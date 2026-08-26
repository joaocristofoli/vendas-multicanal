// Página do Badoo no Chrome real da VM (via CDP). Mesmo desenho do Instagram, e pelo mesmo
// motivo — mas aqui a razão é mais forte que "o DOM é a única forma":
//
// O Badoo assina cada chamada da API com um `x-pingback` calculado no JS deles sobre o
// CORPO do pedido (provado em 25/07/2026: só funciona o pingback do pedido exato; o de
// outra chamada da mesma sessão falha). Um cliente HTTP não consegue montar pedidos novos —
// só repetir capturados. Dentro do navegador, quem assina é o código deles, de graça.
//
// Regra herdada do Instagram: UMA aba, operações serializadas com timeout. Se uma travar, a
// fila avança — senão um travamento congela o canal inteiro pra sempre.
import { connectBrowser, firstContext } from '../browser/chrome.mjs'
import { getCookies, getUa } from './session.mjs'

const BADOO = 'https://badoo.com'
let _page = null
let _cookiesInjetados = false

// Injeta a sessão importada no perfil do Chrome (uma vez por processo, ou à força).
async function garantirSessao(ctx, forcar = false) {
  if (_cookiesInjetados && !forcar) return
  const cru = getCookies()
  if (!cru) throw new Error('sem sessão do Badoo — importe os cookies primeiro')
  const cookies = cru.split(/;\s*/).map((s) => {
    const i = s.indexOf('=')
    return { name: s.slice(0, i).trim(), value: s.slice(i + 1).trim(), domain: '.badoo.com', path: '/', secure: true }
  }).filter((c) => c.name && c.value)
  await ctx.addCookies(cookies)
  _cookiesInjetados = true
}

// Esquece a sessão já injetada. Reimportar cookies no mesmo processo caía no cache e o
// Chrome seguia com a sessão VELHA — a importação "dava certo" e o canal continuava na conta
// anterior. Quem troca cookie chama isto antes de provar.
export function esquecerSessaoInjetada() { _cookiesInjetados = false }

export async function badooPage() {
  const b = await connectBrowser()
  const ctx = firstContext(b)
  if (!ctx) throw new Error('Chrome sem contexto')
  await garantirSessao(ctx)
  if (_page && !_page.isClosed()) return _page
  _page = ctx.pages().find((p) => /badoo\.com/.test(p.url())) || (await ctx.newPage())
  try {
    const cdp = await ctx.newCDPSession(_page)
    const ua = getUa()
    if (ua) await cdp.send('Network.setUserAgentOverride', { userAgent: ua }).catch(() => {})
  } catch { /* segue sem override */ }
  await _page.setViewportSize({ width: 1280, height: 900 }).catch(() => {})
  return _page
}

// Uma aba SÓ pra sessão de deslizar, na mesma sessão de cookies.
//
// A aba compartilhada tem dono: o sync abre até 6 conversas a cada 5 minutos e deixa a aba
// numa `/messages/...`. Uma sessão de deslizar dura minutos e ficava sendo levada embora no
// meio — o baralho carregava e, quando ia clicar, a tela já era outra. Como o `badooExclusive`
// só serializa dentro de um processo, disputar a mesma aba nunca ia ficar de pé.
// Aba própria resolve os dois problemas de uma vez: ninguém navega por baixo, e o deslizar
// não precisa mais segurar o mutex enquanto vota.
// UMA aba só, reaproveitada. Criar uma por sessão vazava: em 27/07/2026 a VM tinha 27 abas
// abertas e load 6,3 numa máquina de 2 núcleos — e aí o ENVIO de mensagem do Badoo passou a
// estourar 120s de timeout, ou seja, o deslizar estava impedindo a IA de responder.
let _pagePropria = null
export async function badooPaginaPropria() {
  if (_pagePropria && !_pagePropria.isClosed()) return _pagePropria
  const b = await connectBrowser()
  const ctx = firstContext(b)
  if (!ctx) throw new Error('Chrome sem contexto')
  // à força: a aba nova nasceu deslogada mostrando a página de cadastro, porque a marca de
  // "já injetei" é por processo e pulava a injeção
  await garantirSessao(ctx, true)
  // reaproveita uma aba de encontros que tenha sobrado de um processo anterior
  const page = ctx.pages().find((x) => /badoo\.com\/encounters/.test(x.url()) && !x.isClosed()) || (await ctx.newPage())
  try {
    const cdp = await ctx.newCDPSession(page)
    const ua = getUa()
    if (ua) await cdp.send('Network.setUserAgentOverride', { userAgent: ua }).catch(() => {})
  } catch { /* segue sem override */ }
  await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {})
  _pagePropria = page
  return page
}

// Fecha o que o Badoo joga por cima (cookies, promoções, "quer premium?").
export async function fecharModais(page) {
  const rotulos = ['Aceitar', 'Aceitar tudo', 'Accept', 'Agora não', 'Não, obrigado', 'Fechar', 'Talvez depois', 'Mais tarde']
  let fechou = false
  for (const r of rotulos) {
    const el = await page.$(`text="${r}"`).catch(() => null)
    if (el) { await el.click().catch(() => {}); await page.waitForTimeout(600); fechou = true }
  }
  // botão de fechar genérico do modal
  const x = await page.$('[data-qa-role="modal-close"], [aria-label="Fechar"], [aria-label="Close"]').catch(() => null)
  if (x) { await x.click().catch(() => {}); await page.waitForTimeout(400); fechou = true }
  return fechou
}

const OP_TIMEOUT_MS = Number(process.env.TIM_BADOO_OP_TIMEOUT_MS || 120000)
function comTimeout(p, ms) {
  let t
  const limite = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`operação do Badoo excedeu ${Math.round(ms / 1000)}s`)), ms) })
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(t)), limite])
}
let _fila = Promise.resolve()
export function badooExclusive(fn) {
  const run = _fila.then(() => comTimeout(fn(), OP_TIMEOUT_MS))
  _fila = run.then(() => {}, () => {})
  return run
}

// Solta a aba (usado quando a sessão é reimportada ou algo trava de vez).
export function soltarPagina() {
  if (_page && !_page.isClosed()) _page.close().catch(() => {})
  _page = null
  _cookiesInjetados = false
}

export { BADOO }
