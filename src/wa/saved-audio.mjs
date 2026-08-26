// Áudios salvos: biblioteca de notas de voz que o dono grava no painel e reusa via
// atalho "/" no composer — e que a IA também pode mandar quando o conteúdo encaixa.
// Este módulo cuida do LADO BAIXO da feature: transcode pra OGG/Opus "nota de voz de
// verdade", medição de duração, acesso a disco e o envio pelo Baileys como PTT.
//
// Nada de lib de ffmpeg: usamos o ffmpeg DO SISTEMA (mesmo que transcreve os áudios
// recebidos foi instalado junto do whisper). Os argumentos do transcode são os que o
// sistema de referência validou em produção — incluem o fix de pre-skip de gravação de iPhone que
// o WhatsApp do destinatário recusa ("áudio indisponível, peça pra reenviar").
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile, rm, mkdtemp, access } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SAVED_AUDIO_DIR as SAVED_AUDIO_DIR_PADRAO } from '../core/caminhos.mjs'

// Pasta dos áudios salvos (persistente: sobrevive a deploy, igual wa-media). Só cria no
// primeiro uso. Env pra teste local; default = onde a VM guarda os dados do vendas-multicanal.
export const SAVED_AUDIO_DIR = SAVED_AUDIO_DIR_PADRAO

// Nome do binário do ffmpeg do sistema (o mesmo que o transcribe.py/whisper usa).
const FFMPEG = process.env.TIM_FFMPEG || 'ffmpeg'

// Teto do upload lido do socket (16MB). Um áudio de nota de voz nunca chega perto disso;
// o teto existe só pra não deixar uma request maliciosa encher a memória.
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024

function ensureDir() { return mkdir(SAVED_AUDIO_DIR, { recursive: true }) }

// Caminho absoluto do .ogg de um id (sem validar existência).
export function savedAudioPath(file) { return path.join(SAVED_AUDIO_DIR, file) }

// Roda o ffmpeg do sistema com args crus; resolve quando fecha. rejeita em erro/exit!=0.
// stderr é capturado (o ffmpeg fala tudo por lá) pra a duração e pro diagnóstico.
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    let stderr = ''
    let proc
    try { proc = spawn(FFMPEG, args) } catch (e) { return reject(e) }
    proc.stderr.on('data', (c) => { stderr += String(c) })
    proc.on('error', (e) => reject(e))
    proc.on('close', (code) => {
      if (code === 0) resolve({ stderr })
      else reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.slice(-300)}`))
    })
  })
}

// Transcodifica um buffer de áudio em QUALQUER formato suportado pelo ffmpeg
// (webm/opus do MediaRecorder, m4a do Safari, mp3, wav, ogg…) pra OGG/Opus mono 48kHz
// ~32kbps — o "sweet spot" pra PTT do WhatsApp. Retorna { buffer, durationSec }.
// Escreve em pasta temporária e limpa no fim (o transcode do ffmpeg exige arquivos).
export async function transcodeToOpusPtt(input) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'vendas-multicanal-audio-'))
  const inPath = path.join(work, 'in.bin')
  const outPath = path.join(work, 'out.ogg')
  try {
    await writeFile(inPath, input)
    // Args IDÊNTICOS ao que o sistema de referência roda em prod. O par
    // aresample=async=1:first_pts=0 + asetpts=N/SR/TB normaliza os timestamps e mata o
    // pre-skip Opus negativo que gravações de celular herdam (start:-0.0065) — sem isso
    // o WhatsApp do destinatário rejeita a reprodução. -application voip = tuning de voz.
    await runFfmpeg([
      '-y', '-i', inPath,
      '-vn', '-map_metadata', '-1',
      '-af', 'aresample=async=1:first_pts=0,asetpts=N/SR/TB',
      '-ac', '1', '-ar', '48000',
      '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip',
      '-f', 'ogg', outPath,
    ])
    const buffer = await readFile(outPath)
    const durationSec = await probeDurationSec(outPath)
    return { buffer, durationSec }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

// Duração em segundos via "ffmpeg -i <file> -f null -" parseando o time= do stderr.
// Não dependemos de ffprobe (não é garantido na VM). Resolve 0 se não achar o tempo.
export function probeDurationSec(filePath) {
  return new Promise((resolve) => {
    let stderr = ''
    let proc
    try { proc = spawn(FFMPEG, ['-i', filePath, '-hide_banner', '-f', 'null', '-']) }
    catch { return resolve(0) }
    proc.stderr.on('data', (c) => { stderr += String(c) })
    proc.on('error', () => resolve(0))
    proc.on('close', () => {
      // "time=00:00:14.32" — pega o ÚLTIMO (o mais avançado do processamento).
      const all = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)]
      const m = all.length ? all[all.length - 1] : null
      if (!m) return resolve(0)
      const h = parseInt(m[1], 10) || 0, min = parseInt(m[2], 10) || 0, s = parseFloat(m[3]) || 0
      resolve(Math.round(h * 3600 + min * 60 + s))
    })
  })
}

// Grava o buffer JÁ TRANSCODIFICADO no disco da biblioteca, como <id>.ogg. Retorna
// { file, sizeBytes }. Cria a pasta na primeira vez.
export async function persistSavedAudio(id, oggBuffer) {
  await ensureDir()
  const file = `${id}.ogg`
  await writeFile(savedAudioPath(file), oggBuffer)
  return { file, sizeBytes: oggBuffer.length }
}

// Stream de leitura do .ogg (pro player do painel via rota). Confirma que existe antes.
export async function openSavedAudioStream(file) {
  const fp = savedAudioPath(file)
  await access(fp) // lança se não existir -> a rota devolve 404
  return createReadStream(fp)
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)) }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Envia um áudio salvo como NOTA DE VOZ (PTT) pelo Baileys. Mais humano que texto:
// mostra "gravando áudio..." por um tempo proporcional à duração antes de mandar.
//   sock   socket baileys conectado
//   jid    destino canônico (@s.whatsapp.net / @lid)
//   audio  linha da tabela saved_audio (precisa de .file e .duration_sec)
// ptt:true é o que faz o áudio aparecer com waveform de nota de voz (crítico).
// Retorna { providerMessageId } — o key.id real, pra dedupe do eco (igual sendText).
// A ONDA É UM CAMPO, NÃO UM EFEITO DA TELA.
//
// `ptt:true` faz a mensagem ser tratada como nota de voz, mas quem desenha as ondinhas é o
// array `waveform` que viaja NA mensagem — 64 bytes de amplitude, 0 a 100. Sem ele o
// WhatsApp mostra a barra reta, que foi a diferença que o gestor viu entre este sistema e o
// integração de referência. O `seconds` também vai explícito: sem ele o player mostra 0:00
// até terminar de baixar.
//
// Como é calculada: ffmpeg cospe PCM mono 16 bits a 8 kHz, a gente divide em 64 baldes e
// tira o RMS de cada um. É a mesma forma que o WhatsApp Web usa — som alto vira barra alta.
export async function waveformDe(arquivo) {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    const { stdout } = await exec(FFMPEG, ['-v', 'quiet', '-i', arquivo, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
    const amostras = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2))
    if (!amostras.length) return null
    const baldes = 64
    const tam = Math.floor(amostras.length / baldes) || 1
    const rms = []
    for (let b = 0; b < baldes; b++) {
      let soma = 0
      const ini = b * tam, fim = Math.min(ini + tam, amostras.length)
      for (let i = ini; i < fim; i++) soma += amostras[i] * amostras[i]
      rms.push(Math.sqrt(soma / Math.max(1, fim - ini)))
    }
    const pico = Math.max(...rms) || 1
    // Normaliza pelo pico do próprio áudio: uma gravação baixinha desenha onda igual à alta,
    // que é o que o app nativo faz. Piso 1 pra não sair barra invisível no silêncio.
    return Uint8Array.from(rms.map((v) => Math.max(1, Math.min(100, Math.round((v / pico) * 100)))))
  } catch {
    return null   // sem onda a mensagem ainda sai; só perde o desenho
  }
}

export async function sendSavedAudio(sock, jid, audio) {
  const buffer = await readFile(savedAudioPath(audio.file))
  const dur = Number(audio.duration_sec) || 0
  // "gravando áudio..." proporcional: base 2s + 350ms por segundo de áudio, preso em
  // [2.5s, 12s]. Presença 'recording' (não 'composing') = o "gravando áudio" nativo.
  await sock.sendPresenceUpdate('recording', jid).catch(() => {})
  await sleep(clamp(2000 + dur * 350, 2500, 12000))
  const waveform = await waveformDe(savedAudioPath(audio.file))
  const result = await sock.sendMessage(jid, {
    audio: buffer, ptt: true, mimetype: 'audio/ogg; codecs=opus',
    seconds: dur || undefined,
    ...(waveform ? { waveform } : {}),
  })
  await sock.sendPresenceUpdate('paused', jid).catch(() => {})
  return { providerMessageId: result && result.key ? result.key.id : undefined }
}
