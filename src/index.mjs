// vendas-multicanal — núcleo de operação. Sobe o painel (HTTP+WS), integra banco/IA/Tinder/WhatsApp,
// e roda o loop de auto-resposta. Um processo, uma conta (v1), pronto pra multi-conta.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

import { db, upsertPerson, upsertTinderMatch, tinderMatches, timeline, getAiSetting, setAiSetting, addMessage, marcarAutor,
  getWaSession, upsertWaSession, pendingLinkReviews, resolveLinkReview, addLinkReview, linkIdentity, personByIdentity,
  recentEvents, logEvent, getSetting, setSetting, upsertWaChat, waChats, getWaChat, channelMessages, waChatSetAvatar, waChatMarkRead, waChatSetPn, waChatSetMode, waChatSetNotTinder,
  setMessageMedia, pendingAudioMessages, mergeWaChatInto, pruneControlChatMetadata, logMonitor,
  igChats, getIgChat, igChatSetMode, igChatSetAdopted, igChatMarkRead, recentMonitor, getPersonObjective, setPersonObjective, igMediaDescription, getWaPoll, markWaPollAnswered,
  recordTinderOutgoingMessage, reconcileTinderConversationSummaries,
  queueTinderOpeners, tinderOpenerQueueCount, getReceipt,
  listSavedAudios, getSavedAudio, insertSavedAudio, updateSavedAudioMeta, bumpSavedAudioUsage,
  setSavedAudioTranscript, uniqueShortcut,
  listSavedImages, getSavedImage, insertSavedImage, updateSavedImageMeta, getSavedImageBySha, uniqueImageShortcut, NIVEIS_FOTO,
  rememberWaIdentity, waPnForLid, waIdentitiesSemPn, reconcileLinkStates, contactHints, contactHintCounts,
  identityRow, setIdentityState, verdictsByMessageIds, consolidateWaIdentities, repairOrphanWaMessages,
  recuperarGeracoesOrfas, garantirEnabledAt, tinderSemPerfil, setTinderPerfil, getTinderPerfil, tinderMatchPorPessoa, setReplySchedule, soltarTentativa } from './core/db.mjs'
import { resolvePnForLid, lidIndexByDigits, backfillPns } from './wa/identity.mjs'
import { colherDaMensagem, colherHistorico } from './bridge/hints.mjs'
import { importarCookies as badooImportarCookies, checarSessao as badooChecarSessao, getCookies as badooGetCookies } from './badoo/session.mjs'
import { badooPage, badooExclusive } from './badoo/browser.mjs'
import { sincronizarLista as badooSincronizarLista, sincronizarConversa as badooSincronizarConversa,
  sincronizarRecentes as badooSincronizarRecentes, sincronizarNovidades as badooSincronizarNovidades,
  enviar as badooEnviar, estadoBadoo, badooPersonId, lerPerfil as badooLerPerfil } from './badoo/sync.mjs'
import { enviarAudioSalvo as badooEnviarAudioSalvo, registrarAudioEnviado as badooRegistrarAudioEnviado } from './badoo/audio.mjs'
import { badooAutoReplyTick, badooIniciarConversa, enviarRascunhoComMidia as badooEnviarRascunhoComMidia } from './badoo/autoreply.mjs'
import { telegramAutoReplyTick } from './telegram/autoreply.mjs'
import { syncTelegram } from './telegram/sync.mjs'
import { estado as telegramEstado, credenciaisDeclaradas as tgConfigurado } from './telegram/session.mjs'
import { syncMeuPatrocinio } from './meupatrocinio/sync.mjs'
import { meuPatrocinioAutoReplyTick } from './meupatrocinio/autoreply.mjs'
import { estaConectado as mpConectado } from './meupatrocinio/api.mjs'
import { deslizarEncontros, encontrosTick, estadoEncontros, ligarEncontros } from './badoo/encontros.mjs'
import { faxinaDeAbas } from './browser/faxina.mjs'
import { importarSessaoDoChrome } from './browser/importar-sessoes.mjs'
import { listarModelos, salvarModelo, apagarModelo, candidatos as primeiraCandidatos,
  dispararPrimeira } from './primeira/disparo.mjs'
import { lerCurtidas, rodarSessaoCurtidas, estadoDescobertaBadoo, ligarDescobertaBadoo, badooSwipeTick,
  abrirPerfilDaCurtida, agirNaCurtida } from './badoo/descoberta.mjs'
import { badooChats, getBadooChat, countChannelMessages, getBadooPerfil } from './core/db.mjs'
import { mpChats, getMpChat } from './core/db.mjs'
import { enviarMeuPatrocinio } from './meupatrocinio/sync.mjs'
import { mpPersonId } from './meupatrocinio/sync.mjs'
import { telegramChats, getTelegramChat } from './core/db.mjs'
import { enviarTelegram, enviarFotoTelegram, tgPersonId } from './telegram/sync.mjs'
import { reconstruirAutoria, coberturaAutoria } from './core/autoria.mjs'
import { registrar as saudeRegistrar, tick as saudeTick, avisarVolta as saudeVolta, estado as saudeEstado, caidos as saudeCaidos } from './core/saude-canais.mjs'
import { aoBloquear as filtroAoBloquear } from './ai/filtro.mjs'
import { tick as monitorVozTick, semana as monitorVozSemana, comoTexto as monitorVozTexto } from './ai/monitor-voz.mjs'
import { coletar as coletarInstagramEu, retrato as retratoDoInstagram } from './self/instagram-eu.mjs'
import { tick as missaoRodarTick, criar as missaoCriar, listar as missaoListar, pegar as missaoPegar, cancelar as missaoCancelar } from './skills/missao.mjs'
import { listar as skillsListar, provar as skillProvar } from './skills/registro.mjs'
import { dispararEvento as skillEvento, atenderRota as skillRota, rotas as skillRotas, tickCron as skillCron } from './skills/gatilhos.mjs'
import { radiografar as badooRadiografar, abrirLista as badooAbrirLista, abrirConversa as badooAbrirConversa,
  lerLista as badooLerLista, abrirPeloNome as badooAbrirPeloNome, lidarComConsentimento as badooConsentimento } from './badoo/dom.mjs'
import { resolverPendentes } from './bridge/resolve.mjs'
import { MEDIA_DIR as MEDIA_DIR_PADRAO } from './core/caminhos.mjs'
import { conferirTodos, alvoDeEnvio, conferirVinculo } from './bridge/verificar.mjs'
import { handleVinculosApi } from './bridge/routes.mjs'
import { chamarTick } from './bridge/chamar-tick.mjs'
import { tinderClient, otherIdFromMatch } from './tinder/api.mjs'
import { getToken, setToken, getMe, checkSession, tinderApi, refreshFromChrome, UA } from './tinder/session.mjs'
import { syncMatches, syncTinderUpdates, personIdForMatch } from './tinder/sync.mjs'
import { tinderAutoReplyTick, tinderOpenerTick, generateDraft } from './tinder/autoreply.mjs'
import { guardarRascunho, pegarRascunho } from './panel/rascunho-pendente.mjs'
import { iaPausada, pausa as iaPausaEstado, pausar as iaPausar, retomar as iaRetomar, cotaTick, lerUso as lerUsoCota, limitePausa, monitorLigado } from './ai/cota.mjs'
import { gerarTexto as gerarTextoIa, definirProvedor, disponiveis as iaDisponiveis, provedorAtivo, MODELOS as IA_MODELOS, ESFORCOS as IA_ESFORCOS, modeloAtivo, esforcoAtivo, definirMotor } from './ai/ia.mjs'
import { iniciarMonitoramentoTokens, resumoUso, saudeGeracao } from './ai/uso.mjs'
import {
  cancelarLogin as cancelarLoginClaude,
  concluirLogin as concluirLoginClaude,
  iniciarLogin as iniciarLoginClaude,
  loginPendente as loginClaudePendente,
} from './ai/claude.mjs'
import {
  ativa as contaOpenAiAtiva,
  faxinaContas as faxinaContasOpenAi,
  cancelarLogin as cancelarLoginOpenAi,
  concluirLoginFallback as concluirFallbackOpenAi,
  iniciarLogin as iniciarLoginOpenAi,
  listar as listarContasOpenAi,
  loginPendente as loginOpenAiPendente,
  todasAsCotas as cotasOpenAi,
  trocar as trocarContaOpenAi,
} from './ai/contas.mjs'
import { varrerPerfis, perfilDaPessoa } from './tinder/perfil.mjs'
import { swipeTick } from './tinder/swipe.mjs'
import { handleSwipeApi } from './tinder/routes.mjs'
import { getCodex, readCommunicationProfile } from './ai/codex.mjs'
import { VALID_MODES } from './ai/modos.mjs'
import { buildHistory, linkDeterministic, personByWaJid, cameFromTinder, tinderProfileForWaJid, pendingFingerprint } from './bridge/bridge.mjs'
import { waAutoReplyTick } from './wa/autoreply.mjs'
import { waImageInterpretTick } from './wa/image-interpret.mjs'
import { WaPool } from './wa/pool.mjs'
import { sendText as waSendText, sendSticker as waSendSticker } from './wa/send.mjs'
import { sendAdvanced as waSendAdvanced, CATALOGO as WA_ADV_CATALOGO } from './wa/send-advanced.mjs'
import { fazerFigurinha } from './wa/sticker-maker.mjs'
import { enviarLottie } from './wa/lottie-sticker.mjs'
import { listarLotties, extrairDoZip } from './wa/lottie-lib.mjs'
import { transcribeAudio, falhaDeInfraestrutura } from './wa/media.mjs'
import { transcodeToOpusPtt, persistSavedAudio, sendSavedAudio, savedAudioPath, SAVED_AUDIO_DIR, MAX_UPLOAD_BYTES } from './wa/saved-audio.mjs'
import { persistSavedImage, savedImagePath, sendSavedImage, tipoDaImagem, dimensoes, SAVED_IMAGE_DIR, MAX_IMAGE_BYTES } from './wa/saved-image.mjs'
import { phoneFromJid, normalizeJid } from './wa/jid.mjs'
import { motivoParaNaoAbrir } from './wa/abertura-a-frio.mjs'
import { procurarUnioes } from './self/uniao.mjs'
import { avaliarChegadaWhatsapp } from './bridge/convites.mjs'
import { enviarFotoBadoo, diagnosticarCompositorBadoo } from './badoo/foto.mjs'
import { checkSession as igCheckSession, getIgMe, importCookies as igImportCookies } from './ig/session.mjs'
import { transcreverAudiosIg } from './ig/audio.mjs'
import { syncIgPelaApi, leituraPelaApiLigada, syncInstagram, deepScanInstagram, syncInboxLight as igSyncInboxLight, lerInboxCru as igLerInboxCru, refreshThread as igRefreshThread, sendToThread as igSendToThread, sendToUsername as igSendToUsername, igPersonId } from './ig/sync.mjs'
import { igAutoReplyTick } from './ig/autoreply.mjs'
import { mediaInterpretTick } from './ig/media-tick.mjs'
import { downloadMedia } from './ig/media-interpret.mjs'
import { getBaileys } from './wa/baileys.mjs'
import { aiEnabledPeople, pendingAgendaProposals, getAgendaProposal, resolveAgendaProposal, personDisplayName } from './core/db.mjs'
import { connectionState as agendaConnectionState, buildConnectUrl as agendaConnectUrl, completeOAuth as agendaCompleteOAuth, disconnect as agendaDisconnect,
  createEvent as agendaCreateEvent, updateEvent as agendaUpdateEvent, deleteEvent as agendaDeleteEvent,
  isConfigured as agendaConfigured, listRange as agendaListRange } from './agenda/google.mjs'
import { ensureAgendaFresh, refreshAgenda, agendaSnapshot, ocupacaoAgenda } from './agenda/context.mjs'
import { criarCompromisso, listarCompromissos, cancelarCompromisso } from './agenda/local.mjs'
import { agendaDetectTick } from './agenda/tick.mjs'
import { handleProjectsApi } from './projects/routes.mjs'
import { handleConversasApi } from './conversas/rotas.mjs'
import { metricasDaConversa } from './conversas/metricas.mjs'
import { handleNecessidadesApi } from './necessidades/rotas.mjs'
import { handleSelfApi } from './self/routes.mjs'
import { lerPix, salvarPix } from './self/pix.mjs'
import { lerServicos, salvarServicos, resolverDuracaoAgenda } from './self/servicos.mjs'
import { entregar, servicosComEntrega, CANAIS_COM_ENTREGA } from './self/entrega.mjs'
import { listarComemorativas, salvarComemorativa, apagarComemorativa, comemorativasDeHoje, proximaComemorativa } from './agenda/comemorativas.mjs'
import { etiquetaAbreFotoQuente } from './self/etiquetas.mjs'
import { listarEtiquetas, criarEtiqueta, editarEtiqueta, apagarEtiqueta, etiquetasDaPessoa, pessoasDaEtiqueta, marcarPessoa, salvarRegras, regrasDaEtiqueta, salvarComportamento, comportamentoDaEtiqueta, definirFotosQuentes, CORES as ETIQUETA_CORES } from './self/etiquetas.mjs'
import { garantirEtiquetaFatal, retroagirFatal } from './self/origem-fatal.mjs'
import { retroagirCidades } from './self/cidade-pessoa.mjs'
// Quem resolve como uma pessoa aparece na tela. Identificador interno NUNCA vaza para a UI:
// esta função desce até nome, @ do Instagram ou telefone formatado, e nunca devolve id.
import { nomeParaMostrar } from './core/nome.mjs'
import { pessoasParaConsolidar, consolidarPessoa } from './self/memoria-pessoa.mjs'
import { detectarIniciativas, listarIniciativas, decidirIniciativa, contagemIniciativas } from './self/iniciativa.mjs'
import { registrarAssercao } from './self/fatos.mjs'
import { conferirHorario } from './self/encontros.mjs'
import { waJidForPerson } from './core/db.mjs'
import { reminderTick } from './projects/reminders.mjs'
import { tickCobrancasProgramadas } from './self/cobranca-programada.mjs'
import { handleAssistenteApi, executarPedidoAcao } from './assistente/routes.mjs'
import { iniciarIpcAcoes } from './assistente/ipc-acoes.mjs'
import { conversar } from './assistente/conversa.mjs'
import { proativoTick } from './assistente/proativo.mjs'
import { ehSelfJid, ehSelfPerson, selfJidDaConta } from './assistente/guarda.mjs'
import { provarFidelidade } from './wa/fidelidade.mjs'
import { PASTA as VIDEO_DIR } from './midia/video.mjs'
import { ehEcoNosso, assistenteLigado, enviarNoSelfChat } from './assistente/canal.mjs'
import { assistJaViu, addAssistMsg } from './core/db.mjs'
import { getProject as getProjectRow, todayBadgeCount, logProject as logProjectEvent, mergePeople,
  canonicalPersonId, personAliases, personChannels } from './projects/store.mjs'
import { doDono } from './core/dono.mjs'
import { SISTEMA } from './core/caminhos.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(__dirname, 'panel', 'public')
const MEDIA_DIR = MEDIA_DIR_PADRAO
const SAVED_AUDIO_DIR_ABS = path.resolve(SAVED_AUDIO_DIR) // guarda anti-traversal da rota de stream
const SAVED_IMAGE_DIR_ABS = path.resolve(SAVED_IMAGE_DIR) // idem, pra rota que serve a foto
const PORT = Number(process.env.TIM_PANEL_PORT || 8080)
const HOST = process.env.TIM_PANEL_HOST || '127.0.0.1'
const PASSWORD = process.env.TIM_PANEL_PASSWORD || ''
const SECRET = process.env.TIM_PANEL_SECRET || crypto.randomBytes(32).toString('hex')
const ACCOUNT = process.env.TIM_ACCOUNT_KEY || 'main'
const COOKIE = 'tim_session'
const TINDER_ROSTER_INTERVAL_MS = Number(process.env.TIM_TINDER_ROSTER_MS || 30 * 60 * 1000)
if (!PASSWORD) { console.error('FATAL: defina TIM_PANEL_PASSWORD'); process.exit(1) }

db()
iniciarMonitoramentoTokens()
// Lixo de login abandonado não sobrevive a um restart: pasta sem credencial queima nome de
// conta pra sempre (`proximoNomeConta` só olha se a pasta existe). Guarda: `licoes/pasta-de-conta-orfa-queima-nome`.
{
  const descartadas = faxinaContasOpenAi()
  if (descartadas.length) console.log(`[contas] faxina: ${descartadas.length} pasta(s) sem credencial descartada(s) — ${descartadas.join(', ')}`)
}
const tinderSummaryRepair = reconcileTinderConversationSummaries(ACCOUNT)
if (tinderSummaryRepair.repaired) {
  logEvent({
    type: 'tinder_summary_repair',
    channel: 'tinder',
    detail: `${tinderSummaryRepair.repaired}/${tinderSummaryRepair.checked} resumos alinhados à timeline`,
  })
}
const waPool = new WaPool()
const sockets = new Set()
function broadcast(obj) { const s = JSON.stringify(obj); for (const ws of sockets) { if (ws.readyState === ws.OPEN) { try { ws.send(s) } catch {} } } }

// ---------- auth ----------
const sign = (v) => `${v}.${crypto.createHmac('sha256', SECRET).update(v).digest('hex')}`
function verify(s) { if (!s) return null; const i = s.lastIndexOf('.'); if (i < 0) return null; const v = s.slice(0, i); const mac = Buffer.from(s.slice(i + 1)); const exp = Buffer.from(crypto.createHmac('sha256', SECRET).update(v).digest('hex')); return mac.length === exp.length && crypto.timingSafeEqual(mac, exp) ? v : null }
function cookies(req) { const o = {}; (req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > -1) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()) }); return o }
const authed = (req) => verify(cookies(req)[COOKIE]) === 'ok'
function checkPw(input) { const a = Buffer.from(String(input || '')), b = Buffer.from(PASSWORD); return a.length === b.length && crypto.timingSafeEqual(a, b) }

// ---------- helpers ----------
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
function body(req) { return new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy() }); req.on('end', () => { try { r(JSON.parse(d || '{}')) } catch { r({}) } }) }) }
// Corpo BINÁRIO cru (upload de áudio: octet-stream, NÃO passa pelo body()/JSON de 2MB).
// Junta os chunks num buffer com teto de MAX_UPLOAD_BYTES; se estourar, destrói a request
// e rejeita. Uma nota de voz nunca chega perto do teto — ele existe só como defesa.
function rawBody(req, max = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0
    req.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); reject(new Error('áudio grande demais')); return } chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
// Transcreve um áudio salvo em background (fire-and-forget): reusa o whisper local
// (transcribeAudio) e grava transcript + status na linha. Depois avisa o painel.
function transcribeSavedAudioInBackground(id, file) {
  const fp = savedAudioPath(file)
  transcribeAudio(fp).then((r) => {
    if (r && typeof r.text === 'string') setSavedAudioTranscript(id, { transcript: r.text, status: 'done' })
    else setSavedAudioTranscript(id, { transcript: null, status: 'error' })
    broadcast({ t: 'state' })
  }).catch(() => { try { setSavedAudioTranscript(id, { transcript: null, status: 'error' }) } catch {} broadcast({ t: 'state' }) })
}

// O SELO DO CANAL NÃO PODE SER "TENHO A CREDENCIAL SALVA".
//
// Até 11/08/2026 o Tinder aparecia verde porque existia token no banco E existia `tinder_me`
// gravado — dois valores que continuam lá depois da sessão morrer. Naquele dia o token
// expirou às 10:32, o Diário registrou `canal_caiu · profile status 401`, e o painel seguiu
// mostrando o nome da conta e o selo verde por horas. Selo verde mentindo é pior que selo
// nenhum: ele
// é justamente o gatilho pra alguém ir renovar a sessão, e enquanto mente ninguém vai.
//
// A fonte honesta já existia e não era consultada: `canal_saude`, que o `loopTick` alimenta
// com o que ele VIU a cada volta. Aqui a credencial só decide entre "nunca configurado" e
// "configurado"; quem diz se está de pé é a última observação real.
//
//   sem credencial          -> IDLE       (nunca foi ligado)
//   credencial, sem registro-> PENDENTE   (salvo, ainda não provado nesta vida do processo)
//   registro ok             -> CONNECTED
//   registro caído          -> CAIDO      (com motivo, desde quando e a receita de conserto)
function estadoHonesto(canal, temCredencial) {
  if (!temCredencial) return { status: 'IDLE', motivo: null, desde: null, comoResolver: null }
  const linha = saudeEstado().find((c) => c.canal === canal)
  if (!linha) return { status: 'PENDENTE', motivo: 'ainda não foi verificado nesta execução', desde: null, comoResolver: null }
  if (linha.ok) return { status: 'CONNECTED', motivo: null, desde: linha.desde, comoResolver: null }
  return { status: 'CAIDO', motivo: linha.motivo || 'sessão recusada', desde: linha.desde, comoResolver: linha.comoResolver }
}

function counts() {
  const ms = tinderMatches(ACCOUNT)
  const semMsg = ms.filter((m) => !m.has_conversation && Number(m.history_checked_at) > 0).length
  return {
    matches: ms.length,
    conversas: ms.length,
    comConversa: ms.filter((m) => m.has_conversation).length,
    pendentes: ms.filter((m) => m.pending).length,
    semMsg,
    openerQueued: tinderOpenerQueueCount(ACCOUNT),
    contatos: ms.filter((m) => m.shared_contact).length,
    // quantas pessoas do Tinder têm a IA ligada em algum canal (o número do chip do filtro)
    comIa: ms.filter((m) => getAiSetting(m.person_id, 'tinder')?.enabled || getAiSetting(m.person_id, 'whatsapp')?.enabled || getAiSetting(m.person_id, 'instagram')?.enabled).length,
    revisoes: pendingLinkReviews(ACCOUNT).length,
    // badge da aba Vínculos: ambíguos + contatos colhidos que não fecharam sozinhos
    vinculos: pendingLinkReviews(ACCOUNT).length + contactHints({ status: 'novo', limit: 200 }).filter((h) => h.confidence < 0.9).length,
    agenda: pendingAgendaProposals(ACCOUNT).length,
    projetos: (() => { try { return todayBadgeCount(ACCOUNT) } catch { return 0 } })(),
  }
}

function personNetworks(personId) {
  const canonicalId = canonicalPersonId(personId)
  const aliases = personAliases(canonicalId)
  const channels = personChannels(canonicalId, ACCOUNT)
  const linkedChannels = channels.filter((channel) => channel !== 'tinder')
  let whatsappJid = null
  if (aliases.length) {
    const qs = aliases.map(() => '?').join(',')
    const wa = db().prepare(`SELECT channel_id FROM identity
      WHERE account_key=? AND channel='whatsapp' AND person_id IN (${qs})
      ORDER BY is_primary DESC, linked_at DESC LIMIT 1`).get(ACCOUNT, ...aliases)
    whatsappJid = wa?.channel_id || null
  }
  if (!whatsappJid) {
    const waAlias = aliases.find((id) => String(id).startsWith('wa:'))
    whatsappJid = waAlias ? String(waAlias).slice(3) : null
  }
  return { canonicalId, aliases, channels, linkedChannels, whatsappJid }
}

function aiEnabledForPerson(ids, channel) {
  return [...new Set(ids)].some((id) => !!getAiSetting(id, channel)?.enabled)
}

function personCard(m) {
  const networks = personNetworks(m.person_id)
  const personIds = [m.person_id, networks.canonicalId, ...networks.aliases]
  const photos = JSON.parse(m.photos_json || '[]')
  const conversationState = m.has_conversation ? 'conversation' : Number(m.history_checked_at) > 0 ? 'unmessaged' : 'checking'
  const opener = getReceipt(ACCOUNT, 'tinder-opener', m.match_id)
  return { personId: m.person_id, matchId: m.match_id, name: m.name, photo: photos[0] || null, age: m.age, city: m.city,
    lastText: m.last_text, lastDir: m.last_dir, lastTs: m.last_ts || null, pending: !!m.pending,
    // QUEM ESCREVEU A ÚLTIMA. Sem isto a lista escrevia "você:" em cima de mensagem que a IA
    // mandou — e em 11/08/2026 foi assim que 139 primeiras mensagens da IA apareceram como
    // se fossem dele. O banco sempre soube (`message.author`); a tela é que não perguntava.
    lastAuthor: m.last_dir === 'eu' && m.last_text ? (channelMessages(m.person_id, 'tinder', 1)[0]?.author || null) : null,
    hasConversation: !!m.has_conversation, historyVerified: Number(m.history_checked_at) > 0, conversationState,
    canSendOpener: conversationState === 'unmessaged', openerState: opener?.state || null,
    channel: networks.linkedChannels.includes('whatsapp') ? 'whatsapp' : 'tinder',
    channels: networks.channels, linkedChannels: networks.linkedChannels,
    aiTinder: aiEnabledForPerson(personIds, 'tinder'), aiWhatsapp: aiEnabledForPerson(personIds, 'whatsapp'), aiInstagram: aiEnabledForPerson(personIds, 'instagram'),
    sharedContact: !!m.shared_contact, objective: getPersonObjective(m.person_id),
    metricas: metricasDaConversa(m.person_id, ACCOUNT) }
}

// ---------- WhatsApp: liga o pool ao banco/eventos ----------
// Os códigos que o WhatsApp devolve ao fechar a conexão, em português. O número sozinho não
// diz nada pra quem lê o Diário às 3 da manhã — e é justamente aí que ele é lido.
// A distinção que mais importa: 401 se resolve com QR novo; 403 NÃO se resolve com QR, e
// insistir em reconectar é o que transforma restrição temporária em permanente.
function nomeDoMotivoWa(code) {
  return ({
    401: 'sessão removida/deslogada — o aparelho saiu da lista de conectados; re-parear resolve',
    403: 'ACESSO NEGADO pelo WhatsApp — conta restringida; re-parear NÃO resolve, e insistir piora',
    405: 'conexão recusada na entrada',
    408: 'tempo esgotado',
    411: 'conflito de sessão',
    428: 'conexão fechada pelo servidor',
    440: 'sessão substituída — o mesmo número foi conectado em outro lugar',
    500: 'erro do servidor do WhatsApp',
    503: 'serviço indisponível',
    515: 'reinício exigido pelo WhatsApp (normal após parear)',
  })[Number(code)] || 'motivo desconhecido'
}

// Pergunta de identidade só existe como RESPOSTA a alguém que acabou de escrever, e só
// quando há convite recente para o WhatsApp. É uma mão determinística, separada da IA
// automática da conversa: não liga toggle, não une pessoas e não repete depois do recibo.
async function perguntarIdentidadeNoWhatsapp({ jid, personId, texto }) {
  const anterior = getReceipt(ACCOUNT, 'wa-identidade', jid)
  if (anterior && ['sending', 'sent', 'uncertain', 'no_servidor', 'entregue', 'sem_confirmacao'].includes(anterior.state)) return false
  const acc = waPool.get(ACCOUNT)
  if (!acc?.sock) return false
  const bloqueio = motivoParaNaoAbrir(ACCOUNT, { personId, jid })
  if (bloqueio) {
    logEvent({ type: 'identidade_pergunta_bloqueada', personId, channel: 'whatsapp', detail: bloqueio })
    return false
  }
  saveReceipt({ accountKey: ACCOUNT, channel: 'wa-identidade', targetId: jid,
    commandId: 'identidade:' + jid, textFp: crypto.createHash('sha1').update(texto).digest('hex').slice(0, 16), state: 'sending' })
  try {
    const r = await waSendText(acc.sock, jid, texto)
    const ts = Date.now()
    const mid = 'wa:' + (r?.providerMessageId || `identidade:${jid}:${ts}`)
    addMessage({ messageId: mid, accountKey: ACCOUNT, personId, channel: 'whatsapp',
      direction: 'outgoing', text: texto, ts, author: 'ia' })
    upsertWaChat({ accountKey: ACCOUNT, jid, lastText: texto, lastTs: ts })
    saveReceipt({ accountKey: ACCOUNT, channel: 'wa-identidade', targetId: jid,
      commandId: 'identidade:' + jid, textFp: crypto.createHash('sha1').update(texto).digest('hex').slice(0, 16),
      state: 'sent', providerMsgId: r?.providerMessageId })
    logEvent({ type: 'identidade_perguntou', personId, channel: 'whatsapp', detail: texto })
    broadcast({ t: 'message', jid, personId })
    return true
  } catch (e) {
    saveReceipt({ accountKey: ACCOUNT, channel: 'wa-identidade', targetId: jid,
      commandId: 'identidade:' + jid, textFp: null, state: 'error' })
    logEvent({ type: 'identidade_pergunta_erro', personId, channel: 'whatsapp', detail: e.message })
    return false
  }
}

function waCallbacks() {
  return {
    // Histórico completo no pareamento (default ligado; reversível pelo setting wa_full_history).
    fullHistory: getSetting('wa_full_history', true),
    // account.mjs entrega objetos: onQr({accountKey,qrDataUrl}), onStatus({accountKey,status,jid,name})
    onQr: (info = {}) => { const dataUrl = info.qrDataUrl; upsertWaSession({ accountKey: ACCOUNT, status: 'QR_READY', qrDataUrl: dataUrl }); broadcast({ t: 'wa-qr', dataUrl }); broadcast({ t: 'wa-status', status: 'QR_READY' }) },
    onStatus: (info = {}) => { const { status, jid, name, statusCode, error } = info; upsertWaSession({ accountKey: ACCOUNT, status, jid, name, requiresRepair: status === 'REPAIR_REQUIRED' }); broadcast({ t: 'wa-status', status, jid, name });
      // O PORQUÊ DA QUEDA NÃO PODE SER JOGADO FORA. Até 03/08/2026 este handler recebia o
      // `statusCode` do Baileys e ignorava: o banco guardava só "REPAIR_REQUIRED", que diz
      // QUE caiu e não DIZ POR QUÊ. Quando o WhatsApp caiu de verdade, a diferença entre
      // 401 (sessão removida — re-parear resolve) e 403 (conta restringida — re-parear NÃO
      // resolve e insistir piora) era exatamente a informação que não existia, e sem ela a
      // decisão vira palpite. Agora fica no Diário, com o nome do motivo em português.
      if (info.motivo === 'historico-completo-recusado') {
        // Não é queda: é o pareamento seguindo sem o histórico completo. Fica no Diário
        // porque muda o que aparece depois de ler o QR (conversas sem passado).
        logEvent({ type: 'wa_sem_historico', channel: 'whatsapp', detail: 'o WhatsApp recusou o histórico completo (428 antes do QR) — pareando sem ele; dá pra re-parear depois' })
      } else if (status !== 'CONNECTED' && (statusCode || error)) {
        logEvent({ type: 'wa_desconectou', channel: 'whatsapp', detail: `${status} | código ${statusCode || '?'} (${nomeDoMotivoWa(statusCode)})${error ? ' | ' + String(error).slice(0, 120) : ''}` })
      }
      // mesma ideia do Tinder: quem já sabe, conta. 'CONNECTED' é de pé; o resto é queda.
      saudeWhatsapp(status); if (status === 'CONNECTED') linkDeterministic(waPool.get(ACCOUNT), ACCOUNT).catch(() => {}) },
    // Persistimos toda conversa 1:1 (grupos/broadcast já são filtrados no account.mjs).
    // A IA continua opt-in por pessoa (ai_setting); isto é só captura pro cliente.
    isAllowed: () => true,
    onMessage: (msg) => {
      const ts = (Number(msg.ts) || Date.now() / 1000) * 1000
      const jid = canonicalWaJid(msg.jid) // junta número + @lid na MESMA conversa
      const linked = personByWaJid(ACCOUNT, jid)
      // pushName de mensagem minha é o MEU nome — nunca renomeia a conversa com ele.
      upsertWaChat({ accountKey: ACCOUNT, jid, name: msg.fromMe ? null : msg.pushName, lastText: msg.text, lastTs: ts, fromTinder: !!linked, unreadInc: !msg.fromMe })
      const personId = linked || ('wa:' + jid)
      // Áudio: SEMPRE vira mídia de áudio (mesmo se o download falhou -> status 'nofile'),
      // pra o painel mostrar a bolha de áudio (player ou "indisponível") em vez do texto cru.
      const media = msg.type === 'audio'
        ? { kind: 'audio', file: (msg.audio && msg.audio.file) || null, dur: (msg.audio && msg.audio.seconds) || null, transcript: null, status: (msg.audio && msg.audio.file) ? 'pending' : 'nofile' }
        : msg.type === 'imagem'
          ? { kind: 'image', file: (msg.image && msg.image.file) || null,
              mimetype: (msg.image && msg.image.mimetype) || null, bytes: (msg.image && msg.image.bytes) || null,
              caption: msg.text && msg.text !== '[imagem]' ? msg.text : null,
              description: null, status: (msg.image && msg.image.file) ? 'pending' : 'nofile' }
        : msg.type === 'figurinha'
          // Figurinha: guarda o .webp baixado (se veio) pra mostrar no painel e poder reenviar.
          ? { kind: 'sticker', file: (msg.sticker && msg.sticker.file) || null }
          : null
      const waMsgId = 'wa:' + (msg.id || jid + ':' + msg.ts)
      // fromMe sem carimbo anterior = ele digitou no celular. Se a IA mandou, a linha já
      // existe com author='ia' e o dedupe protege; se o eco venceu a corrida, o caminho da
      // IA corrige com marcarAutor logo depois.
      addMessage({ messageId: waMsgId, accountKey: ACCOUNT, personId, channel: 'whatsapp', direction: msg.fromMe ? 'outgoing' : 'incoming', text: msg.text, media, ts, author: msg.fromMe ? 'humano' : null })
      // A foto precisa ser vista ANTES da resposta. O tick é solto para não segurar a
      // ingestão do socket; wa/autoreply.mjs barra a geração enquanto o status é pending.
      if (media && media.kind === 'image' && media.status === 'pending') {
        void waImageInterpretTick({ accountKey: ACCOUNT }).then((n) => {
          if (n) { broadcast({ t: 'message', jid, personId }); void loopTick() }
        }).catch((e) => logEvent({ type: 'wa_image_tick_error', personId, channel: 'whatsapp', detail: e.message }))
      }
      // Migração de app -> WhatsApp. Usa convite registrado, nome, horário e apresentação;
      // sem nome, pergunta uma única vez. A inferência só cria cartão de revisão — nunca
      // mistura duas pessoas automaticamente por coincidência.
      if (!msg.fromMe && msg.text && String(personId).startsWith('wa:')) {
        try {
          const chatAgora = getWaChat(ACCOUNT, jid)
          const chegada = avaliarChegadaWhatsapp({
            accountKey: ACCOUNT, jid, personId, nome: chatAgora?.name || msg.pushName,
            texto: msg.text, ts,
          })
          if (chegada.nomeDeclarado) {
            upsertWaChat({ accountKey: ACCOUNT, jid, name: chegada.nomeDeclarado, lastTs: ts })
            logEvent({ type: 'identidade_nome_informado', personId, channel: 'whatsapp', detail: chegada.nomeDeclarado })
          }
          if (chegada.reavaliar) {
            const unioes = procurarUnioes({ accountKey: ACCOUNT })
            if (unioes.propostas || unioes.autoVinculados) broadcast({ t: 'state' })
          }
          if (chegada.perguntar) void perguntarIdentidadeNoWhatsapp({ jid, personId, texto: chegada.pergunta })
        } catch (e) { logEvent({ type: 'identidade_chegada_erro', personId, channel: 'whatsapp', detail: e.message }) }
      }
      // Colhe contato passado nesta mensagem (telefone/@ do Instagram) e, se colheu algo
      // novo, manda resolver logo — é o gatilho "na hora" (o antigo só rodava no connect).
      if (!msg.fromMe && msg.text) {
        try { if (colherDaMensagem({ accountKey: ACCOUNT, personId, channel: 'whatsapp', messageId: waMsgId, text: msg.text, direction: 'incoming' }).length) agendarResolucao() }
        catch (e) { logEvent({ type: 'hint_error', channel: 'whatsapp', detail: e.message }) }
      }
      // GATILHOS DE SKILL: o fato aconteceu, as habilidades aprendidas reagem — sem modelo.
      // Solto (void) e com erro engolido lá dentro: skill nenhuma pode segurar nem derrubar
      // a ingestão do WhatsApp, que é o caminho mais quente do sistema.
      if (!msg.fromMe) {
        void skillEvento('mensagem_recebida', { personId, canal: 'whatsapp', texto: msg.text, messageId: waMsgId, media })
        if (media && media.kind === 'audio' && media.file) {
          void skillEvento('audio_recebido', { personId, canal: 'whatsapp', arquivo: path.join(MEDIA_DIR, media.file), messageId: waMsgId })
        }
      }
      // A MINHA conversa comigo mesmo é o console do assistente, não uma conversa.
      // Solto de propósito (o cérebro leva segundos e não pode segurar o fluxo do WhatsApp).
      // ÁUDIO NÃO entra aqui: ao vivo o texto é só o marcador '[audio]', e responder a ele
      // (a) faz o assistente dizer "não consegui ouvir" e (b) marca o waMsgId como visto, o que
      // DESCARTA a transcrição real que chega segundos depois (mesmo id, dedup). O gatilho do
      // áudio no self-chat mora no transcribeTick, já com o texto transcrito.
      // (idem figurinha e qualquer mídia: o marcador '[figurinha]'/'[imagem]' não é comando de texto)
      if (ehSelfJid(ACCOUNT, jid) && msg.text && !media) void tratarSelfChat({ texto: msg.text, waMsgId: msg.id, ts })
      broadcast({ t: 'message', jid, personId })
    },
    // Lista de conversas (metadados) para o painel. lastTs só sobe quando vem mensagem
    // REAL (tem lastText); update só de metadado (conversationTimestamp bombado por evento
    // de controle) NÃO reposiciona o chat — igual ao WhatsApp.
    // Confirmação de ENTREGA das mensagens que mandamos. status do WhatsApp:
    // 1=pendente 2=servidor recebeu 3=entregue no aparelho 4=lida 5=tocada.
    // Sem isso, "enviei" era só o id devolvido pelo baileys — que não prova entrega
    // (25/07/2026: uma primeira mensagem "enviada" nunca chegou, sem erro nenhum).
    onSendStatus: ({ id, jid, status }) => {
      try {
        // O WhatsApp tem DOIS marcos e eles não significam a mesma coisa:
        //   2 = chegou no servidor  -> a mensagem SAIU. Se ela estiver sem internet, para
        //       aqui e é entregue sozinha quando ela abrir o WhatsApp. Isso é SUCESSO.
        //   3+ = entregue no aparelho dela (✓✓) / 4 lida / 5 ouvida.
        // Tratar "só chegou no servidor" como falha é alarme falso — foi o que eu fiz na
        // primeira versão, com a fixture sintética simplesmente offline (correção do dono, 25/07/2026).
        const saiu = Number(status) >= 2
        const entregue = Number(status) >= 3
        if (entregue) logMonitor({ accountKey: ACCOUNT, kind: 'entrega', jid,
          name: getWaChat(ACCOUNT, jid)?.name || null, summary: 'mensagem sua foi entregue', detail: { id, status } })
        const r = db().prepare(`SELECT * FROM send_receipt WHERE account_key=? AND provider_msg_id=?`).get(ACCOUNT, id)
        if (!r) return
        const novo = entregue ? 'entregue' : (saiu ? 'no_servidor' : r.state)
        if (novo !== r.state) {
          db().prepare(`UPDATE send_receipt SET state=? WHERE account_key=? AND channel=? AND target_id=?`).run(novo, ACCOUNT, r.channel, r.target_id)
          logEvent({ type: 'entrega_' + novo, channel: r.channel, detail: `${r.target_id} (status ${status})` })
          broadcast({ t: 'state' })
        }
      } catch { /* best-effort */ }
    },
    // Voto numa enquete que NÓS mandamos: decifra a escolha e, se for o self-chat, entrega pro
    // assistente como se o dono tivesse respondido "escolhi: X" — assim ele entende e continua.
    onPollVote: async ({ pollMsgId, vote, voterJid }) => {
      try {
        const poll = getWaPoll(pollMsgId)
        if (!poll || poll.answered_at) return
        const { decryptPollVote } = await getBaileys()
        if (typeof decryptPollVote !== 'function') return
        const voteMsg = decryptPollVote(vote, { pollEncKey: Buffer.from(poll.enc_key, 'base64'), pollCreatorJid: poll.creator_jid, pollMsgId, voterJid })
        const selecionadas = (voteMsg && voteMsg.selectedOptions) || []
        const opcoes = JSON.parse(poll.options_json || '[]')
        // cada selecionada é o SHA256 do nome da opção; casa pelo hash.
        const hashes = new Set(selecionadas.map((h) => Buffer.from(h).toString('hex')))
        const escolhidas = opcoes.filter((o) => hashes.has(crypto.createHash('sha256').update(String(o)).digest('hex')))
        if (!escolhidas.length) return
        markWaPollAnswered(pollMsgId)
        logEvent({ type: 'wa_poll_voto', detail: `${poll.question}: ${escolhidas.join(', ')}` })
        // só o self-chat alimenta o assistente
        if (ehSelfPerson(ACCOUNT, poll.person_id) || ehSelfJid(ACCOUNT, poll.jid)) {
          void tratarSelfChat({ texto: `escolhi na enquete "${poll.question}": ${escolhidas.join(', ')}`, waMsgId: pollMsgId + ':voto', ts: null })
        }
      } catch (e) { logEvent({ type: 'wa_poll_voto_erro', detail: e.message }) }
    },
    onChats: (chats) => {
      for (const c of chats) { const jid = canonicalWaJid(c.jid); upsertWaChat({ accountKey: ACCOUNT, jid, name: c.name, lastText: c.lastText, lastTs: c.lastText ? (c.ts || 0) * 1000 : 0, fromTinder: !!personByWaJid(ACCOUNT, jid) }) }
      broadcast({ t: 'state' })
    },
    // Mensagens do historico inicial: preview + timeline de TODA conversa 1:1.
    onHistory: (msgs) => {
      for (const m of msgs) {
        const ts = (m.ts || 0) * 1000
        const jid = canonicalWaJid(m.jid)
        const linked = personByWaJid(ACCOUNT, jid)
        upsertWaChat({ accountKey: ACCOUNT, jid, name: m.fromMe ? null : m.pushName, lastText: m.text, lastTs: ts, fromTinder: !!linked })
        const personId = linked || ('wa:' + jid)
        addMessage({ messageId: 'wa:' + (m.id || jid + ':' + m.ts), accountKey: ACCOUNT, personId, channel: 'whatsapp', direction: m.fromMe ? 'outgoing' : 'incoming', text: m.text, ts })
      }
      broadcast({ t: 'state' })
    },
  }
}

// Busca a foto de perfil do contato (best-effort, timeout curto) e cacheia no wa_chat.
// @lid nunca devolve foto (o WhatsApp bloqueia): pula pra não inundar o socket.
// Número por trás de um @lid, direto do cache de identidade do WhatsApp.
function pnForLid(lid) {
  try { return db().prepare(`SELECT pn FROM wa_identity WHERE lid=?`).get(lid)?.pn || null } catch { return null }
}

async function fetchAvatar(jid) {
  if (!jid) return null
  const acc = waPool.get(ACCOUNT)
  if (!acc || !acc.sock) return null
  // Conversa em @lid não tem foto por si: o servidor só devolve pelo NÚMERO. Como a
  // resolução LID->PN já está no banco (wa_chat.pn), pergunta pelo número e guarda a foto
  // no jid original. Sem isso, a maioria das conversas ficava sem foto no painel.
  // Esta conta está no sistema LID, então o @lid é o identificador BOM: 11 conversas em
  // @lid já tinham foto e nenhuma das 12 respondeu quando perguntei pelo número. Tenta o
  // jid como veio e, só se não vier nada, cai pro número (sem o sufixo de dispositivo,
  // que o servidor recusa). Quem não tem foto ou esconde por privacidade devolve nada nos
  // dois caminhos — e aí o painel mostra a inicial colorida, que já é o padrão da casa.
  const alvos = [jid]
  if (jid.endsWith('@lid')) {
    const bruto = getWaChat(ACCOUNT, jid)?.pn || pnForLid(jid)
    const digitos = String(bruto || '').split('@')[0].split(':')[0].replace(/\D/g, '')
    if (digitos) alvos.push(digitos + '@s.whatsapp.net')
  }
  for (const alvo of alvos) {
    try {
      const url = await Promise.race([acc.sock.profilePictureUrl(alvo, 'image'), new Promise((r) => setTimeout(() => r(null), 5000))])
      if (url) { waChatSetAvatar(ACCOUNT, jid, url); broadcast({ t: 'state' }); return url }
    } catch { /* sem foto / privado / identificador que este servidor não aceita */ }
  }
  return null
}

// Pede ao WhatsApp as mensagens ANTERIORES à mais antiga que temos dessa conversa
// (on-demand history). Chegam via 'messaging-history.set' -> onHistory e são persistidas.
// A âncora precisa de um key.id real (o formato 'wa:<id>'; ignora ids sintéticos jid:ts).
function requestWaHistory(jid, personId) {
  const acc = waPool.get(ACCOUNT)
  if (!acc || !acc.sock) return
  const rows = db().prepare(`SELECT message_id,direction,ts FROM message WHERE person_id=? AND channel='whatsapp' ORDER BY ts ASC LIMIT 5`).all(personId)
  let anchor = null
  for (const r of rows) {
    const raw = String(r.message_id).replace(/^wa:/, '')
    if (raw && !raw.includes('@') && !raw.includes(':')) { anchor = { id: raw, ts: r.ts, fromMe: r.direction === 'outgoing' }; break }
  }
  if (!anchor) return
  acc.fetchHistory(50, { remoteJid: jid, id: anchor.id, fromMe: anchor.fromMe }, anchor.ts).catch(() => {})
}

// Antes de medir o Sobre mim, amplia o que está local sem desmontar sessão nem exigir novo
// QR. Tinder faz o sync completo autoritativo; WhatsApp pede páginas anteriores a partir da
// mensagem real mais antiga. O WhatsApp não declara um total remoto, então o resultado desta
// função nunca chama a coleta dele de "completa" — apenas diz quantas páginas conseguiu pedir.
async function prepararHistoricoParaSobreMim({ onProgress } = {}) {
  const resultado = {
    tinder: { estado: 'indisponível', matches: 0 },
    whatsapp: { estado: 'indisponível', conversasConhecidas: 0, paginasPedidas: 0, mensagensNovas: 0 },
  }

  onProgress?.({ etapa: 'sincronizando Tinder', feito: 0, total: 1, detalhe: 'buscando matches e históricos disponíveis' })
  try {
    const api = getToken() ? tinderApi() : null
    let me = getMe()
    if (api && !me?.id && !me?._id) me = (await checkSession()).me || null
    const myId = me?.id || me?._id || null
    if (api && myId) {
      resultado.tinder.matches = await syncMatches(api, ACCOUNT, myId, { withHistory: true, delayMs: 180 })
      resultado.tinder.estado = 'sincronizado'
    } else resultado.tinder.estado = 'sem sessão'
  } catch (e) {
    resultado.tinder = { estado: 'falhou', matches: 0, erro: e.message }
  }

  onProgress?.({ etapa: 'sincronizando WhatsApp', feito: 0, total: 1, detalhe: 'pedindo histórico anterior das conversas conhecidas' })
  const acc = waPool.get(ACCOUNT)
  const chats = waChats(ACCOUNT)
  resultado.whatsapp.conversasConhecidas = chats.length
  if (!acc?.sock) {
    resultado.whatsapp.estado = 'sem sessão conectada; usando o que já estava salvo'
    return resultado
  }
  const antes = db().prepare(`SELECT COUNT(*) n FROM message WHERE channel='whatsapp'`).get()?.n || 0
  const ancoraAnterior = new Map()
  const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  for (let rodada = 0; rodada < 3; rodada++) {
    let pedidasNaRodada = 0
    for (let i = 0; i < chats.length; i++) {
      const c = chats[i]
      const linked = personByWaJid(ACCOUNT, c.jid)
      const ids = [...new Set([linked, `wa:${c.jid}`].filter(Boolean))]
      const marcadores = ids.map(() => '?').join(',')
      const rows = db().prepare(`SELECT message_id,direction,ts FROM message
        WHERE channel='whatsapp' AND person_id IN (${marcadores}) ORDER BY ts ASC LIMIT 8`).all(...ids)
      let anchor = null
      for (const row of rows) {
        const raw = String(row.message_id || '').replace(/^wa:/, '')
        if (raw && !raw.includes('@') && !raw.includes(':')) { anchor = { id: raw, ts: row.ts, fromMe: row.direction === 'outgoing' }; break }
      }
      if (!anchor || ancoraAnterior.get(c.jid) === anchor.id) continue
      ancoraAnterior.set(c.jid, anchor.id)
      onProgress?.({ etapa: 'sincronizando WhatsApp', feito: i + 1, total: chats.length, detalhe: `rodada ${rodada + 1} de 3` })
      await acc.fetchHistory(100, { remoteJid: c.jid, id: anchor.id, fromMe: anchor.fromMe }, anchor.ts)
      resultado.whatsapp.paginasPedidas++
      pedidasNaRodada++
      await esperar(120)
    }
    if (!pedidasNaRodada) break
    // As mensagens chegam em `messaging-history.set`, fora da Promise da requisição.
    await esperar(1_200)
  }
  const depois = db().prepare(`SELECT COUNT(*) n FROM message WHERE channel='whatsapp'`).get()?.n || 0
  resultado.whatsapp.mensagensNovas = Math.max(0, depois - antes)
  resultado.whatsapp.estado = 'histórico disponível ampliado'
  return resultado
}

// Formata dígitos BR pra exibição: 5511999990001 -> (11) 99999-0001.
// Restaura o 9º dígito quando o WhatsApp guardou o celular no formato antigo de 8
// dígitos (DDD + 8 díg começando em 6-9 -> insere o 9).
function prettyPhone(digits) {
  let d = String(digits || '').replace(/\D/g, '')
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2)
  if (d.length === 10 && /[6-9]/.test(d[2])) d = d.slice(0, 2) + '9' + d.slice(2) // 9º dígito
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return String(digits || '')
}

// Resolve o número real (PN, @s.whatsapp.net) de um @lid via lidMapping do Baileys e
// cacheia em wa_chat.pn. Best-effort e não-bloqueante. Retorna o jid PN ou null.
async function resolvePn(jid) {
  if (!jid || !jid.endsWith('@lid')) return null
  const cached = getWaChat(ACCOUNT, jid)?.pn || waPnForLid(jid)
  if (cached) { waChatSetPn(ACCOUNT, jid, cached); return cached }
  const pn = await resolvePnForLid(waPool.get(ACCOUNT), jid) // grava no cache wa_identity
  if (pn) { waChatSetPn(ACCOUNT, jid, pn); reconcileLidDuplicates(); return pn }
  return null
}

// ---------- LID: a mesma pessoa chega por 2 identidades (número @s.whatsapp.net e @lid) ----------
// Canonizamos pro @lid (que carrega o nome). lidByDigits: dígitos do número -> jid @lid.
const lidByDigits = new Map()
function refreshLidMap() {
  lidByDigits.clear()
  // O cache persistente (wa_identity) é a fonte principal: sobrevive a restart e guarda
  // pares que vieram do onWhatsApp, não só das conversas já abertas. A varredura do
  // wa_chat continua por cima, pros pares antigos que só existem lá.
  for (const [digitos, lid] of lidIndexByDigits()) lidByDigits.set(digitos, lid)
  for (const c of waChats(ACCOUNT)) {
    if (c.jid.endsWith('@lid') && c.pn) {
      const d = phoneFromJid(c.pn)
      if (d) { lidByDigits.set(d, c.jid); rememberWaIdentity({ lid: c.jid, pn: c.pn, source: 'wa_chat' }) }
    }
  }
}
// jid de número com @lid conhecido -> devolve o @lid; senão o próprio jid.
function canonicalWaJid(jid) {
  if (jid && jid.endsWith('@s.whatsapp.net')) { const lid = lidByDigits.get(phoneFromJid(jid)); if (lid) return lid }
  return jid
}
// Funde os chats-número nos @lid correspondentes (duplicatas do LID). Só funde quando
// nenhum lado está vinculado a uma pessoa do Tinder (aí a mesclagem é segura).
function reconcileLidDuplicates() {
  refreshLidMap()
  let merged = 0
  for (const c of waChats(ACCOUNT)) {
    if (!c.jid.endsWith('@s.whatsapp.net')) continue
    const lid = lidByDigits.get(phoneFromJid(c.jid))
    if (!lid || lid === c.jid) continue
    // mergeWaChatInto resolve o person_id certo (pessoa vinculada ou wa:) e só recusa em conflito real
    if (mergeWaChatInto(ACCOUNT, c.jid, lid)) merged++
  }
  if (merged) broadcast({ t: 'state' })
  return merged
}

// Telefone de exibição de uma conversa: o PN resolvido (se @lid) ou o próprio número.
// Retorna null quando é um @lid ainda não resolvido (o painel mostra só o nome).
function displayPhone(jid, chat) {
  const pnJid = (chat && chat.pn) || (jid && !jid.endsWith('@lid') ? jid : null)
  return pnJid ? prettyPhone(phoneFromJid(pnJid)) : null
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const p = url.pathname

  if (req.method === 'POST' && p === '/api/login') { const b = await body(req); if (checkPw(b.password)) { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `${COOKIE}=${encodeURIComponent(sign('ok'))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` }); res.end('{"ok":true}') } else json(res, 401, { ok: false }); return }
  if (p === '/api/logout') { res.writeHead(200, { 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0`, 'content-type': 'application/json' }); res.end('{"ok":true}'); return }

  // Callback do OAuth da Google Agenda: chega via redirect do Google (não passa pelo
  // guard de senha — a segurança é o state assinado). Fecha a conexão e volta pro painel.
  if (p === '/api/agenda/oauth/callback') {
    const code = url.searchParams.get('code'), state = url.searchParams.get('state'), err = url.searchParams.get('error')
    const back = (q) => { res.writeHead(302, { Location: `/?agenda=${q}` }); res.end() }
    if (err || !code || !state) { logEvent({ type: 'agenda_oauth_error', detail: err || 'sem code/state' }); return back('error') }
    try { const r = await agendaCompleteOAuth({ code, state, req }); logEvent({ type: 'agenda_connected', detail: r.email || '' }); refreshAgenda().catch(() => {}); return back('connected') }
    catch (e) { logEvent({ type: 'agenda_oauth_error', detail: e.message }); return back('error') }
  }

  // páginas
  if (p === '/') { serveFile(res, path.join(PUBLIC, authed(req) ? 'panel.html' : 'login.html'), req); return }
  if (!p.startsWith('/api') && p !== '/ws') { const f = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, '')); if (f.startsWith(PUBLIC) && fs.existsSync(f) && fs.statSync(f).isFile()) { serveFile(res, f, req); return } res.writeHead(404); res.end(); return }

  if (!authed(req)) { json(res, 401, { error: 'auth' }); return }

  try {
    if (p === '/api/state') {
      const me = getMe(); const wa = getWaSession(ACCOUNT)
      const t = estadoHonesto('tinder', !!getToken() && !!me)
      return json(res, 200, {
        tinder: { connected: t.status === 'CONNECTED', status: t.status, motivo: t.motivo, desde: t.desde, comoResolver: t.comoResolver, name: me?.name || null },
        wa: { status: wa?.status || 'IDLE', jid: wa?.jid || null, name: wa?.name || null }, counts: counts(),
      })
    }
    if (p === '/api/people') {
      const filter = url.searchParams.get('filter') || 'all'
      let list = tinderMatches(ACCOUNT).map(personCard)
      if (filter === 'pending') list = list.filter((x) => x.pending)
      else if (filter === 'matches') list = list.filter((x) => x.conversationState === 'unmessaged')
      else if (filter === 'whatsapp') list = list.filter((x) => x.linkedChannels.includes('whatsapp') || x.sharedContact)
      // Filtro pelo interruptor da IA. Vale a pessoa estar ligada em QUALQUER canal dela: na
      // aba Tinder aparece gente que já migrou pro WhatsApp, e filtrar só por `aiTinder`
      // esconderia justamente quem a IA está atendendo hoje.
      else if (filter === 'ia') list = list.filter((x) => x.aiTinder || x.aiWhatsapp || x.aiInstagram)
      else if (filter === 'sem-ia') list = list.filter((x) => !x.aiTinder && !x.aiWhatsapp && !x.aiInstagram)
      // "Todas" virou a tela inicial: o teto antigo (400) cortava conversas de verdade
      return json(res, 200, list.slice(0, 1000))
    }
    if (p === '/api/tinder/openers' && req.method === 'POST') {
      const b = await body(req)
      const queued = queueTinderOpeners({ accountKey: ACCOUNT, personIds: Array.isArray(b.personIds) ? b.personIds : [] })
      if (queued.accepted.length) {
        logEvent({ type: 'openers_queued', channel: 'tinder', detail: `${queued.accepted.length} primeiras mensagens` })
        broadcast({ t: 'state' })
        void requestTinderOpenerDrain()
      }
      return json(res, 200, {
        ok: true,
        queued: queued.accepted.length,
        skipped: queued.skipped.length,
        personIds: queued.accepted.map((match) => match.person_id),
      })
    }
    if (p.startsWith('/api/person/')) {
      const parts = p.split('/'); const personId = decodeURIComponent(parts[3]); const action = parts[4]
      const m = db().prepare(`SELECT * FROM tinder_match WHERE person_id=?`).get(personId)
      if (req.method === 'GET' && !action) {
        const photos = JSON.parse(m?.photos_json || '[]')
        const tl = timeline(personId, 1000).map((x) => ({ channel: x.channel, direction: x.direction === 'outgoing' ? 'eu' : 'ela', text: x.text, ts: x.ts }))
        const networks = personNetworks(personId)
        const personIds = [personId, networks.canonicalId, ...networks.aliases]
        return json(res, 200, { person: { name: m?.name }, tinder: { matchId: m?.match_id, bio: m?.bio, photos, age: m?.age, city: m?.city }, timeline: tl,
          ai: { tinder: aiEnabledForPerson(personIds, 'tinder'), whatsapp: aiEnabledForPerson(personIds, 'whatsapp'), instagram: aiEnabledForPerson(personIds, 'instagram') },
          identity: { canonicalPersonId: networks.canonicalId, channels: networks.channels, linkedChannels: networks.linkedChannels },
          linkedChannels: networks.linkedChannels,
          whatsapp: { jid: networks.whatsappJid, linked: networks.linkedChannels.includes('whatsapp') }, objective: getPersonObjective(personId),
          metricas: metricasDaConversa(personId, ACCOUNT) })
      }
      if (req.method === 'GET' && action === 'objective') return json(res, 200, { objective: getPersonObjective(personId) })
      const b = await body(req)
      if (action === 'objective') {
        const objective = setPersonObjective(personId, b.objective)
        logEvent({ type: objective ? 'person_objective_set' : 'person_objective_removed', personId, detail: objective ? 'definido' : 'removido' })
        broadcast({ t: 'state' })
        return json(res, 200, { ok: true, objective })
      }
      if (action === 'ai') {
        const canal = b.channel || 'tinder'
        setAiSetting({ personId, channel: canal, enabled: !!b.enabled, state: 'idle' })
        logEvent({ type: b.enabled ? 'ai_on' : 'ai_off', personId, channel: canal })
        // ligou com ela esperando? responde agora, sem entrar na fila
        if (b.enabled && responderAgoraSePendente({ personId, channel: canal })) cutucarCanal(canal)
        broadcast({ t: 'state' }); return json(res, 200, { ok: true })
      }
      if (action === 'generate') {
        // O botão do painel usa o MESMO perfil que a resposta automática: dois caminhos
        // com material diferente é como um dos dois volta a escrever às cegas sem ninguém ver.
        const canalGerar = b.channel || 'tinder'
        const draft = await generateDraft({ personId, name: m?.name, channel: canalGerar, manual: true,
          profile: canalGerar === 'tinder' ? perfilDaPessoa(ACCOUNT, personId, { tinderMatchPorPessoa, getTinderPerfil }) : undefined })
        guardarRascunho(b.pedido, draft)
        return json(res, 200, { draft })
      }
      if (action === 'send') {
        const channel = b.channel || 'tinder'
        if (channel === 'tinder') {
          const me = getMe()
          const r = await tinderApi().sendText({ matchId: m.match_id, otherId: m.other_id || otherIdFromMatch(m.match_id, me?.id), userId: me?.id, text: b.text })
          if (r.ok) {
            const sentAt = Date.now()
            recordTinderOutgoingMessage({
              messageId: r.messageId || `local:${m.match_id}:${sentAt}`,
              accountKey: ACCOUNT,
              matchId: m.match_id,
              personId,
              text: b.text,
              ts: sentAt,
            })
          }
          logEvent({ type: r.ok ? 'manual_sent' : 'manual_error', personId, channel: 'tinder', detail: b.text })
          broadcast({ t: 'message', personId })
          return json(res, 200, { ok: r.ok })
        }
        const wa = db().prepare(`SELECT channel_id FROM identity WHERE person_id=? AND channel='whatsapp'`).get(personId)
        const acc = waPool.get(ACCOUNT)
        if (!wa || !acc?.sock) return json(res, 400, { ok: false, error: 'whatsapp não vinculado/conectado' })
        const r = await waSendText(acc.sock, wa.channel_id, b.text)
        addMessage({ messageId: 'wa:' + (r.providerMessageId || Date.now()), accountKey: ACCOUNT, personId, channel: 'whatsapp', direction: 'outgoing', text: b.text, ts: Date.now(), author: 'humano' })
        logEvent({ type: 'manual_sent', personId, channel: 'whatsapp', detail: b.text }); broadcast({ t: 'message', personId }); return json(res, 200, { ok: true })
      }
    }
    if (p === '/api/wa') {
      const wa = getWaSession(ACCOUNT)
      const linkedCount = db().prepare(`SELECT COUNT(*) n FROM identity WHERE channel='whatsapp' AND account_key=?`).get(ACCOUNT).n
      return json(res, 200, { status: wa?.status || 'IDLE', qrDataUrl: wa?.qr_data_url || null, jid: wa?.jid || null, name: wa?.name || null,
        phone: wa?.jid ? phoneFromJid(wa.jid) : null, linkedCount, queueCount: pendingLinkReviews(ACCOUNT).length,
        reviews: pendingLinkReviews(ACCOUNT).map((r) => ({
          id: r.id, waJid: r.wa_jid, pushName: r.wa_push_name, firstText: r.wa_first_text,
          candidateName: r.candidate_name || personDisplayName(r.candidate_person_id), reason: r.reason,
        })) })
    }
    if (p === '/api/wa/connect') { waPool.getOrCreate(ACCOUNT, waCallbacks()).start().catch((e) => logEvent({ type: 'wa_error', detail: e.message })); return json(res, 200, { ok: true }) }
    // Re-parear: desloga, apaga as credenciais e gera QR novo. Com wa_full_history ligado,
    // o novo pareamento baixa o histórico COMPLETO das conversas. o dono lê o QR no painel.
    if (p === '/api/wa/reparear' && req.method === 'POST') {
      const acc = waPool.getOrCreate(ACCOUNT, waCallbacks())
      acc.fullHistory = getSetting('wa_full_history', true) // garante o valor atual do setting
      upsertWaSession({ accountKey: ACCOUNT, status: 'CONNECTING', qrDataUrl: null })
      acc.reset().catch((e) => logEvent({ type: 'wa_error', detail: 'reparear: ' + e.message }))
      logEvent({ type: 'wa_reparear', detail: 'reset solicitado — aguardando QR' })
      return json(res, 200, { ok: true })
    }
    if (p === '/api/wa/chats') {
      // A lista é o SEU WhatsApp: ordem por recência, como no app. As conversas importantes
      // (do Tinder, adotadas, com modo) entram sempre — mas no lugar delas na linha do tempo,
      // não empilhadas no topo. Antes elas iam todas pra frente; com 14 vínculos novos isso
      // enterrou as conversas normais e o painel parecia ter perdido o inbox (24/07/2026).
      // tira o self-chat (é a aba do assistente, não uma conversa). Comparar só os dígitos
      // deixava passar quando a conta está no sistema LID: a minha conversa comigo mesmo
      // chega como um @lid cujos dígitos não são o meu número. ehSelfJid resolve o LID.
      const all = waChats(ACCOUNT).filter((c) => !ehSelfJid(ACCOUNT, c.jid))
      const isTinder = (c) => cameFromTinder(ACCOUNT, c.jid) && !c.not_tinder // veio do Tinder E não foi desmarcado
      const importante = (c) => isTinder(c) || c.adopted || c.mode
      const RECENTES = 40
      const recentes = all.slice(0, RECENTES)                       // waChats já vem por last_ts DESC
      const noFim = all.slice(RECENTES).filter(importante)          // importantes antigas não podem sumir
      const seen = new Set()
      const merged = [...recentes, ...noFim]
        .filter((c) => (seen.has(c.jid) ? false : seen.add(c.jid)))
        .sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0))
      for (const c of merged) { // em background: fotos + resolução de número real dos @lid
        if (!c.avatar) fetchAvatar(c.jid).catch(() => {})
        if (c.jid.endsWith('@lid') && !c.pn) resolvePn(c.jid).catch(() => {})
      }
      return json(res, 200, merged.map((c) => {
        const personId = personByWaJid(ACCOUNT, c.jid) || ('wa:' + c.jid)
        const phone = displayPhone(c.jid, c)
        return { jid: c.jid, name: c.name || phone || phoneFromJid(c.jid), phone, avatar: c.avatar || null, lastText: c.last_text, lastTs: c.last_ts,
          unread: c.unread || 0, fromTinder: isTinder(c), adopted: !!c.adopted, personId, mode: c.mode || null,
          objective: getPersonObjective(personId), aiOn: personId ? !!getAiSetting(personId, 'whatsapp')?.enabled : false,
          // As etiquetas vêm na LISTA porque é ali que se decide qual conversa abrir: saber
          // que aquele é cliente da Fatal antes de entrar muda a ordem do dia.
          etiquetas: (etiquetasDaPessoa(personId) || []).map((e) => ({ id: e.id, nome: e.nome, cor: e.cor })),
          metricas: metricasDaConversa(personId, ACCOUNT) }
      }))
    }
    // Histórico de uma conversa (thread). Marca como lida ao abrir.
    if (p === '/api/wa/chat' && req.method === 'GET') {
      const jid = url.searchParams.get('jid')
      if (!jid) return json(res, 400, { error: 'jid' })
      const chat = getWaChat(ACCOUNT, jid)
      const linked = personByWaJid(ACCOUNT, jid)
      const personId = linked || ('wa:' + jid)
      const messages = channelMessages(personId, 'whatsapp', 400).map((m) => {
        let media = null
        if (m.media_json) { try { media = JSON.parse(m.media_json) } catch { /* json inválido */ } }
        const isAudio = media && media.kind === 'audio'
        const isSticker = media && media.kind === 'sticker'
        const isImage = media && media.kind === 'image'
        // saved:true = áudio salvo (nota de voz do dono mandada pelo picker/IA): o painel
        // toca pela rota /api/wa/audios/stream em vez de /api/wa/media (áudio recebido).
        return { id: m.message_id, dir: m.direction === 'outgoing' ? 'out' : 'in', text: m.text, ts: m.ts,
          type: isAudio ? 'audio' : isSticker ? 'figurinha' : isImage ? 'imagem' : 'texto',
          audio: isAudio ? { file: media.file, dur: media.dur, transcript: media.transcript, status: media.status, saved: !!media.saved } : null,
          sticker: isSticker ? { file: media.file || null } : null,
          media: isImage ? { file: media.file || null, desc: media.description || null, caption: media.caption || null, status: media.status || null } : null }
      })
      // veredito humano (certo/errado) de cada mensagem que NÓS mandamos
      const vd = verdictsByMessageIds(messages.filter((m) => m.dir === 'out').map((m) => m.id))
      for (const m of messages) if (vd[m.id]) m.veredito = vd[m.id]
      waChatMarkRead(ACCOUNT, jid)
      if (chat && !chat.avatar) fetchAvatar(jid).catch(() => {})
      if (jid.endsWith('@lid') && !(chat && chat.pn)) resolvePn(jid).catch(() => {})
      if (messages.length < 8) requestWaHistory(jid, personId) // puxa o histórico anterior sob demanda
      const phone = displayPhone(jid, chat)
      const fromTinder = cameFromTinder(ACCOUNT, jid) && !(chat && chat.not_tinder)
      return json(res, 200, { jid, name: (chat && chat.name) || phone || phoneFromJid(jid), phone, avatar: (chat && chat.avatar) || null,
        fromTinder, personId, mode: (chat && chat.mode) || null, objective: getPersonObjective(personId),
        aiOn: !!getAiSetting(personId, 'whatsapp')?.enabled, messages,
        etiquetas: (etiquetasDaPessoa(personId) || []).map((e) => ({ id: e.id, nome: e.nome, cor: e.cor })),
        metricas: metricasDaConversa(personId, ACCOUNT) })
    }
    // Serve áudio, figurinha ou foto capturada de uma conversa. Sem traversal.
    if (p === '/api/wa/media') {
      const file = url.searchParams.get('file') || ''
      const ext = path.extname(file).toLowerCase()
      const contentTypes = { '.ogg': 'audio/ogg', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif' }
      if (!/^[A-Za-z0-9_-]+\.(?:ogg|webp|jpe?g|png|gif)$/.test(file) || !contentTypes[ext]) { json(res, 400, { error: 'file' }); return }
      const fp = path.join(MEDIA_DIR, file)
      if (!fp.startsWith(MEDIA_DIR) || !fs.existsSync(fp)) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': contentTypes[ext], 'cache-control': 'private, max-age=86400' })
      fs.createReadStream(fp).pipe(res)
      return
    }
    // Envia uma FIGURINHA pra uma pessoa/JID. Fontes: { file } (.webp já capturado), { latest }
    // (última capturada) ou { forwardFrom } (ENCAMINHA a última figurinha recebida daquela
    // conversa — único jeito de reenviar a MESMA animada/Lottie). Alvo: personId OU jid.
    if (p === '/api/wa/send-sticker' && req.method === 'POST') {
      const bd = await body(req)
      const acc = waPool.get(ACCOUNT)
      if (!acc || !acc.sock) return json(res, 400, { ok: false, error: 'WhatsApp não conectado' })
      // resolve o alvo (personId -> jid, com alvoDeEnvio pra resolver @lid -> número)
      const alvoJid = () => {
        if (bd.jid) return String(bd.jid)
        if (bd.personId) return waJidForPerson(ACCOUNT, bd.personId) || (String(bd.personId).startsWith('wa:') ? String(bd.personId).slice(3) : null)
        return null
      }
      // MODO ENCAMINHAR: reenvia a mesma figurinha (inclusive animada) recebida de forwardFrom
      if (bd.forwardFrom) {
        const src = waJidForPerson(ACCOUNT, bd.forwardFrom) || (String(bd.forwardFrom).startsWith('wa:') ? String(bd.forwardFrom).slice(3) : String(bd.forwardFrom))
        const jid = alvoJid() || src // por padrão devolve pra própria conversa
        if (!jid) return json(res, 400, { ok: false, error: 'sem alvo' })
        try {
          const r = await acc.forwardLastSticker(alvoDeEnvio(ACCOUNT, jid), src)
          const personId = personByWaJid(ACCOUNT, canonicalWaJid(jid)) || ('wa:' + canonicalWaJid(jid))
          addMessage({ messageId: 'wa:' + (r?.providerMessageId || jid + ':sticker:' + Date.now()), accountKey: ACCOUNT, personId, channel: 'whatsapp', direction: 'outgoing', text: '[figurinha]', media: { kind: 'sticker', file: null }, ts: Date.now() })
          broadcast({ t: 'message', jid, personId })
          logEvent({ type: 'wa_sticker_sent', personId, channel: 'whatsapp', detail: `forward de ${src} -> ${jid}` })
          return json(res, 200, { ok: true, providerMessageId: r?.providerMessageId, forwardFrom: src, jid })
        } catch (e) { return json(res, 500, { ok: false, error: e.message }) }
      }
      // resolve o arquivo .webp
      let file = typeof bd.file === 'string' && /^[A-Za-z0-9_-]+\.webp$/.test(bd.file) ? bd.file : null
      if (!file && bd.latest) {
        const row = db().prepare(`SELECT media_json FROM message WHERE channel='whatsapp' AND media_json LIKE '%"kind":"sticker"%' AND media_json LIKE '%.webp%' ORDER BY ts DESC LIMIT 1`).get()
        try { file = row && JSON.parse(row.media_json).file } catch { /* ignora */ }
      }
      if (!file) return json(res, 400, { ok: false, error: 'sem figurinha (passe file=<x>.webp, latest=true ou forwardFrom)' })
      const fp = path.join(MEDIA_DIR, file)
      if (!fp.startsWith(MEDIA_DIR) || !fs.existsSync(fp)) return json(res, 404, { ok: false, error: 'arquivo não encontrado' })
      const jid = alvoJid()
      if (!jid) return json(res, 400, { ok: false, error: 'sem alvo (personId ou jid)' })
      try {
        const buf = fs.readFileSync(fp)
        const r = await waSendSticker(acc.sock, alvoDeEnvio(ACCOUNT, jid), buf)
        const personId = personByWaJid(ACCOUNT, canonicalWaJid(jid)) || ('wa:' + canonicalWaJid(jid))
        addMessage({ messageId: 'wa:' + (r?.providerMessageId || jid + ':sticker:' + Date.now()), accountKey: ACCOUNT, personId, channel: 'whatsapp', direction: 'outgoing', text: '[figurinha]', media: { kind: 'sticker', file }, ts: Date.now() })
        broadcast({ t: 'message', jid, personId })
        logEvent({ type: 'wa_sticker_sent', personId, channel: 'whatsapp', detail: `${file} -> ${jid}` })
        return json(res, 200, { ok: true, providerMessageId: r?.providerMessageId, file, jid })
      } catch (e) { return json(res, 500, { ok: false, error: e.message }) }
    }
    // CRIAR figurinha própria (estática ou ANIMADA) a partir de imagem/GIF/vídeo (url ou file
    // em MEDIA_DIR) e enviar. { personId|jid, url|file, animada }. NÃO é o encaminhamento (esse
    // segue no /api/wa/send-sticker forwardFrom); aqui a gente FABRICA uma figurinha nova.
    if (p === '/api/wa/make-sticker' && req.method === 'POST') {
      const bd = await body(req)
      const acc = waPool.get(ACCOUNT)
      if (!acc || !acc.sock) return json(res, 400, { ok: false, error: 'WhatsApp não conectado' })
      const jid = bd.jid ? String(bd.jid) : (bd.personId ? (waJidForPerson(ACCOUNT, bd.personId) || (String(bd.personId).startsWith('wa:') ? String(bd.personId).slice(3) : null)) : null)
      if (!jid) return json(res, 400, { ok: false, error: 'sem alvo (personId ou jid)' })
      let fonte = null
      if (bd.url) fonte = { url: String(bd.url) }
      else if (bd.file && /^[A-Za-z0-9_.-]+$/.test(bd.file)) { const fp = path.join(MEDIA_DIR, bd.file); if (fp.startsWith(MEDIA_DIR) && fs.existsSync(fp)) fonte = { buffer: fs.readFileSync(fp) } }
      if (!fonte) return json(res, 400, { ok: false, error: 'sem fonte (url ou file de imagem/gif/vídeo)' })
      try {
        const webp = await fazerFigurinha({ ...fonte, animada: !!bd.animada })
        // guarda o arquivo pra o painel mostrar e pra poder reenviar depois
        const file = 'made_' + crypto.createHash('md5').update(webp).digest('hex').slice(0, 12) + '.webp'
        fs.writeFileSync(path.join(MEDIA_DIR, file), webp)
        const r = await waSendSticker(acc.sock, alvoDeEnvio(ACCOUNT, jid), webp)
        const personId = personByWaJid(ACCOUNT, canonicalWaJid(jid)) || ('wa:' + canonicalWaJid(jid))
        addMessage({ messageId: 'wa:' + (r?.providerMessageId || jid + ':stk:' + Date.now()), accountKey: ACCOUNT, personId, channel: 'whatsapp', direction: 'outgoing', text: '[figurinha]', media: { kind: 'sticker', file }, ts: Date.now() })
        broadcast({ t: 'message', jid, personId })
        logEvent({ type: 'wa_sticker_made', personId, channel: 'whatsapp', detail: `${bd.animada ? 'animada' : 'estática'} ${Math.round(webp.length / 1024)}KB -> ${jid}` })
        return json(res, 200, { ok: true, providerMessageId: r?.providerMessageId, file, bytes: webp.length, animada: !!bd.animada })
      } catch (e) { return json(res, 500, { ok: false, error: e.message }) }
    }
    // EXPERIMENTO: envia uma figurinha LOTTIE montada por nós (ZIP em MEDIA_DIR). Pra descobrir
    // se o WhatsApp renderiza Lottie sem o trust_token da Meta. { jid|personId, file:<x.zip/.webp> }
    if (p === '/api/wa/send-lottie' && req.method === 'POST') {
      const bd = await body(req)
      const acc = waPool.get(ACCOUNT)
      if (!acc || !acc.sock) return json(res, 400, { ok: false, error: 'WhatsApp não conectado' })
      const jid = bd.jid ? String(bd.jid) : (bd.personId ? (waJidForPerson(ACCOUNT, bd.personId) || (String(bd.personId).startsWith('wa:') ? String(bd.personId).slice(3) : null)) : null)
      if (!jid || !bd.file || !/^[A-Za-z0-9_.-]+$/.test(bd.file)) return json(res, 400, { ok: false, error: 'jid/file' })
      const fp = path.join(MEDIA_DIR, bd.file)
      if (!fp.startsWith(MEDIA_DIR) || !fs.existsSync(fp)) return json(res, 404, { ok: false, error: 'arquivo não encontrado' })
      try {
        const r = await enviarLottie(acc.sock, alvoDeEnvio(ACCOUNT, jid), fs.readFileSync(fp), { mimetype: bd.mimetype || null })
        logEvent({ type: 'wa_lottie_teste', channel: 'whatsapp', detail: `${bd.file} -> ${jid}` })
        return json(res, 200, { ok: true, providerMessageId: r.providerMessageId })
      } catch (e) { return json(res, 500, { ok: false, error: e.message }) }
    }
    // DEBUG: dumpa os campos do stickerMessage REAL de uma Lottie recebida (do cache _lastSticker)
    // pra a gente copiar o mimetype/flags exatos. { jid|personId }
    if (p === '/api/wa/lottie-template' && req.method === 'GET') {
      const acc = waPool.get(ACCOUNT)
      const jidQ = url.searchParams.get('jid') || ''
      const cached = acc && acc._lastSticker && (acc._lastSticker.get(jidQ) || acc._lastSticker.get(canonicalWaJid(jidQ)))
      if (!cached) return json(res, 404, { error: 'sem figurinha em cache dessa conversa' })
      const m = cached.message || {}
      const lot = m.lottieStickerMessage && m.lottieStickerMessage.message && m.lottieStickerMessage.message.stickerMessage
      const st = lot || m.stickerMessage || null
      if (!st) return json(res, 404, { error: 'cache não é sticker/lottie', keys: Object.keys(m) })
      return json(res, 200, { ehLottie: !!lot, campos: { mimetype: st.mimetype, isAnimated: st.isAnimated, isLottie: st.isLottie, isAvatar: st.isAvatar, isAiSticker: st.isAiSticker, height: st.height, width: st.width, mediaKeyDomain: st.mediaKeyDomain, fileLength: st.fileLength ? String(st.fileLength) : null } })
    }
    // R&D: dispara uma query IQ arbitrária pela conexão do WhatsApp e devolve a resposta.
    // Pra reverse-engineering do fetch de sticker packs da Meta. { node: <BinaryNode> }
    if (p === '/api/wa/wa-query' && req.method === 'POST') {
      const bd = await body(req)
      const acc = waPool.get(ACCOUNT)
      if (!acc || !acc.sock) return json(res, 400, { ok: false, error: 'sem sock' })
      const serial = (n, prof = 0) => {
        if (n == null || prof > 8) return null
        if (Buffer.isBuffer(n) || n instanceof Uint8Array) { const b = Buffer.from(n); return { _bytes: b.length, b64: b.toString('base64').slice(0, 400), utf8: b.toString('utf8').replace(/[^\x20-\x7e]/g, '.').slice(0, 300) } }
        if (typeof n === 'string' || typeof n === 'number') return n
        if (Array.isArray(n)) return n.map((x) => serial(x, prof + 1))
        if (typeof n === 'object') { const o = {}; for (const k of Object.keys(n)) o[k] = serial(n[k], prof + 1); return o }
        return String(n)
      }
      try {
        const r = await acc.sock.query(bd.node, bd.timeoutMs || 7000)
        return json(res, 200, { ok: true, resp: serial(r) })
      } catch (e) { return json(res, 500, { ok: false, error: e && e.message ? e.message : String(e), data: e && e.data ? serial(e.data) : null }) }
    }
    // Biblioteca de figurinhas LOTTIE capturadas (pra o seletor do painel: manda qualquer uma).
    if (p === '/api/wa/lottie-library') return json(res, 200, { lotties: listarLotties() })
    // Serve o animation.json de uma Lottie (pra preview animado no painel, com lottie-web).
    if (p === '/api/wa/lottie-json' && req.method === 'GET') {
      const file = url.searchParams.get('file') || ''
      if (!/^[A-Za-z0-9_.-]+\.webp$/.test(file)) { json(res, 400, { error: 'file' }); return }
      const fp = path.join(MEDIA_DIR, file)
      if (!fp.startsWith(MEDIA_DIR) || !fs.existsSync(fp)) { res.writeHead(404); res.end(); return }
      const aj = extrairDoZip(fs.readFileSync(fp), 'animation/animation.json')
      if (!aj) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'private, max-age=86400' })
      res.end(aj)
      return
    }
    // Catálogo dos tipos de mensagem avançados (dirige a UI do painel).
    if (p === '/api/wa/advanced-catalog') return json(res, 200, { catalogo: WA_ADV_CATALOGO })
    // Envio AVANÇADO: { personId|jid, spec:{type,...}, targetKey?, quoted? }. spec.type do catálogo.
    if (p === '/api/wa/send-advanced' && req.method === 'POST') {
      const bd = await body(req)
      const acc = waPool.get(ACCOUNT)
      if (!acc || !acc.sock) return json(res, 400, { ok: false, error: 'WhatsApp não conectado' })
      const jid = bd.jid ? String(bd.jid) : (bd.personId ? (waJidForPerson(ACCOUNT, bd.personId) || (String(bd.personId).startsWith('wa:') ? String(bd.personId).slice(3) : null)) : null)
      if (!jid) return json(res, 400, { ok: false, error: 'sem alvo (personId ou jid)' })
      const spec = bd.spec || {}
      try {
        const r = await waSendAdvanced(acc.sock, alvoDeEnvio(ACCOUNT, jid), spec, { now: Date.now(), targetKey: bd.targetKey, quoted: bd.quoted })
        const personId = personByWaJid(ACCOUNT, canonicalWaJid(jid)) || ('wa:' + canonicalWaJid(jid))
        // registra um marcador legível do que foi enviado (as operações não geram bolha nova)
        const semBolha = ['react', 'pin', 'edit', 'delete', 'ephemeral']
        if (!semBolha.includes(spec.type)) {
          addMessage({ messageId: 'wa:' + (r?.providerMessageId || jid + ':adv:' + Date.now()), accountKey: ACCOUNT, personId, channel: 'whatsapp', direction: 'outgoing', text: spec.texto || `[${spec.type}]`, ts: Date.now() })
          broadcast({ t: 'message', jid, personId })
        }
        logEvent({ type: 'wa_adv_sent', personId, channel: 'whatsapp', detail: `${spec.type} -> ${jid}` })
        return json(res, 200, { ok: true, providerMessageId: r?.providerMessageId, type: spec.type })
      } catch (e) { return json(res, 500, { ok: false, error: e.message, type: spec.type }) }
    }
    // PROVA DE FIDELIDADE (diagnóstico, não caminho de produção): manda um vídeo da pasta pro
    // SELF-CHAT, baixa de volta do próprio WhatsApp e compara o sha256. É como se responde
    // "o WhatsApp comprimiu?" com medida em vez de opinião. Corpo: { arquivo, comoArquivo }.
    if (p === '/api/wa/fidelidade' && req.method === 'POST') {
      const bd = await body(req)
      const acc = waPool.get(ACCOUNT)
      if (!acc || !acc.sock) return json(res, 400, { ok: false, error: 'WhatsApp não conectado' })
      const arquivo = String(bd.arquivo || '')
      if (!/^[A-Za-z0-9_.-]+\.mp4$/.test(arquivo)) return json(res, 400, { ok: false, error: 'arquivo inválido' })
      const raiz = path.resolve(VIDEO_DIR)
      const fp = path.resolve(path.join(raiz, arquivo))
      if (!fp.startsWith(raiz) || !fs.existsSync(fp)) return json(res, 404, { ok: false, error: 'não achei esse vídeo' })
      const jid = selfJidDaConta(ACCOUNT)
      if (!jid) return json(res, 400, { ok: false, error: 'sem self-chat' })
      try {
        const r = await provarFidelidade(acc.sock, jid, fs.readFileSync(fp), { comoArquivo: !!bd.comoArquivo, fileName: arquivo })
        logEvent({ type: 'wa_fidelidade', channel: 'whatsapp', detail: `${r.tipo}: ${r.identico ? 'idêntico' : 'DIFERENTE'} (${r.bytesEnviados} -> ${r.bytesVoltaram})` })
        return json(res, 200, { ok: true, ...r })
      } catch (e) { return json(res, 500, { ok: false, error: e.message }) }
    }
    // VARREDURA DE TESTE: manda um exemplo de CADA tipo pro número de teste e devolve o que
    // funcionou. Só pra provar/documentar (uso interno). Corpo: { jid|personId }.
    if (p === '/api/wa/test-sweep' && req.method === 'POST') {
      const bd = await body(req)
      const acc = waPool.get(ACCOUNT)
      if (!acc || !acc.sock) return json(res, 400, { ok: false, error: 'WhatsApp não conectado' })
      const jidRaw = bd.jid ? String(bd.jid) : (bd.personId ? (waJidForPerson(ACCOUNT, bd.personId) || (String(bd.personId).startsWith('wa:') ? String(bd.personId).slice(3) : null)) : null)
      if (!jidRaw) return json(res, 400, { ok: false, error: 'sem alvo' })
      const jid = alvoDeEnvio(ACCOUNT, jidRaw)
      testSweep(acc.sock, jid, bd.only).then((r) => logEvent({ type: 'wa_sweep_done', detail: JSON.stringify(r).slice(0, 6000) })).catch((e) => logEvent({ type: 'wa_sweep_err', detail: e.message }))
      return json(res, 200, { ok: true, started: true, alvo: jid })
    }
    // ---------- Áudios salvos (biblioteca de notas de voz do dono + picker "/" + IA) ----------
    // Lista os áudios salvos (todos; o painel filtra ativos pro picker). GET só leitura.
    if (p === '/api/wa/audios' && req.method === 'GET') {
      return json(res, 200, listSavedAudios({}).map((a) => ({
        id: a.id, title: a.title, shortcut: a.shortcut, descricao: a.descricao,
        file: a.file, dur: a.duration_sec, sizeBytes: a.size_bytes,
        transcript: a.transcript, transcriptStatus: a.transcript_status,
        active: !!a.active, usageCount: a.usage_count, lastUsedAt: a.last_used_at, createdAt: a.created_at,
      })))
    }
    // Liga/desliga o USO DE ÁUDIOS PELA IA (setting saved_audio_ai). Desligado = a IA
    // volta a responder 100% texto (prompt idêntico ao sem-áudios); o atalho "/" manual
    // continua funcionando — o botão só governa a IA.
    if (p === '/api/wa/audios/ai' && req.method === 'GET') {
      return json(res, 200, { enabled: !!getSetting('saved_audio_ai', true) })
    }
    if (p === '/api/wa/audios/ai' && req.method === 'POST') {
      const b = await body(req)
      const enabled = !!b.enabled
      setSetting('saved_audio_ai', enabled)
      logEvent({ type: enabled ? 'saved_audio_ai_on' : 'saved_audio_ai_off', detail: 'toggle no painel' })
      broadcast({ t: 'state' })
      return json(res, 200, { ok: true, enabled })
    }
    // UPLOAD de um áudio novo: corpo é BINÁRIO CRU (application/octet-stream), metadados na
    // querystring (?title=&descricao=). Fluxo: buffer -> transcode OGG/Opus -> salva em disco
    // -> mede duração -> insere -> responde JÁ -> transcreve em background (whisper).
    if (p === '/api/wa/audios' && req.method === 'POST') {
      const title = String(url.searchParams.get('title') || '').trim().slice(0, 120)
      const descricao = String(url.searchParams.get('descricao') || '').trim().slice(0, 600)
      if (!title) return json(res, 400, { ok: false, error: 'título obrigatório' })
      let input
      try { input = await rawBody(req) } catch (e) { return json(res, 413, { ok: false, error: e.message }) }
      if (!input || !input.length) return json(res, 400, { ok: false, error: 'áudio vazio' })
      try {
        const { buffer, durationSec } = await transcodeToOpusPtt(input)
        const id = crypto.randomBytes(16).toString('hex') // casa com a regex da rota de stream
        const { file, sizeBytes } = await persistSavedAudio(id, buffer)
        const shortcut = uniqueShortcut(title)
        const row = insertSavedAudio({ id, title, shortcut, descricao, file, durationSec, sizeBytes })
        logEvent({ type: 'saved_audio_add', channel: 'whatsapp', detail: `${title} (/${shortcut}, ${durationSec}s)` })
        transcribeSavedAudioInBackground(id, file) // fire-and-forget
        broadcast({ t: 'state' })
        return json(res, 200, { ok: true, audio: { id: row.id, title: row.title, shortcut: row.shortcut, descricao: row.descricao, file: row.file, dur: row.duration_sec, transcriptStatus: 'pending', active: true, usageCount: 0 } })
      } catch (e) { logEvent({ type: 'saved_audio_error', channel: 'whatsapp', detail: e.message }); return json(res, 500, { ok: false, error: e.message }) }
    }
    // Edita metadados (soft delete = active:false; NUNCA apaga arquivo nem linha).
    if (p === '/api/wa/audios/meta' && req.method === 'POST') {
      const b = await body(req)
      if (!b.id || !getSavedAudio(b.id)) return json(res, 404, { ok: false, error: 'áudio não encontrado' })
      const patch = {}
      if (b.title !== undefined) { const t = String(b.title || '').trim().slice(0, 120); if (!t) return json(res, 400, { ok: false, error: 'título vazio' }); patch.title = t; patch.shortcut = uniqueShortcut(t, b.id) }
      if (b.shortcut !== undefined && b.title === undefined) patch.shortcut = uniqueShortcut(String(b.shortcut || ''), b.id)
      if (b.descricao !== undefined) patch.descricao = String(b.descricao || '').trim().slice(0, 600)
      if (b.active !== undefined) patch.active = !!b.active
      const row = updateSavedAudioMeta(b.id, patch)
      logEvent({ type: 'saved_audio_meta', channel: 'whatsapp', detail: `${row.title} (/${row.shortcut})${b.active === false ? ' inativado' : ''}` })
      broadcast({ t: 'state' })
      return json(res, 200, { ok: true, audio: { id: row.id, title: row.title, shortcut: row.shortcut, descricao: row.descricao, active: !!row.active } })
    }
    // Serve o .ogg de um áudio salvo (pro player do painel). Mesma segurança do /api/wa/media.
    if (p === '/api/wa/audios/stream') {
      const file = url.searchParams.get('file') || ''
      if (!/^[A-Za-z0-9_-]+\.ogg$/.test(file)) { json(res, 400, { error: 'file' }); return }
      const fp = path.resolve(savedAudioPath(file))
      if (!fp.startsWith(SAVED_AUDIO_DIR_ABS) || !fs.existsSync(fp)) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': 'audio/ogg', 'cache-control': 'private, max-age=86400' })
      fs.createReadStream(fp).pipe(res)
      return
    }

    // ---------------- BANCO DE FOTOS ----------------
    // O motor já existia inteiro (tabela, trava de nível, uso nos 4 canais) e a única porta de
    // entrada era `tools/importar-fotos.mjs`, um comando na VM. Estas rotas são a porta que
    // faltava. Espelham as de áudio de propósito: mesma forma de upload (binário cru com os
    // metadados na querystring), mesmo soft delete, mesmo broadcast.
    if (p === '/api/fotos' && req.method === 'GET') {
      return json(res, 200, listSavedImages({}).map((f) => ({
        id: f.id, title: f.title, shortcut: f.shortcut, descricao: f.descricao, contexto: f.contexto, file: f.file,
        width: f.width, height: f.height, sizeBytes: f.size_bytes, nivel: f.nivel,
        active: !!f.active, usageCount: f.usage_count, lastUsedAt: f.last_used_at, createdAt: f.created_at,
      })))
    }
    // Liga/desliga o USO DE FOTOS PELA IA (setting saved_image_ai, lido pelos 4 canais).
    // Desligado, o marcador [foto:slug] de um rascunho é descartado e vira registro no Diário.
    if (p === '/api/fotos/ai' && req.method === 'GET') {
      return json(res, 200, { enabled: !!getSetting('saved_image_ai', true) })
    }
    if (p === '/api/fotos/ai' && req.method === 'POST') {
      const b = await body(req)
      const enabled = !!b.enabled
      setSetting('saved_image_ai', enabled)
      logEvent({ type: enabled ? 'saved_image_ai_on' : 'saved_image_ai_off', detail: 'toggle no painel' })
      broadcast({ t: 'state' })
      return json(res, 200, { ok: true, enabled })
    }
    // UPLOAD: corpo binário cru, metadados na querystring (?title=&descricao=&nivel=).
    //
    // NÍVEL PADRÃO É 'livre' — regra configurada em 11/08/2026. Foto nova já pode ser usada
    // pela IA; travar é o gesto excepcional, não o contrário.
    //
    // DEDUPE POR CONTEÚDO, não por nome: a trava de "nunca repete a mesma foto pra essa
    // pessoa" casa por ARQUIVO. A mesma imagem entrando duas vezes com nomes diferentes
    // fura essa trava em silêncio — foi assim que a primeira pasta importada quase mandou a
    // mesma foto duas vezes pra mesma pessoa.
    if (p === '/api/fotos' && req.method === 'POST') {
      const title = String(url.searchParams.get('title') || '').trim().slice(0, 120)
      const descricao = String(url.searchParams.get('descricao') || '').trim().slice(0, 600)
      const contexto = String(url.searchParams.get('contexto') || '').trim().slice(0, 400)
      const nivel = NIVEIS_FOTO.includes(url.searchParams.get('nivel')) ? url.searchParams.get('nivel') : 'livre'
      if (!descricao) return json(res, 400, { ok: false, error: 'descrição obrigatória — é o único texto que a IA lê pra decidir quando usar a foto' })
      let input
      try { input = await rawBody(req, MAX_IMAGE_BYTES) } catch (e) { return json(res, 413, { ok: false, error: e.message }) }
      if (!input || !input.length) return json(res, 400, { ok: false, error: 'foto vazia' })
      try {
        const sha = crypto.createHash('sha256').update(input).digest('hex')
        const jaTem = getSavedImageBySha(sha)
        if (jaTem) return json(res, 409, { ok: false, error: `essa mesma foto já está no banco como "${jaTem.descricao || jaTem.shortcut}"`, id: jaTem.id })
        const id = crypto.randomBytes(16).toString('hex')
        const { file, sizeBytes, width, height } = await persistSavedImage(id, input)
        const tit = title || descricao.slice(0, 60)
        const shortcut = uniqueImageShortcut(tit)
        const row = insertSavedImage({ id, title: tit, shortcut, descricao, contexto, file, width, height, sizeBytes, nivel, sha })
        logEvent({ type: 'saved_image_add', detail: `${tit} (/${shortcut}, ${nivel})` })
        broadcast({ t: 'state' })
        return json(res, 200, { ok: true, foto: { id: row.id, title: row.title, shortcut: row.shortcut, descricao: row.descricao, file: row.file, width: row.width, height: row.height, nivel: row.nivel, active: true, usageCount: 0 } })
      } catch (e) { logEvent({ type: 'saved_image_error', detail: e.message }); return json(res, 500, { ok: false, error: e.message }) }
    }
    // Edita metadados (soft delete = active:false; NUNCA apaga arquivo nem linha).
    if (p === '/api/fotos/meta' && req.method === 'POST') {
      const b = await body(req)
      if (!b.id || !getSavedImage(b.id)) return json(res, 404, { ok: false, error: 'foto não encontrada' })
      const patch = {}
      if (b.title !== undefined) { const t = String(b.title || '').trim().slice(0, 120); if (!t) return json(res, 400, { ok: false, error: 'título vazio' }); patch.title = t; patch.shortcut = uniqueImageShortcut(t, b.id) }
      if (b.shortcut !== undefined && b.title === undefined) patch.shortcut = uniqueImageShortcut(String(b.shortcut || ''), b.id)
      if (b.descricao !== undefined) { const d = String(b.descricao || '').trim().slice(0, 600); if (!d) return json(res, 400, { ok: false, error: 'sem descrição a IA não sabe quando usar a foto' }); patch.descricao = d }
      if (b.contexto !== undefined) patch.contexto = String(b.contexto || '').trim().slice(0, 400)
      if (b.active !== undefined) patch.active = !!b.active
      // Os QUATRO níveis (15/08/2026). A rota achatava tudo em livre/travada e engolia em
      // silêncio o que a tela mandava: marcar "com criança" virava "livre", que é o pior
      // resultado possível. Nível desconhecido agora é erro, não conversão calada.
      if (b.nivel !== undefined) {
        if (!NIVEIS_FOTO.includes(b.nivel)) return json(res, 400, { ok: false, error: `nível inválido: ${b.nivel}` })
        patch.nivel = b.nivel
      }
      const row = updateSavedImageMeta(b.id, patch)
      logEvent({ type: 'saved_image_meta', detail: `${row.title} (/${row.shortcut}, ${row.nivel})${b.active === false ? ' inativada' : ''}` })
      broadcast({ t: 'state' })
      return json(res, 200, { ok: true, foto: { id: row.id, title: row.title, shortcut: row.shortcut, descricao: row.descricao, contexto: row.contexto, nivel: row.nivel, active: !!row.active } })
    }
    // Serve o arquivo da foto (miniatura e visualização no painel). Mesma guarda
    // anti-traversal da rota de áudio: nome validado por regex E caminho resolvido.
    if (p === '/api/fotos/arquivo') {
      const file = url.searchParams.get('file') || ''
      if (!/^[A-Za-z0-9_-]+\.(jpg|png|gif|webp)$/.test(file)) { json(res, 400, { error: 'file' }); return }
      const fp = path.resolve(savedImagePath(file))
      if (!fp.startsWith(SAVED_IMAGE_DIR_ABS) || !fs.existsSync(fp)) { res.writeHead(404); res.end(); return }
      const ext = file.split('.').pop()
      const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'private, max-age=86400' })
      fs.createReadStream(fp).pipe(res)
      return
    }
    // Envia um áudio salvo manualmente (picker "/"). Persiste a bolha outgoing como áudio
    // saved (com transcript pra a IA "lembrar"), soma o uso e dedupa o eco pelo id real.
    if (p === '/api/wa/chat/send-audio') {
      const b = await body(req); const jid = b.jid; const audioId = b.audioId
      if (!jid || !audioId) return json(res, 400, { ok: false, error: 'jid/audioId' })
      const acc = waPool.get(ACCOUNT)
      if (!acc || !acc.sock) return json(res, 400, { ok: false, error: 'whatsapp offline' })
      const audio = getSavedAudio(audioId)
      if (!audio || !audio.active) return json(res, 404, { ok: false, error: 'áudio não encontrado' })
      const linked = personByWaJid(ACCOUNT, jid); const personId = linked || ('wa:' + jid)
      try {
        const r = await sendSavedAudio(acc.sock, jid, audio)
        const ts = Date.now()
        const mid = 'wa:' + (r && r.providerMessageId ? r.providerMessageId : jid + ':out:' + ts)
        const media = { kind: 'audio', saved: true, file: audio.file, dur: audio.duration_sec, transcript: audio.transcript, status: 'done' }
        addMessage({ messageId: mid, accountKey: ACCOUNT, personId, channel: 'whatsapp', direction: 'outgoing', text: '', media, ts, author: 'humano' })
        upsertWaChat({ accountKey: ACCOUNT, jid, lastText: '[áudio]', lastTs: ts, fromTinder: !!linked })
        bumpSavedAudioUsage(audioId)
        logEvent({ type: 'manual_sent_audio', personId, channel: 'whatsapp', detail: `${audio.title} (/${audio.shortcut})` })
        broadcast({ t: 'message', jid, personId }); broadcast({ t: 'state' })
        return json(res, 200, { ok: true, message: { id: mid, dir: 'out', type: 'audio', ts, audio: { file: audio.file, dur: audio.duration_sec, transcript: audio.transcript, status: 'done', saved: true } }, providerMessageId: r && r.providerMessageId })
      } catch (e) { logEvent({ type: 'manual_audio_error', personId, channel: 'whatsapp', detail: e.message }); return json(res, 500, { ok: false, error: e.message }) }
    }
    // Envio manual pelo WhatsApp direto da conversa.
    if (p === '/api/wa/chat/send') {
      const b = await body(req); const jid = b.jid; const text = String(b.text || '').trim()
      if (!jid || !text) return json(res, 400, { ok: false, error: 'jid/text' })
      const acc = waPool.get(ACCOUNT)
      if (!acc || !acc.sock) return json(res, 400, { ok: false, error: 'whatsapp offline' })
      const linked = personByWaJid(ACCOUNT, jid); const personId = linked || ('wa:' + jid)
      // TRAVA: o WhatsApp não abre conversa (ver src/wa/abertura-a-frio.mjs). Vale pro painel
      // igual: o gatilho é o ato de abrir, não quem digitou.
      const barrado = motivoParaNaoAbrir(ACCOUNT, { personId, jid })
      if (barrado) {
        logEvent({ type: 'wa_abertura_barrada', personId, channel: 'whatsapp', detail: text.slice(0, 90) })
        return json(res, 409, { ok: false, error: barrado })
      }
      try {
        const r = await waSendText(acc.sock, jid, text)
        const ts = Date.now()
        // messageId = id REAL do WhatsApp -> o eco de messages.upsert dedupa (não duplica).
        const mid = 'wa:' + (r && r.providerMessageId ? r.providerMessageId : jid + ':out:' + ts)
        addMessage({ messageId: mid, accountKey: ACCOUNT, personId, channel: 'whatsapp', direction: 'outgoing', text, ts, author: 'humano' })
        upsertWaChat({ accountKey: ACCOUNT, jid, lastText: text, lastTs: ts, fromTinder: !!linked })
        logEvent({ type: 'manual_sent', personId, channel: 'whatsapp', detail: text }); broadcast({ t: 'message', jid, personId })
        return json(res, 200, { ok: true, message: { id: mid, dir: 'out', text, ts }, providerMessageId: r && r.providerMessageId })
      } catch (e) { return json(res, 500, { ok: false, error: e.message }) }
    }
    // Rascunho da IA pra conversa (não envia). Usa o modo da conversa, se setado.
    // O rascunho que ficou pronto DEPOIS de a tela desistir de esperar. Vale pros quatro
    // canais porque a chave é o `pedido` que o painel mandou, não a pessoa nem o canal.
    // Uso único e sem estado no banco — ver `src/panel/rascunho-pendente.mjs`.
    if (p === '/api/rascunho' && req.method === 'GET') {
      const guardado = pegarRascunho(url.searchParams.get('pedido'))
      if (!guardado) return json(res, 404, { ok: false, error: 'nenhum rascunho pendente' })
      return json(res, 200, { ok: true, draft: guardado.texto, ts: guardado.ts, ...(guardado.extra || {}) })
    }
    if (p === '/api/wa/chat/generate') {
      const b = await body(req); const jid = b.jid
      if (!jid) return json(res, 400, { ok: false, error: 'jid' })
      const linked = personByWaJid(ACCOUNT, jid); const personId = linked || ('wa:' + jid)
      const chat = getWaChat(ACCOUNT, jid)
      const name = chat?.name || phoneFromJid(jid)
      try { const draft = await generateDraft({ personId, name, channel: 'whatsapp', chatMode: chat?.mode || null, manual: true }); guardarRascunho(b.pedido, draft); return json(res, 200, { ok: true, draft }) }
      catch (e) { return json(res, 500, { ok: false, error: e.message }) }
    }
    // Modo da conversa (romance-paquera|romance-quente|amigo|negocio|civico|null).
    if (p === '/api/wa/chat/mode') {
      const b = await body(req); const jid = b.jid
      const mode = b.mode && VALID_MODES.includes(b.mode) ? b.mode : null
      if (!jid) return json(res, 400, { ok: false, error: 'jid' })
      if (b.mode && !mode) return json(res, 400, { ok: false, error: 'modo inválido' })
      if (!getWaChat(ACCOUNT, jid)) upsertWaChat({ accountKey: ACCOUNT, jid }) // garante a linha
      waChatSetMode(ACCOUNT, jid, mode)
      logEvent({ type: 'wa_mode', channel: 'whatsapp', detail: jid + ' -> ' + (mode || 'sem modo') })
      broadcast({ t: 'state' })
      return json(res, 200, { ok: true, mode })
    }
    // Override manual do selo "Tinder": {jid, isTinder:false} marca como NÃO sendo do
    // Tinder (some o selo mesmo com vínculo); {jid, isTinder:true} volta ao automático.
    // Perfil do Tinder da pessoa desta conversa (o que o selo "Tinder" abre).
    if (p === '/api/wa/chat/tinder-perfil' && req.method === 'GET') {
      const jid = url.searchParams.get('jid')
      if (!jid) return json(res, 400, { error: 'jid' })
      const perfil = tinderProfileForWaJid(ACCOUNT, jid)
      if (!perfil) return json(res, 404, { error: 'sem vínculo com o Tinder' })
      const conf = conferirVinculo(ACCOUNT, perfil.personId, jid)
      return json(res, 200, { ...perfil, conferencia: { estado: conf.estado, escrito: conf.escrito || null, alvo: conf.alvo || null } })
    }
    if (p === '/api/wa/chat/tinder') {
      const b = await body(req); const jid = b.jid
      if (!jid) return json(res, 400, { ok: false, error: 'jid' })
      if (!getWaChat(ACCOUNT, jid)) upsertWaChat({ accountKey: ACCOUNT, jid })
      waChatSetNotTinder(ACCOUNT, jid, b.isTinder === false ? 1 : 0)
      const fromTinder = cameFromTinder(ACCOUNT, jid) && !getWaChat(ACCOUNT, jid)?.not_tinder
      logEvent({ type: 'wa_tinder_flag', channel: 'whatsapp', detail: jid + ' -> ' + (fromTinder ? 'tinder' : 'nao-tinder') })
      broadcast({ t: 'state' })
      return json(res, 200, { ok: true, fromTinder })
    }
    // Liga/desliga a IA automática nessa conversa (materializa a pessoa e a identity).
    if (p === '/api/wa/chat/ai' || p === '/api/wa/adopt') {
      const b = await body(req); const jid = b.jid; const enable = b.enable != null ? !!b.enable : true
      if (!jid) return json(res, 400, { ok: false, error: 'jid' })
      // TRAVA (a mesma do autoreply, na porta de entrada): a IA de conversa não se liga
      // na minha conversa comigo mesmo. Ali quem responde é o assistente.
      if (ehSelfJid(ACCOUNT, jid)) return json(res, 400, { ok: false, error: 'essa é a sua conversa com o vendas-multicanal — a IA de conversa não entra aqui' })
      let personId = personByWaJid(ACCOUNT, jid)
      if (!personId) { personId = 'wa:' + jid; const chat = getWaChat(ACCOUNT, jid); upsertPerson({ personId, accountKey: ACCOUNT, name: (chat && chat.name) || phoneFromJid(jid) }); linkIdentity({ accountKey: ACCOUNT, channel: 'whatsapp', channelId: jid, personId, method: 'manual' }) }
      upsertWaChat({ accountKey: ACCOUNT, jid, adopted: enable })
      setAiSetting({ personId, channel: 'whatsapp', enabled: enable, state: 'idle' })
      if (enable && responderAgoraSePendente({ personId, channel: 'whatsapp' })) cutucarCanal('whatsapp')
      logEvent({ type: enable ? 'ai_on' : 'ai_off', personId, channel: 'whatsapp', detail: jid }); broadcast({ t: 'state' })
      return json(res, 200, { ok: true, aiOn: enable, personId })
    }
    if (p.startsWith('/api/wa/review/')) { const id = p.split('/')[4]; const b = await body(req); const rev = db().prepare(`SELECT * FROM wa_link_review WHERE id=?`).get(id); if (rev && b.action === 'confirm') linkIdentity({ accountKey: ACCOUNT, channel: 'whatsapp', channelId: rev.wa_jid, personId: rev.candidate_person_id, method: 'heuristic' }); resolveLinkReview(id, b.action === 'confirm' ? 'confirmed' : 'rejected'); broadcast({ t: 'state' }); return json(res, 200, { ok: true }) }
    // ---------- Instagram (DMs via Chrome real logado, mesma lógica de IA) ----------
    if (p === '/api/ig') {
      const me = getIgMe()
      const e = estadoHonesto('instagram', !!me)
      return json(res, 200, { status: e.status, motivo: e.motivo, desde: e.desde, comoResolver: e.comoResolver, me })
    }
    // Interpretação de mídia (IA "vê" imagem/vídeo recebido). GASTA tokens — nasce desligada.
    if (p === '/api/ig/media-interpret') {
      if (req.method === 'POST') { const b = await body(req); setSetting('media_interpret', !!b.enabled); logEvent({ type: 'ig_media_toggle', channel: 'instagram', detail: b.enabled ? 'ligado' : 'desligado' }); broadcast({ t: 'state' }) }
      return json(res, 200, { enabled: !!getSetting('media_interpret', false) })
    }
    // ---------- Badoo (API JSON própria, sessão por cookies importados) ----------
    // Estado do canal. NÃO usa `checarSessao`: aquela checagem passa pelo caminho HTTP
    // direto, que é impossível por desenho (assinatura x-pingback) e respondia EXPIRED com a
    // sessão viva. O estado honesto vem da última lista que o Chrome trouxe de verdade.
    if (p === '/api/badoo' && req.method === 'GET') return json(res, 200, estadoBadoo(ACCOUNT))
    // Radiografia do DOM do Badoo — roda DENTRO do núcleo (rodar de outro processo disputa
    // a aba do Chrome com o Instagram e trava, armadilha já conhecida deste projeto).
    if (p === '/api/badoo/explorar' && req.method === 'POST') {
      const b = await body(req)
      try {
        const r = await badooExclusive(async () => {
          const page = await badooPage()
          if (b.consentimento) { await badooAbrirLista(page); return badooConsentimento(page) }
          if (b.escutar) {
            // Deixa o APP fazer as chamadas (ele assina) e a gente LÊ as respostas. É assim
            // que se pega o id de cada conversa sem clicar em nada e sem forjar assinatura.
            const capturado = []
            const ouvinte = async (resp) => {
              if (!/mwebapi\.phtml/.test(resp.url())) return
              try {
                const j = await resp.json()
                for (const m of j.body || []) {
                  const lista = m.client_user_list
                  if (!lista) continue
                  for (const sec of lista.section || []) for (const u of sec.users || []) {
                    capturado.push({ id: u.user_id, nome: u.name || null, previa: u.display_message || null,
                                     naoLida: !!u.is_unread, ts: u.sort_timestamp ? u.sort_timestamp * 1000 : null })
                  }
                }
              } catch { /* resposta não-JSON */ }
            }
            page.on('response', ouvinte)
            // força o app a recarregar a lista, do jeito dele
            await page.goto('https://badoo.com/pt/connections', { waitUntil: 'domcontentloaded' }).catch(() => {})
            await page.waitForTimeout(9000)
            page.off('response', ouvinte)
            const vistos = new Set()
            const conversas = capturado.filter((c) => c.id && !vistos.has(c.id) && vistos.add(c.id))
            return { conversas: conversas.slice(0, 60), total: conversas.length }
          }
          if (b.cru) {
            // RAIO-X do protocolo: navega e despeja o objeto CRU que o app deles recebe.
            // O borrado da tela é CSS; o payload pode vir inteiro (é a lição do sticker
            // animado no WhatsApp — a camada de cima mente, o objeto cru não).
            const pacotes = []
            const ouvinte = async (resp) => {
              if (!/mwebapi\.phtml/.test(resp.url())) return
              try { const j = await resp.json(); for (const m of j.body || []) pacotes.push(m) } catch { /* não-JSON */ }
            }
            page.on('response', ouvinte)
            await page.goto(b.url || 'https://badoo.com/pt/liked-you', { waitUntil: 'domcontentloaded' }).catch(() => {})
            await page.waitForTimeout(4000)
            await badooConsentimento(page).catch(() => {})
            await page.waitForTimeout(6000)
            page.off('response', ouvinte)
            // procura QUALQUER array de gente no meio dos pacotes, sem supor onde
            const gente = []
            const varrer = (o, caminho, prof = 0) => {
              if (!o || typeof o !== 'object' || prof > 8) return
              if (Array.isArray(o)) {
                if (o.length && o[0] && typeof o[0] === 'object' && ('user_id' in o[0] || 'name' in o[0] || 'age' in o[0])) {
                  gente.push({ caminho, quantos: o.length, chaves: Object.keys(o[0]),
                    amostra: o.slice(0, 3).map((u) => ({ user_id: u.user_id, name: u.name, age: u.age,
                      foto: u.profile_photo?.large_url || u.profile_photo?.preview_url || null,
                      is_locked: u.is_locked, blocked: u.blocked_by_me })) })
                }
                o.forEach((v, i) => varrer(v, `${caminho}[${i}]`, prof + 1))
                return
              }
              for (const [k, v] of Object.entries(o)) if (k !== '$gpb') varrer(v, caminho ? `${caminho}.${k}` : k, prof + 1)
            }
            for (const m of pacotes) varrer(m, `t${m.message_type}:${Object.keys(m).filter((k) => k !== '$gpb' && k !== 'message_type')[0] || ''}`)
            // despeja INTEIRO o pacote pedido por número: é o raio-x de verdade
            const alvoTipo = Number(b.tipo) || null
            const inteiro = alvoTipo ? pacotes.filter((m) => m.message_type === alvoTipo).map((m) => JSON.stringify(m).slice(0, 4000)) : null
            // quem é a pessoa DA CONVERSA (chat_user): é o id dela, não o da conversa
            const donoDaConversa = pacotes.map((m) => m.client_open_chat?.chat_user).find(Boolean) || null
            // extrai a lista de gente do client_user_list SEM cortar: é o dado que importa
            const usuarios = []
            for (const m of pacotes) {
              const u = m.user
              if (!u) continue
              usuarios.push({ user_id: u.user_id, name: u.name || null, age: u.age || null,
                album: u.albums?.[0]?.name || null, fotos: u.albums?.[0]?.count_of_photos || 0,
                foto: u.profile_photo?.large_url || null,
                campos: (u.profile_fields || []).map((f) => `${f.name}=${String(f.display_value || f.value || '').slice(0, 40)}`).slice(0, 8),
                chaves: Object.keys(u), origem: 'perfil' })
            }
            for (const m of pacotes) {
              for (const sec of m.client_user_list?.section || []) {
                for (const u of sec.users || []) {
                  usuarios.push({ user_id: u.user_id, name: u.name || null, age: u.age || null,
                    album: u.albums?.[0]?.name || null, fotos: u.albums?.[0]?.count_of_photos || 0,
                    chaves: Object.keys(u), total: sec.total_count })
                }
              }
            }
            return {
              donoDaConversa: donoDaConversa ? { user_id: donoDaConversa.user_id, name: donoDaConversa.name, age: donoDaConversa.age,
                campos: (donoDaConversa.profile_fields || []).map((f) => ({ id: f.id, tipo: f.type, nome: f.name, valor: f.display_value ?? f.value })),
                quantosCampos: (donoDaConversa.profile_fields || []).length, projection: donoDaConversa.projection } : null,
              usuarios: usuarios.slice(0, 20), inteiro,
              tipos: pacotes.map((m) => ({ tipo: m.message_type, nome: Object.keys(m).filter((k) => k !== '$gpb' && k !== 'message_type')[0] || null, gpb: m.$gpb || null })),
              gente: gente.slice(0, 6),
            }
          }
          if (b.curtidas) {
            // A fila de quem JÁ te curtiu. Não tem URL própria: é um item da lista de
            // conexões (data-qa-connections-item-type="liked-you"). Clica nele e vê o que
            // aparece — perfis e, com sorte, os botões de curtir/passar.
            const pacotes = []
            const ouvinte = async (resp) => {
              if (!/mwebapi\.phtml/.test(resp.url())) return
              try { const j = await resp.json(); for (const m of j.body || []) pacotes.push({ tipo: m.message_type, chaves: Object.keys(m).filter((k) => k !== '$gpb' && k !== 'message_type'), dado: m }) } catch { /* não-JSON */ }
            }
            // navegação FORÇADA: abrirLista não sai de /messages (ela considera que já está
            // "na lista"), e a fila de curtidas só existe na tela de conexões
            await page.goto('https://badoo.com/pt/connections', { waitUntil: 'domcontentloaded' }).catch(() => {})
            await page.waitForTimeout(3500)
            await badooConsentimento(page).catch(() => {})
            await page.waitForTimeout(2500)
            page.on('response', ouvinte)
            const alvo = page.locator('[data-qa-connections-item-type="liked-you"]').first()
            let clique = 'nao achei o cartao'
            if (await alvo.count()) {
              const cx = await alvo.boundingBox()
              if (cx) { await page.mouse.click(cx.x + cx.width / 2, cx.y + cx.height / 2); clique = 'cliquei' }
            }
            await page.waitForTimeout(7000)
            page.off('response', ouvinte)
            const dentro = await page.evaluate(() => {
              const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 6 && r.height > 6 }
              const t = (el) => (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 45)
              const censo = {}
              for (const el of document.querySelectorAll('[data-qa]')) { const q = el.getAttribute('data-qa'); censo[q] = (censo[q] || 0) + 1 }
              return {
                url: location.href,
                titulo: (document.querySelector('h1,[data-qa="navbar-title"]') || {}).innerText || '',
                texto: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 260),
                botoes: [...document.querySelectorAll('button,[role="button"]')].filter(vis)
                  .map((el) => ({ qa: el.getAttribute('data-qa') || null, txt: t(el) })).slice(0, 30),
                repetidos: Object.entries(censo).filter(([, n]) => n > 2).sort((a, b2) => b2[1] - a[1]).slice(0, 12),
                fotos: document.querySelectorAll('img').length,
              }
            })
            try { await page.screenshot({ path: '/tmp/badoo-curtidas.png' }) } catch { /* sem foto */ }
            return { clique, tipos: pacotes.map((x) => ({ tipo: x.tipo, chaves: x.chaves })), dentro }
          }
          if (b.mapa) {
            // Mapa cru da tela: pra onde dá pra ir e no que dá pra clicar. Serve pra achar a
            // fila de "quem te curtiu" sem adivinhar URL (o Badoo não publica rota estável).
            await page.goto(b.url || 'https://badoo.com/pt/connections', { waitUntil: 'domcontentloaded' }).catch(() => {})
            await page.waitForTimeout(3500)
            await badooConsentimento(page).catch(() => {})
            await page.waitForTimeout(2500)
            const mapa = await page.evaluate(() => {
              const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 6 && r.height > 6 }
              const t = (el) => (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40)
              return {
                url: location.href,
                links: [...document.querySelectorAll('a[href]')].filter(vis).map((a) => ({ href: a.getAttribute('href'), txt: t(a) })).slice(0, 40),
                botoes: [...document.querySelectorAll('button,[role="button"]')].filter(vis)
                  .map((el) => ({ qa: el.getAttribute('data-qa') || el.getAttribute('data-qa-role') || null, txt: t(el) })).slice(0, 40),
                curtiram: [...document.querySelectorAll('[data-qa-connections-item-type="liked-you"], [data-qa*="liked"], [data-qa*="curtid"]')]
                  .map((el) => ({ qa: el.getAttribute('data-qa'), tipo: el.getAttribute('data-qa-connections-item-type'), txt: t(el) })).slice(0, 20),
              }
            })
            try { await page.screenshot({ path: '/tmp/badoo-mapa.png' }) } catch { /* sem foto */ }
            return mapa
          }
          if (b.baralho) {
            // RECONHECIMENTO do swipe do Badoo: abre a tela de descoberta e escuta o que o
            // app deles recebe. `server_get_encounters` (81) traz o baralho e
            // `server_encounters_vote` (80) é o like/passar — mas nós não forjamos nenhum
            // dos dois (§10): quem chama é o app, e o clique é no DOM. Isto aqui só LÊ.
            const pacotes = []
            const ouvinte = async (resp) => {
              if (!/mwebapi\.phtml/.test(resp.url())) return
              try {
                const j = await resp.json()
                for (const m of j.body || []) pacotes.push({ tipo: m.message_type, chaves: Object.keys(m).filter((k) => k !== '$gpb' && k !== 'message_type'), dado: m })
              } catch { /* não-JSON */ }
            }
            page.on('response', ouvinte)
            await page.goto(b.url || 'https://badoo.com/encounters', { waitUntil: 'domcontentloaded' }).catch(() => {})
            await page.waitForTimeout(4000)
            await badooConsentimento(page).catch(() => {})
            await page.waitForTimeout(6000)
            page.off('response', ouvinte)
            // procura o baralho: qualquer array cujos itens tenham cara de perfil
            let perfis = null, onde = null
            const varrer = (o, caminho, prof = 0) => {
              if (!o || typeof o !== 'object' || perfis || prof > 6) return
              if (Array.isArray(o)) {
                if (o.length && o[0] && typeof o[0] === 'object' && ('user_id' in o[0] || 'name' in o[0]) && ('age' in o[0] || 'profile_photo' in o[0] || 'albums' in o[0])) { perfis = o; onde = caminho; return }
                o.forEach((v, i) => varrer(v, `${caminho}[${i}]`, prof + 1))
                return
              }
              for (const [k, v] of Object.entries(o)) varrer(v, caminho ? `${caminho}.${k}` : k, prof + 1)
            }
            for (const p2 of pacotes) varrer(p2.dado, `tipo${p2.tipo}`)
            const raio = await badooRadiografar(page)
            try { await page.screenshot({ path: '/tmp/badoo-baralho.png' }) } catch { /* sem foto */ }
            return {
              url: page.url(),
              tipos: pacotes.map((x) => ({ tipo: x.tipo, chaves: x.chaves })),
              baralhoEm: onde, quantos: perfis ? perfis.length : 0,
              amostra: perfis ? perfis.slice(0, 2).map((x) => ({ chaves: Object.keys(x), user_id: x.user_id, name: x.name, age: x.age })) : null,
              raio,
            }
          }
          if (b.conversa) {
            // Navega DIRETO pra /messages/<id> e escuta a resposta que o app recebe: é ali
            // que vem o histórico, assinado por eles. Sem clique e sem forjar nada.
            const pacotes = []
            const ouvinte = async (resp) => {
              if (!/mwebapi\.phtml/.test(resp.url())) return
              try {
                const j = await resp.json()
                for (const m of j.body || []) {
                  const chaves = Object.keys(m).filter((k) => k !== '$gpb' && k !== 'message_type')
                  pacotes.push({ tipo: m.message_type, chaves, dado: m })
                }
              } catch { /* não-JSON */ }
            }
            page.on('response', ouvinte)
            await page.goto('https://badoo.com/messages/' + b.conversa, { waitUntil: 'domcontentloaded' }).catch(() => {})
            await page.waitForTimeout(9000)
            page.off('response', ouvinte)
            // procura mensagens em qualquer pacote (array cujos itens têm `mssg`)
            let mensagens = null, onde = null
            const varrer = (o, caminho) => {
              if (!o || typeof o !== 'object' || mensagens) return
              if (Array.isArray(o)) {
                if (o.length && o[0] && typeof o[0] === 'object' && 'mssg' in o[0]) { mensagens = o; onde = caminho; return }
                o.forEach((v, i) => varrer(v, `${caminho}[${i}]`))
                return
              }
              for (const [k, v] of Object.entries(o)) varrer(v, caminho ? `${caminho}.${k}` : k)
            }
            for (const p of pacotes) varrer(p.dado, 'tipo' + p.tipo)
            return {
              url: page.url(),
              tiposRecebidos: pacotes.map((p) => p.tipo + ':' + p.chaves.join('|')).slice(0, 12),
              mensagensEm: onde,
              mensagens: (mensagens || []).slice(-8).map((m) => ({
                de: String(m.from_person_id || '').slice(0, 14), texto: String(m.mssg || '').slice(0, 60),
                ts: m.date_modified || m.date || null, tipo: m.message_type,
              })),
              total: (mensagens || []).length,
              camposDeUma: mensagens && mensagens[0] ? Object.keys(mensagens[0]).join(',') : null,
            }
          }
          if (b.passoApasso) {  // clica com foto a cada passo — pra VER, não adivinhar
            await badooAbrirLista(page)
            const nome = b.passoApasso
            const erros = []
            page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 120)) })
            const alvo = page.locator('[data-qa="connections-item"][data-qa-connections-item-type="user"]')
              .filter({ hasText: nome }).first()
            if (!(await alvo.count())) return { erro: 'linha não achada' }
            // CENTRALIZA na tela: o scrollIntoViewIfNeeded encosta o item no rodapé, e o
            // clique cai na barra de navegação de baixo (aconteceu: mouse em y=858).
            await alvo.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => {})
            await page.waitForTimeout(900)
            await page.screenshot({ path: '/tmp/badoo-1-antes.png' })
            const conteudo = alvo.locator('.csms-connections-item__content').first()
            const cx = await (await conteudo.count() ? conteudo : alvo).boundingBox()
            const antes = page.url()
            const passos = []
            if (cx) {
              const x = cx.x + cx.width / 2, y = cx.y + cx.height / 2
              await page.mouse.move(x, y); await page.waitForTimeout(200)
              await page.mouse.down(); await page.waitForTimeout(120)
              await page.mouse.up()
              passos.push(`mouse em ${Math.round(x)},${Math.round(y)}`)
            } else passos.push('sem caixa na tela')
            await page.waitForTimeout(4000)
            await page.screenshot({ path: '/tmp/badoo-2-depois.png' })
            return { antes, depois: page.url(), passos, erros: erros.slice(0, 5),
                     composer: await page.evaluate(() => !!document.querySelector('textarea,[contenteditable="true"]')),
                     tela: await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200)) }
          }
          if (b.linha) {   // o HTML de uma linha REAL de conversa (não o card de curtidas)
            await badooAbrirLista(page)
            return page.evaluate((nome) => {
              const t = (el) => ((el && el.innerText) || '').replace(/\s+/g, ' ').trim()
              const itens = [...document.querySelectorAll('[data-qa="connections-item"]')]
                .filter((el) => el.getAttribute('data-qa-connections-item-type') !== 'liked-you')
              const el = nome ? itens.find((x) => t(x.querySelector('[data-qa="profile-info__name"]')) === nome) : itens[0]
              if (!el) return { erro: 'linha não encontrada', total: itens.length }
              // procura QUALQUER id de conversa escondido no elemento ou nos pais
              const atributos = {}
              let cur = el
              for (let i = 0; i < 4 && cur; i++, cur = cur.parentElement) {
                for (const a of cur.attributes || []) if (!/^class$|^style$/.test(a.name)) atributos[i + ':' + a.name] = String(a.value).slice(0, 120)
              }
              const props = Object.keys(el).filter((k) => /^__react|^_reactProps/.test(k))
              let reactProps = null
              try {
                const k = props.find((x) => /Props/.test(x))
                if (k) reactProps = Object.keys(el[k] || {}).join(',')
              } catch { /* sem react */ }
              return { tag: el.tagName.toLowerCase(), nome: t(el.querySelector('[data-qa="profile-info__name"]')),
                       atributos, reactProps, html: el.outerHTML.slice(0, 900), total: itens.length }
            }, b.linha === true ? null : b.linha)
          }
          if (b.frames) {  // onde, afinal, mora a lista: main frame ou iframe?
            await badooAbrirLista(page)
            const out = []
            for (const f of page.frames()) {
              let n = 0, viaDom = 0
              try { n = await f.locator('button[data-qa="connections-item"]').count() } catch {}
              try { viaDom = await f.evaluate(() => document.querySelectorAll('button[data-qa="connections-item"]').length) } catch {}
              out.push({ url: String(f.url()).slice(0, 60), porLocator: n, porDom: viaDom })
            }
            return { frames: out }
          }
          if (b.foto) {   // só abre a lista e fotografa — pra ver o que o Chrome está mostrando
            await badooAbrirLista(page)
            await page.screenshot({ path: '/tmp/badoo-tela.png' })
            const n = await page.locator('button[data-qa="connections-item"]').count()
            return { fotografou: true, botoes: n, url: page.url() }
          }
          if (b.html) {   // o HTML cru de uma linha da lista: é como se descobre o que é clicável
            await badooAbrirLista(page)
            return page.evaluate(() => {
              const el = document.querySelector('[data-qa="connections-list-item"]')
              if (!el) return { erro: 'nenhuma linha encontrada' }
              const r = el.getBoundingClientRect()
              return { html: el.outerHTML.slice(0, 2200), tam: { l: Math.round(r.width), a: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) },
                       noPonto: (document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) || {}).outerHTML?.slice(0, 200) }
            })
          }
          if (b.chatId) await badooAbrirConversa(page, b.chatId)
          else await badooAbrirLista(page)
          if (b.nome) {                      // clicar numa conversa pelo nome e radiografar lá dentro
            const id = await badooAbrirPeloNome(page, b.nome)
            const raio = await badooRadiografar(page)
            // uma foto da tela vale mais que adivinhar seletor no escuro
            try { await page.screenshot({ path: '/tmp/badoo-tela.png' }) } catch { /* sem foto */ }
            return { abriu: id, ...raio }
          }
          if (b.lista) return badooLerLista(page)
          return badooRadiografar(page)
        })
        return json(res, 200, r)
      } catch (e) { return json(res, 500, { error: e.message }) }
    }
    if (p === '/api/badoo/sync' && req.method === 'POST') {
      const b = await body(req)
      // Assíncrono é o que o botão do painel usa: a lista sozinha leva ~12s e cada conversa
      // com novidade custa mais uma navegação. A tela não espera — o WS avisa quando acaba.
      if (b.assincrono) {
        badooSincronizarNovidades({ accountKey: ACCOUNT, max: Number(b.max) || 6 })
          .then(() => broadcast({ t: 'state' }))
          .catch((e) => logEvent({ type: 'badoo_erro', channel: 'badoo', detail: e.message }))
        return json(res, 200, { ok: true, iniciado: true })
      }
      try {
        if (b.chatId) return json(res, 200, await badooSincronizarConversa({ accountKey: ACCOUNT, chatId: b.chatId }))
        const lista = await badooSincronizarLista({ accountKey: ACCOUNT })
        const detalhadas = b.comMensagens ? await badooSincronizarRecentes({ accountKey: ACCOUNT, max: Number(b.max) || 5 }) : []
        broadcast({ t: 'state' })
        return json(res, 200, { conversasNaLista: lista.conversas, detalhadas })
      } catch (e) { return json(res, 500, { error: e.message }) }
    }
    if (p === '/api/badoo/chats' && req.method === 'GET') {
      return json(res, 200, badooChats(ACCOUNT).map((c) => {
        const personId = badooPersonId(c.chat_id)
        return {
          chatId: c.chat_id, nome: c.name, previa: c.previa, foto: c.foto, lastTs: c.last_ts,
          naoLida: !!c.unread, personId,
          mensagens: countChannelMessages(personId, 'badoo'),
          metricas: metricasDaConversa(personId, ACCOUNT),
          aiOn: !!getAiSetting(personId, 'badoo')?.enabled,
        }
      }))
    }
    // Uma conversa: o que está no banco. A releitura ao vivo vai em segundo plano (é uma
    // navegação de ~8s no Chrome) e avisa pelo WS quando chega — a tela não fica esperando.
    if (p === '/api/badoo/conversa' && req.method === 'GET') {
      const chatId = url.searchParams.get('chatId')
      if (!chatId) return json(res, 400, { error: 'chatId' })
      const chat = getBadooChat(ACCOUNT, chatId)
      const personId = badooPersonId(chatId)
      // `vivo=1` só quando a conversa ABRE. O poll da tela não pede: cada releitura é uma
      // navegação no Chrome, e sondar de 8 em 8 segundos derrubaria a aba do Instagram junto.
      if (url.searchParams.get('vivo') === '1') {
        badooSincronizarConversa({ accountKey: ACCOUNT, chatId })
          .then((r) => { if (r && r.novas) broadcast({ t: 'message', personId }) })
          .catch(() => {})
      }
      const messages = channelMessages(personId, 'badoo', 200).map((m) => ({
        id: m.message_id, dir: m.direction === 'outgoing' ? 'out' : 'in', text: m.text, ts: m.ts, type: 'texto', autor: m.author || null,
      }))
      const vd = verdictsByMessageIds(messages.filter((m) => m.dir === 'out').map((m) => m.id))
      for (const m of messages) if (vd[m.id]) m.veredito = vd[m.id]
      return json(res, 200, { chatId, nome: chat?.name || null, foto: chat?.foto || null, personId,
        aiOn: !!getAiSetting(personId, 'badoo')?.enabled, messages, metricas: metricasDaConversa(personId, ACCOUNT) })
    }
    if (p === '/api/badoo/enviar' && req.method === 'POST') {
      const b = await body(req)
      if (!b.chatId || !b.texto) return json(res, 400, { error: 'chatId e texto' })
      // veio do painel = palavras do dono (docs/QUEM-ESCREVEU.md); a IA carimba 'ia' por dentro
      try {
        const r = await badooEnviarRascunhoComMidia({ accountKey: ACCOUNT, personId: badooPersonId(b.chatId), chatId: b.chatId,
          draft: b.texto, author: b.author || 'humano', protegerAudio: false })
        broadcast({ t: 'message', personId: badooPersonId(b.chatId) })
        return json(res, 200, { ok: true, comprovado: true, ...r })
      } catch (e) { return json(res, 500, { error: e.message }) }
    }
    if (p === '/api/badoo/enviar-audio' && req.method === 'POST') {
      const b = await body(req)
      const audio = getSavedAudio(b.audioId)
      if (!b.chatId || !b.audioId) return json(res, 400, { error: 'chatId e audioId' })
      if (!audio || !audio.active) return json(res, 404, { error: 'áudio salvo não encontrado ou inativo' })
      try {
        const r = await badooEnviarAudioSalvo({ chatId: b.chatId, audio })
        badooRegistrarAudioEnviado({ accountKey: ACCOUNT, personId: badooPersonId(b.chatId), audio, receipt: r, author: 'humano' })
        bumpSavedAudioUsage(audio.id)
        // O recibo 151 é a fonte de verdade do envio. A releitura só atualiza a conversa no
        // painel, sem transformar uma confirmação já recebida numa falsa falha.
        badooSincronizarConversa({ accountKey: ACCOUNT, chatId: b.chatId })
          .then(() => broadcast({ t: 'message', personId: badooPersonId(b.chatId) }))
          .catch(() => {})
        broadcast({ t: 'message', personId: badooPersonId(b.chatId) })
        return json(res, 200, r)
      } catch (e) { return json(res, 500, { error: e.message }) }
    }
    // ---------- descoberta do Badoo: a fila de quem já te curtiu ----------
    if (p === '/api/badoo/curtidas' && req.method === 'GET') {
      try { const r = await lerCurtidas({ max: 40 }); return json(res, 200, { estado: estadoDescobertaBadoo(), bloqueada: r.bloqueada, fila: r.fila }) }
      catch (e) { return json(res, 500, { error: e.message }) }
    }
    if (p === '/api/badoo/curtidas/config' && req.method === 'POST') {
      const b = await body(req)
      const e = ligarDescobertaBadoo(b)
      logEvent({ type: 'badoo_swipe_config', channel: 'badoo', detail: `ligado=${e.ligado} sombra=${e.sombra} porSessao=${e.porSessao}` })
      broadcast({ t: 'state' })
      return json(res, 200, e)
    }
    if (p === '/api/badoo/curtidas/rodar' && req.method === 'POST') {
      const b = await body(req)
      // sombra é o padrão SEMPRE: sair dela exige o pedido explícito, aqui e no agendador
      const sombra = b.sombra != null ? !!b.sombra : estadoDescobertaBadoo().sombra
      try { return json(res, 200, await rodarSessaoCurtidas({ accountKey: ACCOUNT, max: Number(b.max) || 6, dryRun: sombra })) }
      catch (e) { return json(res, 500, { error: e.message }) }
    }
    if (p === '/api/badoo/curtidas/perfil' && req.method === 'POST') {
      const b = await body(req)
      try { return json(res, 200, await abrirPerfilDaCurtida({ indice: Number(b.indice) || 1 })) }
      catch (e) { return json(res, 500, { error: e.message }) }
    }
    if (p === '/api/badoo/curtidas/acao' && req.method === 'POST') {
      const b = await body(req)
      if (!['like', 'pass'].includes(b.acao)) return json(res, 400, { error: 'acao' })
      try { const r = await agirNaCurtida({ indice: Number(b.indice) || 1, acao: b.acao }); broadcast({ t: 'state' }); return json(res, 200, r) }
      catch (e) { return json(res, 500, { error: e.message }) }
    }
    // Deslizar no baralho de Encontros. Roda AQUI dentro de propósito: a aba do Badoo é uma
    // só e o `badooExclusive` só serializa dentro do processo — script por fora disputa o
    // Chrome com o sync e navega a aba por baixo do voto.
    if (p === '/api/chrome/abas' && req.method === 'GET') return json(res, 200, await faxinaDeAbas({ seco: true }))
    if (p === '/api/chrome/abas' && req.method === 'POST') { const r = await faxinaDeAbas(); broadcast({ t: 'state' }); return json(res, 200, r) }
    if (p === '/api/badoo/encontros' && req.method === 'GET') return json(res, 200, estadoEncontros())
    if (p === '/api/badoo/encontros/config' && req.method === 'POST') {
      const b = await body(req)
      const r = ligarEncontros({ ligado: b.ligado, sombra: b.sombra, tetos: b.tetos, modo: b.modo, ritmo: b.ritmo })
      logEvent({ type: 'badoo_encontros_config', channel: 'badoo', detail: `agendador ${r.ligado ? 'ligado' : 'desligado'}, ${r.sombra ? 'sombra' : 'VALENDO'}` })
      broadcast({ t: 'state' })
      return json(res, 200, r)
    }
    if (p === '/api/badoo/encontros/deslizar' && req.method === 'POST') {
      const b = await body(req)
      const quantos = Math.max(1, Math.min(Number(b.quantos) || 10, 200))
      const dryRun = b.dryRun !== false
      try {
        const r = await deslizarEncontros({ quantos, dryRun, accountKey: ACCOUNT })
        if (!dryRun) broadcast({ t: 'state' })
        return json(res, 200, r)
      } catch (e) { return json(res, 500, { error: e.message }) }
    }

    if (p === '/api/badoo/perfil' && req.method === 'POST') {
      const b = await body(req)
      if (!b.chatId) return json(res, 400, { error: 'chatId' })
      try { return json(res, 200, { perfil: await badooLerPerfil({ accountKey: ACCOUNT, chatId: b.chatId }) }) }
      catch (e) { return json(res, 500, { error: e.message }) }
    }
    if (p === '/api/badoo/gerar' && req.method === 'POST') {
      const b = await body(req)
      if (!b.chatId) return json(res, 400, { ok: false, error: 'chatId' })
      const chat = getBadooChat(ACCOUNT, b.chatId)
      // o perfil dela entra na geração (o que faltava): lê do banco, e busca ao vivo na 1a vez
      let profile = getBadooPerfil(ACCOUNT, b.chatId)
      if (!profile && b.semPerfil !== true) profile = await badooLerPerfil({ accountKey: ACCOUNT, chatId: b.chatId }).catch(() => null)
      if (b.semPerfil === true) profile = null
      try { const draft = await generateDraft({ personId: badooPersonId(b.chatId), name: chat?.name, channel: 'badoo', profile, chatMode: chat?.mode || null, manual: true }); guardarRascunho(b.pedido, draft, { comPerfil: !!profile }); return json(res, 200, { ok: true, draft, comPerfil: !!profile }) }
      catch (e) { return json(res, 500, { ok: false, error: e.message }) }
    }
    if (p === '/api/badoo/ia' && req.method === 'POST') {
      const b = await body(req)
      if (!b.chatId) return json(res, 400, { ok: false, error: 'chatId' })
      const enable = b.enable != null ? !!b.enable : true
      const personId = badooPersonId(b.chatId)
      setAiSetting({ personId, channel: 'badoo', enabled: enable, state: 'idle' })
      if (enable && responderAgoraSePendente({ personId, channel: 'badoo' })) cutucarCanal('badoo')
      // SEM MENSAGEM NENHUMA = ABRIR A CONVERSA. No Badoo a conversa nasce de uma visita ao
      // perfil, sem ninguém ter escrito: o caminho reativo nunca sairia do lugar. Roda em
      // segundo plano porque é navegação (lê o perfil, escreve no composer) e a resposta do
      // clique não pode ficar pendurada nisso. Só neste canal, e só no clique — ver a
      // justificativa em `badooIniciarConversa`.
      else if (enable) {
        void badooIniciarConversa({ accountKey: ACCOUNT, personId, sendEnabled: getSetting('send_enabled', true) })
          .then((r) => { if (r) broadcast({ t: 'message', personId }) })
          .catch(() => { /* o próprio abridor já registra o erro no Diário */ })
      }
      logEvent({ type: enable ? 'ai_on' : 'ai_off', personId, channel: 'badoo', detail: b.chatId })
      broadcast({ t: 'state' })
      return json(res, 200, { ok: true, aiOn: enable, personId })
    }
    // ---------- Telegram: lista, conversa, envio, toggle de IA ----------
    if (p === '/api/tg/chats' && req.method === 'GET') {
      return json(res, 200, telegramChats(ACCOUNT).map((c) => {
        const personId = tgPersonId(c.chat_id)
        return {
          chatId: c.chat_id, nome: c.nome || null, username: c.username || null, previa: c.previa || null,
          lastTs: c.last_ts, naoLida: !!c.unread, personId,
          mensagens: countChannelMessages(personId, 'telegram'),
          metricas: metricasDaConversa(personId, ACCOUNT),
          aiOn: !!getAiSetting(personId, 'telegram')?.enabled,
        }
      }))
    }
    if (p === '/api/tg/conversa' && req.method === 'GET') {
      const chatId = url.searchParams.get('chatId')
      if (!chatId) return json(res, 400, { error: 'chatId' })
      const chat = getTelegramChat(ACCOUNT, chatId)
      const personId = tgPersonId(chatId)
      const messages = channelMessages(personId, 'telegram', 200).map((m) => ({
        id: m.message_id, dir: m.direction === 'outgoing' ? 'out' : 'in', text: m.text, ts: m.ts, type: 'texto', autor: m.author || null,
      }))
      const vd = verdictsByMessageIds(messages.filter((m) => m.dir === 'out').map((m) => m.id))
      for (const m of messages) if (vd[m.id]) m.veredito = vd[m.id]
      return json(res, 200, { chatId, nome: chat?.nome || null, username: chat?.username || null, personId,
        aiOn: !!getAiSetting(personId, 'telegram')?.enabled, messages, metricas: metricasDaConversa(personId, ACCOUNT) })
    }
    if (p === '/api/tg/enviar' && req.method === 'POST') {
      const b = await body(req)
      if (!b.chatId || !b.texto) return json(res, 400, { error: 'chatId e texto' })
      try {
        const r = await enviarTelegram({ accountKey: ACCOUNT, chatId: b.chatId, texto: b.texto, author: b.author || 'humano' })
        broadcast({ t: 'message', personId: tgPersonId(b.chatId) })
        return json(res, 200, r)
      } catch (e) { return json(res, 500, { error: e.message }) }
    }
    if (p === '/api/tg/ia' && req.method === 'POST') {
      const b = await body(req)
      if (!b.chatId) return json(res, 400, { ok: false, error: 'chatId' })
      const enable = b.enable != null ? !!b.enable : true
      const personId = tgPersonId(b.chatId)
      setAiSetting({ personId, channel: 'telegram', enabled: enable, state: 'idle' })
      logEvent({ type: enable ? 'ai_on' : 'ai_off', personId, channel: 'telegram', detail: b.chatId })
      broadcast({ t: 'state' })
      return json(res, 200, { ok: true, aiOn: enable, personId })
    }
    // ---------- Meu Patrocínio: lista, conversa, envio, toggle de IA ----------
    if (p === '/api/mp/chats' && req.method === 'GET') {
      return json(res, 200, mpChats(ACCOUNT).map((c) => {
        const personId = mpPersonId(c.peer_id)
        return {
          peerId: c.peer_id, nome: c.nome || null, previa: c.previa || null, foto: c.foto || null,
          lastTs: c.last_ts, naoLida: !!c.unread, personId,
          mensagens: countChannelMessages(personId, 'meupatrocinio'),
          metricas: metricasDaConversa(personId, ACCOUNT),
          aiOn: !!getAiSetting(personId, 'meupatrocinio')?.enabled,
        }
      }))
    }
    if (p === '/api/mp/conversa' && req.method === 'GET') {
      const peerId = url.searchParams.get('peerId')
      if (!peerId) return json(res, 400, { error: 'peerId' })
      const chat = getMpChat(ACCOUNT, peerId)
      const personId = mpPersonId(peerId)
      const messages = channelMessages(personId, 'meupatrocinio', 200).map((m) => ({
        id: m.message_id, dir: m.direction === 'outgoing' ? 'out' : 'in', text: m.text, ts: m.ts, type: 'texto', autor: m.author || null,
      }))
      const vd = verdictsByMessageIds(messages.filter((m) => m.dir === 'out').map((m) => m.id))
      for (const m of messages) if (vd[m.id]) m.veredito = vd[m.id]
      return json(res, 200, { peerId, nome: chat?.nome || null, foto: chat?.foto || null, personId,
        aiOn: !!getAiSetting(personId, 'meupatrocinio')?.enabled, messages, metricas: metricasDaConversa(personId, ACCOUNT) })
    }
    if (p === '/api/mp/enviar' && req.method === 'POST') {
      const b = await body(req)
      if (!b.peerId || !b.texto) return json(res, 400, { error: 'peerId e texto' })
      // veio do painel = palavras do dono (docs/QUEM-ESCREVEU.md)
      try {
        const r = await enviarMeuPatrocinio({ accountKey: ACCOUNT, peerId: b.peerId, texto: b.texto, author: b.author || 'humano' })
        broadcast({ t: 'message', personId: mpPersonId(b.peerId) })
        return json(res, 200, r)
      } catch (e) { return json(res, 500, { error: e.message }) }
    }
    if (p === '/api/mp/ia' && req.method === 'POST') {
      const b = await body(req)
      if (!b.peerId) return json(res, 400, { ok: false, error: 'peerId' })
      const enable = b.enable != null ? !!b.enable : true
      const personId = mpPersonId(b.peerId)
      setAiSetting({ personId, channel: 'meupatrocinio', enabled: enable, state: 'idle' })
      logEvent({ type: enable ? 'ai_on' : 'ai_off', personId, channel: 'meupatrocinio', detail: b.peerId })
      broadcast({ t: 'state' })
      return json(res, 200, { ok: true, aiOn: enable, personId })
    }
    if (p === '/api/canais/importar-chrome' && req.method === 'POST') {
      const bd = await body(req)
      try {
        const r = await importarSessaoDoChrome(String(bd.canal || '').toLowerCase())
        broadcast({ t: 'state' })
        return json(res, 200, r)
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message })
      }
    }
    if (p === '/api/badoo/session' && req.method === 'POST') {
      const bd = await body(req)
      try { const r = await badooImportarCookies(bd.cookies || bd, bd.ua); broadcast({ t: 'state' }); return json(res, 200, r) }
      catch (e) { return json(res, 400, { ok: false, error: e.message }) }
    }
    if (p === '/api/ig/session') {
      const bd = await body(req)
      try { const r = await igImportCookies(bd.cookies || bd, bd.ua); broadcast({ t: 'state' }); return json(res, 200, { ok: r.ok, me: r.me }) }
      catch (e) { return json(res, 400, { ok: false, error: e.message }) }
    }
    if (p === '/api/ig/sync') { syncInstagram({ accountKey: ACCOUNT, max: 8, onUpdate: (tid, pid) => broadcast({ t: 'message', personId: pid }) }).then(() => broadcast({ t: 'state' })).catch((e) => logEvent({ type: 'ig_error', detail: e.message })); return json(res, 200, { ok: true }) }
    // O que o Instagram sabe sobre o HUMANO (não sobre as conversas): quem ele segue, o que
    // curte, o que salva. Roda AQUI DENTRO porque o navegador é de uma aba só e um processo
    // separado disputaria a mesma aba com o núcleo (armadilha conhecida do projeto).
    if (p === '/api/saude/canais') return json(res, 200, { canais: saudeEstado(), caidos: saudeCaidos().length })
    if (p === '/api/ia/monitor') { const r = monitorVozSemana({ dias: Number(url.searchParams.get('dias') || 7) }); return json(res, 200, { ...r, texto: monitorVozTexto(r) }) }
    if (p === '/api/skills') return json(res, 200, { skills: skillsListar(), rotas: skillRotas() })
    // Rotas publicadas por SKILLS. É o caminho em que uma habilidade aprendida atende sem
    // modelo nenhum: chega HTTP, roda JavaScript, responde. Zero token.
    //
    // A CHECAGEM DE CAMINHO VEM ANTES DE LER O CORPO, e isso não é estilo — é o que impede
    // um desastre. A versão anterior fazia `await body(req)` pra TODO POST antes de saber se
    // a rota era de skill. O corpo é um stream: lido uma vez, acabou. Toda rota POST abaixo
    // desta linha (fatos, memória, encontros, projetos, vínculos) ficava esperando um 'end'
    // que nunca vinha — a requisição pendurava pra sempre, sem erro, sem resposta. No painel
    // isso aparecia como botão que não faz nada, que foi como o dono encontrou.
    if (skillRotas().some((r) => r.caminho === p && r.metodo === String(req.method).toUpperCase())) {
      const r = await skillRota({ metodo: req.method, caminho: p, corpo: req.method === 'POST' ? await body(req).catch(() => ({})) : Object.fromEntries(url.searchParams) })
      if (r) return json(res, r.status, r.corpo)
    }
    if (p === '/api/skills/provar' && req.method === 'POST') {
      const bd = await body(req); const r = await skillProvar(bd.nome)
      broadcast({ t: 'state' }); return json(res, 200, r)
    }
    if (p === '/api/missoes') {
      if (req.method === 'GET') return json(res, 200, { missoes: missaoListar() })
      const bd = await body(req)
      if (bd.cancelar) return json(res, 200, { missao: missaoCancelar(bd.cancelar) })
      if (!bd.objetivo) return json(res, 400, { ok: false, error: 'sem objetivo' })
      const m = missaoCriar({ objetivo: bd.objetivo, skill: bd.skill || null, provaCmd: bd.prova || null, maxVoltas: Number(bd.voltas || 6), origem: 'painel' })
      setTimeout(missaoTick, 500)   // não espera o tick: ele pediu agora
      return json(res, 200, { ok: true, missao: m })
    }
    if (p === '/api/missao' && req.method === 'GET') return json(res, 200, missaoPegar(url.searchParams.get('id')) || { erro: 'não achei' })
    if (p === '/api/eu/instagram') {
      if (req.method === 'GET') return json(res, 200, retratoDoInstagram())
      const bd = await body(req).catch(() => ({}))
      try { const r = await coletarInstagramEu({ username: bd.username || null }); return json(res, 200, { ok: true, ...r, retrato: retratoDoInstagram() }) }
      catch (e) { return json(res, 500, { ok: false, error: e.message }) }
    }
    // Varredura profunda (puxar o máximo de histórico de cada conversa). Assíncrona: responde já e reporta progresso por WS.
    if (p === '/api/ig/deep-scan') { deepScanInstagram({ accountKey: ACCOUNT, onProgress: (done, total, name, n) => broadcast({ t: 'ig-deep', done, total, name, n }) }).then((d) => { logEvent({ type: 'ig_deep_scan', detail: 'concluída: ' + d + ' conversas' }); broadcast({ t: 'ig-deep-done', total: d }); broadcast({ t: 'state' }) }).catch((e) => logEvent({ type: 'ig_error', detail: 'deep-scan: ' + e.message })); return json(res, 200, { ok: true }) }
    // Diagnóstico: o que o scanner VÊ no inbox agora, cru, antes de qualquer filtro.
    // Roda DENTRO do processo (igExclusive serializa a aba) — rodar readInbox em outro
    // processo briga pelo Chrome e congela a tela ao vivo.
    if (p === '/api/ig/inbox-cru' && req.method === 'GET') {
      try {
        const linhas = await igLerInboxCru({ max: Number(url.searchParams.get('max')) || 25 })
        const conhecidas = new Set(igChats(ACCOUNT).map((c) => c.name))
        return json(res, 200, {
          total: linhas.length,
          linhas: linhas.map((l, i) => ({ pos: i + 1, ...l, noBanco: conhecidas.has(l.name) })),
        })
      } catch (e) { return json(res, 500, { error: e.message }) }
    }
    if (p === '/api/ig/chats') {
      return json(res, 200, igChats(ACCOUNT).map((c) => {
        const personId = igPersonId(c.thread_id)
        return { threadId: c.thread_id, name: c.name || c.username || 'Instagram', username: c.username, avatar: c.avatar, lastText: c.last_text, lastTs: c.last_ts,
          unread: c.unread || 0, adopted: !!c.adopted, mode: c.mode || null, personId,
          objective: getPersonObjective(personId), aiOn: !!getAiSetting(personId, 'instagram')?.enabled,
          metricas: metricasDaConversa(personId, ACCOUNT) }
      }))
    }
    if (p === '/api/ig/chat' && req.method === 'GET') {
      const threadId = url.searchParams.get('threadId')
      if (!threadId) return json(res, 400, { error: 'threadId' })
      const chat = getIgChat(ACCOUNT, threadId); const personId = igPersonId(threadId)
      igChatMarkRead(ACCOUNT, threadId)
      igRefreshThread({ accountKey: ACCOUNT, threadId }).then(() => broadcast({ t: 'message', personId })).catch(() => {}) // relê ao vivo em background
      const messages = channelMessages(personId, 'instagram', 200).map((m) => {
        // mídia (imagem/vídeo/reel): expõe pro painel desenhar a bolha real (o meme, a foto).
        // A imagem é servida pela rota-proxy /api/ig/media (o CDN do IG bloqueia hotlink direto).
        let media = null
        if (m.media_json) { try { media = JSON.parse(m.media_json) } catch { /* json inválido */ } }
        const isImg = media && (media.kind === 'imagem' || media.kind === 'foto')
        const isVid = media && (media.kind === 'video' || media.kind === 'reel')
        return { id: m.message_id, dir: m.direction === 'outgoing' ? 'out' : 'in', text: m.text, ts: m.ts,
          type: isImg ? 'imagem' : isVid ? 'video' : 'texto',
          media: media ? { kind: media.kind, src: media.src, desc: igMediaDescription(media.src) || null } : null }
      })
      const vdIg = verdictsByMessageIds(messages.filter((m) => m.dir === 'out').map((m) => m.id))
      for (const m of messages) if (vdIg[m.id]) m.veredito = vdIg[m.id]
      return json(res, 200, { threadId, name: chat?.name, username: chat?.username, avatar: chat?.avatar, personId, mode: chat?.mode || null,
        objective: getPersonObjective(personId), aiOn: !!getAiSetting(personId, 'instagram')?.enabled, messages,
        metricas: metricasDaConversa(personId, ACCOUNT) })
    }
    // Proxy da mídia do Instagram (o CDN bloqueia hotlink direto por Referer): busca a imagem
    // server-side e faz stream pro painel. Só hosts do IG/FB, sem traversal. URL do CDN expira
    // em horas — quando expira, o re-sync da thread recaptura uma URL fresca.
    if (p === '/api/ig/media' && req.method === 'GET') {
      const src = url.searchParams.get('src') || ''
      let host = ''
      try { host = new URL(src).hostname } catch { return json(res, 400, { error: 'src' }) }
      if (!/(^|\.)(cdninstagram\.com|fbcdn\.net|instagram\.com)$/.test(host)) return json(res, 400, { error: 'host' })
      try {
        const buf = await downloadMedia(src, {}) // Buffer cru; imagens do IG são JPEG
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' })
        res.end(buf)
      } catch { res.writeHead(502); res.end() }
      return
    }
    if (p === '/api/ig/chat/send') {
      const bd = await body(req); const threadId = bd.threadId; const text = String(bd.text || '').trim()
      if (!threadId || !text) return json(res, 400, { ok: false, error: 'threadId/text' })
      try { const r = await igSendToThread({ accountKey: ACCOUNT, threadId, text }); broadcast({ t: 'message', personId: igPersonId(threadId) }); return json(res, 200, { ok: true, message: { id: 'ig:' + threadId + ':out:' + r.ts, dir: 'out', text, ts: r.ts } }) }
      catch (e) { return json(res, 500, { ok: false, error: e.message }) }
    }
    if (p === '/api/ig/chat/generate') {
      const bd = await body(req); const threadId = bd.threadId
      if (!threadId) return json(res, 400, { ok: false, error: 'threadId' })
      const chat = getIgChat(ACCOUNT, threadId); const personId = igPersonId(threadId)
      try { const draft = await generateDraft({ personId, name: chat?.name, channel: 'instagram', chatMode: chat?.mode || null, manual: true }); guardarRascunho(bd.pedido, draft); return json(res, 200, { ok: true, draft }) }
      catch (e) { return json(res, 500, { ok: false, error: e.message }) }
    }
    if (p === '/api/ig/chat/ai') {
      const bd = await body(req); const threadId = bd.threadId; const enable = bd.enable != null ? !!bd.enable : true
      if (!threadId) return json(res, 400, { ok: false, error: 'threadId' })
      const personId = igPersonId(threadId)
      igChatSetAdopted(ACCOUNT, threadId, enable); setAiSetting({ personId, channel: 'instagram', enabled: enable, state: 'idle' })
      if (enable && responderAgoraSePendente({ personId, channel: 'instagram' })) cutucarCanal('instagram')
      logEvent({ type: enable ? 'ai_on' : 'ai_off', personId, channel: 'instagram', detail: threadId }); broadcast({ t: 'state' })
      return json(res, 200, { ok: true, aiOn: enable, personId })
    }
    if (p === '/api/ig/chat/mode') {
      const bd = await body(req); const threadId = bd.threadId
      const mode = bd.mode && VALID_MODES.includes(bd.mode) ? bd.mode : null
      if (!threadId) return json(res, 400, { ok: false, error: 'threadId' })
      if (bd.mode && !mode) return json(res, 400, { ok: false, error: 'modo inválido' })
      igChatSetMode(ACCOUNT, threadId, mode); logEvent({ type: 'ig_mode', channel: 'instagram', detail: threadId + ' -> ' + (mode || 'sem modo') }); broadcast({ t: 'state' })
      return json(res, 200, { ok: true, mode })
    }
    if (p === '/api/tinder/sync') {
      const me = await tinderApi().profile()
      setSetting('tinder_me', { id: me._id, name: me.name })
      const n = await syncMatches(tinderApi(), ACCOUNT, me._id)
      setSetting('tinder_roster_synced_at', Date.now())
      broadcast({ t: 'state' })
      return json(res, 200, { ok: true, synced: n })
    }
    if (p === '/api/tinder/token') {
      const b = await body(req); setToken(b.token)
      const s = await checkSession()
      // quem acabou de trocar o token sabe na hora se funcionou: registrar aqui é o que faz
      // o selo do painel e o aviso do WhatsApp acompanharem sem esperar o próximo loopTick
      anunciarCanal(saudeRegistrar({ canal: 'tinder', ok: s.ok, motivo: s.ok ? null : (s.reason || 'token recusado') }))
      broadcast({ t: 'state' })
      return json(res, 200, { ok: s.ok, me: s.me?.name })
    }
    // "Sobre mim": os documentos que a IA usa pra conversar (voz + fatos). Só leitura.
    // text = o que a IA REALMENTE lê no prompt; fullText = arquivo completo (fonte).
    if (p === '/api/ia/uso' && req.method === 'GET') {
      const horas = Math.max(1, Math.min(24 * 31, Number(url.searchParams.get('horas')) || 24))
      return json(res, 200, resumoUso({ desde: Date.now() - horas * 3600_000 }))
    }
    if (p === '/api/config' && req.method === 'GET') {
      const atualizar = url.searchParams.get('atualizar') === '1'
      const contaAtual = contaOpenAiAtiva()
      const [prof, openaiResult, providers, cotas] = await Promise.all([
        readCommunicationProfile(),
        contaAtual ? getCodex(contaAtual.home).accountOverview().catch(() => null) : Promise.resolve(null),
        iaDisponiveis({ forcar: atualizar }).catch(() => ({
          ativo: provedorAtivo(),
          codex: { pronto: !!contaAtual, nome: 'OpenAI (Codex)', conta: contaAtual?.nome || null },
          claude: { pronto: false, nome: 'Anthropic (Claude)', falta: 'não foi possível consultar agora' },
        })),
        cotasOpenAi({ forcar: atualizar }).catch(() => []),
      ])
      const cotasPorNome = new Map(cotas.map((item) => [item.nome, item]))
      const contas = listarContasOpenAi().map((item) => {
        const cota = cotasPorNome.get(item.nome) || {}
        return {
          nome: item.nome,
          email: cota.email || null,
          plano: cota.plano || null,
          conectada: cota.conectada !== false,
          precisaRelogin: cota.precisaRelogin === true,
          // "não deu pra ler o uso" é um estado próprio: sem isto a tela mostra 0%.
          semLeitura: cota.semLeitura === true || cota.usadoPct == null,
          motivo: cota.motivo || null,
          usadoPct: cota.usadoPct ?? null,
          sobraPct: cota.sobraPct ?? null,
          viraEm: cota.viraEm || null,
          janelaHoras: cota.janelaHoras || null,
          tokensNaVida: cota.tokensNaVida ?? null,
          erro: cota.erro || null,
          ativa: item.nome === contaAtual?.nome,
        }
      })
      const documents = await Promise.all((prof.documents || []).map(async (d) => {
        let fullText = d.text || ''
        try { if (d.path) fullText = await fs.promises.readFile(d.path, 'utf8') } catch { /* usa o recorte */ }
        const usedText = d.text || ''
        return {
          id: d.id, label: d.label, filename: d.path ? d.path.split('/').pop() : null,
          available: !!d.available, text: usedText, usedChars: usedText.length,
          fullText, fullChars: fullText.length, usesFullFile: fullText.trim().length === usedText.trim().length,
          error: d.error || null,
        }
      }))
      return json(res, 200, {
        available: !!prof.available,
        documents,
        pix: lerPix(),
        servicos: lerServicos(),
        openai: openaiResult,
        ia: {
          ativo: provedorAtivo(),
          providers: {
            ...providers,
            claude: {
              ...(providers.claude || {}),
              loginPendente: loginClaudePendente(),
            },
          },
          openai: {
            ativa: contaAtual?.nome || null,
            contas,
            loginPendente: loginOpenAiPendente(),
          },
          // "a IA ainda fala?" — falhas seguidas sem nenhum acerto no meio. Vai junto do
          // resto da configuração porque é nesta tela que se escolhe a conta, e é aqui que
          // uma conta muda tem de gritar.
          saude: saudeGeracao(),
        },
      })
    }
    if (p === '/api/config/pix' && req.method === 'POST') {
      const b = await body(req)
      try { return json(res, 200, { ok: true, pix: salvarPix(b) }) }
      catch (e) { return json(res, 400, { ok: false, erro: e.message }) }
    }
    // A tabela de serviços vai inteira de uma vez: a tela edita uma lista, e salvar linha a
    // linha deixaria a tabela meio-salva se a conexão caísse no meio.
    if (p === '/api/config/servicos' && req.method === 'POST') {
      const b = await body(req)
      try { return json(res, 200, { ok: true, servicos: salvarServicos(b) }) }
      catch (e) { return json(res, 400, { ok: false, erro: e.message }) }
    }
    // ENTREGA DE SERVIÇO. Só sai daqui, e só com clique: nenhum caminho automático chega nesta
    // rota. O alvo é EXPLÍCITO (jid/chatId), nunca "a conversa aberta" — foi assim que duas
    // fotos foram parar com terceiros no Instagram em 03/08/2026.
    if (p === '/api/servicos/entrega' && req.method === 'GET') {
      return json(res, 200, { servicos: servicosComEntrega(), canais: CANAIS_COM_ENTREGA })
    }
    if (p === '/api/servicos/entregar' && req.method === 'POST') {
      const b = await body(req)
      const canal = String(b.canal || '')
      const personId = String(b.personId || '')
      try {
        if (canal === 'whatsapp') {
          const jid = String(b.jid || '')
          if (!jid) return json(res, 400, { ok: false, erro: 'sem destinatário' })
          const acc = waPool.get(ACCOUNT)
          if (!acc || !acc.sock) return json(res, 400, { ok: false, erro: 'whatsapp offline' })
          const feito = await entregar({
            personId, canal, indice: b.indice,
            enviarTexto: async (texto) => {
              const r = await waSendText(acc.sock, jid, texto)
              const ts = Date.now()
              addMessage({ messageId: 'wa:' + (r?.providerMessageId || `${jid}:out:${ts}`), accountKey: ACCOUNT,
                personId, channel: 'whatsapp', direction: 'outgoing', text: texto, ts, author: 'humano' })
            },
            enviarFoto: async (imagem) => {
              const r = await sendSavedImage(acc.sock, jid, imagem)
              const ts = Date.now()
              addMessage({ messageId: 'wa:' + (r?.providerMessageId || `${jid}:img:${ts}`), accountKey: ACCOUNT,
                personId, channel: 'whatsapp', direction: 'outgoing', text: '',
                media: { kind: 'image', saved: true, file: imagem.file, status: 'done' }, ts, author: 'humano' })
            },
          })
          broadcast({ t: 'message', jid, personId })
          return json(res, 200, { ok: true, feito })
        }
        if (canal === 'telegram') {
          const chatId = String(b.chatId || '')
          if (!chatId) return json(res, 400, { ok: false, erro: 'sem destinatário' })
          const feito = await entregar({
            personId, canal, indice: b.indice,
            enviarTexto: async (texto) => { await enviarTelegram({ accountKey: ACCOUNT, chatId, texto, author: 'humano' }) },
            enviarFoto: async (imagem, caminho) => { await enviarFotoTelegram({ accountKey: ACCOUNT, chatId, arquivo: caminho, author: 'humano' }) },
          })
          broadcast({ t: 'message', personId })
          return json(res, 200, { ok: true, feito })
        }
        if (canal === 'badoo') {
          const chatId = String(b.chatId || '')
          if (!chatId) return json(res, 400, { ok: false, erro: 'sem destinatário' })
          const feito = await entregar({
            personId, canal, indice: b.indice,
            // O envio do Badoo devolve recibo do próprio site (`comprovado`) e grava a
            // mensagem por dentro — por isso aqui não há addMessage: duplicaria a bolha.
            enviarTexto: async (texto) => {
              await badooEnviarRascunhoComMidia({ accountKey: ACCOUNT, personId, chatId, draft: texto, author: 'humano', protegerAudio: false })
            },
            enviarFoto: async () => { throw new Error('o Badoo não envia imagem') },
          })
          broadcast({ t: 'message', personId })
          return json(res, 200, { ok: true, feito })
        }
        return json(res, 400, { ok: false, erro: `entrega ainda não vale no ${canal || 'canal desconhecido'}` })
      } catch (e) { return json(res, 400, { ok: false, erro: e.message }) }
    }
    // ETIQUETAS. São nossas, não as do WhatsApp Business: valem em todos os canais e a chave é
    // a pessoa canônica. O DELETE vai por querystring porque o servidor só lê corpo em POST.
    if (p === '/api/etiquetas' && req.method === 'GET') {
      return json(res, 200, { etiquetas: listarEtiquetas(), cores: ETIQUETA_CORES })
    }
    if (p === '/api/etiquetas' && req.method === 'POST') {
      const b = await body(req)
      try { return json(res, 200, { ok: true, etiqueta: criarEtiqueta(b), etiquetas: listarEtiquetas() }) }
      catch (e) { return json(res, 400, { ok: false, erro: e.message }) }
    }
    if (p === '/api/etiquetas/editar' && req.method === 'POST') {
      const b = await body(req)
      try { return json(res, 200, { ok: true, etiqueta: editarEtiqueta(b), etiquetas: listarEtiquetas() }) }
      catch (e) { return json(res, 400, { ok: false, erro: e.message }) }
    }
    // As REGRAS de uma etiqueta: o que a pessoa precisa escrever para ganhá-la sozinha.
    if (p === '/api/etiquetas/regras' && req.method === 'GET') {
      return json(res, 200, { regras: regrasDaEtiqueta(url.searchParams.get('id')) })
    }
    if (p === '/api/etiquetas/regras' && req.method === 'POST') {
      const b = await body(req)
      try { return json(res, 200, { ok: true, regras: salvarRegras(b) }) }
      catch (e) { return json(res, 400, { ok: false, erro: e.message }) }
    }
    if (p === '/api/etiquetas/comportamento' && req.method === 'GET') {
      return json(res, 200, { comportamento: comportamentoDaEtiqueta(url.searchParams.get('id')) })
    }
    // Esta marca pode receber foto sensual? Decisão de quem opera, por etiqueta.
    if (p === '/api/etiquetas/fotos-quentes' && req.method === 'POST') {
      const b = await body(req)
      try { return json(res, 200, { ok: true, fotosQuentes: definirFotosQuentes(b.id, b.permitido === true), etiquetas: listarEtiquetas() }) }
      catch (e) { return json(res, 400, { ok: false, erro: e.message }) }
    }
    if (p === '/api/etiquetas/comportamento' && req.method === 'POST') {
      const b = await body(req)
      try { return json(res, 200, { ok: true, comportamento: salvarComportamento(b) }) }
      catch (e) { return json(res, 400, { ok: false, erro: e.message }) }
    }
    if (p === '/api/etiquetas' && req.method === 'DELETE') {
      try {
        const r = apagarEtiqueta(url.searchParams.get('id'))
        return json(res, 200, { ok: true, ...r, etiquetas: listarEtiquetas() })
      } catch (e) { return json(res, 400, { ok: false, erro: e.message }) }
    }
    if (p === '/api/etiquetas/pessoas' && req.method === 'GET') {
      return json(res, 200, { pessoas: pessoasDaEtiqueta(url.searchParams.get('id')).map((x) => ({
        personId: x.personId, nome: nomeParaMostrar(x.personId) || x.nome || 'contato sem nome',
      })) })
    }
    if (p === '/api/etiquetas/pessoa' && req.method === 'GET') {
      return json(res, 200, { etiquetas: etiquetasDaPessoa(url.searchParams.get('personId')) })
    }
    if (p === '/api/etiquetas/pessoa' && req.method === 'POST') {
      const b = await body(req)
      try {
        const alvo = listarEtiquetas().find((e) => e.id === Number(b.etiquetaId))
        if (alvo?.tipo === 'cidade') {
          const C = await import('./self/cidade-pessoa.mjs')
          if (b.marcar === false) C.soltarCidade(b.personId)
          else C.aplicarCidade({ personId: b.personId, cidade: alvo.nome, fonte: 'manual', forcar: true })
          return json(res, 200, { ok: true, etiquetas: etiquetasDaPessoa(b.personId) })
        }
        const etiquetas = marcarPessoa({ personId: b.personId, etiquetaId: b.etiquetaId, marcar: b.marcar !== false })
        logEvent({ type: b.marcar !== false ? 'etiqueta_posta' : 'etiqueta_tirada', personId: b.personId, detail: String(b.etiquetaId) })
        return json(res, 200, { ok: true, etiquetas })
      } catch (e) { return json(res, 400, { ok: false, erro: e.message }) }
    }
    // Modelo e esforço do cérebro. A lista é a PROVADA (tests-tim/testar-modelos.mjs), não a
    // que a interface do Codex mostra.
    if (p === '/api/ia/motor' && req.method === 'GET') {
      return json(res, 200, { modelo: modeloAtivo(), esforco: esforcoAtivo(), modelos: IA_MODELOS, esforcos: IA_ESFORCOS })
    }
    if (p === '/api/ia/motor' && req.method === 'POST') {
      const b = await body(req)
      try { const r = definirMotor({ modelo: b.modelo, esforco: b.esforco }); broadcast({ t: 'state' }); return json(res, 200, { ok: true, ...r }) }
      catch (e) { return json(res, 400, { error: e.message }) }
    }
    // Provar ao vivo quais modelos respondem — é o que decide quem aparece na lista.
    if (p === '/api/ia/motor/testar' && req.method === 'POST') {
      const alvos = IA_MODELOS.map((m) => m.id)
      const out = []
      for (const id of alvos) {
        const t0 = Date.now()
        try {
          const r = await gerarTextoIa({ prompt: 'Responda exatamente com a palavra: funciona', baseInstructions: 'Responda em uma palavra.', model: id, effort: 'medium' })
          out.push({ modelo: id, ok: !!(r && r.text), ms: Date.now() - t0, resposta: String(r?.text || '').trim().slice(0, 40) })
        } catch (e) { out.push({ modelo: id, ok: false, ms: Date.now() - t0, erro: String(e.message || e).slice(0, 90) }) }
      }
      logEvent({ type: 'ia_motor_teste', detail: `${out.filter((x) => x.ok).length} de ${out.length} modelos responderam` })
      return json(res, 200, { resultados: out })
    }

    if (p === '/api/ia/provedor' && req.method === 'POST') {
      const b = await body(req)
      const alvo = b.provedor === 'openai' ? 'codex' : String(b.provedor || '')
      if (!['codex', 'claude'].includes(alvo)) return json(res, 400, { ok: false, error: 'provedor inválido' })
      if (alvo === 'codex' && !contaOpenAiAtiva()) {
        return json(res, 409, { ok: false, error: 'adicione uma conta OpenAI antes de usar o Codex' })
      }
      if (alvo === 'claude') {
        const providers = await iaDisponiveis({ forcar: true })
        if (!providers.claude?.pronto) {
          return json(res, 409, { ok: false, error: providers.claude?.falta || 'a conta Claude não está pronta' })
        }
      }
      const troca = definirProvedor(alvo)
      if (iaPausaEstado()?.auto) iaRetomar({ auto: true, motivo: `provedor trocado para ${alvo}` })
      broadcast({ t: 'state' })
      return json(res, 200, { ok: true, troca, ativo: provedorAtivo(), providers: await iaDisponiveis() })
    }
    if (p === '/api/ia/contas/trocar' && req.method === 'POST') {
      const b = await body(req)
      try {
        const troca = trocarContaOpenAi(String(b.nome || ''))
        definirProvedor('codex')
        if (iaPausaEstado()?.auto) iaRetomar({ auto: true, motivo: `conta OpenAI trocada para ${troca.para}` })
        broadcast({ t: 'state' })
        return json(res, 200, { ok: true, troca, ativo: provedorAtivo() })
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message })
      }
    }
    if (p === '/api/ia/contas/login' && req.method === 'POST') {
      const b = await body(req)
      try {
        const login = await iniciarLoginOpenAi({ nome: b.nome || '', deviceCode: false, substituir: b.substituir === true })
        return json(res, 200, { ok: true, login })
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message })
      }
    }
    if (p === '/api/ia/contas/fallback' && req.method === 'POST') {
      const b = await body(req)
      try {
        const conta = await concluirFallbackOpenAi({ nome: b.nome, fallback: b.fallback })
        definirProvedor('codex')
        if (iaPausaEstado()?.auto) iaRetomar({ auto: true, motivo: `nova conta OpenAI selecionada: ${conta.nome}` })
        broadcast({ t: 'state' })
        return json(res, 200, { ok: true, conta, ativo: provedorAtivo() })
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message })
      }
    }
    if (p === '/api/ia/contas/login/cancelar' && req.method === 'POST') {
      const b = await body(req)
      return json(res, 200, await cancelarLoginOpenAi(b.nome))
    }
    if (p === '/api/ia/claude/login' && req.method === 'POST') {
      try {
        const login = await iniciarLoginClaude()
        return json(res, 200, { ok: true, login })
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message })
      }
    }
    if (p === '/api/ia/claude/codigo' && req.method === 'POST') {
      const b = await body(req)
      try {
        const status = await concluirLoginClaude(b.codigo)
        const troca = definirProvedor('claude')
        if (iaPausaEstado()?.auto) iaRetomar({ auto: true, motivo: 'Claude conectado e selecionado' })
        broadcast({ t: 'state' })
        return json(res, 200, { ok: true, status, troca, ativo: provedorAtivo() })
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message })
      }
    }
    if (p === '/api/ia/claude/login/cancelar' && req.method === 'POST') {
      return json(res, 200, cancelarLoginClaude())
    }
    // ---------- Google Agenda ----------
    if (p === '/api/agenda' && req.method === 'GET') {
      const st = agendaConnectionState()
      let events = []
      if (st.connected) await ensureAgendaFresh()
      // A tela e o aviso de horário usam as DUAS fontes: sem isso, quem não tem Google via
      // "nenhum compromisso" com a agenda da casa cheia.
      events = ocupacaoAgenda({ dias: 10 })
      const all = pendingAgendaProposals(ACCOUNT).map((r) => ({
        id: r.id, title: r.title, startsAt: r.starts_at, endsAt: r.ends_at, withPerson: r.with_person,
        personId: r.person_id, channel: r.channel, confidence: r.confidence, sourceQuote: r.source_quote,
        personName: personDisplayName(r.person_id) || r.with_person || null,
        projectId: r.project_id || null, projectName: r.project_id ? (getProjectRow(r.project_id)?.name || null) : null,
      }))
      const nowMs = Date.now()
      // AVISO, nunca bloqueio: se o horário detectado cai fora da disponibilidade dele, ou
      // num dia em que ele vai estar em outra cidade, o cartão diz isso e o botão de aprovar
      // continua lá do mesmo jeito. Quem decide é ele — o interruptor é a fonte da verdade.
      // Sem disponibilidade cadastrada, `conferirHorario` devolve semRegra e nada é avisado:
      // não se acusa de estar fora de uma regra que não existe.
      const comAviso = all.map((x) => {
        try {
          const dur = resolverDuracaoAgenda({
            personId: x.personId || null,
            texto: `${x.title || ''} ${x.sourceQuote || ''}`,
            startMs: x.startsAt,
            endsAt: x.endsAt || null,
            etiquetasDaPessoa: x.personId ? etiquetasDaPessoa(x.personId) : [],
          })
          const v = conferirHorario(x.startsAt, { tipo: 'compromisso', eventos: events, duracaoMin: dur.minutos, ocupacao: dur.ocupacao })
          return v.ok || v.semRegra ? x : { ...x, aviso: v.motivos, avisoLugar: v.lugar?.nome || null }
        } catch { return x }
      })
      const proposals = comAviso.filter((x) => x.startsAt > nowMs)   // pendentes futuras (lista principal)
      const expired = comAviso.filter((x) => x.startsAt <= nowMs)     // vencidas (guardadas, expansível)
      return json(res, 200, { ...st, awareness: getSetting('agenda_awareness', true), events, proposals, expired })
    }
    if (p === '/api/agenda/connect') { // navegação do painel -> redireciona pro consent do Google
      if (!agendaConfigured()) { res.writeHead(302, { Location: '/?agenda=config' }); res.end(); return }
      try { res.writeHead(302, { Location: agendaConnectUrl(req) }); res.end() } catch { res.writeHead(302, { Location: '/?agenda=error' }); res.end() }
      return
    }
    if (p === '/api/agenda/events' && req.method === 'GET') { // eventos de um intervalo (calendário)
      const from = url.searchParams.get('from'), to = url.searchParams.get('to')
      if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return json(res, 400, { error: 'intervalo' })
      const deMs = Date.parse(from), ateMs = Date.parse(to)
      // O calendário da casa aparece SEMPRE; a Google entra por cima quando conectada. Sem
      // isso, quem não tem Google via um mês vazio com a agenda cheia.
      const locais = listarCompromissos({ fromMs: deMs, toMs: ateMs })
      if (!agendaConnectionState().connected) return json(res, 200, { events: locais, fonte: 'local' })
      try {
        const doGoogle = await agendaListRange({ timeMinIso: new Date(deMs).toISOString(), timeMaxIso: new Date(ateMs).toISOString() })
        const idsGoogle = new Set(doGoogle.map((e) => e.id).filter(Boolean))
        const semEspelho = locais.filter((c) => !(c.googleEventId && idsGoogle.has(c.googleEventId)))
        return json(res, 200, { events: [...doGoogle, ...semEspelho].sort((a, b) => a.startMs - b.startMs), fonte: 'google+local' })
      } catch (e) { return json(res, 500, { error: e.message }) }
    }
    // Marcar à mão no calendário da casa (e espelhar na Google, se conectada).
    if (p === '/api/agenda/compromissos' && req.method === 'GET') {
      const de = Number(url.searchParams.get('de')) || Date.now()
      const dias = Math.max(1, Math.min(120, Number(url.searchParams.get('dias')) || 30))
      return json(res, 200, { compromissos: listarCompromissos({ fromMs: de, toMs: de + dias * 86400000 }) })
    }
    if (p === '/api/agenda/compromissos' && req.method === 'POST') {
      const b = await body(req)
      try {
        const inicioMs = b.inicioMs ? Number(b.inicioMs) : Date.parse(b.inicio || '')
        if (!Number.isFinite(inicioMs) || !inicioMs) return json(res, 400, { erro: 'início inválido' })
        const dur = resolverDuracaoAgenda({
          personId: b.personId || null,
          texto: `${b.titulo || ''} ${b.servico || ''} ${b.faixa || ''}`,
          startMs: inicioMs,
          endsAt: b.fimMs ? Number(b.fimMs) : null,
          etiquetasDaPessoa: b.personId ? etiquetasDaPessoa(b.personId) : [],
        })
        const fimMs = Number(b.fimMs) || inicioMs + dur.minutos * 60000
        // Lugar digitado manda; sem ele, o do serviço reconhecido (endereço exato antes da
        // referência, porque quem vai ao compromisso precisa do endereço).
        const ondeManual = (b.lugar && String(b.lugar).trim())
          || (dur.servico ? (dur.servico.endereco || dur.servico.local || null) : null) || null
        let googleEventId = null
        if (agendaConnectionState().connected) {
          try {
            const ev = await agendaCreateEvent({ title: b.titulo || 'Compromisso',
              startsAtIso: new Date(inicioMs).toISOString(), endsAtIso: new Date(fimMs).toISOString(),
              description: [b.observacao || null, ondeManual ? `Local: ${ondeManual}` : null].filter(Boolean).join('\n') || null,
              personId: b.personId || null, channel: b.canal || null,
              duracaoMinutos: Math.round((fimMs - inicioMs) / 60000),
              servico: dur.servico?.nome || null, faixa: dur.faixa?.tempo || null })
            googleEventId = ev.id || null
          } catch (e) { logEvent({ type: 'agenda_event_error', detail: `espelho na Google falhou: ${e.message}` }) }
        }
        const c = criarCompromisso({
          titulo: b.titulo, inicioMs, fimMs, personId: b.personId || null, canal: b.canal || null,
          servico: dur.servico?.nome || null, faixa: dur.faixa?.tempo || null,
          folgaAntesMin: dur.ocupacao?.folgaAntesMin || 0, folgaDepoisMin: dur.ocupacao?.folgaDepoisMin || 0,
          lugar: ondeManual, observacao: b.observacao || null, origem: 'manual', googleEventId,
        })
        broadcast({ t: 'state' })
        return json(res, 200, { ok: true, compromisso: c, espelhado: !!googleEventId })
      } catch (e) { return json(res, 400, { ok: false, erro: e.message }) }
    }
    if (p.startsWith('/api/agenda/compromissos/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.slice('/api/agenda/compromissos/'.length))
      try {
        const c = cancelarCompromisso(id)
        // Cancelou aqui, cancela o espelho: deixar o evento na Google faria o horário
        // continuar ocupado pra ela e livre pra nós.
        if (c.googleEventId && agendaConnectionState().connected) {
          try { await agendaDeleteEvent(c.googleEventId); await refreshAgenda() }
          catch (e) { logEvent({ type: 'agenda_event_error', detail: `não deu pra apagar o espelho: ${e.message}` }) }
        }
        broadcast({ t: 'state' })
        return json(res, 200, { ok: true })
      } catch (e) { return json(res, 400, { ok: false, erro: e.message }) }
    }
    if (p.startsWith('/api/agenda/events/') && (req.method === 'PATCH' || req.method === 'DELETE')) {
      if (!agendaConnectionState().connected) return json(res, 400, { error: 'agenda não conectada' })
      const eventId = decodeURIComponent(p.slice('/api/agenda/events/'.length))
      if (!eventId) return json(res, 400, { error: 'evento' })
      try {
        if (req.method === 'DELETE') {
          await agendaDeleteEvent(eventId)
          await refreshAgenda()
          logEvent({ type: 'agenda_event_deleted', channel: 'agenda', detail: eventId })
          broadcast({ t: 'state' })
          return json(res, 200, { ok: true })
        }
        const b = await body(req)
        const event = await agendaUpdateEvent({
          eventId,
          title: b.title,
          startsAtIso: b.startsAtIso,
          endsAtIso: b.endsAtIso,
          allDay: !!b.allDay,
          startDate: b.startDate,
          endDate: b.endDate,
          location: b.location,
          description: b.description,
        })
        await refreshAgenda()
        logEvent({ type: 'agenda_event_updated', channel: 'agenda', detail: event.title })
        broadcast({ t: 'state' })
        return json(res, 200, { ok: true, event })
      } catch (e) {
        logEvent({ type: req.method === 'DELETE' ? 'agenda_event_delete_error' : 'agenda_event_update_error', channel: 'agenda', detail: e.message })
        return json(res, 500, { error: e.message })
      }
    }
    if (p === '/api/agenda/disconnect' && req.method === 'POST') { agendaDisconnect(); await refreshAgenda(); broadcast({ t: 'state' }); return json(res, 200, { ok: true }) }
    // Só os nomes e o tipo: a tela de Datas precisa saber QUAIS serviços existem para montar
    // os chips, sem carregar preço, foto nem entrega.
    // FOTO NO BADOO. Roda DENTRO do processo do núcleo de propósito: a fila do
    // `badooExclusive` só serializa quem está no mesmo processo, e o sync usa a MESMA aba do
    // Chrome. Um script paralelo trocaria de conversa por baixo do envio — foi o que
    // aconteceu na primeira tentativa, em 15/08/2026.
    if (p === '/api/badoo/foto' && req.method === 'POST') {
      const b = await body(req)
      try {
        const personId = String(b.personId || '')
        const chatId = String(b.chatId || (personId.startsWith('b:') ? personId.slice(2) : ''))
        if (!chatId) return json(res, 400, { ok: false, erro: 'sem conversa do Badoo' })
        if (b.diagnostico) return json(res, 200, await diagnosticarCompositorBadoo({ chatId, nomeEsperado: b.nomeEsperado || null }))
        const r = await enviarFotoBadoo({
          accountKey: ACCOUNT, personId: personId || `b:${chatId}`, chatId,
          atalho: String(b.atalho || ''), nomeEsperado: b.nomeEsperado || null,
          permitirQuente: b.permitirQuente === true || etiquetaAbreFotoQuente(personId || `b:${chatId}`),
          author: b.author === 'ia' ? 'ia' : 'humano',
        })
        broadcast({ t: 'message', personId: personId || `b:${chatId}` })
        return json(res, 200, r)
      } catch (e) {
        logEvent({ type: 'badoo_foto_erro', channel: 'badoo', detail: e.message })
        return json(res, 400, { ok: false, erro: e.message })
      }
    }
    if (p === '/api/servicos/nomes' && req.method === 'GET') {
      return json(res, 200, { servicos: lerServicos().itens.map((s) => ({ nome: s.nome, tipo: s.tipo })) })
    }
    // DATAS COMEMORATIVAS: as que a dona escreve à mão. Não dependem do Google — a agenda
    // pode estar desconectada e estas continuam valendo, porque a fonte é o banco daqui.
    if (p === '/api/agenda/datas' && req.method === 'GET') {
      return json(res, 200, { datas: listarComemorativas(), hoje: comemorativasDeHoje(), proxima: proximaComemorativa() })
    }
    if (p === '/api/agenda/datas' && req.method === 'POST') {
      const b = await body(req)
      try { return json(res, 200, { ok: true, data: salvarComemorativa(b), datas: listarComemorativas(), hoje: comemorativasDeHoje() }) }
      catch (e) { return json(res, 400, { ok: false, erro: e.message }) }
    }
    if (p === '/api/agenda/datas' && req.method === 'DELETE') {
      try { return json(res, 200, { ok: true, ...apagarComemorativa(url.searchParams.get('id')), datas: listarComemorativas() }) }
      catch (e) { return json(res, 400, { ok: false, erro: e.message }) }
    }
    if (p === '/api/agenda/refresh' && req.method === 'POST') { const c = await refreshAgenda(); return json(res, 200, { ok: true, events: c.events }) }
    if (p === '/api/agenda/awareness' && req.method === 'POST') { const b = await body(req); setSetting('agenda_awareness', !!b.enabled); return json(res, 200, { ok: true, awareness: !!b.enabled }) }
    if (p.startsWith('/api/agenda/proposal/') && req.method === 'POST') {
      const id = decodeURIComponent(p.split('/')[4] || ''); const b = await body(req)
      const prop = getAgendaProposal(id)
      if (!prop || prop.status !== 'pending') return json(res, 404, { error: 'proposta' })
      if (b.action === 'reject') { resolveAgendaProposal(id, 'rejected'); broadcast({ t: 'state' }); return json(res, 200, { ok: true, status: 'rejected' }) }
      if (b.action === 'approve') {
        const startsAt = b.startsAt ? Date.parse(b.startsAt) : prop.starts_at
        const title = (b.title && String(b.title).trim()) || prop.title
        try {
          const projectId = (b.projectId !== undefined ? b.projectId : prop.project_id) || null
          const dur = resolverDuracaoAgenda({
            personId: prop.person_id,
            texto: `${title} ${prop.source_quote || ''}`,
            startMs: startsAt,
            endsAt: prop.ends_at || null,
            etiquetasDaPessoa: etiquetasDaPessoa(prop.person_id),
          })
          // O compromisso nasce no calendário da casa SEMPRE. Antes disto, aprovar sem a
          // Google conectada simplesmente estourava — e o horário aprovado não ocupava nada.
          const fimMs = startsAt + dur.minutos * 60000
          let ev = { id: null, htmlLink: null }
          if (agendaConnectionState().connected) {
            ev = await agendaCreateEvent({ title, startsAtIso: new Date(startsAt).toISOString(),
              endsAtIso: new Date(fimMs).toISOString(),
              description: prop.source_quote ? `Contexto da conversa: ${prop.source_quote}` : null,
              personId: prop.person_id, channel: prop.channel, projectId,
              duracaoMinutos: dur.minutos, servico: dur.servico?.nome || null, faixa: dur.faixa?.tempo || null })
          }
          // O LUGAR do serviço acompanha o compromisso: endereço exato quando ela cadastrou
          // um, senão a referência. É aqui que o endereço sai do cadastro — nunca no prompt.
          const ondeServico = dur.servico ? (dur.servico.endereco || dur.servico.local || null) : null
          criarCompromisso({
            titulo: title, inicioMs: startsAt, fimMs, lugar: ondeServico,
            personId: prop.person_id, canal: prop.channel, projectId,
            servico: dur.servico?.nome || null, faixa: dur.faixa?.tempo || null,
            folgaAntesMin: dur.ocupacao?.folgaAntesMin || 0, folgaDepoisMin: dur.ocupacao?.folgaDepoisMin || 0,
            observacao: prop.source_quote ? `Contexto da conversa: ${prop.source_quote}` : null,
            origem: 'proposta', googleEventId: ev.id || null,
          })
          if (projectId && getProjectRow(projectId)) { try { logProjectEvent(projectId, 'event_created', title) } catch { /* */ } }
          resolveAgendaProposal(id, 'created', { googleEventId: ev.id, googleHtmlLink: ev.htmlLink })
          await refreshAgenda(); logEvent({ type: 'agenda_event_created', personId: prop.person_id, detail: title }); broadcast({ t: 'state' })
          return json(res, 200, { ok: true, status: 'created', htmlLink: ev.htmlLink })
        } catch (e) { logEvent({ type: 'agenda_event_error', detail: e.message }); return json(res, 500, { error: e.message }) }
      }
      return json(res, 400, { error: 'ação' })
    }
    if (p === '/api/wa/monitor') { // fluxo de monitoramento do WhatsApp (não-mensagens)
      const kind = url.searchParams.get('kind') || null
      return json(res, 200, recentMonitor(ACCOUNT, { limit: 300, kind }).map((m) => ({
        id: m.id, ts: m.ts, kind: m.kind, jid: m.jid, name: m.name, summary: m.summary,
        detail: m.detail ? (() => { try { return JSON.parse(m.detail) } catch { return null } })() : null,
      })))
    }
    if (p === '/api/log') return json(res, 200, recentEvents(120))
    // ---------- Projetos (gestão da vida): rotas /api/{projects,tasks,notes,reminders,habits,people,capture,today} ----------
    if (/^\/api\/(projects|tasks|notes|reminders|habits|people|capture|today|week)/.test(p)) {
      const handled = await handleProjectsApi({
        p, method: req.method, req, res, url,
        json, body: () => body(req), broadcast, account: ACCOUNT,
        agenda: { connected: () => agendaConnectionState().connected, createEvent: agendaCreateEvent, listRange: agendaListRange },
      })
      if (handled) { if (p.startsWith('/api/projects') || p.startsWith('/api/reminders') || p.startsWith('/api/habits') || p.startsWith('/api/tasks')) broadcast({ t: 'state' }); return }
    }

    // ---------- Progresso das conversas: quais andam, quais esfriaram, quanto ela responde ----------
    if (handleConversasApi({ p, method: req.method, res, url, json, account: ACCOUNT })) return
    // Necessidades (o que está apertando e quanto falta, em reais). O corpo é lido AQUI
    // porque só POST tem corpo, e ler em toda requisição penduraria GET à toa.
    if (p.startsWith('/api/necessidades')) {
      const corpo = req.method === 'POST' ? await body(req) : {}
      if (handleNecessidadesApi({ p, method: req.method, res, url, json, body: corpo })) return
    }

    // ---------- O interruptor geral da IA (e o freio de cota que o aperta sozinho) ----------
    if (p === '/api/ia/pausa' && req.method === 'GET') {
      const uso = await lerUsoCota().catch(() => null)
      return json(res, 200, { pausada: iaPausada(), pausa: iaPausaEstado(), uso, teto: limitePausa(), monitor: monitorLigado() })
    }
    if (p === '/api/ia/pausa' && req.method === 'POST') {
      const b = await body(req)
      // `pausar:false` religa mesmo quando quem pausou foi o monitor — a mão dele manda mais.
      if (b.pausar) iaPausar({ motivo: b.motivo || 'pausada por você no painel', auto: false })
      else iaRetomar({ auto: false, motivo: 'religada por você no painel' })
      if (typeof b.monitor === 'boolean') setSetting('ia_pausa_auto', b.monitor)
      broadcast({ t: 'state' })
      return json(res, 200, { ok: true, pausada: iaPausada(), pausa: iaPausaEstado(), monitor: monitorLigado() })
    }

    // ---------- Primeira mensagem SEM modelo de linguagem (você escolhe quem e o quê) ----------
    if (p === '/api/primeira/modelos' && req.method === 'GET') {
      return json(res, 200, { modelos: listarModelos({ canal: url.searchParams.get('canal') || null }) })
    }
    if (p === '/api/primeira/modelos' && req.method === 'POST') {
      const b = await body(req)
      try {
        const m = b.apagar ? (apagarModelo(b.apagar), null) : salvarModelo({ id: b.id || null, texto: b.texto, canal: b.canal || null, ativo: b.ativo !== false })
        broadcast({ t: 'state' })
        return json(res, 200, { ok: true, modelo: m, modelos: listarModelos({ canal: b.canal || null }) })
      } catch (e) { return json(res, 400, { error: e.message }) }
    }
    if (p === '/api/primeira/candidatos' && req.method === 'GET') {
      try {
        return json(res, 200, { candidatos: primeiraCandidatos({ accountKey: ACCOUNT, canal: url.searchParams.get('canal'), limite: Math.min(Number(url.searchParams.get('limite')) || 300, 1000) }) })
      } catch (e) { return json(res, 400, { error: e.message }) }
    }
    if (p === '/api/primeira/disparar' && req.method === 'POST') {
      const b = await body(req)
      const canal = b.canal
      // O envio de cada canal é injetado aqui: o módulo do disparo não conhece sessão nem
      // navegador, e por isso pôde ser provado inteiro sem rede.
      const enviarPorCanal = {
        tinder: async ({ alvo, texto, candidato }) => {
          const api = tinderApi()
          const me = getMe()
          const myId = me?.id || me?._id || null
          if (!api || !myId) return { ok: false, erro: 'sem sessão do Tinder' }
          const linha = db().prepare(`SELECT other_id FROM tinder_match WHERE account_key=? AND match_id=?`).get(ACCOUNT, alvo)
          const r = await api.sendText({ matchId: alvo, otherId: linha?.other_id || otherIdFromMatch(alvo, myId), userId: myId, text: texto })
          return { ok: !!r.ok, status: r.status, messageId: r.messageId, erro: r.ok ? null : `tinder respondeu ${r.status}` }
        },
        badoo: async ({ alvo, texto }) => {
          try {
            const r = await badooEnviarRascunhoComMidia({
              accountKey: ACCOUNT, personId: badooPersonId(alvo), chatId: alvo,
              draft: texto, author: 'humano', protegerAudio: true,
            })
            return { ok: true, messageId: r?.lastUid || null }
          }
          catch (e) { return { ok: false, erro: e.message } }
        },
      }
      if (!enviarPorCanal[canal]) return json(res, 400, { error: 'canal inválido' })
      try {
        const r = await dispararPrimeira({
          accountKey: ACCOUNT, canal, alvos: b.alvos || [], modelos: b.modelos || [],
          dryRun: b.dryRun !== false, enviar: enviarPorCanal[canal],
          aoAndar: (x) => broadcast({ t: 'primeira', ...x }),
        })
        broadcast({ t: 'state' })
        logEvent({ type: 'primeira_disparo', channel: canal, detail: `${r.enviadas} enviadas, ${r.puladas} puladas, ${r.falhas} falhas${r.dryRun ? ' (ensaio)' : ''}` })
        return json(res, 200, r)
      } catch (e) { return json(res, 400, { error: e.message }) }
    }

    // ---------- Iniciativas (nível 1): a IA sugere puxar papo; você aprova ----------
    if (p === '/api/iniciativas' && req.method === 'GET') {
      return json(res, 200, { iniciativas: listarIniciativas(), contagem: contagemIniciativas(), enabled: getSetting('iniciativa_enabled', true) !== false })
    }
    if (p === '/api/iniciativas/config' && req.method === 'POST') {
      const b = await body(req)
      setSetting('iniciativa_enabled', !!b.enabled)
      return json(res, 200, { ok: true, enabled: !!b.enabled })
    }
    if (p === '/api/iniciativas/detectar' && req.method === 'POST') {
      detectarIniciativas({ gerarRascunho: gerarRascunhoIniciativa })
        .then((r) => { broadcast({ t: 'state' }); logEvent({ type: 'iniciativa_deteccao', detail: `${r.novas || 0} nova(s)` }) })
        .catch((e) => logEvent({ type: 'iniciativa_erro', detail: e.message }))
      return json(res, 200, { ok: true })
    }
    if (p.startsWith('/api/iniciativas/') && req.method === 'POST') {
      const id = decodeURIComponent(p.slice('/api/iniciativas/'.length))
      const b = await body(req)
      const r = await decidirIniciativa(id, { acao: b.acao, texto: b.texto, enviar: enviarIniciativa })
      broadcast({ t: 'state' })
      return json(res, r.ok ? 200 : 400, r)
    }

    // ---------- O "eu": fatos, asserções e encontros (janelas + interruptor) ----------
    {
      const handled = await handleSelfApi({
        p, method: req.method, req, res, url, json, body: () => body(req), broadcast, account: ACCOUNT,
        buscarFoto: (jid) => { fetchAvatar(jid).catch(() => {}) },
        prepararSobreMim: prepararHistoricoParaSobreMim,
      })
      if (handled) return
    }

    // ---------- Assistente pessoal: a conversa dele COM o vendas-multicanal ----------
    {
      const handled = await handleAssistenteApi({
        p, method: req.method, req, res, url, json, body: () => body(req), broadcast, account: ACCOUNT,
        sock: () => waPool.get(ACCOUNT)?.sock || null,
        enviarParaPessoa,
      })
      if (handled) return
    }

    // ---------- Descoberta: auto-deslizar, critérios, passport, perfil do Tinder ----------
    {
      const handled = await handleSwipeApi({
        p, method: req.method, req, res, url,
        json, body: () => body(req), broadcast,
        // devolve null sem token: a tela mostra o aviso em vez de quebrar
        api: () => { try { return getToken() ? tinderApi() : null } catch { return null } },
      })
      if (handled) return
    }

    // ---------- Vínculos entre canais (identidade, chamar primeiro, veredito) ----------
    {
      const handled = await handleVinculosApi({
        p, method: req.method, req, res, url,
        json, body: () => body(req), broadcast, account: ACCOUNT,
        resolverAgora: rodarResolucao,
        waAccount: () => waPool.get(ACCOUNT),
        buscarFoto: (jid) => { fetchAvatar(jid).catch(() => {}) },
        // envio real de primeira mensagem: WhatsApp pelo Baileys, Instagram abrindo DM nova
        enviarWhatsapp: async ({ alvo, texto }) => {
          const acc = waPool.get(ACCOUNT)
          if (!acc || !acc.sock) throw new Error('WhatsApp não conectado')
          // primeira mensagem vai pro NÚMERO (o @lid sem sessão não entrega — ver verificar.mjs)
          return waSendText(acc.sock, alvoDeEnvio(ACCOUNT, alvo), texto)
        },
        enviarInstagram: async ({ alvo, texto }) => igSendToUsername({ accountKey: ACCOUNT, username: alvo, text: texto }),
      })
      if (handled) return
    }
    json(res, 404, { error: 'rota' })
  } catch (e) { json(res, 500, { error: e.message }) }
})

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' }

// Impressão digital de um arquivo estático. Barata de propósito (tamanho + mtime, não hash
// do conteúdo): roda a cada carregamento da página, e o deploy reescreve os arquivos, então
// o mtime sempre anda quando algo muda de verdade.
const digitalCache = new Map()
function digital(f) {
  try {
    const st = fs.statSync(f)
    const chave = `${st.size}-${st.mtimeMs}`
    const guardado = digitalCache.get(f)
    if (guardado && guardado.chave === chave) return guardado.hash
    const hash = crypto.createHash('md5').update(chave).digest('hex').slice(0, 10)
    digitalCache.set(f, { chave, hash })
    return hash
  } catch { return 'x' }
}

// O ?v= do panel.html era escrito na mão. Todo deploy que esquecia de bumpar ficava
// INVISÍVEL: o navegador continuava servindo o panel.js velho do cache e a mudança nova
// simplesmente não existia pra quem já tinha a página aberta. Agora o v sai do arquivo.
function versionarAssets(html) {
  return html.replace(/(src|href)="\/([^"?]+)(?:\?[^"]*)?"/g, (m, attr, rel) => {
    if (!/\.(js|css)$/.test(rel)) return m
    const f = path.join(PUBLIC, rel)
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f)) return m
    return `${attr}="/${rel}?v=${digital(f)}"`
  })
}

function serveFile(res, f, req) {
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404); res.end(); return }
    const ext = path.extname(f)
    // O NOME DA INSTÂNCIA NA TELA. O painel foi escrito com "vendas-multicanal" literal em ~70 lugares
    // (título, marca, abas, textos de ajuda), e no clone isso aparecia como o nome da OUTRA
    // pessoa — a tela do clone dizendo o nome da instância de origem. Traduzir na entrega
    // resolve os setenta de uma
    // vez, sem precisar caçar cada string.
    //
    // O que NÃO pode ser trocado: as chaves de localStorage (`vendas-multicanal.tinderView` e
    // companhia) guardam preferência de quem usa; renomeá-las apagaria o que ele ajustou. Por
    // isso a troca ignora `vendas-multicanal.` seguido de letra. A classe CSS que tinha esse nome foi
    // renomeada pra `msg-ia` — nome de instância não pode ser seletor.
    let corpo = buf
    if (ext === '.html') corpo = Buffer.from(versionarAssets(buf.toString('utf8')), 'utf8')
    if (SISTEMA !== 'vendas-multicanal' && (ext === '.html' || ext === '.js')) {
      corpo = Buffer.from(corpo.toString('utf8').replace(/vendas-multicanal(?!\.[A-Za-z])/g, SISTEMA), 'utf8')
    }
    const etag = `"${crypto.createHash('md5').update(corpo).digest('hex').slice(0, 16)}"`
    // no-cache não quer dizer "não guarde", quer dizer "guarde, mas confirme antes de usar".
    // Com o ETag isso vira um 304 de poucos bytes quando nada mudou, e entrega a versão nova
    // na hora quando mudou. Sem validador nenhum o navegador decide sozinho — e erra pro
    // lado de servir o velho, que foi exatamente o que aconteceu com o picker de áudio.
    const cabecalho = { 'content-type': MIME[ext] || 'application/octet-stream', etag, 'cache-control': 'no-cache' }
    if (req && req.headers['if-none-match'] === etag) { res.writeHead(304, cabecalho); res.end(); return }
    res.writeHead(200, cabecalho)
    res.end(corpo)
  })
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => { if (new URL(req.url, `http://${req.headers.host}`).pathname !== '/ws' || !authed(req)) { socket.destroy(); return } wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws)) })
wss.on('connection', (ws) => { sockets.add(ws); ws.on('close', () => sockets.delete(ws)); ws.on('error', () => sockets.delete(ws)) })


// ---------- ligar o toggle responde NA HORA ----------
// Regra do dono (27/07/2026), depois da Rayana: "ligar o toggle deve responder na hora caso
// tenha alguma mensagem sem responder da pessoa".
//
// Antes, ligar a IA só colocava a pessoa na fila normal: o laço passa pelos pendentes em
// ordem e a cadência ainda agenda a resposta pro futuro. Na prática deu 10 minutos entre o
// clique e a resposta — e o clique é justamente o momento em que ele decidiu que quer
// resposta AGORA. A cadência humana existe pra não parecer robô respondendo sozinho; quando
// é ele quem manda responder, ela não tem o que segurar.
//
// Faz duas coisas: solta a marca de "já tratei essa" (senão o laço pula) e agenda pra agora
// (o portão da cadência devolve 'send' na hora). Depois cutuca o tick do canal, pra não
// esperar a próxima volta de 45s.
function responderAgoraSePendente({ personId, channel }) {
  try {
    const fp = pendingFingerprint(personId)
    if (!fp) return false   // ela não está esperando: nada a fazer
    setAiSetting({ personId, channel, enabled: true, state: 'idle' })
    soltarTentativa(personId, channel)   // `null` no setAiSetting NÃO limpa; ver soltarTentativa
    setReplySchedule({ personId, channel, fp, replyAt: Date.now() })
    logEvent({ type: 'ai_on_responde_agora', personId, channel, detail: 'toggle ligado com mensagem dela sem resposta' })
    return true
  } catch (e) {
    logEvent({ type: 'ai_on_erro', personId, channel, detail: e.message })
    return false
  }
}

// Cutuca o canal certo pra a resposta sair no próximo instante, não na próxima volta do laço.
function cutucarCanal(channel) {
  const nada = () => {}
  if (channel === 'tinder') {
    const me = getMe()
    if (me && getToken()) serializeTinderOutbound(() => tinderAutoReplyTick({ api: tinderApi(), accountKey: ACCOUNT, myId: me.id, sendEnabled: getSetting('send_enabled', true) })).then(nada, nada)
  } else if (channel === 'whatsapp') {
    const acc = waPool.get(ACCOUNT)
    if (acc && acc.sock) waAutoReplyTick({ waAccount: acc, accountKey: ACCOUNT, sendEnabled: getSetting('send_enabled', true), onSent: (pid, jid) => broadcast({ t: 'message', jid, personId: pid }) }).then(nada, nada)
  } else if (channel === 'instagram') {
    igAutoReplyTick({ accountKey: ACCOUNT, sendEnabled: getSetting('send_enabled', true), onSent: (pid) => broadcast({ t: 'message', personId: pid }) }).then(nada, nada)
  } else if (channel === 'badoo') {
    badooAutoReplyTick({ accountKey: ACCOUNT, sendEnabled: getSetting('send_enabled', true), onSent: (pid) => broadcast({ t: 'message', personId: pid }) }).then(nada, nada)
  }
}

// ---------- fila de saída do Tinder ----------
// A API é uma única "mão": primeiras mensagens em lote e respostas automáticas
// compartilham esta trava para nunca enviar em paralelo na mesma conta.
let tinderOutboundTail = Promise.resolve()
function serializeTinderOutbound(action) {
  const run = tinderOutboundTail.then(action, action)
  tinderOutboundTail = run.catch(() => {})
  return run
}

let openerDrainPromise = null
function requestTinderOpenerDrain() {
  if (openerDrainPromise) return openerDrainPromise
  openerDrainPromise = serializeTinderOutbound(async () => {
    const me = getMe()
    if (!me || !getToken()) return 0
    let processed = 0
    while (await tinderOpenerTick({
      api: tinderApi(),
      accountKey: ACCOUNT,
      myId: me.id,
      sendEnabled: getSetting('send_enabled', true),
    })) {
      processed++
      broadcast({ t: 'state' })
      await new Promise((resolve) => setTimeout(resolve, 1200 + Math.floor(Math.random() * 900)))
    }
    return processed
  }).finally(() => { openerDrainPromise = null })
  return openerDrainPromise
}

// ---------- loop de auto-resposta ----------
// PRAZO E ISOLAMENTO POR ETAPA (15/08/2026, depois de acontecer). O laço é sequencial e os
// canais vinham crus: uma etapa pendurada segurava o `ticking` e calava TODO canal que vem
// depois dela. Medido na instancia-b — o bloco do Tinder travou às 15:02:50 e o WhatsApp, que é
// a linha seguinte, ficou 34 minutos sem rodar com cliente esperando resposta. Reiniciar
// dava UMA volta e travava de novo.
//
// Duas coisas aqui, e as duas importam:
//   1. PRAZO — `Promise.race` devolve o laço quando a etapa passa do tempo. Não cancela a
//      promessa pendurada (JS não cancela), e não precisa: o canal travado perde a vez, a
//      casa inteira não perde o dia.
//   2. ISOLAMENTO — erro de um canal não sobe mais até o `catch` do laço, que abortava as
//      etapas seguintes pelo mesmo efeito. Cada canal cai sozinho.
// Nos dois casos o Diário registra QUAL etapa caiu e por quê — sem isso, "a IA parou de
// responder" continua sendo um mistério que só o restart resolve.
const ETAPA_MS = Number(process.env.TIM_ETAPA_MS || 90000)
let etapaUltimoAviso = new Map()
async function etapa(nome, fn, ms = ETAPA_MS) {
  let timer = null
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, rejeitar) => {
        timer = setTimeout(() => rejeitar(Object.assign(new Error(`passou de ${Math.round(ms / 1000)}s sem responder`), { prazo: true })), ms)
      }),
    ])
  } catch (e) {
    // UMA linha por minuto por etapa: um canal quebrado não pode inundar o Diário e esconder
    // o resto. O primeiro registro sai na hora, sempre.
    const agora = Date.now()
    if (!(etapaUltimoAviso.get(nome) > agora - 60000)) {
      etapaUltimoAviso.set(nome, agora)
      logEvent({ type: e?.prazo ? 'loop_etapa_travou' : 'loop_etapa_erro', detail: `${nome}: ${e?.message || e}` })
    }
    return null
  } finally { if (timer) clearTimeout(timer) }
}

let ticking = false
async function loopTick() {
  if (ticking) return
  ticking = true
  // Freio de cota: com a IA pausada, nem entra nos ticks de resposta. O generateDraft
  // recusaria pessoa por pessoa de qualquer jeito (é ele o portão), mas aqui a gente evita
  // varrer a base inteira pra colecionar a mesma exceção. O resto do laço — sync, perfis,
  // agenda — continua rodando: quem está de castigo é a IA, não o sistema.
  const iaEmPausa = iaPausada()
  try {
    if (getToken()) {
      const s = (await etapa('tinder: conferir sessão', () => checkSession(), 45000)) || { ok: false, reason: 'a conferência da sessão não respondeu a tempo' }
      // ELE JÁ SABIA. Esta chamada existe desde sempre e o resultado morria aqui: em
      // 26/07/2026 a sessão caiu às 14:56 e o tick viu o 401 a cada volta, tentou o Chrome,
      // não conseguiu, e seguiu calado por 4h30. Registrar o que se viu é o que separa um
      // sistema que sabe de um sistema que avisa.
      if (!s.ok) {
        const r = await refreshFromChrome()
        if (!r) anunciarCanal(saudeRegistrar({ canal: 'tinder', ok: false, motivo: s.reason || 'sessão recusada' }))
        else anunciarCanal(saudeRegistrar({ canal: 'tinder', ok: true }))
      } else {
        anunciarCanal(saudeRegistrar({ canal: 'tinder', ok: true }))
      }
      const me = getMe()
      if (s.ok && me) {
        // A lista completa é a fonte autoritativa de quem ainda é match ativo. Faz uma
        // reconciliação leve e periódica para ocultar unmatches sem apagar históricos.
        const rosterAt = Number(getSetting('tinder_roster_synced_at', 0)) || 0
        const channelRosterV2 = getSetting('tinder_channel_roster_v2', false)
        if (!channelRosterV2 || Date.now() - rosterAt >= TINDER_ROSTER_INTERVAL_MS) {
          try {
            await etapa('tinder: reconciliar matches', () => syncMatches(tinderApi(), ACCOUNT, me.id, { withHistory: false, delayMs: 0 }))
            setSetting('tinder_roster_synced_at', Date.now())
            setSetting('tinder_channel_roster_v2', true)
            broadcast({ t: 'state' })
          } catch (e) {
            logEvent({ type: 'tinder_roster_err', detail: e.message })
          }
        }
        // sincroniza as novidades do Tinder (preview de todas + mensagens das que mudaram)
        // ANTES de responder, pra a IA ver o que chegou e o painel ficar em dia com o app.
        { const r = await etapa('tinder: sincronizar', () => syncTinderUpdates(tinderApi(), ACCOUNT, me.id)); if (r && r.fetched) broadcast({ t: 'state' }) }
        // O PERFIL DELAS. Roda depois do sync e antes de responder, mas é solto de propósito
        // (sem await): são centenas de matches a ~1,2s cada, e a resposta não pode esperar
        // varredura. Cada volta pega um pedaço da fila e marca o que já viu, então em poucas
        // horas a base inteira tem perfil e depois disso só entra match novo.
        if (getSetting('tinder_perfis', true)) {
          varrerPerfis({ api: tinderApi(), accountKey: ACCOUNT, limite: 25,
            deps: { tinderSemPerfil, setTinderPerfil, logEvent } })
            .then((r) => { if (r.guardados) broadcast({ t: 'state' }) })
            .catch((e) => logEvent({ type: 'tinder_perfil_err', detail: e?.message || String(e) }))
        }
        if (!iaEmPausa) await etapa('tinder: fila de aberturas', () => requestTinderOpenerDrain())
        const autoReplied = iaEmPausa ? false : await etapa('tinder: responder', () => serializeTinderOutbound(() => tinderAutoReplyTick({
          api: tinderApi(),
          accountKey: ACCOUNT,
          myId: me.id,
          sendEnabled: getSetting('send_enabled', true),
        })))
        if (autoReplied) broadcast({ t: 'state' })
        // Auto-deslizar: nasce DESLIGADO (swipe_enabled) e em modo sombra (swipe_dry_run).
        // Solto de propósito — uma sessão dura 4-15 min e não pode segurar as respostas,
        // que têm cadência própria. O mutex interno impede sobreposição.
        if (getSetting('swipe_enabled', false)) {
          swipeTick({ api: tinderApi() })
            .then((r) => { if (r) broadcast({ t: 'state' }) })
            .catch((e) => logEvent({ type: 'swipe_tick_err', channel: 'tinder', detail: e.message }))
        }
      }
    }
    // WhatsApp: responde as conversas com IA ligada (opt-in por pessoa).
    const acc = waPool.get(ACCOUNT)
    if (acc && acc.sock && !iaEmPausa) await etapa('whatsapp: responder', () => waAutoReplyTick({ waAccount: acc, accountKey: ACCOUNT, sendEnabled: getSetting('send_enabled', true), onSent: (personId, jid) => broadcast({ t: 'message', jid, personId }) }))
    // Instagram: idem (aba única, serializado internamente). Só roda se há alguém com IA ligada.
    if (getIgMe() && !iaEmPausa && aiEnabledPeople('instagram').length) await etapa('instagram: responder', () => igAutoReplyTick({ accountKey: ACCOUNT, sendEnabled: getSetting('send_enabled', true), onSent: (personId) => broadcast({ t: 'message', personId }) }))
    // Badoo: idem. Cada pessoa custa uma navegação, então só roda com alguém de IA ligada.
    if (badooGetCookies() && !iaEmPausa && aiEnabledPeople('badoo').length) await etapa('badoo: responder', () => badooAutoReplyTick({ accountKey: ACCOUNT, sendEnabled: getSetting('send_enabled', true), onSent: (personId) => broadcast({ t: 'message', personId }) }))
  } catch (e) { logEvent({ type: 'loop_error', detail: e.message }) } finally { ticking = false }
}
setInterval(loopTick, Number(process.env.TIM_LOOP_MS || 45000))

// ---------- fila de transcrição de áudio (local, offline) ----------
// O transcritor é uma CAPACIDADE que pode cair inteira, e quando cai não é culpa do áudio da
// vez: é a mesma família do canal que expira (src/core/saude-canais.mjs), então usa o mesmo
// alarme — avisa UMA vez, com a receita de como voltar, e a volta só fala se a queda falou.
// A carência existe pra não ficar tentando spawnar um binário inexistente a cada 12 segundos.
const TRANSCRITOR_CARENCIA_MS = Number(process.env.TIM_TRANSCRITOR_CARENCIA_MS || 300000)
let transcritorDeVoltaEm = 0
let transcribing = false
async function transcribeTick() {
  if (transcribing) return
  if (transcritorDeVoltaEm && Date.now() < transcritorDeVoltaEm) return
  transcribing = true
  try {
    for (const row of pendingAudioMessages(3)) {
      let media
      try { media = JSON.parse(row.media_json) } catch { continue }
      const fp = media && media.file ? path.join(MEDIA_DIR, media.file) : null
      if (!fp || !fs.existsSync(fp)) {
        setMessageMedia(row.message_id, { ...(media || {}), status: 'nofile' })
        // self-chat: se o áudio nem baixou, avisa uma vez (status deixa de ser 'pending', não repete)
        if (ehSelfPerson(ACCOUNT, row.person_id)) void enviarNoSelfChat({ sock: waPool.get(ACCOUNT)?.sock || null, accountKey: ACCOUNT, texto: 'não consegui baixar esse áudio pra ouvir aqui, manda de novo ou escreve pra mim', origem: 'sistema' })
        continue
      }
      const res = await transcribeAudio(fp)
      if (res && typeof res.text === 'string') {
        // Transcreveu: a máquina está de pé. A volta só é anunciada se a queda foi anunciada
        // (mesma regra dos canais — volta de queda muda é ruído).
        transcritorDeVoltaEm = 0
        const voltou = saudeRegistrar({ canal: 'transcricao', ok: true })
        if (voltou && voltou.tipo === 'voltou' && voltou.avisadaEm) void saudeVolta({ canal: 'transcricao', quanto: voltou.quanto, avisar: avisarNoSelfChat })
        setMessageMedia(row.message_id, { ...media, transcript: res.text, dur: media.dur || res.duration || null, status: 'done' })
        logEvent({ type: 'wa_audio_transcribed', personId: row.person_id, channel: 'whatsapp', detail: res.text.slice(0, 140) })
        void skillEvento('transcricao_pronta', { personId: row.person_id, canal: 'whatsapp', texto: String(res.text || '').trim(), messageId: row.message_id })
        // Áudio que EU mandei pra mim mesmo é comando falado: o assistente só consegue
        // ouvir depois da transcrição, então o gatilho dele mora aqui.
        if (ehSelfPerson(ACCOUNT, row.person_id) && res.text.trim()) {
          // ts=null de propósito: a peneira de frescor é do texto que chega ao vivo; aqui
          // o atraso é a fila de transcrição, e o id já garante que não repete.
          void tratarSelfChat({ texto: res.text.trim(), waMsgId: String(row.message_id).replace(/^wa:/, ''), ts: null })
        }
      } else if (falhaDeInfraestrutura(res && res.error)) {
        // O TRANSCRITOR caiu, não o áudio. Não carimba 'error' de jeito nenhum: o áudio fica
        // 'pending' e volta pra fila sozinho quando a máquina voltar. Marcar aqui queimaria
        // uma mensagem que nunca teve defeito (foi o que aconteceu com 54 áudios em 01/08).
        const transicao = saudeRegistrar({ canal: 'transcricao', ok: false, motivo: (res && res.error) || 'falha' })
        if (transicao && transicao.tipo === 'caiu') logEvent({ type: 'transcritor_caiu', detail: transicao.motivo })
        transcritorDeVoltaEm = Date.now() + TRANSCRITOR_CARENCIA_MS
        break   // é a máquina: os outros áudios da fila falhariam igual
      } else {
        setMessageMedia(row.message_id, { ...media, status: 'error', error: (res && res.error) || 'falha' })
        logEvent({ type: 'wa_audio_error', personId: row.person_id, channel: 'whatsapp', detail: (res && res.error) || 'falha' })
        // self-chat: transcrição falhou de verdade — avisa uma vez em vez de ficar mudo
        if (ehSelfPerson(ACCOUNT, row.person_id)) void enviarNoSelfChat({ sock: waPool.get(ACCOUNT)?.sock || null, accountKey: ACCOUNT, texto: 'não consegui entender esse áudio, manda de novo ou escreve pra mim', origem: 'sistema' })
      }
      broadcast({ t: 'message', personId: row.person_id })
    }
  } catch (e) { logEvent({ type: 'transcribe_error', detail: e.message }) } finally { transcribing = false }
}
setInterval(transcribeTick, 12000)

// ---------- visão das fotos do WhatsApp ----------
// Só chama o modelo para conversa com a IA ligada. O autoreply espera a descrição ficar
// pronta; quando ela chega, cutucamos o laço para responder sem aguardar mais 45 segundos.
setInterval(() => {
  waImageInterpretTick({ accountKey: ACCOUNT }).then((n) => {
    if (n) { broadcast({ t: 'state' }); void loopTick() }
  }).catch((e) => logEvent({ type: 'wa_image_tick_error', channel: 'whatsapp', detail: e.message }))
}, Number(process.env.TIM_WA_IMAGE_MS || 6000))

// ---------- sync periódico do Instagram (pesado: abre threads na aba única) ----------
let igSyncing = false
// QUANDO O INSTAGRAM PEDE PRA PARAR, A GENTE PARA.
//
// 31/07 a 02/08/2026: o Instagram devolveu 429 ("requisições demais") em 488 chamadas
// SEGUIDAS, dois dias inteiros, e este tick continuou batendo a cada 3 minutos — e pior, cada
// volta batia DUAS vezes, porque o 429 da API caía no catch e o sync pelo DOM rodava logo
// depois assim mesmo. Insistir num limite de taxa não fura o limite: sustenta ele. O canal
// ficou 2 dias fora e ninguém foi avisado, porque o Instagram nem linha tinha no canal_saude.
//
// 429 NÃO é sessão vencida (essa é 401/403, tratada em ig/api.mjs com retry de cookie fresco).
// Então a receita aqui é ESPERAR, dobrando: 15min, 30min, 1h, 2h, teto de 4h.
// O PRAZO MORA NO BANCO, NÃO NA MEMÓRIA. Deploy é rotina aqui (o push.sh reinicia o núcleo),
// e um backoff em variável de processo zera a cada restart: bastava eu subir código no meio da
// espera pra ele voltar a bater na hora, e o "recuo" nunca acontecia de fato. Foi o que quase
// aconteceu no deploy das 20:45 de 02/08/2026, minutos depois de eu escrever este backoff.
const IG_BACKOFF_BASE_MS = Number(process.env.TIM_IG_BACKOFF_MS || 900000)
const IG_BACKOFF_TETO_MS = Number(process.env.TIM_IG_BACKOFF_TETO_MS || 14400000)
const igDeVoltaEm = () => Number(getSetting('ig_backoff_ate', 0)) || 0
const igLimites = () => Number(getSetting('ig_backoff_n', 0)) || 0
const igCastigar = (n, ate) => { setSetting('ig_backoff_n', n); setSetting('ig_backoff_ate', ate) }
const igSoltar = () => { if (igLimites() || igDeVoltaEm()) igCastigar(0, 0) }
const ehLimiteDeTaxa = (msg) => /\b429\b/.test(String(msg || ''))

async function igSyncTick() {
  if (igSyncing || !getIgMe()) return
  // de castigo: nem a API nem o DOM batem, senão a espera não serve pra nada
  if (Date.now() < igDeVoltaEm()) return
  igSyncing = true
  try {
    // A API PRIMEIRO (docs/IG-API.md): traz id, hora, tipo e citação de verdade, é idempotente
    // (grava por item_id) e custa um round-trip contra ~10s de navegação por conversa. O DOM
    // continua rodando depois porque ainda faz o que a API não faz: descobrir conversa NOVA
    // (só ele conhece o id da URL, que é a chave da pessoa aqui) e a transcrição dos áudios.
    // Se a API falhar, o DOM sozinho mantém tudo funcionando — é o mesmo comportamento de antes.
    if (leituraPelaApiLigada()) {
      try {
        // 50 e não mais: em 100 o inbox devolve 500. Cobre as 50 conversas mais RECENTES —
        // as que estão vivas. As antigas seguem pelo DOM até a paginação por cursor existir.
        const r = await syncIgPelaApi({ accountKey: ACCOUNT, limite: 50 })
        if (r.gravadas) broadcast({ t: 'state' })
      } catch (e) {
        logEvent({ type: 'ig_api_erro', detail: e.message })
        if (ehLimiteDeTaxa(e.message)) {
          const n = igLimites() + 1
          const espera = Math.min(IG_BACKOFF_BASE_MS * 2 ** (n - 1), IG_BACKOFF_TETO_MS)
          igCastigar(n, Date.now() + espera)
          const min = Math.round(espera / 60000)
          const transicao = saudeRegistrar({
            canal: 'instagram',
            ok: false,
            motivo: `o Instagram está limitando as requisições (429) — ${n}ª vez seguida`,
            comoResolver: `nada na mão: o sistema está esperando ${min} min antes de tentar de novo. Se insistir agora, o bloqueio só aumenta. Se durar mais de um dia, aí sim reimporte os cookies pelo painel`,
          })
          if (transicao && transicao.tipo === 'caiu') logEvent({ type: 'ig_limite_taxa', detail: `esperando ${min} min` })
          return   // não roda o DOM: seria a segunda batida da mesma volta
        }
      }
    }
    const r = await syncInstagram({ accountKey: ACCOUNT, max: 8, onUpdate: (tid, pid) => broadcast({ t: 'message', personId: pid }) })
    // Chegou aqui sem 429: o canal está de pé. Zera o castigo e anuncia a volta (só se a
    // queda foi anunciada — mesma regra dos outros canais).
    igSoltar()
    const voltou = saudeRegistrar({ canal: 'instagram', ok: true })
    if (voltou && voltou.tipo === 'voltou' && voltou.avisadaEm) void saudeVolta({ canal: 'instagram', quanto: voltou.quanto, avisar: avisarNoSelfChat })
    broadcast({ t: 'state' })
    return r
  }
  catch (e) { logEvent({ type: 'ig_error', detail: e.message }) } finally { igSyncing = false }
}
setInterval(igSyncTick, Number(process.env.TIM_IG_SYNC_MS || 180000))

// A IA precisa OUVIR o áudio do Instagram. Tick próprio (e não dentro do sync) porque o
// whisper é local e demorado: travar o sync esperando transcrição atrasaria as mensagens de
// texto de todo mundo. A fila é o próprio banco (mensagem cujo texto ainda é o marcador).
let igAudioRodando = false
setInterval(async () => {
  if (igAudioRodando || !getIgMe()) return
  igAudioRodando = true
  try {
    const r = await transcreverAudiosIg()
    if (r.transcritos) broadcast({ t: 'state' })
  } catch (e) { logEvent({ type: 'ig_audio_tick_erro', detail: e.message }) }
  finally { igAudioRodando = false }
}, Number(process.env.TIM_IG_AUDIO_MS || 60000))

// ---------- sync periódico do Badoo (lista inteira + mensagens só de quem mudou) ----------
// A lista precisa ser quase realtime: com o intervalo antigo de 5 min, uma conversa ativa
// parecia sumida do painel. A rodada automática é curta (até 4 detalhes, esperas de 6s);
// o sync manual continua usando os tempos completos e serve para puxar o histórico todo.
let badooSyncing = false
async function badooSyncTick() {
  if (badooSyncing || !badooGetCookies()) return
  badooSyncing = true
  try {
    const r = await badooSincronizarNovidades({
      accountKey: ACCOUNT, max: 4, listaEsperaMs: 6000, conversaEsperaMs: 6000,
    })
    if (r.mudaram) broadcast({ t: 'state' })
  } catch (e) { logEvent({ type: 'badoo_erro', channel: 'badoo', detail: e.message }) } finally { badooSyncing = false }
}
setInterval(badooSyncTick, Number(process.env.TIM_BADOO_SYNC_MS || 60000))
setTimeout(badooSyncTick, 8000)

// ---------- descoberta do Badoo (fila de quem curtiu) — nasce DESLIGADA e em sombra ----------
// Solto do loop de resposta de propósito: uma sessão navega e clica, e não pode segurar as
// mensagens. O próprio badooSwipeTick não faz nada com `badoo_swipe_enabled` desligado.
setInterval(() => {
  badooSwipeTick({ accountKey: ACCOUNT }).then((r) => { if (r && r.decisoes.length) broadcast({ t: 'state' }) }).catch(() => {})
}, Number(process.env.TIM_BADOO_SWIPE_MS || 1800000))

// ---------- faxina de abas do Chrome ----------
// Aba vazada não parece problema: vira conversa sem resposta, porque o envio do Badoo e do
// Instagram é clique no DOM e o navegador saturado estoura o timeout. Ver src/browser/faxina.mjs.
setInterval(() => {
  faxinaDeAbas().then((r) => { if (r && r.fechadas) broadcast({ t: 'state' }) }).catch(() => {})
}, Number(process.env.TIM_FAXINA_MS || 600000))

// ---------- deslizar no baralho de Encontros do Badoo — nasce DESLIGADO e em sombra ----------
// Aba própria e fora do mutex do Badoo (o sync leva a aba compartilhada pra uma conversa no
// meio da sessão), então não segura nem as mensagens nem a fila de curtidas. O tick só age
// quando a hora de uma sessão do plano chega; com o agendador desligado não faz nada.
setInterval(() => {
  encontrosTick({ accountKey: ACCOUNT }).then((r) => { if (r && r.decididas) broadcast({ t: 'state' }) }).catch(() => {})
}, Number(process.env.TIM_BADOO_ENCONTROS_MS || 300000))

// ---------- poll LEVE do inbox do Instagram (realtime da lista: só lê, não abre threads) ----------
let igInboxPolling = false
async function igInboxTick() {
  // igExclusive já serializa no browser; não gatilhamos com igSyncing (evita deadlock se
  // o sync pesado travar). Só o self-guard pra não empilhar poll leve em cima de poll leve.
  if (igInboxPolling || !getIgMe()) return
  // O CASTIGO VALE PROS DOIS TICKS. Este roda a cada 45s — quatro vezes mais que o sync
  // pesado — então backoff que só cobre o outro não é backoff: durante a queda de 31/07 a
  // 02/08/2026 este aqui sozinho bateu ~1.900 vezes por dia enquanto o Instagram pedia pra
  // parar. Cobrir só o caminho instrumentado foi um erro meu, e é o tipo de erro que dá
  // sensação de conserto sem o conserto.
  if (Date.now() < igDeVoltaEm()) return
  igInboxPolling = true
  try {
    const n = await igSyncInboxLight({ accountKey: ACCOUNT })
    if (n) broadcast({ t: 'state' })
    // Leu sem 429: o canal está de pé. Este tick é o mais frequente, então é ele quem
    // percebe a volta primeiro — e é o único que percebe quando o sync pesado está lento.
    igSoltar()
    const voltou = saudeRegistrar({ canal: 'instagram', ok: true })
    if (voltou && voltou.tipo === 'voltou' && voltou.avisadaEm) void saudeVolta({ canal: 'instagram', quanto: voltou.quanto, avisar: avisarNoSelfChat })
  } catch (e) {
    logEvent({ type: 'ig_error', detail: e.message })
    if (ehLimiteDeTaxa(e.message)) {
      const n = igLimites() + 1
      const espera = Math.min(IG_BACKOFF_BASE_MS * 2 ** (n - 1), IG_BACKOFF_TETO_MS)
      igCastigar(n, Date.now() + espera)
      saudeRegistrar({
        canal: 'instagram', ok: false,
        motivo: `o Instagram está limitando as requisições (429) — ${n}ª vez seguida`,
        comoResolver: `nada na mão: o sistema está esperando ${Math.round(espera / 60000)} min antes de tentar de novo. Se insistir agora, o bloqueio só aumenta. Se durar mais de um dia, aí sim reimporte os cookies pelo painel`,
      })
    }
  } finally { igInboxPolling = false }
}
setInterval(igInboxTick, Number(process.env.TIM_IG_INBOX_MS || 45000))

// ---------- interpretação de mídia do IG (imagem/vídeo) — só trabalha se o setting media_interpret estiver LIGADO ----------
setInterval(() => { mediaInterpretTick({ accountKey: ACCOUNT }).then((n) => { if (n) broadcast({ t: 'state' }) }).catch(() => {}) }, Number(process.env.TIM_IG_MEDIA_MS || 90000))

// VARREDURA DE TESTE dos tipos avançados de WhatsApp. Manda um exemplo de cada pro alvo e
// devolve [{type, ok, id|erro}]. Tipos que operam sobre uma mensagem (react/pin/edit/delete/
// reply) ganham uma âncora própria logo antes. Delay entre envios evita rate-limit/ordem.
async function testSweep(sock, jid, only) {
  const espera = (ms) => new Promise((r) => setTimeout(r, ms))
  const now = Date.now()
  const digitos = String(jid).replace(/\D/g, '')
  // params de exemplo por tipo (mídia usa arquivos gerados em MEDIA_DIR: sweep*.*)
  const exemplo = {
    text: { type: 'text', texto: 'teste: texto simples' },
    mention: { type: 'mention', texto: `teste menção @${digitos}`, mentions: [jid] },
    spoiler: { type: 'spoiler', texto: 'teste spoiler' },
    image: { type: 'image', file: 'sweepimg.jpg', caption: 'teste imagem' },
    video: { type: 'video', file: 'sweepvid.mp4', caption: 'teste vídeo' },
    gif: { type: 'gif', file: 'sweepvid.mp4' },
    ptv: { type: 'ptv', file: 'sweepsq.mp4' },
    audio: { type: 'audio', file: 'sweepaud.mp3' },
    voice: { type: 'voice', file: 'sweepaud.ogg' },
    document: { type: 'document', file: 'sweepdoc.pdf', fileName: 'teste.pdf', mimetype: 'application/pdf' },
    sticker: { type: 'sticker', file: 'teststicker.webp' },
    location: { type: 'location', lat: -25.4284, lng: -49.2733, nome: 'Curitiba', endereco: 'PR' },
    contact: { type: 'contact', nome: 'Contato Teste', telefone: '+55 11 99999-0003' },
    poll: { type: 'poll', pergunta: 'Cor favorita?', opcoes: ['Azul', 'Verde', 'Vermelho'] },
    event: { type: 'event', nome: 'Evento Teste', descricao: 'gerado no teste', inicio: now + 3600000 },
    externalAdReply: { type: 'externalAdReply', texto: 'olha esse link', titulo: 'Título do card', corpo: 'Descrição', sourceUrl: 'https://example.com' },
    ephemeral: { type: 'ephemeral', ligar: true, segundos: 86400 },
    buttons: { type: 'buttons', texto: 'Escolha uma opção', botoes: ['Sim', 'Não', 'Talvez'] },
    list: { type: 'list', titulo: 'Menu', descricao: 'escolha', itens: ['Item A', 'Item B'] },
    interactive: { type: 'interactive', texto: 'Interativo', botoes: [{ texto: 'Botão 1', id: '1' }] },
    template: { type: 'template', texto: 'Template', botoes: [{ texto: 'Ok', id: 'ok' }] },
  }
  const precisaAlvo = { reply: 1, react: 1, pin: 1, edit: 1, delete: 1 }
  const lista = WA_ADV_CATALOGO.map((c) => c.type).filter((t) => !only || (Array.isArray(only) ? only.includes(t) : only === t))
  const out = []
  for (const type of lista) {
    try {
      if (precisaAlvo[type]) {
        // âncora própria
        const anc = await sock.sendMessage(jid, { text: `âncora p/ ${type}` })
        await espera(500)
        const targetKey = anc.key
        let spec
        if (type === 'reply') spec = { type: 'reply', texto: 'teste: resposta citando', quoted: anc }
        else if (type === 'react') spec = { type: 'react', emoji: '❤️', targetKey }
        else if (type === 'pin') spec = { type: 'pin', targetKey, time: 86400 }
        else if (type === 'edit') spec = { type: 'edit', texto: 'teste: mensagem editada', targetKey }
        else if (type === 'delete') spec = { type: 'delete', targetKey }
        const r = await waSendAdvanced(sock, jid, spec, { now, targetKey, quoted: anc })
        out.push({ type, ok: true, id: r.providerMessageId })
      } else {
        const r = await waSendAdvanced(sock, jid, exemplo[type], { now })
        out.push({ type, ok: true, id: r.providerMessageId })
      }
    } catch (e) { out.push({ type, ok: false, erro: e && e.message ? e.message : String(e) }) }
    await espera(700)
  }
  return out
}

// ---------- agenda: mantém o cache quente + varre conversas em busca de compromisso ----------
let agendaTicking = false
async function agendaTick() {
  if (agendaTicking || !agendaConnectionState().connected) return
  agendaTicking = true
  try {
    await ensureAgendaFresh() // cache pro cérebro (TTL interno de 5 min)
    await agendaDetectTick({ accountKey: ACCOUNT, onProposal: () => broadcast({ t: 'state' }) })
  } catch (e) { logEvent({ type: 'agenda_tick_error', detail: e.message }) } finally { agendaTicking = false }
}
setInterval(agendaTick, Number(process.env.TIM_AGENDA_MS || 120000))
if (agendaConnectionState().connected) refreshAgenda().catch(() => {}) // aquece no boot

// Etiqueta Fatal (origem do anúncio): nasce com o motor e retroage UMA vez no histórico.
// Sem isto o clone sobe sem a marca e o histórico anterior fica sem etiqueta,
// porque a regra automática só vale para mensagens novas.
try {
  garantirEtiquetaFatal()
  const fatal = retroagirFatal()
  if (!fatal.pulou && fatal.novas) {
    console.log(`[vendas-multicanal] Fatal: ${fatal.novas} pessoa(s) do histórico etiquetadas`)
  }
} catch (e) { try { logEvent({ type: 'etiqueta_fatal_erro', detail: e.message }) } catch {} }
try {
  const cid = retroagirCidades()
  if (cid.pessoas) console.log(`[vendas-multicanal] cidade: ${cid.pessoas} pessoa(s) com cidade (perfil ${cid.perfis}, texto ${cid.textos}, conflito ${cid.conflitos})`)
} catch (e) { try { logEvent({ type: 'cidade_erro', detail: e.message }) } catch {} }

// se o WhatsApp já foi pareado antes, religa sozinho no boot
const waPrev = getWaSession(ACCOUNT)
if (waPrev && waPrev.status && waPrev.status !== 'IDLE') waPool.getOrCreate(ACCOUNT, waCallbacks()).start().catch(() => {})

// Resposta que ficou marcada como "gerando" quando o processo caiu: sem isso a pessoa
// nunca mais é respondida (a marca anti-duplicata sobrevive ao processo). Ver db.mjs.
try {
  const orfas = recuperarGeracoesOrfas()
  for (const o of orfas) logEvent({ type: 'auto_geracao_recuperada', personId: o.person_id, channel: o.channel, detail: 'boot: geração interrompida, marca solta pra tentar de novo' })
  if (orfas.length) console.log(`[vendas-multicanal] ${orfas.length} geração(ões) interrompida(s) recuperada(s) no boot`)
} catch {}
try {
  const n = garantirEnabledAt()
  if (n) logEvent({ type: 'ia_enabled_at_backfill', detail: `${n} linha(s) de IA ligada ganharam a data da virada` })
} catch {}
// Adota no boot qualquer histórico órfão de conversa vinculada (nenhuma conversa vazia).
try { const o = repairOrphanWaMessages(ACCOUNT); if (o.movidas) logEvent({ type: 'vinculo_reparou_orfas', detail: `boot: ${o.movidas} mensagens em ${o.conversas} conversa(s)` }) } catch {}
// Conserta chats mal-posicionados por mensagem de controle (protocolMessage etc.) no boot.
try { const r = pruneControlChatMetadata(ACCOUNT); if (r.fixed || r.removed) logEvent({ type: 'wa_control_prune', detail: `corrigidos ${r.fixed}, removidos ${r.removed}` }) } catch {}
// LID: junta os chats-número com o gêmeo @lid (mesma pessoa). No boot + a cada 60s.
try { refreshLidMap() } catch {}
setInterval(() => { try { reconcileLidDuplicates() } catch (e) { logEvent({ type: 'wa_lid_error', detail: e.message }) } }, Number(process.env.TIM_WA_LID_MS || 60000))

// ---------- Vínculo: os 4 gatilhos (docs/PLANO-IDENTIDADE-VINCULO.md §2.5) ----------
// 1) na hora (chamado por quem colhe um hint novo), 2) no boot, 3) periódico leve,
// 4) sob demanda pela rota /api/vinculos/resolver. Uma execução por vez.
let resolvendo = false
let resolucaoAgendada = null
export async function rodarResolucao({ limite = 25, hintId = null } = {}) {
  if (resolvendo) return null
  resolvendo = true
  try {
    const r = await resolverPendentes(waPool.get(ACCOUNT), ACCOUNT, { limite, mergePeople, hintId })
    const consolidado = consolidateWaIdentities(ACCOUNT)
    if (consolidado.removidos) logEvent({ type: 'vinculo_consolidado', detail: `${consolidado.removidos} duplicado(s) de ${consolidado.pessoas} pessoa(s)` })
    const orfas = repairOrphanWaMessages(ACCOUNT)   // nenhuma conversa pode abrir vazia
    if (orfas.movidas) logEvent({ type: 'vinculo_reparou_orfas', detail: `${orfas.movidas} mensagens em ${orfas.conversas} conversa(s)` })
    const conferencia = conferirTodos(ACCOUNT)     // o vínculo aponta pro número que ela escreveu?
    if (conferencia.divergente) logEvent({ type: 'vinculo_divergente_resumo', detail: `${conferencia.divergente} vínculo(s) apontando pro número errado` })
    const estados = reconcileLinkStates(ACCOUNT, 'whatsapp')
    if (r.vinculados || r.ambiguos) broadcast({ t: 'state' })
    return { ...r, estados }
  } finally { resolvendo = false }
}
function agendarResolucao(atrasoMs = 4000) {
  if (resolucaoAgendada) return
  resolucaoAgendada = setTimeout(() => {
    resolucaoAgendada = null
    rodarResolucao().catch((e) => logEvent({ type: 'vinculo_erro', detail: e.message }))
  }, atrasoMs)
}
// Chamar primeiro em canal novo. Com os interruptores desligados (o padrão), este tick não
// faz nada — a trava está no chamar.mjs, não aqui. Uma pessoa por rodada, por canal.
const CHAMAR_MS = Number(process.env.TIM_CHAMAR_MS || 900000)
let chamando = false
async function rodarChamadas() {
  if (chamando) return null
  chamando = true
  try {
    const r = await chamarTick({
      accountKey: ACCOUNT,
      porRodada: 1,
      enviarWhatsapp: async ({ alvo, texto }) => {
        const acc = waPool.get(ACCOUNT)
        if (!acc || !acc.sock) throw new Error('WhatsApp não conectado')
        return waSendText(acc.sock, alvoDeEnvio(ACCOUNT, alvo), texto)
      },
      enviarInstagram: async ({ alvo, texto }) => igSendToUsername({ accountKey: ACCOUNT, username: alvo, text: texto }),
    })
    if (r.whatsapp.length || r.instagram.length) broadcast({ t: 'state' })
    return r
  } finally { chamando = false }
}
if (CHAMAR_MS > 0) {
  setInterval(() => { rodarChamadas().catch((e) => logEvent({ type: 'chamada_erro', detail: e.message })) }, CHAMAR_MS)
  // Um disparo logo depois do boot. Sem isto, cada restart zera o relógio de 15 min: numa
  // tarde de deploys seguidos a chamada automática nunca acontece — e em silêncio, porque
  // ninguém erra, só nada roda (achado com a fixture sintética em 25/07/2026). 90s dá tempo do
  // WhatsApp conectar e do resolvedor rodar antes.
  setTimeout(() => { rodarChamadas().catch((e) => logEvent({ type: 'chamada_erro', detail: e.message })) }, 90000)
}

const RESOLVE_MS = Number(process.env.TIM_RESOLVE_MS || 600000)
if (RESOLVE_MS > 0) setInterval(() => { rodarResolucao().catch((e) => logEvent({ type: 'vinculo_erro', detail: e.message })) }, RESOLVE_MS)

// ---------- iniciativas (nível 1: só sugere; enviar é decisão do dono) ----------
// Rascunho: o MESMO generateDraft de sempre (voz, vínculo, memória, janela), só que com
// a tarefa de INICIATIVA — reusa tudo que o sistema já sabe sobre a pessoa.
async function gerarRascunhoIniciativa(c) {
  const nome = personDisplayName(c.personId) || null
  const canalIni = c.canal === 'instagram' ? 'instagram' : c.canal === 'whatsapp' ? 'whatsapp' : 'tinder'
  const draft = await generateDraft({ personId: c.personId, name: nome, channel: canalIni,
    profile: canalIni === 'tinder' ? perfilDaPessoa(ACCOUNT, c.personId, { tinderMatchPorPessoa, getTinderPerfil }) : undefined,
    iniciativa: { gatilho: c.gatilho, motivo: c.motivo },
    usageOrigin: 'iniciativa', usageTrigger: 'automatico' })
  return draft
}

// Envio de uma iniciativa APROVADA, pelo canal da conversa. Reusa os caminhos manuais.
async function enviarIniciativa({ personId, canal, texto }) {
  const ts = Date.now()
  if (canal === 'whatsapp') {
    const acc = waPool.get(ACCOUNT)
    if (!acc || !acc.sock) throw new Error('WhatsApp offline')
    const jid = waJidForPerson(ACCOUNT, personId) || (String(personId).startsWith('wa:') ? String(personId).slice(3) : null)
    if (!jid) throw new Error('sem jid de WhatsApp pra essa pessoa')
    const r = await waSendText(acc.sock, alvoDeEnvio(ACCOUNT, jid), texto)
    const mid = 'wa:' + (r && r.providerMessageId ? r.providerMessageId : jid + ':out:' + ts)
    addMessage({ messageId: mid, accountKey: ACCOUNT, personId, channel: 'whatsapp', direction: 'outgoing', text: texto, ts, author: 'ia' })
    marcarAutor({ channel: 'whatsapp', messageId: mid, author: 'ia' })
    upsertWaChat({ accountKey: ACCOUNT, jid, lastText: texto, lastTs: ts })
    registrarAssercao({ personId, channel: 'whatsapp', messageId: mid, texto, fatos: [] })
    broadcast({ t: 'message', jid, personId })
    return
  }
  if (canal === 'instagram') {
    const tid = String(personId).startsWith('ig:') ? String(personId).slice(3) : db().prepare(`SELECT thread_id FROM ig_chat WHERE account_key=? AND ('ig:'||thread_id)=?`).get(ACCOUNT, personId)?.thread_id
    if (!tid) throw new Error('sem thread de Instagram pra essa pessoa')
    await igSendToThread({ accountKey: ACCOUNT, threadId: tid, text: texto, author: 'ia' })
    registrarAssercao({ personId, channel: 'instagram', texto, fatos: [] })
    broadcast({ t: 'message', personId })
    return
  }
  // tinder
  const m = db().prepare(`SELECT match_id, other_id FROM tinder_match WHERE account_key=? AND person_id=?`).get(ACCOUNT, personId)
  if (!m) throw new Error('sem match do Tinder pra essa pessoa')
  const me = getSetting('tinder_me', null)
  const r = await tinderApi().sendText({ matchId: m.match_id, otherId: m.other_id || otherIdFromMatch(m.match_id, me?.id), userId: me?.id, text: texto })
  if (!r.ok) throw new Error('Tinder recusou o envio (status ' + r.status + ')')
  recordTinderOutgoingMessage({ messageId: `local:${m.match_id}:iniciativa:${ts}`, accountKey: ACCOUNT, matchId: m.match_id, personId, text: texto, ts, author: 'ia' })
  registrarAssercao({ personId, channel: 'tinder', texto, fatos: [] })
  broadcast({ t: 'message', personId })
}

// Tick: detecta e SUGERE (nunca envia). Uma rodada por hora é suficiente — iniciativa é
// sobre dias de silêncio, não minutos. Reversível: setting iniciativa_enabled.
const INICIATIVA_MS = Number(process.env.TIM_INICIATIVA_MS || 3600000)
if (INICIATIVA_MS > 0) setInterval(() => {
  detectarIniciativas({ gerarRascunho: gerarRascunhoIniciativa })
    .then((r) => { if (r.novas) { broadcast({ t: 'state' }); logEvent({ type: 'iniciativa_deteccao', detail: `${r.novas} nova(s) na fila` }) } })
    .catch((e) => logEvent({ type: 'iniciativa_erro', detail: e.message }))
}, INICIATIVA_MS)

// ---------- memória por pessoa (consolidação de fundo) ----------
// Uma pessoa por vez, espaçado, FORA do caminho da resposta: a IA nunca espera por isto.
// É o que faz a lembrança sobreviver ao corte de 1.000 mensagens do histórico. Reversível
// pelo setting `memoria_auto` (o bloco no prompt tem o seu próprio: `memoria_pessoa`).
// ---------- fotos do WhatsApp que faltam ----------
// A foto só chegava quando alguma tela pedia, então quem não aparecia na lista do WhatsApp
// ficava sem cara pra sempre — inclusive nas telas de identidade, onde a foto é justamente
// o que deixa conferir se é a pessoa certa. Isto preenche devagar (3 por minuto), sem
// insistir em quem já foi tentado nas últimas 24h.
const AVATAR_MS = Number(process.env.TIM_AVATAR_MS || 60000)
if (AVATAR_MS > 0) setInterval(async () => {
  try {
    const acc = waPool.get(ACCOUNT)
    if (!acc || !acc.sock) return
    const alvos = db().prepare(`SELECT jid FROM wa_chat
      WHERE account_key=? AND avatar IS NULL AND (avatar_tried_at IS NULL OR avatar_tried_at < ?)
        AND jid NOT LIKE '%@g.us' AND last_ts IS NOT NULL
      ORDER BY last_ts DESC LIMIT 3`).all(ACCOUNT, Date.now() - 86400000)
    for (const a of alvos) {
      db().prepare(`UPDATE wa_chat SET avatar_tried_at=? WHERE account_key=? AND jid=?`).run(Date.now(), ACCOUNT, a.jid)
      await fetchAvatar(a.jid)
    }
  } catch { /* foto é enfeite: nunca pode atrapalhar o resto */ }
}, AVATAR_MS)

const MEMORIA_MS = Number(process.env.TIM_MEMORIA_MS || 300000)
let consolidandoMemoria = false
if (MEMORIA_MS > 0) setInterval(async () => {
  if (consolidandoMemoria || !getSetting('memoria_auto', true)) return
  consolidandoMemoria = true
  try {
    const [alvo] = pessoasParaConsolidar({ limite: 1, somenteComIa: true, economica: true })
    if (alvo) {
      const r = await consolidarPessoa(alvo.personId)
      if (r) { logEvent({ type: 'memoria_pessoa', personId: r.personId, detail: `v${r.versao}, ${r.lidas} msgs lidas de ${r.total}` }); broadcast({ t: 'state' }) }
    }
  } catch (e) { logEvent({ type: 'memoria_erro', detail: e.message }) } finally { consolidandoMemoria = false }
}, MEMORIA_MS)
setTimeout(() => { rodarResolucao({ limite: 60 }).catch(() => {}) }, 20000) // no boot, depois da colheita

// Colhe do histórico os contatos que as pessoas já passaram (telefone/@ do Instagram) uma
// vez por boot. Idempotente (índice único no contact_hint) e só leitura+insert — não
// vincula nada, quem vincula é o resolvedor. Roda solto pra não atrasar o boot.
setTimeout(() => {
  try {
    const r = colherHistorico(ACCOUNT)
    if (r.novos) logEvent({ type: 'hints_colhidos', detail: `${r.novos} novos de ${r.mensagens} mensagens: ` + JSON.stringify(r.porTipo) })
  } catch (e) { logEvent({ type: 'hint_error', detail: 'histórico: ' + e.message }) }
}, 8000)

// Backfill do número dos @lid CEGOS (conversa que chegou sem número resolvido). Enquanto
// eles ficam cegos, nenhum vínculo do Tinder consegue casar com aquela conversa. Roda em
// lotes lentos e só com a sessão conectada — cada resolução vira uma consulta ao servidor.
// TIM_WA_BACKFILL_MS=0 desliga.
const BACKFILL_MS = Number(process.env.TIM_WA_BACKFILL_MS || 300000)
let backfillRodando = false
async function backfillLidsCegos(limite = 25) {
  if (backfillRodando) return 0
  const acc = waPool.get(ACCOUNT)
  if (!acc || !acc.sock) return 0
  const cegos = db().prepare(`SELECT jid FROM wa_chat WHERE account_key=? AND jid LIKE '%@lid' AND pn IS NULL
    ORDER BY last_ts DESC LIMIT ?`).all(ACCOUNT, limite).map((r) => r.jid)
    .filter((jid) => !waPnForLid(jid))
  if (!cegos.length) return 0
  backfillRodando = true
  try {
    const r = await backfillPns(acc, cegos, { pausaMs: 400 })
    for (const lid of cegos) { const pn = waPnForLid(lid); if (pn) waChatSetPn(ACCOUNT, lid, pn) }
    if (r.resolvidos) { reconcileLidDuplicates(); broadcast({ t: 'state' }) }
    return r.resolvidos
  } finally { backfillRodando = false }
}
if (BACKFILL_MS > 0) setInterval(() => { backfillLidsCegos().catch((e) => logEvent({ type: 'wa_backfill_error', detail: e.message })) }, BACKFILL_MS)

// ---------- Projetos: lembretes disparam no self-chat do dono (mensagem pra você mesmo) ----------
// jid próprio, sem sufixo de dispositivo (sock.user.id vem como '55...:NN@s.whatsapp.net').
function selfJid() {
  const raw = (waPool.get(ACCOUNT)?.sock?.user?.id) || getWaSession(ACCOUNT)?.jid || null
  return raw ? normalizeJid(raw) : null
}
let remTicking = false
async function reminderTickLoop() {
  if (remTicking) return
  remTicking = true
  try {
    const n = await reminderTick({
      getSock: () => waPool.get(ACCOUNT)?.sock || null, getSelfJid: selfJid, broadcast,
      // registra o id da mensagem: é o que impede o lembrete de voltar como comando
      enviarSelf: (texto) => enviarNoSelfChat({ sock: waPool.get(ACCOUNT)?.sock || null, accountKey: ACCOUNT, texto, origem: 'sistema' }),
    })
    if (n) broadcast({ t: 'state' })
    // O que o vendas-multicanal pode falar sem ser chamado (só o que o dono ligou).
    await proativoTick(ctxAssistente())
    const cob = await tickCobrancasProgramadas({ enviarParaPessoa })
    if (cob) broadcast({ t: 'state' })
    const { aplicarCobrancaNecessidades } = await import('./necessidades/cobranca.mjs')
    const nec = aplicarCobrancaNecessidades()
    if (nec?.ligadas) broadcast({ t: 'state' })
  } catch (e) { logEvent({ type: 'reminder_tick_error', detail: e.message }) } finally { remTicking = false }
}

// ---------- Assistente pessoal: o self-chat é o console dele ----------
// Uma mensagem só vira comando se passar por TRÊS peneiras, nesta ordem: já processada
// (reentrega do baileys), eco nosso (a própria resposta voltando) e frescor (histórico
// antigo reentregue numa reconexão não pode disparar 200 comandos).
const SELF_FRESCOR_MS = 10 * 60 * 1000
function ctxAssistente() {
  return { accountKey: ACCOUNT, sock: waPool.get(ACCOUNT)?.sock || null, broadcast, enviarParaPessoa }
}
async function tratarSelfChat({ texto, waMsgId, ts }) {
  try {
    // Sem checar assistenteLigado() aqui de propósito: com a IA desligada, "ia on" precisa
    // chegar no conversar (é lá que o interruptor por texto é lido, antes dos portões).
    if (waMsgId && assistJaViu(waMsgId)) return
    if (ehEcoNosso({ waMsgId, texto })) return
    if (ts && Date.now() - ts > SELF_FRESCOR_MS) { logEvent({ type: 'assistente_ignorou_antiga', detail: String(texto).slice(0, 60) }); return }
    await conversar({ texto, origem: 'whatsapp', waMsgId, ctx: ctxAssistente() })
  } catch (e) { logEvent({ type: 'assistente_erro', detail: e.message }) }
}

// Envio de verdade pra uma pessoa (só depois do dono confirmar — nível externa).
async function enviarParaPessoa({ personId, canal, texto }) {
  if (ehSelfPerson(ACCOUNT, personId)) throw new Error('essa é a sua conversa comigo')
  if (canal === 'instagram') {
    const threadId = String(personId).startsWith('ig:') ? String(personId).slice(3) : null
    if (!threadId) throw new Error('essa pessoa não tem conversa de Instagram')
    await igSendToThread({ accountKey: ACCOUNT, threadId, text: texto, author: 'ia' })
    return { canal, personId }
  }
  if (canal === 'tinder') {
    const m = db().prepare(`SELECT * FROM tinder_match WHERE person_id=?`).get(personId)
    const me = getMe()
    if (!m || !me) throw new Error('não achei o match no Tinder')
    const r = await tinderApi().sendText({ matchId: m.match_id, otherId: m.other_id || otherIdFromMatch(m.match_id, me.id), userId: me.id, text: texto })
    recordTinderOutgoingMessage({ messageId: 'local:' + Date.now(), accountKey: ACCOUNT, matchId: m.match_id, personId, text: texto, ts: Date.now(), author: 'ia' })
    return { canal, personId, ok: !!r }
  }
  const acc = waPool.get(ACCOUNT)
  if (!acc || !acc.sock) throw new Error('WhatsApp não conectado')
  const jid = waJidForPerson(ACCOUNT, personId)
  if (!jid) throw new Error('essa pessoa não tem WhatsApp vinculado')
  const r = await waSendText(acc.sock, alvoDeEnvio(ACCOUNT, jid), texto)
  const midAss = 'wa:' + (r?.providerMessageId || jid + ':out:' + Date.now())
  addMessage({ messageId: midAss, accountKey: ACCOUNT, personId, channel: 'whatsapp', direction: 'outgoing', text: texto, ts: Date.now(), author: 'ia' })
  marcarAutor({ channel: 'whatsapp', messageId: midAss, author: 'ia' })
  broadcast({ t: 'message', jid, personId })
  return { canal: 'whatsapp', personId }
}
setInterval(reminderTickLoop, Number(process.env.TIM_REMINDER_MS || 30000))

// Autoria retroativa: devolve "quem escreveu" às mensagens anteriores à coluna `author`,
// casando cada envio com o evento que ele deixou no diário. Roda uma vez só (a varredura
// completa é cara e não muda de resultado) e nunca sobrescreve carimbo existente.
// Ver src/core/autoria.mjs.
// MISSÕES: o laço que faz um objetivo do dono andar sozinho até a prova passar.
// Roda no núcleo (e não dentro do turno do agente) de propósito: assim a missão sobrevive a
// restart e a deploy — inclusive ao deploy que o próprio agente faz pra testar o que
// escreveu, que aqui é o caso COMUM. Uma volta por vez, serializada.
let missaoOcupado = false
async function missaoTick() {
  if (missaoOcupado) return
  missaoOcupado = true
  try {
    await missaoRodarTick({
      avisar: async (texto) => {
        try { await enviarNoSelfChat({ sock: waPool.get(ACCOUNT)?.sock || null, accountKey: ACCOUNT, texto, origem: 'sistema' }) }
        catch (e) { logEvent({ type: 'missao_aviso_erro', detail: e.message }) }
        broadcast({ t: 'assistente' })
      },
    })
  } catch (e) { logEvent({ type: 'missao_erro', detail: e.message }) } finally { missaoOcupado = false }
}
setInterval(missaoTick, Number(process.env.TIM_MISSAO_TICK_MS || 45000))
// Gatilhos agendados das skills. Separado do tick de missão de propósito: uma skill lenta
// não pode atrasar o laço que faz as missões andarem.
setInterval(() => { skillCron().catch((e) => logEvent({ type: 'skill_cron_erro', detail: e.message })) },
  Number(process.env.TIM_SKILL_CRON_MS || 60000))

// O AVISO. Vai pro self-chat do WhatsApp, que é onde ele já olha — e ao painel pelo
// broadcast. Uma vez por queda, nunca por minuto: alarme que repete vira alarme ignorado.
// AVISO DO SISTEMA NÃO VAI PRO WHATSAPP. Decisão do dono (03/08/2026): ele acompanha pelo
// painel, e o WhatsApp fica só pra conversa com gente.
//
// Nem tenta mandar, de propósito. A versão anterior tentava, batia na trava de abertura a
// frio e só então caía no Diário — trabalho jogado fora em toda queda de canal, e uma linha
// de log suja ("não saiu no WhatsApp: ...") em cada alarme. Aqui o Diário é o destino, não o
// plano B.
//
// Isto NÃO desliga o assistente: quando ela escreve no self-chat, a resposta continua indo
// por `enviarNoSelfChat` (caminho separado), e a trava deixa passar porque aí existe
// mensagem recebida. O que morreu é só o sistema cutucar sozinho.
function avisarNoSelfChat(texto) {
  logEvent({ type: 'alarme', detail: String(texto).replace(/\n/g, ' | ').slice(0, 240) })
  broadcast({ t: 'state' })
  return Promise.resolve()
}

// A VOLTA é transição e não sobrevive no banco esperando (o estado já virou 'ok'), então é
// anunciada na hora em que acontece — mas só se a QUEDA tiver sido anunciada. Sem esse
// `avisadaEm`, todo reinício do serviço virava um "o whatsapp voltou" no self-chat de uma
// queda de 3 segundos que ninguém viu (16 deles em 2h no dia 26/07/2026). O painel continua
// sabendo de tudo pelo broadcast; quem é poupado do ruído é o dono.
function anunciarCanal(transicao) {
  if (!transicao) return
  broadcast({ t: 'state' })
  if (transicao.tipo === 'voltou' && transicao.avisadaEm) void saudeVolta({ canal: transicao.canal, quanto: transicao.quanto, avisar: avisarNoSelfChat }).catch(() => {})
}

// O WhatsApp passa por CONNECTING toda vez que o processo sobe, e subir é rotina aqui. Estado
// que o próprio Baileys resolve sozinho em segundos não é queda: só vira queda se DURAR.
// O que exige humano (QR novo, re-pareamento) não espera carência nenhuma — nesses o tempo
// perdido é tempo em que o canal está mudo de verdade.
const WA_EXIGE_HUMANO = new Set(['QR_READY', 'REPAIR_REQUIRED', 'LOGGED_OUT'])
const WA_CARENCIA_MS = Number(process.env.TIM_WA_CARENCIA_MS || 45000)
let waQuedaPendente = null
function saudeWhatsapp(status) {
  if (waQuedaPendente) { clearTimeout(waQuedaPendente); waQuedaPendente = null }
  if (status === 'CONNECTED') return anunciarCanal(saudeRegistrar({ canal: 'whatsapp', ok: true }))
  if (WA_EXIGE_HUMANO.has(status)) return anunciarCanal(saudeRegistrar({ canal: 'whatsapp', ok: false, motivo: `estado ${status}` }))
  waQuedaPendente = setTimeout(() => {
    waQuedaPendente = null
    anunciarCanal(saudeRegistrar({ canal: 'whatsapp', ok: false, motivo: `estado ${status} há mais de ${Math.round(WA_CARENCIA_MS / 1000)}s` }))
  }, WA_CARENCIA_MS)
  if (waQuedaPendente.unref) waQuedaPendente.unref()   // carência nunca segura o processo de pé
}

// O FREIO DE COTA. Lê o uso real do provedor e pausa a IA automática antes de a conta virar.
// 5 minutos é o intervalo certo: a cota não anda mais rápido que isso, e uma leitura por
// minuto seria gasto de chamada pra saber a mesma coisa.
let cotaOcupada = false
async function cotaCanaisTick() {
  if (cotaOcupada) return
  cotaOcupada = true
  try {
    const r = await cotaTick({ avisar: avisarNoSelfChat })
    if (r && r.agiu) broadcast({ t: 'state' })
  } catch (e) { logEvent({ type: 'cota_tick_erro', detail: e.message }) }
  finally { cotaOcupada = false }
}
setInterval(cotaCanaisTick, Number(process.env.TIM_COTA_TICK_MS || 300000))

let saudeOcupado = false
async function saudeCanaisTick() {
  if (saudeOcupado) return
  saudeOcupado = true
  try { await saudeTick({ avisar: avisarNoSelfChat }) }
  catch (e) { logEvent({ type: 'canal_aviso_erro', detail: e.message }) }
  finally { saudeOcupado = false }
}
setInterval(saudeCanaisTick, Number(process.env.TIM_SAUDE_TICK_MS || 60000))

// PROCURAR UNIÕES SOZINHO. Antes isto só rodava quando alguém clicava "procurar" no painel —
// ou seja, a mesma pessoa que quer ser avisada tinha que lembrar de perguntar. Com o convite
// de rede (a IA passa o contato dela e a pessoa aparece no Instagram depois), a janela útil é
// justamente a de horas depois do convite: sem tick, a sugestão nasceria só na próxima vez
// que alguém abrisse a aba. Prova forte e única conclui; ambiguidade só propõe.
let unioesOcupado = false
async function unioesTick() {
  if (unioesOcupado) return
  unioesOcupado = true
  try {
    const r = procurarUnioes({ accountKey: ACCOUNT })
    if (r.propostas > 0 || r.autoVinculados > 0) {
      logEvent({ type: 'uniao_procurada', detail: `${r.autoVinculados} vínculo(s) automático(s), ${r.propostas} sugestão(ões) nova(s), ${r.pendentes} pendente(s) — ambiguidades ficam na aba Pessoas` })
      broadcast({ t: 'state' })
    }
  } catch (e) { logEvent({ type: 'uniao_erro', detail: e.message }) } finally { unioesOcupado = false }
}
setInterval(unioesTick, Number(process.env.TIM_UNIOES_TICK_MS || 600000))

// ---------- Telegram (5º canal) ----------
// Só roda quando está CONFIGURADO. Sem api_id/api_hash o canal simplesmente não existe pro
// sistema — nada de tick batendo à toa nem de erro repetido no Diário.
let tgOcupado = false
async function telegramTick() {
  if (tgOcupado || !tgConfigurado()) return
  tgOcupado = true
  try {
    const r = await syncTelegram({ accountKey: ACCOUNT })
    if (!r.ok) { saudeRegistrar({ canal: 'telegram', ok: false, motivo: r.motivo }); return }
    saudeRegistrar({ canal: 'telegram', ok: true })
    if (r.conversas) broadcast({ t: 'state' })
    if (!iaPausada() && aiEnabledPeople('telegram').length) {
      await telegramAutoReplyTick({ accountKey: ACCOUNT, sendEnabled: getSetting('send_enabled', true), onSent: (personId) => broadcast({ t: 'message', personId }) })
    }
  } catch (e) { logEvent({ type: 'tg_erro', channel: 'telegram', detail: String(e && e.message || e).slice(0, 180) }) }
  finally { tgOcupado = false }
}
setInterval(telegramTick, Number(process.env.TIM_TG_TICK_MS || 60000))

// ---------- Meu Patrocínio (6º canal) ----------
let mpOcupado = false
async function meuPatrocinioTick() {
  if (mpOcupado || !mpConectado()) return
  mpOcupado = true
  try {
    const r = await syncMeuPatrocinio({ accountKey: ACCOUNT })
    if (!r.ok) { saudeRegistrar({ canal: 'meupatrocinio', ok: false, motivo: r.motivo }); return }
    saudeRegistrar({ canal: 'meupatrocinio', ok: true })
    if (r.conversas) broadcast({ t: 'state' })
    if (!iaPausada() && aiEnabledPeople('meupatrocinio').length) {
      await meuPatrocinioAutoReplyTick({ accountKey: ACCOUNT, sendEnabled: getSetting('send_enabled', true), onSent: (personId) => broadcast({ t: 'message', personId }) })
    }
  } catch (e) { logEvent({ type: 'mp_erro', channel: 'meupatrocinio', detail: String(e && e.message || e).slice(0, 180) }) }
  finally { mpOcupado = false }
}
setInterval(meuPatrocinioTick, Number(process.env.TIM_MP_TICK_MS || 90000))

// Quando o filtro segura uma mensagem, o dono fica sabendo na hora. O filtro é puro e não
// conhece o WhatsApp; o núcleo é quem liga os dois.
filtroAoBloquear(avisarNoSelfChat)

// MONITOR DA VOZ: uma vez por semana, mede o que a IA obteve (as pessoas responderam? com
// conteúdo?) contra o que o dono obteve no mesmo período, e só fala quando há o que melhorar.
// Tick de hora em hora porque o próprio monitor guarda quando falou pela última vez — assim
// ele sobrevive a restart sem perder nem repetir a janela.
setInterval(() => {
  monitorVozTick({ avisar: avisarNoSelfChat, getSetting, setSetting })
    .catch((e) => logEvent({ type: 'monitor_voz_erro', detail: e.message }))
}, Number(process.env.TIM_MONITOR_VOZ_MS || 3600000))

function backfillAutoria() {
  if (getSetting('autoria_backfill_v2', false) === true) return
  try {
    const r = reconstruirAutoria()
    setSetting('autoria_backfill_v2', true)
    logEvent({ type: 'autoria_backfill', detail: `${r.eventos} eventos -> ${r.ia} da IA, ${r.humano} ${doDono()}; ${r.anterioresAIa} anteriores à IA (${r.detalhe.join(', ')})` })
  } catch (e) { logEvent({ type: 'autoria_backfill_erro', detail: e.message }) }
}

// O SEGUNDO CANO PRO CATÁLOGO. O modo códex roda num sandbox que compartilha /opt/vendas-multicanal/app com
// este processo mas NÃO compartilha rede — nem loopback. Enquanto o `tools/acao.mjs` só falava
// HTTP, toda ação pedida em modo códex morria com "o vendas-multicanal-core não respondeu", com o núcleo vivo
// na mesma máquina. A fila é de arquivo, carrega só pedidos do catálogo fechado (nunca comando
// arbitrário) e desemboca no MESMO executor do painel. Ver licoes/catalogo-inacessivel-no-sandbox.
iniciarIpcAcoes({
  executar: (corpo) => executarPedidoAcao(corpo, ctxAssistente()),
  aoErro: (e) => logEvent({ type: 'ipc_acoes_erro', detail: e.message }),
})

server.listen(PORT, HOST, () => {
  console.log(`[vendas-multicanal] painel em http://${HOST}:${PORT} | conta ${ACCOUNT}`)
  logEvent({ type: 'boot', detail: 'vendas-multicanal iniciado' })
  setTimeout(() => void loopTick(), 1200)
  setTimeout(backfillAutoria, 4000)
})
