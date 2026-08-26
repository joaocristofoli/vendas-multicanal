// Progresso das conversas: quais estão andando, quais esfriaram, quanto ela responde e se a
// IA segura conversa como o dono. Tudo sai de SQL sobre a tabela message — nenhuma chamada
// de modelo, nem aqui nem no uso (regra "função eterna" no CLAUDE.md).
//
// ESTRUTURA: uma unidade de medida, três vistas.
// O átomo é a TENTATIVA — uma fala que já teve tempo de ser respondida, carimbada com quando
// terminou, se foi respondida, em quanto tempo, quem escreveu e se foi uma retomada. Tudo o
// mais é agregação disso: o resumo (soma tudo), a série (agrupa por semana) e a saúde de uma
// conversa (filtra por pessoa). Antes cada vista fazia a própria conta e elas podiam
// discordar; agora não têm como.
//
// O CONCEITO QUE FAZ A CONTA VALER É "TURNO", NÃO MENSAGEM.
// O o dono escreve em rajada ("Fechou" / "bora" / "kkk" = 3 mensagens, 1 fala). Medir resposta
// por mensagem faria 3 tentativas de uma só e afundaria a taxa dele sem nada ter acontecido.
// Turno = mensagens seguidas do mesmo lado. E um silêncio de 6h reabre o turno mesmo do mesmo
// lado: escrever de novo no dia seguinte é OUTRA tentativa, não a mesma.
//
// POR QUE "TAXA DE RESPOSTA" SOZINHA NÃO SERVE PRA DIZER SE VAI BEM.
// Medida assim ela deu 98% em TODAS as conversas dos dados reais, e 100% nas maiores. É
// tautológico: dentro de uma conversa viva toda fala é respondida, senão a conversa teria
// morrido ali. O único turno que pode ficar sem resposta é o último — então a taxa vira
// 1 menos 1/tentativas, ou seja, mede volume disfarçado de qualidade.
// O que separa uma conversa boa de uma morna é outra coisa:
//   RETOMADA   — escrevi depois de 12h de silêncio: ela voltou? É o momento da verdade.
//   IDAS E VINDAS — quantas vezes a bola trocou de lado. É o "andou" de verdade.
//   RECIPROCIDADE — ela escreve mais ou menos que eu.
//   TEMPO        — em quanto tempo ela responde.
//   VÁCUOS       — número absoluto de falas minhas que morreram, não porcentagem.
//
// A CONVERSA É COM A PESSOA, NÃO COM A REDE.
// Quando a mesma pessoa está no Tinder e no WhatsApp, é UMA conversa. Medir separado dizia
// que ela "esfriou no Tinder" enquanto vocês trocavam mensagem no WhatsApp o dia inteiro —
// e, pior, transformava a migração de canal em vácuo: eu escrevia no Tinder, ela respondia
// no WhatsApp, e a fala entrava como morta. A linha do tempo é UNIDA e ordenada por hora,
// e os turnos são montados em cima dela; responder por outra rede é responder.
// A união vem de `pessoaCanonica`, que resolve os dois mecanismos do tim (identity, que MOVE
// as mensagens no vínculo Tinder↔WhatsApp, e person_alias, o agrupamento lógico do Instagram).
// O quanto cada rede carrega NÃO se perde: vai em `porCanal`. O que não se faz é inferir
// assunto por rede — isso varia demais de pessoa pra pessoa pra virar regra.
//
// A LEITURA É SEMPRE DA HISTÓRIA INTEIRA, e o recorte de período acontece DEPOIS.
// Cortar no SQL truncava turnos na borda da janela: a primeira fala da janela perdia o
// silêncio que veio antes dela e deixava de ser reconhecida como retomada. Ler tudo (64 mil
// linhas, ~200ms) e filtrar as tentativas por data resolve isso de uma vez e é o que permite
// a série semanal retroativa — o histórico existe desde o primeiro dia, sem esperar coletar.
import { db } from '../core/db.mjs'
import { nomeParaMostrar } from '../core/nome.mjs'
import { pessoaCanonica, idsBrutosDaPessoa } from '../self/identidade.mjs'

const HORA = 3_600_000
const DIA = 86_400_000
const SEMANA = 7 * DIA

export const REGUA = {
  gapTurnoMs: 6 * HORA,        // silêncio que transforma "escrevi de novo" em nova tentativa
  janelaRespostaMs: 48 * HORA, // depois disso não é resposta, é conversa nova
  retomadaMs: 12 * HORA,       // escrever depois disso é retomar, não continuar
  andandoDias: 3,              // trocou nos últimos 3 dias = andando
  esfriandoDias: 14,           // de 4 a 14 dias = esfriando; acima disso, parada
  minMensagens: 2,             // com menos que isso não existe conversa pra medir
  novaMensagens: 6,            // ainda não deu tempo de saber se vai pra frente
  // Abaixo disso a porcentagem não é mostrada: 4 de 5 vira "80%" e passa por conclusão
  // quando é ruído. O número cru aparece do mesmo jeito, com o aviso de que falta amostra.
  amostraMinima: 20,
}

// ---------------------------------------------------------------- cache
// A leitura é da história inteira; sem cache cada troca de filtro relia tudo. A chave é só a
// conta, porque canal e período são recortes feitos em memória sobre a mesma base.
const CACHE_MS = 60_000
let base = { ts: 0, chave: '', dados: null }

export function limparCacheProgresso() { base = { ts: 0, chave: '', dados: null } }

// ---------------------------------------------------------------- turnos e tentativas
// Uma fala. Mensagens seguidas do mesmo lado viram um turno só; 6h de silêncio abrem outro.
function montarTurnos(msgs) {
  const out = []
  for (const m of msgs) {
    const t = out[out.length - 1]
    if (t && t.dir === m.direction && m.ts - t.fim < REGUA.gapTurnoMs) {
      t.fim = m.ts; t.n++
      if (m.author) t.autores.add(m.author)
      continue
    }
    out.push({ dir: m.direction, inicio: m.ts, fim: m.ts, n: 1, autores: new Set(m.author ? [m.author] : []) })
  }
  return out
}

// Quantas vezes a bola trocou de lado. É o "andou" da conversa: 40 idas e vindas é papo de
// verdade, 2 é um oi que não foi pra frente — e isso o total de mensagens esconde, porque
// uma rajada de 12 mensagens de um lado só conta como uma ida.
function marcarIdas(turnos) {
  const idas = []
  for (let i = 1; i < turnos.length; i++) if (turnos[i].dir !== turnos[i - 1].dir) idas.push(turnos[i].inicio)
  return idas
}

// As tentativas de um lado da conversa. Uma tentativa só existe depois que a janela de 48h
// fecha: enquanto está dentro dela e sem resposta, a fala está EM ABERTO — ainda não
// fracassou, então não pode contar como não-respondida.
function tentativasDoLado(turnos, dir, agora) {
  const out = []
  for (let i = 0; i < turnos.length; i++) {
    const t = turnos[i]
    if (t.dir !== dir) continue
    const prox = turnos[i + 1]
    const respondeu = !!prox && prox.dir !== dir && prox.inicio - t.fim <= REGUA.janelaRespostaMs
    const limite = prox ? prox.inicio : agora
    if (!respondeu && limite - t.fim <= REGUA.janelaRespostaMs) continue // em aberto
    const anterior = turnos[i - 1]
    out.push({
      // quando a fala terminou é o que define em que semana a tentativa entra
      fim: t.fim,
      respondeu,
      tempoMs: respondeu ? prox.inicio - t.fim : null,
      // turno misto ou sem carimbo não é atribuído a ninguém, em vez de ser chutado
      autor: t.autores.size === 1 ? [...t.autores][0] : null,
      // retomada = veio depois de um silêncio longo. A primeira fala de todas não conta:
      // não dá pra saber de quanto foi o silêncio antes dela.
      retomada: !!anterior && t.inicio - anterior.fim >= REGUA.retomadaMs,
    })
  }
  return out
}

function mediana(v) {
  if (!v.length) return null
  const s = [...v].sort((a, b) => a - b)
  const meio = Math.floor(s.length / 2)
  return s.length % 2 ? s[meio] : Math.round((s[meio - 1] + s[meio]) / 2)
}

// ---------------------------------------------------------------- a base
// Lê a história inteira uma vez e devolve as conversas já analisadas. Conversa = par
// (pessoa, canal): a mesma pessoa no Tinder e no WhatsApp são duas, porque uma pode estar
// viva e a outra morta e juntar as duas esconderia isso.
function lerBase(accountKey, personIds = null) {
  const chave = `${accountKey}|${personIds ? personIds.join(',') : '*'}`
  if (base.chave === chave && Date.now() - base.ts < CACHE_MS) return base.dados

  const onde = personIds?.length ? `WHERE person_id IN (${personIds.map(() => '?').join(',')})` : ''
  const args = personIds?.length ? personIds : []
  // sem filtro de texto: "[audio]" e "[imagem]" são mensagens da conversa como qualquer outra
  const linhas = db().prepare(`SELECT person_id, channel, direction, author, ts
    FROM message ${onde} ORDER BY ts ASC`).all(...args)

  // Um id bruto por vez, memorizado: `pessoaCanonica` consulta o banco e há ~1000 ids
  // distintos, mas só algumas centenas de pessoas.
  const canonDe = new Map()
  const canon = (id) => {
    let c = canonDe.get(id)
    if (c === undefined) { try { c = pessoaCanonica(id, accountKey) } catch { c = id }; canonDe.set(id, c) }
    return c
  }

  const porPessoa = new Map()
  for (const m of linhas) {
    const k = canon(m.person_id)
    let c = porPessoa.get(k)
    if (!c) { c = { personId: k, msgs: [], canais: new Map() }; porPessoa.set(k, c) }
    c.msgs.push(m)
    let ch = c.canais.get(m.channel)
    if (!ch) { ch = { canal: m.channel, n: 0, dela: 0, minhas: 0, primeira: m.ts, ultima: m.ts, personIdBruto: m.person_id }; c.canais.set(m.channel, ch) }
    ch.n++
    if (m.direction === 'incoming') ch.dela++; else ch.minhas++
    if (m.ts < ch.primeira) ch.primeira = m.ts
    if (m.ts > ch.ultima) ch.ultima = m.ts
  }

  const agora = Date.now()
  const dados = []
  for (const c of porPessoa.values()) {
    // a leitura já vem ordenada por hora, então a linha do tempo unida sai pronta
    const total = c.msgs.length
    if (total < REGUA.minMensagens) continue
    const dela = c.msgs.reduce((a, m) => a + (m.direction === 'incoming' ? 1 : 0), 0)
    const minhas = total - dela
    if (!dela || !minhas) continue // monólogo dos dois lados não é conversa
    const turnos = montarTurnos(c.msgs)
    dados.push({
      personId: c.personId,
      // o canal onde a conversa está viva HOJE: é por ele que o clique abre a thread certa
      canal: [...c.canais.values()].sort((a, b) => b.ultima - a.ultima)[0].canal,
      canais: [...c.canais.values()].sort((a, b) => b.ultima - a.ultima),
      total, dela, minhas,
      primeira: c.msgs[0].ts,
      ultima: c.msgs[total - 1].ts,
      ultimaDirecao: c.msgs[total - 1].direction,
      carimbadas: c.msgs.filter((m) => m.direction === 'outgoing' && m.author).map((m) => m.ts),
      idas: marcarIdas(turnos),
      minhasTentativas: tentativasDoLado(turnos, 'outgoing', agora),
      delasTentativas: tentativasDoLado(turnos, 'incoming', agora),
      // hora e lado de cada mensagem (sinal negativo = minha), pra recortar volume por
      // janela e por semana sem reler o banco
      carimbos: c.msgs.map((m) => (m.direction === 'incoming' ? m.ts : -m.ts)),
      // o mesmo carimbo, por canal, pra dizer quanto cada rede carrega DENTRO da janela
      carimbosPorCanal: c.msgs.map((m) => [m.ts, m.channel]),
    })
  }
  if (!personIds) base = { ts: Date.now(), chave, dados }
  return dados
}

// O filtro de canal ESCOLHE QUEM APARECE, não separa a medida: pessoa com mensagem naquela
// rede dentro da janela entra, e o número dela continua sendo o da conversa inteira. Filtrar
// pelo "canal de hoje" deixaria de fora quem começou no Tinder e migrou pro WhatsApp — que é
// justamente quem mais interessa.
function usaCanal(c, canal, desde, ate) {
  if (!canal) return true
  for (const [ts, ch] of c.carimbosPorCanal) if (ch === canal && ts >= desde && ts <= ate) return true
  return false
}

// ---------------------------------------------------------------- agregação
// Soma um punhado de tentativas. É a mesma função pro conjunto, pra uma semana e pra uma
// conversa — se cada uma somasse do seu jeito, as três telas podiam discordar.
export function agregar(tentativas) {
  let fechadas = 0, respondidas = 0, retomadas = 0, retomadasRespondidas = 0
  const tempos = []
  const zero = () => ({ fechadas: 0, respondidas: 0, retomadas: 0, retomadasRespondidas: 0 })
  const porAutor = { ia: zero(), joao: zero() }
  for (const t of tentativas) {
    fechadas++
    if (t.respondeu) { respondidas++; tempos.push(t.tempoMs) }
    if (t.retomada) { retomadas++; if (t.respondeu) retomadasRespondidas++ }
    const a = porAutor[t.autor]
    if (a) {
      a.fechadas++; if (t.respondeu) a.respondidas++
      if (t.retomada) { a.retomadas++; if (t.respondeu) a.retomadasRespondidas++ }
    }
  }
  return {
    fechadas, respondidas, vacuos: fechadas - respondidas,
    taxa: pct(respondidas, fechadas),
    retomadas, retomadasRespondidas,
    taxaRetomada: pct(retomadasRespondidas, retomadas),
    tempoRespostaMs: mediana(tempos),
    porAutor: { ia: comPct(porAutor.ia), joao: comPct(porAutor.joao) },
  }
}

// Porcentagem inteira, ou null quando não houve amostra — nunca 0 por falta de dado. A
// diferença entre "0%" e "não sei" é a diferença entre um fato e um chute.
function pct(parte, total) { return total ? Math.round((parte / total) * 100) : null }
function comPct(o) {
  return {
    ...o,
    pct: pct(o.respondidas, o.fechadas),
    pctRetomada: pct(o.retomadasRespondidas, o.retomadas),
    // a amostra manda: abaixo do mínimo a tela mostra o número cru e avisa, sem concluir
    bastante: o.retomadas >= REGUA.amostraMinima,
  }
}

// ---------------------------------------------------------------- estágio
function estagioDe({ total, ultima, agora }) {
  const dias = (agora - ultima) / DIA
  if (dias <= REGUA.andandoDias) return total < REGUA.novaMensagens ? 'nova' : 'andando'
  if (dias <= REGUA.esfriandoDias) return 'esfriando'
  return 'parada'
}

export const ESTAGIOS = { nova: 'começando', andando: 'andando', esfriando: 'esfriando', parada: 'parada' }

// ---------------------------------------------------------------- uma conversa
// Monta a linha de uma conversa dentro de um recorte de tempo. `desde` filtra as tentativas,
// mas o estágio e a última troca são SEMPRE do estado real de hoje: uma conversa não fica
// "andando" porque você escolheu olhar só o mês passado.
function linhaDaConversa(c, desde, agora, ate = Infinity) {
  const naJanela = (t) => t.fim >= desde && t.fim <= ate
  const minhas = c.minhasTentativas.filter(naJanela)
  const delas = c.delasTentativas.filter(naJanela)
  const eu = agregar(minhas)
  const ela = agregar(delas)
  const idas = c.idas.filter((ts) => ts >= desde && ts <= ate).length
  // volume DENTRO da janela (o carimbo negativo marca mensagem minha). Só o estágio e a
  // última troca ignoram a janela: eles descrevem o estado de hoje, não o do recorte.
  let nDela = 0, nMinhas = 0
  for (const k of c.carimbos) { const ts = Math.abs(k); if (ts < desde || ts > ate) continue; if (k > 0) nDela++; else nMinhas++ }
  // Quanto cada rede carrega DENTRO da janela. É o dado que a união não pode fazer sumir:
  // muita gente usa uma rede muito mais que a outra, e isso é normal, não é esfriamento.
  const porCanalJanela = new Map()
  for (const [ts, canal] of c.carimbosPorCanal) {
    if (ts < desde || ts > ate) continue
    porCanalJanela.set(canal, (porCanalJanela.get(canal) || 0) + 1)
  }
  const canais = [...porCanalJanela.entries()].sort((a, b) => b[1] - a[1])
    .map(([canal, n]) => ({ canal, n, pct: Math.round((n / (nDela + nMinhas || 1)) * 100) }))
  return {
    personId: c.personId,
    canal: c.canal,
    canais,
    // todos os canais da vida da pessoa, mesmo os sem mensagem na janela
    canaisVida: c.canais.map((x) => ({ canal: x.canal, n: x.n, ultima: x.ultima, personIdBruto: x.personIdBruto })),
    nome: nomeParaMostrar(c.personId),
    total: nDela + nMinhas, dela: nDela, minhas: nMinhas,
    totalVida: c.total,
    primeira: c.primeira, ultima: c.ultima, ultimaDirecao: c.ultimaDirecao,
    // "a vez é sua" quando ela falou por último: a bola está com você
    vez: c.ultimaDirecao === 'incoming' ? 'sua' : 'dela',
    paradaHa: agora - c.ultima,
    estagio: estagioDe({ total: c.total, ultima: c.ultima, agora }),
    estagioLabel: ESTAGIOS[estagioDe({ total: c.total, ultima: c.ultima, agora })],
    idasEVindas: idas,
    // ela respondendo você
    tentativas: eu.fechadas, respondidas: eu.respondidas, vacuos: eu.vacuos,
    pct: eu.taxa, pctRetomada: eu.taxaRetomada,
    retomadas: eu.retomadas, retomadasRespondidas: eu.retomadasRespondidas,
    tempoRespostaMs: eu.tempoRespostaMs,
    // você respondendo ela
    pctMinha: ela.taxa, vacuosDela: ela.vacuos, tempoMeuMs: ela.tempoRespostaMs,
    reciprocidade: nMinhas ? nDela / nMinhas : null,
    porAutor: eu.porAutor,
    outgoingCarimbadas: c.carimbadas.reduce((a, ts) => a + (ts >= desde && ts <= ate ? 1 : 0), 0),
    outgoingTotal: nMinhas,
  }
}

// A faixa que aparece dentro da conversa. null quando não há o que medir — melhor não
// mostrar nada do que mostrar 0% de uma conversa que nunca existiu.
// O canal de onde a chamada veio não filtra nada: a pessoa é uma só e a medida é da linha do
// tempo inteira dela. Ele serve só pra chegar aos ids brutos quando o chamador só tem um lado.
export function saudeDaConversa(personId, _canal, { accountKey = 'main' } = {}) {
  let ids
  try { ids = idsBrutosDaPessoa(String(personId), accountKey) } catch { ids = [String(personId)] }
  const todas = lerBase(accountKey, ids)
  if (!todas.length) return null
  todas.sort((a, b) => b.ultima - a.ultima)
  return linhaDaConversa(todas[0], 0, Date.now())
}

// ---------------------------------------------------------------- o conjunto
export function resumoConversas({ accountKey = 'main', dias = 30, canal = null, limite = 12, desde: desdeIn = null, ate: ateIn = null, incluirTodas = false } = {}) {
  const agora = Date.now()
  // a janela pode vir por período ("últimos 30 dias") ou por recorte explícito (uma semana
  // do gráfico). O recorte explícito é o que permite ir do número pras conversas que o
  // formaram sem inventar um segundo caminho de cálculo.
  const ate = ateIn || agora
  const desde = desdeIn != null ? desdeIn : (dias ? agora - dias * DIA : 0)
  const dentro = (c) => c.ultima >= desde && c.primeira <= ate
  const cs = lerBase(accountKey).filter((c) => dentro(c) && usaCanal(c, canal, desde, ate))
  const conversas = cs.map((c) => linhaDaConversa(c, desde, agora, ate))

  const minhas = [], delas = []
  for (const c of cs) {
    for (const t of c.minhasTentativas) if (t.fim >= desde && t.fim <= ate) minhas.push(t)
    for (const t of c.delasTentativas) if (t.fim >= desde && t.fim <= ate) delas.push(t)
  }
  const eu = agregar(minhas)
  const ela = agregar(delas)

  const porEstagio = { nova: 0, andando: 0, esfriando: 0, parada: 0 }
  for (const c of conversas) porEstagio[c.estagio]++

  const soma = (f) => conversas.reduce((a, c) => a + (f(c) || 0), 0)
  const vivas = conversas.filter((c) => c.estagio === 'andando' || c.estagio === 'nova')
  const esfriando = conversas.filter((c) => c.estagio === 'esfriando')
  const aguardando = conversas.filter((c) => c.vez === 'sua')
  const ordena = (arr, f) => [...arr].sort(f).slice(0, limite)

  return {
    janela: { dias: dias || null, desde: desde || null, ate, recorte: !!desdeIn },
    canal: canal || null,
    conversas: conversas.length,
    porEstagio,
    // a taxa de retomada é a que separa: dentro de conversa viva quase toda fala é
    // respondida, mas voltar depois do silêncio é onde a maioria morre.
    taxaRetomada: eu.taxaRetomada, retomadas: eu.retomadas, retomadasRespondidas: eu.retomadasRespondidas,
    taxaResposta: eu.taxa, tentativas: eu.fechadas, respondidas: eu.respondidas, vacuos: eu.vacuos,
    tempoRespostaMs: eu.tempoRespostaMs,
    // o outro lado do espelho: quanto VOCÊ deixa gente no vácuo
    seuVacuo: { taxa: ela.taxa, vacuos: ela.vacuos, tempoMs: ela.tempoRespostaMs, tentativas: ela.fechadas },
    bolaComVoce: aguardando.length,
    iaVsJoao: {
      ia: eu.porAutor.ia, joao: eu.porAutor.joao,
      cobertura: { carimbadas: soma((c) => c.outgoingCarimbadas), outgoing: soma((c) => c.outgoingTotal) },
      amostraMinima: REGUA.amostraMinima,
    },
    // "andando bem" é quem tem conversa DE VERDADE agora: manda pelas idas e vindas, não
    // pela taxa (que fica em 100% em qualquer conversa viva e não separa nada).
    andandoBem: ordena(vivas, (a, b) => (b.idasEVindas - a.idasEVindas) || (a.paradaHa - b.paradaHa)),
    esfriando: ordena(esfriando, (a, b) => a.paradaHa - b.paradaHa),
    aguardandoVoce: ordena(aguardando, (a, b) => b.paradaHa - a.paradaHa),
    // as listas são recortadas em `limite`; o total vai junto pra tela nunca dizer "12"
    // quando existem 64 — ver "parcial nunca é relatado como total" no CLAUDE.md
    totais: { andandoBem: vivas.length, esfriando: esfriando.length, aguardandoVoce: aguardando.length, limite },
    // a lista COMPLETA, sob demanda: os três rankings juntos não cobrem tudo (uma conversa
    // parada em que você falou por último não cai em nenhum deles), e exportar a união deles
    // como se fosse o universo seria apresentar parte como total.
    todas: incluirTodas ? conversas.slice().sort((a, b) => b.ultima - a.ultima) : undefined,
    regua: REGUA,
  }
}

// ---------------------------------------------------------------- a série no tempo
// O eixo que faltava. Mexer na IA e olhar um número só não diz nada: 91% é bom ou é pior do
// que era? A série é RETROATIVA (sai da mesma história já lida), então o histórico existe
// desde hoje, sem precisar guardar foto nenhuma pra começar a comparar.
export function serieConversas({ accountKey = 'main', dias = 90, canal = null, passo = SEMANA } = {}) {
  const agora = Date.now()
  const desde = dias ? agora - dias * DIA : 0
  const cs = lerBase(accountKey).filter((c) => usaCanal(c, canal, 0, agora))

  const inicioReal = desde || Math.min(...cs.map((c) => c.primeira).filter(Number.isFinite), agora)
  // baldes alinhados no fim: a última barra é sempre a semana corrente, que é a que interessa
  const baldes = []
  for (let fim = agora; fim > inicioReal; fim -= passo) baldes.unshift({ inicio: Math.max(inicioReal, fim - passo), fim })
  if (!baldes.length) return { passo, baldes: [] }

  const alvo = (ts) => {
    if (ts < baldes[0].inicio || ts > agora) return -1
    const i = Math.floor((ts - baldes[0].inicio) / passo)
    return Math.min(i, baldes.length - 1)
  }

  const vazio = () => ({ minhas: [], idas: 0, conversas: new Set(), mensagens: 0 })
  const acc = baldes.map(vazio)
  for (const c of cs) {
    for (const t of c.minhasTentativas) { const i = alvo(t.fim); if (i >= 0) acc[i].minhas.push(t) }
    for (const ts of c.idas) { const i = alvo(ts); if (i >= 0) acc[i].idas++ }
    for (const ts of c.carimbos) {
      const i = alvo(ts)
      if (i >= 0) { acc[i].conversas.add(c.personId + ' ' + c.canal); acc[i].mensagens++ }
    }
  }

  const linhas = baldes.map((b, i) => {
      const a = agregar(acc[i].minhas)
      return {
        inicio: b.inicio, fim: b.fim,
        // a última barra está incompleta por definição: a semana ainda não acabou
        parcial: i === baldes.length - 1,
        conversasAtivas: acc[i].conversas.size,
        mensagens: acc[i].mensagens,
        idasEVindas: acc[i].idas,
        tentativas: a.fechadas, respondidas: a.respondidas, vacuos: a.vacuos,
        taxaResposta: a.taxa,
        retomadas: a.retomadas, retomadasRespondidas: a.retomadasRespondidas,
        taxaRetomada: a.taxaRetomada,
        tempoRespostaMs: a.tempoRespostaMs,
        ia: a.porAutor.ia, joao: a.porAutor.joao,
      }
  })

  // Onde a série começa a valer. O banco tem meses antigos com uma conversa solta: plotar
  // isso espreme a parte com dado num canto e enche o resto de buraco. O corte é
  // determinístico — a primeira semana de uma sequência de 4 com amostra de verdade — e o
  // que foi cortado é REPORTADO, em vez de sumir calado.
  const CORRIDA = 4
  let inicio = 0
  for (let i = 0; i + CORRIDA <= linhas.length; i++) {
    if (linhas.slice(i, i + CORRIDA).every((b) => b.retomadas >= 5)) { inicio = i; break }
  }
  return {
    passo,
    ate: agora,
    baldes: linhas.slice(inicio),
    // quantas semanas ficaram de fora por não terem amostra pra plotar, e desde quando
    // a série é confiável
    semanasSemDado: inicio,
    desdeQuandoVale: linhas[inicio]?.inicio || null,
    amostraMinima: REGUA.amostraMinima,
  }
}

// ---------------------------------------------------------------- comparação com o antes
// Um número sozinho não diz se melhorou. Esta função devolve a MESMA medida na janela
// imediatamente anterior, do mesmo tamanho, e a diferença em pontos percentuais.
// A comparação só é declarada quando os DOIS lados têm amostra: 100% de 2 contra 60% de 90
// não é uma melhora de 40 pontos, é ruído contra fato.
export function compararPeriodo({ accountKey = 'main', dias = 30, canal = null } = {}) {
  if (!dias) return null // "tudo" não tem período anterior
  const agora = Date.now()
  const inicio = agora - dias * DIA
  const atual = resumoConversas({ accountKey, dias, canal, limite: 1 })
  const antes = resumoConversas({ accountKey, canal, limite: 1, desde: inicio - dias * DIA, ate: inicio })
  const delta = (a, b, minA, minB) => {
    if (a == null || b == null) return null
    if (minA < REGUA.amostraMinima || minB < REGUA.amostraMinima) return null
    return a - b
  }
  return {
    dias,
    de: { desde: inicio - dias * DIA, ate: inicio },
    retomada: {
      agora: atual.taxaRetomada, antes: antes.taxaRetomada,
      amostraAgora: atual.retomadas, amostraAntes: antes.retomadas,
      deltaPp: delta(atual.taxaRetomada, antes.taxaRetomada, atual.retomadas, antes.retomadas),
    },
    // NÃO comparar os estágios entre janelas: "andando" quer dizer "trocou nos últimos 3
    // dias contados de HOJE", então na janela anterior quase nada se qualifica e a diferença
    // vira um número enorme que não quer dizer nada. O que é comparável é quantas conversas
    // tiveram alguma troca dentro de cada janela.
    conversasNoPeriodo: { agora: atual.conversas, antes: antes.conversas },
    vacuos: { agora: atual.vacuos, antes: antes.vacuos },
    tempoRespostaMs: { agora: atual.tempoRespostaMs, antes: antes.tempoRespostaMs },
  }
}
