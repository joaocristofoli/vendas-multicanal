// Lado ALTO (inteligente) dos áudios salvos: o que a IA vê no prompt e como o rascunho
// dela vira envio de áudio. Funções PURAS de propósito (sem fs/rede/banco) pra dar pra
// testar tudo sem socket. O acesso a banco/disco fica no index/autoreply; aqui é só regra.
//
// Fluxo: generateDraft monta a lista `savedAudios` (uma linha por áudio, com o resumo da
// transcrição) e injeta no prompt (bloco opt-in em ai/prompt.mjs). Se a IA decidir mandar
// um áudio, ela escreve o marcador [audio:atalho] SOZINHO numa linha; splitDraftAudio
// separa as linhas de texto das de áudio, preservando a ordem entre as bolhas.

// Marcador de áudio numa linha inteira: [audio:atalho]. Slug = [a-z0-9-] (casa o slug do
// shortcut no banco). Só vale a linha INTEIRA (âncoras ^$) pra não confundir com texto.
const AUDIO_LINE = /^\[audio:([a-z0-9-]+)\]$/

// Resumo curto de uma transcrição pra caber na lista do prompt sem estourar o contexto.
// Uma linha, sem quebras; corta em ~180 chars com reticências.
function summarizeTranscript(text, max = 180) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1).trimEnd() + '…'
}

// Monta a string `savedAudios` pro prompt a partir das linhas ATIVAS que já têm
// transcrição pronta (status 'done' e transcript não-vazio — a IA precisa saber o que o
// áudio DIZ pra escolher). Retorna '' quando não há nenhum utilizável (aí o prompt fica
// idêntico ao de antes). Cada item: "- [audio:atalho] (Xs): "resumo" — quando usar: ...".
export function buildSavedAudiosPrompt(audios) {
  const lines = []
  for (const a of audios || []) {
    if (!a || !a.active) continue
    if (a.transcript_status !== 'done') continue
    const transcript = String(a.transcript || '').trim()
    if (!transcript) continue
    const dur = Number(a.duration_sec) || 0
    const when = String(a.descricao || '').replace(/\s+/g, ' ').trim()
    lines.push(`- [audio:${a.shortcut}] (${dur}s): "${summarizeTranscript(transcript)}"`
      + (when ? ` — quando usar: ${summarizeTranscript(when, 120)}` : ''))
  }
  return lines.join('\n')
}

// Separa o rascunho da IA em segmentos ORDENADOS de texto e áudio. Cada linha que casa
// [audio:atalho] vira { kind:'audio', slug }; as demais linhas (agrupadas até o próximo
// marcador) viram { kind:'text', text }. Preserva a ordem em que aparecem, pra intercalar
// bolhas de texto e áudio como a IA pediu. Não valida se o slug existe (isso é guardrail
// no envio) — aqui é só o parse estrutural.
export function splitDraftAudio(draft) {
  const rawLines = String(draft || '').split(/\n+/)
  const segments = []
  let textBuf = []
  const flush = () => { const t = textBuf.join('\n').trim(); if (t) segments.push({ kind: 'text', text: t }); textBuf = [] }
  for (const line of rawLines) {
    const m = line.trim().match(AUDIO_LINE)
    if (m) { flush(); segments.push({ kind: 'audio', slug: m[1] }) }
    else textBuf.push(line)
  }
  flush()
  return segments
}
