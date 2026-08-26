// Auto-resposta do Meu Patrocínio: mesmo cérebro dos outros canais. IA opt-in por conversa
// (ai_setting channel='meupatrocinio'), nasce desligada por pessoa.
//
// O envio usa o conversation_id (guardado no mp_chat junto do peer). Sem ele, não manda —
// enviarMeuPatrocinio recusa em vez de chutar a numeração.
import { aiEnabledPeople, getAiSetting, setAiSetting, getReceipt, saveReceipt, getMpChat, logEvent, soltarTentativa } from '../core/db.mjs'
import { pendingFingerprint } from '../bridge/bridge.mjs'
import { generateDraft, textFp } from '../tinder/autoreply.mjs'
import { registrarAssercao } from '../self/fatos.mjs'
import { avisoDeVinculo } from '../self/vinculos.mjs'
import { replyGate } from '../ai/cadence.mjs'
import { enviarMeuPatrocinio } from './sync.mjs'
import { MAX_BOLHAS } from '../ai/prompt.mjs'
import { registrarCobrancaEnviada } from '../self/pix.mjs'

const peerIdOf = (personId) => (String(personId || '').startsWith('mp:') ? String(personId).slice(3) : null)

export async function meuPatrocinioAutoReplyTick({ accountKey = 'main', sendEnabled = true, onSent } = {}) {
  let acted = 0
  for (const row of aiEnabledPeople('meupatrocinio')) {
    const personId = row.person_id
    const peerId = peerIdOf(personId)
    if (!peerId) continue
    try {
      const fp = pendingFingerprint(personId)
      if (!fp) continue
      const st = getAiSetting(personId, 'meupatrocinio')
      if (st && st.last_attempted_fp === fp) continue
      if (replyGate({ personId, channel: 'meupatrocinio', fp }) !== 'send') continue

      const chat = getMpChat(accountKey, peerId)
      const meta = {}
      setAiSetting({ personId, channel: 'meupatrocinio', enabled: true, state: 'generating', lastAttemptedFp: fp })
      const aviso = avisoDeVinculo(personId)
      if (aviso) logEvent({ type: 'auto_aviso_vinculo', personId, channel: 'meupatrocinio', detail: aviso })

      const draft = await generateDraft({ personId, name: chat?.nome, channel: 'meupatrocinio', chatMode: chat?.mode || null, meta })
      const fpText = textFp(draft)
      const prev = getReceipt(accountKey, 'meupatrocinio', peerId)
      if (prev && prev.text_fp === fpText && ['sent', 'sending', 'uncertain'].includes(prev.state)) {
        logEvent({ type: 'auto_skip_dup', personId, channel: 'meupatrocinio', detail: draft }); continue
      }
      if (!sendEnabled) { logEvent({ type: 'auto_draft', personId, channel: 'meupatrocinio', detail: draft }); acted++; continue }

      saveReceipt({ accountKey, channel: 'meupatrocinio', targetId: peerId, commandId: fp, textFp: fpText, state: 'sending' })
      const bolhas = String(draft).split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, MAX_BOLHAS)
      for (const b of bolhas) await enviarMeuPatrocinio({ accountKey, peerId, texto: b, author: 'ia' })
      saveReceipt({ accountKey, channel: 'meupatrocinio', targetId: peerId, commandId: fp, textFp: fpText, state: 'sent' })

      setAiSetting({ personId, channel: 'meupatrocinio', enabled: true, state: 'idle', lastAttemptedFp: fp, lastSentFp: fpText })
      const eventoId = logEvent({ type: 'auto_sent', personId, channel: 'meupatrocinio', detail: draft })
      if (meta.cobranca) registrarCobrancaEnviada({ personId, channel: 'meupatrocinio', receiptKey: `event:${eventoId}`, tipo: meta.cobranca.tipo })
      registrarAssercao({ personId, channel: 'meupatrocinio', texto: draft, fatos: meta.fatos || [] })
      if (typeof onSent === 'function') { try { onSent(personId) } catch { /* ignora */ } }
      acted++
    } catch (e) {
      try { soltarTentativa(personId, 'meupatrocinio') } catch { /* melhor esforço */ }
      setAiSetting({ personId, channel: 'meupatrocinio', enabled: true, state: 'error' })
      logEvent({ type: 'auto_error', personId, channel: 'meupatrocinio', detail: String(e && e.message || e).slice(0, 200) })
    }
  }
  return acted
}
