// Auto-deslizar com ritmo humano. Não é loop: é SESSÃO.
//
// O vendas-multicanal não varre o Tinder — ele usa o Tinder como o dono usaria: 3-5 sessões por dia,
// em horários sorteados com o peso do histograma REAL dele, com tempo de leitura por
// perfil, hesitação antes de curtir, micro-pausa de distração e teto diário.
// A eficiência é sacrificada de propósito: sessão que curte 400 perfis em 6 minutos
// resolve o problema errado e queima a conta.
//
// Contrato e provas: docs/TINDER-DESCOBERTA.md B.4
import crypto from 'node:crypto'
import {
  getSetting, setSetting, logEvent, swipeSeen, recordSwipe, markSwipeSent,
  swipeCountsSince, startSwipeSession, endSwipeSession,
} from '../core/db.mjs'
import { julgar, criteriosAtuais } from './criteria.mjs'

// Mensagens ENVIADAS pelo dono por hora (Brasília), do próprio banco do vendas-multicanal — 29.973
// mensagens, coluna Tinder isolada. Pico às 19h, segundo pico às 23h, buraco 3h-7h.
// É a curva que dá o peso do sorteio de horário. Não é chute.
export const HISTOGRAMA = [45, 16, 20, 8, 0, 1, 13, 16, 29, 39, 64, 45, 53, 43, 36, 64, 81, 95, 116, 159, 120, 51, 97, 134]

// Faixa proibida: nenhuma sessão nasce aqui. É o que mais denuncia robô.
export const HORAS_PROIBIDAS = [3, 4, 5, 6]

// tamanhoSessao calibrado pra que 3-5 sessões caibam DENTRO do teto diário — senão as
// últimas sessões do dia nasceriam mortas (sessão que faz 0 swipe não parece gente).
export const TETOS_PADRAO = { porDia: 80, curtidasPorDia: 35, sessoesPorDia: [3, 5], tamanhoSessao: [10, 28] }

const agora = () => Date.now()

// Haversine em milhas — usada só pro offset do passport.
function distanciaMi(a, b) {
  const R = 3958.8
  const rad = (x) => (x * Math.PI) / 180
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
const rnd = (a, b) => a + Math.random() * (b - a)
const rndInt = (a, b) => Math.floor(rnd(a, b + 1))
const espera = (ms) => new Promise((r) => setTimeout(r, ms))

// Horário de Brasília sem depender de TZ do processo.
export function horaBrasilia(ts = agora()) {
  return Number(new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(new Date(ts)))
}
export function diaBrasilia(ts = agora()) {
  const [d, m, a] = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(ts)).split('/')
  return `${a}-${m}-${d}`
}

// Sorteia uma hora com peso do histograma, zerando a faixa proibida.
export function sorteiaHora() {
  const pesos = HISTOGRAMA.map((v, h) => (HORAS_PROIBIDAS.includes(h) ? 0 : v))
  const total = pesos.reduce((a, b) => a + b, 0)
  let x = Math.random() * total
  for (let h = 0; h < 24; h++) { x -= pesos[h]; if (x <= 0) return h }
  return 19
}

// Plano do dia: 3-5 sessões, horários sorteados pela curva, separadas por >= 45 min.
export function planejaDia({ dia = diaBrasilia(), tetos = tetosAtuais() } = {}) {
  const quantas = rndInt(tetos.sessoesPorDia[0], tetos.sessoesPorDia[1])
  const marcas = []
  for (let i = 0; i < quantas * 4 && marcas.length < quantas; i++) {
    const h = sorteiaHora()
    const min = rndInt(0, 59)
    const emMin = h * 60 + min
    if (marcas.some((m) => Math.abs(m.emMin - emMin) < 45)) continue
    marcas.push({ emMin, hora: h, minuto: min, tamanho: rndInt(tetos.tamanhoSessao[0], tetos.tamanhoSessao[1]), feita: false })
  }
  marcas.sort((a, b) => a.emMin - b.emMin)
  return { dia, sessoes: marcas }
}

export function tetosAtuais() { return { ...TETOS_PADRAO, ...(getSetting('swipe_caps', null) || {}) } }
export function planoAtual() {
  const p = getSetting('swipe_plan', null)
  if (p && p.dia === diaBrasilia()) return p
  const novo = planejaDia()
  setSetting('swipe_plan', novo)
  logEvent({ type: 'swipe_plano', channel: 'tinder', detail: { dia: novo.dia, sessoes: novo.sessoes.map((s) => `${String(s.hora).padStart(2, '0')}:${String(s.minuto).padStart(2, '0')} x${s.tamanho}`) } })
  return novo
}

// Tempo "olhando o perfil": log-normal, mediana ~2,5s, cauda até 20s. Curtir demora mais
// que passar — a hesitação humana é na hora de curtir, não na de descartar. Bio longa e
// muitas fotos somam tempo de leitura. Piso absoluto de 1,2s.
export function tempoDeOlhada({ decisao, bioLen = 0, fotos = 0 }) {
  const g = Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random())
  let s = Math.exp(Math.log(2.5) + g * 0.6)
  if (decisao === 'like') s *= rnd(1.4, 1.9)
  s += Math.min(bioLen, 300) / 220
  s += Math.min(fotos, 9) * 0.12
  return Math.round(Math.min(Math.max(s, 1.2), 20) * 1000)
}

// Governador da taxa de curtida: mantém a proporção dentro do alvo (25-40%), decidindo a
// FRONTEIRA. Se já está curtindo demais, fronteira vira pass; se de menos, vira like.
function resolveFronteira({ likes, feitos, alvo }) {
  const taxa = feitos ? likes / feitos : 0
  if (taxa > alvo.max) return 'pass'
  if (taxa < alvo.min) return 'like'
  return Math.random() < (alvo.min + alvo.max) / 2 ? 'like' : 'pass'
}

// Executa UMA sessão. dryRun = modo sombra: julga, grava o motivo e NÃO envia nada.
export async function rodaSessao({ api, tamanho = 20, dryRun = true, aoDecidir = null, duracaoMaxMs = null } = {}) {
  const inicioSessao = agora()
  const criterios = criteriosAtuais()
  const tetos = tetosAtuais()
  // Meia-noite de Brasília em epoch. Zerar as horas de um Date "convertido" dava 21h do dia
  // anterior na VM (que roda em UTC) e o teto diário contava swipes do dia errado.
  // O Brasil não tem mais horário de verão, então -03:00 é estável.
  const inicioDia = Date.parse(`${diaBrasilia()}T00:00:00-03:00`)
  const jaHoje = swipeCountsSince(inicioDia)
  const sessionId = 's' + crypto.randomBytes(6).toString('hex')

  const onde = await api.whereAmI().catch(() => ({ city: null }))
  // Com passport ligado o Tinder segue medindo a distância do GPS REAL (doc A.6): o
  // offset entre os dois pontos é o que permite estimar a distância verdadeira até ela.
  const offsetMi = onde.isTraveling && onde.realPos && onde.travelPos ? distanciaMi(onde.realPos, onde.travelPos) : 0
  startSwipeSession({ id: sessionId, planned: tamanho, city: onde.city, mode: dryRun ? 'sombra' : 'ao vivo' })

  // Quem já te curtiu vem PRIMEIRO: curtir de volta é match garantido, zero desperdício.
  const fila = []
  try { for (const r of await api.fastMatch(30)) fila.push({ ...r, tim_fonte: 'fast_match' }) } catch (e) { logEvent({ type: 'swipe_fila_err', channel: 'tinder', detail: 'fast_match: ' + e.message }) }
  try { for (const r of await api.recs()) fila.push({ ...r, tim_fonte: 'recs' }) } catch (e) { logEvent({ type: 'swipe_fila_err', channel: 'tinder', detail: 'recs: ' + e.message }) }

  let feitos = 0, likes = 0, motivoFim = 'fila esgotada'
  const vistosAgora = new Set()
  for (const rec of fila) {
    const u = rec.user || {}
    if (!u._id) continue
    if (vistosAgora.has(u._id)) continue                              // a mesma pessoa em 2 fontes
    vistosAgora.add(u._id)
    if (swipeSeen(u._id, { enviado: true })) continue                 // idempotência: já deslizada de verdade
    if (feitos >= tamanho) { motivoFim = 'tamanho da sessão'; break }
    // teto de duração: uma sessão humana tem fim no relógio, não só na contagem
    if (duracaoMaxMs && agora() - inicioSessao >= duracaoMaxMs) { motivoFim = 'tempo da sessão'; break }
    if (!dryRun && jaHoje.swipes + feitos >= tetos.porDia) { motivoFim = 'teto diário de swipes'; break }

    const j = julgar(rec, criterios, { offsetMi, fonte: rec.tim_fonte })
    let decisao = j.decisao
    let motivo = j.motivo
    if (decisao === 'fronteira') {
      decisao = resolveFronteira({ likes, feitos, alvo: criterios.taxaLikeAlvo })
      motivo = `fronteira -> ${decisao} (${motivo})`
    } else if (Math.random() < (criterios.ruido || 0)) {
      // Ruído deliberado: um filtro 100% determinístico é uma assinatura; humano é
      // inconsistente. Só inverte decisões de pontuação, nunca as regras duras.
      if (j.camada === 'pontuacao') { decisao = decisao === 'like' ? 'pass' : 'like'; motivo = `ruído -> ${decisao} (${motivo})` }
    }
    if (decisao === 'like' && !dryRun && jaHoje.likes + likes >= tetos.curtidasPorDia) {
      decisao = 'pass'; motivo = `teto de curtidas do dia (${motivo})`
    }

    // Grava ANTES de enviar. Se o processo morrer aqui, no pior caso perdemos o envio —
    // nunca duplicamos o swipe.
    const novo = recordSwipe({
      userId: u._id, name: u.name, age: u.birth_date ? Math.floor((agora() - new Date(u.birth_date)) / 31557600000) : null,
      distance: rec.distance_mi ?? null, decision: decisao, reason: motivo, layer: j.camada, score: j.pontos,
      source: rec.tim_fonte, sessionId, payload: dryRun ? null : { s_number: rec.s_number },
    })
    if (!novo) continue

    await espera(tempoDeOlhada({ decisao, bioLen: String(u.bio || '').length, fotos: (u.photos || []).length }))

    let envio = null
    if (!dryRun) {
      try {
        envio = decisao === 'like'
          ? await api.like({ userId: u._id, sNumber: rec.s_number, photoId: (u.photos || [])[0]?.id, contentHash: rec.content_hash })
          : await api.pass({ userId: u._id, sNumber: rec.s_number })
        // Só carimba o comprovante quando o Tinder ACEITOU. Marcar um 500 como enviado
        // seria comprovante falso — o mesmo erro que o endpoint legado de mensagem cometia.
        if (envio.ok) markSwipeSent(u._id, { httpStatus: envio.status, matched: envio.match })
        else logEvent({ type: 'swipe_recusado', channel: 'tinder', detail: { name: u.name, status: envio.status, decisao } })
        if (envio.status === 429 || envio.status === 403) {
          setSetting('swipe_backoff_until', agora() + 6 * 3600 * 1000)
          logEvent({ type: 'swipe_backoff', channel: 'tinder', detail: { status: envio.status } })
          motivoFim = `backoff ${envio.status}`
          break
        }
      } catch (e) { logEvent({ type: 'swipe_err', channel: 'tinder', detail: e.message }) }
    }

    feitos++
    if (decisao === 'like') likes++
    if (aoDecidir) aoDecidir({ user: u, decisao, motivo, camada: j.camada, pontos: j.pontos, fonte: rec.tim_fonte, envio })

    // Micro-pausa de distração: 8% de chance, 20 a 90 segundos.
    if (Math.random() < 0.08) await espera(rnd(20000, 90000))
  }

  endSwipeSession(sessionId, { done: feitos, likes, reason: motivoFim })
  logEvent({ type: 'swipe_sessao', channel: 'tinder', detail: { sessionId, feitos, likes, modo: dryRun ? 'sombra' : 'ao vivo', fim: motivoFim, cidade: onde.city, offsetMi: Math.round(offsetMi) } })
  return { sessionId, feitos, likes, motivoFim, cidade: onde.city, offsetMi: Math.round(offsetMi) }
}

// Chamado pelo loop de 45s. Não bloqueia: dispara a sessão em segundo plano quando chega
// a hora marcada no plano do dia. Nasce DESLIGADO (swipe_enabled) e em modo sombra.
let rodando = false
let rodandoDesde = 0
const SESSAO_MAX_MS = 45 * 60000   // nenhuma sessão humana passa disso

// Se um travamento segurar o mutex, todas as sessões seguintes do dia morriam caladas.
// Depois do teto, o motor considera a sessão órfã e volta a funcionar.
function mutexPreso() {
  if (!rodando) return false
  if (agora() - rodandoDesde > SESSAO_MAX_MS) {
    logEvent({ type: 'swipe_mutex_liberado', channel: 'tinder', detail: `sessão presa há ${Math.round((agora() - rodandoDesde) / 60000)} min` })
    rodando = false
    return false
  }
  return true
}

export async function swipeTick({ api } = {}) {
  if (mutexPreso()) return null
  if (!getSetting('swipe_enabled', false)) return null
  const backoff = Number(getSetting('swipe_backoff_until', 0)) || 0
  if (backoff > agora()) return null

  const plano = planoAtual()
  const h = horaBrasilia()
  const min = Number(new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', minute: '2-digit' }).format(new Date()))
  const emMin = h * 60 + min
  const alvo = plano.sessoes.find((s) => !s.feita && s.emMin <= emMin && emMin - s.emMin < 60)
  if (!alvo) return null

  alvo.feita = true
  setSetting('swipe_plan', plano)
  rodando = true
  rodandoDesde = agora()
  const dryRun = getSetting('swipe_dry_run', true)
  try {
    return await rodaSessao({ api, tamanho: alvo.tamanho, dryRun })
  } finally { rodando = false }
}

// ---------- validação dos tetos e do ritmo ----------

const trava = (v, min, max) => Math.min(max, Math.max(min, v))
const inteiro = (v, def) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : def)

// Devolve { ok, tetos, erros[], avisos[], projecao }. A projeção é o que o painel mostra
// pro dono ver de imediato quantos swipes por dia a configuração dele significa.
export function validaTetos(entrada = {}) {
  const b = TETOS_PADRAO
  const erros = []
  const avisos = []
  const porDia = trava(inteiro(entrada.porDia, b.porDia), 1, 200)
  let curtidasPorDia = trava(inteiro(entrada.curtidasPorDia, b.curtidasPorDia), 1, 200)
  if (curtidasPorDia > porDia) {
    curtidasPorDia = porDia
    avisos.push('teto de curtidas não pode passar o teto de swipes; ajustei pra igual')
  }
  const sMin = trava(inteiro(entrada.sessoesPorDia?.[0], b.sessoesPorDia[0]), 1, 12)
  const sMax = trava(inteiro(entrada.sessoesPorDia?.[1], b.sessoesPorDia[1]), 1, 12)
  if (sMin > sMax) erros.push({ campo: 'sessoesPorDia', msg: 'mínimo de sessões maior que o máximo' })
  const tMin = trava(inteiro(entrada.tamanhoSessao?.[0], b.tamanhoSessao[0]), 1, 100)
  const tMax = trava(inteiro(entrada.tamanhoSessao?.[1], b.tamanhoSessao[1]), 1, 100)
  if (tMin > tMax) erros.push({ campo: 'tamanhoSessao', msg: 'tamanho mínimo de sessão maior que o máximo' })

  const tetos = { porDia, curtidasPorDia, sessoesPorDia: [sMin, sMax], tamanhoSessao: [tMin, tMax] }
  // Projeção média: se passar do teto, as últimas sessões do dia nascem mortas.
  const projecao = Math.round(((sMin + sMax) / 2) * ((tMin + tMax) / 2))
  if (projecao > porDia) avisos.push(`as sessões planejadas somam ~${projecao} swipes/dia, acima do teto de ${porDia} — as últimas do dia vão parar no meio`)
  if (tMax > 60) avisos.push('sessão de mais de 60 swipes é longa demais pra parecer humana')
  return { ok: erros.length === 0, tetos, erros, avisos, projecao }
}

// Estado completo pro painel. Não chama a API do Tinder — quem quiser `onde`/`conta`
// pede separado, pra não pesar o polling da tela.
export function estadoSwipe() {
  const inicioDia = Date.parse(`${diaBrasilia()}T00:00:00-03:00`)
  const backoff = Number(getSetting('swipe_backoff_until', 0)) || 0
  return {
    ligado: !!getSetting('swipe_enabled', false),
    sombra: getSetting('swipe_dry_run', true) !== false,
    rodando: mutexPreso(),
    backoffAte: backoff > agora() ? backoff : null,
    criterios: criteriosAtuais(),
    tetos: tetosAtuais(),
    plano: getSetting('swipe_plan', null),
    hoje: swipeCountsSince(inicioDia),
    horasProibidas: HORAS_PROIBIDAS,
    histograma: HISTOGRAMA,
    cidades: getSetting('swipe_cities', []),
  }
}

// Roda uma sessão agora, sem esperar o horário do plano. Usada pelo botão do painel.
export async function rodaAgora({ api, tamanho, dryRun, duracaoMaxMs = null }) {
  if (mutexPreso()) return { ok: false, erro: 'já tem uma sessão rodando' }
  rodando = true
  rodandoDesde = agora()
  try {
    const r = await rodaSessao({ api, tamanho, dryRun, duracaoMaxMs })
    return { ok: true, ...r }
  } finally { rodando = false }
}
