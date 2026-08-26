// Abrir uma conversa NOVA no Instagram a partir de um @ (F6 do PLANO-IDENTIDADE-VINCULO.md).
//
// Até aqui o vendas-multicanal só sabia responder em thread que já existia (`sendToThread` exige
// thread_id). Quando ela passava o Instagram no Tinder, não dava pra chamar — o @ nem era
// guardado. Este módulo fecha esse buraco: /direct/new/ -> busca o @ -> seleciona -> abre.
//
// É o ponto mais frágil do plano (depende do DOM do Instagram no Chrome logado do dono),
// então cada passo confirma o que aconteceu antes de seguir, e a função devolve um motivo
// legível quando não dá — nunca "abre" uma conversa com a pessoa errada por chute.
import { IG, closeModals } from './browser.mjs'
import { threadIdFromUrl } from './dom.mjs'

const pausa = (page, ms) => page.waitForTimeout(ms)

// Acha a caixa de busca do modal "Nova mensagem". O Instagram troca placeholder e aria
// conforme o idioma da conta, então tentamos várias e caímos no primeiro input do diálogo.
async function acharBuscaDoModal(page) {
  const tentativas = [
    'input[name="queryBox"]',
    'div[role="dialog"] input[placeholder*="Pesquis" i]',
    'div[role="dialog"] input[placeholder*="Search" i]',
    'div[role="dialog"] input[type="text"]',
    'div[role="dialog"] input',
  ]
  for (const sel of tentativas) {
    const el = await page.$(sel)
    if (el) return el
  }
  return null
}

// Linha de resultado cujo @ bate EXATAMENTE com o procurado. Nome nunca serve de chave:
// tem cinco "Ana Paula" na busca, mas só um @ana.paula.
async function acharResultadoExato(page, username) {
  const alvo = String(username).toLowerCase()
  const linhas = await page.$$('div[role="dialog"] div[role="button"], div[role="dialog"] [role="option"]')
  for (const linha of linhas) {
    const txt = (await linha.innerText().catch(() => '')) || ''
    const tokens = txt.split('\n').map((t) => t.trim().toLowerCase()).filter(Boolean)
    if (tokens.includes(alvo) || tokens.includes('@' + alvo)) return linha
  }
  return null
}

// Botão de avançar do modal ("Bate-papo" / "Chat" / "Avançar" / "Next").
async function acharBotaoAvancar(page) {
  const textos = ['bate-papo', 'chat', 'avançar', 'avancar', 'next', 'conversar']
  const btns = await page.$$('div[role="dialog"] div[role="button"], div[role="dialog"] button')
  for (const b of btns) {
    const t = ((await b.innerText().catch(() => '')) || '').trim().toLowerCase()
    if (textos.includes(t)) return b
  }
  return null
}

// Abre (ou reabre) a conversa com @username. NÃO envia nada — só deixa a thread aberta.
// Devolve { ok, threadId, motivo }. Quando a conversa já existe, o Instagram cai direto
// nela e o thread_id volta igual — por isso serve pros dois casos.
export async function openNewThread(page, username) {
  const alvo = String(username || '').trim().replace(/^@+/, '').toLowerCase()
  if (!alvo) return { ok: false, motivo: 'username vazio' }

  await page.goto(`${IG}/direct/new/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await pausa(page, 2500)
  await closeModals(page)

  const busca = await acharBuscaDoModal(page)
  if (!busca) return { ok: false, motivo: 'caixa de busca do modal não apareceu' }

  await busca.click().catch(() => {})
  await pausa(page, 300)
  await page.keyboard.type(alvo, { delay: 45 })
  await pausa(page, 2500) // a busca do Instagram é remota: precisa respirar

  const linha = await acharResultadoExato(page, alvo)
  if (!linha) return { ok: false, motivo: `nenhum resultado com o @ exato "${alvo}"` }
  await linha.click().catch(() => {})
  await pausa(page, 800)

  const avancar = await acharBotaoAvancar(page)
  if (!avancar) return { ok: false, motivo: 'botão de avançar não encontrado' }
  const desabilitado = await avancar.getAttribute('aria-disabled').catch(() => null)
  if (desabilitado === 'true') return { ok: false, motivo: 'o Instagram não deixou avançar (perfil não selecionado)' }
  await avancar.click().catch(() => {})
  await pausa(page, 3500)
  await closeModals(page)

  const threadId = threadIdFromUrl(page.url())
  if (!threadId) return { ok: false, motivo: 'a conversa não abriu (sem thread na URL)' }
  return { ok: true, threadId }
}
