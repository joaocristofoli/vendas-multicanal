// Camada de dados do módulo Projetos (gestão da vida do dono). Tudo aditivo e isolado
// dos canais. Datas do usuário são sempre em America/Sao_Paulo (a VM pode estar em UTC),
// então o "dia" é calculado por carimbo YYYY-MM-DD no fuso de SP, nunca pela hora local do
// servidor. Ver docs/PROJETOS-PROMPT.md. Compromisso não mora aqui: é evento na Google Agenda.
import crypto from 'node:crypto'
import { db } from '../core/db.mjs'
import { phoneFromJid } from '../wa/jid.mjs'
import { phoneVariants } from '../wa/phone.mjs'

const now = () => Date.now()
const uid = () => crypto.randomUUID()
const TZ = 'America/Sao_Paulo'
const SP_OFFSET = '-03:00' // São Paulo não tem horário de verão desde 2019 (igual ao resto do sistema)

// ---------- tempo em São Paulo ----------
const spDayFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ })
export function dayStampSP(ms = now()) { return spDayFmt.format(new Date(ms)) }         // 'YYYY-MM-DD'
export function startOfDaySP(stamp) { return Date.parse(`${stamp}T00:00:00${SP_OFFSET}`) }
export function endOfDaySP(stamp) { return startOfDaySP(stamp) + 86400000 - 1 }
export function addDaysStamp(stamp, n) { const d = new Date(startOfDaySP(stamp) + n * 86400000); return dayStampSP(d.getTime()) }
// Componentes de data (ano/mês/dia/hora/min) em SP a partir de um ms — pra recorrência.
const partsFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ })
export function spParts(ms) {
  const o = {}; for (const p of partsFmt.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = p.value
  let hour = Number(o.hour); if (hour === 24) hour = 0
  return { y: Number(o.year), mo: Number(o.month), d: Number(o.day), h: hour, mi: Number(o.minute) }
}
// Monta um ms a partir de componentes em SP (dia pode estourar o mês: normaliza sozinho).
export function spTime({ y, mo, d, h = 9, mi = 0 }) {
  // Nº de dias do mês (mo 1-12): dia 0 do mês seguinte em UTC = último dia deste mês.
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  const day = Math.min(d, daysInMonth)
  return Date.parse(`${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00${SP_OFFSET}`)
}

// ============================================================ PROJETOS
export function createProject({ accountKey, name, type = 'pessoal', color = 'teal', description = null }) {
  const id = uid(); const t = now()
  db().prepare(`INSERT INTO project(id,account_key,name,type,color,status,description,created_at,updated_at)
    VALUES(?,?,?,?,?,'ativo',?,?,?)`).run(id, accountKey, name, type, color, description, t, t)
  logProject(id, 'created', name)
  return getProject(id)
}
export function getProject(id) { return db().prepare(`SELECT * FROM project WHERE id=?`).get(id) || null }
export function listProjects(accountKey) { return db().prepare(`SELECT * FROM project WHERE account_key=? ORDER BY (status='concluido'), (status='pausado'), updated_at DESC`).all(accountKey) }
export function updateProject(id, patch = {}) {
  const p = getProject(id); if (!p) return null
  const cols = ['name', 'type', 'color', 'status', 'description', 'due_date', 'metric_name', 'metric_target', 'metric_current', 'metric_unit']
  const sets = [], vals = {}
  for (const c of cols) { const camel = c.replace(/_([a-z])/g, (_, x) => x.toUpperCase()); if (camel in patch) { sets.push(`${c}=@${c}`); vals[c] = patch[camel] } }
  if (!sets.length) return p
  vals.id = id; vals.t = now()
  if (patch.status === 'concluido' && p.status !== 'concluido') { sets.push('completed_at=@t') }
  if (patch.status && patch.status !== 'concluido') { sets.push('completed_at=NULL') }
  db().prepare(`UPDATE project SET ${sets.join(',')}, updated_at=@t WHERE id=@id`).run(vals)
  if (patch.status && patch.status !== p.status) logProject(id, 'status_change', patch.status)
  if ('metricCurrent' in patch) logProject(id, 'metric_update', String(patch.metricCurrent))
  return getProject(id)
}
export function touchProject(id) { db().prepare(`UPDATE project SET updated_at=? WHERE id=?`).run(now(), id) }
export function deleteProject(id) {
  const d = db()
  const tx = d.transaction(() => {
    d.prepare(`DELETE FROM task WHERE project_id=?`).run(id)
    d.prepare(`DELETE FROM note WHERE project_id=?`).run(id)
    d.prepare(`DELETE FROM reminder WHERE project_id=?`).run(id)
    d.prepare(`DELETE FROM project_person WHERE project_id=?`).run(id)
    d.prepare(`DELETE FROM project_log WHERE project_id=?`).run(id)
    d.prepare(`DELETE FROM project WHERE id=?`).run(id)
  })
  tx()
  return true
}

// Projeto com agregados pro card (contagem de tarefas, próximo passo, próxima data, envolvidos).
export function projectAggregate(p) {
  const total = db().prepare(`SELECT COUNT(*) n FROM task WHERE project_id=?`).get(p.id).n
  const done = db().prepare(`SELECT COUNT(*) n FROM task WHERE project_id=? AND done=1`).get(p.id).n
  const next = db().prepare(`SELECT id,title,due_date FROM task WHERE project_id=? AND is_next=1 AND done=0 LIMIT 1`).get(p.id)
    || db().prepare(`SELECT id,title,due_date FROM task WHERE project_id=? AND done=0 ORDER BY position ASC LIMIT 1`).get(p.id) || null
  const nextDue = db().prepare(`SELECT MIN(due_date) d FROM task WHERE project_id=? AND done=0 AND due_date IS NOT NULL AND due_date>0`).get(p.id)?.d || null
  const people = projectPeople(p.id)
  return {
    id: p.id, name: p.name, type: p.type, color: p.color, status: p.status, description: p.description,
    dueDate: p.due_date || null, updatedAt: p.updated_at,
    metric: p.metric_name ? { name: p.metric_name, target: p.metric_target, current: p.metric_current, unit: p.metric_unit } : null,
    tasksTotal: total, tasksDone: done, nextStep: next ? { id: next.id, title: next.title, dueDate: next.due_date || null } : null,
    nextDue, people: people.slice(0, 4), peopleCount: people.length,
  }
}
export function listProjectsAggregated(accountKey) { return listProjects(accountKey).map(projectAggregate) }

// ============================================================ TAREFAS
export function projectTasks(projectId) { return db().prepare(`SELECT * FROM task WHERE project_id=? ORDER BY done ASC, position ASC, created_at ASC`).all(projectId) }
export function getTask(id) { return db().prepare(`SELECT * FROM task WHERE id=?`).get(id) || null }
export function createTask({ accountKey, projectId = null, title, dueDate = null }) {
  const id = uid(); const t = now()
  const pos = (db().prepare(`SELECT MAX(position) m FROM task WHERE project_id IS ?`).get(projectId)?.m || 0) + 1
  db().prepare(`INSERT INTO task(id,account_key,project_id,title,done,due_date,is_next,position,created_at)
    VALUES(?,?,?,?,0,?,0,?,?)`).run(id, accountKey, projectId, title, dueDate, pos, t)
  if (projectId) { touchProject(projectId); logProject(projectId, 'task_added', title) }
  return getTask(id)
}
export function updateTask(id, patch = {}) {
  const task = getTask(id); if (!task) return null
  if ('done' in patch) {
    const done = patch.done ? 1 : 0
    db().prepare(`UPDATE task SET done=?, completed_at=? WHERE id=?`).run(done, done ? now() : null, id)
    if (task.project_id) { touchProject(task.project_id); if (done) logProject(task.project_id, 'task_done', task.title) }
    // ao concluir o "próximo passo", ele deixa de ser próximo passo
    if (done && task.is_next) db().prepare(`UPDATE task SET is_next=0 WHERE id=?`).run(id)
  }
  if ('title' in patch) db().prepare(`UPDATE task SET title=? WHERE id=?`).run(String(patch.title || '').trim(), id)
  if ('dueDate' in patch) db().prepare(`UPDATE task SET due_date=? WHERE id=?`).run(patch.dueDate || null, id)
  if ('position' in patch) db().prepare(`UPDATE task SET position=? WHERE id=?`).run(Number(patch.position) || 0, id)
  if ('projectId' in patch) { db().prepare(`UPDATE task SET project_id=? WHERE id=?`).run(patch.projectId || null, id); if (patch.projectId) { touchProject(patch.projectId); logProject(patch.projectId, 'task_added', task.title) } }
  return getTask(id)
}
// Marca UMA tarefa como o "próximo passo" do projeto (limpa as demais). null = tira o próximo passo.
export function setTaskNext(projectId, taskId) {
  db().prepare(`UPDATE task SET is_next=0 WHERE project_id=?`).run(projectId)
  if (taskId) db().prepare(`UPDATE task SET is_next=1 WHERE id=? AND project_id=?`).run(taskId, projectId)
  touchProject(projectId)
}
export function deleteTask(id) { const t = getTask(id); db().prepare(`DELETE FROM task WHERE id=?`).run(id); if (t?.project_id) touchProject(t.project_id); return true }
// Reordena por troca de posição com o vizinho (dir: -1 sobe, +1 desce).
export function moveTask(id, dir) {
  const t = getTask(id); if (!t || !t.project_id) return false
  const sibs = db().prepare(`SELECT id,position FROM task WHERE project_id=? AND done=0 ORDER BY position ASC`).all(t.project_id)
  const i = sibs.findIndex((s) => s.id === id); const j = i + (dir < 0 ? -1 : 1)
  if (i < 0 || j < 0 || j >= sibs.length) return false
  db().prepare(`UPDATE task SET position=? WHERE id=?`).run(sibs[j].position, sibs[i].id)
  db().prepare(`UPDATE task SET position=? WHERE id=?`).run(sibs[i].position, sibs[j].id)
  return true
}
export function inboxTasks(accountKey) { return db().prepare(`SELECT * FROM task WHERE account_key=? AND project_id IS NULL AND done=0 ORDER BY created_at DESC`).all(accountKey) }
// Tarefas com prazo hoje ou atrasadas (não concluídas) — pro Hoje.
export function tasksDueByStamp(accountKey, stamp) {
  const end = endOfDaySP(stamp)
  return db().prepare(`SELECT * FROM task WHERE account_key=? AND done=0 AND due_date IS NOT NULL AND due_date>0 AND due_date<=? ORDER BY due_date ASC`).all(accountKey, end)
}
// Tarefas com prazo dentro de um intervalo (pra Semana).
export function tasksDueRange(accountKey, fromMs, toMs) {
  return db().prepare(`SELECT * FROM task WHERE account_key=? AND done=0 AND due_date IS NOT NULL AND due_date>=? AND due_date<=? ORDER BY due_date ASC`).all(accountKey, fromMs, toMs)
}

// ============================================================ NOTAS
export function projectNotes(projectId) { return db().prepare(`SELECT * FROM note WHERE project_id=? ORDER BY created_at DESC`).all(projectId) }
export function createNote({ accountKey, projectId = null, text }) {
  const id = uid()
  db().prepare(`INSERT INTO note(id,account_key,project_id,text,created_at) VALUES(?,?,?,?,?)`).run(id, accountKey, projectId, text, now())
  if (projectId) { touchProject(projectId); logProject(projectId, 'note_added', String(text).slice(0, 80)) }
  return db().prepare(`SELECT * FROM note WHERE id=?`).get(id)
}
export function deleteNote(id) { db().prepare(`DELETE FROM note WHERE id=?`).run(id); return true }
export function inboxNotes(accountKey) { return db().prepare(`SELECT * FROM note WHERE account_key=? AND project_id IS NULL ORDER BY created_at DESC`).all(accountKey) }

// ============================================================ LEMBRETES
export function createReminder({ accountKey, projectId = null, taskId = null, text, at, recurrence = null, recurrenceDetail = null, preMinutes = null }) {
  const id = uid()
  // Ancora o dia-do-mês (mensal) / mês+dia (anual) original, pra recorrência não "grudar"
  // num dia curto (ex.: dia 31 -> fev 28, mas em março volta pro 31, não fica no 28).
  if (!recurrenceDetail && recurrence) {
    const p = spParts(at)
    if (recurrence === 'monthly') recurrenceDetail = { dom: p.d }
    else if (recurrence === 'yearly') recurrenceDetail = { mo: p.mo, dom: p.d }
  }
  db().prepare(`INSERT INTO reminder(id,account_key,project_id,task_id,text,at,recurrence,recurrence_detail,status,created_at,pre_minutes)
    VALUES(?,?,?,?,?,?,?,?, 'ativo', ?,?)`).run(id, accountKey, projectId, taskId, text, at, recurrence || null, recurrenceDetail ? JSON.stringify(recurrenceDetail) : null, now(),
    preMinutes === null || preMinutes === undefined ? null : Math.max(0, Math.round(Number(preMinutes) || 0)))
  if (projectId) logProject(projectId, 'reminder_added', text)
  return getReminder(id)
}
export function getReminder(id) { return db().prepare(`SELECT * FROM reminder WHERE id=?`).get(id) || null }
export function projectReminders(projectId) { return db().prepare(`SELECT * FROM reminder WHERE project_id=? AND status!='feito' ORDER BY at ASC`).all(projectId) }
export function updateReminder(id, patch = {}) {
  const r = getReminder(id); if (!r) return null
  const map = { text: 'text', at: 'at', recurrence: 'recurrence', status: 'status', snoozeUntil: 'snooze_until', preMinutes: 'pre_minutes' }
  const sets = [], vals = { id }
  for (const [k, col] of Object.entries(map)) if (k in patch) { sets.push(`${col}=@${col}`); vals[col] = patch[k] }
  if ('recurrenceDetail' in patch) { sets.push('recurrence_detail=@rd'); vals.rd = patch.recurrenceDetail ? JSON.stringify(patch.recurrenceDetail) : null }
  // Remarcou a hora? O aviso prévio volta a valer — senão remarcar de 14h pra 19h herdava a
  // marca "já avisei" e o aviso das 18h50 nunca saía.
  if ('at' in patch && Number(patch.at) !== Number(r.at)) sets.push('pre_fired_at=NULL')
  if (!sets.length) return r
  db().prepare(`UPDATE reminder SET ${sets.join(',')} WHERE id=@id`).run(vals)
  return getReminder(id)
}
export function deleteReminder(id) { db().prepare(`DELETE FROM reminder WHERE id=?`).run(id); return true }
// Lembretes prontos pra disparar: ativos, com at (ou snooze) <= agora.
export function dueReminders(nowMs = now()) {
  return db().prepare(`SELECT * FROM reminder WHERE status='ativo'
    AND ( (snooze_until IS NOT NULL AND snooze_until<=?) OR (snooze_until IS NULL AND at<=?) )
    ORDER BY at ASC`).all(nowMs, nowMs)
}
// AVISO ANTES DA HORA — quem tem que ser avisado agora de algo que ainda vai acontecer.
//
// Três condições, e cada uma corrige um jeito de errar:
//  - `pre_fired_at IS NULL`: um aviso só. O tick roda a cada 30s; sem isto o mesmo recado
//    sairia ~20 vezes durante os 10 minutos.
//  - `at > nowMs`: o que já venceu não é aviso prévio, é o lembrete de verdade — quem trata
//    é o `dueReminders`, e mandar os dois seria falar duas vezes da mesma coisa.
//  - `at - created_at > janela`: lembrete criado às 18h55 pra 19h não recebe "daqui a 5 min",
//    porque ele acabou de escrever isso. Aviso prévio de algo que ele acabou de pedir é ruído.
//
// `pre_minutes` por lembrete vence o padrão; 0 desliga só naquele.
export function reminderPreAvisos(nowMs = now(), padraoMin = 10) {
  const padrao = Math.max(0, Number(padraoMin) || 0)
  return db().prepare(`SELECT *, COALESCE(pre_minutes, @padrao) AS aviso_min FROM reminder
    WHERE status='ativo' AND snooze_until IS NULL AND pre_fired_at IS NULL
      AND at > @agora
      AND COALESCE(pre_minutes, @padrao) > 0
      AND at - (COALESCE(pre_minutes, @padrao) * 60000) <= @agora
      AND at - COALESCE(created_at, 0) > COALESCE(pre_minutes, @padrao) * 60000
    ORDER BY at ASC`).all({ agora: nowMs, padrao })
}
export function markReminderPreFired(id, nowMs = now()) {
  db().prepare(`UPDATE reminder SET pre_fired_at=? WHERE id=?`).run(nowMs, id)
}

// Lembretes do dia (pro Hoje): ativos com at dentro do dia (SP), inclui vencidos não disparados.
export function remindersByStamp(accountKey, stamp) {
  const end = endOfDaySP(stamp)
  return db().prepare(`SELECT * FROM reminder WHERE account_key=? AND status='ativo' AND at<=? ORDER BY at ASC`).all(accountKey, end)
}
export function remindersRange(accountKey, fromMs, toMs) {
  return db().prepare(`SELECT * FROM reminder WHERE account_key=? AND status='ativo' AND at>=? AND at<=? ORDER BY at ASC`).all(accountKey, fromMs, toMs)
}
// Calcula a próxima ocorrência de um lembrete recorrente a partir do 'at' atual, em SP.
// Avança até ficar estritamente no futuro (cobre catch-up de várias ocorrências perdidas).
// detail: âncora opcional { dom } (mensal) ou { mo, dom } (anual) pra não grudar em dia curto.
export function nextOccurrence(atMs, recurrence, detail = null, nowMs = now()) {
  if (!recurrence) return null
  const anchorDom = detail && detail.dom ? detail.dom : spParts(atMs).d
  let cur = atMs
  let guard = 0
  do {
    const p = spParts(cur)
    if (recurrence === 'daily') cur = spTime({ ...p, d: p.d + 1 })
    else if (recurrence === 'weekly') cur = spTime({ ...p, d: p.d + 7 })
    else if (recurrence === 'monthly') cur = spTime({ y: p.mo === 12 ? p.y + 1 : p.y, mo: p.mo === 12 ? 1 : p.mo + 1, d: anchorDom, h: p.h, mi: p.mi })
    else if (recurrence === 'yearly') cur = spTime({ y: p.y + 1, mo: (detail && detail.mo) || p.mo, d: anchorDom, h: p.h, mi: p.mi })
    else return null
  } while (cur <= nowMs && ++guard < 400)
  return cur
}
// Registra o disparo: recorrente recalcula o 'at' pro futuro; único vira 'feito'. Limpa snooze.
export function afterFire(id, nowMs = now()) {
  const r = getReminder(id); if (!r) return
  if (r.recurrence) {
    let detail = null; try { detail = r.recurrence_detail ? JSON.parse(r.recurrence_detail) : null } catch { /* */ }
    const next = nextOccurrence(r.at, r.recurrence, detail, nowMs)
    // pre_fired_at ZERA junto com o próximo `at`: sem isto o lembrete diário recebia aviso
    // prévio uma vez na vida e nunca mais, porque a marca do primeiro dia ficava lá.
    db().prepare(`UPDATE reminder SET last_fired_at=?, at=?, snooze_until=NULL, pre_fired_at=NULL WHERE id=?`).run(nowMs, next || r.at, id)
  } else {
    db().prepare(`UPDATE reminder SET last_fired_at=?, status='feito', snooze_until=NULL WHERE id=?`).run(nowMs, id)
  }
}

// ============================================================ HÁBITOS
export function listHabits(accountKey) { return db().prepare(`SELECT * FROM habit WHERE account_key=? ORDER BY paused ASC, position ASC, created_at ASC`).all(accountKey) }
export function getHabit(id) { return db().prepare(`SELECT * FROM habit WHERE id=?`).get(id) || null }
export function createHabit({ accountKey, name, days = 'daily', timeHint = null }) {
  const id = uid()
  const pos = (db().prepare(`SELECT MAX(position) m FROM habit WHERE account_key=?`).get(accountKey)?.m || 0) + 1
  db().prepare(`INSERT INTO habit(id,account_key,name,days,time_hint,streak_current,streak_best,paused,position,created_at)
    VALUES(?,?,?,?,?,0,0,0,?,?)`).run(id, accountKey, name, typeof days === 'string' ? days : JSON.stringify(days), timeHint, pos, now())
  return getHabit(id)
}
export function updateHabit(id, patch = {}) {
  const h = getHabit(id); if (!h) return null
  if ('name' in patch) db().prepare(`UPDATE habit SET name=? WHERE id=?`).run(patch.name, id)
  if ('days' in patch) db().prepare(`UPDATE habit SET days=? WHERE id=?`).run(typeof patch.days === 'string' ? patch.days : JSON.stringify(patch.days), id)
  if ('timeHint' in patch) db().prepare(`UPDATE habit SET time_hint=? WHERE id=?`).run(patch.timeHint || null, id)
  if ('paused' in patch) db().prepare(`UPDATE habit SET paused=? WHERE id=?`).run(patch.paused ? 1 : 0, id)
  return getHabit(id)
}
export function deleteHabit(id) { db().prepare(`DELETE FROM habit WHERE id=?`).run(id); db().prepare(`DELETE FROM habit_log WHERE habit_id=?`).run(id); return true }
export function habitDoneOn(id, stamp) { return !!db().prepare(`SELECT 1 FROM habit_log WHERE habit_id=? AND date=?`).get(id, stamp) }
// Marca/desmarca o hábito num dia (default hoje SP) e recalcula o streak. Retorna o hábito.
export function toggleHabit(id, stamp = dayStampSP()) {
  const has = habitDoneOn(id, stamp)
  if (has) db().prepare(`DELETE FROM habit_log WHERE habit_id=? AND date=?`).run(id, stamp)
  else db().prepare(`INSERT OR REPLACE INTO habit_log(habit_id,date,done_at) VALUES(?,?,?)`).run(id, stamp, now())
  recomputeStreak(id)
  return getHabit(id)
}
// Streak = dias marcados consecutivos terminando hoje (ou ontem, se hoje ainda não marcou).
function recomputeStreak(id) {
  const today = dayStampSP()
  let cur = 0
  let cursor = habitDoneOn(id, today) ? today : addDaysStamp(today, -1)
  // conta pra trás enquanto houver marcação em dias consecutivos
  for (let i = 0; i < 3660; i++) { if (habitDoneOn(id, cursor)) { cur++; cursor = addDaysStamp(cursor, -1) } else break }
  const best = Math.max(cur, getHabit(id)?.streak_best || 0)
  db().prepare(`UPDATE habit SET streak_current=?, streak_best=? WHERE id=?`).run(cur, best, id)
}
// Hábitos do dia (pro Hoje), com flag 'done' e se o dia bate com os dias planejados.
export function habitsForDay(accountKey, stamp = dayStampSP()) {
  const dow = new Date(startOfDaySP(stamp)).getDay() // 0=dom
  return listHabits(accountKey).filter((h) => !h.paused).map((h) => {
    let planned = true
    if (h.days && h.days !== 'daily') { try { const arr = JSON.parse(h.days); planned = Array.isArray(arr) ? arr.includes(dow) : true } catch { planned = true } }
    return { id: h.id, name: h.name, timeHint: h.time_hint, streak: h.streak_current, best: h.streak_best, done: habitDoneOn(h.id, stamp), planned }
  })
}

// ============================================================ PESSOAS (envolvidos + identidade)
// Segue o alias até o id canônico (colapsa cadeias). Sem alias, o id é seu próprio canônico.
export function canonicalPersonId(id) {
  let cur = id, guard = 0
  while (guard++ < 20) { const r = db().prepare(`SELECT canonical_person_id FROM person_alias WHERE alias_person_id=?`).get(cur); if (!r || r.canonical_person_id === cur) break; cur = r.canonical_person_id }
  return cur
}
// Todos os ids brutos que resolvem pra este canônico (inclui ele mesmo).
export function personAliases(canonicalId) {
  const ids = new Set([canonicalId])
  for (const r of db().prepare(`SELECT alias_person_id FROM person_alias WHERE canonical_person_id=?`).all(canonicalId)) ids.add(r.alias_person_id)
  return [...ids]
}
// O CANAL DE UMA PESSOA VEM DO PREFIXO DO ID, E O MAPA TEM QUE CONHECER TODOS OS CANAIS.
//
// Até 13/08/2026 este arquivo tratava `wa:` e `ig:` e mandava TODO o resto pro `return` de
// baixo, que é o do Tinder. Como o Badoo é `b:`, o Telegram é `tg:` e o Meu Patrocínio é
// `mp:`, as pessoas desses três canais eram carimbadas como TINDER — na instancia-b isso eram
// 51 pessoas com um Tinder que nunca existiu (0 linhas em `tinder_match`).
//
// Não é cosmético: `personChannels` monta a lista de redes a partir daqui, e ela responde
// "por onde falar com essa pessoa" no `canalPreferido` do assistente. Um canal inventado
// aceita "manda mensagem pra ela pelo Tinder" e tenta escrever num match que não existe.
//
// Por isso o mapa é DADO, e não uma escada de `if`: canal novo entra com uma linha, e a
// guarda `licoes/canal-fantasma-por-prefixo` reprova se o prefixo de um canal existente
// não estiver aqui. O `return` do fim continua sendo o do Tinder porque a pessoa canônica
// do sistema nasceu lá e não tem prefixo próprio — ele é o caso conhecido, não o resto.
const CARTAO_POR_PREFIXO = [
  { prefixo: 'wa:', channel: 'whatsapp', ler: (d, id, acc) => {
    const c = d.prepare(`SELECT name,avatar,pn FROM wa_chat WHERE account_key=? AND jid=?`).get(acc, id)
    const phone = c?.pn ? phoneFromJid(c.pn) : (id.endsWith('@lid') ? null : phoneFromJid(id))
    return { name: c?.name || (phone ? prettyBr(phone) : 'contato'), avatar: c?.avatar || null, sub: phone ? prettyBr(phone) : null }
  } },
  { prefixo: 'ig:', channel: 'instagram', ler: (d, id, acc) => {
    const c = d.prepare(`SELECT name,username,avatar FROM ig_chat WHERE account_key=? AND thread_id=?`).get(acc, id)
    return { name: c?.name || c?.username || 'Instagram', avatar: c?.avatar || null, sub: c?.username ? '@' + c.username : null }
  } },
  { prefixo: 'b:', channel: 'badoo', ler: (d, id, acc) => {
    const c = d.prepare(`SELECT name,foto,perfil_json FROM badoo_chat WHERE account_key=? AND chat_id=?`).get(acc, id)
    // A idade já está guardada no perfil que o canal lê sozinho — só não estava sendo
    // mostrada. Ler o que existe é de graça; nada aqui vai buscar perfil no Badoo.
    return { name: c?.name || 'conversa', avatar: c?.foto || null, sub: null, idade: idadeDoPerfil(c?.perfil_json) }
  } },
  { prefixo: 'tg:', channel: 'telegram', ler: (d, id, acc) => {
    const c = d.prepare(`SELECT nome,username,telefone FROM telegram_chat WHERE account_key=? AND chat_id=?`).get(acc, id)
    // No Telegram muita gente não tem @: o degrau seguinte é o telefone, nunca o chat_id
    // (identificador interno na tela é proibido — ver licoes/id-interno-na-tela).
    return { name: c?.nome || c?.username || (c?.telefone ? prettyBr(c.telefone) : 'conversa'), avatar: null,
      sub: c?.username ? '@' + c.username : (c?.telefone ? prettyBr(c.telefone) : null) }
  } },
  { prefixo: 'mp:', channel: 'meupatrocinio', ler: (d, id, acc) => {
    const c = d.prepare(`SELECT nome,foto FROM mp_chat WHERE account_key=? AND peer_id=?`).get(acc, id)
    return { name: c?.nome || 'conversa', avatar: c?.foto || null, sub: null }
  } },
]
// Os prefixos que este arquivo sabe resolver. A guarda lê esta lista.
export const PREFIXOS_DE_CANAL = CARTAO_POR_PREFIXO.map((p) => p.prefixo)

// IDADE: só a que JÁ ESTÁ no banco. O Tinder guarda em `tinder_match.age` e o Badoo no
// `perfil_json` que o próprio canal lê. WhatsApp e Instagram não têm idade nenhuma, e aqui
// ela NÃO se inventa: sem número, a tela simplesmente não mostra nada. Idade errada numa
// lista de vincular é pior que idade ausente — ela decide quem é quem.
function idadeValida(n) {
  const i = Number(n)
  return Number.isFinite(i) && i >= 18 && i <= 99 ? i : null
}
function idadeDoPerfil(perfilJson) {
  if (!perfilJson) return null
  try { return idadeValida(JSON.parse(perfilJson)?.age) } catch { return null }
}

// Cartão de uma identidade BRUTA (não canônica): nome, avatar, canal e sub-rótulo.
export function personCardRaw(rawId, accountKey = 'main') {
  const d = db()
  const id = String(rawId)
  for (const p of CARTAO_POR_PREFIXO) {
    if (!id.startsWith(p.prefixo)) continue
    const dados = p.ler(d, id.slice(p.prefixo.length), accountKey)
    return { personId: rawId, channel: p.channel, ...dados }
  }
  // Tinder / pessoa canônica do sistema
  const m = d.prepare(`SELECT name,photos_json,age,city FROM tinder_match WHERE person_id=? LIMIT 1`).get(rawId)
  const pr = d.prepare(`SELECT display_name,primary_photo FROM person WHERE person_id=?`).get(rawId)
  let photo = pr?.primary_photo || null
  if (!photo && m?.photos_json) { try { photo = JSON.parse(m.photos_json)[0] || null } catch { /* */ } }
  const waId = d.prepare(`SELECT channel_id FROM identity WHERE person_id=? AND channel='whatsapp' LIMIT 1`).get(rawId)
  return { personId: rawId, channel: 'tinder', name: m?.name || pr?.display_name || 'pessoa', avatar: photo,
    sub: m?.city || (waId ? 'no WhatsApp' : null), idade: idadeValida(m?.age) }
}
function prettyBr(digits) {
  let s = String(digits || '').replace(/\D/g, '')
  if (s.startsWith('55') && s.length >= 12) s = s.slice(2)
  if (s.length === 10 && /[6-9]/.test(s[2])) s = s.slice(0, 2) + '9' + s.slice(2)
  if (s.length === 11) return `(${s.slice(0, 2)}) ${s.slice(2, 7)}-${s.slice(7)}`
  if (s.length === 10) return `(${s.slice(0, 2)}) ${s.slice(2, 6)}-${s.slice(6)}`
  return digits ? String(digits) : null
}

// Redes que pertencem de verdade à mesma pessoa. Os aliases cobrem uniões manuais
// (ex.: Tinder + Instagram); `identity` cobre vínculos diretos da pessoa canônica
// (ex.: Tinder + WhatsApp). Usar só uma dessas fontes escondia vínculos já resolvidos.
export function personChannels(canonicalId, accountKey = 'main') {
  const canonico = canonicalPersonId(canonicalId)
  const ids = personAliases(canonico)
  const canais = new Set(ids.map((id) => personCardRaw(id, accountKey).channel))
  if (ids.length) {
    const qs = ids.map(() => '?').join(',')
    for (const row of db().prepare(`SELECT DISTINCT channel FROM identity
        WHERE account_key=? AND person_id IN (${qs})`).all(accountKey, ...ids)) {
      if (row.channel) canais.add(row.channel)
    }
  }
  const ordem = ['tinder', 'whatsapp', 'instagram', 'badoo']
  return [...ordem.filter((c) => canais.has(c)), ...[...canais].filter((c) => !ordem.includes(c)).sort()]
}

// Cartão de uma pessoa CANÔNICA: junta os cartões de todos os aliases (nome/avatar melhores + canais).
export function personCard(canonicalId, accountKey = 'main') {
  const cards = personAliases(canonicalId).map((r) => personCardRaw(r, accountKey))
  const channels = personChannels(canonicalId, accountKey)
  const withAvatar = cards.find((c) => c.avatar)
  const named = cards.find((c) => c.name && !/^(contato|Instagram|pessoa)$/.test(c.name)) || cards[0]
  // A idade vem do primeiro alias que TEM uma. Numa pessoa unificada, o WhatsApp não sabe a
  // idade e o Tinder ou o Badoo sabem — juntar é o ponto de unificar.
  const comIdade = cards.find((c) => c.idade)
  return {
    personId: canonicalId, name: named?.name || 'pessoa', avatar: withAvatar?.avatar || null,
    channels, channel: channels[0] || 'tinder', sub: named?.sub || null, idade: comIdade?.idade || null,
    merged: channels.length > 1 || personAliases(canonicalId).length > 1,
  }
}

// As duas formas do mesmo celular brasileiro (com e sem o 9º dígito), em dígitos puros.
// Procurar por substring crua NÃO resolve isto: o WhatsApp mostra "+55 11 99999-0010" e
// guarda o jid como 551199990010 — falta o 9, e uma string não é sufixo da outra. Foi
// exatamente assim que o assistente respondeu "não achei esse número" sobre uma conversa
// de 300 mensagens que existia (25/07/2026). phoneVariants é a resposta única do projeto.
function formasDoNumero(termo) {
  const digitos = String(termo || '').replace(/\D/g, '')
  if (digitos.length < 4) return []
  const formas = new Set([digitos])
  try { for (const v of phoneVariants(termo)) formas.add(v) } catch { /* não é telefone: só a forma crua */ }
  return [...formas]
}

// Busca unificada nos 3 canais (nome/username/telefone). Retorna cartões canônicos deduplicados.
export function searchPeople(accountKey, q, limit = 20) {
  const term = String(q || '').trim().toLowerCase()
  if (term.length < 1) return []
  const digits = term.replace(/\D/g, '')
  const formas = formasDoNumero(term)
  // Conversa em @lid não tem o número no jid; o mapa lid->pn é quem sabe. Sem consultar
  // wa_identity, quem só tem conversa em @lid fica invisível pra busca por telefone.
  const lidsDoNumero = new Set()
  if (formas.length) {
    for (const r of db().prepare(`SELECT lid, pn FROM wa_identity WHERE pn IS NOT NULL`).all()) {
      const pnd = String(r.pn).replace(/\D/g, '')
      if (formas.some((f) => pnd.includes(f))) lidsDoNumero.add(r.lid)
    }
  }
  const raw = []
  for (const c of db().prepare(`SELECT jid,name,pn FROM wa_chat WHERE account_key=?`).all(accountKey)) {
    const hay = (c.name || '').toLowerCase()
    // dígitos do número real (pn) E do jid: um @lid tem dígitos próprios que não são telefone
    const ph = String(c.pn || '').replace(/\D/g, '')
    const pj = String(c.jid || '').replace(/\D/g, '')
    const casaTelefone = formas.length && [ph, pj].some((alvo) => alvo && formas.some((f) => alvo.includes(f)))
    if (hay.includes(term) || casaTelefone || lidsDoNumero.has(c.jid)) raw.push('wa:' + c.jid)
  }
  for (const c of db().prepare(`SELECT thread_id,name,username FROM ig_chat WHERE account_key=?`).all(accountKey)) {
    if ((c.name || '').toLowerCase().includes(term) || (c.username || '').toLowerCase().includes(term)) raw.push('ig:' + c.thread_id)
  }
  for (const m of db().prepare(`SELECT person_id,name FROM tinder_match WHERE account_key=? AND name IS NOT NULL`).all(accountKey)) {
    if ((m.name || '').toLowerCase().includes(term)) raw.push(m.person_id)
  }
  const seen = new Set(); const out = []
  for (const r of raw) { const canon = canonicalPersonId(r); if (seen.has(canon)) continue; seen.add(canon); out.push(personCard(canon, accountKey)); if (out.length >= limit) break }
  return out
}

// Envolvidos de um projeto (cartões canônicos deduplicados + papel).
export function projectPeople(projectId, accountKey = 'main') {
  const rows = db().prepare(`SELECT person_id, role FROM project_person WHERE project_id=? ORDER BY created_at ASC`).all(projectId)
  const seen = new Map()
  for (const r of rows) { const canon = canonicalPersonId(r.person_id); if (!seen.has(canon)) seen.set(canon, r.role || null) }
  return [...seen.entries()].map(([canon, role]) => ({ ...personCard(canon, accountKey), role }))
}
export function addProjectPerson(projectId, personId, role = null) {
  db().prepare(`INSERT OR IGNORE INTO project_person(project_id,person_id,role,created_at) VALUES(?,?,?,?)`).run(projectId, personId, role, now())
  touchProject(projectId); logProject(projectId, 'person_added', personId)
}
export function setProjectPersonRole(projectId, personId, role) {
  // aceita o id canônico: aplica ao(s) alias(es) presente(s) no projeto
  const canon = canonicalPersonId(personId)
  for (const r of db().prepare(`SELECT person_id FROM project_person WHERE project_id=?`).all(projectId)) {
    if (canonicalPersonId(r.person_id) === canon) db().prepare(`UPDATE project_person SET role=? WHERE project_id=? AND person_id=?`).run(role || null, projectId, r.person_id)
  }
}
export function removeProjectPerson(projectId, personId) {
  const canon = canonicalPersonId(personId)
  for (const r of db().prepare(`SELECT person_id FROM project_person WHERE project_id=?`).all(projectId)) {
    if (canonicalPersonId(r.person_id) === canon) db().prepare(`DELETE FROM project_person WHERE project_id=? AND person_id=?`).run(projectId, r.person_id)
  }
  touchProject(projectId)
}
// Une duas identidades (mesma pessoa em canais diferentes). Escreve só no person_alias — não
// mexe no message store (as threads de cada canal seguem intactas). Retorna o id do merge.
export function mergePeople(primaryId, secondaryId) {
  const primary = canonicalPersonId(primaryId), secondary = canonicalPersonId(secondaryId)
  if (primary === secondary) return null
  const d = db(); const id = uid()
  const tx = d.transaction(() => {
    // re-encadeia quem já apontava pro secundário -> passa a apontar pro primário
    d.prepare(`UPDATE person_alias SET canonical_person_id=? WHERE canonical_person_id=?`).run(primary, secondary)
    d.prepare(`INSERT OR REPLACE INTO person_alias(alias_person_id,canonical_person_id,created_at) VALUES(?,?,?)`).run(secondary, primary, now())
    d.prepare(`INSERT INTO person_merge(id,ts,primary_person_id,merged_person_id,detail) VALUES(?,?,?,?,?)`).run(id, now(), primary, secondary, JSON.stringify({ primaryId, secondaryId }))
  })
  tx()
  import('../self/cidade-pessoa.mjs')
    .then((C) => C.reconciliarAposUniao(primary, secondary))
    .catch(() => {})
  return id
}
export function undoMerge(mergeId) {
  const m = db().prepare(`SELECT * FROM person_merge WHERE id=?`).get(mergeId)
  if (!m) return false
  const d = db()
  const tx = d.transaction(() => {
    d.prepare(`DELETE FROM person_alias WHERE alias_person_id=? AND canonical_person_id=?`).run(m.merged_person_id, m.primary_person_id)
    d.prepare(`DELETE FROM person_merge WHERE id=?`).run(mergeId)
  })
  tx()
  return true
}
// Desfaz a união de UMA conversa específica (o X por rede na tela de identidade), sem
// mexer nas outras. Some também o registro de merge daquele par, pra não ressuscitar.
export function removerAlias(aliasPersonId) {
  const d = db()
  const linha = d.prepare(`SELECT canonical_person_id FROM person_alias WHERE alias_person_id=?`).get(aliasPersonId)
  if (!linha) return false
  const tx = d.transaction(() => {
    d.prepare(`DELETE FROM person_alias WHERE alias_person_id=?`).run(aliasPersonId)
    d.prepare(`DELETE FROM person_merge WHERE merged_person_id=? AND primary_person_id=?`).run(aliasPersonId, linha.canonical_person_id)
  })
  tx()
  return true
}

export function recentMerges(limit = 30) { return db().prepare(`SELECT * FROM person_merge ORDER BY ts DESC LIMIT ?`).all(limit) }
// Projetos ATIVOS em que uma pessoa (por qualquer alias) é envolvida. Usado pra sugerir
// o projeto de uma proposta de compromisso (F6): quando é exatamente um, a proposta o adota.
export function projectsForPerson(personId, accountKey = 'main') {
  const canon = canonicalPersonId(personId)
  const seen = new Set()
  const out = []
  for (const r of db().prepare(`SELECT DISTINCT pp.project_id FROM project_person pp JOIN project p ON p.id=pp.project_id
      WHERE p.account_key=? AND p.status='ativo'`).all(accountKey)) {
    // filtra por canônico (o project_person guarda ids brutos)
    const rows = db().prepare(`SELECT person_id FROM project_person WHERE project_id=?`).all(r.project_id)
    if (rows.some((x) => canonicalPersonId(x.person_id) === canon)) { if (!seen.has(r.project_id)) { seen.add(r.project_id); out.push(getProject(r.project_id)) } }
  }
  return out
}
// Acha o merge que uniu duas identidades (pra oferecer "desfazer" no chip certo).
export function mergeForCanonical(canonicalId) { return db().prepare(`SELECT * FROM person_merge WHERE primary_person_id=? ORDER BY ts DESC LIMIT 1`).get(canonicalId) || null }

// ============================================================ TIMELINE DO PROJETO
export function logProject(projectId, type, detail) {
  if (!projectId) return
  db().prepare(`INSERT INTO project_log(project_id,ts,type,detail) VALUES(?,?,?,?)`).run(projectId, now(), type, typeof detail === 'string' ? detail : JSON.stringify(detail || {}))
}
export function projectLog(projectId, limit = 60) { return db().prepare(`SELECT * FROM project_log WHERE project_id=? ORDER BY ts DESC LIMIT ?`).all(projectId, limit) }

// ============================================================ AGREGADO DO HOJE
export function todayData(accountKey) {
  const stamp = dayStampSP()
  const habits = habitsForDay(accountKey, stamp)
  const reminders = remindersByStamp(accountKey, stamp)
  const tasks = tasksDueByStamp(accountKey, stamp)
  // próximos passos dos projetos ativos
  const nextSteps = []
  for (const p of db().prepare(`SELECT id,name,color FROM project WHERE account_key=? AND status='ativo'`).all(accountKey)) {
    const t = db().prepare(`SELECT id,title,due_date FROM task WHERE project_id=? AND is_next=1 AND done=0 LIMIT 1`).get(p.id)
    if (t) nextSteps.push({ projectId: p.id, projectName: p.name, color: p.color, taskId: t.id, title: t.title, dueDate: t.due_date || null })
  }
  const startToday = startOfDaySP(stamp), endToday = endOfDaySP(stamp)
  return { stamp, habits, reminders, tasks, nextSteps, dayStart: startToday, dayEnd: endToday }
}
// Contagem pro badge da aba (itens de hoje não resolvidos).
export function todayBadgeCount(accountKey) {
  const stamp = dayStampSP()
  const rem = remindersByStamp(accountKey, stamp).length
  const tsk = tasksDueByStamp(accountKey, stamp).length
  return rem + tsk
}

export { TZ }
