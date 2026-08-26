// Sincronização das DMs do Instagram com o banco + envio. Tudo serializado (igExclusive)
// porque o Instagram roda numa aba só. Conversa canônica por thread_id (person 'ig:'+id).
import { igPage, igExclusive } from './browser.mjs'
import { MAX_BOLHAS } from '../ai/prompt.mjs'
import { readInbox, openThreadByName, openThreadById, readOpenThread, sendText } from './dom.mjs'
import { upsertIgChat, getIgChat, igChats, igChatTouch, upsertPerson, linkIdentity, addMessage, deleteChannelMessages, countChannelMessages, channelMessages, registerIgMedia, logEvent } from '../core/db.mjs'
import { colherDaMensagem } from '../bridge/hints.mjs'
import { openNewThread } from './newthread.mjs'
import * as igApi from './api.mjs'
import { igChatSetApiId, igChatPorApiId, igChatPorUsername, getSetting as _getSetting } from '../core/db.mjs'

export function igPersonId(threadId) { return 'ig:' + threadId }

// Grava as mensagens visíveis de uma thread (replace) + atualiza a lista. A mensagem mais
// recente é ancorada em anchorTs (o tempo REAL vindo do inbox); as anteriores ficam um
// pouco antes, preservando a ordem. Sem anchorTs cai pra agora (melhor que nada).
const MSG_GAP_MS = 60000
const syncToken = (m) => `${m.dir}|${m.text}`

// Uma leitura rápida contém a cauda recente, não todo o histórico. Costura essa cauda
// no histórico persistido pela maior sobreposição, para atualizar em segundos sem apagar
// o contexto antigo. A varredura profunda continua podendo substituir tudo quando traz mais.
export function mergePersistedThread(existing, fresh) {
  const old = Array.isArray(existing) ? existing.map((m) => ({ ...m })) : []
  const tail = Array.isArray(fresh) ? fresh.map((m) => ({ ...m })) : []
  if (!old.length) return tail
  if (!tail.length) return old
  // O DOM virtualizado pode falhar numa rodada e trazer só a ÚLTIMA bolha do dono; na
  // seguinte ele traz as bolhas intermediárias também. A costura antiga ancorava na
  // última mensagem já salva e aceitava somente o que viesse DEPOIS dela, tornando o
  // buraco permanente. Aqui fazemos uma supersequência comum mínima (LCS/SCS): preserva
  // tudo o que já estava salvo e também insere mensagens que reapareceram NO MEIO da
  // janela, mantendo a ordem e a multiplicidade de "kkkk" repetidos.
  const n = old.length
  const m = tail.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = syncToken(old[i]) === syncToken(tail[j])
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const merged = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (syncToken(old[i]) === syncToken(tail[j])) {
      // Mantém o horário persistido (estável) e recupera metadados que só a leitura nova
      // viu, como uma URL de mídia recém-materializada.
      const same = { ...old[i], ...tail[j] }
      if (old[i].ts) same.ts = old[i].ts
      merged.push({ value: same, source: 'both' })
      i++; j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      merged.push({ value: old[i++], source: 'old' })
    } else {
      merged.push({ value: tail[j++], source: 'fresh' })
    }
  }
  while (i < n) merged.push({ value: old[i++], source: 'old' })
  while (j < m) merged.push({ value: tail[j++], source: 'fresh' })

  // Se uma mensagem textual específica aparece uma vez de cada lado, mas a LCS deixou
  // uma cópia velha e outra nova em posições diferentes, ela foi RELOCALIZADA pela nova
  // leitura (normalmente porque o timestamp antigo caiu no dia errado). Mantém a posição
  // fresca e tira a cópia deslocada. Textos curtíssimos ficam fora: "oi"/"kkkk" podem ser
  // mensagens legítimas repetidas e não há id estável no DOM para distingui-las.
  const oldOnly = new Map()
  const freshOnly = new Map()
  for (const item of merged) {
    const token = syncToken(item.value)
    const alvo = item.source === 'old' ? oldOnly : item.source === 'fresh' ? freshOnly : null
    if (alvo) alvo.set(token, (alvo.get(token) || 0) + 1)
  }
  const reconciled = merged.filter((item) => {
      if (item.source !== 'old') return true
      const token = syncToken(item.value)
      const texto = String(item.value.text || '').trim()
      return !(texto.length >= 12 && oldOnly.get(token) === 1 && freshOnly.get(token) === 1)
    })

  // Mensagem recuperada entre duas mensagens persistidas herda um horário ENTRE as duas.
  // O fallback do leitor usa "agora" quando o DOM não exibe separador; sem interpolar,
  // a bolha reaparecia no fim da conversa em vez de voltar ao ponto onde foi enviada.
  let left = -1
  for (let right = 0; right < reconciled.length; right++) {
    const stable = reconciled[right].source !== 'fresh' && Number(reconciled[right].value.ts) > 0
    if (!stable) continue
    if (left >= 0 && right - left > 1) {
      const a = Number(reconciled[left].value.ts)
      const b = Number(reconciled[right].value.ts)
      if (b > a) {
        const step = (b - a) / (right - left)
        for (let k = left + 1; k < right; k++) {
          if (reconciled[k].source === 'fresh') reconciled[k].value.ts = Math.round(a + step * (k - left))
        }
      }
    }
    left = right
  }
  return reconciled.map((item) => item.value)
}

// Exportada só pra ser testável: é aqui que mora o replace destrutivo do Instagram, e o
// que ele preserva (mídia, autoria) precisa de prova, não de confiança.
export function persistThread({ accountKey, threadId, name, username, avatar, unread, messages, anchorTs }) {
  const personId = igPersonId(threadId)
  // A API JÁ CUIDA DESTA CONVERSA — não encoste nas mensagens.
  //
  // Este caminho é DESTRUTIVO por natureza (delete do canal inteiro + re-add), porque o DOM não
  // tem id de mensagem e a única forma de refletir a thread era reescrevê-la. Com os dois
  // caminhos ligados, o DOM apagava tudo que a API tinha gravado a cada 180s — a API gravava
  // 353 mensagens e o tick seguinte as derrubava (visto ao vivo em 28/07/2026).
  // O cabeçalho continua sendo atualizado: a lista da esquerda não perde nada.
  const chatAtual = getIgChat(accountKey, threadId)
  const jaEhDaApi = leituraPelaApiLigada() && !!chatAtual?.api_thread_id
  if (jaEhDaApi) {
    const ultima = messages && messages.length ? messages[messages.length - 1] : null
    // A leitura do DOM é virtualizada: durante a reciclagem de uma linha, texto e imagem
    // podem pertencer a instantes diferentes. A API já identificou esta thread, então nome,
    // @ e avatar continuam sendo exclusivamente dela. O DOM só adianta a prévia/contador;
    // o painel a mostra como "sincronizando" até o item com id real chegar pela API.
    const preview = ultima
      ? (ultima.dir === 'out' ? `You: ${ultima.text || ''}` : ultima.text)
      : undefined
    igChatTouch(accountKey, threadId, { lastText: preview, lastTs: anchorTs || undefined, unread })
    return personId
  }
  upsertPerson({ personId, accountKey, name })
  linkIdentity({ accountKey, channel: 'instagram', channelId: threadId, personId, method: 'ig' })
  const lastTs = anchorTs || Date.now()
  const existing = countChannelMessages(personId, 'instagram')
  if (messages.length < existing) {
    const persisted = channelMessages(personId, 'instagram', 1000).map((m) => ({
      dir: m.direction === 'outgoing' ? 'out' : 'in',
      text: m.text,
      ts: m.ts,
    }))
    messages = mergePersistedThread(persisted, messages)
  }
  const last = messages[messages.length - 1]
  upsertIgChat({ accountKey, threadId, name, username, avatar, lastText: (last && last.text) || null, lastTs, unread })
  if (anchorTs) igChatTouch(accountKey, threadId, { lastTs: anchorTs, lastText: (last && last.text) || undefined }) // força o tempo real
  // A mensagem MAIS RECENTE recebe o tempo REAL do inbox (anchorTs): garante que a última
  // da thread seja a mesma da sidebar, mesmo se o parse de separador do IG errou o horário.
  if (anchorTs && messages.length) {
    const lastM = messages[messages.length - 1], prevM = messages[messages.length - 2]
    if (!prevM || anchorTs >= prevM.ts) lastM.ts = anchorTs
  }
  // Mídia já conhecida (por token dir|texto), LIDA ANTES do delete: a releitura rasa nem sempre
  // recaptura o msrc (a virtualização do IG só renderiza <img> perto da viewport), então sem isto
  // uma imagem some do histórico no próximo refresh. Map<token, [media...]> preserva multiplicidade.
  const priorMedia = new Map()
  // QUEM ESCREVEU, pelo MESMO motivo e com a mesma técnica: o replace destrutivo apagaria o
  // carimbo de autoria (`author`) a cada re-sync, e a releitura do DOM não tem como saber se
  // uma bolha "out" foi escrita pela IA ou pelo dono. Sem preservar, toda mensagem da IA no
  // Instagram voltava a ser "não sei" no próximo refresh — silenciosamente.
  const priorAuthor = new Map()
  for (const pm of channelMessages(personId, 'instagram', 1000)) {
    const k = `${pm.direction === 'outgoing' ? 'out' : 'in'}|${pm.text || ''}`
    if (pm.author) {
      if (!priorAuthor.has(k)) priorAuthor.set(k, [])
      priorAuthor.get(k).push(pm.author)
    }
    if (!pm.media_json) continue
    let md = null; try { md = JSON.parse(pm.media_json) } catch { continue }
    if (!md || !md.src) continue
    if (!priorMedia.has(k)) priorMedia.set(k, [])
    priorMedia.get(k).push(md)
  }
  deleteChannelMessages(personId, 'instagram')
  messages.forEach((m, idx) => {
    // mídia (imagem/vídeo): guarda a URL na mensagem e registra pra interpretar depois (a
    // descrição vive em ig_media, sobrevive ao re-sync). registerIgMedia não re-gasta o que já foi feito.
    let media = m.msrc ? { kind: m.mkind || 'imagem', src: m.msrc } : null
    if (!media) { const q = priorMedia.get(`${m.dir}|${m.text || ''}`); if (q && q.length) media = q.shift() } // recupera a que a releitura não trouxe
    if (media) {
      try { registerIgMedia({ accountKey, src: media.src, kind: media.kind, personId, threadId }) }
      catch { /* best-effort */ }
    }
    const filaAutor = priorAuthor.get(`${m.dir}|${m.text || ''}`)
    addMessage({
      messageId: 'ig:' + threadId + ':' + idx + ':' + lastTs,
      accountKey, personId, channel: 'instagram',
      direction: m.dir === 'out' ? 'outgoing' : 'incoming', text: m.text, media,
      author: (filaAutor && filaAutor.length) ? filaAutor.shift() : null,
      // horário REAL da mensagem (do separador do IG); só cai no espalhamento se faltar
      ts: (typeof m.ts === 'number' && m.ts > 0) ? m.ts : (lastTs - (messages.length - 1 - idx) * MSG_GAP_MS),
    })
  })
  // Colhe contato passado nas mensagens recebidas (aqui é comum a pessoa mandar o zap).
  // O contact_hint tem índice único por pessoa+tipo+valor, então o replace destrutivo do
  // Instagram não duplica hint nem apaga o que já foi colhido.
  for (const m of messages) {
    if (m.dir === 'out' || !m.text) continue
    try { colherDaMensagem({ accountKey, personId, channel: 'instagram', messageId: null, text: m.text, direction: 'incoming' }) }
    catch { /* colher nunca derruba o sync */ }
  }
  return personId
}

// Poll LEVE: lê o inbox, atualiza last_text/last_ts/unread e abre no máximo as duas
// conversas recentes do topo. Atualizar só a lista cria uma mentira visual: aparece
// "1 min", mas a mensagem continua fora da thread até o sync pesado seguinte.
// Só lê a lista e devolve como está — para diagnóstico ("por que fulana não aparece?").
// Quantas conversas NOVAS o poll leve adota por rodada. Uma é o bastante pra sensação de
// tempo real e mantém o tick leve (abrir uma conversa custa ~10s).
const MAX_NOVAS_POR_TICK = 1
const MAX_RECENTES_POR_TICK = 2
const RECENTE_MS = 5 * 60_000
// Horários como "1 h" têm arredondamento de vários minutos; só o usamos como prova de
// atraso fora do topo quando a diferença é grande de verdade.
const ATRASO_TOLERADO_MS = 10 * 60_000
const COOLDOWN_RECENTE_MS = 60_000
const refreshRecenteEm = new Map()

// Decisão pura e testável. As duas primeiras conversas com atividade nos últimos minutos
// são relidas mesmo se a prévia for vazia/"." (o Instagram faz isso com não-lidas).
// Fora do topo, só relê se o inbox estiver materialmente à frente da última mensagem salva.
export function deveRelerThreadDoInbox({ row, index, latestTs = null, lastRefreshAt = null, now = Date.now() } = {}) {
  if (!row) return false
  if (lastRefreshAt && now - lastRefreshAt < COOLDOWN_RECENTE_MS) return false
  const ts = Number(row.ts) || 0
  const latest = Number(latestTs) || 0
  const noTopoAgora = index < MAX_RECENTES_POR_TICK && ts > 0 && now - ts <= RECENTE_MS
  const inboxNaFrente = ts > 0 && (!latest || ts - latest > ATRASO_TOLERADO_MS)
  return Number(row.unread) > 0 || noTopoAgora || inboxNaFrente
}

export async function lerInboxCru({ max = 25 } = {}) {
  return igExclusive(async () => {
    const page = await igPage()
    return readInbox(page, { max })
  })
}

export async function syncInboxLight({ accountKey } = {}) {
  return igExclusive(async () => {
    const page = await igPage()
    const inbox = await readInbox(page, { max: 20 })
    const byName = new Map(igChats(accountKey).map((c) => [c.name, c]))
    let updated = 0
    const novas = []
    const recentes = []
    for (let index = 0; index < inbox.length; index++) {
      const row = inbox[index]
      const chat = byName.get(row.name)
      if (!chat) { novas.push(row); continue }
      const latest = channelMessages(igPersonId(chat.thread_id), 'instagram', 1)[0] || null
      if (deveRelerThreadDoInbox({
        row,
        index,
        latestTs: latest?.ts || null,
        lastRefreshAt: refreshRecenteEm.get(`${accountKey}:${chat.thread_id}`) || null,
      })) recentes.push({ row, chat })
      igChatTouch(accountKey, chat.thread_id, { lastText: row.preview || undefined, lastTs: row.ts || undefined, unread: row.unread })
      updated++
    }
    // CONVERSA NOVA ENTRA AQUI, na hora (correção de 27/07/2026). Antes o tick leve só
    // PULAVA quem não estava no banco e deixava pro sync pesado — que abre no máximo 8 por
    // rodada e leva minutos por conversa (8 rodadas de scroll cada). Resultado: conversa
    // recém-criada demorava dezenas de minutos pra aparecer na lista do painel, mesmo
    // estando em primeiro lugar no inbox. Aqui abrimos SÓ a mais recente e com leitura
    // curta: o histórico completo o sync pesado busca depois.
    for (const row of novas.slice(0, MAX_NOVAS_POR_TICK)) {
      const tid = await openThreadByName(page, row.name)
      if (!tid) continue
      const t = await readOpenThread(page, { scrollRounds: 2 })
      persistThread({ accountKey, threadId: tid, name: row.name, username: t.username, avatar: row.avatar, unread: row.unread, messages: t.messages, anchorTs: row.ts })
      logEvent({ type: 'ig_conversa_nova', channel: 'instagram', detail: `${row.name} (${t.messages.length} msgs) entrou pelo poll leve` })
      updated++
    }
    // As threads recentes são conhecidas, portanto abrimos pelo id mesmo que a adoção de
    // uma conversa nova acima tenha tirado a página do inbox. Duas por rodada cobrem o
    // caso real das duas pessoas no topo sem transformar o poll de 45s numa varredura.
    for (const { row, chat } of recentes.slice(0, MAX_RECENTES_POR_TICK)) {
      const tid = await openThreadById(page, chat.thread_id)
      if (!tid) continue
      const t = await readOpenThread(page, { scrollRounds: 2 })
      persistThread({ accountKey, threadId: chat.thread_id, name: chat.name, username: t.username, avatar: row.avatar || chat.avatar, unread: row.unread, messages: t.messages, anchorTs: row.ts })
      refreshRecenteEm.set(`${accountKey}:${chat.thread_id}`, Date.now())
      logEvent({ type: 'ig_refresh_recente', personId: igPersonId(chat.thread_id), channel: 'instagram', detail: `${chat.name || chat.thread_id}: ${t.messages.length} msgs` })
      updated++
    }
    return updated
  })
}

// Sincroniza as top N conversas do inbox (lista + mensagens). onUpdate(threadId, personId) por conversa.
export async function syncInstagram({ accountKey, max = 8, onUpdate } = {}) {
  const inbox = await igExclusive(async () => {
    const page = await igPage()
    return readInbox(page, { max: 15 })
  })
  // Quem ainda não está no banco vem PRIMEIRO. Sem isso, uma conversa nova em posição 9+
  // nunca entrava: o laço abre no máximo `max` (8) e as 8 primeiras são sempre as mesmas.
  const conhecidas = new Set(igChats(accountKey).map((c) => c.name))
  const ordenado = [...inbox.filter((c) => !conhecidas.has(c.name)), ...inbox.filter((c) => conhecidas.has(c.name))]
  let done = 0
  for (let i = 0; i < ordenado.length && done < max; i++) {
    const c = ordenado[i]
    const personId = await igExclusive(async () => {
      const page = await igPage()
      const tid = await openThreadByName(page, c.name)
      if (!tid) return null
      const t = await readOpenThread(page, { scrollRounds: 8 }) // histórico no sync geral (para sozinho no topo)
      return { tid, personId: persistThread({ accountKey, threadId: tid, name: c.name, username: t.username, avatar: c.avatar, unread: c.unread, messages: t.messages, anchorTs: c.ts }) }
    })
    if (personId) {
      done++
      if (typeof onUpdate === 'function') { try { onUpdate(personId.tid, personId.personId) } catch { /* ignora */ } }
    }
  }
  // A FRAÇÃO, não só o total (regra do projeto: parcial nunca é relatado como total). "0
  // conversas" sozinho é ambíguo — some o caso em que o inbox veio VAZIO porque o Instagram
  // não deixou ler, que foi o que aconteceu por 2 dias em 31/07-02/08/2026 enquanto o log
  // dizia "sincronizou 0 conversas" com cara de dia parado.
  const detail = ordenado.length
    ? `sincronizou ${done} de ${ordenado.length} conversas do inbox`
    : 'o inbox voltou VAZIO (0 conversas) — não é o mesmo que não ter novidade: ou o Instagram não deixou ler, ou a sessão caiu'
  logEvent({ type: 'ig_sync', channel: 'instagram', detail })
  return done
}

// Varredura PROFUNDA: abre CADA conversa conhecida e rola bem fundo, puxando o máximo de
// histórico. Ponto crítico: cada conversa é uma operação igExclusive SEPARADA (~40s, bem
// dentro do timeout de 150s do igExclusive). Uma varredura única e longa estouraria o
// timeout e a aba seria disputada pelo loop normal no meio — por isso vamos uma a uma,
// soltando o lock entre elas (o loop normal intercala em vez de bloquear por minutos).
// onProgress(feitas, total, nome, nMsgs) reporta o andamento.
export async function deepScanInstagram({ accountKey, scrollRounds = 45, onProgress } = {}) {
  const chats = igChats(accountKey) // conversas já conhecidas (thread_id + nome), abrimos por id
  let done = 0
  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i]
    try {
      const n = await igExclusive(async () => {
        const page = await igPage()
        const tid = await openThreadById(page, chat.thread_id)
        if (!tid) return -1
        const t = await readOpenThread(page, { scrollRounds })
        persistThread({ accountKey, threadId: chat.thread_id, name: chat.name, username: t.username, avatar: chat.avatar, unread: false, messages: t.messages, anchorTs: chat.last_ts })
        return t.messages.length
      })
      if (n >= 0) { done++; if (typeof onProgress === 'function') { try { onProgress(done, chats.length, chat.name, n) } catch { /* ignora */ } } }
    } catch (e) { logEvent({ type: 'ig_error', channel: 'instagram', detail: 'deep-scan ' + (chat.name || '') + ': ' + e.message }) }
  }
  logEvent({ type: 'ig_deep_scan', channel: 'instagram', detail: 'varredura profunda: ' + done + ' de ' + chats.length + ' conversas' })
  return done
}

// Abre uma thread específica, relê e persiste (sob demanda: painel abriu / IA vai responder).
// O painel consulta a cada 5s; uma releitura ainda em curso é reutilizada, em vez de
// enfileirar dezenas de navegações iguais e deixar o Direct permanentemente atrasado.
const refreshes = new Map()
export function refreshThread({ accountKey, threadId, scrollRounds = 6 }) {
  const key = `${accountKey}:${threadId}`
  if (refreshes.has(key)) return refreshes.get(key)
  const task = igExclusive(async () => {
    const page = await igPage()
    const tid = await openThreadById(page, threadId)
    if (!tid) return null
    const t = await readOpenThread(page, { scrollRounds }) // cauda recente; persistThread preserva o histórico antigo
    const chat = getIgChat(accountKey, threadId)
    // âncora = o tempo real que o poll do inbox já gravou (se houver); senão agora.
    persistThread({ accountKey, threadId, name: chat?.name, username: t.username, avatar: chat?.avatar, unread: false, messages: t.messages, anchorTs: chat?.last_ts })
    return { messages: t.messages, username: t.username }
  }).finally(() => refreshes.delete(key))
  refreshes.set(key, task)
  return task
}



// Chama alguém pelo @ (conversa NOVA). Abre /direct/new/, acha o perfil exato, abre a
// conversa e manda o texto — o mesmo caminho de envio da thread normal, então a mensagem
// fica persistida e a thread passa a existir pro resto do sistema. Devolve { ok, threadId }.
export async function sendToUsername({ accountKey, username, text, author = null }) {
  const r = await igExclusive(async () => {
    const page = await igPage()
    const aberta = await openNewThread(page, username)
    if (!aberta.ok) return aberta
    const bolhas = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, MAX_BOLHAS)
    if (!bolhas.length) return { ok: false, motivo: 'texto vazio' }
    const personId = igPersonId(aberta.threadId)
    let ts = Date.now()
    for (let i = 0; i < bolhas.length; i++) {
      if (i > 0) await page.waitForTimeout(1200 + Math.min(bolhas[i].length * 40, 2800))
      await sendText(page, bolhas[i])
      ts = Date.now()
      addMessage({ messageId: 'ig:' + aberta.threadId + ':out:' + ts + ':' + i, accountKey, personId, channel: 'instagram', direction: 'outgoing', text: bolhas[i], ts, author })
    }
    upsertIgChat({ accountKey, threadId: aberta.threadId, name: null, username: String(username).replace(/^@+/, '').toLowerCase(), lastText: bolhas[bolhas.length - 1], lastTs: ts, unread: 0 })
    upsertPerson({ personId, accountKey, name: null })
    linkIdentity({ accountKey, channel: 'instagram', channelId: aberta.threadId, personId, method: 'ig' })
    logEvent({ type: 'ig_sent_novo', personId, channel: 'instagram', detail: '@' + username + ': ' + bolhas.join(' | ') })
    return { ok: true, threadId: aberta.threadId, ts, personId }
  })
  return r
}

// Envia numa thread (abre + digita + Enter) e persiste. Quebras de linha no texto =
// BOLHAS separadas (a IA sinaliza assim; no composer do IG o Enter envia, então cada
// linha vira um envio próprio, com respiro humano entre eles). Máximo 3.
export async function sendToThread({ accountKey, threadId, text, author = null }) {
  return igExclusive(async () => {
    const page = await igPage()
    await openThreadById(page, threadId)
    const personId = igPersonId(threadId)
    const bolhas = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, MAX_BOLHAS)
    let ts = Date.now()
    for (let i = 0; i < bolhas.length; i++) {
      if (i > 0) await page.waitForTimeout(1200 + Math.min(bolhas[i].length * 40, 2800))
      await sendText(page, bolhas[i])
      ts = Date.now()
      addMessage({ messageId: 'ig:' + threadId + ':out:' + ts + ':' + i, accountKey, personId, channel: 'instagram', direction: 'outgoing', text: bolhas[i], ts, author })
    }
    const last = bolhas[bolhas.length - 1] || ''
    const chat = getIgChat(accountKey, threadId)
    upsertIgChat({ accountKey, threadId, name: chat?.name, lastText: last, lastTs: ts, unread: false })
    logEvent({ type: 'ig_sent', personId, channel: 'instagram', detail: bolhas.join(' | ') })
    return { ok: true, ts }
  })
}

// ============================================================================================
// LEITURA PELA API (28/07/2026) — o caminho que substitui o scraping de DOM.
//
// A diferença que importa não é velocidade: é IDENTIDADE. Cada mensagem vem com `item_id`, e
// isso permite gravar de forma IDEMPOTENTE (addMessage por id) em vez do `delete + re-add` que
// o DOM obrigava. Com isso somem de uma vez: a citação virando mensagem, o horário deslizando a
// cada sync, as mensagens antigas reinseridas com data nova e o áudio virando texto.
//
// O DOM continua vivo e não foi apagado: ele faz o ENVIO, descobre conversa nova (é ele que
// conhece o id da URL, que a API não dá) e é o plano B se a API fechar.
// Ver docs/IG-API.md e docs/ENTENDIMENTO-IG-DOM.md.

// Uma conversa da API vira mensagens no banco. NÃO apaga nada: cada item entra pelo seu id.
export function persistirDaApi({ accountKey, threadId, mensagens, nome, username, avatar, unread }) {
  const personId = igPersonId(threadId)
  upsertPerson({ personId, accountKey, name: nome })
  linkIdentity({ accountKey, channel: 'instagram', channelId: threadId, personId, method: 'ig' })
  let gravadas = 0
  for (const m of mensagens) {
    if (!m || !m.id) continue
    // A CITAÇÃO NÃO É MENSAGEM. No DOM ela virava uma bolha nova com a direção de quem citou —
    // o defeito que embaralhou a conversa da Helena. Aqui ela é só um campo do item.
    const r = addMessage({
      messageId: 'ig:' + m.id,          // id REAL do Instagram: reprocessar não duplica
      accountKey, personId, channel: 'instagram',
      direction: m.dir === 'out' ? 'outgoing' : 'incoming',
      text: m.text, ts: m.ts,
      media: m.midia || null,
    })
    if (r !== false) gravadas++
    if (m.midia && m.midia.src) {
      try { registerIgMedia({ accountKey, src: m.midia.src, kind: m.midia.kind, personId, threadId }) }
      catch { /* best-effort */ }
    }
  }
  const ultima = mensagens[mensagens.length - 1]
  upsertIgChat({
    accountKey, threadId, name: nome, username, avatar,
    lastText: ultima ? ultima.text : null,
    lastTs: ultima ? ultima.ts : null,      // hora REAL, não mais inferida
    unread: unread == null ? null : (unread ? 1 : 0),
  })
  for (const m of mensagens) {
    if (m.dir === 'out' || !m.text) continue
    try { colherDaMensagem({ accountKey, personId, channel: 'instagram', messageId: 'ig:' + m.id, text: m.text, direction: 'incoming' }) }
    catch { /* colher nunca derruba o sync */ }
  }
  return { personId, gravadas }
}

// O tick. Uma chamada de inbox traz as conversas COM as últimas mensagens de cada uma — o que
// no DOM custava ~10s de navegação por conversa, aqui é um round-trip.
//
// Só sincroniza quem JÁ existe no banco: o `person_id` do Instagram é `ig:<id da URL>`, e a API
// usa outra numeração. Criar conversa nova por aqui geraria uma segunda pessoa pra alguém que
// já existe. Quem descobre conversa nova continua sendo o DOM, que conhece o id da URL.
export async function syncIgPelaApi({ accountKey = 'main', limite = 20, mensagensPorConversa = 20 } = {}) {
  const { conversas } = await igApi.inbox({ limite, mensagensPorConversa })
  let tocadas = 0
  let gravadas = 0
  const semCasar = []
  for (const c of conversas) {
    if (c.grupo || !c.username) continue
    // Depois do primeiro casamento, o id da API é a chave mais forte. Continuar dependendo
    // do @ deixava uma leitura ruim do DOM romper o vínculo e podia aplicar foto/nome na
    // conversa errada até a próxima varredura completa.
    const linha = igChatPorApiId(accountKey, c.apiThreadId) || igChatPorUsername(accountKey, c.username)
    if (!linha) { semCasar.push(c.username); continue }
    if (linha.api_thread_id !== c.apiThreadId) igChatSetApiId(accountKey, linha.thread_id, c.apiThreadId)
    const r = persistirDaApi({
      accountKey, threadId: linha.thread_id, mensagens: c.mensagens,
      nome: c.nome, username: c.username, avatar: c.avatar, unread: c.naoLidas,
    })
    tocadas++
    gravadas += r.gravadas
  }
  logEvent({ type: 'ig_sync_api', detail: `${conversas.length} conversas na API, ${tocadas} atualizadas, ${gravadas} mensagens novas${semCasar.length ? `, ${semCasar.length} ainda sem cadastro (o DOM descobre)` : ''}` })
  return { conversas: conversas.length, tocadas, gravadas, semCasar }
}

export function leituraPelaApiLigada() { return _getSetting('ig_leitura_api', true) !== false }
