// AS DMs DO INSTAGRAM PELO DADO, NÃO PELO DESENHO DA TELA.
//
// Até 28/07/2026 a leitura era scraping de DOM (`dom.mjs`: varrer `div[dir="auto"]` e decidir
// direção pela posição X da bolha). Aquilo funciona, mas lê o DESENHO — e desenho não carrega
// identidade. Os quatro defeitos que vieram junto, todos vistos na mesma conversa real:
//
//   1. CITAÇÃO VIRA MENSAGEM. Ela responde citando ("Replied to you") e o texto citado é lido
//      como uma bolha nova, com a direção de quem citou. "De bikeee olha ela" ficou gravado
//      duas vezes: outgoing (a real, dele) e incoming (a citação, dela).
//   2. HORÁRIO INVENTADO E INSTÁVEL. O DOM só dá "18:57" ou "ontem"; o resto era inferência,
//      recalculada a cada sync. A MESMA mensagem mudou de horário três vezes em três leituras.
//   3. SEM IDENTIDADE. O id era `ig:<thread>:<índice>:<ts-do-sync>` — posicional e temporal.
//      Como a costura do histórico casa por `direção|texto`, uma leitura parcial (o Instagram
//      só renderiza o que está perto da viewport) desalinhava e REINSERIA mensagens antigas
//      mais adiante, com data nova.
//   4. ÁUDIO E STORY VIRAM TEXTO. `voice_media` e `reel_share` eram gravados como texto comum.
//
// Aqui cada um desses some por construção: o Instagram entrega `item_id`, `timestamp` em
// microssegundos, `is_sent_by_viewer`, `item_type` e `replied_to_message` como CAMPO.
//
// O conhecimento do DOM não foi jogado fora — está em docs/ENTENDIMENTO-IG-DOM.md, porque o
// ENVIO continua por lá e porque a API pode fechar sem aviso.
import { getSetting, logEvent } from '../core/db.mjs'
import { connectBrowser, firstContext } from '../browser/chrome.mjs'

const APP_ID = '936619743392459'
const BASE = 'https://www.instagram.com/api/v1/direct_v2'
const TIMEOUT_MS = 20000

// O cookie vive no PERFIL DO CHROME (o login foi feito lá), não no nosso banco. Ler daqui é
// uma operação de leitura do contexto: não cria aba, não navega, não mexe na página que o
// sync por DOM e o Badoo usam. Sem isso seria preciso um segundo login.
let cache = { ts: 0, cookie: null, csrf: null }
const CACHE_MS = 5 * 60 * 1000

export async function sessaoDoChrome({ forcar = false } = {}) {
  if (!forcar && cache.cookie && Date.now() - cache.ts < CACHE_MS) return cache
  const browser = await connectBrowser()
  const ctx = firstContext(browser)
  if (!ctx) throw new Error('o Chrome da VM não tem contexto aberto')
  const cookies = await ctx.cookies('https://www.instagram.com')
  if (!cookies.length) throw new Error('sem cookies do Instagram no Chrome (faça a importação de sessão)')
  cache = {
    ts: Date.now(),
    cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    csrf: (cookies.find((c) => c.name === 'csrftoken') || {}).value || '',
  }
  return cache
}

// Os `sec-fetch-*` NÃO são enfeite: sem eles a resposta é `400 SecFetch Policy violation`, que
// não parece um erro de header nenhum. Foi o que travou a primeira sonda.
function headers({ cookie, csrf }, referer) {
  return {
    cookie,
    'user-agent': getSetting('ig_ua', null) || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'x-ig-app-id': APP_ID,
    'x-csrftoken': csrf,
    'x-ig-www-claim': '0',
    'x-requested-with': 'XMLHttpRequest',
    accept: '*/*',
    'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
    origin: 'https://www.instagram.com',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    referer: referer || 'https://www.instagram.com/direct/inbox/',
  }
}

async function pegar(url, { referer = null, forcarSessao = false } = {}) {
  const s = await sessaoDoChrome({ forcar: forcarSessao })
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let r
  try { r = await fetch(url, { headers: headers(s, referer), signal: ctrl.signal }) }
  finally { clearTimeout(t) }
  const txt = await r.text()
  if (r.status === 401 || r.status === 403) {
    // sessão velha em cache é a causa mais provável; uma segunda chance com cookie fresco
    if (!forcarSessao) return pegar(url, { referer, forcarSessao: true })
    throw new Error(`Instagram recusou (${r.status}) — a sessão do Chrome caiu`)
  }
  if (r.status !== 200) throw new Error(`Instagram respondeu ${r.status}: ${txt.slice(0, 120)}`)
  try { return JSON.parse(txt) } catch { throw new Error('resposta do Instagram não é JSON') }
}

// ---------------------------------------------------------------- normalização
// O formato que o resto do vendas-multicanal já entende (o mesmo que o DOM produzia), mas agora com o que só
// o dado tem: id de verdade, hora de verdade, tipo e citação.
export function normalizarItem(item) {
  if (!item || !item.item_id) return null
  const tipo = item.item_type
  // `is_sent_by_viewer` vem do servidor. O DOM decidia isso pela posição horizontal da bolha,
  // que é a razão de a citação entrar com a direção errada.
  const dir = item.is_sent_by_viewer ? 'out' : 'in'
  const ts = Math.round(Number(item.timestamp || 0) / 1000)   // microssegundos -> ms

  let text = null
  let midia = null
  if (tipo === 'text') text = String(item.text || '')
  else if (tipo === 'reel_share') {
    // resposta a story/reel: o que a PESSOA escreveu está em reel_share.text; o resto é o post
    text = String(item.reel_share?.text || '')
    const m = item.reel_share?.media
    const src = m?.image_versions2?.candidates?.[0]?.url || m?.video_versions?.[0]?.url || null
    if (src) midia = { kind: m?.video_versions?.length ? 'video' : 'imagem', src }
    if (!text) text = '[respondeu um story]'
  } else if (tipo === 'voice_media') {
    const src = item.voice_media?.media?.audio?.audio_src || null
    midia = src ? { kind: 'audio', src } : null
    text = '[áudio]'
  } else if (tipo === 'media' || tipo === 'raven_media') {
    const m = item.media || item.visual_media?.media
    const src = m?.image_versions2?.candidates?.[0]?.url || m?.video_versions?.[0]?.url || null
    if (src) midia = { kind: m?.video_versions?.length ? 'video' : 'imagem', src }
    text = midia?.kind === 'video' ? '[vídeo]' : '[imagem]'
  } else if (tipo === 'animated_media') { text = '[gif]' }
  else if (tipo === 'like') { text = '❤' }
  else if (tipo === 'link') { text = String(item.link?.text || item.link?.link_context?.link_url || '[link]') }
  else if (tipo === 'placeholder') return null    // "mensagem indisponível": não é conteúdo
  else text = `[${tipo}]`

  return {
    id: String(item.item_id),
    dir,
    text,
    ts,
    tipo,
    midia,
    // A CITAÇÃO É METADADO, NUNCA MENSAGEM. É o defeito nº 1 morrendo na origem.
    citouId: item.replied_to_message?.item_id ? String(item.replied_to_message.item_id) : null,
    citouTexto: item.replied_to_message?.text ? String(item.replied_to_message.text) : null,
  }
}

const ordenar = (msgs) => msgs.slice().sort((a, b) => a.ts - b.ts)

// ---------------------------------------------------------------- inbox
// Uma chamada devolve as conversas E as últimas mensagens de cada uma — é o sync inteiro do
// poll leve num round-trip, contra ~10s de navegação por conversa no caminho do DOM.
export async function inbox({ limite = 20, mensagensPorConversa = 20 } = {}) {
  const j = await pegar(`${BASE}/inbox/?limit=${limite}&thread_message_limit=${mensagensPorConversa}`)
  const meuId = String(j?.viewer?.pk || '')
  const conversas = (j?.inbox?.threads || []).map((t) => {
    const users = t.users || []
    return {
      // ATENÇÃO: este NÃO é o id que aparece na URL /direct/t/<id>/. São numerações
      // diferentes, e usar o da URL na API devolve um 500 enganoso. O casamento com o que já
      // está no banco é pelo @username.
      apiThreadId: String(t.thread_id),
      threadV2Id: t.thread_v2_id ? String(t.thread_v2_id) : null,
      titulo: t.thread_title || null,
      grupo: !!t.is_group || users.length > 1,
      username: users[0]?.username || null,
      nome: users[0]?.full_name || null,
      avatar: users[0]?.profile_pic_url || null,
      naoLidas: Number(t.read_state || 0) > 0 || !!t.has_newer,
      mensagens: ordenar((t.items || []).map(normalizarItem).filter(Boolean)),
    }
  })
  return { meuId, conversas }
}

// Histórico de uma conversa, com paginação. `paginas` limita o quanto se puxa de uma vez —
// puxar tudo de uma conversa antiga são dezenas de chamadas.
export async function thread(apiThreadId, { limite = 40, paginas = 1 } = {}) {
  let cursor = null
  let todas = []
  let meuId = ''
  for (let p = 0; p < Math.max(1, paginas); p++) {
    const qs = `limit=${limite}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const j = await pegar(`${BASE}/threads/${apiThreadId}/?${qs}`)
    const t = j?.thread || {}
    meuId = String(t.viewer_id || meuId)
    todas = todas.concat((t.items || []).map(normalizarItem).filter(Boolean))
    cursor = t.oldest_cursor || null
    if (!cursor || !t.has_older) break
  }
  return { meuId, mensagens: ordenar(todas) }
}

// ---------------------------------------------------------------- post público
// A MESMA sessão serve pra media info de um POST (reel, foto, carrossel, story), que mora em
// outro caminho da API. É por aqui que "me baixa esse vídeo" vira dado — ver src/midia/video.mjs.
// O referer é o do site, não o da inbox: o post não é uma conversa.
export async function mediaInfo(mediaId) {
  const id = String(mediaId || '').replace(/\D/g, '')
  if (!id) throw new Error('id de mídia inválido')
  const j = await pegar(`https://www.instagram.com/api/v1/media/${id}/info/`, { referer: 'https://www.instagram.com/' })
  const item = j?.items?.[0]
  // Post apagado, privado ou de conta que bloqueou vem como lista vazia, com 200. Sem esta
  // linha o erro apareceria lá na frente, como "post vazio", sem dizer o que houve.
  if (!item) throw new Error('o Instagram não devolveu esse post (apagado, privado ou fora do alcance da sua conta)')
  return item
}

// A sessão está de pé? Barata (limite 1) e honesta: distingue "não configurado" de "caiu".
export async function checarApi() {
  try {
    const j = await pegar(`${BASE}/inbox/?limit=1`)
    return { ok: true, meuId: String(j?.viewer?.pk || ''), conversas: (j?.inbox?.threads || []).length }
  } catch (e) {
    logEvent({ type: 'ig_api_indisponivel', detail: e.message })
    return { ok: false, motivo: e.message }
  }
}
