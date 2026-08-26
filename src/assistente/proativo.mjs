// O que o vendas-multicanal pode falar SEM ser chamado. Decisão 2 do dono: "pode falar primeiro, mas
// somente em coisas que vou definir, tipo lembretes e compromissos do dia".
// Então aqui é uma lista curta, cada item com interruptor próprio, e o texto é escrito
// por CÓDIGO — nada de o modelo inventar assunto pra puxar conversa com ele.
//
// Lembrete já existia (projects/reminders.mjs dispara no self-chat) e continua onde está.
// Isto acrescenta: o resumo do dia, e dois alertas que nascem DESLIGADOS.
import { db, getSetting, setSetting, getWaSession, getAiSetting, logEvent, agendaAvisoJaFeito, marcarAgendaAviso, limparAgendaAvisos } from '../core/db.mjs'
import { ensureAgendaFresh, agendaSnapshot, refreshAgenda, ocupacaoAgenda } from '../agenda/context.mjs'
import { avisoPadraoMin } from '../projects/reminders.mjs'
import * as S from '../projects/store.mjs'
import { compromissos, nomeDe } from './contexto.mjs'
import { enviarNoSelfChat, assistenteLigado } from './canal.mjs'
import { ehSelfPerson } from './guarda.mjs'

const fmtHora = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
const horaAgoraSP = () => new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date())

// Texto do resumo do dia. Devolve null quando não há NADA — dia vazio não vira mensagem
// (aviso diário sem conteúdo é ruído, e ruído faz desligar a coisa toda).
export async function textoDoDia({ accountKey = 'main' } = {}) {
  try { await ensureAgendaFresh() } catch { /* segue com o cache */ }
  const evs = compromissos({ dias: 1 })
  const hoje = S.todayData(accountKey)
  const linhas = []
  if (evs.length) linhas.push(...evs.map((e) => `${e.diaTodo ? 'dia todo' : fmtHora.format(new Date(e.inicio))} — ${e.titulo}`))
  if (hoje.reminders?.length) linhas.push(...hoje.reminders.map((r) => `${fmtHora.format(new Date(r.at))} — lembrete: ${r.text}`))
  if (hoje.tasks?.length) linhas.push(...hoje.tasks.map((t) => `prazo hoje: ${t.title}`))
  if (!linhas.length) return null
  return ['Seu dia:', ...linhas].join('\n')
}

// Um tick barato (roda junto com o dos lembretes). Só age no minuto certo e uma vez por dia.
export async function proativoTick(ctx = {}) {
  if (!assistenteLigado()) return 0
  let mandou = 0
  mandou += await avisoDeCompromisso(ctx)
  mandou += await resumoDoDia(ctx)
  mandou += await alertaDeSistema(ctx)
  mandou += await avisoDeResposta(ctx)
  return mandou
}

// "me avisa quando a fulana responder" — nasce DESLIGADO. Avisa uma vez por pessoa por
// mensagem nova, só de quem está SEM IA (com IA ligada o vendas-multicanal já responde sozinho, avisar
// seria ruído) e só do que chegou depois do último aviso.
async function avisoDeResposta(ctx) {
  if (getSetting('assistente_proativo_respostas', false) !== true) return 0
  const desde = Number(getSetting('assistente_aviso_desde', 0)) || (Date.now() - 10 * 60 * 1000)
  const agora = Date.now()
  setSetting('assistente_aviso_desde', agora)
  const novas = db().prepare(`
    SELECT m.person_id, m.channel, m.text, m.ts FROM message m
    JOIN (SELECT person_id, max(ts) mx FROM message GROUP BY person_id) u
      ON u.person_id=m.person_id AND u.mx=m.ts
    WHERE m.direction='incoming' AND m.ts > ? AND m.ts <= ?
    ORDER BY m.ts DESC LIMIT 6`).all(desde, agora)
  const linhas = []
  for (const n of novas) {
    if (ehSelfPerson(ctx.accountKey || 'main', n.person_id)) continue
    if (getAiSetting(n.person_id, n.channel)?.enabled) continue // a IA já cuida dessa
    linhas.push(`${nomeDe(n.person_id)} te respondeu no ${n.channel}: ${String(n.text || '').slice(0, 80)}`)
  }
  if (!linhas.length) return 0
  await enviarNoSelfChat({ sock: ctx.sock, accountKey: ctx.accountKey || 'main', texto: linhas.join('\n'), origem: 'sistema' })
  logEvent({ type: 'assistente_aviso_resposta', detail: `${linhas.length} pessoa(s)` })
  if (ctx.broadcast) ctx.broadcast({ t: 'assistente' })
  return 1
}

// AVISO ANTES DO COMPROMISSO. Regra do sistema em 28/07/2026, na sequência do aviso de
// lembrete: "compromisso da agenda também avisando no WhatsApp antes da hora", valendo pra
// QUALQUER compromisso — inclusive os que ele marca pelo celular, que o vendas-multicanal nunca tocou.
//
// Usa o MESMO ajuste do lembrete (`lembrete_aviso_min`) de propósito. Dois números pra
// "quanto antes me avisam" acabariam discordando algum dia, e ele teria que lembrar de mexer
// nos dois — é a mesma lição que já custou caro no ajuste de qual IA roda.
//
// Diferente do lembrete, aqui o evento é de OUTRO sistema: não dá pra marcar nada nele, então
// quem lembra que já avisou é a tabela `agenda_aviso`.
export async function avisoDeCompromisso(ctx = {}, { agora = Date.now(), eventos = null } = {}) {
  const min = avisoPadraoMin()
  if (min <= 0) return 0
  let lista = eventos
  if (!lista) {
    // O cache normal é de 5 min, o que atrasaria demais um aviso de 10: um compromisso
    // marcado no celular às 14h52 pra 15h só apareceria às 14h55. Aqui a agenda é relida se
    // estiver com mais de 2 min — 30 chamadas por hora, irrelevante pra cota do Google.
    try {
      const snap = agendaSnapshot()
      if (agora - (snap.ts || 0) > 2 * 60 * 1000) await refreshAgenda()
      else await ensureAgendaFresh()
    } catch { /* agenda fora do ar não pode derrubar o tick */ }
    // Compromisso do calendário da casa também merece aviso: pra quem vai ser avisado, não
    // faz diferença nenhuma em qual sistema o horário foi marcado.
    lista = ocupacaoAgenda({ dias: 2 })
  }
  const janela = min * 60000
  let mandou = 0
  for (const ev of lista) {
    if (!ev || !ev.id || !ev.startMs || ev.allDay) continue      // "dia todo" não tem hora pra avisar
    if (ev.startMs <= agora || ev.startMs - agora > janela) continue
    // marcou agora pra daqui a pouco: ele acabou de fazer isso, avisar é repetir
    if (ev.createdMs && ev.startMs - ev.createdMs <= janela) continue
    if (agendaAvisoJaFeito(ev.id, ev.startMs)) continue
    const faltam = Math.round((ev.startMs - agora) / 60000)
    const quando = faltam >= 1 ? `daqui a ${faltam} ${faltam === 1 ? 'minuto' : 'minutos'}` : 'já já'
    const onde = ev.location ? ` — ${String(ev.location).slice(0, 60)}` : ''
    const texto = `Compromisso ${quando} (${fmtHora.format(new Date(ev.startMs))}): ${ev.title}${onde}`
    try {
      await enviarNoSelfChat({ sock: ctx.sock, accountKey: ctx.accountKey || 'main', texto, origem: 'sistema' })
      // marca DEPOIS do envio: WhatsApp fora do ar tem que avisar no próximo tick, não perder
      marcarAgendaAviso(ev.id, ev.startMs, agora)
      logEvent({ type: 'agenda_aviso', detail: texto })
      if (ctx.broadcast) ctx.broadcast({ t: 'assistente' })
      mandou++
    } catch (e) {
      logEvent({ type: 'agenda_aviso_erro', detail: e.message })
    }
  }
  if (mandou) limparAgendaAvisos()
  return mandou
}

async function resumoDoDia(ctx) {
  if (getSetting('assistente_proativo_dia', true) === false) return 0
  const hora = String(getSetting('assistente_proativo_hora', '08:00'))
  const stamp = S.dayStampSP()
  if (getSetting('assistente_proativo_ultimo_dia', '') === stamp) return 0
  if (horaAgoraSP() < hora) return 0
  // Marca ANTES de enviar: se o envio falhar, não repete a cada 30s o dia inteiro.
  setSetting('assistente_proativo_ultimo_dia', stamp)
  const texto = await textoDoDia({ accountKey: ctx.accountKey || 'main' })
  if (!texto) return 0
  await enviarNoSelfChat({ sock: ctx.sock, accountKey: ctx.accountKey || 'main', texto, origem: 'sistema' })
  logEvent({ type: 'assistente_resumo_dia', detail: texto.slice(0, 120) })
  if (ctx.broadcast) ctx.broadcast({ t: 'assistente' })
  return 1
}

// Alerta de sistema: nasce DESLIGADO. Só avisa na MUDANÇA de estado (conectado -> caiu),
// nunca repete o mesmo aviso.
async function alertaDeSistema(ctx) {
  if (getSetting('assistente_proativo_alertas', false) !== true) return 0
  const status = getWaSession(ctx.accountKey || 'main')?.status || 'IDLE'
  const anterior = String(getSetting('assistente_ultimo_status_wa', ''))
  if (status === anterior) return 0
  setSetting('assistente_ultimo_status_wa', status)
  if (!anterior) return 0 // primeira leitura não é mudança
  const caiu = status !== 'CONNECTED'
  const texto = caiu ? `o WhatsApp saiu do ar aqui (${status})` : 'o WhatsApp voltou'
  await enviarNoSelfChat({ sock: ctx.sock, accountKey: ctx.accountKey || 'main', texto, origem: 'sistema' })
  logEvent({ type: 'assistente_alerta', detail: texto })
  if (ctx.broadcast) ctx.broadcast({ t: 'assistente' })
  return 1
}
