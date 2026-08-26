// Detector de texto que soa escrito em vez de falado.
//
// O mecanismo é estrutural: uma frase única, longa, com duas orações ligadas por vírgula e
// pergunta trabalhada no fim. O exemplo de reescrita nunca mora no código; vem da identidade
// privada em sobre-mim-fontes/exemplos-voz.json.
import fs from 'node:fs'
import { doDono, oDono, pronomeDono } from '../core/dono.mjs'
import { EXEMPLOS_VOZ_PATH } from '../core/caminhos.mjs'

// Isto fica em código porque é uma checagem determinística posterior à geração. Repetir a
// orientação no prompt não substitui a validação da forma final.

const RISADA = /\b(k{2,}|rs+|ha(ha)+|hue+)\b|😂|🤣/i

// Uma frase só, com vírgula juntando duas orações, terminando em pergunta, sem risada. É o
// formato que o filtro precisa reconhecer mesmo quando o perfil privado estiver vazio.
export function soouEscrito(texto) {
  const t = String(texto || '').trim()
  // Abaixo de 40 caracteres não há espaço pra soar escrito, e cobrar isso de um "Bom dia"
  // seria absurdo. Duas bolhas já têm forma de fala, então também passam.
  if (t.length < 40 || t.includes('\n')) return { escrito: false, marcas: [] }
  if (!/\w,\s\w/.test(t) || !/\?\s*$/.test(t) || RISADA.test(t)) return { escrito: false, marcas: [] }
  return { escrito: true, marcas: ['frase única com vírgula juntando duas orações e pergunta no fim, sem risada'] }
}

// A correção. Mostra o formato em vez de descrever: o exemplo é quem opera reescrevendo a
// mensagem ruim, e é mais barato pro modelo copiar um jeito do que interpretar um adjetivo.
//
// O EXEMPLO É DADO, NÃO CÓDIGO (01/08/2026). Até a segunda clonagem, o par (frase da IA,
// reescrita humana) vinha CHUMBADO aqui — com uma frase real da dona anterior, indo pro
// prompt. Não é um detalhe de estilo: um exemplo de voz é a instrução mais forte que existe
// num prompt, então o sistema estava ensinando a IA a escrever como OUTRA pessoa. Agora vem
// de sobre-mim-fontes/exemplos-voz.json. Sem o arquivo, a instrução sai só com a descrição do
// mecanismo — pior instrução, mas honesta. Mesma regra das pontes: sem fato, sem invenção.
export function instrucaoDeFalarAssim() {
  const base = 'Isso saiu como frase de redação: duas orações amarradas por vírgula e uma pergunta trabalhada no fim.'
    + ` ${oDono()} não escreve assim. Quebre em duas bolhas (uma quebra de linha), ou emende com "e"/"mas",`
    + ' ou ponha um kkk no lugar da vírgula. A pergunta do fim pode ser banal.'
  const ex = exemploDeReescrita()
  if (!ex) return base
  return base
    + ` Exemplo ${doDono()} reescrevendo uma mensagem sua:`
    + ` em vez de "${ex.ruim}"`
    + ` ${pronomeDono()} escreveria "${ex.bom}" — mais solto, mais impreciso, menos caprichado. Mesmo conteúdo, outra boca.`
}

// Lê o exemplo da identidade. Mesmo desenho de src/core/dono.mjs: env, runtime da VM, repo.
let cacheEx
function exemploDeReescrita() {
  if (cacheEx !== undefined) return cacheEx
  const caminhos = [
    process.env.TIM_EXEMPLOS_VOZ_PATH,
    EXEMPLOS_VOZ_PATH,
    new URL('../../sobre-mim-fontes/exemplos-voz.json', import.meta.url).pathname,
  ].filter(Boolean)
  cacheEx = null
  for (const c of caminhos) {
    try {
      const j = JSON.parse(fs.readFileSync(c, 'utf8'))
      const r = j?.reescrita
      if (r && typeof r.ruim === 'string' && typeof r.bom === 'string' && r.ruim.trim() && r.bom.trim()) {
        cacheEx = { ruim: r.ruim.trim(), bom: r.bom.trim() }
        break
      }
    } catch { /* não existe ainda: segue sem exemplo */ }
  }
  return cacheEx
}

/** Só para os testes. */
export function recarregarExemplos() { cacheEx = undefined; return exemploDeReescrita() }
