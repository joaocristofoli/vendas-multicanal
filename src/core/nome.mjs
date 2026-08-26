// COMO UMA PESSOA APARECE NA TELA. Uma função só, e ela NUNCA devolve identificador interno.
//
// Regra do dono (26/07/2026), depois de ver `wa:222333444555666@lid` num cartão de memória
// no painel: "eu nunca, visualmente, quero ver isso pois não sei o que é. Eu queria ver o
// número ou o nome da pessoa do WhatsApp".
//
// Ele está certo, e o defeito era estrutural: `nomeDaPessoa` devolvia `null` quando não havia
// nome salvo, e cada tela resolvia o `null` do seu jeito — a de memórias fazia
// `x.nome || x.person_id` e despejava o @lid. O número estava no banco o tempo todo, na
// coluna `pn`; ninguém olhava.
//
// O @lid é um identificador que o WhatsApp inventou pra não expor o número; os dígitos dele
// não têm relação nenhuma com o telefone. Mostrar isso pra um humano é mostrar nada.
//
// A cascata desce até algo que uma PESSOA reconhece, e o último degrau é uma frase em
// português — nunca o id:
//   1. nome salvo (person.display_name)
//   2. nome da conversa (WhatsApp / Instagram / Tinder / Badoo, em qualquer alias)
//   3. @ do Instagram
//   4. TELEFONE formatado — é o que ele pediu, e quase sempre existe
//   5. "contato sem nome"
import { db } from './db.mjs'
import { prettyPhone } from '../wa/phone.mjs'

const SEM_NOME = 'contato sem nome'

// Todos os ids que representam esta pessoa (ela, o canônico e os apelidos). Consulta direta
// pra este módulo não depender de projects/store e poder ser usado de qualquer lugar.
function idsDaPessoa(personId) {
  const pid = String(personId || '')
  if (!pid) return []
  try {
    const canon = db().prepare(`SELECT canonical_person_id FROM person_alias WHERE alias_person_id=?`).get(pid)?.canonical_person_id || pid
    const irmaos = db().prepare(`SELECT alias_person_id FROM person_alias WHERE canonical_person_id=?`).all(canon).map((r) => r.alias_person_id)
    return [...new Set([pid, canon, ...irmaos])].filter(Boolean)
  } catch { return [pid] }
}

const um = (sql, ...p) => { try { return db().prepare(sql).get(...p) } catch { return null } }

// Um "nome" que na verdade é identificador. Não basta barrar `wa:` e `@lid`: apareceu uma
// linha de `person` com o display_name igual aos DÍGITOS CRUS do @lid ("444555666777888"),
// que passava por todas as barreiras e chegava na tela como se fosse o nome da pessoa.
// Sequência longa só de dígitos não é nome de gente — e, se por acaso for, o degrau de baixo
// (o telefone formatado) mostra algo que um humano reconhece.
function pareceIdentificador(txt) {
  const t = String(txt || '').trim()
  if (!t) return true
  if (/^(wa|ig|b|p):/.test(t)) return true
  if (/@(lid|s\.whatsapp\.net|g\.us|broadcast|newsletter)/.test(t)) return true
  // corrida longa de dígitos SEM formatação nenhuma: é id, não telefone. Um telefone de
  // verdade chega aqui formatado — "(11) 99999-0002" — e continua valendo como nome.
  if (/^\d{9,}$/.test(t)) return true
  return false
}

// Aceita o candidato só se ele for mesmo um nome.
const nomeBom = (txt) => (pareceIdentificador(txt) ? null : String(txt).trim())

// O telefone de verdade por trás de um id de WhatsApp. Um @lid não carrega número: quem sabe
// é a coluna `pn` da conversa ou o mapa `wa_identity`. Sem essas duas consultas, toda conversa
// em @lid — que é a maioria nesta conta — cairia em "sem nome" tendo o número no banco.
function telefoneDe(jid) {
  if (!jid) return null
  const c = um(`SELECT pn FROM wa_chat WHERE jid=?`, jid)
  if (c?.pn) return c.pn
  const m = um(`SELECT pn FROM wa_identity WHERE lid=?`, jid)
  if (m?.pn) return m.pn
  // jid que já é o próprio número (não é @lid)
  if (!jid.includes('@lid')) return jid
  return null
}

// O nome pra MOSTRAR. Nunca devolve null, nunca devolve id interno.
export function nomeParaMostrar(personId) {
  const ids = idsDaPessoa(personId)
  if (!ids.length) return SEM_NOME

  for (const id of ids) {
    const p = um(`SELECT display_name FROM person WHERE person_id=?`, id)
    const n = nomeBom(p?.display_name)
    if (n) return n
  }
  for (const id of ids) {
    if (id.startsWith('wa:')) { const c = um(`SELECT name FROM wa_chat WHERE jid=?`, id.slice(3)); const n = nomeBom(c?.name); if (n) return n }
    if (id.startsWith('ig:')) { const c = um(`SELECT name, username FROM ig_chat WHERE thread_id=?`, id.slice(3)); const n = nomeBom(c?.name); if (n) return n }
    if (id.startsWith('b:')) { const c = um(`SELECT name FROM badoo_chat WHERE chat_id=?`, id.slice(2)); const n = nomeBom(c?.name); if (n) return n }
    const t = um(`SELECT name FROM tinder_match WHERE person_id=? AND name IS NOT NULL LIMIT 1`, id)
    const n = nomeBom(t?.name)
    if (n) return n
  }
  for (const id of ids) {
    if (!id.startsWith('ig:')) continue
    const c = um(`SELECT username FROM ig_chat WHERE thread_id=?`, id.slice(3))
    if (c?.username?.trim() && !pareceIdentificador(c.username)) return '@' + c.username.trim()
  }
  // o TELEFONE — o que ele pediu explicitamente quando não há nome
  for (const id of ids) {
    if (!id.startsWith('wa:')) continue
    const tel = telefoneDe(id.slice(3))
    if (tel) { const bonito = prettyPhone(tel); if (bonito && !/@/.test(bonito)) return bonito }
  }
  return SEM_NOME
}

// Para quem precisa saber se é nome de verdade ou só o degrau de baixo (ex.: decidir se
// vale a pena pedir pro dono apelidar a conversa).
export function temNomeDeVerdade(personId) {
  const n = nomeParaMostrar(personId)
  return n !== SEM_NOME && !/^\(\d{2}\)\s/.test(n)
}

export { SEM_NOME }
