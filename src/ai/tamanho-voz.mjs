// A IA ESCREVE DEMAIS — e instrução no prompt não conserta isso.
//
// Medido em 31/07/2026, nas primeiras respostas automáticas dela contra as 18.666 mensagens
// reais da dona:
//
//                        ela      a IA
//   mediana              3 pal.   10 pal.
//   mensagens de 1-3     59,3%    0%
//   pergunta             8,6%     30%
//
// Três rodadas de instrução no prompt ("escreva curto", "pergunta é exceção", "não puxe
// assunto") e a mediana SUBIU. É o padrão conhecido: instrução de estilo o modelo obedece na
// primeira frase e esquece na terceira, porque escrever bonito é o comportamento default dele
// e escrever curto parece "resposta ruim".
//
// Então isto aqui não pede: mede o rascunho e manda reescrever. Mesmo caminho que o detector
// de "soou escrito" já usa neste arquivo — um sorteio novo, dizendo exatamente qual foi o
// defeito. Se na segunda o modelo ainda vier longo, aí sai assim mesmo: melhor uma mensagem
// comprida que uma conversa muda.
//
// O ALVO NÃO É "3 PALAVRAS SEMPRE". A mediana dela é 3, mas ela também escreve frases de 10
// quando o assunto pede. O que não existe no histórico dela é o padrão de SEMPRE elaborar:
// por isso o teto é por BOLHA e a régua da pergunta é por RESPOSTA.

const PALAVRAS_TETO_BOLHA = 10      // acima disso, é textão pro padrão dela
const PALAVRAS_ALVO_MEDIA = 8       // média das bolhas de uma resposta

// "Puxar assunto" tem cara: pergunta sobre a vida do outro que não foi provocada pelo que ele
// acabou de dizer. Aqui o proxy é mais simples e não erra: DUAS perguntas na mesma resposta,
// ou pergunta em bolha que já era a segunda. Ela não faz isso.
const PERGUNTAS_TETO = 1

export function medirRascunho(rascunho) {
  const bolhas = String(rascunho || '').split('\n').map((b) => b.trim()).filter(Boolean)
  if (!bolhas.length) return null
  const palavras = bolhas.map((b) => b.split(/\s+/).length)
  const perguntas = bolhas.filter((b) => b.includes('?')).length
  return {
    bolhas: bolhas.length,
    maiorBolha: Math.max(...palavras),
    mediaBolha: palavras.reduce((a, b) => a + b, 0) / bolhas.length,
    perguntas,
    total: palavras.reduce((a, b) => a + b, 0),
  }
}

// Devolve { longo, motivo } — `longo:true` significa "reescreva".
export function passouDoTamanho(rascunho) {
  const m = medirRascunho(rascunho)
  if (!m) return { longo: false }
  const motivos = []
  if (m.maiorBolha > PALAVRAS_TETO_BOLHA) motivos.push(`uma bolha com ${m.maiorBolha} palavras (o normal dela é até ${PALAVRAS_TETO_BOLHA})`)
  // A média só acusa quando há MAIS DE UMA bolha. Uma frase única de 9 palavras é normal no
  // histórico dela (uma frase inteira sobre de onde ela é, por exemplo); o que não é normal é a
  // resposta INTEIRA ser longa, e isso a média entre bolhas pega.
  if (m.bolhas > 1 && m.mediaBolha > PALAVRAS_ALVO_MEDIA) motivos.push(`média de ${m.mediaBolha.toFixed(0)} palavras por bolha (alvo: ${PALAVRAS_ALVO_MEDIA})`)
  if (m.perguntas > PERGUNTAS_TETO) motivos.push(`${m.perguntas} perguntas na mesma resposta (ela faz no máximo ${PERGUNTAS_TETO})`)
  return motivos.length ? { longo: true, motivo: motivos.join('; '), medida: m } : { longo: false, medida: m }
}

// ENCURTAR NÃO PODE SIGNIFICAR EMUDECER.
//
// Esta instrução mandava "não acrescente pergunta pra puxar assunto, não conte história" — e
// era aplicada mesmo quando o diagnóstico da conversa (src/ai/conversa-estado.mjs) tinha
// ACABADO de dizer que a conversa estava morrendo por falta de iniciativa. As duas regras
// brigavam e esta ganhava, porque roda depois: o rascunho que trazia algo dela era reescrito
// pra uma reação seca. Foi assim que a conversa virou "só o outro perguntando" (11/08/2026).
//
// Com `permitirIniciativa`, o encurtar continua encurtando — o que muda é que ele deixa UMA
// coisa dela sobreviver, em bolha curta. Curto e vazio não é a voz dela: a mediana é 2
// palavras, mas ela conta coisa (o assunto mais transversal dela é a própria rotina).
export function instrucaoDeEncurtar(v, { permitirIniciativa = false } = {}) {
  return [
    `A resposta anterior não é do jeito que ela escreve: ${v.motivo}.`,
    'Reescreva MUITO mais curto. A mediana dela é 2 palavras por mensagem e 67% do que ela escreve tem de 1 a 3 palavras.',
    // QUEBRAR, NÃO APAGAR. Ela escreve pouco POR BOLHA e manda 2,74 bolhas por vez — o
    // conteúdo cabe, o que não cabe é o parágrafo. Mandar "responda só ao que ele disse"
    // fazia a correção deletar o assunto em vez de reparti-lo: uma frase de 12 palavras
    // virou "Tenho ss" em cima de um "Tem assunto?" (11/08/2026).
    'NÃO APAGUE O QUE VOCÊ IA DIZER: quebre em 2 ou 3 bolhas curtas (uma frase por linha), que é como ela escreve. Cortar o conteúdo e responder só "ta bom"/"tenho sim" é pior que a mensagem longa.',
    permitirIniciativa
      ? 'Esta conversa está parada do seu lado: mantenha UMA coisa sua (algo que você fez, uma opinião curta) ou UMA pergunta sobre algo concreto que ele falou.'
      : 'Não acrescente assunto novo — mas o que já estava na resposta, mantenha.',
    'Se a resposta natural for "Blz", "Ta bom", "Sério?", "Delícia" ou "kk", é isso mesmo — mande isso e nada mais.',
  ].join(' ')
}
