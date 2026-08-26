// Cliente da API do Badoo. Um endpoint só (`mwebapi.phtml`) com um envelope de mensagens
// numeradas — nada de REST. Mapeado do HAR real do dono em docs/ENTENDIMENTO-BADOO.md.
//
// Autenticação é por COOKIE de sessão (não existe token avulso como o do Tinder), então o
// caminho é o mesmo do Instagram: os cookies do navegador logado dele são importados e
// guardados; aqui a gente só os manda em toda chamada.
import crypto from 'node:crypto'

const BASE = 'https://badoo.com/mwebapi.phtml'

// Os tipos que interessam, com o NOME DO COMANDO que vai na query string da URL
// (`/mwebapi.phtml?SERVER_GET_USER_LIST`). O nome não é decoração: sem ele o servidor
// responde "Unknown command client_response" e recusa a chamada.
export const TIPO = {
  APP_STARTUP: 2,          // SERVER_APP_STARTUP     handshake da sessão
  FOLDER_REQUEST: 157,     // SERVER_GET_FOLDER      contadores das pastas
  LISTA_CONVERSAS: 245,    // SERVER_GET_USER_LIST   (folder_id 49 = Mensagens)
  ABRIR_CONVERSA: 102,     // SERVER_OPEN_CHAT
  MANDAR: 104,             // CHAT_MESSAGE
  PERFIL: 403,             // SERVER_GET_USER
  MARCAR_LIDA: 555,        // CHAT_MESSAGE_READ
}
const COMANDO = {
  2: 'SERVER_APP_STARTUP',
  157: 'SERVER_GET_FOLDER',
  245: 'SERVER_GET_USER_LIST',
  102: 'SERVER_OPEN_CHAT',
  104: 'CHAT_MESSAGE',
  403: 'SERVER_GET_USER',
  555: 'CHAT_MESSAGE_READ',
}

// Respostas que a gente lê.
export const RESPOSTA = {
  LISTA: 246,              // client_user_list
  CONVERSA: 103,           // client_open_chat
  ENVIADA: 151,            // chat_message_received  (o comprovante)
  NOTICE: 138,             // person_notice (contadores; ruído pra nós)
  LOGIN_OK: 17,            // client_login_success
  ERRO: 124,               // server_error_message — o Badoo devolve o motivo em texto
  ERRO_ALT: 1,             // o mesmo erro chega como tipo 1 em algumas rotas
}

export const PASTA_MENSAGENS = 49

// A projeção de campos que a lista de conversas devolve. Os números vieram do HAR (é o
// que o site pede); mexer aqui muda o que volta em cada pessoa.
const PROJECAO_LISTA = [200, 230, 700, 340, 650, 640, 280, 583, 580, 250, 610, 560, 611, 759, 630, 270, 330, 871, 920, 820, 830, 1120, 1423, 1436, 643, 1435, 1434]
const PROJECAO_CONVERSA = [210, 230, 610, 580, 290, 583, 250, 100, 570, 200, 331, 330, 340, 560, 650, 930, 1436, 760, 761, 370, 431, 700, 410, 310, 490, 311]

const pingback = () => crypto.randomBytes(16).toString('hex')

// RITMO. O Badoo derruba rajada: duas chamadas coladas voltam com erro 9012 (mensagem
// vazia, com `error_eta` em ms — a dica de espera). Espaçadas, passam. Descoberto na marra
// em 25/07/2026: o mesmo pedido falhou em sequência e funcionou sozinho.
// Uma fila global serializa tudo e garante o intervalo mínimo entre chamadas.
const INTERVALO_MS = Number(process.env.TIM_BADOO_INTERVALO_MS || 900)
let ultimaChamada = 0
let fila = Promise.resolve()
const dormir = (ms) => new Promise((r) => setTimeout(r, ms))
function naFila(fn) {
  const proxima = fila.then(async () => {
    const espera = INTERVALO_MS - (Date.now() - ultimaChamada)
    if (espera > 0) await dormir(espera)
    try { return await fn() } finally { ultimaChamada = Date.now() }
  })
  fila = proxima.catch(() => {})   // um erro não trava a fila
  return proxima
}

// Erro que vale reenviar: o 9012 é limite de ritmo, não recusa de verdade.
const ehRitmo = (e) => /\b9012\b/.test(String(e && e.message))

// Uma chamada ao Badoo. `corpo` é o objeto interno (ex. { server_get_user_list: {...} }).
// Devolve o array `body` da resposta (as mensagens de volta), ou lança com motivo legível.
export async function chamar(opts) {
  const tentativas = opts.tentativas == null ? 3 : opts.tentativas
  let ultimoErro
  for (let i = 0; i < tentativas; i++) {
    try { return await naFila(() => chamarUmaVez(opts)) }
    catch (e) {
      ultimoErro = e
      if (!ehRitmo(e) || i === tentativas - 1) throw e
      await dormir(1200 * (i + 1))   // o servidor pediu calma: dá calma
    }
  }
  throw ultimoErro
}

async function chamarUmaVez({ cookies, ua, tipo, corpo, referer, timeoutMs = 20000 }) {
  if (!cookies) throw new Error('sem sessão do Badoo (cookies não importados)')
  // O envelope repete o tipo da operação (não é um número fixo: eu tinha chutado 6004 e o
  // servidor respondeu "Unknown command client_response"). `is_background` vai como o site manda.
  const envelope = {
    $gpb: 'badoo.bma.BadooMessage',
    // Sem `$gpb` no item do corpo: o site não manda, e mandar faz o servidor recusar com
    // erro 9012 sem mensagem. Descoberto comparando com o replay exato do HAR (25/07/2026).
    body: [{ message_type: tipo, ...corpo }],
    message_id: Math.floor(Math.random() * 1000) + 1,
    message_type: tipo,
    version: 1,
    is_background: false,
  }
  const url = BASE + (COMANDO[tipo] ? '?' + COMANDO[tipo] : '')
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  let r
  try {
    r = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'accept': '*/*',
        'cookie': cookies,
        'user-agent': ua,
        'x-user-agent': ua,
        'x-message-type': String(tipo),
        'x-pingback': pingback(),
        'x-use-session-cookie': '1',
        'origin': 'https://badoo.com',
        'referer': referer || 'https://badoo.com/pt/connections',
        'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify(envelope),
    })
  } finally { clearTimeout(t) }

  if (!r.ok) throw new Error(`Badoo respondeu ${r.status}`)
  const texto = await r.text()
  let json
  try { json = JSON.parse(texto) } catch { throw new Error('resposta do Badoo não é JSON: ' + texto.slice(0, 120)) }
  const body = Array.isArray(json.body) ? json.body : []
  const erro = body.find((b) => b.server_error_message || b.message_type === RESPOSTA.ERRO)
  if (erro) {
    const m = erro.server_error_message || {}
    const cod = m.error_code || m.type || '?'
    throw new Error(`Badoo recusou [${cod}]: ${m.error_message || 'sem mensagem'}${m.error_id ? ' (' + m.error_id + ')' : ''}`)
  }
  return body
}

// Acha a primeira mensagem de um tipo dentro da resposta.
export const achar = (body, tipo) => (body || []).find((b) => b.message_type === tipo) || null

// ---------------------------------------------------------------- as 4 operações

// Lista as conversas (pasta Mensagens). Paginado: `direction` 1 = mais recentes primeiro.
// Devolve { pessoas, total } — pessoa = { user_id, name, is_unread, sort_timestamp, foto }.
export async function listarConversas({ cookies, ua, quantidade = 50, pasta = PASTA_MENSAGENS }) {
  const body = await chamar({
    cookies, ua, tipo: TIPO.LISTA_CONVERSAS,
    corpo: {
      server_get_user_list: {
        $gpb: 'badoo.bma.ServerGetUserList',
        folder_id: pasta,
        user_field_filter: { $gpb: 'badoo.bma.UserFieldFilter', projection: PROJECAO_LISTA },
        source: 127,
        preferred_count: quantidade,
        direction: 1,
      },
    },
  })
  const lista = achar(body, RESPOSTA.LISTA)
  const secoes = lista?.client_user_list?.section || []
  const pessoas = []
  for (const s of secoes) for (const u of s.users || []) pessoas.push(normalizarPessoa(u))
  return { pessoas, total: lista?.client_user_list?.total_count ?? pessoas.length }
}

// Abre uma conversa. É aqui que (esperamos) vêm as mensagens — o HAR só capturou uma
// conversa NOVA, sem histórico, então o formato das mensagens ainda vai ser confirmado ao
// vivo pelo tools/badoo-probe.mjs. Devolve o objeto client_open_chat cru + o normalizado.
export async function abrirConversa({ cookies, ua, chatId }) {
  const body = await chamar({
    cookies, ua, tipo: TIPO.ABRIR_CONVERSA,
    referer: `https://badoo.com/messages/${chatId}`,
    corpo: {
      server_open_chat: {
        $gpb: 'badoo.bma.ServerOpenChat',
        chat_instance_id: chatId,
        folder_id: PASTA_MENSAGENS,
        context: 127,
        user_field_filter: { $gpb: 'badoo.bma.UserFieldFilter', projection: PROJECAO_CONVERSA },
      },
    },
  })
  const chat = achar(body, RESPOSTA.CONVERSA)?.client_open_chat || null
  return { chat, body }
}

// Manda mensagem. `de` e `para` são os person_id opacos do Badoo.
// Devolve { ok, comprovante } — o comprovante é o `chat_message_received` (151).
export async function mandar({ cookies, ua, de, para, texto }) {
  const body = await chamar({
    cookies, ua, tipo: TIPO.MANDAR,
    referer: `https://badoo.com/messages/${para}`,
    corpo: {
      chat_message: {
        $gpb: 'badoo.bma.ChatMessage',
        from_person_id: de,
        to_person_id: para,
        message_type: 1,
        mssg: String(texto),
        read: false,
        uid: 'TEMP_ID:' + Date.now(),
        context: 127,
      },
    },
  })
  const rec = achar(body, RESPOSTA.ENVIADA)
  return { ok: !!rec, comprovante: rec?.chat_message_received || rec || null, body }
}

// Perfil de uma pessoa (nome, idade, cidade, fotos, bio).
export async function perfil({ cookies, ua, userId }) {
  const body = await chamar({
    cookies, ua, tipo: TIPO.PERFIL,
    corpo: {
      server_get_user: {
        $gpb: 'badoo.bma.ServerGetUser',
        user_id: userId,
        user_field_filter: { $gpb: 'badoo.bma.UserFieldFilter', projection: PROJECAO_CONVERSA },
      },
    },
  })
  return achar(body, 404)?.user || achar(body, 403)?.user || null
}

// Uma pessoa da lista, no formato que o resto do vendas-multicanal entende.
function normalizarPessoa(u) {
  const foto = u.profile_photo?.preview_url || u.profile_photo?.large_url || null
  return {
    id: u.user_id,
    nome: u.name || null,
    idade: u.age || null,
    naoLida: !!u.is_unread,
    match: !!u.is_match,
    removida: !!u.is_removed,
    ts: u.sort_timestamp ? u.sort_timestamp * 1000 : null,
    previa: u.display_message || null,
    foto: foto ? (foto.startsWith('//') ? 'https:' + foto : foto) : null,
    cru: u,
  }
}
