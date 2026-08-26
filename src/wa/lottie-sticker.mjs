// EXPERIMENTO: enviar uma figurinha LOTTIE (a animada "de efeito grande") montada por nós.
// A Lottie é um ZIP (animation/animation.json [+ secondary] [+ .trust_token]). O envio é:
//   1. subir o ZIP como mídia de sticker (prepareWAMessageMedia) -> vira um stickerMessage
//   2. embrulhar em lottieStickerMessage { message: { stickerMessage } } (FutureProofMessage)
//   3. relayMessage (mensagem crua)
// O objetivo é descobrir, ao vivo, se o WhatsApp RENDERIZA uma Lottie sem o trust_token da Meta.
import { getBaileys } from './baileys.mjs'

export async function enviarLottie(sock, jid, zipBuffer, { mimetype = null } = {}) {
  const bl = await import('baileys')
  const { generateWAMessageFromContent } = await getBaileys()
  if (typeof bl.prepareWAMessageMedia !== 'function') throw new Error('prepareWAMessageMedia indisponível')
  // sobe o ZIP como mídia de sticker. isAnimated=true; o buffer é o zip da Lottie.
  const inner = await bl.prepareWAMessageMedia(
    { sticker: zipBuffer, isAnimated: true },
    { upload: sock.waUploadToServer, mediaTypeOverride: 'sticker' },
  )
  if (!inner || !inner.stickerMessage) throw new Error('upload não devolveu stickerMessage')
  // O FLAG QUE FALTAVA: isLottie=true diz ao WhatsApp "isto é Lottie, extraia o ZIP e anime o
  // vetor". Sem ele o app recebe como sticker comum e mostra "diferente" (não anima). isAnimated
  // também, e o mimetype do ZIP de Lottie.
  // Campos IDÊNTICOS ao de uma Lottie real (capturado do cache): sem casar isso o servidor
  // dropa (isLottie com mimetype image/webp é inconsistente e é filtrado). application/was +
  // isLottie + 512x512 é o que o WhatsApp espera.
  inner.stickerMessage.isAnimated = true
  inner.stickerMessage.isLottie = true
  inner.stickerMessage.mimetype = mimetype || 'application/was'
  inner.stickerMessage.height = 512
  inner.stickerMessage.width = 512
  const content = { lottieStickerMessage: { message: inner } }
  const full = generateWAMessageFromContent(jid, content, { userJid: sock.user && sock.user.id ? sock.user.id : undefined })
  await sock.relayMessage(jid, full.message, { messageId: full.key.id })
  return { providerMessageId: full.key.id }
}
