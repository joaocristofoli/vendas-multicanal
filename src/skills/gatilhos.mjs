// GATILHOS: como uma skill roda SEM modelo nenhum no caminho.
//
// O dono perguntou: "mas a skill é um conjunto de prompts, né? não uma habilidade que não
// gasta tokens depois". A primeira metade estava errada — o index.mjs de uma skill é
// JavaScript, e rodar custa zero token. A segunda metade estava CERTA, e é o que este
// arquivo conserta.
//
// O buraco: uma skill que só o agente sabe invocar ainda precisa de um turno de modelo pra
// ser usada. O modelo lê "existe a skill X", decide chamar, chama. Isso é ferramenta — não
// é habilidade. Habilidade é o que o corpo faz sozinho.
//
// Um gatilho é a declaração de COMO a skill se pendura no caminho determinístico:
//
//   rota    -> vira endpoint HTTP. Qualquer coisa chama, inclusive o painel e o celular.
//   evento  -> o núcleo dispara quando o fato acontece (chegou áudio, chegou mensagem).
//   cron    -> roda de tempos em tempos.
//
// Nos três, o modelo está fora do laço. Ele foi gasto UMA vez, pra escrever o código e o
// gatilho. Depois disso a habilidade é do sistema, não da IA.
//
// Três travas que não são negociáveis aqui, porque gatilho é código de terceiro rodando no
// caminho quente do WhatsApp:
//   1. TIMEOUT por execução — skill lenta não pode segurar a fila de mensagens;
//   2. erro NUNCA sobe — uma skill quebrada não pode derrubar a ingestão;
//   3. interruptor geral (`skills_gatilhos`), porque tudo aqui tem que ter freio de mão.
import { getSetting, logEvent } from '../core/db.mjs'
import { listar, carregar } from './registro.mjs'
import { contarUso } from './economia.mjs'

const TIMEOUT_MS = Number(process.env.TIM_SKILL_GATILHO_TIMEOUT_MS || 30_000)

export function ligado() { return getSetting('skills_gatilhos', true) !== false }

// Os eventos que o núcleo REALMENTE emite. Lista fechada de propósito: gatilho num evento
// que não existe é uma skill que nunca roda e ninguém entende por quê.
export const EVENTOS = {
  mensagem_recebida: 'chegou mensagem de alguém (qualquer canal). dados: {personId, canal, texto, messageId, media}',
  audio_recebido: 'chegou um áudio e o arquivo já está em disco. dados: {personId, canal, arquivo, messageId}',
  mensagem_enviada: 'saiu mensagem nossa. dados: {personId, canal, texto, autor}',
  transcricao_pronta: 'um áudio acabou de ser transcrito. dados: {personId, canal, texto, messageId}',
  vinculo_criado: 'uma identidade nova foi ligada a uma pessoa. dados: {personId, canal, canalId}',
  boot: 'o vendas-multicanal subiu. dados: {}',
}

// Só skills PROVADAS ganham gatilho. Uma skill que nunca passou na prova rodando sozinha no
// caminho do WhatsApp seria o pior dos mundos.
function comGatilho(tipo) {
  const out = []
  for (const s of listar()) {
    if (!s.pronta) continue
    for (const g of (Array.isArray(s.gatilhos) ? s.gatilhos : [])) {
      if (g && g.tipo === tipo) out.push({ skill: s.nome, ...g })
    }
  }
  return out
}

function comTimeout(p, ms, oQue) {
  let t
  const limite = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${oQue} passou de ${Math.round(ms / 1000)}s`)), ms) })
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(t)), limite])
}

async function rodar(nome, ...args) {
  const mod = await carregar(nome)
  const fn = mod.skill || mod.default
  if (typeof fn !== 'function') throw new Error(`a skill "${nome}" não exporta skill()`)
  // Conta ANTES de rodar: um uso que falha ainda é um uso, e o que interessa medir é quantas
  // vezes o sistema resolveu isso sem modelo — não quantas deram certo.
  contarUso(nome)
  return comTimeout(fn(...args), TIMEOUT_MS, `a skill ${nome}`)
}

// ---------------------------------------------------------------- evento
// Chamado pelo núcleo quando o fato acontece. NENHUM modelo no caminho.
// Nunca lança: o retorno diz o que rodou e o que falhou, e o resto do sistema segue.
export async function dispararEvento(evento, dados = {}) {
  if (!ligado()) return { pulou: 'gatilhos desligados' }
  const alvos = comGatilho('evento').filter((g) => g.evento === evento)
  if (!alvos.length) return { rodaram: 0 }
  const resultados = []
  for (const g of alvos) {
    try {
      const r = await rodar(g.skill, dados)
      resultados.push({ skill: g.skill, ok: true, resultado: r })
      logEvent({ type: 'skill_gatilho', personId: dados.personId || null, channel: dados.canal || null, detail: `${g.skill} <- ${evento}` })
    } catch (e) {
      // erro de skill NUNCA sobe: ela é código de terceiro no caminho quente
      resultados.push({ skill: g.skill, ok: false, erro: e.message })
      logEvent({ type: 'skill_gatilho_erro', detail: `${g.skill} <- ${evento}: ${e.message}` })
    }
  }
  return { rodaram: resultados.length, resultados }
}

// ---------------------------------------------------------------- rota
// As rotas que as skills publicam. O núcleo consulta isto no roteador.
export function rotas() {
  return comGatilho('rota').map((g) => ({
    skill: g.skill,
    metodo: String(g.metodo || 'POST').toUpperCase(),
    caminho: g.caminho || `/api/skill/${g.skill}`,
  }))
}

export async function atenderRota({ metodo, caminho, corpo }) {
  const r = rotas().find((x) => x.caminho === caminho && x.metodo === String(metodo).toUpperCase())
  if (!r) return null
  if (!ligado()) return { status: 503, corpo: { ok: false, error: 'gatilhos de skill desligados' } }
  try {
    const resultado = await rodar(r.skill, corpo)
    logEvent({ type: 'skill_rota', detail: `${r.metodo} ${r.caminho} -> ${r.skill}` })
    return { status: 200, corpo: { ok: true, skill: r.skill, resultado } }
  } catch (e) {
    logEvent({ type: 'skill_rota_erro', detail: `${r.skill}: ${e.message}` })
    return { status: 500, corpo: { ok: false, skill: r.skill, error: e.message } }
  }
}

// ---------------------------------------------------------------- cron
// Guarda a última execução em memória: perder o relógio num restart é aceitável (roda mais
// cedo uma vez), enquanto gravar no banco a cada tick não vale o custo.
const ultimaVez = new Map()
export async function tickCron() {
  if (!ligado()) return { rodaram: 0 }
  const agora = Date.now()
  const resultados = []
  for (const g of comGatilho('cron')) {
    const cada = Math.max(1, Number(g.cadaMin || 60)) * 60_000
    const ultima = ultimaVez.get(g.skill) || 0
    if (agora - ultima < cada) continue
    ultimaVez.set(g.skill, agora)
    try {
      const r = await rodar(g.skill, g.args || {})
      resultados.push({ skill: g.skill, ok: true, resultado: r })
      logEvent({ type: 'skill_cron', detail: `${g.skill} (a cada ${g.cadaMin || 60}min)` })
    } catch (e) {
      resultados.push({ skill: g.skill, ok: false, erro: e.message })
      logEvent({ type: 'skill_cron_erro', detail: `${g.skill}: ${e.message}` })
    }
  }
  return { rodaram: resultados.length, resultados }
}

// O que o agente lê sobre gatilhos: curto, e só quando ele for criar um.
export function comoTexto() {
  const rs = rotas(), evs = comGatilho('evento'), crs = comGatilho('cron')
  return [
    'GATILHOS (como uma skill roda SEM modelo no caminho):',
    '  Declare em skill.json: "gatilhos": [{ "tipo": "rota", "metodo": "POST", "caminho": "/api/skill/<nome>" }]',
    '                                     [{ "tipo": "evento", "evento": "<um da lista>" }]',
    '                                     [{ "tipo": "cron", "cadaMin": 60 }]',
    '  Eventos que o núcleo emite:',
    ...Object.entries(EVENTOS).map(([k, v]) => `    ${k} — ${v}`),
    `  Hoje: ${rs.length} rota(s), ${evs.length} evento(s), ${crs.length} agendada(s).`,
    '  Só skill PROVADA ganha gatilho. Erro de skill nunca derruba o sistema, e há timeout por execução.',
  ].join('\n')
}
