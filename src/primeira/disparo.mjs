// PRIMEIRA MENSAGEM SEM MODELO DE LINGUAGEM.
//
// Regra do sistema em 27/07/2026: escolher os perfis na mão, escolher o que mandar entre
// opções que ele escreveu, e disparar — "assim eu economizo token". É também a regra da casa
// (CLAUDE.md): capacidade nova nasce como função eterna, não como chamada de modelo. Aqui não
// há nenhuma: o texto é dele, a substituição é `String.replace`, e a escolha de quem recebe o
// quê é um rodízio determinístico.
//
// O que este módulo garante, e que um disparo em massa feito na mão não garantiria:
//   - NUNCA manda pra quem já tem conversa naquele canal (a checagem é refeita na hora do
//     envio, não só na hora de listar — a lista pode ter minutos de idade);
//   - comprovante por alvo (`send_receipt`), então rodar duas vezes não manda duas vezes;
//   - ritmo humano entre envios, bem mais lento que o do deslizar: primeira mensagem em
//     rajada é o jeito mais rápido de queimar uma conta;
//   - se o modelo usa {nome} e a pessoa não tem nome de verdade, ela é PULADA em vez de
//     receber "oi contato sem nome".
import crypto from 'node:crypto'
import { db, saveReceipt, logEvent, upsertPerson, addMessage } from '../core/db.mjs'
import { nomeParaMostrar, temNomeDeVerdade } from '../core/nome.mjs'

const CANAIS = new Set(['tinder', 'badoo'])
const fp = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16)
const id12 = () => crypto.randomBytes(6).toString('hex')

// Ritmo entre uma primeira mensagem e a próxima. Ordem de grandeza MUITO maior que a do
// deslizar (segundos lá, dezenas de segundos aqui) porque o custo de errar é outro: swipe
// errado ninguém vê, mensagem em rajada derruba a conta.
export const RITMO_ENVIO = { minMs: 22000, maxMs: 75000 }
export function pausaEnvio(rnd = Math.random) {
  const { minMs, maxMs } = RITMO_ENVIO
  // viés pros valores baixos, com cauda: a maioria sai rápido, algumas demoram
  return Math.round(minMs + Math.pow(rnd(), 1.7) * (maxMs - minMs))
}

// ---------------------------------------------------------------- modelos
// As "opções do que quero enviar". Texto do dono, guardado como está.
export function listarModelos({ canal = null } = {}) {
  const onde = canal ? `WHERE canal IS NULL OR canal=?` : ''
  const args = canal ? [canal] : []
  return db().prepare(`SELECT * FROM modelo_msg ${onde} ORDER BY ativo DESC, criado_em DESC`).all(...args)
    .map((m) => ({ ...m, ativo: !!m.ativo, usaNome: /\{nome\}/.test(m.texto) }))
}

export function salvarModelo({ id = null, texto, canal = null, ativo = true }) {
  const t = String(texto || '').trim()
  if (!t) throw new Error('texto vazio')
  if (t.length > 900) throw new Error('texto longo demais')
  if (canal && !CANAIS.has(canal)) throw new Error('canal inválido')
  if (id) {
    db().prepare(`UPDATE modelo_msg SET texto=?, canal=?, ativo=? WHERE id=?`).run(t, canal, ativo ? 1 : 0, id)
    return db().prepare(`SELECT * FROM modelo_msg WHERE id=?`).get(id)
  }
  const novo = id12()
  db().prepare(`INSERT INTO modelo_msg(id,canal,texto,ativo,criado_em) VALUES(?,?,?,?,?)`)
    .run(novo, canal, t, ativo ? 1 : 0, Date.now())
  return db().prepare(`SELECT * FROM modelo_msg WHERE id=?`).get(novo)
}

export function apagarModelo(id) { db().prepare(`DELETE FROM modelo_msg WHERE id=?`).run(id); return true }

// Substituição determinística. Só duas variáveis, porque são as duas que existem pros dois
// canais sem depender de ler perfil: nome e idade.
export function preencher(texto, { nome, idade } = {}) {
  return String(texto)
    .replace(/\{nome\}/g, nome || '')
    .replace(/\{idade\}/g, idade != null ? String(idade) : '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// ---------------------------------------------------------------- quem ainda não recebeu
export function candidatos({ accountKey = 'main', canal, limite = 300 } = {}) {
  if (!CANAIS.has(canal)) throw new Error('canal inválido')
  if (canal === 'tinder') {
    return db().prepare(`SELECT match_id, person_id, name, age, city, photos_json, updated_at
      FROM tinder_match
      WHERE account_key=? AND active=1 AND has_conversation=0
      ORDER BY updated_at DESC LIMIT ?`).all(accountKey, limite)
      .map((m) => ({
        alvo: m.match_id,
        personId: m.person_id,
        nome: m.name || nomeParaMostrar(m.person_id),
        idade: m.age || null,
        cidade: m.city || null,
        foto: (() => { try { return (JSON.parse(m.photos_json || '[]')[0]) || null } catch { return null } })(),
        temNome: !!(m.name && m.name.trim()),
      }))
  }
  // Badoo: conversa que existe na lista e ainda não tem mensagem nenhuma no banco
  // a coluna da foto no badoo_chat é `foto`, não `avatar` (o ig_chat é que usa `avatar`)
  return db().prepare(`SELECT b.chat_id, b.name, b.foto
    FROM badoo_chat b
    WHERE b.account_key=? AND NOT EXISTS (SELECT 1 FROM message m WHERE m.person_id = 'b:'||b.chat_id)
    ORDER BY b.updated_at DESC LIMIT ?`).all(accountKey, limite)
    .map((c) => ({
      alvo: c.chat_id,
      personId: 'b:' + c.chat_id,
      nome: c.name || nomeParaMostrar('b:' + c.chat_id),
      idade: null,
      cidade: null,
      foto: c.foto || null,
      temNome: !!(c.name && c.name.trim()),
    }))
}

// Já mandamos primeira mensagem pra esse alvo alguma vez?
function jaDisparado(accountKey, canal, alvo) {
  const r = db().prepare(`SELECT state FROM send_receipt WHERE account_key=? AND channel=? AND target_id=?`)
    .get(accountKey, `${canal}-primeira`, alvo)
  return !!r && r.state !== 'failed'
}

// A conversa ganhou mensagem no meio do caminho? (a lista pode estar velha)
function temConversaAgora(accountKey, canal, alvo, personId) {
  if (canal === 'tinder') {
    const m = db().prepare(`SELECT active, has_conversation FROM tinder_match WHERE account_key=? AND match_id=?`).get(accountKey, alvo)
    if (!m) return true          // sumiu do banco: não manda
    return !m.active || !!m.has_conversation
  }
  const n = db().prepare(`SELECT COUNT(*) n FROM message WHERE person_id=?`).get(personId).n
  return n > 0
}

// ---------------------------------------------------------------- o disparo
// `enviar` é injetado por quem chama (o index tem o cliente do Tinder e o do Badoo prontos),
// pra este módulo não depender de sessão nem de navegador — e ficar testável sem rede.
export async function dispararPrimeira({
  accountKey = 'main', canal, alvos = [], modelos = [], dryRun = true,
  enviar, aoAndar = null, rnd = Math.random, esperar = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!CANAIS.has(canal)) throw new Error('canal inválido')
  const textos = modelos.map((m) => (typeof m === 'string' ? m : m.texto)).map((t) => String(t || '').trim()).filter(Boolean)
  if (!textos.length) throw new Error('escolha pelo menos uma mensagem')
  if (!alvos.length) throw new Error('escolha pelo menos um perfil')

  const lista = candidatos({ accountKey, canal, limite: 5000 })
  const porAlvo = new Map(lista.map((c) => [String(c.alvo), c]))
  const comando = id12()
  const saida = []
  let enviadas = 0

  for (let i = 0; i < alvos.length; i++) {
    const alvo = String(alvos[i])
    const c = porAlvo.get(alvo)
    const anota = (situacao, extra = {}) => saida.push({ alvo, nome: c?.nome || null, situacao, ...extra })

    if (!c) { anota('pulado', { motivo: 'não está mais na lista de quem não tem conversa' }); continue }
    if (jaDisparado(accountKey, canal, alvo)) { anota('pulado', { motivo: 'já recebeu primeira mensagem' }); continue }
    if (temConversaAgora(accountKey, canal, alvo, c.personId)) { anota('pulado', { motivo: 'a conversa já começou' }); continue }

    // rodízio determinístico: nem todo mundo recebe o mesmo texto
    const molde = textos[i % textos.length]
    if (/\{nome\}/.test(molde) && !(c.temNome || temNomeDeVerdade(c.personId))) {
      anota('pulado', { motivo: 'o modelo usa o nome e essa pessoa não tem nome salvo' }); continue
    }
    const texto = preencher(molde, { nome: c.nome, idade: c.idade })
    if (!texto) { anota('pulado', { motivo: 'o texto ficou vazio depois de preencher' }); continue }

    if (dryRun) { anota('ensaio', { texto }); continue }

    saveReceipt({ accountKey, channel: `${canal}-primeira`, targetId: alvo, commandId: comando, textFp: fp(texto), state: 'sending' })
    let r
    try { r = await enviar({ alvo, personId: c.personId, texto, candidato: c }) } catch (e) { r = { ok: false, erro: e.message } }
    if (!r || !r.ok) {
      saveReceipt({ accountKey, channel: `${canal}-primeira`, targetId: alvo, commandId: comando, textFp: fp(texto), state: 'failed' })
      anota('falhou', { texto, motivo: r?.erro || `status ${r?.status ?? '?'}` })
      continue
    }
    saveReceipt({ accountKey, channel: `${canal}-primeira`, targetId: alvo, commandId: comando, textFp: fp(texto), state: 'sent', providerMsgId: r.messageId || null })
    // a bolha entra no histórico na hora, como nos outros canais — author 'humano' porque o
    // texto é dele, não de modelo nenhum
    try {
      upsertPerson({ personId: c.personId, accountKey, name: c.nome })
      addMessage({
        messageId: r.messageId || `local:${canal}:${alvo}:${fp(texto)}`,
        accountKey, personId: c.personId, channel: canal, direction: 'outgoing',
        text: texto, ts: Date.now(), author: 'humano',
      })
    } catch { /* histórico é bônus; o comprovante é o que vale */ }
    logEvent({ type: 'primeira_enviada', personId: c.personId, channel: canal, detail: texto.slice(0, 80) })
    anota('enviada', { texto })
    enviadas++
    if (i < alvos.length - 1) await esperar(pausaEnvio(rnd))
    if (aoAndar) aoAndar({ feitos: i + 1, total: alvos.length, enviadas })
  }

  return {
    canal, dryRun, pedidos: alvos.length, enviadas,
    puladas: saida.filter((s) => s.situacao === 'pulado').length,
    falhas: saida.filter((s) => s.situacao === 'falhou').length,
    comando, itens: saida,
  }
}
