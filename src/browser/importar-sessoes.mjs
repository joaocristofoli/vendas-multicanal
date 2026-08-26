import { connectBrowser, firstContext } from './chrome.mjs'
import { tinderClient } from '../tinder/api.mjs'
import { setToken, UA as TINDER_UA } from '../tinder/session.mjs'
import { importarCookies as importarBadoo } from '../badoo/session.mjs'
import { importCookies as importarInstagram } from '../ig/session.mjs'
import { setSetting } from '../core/db.mjs'

const DOMINIOS = {
  tinder: /(^|\.)tinder\.com$/i,
  badoo: /(^|\.)badoo\.com$/i,
  instagram: /(^|\.)instagram\.com$/i,
}

function hostSeguro(url) {
  try { return new URL(url).hostname } catch { return '' }
}

async function contextoChrome() {
  const browser = await connectBrowser()
  const contexto = firstContext(browser)
  if (!contexto) throw new Error('Chrome dedicado sem perfil aberto. Rode npm run chrome.')
  return contexto
}

async function paginaDaRede(contexto, canal) {
  const pagina = contexto.pages().find((p) => DOMINIOS[canal].test(hostSeguro(p.url())))
  if (!pagina) throw new Error(`Abra ${canal}.com no Chrome dedicado e faça login primeiro.`)
  return pagina
}

async function userAgent(pagina) {
  return pagina.evaluate(() => navigator.userAgent).catch(() => null)
}

export async function importarSessaoDoChrome(canal) {
  if (!DOMINIOS[canal]) throw new Error('canal não suportado para importação pelo Chrome')
  const contexto = await contextoChrome()
  const pagina = await paginaDaRede(contexto, canal)

  if (canal === 'tinder') {
    const token = await pagina.evaluate(() => localStorage.getItem('TinderWeb/APIToken')).catch(() => null)
    if (!token) throw new Error('Tinder aberto, mas sem sessão. Conclua o login nessa aba e tente novamente.')
    const me = await tinderClient({ token, ua: await userAgent(pagina) || TINDER_UA }).profile()
    if (!me?._id) throw new Error('O Tinder não confirmou a identidade desta sessão.')
    setToken(token)
    setSetting('tinder_me', { id: me._id, name: me.name })
    return { ok: true, canal, me: me.name || null }
  }

  const todos = await contexto.cookies()
  const cookies = todos.filter((c) => DOMINIOS[canal].test(String(c.domain || '').replace(/^\./, '')))
  if (!cookies.length) throw new Error(`${canal} aberto, mas sem cookies de sessão. Conclua o login nessa aba e tente novamente.`)
  const ua = await userAgent(pagina)

  if (canal === 'badoo') {
    const r = await importarBadoo(cookies, ua)
    return { ...r, canal }
  }

  const r = await importarInstagram(cookies, ua)
  if (!r.ok) throw new Error('O Instagram não confirmou a sessão. Atualize a aba, conclua qualquer verificação e tente novamente.')
  return { ok: true, canal, me: r.me || null }
}
