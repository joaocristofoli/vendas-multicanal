// Conferência automática do vínculo — a pergunta "esse vínculo aponta MESMO pro número que
// ela escreveu?" respondida pelo sistema, sempre, sem ninguém precisar rodar consulta.
//
// Por que existe (o dono, 25/07/2026): "o sistema deve saber fazer isso automaticamente no
// futuro, não precisando de você pensar". Antes de mandar a primeira mensagem pra alguém, a
// única coisa que importa é: o número que ela mandou na conversa é o mesmo número da conta
// pra onde a mensagem vai? Se não for, a mensagem vai pra um estranho.
//
// A comparação tem duas armadilhas, as duas já custaram erro:
//  1. o 9º dígito: ela escreve 11 dígitos, o WhatsApp guarda a conta em 10 (formato antigo).
//     Comparar string crua diz "não bate" pra vínculo certo. Compara-se por VARIANTE.
//  2. o sufixo de dispositivo ('554491230002:0@s.whatsapp.net'): tirar a pontuação gruda o
//     dígito do device no fim do telefone e desloca tudo. Normaliza-se o jid antes.
import { db, waPnForLid, contactHints, logEvent, setIdentityState } from '../core/db.mjs'
import { phoneVariants } from '../wa/phone.mjs'
import { phoneFromJid } from '../wa/jid.mjs'

// Número (em dígitos, sem device) pra onde um vínculo de WhatsApp realmente aponta.
export function numeroDoVinculo(channelId) {
  if (!channelId) return null
  const pn = String(channelId).endsWith('@lid') ? waPnForLid(channelId) : channelId
  const digitos = phoneFromJid(pn)
  return digitos || null
}

// Confere um vínculo. Devolve:
//   { ok:true,  estado:'confere' }                 número do vínculo = número que ela escreveu
//   { ok:false, estado:'divergente', ... }         aponta pra OUTRO número — não pode mandar nada
//   { ok:true,  estado:'sem_prova' }               não há número escrito guardado (vínculo antigo)
//   { ok:true,  estado:'sem_numero_resolvido' }    o @lid ainda não teve o número resolvido
export function conferirVinculo(accountKey, personId, channelId) {
  const escrito = contactHints({ personId, limit: 10 }).find((h) => h.kind === 'phone' || h.kind === 'wa_link')
  if (!escrito) return { ok: true, estado: 'sem_prova' }
  const doVinculo = numeroDoVinculo(channelId)
  if (!doVinculo) return { ok: true, estado: 'sem_numero_resolvido', escrito: escrito.normalized }
  const formas = phoneVariants(escrito.normalized)
  if (formas.includes(doVinculo)) return { ok: true, estado: 'confere', escrito: escrito.normalized, alvo: doVinculo }
  return { ok: false, estado: 'divergente', escrito: escrito.normalized, alvo: doVinculo }
}

// Passa em todos os vínculos de WhatsApp de pessoas do Tinder e marca os divergentes.
// Roda junto com as outras reconciliações — é barato (só cache e banco, nada de rede).
export function conferirTodos(accountKey) {
  const linhas = db().prepare(`SELECT i.person_id, i.channel_id, i.link_state, tm.name
    FROM identity i JOIN tinder_match tm ON tm.person_id=i.person_id AND tm.account_key=i.account_key
    WHERE i.account_key=? AND i.channel='whatsapp'`).all(accountKey)
  const resumo = { confere: 0, divergente: 0, sem_prova: 0, sem_numero_resolvido: 0 }
  const divergentes = []
  for (const l of linhas) {
    const r = conferirVinculo(accountKey, l.person_id, l.channel_id)
    resumo[r.estado] = (resumo[r.estado] || 0) + 1
    if (r.estado === 'divergente') {
      divergentes.push({ nome: l.name, ...r, channelId: l.channel_id, personId: l.person_id })
      // trava o vínculo: some do "pode chamar" e aparece pra revisão
      if (l.link_state !== 'divergente') {
        setIdentityState({ accountKey, channel: 'whatsapp', channelId: l.channel_id, state: 'divergente' })
        logEvent({ type: 'vinculo_divergente', personId: l.person_id, channel: 'whatsapp',
          detail: `${l.name}: escreveu ${r.escrito}, vínculo aponta pra ${r.alvo}` })
      }
    }
  }
  return { ...resumo, divergentes }
}

// Pra ONDE mandar de fato. A chave canônica da identidade é o @lid, mas o @lid só é
// endereçável quando já existe sessão de criptografia com ele — o que acontece depois de
// alguma conversa. Numa PRIMEIRA mensagem, quem o servidor sempre roteia é o NÚMERO (PN).
//
// Isso não é teoria: em 25/07/2026 duas primeiras mensagens saíram pelo @lid; a que tinha
// sessão (a pessoa já tinha aparecido no inbox) chegou e foi respondida, e a de quem nunca
// tinha conversado NÃO chegou — sem erro nenhum, com id de mensagem devolvido normalmente.
//
// Regra: conversa sem histórico -> manda pro número. Conversa em andamento -> mantém o @lid,
// que é o que já funciona hoje pras respostas da IA.
export function alvoDeEnvio(accountKey, jid) {
  const temHistorico = db().prepare(`SELECT 1 FROM message
    WHERE channel='whatsapp' AND person_id IN (?, (SELECT person_id FROM identity WHERE account_key=? AND channel='whatsapp' AND channel_id=?))
      AND direction='incoming' LIMIT 1`).get('wa:' + jid, accountKey, jid)
  if (temHistorico) return jid
  if (!String(jid).endsWith('@lid')) return jid
  const pn = waPnForLid(jid)
  return pn || jid
}
