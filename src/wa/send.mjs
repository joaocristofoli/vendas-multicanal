// Envio de texto com ritmo humano.
// O vendas-multicanal nunca "cospe" a mensagem: mostra que esta digitando (presenca
// 'composing'), espera um tempo proporcional ao tamanho do texto (com jitter),
// manda, e volta a presenca pra 'paused'. Coerente com o bot passivo — nunca
// enviamos 'available' (isso roubaria o status online do celular do PessoaOperadora).
// Ver ENTENDIMENTO-BAILEYS.md, secao "Presenca de digitacao (ritmo humano)".

// Espera assincrona simples.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Prende um valor no intervalo [min, max].
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

// Envia um texto para um JID simulando digitacao humana.
//   sock          socket baileys ja conectado
//   jid           JID de destino (canonico, @s.whatsapp.net)
//   text          texto a enviar
//   simulateTyping (default true) liga/desliga a presenca + o atraso
// Retorna { providerMessageId } — o key.id devolvido pelo baileys, que e o
// nosso comprovante de envio (equivalente ao comprovante DOM do Tinder).
export async function sendText(sock, jid, text, { simulateTyping = true } = {}) {
  if (simulateTyping) {
    // Sinaliza "digitando..." pra pessoa antes de mandar.
    await sock.sendPresenceUpdate('composing', jid)
    // Atraso proporcional ao tamanho do texto, com jitter aleatorio, preso
    // em [2200, 10500] ms. O jitter aqui e ritmo humano (nao determinismo
    // critico), entao Math.random e aceitavel.
    const jitter = Math.floor(Math.random() * 800)
    const alvo = 1700 + text.length * 30 + jitter
    await sleep(clamp(alvo, 2200, 10500))
  }

  const result = await sock.sendMessage(jid, { text })

  if (simulateTyping) {
    // Encerra a presenca de digitacao (nunca 'available').
    await sock.sendPresenceUpdate('paused', jid)
  }

  return { providerMessageId: result && result.key ? result.key.id : undefined }
}

// Envia uma FIGURINHA (webp) para um JID. buffer = bytes do .webp. O WhatsApp aceita
// figurinha estática ou animada em webp (idealmente 512x512). Retorna { providerMessageId }
// — o key.id do baileys, nosso comprovante de envio (igual ao sendText).
export async function sendSticker(sock, jid, buffer) {
  if (!buffer || !buffer.length) throw new Error('figurinha vazia')
  const result = await sock.sendMessage(jid, { sticker: buffer })
  return { providerMessageId: result && result.key ? result.key.id : undefined }
}

// Envia um VÍDEO. buffer = bytes do mp4. Sem "digitando" de propósito: subir mídia já demora,
// e o composing expira antes do envio terminar (ficaria "digitando..." mentindo). Retorna
// { providerMessageId } — o key.id do baileys, o comprovante de sempre.
//
// comoArquivo=true manda como DOCUMENTO (o "enviar como arquivo" do aplicativo). Os bytes são
// os mesmos nos dois formatos — provado por ida-e-volta em src/wa/fidelidade.mjs, sha256 igual
// nos dois. O que muda é como o outro lado RECEBE: documento chega com nome de arquivo e não
// entra no rolo da câmera, e o teto de tamanho é muito maior (documento ~2 GB contra ~64 MB
// de vídeo). Ver docs/BAIXAR-VIDEO.md.
export async function sendVideo(sock, jid, buffer, { caption = '', mimetype = 'video/mp4', comoArquivo = false, fileName = 'video.mp4' } = {}) {
  if (!buffer || !buffer.length) throw new Error('vídeo vazio')
  const conteudo = comoArquivo
    ? { document: buffer, mimetype, fileName, caption: caption || undefined }
    : { video: buffer, mimetype, caption: caption || undefined }
  const result = await sock.sendMessage(jid, conteudo)
  return { providerMessageId: result && result.key ? result.key.id : undefined }
}

// Envia uma ENQUETE (poll). Gera nós mesmos o messageSecret (a chave que decifra os votos)
// pra guardá-la e poder ler a resposta depois. selectableCount=1 (escolha única) ou N (múltipla).
// Retorna { providerMessageId, encKey (base64), key }.
export async function sendPoll(sock, jid, { name, values, selectableCount = 1 }) {
  const { randomBytes } = await import('node:crypto')
  const messageSecret = randomBytes(32)
  const r = await sock.sendMessage(jid, { poll: { name, values, selectableCount, messageSecret } })
  return { providerMessageId: r && r.key ? r.key.id : undefined, encKey: Buffer.from(messageSecret).toString('base64'), key: r && r.key ? r.key : null }
}

// Atraso inicial "humano" antes da primeira acao numa conversa: um numero
// aleatorio preso em [4000, 6200] ms. Usado por quem orquestra o envio pra
// nao responder instantaneamente.
export function humanInitialDelayMs() {
  return clamp(4000 + Math.floor(Math.random() * 2200), 4000, 6200)
}

// Quebra uma resposta em "bolhas" naturais (como gente digita no WhatsApp).
// 1) QUEBRA EXPLÍCITA: se o texto tem quebras de linha, cada linha É uma bolha —
//    é como a IA sinaliza "mandar em 2 mensagens" (ex. real do dono pra Beltrana:
//    "Essa sequência de plantão tá acabando com vc, meu bem" + "cuidado com isso,
//    cuida da sua saúde"). O teto padrão é 3; canais que suportam mais podem passá-lo
//    explicitamente, e o excedente sempre se junta na última.
// 2) Sem quebra de linha: textos curtos vao numa bolha so; maiores dividem por
//    frase agrupando ate ~120 chars, respeitando o mesmo teto. Nunca corta no meio de frase.
export function splitIntoBubbles(text, maxBubbles = 3) {
  const t = String(text || '').trim()
  const limite = Math.max(1, Math.min(5, Math.floor(Number(maxBubbles) || 3)))
  const compactar = (partes) => partes.length <= limite
    ? partes
    : [...partes.slice(0, limite - 1), partes.slice(limite - 1).join(' ')]
  const lines = t.split(/\n+/).map((s) => s.trim()).filter(Boolean)
  if (lines.length > 1) return compactar(lines)
  if (t.length <= 90) return t ? [t] : []
  const sentences = t.split(/(?<=[.?…])\s+/).map((s) => s.trim()).filter(Boolean)
  const bubbles = []
  let cur = ''
  for (const s of sentences) {
    if (cur && (cur + ' ' + s).length > 120) { bubbles.push(cur); cur = s } else cur = cur ? cur + ' ' + s : s
    if (bubbles.length >= limite - 1) break
  }
  const idx = bubbles.join(' ').length
  const rest = t.slice(idx).trim()
  if (rest) bubbles.push(rest)
  return bubbles.length ? bubbles.slice(0, limite) : [t]
}

// Envia uma resposta como um humano: quebra em bolhas e manda uma a uma, cada uma
// com presenca "digitando" proporcional ao tamanho e um respiro entre elas. Retorna
// { parts:[{text,id}], providerMessageId } — o id de cada bolha (o key.id REAL do
// WhatsApp, pra deduplicar contra o eco de messages.upsert) e o id da ultima.
export async function sendHumanReply(sock, jid, text) {
  const chunks = splitIntoBubbles(text)
  const parts = []
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(clamp(500 + chunks[i].length * 12, 600, 2600)) // respiro entre bolhas
    const r = await sendText(sock, jid, chunks[i]) // ja faz composing + atraso proporcional + paused
    parts.push({ text: chunks[i], id: r && r.providerMessageId })
  }
  return { parts, providerMessageId: parts.length ? parts[parts.length - 1].id : undefined }
}
