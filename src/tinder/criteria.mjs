// Motor de critérios do auto-deslizar. Três camadas, da mais barata pra mais cara:
//   1. regras duras   — campos estruturados, decisão instantânea, sem IA
//   2. texto/símbolo  — listas de bloqueio e de bônus (bio, nome, gênero custom, prompts)
//   3. pontuação      — sinais de qualidade; a faixa do meio é "fronteira" (opcional: IA)
//
// Toda decisão sai com MOTIVO legível — é o que o painel mostra e o que permite auditar.
// Contrato: docs/TINDER-DESCOBERTA.md B.3
import { getSetting } from '../core/db.mjs'

// As listas começam vazias. Cada pessoa decide seus próprios filtros no painel,
// sem herdar preferências íntimas de quem publicou o código.
const SIMBOLOS_PADRAO = []
const TERMOS_PADRAO = []

export const CRITERIOS_PADRAO = {
  idade: { min: 18, max: 99 },
  // O padrão público é inclusivo: idade adulta, sem distância ou atributos
  // obrigatórios. Preferências pessoais podem ser configuradas depois.
  filtrarPorDistancia: false,
  pontuarDistancia: false,
  distanciaMax: 60,          // só vale quando filtrarPorDistancia = true
  distanciaPerto: 40,        // só vale quando pontuarDistancia = true
  fotosMin: 0,
  exigirBio: false,
  exigirVerificada: false,
  exigirAtivaRecente: false,
  intencoesBloqueadas: [],
  regras: {
    // Nome mantido por compatibilidade com configurações antigas; vem desligado e vazio.
    excluirTrans: { ativa: false, simbolos: SIMBOLOS_PADRAO, termos: TERMOS_PADRAO },
  },
  bloqueioTexto: [],         // chips livres editáveis
  bonusTexto: [],
  pontuacao: { curtirAcima: 4, passarAbaixo: 3 },
  taxaLikeAlvo: { min: 0.25, max: 0.40 },
  ruido: 0.05,               // fração das decisões de fronteira que é invertida
}

export function criteriosAtuais() {
  const salvo = getSetting('swipe_criteria', null)
  if (!salvo) return CRITERIOS_PADRAO
  return { ...CRITERIOS_PADRAO, ...salvo, regras: { ...CRITERIOS_PADRAO.regras, ...(salvo.regras || {}) } }
}

const normaliza = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

// Escapa o que o usuário digitou: sem isso, um chip com "(" ou "+" derruba a geração da
// regex e o filtro inteiro para de funcionar em silêncio.
const escapaRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function regexTermos(termos) {
  const alt = termos.map((t) => escapaRegex(normaliza(t)).replace(/\\?-/g, '[- ]?')).join('|')
  return new RegExp('(^|[^\\p{L}\\p{N}])(' + alt + ')([^\\p{L}\\p{N}]|$)', 'u')
}
function regexSimbolos(simbolos) { return new RegExp(simbolos.map(escapaRegex).join('|'), 'u') }

// Campos varridos: bio, nome, gênero customizado (o sinal ESTRUTURADO, mais confiável que
// bio) e as respostas dos prompts.
function camposDeTexto(user = {}) {
  return [
    ['bio', user.bio],
    ['nome', user.name],
    ['genero_custom', user.custom_gender],
    ...(user.user_prompts?.prompts || []).map((p, i) => [`prompt${i + 1}`, p.answer_text]),
  ].filter(([, v]) => v)
}

// Detector genérico de marcador, usado por listas opcionais de bloqueio e bônus.
export function detectaMarcador(user = {}, { simbolos = SIMBOLOS_PADRAO, termos = TERMOS_PADRAO } = {}) {
  const reSim = simbolos?.length ? regexSimbolos(simbolos) : null
  const reTer = termos?.length ? regexTermos(termos) : null
  for (const [onde, valor] of camposDeTexto(user)) {
    const cru = String(valor)
    if (reSim && reSim.test(cru)) return { bate: true, onde, motivo: 'bandeira/simbolo', trecho: cru.slice(0, 60) }
    if (reTer) {
      const m = reTer.exec(normaliza(cru))
      if (m) return { bate: true, onde, motivo: `termo "${m[2]}"`, trecho: cru.slice(Math.max(0, m.index - 15), m.index + 45) }
    }
  }
  return { bate: false }
}

const idadeDe = (b) => (b ? Math.floor((Date.now() - new Date(b)) / 31557600000) : null)

// Julga um rec. Devolve { decisao: like|pass|fronteira, motivo, camada, pontos }.
// "fronteira" é resolvido por quem chamou (governador de taxa, ruído ou IA).
// Distância com passport ligado (doc A.6): o Tinder mede `distance_mi` sempre do GPS
// REAL. Em modo viagem, |distância bruta - offset| estima a distância até a posição
// escolhida. A correção vale só para recomendações; fast_match mantém o valor recebido.
export function julgar(rec, criterios = criteriosAtuais(), contexto = {}) {
  const u = rec.user || rec
  const idade = idadeDe(u.birth_date)
  const bruta = rec.distance_mi ?? null
  const offset = Number(contexto.offsetMi || 0)
  const usaOffset = offset > 5 && contexto.fonte === 'recs'
  const dist = bruta == null ? null : (usaOffset ? Math.round(Math.abs(bruta - offset)) : bruta)
  const fotos = (u.photos || []).length
  const bio = String(u.bio || '').trim()
  const verificada = (u.badges || []).some((b) => b.type === 'selfie_verified')
  const intencao = u.relationship_intent?.body_text || null

  // ---------- camada 1: regras duras ----------
  const reprova = (motivo) => ({ decisao: 'pass', motivo, camada: 'regra', pontos: null })
  if (u.matches_banned) return reprova('conta com restrição de match')
  if (idade != null && idade < criterios.idade.min) return reprova(`${idade} anos < mínimo ${criterios.idade.min}`)
  if (idade != null && idade > criterios.idade.max) return reprova(`${idade} anos > máximo ${criterios.idade.max}`)
  if (criterios.filtrarPorDistancia && dist != null && dist > criterios.distanciaMax) return reprova(`${dist}mi > máximo ${criterios.distanciaMax}mi${usaOffset ? ` (bruto ${bruta}mi - viagem ${Math.round(offset)}mi)` : ''}`)
  if (fotos < criterios.fotosMin) return reprova(`${fotos} foto(s) < mínimo ${criterios.fotosMin}`)
  if (criterios.exigirBio && !bio) return reprova('sem bio')
  if (criterios.exigirVerificada && !verificada) return reprova('sem selfie verificada')
  if (criterios.exigirAtivaRecente && !u.recently_active) return reprova('não esteve ativa recentemente')
  if (intencao && (criterios.intencoesBloqueadas || []).includes(intencao)) return reprova(`intenção "${intencao}" bloqueada`)

  // ---------- camada 2: texto e símbolo ----------
  const rt = criterios.regras?.excluirTrans
  if (rt?.ativa) {
    const d = detectaMarcador(u, { simbolos: rt.simbolos, termos: rt.termos })
    if (d.bate) return { decisao: 'pass', motivo: `regra excluirTrans: ${d.motivo} em ${d.onde}`, camada: 'texto', pontos: null }
  }
  if ((criterios.bloqueioTexto || []).length) {
    const d = detectaMarcador(u, { simbolos: [], termos: criterios.bloqueioTexto })
    if (d.bate) return { decisao: 'pass', motivo: `bloqueio: ${d.motivo} em ${d.onde}`, camada: 'texto', pontos: null }
  }

  // ---------- camada 3: pontuação ----------
  let pts = 0
  const porque = []
  if (verificada) { pts += 2; porque.push('verificada') }
  if (bio.length >= 40) { pts += 2; porque.push('bio boa') }
  else if (bio.length >= 10) { pts += 1; porque.push('bio curta') }
  if (fotos >= 5) { pts += 1; porque.push(`${fotos} fotos`) }
  const interesses = (u.user_interests?.selected_interests || []).length
  if (interesses >= 3) { pts += 1; porque.push(`${interesses} interesses`) }
  if (u.recently_active) { pts += 1; porque.push('ativa recente') }
  if ((u.schools || []).length || (u.jobs || []).length) { pts += 1; porque.push('escola/trabalho') }
  if (criterios.pontuarDistancia && dist != null && dist <= (criterios.distanciaPerto ?? 40)) { pts += 1; porque.push(`perto (${dist}mi)`) }
  if ((criterios.bonusTexto || []).length) {
    const b = detectaMarcador(u, { simbolos: [], termos: criterios.bonusTexto })
    if (b.bate) { pts += 2; porque.push(`bônus (${b.motivo})`) }
  }

  const resumo = porque.join(' + ') || 'nada a favor'
  if (pts >= criterios.pontuacao.curtirAcima) return { decisao: 'like', motivo: `${pts} pts: ${resumo}`, camada: 'pontuacao', pontos: pts }
  if (pts < criterios.pontuacao.passarAbaixo) return { decisao: 'pass', motivo: `${pts} pts: ${resumo}`, camada: 'pontuacao', pontos: pts }
  return { decisao: 'fronteira', motivo: `${pts} pts: ${resumo}`, camada: 'pontuacao', pontos: pts }
}

// ---------- validação (servidor nunca confia na tela) ----------

const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def)
const int = (v, def) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : def)
const bool = (v, def) => (typeof v === 'boolean' ? v : def)
const trava = (v, min, max) => Math.min(max, Math.max(min, v))

// Normaliza uma lista de chips: apara, tira vazio, tira duplicata (sem acento e sem caixa),
// limita tamanho e quantidade. Chip só de espaço ou gigante era jeito fácil de quebrar.
function listaDeChips(v, { max = 60, maxLen = 40 } = {}) {
  if (!Array.isArray(v)) return null
  const vistos = new Set()
  const out = []
  for (const item of v) {
    const s = String(item ?? '').trim()
    if (!s || s.length > maxLen) continue
    const chave = normaliza(s)
    if (vistos.has(chave)) continue
    vistos.add(chave)
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

// Devolve { ok, criterios, erros[], avisos[] }. Erro barra o salvamento; aviso só informa.
export function validaCriterios(entrada = {}) {
  const b = CRITERIOS_PADRAO
  const erros = []
  const avisos = []
  const c = JSON.parse(JSON.stringify(b))

  // idade: o Tinder não permite abaixo de 18 e inverter a faixa zera a fila
  const iMin = trava(int(entrada.idade?.min, b.idade.min), 18, 99)
  const iMax = trava(int(entrada.idade?.max, b.idade.max), 18, 99)
  if (iMin > iMax) erros.push({ campo: 'idade', msg: 'idade mínima maior que a máxima' })
  c.idade = { min: iMin, max: iMax }

  c.filtrarPorDistancia = bool(entrada.filtrarPorDistancia, b.filtrarPorDistancia)
  c.pontuarDistancia = bool(entrada.pontuarDistancia, b.pontuarDistancia)
  c.distanciaMax = trava(int(entrada.distanciaMax, b.distanciaMax), 1, 500)
  c.distanciaPerto = trava(int(entrada.distanciaPerto, b.distanciaPerto), 1, 500)
  if (c.filtrarPorDistancia && c.distanciaPerto > c.distanciaMax) avisos.push('o "perto" está maior que o limite de distância: o bônus vale pra fila inteira')
  c.fotosMin = trava(int(entrada.fotosMin, b.fotosMin), 0, 9)
  c.exigirBio = bool(entrada.exigirBio, b.exigirBio)
  c.exigirVerificada = bool(entrada.exigirVerificada, b.exigirVerificada)
  c.exigirAtivaRecente = bool(entrada.exigirAtivaRecente, b.exigirAtivaRecente)

  const intencoes = listaDeChips(entrada.intencoesBloqueadas, { max: 20, maxLen: 60 })
  c.intencoesBloqueadas = intencoes ?? b.intencoesBloqueadas

  // regra nomeada: ligada sem nenhum termo nem símbolo não filtra nada — erro, não silêncio
  const rt = entrada.regras?.excluirTrans || {}
  const termos = listaDeChips(rt.termos) ?? b.regras.excluirTrans.termos
  const simbolos = listaDeChips(rt.simbolos, { max: 20, maxLen: 16 }) ?? b.regras.excluirTrans.simbolos
  const ativa = bool(rt.ativa, b.regras.excluirTrans.ativa)
  if (ativa && !termos.length && !simbolos.length) erros.push({ campo: 'excluirTrans', msg: 'regra ligada sem nenhum termo ou símbolo' })
  c.regras = { excluirTrans: { ativa, termos, simbolos } }

  c.bloqueioTexto = listaDeChips(entrada.bloqueioTexto) ?? b.bloqueioTexto
  c.bonusTexto = listaDeChips(entrada.bonusTexto) ?? b.bonusTexto
  const conflito = c.bloqueioTexto.filter((x) => c.bonusTexto.some((y) => normaliza(x) === normaliza(y)))
  if (conflito.length) erros.push({ campo: 'bonusTexto', msg: `mesma palavra em bloqueio e bônus: ${conflito.join(', ')}` })

  // pontuação: passarAbaixo acima de curtirAcima faria a mesma nota ser like e pass
  const acima = trava(int(entrada.pontuacao?.curtirAcima, b.pontuacao.curtirAcima), 1, 12)
  const abaixo = trava(int(entrada.pontuacao?.passarAbaixo, b.pontuacao.passarAbaixo), 0, 12)
  if (abaixo > acima) erros.push({ campo: 'pontuacao', msg: 'o corte de passar não pode ser maior que o de curtir' })
  if (abaixo === acima) avisos.push('sem faixa de fronteira: o governador de taxa não vai ter o que ajustar')
  c.pontuacao = { curtirAcima: acima, passarAbaixo: abaixo }

  const tMin = trava(num(entrada.taxaLikeAlvo?.min, b.taxaLikeAlvo.min), 0, 1)
  const tMax = trava(num(entrada.taxaLikeAlvo?.max, b.taxaLikeAlvo.max), 0, 1)
  if (tMin > tMax) erros.push({ campo: 'taxaLikeAlvo', msg: 'taxa mínima maior que a máxima' })
  if (tMax > 0.7) avisos.push('curtir mais de 70% do que aparece é padrão de robô')
  c.taxaLikeAlvo = { min: tMin, max: tMax }

  c.ruido = trava(num(entrada.ruido, b.ruido), 0, 0.5)

  // a regex é montada com o que veio da tela: se não compilar, o filtro morreria em silêncio
  try {
    detectaMarcador({ bio: 'teste' }, { simbolos: c.regras.excluirTrans.simbolos, termos: c.regras.excluirTrans.termos })
    if (c.bloqueioTexto.length) detectaMarcador({ bio: 'teste' }, { simbolos: [], termos: c.bloqueioTexto })
    if (c.bonusTexto.length) detectaMarcador({ bio: 'teste' }, { simbolos: [], termos: c.bonusTexto })
  } catch (e) { erros.push({ campo: 'listas', msg: 'alguma palavra da lista quebra o detector: ' + e.message }) }

  return { ok: erros.length === 0, criterios: c, erros, avisos }
}
