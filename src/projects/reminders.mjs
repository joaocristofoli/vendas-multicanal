// Runtime dos lembretes: um tick no loop do index.mjs. Dispara lembretes vencidos como
// mensagem no self-chat do dono (mensagem pra você mesmo) via WhatsApp — utilitário, sem
// simular digitação. Recorrente recalcula o próximo 'at'; único vira 'feito'. Se o WhatsApp
// estiver offline, não perde: espera o próximo tick. Catch-up: vencido há muito = "atrasado".
import { dueReminders, afterFire, getProject, TZ, reminderPreAvisos, markReminderPreFired } from './store.mjs'
import { logEvent, getSetting } from '../core/db.mjs'
import { sendText } from '../wa/send.mjs'

const LATE_MS = 5 * 60 * 1000 // vencido há mais de 5 min (sem snooze) = disparo atrasado (pós-restart)
const fmtWhen = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ })
const fmtHora = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ })

// Quantos minutos antes avisar, por padrão. Regra do sistema (28/07/2026): lembrete que só toca
// na hora chega tarde pra tudo que exige FAZER algo — "mandar mensagem pra fulano às 19h",
// avisado às 19h em ponto, já nasce atrasado. Ele escolheu 20 minutos ("o aviso pode ser 20
// minutos antes, nao 10"). Ajuste `lembrete_aviso_min`; 0 desliga.
//
// O MESMO número vale pros compromissos da Google Agenda (src/assistente/proativo.mjs): dois
// ajustes pra "quanto antes me avisam" acabariam discordando, e ele teria que lembrar de
// mexer nos dois.
export const AVISO_PADRAO_MIN = 20
export function avisoPadraoMin() {
  const v = Number(getSetting('lembrete_aviso_min', AVISO_PADRAO_MIN))
  return Number.isFinite(v) && v >= 0 ? Math.min(v, 24 * 60) : AVISO_PADRAO_MIN
}

function lineFor(r, late) {
  const proj = r.project_id ? getProject(r.project_id) : null
  const suffix = proj ? ` (${proj.name})` : ''
  const prefix = late ? `Lembrete atrasado (era ${fmtWhen.format(new Date(r.at))}): ` : 'Lembrete: '
  return `${prefix}${r.text}${suffix}`
}

// O texto do aviso prévio. Diz os minutos REAIS que faltam, não os configurados: o tick roda
// a cada 30s e pode pegar o lembrete com 9 min, e prometer 10 quando são 9 é mentira pequena
// que ele confere no relógio. Abaixo de 1 min vira "já", que é o honesto.
export function linhaPreAviso(r, nowMs = Date.now()) {
  const proj = r.project_id ? getProject(r.project_id) : null
  const suffix = proj ? ` (${proj.name})` : ''
  const faltam = Math.round((r.at - nowMs) / 60000)
  const quando = faltam >= 1
    ? `Daqui a ${faltam} ${faltam === 1 ? 'minuto' : 'minutos'}`
    : 'Já já'
  return `${quando} (${fmtHora.format(new Date(r.at))}): ${r.text}${suffix}`
}

// Um tick. getSock()=>socket baileys|null; getSelfJid()=>jid do próprio o dono|null.
// enviarSelf (opcional): quem de fato escreve no self-chat. O index passa o canal do
// assistente, que REGISTRA o id da mensagem — sem isso o lembrete voltaria pelo
// messages.upsert como se fosse o dono falando, e o assistente responderia ao próprio
// lembrete (o eco que a gente jurou não ter). Sem o argumento, o comportamento é o antigo.
export async function reminderTick({ getSock, getSelfJid, broadcast, onFired, enviarSelf, agora = null } = {}) {
  const sock = getSock && getSock()
  const selfJid = getSelfJid && getSelfJid()
  const nowMs = agora || Date.now()
  const due = dueReminders(nowMs)
  const antes = reminderPreAvisos(nowMs, avisoPadraoMin())
  if (!due.length && !antes.length) return 0
  if (!sock || !selfJid) return 0 // WhatsApp offline: não perde, tenta no próximo tick

  // Os avisos prévios vão ANTES dos vencidos: se um lembrete das 19h00 e o aviso do das
  // 19h10 caem no mesmo tick, a ordem natural de leitura é essa.
  for (const r of antes) {
    try {
      const text = linhaPreAviso(r, nowMs)
      if (enviarSelf) await enviarSelf(text)
      else await sendText(sock, selfJid, text, { simulateTyping: false })
      // marca DEPOIS do envio, pelo mesmo motivo do afterFire: se o WhatsApp falhar, o aviso
      // tem que sair no próximo tick em vez de sumir marcado como entregue.
      markReminderPreFired(r.id, nowMs)
      logEvent({ type: 'reminder_pre_fired', detail: text })
      if (broadcast) broadcast({ t: 'reminder', text })
    } catch (e) {
      logEvent({ type: 'reminder_pre_error', detail: e.message })
    }
  }

  let fired = 0
  for (const r of due) {
    const late = !r.snooze_until && (nowMs - r.at) > LATE_MS
    try {
      const text = lineFor(r, late)
      if (enviarSelf) await enviarSelf(text)
      else await sendText(sock, selfJid, text, { simulateTyping: false })
      afterFire(r.id, nowMs)
      logEvent({ type: 'reminder_fired', detail: text })
      fired++
      if (typeof onFired === 'function') onFired(text)
      if (broadcast) { broadcast({ t: 'projects' }); broadcast({ t: 'reminder', text }) }
    } catch (e) {
      // falha de envio: NÃO marca afterFire -> tenta de novo no próximo tick (idempotente)
      logEvent({ type: 'reminder_error', detail: e.message })
    }
  }
  return fired + antes.length
}
