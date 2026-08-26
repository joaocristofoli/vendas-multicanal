// CIDADE DA PESSOA — uma verdade por pessoa canônica, em todos os canais.
//
// NÃO é a cidade do DONO (isso é src/self/lugares.mjs). Aqui é a cidade de QUEM
// está do outro lado. Vira etiqueta (tipo=cidade) pra aparecer no painel igual
// Fatal/Cliente, e mora também em pessoa_pref — é essa coluna que impede duas
// marcas quando a mesma pessoa existe no Tinder e no WhatsApp.
//
// Fontes, da mais firme pra mais frouxa:
//   perfil_tinder / perfil_badoo  — campo de cidade do app
//   texto                         — "moro em X" / "sou de X" contra o catálogo
//
// "tô em X" NÃO conta: pode indicar presença temporária, não local de residência.
// "não sou de X" também não. Estado sozinho ("Paraná", "SP") não é cidade.
//
// Conflito (Toledo no Badoo, São Paulo no Tinder): NÃO escolhe. Mantém a que
// já estava, registra no Diário. Quem opera decide.
// Quem tira a etiqueta à mão trava: o motor não recoloca.
import { db, getSetting, setSetting, logEvent } from '../core/db.mjs'
import { pessoaCanonica, idsBrutosDaPessoa } from './identidade.mjs'
import {
  criarEtiqueta, listarEtiquetas, marcarPessoa, etiquetasDaPessoa,
} from './etiquetas.mjs'
import { parseCidadePerfil, cidadeNoTrecho, semAcento, chaveCidade } from './cidades-catalogo.mjs'

export const CIDADE_COR = 'ambar'
const FONTE_PESO = { perfil_tinder: 3, perfil_badoo: 3, texto: 1, manual: 4 }

function garantirPref() {
  const cols = db().prepare(`PRAGMA table_info(pessoa_pref)`).all().map((c) => c.name)
  if (!cols.includes('cidade')) db().exec(`ALTER TABLE pessoa_pref ADD COLUMN cidade TEXT`)
  if (!cols.includes('cidade_uf')) db().exec(`ALTER TABLE pessoa_pref ADD COLUMN cidade_uf TEXT`)
  if (!cols.includes('cidade_fonte')) db().exec(`ALTER TABLE pessoa_pref ADD COLUMN cidade_fonte TEXT`)
  if (!cols.includes('cidade_em')) db().exec(`ALTER TABLE pessoa_pref ADD COLUMN cidade_em INTEGER`)
  if (!cols.includes('cidade_travada')) db().exec(`ALTER TABLE pessoa_pref ADD COLUMN cidade_travada INTEGER DEFAULT 0`)
}

function upsertPref(personId, campos) {
  garantirPref()
  db().prepare(`INSERT INTO pessoa_pref(person_id, updated_at) VALUES(?,?)
    ON CONFLICT(person_id) DO UPDATE SET updated_at=excluded.updated_at`).run(personId, Date.now())
  const sets = []
  const vals = []
  for (const [k, v] of Object.entries(campos)) {
    sets.push(`${k}=?`)
    vals.push(v)
  }
  if (!sets.length) return
  vals.push(personId)
  db().prepare(`UPDATE pessoa_pref SET ${sets.join(', ')} WHERE person_id=?`).run(...vals)
}

export function cidadeDaPessoa(personIdBruto) {
  garantirPref()
  const id = pessoaCanonica(personIdBruto)
  if (!id) return null
  const row = db().prepare(`SELECT cidade, cidade_uf, cidade_fonte, cidade_em, cidade_travada
    FROM pessoa_pref WHERE person_id=?`).get(id)
  if (row?.cidade_travada && !row?.cidade) {
    return { nome: null, uf: null, fonte: null, em: null, travada: true }
  }
  if (row?.cidade) {
    return {
      nome: row.cidade,
      uf: row.cidade_uf || null,
      fonte: row.cidade_fonte || null,
      em: row.cidade_em || null,
      travada: !!row.cidade_travada,
    }
  }
  const etq = etiquetasDaPessoa(id).find((e) => e.tipo === 'cidade')
  if (!etq) return null
  return { nome: etq.nome, uf: null, fonte: null, em: null, travada: false, etiquetaId: etq.id }
}

export function garantirEtiquetaCidade(nome) {
  const limpo = String(nome || '').replace(/\s+/g, ' ').trim()
  if (!limpo) throw new Error('cidade sem nome')
  const ja = listarEtiquetas().find((e) => chaveCidade(e.nome) === chaveCidade(limpo))
  if (ja) {
    if (ja.tipo !== 'cidade') {
      db().prepare(`UPDATE etiqueta SET tipo='cidade' WHERE id=?`).run(ja.id)
      return { ...ja, tipo: 'cidade' }
    }
    return ja
  }
  return criarEtiqueta({ nome: limpo, cor: CIDADE_COR, tipo: 'cidade' })
}

function etiquetasCidadeDaPessoa(personId) {
  return etiquetasDaPessoa(personId).filter((e) => e.tipo === 'cidade')
}

function mesma(a, b) {
  return chaveCidade(a) === chaveCidade(b)
}

// Aplica a cidade na pessoa CANÔNICA. Idempotente. Não sobrescreve conflito.
// `forcar` é o caminho de quem opera (marcar à mão).
export function aplicarCidade({ personId, cidade, fonte = 'texto', uf = null, forcar = false } = {}) {
  const parsed = typeof cidade === 'object' && cidade?.nome
    ? cidade
    : parseCidadePerfil(cidade)
  if (!parsed?.nome) return { ok: false, motivo: 'cidade-invalida' }
  const canon = pessoaCanonica(personId)
  if (!canon) return { ok: false, motivo: 'sem-pessoa' }

  garantirPref()
  const atual = cidadeDaPessoa(canon)
  const pesoNovo = FONTE_PESO[fonte] || 0
  const pesoAtual = FONTE_PESO[atual?.fonte] || 0

  if (atual?.travada && !forcar) return { ok: false, motivo: 'travada', atual }

  if (atual?.nome && !mesma(atual.nome, parsed.nome)) {
    if (!forcar && pesoNovo <= pesoAtual) {
      logEvent({
        type: 'cidade_conflito',
        personId: canon,
        detail: `manteve ${atual.nome} (${atual.fonte || '?'}) e recusou ${parsed.nome} (${fonte})`,
      })
      return { ok: false, motivo: 'conflito', atual, proposta: parsed }
    }
  }

  const etq = garantirEtiquetaCidade(parsed.nome)
  for (const velha of etiquetasCidadeDaPessoa(canon)) {
    if (velha.id !== etq.id) marcarPessoa({ personId: canon, etiquetaId: velha.id, marcar: false })
  }
  marcarPessoa({ personId: canon, etiquetaId: etq.id })
  upsertPref(canon, {
    cidade: parsed.nome,
    cidade_uf: parsed.uf || uf || null,
    cidade_fonte: fonte,
    cidade_em: Date.now(),
    cidade_travada: forcar ? 0 : (atual?.travada ? 1 : 0),
  })
  if (!atual || !mesma(atual.nome, parsed.nome)) {
    logEvent({
      type: 'cidade_posta',
      personId: canon,
      detail: `${parsed.nome}${parsed.uf ? ' / ' + parsed.uf : ''} via ${fonte}`,
    })
  }
  return { ok: true, cidade: parsed, etiquetaId: etq.id, canon }
}

// Quem opera tirou a marca: trava, senão o próximo perfil/boot recoloca.
export function soltarCidade(personIdBruto) {
  const canon = pessoaCanonica(personIdBruto)
  if (!canon) return { ok: false }
  garantirPref()
  for (const e of etiquetasCidadeDaPessoa(canon)) {
    marcarPessoa({ personId: canon, etiquetaId: e.id, marcar: false })
  }
  upsertPref(canon, {
    cidade: null,
    cidade_uf: null,
    cidade_fonte: null,
    cidade_em: null,
    cidade_travada: 1,
  })
  logEvent({ type: 'cidade_tirada', personId: canon, detail: 'travada — o motor não recoloca' })
  return { ok: true }
}

const DECLARA = /\b(moro em|moro no|moro na|sou de|sou do|sou da|vivo em|vivo no|vivo na|morava em)\b\s+(.{2,40})/i
const NEGA = /\b(nao|nunca|nem)\s+(sou|moro|vivo|morei)\b/

export function cidadeNoTexto(texto) {
  const t = String(texto || '')
  if (!t.trim()) return null
  if (NEGA.test(semAcento(t))) return null
  const m = t.match(DECLARA)
  if (!m) return null
  return cidadeNoTrecho(m[2])
}

export function aplicarCidadeDeTexto({ personId, texto, direction = 'incoming' } = {}) {
  if (direction !== 'incoming') return null
  const achada = cidadeNoTexto(texto)
  if (!achada) return null
  return aplicarCidade({ personId, cidade: achada, fonte: 'texto' })
}

export function aplicarCidadeDePerfil({ personId, city, fonte } = {}) {
  const parsed = parseCidadePerfil(city)
  if (!parsed) return { ok: false, motivo: 'cidade-invalida' }
  return aplicarCidade({ personId, cidade: parsed, fonte })
}

// Depois de unir duas redes: uma verdade só. Mesma cidade = fica. Diferente = conflito,
// mantém a de maior peso (perfil ganha de texto; empate mantém a do primário).
export function reconciliarAposUniao(primario, secundario) {
  const a = pessoaCanonica(primario)
  const ca = cidadeDaPessoa(primario)
  const cb = cidadeDaPessoa(secundario)
  if (!ca && !cb) return { ok: true, motivo: 'nenhuma' }
  if (ca && !cb) {
    aplicarCidade({ personId: a, cidade: ca, fonte: ca.fonte || 'manual', uf: ca.uf, forcar: true })
    return { ok: true, cidade: ca.nome }
  }
  if (!ca && cb) {
    aplicarCidade({ personId: a, cidade: cb, fonte: cb.fonte || 'manual', uf: cb.uf, forcar: true })
    return { ok: true, cidade: cb.nome }
  }
  if (mesma(ca.nome, cb.nome)) {
    aplicarCidade({ personId: a, cidade: ca, fonte: ca.fonte || cb.fonte || 'manual', uf: ca.uf || cb.uf, forcar: true })
    return { ok: true, cidade: ca.nome }
  }
  const fica = (FONTE_PESO[cb.fonte] || 0) > (FONTE_PESO[ca.fonte] || 0) ? cb : ca
  aplicarCidade({ personId: a, cidade: fica, fonte: fica.fonte || 'manual', uf: fica.uf, forcar: true })
  logEvent({
    type: 'cidade_conflito',
    personId: a,
    detail: `união: ficou ${fica.nome} (${fica.fonte || '?'}); a outra era ${fica === ca ? cb.nome : ca.nome}`,
  })
  return { ok: true, conflito: true, cidade: fica.nome }
}

function personIdTinder(accountKey, matchId) {
  return db().prepare(`SELECT person_id FROM tinder_match WHERE account_key=? AND match_id=?`)
    .get(accountKey, matchId)?.person_id || null
}

export function retroagirCidades() {
  let perfis = 0
  let textos = 0
  let conflitos = 0
  for (const row of db().prepare(`SELECT account_key, match_id, person_id, perfil_json FROM tinder_match WHERE perfil_json IS NOT NULL`).all()) {
    let p = null
    try { p = JSON.parse(row.perfil_json) } catch { continue }
    if (!p?.city) continue
    const r = aplicarCidadeDePerfil({ personId: row.person_id, city: p.city, fonte: 'perfil_tinder' })
    if (r?.ok) perfis++
    else if (r?.motivo === 'conflito') conflitos++
  }
  for (const row of db().prepare(`SELECT account_key, chat_id, perfil_json FROM badoo_chat WHERE perfil_json IS NOT NULL`).all()) {
    let p = null
    try { p = JSON.parse(row.perfil_json) } catch { continue }
    if (!p?.city) continue
    const r = aplicarCidadeDePerfil({ personId: 'b:' + row.chat_id, city: p.city, fonte: 'perfil_badoo' })
    if (r?.ok) perfis++
    else if (r?.motivo === 'conflito') conflitos++
  }
  for (const row of db().prepare(`
    SELECT person_id, text FROM message
    WHERE direction='incoming' AND text IS NOT NULL AND text != ''
      AND (lower(text) LIKE '%moro %' OR lower(text) LIKE '%sou de%'
        OR lower(text) LIKE '%sou do%' OR lower(text) LIKE '%sou da%'
        OR lower(text) LIKE '%vivo em%' OR lower(text) LIKE '%morava %')
  `).all()) {
    const r = aplicarCidadeDeTexto({ personId: row.person_id, texto: row.text })
    if (r?.ok) textos++
    else if (r?.motivo === 'conflito') conflitos++
  }
  const n = db().prepare(`SELECT COUNT(*) n FROM pessoa_pref WHERE cidade IS NOT NULL AND trim(cidade) != ''`).get()?.n || 0
  if (perfis || textos) {
    logEvent({
      type: 'cidade_retroativa',
      detail: `${n} pessoa(s) com cidade — ${perfis} de perfil, ${textos} de texto, ${conflitos} conflito(s)`,
    })
  }
  return { pessoas: n, perfis, textos, conflitos }
}

export { personIdTinder }
