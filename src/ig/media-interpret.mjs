// INTERPRETAÇÃO DE MÍDIA RECEBIDA (imagem / vídeo / reel do Instagram) — PRONTO PRA PLUGAR,
// NÃO ATIVADO. Nada importa este módulo hoje; ele existe pra o dia em que a gente quiser
// que a IA "veja" o que chega (em vez de só ver o marcador "[imagem]"/"[vídeo]").
//
// Filosofia: este módulo só ORQUESTRA (baixa → frames/áudio → junta a descrição). As duas
// peças que dependem de modelo entram por INJEÇÃO na hora de plugar, pra não acoplar aqui a
// um provedor específico:
//   - describeImages(buffers, { context }) -> Promise<string>   (visão: descreve 1+ imagens)
//   - transcribeAudio(buffer) -> Promise<{ text }>              (áudio: já existe em wa/media.mjs)
//
// Integração futura (ver docs/MEDIA-INTERPRET.md): no persistThread do IG, quando a mensagem
// é mídia, guardar o `src` (hoje a gente só guarda "[imagem]"); depois chamar interpretMedia e
// gravar o resultado em message.media_json.description — o buildHistory injeta essa descrição
// no lugar do marcador, e a IA responde sabendo o que recebeu.
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_FRAME_COUNT = 6
const MAX_BYTES = 25 * 1024 * 1024 // teto de download (mídia de DM é pequena)

// Baixa a mídia (imagem/vídeo) da URL do CDN do Instagram. As URLs do IG expiram e às vezes
// pedem o cookie/Referer da sessão — por isso cookieHeader e referer são opcionais.
export async function downloadMedia(url, { cookieHeader = null, referer = 'https://www.instagram.com/' } = {}) {
  if (!url) throw new Error('sem url de mídia')
  const headers = { 'user-agent': 'Mozilla/5.0', referer }
  if (cookieHeader) headers.cookie = cookieHeader
  const r = await fetch(url, { headers })
  if (!r.ok) throw new Error(`download da mídia falhou: ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error('mídia grande demais')
  return buf
}

// Extrai `count` frames espaçados de um vídeo. Usa ffmpeg (spawn) — é a dependência de
// ATIVAÇÃO (instalar ffmpeg na VM). Retorna array de Buffers JPEG. Se ffmpeg faltar, lança
// (o chamador decide: descrever só pelo áudio, ou avisar). Alternativa sem ffmpeg: a fábrica
// opensquad monta um contact-sheet — dá pra portar aqui depois se não quiser a dependência.
export async function videoFrames(videoBuffer, { count = DEFAULT_FRAME_COUNT, ffmpegBin = process.env.TIM_FFMPEG || 'ffmpeg' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vendas-multicanal-frames-'))
  try {
    const inFile = path.join(dir, 'in.mp4')
    await writeFile(inFile, videoBuffer)
    // fps calculado pra sair ~count frames de um vídeo de reel (até ~90s); "thumbnail" pega
    // frames representativos. Simples e robusto; ajustável na ativação.
    await runProcess(ffmpegBin, ['-i', inFile, '-vf', `thumbnail,fps=1/8`, '-frames:v', String(count), '-y', path.join(dir, 'f-%02d.jpg')])
    const files = (await readdir(dir)).filter((f) => f.startsWith('f-')).sort()
    const frames = []
    for (const f of files.slice(0, count)) frames.push(await readFile(path.join(dir, f)))
    if (!frames.length) throw new Error('nenhum frame extraído')
    return frames
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function runProcess(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (c) => { err += String(c); if (err.length > 4000) err = err.slice(-4000) })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${bin} saiu com ${code}: ${err.slice(-300)}`))))
  })
}

// ORQUESTRADOR. Recebe a mídia + as duas funções injetadas e devolve uma descrição em
// texto pra IA. NÃO é chamado por ninguém hoje.
//   input: { kind: 'imagem'|'video'|'reel', src, cookieHeader?, describeImages, transcribeAudio? }
//   retorno: { ok, kind, description, transcript }
export async function interpretMedia({ kind, src, cookieHeader = null, describeImages, transcribeAudio = null, frameCount = DEFAULT_FRAME_COUNT } = {}) {
  if (typeof describeImages !== 'function') throw new Error('describeImages (visão) é obrigatório — injetar na ativação')
  const buf = await downloadMedia(src, { cookieHeader })

  if (kind === 'imagem') {
    const description = await describeImages([buf], { context: 'imagem enviada num Direct do Instagram' })
    return { ok: true, kind, description: (description || '').trim(), transcript: null }
  }

  // vídeo / reel: frames (visão) + áudio (transcrição), combinados numa descrição só.
  let frames = []
  try { frames = await videoFrames(buf, { count: frameCount }) } catch { frames = [] }
  const [visual, audio] = await Promise.all([
    frames.length ? describeImages(frames, { context: 'frames de um vídeo/reel enviado num Direct do Instagram, em ordem cronológica' }) : Promise.resolve(''),
    (transcribeAudio && buf.length) ? transcribeAudio(buf).then((r) => (r && r.text) || '').catch(() => '') : Promise.resolve(''),
  ])
  const parts = []
  if (visual) parts.push(`O que aparece no vídeo: ${visual.trim()}`)
  if (audio) parts.push(`Áudio do vídeo: ${audio.trim()}`)
  return { ok: true, kind, description: parts.join('\n') || '(não deu pra interpretar o vídeo)', transcript: audio || null }
}

// Rótulo curto pra prévia/lista quando ainda não interpretou (o marcador de sempre).
export function mediaPlaceholder(kind) {
  return kind === 'video' || kind === 'reel' ? '[vídeo]' : '[imagem]'
}
