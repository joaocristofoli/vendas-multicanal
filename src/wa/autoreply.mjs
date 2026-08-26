// Motor de resposta automática do WhatsApp. Espelha o tinderAutoReplyTick, mas envia
// pelo Baileys (waSendText, com ritmo humano). Mesmo cérebro: Codex + memória unificada
// (buildHistory por person_id, então conversa que veio do Tinder mantém o contexto).
// IA é opt-in por pessoa (ai_setting channel='whatsapp'); nasce desligada.
import { db, aiEnabledPeople, getAiSetting, setAiSetting, getReceipt, saveReceipt, addMessage, marcarAutor, getWaChat, logEvent,
  getSavedAudioByShortcut, bumpSavedAudioUsage, getSetting, waJidForPerson, setReplySchedule, soltarTentativa,
  getSavedImageByShortcut, bumpSavedImageUsage, linkIdentity } from '../core/db.mjs'
import { pendingFingerprint } from '../bridge/bridge.mjs'
import { generateDraft, textFp } from '../tinder/autoreply.mjs'
import { registrarAssercao } from '../self/fatos.mjs'
import { avisoDeVinculo } from '../self/vinculos.mjs'
import { replyGate } from '../ai/cadence.mjs'
import { sendHumanReply } from './send.mjs'
import { sendSavedAudio } from './saved-audio.mjs'
import { sendSavedImage } from './saved-image.mjs'
import { splitDraftMidia } from './saved-image-ai.mjs'
import { ehSelfPerson } from '../assistente/guarda.mjs'
import { motivoParaNaoAbrir } from './abertura-a-frio.mjs'
import { concluirPedidoUnico, liberarPedidoUnico, fingerprintIniciativaCobranca } from '../necessidades/pedido-unico.mjs'
import { registrarCobrancaEnviada } from '../self/pix.mjs'
import { etiquetaAbreFotoQuente } from '../self/etiquetas.mjs'

// Esta pessoa já recebeu ESTE áudio salvo antes? (busca o file no media_json das mensagens
// outgoing dela). É a trava anti-repetição no CÓDIGO — não confiamos só no prompt.
function savedAudioAlreadySent(personId, file) {
  if (!file) return false
  return !!db().prepare(`SELECT 1 FROM message WHERE person_id=? AND channel='whatsapp' AND direction='outgoing'
    AND media_json LIKE '%"saved":true%' AND media_json LIKE ? LIMIT 1`).get(personId, `%${JSON.stringify(file).slice(1, -1)}%`)
}

// jid do WhatsApp vinculado a uma pessoa (a IA só age em quem já foi adotado, e adotar
// materializa a identity whatsapp -> aqui sempre há jid).
function jidForPerson(accountKey, personId) {
  // waJidForPerson tem ORDEM definida (conversa de verdade primeiro). A consulta crua que
  // estava aqui podia devolver um vínculo morto quando a pessoa tinha mais de um.
  const vinculado = waJidForPerson(accountKey, personId)
  if (vinculado) return vinculado

  // SEM VÍNCULO NA TABELA `identity`, MAS COM CONVERSA ABERTA (15/08/2026).
  //
  // A pessoa do WhatsApp nasce com `person_id` = "wa:<jid>" quando ninguém a uniu a outro
  // canal — e nesse caso pode não existir linha em `identity`. O tick pedia o jid, recebia
  // null e PULAVA EM SILÊNCIO: sem rascunho, sem erro, sem aviso. Na instancia-b isso deixou 20
  // das 24 conversas com IA ligada mudas, incluindo alguém que mandou a mesma mensagem 7
  // vezes desde junho com o toggle verde na tela.
  //
  // O destino não é adivinhado: só vale o jid que está DENTRO do próprio person_id e que
  // tem conversa de verdade em `wa_chat` desta conta. É o mesmo jid que o painel abre.
  const jidCru = String(personId || '').startsWith('wa:') ? String(personId).slice(3) : null
  if (!jidCru) return null
  const existe = db().prepare(`SELECT 1 FROM wa_chat WHERE account_key=? AND jid=? LIMIT 1`).get(accountKey, jidCru)
  if (!existe) return null
  // Conserta o dado, não só o sintoma: o vínculo passa a existir e todo o resto do sistema
  // (memória, envio manual, união de canais) enxerga a mesma pessoa.
  try {
    linkIdentity({ accountKey, channel: 'whatsapp', channelId: jidCru, personId, method: 'auto-conversa' })
    logEvent({ type: 'wa_vinculo_reparado', personId, channel: 'whatsapp', detail: `vínculo criado a partir da conversa aberta (${jidCru})` })
  } catch { /* se não gravar, o envio desta rodada ainda acontece */ }
  return jidCru
}

// Exportada só para a guarda `licoes/ia-ligada-sem-destino` poder provar o caminho do
// destino sem subir o tick inteiro (que precisaria de socket do WhatsApp).
export function jidForPersonParaProva(accountKey, personId) { return jidForPerson(accountKey, personId) }

// Uma foto recebida depois da última mensagem nossa precisa terminar a visão antes de a
// IA escrever. Vale mesmo quando a pessoa mandou "foto + texto" em duas bolhas: olhar só a
// última mensagem deixaria a bolha de texto atropelar a imagem ainda pendente.
export function hasPendingIncomingImage(personId) {
  if (!personId) return false
  return !!db().prepare(`SELECT 1 FROM message
    WHERE person_id=? AND channel='whatsapp' AND direction='incoming'
      AND media_json LIKE '%"kind":"image"%' AND media_json LIKE '%"status":"pending"%'
      AND ts > COALESCE((SELECT MAX(ts) FROM message
        WHERE person_id=? AND channel='whatsapp' AND direction='outgoing'), 0)
    LIMIT 1`).get(personId, personId)
}

// Entrega um rascunho que pode intercalar TEXTO e ÁUDIO salvo (marcador [audio:atalho]),
// segmento a segmento na ordem em que a IA escreveu. Texto vai por sendHumanReply; áudio
// passa pelos guardrails (não confio só no prompt): slug inexistente/inativo -> descarta e
// loga; máximo 1 áudio por resposta; áudio já enviado a essa pessoa -> descarta. Persiste
// cada bolha com o id REAL do WhatsApp (dedupe do eco) e, no áudio, com o media_json saved.
// Exportada pra ser o MESMO caminho testável fora do tick (com sock mockado). Retorna
// { lastProviderMsgId, audioSent, textBubbles }.
export async function deliverDraftSegments(sock, { accountKey, personId, jid, draft }) {
  // TRAVA DE ABERTURA A FRIO. A IA do WhatsApp só responde a quem já escreveu, então na
  // prática isto nunca dispara aqui — e é exatamente por isso que fica: no dia em que algum
  // caminho novo tentar fazer a IA abrir conversa, ele morre aqui em vez de queimar o número.
  const barrado = motivoParaNaoAbrir(accountKey, { personId, jid })
  if (barrado) {
    logEvent({ type: 'wa_abertura_barrada', personId, channel: 'whatsapp', detail: 'a IA tentou abrir conversa: ' + barrado.slice(0, 80) })
    return { lastProviderMsgId: undefined, audioSent: 0, fotoSent: 0, textBubbles: 0, barrado }
  }
  const segments = splitDraftMidia(draft)
  let lastProviderMsgId
  let audioSent = 0
  let fotoSent = 0
  let textBubbles = 0
  for (const seg of segments) {
    if (seg.kind === 'text') {
      const res = await sendHumanReply(sock, jid, seg.text)
      const base = Date.now()
      const parts = res.parts && res.parts.length ? res.parts : [{ text: seg.text, id: null }]
      // messageId = id REAL do WhatsApp -> quando o eco chegar via messages.upsert, dedupa.
      // author:'ia' + marcarAutor: o eco pode CHEGAR ANTES deste insert (o WhatsApp é rápido
      // e o sendHumanReply demora com o "digitando"). Nesse caso o insert é engolido pelo
      // dedupe e a linha ficaria como escrita pelo dono. O UPDATE garante a verdade.
      parts.forEach((part, i) => {
        const mid = 'wa:' + (part.id || (jid + ':out:' + (base + i)))
        addMessage({ messageId: mid, accountKey, personId, channel: 'whatsapp', direction: 'outgoing', text: part.text, ts: base + i, author: 'ia' })
        marcarAutor({ channel: 'whatsapp', messageId: mid, author: 'ia' })
      })
      textBubbles += parts.length
      if (res && res.providerMessageId) lastProviderMsgId = res.providerMessageId
      continue
    }
    // seg.kind === 'foto' — as MESMAS travas do áudio, no CÓDIGO. Foto erra pior: áudio
    // trocado é constrangedor, foto trocada é irreversível.
    if (seg.kind === 'foto') {
      if (!getSetting('saved_image_ai', true)) { logEvent({ type: 'auto_foto_disabled', personId, channel: 'whatsapp', detail: `[foto:${seg.slug}] descartada (uso de fotos pela IA desligado)` }); continue }
      // getSavedImageByShortcut já recusa inativa E travada: um rascunho gerado antes de a
      // foto virar 'travada' ainda carrega o marcador, e é aqui que ele morre.
      const imagem = getSavedImageByShortcut(seg.slug, { permitirQuente: etiquetaAbreFotoQuente(personId) })
      if (!imagem) { logEvent({ type: 'auto_foto_bad_slug', personId, channel: 'whatsapp', detail: `[foto:${seg.slug}] inexistente, inativa ou travada` }); continue }
      if (fotoSent >= 1) { logEvent({ type: 'auto_foto_extra_dropped', personId, channel: 'whatsapp', detail: `[foto:${seg.slug}] descartada (máx 1 por resposta)` }); continue }
      if (savedAudioAlreadySent(personId, imagem.file)) { logEvent({ type: 'auto_foto_repeat_dropped', personId, channel: 'whatsapp', detail: `[foto:${seg.slug}] já enviada antes pra essa pessoa` }); continue }
      const fr = await sendSavedImage(sock, jid, imagem)
      const fts = Date.now()
      const fmid = 'wa:' + (fr && fr.providerMessageId ? fr.providerMessageId : jid + ':out:' + fts)
      // media_json com `saved` e a descrição: é o que faz a trava de repetição funcionar e o
      // que deixa a IA LEMBRAR, na próxima vez, qual foto ela já mandou pra essa pessoa.
      addMessage({ messageId: fmid, accountKey, personId, channel: 'whatsapp', direction: 'outgoing', text: '',
        media: { kind: 'image', saved: true, file: imagem.file, descricao: imagem.descricao, status: 'done' }, ts: fts, author: 'ia' })
      marcarAutor({ channel: 'whatsapp', messageId: fmid, author: 'ia' })
      bumpSavedImageUsage(imagem.id)
      if (fr && fr.providerMessageId) lastProviderMsgId = fr.providerMessageId
      fotoSent++
      logEvent({ type: 'auto_sent_foto', personId, channel: 'whatsapp', detail: `[foto:${imagem.shortcut}] ${imagem.title || ''}` })
      continue
    }
    // seg.kind === 'audio' — guardrails no CÓDIGO:
    // Cinto do toggle do painel: com saved_audio_ai desligado, NENHUM áudio sai pela IA
    // (mesmo que um rascunho gerado antes do desligamento ainda carregue o marcador).
    if (!getSetting('saved_audio_ai', true)) { logEvent({ type: 'auto_audio_disabled', personId, channel: 'whatsapp', detail: `[audio:${seg.slug}] descartado (uso de áudios pela IA desligado)` }); continue }
    const audio = getSavedAudioByShortcut(seg.slug)
    if (!audio) { logEvent({ type: 'auto_audio_bad_slug', personId, channel: 'whatsapp', detail: `[audio:${seg.slug}] inexistente/inativo` }); continue }
    if (audioSent >= 1) { logEvent({ type: 'auto_audio_extra_dropped', personId, channel: 'whatsapp', detail: `[audio:${seg.slug}] descartado (máx 1 por resposta)` }); continue }
    if (savedAudioAlreadySent(personId, audio.file)) { logEvent({ type: 'auto_audio_repeat_dropped', personId, channel: 'whatsapp', detail: `[audio:${seg.slug}] já enviado antes` }); continue }
    const ar = await sendSavedAudio(sock, jid, audio)
    const ats = Date.now()
    const amid = 'wa:' + (ar && ar.providerMessageId ? ar.providerMessageId : jid + ':out:' + ats)
    // Persiste com o media_json saved (transcript incluso) -> historyText faz a IA "lembrar"
    // do que o áudio disse na próxima vez, sem tocar no bridge.
    addMessage({ messageId: amid, accountKey, personId, channel: 'whatsapp', direction: 'outgoing', text: '',
      media: { kind: 'audio', saved: true, file: audio.file, dur: audio.duration_sec, transcript: audio.transcript, status: 'done' }, ts: ats, author: 'ia' })
    marcarAutor({ channel: 'whatsapp', messageId: amid, author: 'ia' })
    bumpSavedAudioUsage(audio.id)
    if (ar && ar.providerMessageId) lastProviderMsgId = ar.providerMessageId
    audioSent++
    logEvent({ type: 'auto_sent_audio', personId, channel: 'whatsapp', detail: `[audio:${audio.shortcut}] ${audio.title}` })
  }
  return { lastProviderMsgId, audioSent, fotoSent, textBubbles }
}

// Um tick do loop do WhatsApp: gera+envia para pendências com IA auto ligada.
// sendEnabled=false => modo sombra (registra o rascunho no diário, não envia).
// onSent(personId, jid) é chamado após um envio bem-sucedido (pro painel atualizar).
export async function waAutoReplyTick({ waAccount, accountKey, sendEnabled = true, onSent } = {}) {
  const sock = waAccount && waAccount.sock
  if (!sock) return 0
  let acted = 0
  for (const row of aiEnabledPeople('whatsapp')) {
    const personId = row.person_id
    // TRAVA: a conversa do dono consigo mesmo é o console do assistente, nunca uma pessoa.
    // Sem isto, um toggle ligado por engano faria o cérebro que escreve COMO ele começar a
    // responder as mensagens DELE — e cada resposta viraria um novo comando (laço).
    if (ehSelfPerson(accountKey, personId)) {
      logEvent({ type: 'auto_skip_self', personId, channel: 'whatsapp', detail: 'self-chat é do assistente, não da IA de conversa' })
      continue
    }
    const jid = jidForPerson(accountKey, personId)
    if (!jid) {
      // NUNCA MAIS EM SILÊNCIO. Sem destino, esta conversa não recebe nada — e quem ligou o
      // toggle precisa saber disso, senão fica olhando um botão verde que não faz nada.
      // O estado fica gravado (a tela lê) e o Diário recebe UMA linha, não uma por tique.
      const st = getAiSetting(personId, 'whatsapp')
      if (st?.state !== 'sem_destino') {
        setAiSetting({ personId, channel: 'whatsapp', enabled: true, state: 'sem_destino' })
        logEvent({ type: 'auto_sem_destino', personId, channel: 'whatsapp',
          detail: 'IA ligada, mas não há conversa de WhatsApp ligada a esta pessoa: nada será enviado até o vínculo existir' })
      }
      continue
    }
    if (hasPendingIncomingImage(personId)) continue // espera enxergar a foto antes de responder
    const fp = pendingFingerprint(personId) || fingerprintIniciativaCobranca(personId, 'whatsapp')
    if (!fp) continue // última foi nossa e não há situação de PIX pra puxar
    const setting = getAiSetting(personId, 'whatsapp')
    if (setting && setting.last_attempted_fp === fp) continue // essa pendência já foi tratada
    if (replyGate({ personId, channel: 'whatsapp', fp }) !== 'send') continue // cadência humana: ainda no tempo de espera
    const chat = getWaChat(accountKey, jid)
    const name = chat?.name || null

    // O toggle é a fonte da verdade (regra do dono): vínculo NUNCA bloqueia. Se o
    // tagueamento marcou a pessoa como delicada (pai, cliente, bot), fica só o aviso
    // no Diário — a decisão de ligar foi dele e é respeitada.
    const aviso = avisoDeVinculo(personId)
    if (aviso) logEvent({ type: 'auto_aviso_vinculo', personId, channel: 'whatsapp', detail: aviso })
    setAiSetting({ personId, channel: 'whatsapp', enabled: true, state: 'generating', lastAttemptedFp: fp })
    let pedidoEmCurso = null
    try {
      const meta = {}
      const draft = await generateDraft({ personId, name, channel: 'whatsapp', chatMode: chat?.mode || null, meta })
      pedidoEmCurso = meta.pedidoUnico || null
      const fpText = textFp(draft)
      const prev = getReceipt(accountKey, 'whatsapp', jid)
      if (prev && prev.text_fp === fpText && ['sent', 'sending', 'uncertain'].includes(prev.state)) {
        if (pedidoEmCurso) concluirPedidoUnico(pedidoEmCurso.id, 'whatsapp')
        logEvent({ type: 'auto_skip_dup', personId, channel: 'whatsapp', detail: pedidoEmCurso ? `[pedido único] ${pedidoEmCurso.resumo}` : draft }); continue
      }
      if (!sendEnabled) {
        if (pedidoEmCurso) liberarPedidoUnico(pedidoEmCurso.id, 'modo sombra: envio desabilitado')
        logEvent({ type: 'auto_draft', personId, channel: 'whatsapp', detail: pedidoEmCurso ? `[pedido único aguardando envio] ${pedidoEmCurso.resumo}` : draft }); acted++; continue
      }

      saveReceipt({ accountKey, channel: 'whatsapp', targetId: jid, commandId: fp, textFp: fpText, state: 'sending' })
      // Entrega o rascunho (texto e/ou áudio salvo intercalados) com os guardrails de áudio.
      const { lastProviderMsgId, textBubbles } = await deliverDraftSegments(sock, { accountKey, personId, jid, draft })
      saveReceipt({ accountKey, channel: 'whatsapp', targetId: jid, commandId: fp, textFp: fpText, state: 'sent', providerMsgId: lastProviderMsgId })
      setAiSetting({ personId, channel: 'whatsapp', enabled: true, state: 'idle', lastAttemptedFp: fp, lastSentFp: fpText })
      if (pedidoEmCurso) concluirPedidoUnico(pedidoEmCurso.id, 'whatsapp')
      const eventoId = logEvent({ type: 'auto_sent', personId, channel: 'whatsapp', detail: pedidoEmCurso ? `[pedido único] ${pedidoEmCurso.resumo}` : draft })
      if (meta.cobranca && textBubbles > 0) registrarCobrancaEnviada({ personId, channel: 'whatsapp', receiptKey: `event:${eventoId}`, tipo: meta.cobranca.tipo })
      if (!pedidoEmCurso) registrarAssercao({ personId, channel: 'whatsapp', messageId: lastProviderMsgId || null, texto: draft, fatos: meta.fatos || [] })
      if (typeof onSent === 'function') { try { onSent(personId, jid) } catch { /* ignora */ } }
      acted++
    } catch (e) {
      // ERRO PASSAGEIRO NÃO PODE VIRAR SILÊNCIO PERMANENTE.
      // O laço pula quem já tem `last_attempted_fp` igual à pendência atual ("já tratei
      // essa"). Guardar o fp aqui, na FALHA, fazia a conversa morrer até a pessoa escrever de
      // novo — foi o que aconteceu em 27/07/2026: um `effort is not defined` derrubou a
      // geração e as conversas ficaram mudas mesmo depois do conserto.
      // Solta o fp (pra tentar de novo) e adia a próxima tentativa pela mesma cadência, que
      // já sabe esperar — assim retentar não vira metralhadora em cima de um erro que insiste.
      setAiSetting({ personId, channel: 'whatsapp', enabled: true, state: 'error' })
      if (pedidoEmCurso) liberarPedidoUnico(pedidoEmCurso.id, e.message)
      soltarTentativa(personId, 'whatsapp')
      setReplySchedule({ personId, channel: 'whatsapp', fp, replyAt: Date.now() + 5 * 60 * 1000 })
      logEvent({ type: 'auto_error', personId, channel: 'whatsapp', detail: e && e.message ? e.message : String(e) })
    }
  }
  return acted
}
