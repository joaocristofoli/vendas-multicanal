// Envio AVANÇADO no WhatsApp: um despachante único que constrói o conteúdo certo do Baileys
// pra cada tipo de mensagem (texto rico, mídia, enquete, evento, localização, contato, reação,
// pin, editar, apagar, view once, ephemeral, externalAdReply, e os interativos experimentais).
//
// O CATÁLOGO (embaixo) é a fonte da verdade: descreve cada tipo, seus campos e se costuma
// funcionar em conta pessoal. O painel monta a UI a partir dele; a doc sai dele; o teste varre
// ele. Ver docs/WHATSAPP-TIPOS-MENSAGEM.md.
import fs from 'node:fs'
import path from 'node:path'
import { getBaileys } from './baileys.mjs'
import { MEDIA_DIR as MEDIA_DIR_PADRAO } from '../core/caminhos.mjs'

const MEDIA_DIR = MEDIA_DIR_PADRAO

// Resolve a fonte de mídia pro formato do Baileys: url (ele baixa), arquivo local em MEDIA_DIR,
// ou base64. Retorna algo aceito por WAMediaUpload.
function midia(spec) {
  if (spec && typeof spec.url === 'string' && /^https?:\/\//.test(spec.url)) return { url: spec.url }
  if (spec && typeof spec.file === 'string' && /^[A-Za-z0-9_.-]+$/.test(spec.file)) {
    const fp = path.join(MEDIA_DIR, spec.file)
    if (fp.startsWith(MEDIA_DIR) && fs.existsSync(fp)) return fs.readFileSync(fp)
  }
  if (spec && typeof spec.base64 === 'string') return Buffer.from(spec.base64, 'base64')
  throw new Error('sem mídia (passe url, file ou base64)')
}

// vcard mínimo válido a partir de nome + telefone.
function vcard({ nome, telefone }) {
  const tel = String(telefone || '').replace(/[^\d+]/g, '')
  return `BEGIN:VCARD\nVERSION:3.0\nFN:${nome || tel}\nTEL;type=CELL;waid=${tel.replace(/\D/g, '')}:${tel}\nEND:VCARD`
}

// contextInfo de externalAdReply (o "card" rico de link, sem ser preview de verdade).
function externalAdReply(p = {}) {
  return {
    externalAdReply: {
      title: p.titulo || 'Título',
      body: p.corpo || '',
      mediaType: p.mediaType || 1, // 1=imagem, 2=vídeo
      thumbnailUrl: p.thumbnailUrl || undefined,
      sourceUrl: p.sourceUrl || undefined,
      renderLargerThumbnail: p.grande !== false,
    },
  }
}

// Monta { content, options } pro sock.sendMessage. `ctx` traz o alvo de reação/edição/reply.
export async function buildContent(spec, ctx = {}) {
  const t = spec.type
  const options = {}
  if (spec.quoted) options.quoted = spec.quoted // reply: mensagem citada (objeto WAMessage)

  switch (t) {
    case 'text':
      return { content: { text: String(spec.texto || ''), ...(spec.linkPreview === false ? { linkPreview: null } : {}) }, options }
    case 'mention': // texto mencionando alguém (precisa do jid no texto como @numero)
      return { content: { text: String(spec.texto || ''), mentions: spec.mentions || [] }, options }
    case 'spoiler': // texto/mídia oculto até tocar — via contextInfo
      return { content: { text: String(spec.texto || ''), contextInfo: { ...(spec.contextInfo || {}) } }, options }
    case 'reply': // responde uma mensagem citando-a
      return { content: { text: String(spec.texto || '') }, options: { ...options, quoted: spec.quoted || ctx.quoted } }

    case 'image':
      return { content: { image: midia(spec), caption: spec.caption || undefined, viewOnce: !!spec.viewOnce }, options }
    case 'video':
      return { content: { video: midia(spec), caption: spec.caption || undefined, gifPlayback: !!spec.gif, ptv: !!spec.ptv, viewOnce: !!spec.viewOnce }, options }
    case 'gif':
      return { content: { video: midia(spec), gifPlayback: true, caption: spec.caption || undefined }, options }
    case 'ptv': // vídeo redondo (video note)
      return { content: { video: midia(spec), ptv: true }, options }
    case 'audio':
      return { content: { audio: midia(spec), mimetype: spec.mimetype || 'audio/mp4', ptt: false, seconds: spec.seconds || undefined }, options }
    case 'voice': // nota de voz (ptt)
      return { content: { audio: midia(spec), mimetype: spec.mimetype || 'audio/ogg; codecs=opus', ptt: true, seconds: spec.seconds || undefined }, options }
    case 'document':
      return { content: { document: midia(spec), mimetype: spec.mimetype || 'application/pdf', fileName: spec.fileName || 'arquivo', caption: spec.caption || undefined }, options }
    case 'sticker':
      return { content: { sticker: midia(spec), isAnimated: !!spec.animado }, options }

    case 'location':
      return { content: { location: { degreesLatitude: Number(spec.lat), degreesLongitude: Number(spec.lng), name: spec.nome || undefined, address: spec.endereco || undefined } }, options }
    case 'contact':
      return { content: { contacts: { displayName: spec.nome || 'Contato', contacts: [{ vcard: vcard(spec) }] } }, options }
    case 'poll':
      return { content: { poll: { name: spec.pergunta || 'Enquete', values: (spec.opcoes || []).map(String), selectableCount: spec.multipla ? (spec.opcoes || []).length : 1 } }, options }
    case 'event':
      return { content: { event: { name: spec.nome || 'Evento', description: spec.descricao || undefined, startDate: spec.inicio ? new Date(spec.inicio) : new Date(ctx.now || 0), endDate: spec.fim ? new Date(spec.fim) : undefined, location: spec.local ? { degreesLatitude: Number(spec.lat || 0), degreesLongitude: Number(spec.lng || 0), name: spec.local } : undefined } }, options }
    case 'externalAdReply':
      return { content: { text: String(spec.texto || ' '), contextInfo: externalAdReply(spec) }, options }

    // ---- operações sobre uma mensagem existente (precisam da key alvo) ----
    case 'react':
      // O padrão é ❤ e não 👍 porque a reação sai NO NOME da dona, e o arquivo de voz dela
      // diz "nunca 👍". O campo `emoji` do painel é opcional: deixar em branco mandava, em
      // nome dela, o único emoji que ela não usa.
      return { content: { react: { text: spec.emoji || '❤', key: spec.targetKey || ctx.targetKey } }, options }
    case 'pin':
      return { content: { pin: spec.targetKey || ctx.targetKey, type: spec.desafixar ? 2 : 1, time: spec.time || 86400 }, options }
    case 'edit':
      return { content: { text: String(spec.texto || ''), edit: spec.targetKey || ctx.targetKey }, options }
    case 'delete':
      return { content: { delete: spec.targetKey || ctx.targetKey }, options }
    case 'ephemeral': // liga/desliga mensagens temporárias na conversa
      return { content: { disappearingMessagesInChat: spec.segundos != null ? Number(spec.segundos) : (spec.ligar ? 604800 : false) }, options }

    // ---- INTERATIVOS (experimentais; costumam falhar/ignorar em conta pessoal) ----
    case 'buttons':
    case 'list':
    case 'interactive':
    case 'template':
      return { raw: await buildInteractive(t, spec), options }

    default:
      throw new Error(`tipo desconhecido: ${t}`)
  }
}

// Interativos via mensagem CRUA (proto) — Baileys não tem atalho estável e o WhatsApp pessoal
// tende a ignorar. Construído mesmo assim pra provar/documentar o comportamento real.
async function buildInteractive(t, spec) {
  const bl = await import('baileys')
  const proto = bl.proto
  if (t === 'buttons') {
    return { buttonsMessage: { contentText: spec.texto || 'Escolha', footerText: spec.rodape || '', headerType: 1,
      buttons: (spec.botoes || ['A', 'B']).map((b, i) => ({ buttonId: `b${i}`, buttonText: { displayText: String(b) }, type: 1 })) } }
  }
  if (t === 'list') {
    return { listMessage: { title: spec.titulo || 'Lista', description: spec.descricao || '', buttonText: spec.botao || 'Abrir', listType: 1,
      sections: [{ title: spec.secao || 'Seção', rows: (spec.itens || ['Item 1', 'Item 2']).map((r, i) => ({ title: String(r), rowId: `r${i}` })) }] } }
  }
  if (t === 'interactive') {
    return { interactiveMessage: proto.Message.InteractiveMessage.create({
      body: { text: spec.texto || 'Corpo' }, footer: { text: spec.rodape || '' },
      nativeFlowMessage: { buttons: (spec.botoes || []).map((b) => ({ name: b.name || 'quick_reply', buttonParamsJson: JSON.stringify(b.params || { display_text: b.texto || 'Botão', id: b.id || 'id' }) })) } }) }
  }
  // template (hydrated)
  return { templateMessage: { hydratedTemplate: { hydratedContentText: spec.texto || 'Template', hydratedFooterText: spec.rodape || '',
    hydratedButtons: (spec.botoes || []).map((b, i) => ({ index: i, quickReplyButton: { displayText: String(b.texto || b), id: b.id || `q${i}` } })) } } }
}

// Envia de verdade. Retorna { providerMessageId }.
export async function sendAdvanced(sock, jid, spec, ctx = {}) {
  const built = await buildContent(spec, ctx)
  let result
  if (built.raw) {
    const { generateWAMessageFromContent } = await getBaileys()
    const msg = generateWAMessageFromContent(jid, built.raw, { userJid: sock.user?.id })
    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id })
    result = msg
  } else {
    result = await sock.sendMessage(jid, built.content, built.options)
  }
  return { providerMessageId: result && result.key ? result.key.id : undefined }
}

// CATÁLOGO — dirige UI, doc e teste. `precisaAlvo`: opera sobre uma mensagem existente.
// `midia`: precisa de arquivo/URL. `pessoal`: expectativa em conta pessoal ('ok'|'talvez'|'nao').
export const CATALOGO = [
  { type: 'text', label: 'Texto', pessoal: 'ok', campos: ['texto', 'linkPreview'] },
  { type: 'reply', label: 'Responder (citar)', pessoal: 'ok', precisaAlvo: true, campos: ['texto'] },
  { type: 'mention', label: 'Menção', pessoal: 'ok', campos: ['texto', 'mentions'] },
  { type: 'spoiler', label: 'Spoiler (oculto)', pessoal: 'talvez', campos: ['texto'] },
  { type: 'image', label: 'Imagem', pessoal: 'ok', midia: true, campos: ['url|file', 'caption', 'viewOnce'] },
  { type: 'video', label: 'Vídeo', pessoal: 'ok', midia: true, campos: ['url|file', 'caption', 'viewOnce'] },
  { type: 'gif', label: 'GIF (vídeo em loop)', pessoal: 'ok', midia: true, campos: ['url|file'] },
  { type: 'ptv', label: 'Vídeo redondo (nota)', pessoal: 'talvez', midia: true, campos: ['url|file'] },
  { type: 'audio', label: 'Áudio (arquivo)', pessoal: 'ok', midia: true, campos: ['url|file'] },
  { type: 'voice', label: 'Nota de voz (ptt)', pessoal: 'ok', midia: true, campos: ['url|file'] },
  { type: 'document', label: 'Documento', pessoal: 'ok', midia: true, campos: ['url|file', 'fileName', 'mimetype', 'caption'] },
  { type: 'sticker', label: 'Figurinha', pessoal: 'ok', midia: true, campos: ['url|file', 'animado'] },
  { type: 'location', label: 'Localização', pessoal: 'ok', campos: ['lat', 'lng', 'nome', 'endereco'] },
  { type: 'contact', label: 'Contato (vCard)', pessoal: 'ok', campos: ['nome', 'telefone'] },
  { type: 'poll', label: 'Enquete', pessoal: 'ok', campos: ['pergunta', 'opcoes', 'multipla'] },
  { type: 'event', label: 'Evento', pessoal: 'talvez', campos: ['nome', 'descricao', 'inicio', 'fim', 'local'] },
  { type: 'externalAdReply', label: 'Card de link (ad reply)', pessoal: 'talvez', campos: ['texto', 'titulo', 'corpo', 'sourceUrl', 'thumbnailUrl'] },
  { type: 'react', label: 'Reação (emoji)', pessoal: 'ok', precisaAlvo: true, campos: ['emoji'] },
  { type: 'pin', label: 'Fixar mensagem', pessoal: 'talvez', precisaAlvo: true, campos: ['time', 'desafixar'] },
  { type: 'edit', label: 'Editar mensagem', pessoal: 'ok', precisaAlvo: true, campos: ['texto'] },
  { type: 'delete', label: 'Apagar p/ todos', pessoal: 'ok', precisaAlvo: true, campos: [] },
  { type: 'ephemeral', label: 'Mensagens temporárias', pessoal: 'ok', campos: ['ligar', 'segundos'] },
  { type: 'buttons', label: 'Botões (legado)', pessoal: 'nao', campos: ['texto', 'botoes'] },
  { type: 'list', label: 'Lista (legado)', pessoal: 'nao', campos: ['titulo', 'itens'] },
  { type: 'interactive', label: 'Interativo (nativo)', pessoal: 'nao', campos: ['texto', 'botoes'] },
  { type: 'template', label: 'Template hidratado', pessoal: 'nao', campos: ['texto', 'botoes'] },
]
