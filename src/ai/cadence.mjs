// Cadência HUMANA de resposta: a IA não responde na hora. Antes de responder uma
// pendência, agenda um atraso variável e só envia quando ele passa. Vale pros 3 canais.
// Fatores (regra do sistema, 24/07/2026):
//   - VARIAÇÃO: sempre com ruído aleatório, nunca o mesmo tempo.
//   - RECIPROCIDADE: espelha (amortecido) o tempo que ELA levou pra te responder.
//   - INTERESSE: se ela respondeu rápido ou fez pergunta, responde mais rápido.
//   - HORA: de madrugada estica bastante (ninguém responde na hora às 4h).
//   - TEMPO JÁ DECORRIDO: se a mensagem dela é antiga, parte da espera já passou.
// Reversível pelo setting `reply_cadence` (default ligado): desligado = responde na hora.
import { timeline, getAiSetting, setReplySchedule, getSetting, logEvent } from '../core/db.mjs'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const rand = (a, b) => a + Math.random() * (b - a)
const MIN_DELAY = 15_000            // nunca menos que 15s (senão parece bot instantâneo)
const MAX_DELAY = 35 * 60_000       // teto de 35min: perceptível, mas nunca "sumiu" (só madrugada chega perto)
const RECIP_CAP = 12 * 60_000       // teto do espelho de reciprocidade: quem some horas e VOLTA é
                                    // respondido num tempo razoável, não com o sumiço inteiro espelhado

const median = (arr) => { const a = [...arr].sort((x, y) => x - y); const n = a.length; return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null }

// Calcula QUANTO esperar (ms) desde a chegada da última mensagem dela. O que manda é o
// RITMO das trocas ATIVAS (não o último gap): quem some 11h e volta, mas antes conversava
// em segundos, é respondido em segundos — porque agora está online. Sumiços (>25min) não
// contam pro ritmo. E se ela está ATIVA agora (burst / ritmo rápido), acelera mais ainda.
export function computeReplyDelay({ personId, now = Date.now() }) {
  const msgs = timeline(personId, 25) // ordem crescente (mais antiga -> mais nova)
  const lastIn = [...msgs].reverse().find((m) => m.direction === 'incoming') || null
  const incomingTs = lastIn?.ts ?? null

  // gaps de resposta DELA (minha mensagem -> resposta dela). Separa "trocas ativas" (<25min,
  // ritmo de conversa) de "pausas" (sumiços). O ritmo ativo é o que define a velocidade.
  const gaps = []
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].direction === 'incoming' && msgs[i - 1].direction === 'outgoing') {
      const g = msgs[i].ts - msgs[i - 1].ts
      if (g > 1_000) gaps.push(g)
    }
  }
  const ativos = gaps.filter((g) => g < 25 * 60_000)
  const ritmo = ativos.length ? median(ativos) : (gaps.length ? median(gaps) : null)

  // base = espelha o ritmo (40-90% dele), capado; sem histórico usa faixa padrão
  let base = (ritmo != null)
    ? clamp(ritmo * rand(0.40, 0.90), 20_000, RECIP_CAP)
    : rand(45_000, 4 * 60_000)

  // ATIVIDADE AGORA (regra do sistema): acelera se ela perguntou, se o ritmo dela é rápido
  // (<2min), ou se ela está num burst (2 últimas mensagens dela coladas, <5min).
  const perguntou = /\?/.test(lastIn?.text || '')
  const ritmoRapido = ritmo != null && ritmo < 120_000
  if (perguntou || ritmoRapido) base *= rand(0.30, 0.55)
  // BURST: ela mandou 2+ mensagens coladas (<5min) agora = está digitando ativamente ->
  // responde bem rápido (não importa o ritmo histórico), como quem tá com o cel na mão.
  const ins = msgs.filter((m) => m.direction === 'incoming')
  const burst = ins.length >= 2 && (ins[ins.length - 1].ts - ins[ins.length - 2].ts) < 5 * 60_000
  if (burst) base = Math.min(base, rand(20_000, 75_000))
  const ativa = perguntou || ritmoRapido || burst

  // madrugada no fuso do dono (proxy do fuso da pessoa): 0h-7h estica 2-3.5x
  const hora = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(now))
  const madrugada = hora >= 0 && hora < 7
  if (madrugada) base *= rand(2, 3.5)

  const delay = Math.round(clamp(base * rand(0.8, 1.25), MIN_DELAY, MAX_DELAY))
  return { delay, incomingTs, ritmo, ativa, madrugada }
}

// Gate chamado pelos autoreplies. Retorna 'send' (responde agora) ou 'wait' (espera).
// Primeira vez que vê a pendência: agenda e devolve 'wait' (a não ser que o atraso já
// tenha passado por a mensagem ser antiga). Depois: 'send' quando reply_at chega.
export function replyGate({ personId, channel, fp, now = Date.now() }) {
  if (!getSetting('reply_cadence', true)) return 'send' // desligado -> comportamento antigo
  const s = getAiSetting(personId, channel)
  if (s?.scheduled_fp === fp) return now >= (s.reply_at || 0) ? 'send' : 'wait'

  // pendência nova (fp nunca agendado): calcula o atraso e desconta o tempo já decorrido
  const { delay, incomingTs, ritmo, ativa, madrugada } = computeReplyDelay({ personId, now })
  const jaEsperou = incomingTs ? Math.max(0, now - incomingTs) : 0
  const restante = Math.max(0, delay - jaEsperou)
  setReplySchedule({ personId, channel, fp, replyAt: now + restante })
  if (restante > 1500) {
    const tag = [ativa ? 'ativa' : null, madrugada ? 'madrugada' : null,
      ritmo != null ? `ritmo ~${humano(ritmo)}` : 'sem base'].filter(Boolean).join(', ')
    logEvent({ type: 'auto_scheduled', personId, channel, detail: `responde em ~${humano(restante)} (${tag})` })
    return 'wait'
  }
  return 'send'
}

function humano(ms) {
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s}s`
  const min = Math.round(s / 60)
  if (min < 90) return `${min}min`
  return `${(min / 60).toFixed(1)}h`
}
