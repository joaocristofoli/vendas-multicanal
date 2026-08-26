// Extração local e ampla do "Sobre mim".
//
// Lê TODO o corpus disponível de WhatsApp e Tinder, mas não envia conversa a provedor
// externo. A voz e o comportamento são medidos de forma determinística; fatos biográficos
// explícitos viram apenas PROPOSTAS, sujeitas à aprovação da dona.
import fs from 'node:fs/promises'
import path from 'node:path'
import { db } from '../core/db.mjs'
import { DATA_DIR } from '../core/caminhos.mjs'
import { nomeDono } from '../core/dono.mjs'
import { listarFatos, salvarFato } from './fatos.mjs'
import { pareceDuplicado } from './extrair.mjs'
import { ehExplicito } from '../ai/cadencia-quente.mjs'
import { temMarcadorCrianca } from '../ai/filtro.mjs'

const CANAIS = ['whatsapp', 'tinder']
const MIDIA = /^\[(audio|áudio|figurinha|imagem|video|vídeo|documento|localização|localizacao|contato|enquete|mensagem apagada|gif)\]$/i
const LINK_OU_ENCAMINHADO = /(https?:\/\/|\*Código do pedido|@all|Junte-se a mim)/i
const PII = /(?:\b\d{3}\.\d{3}\.\d{3}-?\d{2}\b|\b\d{2}\.?\d{3}\.?\d{3}[\/-]?\d{4}-?\d{2}\b|\b\+?55\s*\(?\d{2}\)?\s*9?\d{4}[-\s]?\d{4}\b|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b)/i
const MENOR_IDADE = /\b(?:1[3-7]\s*anos?|menor(?:es)? de idade|adolescent[ea]s?)\b/i
const JANELA_QUENTE_MS = 2 * 3_600_000

const pct = (n, total) => total ? +(n * 100 / total).toFixed(1) : 0
const palavras = (texto) => String(texto || '').trim().split(/\s+/).filter(Boolean)
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const ehDaDona = (m) => m.direction === 'outgoing' && m.author !== 'ia'
const ehTexto = (m) => String(m.text || '').trim() && !MIDIA.test(String(m.text || '').trim())
const quantil = (valores, q) => {
  if (!valores.length) return 0
  const s = valores.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * q)))]
}

export function coletarCorpus() {
  return db().prepare(`SELECT person_id,channel,direction,text,ts,author FROM message
    WHERE channel IN ('whatsapp','tinder') AND text IS NOT NULL AND length(trim(text))>0
    ORDER BY person_id,channel,ts,rowid`).all().map((row) => ({
      ...row,
      text: String(row.text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim(),
    }))
}

// WhatsApp não fornece o total remoto; por isso a cobertura dele nunca é apresentada como
// percentual total. Tinder tem `history_checked_at`, então ali a fração é auditável.
export function coberturaDoCorpus(corpus = coletarCorpus()) {
  const canais = {}
  for (const canal of CANAIS) {
    const rows = corpus.filter((m) => m.channel === canal)
    let periodoDe = null, periodoAte = null
    for (const m of rows) {
      const ts = Number(m.ts) || 0
      if (!periodoDe || ts < periodoDe) periodoDe = ts
      if (!periodoAte || ts > periodoAte) periodoAte = ts
    }
    canais[canal] = {
      mensagensDisponiveis: rows.length,
      mensagensDaDona: rows.filter((m) => ehDaDona(m) && ehTexto(m)).length,
      conversasComMensagens: new Set(rows.map((m) => m.person_id)).size,
      periodoDe,
      periodoAte,
    }
  }
  const wa = db().prepare(`SELECT COUNT(*) n FROM wa_chat`).get()?.n || 0
  const tinder = db().prepare(`SELECT
      SUM(CASE WHEN has_conversation=1 THEN 1 ELSE 0 END) conversas,
      SUM(CASE WHEN has_conversation=1 AND COALESCE(history_checked_at,0)>0 THEN 1 ELSE 0 END) verificadas
    FROM tinder_match`).get() || {}
  canais.whatsapp.conversasConhecidas = wa
  canais.whatsapp.totalRemotoConhecido = false
  canais.tinder.conversasConhecidas = Number(tinder.conversas) || 0
  canais.tinder.historicosVerificados = Number(tinder.verificadas) || 0
  canais.tinder.totalRemotoConhecido = true
  return {
    mensagensDisponiveis: corpus.length,
    mensagensDaDona: corpus.filter((m) => ehDaDona(m) && ehTexto(m)).length,
    conversasComMensagens: new Set(corpus.map((m) => `${m.channel}:${m.person_id}`)).size,
    canais,
  }
}

const ABREVIACOES = ['vc', 'vcs', 'pq', 'q', 'n', 'nn', 'ss', 'tb', 'tbm', 't', 'to', 'ta', 'td', 'nd', 'blz', 'obg', 'agr', 'hj', 'hr', 'cmg', 'vdd', 'sla', 'mds', 'fds', 'flw', 'vlw', 'oq', 'aq', 'aqi', 'msg']
const VOCATIVOS = ['man', 'mano', 'vei', 'véi', 'cara', 'mor', 'amor', 'bb', 'bebe', 'bebê', 'miga', 'amiga', 'amigo', 'lindo', 'linda', 'gata', 'gato', 'fi', 'moço', 'moça', 'gente']
const TEMAS = [
  ['trabalho', /\b(trabalh|estagi|servi[cç]|emprego|curr[íi]culo|entrevista|patr[ãa]o|expediente|folga|turno|sal[áa]rio)/i],
  ['estudo', /\b(faculdade|aula|prova|professor|estud|curso|matr[íi]cula|semestre|tcc|escola)/i],
  ['família', /\b(m[ãa]e|pai|irm[ãa]|av[óô]|fam[íi]lia|sobrinh|prim[ao]|tia|tio|filh)/i],
  ['festa e saída', /\b(festa|balada|bar|chopp|cerveja|beber|role|rolê|show|pagode|sertanej)/i],
  ['comida', /\b(comer|comida|almo[cç]|janta|lanche|pizza|hamb|fome|marmita|caf[ée]|doce|churrasc)/i],
  ['casa e rotina', /\b(casa|dormi|acordei|cansad|banho|limpe|arrum|lavar|lou[cç]a|faxina|cama|sono)/i],
  ['jogos', /\b(jogo|jogar|free fire|partida|slot|treino|campeonat|squad|discord)/i],
  ['música', /\b(m[úu]sica|som|playlist|spotify|cantor|banda|ouvindo)/i],
  ['viagem e lugar', /\b(viagem|viajar|praia|passeio|estrada|[ôo]nibus|cidade|interior)/i],
  ['saúde', /\b(m[ée]dic|rem[ée]di|dor de|dentista|consulta|exame|hospital|doente|gripe|febre)/i],
  ['dinheiro', /\b(pix|dinheiro|pagar|conta pra pagar|grana|caro|barato|sal[áa]rio|boleto|parcel)/i],
  ['relacionamento', /\b(namorad|casar|casamento|relacionament|ficante|crush|apaixon|solteir)/i],
  ['redes sociais', /\b(tiktok|instagram|insta|story|stories|reels|post|whatsapp|status)/i],
  ['animais', /\b(cachorr|gat[oa]|pet|ra[cç][ãa]o|filhote|miau)/i],
]

function frequenciaLista(mensagens, lista) {
  return lista.map((forma) => {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${forma.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'giu')
    const conversas = new Set()
    let vezes = 0
    for (const m of mensagens) {
      const n = (m.text.match(re) || []).length
      if (n) { vezes += n; conversas.add(`${m.channel}:${m.person_id}`) }
    }
    return { forma, vezes, conversas: conversas.size }
  }).filter((x) => x.vezes).sort((a, b) => b.vezes - a.vezes)
}

function frasesFrequentes(mensagens) {
  const mapa = new Map()
  for (const m of mensagens) {
    const t = String(m.text || '').trim().toLowerCase()
    if (!t || PII.test(t) || LINK_OU_ENCAMINHADO.test(t) || palavras(t).length > 5 || t.length > 50) continue
    const chave = semAcento(t).replace(/[^a-z0-9\s?!]/g, '').replace(/\s+/g, ' ').trim()
    if (!chave) continue
    if (!mapa.has(chave)) mapa.set(chave, { forma: t, vezes: 0, conversas: new Set() })
    const x = mapa.get(chave); x.vezes++; x.conversas.add(`${m.channel}:${m.person_id}`)
  }
  return [...mapa.values()].filter((x) => x.vezes >= 3 && x.conversas.size >= 2)
    .sort((a, b) => b.vezes - a.vezes).slice(0, 25)
    .map((x) => ({ forma: x.forma, vezes: x.vezes, conversas: x.conversas.size }))
}

function metricasTexto(rows) {
  const textos = rows.filter(ehTexto)
  const tamanhos = textos.map((m) => palavras(m.text).length)
  const conta = (re) => textos.filter((m) => re.test(String(m.text))).length
  return {
    mensagens: textos.length,
    palavrasMediana: quantil(tamanhos, .5),
    palavrasP75: quantil(tamanhos, .75),
    palavrasP90: quantil(tamanhos, .9),
    ate3PalavrasPct: pct(tamanhos.filter((n) => n <= 3).length, tamanhos.length),
    ate6PalavrasPct: pct(tamanhos.filter((n) => n <= 6).length, tamanhos.length),
    mais15PalavrasPct: pct(tamanhos.filter((n) => n > 15).length, tamanhos.length),
    perguntaPct: pct(conta(/\?/), textos.length),
    exclamacaoPct: pct(conta(/!/), textos.length),
    pontoFinalPct: pct(textos.filter((m) => /\.$/.test(m.text.trim())).length, textos.length),
    virgulaPct: pct(conta(/,/), textos.length),
    reticenciasPct: pct(conta(/\.\.\.|…/), textos.length),
    emojiPct: pct(conta(/\p{Extended_Pictographic}/u), textos.length),
    risadaPct: pct(conta(/(?:k{2,}|[kK]a[kK]a|haha|rsrs|hehe)/i), textos.length),
  }
}

export function estatisticasDoCorpus(corpus = coletarCorpus(), { ignorarFrases = new Set() } = {}) {
  const minhas = corpus.filter(ehDaDona)
  const textoMeu = minhas.filter(ehTexto)
  const grupos = new Map()
  // Mensagem da IA não é "outro lado" nem dona: ela sai inteiramente da linha do tempo
  // comportamental. Mantê-la mudaria tempo de resposta e reciprocidade mesmo sem entrar nas
  // métricas de texto — uma contaminação mais silenciosa que copiar o vocabulário dela.
  for (const m of corpus.filter((x) => x.author !== 'ia')) {
    const chave = `${m.channel}:${m.person_id}`
    if (!grupos.has(chave)) grupos.set(chave, [])
    grupos.get(chave).push(m)
  }
  let bolhas = 0, emRajada = 0, retomadasDona = 0, retomadasOutros = 0, turnosDona = 0, turnosOutros = 0
  const respostasMin = []
  for (const msgs of grupos.values()) {
    msgs.sort((a, b) => a.ts - b.ts)
    let ultimoLado = null
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i], ant = msgs[i - 1]
      const lado = ehDaDona(m) ? 'dona' : 'outro'
      if (lado !== ultimoLado) { if (lado === 'dona') turnosDona++; else turnosOutros++; ultimoLado = lado }
      if (ehDaDona(m)) {
        bolhas++
        if (ant && ehDaDona(ant) && m.ts - ant.ts <= 60_000) emRajada++
        if (ant && !ehDaDona(ant) && m.ts > ant.ts && m.ts - ant.ts <= 24 * 3_600_000) respostasMin.push((m.ts - ant.ts) / 60_000)
      }
      if (ant && m.ts - ant.ts >= 6 * 3_600_000) {
        if (ehDaDona(m)) retomadasDona++
        else retomadasOutros++
      }
    }
  }
  const temas = TEMAS.map(([tema, re]) => {
    const conversas = new Set(); let ocorrencias = 0
    for (const m of textoMeu) if (re.test(m.text)) { ocorrencias++; conversas.add(`${m.channel}:${m.person_id}`) }
    return { tema, ocorrencias, conversas: conversas.size }
  }).filter((x) => x.ocorrencias).sort((a, b) => b.conversas - a.conversas || b.ocorrencias - a.ocorrencias)
  return {
    universo: {
      mensagens: corpus.length,
      mensagensDaDona: minhas.length,
      textoDaDona: textoMeu.length,
      midiaDaDona: minhas.filter((m) => MIDIA.test(m.text.trim())).length,
      conversas: grupos.size,
      linksOuEncaminhados: minhas.filter((m) => LINK_OU_ENCAMINHADO.test(m.text)).length,
    },
    escrita: metricasTexto(minhas),
    ritmo: {
      bolhasEmRajadaPct: pct(emRajada, bolhas),
      respostasAmostra: respostasMin.length,
      respostasMedianaMin: respostasMin.length ? +quantil(respostasMin, .5).toFixed(2) : null,
      respostasP75Min: respostasMin.length ? +quantil(respostasMin, .75).toFixed(2) : null,
      respostasAte1MinPct: pct(respostasMin.filter((n) => n <= 1).length, respostasMin.length),
      respostasAte5MinPct: pct(respostasMin.filter((n) => n <= 5).length, respostasMin.length),
      retomadasAmostra: retomadasDona + retomadasOutros,
      retomadasPelaDonaPct: pct(retomadasDona, retomadasDona + retomadasOutros),
      retomadas: { dona: retomadasDona, outrasPessoas: retomadasOutros },
      reciprocidadeDeTurnos: turnosDona ? +(turnosOutros / turnosDona).toFixed(2) : 0,
    },
    abreviacoes: frequenciaLista(textoMeu, ABREVIACOES),
    vocativos: frequenciaLista(textoMeu, VOCATIVOS),
    // Frase sexual exata nunca sobe para o manual global. O registro íntimo é medido à
    // parte e entra somente no modo romance-quente, sempre como agregado.
    frasesFrequentes: frasesFrequentes(textoMeu.filter((m) => !ehExplicito(m.text) && !ignorarFrases.has(m))),
    temas,
    porCanal: Object.fromEntries(CANAIS.map((canal) => [canal, metricasTexto(minhas.filter((m) => m.channel === canal))])),
  }
}

const CATEGORIAS_QUENTES = [
  ['sugestão e provocação', /\b(?:te quero|quero (?:voce|você|vc)|vontade de (?:voce|você|vc)|imagina|provoc\w*|mal[ií]ci\w*|safad\w*|aqui comigo|na minha cama|dormir comigo)\b/i],
  ['convite ou pedido', /\b(?:vem|manda|mostra|fala|conta|continua|faz|quero|deixa eu|posso|pode)\b/i],
  ['reciprocidade afirmativa', /\b(?:sim|quero|gosto|adoro|pode|continua|tamb[eé]m|eu topo|bora)\b/i],
  ['afeto no meio do clima', /\b(?:amor|amorzinho|bb|beb[eê]|carinho|beij|saudade|lind[oa]|gat[oa])\b/i],
  ['limite ou desaceleração', /\b(?:agora n[aã]o|hoje n[aã]o|n[aã]o quero|n[aã]o curto|n[aã]o gosto|para|calma|devagar|sem pressa|melhor n[aã]o|deixa quieto|chega)\b/i],
  ['foto, vídeo ou áudio', /\b(?:foto|imagem|v[ií]deo|[aá]udio|nudes?|manda[r]? foto|mostrar|ver voc[eê])\b/i],
]

function dividirSessoes(rows) {
  const sessoes = []
  let atual = []
  for (const m of rows.slice().sort((a, b) => a.ts - b.ts)) {
    if (atual.length && m.ts - atual.at(-1).ts > JANELA_QUENTE_MS) {
      sessoes.push(atual)
      atual = []
    }
    atual.push(m)
  }
  if (atual.length) sessoes.push(atual)
  return sessoes
}

// Mede sexting sem guardar frases. O corte é conservador: se QUALQUER mensagem daquela
// conversa traz marcador de criança ou menor de idade, a conversa inteira fica fora — mesmo
// que o trecho explícito esteja longe dela no tempo.
export function estatisticasQuentes(corpus = coletarCorpus()) {
  const grupos = new Map()
  for (const m of corpus.filter((x) => x.author !== 'ia')) {
    const chave = `${m.channel}:${m.person_id}`
    if (!grupos.has(chave)) grupos.set(chave, [])
    grupos.get(chave).push(m)
  }

  const contextoDona = []
  let conversasExcluidasPorProtecao = 0
  let mensagensExcluidasPorProtecao = 0
  let conversasElegiveis = 0
  let sessoes = 0
  let sessoesIniciadasPelaDona = 0
  let sessoesIniciadasPelaOutraPessoa = 0
  let sessoesReciprocas = 0
  let bolhas = 0
  let emRajada = 0
  let explicitasDona = 0
  let explicitasOutros = 0
  const conversasComSinal = new Set()
  const respostasMin = []

  for (const [chave, originais] of grupos) {
    const rows = originais.slice().sort((a, b) => a.ts - b.ts)
    const protegida = rows.some((m) => temMarcadorCrianca(m.text) || MENOR_IDADE.test(semAcento(m.text)))
    if (protegida) {
      conversasExcluidasPorProtecao++
      mensagensExcluidasPorProtecao += rows.length
      continue
    }
    conversasElegiveis++
    for (const sessao of dividirSessoes(rows)) {
      const explicitas = sessao.filter((m) => ehTexto(m) && ehExplicito(m.text))
      if (!explicitas.length) continue
      sessoes++
      conversasComSinal.add(chave)
      if (ehDaDona(explicitas[0])) sessoesIniciadasPelaDona++
      else sessoesIniciadasPelaOutraPessoa++
      const explicitasMinhas = explicitas.filter(ehDaDona).length
      const explicitasDeles = explicitas.length - explicitasMinhas
      explicitasDona += explicitasMinhas
      explicitasOutros += explicitasDeles
      if (explicitasMinhas && explicitasDeles) sessoesReciprocas++

      for (let i = 0; i < sessao.length; i++) {
        const m = sessao[i]
        const ant = sessao[i - 1]
        if (!ehDaDona(m) || !ehTexto(m)) continue
        contextoDona.push(m)
        bolhas++
        if (ant && ehDaDona(ant) && m.ts - ant.ts <= 60_000) emRajada++
        if (ant && !ehDaDona(ant) && m.ts > ant.ts && m.ts - ant.ts <= JANELA_QUENTE_MS) {
          respostasMin.push((m.ts - ant.ts) / 60_000)
        }
      }
    }
  }

  const categorias = CATEGORIAS_QUENTES.map(([categoria, re]) => {
    const mensagens = contextoDona.filter((m) => re.test(m.text)).length
    return { categoria, mensagens, pct: pct(mensagens, contextoDona.length) }
  }).filter((x) => x.mensagens)
  const conversas = conversasComSinal.size
  const amostra = contextoDona.length >= 30 && conversas >= 3 ? 'robusta'
    : contextoDona.length >= 12 && conversas >= 2 ? 'moderada'
      : contextoDona.length >= 5 && conversas >= 1 ? 'inicial'
        : 'insuficiente'

  const resultado = {
    universo: {
      conversasAnalisadas: grupos.size,
      conversasElegiveis,
      conversasExcluidasPorProtecao,
      mensagensExcluidasPorProtecao,
      conversasComSinal: conversas,
      sessoes,
      mensagensDaDonaNoContexto: contextoDona.length,
      mensagensExplicitasDaDona: explicitasDona,
      mensagensExplicitasDosOutros: explicitasOutros,
    },
    qualidade: { amostra, geravel: amostra !== 'insuficiente' },
    escrita: metricasTexto(contextoDona),
    ritmo: {
      bolhasEmRajadaPct: pct(emRajada, bolhas),
      respostasAmostra: respostasMin.length,
      respostasMedianaMin: respostasMin.length ? +quantil(respostasMin, .5).toFixed(2) : null,
      sessoesIniciadasPelaDona,
      sessoesIniciadasPelaOutraPessoa,
      iniciativaDaDonaPct: pct(sessoesIniciadasPelaDona, sessoes),
      sessoesReciprocas,
      reciprocidadeExplicitaPct: pct(sessoesReciprocas, sessoes),
    },
    intensidade: {
      explicitaPct: pct(explicitasDona, contextoDona.length),
      sugestivaPct: pct(contextoDona.filter((m) => !ehExplicito(m.text) && CATEGORIAS_QUENTES[0][1].test(m.text)).length, contextoDona.length),
    },
    categorias,
  }
  // Auxilia a separação entre a voz global e o modo íntimo sem persistir IDs nem texto no
  // relatório: propriedade deliberadamente não enumerável.
  Object.defineProperty(resultado, '_contextoDona', { value: new Set(contextoDona), enumerable: false })
  return resultado
}

function fmtMin(n) {
  if (!Number.isFinite(n)) return 'sem amostra'
  if (n < 1) { const s = Math.max(1, Math.round(n * 60)); return `${s} segundo${s === 1 ? '' : 's'}` }
  if (n < 60) { const m = Math.round(n); return `${m} minuto${m === 1 ? '' : 's'}` }
  const h = +(n / 60).toFixed(1)
  return `${h} hora${h === 1 ? '' : 's'}`
}

function descricaoTamanho(e) {
  if (e.palavrasMediana <= 3) return 'A unidade natural é a bolha curta; uma resposta longa deve ser quebrada.'
  if (e.palavrasMediana <= 8) return 'A unidade natural é uma frase curta, sem desenvolver demais.'
  return 'Ela costuma desenvolver a frase; cortar tudo para duas palavras apagaria a voz.'
}

function listaMedida(itens, vazio = 'nenhum padrão forte medido') {
  if (!itens.length) return `- ${vazio}`
  return itens.slice(0, 14).map((x) => `- \`${x.forma}\`: ${x.vezes} vezes em ${x.conversas} conversa${x.conversas === 1 ? '' : 's'}`).join('\n')
}

function resumoCanal(nome, m) {
  if (!m.mensagens) return `- ${nome}: sem mensagens próprias de texto disponíveis`
  return `- ${nome}: mediana de ${m.palavrasMediana} ${m.palavrasMediana === 1 ? 'palavra' : 'palavras'}; ${m.perguntaPct}% com pergunta; ${m.risadaPct}% com risada`
}

function manualMarkdown(est, cob) {
  const e = est.escrita, r = est.ritmo, wa = cob.canais.whatsapp, ti = cob.canais.tinder
  const tiCob = ti.conversasConhecidas ? pct(ti.historicosVerificados, ti.conversasConhecidas) : 0
  const temas = est.temas.slice(0, 12).map((x) => `- ${x.tema}: apareceu em ${x.conversas} conversa${x.conversas === 1 ? '' : 's'} (${x.ocorrencias} mensagens)`).join('\n') || '- sem amostra suficiente'
  const resposta = r.respostasAmostra
    ? `- primeira resposta depois da outra pessoa: mediana de ${fmtMin(r.respostasMedianaMin)} em ${r.respostasAmostra} trocas; ${r.respostasAte1MinPct}% em até 1 minuto e ${r.respostasAte5MinPct}% em até 5 minutos`
    : '- tempo de resposta: sem amostra suficiente'
  const retomada = r.retomadasAmostra
    ? `- depois de 6 horas de silêncio, ela retomou ${r.retomadasPelaDonaPct}% das vezes (${r.retomadas.dona} retomadas dela e ${r.retomadas.outrasPessoas} das outras pessoas)`
    : '- retomada depois de silêncio longo: sem amostra suficiente'
  return `# Como eu converso

Este manual foi medido localmente em ${cob.mensagensDaDona.toLocaleString('pt-BR')} mensagens próprias de texto de ${cob.conversasComMensagens.toLocaleString('pt-BR')} conversas disponíveis. Nenhuma conversa bruta saiu desta máquina.

## 1. Formato

Mediana de **${e.palavrasMediana} ${e.palavrasMediana === 1 ? 'palavra' : 'palavras'}** por mensagem; ${e.ate3PalavrasPct}% têm até 3 palavras, ${e.ate6PalavrasPct}% até 6 e ${e.mais15PalavrasPct}% passam de 15. ${descricaoTamanho(e)}

${r.bolhasEmRajadaPct}% das bolhas próprias vieram até um minuto depois de outra bolha própria. Preserve esse ritmo: quando houver mais de uma ideia, prefira uma pequena sequência à transformação automática em parágrafo.

## 2. Escrita visível

- pergunta em ${e.perguntaPct}% das mensagens
- ponto final em ${e.pontoFinalPct}%
- vírgula em ${e.virgulaPct}%
- exclamação em ${e.exclamacaoPct}%
- reticências em ${e.reticenciasPct}%
- emoji em ${e.emojiPct}%
- risada escrita em ${e.risadaPct}%

Essas frequências são limites: uma marca rara não deve aparecer em toda resposta só porque existe no histórico.

## 3. Abreviações medidas

${listaMedida(est.abreviacoes)}

## 4. Como chama as pessoas

${listaMedida(est.vocativos)}

## 5. Respostas que realmente se repetem

${listaMedida(est.frasesFrequentes)}

Use as proporções e a função dessas respostas; não despeje bordões fora de contexto.

## 6. Ritmo e comportamento na conversa

${resposta}
${retomada}
- reciprocidade observada de turnos: ${r.reciprocidadeDeTurnos} turno da outra pessoa para cada turno dela

Isso descreve comportamento observado, não personalidade ou intenção. Não transforme demora, iniciativa ou silêncio em diagnóstico.

## 7. Terrenos de conversa

Os itens abaixo são assuntos recorrentes, não automaticamente gostos ou fatos biográficos:

${temas}

## 8. Mudança por canal

${resumoCanal('WhatsApp', est.porCanal.whatsapp)}
${resumoCanal('Tinder', est.porCanal.tinder)}

Só trate a diferença como mudança de registro quando os dois canais tiverem amostra. Canal também muda porque as pessoas e os assuntos mudam.

## 9. O que não imitar

- mensagens com autoria \`ia\` ficaram fora da amostra
- fala da outra pessoa nunca virou traço dela
- links e encaminhados não definem sintaxe própria
- frequência baixa não vira regra absoluta
- assunto recorrente não vira preferência sem afirmação explícita aprovada
- nenhum padrão desta leitura autoriza inventar fato, diagnóstico ou rótulo psicológico

## Cobertura desta leitura

- WhatsApp: ${wa.mensagensDisponiveis.toLocaleString('pt-BR')} mensagens disponíveis em ${wa.conversasComMensagens} de ${wa.conversasConhecidas} conversas conhecidas. O WhatsApp não declara o total remoto; isto é **tudo disponível na sessão**, não "100% do WhatsApp".
- Tinder: ${ti.mensagensDisponiveis.toLocaleString('pt-BR')} mensagens disponíveis em ${ti.conversasComMensagens} conversas; ${ti.historicosVerificados} de ${ti.conversasConhecidas} históricos de conversa marcados como verificados (${tiCob}%).
`
}

function nucleoMarkdown(est, cob) {
  const e = est.escrita, r = est.ritmo
  const abrev = est.abreviacoes.slice(0, 10).map((x) => `\`${x.forma}\``).join(', ') || 'nenhuma forte ainda'
  const voc = est.vocativos.slice(0, 7).map((x) => `\`${x.forma}\``).join(', ') || 'nenhum forte ainda'
  const frases = est.frasesFrequentes.slice(0, 8).map((x) => `\`${x.forma}\``).join(', ') || 'nenhuma forte ainda'
  return `# Núcleo da voz

Resumo local medido em ${cob.mensagensDaDona.toLocaleString('pt-BR')} mensagens próprias de texto disponíveis.

## Regras duras

**Não invente nada sobre mim.** Fato extraído só vale depois de aprovado no painel.

**Não copie a outra pessoa.** A voz abaixo vem somente de mensagens próprias sem autoria da IA.

## Forma

- mediana de ${e.palavrasMediana} ${e.palavrasMediana === 1 ? 'palavra' : 'palavras'}; ${e.ate3PalavrasPct}% têm até 3
- ${r.bolhasEmRajadaPct}% das bolhas saem em rajada; mais de uma ideia tende a virar mais de uma bolha
- pergunta ${e.perguntaPct}% · ponto final ${e.pontoFinalPct}% · vírgula ${e.virgulaPct}% · exclamação ${e.exclamacaoPct}% · emoji ${e.emojiPct}% · risada ${e.risadaPct}%
- abreviações mais sustentadas: ${abrev}
- vocativos mais sustentados: ${voc}
- respostas recorrentes: ${frases}

## Ritmo

Resposta mediana de ${fmtMin(r.respostasMedianaMin)}${r.respostasAmostra ? ` em ${r.respostasAmostra} trocas` : ''}. ${r.retomadasAmostra ? `Ela retomou ${r.retomadasPelaDonaPct}% das conversas depois de silêncio longo.` : 'Ainda não há amostra de retomada depois de silêncio longo.'} Use como tendência, nunca como obrigação ou jogo de demora.

## Limite da inferência

Assunto recorrente não é gosto confirmado. Padrão de conversa não é diagnóstico. Preserve a frequência: uma marca rara continua rara.
`
}

function quenteMarkdown(q) {
  const u = q.universo
  const e = q.escrita
  const r = q.ritmo
  const categorias = q.categorias.map((x) => `- ${x.categoria}: ${x.mensagens} mensagens (${x.pct}% da amostra)`).join('\n') || '- nenhuma categoria sustentada o bastante para medir'
  const iniciativa = u.sessoes
    ? `Em ${r.iniciativaDaDonaPct}% das ${u.sessoes} sessões medidas, a primeira mensagem explicitamente sexual foi dela; em ${r.reciprocidadeExplicitaPct}% houve registro explícito dos dois lados.`
    : 'Sem sessões suficientes para medir iniciativa.'
  const limite = q.categorias.find((x) => x.categoria === 'limite ou desaceleração')
  return `# Modo: romance quente (sexting)

Perfil local agregado, medido em ${u.mensagensDaDonaNoContexto} mensagens próprias dentro de ${u.sessoes} sessões com sinal explícito, em ${u.conversasComSinal} conversas. A amostra é **${q.qualidade.amostra}**. Nenhuma frase íntima foi copiada para este arquivo.

Este módulo só entra quando a outra pessoa é adulta confirmada e a conversa já está no modo \`romance-quente\`. Ele não autoriza iniciar sexo do nada, não substitui reciprocidade e não muda a cadência de descanso do sistema.

## Forma observada

- mediana de ${e.palavrasMediana} palavras por bolha; ${e.ate3PalavrasPct}% têm até 3 palavras
- ${r.bolhasEmRajadaPct}% das bolhas saem em rajada
- pergunta ${e.perguntaPct}% · emoji ${e.emojiPct}% · risada ${e.risadaPct}% · reticências ${e.reticenciasPct}%
- resposta mediana de ${fmtMin(r.respostasMedianaMin)}${r.respostasAmostra ? ` em ${r.respostasAmostra} trocas` : ''}
- ${q.intensidade.explicitaPct}% das mensagens do contexto foram diretamente explícitas; ${q.intensidade.sugestivaPct}% foram sugestivas sem serem explícitas

## Movimento da conversa

${iniciativa}

Categorias observadas podem se sobrepor:

${categorias}

## Limites que não se inferem

- ${limite ? `houve ${limite.mensagens} mensagem${limite.mensagens === 1 ? '' : 'ens'} com limite ou desaceleração; respeite esse movimento imediatamente` : 'não apareceu limite textual nessa amostra; ausência de registro nunca significa consentimento'}
- não invente preferência, fantasia, disponibilidade ou consentimento
- acompanhe somente um clima adulto, claro e recíproco; diante de ambiguidade, desacelere
- nunca leve vocabulário deste modo para conversa comum, contexto de criança ou menor de idade
- o portão de \`src/ai/filtro.mjs\` e o descanso de \`src/ai/cadencia-quente.mjs\` continuam absolutos

## Proteção da amostra

${u.conversasExcluidasPorProtecao} conversa${u.conversasExcluidasPorProtecao === 1 ? '' : 's'} inteira${u.conversasExcluidasPorProtecao === 1 ? '' : 's'} (${u.mensagensExcluidasPorProtecao} mensagens) ficou${u.conversasExcluidasPorProtecao === 1 ? '' : 'ram'} fora por conter marcador de criança ou menor de idade. Mensagens da IA também ficaram fora.
`
}

const CANDIDATOS_FATO = [
  /\b(?:eu\s+)?(?:moro|morava|nasci|cresci)\s+(?:em|no|na)\s+[^.!?]{2,90}/i,
  /\b(?:eu\s+)?(?:trabalho|trabalhava)\s+(?:com|em|no|na|como)\s+[^.!?]{2,100}/i,
  /\b(?:eu\s+)?(?:estudo|estudava|faço faculdade|faco faculdade|faço curso|faco curso)\s+[^.!?]{2,100}/i,
  /\b(?:eu\s+)?(?:tenho|tive)\s+(?:um|uma|dois|duas|minha|meu)?\s*(?:filh[oa]|irm[ãa]|cachorr[oa]|gat[oa]|pet)\b[^.!?]{0,90}/i,
  /\b(?:eu\s+)?(?:sou|estou)\s+(?:solteir[oa]|casad[oa]|divorciad[oa]|separad[oa]|vi[úu]v[oa])\b[^.!?]{0,70}/i,
  /\b(?:eu\s+)?(?:gosto|amo|adoro|odeio)\s+d[eo]\s+[^.!?]{2,80}/i,
]

function categoriaFato(texto) {
  if (/\b(moro|morava|nasci|cresci)\b/i.test(texto)) return 'lugar'
  if (/\btrabalh/i.test(texto)) return 'trabalho'
  if (/\b(estud|faculdade|curso)\b/i.test(texto)) return 'formacao'
  if (/\b(filh|irm|cachorr|gat|pet)\b/i.test(texto)) return 'familia'
  if (/\b(solteir|casad|divorci|separad|viuv)/i.test(semAcento(texto))) return 'relacionamento'
  if (/\b(gosto|amo|adoro|odeio)\b/i.test(texto)) return 'gosto'
  return 'outro'
}

function proporFatosLocais(corpus, ignorar = new Set()) {
  const existentes = listarFatos()
  const novos = []
  let duplicados = 0
  for (const m of corpus.filter((x) => ehDaDona(x) && ehTexto(x))) {
    if (PII.test(m.text) || LINK_OU_ENCAMINHADO.test(m.text) || m.text.length > 240 || ehExplicito(m.text) || ignorar.has(m)) continue
    for (const re of CANDIDATOS_FATO) {
      const achou = m.text.match(re)?.[0]?.replace(/\s+/g, ' ').trim()
      if (!achou || achou.length < 8) continue
      const texto = achou[0].toUpperCase() + achou.slice(1)
      if (pareceDuplicado(texto, [...existentes, ...novos])) { duplicados++; break }
      const categoria = categoriaFato(texto)
      const sensibilidade = ['familia', 'relacionamento'].includes(categoria) ? 'sob_pedido' : 'livre'
      const item = {
        texto, categoria, sensibilidade, status: 'proposto', confianca: .65,
        gatilhos: palavras(texto).filter((w) => w.length >= 5).slice(0, 6),
        origem: `extração local de ${m.channel}`,
      }
      item.id = salvarFato(item)
      novos.push(item)
      break
    }
  }
  return { propostos: novos.length, duplicados }
}

// O padrão ACOMPANHA a instância — nunca o nome de outra escrito à mão. Escrever a voz
// medida no `data/sobre-mim/` de outra pessoa é o pior caso da lição
// `clone-com-caminho-da-origem`: não dá erro nenhum e a IA de uma passa a ler o retrato da
// outra. Leitura TARDIA de propósito: quem define a variável depois (todo teste que monta
// fixture antes de importar) seria ignorado em silêncio se isto virasse constante de topo.
function caminhos() {
  const sobreMim = path.join(DATA_DIR, 'sobre-mim')
  const manual = process.env.TIM_CONVERSATION_STYLE_PATH || path.join(sobreMim, 'como-eu-converso.md')
  const nucleo = process.env.TIM_NUCLEO_VOZ_PATH || path.join(sobreMim, 'nucleo-voz.md')
  const relatorio = process.env.TIM_SOBRE_MIM_RELATORIO_PATH || path.join(path.dirname(manual), 'extracao-relatorio.json')
  const quente = process.env.TIM_MODO_QUENTE_PATH || path.join(process.env.TIM_MODOS_DIR || path.join(path.dirname(manual), 'modos'), 'romance-quente.md')
  return { manual, nucleo, relatorio, quente }
}

async function escreverAtomico(arquivo, conteudo) {
  await fs.mkdir(path.dirname(arquivo), { recursive: true })
  const temp = `${arquivo}.novo-${process.pid}-${Date.now()}`
  await fs.writeFile(temp, conteudo, 'utf8')
  await fs.rename(temp, arquivo)
}

export async function extrairSobreMim({ sincronizar, onProgress } = {}) {
  const sincronizacao = typeof sincronizar === 'function'
    ? await sincronizar({ onProgress })
    : { whatsapp: { estado: 'não solicitado' }, tinder: { estado: 'não solicitado' } }
  onProgress?.({ etapa: 'medindo', feito: 0, total: 3, detalhe: 'lendo todo o corpus disponível' })
  const corpus = coletarCorpus()
  const cobertura = coberturaDoCorpus(corpus)
  if (!cobertura.mensagensDaDona) throw new Error('não há mensagens próprias disponíveis no WhatsApp ou Tinder')
  const quente = estatisticasQuentes(corpus)
  const estatisticas = estatisticasDoCorpus(corpus, { ignorarFrases: quente._contextoDona })
  onProgress?.({ etapa: 'medindo', feito: 1, total: 3, detalhe: `${cobertura.mensagensDisponiveis} mensagens contabilizadas` })
  const fatos = proporFatosLocais(corpus, quente._contextoDona)
  onProgress?.({ etapa: 'cristalizando', feito: 2, total: 3, detalhe: 'gravando voz e comportamento medidos' })
  const out = caminhos()
  const geradoEm = Date.now()
  await escreverAtomico(out.nucleo, nucleoMarkdown(estatisticas, cobertura))
  await escreverAtomico(out.manual, manualMarkdown(estatisticas, cobertura))
  let quenteGerado = false
  if (quente.qualidade.geravel) {
    await escreverAtomico(out.quente, quenteMarkdown(quente))
    quenteGerado = true
  }
  await escreverAtomico(out.relatorio, JSON.stringify({ geradoEm, nome: nomeDono(), cobertura, estatisticas, quente: { ...quente, gerado: quenteGerado }, sincronizacao, fatos }, null, 2) + '\n')
  onProgress?.({ etapa: 'pronto', feito: 3, total: 3, detalhe: quenteGerado ? 'voz, comportamento, modo quente e fatos propostos' : 'voz e comportamento prontos; modo quente sem amostra suficiente' })
  return {
    ...fatos,
    geradoEm,
    mensagensLidas: cobertura.mensagensDisponiveis,
    mensagensDaDona: cobertura.mensagensDaDona,
    conversasLidas: cobertura.conversasComMensagens,
    cobertura,
    quente: { ...quente, gerado: quenteGerado },
    sincronizacao,
    arquivosAtualizados: ['nucleo-voz.md', 'como-eu-converso.md', ...(quenteGerado ? ['modos/romance-quente.md'] : [])],
    local: true,
  }
}
