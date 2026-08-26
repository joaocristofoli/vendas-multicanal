// Sessão do Telegram: login como a PRÓPRIA DONA (MTProto), não como bot.
//
// POR QUE NÃO É BOT. Um bot do Telegram só enxerga quem procurou o bot e apertou "iniciar",
// e fala como um bot. Ele nunca veria as DMs dela nem responderia como ela. O vendas-multicanal
// representa uma pessoa, então o login é o mesmo tipo do WhatsApp: a conta dela.
//
// O QUE ISSO EXIGE, e não tem como contornar:
//   - api_id e api_hash, criados em my.telegram.org logando com o número DELA;
//   - o número dela;
//   - o código que o Telegram manda no app na hora do login (só ela recebe);
//   - a senha de duas etapas, se ela tiver.
// Nada disso pode ser inventado aqui, e por isso a conexão é um passo com ela junto.
//
// A sessão vira uma STRING e fica no banco. Com ela, os próximos boots não pedem código —
// igual às credenciais do Baileys. Se a string sumir ou for revogada, volta a pedir login.
import { getSetting, setSetting, logEvent } from '../core/db.mjs'

const API_ID = () => Number(process.env.TIM_TG_API_ID || getSetting('tg_api_id', 0)) || 0
const API_HASH = () => process.env.TIM_TG_API_HASH || getSetting('tg_api_hash', null)

export function credenciaisDeclaradas() { return !!(API_ID() && API_HASH()) }
export function sessaoSalva() { return getSetting('tg_session', null) }
export function meuTelegram() { return getSetting('tg_me', null) }

// Carrega a lib só quando precisa: ela é pesada e o sistema tem que subir mesmo sem Telegram
// configurado (o canal é opcional, como o Badoo).
async function lib() {
  const { TelegramClient, Api } = await import('teleproto')
  const { StringSession } = await import('teleproto/sessions/index.js')
  return { TelegramClient, Api, StringSession }
}

let cliente = null

// Conecta com a sessão salva. Devolve null (sem estourar) quando não há credencial ou sessão:
// canal não configurado é um ESTADO, não um erro — o resto do sistema segue rodando.
export async function conectar() {
  if (cliente && cliente.connected) return cliente
  if (!credenciaisDeclaradas()) return null
  const salva = sessaoSalva()
  if (!salva) return null
  const { TelegramClient, StringSession } = await lib()
  const c = new TelegramClient(new StringSession(salva), API_ID(), API_HASH(), {
    connectionRetries: 3,
    // O Telegram mostra o aparelho na lista de sessões dela. Nome comum, pelo mesmo motivo
    // do WhatsApp: identificador do nosso sistema exposto na conta de uma pessoa real assusta
    // quem abre a lista, e é configurável pra poder mudar sem tocar em código.
    deviceModel: process.env.TIM_TG_DEVICE || 'Desktop',
    systemVersion: process.env.TIM_TG_SO || 'Windows 10',
    appVersion: '5.0.0',
  })
  await c.connect()
  if (!await c.checkAuthorization()) { logEvent({ type: 'tg_sessao_invalida', channel: 'telegram', detail: 'a sessão salva não vale mais; precisa logar de novo' }); return null }
  cliente = c
  return c
}

// LOGIN COM CÓDIGO. `pedirCodigo` e `pedirSenha` são funções que quem opera fornece — o
// código chega no app dela e não tem como este processo adivinhar.
const opcoesCliente = () => ({
  connectionRetries: 3,
  deviceModel: process.env.TIM_TG_DEVICE || 'Desktop',
  systemVersion: process.env.TIM_TG_SO || 'Windows 10',
  appVersion: '5.0.0',
})

// LOGIN EM DOIS PASSOS, porque o código chega no app dela e não dá pra adivinhar — então o
// processo tem que PARAR, esperar o código, e continuar. Como os dois momentos são chamadas
// separadas (mensagens diferentes), o estado da sessão entre eles é salvo no banco
// (`tg_login_session` + `tg_login_hash`). Isso é o equivalente ao sendCode/signIn cru, sem
// manter um processo vivo pendurado.

// Passo 1: pede o código. O Telegram manda pro app dela. Guarda o estado pra o passo 2.
export async function pedirCodigo({ telefone }) {
  if (!credenciaisDeclaradas()) throw new Error('faltam api_id/api_hash (crie em my.telegram.org)')
  if (!telefone) throw new Error('falta o número de telefone da conta')
  const { TelegramClient, StringSession } = await lib()
  const c = new TelegramClient(new StringSession(''), API_ID(), API_HASH(), opcoesCliente())
  await c.connect()
  const { phoneCodeHash } = await c.sendCode({ apiId: API_ID(), apiHash: API_HASH() }, telefone)
  // salva a sessão DEPOIS do sendCode: ela carrega o DC certo, que o signIn precisa
  setSetting('tg_login_session', c.session.save())
  setSetting('tg_login_hash', phoneCodeHash)
  setSetting('tg_login_phone', telefone)
  await c.disconnect()
  logEvent({ type: 'tg_codigo_pedido', channel: 'telegram', detail: 'código enviado pro app' })
  return { ok: true }
}

// Passo 2: entra com o código (e a senha de 2 etapas, se houver). Salva a sessão final.
export async function confirmarCodigo({ codigo, senha = null }) {
  const salva = getSetting('tg_login_session', null)
  const hash = getSetting('tg_login_hash', null)
  const telefone = getSetting('tg_login_phone', null)
  if (!salva || !hash || !telefone) throw new Error('não há login em andamento — peça o código primeiro')
  const { TelegramClient, StringSession, Api } = await lib()
  const c = new TelegramClient(new StringSession(salva), API_ID(), API_HASH(), opcoesCliente())
  await c.connect()
  try {
    await c.invoke(new Api.auth.SignIn({ phoneNumber: telefone, phoneCodeHash: hash, phoneCode: String(codigo).trim() }))
  } catch (e) {
    // conta com verificação em duas etapas: o código sozinho não basta, precisa da senha
    if (/SESSION_PASSWORD_NEEDED/.test(String(e && e.message))) {
      if (!senha) { await c.disconnect(); return { ok: false, precisaSenha: true } }
      await c.signInWithPassword({ apiId: API_ID(), apiHash: API_HASH() }, { password: async () => senha, onError: (x) => { throw x } })
    } else { await c.disconnect(); throw e }
  }
  const eu = await c.getMe()
  setSetting('tg_session', c.session.save())
  setSetting('tg_me', eu?.username || eu?.firstName || String(eu?.id || ''))
  setSetting('tg_login_session', null); setSetting('tg_login_hash', null); setSetting('tg_login_phone', null)
  await c.disconnect(); cliente = null
  logEvent({ type: 'tg_conectado', channel: 'telegram', detail: `logado como ${eu?.username ? '@' + eu.username : (eu?.firstName || eu?.id)}` })
  return { ok: true, me: getSetting('tg_me', null) }
}

export async function desconectar() {
  try { if (cliente) await cliente.disconnect() } catch { /* já caiu */ }
  cliente = null
}

// Estado pro painel e pra saúde do canal. Nunca estoura.
export async function estado() {
  if (!credenciaisDeclaradas()) return { ok: false, motivo: 'faltam api_id/api_hash' }
  if (!sessaoSalva()) return { ok: false, motivo: 'nunca logou' }
  try {
    const c = await conectar()
    if (!c) return { ok: false, motivo: 'sessão inválida — precisa logar de novo' }
    return { ok: true, me: meuTelegram() }
  } catch (e) { return { ok: false, motivo: String(e && e.message || e).slice(0, 120) } }
}
