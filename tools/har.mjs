#!/usr/bin/env node
// `node tools/har.mjs <arquivo.har> [--host badoo.com] [--corpo] [--json]`
//
// Lê um HAR e devolve o MAPA da API privada que está ali dentro: quais hosts, quais
// endpoints, o que autentica, o formato do envelope e onde estão os dados.
//
// Existe porque eu fiz isso À MÃO pro Badoo (docs/ENTENDIMENTO-BADOO.md) e levou horas: ler
// centenas de requisições, achar o endpoint único, descobrir que o corpo era um envelope
// numerado, decodificar base64, entender que o `x-pingback` era assinatura. É trabalho
// mecânico — e trabalho mecânico feito por modelo é caro, lento e diferente a cada vez.
// Aqui vira função: mesmo HAR, mesma resposta, de graça, pra sempre.
//
// O que ele procura, em ordem de utilidade:
//   1. ENDPOINT QUENTE — o que repete muito com corpos diferentes costuma ser o RPC central.
//   2. AUTENTICAÇÃO — quais cabeçalhos/cookies aparecem em TODAS as chamadas do host (o que
//      é constante autentica; o que muda por chamada é assinatura, e assinatura não se forja).
//   3. ASSINATURA POR PEDIDO — cabeçalho que muda a cada chamada. É a diferença entre "dá
//      pra fazer um cliente HTTP" e "só dá pelo navegador". Foi o que matou o cliente do Badoo.
//   4. FORMA DA RESPOSTA — as chaves de topo, pra saber onde os dados moram.
import fs from 'node:fs'

const arqv = process.argv.slice(2)
const arquivo = arqv.find((a) => !a.startsWith('--'))
const opt = (n) => arqv.includes('--' + n)
const valor = (n) => { const i = arqv.indexOf('--' + n); return i >= 0 ? arqv[i + 1] : null }

if (!arquivo) {
  console.error('uso: node tools/har.mjs <arquivo.har> [--host <dominio>] [--corpo] [--json]')
  process.exit(1)
}

let har
try { har = JSON.parse(fs.readFileSync(arquivo, 'utf8')) }
catch (e) { console.error('não consegui ler o HAR:', e.message); process.exit(1) }

const entradas = har?.log?.entries || []
if (!entradas.length) {
  console.error(`o HAR tem 0 requisições. Quase sempre é um destes dois: (a) havia FILTRO ativo no DevTools na hora de exportar — o botão mostra "0 / N requests"; (b) a aba foi aberta depois da navegação. Exporte de novo com o filtro limpo.`)
  process.exit(2)
}

const hostFiltro = valor('host')
const ruido = /\.(png|jpe?g|gif|webp|svg|ico|css|woff2?|ttf|mp4|m4s|js)(\?|$)/i
const seRuido = (u) => ruido.test(u) || /google-analytics|googletagmanager|doubleclick|facebook\.com\/tr|sentry|hotjar|clarity\.ms/i.test(u)

const porHost = new Map()
for (const e of entradas) {
  let u
  try { u = new URL(e.request.url) } catch { continue }
  if (hostFiltro && !u.host.includes(hostFiltro)) continue
  if (seRuido(e.request.url)) continue
  if (!porHost.has(u.host)) porHost.set(u.host, [])
  porHost.get(u.host).push({ e, u })
}

// Cabeçalho que é IGUAL em todas as chamadas -> credencial. Cabeçalho que MUDA a cada
// chamada -> assinatura/nonce. A distinção é a informação mais valiosa do HAR inteiro.
function classificarCabecalhos(itens) {
  const vistos = new Map()
  for (const { e } of itens) {
    for (const h of e.request.headers || []) {
      const k = h.name.toLowerCase()
      if (/^(:|accept|accept-encoding|accept-language|connection|content-length|host|user-agent|sec-|origin|referer|cache-control|pragma|priority|te$|dnt)/.test(k)) continue
      if (!vistos.has(k)) vistos.set(k, new Set())
      vistos.get(k).add(h.value)
    }
  }
  const constantes = [], variaveis = []
  for (const [k, vals] of vistos) {
    const n = vals.size
    const amostra = [...vals][0] || ''
    const curto = amostra.length > 60 ? amostra.slice(0, 57) + '…' : amostra
    if (n === 1) constantes.push({ nome: k, valor: curto })
    else variaveis.push({ nome: k, formasDiferentes: n, deQuantas: itens.length, amostra: curto })
  }
  return { constantes, variaveis }
}

function chavesDoJson(txt, prof = 0) {
  try {
    const j = JSON.parse(txt)
    if (Array.isArray(j)) return ['[array de ' + j.length + ']']
    if (j && typeof j === 'object') {
      return Object.keys(j).slice(0, 12).map((k) => {
        const v = j[k]
        if (Array.isArray(v)) return `${k}[${v.length}]`
        if (v && typeof v === 'object' && prof < 1) return `${k}{${Object.keys(v).slice(0, 5).join(',')}}`
        return k
      })
    }
  } catch { /* não é json */ }
  return null
}

const relatorio = []
for (const [host, itens] of [...porHost.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const { constantes, variaveis } = classificarCabecalhos(itens)

  // agrupa por caminho + query "de comando" (o Badoo põe o nome do comando na query sem valor)
  const porRota = new Map()
  for (const { e, u } of itens) {
    const comando = [...u.searchParams.keys()].find((k) => !u.searchParams.get(k)) || null
    const chave = `${e.request.method} ${u.pathname}${comando ? '?' + comando : ''}`
    if (!porRota.has(chave)) porRota.set(chave, [])
    porRota.get(chave).push(e)
  }

  const rotas = [...porRota.entries()].sort((a, b) => b[1].length - a[1].length).map(([rota, es]) => {
    const e0 = es[0]
    const corpoEnv = e0.request.postData?.text || null
    const resp = e0.response?.content
    let txt = resp?.text || ''
    if (resp?.encoding === 'base64') { try { txt = Buffer.from(txt, 'base64').toString('utf8') } catch { /* binário */ } }
    return {
      rota, chamadas: es.length,
      status: [...new Set(es.map((x) => x.response?.status))].join(','),
      tipo: resp?.mimeType || null,
      enviaChaves: corpoEnv ? chavesDoJson(corpoEnv) : null,
      recebeChaves: chavesDoJson(txt),
      ...(opt('corpo') ? { corpoExemplo: (corpoEnv || '').slice(0, 600), respostaExemplo: txt.slice(0, 600) } : {}),
    }
  })

  relatorio.push({
    host, chamadas: itens.length,
    autenticacao: constantes.length ? constantes : '(nada constante: talvez a sessão seja por cookie do domínio)',
    assinaturaPorPedido: variaveis.length
      ? variaveis.map((v) => ({ ...v, aviso: v.formasDiferentes >= v.deQuantas * 0.8
        ? 'MUDA quase toda chamada: quase certamente é assinatura/nonce do corpo. Um cliente HTTP NÃO vai conseguir montar pedidos novos — só repetir os capturados. Nesse caso o caminho é rodar dentro do navegador e ESCUTAR as respostas do app deles.'
        : 'muda às vezes: pode ser id de sessão rotativo ou paginação' }))
      : '(nenhum cabeçalho variável: bom sinal, dá pra fazer cliente HTTP)',
    rotas: rotas.slice(0, 20),
    rotaMaisQuente: rotas[0]?.rota || null,
  })
}

if (opt('json')) { console.log(JSON.stringify({ arquivo, hosts: relatorio }, null, 1)); process.exit(0) }

console.log(`HAR: ${arquivo}`)
console.log(`${entradas.length} requisições no total; ${[...porHost.values()].reduce((a, b) => a + b.length, 0)} depois de tirar imagem/css/js e rastreadores\n`)
for (const h of relatorio) {
  console.log(`=== ${h.host}  (${h.chamadas} chamadas) ===`)
  console.log('  AUTENTICA (igual em toda chamada):')
  if (typeof h.autenticacao === 'string') console.log('    ' + h.autenticacao)
  else for (const c of h.autenticacao) console.log(`    ${c.nome}: ${c.valor}`)
  console.log('  ASSINATURA (muda entre chamadas):')
  if (typeof h.assinaturaPorPedido === 'string') console.log('    ' + h.assinaturaPorPedido)
  else for (const v of h.assinaturaPorPedido) { console.log(`    ${v.nome}  (${v.formasDiferentes} valores em ${v.deQuantas} chamadas)`); console.log(`      -> ${v.aviso}`) }
  console.log('  ROTAS (mais usadas primeiro):')
  for (const r of h.rotas) {
    console.log(`    ${String(r.chamadas).padStart(4)}x  ${r.rota}   [${r.status}]`)
    if (r.enviaChaves) console.log(`           envia:  ${r.enviaChaves.join(', ')}`)
    if (r.recebeChaves) console.log(`           recebe: ${r.recebeChaves.join(', ')}`)
    if (opt('corpo') && r.corpoExemplo) console.log(`           corpo:  ${r.corpoExemplo.replace(/\n/g, ' ').slice(0, 300)}`)
    if (opt('corpo') && r.respostaExemplo) console.log(`           resp:   ${r.respostaExemplo.replace(/\n/g, ' ').slice(0, 300)}`)
  }
  console.log()
}
process.exit(0)
