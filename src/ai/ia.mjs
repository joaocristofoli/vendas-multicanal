// A IA. Uma só, com UM interruptor.
//
// Correção do dono (26/07/2026): "não quero que sejam duas coisas diferentes, quero que sejam
// a mesma coisa, mas trocando: numa usa OpenAI oauth e quando eu trocar usa a conta do Claude".
//
// Eu tinha partido isso em dois — um `motor` pro agente que mexe no código e um `provedor`
// pro texto — porque por dentro as duas chamadas têm formato diferente. Estava certo por
// dentro e errado por fora: da cadeira dele é uma coisa só, "qual IA está rodando", e detalhe
// de implementação não pode virar botão. Dois botões que precisam concordar acabam
// discordando, e aí metade do sistema fala com uma conta e metade com outra sem ninguém ver.
//
// Então: UM ajuste (`ia_provedor`), e cada provedor implementa AS DUAS capacidades.
//
//                        OpenAI (codex)                    Anthropic (claude)
//   texto de um tiro     runTurn efêmero, read-only        -p --allowedTools ""
//   turno de agente      thread workspace-write            -p --permission-mode acceptEdits
//   instruções           baseInstructions                  --append-system-prompt
//   sessão que continua  threadId                          --resume <sessionId>
//   saída estruturada    turn/completed                    --output-format json
//
// Simétrico de propósito: o que não for simétrico vira mentira no dia da troca. O único
// assimétrico de verdade é VISÃO (imagem), e isso não virou botão — virou fallback que avisa.
import { spawn } from 'node:child_process'
import { getSetting, setSetting, logEvent } from '../core/db.mjs'
import { getCodex, REPLY_INSTRUCTIONS, extractReplyText } from './codex.mjs'
import { acharBinario, disponivel as claudeDisponivel, runAgentTurn as claudeAgente, usoDoResultadoClaude } from './claude.mjs'
import { ativa as contaAtiva, talvezTrocar, autoLigado } from './contas.mjs'
import { pareceMensagemDeSistema } from './filtro.mjs'
import { registrarUso } from './uso.mjs'

// FALHA QUE VOLTA COMO TEXTO É FALHA, NÃO RESPOSTA.
//
// Os dois provedores às vezes respondem com sucesso (exit 0, turno "completed") carregando a
// falha DENTRO do texto: "Claude AI usage limit reached", "rate limit", "service
// unavailable". Quem chama isso trata como resposta pronta — e o clone manda no Tinder da
// pessoa. Converter aqui em exceção faz o resto do sistema tratar como o que é: o provedor
// está fora, não envia nada, tenta no próximo tick. O portão do filtro continua existindo
// depois disto; este é o primeiro dos dois, e nenhum dos dois é opcional.
function recusarTextoDeFalha(texto, provedor, { permitirEstruturado = false } = {}) {
  const s = pareceMensagemDeSistema(texto, { permitirEstruturado })
  if (!s) return texto
  logEvent({ type: 'ia_texto_de_falha', detail: `${provedor}: ${String(texto || '').slice(0, 200)}` })
  const e = new Error(`o ${provedor} devolveu falha no lugar da resposta: ${s.motivo}`)
  e.textoDeFalha = true
  throw e
}

const CHAVE = 'ia_provedor'

// MODELO E ESFORÇO, escolhidos pelo dono na Config.
//
// Antes disso o vendas-multicanal mandava `model: null` e `effort: 'low'` em TODA chamada — ou seja, rodava
// no modelo padrão do Codex e no esforço mais baixo, sem ninguém ter decidido isso. O
// `config.toml` da conta dizia `gpt-5.6-sol` e `xhigh`, e não valia nada: o parâmetro da
// chamada ganha do arquivo.
//
// A lista de modelos NÃO é a que a interface do Codex mostra: é a que respondeu de verdade
// quando foram sondados um a um. Mesma coisa nos esforços — o "Light" da interface deles é
// recusado pela API ("invalid_request_error"); o valor que funciona é `low`.
//
// ESTES IDS SÃO DA OPENAI E SÓ VALEM PRO CODEX. Um `gpt-5.6-sol` não existe do lado da
// Anthropic — mandar `claude --model gpt-5.6-sol` é pedir um modelo que não existe naquele
// provedor. Por isso o padrão do dono só é aplicado quando o alvo é o codex (`modeloDoAlvo`);
// não é uma hipótese sobre o que o CLI responde, é que a escolha não faz sentido fora da
// OpenAI. Se um dia houver escolha de modelo pro Claude, ela é uma lista própria, não esta.
export const MODELOS = [
  { id: 'gpt-5.6-sol', nome: '5.6 Sol', nota: 'o mais capaz' },
  { id: 'gpt-5.6-terra', nome: '5.6 Terra' },
  { id: 'gpt-5.6-luna', nome: '5.6 Luna' },
  { id: 'gpt-5.5', nome: '5.5' },
  { id: 'gpt-5.4', nome: '5.4' },
  { id: 'gpt-5.4-mini', nome: '5.4 Mini', nota: 'o mais rápido e barato' },
]
export const ESFORCOS = [
  { id: 'low', nome: 'Baixo', nota: 'era o que o vendas-multicanal usava sem ninguém ter escolhido' },
  { id: 'medium', nome: 'Médio' },
  { id: 'high', nome: 'Alto' },
  { id: 'xhigh', nome: 'Muito alto' },
  { id: 'ultra', nome: 'Ultra', nota: 'come cota mais rápido' },
]

export function modeloAtivo() {
  const m = getSetting('ia_model', null)
  return MODELOS.some((x) => x.id === m) ? m : null   // null = deixa o Codex escolher
}

// Qual modelo mandar pra ESTE provedor. O que quem chama passou sempre ganha; o padrão do
// o dono (a lista acima) só vale pro codex, porque é uma lista de ids da OpenAI. Antes disto,
// `model = model || modeloAtivo()` rodava ANTES de saber pra quem ia: com um modelo escolhido
// na Config, trocar pro Claude mandaria `--model gpt-5.6-sol` em toda geração de texto — o
// clone, o assistente e os extratores. Deixar o Claude no modelo padrão dele é o certo.
export function modeloDoAlvo(alvo, pedido = null) {
  if (pedido) return pedido
  return alvo === 'codex' ? modeloAtivo() : null
}
export function esforcoAtivo() {
  const e = getSetting('ia_effort', 'low')
  return ESFORCOS.some((x) => x.id === e) ? e : 'low'
}
export function definirMotor({ modelo, esforco } = {}) {
  if (modelo !== undefined) {
    if (modelo && !MODELOS.some((x) => x.id === modelo)) throw new Error(`modelo "${modelo}" não está na lista provada`)
    setSetting('ia_model', modelo || null)
  }
  if (esforco !== undefined) {
    if (!ESFORCOS.some((x) => x.id === esforco)) throw new Error(`esforço "${esforco}" não está na lista provada`)
    setSetting('ia_effort', esforco)
  }
  logEvent({ type: 'ia_motor', detail: `modelo ${modeloAtivo() || '(padrão do Codex)'}, esforço ${esforcoAtivo()}` })
  return { modelo: modeloAtivo(), esforco: esforcoAtivo(), modelos: MODELOS, esforcos: ESFORCOS }
}

export const PROVEDORES = {
  codex: { nome: 'OpenAI (Codex)', conta: 'o seu login OAuth da OpenAI', visao: true },
  claude: { nome: 'Anthropic (Claude)', conta: 'a sua conta do Claude', visao: false },
}

export function provedorAtivo() {
  const p = getSetting(CHAVE, 'codex')
  return PROVEDORES[p] ? p : 'codex'
}

export function definirProvedor(p) {
  if (!PROVEDORES[p]) throw new Error(`provedor "${p}" não existe (tem: ${Object.keys(PROVEDORES).join(', ')})`)
  const antes = provedorAtivo()
  setSetting(CHAVE, p)
  logEvent({ type: 'ia_provedor', detail: `${antes} -> ${p}` })
  return { de: antes, para: p }
}

// ---------------------------------------------------------------- o lado do Claude
const TIMEOUT_TEXTO = 120_000

// Tira a cerca de markdown. Diferença REAL medida entre os dois: pedindo JSON, o Codex
// devolve o objeto cru e o Claude devolve dentro de ```json ... ```. Os extratores fazem
// JSON.parse — com cerca, quebram, e a agenda pararia de detectar compromisso sem ninguém
// entender por quê. Normalizar aqui é o que faz a troca ser de fato transparente.
// Só o caminho do Claude passa por isto: a saída do Codex continua byte a byte a de sempre.
function semCerca(t) {
  return String(t || '').trim().replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```$/i, '').trim()
}

// Gerador de texto de um tiro: mesmo contrato do runTurn efêmero do Codex.
//
// DUAS DECISÕES QUE PARECEM DETALHE E NÃO SÃO:
//
// 1. `--allowedTools NENHUMA` em vez de `--allowedTools ""`. A flag é VARIÁDICA: com valor
//    vazio ela engole o próximo argumento, e o próximo era o prompt. No Mac passou por
//    acidente (vinha outra flag no meio); na VM o CLI respondeu "Input must be provided" e a
//    sonda de prontidão virou "resposta ilegível". Um nome de ferramenta que não existe
//    fecha a lista sem ambiguidade e proíbe tudo do mesmo jeito.
//
// 2. O PROMPT VAI POR STDIN, não como argumento. Some a ambiguidade posicional de vez, e
//    principalmente: o prompt do clone carrega a conversa inteira e argumento tem limite de
//    tamanho no sistema operacional. Como argumento, isso quebraria um dia, numa conversa
//    longa, sem motivo aparente.
async function claudeTexto({ prompt, baseInstructions, model, timeoutMs = TIMEOUT_TEXTO }) {
  const bin = await acharBinario()
  const args = ['-p', '--output-format', 'json', '--allowedTools', 'NENHUMA']
  if (baseInstructions) args.push('--append-system-prompt', String(baseInstructions))
  if (model) args.push('--model', String(model))
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } })
    try { p.stdin.write(String(prompt || '')); p.stdin.end() } catch { /* o close trata */ }
    let out = '', err = ''
    p.stdout.on('data', (c) => { out += String(c) })
    p.stderr.on('data', (c) => { err += String(c) })
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* já morreu */ } reject(new Error(`o Claude passou de ${Math.round(timeoutMs / 1000)}s`)) }, timeoutMs)
    p.on('error', (e) => { clearTimeout(t); reject(new Error(`Claude não rodou: ${e.message}`)) })
    p.on('close', (code) => {
      clearTimeout(t)
      // O corpo JSON existe MESMO com saída != 0, e é onde mora a mensagem legível
      // ("Not logged in · Please run /login"). Rejeitar antes de ler despejava JSON cru na
      // cara de quem só queria saber que faltava login.
      let j = null
      try { j = JSON.parse(out) } catch { /* saída não-JSON */ }
      if (j && j.is_error) {
        const error = new Error(String(j.result || 'o Claude recusou').trim().slice(0, 300))
        error.usage = usoDoResultadoClaude(j)
        error.costUsd = Number.isFinite(Number(j.total_cost_usd)) ? Number(j.total_cost_usd) : null
        error.threadId = j.session_id || null
        return reject(error)
      }
      if (code !== 0) return reject(new Error(`Claude saiu com ${code}: ${(err || out).slice(0, 200)}`))
      resolve({
        text: semCerca(j ? String(j.result ?? out) : out),
        usage: usoDoResultadoClaude(j),
        costUsd: Number.isFinite(Number(j?.total_cost_usd)) ? Number(j.total_cost_usd) : null,
        threadId: j?.session_id || null,
        turnId: j?.uuid || null,
        model: j?.model || model || null,
      })
    })
  })
}

async function medir({ provider, operation, prompt, baseInstructions, images, usageMeta, executar }) {
  const startedAt = Date.now()
  const meta = usageMeta && typeof usageMeta === 'object' ? usageMeta : {}
  try {
    const result = await executar()
    registrarUso({
      provider,
      accountName: provider === 'codex' ? (contaAtiva()?.nome || null) : 'claude',
      operation,
      origin: meta.origin,
      step: meta.step,
      trigger: meta.trigger,
      channel: meta.channel,
      personId: meta.personId,
      aiEnabled: meta.aiEnabled,
      model: result?.model || meta.model || null,
      status: 'ok',
      usage: result?.usage,
      costUsd: result?.costUsd,
      promptChars: String(prompt || '').length,
      baseChars: String(baseInstructions || '').length,
      imageCount: Array.isArray(images) ? images.length : 0,
      threadId: result?.threadId,
      turnId: result?.turnId,
      startedAt,
      durationMs: Date.now() - startedAt,
      meta: meta.detail || null,
    })
    return result
  } catch (error) {
    registrarUso({
      provider,
      accountName: provider === 'codex' ? (contaAtiva()?.nome || null) : 'claude',
      operation,
      origin: meta.origin,
      step: meta.step,
      trigger: meta.trigger,
      channel: meta.channel,
      personId: meta.personId,
      aiEnabled: meta.aiEnabled,
      model: meta.model || null,
      status: 'erro',
      usage: error?.usage,
      costUsd: error?.costUsd,
      promptChars: String(prompt || '').length,
      baseChars: String(baseInstructions || '').length,
      imageCount: Array.isArray(images) ? images.length : 0,
      threadId: error?.threadId,
      turnId: error?.turnId,
      startedAt,
      durationMs: Date.now() - startedAt,
      error: error?.message || error,
      meta: meta.detail || null,
    })
    throw error
  }
}

function propagarMedicao(error, result) {
  if (error && result) {
    error.usage ??= result.usage
    error.costUsd ??= result.costUsd
    error.threadId ??= result.threadId
    error.turnId ??= result.turnId
  }
  throw error
}

// ---------------------------------------------------------------- capacidade 1: texto
// Um tiro, sem ferramenta, sem estado. É o que o clone e os extratores precisam.
export async function gerarTexto({ prompt, baseInstructions, effort = null, model = null, images = [], timeoutMs = TIMEOUT_TEXTO, usageMeta = null }) {
  // quem chama pode forçar; sem isso, vale o que o dono escolheu na Config
  effort = effort || esforcoAtivo()
  let alvo = provedorAtivo()

  // VISÃO é o único assimétrico de verdade: o Claude Code em modo print não recebe imagem por
  // este caminho. Não virou botão porque não é escolha dele — é limitação. Cai pro Codex e
  // DIZ que caiu; ficar calado produziria laudo de imagem que ninguém viu.
  if (alvo === 'claude' && images && images.length) {
    logEvent({ type: 'ia_fallback_visao', detail: 'imagem não passa pelo Claude, usei o Codex' })
    alvo = 'codex'
  }
  // depois do fallback de visão, nunca antes: o alvo pode ter mudado aqui em cima
  model = modeloDoAlvo(alvo, model)

  if (alvo === 'claude') {
    return medir({
      provider: 'claude', operation: 'texto', prompt, baseInstructions, images, usageMeta,
      executar: async () => {
        const r = await claudeTexto({ prompt, baseInstructions, model, timeoutMs })
        try { return { ...r, text: recusarTextoDeFalha(r.text, 'claude', { permitirEstruturado: true }), provedor: 'claude' } }
        catch (error) { return propagarMedicao(error, r) }
      },
    })
  }
  return medir({
    provider: 'codex', operation: images?.length ? 'visao' : 'texto', prompt, baseInstructions, images, usageMeta,
    executar: async () => {
      const r = await getCodex(contaAtiva()?.home || null).runTurn({ prompt, baseInstructions, effort, model, images })
      try { return { ...r, text: recusarTextoDeFalha(r.text, 'codex', { permitirEstruturado: true }), provedor: 'codex' } }
      catch (error) { return propagarMedicao(error, r) }
    },
  })
}

// A resposta do CLONE. Separada porque carrega a BLINDAGEM — as instruções que dizem "você
// escreve como o próprio usuário e nunca admite ser IA". Elas vêm de codex.mjs e são as
// MESMAS nos dois: se cada provedor tivesse a sua, trocar mudaria a blindagem em silêncio.
export async function gerarResposta({ prompt, model = null, usageMeta = null }) {
  model = modeloDoAlvo(provedorAtivo(), model)
  if (provedorAtivo() === 'claude') {
    return medir({
      provider: 'claude', operation: 'resposta', prompt, baseInstructions: REPLY_INSTRUCTIONS, images: [], usageMeta,
      executar: async () => {
        const r = await claudeTexto({ prompt, baseInstructions: REPLY_INSTRUCTIONS, model, timeoutMs: 180_000 })
        try {
          const reply = extractReplyText(r.text)
          if (!reply) throw new Error('o Claude não devolveu uma mensagem utilizável.')
          return { ...r, reply: recusarTextoDeFalha(reply, 'claude'), provedor: 'claude', model: r.model || model || null }
        } catch (error) { return propagarMedicao(error, r) }
      },
    })
  }
  return medir({
    provider: 'codex', operation: 'resposta', prompt, baseInstructions: REPLY_INSTRUCTIONS, images: [], usageMeta,
    executar: async () => {
      const r = await getCodex(contaAtiva()?.home || null).generateReply({ prompt, model, effort: esforcoAtivo() })
      try { return { ...r, reply: recusarTextoDeFalha(r.reply, 'codex'), provedor: 'codex' } }
      catch (error) { return propagarMedicao(error, r) }
    },
  })
}

// ---------------------------------------------------------------- capacidade 2: agente
// Com estado, com shell, com edição de arquivo, dentro de uma cerca. É o modo códex.
// `threadId` é opaco e pertence ao provedor que o gerou — quem chama guarda um por provedor.
export async function turnoDeAgente({ prompt, baseInstructions, cwd, threadId = null, effort = 'medium', timeoutMs = 600_000, usageMeta = null }) {
  if (provedorAtivo() === 'claude') {
    return medir({
      provider: 'claude', operation: 'agente', prompt, baseInstructions, images: [], usageMeta,
      executar: () => claudeAgente({ prompt, baseInstructions, cwd, threadId, timeoutMs }),
    })
  }
  // O gancho do failover de conta (Codex tem várias credenciais possíveis). Com o automático
  // desligado — o padrão — isto é uma leitura de setting e nada mais.
  if (autoLigado()) {
    try { const r = await talvezTrocar(); if (r.agiu) logEvent({ type: 'llm_failover_no_turno', detail: `${r.de} -> ${r.para}` }) }
    catch (e) { logEvent({ type: 'llm_failover_erro', detail: e.message }) }
  }
  return medir({
    provider: 'codex', operation: 'agente', prompt, baseInstructions, images: [], usageMeta,
    executar: async () => {
      const r = await getCodex(contaAtiva()?.home || null).runAgentTurn({ prompt, baseInstructions, cwd, threadId, effort, timeoutMs })
      return { ...r, motor: 'codex' }
    },
  })
}

// ---------------------------------------------------------------- estado
// "existe" e "está pronto" são coisas diferentes. Prometer o que não roda é o pior tipo de
// configuração — por isso a checagem é do binário de verdade, não de uma lista.
export async function disponiveis({ forcar = false } = {}) {
  const c = await claudeDisponivel({ forcar })
  const ativo = provedorAtivo()
  return {
    ativo,
    codex: { pronto: true, nome: PROVEDORES.codex.nome, conta: contaAtiva()?.nome || null, visao: true },
    // `falta` vem da sonda REAL, não de um palpite: "instalado" e "logado" são coisas
    // diferentes e a diferença só aparece quando alguém tenta usar.
    claude: {
      pronto: c.ok,
      nome: PROVEDORES.claude.nome,
      versao: c.versao,
      conta: c.conta || null,
      visao: false,
      falta: c.ok ? null : c.motivo,
    },
  }
}

export function comoTexto() {
  const a = provedorAtivo()
  return [
    `IA ATIVA: ${PROVEDORES[a].nome} — usa ${PROVEDORES[a].conta}`,
    '  Vale pra TUDO: o clone que escreve pras pessoas, o assistente que fala com você, os extratores e o agente do modo códex.',
    `  Trocar: node tools/trava.mjs ia ${a === 'codex' ? 'claude' : 'codex'}`,
    a === 'claude' ? '  (imagem continua indo pelo Codex: o Claude não recebe imagem por este caminho)' : null,
  ].filter(Boolean).join('\n')
}
