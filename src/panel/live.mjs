// Tela ao vivo do Chrome pelo painel: screencast (CDP Page.startScreencast) +
// passagem de input (mouse/teclado) via CDP Input.*. É por aqui que o dono loga
// no Tinder e resolve qualquer tela inesperada (captcha, verificação) sem SSH.

export class LiveScreen {
  constructor(page) {
    this.page = page
    this.client = null
    this.frameListeners = new Set()
    this.lastMetadata = null
    this.running = false
  }

  async start({ format = 'jpeg', quality = 55, maxWidth = 1280, maxHeight = 800 } = {}) {
    if (this.running) return
    this.client = await this.page.context().newCDPSession(this.page)
    this.client.on('Page.screencastFrame', async (frame) => {
      this.lastMetadata = frame.metadata
      for (const cb of this.frameListeners) {
        try { cb(frame.data, frame.metadata) } catch { /* listener morto */ }
      }
      try { await this.client.send('Page.screencastAck', { sessionId: frame.sessionId }) } catch { /* frame já descartado */ }
    })
    await this.client.send('Page.startScreencast', { format, quality, maxWidth, maxHeight, everyNthFrame: 1 })
    this.running = true
  }

  onFrame(cb) { this.frameListeners.add(cb); return () => this.frameListeners.delete(cb) }

  async stop() {
    if (!this.running || !this.client) return
    try { await this.client.send('Page.stopScreencast') } catch { /* já parado */ }
    this.running = false
  }

  // x,y já em CSS px do viewport (o front converte pela proporção do frame).
  async mouse({ type, x, y, button = 'left', clickCount = 1, deltaX = 0, deltaY = 0 }) {
    if (!this.client) return
    const map = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved', wheel: 'mouseWheel' }
    const t = map[type]
    if (!t) return
    const params = { type: t, x: Math.round(x), y: Math.round(y), button, clickCount }
    if (t === 'mouseWheel') { params.deltaX = deltaX; params.deltaY = deltaY; params.button = 'none' }
    if (t === 'mouseMoved') { params.button = 'none' }
    try { await this.client.send('Input.dispatchMouseEvent', params) } catch { /* viewport trocou */ }
  }

  async key({ type, key, code, keyCode = 0, text }) {
    if (!this.client) return
    const t = type === 'down' ? 'keyDown' : 'keyUp'
    const params = {
      type: text && t === 'keyDown' ? 'keyDown' : t,
      key, code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    }
    if (t === 'keyDown' && text) { params.text = text; params.unmodifiedText = text }
    try { await this.client.send('Input.dispatchKeyEvent', params) } catch { /* ignore */ }
  }

  async insertText(text) {
    if (!this.client || !text) return
    try { await this.client.send('Input.insertText', { text }) } catch { /* ignore */ }
  }

  async navigate(url) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {})
  }

  currentUrl() { try { return this.page.url() } catch { return '' } }
}
