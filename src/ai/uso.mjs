// Livro-caixa de TODA chamada paga à IA.
//
// O painel da OpenAI mostra o total da conta, mas não responde a pergunta operacional:
// "qual parte do vendas-multicanal gastou isso?". Esta tabela nasce no ponto único por onde passam Codex
// e Claude e guarda tanto chamadas concluídas quanto tentativas que falharam. Tokens ficam
// NULL quando o provedor não os informou — nunca inventamos uma estimativa e nunca escondemos
// uma chamada só porque ela não trouxe medição.
import crypto from 'node:crypto'
import { db, getSetting, setSetting, personDisplayName } from '../core/db.mjs'
import { idsBrutosDaPessoa } from '../self/identidade.mjs'

let schemaPronto = false

function numero(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null
}

function somaConhecida(...values) {
  const conhecidos = values.filter((v) => v != null)
  return conhecidos.length ? conhecidos.reduce((s, v) => s + v, 0) : null
}

export function normalizarUso(raw) {
  if (!raw || typeof raw !== 'object') return null
  const inputTokens = numero(raw.inputTokens ?? raw.input_tokens)
  const cachedInputTokens = numero(raw.cachedInputTokens ?? raw.cache_read_input_tokens ?? raw.cached_input_tokens)
  const cacheWriteTokens = numero(raw.cacheWriteTokens ?? raw.cache_creation_input_tokens ?? raw.cache_write_input_tokens)
  const outputTokens = numero(raw.outputTokens ?? raw.output_tokens)
  const reasoningOutputTokens = numero(raw.reasoningOutputTokens ?? raw.reasoning_output_tokens)
  const informado = numero(raw.totalTokens ?? raw.total_tokens)
  const totalTokens = informado ?? somaConhecida(inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, reasoningOutputTokens)
  if ([inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, reasoningOutputTokens, totalTokens].every((v) => v == null)) return null
  return { inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, reasoningOutputTokens, totalTokens }
}

export function somarUsos(a, b) {
  const x = normalizarUso(a), y = normalizarUso(b)
  if (!x) return y
  if (!y) return x
  const add = (k) => (x[k] == null && y[k] == null) ? null : (x[k] || 0) + (y[k] || 0)
  return {
    inputTokens: add('inputTokens'),
    cachedInputTokens: add('cachedInputTokens'),
    cacheWriteTokens: add('cacheWriteTokens'),
    outputTokens: add('outputTokens'),
    reasoningOutputTokens: add('reasoningOutputTokens'),
    totalTokens: add('totalTokens'),
  }
}

export function iniciarMonitoramentoTokens() {
  if (!schemaPronto) {
    db().exec(`
      CREATE TABLE IF NOT EXISTS llm_usage (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        started_at INTEGER,
        duration_ms INTEGER,
        provider TEXT,
        account_name TEXT,
        operation TEXT,
        origin TEXT,
        step TEXT,
        trigger TEXT,
        channel TEXT,
        person_id TEXT,
        ai_enabled INTEGER,
        model TEXT,
        status TEXT,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        cache_write_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_output_tokens INTEGER,
        total_tokens INTEGER,
        cost_usd REAL,
        prompt_chars INTEGER,
        base_chars INTEGER,
        image_count INTEGER,
        thread_id TEXT,
        turn_id TEXT,
        error TEXT,
        meta_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_llm_usage_ts ON llm_usage(ts);
      CREATE INDEX IF NOT EXISTS idx_llm_usage_origin_ts ON llm_usage(origin, ts);
      CREATE INDEX IF NOT EXISTS idx_llm_usage_person_ts ON llm_usage(person_id, channel, ts);
    `)
    // As primeiras versões do monitor usavam "automático" como default mesmo quando o
    // chamador ainda não informava origem/pessoa. Isso produz falso positivo de fora do
    // botão; sem prova não se chama violação — fica honestamente como não informado.
    db().prepare(`UPDATE llm_usage SET trigger='nao_informado'
      WHERE origin='nao_informado' AND person_id IS NULL AND trigger='automatico'`).run()
    schemaPronto = true
  }
  let desde = getSetting('llm_monitor_started_at', null)
  if (!desde) {
    desde = Date.now()
    setSetting('llm_monitor_started_at', desde)
  }
  return Number(desde)
}

// Resolve aliases e vínculos antes de avaliar o interruptor. Memória, por exemplo, pertence
// à pessoa canônica; o botão pode estar na identidade crua do Instagram ou WhatsApp.
export function iaLigadaParaPessoa(personId, channel = null) {
  if (!personId) return null
  let ids
  try { ids = idsBrutosDaPessoa(personId) } catch { ids = [String(personId)] }
  ids = [...new Set([String(personId), ...ids].filter(Boolean))]
  if (!ids.length) return null
  const marks = ids.map(() => '?').join(',')
  const rows = channel
    ? db().prepare(`SELECT enabled FROM ai_setting WHERE person_id IN (${marks}) AND channel=?`).all(...ids, String(channel))
    : db().prepare(`SELECT enabled FROM ai_setting WHERE person_id IN (${marks})`).all(...ids)
  if (!rows.length) return false
  return rows.some((r) => Boolean(r.enabled))
}

export function registrarUso({
  provider,
  accountName = null,
  operation = 'texto',
  origin = 'nao_informado',
  step = 'principal',
  trigger = 'nao_informado',
  channel = null,
  personId = null,
  aiEnabled = undefined,
  model = null,
  status = 'ok',
  usage = null,
  costUsd = null,
  promptChars = null,
  baseChars = null,
  imageCount = 0,
  threadId = null,
  turnId = null,
  startedAt = null,
  durationMs = null,
  error = null,
  meta = null,
} = {}) {
  try {
    iniciarMonitoramentoTokens()
    const u = normalizarUso(usage)
    const ligado = aiEnabled === undefined ? iaLigadaParaPessoa(personId, channel) : aiEnabled
    db().prepare(`INSERT INTO llm_usage(
      id,ts,started_at,duration_ms,provider,account_name,operation,origin,step,trigger,
      channel,person_id,ai_enabled,model,status,input_tokens,cached_input_tokens,
      cache_write_tokens,output_tokens,reasoning_output_tokens,total_tokens,cost_usd,
      prompt_chars,base_chars,image_count,thread_id,turn_id,error,meta_json
    ) VALUES(
      @id,@ts,@started,@duration,@provider,@account,@operation,@origin,@step,@trigger,
      @channel,@person,@enabled,@model,@status,@input,@cached,@cacheWrite,@output,
      @reasoning,@total,@cost,@promptChars,@baseChars,@images,@thread,@turn,@error,@meta
    )`).run({
      id: crypto.randomUUID(),
      ts: Date.now(),
      started: startedAt == null ? null : Number(startedAt),
      duration: durationMs == null ? null : Math.max(0, Math.round(Number(durationMs) || 0)),
      provider: String(provider || 'desconhecido'),
      account: accountName == null ? null : String(accountName),
      operation: String(operation || 'texto'),
      origin: String(origin || 'nao_informado'),
      step: String(step || 'principal'),
      trigger: String(trigger || 'nao_informado'),
      channel: channel == null ? null : String(channel),
      person: personId == null ? null : String(personId),
      enabled: ligado == null ? null : (ligado ? 1 : 0),
      model: model == null ? null : String(model),
      status: String(status || 'ok'),
      input: u?.inputTokens ?? null,
      cached: u?.cachedInputTokens ?? null,
      cacheWrite: u?.cacheWriteTokens ?? null,
      output: u?.outputTokens ?? null,
      reasoning: u?.reasoningOutputTokens ?? null,
      total: u?.totalTokens ?? null,
      cost: costUsd == null || !Number.isFinite(Number(costUsd)) ? null : Number(costUsd),
      promptChars: promptChars == null ? null : Math.max(0, Math.round(Number(promptChars) || 0)),
      baseChars: baseChars == null ? null : Math.max(0, Math.round(Number(baseChars) || 0)),
      images: Math.max(0, Math.round(Number(imageCount) || 0)),
      thread: threadId == null ? null : String(threadId),
      turn: turnId == null ? null : String(turnId),
      error: error == null ? null : String(error).slice(0, 1000),
      meta: meta == null ? null : JSON.stringify(meta).slice(0, 8000),
    })
    return true
  } catch {
    // Telemetria não pode derrubar uma resposta. A tentativa ainda fica visível no Diário
    // através dos erros normais do chamador; este catch protege o produto de um banco cheio.
    return false
  }
}

function rowUso(r) {
  return {
    ...r,
    calls: Number(r.calls || 0),
    measuredCalls: Number(r.measured_calls || 0),
    failedCalls: Number(r.failed_calls || 0),
    offToggleCalls: Number(r.off_toggle_calls || 0),
    inputTokens: Number(r.input_tokens || 0),
    cachedInputTokens: Number(r.cached_input_tokens || 0),
    cacheWriteTokens: Number(r.cache_write_tokens || 0),
    outputTokens: Number(r.output_tokens || 0),
    reasoningOutputTokens: Number(r.reasoning_output_tokens || 0),
    totalTokens: Number(r.total_tokens || 0),
    costUsd: Number(r.cost_usd || 0),
    durationMs: Number(r.duration_ms || 0),
  }
}

export function resumoUso({ desde = Date.now() - 24 * 3600_000, limite = 200 } = {}) {
  const monitorandoDesde = iniciarMonitoramentoTokens()
  const start = Math.max(0, Number(desde) || 0)
  const totals = rowUso(db().prepare(`
    SELECT COUNT(*) calls,
      SUM(total_tokens IS NOT NULL) measured_calls,
      SUM(status <> 'ok') failed_calls,
      SUM(trigger='automatico' AND COALESCE(ai_enabled,0)=0) off_toggle_calls,
      COALESCE(SUM(input_tokens),0) input_tokens,
      COALESCE(SUM(cached_input_tokens),0) cached_input_tokens,
      COALESCE(SUM(cache_write_tokens),0) cache_write_tokens,
      COALESCE(SUM(output_tokens),0) output_tokens,
      COALESCE(SUM(reasoning_output_tokens),0) reasoning_output_tokens,
      COALESCE(SUM(total_tokens),0) total_tokens,
      COALESCE(SUM(cost_usd),0) cost_usd,
      COALESCE(SUM(duration_ms),0) duration_ms
    FROM llm_usage WHERE ts>=?`).get(start))
  const grupos = db().prepare(`
    SELECT origin,step,trigger,provider,account_name,channel,person_id,ai_enabled,model,
      COUNT(*) calls,
      SUM(total_tokens IS NOT NULL) measured_calls,
      SUM(status <> 'ok') failed_calls,
      SUM(trigger='automatico' AND COALESCE(ai_enabled,0)=0) off_toggle_calls,
      COALESCE(SUM(input_tokens),0) input_tokens,
      COALESCE(SUM(cached_input_tokens),0) cached_input_tokens,
      COALESCE(SUM(cache_write_tokens),0) cache_write_tokens,
      COALESCE(SUM(output_tokens),0) output_tokens,
      COALESCE(SUM(reasoning_output_tokens),0) reasoning_output_tokens,
      COALESCE(SUM(total_tokens),0) total_tokens,
      COALESCE(SUM(cost_usd),0) cost_usd,
      COALESCE(SUM(duration_ms),0) duration_ms,
      MAX(ts) last_at
    FROM llm_usage WHERE ts>=?
    GROUP BY origin,step,trigger,provider,account_name,channel,person_id,ai_enabled,model
    ORDER BY total_tokens DESC, calls DESC, last_at DESC LIMIT ?`).all(start, Math.max(1, Math.min(1000, Number(limite) || 200))).map((row) => {
      const out = rowUso(row)
      out.personName = out.person_id ? (personDisplayName(out.person_id) || null) : null
      return out
    })
  const recentes = db().prepare(`
    SELECT id,ts,duration_ms,provider,account_name,operation,origin,step,trigger,channel,
      person_id,ai_enabled,model,status,input_tokens,cached_input_tokens,cache_write_tokens,
      output_tokens,reasoning_output_tokens,total_tokens,cost_usd,prompt_chars,base_chars,
      image_count,thread_id,turn_id,error
    FROM llm_usage WHERE ts>=? ORDER BY ts DESC LIMIT 100`).all(start)
  return {
    monitorandoDesde,
    desde: start,
    ate: Date.now(),
    total: totals,
    grupos,
    recentes,
  }
}

// A SAÚDE DA GERAÇÃO: "a IA ainda consegue falar?"
//
// Uma credencial revogada pode fazer todas as tentativas falharem enquanto a conta ainda
// parece conectada, com a barra em 0%. O freio de cota não
// pegou porque ele só age quando CONSEGUE ler o uso, e ali não havia leitura nenhuma.
//
// Esta leitura é o contrapeso: conta quantas gerações falharam DESDE o último sucesso. Uma
// falha isolada é ruído (rede, timeout); uma fila delas sem nenhum acerto no meio é a IA
// muda, e isso precisa aparecer antes de o dono descobrir pelas conversas paradas.
export function saudeGeracao() {
  const ultimoOk = db().prepare("SELECT MAX(ts) t FROM llm_usage WHERE status='ok'").get()?.t || 0
  const falhas = db().prepare(`
    SELECT COUNT(*) n, MIN(ts) desde, MAX(ts) ate FROM llm_usage
    WHERE status<>'ok' AND ts>?`).get(ultimoOk) || {}
  const ultima = db().prepare(`
    SELECT ts, account_name, error FROM llm_usage
    WHERE status<>'ok' AND ts>? ORDER BY ts DESC LIMIT 1`).get(ultimoOk) || null
  const falhasSeguidas = Number(falhas.n || 0)
  return {
    falhasSeguidas,
    ultimoOk: ultimoOk || null,
    mudaDesde: falhasSeguidas ? Number(falhas.desde) : null,
    ultimaFalhaEm: ultima ? Number(ultima.ts) : null,
    conta: ultima?.account_name || null,
    erro: ultima?.error ? String(ultima.error).slice(0, 200) : null,
    // Três seguidas sem UM acerto no meio já não é azar de rede: é canal quebrado.
    muda: falhasSeguidas >= 3,
  }
}
