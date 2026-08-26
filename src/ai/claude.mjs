// Motor Claude Code — o segundo agente possível pro modo códex.
//
// Por que um adaptador e não "outra IA": o dono pediu pra pegar "aquilo que constrói de fato
// um codex ou um claude code, não somente as interfaces pra frente". O que constrói os dois,
// por trás da interface, é o MESMO conjunto de peças:
//
//   instruções de sistema  -> codex: baseInstructions      | claude: --append-system-prompt
//   sessão que continua    -> codex: threadId              | claude: --resume <sessionId>
//   diretório de trabalho  -> codex: cwd na thread         | claude: cwd do processo + --add-dir
//   política de permissão  -> codex: approvalPolicy        | claude: --permission-mode
//   cerca de escrita       -> codex: sandbox               | claude: sandbox do SO + permissões
//   laço de ferramenta     -> os dois já trazem o seu (shell, edição de arquivo, busca)
//   saída estruturada      -> codex: turn/completed        | claude: --output-format json
//
// Ou seja: a abstração não é "mande um texto e receba outro". É "rode um TURNO DE AGENTE com
// estado", que é a unidade de verdade dos dois. Por isso os dois adaptadores expõem a mesma
// função e devolvem o mesmo par { text, threadId }: trocar de motor não muda o modo códex.
//
// Diferença honesta que fica registrada: o Codex fala JSON-RPC por um app-server que vive
// entre turnos (mais barato); o Claude Code é um processo por turno (mais simples, mais
// lento no arranque). Nenhum dos dois vaza pro chamador.
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { registrarUso } from './uso.mjs'

const TIMEOUT_PADRAO = 600_000

export async function acharBinario() {
  const cands = [process.env.TIM_CLAUDE_BINARY, '/usr/local/bin/claude', '/opt/homebrew/bin/claude', '/usr/bin/claude'].filter(Boolean)
  for (const c of cands) { try { await access(c); return c } catch { /* segue */ } }
  return 'claude'   // deixa o PATH resolver; se não existir, o spawn falha com ENOENT claro
}

// "Pronto" é AUTENTICADO, não "o binário existe". Olhar só o `--version` mentia: na VM o
// claude estava instalado e sem login, o `disponiveis()` disse pronto, a troca foi permitida
// e só então tudo quebrou — com um despejo de JSON cru na cara. Prometer o que não roda é o
// pior tipo de configuração.
//
// A sonda é um `-p` mínimo. Quando não há login, ele falha em ~300ms e custa ZERO token; com
// login, custa uma chamada minúscula. Cacheado, porque estado de login não muda a cada minuto.
let _cacheProntidao = null
const TTL_PRONTIDAO = Number(process.env.TIM_CLAUDE_PRONTO_TTL_MS || 300_000)

export async function disponivel({ forcar = false } = {}) {
  if (!forcar && _cacheProntidao && Date.now() - _cacheProntidao.t < TTL_PRONTIDAO) return _cacheProntidao.v
  const bin = await acharBinario()
  const versao = await new Promise((r) => {
    const p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.on('data', (c) => { out += String(c) })
    p.on('error', () => r(null))
    p.on('close', (code) => r(code === 0 ? out.trim() : null))
  })
  if (!versao) {
    const v = { ok: false, versao: null, motivo: 'binário `claude` não instalado nesta máquina' }
    _cacheProntidao = { t: Date.now(), v }; return v
  }

  // Versões atuais expõem o estado OAuth sem gastar uma geração. Além de ser mais barato
  // que a antiga sonda "responda ok", isto entrega o e-mail e o plano que a Config precisa
  // mostrar. Se uma versão antiga não tiver `auth status`, cai na sonda compatível abaixo.
  const auth = await new Promise((r) => {
    const p = spawn(bin, ['auth', 'status', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', (c) => { out += String(c) })
    p.stderr.on('data', (c) => { err += String(c) })
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* ok */ } r(null) }, 10_000)
    p.on('error', () => { clearTimeout(t); r(null) })
    p.on('close', () => {
      clearTimeout(t)
      try { r(JSON.parse(out)) } catch { r(null) }
    })
  })
  if (auth && typeof auth.loggedIn === 'boolean') {
    const conta = {
      email: auth.email ? String(auth.email) : null,
      orgName: auth.orgName ? String(auth.orgName) : null,
      subscriptionType: auth.subscriptionType ? String(auth.subscriptionType) : null,
      authMethod: auth.authMethod ? String(auth.authMethod) : null,
    }
    const v = {
      ok: auth.loggedIn,
      versao,
      conta,
      motivo: auth.loggedIn ? null : 'Claude Code instalado, mas sem login OAuth',
    }
    _cacheProntidao = { t: Date.now(), v }; return v
  }

  const sonda = await new Promise((r) => {
    const startedAt = Date.now()
    const p = spawn(bin, ['-p', '--output-format', 'json', '--allowedTools', 'NENHUMA'], { stdio: ['pipe', 'pipe', 'pipe'] })
    try { p.stdin.write('ok'); p.stdin.end() } catch { /* o close trata */ }
    let out = ''
    let terminou = false
    const finalizar = (resultado, j = null) => {
      if (terminou) return
      terminou = true
      registrarUso({
        provider: 'claude',
        accountName: 'claude',
        operation: 'diagnostico',
        origin: 'sonda_provider',
        trigger: 'diagnostico',
        channel: 'sistema',
        status: resultado.ok ? 'ok' : 'erro',
        usage: usoDoResultadoClaude(j),
        costUsd: Number.isFinite(Number(j?.total_cost_usd)) ? Number(j.total_cost_usd) : null,
        promptChars: 2,
        startedAt,
        durationMs: Date.now() - startedAt,
        error: resultado.ok ? null : resultado.motivo,
      })
      r(resultado)
    }
    p.stdout.on('data', (c) => { out += String(c) })
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* ok */ } finalizar({ ok: false, motivo: 'a sonda não respondeu em 45s' }) }, 45_000)
    p.on('error', (e) => { clearTimeout(t); finalizar({ ok: false, motivo: e.message }) })
    p.on('close', () => {
      clearTimeout(t)
      try {
        const j = JSON.parse(out)
        if (j.is_error) return finalizar({ ok: false, motivo: String(j.result || 'o Claude recusou').trim() }, j)
        return finalizar({ ok: true }, j)
      } catch { finalizar({ ok: false, motivo: (out || 'resposta ilegível do claude').slice(0, 200) }) }
    })
  })
  const v = { ok: sonda.ok, versao, conta: null, motivo: sonda.ok ? null : sonda.motivo }
  _cacheProntidao = { t: Date.now(), v }
  return v
}
export function esquecerProntidao() { _cacheProntidao = null }

// O CLI do Claude devolve a medição no próprio JSON final. Mantemos as categorias de cache
// separadas porque cache lido e cache criado têm preços diferentes e o painel precisa mostrar
// onde os tokens foram, não só um total aproximado.
export function usoDoResultadoClaude(j) {
  const u = j?.usage
  if (!u || typeof u !== 'object') return null
  const n = (value) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null
  }
  const usage = {
    inputTokens: n(u.input_tokens),
    cachedInputTokens: n(u.cache_read_input_tokens),
    cacheWriteTokens: n(u.cache_creation_input_tokens),
    outputTokens: n(u.output_tokens),
    reasoningOutputTokens: n(u.reasoning_output_tokens),
    totalTokens: n(u.total_tokens),
  }
  if (usage.totalTokens == null) {
    const parts = [usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteTokens, usage.outputTokens, usage.reasoningOutputTokens]
    if (parts.some((v) => v != null)) usage.totalTokens = parts.reduce((sum, v) => sum + (v || 0), 0)
  }
  return Object.values(usage).some((v) => v != null) ? usage : null
}

// Login Claude para servidor remoto. Diferente do Codex, o próprio CLI usa callback hospedado:
// ele imprime uma URL, a Anthropic mostra um código ao fim e o usuário cola esse código no
// stdin ainda aberto. Guardamos só o processo pendente; a credencial final continua sendo
// salva pelo Claude Code no armazenamento dele.
let _login = null
const LOGIN_TIMEOUT_MS = Number(process.env.TIM_CLAUDE_LOGIN_TIMEOUT_MS || 20 * 60_000)

function textoSemAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-9;]*m/g, '')
}

function urlDeLogin(value) {
  const match = textoSemAnsi(value).match(/https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s]+/i)
  return match ? match[0].trim() : null
}

export function loginPendente() {
  return _login && !_login.finished
    ? { authUrl: _login.authUrl || null, iniciadoEm: _login.iniciadoEm }
    : null
}

export async function iniciarLogin() {
  if (_login && !_login.finished) {
    if (_login.authUrl) return { authUrl: _login.authUrl, iniciadoEm: _login.iniciadoEm }
    return _login.started
  }
  const bin = await acharBinario()
  let resolveStarted, rejectStarted, resolveDone
  const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject })
  const done = new Promise((resolve) => { resolveDone = resolve })
  const proc = spawn(bin, ['auth', 'login', '--claudeai'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: '/bin/false' },
  })
  const login = {
    proc,
    authUrl: null,
    iniciadoEm: Date.now(),
    output: '',
    finished: false,
    started,
    done,
    resolveStarted,
    rejectStarted,
    resolveDone,
    startTimer: null,
    expiryTimer: null,
  }
  _login = login

  const read = (chunk) => {
    login.output = `${login.output}${String(chunk || '')}`.slice(-24_000)
    const authUrl = urlDeLogin(login.output)
    if (authUrl && !login.authUrl) {
      login.authUrl = authUrl
      clearTimeout(login.startTimer)
      login.resolveStarted({ authUrl, iniciadoEm: login.iniciadoEm })
    }
  }
  proc.stdout.on('data', read)
  proc.stderr.on('data', read)
  proc.stdin.on('error', () => {})
  proc.on('error', (error) => {
    login.finished = true
    clearTimeout(login.startTimer); clearTimeout(login.expiryTimer)
    if (!login.authUrl) login.rejectStarted(error)
    login.resolveDone({ ok: false, error: error.message })
  })
  proc.on('close', (code) => {
    if (login.finished) return
    login.finished = true
    clearTimeout(login.startTimer); clearTimeout(login.expiryTimer)
    const result = code === 0
      ? { ok: true }
      : { ok: false, error: textoSemAnsi(login.output).trim().slice(-500) || `Claude auth saiu com ${code}` }
    if (!login.authUrl) login.rejectStarted(new Error(result.error || 'o Claude não informou a URL de login'))
    login.resolveDone(result)
    esquecerProntidao()
  })
  login.startTimer = setTimeout(() => {
    if (!login.authUrl) {
      try { proc.kill('SIGKILL') } catch { /* ok */ }
      login.rejectStarted(new Error('o Claude não informou a URL de login em 15 segundos'))
    }
  }, 15_000)
  login.expiryTimer = setTimeout(() => {
    try { proc.kill('SIGKILL') } catch { /* ok */ }
  }, LOGIN_TIMEOUT_MS)
  login.expiryTimer.unref?.()
  return started
}

export async function concluirLogin(codigo) {
  const login = _login
  if (!login || login.finished || !login.authUrl) throw new Error('não existe um login Claude pendente')
  const value = String(codigo || '').trim()
  if (!value) throw new Error('cole o código exibido pela Anthropic')
  if (value.length > 4096) throw new Error('o código colado é grande demais')
  try {
    login.proc.stdin.write(`${value}\n`)
  } catch (error) {
    throw new Error(`não consegui entregar o código ao Claude: ${error.message}`)
  }
  let timeoutId
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      try { login.proc.kill('SIGKILL') } catch { /* ok */ }
      resolve({ ok: false, error: 'o Claude não confirmou o login em 45 segundos' })
    }, 45_000)
  })
  const result = await Promise.race([login.done, timeout])
  clearTimeout(timeoutId)
  if (!result.ok) throw new Error(result.error || 'o login Claude não foi concluído')
  esquecerProntidao()
  const status = await disponivel({ forcar: true })
  if (!status.ok) throw new Error(status.motivo || 'o Claude terminou o login, mas ainda não está autenticado')
  _login = null
  return status
}

export function cancelarLogin() {
  if (!_login) return { ok: true, cancelado: false }
  try { _login.proc.kill('SIGTERM') } catch { /* ok */ }
  _login = null
  esquecerProntidao()
  return { ok: true, cancelado: true }
}

// Um turno de agente. Mesma assinatura do runAgentTurn do Codex.
//
// permission-mode: 'acceptEdits' deixa editar arquivo sem perguntar, que é o equivalente do
// approvalPolicy:'never' + sandbox:'workspace-write' do Codex. NÃO usamos
// --dangerously-skip-permissions: a cerca continua existindo, só não pede confirmação pra
// edição — no WhatsApp não há ninguém pra clicar em "permitir".
export async function runAgentTurn({ prompt, baseInstructions, cwd, threadId = null, model = null, timeoutMs = TIMEOUT_PADRAO }) {
  const bin = await acharBinario()
  // `--add-dir` é VARIÁDICA, igual ao --allowedTools: um argumento posicional depois dela é
  // engolido como se fosse mais um diretório. Por isso o prompt vai por STDIN — e isso também
  // resolve o limite de tamanho de argumento, que um prompt de conversa longa estoura.
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--add-dir', String(cwd)]
  if (baseInstructions) args.push('--append-system-prompt', String(baseInstructions))
  if (threadId) args.push('--resume', String(threadId))
  if (model) args.push('--model', String(model))

  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd: String(cwd), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } })
    try { p.stdin.write(String(prompt || '')); p.stdin.end() } catch { /* o close trata */ }
    let out = '', err = ''
    p.stdout.on('data', (c) => { out += String(c) })
    p.stderr.on('data', (c) => { err += String(c) })
    const timer = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* já morreu */ } reject(new Error(`o turno do Claude passou de ${Math.round(timeoutMs / 1000)}s`)) }, timeoutMs)
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(`Claude Code não rodou: ${e.message}`)) })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`Claude Code saiu com ${code}: ${(err || out).slice(0, 300)}`))
      // --output-format json devolve UM objeto com result e session_id. Se a versão mudar o
      // formato, o texto cru ainda serve de resposta — degradar é melhor que travar o canal.
      try {
        const j = JSON.parse(out)
        const texto = typeof j.result === 'string' ? j.result : (j.text || out)
        resolve({
          text: String(texto || '').trim(),
          threadId: j.session_id || threadId || null,
          turnId: j.uuid || null,
          model: j.model || model || null,
          usage: usoDoResultadoClaude(j),
          costUsd: Number.isFinite(Number(j.total_cost_usd)) ? Number(j.total_cost_usd) : null,
          motor: 'claude',
        })
      } catch {
        resolve({ text: out.trim(), threadId, motor: 'claude' })
      }
    })
  })
}
