// COBERTURA DE UM TURNO LONGO. Se o contato envia várias bolhas e a resposta devolve apenas
// uma, o corretor pede 2 ou 3 bolhas sobre frentes diferentes. A decisão usa contagem de
// strings; palavras só ajudam a nomear o que ficou de fora.

const VAZIAS = new Set(('a o e é de da do das dos em no na nos nas um uma uns umas pra para por com sem que se '
  + 'eu vc você tu meu minha meus minhas seu sua teu tua ele ela eles elas gente nos nós '
  + 'to tô ta tá tou estou está estava era foi fui vai vou ir ser sou sao são tem ter tinha teve '
  + 'mais menos muito pouco bem mal já ainda também tbm só so aqui ali la lá isso isto aquilo '
  + 'mas porem porém ou nem nao não sim kkk kk rs ne né tipo assim então entao mesmo cada toda todo '
  + 'quando onde como qual quais quem porque pq oq mt hj prs sabe fazer faço tenho quero gosto '
  + 'coisa coisas gente hoje ontem agora depois antes sobre acho').split(/\s+/))

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')

function conteudo(texto) {
  return [...new Set(semAcento(texto).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((p) => p.length >= 4 && !VAZIAS.has(p)))]
}

// O QUE ELA TROUXE E O RASCUNHO NÃO ENCOSTOU. Só pra NOMEAR na correção, nunca pra decidir
// se reprova: julgar cobertura de assunto por sobreposição de palavra é chute — "comédia"
// aparecer na explicação do BoJack não quer dizer que a IA falou do gosto dela por comédia.
// O que decide é uma coisa só, contável e sem interpretação: quantas bolhas ela mandou e
// quantas a resposta tem.
function largadas(rascunho, textos) {
  const noRascunho = new Set(conteudo(rascunho))
  const fora = []
  for (const texto of textos) {
    const palavras = conteudo(texto).filter((p) => !noRascunho.has(p))
    // a mais longa de cada mensagem dela: é a que carrega o assunto daquela bolha
    const marcante = palavras.sort((a, b) => b.length - a.length)[0]
    if (marcante) fora.push(marcante)
  }
  return [...new Set(fora)].slice(0, 4)
}

// `turnoDela` = os textos seguidos que ela mandou (o turno inteiro, não a última bolha).
export function oQueElaTrouxe(turnoDela) {
  const textos = (Array.isArray(turnoDela) ? turnoDela : [turnoDela])
    .map((m) => (typeof m === 'string' ? m : m?.text) || '').filter((s) => s.trim())
  return { textos, assuntos: conteudo(textos.join(' ')) }
}

// Uma bolha para um turno com três ou mais é a condição determinística que reprova.
export function assuntosLargados(rascunho, turnoDela, { minimoBolhasDela = 3 } = {}) {
  const { textos, assuntos } = oQueElaTrouxe(turnoDela)
  const bolhas = String(rascunho || '').split(/\n+/).map((s) => s.trim()).filter(Boolean).length
  if (textos.length < minimoBolhasDela || bolhas >= 2) {
    return { largou: false, largados: [], bolhas, bolhasDela: textos.length, total: assuntos.length }
  }
  return { largou: true, bolhas, bolhasDela: textos.length, total: assuntos.length, largados: largadas(rascunho, textos) }
}

// A correção. Nomeia o que ficou de fora e manda usar bolhas — o teto sempre foi 3.
export function instrucaoDeCobrirMais(r) {
  const nomes = r.largados.length ? ` Ficou de fora, por exemplo: ${r.largados.map((n) => `"${n}"`).join(', ')}.` : ''
  return `Ela mandou ${r.bolhasDela} mensagens e você respondeu com uma frase só.`
    + nomes
    + ` Isso corta a conversa de quem está se abrindo. Responda em 2 ou 3 bolhas (cada uma numa LINHA),`
    + ` cada uma sobre um assunto DIFERENTE que ela trouxe: responda o que ela perguntou, reaja ao que`
    + ` ela contou, comente o que ela citou. Não é lista nem resposta item por item — são falas soltas`
    + ` e curtas, como quem tem o que dizer sobre mais de um ponto.`
}
