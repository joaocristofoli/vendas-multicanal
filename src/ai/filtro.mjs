// O ÚLTIMO PORTÃO ANTES DE UMA MENSAGEM SAIR.
//
// Em 25/07/2026 a IA escreveu, num Tinder, pra uma menina de 18 anos que tinha acabado de
// dizer que estava em casa com o filho de 10 meses:
//
//     "Ooii, 10 meses é uma fase bem gostosa, já deve estar querendo mexer em tudo kkk"
//
// Em português "fase gostosa" é idiomático e inocente. Naquele contexto — homem, app de
// namoro, falando do BEBÊ dela — lê como outra coisa completamente. O dono teve que entrar na
// conversa na mão pra consertar. A ordem dele: "erro que nunca pode acontecer: a IA nunca
// pode PARECER algo tipo pedofilia".
//
// POR QUE ISTO É CÓDIGO E NÃO UMA REGRA NO PROMPT
// Uma instrução no prompt é um pedido: o modelo atende quase sempre, e "quase sempre" aqui
// vale zero. Este arquivo não pede — ele IMPEDE. É determinístico, roda depois da geração e
// antes do envio, e não tem caminho que o contorne.
//
// A DECISÃO CENTRAL: PROIBIR A COLISÃO, NÃO A PALAVRA
// "gostosa" faz parte da voz do dono com mulher adulta, e bani-la globalmente quebraria o
// que ele aprovou no golden set. O que não pode existir NUNCA é o encontro daquele registro
// com um contexto de criança na MESMA mensagem. Então a regra é de proximidade, não de
// vocabulário: cada lista sozinha é livre; juntas, a mensagem não sai.
//
// DOIS PESOS, DOIS DESTINOS
//   'crianca'  -> NUNCA envia. Não tenta de novo, não reescreve: bloqueia e avisa o dono.
//                 Um novo sorteio do modelo não é garantia de nada, e o custo do erro aqui
//                 não é constrangimento — é parecer criminoso.
//   'batido'   -> bordão gasto ("ganhou pontos comigo") ou abertura invasiva ("não dá pra
//                 fugir de mim"). Vale gerar de novo uma vez; se insistir, não sai.
import fsFiltro from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../core/caminhos.mjs'

const norm = (t) => String(t || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')

// ---------------------------------------------------------------- criança
// Marcadores de que o assunto é uma CRIANÇA. Inclui idade pequena escrita de todo jeito que
// gente escreve: "10 meses", "2 aninhos", "3 anos" (só até 12), "recém-nascido".
const CRIANCA = [
  /\bbebe\b/, /\bbebes\b/, /\bnenem\b/, /\bnene\b/, /\brecem[- ]?nascid/, /\bnewborn\b/,
  /\bfilh[oa]s?\b/, /\bfilhinh/, /\bcrianc/, /\bmenin[oa]zinh/, /\bpequenininh/, /\bpequenin/,
  /\bmoleque\b/, /\bguri\b/, /\bcriancinha/, /\bbaby\b/,
  /\bfralda/, /\bmamada/, /\bmamando\b/, /\bamamenta/, /\bberco\b/, /\bcolo\b/,
  /\bmaternidade\b/, /\bgestac/, /\bgravid/, /\bpediatra\b/, /\bcreche\b/,
  /\b\d{1,2}\s*mes(es)?\b/,                 // "10 meses"
  /\b\d{1,2}\s*aninhos?\b/,                 // "2 aninhos"
  /\b([0-9]|1[0-2])\s*anos?\b/,             // "3 anos" — só até 12
  /\bfilh[oa] (dela|dele|teu|tua|seu|sua)\b/,
]

// O NOME DA CRIANÇA TAMBÉM É UM MARCADOR — e sem isto existia um buraco por onde passava
// exatamente o que este arquivo foi feito pra impedir. Medido em 11/08/2026, no dia em que a
// filha da dona entrou no retrato:
//
//     "minha filha é uma gata"  -> BLOQUEIA
//     "a Crianca Exemplo é uma gata"    -> passava
//
// Ou seja: bastava o modelo chamar a criança pelo nome — o jeito mais natural de falar dela —
// pra a colisão não ser vista. Declarar o filho no retrato SEM ensinar o portão a reconhecer
// o nome deixa o sistema pior do que antes de declarar.
//
// Vem de `sobre-mim-fontes/criancas.json` (ou da identidade viva na VM), nunca literal aqui:
// nome de criança é dado, mesma classe do nome do dono (ver src/core/dono.mjs e a guarda
// `licoes/identidade-de-outro-dono`). Sem o arquivo, a lista fica igual à de antes.
// O caminho vem de `src/core/caminhos.mjs` e não de um `TIM_SISTEMA || 'vendas-multicanal'` repetido
// aqui: derivar o nome da instância de novo em cada arquivo é como o clone volta a apontar
// pra pasta da origem quando UMA variável falta no env — e aqui isso significa o portão
// reconhecer os nomes das crianças de OUTRA casa.
const CAMINHOS_CRIANCAS = [
  process.env.TIM_CRIANCAS_PATH || path.join(DATA_DIR, 'sobre-mim', 'criancas.json'),
  new URL('../../sobre-mim-fontes/criancas.json', import.meta.url).pathname,
]
function nomesDeCrianca() {
  for (const p of CAMINHOS_CRIANCAS) {
    try {
      const j = JSON.parse(fsFiltro.readFileSync(p, 'utf8'))
      const nomes = Array.isArray(j?.nomes) ? j.nomes : []
      return nomes.filter((n) => typeof n === 'string' && n.trim().length >= 3)
    } catch { /* tenta o próximo */ }
  }
  return []
}
for (const nome of nomesDeCrianca()) {
  // `norm` tira acento e baixa a caixa antes de testar, então o marcador acompanha.
  const alvo = norm(nome).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  CRIANCA.push(new RegExp(`\\b${alvo}\\b`))
}

// Registro que NUNCA pode encostar no de cima. São palavras do vocabulário de atração/apetite
// — legítimas com adulto, catastróficas perto de criança.
// PREFIXO, não palavra fechada: o teste pegou "gostosinha" passando, e o diminutivo é
// exatamente como alguém escreveria sobre um bebê. `\bgostos` cobre gostosa, gostoso,
// gostosinha, gostosura, gostosão — e continua sem afetar a voz com adulto, porque sozinho
// nenhum destes bloqueia nada: só a COLISÃO com contexto de criança.
const APETITE = [
  /\bgostos/, /\bdelici/, /\btesao\b/, /\btesud/,
  /\bsafad/, /\bgat[ao]\b/, /\bgatinh[ao]\b/, /\bapetitos/, /\bcomivel\b/, /\bpegavel\b/,
  /\bde comer\b/, /\bpra comer\b/, /\bda vontade de\b/, /\bcheirosinh/, /\btentador/,
  /\bmaravilhos[ao] demais\b/, /\bque delicia\b/,
]

// ---------------------------------------------------------------- batido
// Bordões que o dono marcou como gastos, e aberturas que soam invasivas. Estes são de VOZ,
// não de segurança: valem uma segunda tentativa.
// ---------------------------------------------------------------- cobrança sem autorização
// O que a IA não escreve SEM autorização explícita por pessoa. Duas famílias:
//   1. o pedido direto ("me ajuda com", "manda um pix", "me empresta");
//   2. o combinado ("me passa o pix", "quanto você consegue", "faz um pix pra mim").
//
// Fora da lista de propósito: falar de dinheiro em si. "tô sem grana", "tá apertado esse
// mês", "não vou conseguir sair porque tô no zero" são desabafo e PODEM sair. A fronteira
// atual é o PEDIDO/ARRANJO sem uma regra de cobrança autorizada, não o assunto.
//
// `\b` em tudo pra não pegar palavra dentro de palavra: "pix" isolado é pedido; "pixel" não.
const PEDIR_DINHEIRO = [
  /\bme ajuda\b(?!.\ba (entender|escolher|decidir)\b)/, /\bme ajudar\b(?=.{0,20}\b(grana|dinheiro|pix|valor|conta)\b)/,
  /\buma ajudinha\b/, /\bme empresta\b/, /\bempresta\b(?=.{0,25}\b(grana|dinheiro|real|reais|pix)\b)/,
  /\bmanda um pix\b/, /\bfaz um pix\b/, /\bme manda um pix\b/,
  /\bme passa o pix\b/, /\bpix pra mim\b/,
  /\bme paga\b/, /\bpaga pra mim\b/, /\bvoce paga\b/, /\btu paga\b/,
  /\bquanto (voce|tu) consegue\b/, /\bconsegue me mandar\b/, /\bme manda (uma grana|um dinheiro|um valor)\b/,
  /\bme salva\b(?=.{0,25}\b(grana|dinheiro|pix|conta|mes)\b)/,
  /\bcontribui\b/, /\bcolabora\b(?=.{0,20}\b(grana|dinheiro|pix)\b)/,
]

// QUANDO A CHAVE PIX É O PRÓPRIO TELEFONE (15/08/2026).
//
// Numa fixture, a chave PIX era o mesmo número do contato. Como o portão só perguntava "o texto
// tem a chave?", TODA mensagem que passava o contato virava "expõe a chave PIX": "pode me
// chamar 11 99999-0000", "me chama vc", "converso mais pelo whats". Foram 650 bloqueios em 5
// dias, 28 pessoas, e 642 deles sem NENHUMA resposta nos 10 minutos seguintes — a conversa
// simplesmente emudecia, porque aqui não há segunda tentativa.
//
// O conserto não é afrouxar a trava: é perguntar a coisa certa. Número de telefone tem uso
// legítimo diário (levar a conversa pro WhatsApp); CPF, e-mail e chave aleatória não têm — um
// CPF solto no meio da paquera só pode ser cobrança. Então, quando a chave É um telefone, ela
// só conta como chave PIX se a mensagem estiver FALANDO DE DINHEIRO. Nos outros formatos,
// nada muda: continua bloqueado como antes.
//
// CUIDADO QUE CUSTOU UMA RODADA DE TESTE: um CPF tem 11 dígitos e casa com o formato de
// celular (um CPF sintético de 11 dígitos passou como telefone). Quem separa os dois é o
// dígito verificador do CPF, que é conta fechada — sem ele, o conserto do telefone teria
// aberto a porta justamente pro formato que NUNCA é contato.
const TELEFONE_BR = /^(55)?[1-9]{2}9?\d{8}$/
function ehCpf(digitos) {
  const d = String(digitos || '')
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false
  const dv = (ate) => {
    let soma = 0
    for (let i = 0; i < ate; i += 1) soma += Number(d[i]) * (ate + 1 - i)
    const r = (soma * 10) % 11
    return r === 10 ? 0 : r
  }
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10])
}
const CONTEXTO_DINHEIRO = [
  /\bpix\b/, /\bchave\b/, /\btransfer(e|ir|encia)\b/, /\bdeposit(a|ar|o)\b/,
  /\bpag(a|ar|amento|ando)\b/, /\bpagar\b/, /\bvalor(es)?\b/, /\br\$/, /\breais\b/,
  /\bdinheiro\b/, /\bgrana\b/, /\bsinal\b/, /\badiantad(o|a)\b/, /\bcach(e|ê)\b/,
  /\bme manda\b(?=.{0,25}\b(grana|dinheiro|valor|pix)\b)/, /\bcobr(a|ar|ança)\b/,
]

// Estas frases podem ser só a resposta a "me passa sua chave PIX". Continuam bloqueadas
// por padrão; só passam quando o turno atual abriu a permissão determinística.
const INFORMAR_PIX = [
  /\bmeu pix\b/, /\bte passo o pix\b/, /\bminha chave pix\b/, /\bchave pix\b/,
]

const BATIDO = [
  { re: /\bganhou pontos?\b/, oQue: '"ganhou pontos comigo" — bordão gasto' },
  { re: /\bpontos? comigo\b/, oQue: '"pontos comigo" — bordão gasto' },
  { re: /\bja ganhou\b.*\bcomigo\b/, oQue: 'variação de "ganhou pontos comigo"' },
  { re: /\bfugir de mim\b/, oQue: '"fugir de mim" — soa possessivo/invasivo' },
  { re: /\bnao (tem|da pra) (como )?(escapar|fugir)\b/, oQue: 'soa possessivo/invasivo' },
  { re: /\bagora (voce )?(e|eh) minha\b/, oQue: 'soa possessivo' },
  { re: /\bnao vai (escapar|se livrar) de mim\b/, oQue: 'soa possessivo/invasivo' },
  { re: /\bte achei\b.*\bnao escapa\b/, oQue: 'soa possessivo' },
  // "desenho adulto" / "animação adulta": o modelo chega nisso quando quer descrever BoJack
  // por categoria. Fora de contexto lê como pornografia — o dono apontou como
  // "extremamente mal colocado". O certo é NOMEAR a obra, não a categoria.
  { re: /\bdesenhos? adult/, oQue: '"desenho adulto" soa como outra coisa — cite o nome da série em vez da categoria' },
  { re: /\banima(cao|ção) adult/, oQue: '"animação adulta" soa como outra coisa — cite o nome da série' },
  { re: /\bconteudo adult/, oQue: '"conteúdo adulto" soa como outra coisa' },
]

// ---------------------------------------------------------------- sistema
// FALHA DO PROVEDOR NUNCA VIRA MENSAGEM. Quando a conta bate 100% de uso, ou a API cai, o
// texto que volta pode ser "Claude AI usage limit reached", "rate limit", "service
// unavailable". Se isso for tratado como resposta, sai no Tinder da pessoa — e nenhuma outra
// coisa entrega tão rápido que do outro lado tem um robô. É o mesmo peso do filtro de
// criança: bloqueia e não tenta de novo com o mesmo texto.
//
// MESMA FILOSOFIA DO RESTO DO ARQUIVO: proibir a COLISÃO, não a palavra. O dono conversa
// sobre IA o tempo todo ("eu uso o Claude e o codex", "nem a própria API oficial deixa") e
// banir esse vocabulário quebraria a voz dele. O que não existe na boca de ninguém é marca de
// infraestrutura ENCOSTADA em marca de falha na mesma mensagem.
const INFRA = [
  /\bopenai\b/, /\banthropic\b/, /\bclaude\b/, /\bcodex\b/, /\bgpt\b/, /\bllm\b/, /\bapi\b/,
  /\bapp[- ]?server\b/, /\bendpoint\b/, /\bprovedor\b/, /\bmodelo de linguagem\b/,
  /\bassistente virtual\b/, /\brequisicao\b/, /\bhttp\b/, /\bsdk\b/, /\btoken(s)? de contexto\b/,
]
// De propósito NÃO tem "erro", "falha" nem "não foi possível" aqui: são palavras da vida real
// dele ("essa ficou com erro", "o sistema deu erro, já to consertando") e usá-las como gatilho
// bloquearia conversa legítima. O que entra é vocabulário de FALHA TÉCNICA DE SERVIÇO, que só
// aparece quando uma máquina está reclamando.
const FALHA = [
  /\blimit(e|es)?\b/, /\blimit\b/, /\bcota\b/, /\bquota\b/, /\bexcedid/, /\bexceeded\b/,
  /\bindisponivel\b/, /\bunavailable\b/, /\brefused\b/, /\btimeout\b/, /\btimed out\b/,
  /\bsobrecarregad/, /\boverloaded\b/, /\bunauthorized\b/, /\bforbidden\b/, /\btry again\b/,
  /\bretry\b/, /\bupgrade\b/, /\bcredit(o|os)?\b/, /\bcredits?\b/, /\bexpirou\b/, /\bexpired\b/,
]
// Assinaturas que não precisam de colisão: ninguém escreve isso numa conversa de paquera.
// Inclui as frases que ESTE código lança — se um dia virarem texto em vez de exceção, morrem
// aqui do mesmo jeito.
const SISTEMA_SOZINHO = [
  /\busage limit\b/, /\brate limit/, /\bcredit balance\b/, /\bupgrade to (pro|max)\b/,
  /\busage limit reached\b/, /\btoo many requests\b/, /\binternal server error\b/,
  /\bservice unavailable\b/, /\bbad gateway\b/, /\bnot logged in\b/, /\bplease run \/login\b/,
  /\bapi key\b/, /\btraceback\b/, /\bstack trace\b/, /\bexception\b/, /\becconnrefused\b/,
  /\benotfound\b/, /\betimedout\b/, /\becconnreset\b/, /\bundefined is not\b/,
  /\bstatus (4|5)\d{2}\b/, /\bhttp (4|5)\d{2}\b/, /\b(429|500|502|503|504) (error|erro)\b/,
  /\bnao devolveu uma mensagem utilizavel\b/, /\bnao devolveu o id\b/, /\bexcedeu o tempo\b/,
  /\bexcedeu \d+ segundos\b/, /\bconecte (sua conta|a conta)\b/, /\bcodex app-server\b/,
  /\bcodex cli nao encontrado\b/, /\bo claude (recusou|nao rodou|passou de)\b/,
  /\blimite de uso\b/, /\bplano (atual|gratuito)\b.*\blimite\b/, /\bsem creditos\b/,
]

// O relógio brasileiro entra no prompt para o modelo raciocinar certo, não para virar
// assunto. Esta é uma configuração interna do produto. Diferente de palavras como "hora"
// ou "Brasil", que fazem parte de conversa normal, as assinaturas abaixo nomeiam justamente
// o mecanismo que o dono proibiu a IA de expor. Mensagem manual não passa por este filtro.
const FUSO_INTERNO = [
  /\bhorario (de brasilia|brasileiro|do brasil)\b/,
  /\bfuso(?: horario)?(?: e)? (de brasilia|brasileiro|do brasil|de sao paulo)\b/,
  /\bamerica\s*\/\s*sao_paulo\b/,
  /\butc\s*[−–—-]?\s*0?3(?::?00)?\b/,
]

// O rascunho é uma conversa social. Se ele TEM CARA de saída de máquina — JSON, log, linha
// que começa com "erro:" — não é resposta pra ninguém.
function temFormaDeMaquina(t) {
  const s = String(t || '').trim()
  if (/^[{[][\s\S]*[}\]]$/.test(s)) { try { JSON.parse(s); return true } catch { /* não era */ } }
  return /^\s*(erro|error|warn|warning|fatal|debug)\s*[:\-—]/i.test(s)
}

export function pareceMensagemDeSistema(texto, { permitirEstruturado = false } = {}) {
  const t = norm(texto)
  if (!t.trim()) return null
  // Extratores internos (memória, agenda, fatos) PEDEM JSON. Neles, formato estruturado é
  // sucesso; numa resposta social continua sendo bloqueio. As assinaturas técnicas abaixo
  // ainda rodam nos dois casos, portanto {"error":"OpenAI rate limit"} continua morrendo.
  if (!permitirEstruturado && temFormaDeMaquina(texto)) return { motivo: 'o texto tem forma de saída de máquina (JSON ou linha de log), não de mensagem' }
  for (const re of SISTEMA_SOZINHO) {
    const m = t.match(re)
    if (m) return { motivo: `o texto carrega assinatura de falha técnica ("${m[0].trim()}")`, trechos: [m[0].trim()] }
  }
  const infra = achar(texto, INFRA)
  const falha = achar(texto, FALHA)
  if (infra.length && falha.length) {
    return { motivo: `o texto junta infraestrutura (${infra.join(', ')}) com falha (${falha.join(', ')}) — é mensagem de erro, não de conversa`, trechos: [...infra, ...falha] }
  }
  return null
}

function achar(texto, lista) {
  const t = norm(texto)
  const achados = []
  for (const re of lista) { const m = t.match(re); if (m) achados.push(m[0].trim()) }
  return achados
}

// Usado também por análises locais que precisam descartar uma conversa inteira antes de
// medir registro íntimo. Exportar o detector evita que cada consumidor invente uma lista
// diferente e deixe passar um marcador que o portão de saída já conhece — inclusive os
// NOMES das crianças, que entram na lista por dado (`criancas.json`) e não estariam numa
// cópia feita à mão.
export function temMarcadorCrianca(texto) {
  return achar(texto, CRIANCA).length > 0
}

// Avalia UMA mensagem (uma bolha ou o rascunho inteiro — chame nos dois).
// Devolve { ok } ou { ok:false, tipo, motivo, trechos }.
export function avaliar(texto, { permitirInformarPix = false, permitirCobrancaPix = false, permitirPedidoDinheiro = false, pixChave = '' } = {}) {
  const t = String(texto || '')
  if (!t.trim()) return { ok: true }

  // Antes de tudo: isto é uma resposta ou é a falha do provedor vestida de resposta? Vem
  // primeiro porque é o único caso em que o texto não é da voz de ninguém — nem errada.
  const sis = pareceMensagemDeSistema(t)
  if (sis) return { ok: false, tipo: 'sistema', motivo: sis.motivo, trechos: { sistema: sis.trechos || [] } }

  const fuso = achar(t, FUSO_INTERNO)
  if (fuso.length) {
    return {
      ok: false,
      tipo: 'fuso_interno',
      motivo: `a mensagem expõe uma configuração interna de fuso (${fuso.join(', ')})`,
      trechos: { fuso },
    }
  }

  const criancas = achar(t, CRIANCA)
  const apetites = achar(t, APETITE)
  if (criancas.length && apetites.length) {
    return {
      ok: false,
      tipo: 'crianca',
      motivo: `a mensagem fala de criança (${criancas.join(', ')}) usando vocabulário de atração (${apetites.join(', ')}). Isso pode ser lido como algo gravíssimo e não sai daqui de jeito nenhum.`,
      trechos: { crianca: criancas, apetite: apetites },
    }
  }

  // COBRANÇA SÓ SAI COM PERMISSÃO POR PESSOA.
  //
  // Ela está passando aperto financeiro e autorizou a IA a CONTAR isso, de vez em quando,
  // nunca no começo da conversa. Contar é uma coisa; pedir é outra, e a distância entre as
  // duas é a diferença entre desabafo e golpe. Numa conversa de paquera, um "me ajuda" ou um
  // pix no meio do papo destrói a reputação dela com aquela pessoa e pode ser lido como
  // extorsão. No futuro o sistema entregará uma permissão determinística por pessoa, junto
  // de motivo, valor e prazo. Até essa regra existir, permitirCobrancaPix fica falso.
  //
  // Então: o CONTAR mora no prompt, atrás de travas (`src/ai/assunto-grana.mjs`); COBRAR
  // mora aqui, atrás de autorização em código. Só ensinar o modelo não abre a permissão.
  const permitirPix = permitirInformarPix || permitirCobrancaPix
  const chaveComoCobranca = textoCobraComAChave(t, pixChave)
  if (chaveComoCobranca && !permitirPix) {
    return {
      ok: false,
      tipo: 'pix_sem_pedido',
      motivo: 'a mensagem expõe a chave PIX sem um pedido explícito no turno atual',
      trechos: { pix: ['chave PIX salva'] },
    }
  }

  const informar = permitirPix ? [] : achar(t, INFORMAR_PIX)
  // Pedido de dinheiro sem a chave só passa com permissão explícita do pedido único (1º tempo).
  // A flag de cobrança sozinha NÃO basta: um bit ligado por engano não pode virar "me ajuda no pix".
  // A chave continua exigindo permitirCobrancaPix (2º tempo, ou o turno em que ela pediu o PIX).
  const cobrancaComDados = (permitirCobrancaPix && chaveComoCobranca) || permitirPedidoDinheiro
  const pedidos = [...(cobrancaComDados ? [] : achar(t, PEDIR_DINHEIRO)), ...informar]
  if (pedidos.length) {
    return {
      ok: false,
      tipo: 'pedir_dinheiro',
      motivo: `a mensagem pede ou combina dinheiro sem autorização de cobrança (${pedidos.join(', ')}). A IA pode contar que ela está apertada; cobrar exige uma regra explícita para esta pessoa.`,
      trechos: { pedir: pedidos },
    }
  }

  for (const b of BATIDO) {
    if (b.re.test(norm(t))) return { ok: false, tipo: 'batido', motivo: b.oQue, trechos: { batido: [b.oQue] } }
  }
  return { ok: true }
}

// Avalia um rascunho que pode ter várias bolhas (a IA separa por quebra de linha).
// Checa bolha a bolha E o texto junto: "10 meses" numa linha e "gostosa" na outra é o mesmo
// desastre pra quem lê a conversa.
// ESTA MENSAGEM ESTÁ COBRANDO COM A CHAVE? — a pergunta única, usada em DOIS lugares:
// aqui, para decidir o envio, e no Progresso, para contar cobrança. Se cada um respondesse por
// conta própria, a tela contaria como cobrança justamente o que o portão deixou passar como
// conversa. Passar um telefone de contato não pode virar cobrança na estatística.
//
// Chave que é telefone só conta quando a mensagem fala de dinheiro; qualquer outro formato
// (CPF, e-mail, aleatória) conta sempre que aparece, porque não tem uso de contato.
export function textoCobraComAChave(texto, pixChave) {
  const t = norm(String(texto || ''))
  const chaveLiteral = String(pixChave || '').trim()
  if (!chaveLiteral || !t) return false
  const chaveDigitos = chaveLiteral.replace(/\D+/g, '')
  const textoDigitos = String(texto || '').replace(/\D+/g, '')
  const contemChave = t.includes(norm(chaveLiteral))
    || (chaveDigitos.length >= 8 && textoDigitos.includes(chaveDigitos))
  if (!contemChave) return false
  const chaveEhTelefone = TELEFONE_BR.test(chaveDigitos) && !ehCpf(chaveDigitos)
  if (!chaveEhTelefone) return true
  return CONTEXTO_DINHEIRO.some((re) => re.test(t))
}

export function avaliarRascunho(rascunho, options = {}) {
  const inteiro = avaliar(rascunho, options)
  if (!inteiro.ok) return inteiro
  for (const linha of String(rascunho || '').split(/\n+/)) {
    const r = avaliar(linha, options)
    if (!r.ok) return r
  }
  return { ok: true }
}

// O que dizer pro modelo quando vale tentar de novo. Específico de propósito: "escreva
// melhor" não corrige nada; nomear o defeito, sim.
export function instrucaoDeCorrecao(v) {
  if (v.tipo === 'batido') return `NÃO use ${v.motivo}. Reescreva com outra saída, mais natural e menos batida, mantendo o mesmo assunto.`
  if (v.tipo === 'fuso_interno') return 'Reescreva usando apenas a data ou a hora natural que importa na conversa. Não mencione fuso, offset, horário de Brasília nem configuração do sistema.'
  return 'Reescreva sem qualquer palavra de atração ou apetite perto do assunto de criança.'
}

// QUEM AVISA O HUMANO. Injetável de propósito: este módulo é puro (regex e comparação) e não
// pode depender do WhatsApp — mas um bloqueio SILENCIOSO seria péssimo, porque a pessoa fica
// sem resposta e ele não sabe por quê. O núcleo registra o avisador no boot.
let _avisador = null
export function aoBloquear(fn) { _avisador = typeof fn === 'function' ? fn : null }
export async function anunciarBloqueio({ tipo, motivo, texto, personId, channel, nome }) {
  if (!_avisador) return
  const cabeca = tipo === 'crianca'
    ? 'BLOQUEEI uma mensagem antes de sair, e é grave'
    : tipo === 'sistema'
      ? 'segurei uma falha técnica que ia sair como mensagem'
      : 'segurei uma mensagem antes de sair'
  const corpo = [
    cabeca,
    `pra: ${nome || personId} (${channel})`,
    `motivo: ${motivo}`,
    `o que ela ia escrever: "${String(texto || '').slice(0, 200)}"`,
    tipo === 'crianca' ? 'a pessoa ficou sem resposta de propósito. responda você, se quiser.'
      : tipo === 'sistema' ? 'era erro do provedor virando texto. não saiu nada, e a IA tenta de novo no próximo tick — se persistir, o provedor está fora.'
        : 'tentei reescrever e não deu; responda você, se quiser.',
  ].join('\n')
  try { await _avisador(corpo) } catch { /* aviso nunca derruba o bloqueio */ }
}

export { CRIANCA, APETITE, BATIDO, PEDIR_DINHEIRO, FUSO_INTERNO }
