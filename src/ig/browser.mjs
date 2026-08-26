// Página do Instagram no Chrome real da VM (via CDP). Reusa uma aba do instagram.com
// se existir, aplica o UA da sessão importada e fecha modais chatos (notificações).
// O Instagram é operado por UMA aba (stateful, sequencial) — diferente do WhatsApp.
import { connectBrowser, firstContext } from '../browser/chrome.mjs'
import { getIgUa } from './session.mjs'

const IG = 'https://www.instagram.com'
let _page = null

export async function igPage() {
  const b = await connectBrowser()
  const ctx = firstContext(b)
  if (!ctx) throw new Error('Chrome sem contexto')
  if (_page && !_page.isClosed()) return _page
  _page = ctx.pages().find((p) => /instagram\.com/.test(p.url())) || (await ctx.newPage())
  try {
    const cdp = await ctx.newCDPSession(_page)
    const ua = getIgUa()
    if (ua) await cdp.send('Network.setUserAgentOverride', { userAgent: ua }).catch(() => {})
  } catch { /* segue sem override */ }
  await _page.setViewportSize({ width: 1280, height: 900 }).catch(() => {})
  return _page
}

// Fecha modais que o Instagram joga por cima (Ativar notificações, etc).
export async function closeModals(page) {
  for (const label of ['Not Now', 'Agora não', 'Not now', 'Cancel']) {
    const el = await page.$(`text="${label}"`).catch(() => null)
    if (el) { await el.click().catch(() => {}); await page.waitForTimeout(700); return true }
  }
  return false
}

// O Instagram é operado por UMA aba: as operações (sync, abrir thread, enviar) NÃO
// podem rodar concorrentes na mesma página. igExclusive serializa tudo numa fila.
// CADA operação tem timeout: se uma travar (Chrome em estado ruim), ela é abandonada e a
// fila AVANÇA — senão um único travamento congelaria o Instagram inteiro pra sempre.
const IG_OP_TIMEOUT_MS = Number(process.env.TIM_IG_OP_TIMEOUT_MS || 150000)
function withTimeout(p, ms) {
  let t
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`operação do Instagram excedeu ${Math.round(ms / 1000)}s`)), ms) })
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(t)), timeout])
}
let _chain = Promise.resolve()
export function igExclusive(fn) {
  const run = _chain.then(() => withTimeout(fn(), IG_OP_TIMEOUT_MS))
  _chain = run.then(() => {}, () => {})
  return run
}

export { IG }
