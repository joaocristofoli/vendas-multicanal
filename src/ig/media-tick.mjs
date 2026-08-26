// Tick de interpretação de mídia do Instagram. GATED pelo setting `media_interpret` (default
// OFF): com ele desligado NÃO baixa, NÃO chama visão, NÃO gasta nada. Quando o dono ligar,
// pega as mídias pendentes (ig_media) e preenche a descrição (a visão é o que custa; a
// transcrição de áudio é local/grátis). A descrição vive em ig_media e o buildHistory a lê.
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { interpretMedia } from './media-interpret.mjs'
import { transcribeAudio } from '../wa/media.mjs'
import { pendingIgMedia, setIgMediaResult, getSetting, logEvent } from '../core/db.mjs'
import { gerarTexto } from '../ai/ia.mjs'
import { iaLigadaParaPessoa } from '../ai/uso.mjs'

// VISÃO: escreve os frames/imagens em arquivos temporários e manda pro Codex (input de
// imagem). É a única parte que consome tokens — só roda com o setting ligado.
async function describeImagesViaCodex(buffers, { context, usageMeta = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vendas-multicanal-vis-'))
  try {
    const paths = []
    for (let i = 0; i < buffers.length; i++) { const p = path.join(dir, `img-${i}.jpg`); await writeFile(p, buffers[i]); paths.push(p) }
    const prompt = [
      'Descreva de forma OBJETIVA e curta o que aparece na(s) imagem(ns).',
      context ? `Contexto: ${context}.` : '',
      'Se for meme ou print, diga o texto que aparece e a piada/assunto. 2 a 4 frases. Em português.',
    ].filter(Boolean).join('\n')
    const { text } = await gerarTexto({ prompt,
      baseInstructions: 'Você descreve imagens de forma objetiva pra dar contexto a quem não as viu. Não invente o que não dá pra ver.',
      effort: 'low',
      images: paths,
      usageMeta,
    })
    return String(text || '').trim()
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

// ÁUDIO (local/grátis): a transcrição do WhatsApp recebe CAMINHO de arquivo; aqui adaptamos
// pra receber o buffer (do vídeo) e devolver { text }.
async function transcribeBuffer(buffer) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vendas-multicanal-aud-'))
  try {
    const file = path.join(dir, 'media.mp4')
    await writeFile(file, buffer)
    return await transcribeAudio(file)
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

let ticking = false
export async function mediaInterpretTick({ accountKey } = {}) {
  // INTERRUPTOR MESTRE: sem isso ligado, não faz nada (não gasta). Ligar com setSetting('media_interpret', true).
  if (ticking || !getSetting('media_interpret', false)) return 0
  ticking = true
  let done = 0
  let attempted = 0
  try {
    // Busca uma janela maior porque as primeiras podem pertencer a conversas desligadas;
    // o teto de DUAS chamadas continua sendo aplicado por `attempted`.
    for (const row of pendingIgMedia(accountKey, 40)) {
      // A visão era um interruptor global separado e podia gastar em qualquer Direct. Agora
      // também exige o botão da IA nesta conversa. Linhas antigas sem pessoa aguardam o
      // próximo sync, que preenche person_id/thread_id sem apagar a descrição já pronta.
      if (!row.person_id || !iaLigadaParaPessoa(row.person_id, 'instagram')) continue
      if (attempted >= 2) break
      attempted++
      try {
        const r = await interpretMedia({
          kind: row.kind === 'video' || row.kind === 'reel' ? 'video' : 'imagem',
          src: row.src,
          describeImages: (buffers, opts) => describeImagesViaCodex(buffers, {
            ...opts,
            usageMeta: {
              origin: 'instagram_visao',
              trigger: 'automatico',
              personId: row.person_id,
              channel: 'instagram',
              detail: { tipo: row.kind, threadId: row.thread_id || null },
            },
          }),
          transcribeAudio: transcribeBuffer,
        })
        setIgMediaResult(row.mkey, { description: r.description, transcript: r.transcript, status: 'done' })
        logEvent({ type: 'ig_media_interpret', channel: 'instagram', detail: `${row.kind}: ${(r.description || '').slice(0, 80)}` })
        done++
      } catch (e) {
        setIgMediaResult(row.mkey, { status: 'error' })
        logEvent({ type: 'ig_media_error', channel: 'instagram', detail: e.message })
      }
    }
  } finally { ticking = false }
  return done
}
