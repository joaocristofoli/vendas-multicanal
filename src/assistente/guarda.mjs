// AS TRAVAS. Este arquivo existe por um motivo só: o chat do dono com o vendas-multicanal e o chat do
// vendas-multicanal com as outras pessoas NUNCA podem se tocar.
//
// O risco concreto (não é teórico): no self-chat do WhatsApp toda mensagem é fromMe e a
// conversa vira uma pessoa comum no banco (`wa:{meu jid}`). Sem trava, três coisas ruins
// acontecem sozinhas:
//   1. o cérebro que escreve COMO o dono começaria a paquerar o próprio o dono;
//   2. a resposta do assistente (que sai da MINHA conta) voltaria como mensagem nova e
//      viraria um comando — eco infinito;
//   3. as varreduras que leem conversas (compromissos, iniciativa, vínculos) achariam
//      "conversas" que na verdade são comandos de operação.
//
// A defesa é de código, não de convenção: quem pergunta "essa pessoa é o próprio o dono?"
// pergunta aqui, e a resposta não depende de ninguém lembrar de filtrar.
import { getWaSession, getWaChat } from '../core/db.mjs'
import { normalizeJid } from '../wa/jid.mjs'
import { mesmoContato } from '../wa/identity.mjs'

// jid do próprio o dono (sem sufixo de device). Fonte: a sessão do WhatsApp conectada.
export function selfJidDaConta(accountKey = 'main') {
  const raw = getWaSession(accountKey)?.jid || null
  return raw ? normalizeJid(raw) : null
}

// Este jid é o meu próprio? Três caminhos, e o terceiro é o que importa nesta conta:
//   1. jid igual ao da sessão;
//   2. mesmos dígitos de número (cobre sufixo de device, ':9@s.whatsapp.net');
//   3. **@lid**: nesta conta o WhatsApp entrega a minha conversa comigo mesmo como
//      `333444555666777@lid`, e os dígitos do LID não têm NADA a ver com o número. Sem
//      resolver o LID, a trava não reconhecia o próprio o dono e o assistente ficava mudo
//      no self-chat (foi exatamente o que aconteceu na primeira mensagem real dele).
//      O mapa lid->pn já é mantido pelo vendas-multicanal (wa_identity + coluna pn do wa_chat).
export function ehSelfJid(accountKey, jid) {
  const meu = selfJidDaConta(accountKey)
  if (!meu || !jid) return false
  const a = normalizeJid(jid)
  if (!a) return false
  if (a === meu) return true
  // mesmoContato é a resposta ÚNICA do projeto pra "esses dois jids são a mesma pessoa?".
  // Ele resolve o @lid pelo mapa e devolve false quando não sabe — nunca chuta. Qualquer
  // comparação por número feita aqui à mão volta a ficar cega no sistema LID.
  return mesmoContato(a, meu, { chatA: getWaChat(accountKey, a) })
}

// Esta pessoa do banco é o próprio o dono? Cobre o personId sintético `wa:{jid}` que o
// cliente de WhatsApp cria pra qualquer conversa 1:1, inclusive a minha comigo mesmo.
export function ehSelfPerson(accountKey, personId) {
  const pid = String(personId || '')
  if (!pid.startsWith('wa:')) return false
  return ehSelfJid(accountKey, pid.slice(3))
}

// Açúcar pra quem só tem o jid da conversa em mãos (listas, ticks de varredura).
export function ignorarConversa(accountKey, jid) { return ehSelfJid(accountKey, jid) }
