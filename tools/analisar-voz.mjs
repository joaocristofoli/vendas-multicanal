#!/usr/bin/env node
// A VOZ DA DONA DESTE SISTEMA, medida no histórico real — sem modelo de linguagem.
//
// Por que determinístico: "como ela fala" é contagem, não interpretação. Tamanho de
// mensagem, taxa de risada, emoji preferido, com que frequência pergunta — tudo isso é
// aritmética sobre o que ela já escreveu, e responde igual daqui a um ano. O modelo entra
// depois, para LER as amostras que este script seleciona, não para calcular.
//
// A saída alimenta sobre-mim-fontes/{nucleo-voz,como-eu-converso}.md e os modos.
//
// Uso: node tools/analisar-voz.mjs [--json /caminho/saida.json]
import { db } from '../src/core/db.mjs'

const arg = (nome) => { const i = process.argv.indexOf(nome); return i > 0 ? process.argv[i + 1] : null }

// ---------------------------------------------------------------- o que é "dela"
// direction='outgoing' no canal WhatsApp = saiu do aparelho dela. Neste sistema a IA ainda
// nunca escreveu (author='ia' é zero), então todo outgoing é ela de verdade. A checagem fica
// explícita porque no dia em que a IA começar a responder, misturar as duas envenena a medida.
const DELA = `direction='outgoing' AND (author IS NULL OR author<>'ia')`

const linhas = db().prepare(`
  SELECT person_id, text, ts, direction, author FROM message
  WHERE channel='whatsapp' AND text IS NOT NULL AND length(trim(text))>0
  ORDER BY ts
`).all()

const minhas = linhas.filter((m) => m.direction === 'outgoing' && m.author !== 'ia')
const delas = linhas.filter((m) => m.direction === 'incoming')

// ---------------------------------------------------------------- classificação da conversa
// Romântico/íntimo não é uma palavra: é a soma de sinais no que OS DOIS escrevem. Uma
// conversa de trabalho pode ter um "amor" solto; uma conversa íntima tem densidade.
const AFETO = /\b(amor|amo|te amo|saudade|sdd|beijo|bj|bjs|carinho|lindo|linda|gato|gata|gostoso|gostosa|bb|bebê|neném|mor|vida|meu bem|paixão|apaixonad|namorad|crush|amorzinho|princesa|gatinho|gatinha)\b/i
const QUENTE = /\b(tesão|tesao|gozar|gozei|pelad|nud|buceta|pau|pica|rola|foder|fode|fuder|transar|transa|trepar|chupar|chupa|gemido|gemer|punheta|siririca|sexo|sexy|safad|puta vontade|te quero|quero você|quero vc|delícia|delicia|molhad|duro|meter|meti|cavalgar|boquete|oral|preliminar|fantasia sexual|camisinha|sexting)\b/i
const ENCONTRO = /\b(encontr|sair|marcar|te ver|nos ver|rolê|role|cinema|jantar|almoç|motel|dormir junto|passar a noite|vem aqui|vou aí|te busco|te pego)\b/i

const porPessoa = new Map()
for (const m of linhas) {
  if (!porPessoa.has(m.person_id)) porPessoa.set(m.person_id, { minhas: [], delas: [], afeto: 0, quente: 0, encontro: 0 })
  const p = porPessoa.get(m.person_id)
  if (m.direction === 'outgoing' && m.author !== 'ia') p.minhas.push(m); else if (m.direction === 'incoming') p.delas.push(m)
  if (AFETO.test(m.text)) p.afeto++
  if (QUENTE.test(m.text)) p.quente++
  if (ENCONTRO.test(m.text)) p.encontro++
}

const conversas = [...porPessoa.entries()].map(([id, p]) => {
  const total = p.minhas.length + p.delas.length
  return {
    id, total, minhas: p.minhas.length, delas: p.delas.length,
    afeto: p.afeto, quente: p.quente, encontro: p.encontro,
    densidadeAfeto: total ? p.afeto / total : 0,
    densidadeQuente: total ? p.quente / total : 0,
  }
}).filter((c) => c.total >= 10)

// Íntima = tem afeto E troca de verdade dos dois lados. Quente = tem conteúdo explícito.
const intimas = conversas.filter((c) => c.afeto >= 5 && c.densidadeAfeto > 0.01 && c.minhas >= 15 && c.delas >= 15)
const quentes = conversas.filter((c) => c.quente >= 5)
const idsIntimas = new Set(intimas.map((c) => c.id))
const idsQuentes = new Set(quentes.map((c) => c.id))

// ---------------------------------------------------------------- as medidas
const RISADA = /\b(k{2,}|rs{1,}|haha+|hehe+|kkk+)\b|😂|🤣/i
const EMOJI = /\p{Extended_Pictographic}/gu
const ABREV = /\b(vc|vcs|pq|tb|tbm|mt|mto|td|tdb|oq|blz|flw|vlw|msm|tlgd|sla|ngm|dps|hj|amanha|qnd|qria|tava|to|ta)\b/gi

function medir(msgs, rotulo) {
  if (!msgs.length) return { rotulo, n: 0 }
  const palavras = msgs.map((m) => m.text.trim().split(/\s+/).length).sort((a, b) => a - b)
  const mediana = palavras[Math.floor(palavras.length / 2)]
  const conta = (re) => msgs.filter((m) => re.test(m.text)).length
  const pct = (n) => +(100 * n / msgs.length).toFixed(1)

  const emojis = new Map()
  for (const m of msgs) for (const e of (m.text.match(EMOJI) || [])) emojis.set(e, (emojis.get(e) || 0) + 1)
  const topEmoji = [...emojis.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)

  const abrevs = new Map()
  for (const m of msgs) for (const a of (m.text.match(ABREV) || [])) { const k = a.toLowerCase(); abrevs.set(k, (abrevs.get(k) || 0) + 1) }
  const topAbrev = [...abrevs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)

  const vocativos = new Map()
  const VOC = /\b(amor|mor|bb|bebê|nenem|neném|gato|gata|lindo|linda|gostoso|gostosa|meu bem|vida|princesa|amigo|amiga|mano|cara|véi|fi|migo|miga)\b/gi
  for (const m of msgs) for (const v of (m.text.match(VOC) || [])) { const k = v.toLowerCase(); vocativos.set(k, (vocativos.get(k) || 0) + 1) }
  const topVoc = [...vocativos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)

  return {
    rotulo,
    n: msgs.length,
    palavrasMediana: mediana,
    palavrasMedia: +(palavras.reduce((a, b) => a + b, 0) / palavras.length).toFixed(1),
    curtas1a3: pct(palavras.filter((p) => p <= 3).length),
    longas15mais: pct(palavras.filter((p) => p >= 15).length),
    risadaPct: pct(conta(RISADA)),
    perguntaPct: pct(conta(/\?/)),
    exclamacaoPct: pct(conta(/!/)),
    pontoFinalPct: pct(msgs.filter((m) => /[a-zA-ZÀ-ÿ]\.$/.test(m.text.trim())).length),
    maiusculaInicioPct: pct(msgs.filter((m) => /^[A-ZÀ-Ý]/.test(m.text.trim())).length),
    comEmojiPct: pct(conta(EMOJI)),
    tuPct: pct(conta(/\btu\b/i)),
    vcPct: pct(conta(/\b(vc|você|voce)\b/i)),
    topEmoji, topAbrev, topVoc,
  }
}

// ---------------------------------------------------------------- ritmo e comportamento
function ritmo(msgs, todas) {
  // rajada = mensagens dela seguidas, sem resposta no meio, dentro de 90s
  let rajadas = 0, emRajada = 0, maiorRajada = 0, atual = 0
  const ordenadas = [...todas].sort((a, b) => a.ts - b.ts)
  for (let i = 0; i < ordenadas.length; i++) {
    const m = ordenadas[i], ant = ordenadas[i - 1]
    const minha = m.direction === 'outgoing' && m.author !== 'ia'
    if (minha && ant && ant.direction === 'outgoing' && m.ts - ant.ts < 90_000) { atual++; emRajada++ }
    else { if (atual > 0) { rajadas++; maiorRajada = Math.max(maiorRajada, atual + 1) } atual = 0 }
  }
  // tempo de resposta: primeira dela depois de uma incoming
  const gaps = []
  for (let i = 1; i < ordenadas.length; i++) {
    const m = ordenadas[i], ant = ordenadas[i - 1]
    if (m.direction === 'outgoing' && ant.direction === 'incoming') gaps.push(m.ts - ant.ts)
  }
  gaps.sort((a, b) => a - b)
  const hora = new Map()
  for (const m of msgs) { const h = new Date(m.ts - 3 * 3600_000).getUTCHours(); hora.set(h, (hora.get(h) || 0) + 1) }
  return {
    rajadas, bolhasEmRajadaPct: msgs.length ? +(100 * emRajada / msgs.length).toFixed(1) : 0, maiorRajada,
    respostaMedianaMin: gaps.length ? +(gaps[Math.floor(gaps.length / 2)] / 60000).toFixed(1) : null,
    respostaRapida2minPct: gaps.length ? +(100 * gaps.filter((g) => g < 120_000).length / gaps.length).toFixed(1) : 0,
    porHora: [...hora.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
  }
}

const geral = medir(minhas, 'TODAS as mensagens dela')
const intimasMsgs = minhas.filter((m) => idsIntimas.has(m.person_id))
const quentesMsgs = minhas.filter((m) => idsQuentes.has(m.person_id))
const restoMsgs = minhas.filter((m) => !idsIntimas.has(m.person_id) && !idsQuentes.has(m.person_id))

const saida = {
  universo: {
    mensagensNoBanco: linhas.length,
    dela: minhas.length,
    dosOutros: delas.length,
    conversasComMais10: conversas.length,
    conversasIntimas: intimas.length,
    conversasComConteudoQuente: quentes.length,
    periodo: [new Date(linhas[0].ts).toISOString().slice(0, 10), new Date(linhas.at(-1).ts).toISOString().slice(0, 10)],
  },
  vozGeral: geral,
  vozIntima: medir(intimasMsgs, 'nas conversas ÍNTIMAS'),
  vozQuente: medir(quentesMsgs, 'nas conversas com conteúdo EXPLÍCITO'),
  vozResto: medir(restoMsgs, 'no resto (amizade/trabalho/família)'),
  ritmoGeral: ritmo(minhas, linhas),
  ritmoIntimo: ritmo(intimasMsgs, linhas.filter((m) => idsIntimas.has(m.person_id))),
  topConversasIntimas: intimas.sort((a, b) => b.total - a.total).slice(0, 12)
    .map((c) => ({ total: c.total, dela: c.minhas, afeto: c.afeto, quente: c.quente, encontro: c.encontro })),
}

const destino = arg('--json')
if (destino) {
  const fs = await import('node:fs')
  fs.writeFileSync(destino, JSON.stringify(saida, null, 2))
  console.log('escrito em ' + destino)
}
console.log(JSON.stringify(saida, null, 2))
