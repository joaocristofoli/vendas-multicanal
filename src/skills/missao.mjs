// MISSÃO: um objetivo que não termina quando o modelo acha que terminou, e sim quando a
// PROVA passa.
//
// O dono descreveu isso com um exemplo: ele manda um áudio, a IA diz que não entende áudio,
// ele responde "então aprenda a transcrever" — e a coisa só acaba quando ela estiver
// realmente ouvindo. "Se falhar acontece, mas a ideia é que ela cumpra a missão."
//
// Três propriedades que separam isso de "pedir de novo até dar certo":
//
// 1. A PROVA VEM PRIMEIRO, E RODA ANTES DE QUALQUER TRABALHO. A volta 0 só verifica. Se já
//    funciona, a missão termina em segundos dizendo "já sei fazer, aqui está o comprovante" —
//    em vez de reescrever algo que estava certo. (Foi o caso real do áudio: o vendas-multicanal já
//    transcrevia, com 192 transcrições no banco.)
//
// 2. A FALHA VOLTA INTEIRA PRO AGENTE. A saída da prova é o que ele lê na volta seguinte.
//    Sem isso ele conserta no escuro e o laço vira sorteio.
//
// 3. SOBREVIVE AO PROCESSO. O estado mora no banco, e um tick retoma. Missão que morre no
//    deploy é missão que o dono nunca vê terminar — e este projeto já foi mordido por isso
//    (a geração órfã de 25/07). Um deploy no meio de uma missão é o caso COMUM aqui, porque
//    o próprio agente faz deploy pra testar o que escreveu.
import { db, logEvent } from '../core/db.mjs'
import { provar, ler as lerSkill, indice as indiceSkills, DIR as DIR_SKILLS } from './registro.mjs'
import { registrarDescoberta } from './economia.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'
import { oDono } from '../core/dono.mjs'
import { APP_DIR } from '../core/caminhos.mjs'

const exec = promisify(execFile)
const RAIZ = APP_DIR

// Quantos tokens a conta ativa já gastou na vida. Devolve null quando não dá pra saber, e
// aí a contabilidade simplesmente não registra, em vez de inventar um número.
//
// DUAS PROTEÇÕES, e as duas nasceram de um defeito real que eu mesmo causei aqui:
//   1. só mede quando o cérebro é o DE VERDADE. Com cérebro injetado (teste) não há gasto
//      pra medir, e subir um app-server só pra descobrir isso travou a suíte inteira.
//   2. TIMEOUT curto. Contabilidade é acessório: se demorar, desiste e devolve null. O que
//      não pode é a medição do custo custar mais que o que ela mede.
const TIMEOUT_CONTA_MS = 8000
async function lerTokensDaConta(medir) {
  if (!medir) return null
  try {
    const { getCodex } = await import('../ai/codex.mjs')
    const o = await Promise.race([
      getCodex().accountOverview(),
      new Promise((r) => setTimeout(() => r(null), TIMEOUT_CONTA_MS)),
    ])
    const n = o?.usage?.summary?.lifetimeTokens
    return Number.isFinite(n) ? n : null
  } catch { return null }
}
const CMD_TIMEOUT_MS = Number(process.env.TIM_MISSAO_CMD_TIMEOUT_MS || 180_000)

export function garantirTabela() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS missao (
      id TEXT PRIMARY KEY, objetivo TEXT, prova_cmd TEXT, skill TEXT,
      estado TEXT,             -- em_andamento | cumprida | desistiu | cancelada
      voltas INTEGER DEFAULT 0, max_voltas INTEGER DEFAULT 6,
      ultima_saida TEXT, criada_em INTEGER, atualizada_em INTEGER, origem TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_missao_estado ON missao(estado, atualizada_em);
  `)
}

const agora = () => Date.now()
const id = () => 'ms:' + crypto.randomBytes(5).toString('hex')

export function criar({ objetivo, provaCmd = null, skill = null, maxVoltas = 6, origem = 'humano' }) {
  garantirTabela()
  const m = { id: id(), objetivo: String(objetivo).trim(), prova_cmd: provaCmd, skill, estado: 'em_andamento', voltas: 0, max_voltas: maxVoltas, ultima_saida: null, criada_em: agora(), atualizada_em: agora(), origem }
  db().prepare(`INSERT INTO missao(id,objetivo,prova_cmd,skill,estado,voltas,max_voltas,ultima_saida,criada_em,atualizada_em,origem)
    VALUES(@id,@objetivo,@prova_cmd,@skill,@estado,@voltas,@max_voltas,@ultima_saida,@criada_em,@atualizada_em,@origem)`).run(m)
  logEvent({ type: 'missao_criada', detail: `${m.id}: ${m.objetivo}` })
  return m
}

export function pegar(idm) { garantirTabela(); return db().prepare(`SELECT * FROM missao WHERE id=?`).get(idm) || null }
export function emAndamento() { garantirTabela(); return db().prepare(`SELECT * FROM missao WHERE estado='em_andamento' ORDER BY atualizada_em ASC`).all() }
export function listar(limite = 20) { garantirTabela(); return db().prepare(`SELECT * FROM missao ORDER BY criada_em DESC LIMIT ?`).all(limite) }
export function cancelar(idm) { garantirTabela(); db().prepare(`UPDATE missao SET estado='cancelada', atualizada_em=? WHERE id=? AND estado='em_andamento'`).run(agora(), idm); return pegar(idm) }

function atualizar(idm, campos) {
  const set = Object.keys(campos).map((k) => `${k}=@${k}`).join(', ')
  db().prepare(`UPDATE missao SET ${set}, atualizada_em=@t WHERE id=@id`).run({ ...campos, id: idm, t: agora() })
  return pegar(idm)
}

// Roda a prova da missão. Duas formas: um skill (roda a prova dele) ou um comando cru.
export async function rodarProva(m) {
  if (m.skill) {
    const s = lerSkill(m.skill)
    // A falha tem que ENSINAR o caminho, não só constatar. Na primeira missão real o agente
    // criou a skill dentro do repo (src/skills/bundled/...) e anunciou "PROVADA"; o registro
    // não a viu e a mensagem "não existe" não dizia onde ela deveria estar. Erro que não
    // ensina faz o laço gastar uma volta inteira redescobrindo a mesma coisa.
    if (!s) return { ok: false, saida: [
      `a skill "${m.skill}" não existe no registro.`,
      `Skills moram em ${DIR_SKILLS}/<nome>/ — dentro do seu espaço de trabalho, que é o único lugar onde você tem permissão de escrita. Não crie em outro caminho: o registro não enxerga e a prova nunca vai passar.`,
      `Crie SEMPRE pelo comando, nunca à mão:`,
      `  node tools/skill.mjs criar ${m.skill} --oque "..." --quando "..."`,
      `Depois implemente ${DIR_SKILLS}/${m.skill}/index.mjs e troque prova.mjs por um caso real.`,
      `Confira com: node tools/skill.mjs listar`,
    ].join('\n') }
    return provar(m.skill)
  }
  if (!m.prova_cmd) return { ok: false, saida: 'esta missão ainda não tem prova definida' }
  try {
    const r = await exec('/bin/bash', ['-lc', m.prova_cmd], { timeout: CMD_TIMEOUT_MS, cwd: RAIZ, env: { ...process.env } })
    return { ok: true, saida: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-4000) }
  } catch (e) {
    return { ok: false, saida: `${e.stdout || ''}${e.stderr || ''}${e.message ? '\n' + e.message : ''}`.trim().slice(-4000) }
  }
}

// O que o agente lê a cada volta. Curto e específico: o objetivo, o estado da prova, e o que
// exatamente falhou. Nada de "tente de novo".
function promptDaVolta(m, prova) {
  return [
    `MISSÃO (volta ${m.voltas + 1} de ${m.max_voltas}) — ${oDono()} pediu isto e não aceita "tentei":`,
    m.objetivo,
    '',
    'REGRAS DESTA MISSÃO:',
    '- O que decide se acabou é a PROVA passar, não a sua avaliação. Rode a prova você mesmo antes de dizer qualquer coisa.',
    '- O aprendizado tem que virar SKILL: código que fica, não explicação. Crie com `node tools/skill.mjs criar` e implemente o index.mjs.',
    '- Skill sem prova.mjs não conta. A prova é o que define "funcionando" — escreva ela primeiro, com um caso real, não um mock.',
    '- Prefira função determinística (endpoint, binário, SQL, Playwright) a chamar modelo em tempo de uso.',
    m.skill ? `- A skill desta missão se chama "${m.skill}". Prova: node tools/skill.mjs provar ${m.skill}` : `- Prova desta missão: ${m.prova_cmd || '(você ainda precisa defini-la — crie a skill e a prova)'}`,
    '',
    indiceSkills(),
    '',
    prova ? `RESULTADO DA PROVA AGORA (é isto que falta consertar):\n${prova.ok ? 'PASSOU' : 'FALHOU'}\n${prova.saida || '(sem saída)'}` : 'A prova ainda não foi rodada.',
    '',
    'Trabalhe. Ao terminar a volta, diga em uma linha o que mudou e por quê.',
  ].join('\n')
}

// UMA volta. Devolve a missão atualizada. Quem chama decide quando chamar de novo (o tick).
// `pensar` é injetável pra testar o laço sem gastar modelo.
export async function umaVolta(idm, { pensar } = {}) {
  const m = pegar(idm)
  if (!m || m.estado !== 'em_andamento') return m

  // 1. VERIFICA ANTES DE TRABALHAR. Se já funciona, acabou — inclusive na volta 0.
  const antes = await rodarProva(m)
  if (antes.ok) {
    logEvent({ type: 'missao_cumprida', detail: `${m.id} em ${m.voltas} volta(s): ${m.objetivo}` })
    return atualizar(m.id, { estado: 'cumprida', ultima_saida: antes.saida })
  }

  if (m.voltas >= m.max_voltas) {
    logEvent({ type: 'missao_desistiu', detail: `${m.id} depois de ${m.voltas} voltas: ${antes.saida.slice(0, 200)}` })
    return atualizar(m.id, { estado: 'desistiu', ultima_saida: antes.saida })
  }

  // 2. Trabalha uma volta, com a falha inteira na mão.
  // O custo da descoberta é MEDIDO, não estimado: o delta de `lifetimeTokens` da conta
  // OpenAI entre antes e depois do turno. É o número que sustenta a promessa "gasta na
  // descoberta, não gasta no uso" — sem ele seria só uma frase bonita.
  const medirCusto = !pensar   // cérebro injetado = teste: não há token pra medir
  const tokensAntes = await lerTokensDaConta(medirCusto)
  const fn = pensar || (await import('../assistente/codex-modo.mjs')).pensarCodex
  let saidaAgente = ''
  try {
    const r = await fn({ mensagem: promptDaVolta(m, antes), timeoutMs: 900_000 })
    saidaAgente = String(r?.text || '').slice(0, 2000)
  } catch (e) {
    saidaAgente = `o agente falhou nesta volta: ${e.message}`
  }

  // 3. Verifica de novo. É este segundo teste que fecha a volta.
  const tokensDepois = await lerTokensDaConta(medirCusto)
  const gasto = (tokensAntes != null && tokensDepois != null) ? Math.max(0, tokensDepois - tokensAntes) : 0
  if (m.skill && gasto) registrarDescoberta({ skill: m.skill, tokens: gasto, voltas: 1 })
  const depois = await rodarProva(m)
  const novo = atualizar(m.id, {
    voltas: m.voltas + 1,
    estado: depois.ok ? 'cumprida' : 'em_andamento',
    ultima_saida: `${saidaAgente}\n---- prova ----\n${depois.saida}`.slice(-4000),
  })
  logEvent({ type: depois.ok ? 'missao_cumprida' : 'missao_volta', detail: `${m.id} volta ${m.voltas + 1}: ${depois.ok ? 'PASSOU' : depois.saida.slice(0, 160)}` })
  return novo
}

// O tick: uma missão por vez, uma volta por tick. Serializado de propósito — duas missões
// mexendo no mesmo código ao mesmo tempo é receita de conflito.
let rodando = false
export async function tick({ pensar, avisar } = {}) {
  if (rodando) return { pulou: 'já tem uma volta rodando' }
  const fila = emAndamento()
  if (!fila.length) return { pulou: 'nada em andamento' }
  rodando = true
  try {
    const antes = fila[0]
    const m = await umaVolta(antes.id, { pensar })
    if (m && m.estado !== 'em_andamento' && avisar) {
      const texto = m.estado === 'cumprida'
        ? `missão cumprida em ${m.voltas} volta(s): ${m.objetivo}\n${String(m.ultima_saida || '').split('\n').slice(-6).join('\n')}`
        : `não consegui cumprir "${m.objetivo}" em ${m.voltas} voltas. O que trava:\n${String(m.ultima_saida || '').split('\n').slice(-8).join('\n')}`
      try { await avisar(texto) } catch { /* aviso nunca derruba a missão */ }
    }
    return { missao: m }
  } finally { rodando = false }
}
