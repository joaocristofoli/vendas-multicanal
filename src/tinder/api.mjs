// Cliente da API REST do Tinder (api.gotinder.com). Usa o sistema de chat por CANAIS
// (v1/chat/channels) — o /user/matches/{id} legado responde 200 mas NAO entrega.
// Autentica por X-Auth-Token. Sem DOM e sem captcha (captcha é só no login web).
import crypto from 'node:crypto'
const API = 'https://api.gotinder.com'

// O DEVICE-ID É POR INSTALAÇÃO, NUNCA CHUMBADO NO CÓDIGO (corrigido em 31/07/2026).
//
// Antes havia aqui o device-id de um navegador específico — o do dono do sistema de origem.
// Num fork isso vira um problema silencioso e sério: duas contas de Tinder diferentes
// enviando o MESMO `persistent-device-id` são, para o Tinder, o mesmo aparelho. É um sinal
// de ligação entre contas que ninguém pediu, num serviço que pune exatamente isso.
//
// A ordem é: TIM_DEVICE_ID (env) -> o que estiver guardado no banco -> um UUID novo, gerado
// uma vez e persistido. Assim cada instalação tem o seu, estável entre reinícios, e nenhum
// device de terceiro entra por default.
import { getSetting, setSetting } from '../core/db.mjs'

function deviceId() {
  if (process.env.TIM_DEVICE_ID) return process.env.TIM_DEVICE_ID
  let id = null
  try { id = getSetting('tinder_device_id', null) } catch { /* banco ainda não subiu */ }
  if (id) return id
  id = crypto.randomUUID()
  try { setSetting('tinder_device_id', id) } catch { /* sem banco: vale só para este processo */ }
  return id
}
const APP_SESSION = crypto.randomUUID()

// Cache matchId -> channel_id ({id, reference_type, reference_id}), compartilhado entre
// instâncias (tinderApi() recria o client a cada chamada). Vive enquanto o processo vive.
const chanCache = new Map()

// O CABEÇALHO QUE FAZ A REQUISIÇÃO PARECER O APP — exportado porque script de diagnóstico
// também precisa dele. Sem isto, cada script montava o seu com três campos e queimava a
// sessão da dona (licoes/tinder-chamada-crua-queima-sessao).
export function cabecalhosDoApp({ token, ua } = {}) {
  return {
    'X-Auth-Token': token,
    platform: 'web',
    'app-version': process.env.TIM_APP_VERSION || '1072503',
    'tinder-version': process.env.TIM_TINDER_VERSION || '7.25.3',
    'persistent-device-id': deviceId(),
    'app-session-id': APP_SESSION,
    'x-supported-image-formats': 'webp,jpeg',
    'User-Agent': ua || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    Origin: 'https://tinder.com',
    Referer: 'https://tinder.com/',
    'Content-Type': 'application/json',
  }
}

export function tinderClient({ token, ua }) {
  // Uma cópia só do cabeçalho, pros dois caminhos (cliente e script) nunca divergirem.
  const headers = cabecalhosDoApp({ token, ua })
  // TIMEOUT OBRIGATÓRIO em toda chamada. Sem ele, uma conexão pendurada trava a sessão
  // pra sempre: em 25/07/2026 a sessão automática das 14:35 parou 11 minutos num `like`
  // que nunca respondeu, segurando o motor inteiro. `fetch` não tem timeout por padrão.
  const TIMEOUT_MS = Number(process.env.TIM_API_TIMEOUT_MS || 20000)
  const chama = async (path, init) => {
    try {
      const r = await fetch(API + path, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
      return { status: r.status, body: await r.json().catch(() => null) }
    } catch (e) {
      // devolve como status 0 em vez de estourar: quem chama decide, e a sessão segue
      if (e.name === 'TimeoutError' || e.name === 'AbortError') return { status: 0, body: null, timeout: true }
      throw e
    }
  }
  const get = (path) => chama(path, {})
  const post = (path, body) => chama(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

  // Carrega os dois grupos que o app móvel mostra em Chat:
  // filter 2 = "New Matches" (sem conversa); filter 1 = "Messages" (com conversa).
  // O polling usa só a página recente; a reconciliação periódica percorre todas.
  async function loadChannels({ allPages = false, maxPages = 25 } = {}) {
    const out = []
    const seen = new Set()
    for (const filter of [2, 1]) {
      let backwardPageToken = null
      for (let page = 0; page < (allPages ? maxPages : 1); page++) {
        const paginationParams = { limit: 50 }
        if (backwardPageToken) paginationParams.backward_page_token = backwardPageToken
        const r = await post('/v1/chat/channels/query?locale=en', {
          filters: [filter],
          included_reference_types: ['REFERENCE_TYPE_MATCH', 'REFERENCE_TYPE_DUO'],
          pagination_params: paginationParams,
        })
        if (r.status !== 200) throw new Error(`channels filter ${filter} status ${r.status}`)
        const channels = r.body?.channels || []
        for (const c of channels) {
          const cid = c.channel_id
          if (!cid?.reference_id) continue
          chanCache.set(cid.reference_id, cid)
          if (seen.has(cid.reference_id)) continue
          seen.add(cid.reference_id)
          out.push({ ...c, tim_filter: filter })
        }
        const info = r.body?.pagination_info || {}
        const next = info.next_backward_page_token
        if (!allPages || !info.has_next_page || !next || next === backwardPageToken || !channels.length) break
        backwardPageToken = next
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
    }
    return out
  }

  // channel_id de um match. Cache -> primeira página -> TODAS as páginas -> desiste.
  //
  // O "por último monta pelo match" que existia aqui era uma aposta, e ela custou caro em
  // 11/08/2026: `loadChannels()` sem paginação traz só a PRIMEIRA página de cada filtro
  // (limite 50) — 91 de 180 canais. Todo match da metade pra baixo caía no canal montado à
  // mão, SEM uuid, e o Tinder respondia 200 com o eco (`"id": ""`) sem entregar nada. Foram
  // 155 mensagens marcadas como enviadas que não existem, em 87 conversas — nenhuma delas
  // estava na primeira página, e as que funcionaram estavam.
  //
  // Agora, quando não acha, ele PROCURA DE VERDADE antes de desistir; e se não achar,
  // devolve null. Null vira falha declarada no `sendText` — nunca mais um envio às cegas
  // que se anuncia como entregue.
  async function channelIdFor(matchId) {
    if (chanCache.has(matchId)) return chanCache.get(matchId)
    await loadChannels()
    if (chanCache.has(matchId)) return chanCache.get(matchId)
    await loadChannels({ allPages: true })
    return chanCache.get(matchId) || null
  }

  return {
    async profile() {
      const r = await get('/v2/profile?include=user')
      if (r.status !== 200) throw new Error('profile status ' + r.status)
      return r.body?.data?.user || null
    },

    // O perfil DELA, como aparece na tela do app: interesses, prompts respondidos, o que
    // ela procura, faculdade, trabalho, descritores (pets, signo, bebida) e distância.
    // O `/v2/matches` só devolve nome, bio e foto — e bio, medida no banco em 27/07/2026,
    // existe em 158 de 461 matches. Esta chamada é o que tira a IA do escuro nos outros 303.
    //
    // Devolve `null` (e não erro) quando o perfil sumiu: 404 é perfil apagado/desmatchado e
    // acontece o tempo todo numa varredura — quem chama precisa marcar "já olhei, não tem"
    // em vez de tentar de novo pra sempre.
    async userProfile(userId) {
      if (!userId) return null
      const r = await get(`/user/${encodeURIComponent(userId)}?locale=pt`)
      if (r.status === 404 || r.status === 410) return null
      if (r.status !== 200) throw new Error('userProfile status ' + r.status)
      return r.body?.results || r.body || null
    },

    // Todos os matches, seguindo a paginação. message=1 traz a última mensagem por match.
    async allMatches({ maxPages = 25, delayMs = 400 } = {}) {
      const out = []
      let pageToken = null
      for (let i = 0; i < maxPages; i++) {
        const r = await get('/v2/matches?count=100&message=1' + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : ''))
        if (r.status !== 200) throw new Error('matches status ' + r.status)
        out.push(...(r.body?.data?.matches || []))
        pageToken = r.body?.data?.next_page_token
        if (!pageToken) break
        await new Promise((res) => setTimeout(res, delayMs))
      }
      return out
    },

    // Canais crus (com participantes: nome, foto). Útil pro painel e pra descoberta.
    channels: loadChannels,
    channelIdFor,

    // Lê o histórico pelo endpoint NOVO e normaliza pro formato legado {_id, from, message, sent_date}
    // pra não quebrar quem consome (autoreply, sync). Ordena do mais antigo pro mais novo.
    async messages(matchId, count = 100) {
      const cid = await channelIdFor(matchId)
      // MATCH SEM CANAL NÃO É ERRO — é conversa que nunca existiu (ou que foi desfeita).
      // Sem isto, `channel_id: null` ia pro servidor, voltava 400, e a varredura registrava
      // "1 conversa(s) não baixaram" a cada 45 segundos, pra sempre, sobre uma conversa que
      // não tem o que baixar. Visto na primeira sincronização de uma conta nova (13/08/2026):
      // 122 matches, 66 canais — o resto nunca trocou mensagem.
      if (!cid) return []
      const r = await post('/v1/chat/channels/messages/query?locale=en', { channel_id: cid, pagination_params: { limit: count } })
      if (r.status !== 200) throw new Error('messages status ' + r.status)
      const msgs = (r.body?.messages || []).map((m) => ({
        _id: m.message_id?.id,
        from: m.sender_id,
        message: m.content?.text?.message ?? '',
        sent_date: m.created_at,
        raw: m,
      }))
      return msgs.sort((a, b) => new Date(a.sent_date) - new Date(b.sent_date))
    },

    // Envia texto pelo canal. Responde 201 quando entrega DE VERDADE (o legado dava 200 falso).
    // ENVIO SÓ É ENVIO COM ID DO PROVEDOR.
    //
    // A condição antiga aceitava "2xx com channel_id no corpo" — e o corpo do ECO traz o
    // channel_id que a gente mesmo mandou. Em 11/08/2026 isso deu 155 mensagens marcadas como
    // enviadas que NÃO EXISTEM no Tinder: conferido conversa por conversa contra o servidor,
    // 0 entregues. Todas gravadas com id `local:` — nenhuma tinha id do provedor, e ninguém
    // reparou porque ninguém exigia.
    //
    // Agora a régua é a única coisa que o servidor não devolve de graça: o `message_id`. Sem
    // ele, `ok:false` — e quem chama decide, mas não pode mais achar que entregou.
    async sendText({ matchId, text }) {
      const cid = await channelIdFor(matchId)
      // SEM CANAL, NÃO EXISTE ENVIO. Mandar assim devolve 200 e não entrega — o pior dos
      // mundos, porque o sistema acha que falou.
      if (!cid || !cid.id) {
        return { ok: false, status: 0, messageId: null,
          motivo: 'não achei o canal desta conversa no Tinder (nem paginando tudo) — nada foi enviado' }
      }
      const r = await post('/v1/chat/channels/messages?locale=en', {
        channel_id: cid, message: { content: { text: { message: String(text || '') } } },
      })
      const messageId = r.body?.message_id?.id || r.body?.message?.message_id?.id || null
      const ok = r.status >= 200 && r.status < 300 && !!messageId
      return { ok, status: r.status, messageId,
        motivo: ok ? null : (messageId ? `status ${r.status}` : `o Tinder respondeu ${r.status} sem id de mensagem — nada foi entregue`),
        body: r.body }
    },

    // ---------- descoberta (docs/TINDER-DESCOBERTA.md) ----------

    // Pilha de recomendações. NÃO consome nada: os mesmos perfis voltam até serem
    // deslizados. Cada item já vem completo (bio, fotos, descritores, intenção).
    async recs() {
      const r = await get('/v2/recs/core?locale=pt')
      if (r.status !== 200) throw new Error('recs status ' + r.status)
      return r.body?.data?.results || []
    },

    // QUANTAS curtidas recebidas ainda não respondidas. Sem Gold o Tinder mostra o NÚMERO
    // (é o que ele usa pra vender o Gold) e recusa a lista com os rostos.
    //
    // Existe aqui, e não solto num script, por uma razão cara: em 11/08/2026 eu li este mesmo
    // endpoint com `fetch` montado à mão, mandando só `X-Auth-Token`/UA/Origin, sem
    // `app-version`, `tinder-version`, `persistent-device-id` nem `app-session-id`. A sessão
    // morreu duas vezes seguidas logo depois — a segunda **81 segundos** depois de o token ser
    // gravado, com um `syncMatches` bem-sucedido 22 s antes. Requisição sem a identidade do
    // app é requisição de robô desconhecido, e queimar a sessão da dona custa um pedido de
    // token novo pra quem está do outro lado.
    async fastMatchCount() {
      const r = await get('/v2/fast-match/count')
      if (r.status !== 200) throw new Error('fast-match/count status ' + r.status)
      return { count: r.body?.data?.count ?? null, faixa: !!r.body?.data?.is_range }
    },

    // Quem já te curtiu, com perfil completo (só vem sem blur por causa do Gold).
    async fastMatch(count = 30) {
      const r = await get(`/v2/fast-match?locale=pt&count=${count}`)
      if (r.status !== 200) throw new Error('fast-match status ' + r.status)
      return (r.body?.data?.results || []).map((x) => (x.user ? x : { user: x }))
    },

    async topPicks() {
      const r = await get('/v2/top-picks?locale=pt')
      return r.status === 200 ? (r.body?.data?.results || []) : []
    },

    // Curtir. O s_number e o content_hash vêm do próprio rec — sem eles o Tinder aceita
    // mas não registra direito. Prova de que entrou = o perfil sair da pilha.
    async like({ userId, sNumber, photoId, contentHash }) {
      const r = await post(`/like/${userId}`, {
        s_number: sNumber, liked_content_id: photoId || undefined,
        liked_content_type: photoId ? 'photo' : undefined, content_hash: contentHash || undefined,
      })
      return { ok: r.status === 200, status: r.status, match: !!r.body?.match, likesRemaining: r.body?.likes_remaining }
    },

    async pass({ userId, sNumber }) {
      const r = await post(`/pass/${userId}?s_number=${sNumber}`, null)
      return { ok: r.status === 200, status: r.status }
    },

    // Passport. ATENÇÃO: nunca usar /passport/user/reset para "voltar" — reset devolve pro
    // GPS real e apaga a viagem que o dono já tinha configurada. Voltar = repostar a
    // posição anterior (guardada por quem chamou).
    async travelTo({ lat, lon }) {
      const r = await post('/passport/user/travel', { lat, lon })
      return { ok: r.status === 200, status: r.status }
    },

    // Volta pro GPS real (apaga a viagem). Só usar quando o dono pedir explicitamente
    // "voltar pra onde eu estou" — nunca como forma de "desfazer" uma troca de cidade,
    // porque apaga a viagem que ele mesmo tinha configurado antes.
    async travelReset() {
      const r = await post('/passport/user/reset', {})
      return { ok: r.status === 200, status: r.status }
    },

    // Onde estou (posição de viagem + GPS real + cidade resolvida pelo próprio Tinder).
    async whereAmI() {
      const r = await get('/v2/profile?include=travel,user')
      const d = r.body?.data || {}
      const c = d.travel?.travel_location_info?.[0]
      return {
        travelPos: d.travel?.travel_pos || null, isTraveling: !!d.travel?.is_traveling,
        realPos: d.user?.pos || null,
        city: c ? `${c.administrative_area_level_2?.long_name || '?'}/${c.administrative_area_level_1?.short_name || '?'}` : null,
      }
    },

    // Estado da conta: assinatura, poderes, filtros, medidor de perfil.
    async accountState() {
      const r = await get('/v2/profile?locale=pt&include=user,likes,super_likes,boost,purchase,feature_access,profile_meter,travel')
      if (r.status !== 200 && r.status !== 206) throw new Error('accountState status ' + r.status)
      return r.body?.data || {}
    },

    // Escrita no perfil (bio, filtros, cargo, interesses...). Devolve o user atualizado.
    async updateProfile(fields) {
      const r = await post('/v2/profile', { user: fields })
      return { ok: r.status === 200, status: r.status, user: r.body?.data?.user || null }
    },

    // Polling INCREMENTAL do Tinder: só as novidades (mensagens/matches novos) desde
    // `since` (ISO). Leve — é o que o app usa pra receber em tempo quase real. Retorna
    // { status, data:{ matches:[{_id, messages:[...], ...}], last_activity_date } }.
    async updates(since) {
      const r = await post('/updates?locale=en&include_conversations=true', { nudge: false, last_activity_date: since || '2020-01-01T00:00:00.000Z' })
      return { status: r.status, data: (r.body && r.body.data) || {} }
    },
  }
}

// matchId = myUserId concatenado com otherUserId (ambos 24 hex). Extrai o otherId.
// (Mantido: o matchId nem sempre começa pelo meu id — alguns vêm com o outro primeiro.)
export function otherIdFromMatch(matchId, myUserId) {
  const s = String(matchId || '')
  if (myUserId && s.startsWith(myUserId)) return s.slice(myUserId.length)
  if (myUserId && s.endsWith(myUserId)) return s.slice(0, s.length - myUserId.length)
  return s.length > 24 ? s.slice(24) : s
}
