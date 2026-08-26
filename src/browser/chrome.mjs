// Conecta no Chrome REAL (lançado pelo systemd sob Xvfb, com --remote-debugging-port)
// via CDP usando Playwright. O vendas-multicanal NUNCA lança o Chrome com flags de automação:
// conecta num Chrome que já roda como processo normal — menos rastro de robô e a
// sessão do Tinder sobrevive a restart do núcleo (vendas-multicanal-core).
import { chromium } from 'playwright-core'

const DEFAULT_ENDPOINT = process.env.TIM_CDP_ENDPOINT || 'http://127.0.0.1:9222'
export const TINDER_HOME = 'https://tinder.com/app/recs'

let _browser = null
let _connecting = null

export async function connectBrowser(endpoint = DEFAULT_ENDPOINT) {
  if (_browser && _browser.isConnected()) return _browser
  if (_connecting) return _connecting
  _connecting = chromium.connectOverCDP(endpoint).then((browser) => {
    _browser = browser
    browser.on('disconnected', () => { if (_browser === browser) _browser = null })
    _connecting = null
    return browser
  }).catch((err) => { _connecting = null; throw err })
  return _connecting
}

export function firstContext(browser) {
  const contexts = browser.contexts()
  return contexts[0] || null
}

// Garante uma página do Tinder na aba controlada (reusa a existente, não recarrega à toa).
export async function ensureTinderPage(browser, { url = TINDER_HOME } = {}) {
  const context = firstContext(browser)
  if (!context) throw new Error('Chrome sem contexto — o perfil persistente não carregou')
  let page = context.pages().find((p) => /(^|\.)tinder\.com/.test(safeHost(p.url())))
  if (!page) {
    page = context.pages()[0] || await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {})
  }
  return page
}

function safeHost(u) { try { return new URL(u).host } catch { return '' } }

export async function probe(endpoint = DEFAULT_ENDPOINT) {
  const browser = await connectBrowser(endpoint)
  const ctx = firstContext(browser)
  const pages = ctx ? ctx.pages() : []
  return {
    connected: browser.isConnected(),
    contexts: browser.contexts().length,
    pages: pages.map((p) => p.url()),
  }
}

// `node src/browser/chrome.mjs --probe` — checagem de fumaça da conexão CDP.
if (process.argv.includes('--probe')) {
  probe()
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0) })
    .catch((e) => { console.error('probe falhou:', e.message); process.exit(1) })
}
