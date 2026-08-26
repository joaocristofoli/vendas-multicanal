// COBRANÇA PROGRAMADA: em tal horário, ligar (e/ou enviar) cobrança pra estas pessoas.
//
// O que já existia: interruptor por pessoa + motivo. A IA só cobra na PRÓXIMA resposta.
// Pedido de 15/08/2026: "hoje quero programar uma cobrança pra tal horário, pra
// determinadas pessoas". Sem isso, ligar na mão às 18h é procedimento — e some no clone.
//
// Ação:
//   ligar  — autoriza a regra na hora marcada (próxima conversa cobra)
//   enviar — manda a mensagem com motivo, valor e PIX (texto fixo, sem modelo)
//   ambos  — os dois
//
// Alvos são SNAPSHOT: se a etiqueta Fatal crescer depois, a programação não ganha gente
// nova. Quem opera escolheu aquelas pessoas.
import { db, logEvent } from '../core/db.mjs'
import { pessoaCanonica, idsBrutosDaPessoa } from './identidade.mjs'
import { pessoasDaEtiqueta } from './etiquetas.mjs'
import { lerPix, salvarCobrancaPessoa, registrarCobrancaEnviada } from './pix.mjs'
import { lerServicos, formatarBRL } from './servicos.mjs'
import { nomeParaMostrar } from '../core/nome.mjs'

const agora = () => Date.now()
const MAX_ALVOS = 200
const MAX_MOTIVO = 500
const ATRASO_MAX_MS = 24 * 3600 * 1000
const ACOES = new Set(['ligar', 'enviar', 'ambos'])

export function garantirTabelas() {
  db().exec(`CREATE TABLE IF NOT EXISTS cobranca_programada (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quando INTEGER NOT NULL,
    motivo TEXT NOT NULL,
    valor_centavos INTEGER,
    servico TEXT,
    faixa TEXT,
    acao TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendente',
    erro TEXT,
    criado_em INTEGER NOT NULL,
    disparado_em INTEGER
  )`)
  db().exec(`CREATE TABLE IF NOT EXISTS cobranca_programada_alvo (
    programacao_id INTEGER NOT NULL,
    person_id TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendente',
    canal TEXT,
    erro TEXT,
    feito_em INTEGER,
    PRIMARY KEY (programacao_id, person_id)
  )`)
  db().exec(`CREATE INDEX IF NOT EXISTS idx_cobranca_prog_quando ON cobranca_programada (estado, quando)`)
}

function row(id) {
  return db().prepare(`SELECT * FROM cobranca_programada WHERE id=?`).get(Number(id)) || null
}

function alvosDe(id) {
  return db().prepare(`SELECT person_id AS personId, estado, canal, erro, feito_em AS feitoEm
    FROM cobranca_programada_alvo WHERE programacao_id=? ORDER BY person_id`).all(Number(id))
}

function comAlvos(p) {
  if (!p) return null
  const alvos = alvosDe(p.id).map((a) => ({ ...a, nome: nomeParaMostrar(a.personId) }))
  return {
    id: p.id,
    quando: p.quando,
    motivo: p.motivo,
    valorCentavos: p.valor_centavos,
    servico: p.servico,
    faixa: p.faixa,
    acao: p.acao,
    estado: p.estado,
    erro: p.erro,
    criadoEm: p.criado_em,
    disparadoEm: p.disparado_em,
    alvos,
    pendentes: alvos.filter((a) => a.estado === 'pendente').length,
    feitos: alvos.filter((a) => a.estado === 'ligado' || a.estado === 'enviado' || a.estado === 'ambos').length,
    falhas: alvos.filter((a) => a.estado === 'erro').length,
  }
}

export function listarProgramadas({ limite = 40 } = {}) {
  garantirTabelas()
  return db().prepare(`SELECT * FROM cobranca_programada ORDER BY
    CASE estado WHEN 'pendente' THEN 0 WHEN 'disparando' THEN 1 ELSE 2 END,
    quando ASC LIMIT ?`).all(limite).map(comAlvos)
}

function resolverValor({ valorCentavos, servico, faixa }) {
  if (Number.isInteger(valorCentavos) && valorCentavos > 0) return { valorCentavos, servico: servico || null, faixa: faixa || null }
  if (servico && faixa) {
    const s = lerServicos().itens.find((x) => x.nome.toLowerCase() === String(servico).toLowerCase())
    const f = s?.faixas?.find((x) => x.tempo.toLowerCase() === String(faixa).toLowerCase())
    if (f?.centavos) return { valorCentavos: f.centavos, servico: s.nome, faixa: f.tempo }
  }
  return { valorCentavos: null, servico: servico || null, faixa: faixa || null }
}

function motivoCompleto({ motivo, valorCentavos, servico, faixa }) {
  const partes = [String(motivo || '').trim()]
  if (servico && faixa) partes.push(`${servico} — ${faixa}`)
  if (valorCentavos) partes.push(formatarBRL(valorCentavos))
  return partes.filter(Boolean).join('. ').slice(0, MAX_MOTIVO)
}

export function montarTextoCobranca({ motivo, valorCentavos, servico, faixa } = {}) {
  const pix = lerPix()
  const linhas = ['oi']
  const corpo = String(motivo || '').trim()
  if (corpo) linhas.push(corpo)
  if (servico && faixa) linhas.push(`${servico} ${faixa}`)
  if (valorCentavos) linhas.push(`fica ${formatarBRL(valorCentavos)}`)
  if (pix.nome) linhas.push(`pix no nome ${pix.nome}`)
  if (pix.chave) linhas.push(pix.chave)
  return linhas.join('\n')
}

function coletarAlvos({ personIds = [], etiquetaId = null } = {}) {
  const ids = new Set()
  for (const bruto of Array.isArray(personIds) ? personIds : []) {
    const c = pessoaCanonica(bruto)
    if (c) ids.add(c)
  }
  if (etiquetaId) {
    for (const p of pessoasDaEtiqueta(etiquetaId)) {
      const c = pessoaCanonica(p.personId)
      if (c) ids.add(c)
    }
  }
  return [...ids]
}

export function programarCobranca({
  quando, motivo, valorCentavos = null, servico = null, faixa = null,
  acao = 'ambos', personIds = [], etiquetaId = null,
} = {}) {
  garantirTabelas()
  const t = Number(quando)
  if (!Number.isFinite(t) || t < agora() - 60 * 1000) throw new Error('escolha um horário no futuro')
  const mot = String(motivo || '').replace(/\s+/g, ' ').trim()
  if (!mot) throw new Error('escreva o motivo da cobrança')
  if (mot.length > MAX_MOTIVO) throw new Error(`o motivo pode ter no máximo ${MAX_MOTIVO} caracteres`)
  if (!ACOES.has(acao)) throw new Error('ação inválida')
  if (acao !== 'ligar') {
    const pix = lerPix()
    if (!pix.nome || !pix.chave) throw new Error('cadastre nome e chave PIX antes de programar um envio')
  }
  const val = resolverValor({ valorCentavos, servico, faixa })
  const alvos = coletarAlvos({ personIds, etiquetaId })
  if (!alvos.length) throw new Error('escolha pelo menos uma pessoa')
  if (alvos.length > MAX_ALVOS) throw new Error(`o máximo é ${MAX_ALVOS} pessoas por programação`)

  const r = db().prepare(`INSERT INTO cobranca_programada
    (quando,motivo,valor_centavos,servico,faixa,acao,estado,criado_em) VALUES(?,?,?,?,?,?, 'pendente', ?)`)
    .run(t, mot, val.valorCentavos, val.servico, val.faixa, acao, agora())
  const id = Number(r.lastInsertRowid)
  const ins = db().prepare(`INSERT OR IGNORE INTO cobranca_programada_alvo(programacao_id,person_id,estado) VALUES(?,?, 'pendente')`)
  for (const pid of alvos) ins.run(id, pid)
  logEvent({ type: 'cobranca_programada', detail: `${acao} em ${new Date(t).toISOString()} pra ${alvos.length} pessoa(s)` })
  return comAlvos(row(id))
}

export function cancelarProgramada(id) {
  garantirTabelas()
  const p = row(id)
  if (!p) throw new Error('programação não encontrada')
  if (p.estado !== 'pendente') throw new Error('essa já disparou ou já foi cancelada')
  db().prepare(`UPDATE cobranca_programada SET estado='cancelada' WHERE id=?`).run(p.id)
  db().prepare(`UPDATE cobranca_programada_alvo SET estado='cancelado' WHERE programacao_id=? AND estado='pendente'`).run(p.id)
  return comAlvos(row(id))
}

export function buscarPessoasCobranca(q, { limite = 20 } = {}) {
  const termo = String(q || '').trim()
  if (termo.length < 2) return []
  const like = `%${termo.replace(/[%_]/g, '')}%`
  const seen = new Set()
  const out = []
  const add = (pid) => {
    const c = pessoaCanonica(pid)
    if (!c || seen.has(c)) return
    seen.add(c)
    out.push({ personId: c, nome: nomeParaMostrar(c) })
  }
  for (const r of db().prepare(`SELECT person_id FROM person WHERE display_name LIKE ? COLLATE NOCASE LIMIT ?`).all(like, limite)) add(r.person_id)
  if (out.length < limite) {
    for (const r of db().prepare(`SELECT 'wa:'||jid AS pid FROM wa_chat WHERE name LIKE ? COLLATE NOCASE LIMIT ?`).all(like, limite)) add(r.pid)
  }
  if (out.length < limite) {
    for (const r of db().prepare(`SELECT person_id FROM tinder_match WHERE name LIKE ? COLLATE NOCASE LIMIT ?`).all(like, limite)) add(r.person_id)
  }
  if (out.length < limite) {
    for (const r of db().prepare(`SELECT 'b:'||chat_id AS pid FROM badoo_chat WHERE name LIKE ? COLLATE NOCASE LIMIT ?`).all(like, limite)) add(r.pid)
  }
  return out.slice(0, limite)
}

function canalDaPessoa(personId) {
  let ids = [personId]
  try { ids = idsBrutosDaPessoa(personId) } catch { /* só o id que temos */ }
  if (!ids.length) ids = [personId]
  const marks = ids.map(() => '?').join(',')
  const row = db().prepare(`SELECT channel FROM message WHERE person_id IN (${marks}) ORDER BY ts DESC LIMIT 1`).get(...ids)
  if (row?.channel) return row.channel
  if (ids.some((id) => String(id).startsWith('wa:'))) return 'whatsapp'
  if (ids.some((id) => String(id).startsWith('ig:'))) return 'instagram'
  if (ids.some((id) => String(id).startsWith('b:'))) return 'badoo'
  return 'whatsapp'
}

export async function dispararProgramada(p, { enviarParaPessoa } = {}) {
  garantirTabelas()
  if (!p || p.estado !== 'pendente') return { feitos: 0, falhas: 0 }
  db().prepare(`UPDATE cobranca_programada SET estado='disparando', disparado_em=? WHERE id=? AND estado='pendente'`).run(agora(), p.id)
  const alvos = alvosDe(p.id).filter((a) => a.estado === 'pendente')
  const dados = { motivo: p.motivo, valorCentavos: p.valor_centavos, servico: p.servico, faixa: p.faixa }
  const motivo = motivoCompleto(dados)
  const texto = montarTextoCobranca(dados)
  const querLigar = p.acao === 'ligar' || p.acao === 'ambos'
  const querEnviar = p.acao === 'enviar' || p.acao === 'ambos'
  let feitos = 0
  let falhas = 0

  for (const a of alvos) {
    const erros = []
    let ligado = false
    let enviado = false
    let canal = null
    try {
      if (querLigar) {
        salvarCobrancaPessoa(a.personId, { enabled: true, motivo })
        ligado = true
      }
      if (querEnviar) {
        if (typeof enviarParaPessoa !== 'function') throw new Error('envio indisponível neste momento')
        canal = canalDaPessoa(a.personId)
        await enviarParaPessoa({ personId: a.personId, canal, texto })
        registrarCobrancaEnviada({
          personId: a.personId, channel: canal,
          receiptKey: `prog:${p.id}:${a.personId}`, tipo: 'regra',
        })
        enviado = true
      }
    } catch (e) {
      erros.push(e.message || String(e))
    }
    const estado = erros.length && !ligado && !enviado
      ? 'erro'
      : (ligado && enviado ? 'ambos' : (enviado ? 'enviado' : (ligado ? 'ligado' : 'erro')))
    db().prepare(`UPDATE cobranca_programada_alvo SET estado=?, canal=?, erro=?, feito_em=?
      WHERE programacao_id=? AND person_id=?`)
      .run(estado, canal, erros[0] || null, agora(), p.id, a.personId)
    if (estado === 'erro') falhas++
    else feitos++
  }

  const resto = db().prepare(`SELECT COUNT(*) n FROM cobranca_programada_alvo WHERE programacao_id=? AND estado='pendente'`).get(p.id)?.n || 0
  const final = resto ? 'pendente' : (falhas && !feitos ? 'erro' : 'feita')
  db().prepare(`UPDATE cobranca_programada SET estado=?, erro=? WHERE id=?`)
    .run(final, falhas && !feitos ? 'nenhum alvo concluiu' : null, p.id)
  logEvent({ type: 'cobranca_programada_disparo', detail: `#${p.id} ${feitos} ok, ${falhas} falha(s)` })
  return { feitos, falhas }
}

export async function tickCobrancasProgramadas({ enviarParaPessoa, agoraMs = agora() } = {}) {
  garantirTabelas()
  const vencidas = db().prepare(`SELECT * FROM cobranca_programada
    WHERE estado='pendente' AND quando<=? ORDER BY quando ASC LIMIT 5`).all(agoraMs)
  let n = 0
  for (const p of vencidas) {
    if (agoraMs - p.quando > ATRASO_MAX_MS) {
      db().prepare(`UPDATE cobranca_programada SET estado='erro', erro=? WHERE id=?`)
        .run('passou mais de 24h do horário — não disparei', p.id)
      db().prepare(`UPDATE cobranca_programada_alvo SET estado='erro', erro=? WHERE programacao_id=? AND estado='pendente'`)
        .run('horário passou demais', p.id)
      continue
    }
    await dispararProgramada(p, { enviarParaPessoa })
    n++
  }
  return n
}
