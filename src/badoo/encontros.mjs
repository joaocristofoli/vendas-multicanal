// Deslizar no Badoo — o baralho de ENCONTROS (não a fila de quem te curtiu, que é o
// descoberta.mjs). Aqui é o swipe normal: passar pra esquerda, curtir pra direita.
//
// TRÊS COISAS APRENDIDAS APANHANDO, e que este módulo existe pra não repetir:
//
// 1. O VOTO NÃO É FORJÁVEL. `server_encounters_vote` (tipo 80) vai assinado, então não dá
//    pra chamar por HTTP como se faz com as mensagens. Curtir é CLIQUE no DOM. As âncoras
//    são `data-qa` e são estáveis: `profile-card-action-vote-yes` / `-vote-no` / `-crush`.
//
// 2. "O CLIQUE DEU OK" NÃO É PROVA DE NADA. Em 27/07/2026 dois cliques voltaram `ok:true`
//    e nada aconteceu: havia um modal (`modal-container`, z-index 999) por cima. A prova de
//    que o voto SAIU é a requisição com o cabeçalho `x-message-type: 80` — é isso que este
//    módulo conta. Antes de mirar, `elementFromPoint` confirma que quem está no ponto do
//    clique é o botão, e não um overlay.
//
// 3. A ABA É UMA SÓ E TEM DONO. O `badooExclusive` só serializa DENTRO de um processo. Um
//    script rodando por fora disputa o Chrome com o sync do vendas-multicanal-core e navega a aba por
//    baixo — foi assim que o voto acabou caindo numa tela de conversa. Por isso este módulo
//    roda no processo do vendas-multicanal-core e é chamado por rota, nunca por script solto.
//
// Quem está no topo do baralho é o PROTOCOLO que diz (`client_encounters.results[]`, o
// primeiro com `has_user_voted:false`), não o texto da tela: os botões ficam numa barra
// global, fora do cartão, e o corpo da página mistura o perfil aberto com o de trás.
import { badooPaginaPropria, BADOO } from './browser.mjs'
import { lidarComConsentimento } from './dom.mjs'
import { detectaMarcador } from '../tinder/criteria.mjs'
import { logEvent, getSetting, setSetting } from '../core/db.mjs'

const URL_ENCONTROS = `${BADOO}/encounters`
const QA = { nao: 'profile-card-action-vote-no', sim: 'profile-card-action-vote-yes', crush: 'profile-card-action-crush' }

// ---------------------------------------------------------------- ritmo
// ALVO: 20 a 50 curtidas por minuto (regra do sistema, 27/07/2026), MAS nunca de forma
// regular. O que denuncia robô não é a velocidade — é a REGULARIDADE. Um intervalo cravado
// de 2 segundos, quarenta vezes seguidas, é mais suspeito que a velocidade em si.
//
// Três coisas se somam:
//   1. sorteio log-normal do intervalo — muitos rápidos, poucos bem mais lentos, que é a cara
//      de quem desliza (rápido, rápido, rápido, aí para pra olhar um perfil);
//   2. distração: de vez em quando dá uma parada de alguns segundos;
//   3. cansaço: dentro de uma tirada os intervalos vão crescendo.
//
// Nesta faixa as distrações precisam ser CURTAS e RARAS: uma pausa de 2 minutos a cada 18
// votos, que era o certo pra 4/min, sozinha comeria a média inteira aqui.
// Calibrado por simulação em tests-tim/badoo-ritmo.mjs, que reprova se sair da faixa.
export const RITMO_PADRAO = {
  medianaMs: 1250,        // o intervalo típico
  espalhamento: 0.55,     // sigma do log-normal: quanto os tempos variam entre si
  pisoMs: 600,            // ninguém clica mais rápido que isso de forma sustentada
  tetoMs: 15000,
  chanceDistracao: 0.02,  // uma em 50
  distracaoMs: [6000, 40000],
  cansacoAte: 1.4,        // no fim da tirada os intervalos estão ~40% mais longos
}

// O ritmo em vigor. O dono mexe nele pela tela — o que ele muda é o intervalo TÍPICO
// (a mediana); o espalhamento, a distração e o cansaço continuam por cima, senão o ritmo
// vira metrônomo e é isso que denuncia robô.
export function ritmoAtual() {
  const salvo = getSetting('badoo_encontros_ritmo', null) || {}
  const r = { ...RITMO_PADRAO, ...salvo }
  // pisos de sanidade: nem o dono consegue pedir 50ms
  r.medianaMs = Math.max(400, Math.min(Number(r.medianaMs) || RITMO_PADRAO.medianaMs, 120000))
  r.pisoMs = Math.max(250, Math.min(Number(r.pisoMs) || RITMO_PADRAO.pisoMs, r.medianaMs))
  return r
}
// mantido pra quem já importava o nome (o teste de ritmo, por exemplo)
export const RITMO = RITMO_PADRAO

// Log-normal por Box-Muller: a distribuição que dá "muitos curtos, poucos longos".
function logNormal(medianaMs, sigma, rnd) {
  const u1 = Math.max(rnd(), 1e-9), u2 = rnd()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return medianaMs * Math.exp(sigma * z)
}

// Quanto esperar antes do PRÓXIMO voto. `passo`/`total` dão o cansaço dentro da tirada.
export function pausaHumana(decisao, { passo = 0, total = 20, rnd = Math.random, r = null } = {}) {
  r = r || ritmoAtual()
  if (rnd() < r.chanceDistracao) {
    return Math.round(r.distracaoMs[0] + rnd() * (r.distracaoMs[1] - r.distracaoMs[0]))
  }
  const cansaco = 1 + (r.cansacoAte - 1) * (total > 1 ? passo / (total - 1) : 0)
  // passar é mais rápido que curtir: a decisão de descartar sai antes
  const peso = decisao === 'like' ? 1 : 0.72
  const bruto = logNormal(r.medianaMs, r.espalhamento, rnd) * cansaco * peso
  return Math.round(Math.min(Math.max(bruto, r.pisoMs), r.tetoMs))
}

// O que o protocolo entrega de cada pessoa, no formato que o julgador do Tinder entende.
// Só os campos de texto interessam pro detector — ele varre nome, bio e afins.
export function comoRec(u = {}) {
  const perfil = []
  for (const s of u.profile_fields || u.profile_sections || []) {
    if (s?.display_value) perfil.push(String(s.display_value))
    if (s?.name) perfil.push(String(s.name))
    for (const f of s?.fields || []) if (f?.display_value) perfil.push(String(f.display_value))
  }
  return {
    _id: u.user_id,
    name: u.name || null,
    birth_date: null,
    age: u.age || null,
    bio: [u.profile_summary, u.about_me_short, u.about_me, ...perfil].filter(Boolean).join(' \n '),
    city: { name: u.home_town_name || u.city_name || null },
    photos: (u.albums?.[0]?.photos || []).map((f) => ({ url: f.large_url || f.preview_url })),
    // o que o Badoo chama de gênero declarado, quando vem
    custom_gender: u.gender_custom || u.gender_str || null,
    selfie_verified: !!u.is_verified,
  }
}

// A ÚNICA regra de recusa combinada com o dono no Badoo (27/07/2026): não curtir perfil
// trans. No resto, curtir — ele paga o premium justamente pra usar a cota. O detector é o
// mesmo do Tinder, com fronteira de palavra: "trans" cru reprovaria quem trabalha com
// transporte, tem transtorno de ansiedade ou está em transição de carreira.
export function decidir(rec) {
  const m = detectaMarcador(rec)
  if (m.bate) return { decisao: 'pass', motivo: `marcador em ${m.onde} (${m.motivo})`, trecho: m.trecho }
  return { decisao: 'like', motivo: 'sem restrição' }
}

// Derruba o que estiver por cima. Duas coisas diferentes atrapalham e as duas voltam
// sozinhas: o modal interno do app (z-index 999) e o banner de consentimento, que vive num
// IFRAME em cima da tela inteira — foi ele que fez o `elementFromPoint` responder "IFRAME"
// no lugar do botão. Por isso isto roda antes de CADA voto, não uma vez no começo.
async function limparTela(page) {
  await lidarComConsentimento(page).catch(() => {})
  const n = await page.evaluate(() => {
    const alvos = [...document.querySelectorAll('[data-qa="modal-close"], [data-qa="modal-action-cancel"], .csms-modal__shadow, [data-qa="modal-navigation"] button')]
    alvos.forEach((b) => { try { b.click() } catch { /* botão sumiu no meio */ } })
    // O IFRAME DE CONSENTIMENTO (consent.badoo.com) fica esticado por cima da barra de voto
    // mesmo sem banner nenhum visível — `elementFromPoint` respondia IFRAME no lugar do botão
    // e NENHUM gatilho funcionava (clique normal, forçado, evento sintético, teclado).
    // O detector de banner não o reconhece porque ele não tem o texto de consentimento.
    // Some com quem estiver cobrindo o botão; é por carga de página, não muda a sessão.
    // Quem intercepta é o CONTAINER do Sourcepoint (`#sp_message_container_*`, um
    // role=dialog aria-modal), não o iframe de dentro: esconder só o iframe não adiantou e o
    // Playwright continuou dizendo que o clique era interceptado. Some com o container
    // inteiro, e de quebra com qualquer outro elemento esticado por cima do botão.
    let escondidos = 0
    const some = (n) => { n.style.setProperty('display', 'none', 'important'); escondidos++ }
    for (const n of document.querySelectorAll('[id^="sp_message_container"], [id^="sp_message_iframe"]')) some(n)
    const alvoBotao = document.querySelector('[data-qa="profile-card-action-vote-yes"]')
    const r = alvoBotao ? alvoBotao.getBoundingClientRect() : null
    if (r) {
      const meio = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      // ainda tem alguém no caminho que não é o botão? sobe até o bloco e some com ele
      if (meio && !alvoBotao.contains(meio)) {
        let n = meio
        for (let i = 0; i < 4 && n && n !== document.body; i++) {
          const nr = n.getBoundingClientRect()
          if (nr.width > r.width * 2 && nr.height > r.height * 2) { some(n); break }
          n = n.parentElement
        }
      }
    }
    return alvos.length + escondidos
  }).catch(() => 0)
  if (n) await page.waitForTimeout(900)
  return n
}

// Clicar de verdade. Duas lições aqui:
//
// Mirar por coordenada calculada na mão NÃO funciona nesta tela: o botão tem um SVG dentro,
// existem cópias do mesmo `data-qa` no DOM (cartões empilhados) e o `elementFromPoint`
// respondia com um nó que não era descendente do botão escolhido — recusa por engano. Quem
// resolve isso é o próprio Playwright: `:visible` descarta as cópias escondidas, ele rola
// até o elemento e só clica quando dá pra clicar de verdade.
//
// E o juiz final NÃO é o clique: é o protocolo. `server_encounters_vote` é o tipo 80 e vai
// no cabeçalho `x-message-type` — se essa requisição não sai, não houve voto, por mais que
// o clique tenha "dado certo".
async function clicarVoto(page, qa) {
  // Existem DUAS cópias do mesmo `data-qa` na tela (cartões empilhados), quase no mesmo
  // lugar, e o `.first()` do Playwright vinha pegando a de trás: o clique era interceptado
  // pelo ícone da de cima e nada acontecia. Quem manda é o teste do próprio navegador —
  // clicar no botão cujo centro devolve ele mesmo (ou um filho dele) em `elementFromPoint`.
  const ponto = await page.evaluate((q) => {
    const todos = [...document.querySelectorAll(`[data-qa="${q}"]`)].filter((b) => b.offsetWidth || b.offsetHeight)
    for (const b of todos) {
      const r = b.getBoundingClientRect()
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2
      const alvo = document.elementFromPoint(cx, cy)
      if (alvo && (alvo === b || b.contains(alvo))) return { x: cx, y: cy }
    }
    // nenhum é dono do próprio centro: devolve quem está por cima, pra o erro dizer o nome
    const b = todos[todos.length - 1]
    if (!b) return null
    const r = b.getBoundingClientRect()
    const alvo = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return { bloqueado: alvo ? `${alvo.tagName}.${String(alvo.className?.baseVal ?? alvo.className ?? '').slice(0, 30)}` : 'nada' }
  }, qa)
  if (!ponto) return { ok: false, motivo: 'botão não está na tela' }
  if (ponto.bloqueado) return { ok: false, motivo: `algo por cima do botão (${ponto.bloqueado})` }
  await page.mouse.click(ponto.x, ponto.y)
  return { ok: true }
}

// O perfil que está na frente, lido da tela. O nome e a idade vêm do cabeçalho do cartão
// ("Fulana, 23"); o resto do texto entra inteiro no campo que o detector varre — é onde mora
// o "Sobre mim", que é justamente onde um marcador apareceria.
async function lerPerfilDaTela(page) {
  return page.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ').trim()
    // "Encontros Fulana, 23 ..." / "Encounters Fulana, 23 ..."
    const m = t.match(/(?:Encontros|Encounters)\s+(.{1,40}?),\s*(\d{2})\b/)
    return { nome: m ? m[1].trim() : null, idade: m ? Number(m[2]) : null, texto: t.slice(0, 1200) }
  })
}

// Uma sessão de deslizar. `dryRun` (padrão) decide tudo e NÃO clica — é assim que se
// confere o critério antes de gastar voto que não volta.
export async function deslizarEncontros({ quantos = 10, dryRun = true, accountKey = 'main', aoVotar = null } = {}) {
  // Aba PRÓPRIA, fora do mutex: a aba compartilhada é do sync, que a leva pra uma conversa
  // no meio da sessão. Ver `badooPaginaPropria` no browser.mjs.
  return (async () => {
    const page = await badooPaginaPropria()
    const votosQueSairam = []
    const baralhos = []
    const onReq = (req) => {
      if (!/mwebapi\.phtml/.test(req.url())) return
      if (req.headers()['x-message-type'] === '80') votosQueSairam.push(Date.now())
    }
    const onResp = async (resp) => {
      if (!/mwebapi\.phtml/.test(resp.url())) return
      try { const j = await resp.json(); for (const m of j.body || []) if (m.client_encounters) baralhos.push(m.client_encounters.results || []) } catch { /* não-JSON */ }
    }
    page.on('request', onReq)
    page.on('response', onResp)

    const decisoes = []
    let paradaPor = null
    try {
      // CHEGAR EM ENCONTROS, numa aba recém-criada.
      // Duas coisas aprendidas aqui: (1) `badoo.com/` é a página de MARKETING mesmo pra quem
      // está logado — cair nela parecia sessão deslogada e não era; (2) na aba compartilhada
      // o `goto('/encounters')` era desfeito quando o app terminava de subir e restaurava a
      // própria última rota. Em aba nova não há rota anterior pra restaurar, então ir direto
      // pra /encounters funciona. O app leva ~10s pra montar: espera o BOTÃO aparecer, não
      // um tempo fixo.
      const pronto = async () => (await page.locator(`[data-qa="${QA.sim}"]:visible`).count()) > 0
      await page.goto(`${BADOO}/encounters`, { waitUntil: 'domcontentloaded' }).catch(() => {})
      for (let t = 0; t < 60 && !(await pronto()); t++) await page.waitForTimeout(500)
      await limparTela(page)
      if (!(await pronto())) {
        return { dryRun, pedidas: quantos, decididas: 0, votosNoProtocolo: 0, curtidas: 0, passadas: 0,
          paradaPor: `não cheguei na tela de Encontros (parei em ${page.url().replace(BADOO, '')})`, decisoes: [] }
      }
      for (let i = 0; i < quantos; i++) {
        // Quem está na frente sai do DOM, não do protocolo: em aba nova o `client_encounters`
        // não reaparece (o app já tem o baralho em memória), e o perfil aberto na tela traz
        // nome, idade e o "Sobre mim" — que é tudo o que o detector precisa ler.
        const perfil = await lerPerfilDaTela(page)
        if (!perfil.nome && !perfil.texto) { paradaPor = 'não consegui ler o perfil na tela'; break }
        const rec = {
          name: perfil.nome, age: perfil.idade, bio: perfil.texto,
          city: { name: null }, photos: [], custom_gender: null,
        }
        const d = decidir(rec)

        if (dryRun) { decisoes.push({ n: i + 1, nome: rec.name, idade: rec.age, ...d, enviado: false }); continue }

        // A limpeza é CARA (varre todos os frames atrás do banner de consentimento) e a
        // 20-50 votos por minuto ela virava o gargalo: ~2,4s de custo mecânico por voto,
        // derrubando o ritmo real pra menos da metade do alvo. Só roda de vez em quando e
        // quando o clique falha — que é quando ela realmente serve pra alguma coisa.
        if (i % 15 === 0) await limparTela(page)
        const antes = votosQueSairam.length
        const qa = d.decisao === 'like' ? QA.sim : QA.nao
        // O app joga modal no meio da sessão (promo depois de algumas curtidas). Desistir na
        // primeira recusa parava a rodada no 4º voto; limpar e tentar de novo resolve, e só
        // se insistir três vezes é que tem coisa de verdade no caminho.
        let clique = { ok: false, motivo: 'não tentou' }
        for (let tentativa = 1; tentativa <= 3; tentativa++) {
          // o app busca mais perfis de vez em quando e a barra de voto some por alguns
          // segundos; nessa velocidade isso acontece toda hora. Esperar é o certo — desistir
          // matava a rodada no meio (parava no 19º de 40).
          for (let t = 0; t < 50 && !(await pronto()); t++) await page.waitForTimeout(200)
          clique = await clicarVoto(page, qa)
          if (clique.ok) break
          await limparTela(page)
          await page.waitForTimeout(1000)
        }
        if (!clique.ok) {
          paradaPor = `o botão não estava clicável: ${clique.motivo}`
          decisoes.push({ n: i + 1, nome: rec.name, idade: rec.age, ...d, enviado: false, erro: paradaPor })
          break
        }
        // o juiz é o protocolo: sem a requisição do tipo 80, não houve voto
        for (let t = 0; t < 25 && votosQueSairam.length === antes; t++) await page.waitForTimeout(200)
        const saiu = votosQueSairam.length > antes
        decisoes.push({ n: i + 1, nome: rec.name, idade: rec.age, ...d, enviado: saiu })
        if (!saiu) { paradaPor = 'o clique não virou voto no protocolo'; break }
        logEvent({ type: 'badoo_swipe', channel: 'badoo', detail: `${d.decisao} em ${rec.name || 'sem nome'} — ${d.motivo}` })
        // conta na hora: uma sessão dura minutos e o painel mostrava "0 de 600" o tempo todo
        if (aoVotar) { try { aoVotar(d) } catch { /* contador é bônus */ } }

        // ESPERAR O CARTÃO TROCAR, não um tempo fixo. Nessa velocidade o clique seguinte
        // chegava antes do próximo perfil montar e a rodada morria em "botão não está na
        // tela" no terceiro voto. A troca de nome é o sinal de que o baralho andou.
        const anterior = rec.name
        for (let t = 0; t < 30; t++) {
          const agora = await lerPerfilDaTela(page)
          if (agora.nome && agora.nome !== anterior) break
          await page.waitForTimeout(150)
        }
        await page.waitForTimeout(pausaHumana(d.decisao, { passo: i, total: quantos }))
      }
    } finally {
      page.off('request', onReq)
      page.off('response', onResp)
      // NÃO fecha: a aba é reaproveitada na próxima sessão. Fechar e recriar a cada volta foi
      // o que encheu o Chrome de abas e derrubou o envio de mensagem por timeout.
    }

    const feitas = decisoes.filter((d) => d.enviado)
    return {
      dryRun,
      pedidas: quantos,
      decididas: decisoes.length,
      // o que REALMENTE saiu, contado no protocolo — não o número de cliques
      votosNoProtocolo: votosQueSairam.length,
      curtidas: feitas.filter((d) => d.decisao === 'like').length,
      passadas: feitas.filter((d) => d.decisao === 'pass').length,
      paradaPor,
      decisoes,
    }
  })()
}

// ---------------------------------------------------------------- rodar sozinho
// O que faz isso virar automação em vez de um botão: um plano do dia com sessões em horários
// sorteados, e um tick que só age quando a hora chega. Mesmo desenho do deslizar do Tinder
// (`src/tinder/swipe.mjs`), pelo mesmo motivo — 40 curtidas de uma vez, todo dia no mesmo
// horário, é assinatura de robô; espalhar em 3-5 sessões é o que um humano faz.
//
// DOIS INTERRUPTORES, os dois no lado seguro por padrão:
//   badoo_encontros_enabled   liga o agendador (sem isso, o tick não faz nada)
//   badoo_encontros_sombra    decide tudo e NÃO clica (é o padrão, mesmo com o agendador ligado)
const TETOS_PADRAO = {
  sessoesPorDia: [3, 5],
  tamanhoSessao: [20, 45],
  tirada: [25, 70],     // tamanho de uma tirada no modo contínuo
  porDia: 600,          // teto duro de votos no dia
}
// Onde as sessões caem. Madrugada fora; pico no fim da tarde e à noite, como o histograma
// real do dono no Tinder.
const PESO_HORA = [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 3, 4, 4, 4, 5, 5, 6, 7, 9, 10, 10, 9, 6, 3]

const rndInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1))
const diaBrasilia = (ms = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
function agoraEmMinutosBrasilia(ms = Date.now()) {
  const f = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
  const [h, m] = f.split(':').map(Number)
  return h * 60 + m
}
function sorteiaHora() {
  const total = PESO_HORA.reduce((a, b) => a + b, 0)
  let x = Math.random() * total
  for (let h = 0; h < 24; h++) { x -= PESO_HORA[h]; if (x <= 0) return h }
  return 20
}

export function tetosEncontros() { return { ...TETOS_PADRAO, ...(getSetting('badoo_encontros_tetos', null) || {}) } }

export function planejaDiaEncontros({ dia = diaBrasilia(), tetos = tetosEncontros() } = {}) {
  const quantas = rndInt(tetos.sessoesPorDia[0], tetos.sessoesPorDia[1])
  const marcas = []
  for (let i = 0; i < quantas * 5 && marcas.length < quantas; i++) {
    const h = sorteiaHora()
    const emMin = h * 60 + rndInt(0, 59)
    if (marcas.some((m) => Math.abs(m.emMin - emMin) < 45)) continue
    marcas.push({ emMin, hora: h, minuto: emMin % 60, tamanho: rndInt(tetos.tamanhoSessao[0], tetos.tamanhoSessao[1]), feita: false })
  }
  marcas.sort((a, b) => a.emMin - b.emMin)
  return { dia, sessoes: marcas, votos: 0 }
}

export function planoEncontros() {
  const p = getSetting('badoo_encontros_plano', null)
  if (p && p.dia === diaBrasilia()) return p
  const novo = planejaDiaEncontros()
  setSetting('badoo_encontros_plano', novo)
  logEvent({ type: 'badoo_encontros_plano', channel: 'badoo',
    detail: `${novo.sessoes.length} sessões hoje: ${novo.sessoes.map((x) => `${String(x.hora).padStart(2, '0')}:${String(x.minuto).padStart(2, '0')} x${x.tamanho}`).join(', ')}` })
  return novo
}

export function estadoEncontros() {
  const plano = planoEncontros()
  return {
    ligado: getSetting('badoo_encontros_enabled', false) === true,
    // 'continuo' = fica deslizando enquanto aparecer gente (o tick de 5 min é o relógio);
    // 'sessoes' = 3-5 tiradas por dia em horários sorteados.
    modo: getSetting('badoo_encontros_modo', 'continuo'),
    sombra: getSetting('badoo_encontros_sombra', true) !== false,
    tetos: tetosEncontros(),
    ritmo: ritmoAtual(),
    plano,
    proxima: plano.sessoes.find((x) => !x.feita) || null,
    votosHoje: votosHoje(),
  }
}

export function ligarEncontros({ ligado, sombra, tetos, modo, ritmo } = {}) {
  if (ligado !== undefined) setSetting('badoo_encontros_enabled', !!ligado)
  if (sombra !== undefined) setSetting('badoo_encontros_sombra', !!sombra)
  if (modo === 'continuo' || modo === 'sessoes') setSetting('badoo_encontros_modo', modo)
  if (tetos) {
    const t = { ...tetosEncontros() }
    if (tetos.porDia != null) t.porDia = Math.max(1, Math.min(Number(tetos.porDia) || t.porDia, 20000))
    if (Array.isArray(tetos.tirada)) t.tirada = [Math.max(1, Number(tetos.tirada[0]) || 25), Math.max(1, Number(tetos.tirada[1]) || 70)].sort((a, b) => a - b)
    setSetting('badoo_encontros_tetos', t)
  }
  if (ritmo && ritmo.medianaMs != null) {
    setSetting('badoo_encontros_ritmo', { ...(getSetting('badoo_encontros_ritmo', null) || {}), medianaMs: Number(ritmo.medianaMs) })
  }
  return estadoEncontros()
}

// Contador do dia, separado do plano (no modo contínuo não existe plano).
function votosHoje() {
  const c = getSetting('badoo_encontros_dia', null)
  return c && c.dia === diaBrasilia() ? (c.votos || 0) : 0
}
function somaVotos(n) {
  setSetting('badoo_encontros_dia', { dia: diaBrasilia(), votos: votosHoje() + n })
}

let rodando = false
// Chamado pelo loop do vendas-multicanal-core. Não faz nada até a hora de uma sessão chegar — e nunca faz
// nada com o agendador desligado.
export async function encontrosTick({ accountKey = 'main' } = {}) {
  if (rodando) return null
  const e = estadoEncontros()
  if (!e.ligado) return null
  const tetos = e.tetos
  const feitos = votosHoje()
  if (feitos >= tetos.porDia) return null
  const cabe = tetos.porDia - feitos

  let quantos = null
  let sessao = null
  if (e.modo === 'continuo') {
    // O tick de 5 min é o relógio. Uma tirada por disparo, de tamanho variável — e de vez em
    // quando ele PULA a vez, que é o que faz o dia não ter cara de metrônomo.
    if (Math.random() < 0.18) return null
    quantos = Math.min(rndInt(tetos.tirada[0], tetos.tirada[1]), cabe)
  } else {
    const agora = agoraEmMinutosBrasilia()
    sessao = e.plano.sessoes.find((x) => !x.feita && x.emMin <= agora)
    if (!sessao) return null
    quantos = Math.min(sessao.tamanho, cabe)
  }

  rodando = true
  try {
    let contados = 0
    const r = await deslizarEncontros({ quantos, dryRun: e.sombra, accountKey, aoVotar: () => { somaVotos(1); contados++ } })
    // se algum voto saiu sem passar pelo contador (erro no meio), acerta a diferença
    const faltou = (r.votosNoProtocolo || 0) - contados
    if (faltou > 0) somaVotos(faltou)
    if (sessao) { sessao.feita = true; setSetting('badoo_encontros_plano', e.plano) }
    logEvent({ type: 'badoo_encontros_sessao', channel: 'badoo',
      detail: `${r.curtidas} curtidas, ${r.passadas} passadas${e.sombra ? ' (sombra)' : ''} — ${votosHoje()}/${tetos.porDia} no dia${r.paradaPor ? ' · parou: ' + r.paradaPor : ''}` })
    return r
  } catch (err) {
    if (sessao) { sessao.feita = true; setSetting('badoo_encontros_plano', e.plano) }
    logEvent({ type: 'badoo_encontros_erro', channel: 'badoo', detail: err?.message || String(err) })
    return null
  } finally { rodando = false }
}
