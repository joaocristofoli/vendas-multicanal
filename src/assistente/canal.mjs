// O CANO do self-chat: como o vendas-multicanal escreve pro dono no WhatsApp e como sabe distinguir
// o que ELE escreveu do que NÓS escrevemos.
//
// No self-chat não existe "recebida": tudo é fromMe. Então a única forma honesta de saber
// quem escreveu é registrar o id REAL de cada mensagem que sai daqui. São três cintos, em
// ordem de confiança, porque um eco infinito no WhatsApp é o pior defeito possível:
//   1. id — toda mensagem nossa é gravada com o key.id do WhatsApp (assistente_msg).
//   2. texto — mesmo texto que saiu de nós nos últimos 15 min não vira comando.
//   3. disjuntor — no máximo N respostas por minuto; estourou, para e loga.
import fs from 'node:fs'
import path from 'node:path'
import { addAssistMsg, assistMsgByWaId, assistEnviouTextoRecente, assistRespostasDesde, logEvent, getSetting, saveWaPoll } from '../core/db.mjs'
import { sendText, sendPoll, sendVideo } from '../wa/send.mjs'
import { selfJidDaConta } from './guarda.mjs'

const JANELA_DISJUNTOR_MS = 60 * 1000
// 12/min: um eco de verdade dispara dezenas por minuto; 8 pegava o dono mandando comando
// em rajada (o próprio teste tropeçou nisso), e freio que morde sem motivo vira feature
// desligada.
const MAX_RESPOSTAS_POR_MINUTO = 12

// Envia uma mensagem no self-chat e REGISTRA o id — o registro é o que impede o eco.
// Sem sock (WhatsApp desconectado) grava mesmo assim: a conversa do painel continua
// funcionando e a mensagem fica no histórico, só não chegou no celular.
export async function enviarNoSelfChat({ sock, accountKey = 'main', texto, origem = 'sistema', acoes = null }) {
  const t = String(texto || '').trim()
  if (!t) return { ok: false, motivo: 'vazio' }
  const jid = selfJidDaConta(accountKey)
  let waMsgId = null
  let entregue = false
  if (sock && jid) {
    // Falha de envio ESTOURA de propósito e nada é gravado: quem chama (o lembrete) precisa
    // saber que não entregou pra tentar de novo no próximo tick. Engolir o erro aqui faria
    // o lembrete ser marcado como disparado sem nunca ter chegado.
    // simulateTyping:false: com o dono o vendas-multicanal é utilitário, não finge humano.
    const r = await sendText(sock, jid, t, { simulateTyping: false })
    waMsgId = r?.providerMessageId || null
    entregue = true
  }
  const id = addAssistMsg({ papel: 'vendas-multicanal', origem, texto: t, waMsgId, acoes })
  return { ok: true, id, waMsgId, entregue }
}

// Manda um ARQUIVO DE VÍDEO no self-chat. Registra o id igual ao texto — o registro é o que
// impede o eco, e não é teoria: sem ele, a mensagem voltaria pelo messages.upsert como se fosse
// ele falando (no self-chat tudo é fromMe). Hoje o portão do índice já ignora mensagem com
// mídia, mas depender de um segundo portão que não é deste módulo é como o eco volta um dia.
export async function enviarVideoNoSelfChat({ sock, accountKey = 'main', caminho, legenda = '', origem = 'sistema', comoArquivo = false }) {
  const jid = selfJidDaConta(accountKey)
  if (!sock || !jid) return { ok: false, motivo: 'whatsapp desconectado' }
  if (!caminho || !fs.existsSync(caminho)) return { ok: false, motivo: 'arquivo não existe' }
  const buf = fs.readFileSync(caminho)
  const r = await sendVideo(sock, jid, buf, { caption: legenda, comoArquivo, fileName: path.basename(caminho) })
  const marcador = comoArquivo ? '[arquivo]' : '[vídeo]'
  const id = addAssistMsg({ papel: 'vendas-multicanal', origem, texto: legenda ? `${marcador} ${legenda}` : marcador, waMsgId: r?.providerMessageId || null })
  return { ok: true, id, waMsgId: r?.providerMessageId || null, bytes: buf.length, comoArquivo }
}

// Envia uma ENQUETE no self-chat (pergunta de múltipla escolha). Guarda a enquete com o
// messageSecret pra decifrar o voto do dono depois. multipla=true deixa escolher mais de uma.
// Registra no histórico do assistente um marcador legível ("[enquete] pergunta: a, b, c").
export async function enviarEnqueteNoSelfChat({ sock, accountKey = 'main', pergunta, opcoes, multipla = false }) {
  const jid = selfJidDaConta(accountKey)
  const values = (Array.isArray(opcoes) ? opcoes : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12)
  if (!sock || !jid || !pergunta || values.length < 2) {
    // sem como mandar enquete: cai pra texto (a pergunta + as opções numeradas)
    const txt = `${pergunta}\n${values.map((v, i) => `${i + 1}. ${v}`).join('\n')}`.trim()
    const id = addAssistMsg({ papel: 'vendas-multicanal', origem: 'whatsapp', texto: txt || String(pergunta || '') })
    return { ok: false, motivo: 'sem_enquete', id }
  }
  const selectableCount = multipla ? values.length : 1
  const r = await sendPoll(sock, jid, { name: String(pergunta), values, selectableCount })
  if (r.providerMessageId) {
    saveWaPoll({ msgId: r.providerMessageId, accountKey, personId: 'wa:' + jid, jid, question: String(pergunta), options: values, encKey: r.encKey, creatorJid: jid, multipla })
  }
  const marcador = `[enquete${multipla ? ' (várias)' : ''}] ${pergunta} — ${values.join(' · ')}`
  const id = addAssistMsg({ papel: 'vendas-multicanal', origem: 'whatsapp', texto: marcador, waMsgId: r.providerMessageId || null })
  return { ok: true, id, waMsgId: r.providerMessageId }
}

// "digitando..." enquanto o vendas-multicanal pensa. O WhatsApp expira o 'composing' sozinho em ~10s,
// então tem que bater de novo enquanto o turno roda (um turno leva 6-12s, às vezes mais).
// Devolve a função que encerra (manda 'paused'). Nunca manda 'available': isso roubaria o
// status online do celular do dono, que é a regra do projeto desde o começo.
export function mostrarDigitando({ sock, accountKey = 'main' }) {
  const jid = selfJidDaConta(accountKey)
  if (!sock || !jid) return async () => {}
  let vivo = true
  const bater = () => { if (vivo) Promise.resolve(sock.sendPresenceUpdate('composing', jid)).catch(() => {}) }
  bater()
  const timer = setInterval(bater, 8000)
  // Cinto: se alguém esquecer de encerrar (ou o turno morrer de um jeito não previsto),
  // "digitando..." eterno é pior que nenhum. Para sozinho em 3 min.
  const limite = setTimeout(() => { vivo = false; clearInterval(timer) }, 180000)
  if (typeof limite.unref === 'function') limite.unref()
  return async () => {
    if (!vivo) return
    vivo = false
    clearInterval(timer)
    clearTimeout(limite)
    try { await sock.sendPresenceUpdate('paused', jid) } catch { /* presença é enfeite, nunca derruba a resposta */ }
  }
}

// Esta mensagem que chegou do WhatsApp é ECO de algo que nós mandamos?
export function ehEcoNosso({ waMsgId, texto }) {
  if (waMsgId && assistMsgByWaId(waMsgId)) return true
  if (assistEnviouTextoRecente(texto)) return true
  return false
}

// Disjuntor: se o assistente já respondeu demais no último minuto, alguma coisa está em
// laço — para de responder e deixa rastro. Volta sozinho quando a janela passa.
export function disjuntorAberto() {
  const n = assistRespostasDesde(Date.now() - JANELA_DISJUNTOR_MS)
  if (n < MAX_RESPOSTAS_POR_MINUTO) return false
  logEvent({ type: 'assistente_disjuntor', detail: `${n} respostas em 60s — pausado` })
  return true
}

// O assistente está ligado? (interruptor geral, reversível a qualquer momento)
export function assistenteLigado() { return getSetting('assistente_enabled', true) !== false }
