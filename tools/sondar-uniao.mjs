#!/usr/bin/env node
// Sonda: quantas pessoas do WhatsApp, Instagram e Tinder são a MESMA pessoa e ainda estão
// separadas? Mede o tamanho da oportunidade antes de construir o resolvedor. Só leitura.
import { db } from '../src/core/db.mjs'
import { canonicalPersonId } from '../src/projects/store.mjs'

const d = db()
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
const primeiro = (s) => norm(s).split(' ')[0] || ''

const wa = d.prepare(`SELECT jid, name, pn FROM wa_chat WHERE name IS NOT NULL AND TRIM(name) <> ''`).all()
const ig = d.prepare(`SELECT thread_id, name, username FROM ig_chat`).all()
const ti = d.prepare(`SELECT person_id, name FROM tinder_match WHERE name IS NOT NULL`).all()

console.log(`\nconversas com nome: WhatsApp ${wa.length} · Instagram ${ig.length} · Tinder ${ti.length}`)

// ---- nome completo idêntico entre canais (sinal forte quando tem 2+ palavras)
function cruzar(a, b, rotuloA, rotuloB) {
  const idx = new Map()
  for (const x of b) { const k = norm(x.name); if (k) { if (!idx.has(k)) idx.set(k, []); idx.get(k).push(x) } }
  const fortes = [], fracos = []
  for (const x of a) {
    const k = norm(x.name)
    if (!k) continue
    const hits = idx.get(k) || []
    if (!hits.length) continue
    const palavras = k.split(' ').length
    for (const h of hits) (palavras >= 2 ? fortes : fracos).push({ a: x, b: h, nome: x.name })
  }
  console.log(`\n${rotuloA} x ${rotuloB}: ${fortes.length} nome completo igual (2+ palavras), ${fracos.length} só primeiro nome`)
  for (const f of fortes.slice(0, 10)) console.log(`   forte: ${f.nome}`)
  for (const f of fracos.slice(0, 5)) console.log(`   fraco: ${f.nome}`)
  return { fortes, fracos }
}

const igWa = cruzar(ig, wa, 'Instagram', 'WhatsApp')
const tiWa = cruzar(ti, wa, 'Tinder', 'WhatsApp')
const tiIg = cruzar(ti, ig, 'Tinder', 'Instagram')

// ---- @ do Instagram citado em alguma conversa (o hint que já existe)
const hints = d.prepare(`SELECT kind, COUNT(*) n FROM contact_hint GROUP BY kind`).all()
console.log('\ncontatos colhidos das conversas (contact_hint):', hints.map((h) => `${h.kind}=${h.n}`).join(' · ') || 'nenhum')

// ---- quantas dessas já estão unidas?
let jaUnidos = 0
for (const f of [...igWa.fortes, ...tiWa.fortes, ...tiIg.fortes]) {
  const ida = f.a.thread_id ? 'ig:' + f.a.thread_id : (f.a.person_id || ('wa:' + f.a.jid))
  const idb = f.b.jid ? 'wa:' + f.b.jid : (f.b.thread_id ? 'ig:' + f.b.thread_id : f.b.person_id)
  if (canonicalPersonId(ida) === canonicalPersonId(idb)) jaUnidos++
}
console.log(`\ndesses pares fortes, já unidos hoje: ${jaUnidos}`)

// ---- volume de conversa das que têm nome completo repetido (vale a pena unir?)
const volume = (id) => d.prepare(`SELECT COUNT(*) n FROM message WHERE person_id=?`).get(id)?.n || 0
console.log('\ntop pares por volume de conversa (os que mais ganham com memória única):')
const pares = igWa.fortes.map((f) => {
  const ida = 'ig:' + f.a.thread_id, idb = 'wa:' + f.b.jid
  return { nome: f.nome, ig: volume(ida), wa: volume(idb), total: volume(ida) + volume(idb) }
}).sort((a, b) => b.total - a.total).slice(0, 10)
for (const p of pares) console.log(`   ${String(p.nome).slice(0, 24).padEnd(26)} ig ${String(p.ig).padStart(4)} + wa ${String(p.wa).padStart(5)} = ${p.total}`)
console.log('')
