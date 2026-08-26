// Os três números curtos que acompanham o nome em qualquer canal.
//
// A conta é da PESSOA, não da thread: quando ela começa no Tinder e continua no WhatsApp,
// os dois lugares mostram a mesma história inteira. `pessoaCanonica` resolve tanto identity
// quanto person_alias, os dois mecanismos de união usados pelo tim.
import { db } from '../core/db.mjs'
import { pessoaCanonica } from '../self/identidade.mjs'

const DIA = 86_400_000
const DIA_SP = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
})

function indiceDoDiaEmSaoPaulo(ts) {
  const partes = Object.fromEntries(DIA_SP.formatToParts(new Date(Number(ts)))
    .filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]))
  return Math.floor(Date.UTC(partes.year, partes.month - 1, partes.day) / DIA)
}

let cache = { assinatura: '', porPessoa: new Map() }

function assinaturaDoBanco(accountKey) {
  const d = db()
  // Linhas legadas sem account_key pertencem à única conta que existia na época.
  const m = d.prepare(`SELECT COUNT(*) n, MAX(ts) ultimo FROM message
    WHERE account_key=? OR account_key IS NULL`).get(accountKey)
  const a = d.prepare(`SELECT COUNT(*) n, MAX(created_at) ultimo FROM person_alias`).get()
  const i = d.prepare(`SELECT COUNT(*) n, MAX(linked_at) ultimo FROM identity WHERE account_key=?`).get(accountKey)
  return `${m?.n || 0}:${m?.ultimo || 0}|${a?.n || 0}:${a?.ultimo || 0}|${i?.n || 0}:${i?.ultimo || 0}`
}

function reconstruir(accountKey = 'main') {
  const assinatura = `${accountKey}|${assinaturaDoBanco(accountKey)}`
  if (cache.assinatura === assinatura) return cache.porPessoa

  const porPessoa = new Map()
  const canonicos = new Map()
  const canonico = (id) => {
    if (!canonicos.has(id)) canonicos.set(id, pessoaCanonica(id, accountKey) || id)
    return canonicos.get(id)
  }
  // Mídia também é mensagem trocada. Não filtramos por texto, ao contrário de algumas
  // réguas de prompt que deliberadamente só medem fala escrita.
  for (const m of db().prepare(`SELECT person_id,ts FROM message
    WHERE ts IS NOT NULL AND (account_key=? OR account_key IS NULL) ORDER BY ts`).all(accountKey)) {
    const id = canonico(m.person_id)
    let r = porPessoa.get(id)
    if (!r) { r = { mensagens: 0, primeira: Number(m.ts), dias: new Set() }; porPessoa.set(id, r) }
    r.mensagens++
    if (Number(m.ts) < r.primeira) r.primeira = Number(m.ts)
    r.dias.add(DIA_SP.format(new Date(Number(m.ts))))
  }
  cache = { assinatura, porPessoa }
  return porPessoa
}

export function metricasDaConversa(personId, accountKey = 'main', agora = Date.now()) {
  const zero = { mensagens: 0, diasDesdePrimeira: 0, diasConversados: 0 }
  if (!personId) return zero
  const id = pessoaCanonica(personId, accountKey) || String(personId)
  const r = reconstruir(accountKey).get(id)
  if (!r) return zero
  return {
    mensagens: r.mensagens,
    // Janela de dias civis INCLUSIVA: se começou dia 11 e hoje é 13, são 3 dias.
    // A mesma régua de calendário usada em `diasConversados` evita mostrar algo como
    // "2 d desde · 3 d ativos", que embora possa acontecer com períodos de 24 horas,
    // é contraditório para quem lê os dois números lado a lado.
    diasDesdePrimeira: Math.max(
      r.dias.size,
      indiceDoDiaEmSaoPaulo(agora) - indiceDoDiaEmSaoPaulo(r.primeira) + 1,
    ),
    // Datas distintas em São Paulo nas quais pelo menos uma mensagem foi trocada.
    diasConversados: r.dias.size,
  }
}

export function limparCacheMetricas() { cache = { assinatura: '', porPessoa: new Map() } }
