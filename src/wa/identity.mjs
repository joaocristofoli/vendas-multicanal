// Identidade canônica do WhatsApp (F2 do docs/PLANO-IDENTIDADE-VINCULO.md).
//
// O problema que este módulo resolve: o WhatsApp entrega a mesma pessoa por duas
// identidades — o número (`5545...@s.whatsapp.net`, "PN") e o LID (`1234...@lid`). A
// conversa quase sempre chega no @lid; o `onWhatsApp`, que é como a gente confirma um
// número, só sabe responder em PN (o baileys recusa LID nessa consulta, está no código
// dele). Sem costurar os dois lados, o vínculo do Tinder nasce apontando pro PN e a
// conversa vive no @lid — foi assim que 17 vínculos ficaram inertes em produção.
//
// Regra: a CHAVE CANÔNICA é o @lid quando ele é conhecido; o PN é atributo. Tudo que
// descobrimos (dos dois lados) vai pro cache `wa_identity`, que sobrevive a restart.
import { rememberWaIdentity, waLidForPn, waPnForLid, waIdentityPairs, logEvent } from '../core/db.mjs'
import { phoneFromJid, normalizeJid } from './jid.mjs'

// O baileys devolve jid COM sufixo de dispositivo ('554491230002:0@s.whatsapp.net'). Guardar
// assim envenena o cache: qualquer comparação por número falha, e tirar os não-dígitos gruda
// o dígito do device no fim do telefone. Tudo que entra aqui passa por esta limpeza.
const semDevice = (jid) => normalizeJid(jid) || jid

const ehLid = (jid) => !!jid && String(jid).endsWith('@lid')
const ehPn = (jid) => !!jid && String(jid).endsWith('@s.whatsapp.net')

function lidMapping(acc) {
  const lm = acc && acc.sock && acc.sock.signalRepository && acc.sock.signalRepository.lidMapping
  return lm || null
}

// PN de um @lid. Consulta o cache primeiro; só fala com o servidor quando não sabe.
// Best-effort: devolve null sem lançar (número pode não ser resolvível).
export async function resolvePnForLid(acc, rawLid) {
  const lid = semDevice(rawLid)
  if (!ehLid(lid)) return null
  const cache = waPnForLid(lid)
  if (cache) return cache
  const lm = lidMapping(acc)
  if (!lm || typeof lm.getPNForLID !== 'function') return null
  try {
    const pn = await lm.getPNForLID(lid)
    if (ehPn(pn)) { const limpo = semDevice(String(pn)); rememberWaIdentity({ lid, pn: limpo, source: 'lidmap' }); return limpo }
  } catch { /* não resolveu: fica pra próxima */ }
  rememberWaIdentity({ lid, pn: null, source: 'lidmap' }) // registra a tentativa
  return null
}

// LID de um número. É o caminho que faltava: com ele, o vínculo determinístico (que nasce
// de um número) já nasce apontando pro jid em que a conversa realmente chega.
export async function resolveLidForPn(acc, rawPn) {
  const pn = semDevice(rawPn)
  if (!ehPn(pn)) return null
  const cache = waLidForPn(pn)
  if (cache) return cache
  const lm = lidMapping(acc)
  if (!lm || typeof lm.getLIDForPN !== 'function') return null
  try {
    const lid = await lm.getLIDForPN(pn)
    if (ehLid(lid)) {
      // O baileys devolve o LID com sufixo de dispositivo (`123:4@lid`) quando o PN tinha
      // um. A chave canônica é sempre sem device — senão o mesmo contato vira N identidades.
      const limpo = String(lid).replace(/:\d+@lid$/, '@lid')
      rememberWaIdentity({ lid: limpo, pn, source: 'lidmap' })
      return limpo
    }
  } catch { /* não resolveu */ }
  return null
}

// Dado qualquer jid, devolve a chave canônica (o @lid quando conhecido) e o par completo.
// Puramente local (só cache) — use as funções acima quando puder falar com o servidor.
export function canonicalWaKey(jid) {
  if (ehLid(jid)) return { key: jid, lid: jid, pn: waPnForLid(jid) }
  if (ehPn(jid)) { const lid = waLidForPn(jid); return { key: lid || jid, lid, pn: jid } }
  return { key: jid, lid: null, pn: null }
}

// Índice dígitos-do-número -> @lid, pra canonizar sem uma consulta por mensagem.
// Reconstruído do cache; barato (uma varredura de tabela pequena).
export function lidIndexByDigits() {
  const idx = new Map()
  for (const { lid, pn } of waIdentityPairs()) { const d = phoneFromJid(pn); if (d) idx.set(d, lid) }
  return idx
}

// Backfill: resolve o PN de todos os @lid conhecidos que ainda estão cegos. Serializado e
// com pausa, porque cada miss vira uma consulta USync ao servidor — disparar 374 de uma vez
// é o tipo de rajada que derruba a sessão. Devolve o que conseguiu resolver.
export async function backfillPns(acc, lids, { pausaMs = 250, limite = 500, onProgress } = {}) {
  const alvos = [...new Set((lids || []).filter(ehLid))].slice(0, limite)
  let resolvidos = 0, falhas = 0
  for (let i = 0; i < alvos.length; i++) {
    const pn = await resolvePnForLid(acc, alvos[i])
    if (pn) resolvidos++; else falhas++
    if (typeof onProgress === 'function') { try { onProgress(i + 1, alvos.length, alvos[i], pn) } catch { /* ignora */ } }
    if (pausaMs) await new Promise((r) => setTimeout(r, pausaMs))
  }
  logEvent({ type: 'wa_backfill_pn', channel: 'whatsapp', detail: `${resolvidos} resolvidos, ${falhas} sem resposta, de ${alvos.length}` })
  return { total: alvos.length, resolvidos, falhas }
}

// ---------------------------------------------------------------------------
// A RESPOSTA ÚNICA pra "qual é o número por trás deste jid?".
//
// Existe porque `phoneFromJid` MENTE CALADO num @lid: pra `333444555666777@lid` ele
// devolve "333444555666777" — dígitos plausíveis que não são telefone nenhum. Quem compara
// identidade em cima disso passa em todo teste feito com @s.whatsapp.net e falha em
// silêncio na conta real, que é 70% LID. Foi assim que o assistente ficou mudo no
// self-chat do dono (25/07/2026).
//
// Contrato: devolve os dígitos do número, ou **null** quando é um @lid sem número
// conhecido. NUNCA chuta. null quer dizer "não sei", e quem chama tem que tratar isso
// como "não posso afirmar que é a mesma pessoa".
export function digitosDeContato(jid, { chat = null } = {}) {
  const a = normalizeJid(jid)
  if (!a) return null
  if (!a.endsWith('@lid')) return phoneFromJid(a) || null
  const pn = waPnForLid(a) || (chat && chat.pn) || null
  return pn ? (phoneFromJid(pn) || null) : null
}

// "Estes dois jids são a mesma pessoa?" — a pergunta que deu errado. Só devolve true com
// prova: dois lados resolvidos e iguais. Sem número resolvido de um dos lados, é false
// (não sei ≠ é o mesmo).
export function mesmoContato(jidA, jidB, { chatA = null, chatB = null } = {}) {
  const a = normalizeJid(jidA), b = normalizeJid(jidB)
  if (!a || !b) return false
  if (a === b) return true
  const da = digitosDeContato(a, { chat: chatA })
  const db2 = digitosDeContato(b, { chat: chatB })
  return !!da && da === db2
}
