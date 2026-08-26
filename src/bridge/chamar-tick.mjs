// Executor do "chamar primeiro" (F7). Separado do chamar.mjs de propósito: lá ficam as
// regras (quem pode, quando pode) — puras e testáveis; aqui fica o efeito colateral (gerar
// texto e mandar). Assim dá pra provar as travas sem mandar mensagem pra ninguém.
import { logEvent, addSendVerdict, negarContato, desvincular, setIdentityState, setAiSetting,
  identityRow, getIgChat, db, transferirIaEntreCanais, getSetting, marcarAutor } from '../core/db.mjs'
import { CANAIS, bloqueioParaChamar, candidatosWhatsapp, candidatosInstagram,
  gerarPrimeiraMensagem, marcarChamada, jaChamou } from './chamar.mjs'
import { getReceipt, saveReceipt } from '../core/db.mjs'
import { textFp } from '../tinder/autoreply.mjs'

// Chama UMA pessoa. `enviar` e `gerarTexto` são injetados (o núcleo passa o envio e a IA
// reais; o teste passa espiões), então este arquivo inteiro é testável sem WhatsApp, sem
// Instagram e sem gastar chamada de IA. Devolve { ok, motivo?, texto?, alvo }.
export async function chamarUma({ accountKey, canal, personId, nome, alvo, enviar, gerarTexto, forcar = false }) {
  const bloqueio = forcar
    ? (jaChamou(accountKey, canal, alvo) ? 'já chamada neste canal' : null)
    : bloqueioParaChamar(accountKey, canal, { personId, alvo })
  if (bloqueio) return { ok: false, motivo: bloqueio, alvo }

  let texto
  try {
    const gerar = typeof gerarTexto === 'function' ? gerarTexto : gerarPrimeiraMensagem
    texto = await gerar({ accountKey, personId, nome, canal, alvo })
  } catch (e) {
    return { ok: false, motivo: 'não consegui escrever a mensagem: ' + (e && e.message ? e.message : e), alvo }
  }
  if (!texto || !String(texto).trim()) return { ok: false, motivo: 'rascunho vazio', alvo }

  // comprovante ANTES do envio: se o processo cair no meio, não repete a chamada
  marcarChamada(accountKey, canal, alvo, 'sending', { textFp: textFp(texto) })
  try {
    const r = await enviar({ personId, alvo, texto })
    marcarChamada(accountKey, canal, alvo, 'sent', { textFp: textFp(texto), providerMsgId: r && r.providerMessageId })
    // Quem escreveu a primeira mensagem foi o MODELO (gerarPrimeiraMensagem). Sem este
    // carimbo ela entra pelo eco do WhatsApp como se fosse o dono — e a pergunta "isso fui
    // eu ou foi a IA?" passa a responder errado justamente na mensagem que ele não escreveu
    // (docs/QUEM-ESCREVEU.md; visto ao vivo na chamada da fixture sintética, 26/07/2026).
    // O ID PRECISA VIR NO MESMO FORMATO com que a mensagem foi gravada, senão o carimbo
    // procura uma chave que não existe e falha em silêncio. No WhatsApp toda mensagem entra
    // como 'wa:'+id (o eco do messages.upsert e o deliverDraftSegments fazem assim); mandar
    // o id cru aqui fazia o UPDATE não achar nada — e a chamada da IA continuava aparecendo
    // como escrita pelo dono. Foi o que aconteceu com "agr ficou difícil fugir de mim"
    // (26/07/2026, 18:33), que o dono leu como mensagem dele.
    const idCru = r && (r.providerMessageId || r.key?.id)
    const idProvedor = idCru ? (canal === 'whatsapp' ? 'wa:' + idCru : idCru) : null
    if (idProvedor) { try { marcarAutor({ channel: canal, messageId: idProvedor, author: 'ia' }) } catch { /* carimbo não derruba envio */ } }
    logEvent({ type: 'chamada_enviada', personId, channel: canal, detail: `${alvo}: ${texto}` })
    // Chamou no canal novo = a conversa mudou de casa de vez. O toggle acompanha: se a IA
    // estava ligada no Tinder, ela passa a responder aqui e apaga lá (transferirIaEntreCanais
    // não liga do nada — se estava desligada, continua desligada nos dois).
    if (getSetting('transferir_ia_no_vinculo', true)) {
      try { transferirIaEntreCanais({ personId, de: 'tinder', para: canal }) } catch { /* envio já aconteceu; isso não pode derrubar */ }
    }
    // O id devolvido pelo provedor NÃO é prova de entrega. Espera a confirmação do servidor
    // (o comprovante vira 'entregue' quando ela chega) e devolve o que realmente aconteceu.
    // Sem isso o sistema dizia "chamei" pra mensagem que nunca chegou (o dono, 25/07/2026).
    const entrega = canal === 'whatsapp' ? await esperarEntrega(accountKey, canal, alvo) : { confirmada: null }
    return { ok: true, texto, alvo, resultado: r, entrega }
  } catch (e) {
    // 'uncertain': pode ter saído. Nunca volta pra fila automaticamente — sai da UI.
    marcarChamada(accountKey, canal, alvo, 'uncertain', { textFp: textFp(texto) })
    return { ok: false, motivo: 'falha no envio: ' + (e && e.message ? e.message : e), alvo, texto }
  }
}

// Espera a confirmação de entrega chegar do WhatsApp (o onSendStatus atualiza o comprovante).
// Devolve { confirmada:true } quando o servidor confirmou, { confirmada:false } no timeout —
// e nesse caso o chamado fica visível como "sem confirmação" em vez de "enviada".
// O que a gente espera aqui é a mensagem SAIR (chegar no servidor do WhatsApp), não ela ser
// entregue no aparelho: se a pessoa está sem internet, a entrega acontece depois, sozinha, e
// isso não é problema nenhum. O comprovante continua subindo pra 'entregue' quando ela abrir
// o WhatsApp (o onSendStatus atualiza a qualquer momento).
async function esperarEntrega(accountKey, canal, alvo, { timeoutMs = 25000, passoMs = 1500 } = {}) {
  const inicio = Date.now()
  while (Date.now() - inicio < timeoutMs) {
    await new Promise((r) => setTimeout(r, passoMs))
    const rec = getReceipt(accountKey, CANAIS[canal].receipt, alvo)
    if (rec && (rec.state === 'entregue' || rec.state === 'no_servidor')) {
      return { saiu: true, entregue: rec.state === 'entregue', estado: rec.state, esperouMs: Date.now() - inicio }
    }
  }
  // Nem o "chegou no servidor" veio: aí sim é suspeito — a mensagem pode não ter saído.
  saveReceipt2(accountKey, canal, alvo, 'sem_confirmacao')
  logEvent({ type: 'chamada_sem_confirmacao', channel: canal, detail: `${alvo}: o WhatsApp não confirmou nem o envio em ${Math.round(timeoutMs / 1000)}s` })
  return { saiu: false, entregue: false, estado: 'sem_confirmacao', esperouMs: Date.now() - inicio }
}
function saveReceipt2(accountKey, canal, alvo, estado) {
  const rec = getReceipt(accountKey, CANAIS[canal].receipt, alvo)
  if (rec) marcarChamada(accountKey, canal, alvo, estado, { textFp: rec.text_fp, providerMsgId: rec.provider_msg_id, commandId: rec.command_id })
}

// Passada automática: chama no máximo `porRodada` pessoas por canal. Nada acontece com o
// interruptor geral desligado — é a regressão que prova que o automático é opt-in.
export async function chamarTick({ accountKey, enviarWhatsapp, enviarInstagram, gerarTexto, porRodada = 1 }) {
  const feitos = { whatsapp: [], instagram: [] }
  for (const [canal, candidatos, enviar] of [
    ['whatsapp', candidatosWhatsapp, enviarWhatsapp],
    ['instagram', candidatosInstagram, enviarInstagram],
  ]) {
    if (typeof enviar !== 'function') continue
    const lista = candidatos(accountKey, { limite: 20 })
    let feitosNoCanal = 0
    for (const c of lista) {
      if (feitosNoCanal >= porRodada) break
      const alvo = canal === 'whatsapp' ? c.jid : c.username
      const r = await chamarUma({ accountKey, canal, personId: c.person_id, nome: c.name, alvo, enviar, gerarTexto })
      if (r.ok) { feitos[canal].push(r); feitosNoCanal++ }
    }
  }
  return feitos
}

// ---------------------------------------------------------------- veredito humano
// O que cada veredito FAZ (PLANO §2.7). É aqui que o "errado" vira freio de mão: desfaz o
// vínculo, desgruda a conversa, desliga a IA e nega o contato pra nunca mais ser sugerido.
export function registrarVeredito({ accountKey, canal, alvo, messageId, personId, verdict, reason, note }) {
  const id = addSendVerdict({ accountKey, channel: canal, targetId: alvo, messageId, personId, verdict, reason, note })
  const efeitos = []

  if (verdict === 'certo') {
    if (canal === 'whatsapp' && alvo && identityRow(accountKey, 'whatsapp', alvo)) {
      setIdentityState({ accountKey, channel: 'whatsapp', channelId: alvo, state: 'confirmado_conversa' })
      efeitos.push('vínculo confirmado')
    }
  } else if (verdict === 'errado' && reason === 'pessoa_errada') {
    if (canal === 'whatsapp' && alvo) {
      const removido = desvincular({ accountKey, channel: 'whatsapp', channelId: alvo })
      if (removido) efeitos.push('vínculo desfeito')
      // as mensagens voltam a ser da conversa crua, não da pessoa do Tinder
      if (removido && removido.person_id) {
        db().prepare(`UPDATE message SET person_id=? WHERE person_id=? AND channel='whatsapp'`).run('wa:' + alvo, removido.person_id)
        setAiSetting({ personId: removido.person_id, channel: 'whatsapp', enabled: false, state: 'idle' })
        efeitos.push('IA desligada e conversa desgrudada')
      }
    }
    if (canal === 'instagram' && alvo) {
      const thread = getIgChat(accountKey, alvo) || db().prepare(`SELECT thread_id FROM ig_chat WHERE account_key=? AND lower(username)=?`).get(accountKey, String(alvo).toLowerCase())
      const tid = thread?.thread_id || alvo
      setAiSetting({ personId: 'ig:' + tid, channel: 'instagram', enabled: false, state: 'idle' })
      efeitos.push('IA do Instagram desligada')
    }
    negarContato({ valor: alvo, kind: canal, personId, motivo: 'marcado como pessoa errada' })
    efeitos.push('contato negado')
  } else if (verdict === 'errado' && reason === 'nao_entregou') {
    if (canal === 'whatsapp' && alvo && identityRow(accountKey, 'whatsapp', alvo)) {
      setIdentityState({ accountKey, channel: 'whatsapp', channelId: alvo, state: 'frio' })
      efeitos.push('vínculo marcado como frio')
    }
  }
  // texto_ruim e outro: não mexem no vínculo (o vínculo estava certo; a mensagem é que não prestou)

  logEvent({ type: 'veredito', personId, channel: canal, detail: `${verdict}${reason ? '/' + reason : ''} em ${alvo} -> ${efeitos.join(', ') || 'sem efeito no vínculo'}` })
  return { id, efeitos }
}
