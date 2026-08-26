// Sessão do Instagram no Chrome real da VM (via CDP). Igual ao Tinder: não logamos do
// zero no IP de datacenter (dispara checkpoint) — importamos os cookies do Instagram
// logado do Mac do dono e injetamos no perfil persistente do Chrome. O cookie que
// importa é o sessionid (httpOnly); os outros ajudam a não parecer um device novo.
import { connectBrowser, firstContext } from '../browser/chrome.mjs'
import { getSetting, setSetting, logEvent } from '../core/db.mjs'

const IG = 'https://www.instagram.com'
const KNOWN = ['sessionid', 'ds_user_id', 'csrftoken', 'mid', 'ig_did', 'rur', 'datr', 'shbid', 'shbts', 'ig_nrcb']

// Normaliza vários formatos de entrada num array de cookies do Playwright:
//  - array [{name,value}]           (export de extensão)
//  - objeto {sessionid:'...', ...}  (JSON simples)
//  - string 'sessionid=..; ds_user_id=..'  (copiado do DevTools/Cabeçalho Cookie)
function normalizeCookies(input) {
  let pairs = []
  if (Array.isArray(input)) pairs = input.map((c) => [c.name, c.value])
  else if (input && typeof input === 'object') pairs = Object.entries(input)
  else if (typeof input === 'string') pairs = input.split(/;\s*/).map((s) => { const i = s.indexOf('='); return i < 0 ? [s.trim(), ''] : [s.slice(0, i).trim(), s.slice(i + 1).trim()] })
  return pairs
    .filter(([n, v]) => n && v)
    .map(([name, value]) => ({ name, value: String(value).replace(/^"|"$/g, ''), domain: '.instagram.com', path: '/', secure: true, httpOnly: name === 'sessionid', sameSite: 'Lax' }))
}

export function getIgUa() { return getSetting('ig_ua', null) }
export function getIgMe() { return getSetting('ig_me', null) }

// Injeta os cookies no Chrome da VM e valida abrindo o Instagram. Retorna {ok, me}.
export async function importCookies(input, ua) {
  const list = normalizeCookies(input)
  if (!list.some((c) => c.name === 'sessionid')) throw new Error('faltou o cookie sessionid (o principal, httpOnly — pegue no DevTools > Application > Cookies)')
  const b = await connectBrowser()
  const ctx = firstContext(b)
  if (!ctx) throw new Error('Chrome sem contexto — o perfil persistente não carregou')
  await ctx.addCookies(list)
  if (ua) setSetting('ig_ua', ua)
  setSetting('ig_imported_at', Date.now())
  logEvent({ type: 'ig_session_import', detail: list.map((c) => c.name).join(',') })
  const r = await check(ctx, ua)
  if (r.me) setSetting('ig_me', r.me)
  return r
}

// Abre o Instagram e confere se a sessão está viva (username visível nos dados da página).
async function check(ctx, ua) {
  const p = await ctx.newPage()
  try {
    const cdp = await ctx.newCDPSession(p).catch(() => null)
    if (cdp && (ua || getIgUa())) await cdp.send('Network.setUserAgentOverride', { userAgent: ua || getIgUa() }).catch(() => {})
    await p.goto(IG + '/', { waitUntil: 'domcontentloaded' }).catch(() => {})
    await p.waitForTimeout(3500)
    const url = p.url()
    const me = await p.evaluate(() => {
      const blob = [...document.querySelectorAll('script')].map((s) => s.textContent || '').join('\n')
      const m = blob.match(/"viewer".{0,80}?"username":"([a-zA-Z0-9_.]+)"/) || blob.match(/"username":"([a-zA-Z0-9_.]+)"/)
      return m ? m[1] : null
    }).catch(() => null)
    const cookies = await ctx.cookies(IG).catch(() => [])
    const ok = !!me || (!/accounts\/login/.test(url) && cookies.some((c) => c.name === 'sessionid' && c.value))
    return { ok, me, url }
  } finally { await p.close().catch(() => {}) }
}

// Checagem periódica sem reinjetar (pra o painel avisar se caiu).
export async function checkSession() {
  try {
    const b = await connectBrowser()
    const ctx = firstContext(b)
    if (!ctx) return { ok: false, reason: 'sem contexto' }
    return await check(ctx, getIgUa())
  } catch (e) { return { ok: false, reason: e.message } }
}

export { normalizeCookies }
