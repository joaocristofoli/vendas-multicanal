// Rotas HTTP do módulo Vínculos (F4/F7 do docs/PLANO-IDENTIDADE-VINCULO.md). Mesmo padrão
// do projects/routes.mjs: devolve true se tratou a rota. Superfície:
//   GET  /api/vinculos                    listas da aba (revisar, ativos, frios, chamadas)
//   POST /api/vinculos/resolver           roda o resolvedor agora
//   POST /api/vinculos/ligar              une duas identidades na mão (autofill)
//   POST /api/vinculos/desligar           separa
//   POST /api/vinculos/trocar             aponta pra outra pessoa sem desfazer antes
//   POST /api/vinculos/revisao            resolve um ambíguo (escolhe uma das opções)
//   POST /api/vinculos/auto               interruptores do chamar automático
//   POST /api/vinculos/chamar             chama agora (manual)
//   POST /api/veredito                    marca um envio como certo/errado
import * as DB from '../core/db.mjs'
import * as S from '../projects/store.mjs'
import { CANAIS, chamarLigado, setChamarLigado, redesAutorizadas, redeAutorizada, setRedeAutorizada,
  pessoasAutorizadas, autorizarPessoa, bloqueioParaChamar, gerarPrimeiraMensagem, autorizaSozinho, setAutorizaSozinho } from './chamar.mjs'
import { conferirVinculo } from './verificar.mjs'
import { chamarUma, registrarVeredito } from './chamar-tick.mjs'
import { criarContextoChamar, pessoaDaChamadaEmOutraRede, metricasChamarPorPessoa } from './chamar-metricas.mjs'
import { vinculoDaPessoa, CATALOGO as CATALOGO_VINCULO } from '../self/vinculos.mjs'
import { prettyPhone, phoneCandidates } from '../wa/phone.mjs'
import { resolveLidForPn } from '../wa/identity.mjs'

const nomeCanal = { whatsapp: 'WhatsApp', instagram: 'Instagram', tinder: 'Tinder', badoo: 'Badoo' }

// Cartão de um vínculo pra UI: quem é, onde mora, em que estado e POR QUE existe.
function safeCard(id, accountKey) {
  try { return S.personCardRaw(id, accountKey) } catch { return null }
}

// De onde a pessoa veio — o OUTRO lado do elo. Um vínculo liga a conversa do WhatsApp a
// alguém que nasceu em algum app, e é esse par (origem -> WhatsApp) que a tela desenha com
// as duas bolinhas. Pergunta ao banco onde ela realmente fala; o prefixo do id só desempata
// quando ela ainda não tem mensagem em canal nenhum.
function canalDeOrigem(personId, canalDoVinculo) {
  const canais = DB.db().prepare(`SELECT DISTINCT channel FROM message WHERE person_id=?`).all(personId).map((r) => r.channel)
  const outro = canais.find((c) => c !== canalDoVinculo)
  if (outro) return outro
  const id = String(personId || '')
  if (id.startsWith('ig:')) return 'instagram'
  if (id.startsWith('b:')) return 'badoo'
  if (id.startsWith('wa:')) return 'whatsapp'
  return 'tinder'
}

// Todas as redes onde essa pessoa existe, cada uma com a cara de lá — é o que a linha
// fechada da aba desenha (duas ou mais fotos seladas com o ícone da rede), pra a organização
// aparecer sem abrir nada. Segue o ALIAS de propósito: quando o vínculo é a conversa apontando
// pra si mesma, a outra ponta da pessoa mora num id irmão, e sem seguir o alias quatro
// pessoas apareciam com uma cara só, como se não tivessem vínculo nenhum.
function redesDaPessoa(ACCOUNT, personId, cardPessoa, cardAlvo) {
  const ids = new Set([personId])
  for (const g of DB.db().prepare(`SELECT alias_person_id a, canonical_person_id c FROM person_alias
      WHERE alias_person_id=? OR canonical_person_id=?`).all(personId, personId)) { ids.add(g.a); ids.add(g.c) }
  const foto = new Map()
  for (const id of ids) {
    const card = safeCard(id, ACCOUNT)
    for (const r of DB.db().prepare(`SELECT DISTINCT channel FROM message WHERE person_id=?`).all(id)) {
      const atual = foto.get(r.channel)
      if (!atual) foto.set(r.channel, (r.channel === 'whatsapp' ? cardAlvo?.avatar : null) || card?.avatar || null)
    }
  }
  // o vínculo é sempre com uma conversa do WhatsApp: ela entra mesmo sem mensagem nenhuma
  if (!foto.has('whatsapp')) foto.set('whatsapp', cardAlvo?.avatar || null)
  if (foto.size === 1 && cardPessoa?.avatar) {
    // sobrou só o WhatsApp: mostra a pessoa do lado de lá pelo canal de onde ela veio
    const origem = canalDeOrigem(personId, 'whatsapp')
    if (origem !== 'whatsapp') foto.set(origem, cardPessoa.avatar)
  }
  return ['tinder', 'badoo', 'instagram', 'whatsapp']
    .filter((c) => foto.has(c))
    .map((c) => ({ canal: c, nome: nomeCanal[c] || c, foto: foto.get(c) || null }))
}

// Uma opção de revisão vira escolha só quando dá pra decidir olhando: o número como se lê,
// o nome de quem atende ali, e se já existe conversa. `jid` cru não decide nada.
function opcaoDeRevisao(ACCOUNT, jid) {
  const chat = DB.getWaChat(ACCOUNT, jid)
  const card = safeCard('wa:' + jid, ACCOUNT)
  const numero = chat?.pn ? prettyPhone(chat.pn) : (String(jid).endsWith('@lid') ? null : prettyPhone(jid))
  return {
    jid,
    titulo: numero || chat?.name || card?.name || 'conversa do WhatsApp',
    nome: chat?.name || null,
    foto: card?.avatar || null,
    mensagens: DB.countChannelMessages('wa:' + jid, 'whatsapp'),
  }
}

function cartaoVinculo(ACCOUNT, row) {
  const hint = row.evidence_hint_id ? DB.getContactHint(row.evidence_hint_id) : null
  const chat = row.channel === 'whatsapp' ? DB.getWaChat(ACCOUNT, row.channel_id) : null
  const msgs = DB.countChannelMessages(row.person_id, row.channel)
  // Foto dos dois lados: a da pessoa (Tinder/Instagram) e a da conversa (WhatsApp). É o
  // que deixa o vínculo conferível de bater o olho, sem abrir nada.
  const cardPessoa = safeCard(row.person_id, ACCOUNT)
  const cardAlvo = row.channel === 'whatsapp' ? safeCard('wa:' + row.channel_id, ACCOUNT) : null
  return {
    foto: cardPessoa?.avatar || null,
    sub: cardPessoa?.sub || null,
    fotoAlvo: cardAlvo?.avatar || null,
    subAlvo: cardAlvo?.sub || null,
    personId: row.person_id,
    // o nome da conversa vem primeiro: o display_name da pessoa às vezes guardou o
    // identificador cru do WhatsApp (o adotar antigo salvava os dígitos do @lid como nome)
    nome: chat?.name || DB.personDisplayName(row.person_id) || 'pessoa',
    origem: canalDeOrigem(row.person_id, row.channel),
    redes: redesDaPessoa(ACCOUNT, row.person_id, cardPessoa, cardAlvo),
    canal: row.channel,
    canalNome: nomeCanal[row.channel] || row.channel,
    alvo: row.channel_id,
    alvoBonito: row.channel === 'whatsapp' ? (chat?.pn ? prettyPhone(chat.pn) : (row.channel_id.endsWith('@lid') ? (chat?.name || 'conversa do WhatsApp') : prettyPhone(row.channel_id))) : row.channel_id,
    estado: row.link_state || 'indefinido',
    metodo: row.link_method,
    manual: row.link_method === 'manual-ui',   // só o que quem opera ligou/trocou na mão
    desde: row.linked_at || null,
    confirmadoEm: row.confirmed_at || null,
    mensagens: msgs,
    prova: hint ? { frase: hint.quote, valor: hint.normalized, canal: hint.source_channel } : null,
    autorizadaPraChamar: pessoasAutorizadas().includes(row.person_id),
    jaChamada: !!DB.getReceipt(ACCOUNT, CANAIS[row.channel]?.receipt || 'x', row.channel_id),
    // "Chamar primeiro" é PRIMEIRA mensagem. Com conversa em andamento não faz sentido
    // nenhum oferecer isso — estava aparecendo em conversa de 6.983 mensagens.
    podeChamar: msgs === 0 && !DB.getReceipt(ACCOUNT, CANAIS[row.channel]?.receipt || 'x', row.channel_id),
  }
}

export async function handleVinculosApi(ctx) {
  const { p, method, res, url, json, body, broadcast, account: ACCOUNT, resolverAgora, enviarWhatsapp, enviarInstagram, buscarFoto } = ctx
  const seg = p.split('/').filter(Boolean) // ['api','vinculos', ...]
  if (!['vinculos', 'veredito', 'pessoas'].includes(seg[1])) return false

  // ---------------- a central de identidades: TODA pessoa que existe ----------------
  // Uma linha por pessoa CANÔNICA (os aliases já somados), com as redes onde ela vive, o
  // peso da conversa e quando foi a última. A memória que a IA guarda não vem aqui de
  // propósito: ela tem rota própria (/api/self/memoria) e a tela junta as duas — assim este
  // módulo não passa a depender do módulo do "eu" só pra desenhar uma lista.
  if (seg[1] === 'pessoas' && !seg[2] && method === 'GET') {
    const canonicoDe = new Map()
    for (const a of DB.db().prepare(`SELECT alias_person_id a, canonical_person_id c FROM person_alias`).all()) canonicoDe.set(a.a, a.c)
    const raiz = (id) => {
      let cur = id
      const seen = new Set()
      while (canonicoDe.has(cur) && !seen.has(cur)) {
        seen.add(cur)
        cur = canonicoDe.get(cur)
      }
      return cur
    }
    const grupos = new Map()
    for (const r of DB.db().prepare(`SELECT person_id, channel, COUNT(*) n, MAX(ts) ultima
        FROM message GROUP BY person_id, channel`).all()) {
      const id = raiz(r.person_id)
      if (!grupos.has(id)) grupos.set(id, { ids: new Set(), canais: new Map(), mensagens: 0, ultima: 0 })
      const g = grupos.get(id)
      g.ids.add(r.person_id)
      const atual = g.canais.get(r.channel) || { n: 0, ultima: 0, id: r.person_id }
      atual.n += r.n
      atual.ultima = Math.max(atual.ultima, r.ultima || 0)
      g.canais.set(r.channel, atual)
      g.mensagens += r.n
      g.ultima = Math.max(g.ultima, r.ultima || 0)
    }
    const ordemCanais = ['tinder', 'badoo', 'instagram', 'whatsapp']
    const contextoChamar = criarContextoChamar(ACCOUNT)
    const autorizadasChamar = new Set(pessoasAutorizadas().map((id) => raiz(id)))
    const autorizaTodosLigado = autorizaSozinho()
    const statsChamar = new Map(metricasChamarPorPessoa(ACCOUNT, { contexto: contextoChamar }).map((m) => [raiz(m.personId), m]))
    const pessoas = [...grupos.entries()].map(([id, g]) => {
      const cartao = (() => { try { return S.personCard(id, ACCOUNT) } catch { return null } })()
      const redes = ordemCanais.filter((c) => g.canais.has(c)).map((c) => {
        const dono = g.canais.get(c).id
        const card = safeCard(dono, ACCOUNT)
        // "no WhatsApp" é um recado do cartão do Tinder, não um identificador — mostrado
        // como tal, a ponta do Tinder dizia "no WhatsApp" na cara do dono.
        const sub = card?.sub && card.sub !== 'no WhatsApp' ? card.sub : null
        return { canal: c, nome: nomeCanal[c] || c, foto: card?.avatar || null, identificador: sub, mensagens: g.canais.get(c).n }
      })
      return {
        personId: id,
        nome: cartao?.name || DB.personDisplayName(id) || 'pessoa',
        foto: cartao?.avatar || redes.find((r) => r.foto)?.foto || null,
        ids: [...g.ids],
        redes,
        canais: redes.map((r) => r.canal),
        unificada: g.ids.size > 1,
        mensagens: g.mensagens,
        ultima: g.ultima || null,
        // o interruptor da IA é por pessoa E por canal: a tela mostra onde está ligado
        iaLigada: redes.filter((r) => DB.getAiSetting(id, r.canal)?.enabled).map((r) => r.canal),
        // Vínculo é da PESSOA (uma linha por pessoa em pessoa_vinculo, gravada no id
        // canônico e lida por todos os ids dela). Vem na lista pra dar pra ver quem é quem
        // sem abrir 1.029 fichas.
        vinculo: (() => {
          const v = (() => { try { return vinculoDaPessoa(id) } catch { return null } })()
          if (!v) return null
          const item = CATALOGO_VINCULO.find((c) => c.valor === v.vinculo)
          return { valor: v.vinculo, label: item?.label || v.vinculo, grupo: item?.grupo || null, padrao: v.origem === 'padrao-tinder' }
        })(),
        chamar: (() => {
          const explicita = autorizadasChamar.has(id)
          const herdada = !explicita && autorizaTodosLigado && redes.some((r) => r.canal === 'tinder')
          const m = statsChamar.get(id)
          return {
            ligada: explicita || herdada,
            explicita,
            herdada,
            origem: explicita ? 'manual' : herdada ? 'todos' : 'desligada',
            tentativas: m?.tentativas || 0,
            avaliadas: m?.avaliadas || 0,
            certas: m?.certas || 0,
            erradas: m?.erradas || 0,
            pendentes: m?.pendentes || 0,
            pctCerto: m?.pctCerto ?? null,
            pctErrado: m?.pctErrado ?? null,
            porCanal: m?.porCanal || { whatsapp: 0, instagram: 0 },
            ultimaTentativa: m?.ultimaTentativa || null,
            ultimoEstado: m?.ultimoEstado || null,
            ultimoVeredito: m?.ultimoVeredito || null,
            ultimoMotivo: m?.ultimoMotivo || null,
          }
        })(),
      }
    })
    pessoas.sort((a, b) => (b.ultima || 0) - (a.ultima || 0))
    // Resumo sobre o conjunto INTEIRO, calculado antes de filtrar: é o que impede a tela de
    // dizer "16 pessoas" quando existem 1029 e o filtro é que está estreito.
    const resumo = {
      total: pessoas.length, unificadas: 0, comIa: 0, porCanal: {},
      chamar: { ligadas: 0, manuais: 0, automaticas: 0, comHistorico: 0, tentativas: 0, avaliadas: 0, certas: 0, erradas: 0, pendentes: 0 },
    }
    for (const x of pessoas) {
      if (x.unificada) resumo.unificadas++
      if (x.iaLigada.length) resumo.comIa++
      for (const c of x.canais) resumo.porCanal[c] = (resumo.porCanal[c] || 0) + 1
      if (x.chamar?.ligada) {
        resumo.chamar.ligadas++
        if (x.chamar.origem === 'manual') resumo.chamar.manuais++
        else if (x.chamar.origem === 'todos') resumo.chamar.automaticas++
        if (x.chamar.tentativas) resumo.chamar.comHistorico++
        resumo.chamar.tentativas += x.chamar.tentativas || 0
        resumo.chamar.avaliadas += x.chamar.avaliadas || 0
        resumo.chamar.certas += x.chamar.certas || 0
        resumo.chamar.erradas += x.chamar.erradas || 0
        resumo.chamar.pendentes += x.chamar.pendentes || 0
      }
    }
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
    const canal = url.searchParams.get('canal') || ''
    const filtro = url.searchParams.get('filtro') || ''
    const limite = Math.min(Number(url.searchParams.get('limite')) || 60, 400)
    let lista = pessoas
    if (canal) lista = lista.filter((x) => x.canais.includes(canal))
    if (filtro === 'unificadas') lista = lista.filter((x) => x.unificada)
    if (filtro === 'ia') lista = lista.filter((x) => x.iaLigada.length)
    if (filtro === 'chamar') {
      lista = lista.filter((x) => x.chamar?.ligada)
      lista.sort((a, b) => (b.chamar?.tentativas || 0) - (a.chamar?.tentativas || 0)
        || (b.chamar?.ultimaTentativa || 0) - (a.chamar?.ultimaTentativa || 0)
        || (b.ultima || 0) - (a.ultima || 0))
    }
    if (q) {
      lista = lista.filter((x) => (x.nome || '').toLowerCase().includes(q)
        || x.redes.some((r) => String(r.identificador || '').toLowerCase().includes(q))
        || String(x.personId).toLowerCase().includes(q))
    }
    return json(res, 200, { resumo, encontradas: lista.length, pessoas: lista.slice(0, limite) }), true
  }

  // ---------------- veredito de envio ----------------
  if (seg[1] === 'veredito' && method === 'POST') {
    const b = await body()
    if (!b.verdict || !['certo', 'errado'].includes(b.verdict)) return json(res, 400, { error: 'veredito' }), true
    const r = registrarVeredito({
      accountKey: ACCOUNT, canal: b.canal || 'whatsapp', alvo: b.alvo, messageId: b.messageId,
      personId: b.personId, verdict: b.verdict, reason: b.reason || null, note: b.note || null,
    })
    broadcast({ t: 'state' })
    return json(res, 200, { ok: true, ...r }), true
  }

  // ---------------- listas da aba ----------------
  if (seg[1] === 'vinculos' && !seg[2] && method === 'GET') {
    // Vínculo é ligação entre DUAS identidades. A conversa apontando pra ela mesma
    // ('wa:<jid>' -> '<jid>') não é vínculo nenhum: é o registro que nasce quando você liga
    // a IA numa conversa. Elas apareciam aqui marcadas como "você definiu" — coisa que o
    // o dono nunca definiu (correção dele, 24/07/2026). Ficam de fora, a menos que a pessoa
    // esteja unificada com outro canal (aí é vínculo de verdade).
    const todos = DB.db().prepare(`SELECT * FROM identity WHERE account_key=? AND channel='whatsapp' ORDER BY linked_at DESC`).all(ACCOUNT)
      .filter((r) => {
        if (r.person_id !== 'wa:' + r.channel_id) return true
        return !!DB.db().prepare(`SELECT 1 FROM person_alias WHERE alias_person_id=? OR canonical_person_id=? LIMIT 1`).get(r.person_id, r.person_id)
      })
    const cartoes = todos.map((r) => cartaoVinculo(ACCOUNT, r))
    // Foto que falta é pedida agora, sem esperar: quando chega, o WebSocket manda 'state'
    // e a aba se redesenha com a cara da pessoa. Mesmo padrão da lista do WhatsApp.
    if (typeof buscarFoto === 'function') {
      for (const c of cartoes) if (!c.fotoAlvo && c.canal === 'whatsapp') buscarFoto(c.alvo)
    }
    // "Frio" na UI é honesto: vínculo confirmado pelo servidor que nunca virou conversa,
    // independente de idade (o estado 'frio' do banco só chega depois de 14 dias).
    const frios = cartoes.filter((c) => c.mensagens === 0 && c.estado !== 'rejeitado')
    const ativos = cartoes.filter((c) => c.mensagens > 0)
    // A revisão é uma PERGUNTA, e a tela só consegue desenhá-la se o servidor mandar os dois
    // lados prontos. Antes daqui saía o texto do motivo e uma lista de opções que era extraída
    // do próprio motivo procurando a palavra "opções:" — que ninguém nunca escreveu. A lista
    // vinha sempre vazia, sobrava só o botão de recusar, e a pergunta ficava sem alternativa
    // nenhuma na tela (defeito apontado pelo dono, 26/07/2026).
    const revisoes = DB.pendingLinkReviews(ACCOUNT).map((r) => {
      const cardPessoa = safeCard(r.candidate_person_id, ACCOUNT)
      let jids = []
      try { jids = JSON.parse(r.options_json || '[]') } catch { jids = [] }
      if (!jids.length && r.wa_jid) jids = [r.wa_jid]     // revisões antigas, de antes da coluna
      const opcoes = jids.map((j) => opcaoDeRevisao(ACCOUNT, j))
      return {
        id: r.id,
        pessoa: r.candidate_name || DB.personDisplayName(r.candidate_person_id), personId: r.candidate_person_id,
        foto: cardPessoa?.avatar || null, sub: cardPessoa?.sub || null,
        origem: canalDeOrigem(r.candidate_person_id, 'whatsapp'),
        // o motivo cru some da tela: vira uma frase que explica a dúvida
        porque: String(r.reason || '').startsWith('jid já vinculado')
          ? 'esse WhatsApp já está ligado a outra pessoa'
          : String(r.reason || '').startsWith('ela escreveu')
            ? String(r.reason).split(' | ')[0]        // já é uma frase pronta (número sem DDD)
            : jids.length > 1 ? 'o número existe em mais de uma conta do WhatsApp' : 'não consegui confirmar sozinho',
        motivo: r.reason, frase: r.wa_first_text, criadoEm: r.created_at, opcoes,
      }
    })
    const hintsPendentes = DB.contactHints({ status: 'novo', limit: 60 }).map((h) => ({
      id: h.id, personId: h.person_id, nome: DB.personDisplayName(h.person_id) || h.person_id,
      foto: safeCard(h.person_id, ACCOUNT)?.avatar || null,
      sub: safeCard(h.person_id, ACCOUNT)?.sub || null,
      tipo: h.kind, valor: h.normalized, frase: h.quote, confianca: h.confidence, canal: h.source_channel,
    }))
    const contextoChamar = criarContextoChamar(ACCOUNT)
    const chamadas = DB.db().prepare(`SELECT * FROM send_receipt WHERE account_key=? AND channel IN ('wa-opener','ig-opener')
      ORDER BY ts DESC LIMIT 100`).all(ACCOUNT).map((r) => {
      const canal = r.channel === 'wa-opener' ? 'whatsapp' : 'instagram'
      const v = DB.db().prepare(`SELECT verdict, reason, person_id FROM send_verdict WHERE account_key=? AND channel=? AND target_id=? ORDER BY created_at DESC LIMIT 1`).get(ACCOUNT, canal, r.target_id)
      const personId = pessoaDaChamadaEmOutraRede(ACCOUNT, canal, r.target_id, { preferido: v?.person_id || null, contexto: contextoChamar })
      return { canal, canalNome: nomeCanal[canal], alvo: r.target_id, estado: r.state, quando: r.ts, personId, veredito: v?.verdict || null, motivo: v?.reason || null }
    })
    return json(res, 200, {
      // um interruptor (chamar), a lista de redes autorizadas, e quem (todos ou só marcados)
      chamar: chamarLigado(),
      redes: redesAutorizadas(),
      autorizaTodos: autorizaSozinho(),
      contagem: {
        revisar: revisoes.length + hintsPendentes.filter((h) => h.confianca < 0.9).length,
        ativos: ativos.length, frios: frios.length, chamadas: chamadas.length,
        hints: hintsPendentes.length,
      },
      revisoes, hintsPendentes, ativos, frios, chamadas,
      negados: DB.contatosNegados(),
      vereditos: DB.verdictCounts(ACCOUNT),
    }), true
  }

  // ---------------- contatos que vieram do TINDER (a aba Aprovações do WhatsApp) ----------------
  // Só o que nasceu numa conversa do Tinder. Número que apareceu numa conversa de WhatsApp
  // ou Instagram em outro contexto (fornecedor, cliente, anúncio) NÃO entra aqui — encher
  // essa lista com isso escondeu o que importa (correção do dono, 24/07/2026).
  if (seg[1] === 'vinculos' && seg[2] === 'tinder' && method === 'GET') {
    const pendentes = DB.db().prepare(`SELECT tm.person_id, tm.name, tm.match_id, tm.last_ts
      FROM tinder_match tm
      WHERE tm.account_key=? AND tm.shared_contact=1
        AND NOT EXISTS (SELECT 1 FROM identity i WHERE i.person_id=tm.person_id AND i.channel='whatsapp')
      ORDER BY tm.last_ts DESC`).all(ACCOUNT)
    const comContexto = pendentes.map((p) => {
      const hints = DB.contactHints({ personId: p.person_id, limit: 10 })
      const tel = hints.find((h) => h.kind === 'phone' || h.kind === 'wa_link')
      const insta = hints.find((h) => h.kind === 'instagram')
      const unificada = DB.db().prepare(`SELECT 1 FROM person_alias WHERE alias_person_id=? OR canonical_person_id=? LIMIT 1`).get(p.person_id, p.person_id)
      let situacao, oQueFazer
      if (tel && tel.status === 'ignorado') { situacao = `o número ${prettyPhone(tel.normalized)} não está no WhatsApp`; oQueFazer = 'confira o número com ela, ou ligue na mão' }
      else if (tel && tel.status === 'novo') { situacao = `número ${prettyPhone(tel.normalized)} colhido, ainda vou confirmar`; oQueFazer = null }
      else if (insta && unificada) { situacao = `passou o Instagram @${insta.normalized} — já unificado`; oQueFazer = null }
      else if (insta) { situacao = `passou o Instagram @${insta.normalized}, e ainda não existe conversa lá`; oQueFazer = 'dá pra chamar no Instagram pelo @' }
      else { situacao = 'ela compartilhou algo, mas não consegui ler um número nem um @'; oQueFazer = 'abra a conversa do Tinder e veja' }
      return {
        personId: p.person_id, nome: p.name, quando: p.last_ts,
        tipo: tel ? 'telefone' : insta ? 'instagram' : 'indefinido',
        valor: tel ? prettyPhone(tel.normalized) : insta ? '@' + insta.normalized : null,
        alvoInstagram: insta ? insta.normalized : null,
        frase: (tel || insta)?.quote || null,
        situacao, oQueFazer,
      }
    })
    const fechados = DB.db().prepare(`SELECT tm.name, i.channel_id, i.link_state,
        (SELECT COUNT(*) FROM message m WHERE m.person_id=i.person_id AND m.channel='whatsapp') AS msgs
      FROM identity i JOIN tinder_match tm ON tm.person_id=i.person_id AND tm.account_key=i.account_key
      WHERE i.account_key=? AND i.channel='whatsapp' ORDER BY msgs DESC`).all(ACCOUNT)
      .map((f) => ({ nome: f.name, mensagens: f.msgs, estado: f.link_state }))
    return json(res, 200, { pendentes: comContexto, fechados }), true
  }

  // ---------------- canais de UMA pessoa (a identidade canônica dela) ----------------
  // Responde "quem é essa pessoa em cada rede": o que está unificado hoje e o que dá pra
  // unificar. É o que a conversa abre quando o dono clica em "Mesma pessoa".
  if (seg[1] === 'vinculos' && seg[2] === 'pessoa' && method === 'GET') {
    const bruto = url.searchParams.get('personId')
    if (!bruto) return json(res, 400, { error: 'personId' }), true
    const canonico = S.canonicalPersonId(bruto)
    const aliases = S.personAliases(canonico)
    // Um canal por linha, de verdade. Duas fontes se somam: os ALIASES (união manual, ex.
    // Instagram) e as IDENTITIES da própria pessoa (é assim que Tinder e WhatsApp moram na
    // mesma pessoa). Contar só alias dizia "essa conversa está sozinha" pra quem já tinha
    // Tinder + WhatsApp unificados — mentira na cara do dono (25/07/2026).
    // TODOS os vínculos, não um por canal. Uma pessoa pode ter dois WhatsApp (número
    // antigo + atual, ou dois chips) e dois Instagram — antes o segundo sumia da tela, o
    // que fazia parecer que não existia (regra do sistema, 25/07/2026).
    const canais = []
    const vistos = new Set()
    const poe = (item) => {
      const chave = `${item.channel}:${item.alvo || item.personId}`
      if (vistos.has(chave)) return
      vistos.add(chave)
      canais.push(item)
    }
    for (const id of aliases) {
      const c = S.personCardRaw(id, ACCOUNT)
      poe({
        channel: c.channel, name: c.name, sub: c.sub, avatar: c.avatar,
        mensagens: DB.countChannelMessages(id, c.channel), personId: id,
        alvo: id.includes(':') ? id.split(':').slice(1).join(':') : null,
        // conversa que veio por união manual: sai desfazendo o alias
        removivel: id !== canonico, tipo: 'alias',
      })
      // vínculos por identity dessa mesma pessoa (Tinder -> WhatsApp, e os extras)
      for (const row of DB.db().prepare(`SELECT channel, channel_id, is_primary, link_method FROM identity WHERE account_key=? AND person_id=? ORDER BY is_primary DESC`).all(ACCOUNT, id)) {
        const chat = row.channel === 'whatsapp' ? DB.getWaChat(ACCOUNT, row.channel_id) : DB.getIgChat(ACCOUNT, row.channel_id)
        const tel = row.channel === 'whatsapp' ? (chat?.pn ? prettyPhone(chat.pn) : (row.channel_id.endsWith('@lid') ? null : prettyPhone(row.channel_id))) : (chat?.username ? '@' + chat.username : null)
        poe({
          channel: row.channel, name: chat?.name || tel || 'conversa', sub: tel,
          avatar: chat?.avatar || null, mensagens: DB.countChannelMessages(id, row.channel),
          personId: id, alvo: row.channel_id, principal: !!row.is_primary,
          manual: row.link_method === 'manual-ui', removivel: true, tipo: 'identity',
        })
      }
    }
    // "principal" só faz sentido quando há mais de um do mesmo canal
    const porCanal = {}
    for (const c of canais) porCanal[c.channel] = (porCanal[c.channel] || 0) + 1
    for (const c of canais) c.escolhivel = c.tipo === 'identity' && porCanal[c.channel] > 1
    const merge = S.mergeForCanonical ? S.mergeForCanonical(canonico) : null
    return json(res, 200, {
      canonico, unificada: canais.length > 1, mergeId: merge ? merge.id : null,
      cartao: S.personCard(canonico, ACCOUNT), canais,
    }), true
  }

  if (seg[1] !== 'vinculos' || method !== 'POST') return false
  const b = await body()

  // ---------------- rodar o resolvedor agora ----------------
  if (seg[2] === 'resolver') {
    const r = typeof resolverAgora === 'function' ? await resolverAgora({ limite: Number(b.limite) || 40, hintId: b.hintId || null }) : null
    broadcast({ t: 'state' })
    return json(res, 200, { ok: true, resultado: r }), true
  }

  // ---------------- ligar duas identidades na mão (autofill) ----------------
  // Aceita {primaryId, secondaryId} (une pessoas, é o caso do Instagram) OU
  // {personId, canal, alvo} (aponta um canal direto pra uma pessoa).
  if (seg[2] === 'ligar') {
    if (b.primaryId && b.secondaryId) {
      const mergeId = S.mergePeople(b.primaryId, b.secondaryId)
      DB.logEvent({ type: 'vinculo_manual', personId: b.primaryId, detail: 'unido a ' + b.secondaryId })
      broadcast({ t: 'state' })
      return json(res, 200, { ok: !!mergeId, mergeId }), true
    }
    if (b.personId && b.canal && b.alvo) {
      const dono = DB.personByIdentity(ACCOUNT, b.canal, b.alvo)
      if (dono && dono !== b.personId && !b.forcar) return json(res, 409, { error: 'ocupado', dono, donoNome: DB.personDisplayName(dono) }), true
      DB.linkIdentity({ accountKey: ACCOUNT, channel: b.canal, channelId: b.alvo, personId: b.personId, method: 'manual-ui' })
    if (DB.getSetting('transferir_ia_no_vinculo', true)) { try { DB.transferirIaEntreCanais({ personId: b.personId, de: 'tinder', para: b.canal }) } catch { /* vínculo não pode cair por isso */ } }
      if (DB.getSetting('transferir_ia_no_vinculo', true)) { try { DB.transferirIaEntreCanais({ personId: b.personId, de: 'tinder', para: b.canal }) } catch { /* vínculo não pode cair por isso */ } }
      DB.setIdentityState({ accountKey: ACCOUNT, channel: b.canal, channelId: b.alvo, state: 'confirmado_conversa' })
      DB.logEvent({ type: 'vinculo_manual', personId: b.personId, channel: b.canal, detail: b.alvo })
      broadcast({ t: 'state' })
      return json(res, 200, { ok: true }), true
    }
    return json(res, 400, { error: 'parâmetros' }), true
  }

  // ---------------- desligar ----------------
  // qual vínculo daquele canal recebe as mensagens (os outros seguem vinculados)
  if (seg[2] === 'principal') {
    if (!b.personId || !b.canal || !b.alvo) return json(res, 400, { error: 'parâmetros' }), true
    DB.setPrimaryIdentity(ACCOUNT, b.personId, b.canal, b.alvo)
    DB.logEvent({ type: 'vinculo_principal', personId: b.personId, channel: b.canal, detail: b.alvo })
    broadcast({ t: 'state' })
    return json(res, 200, { ok: true }), true
  }

  if (seg[2] === 'desligar') {
    if (b.mergeId) { const ok = S.undoMerge(b.mergeId); broadcast({ t: 'state' }); return json(res, 200, { ok }), true }
    // X numa conversa unida logicamente (Instagram, união manual): desfaz só aquele alias,
    // sem tocar nos outros canais da pessoa.
    if (b.aliasId) {
      const ok = S.removerAlias(b.aliasId)
      DB.logEvent({ type: 'vinculo_desfeito', personId: b.aliasId, detail: 'alias removido pela tela de identidade' })
      broadcast({ t: 'state' })
      return json(res, 200, { ok }), true
    }
    if (b.canal && b.alvo) {
      const row = DB.desvincular({ accountKey: ACCOUNT, channel: b.canal, channelId: b.alvo })
      // devolve as mensagens pra conversa crua daquele canal
      if (row && b.canal === 'whatsapp') DB.db().prepare(`UPDATE message SET person_id=? WHERE person_id=? AND channel='whatsapp'`).run('wa:' + b.alvo, row.person_id)
      DB.logEvent({ type: 'vinculo_desfeito', personId: row?.person_id, channel: b.canal, detail: b.alvo })
      broadcast({ t: 'state' })
      return json(res, 200, { ok: !!row }), true
    }
    return json(res, 400, { error: 'parâmetros' }), true
  }

  // ---------------- trocar de pessoa ----------------
  if (seg[2] === 'trocar') {
    if (!b.canal || !b.alvo || !b.personId) return json(res, 400, { error: 'parâmetros' }), true
    DB.desvincular({ accountKey: ACCOUNT, channel: b.canal, channelId: b.alvo })
    DB.linkIdentity({ accountKey: ACCOUNT, channel: b.canal, channelId: b.alvo, personId: b.personId, method: 'manual-ui' })
    DB.setIdentityState({ accountKey: ACCOUNT, channel: b.canal, channelId: b.alvo, state: 'confirmado_conversa' })
    DB.logEvent({ type: 'vinculo_trocado', personId: b.personId, channel: b.canal, detail: b.alvo })
    broadcast({ t: 'state' })
    return json(res, 200, { ok: true }), true
  }

  // ---------------- resolver um ambíguo ----------------
  if (seg[2] === 'revisao') {
    const rev = DB.db().prepare(`SELECT * FROM wa_link_review WHERE id=?`).get(b.id)
    if (!rev) return json(res, 404, { error: 'revisão' }), true
    if (b.acao === 'confirmar' && b.alvo) {
      DB.linkIdentity({ accountKey: ACCOUNT, channel: 'whatsapp', channelId: b.alvo, personId: rev.candidate_person_id, method: 'manual-ui' })
      if (DB.getSetting('transferir_ia_no_vinculo', true)) { try { DB.transferirIaEntreCanais({ personId: rev.candidate_person_id, de: 'tinder', para: 'whatsapp' }) } catch { /* vínculo não pode cair por isso */ } }
      DB.setIdentityState({ accountKey: ACCOUNT, channel: 'whatsapp', channelId: b.alvo, state: 'confirmado_servidor' })
    }
    DB.resolveLinkReview(b.id, b.acao === 'confirmar' ? 'confirmed' : 'rejected')
    broadcast({ t: 'state' })
    return json(res, 200, { ok: true }), true
  }

  // ---------------- interruptores do chamar automático ----------------
  if (seg[2] === 'auto') {
    // {chamar:bool}          liga/desliga o "chamar em outras redes" (o interruptor único)
    // {rede:'instagram', ligado:bool}  autoriza ou tira uma rede da lista
    // {todos:bool}           chamar todo mundo que vier do Tinder, sem marcar pessoa a pessoa
    // {personId, ligado}     autoriza UMA pessoa (vale pra qualquer rede que ela passar)
    if (b.chamar != null) { setChamarLigado(!!b.chamar); DB.logEvent({ type: 'chamar_auto', detail: b.chamar ? 'ligado' : 'desligado' }); broadcast({ t: 'state' }); return json(res, 200, { ok: true, chamar: chamarLigado() }), true }
    if (b.rede) { const r = setRedeAutorizada(b.rede, !!b.ligado); if (!r) return json(res, 400, { error: 'rede' }), true; DB.logEvent({ type: 'chamar_rede', channel: b.rede, detail: b.ligado ? 'autorizada' : 'removida' }); broadcast({ t: 'state' }); return json(res, 200, { ok: true, redes: redesAutorizadas() }), true }
    if (b.todos != null) { setAutorizaSozinho(!!b.todos); DB.logEvent({ type: 'chamar_auto_todos', detail: b.todos ? 'ligado' : 'desligado' }); broadcast({ t: 'state' }); return json(res, 200, { ok: true, todos: autorizaSozinho() }), true }
    if (b.personId != null) { autorizarPessoa(b.personId, !!b.ligado); broadcast({ t: 'state' }); return json(res, 200, { ok: true, pessoas: pessoasAutorizadas() }), true }
    return json(res, 400, { error: 'parâmetros' }), true
  }

  // ---------------- chamar agora (manual) ----------------
  if (seg[2] === 'chamar') {
    const canal = b.canal || 'whatsapp'
    const enviar = canal === 'whatsapp' ? enviarWhatsapp : enviarInstagram
    // Prévia: escreve a mensagem e mostra a conferência do vínculo, SEM enviar nada. É como
    // se olha o que vai sair antes de sair (e o que o sistema acha do vínculo).
    if (b.previa) {
      const conf = canal === 'whatsapp' ? conferirVinculo(ACCOUNT, b.personId, b.alvo) : { estado: 'n/a', ok: true }
      let texto = null, erro = null
      try { texto = await gerarPrimeiraMensagem({ accountKey: ACCOUNT, personId: b.personId, nome: b.nome, canal, alvo: b.alvo }) }
      catch (e) { erro = e && e.message ? e.message : String(e) }
      return json(res, 200, {
        ok: !erro, texto, erro,
        conferencia: conf,
        bloqueio: bloqueioParaChamar(ACCOUNT, canal, { personId: b.personId, alvo: b.alvo }),
      }), true
    }
    if (typeof enviar !== 'function') return json(res, 503, { error: canal + ' indisponível' }), true
    const r = await chamarUma({ accountKey: ACCOUNT, canal, personId: b.personId, nome: b.nome, alvo: b.alvo, enviar, forcar: true })
    broadcast({ t: 'state' })
    return json(res, r.ok ? 200 : 409, r), true
  }

  // ---------------- diagnóstico de um número: o que o SERVIDOR responde ----------------
  // Pergunta ao WhatsApp quais formas do número existem e qual LID cada uma tem. É a
  // ferramenta pra entender por que uma mensagem não chegou, sem adivinhação.
  if (seg[2] === 'diag-numero') {
    const acc = ctx.waAccount && ctx.waAccount()
    if (!acc || !acc.sock) return json(res, 503, { error: 'WhatsApp não conectado' }), true
    const candidatos = phoneCandidates(b.numero || '')
    if (!candidatos.length) return json(res, 400, { error: 'número inválido' }), true
    let existentes = []
    try { existentes = (await acc.onWhatsApp(...candidatos)) || [] } catch (e) { return json(res, 500, { error: e.message }), true }
    const detalhe = []
    for (const r of existentes) {
      let lid = null
      if (r.exists) { try { lid = await resolveLidForPn(acc, r.jid) } catch { /* sem lid */ } }
      detalhe.push({ jid: r.jid, existe: !!r.exists, lid })
    }
    return json(res, 200, { candidatos, detalhe }), true
  }

  // ---------------- diagnóstico de uma pessoa (pra ficha) ----------------
  if (seg[2] === 'diagnostico') {
    const canal = b.canal || 'whatsapp'
    return json(res, 200, { bloqueio: bloqueioParaChamar(ACCOUNT, canal, { personId: b.personId, alvo: b.alvo }) }), true
  }

  return false
}
