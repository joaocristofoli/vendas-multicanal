// Núcleo do número brasileiro — funções PURAS, sem rede, sem banco, sem baileys.
// É aqui que mora a regra que mais deu problema no vendas-multicanal: o 9º dígito, o DDD e o que é
// telefone de verdade dentro de uma frase escrita por gente ("meu zap é 11 99999-0001",
// "chama lá 11 9 9999 0002", "45999999999" que é só ela batendo na tecla).
//
// Princípio (docs/PLANO-IDENTIDADE-VINCULO.md §2.1): NUNCA chutar. Este módulo só produz
// HIPÓTESES; quem decide qual existe é o servidor do WhatsApp (onWhatsApp) e o lidMapping.
// Por isso ele é generoso pra achar candidatos e severo pra descartar lixo — falso negativo
// custa um vínculo a menos; falso positivo faz a IA falar com a pessoa errada.
//
// Diferenças pro antigo src/wa/jid.mjs (que continua existindo e passa a delegar):
//  - valida o DDD contra a lista real (67 códigos). O antigo aceitava qualquer par de
//    dígitos, então CPF, CEP, data e valor viravam "telefone".
//  - distingue CELULAR de FIXO. O antigo inventava um 9º dígito em número fixo.
//  - extrai TODOS os candidatos de um texto, um por vez, sem concatenar mensagens (o antigo
//    juntava a conversa inteira num texto só e podia casar atravessando duas mensagens).

const WA_USER_DOMAIN = 's.whatsapp.net'

// Os 67 DDDs que existem no Brasil. O que não está aqui não é telefone brasileiro —
// esta única verificação derruba a maior parte dos falsos positivos.
export const DDDS_VALIDOS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,                 // SP
  21, 22, 24, 27, 28,                                 // RJ, ES
  31, 32, 33, 34, 35, 37, 38,                         // MG
  41, 42, 43, 44, 45, 46, 47, 48, 49,                 // PR, SC
  51, 53, 54, 55,                                     // RS
  61, 62, 63, 64, 65, 66, 67, 68, 69,                 // DF, GO, TO, MT, MS, AC, RO
  71, 73, 74, 75, 77, 79,                             // BA, SE
  81, 82, 83, 84, 85, 86, 87, 88, 89,                 // PE, AL, PB, RN, CE, PI
  91, 92, 93, 94, 95, 96, 97, 98, 99,                 // PA, AM, RR, AP, MA
])

export function onlyDigits(raw) {
  return String(raw == null ? '' : raw).replace(/\D+/g, '')
}

// Sequência que ninguém tem de telefone: dígito repetido (99999999999) ou uma corrida
// crescente/decrescente longa (12345678, 987654321). Gente escreve isso quando está
// brincando, testando ou preenchendo campo por preencher. Seis dígitos em fila é o corte:
// número de verdade quase nunca tem corrida tão longa (o maior que vi em base real tem 2).
function ehSequenciaBoba(digits) {
  if (/^(\d)\1+$/.test(digits)) return true
  let corrida = 1, maior = 1, direcao = 0
  for (let i = 1; i < digits.length; i++) {
    const passo = Number(digits[i]) - Number(digits[i - 1])
    if (passo === direcao && (passo === 1 || passo === -1)) corrida++
    else { direcao = (passo === 1 || passo === -1) ? passo : 0; corrida = direcao ? 2 : 1 }
    if (corrida > maior) maior = corrida
  }
  return maior >= 6
}

// Analisa um número cru e diz o que ele é. Nunca lança — devolve { ok:false, motivo }
// pra quem chama poder logar por que descartou (o motivo entra no diário e na revisão).
//
// Retorno quando ok:
//   { ok:true, nacional, ddd, assinante, tipo:'celular'|'fixo', e164 }
// `nacional` = 10 ou 11 dígitos (sem o 55). `e164` = '55' + nacional.
export function parseBrazilianPhone(raw) {
  let digits = onlyDigits(raw)
  if (!digits) return { ok: false, motivo: 'vazio' }

  // Tira o 0 de operadora na frente (0 45 ..., 021 45 ...) antes de qualquer coisa.
  const tinhaZero = digits[0] === '0'
  digits = digits.replace(/^0+/, '')
  // Tira o DDI 55 quando o número claramente já o inclui (12 ou 13 dígitos com 55 na frente).
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) digits = digits.slice(2)
  // Código de operadora (o "21" de 0 21 11 99999-0001): só considera quando o número veio
  // com 0 na frente E sobrou comprimento demais — é a assinatura da seleção de operadora.
  else if (tinhaZero && (digits.length === 12 || digits.length === 13) && DDDS_VALIDOS.has(Number(digits.slice(2, 4)))) digits = digits.slice(2)

  if (digits.length < 10) return { ok: false, motivo: `curto demais (${digits.length} dígitos)` }
  if (digits.length > 11) return { ok: false, motivo: `longo demais (${digits.length} dígitos)` }

  const ddd = Number(digits.slice(0, 2))
  if (!DDDS_VALIDOS.has(ddd)) return { ok: false, motivo: `DDD ${digits.slice(0, 2)} não existe` }

  const assinante = digits.slice(2)
  if (ehSequenciaBoba(assinante)) return { ok: false, motivo: 'sequência de dígitos improvável' }

  if (assinante.length === 9) {
    // Celular moderno: 9 dígitos e o primeiro é obrigatoriamente 9. Se não for, não é
    // telefone — é outro número de 11 dígitos que caiu aqui por acaso (CPF, por exemplo).
    if (assinante[0] !== '9') return { ok: false, motivo: 'celular de 9 dígitos tem que começar com 9' }
    return { ok: true, nacional: digits, ddd, assinante, tipo: 'celular', e164: '55' + digits }
  }
  // 8 dígitos: 6-9 = celular no formato antigo (é assim que o WhatsApp guarda muita conta
  // brasileira até hoje); 2-5 = fixo. Fixo nunca ganha 9º dígito.
  const primeiro = assinante[0]
  if (primeiro >= '6') return { ok: true, nacional: digits, ddd, assinante, tipo: 'celular', e164: '55' + digits }
  if (primeiro >= '2') return { ok: true, nacional: digits, ddd, assinante, tipo: 'fixo', e164: '55' + digits }
  return { ok: false, motivo: `assinante começando com ${primeiro} não existe` }
}

// Gera os JIDs candidatos pra consultar no onWhatsApp. Ordem estável: a forma que a pessoa
// escreveu primeiro, depois a variante. CELULAR tem duas formas possíveis (com e sem o 9);
// FIXO tem uma só. Devolve [] quando o número não passa no parse.
export function phoneCandidates(raw) {
  const p = parseBrazilianPhone(raw)
  if (!p.ok) return []
  const jids = [`55${p.nacional}@${WA_USER_DOMAIN}`]
  if (p.tipo === 'celular') {
    if (p.assinante.length === 9) {
      // com 9 -> acrescenta a variante SEM o 9 (contas antigas vivem nesse formato)
      jids.push(`55${p.nacional.slice(0, 2)}${p.assinante.slice(1)}@${WA_USER_DOMAIN}`)
    } else {
      // sem 9 -> acrescenta a variante COM o 9
      jids.push(`55${p.nacional.slice(0, 2)}9${p.assinante}@${WA_USER_DOMAIN}`)
    }
  }
  return jids
}

// As duas formas do MESMO número (com e sem 9), em dígitos E.164, pra casar identidades
// que o WhatsApp guardou num formato e a pessoa mandou no outro.
export function phoneVariants(raw) {
  return phoneCandidates(raw).map((j) => j.slice(0, j.indexOf('@')))
}

// Máscaras que parecem telefone mas não são. Rodam sobre o TRECHO ORIGINAL (com pontuação),
// porque é a pontuação que denuncia: 000.000.000-00 é CPF, 00000-000 é CEP, 00/00/0000 é data.
const MASCARA_CPF = /\d{3}\.\d{3}\.\d{3}-?\d{0,2}/
const MASCARA_CNPJ = /\d{2}\.\d{3}\.\d{3}\/\d{4}-?\d{0,2}/
const MASCARA_CEP = /\b\d{5}-\d{3}\b/
const TEM_BARRA = /\d\s*\/\s*\d/          // data (12/05/2026) ou fração
const TEM_MOEDA = /(r\$|reais)\s*[\d.,]*$/i

// Trecho de texto que PODE ser um telefone: grupos de dígitos separados por no máximo dois
// caracteres de pontuação/espaço. O limite de dois é o que impede o número de "vazar" pra
// outra frase e casar atravessando o que era uma mensagem separada.
const TRECHO_TELEFONE = /(?:\+?\s?55[\s.\-()]{0,2})?(?:\(\s?\d{2}\s?\)|\b\d{2})[\s.\-()]{0,2}\d(?:[\s.\-()]{0,2}\d){7,9}/g

// Números que aparecem em link (wa.me/5545..., api.whatsapp.com/send?phone=55...).
const LINK_WA = /(?:wa\.me|api\.whatsapp\.com\/send\?phone=|whatsapp\.com\/send\?phone=)\/?\+?(\d{10,15})/gi

// Extrai TODOS os telefones plausíveis de UM texto (uma mensagem — nunca passe a conversa
// concatenada; era assim que o extrator antigo casava atravessando duas mensagens).
// Devolve [{ bruto, nacional, e164, ddd, tipo, origem:'texto'|'link' }], sem repetidos.
// `ignorar` = lista de números (qualquer formato) que nunca devem virar candidato — use pro
// número do próprio o dono, senão ele vira "contato" de todo mundo que o repassa.
export function extractPhones(text, { ignorar = [] } = {}) {
  const bruto = String(text == null ? '' : text)
  if (!bruto) return []
  const negados = new Set()
  for (const i of ignorar) { for (const v of phoneVariants(i)) negados.add(v) }

  const achados = []
  const vistos = new Set()
  const empurra = (trecho, digitos, origem) => {
    const p = parseBrazilianPhone(digitos)
    if (!p.ok) return
    if (negados.has(p.e164)) return
    if (vistos.has(p.e164)) return
    vistos.add(p.e164)
    achados.push({ bruto: trecho.trim(), nacional: p.nacional, e164: p.e164, ddd: p.ddd, tipo: p.tipo, origem })
  }

  // 1) Links: o número vem limpo e sem ambiguidade, então entram primeiro e sem filtro de
  //    máscara. O trecho consumido fica marcado pra a varredura de texto não reler os mesmos
  //    dígitos numa janela deslocada (era assim que um wa.me virava dois "telefones").
  const consumidos = []
  for (const m of bruto.matchAll(LINK_WA)) {
    consumidos.push([m.index, m.index + m[0].length])
    empurra(m[0], m[1], 'link')
  }

  // 2) Texto corrido. Cada trecho passa pelos filtros de máscara antes de virar candidato.
  //    O contexto ao redor entra na checagem de moeda ("R$ 1.250,00" vira dígitos senão).
  for (const m of bruto.matchAll(TRECHO_TELEFONE)) {
    const trecho = m[0]
    const ini = m.index, fim = m.index + trecho.length
    if (consumidos.some(([a, b]) => ini < b && fim > a)) continue
    // Não pode começar nem terminar no MEIO de uma sequência de dígitos: se tem dígito
    // colado antes ou depois, o que casou é um pedaço recortado de outro número.
    if (/\d/.test(bruto[ini - 1] || '') || /\d/.test(bruto[fim] || '')) continue
    const antes = bruto.slice(Math.max(0, ini - 12), ini)
    if (MASCARA_CPF.test(trecho) || MASCARA_CNPJ.test(trecho)) continue
    if (MASCARA_CEP.test(trecho)) continue
    if (TEM_BARRA.test(trecho)) continue
    if (TEM_MOEDA.test(antes)) continue
    empurra(trecho, onlyDigits(trecho), 'texto')
  }
  return achados
}

// Sequências que PARECEM telefone e o parse recusou. Existem porque ninguém padroniza como
// escreve o próprio número: "0986734658" (zero na frente e sem DDD), "98673-4658" (só o
// assinante), "45 9 8673 4658". O extrator antigo simplesmente descartava — em silêncio, sem
// hint, sem diário, sem nada. Uma menina passou o WhatsApp no Tinder em 26/07/2026 e sumiu
// assim; o dono percebeu e o sistema não. O que não dá pra ler tem que ficar VISÍVEL.
//
// Devolve [{ bruto, digitos, motivo, assinante? }]. `assinante` vem preenchido quando o que
// sobrou é um número de assinante sem DDD (8 ou 9 dígitos) — é o caso recuperável: basta
// perguntar ao servidor do WhatsApp em quais DDDs ele existe.
export function numerosIncertos(text, { ignorar = [] } = {}) {
  const bruto = String(text == null ? '' : text)
  if (!bruto) return []
  const jaValidos = new Set(extractPhones(bruto, { ignorar }).map((p) => p.bruto))
  const out = []
  const vistos = new Set()
  // qualquer corrida de 8+ dígitos com pontuação leve no meio (mais larga que TRECHO_TELEFONE,
  // que exige começar com algo com cara de DDD)
  const CORRIDA = /\+?\d(?:[\s.\-()]{0,2}\d){7,14}/g
  for (const m of bruto.matchAll(CORRIDA)) {
    const trecho = m[0]
    if (jaValidos.has(trecho.trim())) continue
    const ini = m.index, fim = m.index + trecho.length
    if (/\d/.test(bruto[ini - 1] || '') || /\d/.test(bruto[fim] || '')) continue
    if (MASCARA_CPF.test(trecho) || MASCARA_CNPJ.test(trecho) || MASCARA_CEP.test(trecho)) continue
    if (TEM_BARRA.test(trecho)) continue
    if (TEM_MOEDA.test(bruto.slice(Math.max(0, ini - 12), ini))) continue
    const digitos = onlyDigits(trecho)
    const p = parseBrazilianPhone(digitos)
    if (p.ok) continue                       // esse o extrator normal já pegou
    if (vistos.has(digitos)) continue
    vistos.add(digitos)
    // o que sobra depois de tirar zeros de operadora e o DDI é o assinante, quando tem 8 ou 9
    let resto = digitos.replace(/^0+/, '')
    if ((resto.length === 12 || resto.length === 13) && resto.startsWith('55')) resto = resto.slice(2)
    const assinante = (resto.length === 9 && resto[0] === '9') || (resto.length === 8 && resto[0] >= '6') ? resto : null
    // Fora da faixa de um telefone brasileiro escrito por gente (8 a 13 dígitos) não é
    // número mal escrito: é id, código, protocolo. Um id cru do WhatsApp tem 14+ e caía
    // aqui como "ilegível" — ruído puro na fila de revisão (pego pela suíte, 26/07/2026).
    if (!assinante && (digitos.length < 10 || digitos.length > 13)) continue
    out.push({ bruto: trecho.trim(), digitos, motivo: p.motivo, assinante })
  }
  return out
}

// Um assinante sem DDD (98673-4658) vira números completos testáveis, um por DDD plausível.
// NÃO adivinha sozinho: só monta as hipóteses pra o servidor do WhatsApp responder quais
// existem — e mesmo assim o vínculo continua sendo decisão do dono, porque o DDD foi nosso.
export function completarComDDD(assinante, ddds = []) {
  const a = onlyDigits(assinante)
  if (!(a.length === 8 || a.length === 9)) return []
  const out = []
  for (const d of ddds) {
    const dd = onlyDigits(d).slice(-2)
    if (!DDDS_VALIDOS.has(Number(dd))) continue
    const p = parseBrazilianPhone(dd + a)
    if (p.ok && !out.includes(p.nacional)) out.push(p.nacional)
  }
  return out
}

// Formata pra exibição: 5511999990001 -> (11) 99999-0001. Restaura o 9º dígito quando o
// número está no formato antigo de 8 dígitos, só pra LER (nunca pra decidir vínculo).
//
// Aceita JID inteiro, e é por isso que o sufixo de DISPOSITIVO sai antes de tudo: o
// WhatsApp guarda '551199990010:0@s.whatsapp.net' e o ':0' vira mais um dígito no
// onlyDigits. Sem tirar, '551199990010' (12) virava '5511999990010' (13) e o número saía
// deslocado uma casa — (11) 99999-0099 em vez de (11) 99999-0010. Aconteceu na primeira
// resposta real sobre um contato (26/07/2026).
export function prettyPhone(raw) {
  let d = onlyDigits(String(raw == null ? '' : raw).replace(/:\d+(?=@|$)/, ''))
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2)
  if (d.length === 10 && d[2] >= '6') d = d.slice(0, 2) + '9' + d.slice(2)
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return String(raw || '')
}
