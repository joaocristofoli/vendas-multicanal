// Quem opera este sistema — o nome e o gênero da pessoa, como DADO.
//
// POR QUE ESTE ARQUIVO EXISTE (aprendido clonando, e pago em erro real):
//
// O primeiro fork da linhagem já tinha tirado os FATOS de vida de dentro do código (ver
// `sobre-mim-fontes/pontes.json` e a guarda `licoes/identidade-de-outro-dono`). Mas o NOME de
// quem opera continuou literal em dezenas de strings que vão pro prompt do assistente e pra
// tela — `src/self/mapa.mjs` chegava a afirmar um fato de outra pessoa dentro do prompt.
// Clonar de novo exigia caçar nome próprio à mão, e um fork fez isso com substituição cega: o
// texto ficou com concordância quebrada ("O Fulana pediu", "a Fulana é avisado", "Ele segue
// 4280"). Prompt com gênero trocado é a IA falando errado sobre a própria dona.
//
// A regra que sai daqui: **nome de dono não é literal em .mjs, é dado** — mesma classe do
// fato biográfico. Trocar de dono é trocar um arquivo, e a concordância acompanha sozinha.
//
// De onde vem, nesta ordem (o mesmo desenho de TIM_LUGAR_BASE em src/core/db.mjs):
//   1. process.env.TIM_DONO — JSON {"nome":"...","genero":"f"|"m"}
//   2. /opt/<instância>/data/sobre-mim/dono.json — a identidade viva na VM
//   3. sobre-mim-fontes/dono.json — o repo, que cobre os testes no Mac
//   4. nada declarado -> NEUTRO ("quem opera"), nunca um nome inventado.
//
// Neutro é o padrão seguro, pela mesma razão que o banco nasce vazio: um sistema que não sabe
// de quem ele é diz "quem opera" e continua funcionando. Um que chuta, mente.
import fs from 'node:fs'

/**
 * O nome desta instância. Vem do ambiente no runtime; o literal aqui é só o padrão da
 * instalação e NÃO é identidade de pessoa — pode continuar literal sem risco.
 */
export const SISTEMA = process.env.TIM_SISTEMA || 'vendas-multicanal'

// O caminho da identidade viva ACOMPANHA a instância. Chumbar aqui o nome de uma instalação
// faria o clone seguinte ler o dono da anterior — que é exatamente o defeito que este arquivo
// existe pra matar.
const CAMINHO_VM = process.env.TIM_DONO_PATH || `/opt/${SISTEMA}/data/sobre-mim/dono.json`
const CAMINHO_REPO = new URL('../../sobre-mim-fontes/dono.json', import.meta.url).pathname

let cache = null

function ler() {
  if (cache) return cache
  let bruto = null
  if (process.env.TIM_DONO) {
    try { bruto = JSON.parse(process.env.TIM_DONO) } catch { bruto = null }
  }
  for (const caminho of [CAMINHO_VM, CAMINHO_REPO]) {
    if (bruto) break
    try { bruto = JSON.parse(fs.readFileSync(caminho, 'utf8')) } catch { /* não existe ainda: segue neutro */ }
  }
  const nome = typeof bruto?.nome === 'string' && bruto.nome.trim() ? bruto.nome.trim() : null
  // Gênero só vale se declarado. Não se infere de nome: "Alex" e "Darci" não dizem nada, e
  // errar aqui é a IA falando de quem ela representa com o gênero errado, para sempre.
  const genero = bruto?.genero === 'f' || bruto?.genero === 'm' ? bruto.genero : null
  cache = { nome, genero }
  return cache
}

/** Só para os testes: força reler depois de mudar env/arquivo. */
export function recarregarDono() { cache = null; return ler() }

/** O nome, quando declarado. Sem declaração, uma descrição — nunca um nome inventado. */
export function nomeDono() { return ler().nome || 'quem opera' }

/** true quando ninguém foi declarado ainda (instância recém-clonada). */
export function donoAnonimo() { return !ler().nome }

/** Gênero declarado no arquivo privado, ou null quando não foi informado. */
export function generoDonoDeclarado() { return ler().genero }

/**
 * Concordância de gênero. Sem gênero declarado, devolve `neutro` — e é por isso que todo
 * chamador é obrigado a ter uma terceira forma sem gênero, em vez de cair no masculino.
 */
export function flexao(masculino, feminino, neutro) {
  const { genero } = ler()
  if (genero === 'f') return feminino
  if (genero === 'm') return masculino
  return neutro
}

/** "a <nome>" / "o <nome>" / "quem opera" — sujeito. */
export function oDono() {
  const { nome } = ler()
  if (!nome) return 'quem opera'
  return `${flexao('o', 'a', '')} ${nome}`.trim()
}

/** "da <nome>" / "do <nome>" / "de quem opera" — posse. */
export function doDono() {
  const { nome } = ler()
  if (!nome) return 'de quem opera'
  return `${flexao('do', 'da', 'de')} ${nome}`
}

/** "à <nome>" / "ao <nome>" / "a quem opera" — objeto indireto. */
export function aoDono() {
  const { nome } = ler()
  if (!nome) return 'a quem opera'
  return `${flexao('ao', 'à', 'a')} ${nome}`
}

/** "pela <nome>" / "pelo <nome>" / "por quem opera" — agente da passiva. */
export function peloDono() {
  const { nome } = ler()
  if (!nome) return 'por quem opera'
  return `${flexao('pelo', 'pela', 'por')} ${nome}`
}

/** "ela" / "ele" / "essa pessoa" — pronome. */
export function pronomeDono() { return flexao('ele', 'ela', 'essa pessoa') }

/** "dela" / "dele" / "dessa pessoa" — posse pronominal. */
export function ddonoPossessivo() { return flexao('dele', 'dela', 'dessa pessoa') }
