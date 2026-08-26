#!/usr/bin/env node
// Como ELA fala quando a conversa é íntima — não como reagem a ela.
//
// A diferença importa: as amostras por "gatilho do outro" mostram a reação dela a um avanço,
// e isso enviesa pro papel defensivo. Aqui o recorte é o oposto: as mensagens em que ela
// mesma puxa o registro afetivo ou explícito. É esse material que vira o modo romântico —
// escrever o modo a partir do que os outros dizem seria escrever o perfil dos outros.
import { db } from '../src/core/db.mjs'

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d }
const N = +arg('--n', 40)
const TIPO = process.argv[2] || 'explicito'

const FILTROS = {
  explicito: /\b(tesão|tesao|gozar|gozei|pelad|nud|buceta|pau|pica|rola|foder|fode|transar|transa|trepar|chupar|chupa|gemid|punheta|sexo|safad|delícia|delicia|molhad|duro|meter|meti|boquete|oral|camisinha|quero você|quero vc|te quero)\b/i,
  afeto: /\b(amor|amo|te amo|saudade|sdd|beijo|carinho|meu bem|vida|neném|nenem|paixão|apaixonad)\b/i,
  desejo: /\b(vontade de|queria|quero|to a fim|tô a fim|imagina|pensando em)\b/i,
  iniciativa: /^(oi|oii+|bom dia|boa noite|acordei|to acordada|tô acordada|sonhei|lembrei|saudade)/i,
}
const re = FILTROS[TIPO]
if (!re) { console.error('tipo: ' + Object.keys(FILTROS).join('|')); process.exit(1) }

const m = db().prepare(`
  SELECT person_id, text, ts, direction, author FROM message
  WHERE channel='whatsapp' AND text IS NOT NULL AND length(trim(text))>0 ORDER BY ts
`).all()

const dela = m.filter((x) => x.direction === 'outgoing' && x.author !== 'ia' && re.test(x.text))

// distribuição por pessoa: mostra se é um comportamento com UMA pessoa ou um jeito dela
const porPessoa = new Map()
for (const x of dela) porPessoa.set(x.person_id, (porPessoa.get(x.person_id) || 0) + 1)

console.log(`### ${TIPO.toUpperCase()} — ${dela.length} mensagens dela, em ${porPessoa.size} conversas`)
console.log(`distribuição: ${JSON.stringify([...porPessoa.values()].sort((a, b) => b - a).slice(0, 10))}\n`)

// amostra espalhada no tempo e entre pessoas, não as N primeiras (que seriam todas da mesma semana)
const passo = Math.max(1, Math.floor(dela.length / N))
for (let i = 0; i < dela.length && i / passo < N; i += passo) {
  const x = dela[i]
  console.log(`  ${new Date(x.ts - 3 * 3600_000).toISOString().slice(5, 16).replace('T', ' ')} | ${x.text.replace(/\s+/g, ' ').slice(0, 200)}`)
}
