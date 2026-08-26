// Leitura e escrita do Badoo pelo DOM da página real. Os seletores daqui são descobertos ao
// vivo (o Badoo não publica nada estável), então cada função tenta várias formas e devolve
// o que achou — nunca assume que o DOM é o esperado.
import { badooPage, fecharModais, BADOO } from './browser.mjs'

// A URL de uma conversa: /messages/<id>. É o mesmo id opaco da API (o `chat_instance_id`).
export const idDaUrl = (url) => (String(url || '').match(/\/messages\/([^/?#]+)/) || [])[1] || null

// Radiografia da página: o que existe, com que cara. É a base pra escolher seletor sem
// chutar — e fica no código porque o DOM do Badoo vai mudar e alguém vai precisar de novo.
export async function radiografar(page, { max = 40 } = {}) {
  return page.evaluate((max) => {
    const visivel = (el) => { const r = el.getBoundingClientRect(); return r.width > 8 && r.height > 8 }
    const texto = (el) => (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70)
    const seletor = (el) => {
      const t = el.tagName.toLowerCase()
      const qa = el.getAttribute('data-qa') || el.getAttribute('data-qa-role') || el.getAttribute('data-testid')
      if (qa) return `${t}[data-qa="${qa}"]`
      const cls = (el.className || '').toString().split(/\s+/).filter((c) => c && !/^\d/.test(c)).slice(0, 2).join('.')
      return cls ? `${t}.${cls}` : t
    }
    // elementos com data-qa são o esqueleto semântico do Badoo
    const comQa = [...document.querySelectorAll('[data-qa], [data-qa-role], [data-testid]')]
      .filter(visivel).slice(0, max)
      .map((el) => ({ qa: el.getAttribute('data-qa') || el.getAttribute('data-qa-role') || el.getAttribute('data-testid'), tag: el.tagName.toLowerCase(), txt: texto(el) }))
    // links pra conversas
    const conversas = [...document.querySelectorAll('a[href*="/messages/"]')].filter(visivel)
      .slice(0, max).map((a) => ({ href: a.getAttribute('href'), txt: texto(a) }))
    // caixas de escrita
    const escrever = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')]
      .filter(visivel).map((el) => ({ sel: seletor(el), placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-label') || '' }))
    // Censo: qual data-qa se REPETE muito? Lista é isso — a mesma marca N vezes.
    const censo = {}
    for (const el of document.querySelectorAll('[data-qa], [data-qa-role], [data-testid]')) {
      const q = el.getAttribute('data-qa') || el.getAttribute('data-qa-role') || el.getAttribute('data-testid')
      if (q) censo[q] = (censo[q] || 0) + 1
    }
    const repetidos = Object.entries(censo).filter(([, n]) => n > 2).sort((a, b) => b[1] - a[1]).slice(0, 15)
    // Amostra de uma linha de cada marca repetida, pra ver o que ela contém
    const amostras = repetidos.slice(0, 6).map(([q, n]) => {
      const el = document.querySelector(`[data-qa="${q}"], [data-qa-role="${q}"], [data-testid="${q}"]`)
      return { qa: q, vezes: n, txt: el ? texto(el) : '', clicavel: el ? !!(el.onclick || el.closest('a,button,[role="button"]')) : false }
    })
    return {
      url: location.href,
      titulo: document.title,
      logado: !/entrar|sign\s?up|log\s?in/i.test(document.title),
      comQa, conversas, escrever, repetidos, amostras,
      amostraTexto: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
    }
  }, max)
}

// Abre a lista de conversas.
export async function abrirLista(page) {
  if (!/\/(messages|connections)/.test(page.url())) {
    await page.goto(`${BADOO}/pt/connections`, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForTimeout(3500)
  }
  // o banner de consentimento cobre a lista e engole os cliques: some com ele primeiro
  await lidarComConsentimento(page).catch(() => {})
  await fecharModais(page)
  return page.url()
}

// Abre uma conversa pelo id e espera as mensagens aparecerem.
export async function abrirConversa(page, chatId) {
  await page.goto(`${BADOO}/messages/${chatId}`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(3500)
  await fecharModais(page)
  return idDaUrl(page.url())
}

// ---------------------------------------------------------------- leitura da lista
// A lista de conversas do Badoo é `connections-list-item`, cada linha com o nome
// (`profile-info__name`) e a prévia (`csms-connections-item__message`). Não são links: a
// navegação é por clique, então guardamos o índice e o nome pra reabrir depois.
export async function lerLista(page, { max = 60 } = {}) {
  return page.evaluate((max) => {
    const t = (el) => ((el && el.innerText) || '').replace(/\s+/g, ' ').trim()
    // NÃO prender na tag: os itens da lista não são <button> (o único <button> é o card
    // de curtidas). Filtrar por tag derrubou a lista de 70 itens pra 1.
    const linhas = [...document.querySelectorAll('[data-qa="connections-item"]')]
      .filter((el) => el.getAttribute('data-qa-connections-item-type') !== 'liked-you')
    const vistos = new Set()
    const out = []
    for (const [i, el] of linhas.entries()) {
      if (out.length >= max) break
      const nome = t(el.querySelector('[data-qa="profile-info__name"]'))
      const previa = t(el.querySelector('[data-qa="csms-connections-item__message"]'))
      if (!nome || vistos.has(nome + '|' + previa)) continue
      vistos.add(nome + '|' + previa)
      const img = el.querySelector('img')
      out.push({
        indice: i,
        nome,
        previa: previa || null,
        foto: img ? img.src : null,
        naoLida: !!el.querySelector('[data-qa="badge"], .badge'),
      })
    }
    return { conversas: out, totalNaTela: linhas.length }
  }, max)
}

// Abre uma conversa CLICANDO na linha (não há href). Devolve o id que apareceu na URL —
// é ele que identifica a pessoa daqui pra frente.
export async function abrirPeloNome(page, nome) {
  // O clique tem que ser do Playwright, não `el.click()` dentro do evaluate: o app do Badoo
  // escuta eventos de ponteiro e ignora o clique sintético do DOM (a URL nem mudava).
  // O clicável é o BUTTON `connections-item` — não o <li> em volta. Meu seletor com vírgula
  // casava os dois (li e button aninhados), então o índice apontava pro elemento errado e o
  // clique caía no nada. E a primeira "linha" da lista nem é conversa: é o card de curtidas.
  const todos = page.locator('[data-qa="connections-item"]:not([data-qa-connections-item-type="liked-you"])')
  const total = await todos.count()
  const botao = todos.filter({ hasText: nome }).first()
  const achou = await botao.count()
  if (!achou) return { erro: 'não achei linha com esse nome', botoesNaLista: total }
  const antes = page.url()
  let clique = 'ok'
  try {
    await botao.scrollIntoViewIfNeeded({ timeout: 8000 })
    await page.waitForTimeout(500)
    // A lista é VIRTUALIZADA: ela se remonta enquanto rola, e o `click()` do Playwright
    // espera o elemento ficar estável — espera que nunca termina (timeout de 10s estourando).
    // Clique por coordenada: pega a caixa e aciona o mouse ali, sem checagem de estabilidade.
    const cx = await botao.boundingBox()
    if (!cx) throw new Error('sem caixa na tela')
    await page.mouse.click(cx.x + cx.width / 2, cx.y + cx.height / 2)
  } catch (e) {
    clique = 'coordenada falhou: ' + (e.message || '').split('\n')[0].slice(0, 90)
    try { await botao.click({ force: true, timeout: 8000 }); clique += ' | force ok' } catch (e2) { clique += ' | force também' }
  }
  await page.waitForTimeout(3500)
  const depois = page.url()
  const composer = await temComposer(page)
  if (!idDaUrl(depois) && !composer) return { erro: 'cliquei e nada abriu', clique, botoesNaLista: total, antes, depois }
  // NÃO chamar fecharModais aqui: ele clica em "Fechar"/"Agora não" e fecharia o próprio
  // painel da conversa que acabou de abrir (foi o que aconteceu na 1ª tentativa).
  return idDaUrl(page.url())
}

// A conversa está aberta quando existe caixa de escrita.
export async function temComposer(page) {
  return page.evaluate(() => !!document.querySelector('textarea, [contenteditable="true"]'))
}

// ---------------------------------------------------------------- consentimento de cookies
// O Badoo usa um CMP que cobre metade da tela e BLOQUEIA os cliques na lista (foi o que
// travou a primeira tentativa de abrir conversa — o clique nem chegava na linha).
//
// A escolha aqui é deliberada: entramos em "Manage Cookies" e RECUSAMOS o não-essencial,
// em vez de clicar em "Accept cookies". Aceitar rastreamento em nome do dono não é uma
// decisão que o sistema deva tomar sozinho.
export async function lidarComConsentimento(page) {
  // O CMP vive num IFRAME (foi por isso que a primeira checagem disse "sem banner" com o
  // banner na tela): procurar no document principal não enxerga nada.
  const alvos = [page, ...page.frames()]
  let ctx = null
  for (const f of alvos) {
    try {
      const tem = await f.evaluate(() => /Protecting and respecting your privacy|Accept cookies|Manage Cookies|Aceitar cookies/i.test(document.body?.innerText || ''))
      if (tem) { ctx = f; break }
    } catch { /* frame morto */ }
  }
  if (!ctx) return { banner: false, frames: page.frames().length }
  const paginaOriginal = page
  page = ctx   // daqui pra baixo, tudo acontece dentro do frame do consentimento

  // 1) entra no gerenciador
  for (const alvo of ['Manage Cookies', 'Gerenciar cookies', 'Gerir cookies']) {
    const b = page.getByRole('button', { name: alvo }).first()
    try { if (await b.count()) { await b.click({ timeout: 6000 }); await page.waitForTimeout(2500); break } } catch { /* tenta o próximo */ }
  }

  // 2) recusa tudo que der, dentro do gerenciador
  const recusas = ['Reject all', 'Rejeitar tudo', 'Reject All', 'Deny all', 'Recusar tudo']
  for (const r of recusas) {
    const b = page.getByRole('button', { name: r }).first()
    try { if (await b.count()) { await b.click({ timeout: 6000 }); await page.waitForTimeout(2500); return { banner: true, acao: 'recusou: ' + r } } } catch { /* segue */ }
  }
  // 3) sem "recusar tudo": confirma com as opções como estão (o padrão do CMP é desligado)
  for (const r of ['Save & Exit', 'Confirm my choices', 'Salvar e sair', 'Confirmar escolhas']) {
    const b = page.getByRole('button', { name: r }).first()
    try { if (await b.count()) { await b.click({ timeout: 6000 }); await page.waitForTimeout(2500); return { banner: true, acao: 'confirmou sem marcar: ' + r } } } catch { /* segue */ }
  }
  // 4) sem opção de recusar: FECHA no X. Não consente e desbloqueia a tela.
  //    "Accept cookies" nunca é clicado — consentir com rastreamento não é decisão do sistema.
  for (const r of ['X', 'Close', 'Fechar']) {
    const b = page.getByRole('button', { name: r }).first()
    try { if (await b.count()) { await b.click({ timeout: 6000 }); await page.waitForTimeout(2000); return { banner: true, acao: 'fechou no X (sem consentir)' } } } catch { /* segue */ }
  }
  // 5) último recurso: TIRA o overlay do caminho, sem tocar em nenhum botão. Isso não
  //    aceita e não recusa nada — só impede que a camada do CMP engula os cliques da lista.
  //    (Os botões dele não respondem por role/nome; insistir seria chute.)
  const removeu = await paginaOriginal.evaluate(() => {
    let n = 0
    for (const f of document.querySelectorAll('iframe')) {
      const src = f.src || ''
      if (/consent|privacy|sp-|sourcepoint|cmp/i.test(src) || f.getBoundingClientRect().height > 200) { f.remove(); n++ }
    }
    for (const el of document.querySelectorAll('body > div, body > section')) {
      const cs = getComputedStyle(el)
      if ((cs.position === 'fixed' || cs.position === 'sticky') && parseInt(cs.zIndex || '0', 10) > 1000
          && el.getBoundingClientRect().height > 200) { el.remove(); n++ }
    }
    document.body.style.overflow = ''
    return n
  })
  return { banner: true, acao: `removi o overlay do caminho (${removeu} elemento(s)) — sem aceitar nem recusar` }
}
