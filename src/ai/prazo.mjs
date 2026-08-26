// O PRAZO DE UMA GERAÇÃO MORA AQUI, E SÓ AQUI.
//
// Em 04/08/2026 o botão "Gerar" falhou três vezes seguidas com "o servidor não respondeu".
// O servidor tinha respondido. Quem desistiu foi o NAVEGADOR, em 20s, enquanto a cadeia de
// geração (principal + correção de repetição) levava 22,4s e 23,3s. A quarta tentativa saiu
// limpa na primeira chamada, 10,9s, e por isso funcionou.
//
// Medido no llm_usage antes de mexer: 30% dos cliques em "Gerar" passavam de 20s, p50 11,8s,
// p90 52,1s, pior 66,0s; nas respostas automáticas, 50,6% das cadeias e a pior com 102,6s.
// Não era caso de borda: era o normal sempre que a cadeia de correção disparava. E os
// rascunhos ficavam PRONTOS — gerados, pagos em token, jogados fora porque a tela já tinha
// desistido.
//
// A causa não é o número 20000. É que existiam DOIS prazos independentes na mesma
// requisição: um digitado no navegador e nenhum na cadeia do servidor. Dois números que não
// se falam divergem — é questão de tempo, não de sorte. Por isso aqui existe UM, e o do
// cliente é DERIVADO dele, nunca digitado de novo.
//
// A invariante: o cliente nunca pode desistir antes do servidor.

// Teto de UMA chamada ao modelo. Não é escolha nossa: é o que codex.mjs já impõe
// (TURN_TIMEOUT_MS) e o que claude.mjs usa. Está aqui porque o orçamento da cadeia precisa
// saber o pior caso de uma chamada pra ser um teto de verdade, e não uma esperança.
export const TETO_CHAMADA_MS = 150_000

// Teto da CADEIA inteira (principal + correção de repetição + cobertura + estilo + filtro).
// Com a regra abaixo, este número é provado, não estimado: uma correção só COMEÇA se ainda
// couber uma chamada inteira dentro do orçamento, então o pior caso é
// (orçamento − teto de chamada) + teto de chamada = o próprio orçamento.
export const PRAZO_CADEIA_MS = 210_000

// O que o navegador espera ALÉM do servidor. Cobre rede, fila do event loop e a resposta
// voltando. Margem existe pra que o cliente desista DEPOIS, nunca antes.
export const MARGEM_CLIENTE_MS = 20_000

// O prazo do cliente. O painel é arquivo estático e não consegue importar isto, então lá o
// número aparece literal — e a guarda `prazo-do-cliente-menor-que-o-do-servidor` reprova o
// build se os dois discordarem. É essa guarda que substitui a boa vontade de quem edita.
export const prazoDoCliente = () => PRAZO_CADEIA_MS + MARGEM_CLIENTE_MS

// Cabe mais uma chamada dentro do orçamento?
//
// Note o que esta função NÃO faz: ela não mata chamada em voo. Uma geração que já está
// rodando termina, sempre. O que o orçamento decide é se vale COMEÇAR mais uma correção —
// e correção é opcional por construção (o código já dizia "melhor uma mensagem imperfeita
// que mensagem nenhuma"). Cortar aqui não perde trabalho, só deixa de apostar mais.
export function cabeMaisUmaChamada(inicioMs, agora = Date.now()) {
  return (agora - inicioMs) + TETO_CHAMADA_MS <= PRAZO_CADEIA_MS
}
