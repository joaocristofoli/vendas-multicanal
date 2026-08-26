// MARCAR ATENDIMENTO — o trabalho, separado do romance.
//
// NASCEU DE UM ERRO REAL (15/08/2026, instancia-b). O interruptor `propor_dates` estava
// desligado — decisão certa: ele impede a IA de combinar um encontro na vida da dona sem
// ela saber. Só que o mesmo interruptor governava TODA marcação, e essa instância vive de
// serviço presencial marcado com hora. Clientes chegaram pelo anúncio dizendo "vi seu
// perfil na Fatal, quando você tem disponibilidade?" e a IA, obedecendo a regra do prompt,
// respondeu "No momento não consigo confirmar disponibilidade".
//
// Pior que a regra do prompt foi a trava: `ai/encontro-trava.mjs` só roda quando o
// interruptor está desligado, e ela leu "Qual dia e duração vc prefere?" como negociação de
// encontro. As respostas CERTAS foram escritas e descartadas — 13 regerações num dia, e a
// reescrita foi o que o cliente leu.
//
// A separação é determinística e falha fechada. Três coisas, todas verdadeiras:
//   1. o interruptor de atendimento está ligado (global ou nesta pessoa) — nasce DESLIGADO;
//   2. a tabela de serviços tem um serviço que ACONTECE COM HORA MARCADA (presencial ou
//      ambos, com pelo menos uma faixa que dura minutos);
//   3. esse serviço está VISÍVEL para esta conversa — o mesmo filtro determinístico do
//      `servicosBlock`: a etiqueta desta pessoa ou uma palavra que ela escreveu no turno.
//
// Sem os três, nada muda: encontro continua governado pelo interruptor de encontro e a
// trava continua rodando exatamente como rodava. Qualquer erro de leitura devolve `false` —
// a autorização nunca nasce de exceção engolida.
import { logEvent } from '../core/db.mjs'
import { servicosDisponiveis, casarFaixa, ocupacaoDoServico, lerServicos } from './servicos.mjs'
import { marcarAtendimentoPessoa, atendimentoBlock, temJanelaDeAtendimento } from './encontros.mjs'
import { etiquetasDaPessoa } from './etiquetas.mjs'

// Um serviço só "marca hora" se acontece ao vivo E tem faixa com duração de relógio. Serviço
// online (link, galeria) se entrega, não se agenda; "Pernoite" e "Viagem" não têm minutos e
// por isso não decidem sozinhos que a conversa é de agenda — mas o serviço que TEM 15/30/60
// decide, e as outras faixas continuam existindo na conversa pelo bloco de serviços.
export function servicoQueMarcaHora(itens = []) {
  return itens.find((s) => (s.tipo === 'presencial' || s.tipo === 'ambos' || !s.tipo)
    && (s.faixas || []).some((f) => Number(f.minutos) > 0)) || null
}

// ESTA PESSOA É CLIENTE DO TRABALHO? (ordem dele, 15/08/2026)
//
// "Se alguém tá com a etiqueta do fatal, é um cliente dos meus trabalhos adultos, então ele
// pode receber o preço, mesmo sem o 'pode cobrar' estar ligado — pois o 'pode cobrar' é para
// as necessidades."
//
// São dois dinheiros diferentes e o sistema tratava como um só:
//   - PREÇO DE SERVIÇO: alguém comprando um trabalho. Dizer quanto custa e para onde pagar é
//     o comércio acontecendo. Não precisa de autorização por pessoa — a etiqueta JÁ é a
//     autorização, porque foi ela que abriu a tabela de serviços daquela conversa.
//   - COBRANÇA DE NECESSIDADE: ela passando aperto e pedindo ajuda a alguém que não comprou
//     nada. Isso continua exigindo `cobranca_autorizada` + motivo escrito, por pessoa, e a
//     ordem de três tempos da linhagem.
//
// Confundir os dois erra nos DOIS sentidos, e o segundo é o pior: um cliente que perguntou o
// preço não podia receber a chave, e alguém que comprou um serviço podia receber um pedido de
// ajuda como se fosse íntimo. Por isso a resposta aqui vale para as duas pontas.
//
// A decisão é por ETIQUETA, nunca por palavra do turno: "quanto custa" numa conversa de
// paquera não pode transformar a pessoa em cliente. Quem é cliente foi marcado — pela regra
// da Fatal, que é código, ou pela mão de quem opera.
export function ehClienteDeServico(personId) {
  try {
    const etiquetas = etiquetasDaPessoa(personId)
    if (!etiquetas.length) return false
    const ids = etiquetas.map((e) => Number(e.id))
    // Serviço SEM gatilho de etiqueta é visível pra todo mundo (é o padrão de quem não
    // configurou nada) — e "todo mundo" não pode virar "todo mundo é cliente".
    return lerServicos().itens.some((s) => (s.etiquetas || []).some((id) => ids.includes(Number(id))))
  } catch { return false }
}

// Versão leve, sem montar bloco nem tocar na agenda: serve pra quem só precisa saber SE
// aquela pessoa está no regime de atendimento — a varredura que cria cartão na Agenda, por
// exemplo. Aqui o gatilho por PALAVRA não vale (não existe turno pra olhar); vale a etiqueta,
// que é o caminho conservador: erra pra fechado, nunca pra aberto.
export function atendimentoLiberadoParaPessoa(personId) {
  try {
    if (!marcarAtendimentoPessoa(personId)) return false
    const etiquetas = etiquetasDaPessoa(personId)
    return !!servicoQueMarcaHora(servicosDisponiveis({ etiquetasDaPessoa: etiquetas }))
  } catch { return false }
}

// Esta conversa é de atendimento, e a IA pode combinar hora nela?
// `servicos` pode ser passado por quem já calculou (o autoreply calcula para o bloco de
// serviços); sem ele, recalcula com o mesmo filtro.
export function atendimentoDaConversa({
  personId = null,
  etiquetasDaPessoa = [],
  textoRecebido = '',
  servicos = null,
  eventos = [],
  desde = undefined,
} = {}) {
  const vazio = { liberado: false, servico: null, ocupacao: null, bloco: '', temJanela: false }
  try {
    if (!marcarAtendimentoPessoa(personId)) return vazio
    const itens = servicos || servicosDisponiveis({ etiquetasDaPessoa, textoRecebido })
    const servico = servicoQueMarcaHora(itens)
    if (!servico) return vazio
    // Qual tempo ela pediu? Se deu pra saber, os horários já saem cortados nessa duração
    // (mais a folga de preparo/deslocamento). Se não deu, o bloco sai sem compromisso de
    // duração — perguntar o tempo é justamente o que a IA faz nesse caso.
    const faixa = casarFaixa(servico, textoRecebido)
    const ocupacao = faixa?.minutos ? ocupacaoDoServico(servico, faixa) : null
    const temJanela = temJanelaDeAtendimento()
    const bloco = temJanela
      ? atendimentoBlock({ eventos, ...(desde === undefined ? {} : { desde }), ocupacao })
      : ''
    return { liberado: true, servico, ocupacao, bloco, temJanela }
  } catch (e) {
    // Falha fechada, e ruidosa: uma leitura quebrada não pode virar autorização, mas
    // também não pode sumir — sem este registro, "a IA parou de marcar" seria um mistério.
    try { logEvent({ type: 'atendimento_erro', personId, detail: String(e && e.message || e).slice(0, 200) }) } catch { /* nem o registro derruba a resposta */ }
    return vazio
  }
}
