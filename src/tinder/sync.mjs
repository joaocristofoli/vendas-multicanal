// Sincroniza matches e conversas do Tinder para o banco (pessoa/identity/mensagens/
// tinder_match), classificando pendência e detecção de contato compartilhado.
import {
  upsertPerson,
  linkIdentity,
  upsertTinderMatch,
  addTinderMessage,
  logEvent,
  updateTinderConversation,
  updateTinderHistoryState,
  unverifiedTinderMatches,
  reconcileActiveTinderMatches,
  getTinderMatchState,
  recentTinderMessages,
} from '../core/db.mjs'
import { otherIdFromMatch } from './api.mjs'
import { colherDaMensagem } from '../bridge/hints.mjs'

const PHONE = /(?:\+?55[\s().-]*)?(?:\(?\d{2}\)?[\s.-]*)?9?[\s.-]?\d{4}[\s.-]?\d{4}/
const SOCIAL = /(instagram\.com|wa\.me|t\.me|api\.whatsapp|snapchat|@[a-z0-9._]{3,})/i

export function personIdForMatch(matchId) { return `p:${matchId}` }

// Quanto tempo esperar antes de tentar de novo baixar um histórico que continuou
// divergindo do preview (preview de mídia, por exemplo, nunca casa com texto nenhum).
const HISTORY_RETRY_MS = Number(process.env.TIM_TINDER_HISTORY_RETRY_MS || 5 * 60 * 1000)
const historyAttempts = new Map() // matchId -> { fp, at }

// A mensagem do preview está no banco? Compara com as últimas bolhas (não só a última,
// porque uma resposta nossa fica DEPOIS do preview: o envio pela API não reordena o canal).
// Tolera truncamento do preview comparando por prefixo.
// O preview do canal vem TRUNCADO quando a mensagem é longa, então comparar por igualdade
// pura não serve. A direção que vale é UMA só: preview truncado é PREFIXO da bolha inteira. O contrário não
// acontece — o banco guarda o texto completo que a API devolveu. E prefixo só conta com
// tamanho suficiente pra ser evidência; preview curto exige igualdade.
const MIN_PREFIXO = 12
const semReticencias = (s) => String(s || '').trim().replace(/(…|\.\.\.)+$/, '').trim()

function previewIsStored(previewText, recent) {
  const a = semReticencias(previewText)
  if (!a) return false
  return recent.some((row) => {
    const b = semReticencias(row.text)
    if (!b) return false
    if (a === b) return true
    return a.length >= MIN_PREFIXO && b.startsWith(a)
  })
}

// Falta histórico desta conversa? O preview do canal é a última mensagem segundo o
// Tinder; se ela não está entre as bolhas do banco, existe buraco — foi assim que uma
// mensagem sumiu (o roster leve gravava só a última e o polling achava que estava em dia).
export function tinderHistoryGap({ previewText, evTs, recent }) {
  if (!recent.length) return true
  if (String(previewText || '').trim()) return !previewIsStored(previewText, recent)
  return Number(evTs || 0) > Number(recent[0].ts || 0) + 60000 // preview sem texto: só o relógio
}

function ageFrom(birthDate) {
  if (!birthDate) return null
  const ms = Date.now() - new Date(birthDate).getTime()
  return ms > 0 ? Math.floor(ms / 3.15576e10) : null
}

function sortedMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && message.sent_date)
    .slice()
    .sort((a, b) => new Date(a.sent_date) - new Date(b.sent_date))
}

export function persistTinderHistory({ accountKey, myId, matchId, personId, messages, checkedAt = Date.now() }) {
  const ordered = sortedMessages(messages)
  let lastDir = null
  let lastText = null
  let lastTs = null
  let shared = false
  for (const msg of ordered) {
    const dir = msg.from === myId ? 'outgoing' : 'incoming'
    const ts = new Date(msg.sent_date).getTime()
    addTinderMessage({ messageId: msg._id, accountKey, personId, direction: dir, text: msg.message, ts })
    lastDir = dir === 'outgoing' ? 'eu' : 'ela'
    lastText = msg.message
    lastTs = ts
    if (dir === 'incoming' && (PHONE.test(msg.message || '') || SOCIAL.test(msg.message || ''))) shared = true
    // Colhe o VALOR do contato (o booleano shared_contact acima só diz que existe algo).
    if (dir === 'incoming' && msg.message) {
      try { colherDaMensagem({ accountKey, personId, channel: 'tinder', messageId: msg._id, text: msg.message, direction: 'incoming' }) }
      catch { /* colher nunca derruba o sync */ }
    }
  }
  updateTinderHistoryState({
    accountKey,
    matchId,
    hasConversation: ordered.length > 0,
    pending: lastDir === 'ela',
    lastDir,
    lastText,
    lastTs,
    sharedContact: shared,
    historyCheckedAt: checkedAt,
  })
  return { messageCount: ordered.length, lastDir, lastText, lastTs, sharedContact: shared }
}

export async function syncTinderMatchHistory(api, accountKey, myId, match) {
  const messages = await api.messages(match.match_id)
  return persistTinderHistory({
    accountKey,
    myId,
    matchId: match.match_id,
    personId: match.person_id || personIdForMatch(match.match_id),
    messages,
  })
}

export async function syncMatches(api, accountKey, myId, { withHistory = true, delayMs = 320 } = {}) {
  // `/v2/matches` representa o grupo "Messages". O grupo "New Matches" só existe nos
  // canais do chat móvel; por isso a lista ativa é a união das duas fontes.
  const [matches, channels] = await Promise.all([
    api.allMatches(),
    api.channels({ allPages: true }),
  ])
  let synced = 0
  const activeIds = new Set()
  for (const m of matches) {
    activeIds.add(m._id)
    const person = m.person || {}
    const personId = personIdForMatch(m._id)
    upsertPerson({ personId, accountKey, name: person.name, photo: person.photos?.[0]?.url })
    linkIdentity({ accountKey, channel: 'tinder', channelId: m._id, personId, method: 'deterministic' })

    let msgs = sortedMessages(m.messages)
    const hasConversationEvidence = msgs.length > 0 || Number(m.message_count) > 0
    let historyCheckedAt = null
    if (withHistory && hasConversationEvidence) {
      try { msgs = sortedMessages(await api.messages(m._id)); historyCheckedAt = Date.now() } catch {
        // A prévia da listagem ainda prova que existe conversa, mesmo quando o endpoint
        // de histórico falha temporariamente. A lacuna continuará elegível no polling.
        msgs = sortedMessages(m.messages)
      }
      await new Promise((r) => setTimeout(r, delayMs))
    }

    let lastDir = null, lastText = null, lastTs = null, shared = false
    for (const msg of msgs) {
      const dir = msg.from === myId ? 'outgoing' : 'incoming'
      // Sem histórico, `msgs` é só a PRÉVIA de `/v2/matches` (a última mensagem). Gravar
      // essa bolha sozinha mascarava o buraco: o polling passava a ver o preview já
      // presente no banco e nunca baixava as mensagens do meio. Aqui ela serve apenas
      // para o cabeçalho da lista; o histórico vem do endpoint de mensagens.
      if (withHistory) addTinderMessage({ messageId: msg._id, accountKey, personId, direction: dir, text: msg.message, ts: new Date(msg.sent_date).getTime() })
      lastDir = dir === 'outgoing' ? 'eu' : 'ela'
      lastText = msg.message
      lastTs = new Date(msg.sent_date).getTime()
      if (dir === 'incoming' && (PHONE.test(msg.message || '') || SOCIAL.test(msg.message || ''))) shared = true
    }

    upsertTinderMatch({
      accountKey, matchId: m._id, personId, otherId: otherIdFromMatch(m._id, myId),
      name: person.name, bio: person.bio, age: ageFrom(person.birth_date), city: person.city?.name,
      photos: (person.photos || []).map((p) => p.url).filter(Boolean),
      hasConversation: hasConversationEvidence || msgs.length > 0,
      pending: lastDir === 'ela',
      lastDir,
      lastText,
      lastTs,
      sharedContact: shared,
      historyCheckedAt,
      active: true,
    })
    synced++
  }

  // O celular é a fonte da verdade para "New Matches": filter 2, sem preview. Esses
  // canais não aparecem em `/v2/matches`, mas continuam sendo matches ativos e elegíveis
  // para primeira mensagem. Filter 1 cobre as conversas e completa a união autoritativa.
  for (const c of channels) {
    const cid = c.channel_id
    if (!cid || cid.reference_type !== 'REFERENCE_TYPE_MATCH' || !cid.reference_id) continue
    const matchId = cid.reference_id
    activeIds.add(matchId)
    if (matches.some((match) => match._id === matchId)) continue
    const personId = personIdForMatch(matchId)
    const part = (c.participants || []).find((p) => p.user_id && p.user_id !== myId) || (c.participants || [])[0] || {}
    const pv = c.message_preview || {}
    const hasPreview = Boolean(pv.sender_id || String(pv.text || '').trim())
    const lastDir = pv.sender_id ? (pv.sender_id === myId ? 'eu' : 'ela') : null
    const evTs = new Date(c.last_reordering_event_timestamp || 0).getTime()
    upsertPerson({ personId, accountKey, name: part.name, photo: part.photo && part.photo.image_url })
    linkIdentity({ accountKey, channel: 'tinder', channelId: matchId, personId, method: 'deterministic' })
    upsertTinderMatch({
      accountKey,
      matchId,
      personId,
      otherId: otherIdFromMatch(matchId, myId),
      name: part.name,
      photos: part.photo && part.photo.image_url ? [part.photo.image_url] : [],
      hasConversation: hasPreview,
      pending: hasPreview && (!!pv.show_your_turn_label || (!!pv.sender_id && pv.sender_id !== myId)),
      lastDir,
      lastText: pv.text || null,
      lastTs: evTs || null,
      historyCheckedAt: hasPreview ? null : Date.now(),
      active: true,
    })
  }

  // A união completa dos grupos "Messages" + "New Matches" espelha a tela Chat do
  // celular. Só o que está ausente de ambos é ocultado, sem apagar o histórico.
  reconcileActiveTinderMatches(accountKey, [...activeIds])
  logEvent({ type: 'tinder_sync', detail: `${activeIds.size} ativos (${synced} conversas, ${activeIds.size - synced} sem conversa)` })
  return activeIds.size
}

// Polling INCREMENTAL via canais (leve, roda no loop): atualiza o preview/pendência de
// TODAS as conversas a partir de `channels()` (2 requests, sem baixar mensagens), e busca
// as mensagens só das que MUDARAM desde o último check E estão pendentes (a IA precisa do
// histórico atualizado pra responder). É o que mantém painel e IA em dia com o Tinder real.
export async function syncTinderUpdates(api, accountKey, myId, { fetchNew = true, maxFetch = 20 } = {}) {
  let channels = []
  try { channels = await api.channels() } catch { return { touched: 0, fetched: 0 } }
  const toFetch = []
  for (const c of channels) {
    const cid = c.channel_id
    if (!cid || cid.reference_type !== 'REFERENCE_TYPE_MATCH' || !cid.reference_id) continue
    const matchId = cid.reference_id
    const personId = personIdForMatch(matchId)
    const pv = c.message_preview || {}
    const part = (c.participants || []).find((p) => p.user_id && p.user_id !== myId) || (c.participants || [])[0] || {}
    const evTs = new Date(c.last_reordering_event_timestamp || 0).getTime()
    const hasPreview = Boolean(pv.sender_id || String(pv.text || '').trim())
    const lastDir = pv.sender_id ? (pv.sender_id === myId ? 'eu' : 'ela') : null
    const pending = hasPreview && (!!pv.show_your_turn_label || (!!pv.sender_id && pv.sender_id !== myId))
    const known = getTinderMatchState(accountKey, matchId) // ANTES de atualizar (ts + preview)
    upsertPerson({ personId, accountKey, name: part.name, photo: part.photo && part.photo.image_url })
    linkIdentity({ accountKey, channel: 'tinder', channelId: matchId, personId, method: 'deterministic' })
    // filter 2 é exatamente a faixa "New Matches" do celular. A ausência de preview
    // aqui é prova autoritativa de que não existe conversa, mesmo se `/v2/matches`
    // não listar o match.
    if (c.tim_filter === 2 && !hasPreview) {
      upsertTinderMatch({
        accountKey,
        matchId,
        personId,
        otherId: otherIdFromMatch(matchId, myId),
        name: part.name,
        photos: part.photo && part.photo.image_url ? [part.photo.image_url] : [],
        hasConversation: false,
        pending: false,
        lastDir: null,
        lastText: null,
        lastTs: evTs || null,
        historyCheckedAt: Date.now(),
        active: true,
      })
      continue
    }
    const rows = hasPreview
      ? updateTinderConversation({ accountKey, matchId, lastText: pv.text || null, lastTs: evTs || null, lastDir, pending, hasConversation: true })
      : Number(Boolean(known.person_id))
    if (!rows) { // conversa ainda não estava no banco: cria o básico (o resto vem do sync completo)
      upsertTinderMatch({ accountKey, matchId, personId, otherId: otherIdFromMatch(matchId, myId), name: part.name,
        photos: part.photo && part.photo.image_url ? [part.photo.image_url] : [],
        hasConversation: hasPreview,
        pending,
        lastDir,
        lastText: pv.text || null,
        lastTs: evTs || null,
        active: true,
      })
    }
    // busca quando a mensagem do preview NÃO está no banco. O critério é o histórico
    // real (tabela message), não o campo `last_text` do match: qualquer caminho que
    // escreve o cabeçalho sem gravar as bolhas fazia o polling achar que estava em dia e
    // a mensagem do meio se perdia pra sempre. Como o critério só apaga quando a bolha
    // entra, fetch que falha ou que não coube no teto volta sozinho no ciclo seguinte.
    if (fetchNew && hasPreview && tinderHistoryGap({ previewText: pv.text, evTs, recent: recentTinderMessages(personId) })) {
      const fp = `${String(pv.text || '').trim()}|${evTs}`
      const attempt = historyAttempts.get(matchId)
      // não insistir no mesmo preview a cada 45s quando o download não resolve a divergência
      if (!attempt || attempt.fp !== fp || Date.now() - attempt.at >= HISTORY_RETRY_MS) {
        toFetch.push({ matchId, personId, evTs, changed: true, fp })
      }
    }
  }

  // Uma checagem vazia também precisa ser persistida: é isso que distingue, com prova,
  // um match realmente sem primeira mensagem de um histórico que ainda não foi puxado.
  // Os não verificados continuam elegíveis nos ciclos seguintes; o teto nunca mais
  // abandona silenciosamente os itens 21+ como acontecia antes.
  const scheduled = new Set(toFetch.map((item) => item.matchId))
  if (fetchNew) {
    for (const match of unverifiedTinderMatches(accountKey, Math.max(maxFetch * 2, maxFetch))) {
      if (scheduled.has(match.match_id)) continue
      scheduled.add(match.match_id)
      toFetch.push({ matchId: match.match_id, personId: match.person_id, evTs: Number(match.last_ts) || 0, changed: false })
    }
  }
  // Mudanças reais primeiro; depois completa a auditoria histórica aos poucos.
  toFetch.sort((a, b) => Number(b.changed) - Number(a.changed) || b.evTs - a.evTs)
  let fetched = 0
  const falhas = []
  for (const { matchId, personId, fp } of toFetch.slice(0, maxFetch)) {
    try {
      const msgs = await api.messages(matchId)
      persistTinderHistory({ accountKey, myId, matchId, personId, messages: msgs })
      if (fp) historyAttempts.set(matchId, { fp, at: Date.now() })
      fetched++
      await new Promise((r) => setTimeout(r, 200))
    } catch (e) {
      // Uma conversa que falha não pode derrubar as outras, mas também não pode sumir sem
      // rastro: o `catch {}` vazio que existia aqui fazia "0 conversas atualizadas" ter duas
      // causas indistinguíveis — nada pra buscar, ou tudo falhando. Fica no diário.
      falhas.push(`${matchId}: ${e.message}`)
    }
  }
  if (falhas.length) logEvent({ type: 'tinder_updates_falha', detail: `${falhas.length} conversa(s) não baixaram: ${falhas.slice(0, 3).join(' | ')}` })
  // `pedidas` separa "não havia o que buscar" de "buscou e falhou" — sem isso o número 0 não
  // diz qual dos dois aconteceu, que foi exatamente o que atrasou este diagnóstico.
  logEvent({ type: 'tinder_updates', detail: `${channels.length} canais, ${fetched}/${toFetch.length} conversas atualizadas` })
  return { touched: channels.length, fetched, pedidas: toFetch.length, falhas: falhas.length }
}
