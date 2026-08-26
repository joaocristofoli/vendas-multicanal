// Encontrar a mesma pessoa em canais diferentes.
//
// Estado real medido em 25/07/2026: 993 ids de pessoa com mensagem e UM único alias no
// banco inteiro. O mecanismo de união existe e é bom; o que faltava era alguém procurar.
//
// Coincidência continua só PROPONDO. A única exceção é uma migração entre redes com convite
// comprovado + identidade forte e isolada (nome/apresentação/origem): nesse caso o sistema
// conclui sozinho e mantém um merge reversível. As travas nasceram de 28 vínculos errados
// criados por automação que usava apenas proximidade de horário — isso segue proibido.
import crypto from 'node:crypto'
import { db, convitesDoCanal, getSetting, getAiSetting, getReceipt, setAiSetting, logEvent } from '../core/db.mjs'
import { canonicalPersonId, mergePeople, personCardRaw } from '../projects/store.mjs'
import { pessoaCanonica, mesmaPessoa } from './identidade.mjs'
import { reconstruirConvitesDasSaidas, nomeDeclaradoNaResposta } from '../bridge/convites.mjs'

const agora = () => Date.now()
const id12 = () => crypto.randomBytes(6).toString('hex')

export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

// Nomes que não identificam ninguém: casar por eles produziria par aleatório.
const GENERICOS = new Set(['amor', 'mor', 'bb', 'vida', 'linda', 'lindo', 'amiga', 'amigo', 'mae', 'pai', 'casa', 'trabalho', 'eu', 'contato'])

function conversas(accountKey = 'main') {
  const d = db()
  const out = []
  for (const c of d.prepare(`SELECT jid, name, pn FROM wa_chat WHERE account_key=?`).all(accountKey)) {
    out.push({ id: 'wa:' + c.jid, canal: 'whatsapp', nome: c.name, extra: c.pn })
  }
  for (const c of d.prepare(`SELECT thread_id, name, username FROM ig_chat WHERE account_key=?`).all(accountKey)) {
    out.push({ id: 'ig:' + c.thread_id, canal: 'instagram', nome: c.name, extra: c.username })
  }
  for (const c of d.prepare(`SELECT person_id, name FROM tinder_match WHERE account_key=? AND name IS NOT NULL`).all(accountKey)) {
    out.push({ id: c.person_id, canal: 'tinder', nome: c.name, extra: null })
  }
  for (const c of d.prepare(`SELECT chat_id, name FROM badoo_chat WHERE account_key=?`).all(accountKey)) {
    out.push({ id: 'b:' + c.chat_id, canal: 'badoo', nome: c.name, extra: null })
  }
  return out
}

const volume = (id) => db().prepare(`SELECT COUNT(*) n FROM message WHERE person_id=?`).get(id)?.n || 0
// Quando esta conversa começou. Infinity quando não tem mensagem: sem primeira mensagem não
// dá pra dizer que ela "apareceu depois" de nada.
const primeiraMensagem = (id) => db().prepare(`SELECT MIN(ts) t FROM message WHERE person_id=?`).get(id)?.t || Infinity

// Um par já resolvido (mesma pessoa) ou já recusado não volta pra fila.
function jaDecidido(a, b) {
  // Os DOIS mecanismos: alias E identity. Sem o identity, 17 pares já unidos voltavam
  // pra fila apontando pra conversas de WhatsApp vazias (medido em 25/07/2026).
  if (mesmaPessoa(a, b)) return true
  const r = db().prepare(`SELECT status FROM uniao_sugerida WHERE (a_person_id=? AND b_person_id=?) OR (a_person_id=? AND b_person_id=?)`).get(a, b, b, a)
  return !!r && r.status !== 'pendente'
}

function guardar({ a, b, motivo, forca }) {
  // O par é sem direção. Sem ordenar, um sinal podia gravar A→B e outro B→A, escapando da
  // UNIQUE(a,b) e desenhando dois cartões iguais na revisão.
  let aa = a, bb = b
  if (String(aa) > String(bb)) [aa, bb] = [bb, aa]
  if (mesmaPessoa(aa, bb)) return false
  const existente = db().prepare(`SELECT id,status,motivo,forca FROM uniao_sugerida
    WHERE (a_person_id=? AND b_person_id=?) OR (a_person_id=? AND b_person_id=?)`).get(aa, bb, bb, aa)
  if (existente) {
    // Pendente pode ganhar evidência melhor (ex.: primeiro só horário; depois ela diz o
    // nome). Atualiza o mesmo cartão, sem anunciar toda passada como sugestão nova.
    if (existente.status === 'pendente'
      && (existente.motivo !== motivo || Number(existente.forca) !== Number(forca))) {
      db().prepare(`UPDATE uniao_sugerida SET motivo=?,forca=? WHERE id=?`).run(motivo, forca, existente.id)
    }
    return false
  }
  try {
    db().prepare(`INSERT INTO uniao_sugerida(id,a_person_id,b_person_id,motivo,forca,status,criado_em)
      VALUES(?,?,?,?,?,'pendente',?)
      ON CONFLICT(a_person_id,b_person_id) DO UPDATE SET motivo=excluded.motivo, forca=excluded.forca`)
      .run(id12(), aa, bb, motivo, forca, agora())
    return true
  } catch { return false }
}

function sugestaoDoPar(a, b) {
  return db().prepare(`SELECT * FROM uniao_sugerida
    WHERE (a_person_id=? AND b_person_id=?) OR (a_person_id=? AND b_person_id=?)`).get(a, b, b, a) || null
}

// Um único caminho faz a união manual e a automática. Além do alias reversível, limpa os
// resumos antigos dos dois lados: na próxima consolidação a memória será refeita já com o
// histórico das duas redes, sem uma versão anterior sobreviver à mudança de identidade.
function unirSugestao(s, { automatico = false, evidencia = null, primaryId = null } = {}) {
  const antes = [...new Set([
    String(s.a_person_id), String(s.b_person_id),
    pessoaCanonica(s.a_person_id), pessoaCanonica(s.b_person_id),
  ].filter(Boolean))]
  // Na migração automática, a pessoa que recebeu o convite já tem a história anterior e
  // deve continuar canônica. A ordem a/b da sugestão é só alfabética e não pode decidir isso.
  const primario = primaryId || s.a_person_id
  const secundario = primaryId
    ? (mesmaPessoa(primaryId, s.a_person_id) ? s.b_person_id : s.a_person_id)
    : s.b_person_id
  const mergeId = mergePeople(primario, secundario)
  db().prepare(`UPDATE uniao_sugerida SET status='unida', decidido_em=? WHERE id=?`).run(agora(), s.id)
  import('./cidade-pessoa.mjs').then((C) => C.reconciliarAposUniao(primario, secundario)).catch(() => {})
  if (antes.length) {
    db().prepare(`DELETE FROM pessoa_memoria WHERE person_id IN (${antes.map(() => '?').join(',')})`).run(...antes)
  }
  // Quem se moveu é quem tem a conversa MAIS NOVA — não a ordem alfabética do par.
  const aNova = primeiraMensagem(s.a_person_id) > primeiraMensagem(s.b_person_id)
  const antigo = aNova ? s.b_person_id : s.a_person_id
  const novo = aNova ? s.a_person_id : s.b_person_id
  const migrou = migrarIaDeCanal(antigo, novo)
  const canonico = pessoaCanonica(s.a_person_id)
  if (automatico) {
    logEvent({
      type: 'uniao_automatica', personId: canonico, channel: canalDe(novo),
      detail: `${canalDe(antigo)} → ${canalDe(novo)}: ${evidencia || s.motivo}; união reversível em Pessoas`,
    })
  }
  return { ok: true, status: 'unida', mergeId, canonico, iaMigrou: migrou, automatico }
}

// Varre os canais, propõe coincidências e conclui somente convites com prova forte e única.
export function procurarUnioes({ accountKey = 'main' } = {}) {
  // Cobre todo caminho de envio, inclusive manual: se uma saída recente carregou um
  // contato real da sessão e o adaptador não a marcou na hora, cristaliza agora.
  const convitesReconstruidos = reconstruirConvitesDasSaidas(accountKey)
  const todas = conversas(accountKey)
  let propostas = 0, autoVinculados = 0

  // ---- sinal 1: nome completo igual em canais diferentes (2+ palavras)
  const porNome = new Map()
  for (const c of todas) {
    const k = norm(c.nome)
    if (!k || k.split(' ').length < 2 || GENERICOS.has(k)) continue
    if (!porNome.has(k)) porNome.set(k, [])
    porNome.get(k).push(c)
  }
  for (const [nome, grupo] of porNome) {
    if (grupo.length < 2) continue
    for (let i = 0; i < grupo.length; i++) {
      for (let j = i + 1; j < grupo.length; j++) {
        if (grupo[i].canal === grupo[j].canal) continue // dois no mesmo canal não é união de identidade
        if (guardar({ a: grupo[i].id, b: grupo[j].id, motivo: `mesmo nome completo: ${nome}`, forca: 0.8 })) propostas++
      }
    }
  }

  // ---- sinal 2: o @ que alguém mandou numa conversa bate com uma thread do Instagram
  const igPorUser = new Map()
  for (const c of todas) if (c.canal === 'instagram' && c.extra) igPorUser.set(norm(c.extra), c)
  const hints = db().prepare(`SELECT person_id, normalized, raw FROM contact_hint WHERE kind='instagram' AND account_key=?`).all(accountKey)
  for (const h of hints) {
    const alvo = igPorUser.get(norm(String(h.normalized || h.raw || '').replace(/^@/, '')))
    if (!alvo || !h.person_id) continue
    if (guardar({ a: h.person_id, b: alvo.id, motivo: `o @${String(h.normalized || h.raw || '').replace(/^@/, '')} apareceu nessa conversa`, forca: 0.9 })) propostas++
  }

  // ---- sinal 3: número do WhatsApp citado numa conversa de OUTRO canal
  const waPorNumero = new Map()
  for (const c of todas) if (c.canal === 'whatsapp') { const n = String(c.extra || c.id.slice(3)).replace(/\D/g, ''); if (n) waPorNumero.set(n.slice(-8), c) }
  for (const h of db().prepare(`SELECT person_id, normalized, raw FROM contact_hint WHERE kind='phone' AND account_key=?`).all(accountKey)) {
    const dig = String(h.normalized || h.raw || '').replace(/\D/g, '')
    if (dig.length < 8 || !h.person_id) continue
    const alvo = waPorNumero.get(dig.slice(-8))
    if (!alvo || alvo.id === h.person_id) continue
    if (guardar({ a: h.person_id, b: alvo.id, motivo: 'o número dela apareceu nessa conversa', forca: 0.85 })) propostas++
  }

  // ---- sinal 4: EU convidei alguém pra outra rede, e uma conversa nova apareceu lá depois
  //
  // O caso que nenhum outro sinal cobre: quando é quem opera que passa o próprio contato, a
  // pessoa chega no Instagram sem nunca ter dito o @ dela — não há hint, não há número, e o
  // nome dela lá pode ser qualquer coisa. Sem isto, a conversa nasce solta e o histórico do
  // Tinder fica para trás.
  //
  // Nome, apresentação, origem e distância de tempo RANQUEIAM as candidatas. Uma prova forte
  // e isolada conclui; qualquer ambiguidade continua como sugestão. Antes todo mundo que
  // aparecia no mesmo dia recebia os mesmos 0.55, e o Badoo nem registrava convite.
  const JANELA_CONVITE_MS = 14 * 24 * 3600 * 1000
  const MAX_CONVITES_AMBIGUOS = 4
  for (const canal of ['instagram', 'whatsapp']) {
    const convites = convitesDoCanal(canal, { desde: agora() - JANELA_CONVITE_MS })
    if (!convites.length) continue
    // conversas DAQUELE canal que nasceram depois do convite mais antigo e ainda estão soltas
    const maisAntigo = Math.min(...convites.map((c) => c.ts))
    const novas = todas.filter((c) => {
      if (c.canal !== canal) return false
      const inicio = primeiraMensagem(c.id)
      // Um contato salvo, mas sem mensagem, não é uma conversa que "chegou". Infinity
      // satisfazia a comparação abaixo e podia produzir um cartão por coincidência de nome.
      return Number.isFinite(inicio) && inicio >= maisAntigo
    })
    for (const nova of novas) {
      const nasceuEm = primeiraMensagem(nova.id)
      if (canonicalPersonId(nova.id) !== nova.id) continue          // já unida a alguém
      const entradas = db().prepare(`SELECT text,ts FROM message WHERE person_id=? AND channel=?
        AND direction='incoming' ORDER BY ts ASC LIMIT 6`).all(nova.id, canal)
      const falas = entradas.map((m) => m.text || '').join(' ')
      const nomeChegada = norm(nova.nome)
      const textoChegada = norm(falas)
      const reciboIdentidade = canal === 'whatsapp' && String(nova.id).startsWith('wa:')
        ? getReceipt(accountKey, 'wa-identidade', String(nova.id).slice(3)) : null
      const perguntaEnviada = !!reciboIdentidade
        && ['sending', 'sent', 'uncertain', 'no_servidor', 'entregue', 'sem_confirmacao'].includes(reciboIdentidade.state)
      const nomesDeclarados = entradas
        .filter((m) => !perguntaEnviada || Number(m.ts) > Number(reciboIdentidade.ts || 0))
        .map((m) => nomeDeclaradoNaResposta(m.text)).filter(Boolean).map(norm)
      const ranqueados = []
      for (const conv of convites) {
        if (nasceuEm < conv.ts || jaDecidido(conv.person_id, nova.id)) continue
        const origem = lado(conv.person_id, accountKey)
        const nomeOrigem = norm(origem.nome)
        const fonte = conv.source_channel || origem.canal || canalDe(conv.person_id)
        const delta = Math.max(0, nasceuEm - conv.ts)
        let forca = 0.42
        const sinais = []
        let temSinalDeIdentidade = false

        const nomeExato = !!(nomeChegada && nomeOrigem && nomeChegada === nomeOrigem && !GENERICOS.has(nomeOrigem))
        const nomeCompleto = nomeOrigem.split(' ').length >= 2
        if (nomeExato) {
          forca += 0.36; temSinalDeIdentidade = true; sinais.push(`o nome ${origem.nome} bate exatamente`)
        } else {
          const primeiroOrigem = nomeOrigem.split(' ')[0]
          const primeiroChegada = nomeChegada.split(' ')[0]
          if (primeiroOrigem.length >= 3 && primeiroOrigem === primeiroChegada && !GENERICOS.has(primeiroOrigem)) {
            forca += 0.22; temSinalDeIdentidade = true; sinais.push(`o primeiro nome ${origem.nome} bate`)
          }
        }

        const primeiro = nomeOrigem.split(' ')[0]
        const declaradoBate = primeiro.length >= 3 && nomesDeclarados.some((n) => n === nomeOrigem || n.split(' ')[0] === primeiro)
        const fonteNaFala = !!(fonte && new RegExp(`\\b${norm(fonte)}\\b`).test(textoChegada))
        if (primeiro.length >= 3 && textoChegada && new RegExp(`\\b${primeiro}\\b`).test(textoChegada)) {
          forca += 0.20; temSinalDeIdentidade = true; sinais.push(`ela se apresentou como ${origem.nome} na conversa`)
        }
        if (fonteNaFala) {
          // A origem confirma um NOME; sozinha ela não identifica qual das várias pessoas
          // convidadas naquele app chegou. Marcar como identidade aqui criava um cartão
          // para cada convite do Badoo quando alguém dizia apenas "vim do Badoo".
          forca += 0.08; sinais.push(`ela citou ${fonte}`)
        }

        if (delta <= 15 * 60e3) { forca += 0.18; sinais.push('chegou em até 15 minutos') }
        else if (delta <= 2 * 3600e3) { forca += 0.13; sinais.push('chegou em até 2 horas') }
        else if (delta <= 24 * 3600e3) { forca += 0.08; sinais.push('chegou no mesmo dia') }
        else if (delta <= 3 * 24 * 3600e3) { forca += 0.04; sinais.push('chegou poucos dias depois') }

        ranqueados.push({
          conv, origem, fonte, delta, temSinalDeIdentidade, forca: Math.min(0.99, forca), sinais,
          nomeExato, nomeCompleto, declaradoBate, fonteNaFala,
          respondeuPergunta: perguntaEnviada && declaradoBate,
        })
      }
      ranqueados.sort((a, b) => b.forca - a.forca || b.conv.ts - a.conv.ts)
      if (!ranqueados.length) continue

      // Horário sozinho NÃO vira cartão. "Algum convite recente" não é identidade: no
      // corpus real isso criou 25+ pares aleatórios na primeira prova. O horário ranqueia
      // uma evidência de nome/apresentação/rede; quando falta nome, a pergunta coleta essa
      // evidência primeiro.
      const elegiveis = ranqueados.filter((r) => r.temSinalDeIdentidade)
      if (!elegiveis.length) continue

      // Um casamento forte e isolado merece um único cartão. Sem separação suficiente,
      // mostra até quatro alternativas: a UI pergunta, não esconde a ambiguidade.
      const topo = elegiveis[0]
      const segundo = elegiveis[1]
      const isolado = topo.forca >= 0.78 && (!segundo || topo.forca - segundo.forca >= 0.12)
      const autoSeguro = isolado && (
        (topo.declaradoBate && topo.fonteNaFala)             // "sou Carlos do Badoo"
        || topo.respondeuPergunta                            // respondeu à pergunta de identidade
        || (topo.nomeExato && topo.nomeCompleto && topo.delta <= 24 * 3600e3)
        || (topo.nomeExato && elegiveis.length === 1 && topo.delta <= 15 * 60e3)
      )
      const motivoDo = (r) => {
        const minutos = Math.max(0, Math.round((nasceuEm - r.conv.ts) / 60000))
        const origemTxt = r.fonte ? ` no ${r.fonte}` : ''
        return `${r.sinais.length ? r.sinais.join('; ') + '; ' : ''}esta conversa no ${canal} começou ${minutos} min depois de o contato ser passado${origemTxt}`
      }
      if (autoSeguro) {
        const motivo = motivoDo(topo)
        guardar({ a: topo.conv.person_id, b: nova.id, motivo, forca: topo.forca })
        const sugestao = sugestaoDoPar(topo.conv.person_id, nova.id)
        if (sugestao?.status === 'pendente') {
          unirSugestao(sugestao, { automatico: true, evidencia: motivo, primaryId: topo.conv.person_id })
          autoVinculados++
          continue
        }
      }
      const escolhidos = isolado ? [topo]
        : (elegiveis.length <= MAX_CONVITES_AMBIGUOS ? elegiveis : elegiveis.filter((r) => r.forca >= 0.78).slice(0, MAX_CONVITES_AMBIGUOS))
      for (const r of escolhidos) {
        const motivo = motivoDo(r)
        if (guardar({ a: r.conv.person_id, b: nova.id, motivo, forca: r.forca })) propostas++
      }
    }
  }

  return { propostas, autoVinculados, pendentes: listarSugestoes().length, convitesReconstruidos }
}

export function listarSugestoes({ limite = 60 } = {}) {
  const linhas = db().prepare(`SELECT * FROM uniao_sugerida WHERE status='pendente' ORDER BY forca DESC, criado_em DESC LIMIT ?`).all(limite)
  return linhas
    .filter((s) => !mesmaPessoa(s.a_person_id, s.b_person_id))
    // Conversa sem nenhuma mensagem dos dois lados não vale a pena julgar: ou já foi
    // esvaziada por um vínculo antigo, ou não há o que unir.
    .filter((s) => volume(s.a_person_id) + volume(s.b_person_id) > 0)
    .map((s) => ({ ...s, a: lado(s.a_person_id), b: lado(s.b_person_id) }))
}

// Um lado do par, com o que dá pra conferir de bater o olho: foto, nome, canal e o
// identificador que importa naquele canal (telefone no WhatsApp, @ no Instagram,
// cidade no Tinder). Reusa o mesmo cartão do resto do painel.
function lado(id, accountKey = 'main') {
  let card = null
  try { card = personCardRaw(id, accountKey) } catch { /* id órfão */ }
  return {
    id,
    nome: card?.name || nomeDe(id),
    canal: card?.channel || canalDe(id),
    avatar: card?.avatar || null,
    sub: card?.sub || null,
    msgs: volume(id),
  }
}

export function canalDe(id) {
  if (String(id).startsWith('wa:')) return 'whatsapp'
  if (String(id).startsWith('ig:')) return 'instagram'
  if (String(id).startsWith('b:')) return 'badoo'
  if (String(id).startsWith('tg:')) return 'telegram'
  if (String(id).startsWith('mp:')) return 'meupatrocinio'
  return 'tinder'
}

export function nomeDe(id, accountKey = 'main') {
  const d = db()
  if (String(id).startsWith('wa:')) return d.prepare(`SELECT name FROM wa_chat WHERE account_key=? AND jid=?`).get(accountKey, String(id).slice(3))?.name || String(id).slice(3)
  if (String(id).startsWith('ig:')) return d.prepare(`SELECT name FROM ig_chat WHERE account_key=? AND thread_id=?`).get(accountKey, String(id).slice(3))?.name || String(id).slice(3)
  return d.prepare(`SELECT display_name FROM person WHERE person_id=?`).get(id)?.display_name
    || d.prepare(`SELECT name FROM tinder_match WHERE person_id=?`).get(id)?.name || String(id)
}

// A IA SEGUE A PESSOA quando ela troca de rede.
//
// Desligada por padrão, e é regra do projeto que seja: "IA automática nasce desligada por
// pessoa e por canal". Isto aqui é o dono levantando essa trava de propósito — ele decide uma
// vez, no interruptor, e a partir daí a conversa que migra leva a IA junto em vez de morrer
// ligada num canal onde ninguém fala mais.
//
// O que ela NÃO faz: ligar a IA numa pessoa que nunca teve IA. Se estava desligada no canal
// antigo, continua desligada no novo — migrar não é o mesmo que ativar.
export function migrarIaDeCanal(idAntigo, idNovo) {
  if (!getSetting('ia_segue_pessoa', false)) return null
  const de = canalDe(idAntigo), para = canalDe(idNovo)
  if (de === para) return null
  const antes = getAiSetting(idAntigo, de)
  if (!antes || !antes.enabled) return null           // não estava ligada: nada a levar
  // O id usado é o CRU (ig:<thread>, wa:<jid>): é assim que cada autoreply de canal procura
  // a configuração — o canônico não seria encontrado por eles.
  setAiSetting({ personId: idNovo, channel: para, enabled: true, state: 'idle' })
  setAiSetting({ personId: idAntigo, channel: de, enabled: false, state: 'idle' })
  logEvent({ type: 'ia_migrou_canal', personId: idNovo, channel: para, detail: `a pessoa foi do ${de} pro ${para}: IA ligada aqui e desligada lá` })
  return { de, para }
}

// Decisão do dono. 'unir' usa o mesmo mergePeople de sempre (alias, sem mover mensagem),
// então continua desfazível pelo histórico de merges.
export function decidirSugestao(id, acao) {
  const s = db().prepare(`SELECT * FROM uniao_sugerida WHERE id=?`).get(id)
  if (!s) return { ok: false, erro: 'sugestão não encontrada' }
  if (acao === 'unir') {
    return unirSugestao(s)
  }
  db().prepare(`UPDATE uniao_sugerida SET status='rejeitada', decidido_em=? WHERE id=?`).run(agora(), id)
  return { ok: true, status: 'rejeitada' }
}
