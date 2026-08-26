// Consciência da agenda no cérebro: lê os próximos compromissos do dono (cache curto)
// e monta um bloco compacto que entra no prompt de TODOS os canais. É opcional/aditivo:
// sem agenda conectada ou sem eventos, devolve '' e o prompt fica idêntico ao de antes.
import { listUpcoming, connectionState, TZ } from './google.mjs'
import { listarCompromissos } from './local.mjs'

const CACHE_TTL_MS = 5 * 60 * 1000
let cache = { ts: 0, events: [] }

// Atualiza o cache se estiver velho (no máx. uma chamada ao Google a cada 5 min).
export async function ensureAgendaFresh() {
  if (!connectionState().connected) { cache = { ts: Date.now(), events: [] }; return }
  if (Date.now() - cache.ts < CACHE_TTL_MS && cache.events.length) return
  await refreshAgenda()
}

// Força a atualização do cache agora (botão do painel / boot). Nunca estoura.
export async function refreshAgenda() {
  if (!connectionState().connected) { cache = { ts: Date.now(), events: [] }; return cache }
  try { cache = { ts: Date.now(), events: await listUpcoming({ days: 10, max: 20 }) } }
  catch { cache = { ts: Date.now(), events: [] } } // falha de rede não pode travar a resposta
  return cache
}

const fmtDay = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: TZ })
const fmtHour = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ })
const dayStamp = (ms) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ }).format(new Date(ms))

function relativeDay(ms) {
  const today = dayStamp(Date.now())
  const tomorrow = dayStamp(Date.now() + 86400000)
  const d = dayStamp(ms)
  if (d === today) return 'hoje'
  if (d === tomorrow) return 'amanhã'
  return null
}

function lineFor(ev) {
  const rel = relativeDay(ev.startMs)
  const when = ev.allDay
    ? `${rel || fmtDay.format(new Date(ev.startMs))} (dia todo)`
    : `${rel || fmtDay.format(new Date(ev.startMs))} ${fmtHour.format(new Date(ev.startMs))}`
  return `- ${when}: ${ev.title}${ev.location ? ` (${ev.location})` : ''}`
}

// Bloco pronto pro prompt (ou '' se não há nada). Lê do cache — chame ensureAgendaFresh antes.
export function agendaBlock() {
  // Os compromissos do calendário da casa entram aqui do mesmo jeito: pra IA não existe
  // "agenda conectada", existe compromisso. Sem nenhum dos dois, devolve '' e o prompt fica
  // byte a byte o de antes — que é o invariante do golden set.
  const eventos = ocupacaoAgenda({ dias: 10 })
  if (!eventos.length) return ''
  const lines = eventos.slice(0, 12).map(lineFor).join('\n')
  return [
    'AGENDA DO USUÁRIO (fonte de verdade sobre os compromissos DELE, fuso de São Paulo).',
    'Use só quando criar conexão natural: para não marcar em cima de um compromisso, sugerir um horário livre, ou puxar um assunto que já está combinado. Nunca liste a agenda pra pessoa nem exponha compromissos de terceiros; fale como quem simplesmente sabe da própria rotina.',
    lines,
  ].join('\n')
}

// Snapshot cru pro painel/uso externo. É SÓ o que veio da Google — quem precisa saber se o
// horário está ocupado tem que usar `ocupacaoAgenda()`, abaixo.
export function agendaSnapshot() { return { ts: cache.ts, events: cache.events } }

// ---------- a ocupação de verdade: Google (se tiver) + calendário da casa ----------
//
// A ordem da pergunta "posso atender às 14h?" é: as JANELAS de disponibilidade dizem o que
// pode; esta função diz o que já está tomado. Sem Google conectada, a resposta vem inteira do
// calendário da casa — que é o caso de toda instância recém-clonada.
//
// O espelho não pode contar duas vezes: compromisso local que já tem par na Google (mesmo
// `google_event_id`) sai da lista quando o evento de lá aparece no intervalo.
// `deGoogle`/`daCasa` entram por parâmetro só pra dar pra provar a união sem banco nem rede —
// o padrão é ler do cache e do calendário da casa.
export function ocupacaoAgenda({ desde = Date.now(), ate = null, dias = 10, deGoogle = null, daCasa = null } = {}) {
  const fim = ate || desde + dias * 86400000
  const google = (deGoogle || cache.events || []).filter((e) => e && e.startMs)
  const idsGoogle = new Set(google.map((e) => e.id).filter(Boolean))
  const locais = (daCasa || listarCompromissos({ fromMs: desde, toMs: fim }))
    .filter((c) => !(c.googleEventId && idsGoogle.has(c.googleEventId)))
  return [...google, ...locais].sort((a, b) => a.startMs - b.startMs)
}
