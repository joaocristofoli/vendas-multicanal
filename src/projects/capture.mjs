// Captura rápida: transforma UMA frase em português numa prévia estruturada (tipo, projeto,
// data/hora, recorrência) sem formulário. O parser LOCAL é o caminho robusto e determinístico
// (resolve os casos reais na hora); a IA é um refino opcional, best-effort e com timeout curto
// — a captura NUNCA trava esperando IA. Datas sempre em America/Sao_Paulo.
import { listProjects, spParts, spTime, dayStampSP, startOfDaySP } from './store.mjs'
import { getSetting } from '../core/db.mjs'
import { gerarTexto } from '../ai/ia.mjs'

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const WEEKDAYS = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6, dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 }
const MONTHS = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 }

// ---------- hora ----------
function parseTime(text) {
  const t = norm(text)
  if (/meio[\s-]?dia/.test(t)) return { h: 12, m: 0 }
  if (/meia[\s-]?noite/.test(t)) return { h: 0, m: 0 }
  // "15h", "15h30", "15:30", "as 20", "20 horas"
  let m = t.match(/(\d{1,2})\s*[:h]\s*(\d{2})/)
  if (m) return { h: clampH(+m[1]), m: Math.min(59, +m[2]) }
  m = t.match(/(?:as|às|@|,)\s*(\d{1,2})\s*h?\b/) || t.match(/\b(\d{1,2})\s*h\b/) || t.match(/\b(\d{1,2})\s*horas?\b/)
  if (m) return { h: clampH(+m[1]), m: 0 }
  // período do dia
  if (/\b(de\s+)?manh[aã]/.test(t)) return { h: 9, m: 0, vague: true }
  if (/\b(de\s+)?tarde/.test(t)) return { h: 15, m: 0, vague: true }
  if (/\b([àa]\s+)?noite/.test(t)) return { h: 20, m: 0, vague: true }
  return null
}
function clampH(h) { return Math.max(0, Math.min(23, h)) }

// ---------- data (retorna {ms, hadDate, hadTime, vagueTime}) ----------
function parseWhen(text) {
  const t = norm(text)
  const now = Date.now()
  const todayStamp = dayStampSP(now)
  const p0 = spParts(now)
  const time = parseTime(text)
  let baseStamp = null                 // dia alvo (YYYY-MM-DD) sem hora ainda
  let hadDate = false

  // relativas
  if (/\bhoje\b/.test(t)) { baseStamp = todayStamp; hadDate = true }
  else if (/\bamanh[aã]\b/.test(t)) { baseStamp = shiftStamp(todayStamp, 1); hadDate = true }
  else if (/\bdepois de amanh[aã]\b/.test(t)) { baseStamp = shiftStamp(todayStamp, 2); hadDate = true }
  // "daqui a 2 horas" / "em 30 min"
  let m = t.match(/\b(?:daqui a?|em)\s+(\d{1,3})\s*(hora|horas|h|min|minuto|minutos)\b/)
  if (!baseStamp && m) { const n = +m[1]; const unit = m[2][0] === 'h' ? 3600000 : 60000; return { ms: now + n * unit, hadDate: true, hadTime: true } }
  // "em 3 dias" / "daqui 5 dias"
  m = t.match(/\b(?:daqui a?|em)\s+(\d{1,3})\s*(dia|dias)\b/)
  if (!baseStamp && m) { baseStamp = shiftStamp(todayStamp, +m[1]); hadDate = true }
  // "semana que vem" / "próxima semana"
  if (!baseStamp && /\b(semana que vem|proxima semana)\b/.test(t)) { baseStamp = shiftStamp(todayStamp, 7); hadDate = true }
  // dia da semana (próxima ocorrência)
  if (!baseStamp) {
    for (const [w, dow] of Object.entries(WEEKDAYS)) {
      if (new RegExp(`\\b${w}(?:-feira|feira)?\\b`).test(t)) { baseStamp = nextWeekday(todayStamp, dow); hadDate = true; break }
    }
  }
  // "dia 5" (próximo dia 5) — só se não houver dia da semana
  if (!baseStamp) { m = t.match(/\bdia\s+(\d{1,2})\b/); if (m) { baseStamp = nextMonthDay(now, +m[1]); hadDate = true } }
  // "15/08" ou "15/8/2026"
  if (!baseStamp) { m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/); if (m) { const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : p0.y; baseStamp = clampStamp(y, +m[2], +m[1]); hadDate = true; if (startOfDaySP(baseStamp) < startOfDaySP(todayStamp) && !m[3]) baseStamp = clampStamp(y + 1, +m[2], +m[1]) } }
  // "até agosto" / "em setembro" / "agosto" (mês só) -> dia 1 daquele mês (próxima ocorrência)
  if (!baseStamp) {
    for (const [mn, mo] of Object.entries(MONTHS)) {
      if (new RegExp(`\\b${mn}\\b`).test(t)) { let y = p0.y; if (mo < p0.mo || (mo === p0.mo)) { if (mo < p0.mo) y = p0.y + 1 }; baseStamp = clampStamp(y, mo, 1); hadDate = true; break }
    }
  }

  if (!baseStamp && !time) return { ms: null, hadDate: false, hadTime: false }
  if (!baseStamp) baseStamp = todayStamp // só hora dita -> hoje (ou empurra pra amanhã se já passou)
  const parts = { y: +baseStamp.slice(0, 4), mo: +baseStamp.slice(5, 7), d: +baseStamp.slice(8, 10) }
  const h = time ? time.h : 9, mi = time ? time.m : 0
  let ms = spTime({ ...parts, h, mi })
  // se caiu no passado (ex.: "às 8" e já são 10h) e a data não foi explícita, joga pra amanhã
  if (ms < now && !hadDate) ms = spTime({ ...spParts(ms + 86400000), h, mi })
  return { ms, hadDate: hadDate || !!time, hadTime: !!time, vagueTime: !!(time && time.vague), monthOnly: !time && !!baseStamp && /agosto|setembro|outubro|janeiro|fevereiro|marco|abril|maio|junho|julho|novembro|dezembro/.test(t) && !/dia\s+\d/.test(t) }
}
function shiftStamp(stamp, n) { return dayStampSP(startOfDaySP(stamp) + n * 86400000) }
function nextWeekday(stamp, dow) { let s = stamp; for (let i = 1; i <= 7; i++) { s = shiftStamp(stamp, i); if (new Date(startOfDaySP(s)).getDay() === dow) return s } return stamp }
function nextMonthDay(nowMs, day) { const p = spParts(nowMs); let ms = spTime({ y: p.y, mo: p.mo, d: day, h: 9, mi: 0 }); if (ms < nowMs) ms = spTime({ y: p.mo === 12 ? p.y + 1 : p.y, mo: p.mo === 12 ? 1 : p.mo + 1, d: day, h: 9, mi: 0 }); return dayStampSP(ms) }
function clampStamp(y, mo, d) { const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return dayStampSP(spTime({ y, mo, d: Math.min(d, dim), h: 9, mi: 0 })) }

// Mesmo interpretador de data/hora em português, exposto pra quem não quer a captura
// inteira (o assistente pessoal usa isto pra entender "quinta que vem às 15h"). Só um
// alias de leitura: não muda nada no fluxo da captura.
export function interpretarQuando(texto) { return parseWhen(texto) }
export function interpretarRecorrencia(texto) { return parseRecurrence(texto) }

// ---------- recorrência ----------
function parseRecurrence(text) {
  const t = norm(text)
  if (/\btodo\s+ano\b|\banualmente\b|\btodo\s+anivers/.test(t)) return 'yearly'
  if (/\btodo\s+(mes|m[eê]s)\b|\bmensalmente\b|\btodo\s+dia\s+\d/.test(t)) return 'monthly'
  if (/\btoda\s+semana\b|\bsemanalmente\b|\btoda\s+(segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/.test(t)) return 'weekly'
  if (/\btodo\s+dia\b|\btodos\s+os\s+dias\b|\bdiariamente\b/.test(t)) return 'daily'
  return null
}

// ---------- tipo ----------
function parseType(text, when) {
  const t = norm(text)
  if (/^\s*ideia\b|^\s*anota[r]?\b|\bideia:/.test(t)) return 'nota'
  if (/\bme\s+lembra|\blembrar\b|\blembrete\b|\bnao esquecer|\bn[aã]o esquecer/.test(t)) return 'lembrete'
  if (when.hadTime && /\breuni[aã]o\b|\bencontro\b|\bcall\b|\bligar\b|\bconsulta\b|\bmarcar\b|\bcafe\b|\balmo[cç]o\b|\bjantar\b|\brol[eê]\b|\bvisita\b/.test(t)) return 'compromisso'
  return 'task'
}

// ---------- projeto (casamento local por nome) ----------
function matchProject(text, projects) {
  const t = norm(text)
  let best = null
  for (const p of projects) {
    const n = norm(p.name); if (n.length < 2) continue
    if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) { if (!best || n.length > norm(best.name).length) best = p }
  }
  return best
}

// Limpa a frase pra virar título: tira preposição de projeto e miolo de data já entendido.
function cleanTitle(text, projectName) {
  let s = String(text || '').trim()
  if (projectName) s = s.replace(new RegExp(`\\s+(no|na|do|da|pro|pra|para)\\s+${projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), '')
  s = s.replace(/^\s*(ideia|anota[r]?)\s*:?\s*/i, '').replace(/^\s*me\s+lembra(r)?\s+(de\s+|pra\s+|para\s+)?/i, '')
  return s.trim().replace(/\s{2,}/g, ' ') || String(text || '').trim()
}

// Interpreta a frase. Devolve a prévia estruturada (não salva nada).
export async function interpretCapture({ accountKey, text }) {
  const projects = listProjects(accountKey).filter((p) => p.status === 'ativo')
  const when = parseWhen(text)
  const recurrence = parseRecurrence(text)
  let type = parseType(text, when)
  // lembrete recorrente é lembrete; recorrência sem "lembra" também vira lembrete (é aviso repetido)
  if (recurrence && type === 'task') type = 'lembrete'
  const project = matchProject(text, projects)
  const title = cleanTitle(text, project?.name)
  // tarefa com data vira prazo (dueDate); compromisso/lembrete usam 'at'
  const preview = {
    type, title, text,
    projectId: project?.id || null, projectName: project?.name || null,
    at: (type === 'compromisso' || type === 'lembrete') ? when.ms : null,
    dueDate: (type === 'task' && when.ms) ? when.ms : null,
    recurrence: recurrence || null,
    hadDate: when.hadDate, hadTime: when.hadTime, vagueTime: when.vagueTime || when.monthOnly,
    projects: projects.map((p) => ({ id: p.id, name: p.name, color: p.color })),
  }
  // refino opcional por IA (best-effort, timeout curto): pode corrigir tipo/projeto ambíguo.
  if (getSetting('capture_ai', true)) {
    try { const ref = await withTimeout(refineWithAi({ text, preview, projects }), 6000); if (ref) Object.assign(preview, ref) } catch { /* IA lenta/indisponível: fica o local */ }
  }
  return preview
}

function withTimeout(promise, ms) { return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]) }

// Refino por Codex: só ajusta tipo e projeto quando o local ficou ambíguo. Nunca inventa data.
async function refineWithAi({ text, preview, projects }) {
  const { getCodex } = await import('../ai/codex.mjs')
  const list = projects.map((p) => `- ${p.name} (id: ${p.id})`).join('\n') || '(nenhum projeto ativo)'
  const prompt = [
    'Classifique esta nota rápida do usuário. Responda SOMENTE JSON válido, sem markdown.',
    'Tipos: "task" (tarefa/afazer), "compromisso" (tem hora e é encontro/reunião/call), "lembrete" (pedido de aviso), "nota" (ideia/registro).',
    'Projetos ativos (escolha o id SÓ se a nota claramente pertence a um deles; senão null):',
    list,
    '',
    `Nota: "${text}"`,
    `Palpite atual: tipo=${preview.type}, projeto=${preview.projectName || 'null'}.`,
    'Formato: {"type":"task|compromisso|lembrete|nota","projectId":"id ou null","title":"título curto e limpo"}',
  ].join('\n')
  const { text: out } = await gerarTexto({
    prompt,
    baseInstructions: 'Você é um classificador. Só responde JSON. Não usa ferramentas.',
    effort: 'low',
    usageMeta: { origin: 'projeto_classificacao', trigger: 'manual', channel: 'self' },
  })
  let j = null; try { const a = out.indexOf('{'), b = out.lastIndexOf('}'); if (a >= 0 && b > a) j = JSON.parse(out.slice(a, b + 1)) } catch { /* */ }
  if (!j) return null
  const valid = ['task', 'compromisso', 'lembrete', 'nota']
  const patch = {}
  if (valid.includes(j.type)) patch.type = j.type
  if (j.projectId && projects.some((p) => p.id === j.projectId)) { patch.projectId = j.projectId; patch.projectName = projects.find((p) => p.id === j.projectId).name }
  if (j.title && String(j.title).trim().length >= 2) patch.title = String(j.title).trim().slice(0, 200)
  // reconcilia at/dueDate ao tipo eventualmente corrigido
  if (patch.type) {
    const t = patch.type
    patch.at = (t === 'compromisso' || t === 'lembrete') ? preview.at || preview.dueDate : null
    patch.dueDate = (t === 'task' && (preview.dueDate || preview.at)) ? (preview.dueDate || preview.at) : null
  }
  return patch
}
