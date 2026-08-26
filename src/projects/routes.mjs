// Rotas HTTP do módulo Projetos. Um handler único chamado pelo index.mjs: devolve true se
// tratou a rota, false se não é dele (o index segue pro 404). Mantém o index.mjs enxuto —
// toda a superfície /api/projects|tasks|notes|reminders|habits|people|capture|today mora aqui.
import * as S from './store.mjs'
import { interpretCapture } from './capture.mjs'

const uidLike = (s) => decodeURIComponent(String(s || ''))

// ctx = { p, method, req, res, url, json, body, broadcast, account, agenda }
//   agenda = { connected(): bool, createEvent(opts), listRange({timeMinIso,timeMaxIso}) }
export async function handleProjectsApi(ctx) {
  const { p, method, res, url, json, body, broadcast, account: ACCOUNT, agenda } = ctx
  const seg = p.split('/').filter(Boolean) // ['api','projects', ...]
  const notForUs = !['projects', 'tasks', 'notes', 'reminders', 'habits', 'people', 'capture', 'today', 'week'].includes(seg[1])
  if (notForUs) return false
  const touch = () => broadcast({ t: 'projects' })

  // Eventos da agenda (compromissos) num intervalo, opcionalmente de um projeto. [] se desconectada.
  async function eventsInRange(fromMs, toMs, projectId = null) {
    if (!agenda.connected()) return []
    try {
      const evs = await agenda.listRange({ timeMinIso: new Date(fromMs).toISOString(), timeMaxIso: new Date(toMs).toISOString() })
      return projectId ? evs.filter((e) => e.projectId === projectId) : evs
    } catch { return [] }
  }

  // ---------------- /api/today ----------------
  if (seg[1] === 'today' && method === 'GET') {
    const t = S.todayData(ACCOUNT)
    const events = await eventsInRange(t.dayStart, t.dayEnd)
    return json(res, 200, { ...t, events }), true
  }

  // ---------------- /api/week (próximos 7 dias: compromissos + lembretes + prazos) ----------------
  if (seg[1] === 'week' && method === 'GET') {
    const from = S.startOfDaySP(S.dayStampSP())
    const to = from + 7 * 86400000 - 1
    const events = await eventsInRange(from, to)
    return json(res, 200, {
      from, to,
      events,
      reminders: S.remindersRange(ACCOUNT, from, to).map(remOut),
      tasks: S.tasksDueRange(ACCOUNT, from, to),
    }), true
  }

  // ---------------- /api/projects ----------------
  if (seg[1] === 'projects') {
    if (!seg[2]) {
      if (method === 'GET') {
        return json(res, 200, {
          projects: S.listProjectsAggregated(ACCOUNT),
          inbox: { tasks: S.inboxTasks(ACCOUNT), notes: S.inboxNotes(ACCOUNT) },
        }), true
      }
      if (method === 'POST') {
        const b = await body()
        const name = String(b.name || '').trim()
        if (!name) return json(res, 400, { error: 'nome' }), true
        const pr = S.createProject({ accountKey: ACCOUNT, name, type: b.type || 'pessoal', color: b.color || 'teal', description: b.description || null })
        touch()
        return json(res, 200, { ok: true, project: S.projectAggregate(pr) }), true
      }
    }
    const id = uidLike(seg[2])
    const project = S.getProject(id)
    if (!project) return json(res, 404, { error: 'projeto' }), true

    // /api/projects/:id/<sub>
    const sub = seg[3]
    if (!sub) {
      if (method === 'GET') {
        // janela ampla pros compromissos do projeto (passado recente + futuro)
        const events = await eventsInRange(Date.now() - 30 * 86400000, Date.now() + 400 * 86400000, id)
        return json(res, 200, {
          project: S.projectAggregate(project),
          tasks: S.projectTasks(id),
          notes: S.projectNotes(id),
          reminders: S.projectReminders(id).map(remOut),
          people: S.projectPeople(id, ACCOUNT).map((pp) => ({ ...pp, merge: pp.merged ? (S.mergeForCanonical(pp.personId)?.id || null) : null })),
          log: S.projectLog(id),
          events,
        }), true
      }
      if (method === 'PATCH') { const b = await body(); const pr = S.updateProject(id, b); touch(); return json(res, 200, { ok: true, project: S.projectAggregate(pr) }), true }
      if (method === 'DELETE') { S.deleteProject(id); touch(); return json(res, 200, { ok: true }), true }
    }
    if (sub === 'tasks' && method === 'POST') {
      const b = await body(); const title = String(b.title || '').trim()
      if (!title) return json(res, 400, { error: 'título' }), true
      const t = S.createTask({ accountKey: ACCOUNT, projectId: id, title, dueDate: b.dueDate || null }); touch()
      return json(res, 200, { ok: true, task: t }), true
    }
    if (sub === 'notes' && method === 'POST') {
      const b = await body(); const text = String(b.text || '').trim()
      if (!text) return json(res, 400, { error: 'texto' }), true
      const n = S.createNote({ accountKey: ACCOUNT, projectId: id, text }); touch()
      return json(res, 200, { ok: true, note: n }), true
    }
    if (sub === 'people' && method === 'POST') {
      const b = await body()
      if (b.action === 'remove') { S.removeProjectPerson(id, b.personId); touch(); return json(res, 200, { ok: true }), true }
      if (b.action === 'role') { S.setProjectPersonRole(id, b.personId, b.role || null); touch(); return json(res, 200, { ok: true }), true }
      if (!b.personId) return json(res, 400, { error: 'personId' }), true
      S.addProjectPerson(id, b.personId, b.role || null); touch()
      return json(res, 200, { ok: true, people: S.projectPeople(id, ACCOUNT) }), true
    }
    // Criar compromisso do projeto -> vira evento carimbado na Google Agenda
    if (sub === 'commit' && method === 'POST') {
      if (!agenda.connected()) return json(res, 400, { error: 'agenda não conectada' }), true
      const b = await body(); const title = String(b.title || project.name).trim()
      const startsAt = b.startsAt ? Date.parse(b.startsAt) : NaN
      if (Number.isNaN(startsAt)) return json(res, 400, { error: 'data' }), true
      try {
        const ev = await agenda.createEvent({ title, startsAtIso: new Date(startsAt).toISOString(), endsAtIso: b.endsAt || null, description: null, projectId: id })
        S.logProject(id, 'event_created', `${title} @ ${new Date(startsAt).toISOString()}`); S.touchProject(id); touch()
        return json(res, 200, { ok: true, event: ev }), true
      } catch (e) { return json(res, 500, { error: e.message }), true }
    }
  }

  // ---------------- /api/tasks/:id ----------------
  if (seg[1] === 'tasks' && seg[2]) {
    const id = uidLike(seg[2]); const t = S.getTask(id)
    if (!t) return json(res, 404, { error: 'tarefa' }), true
    if (seg[3] === 'move' && method === 'POST') { const b = await body(); S.moveTask(id, Number(b.dir) || 1); touch(); return json(res, 200, { ok: true }), true }
    if (method === 'PATCH') {
      const b = await body()
      if ('isNext' in b && t.project_id) S.setTaskNext(t.project_id, b.isNext ? id : null)
      const patch = {}
      for (const k of ['done', 'title', 'dueDate', 'position', 'projectId']) if (k in b) patch[k] = b[k]
      const out = Object.keys(patch).length ? S.updateTask(id, patch) : S.getTask(id)
      touch(); return json(res, 200, { ok: true, task: out }), true
    }
    if (method === 'DELETE') { S.deleteTask(id); touch(); return json(res, 200, { ok: true }), true }
  }

  // ---------------- /api/notes/:id ----------------
  if (seg[1] === 'notes' && seg[2] && method === 'DELETE') { S.deleteNote(uidLike(seg[2])); touch(); return json(res, 200, { ok: true }), true }

  // ---------------- /api/reminders ----------------
  if (seg[1] === 'reminders') {
    if (!seg[2] && method === 'POST') {
      const b = await body(); const text = String(b.text || '').trim()
      const at = b.at ? Number(b.at) : (b.startsAt ? Date.parse(b.startsAt) : NaN)
      if (!text || Number.isNaN(at)) return json(res, 400, { error: 'texto/quando' }), true
      const r = S.createReminder({ accountKey: ACCOUNT, projectId: b.projectId || null, taskId: b.taskId || null, text, at, recurrence: b.recurrence || null })
      touch(); return json(res, 200, { ok: true, reminder: remOut(r) }), true
    }
    if (seg[2]) {
      const id = uidLike(seg[2]); const r = S.getReminder(id)
      if (!r) return json(res, 404, { error: 'lembrete' }), true
      if (method === 'PATCH') {
        const b = await body()
        if (b.action === 'done') { S.updateReminder(id, { status: 'feito' }) }
        else if (b.action === 'pause') { S.updateReminder(id, { status: r.status === 'pausado' ? 'ativo' : 'pausado' }) }
        else if (b.action === 'snooze') { S.updateReminder(id, { snoozeUntil: Number(b.until) || (Date.now() + 3600000) }) }
        else { const patch = {}; for (const k of ['text', 'at', 'recurrence']) if (k in b) patch[k] = b[k]; if (Object.keys(patch).length) S.updateReminder(id, patch) }
        touch(); return json(res, 200, { ok: true, reminder: remOut(S.getReminder(id)) }), true
      }
      if (method === 'DELETE') { S.deleteReminder(id); touch(); return json(res, 200, { ok: true }), true }
    }
  }

  // ---------------- /api/habits ----------------
  if (seg[1] === 'habits') {
    if (!seg[2]) {
      if (method === 'GET') return json(res, 200, { habits: S.habitsForDay(ACCOUNT) }), true
      if (method === 'POST') { const b = await body(); const name = String(b.name || '').trim(); if (!name) return json(res, 400, { error: 'nome' }), true; const h = S.createHabit({ accountKey: ACCOUNT, name, days: b.days || 'daily', timeHint: b.timeHint || null }); touch(); return json(res, 200, { ok: true, habit: h }), true }
    }
    if (seg[2]) {
      const id = uidLike(seg[2])
      if (seg[3] === 'check' && method === 'POST') { const h = S.toggleHabit(id); touch(); return json(res, 200, { ok: true, habit: { id: h.id, streak: h.streak_current, best: h.streak_best } }), true }
      if (method === 'PATCH') { const b = await body(); const h = S.updateHabit(id, b); touch(); return json(res, 200, { ok: true, habit: h }), true }
      if (method === 'DELETE') { S.deleteHabit(id); touch(); return json(res, 200, { ok: true }), true }
    }
  }

  // ---------------- /api/people (busca unificada + merge) ----------------
  if (seg[1] === 'people') {
    if (seg[2] === 'search' && method === 'GET') { return json(res, 200, { results: S.searchPeople(ACCOUNT, url.searchParams.get('q') || '') }), true }
    if (seg[2] === 'merge') {
      if (seg[3] === 'undo' && method === 'POST') { const b = await body(); const ok = S.undoMerge(b.mergeId); touch(); return json(res, 200, { ok }), true }
      if (method === 'POST') {
        const b = await body()
        if (!b.primaryId || !b.secondaryId) return json(res, 400, { error: 'ids' }), true
        const mergeId = S.mergePeople(b.primaryId, b.secondaryId); touch()
        return json(res, 200, { ok: !!mergeId, mergeId }), true
      }
    }
  }

  // ---------------- /api/capture ----------------
  if (seg[1] === 'capture') {
    if (!seg[2] && method === 'POST') {
      const b = await body(); const text = String(b.text || '').trim()
      if (!text) return json(res, 400, { error: 'texto' }), true
      const preview = await interpretCapture({ accountKey: ACCOUNT, text })
      return json(res, 200, { ok: true, preview }), true
    }
    if (seg[2] === 'commit' && method === 'POST') {
      const b = await body()
      const type = b.type || 'task'
      const projectId = b.projectId || null
      try {
        if (type === 'compromisso') {
          if (!agenda.connected()) return json(res, 400, { error: 'agenda não conectada' }), true
          const startsAt = b.at ? Number(b.at) : Date.parse(b.startsAt)
          if (Number.isNaN(startsAt)) return json(res, 400, { error: 'data' }), true
          const ev = await agenda.createEvent({ title: b.title || 'Compromisso', startsAtIso: new Date(startsAt).toISOString(), endsAtIso: null, projectId })
          if (projectId) { S.logProject(projectId, 'event_created', b.title || ''); S.touchProject(projectId) }
          touch(); return json(res, 200, { ok: true, kind: 'compromisso', event: ev }), true
        }
        if (type === 'lembrete') {
          const at = b.at ? Number(b.at) : Date.parse(b.startsAt)
          if (Number.isNaN(at)) return json(res, 400, { error: 'data' }), true
          const r = S.createReminder({ accountKey: ACCOUNT, projectId, text: b.title || b.text, at, recurrence: b.recurrence || null })
          touch(); return json(res, 200, { ok: true, kind: 'lembrete', reminder: remOut(r) }), true
        }
        if (type === 'nota') { const n = S.createNote({ accountKey: ACCOUNT, projectId, text: b.title || b.text }); touch(); return json(res, 200, { ok: true, kind: 'nota', note: n }), true }
        // default: tarefa
        const t = S.createTask({ accountKey: ACCOUNT, projectId, title: b.title || b.text, dueDate: b.dueDate || (b.at ? Number(b.at) : null) })
        touch(); return json(res, 200, { ok: true, kind: 'tarefa', task: t }), true
      } catch (e) { return json(res, 500, { error: e.message }), true }
    }
  }

  return false
}

// Serializa um lembrete pro painel (traduz recurrence + próxima ocorrência legível).
function remOut(r) {
  if (!r) return null
  return {
    id: r.id, text: r.text, at: r.at, recurrence: r.recurrence || null, status: r.status,
    projectId: r.project_id || null, snoozeUntil: r.snooze_until || null, lastFiredAt: r.last_fired_at || null,
  }
}
