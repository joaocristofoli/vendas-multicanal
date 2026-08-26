#!/usr/bin/env node
// Mede uma hipótese ANTES de ela virar afirmação: nas conversas de teor romântico, o avanço
// sexual do outro é seguido de um pedido material dela?
//
// Ler seis trechos e concluir "é assim que ela funciona" é exatamente o erro que este projeto
// não pode cometer — um perfil inteiro sairia errado por causa de uma amostra pequena. Aqui a
// pergunta vira contagem: quantas conversas, com que frequência, e em que ordem.
import { db } from '../src/core/db.mjs'

const DINHEIRO = /\b(pix|mimar|mimo|mima|agrado|presente|me ajuda|ajudinha|dinheiro|grana|valor|r\$|reais|paga|pagar|deposita|conteudo|conteúdo|privacy|onlyfans|assinatura|pack)\b/i
const AVANCO = /\b(gostosa|tesão|tesao|quero te|te quero|transar|foder|chupar|pelad|nud|manda foto|manda uma foto|foto sua|video seu|vídeo seu|delicia|delícia|safad)\b/i

const m = db().prepare(`
  SELECT person_id, text, ts, direction, author FROM message
  WHERE channel='whatsapp' AND text IS NOT NULL AND length(trim(text))>0 ORDER BY ts
`).all()

const ehDela = (x) => x.direction === 'outgoing' && x.author !== 'ia'
const minhas = m.filter(ehDela)
const deles = m.filter((x) => x.direction === 'incoming')
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-')

console.log('== VOLUME ==')
console.log('  mensagens dela com termo de dinheiro/mimo:', minhas.filter((x) => DINHEIRO.test(x.text)).length,
  'de', minhas.length, '=', pct(minhas.filter((x) => DINHEIRO.test(x.text)).length, minhas.length))
console.log('  mensagens deles com termo de dinheiro:', deles.filter((x) => DINHEIRO.test(x.text)).length,
  '=', pct(deles.filter((x) => DINHEIRO.test(x.text)).length, deles.length))

const conv = new Map()
for (const x of m) {
  if (!conv.has(x.person_id)) conv.set(x.person_id, { n: 0, dinDela: 0, avancoDele: 0 })
  const c = conv.get(x.person_id)
  c.n++
  if (ehDela(x) && DINHEIRO.test(x.text)) c.dinDela++
  if (x.direction === 'incoming' && AVANCO.test(x.text)) c.avancoDele++
}
const cs = [...conv.values()].filter((c) => c.n >= 20)
console.log('\n== CONVERSAS (20+ mensagens) ==')
console.log('  total:', cs.length)
console.log('  com pedido material dela (2+):', cs.filter((c) => c.dinDela >= 2).length)
console.log('  com avanço sexual dele (2+):', cs.filter((c) => c.avancoDele >= 2).length)
console.log('  com OS DOIS:', cs.filter((c) => c.dinDela >= 2 && c.avancoDele >= 2).length)

// A ordem importa: pedido DEPOIS do avanço é uma dinâmica; pedido solto é outra coisa.
let seguido = 0, total = 0
const idx = new Map()
m.forEach((x, i) => { if (!idx.has(x.person_id)) idx.set(x.person_id, []); idx.get(x.person_id).push(i) })
for (let i = 0; i < m.length; i++) {
  if (m[i].direction !== 'incoming' || !AVANCO.test(m[i].text)) continue
  total++
  const lista = idx.get(m[i].person_id)
  const pos = lista.indexOf(i)
  for (const j of lista.slice(pos + 1, pos + 6)) {
    if (ehDela(m[j]) && DINHEIRO.test(m[j].text)) { seguido++; break }
  }
}
console.log('\n== ORDEM ==')
console.log('  avanços deles:', total, '| seguidos de pedido dela em até 5 mensagens:', seguido, '=', pct(seguido, total))

// O que ela pede, em ordem de frequência: distingue "sorvete" de "pix"
const termos = new Map()
for (const x of minhas) {
  const achado = x.text.match(new RegExp(DINHEIRO, 'gi'))
  for (const t of (achado || [])) { const k = t.toLowerCase(); termos.set(k, (termos.get(k) || 0) + 1) }
}
console.log('\n== O QUE ELA PEDE ==')
console.log(' ', JSON.stringify([...termos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)))
