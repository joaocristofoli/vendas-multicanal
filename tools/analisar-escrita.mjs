#!/usr/bin/env node
// COMO ELA ESCREVE E COMO ELA RESPONDE — medido, sem modelo de linguagem.
//
// Complementa `analisar-voz.mjs` (que mede a voz no recorte romântico) com as três coisas
// que faltavam pra escrever o manual: RITMO (quanto ela demora, quando ela some, quem puxa),
// ORTOGRAFIA (as trocas que ela faz sempre — e que a IA tem que continuar fazendo) e
// ASSUNTO (do que ela fala, pra saber o que é dela e o que seria invenção).
//
// A REGRA QUE ESTE ARQUIVO EXISTE PRA NÃO DEIXAR QUEBRAR: marcador de mídia NÃO é fala.
// 27% das "mensagens dela" no banco são `[audio]`, `[figurinha]`, `[imagem]`, `[video]`.
// Contar isso como texto derruba a mediana pra 1 palavra e inventa uma pessoa monossilábica
// que não existe. Aqui a mídia é contada à parte e declarada — ela é um traço de
// comportamento (ela manda MUITO áudio), não uma frase curta.
//
// Uso: node tools/analisar-escrita.mjs [--json /caminho/saida.json] [--amostras N]
import { db } from '../src/core/db.mjs'

const arg = (nome, padrao = null) => { const i = process.argv.indexOf(nome); return i > 0 ? process.argv[i + 1] : padrao }
const N_AMOSTRAS = +arg('--amostras', 40)

// Marcador de mídia que o próprio sistema grava no lugar do conteúdo.
const MIDIA = /^\[(audio|áudio|figurinha|imagem|video|vídeo|documento|localização|localizacao|contato|enquete|mensagem apagada|gif)\]$/i
const ehMidia = (t) => MIDIA.test(String(t || '').trim())

// Dela = saiu do aparelho dela e não foi a IA. Se um dia a IA escrever, misturar as duas
// envenena a medida — por isso o autor entra na condição, não só a direção.
const dela = (m) => m.direction === 'outgoing' && m.author !== 'ia'

const linhas = db().prepare(`
  SELECT person_id, text, ts, direction, author FROM message
  WHERE channel='whatsapp' AND text IS NOT NULL AND length(trim(text))>0
  ORDER BY ts
`).all()

const minhasTudo = linhas.filter(dela)
const minhas = minhasTudo.filter((m) => !ehMidia(m.text))
const minhasMidia = minhasTudo.filter((m) => ehMidia(m.text))
const outrosTudo = linhas.filter((m) => m.direction === 'incoming')
const outros = outrosTudo.filter((m) => !ehMidia(m.text))

const palavras = (t) => String(t).trim().split(/\s+/).filter(Boolean)
const mediana = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2 }
const percentil = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }
const pct = (n, total) => (total ? +(n * 100 / total).toFixed(1) : 0)

// ---------------------------------------------------------------- tamanho
const tam = minhas.map((m) => palavras(m.text).length)
const tamanho = {
  n: minhas.length,
  mediana: mediana(tam),
  media: +(tam.reduce((a, b) => a + b, 0) / (tam.length || 1)).toFixed(2),
  p75: percentil(tam, 0.75),
  p90: percentil(tam, 0.90),
  p99: percentil(tam, 0.99),
  umaPalavraPct: pct(tam.filter((n) => n === 1).length, tam.length),
  ate3Pct: pct(tam.filter((n) => n <= 3).length, tam.length),
  ate6Pct: pct(tam.filter((n) => n <= 6).length, tam.length),
  mais15Pct: pct(tam.filter((n) => n > 15).length, tam.length),
  maior: Math.max(0, ...tam),
}

// ---------------------------------------------------------------- rajada (bolhas seguidas)
// Rajada = bolhas dela, na mesma conversa, com menos de 60s entre uma e outra. É o que
// diferencia "escreve um parágrafo" de "manda cinco linhas seguidas".
const porPessoa = new Map()
for (const m of linhas) {
  if (!porPessoa.has(m.person_id)) porPessoa.set(m.person_id, [])
  porPessoa.get(m.person_id).push(m)
}
let rajadas = 0, bolhasEmRajada = 0, maiorRajada = 0, bolhasTotal = 0
for (const msgs of porPessoa.values()) {
  let corrente = 0
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (!dela(m)) { if (corrente > 1) { rajadas++; bolhasEmRajada += corrente; maiorRajada = Math.max(maiorRajada, corrente) } corrente = 0; continue }
    bolhasTotal++
    const ant = msgs[i - 1]
    corrente = (ant && dela(ant) && m.ts - ant.ts < 60000) ? corrente + 1 : 1
  }
  if (corrente > 1) { rajadas++; bolhasEmRajada += corrente; maiorRajada = Math.max(maiorRajada, corrente) }
}

// ---------------------------------------------------------------- tempo de resposta
// Só conta o PRIMEIRO movimento dela depois de alguém falar. Bolha 2..n de uma rajada não é
// tempo de resposta, é a mesma resposta continuando — contar tudo espremeria a mediana pra
// perto de zero e diria que ela responde instantaneamente sempre.
const esperasDela = [], esperasDosOutros = [], porHora = new Array(24).fill(0)
let puxouEla = 0, puxaramOutros = 0
const SILENCIO_NOVA_CONVERSA = 6 * 3600 * 1000
for (const msgs of porPessoa.values()) {
  for (let i = 1; i < msgs.length; i++) {
    const ant = msgs[i - 1], m = msgs[i]
    const gap = m.ts - ant.ts
    const viraram = dela(m) !== dela(ant)
    if (viraram && gap < 24 * 3600 * 1000) {
      if (dela(m)) { esperasDela.push(gap / 60000); porHora[new Date(m.ts).getUTCHours()]++ }
      else esperasDosOutros.push(gap / 60000)
    }
    // retomada depois do silêncio: quem escreve primeiro
    if (gap >= SILENCIO_NOVA_CONVERSA) { if (dela(m)) puxouEla++; else puxaramOutros++ }
  }
}
const faixas = (a) => ({
  ate1min: pct(a.filter((x) => x <= 1).length, a.length),
  de1a5min: pct(a.filter((x) => x > 1 && x <= 5).length, a.length),
  de5a30min: pct(a.filter((x) => x > 5 && x <= 30).length, a.length),
  de30mina2h: pct(a.filter((x) => x > 30 && x <= 120).length, a.length),
  de2ha12h: pct(a.filter((x) => x > 120 && x <= 720).length, a.length),
  mais12h: pct(a.filter((x) => x > 720).length, a.length),
})
const resposta = {
  n: esperasDela.length,
  medianaMin: +mediana(esperasDela).toFixed(2),
  p25Min: +percentil(esperasDela, 0.25).toFixed(2),
  p75Min: +percentil(esperasDela, 0.75).toFixed(2),
  p90Min: +percentil(esperasDela, 0.90).toFixed(1),
  faixas: faixas(esperasDela),
  osOutrosMedianaMin: +mediana(esperasDosOutros).toFixed(2),
  osOutrosFaixas: faixas(esperasDosOutros),
  retomada: { ela: puxouEla, osOutros: puxaramOutros, elaPct: pct(puxouEla, puxouEla + puxaramOutros) },
  // fuso: o banco grava epoch; a VM roda em UTC e ela vive em -03
  porHoraLocal: porHora.map((n, h) => [(h + 21) % 24, n]).sort((a, b) => a[0] - b[0]),
}

// ---------------------------------------------------------------- ortografia
// As TROCAS: para cada palavra que tem forma padrão e forma dela, conta as duas. É isto que
// responde "que erro tem que continuar" — sem achismo, com o placar.
// CADA PAR TEM QUE SER MUTUAMENTE EXCLUSIVO, senão o placar mente. Três armadilhas que já
// caíram aqui: `é` vs `e` é indecidível (o "e" de conjunção é a mesma letra — só "eh" conta);
// `pra` é forma corrente do português falado e estava sendo contada dos DOIS lados, dando um
// empate falso de 49,5%; e `aqui` aparecia dentro da própria alternativa "dela".
const TROCAS = [
  ['não', /\bnão\b/gi, /\b(nao|nn)\b/g], ['está/tá', /\b(está|tá)\b/gi, /\b(ta|t)\b/g],
  ['você', /\bvocê\b/gi, /\b(vc|voce|vcs)\b/g], ['aí', /\baí\b/gi, /\bai\b/g],
  ['é (só "eh")', /\bé\b/gi, /\beh\b/g], ['também', /\btambém\b/gi, /\b(tambem|tbm|tb)\b/g],
  ['que', /\bque\b/gi, /\bq\b/g], ['para', /\bpara\b/gi, /\b(pra|pr)\b/g],
  ['de', /\bde\b/gi, /\bd\b/g], ['por que/pq', /\bpor ?qu[eê]\b/gi, /\bpq\b/g],
  ['até', /\baté\b/gi, /\bate\b/g], ['aqui', /\baqui\b/gi, /\b(aq|aqu|aquu)\b/g],
  ['hora', /\bhora\b/gi, /\bhr\b/g], ['nada', /\bnada\b/gi, /\bnd\b/g],
  ['beleza', /\bbeleza\b/gi, /\bblz\b/g], ['obrigada', /\bobrigada\b/gi, /\b(obg|brigada)\b/g],
]
const textoDela = minhas.map((m) => m.text).join('\n')
const textoBaixo = textoDela.toLowerCase()
const conta = (re) => (textoBaixo.match(re) || []).length
const trocas = TROCAS.map(([nome, padraoRe, delaRe]) => {
  const p = conta(padraoRe), d = conta(delaRe)
  return { palavra: nome, formaPadrao: p, formaDela: d, delaPct: pct(d, p + d) }
}).filter((t) => t.formaPadrao + t.formaDela >= 20).sort((a, b) => b.delaPct - a.delaPct)

// Acento: quantas das palavras acentuáveis mais comuns ela escreve SEM acento.
const ACENTUAVEIS = ['não', 'é', 'está', 'você', 'aí', 'até', 'também', 'só', 'já', 'vô', 'avó', 'três', 'após', 'português', 'amanhã', 'coração', 'história', 'família', 'férias', 'saúde']
const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
let comAcentoN = 0, semAcentoN = 0
for (const p of ACENTUAVEIS) {
  const re = (w) => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g')
  comAcentoN += (textoBaixo.match(re(p)) || []).length
  if (semAcento(p) !== p) semAcentoN += (textoBaixo.match(re(semAcento(p))) || []).length
}

const linhasDela = minhas.map((m) => m.text.trim()).filter(Boolean)
const escrita = {
  maiusculaNoInicioPct: pct(linhasDela.filter((t) => /^[A-ZÀ-Ý]/.test(t)).length, linhasDela.length),
  pontoFinalPct: pct(linhasDela.filter((t) => /[.]$/.test(t)).length, linhasDela.length),
  virgulaPct: pct(linhasDela.filter((t) => t.includes(',')).length, linhasDela.length),
  interrogacaoPct: pct(linhasDela.filter((t) => t.includes('?')).length, linhasDela.length),
  exclamacaoPct: pct(linhasDela.filter((t) => t.includes('!')).length, linhasDela.length),
  reticenciasPct: pct(linhasDela.filter((t) => /\.\.\./.test(t)).length, linhasDela.length),
  travessaoPct: pct(linhasDela.filter((t) => /—|–/.test(t)).length, linhasDela.length),
  comEmojiPct: pct(linhasDela.filter((t) => /\p{Extended_Pictographic}/u.test(t)).length, linhasDela.length),
  acentoEscritoPct: pct(comAcentoN, comAcentoN + semAcentoN),
  trocas,
}

// ---------------------------------------------------------------- risada
const FORMAS_RISADA = [['kkk (minúsculo)', /\bk{2,}\b/g], ['Kkk (maiúsculo)', /\bK+k+\b/g], ['kakaka', /\b[kK]a([kK]a)+\b/g],
  ['haha', /\b[hH]a([hH]a)+\b/g], ['rsrs', /\b(rs){2,}\b/g], ['hehe', /\b[hH]e([hH]e)+\b/g]]
const risada = {
  mensagensComRisadaPct: pct(linhasDela.filter((t) => /(k{2,}|[kK]a[kK]a|[hH]a[hH]a|(rs){2,}|[hH]e[hH]e)/.test(t)).length, linhasDela.length),
  formas: FORMAS_RISADA.map(([nome, re]) => [nome, (textoDela.match(re) || []).length]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]),
  maiorSequencia: (textoDela.match(/k{2,}/gi) || []).reduce((a, s) => Math.max(a, s.length), 0),
}

// ---------------------------------------------------------------- vocabulário e assunto
const VAZIAS = new Set(('a o e de da do que em um uma pra para com no na os as não nao eu vc você te me se ja já ta tá tô to é eh foi vai vou ai aí aqui la lá isso isso'
  + ' mas mais ainda so só bem ter tem tenho ser sou meu minha seu sua ele ela nos nós dos das ao à às aos por pq porque quando como onde qual quem tudo todo toda nada'
  + ' sim nao ok blz kkk kkkk kkkkk d q t n hj hr tbm tb pq vc oi ola olá bom boa dia tarde noite hoje amanha amanhã ontem agora depois antes entao então tipo coisa'
  + ' fazer faz fez fazendo vamos vou vem veio ir foi era estava esta está tava to tá sei sabe saber acho achei quer quero queria pode posso vai da dá deu').split(/\s+/))
const freq = new Map()
for (const t of linhasDela) {
  for (const w of semAcento(t.toLowerCase()).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (!w || w.length < 3 || VAZIAS.has(w)) continue
    freq.set(w, (freq.get(w) || 0) + 1)
  }
}
const vocabulario = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)

// Abreviações: token curtíssimo e frequente é a assinatura da escrita dela.
const freqCurtas = new Map()
for (const t of linhasDela) {
  for (const w of t.toLowerCase().replace(/[^a-zà-ÿ0-9\s]/g, ' ').split(/\s+/)) {
    if (!w || w.length > 4) continue
    freqCurtas.set(w, (freqCurtas.get(w) || 0) + 1)
  }
}
const abreviacoes = [...freqCurtas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 45)

// ---------------------------------------------------------------- assunto e tratamento
// DO QUE ELA FALA, contado por conversa e não por mensagem: um assunto citado 80 vezes numa
// conversa só é obsessão de um relacionamento, não um interesse dela. O que vale pra dizer
// "isso é assunto dela" é aparecer em MUITAS conversas diferentes.
const TEMAS = [
  ['trabalho/estágio', /\b(trabalh|estagi|serviç|servic|emprego|curr[íi]culo|entrevista|patr[ãa]o|expediente|folga|turno|sal[áa]rio|contrat)/i],
  ['faculdade/estudo', /\b(faculdade|aula|prova|trabalho da facu|professor|estud|curso|matr[íi]cula|semestre|tcc|escola)/i],
  ['família', /\b(m[ãa]e|pai|irm[ãa]|vó|vô|vo[ck]|fam[íi]lia|sobrinh|prim[ao]|tia|tio|filh)/i],
  ['festa/balada', /\b(festa|balada|bar|chopp|cerveja|bebe|beber|bêbad|bebad|sair a noite|role|rolê|show|pagode|sertanej)/i],
  ['comida', /\b(comer|comida|almoç|janta|lanche|pizza|hamb|x salada|fome|marmita|café|doce|churrasc)/i],
  ['casa/rotina', /\b(casa|dormi|acordei|cansad|banho|limpe|arrum|lavar|louça|faxina|cama|sono)/i],
  ['jogos', /\b(jogo|jogar|free fire|ff|partida|slot|treino|campeonat|squad|clã|cla|mobile|discord)/i],
  ['igreja/fé', /\b(deus|igreja|cult|ora[çc][ãa]o|rezar|f[ée] em deus|gra[çc]as a deus|am[ée]m)/i],
  ['tarô/signos', /\b(carta[s]? mostr|tar[ôo]|signo|hor[óo]scopo|mapa astral|mercúrio|energia dele|universo conspira)/i],
  ['música', /\b(música|musica|som|playlist|spotify|cantor|banda|ouvindo)/i],
  ['viagem', /\b(viagem|viajar|praia|passeio|estrada|ônibus|onibus|foz|curitiba|cascavel|toledo)/i],
  ['saúde', /\b(médic|medic|remédi|remedi|dor de|dentista|consulta|exame|hospital|doente|gripe|febre)/i],
  ['dinheiro', /\b(pix|dinheiro|pagar|conta pra pagar|grana|caro|barato|salário|salario|boleto|parcel)/i],
  ['relacionamento', /\b(namorad|casar|casamento|relacionament|ex |ficante|crush|apaixon|solteira|sozinha)/i],
  ['tiktok/redes', /\b(tiktok|instagram|insta|story|stories|reels|post|whatsapp status)/i],
  ['pets', /\b(cachorr|gat[oa] |pet|dog|ra[çc][ãa]o|filhote|au au|miau)/i],
]
const temas = TEMAS.map(([nome, re]) => {
  const conversasComTema = new Set()
  let ocorrencias = 0
  for (const m of minhas) if (re.test(m.text)) { ocorrencias++; conversasComTema.add(m.person_id) }
  return { tema: nome, ocorrencias, conversas: conversasComTema.size }
}).sort((a, b) => b.conversas - a.conversas)

// COMO ELA CHAMA AS PESSOAS. É a marca mais audível de uma voz e a mais fácil de errar.
const VOCATIVOS = ['man', 'vei', 'mano', 'cara', 'mor', 'amiga', 'amigo', 'bb', 'linda', 'lindo', 'gata', 'fi', 'véi', 'moço', 'gente', 'migx', 'miga']
const tratamento = VOCATIVOS.map((v) => {
  const re = new RegExp('\\b' + v + '\\b', 'gi')
  const conversasCom = new Set()
  let n = 0
  for (const m of minhas) { const c = (m.text.match(re) || []).length; if (c) { n += c; conversasCom.add(m.person_id) } }
  return { palavra: v, vezes: n, conversas: conversasCom.size }
}).filter((t) => t.vezes > 0).sort((a, b) => b.vezes - a.vezes)

// ENCAMINHADO NÃO É VOZ. Promoção de balada, recibo de delivery e convite de app entram no
// banco como mensagem dela e sequestram qualquer leitura das "mensagens mais longas" — foi
// exatamente o que apareceu na primeira leitura aqui. Marcados pra ficarem de fora.
const ENCAMINHADO = /(https?:\/\/|whatsmenu|tiktok\.com|\*Código do pedido|SLOT \d|ESGOTADO|@all|Junte-se a mim)/i
const ehVozDela = (t) => !ENCAMINHADO.test(t)

// ---------------------------------------------------------------- amostras
// Seleção determinística: as mensagens mais REPETIDAS dela (o que ela diz sempre) e uma
// fatia das longas (onde a personalidade aparece inteira).
const repetidas = new Map()
for (const t of linhasDela) { const k = t.toLowerCase(); repetidas.set(k, (repetidas.get(k) || 0) + 1) }
const maisDitas = [...repetidas.entries()].sort((a, b) => b[1] - a[1]).slice(0, N_AMOSTRAS)
const maisLongas = linhasDela.filter(ehVozDela).sort((a, b) => palavras(b).length - palavras(a).length).slice(0, 25)
// A faixa do meio (7 a 14 palavras) é onde mora a frase inteira dela: grande o bastante pra
// ter sintaxe, pequena o bastante pra não ser texto copiado.
const medias = linhasDela.filter((t) => ehVozDela(t) && palavras(t).length >= 7 && palavras(t).length <= 14)
const amostraMedias = medias.filter((_, i) => i % Math.max(1, Math.floor(medias.length / 30)) === 0).slice(0, 30)

const saida = {
  universo: {
    mensagens: linhas.length,
    delaTexto: minhas.length,
    delaMidia: minhasMidia.length,
    delaMidiaPct: pct(minhasMidia.length, minhasTudo.length),
    midiaPorTipo: [...minhasMidia.reduce((m, x) => m.set(x.text.trim().toLowerCase(), (m.get(x.text.trim().toLowerCase()) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]),
    outrosTexto: outros.length,
    conversas: porPessoa.size,
    periodo: [new Date(linhas[0]?.ts || 0).toISOString().slice(0, 10), new Date(linhas[linhas.length - 1]?.ts || 0).toISOString().slice(0, 10)],
  },
  tamanho,
  rajada: { rajadas, bolhasEmRajadaPct: pct(bolhasEmRajada, bolhasTotal), maiorRajada, mediaBolhasPorRajada: +(bolhasEmRajada / (rajadas || 1)).toFixed(2) },
  resposta,
  escrita,
  risada,
  vocabulario,
  abreviacoes,
  temas,
  tratamento,
  maisDitas,
  maisLongas,
  amostraMedias,
}

const destino = arg('--json')
if (destino) { const { writeFileSync } = await import('node:fs'); writeFileSync(destino, JSON.stringify(saida, null, 1)); console.log('escrito em ' + destino) }
else console.log(JSON.stringify(saida, null, 1))
