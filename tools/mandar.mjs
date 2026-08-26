#!/usr/bin/env node
// `node tools/mandar.mjs --pessoa "Nome ou número" --canal whatsapp --texto "oi"`
//
// Mandar mensagem DIRETO, sem confirmação, sem cadência, sem allowlist. É a ferramenta que
// responde à regra do sistema de 26/07/2026: se ele pede pra mandar uma mensagem pra testar,
// nada no sistema recusa caladinho.
//
// Por que uma ferramenta e não "o modelo chama uma ação": no modo códex o agente tem shell,
// e shell + comando determinístico é mais confiável que protocolo novo. Além disso este
// arquivo é testável sozinho e serve pro dono também, na mão.
//
// Por que passa pelo vendas-multicanal-core em vez de falar com o WhatsApp direto: o socket do Baileys
// vive DENTRO do processo do vendas-multicanal. Um segundo processo não tem esse socket — tentaria abrir
// outro pareamento e derrubaria o primeiro. Então a ferramenta fala com o núcleo por HTTP
// local, que é quem tem a mão no canal.
//
// O que ele NÃO faz: nada de laço, nada de lista. Uma mensagem, uma pessoa, um comprovante.
import { db } from '../src/core/db.mjs'
import { canonicalPersonId, personAliases } from '../src/projects/store.mjs'
import { resolverPessoa } from '../src/assistente/pessoas.mjs'
import { autenticar, PAINEL } from './painel.mjs'

const ACCOUNT = process.env.TIM_ACCOUNT || 'main'

function args() {
  const a = {}
  const v = process.argv.slice(2)
  for (let i = 0; i < v.length; i++) {
    if (!v[i].startsWith('--')) continue
    const k = v[i].slice(2)
    a[k] = (v[i + 1] && !v[i + 1].startsWith('--')) ? v[++i] : true
  }
  return a
}

const a = args()
if (!a.pessoa || !a.texto) {
  console.error(`uso: node tools/mandar.mjs --pessoa "<nome ou telefone>" --texto "<mensagem>" [--canal whatsapp|instagram|tinder|badoo] [--confirmar]

  --pessoa    nome, telefone em qualquer formato, ou o person_id cru
  --canal     padrão: o canal onde a pessoa tem conversa (whatsapp se houver)
  --confirmar sem isto, só MOSTRA quem é o alvo e não manda (evita mandar pra pessoa errada
              por causa de um nome ambíguo — o único cuidado que sobrou, e é sobre pontaria,
              não sobre permissão)`)
  process.exit(1)
}

// Quem é o alvo. Aceita person_id cru pra o caso do agente já ter resolvido antes.
//
// --confirmar autoriza o ENVIO, nunca a PONTARIA. Até 28/07/2026 ele pulava a checagem de
// homônimo e caía em `achados[0]` — a mesma armadilha do assistente: com dois contatos de teste homônimos, o
// recado do dono ia pro primeiro da ordem das tabelas, calado. Ambiguidade agora para
// sempre, com ou sem --confirmar, porque essa pergunta não é sobre permissão.
let pessoa
if (/^(wa:|ig:|b:|p:)/.test(String(a.pessoa))) {
  pessoa = { personId: String(a.pessoa), name: null }
} else {
  try {
    pessoa = resolverPessoa(ACCOUNT, String(a.pessoa))
  } catch (e) {
    if (e.name !== 'PessoaAmbigua') { console.error(e.message); process.exit(2) }
    console.error(`"${a.pessoa}" casa com ${e.candidatos.length} pessoas — diga qual (repita com o id no --pessoa):`)
    for (const p of e.candidatos) console.error(`  ${p.personId}  ${p.rotulo}`)
    process.exit(3)
  }
}

const pid = canonicalPersonId(pessoa.personId)
const ids = personAliases(pid)
const q = ids.map(() => '?').join(',')
const canais = db().prepare(`SELECT channel, COUNT(*) n, MAX(ts) ultima FROM message WHERE person_id IN (${q}) GROUP BY channel ORDER BY ultima DESC`).all(...ids)
const canal = String(a.canal || (canais.find((c) => c.channel === 'whatsapp') ? 'whatsapp' : (canais[0]?.channel || 'whatsapp')))

console.log(`alvo:  ${pessoa.name || pid}  (${pid})`)
console.log(`canal: ${canal}${canais.length ? `   [conversa existente: ${canais.map((c) => `${c.channel} ${c.n}`).join(', ')}]` : '   [sem conversa anterior]'}`)
console.log(`texto: ${a.texto}`)

if (!a.confirmar) {
  console.log('\n(nada foi enviado — repita com --confirmar)')
  process.exit(0)
}

// O envio. Rotas do próprio núcleo, as mesmas que o painel usa: elas mandam DIRETO, sem
// pedir confirmação nenhuma. A trava de confirmação vive só no catálogo do modo assistente.
async function enviar() {
  if (canal === 'whatsapp') {
    const jid = db().prepare(`SELECT channel_id FROM identity WHERE account_key=? AND channel='whatsapp' AND person_id IN (${q}) ORDER BY is_primary DESC LIMIT 1`).get(ACCOUNT, ...ids)?.channel_id
      || (String(pid).startsWith('wa:') ? String(pid).slice(3) : null)
    if (!jid) throw new Error('essa pessoa não tem WhatsApp vinculado (passe --canal outro, ou vincule antes)')
    return post('/api/wa/chat/send', { jid, text: a.texto })
  }
  if (canal === 'instagram') {
    const th = ids.find((i) => String(i).startsWith('ig:'))
    if (!th) throw new Error('essa pessoa não tem conversa de Instagram')
    return post('/api/ig/send', { threadId: String(th).slice(3), text: a.texto })
  }
  if (canal === 'badoo') {
    const b = ids.find((i) => String(i).startsWith('b:'))
    if (!b) throw new Error('essa pessoa não tem conversa de Badoo')
    return post('/api/badoo/enviar', { chatId: String(b).slice(2), texto: a.texto })
  }
  return post('/api/send', { personId: pid, text: a.texto })   // tinder
}

// A conversa com o núcleo (login + cookie) mora em tools/painel.mjs — mesma porta pra
// todas as ferramentas.
async function post(rota, corpo) {
  const cookie = await autenticar()
  const r = await fetch(PAINEL + rota, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(corpo),
  })
  const t = await r.text()
  let j = null; try { j = JSON.parse(t) } catch { /* texto cru */ }
  if (!r.ok || (j && j.ok === false)) throw new Error(`${rota} respondeu ${r.status}: ${(j && j.error) || t.slice(0, 200)}`)
  return j || t
}

try {
  const r = await enviar()
  console.log('\nENVIADO.', JSON.stringify(r).slice(0, 300))
  process.exit(0)
} catch (e) {
  console.error('\nNÃO SAIU:', e.message)
  console.error('(se for trava, rode `node tools/eu.mjs travas` — todas estão lá com a chave)')
  process.exit(4)
}
