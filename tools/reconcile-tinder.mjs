// Reconcilia o HISTÓRICO e a classificação do Tinder com o real. Inclui tanto
// conversas cujo preview não bate quanto matches ainda não verificados. Uma resposta
// vazia do endpoint é persistida como "sem conversa"; mensagens encontradas promovem o
// match para conversa iniciada. Idempotente.
// Rodar de /opt/vendas-multicanal/app: node tools/reconcile-tinder.mjs
import { tinderApi, getMe } from '../src/tinder/session.mjs'
import { db } from '../src/core/db.mjs'
import { syncTinderMatchHistory } from '../src/tinder/sync.mjs'

db()
const me = getMe()
const myId = me?.id
if (!myId) { console.log('sem tinder_me (rode checkSession antes)'); process.exit(1) }

const matches = db().prepare(`SELECT tm.account_key,tm.match_id,tm.person_id,tm.name,tm.last_text,tm.history_checked_at,
    (SELECT text FROM message WHERE person_id=tm.person_id AND channel='tinder' ORDER BY ts DESC LIMIT 1) AS stored_last
  FROM tinder_match tm
  WHERE tm.active=1 AND (COALESCE(tm.history_checked_at,0)=0
     OR COALESCE(tm.last_text,'')<>COALESCE((SELECT text FROM message WHERE person_id=tm.person_id AND channel='tinder' ORDER BY ts DESC LIMIT 1),'')
  )
  ORDER BY tm.last_ts DESC`).all()
const api = tinderApi()
let checked = 0, conversations = 0, unmessaged = 0, errors = 0

for (const m of matches) {
  try {
    const result = await syncTinderMatchHistory(api, m.account_key, myId, m)
    checked++
    if (result.messageCount) {
      conversations++
      console.log(`  conversa  ${m.name}  | ${result.messageCount} mensagem${result.messageCount === 1 ? '' : 's'}`)
    } else {
      unmessaged++
      console.log(`  sem 1ª   ${m.name}`)
    }
    await new Promise((r) => setTimeout(r, 250))
  } catch (e) {
    errors++
    console.log(`  ERRO ${m.name}: ${e.message}`)
  }
}
console.log(`\nchecados: ${checked} | conversas encontradas: ${conversations} | sem primeira mensagem: ${unmessaged} | erros: ${errors}`)
process.exit(0)
