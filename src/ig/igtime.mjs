// Parser dos SEPARADORES de tempo que o Instagram web mostra entre grupos de mensagens.
// Formatos observados no DOM real (em inglês, com AM/PM):
//   "May 6, 2026, 10:19 PM"   -> data absoluta
//   "Mon 9:36 PM"             -> dia da semana + hora (resolve pro dia da semana passado mais recente)
//   "9:36 PM" / "2:16 AM"     -> só hora (herda a DATA do separador anterior)
// Tudo é interpretado no fuso America/Sao_Paulo (o painel/relógio do dono).
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()

// Constrói ms para uma data/hora "local de São Paulo" (offset fixo -03:00, sem DST desde 2019).
function spMs({ y, mon, d, h, mi }) {
  const iso = `${y}-${String(mon + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00-03:00`
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}
// Componentes de "agora" no fuso de SP (pra resolver dia-da-semana / herança de data).
function nowParts(nowMs) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
  const p = Object.fromEntries(f.formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]))
  return { y: Number(p.year), mon: Number(p.month) - 1, d: Number(p.day), wd: WEEKDAYS[p.weekday.toLowerCase().slice(0, 3)] }
}
function parseClock(str) {
  const m = clean(str).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i)
  if (!m) return null
  let h = Number(m[1]); const mi = Number(m[2]); const ap = m[3] && m[3].toUpperCase()
  if (ap === 'PM' && h < 12) h += 12
  if (ap === 'AM' && h === 12) h = 0
  if (h > 23 || mi > 59) return null
  return { h, mi }
}

// Interpreta UM separador. prevMs = ts do separador anterior (pra herdar a data no formato só-hora).
// Retorna { ms, dateKnown } — dateKnown=false quando herdou (útil pra decidir precisão).
export function parseIgSeparator(text, nowMs = Date.now(), prevMs = null) {
  const s = clean(text)
  const clock = parseClock(s)
  if (!clock) return null
  const now = nowParts(nowMs)

  // 1) absoluto: "May 6, 2026, 10:19 PM"
  const abs = s.match(/([a-z]{3,})\s+(\d{1,2}),\s*(\d{4})/i)
  if (abs && MONTHS[abs[1].toLowerCase().slice(0, 3)] != null) {
    const ms = spMs({ y: Number(abs[3]), mon: MONTHS[abs[1].toLowerCase().slice(0, 3)], d: Number(abs[2]), h: clock.h, mi: clock.mi })
    return ms ? { ms, dateKnown: true } : null
  }
  // 2) dia da semana: "Mon 9:36 PM" -> o mais recente <= hoje
  const wdm = s.match(/^([a-z]{3})\b/i)
  if (wdm && WEEKDAYS[wdm[1].toLowerCase()] != null) {
    const target = WEEKDAYS[wdm[1].toLowerCase()]
    let back = (now.wd - target + 7) % 7 // dias pra trás até o dia-da-semana alvo
    const base = spMs({ y: now.y, mon: now.mon, d: now.d, h: clock.h, mi: clock.mi })
    const ms = base - back * 86400000
    return { ms, dateKnown: true }
  }
  // 3) só hora ("2:16 AM"): herda a DATA do separador anterior; sem ele, assume hoje.
  const src = prevMs != null ? nowParts(prevMs) : now
  let ms = spMs({ y: src.y, mon: src.mon, d: src.d, h: clock.h, mi: clock.mi })
  // A conversa atravessou meia-noite. O Instagram continua mostrando só a hora, então
  // "2:25 AM" depois de "5:21 AM" pertence ao DIA SEGUINTE, não ao mesmo dia. Sem este
  // avanço, as mensagens novas eram gravadas no dia anterior e pareciam sumir da cauda.
  if (ms != null && prevMs != null) {
    while (ms + 60000 < prevMs) ms += 86400000
  }
  return ms ? { ms, dateKnown: prevMs != null } : null
}

// É um separador (e não uma mensagem)? Texto curto que casa "…H:MM AM/PM".
export function looksLikeSeparator(text) {
  const s = clean(text)
  return s.length <= 30 && /(^|\s)\d{1,2}:\d{2}\s*(AM|PM)?$/i.test(s) && /^(\w{3,}\s+\d|\w{3}\b|\d{1,2}:)/i.test(s)
}
