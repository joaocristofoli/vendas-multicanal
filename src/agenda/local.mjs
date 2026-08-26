// O CALENDÁRIO DO PRÓPRIO SISTEMA.
//
// Por que ele existe: até 15/08/2026 a única fonte de ocupação era a Google Agenda. Sem ela
// conectada — que é o estado de toda instância recém-clonada — `slotsLivres` via o dia
// inteiro livre e a IA oferecia horário em cima de compromisso já marcado; e aprovar uma
// proposta detectada estourava, porque o único caminho de gravação era criar evento lá fora.
//
// A REGRA, na ordem: o que pode ser atendido sai das JANELAS de disponibilidade declaradas
// (`src/self/encontros.mjs`); do que sobra, desconta-se a ocupação — Google **e** este
// calendário, unidos. Com a Google conectada, ela vira ESPELHO: o compromisso continua
// nascendo aqui e leva o `google_event_id` do par, pra ninguém contar o mesmo horário duas
// vezes.
//
// O que este módulo NÃO faz: recorrência, convidados, lembrete próprio. Compromisso aqui é
// um bloco de tempo com dono, duração e folga — o suficiente pra responder "cabe?".
import crypto from 'node:crypto'
import { db, logEvent } from '../core/db.mjs'

const ACCOUNT = () => process.env.TIM_ACCOUNT_KEY || 'main'
const num = (v, padrao = 0) => { const n = Number(v); return Number.isFinite(n) ? n : padrao }

// Mesmo formato dos eventos normalizados da Google (`normalizeEvent`), pra quem consome não
// precisar saber de onde veio: quem lê ocupação só quer startMs/endMs.
function paraEvento(row) {
  return {
    id: `local:${row.id}`,
    localId: row.id,
    title: row.titulo || 'Compromisso',
    description: row.observacao || null,
    createdMs: num(row.criado_em) || null,
    startMs: num(row.inicio_ms),
    endMs: num(row.fim_ms),
    allDay: false,
    location: row.lugar || null,
    htmlLink: null,
    recurring: false,
    attendees: [],
    isTim: true,
    origem: row.origem || 'manual',
    fonte: 'local',
    googleEventId: row.google_event_id || null,
    personId: row.person_id || null,
    canal: row.canal || null,
    projectId: row.project_id || null,
    servico: row.servico || null,
    faixa: row.faixa || null,
    folgaAntesMin: num(row.folga_antes_min),
    folgaDepoisMin: num(row.folga_depois_min),
    status: row.status || 'marcado',
  }
}

export function criarCompromisso({
  titulo, inicioMs, fimMs = null, duracaoMinutos = null, personId = null, canal = null,
  projectId = null, servico = null, faixa = null, folgaAntesMin = 0, folgaDepoisMin = 0,
  lugar = null, observacao = null, origem = 'manual', googleEventId = null,
} = {}) {
  const ini = num(inicioMs)
  if (!ini) throw new Error('compromisso precisa de horário de início')
  const min = num(duracaoMinutos)
  const fim = num(fimMs) || (ini + (min > 0 ? min : 60) * 60000)
  if (fim <= ini) throw new Error('o fim do compromisso tem que ser depois do início')
  const t = String(titulo || '').trim() || 'Compromisso'
  const id = crypto.randomUUID()
  const agora = Date.now()
  db().prepare(`INSERT INTO compromisso (id, account_key, titulo, inicio_ms, fim_ms, person_id, canal,
      project_id, servico, faixa, folga_antes_min, folga_depois_min, lugar, observacao, origem,
      google_event_id, status, criado_em, atualizado_em)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'marcado',?,?)`)
    .run(id, ACCOUNT(), t, ini, fim, personId, canal, projectId, servico, faixa,
      Math.max(0, num(folgaAntesMin)), Math.max(0, num(folgaDepoisMin)), lugar, observacao, origem,
      googleEventId, agora, agora)
  logEvent({ type: 'compromisso_marcado', channel: 'agenda', personId, detail: `${t} (${new Date(ini).toISOString()})` })
  return lerCompromisso(id)
}

export function lerCompromisso(id) {
  const row = db().prepare('SELECT * FROM compromisso WHERE id=?').get(String(id || ''))
  return row ? paraEvento(row) : null
}

// A janela é meia-aberta pelos DOIS lados: um compromisso que começou antes e termina dentro
// do intervalo ocupa o intervalo do mesmo jeito. Ignorar isso é o jeito clássico de oferecer
// 14h pra quem está atendendo das 13h30 às 15h.
export function listarCompromissos({ fromMs = 0, toMs = 0, incluirCancelados = false } = {}) {
  const de = num(fromMs), ate = num(toMs)
  const cond = ['1=1']
  const args = []
  if (!incluirCancelados) cond.push("status = 'marcado'")
  if (de) { cond.push('fim_ms > ?'); args.push(de) }
  if (ate) { cond.push('inicio_ms < ?'); args.push(ate) }
  return db().prepare(`SELECT * FROM compromisso WHERE ${cond.join(' AND ')} ORDER BY inicio_ms ASC`)
    .all(...args).map(paraEvento)
}

export function proximosCompromissos({ dias = 10, max = 25, desde = Date.now() } = {}) {
  return listarCompromissos({ fromMs: desde, toMs: desde + dias * 86400000 }).slice(0, max)
}

export function editarCompromisso(id, patch = {}) {
  const atual = lerCompromisso(id)
  if (!atual) throw new Error('compromisso não existe')
  const campos = {
    titulo: patch.titulo != null ? String(patch.titulo).trim() : atual.title,
    inicio_ms: patch.inicioMs != null ? num(patch.inicioMs) : atual.startMs,
    fim_ms: patch.fimMs != null ? num(patch.fimMs) : atual.endMs,
    lugar: patch.lugar !== undefined ? patch.lugar : atual.location,
    observacao: patch.observacao !== undefined ? patch.observacao : atual.description,
    google_event_id: patch.googleEventId !== undefined ? patch.googleEventId : atual.googleEventId,
  }
  if (campos.fim_ms <= campos.inicio_ms) throw new Error('o fim do compromisso tem que ser depois do início')
  db().prepare(`UPDATE compromisso SET titulo=?, inicio_ms=?, fim_ms=?, lugar=?, observacao=?,
      google_event_id=?, atualizado_em=? WHERE id=?`)
    .run(campos.titulo, campos.inicio_ms, campos.fim_ms, campos.lugar, campos.observacao,
      campos.google_event_id, Date.now(), atual.localId)
  return lerCompromisso(atual.localId)
}

// Cancelar NÃO apaga: o horário some da ocupação, mas a linha fica. Compromisso desmarcado é
// histórico da pessoa, e apagar dado em produção é o que a casa não faz.
export function cancelarCompromisso(id) {
  const atual = lerCompromisso(id)
  if (!atual) throw new Error('compromisso não existe')
  const agora = Date.now()
  db().prepare("UPDATE compromisso SET status='cancelado', cancelado_em=?, atualizado_em=? WHERE id=?")
    .run(agora, agora, atual.localId)
  logEvent({ type: 'compromisso_cancelado', channel: 'agenda', personId: atual.personId, detail: atual.title })
  return { ...lerCompromisso(atual.localId), googleEventId: atual.googleEventId }
}

// Achar o compromisso local que espelha um evento da Google (pra editar/cancelar dos dois
// lados quando a ação começa pelo id de lá).
export function porGoogleEventId(googleEventId) {
  const row = db().prepare("SELECT * FROM compromisso WHERE google_event_id=? AND status='marcado'")
    .get(String(googleEventId || ''))
  return row ? paraEvento(row) : null
}
