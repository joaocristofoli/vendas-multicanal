// Meu Patrocínio pelo DADO, não pela tela.
//
// O mapa de endpoints saiu de duas capturas de rede (HAR) do app deles, 03/08/2026. As
// capturas vieram SANITIZADAS: os endpoints e os corpos ENVIADOS estão lá (foi assim que se
// achou o formato do login e do envio), mas os corpos de RESPOSTA foram removidos. O formato
// de LEITURA foi então descoberto com sessão real (03/08/2026), nunca chutado — está no fim
// deste arquivo, com os campos reais.
//
// A auth é um TOKEN JWT (flask-jwt-extended) de vida longa (4,9 anos) — ver o login abaixo.
//
// DUAS NUMERAÇÕES DIFERENTES, e confundir as duas manda mensagem pra pessoa errada:
//   - peer_id (initiator/interlocutor) -> quem é a pessoa. LEITURA usa ele.
//   - conversation_id                  -> a conversa. ENVIO usa ele.
// Confirmado ao vivo: numa conversa os dois números foram 898780 (conversa) e 11883263
// (peer) — diferentes. Tratar como campo único manda mensagem pra pessoa errada.
import crypto from 'node:crypto'
import { getSetting, setSetting, logEvent } from '../core/db.mjs'

const BASE = 'https://api.meupatrocinio.com'
const SITE = 'https://app.meupatrocinio.com'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const TIMEOUT_MS = 20000

// A AUTENTICAÇÃO É UM TOKEN JWT (flask-jwt-extended), não cookie — descoberto em 03/08/2026:
// os cookies do site são só analytics. O login devolve { token, expires_in }, e o token
// VALE 4,9 ANOS (expires_in = 155520000s). O `refresh_token` da resposta vem VAZIO — este
// serviço não usa refresh porque o próprio token de acesso é de vida longuíssima. Ou seja: um
// login e a sessão dura anos. Não há o que renovar; se um dia der 401, é logar de novo (a
// senha está guardada nos settings pelo próprio login, então é automático).
//
// Login por senha aqui é aceitável (ao contrário do Instagram) porque o Meu Patrocínio
// respondeu 200 do IP da VM, sem verificação. Se um dia passar a barrar, isto vira o mesmo
// problema do IG e o caminho muda.
const baseHeaders = () => ({
  'user-agent': getSetting('mp_ua', null) || UA,
  accept: 'application/json, text/plain, */*',
  'X-MP-Request-Origin': '0',
  'X-MP-Version': getSetting('mp_version', 'v1.32.0.2049'),
  origin: SITE, referer: SITE + '/',
})

export function meuId() { return getSetting('mp_meu_id', null) }
export function estaConectado() { return !!getSetting('mp_token', null) }

// Login com email+senha. Guarda os dois tokens. Nunca loga a senha.
export async function logar({ email, password }) {
  if (!email || !password) throw new Error('faltam email/senha')
  const r = await fetch(BASE + '/login-new', {
    method: 'POST', headers: { ...baseHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, client_version: 'web' }),
  })
  if (r.status !== 200) throw new Error(`login recusado (${r.status})`)
  const j = await r.json()
  if (!j.token) throw new Error('login sem token na resposta')
  setSetting('mp_token', j.token)
  setSetting('mp_token_at', Date.now())
  if (j.expires_in) setSetting('mp_expires_in', j.expires_in)
  // A senha fica guardada pra reconexão automática num 401 (o token é de vida longa, mas se
  // for revogado do lado deles, dá pra logar de novo sem incomodar ninguém). É o mesmo modelo
  // do Tinder, que guarda o token da sessão. Fica só nos settings da VM, nunca em código.
  setSetting('mp_login', { email, password })
  logEvent({ type: 'mp_conectado', channel: 'meupatrocinio', detail: `login ok (token vale ${Math.round((j.expires_in || 0) / 86400)} dias)` })
  return { ok: true }
}

// Sem refresh_token neste serviço (a resposta dele vem vazia): renovar é LOGAR DE NOVO, com a
// senha guardada. Só acontece se o token de vida longa for revogado do lado deles.
async function renovar() {
  const cred = getSetting('mp_login', null)
  if (!cred || !cred.email) return false
  try { await logar(cred); return true } catch { return false }
}

function headers() {
  const token = getSetting('mp_token', null)
  return { ...baseHeaders(), ...(token ? { authorization: 'Bearer ' + token } : {}) }
}

async function pegar(caminho, { metodo = 'GET', corpo = null, jaRenovou = false } = {}) {
  if (!getSetting('mp_token', null)) throw new Error('Meu Patrocínio não conectado (faça login)')
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let r
  try {
    r = await fetch(BASE + caminho, {
      method: metodo,
      headers: corpo ? { ...headers(), 'content-type': 'application/json' } : headers(),
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: ctrl.signal,
    })
  } finally { clearTimeout(t) }
  // O token é de vida longa, então 401/422 é raro (revogação do lado deles). Quando acontece,
  // loga de novo com a senha guardada, UMA vez — jaRenovou trava a recursão, sem loop.
  if ((r.status === 401 || r.status === 422) && !jaRenovou) {
    if (await renovar()) return pegar(caminho, { metodo, corpo, jaRenovou: true })
    throw new Error(`Meu Patrocínio recusou (${r.status}) e o novo login não resolveu — a senha guardada pode ter mudado`)
  }
  const txt = await r.text()
  if (r.status === 204) return null
  if (r.status !== 200 && r.status !== 206) throw new Error(`Meu Patrocínio respondeu ${r.status}: ${txt.slice(0, 120)}`)
  try { return JSON.parse(txt) } catch { throw new Error('resposta não é JSON') }
}

// ---------------------------------------------------------------- os endpoints
// Lista de conversas. O id da URL é o da PRÓPRIA dona (veio assim na captura).
export const listaDeConversas = (pagina = 1) => pegar(`/chat/${meuId()}?page=${pagina}`)
// Mensagens de uma conversa, por PEER.
export const mensagensDoPeer = (peerId, pagina = 1) => pegar(`/chat/conversation/peer/${peerId}/messages?page=${pagina}`)
// A conversa de um peer (é daqui que sai o conversation_id de verdade, que o envio usa).
export const conversaDoPeer = (peerId) => pegar(`/chat/conversation/peer/${peerId}`)
// Mensagens por id, em lote.
export const mensagensPorId = (ids) => pegar('/chat/messages/bulk?' + ids.map((i) => `ids[]=${encodeURIComponent(i)}`).join('&'))
export const naoLidas = () => pegar('/conversations/count-unread-messages')
// Perfis em lote (nome, idade, cidade, foto) por profile_id. É o que dá NOME à conversa em vez
// de "contato <id>". Aceita vários ids de uma vez.
export const perfisEmLote = (ids) => pegar('/profile/bulk?' + ids.map((i) => `ids[]=${encodeURIComponent(i)}`).join('&'))
export const meuPerfil = () => pegar('/me')

// ENVIO. `conversationId` — NUNCA o peer. O `uuid` é o comprovante de idempotência do lado
// deles: reenviar com o mesmo uuid não duplica, e é o que a regra do projeto pede.
export async function enviarMensagem({ conversationId, texto, uuid }) {
  if (!conversationId) throw new Error('sem conversationId: enviar sem destinatário explícito não acontece aqui')
  const limpo = String(texto || '').trim()
  if (!limpo) throw new Error('texto vazio')
  const r = await pegar(`/conversations/${conversationId}/messages`, {
    metodo: 'POST',
    corpo: { text: limpo, uuid: uuid || crypto.randomUUID() },
  })
  logEvent({ type: 'mp_enviado', channel: 'meupatrocinio', detail: `conversa ${conversationId}` })
  return r
}
// "Digitando" — mesma numeração do envio.
export const avisarDigitando = (conversationId) => pegar(`/conversations/${conversationId}/writing`, { metodo: 'POST', corpo: {} }).catch(() => null)

// ---------------------------------------------------------------- o formato (DESCOBERTO 03/08)
// Já não se adivinha nada: o formato abaixo veio de sessão real. A dona é `profile_id`; a
// lista é paginada (Laravel, `data[]`); cada conversa tem os DOIS lados (initiator/interlocutor)
// e o conversation_id; cada mensagem traz message_id, sender_id, text, created_at.

// O profile_id da dona (é a chave que identifica "eu" nas conversas). Cacheia no setting.
export async function meuProfileId() {
  const cache = getSetting('mp_meu_id', null)
  if (cache) return String(cache)
  const me = await meuPerfil()
  if (me && me.profile_id) { setSetting('mp_meu_id', String(me.profile_id)); return String(me.profile_id) }
  return null
}

// O peer (a OUTRA pessoa) de uma conversa, dado quem sou eu.
export function peerDaConversa(conversa, meuId) {
  return String(conversa.initiator_id) === String(meuId) ? String(conversa.interlocutor_id) : String(conversa.initiator_id)
}

// Uma mensagem normalizada, no formato que o resto do vendas-multicanal entende. direction pelo
// sender_id (dado do servidor), nunca por posição de tela.
export function normalizarMensagem(m, meuId) {
  if (!m || !m.message_id) return null
  return {
    id: String(m.message_id),
    direction: String(m.sender_id) === String(meuId) ? 'outgoing' : 'incoming',
    text: String(m.text || ''),
    ts: m.created_at ? Date.parse(m.created_at) || Date.now() : Date.now(),
  }
}
