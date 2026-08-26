// Separa preço comercial de pedido pessoal para que um fluxo nunca contamine o outro.
//
//   NECESSIDADE — ELA pede. Três tempos. Chave só com o sim.
//   SERVIÇO / FATAL — ELES pedem (preço, horário, disponibilidade). Ela cotiza. Não pede ajuda.
//
// O caminho é determinístico: etiqueta de cliente/serviço abre o catálogo comercial.
import { etiquetasDaPessoa } from './etiquetas.mjs'
import { etiquetaFatal } from './origem-fatal.mjs'
import { ehClienteDeServico } from './atendimento.mjs'
import { apegoNecessidadeBlock } from './apego-necessidade.mjs'

export function pessoaDaFatal(personId) {
  if (!personId) return false
  try {
    const etq = etiquetaFatal()
    if (!etq) return false
    return etiquetasDaPessoa(personId).some((e) => Number(e.id) === Number(etq.id))
  } catch { return false }
}

export function caminhoDinheiro(personId) {
  try {
    if (pessoaDaFatal(personId) || ehClienteDeServico(personId)) return 'servico'
  } catch { /* banco parcial: necessidade é o caminho fechado */ }
  return 'necessidade'
}

const NECESSIDADE = [
  'PEDIDO PESSOAL: esta capacidade não é preço de serviço e nasce DESLIGADA na edição pública.',
  '- Só use após autorização explícita e consciente de quem opera para esta pessoa.',
  '- Seja honesto, direto e faça no máximo um pedido. Não use intimidade, sexo, foto, culpa, urgência falsa ou recompensa como pressão.',
  '- Chave PIX só depois de a pessoa pedir os dados ou aceitar claramente ajudar.',
  '- Hesitação, recusa ou silêncio encerram o pedido. Não insista.',
].join('\n')

const SERVICO = [
  'VENDA DE SERVIÇO OU CONTEÚDO: responda ao que o cliente pediu usando somente o catálogo.',
  '- Se a duração ou quantidade estiver ambígua, ofereça as faixas cadastradas sem escolher pela pessoa.',
  '- Nunca invente valor, desconto ou pacote. Inventar preço é dinheiro combinado com outra pessoa.',
  '- Foto de exemplo e entrega são papéis separados. Não prometa nem entregue o que não foi confirmado.',
  '- Depois do preço, confirme o próximo passo sem pressão e respeite recusa ou silêncio.',
  '- Nunca misture venda com pedido pessoal de ajuda.',
].join('\n')

export function padroesDinheiroBlock({ caminho = 'necessidade', personId = null, filaAtiva = false } = {}) {
  const base = caminho === 'servico' ? SERVICO : NECESSIDADE
  const apego = personId ? apegoNecessidadeBlock({ personId, filaAtiva, caminho }) : ''
  return apego ? `${base}\n${apego}` : base
}
