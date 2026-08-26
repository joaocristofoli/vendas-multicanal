// Envio de nota de voz no Badoo.
//
// O Badoo não aceita um POST de chat fabricado: o `x-pingback` assina o corpo. Por isso este
// módulo usa o gravador do próprio cliente Badoo já logado. Ele injeta o áudio salvo como uma
// MediaStream temporária, mantém pressionado o botão nativo e deixa o site executar, na ordem
// real, upload CDN -> SERVER_SEND_CHAT_MESSAGE. A resposta 151 é o comprovante definitivo.
import { readFile } from 'node:fs/promises'
import { badooPage, badooExclusive, BADOO } from './browser.mjs'
import { lidarComConsentimento } from './dom.mjs'
import { savedAudioPath } from '../wa/saved-audio.mjs'
import { addMessage, marcarAutor, setMessageMedia } from '../core/db.mjs'

const RECORD_BUTTON = '[data-qa="messenger-chat-record-audio"]'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function messageReceipt(packet) {
  for (const body of packet?.body || []) {
    const received = body?.chat_message_received
    const message = received?.chat_message
    if (received?.success && message?.message_type === 19 && message?.multimedia?.audio?.id) {
      return { uid: message.uid, audioId: String(message.multimedia.audio.id), durationMs: message.multimedia.audio.duration_ms || null }
    }
  }
  return null
}

// Instala um microfone efêmero no documento. O AudioContext decodifica o OGG real; o
// MediaRecorder do Badoo continua sendo quem produz o blob, calcula waveform e manda ao CDN.
async function instalarMicrofone(page, audioBase64) {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const decoded = await ctx.decodeAudioData(bytes.buffer)
    const destination = ctx.createMediaStreamDestination()
    const original = navigator.mediaDevices?.getUserMedia
    if (!original) throw new Error('navegador sem getUserMedia')
    let started = false
    const fake = async () => {
      if (!started) {
        started = true
        await ctx.resume().catch(() => {})
        const source = ctx.createBufferSource()
        source.buffer = decoded
        source.connect(destination)
        source.start()
      }
      return destination.stream
    }
    navigator.mediaDevices.getUserMedia = fake
    window.__timMariBadooAudioRestore = () => {
      navigator.mediaDevices.getUserMedia = original
      try { ctx.close() } catch {}
      delete window.__timMariBadooAudioRestore
    }
    return { durationMs: Math.ceil(decoded.duration * 1000), state: ctx.state }
  }, audioBase64)
}

async function restaurarMicrofone(page) {
  await page.evaluate(() => window.__timMariBadooAudioRestore?.()).catch(() => {})
}

export async function enviarAudioSalvo({ chatId, audio }) {
  if (!chatId) throw new Error('chatId ausente')
  if (!audio?.file) throw new Error('áudio salvo ausente')

  const buffer = await readFile(savedAudioPath(audio.file))
  if (!buffer.length) throw new Error('arquivo de áudio vazio')

  return badooExclusive(async () => {
    const page = await badooPage()
    const url = `${BADOO}/messages/${chatId}`
    if (!page.url().includes(chatId)) {
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await sleep(3500)
    }
    await lidarComConsentimento(page).catch(() => {})

    const button = page.locator(RECORD_BUTTON).first()
    if (!(await button.count())) throw new Error('não achei o botão de gravar áudio no Badoo')
    const box = await button.boundingBox()
    if (!box) throw new Error('botão de gravar áudio não está visível')

    const mic = await instalarMicrofone(page, buffer.toString('base64'))
    if (mic.durationMs < 1000) {
      await restaurarMicrofone(page)
      throw new Error('o áudio precisa ter pelo menos 1 segundo')
    }

    let resolveReceipt
    const receipt = new Promise((resolve) => { resolveReceipt = resolve })
    const listener = async (response) => {
      if (!/mwebapi\.phtml\?SERVER_SEND_CHAT_MESSAGE/.test(response.url())) return
      try {
        const found = messageReceipt(await response.json())
        if (found) resolveReceipt(found)
      } catch { /* a confirmação abaixo expira e devolve erro claro */ }
    }
    page.on('response', listener)
    try {
      // O gravador do Badoo tem atraso de 1 s antes de pedir o microfone. Segurar por toda a
      // duração + margem preserva o áudio completo; soltar abre a prévia e o segundo clique envia.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await sleep(mic.durationMs + 1400)
      await page.mouse.up()

      const send = page.locator(RECORD_BUTTON).first()
      await send.waitFor({ state: 'visible', timeout: 10000 })
      await sleep(700) // o Badoo termina MediaRecorder -> waveform -> prévia de modo assíncrono
      await send.click({ timeout: 8000 })

      const confirmed = await Promise.race([
        receipt,
        sleep(30000).then(() => null),
      ])
      if (!confirmed) throw new Error('o Badoo não confirmou o envio do áudio')
      return { ok: true, ...confirmed, recordedDurationMs: mic.durationMs }
    } finally {
      page.off('response', listener)
      await restaurarMicrofone(page)
    }
  })
}

// Grava o fato local com o uid REAL recebido no 151. Sem isto a próxima geração só veria
// "Mensagem de voz" e poderia escolher o mesmo áudio salvo outra vez para a mesma pessoa.
export function registrarAudioEnviado({ accountKey, personId, audio, receipt, author = 'humano' }) {
  if (!receipt?.uid) return false
  const messageId = 'b:' + receipt.uid
  const media = {
    kind: 'audio', saved: true, file: audio.file, dur: Number(audio.duration_sec) || 0,
    transcript: audio.transcript || null, status: 'done', badooAudioId: receipt.audioId || null,
  }
  addMessage({ messageId, accountKey, personId, channel: 'badoo', direction: 'outgoing',
    text: 'Mensagem de voz', media, ts: Date.now(), author })
  // O sync pode ter trazido o eco entre o 151 e o INSERT; nesse caso completa a mesma linha.
  setMessageMedia(messageId, media)
  marcarAutor({ channel: 'badoo', messageId, author })
  return true
}
