#!/usr/bin/env node
// Recorta TRECHOS DE DIÁLOGO em torno dos momentos que definem o modo romântico, pra leitura
// humana (ou de modelo) depois. O script não interpreta nada: ele seleciona.
//
// Por que trecho e não mensagem solta: "como ela responde a um elogio" só existe com o elogio
// junto. Mensagem isolada mostra vocabulário; o turno mostra COMPORTAMENTO — se ela devolve,
// desconversa, escala, ri, ou muda de assunto.
//
// Uso: node tools/amostras-voz.mjs <momento> [--n 12] [--janela 6]
//   momentos: elogio | avanco | encontro | abertura | sumico | recusa | quente | fim
import { db } from '../src/core/db.mjs'

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d }
const momento = process.argv[2] || 'elogio'
const N = +arg('--n', 12)
const JANELA = +arg('--janela', 6)

// O gatilho é sempre algo que a OUTRA pessoa disse (direction=incoming): o que se quer ver é
// a reação DELA. Exceção: 'abertura' e 'sumico', onde o gatilho é dela mesma.
const GATILHOS = {
  elogio: { lado: 'incoming', re: /\b(linda|gostosa|delícia|delicia|maravilhosa|perfeita|te acho|que corpo|gata|princesa|cheirosa|sexy|tesão em vc|tesao em vc)\b/i },
  avanco: { lado: 'incoming', re: /\b(quero te|te quero|vontade de|tesão|tesao|pelad|nud|manda uma foto|me manda|foto sua|saudade do seu|quero ver você|quero ver vc)\b/i },
  encontro: { lado: 'incoming', re: /\b(vamos sair|te ver|nos ver|marcar|vem aqui|vou aí|te busco|te pego|cinema|jantar|almoç|motel|dormir|passar a noite)\b/i },
  quente: { lado: 'incoming', re: /\b(gozar|gozei|foder|fode|transar|chupar|meter|molhad|duro|pau|buceta|rola|safad|gemid)\b/i },
  recusa: { lado: 'outgoing', re: /\b(não posso|nao posso|hoje não|hoje nao|agora não|agora nao|tô ocupad|to ocupad|melhor não|melhor nao|não quero|nao quero|para|deixa pra)\b/i },
  abertura: { lado: 'outgoing', re: /^(oi|oii+|olá|ola|bom dia|boa tarde|boa noite|e aí|e ai|opa|sumiu|cadê|cade)\b/i },
  sumico: { lado: 'outgoing', re: /\b(sumiu|cadê você|cade vc|desapareceu|morreu|tá vivo|ta vivo|esqueceu de mim)\b/i },
  fim: { lado: 'outgoing', re: /\b(boa noite|vou dormir|to indo dormir|tô indo dormir|até amanhã|ate amanha|beijos|bjs)\b/i },
}

const g = GATILHOS[momento]
if (!g) { console.error('momento inválido: ' + momento + ' (use ' + Object.keys(GATILHOS).join('|') + ')'); process.exit(1) }

const msgs = db().prepare(`
  SELECT person_id, text, ts, direction, author FROM message
  WHERE channel='whatsapp' AND text IS NOT NULL AND length(trim(text))>0 ORDER BY ts
`).all()

// índice por pessoa pra recortar a janela sem varrer tudo de novo
const porPessoa = new Map()
msgs.forEach((m, i) => { if (!porPessoa.has(m.person_id)) porPessoa.set(m.person_id, []); porPessoa.get(m.person_id).push(i) })

const hora = (ts) => new Date(ts - 3 * 3600_000).toISOString().slice(5, 16).replace('T', ' ')
const quem = (m) => (m.direction === 'outgoing' ? 'ELA ' : 'ele ')

const vistos = new Set()
const trechos = []
for (let i = 0; i < msgs.length && trechos.length < N; i++) {
  const m = msgs[i]
  const ladoCerto = g.lado === 'incoming' ? m.direction === 'incoming' : (m.direction === 'outgoing' && m.author !== 'ia')
  if (!ladoCerto || !g.re.test(m.text)) continue
  // uma amostra por pessoa: senão a conversa mais longa domina tudo
  if (vistos.has(m.person_id)) continue
  vistos.add(m.person_id)
  const idx = porPessoa.get(m.person_id)
  const pos = idx.indexOf(i)
  const janela = idx.slice(Math.max(0, pos - 2), pos + JANELA).map((k) => msgs[k])
  trechos.push({ pessoa: vistos.size, linhas: janela.map((x) => `  ${hora(x.ts)} ${quem(x)}| ${x.text.replace(/\s+/g, ' ').slice(0, 220)}`) })
}

console.log(`### ${momento.toUpperCase()} — ${trechos.length} trechos (uma pessoa cada)\n`)
for (const t of trechos) { console.log(`--- conversa ${t.pessoa} ---`); console.log(t.linhas.join('\n')); console.log('') }
