// Compartilhamento opcional de uma dificuldade financeira pessoal. Nasce desligado e nunca
// pode virar pedido automático, pressão ou argumento comercial.
//
// São três restrições, e nenhuma delas sobrevive só no prompt:
//   1. NUNCA NO COMEÇO  -> exige conversa já rodada (mensagens dela e tempo)
//   2. NÃO TODA HORA    -> uma vez por pessoa, marcada no banco
//   3. CONTAR, NÃO PEDIR -> essa é a mais importante, e mora no filtro (`ai/filtro.mjs`,
//      tipo 'pedir_dinheiro'), porque é a que protege ela de parecer golpe.
//
// Por que trava de código e não instrução: "não fale toda hora" é exatamente o tipo de
// instrução que o modelo cumpre em 9 conversas e esquece na décima — e a décima é a que
// estraga. Aqui, se a janela não abriu, o bloco não existe no prompt; o modelo não tem o que
// esquecer.
import { db, getSetting } from '../core/db.mjs'
import { contextoParaIa, preparoPendente } from '../necessidades/store.mjs'
import { idsBrutosDaPessoa } from '../self/identidade.mjs'
import { vinculoDaPessoa } from '../self/vinculos.mjs'

// TODA conta desta página é feita sobre a PESSOA, não sobre a thread.
//
// Uma pessoa pode ter conversa em ids diferentes: o Tinder move as mensagens pro person_id
// dele, o Instagram agrupa por alias sem mover, e ainda pode sobrar um `wa:<jid>` com
// histórico antigo. Perguntar "há quantos dias eu falo com ela" olhando um id só responde
// pela THREAD — e a resposta vem menor do que a verdade, calada. `idsBrutosDaPessoa` é a
// função que já resolve os dois mecanismos de união; aqui ela vale pra idade da conversa e
// pra janela do assunto dinheiro.
function linhasDaPessoa(personId) {
  let ids = [String(personId)]
  try { ids = idsBrutosDaPessoa(personId) } catch { /* banco parcial: vale o id cru */ }
  if (!ids.length) return []
  const marcas = ids.map(() => '?').join(',')
  return db().prepare(
    `SELECT direction, ts FROM message WHERE person_id IN (${marcas}) AND text IS NOT NULL ORDER BY ts`,
  ).all(...ids)
}

// Conversa "já rodada": ela precisa ter falado de verdade, e não pode ser de hoje cedo.
// Os números são conservadores de propósito — errar pro lado de falar de menos é barato;
// falar de dificuldade financeira pra alguém que ela conheceu há 20 minutos, não.
const MIN_MENSAGENS_DELA = 8
const MIN_TROCAS = 20          // total dos dois lados
const MIN_HORAS_DE_CONVERSA = 24

export function garantirTabela() {
  db().exec(`CREATE TABLE IF NOT EXISTS assunto_contado (
    person_id TEXT NOT NULL, assunto TEXT NOT NULL, ts INTEGER,
    PRIMARY KEY (person_id, assunto)
  )`)
}

export function jaContou(personId, assunto = 'grana') {
  garantirTabela()
  return !!db().prepare(`SELECT 1 FROM assunto_contado WHERE person_id=? AND assunto=?`).get(personId, assunto)
}

export function marcarContado(personId, assunto = 'grana') {
  garantirTabela()
  db().prepare(`INSERT OR REPLACE INTO assunto_contado(person_id,assunto,ts) VALUES(?,?,?)`)
    .run(personId, assunto, Date.now())
}

// Há quantos DIAS INTEIROS esta conversa existe. É a régua da espera que cada necessidade
// pode ter ("só depois de N dias de conversa"), e a mesma medida que a janela geral usa em
// horas — uma conta só, pra tela e IA nunca discordarem sobre a idade da conversa.
// SÃO DUAS CONTAS, E ELAS NÃO SE SUBSTITUEM (observação do gestor, 13/08/2026):
//
//   corridos    — quanto tempo faz que vocês se falam. Do primeiro "oi" até hoje, contando
//                 os dias em que ninguém disse nada. É a régua da INTIMIDADE POR TEMPO:
//                 "faz um mês que a gente se fala".
//   conversados — em quantos dias diferentes houve conversa de verdade. É a régua da
//                 INTIMIDADE POR CONVÍVIO: quem sumiu três semanas não envelhece o vínculo.
//
// Quem conversou ontem, hoje, e uma vez há 12 dias tem 12 corridos e 3 conversados. Uma
// necessidade delicada pede a segunda; uma que só precisa que "não seja o primeiro dia"
// se resolve com a primeira.
//
// O dia é o dia DAQUI (America/Sao_Paulo). Contar em UTC jogaria toda conversa depois das
// 21h pro dia seguinte e inflaria a conta de quem fala à noite — que é quando ela fala.
const TZ_DIA = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
})

export function diasDeConversa(personId) {
  if (!personId) return 0
  try {
    // Não é SOMA de dias por canal: é o tempo desde a PRIMEIRA mensagem em qualquer canal
    // dela. Conversou 2 dias no Tinder e ontem no Instagram? Vocês se falam há 2 dias — o
    // Instagram não acrescenta um terceiro dia, ele continua a mesma conversa.
    const linhas = linhasDaPessoa(personId)
    if (!linhas.length) return 0
    return Math.max(0, Math.floor((Date.now() - linhas[0].ts) / 86_400_000))
  } catch { return 0 }
}

// Em quantos dias DIFERENTES houve conversa. Conta o dia em que a pessoa apareceu, não a
// quantidade de mensagens: 200 mensagens numa madrugada são um dia só.
export function diasConversados(personId) {
  if (!personId) return 0
  try {
    const dias = new Set()
    for (const l of linhasDaPessoa(personId)) if (l.ts) dias.add(TZ_DIA.format(new Date(l.ts)))
    return dias.size
  } catch { return 0 }
}

// QUANTOS MINUTOS DE CONVERSA DE VERDADE (regra configurada, 13/08/2026: "conversar por 40
// minutos antes de citar").
//
// Conversa não é a distância entre a primeira e a última mensagem: se ela mandou "oi" às 9h e
// "boa noite" às 22h, isso não é um dia inteiro de conversa. O que se mede aqui é o tempo
// ENGAJADO — a soma dos intervalos entre mensagens seguidas que estão perto uma da outra.
//
// Pausa maior que 15 minutos corta: quem voltou depois de meia hora começou outra conversa, e
// somar o intervalo inteiro transformaria duas mensagens distantes em "40 minutos de papo".
// Mensagem solta não vale nada, e é isso mesmo: uma frase não é conversa.
const GAP_MAX_MS = 15 * 60_000

export function minutosDeConversa(personId, dentroDeDias = 0) {
  if (!personId) return 0
  try {
    const desde = Number(dentroDeDias) > 0 ? Date.now() - Number(dentroDeDias) * 86_400_000 : 0
    const ts = linhasDaPessoa(personId).map((l) => l.ts).filter((t) => t && t >= desde).sort((a, b) => a - b)
    let ms = 0
    for (let i = 1; i < ts.length; i++) {
      const d = ts[i] - ts[i - 1]
      if (d > 0 && d <= GAP_MAX_MS) ms += d
    }
    return Math.floor(ms / 60_000)
  } catch { return 0 }
}

// Há quantos dias INTEIROS a IA está ligada pra esta pessoa (em algum canal).
// Não é a idade da conversa: quem se fala há um mês e só ligou a IA ontem tem 0.
// `enabled_at` é a virada do interruptor; `updated_at` muda a cada geração e mente.
export function diasDeIaLigada(personId) {
  if (!personId) return 0
  try {
    let ids = [String(personId)]
    try { ids = idsBrutosDaPessoa(personId) } catch { /* banco parcial */ }
    ids = [...new Set(ids.filter(Boolean))]
    if (!ids.length) return 0
    const marks = ids.map(() => '?').join(',')
    const row = db().prepare(
      `SELECT MIN(enabled_at) at FROM ai_setting WHERE enabled=1 AND person_id IN (${marks}) AND enabled_at IS NOT NULL`,
    ).get(...ids)
    if (!row?.at) return 0
    return Math.max(0, Math.floor((Date.now() - Number(row.at)) / 86_400_000))
  } catch { return 0 }
}

export function mensagensDaPessoa(personId) {
  if (!personId) return 0
  try {
    const linhas = linhasDaPessoa(personId)
    return linhas.length
  } catch { return 0 }
}

// As contas de uma vez — é assim que o gerador pergunta, porque cada necessidade escolhe a
// sua. `minutosEm` é FUNÇÃO porque cada necessidade pode olhar uma janela de dias diferente.
export function reguasDaConversa(personId) {
  const cache = new Map()
  return {
    corridos: diasDeConversa(personId),
    conversados: diasConversados(personId),
    iaLigada: diasDeIaLigada(personId),
    mensagens: mensagensDaPessoa(personId),
    minutosEm: (dias) => {
      const k = Number(dias) || 0
      if (!cache.has(k)) cache.set(k, minutosDeConversa(personId, k))
      return cache.get(k)
    },
  }
}

// A janela está aberta pra ESTA pessoa? Devolve { pode, porque } — o `porque` existe pra
// aparecer no Diário: decisão silenciosa é decisão que ninguém consegue auditar depois.
export function janelaAberta(personId) {
  if (!getSetting('personal_finance_sharing_enabled', false)) return { pode: false, porque: 'capacidade desligada' }
  if (!personId) return { pode: false, porque: 'sem pessoa' }
  if (jaContou(personId)) return { pode: false, porque: 'já contou pra essa pessoa' }
  let linhas = []
  try { linhas = linhasDaPessoa(personId) } catch { return { pode: false, porque: 'sem histórico' } }

  const dela = linhas.filter((m) => m.direction === 'outgoing').length
  if (linhas.length < MIN_TROCAS) return { pode: false, porque: `conversa curta (${linhas.length} de ${MIN_TROCAS})` }
  if (dela < MIN_MENSAGENS_DELA) return { pode: false, porque: `ela falou pouco (${dela} de ${MIN_MENSAGENS_DELA})` }
  const horas = (Date.now() - linhas[0].ts) / 3_600_000
  if (horas < MIN_HORAS_DE_CONVERSA) return { pode: false, porque: `conversa nova (${horas.toFixed(0)}h de ${MIN_HORAS_DE_CONVERSA}h)` }
  return { pode: true, porque: `${linhas.length} mensagens, ${dela} dela, ${Math.round(horas / 24)} dia(s)` }
}

// O bloco que entra no prompt quando a janela está aberta. Curto de propósito: quanto mais
// longo, mais o modelo trata como tarefa a cumprir — e o que se quer é o contrário, que ele
// use SÓ se a conversa pedir.
export const BLOCO = [
  'SOBRE DINHEIRO PESSOAL (capacidade opt-in):',
  '- Só mencione um fato verdadeiro e aprovado se ele for diretamente relevante à conversa.',
  '- Seja objetivo, sem drama, culpa, pressão, intimidade calculada ou urgência falsa.',
  '- NESTE CONTEXTO, NUNCA peça dinheiro, ajuda, pix, empréstimo ou presente. Uma cobrança',
  '  de trabalho é outro fluxo e só pode acontecer quando existir autorização específica',
  '  para aquela pessoa. Aqui, nunca insinue. Se a pessoa',
  '  oferecer, não aceite nem combine nada: agradeça e deixe pra depois — quem decide isso é',
  '  ela, pessoalmente, fora daqui.',
  '- Isso é um detalhe da vida dela, não o assunto da conversa. Uma vez, e só.',
].join('\n')

// Marca de que o rascunho tocou no assunto — pra não repetir com a mesma pessoa. Reconhece o
// desabafo, não o pedido (pedido nem chega aqui: o filtro barra antes).
// SEM `\b` NO FIM: estes são PREFIXOS. Com a barra final, "apertad" nunca casaria com
// "apertada" — que é exatamente como ela escreveria. É a mesma armadilha que já mordeu o
// detector de faculdade neste código, e o teste pegou de novo aqui.
const FALOU_DE_GRANA = /\b(apertad|sem grana|sem dinheiro|no zero|conta do mes|contas do mes|conta pra pagar|contas pra pagar|to dura|mes dificil|to quebrad|situacao dificil|sem condicao|nao ta sobrando|nao sobra|almocar|chefe nao me pagou|recompenso)/i

export function rascunhoTocouNoAssunto(texto) {
  // Compara sempre na forma sem acento: ela escreve "mês" e "mes" indistintamente.
  const semAcento = String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  return FALOU_DE_GRANA.test(semAcento)
}

// O bloco COM as necessidades que ela anotou na tela.
//
// Aqui entram descrição, valor e prazo do que está apertando. Isso deixa a fala concreta
// quando fizer sentido; o pedido/cobrança continua protegido pelo filtro, não por omissão
// do dado.
export function blocoComNecessidades(personId) {
  if (!getSetting('personal_finance_sharing_enabled', false)) return ''
  let oQue = ''
  // Cada necessidade tem a própria espera E a própria régua (regra configurada, 13/08/2026).
  // Quem está dentro do prazo entra; quem não está não é citado como proibido — não é
  // citado, ponto.
  // O TIPO da pessoa (paquera, amigo, cliente…) e o que foi decidido pra ela na ficha. Sem
  // isso, a necessidade que ele restringiu a um tipo entraria em qualquer conversa.
  let tipoDaPessoa = null
  let decisoes = null
  try { tipoDaPessoa = vinculoDaPessoa(personId)?.vinculo || null } catch { /* sem tagueamento */ }
  try { decisoes = decisoesDaPessoa(idsBrutosDaPessoa(personId)) } catch { /* banco parcial */ }
  try { oQue = contextoParaIa({ max: 3, ...reguasDaConversa(personId), tipoDaPessoa, decisoes }) } catch { oQue = '' }
  // (reguasDaConversa já entrega corridos, conversados e minutosEm — uma conta só pros dois)
  if (!oQue) return BLOCO
  // O PREPARO: quando uma necessidade só falta esquentar a conversa, o jeito escrito por ele
  // entra como instrução de COMO conduzir agora.
  //
  // E entra SEM DIZER QUAL É A NECESSIDADE. Nomear o assunto aqui seria entregar de bandeja o
  // que a trava está segurando: o modelo lê "antes de falar da conta de luz, faça X" e fala da
  // conta de luz. A instrução é só o jeito; o assunto continua fora do prompt.
  let preparo = null
  try { preparo = preparoPendente({ ...reguasDaConversa(personId), tipoDaPessoa, decisoes }) } catch { preparo = null }
  const comFala = /ela conta assim:/.test(oQue)
  return [
    BLOCO,
    `- O que está apertando agora: ${oQue}. Use isso só se ajudar a resposta; valor e prazo podem ser citados se fizerem diferença, sem inventar nada, e soando como algo que ela evitou dizer.`,
    // A linha de conversa é a frase que o gestor escreveu pra AQUELE assunto. Ela existe
    // justamente pra o modelo não inventar uma versão própria da história — então tem que
    // ficar claro no prompt que aquilo é fala dela, e não descrição do problema.
    comFala ? '- Onde estiver "ela conta assim", aquilo é o FATO do aperto — não é o texto da fala. Conte com as palavras DESTA conversa. Colar a linha pronta em todo mundo é o defeito. Nunca invente outra história (chefe, valor, o que falta).' : '',
    preparo ? `- AGORA, O JEITO DE CONDUZIR ESTA CONVERSA É: ${preparo.como} — faça só isso nesta mensagem, sem explicar por quê e sem puxar nada sobre dinheiro ou aperto ainda.` : '',
  ].filter(Boolean).join('\n')
}
