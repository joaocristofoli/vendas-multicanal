// Google Agenda do vendas-multicanal — UMA conta só (o dono). Cérebro único, uma agenda.
// Portado do padrão do implementação de referência (src/lib/google-calendar.ts): OAuth2 offline +
// refresh_token, wrapper de calendar/v3, escrita idempotente carimbada. Aqui os tokens
// vivem no `setting` (chave google_agenda), não por-pessoa. Leitura + criação de evento.
import crypto from 'node:crypto'
import { getSetting, setSetting } from '../core/db.mjs'
import { SISTEMA } from '../core/caminhos.mjs'

const TZ = 'America/Sao_Paulo'
const SETTING_KEY = 'google_agenda'
const STATE_MAX_AGE_MS = 15 * 60 * 1000
// calendar = ler/escrever eventos; userinfo.email = saber qual conta conectou.
const SCOPE = ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/userinfo.email', 'openid'].join(' ')

const CLIENT_ID = () => process.env.GOOGLE_AGENDA_CLIENT_ID || ''
const CLIENT_SECRET = () => process.env.GOOGLE_AGENDA_CLIENT_SECRET || ''
const STATE_SECRET = () => process.env.TIM_PANEL_SECRET || 'vendas-multicanal-google-agenda'

export function isConfigured() { return Boolean(CLIENT_ID() && CLIENT_SECRET()) }

function conn() { return getSetting(SETTING_KEY, null) }
function saveConn(patch) { setSetting(SETTING_KEY, { ...(conn() || {}), ...patch }) }

// ---------- URL pública (redirect do OAuth precisa bater EXATO com o registrado) ----------
// O redirect tem que ser SEMPRE o mesmo (o registrado no client OAuth), independente de
// qual forma do domínio sslip o dono acessa (pontos vs traços resolvem pro mesmo IP).
// Por isso TIM_PUBLIC_URL manda; só cai pro Host do request se ele não estiver setado.
//
// E o último degrau NÃO pode ser um endereço escrito à mão: ele era o IP da instância de
// origem (`203.0.113.10`), então uma instância clonada que chegasse aqui mandaria o OAuth
// entregar o `code` NA MÁQUINA DA OUTRA — a pior forma de falhar, porque o navegador mostra
// uma tela do Google normal. Sem `TIM_PUBLIC_URL` e sem Host, isto reprova falando.
export function baseUrl(req) {
  const fixed = process.env.TIM_PUBLIC_URL
  if (fixed) return fixed.replace(/\/+$/, '')
  const host = req?.headers?.host
  if (host) return `https://${host}`
  throw new Error(`não sei o endereço público desta instância (${SISTEMA}): defina TIM_PUBLIC_URL no env — sem isso o redirect do OAuth iria para o endereço de outra máquina`)
}
export function redirectUri(req) { return `${baseUrl(req)}/api/agenda/oauth/callback` }

// ---------- state assinado (HMAC), curto ----------
function signState() {
  const payload = JSON.stringify({ ts: Date.now(), n: crypto.randomBytes(8).toString('hex') })
  const b64 = Buffer.from(payload, 'utf8').toString('base64url')
  const mac = crypto.createHmac('sha256', STATE_SECRET()).update(b64).digest('base64url')
  return `${b64}.${mac}`
}
function verifyState(state) {
  const [b64, mac] = String(state || '').split('.')
  if (!b64 || !mac) throw new Error('state inválido')
  const exp = crypto.createHmac('sha256', STATE_SECRET()).update(b64).digest('base64url')
  const a = Buffer.from(mac), b = Buffer.from(exp)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('assinatura do state inválida')
  const parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
  if (!parsed.ts || Date.now() - parsed.ts > STATE_MAX_AGE_MS) throw new Error('state expirado')
  return parsed
}

export function buildConnectUrl(req) {
  if (!isConfigured()) throw new Error('GOOGLE_AGENDA_CLIENT_ID/SECRET não configurados')
  const params = new URLSearchParams({
    access_type: 'offline',        // pra vir refresh_token
    prompt: 'consent',             // força o consent (garante refresh_token sempre)
    client_id: CLIENT_ID(),
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: SCOPE,
    state: signState(),
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

// ---------- troca de token ----------
async function exchangeToken({ code, refreshToken, redirectUri: ru }) {
  const params = new URLSearchParams({ client_id: CLIENT_ID(), client_secret: CLIENT_SECRET() })
  if (refreshToken) { params.set('grant_type', 'refresh_token'); params.set('refresh_token', refreshToken) }
  else if (code && ru) { params.set('grant_type', 'authorization_code'); params.set('code', code); params.set('redirect_uri', ru) }
  else throw new Error('parâmetros insuficientes pra trocar token')
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params,
  })
  if (!r.ok) throw new Error(`falha ao trocar token do Google: ${await r.text()}`)
  return r.json()
}

async function fetchUserEmail(accessToken) {
  const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!r.ok) return null
  const j = await r.json().catch(() => ({}))
  return j.email || null
}

// Fecha a conexão: troca o code, descobre o email, persiste tokens. Chamado no callback.
export async function completeOAuth({ code, state, req }) {
  if (!isConfigured()) throw new Error('integração da agenda não configurada')
  verifyState(state)
  const token = await exchangeToken({ code, redirectUri: redirectUri(req) })
  const email = await fetchUserEmail(token.access_token)
  saveConn({
    email, calendarId: 'primary',
    accessToken: token.access_token,
    refreshToken: token.refresh_token || conn()?.refreshToken || null,
    tokenExpiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
    scope: token.scope || SCOPE,
    connectedAt: Date.now(),
    syncEnabled: true,
  })
  return { email }
}

export function disconnect() { setSetting(SETTING_KEY, null) }

// Devolve um access token válido, renovando pelo refresh_token quando perto de expirar.
async function freshToken() {
  const c = conn()
  if (!c || !c.syncEnabled || !c.refreshToken) throw new Error('agenda não conectada')
  if (c.accessToken && c.tokenExpiresAt && c.tokenExpiresAt - Date.now() > 60_000) return c.accessToken
  const token = await exchangeToken({ refreshToken: c.refreshToken })
  saveConn({
    accessToken: token.access_token,
    tokenExpiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : c.tokenExpiresAt,
    scope: token.scope || c.scope,
  })
  return token.access_token
}

async function calendarRequest(pathPart, init) {
  const accessToken = await freshToken()
  const r = await fetch(`https://www.googleapis.com/calendar/v3${pathPart}`, {
    ...init,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${accessToken}`, ...(init?.headers || {}) },
  })
  if (!r.ok) { const body = await r.text(); const e = new Error(`Google Calendar ${r.status}: ${body}`); e.status = r.status; throw e }
  if (r.status === 204 || init?.method === 'DELETE') return null
  return r.json()
}

// ---------- leitura ----------
function parseEventTime(v) {
  if (!v) return { ms: null, allDay: false }
  if (v.dateTime) { const d = Date.parse(v.dateTime); return { ms: Number.isNaN(d) ? null : d, allDay: false } }
  if (v.date) { const d = Date.parse(`${v.date}T00:00:00-03:00`); return { ms: Number.isNaN(d) ? null : d, allDay: true } }
  return { ms: null, allDay: false }
}

function normalizeEvent(ev) {
  const s = parseEventTime(ev?.start), e = parseEventTime(ev?.end)
  return {
    id: ev?.id || null,
    title: (ev?.summary || '').trim() || 'Compromisso sem título',
    description: ev?.description || null,
    // quando o evento foi CRIADO: é o que permite não avisar "daqui a 8 min" de um
    // compromisso que ele acabou de marcar no celular. Mesma regra do lembrete.
    createdMs: ev?.created ? Date.parse(ev.created) || null : null,
    startMs: s.ms,
    endMs: e.ms,
    allDay: s.allDay,
    location: ev?.location || null,
    htmlLink: ev?.htmlLink || null,
    recurring: Boolean(ev?.recurringEventId),
    attendees: (Array.isArray(ev?.attendees) ? ev.attendees : []).map((a) => ({
      name: a.displayName || null,
      email: a.email || null,
      response: a.responseStatus || null,
      self: Boolean(a.self),
    })),
    isTim: ev?.extendedProperties?.private?.timSource === 'detected',
    projectId: ev?.extendedProperties?.private?.timProjectId || null,
  }
}

// Eventos da agenda primária num intervalo [timeMin, timeMax]. Normalizado e ordenado.
export async function listRange({ timeMinIso, timeMaxIso, max = 250 } = {}) {
  const c = conn()
  if (!c || !c.syncEnabled) return []
  const calId = encodeURIComponent(c.calendarId || 'primary')
  const params = new URLSearchParams({
    singleEvents: 'true', orderBy: 'startTime', showDeleted: 'false', maxResults: String(max),
    timeMin: timeMinIso, timeMax: timeMaxIso,
  })
  const res = await calendarRequest(`/calendars/${calId}/events?${params.toString()}`)
  const items = Array.isArray(res?.items) ? res.items : []
  return items.map(normalizeEvent).filter((ev) => ev.startMs).sort((a, b) => a.startMs - b.startMs)
}

// Próximos compromissos (a partir de agora) — usado pelo cérebro e pelo cache.
export async function listUpcoming({ days = 10, max = 25 } = {}) {
  return listRange({ timeMinIso: new Date().toISOString(), timeMaxIso: new Date(Date.now() + days * 86400000).toISOString(), max })
}

// ---------- escrita ----------
// Cria um evento carimbado (timSource=detected) na agenda do dono. Datas em RFC3339.
// projectId (opcional): carimba timProjectId pra o compromisso ser agrupado sob um projeto.
export async function createEvent({ title, startsAtIso, endsAtIso, description, personId, channel, projectId, duracaoMinutos = null, servico = null, faixa = null }) {
  const c = conn()
  if (!c || !c.syncEnabled) throw new Error('agenda não conectada')
  const calId = encodeURIComponent(c.calendarId || 'primary')
  const start = new Date(startsAtIso)
  if (Number.isNaN(start.getTime())) throw new Error('data de início inválida')
  const min = Number(duracaoMinutos)
  const end = endsAtIso && !Number.isNaN(Date.parse(endsAtIso))
    ? new Date(endsAtIso)
    : new Date(start.getTime() + (Number.isFinite(min) && min > 0 ? min : 60) * 60 * 1000)
  const footer = personId ? 'Criado pelo vendas-multicanal a partir de uma conversa.' : 'Criado pelo vendas-multicanal.'
  const payload = {
    summary: String(title || 'Compromisso').slice(0, 300),
    description: [description, '', footer].filter((v) => v != null).join('\n').slice(0, 2000),
    start: { dateTime: start.toISOString(), timeZone: TZ },
    end: { dateTime: end.toISOString(), timeZone: TZ },
    extendedProperties: { private: {
      timSource: 'detected',
      ...(personId ? { personId: String(personId) } : {}),
      ...(channel ? { channel: String(channel) } : {}),
      ...(projectId ? { timProjectId: String(projectId) } : {}),
      ...(servico ? { timServico: String(servico).slice(0, 80) } : {}),
      ...(faixa ? { timFaixa: String(faixa).slice(0, 40) } : {}),
      ...(Number.isFinite(min) && min > 0 ? { timMinutos: String(min) } : {}),
    } },
  }
  const res = await calendarRequest(`/calendars/${calId}/events`, { method: 'POST', body: JSON.stringify(payload) })
  return { id: res?.id || null, htmlLink: res?.htmlLink || null }
}

function validDateKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.toISOString().slice(0, 10) === value ? value : null
}

function nextDateKey(value) {
  const valid = validDateKey(value)
  if (!valid) return null
  return new Date(Date.parse(`${valid}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
}

// Edita uma ocorrência na agenda primária. PATCH preserva propriedades que o painel
// não gerencia (convidados, recorrência, Meet e vínculos do vendas-multicanal).
export async function updateEvent({ eventId, title, startsAtIso, endsAtIso, allDay = false, startDate, endDate, location, description }) {
  const c = conn()
  if (!c || !c.syncEnabled) throw new Error('agenda não conectada')
  const id = String(eventId || '').trim()
  if (!id) throw new Error('evento inválido')
  const summary = String(title || '').trim()
  if (!summary) throw new Error('título obrigatório')

  let start
  let end
  if (allDay) {
    const first = validDateKey(startDate)
    const last = validDateKey(endDate || startDate)
    if (!first || !last || last < first) throw new Error('datas inválidas')
    start = { date: first }
    end = { date: nextDateKey(last) }
  } else {
    const startMs = Date.parse(startsAtIso)
    const endMs = Date.parse(endsAtIso)
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) throw new Error('horário inválido')
    start = { dateTime: new Date(startMs).toISOString(), timeZone: TZ }
    end = { dateTime: new Date(endMs).toISOString(), timeZone: TZ }
  }

  const calId = encodeURIComponent(c.calendarId || 'primary')
  const payload = {
    summary: summary.slice(0, 300),
    location: String(location || '').trim().slice(0, 1000),
    description: String(description || '').trim().slice(0, 8000),
    start,
    end,
  }
  const res = await calendarRequest(`/calendars/${calId}/events/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
  return normalizeEvent(res)
}

export async function deleteEvent(eventId) {
  const c = conn()
  if (!c || !c.syncEnabled) throw new Error('agenda não conectada')
  const id = String(eventId || '').trim()
  if (!id) throw new Error('evento inválido')
  const calId = encodeURIComponent(c.calendarId || 'primary')
  await calendarRequest(`/calendars/${calId}/events/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return true
}

export function connectionState() {
  const c = conn()
  return {
    configured: isConfigured(),
    connected: Boolean(c?.syncEnabled && c?.connectedAt),
    email: c?.email || null,
    calendarId: c?.calendarId || 'primary',
    connectedAt: c?.connectedAt || null,
  }
}

export { TZ }
