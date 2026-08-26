// Iniciativa (nível 1): a IA percebe motivo pra PUXAR papo, escreve o rascunho e coloca
// na fila da aba Vínculos. NADA sai sem o dono aprovar — este é o nível 1 combinado com
// ele em 25/07/2026 ("depois vamos ligando automático conforme ela vai indo bem").
//
// Por que existe: a assinatura nº 1 do corpus é o dono chegar PRIMEIRO (oferece antes,
// manda salve, cobra combinado). Um clone que só reage não é ele. Dois gatilhos no MVP:
//   1. combinado  — a memória da pessoa registra algo pendente e a conversa esfriou.
//   2. esfriou    — vínculo social/romântico sem troca há alguns dias.
import crypto from 'node:crypto'
import { db, getSetting, logEvent } from '../core/db.mjs'
import { pessoaCanonica } from './identidade.mjs'
import { vinculoDaPessoa, SEM_MEMORIA } from './vinculos.mjs'
import { nomeDaPessoa, idsDaPessoa } from './memoria-pessoa.mjs'
import { personCardRaw } from '../projects/store.mjs'
import { iaLigadaParaPessoa } from '../ai/uso.mjs'

const agora = () => Date.now()
const id12 = () => crypto.randomBytes(6).toString('hex')
const DIA = 86_400_000

// Vínculos onde "dar sinal de vida" faz sentido social. Combinado pendente vale pra
// (quase) todo mundo; sinal de vida só pra relação social/romântica.
const VINCULOS_SOCIAIS = new Set(['paquera', 'romance', 'amigo', 'amiga-confidente', 'afeto-antigo'])

// Config do nível 1 (conservadora de propósito; ajustável por setting depois).
export const LIMITES = {
  expiraMs: 48 * 3600 * 1000,   // sugestão não decidida some em 48h
  maxPendentes: 8,              // fila nunca vira avalanche
  maxNovasPorRodada: 3,
  silencioCombinadoMs: 24 * 3600 * 1000,      // combinado + 24h sem troca
  esfriouMinMs: 4 * DIA, esfriouMaxMs: 21 * DIA, // janela do "sinal de vida"
  naoRepetirMs: 7 * DIA,        // rejeitada/enviada -> a pessoa sai do radar por 7 dias
}

function ultimaMensagem(personId) {
  const ids = idsDaPessoa(personId)
  const marks = ids.map(() => '?').join(',')
  return db().prepare(`SELECT channel, direction, ts FROM message WHERE person_id IN (${marks}) ORDER BY ts DESC LIMIT 1`).get(...ids) || null
}

function jaNoRadar(personId) {
  const r = db().prepare(`SELECT status, criado_em, decidido_em FROM iniciativa WHERE person_id=? ORDER BY criado_em DESC LIMIT 1`).get(personId)
  if (!r) return false
  if (r.status === 'pendente') return true
  return (r.decidido_em || r.criado_em || 0) > agora() - LIMITES.naoRepetirMs
}

// Canal onde a iniciativa sai: o da última conversa real com a pessoa.
function canalDaPessoa(personId) {
  return ultimaMensagem(personId)?.channel || null
}

// ---------- detecção ----------
export function candidatosIniciativa() {
  const out = []
  const pendentes = db().prepare(`SELECT COUNT(*) n FROM iniciativa WHERE status='pendente'`).get().n
  if (pendentes >= LIMITES.maxPendentes) return out

  // 1. combinados pendentes (a memória por pessoa já guarda; é ouro parado)
  for (const m of db().prepare(`SELECT person_id, combinados FROM pessoa_memoria WHERE combinados IS NOT NULL AND TRIM(combinados) <> ''`).all()) {
    const pid = pessoaCanonica(m.person_id)
    const v = vinculoDaPessoa(pid)
    if (v && (SEM_MEMORIA.has(v.vinculo))) continue
    if (jaNoRadar(pid)) continue
    const ult = ultimaMensagem(pid)
    if (!ult) continue
    if (!iaLigadaParaPessoa(pid, ult.channel)) continue
    const silencio = agora() - (ult.ts || 0)
    if (silencio < LIMITES.silencioCombinadoMs || silencio > LIMITES.esfriouMaxMs) continue
    out.push({ personId: pid, canal: ult.channel, gatilho: 'combinado', motivo: `combinado em aberto: ${String(m.combinados).slice(0, 200)}`, silencioDias: Math.round(silencio / DIA) })
  }

  // 2. conversa esfriando (vínculo social/romântico tagueado + matches do Tinder com conversa)
  const sociais = db().prepare(`SELECT person_id, vinculo FROM pessoa_vinculo WHERE vinculo IN (${[...VINCULOS_SOCIAIS].map(() => '?').join(',')})`).all(...VINCULOS_SOCIAIS)
  const tinderAtivos = db().prepare(`SELECT person_id FROM tinder_match WHERE has_conversation=1 AND active=1`).all()
  const vistos = new Set(out.map((c) => c.personId))
  for (const r of [...sociais, ...tinderAtivos]) {
    const pid = pessoaCanonica(r.person_id)
    if (vistos.has(pid)) continue
    vistos.add(pid)
    const v = vinculoDaPessoa(pid)
    if (v && SEM_MEMORIA.has(v.vinculo)) continue
    if (jaNoRadar(pid)) continue
    const ult = ultimaMensagem(pid)
    if (!ult) continue
    if (!iaLigadaParaPessoa(pid, ult.channel)) continue
    const silencio = agora() - (ult.ts || 0)
    if (silencio < LIMITES.esfriouMinMs || silencio > LIMITES.esfriouMaxMs) continue
    // mínimo de conversa real: sinal de vida pra quem trocou 3 mensagens é estranho
    const ids = idsDaPessoa(pid)
    const marks = ids.map(() => '?').join(',')
    const total = db().prepare(`SELECT COUNT(*) n FROM message WHERE person_id IN (${marks})`).get(...ids).n
    if (total < 12) continue
    const dias = Math.round(silencio / DIA)
    out.push({ personId: pid, canal: ult.channel, gatilho: 'esfriou', motivo: `vocês não se falam há ${dias} dias; dar um sinal de vida natural`, silencioDias: dias })
  }

  // prioriza combinado (mais concreto), depois silêncio mais curto (conversa mais viva)
  out.sort((a, b) => (a.gatilho === 'combinado' ? -1 : 1) - (b.gatilho === 'combinado' ? -1 : 1) || a.silencioDias - b.silencioDias)
  return out.slice(0, Math.min(LIMITES.maxNovasPorRodada, LIMITES.maxPendentes - pendentes))
}

// Roda a detecção e gera os rascunhos. gerarRascunho é injetado (o index passa o
// generateDraft real; os testes passam mock) — nada aqui envia coisa alguma.
export async function detectarIniciativas({ gerarRascunho }) {
  // A edição pública nasce sem abordagem proativa. Quem opera precisa ligar conscientemente.
  if (!getSetting('iniciativa_enabled', false)) return { novas: 0 }
  expirarAntigas()
  const candidatos = candidatosIniciativa()
  let novas = 0
  for (const c of candidatos) {
    let rascunho = ''
    try {
      rascunho = await gerarRascunho(c)
    } catch (e) { logEvent({ type: 'iniciativa_erro', personId: c.personId, detail: e.message }); continue }
    if (!rascunho) continue
    db().prepare(`INSERT INTO iniciativa(id,person_id,channel,gatilho,motivo,rascunho,status,criado_em) VALUES(?,?,?,?,?,?,'pendente',?)`)
      .run(id12(), c.personId, c.canal, c.gatilho, c.motivo, rascunho, agora())
    logEvent({ type: 'iniciativa_sugerida', personId: c.personId, channel: c.canal, detail: `${c.gatilho}: ${c.motivo.slice(0, 120)}` })
    novas++
  }
  return { novas, pendentes: listarIniciativas().length }
}

export function expirarAntigas() {
  db().prepare(`UPDATE iniciativa SET status='expirada', decidido_em=? WHERE status='pendente' AND criado_em < ?`)
    .run(agora(), agora() - LIMITES.expiraMs)
}

export function listarIniciativas({ status = 'pendente', limite = 30 } = {}) {
  return db().prepare(`SELECT * FROM iniciativa WHERE status=? ORDER BY criado_em DESC LIMIT ?`).all(status, limite)
    .map((i) => {
      // nome de gente sempre: contato sem nome salvo cai no telefone bonito do cartão
      let nome = nomeDaPessoa(i.person_id)
      if (!nome) { try { nome = personCardRaw(i.person_id).name } catch { /* id órfão */ } }
      return { ...i, nome: nome || i.person_id }
    })
}

// Decisão do dono. 'aprovar' envia AGORA pelo canal (callback injetado pelo index);
// texto editado por ele substitui o rascunho. 'rejeitar' só arquiva (e a pessoa sai do
// radar por 7 dias — rejeição é informação).
export async function decidirIniciativa(id, { acao, texto, enviar }) {
  const i = db().prepare(`SELECT * FROM iniciativa WHERE id=?`).get(id)
  if (!i) return { ok: false, error: 'iniciativa não encontrada' }
  if (i.status !== 'pendente') return { ok: false, error: `já ${i.status}` }
  if (acao === 'rejeitar') {
    db().prepare(`UPDATE iniciativa SET status='rejeitada', decidido_em=? WHERE id=?`).run(agora(), id)
    return { ok: true, status: 'rejeitada' }
  }
  if (acao !== 'aprovar') return { ok: false, error: 'ação' }
  const final = String(texto || i.rascunho || '').trim()
  if (!final) return { ok: false, error: 'texto vazio' }
  try {
    await enviar({ personId: i.person_id, canal: i.channel, texto: final })
    db().prepare(`UPDATE iniciativa SET status='enviada', decidido_em=?, rascunho=? WHERE id=?`).run(agora(), final, id)
    logEvent({ type: 'iniciativa_enviada', personId: i.person_id, channel: i.channel, detail: final.slice(0, 200) })
    return { ok: true, status: 'enviada' }
  } catch (e) {
    db().prepare(`UPDATE iniciativa SET status='erro', decidido_em=?, detalhe=? WHERE id=?`).run(agora(), e.message, id)
    return { ok: false, error: e.message }
  }
}

export function contagemIniciativas() {
  const out = {}
  for (const r of db().prepare(`SELECT status, COUNT(*) n FROM iniciativa GROUP BY status`).all()) out[r.status] = r.n
  return out
}
