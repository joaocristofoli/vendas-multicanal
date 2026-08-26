// Métricas objetivas de voz. São as mesmas grandezas da análise de 24/07/2026 (docs/
// VOZ-ANALISE-2026-07-24.md), medidas do mesmo jeito antes e depois de qualquer mudança.
// A comparação do golden set é ESTATÍSTICA: geração é estocástica, então o que se compara
// é a distribuição destas métricas, nunca o texto literal.

const EMOJI = /\p{Extended_Pictographic}/gu
const RISADA = /\b(k{2,}|rs{2,}|haha+|ka+ka+)\b/giu

export function metricas(texto, { pessoa = '' } = {}) {
  const t = String(texto || '')
  const bolhas = t.split(/\n+/).map((l) => l.trim()).filter(Boolean)
  const palavras = t.split(/\s+/).filter(Boolean).length
  const risadas = t.match(RISADA) || []
  const emojis = t.match(EMOJI) || []
  // "no fim" = a risada fecha a bolha (jeito real dele) em vez de aparecer no meio da frase
  const risadaNoFim = bolhas.some((b) => RISADA.test(b.replace(/[\s.,!?]+$/, '').slice(-8)))
  const primeiroNome = String(pessoa || '').trim().split(/\s+/)[0] || ''
  return {
    palavras,
    bolhas: bolhas.length,
    palavrasPorBolha: bolhas.length ? Number((palavras / bolhas.length).toFixed(1)) : 0,
    temRisada: risadas.length > 0,
    risadas: risadas.length,
    risadaNoFim,
    temPergunta: /\?/.test(t),
    perguntas: (t.match(/\?/g) || []).length,
    emojis: emojis.length,
    emojiUsados: [...new Set(emojis)],
    // As três regras absolutas de escrita: qualquer valor > 0 aqui é violação dura.
    violaPontoFinal: bolhas.filter((b) => /\.$/.test(b) && !/\.\.\.$/.test(b)).length,
    violaExclamacao: (t.match(/!/g) || []).length,
    violaTravessao: (t.match(/[—–]/g) || []).length,
    violaNome: primeiroNome.length >= 3 && new RegExp(`\\b${primeiroNome}\\b`, 'i').test(t) ? 1 : 0,
    usaVc: (t.match(/\bvc\b/gi) || []).length,
    usaVoceExtenso: (t.match(/\bvocê\b/gi) || []).length,
    usaTu: (t.match(/\btu\b/gi) || []).length,
  }
}

// Agrega as métricas de várias gerações do mesmo cenário (ou do conjunto todo).
export function agregar(lista) {
  if (!lista.length) return null
  const num = (campo) => lista.map((m) => m[campo]).filter((v) => typeof v === 'number')
  const media = (campo) => Number((num(campo).reduce((a, b) => a + b, 0) / lista.length).toFixed(2))
  const taxa = (campo) => Number((lista.filter((m) => m[campo]).length / lista.length).toFixed(2))
  return {
    n: lista.length,
    palavrasMedia: media('palavras'),
    bolhasMedia: media('bolhas'),
    taxaRisada: taxa('temRisada'),
    taxaRisadaNoFim: taxa('risadaNoFim'),
    taxaPergunta: taxa('temPergunta'),
    emojisMedia: media('emojis'),
    violacoes: {
      pontoFinal: num('violaPontoFinal').reduce((a, b) => a + b, 0),
      exclamacao: num('violaExclamacao').reduce((a, b) => a + b, 0),
      travessao: num('violaTravessao').reduce((a, b) => a + b, 0),
      nome: num('violaNome').reduce((a, b) => a + b, 0),
    },
    vc: media('usaVc'),
    voceExtenso: media('usaVoceExtenso'),
    tu: media('usaTu'),
  }
}

// Banda aceitável para dizer "o comportamento não mudou". Os alvos vivos são os do
// como-eu-converso.md §4b/§4e: kkk ~1 a cada 5-6, pergunta ~1 a cada 3-4, 8-15 palavras.
//
// A TOLERÂNCIA DEPENDE DO TAMANHO DA AMOSTRA, e ignorar isso foi um erro real na primeira
// versão (25/07/2026): com 3 gerações por cenário, uma taxa só pode valer 0, 0,33, 0,67 ou 1
// — a resolução é 0,33. Comparar isso contra tolerância de 0,25 REPROVA por definição, mesmo
// sem nada ter mudado: uma única geração diferente já estoura. Foi o que aconteceu (12 de 24
// cenários "fora da banda", com desvios pros dois lados, enquanto o agregado de 72 gerações
// ficou praticamente idêntico). Agora a tolerância de taxa nunca fica abaixo da resolução da
// amostra mais uma margem de ruído binomial.
export function bandaPara(n = 72) {
  const resolucao = 1 / Math.max(1, n)                    // menor diferença representável
  const ruido = Math.sqrt(0.25 / Math.max(1, n))          // erro padrão de proporção (p=0,5)
  const taxa = Math.max(0.2, resolucao + 2 * ruido)
  return {
    palavrasMedia: Math.max(5, 20 / Math.sqrt(n)),
    bolhasMedia: Math.max(0.6, 2 / Math.sqrt(n)),
    taxaRisada: taxa,
    taxaPergunta: taxa,
    emojisMedia: Math.max(0.5, 2 / Math.sqrt(n)),
  }
}

export function dentroDaBanda(base, novo, n = null) {
  const tol = bandaPara(n || novo?.n || 72)
  const problemas = []
  const cmp = (campo, rotulo) => {
    const d = Math.abs((novo[campo] ?? 0) - (base[campo] ?? 0))
    if (d > tol[campo]) problemas.push(`${rotulo}: ${base[campo]} -> ${novo[campo]} (tolerância ${tol[campo].toFixed(2)} para n=${novo?.n ?? n})`)
  }
  cmp('palavrasMedia', 'tamanho médio')
  cmp('bolhasMedia', 'bolhas por resposta')
  cmp('taxaRisada', 'taxa de risada')
  cmp('taxaPergunta', 'taxa de pergunta')
  cmp('emojisMedia', 'emoji por resposta')
  // Regra absoluta não tem banda: qualquer violação a mais reprova, em qualquer amostra.
  for (const k of ['pontoFinal', 'exclamacao', 'travessao', 'nome']) {
    if ((novo.violacoes?.[k] ?? 0) > (base.violacoes?.[k] ?? 0)) {
      problemas.push(`violação de regra absoluta (${k}): ${base.violacoes[k]} -> ${novo.violacoes[k]}`)
    }
  }
  return { ok: problemas.length === 0, problemas }
}
