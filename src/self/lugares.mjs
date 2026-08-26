// ONDE ELE ESTÁ, e quando. Duas coisas e uma regra.
//
// LUGAR é um grupo de cidades que ele alcança de onde está — de casa ele chega na cidade
// dele e em duas vizinhas, então as três são o mesmo lugar. Não é uma cidade só: se fosse, ele
// teria que cadastrar a mesma faixa de horário três vezes pra cobrir a região.
//
// PERÍODO é a linha do tempo desse lugar. Fora de qualquer período ele está na BASE. Dentro
// de um período 'em_lugar' ele está em outro lugar, e é isso que resolve o pedido original
// (26/07/2026): "já tenho uma viagem marcada e esse período todo eu tô em São Paulo, então
// não poderei ter compromissos em nenhuma cidade da minha região". A viagem não bloqueia a
// agenda — ela MUDA o lugar, e a janela da região simplesmente não vale enquanto ele estiver
// fora. Um período 'ocupado' é o outro caso: nada pode ser marcado, mesmo com a Google
// Agenda vazia — porque vazio na agenda nunca significou disponível.
//
// Tudo aqui é consulta a banco e comparação de string de data. Nenhuma chamada de modelo:
// "onde eu estou dia 12 de agosto" é uma pergunta com resposta exata, e uma resposta exata
// não se pede pra uma IA. Ver a regra da função eterna no CLAUDE.md.
import crypto from 'node:crypto'
import { db } from '../core/db.mjs'

const TZ = 'America/Sao_Paulo'
const agora = () => Date.now()
const id8 = () => crypto.randomBytes(6).toString('hex')

// Data no fuso de São Paulo, como 'YYYY-MM-DD'. Toda comparação de período é feita nesta
// string: período é dia inteiro, e dia inteiro é um conceito de calendário, não de relógio.
const fmtData = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
export function dataDe(ms) { return fmtData.format(new Date(ms)) }

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/
export function ehData(s) { return DATA_RE.test(String(s || '').trim()) }

function cidadesDe(row) {
  if (!row) return []
  try { const a = JSON.parse(row.cidades || '[]'); return Array.isArray(a) ? a.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim()) : [] }
  catch { return [] }
}

const comCidades = (row) => (row ? { ...row, base: !!row.base, cidades: cidadesDe(row) } : null)

// ---------------------------------------------------------------- lugares
export function listarLugares() {
  return db().prepare(`SELECT * FROM lugar ORDER BY base DESC, nome`).all().map(comCidades)
}

export function lugarPorId(id) {
  if (!id) return null
  return comCidades(db().prepare(`SELECT * FROM lugar WHERE id=?`).get(id))
}

// A base. Pode não existir (ele apagou tudo) — quem chama tem que aguentar null, porque
// inventar uma base seria decidir por ele onde ele mora.
export function lugarBase() {
  return comCidades(db().prepare(`SELECT * FROM lugar WHERE base=1 ORDER BY updated_at LIMIT 1`).get())
}

export function salvarLugar({ id, nome, cidades = [], base = false }) {
  const n = String(nome || '').trim()
  if (!n) throw new Error('o lugar precisa de um nome')
  const lista = (Array.isArray(cidades) ? cidades : String(cidades).split(','))
    .map((c) => String(c).trim()).filter(Boolean)
  const idL = id || id8()
  const d = db()
  d.prepare(`INSERT INTO lugar(id,nome,cidades,base,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, cidades=excluded.cidades, base=excluded.base, updated_at=excluded.updated_at`)
    .run(idL, n, JSON.stringify(lista), base ? 1 : 0, agora())
  // Base é única: marcar uma desmarca a outra. Duas bases fariam `lugarBase()` escolher no
  // escuro, e "onde eu moro" não pode depender de qual linha o SQLite devolveu primeiro.
  if (base) d.prepare(`UPDATE lugar SET base=0 WHERE id<>?`).run(idL)
  return idL
}

// Apagar um lugar não pode deixar janela nem período apontando pra um id morto: janela
// órfã voltaria a valer como se fosse da base (e ele veria horário sendo oferecido numa
// cidade que ele acabou de tirar do sistema). Então a janela vai junto, e o período volta
// a ser um período sem lugar, que o cálculo trata como desconhecido e ignora.
export function apagarLugar(id) {
  const d = db()
  const alvo = lugarPorId(id)
  if (!alvo) return { apagado: false, janelas: 0, periodos: 0 }
  const janelas = d.prepare(`SELECT COUNT(*) c FROM date_janela WHERE lugar_id=?`).get(id).c
  const periodos = d.prepare(`SELECT COUNT(*) c FROM periodo WHERE lugar_id=?`).get(id).c
  d.prepare(`DELETE FROM date_janela WHERE lugar_id=?`).run(id)
  d.prepare(`DELETE FROM periodo WHERE lugar_id=?`).run(id)
  d.prepare(`DELETE FROM lugar WHERE id=?`).run(id)
  return { apagado: true, janelas, periodos }
}

// ---------------------------------------------------------------- períodos
export function listarPeriodos({ desde = null } = {}) {
  const rows = db().prepare(`SELECT * FROM periodo ORDER BY de`).all()
  const corte = desde ? dataDe(desde) : null
  return rows
    .filter((p) => !corte || (p.ate || p.de) >= corte)
    .map((p) => ({ ...p, lugar: p.lugar_id ? lugarPorId(p.lugar_id) : null }))
}

export function salvarPeriodo({ id, de, ate, tipo = 'em_lugar', lugarId = null, titulo = '', eventId = null }) {
  const d1 = String(de || '').trim(), d2 = String(ate || de || '').trim()
  if (!ehData(d1) || !ehData(d2)) throw new Error('data inválida (use AAAA-MM-DD)')
  if (d2 < d1) throw new Error('o fim tem que ser depois do início')
  const t = tipo === 'ocupado' ? 'ocupado' : 'em_lugar'
  if (t === 'em_lugar' && !lugarId) throw new Error('escolha o lugar onde você estará')
  if (t === 'em_lugar' && !lugarPorId(lugarId)) throw new Error('esse lugar não existe mais')
  const idP = id || id8()
  db().prepare(`INSERT INTO periodo(id,de,ate,tipo,lugar_id,titulo,event_id,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET de=excluded.de, ate=excluded.ate, tipo=excluded.tipo,
      lugar_id=excluded.lugar_id, titulo=excluded.titulo, event_id=excluded.event_id, updated_at=excluded.updated_at`)
    .run(idP, d1, d2, t, t === 'em_lugar' ? lugarId : null, String(titulo || '').trim().slice(0, 200) || null, eventId || null, agora())
  return idP
}

export function apagarPeriodo(id) { db().prepare(`DELETE FROM periodo WHERE id=?`).run(id) }

// Já existe período criado a partir deste evento do Google? Evita dois períodos idênticos
// quando ele clica duas vezes no mesmo compromisso.
export function periodoDoEvento(eventId) {
  if (!eventId) return null
  const r = db().prepare(`SELECT * FROM periodo WHERE event_id=? LIMIT 1`).get(eventId)
  return r ? { ...r, lugar: r.lugar_id ? lugarPorId(r.lugar_id) : null } : null
}

// ---------------------------------------------------------------- a regra
// Onde ele está num instante, e se está disponível de alguma forma.
//   { ocupado: true }                      -> período 'ocupado' cobrindo o dia
//   { lugarId, nome, cidades, fora: bool } -> o lugar ativo; fora=true quando não é a base
//
// `periodos` e `base` entram por parâmetro pra este cálculo ser testável sem banco, mas o
// padrão é ler do banco — quem chama não precisa saber que existe uma tabela.
//
// Empate (dois períodos no mesmo dia): 'ocupado' vence, porque é a leitura mais restritiva e
// errar pra menos só custa um horário não oferecido; errar pra mais marca compromisso onde
// ele não pode estar. Entre dois 'em_lugar', vence o editado mais recentemente.
export function lugarAtivoEm(ms, { periodos = null, base = undefined } = {}) {
  const dia = dataDe(ms)
  const lista = periodos || listarPeriodos()
  const cobrindo = lista.filter((p) => p.de <= dia && dia <= (p.ate || p.de))
  if (cobrindo.some((p) => p.tipo === 'ocupado')) return { ocupado: true, lugarId: null, nome: null, cidades: [], fora: false }
  const emLugar = cobrindo.filter((p) => p.tipo === 'em_lugar' && p.lugar_id)
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
  const b = base === undefined ? lugarBase() : base
  if (emLugar.length) {
    const l = emLugar[0].lugar || lugarPorId(emLugar[0].lugar_id)
    // Período apontando pra lugar apagado: não dá pra afirmar onde ele está, e afirmar a
    // base seria chutar. Trata como ocupado — o horário não é oferecido e ninguém marca
    // nada baseado num palpite.
    if (!l) return { ocupado: true, lugarId: null, nome: null, cidades: [], fora: false, motivo: 'lugar removido' }
    return { ocupado: false, lugarId: l.id, nome: l.nome, cidades: l.cidades, fora: !b || l.id !== b.id, periodo: emLugar[0] }
  }
  if (!b) return { ocupado: false, lugarId: null, nome: null, cidades: [], fora: false, semBase: true }
  return { ocupado: false, lugarId: b.id, nome: b.nome, cidades: b.cidades, fora: false }
}

// Uma janela vale nesse dia? lugar_id NULL na janela significa "a base", não "qualquer
// lugar" — quem cadastrou "quarta 19h" cadastrou pra onde mora.
export function janelaValeNoLugar(janela, ativo, base) {
  if (!ativo || ativo.ocupado) return false
  if (ativo.semBase) return true             // sem base cadastrada, o lugar não filtra nada
  const daJanela = janela.lugar_id || (base ? base.id : null)
  if (!daJanela) return true
  return daJanela === ativo.lugarId
}
