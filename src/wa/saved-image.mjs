// Lado BAIXO das FOTOS (e VÍDEOS) salvas: disco e envio. O irmão saved-audio.mjs faz o mesmo
// pro áudio.
//
// FOTO entra como veio (jpg/png/webp). O áudio precisava de ffmpeg porque o WhatsApp só aceita
// nota de voz em OGG/Opus; imagem ele aceita direto, e reencodar só perderia qualidade.
//
// VÍDEO (07/10/2026) mora no mesmo banco, com a mesma descrição, o mesmo nível e o mesmo
// marcador [foto:atalho]: para quem opera é "mais um item do banco", não uma segunda
// biblioteca. No disco ele vira SEMPRE <id>.mp4 (H.264 + AAC, faststart), porque é o único
// formato que o WhatsApp toca dentro da conversa em qualquer aparelho — o .mov HEVC do iPhone
// chega lá como arquivo que não abre. Junto nasce <id>-capa.jpg, a miniatura do painel.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SAVED_IMAGE_DIR as SAVED_IMAGE_DIR_PADRAO } from '../core/caminhos.mjs'

// Pasta persistente (sobrevive a deploy, igual wa-media e wa-saved-audio).
export const SAVED_IMAGE_DIR = SAVED_IMAGE_DIR_PADRAO

// Teto do upload. Foto de celular passa longe disso; o teto existe pra uma request
// maliciosa não encher a memória do processo.
export const MAX_IMAGE_BYTES = 24 * 1024 * 1024
// Vídeo tem teto próprio, maior. O corpo inteiro passa pela memória do processo, então não
// dá pra abrir sem limite numa máquina de 1 GB.
export const MAX_VIDEO_BYTES = 64 * 1024 * 1024

const FFMPEG = process.env.TIM_FFMPEG || 'ffmpeg'

const TIPOS = {
  'ffd8ff': { ext: 'jpg', mime: 'image/jpeg' },
  '89504e': { ext: 'png', mime: 'image/png' },
  '474946': { ext: 'gif', mime: 'image/gif' },
  '524946': { ext: 'webp', mime: 'image/webp' },   // RIFF....WEBP
}

// O TIPO VEM DOS BYTES, não da extensão que o navegador mandou. Extensão é palpite de quem
// envia; assinatura é fato. Também é o que impede alguém salvar um arquivo qualquer como
// ".jpg" e o WhatsApp recusar na hora do envio, muito depois, sem explicação.
export function tipoDaImagem(buffer) {
  if (!buffer || buffer.length < 12) return null
  const head = buffer.subarray(0, 3).toString('hex')
  const t = TIPOS[head]
  if (!t) return null
  if (t.ext === 'webp' && buffer.subarray(8, 12).toString('ascii') !== 'WEBP') return null
  return t
}

// Marcas de "ftyp" que são FOTO, não vídeo. A foto HEIC do iPhone usa a mesma caixa do MP4;
// sem esta lista ela entraria como um vídeo de um quadro só.
const MARCAS_DE_FOTO = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis'])

// Vídeo pela assinatura: MP4/MOV/M4V/3GP têm a caixa 'ftyp' nos bytes 4..8; WebM e MKV
// começam pelo cabeçalho EBML. Quem decide se dá pra tocar é o ffmpeg, logo depois.
export function pareceVideo(buffer) {
  if (!buffer || buffer.length < 12) return false
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    return !MARCAS_DE_FOTO.has(buffer.subarray(8, 12).toString('ascii').toLowerCase())
  }
  return buffer.subarray(0, 4).toString('hex') === '1a45dfa3'
}

// O que está salvo no banco: vídeo é sempre .mp4 (normalizado no upload), o resto é foto.
export function ehVideoSalvo(file) { return /\.mp4$/i.test(String(file || '')) }
export function tipoDaMidiaSalva(file) { return ehVideoSalvo(file) ? 'video' : 'image' }
export function capaDoVideo(file) { return String(file || '').replace(/\.mp4$/i, '-capa.jpg') }

// Dimensões, quando dá pra ler barato do cabeçalho. Não é essencial (serve pro painel
// mostrar), então falha vira 0 em vez de erro: uma foto sem dimensão continua enviável.
export function dimensoes(buffer, ext) {
  try {
    if (ext === 'png') return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    if (ext === 'gif') return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
    if (ext === 'jpg') {
      let i = 2
      while (i < buffer.length - 9) {
        if (buffer[i] !== 0xff) { i++; continue }
        const marker = buffer[i + 1]
        // SOF0..SOF3 e SOF5..SOF7: os que carregam altura/largura
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
          return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) }
        }
        i += 2 + buffer.readUInt16BE(i + 2)
      }
    }
  } catch { /* cabeçalho estranho: dimensão não é essencial */ }
  return { width: 0, height: 0 }
}

function ensureDir() { return mkdir(SAVED_IMAGE_DIR, { recursive: true }) }
export function savedImagePath(file) { return path.join(SAVED_IMAGE_DIR, file) }

function erroDeEntrada(mensagem, status = 400) {
  const e = new Error(mensagem)
  e.status = status
  return e
}

// Roda o ffmpeg com args crus. O stderr volta junto: é por ele que o ffmpeg conta o que achou.
function rodarFfmpeg(args, { aceitaFalha = false } = {}) {
  return new Promise((resolve, reject) => {
    let stderr = ''
    let proc
    try { proc = spawn(FFMPEG, args) } catch (e) { return reject(e) }
    proc.stderr.on('data', (c) => { stderr += String(c); if (stderr.length > 200_000) stderr = stderr.slice(-100_000) })
    proc.on('error', (e) => reject(e.code === 'ENOENT'
      ? erroDeEntrada('para guardar vídeo o sistema precisa do FFmpeg instalado (npm run diagnostico mostra se ele está)', 500)
      : e))
    proc.on('close', (code) => {
      if (code === 0 || aceitaFalha) resolve({ code, stderr })
      else reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.slice(-300)}`))
    })
  })
}

// O que o arquivo tem por dentro, lido do stderr do `ffmpeg -i` (sem ffprobe, que não é
// garantido na VM). `ffmpeg -i` sem saída sempre termina com código 1; isso é normal aqui.
export function lerSondagem(stderr) {
  const t = String(stderr || '')
  const dur = t.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/)
  const durationSec = dur ? Math.round(Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) : 0
  const linhaVideo = t.match(/Stream #\d+:\d+[^\n]*?: Video: ([^\n]+)/)
  const linhaAudio = t.match(/Stream #\d+:\d+[^\n]*?: Audio: (\w+)/)
  let video = null
  if (linhaVideo) {
    const resto = linhaVideo[1]
    const codec = (resto.match(/^(\w+)/) || [])[1] || ''
    const pixfmt = (resto.match(/^\w+[^,]*, (\w+)/) || [])[1] || ''
    const dim = resto.match(/, (\d{2,5})x(\d{2,5})/)
    let width = dim ? Number(dim[1]) : 0
    let height = dim ? Number(dim[2]) : 0
    // Celular grava deitado e marca "gire 90°". A dimensão que importa é a de quem assiste.
    const rot = t.match(/rotation of (-?\d+(?:\.\d+)?) degrees/)
    if (rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90) [width, height] = [height, width]
    video = { codec, pixfmt, width, height }
  }
  return { video, audio: linhaAudio ? { codec: linhaAudio[1] } : null, durationSec }
}

async function sondar(caminho) {
  const { stderr } = await rodarFfmpeg(['-hide_banner', '-i', caminho], { aceitaFalha: true })
  return lerSondagem(stderr)
}

// Lado maior em até 1280 px, e as duas medidas pares (o H.264 em yuv420p exige).
const ESCALA = "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))',scale=trunc(iw/2)*2:trunc(ih/2)*2"

// Prepara um vídeo pra morar no banco. Copia o que já é compatível (H.264 em yuv420p, áudio
// AAC) e só reencoda o que não é — reencodar tudo custaria minutos de CPU numa máquina
// pequena e perderia qualidade à toa. `-map_metadata -1` tira o que o celular grava junto,
// inclusive a LOCALIZAÇÃO de onde o vídeo foi feito: o vídeo sai do banco para estranhos.
async function persistirVideo(id, buffer) {
  if (buffer.length > MAX_VIDEO_BYTES) throw erroDeEntrada(`vídeo maior que ${Math.round(MAX_VIDEO_BYTES / 1048576)} MB`, 413)
  await ensureDir()
  // Pasta de trabalho DENTRO do banco, não no /tmp: em muita VM o /tmp é memória (tmpfs) e um
  // vídeo de 60 MB lido duas vezes não cabe. Mesmo disco também deixa o rename atômico.
  const work = await mkdtemp(path.join(SAVED_IMAGE_DIR, '.trabalho-'))
  const entrada = path.join(work, 'entrada')
  const saida = path.join(work, 'saida.mp4')
  const capa = path.join(work, 'capa.jpg')
  try {
    await writeFile(entrada, buffer)
    const antes = await sondar(entrada)
    if (!antes.video) throw erroDeEntrada('não achei imagem nesse vídeo — o arquivo pode estar corrompido')
    const copiaVideo = antes.video.codec === 'h264' && /^yuv420p/.test(antes.video.pixfmt)
    const copiaAudio = !antes.audio || antes.audio.codec === 'aac'
    await rodarFfmpeg([
      '-y', '-hide_banner', '-i', entrada,
      '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1',
      ...(copiaVideo ? ['-c:v', 'copy'] : ['-vf', ESCALA, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']),
      ...(copiaAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k']),
      '-movflags', '+faststart', saida,
    ])
    // A capa sai de meio segundo pra dentro (o primeiro quadro costuma ser preto). Vídeo mais
    // curto que isso não tem quadro ali, e aí vale o primeiro mesmo.
    for (const ss of ['0.5', '0']) {
      await rodarFfmpeg(['-y', '-hide_banner', '-ss', ss, '-i', saida, '-frames:v', '1', '-vf', "scale='min(720,iw)':-2", '-q:v', '4', capa], { aceitaFalha: true })
      if (await stat(capa).then((s) => s.size > 0, () => false)) break
    }
    const depois = await sondar(saida)
    const file = `${id}.mp4`
    await rename(saida, savedImagePath(file))
    await rename(capa, savedImagePath(capaDoVideo(file))).catch(() => {}) // sem capa o vídeo continua enviável
    const { size } = await stat(savedImagePath(file))
    return {
      file, sizeBytes: size, mime: 'video/mp4', kind: 'video',
      width: depois.video?.width || antes.video.width || 0,
      height: depois.video?.height || antes.video.height || 0,
      durationSec: depois.durationSec || antes.durationSec || 0,
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

// Grava a foto (ou o vídeo) em disco e devolve o nome do arquivo + tamanho + dimensões.
export async function persistSavedImage(id, buffer) {
  const tipo = tipoDaImagem(buffer)
  if (tipo) {
    if (buffer.length > MAX_IMAGE_BYTES) throw erroDeEntrada(`foto maior que ${Math.round(MAX_IMAGE_BYTES / 1048576)} MB`, 413)
    await ensureDir()
    const file = `${id}.${tipo.ext}`
    await writeFile(savedImagePath(file), buffer)
    const { width, height } = dimensoes(buffer, tipo.ext)
    return { file, sizeBytes: buffer.length, width, height, mime: tipo.mime, kind: 'image', durationSec: null }
  }
  if (pareceVideo(buffer)) return persistirVideo(id, buffer)
  throw erroDeEntrada('isso não é foto nem vídeo que eu saiba mandar (aceito jpg, png, gif, webp, mp4, mov e webm)')
}

// Envia uma foto (ou vídeo) do banco. `caption` opcional: a IA pode mandar sozinha (o normal
// dela é bolha curta separada) ou com uma legenda curta.
export async function sendSavedImage(sock, jid, imagem, { caption = null } = {}) {
  const buffer = await readFile(savedImagePath(imagem.file))
  const legenda = caption ? String(caption).slice(0, 400) : undefined
  // "digitando" curto antes da mídia: mandar mídia instantânea depois de uma bolha de texto
  // denuncia automação. Curto de propósito — foto não se "grava" como áudio.
  await sock.sendPresenceUpdate('composing', jid).catch(() => {})
  await new Promise((r) => setTimeout(r, 1200 + Math.floor(Math.random() * 900)))
  const conteudo = ehVideoSalvo(imagem.file)
    ? { video: buffer, mimetype: 'video/mp4', caption: legenda,
        ...(imagem.duration_sec ? { seconds: imagem.duration_sec } : {}),
        ...(imagem.width && imagem.height ? { width: imagem.width, height: imagem.height } : {}) }
    : { image: buffer, mimetype: tipoDaImagem(buffer)?.mime || 'image/jpeg', caption: legenda }
  const result = await sock.sendMessage(jid, conteudo)
  await sock.sendPresenceUpdate('paused', jid).catch(() => {})
  return { providerMessageId: result?.key?.id || null }
}
