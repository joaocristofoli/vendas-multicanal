// Auto-resposta do Instagram: mesmo cérebro do Tinder/WhatsApp (Codex + modos + memória),
// mas envia pelo DOM (sendToThread). IA opt-in por conversa (ai_setting channel='instagram').
import { aiEnabledPeople, getAiSetting, setAiSetting, getReceipt, saveReceipt, getIgChat, logEvent, setReplySchedule, soltarTentativa,
  getSavedImageByShortcut, bumpSavedImageUsage, getSetting, addMessage, db } from '../core/db.mjs'
import { pendingFingerprint } from '../bridge/bridge.mjs'
import { generateDraft, textFp } from '../tinder/autoreply.mjs'
import { registrarAssercao } from '../self/fatos.mjs'
import { avisoDeVinculo } from '../self/vinculos.mjs'
import { replyGate } from '../ai/cadence.mjs'
import { refreshThread, sendToThread } from './sync.mjs'
import { splitDraftMidia } from '../wa/saved-image-ai.mjs'
import { savedImagePath } from '../wa/saved-image.mjs'
import { enviarFoto } from './enviar-foto.mjs'
import { igPage, igExclusive } from './browser.mjs'
import { registrarCobrancaEnviada } from '../self/pix.mjs'
import { concluirPedidoUnico, liberarPedidoUnico, fingerprintIniciativaCobranca } from '../necessidades/pedido-unico.mjs'
import { etiquetaAbreFotoQuente } from '../self/etiquetas.mjs'

function threadIdOf(personId) { return String(personId || '').startsWith('ig:') ? personId.slice(3) : null }

// Esta pessoa já recebeu ESTA foto no Instagram? Mesma trava do WhatsApp, casando pelo
// arquivo gravado no media_json. Repetir foto é constrangedor e a IA não lembra sozinha.
function fotoJaEnviada(personId, file) {
  if (!file) return false
  return !!db().prepare(`SELECT 1 FROM message WHERE person_id=? AND channel='instagram' AND direction='outgoing'
    AND media_json LIKE '%"saved":true%' AND media_json LIKE ? LIMIT 1`).get(personId, `%${JSON.stringify(file).slice(1, -1)}%`)
}

// Entrega um rascunho que pode intercalar TEXTO e FOTO, na ordem em que a IA escreveu.
//
// As travas são as mesmas do WhatsApp e moram no CÓDIGO, não no prompt: interruptor geral,
// atalho inexistente/inativo/travado, máximo 1 por resposta, nunca repete pra essa pessoa.
// A trava EXTRA daqui é o destinatário: `enviarFoto` confere na PÁGINA, duas vezes, que a
// conversa aberta é de quem a gente pensa que é (03/08/2026 — duas fotos foram parar com
// terceiros por confiar no cache). Se o `ig_chat` estiver errado, isso vira ABORTO, nunca
// entrega errada.
export async function entregarDraftNoInstagram({ accountKey, personId, threadId, draft, author = 'ia' }) {
  const segs = splitDraftMidia(draft)
  const temFoto = segs.some((x) => x.kind === 'foto')
  if (!temFoto) { await sendToThread({ accountKey, threadId, text: draft, author }); return { fotoSent: 0 } }

  const chat = getIgChat(accountKey, threadId)
  const paraArroba = chat && chat.username ? String(chat.username) : null
  let fotoSent = 0
  for (const seg of segs) {
    if (seg.kind === 'text') { await sendToThread({ accountKey, threadId, text: seg.text, author }); continue }
    if (seg.kind !== 'foto') continue
    if (!getSetting('saved_image_ai', true)) { logEvent({ type: 'auto_foto_disabled', personId, channel: 'instagram', detail: `[foto:${seg.slug}] uso de fotos pela IA desligado` }); continue }
    const imagem = getSavedImageByShortcut(seg.slug, { permitirQuente: etiquetaAbreFotoQuente(personId) })
    if (!imagem) { logEvent({ type: 'auto_foto_bad_slug', personId, channel: 'instagram', detail: `[foto:${seg.slug}] inexistente, inativa ou travada` }); continue }
    if (fotoSent >= 1) { logEvent({ type: 'auto_foto_extra_dropped', personId, channel: 'instagram', detail: `[foto:${seg.slug}] máx 1 por resposta` }); continue }
    if (fotoJaEnviada(personId, imagem.file)) { logEvent({ type: 'auto_foto_repeat_dropped', personId, channel: 'instagram', detail: `[foto:${seg.slug}] já enviada pra essa pessoa` }); continue }
    if (!paraArroba) { logEvent({ type: 'auto_foto_sem_alvo', personId, channel: 'instagram', detail: `[foto:${seg.slug}] não sei o @ desta conversa; não mando foto sem poder conferir o destinatário` }); continue }
    try {
      const r = await igExclusive(async () => enviarFoto(await igPage(), { threadId, paraArroba, arquivo: savedImagePath(imagem.file) }))
      const ts = Date.now()
      addMessage({ messageId: 'ig:' + threadId + ':foto:' + ts, accountKey, personId, channel: 'instagram', direction: 'outgoing', text: '',
        media: { kind: 'image', saved: true, file: imagem.file, descricao: imagem.descricao, status: 'done' }, ts, author })
      bumpSavedImageUsage(imagem.id)
      fotoSent++
      logEvent({ type: 'auto_sent_foto', personId, channel: 'instagram', detail: `[foto:${imagem.shortcut}] pra @${r.enviadoPara}` })
    } catch (e) {
      // ABORTADO por conferência de destinatário não é falha de rede: é a trava fazendo o
      // trabalho dela. Fica no Diário e a conversa segue com o texto que já saiu.
      logEvent({ type: 'auto_foto_abortada', personId, channel: 'instagram', detail: `[foto:${seg.slug}] ${e.message.slice(0, 160)}` })
    }
  }
  return { fotoSent }
}

export async function igAutoReplyTick({ accountKey, sendEnabled = true, onSent } = {}) {
  let acted = 0
  for (const row of aiEnabledPeople('instagram')) {
    const personId = row.person_id
    const threadId = threadIdOf(personId)
    if (!threadId) {
      // Mesmo motivo do WhatsApp (15/08/2026): sem destino não sai nada, e o toggle verde na
      // tela precisa ter alguém dizendo por quê. Uma linha no Diário, não uma por tique.
      const st = getAiSetting(personId, 'instagram')
      if (st?.state !== 'sem_destino') {
        setAiSetting({ personId, channel: 'instagram', enabled: true, state: 'sem_destino' })
        logEvent({ type: 'auto_sem_destino', personId, channel: 'instagram',
          detail: 'IA ligada, mas esta pessoa não tem conversa do Instagram ligada a ela: nada será enviado' })
      }
      continue
    }
    // Cadência: se já há resposta agendada pra pendência atual e ainda não é hora, nem relê
    // o DOM (caro, disputa a aba única). O fp aqui é pelo banco; refina após reler.
    const pre = getAiSetting(personId, 'instagram')
    const fpPre = pendingFingerprint(personId) || fingerprintIniciativaCobranca(personId, 'instagram')
    if (fpPre && pre?.scheduled_fp === fpPre && pre?.last_attempted_fp !== fpPre && Date.now() < (pre.reply_at || 0)) continue
    // relê a conversa ao vivo antes de decidir (o DOM é a verdade)
    await refreshThread({ accountKey, threadId }).catch(() => {})
    const fp = pendingFingerprint(personId) || fingerprintIniciativaCobranca(personId, 'instagram')
    if (!fp) continue // última foi nossa e não há situação de PIX pra puxar
    const setting = getAiSetting(personId, 'instagram')
    if (setting && setting.last_attempted_fp === fp) continue
    if (replyGate({ personId, channel: 'instagram', fp }) !== 'send') continue // cadência humana: ainda no tempo de espera
    const chat = getIgChat(accountKey, threadId)
    // O toggle é a fonte da verdade (regra do dono): vínculo NUNCA bloqueia. Se o
    // tagueamento marcou a pessoa como delicada (pai, cliente, bot), fica só o aviso
    // no Diário — a decisão de ligar foi dele e é respeitada.
    const aviso = avisoDeVinculo(personId)
    if (aviso) logEvent({ type: 'auto_aviso_vinculo', personId, channel: 'instagram', detail: aviso })
    setAiSetting({ personId, channel: 'instagram', enabled: true, state: 'generating', lastAttemptedFp: fp })
    let pedidoEmCurso = null
    try {
      const meta = {}
      const draft = await generateDraft({ personId, name: chat?.name, channel: 'instagram', chatMode: chat?.mode || null, meta })
      pedidoEmCurso = meta.pedidoUnico || null
      const fpText = textFp(draft)
      const prev = getReceipt(accountKey, 'instagram', threadId)
      if (prev && prev.text_fp === fpText && ['sent', 'sending', 'uncertain'].includes(prev.state)) {
        if (pedidoEmCurso) concluirPedidoUnico(pedidoEmCurso.id, 'instagram')
        logEvent({ type: 'auto_skip_dup', personId, channel: 'instagram', detail: pedidoEmCurso ? `[pedido único] ${pedidoEmCurso.resumo}` : draft }); continue
      }
      if (!sendEnabled) {
        if (pedidoEmCurso) liberarPedidoUnico(pedidoEmCurso.id, 'modo sombra: envio desabilitado')
        logEvent({ type: 'auto_draft', personId, channel: 'instagram', detail: pedidoEmCurso ? `[pedido único aguardando envio] ${pedidoEmCurso.resumo}` : draft }); acted++; continue
      }
      saveReceipt({ accountKey, channel: 'instagram', targetId: threadId, commandId: fp, textFp: fpText, state: 'sending' })
      await entregarDraftNoInstagram({ accountKey, personId, threadId, draft, author: 'ia' })
      saveReceipt({ accountKey, channel: 'instagram', targetId: threadId, commandId: fp, textFp: fpText, state: 'sent' })
      setAiSetting({ personId, channel: 'instagram', enabled: true, state: 'idle', lastAttemptedFp: fp, lastSentFp: fpText })
      if (pedidoEmCurso) concluirPedidoUnico(pedidoEmCurso.id, 'instagram')
      const eventoId = logEvent({ type: 'auto_sent', personId, channel: 'instagram', detail: pedidoEmCurso ? `[pedido único] ${pedidoEmCurso.resumo}` : draft })
      if (meta.cobranca) registrarCobrancaEnviada({ personId, channel: 'instagram', receiptKey: `event:${eventoId}`, tipo: meta.cobranca.tipo })
      if (!pedidoEmCurso) registrarAssercao({ personId, channel: 'instagram', texto: draft, fatos: meta.fatos || [] })
      if (typeof onSent === 'function') { try { onSent(personId, threadId) } catch { /* ignora */ } }
      acted++
    } catch (e) {
      // ERRO PASSAGEIRO NÃO PODE VIRAR SILÊNCIO PERMANENTE.
      // O laço pula quem já tem `last_attempted_fp` igual à pendência atual ("já tratei
      // essa"). Guardar o fp aqui, na FALHA, fazia a conversa morrer até a pessoa escrever de
      // novo — foi o que aconteceu em 27/07/2026: um `effort is not defined` derrubou a
      // geração e as conversas ficaram mudas mesmo depois do conserto.
      // Solta o fp (pra tentar de novo) e adia a próxima tentativa pela mesma cadência, que
      // já sabe esperar — assim retentar não vira metralhadora em cima de um erro que insiste.
      setAiSetting({ personId, channel: 'instagram', enabled: true, state: 'error' })
      if (pedidoEmCurso) liberarPedidoUnico(pedidoEmCurso.id, e.message)
      soltarTentativa(personId, 'instagram')
      setReplySchedule({ personId, channel: 'instagram', fp, replyAt: Date.now() + 5 * 60 * 1000 })
      logEvent({ type: 'auto_error', personId, channel: 'instagram', detail: e && e.message ? e.message : String(e) })
    }
  }
  return acted
}
