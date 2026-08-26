// Chamar primeiro em canal novo — WhatsApp e Instagram (F7 do PLANO-IDENTIDADE-VINCULO.md).
//
// Ela passou o contato no Tinder; o vendas-multicanal abre a conversa no canal novo com uma primeira
// mensagem escrita pela IA, com a memória da conversa inteira (a IA continua o assunto em
// vez de se reapresentar). Decisão do dono em 24/07/2026: pode ser automático.
//
// Errar aqui é falar com a pessoa errada, então são TRÊS travas, todas verificadas aqui e
// não no prompt:
//   1. só vínculo confirmado (`confirmado_servidor` ou `confirmado_conversa`);
//   2. interruptor geral por canal (nasce desligado) E interruptor por pessoa;
//   3. uma vez por pessoa por canal, com comprovante — não repete nem depois de restart.
import {
  db, getSetting, setSetting, getReceipt, saveReceipt, identityRow, personDisplayName, logEvent,
  getWaChat, getIgChat, contatoNegado, getTinderPerfil, tinderMatchPorPessoa,
} from '../core/db.mjs'
import { generateDraft } from '../tinder/autoreply.mjs'
import { perfilDaPessoa } from '../tinder/perfil.mjs'
import { conferirVinculo } from './verificar.mjs'
import { prettyPhone } from '../wa/phone.mjs'
export { meuContatoNaRede, meuContatoEnviado } from './convites.mjs'

// Canais e a chave do interruptor geral de cada um.
export const CANAIS = {
  whatsapp: { receipt: 'wa-opener' },
  instagram: { receipt: 'ig-opener' },
}

// MODELO (refeito em 25/07/2026, correção do dono): o canal NÃO é uma escolha sua — é o que
// ELA passou. Ter um interruptor por canal fazia a coisa errada: se ela mandava só o
// Instagram e o Instagram estava desligado, não acontecia nada, em silêncio.
//
// São três perguntas, e cada uma tem um lugar:
//   1. CHAMAR?  um interruptor só: o vendas-multicanal pode abrir conversa em outra rede.
//   2. ONDE?    a lista de redes autorizadas — o vendas-multicanal usa a que ela passou, se estiver nela.
//   3. QUEM?    todo mundo que vier do Tinder, ou só quem você autorizar (por PESSOA, não
//               por canal — a autorização é da pessoa, como toda identidade aqui).
export function chamarLigado() {
  const novo = getSetting('chamar_auto', null)
  if (novo != null) return !!novo
  // herda o modelo antigo (um interruptor por canal): se qualquer um estava ligado, o
  // "chamar em outras redes" nasce ligado — a escolha que o dono já tinha feito não se perde.
  return !!getSetting('chamar_auto_whatsapp', false) || !!getSetting('chamar_auto_instagram', false)
}
export function setChamarLigado(valor) { setSetting('chamar_auto', !!valor); return true }

const REDES_PADRAO = ['whatsapp']
export function redesAutorizadas() {
  const r = getSetting('chamar_redes', null)
  if (Array.isArray(r)) return r
  // herda do modelo antigo: cada canal que estava ligado vira uma rede autorizada
  const herdadas = []
  if (getSetting('chamar_auto_whatsapp', false)) herdadas.push('whatsapp')
  if (getSetting('chamar_auto_instagram', false)) herdadas.push('instagram')
  return herdadas.length ? herdadas : REDES_PADRAO
}
export function redeAutorizada(canal) { return redesAutorizadas().includes(canal) }
export function setRedeAutorizada(canal, valor) {
  if (!CANAIS[canal]) return false
  const atual = new Set(redesAutorizadas())
  if (valor) atual.add(canal); else atual.delete(canal)
  setSetting('chamar_redes', [...atual])
  return [...atual]
}

// Compatibilidade: chamadas antigas com (canal) continuam funcionando e agora significam
// "o chamar está ligado E essa rede está autorizada".
export function chamarAutoLigado(canal) { return canal ? (chamarLigado() && redeAutorizada(canal)) : chamarLigado() }

// Pessoas autorizadas: UMA lista, da pessoa — não por canal. Se você autorizou a Fulana, o
// vendas-multicanal chama onde ela passou contato, seja WhatsApp ou Instagram.
export function pessoasAutorizadas() {
  const nova = getSetting('chamar_auto_pessoas', null)
  if (Array.isArray(nova)) return nova
  // migração das listas antigas (uma por canal), sem perder quem já estava autorizado
  const antigas = [...(getSetting('chamar_auto_pessoas_whatsapp', []) || []), ...(getSetting('chamar_auto_pessoas_instagram', []) || [])]
  return [...new Set(antigas)]
}
export function autorizarPessoa(personId, valor) {
  const atual = new Set(pessoasAutorizadas())
  if (valor) atual.add(personId); else atual.delete(personId)
  setSetting('chamar_auto_pessoas', [...atual])
  return [...atual]
}

// Já chamamos essa pessoa neste canal? O comprovante é a trava que sobrevive a restart.
export function jaChamou(accountKey, canal, alvo) {
  const r = getReceipt(accountKey, CANAIS[canal].receipt, alvo)
  // 'sem_confirmacao' também conta: a mensagem PODE ter saído. Repetir sozinho arriscaria
  // mandar duas vezes pra mesma pessoa — quem decide reenviar é o dono, pelo painel.
  return !!r && ['sending', 'sent', 'uncertain', 'entregue', 'no_servidor', 'sem_confirmacao'].includes(r.state)
}

// Quem está pronto pra ser chamado no WhatsApp: pessoa do Tinder, com vínculo confirmado,
// sem NENHUMA mensagem trocada no WhatsApp ainda, e que ainda não foi chamada.
export function candidatosWhatsapp(accountKey, { limite = 20 } = {}) {
  const linhas = db().prepare(`SELECT i.channel_id AS jid, i.person_id, i.link_state, tm.name
    FROM identity i
    JOIN tinder_match tm ON tm.person_id=i.person_id AND tm.account_key=i.account_key
    WHERE i.account_key=? AND i.channel='whatsapp'
      AND COALESCE(i.link_state,'') IN ('confirmado_servidor','confirmado_conversa')
      AND NOT EXISTS (SELECT 1 FROM message m WHERE m.person_id=i.person_id AND m.channel='whatsapp')
    ORDER BY i.linked_at DESC LIMIT ?`).all(accountKey, limite)
  return linhas.filter((l) => !jaChamou(accountKey, 'whatsapp', l.jid) && !contatoNegado(l.jid))
}

// Quem está pronto pra ser chamado no Instagram: hint de @ resolvido numa thread que ainda
// não tem NENHUMA mensagem nossa, ou @ colhido sem thread (aí a conversa nasce agora).
export function candidatosInstagram(accountKey, { limite = 20 } = {}) {
  const linhas = db().prepare(`SELECT h.person_id, h.normalized AS username, h.quote
    FROM contact_hint h
    WHERE h.account_key=? AND h.kind='instagram' AND h.status IN ('novo','resolvido')
      AND h.confidence >= 0.9
    ORDER BY h.created_at DESC LIMIT ?`).all(accountKey, limite)
  const out = []
  for (const l of linhas) {
    if (jaChamou(accountKey, 'instagram', l.username) || contatoNegado(l.username)) continue
    // se já existe conversa com esse @ e ela já tem mensagem nossa, não é "primeira vez"
    const thread = db().prepare(`SELECT thread_id FROM ig_chat WHERE account_key=? AND lower(username)=?`).get(accountKey, l.username)
    if (thread) {
      const jaFalamos = db().prepare(`SELECT 1 FROM message WHERE person_id=? AND channel='instagram' AND direction='outgoing' LIMIT 1`).get('ig:' + thread.thread_id)
      if (jaFalamos) continue
    }
    out.push({ ...l, threadId: thread?.thread_id || null })
  }
  return out
}

// Motivo pelo qual NÃO pode chamar automaticamente (null = pode). Explícito de propósito:
// é o que a UI mostra e o que o log registra.
// Terceiro modo: autorizar SOZINHO quem vier do Tinder, sem você marcar pessoa por pessoa.
// Nasce desligado. Com ele ligado, a autorização individual deixa de ser exigida — as outras
// travas continuam todas (vínculo conferido, número que confere, uma vez por pessoa).
export function autorizaSozinho() {
  const novo = getSetting('chamar_auto_todos', null)
  if (novo != null) return !!novo
  return !!getSetting('chamar_auto_todos_whatsapp', false) || !!getSetting('chamar_auto_todos_instagram', false)
}
export function setAutorizaSozinho(valor) { setSetting('chamar_auto_todos', !!valor); return true }

export function bloqueioParaChamar(accountKey, canal, { personId, alvo }) {
  if (!CANAIS[canal]) return 'canal desconhecido'
  if (!chamarLigado()) return 'chamar em outras redes está desligado'
  if (!redeAutorizada(canal)) return `${canal === 'instagram' ? 'o Instagram' : 'o WhatsApp'} não está nas redes autorizadas`
  if (!autorizaSozinho() && !pessoasAutorizadas().includes(personId)) return 'pessoa não autorizada'
  if (jaChamou(accountKey, canal, alvo)) return 'já chamada neste canal'
  if (contatoNegado(alvo)) return 'contato marcado como errado'
  if (canal === 'whatsapp') {
    const row = identityRow(accountKey, 'whatsapp', alvo)
    if (!row) return 'sem vínculo'
    if (!['confirmado_servidor', 'confirmado_conversa'].includes(row.link_state || '')) return `vínculo em estado "${row.link_state || 'indefinido'}"`
    // TRAVA FINAL, checada na hora do envio: o número pra onde a mensagem vai é mesmo o que
    // ela escreveu? Não conferindo, a mensagem iria pra um estranho. Não depende de nenhuma
    // reconciliação ter rodado antes — é conferido aqui, sempre (o dono, 25/07/2026).
    const conf = conferirVinculo(accountKey, personId, alvo)
    if (!conf.ok) return `o vínculo aponta pra outro número (ela escreveu ${prettyPhone(conf.escrito)}, o vínculo vai pra ${prettyPhone(conf.alvo)})`
  }
  return null
}

// Gera a primeira mensagem pro canal novo. Usa o MESMO cérebro (memória unificada), então
// ela continua o assunto do Tinder em vez de se apresentar do zero. `mode:'reply'` é
// proposital: existe histórico (o do Tinder), não é uma abertura no escuro.
export async function gerarPrimeiraMensagem({ accountKey = 'main', personId, nome, canal, alvo }) {
  const chatMode = canal === 'whatsapp'
    ? (getWaChat(accountKey, alvo)?.mode || null)
    : (getIgChat(accountKey, alvo)?.mode || null)
  // O perfil DELA no Tinder vai junto: esta mensagem é a continuação da conversa de lá com
  // a MESMA pessoa, e é exatamente o momento em que a IA precisa ter assunto. Só vale aqui
  // (ponte de um match) — a resposta comum de WhatsApp não recebe perfil de Tinder, que
  // seria estranho numa conversa com sócio ou família.
  const profile = perfilDaPessoa(accountKey, personId, { tinderMatchPorPessoa, getTinderPerfil })
  return generateDraft({
    personId,
    name: nome || personDisplayName(personId),
    channel: canal,
    chatMode,
    profile,
    mode: 'reply',
    usageOrigin: 'chamada_outra_rede',
    usageTrigger: 'funcao_autorizada',
  })
}

// Registra o comprovante do chamado (antes e depois do envio), pra nunca repetir.
export function marcarChamada(accountKey, canal, alvo, estado, { textFp, providerMsgId, commandId } = {}) {
  saveReceipt({ accountKey, channel: CANAIS[canal].receipt, targetId: alvo, commandId: commandId || 'chamar:' + alvo,
    textFp: textFp || null, state: estado, providerMsgId: providerMsgId || null })
  logEvent({ type: 'chamada_' + estado, channel: canal, detail: alvo })
}
