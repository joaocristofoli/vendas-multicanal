// Memória por PESSOA (não por conversa).
//
// O problema que isto resolve: a IA lê o histórico cru, cortado em 1.000 mensagens e 48 mil
// caracteres. A Nara tem 6.983 mensagens — quase 6 mil simplesmente não existem para
// a IA. E quem tem WhatsApp + Instagram + Tinder tinha o assunto picado por canal.
//
// A memória é sempre da PESSOA CANÔNICA (canonicalPersonId), então serve os três canais de
// uma vez. Os botões de ligar a IA continuam por conversa/rede, como o dono pediu: quem
// responde é a thread, quem lembra é a pessoa.
//
// Como se mantém: um turno barato de IA lê o resumo atual + as mensagens novas e reescreve
// o resumo. Roda FORA do caminho da resposta (tick de fundo), então não atrasa ninguém.
// Sem memória gravada, o bloco é '' e o prompt fica byte a byte igual ao de antes.
import crypto from 'node:crypto'
import { db } from '../core/db.mjs'
import { pessoaCanonica, idsBrutosDaPessoa } from './identidade.mjs'
import { vinculoDaPessoa, SEM_MEMORIA } from './vinculos.mjs'
import { getCodex } from '../ai/codex.mjs'
import { gerarTexto } from '../ai/ia.mjs'
import { iaLigadaParaPessoa } from '../ai/uso.mjs'

const agora = () => Date.now()
const MAX_RESUMO = 1400          // teto de caracteres do resumo (cabe no prompt sem pesar)
const MIN_MSGS_PRA_ATUALIZAR = 12 // só reescreve quando juntou conversa nova o bastante
// O automático precisa se pagar: abaixo destes patamares o histórico cru ainda cabe no
// prompt e resumir custa mais do que economiza. O botão manual mantém o limiar de 12.
const MIN_MSGS_AUTO = 80
const MIN_TOTAL_AUTO = 240
const MIN_CHARS_AUTO = 24_000

// Todos os ids brutos desta pessoa (ela + canônico + aliases), igual ao buildHistory.
export function idsDaPessoa(personId) {
  try { return idsBrutosDaPessoa(personId) } catch { return [String(personId)] }
}

export function memoriaDaPessoa(personId) {
  const canonico = pessoaCanonica(personId)
  const r = db().prepare(`SELECT * FROM pessoa_memoria WHERE person_id=?`).get(canonico)
  if (!r) return null
  return { ...r, canonico }
}

// Bloco pronto pro prompt. '' quando não há memória (comportamento anterior intacto).
export function memoriaBlock(personId) {
  const m = memoriaDaPessoa(personId)
  const resumo = String(m?.resumo || '').trim()
  if (!resumo) return ''
  const pend = String(m?.combinados || '').trim()
  return [
    'O QUE VOCÊ JÁ SABE DESSA PESSOA (memória sua, construída ao longo de todas as conversas com ela, inclusive as antigas que não aparecem no histórico abaixo).',
    resumo,
    pend ? `Combinado em aberto com ela: ${pend}` : null,
    // A versão anterior só FREAVA ("não repita, não interrogue") e a IA entendeu que
    // memória era coisa pra evitar: com 87 mensagens de contexto e um encontro combinado,
    // respondeu "tô bem tbm" e nada mais (caso real da fixture sintética, 25/07/2026). Freio sem
    // acelerador não usa a memória — agora diz explicitamente PRA QUE ela serve.
    'USE ISSO: é daqui que sai o gancho que faz a conversa andar. Quando a mensagem dela for curta ou de pouco conteúdo ("oi", "tudo bem", "vou salvar seu contato"), é justamente a hora de puxar algo que você já sabe dela — o que ela contou, o que vocês combinaram, um assunto que ficou no ar — em vez de responder só o que foi perguntado.',
    pend ? 'O combinado em aberto é o melhor gancho que existe: retome com leveza quando couber.' : null,
    'Sem virar roteiro: fale como quem lembra naturalmente, não repita pra ela o que ela mesma acabou de dizer, não a interrogue sobre o que já contou, e nunca mencione que anotou nada.',
  ].filter(Boolean).join('\n')
}

// Quantas mensagens novas entraram desde a última consolidação.
export function mensagensNovas(personId) {
  const ids = idsDaPessoa(personId)
  const m = memoriaDaPessoa(personId)
  const desde = m?.ate_ts || 0
  const marks = ids.map(() => '?').join(',')
  return db().prepare(`SELECT COUNT(*) n FROM message WHERE person_id IN (${marks}) AND ts > ?`).get(...ids, desde)?.n || 0
}

// Pessoas que valem uma consolidação agora: as que acumularam conversa nova.
export function pessoasParaConsolidar({
  limite = 3,
  minimo = MIN_MSGS_PRA_ATUALIZAR,
  somenteComIa = false,
  economica = false,
} = {}) {
  const linhas = db().prepare(`
    SELECT m.person_id, COUNT(*) total, MAX(m.ts) ultima
    FROM message m GROUP BY m.person_id HAVING total >= ?
    ORDER BY ultima DESC LIMIT 400`).all(minimo)
  const vistos = new Set()
  const alvos = []
  for (const l of linhas) {
    const c = pessoaCanonica(l.person_id)
    if (vistos.has(c)) continue
    vistos.add(c)
    // Bot e self-chat não ganham memória: consolidar "lembrança" do Sicredi ou da outro contato
    // é turno de IA jogado fora — e memória de bot poluiria o prompt se alguém a ligasse.
    try { const v = vinculoDaPessoa(c); if (v && SEM_MEMORIA.has(v.vinculo)) continue } catch { /* segue */ }
    if (somenteComIa && !iaLigadaParaPessoa(c)) continue
    const novas = mensagensNovas(c)
    if (economica) {
      if (novas < Math.max(minimo, MIN_MSGS_AUTO)) continue
      const ids = idsDaPessoa(c)
      const marks = ids.map(() => '?').join(',')
      const volume = db().prepare(`SELECT COUNT(*) total, COALESCE(SUM(LENGTH(text)),0) chars
        FROM message WHERE person_id IN (${marks})`).get(...ids)
      if ((volume?.total || 0) < MIN_TOTAL_AUTO && (volume?.chars || 0) < MIN_CHARS_AUTO) continue
    }
    if (novas >= minimo) alvos.push({ personId: c, novas, ultima: l.ultima })
    if (alvos.length >= limite) break
  }
  return alvos
}

const INSTRUCOES = [
  'Você mantém a memória que uma pessoa tem sobre OUTRA pessoa com quem conversa.',
  'Responda somente com JSON válido, sem markdown e sem texto fora do JSON.',
].join('\n')

function montarPrompt({ nome, resumoAtual, combinadosAtuais, mensagens }) {
  return [
    `Você está atualizando o que EU lembro sobre ${nome || 'esta pessoa'}, com quem eu converso.`,
    '',
    resumoAtual ? `O que eu já lembrava dela:\n${resumoAtual}` : 'Ainda não tenho nada anotado sobre ela.',
    combinadosAtuais ? `Combinados que estavam em aberto: ${combinadosAtuais}` : '',
    '',
    'Conversa nova (EU = eu, ELA = a outra pessoa; pode vir de canais diferentes):',
    mensagens.map((m) => `${m.direction === 'outgoing' ? 'EU' : 'ELA'}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n'),
    '',
    'Reescreva a memória inteira, incorporando o que a conversa nova acrescenta. Regras:',
    '- Escreva em português falado, direto, como anotação minha sobre ela.',
    '- Guarde o que dura: quem ela é, trabalho, rotina, gostos, o que ela já me contou, como está a relação, do que a gente já falou, o jeito dela escrever.',
    '- NÃO guarde o que é passageiro ("tá cansada hoje"), nem repita mensagem literal, nem invente nada que não esteja na conversa.',
    '- Se algo mudou (ela trocou de emprego, de cidade, terminou algo), a memória nova substitui a antiga.',
    `- No máximo ${MAX_RESUMO} caracteres no resumo. Sem lista longa: texto corrido curto.`,
    '- Em "combinados", só o que ficou REALMENTE combinado e ainda não aconteceu ("ela ia me mandar o endereço", "eu ia ligar depois da fisio"). Se não há nada pendente, mande string vazia.',
    '- Em "tom", uma linha sobre como ELA escreve (ritmo, gírias, emoji, se responde curto ou longo).',
    '',
    'Formato exato: {"resumo":"...","combinados":"...","tom":"..."}',
  ].filter(Boolean).join('\n')
}

function parseMemoria(texto) {
  const t = String(texto || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const tenta = (s) => { try { return JSON.parse(s) } catch { return null } }
  const o = tenta(t) || tenta((t.match(/\{[\s\S]*\}/) || [])[0] || '')
  if (!o || typeof o.resumo !== 'string') return null
  return {
    resumo: o.resumo.replace(/\s+/g, ' ').trim().slice(0, MAX_RESUMO),
    combinados: String(o.combinados || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    tom: String(o.tom || '').replace(/\s+/g, ' ').trim().slice(0, 300),
  }
}

// Nome de exibição da pessoa, olhando os três canais.
export function nomeDaPessoa(personId, accountKey = 'main') {
  const d = db()
  for (const id of idsDaPessoa(personId)) {
    const p = d.prepare(`SELECT display_name FROM person WHERE person_id=?`).get(id)
    if (p?.display_name) return p.display_name
    if (id.startsWith('wa:')) { const c = d.prepare(`SELECT name FROM wa_chat WHERE account_key=? AND jid=?`).get(accountKey, id.slice(3)); if (c?.name) return c.name }
    if (id.startsWith('ig:')) { const c = d.prepare(`SELECT name FROM ig_chat WHERE account_key=? AND thread_id=?`).get(accountKey, id.slice(3)); if (c?.name) return c.name }
  }
  return null
}

// Consolida UMA pessoa. Lê o que ainda não foi lido (com uma sobreposição pequena pra não
// perder o fio) e reescreve a memória. Devolve null quando não havia o que fazer.
export async function consolidarPessoa(personId, { forcar = false, maxMensagens = 220 } = {}) {
  const canonico = pessoaCanonica(personId)
  const atual = memoriaDaPessoa(canonico)
  const ids = idsDaPessoa(canonico)
  const marks = ids.map(() => '?').join(',')
  const desde = forcar ? 0 : (atual?.ate_ts || 0)
  const novas = db().prepare(`SELECT direction, text, ts FROM message WHERE person_id IN (${marks}) AND ts > ? AND text IS NOT NULL AND TRIM(text) <> '' ORDER BY ts ASC`).all(...ids, desde)
  if (!novas.length) return null
  if (!forcar && novas.length < MIN_MSGS_PRA_ATUALIZAR) return null

  // Corte por volume: numa primeira consolidação de 7 mil mensagens, lê as mais recentes.
  // O resumo anterior carrega o que veio antes — é assim que a memória não estoura o prompt.
  const recorte = novas.slice(-maxMensagens)
  const prompt = montarPrompt({
    nome: nomeDaPessoa(canonico),
    resumoAtual: atual?.resumo || '',
    combinadosAtuais: atual?.combinados || '',
    mensagens: recorte,
  })
  const r = await gerarTexto({
    prompt,
    baseInstructions: INSTRUCOES,
    effort: 'low',
    usageMeta: {
      origin: forcar ? 'memoria_manual' : 'memoria_automatica',
      trigger: forcar ? 'manual' : 'automatico',
      personId: canonico,
    },
  })
  const memo = parseMemoria(r.text)
  if (!memo) throw new Error('memória: resposta não veio em JSON utilizável')

  const ateTs = novas[novas.length - 1].ts
  const total = db().prepare(`SELECT COUNT(*) n FROM message WHERE person_id IN (${marks})`).get(...ids)?.n || 0
  db().prepare(`INSERT INTO pessoa_memoria(person_id,resumo,combinados,tom,ate_ts,msgs_lidas,total_msgs,versao,updated_at)
    VALUES(@id,@resumo,@combinados,@tom,@ate,@lidas,@total,@versao,@up)
    ON CONFLICT(person_id) DO UPDATE SET resumo=excluded.resumo, combinados=excluded.combinados, tom=excluded.tom,
      ate_ts=excluded.ate_ts, msgs_lidas=excluded.msgs_lidas, total_msgs=excluded.total_msgs,
      versao=excluded.versao, updated_at=excluded.updated_at`)
    .run({
      id: canonico, resumo: memo.resumo, combinados: memo.combinados, tom: memo.tom,
      ate: ateTs, lidas: (atual?.msgs_lidas || 0) + recorte.length, total,
      versao: (atual?.versao || 0) + 1, up: agora(),
    })
  return { personId: canonico, lidas: recorte.length, novas: novas.length, total, versao: (atual?.versao || 0) + 1, resumo: memo.resumo }
}

export function listarMemorias({ limite = 200 } = {}) {
  return db().prepare(`SELECT * FROM pessoa_memoria ORDER BY updated_at DESC LIMIT ?`).all(limite)
}

export function apagarMemoria(personId) {
  db().prepare(`DELETE FROM pessoa_memoria WHERE person_id=?`).run(pessoaCanonica(personId))
}

export const _internos = {
  montarPrompt,
  parseMemoria,
  MIN_MSGS_PRA_ATUALIZAR,
  MIN_MSGS_AUTO,
  MIN_TOTAL_AUTO,
  MIN_CHARS_AUTO,
  MAX_RESUMO,
}
export { crypto as _crypto }
