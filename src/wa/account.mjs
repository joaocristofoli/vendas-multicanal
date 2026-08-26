// WaAccount: um socket Baileys por conta (accountKey).
// Cuida do ciclo de vida da sessao (start / reconnect / reset), do QR pro
// painel, da maquina de estados e da recepcao de mensagens com ALLOWLIST
// ESTRITA. Nao acopla ao banco: recebe callbacks injetados no construtor
// (onQr, onStatus, onMessage, isAllowed) e so age atraves deles.
//
// Diferenca central do padrao base (implementação de referência): o vendas-multicanal so processa mensagens
// de JIDs explicitamente permitidos (isAllowed) e nao baixa o historico pessoal
// do PessoaOperadora (syncFullHistory:false). Ver docs/PLANO-WHATSAPP.md secao 2.
import { rm, rename, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import QRCode from 'qrcode'
import pino from 'pino'
import { getBaileys } from './baileys.mjs'
import { normalizeJid, isTrackableJid } from './jid.mjs'
import { logMonitor, waMessageText, getWaChat, logEvent } from '../core/db.mjs'
import { MEDIA_DIR, WA_AUTH_DIR } from '../core/caminhos.mjs'

const DEFAULT_MEDIA_ROOT = MEDIA_DIR
const MAX_RECEIVED_IMAGE_BYTES = 25 * 1024 * 1024

// Codigos de desconexao que valem reconexao automatica. 401 (loggedOut) NAO
// esta aqui de proposito: sessao invalidada nao reconecta, exige novo QR.
const RETRY_REASONS = new Set([408, 428, 500, 503, 515])

const MAX_RECONNECT_ATTEMPTS = 5
const BACKOFF_BASE_MS = 2000
const BACKOFF_CEIL_MS = 300000

const DEFAULT_AUTH_ROOT = WA_AUTH_DIR

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function noop() {}

export class WaAccount {
  constructor(accountKey, options = {}) {
    if (!accountKey) throw new Error('WaAccount exige um accountKey')
    this.accountKey = accountKey

    const {
      authDir,
      mediaDir,
      onQr,
      onStatus,
      onMessage,
      onChats,
      onHistory,
      onSendStatus,
      onPollVote,
      isAllowed,
      fullHistory,
    } = options

    // Quando true, o pareamento pede o histórico COMPLETO das conversas 1:1 (mais dados,
    // download maior). Default false = comportamento conservador. O app liga via setting.
    this.fullHistory = fullHistory === true

    // Diretorio de credenciais persistentes desta conta.
    this.authDir = authDir || `${DEFAULT_AUTH_ROOT}/${accountKey}`
    // Diretorio onde os audios recebidos sao salvos (pra transcricao + player).
    this.mediaDir = mediaDir || DEFAULT_MEDIA_ROOT

    // Callbacks injetados (defensivos: sempre chamaveis).
    this.onQr = typeof onQr === 'function' ? onQr : noop
    this.onStatus = typeof onStatus === 'function' ? onStatus : noop
    this.onMessage = typeof onMessage === 'function' ? onMessage : noop
    // onChats: lista de conversas (metadados) para o painel. onHistory: mensagens
    // do historico inicial (para preview e contexto de quem for adotado).
    this.onChats = typeof onChats === 'function' ? onChats : noop
    this.onHistory = typeof onHistory === 'function' ? onHistory : noop
    // onSendStatus: confirmação de entrega das mensagens que NÓS mandamos (ver messages.update)
    this.onSendStatus = typeof onSendStatus === 'function' ? onSendStatus : noop
    // onPollVote: chegou um voto numa enquete que mandamos (pra o assistente ler a escolha).
    this.onPollVote = typeof onPollVote === 'function' ? onPollVote : noop
    // Sem allowlist explicita, nada e permitido (fail-closed).
    this.isAllowed = typeof isAllowed === 'function' ? isAllowed : () => false

    // Socket vivo (exposto pro send.mjs). Null enquanto nao conectado.
    this.sock = null

    // Estado interno (base do snapshot).
    this.status = 'IDLE'
    this.qrDataUrl = null
    this.jid = null
    this.name = null
    this.reconnectAttempts = 0
    this.requiresRePair = false

    // Última figurinha crua recebida por conversa (jid -> {key,message}), pra poder ENCAMINHAR
    // exatamente a mesma — inclusive as animadas (Lottie), que não dá pra reenviar como webp.
    this._lastSticker = new Map()
    // Controle de ciclo de vida.
    this.generation = 0            // invalida handlers de socket morto
    this.startPromise = null       // idempotencia do start()
    this._reconnectTimer = null    // timer de backoff agendado
    this._connectionCloseHandled = false // idempotencia do evento 'close'
    this._saveCreds = null
    this._lastReceipt = new Map()  // throttle de "leu" por jid (evita flood de recibo)
  }

  // Nome amigável de um jid pro monitor (usa a lista de conversas; cai no fallback).
  _monitorName(jid, fallback) {
    try { const c = getWaChat(this.accountKey, jid); if (c && c.name) return c.name } catch { /* segue */ }
    return fallback || jid
  }
  // "É uma conversa que o dono já tem?" — evita monitorar o catálogo inteiro em contacts.update.
  _knownChat(jid) { try { return !!getWaChat(this.accountKey, jid) } catch { return false } }

  // Atualiza o estado e notifica o painel via onStatus.
  // extra permite carregar dados junto do evento (jid, name, motivo...).
  setStatus(status, extra = {}) {
    this.status = status
    this.onStatus({ accountKey: this.accountKey, status, ...extra })
  }

  // Inicia (ou reaproveita) a conexao. Idempotente: chamadas concorrentes
  // compartilham a mesma promise de arranque.
  async start() {
    if (this.startPromise) return this.startPromise
    // Arranque pedido com a sessão morta (o painel clicou "tentar de novo") devolve o
    // orçamento de tentativas. Sem isto o contador continua estourado e a primeira queda
    // volta pro mesmo beco, com a diferença de que agora existe alguém esperando.
    if (this.status === 'REPAIR_REQUIRED' || this.status === 'ERROR') this.reconnectAttempts = 0
    this.startPromise = this._connect().catch((err) => {
      this.startPromise = null
      this.setStatus('ERROR', { error: err && err.message ? err.message : String(err) })
      throw err
    })
    return this.startPromise
  }

  // Monta o socket, liga os handlers e a persistencia de credenciais.
  async _connect() {
    const { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestWaWebVersion } = await getBaileys()

    // Cada tentativa de conexao e uma nova "geracao": handlers de sockets
    // antigos que dispararem depois disso sao ignorados.
    const generation = ++this.generation
    this._connectionCloseHandled = false

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir)
    this._saveCreds = saveCreds

    // Versao do WhatsApp Web (best-effort; se falhar, deixa o baileys decidir).
    let version
    try {
      const fetched = await fetchLatestWaWebVersion()
      version = fetched && fetched.version
    } catch {
      version = undefined
    }

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      markOnlineOnConnect: false,        // bot passivo: nao rouba o push do celular
      // O NOME QUE APARECE NA LISTA DE APARELHOS CONECTADOS DELA.
      //
      // Era `Browsers.macOS('vendas-multicanal')`, ou seja: no WhatsApp dela havia um aparelho chamado
      // literalmente "vendas-multicanal". Isso é um identificador do NOSSO sistema exposto na conta de
      // uma pessoa real — quem abrir "Aparelhos conectados" vê um nome que não é de nenhum
      // programa que ela reconheça, e é exatamente o tipo de coisa que faz alguém desconectar
      // por susto (e que destoa de qualquer cliente legítimo).
      //
      // Agora é configurável e nasce com um nome comum de navegador. Trocar o nome NÃO é
      // trocar de aparelho pro WhatsApp: a identidade da sessão são as credenciais do
      // authDir. Mudar isto só muda o rótulo — e por isso não conserta, sozinho, uma conta
      // restringida (ver `nomeDoMotivoWa` em src/index.mjs).
      //
      // O PAR (browser, syncFullHistory) DECIDE SE EXISTE QR. Medido na vendas-multicanal-vm em
      // 10/08/2026, socket cru, mesmas credenciais vazias, versão do WhatsApp Web idêntica:
      //
      //   ["Mac OS","Desktop"] + fullHistory=true  -> 428 "Connection Terminated" em ~0,5s, SEM QR
      //   ["Mac OS","Desktop"] + fullHistory=false -> QR em ~0,5s
      //   ["Ubuntu","Chrome"]  + fullHistory=true  -> QR em ~0,5s
      //   ["Ubuntu","Chrome"]  + fullHistory=false -> QR em ~0,5s
      //
      // O default era o par que não pareia: o pareamento morria antes do primeiro QR e o
      // painel ficava eternamente em "Gerando o código de pareamento…". Por isso o default
      // agora é Ubuntu/Chrome — que ainda é um nome comum de navegador na lista de aparelhos
      // dela, e é o único dos dois que pede histórico completo sem ser derrubado.
      browser: Browsers[process.env.TIM_WA_PLATAFORMA || 'ubuntu'](process.env.TIM_WA_DEVICE || 'Chrome'),
      version: Array.isArray(version) ? version : undefined,
      syncFullHistory: this.fullHistory, // liga/desliga o download do histórico completo (setting wa_full_history)
      getMessage: async () => undefined,
    })
    this.sock = sock

    // Persiste credenciais sempre que mudarem.
    sock.ev.on('creds.update', saveCreds)

    // Eventos de conexao / QR / reconexao.
    sock.ev.on('connection.update', (update) => {
      if (generation !== this.generation) return
      this._handleConnectionUpdate(update, generation)
    })

    // Recepcao de mensagens (com allowlist estrita).
    sock.ev.on('messages.upsert', (payload) => {
      if (generation !== this.generation) return
      this._handleMessagesUpsert(payload, generation)
    })

    // Historico inicial e novos chats: alimentam a LISTA de conversas do painel
    // (metadados) e o preview. So metadados/preview aqui; conteudo completo de uma
    // conversa so e usado quando o PessoaOperadora a adota (ativa a IA nela).
    sock.ev.on('messaging-history.set', (payload) => {
      if (generation !== this.generation) return
      this._handleHistory(payload || {})
    })
    sock.ev.on('chats.upsert', (chats) => {
      if (generation !== this.generation) return
      this._handleHistory({ chats: Array.isArray(chats) ? chats : [] })
    })

    // ---------- MONITOR: sinais que não são mensagem (não viram bolha) ----------
    // Reação (emoji) numa mensagem — ou remoção da reação.
    sock.ev.on('messages.reaction', (list) => {
      if (generation !== this.generation) return
      for (const r of list || []) {
        try {
          const jid = normalizeJid(r.key && r.key.remoteJid); if (!jid || !isTrackableJid(jid)) continue
          const emoji = r.reaction && r.reaction.text
          const alvo = waMessageText(r.key && r.key.id) // mensagem que recebeu a reação
          const naMinha = Boolean(r.key && r.key.fromMe) // reagiram numa msg MINHA
          const name = this._monitorName(jid)
          const summary = emoji
            ? `${name} reagiu ${emoji}${naMinha ? ' na sua mensagem' : ''}`
            : `${name} removeu a reação`
          logMonitor({ accountKey: this.accountKey, kind: 'reaction', jid, name, summary, detail: { emoji: emoji || null, sobre: alvo, naMinha } })
        } catch { /* best-effort */ }
      }
    })

    // Recibo das MINHAS mensagens: entregue / LIDO (visto) / OUVIDO (áudio).
    sock.ev.on('message-receipt.update', (list) => {
      if (generation !== this.generation) return
      for (const u of list || []) {
        try {
          const jid = normalizeJid(u.key && u.key.remoteJid); if (!jid || !isTrackableJid(jid)) continue
          if (!(u.key && u.key.fromMe)) continue // só o "visto" das minhas mensagens
          const rc = u.receipt || {}
          let verb = null, sub = null
          if (rc.playedTimestamp) { verb = 'ouviu seu áudio'; sub = 'played' }
          else if (rc.readTimestamp) { verb = 'leu sua mensagem'; sub = 'read' }
          else continue // "entregue" só: ignora (barulho demais)
          const last = this._lastReceipt.get(jid + ':' + sub) || 0
          if (Date.now() - last < 60000) continue // no máx 1 registro por minuto/conversa
          this._lastReceipt.set(jid + ':' + sub, Date.now())
          const name = this._monitorName(jid)
          logMonitor({ accountKey: this.accountKey, kind: 'receipt', jid, name, summary: `${name} ${verb}`, detail: { type: sub } })
        } catch { /* best-effort */ }
      }
    })

    // Chamadas (voz/vídeo): recebida / perdida / recusada.
    sock.ev.on('call', (list) => {
      if (generation !== this.generation) return
      for (const c of list || []) {
        try {
          const jid = normalizeJid(c.from || c.chatId || c.peerJid); if (!jid || !isTrackableJid(jid)) continue
          const via = c.isVideo ? 'vídeo' : 'voz'
          let verb = null
          if (c.status === 'offer' || c.status === 'ringing') verb = `chamada de ${via} recebida`
          else if (c.status === 'timeout') verb = `chamada de ${via} perdida`
          else if (c.status === 'reject') verb = `chamada de ${via} recusada`
          else continue
          const name = this._monitorName(jid)
          logMonitor({ accountKey: this.accountKey, kind: 'call', jid, name, summary: `${name}: ${verb}`, detail: { status: c.status, video: !!c.isVideo } })
        } catch { /* best-effort */ }
      }
    })

    // Edição de mensagem: guarda antes -> depois.
    sock.ev.on('messages.update', (list) => {
      if (generation !== this.generation) return
      for (const u of list || []) {
        try {
          const jid = normalizeJid(u.key && u.key.remoteJid); if (!jid || !isTrackableJid(jid)) continue
          const upd = u.update || {}
          // STATUS DE ENTREGA das mensagens que NÓS mandamos. É a única prova de que a
          // mensagem saiu de verdade — o id devolvido pelo sendMessage não garante nada
          // (25/07/2026: uma primeira mensagem "enviada" nunca chegou, sem erro nenhum).
          if (u.key && u.key.fromMe && upd.status != null && typeof this.onSendStatus === 'function') {
            try { this.onSendStatus({ id: u.key.id, jid, status: upd.status }) } catch { /* best-effort */ }
          }
          const editedWrap = upd.message && (upd.message.protocolMessage && upd.message.protocolMessage.editedMessage || upd.message.editedMessage)
          if (!editedWrap) continue
          const before = waMessageText(u.key && u.key.id)
          const ex = extractMessageText(editedWrap.message || upd.message)
          const name = this._monitorName(jid); const who = (u.key && u.key.fromMe) ? 'você' : name
          logMonitor({ accountKey: this.accountKey, kind: 'edited', jid, name, summary: `${who} editou uma mensagem`, detail: { antes: before, depois: ex.text } })
        } catch { /* best-effort */ }
      }
    })

    // Mudanças de perfil do contato: foto / recado / nome (só nas conversas que você tem).
    sock.ev.on('contacts.update', (list) => {
      if (generation !== this.generation) return
      for (const u of list || []) {
        try {
          const jid = normalizeJid(u.id); if (!jid || !isTrackableJid(jid) || !this._knownChat(jid)) continue
          const name = this._monitorName(jid)
          if (u.imgUrl !== undefined) logMonitor({ accountKey: this.accountKey, kind: 'profile_pic', jid, name, summary: `${name} trocou a foto de perfil` })
          if (u.status) logMonitor({ accountKey: this.accountKey, kind: 'profile_status', jid, name, summary: `${name} mudou o recado`, detail: { recado: u.status } })
          const novo = u.name || u.notify
          if (novo && novo !== name) logMonitor({ accountKey: this.accountKey, kind: 'profile_name', jid, name, summary: `${name} agora aparece como "${novo}"`, detail: { novo } }) // só quando MUDA de verdade
        } catch { /* best-effort */ }
      }
    })
  }

  // Extrai chats (nao-grupo) e mensagens do historico, entregando metadados ao
  // nucleo via onChats/onHistory. Grupos, status, broadcast e canais sao descartados.
  _handleHistory({ chats = [], contacts = [], messages = [] }) {
    const names = {}
    for (const c of contacts || []) { const j = normalizeJid(c && c.id); if (j) names[j] = (c.name || c.notify || c.verifiedName) || null }

    const chatList = []
    for (const c of chats || []) {
      const jid = normalizeJid(c && c.id)
      if (!jid || !isTrackableJid(jid)) continue
      chatList.push({ jid, name: (c.name || names[jid]) || null, ts: Number(c.conversationTimestamp) || 0 })
    }
    if (chatList.length) this.onChats(chatList)

    const msgList = []
    for (const m of messages || []) {
      if (!m || !m.key) continue
      const jid = normalizeJid(m.key.remoteJid)
      if (!jid || !isTrackableJid(jid)) continue
      const ex = extractMessageText(m.message)
      if (!ex.text) continue
      msgList.push({ jid, fromMe: Boolean(m.key.fromMe), text: ex.text, type: ex.type, ts: Number(m.messageTimestamp) || 0, id: m.key.id, pushName: m.pushName })
    }
    if (msgList.length) this.onHistory(msgList)
  }

  // Trata connection.update: QR, transicoes de estado e reconexao com backoff.
  async _handleConnectionUpdate(update, generation) {
    if (generation !== this.generation) return

    // QR novo -> vira dataURL nitida pro painel (nunca terminal).
    if (update.qr) {
      try {
        const dataUrl = await QRCode.toDataURL(update.qr, { errorCorrectionLevel: 'M', margin: 1, width: 320 })
        if (generation !== this.generation) return
        this.qrDataUrl = dataUrl
        this.requiresRePair = false
        this.setStatus('QR_READY', { accountKey: this.accountKey })
        this.onQr({ accountKey: this.accountKey, qrDataUrl: dataUrl })
      } catch {
        // Falha ao renderizar o QR nao derruba a conexao; o proximo QR tenta de novo.
      }
    }

    const connection = update.connection

    if (connection === 'connecting') {
      this.setStatus('CONNECTING')
    } else if (connection === 'open') {
      // Conectado: zera tentativas, guarda a identidade da sessao.
      this.reconnectAttempts = 0
      this.requiresRePair = false
      this.qrDataUrl = null
      const user = this.sock && this.sock.user
      this.jid = user && user.id ? user.id : null
      this.name = user && user.name ? user.name : null
      this.setStatus('CONNECTED', { jid: this.jid, name: this.name })
    } else if (connection === 'close') {
      // 'close' pode disparar duas vezes; processa so a primeira desta geracao.
      if (this._connectionCloseHandled) return
      this._connectionCloseHandled = true

      const statusCode = Number(
        (update.lastDisconnect && update.lastDisconnect.error && update.lastDisconnect.error.output && update.lastDisconnect.error.output.statusCode) || 0
      )
      // Antes de concluir o pareamento, o WhatsApp pode fechar o socket quando o QR
      // expira sem fornecer um status HTTP que o Baileys consiga decodificar. Nesse
      // estado, renovar a conexão é seguro e gera outro QR; só uma sessão que já abriu
      // deve ficar em REPAIR_REQUIRED para códigos desconhecidos.
      const aguardandoLeituraDoQr = !this.jid && (this.status === 'QR_READY' || this.status === 'CONNECTING' || this.status === 'DISCONNECTED')
      const retryable = RETRY_REASONS.has(statusCode) || aguardandoLeituraDoQr

      // O WHATSAPP PODE RECUSAR O HISTÓRICO COMPLETO — E A RECUSA NÃO PARECE UMA RECUSA.
      // Ela chega como 428 seco antes de qualquer QR (ver a matriz medida no `browser`
      // acima). Repetir a mesma tentativa cinco vezes só troca o dead-end de lugar: o
      // painel fica em "Gerando o código de pareamento…" pra sempre. Aqui a conexão
      // REBAIXA uma vez — pede o QR sem histórico completo — porque parear e perder o
      // histórico é recuperável (re-parear depois), e não parear não é.
      if (statusCode === 428 && !this.jid && !this.qrDataUrl && this.fullHistory) {
        this.fullHistory = false
        this.historicoRebaixado = true
        this.setStatus('DISCONNECTED', { statusCode, reconnectIn: 1500, motivo: 'historico-completo-recusado' })
        this._scheduleRestart(1500)
        return
      }

      if (retryable && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        // Backoff exponencial: base 2000ms, dobra a cada tentativa, teto 300000ms.
        const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempts), BACKOFF_CEIL_MS)
        this.reconnectAttempts += 1
        this.setStatus('DISCONNECTED', { statusCode, reconnectIn: delay, attempt: this.reconnectAttempts })
        this._scheduleRestart(delay)
      } else {
        // Nao reconecta (loggedOut, motivo nao-retryable, ou estourou tentativas)
        // -> precisa de novo QR.
        this.requiresRePair = true
        this.sock = null
        this.setStatus('REPAIR_REQUIRED', { statusCode })
      }
    }
  }

  // Agenda um restart apos o backoff. Invalida a geracao antiga ao reconectar.
  _scheduleRestart(delay) {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      // Libera a promise de start pra permitir novo arranque.
      this.startPromise = null
      this.sock = null
      this.start().catch(() => {
        // Erro de reconexao ja e reportado via setStatus('ERROR') dentro de start().
      })
    }, delay)
  }

  // Trata messages.upsert com ALLOWLIST ESTRITA.
  // Fluxo: normaliza JID -> filtra nao-rastreaveis (grupo/status/broadcast/canal)
  // -> extrai texto -> SO chama onMessage se isAllowed(jid) === true; senao
  // descarta em silencio, sem logar conteudo.
  async _handleMessagesUpsert(payload, generation) {
    if (generation !== this.generation) return
    const messages = payload && Array.isArray(payload.messages) ? payload.messages : []

    for (const message of messages) {
      if (generation !== this.generation) return
      if (!message || !message.key) continue

      const jid = normalizeJid(message.key.remoteJid)
      if (!jid) continue
      // VOTO em enquete: chega como pollUpdateMessage. Não é bolha — vai pro onPollVote, que
      // decifra a escolha e (no self-chat) alimenta o assistente. voterJid = quem votou.
      const pollUpd = message.message && message.message.pollUpdateMessage
      if (pollUpd && pollUpd.pollCreationMessageKey && pollUpd.vote) {
        try {
          this.onPollVote({
            pollMsgId: pollUpd.pollCreationMessageKey.id,
            vote: pollUpd.vote,
            voterJid: normalizeJid(message.key.participant || message.key.remoteJid),
            jid, fromMe: Boolean(message.key.fromMe),
          })
        } catch { /* best-effort */ }
        continue
      }
      // Filtro estrutural: grupos, status, broadcast, canais nunca passam.
      if (!isTrackableJid(jid)) continue

      const fromMe = Boolean(message.key.fromMe)
      const extracted = extractMessageText(message.message)
      if (extracted.skip) {
        // Evento de controle (ex.: mensagem apagada) — não vira bolha, vai pro MONITOR.
        // Só pra conversa permitida (não vaza de quem não segue).
        if (extracted.control && this.isAllowed(jid) === true) {
          try {
            const name = this._monitorName(jid, message.pushName || jid)
            const who = fromMe ? 'você' : name
            if (extracted.control === 'mensagem apagada') {
              const orig = waMessageText(extracted.revokedId) // recupera o que foi apagado (se já tínhamos)
              logMonitor({ accountKey: this.accountKey, kind: 'deleted', jid, name, summary: orig ? `${who} apagou: ${orig}` : `${who} apagou uma mensagem`, detail: { original: orig } })
            } else {
              logMonitor({ accountKey: this.accountKey, kind: 'control', jid, name, summary: `${who}: ${extracted.control}` })
            }
          } catch { /* monitor best-effort */ }
        }
        continue
      }

      // A LISTA de conversas recebe metadados de qualquer chat (nao-grupo): jid,
      // nome e preview da ultima mensagem. Isso alimenta a aba WhatsApp mesmo antes
      // de a conversa ser adotada. Nao entra na timeline nem na IA.
      // pushName de mensagem MINHA e o MEU nome — nunca renomeia a conversa com ele.
      if (extracted.text) this.onChats([{ jid, name: fromMe ? null : message.pushName, ts: Number(message.messageTimestamp) || 0, lastText: extracted.text }])

      // ALLOWLIST ESTRITA: so entrega o CONTEUDO ao nucleo (timeline/IA) se o JID
      // estiver permitido. Fora da allowlist -> nao processa o conteudo.
      if (this.isAllowed(jid) !== true) continue

      // Áudio: baixa e salva o arquivo (best-effort) pra transcrição + player.
      let audio = null
      if (extracted.type === 'audio') audio = await this._saveAudioMedia(message).catch(() => null)
      // Imagem: baixa o arquivo descriptografado enquanto a mensagem ainda carrega as
      // chaves de mídia. A descrição visual é feita fora deste adaptador; aqui apenas
      // preservamos o arquivo para a IA e para o painel.
      let image = null
      if (extracted.type === 'imagem') image = await this._saveImageMedia(message).catch(() => null)
      // Figurinha: guarda a mensagem crua (pra ENCAMINHAR a mesma, animada inclusive) e baixa o
      // .webp (best-effort, pro painel/estáticas). O cache limita-se à última por conversa.
      let sticker = null
      if (extracted.type === 'figurinha') {
        try { this._lastSticker.set(jid, { key: message.key, message: message.message }); if (this._lastSticker.size > 200) this._lastSticker.delete(this._lastSticker.keys().next().value) } catch { /* cache best-effort */ }
        sticker = await this._saveStickerMedia(message).catch(() => null)
      }

      this.onMessage({
        accountKey: this.accountKey,
        jid,
        fromMe,
        id: message.key.id,
        text: extracted.text,
        type: extracted.type,
        audio,
        image,
        sticker,
        ts: message.messageTimestamp,
        pushName: message.pushName,
      })
    }
  }

  // Baixa o áudio de uma mensagem (baileys descriptografa) e salva em mediaDir.
  // Retorna { file, seconds } ou null. Best-effort: nunca lança pra fora.
  async _saveAudioMedia(message) {
    try {
      const { downloadMediaMessage } = await getBaileys()
      const id = message.key && message.key.id
      if (typeof downloadMediaMessage !== 'function' || !id) return null
      const buf = await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: this.sock && this.sock.updateMediaMessage })
      if (!buf || !buf.length) return null
      await mkdir(this.mediaDir, { recursive: true })
      const file = `${id}.ogg`
      await writeFile(path.join(this.mediaDir, file), buf)
      const seconds = message.message && message.message.audioMessage && message.message.audioMessage.seconds
      return { file, seconds: seconds || null }
    } catch {
      return null
    }
  }

  // Baixa uma imagem recebida (Baileys descriptografa) e salva em mediaDir. O arquivo
  // não tem qualquer relação com authDir: capturar uma foto nunca toca na sessão/QR.
  // Retorna { file, mimetype, bytes } ou null. Best-effort: nunca lança pra fora.
  async _saveImageMedia(message) {
    try {
      const { downloadMediaMessage } = await getBaileys()
      const id = message.key && message.key.id
      if (typeof downloadMediaMessage !== 'function' || !id) return null
      const buf = await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: this.sock && this.sock.updateMediaMessage })
      if (!buf || !buf.length || buf.length > MAX_RECEIVED_IMAGE_BYTES) return null
      const content = unwrapMessageContent(message.message)
      const mimetype = String(content && content.imageMessage && content.imageMessage.mimetype || 'image/jpeg').toLowerCase()
      const ext = mimetype.includes('png') ? 'png' : mimetype.includes('webp') ? 'webp' : mimetype.includes('gif') ? 'gif' : 'jpg'
      const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 180)
      if (!safeId) return null
      await mkdir(this.mediaDir, { recursive: true })
      const file = `${safeId}.${ext}`
      await writeFile(path.join(this.mediaDir, file), buf)
      return { file, mimetype, bytes: buf.length }
    } catch {
      return null
    }
  }

  // Baixa a figurinha (.webp) de uma mensagem e salva em mediaDir. Retorna { file } ou null.
  // Mesmo mecanismo do áudio (baileys descriptografa); best-effort, nunca lança pra fora.
  async _saveStickerMedia(message) {
    try {
      const { downloadMediaMessage, downloadContentFromMessage } = await getBaileys()
      const id = message.key && message.key.id
      if (!id) return null
      // Figurinha ANIMADA (lottieStickerMessage) o downloadMediaMessage não reconhece ("not a
      // media message"). Baixamos pela via de baixo nível, apontando os campos de mídia dela.
      const lottie = message.message && message.message.lottieStickerMessage
      let buf = null
      if (lottie && typeof downloadContentFromMessage === 'function') {
        // Figurinha animada: a mídia REAL fica aninhada em lottie.message.stickerMessage (achado
        // olhando o dado cru — ver docs/DEPURAR-MENSAGEM-CRUA.md). Baixa por baixo nível.
        const midia = (lottie.message && (lottie.message.stickerMessage || lottie.message.lottieStickerMessage)) || lottie.stickerMessage || lottie
        const stream = await downloadContentFromMessage(midia, 'sticker', {})
        const chunks = []
        for await (const c of stream) chunks.push(c)
        buf = Buffer.concat(chunks)
      } else if (typeof downloadMediaMessage === 'function') {
        buf = await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: this.sock && this.sock.updateMediaMessage })
      }
      if (!buf || !buf.length) { logEvent({ type: 'wa_sticker_capture', channel: 'whatsapp', detail: `vazio (${id})` }); return null }
      await mkdir(this.mediaDir, { recursive: true })
      const file = `${id}.webp`
      await writeFile(path.join(this.mediaDir, file), buf)
      logEvent({ type: 'wa_sticker_capture', channel: 'whatsapp', detail: `ok ${file} (${buf.length}b)` })
      return { file }
    } catch (e) {
      logEvent({ type: 'wa_sticker_capture', channel: 'whatsapp', detail: `ERRO: ${e && e.message ? e.message : String(e)}` })
      return null
    }
  }

  // Encaminha a ÚLTIMA figurinha recebida de `sourceJid` para `targetJid`. É o único jeito de
  // reenviar a MESMA figurinha animada (Lottie), que não tem webp pra remontar. Retorna
  // { providerMessageId }. Lança se não houver figurinha em cache pra aquela conversa.
  async forwardLastSticker(targetJid, sourceJid) {
    if (!this.sock) throw new Error('WhatsApp não conectado')
    const cached = this._lastSticker.get(normalizeJid(sourceJid)) || this._lastSticker.get(sourceJid)
    if (!cached) throw new Error('nenhuma figurinha recente em cache dessa conversa')
    const r = await this.sock.sendMessage(targetJid, { forward: cached })
    return { providerMessageId: r && r.key ? r.key.id : undefined }
  }

  // Pede ao WhatsApp o histórico ANTERIOR a uma mensagem âncora (on-demand history
  // sync). As mensagens chegam depois via 'messaging-history.set' -> onHistory, que
  // as persiste. count = quantas buscar; oldestMsgKey = {remoteJid,id,fromMe} da msg
  // mais antiga que já temos; oldestMsgTimestamp em ms. Best-effort (não lança).
  async fetchHistory(count, oldestMsgKey, oldestMsgTimestamp) {
    if (!this.sock || typeof this.sock.fetchMessageHistory !== 'function') return null
    try { return await this.sock.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp) }
    catch { return null }
  }

  // Valida uma lista de JIDs no WhatsApp. Usa spread (nao array!) conforme o
  // padrao do baileys. Retorna [{ jid, exists }] usando o result.jid canonico.
  async onWhatsApp(...jids) {
    if (!this.sock) throw new Error('WaAccount sem socket conectado para onWhatsApp')
    const results = await this.sock.onWhatsApp(...jids)
    if (!Array.isArray(results)) return []
    return results.map((r) => ({ jid: r && r.jid, exists: Boolean(r && r.exists) }))
  }

  // Encerra o socket sem apagar credenciais (nao e re-pareamento).
  async stop() {
    this.generation += 1 // invalida handlers pendentes
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    this.startPromise = null
    const sock = this.sock
    this.sock = null
    if (sock) {
      try {
        if (typeof sock.end === 'function') sock.end(undefined)
      } catch {
        // ignora erro ao encerrar
      }
    }
  }

  // Re-pareamento: desloga, apaga as credenciais e reinicia (novo QR).
  // Incrementa a geracao pra matar qualquer handler do socket antigo.
  async reset() {
    this.generation += 1
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    this.startPromise = null
    this.reconnectAttempts = 0

    const sock = this.sock
    this.sock = null
    if (sock) {
      // PARA de salvar credenciais ANTES de qualquer coisa: senão o socket antigo
      // re-escreve o authDir que vamos apagar e a sessao "ressuscita" (reconecta sem QR).
      try { sock.ev.removeAllListeners('creds.update') } catch { /* sem listeners */ }
      try { await sock.logout() } catch { /* sessao ja pode estar invalida */ }
      try { sock.end(undefined) } catch { /* encerra o socket de vez */ }
    }

    await sleep(400) // deixa o socket encerrar e soltar os handles do authDir

    // Tira o authDir da frente ATOMICAMENTE (rename) e apaga o antigo em background. Assim,
    // mesmo que algo atrasado tente salvar creds, escreve no dir velho; o start() logo abaixo
    // ja enxerga o dir vazio e gera QR. (Com fullHistory o authDir tem milhares de arquivos.)
    try {
      await rename(this.authDir, `${this.authDir}.old-${this.generation}`)
      removeDirWithRetries(`${this.authDir}.old-${this.generation}`, 6).catch(() => {})
    } catch {
      await removeDirWithRetries(this.authDir, 6) // fallback: apaga in-place
    }

    this.jid = null
    this.name = null
    this.qrDataUrl = null
    this.requiresRePair = false
    this.status = 'IDLE'

    return this.start()
  }

  // Snapshot imutavel do estado interno (copia rasa) pro painel.
  getSnapshot() {
    return {
      status: this.status,
      qrDataUrl: this.qrDataUrl,
      jid: this.jid,
      name: this.name,
      reconnectAttempts: this.reconnectAttempts,
      requiresRePair: this.requiresRePair,
    }
  }
}

// ---- Helpers de modulo (puros) ----

function unwrapMessageContent(rawContent) {
  let content = rawContent
  for (let i = 0; i < 5 && content; i++) {
    if (content.ephemeralMessage && content.ephemeralMessage.message) { content = content.ephemeralMessage.message; continue }
    if (content.viewOnceMessage && content.viewOnceMessage.message) { content = content.viewOnceMessage.message; continue }
    if (content.viewOnceMessageV2 && content.viewOnceMessageV2.message) { content = content.viewOnceMessageV2.message; continue }
    if (content.editedMessage && content.editedMessage.message) { content = content.editedMessage.message; continue }
    break
  }
  return content
}

// Extrai o texto de uma mensagem, desembrulhando os wrappers conhecidos
// (ephemeralMessage, viewOnceMessage / V2, editedMessage) e resolvendo o tipo.
// Midia (imagem/video/audio/documento/figurinha) vira um marcador de tipo
// ('[imagem]', '[audio]', ...) — o vendas-multicanal responde em texto e a ficha sinaliza
// quando algo precisa de atencao humana. Retorna { text, type }.
export function extractMessageText(rawContent) {
  let content = rawContent
  // Desembrulha wrappers ate chegar no conteudo real (protege contra loop).
  for (let i = 0; i < 5 && content; i++) {
    if (content.ephemeralMessage && content.ephemeralMessage.message) {
      content = content.ephemeralMessage.message
      continue
    }
    if (content.viewOnceMessage && content.viewOnceMessage.message) {
      content = content.viewOnceMessage.message
      continue
    }
    if (content.viewOnceMessageV2 && content.viewOnceMessageV2.message) {
      content = content.viewOnceMessageV2.message
      continue
    }
    if (content.editedMessage && content.editedMessage.message) {
      content = content.editedMessage.message
      continue
    }
    break
  }

  if (!content) return { text: '', type: 'desconhecido' }

  if (typeof content.conversation === 'string') {
    return { text: content.conversation, type: 'texto' }
  }
  if (content.extendedTextMessage && typeof content.extendedTextMessage.text === 'string') {
    return { text: content.extendedTextMessage.text, type: 'texto' }
  }
  if (content.imageMessage) {
    return { text: content.imageMessage.caption || '[imagem]', type: 'imagem' }
  }
  if (content.videoMessage) {
    return { text: content.videoMessage.caption || '[video]', type: 'video' }
  }
  if (content.audioMessage) {
    return { text: '[audio]', type: 'audio' }
  }
  if (content.documentMessage) {
    return { text: content.documentMessage.caption || '[documento]', type: 'documento' }
  }
  // figurinha estática (stickerMessage) E animada (lottieStickerMessage, formato novo do
  // WhatsApp). Sem a animada, a figurinha de quem manda animada SUMIA (não virava bolha) —
  // caía no fallback de tipo desconhecido. Achado pelo raio-x: keys=...,lottieStickerMessage.
  if (content.stickerMessage || content.lottieStickerMessage) {
    return { text: '[figurinha]', type: 'figurinha' }
  }
  if (content.locationMessage || content.liveLocationMessage) {
    return { text: '[localização]', type: 'localizacao' }
  }
  if (content.contactMessage || content.contactsArrayMessage) {
    return { text: '[contato]', type: 'contato' }
  }
  if (content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3) {
    return { text: '[enquete]', type: 'enquete' }
  }

  // Mensagens de CONTROLE do WhatsApp (não são conversa): apagar/revogar, timer de
  // mensagem temporária, distribuição de chave, reação, voto em enquete, sync interno.
  // Retornam skip=true -> não entram na lista, na timeline nem no contexto da IA.
  // O protocolMessage carrega um SUBTIPO (control) que registramos no Diário.
  if (content.protocolMessage) {
    return { text: '', type: 'protocolMessage', skip: true, control: protocolLabel(content.protocolMessage), revokedId: content.protocolMessage.key && content.protocolMessage.key.id }
  }
  const keys = Object.keys(content)
  const first = keys.length ? keys[0] : 'desconhecido'
  if (SKIP_MESSAGE_TYPES.has(first)) return { text: '', type: first, skip: true }

  // Fallback: usa a primeira chave do conteudo como tipo (desconhecido/novo).
  return { text: `[${first}]`, type: first }
}

// Tipos que são puro controle/protocolo — nunca viram mensagem visível.
const SKIP_MESSAGE_TYPES = new Set([
  'protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo',
  'reactionMessage', 'pollUpdateMessage', 'keepInChatMessage', 'pinInChatMessage',
])

// Subtipo do protocolMessage em rótulo legível (o `type` vem número OU string do baileys).
const PROTOCOL_TYPE_LABEL = {
  0: 'mensagem apagada', REVOKE: 'mensagem apagada',
  3: 'timer de mensagem temporária alterado', EPHEMERAL_SETTING: 'timer de mensagem temporária alterado',
  4: 'sync de mensagem temporária', 5: 'sync de histórico', 6: 'sync de chave', 7: 'sync de chave',
  11: 'número de telefone compartilhado', SHARE_PHONE_NUMBER: 'número de telefone compartilhado',
  14: 'mensagem editada', MESSAGE_EDIT: 'mensagem editada',
}
function protocolLabel(pm) {
  const t = pm && pm.type
  return PROTOCOL_TYPE_LABEL[t] || `controle do WhatsApp (${t != null ? t : '?'})`
}

// Apaga um diretorio com N tentativas (o baileys pode segurar handles logo
// apos logout). Ignora ENOENT (ja nao existe).
async function removeDirWithRetries(dir, attempts) {
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (err && err.code === 'ENOENT') return
      if (i === attempts - 1) throw err
      await sleep(200)
    }
  }
}
