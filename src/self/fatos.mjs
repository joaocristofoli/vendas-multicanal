// Memória estruturada sobre o dono: fatos com fonte, validade e política de uso.
//
// Isto NÃO substitui o retrato em prosa (sobre-mim/quem-eu-sou.md) — soma. O retrato
// continua sendo o núcleo estável; os fatos são a camada que cresce a partir das conversas
// reais (WhatsApp, Instagram, Tinder) e que sabe A HORA de aparecer.
//
// Três garantias de desenho:
//   1. Sem fato aprovado, `fatosBlock()` devolve '' e o prompt fica byte a byte igual.
//   2. Fato 'nunca' não é renderizado em situação nenhuma — a política é aplicada aqui,
//      na seleção, e não como pedido ao modelo. O modelo não vaza o que não recebeu.
//   3. Nada entra sozinho: fato nasce 'proposto' e só o dono aprova.
import crypto from 'node:crypto'
import { db, getSetting } from '../core/db.mjs'
import { pessoaCanonica } from './identidade.mjs'

const agora = () => Date.now()
const id16 = () => crypto.randomBytes(8).toString('hex')

export const CATEGORIAS = ['trabalho', 'formacao', 'familia', 'historia', 'gosto', 'rotina', 'lugar', 'saude', 'relacionamento', 'outro']
export const SENSIBILIDADES = ['livre', 'sob_pedido', 'nunca']

// Quantos fatos entram como pano de fundo (sem o assunto encostar neles).
const MAX_FUNDO = 2

const parseGatilhos = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }

// Normaliza pra comparar: minúsculo, sem acento. "Fotovoltaica" casa com "fotovoltaico".
export function chave(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export function listarFatos({ status = null, incluirNunca = true } = {}) {
  const where = []
  const args = []
  if (status) { where.push('status=?'); args.push(status) }
  if (!incluirNunca) where.push(`sensibilidade<>'nunca'`)
  const sql = `SELECT * FROM fato ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY status='proposto' DESC, categoria, updated_at DESC`
  return db().prepare(sql).all(...args).map((f) => ({ ...f, gatilhos: parseGatilhos(f.gatilhos) }))
}

export function salvarFato(f) {
  const idF = f.id || id16()
  const texto = String(f.texto || '').replace(/\s+/g, ' ').trim().slice(0, 400)
  if (!texto) throw new Error('fato vazio')
  const sens = SENSIBILIDADES.includes(f.sensibilidade) ? f.sensibilidade : 'livre'
  const status = ['proposto', 'aprovado', 'rejeitado'].includes(f.status) ? f.status : 'proposto'
  const existente = db().prepare(`SELECT id, recorded_at FROM fato WHERE id=?`).get(idF)
  db().prepare(`INSERT INTO fato(id,texto,categoria,sensibilidade,status,origem,origem_ref,confianca,gatilhos,valid_from,valid_to,recorded_at,updated_at)
    VALUES(@id,@texto,@categoria,@sensibilidade,@status,@origem,@origem_ref,@confianca,@gatilhos,@valid_from,@valid_to,@recorded_at,@updated_at)
    ON CONFLICT(id) DO UPDATE SET texto=excluded.texto, categoria=excluded.categoria, sensibilidade=excluded.sensibilidade,
      status=excluded.status, origem=excluded.origem, origem_ref=excluded.origem_ref, confianca=excluded.confianca,
      gatilhos=excluded.gatilhos, valid_from=excluded.valid_from, valid_to=excluded.valid_to, updated_at=excluded.updated_at`)
    .run({
      id: idF, texto, categoria: CATEGORIAS.includes(f.categoria) ? f.categoria : 'outro',
      sensibilidade: sens, status, origem: f.origem || 'manual', origem_ref: f.origemRef || null,
      confianca: typeof f.confianca === 'number' ? f.confianca : 0.5,
      gatilhos: JSON.stringify((f.gatilhos || []).map((g) => String(g).trim()).filter(Boolean).slice(0, 12)),
      valid_from: f.validFrom || null, valid_to: f.validTo || null,
      recorded_at: existente?.recorded_at || agora(), updated_at: agora(),
    })
  return idF
}

export function apagarFato(idF) { db().prepare(`DELETE FROM fato WHERE id=?`).run(idF) }

// Invalidar em vez de apagar: o fato deixou de valer, mas continua sendo verdade sobre o
// passado. É o que permite "morei em Cidade Natal" sem a IA dizer que ele mora lá hoje.
export function invalidarFato(idF, quando = agora()) {
  db().prepare(`UPDATE fato SET valid_to=?, updated_at=? WHERE id=?`).run(quando, agora(), idF)
}

const vigente = (f, quando = agora()) => (!f.valid_from || f.valid_from <= quando) && (!f.valid_to || f.valid_to > quando)

// Seleção por relevância ao que está sendo conversado. Sem assunto que encoste no fato,
// só entram os 'livre' de maior confiança — é o que evita despejar currículo.
export function selecionarFatos({ textoDaConversa = '', limite = 10, jaContados = null } = {}) {
  const alvo = chave(textoDaConversa)
  // Fato já contado pra ESTA pessoa sai da mesa. Não é censura, é o que qualquer um faz:
  // ninguém conta a mesma história pra mesma pessoa duas vezes na mesma semana.
  const contados = jaContados instanceof Set ? jaContados : null
  const todos = listarFatos({ status: 'aprovado', incluirNunca: false })
    .filter((f) => vigente(f) && !(contados && contados.has(f.id)))
  const pontuados = todos.map((f) => {
    const gat = f.gatilhos.length ? f.gatilhos : f.texto.split(/\s+/).filter((w) => w.length >= 5).slice(0, 6)
    const casou = gat.filter((g) => g && alvo.includes(chave(g)))
    return { fato: f, casou: casou.length, score: casou.length * 10 + (f.confianca || 0.5) }
  })
  // 'sob_pedido' só passa quando o assunto realmente encostou: é o "saber a hora de usar".
  const elegiveis = pontuados.filter((p) => p.fato.sensibilidade !== 'sob_pedido' || p.casou > 0)
  const casaram = elegiveis.filter((p) => p.casou > 0).sort((a, b) => b.score - a.score)
  // Fato que NÃO encostou no assunto entra só em dose pequena (pano de fundo). Sem esse
  // teto, todo fato 'livre' viajava em toda geração: com 2 fatos são 460 chars, com os 50
  // que a extração profunda vai gerar seria peso morto em cada mensagem — e ruído, porque
  // a IA lê gosto musical numa conversa sobre plantão de hospital.
  const soltos = elegiveis.filter((p) => p.casou === 0).sort((a, b) => b.score - a.score).slice(0, MAX_FUNDO)
  return [...casaram, ...soltos].slice(0, limite).map((p) => p.fato)
}

// Bloco pronto pro prompt, ou '' quando não há nada a dizer (prompt idêntico ao de antes).
export function fatosBlock({ textoDaConversa = '', limite = 10, personId = null } = {}) {
  if (!getSetting('fatos_awareness', true)) return { texto: '', usados: [] }
  let escolhidos = []
  const jaContados = personId ? fatosJaContados(personId) : null
  try { escolhidos = selecionarFatos({ textoDaConversa, limite, jaContados }) } catch { return { texto: '', usados: [] } }
  if (!escolhidos.length) return { texto: '', usados: [] }
  const linhas = escolhidos.map((f) => `- ${f.texto}`).join('\n')
  const texto = [
    'MAIS COISAS VERDADEIRAS SOBRE O USUÁRIO (memória própria dele, além do retrato acima).',
    'Valem as mesmas regras do retrato: são fatos reais, usados só quando criarem conexão natural com o assunto, em dose pequena, nunca como currículo e nunca listados de uma vez. Se nenhum encaixar nesta resposta, não use nenhum.',
    linhas,
  ].join('\n')
  // `usados` continua sendo os ids (quem já lia isso não muda); `objetos` existe pro ledger
  // conseguir conferir DEPOIS quais deles a mensagem realmente contou.
  return { texto, usados: escolhidos.map((f) => f.id), objetos: escolhidos }
}

export function marcarUso(ids = []) {
  if (!ids.length) return
  const stmt = db().prepare(`UPDATE fato SET usos=usos+1, ultimo_uso_at=? WHERE id=?`)
  const t = agora()
  for (const i of ids) { try { stmt.run(t, i) } catch { /* fato apagado no meio */ } }
}

// ---------- ledger de asserções ----------
// Toda mensagem que a IA manda em nome do dono fica registrada com os fatos que estavam
// no contexto. É o que responde depois: "o que o clone já afirmou, pra quem, com base em quê".
// Quais dos fatos OFERECIDOS a mensagem realmente contou. A diferença importa: o contexto
// oferece até 10 fatos e a mensagem usa zero ou um. Registrar todos como "ditos" faria o
// sistema achar que já contou a vida inteira pra ela depois de duas mensagens, e aí nunca
// mais teria o que dizer.
//
// A prova de que foi dito é a palavra distintiva do fato aparecendo no texto que saiu —
// mesma normalização que a seleção usa, então os dois lados enxergam igual.
export function fatosDitosNoTexto(fatos = [], texto = '') {
  const alvo = chave(texto)
  if (!alvo) return []
  const ids = []
  for (const f of fatos) {
    if (!f) continue
    const marcas = (f.gatilhos && f.gatilhos.length ? f.gatilhos : String(f.texto || '').split(/\s+/).filter((w) => w.length >= 5))
      .map((g) => chave(g)).filter(Boolean)
    if (marcas.some((m) => alvo.includes(m))) ids.push(f.id)
  }
  return ids
}

export function registrarAssercao({ personId, channel, messageId, texto, fatos = [] }) {
  const idA = id16()
  try {
    // Sempre no id CANÔNICO: o que o clone disse pra uma pessoa é dela inteira, não da
    // thread. Sem isso, "o que eu já contei pra ela" ficaria picado por rede social.
    const pid = personId ? pessoaCanonica(personId) : null
    // `fatos` pode vir como ids (do meta antigo) ou como objetos. Só dá pra checar o que
    // foi realmente dito quando vêm os objetos; com ids soltos, mantém o comportamento
    // anterior em vez de adivinhar.
    const objetos = fatos.filter((f) => f && typeof f === 'object')
    const ids = objetos.length ? fatosDitosNoTexto(objetos, texto) : fatos.filter((f) => typeof f === 'string')
    db().prepare(`INSERT INTO fato_assercao(id,person_id,channel,message_id,texto,fatos,ts) VALUES(?,?,?,?,?,?,?)`)
      .run(idA, pid, channel || null, messageId || null, String(texto || '').slice(0, 2000), JSON.stringify(ids), agora())
    marcarUso(ids)
  } catch { /* ledger nunca pode derrubar um envio */ }
  return idA
}

// O QUE EU JÁ CONTEI PRA ELA. É o que impede a IA de contar a mesma história do mestrado
// duas vezes na mesma conversa (caso fixture sintética, 27/07/2026) — só que aqui na raiz: o fato
// nem chega a ser oferecido de novo, em vez de ser barrado depois de escrito.
export function fatosJaContados(personId, { limite = 80 } = {}) {
  if (!personId) return new Set()
  try {
    const pid = pessoaCanonica(personId)
    const linhas = db().prepare(`SELECT fatos FROM fato_assercao WHERE person_id=? ORDER BY ts DESC LIMIT ?`).all(pid, limite)
    const s = new Set()
    for (const l of linhas) for (const id of parseGatilhos(l.fatos)) s.add(id)
    return s
  } catch { return new Set() }
}

export function assercoesDaPessoa(personId, limite = 50) {
  const pid = pessoaCanonica(personId)
  return db().prepare(`SELECT * FROM fato_assercao WHERE person_id=? ORDER BY ts DESC LIMIT ?`).all(pid, limite)
    .map((a) => ({ ...a, fatos: parseGatilhos(a.fatos) }))
}

export function assercoesRecentes(limite = 100) {
  return db().prepare(`SELECT * FROM fato_assercao ORDER BY ts DESC LIMIT ?`).all(limite)
    .map((a) => ({ ...a, fatos: parseGatilhos(a.fatos) }))
}

export function contagemFatos() {
  const r = db().prepare(`SELECT status, sensibilidade, COUNT(*) n FROM fato GROUP BY status, sensibilidade`).all()
  const out = { proposto: 0, aprovado: 0, rejeitado: 0, nunca: 0, total: 0 }
  for (const x of r) {
    out[x.status] = (out[x.status] || 0) + x.n
    if (x.sensibilidade === 'nunca') out.nunca += x.n
    out.total += x.n
  }
  return out
}
