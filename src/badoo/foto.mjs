// Envio de FOTO no Badoo.
//
// Por que pelo navegador, e não por requisição: o envio tem duas etapas, e a primeira é um
// upload para um CDN com uma URL assinada (`.../hidden?euri=<token>`) que o servidor entrega
// ao cliente em tempo de execução. Fabricar isso por fora significaria reimplementar a
// assinatura e sustentá-la para sempre. O caminho barato e estável é o mesmo já usado na nota
// de voz: colocar o arquivo no input do PRÓPRIO cliente Badoo, já logado, e deixar ele fazer,
// na ordem real, upload -> SERVER_SEND_CHAT_MESSAGE. O pacote 151 do site é o comprovante.
//
// A TRAVA QUE MAIS IMPORTA AQUI É O ALVO. Foto trocada é irreversível: em 03/08/2026 duas
// fotos foram parar com terceiros no Instagram porque o alvo foi conferido contra um cache em
// vez da página. Então, antes de soltar o arquivo, este módulo confere DUAS coisas
// independentes na página viva — a URL da conversa e o nome no cabeçalho — e ABORTA quando
// não conseguir ler. Ver `licoes/teste-caiu-na-conversa-errada`.
import { readFile } from 'node:fs/promises'
import { badooPage, badooExclusive } from './browser.mjs'
import { lidarComConsentimento } from './dom.mjs'
import { savedImagePath } from '../wa/saved-image.mjs'
import { addMessage, marcarAutor, getSavedImageByShortcut, bumpSavedImageUsage, logEvent } from '../core/db.mjs'

const INPUT_FOTO = 'input[type=file][accept*="image"]'
// O botão da pré-visualização. Texto exato para não pegar outro "enviar" da tela.
const BOTAO_ENVIAR = 'button:text-is("Enviar"), [role=button]:text-is("Enviar")'
const BOTAO_MULTIMIDIA = '[data-qa="messenger-chat-control-switcher-multimedia"]'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// O comprovante: o site responde o envio com um pacote 151 que traz o id da foto no chat.
// Sem ele, não se diz que enviou — some com a mensagem "não deu para confirmar".
function reciboDaFoto(packet) {
  for (const body of packet?.body || []) {
    const recebido = body?.chat_message_received
    const msg = recebido?.chat_message
    if (recebido?.success && msg?.multimedia?.photo?.id) {
      return { uid: String(msg.uid || ''), photoId: String(msg.multimedia.photo.id) }
    }
  }
  return null
}

// Fecha uma pré-visualização de foto que tenha ficado aberta de uma tentativa anterior. Com
// ela na tela, o input não reage e o compositor parece quebrado.
async function fecharPreviewPendente(page) {
  const aberto = await page.$(BOTAO_ENVIAR)
  if (!aberto) return false
  await page.click('button[aria-label="Fechar"], button[aria-label="Close"], [data-qa="close"]').catch(() => {})
  await page.keyboard.press('Escape').catch(() => {})
  await sleep(1200)
  return true
}

// ORÇAMENTO DE TEMPO. A aba do Badoo é UMA só e a fila (`badooExclusive`) corta a operação em
// 120 s — passou disso, o sync entra e navega por baixo, e o que se vê é "o compositor
// quebrou". Por isso cada espera aqui é curta e somada de propósito: navegar (25 s) +
// pré-visualização (15 s) + comprovante (45 s) cabe com folga.
async function abrirConversaConferida(page, { chatId, nomeEsperado }) {
  if (!page.url().includes(chatId)) {
    await page.goto(`https://badoo.com/pt/messages/${chatId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
    for (let i = 0; i < 10 && !page.url().includes(chatId); i += 1) await sleep(500)
  }
  if (!page.url().includes(chatId)) throw new Error('não consegui abrir a conversa certa no Badoo (a URL nunca bateu com o chat)')
  // Segunda conferência, independente da primeira: o nome que a PÁGINA mostra. Precisa
  // ESPERAR — com `domcontentloaded` o app ainda está montando o cabeçalho, e ler cedo demais
  // devolve vazio, que aqui significa abortar.
  await page.waitForSelector('[data-qa="profile-info__name"]', { timeout: 12_000, state: 'attached' }).catch(() => {})
  const nomeNaPagina = await page.evaluate(() => {
    const el = document.querySelector('[data-qa="profile-info__name"]')
    return el ? (el.textContent || '').trim() : null
  })
  if (!nomeNaPagina) throw new Error('não consegui ler de quem é a conversa aberta; não vou mandar foto no escuro')
  if (nomeEsperado) {
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
    if (!norm(nomeNaPagina).startsWith(norm(nomeEsperado).split(' ')[0])) {
      throw new Error(`a conversa aberta é de "${nomeNaPagina}", não de "${nomeEsperado}" — abortei antes de mandar a foto`)
    }
  }
  return nomeNaPagina
}

// DIAGNÓSTICO do compositor: abre a conversa e conta o que existe na tela depois de clicar no
// botão de multimídia. Roda pela mesma fila do envio (senão o sync troca a aba por baixo).
export async function diagnosticarCompositorBadoo({ chatId, nomeEsperado = null } = {}) {
  return badooExclusive(async () => {
    const page = await badooPage()
    const nome = await abrirConversaConferida(page, { chatId, nomeEsperado })
    await lidarComConsentimento(page).catch(() => {})
    const antes = await page.evaluate(() => ({
      inputs: [...document.querySelectorAll('input[type=file]')].map((i) => ({ accept: i.accept, qa: i.getAttribute('data-qa'), montado: !!i.offsetParent })),
      switcher: !!document.querySelector('[data-qa="messenger-chat-control-switcher-multimedia"]'),
    }))
    await page.click('[data-qa="messenger-chat-control-switcher-multimedia"]').catch(() => {})
    await sleep(1500)
    const depois = await page.evaluate(() => {
      const caminho = (el) => {
        const partes = []
        for (let n = el; n && n !== document.body && partes.length < 5; n = n.parentElement) {
          partes.unshift(n.getAttribute('data-qa') || n.className?.toString().split(' ')[0] || n.tagName.toLowerCase())
        }
        return partes.join(' > ')
      }
      return {
        inputs: [...document.querySelectorAll('input[type=file]')].map((i) => ({ accept: i.accept, onde: caminho(i) })),
        rotulados: [...document.querySelectorAll('[aria-label],[title]')]
          .map((e) => ({ rot: e.getAttribute('aria-label') || e.getAttribute('title'), tag: e.tagName.toLowerCase(), qa: e.getAttribute('data-qa') }))
          .filter((x) => /foto|photo|imagem|image|galeria/i.test(x.rot || '')).slice(0, 10),
      }
    })
    return { nome, antes, depois }
  })
}

// Manda a foto salva (pelo atalho) para uma conversa do Badoo.
// `permitirQuente` vem da etiqueta da pessoa; foto de família nunca passa daqui (o próprio
// getSavedImageByShortcut recusa).
export async function enviarFotoBadoo({ accountKey, personId, chatId, atalho, nomeEsperado = null, permitirQuente = false, author = 'ia' } = {}) {
  const imagem = getSavedImageByShortcut(atalho, { permitirQuente })
  if (!imagem) throw new Error(`foto "${atalho}" não existe, está inativa ou o nível não permite enviar nesta conversa`)
  const caminho = savedImagePath(imagem.file)
  const bytes = await readFile(caminho)

  return badooExclusive(async () => {
    const page = await badooPage()
    const nome = await abrirConversaConferida(page, { chatId, nomeEsperado })

    // Escuta a resposta do próprio site: é ela que comprova o envio.
    let recibo = null
    const ouvinte = async (resposta) => {
      if (recibo || !resposta.url().includes('SERVER_SEND_CHAT_MESSAGE')) return
      try { recibo = reciboDaFoto(await resposta.json()) } catch { /* pacote que não é json */ }
    }
    page.on('response', ouvinte)
    try {
      // RECONFERE NO ÚLTIMO INSTANTE. Entre abrir a conversa e soltar o arquivo a aba pode ter
      // mudado de conversa (o sync usa a MESMA aba). Conferir só no começo é conferir contra
      // um cache — o erro de 03/08/2026, agora do lado do Badoo.
      if (!page.url().includes(chatId)) throw new Error('a aba mudou de conversa antes do envio; abortei sem mandar nada')
      const nomeAgora = await page.evaluate(() => document.querySelector('[data-qa="profile-info__name"]')?.textContent?.trim() || null)
      if (nomeAgora !== nome) throw new Error(`a conversa mudou de "${nome}" para "${nomeAgora}" antes do envio; abortei`)

      // O BANNER DE COOKIES FICA POR CIMA E COME O CLIQUE. Ele vive num iframe, então não
      // aparece em nenhuma checagem do documento principal — o erro que sai é "o iframe
      // intercepta pointer events", que não parece um problema de consentimento.
      await lidarComConsentimento(page).catch(() => {})
      if (await fecharPreviewPendente(page)) logEvent({ type: 'badoo_preview_pendente', channel: 'badoo', detail: 'havia uma pré-visualização aberta; fechei antes de começar' })

      // O ARQUIVO ENTRA PELO BOTÃO DO PRÓPRIO APP, não por um input escolhido a dedo. A página
      // tem mais de um `input[type=file]` (foto de perfil, álbum), e escrever no errado não dá
      // erro: simplesmente não acontece nada — foi o que travou a primeira tentativa. Pedindo
      // o seletor de arquivos ao clicar em "Adicionar foto", quem aponta o input é o site.
      // O input do compositor é o do `photo-form` — o único da página com accept de imagem.
      // Clicar no botão só ABRE o menu de multimídia; quem carrega o arquivo é o input.
      // ABRIR O MENU DE MULTIMÍDIA PRIMEIRO. O input do `photo-form` existe no DOM o tempo
      // todo, mas o app só liga o handler quando o compositor de multimídia está aberto —
      // escrever no input com o menu fechado não faz nada, sem erro nenhum. Foi a diferença
      // entre o diagnóstico (que abria o menu) e o envio (que não abria).
      await page.click(BOTAO_MULTIMIDIA, { timeout: 10_000 }).catch(() => {})
      await sleep(1200)
      const input = await page.waitForSelector(INPUT_FOTO, { timeout: 15_000, state: 'attached' })
      await input.setInputFiles({ name: imagem.file, mimeType: 'image/jpeg', buffer: bytes })

      // O ARQUIVO NÃO É O ENVIO. O Badoo abre uma PRÉ-VISUALIZAÇÃO em tela cheia com um botão
      // "Enviar" no topo — enquanto ninguém clica, nada sai. Era isto que faltava: o input
      // aceitava a foto, o site esperava a confirmação e o código esperava um comprovante que
      // nunca viria. Descoberto por captura de tela, não por adivinhação.
      // A PRÉ-VISUALIZAÇÃO. O Badoo troca a rota para /pt/multimedia/-/<chatId> e mostra a foto
      // com um "Enviar" no topo. Enquanto ninguém clica, nada sai — o input aceitar o arquivo
      // não é o envio.
      //
      // O clique é por TEXTO lido do DOM, não por seletor de texto do Playwright: o botão real
      // não casou com `:text-is("Enviar")` (o texto mora num filho), e o resultado foi uma
      // falha que parecia "o compositor quebrou" com a tela perfeita por trás.
      let apareceu = false
      for (let i = 0; i < 30 && !apareceu; i += 1) {
        apareceu = await page.evaluate(() => [...document.querySelectorAll('button,[role=button]')]
          .some((b) => (b.textContent || '').trim() === 'Enviar'))
        if (!apareceu) await sleep(500)
      }
      if (!apareceu) {
        await page.screenshot({ path: '/tmp/badoo-falha-preview.png' }).catch(() => {})
        throw new Error('a pré-visualização da foto não abriu (o Badoo mudou o compositor?)')
      }
      // Última conferência antes do clique irreversível: a rota do preview carrega o chatId.
      if (!page.url().includes(chatId)) throw new Error('a aba mudou de conversa com a foto já carregada; abortei sem enviar')
      const clicou = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button,[role=button]')].find((x) => (x.textContent || '').trim() === 'Enviar')
        if (!b) return false
        b.click()
        return true
      })
      if (!clicou) throw new Error('o botão Enviar sumiu entre achar e clicar; nada foi enviado')

      // Upload no CDN + envio levam mais que um punhado de segundos numa foto de 400 KB.
      for (let i = 0; i < 90 && !recibo; i += 1) await sleep(500)   // até 45 s pelo comprovante
    } finally {
      page.off('response', ouvinte)
    }
    if (!recibo) throw new Error('a foto foi colocada no chat mas o Badoo não confirmou o envio')

    const ts = Date.now()
    const messageId = `b:${recibo.uid || `foto:${ts}`}`
    addMessage({
      messageId, accountKey, personId, channel: 'badoo', direction: 'outgoing', text: '',
      media: { kind: 'image', saved: true, file: imagem.file, descricao: imagem.descricao, status: 'done' },
      ts, author,
    })
    marcarAutor({ channel: 'badoo', messageId: recibo.uid || '', author })
    bumpSavedImageUsage(imagem.id)
    logEvent({ type: author === 'ia' ? 'auto_sent_foto' : 'badoo_sent_foto', personId, channel: 'badoo',
      detail: `[foto:${imagem.shortcut}] para ${nome} (photo_id ${recibo.photoId})` })
    return { ok: true, uid: recibo.uid, photoId: recibo.photoId, para: nome, atalho: imagem.shortcut }
  })
}
