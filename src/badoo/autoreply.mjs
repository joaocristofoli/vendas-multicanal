// Auto-resposta do Badoo: mesmo cérebro do Tinder/WhatsApp/Instagram (Codex + modos +
// memória unificada), enviando pelo composer da página (sync.enviar). IA opt-in por conversa
// (ai_setting channel='badoo') — como manda a regra, nasce desligada por pessoa.
//
// A diferença de custo em relação aos outros canais: reler a conversa aqui é uma NAVEGAÇÃO
// (o Badoo só entrega o histórico quando o app dele pede). Por isso a peneira barata vem
// primeiro — cadência e fingerprint de banco — e a releitura só acontece pra quem sobrou.
import { aiEnabledPeople, getAiSetting, setAiSetting, getReceipt, saveReceipt, getBadooChat, logEvent, setReplySchedule, soltarTentativa, channelMessages,
  getSavedAudioByShortcut, getSavedImageByShortcut, getSetting, bumpSavedAudioUsage } from '../core/db.mjs'
import { pendingFingerprint } from '../bridge/bridge.mjs'
import { generateDraft, textFp } from '../tinder/autoreply.mjs'
import { registrarAssercao } from '../self/fatos.mjs'
import { avisoDeVinculo } from '../self/vinculos.mjs'
import { replyGate } from '../ai/cadence.mjs'
import { sincronizarConversa, enviar, lerPerfil } from './sync.mjs'
import { getBadooPerfil } from '../core/db.mjs'
import { enviarAudioSalvo, registrarAudioEnviado } from './audio.mjs'
import { enviarFotoBadoo } from './foto.mjs'
import { ehVideoSalvo } from '../wa/saved-image.mjs'
import { splitDraftMidia } from '../wa/saved-image-ai.mjs'
import { registrarConviteDaSaida } from '../bridge/convites.mjs'
import { registrarCobrancaEnviada } from '../self/pix.mjs'
import { concluirPedidoUnico, liberarPedidoUnico, cobrancaQuerEsquentar, fingerprintIniciativaCobranca } from '../necessidades/pedido-unico.mjs'
import { etiquetaAbreFotoQuente } from '../self/etiquetas.mjs'

const chatIdOf = (personId) => (String(personId || '').startsWith('b:') ? String(personId).slice(2) : null)
// "Já trocaram alguma palavra?" — qualquer mensagem, de qualquer lado. É o que separa abrir
// conversa de responder: `pendingFingerprint` só enxerga a última, e uma conversa em que só
// EU falei devolve null nele exatamente como uma conversa vazia.
const temHistorico = (personId) => (channelMessages(personId, 'badoo', 1) || []).length > 0

function audioJaEnviado(personId, file) {
  if (!file) return false
  return (channelMessages(personId, 'badoo', 500) || []).some((m) => {
    try { const media = JSON.parse(m.media_json || ''); return media?.kind === 'audio' && media.saved && media.file === file } catch { return false }
  })
}

function fotoJaEnviada(personId, file) {
  if (!file) return false
  return (channelMessages(personId, 'badoo', 500) || []).some((m) => {
    try { const media = JSON.parse(m.media_json || ''); return media?.kind === 'image' && media.saved && media.file === file } catch { return false }
  })
}

// Entrega o rascunho que a IA escreveu, mantendo a ordem entre texto, áudio e foto.
// Foto vai por `enviarFotoBadoo` (alvo conferido na página duas vezes). Sem comprovante
// não se diz que enviou.
export async function enviarRascunhoComMidia({ accountKey, personId, chatId, draft, author = 'ia', protegerAudio = true }) {
  const segments = splitDraftMidia(draft)
  let audioSent = 0
  let fotoSent = 0
  let lastUid = null
  const textosComprovados = []
  const nomeEsperado = getBadooChat(accountKey, chatId)?.name || null
  const permitirQuente = etiquetaAbreFotoQuente(personId) || cobrancaQuerEsquentar(personId)
  for (const segment of segments) {
    if (segment.kind === 'text') {
      const result = await enviar({ accountKey, chatId, texto: segment.text, author })
      lastUid = result?.uids?.at(-1) || lastUid
      if (result?.comprovado) textosComprovados.push(segment.text)
      continue
    }
    if (segment.kind === 'foto') {
      if (!getSetting('saved_image_ai', true)) {
        logEvent({ type: 'auto_foto_disabled', personId, channel: 'badoo', detail: `[foto:${segment.slug}] descartada (uso de fotos pela IA desligado)` })
        continue
      }
      if (fotoSent >= 1) {
        logEvent({ type: 'auto_foto_extra_dropped', personId, channel: 'badoo', detail: `[foto:${segment.slug}] descartada (máx 1 por resposta)` })
        continue
      }
      const imagem = getSavedImageByShortcut(segment.slug, { permitirQuente })
      if (!imagem) {
        logEvent({ type: 'auto_foto_bad_slug', personId, channel: 'badoo', detail: `[foto:${segment.slug}] inexistente, inativa ou nível não permite` })
        continue
      }
      // O compositor do Badoo só aceita imagem. A lista da IA neste canal nem traz os vídeos.
      if (ehVideoSalvo(imagem.file)) {
        logEvent({ type: 'auto_foto_video_sem_canal', personId, channel: 'badoo', detail: `[foto:${segment.slug}] é vídeo; o Badoo não manda vídeo` })
        continue
      }
      if (fotoJaEnviada(personId, imagem.file)) {
        logEvent({ type: 'auto_foto_repeat_dropped', personId, channel: 'badoo', detail: `[foto:${segment.slug}] já enviada antes pra essa pessoa` })
        continue
      }
      try {
        const rec = await enviarFotoBadoo({
          accountKey, personId, chatId, atalho: segment.slug,
          nomeEsperado, permitirQuente, author,
        })
        if (rec?.uid) lastUid = rec.uid
        fotoSent++
      } catch (e) {
        logEvent({ type: 'auto_foto_erro', personId, channel: 'badoo', detail: `[foto:${segment.slug}] ${e.message}` })
      }
      continue
    }
    if (!getSetting('saved_audio_ai', true) && protegerAudio) {
      logEvent({ type: 'auto_audio_disabled', personId, channel: 'badoo', detail: `[audio:${segment.slug}] descartado (uso de áudios pela IA desligado)` })
      continue
    }
    const audio = getSavedAudioByShortcut(segment.slug)
    if (!audio) { logEvent({ type: 'auto_audio_bad_slug', personId, channel: 'badoo', detail: `[audio:${segment.slug}] inexistente/inativo` }); continue }
    if (protegerAudio && audioSent >= 1) { logEvent({ type: 'auto_audio_extra_dropped', personId, channel: 'badoo', detail: `[audio:${segment.slug}] descartado (máx 1 por resposta)` }); continue }
    if (protegerAudio && audioJaEnviado(personId, audio.file)) { logEvent({ type: 'auto_audio_repeat_dropped', personId, channel: 'badoo', detail: `[audio:${segment.slug}] já enviado antes` }); continue }
    const receipt = await enviarAudioSalvo({ chatId, audio })
    registrarAudioEnviado({ accountKey, personId, audio, receipt, author })
    bumpSavedAudioUsage(audio.id)
    audioSent++
    lastUid = receipt.uid || lastUid
    logEvent({ type: author === 'ia' ? 'auto_sent_audio' : 'badoo_sent_audio', personId, channel: 'badoo', detail: `[audio:${audio.shortcut}] ${audio.title || ''}` })
  }
  // Badoo agora participa do MESMO aprendizado de migração do Tinder: se a mensagem
  // comprovadamente enviada carregou o WhatsApp da sessão, deixa o rastro que explicará
  // uma conversa nova aparecendo lá depois. Vale para IA e envio manual do painel.
  const convite = textosComprovados.length
    ? registrarConviteDaSaida({
        accountKey, personId, sourceChannel: 'badoo',
        messageId: lastUid ? `b:${lastUid}` : null,
        texto: textosComprovados.join('\n'),
      })
    : null
  return { audioSent, lastUid, convite }
}

// Teto de navegações por volta. Cada uma custa ~8s de Chrome; o prazo da etapa no laço é de
// 90s (src/index.mjs). Com 4, a volta cabe com folga mesmo quando 4 pessoas respondem juntas —
// e quem sobrar é atendido na volta seguinte, que vem em menos de um minuto.
const MAX_NAVEGACOES_POR_VOLTA = 4

export async function badooAutoReplyTick({ accountKey, sendEnabled = true, onSent } = {}) {
  let acted = 0
  let navegacoes = 0
  for (const row of aiEnabledPeople('badoo')) {
    const personId = row.person_id
    const chatId = chatIdOf(personId)
    if (!chatId) {
      // Mesmo motivo do WhatsApp (15/08/2026): sem destino não sai nada, e o toggle verde na
      // tela precisa ter alguém dizendo por quê. Uma linha no Diário, não uma por tique.
      const st = getAiSetting(personId, 'badoo')
      if (st?.state !== 'sem_destino') {
        setAiSetting({ personId, channel: 'badoo', enabled: true, state: 'sem_destino' })
        logEvent({ type: 'auto_sem_destino', personId, channel: 'badoo',
          detail: 'IA ligada, mas esta pessoa não tem conversa do Badoo ligada a ela: nada será enviado' })
      }
      continue
    }
    // AS PENEIRAS BARATAS VÊM TODAS ANTES DA NAVEGAÇÃO (15/08/2026, depois de acontecer).
    //
    // Reler uma conversa aqui é abrir a página no Chrome e esperar 8 segundos. Este laço
    // fazia isso para TODA pessoa com IA ligada antes de olhar cadência ou pendência — com
    // 147 conversas ligadas na instancia-b, uma volta pedia ~20 minutos. Ela nunca terminava:
    // primeiro travava o laço inteiro (e calava WhatsApp e Tinder junto), depois, com o prazo
    // por etapa, passou a ser cortada aos 90s sempre no mesmo ponto — as primeiras pessoas da
    // lista eram atendidas e as do fim NUNCA. Um cliente ficou 50 minutos sem resposta com a
    // IA ligada e o Diário limpo.
    //
    // Agora navega só quem sobrou depois de tudo: pendência conhecida, já tratada, cadência.
    // Quem chega aqui é quem vai responder de verdade — costumam ser uma ou duas por volta.
    const pre = getAiSetting(personId, 'badoo')
    const fpPre = pendingFingerprint(personId) || fingerprintIniciativaCobranca(personId, 'badoo')
    if (!fpPre) continue
    if (fpPre && pre?.scheduled_fp === fpPre && pre?.last_attempted_fp !== fpPre && Date.now() < (pre.reply_at || 0)) continue
    if (fpPre && pre?.last_attempted_fp === fpPre) continue          // essa pendência já foi tratada
    if (fpPre && replyGate({ personId, channel: 'badoo', fp: fpPre }) !== 'send') continue // cadência humana
    // Sem pendência conhecida, o banco pode estar atrás do servidor — mas isso é trabalho da
    // varredura de novidades (`sincronizarNovidades`, que lê a lista e navega só nas que
    // mudaram). Aqui, só confirma quem já tem pendência: navegar às cegas por 147 conversas
    // é justamente o que quebrava o canal.
    if (navegacoes >= MAX_NAVEGACOES_POR_VOLTA) continue
    navegacoes++
    await sincronizarConversa({ accountKey, chatId }).catch(() => {})   // o servidor é a verdade
    const fp = pendingFingerprint(personId) || fingerprintIniciativaCobranca(personId, 'badoo')
    if (!fp) continue // ela respondeu pelo app entre a peneira e agora -> nada a responder
    const setting = getAiSetting(personId, 'badoo')
    if (setting && setting.last_attempted_fp === fp) continue
    if (replyGate({ personId, channel: 'badoo', fp }) !== 'send') continue // cadência humana
    const chat = getBadooChat(accountKey, chatId)
    // O toggle é a fonte da verdade: vínculo delicado só avisa no Diário, nunca bloqueia.
    const aviso = avisoDeVinculo(personId)
    if (aviso) logEvent({ type: 'auto_aviso_vinculo', personId, channel: 'badoo', detail: aviso })
    setAiSetting({ personId, channel: 'badoo', enabled: true, state: 'generating', lastAttemptedFp: fp })
    let pedidoEmCurso = null
    try {
      const meta = {}
      // O perfil dela entra na geração como no Tinder. Lê uma vez e guarda: sem isto a IA
      // puxa assunto às cegas, que era o defeito (26/07/2026).
      let profile = getBadooPerfil(accountKey, chatId)
      if (!profile) profile = await lerPerfil({ accountKey, chatId }).catch(() => null)
      const draft = await generateDraft({ personId, name: chat?.name, channel: 'badoo', profile, chatMode: chat?.mode || null, meta })
      pedidoEmCurso = meta.pedidoUnico || null
      const fpText = textFp(draft)
      const prev = getReceipt(accountKey, 'badoo', chatId)
      if (prev && prev.text_fp === fpText && ['sent', 'sending', 'uncertain'].includes(prev.state)) {
        if (pedidoEmCurso) concluirPedidoUnico(pedidoEmCurso.id, 'badoo')
        logEvent({ type: 'auto_skip_dup', personId, channel: 'badoo', detail: pedidoEmCurso ? `[pedido único] ${pedidoEmCurso.resumo}` : draft }); continue
      }
      if (!sendEnabled) {
        if (pedidoEmCurso) liberarPedidoUnico(pedidoEmCurso.id, 'modo sombra: envio desabilitado')
        logEvent({ type: 'auto_draft', personId, channel: 'badoo', detail: pedidoEmCurso ? `[pedido único aguardando envio] ${pedidoEmCurso.resumo}` : draft }); acted++; continue
      }
      saveReceipt({ accountKey, channel: 'badoo', targetId: chatId, commandId: fp, textFp: fpText, state: 'sending' })
      const entrega = await enviarRascunhoComMidia({ accountKey, personId, chatId, draft, author: 'ia' })
      const teveEntrega = !!entrega.lastUid
      saveReceipt({ accountKey, channel: 'badoo', targetId: chatId, commandId: fp, textFp: fpText, state: teveEntrega ? 'sent' : 'uncertain' })
      setAiSetting({ personId, channel: 'badoo', enabled: true, state: teveEntrega ? 'idle' : 'error', lastAttemptedFp: fp, lastSentFp: teveEntrega ? fpText : null })
      if (pedidoEmCurso) {
        if (teveEntrega) concluirPedidoUnico(pedidoEmCurso.id, 'badoo')
        else liberarPedidoUnico(pedidoEmCurso.id, 'envio sem comprovante')
      }
      const eventoId = logEvent({ type: teveEntrega ? 'auto_sent' : 'auto_error', personId, channel: 'badoo', detail: pedidoEmCurso ? `[pedido único] ${pedidoEmCurso.resumo}` : (teveEntrega ? draft : 'envio sem comprovante') })
      if (meta.cobranca && entrega.lastUid) registrarCobrancaEnviada({ personId, channel: 'badoo', receiptKey: `event:${eventoId}`, tipo: meta.cobranca.tipo })
      if (teveEntrega && !pedidoEmCurso) registrarAssercao({ personId, channel: 'badoo', texto: draft, fatos: meta.fatos || [] })
      if (typeof onSent === 'function') { try { onSent(personId, chatId) } catch { /* ignora */ } }
      acted++
    } catch (e) {
      // ERRO PASSAGEIRO NÃO PODE VIRAR SILÊNCIO PERMANENTE.
      // O laço pula quem já tem `last_attempted_fp` igual à pendência atual ("já tratei
      // essa"). Guardar o fp aqui, na FALHA, fazia a conversa morrer até a pessoa escrever de
      // novo — foi o que aconteceu em 27/07/2026: um `effort is not defined` derrubou a
      // geração e as conversas ficaram mudas mesmo depois do conserto.
      // Solta o fp (pra tentar de novo) e adia a próxima tentativa pela mesma cadência, que
      // já sabe esperar — assim retentar não vira metralhadora em cima de um erro que insiste.
      setAiSetting({ personId, channel: 'badoo', enabled: true, state: 'error' })
      if (pedidoEmCurso) liberarPedidoUnico(pedidoEmCurso.id, e.message)
      soltarTentativa(personId, 'badoo')
      setReplySchedule({ personId, channel: 'badoo', fp, replyAt: Date.now() + 5 * 60 * 1000 })
      logEvent({ type: 'auto_error', personId, channel: 'badoo', detail: e && e.message ? e.message : String(e) })
    }
  }
  return acted
}

// ---------------------------------------------------------------------------------------
// ABRIR CONVERSA (a primeira mensagem)
//
// Regra do gestor (11/08/2026): "se estiver sem mensagem a conversa e eu ligar, a IA deve
// criar a primeira mensagem — e continuar a conversa."
//
// O tick acima é REATIVO por desenho: sem mensagem dela não há pendência e ele pula. Isso
// deixava as conversas do Badoo que nascem de uma VISITA AO PERFIL (as que o painel mostra
// com "Visitou seu perfil hoje", sem nenhuma mensagem) num limbo: ligar o interruptor não
// fazia nada, e nada faria, porque ninguém ia escrever primeiro.
//
// Por que só o Badoo, e só no clique: abrir conversa é o sistema falando com alguém que
// nunca falou com ele. É um gesto que tem que ter dono. Aqui o dono é o clique no
// interruptor daquela conversa — não existe abertura em massa, nem varredura que sai
// puxando assunto sozinha.
//
// As três travas:
//  1. SÓ SE ESTIVER VAZIA DE VERDADE. Sincroniza a conversa antes de decidir; o servidor é a
//     verdade, o banco é cache. Conversa com histórico volta pro caminho reativo.
//  2. UMA VEZ SÓ. O comprovante em `badoo-opener` guarda o chatId: se já houve abertura,
//     não abre de novo, mesmo que o interruptor seja desligado e religado.
//  3. RESPEITA O ENVIO GLOBAL. Com `send_enabled` desligado, gera e registra o rascunho no
//     Diário sem mandar — é o modo de ensaio, igual ao do tick.
export async function badooIniciarConversa({ accountKey, personId, sendEnabled = true }) {
  const chatId = chatIdOf(personId)
  if (!chatId) return null

  await sincronizarConversa({ accountKey, chatId }).catch(() => {})   // (1) o servidor é a verdade
  if (temHistorico(personId)) return null                            // tem conversa: não é abertura

  const jaAbriu = getReceipt(accountKey, 'badoo-opener', chatId)
  if (jaAbriu && ['sent', 'sending', 'uncertain'].includes(jaAbriu.state)) {   // (2)
    logEvent({ type: 'opener_skip_dup', personId, channel: 'badoo', detail: 'esta conversa já foi aberta antes' })
    return null
  }

  const chat = getBadooChat(accountKey, chatId)
  try {
    setAiSetting({ personId, channel: 'badoo', enabled: true, state: 'generating' })
    // Perfil primeiro: abrir conversa sem ler o perfil é puxar assunto às cegas — foi o
    // defeito de 26/07/2026 (a IA lia o perfil de NINGUÉM). Numa primeira mensagem isso é
    // pior, porque não existe histórico pra segurar o assunto.
    let profile = getBadooPerfil(accountKey, chatId)
    if (!profile) profile = await lerPerfil({ accountKey, chatId }).catch(() => null)

    const meta = {}
    const draft = await generateDraft({
      personId, name: chat?.name, channel: 'badoo', profile,
      chatMode: chat?.mode || null, mode: 'opener', meta,
    })
    const fpText = textFp(draft)
    if (!sendEnabled) {                                                        // (3)
      logEvent({ type: 'auto_draft', personId, channel: 'badoo', detail: `[abertura] ${draft}` })
      setAiSetting({ personId, channel: 'badoo', enabled: true, state: 'idle' })
      return { ok: true, enviado: false, draft }
    }
    saveReceipt({ accountKey, channel: 'badoo-opener', targetId: chatId, commandId: 'opener-' + chatId, textFp: fpText, state: 'sending' })
    await enviarRascunhoComMidia({ accountKey, personId, chatId, draft, author: 'ia' })
    saveReceipt({ accountKey, channel: 'badoo-opener', targetId: chatId, commandId: 'opener-' + chatId, textFp: fpText, state: 'sent' })
    setAiSetting({ personId, channel: 'badoo', enabled: true, state: 'idle', lastSentFp: fpText })
    logEvent({ type: 'opener_sent', personId, channel: 'badoo', detail: draft })
    registrarAssercao({ personId, channel: 'badoo', texto: draft, fatos: meta.fatos || [] })
    return { ok: true, enviado: true, draft }
  } catch (e) {
    // Mesma lição do tick: erro passageiro não pode virar silêncio permanente. Aqui basta
    // não deixar comprovante de 'sent' — a próxima ligada do interruptor tenta de novo.
    setAiSetting({ personId, channel: 'badoo', enabled: true, state: 'error' })
    saveReceipt({ accountKey, channel: 'badoo-opener', targetId: chatId, commandId: 'opener-' + chatId, textFp: null, state: 'error' })
    logEvent({ type: 'opener_error', personId, channel: 'badoo', detail: e && e.message ? e.message : String(e) })
    return { ok: false, erro: e.message }
  }
}
