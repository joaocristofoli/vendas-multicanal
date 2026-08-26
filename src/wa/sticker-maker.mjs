// Cria uma FIGURINHA própria (webp) a partir de imagem/GIF/vídeo, usando ffmpeg (que tem
// libwebp_anim). Estática ou ANIMADA — a animada é o "faça sua própria figurinha animada".
// Sem lib nova: só ffmpeg, que já roda na VM. O envio continua sendo sock.sendMessage({sticker}).
//
// NÃO confundir com a figurinha animada LOTTIE (aquela é JSON e a gente ENCAMINHA, não remonta).
// Aqui a animada é webp animado (de GIF/vídeo), que é o formato que dá pra CRIAR e enviar.
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const FFMPEG = process.env.TIM_FFMPEG || 'ffmpeg'
const MAX_IN = 25 * 1024 * 1024

// Baixa a fonte (url http/https) OU usa o buffer/arquivo dado. Retorna Buffer.
async function fonteBuffer({ url, buffer }) {
  if (buffer) return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (url && /^https?:\/\//.test(url)) {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
    if (!r.ok) throw new Error(`baixar a fonte falhou: ${r.status}`)
    const b = Buffer.from(await r.arrayBuffer())
    if (b.length > MAX_IN) throw new Error('arquivo grande demais')
    return b
  }
  throw new Error('sem fonte (url ou buffer)')
}

function rodarFfmpeg(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => { err += d.toString().slice(0, 2000) })
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* já morreu */ } reject(new Error('ffmpeg timeout')) }, timeoutMs)
    p.on('error', (e) => { clearTimeout(t); reject(e) })
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`ffmpeg saiu ${code}: ${err.slice(-300)}`)) })
  })
}

// Escala pra 512x512 mantendo proporção, com padding transparente (padrão de figurinha).
const VF_QUADRADO = 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000'

// Gera o webp. animada=true -> webp animado (loop infinito, ~15fps). Retorna Buffer.
// Se ficar grande demais (> ~900KB), refaz com fps/qualidade menores.
export async function fazerFigurinha({ url, buffer, animada = false } = {}) {
  const src = await fonteBuffer({ url, buffer })
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vendas-multicanal-stk-'))
  try {
    const inp = path.join(dir, 'in')
    const out = path.join(dir, 'out.webp')
    await writeFile(inp, src)
    const base = ['-y', '-i', inp]
    async function encode(fps, q) {
      const vf = animada ? `fps=${fps},${VF_QUADRADO}` : VF_QUADRADO
      const args = animada
        ? [...base, '-vcodec', 'libwebp_anim', '-filter:v', vf, '-loop', '0', '-lossless', '0', '-compression_level', '5', '-q:v', String(q), '-preset', 'picture', '-an', '-vsync', '0', out]
        : [...base, '-vcodec', 'libwebp', '-filter:v', vf, '-lossless', '1', '-q:v', String(q), '-an', out]
      await rodarFfmpeg(args)
      return readFile(out)
    }
    let webp = await encode(animada ? 15 : 75, animada ? 65 : 90)
    // controla o tamanho (WhatsApp reclama de figurinha animada muito grande)
    if (animada && webp.length > 900 * 1024) webp = await encode(12, 45)
    if (animada && webp.length > 900 * 1024) webp = await encode(10, 30)
    return webp
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
}
