#!/usr/bin/env node
// Limpeza única (24/07/2026): desfaz os vínculos criados pela primeira versão do resolvedor
// quando o número era de TERCEIRO — alguém repassou um contato dentro de uma conversa de
// WhatsApp ("Fornecedor- Marcio, contato- 11 99999-0023") e a conversa foi vinculada ao
// WhatsApp do terceiro. A regra nova (resolve.mjs) já não deixa isso acontecer.
//
// Critério do que é errado: vínculo `deterministic` cujo dono é uma conversa avulsa
// (`wa:...`) e que aponta pra OUTRO jid que não o dela mesma. Vínculo de pessoa do Tinder,
// manual, ou auto-vínculo (conversa apontando pra si) fica intocado.
//
// Uso: node tools/limpar-vinculos-terceiros.mjs [--aplicar]
//      (sem --aplicar, só mostra o que faria)
import Database from 'better-sqlite3'

const aplicar = process.argv.includes('--aplicar')
const dbPath = process.env.TIM_DB_PATH || '/opt/vendas-multicanal/data/vendas-multicanal.db'
const db = new Database(dbPath)

// Mesmo critério da regra nova em resolve.mjs: vínculo automático só é legítimo quando o
// dono é uma pessoa do Tinder (ela passou o próprio contato) ou é a própria conversa.
const suspeitos = db.prepare(`SELECT i.*, h.quote
  FROM identity i LEFT JOIN contact_hint h ON h.id = i.evidence_hint_id
  WHERE i.channel='whatsapp' AND i.link_method='deterministic'
    AND i.person_id != 'wa:'||i.channel_id
    AND NOT EXISTS (SELECT 1 FROM tinder_match tm WHERE tm.person_id = i.person_id)`).all()

console.log(`banco: ${dbPath}`)
console.log(`${suspeitos.length} vínculo(s) de terceiro pra desfazer${aplicar ? '' : ' (simulação — use --aplicar)'}\n`)
for (const s of suspeitos) {
  const frase = String(s.quote || '').replace(/\s+/g, ' ').slice(0, 70)
  console.log(`  ${s.person_id.slice(0, 26).padEnd(27)} -> ${s.channel_id.padEnd(22)} "${frase}"`)
}

if (!aplicar) { console.log('\nNada mudou.'); process.exit(0) }

const apagar = db.prepare(`DELETE FROM identity WHERE account_key=? AND channel='whatsapp' AND channel_id=?`)
// o hint volta pra fila: a regra nova vai mandá-lo pra revisão em vez de vincular
const reabrir = db.prepare(`UPDATE contact_hint SET status='novo', resolved_at=NULL WHERE id=?`)
let n = 0
db.transaction(() => {
  for (const s of suspeitos) {
    apagar.run(s.account_key, s.channel_id)
    if (s.evidence_hint_id) reabrir.run(s.evidence_hint_id)
    n++
  }
})()
console.log(`\n${n} vínculo(s) desfeito(s). As mensagens não foram tocadas (elas nunca chegaram a mudar de pessoa: a conversa do terceiro seguiu indexada em 'wa:'+jid dela).`)
