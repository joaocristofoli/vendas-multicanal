// BAIXAR UM VÍDEO PELO LINK — conta, não navegação.
//
// O caminho curto existe porque o shortcode do Instagram É o id da mídia escrito em base64
// com o alfabeto deles: "AbC1dEfGhI2" -> 487186803856118326. Isso é uma CONTA (14 linhas,
// zero rede), não uma consulta. O jeito que a fábrica de conteúdo faz no Mac — abrir o
// permalink no Chrome, varrer os <script type="application/json"> do HTML atrás de um nó com
// `code === SHORT` e pescar o id de lá — depende do HTML continuar com aquela forma, custa
// uma aba e alguns segundos, e é exatamente o tipo de coisa que quebra calado.
//
// Com o id na mão, a media info da API interna (a MESMA sessão que já lê as DMs, src/ig/api.mjs)
// entrega `video_versions` com largura e altura. A maior é a máxima que o Instagram guarda:
// o payload traz `original_width/original_height` e, no reel que motivou isto, os três
// `video_versions` e a melhor `Representation` do DASH davam todos 716x894 — igual ao original.
// Não existe "versão escondida em 1080p": o que ele serve é o que ele tem.
//
// Nada aqui chama modelo de linguagem. O modelo só decide QUE isto deve rodar (a ação
// `baixar_video` do assistente); o resto é função eterna. Ver docs/BAIXAR-VIDEO.md.
import fs from 'node:fs'
import path from 'node:path'
import { mediaInfo, sessaoDoChrome } from '../ig/api.mjs'
import { VIDEO_DIR } from '../core/caminhos.mjs'

// Onde os vídeos ficam na VM. Fora do banco de propósito: arquivo grande em SQLite é peso
// morto no backup, e o que importa guardar (o link, o que foi feito) já vive no log.
export const PASTA = VIDEO_DIR

// Teto do download. Um reel tem 1-20 MB; 300 MB é folga pra um vídeo longo sem virar bomba
// de disco numa VM de 50 GB.
const TETO_BYTES = 300 * 1024 * 1024
// O WhatsApp recusa mídia acima de ~64 MB. Cortar em 60 MB dá margem pro overhead do
// protocolo e evita descobrir o limite com um envio que falha depois de subir tudo.
export const TETO_WHATSAPP = 60 * 1024 * 1024
// Quantos arquivos ficam na pasta. Sem isso a pasta cresce pra sempre.
const GUARDAR = 40

// Alfabeto do shortcode do Instagram (base64url, nesta ordem).
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

// ---------------------------------------------------------------- link -> identidade

// De que fonte é este link? Hoje só o Instagram tem sessão logada aqui dentro. Devolver null
// (em vez de tentar e falhar feio) é o que deixa a mensagem de erro honesta.
export function fonteDoLink(link) {
  const s = String(link || '').trim()
  if (!/^https?:\/\//i.test(s)) return /^[A-Za-z0-9_-]{5,}$/.test(s) ? 'instagram' : null
  let host
  try { host = new URL(s).hostname.toLowerCase().replace(/^www\./, '') } catch { return null }
  if (host === 'instagram.com' || host.endsWith('.instagram.com') || host === 'instagr.am') return 'instagram'
  return null
}

// O shortcode dentro da URL. Aceita /reel/, /reels/, /p/ e /tv/, com ou sem barra final, com
// ou sem a tralha de rastreamento que o compartilhamento do celular gruda (?igsh=...).
export function codigoDoLink(link) {
  const s = String(link || '').trim()
  const m = s.match(/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/)
  if (m) return m[1]
  // shortcode cru, sem URL nenhuma
  if (/^[A-Za-z0-9_-]{5,}$/.test(s) && !s.includes('/')) return s
  return null
}

// Link de STORY já traz o id da mídia na própria URL (/stories/<usuario>/<id>/) — não passa
// por shortcode nenhum.
export function idDeStory(link) {
  const m = String(link || '').match(/\/stories\/[^/]+\/(\d{6,})/)
  return m ? m[1] : null
}

// O shortcode É o id em base64. Função pura: mesma entrada, mesma saída, pra sempre.
export function idDoCodigo(codigo) {
  const c = String(codigo || '')
  if (!c) return null
  let n = 0n
  for (const ch of c) {
    const i = ALFABETO.indexOf(ch)
    if (i < 0) return null
    n = n * 64n + BigInt(i)
  }
  return n.toString()
}

// O compartilhamento do app às vezes gera /share/... , que não carrega o shortcode: só um
// redirecionamento pra ele. Uma requisição resolve — e é a ÚNICA ida à rede antes da API.
export async function resolverCompartilhado(link) {
  const s = String(link || '')
  if (!/instagram\.com\/share\//i.test(s)) return s
  let cookie = null
  try { cookie = (await sessaoDoChrome()).cookie } catch { /* sem sessão o redirect costuma valer mesmo assim */ }
  const r = await fetch(s, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0', ...(cookie ? { cookie } : {}) } })
  return r.url || s
}

// ---------------------------------------------------------------- escolha da versão

// A maior versão por área. O Instagram devolve `video_versions` fora de ordem e com `type`
// que NÃO é qualidade (101/102/103 são formatos de entrega, e no mesmo post costumam apontar
// pra mesma URL).
export function melhorVersao(versoes) {
  const vs = (Array.isArray(versoes) ? versoes : []).filter((v) => v && v.url)
  if (!vs.length) return null
  return vs.slice().sort((a, b) => (Number(b.width || 0) * Number(b.height || 0)) - (Number(a.width || 0) * Number(a.height || 0)))[0]
}

// De um item da media info tira o vídeo: post de vídeo direto, ou o primeiro vídeo de um
// carrossel. Devolve também quantos vídeos havia, porque "baixei 1 de 3" e "baixei o único"
// são frases diferentes e ele precisa saber qual é.
export function videoDoItem(item) {
  if (!item) throw new Error('post vazio')
  if (item.media_type === 2 || item.video_versions?.length) {
    const v = melhorVersao(item.video_versions)
    if (!v) throw new Error('esse post é um vídeo mas o Instagram não devolveu nenhuma versão pra baixar')
    return { versao: v, total: 1, indice: 1, duracao: Number(item.video_duration || 0) }
  }
  if (item.media_type === 8) {
    const filhos = (item.carousel_media || []).filter((c) => c?.video_versions?.length)
    if (!filhos.length) throw new Error('esse carrossel só tem foto, nenhum vídeo')
    const v = melhorVersao(filhos[0].video_versions)
    return { versao: v, total: filhos.length, indice: 1, duracao: Number(filhos[0].video_duration || 0) }
  }
  throw new Error('esse post é uma foto, não um vídeo')
}

// ---------------------------------------------------------------- disco

function limpar(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // acento vira letra simples, não vira traço
    .replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'video'
}

// Guarda só os mais novos. Determinístico e barato: roda a cada download.
export function podarPasta({ guardar = GUARDAR, pasta = PASTA } = {}) {
  let arquivos
  try { arquivos = fs.readdirSync(pasta).filter((f) => f.endsWith('.mp4')) } catch { return 0 }
  if (arquivos.length <= guardar) return 0
  const comIdade = arquivos.map((f) => ({ f, t: (() => { try { return fs.statSync(path.join(pasta, f)).mtimeMs } catch { return 0 } })() }))
  comIdade.sort((a, b) => b.t - a.t)
  let apagados = 0
  for (const { f } of comIdade.slice(guardar)) {
    try { fs.unlinkSync(path.join(pasta, f)); apagados++ } catch { /* já sumiu */ }
  }
  return apagados
}

async function baixarPara(url, arquivo, { cookie = null } = {}) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.instagram.com/', ...(cookie ? { cookie } : {}) } })
  if (!r.ok) throw new Error(`o CDN do Instagram recusou o download (${r.status})`)
  // O content-length evita começar a escrever um arquivo que já se sabe grande demais.
  const anunciado = Number(r.headers.get('content-length') || 0)
  if (anunciado > TETO_BYTES) throw new Error(`vídeo grande demais (${Math.round(anunciado / 1048576)} MB)`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length > TETO_BYTES) throw new Error(`vídeo grande demais (${Math.round(buf.length / 1048576)} MB)`)
  if (!buf.length) throw new Error('o download veio vazio')
  fs.mkdirSync(path.dirname(arquivo), { recursive: true })
  fs.writeFileSync(arquivo, buf)
  return buf.length
}

// ---------------------------------------------------------------- a capacidade

// Baixa o vídeo de um link do Instagram na melhor qualidade que existir e devolve o retrato do
// que foi baixado. NÃO envia nada: quem entrega é quem chamou (o assistente manda no self-chat).
export async function baixarVideo(link, { pasta = PASTA } = {}) {
  const original = String(link || '').trim()
  if (!original) throw new Error('sem link')
  const fonte = fonteDoLink(original)
  if (fonte !== 'instagram') {
    throw new Error('por enquanto eu só sei baixar vídeo do Instagram (é lá que eu tenho sessão logada). Manda o link do post/reel')
  }

  const resolvido = await resolverCompartilhado(original)
  const story = idDeStory(resolvido)
  const codigo = story ? null : codigoDoLink(resolvido)
  const mediaId = story || idDoCodigo(codigo)
  if (!mediaId) throw new Error('não consegui achar o código do post nesse link')

  const item = await mediaInfo(mediaId)
  const { versao, total, indice, duracao } = videoDoItem(item)

  const autor = item.user?.username || 'instagram'
  const nome = `${limpar(autor)}-${limpar(story ? `story-${story}` : codigo)}.mp4`
  const arquivo = path.join(pasta, nome)
  let cookie = null
  try { cookie = (await sessaoDoChrome()).cookie } catch { /* a URL do CDN normalmente é aberta */ }
  const bytes = await baixarPara(versao.url, arquivo, { cookie })
  podarPasta({ pasta })

  return {
    arquivo,
    nome,
    bytes,
    largura: Number(versao.width || 0),
    altura: Number(versao.height || 0),
    duracao,
    autor,
    codigo: story ? `story-${story}` : codigo,
    legenda: item.caption?.text || null,
    total,
    indice,
    link: resolvido,
    cabeNoWhatsapp: bytes <= TETO_WHATSAPP,
  }
}

// ---------------------------------------------------------------- o gatilho
// "baixa esse vídeo <link>" entendido SEM modelo nenhum. Devolve o link, ou null.
//
// Por que um gatilho e não só uma ação do catálogo: no modo códex o catálogo não é alcançável
// (o sandbox do agente não tem rede, então `tools/acao.mjs` morre em http=000 — medido na VM
// em 29/07/2026), e a mesma frase funcionaria num modo e falharia no outro. Além disso, pedido
// com link é inequívoco: gastar um turno de modelo pra descobrir que "baixa esse vídeo" quer
// dizer baixar esse vídeo é o oposto da regra da casa.
//
// Duas peneiras juntas, de propósito: tem que ter um LINK de post do Instagram E um verbo de
// baixar. Só o link não basta — ele cola link o tempo todo pra comentar, e baixar calado seria
// o sistema decidindo por ele.
//
// A lista é FECHADA (e não `baix\w*`) por causa de um falso positivo que o teste pegou: "o
// preço baixou, olha esse link" viraria download. Flexão de passado é sobre outra coisa; o
// que vira ordem é imperativo e infinitivo. O que ficar de fora não se perde — no modo normal
// o modelo ainda entende pelo catálogo; só no modo códex o gatilho é a única porta.
const VERBOS = /\b(baixa|baixar|baixe|baixando|download|salva|salvar|salve|guarda|guardar|guarde)\b/i

export function gatilhoDeVideo(texto) {
  const t = String(texto || '')
  if (!VERBOS.test(t)) return null
  const m = t.match(/https?:\/\/[^\s]*instagram\.com\/[^\s]+/i)
  if (!m) return null
  const link = m[0].replace(/[)\]}.,;]+$/, '')   // pontuação colada no fim do link
  // Precisa ser um post: /reel/, /p/, /tv/, /stories/ ou /share/. Link de perfil não tem vídeo.
  if (!codigoDoLink(link) && !idDeStory(link) && !/instagram\.com\/share\//i.test(link)) return null
  return link
}

// Ele pediu pra vir COMO ARQUIVO (documento) em vez de bolha de vídeo? Os bytes são os mesmos
// nos dois — está provado em `src/wa/fidelidade.mjs` — mas o formato muda como o outro lado
// recebe: documento chega com nome de arquivo e sem passar pelo player. Ler a intenção aqui
// (e não no modelo) é o que faz a frase valer igual nos dois modos do self-chat.
export function pediuComoArquivo(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  return /\b(como arquivo|em arquivo|como documento|em documento|como doc|sem (compressao|compactacao|comprimir|perder))\b/.test(t)
}

// Uma linha honesta sobre o que foi baixado — é o que vai como legenda no WhatsApp e como
// comprovante da ação. Sem emoji (regra do projeto) e sem adjetivo: só o que é fato.
export function descrever(r) {
  const mb = (r.bytes / 1048576).toFixed(1).replace('.', ',')
  const partes = [`@${r.autor}`]
  if (r.duracao) partes.push(`${Math.round(r.duracao)}s`)
  if (r.largura && r.altura) partes.push(`${r.largura}x${r.altura}`)
  partes.push(`${mb} MB`)
  if (r.total > 1) partes.push(`vídeo ${r.indice} de ${r.total} do carrossel`)
  return partes.join(' · ')
}
