// Lado BAIXO das FOTOS salvas: disco e envio. O irmão saved-audio.mjs faz o mesmo pro áudio.
//
// Sem transcode: foto entra como veio (jpg/png/webp). O áudio precisava de ffmpeg porque o
// WhatsApp só aceita nota de voz em OGG/Opus; imagem ele aceita direto, e reencodar só
// perderia qualidade sem ganhar nada.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SAVED_IMAGE_DIR as SAVED_IMAGE_DIR_PADRAO } from '../core/caminhos.mjs'

// Pasta persistente (sobrevive a deploy, igual wa-media e wa-saved-audio).
export const SAVED_IMAGE_DIR = SAVED_IMAGE_DIR_PADRAO

// Teto do upload. Foto de celular passa longe disso; o teto existe pra uma request
// maliciosa não encher a memória do processo.
export const MAX_IMAGE_BYTES = 24 * 1024 * 1024

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

// Grava a foto em disco e devolve o nome do arquivo + tamanho + dimensões.
export async function persistSavedImage(id, buffer) {
  const tipo = tipoDaImagem(buffer)
  if (!tipo) throw new Error('isso não é uma imagem que eu saiba mandar (aceito jpg, png, gif e webp)')
  await ensureDir()
  const file = `${id}.${tipo.ext}`
  await writeFile(savedImagePath(file), buffer)
  const { width, height } = dimensoes(buffer, tipo.ext)
  return { file, sizeBytes: buffer.length, width, height, mime: tipo.mime }
}

// Envia uma foto do banco. `caption` opcional: a IA pode mandar a foto sozinha (o normal
// dela é bolha curta separada) ou com uma legenda curta.
export async function sendSavedImage(sock, jid, imagem, { caption = null } = {}) {
  const buffer = await readFile(savedImagePath(imagem.file))
  const tipo = tipoDaImagem(buffer)
  // "digitando" curto antes da foto: mandar mídia instantânea depois de uma bolha de texto
  // denuncia automação. Curto de propósito — foto não se "grava" como áudio.
  await sock.sendPresenceUpdate('composing', jid).catch(() => {})
  await new Promise((r) => setTimeout(r, 1200 + Math.floor(Math.random() * 900)))
  const result = await sock.sendMessage(jid, {
    image: buffer,
    mimetype: tipo?.mime || 'image/jpeg',
    caption: caption ? String(caption).slice(0, 400) : undefined,
  })
  await sock.sendPresenceUpdate('paused', jid).catch(() => {})
  return { providerMessageId: result?.key?.id || null }
}
