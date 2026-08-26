#!/usr/bin/env node
// Sonda do Badoo: usa a sessão importada pra descobrir o que o HAR não mostrou — o formato
// do HISTÓRICO de uma conversa. Só LÊ; não manda nada, não marca nada como lido.
//
// Uso:
//   node tools/badoo-probe.mjs                 lista conversas e abre a primeira COM prévia
//   node tools/badoo-probe.mjs <chat_id>       abre uma conversa específica
//   node tools/badoo-probe.mjs --cru           despeja a resposta inteira (pra inspeção)
import { credenciais, checarSessao } from '../src/badoo/session.mjs'
import { listarConversas, abrirConversa } from '../src/badoo/api.mjs'

const args = process.argv.slice(2)
const cru = args.includes('--cru')
const alvo = args.find((a) => !a.startsWith('--'))

const s = await checarSessao()
if (!s.ok) { console.error('sessão do Badoo indisponível:', s.motivo); process.exit(2) }
const cred = credenciais()
console.log(`sessão ok — ${s.conversas} conversas na pasta Mensagens\n`)

const { pessoas } = await listarConversas({ ...cred, quantidade: 20 })
console.log('=== conversas (20 primeiras) ===')
for (const p of pessoas.slice(0, 20)) {
  console.log(` ${p.naoLida ? '•' : ' '} ${String(p.nome || '?').padEnd(18)} ${p.previa ? '"' + String(p.previa).slice(0, 40) + '"' : '(sem prévia)'}`)
}

const escolhida = alvo
  ? { id: alvo, nome: '(id passado na linha de comando)' }
  : pessoas.find((p) => p.previa) || pessoas[0]
if (!escolhida) { console.log('\nnenhuma conversa pra abrir'); process.exit(0) }

console.log(`\n=== abrindo a conversa de ${escolhida.nome} ===`)
const { chat, body } = await abrirConversa({ ...cred, chatId: escolhida.id })
console.log('tipos na resposta:', body.map((b) => b.message_type).join(', '))
if (!chat) { console.log('sem client_open_chat na resposta'); process.exit(0) }
console.log('chaves do chat:', Object.keys(chat).join(', '))

// A pergunta que esta sonda existe pra responder: onde ficam as mensagens?
const candidatos = ['chat_messages', 'messages', 'chat_message', 'message_list', 'history']
let achou = null
for (const c of candidatos) if (Array.isArray(chat[c])) { achou = c; break }
if (!achou) {
  // procura fundo: qualquer array cujos itens tenham 'mssg'
  const varrer = (o, caminho = '') => {
    if (!o || typeof o !== 'object') return null
    if (Array.isArray(o)) {
      if (o.length && o[0] && typeof o[0] === 'object' && ('mssg' in o[0] || 'message_type' in o[0] && 'from_person_id' in o[0])) return caminho
      for (const [i, v] of o.entries()) { const r = varrer(v, `${caminho}[${i}]`); if (r) return r }
      return null
    }
    for (const [k, v] of Object.entries(o)) { const r = varrer(v, caminho ? `${caminho}.${k}` : k); if (r) return r }
    return null
  }
  achou = varrer(chat) || varrer(body)
}

if (achou) {
  const arr = achou.split('.').reduce((o, k) => (o ? o[k.replace(/\[\d+\]/, '')] : null), chat) || []
  console.log(`\nMENSAGENS achadas em: ${achou} (${Array.isArray(arr) ? arr.length : '?'} itens)`)
  const lista = Array.isArray(arr) ? arr : []
  for (const m of lista.slice(-5)) {
    console.log('  ', JSON.stringify({
      de: String(m.from_person_id || '').slice(0, 12),
      texto: String(m.mssg || '').slice(0, 45),
      ts: m.date_modified || m.date || m.timestamp,
      tipo: m.message_type,
    }))
  }
  if (lista[0]) console.log('\ncampos de uma mensagem:', Object.keys(lista[0]).join(', '))
} else {
  console.log('\nNENHUMA mensagem no open_chat — o histórico vem por outra chamada.')
  console.log('Pistas na resposta pra investigar:')
  for (const k of Object.keys(chat)) {
    const v = chat[k]
    if (typeof v === 'string' && /comet|url|encrypted/i.test(k)) console.log('  ', k, '=', String(v).slice(0, 80))
  }
}

if (cru) console.log('\n=== resposta crua ===\n' + JSON.stringify(body, null, 1).slice(0, 6000))
