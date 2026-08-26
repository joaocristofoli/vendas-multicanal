// Varredura de compromissos: passa o extrator sobre conversas com mensagem nova e,
// quando acha um compromisso com confiança suficiente, cria uma PROPOSTA pendente
// (sugere -> o dono confirma). Nada é escrito na agenda aqui. Roda leve (poucas por tick).
import crypto from 'node:crypto'
import { peopleWithRecentIncoming, getAgendaScan, setAgendaScan, agendaProposalNear, addAgendaProposal, personDisplayName, logEvent } from '../core/db.mjs'
import { connectionState } from './google.mjs'
import { detectCommitment } from './detect.mjs'
import { projectsForPerson } from '../projects/store.mjs'
import { iaLigadaParaPessoa } from '../ai/uso.mjs'
import { proporDatesPessoa } from '../self/encontros.mjs'
import { atendimentoLiberadoParaPessoa } from '../self/atendimento.mjs'

const SCAN_WINDOW_MS = 14 * 86400000   // só conversas ativas nas últimas 2 semanas
const MAX_PER_TICK = 4                  // teto de chamadas ao Codex por tick
const MIN_CONFIDENCE = 0.6
const DEDUPE_WINDOW_MS = 30 * 60000    // mesma pessoa + horário dentro de 30min = mesmo compromisso
// Abaixo disto nem vale registrar o descarte: é ruído do modelo, não plano de ninguém.
const CONFIANCA_DIGNA_DE_NOTA = 0.35

// FALHA DE LEITURA não é "li e não achei". Cota estourada, 503 e timeout são o provedor
// dizendo "tente depois"; tratar isso como resposta fazia a conversa ser marcada como varrida
// e nunca mais ser olhada — só voltaria se ELA escrevesse de novo. Em 24/07/2026 a cota
// estourou às 19:33 e três conversas foram marcadas como lidas sem nunca terem sido lidas.
const RE_TRANSITORIO = /usage limit|high demand|rate.?limit|quota|too many requests|\b429\b|\b503\b|\b502\b|\b504\b|service unavailable|timeout|timed out|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i
function ehTransitorio(e) { return RE_TRANSITORIO.test(`${e?.message || ''} ${e?.code || ''}`) }

// Espera entre tentativas da MESMA conversa, pra uma falha persistente não ocupar as 4 vagas
// do tick pra sempre e deixar as outras conversas sem varredura.
const ESPERA_MS = [2 * 60000, 10 * 60000, 30 * 60000, 2 * 3600000]
const MAX_TENTATIVAS = ESPERA_MS.length
const adiadas = new Map()   // personId -> { tentativas, proximaEm }

// O mesmo fail-closed do gerador: falha de leitura nunca vira autorização implícita.
//
// ATENDIMENTO ENTRA AQUI TAMBÉM (15/08/2026). Sem isto, a separação entre trabalho e romance
// ficava pela metade: a IA voltava a combinar o atendimento na conversa, mas nenhum cartão
// nascia na Agenda — porque a varredura inteira estava presa no interruptor de ENCONTRO. O
// horário combinado sumia, e o próximo cliente recebia um horário já vendido.
function podeMarcarNaAgenda(personId) {
  try { return proporDatesPessoa(personId) || atendimentoLiberadoParaPessoa(personId) } catch { return false }
}

// Exportados só pra prova. `_limparAdiadas` começa de um estado limpo; `_forcarVencimento`
// faz a espera de uma conversa vencer agora, pra a guarda testar as 4 tentativas sem levar
// horas de verdade.
export function _limparAdiadas() { adiadas.clear() }
export function _forcarVencimento(personId) {
  const a = adiadas.get(personId)
  if (a) adiadas.set(personId, { ...a, proximaEm: 0 })
}

// Impressão digital SÓ pra registro (a trava real é agendaProposalNear, por pessoa+horário).
// Não usa o título de propósito: a IA varia o título a cada re-scan e isso gerava duplicata.
function fingerprint(personId, startMs) {
  return crypto.createHash('sha1').update(`${personId}|${Math.round(startMs / DEDUPE_WINDOW_MS)}`).digest('hex').slice(0, 20)
}

// Um tick. Devolve quantas propostas novas criou. onProposal(prop) pra avisar o painel.
// `detectar` é injetável só pra prova: a guarda de `licoes/varredura-queimada-por-erro`
// precisa provocar um 503 de verdade e conferir o que acontece com a marca de varredura.
// Em produção é sempre o detectCommitment de cima.
export async function agendaDetectTick({ accountKey, onProposal = () => {}, detectar = detectCommitment } = {}) {
  if (!connectionState().connected) return 0
  const since = Date.now() - SCAN_WINDOW_MS
  const agora = Date.now()
  const recentes = peopleWithRecentIncoming(since, 40)
    .filter((r) => r.last_ts > getAgendaScan(r.person_id))
    // Varredura com modelo só existe nas conversas que o dono autorizou pelo botão da IA.
    .filter((r) => iaLigadaParaPessoa(r.person_id, r.channel))

  // Com as DUAS autorizações desligadas (encontro e atendimento), a criação automática de
  // cartão na Agenda não acontece. Avança a marca sem chamar modelo para que mensagens
  // recebidas enquanto estava desligado não reapareçam como compromisso antigo no instante
  // em que o dono decidir ligar no futuro.
  for (const row of recentes) {
    if (!podeMarcarNaAgenda(row.person_id)) setAgendaScan(row.person_id, row.last_ts)
  }

  const pending = recentes
    .filter((r) => podeMarcarNaAgenda(r.person_id))
    // conversa adiada por falha de leitura espera a vez dela, em vez de ocupar a vaga
    .filter((r) => { const a = adiadas.get(r.person_id); return !a || a.proximaEm <= agora })
    .slice(0, MAX_PER_TICK)
  let made = 0
  for (const row of pending) {
    const personId = row.person_id
    try {
      const name = personDisplayName(personId)
      const found = await detectar({ personId, name, channel: row.channel })
      setAgendaScan(personId, row.last_ts) // marca como lida mesmo sem achar (não reprocessa)
      adiadas.delete(personId)             // leu: qualquer adiamento anterior morre aqui
      if (!found) continue
      // O botão pode ter sido desligado durante a chamada do detector. A segunda leitura é o
      // portão de envio equivalente ao de generateDraft: sem autorização atual, nada nasce.
      if (!podeMarcarNaAgenda(personId)) {
        logEvent({ type: 'agenda_descartado', personId, channel: row.channel,
          detail: `marcar desligado durante a varredura: ${found.title || 'compromisso detectado'}` })
        continue
      }
      // DESCARTE COM RASTRO. Antes estes dois `continue` eram silenciosos: um compromisso que
      // o modelo identificou podia ser jogado fora e o dono nunca saberia que existiu. Agora
      // o Diário registra, e a decisão continua sendo dele.
      if (found.confidence < MIN_CONFIDENCE) {
        if (found.confidence >= CONFIANCA_DIGNA_DE_NOTA) {
          logEvent({ type: 'agenda_descartado', personId, channel: row.channel,
            detail: `confiança ${found.confidence.toFixed(2)} < ${MIN_CONFIDENCE}: ${found.title} @ ${found.startsAtIso}` })
        }
        continue
      }
      const startMs = Date.parse(found.startsAtIso)
      if (startMs <= Date.now()) {
        logEvent({ type: 'agenda_descartado', personId, channel: row.channel,
          detail: `já passou quando foi detectado: ${found.title} @ ${found.startsAtIso}` })
        continue // compromisso no passado não interessa
      }
      // trava anti-duplicata por pessoa+horário (independe do título): mesmo compromisso
      // re-detectado numa mesma conversa não vira 2 propostas.
      if (agendaProposalNear(accountKey, personId, startMs, DEDUPE_WINDOW_MS)) continue
      const fp = fingerprint(personId, startMs)
      // Sugere o projeto quando a pessoa é envolvida de EXATAMENTE um projeto ativo (F6).
      let projectId = null
      try { const prjs = projectsForPerson(personId, accountKey); if (prjs.length === 1) projectId = prjs[0].id } catch { /* projetos indisponíveis */ }
      const prop = {
        id: crypto.randomUUID(), accountKey, personId, channel: row.channel,
        title: found.title, startsAt: Date.parse(found.startsAtIso),
        endsAt: found.endsAtIso ? Date.parse(found.endsAtIso) : null,
        withPerson: found.withPerson, confidence: found.confidence, sourceQuote: found.sourceQuote, fp, projectId,
      }
      addAgendaProposal(prop)
      logEvent({ type: 'agenda_proposal', personId, channel: row.channel, detail: `${found.title} @ ${found.startsAtIso}` })
      onProposal(prop)
      made++
    } catch (e) {
      // A diferença que este bloco protege: "li a conversa e não achei compromisso" avança a
      // marca de varredura; "não consegui ler a conversa" NÃO pode avançar, senão a conversa
      // é dada como analisada sem nunca ter sido — e some pra sempre se ela não escrever mais.
      if (ehTransitorio(e)) {
        const antes = adiadas.get(personId)
        const tentativas = (antes?.tentativas || 0) + 1
        if (tentativas > MAX_TENTATIVAS) {
          // Desistir é legítimo; desistir calado não é. Avança a marca pra não travar a fila,
          // e deixa dito no Diário que esta conversa ficou SEM análise.
          adiadas.delete(personId)
          setAgendaScan(personId, row.last_ts)
          logEvent({ type: 'agenda_detect_desistiu', personId, channel: row.channel,
            detail: `${MAX_TENTATIVAS} tentativas falharam; a conversa ficou SEM varredura de compromisso: ${e.message}` })
        } else {
          adiadas.set(personId, { tentativas, proximaEm: Date.now() + ESPERA_MS[tentativas - 1] })
          logEvent({ type: 'agenda_detect_adiado', personId, channel: row.channel,
            detail: `tentativa ${tentativas}/${MAX_TENTATIVAS} falhou (${e.message.slice(0, 80)}); tenta de novo em ${Math.round(ESPERA_MS[tentativas - 1] / 60000)} min` })
        }
      } else {
        setAgendaScan(personId, row.last_ts)
        logEvent({ type: 'agenda_detect_error', personId, detail: e.message })
      }
    }
  }
  return made
}
