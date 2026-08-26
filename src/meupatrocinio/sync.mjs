// Sincroniza as conversas do Meu Patrocínio pro banco, e envia.
//
// person_id = 'mp:'+peer_id; as mensagens moram em `message` com channel='meupatrocinio', então
// memória unificada, vínculo entre redes e IA por pessoa funcionam de graça. O peer identifica
// a pessoa (leitura); o conversation_id, guardado à parte, é o que o envio usa.
import { addMessage, upsertPerson, upsertMpChat, getMpChat, logEvent } from '../core/db.mjs'
import {
  meuProfileId, listaDeConversas, mensagensDoPeer, peerDaConversa, normalizarMensagem,
  enviarMensagem as apiEnviar, avisarDigitando, perfisEmLote,
} from './api.mjs'

export const mpPersonId = (peerId) => 'mp:' + String(peerId)

// Sincroniza as conversas mais recentes. `paginas` limita quantas páginas da lista puxa (30
// conversas por página); `porConversa` as mensagens por conversa.
export async function syncMeuPatrocinio({ accountKey = 'main', paginas = 1, porConversa = 30 } = {}) {
  const meuId = await meuProfileId()
  if (!meuId) return { ok: false, motivo: 'não achei o profile_id (sessão caiu?)', conversas: 0, mensagens: 0 }

  let conversas = 0
  let mensagens = 0
  for (let p = 1; p <= paginas; p++) {
    const lista = await listaDeConversas(p)
    const linhas = (lista && lista.data) || []
    if (!linhas.length) break
    // Nomes das pessoas desta página, em UMA chamada (perfis em lote). Sem isso a conversa
    // aparece como "contato <id>" — foi a reclamação de usabilidade de 03/08.
    const peers = linhas.map((c) => peerDaConversa(c, meuId))
    const perfis = {}
    try {
      for (const pf of (await perfisEmLote(peers)) || []) {
        if (pf && pf.profile_id) perfis[String(pf.profile_id)] = pf
      }
    } catch { /* sem nome é degradação aceitável, não erro */ }

    for (const c of linhas) {
      const peer = peerDaConversa(c, meuId)
      const personId = mpPersonId(peer)
      const pf = perfis[String(peer)]
      const nome = pf ? [pf.username, pf.age ? `(${pf.age})` : null].filter(Boolean).join(' ') : null
      // A foto vem como photo_id, não URL — sem a URL montada não dá pra exibir, então fica
      // sem foto (o avatar de inicial do sistema cobre bem). Melhor isso que imagem quebrada.
      // guarda o peer E o conversation_id, separados — é o par que o envio precisa
      upsertMpChat({ accountKey, peerId: peer, conversationId: c.conversation_id, nome, lastTs: Date.now() })
      upsertPerson({ personId, accountKey, name: nome })
      conversas++

      const msgs = await mensagensDoPeer(peer, 1).catch(() => null)
      for (const raw of ((msgs && msgs.data) || []).slice(0, porConversa)) {
        const m = normalizarMensagem(raw, meuId)
        if (!m || !m.text) continue
        addMessage({
          messageId: 'mp:' + peer + ':' + m.id,           // id real: dedupe de graça
          accountKey, personId, channel: 'meupatrocinio',
          direction: m.direction, text: m.text, ts: m.ts,
          author: m.direction === 'outgoing' ? 'humano' : null,   // 'humano' = a dona (enum interno)
        })
        mensagens++
      }
    }
  }
  logEvent({ type: 'mp_sync', channel: 'meupatrocinio', detail: `${conversas} conversas, ${mensagens} mensagens vistas` })
  return { ok: true, conversas, mensagens }
}

// ENVIO. O destinatário é o CONVERSATION_ID, que a gente guardou junto do peer. Se não temos o
// conversation_id daquela pessoa, NÃO envia (em vez de chutar o peer e mandar pra numeração
// errada) — busca o conversation_id primeiro, na próxima sincronização.
export async function enviarMeuPatrocinio({ accountKey = 'main', peerId, texto, author = 'ia' }) {
  const chat = getMpChat(accountKey, peerId)
  if (!chat || !chat.conversation_id) throw new Error(`sem conversation_id pra ${peerId}: não mando sem o destinatário certo`)
  const personId = mpPersonId(peerId)
  await avisarDigitando(chat.conversation_id)
  const r = await apiEnviar({ conversationId: chat.conversation_id, texto })
  const ts = Date.now()
  addMessage({ messageId: 'mp:' + peerId + ':out:' + ts, accountKey, personId,
    channel: 'meupatrocinio', direction: 'outgoing', text: String(texto), ts, author })
  return { ok: true, messageId: r && r.message_id ? r.message_id : null }
}
