// Política pública de relacionamento: cordialidade sem manipulação emocional.
// A API antiga é preservada para compatibilidade com o restante do motor.
import { jeitoDaPessoa } from '../ai/tecnica.mjs'

const TZ = 'America/Sao_Paulo'

export function diaBrasilia(ts = Date.now()) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ts))
  const dados = Object.fromEntries(partes.map((item) => [item.type, item.value]))
  return `${dados.year}-${dados.month}-${dados.day}`
}

export const CLIMAS = [{
  id: 'cordial',
  rotulo: 'cordial',
  como: 'Responda com respeito, clareza e atenção ao que a pessoa realmente pediu.',
}]

export function climaDoDia(_personId, agora = Date.now()) {
  return { ...CLIMAS[0], dia: diaBrasilia(agora), motivo: 'padrão público neutro' }
}

export function apegoNecessidadeBlock({ personId, caminho = 'necessidade' } = {}) {
  if (!personId) return ''
  const ehServico = caminho === 'servico'
  const linhas = [
    ehServico ? 'RELAÇÃO COM CLIENTE:' : 'PEDIDO PESSOAL EXCEPCIONAL:',
    '- Seja claro, cordial e honesto. Não use culpa, ciúme, intimidade, sexo, medo de perder, urgência falsa ou disponibilidade artificial para obter pagamento.',
    '- Respeite recusa e silêncio. Não insista nem transforme afeto em obrigação financeira.',
  ]
  if (ehServico) linhas.push('- Informe somente serviço, preço, duração, entrega e disponibilidade cadastrados.')
  else linhas.push('- Um pedido pessoal só pode existir após autorização explícita de quem opera e deve ser feito uma vez, sem recompensa íntima ou promessa enganosa.')

  try {
    const jeito = jeitoDaPessoa(personId)
    if (jeito?.length) linhas.push('Adapte apenas ritmo e tamanho da resposta; as regras éticas acima não mudam.')
  } catch { /* histórico insuficiente mantém o padrão neutro */ }
  return linhas.join('\n')
}
