// Lado ALTO (inteligente) das FOTOS salvas: o que a IA vê no prompt e como o rascunho dela
// vira envio de foto. Funções PURAS (sem fs/rede/banco), igual ao irmão saved-audio-ai.mjs.
//
// A DIFERENÇA QUE DECIDE O DESENHO: o áudio ganha a transcrição sozinho (whisper), então o
// sistema sabe o que ele DIZ. A foto não tem de onde — quem diz o que ela mostra é a
// descrição escrita pela dona. Por isso foto sem descrição NÃO entra na lista: a IA não
// teria como escolher, e escolher no escuro é mandar foto errada.
//
// Fluxo: generateDraft monta `savedImages` (uma linha por foto) e injeta no prompt. Se a IA
// decidir mandar, escreve [foto:atalho] SOZINHO numa linha; splitDraftMidia separa texto e
// mídia preservando a ordem.

// Marcador de foto numa linha inteira: [foto:atalho]. Mesmas âncoras do áudio, pra não
// confundir com texto que por acaso contenha colchetes.
const FOTO_LINE = /^\[foto:([a-z0-9-]+)\]$/
const AUDIO_LINE = /^\[audio:([a-z0-9-]+)\]$/

function resumo(text, max = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1).trimEnd() + '…'
}

// Monta a lista pro prompt. Entram SÓ as fotos ativas, de nível 'livre' e COM descrição.
//
// A foto 'travada' não é filtrada aqui por acaso: ela não pode nem ser renderizada. Mesma
// política do fato 'nunca' em src/self/fatos.mjs — o modelo não vaza o que não recebeu.
// Quem chama já deve passar só as livres (listSavedImages({apenasLivres:true})); este filtro
// é o cinto, caso alguém chame com a lista inteira.
// A lista de fotos que a IA enxerga, JÁ com o vínculo de necessidade resolvido. Mora aqui e
// não no autoreply pra existir um caminho só: se a resolução ficasse na chamada, um teste que
// a repetisse continuaria verde depois de ela sumir do código de verdade.
// `permitirQuente` vem da ETIQUETA da conversa (ver `etiquetaAbreFotoQuente`): cliente que
// veio de anúncio adulto pode receber foto sensual; conversa comum, não. Foto de nível
// `familia` NUNCA entra, com etiqueta nenhuma — a lista nem a carrega.
// VÍDEO (07/10/2026) entra na mesma lista, marcado, mas só no canal que consegue mandar: o
// Instagram e o Badoo enviam pela página e só foto foi provada lá. Oferecer à IA o que o canal
// não entrega é o "cheque sem fundo" de ai/promessa-midia.mjs.
export const CANAIS_SEM_VIDEO = new Set(['instagram', 'badoo'])
const ehVideo = (f) => /\.mp4$/i.test(String(f?.file || ''))

export async function fotosParaPrompt({ permitirQuente = false, canal = null } = {}) {
  const { listSavedImages } = await import('../core/db.mjs')
  const { necessidadesDaFoto } = await import('../necessidades/store.mjs')
  const { servicosDaFoto } = await import('../self/servicos.mjs')
  const semVideo = !canal || CANAIS_SEM_VIDEO.has(canal)
  return listSavedImages({ activeOnly: true, niveis: permitirQuente ? ['livre', 'quente'] : ['livre'] }).filter((f) => !(semVideo && ehVideo(f))).map((f) => ({
    ...f,
    necessidades: (() => { try { return necessidadesDaFoto(f.id) } catch { return [] } })(),
    servicos: (() => { try { return servicosDaFoto(f.id) } catch { return [] } })(),
  }))
}

export function buildSavedImagesPrompt(imagens) {
  const lines = []
  for (const f of imagens || []) {
    if (!f || !f.active) continue
    if (f.nivel === 'travada' || f.nivel === 'familia') continue   // cinto: nem renderiza
    const desc = String(f.descricao || '').replace(/\s+/g, ' ').trim()
    if (!desc) continue                       // sem descrição a IA escolheria no escuro
    // DUAS PERGUNTAS, DUAS RESPOSTAS. "O que mostra" evita mandar a foto errada; "quando
    // mandar" evita mandar a foto certa na hora errada — que é o defeito mais caro dos dois,
    // porque a pessoa do outro lado sente o descompasso na hora.
    const ctx = String(f.contexto || '').replace(/\s+/g, ' ').trim()
    // VÍNCULO COM NECESSIDADE (opcional). Quando existe, ele é MAIS FORTE que o contexto
    // escrito: a foto foi amarrada a um assunto específico, então mandá-la fora dele é usar a
    // foto de alguém pra outra coisa. Quem monta a lista já resolve os nomes (f.necessidades).
    const necs = (f.necessidades || []).map((n) => String(n.descricao || '').trim()).filter(Boolean)
    // VÍNCULO COM SERVIÇO (opcional, 14/08/2026). Mesma força do vínculo com necessidade e pelo
    // mesmo motivo: a foto foi amarrada a um assunto. Aqui o assunto é o serviço, e o preço vem
    // junto — é o que faz a foto valer como exemplo do que ela está cobrando, e não uma foto
    // solta no meio da negociação.
    const servs = (f.servicos || [])
      .map((s) => [String(s.nome || '').trim(), String(s.precos || '').trim()].filter(Boolean).join(' — '))
      .filter(Boolean)
    const amarras = [...necs, ...servs]
    const dur = Number(f.duration_sec) || 0
    const tipo = ehVideo(f) ? ` (vídeo${dur ? ` de ${dur} s` : ''})` : ''
    const partes = [`- [foto:${f.shortcut}]${tipo}: ${resumo(desc)}`]
    if (amarras.length) partes.push(`— SÓ quando a conversa for sobre: ${resumo(amarras.join('; '), 200)}`)
    else if (ctx) partes.push(`— MANDAR QUANDO: ${resumo(ctx, 120)}`)
    if (amarras.length && ctx) partes.push(`(contexto: ${resumo(ctx, 80)})`)
    lines.push(partes.join(' '))
  }
  return lines.join('\n')
}

// Separa o rascunho em segmentos ORDENADOS de texto, áudio e foto. Generaliza o
// splitDraftAudio (que continua existindo e se comportando igual) porque uma resposta pode
// ter as duas mídias, e duplicar o parser criaria duas ordens possíveis pro mesmo rascunho.
export function splitDraftMidia(draft) {
  const rawLines = String(draft || '').split(/\n+/)
  const segments = []
  let textBuf = []
  const flush = () => { const t = textBuf.join('\n').trim(); if (t) segments.push({ kind: 'text', text: t }); textBuf = [] }
  for (const line of rawLines) {
    const l = line.trim()
    const mFoto = l.match(FOTO_LINE)
    if (mFoto) { flush(); segments.push({ kind: 'foto', slug: mFoto[1] }); continue }
    const mAudio = l.match(AUDIO_LINE)
    if (mAudio) { flush(); segments.push({ kind: 'audio', slug: mAudio[1] }); continue }
    textBuf.push(line)
  }
  flush()
  return segments
}
