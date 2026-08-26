// Métricas do "chamar em outras redes" por PESSOA.
//
// O recibo do chamado é keyed pelo ALVO do canal (jid do WhatsApp, @ do Instagram), mas a
// tela que o dono quer ver é por pessoa. Este módulo resolve "de quem era esse alvo?" com as
// mesmas pistas que o sistema tem hoje (veredito salvo, vínculo atual, hint de contato,
// thread do Instagram) e agrega as tentativas de abertura por pessoa canônica.
import { db } from '../core/db.mjs'

export function criarContextoChamar(accountKey) {
  const alias = new Map()
  for (const r of db().prepare(`SELECT alias_person_id a, canonical_person_id c FROM person_alias`).all()) alias.set(r.a, r.c)

  const canonicalize = (id) => {
    if (!id) return null
    let cur = String(id)
    const seen = new Set()
    while (alias.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      cur = alias.get(cur)
    }
    return cur
  }

  const waOwners = new Map()
  for (const r of db().prepare(`SELECT channel_id, person_id FROM identity WHERE account_key=? AND channel='whatsapp'`).all(accountKey)) {
    waOwners.set(r.channel_id, canonicalize(r.person_id))
  }

  const igHints = new Map()
  for (const r of db().prepare(`SELECT normalized, person_id FROM contact_hint
      WHERE account_key=? AND kind='instagram'
      ORDER BY created_at DESC`).all(accountKey)) {
    const user = String(r.normalized || '').trim().replace(/^@/, '').toLowerCase()
    if (user && !igHints.has(user)) igHints.set(user, canonicalize(r.person_id))
  }

  const igChats = new Map()
  for (const r of db().prepare(`SELECT thread_id, username FROM ig_chat
      WHERE account_key=? AND username IS NOT NULL
      ORDER BY updated_at DESC`).all(accountKey)) {
    const user = String(r.username || '').trim().replace(/^@/, '').toLowerCase()
    if (user && !igChats.has(user)) igChats.set(user, canonicalize('ig:' + r.thread_id))
  }

  return { accountKey, canonicalize, waOwners, igHints, igChats }
}

export function pessoaDaChamadaEmOutraRede(accountKey, canal, alvo, { preferido = null, contexto = null } = {}) {
  const ctx = contexto && contexto.accountKey === accountKey ? contexto : criarContextoChamar(accountKey)
  if (preferido) return ctx.canonicalize(preferido)
  if (canal === 'whatsapp') return ctx.waOwners.get(String(alvo || '')) || null
  if (canal === 'instagram') {
    const user = String(alvo || '').trim().replace(/^@/, '').toLowerCase()
    return ctx.igHints.get(user) || ctx.igChats.get(user) || null
  }
  return null
}

export function metricasChamarPorPessoa(accountKey, { contexto = null } = {}) {
  const ctx = contexto && contexto.accountKey === accountKey ? contexto : criarContextoChamar(accountKey)
  const linhas = db().prepare(`SELECT r.channel, r.target_id, r.state, r.ts,
      CASE r.channel WHEN 'wa-opener' THEN 'whatsapp' WHEN 'ig-opener' THEN 'instagram' ELSE r.channel END AS canal,
      (SELECT sv.verdict FROM send_verdict sv
        WHERE sv.account_key=r.account_key
          AND sv.channel=CASE r.channel WHEN 'wa-opener' THEN 'whatsapp' WHEN 'ig-opener' THEN 'instagram' ELSE r.channel END
          AND sv.target_id=r.target_id
        ORDER BY sv.created_at DESC LIMIT 1) AS verdict,
      (SELECT sv.reason FROM send_verdict sv
        WHERE sv.account_key=r.account_key
          AND sv.channel=CASE r.channel WHEN 'wa-opener' THEN 'whatsapp' WHEN 'ig-opener' THEN 'instagram' ELSE r.channel END
          AND sv.target_id=r.target_id
        ORDER BY sv.created_at DESC LIMIT 1) AS reason,
      (SELECT sv.person_id FROM send_verdict sv
        WHERE sv.account_key=r.account_key
          AND sv.channel=CASE r.channel WHEN 'wa-opener' THEN 'whatsapp' WHEN 'ig-opener' THEN 'instagram' ELSE r.channel END
          AND sv.target_id=r.target_id
        ORDER BY sv.created_at DESC LIMIT 1) AS person_id
    FROM send_receipt r
    WHERE r.account_key=? AND r.channel IN ('wa-opener','ig-opener')
    ORDER BY r.ts DESC`).all(accountKey)

  const out = new Map()
  for (const r of linhas) {
    const personId = pessoaDaChamadaEmOutraRede(accountKey, r.canal, r.target_id, { preferido: r.person_id, contexto: ctx })
    if (!personId) continue
    if (!out.has(personId)) {
      out.set(personId, {
        personId,
        tentativas: 0,
        avaliadas: 0,
        certas: 0,
        erradas: 0,
        pendentes: 0,
        porCanal: { whatsapp: 0, instagram: 0 },
        ultimaTentativa: 0,
        ultimoEstado: null,
        ultimoVeredito: null,
        ultimoMotivo: null,
      })
    }
    const cur = out.get(personId)
    cur.tentativas++
    cur.ultimaTentativa = Math.max(cur.ultimaTentativa || 0, r.ts || 0)
    if (r.canal === 'whatsapp' || r.canal === 'instagram') cur.porCanal[r.canal] = (cur.porCanal[r.canal] || 0) + 1
    if (!cur.ultimoEstado) cur.ultimoEstado = r.state || null
    if (r.verdict === 'certo') {
      cur.certas++
      cur.avaliadas++
      if (!cur.ultimoVeredito) { cur.ultimoVeredito = 'certo'; cur.ultimoMotivo = r.reason || null }
    } else if (r.verdict === 'errado') {
      cur.erradas++
      cur.avaliadas++
      if (!cur.ultimoVeredito) { cur.ultimoVeredito = 'errado'; cur.ultimoMotivo = r.reason || null }
    } else {
      cur.pendentes++
    }
  }

  return [...out.values()].map((r) => ({
    ...r,
    pctCerto: r.avaliadas ? Math.round((r.certas / r.avaliadas) * 100) : null,
    pctErrado: r.avaliadas ? Math.round((r.erradas / r.avaliadas) * 100) : null,
  }))
}
