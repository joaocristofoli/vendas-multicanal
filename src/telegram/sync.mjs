// Leitura das DMs do Telegram — pelo DADO (MTProto), nunca por tela.
//
// Diferente do Instagram, aqui não existe DOM nem composer: a API entrega id de mensagem,
// hora real, quem escreveu e o tipo, e o envio recebe o destinatário como PARÂMETRO. É o
// mesmo tipo de caminho do Baileys no WhatsApp, e é por isso que este canal nasce sem a
// classe de erro que fez foto ir pra pessoa errada no Instagram.
//
// SÓ CONVERSA DE UMA PESSOA. Grupo, canal e bot ficam de fora: o vendas-multicanal é sobre conversas
// individuais, e um grupo entrando na tabela message viraria a IA "respondendo" num lugar
// onde ela não deve existir.
import { Api } from 'teleproto'
import { addMessage, upsertPerson, upsertTelegramChat, logEvent } from '../core/db.mjs'
import { conectar } from './session.mjs'
import { ehVideoSalvo, tipoDaMidiaSalva } from '../wa/saved-image.mjs'

export const tgPersonId = (chatId) => 'tg:' + String(chatId)

// O texto de uma mensagem, com marcador honesto pro que não é texto. Nunca inventa conteúdo:
// se é foto, o histórico diz [foto] — e não uma descrição imaginada.
function textoDaMensagem(m) {
  if (m.message) return String(m.message)
  if (m.media) {
    const t = m.media.className || ''
    if (/Photo/i.test(t)) return '[foto]'
    if (/Document/i.test(t)) return '[arquivo]'
    if (/Voice|Audio/i.test(t)) return '[áudio]'
    if (/Video/i.test(t)) return '[vídeo]'
    if (/Sticker/i.test(t)) return '[figurinha]'
    return '[mídia]'
  }
  return ''
}

// Sincroniza as conversas individuais mais recentes. `limite` de conversas, `porConversa` de
// mensagens. Idempotente: addMessage dedupa por messageId.
export async function syncTelegram({ accountKey = 'main', limite = 30, porConversa = 40 } = {}) {
  const c = await conectar()
  if (!c) return { ok: false, motivo: 'telegram não conectado', conversas: 0, mensagens: 0 }

  const eu = await c.getMe()
  const meuId = String(eu?.id || '')
  let conversas = 0
  let mensagens = 0

  const dialogs = await c.getDialogs({ limit: limite })
  for (const d of dialogs) {
    // só pessoa: nada de grupo, canal ou bot
    if (!d.isUser || d.entity?.bot) continue
    const chatId = String(d.entity?.id || d.id || '')
    if (!chatId || chatId === meuId) continue

    const nome = [d.entity?.firstName, d.entity?.lastName].filter(Boolean).join(' ').trim() || d.title || null
    const personId = tgPersonId(chatId)
    upsertPerson({ personId, accountKey, name: nome })
    upsertTelegramChat({ accountKey, chatId, nome, username: d.entity?.username || null,
      telefone: d.entity?.phone || null, previa: d.message?.message || null,
      lastTs: (d.message?.date || 0) * 1000, unread: d.unreadCount || 0 })
    conversas++

    const msgs = await c.getMessages(d.entity, { limit: porConversa })
    for (const m of msgs) {
      const texto = textoDaMensagem(m)
      if (!texto) continue
      addMessage({
        messageId: 'tg:' + chatId + ':' + m.id,          // id REAL do Telegram: dedupe de graça
        accountKey, personId, channel: 'telegram',
        direction: m.out ? 'outgoing' : 'incoming',
        text: texto,
        ts: (m.date || 0) * 1000,
        author: m.out ? 'humano' : null,                   // 'humano' = a dona (enum interno, ver core/autoria.mjs)
      })
      mensagens++
    }
  }
  logEvent({ type: 'tg_sync', channel: 'telegram', detail: `${conversas} conversas, ${mensagens} mensagens vistas` })
  return { ok: true, conversas, mensagens }
}

// ENVIO COM DESTINATÁRIO EXPLÍCITO. O chat_id é parâmetro da chamada — não existe "conversa
// em foco" aqui, que é a armadilha do composer do Instagram.
export async function enviarTelegram({ accountKey = 'main', chatId, texto, author = 'ia' }) {
  const c = await conectar()
  if (!c) throw new Error('telegram não conectado')
  const limpo = String(texto || '').trim()
  if (!limpo) throw new Error('texto vazio')
  const enviada = await c.sendMessage(String(chatId), { message: limpo })
  const ts = Date.now()
  addMessage({ messageId: 'tg:' + chatId + ':' + (enviada?.id || ts), accountKey,
    personId: tgPersonId(chatId), channel: 'telegram', direction: 'outgoing', text: limpo, ts, author })
  return { ok: true, messageId: enviada?.id || null }
}

// ENVIO DE FOTO. Mesma propriedade do texto: o destinatário é PARÂMETRO (chatId), então não
// existe a armadilha do composer do Instagram, onde o alvo era a conversa em foco.
//
// `forcarDocumento: false` manda como FOTO (comprimida, como o app manda), não como arquivo —
// arquivo aparece como anexo e denuncia automação na hora.
//
// VÍDEO do banco (.mp4) sai pelo mesmo caminho, como vídeo tocável. As medidas e a duração vão
// declaradas (`imagem`, a linha do banco): sem elas a biblioteca manda 1×1 e 0 s, e o vídeo
// aparece como um quadradinho no aplicativo de quem recebe.
export async function enviarFotoTelegram({ accountKey = 'main', chatId, arquivo, legenda = null, author = 'ia', imagem = null }) {
  const c = await conectar()
  if (!c) throw new Error('telegram não conectado')
  if (!chatId) throw new Error('sem destinatário: chatId é obrigatório')
  if (!arquivo) throw new Error('sem arquivo')
  const video = ehVideoSalvo(arquivo)
  const enviada = await c.sendFile(String(chatId), {
    file: arquivo,
    caption: legenda ? String(legenda).slice(0, 900) : undefined,
    forceDocument: false,
    ...(video ? {
      supportsStreaming: true,
      attributes: [new Api.DocumentAttributeVideo({
        duration: Number(imagem?.duration_sec) || 0,
        w: Number(imagem?.width) || 1,
        h: Number(imagem?.height) || 1,
        supportsStreaming: true,
      })],
    } : {}),
  })
  const ts = Date.now()
  addMessage({ messageId: 'tg:' + chatId + ':' + (enviada?.id || ts), accountKey,
    personId: tgPersonId(chatId), channel: 'telegram', direction: 'outgoing', text: legenda || '',
    media: { kind: tipoDaMidiaSalva(arquivo), saved: true, file: arquivo.split('/').pop(), ...(imagem?.descricao ? { descricao: imagem.descricao } : {}), status: 'done' }, ts, author })
  return { ok: true, messageId: enviada?.id || null }
}
