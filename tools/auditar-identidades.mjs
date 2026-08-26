#!/usr/bin/env node
// Auditoria de identidade: mede, no banco REAL, o quanto a "pessoa" está fragmentada e
// o que está guardado em id bruto quando deveria seguir a pessoa inteira.
// Só leitura — não altera nada.
import { db } from '../src/core/db.mjs'
import { canonicalPersonId, personAliases } from '../src/projects/store.mjs'

const d = db()
const linha = (t, v) => console.log(`${String(t).padEnd(52)} ${v}`)

console.log('\n=== TAMANHO DO PROBLEMA ===')
const idsComMensagem = d.prepare(`SELECT person_id, COUNT(*) n, GROUP_CONCAT(DISTINCT channel) canais FROM message GROUP BY person_id`).all()
linha('ids de pessoa com mensagem', idsComMensagem.length)
const porCanal = { tinder: 0, whatsapp: 0, instagram: 0, misto: 0 }
for (const r of idsComMensagem) {
  const c = (r.canais || '').split(',')
  if (c.length > 1) porCanal.misto++
  else porCanal[c[0]] = (porCanal[c[0]] || 0) + 1
}
linha('  só Tinder / só WhatsApp / só Instagram', `${porCanal.tinder} / ${porCanal.whatsapp} / ${porCanal.instagram}`)
linha('  ids que JÁ carregam mais de um canal (identity)', porCanal.misto)

const aliases = d.prepare(`SELECT * FROM person_alias`).all()
linha('linhas de person_alias (união lógica)', aliases.length)
const canonicos = new Set(aliases.map((a) => a.canonical_person_id))
linha('pessoas com pelo menos um alias', canonicos.size)

// Cadeia A->B->C: personAliases() só olha um nível, então cadeia esconde id da memória.
let cadeias = 0
for (const a of aliases) {
  const doCanonico = d.prepare(`SELECT 1 FROM person_alias WHERE alias_person_id=?`).get(a.canonical_person_id)
  if (doCanonico) cadeias++
}
linha('aliases em CADEIA (A->B->C, risco de sumir da memória)', cadeias)

console.log('\n=== O QUE ESTÁ GUARDADO EM ID BRUTO (deveria seguir a pessoa) ===')
const foraDoCanonico = (tabela, coluna) => {
  let total = 0, fora = 0
  try {
    for (const r of d.prepare(`SELECT DISTINCT ${coluna} id FROM ${tabela} WHERE ${coluna} IS NOT NULL`).all()) {
      total++
      if (canonicalPersonId(r.id) !== r.id) fora++
    }
  } catch { return 'tabela não existe' }
  return `${fora} de ${total} em id não-canônico`
}
linha('person_objective', foraDoCanonico('person_objective', 'person_id'))
linha('fato_assercao (ledger)', foraDoCanonico('fato_assercao', 'person_id'))
linha('pessoa_pref (propor encontro)', foraDoCanonico('pessoa_pref', 'person_id'))
linha('ai_setting (é POR CONVERSA de propósito)', foraDoCanonico('ai_setting', 'person_id'))
linha('project_person', foraDoCanonico('project_person', 'person_id'))

console.log('\n=== PESSOAS COM MAIS DE UMA CONVERSA (as que precisam de memória única) ===')
const mapa = new Map()
for (const r of idsComMensagem) {
  const c = canonicalPersonId(r.person_id)
  if (!mapa.has(c)) mapa.set(c, [])
  mapa.get(c).push({ id: r.person_id, n: r.n, canais: r.canais })
}
const multi = [...mapa.entries()].filter(([, v]) => v.length > 1)
linha('pessoas canônicas com 2+ conversas', multi.length)
for (const [c, v] of multi.slice(0, 12)) {
  const nome = d.prepare(`SELECT display_name FROM person WHERE person_id=?`).get(c)?.display_name
    || d.prepare(`SELECT name FROM wa_chat WHERE 'wa:'||jid=?`).get(c)?.name
    || d.prepare(`SELECT name FROM ig_chat WHERE 'ig:'||thread_id=?`).get(c)?.name || '?'
  console.log(`  ${String(nome).slice(0, 22).padEnd(24)} ${v.map((x) => `${x.canais}:${x.n}`).join(' + ')}`)
}

console.log('\n=== MENSAGENS QUE A IA LÊ POR PESSOA (as maiores) ===')
const maiores = [...mapa.entries()].map(([c, v]) => ({ c, total: v.reduce((a, b) => a + b.n, 0) })).sort((a, b) => b.total - a.total).slice(0, 8)
for (const m of maiores) {
  const nome = d.prepare(`SELECT display_name FROM person WHERE person_id=?`).get(m.c)?.display_name
    || d.prepare(`SELECT name FROM wa_chat WHERE 'wa:'||jid=?`).get(m.c)?.name || '?'
  console.log(`  ${String(nome).slice(0, 22).padEnd(24)} ${m.total} mensagens`)
}
console.log('')
