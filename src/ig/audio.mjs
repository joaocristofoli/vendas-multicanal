// A IA VOLTA A OUVIR OS ÁUDIOS DO INSTAGRAM.
//
// Como era: o caminho do DOM clicava em "View transcription" e o texto que a META transcreve
// virava mensagem. Funcionava, mas dependia de aceitar o termo da Meta, entrava no histórico
// SEM selo de áudio (parecia mensagem digitada) e morria junto com o scraping.
//
// Como é agora: a API entrega `voice_media.media.audio.audio_src`, então dá pra baixar o
// arquivo e transcrever com o MESMO whisper local que já transcreve o áudio do WhatsApp
// (tools/transcribe.py). Isso derruba a razão pela qual esse caminho tinha sido descartado em
// 23/07/2026 — na época o Instagram não expunha `<audio src>` em lugar nenhum.
//
// Três ganhos sobre o jeito antigo: não depende da Meta, o áudio continua marcado COMO áudio
// (`media_json`) e a transcrição é a mesma engine dos outros canais.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { db, logEvent } from '../core/db.mjs'
import { transcribeAudio } from '../wa/media.mjs'
import { downloadMedia } from './media-interpret.mjs'
import { sessaoDoChrome } from './api.mjs'

// O texto que a API grava enquanto ninguém ouviu ainda. É por ele que se acha o que falta.
export const MARCADOR = '[áudio]'
const MAX_POR_VEZ = 4

// Os áudios do Instagram que ainda não têm transcrição. Não usa coluna nova de propósito: o
// estado "já transcrevi" É o texto ter deixado de ser o marcador — uma verdade só, sem
// contador paralelo pra discordar dela.
export function audiosPendentes(limite = MAX_POR_VEZ) {
  return db().prepare(`SELECT message_id, person_id, text, media_json FROM message
    WHERE channel='instagram' AND text=? AND media_json IS NOT NULL
    ORDER BY ts DESC LIMIT ?`).all(MARCADOR, limite)
}

async function baixarETranscrever(src, cookie) {
  const buf = await downloadMedia(src, { cookieHeader: cookie })
  const arq = path.join(os.tmpdir(), `ig-audio-${Date.now()}-${Math.floor(buf.length % 100000)}.m4a`)
  fs.writeFileSync(arq, buf)
  try { return await transcribeAudio(arq) }
  finally { try { fs.unlinkSync(arq) } catch { /* tmp */ } }
}

// Um tick. Poucos por vez porque o whisper é local e come CPU da VM, que é a mesma que roda o
// Chrome. O que não couber volta no próximo — a fila é o próprio banco.
export async function transcreverAudiosIg({ limite = MAX_POR_VEZ } = {}) {
  const pendentes = audiosPendentes(limite)
  if (!pendentes.length) return { pendentes: 0, transcritos: 0 }
  let cookie = null
  try { cookie = (await sessaoDoChrome()).cookie } catch { /* sem sessão: as URLs autenticadas vão falhar e o item volta depois */ }
  let transcritos = 0
  for (const m of pendentes) {
    let src = null
    try { src = JSON.parse(m.media_json)?.src || null } catch { /* media_json torto */ }
    if (!src) continue
    try {
      const r = await baixarETranscrever(src, cookie)
      const texto = String(r?.text || '').trim()
      if (!texto) { logEvent({ type: 'ig_audio_sem_texto', detail: r?.error || 'transcrição vazia' }); continue }
      // O media_json fica: a mensagem continua sendo um ÁUDIO que por acaso tem texto, e não
      // um texto que apareceu do nada no histórico (era assim no caminho do DOM).
      db().prepare(`UPDATE message SET text=? WHERE message_id=?`).run(texto, m.message_id)
      transcritos++
      logEvent({ type: 'ig_audio_transcrito', personId: m.person_id, detail: texto.slice(0, 90) })
    } catch (e) {
      // URL de mídia do Instagram EXPIRA. Quando isso acontece o áudio não volta — marcar aqui
      // evita tentar o mesmo arquivo morto pra sempre, e diz a verdade no histórico.
      const morta = /40[34]|410/.test(String(e.message))
      if (morta) db().prepare(`UPDATE message SET text=? WHERE message_id=?`).run('[áudio que não deu pra ouvir]', m.message_id)
      logEvent({ type: 'ig_audio_erro', detail: `${e.message}${morta ? ' (link expirado)' : ''}` })
    }
  }
  return { pendentes: pendentes.length, transcritos }
}
