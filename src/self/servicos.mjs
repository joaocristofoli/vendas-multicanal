// A TABELA DE SERVIÇOS: o que a dona faz, por quanto, e por quanto tempo.
//
// É informação pessoal dela, como o PIX: vive no banco, nunca no código, e viaja para a IA
// com a política de uso colada no dado. A política aqui é diferente da do PIX por decisão
// explícita do gestor (14/08/2026): a IA PODE oferecer os valores por iniciativa própria,
// não só quando perguntam.
//
// O MODELO É "UM SERVIÇO, VÁRIOS TEMPOS" porque foi assim que ele descreveu: o mesmo serviço
// costuma ter preço diferente conforme a duração (1 hora, 2 horas, pernoite). Então cada
// serviço carrega uma LISTA de faixas {tempo, valor} em vez de um preço só.
//
// DINHEIRO É INTEIRO, EM CENTAVOS. Nunca float: 0.1 + 0.2 não é 0.3, e valor de serviço é
// financeiro — a regra da casa é tolerância zero aqui. A UI mostra e digita em reais; a
// fronteira converte uma vez e o banco guarda centavos.
import { getSetting, setSetting, getSavedImage } from '../core/db.mjs'

const CHAVE = 'servicos_tabela'

const MAX_SERVICOS = 40
const MAX_FAIXAS = 12
const MAX_NOME = 80
const MAX_TEMPO = 40
const MAX_OBS = 280
const MAX_LOCAL = 160
const MAX_ENDERECO = 240
const MAX_LOCAIS = 8
const MAX_FOTOS = 12
const MAX_CENTAVOS = 100_000_000   // R$ 1.000.000,00 — teto de sanidade, não regra de negócio

const limpar = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

export function formatarBRL(centavos) {
  const n = Number(centavos)
  if (!Number.isFinite(n)) return ''
  // O `toLocaleString` do pt-BR separa "R$" do número com espaço NÃO-QUEBRÁVEL (U+00A0).
  // Invisível na tela e diferente na comparação: vira espaço comum antes de sair daqui,
  // porque este texto vai para o prompt e para o teste.
  return (n / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/ /g, ' ')
}

// Aceita o que a UI manda (centavos inteiros) e também texto digitado em reais, porque um dia
// alguém vai chamar isto de um script. "1.200,50", "1200,50" e "1200.50" são o mesmo valor;
// o separador decimal do português é a VÍRGULA, e o ponto é milhar.
export function paraCentavos(valor) {
  if (typeof valor === 'number' && Number.isFinite(valor)) return Math.round(valor)
  const bruto = String(valor ?? '').trim()
  if (!bruto) return NaN
  const so = bruto.replace(/[^\d.,-]/g, '')
  if (!so) return NaN
  if (/^-?\d+$/.test(so)) return Number(so)
  // Com vírgula, ela manda: o ponto é milhar ("1.200,50"). Sem vírgula, um ponto seguido de
  // um ou dois dígitos é decimal ("150.5" = R$ 150,50) — do contrário "1.200" viraria
  // R$ 12,00 em vez de R$ 1.200,00, que é o erro caro nos dois sentidos.
  const normalizado = so.includes(',')
    ? so.replace(/\./g, '').replace(',', '.')
    : (/^-?\d+\.\d{1,2}$/.test(so) ? so : so.replace(/\./g, ''))
  const n = Number(normalizado)
  return Number.isFinite(n) ? Math.round(n * 100) : NaN
}

// "15 minutos", "30 min", "1 hora", "1h", "2 horas" → minutos na agenda.
// "pernoite" e texto que não é duração de relógio devolvem null: preço continua
// valendo, mas o compromisso não adivinha o fim.
export function minutosDeTempo(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
  if (!t) return null
  const min = t.match(/^(\d+)\s*(min|mins|minuto|minutos)$/)
  if (min) {
    const n = Number(min[1])
    return n > 0 && n <= 24 * 60 ? n : null
  }
  const hor = t.match(/^(\d+)\s*(h|hr|hrs|hora|horas)$/)
  if (hor) {
    const n = Number(hor[1]) * 60
    return n > 0 && n <= 24 * 60 ? n : null
  }
  if (/^(uma|1)\s*hora$/.test(t)) return 60
  return null
}

function minutosNaFaixa(faixa, tempo) {
  const bruto = faixa?.minutos
  if (bruto !== undefined && bruto !== null && bruto !== '') {
    const n = Number(bruto)
    if (!Number.isInteger(n) || n < 0) throw new Error(`a duração de "${tempo}" precisa ser minutos inteiros`)
    if (n > 24 * 60) throw new Error(`a duração de "${tempo}" passou de 24 horas`)
    return n || null
  }
  return minutosDeTempo(tempo)
}

function normalizarFaixa(faixa, indice) {
  const tempo = limpar(faixa?.tempo, MAX_TEMPO)
  if (!tempo) throw new Error(`informe o tempo da ${indice + 1}ª faixa (ex: 1 hora)`)
  const centavos = paraCentavos(faixa?.centavos ?? faixa?.valor)
  if (!Number.isFinite(centavos)) throw new Error(`o valor de "${tempo}" não é um número`)
  if (centavos <= 0) throw new Error(`o valor de "${tempo}" precisa ser maior que zero`)
  if (centavos > MAX_CENTAVOS) throw new Error(`o valor de "${tempo}" passou do teto do sistema`)
  return { tempo, centavos, minutos: minutosNaFaixa(faixa, tempo) }
}

function inteiroMin(valor, nome, teto = 24 * 60) {
  const n = Number(valor)
  if (!Number.isFinite(n) || n === 0) return 0
  if (!Number.isInteger(n) || n < 0) throw new Error(`${nome} precisa ser minutos inteiros`)
  if (n > teto) throw new Error(`${nome} passou de ${teto} minutos`)
  return n
}

// FOTOS DE EXEMPLO (14/08/2026). A foto é a mesma da biblioteca de fotos salvas — aqui só
// mora o id dela. Guardar a ligação DENTRO do serviço, e não numa tabela à parte, mantém a
// propriedade que a tabela já tem: ela é salva inteira, de uma vez, sem estado meio-salvo.
// O preço de não ter chave estrangeira é o id órfão quando a foto é apagada, e isso a LEITURA
// resolve — id que não existe mais some, em vez de virar foto fantasma no prompt.
// O id da foto é TEXTO (hash do conteúdo), nunca número — `saved_image.id` é `TEXT PRIMARY
// KEY`. A primeira versão daqui exigia inteiro e recusava toda foto real com "foto inválida";
// o teste não pegou porque a fixture inventava id numérico. Fixture com formato irreal é o
// jeito mais fácil de um teste ficar verde enquanto a tela quebra.
function normalizarFotos(fotos, nome) {
  const lista = Array.isArray(fotos) ? fotos : []
  const ids = []
  for (const bruto of lista) {
    const id = String(bruto ?? '').trim()
    if (!id || id.length > 80 || /[^\w-]/.test(id)) throw new Error(`"${nome}" tem uma foto inválida`)
    if (!ids.includes(id)) ids.push(id)
  }
  if (ids.length > MAX_FOTOS) throw new Error(`"${nome}" passou de ${MAX_FOTOS} fotos de exemplo`)
  return ids
}

// ACIONAMENTO (14/08/2026). Um serviço pode ficar guardado até algo o chamar: uma ETIQUETA na
// pessoa, ou uma PALAVRA que ela escreveu. Serviço sem gatilho nenhum continua sempre visível
// — quem não configura nada não perde nada, que é o padrão de todo módulo daqui.
function normalizarGatilhos(servico, nome) {
  const etiquetas = []
  for (const bruto of Array.isArray(servico?.etiquetas) ? servico.etiquetas : []) {
    const id = Number(bruto)
    if (!Number.isInteger(id) || id <= 0) throw new Error(`"${nome}" tem uma etiqueta inválida`)
    if (!etiquetas.includes(id)) etiquetas.push(id)
  }
  const palavras = []
  for (const bruto of Array.isArray(servico?.palavras) ? servico.palavras : []) {
    const p = limpar(bruto, 40).toLowerCase()
    if (!p) continue
    if (p.length < 2) throw new Error(`"${nome}" tem uma palavra-gatilho curta demais: "${p}"`)
    if (!palavras.includes(p)) palavras.push(p)
  }
  if (etiquetas.length > 20) throw new Error(`"${nome}" passou de 20 etiquetas`)
  if (palavras.length > 20) throw new Error(`"${nome}" passou de 20 palavras`)
  return { etiquetas, palavras }
}

// O QUE É ENTREGUE (14/08/2026). Diferente de tudo o mais deste arquivo, isto NÃO vai para a
// IA: link de acesso, instruções e as fotos com direito de uso são o PRODUTO, e produto só sai
// quando quem opera manda sair. A IA nem fica sabendo que existe — é a única forma de garantir
// que ela nunca entregue para quem não pagou.
//
// As fotos de ENTREGA são separadas das de exemplo de propósito: exemplo é amostra e pode
// aparecer na conversa; entrega é o que a pessoa comprou.
function normalizarEntrega(entrega, nome) {
  const link = limpar(entrega?.link, 500)
  if (link && !/^https?:\/\/\S+$/i.test(link)) throw new Error(`o link de "${nome}" precisa começar com http:// ou https://`)
  const instrucao = String(entrega?.instrucao ?? '').replace(/\r/g, '').trim().slice(0, 800)
  const fotos = []
  for (const bruto of Array.isArray(entrega?.fotos) ? entrega.fotos : []) {
    const id = String(bruto ?? '').trim()
    if (!id || id.length > 80 || /[^\w-]/.test(id)) throw new Error(`"${nome}" tem uma foto de entrega inválida`)
    if (!fotos.includes(id)) fotos.push(id)
  }
  if (fotos.length > 30) throw new Error(`"${nome}" passou de 30 fotos de entrega`)
  return { link, instrucao, fotos }
}

// PRESENCIAL OU ENTREGÁVEL (15/08/2026, regra configurada). Antes a diferença era dedução —
// "tem link, então é entregue" — e dedução não serve para a IA falar do serviço. Agora é
// declarado. Quem já tinha serviço cadastrado ganha o rótulo inferido uma vez, na leitura:
// com entrega configurada vira 'online', sem entrega vira 'presencial'.
export const TIPOS = ['presencial', 'online', 'ambos']
export const TIPO_TEXTO = {
  presencial: 'presencial (acontece ao vivo)',
  online: 'online — o que ela recebe é entregue pelo sistema',
  ambos: 'presencial e online',
}

// ONDE o serviço acontece, quando é presencial. Não é o mesmo que o `local` escrito: isto
// responde "quem se desloca?", que muda a frase da conversa e o que entra no compromisso.
// QUEM PAGA O LOCAL. Um motel, uma diária, uma sala alugada: o custo é do LUGAR, não do
// serviço, e por isso vive na linha do local em vez de virar mais uma faixa de preço. Somar
// os dois num valor só faria a IA dizer um número que não é o do trabalho dela.
export const PAGA_LOCAL = ['pessoa', 'somado', 'incluso']
export const PAGA_LOCAL_TEXTO = {
  pessoa: 'quem paga o lugar é a outra pessoa, direto lá, à parte do valor do serviço',
  somado: 'o valor do lugar entra POR CIMA do valor do serviço',
  incluso: 'o lugar já está incluso no valor do serviço',
}

export const ATENDE = ['meu_espaco', 'vou_ate', 'combinar']
export const ATENDE_TEXTO = {
  meu_espaco: 'acontece no espaço do usuário (a pessoa vai até ele)',
  vou_ate: 'o usuário vai até a pessoa',
  combinar: 'o lugar é combinado a cada vez',
}

// LOCAIS COM CUSTO PRÓPRIO (15/08/2026). Um serviço pode acontecer em mais de um lugar, e o
// lugar pode ter preço: motel, diária, sala. O valor é do LOCAL — some ao serviço só quando
// quem opera disser que soma. Dinheiro aqui é centavo inteiro, como em toda a casa.
function normalizarLocais(locais, nome) {
  const lista = Array.isArray(locais) ? locais : []
  if (lista.length > MAX_LOCAIS) throw new Error(`"${nome}" passou de ${MAX_LOCAIS} locais`)
  const out = []
  const vistos = new Set()
  for (const bruto of lista) {
    const apelido = limpar(bruto?.nome, MAX_LOCAL)
    if (!apelido) continue                       // linha em branco na tela não vira erro
    const chave = apelido.toLowerCase()
    if (vistos.has(chave)) throw new Error(`"${nome}" tem o local "${apelido}" repetido`)
    vistos.add(chave)
    let centavos = 0
    if (bruto?.valorCentavos != null && String(bruto.valorCentavos).trim() !== '') {
      centavos = paraCentavos(bruto.valorCentavos)
      if (!Number.isFinite(centavos)) throw new Error(`o valor do local "${apelido}" não é um número`)
      if (centavos < 0) throw new Error(`o valor do local "${apelido}" não pode ser negativo`)
      if (centavos > MAX_CENTAVOS) throw new Error(`o valor do local "${apelido}" passou do teto do sistema`)
    }
    const endereco = limpar(bruto?.endereco, MAX_ENDERECO)
    out.push({
      nome: apelido,
      valorCentavos: centavos,
      // Sem custo não tem quem pagar: forçar um rótulo aqui viraria frase errada no prompt.
      quemPaga: centavos > 0 ? (PAGA_LOCAL.includes(bruto?.quemPaga) ? bruto.quemPaga : 'pessoa') : null,
      endereco,
      // ENDEREÇO DIVULGÁVEL (15/08/2026): a regra da casa é que endereço não vai para a IA,
      // e ela segue valendo por PADRÃO. Este interruptor é a exceção declarada por quem
      // opera, lugar a lugar: um motel público não é a casa dela, e esconder o endereço de um
      // lugar que qualquer um acha no mapa só atrapalha a conversa. Sem endereço escrito, o
      // interruptor não significa nada e fica falso.
      enderecoPublico: !!endereco && bruto?.enderecoPublico === true,
      obs: limpar(bruto?.obs, MAX_OBS),
    })
  }
  return out
}

function normalizarServico(servico, indice) {
  const nome = limpar(servico?.nome, MAX_NOME)
  if (!nome) throw new Error(`o ${indice + 1}º serviço está sem nome`)
  const obs = limpar(servico?.obs, MAX_OBS)
  // ONDE O SERVIÇO ACONTECE — dois campos, com políticas diferentes de propósito:
  //   local     → a referência que PODE ser dita na conversa ("meu espaço, centro da cidade").
  //   endereco  → rua, número, complemento. NÃO entra no prompt: sai na hora de confirmar o
  //               compromisso, pela mão de quem opera, e vai junto do compromisso na agenda.
  // Misturar os dois num campo só faria a IA soltar endereço para quem só perguntou o preço.
  const local = limpar(servico?.local, MAX_LOCAL)
  const endereco = limpar(servico?.endereco, MAX_ENDERECO)
  const atendeEm = ATENDE.includes(servico?.atendeEm) ? servico.atendeEm : null
  const locais = normalizarLocais(servico?.locais, nome)
  const fotos = normalizarFotos(servico?.fotos, nome)
  const { etiquetas, palavras } = normalizarGatilhos(servico, nome)
  const entrega = normalizarEntrega(servico?.entrega, nome)
  const tipo = TIPOS.includes(servico?.tipo) ? servico.tipo : null
  const folgaAntesMin = inteiroMin(servico?.folgaAntesMin, `a folga antes de "${nome}"`)
  const folgaDepoisMin = inteiroMin(servico?.folgaDepoisMin, `a folga depois de "${nome}"`)
  const faixasBrutas = Array.isArray(servico?.faixas) ? servico.faixas : []
  if (!faixasBrutas.length) throw new Error(`"${nome}" precisa de pelo menos um tempo com valor`)
  if (faixasBrutas.length > MAX_FAIXAS) throw new Error(`"${nome}" passou de ${MAX_FAIXAS} faixas de tempo`)
  const faixas = faixasBrutas.map(normalizarFaixa)
  // Tempo repetido dentro do mesmo serviço é erro de digitação, e no prompt viraria duas
  // verdades para a mesma pergunta ("quanto é 1 hora?").
  const vistos = new Set()
  for (const f of faixas) {
    const chave = f.tempo.toLowerCase()
    if (vistos.has(chave)) throw new Error(`"${nome}" tem "${f.tempo}" repetido`)
    vistos.add(chave)
  }
  return { nome, obs, local, endereco, atendeEm, locais, faixas, fotos, etiquetas, palavras, entrega, tipo, folgaAntesMin, folgaDepoisMin }
}

export function lerServicos() {
  const salvo = getSetting(CHAVE, null)
  const itens = Array.isArray(salvo?.itens) ? salvo.itens : []
  return {
    itens: itens.map((s) => ({
      nome: String(s?.nome || ''),
      obs: String(s?.obs || ''),
      local: String(s?.local || ''),
      endereco: String(s?.endereco || ''),
      atendeEm: ATENDE.includes(s?.atendeEm) ? s.atendeEm : null,
      locais: (Array.isArray(s?.locais) ? s.locais : []).map((l) => ({
        nome: String(l?.nome || ''),
        valorCentavos: Number(l?.valorCentavos) || 0,
        quemPaga: PAGA_LOCAL.includes(l?.quemPaga) ? l.quemPaga : null,
        endereco: String(l?.endereco || ''),
        enderecoPublico: l?.enderecoPublico === true,
        obs: String(l?.obs || ''),
      })).filter((l) => l.nome),
      faixas: (Array.isArray(s?.faixas) ? s.faixas : []).map((f) => ({
        tempo: String(f?.tempo || ''),
        centavos: Number(f?.centavos) || 0,
        minutos: Number.isInteger(Number(f?.minutos)) && Number(f.minutos) > 0
          ? Number(f.minutos)
          : minutosDeTempo(f?.tempo),
      })),
      fotos: (Array.isArray(s?.fotos) ? s.fotos : []).map((x) => String(x || '').trim()).filter(Boolean),
      etiquetas: (Array.isArray(s?.etiquetas) ? s.etiquetas : []).map(Number).filter(Number.isInteger),
      palavras: (Array.isArray(s?.palavras) ? s.palavras : []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean),
      // Sem tipo salvo (cadastro anterior a 15/08/2026), infere do que existe: quem tem link
      // ou foto de entrega é online; o resto é presencial. Só a inferência inicial — assim que
      // ele escolher na tela, o valor declarado manda.
      tipo: TIPOS.includes(s?.tipo) ? s.tipo
        : ((String(s?.entrega?.link || '').trim() || (s?.entrega?.fotos || []).length) ? 'online' : 'presencial'),
      folgaAntesMin: Math.max(0, Number(s?.folgaAntesMin) || 0),
      folgaDepoisMin: Math.max(0, Number(s?.folgaDepoisMin) || 0),
      entrega: {
        link: String(s?.entrega?.link || ''),
        instrucao: String(s?.entrega?.instrucao || ''),
        fotos: (Array.isArray(s?.entrega?.fotos) ? s.entrega.fotos : []).map((x) => String(x || '').trim()).filter(Boolean),
      },
    })).filter((s) => s.nome && s.faixas.length),
    atualizadoEm: Number.isFinite(Number(salvo?.atualizadoEm)) ? Number(salvo.atualizadoEm) : null,
  }
}

// Salva a tabela inteira de uma vez: a UI edita uma lista, e substituir tudo evita o estado
// meio-salvo que aparece quando cada linha vira uma requisição. Lista vazia é válido — é
// como se apaga a tabela.
export function salvarServicos({ itens } = {}) {
  const brutos = Array.isArray(itens) ? itens : []
  if (brutos.length > MAX_SERVICOS) throw new Error(`o máximo é ${MAX_SERVICOS} serviços`)
  const limpos = brutos.map(normalizarServico)
  const nomes = new Set()
  for (const s of limpos) {
    const chave = s.nome.toLowerCase()
    if (nomes.has(chave)) throw new Error(`o serviço "${s.nome}" está repetido`)
    nomes.add(chave)
  }
  const tabela = { itens: limpos, atualizadoEm: Date.now() }
  setSetting(CHAVE, tabela)
  return lerServicos()
}

// O bloco que vai para a IA. Sem serviço cadastrado devolve string vazia — e a linha some do
// prompt, que fica idêntico ao de antes (aditivo, como todo módulo opt-in daqui).
//
// A POLÍTICA VIAJA COM O DADO. O que ela permite e o que ela proíbe foi decidido pelo gestor:
// pode oferecer por iniciativa, mas NUNCA pode inventar valor, tempo ou serviço fora da lista.
// Inventar preço é a falha cara aqui — é dinheiro combinado com outra pessoa.
// As fotos de exemplo de um serviço, já resolvidas — e só as que a IA pode mandar de fato.
// Foto apagada, desativada ou TRAVADA some daqui: a trava do nível vale no código, nunca só
// na ausência do marcador no prompt (é a mesma regra do envio automático de foto).
export function fotosDoServico(servico) {
  const out = []
  for (const id of servico?.fotos || []) {
    const f = (() => { try { return getSavedImage(id) } catch { return null } })()
    if (!f || !f.active || f.nivel === 'travada' || !f.shortcut) continue
    out.push({ id: f.id, shortcut: f.shortcut, descricao: String(f.descricao || '').trim() })
  }
  return out
}

// A volta do caminho: a que serviços esta foto está amarrada. É o que permite a linha da foto
// no prompt dizer o assunto dela, do mesmo jeito que já acontece com necessidade.
export function servicosDaFoto(fotoId) {
  const id = String(fotoId ?? '').trim()
  if (!id) return []
  return lerServicos().itens
    .filter((s) => (s.fotos || []).includes(id))
    .map((s) => ({
      nome: s.nome,
      precos: s.faixas.map((f) => `${f.tempo}: ${formatarBRL(f.centavos)}`).join(' | '),
    }))
}

// Sem acento e sem pontuação: "pernoite?" e "PERNOITE" têm que casar com "pernoite". A palavra
// é procurada com borda, então "hora" não casa dentro de "agora" — o gatilho tem que disparar
// quando a pessoa pediu, e ficar quieto quando não pediu.
const semAcento = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const escaparRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function palavraApareceEm(palavra, texto) {
  const alvo = semAcento(palavra).trim()
  if (!alvo) return false
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaparRegex(alvo)}([^\\p{L}\\p{N}]|$)`, 'iu').test(semAcento(texto))
}

// QUAIS SERVIÇOS ESTA CONVERSA PODE VER.
//   - sem gatilho nenhum: sempre disponível (é o padrão de quem não configurou nada);
//   - com etiqueta: só quando a pessoa desta conversa tem uma delas;
//   - com palavra: só quando ela apareceu no que a pessoa escreveu neste turno.
// Etiqueta OU palavra basta — são dois caminhos para a mesma porta, não uma exigência dupla.
export function servicosDisponiveis({ etiquetasDaPessoa = [], textoRecebido = '', datasDeHoje = [] } = {}) {
  const idsPessoa = (etiquetasDaPessoa || []).map((e) => Number(e?.id ?? e)).filter(Number.isInteger)
  const porData = new Map((datasDeHoje || []).map((x) => [String(x?.servico ?? x), x?.data || null]))
  return lerServicos().itens.filter((s) => {
    // A DATA ABRE, NUNCA FECHA: ligar um serviço a uma data não o esconde nos outros dias.
    // Quem não tem gatilho próprio continua sempre disponível, como sempre foi.
    if (porData.has(s.nome)) return true
    const temGatilho = (s.etiquetas || []).length || (s.palavras || []).length
    if (!temGatilho) return true
    if ((s.etiquetas || []).some((id) => idsPessoa.includes(Number(id)))) return true
    return (s.palavras || []).some((p) => palavraApareceEm(p, textoRecebido))
  }).map((s) => (porData.has(s.nome) ? { ...s, hojeE: porData.get(s.nome) } : s))
}

export function servicosBlock(contexto = {}) {
  const itens = servicosDisponiveis(contexto)
  if (!itens.length) return ''
  const linhas = itens.map((s) => {
    const precos = s.faixas.map((f) => `${f.tempo}: ${formatarBRL(f.centavos)}`).join(' | ')
    // As fotos entram pelo ATALHO, que é o mesmo marcador que a IA já usa para mandar foto.
    // Assim ela sabe qual foto mostra qual serviço, em vez de escolher pela descrição no escuro.
    const fotos = fotosDoServico(s).map((f) => `[foto:${f.shortcut}]`).join(' ')
    // O TIPO importa na hora de falar: um presencial se combina, um online se entrega. E o
    // "hoje é o dia dele" é o que liga a data comemorativa à oferta, sem obrigar nada.
    const tipo = TIPO_TEXTO[s.tipo] ? ` [${TIPO_TEXTO[s.tipo]}]` : ''
    const hoje = s.hojeE ? ` | HOJE É ${String(s.hojeE).toUpperCase()}: se a conversa der abertura, este é o serviço do dia` : ''
    const agenda = (s.faixas || []).some((f) => f.minutos)
      ? ` | na agenda: ${s.faixas.filter((f) => f.minutos).map((f) => `${f.tempo}=${f.minutos}min`).join(', ')}`
      : ''
    const folga = (s.folgaAntesMin || s.folgaDepoisMin)
      ? ` | pra marcar, a agenda precisa estar livre ${s.folgaAntesMin ? `${s.folgaAntesMin} min antes` : ''}${s.folgaAntesMin && s.folgaDepoisMin ? ' e ' : ''}${s.folgaDepoisMin ? `${s.folgaDepoisMin} min depois` : ''}`
      : ''
    // O LOCAL entra; o ENDEREÇO não. O que a dona escreveu como referência ("meu espaço, no
    // centro") é conversa normal; rua e número saem na hora de confirmar, pela mão dela.
    const onde = s.local ? ` | onde: ${s.local}` : ''
    // OS LOCAIS COM PREÇO PRÓPRIO. O valor do lugar NUNCA se mistura com o do serviço: são
    // duas contas, e quem paga cada uma está escrito. Endereço continua fora do prompt.
    const locais = (s.locais || []).length
      ? ` | lugares: ${s.locais.map((l) => {
        const semCusto = l.enderecoPublico && l.endereco ? `${l.nome}, fica em ${l.endereco} (sem custo de lugar)` : `${l.nome} (sem custo de lugar)`
        if (!l.valorCentavos) return semCusto
        const quem = l.quemPaga === 'somado' ? 'soma ao valor do serviço'
          : l.quemPaga === 'incluso' ? 'já incluso no valor do serviço'
            : 'quem paga é a outra pessoa, à parte'
        const onde = l.enderecoPublico && l.endereco ? `, fica em ${l.endereco}` : ''
        return `${l.nome}${onde} ${formatarBRL(l.valorCentavos)} do lugar (${quem})${l.obs ? ` — ${l.obs}` : ''}`
      }).join('; ')}`
      : ''
    const quemVai = ATENDE_TEXTO[s.atendeEm] ? ` | ${ATENDE_TEXTO[s.atendeEm]}` : ''
    return `- ${s.nome}${s.obs ? ` (${s.obs})` : ''}${tipo} -> ${precos}${onde}${locais}${quemVai}${agenda}${folga}${fotos ? ` | fotos de exemplo deste serviço: ${fotos}` : ''}${hoje}`
  })
  return [
    'SERVIÇOS E VALORES DO USUÁRIO (tabela escrita por ele, em reais):',
    ...linhas,
    '- Quando combinarem um horário, a duração na agenda é a da faixa (15 minutos = 15 min, 1 hora = 60 min).',
    '  Se houver folga antes/depois, esse tempo também precisa estar LIVRE na agenda — não é parte do atendimento,',
    '  é deslocamento/preparo. Não marque em cima de outro compromisso nem dentro da folga.',
    '- Estes são os únicos serviços e os únicos valores que existem. NUNCA invente serviço, tempo,',
    '  valor, desconto, pacote ou promoção que não esteja escrito acima, e nunca arredonde o valor.',
    '- Você PODE trazer o assunto por iniciativa própria quando fizer sentido na conversa, e pode',
    '  responder direto quando perguntarem preço. Diga o valor exato do tempo que a pessoa pediu;',
    '  se ela não disse o tempo, ofereça as opções que existem em vez de escolher por ela.',
    '- Fale como gente falando de trabalho: valor no meio da conversa, sem tabela, sem lista com',
    '  travessão, sem tom de anúncio e sem repetir o preço que você já disse.',
    '- Se perguntarem por algo que não está na tabela, diga que precisa combinar, e não estime.',
    '- Sobre o LUGAR: você pode falar a referência escrita acima ("onde:") e quem se desloca.',
    '- Quando o lugar tem valor próprio ("lugares:"), ele é OUTRA conta: diga o valor do serviço e',
    '  o do lugar separados, do jeito que está escrito, e nunca some os dois num número só nem',
    '  invente valor de lugar que não está aqui. Se o lugar é pago pela outra pessoa, isso se diz',
    '  com naturalidade, sem parecer cobrança extra.',
    '  ENDEREÇO EXATO (rua, número, complemento, ponto de referência preciso) você só tem quando',
    '  ele está escrito acima com "fica em" — esse pode ser dito se a pessoa perguntar. Qualquer',
    '  outro endereço você NÃO tem e NUNCA inventa nem deduz: se pedirem, diga que manda na hora',
    '  de confirmar. Serviço sem "onde:" escrito é lugar a combinar — não escolha um por conta própria.',
    '- O QUE A PESSOA RECEBE (link de acesso, arquivo, galeria) NÃO está aqui e você não tem.',
    '  Nunca invente link, senha, prazo de entrega ou forma de acesso. Se ela perguntar como',
    '  recebe, diga que você manda assim que acertarem — quem entrega é o usuário, na mão.',
    '- Onde houver foto de exemplo, você pode mandá-la quando estiver falando DAQUELE serviço,',
    '  usando o marcador do jeito de sempre. A foto é exemplo do serviço: não a use para outro',
    '  assunto, e não descreva foto que não existe.',
  ].join('\n')
}

// Quanto o compromisso OCUPA na agenda: a duração da faixa + folga antes/depois.
// Folga não entra no evento (o cliente vê 15 min); entra na CHECAGEM de horário livre.
export function ocupacaoDoServico(servico, faixa) {
  const minutos = Number(faixa?.minutos) || minutosDeTempo(faixa?.tempo) || 0
  const folgaAntesMin = Math.max(0, Number(servico?.folgaAntesMin) || 0)
  const folgaDepoisMin = Math.max(0, Number(servico?.folgaDepoisMin) || 0)
  return {
    minutos,
    folgaAntesMin,
    folgaDepoisMin,
    totalMin: minutos + folgaAntesMin + folgaDepoisMin,
    servico: servico?.nome || null,
    faixa: faixa?.tempo || null,
  }
}

// Acha a faixa no texto ("30 minutos", "1h", "quinze"). Sem match e com uma faixa só, é ela.
export function casarFaixa(servico, texto) {
  const faixas = (servico?.faixas || []).filter((f) => (f.minutos || minutosDeTempo(f.tempo)))
  if (!faixas.length) return null
  const t = semAcento(texto || '')
  for (const f of faixas) {
    const min = f.minutos || minutosDeTempo(f.tempo)
    const rotulo = semAcento(f.tempo)
    if (rotulo && t.includes(rotulo)) return { ...f, minutos: min }
    if (min && new RegExp(`(^|[^0-9])${min}\\s*(min|minuto|minutos)([^a-z]|$)`).test(t)) return { ...f, minutos: min }
    if (min && min % 60 === 0) {
      const h = min / 60
      if (new RegExp(`(^|[^0-9])${h}\\s*(h|hora|horas)([^a-z]|$)`).test(t)) return { ...f, minutos: min }
    }
  }
  return faixas.length === 1 ? { ...faixas[0], minutos: faixas[0].minutos || minutosDeTempo(faixas[0].tempo) } : null
}

// Resolve duração de um compromisso pra ESTA pessoa: texto da conversa + serviços que
// a etiqueta dela abre. Sem faixa casada, devolve o padrão antigo (60 min) e fonte 'padrao'.
export function resolverDuracaoAgenda({ personId, texto = '', startMs = null, endsAt = null, etiquetasDaPessoa = [] } = {}) {
  if (startMs && endsAt && Number(endsAt) > Number(startMs)) {
    const minutos = Math.max(1, Math.round((Number(endsAt) - Number(startMs)) / 60000))
    const visiveis = servicosDisponiveis({ etiquetasDaPessoa, textoRecebido: texto })
    let casada = null
    for (const s of visiveis) {
      const f = casarFaixa(s, texto)
      if (f) { casada = { servico: s, faixa: f }; break }
    }
    return {
      minutos,
      fonte: 'fim',
      ocupacao: casada ? ocupacaoDoServico(casada.servico, { ...casada.faixa, minutos }) : { minutos, folgaAntesMin: 0, folgaDepoisMin: 0, totalMin: minutos },
      servico: casada?.servico || null,
      faixa: casada?.faixa || null,
    }
  }
  const visiveis = servicosDisponiveis({ etiquetasDaPessoa, textoRecebido: texto })
  for (const s of visiveis) {
    const f = casarFaixa(s, texto)
    if (f?.minutos) {
      return { minutos: f.minutos, fonte: 'faixa', ocupacao: ocupacaoDoServico(s, f), servico: s, faixa: f }
    }
  }
  const unicas = visiveis.flatMap((s) => (s.faixas || []).filter((f) => f.minutos).map((f) => ({ s, f })))
  if (unicas.length === 1) {
    const { s, f } = unicas[0]
    return { minutos: f.minutos, fonte: 'unica', ocupacao: ocupacaoDoServico(s, f), servico: s, faixa: f }
  }
  return { minutos: 60, fonte: 'padrao', ocupacao: { minutos: 60, folgaAntesMin: 0, folgaDepoisMin: 0, totalMin: 60 }, servico: null, faixa: null }
}
