// Quem é a pessoa, de verdade — resolvendo os DOIS mecanismos de união de uma vez.
//
// O vendas-multicanal junta pessoa de dois jeitos, e eles não são iguais (docs/PLANO-IDENTIDADE-VINCULO):
//   1. identity  — Tinder ↔ WhatsApp: as mensagens são MOVIDAS pro person_id do Tinder.
//      Depois disso a conversa 'wa:<jid>' fica vazia, mas continua existindo como linha.
//   2. person_alias — Instagram e uniões manuais: agrupamento lógico, sem mover mensagem
//      (o sync do Instagram reescreve a thread, então mover seria desfeito no sync seguinte).
//
// Quem olha só um dos dois erra. Foi o que aconteceu em 25/07/2026: o resolvedor de uniões
// propôs 17 pares que JÁ estavam unidos por identity — todos apontando pra uma conversa de
// WhatsApp com 0 mensagens, que é a assinatura de quem já teve as mensagens movidas.
//
// Esta é a função única: id bruto de qualquer canal -> a pessoa canônica.
import { db } from '../core/db.mjs'
import { canonicalPersonId } from '../projects/store.mjs'

// A pessoa apontada por uma identity de WhatsApp (o vínculo que move mensagem).
function pessoaPorJid(accountKey, jid) {
  return db().prepare(`SELECT person_id FROM identity WHERE account_key=? AND channel='whatsapp' AND channel_id=?`)
    .get(accountKey, jid)?.person_id || null
}

export function pessoaCanonica(rawId, accountKey = 'main') {
  let id = String(rawId || '')
  if (!id) return id
  if (id.startsWith('wa:')) {
    const vinculada = pessoaPorJid(accountKey, id.slice(3))
    if (vinculada) id = vinculada
  }
  try { return canonicalPersonId(id) } catch { return id }
}

// Já são a mesma pessoa? Vale pelos dois mecanismos.
export function mesmaPessoa(a, b, accountKey = 'main') {
  return pessoaCanonica(a, accountKey) === pessoaCanonica(b, accountKey)
}

// Todos os ids brutos que carregam mensagem desta pessoa: ela, o canônico, os aliases e
// os jids de WhatsApp vinculados a ela (que podem ter sobrado com histórico antigo).
export function idsBrutosDaPessoa(rawId, accountKey = 'main') {
  const canonico = pessoaCanonica(rawId, accountKey)
  const ids = new Set([String(rawId), canonico])
  try {
    for (const r of db().prepare(`SELECT alias_person_id FROM person_alias WHERE canonical_person_id=?`).all(canonico)) ids.add(r.alias_person_id)
    // alias em cadeia (A->B->C): sobe até o topo e recolhe o galho inteiro
    for (const r of db().prepare(`SELECT alias_person_id FROM person_alias WHERE canonical_person_id IN (SELECT alias_person_id FROM person_alias WHERE canonical_person_id=?)`).all(canonico)) ids.add(r.alias_person_id)
    for (const r of db().prepare(`SELECT channel_id FROM identity WHERE account_key=? AND channel='whatsapp' AND person_id IN (${[...ids].map(() => '?').join(',')})`).all(accountKey, ...ids)) {
      ids.add('wa:' + r.channel_id)
    }
  } catch { /* banco novo/parcial: devolve o que já tem */ }
  return [...ids].filter(Boolean)
}
