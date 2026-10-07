// Auto-resposta do Telegram: mesmo cérebro do Tinder/WhatsApp/Instagram/Badoo (Codex + modos
// + memória unificada). IA opt-in por conversa (ai_setting channel='telegram') — nasce
// desligada por pessoa, como manda a regra do projeto.
//
// Este canal é o mais simples dos cinco por um motivo: o envio recebe o destinatário como
// PARÂMETRO (chat_id na chamada MTProto). Não existe "conversa em foco" pra errar, não
// existe DOM pra mudar de layout, e a hora e o id da mensagem vêm do servidor.
import { aiEnabledPeople, getAiSetting, setAiSetting, getReceipt, saveReceipt, getTelegramChat, logEvent, setReplySchedule, soltarTentativa } from '../core/db.mjs'
import { pendingFingerprint } from '../bridge/bridge.mjs'
import { generateDraft, textFp } from '../tinder/autoreply.mjs'
import { registrarAssercao } from '../self/fatos.mjs'
import { avisoDeVinculo } from '../self/vinculos.mjs'
import { replyGate } from '../ai/cadence.mjs'
import { enviarTelegram, enviarFotoTelegram } from './sync.mjs'
import { MAX_BOLHAS } from '../ai/prompt.mjs'
import { splitDraftMidia } from '../wa/saved-image-ai.mjs'
import { savedImagePath } from '../wa/saved-image.mjs'
import { getSavedImageByShortcut, bumpSavedImageUsage, getSetting, db } from '../core/db.mjs'
import { registrarCobrancaEnviada } from '../self/pix.mjs'
import { etiquetaAbreFotoQuente } from '../self/etiquetas.mjs'

const chatIdOf = (personId) => (String(personId || '').startsWith('tg:') ? String(personId).slice(3) : null)

// Esta pessoa já recebeu ESTA foto aqui? Mesma trava dos outros canais, casando pelo arquivo.
function fotoJaEnviada(personId, file) {
  if (!file) return false
  return !!db().prepare(`SELECT 1 FROM message WHERE person_id=? AND channel='telegram' AND direction='outgoing'
    AND media_json LIKE '%"saved":true%' AND media_json LIKE ? LIMIT 1`).get(personId, `%${JSON.stringify(file).slice(1, -1)}%`)
}

// Entrega texto e foto na ORDEM em que a IA escreveu. As travas são as mesmas do WhatsApp e
// do Instagram, todas no código: interruptor, atalho inválido/travado, máximo 1, nunca repete.
//
// Aqui NÃO existe a trava de destinatário do Instagram, e não é esquecimento: o chatId é
// parâmetro da chamada, então não há "conversa em foco" pra conferir. O alvo não pode
// escorregar entre a decisão e o envio.
async function entregarSegmentos({ accountKey, personId, chatId, draft }) {
  const segs = splitDraftMidia(draft)
  let fotoSent = 0
  for (const seg of segs) {
    if (seg.kind === 'text') {
      for (const b of seg.text.split(/\n+/).map((x) => x.trim()).filter(Boolean).slice(0, MAX_BOLHAS)) {
        await enviarTelegram({ accountKey, chatId, texto: b, author: 'ia' })
      }
      continue
    }
    if (seg.kind !== 'foto') continue
    if (!getSetting('saved_image_ai', true)) { logEvent({ type: 'auto_foto_disabled', personId, channel: 'telegram', detail: `[foto:${seg.slug}] uso de fotos pela IA desligado` }); continue }
    const imagem = getSavedImageByShortcut(seg.slug, { permitirQuente: etiquetaAbreFotoQuente(personId) })
    if (!imagem) { logEvent({ type: 'auto_foto_bad_slug', personId, channel: 'telegram', detail: `[foto:${seg.slug}] inexistente, inativa ou travada` }); continue }
    if (fotoSent >= 1) { logEvent({ type: 'auto_foto_extra_dropped', personId, channel: 'telegram', detail: `[foto:${seg.slug}] máx 1 por resposta` }); continue }
    if (fotoJaEnviada(personId, imagem.file)) { logEvent({ type: 'auto_foto_repeat_dropped', personId, channel: 'telegram', detail: `[foto:${seg.slug}] já enviada pra essa pessoa` }); continue }
    await enviarFotoTelegram({ accountKey, chatId, arquivo: savedImagePath(imagem.file), author: 'ia', imagem })
    bumpSavedImageUsage(imagem.id)
    fotoSent++
    logEvent({ type: 'auto_sent_foto', personId, channel: 'telegram', detail: `[foto:${imagem.shortcut}]` })
  }
  return { fotoSent }
}

export async function telegramAutoReplyTick({ accountKey = 'main', sendEnabled = true, onSent } = {}) {
  let acted = 0
  for (const row of aiEnabledPeople('telegram')) {
    const personId = row.person_id
    const chatId = chatIdOf(personId)
    if (!chatId) continue
    try {
      const fp = pendingFingerprint(personId)
      if (!fp) continue                                   // a última foi nossa: nada pendente
      const st = getAiSetting(personId, 'telegram')
      if (st && st.last_attempted_fp === fp) continue     // já tratei essa pendência
      if (replyGate({ personId, channel: 'telegram', fp }) !== 'send') continue  // cadência humana

      const chat = getTelegramChat(accountKey, chatId)
      const meta = {}
      setAiSetting({ personId, channel: 'telegram', enabled: true, state: 'generating', lastAttemptedFp: fp })
      const aviso = avisoDeVinculo(personId)
      if (aviso) logEvent({ type: 'auto_aviso_vinculo', personId, channel: 'telegram', detail: aviso })

      const draft = await generateDraft({ personId, name: chat?.nome, channel: 'telegram', chatMode: chat?.mode || null, meta })
      const fpText = textFp(draft)
      const prev = getReceipt(accountKey, 'telegram', chatId)
      if (prev && prev.text_fp === fpText && ['sent', 'sending', 'uncertain'].includes(prev.state)) {
        logEvent({ type: 'auto_skip_dup', personId, channel: 'telegram', detail: draft }); continue
      }
      if (!sendEnabled) { logEvent({ type: 'auto_draft', personId, channel: 'telegram', detail: draft }); acted++; continue }

      saveReceipt({ accountKey, channel: 'telegram', targetId: chatId, commandId: fp, textFp: fpText, state: 'sending' })
      // Texto e foto na ordem que a IA escreveu (uma bolha por linha, como ela escreve).
      await entregarSegmentos({ accountKey, personId, chatId, draft })
      saveReceipt({ accountKey, channel: 'telegram', targetId: chatId, commandId: fp, textFp: fpText, state: 'sent' })

      setAiSetting({ personId, channel: 'telegram', enabled: true, state: 'idle', lastAttemptedFp: fp, lastSentFp: fpText })
      const eventoId = logEvent({ type: 'auto_sent', personId, channel: 'telegram', detail: draft })
      if (meta.cobranca) registrarCobrancaEnviada({ personId, channel: 'telegram', receiptKey: `event:${eventoId}`, tipo: meta.cobranca.tipo })
      registrarAssercao({ personId, channel: 'telegram', texto: draft, fatos: meta.fatos || [] })
      if (typeof onSent === 'function') { try { onSent(personId) } catch { /* ignora */ } }
      acted++
    } catch (e) {
      // ERRO PASSAGEIRO NÃO PODE VIRAR SILÊNCIO PERMANENTE: solta a tentativa pra que a
      // próxima volta tente de novo, em vez de a conversa morrer até a pessoa escrever.
      try { soltarTentativa(personId, 'telegram') } catch { /* melhor esforço */ }
      setAiSetting({ personId, channel: 'telegram', enabled: true, state: 'error' })
      logEvent({ type: 'auto_error', personId, channel: 'telegram', detail: String(e && e.message || e).slice(0, 200) })
    }
  }
  return acted
}
