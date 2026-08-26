// O QUE O INSTAGRAM SABE SOBRE O HUMANO.
//
// Ele abriu o pedido com isto: "o instagram tem coisas sobre mim, que são os vídeos
// curtidos, as coisas que eu gosto, pessoas que eu sigo". É uma fonte de gosto que nenhuma
// conversa dá — o que ele SEGUE e o que ele CURTE é preferência revelada, não declarada.
//
// TÉCNICA: a mesma que destravou o Badoo. Em vez de raspar o DOM (frágil) ou forjar chamada
// (o Instagram assina), a gente navega no Chrome logado dele e ESCUTA as respostas que o
// app do Instagram recebe. São dados de API, limpos, e ninguém contorna proteção nenhuma —
// é o cliente deles trabalhando.
//
// EXTRAÇÃO GENÉRICA de propósito: em vez de casar endpoint por endpoint (que o Instagram
// renomeia sem avisar), a gente varre QUALQUER json que chegue procurando as duas formas
// que interessam — objeto de usuário (tem pk/username) e objeto de mídia (tem id/code e
// caption/owner). Assim uma troca de rota deles não quebra a coleta.
//
// LIMITE HONESTO: "vídeos curtidos" só aparece se a página de atividade renderizar; se o
// Instagram esconder atrás de mais cliques, a coleta volta só com o que veio. O retorno
// sempre diz QUANTO veio de cada tipo, pra ninguém confundir "não curte nada" com "não
// consegui ler".
import { igPage, igExclusive, closeModals, IG } from '../ig/browser.mjs'
import { db, logEvent, setSetting, getSetting } from '../core/db.mjs'

const AGORA = () => Date.now()

export function garantirTabela() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS ig_sinal (
      tipo TEXT,           -- segue | curtiu | salvou | sugerido
      ref TEXT,            -- id estável do lado do Instagram (pk do usuário, id da mídia)
      rotulo TEXT,         -- @username ou legenda curta
      meta_json TEXT,
      visto_em INTEGER,
      PRIMARY KEY (tipo, ref)
    );
    CREATE INDEX IF NOT EXISTS idx_ig_sinal_tipo ON ig_sinal(tipo, visto_em);
  `)
}

function guardar({ tipo, ref, rotulo, meta }) {
  if (!ref) return false
  try {
    db().prepare(`INSERT INTO ig_sinal(tipo,ref,rotulo,meta_json,visto_em) VALUES(?,?,?,?,?)
      ON CONFLICT(tipo,ref) DO UPDATE SET rotulo=COALESCE(excluded.rotulo,rotulo), meta_json=COALESCE(excluded.meta_json,meta_json), visto_em=excluded.visto_em`)
      .run(tipo, String(ref), rotulo || null, meta ? JSON.stringify(meta) : null, AGORA())
    return true
  } catch { return false }
}

// Varre um json de qualquer formato atrás das duas formas que interessam.
// `limite` existe porque a resposta do feed pode ser gigante e a recursão sem freio custa CPU.
function colher(no, achados, prof = 0) {
  if (!no || prof > 8 || achados.usuarios.length + achados.midias.length > 4000) return achados
  if (Array.isArray(no)) { for (const x of no) colher(x, achados, prof + 1); return achados }
  if (typeof no !== 'object') return achados

  // O TOTAL DECLARADO. Existe por causa de um erro meu (26/07/2026): capturei 121 contas de
  // uma lista de 4280 e RELATEI como se fossem todas. Sem o total, "quanto eu peguei" e
  // "quanto existe" são a mesma coisa aos olhos de quem lê — e afirmar parcial como total é
  // o pior tipo de mentira, porque parece um fato.
  //
  // Com o total na mão, todo relatório passa a ser "121 de 4280 (3%)" e a incompletude fica
  // impossível de esconder. É a mesma ideia do `semCarimbo` na autoria: o que não se sabe
  // aparece como não sabido.
  if (no.edge_follow?.count != null || no.following_count != null) {
    achados.totais.seguindo = no.edge_follow?.count ?? no.following_count
  }
  if (no.edge_followed_by?.count != null || no.follower_count != null) {
    // só do PERFIL DELE (tem media_count junto); follower_count solto é de outra pessoa
    if (no.media_count != null || no.edge_owner_to_timeline_media) achados.totais.seguidores = no.edge_followed_by?.count ?? no.follower_count
  }

  // usuário: pk + username é a assinatura do Instagram
  if (no.username && (no.pk || no.id || no.pk_id)) {
    achados.usuarios.push({
      ref: String(no.pk || no.pk_id || no.id),
      username: String(no.username),
      nome: no.full_name || null,
      verificado: !!no.is_verified,
      privado: !!no.is_private,
      seguidores: no.follower_count ?? null,
    })
  }
  // mídia: code (o shortcode da URL) + dono
  if (no.code && (no.id || no.pk) && (no.caption !== undefined || no.user || no.owner || no.media_type !== undefined)) {
    const cap = typeof no.caption === 'object' && no.caption ? no.caption.text : (typeof no.caption === 'string' ? no.caption : null)
    const dono = no.user?.username || no.owner?.username || null
    achados.midias.push({
      ref: String(no.id || no.pk),
      code: String(no.code),
      dono,
      // media_type 2 = vídeo/reel no Instagram; é o que ele chamou de "vídeos curtidos"
      video: no.media_type === 2 || !!no.video_versions || !!no.is_video,
      legenda: cap ? String(cap).slice(0, 300) : null,
      curtidas: no.like_count ?? null,
    })
  }
  for (const k of Object.keys(no)) colher(no[k], achados, prof + 1)
  return achados
}

// Navega e escuta. `paginas` é uma lista de {url, tipo, rolagens}.
const ROTEIRO = [
  { url: '/your_activity/interactions/likes/', tipo: 'curtiu', rolagens: 14, oQue: 'o que você curtiu' },
  { url: '/your_activity/interactions/reels_likes/', tipo: 'curtiu', rolagens: 10, oQue: 'reels que você curtiu' },
  { url: '/your_activity/saved/all-posts/', tipo: 'salvou', rolagens: 8, oQue: 'o que você salvou' },
  { url: '/your_activity/interactions/comments/', tipo: 'curtiu', rolagens: 6, oQue: 'onde você comentou' },
]

// Rolar de verdade numa página do Instagram. `mouse.wheel` sozinho não serve: a grade da
// atividade vive num CONTÊINER com scroll próprio, e a roda só empurra o que está debaixo
// do cursor. Então a gente rola os três: a janela, o contêiner mais alto com overflow, e a
// roda — e para cedo quando a altura para de crescer (senão são 14 esperas à toa).
async function rolarFundo(page, vezes, pausaMs = 1200) {
  let alturaAnterior = 0, parado = 0
  for (let i = 0; i < vezes; i++) {
    const altura = await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 0.9)
      // o maior elemento com rolagem própria é a grade
      let melhor = null, melhorAltura = 0
      for (const el of document.querySelectorAll('div,main,section')) {
        if (el.scrollHeight > el.clientHeight + 200 && el.scrollHeight > melhorAltura) { melhor = el; melhorAltura = el.scrollHeight }
      }
      if (melhor) melhor.scrollTop = melhor.scrollHeight
      return Math.max(document.body.scrollHeight, melhorAltura)
    }).catch(() => 0)
    await page.mouse.wheel(0, 1600).catch(() => {})
    await page.waitForTimeout(pausaMs)
    if (altura <= alturaAnterior) { if (++parado >= 3) break } else parado = 0
    alturaAnterior = altura
  }
}

// FALLBACK PELO DOM — e por que ele é legítimo aqui.
//
// A regra do projeto é API primeiro, DOM só quando não há API. As páginas de "sua atividade"
// são exatamente esse caso: o diagnóstico mostrou as quatro abrindo certo e devolvendo
// SEMPRE 3 mídias e 3 usuários — número idêntico em páginas de conteúdo diferente, ou seja,
// não é a atividade, é a barra lateral. A grade em si vem renderizada no HTML e nunca passa
// pela API. Então não existe resposta pra escutar; o dado só está no DOM.
//
// Pega o shortcode do link (/p/<code>/ e /reel/<code>/), que é o id estável do post no
// Instagram, e o @ do dono quando estiver visível. É pouco, mas é verdadeiro e não quebra
// quando eles trocarem o nome de uma classe.
async function colherDoDom(page) {
  return page.evaluate(() => {
    const out = []
    const vistos = new Set()
    for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
      const m = a.getAttribute('href')?.match(/\/(p|reel)\/([A-Za-z0-9_-]{5,})/)
      if (!m || vistos.has(m[2])) continue
      vistos.add(m[2])
      const img = a.querySelector('img')
      out.push({
        ref: m[2], code: m[2], video: m[1] === 'reel',
        // o alt da miniatura do Instagram costuma trazer "Foto de X em ..." ou a legenda
        legenda: img?.getAttribute('alt')?.slice(0, 300) || null,
        dono: (img?.getAttribute('alt') || '').match(/(?:de|by)\s+@?([A-Za-z0-9._]{2,30})/)?.[1] || null,
      })
    }
    return out
  }).catch(() => [])
}

export async function coletar({ username = null, roteiro = ROTEIRO, esperaMs = 4500 } = {}) {
  garantirTabela()
  return igExclusive(async () => {
    const page = await igPage()
    const total = { curtiu: 0, salvou: 0, segue: 0, sugerido: 0 }
    let vistosNaSessao = 0
    let totalDoDom = null
    const erros = []

    const escutar = async (destinoTipo, acao) => {
      const achados = { usuarios: [], midias: [], totais: {} }
      const ouvinte = async (resp) => {
        const u = resp.url()
        if (!/instagram\.com\/(api\/v1|graphql)/.test(u)) return
        try { colher(await resp.json(), achados) } catch { /* não-json ou já consumido */ }
      }
      page.on('response', ouvinte)
      try { await acao() } finally { page.off('response', ouvinte) }
      return achados
    }

    // 1) quem ele segue — a fonte mais estável de "o que eu gosto"
    if (username) {
      try {
        const a = await escutar('segue', async () => {
          // PRIMEIRO o perfil, DEPOIS a lista. É a página do perfil que devolve
          // `edge_follow.count` — o total declarado. Sem essa parada a coleta não tem contra
          // o que se medir e o relatório vira "121 contas" em vez de "121 de 4280". Foi
          // exatamente esse buraco que me fez afirmar um parcial como total.
          await page.goto(`${IG}/${username}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
          await page.waitForTimeout(2500)
          // O total também está ESCRITO no cabeçalho ("4.280 seguindo"). A API mudou de forma
          // e parou de entregar edge_follow.count por aqui; o número na tela não mudou em anos
          // e é a mesma verdade. Ler os dois e ficar com o que vier é mais robusto que torcer.
          totalDoDom = await page.evaluate(() => {
            const txt = document.body.innerText || ''
            const m = txt.match(/([\d.,]+)\s*(seguindo|following)/i)
            if (!m) return null
            const n = Number(String(m[1]).replace(/[.,]/g, ''))
            return Number.isFinite(n) && n > 0 ? n : null
          }).catch(() => null)
          await page.goto(`${IG}/${username}/following/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
          await page.waitForTimeout(esperaMs)
          await closeModals(page).catch(() => {})
          await rolarFundo(page, 10, 1100)   // a lista de "seguindo" é virtualizada num modal
        })
        const vistos = new Set()
        for (const u of a.usuarios) {
          if (vistos.has(u.ref) || u.username === username) continue
          vistos.add(u.ref)
          if (guardar({ tipo: 'segue', ref: u.ref, rotulo: '@' + u.username, meta: u })) total.segue++
        }
        // o total declarado pelo próprio Instagram: é contra ele que a captura é medida
        const totalSeguindo = a.totais.seguindo ?? totalDoDom
        if (totalSeguindo != null) setSetting('ig_total_seguindo', totalSeguindo)
        if (a.totais.seguidores != null) setSetting('ig_total_seguidores', a.totais.seguidores)
        vistosNaSessao = vistos.size
      } catch (e) { erros.push(`seguindo: ${e.message}`) }
    }

    // 2) curtidas e salvos
    // `diagnostico` existe porque este é o pedaço frágil: o Instagram muda as páginas de
    // "sua atividade" com frequência e uma coleta vazia pode significar três coisas muito
    // diferentes — a URL não existe mais, existe mas não chama API, ou existe e ele não
    // curtiu nada. Sem registrar a URL final e o que veio, as três viram "0" e ninguém
    // sabe se é limitação ou verdade.
    const diagnostico = []
    for (const r of roteiro) {
      try {
        const a = await escutar(r.tipo, async () => {
          await page.goto(IG + r.url, { waitUntil: 'domcontentloaded' }).catch(() => {})
          await page.waitForTimeout(esperaMs)
          await closeModals(page).catch(() => {})
          await rolarFundo(page, r.rolagens || 6)
        })
        // API + DOM: o que a API deu (pouco, nessas páginas) mais o que só existe no HTML.
        const doDom = await colherDoDom(page)
        for (const m of [...a.midias, ...doDom]) {
          if (guardar({ tipo: r.tipo, ref: m.ref, rotulo: m.legenda || (m.dono ? '@' + m.dono : m.code), meta: m })) total[r.tipo]++
        }
        // usuários que aparecem nessas páginas são donos do conteúdo que ele consome
        for (const u of a.usuarios) guardar({ tipo: 'sugerido', ref: u.ref, rotulo: '@' + u.username, meta: u })
        const urlFinal = page.url()
        diagnostico.push({
          pagina: r.oQue, pedi: r.url, cheguei: urlFinal.replace(IG, ''),
          midiasVistas: a.midias.length, midiasNoDom: (await colherDoDom(page)).length, usuariosVistos: a.usuarios.length,
          // a URL final diferente da pedida = o Instagram redirecionou (a página mudou de lugar)
          leitura: !urlFinal.includes(r.url.replace(/\/$/, ''))
            ? 'REDIRECIONOU — essa URL não existe mais nesse formato'
            : (a.midias.length ? 'ok' : 'a página abriu mas não pediu nada pra API (o conteúdo veio no HTML ou está atrás de mais cliques)'),
        })
      } catch (e) { erros.push(`${r.oQue}: ${e.message}`); diagnostico.push({ pagina: r.oQue, pedi: r.url, erro: e.message }) }
    }

    const declarado = getSetting('ig_total_seguindo', null)
    const noBanco = (() => { try { return db().prepare(`SELECT COUNT(*) n FROM ig_sinal WHERE tipo='segue'`).get().n } catch { return 0 } })()
    const cobertura = declarado ? { capturado: noBanco, existem: declarado, pct: +(noBanco / declarado * 100).toFixed(1) } : null
    logEvent({ type: 'ig_eu_coleta', channel: 'instagram', detail: JSON.stringify({ ...total, cobertura }) })
    return { total, cobertura, vistosNaSessao, erros, diagnostico, aviso: Object.values(total).every((n) => !n) ? 'não veio nada: ou a sessão do Instagram caiu, ou essas páginas mudaram de formato. Rode `node tools/eu.mjs sessoes` pra conferir a sessão.' : null }
  })
}

// ---------------------------------------------------------------- o retrato
// Determinístico, sem modelo no caminho: conta, agrupa e ordena. É o que o agente lê pra
// saber do que o dono gosta — e é barato o suficiente pra caber num prompt quando precisa.
export function retrato({ topo = 15 } = {}) {
  garantirTabela()
  const linha = (sql, ...p) => { try { return db().prepare(sql).all(...p) } catch { return [] } }
  const contagem = (tipo) => { try { return db().prepare(`SELECT COUNT(*) n FROM ig_sinal WHERE tipo=?`).get(tipo)?.n || 0 } catch { return 0 } }

  const segue = linha(`SELECT rotulo, meta_json FROM ig_sinal WHERE tipo='segue' ORDER BY visto_em DESC`)
  const curtiu = linha(`SELECT rotulo, meta_json FROM ig_sinal WHERE tipo='curtiu' ORDER BY visto_em DESC LIMIT 400`)

  // De quem ele mais curte: preferência revelada, mais forte que "seguir".
  const porDono = new Map()
  let videos = 0
  for (const c of curtiu) {
    let m = null; try { m = JSON.parse(c.meta_json || 'null') } catch { /* ignora */ }
    if (m?.video) videos++
    if (m?.dono) porDono.set(m.dono, (porDono.get(m.dono) || 0) + 1)
  }
  const maisCurtidos = [...porDono.entries()].sort((a, b) => b[1] - a[1]).slice(0, topo).map(([dono, n]) => `@${dono} (${n})`)

  // Palavras que se repetem nas legendas do que ele curte — sinal grosseiro de assunto.
  const PAREM = new Set(['para','com','uma','que','não','dos','das','por','como','mais','isso','você','este','esta','pelo','pela','está','são','tem','the','and','for','you','your','this','that','from','with'])
  const freq = new Map()
  for (const c of curtiu) {
    for (const w of String(c.rotulo || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/)) {
      if (w.length < 4 || PAREM.has(w)) continue
      freq.set(w, (freq.get(w) || 0) + 1)
    }
  }
  const assuntos = [...freq.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, topo).map(([w, n]) => `${w} (${n})`)

  // COBERTURA, não contagem. `capturei` e `existem` são coisas diferentes e nunca mais
  // podem ser lidas como a mesma. Ver o comentário do total declarado, lá em cima.
  const declarado = getSetting('ig_total_seguindo', null)
  const pego = contagem('segue')
  return {
    coletadoEm: (() => { try { return db().prepare(`SELECT MAX(visto_em) t FROM ig_sinal`).get()?.t || null } catch { return null } })(),
    seguindo: declarado
      ? { capturei: pego, existem: declarado, pct: +(pego / declarado * 100).toFixed(1), completo: pego >= declarado }
      : { capturei: pego, existem: null, aviso: 'não sei quantas existem no total — a coleta não passou pelo perfil dele' },
    quantos: { segue: contagem('segue'), curtiu: contagem('curtiu'), salvou: contagem('salvou') },
    videosEntreAsCurtidas: videos,
    quemEleSegue: segue.slice(0, topo).map((s) => s.rotulo),
    deQuemEleMaisCurte: maisCurtidos,
    assuntosQueSeRepetem: assuntos,
    comoAtualizar: 'POST /api/eu/instagram no painel, ou `node tools/eu.mjs gosto` pra só ler',
  }
}

// Texto compacto pro prompt — só quando o agente pedir.
export function comoTexto() {
  const r = retrato({ topo: 12 })
  if (!r.quantos.segue && !r.quantos.curtiu) return 'Ainda não coletei os sinais do Instagram dele (rode a coleta antes de afirmar qualquer coisa sobre o gosto dele).'
  const s = r.seguindo
  return [
    `GOSTO DO HUMANO, pelo Instagram (coletado ${r.coletadoEm ? new Date(r.coletadoEm).toISOString().slice(0, 10) : '?'}):`,
    // A primeira linha é a cobertura, e vem ANTES de qualquer conclusão de propósito: quem
    // ler isto tem que saber o tamanho da amostra antes de acreditar no resto.
    s.existem
      ? `- AMOSTRA: ${s.capturei} de ${s.existem} contas que ele segue (${s.pct}%)${s.completo ? ' — completo' : ' — PARCIAL, não tire conclusão de "ele só segue isso"'}`
      : `- AMOSTRA: ${s.capturei} contas capturadas; NÃO SEI quantas existem no total (${s.aviso})`,
    `- curtiu ${r.quantos.curtiu} posts capturados (${r.videosEntreAsCurtidas} são vídeo/reel); salvou ${r.quantos.salvou}`,
    r.deQuemEleMaisCurte.length ? `- curte mais: ${r.deQuemEleMaisCurte.join(', ')}` : null,
    r.assuntosQueSeRepetem.length ? `- assuntos que se repetem: ${r.assuntosQueSeRepetem.join(', ')}` : null,
    r.quemEleSegue.length ? `- segue, por exemplo: ${r.quemEleSegue.join(', ')}` : null,
    'Isto é preferência REVELADA (o que ele faz), não declarada. Vale mais que opinião dita, e menos que ele te corrigindo.',
  ].filter(Boolean).join('\n')
}
