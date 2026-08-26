// Leitura e envio de DMs do Instagram pelo DOM (Playwright no Chrome real logado).
// Seletores descobertos por exploração ao vivo (ver docs/ e tests-tim/ig-explore*):
//  - lista:    div[role="button"][tabindex="0"] contendo img[alt="user-profile-picture"]
//  - thread:   URL /direct/t/{id}/ ; mensagens = div[dir="auto"], in/out pela posição X
//  - composer: div[role="textbox"][contenteditable="true"] (Lexical), envia com Enter
import { closeModals, IG } from './browser.mjs'
import { parseIgSeparator } from './igtime.mjs'

export function threadIdFromUrl(url) { const m = String(url || '').match(/\/direct\/t\/(\d+)/); return m ? m[1] : null }

// Converte o "tempo" que o inbox mostra ("21 m", "2 h", "agora", "ontem", "1 sem")
// num timestamp absoluto aproximado. Retorna null pro que não dá pra cravar (dia da
// semana antigo), aí o chamador mantém o que já tinha.
export function relTimeToTs(text, nowMs = Date.now()) {
  if (!text) return null
  const s = String(text).toLowerCase().trim()
  if (/^(agora|now|activ|online)/.test(s)) return nowMs
  if (/^(ontem|yesterday)/.test(s)) return nowMs - 86400000
  const m = s.match(/^(\d+)\s*(min|m|h|d|sem|semanas?|w)\b/)
  if (m) {
    const n = parseInt(m[1], 10); const u = m[2]
    if (u === 'h') return nowMs - n * 3600000
    if (u === 'd') return nowMs - n * 86400000
    if (u === 'w' || u.startsWith('sem')) return nowMs - n * 7 * 86400000
    return nowMs - n * 60000 // "min" ou "m" = minutos
  }
  return null // dia da semana etc: desconhecido
}

// O inbox troca a prévia real por "2 new messages" quando há não-lidas. Esse texto é
// metadado (e também o contador), não uma mensagem da conversa.
export function parseInboxLines(input) {
  const lines = (Array.isArray(input) ? input : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
  if (!lines.length) return null
  // O separador já apareceu como "·", "•" e "." em contas/idiomas diferentes.
  // Se o ponto virar prévia, a sidebar sobe na hora mas mostra só "." — exatamente o
  // sintoma de que o inbox sabe da novidade e o histórico ainda não a leu.
  const isTime = (line) => /^[·•.]$/.test(line) || /^(unread|não lida|agora|now|active|online|\d+\s*(min|m|h|d|sem|semanas?|w)|ontem|yesterday|seg|ter|qua|qui|sex|s[áa]b|dom)\b/i.test(line)
  const unreadCount = (line) => {
    if (/^(unread|não lida)$/i.test(line)) return 1
    if (/^(new|unread)\s+messages?$/i.test(line) || /^novas?\s+mensagens?$/i.test(line)) return 1
    const m = line.match(/^(\d+)\s+(?:(?:new|unread)\s+messages?|novas?\s+mensagens?|mensagens?\s+não\s+lidas?)$/i)
    return m ? Number(m[1]) : 0
  }
  const rest = lines.slice(1)
  const unread = rest.reduce((n, line) => Math.max(n, unreadCount(line)), 0)
  const preview = rest.find((line) => !isTime(line) && !unreadCount(line)) || ''
  const timeText = rest.find((line) => isTime(line) && !/^[·•.]$/.test(line) && !/^(unread|não lida)$/i.test(line)) || null
  return {
    name: lines[0],
    preview,
    unread,
    fromMe: /^(you|você)\b/i.test(preview),
    timeText,
  }
}

// Lê a LISTA de conversas do inbox (rápido, sem abrir cada uma). Cada linha traz o
// horário relativo ("21 m", "agora"…) que vira ts real — é o que conserta a hora/ordem.
export async function readInbox(page, { max = 20 } = {}) {
  await page.goto(`${IG}/direct/inbox/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(3500)
  await closeModals(page)
  await page.waitForTimeout(600)
  const rows = await page.evaluate((max) => {
    const out = []
    const seen = new Set()
    for (const btn of document.querySelectorAll('div[role="button"][tabindex="0"]')) {
      const img = btn.querySelector('img[alt="user-profile-picture"]')
      if (!img) continue
      const lines = (btn.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean)
      if (!lines.length) continue
      const name = lines[0]
      if (!name || seen.has(name)) continue
      seen.add(name)
      out.push({ lines, avatar: (img.getAttribute('src') || null) })
      if (out.length >= max) break
    }
    return out
  }, max)
  const nowMs = Date.now()
  return rows.map((r) => {
    const parsed = parseInboxLines(r.lines)
    return parsed ? { ...parsed, avatar: r.avatar, ts: relTimeToTs(parsed.timeText, nowMs) } : null
  }).filter(Boolean)
}

// Clica no item da lista cujo nome bate e abre a conversa; retorna o thread_id.
export async function openThreadByName(page, name) {
  const btns = await page.$$('div[role="button"][tabindex="0"]')
  for (const btn of btns) {
    const txt = await btn.innerText().catch(() => '')
    if ((txt.split('\n')[0] || '').trim() === name && (await btn.$('img[alt="user-profile-picture"]'))) {
      await btn.click().catch(() => {})
      await page.waitForTimeout(3000)
      await closeModals(page)
      return threadIdFromUrl(page.url())
    }
  }
  return null
}

// Vai direto numa thread pelo id.
export async function openThreadById(page, threadId) {
  await page.goto(`${IG}/direct/t/${threadId}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(3000)
  await closeModals(page)
  return threadIdFromUrl(page.url())
}

const messageToken = (m) => `${m.dir}|${m.mkey || m.text}`

// Os snapshots se sobrepõem enquanto a lista virtualizada rola. Costura as janelas pela
// maior sequência comum na borda, em vez de deduplicar por texto globalmente (duas
// mensagens "kkkk" iguais continuam sendo duas mensagens).
export function mergeThreadSnapshots(chunks) {
  let merged = []
  for (const raw of Array.isArray(chunks) ? chunks : []) {
    const older = (Array.isArray(raw) ? raw : []).map((m) => ({ ...m }))
    if (!older.length) continue
    if (!merged.length) { merged = older; continue }
    let overlap = 0
    const cap = Math.min(older.length, merged.length)
    for (let size = cap; size > 0; size--) {
      let same = true
      for (let i = 0; i < size; i++) {
        if (messageToken(older[older.length - size + i]) !== messageToken(merged[i])) { same = false; break }
      }
      if (same) { overlap = size; break }
    }
    if (overlap) {
      for (let i = 0; i < overlap; i++) {
        const from = older[older.length - overlap + i]
        if (!merged[i].sep && from.sep) merged[i].sep = from.sep
      }
      merged = [...older.slice(0, older.length - overlap), ...merged]
      continue
    }
    let containedAt = -1
    for (let start = 0; start + older.length <= merged.length; start++) {
      if (older.every((m, i) => messageToken(m) === messageToken(merged[start + i]))) { containedAt = start; break }
    }
    if (containedAt >= 0) {
      older.forEach((m, i) => { if (!merged[containedAt + i].sep && m.sep) merged[containedAt + i].sep = m.sep })
      continue
    }
    merged = [...older, ...merged]
  }
  return merged
}

// Lê a thread ABERTA com CONTEXTO: o Instagram virtualiza a renderização (o texto de
// uma mensagem só existe no DOM enquanto ela está visível), então rolamos do fim pro
// topo COLETANDO os trechos conforme aparecem e remontamos a ordem cronológica. É o que
// dá contexto à IA (sem o histórico ela pode ler ironia como coisa séria). scrollRounds
// = teto de passos de rolagem (mais = mais fundo no histórico); a leitura para sozinha
// quando maxNoNew passos seguidos não trazem NENHUMA mensagem nova (chegou no topo real).
export async function readOpenThread(page, { scrollRounds = 30, maxNoNew = 4 } = {}) {
  // snapshot: mensagens visíveis + o SEPARADOR de data/hora do IG logo acima de cada uma
  // (é daí que sai o horário REAL). Cada mensagem carrega o texto do separador (ex.:
  // "May 6, 2026, 10:19 PM"); o parse pra timestamp é feito no Node (parseIgSeparator).
  const snap = () => page.evaluate(() => {
    const W = window.innerWidth; const H = window.innerHeight; const mid = 480 + (W - 480) / 2
    const els = []
    for (const el of document.querySelectorAll('div[dir="auto"]')) {
      if (el.querySelector('div[dir="auto"]')) continue
      const t = (el.innerText || '').trim(); if (!t) continue
      const r = el.getBoundingClientRect()
      if (r.left < 480 || r.width < 8 || r.bottom < 60 || r.top > H - 20) continue
      els.push({ top: r.top, mid: r.left + r.width / 2, text: t })
    }
    // MÍDIA (imagem/vídeo): o leitor de texto não vê. Imagem GRANDE sem "profile picture"
    // (avatar é 74x74 com esse alt) ou vídeo. Vira uma "mensagem" [imagem]/[vídeo] na ordem.
    for (const el of document.querySelectorAll('img,video')) {
      const r = el.getBoundingClientRect()
      if (r.left < 480 || r.bottom < 60 || r.top > H - 20) continue
      const isVideo = el.tagName === 'VIDEO'
      const alt = el.getAttribute('alt') || ''
      if (!isVideo) { if (r.width < 120 || r.height < 120 || /profile picture/i.test(alt)) continue }
      else if (r.width < 80) continue
      const src = el.getAttribute('src') || el.currentSrc || ''
      els.push({ top: r.top, mid: r.left + r.width / 2, text: isVideo ? '[vídeo]' : '[imagem]', mkey: 'md:' + src.slice(-28), msrc: src, mkind: isVideo ? 'video' : 'imagem' })
    }
    // Foto/vídeo efêmero aparece como um botão textual ("Photo"/"Foto") e não como
    // <img>/<video>; sem este caso a bolha some por completo do histórico.
    for (const el of document.querySelectorAll('[role="button"],[tabindex="0"],span')) {
      const label = (el.innerText || '').replace(/\s+/g, ' ').trim()
      const photo = /^(photo|foto|this photo can only be replayed once\. use the mobile app to view\.)$/i.test(label)
      const video = /^(video|vídeo|this video can only be replayed once\. use the mobile app to view\.)$/i.test(label)
      if (!photo && !video) continue
      const r = el.getBoundingClientRect()
      if (r.left < 480 || r.width < 45 || r.bottom < 60 || r.top > H - 20) continue
      const text = video ? '[vídeo]' : '[imagem]'
      const middle = r.left + r.width / 2
      if (els.some((e) => !e.sep && Math.abs(e.top - r.top) < 12 && Math.abs(e.mid - middle) < 80)) continue
      els.push({ top: r.top, mid: middle, text, mkey: 'ephemeral:' + text })
    }
    const sepRe = /(^|\s)\d{1,2}:\d{2}\s*(AM|PM)?$/i // separador termina em "H:MM AM/PM"
    for (const el of document.querySelectorAll('span,h5')) {
      if (el.children.length) continue
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim()
      if (!t || t.length > 30 || !sepRe.test(t)) continue
      const r = el.getBoundingClientRect()
      if (r.left < 400 || r.top > H - 20) continue
      els.push({ top: r.top, sep: t })
    }
    els.sort((a, b) => a.top - b.top)
    const arr = []; let cur = null
    for (const e of els) { if (e.sep) cur = e.sep; else arr.push({ dir: e.mid > mid ? 'out' : 'in', text: e.text, sep: cur, mkey: e.mkey || null, msrc: e.msrc || null, mkind: e.mkind || null }) }
    let username = null
    for (const a of document.querySelectorAll('a[href^="/"]')) {
      const rr = a.getBoundingClientRect(); const h = a.getAttribute('href') || ''
      if (rr.top < 130 && rr.left > 480 && /^\/[a-zA-Z0-9_.]+\/$/.test(h)) { username = h.replace(/\//g, ''); break }
    }
    return { arr, username }
  }).catch(() => ({ arr: [], username: null }))

  // Expande as transcrições de áudio visíveis (o termo já foi aceito na conta). Cada
  // "View transcription" clicado vira o texto do áudio, que entra no histórico da IA.
  const expandTranscripts = async () => {
    for (let g = 0; g < 6; g++) {
      const loc = page.getByText('View transcription', { exact: true }).first()
      if (!(await loc.count().catch(() => 0)) || !(await loc.isVisible().catch(() => false))) break
      const clicked = await loc.click({ timeout: 2000 }).then(() => true).catch(() => false)
      if (!clicked) break
      await page.waitForTimeout(500)
    }
  }

  // Encontra o ancestral rolável exatamente sob a área da conversa. Mover o scrollTop
  // direto é muito mais rápido e previsível que dezenas de wheels para descer do divisor
  // "New messages" até o fim, e ainda dispara o lazy-load normal do Instagram.
  const moveThreadScroll = (where) => page.evaluate((where) => {
    const x = Math.min(window.innerWidth - 40, 880)
    const y = Math.min(window.innerHeight - 140, 430)
    let el = document.elementFromPoint(x, y)
    while (el && el !== document.documentElement) {
      const style = getComputedStyle(el)
      if (el.scrollHeight > el.clientHeight + 24 && /(auto|scroll)/.test(style.overflowY)) break
      el = el.parentElement
    }
    if (!el || el === document.documentElement) return { found: false, max: 0, atEnd: false }
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    if (where === 'end') el.scrollTop = el.scrollHeight
    else el.scrollTop += Number(where) || 0
    el.dispatchEvent(new Event('scroll', { bubbles: true }))
    return { found: true, max, atEnd: el.scrollTop >= max - 3 }
  }, where).catch(() => ({ found: false, max: 0, atEnd: false }))

  await page.mouse.move(880, 430).catch(() => {}) // hover sobre a área de mensagens

  // Uma thread com não-lidas abre no divisor "New messages", não no final. Primeiro
  // descemos até a mensagem mais recente; só então fazemos a varredura do fim pro topo.
  let bottomStable = 0; let previousMax = -1
  for (let i = 0; i < 6 && bottomStable < 2; i++) {
    await expandTranscripts()
    const moved = await moveThreadScroll('end')
    if (!moved.found) await page.mouse.wheel(0, 900).catch(() => {})
    await page.waitForTimeout(500)
    bottomStable = moved.found && moved.atEnd && moved.max === previousMax ? bottomStable + 1 : 0
    previousMax = moved.max
  }

  const chunks = []
  let username = null; let noNew = 0
  await expandTranscripts()
  const first = await snap(); username = first.username; chunks.push(first.arr) // abre no fim (recentes)
  let merged = mergeThreadSnapshots(chunks)
  for (let i = 0; i < scrollRounds; i++) {
    await page.mouse.wheel(0, -520).catch(() => {}) // wheel REAL pra cima -> dispara o lazy-load (com sobreposição)
    await page.waitForTimeout(650)
    await expandTranscripts() // novos áudios que apareceram no scroll
    const s = await snap()
    if (s.username && !username) username = s.username
    chunks.push(s.arr)
    const next = mergeThreadSnapshots(chunks)
    const fresh = Math.max(0, next.length - merged.length)
    merged = next
    // topo real = maxNoNew passos seguidos sem nenhuma novidade (robusto contra passo que não rola)
    if (fresh === 0) { if (++noNew >= maxNoNew) break } else noNew = 0
  }
  // Confirma a CAUDA depois da varredura. O Instagram pode abrir no divisor "New
  // messages" e materializar as últimas bolhas só depois que o scroll/lazy-load assentou.
  // Sem esta segunda ida ao fim, a lista lateral fica atualizada, mas a thread termina na
  // mensagem de ontem até o ciclo pesado seguinte. A cauda vem primeiro porque
  // mergeThreadSnapshots espera a janela mais nova antes das janelas progressivamente
  // mais antigas.
  for (let i = 0; i < 3; i++) {
    const moved = await moveThreadScroll('end')
    if (!moved.found) await page.mouse.wheel(0, 900).catch(() => {})
    await page.waitForTimeout(450)
  }
  await expandTranscripts()
  const finalTail = await snap()
  if (finalTail.username && !username) username = finalTail.username
  const messages = mergeThreadSnapshots([finalTail.arr, ...chunks])
  // ── horário por mensagem, com INVARIANTES (o DOM do IG mente às vezes: separador "só
  //    hora" sem data, hora mal-pareada → timestamp no FUTURO/embaralhado). Regras:
  //    1) a ordem do DOM (mais antigo → mais recente) é a VERDADE; o ts respeita ela (monotônico);
  //    2) NENHUM ts pode ser no futuro (hora-do-dia sem data cai no passado mais recente);
  //    3) buracos são interpolados. Assim a thread nunca "atrasa" nem mostra msg futura. ──
  const now = Date.now(); const nowCap = now + 60000
  let prevMs = null
  for (const m of messages) { if (m.sep) { const p = parseIgSeparator(m.sep, now, prevMs); if (p) { m.ts = p.ms; prevMs = p.ms } } }
  // backfill das mensagens do TOPO (antes do 1º separador) a partir da 1ª conhecida
  const firstIdx = messages.findIndex((m) => typeof m.ts === 'number' && m.ts > 0)
  if (firstIdx > 0) { let base = messages[firstIdx].ts; for (let i = firstIdx - 1; i >= 0; i--) { base -= 1000; messages[i].ts = base } }
  // passe final: sem futuro (rola dia pra trás) + monotônico crescente + preenche buracos
  let prev = 0
  for (const m of messages) {
    let t = (typeof m.ts === 'number' && m.ts > 0) ? m.ts : (prev > 0 ? prev + 1000 : now - messages.length * 1000)
    while (t > nowCap) t -= 86400000        // futuro = hora sem a data certa → passado mais recente
    if (t < prev) t = prev + 1000            // ordem do documento manda
    m.ts = t; prev = t
  }
  for (const m of messages) { delete m.sep; delete m.mkey }
  return { username, messages }
}

// Digita no composer e envia (Enter), com um ritmo levemente humano.
export async function sendText(page, text) {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('texto vazio')
  const box = await page.$('div[role="textbox"][contenteditable="true"]')
  if (!box) throw new Error('composer do Instagram não encontrado')
  await box.click().catch(() => {})
  await page.waitForTimeout(300)
  await page.keyboard.type(clean, { delay: 22 })
  await page.waitForTimeout(400)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  return true
}
