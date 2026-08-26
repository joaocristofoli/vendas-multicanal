// Repetição é detectada antes do envio. A mensagem anterior da
// própria IA está no histórico que ela lê. Ela não está puxando o fato da memória, está
// copiando a si mesma — é a coisa mais provável de escrever, porque acabou de escrever.
// Instrução de prompt ("não se repita") não resolve isso: o modelo não sabe que repetiu,
// já que pra ele cada geração é a primeira. Quem sabe é quem tem as duas mensagens na mão,
// e isso é uma comparação de strings.
//
// RECEITA: tira as palavras vazias e procura as palavras de conteúdo que o rascunho REPETE
// das mensagens que a IA já mandou — descontando as que ELA também usou.
//
// Esse desconto é o coração da coisa, e a primeira versão não tinha: sem ele, "Legislação
// deve ser tensa" seria acusado de repetir "Legislação" logo depois de ela dizer
// "Legislação", que é justamente a conversa funcionando. Palavra que os dois usam é o
// ASSUNTO e tem que voltar; palavra que só eu repito sou eu me repetindo.
//
// A comparação é de palavras de assunto, não apenas de frase literal.
//
// Zero token, mesmo resultado sempre.

// Palavras que aparecem em tudo e não dizem nada sobre o ASSUNTO. Sem cortar isto,
// "eu acho que" casaria com "eu acho que" e todo rascunho seria acusado de repetição.
const VAZIAS = new Set(('a o e é de da do das dos em no na nos nas um uma uns umas pra para por com sem que se '
  + 'eu vc você tu meu minha meus minhas seu sua teu tua ele ela eles elas a gente nós '
  + 'to tô ta tá tou estou está estava era foi vai vou ir ser sou sao são tem ter tinha teve '
  + 'mais menos muito pouco bem mal já ainda também tbm só so aqui ali la lá isso isto aquilo '
  + 'mas porem porém e ou nem nao não sim kkk kk rs ne né tipo assim então entao '
  + 'quando onde como qual quais quem porque pq o que oq').split(/\s+/))

const normal = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

function conteudo(texto) {
  return normal(texto).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((p) => p.length >= 3 && !VAZIAS.has(p))
}

const conjunto = (textos) => {
  const s = new Set()
  for (const t of textos || []) for (const p of conteudo(t)) s.add(p)
  return s
}

// O que o rascunho repete de mim mesmo. `quantas` limita à janela recente: contar a mesma
// coisa depois de trinta mensagens é lembrança, depois de duas é disco riscado.
export function jaDisseIsso(rascunho, minhasAnteriores, { delaAnteriores = [], quantas = 6 } = {}) {
  const novas = conteudo(rascunho)
  if (novas.length < 2) return { repetiu: false, palavras: [] }
  const minhas = conjunto((Array.isArray(minhasAnteriores) ? minhasAnteriores : []).slice(-quantas))
  if (!minhas.size) return { repetiu: false, palavras: [] }
  // O desconto: o que ELA trouxe é o assunto da conversa e pode (deve) voltar na minha boca.
  const dela = conjunto((Array.isArray(delaAnteriores) ? delaAnteriores : []).slice(-quantas))
  const repetidas = [...new Set(novas)].filter((p) => minhas.has(p) && !dela.has(p))
  // Duas palavras de conteúdo minhas voltando é a mesma história de novo ("mestrado" +
  // "constancia"). Uma só é coincidência de vocabulário, e brigar com isso seria brigar com
  // a conversa ter tema.
  return { repetiu: repetidas.length >= 2, palavras: repetidas.slice(0, 6) }
}

// A correção que vai pro modelo. Nomeia o que não pode voltar, e manda trocar o miolo em vez
// de reescrever com outras palavras — trocar as palavras e manter a história é o mesmo
// defeito com outra roupa.
export function instrucaoDeNaoRepetir(r) {
  const trechos = r.palavras.map((p) => `"${p}"`).join(', ')
  return `Você já falou disso nesta conversa — está repetindo ${trechos}. Não conte a mesma história de novo,`
    + ` nem com outras palavras. Traga uma coisa DIFERENTE sua, ou reaja ao que ela acabou de falar sem`
    + ` puxar o mesmo assunto pela segunda vez.`
}
