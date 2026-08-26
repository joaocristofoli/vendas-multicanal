// Sessão do Tinder: guarda o token (setting no banco), valida, e tenta manter fresco
// lendo do Chrome logado na VM (o app web renova sozinho). Estratégia sustentável:
// a VM é a sessão única; o token vem do Chrome da VM quando disponível.
import { getSetting, setSetting, logEvent } from '../core/db.mjs'
import { tinderClient } from './api.mjs'

const UA = process.env.TIM_UA || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

export function getToken() { return getSetting('tinder_token', null) }
export function setToken(tok) { setSetting('tinder_token', tok); setSetting('tinder_token_at', Date.now()) }
export function getMe() { return getSetting('tinder_me', null) }

export function tinderApi() {
  const token = getToken()
  if (!token) throw new Error('Sem token do Tinder. Faça a sessão da VM (ver painel).')
  return tinderClient({ token, ua: UA })
}

// Valida a sessão atual; guarda quem sou. Retorna { ok, me?, reason? }.
export async function checkSession() {
  const token = getToken()
  if (!token) return { ok: false, reason: 'sem token' }
  try {
    const me = await tinderClient({ token, ua: UA }).profile()
    setSetting('tinder_me', { id: me._id, name: me.name })
    return { ok: true, me }
  } catch (e) { return { ok: false, reason: e.message } }
}

// Lê o token do Chrome logado na VM (sem navegar, só evaluate) e adota se for da MESMA conta.
//
// ESTE CAMINHO ESTÁ DESLIGADO POR DECISÃO — ver `docs/TINDER-SESSAO.md`. A sessão do
// vendas-multicanal vem de um navegador normal, não do Chrome da VM. A função continua aqui porque
// é a rede de recuperação automática do dia em que a decisão mudar; enquanto não mudar, o
// Chrome da VM não tem sessão nenhuma e ela devolve null sem fazer nada.
//
// A CHECAGEM DE CONTA É O QUE TORNA ISSO SEGURO DE DEIXAR LIGADO. Antes, qualquer token
// válido achado numa aba de tinder.com era adotado — se alguém abrisse OUTRA conta naquele
// Chrome (a de teste, a de outra pessoa), o sistema trocava de dona em silêncio e passava a
// dar like e responder pela conta errada. Token só entra se o `_id` bater com o de quem já
// está registrado; conta diferente é registrada no Diário e RECUSADA.
export async function refreshFromChrome() {
  try {
    const { connectBrowser, firstContext } = await import('../browser/chrome.mjs')
    const b = await connectBrowser()
    const ctx = firstContext(b)
    for (const p of ctx.pages()) {
      if (!/tinder\.com/.test(p.url())) continue
      const tok = await p.evaluate(() => localStorage.getItem('TinderWeb/APIToken')).catch(() => null)
      if (tok && tok !== getToken()) {
        try {
          const me = await tinderClient({ token: tok, ua: UA }).profile()
          const registrado = getMe()
          if (registrado?.id && me?._id && String(me._id) !== String(registrado.id)) {
            logEvent({ type: 'tinder_token_conta_errada', detail: `o Chrome da VM está logado em "${me.name}" e a conta deste sistema é "${registrado.name}" — token RECUSADO` })
            continue
          }
          setToken(tok)
          logEvent({ type: 'tinder_token_refreshed', detail: 'chrome-vm' })
          return tok
        } catch { /* invalido */ }
      }
    }
  } catch { /* chrome sem sessão */ }
  return null
}

export { UA }
