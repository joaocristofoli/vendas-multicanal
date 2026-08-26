// Rotas da seção Descoberta (auto-deslizar, critérios, passport, perfil do Tinder).
// Mesmo padrão de bridge/routes.mjs e projects/routes.mjs: devolve true se tratou.
//
//   GET  /api/swipe/estado[?full=1]   estado completo (full traz passport e conta, que batem na API)
//   POST /api/swipe/config            liga/desliga, modo sombra, critérios, tetos (validado)
//   POST /api/swipe/rodar             roda uma sessão agora (respeita o modo)
//   POST /api/swipe/replanejar        sorteia de novo os horários de hoje
//   GET  /api/swipe/decisoes          histórico de decisões com motivo
//   GET  /api/swipe/curtiram          quem já te curtiu (perfis completos)
//   GET  /api/swipe/fila              a fila de recomendação, já julgada (prévia seca)
//   POST /api/swipe/manual            curtir/passar uma pessoa na mão pela tela
//   POST /api/swipe/passport          troca de cidade, volta pro GPS real, salva cidade
//   GET  /api/tinder/perfil           perfil e preferências como o Tinder guarda
//   POST /api/tinder/perfil           escreve bio, cargo, escola, filtros
import { getSetting, setSetting, logEvent, listSwipes, listSwipeSessions, swipeSeen, recordSwipe, markSwipeSent } from '../core/db.mjs'
import { validaCriterios, criteriosAtuais, julgar } from './criteria.mjs'
import { validaTetos, estadoSwipe, rodaAgora, planejaDia, tetosAtuais, diaBrasilia, HISTOGRAMA, HORAS_PROIBIDAS } from './swipe.mjs'

// Guarda s_number/content_hash das pessoas que a tela mostrou. Sem isso o curtir manual
// não teria como ser enviado (o Tinder exige esses campos e eles só vêm no rec).
const recCache = new Map()
function guardaRecs(lista, fonte) {
  for (const r of lista) {
    const u = r.user || {}
    if (u._id) recCache.set(u._id, { sNumber: r.s_number, contentHash: r.content_hash, fonte, user: u, distance: r.distance_mi ?? null })
  }
  // não deixa crescer pra sempre
  if (recCache.size > 400) for (const k of [...recCache.keys()].slice(0, recCache.size - 400)) recCache.delete(k)
}

const R = 3958.8
const rad = (x) => (x * Math.PI) / 180
function distanciaMi(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
async function offsetDoPassport(api) {
  try {
    const w = await api.whereAmI()
    return { onde: w, offsetMi: w.isTraveling && w.realPos && w.travelPos ? distanciaMi(w.realPos, w.travelPos) : 0 }
  } catch { return { onde: null, offsetMi: 0 } }
}

// Cartão de pessoa pra tela: só o que a UI mostra, sem despejar o payload inteiro.
function cartaoPessoa(u, extra = {}) {
  return {
    id: u._id,
    nome: u.name || 'sem nome',
    idade: u.birth_date ? Math.floor((Date.now() - new Date(u.birth_date)) / 31557600000) : null,
    bio: u.bio || '',
    fotos: (u.photos || []).map((f) => f.url).filter(Boolean).slice(0, 6),
    verificada: (u.badges || []).some((b) => b.type === 'selfie_verified'),
    ativaRecente: !!u.recently_active,
    intencao: u.relationship_intent?.body_text || null,
    escola: (u.schools || [])[0]?.name || null,
    trabalho: (u.jobs || [])[0]?.title?.name || null,
    interesses: (u.user_interests?.selected_interests || []).map((i) => i.name).slice(0, 8),
    ...extra,
  }
}

export async function handleSwipeApi(ctx) {
  const { p, method, res, url, json, body, broadcast, api: getApi } = ctx
  if (!p.startsWith('/api/swipe') && p !== '/api/tinder/perfil') return false

  // Sem token não dá pra fazer nada com o Tinder: a tela precisa saber disso, não travar.
  const comApi = () => {
    const api = getApi()
    if (!api) { json(res, 409, { ok: false, erro: 'sem token do Tinder' }); return null }
    return api
  }

  // ---------------- estado ----------------
  if (p === '/api/swipe/estado' && method === 'GET') {
    const estado = estadoSwipe()
    estado.sessoes = listSwipeSessions(10)
    estado.decisoes = listSwipes({ limit: 60 })
    estado.projecao = validaTetos(estado.tetos).projecao
    if (url.searchParams.get('full') === '1') {
      const api = getApi()
      if (api) {
        const { onde, offsetMi } = await offsetDoPassport(api)
        estado.onde = onde ? { ...onde, offsetMi: Math.round(offsetMi) } : null
        try {
          const st = await api.accountState()
          const c = st.travel?.travel_location_info?.[0]
          estado.conta = {
            gold: (st.purchase?.purchases || []).some((x) => x.product_type === 'gold' && !st.purchase?.subscription_expired),
            assinaturaAte: (st.purchase?.purchases || [])[0]?.expire_date || null,
            likesRestantes: st.likes?.likes_remaining ?? null,
            superLikes: st.super_likes?.remaining ?? null,
            boosts: st.boost?.remaining ?? null,
            perfilCompleto: st.profile_meter?.percent_achieved ?? null,
            endereco: c ? [c.route?.long_name, c.administrative_area_level_2?.long_name, c.administrative_area_level_1?.short_name].filter(Boolean).join(', ') : null,
          }
        } catch (e) { estado.conta = { erro: e.message } }
      } else estado.semToken = true
    }
    return json(res, 200, { ok: true, estado }), true
  }

  // ---------------- configuração ----------------
  if (p === '/api/swipe/config' && method === 'POST') {
    const b = await body()
    const vc = validaCriterios(b.criterios || criteriosAtuais())
    const vt = validaTetos(b.tetos || tetosAtuais())
    const erros = [...vc.erros, ...vt.erros]
    if (erros.length) return json(res, 400, { ok: false, erros }), true

    setSetting('swipe_criteria', vc.criterios)
    setSetting('swipe_caps', vt.tetos)
    if (typeof b.ligado === 'boolean') setSetting('swipe_enabled', b.ligado)
    // Ligar o envio de verdade é o único passo irreversível daqui: exige confirmação
    // explícita do cliente, pra um clique errado no switch não virar swipe real.
    if (typeof b.sombra === 'boolean') {
      if (b.sombra === false && b.confirmaAoVivo !== true) return json(res, 400, { ok: false, erros: [{ campo: 'sombra', msg: 'sair do modo sombra exige confirmação' }] }), true
      setSetting('swipe_dry_run', b.sombra)
    }
    logEvent({ type: 'swipe_config', channel: 'tinder', detail: { ligado: getSetting('swipe_enabled', false), sombra: getSetting('swipe_dry_run', true) } })
    broadcast({ t: 'state' })
    return json(res, 200, { ok: true, estado: estadoSwipe(), avisos: [...vc.avisos, ...vt.avisos] }), true
  }

  // ---------------- rodar agora ----------------
  if (p === '/api/swipe/rodar' && method === 'POST') {
    const api = comApi(); if (!api) return true
    const b = await body()
    const estado = estadoSwipe()
    if (estado.rodando) return json(res, 409, { ok: false, erro: 'já tem uma sessão rodando' }), true
    if (estado.backoffAte) return json(res, 409, { ok: false, erro: 'em backoff até ' + new Date(estado.backoffAte).toLocaleString('pt-BR') }), true
    const sombra = b.sombra !== undefined ? !!b.sombra : estado.sombra
    if (!sombra && b.confirmaAoVivo !== true) return json(res, 400, { ok: false, erro: 'sessão ao vivo exige confirmação' }), true
    const tamanho = Math.min(Math.max(Number(b.tamanho) || 15, 1), 100)
    // não bloqueia a resposta: a sessão leva minutos por causa do ritmo humano
    rodaAgora({ api, tamanho, dryRun: sombra })
      .then((r) => { logEvent({ type: 'swipe_manual', channel: 'tinder', detail: r }); broadcast({ t: 'state' }) })
      .catch((e) => logEvent({ type: 'swipe_manual_err', channel: 'tinder', detail: e.message }))
    return json(res, 202, { ok: true, iniciada: true, tamanho, sombra }), true
  }

  if (p === '/api/swipe/replanejar' && method === 'POST') {
    const plano = planejaDia({ dia: diaBrasilia(), tetos: tetosAtuais() })
    setSetting('swipe_plan', plano)
    broadcast({ t: 'state' })
    return json(res, 200, { ok: true, plano }), true
  }

  // ---------------- histórico ----------------
  if (p === '/api/swipe/decisoes' && method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500)
    const decisao = url.searchParams.get('decisao') || null
    return json(res, 200, { ok: true, decisoes: listSwipes({ limit, decision: decisao }) }), true
  }

  // ---------------- filas ----------------
  if (p === '/api/swipe/curtiram' && method === 'GET') {
    const api = comApi(); if (!api) return true
    try {
      const lista = await api.fastMatch(30)
      guardaRecs(lista, 'fast_match')
      const { offsetMi } = await offsetDoPassport(api)
      const criterios = criteriosAtuais()
      const pessoas = lista.map((r) => {
        const j = julgar(r, criterios, { offsetMi, fonte: 'fast_match' })
        return cartaoPessoa(r.user || {}, { distancia: r.distance_mi ?? null, decisao: j.decisao, motivo: j.motivo, jaDecidida: swipeSeen((r.user || {})._id, { enviado: true }) })
      })
      return json(res, 200, { ok: true, pessoas }), true
    } catch (e) { return json(res, 502, { ok: false, erro: e.message }), true }
  }

  if (p === '/api/swipe/fila' && method === 'GET') {
    const api = comApi(); if (!api) return true
    try {
      const lista = await api.recs()
      guardaRecs(lista, 'recs')
      const { onde, offsetMi } = await offsetDoPassport(api)
      const criterios = criteriosAtuais()
      const pessoas = lista.map((r) => {
        const j = julgar(r, criterios, { offsetMi, fonte: 'recs' })
        return cartaoPessoa(r.user || {}, { distancia: r.distance_mi ?? null, decisao: j.decisao, motivo: j.motivo, jaDecidida: swipeSeen((r.user || {})._id, { enviado: true }) })
      })
      return json(res, 200, { ok: true, pessoas, onde, offsetMi: Math.round(offsetMi) }), true
    } catch (e) { return json(res, 502, { ok: false, erro: e.message }), true }
  }

  // ---------------- curtir/passar na mão ----------------
  if (p === '/api/swipe/manual' && method === 'POST') {
    const api = comApi(); if (!api) return true
    const b = await body()
    const alvo = recCache.get(b.userId)
    if (!alvo) return json(res, 404, { ok: false, erro: 'perfil não está mais na fila — recarregue a lista' }), true
    if (!['like', 'pass'].includes(b.decisao)) return json(res, 400, { ok: false, erro: 'decisão inválida' }), true
    if (swipeSeen(b.userId, { enviado: true })) return json(res, 409, { ok: false, erro: 'essa pessoa já foi deslizada' }), true

    const u = alvo.user
    recordSwipe({
      userId: b.userId, name: u.name, age: u.birth_date ? Math.floor((Date.now() - new Date(u.birth_date)) / 31557600000) : null,
      distance: alvo.distance, decision: b.decisao, reason: 'manual pelo painel', layer: 'manual',
      source: alvo.fonte, sessionId: null, payload: { s_number: alvo.sNumber },
    })
    try {
      const envio = b.decisao === 'like'
        ? await api.like({ userId: b.userId, sNumber: alvo.sNumber, photoId: (u.photos || [])[0]?.id, contentHash: alvo.contentHash })
        : await api.pass({ userId: b.userId, sNumber: alvo.sNumber })
      if (envio.ok) markSwipeSent(b.userId, { httpStatus: envio.status, matched: envio.match })
      logEvent({ type: 'swipe_manual_um', channel: 'tinder', detail: { nome: u.name, decisao: b.decisao, status: envio.status, match: !!envio.match } })
      broadcast({ t: 'state' })
      return json(res, envio.ok ? 200 : 502, { ok: envio.ok, match: !!envio.match, status: envio.status }), true
    } catch (e) { return json(res, 502, { ok: false, erro: e.message }), true }
  }

  // ---------------- passport ----------------
  if (p === '/api/swipe/passport' && method === 'POST') {
    const api = comApi(); if (!api) return true
    const b = await body()
    try {
      if (b.reset === true) {
        // Volta pro GPS real de verdade (o /travel só troca de cidade).
        const r = await api.travelReset()
        logEvent({ type: 'passport', channel: 'tinder', detail: 'reset pro GPS real' })
        broadcast({ t: 'state' })
        return json(res, r.ok ? 200 : 502, { ok: r.ok, onde: await api.whereAmI() }), true
      }
      const lat = Number(b.lat), lon = Number(b.lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return json(res, 400, { ok: false, erro: 'coordenadas inválidas' }), true
      }
      const antes = await api.whereAmI().catch(() => null)
      const r = await api.travelTo({ lat, lon })
      if (!r.ok) return json(res, 502, { ok: false, erro: 'Tinder recusou (status ' + r.status + ')' }), true
      // guarda a cidade na lista de salvas (sem duplicar coordenada)
      if (b.salvar && b.nome) {
        const cidades = getSetting('swipe_cities', [])
        if (!cidades.some((c) => Math.abs(c.lat - lat) < 0.01 && Math.abs(c.lon - lon) < 0.01)) {
          cidades.push({ nome: String(b.nome).slice(0, 40), lat, lon })
          setSetting('swipe_cities', cidades.slice(0, 20))
        }
      }
      logEvent({ type: 'passport', channel: 'tinder', detail: { de: antes?.city || null, para: b.nome || `${lat},${lon}` } })
      broadcast({ t: 'state' })
      return json(res, 200, { ok: true, onde: await api.whereAmI() }), true
    } catch (e) { return json(res, 502, { ok: false, erro: e.message }), true }
  }

  if (p === '/api/swipe/cidades' && method === 'POST') {
    const b = await body()
    const cidades = (Array.isArray(b.cidades) ? b.cidades : [])
      .filter((c) => Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lon)) && c.nome)
      .map((c) => ({ nome: String(c.nome).slice(0, 40), lat: Number(c.lat), lon: Number(c.lon) }))
      .slice(0, 20)
    setSetting('swipe_cities', cidades)
    return json(res, 200, { ok: true, cidades }), true
  }

  // ---------------- perfil do Tinder ----------------
  if (p === '/api/tinder/perfil' && method === 'GET') {
    const api = comApi(); if (!api) return true
    try {
      const st = await api.accountState()
      const u = st.user || {}
      return json(res, 200, {
        ok: true,
        perfil: {
          nome: u.name, bio: u.bio || '',
          cargo: (u.jobs || [])[0]?.title?.name || '', empresa: (u.jobs || [])[0]?.company?.name || '',
          escola: (u.schools || [])[0]?.name || '',
          idadeMin: u.age_filter_min, idadeMax: u.age_filter_max, raio: u.distance_filter,
          descobrivel: !!u.discoverable, topPicks: !!u.top_picks_discoverable,
          fotos: (u.photos || []).map((f) => f.url).filter(Boolean),
          completo: st.profile_meter?.percent_achieved ?? null,
          falta: (st.profile_meter?.incomplete_components || []).map((c) => ({ chave: c.key, ganho: c.display_text || null })),
        },
      }), true
    } catch (e) { return json(res, 502, { ok: false, erro: e.message }), true }
  }

  if (p === '/api/tinder/perfil' && method === 'POST') {
    const api = comApi(); if (!api) return true
    const b = await body()
    const campos = {}
    const erros = []
    if (typeof b.bio === 'string') {
      if (b.bio.length > 500) erros.push({ campo: 'bio', msg: 'bio passa de 500 caracteres' })
      else campos.bio = b.bio
    }
    if (b.idadeMin != null || b.idadeMax != null) {
      const min = Math.min(Math.max(Math.round(Number(b.idadeMin ?? 18)), 18), 100)
      const max = Math.min(Math.max(Math.round(Number(b.idadeMax ?? 26)), 18), 100)
      if (min > max) erros.push({ campo: 'idade', msg: 'idade mínima maior que a máxima' })
      else { campos.age_filter_min = min; campos.age_filter_max = max }
    }
    if (b.raio != null) {
      const r = Math.round(Number(b.raio))
      if (!Number.isFinite(r) || r < 1 || r > 100) erros.push({ campo: 'raio', msg: 'raio tem que ser de 1 a 100 milhas' })
      else campos.distance_filter = r
    }
    if (typeof b.descobrivel === 'boolean') campos.discoverable = b.descobrivel
    if (typeof b.topPicks === 'boolean') campos.top_picks_discoverable = b.topPicks
    if (erros.length) return json(res, 400, { ok: false, erros }), true
    if (!Object.keys(campos).length) return json(res, 400, { ok: false, erro: 'nada pra salvar' }), true
    try {
      const r = await api.updateProfile(campos)
      if (!r.ok) return json(res, 502, { ok: false, erro: 'Tinder recusou (status ' + r.status + ')' }), true
      logEvent({ type: 'tinder_perfil', channel: 'tinder', detail: Object.keys(campos).join(',') })
      return json(res, 200, { ok: true }), true
    } catch (e) { return json(res, 502, { ok: false, erro: e.message }), true }
  }

  return false
}
