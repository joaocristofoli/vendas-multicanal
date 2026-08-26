// O RASCUNHO QUE FICOU PRONTO DEPOIS QUE A TELA DESISTIU.
//
// Cinto do prazo (ver `src/ai/prazo.mjs`). Mesmo com o prazo do cliente derivado do
// orçamento do servidor, sobra um caso: a rede caiu, a aba dormiu, o pessoa operadora fechou o drawer.
// Sem isto, o rascunho que já estava pronto vira lixo — foi exatamente o que aconteceu nas
// três tentativas de 04/08/2026: o texto existiu, foi pago em token, e ninguém viu.
//
// Regra: quem gera guarda; quem perdeu a resposta busca UMA vez pelo mesmo `pedido`.
//
// É memória, não banco, de propósito. Um rascunho vale minutos: se o tim-core reiniciou, a
// requisição morreu junto e não há o que recuperar. Tabela aqui só criaria migração,
// varredura e um lugar a mais guardando texto íntimo sem precisar.

const TTL_MS = 10 * 60 * 1000
const TETO = 50

const pendentes = new Map() // pedido -> { texto, ts, extra }

function limpar(agora = Date.now()) {
  for (const [k, v] of pendentes) if (agora - v.ts > TTL_MS) pendentes.delete(k)
  // teto duro: Map preserva ordem de inserção, então os mais velhos saem primeiro
  while (pendentes.size > TETO) pendentes.delete(pendentes.keys().next().value)
}

// `pedido` vem do painel e é opaco aqui. Sem pedido não guarda nada: é o caminho de quem
// chamou a rota por fora do painel, e ali não há tela pra recuperar.
export function guardarRascunho(pedido, texto, extra = null) {
  if (!pedido || typeof pedido !== 'string' || !texto) return
  limpar()
  pendentes.set(String(pedido).slice(0, 64), { texto, ts: Date.now(), extra })
}

// Uso único: entregar duas vezes o mesmo rascunho é como ele reaparece sozinho depois de o
// pessoa operadora já ter apagado o texto da caixa.
export function pegarRascunho(pedido) {
  if (!pedido) return null
  limpar()
  const k = String(pedido).slice(0, 64)
  const v = pendentes.get(k)
  if (!v) return null
  pendentes.delete(k)
  return v
}

export function quantosPendentes() { limpar(); return pendentes.size }
