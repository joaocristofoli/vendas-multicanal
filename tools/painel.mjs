// Falar com o núcleo (vendas-multicanal-core) a partir de uma ferramenta de linha de comando.
//
// Toda ferramenta que precisa do socket do WhatsApp, da sessão do Instagram ou do token do
// Tinder tem que passar por aqui: essas coisas vivem DENTRO do processo do vendas-multicanal-core, e um
// segundo processo que tentasse falar com o WhatsApp direto abriria outro pareamento e
// derrubaria o primeiro.
//
// O painel autentica por cookie ASSINADO com um segredo que só o processo do núcleo conhece
// (aleatório por processo quando TIM_PANEL_SECRET não está setado). Não dá pra forjar o
// cookie — e nem se deve. O caminho honesto é o mesmo do navegador: login com a senha, que
// vem do /opt/vendas-multicanal/env, que é onde ela já mora.
import fsSync from 'node:fs'

export const PAINEL = process.env.TIM_PANEL_URL || 'http://127.0.0.1:8080'

let _cookie = null
export async function autenticar() {
  if (_cookie) return _cookie
  let senha = process.env.TIM_PANEL_PASSWORD
  if (!senha) {
    try {
      const env = fsSync.readFileSync('/opt/vendas-multicanal/env', 'utf8')
      senha = env.match(/^TIM_PANEL_PASSWORD=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '')
    } catch { /* sem env: segue sem senha e o painel recusa com 401 claro */ }
  }
  if (!senha) throw new Error('não achei TIM_PANEL_PASSWORD (nem no ambiente nem em /opt/vendas-multicanal/env)')
  const r = await fetch(PAINEL + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: senha }) })
  if (!r.ok) throw new Error(`login no painel falhou (${r.status}) — senha errada?`)
  const set = r.headers.get('set-cookie') || ''
  _cookie = set.split(';')[0]
  if (!_cookie) throw new Error('o painel não devolveu cookie de sessão')
  return _cookie
}

// Devolve { ok, status, dados } — nunca estoura por status HTTP, porque quem chama precisa
// distinguir "o núcleo recusou" (mensagem útil pro dono) de "o núcleo não respondeu".
export async function postNoPainel(rota, corpo) {
  const cookie = await autenticar()
  const r = await fetch(PAINEL + rota, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(corpo || {}),
  })
  const txt = await r.text()
  let dados = null
  try { dados = txt ? JSON.parse(txt) : null } catch { dados = { texto: txt } }
  return { ok: r.ok, status: r.status, dados }
}
