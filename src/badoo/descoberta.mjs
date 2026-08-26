// Descoberta no Badoo — começando pela fila de QUEM JÁ TE CURTIU (badoo.com/pt/liked-you).
//
// Por que essa fila e não o baralho: curtir de volta ali é match na hora, e ela não depende
// da cota diária de curtidas (em 26/07/2026 o baralho de Encontros voltou VAZIO — "você já
// não tem mais curtidas" — e a fila de curtidas estava lá, com 17 pessoas desbloqueadas).
//
// Como se age: o voto do Badoo (`server_encounters_vote`, tipo 80) é assinado e não dá pra
// forjar (docs/ENTENDIMENTO-BADOO.md §10). Então quem clica somos nós, no DOM deles — e os
// botões têm rótulo acessível estável, o que é melhor que classe CSS:
//   "Curtir de volta o perfil N de M"  |  "Não tenho interesse no perfil N de M"
//
// Duas travas herdadas do Tinder, iguais: `badoo_swipe_enabled` liga o agendador e
// `badoo_swipe_dry_run` é o modo sombra. Ambas nascem no lado seguro.
import { badooPage, badooExclusive, BADOO } from './browser.mjs'
import { lidarComConsentimento } from './dom.mjs'
import { getSetting, setSetting, logEvent, swipeSeen, recordSwipe, markSwipeSent } from '../core/db.mjs'
import { julgar, criteriosAtuais } from '../tinder/criteria.mjs'

const URL_CURTIDAS = `${BADOO}/pt/liked-you`
const idDoBadoo = (chave) => 'b:' + chave

// Ritmo humano: olhar um perfil leva tempo, e curtir leva mais que passar (é o que a pessoa
// pensa mais). Mesmos números do Tinder, que saíram do histograma real do dono.
const espera = (ms) => new Promise((r) => setTimeout(r, ms))
function tempoDeOlhada(decisao) {
  const base = decisao === 'like' ? 2600 : 1500
  const variacao = Math.random() * (decisao === 'like' ? 4200 : 2200)
  return Math.max(1200, Math.round(base + variacao))
}

// ---------------------------------------------------------------- leitura
// Lê os cartões da fila. Cada cartão vira um "rec" no formato que o julgador do Tinder já
// entende, pra os critérios do dono (idade, fotos, a regra de não deslizar em perfil trans)
// valerem igual nos dois canais — sem uma segunda régua pra manter.
// LER PELO PROTOCOLO, NÃO PELA TELA (26/07/2026, regra de implementação: "no WhatsApp precisamos ir
// ao nível proto binário pra conseguir o sticker animado; aqui algo semelhante funciona").
// Ele estava certo: a grade renderiza borrões e o clique no cartão devolve pra "você já não
// tem mais curtidas", mas a resposta que o app RECEBE (`client_user_list`, tipo 246) traz os
// 17 com id, álbum, contagem de fotos e o voto delas. Daí saem os NOMES.
//
// O que o protocolo NÃO desfaz (conferido, pra ninguém tentar de novo): a foto continua
// borrada. O `hidden` no caminho do CDN não é marca de bloqueio — é o caminho padrão de
// TODA foto do Badoo, inclusive a do próprio o dono. Quem borra é o servidor de imagem, pra
// as curtidas travadas. Rosto só com cota/Premium; nome e id, não.
//
// Um detalhe do formato deles: o `name` vem null nessa projeção, mas o álbum se chama
// "Fotos de <Nome>" — é de lá que sai o nome, sem inventar nada.
const nomeDoAlbum = (a) => {
  const m = String(a || '').match(/^Fotos de\s+(.+)$/i)
  return m ? m[1].trim() : null
}
const urlDeFoto = (u) => {
  if (!u) return null
  const s = String(u).replace(/__size__/g, '640x640')
  return s.startsWith('//') ? 'https:' + s : s
}

export async function lerCurtidas({ max = 40 } = {}) {
  return badooExclusive(async () => {
    const page = await badooPage()
    const pacotes = []
    const ouvinte = async (resp) => {
      if (!/mwebapi\.phtml/.test(resp.url())) return
      try { const j = await resp.json(); for (const m of j.body || []) if (m.client_user_list) pacotes.push(m.client_user_list) } catch { /* não-JSON */ }
    }
    page.on('response', ouvinte)
    await page.goto(URL_CURTIDAS, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForTimeout(3500)
    await lidarComConsentimento(page).catch(() => {})
    await page.waitForTimeout(4000)
    page.off('response', ouvinte)

    const doProtocolo = []
    for (const lista of pacotes) {
      for (const sec of lista.section || []) {
        for (const u of sec.users || []) {
          if (doProtocolo.length >= max) break
          const album = u.albums?.[0]
          doProtocolo.push({
            indice: doProtocolo.length + 1,
            userId: u.user_id,
            nome: nomeDoAlbum(album?.name) || u.name || null,
            idade: u.age || null,
            foto: urlDeFoto(u.profile_photo?.large_url || u.profile_photo?.preview_url),
            fotos: (album?.photos || []).map((f) => urlDeFoto(f.large_url || f.preview_url)).filter(Boolean).slice(0, 8),
            quantasFotos: album?.count_of_photos || 0,
            curtiuVoce: !!u.their_vote,
            chave: u.user_id,
            texto: '',
          })
        }
      }
    }
    // O protocolo é a fonte. Só se ele vier vazio a gente cai na leitura da tela — e aí sim
    // vale saber se a tela está travada pelo paywall.
    if (doProtocolo.length) return { bloqueada: false, fonte: 'protocolo', fila: doProtocolo }
    // O paywall: sem cota de curtidas o Badoo BORRA as fotos de quem te curtiu e o clique no
    // cartão nem abre o perfil — devolve pra Encontros com "você já não tem mais curtidas"
    // (provado em 26/07/2026). Sem detectar isso, a tela mostraria 17 borrões como se fossem
    // pessoas e o julgador decidiria sobre nada.
    const bloqueada = await page.evaluate(() =>
      /revelar curtidas|obtenha curtidas ilimitadas|badoo premium/i.test(document.body.innerText || ''))
    const cru = await page.evaluate((teto) => {
      const cartoes = [...document.querySelectorAll('[data-qa="user-card"]')].slice(0, teto)
      return cartoes.map((c, i) => {
        const texto = (c.innerText || '').replace(/\s+/g, ' ').trim()
        const img = c.querySelector('img')
        const curtir = c.querySelector('[aria-label^="Curtir de volta"]') || document.querySelector(`[aria-label="Curtir de volta o perfil ${i + 1} de ${cartoes.length}"]`)
        return {
          indice: i + 1,
          texto: texto.slice(0, 160),
          foto: img ? img.src : null,
          bloqueado: !c.matches('[data-qa*="unlocked"], [data-qa="user-card"]') || /revelar/i.test(texto),
          rotuloCurtir: curtir ? curtir.getAttribute('aria-label') : null,
        }
      })
    }, max)
    return { bloqueada, fonte: 'tela', fila: cru.map((c) => ({ ...c, ...interpretaCartao(c) })) }
  })
}

// O cartão vem como um texto só ("Nome, 26 Cidade, Estado ..."). Extrair nome e idade daqui
// é determinístico e barato — nada de modelo pra ler duas palavras.
export function interpretaCartao(c) {
  const t = String(c.texto || '')
  const m = t.match(/^([^,\d]{2,30}?)[,\s]+(\d{2})\b/)
  const nome = m ? m[1].trim() : (t.split(/[,\d]/)[0] || '').trim() || null
  const idade = m ? Number(m[2]) : null
  const cidade = (t.match(/\b([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ú]+(?:\s[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ú]+)*),\s*(Paraná|São Paulo|Santa Catarina|Rio Grande do Sul|[A-ZÁÉÍÓÚ][\wÀ-ú]+)/) || [])[0] || null
  return { nome, idade, cidade, chave: `${nome || 'sem-nome'}|${idade || '?'}|${cidade || ''}` }
}

// Formato que o julgador do Tinder entende. O que o Badoo não dá (bio completa, selfie
// verificada, intenção) entra vazio — e vazio nunca reprova sozinho, só deixa de pontuar.
function comoRec(c) {
  const anoNasc = c.idade ? new Date().getFullYear() - c.idade : null
  return {
    distance_mi: null,
    user: {
      _id: c.chave, name: c.nome || '', bio: c.texto || '',
      birth_date: anoNasc ? `${anoNasc}-01-01` : null,
      photos: c.foto ? [{ id: 'capa' }] : [],
      badges: [], city: c.cidade ? { name: c.cidade } : null,
    },
  }
}

// ---------------------------------------------------------------- ação
// Clica pelo RÓTULO acessível, que é o que o Badoo mantém estável ("Curtir de volta o perfil
// N de M"). Índice muda quando a fila anda, então relemos antes de cada clique.
async function clicar(page, indice, total, acao) {
  const rotulo = acao === 'like'
    ? `Curtir de volta o perfil ${indice} de ${total}`
    : `Não tenho interesse no perfil ${indice} de ${total}`
  const alvo = page.locator(`[aria-label="${rotulo}"]`).first()
  if (!(await alvo.count())) return { ok: false, motivo: 'botão não está na tela' }
  const cx = await alvo.boundingBox()
  if (!cx) return { ok: false, motivo: 'botão sem posição na tela' }
  await page.mouse.click(cx.x + cx.width / 2, cx.y + cx.height / 2)
  return { ok: true, rotulo }
}

// Abre o perfil de UMA da fila e lê o que a grade não mostra (nome, idade, cidade, bio,
// quantas fotos). É navegação: custa alguns segundos, então é sob demanda — a grade continua
// leve e o detalhe vem quando alguém (o dono ou o julgador) precisa dele.
export async function abrirPerfilDaCurtida({ indice = 1 } = {}) {
  return badooExclusive(async () => {
    const page = await badooPage()
    if (!page.url().includes('liked-you')) {
      await page.goto(URL_CURTIDAS, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForTimeout(3000)
      await lidarComConsentimento(page).catch(() => {})
    }
    const cartoes = page.locator('[data-qa="user-card"]')
    const total = await cartoes.count()
    if (indice > total) return { erro: `só existem ${total} na fila` }
    const alvo = cartoes.nth(indice - 1)
    const cx = await alvo.boundingBox()
    if (!cx) return { erro: 'cartão sem posição na tela' }
    await page.mouse.click(cx.x + cx.width / 2, cx.y + cx.height / 2)
    await page.waitForTimeout(3500)
    const perfil = await page.evaluate(() => {
      const t = (document.body.innerText || '').replace(/\s+/g, ' ').trim()
      const fotos = [...document.querySelectorAll('img')].map((i) => i.src).filter((s) => /badoocdn/.test(s))
      return { url: location.href, texto: t.slice(0, 700), fotos: [...new Set(fotos)].slice(0, 12) }
    })
    // volta pra fila pra a próxima leitura começar do mesmo lugar
    await page.goto(URL_CURTIDAS, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForTimeout(2000)
    return { indice, ...perfil, ...interpretaCartao({ texto: perfil.texto }) }
  })
}

// Curtir ou passar UMA, na mão. O painel usa isto — e é o mesmo caminho que a sessão
// automática usa, então provar aqui prova os dois.
export async function agirNaCurtida({ indice = 1, acao = 'like' } = {}) {
  return badooExclusive(async () => {
    const page = await badooPage()
    if (!page.url().includes('liked-you')) {
      await page.goto(URL_CURTIDAS, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForTimeout(3000)
      await lidarComConsentimento(page).catch(() => {})
    }
    const total = await page.locator('[data-qa="user-card"]').count()
    const r = await clicar(page, indice, total, acao)
    if (r.ok) logEvent({ type: 'badoo_swipe', channel: 'badoo', detail: `${acao} manual no perfil ${indice} de ${total}` })
    await page.waitForTimeout(1500)
    const sobrou = await page.locator('[data-qa="user-card"]').count()
    return { ...r, antes: total, agora: sobrou }
  })
}

// ---------------------------------------------------------------- sessão
// Julga a fila inteira e age. `dryRun` (padrão) decide tudo e NÃO clica em nada — é assim que
// se confere o critério antes de gastar uma curtida que não volta.
export async function rodarSessaoCurtidas({ accountKey, max = 10, dryRun = true } = {}) {
  const sessionId = 'bs:' + Date.now().toString(36)
  const { fila, bloqueada } = await lerCurtidas({ max: 40 })
  // Fila bloqueada = fotos borradas e perfil que não abre: não há o que julgar, e decidir
  // sobre borrão seria pior que não decidir. Devolve o motivo em vez de inventar decisão.
  if (bloqueada) return { sessionId, fila: fila.length, decisoes: [], sombra: dryRun, bloqueada: true,
    motivo: 'o Badoo está escondendo quem te curtiu (sem cota de curtidas / sem Premium)' }
  const criterios = criteriosAtuais()
  const decisoes = []
  let agidas = 0

  for (const c of fila) {
    if (agidas >= max) break
    const userId = idDoBadoo(c.userId || c.chave)
    if (swipeSeen(userId, { enviado: true })) continue          // já deslizada de verdade
    const v = julgar(comoRec(c), criterios, { fonte: 'badoo-curtidas' })
    recordSwipe({
      userId, name: c.nome, age: c.idade, distance: null,
      decision: v.decisao, reason: v.motivo, layer: v.camada, score: v.pontos,
      source: 'badoo-liked-you', sessionId, payload: JSON.stringify({ texto: c.texto, cidade: c.cidade }),
    })
    decisoes.push({ nome: c.nome, idade: c.idade, decisao: v.decisao, motivo: v.motivo, indice: c.indice })
    agidas++
    if (dryRun) continue

    // fora da sombra: clica de verdade, relendo a fila (o índice anda a cada ação)
    const r = await badooExclusive(async () => {
      const page = await badooPage()
      if (!page.url().includes('liked-you')) {
        await page.goto(URL_CURTIDAS, { waitUntil: 'domcontentloaded' }).catch(() => {})
        await page.waitForTimeout(3000)
        await lidarComConsentimento(page).catch(() => {})
      }
      const total = await page.locator('[data-qa="user-card"]').count()
      await espera(tempoDeOlhada(v.decisao))
      return clicar(page, 1, total, v.decisao)     // a fila sempre anda pro topo
    })
    if (r.ok) {
      markSwipeSent(userId, { httpStatus: 200 })
      logEvent({ type: 'badoo_swipe', channel: 'badoo', detail: `${v.decisao} em ${c.nome || '?'} (${v.motivo})` })
    } else {
      logEvent({ type: 'badoo_swipe_erro', channel: 'badoo', detail: `${c.nome || '?'}: ${r.motivo}` })
      break                                        // a tela mudou: para e tenta na próxima
    }
  }
  return { sessionId, fila: fila.length, decisoes, sombra: dryRun }
}

// ---------------------------------------------------------------- agendador
export function estadoDescobertaBadoo() {
  return {
    ligado: !!getSetting('badoo_swipe_enabled', false),
    sombra: getSetting('badoo_swipe_dry_run', true) !== false,
    porSessao: Number(getSetting('badoo_swipe_por_sessao', 6)) || 6,
  }
}
export function ligarDescobertaBadoo({ ligado, sombra, porSessao }) {
  if (ligado != null) setSetting('badoo_swipe_enabled', !!ligado)
  if (sombra != null) setSetting('badoo_swipe_dry_run', !!sombra)
  if (porSessao != null) setSetting('badoo_swipe_por_sessao', Math.max(1, Math.min(20, Number(porSessao) || 6)))
  return estadoDescobertaBadoo()
}

let rodando = false
export async function badooSwipeTick({ accountKey } = {}) {
  const e = estadoDescobertaBadoo()
  if (!e.ligado || rodando) return null
  rodando = true
  try {
    const r = await rodarSessaoCurtidas({ accountKey, max: e.porSessao, dryRun: e.sombra })
    if (r.decisoes.length) {
      logEvent({ type: 'badoo_swipe_sessao', channel: 'badoo',
        detail: `${r.decisoes.length} decisões${e.sombra ? ' (sombra)' : ''} · ${r.decisoes.filter((d) => d.decisao === 'like').length} curtidas` })
    }
    return r
  } catch (err) {
    logEvent({ type: 'badoo_swipe_erro', channel: 'badoo', detail: err && err.message ? err.message : String(err) })
    return null
  } finally { rodando = false }
}
