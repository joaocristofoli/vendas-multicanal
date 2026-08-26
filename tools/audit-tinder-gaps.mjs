// Audita o histórico do Tinder contra a API: para cada conversa ativa, baixa o que o
// Tinder tem e compara com as bolhas do banco. Reporta mensagens FALTANDO (buraco) e
// bolhas do banco sem correspondência na janela coberta pela API (sobra).
//
//   node tools/audit-tinder-gaps.mjs           -> só relatório (não escreve nada)
//   node tools/audit-tinder-gaps.mjs --fix     -> insere as faltantes (idempotente)
//   node tools/audit-tinder-gaps.mjs --limit=5 -> audita só as N conversas mais recentes
//
// Roda de /opt/vendas-multicanal/app.
import { tinderApi, getMe } from '../src/tinder/session.mjs'
import { db, addTinderMessage, updateTinderHistoryState } from '../src/core/db.mjs'

const FIX = process.argv.includes('--fix')
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 0)

db()
const me = getMe()
const myId = me?.id
if (!myId) { console.log('sem tinder_me (rode checkSession antes)'); process.exit(1) }

// Mesma mensagem? O id da API é uuid ("019f9634-1ed0-<hex24>"); o caminho legado gravava
// só a cauda hex. Um id sendo sufixo do outro é a MESMA mensagem.
function sameId(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  return a.endsWith(b) || b.endsWith(a)
}

const rows = db().prepare(`SELECT account_key,match_id,person_id,name,last_text
  FROM tinder_match WHERE active=1 AND has_conversation=1 ORDER BY last_ts DESC`).all()
const targets = LIMIT ? rows.slice(0, LIMIT) : rows
const api = tinderApi()

let convChecked = 0, convWithGap = 0, missingTotal = 0, insertedTotal = 0, errors = 0
const report = []

for (const m of targets) {
  let apiMsgs
  try {
    apiMsgs = await api.messages(m.match_id, 100)
  } catch (e) {
    // 404 = canal não existe mais (unmatch/conta apagada). Não é buraco de histórico.
    if (/status 404/.test(e.message)) { console.log(`  sem canal ${m.name} (unmatch)`); continue }
    errors++
    console.log(`  ERRO ${m.name}: ${e.message}`)
    continue
  }
  convChecked++
  if (!apiMsgs.length) { await new Promise((r) => setTimeout(r, 220)); continue }

  const oldest = Math.min(...apiMsgs.map((x) => new Date(x.sent_date).getTime()))
  const stored = db().prepare(`SELECT message_id,direction,text,ts FROM message
    WHERE person_id=? AND channel='tinder' AND ts>=? ORDER BY ts ASC`).all(m.person_id, oldest - 60000)

  const used = new Set()
  const missing = []
  for (const msg of apiMsgs) {
    const dir = msg.from === myId ? 'outgoing' : 'incoming'
    const ts = new Date(msg.sent_date).getTime()
    const hit = stored.find((s, i) => !used.has(i) && (
      sameId(s.message_id, msg._id) ||
      (s.direction === dir && s.text === msg.message && Math.abs(s.ts - ts) < 600000)
    ))
    if (hit) { used.add(stored.indexOf(hit)); continue }
    missing.push({ msg, dir, ts })
  }

  if (missing.length) {
    convWithGap++
    missingTotal += missing.length
    report.push({ name: m.name, personId: m.person_id, missing: missing.map((x) => `${new Date(x.ts).toISOString().slice(11, 19)} ${x.dir === 'outgoing' ? 'eu ' : 'ela'}: ${String(x.msg.message).slice(0, 60)}`) })
    console.log(`  BURACO  ${m.name} (${missing.length})`)
    for (const x of missing) console.log(`      ${new Date(x.ts).toISOString().slice(0, 19)} ${x.dir === 'outgoing' ? 'eu ' : 'ela'}: ${JSON.stringify(String(x.msg.message).slice(0, 70))}`)
    if (FIX) {
      for (const { msg, dir, ts } of missing) {
        if (addTinderMessage({ messageId: msg._id, accountKey: m.account_key, personId: m.person_id, direction: dir, text: msg.message, ts })) insertedTotal++
      }
      // realinha o cabeçalho da conversa com a última mensagem real
      const last = apiMsgs[apiMsgs.length - 1]
      const lastDir = last.from === myId ? 'eu' : 'ela'
      updateTinderHistoryState({
        accountKey: m.account_key,
        matchId: m.match_id,
        hasConversation: true,
        pending: lastDir === 'ela',
        lastDir,
        lastText: last.message,
        lastTs: new Date(last.sent_date).getTime(),
        historyCheckedAt: Date.now(),
      })
    }
  }
  await new Promise((r) => setTimeout(r, 220))
}

console.log(`\nconversas auditadas: ${convChecked} | com buraco: ${convWithGap} | mensagens faltando: ${missingTotal}` +
  (FIX ? ` | inseridas: ${insertedTotal}` : ' | (dry-run, nada escrito)') + ` | erros: ${errors}`)
process.exit(0)
