// AS CONTAS DE LLM: quantas existem, quanto cada uma já gastou, qual está trabalhando, e
// como passar o bastão quando uma acabar.
//
// O dono paga várias contas do Codex. O pedido dele foi explícito no tempo: "não
// necessariamente agora, mas será necessário essa auto-construção algum dia — quando uma
// conta cair, automaticamente passar pra outra; a conta ter auto-consciência da sua
// porcentagem e quando algo estiver caindo ela poder se auto-trocar (caso eu ligue essa
// função algum dia)".
//
// Então o desenho separa três coisas que costumam vir grudadas e não deveriam:
//   SABER   — ler a cota de cada conta. Sempre ligado, custa quase nada, e é o que dá a
//             "auto-consciência da porcentagem".
//   TROCAR  — passar o bastão. Existe e funciona hoje, na mão.
//   TROCAR SOZINHO — o automático. Nasce DESLIGADO, atrás de um interruptor, porque foi
//             assim que ele pediu. Ligar é uma linha; o código já está pronto e testado.
//
// Uma conta é uma PASTA de credencial (CODEX_HOME). Trocar de conta é apontar o app-server
// pra outra pasta — nunca copiar auth.json por cima, que destruiria a conta anterior.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getSetting, setSetting, logEvent } from '../core/db.mjs'
import { CodexAppServer, espiarConta, soltarCodex, credencialMorta } from './codex.mjs'
import { oDono } from '../core/dono.mjs'
import { CONTAS_DIR } from '../core/caminhos.mjs'

// Onde as contas moram. A padrão (~/.codex) sempre entra, com o nome 'principal'.
export const DIR_CONTAS = CONTAS_DIR
const HOME_PADRAO = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')

const CHAVE_ATIVA = 'llm_conta_ativa'
const CHAVE_AUTO = 'llm_failover_auto'          // o interruptor que ele vai ligar um dia
const CHAVE_LIMITE = 'llm_failover_limite_pct'  // a partir de quantos % procurar outra
const LOGIN_TIMEOUT_MS = Number(process.env.TIM_OPENAI_LOGIN_TIMEOUT_MS || 20 * 60_000)
const loginsPendentes = new Map()

// Uma pasta é conta de Codex se tem auth.json. Não adivinha nada além disso.
function ehConta(dir) { try { return fs.existsSync(path.join(dir, 'auth.json')) } catch { return false } }

export function listar() {
  const out = []
  if (ehConta(HOME_PADRAO)) out.push({ nome: 'principal', home: HOME_PADRAO, motor: 'codex' })
  try {
    for (const d of fs.readdirSync(DIR_CONTAS, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const home = path.join(DIR_CONTAS, d.name)
      if (ehConta(home) && home !== HOME_PADRAO) out.push({ nome: d.name, home, motor: 'codex' })
    }
  } catch { /* a pasta pode não existir ainda: uma conta só é um estado válido */ }
  return out
}

// Nome de pasta, não nome exibido. O e-mail real vem do OAuth depois. Manter o identificador
// estritamente neste alfabeto é a guarda que impede um apelido digitado no painel de escapar
// de /opt/vendas-multicanal/contas com "../" ou uma barra escondida.
export function normalizarNomeConta(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function proximoNomeConta() {
  let n = 2
  while (fs.existsSync(path.join(DIR_CONTAS, `conta-${n}`))) n += 1
  return `conta-${n}`
}

function redirectDoLogin(authUrl) {
  const auth = new URL(String(authUrl || ''))
  const redirect = auth.searchParams.get('redirect_uri')
  if (!redirect) throw new Error('o login da OpenAI não informou o callback')
  return new URL(redirect)
}

// O OAuth do Codex abre um callback em localhost DA VM. Como o navegador do dono está em
// outra máquina, a última navegação falha no computador dele. O fallback é copiar aquela URL
// inteira e colar no painel; o servidor repete o GET no localhost correto.
//
// Segurança: só aceitamos o path, a porta e o state gerados pela sessão que ainda está viva.
// O texto colado nunca vira um fetch arbitrário e nunca pode alcançar outro serviço local.
export function normalizarFallbackOAuth(value, authUrl) {
  const expected = redirectDoLogin(authUrl)
  const raw = String(value || '').trim().replaceAll('&amp;', '&')
  if (!raw) throw new Error('cole a URL de fallback exibida no fim do login')

  let pasted
  const found = raw.match(/https?:\/\/[^\s"'<>]+/i)
  if (found) {
    const cleaned = found[0].replace(/[)\],.;]+$/g, '')
    pasted = new URL(cleaned)
  } else if (/(^|[?&])code=/.test(raw)) {
    pasted = new URL(expected.toString())
    pasted.search = raw.startsWith('?') ? raw : `?${raw}`
  } else {
    throw new Error('o fallback precisa ser a URL completa de localhost com code e state')
  }

  const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
  if (pasted.protocol !== 'http:' || !loopback.has(pasted.hostname)) {
    throw new Error('o fallback não é um callback local válido')
  }
  if (pasted.username || pasted.password || pasted.hash) throw new Error('o fallback contém partes não permitidas')
  if (pasted.pathname !== expected.pathname || pasted.port !== expected.port) {
    throw new Error('o fallback pertence a outro login ou a outra porta')
  }
  const state = pasted.searchParams.get('state')
  const expectedState = new URL(String(authUrl)).searchParams.get('state')
  if (!state || !expectedState || state !== expectedState) throw new Error('o fallback pertence a outra sessão de login')
  if (!pasted.searchParams.get('code')) throw new Error('o fallback ainda não contém o código de autorização')

  const local = new URL(expected.toString())
  local.hostname = '127.0.0.1'
  local.search = pasted.search
  return local.toString()
}

// PASTA QUE NÃO VIROU CREDENCIAL É LIXO, E LIXO VAI FORA SOZINHO.
//
// `iniciarLogin` cria a pasta ANTES do OAuth, porque o app-server precisa de um CODEX_HOME
// pra escrever. Se o login não termina — navegador fechado ou prazo esgotado — sobra uma
// pasta vazia. E `proximoNomeConta()` só olha se a pasta EXISTE, então cada desistência
// queimaria um número. Pior, a pasta vazia não aparece em `listar()` (que exige auth.json),
// então ninguém vê o lixo acumulando.
//
// Só apaga pasta DENTRO de DIR_CONTAS e SEM auth.json. Credencial nunca é apagada por engano:
// a única porta pra isso é o relogin explícito de uma conta comprovadamente morta, abaixo.
function descartarPastaSemCredencial(home, motivo) {
  try {
    const alvo = path.resolve(home)
    if (path.dirname(alvo) !== path.resolve(DIR_CONTAS)) return false
    if (alvo === path.resolve(HOME_PADRAO)) return false
    if (!fs.existsSync(alvo) || ehConta(alvo)) return false
    fs.rmSync(alvo, { recursive: true, force: true })
    // O registro é bem-vindo, mas nunca decide o resultado: apagou é apagou, e um banco
    // indisponível não pode fazer o chamador pensar que a pasta continua lá.
    try { logEvent({ type: 'llm_conta_pasta_descartada', detail: `${path.basename(alvo)}: ${motivo}` }) } catch { /* sem diário, tudo bem */ }
    return true
  } catch { return false }
}

// A faxina de quem chega: roda no boot e antes de escolher nome novo, pra que o lixo deixado
// por uma versão antiga (ou por um processo morto no meio do login) não continue queimando
// número pra sempre. Pasta com login ABERTO agora é poupada — ela está em uso.
export function faxinaContas() {
  const descartadas = []
  try {
    for (const d of fs.readdirSync(DIR_CONTAS, { withFileTypes: true })) {
      if (!d.isDirectory() || loginsPendentes.has(d.name)) continue
      if (descartarPastaSemCredencial(path.join(DIR_CONTAS, d.name), 'pasta sem credencial na faxina')) {
        descartadas.push(d.name)
      }
    }
  } catch { /* a pasta pode não existir ainda */ }
  return descartadas
}

function encerrarLogin(sessao, result) {
  if (sessao.finalizado) return sessao.result
  sessao.finalizado = true
  sessao.result = result
  clearTimeout(sessao.timer)
  try { sessao.server.close() } catch { /* já encerrou */ }
  // Login que não deu certo não deixa rastro: sem isto o nome fica queimado pra sempre.
  if (!result?.ok) descartarPastaSemCredencial(sessao.home, result?.error || 'login não concluído')
  sessao.resolve(result)
  setTimeout(() => {
    if (loginsPendentes.get(sessao.nome) === sessao) loginsPendentes.delete(sessao.nome)
  }, 60_000).unref?.()
  return result
}

async function concluirSessao(sessao, event = {}) {
  if (sessao.finalizado) return sessao.result
  if (sessao.concluindo) return sessao.done
  sessao.concluindo = true
  if (!event.success) {
    return encerrarLogin(sessao, {
      ok: false,
      nome: sessao.nome,
      error: String(event.error || 'o login OpenAI não foi concluído'),
    })
  }
  // A notificação pode chegar alguns milissegundos antes do rename atômico de auth.json.
  for (let i = 0; i < 30 && !ehConta(sessao.home); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!ehConta(sessao.home)) {
    return encerrarLogin(sessao, { ok: false, nome: sessao.nome, error: 'o OAuth terminou sem salvar a credencial' })
  }
  cacheCota.delete(sessao.nome)
  const troca = trocar(sessao.nome)
  const result = {
    ok: true,
    nome: sessao.nome,
    email: emailDe(sessao.home),
    ativa: true,
    troca,
  }
  logEvent({ type: 'llm_conta_adicionada', detail: `${sessao.nome} (${result.email || 'sem e-mail'})` })
  return encerrarLogin(sessao, result)
}

// A credencial daquele nome ainda trabalha? Pergunta cara (sobe app-server), feita só quando
// alguém pede pra ESCREVER POR CIMA de uma conta salva. Falha que não é morte de credencial
// (rede, app-server caindo) devolve `false`: na dúvida, preserva.
async function credencialEstaMorta(home) {
  try {
    const o = await espiarConta(home)
    return !!o?.credencialInvalida
  } catch (e) { return credencialMorta(e) }
}

export async function iniciarLogin({ nome = '', deviceCode = false, substituir = false } = {}) {
  fs.mkdirSync(DIR_CONTAS, { recursive: true, mode: 0o700 })
  faxinaContas()
  const escolhido = normalizarNomeConta(nome) || proximoNomeConta()
  // "principal" NÃO mora em DIR_CONTAS — é o CODEX_HOME padrão (~/.codex). Sem este desvio,
  // pedir login com esse nome criava uma pasta `contas/principal` VAZIA que sombreava a conta
  // de verdade: `listar()` passaria a devolver dois itens chamados "principal". Achado na
  // prova em produção de 15/08/2026, com o login já aberto.
  const ehPadrao = escolhido === 'principal'
  const home = ehPadrao ? HOME_PADRAO : path.join(DIR_CONTAS, escolhido)
  if (!ehPadrao && path.dirname(home) !== path.resolve(DIR_CONTAS)) throw new Error('nome de conta inválido')
  if (loginsPendentes.has(escolhido)) throw new Error(`já existe um login aberto para "${escolhido}"`)
  if (ehConta(home)) {
    // ENTRAR DE NOVO NA MESMA CONTA. Sem esta porta, relogar exigiria um nome novo e a pasta
    // anterior viraria lixo com credencial. Sessão encerrada pelo provedor não queima número.
    if (!substituir) throw new Error(`a conta "${escolhido}" já está salva`)
    if (!(await credencialEstaMorta(home))) {
      throw new Error(`a conta "${escolhido}" ainda está viva — não vou apagar a credencial dela`)
    }
    // No CODEX_HOME padrão sai só a credencial: a pasta ~/.codex guarda config, sessões e
    // histórico que não têm nada a ver com o login que morreu.
    if (ehPadrao) fs.rmSync(path.join(home, 'auth.json'), { force: true })
    else fs.rmSync(home, { recursive: true, force: true })
    logEvent({ type: 'llm_conta_relogin', detail: `${escolhido}: credencial morta descartada para entrar de novo` })
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })

  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const sessao = {
    nome: escolhido,
    home,
    server: null,
    loginId: null,
    authUrl: null,
    iniciadoEm: Date.now(),
    finalizado: false,
    concluindo: false,
    result: null,
    resolve: resolveDone,
    done,
    timer: null,
  }
  sessao.server = new CodexAppServer((event) => {
    if (event?.event === 'loginCompleted' && (!sessao.loginId || !event.loginId || event.loginId === sessao.loginId)) {
      void concluirSessao(sessao, event)
    }
  }, home)
  loginsPendentes.set(escolhido, sessao)

  try {
    const result = await sessao.server.startLogin(Boolean(deviceCode))
    sessao.loginId = result?.loginId || null
    sessao.authUrl = result?.authUrl || result?.verificationUrl || null
    if (!sessao.finalizado) {
      sessao.timer = setTimeout(() => {
        void concluirSessao(sessao, { success: false, error: 'o login expirou; comece novamente' })
      }, LOGIN_TIMEOUT_MS)
      sessao.timer.unref?.()
    }
    return {
      nome: escolhido,
      loginId: sessao.loginId,
      authUrl: result?.authUrl || null,
      verificationUrl: result?.verificationUrl || null,
      userCode: result?.userCode || null,
      expiresInMs: LOGIN_TIMEOUT_MS,
    }
  } catch (error) {
    loginsPendentes.delete(escolhido)
    try { sessao.server.close() } catch { /* ok */ }
    descartarPastaSemCredencial(home, `o login nem chegou a abrir: ${error.message}`)
    throw error
  }
}

export function loginPendente() {
  const sessao = [...loginsPendentes.values()].find((item) => !item.finalizado)
  return sessao
    ? { nome: sessao.nome, loginId: sessao.loginId, authUrl: sessao.authUrl, iniciadoEm: sessao.iniciadoEm || null }
    : null
}

export async function concluirLoginFallback({ nome, fallback } = {}) {
  const key = normalizarNomeConta(nome)
  const sessao = loginsPendentes.get(key)
  if (!sessao || sessao.finalizado || !sessao.authUrl) throw new Error('não existe um login pendente para esta conta')
  const callbackUrl = normalizarFallbackOAuth(fallback, sessao.authUrl)
  let response
  try {
    response = await fetch(callbackUrl, { redirect: 'manual', signal: AbortSignal.timeout(12_000) })
  } catch (error) {
    throw new Error(`não consegui entregar o fallback ao Codex: ${error.message}`)
  }
  if (response.status >= 400) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 240)
    throw new Error(detail || `o callback recusou o fallback (${response.status})`)
  }

  // Normalmente a notificação chega primeiro. A observação do auth.json cobre versões do
  // app-server que encerram o callback antes de publicar account/login/completed.
  const deadline = Date.now() + 15_000
  while (!sessao.finalizado && Date.now() < deadline) {
    if (ehConta(sessao.home)) await concluirSessao(sessao, { success: true })
    if (!sessao.finalizado) await new Promise((resolve) => setTimeout(resolve, 150))
  }
  if (!sessao.finalizado) throw new Error('o callback foi aceito, mas a conta ainda não confirmou o login')
  const result = await sessao.done
  if (!result.ok) throw new Error(result.error || 'o login não foi concluído')
  return result
}

export async function cancelarLogin(nome) {
  const key = normalizarNomeConta(nome)
  const sessao = loginsPendentes.get(key)
  if (!sessao) return { ok: true, cancelado: false }
  try { if (sessao.loginId) await sessao.server.cancelLogin(sessao.loginId) } catch { /* fecha abaixo */ }
  encerrarLogin(sessao, { ok: false, nome: key, error: 'login cancelado' })
  loginsPendentes.delete(key)
  return { ok: true, cancelado: true }
}

export function ativa() {
  const nome = getSetting(CHAVE_ATIVA, 'principal')
  return listar().find((c) => c.nome === nome) || listar()[0] || null
}

// O e-mail da conta sem subir app-server nenhum: está no próprio auth.json. Barato de
// propósito — é o que permite listar as contas no crachá sem custo.
export function emailDe(home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'))
    const claims = j?.tokens?.id_token
    if (typeof claims === 'string' && claims.includes('.')) {
      const p = JSON.parse(Buffer.from(claims.split('.')[1], 'base64').toString('utf8'))
      return p.email || null
    }
    return j.email || null
  } catch { return null }
}

// A COTA. `usedPercent` da janela primária é o número que o dono quer enxergar.
// Cacheado: a janela é de 7 dias, não faz sentido perguntar a cada turno.
const cacheCota = new Map()
const TTL_COTA = Number(process.env.TIM_COTA_TTL_MS || 300_000)

export async function cota(nome, { forcar = false } = {}) {
  const c = listar().find((x) => x.nome === nome)
  if (!c) return { nome, erro: 'conta não existe' }
  const hit = cacheCota.get(nome)
  if (!forcar && hit && Date.now() - hit.t < TTL_COTA) return hit.v
  let v
  try {
    const o = await espiarConta(c.home)
    const lim = (o.limits || [])[0] || null
    // `o.connected` diz apenas que existe um auth.json legível — ele continua true com o
    // token revogado. Quem responde "esta conta ainda trabalha?" é o 401 das chamadas de
    // cota. Sem isso o painel mostra "Em uso" numa conta que não gera mais nada.
    const morta = !!o.credencialInvalida
    v = {
      nome, email: o.account?.email || emailDe(c.home), plano: o.account?.planType || null,
      conectada: !!o.connected && !morta,
      precisaRelogin: morta,
      // Uso desconhecido NÃO é uso zero. Quem desenha a barra precisa saber a diferença.
      semLeitura: lim?.primary?.usedPercent == null,
      motivo: morta
        ? (o.refreshOk === false
            ? 'a sessão desta conta não renova mais: a geração falha em toda tentativa; entre de novo'
            : 'a credencial foi invalidada pelo provedor; entre de novo nesta conta')
        : (o.falhas?.limits || null),
      usadoPct: lim?.primary?.usedPercent ?? null,
      // sobra = o que dá pra gastar antes de bater no teto. É por isso que se escolhe conta.
      sobraPct: lim?.primary?.usedPercent == null ? null : Math.max(0, 100 - lim.primary.usedPercent),
      viraEm: lim?.primary?.resetsAt ? new Date(lim.primary.resetsAt * 1000).toISOString() : null,
      janelaHoras: lim?.primary?.windowDurationMins ? Math.round(lim.primary.windowDurationMins / 60) : null,
      tokensNaVida: o.usage?.summary?.lifetimeTokens ?? null,
    }
  } catch (e) {
    // Conta que não responde é informação, não exceção: é exatamente o caso "a conta caiu".
    v = {
      nome, email: emailDe(c.home), conectada: false, usadoPct: null, sobraPct: null,
      semLeitura: true, precisaRelogin: credencialMorta(e), motivo: e.message, erro: e.message,
    }
  }
  cacheCota.set(nome, { t: Date.now(), v })
  return v
}

export async function todasAsCotas({ forcar = false } = {}) {
  return Promise.all(listar().map((c) => cota(c.nome, { forcar })))
}

// Passar o bastão. Derruba o app-server pra que o próximo turno suba na credencial nova —
// sem isso a troca seria só cosmética (o processo antigo continuaria com o token antigo).
export function trocar(nome) {
  const c = listar().find((x) => x.nome === nome)
  if (!c) throw new Error(`conta "${nome}" não existe (tem: ${listar().map((x) => x.nome).join(', ') || 'nenhuma'})`)
  const antes = getSetting(CHAVE_ATIVA, 'principal')
  setSetting(CHAVE_ATIVA, nome)
  soltarCodex()
  logEvent({ type: 'llm_conta_trocada', detail: `${antes} -> ${nome} (${c.home})` })
  return { de: antes, para: nome, home: c.home }
}

// A conta com mais fôlego. Empate ou tudo sem número: mantém a atual (trocar à toa é pior).
export async function melhorConta() {
  const cotas = (await todasAsCotas()).filter((c) => c.conectada && c.sobraPct != null)
  if (!cotas.length) return null
  return cotas.sort((a, b) => b.sobraPct - a.sobraPct)[0]
}

export function autoLigado() { return getSetting(CHAVE_AUTO, false) === true }
export function limitePct() { return Number(getSetting(CHAVE_LIMITE, 90)) }
export function ligarAuto(v, limite) {
  setSetting(CHAVE_AUTO, !!v)
  if (limite != null) setSetting(CHAVE_LIMITE, Number(limite))
  logEvent({ type: 'llm_failover', detail: `automático ${v ? 'LIGADO' : 'desligado'} (limite ${limitePct()}%)` })
  return { auto: autoLigado(), limitePct: limitePct() }
}

// O automático. Só age se o interruptor estiver ligado. Devolve o que fez (ou por que não
// fez) — nunca falha calado, porque uma troca invisível de conta é impossível de depurar.
export async function talvezTrocar({ forcar = false } = {}) {
  if (!autoLigado() && !forcar) return { agiu: false, motivo: 'automático desligado' }
  const atual = ativa()
  if (!atual) return { agiu: false, motivo: 'nenhuma conta configurada' }
  const minha = await cota(atual.nome, { forcar: true })
  // conta caída conta como "estourada": é o caso que mais importa
  const estourou = !minha.conectada || (minha.usadoPct != null && minha.usadoPct >= limitePct())
  if (!estourou) return { agiu: false, motivo: `conta ${atual.nome} em ${minha.usadoPct ?? '?'}%, abaixo do limite de ${limitePct()}%`, cota: minha }
  const melhor = await melhorConta()
  if (!melhor || melhor.nome === atual.nome) {
    logEvent({ type: 'llm_failover_sem_saida', detail: `${atual.nome} em ${minha.usadoPct ?? '?'}% e não há conta melhor` })
    return { agiu: false, motivo: 'não há outra conta com mais fôlego', cota: minha }
  }
  const r = trocar(melhor.nome)
  logEvent({ type: 'llm_failover_trocou', detail: `${atual.nome} (${minha.usadoPct}%) -> ${melhor.nome} (${melhor.usadoPct}%)` })
  return { agiu: true, ...r, de_cota: minha, para_cota: melhor }
}

// O resumo curto que entra no mapa de si.
export async function resumo() {
  const cotas = await todasAsCotas()
  const at = ativa()
  return {
    ativa: at?.nome || null,
    ondeMoram: DIR_CONTAS,
    automatico: autoLigado() ? `ligado, troca a partir de ${limitePct()}%` : `DESLIGADO (${oDono()} decide quando ligar)`,
    contas: cotas.map((c) => ({ nome: c.nome, email: c.email, plano: c.plano, usadoPct: c.usadoPct, sobraPct: c.sobraPct, viraEm: c.viraEm, ativa: c.nome === at?.nome, erro: c.erro || undefined })),
    comoAcrescentar: `crie ${DIR_CONTAS}/<nome>/ e rode: CODEX_HOME=${DIR_CONTAS}/<nome> codex login`,
  }
}
