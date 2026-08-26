// Rotina semanal declarada de quem opera: o que costuma fazer, em quais horários e onde.
//
// Não é disponibilidade. Uma pessoa pode estar trabalhando às 14h e ainda assim aceitar
// uma ligação; ou estar sem evento na agenda e não estar livre. A rotina descreve o pano de
// fundo da vida, enquanto Agenda e Encontros decidem compromissos e horários disponíveis.
//
// Cada instância do TIM pertence a uma pessoa, então a tabela não carrega person_id. No
// clone ela nasce vazia, como toda identidade. Sem item ativo, rotinaBlock() devolve '' e a
// geração permanece byte a byte como era.
import crypto from 'node:crypto'
import { db } from '../core/db.mjs'

const TZ = 'America/Sao_Paulo'
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const id8 = () => crypto.randomBytes(6).toString('hex')
const agora = () => Date.now()

const fmtPartes = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function hhmm(valor) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(valor || '').trim())
  if (!m) return null
  const h = Number(m[1]), min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

function minutos(valor) {
  const [h, m] = valor.split(':').map(Number)
  return h * 60 + m
}

function normalizarDias(valor) {
  let entrada = valor
  if (typeof valor === 'string') {
    try { entrada = JSON.parse(valor) } catch { entrada = [] }
  }
  return [...new Set((Array.isArray(entrada) ? entrada : [])
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
}

function item(row) {
  if (!row) return null
  return { ...row, dias: normalizarDias(row.dias), ativo: !!row.ativo }
}

export function listarRotina({ somenteAtiva = false } = {}) {
  const sql = `SELECT * FROM rotina${somenteAtiva ? ' WHERE ativo=1' : ''} ORDER BY inicio, titulo`
  return db().prepare(sql).all().map(item)
}

export function salvarRotina({ id, titulo, detalhes = '', local = '', dias = [], inicio, fim, ativo = true } = {}) {
  const nome = String(titulo || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  const desc = String(detalhes || '').replace(/\s+/g, ' ').trim().slice(0, 500)
  const onde = String(local || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  const ds = normalizarDias(dias)
  const ini = hhmm(inicio), ate = hhmm(fim)
  if (!nome) throw new Error('diga o que você faz nesse horário')
  if (!ds.length) throw new Error('escolha pelo menos um dia')
  if (!ini || !ate) throw new Error('horário inválido')
  if (ini === ate) throw new Error('início e fim precisam ser diferentes')

  const idR = String(id || '').trim() || id8()
  const existente = db().prepare('SELECT created_at FROM rotina WHERE id=?').get(idR)
  const t = agora()
  db().prepare(`INSERT INTO rotina(id,titulo,detalhes,local,dias,inicio,fim,ativo,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET titulo=excluded.titulo, detalhes=excluded.detalhes,
      local=excluded.local, dias=excluded.dias, inicio=excluded.inicio, fim=excluded.fim,
      ativo=excluded.ativo, updated_at=excluded.updated_at`)
    .run(idR, nome, desc || null, onde || null, JSON.stringify(ds), ini, ate, ativo ? 1 : 0, existente?.created_at || t, t)
  return idR
}

export function apagarRotina(id) {
  return db().prepare('DELETE FROM rotina WHERE id=?').run(String(id || '')).changes > 0
}

export function partesDoAgora(ms = agora()) {
  const p = Object.fromEntries(fmtPartes.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  const dow = WEEKDAYS.indexOf(p.weekday)
  const hora = `${p.hour === '24' ? '00' : p.hour}:${p.minute}`
  return { dow, hora, minutos: minutos(hora) }
}

// Uma faixa 22h–02h pertence ao dia em que COMEÇA. À 01h de terça, portanto, vale a faixa
// de segunda. Essa borda é onde implementações que só comparam strings costumam mentir.
export function itemValeAgora(r, ms = agora()) {
  if (!r?.ativo) return false
  const ds = normalizarDias(r.dias)
  const ini = hhmm(r.inicio), fim = hhmm(r.fim)
  if (!ds.length || !ini || !fim || ini === fim) return false
  const p = partesDoAgora(ms)
  const a = minutos(ini), b = minutos(fim)
  if (b > a) return ds.includes(p.dow) && p.minutos >= a && p.minutos < b
  if (p.minutos >= a) return ds.includes(p.dow)
  if (p.minutos < b) return ds.includes((p.dow + 6) % 7)
  return false
}

export function rotinaAgora(ms = agora()) {
  return listarRotina({ somenteAtiva: true }).filter((r) => itemValeAgora(r, ms))
}

function nomeDosDias(dias) {
  const ds = normalizarDias(dias)
  if (ds.length === 7) return 'todos os dias'
  if (JSON.stringify(ds) === JSON.stringify([1, 2, 3, 4, 5])) return 'segunda a sexta'
  if (JSON.stringify(ds) === JSON.stringify([0, 6])) return 'sábado e domingo'
  return ds.map((d) => DIAS_CURTOS[d]).join(', ')
}

function descrever(r) {
  const horario = `${r.inicio}–${r.fim}`
  const onde = r.local ? `, em ${r.local}` : ''
  const detalhes = r.detalhes ? ` — ${r.detalhes}` : ''
  return `${nomeDosDias(r.dias)}, ${horario}: ${r.titulo}${onde}${detalhes}`
}

export function rotinaBlock(ms = agora()) {
  const itens = listarRotina({ somenteAtiva: true })
  if (!itens.length) return ''
  const atuais = itens.filter((r) => itemValeAgora(r, ms))
  const linhas = [
    'ROTINA DECLARADA DO USUÁRIO (padrão semanal, não confirmação em tempo real).',
    'Use apenas quando ajudar a conversa. Trate como o que o usuário normalmente está fazendo, nunca como prova de onde o usuário está agora. Não despeje a rotina nem ofereça horários como disponibilidade; Agenda e Encontros são as fontes para compromissos.',
  ]
  if (atuais.length) linhas.push(`Pelo horário atual, o usuário provavelmente está: ${atuais.map((r) => `${r.titulo}${r.local ? ` em ${r.local}` : ''}`).join('; ')}.`)
  else linhas.push('Pelo horário atual, nenhuma atividade cadastrada está em andamento.')
  linhas.push('Semana declarada:')
  for (const r of itens) linhas.push(`- ${descrever(r)}`)
  return linhas.join('\n')
}

export { DIAS }
