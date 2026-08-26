// Painel vendas-multicanal — tela ao vivo. Recebe frames por WebSocket e devolve mouse/teclado.
(() => {
  const stage = document.getElementById('stage')
  const screen = document.getElementById('screen')
  const placeholder = document.getElementById('placeholder')
  const dot = document.getElementById('dot')
  const stateText = document.getElementById('stateText')
  const urlEl = document.getElementById('url')
  const kbdText = document.getElementById('kbdText')
  const foot = document.getElementById('foot')

  let ws = null
  let lastMeta = null
  let armed = false
  let reconnectTimer = null
  let wsUp = false

  // ---------- WebSocket ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws`)
    ws.onopen = () => { wsUp = true; stateText.textContent = 'conectado'; updateFoot() }
    ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.t === 'frame') {
        lastMeta = msg.meta || lastMeta
        // faz o palco ter EXATAMENTE a proporção do frame -> sem letterbox, clique 1:1
        if (lastMeta && lastMeta.deviceWidth && lastMeta.deviceHeight) {
          stage.style.aspectRatio = `${lastMeta.deviceWidth} / ${lastMeta.deviceHeight}`
        }
        screen.src = 'data:image/jpeg;base64,' + msg.data
        if (screen.style.display === 'none') { screen.style.display = 'block'; placeholder.style.display = 'none' }
        updateFoot()
      } else if (msg.t === 'info') {
        setConnected(msg.connected)
        urlEl.textContent = msg.url || ''
      }
    }
    ws.onclose = () => { wsUp = false; setConnected(false); stateText.textContent = 'reconectando…'; updateFoot(); scheduleReconnect() }
    ws.onerror = () => { try { ws.close() } catch {} }
  }
  function scheduleReconnect() {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, 1500)
  }
  function setConnected(on) {
    dot.className = 'dot ' + (on ? 'on' : 'off')
    if (on) stateText.textContent = 'Chrome conectado'
  }
  function updateFoot() {
    const res = lastMeta ? `${lastMeta.deviceWidth}x${lastMeta.deviceHeight}` : '—'
    foot.textContent = `sinal: ${wsUp ? 'ligado' : 'desligado'} · tela: ${res} · ${armed ? 'teclado ativo' : 'teclado livre'}`
  }
  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)) }

  // ---------- coordenadas (palco já tem a proporção do frame; clamp por segurança) ----------
  function toDevice(clientX, clientY) {
    const dw = (lastMeta && lastMeta.deviceWidth) || screen.naturalWidth || 1280
    const dh = (lastMeta && lastMeta.deviceHeight) || screen.naturalHeight || 800
    const rect = screen.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    const scale = Math.min(rect.width / dw, rect.height / dh)
    const renderW = dw * scale, renderH = dh * scale
    const offX = (rect.width - renderW) / 2, offY = (rect.height - renderH) / 2
    let x = (clientX - rect.left - offX) / renderW * dw
    let y = (clientY - rect.top - offY) / renderH * dh
    x = Math.max(0, Math.min(dw, x))
    y = Math.max(0, Math.min(dh, y))
    return { x, y }
  }
  const BTN = { 0: 'left', 1: 'middle', 2: 'right' }

  // ---------- mouse ----------
  stage.addEventListener('mousedown', (e) => {
    e.preventDefault(); arm()
    const r = screen.getBoundingClientRect()
    const p = toDevice(e.clientX, e.clientY)
    send({ t: 'dbg', cx: Math.round(e.clientX), cy: Math.round(e.clientY), rl: Math.round(r.left), rt: Math.round(r.top), rw: Math.round(r.width), rh: Math.round(r.height), nw: screen.naturalWidth, nh: screen.naturalHeight, iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio, x: p ? Math.round(p.x) : null, y: p ? Math.round(p.y) : null })
    if (!p) return
    send({ t: 'mouse', type: 'down', x: p.x, y: p.y, button: BTN[e.button] || 'left', clickCount: e.detail || 1 })
  })
  window.addEventListener('mouseup', (e) => {
    const p = toDevice(e.clientX, e.clientY); if (!p) return
    send({ t: 'mouse', type: 'up', x: p.x, y: p.y, button: BTN[e.button] || 'left', clickCount: e.detail || 1 })
  })
  let moveThrottle = 0
  stage.addEventListener('mousemove', (e) => {
    const now = performance.now()
    if (now - moveThrottle < 30) return
    moveThrottle = now
    const p = toDevice(e.clientX, e.clientY); if (!p) return
    send({ t: 'mouse', type: 'move', x: p.x, y: p.y })
  })
  stage.addEventListener('wheel', (e) => {
    const p = toDevice(e.clientX, e.clientY); if (!p) return
    e.preventDefault()
    send({ t: 'mouse', type: 'wheel', x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY })
  }, { passive: false })
  stage.addEventListener('contextmenu', (e) => e.preventDefault())
  function rectStr() { const r = screen.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}` }

  // ---------- teclado (armado ao focar a tela) ----------
  function arm() { armed = true; stage.classList.add('armed'); stage.focus(); kbdText.textContent = 'teclado ativo — clique fora ou Esc para liberar'; updateFoot() }
  function disarm() { armed = false; stage.classList.remove('armed'); kbdText.textContent = 'teclado liberado — clique na tela para assumir'; updateFoot() }
  stage.addEventListener('blur', disarm)
  document.addEventListener('mousedown', (e) => { if (!stage.contains(e.target)) disarm() })
  window.addEventListener('keydown', (e) => {
    if (!armed) return
    if (e.key === 'Escape') { disarm(); e.preventDefault(); return }
    e.preventDefault()
    const text = (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) ? e.key : undefined
    send({ t: 'key', type: 'down', key: e.key, code: e.code, keyCode: e.keyCode, text })
  })
  window.addEventListener('keyup', (e) => {
    if (!armed) return
    e.preventDefault()
    send({ t: 'key', type: 'up', key: e.key, code: e.code, keyCode: e.keyCode })
  })

  // ---------- toolbar ----------
  document.getElementById('btnHome').addEventListener('click', () => send({ t: 'nav', url: 'https://tinder.com/app/recs' }))
  document.getElementById('btnReload').addEventListener('click', () => send({ t: 'nav', url: 'https://tinder.com/' }))
  document.getElementById('btnLogout').addEventListener('click', async () => { await fetch('/api/logout'); location.href = '/' })

  connect()
  updateFoot()
})()
