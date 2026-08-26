// Painel de operações do vendas-multicanal — servidor HTTP + WebSocket.
// F1: autenticação por senha, tela ao vivo do Chrome (screencast + input) para o
// o dono logar no Tinder. As demais seções (Pessoas, Tinder, WhatsApp, Ajustes,
// Diário) entram nas fases seguintes; o servidor já nasce preparado pra crescer.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { connectBrowser, ensureTinderPage, firstContext, TINDER_HOME } from '../browser/chrome.mjs'
import { LiveScreen } from './live.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(__dirname, 'public')
const PORT = Number(process.env.TIM_PANEL_PORT || 8080)
const HOST = process.env.TIM_PANEL_HOST || '127.0.0.1'
const PASSWORD = process.env.TIM_PANEL_PASSWORD || ''
const SECRET = process.env.TIM_PANEL_SECRET || crypto.randomBytes(32).toString('hex')
const COOKIE = 'tim_session'

if (!PASSWORD) {
  console.error('FATAL: defina TIM_PANEL_PASSWORD no ambiente.')
  process.exit(1)
}

// ---------- auth (cookie assinado por HMAC) ----------
function sign(value) {
  const mac = crypto.createHmac('sha256', SECRET).update(value).digest('hex')
  return `${value}.${mac}`
}
function verify(signed) {
  if (!signed || typeof signed !== 'string') return null
  const i = signed.lastIndexOf('.')
  if (i < 0) return null
  const value = signed.slice(0, i)
  const mac = Buffer.from(signed.slice(i + 1))
  const expect = Buffer.from(crypto.createHmac('sha256', SECRET).update(value).digest('hex'))
  if (mac.length !== expect.length) return null
  return crypto.timingSafeEqual(mac, expect) ? value : null
}
function parseCookies(req) {
  const out = {}
  const h = req.headers.cookie
  if (!h) return out
  for (const part of h.split(';')) {
    const idx = part.indexOf('=')
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
  }
  return out
}
function isAuthed(req) {
  return verify(parseCookies(req)[COOKIE]) === 'ok'
}
function checkPassword(input) {
  const a = Buffer.from(String(input || ''))
  const b = Buffer.from(PASSWORD)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// ---------- estado da tela ao vivo ----------
const state = {
  browser: null,
  context: null,
  tinderPage: null,
  activePage: null,
  live: null,
  sockets: new Set(),
  lastError: null,
  reconnectTimer: null,
  lastFrame: null,
}

function broadcastFrame(dataB64, metadata) {
  state.lastFrame = { data: dataB64, meta: metadata }
  const payload = JSON.stringify({ t: 'frame', data: dataB64, meta: metadata })
  for (const ws of state.sockets) {
    if (ws.readyState === ws.OPEN) { try { ws.send(payload) } catch { /* drop */ } }
  }
}
function broadcastInfo() {
  const payload = JSON.stringify({ t: 'info', url: state.activePage ? safeUrl(state.activePage) : '', connected: !!(state.browser && state.browser.isConnected()) })
  for (const ws of state.sockets) {
    if (ws.readyState === ws.OPEN) { try { ws.send(payload) } catch { /* drop */ } }
  }
}
function safeUrl(p) { try { return p.url() } catch { return '' } }

async function switchLiveTo(page) {
  if (!page) return
  if (state.live) { await state.live.stop().catch(() => {}) }
  state.activePage = page
  state.live = new LiveScreen(page)
  state.live.onFrame(broadcastFrame)
  await state.live.start().catch((e) => { state.lastError = e.message })
  broadcastInfo()
}

async function ensureLive() {
  try {
    state.browser = await connectBrowser()
    state.context = firstContext(state.browser)
    state.tinderPage = await ensureTinderPage(state.browser)
    // Popups de login (Google/Facebook) viram a página ativa; ao fechar, volta ao Tinder.
    if (state.context && !state.context.__timHooked) {
      state.context.__timHooked = true
      state.context.on('page', (p) => {
        switchLiveTo(p)
        p.on('close', () => { if (state.tinderPage && !state.tinderPage.isClosed()) switchLiveTo(state.tinderPage) })
      })
    }
    await switchLiveTo(state.tinderPage)
    state.lastError = null
  } catch (e) {
    state.lastError = e.message
    scheduleReconnect()
  }
}
function scheduleReconnect() {
  if (state.reconnectTimer) return
  state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; ensureLive() }, 3000)
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('não encontrado'); return }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(buf)
  })
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy() })
    req.on('end', () => resolve(data))
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const p = url.pathname

  if (req.method === 'POST' && p === '/api/login') {
    const body = await readBody(req)
    let pass = ''
    try { pass = JSON.parse(body).password } catch { /* form? */ }
    if (checkPassword(pass)) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `${COOKIE}=${encodeURIComponent(sign('ok'))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
      })
      res.end(JSON.stringify({ ok: true }))
    } else {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'senha incorreta' }))
    }
    return
  }

  if (p === '/api/logout') {
    res.writeHead(200, { 'set-cookie': `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`, 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (p === '/api/status') {
    const authed = isAuthed(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      authed,
      chrome: authed ? { connected: !!(state.browser && state.browser.isConnected()), url: state.activePage ? safeUrl(state.activePage) : '', error: state.lastError } : undefined,
    }))
    return
  }

  if (req.method === 'POST' && p === '/api/navigate') {
    if (!isAuthed(req)) { res.writeHead(401); res.end(); return }
    const body = await readBody(req)
    let target = TINDER_HOME
    try { target = JSON.parse(body).url || TINDER_HOME } catch { /* default */ }
    if (state.live) await state.live.navigate(target)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // estáticos + páginas
  if (p === '/' ) {
    serveFile(res, path.join(PUBLIC, isAuthed(req) ? 'app.html' : 'login.html'))
    return
  }
  const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '')
  const file = path.join(PUBLIC, safe)
  if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    serveFile(res, file)
    return
  }
  res.writeHead(404); res.end('não encontrado')
})

// ---------- WebSocket (screencast + input) ----------
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, `http://${req.headers.host}`).pathname !== '/ws' || !isAuthed(req)) {
    socket.destroy(); return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})
wss.on('connection', (ws) => {
  state.sockets.add(ws)
  // manda o último frame na hora — a tela do Tinder é estática, não espera mudança
  if (state.lastFrame) { try { ws.send(JSON.stringify({ t: 'frame', data: state.lastFrame.data, meta: state.lastFrame.meta })) } catch { /* drop */ } }
  broadcastInfo()
  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.t === 'dbg') { console.log('[ws] dbg', JSON.stringify(msg)); return }
    if (!state.live) { console.log('[ws] input sem live ativa:', msg.t); return }
    if (msg.t === 'mouse') {
      if (msg.type !== 'move') console.log('[ws] mouse', msg.type, Math.round(msg.x), Math.round(msg.y))
      if (msg.type === 'down' && state.live.page) {
        // marca onde o clique caiu, para o dono mirar com precisão (some em 1.4s)
        state.live.page.evaluate(([x, y]) => {
          document.getElementById('__timclick')?.remove()
          const d = document.createElement('div')
          d.id = '__timclick'
          d.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:26px;height:26px;margin:-13px 0 0 -13px;border:3px solid #ff2d55;border-radius:50%;background:rgba(255,45,85,.25);z-index:2147483647;pointer-events:none`
          document.body.appendChild(d)
          setTimeout(() => d.remove(), 1400)
        }, [Math.round(msg.x), Math.round(msg.y)]).catch(() => {})
      }
      await state.live.mouse(msg)
    }
    else if (msg.t === 'key') { console.log('[ws] key', msg.type, msg.key); await state.live.key(msg) }
    else if (msg.t === 'text') await state.live.insertText(msg.text)
    else if (msg.t === 'nav') { console.log('[ws] nav', msg.url); await state.live.navigate(msg.url || TINDER_HOME) }
  })
  ws.on('close', () => state.sockets.delete(ws))
  ws.on('error', () => state.sockets.delete(ws))
})

server.listen(PORT, HOST, () => {
  console.log(`[vendas-multicanal-panel] ouvindo em http://${HOST}:${PORT}`)
  ensureLive()
})
