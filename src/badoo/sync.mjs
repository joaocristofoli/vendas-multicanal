// Sincronização do Badoo. O truque que faz isto existir: em vez de forjar as chamadas da
// API (impossível — o `x-pingback` é uma assinatura do pedido, ver docs/ENTENDIMENTO-BADOO.md
// §10), a gente deixa o APP DELES fazer as chamadas no Chrome real e ESCUTA as respostas.
// Navegar pra /messages/<id> faz o app pedir a conversa; nós lemos o JSON que chega.
//
// Resultado: dados limpos de API (não raspagem de DOM), sem quebrar quando mudarem o HTML,
// e sem contornar proteção nenhuma — é o próprio cliente deles trabalhando.
import { badooPage, badooExclusive, BADOO } from './browser.mjs'
import { abrirLista, lidarComConsentimento } from './dom.mjs'
import { upsertBadooChat, badooChats, getBadooChat, addMessage, upsertPerson, linkIdentity,
  deleteChannelMessages, countChannelMessages, logEvent, reidentificarMensagem, marcarAutor,
  getSetting, setSetting, setBadooPerfil } from '../core/db.mjs'
import { colherDaMensagem } from '../bridge/hints.mjs'
import { splitIntoBubbles } from '../wa/send.mjs'

export const badooPersonId = (chatId) => 'b:' + chatId

// Uma conversa ainda desconhecida, mas que já tem prévia, também é novidade. Antes ela era
// gravada na lista, porém não entrava na fila de hidratação porque `antes` era nulo; assim o
// chat aparecia sem as mensagens até ser aberto manualmente ou cair numa rodada posterior.
export function conversaMudouNaLista(antes, { previa = null, lastTs = null } = {}) {
  if (!previa) return false
  if (!antes) return true
  return previa !== (antes.previa || null) || (lastTs || 0) > (antes.last_ts || 0)
}

// Escuta as respostas da API do Badoo enquanto `acao` roda. Devolve o que foi capturado.
async function ouvindo(page, acao) {
  const pacotes = []
  const ouvinte = async (resp) => {
    if (!/mwebapi\.phtml/.test(resp.url())) return
    try { const j = await resp.json(); for (const m of j.body || []) pacotes.push(m) } catch { /* não-JSON */ }
  }
  page.on('response', ouvinte)
  try { await acao() } finally { page.off('response', ouvinte) }
  return pacotes
}

// ---------------------------------------------------------------- lista de conversas
export async function sincronizarLista({ accountKey, esperaMs = 9000 } = {}) {
  return badooExclusive(async () => {
    const page = await badooPage()
    const pacotes = await ouvindo(page, async () => {
      await page.goto(`${BADOO}/pt/connections`, { waitUntil: 'domcontentloaded' }).catch(() => {})
      // O consentimento reaparece principalmente depois de reiniciar o navegador. Antes ele
      // só era removido DEPOIS de encerrar a escuta: a primeira rodada capturava zero, tirava
      // o banner e precisava esperar o próximo minuto. Mantém a escuta ligada enquanto o
      // banner sai, pois é justamente aí que o app finalmente pede `client_user_list`.
      await abrirLista(page).catch(() => {})
      await page.waitForTimeout(esperaMs)
    })
    const vistos = new Set()
    const mudaram = []
    let n = 0
    for (const m of pacotes) {
      const lista = m.client_user_list
      if (!lista) continue
      for (const sec of lista.section || []) for (const u of sec.users || []) {
        if (!u.user_id || vistos.has(u.user_id)) continue
        vistos.add(u.user_id)
        const foto = u.profile_photo?.preview_url || null
        const previa = u.display_message || null
        const lastTs = u.sort_timestamp ? u.sort_timestamp * 1000 : null
        // Quem mudou é decidido pela PRÉVIA, não só pelo relógio — mesma lição do Tinder
        // (docs/SYNC-INVARIANTES.md): o texto muda em casos em que o timestamp não mexe.
        const antes = getBadooChat(accountKey, u.user_id)
        if (conversaMudouNaLista(antes, { previa, lastTs })) mudaram.push(u.user_id)
        upsertBadooChat({
          accountKey, chatId: u.user_id, name: u.name || null, previa,
          foto: foto ? (foto.startsWith('//') ? 'https:' + foto : foto) : null,
          lastTs, unread: !!u.is_unread,
        })
        n++
      }
    }
    if (n) setSetting('badoo_ultimo_sync', Date.now())
    logEvent({ type: 'badoo_sync_lista', channel: 'badoo', detail: `${n} conversas${mudaram.length ? `, ${mudaram.length} com novidade` : ''}` })
    return { conversas: n, mudaram }
  })
}

// Lista + mensagens só das que mudaram. É este que o loop periódico chama: sincronizar tudo
// levaria minutos (cada conversa é uma navegação), e o preview já diz onde vale olhar.
// O laço das conversas roda FORA do `badooExclusive` de propósito: `sincronizarConversa`
// pega a mesma fila, e chamar de dentro travaria os dois (a fila esperando ela mesma).
export async function sincronizarNovidades({
  accountKey, max = 6, listaEsperaMs = 9000, conversaEsperaMs = 8000,
} = {}) {
  const lista = await sincronizarLista({ accountKey, esperaMs: listaEsperaMs })
  const feitas = []
  for (const chatId of (lista.mudaram || []).slice(0, max)) {
    try { feitas.push(await sincronizarConversa({ accountKey, chatId, esperaMs: conversaEsperaMs })) }
    catch (e) { logEvent({ type: 'badoo_erro', channel: 'badoo', detail: `${chatId}: ${e.message}` }) }
  }
  return { conversas: lista.conversas, mudaram: (lista.mudaram || []).length, detalhadas: feitas }
}

// ---------------------------------------------------------------- uma conversa
// Navega pra conversa e persiste as mensagens que o app receber. As mensagens do Badoo têm
// `uid` estável, então o dedupe é por id de verdade (nada de replace destrutivo como no
// Instagram) — e o histórico vai crescendo em vez de ser reescrito.
export async function sincronizarConversa({ accountKey, chatId, esperaMs = 8000 }) {
  return badooExclusive(async () => {
    const page = await badooPage()
    const pacotes = await ouvindo(page, async () => {
      await page.goto(`${BADOO}/messages/${chatId}`, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForTimeout(esperaMs)
    })
    return persistirConversa({ accountKey, chatId, pacotes })
  })
}

// Separado do navegador de propósito: dá pra testar a persistência com pacotes gravados.
export function persistirConversa({ accountKey, chatId, pacotes }) {
  const chat = (pacotes || []).map((m) => m.client_open_chat).find(Boolean)
  const msgs = chat?.chat_messages || []
  const personId = badooPersonId(chatId)
  const nome = chat?.chat_user?.name || getBadooChat(accountKey, chatId)?.name || null
  const meu = chat?.chat_instance?.uid ? null : null   // o "eu" vem do from_person_id das minhas msgs
  upsertPerson({ personId, accountKey, name: nome })
  linkIdentity({ accountKey, channel: 'badoo', channelId: chatId, personId, method: 'badoo' })

  // Quem sou eu nesta conversa: o remetente que NÃO é o chat_id da pessoa.
  const outro = String(chatId)
  let novas = 0
  for (const m of msgs) {
    if (!m || (!m.mssg && !m.image_url)) continue
    const daPessoa = String(m.from_person_id || '') === outro
    const ts = (m.date_modified || m.date_created || 0) * 1000 || Date.now()
    const texto = m.mssg || (m.image_url ? '[foto]' : '')
    // O que saiu daqui pode já estar no banco com id provisório (ver `enviar`): troca o id
    // pelo `uid` real antes de tentar inserir, senão a mesma mensagem entraria duas vezes.
    if (!daPessoa && m.uid) {
      reidentificarMensagem({ channel: 'badoo', personId, direction: 'outgoing', text: texto,
        desdeTs: ts - 15 * 60 * 1000, novoId: 'b:' + m.uid })
    }
    const inserida = addMessage({
      messageId: 'b:' + (m.uid || `${chatId}:${ts}`),
      accountKey, personId, channel: 'badoo',
      direction: daPessoa ? 'incoming' : 'outgoing',
      text: texto, ts,
    })
    if (inserida) {
      novas++
      // é aqui que o Badoo entra no sistema de identidade: o número que ela mandar vira hint
      if (daPessoa && texto) {
        try { colherDaMensagem({ accountKey, personId, channel: 'badoo', messageId: 'b:' + m.uid, text: texto, direction: 'incoming' }) }
        catch { /* colher nunca derruba o sync */ }
      }
    }
  }
  const ultima = msgs[msgs.length - 1]
  if (ultima) {
    upsertBadooChat({ accountKey, chatId, name: nome, previa: ultima.mssg || null,
      lastTs: (ultima.date_modified || ultima.date_created || 0) * 1000 || null, unread: false })
  }
  if (novas) logEvent({ type: 'badoo_sync_conversa', personId, channel: 'badoo', detail: `${novas} mensagens novas de ${nome || chatId}` })
  return { chatId, nome, mensagens: msgs.length, novas, total: countChannelMessages(personId, 'badoo') }
}

// ---------------------------------------------------------------- perfil da pessoa
// A IA do Badoo estava escrevendo às cegas: `generateDraft` era chamado SEM perfil, então o
// prompt dizia "Perfil conhecido: nenhum dado detalhado disponível" e ela só tinha o nome e o
// histórico pra puxar assunto (defeito apontado pelo dono, 26/07/2026). No Tinder ela recebe
// bio, cidade e idade desde sempre.
//
// O Badoo tem isso — só não está no DOM da conversa: vem no pacote `user` que o app recebe ao
// abrir a conversa, com `profile_fields` ("Sobre mim", "Localização atual", "Busco", "Filhos",
// "Aparência"...). Mesma técnica do resto: quem pede é o app deles, a gente escuta.
// Casar por `id` do campo, não por nome: o rótulo vem no idioma da conta ("About me" ou
// "Sobre mim", "Current location" ou "Localização atual") e casar por texto quebra quando o
// o dono troca o idioma. O id é estável — foi o que apareceu no pacote: id:'location'.
const ID_BIO = /^(about_me|about|bio)$/i
const ID_CIDADE = /^(location|current_location|city)$/i
const ID_TRABALHO = /^(work|job|occupation|profession)$/i
const ID_ESTUDO = /^(education|school|university)$/i
// o nome ainda serve de rede de segurança quando o id vier vazio ou desconhecido
const NOME_BIO = /sobre mim|about me/i
const NOME_CIDADE = /localiza|current location|lives in/i
const NOME_TRABALHO = /profiss|trabalh|\bwork\b|emprego/i
const NOME_ESTUDO = /educa|estud|school|university/i

export function perfilDoPacote(u) {
  if (!u) return null
  const campos = (u.profile_fields || []).map((f) => ({
    id: String(f.id || '').trim(),
    nome: String(f.name || '').trim(),
    valor: String(f.display_value ?? f.value ?? '').trim(),
  })).filter((c) => (c.nome || c.id) && c.valor && c.valor !== 'None')
  const acha = (reId, reNome) => campos.find((c) => (c.id && reId.test(c.id)) || (c.nome && reNome.test(c.nome)))?.valor || null
  const album = u.albums?.[0]
  return {
    age: u.age || null,
    city: acha(ID_CIDADE, NOME_CIDADE),
    bio: acha(ID_BIO, NOME_BIO),
    work: acha(ID_TRABALHO, NOME_TRABALHO),
    education: acha(ID_ESTUDO, NOME_ESTUDO),
    verified: (u.system_badges || []).length ? true : null,
    // tudo que sobra vira "detalhes": é o material bruto pra puxar assunto (Busco, Filhos,
    // Cigarros, Signo, Idiomas...). Guardar como "nome: valor" mantém o sentido.
    details: campos
      .filter((c) => ![[ID_BIO, NOME_BIO], [ID_CIDADE, NOME_CIDADE], [ID_TRABALHO, NOME_TRABALHO], [ID_ESTUDO, NOME_ESTUDO]]
        .some(([ri, rn]) => (c.id && ri.test(c.id)) || (c.nome && rn.test(c.nome))))
      .map((c) => `${c.nome || c.id}: ${c.valor}`).slice(0, 14),
    interests: (u.interests || []).map((i) => i.name).filter(Boolean).slice(0, 12),
    fotos: album?.count_of_photos || 0,
    lidoEm: Date.now(),
  }
}

// Abre a conversa e captura o perfil que o app recebe junto. Guarda no banco pra a IA não
// pagar uma navegação por mensagem.
export async function lerPerfil({ accountKey, chatId, esperaMs = 8000 }) {
  return badooExclusive(async () => {
    const page = await badooPage()
    // PASSO 1: abrir a conversa dá o `chat_user` — e é dele que sai o user_id DELA. Só que
    // essa projeção traz UM campo (location): nada de bio. Foi o que me fez dizer que a Madu
    // "não tinha perfil", com a bio dela inteira na tela do dono (erro meu, 26/07/2026).
    const daConversa = await ouvindo(page, async () => {
      await page.goto(`${BADOO}/messages/${chatId}`, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForTimeout(esperaMs)
    })
    const chat0 = daConversa.map((m) => m.client_open_chat).find(Boolean)
    const idDela = chat0?.chat_user?.user_id ? String(chat0.chat_user.user_id) : String(chatId)

    // PASSO 2: o perfil COMPLETO vem de /profile/<user_id> — o app pede server_get_user e a
    // resposta traz About me, Relationship, Kids, Smoking, Drinking... o material de assunto.
    // Cuidado: nessa navegação vêm VÁRIOS pacotes `user`, inclusive o do próprio o dono. Casar
    // pelo id é obrigatório; sem isso a IA lê a bio dele achando que é a dela.
    const doPerfil = await ouvindo(page, async () => {
      await page.goto(`${BADOO}/profile/${idDela}`, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForTimeout(6000)
    })
    const pacotes = [...daConversa, ...doPerfil]
    // O perfil DELA vem no `chat_user` do client_open_chat. Pegar "qualquer pacote user" era
    // errado e deu no pior tipo de erro: o app manda o MEU perfil junto (client_login_success),
    // então a IA ia conversar com a Madu lendo a bio do próprio o dono. O id da conversa não é o
    // id dela — por isso o casamento tem que ser pelo chat_user, não pelo chatId.
    const dela = chat0?.chat_user || null
    // o `user` DELA (casado pelo id) ganha do mini-perfil: é ele que tem a bio
    const completo = pacotes.map((m) => m.user).find((u) => u && String(u.user_id || '') === idDela)
    const perfil = perfilDoPacote(completo && (completo.profile_fields || []).length > (dela?.profile_fields || []).length ? completo : (completo || dela))
    if (perfil) {
      setBadooPerfil(accountKey, chatId, perfil)
      logEvent({ type: 'badoo_perfil', channel: 'badoo', detail: `${chatId}: ${[perfil.city, perfil.bio && 'bio', `${perfil.details.length} detalhes`].filter(Boolean).join(', ')}` })
    }
    return perfil
  })
}

// ---------------------------------------------------------------- envio
// Escreve no composer da conversa aberta. O envio é o único lugar onde o DOM é inevitável —
// mas é o caminho mais simples do fluxo: um campo e um Enter.
//
// Duas armadilhas provadas ao vivo (25→26/07/2026), e o motivo de o código não ser 3 linhas:
//
// 1. O CMP de cookies (iframe do SourcePoint) fica POR CIMA do composer e ENGOLE o clique —
//    o Playwright achava o textarea, via ele "visível e estável", e o clique morria no
//    iframe. `abrirLista` já tratava o banner; o envio não, e era só isso.
// 2. O comprovante honesto não é o pacote de eco: é a mensagem VOLTAR nos dados do Badoo.
//    Por isso o envio relê a conversa e procura o próprio texto — e é dessa releitura que
//    sai o `uid` real, que substitui o id provisório da bolha otimista.
// 3. Quebra de linha no rascunho é BOLHA, não caractere. Digitar "\n" no composer do Badoo
//    é apertar Enter, e Enter manda: o texto se partia sozinho, no lugar errado, e ainda
//    comia as primeiras letras da segunda parte (o app engole teclado logo depois de enviar).
//    Aconteceu de verdade em 26/07: "E cuidar dos sobrinhos" chegou como "E dos sobrinhos",
//    e o painel ficou com uma bolha-fantasma juntando as duas. Quem divide agora é isto aqui,
//    de propósito e com respiro entre as bolhas — mesmo comportamento do WhatsApp e do Tinder.
export function bolhasParaEnviar(texto) {
  return splitIntoBubbles(texto, 4)
    .map((b) => String(b).replace(/\s*\n+\s*/g, ' ').trim())   // nenhum \n pode chegar no teclado
    .filter(Boolean)
}

export async function enviar({ accountKey, chatId, texto, author = null }) {
  return badooExclusive(async () => {
    const page = await badooPage()
    const url = `${BADOO}/messages/${chatId}`
    if (!page.url().includes(chatId)) {
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForTimeout(5000)
    }
    await lidarComConsentimento(page).catch(() => {})   // sem isto, o clique não chega no campo

    const bolhas = bolhasParaEnviar(texto)
    if (!bolhas.length) throw new Error('nada pra enviar')
    const personId = badooPersonId(chatId)
    const ts = Date.now()

    for (const [i, bolha] of bolhas.entries()) {
      // o composer se remonta a cada envio: reprocura o campo em vez de guardar o locator
      const campo = page.locator('textarea[data-qa="chat-input-textarea"], textarea, [contenteditable="true"]').first()
      if (!(await campo.count())) throw new Error('não achei o campo de escrever na conversa')
      try {
        await campo.click({ timeout: 8000 })
      } catch {
        // Se ainda houver camada por cima, foca por dentro da página: o teclado segue o foco,
        // não o ponteiro. Preferir o clique real quando dá (o app deles escuta ponteiro).
        await campo.evaluate((el) => el.focus()).catch(() => {})
      }
      await page.keyboard.type(bolha, { delay: 25 })
      await page.waitForTimeout(400)
      await page.keyboard.press('Enter')
      // Respiro depois do Enter. Sem ele o app come as primeiras letras da bolha seguinte —
      // foi exatamente assim que "cuidar" desapareceu. Jitter porque humano não é metrônomo.
      await page.waitForTimeout(i < bolhas.length - 1 ? 1400 + Math.floor(Math.random() * 900) : 2500)
    }

    // Releitura ÚNICA no fim: é ela que traz a conversa com os uid reais das minhas bolhas.
    const pacotes = await ouvindo(page, async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForTimeout(6000)
    })
    const chat = pacotes.map((m) => m.client_open_chat).find(Boolean)
    const minhas = (chat?.chat_messages || []).filter((m) => String(m.from_person_id || '') !== String(chatId))
    if (chat) persistirConversa({ accountKey, chatId, pacotes })   // grava tudo com uid real

    // Comprovante por bolha: cada uma tem que ter voltado nos dados do servidor deles.
    const achadas = []
    for (const bolha of bolhas) {
      const m = minhas.filter((x) => (x.mssg || '') === bolha).pop()
      if (m) { achadas.push(m.uid); if (author) marcarAutor({ channel: 'badoo', messageId: 'b:' + m.uid, author }) }
    }
    const comprovado = achadas.length === bolhas.length

    // O que não voltou entra com id provisório, POR BOLHA (nunca o texto inteiro junto: era a
    // bolha-fantasma). O próximo sync troca o id pelo real via reidentificarMensagem.
    if (!comprovado) {
      bolhas.forEach((bolha, i) => {
        const jaEsta = minhas.some((x) => (x.mssg || '') === bolha)
        if (jaEsta) return
        addMessage({ messageId: 'b:out:' + (ts + i), accountKey, personId, channel: 'badoo', direction: 'outgoing', text: bolha, ts: ts + i, author })
      })
      upsertBadooChat({ accountKey, chatId, previa: bolhas[bolhas.length - 1], lastTs: ts, unread: false })
    }
    logEvent({
      type: comprovado ? 'badoo_enviado' : 'badoo_enviado_sem_comprovante',
      personId, channel: 'badoo',
      detail: bolhas.join(' | ') + (bolhas.length > 1 ? ` (${bolhas.length} bolhas)` : ''),
    })
    return { ok: true, comprovado, bolhas: bolhas.length, uids: achadas, ts }
  })
}

// Estado do canal SEM chamar a API assinada. A checagem antiga (`checarSessao`) usa o caminho
// HTTP direto, que não funciona por desenho (o `x-pingback` é assinado no JS deles) — ela
// respondia EXPIRED com a sessão viva, um falso negativo que ia direto pra tela. Aqui o
// estado sai do que o sistema PROVOU: a última lista que voltou de verdade.
export function estadoBadoo(accountKey) {
  const ultimo = Number(getSetting('badoo_ultimo_sync', 0)) || 0
  const conversas = badooChats(accountKey).length
  if (!getSetting('badoo_cookies', null)) return { status: 'IDLE', conversas: 0, ultimoSync: null }
  if (!ultimo) return { status: 'PENDENTE', conversas, ultimoSync: null }
  // 6h sem uma lista boa é sinal de sessão caída (o tick roda de 5 em 5 minutos)
  return { status: Date.now() - ultimo < 6 * 3600e3 ? 'CONNECTED' : 'ATENCAO', conversas, ultimoSync: ultimo }
}

// Sincroniza as N conversas mais recentes que têm prévia (as que têm conversa de verdade).
export async function sincronizarRecentes({ accountKey, max = 5 }) {
  const alvos = badooChats(accountKey).filter((c) => c.previa).slice(0, max)
  const feitas = []
  for (const c of alvos) {
    try { feitas.push(await sincronizarConversa({ accountKey, chatId: c.chat_id })) }
    catch (e) { logEvent({ type: 'badoo_erro', channel: 'badoo', detail: `${c.name}: ${e.message}` }) }
  }
  return feitas
}
