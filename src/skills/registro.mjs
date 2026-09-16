// SKILLS: o que o vendas-multicanal APRENDEU a fazer.
//
// Regra do sistema (26/07/2026): "tudo que aprender, deve ser aprendido como uma skill ou
// plugin". O exemplo dele: se ele manda um áudio e a IA diz que não entende áudio, ele
// responde "então aprenda a transcrever" — e ela só termina quando estiver realmente
// ouvindo.
//
// Três decisões que fazem isso ser real e não um diretório de rascunhos:
//
// 1. SKILL SEM PROVA NÃO É SKILL. Todo skill nasce com um `prova.mjs` que DEFINE o que
//    "funcionando" significa, e o registro só chama de pronta a que passa. Sem isso, "está
//    pronto" seria opinião do modelo — e é exatamente aí que o trabalho morre pela metade.
//
// 2. MORA EM /opt/vendas-multicanal/app/skills — DENTRO do espaço de trabalho, e isso NÃO é descuido.
//    A cerca do agente é `sandbox: workspace-write`: ele escreve em /opt/vendas-multicanal/app e em mais
//    nada. Colocar as skills em /opt/vendas-multicanal/data (a ideia óbvia, "dados ficam em data") tornava
//    fisicamente impossível ele criar uma — provado ao vivo: duas voltas de missão gastas
//    com o agente anunciando "PROVADA" enquanto o registro não via nada. Tentei abrir uma
//    raiz extra de escrita no sandbox; o bwrap ignora.
//    Sobreviver ao deploy continua garantido, por outro caminho: o push.sh extrai APENAS os
//    diretórios do tarball, e `skills` não está nele — extração não apaga o que não veio.
//    O teste tests-tim/skills-e-missoes.mjs falha se alguém acrescentar `skills` ao push.
//
// 3. É CÓDIGO, NÃO PROMPT — E ISSO É VERIFICADO, NÃO PROMETIDO. A regra do dono: no
//    DESENVOLVIMENTO pode gastar quanto quiser de token; DEPOIS de descobrir como fazer,
//    não gasta mais. Uma skill cujo index.mjs chamasse modelo em tempo de uso quebraria
//    exatamente isso — e quebraria em silêncio, porque continuaria "funcionando". Então
//    `provar()` LÊ o código e REPROVA se achar chamada de IA. A cristalização deixa de ser
//    disciplina e vira propriedade do sistema.
//
// 4. TODA SKILL DECLARA A RECEITA: qual é o mecanismo que foi descoberto (endpoint, binário,
//    consulta, DOM) e como se chegou nele. É a diferença entre "aprendi" e "sei explicar o
//    que aprendi" — e é o que permite consertar quando o provedor mudar, sem redescobrir do
//    zero.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logEvent } from '../core/db.mjs'

const exec = promisify(execFile)
// Se localiza sozinho quando TIM_APP_DIR não está setado. Chumbar '/opt/vendas-multicanal/app' fazia o
// registro tentar criar diretório lá fora da VM (Mac, CI, outra nuvem) e estourar EACCES —
// e o vendas-multicanal é feito pra migrar de máquina, então caminho absoluto chumbado é bug de nascença.
const RAIZ = process.env.TIM_APP_DIR || path.resolve(new URL('../..', import.meta.url).pathname)
export const DIR = process.env.TIM_SKILLS_DIR || path.join(RAIZ, 'skills')
const PROVA_TIMEOUT_MS = Number(process.env.TIM_SKILL_PROVA_TIMEOUT_MS || 120_000)

// O que denuncia uma skill que voltou a depender de modelo em tempo de USO. Amplo de
// propósito: falso positivo custa renomear uma variável; falso negativo custa uma capacidade
// que parece cristalizada e sangra token em toda execução, pra sempre.
// Procura CHAMADA, não menção: `\s*\(` separa "chama o modelo" de "fala sobre chamar o
// modelo". Sem isso, um teste ou uma guarda que cita esses nomes seria barrado.
const CHEIRO_DE_LLM = /\b(getCodex|runAgentTurn|runTurn|turnoDeAgente|pensarCodex|generateDraft|generateReply)\s*\(|api\.(openai|anthropic)\.com/
export function usaModelo(codigo) { return CHEIRO_DE_LLM.test(String(codigo || '')) }

// Os mecanismos que contam como CRISTALIZADO. Fora desta lista, a capacidade não foi
// aprendida — foi terceirizada.
export const TIPOS_DE_RECEITA = {
  endpoint: 'chamada HTTP direta a uma API (a mais durável)',
  binario: 'um executável local (whisper, ffmpeg, um CLI)',
  consulta: 'SQL no próprio banco',
  navegador: 'Playwright no Chrome real — quando a API é assinada e não dá pra forjar',
  calculo: 'puro: parsing, regex, matemática, transformação de dados',
}

export function garantirDir() { fs.mkdirSync(DIR, { recursive: true }); return DIR }

const caminho = (nome) => path.join(DIR, String(nome).replace(/[^a-z0-9-]/gi, '-').toLowerCase())

// Um skill no disco. `pronta` só é true depois que a prova passou de verdade uma vez.
export function ler(nome) {
  const dir = caminho(nome)
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'skill.json'), 'utf8'))
    return { ...m, nome: m.nome || path.basename(dir), dir, temCodigo: fs.existsSync(path.join(dir, 'index.mjs')), temProva: fs.existsSync(path.join(dir, 'prova.mjs')) }
  } catch { return null }
}

export function listar() {
  garantirDir()
  const out = []
  for (const d of fs.readdirSync(DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const s = ler(d.name)
    if (s) out.push(s)
  }
  return out.sort((a, b) => (b.provadaEm || 0) - (a.provadaEm || 0))
}

// O índice pro prompt: nome + o que faz + quando usar. O código NÃO entra aqui.
//
// TETO DE PROPÓSITO. Medido em 26/07/2026: ~85 tokens por skill listada, por turno. Com 50
// skills isso vira ~4200 tokens em TODA mensagem, pra sempre — o oposto da economia que o
// resto do sistema persegue. Então o índice mostra as `max` mais recentemente provadas e
// diz quantas ficaram de fora; o agente puxa a lista inteira com `skill.mjs listar` se
// precisar. Mesmo princípio do mapa de si: saber onde está o catálogo, não decorar o catálogo.
//
// Skill com GATILHO não precisa nem aparecer aqui pro sistema usá-la: ela já roda sozinha
// (src/skills/gatilhos.mjs). O índice serve pro agente NÃO REESCREVER o que existe.
const TETO_INDICE = Number(process.env.TIM_SKILLS_INDICE_MAX || 12)

export function indice({ max = TETO_INDICE } = {}) {
  const s = listar()
  if (!s.length) return 'SKILLS APRENDIDOS: nenhum ainda.'
  const mostra = s.slice(0, max)
  const sobra = s.length - mostra.length
  return ['SKILLS APRENDIDOS (código pronto — use, não refaça):',
    ...mostra.map((x) => `  ${x.nome}${x.pronta ? '' : ' [NÃO PROVADO]'}${(x.gatilhos || []).length ? ' [roda sozinha]' : ''} — ${x.oQue}${x.quando ? ` | usar quando: ${x.quando}` : ''}`),
    sobra > 0 ? `  (+${sobra} outras — veja com: node tools/skill.mjs listar)` : null,
    '  Rode: node tools/skill.mjs rodar <nome> [args...]   |   detalhes: node tools/skill.mjs ver <nome>',
  ].filter(Boolean).join('\n')
}

// Cria o esqueleto. Deliberadamente exige `prova`: não dá pra criar um skill sem dizer como
// se verifica que ele funciona.
export function criar({ nome, oQue, quando = null, codigo = null, prova = null, comoFunciona = null, gatilhos = [], receita = null }) {
  if (!nome || !oQue) throw new Error('skill precisa de nome e de "oQue" (o que ela faz)')
  if (!prova) throw new Error('skill precisa de prova: o teste que define "funcionando". Sem prova, "pronto" vira opinião.')
  if (codigo && usaModelo(codigo)) throw new Error('o código da skill NÃO pode chamar modelo: descobrir gasta token uma vez, usar tem que custar zero. Resolva por endpoint, binário, SQL, navegador ou cálculo.')
  if (receita && !TIPOS_DE_RECEITA[receita.tipo]) throw new Error(`receita.tipo inválido: use um de ${Object.keys(TIPOS_DE_RECEITA).join(', ')}`)
  garantirDir()
  const dir = caminho(nome)
  fs.mkdirSync(dir, { recursive: true })
  const manifesto = { nome: path.basename(dir), oQue, quando, gatilhos, receita: receita || null, criadaEm: Date.now(), pronta: false, provadaEm: null, versao: 1 }
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify(manifesto, null, 2))
  if (codigo) fs.writeFileSync(path.join(dir, 'index.mjs'), codigo)
  fs.writeFileSync(path.join(dir, 'prova.mjs'), prova)
  if (comoFunciona) fs.writeFileSync(path.join(dir, 'COMO-FUNCIONA.md'), comoFunciona)
  logEvent({ type: 'skill_criada', detail: `${manifesto.nome}: ${oQue}` })
  return ler(manifesto.nome)
}

// RODA A PROVA. É a única coisa que decide se um skill está pronto.
// Sai 0 = passou. Qualquer outra coisa = não passou, e a saída volta inteira pra quem
// estiver consertando (é o que alimenta o laço da missão).
export async function provar(nome) {
  const s = ler(nome)
  if (!s) return { ok: false, saida: `skill "${nome}" não existe` }
  const arq = path.join(s.dir, 'prova.mjs')
  if (!fs.existsSync(arq)) return { ok: false, saida: 'essa skill não tem prova.mjs' }

  // A PENEIRA, verificada a CADA prova (não só na criação: o arquivo pode ser editado depois).
  // Uma skill que chama modelo em tempo de uso não é uma capacidade cristalizada — é um
  // atalho que vai sangrar token pra sempre, sem ninguém notar.
  const fonteSkill = (() => { try { return fs.readFileSync(path.join(s.dir, 'index.mjs'), 'utf8') } catch { return '' } })()
  if (usaModelo(fonteSkill)) {
    return { ok: false, saida: [
      'REPROVADA: o index.mjs desta skill chama modelo de IA em tempo de uso.',
      'A regra é: no desenvolvimento pode gastar token à vontade; depois de descobrir COMO fazer, usar tem que custar zero.',
      `Refaça o mecanismo como um destes: ${Object.keys(TIPOS_DE_RECEITA).join(', ')}.`,
      'Se a tarefa for genuinamente de linguagem (redigir texto novo), então ela não é uma skill — é um caminho do assistente.',
    ].join('\n') }
  }
  if (!s.receita) {
    return { ok: false, saida: [
      'REPROVADA: skill sem `receita` no skill.json.',
      'Declare o mecanismo que você descobriu, senão ninguém consegue consertar quando o provedor mudar — vai ter que redescobrir do zero.',
      '  "receita": { "tipo": "endpoint|binario|consulta|navegador|calculo", "mecanismo": "...", "comoFoiDescoberto": "...", "porQueNaoPrecisaDeModelo": "..." }',
    ].join('\n') }
  }

  let ok = false, saida = ''
  try {
    const r = await exec(process.execPath, [arq], { timeout: PROVA_TIMEOUT_MS, cwd: s.dir, env: { ...process.env } })
    saida = `${r.stdout || ''}${r.stderr || ''}`.trim()
    ok = true
  } catch (e) {
    saida = `${e.stdout || ''}${e.stderr || ''}${e.message ? '\n' + e.message : ''}`.trim()
    ok = false
  }
  // O manifesto guarda o VEREDITO, com data. "pronta" nunca é escrita à mão.
  try {
    const m = JSON.parse(fs.readFileSync(path.join(s.dir, 'skill.json'), 'utf8'))
    m.pronta = ok
    m.provadaEm = ok ? Date.now() : m.provadaEm || null
    m.ultimaProva = { ok, em: Date.now(), saida: saida.slice(-1500) }
    fs.writeFileSync(path.join(s.dir, 'skill.json'), JSON.stringify(m, null, 2))
  } catch { /* manifesto quebrado não pode derrubar a prova */ }
  logEvent({ type: ok ? 'skill_provada' : 'skill_falhou', detail: `${nome}: ${saida.slice(0, 200)}` })
  return { ok, saida: saida.slice(-4000) }
}

export async function provarTodas() {
  const r = []
  for (const s of listar()) r.push({ nome: s.nome, ...(await provar(s.nome)) })
  return r
}

// Carrega o módulo do skill pra usar de dentro do vendas-multicanal.
//
// A query `?v=` NÃO é enfeite e o valor dela importa: o ESM cacheia módulo por URL, pra
// sempre, dentro do processo. Com um número fixo (a `versao` do manifesto, que ninguém
// incrementa), uma skill consertada no disco continuaria rodando a versão VELHA até o
// próximo restart — e o conserto pareceria não ter funcionado, sem erro nenhum. O teste
// pegou isso: a skill quebrada de propósito continuou devolvendo o resultado bom.
//
// A chave é o HASH DO CONTEÚDO, não o mtime. Tentei mtime primeiro e o teste reprovou: duas
// escritas no mesmo milissegundo produzem o mesmo carimbo, o cache não é invalidado e a
// versão velha continua rodando. Isso não é caso de laboratório — é exatamente o que
// acontece quando o agente conserta uma skill e a prova roda em seguida.
// Hash de um arquivo de 1KB é barato; carregar código errado achando que é o certo, não.
export async function carregar(nome) {
  const s = ler(nome)
  if (!s) throw new Error(`skill "${nome}" não existe`)
  if (!s.temCodigo) throw new Error(`skill "${nome}" não tem index.mjs`)
  const arq = path.join(s.dir, 'index.mjs')
  const chave = (() => {
    try { return crypto.createHash('sha1').update(fs.readFileSync(arq)).digest('hex').slice(0, 12) }
    catch { return String(Date.now()) }
  })()
  return import(`${arq}?v=${chave}`)
}

export function apagar(nome) {
  const s = ler(nome)
  if (!s) return false
  fs.rmSync(s.dir, { recursive: true, force: true })
  logEvent({ type: 'skill_apagada', detail: nome })
  return true
}
