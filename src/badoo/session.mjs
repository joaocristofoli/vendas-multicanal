// Sessão do Badoo. Mesma escolha do Instagram e do Tinder: não logamos do zero pelo IP de
// datacenter (isso dispara verificação). O dono exporta os cookies do navegador dele já
// logado, a gente guarda e usa em toda chamada.
//
// Diferença pro Instagram: lá os cookies são injetados num Chrome real (o Instagram é lido
// pelo DOM). Aqui não precisa de navegador — o Badoo tem API JSON, então basta mandar o
// cabeçalho `cookie` no fetch. É mais rápido, mais estável e não disputa a aba do Chrome.
import { getSetting, setSetting, logEvent } from '../core/db.mjs'
import { listarConversas } from './api.mjs'

const UA_PADRAO = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

// Aceita os mesmos formatos do Instagram, porque é assim que o dono já está acostumado:
//  - string 'session=..; sso=..'        (copiado do DevTools, cabeçalho Cookie)
//  - array [{name,value}]                (export de extensão)
//  - objeto {session:'...', ...}
export function normalizarCookies(entrada) {
  let pares = []
  if (Array.isArray(entrada)) pares = entrada.map((c) => [c.name, c.value])
  else if (entrada && typeof entrada === 'object') pares = Object.entries(entrada)
  else if (typeof entrada === 'string') {
    pares = entrada.split(/;\s*/).map((s) => { const i = s.indexOf('='); return i < 0 ? [s.trim(), ''] : [s.slice(0, i).trim(), s.slice(i + 1).trim()] })
  }
  return pares
    .filter(([n, v]) => n && v)
    .map(([name, value]) => [name, String(value).replace(/^"|"$/g, '')])
}

export const cabecalhoCookie = (pares) => pares.map(([n, v]) => `${n}=${v}`).join('; ')

export function getCookies() { return getSetting('badoo_cookies', null) }
export function getUa() { return getSetting('badoo_ua', UA_PADRAO) }
export function getMe() { return getSetting('badoo_me', null) }

// Guarda os cookies e PROVA que a sessão funciona: pede a lista de conversas. Sem essa
// prova, um cookie velho ficaria salvo em silêncio e só falharia no primeiro sync.
// A PROVA NÃO PODE SER PELO CAMINHO IMPOSSÍVEL. Esta função nasceu provando a sessão com
// `listarConversas` — HTTP puro. Só que o §10 do docs/ENTENDIMENTO-BADOO.md mediu que HTTP
// puro NÃO MONTA pedido novo: o `x-pingback` é assinatura do corpo, e sem ela toda chamada
// volta 9012. Ou seja, a porta de entrada do canal recusava QUALQUER cookie, inclusive os
// válidos, por um teste que não tinha como passar. (Em 11/08/2026 foi exatamente o que
// aconteceu com uma sessão boa: `Badoo recusou [9012]`.)
//
// Agora a ordem é: tenta o HTTP (barato, e funciona pra sessão já aquecida); se ele bater na
// parede conhecida do 9012, prova pelo caminho que o sistema REALMENTE usa — injetar os
// cookies no Chrome da VM e deixar o app do Badoo fazer a chamada assinada, lendo a resposta.
// Só salva com uma das duas provas. Cookie ruim continua sem entrar.
export async function importarCookies(entrada, ua) {
  const pares = normalizarCookies(entrada)
  if (!pares.length) throw new Error('nenhum cookie reconhecido no que foi colado')
  const cookies = cabecalhoCookie(pares)
  const agente = ua || UA_PADRAO
  let prova = null
  try {
    const r = await listarConversas({ cookies, ua: agente, quantidade: 5 })
    if (!Array.isArray(r.pessoas)) throw new Error('a sessão não devolveu conversas — cookie inválido ou expirado')
    prova = { via: 'http', conversas: r.pessoas.length, total: r.total, amostra: r.pessoas.slice(0, 3).map((p) => p.nome) }
  } catch (e) {
    if (!/\b9012\b/.test(String(e && e.message))) throw e
    // Grava provisoriamente porque o injetor do navegador lê os cookies do BANCO; se a prova
    // falhar, o valor anterior volta — nada de sessão meia-boca ficando salva.
    const anterior = getSetting('badoo_cookies', null)
    const anteriorUa = getSetting('badoo_ua', null)
    setSetting('badoo_cookies', cookies); setSetting('badoo_ua', agente)
    try {
      const { esquecerSessaoInjetada } = await import('./browser.mjs')
      esquecerSessaoInjetada()
      const { sincronizarLista } = await import('./sync.mjs')
      const r = await sincronizarLista({ accountKey: getSetting('conta_atual', 'main') })
      const n = (r && r.conversas) || 0
      if (!n) throw new Error('o navegador abriu o Badoo mas não veio lista — cookie inválido ou expirado')
      prova = { via: 'navegador', conversas: n, total: n, amostra: [] }
    } catch (e2) {
      if (anterior) { setSetting('badoo_cookies', anterior); setSetting('badoo_ua', anteriorUa || UA_PADRAO) }
      else { setSetting('badoo_cookies', null); setSetting('badoo_ua', null) }
      throw new Error(`HTTP puro é impossível por desenho (9012) e a prova pelo navegador falhou: ${e2.message}`)
    }
  }
  setSetting('badoo_cookies', cookies)
  setSetting('badoo_ua', agente)
  setSetting('badoo_importado_em', Date.now())
  logEvent({ type: 'badoo_session_import', detail: pares.map(([n]) => n).join(',') + ` · ${prova.conversas} conversas (prova: ${prova.via})` })
  return { ok: true, via: prova.via, conversas: prova.conversas, total: prova.total, amostra: prova.amostra }
}

// A sessão ainda vale? Devolve { ok, conversas } sem lançar.
export async function checarSessao() {
  const cookies = getCookies()
  if (!cookies) return { ok: false, motivo: 'sem cookies importados' }
  try {
    const r = await listarConversas({ cookies, ua: getUa(), quantidade: 3 })
    return { ok: true, conversas: r.total }
  } catch (e) {
    return { ok: false, motivo: e && e.message ? e.message : String(e) }
  }
}

// Atalho: as credenciais prontas pra passar pro api.mjs.
export function credenciais() { return { cookies: getCookies(), ua: getUa() } }
