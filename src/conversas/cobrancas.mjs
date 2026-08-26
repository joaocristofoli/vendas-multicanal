// Resumo de pedidos unicos e cobrancas para a aba Progresso.
//
// Importante: aqui entram apenas acoes concretas de pedido/cobranca. Necessidade ligada no
// contexto da IA nao conta como cobranca iniciada.
import { db } from '../core/db.mjs'
import { garantirTabelaPedidoUnico } from '../necessidades/pedido-unico.mjs'
import { formatarBRL, garantirTabela as garantirTabelaNecessidade } from '../necessidades/store.mjs'
import { historicoCobrancas, lerPix } from '../self/pix.mjs'
import { textoCobraComAChave } from '../ai/filtro.mjs'

function numero(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function quandoDoPedido(row) {
  return numero(row.enviado_em) || numero(row.atualizado_em) || numero(row.agendado_em)
}

function pedidoVisivel(row, { desde = 0, ate = Date.now() } = {}) {
  if (!row) return false
  if (row.estado === 'pendente' || row.estado === 'gerando' || row.estado === 'aguardando') return true
  const ts = quandoDoPedido(row)
  if (!ts) return false
  if (desde && ts < desde) return false
  if (ate && ts > ate) return false
  return true
}

function historicoNoRecorte(itens, { desde = 0, ate = Date.now() } = {}) {
  return (Array.isArray(itens) ? itens : []).filter((item) => {
    const ts = numero(item.ts)
    if (!ts) return false
    if (desde && ts < desde) return false
    if (ate && ts > ate) return false
    return true
  })
}

// O ESTADO "LIGADA E AINDA NÃO COBRADA".
//
// Ligar uma necessidade em 26 pessoas não é cobrança — mas é uma decisão que ficou de pé, e
// até 15/08/2026 ela era INVISÍVEL: a aba só listava pedido único e cobrança confirmada, e
// como nenhum dos dois tinha acontecido, a tela dizia "Nenhuma cobrança iniciada" enquanto a
// necessidade seguia ligada em 26 conversas desde a véspera. Quem ligou não tinha como saber
// se aquilo tinha virado alguma coisa. "Ligada e não cobrada" é um dado, e é este bloco.
//
// Ele NÃO respeita o recorte de tempo dos filtros de cima, de propósito: ligação é ESTADO
// atual, não evento do período. Uma necessidade ligada há dois meses e ainda de pé precisa
// aparecer em "7 dias". O que respeita o recorte é a contagem de bloqueios, que é evento.
export function necessidadesLigadasProgresso({ desde = 0, ate = Date.now() } = {}) {
  // As tabelas de necessidade nascem SOB DEMANDA, não no schema base: numa instância que
  // nunca abriu a tela de Necessidades — toda recém-clonada — consultar direto estoura com
  // "no such table". A aba Cobranças não pode cair por causa disso.
  garantirTabelaNecessidade()
  garantirTabelaPedidoUnico()
  const d = db()
  const necessidades = d.prepare(`SELECT n.id, n.descricao, n.valor_centavos, n.status,
      COUNT(np.person_id) AS pessoas, MAX(np.criado_em) AS ligada_em, MIN(np.criado_em) AS primeira_em
    FROM necessidade n
    JOIN necessidade_pessoa np ON np.necessidade_id = n.id AND np.estado = 'sim'
    GROUP BY n.id
    ORDER BY ligada_em DESC, n.id DESC`).all()

  // Pessoa ligada em duas necessidades é UMA pessoa. Somar os cartões daria 32 onde há 30 —
  // número inflado na tela é o mesmo defeito de contar parcial como total.
  const pessoasDistintas = new Set()
  const cobradasDistintas = new Set()

  const itens = necessidades.map((row) => {
    const id = numero(row.id)
    const pessoas = d.prepare(`SELECT person_id, criado_em FROM necessidade_pessoa
      WHERE necessidade_id=? AND estado='sim'`).all(id)
    const ids = pessoas.map((p) => String(p.person_id))
    const marks = ids.map(() => '?').join(',') || "''"
    // Cobrada = pedido único ENVIADO desta necessidade, ou chave PIX confirmada pra essa
    // pessoa. Pedido pendente não é cobrança: é intenção esperando a vez.
    const enviados = new Set(d.prepare(`SELECT DISTINCT person_id FROM necessidade_pedido_unico
      WHERE necessidade_id=? AND estado='enviado'`).all(id).map((r) => String(r.person_id)))
    const pendentes = d.prepare(`SELECT COUNT(*) AS n FROM necessidade_pedido_unico
      WHERE necessidade_id=? AND estado IN ('pendente','gerando','aguardando')`).get(id)?.n || 0
    const comPix = new Set(ids.length
      ? d.prepare(`SELECT DISTINCT person_id FROM cobranca_envio WHERE person_id IN (${marks})`).all(...ids).map((r) => String(r.person_id))
      : [])
    const cobradas = new Set([...enviados, ...comPix].filter((pid) => ids.includes(pid)))
    ids.forEach((pid) => pessoasDistintas.add(pid))
    cobradas.forEach((pid) => cobradasDistintas.add(pid))
    // Quem recebeu resposta AUTOMÁTICA depois de ser ligada. Mede se a necessidade sequer
    // chegou a uma conversa — sem isso, "ligada em 26" não diz se alguém falou com alguém.
    let comMensagemDepois = 0
    for (const p of pessoas) {
      const desdeLigacao = numero(p.criado_em)
      if (!desdeLigacao) continue
      const n = d.prepare(`SELECT COUNT(*) AS n FROM message
        WHERE person_id=? AND direction='outgoing' AND author='ia' AND ts > ?`).get(String(p.person_id), desdeLigacao)?.n || 0
      if (n > 0) comMensagemDepois++
    }
    return {
      id,
      descricao: row.descricao || 'necessidade',
      valorFormatado: formatarBRL(numero(row.valor_centavos)),
      status: row.status || 'aberta',
      pessoas: ids.length,
      ligadaEm: numero(row.ligada_em) || null,
      primeiraEm: numero(row.primeira_em) || null,
      cobradas: cobradas.size,
      pedidosAbertos: numero(pendentes),
      comMensagemDepois,
    }
  })

  // A permissão de mandar a chave PIX é POR PESSOA e exige bit + motivo escrito. Sem ela o
  // filtro segura a chave, e é isso que explica "ligada e ninguém cobrado".
  const autorizadas = d.prepare(`SELECT COUNT(*) AS n FROM pessoa_pref
    WHERE cobranca_autorizada=1 AND COALESCE(cobranca_motivo,'') <> ''`).get()?.n || 0
  const bitSemMotivo = d.prepare(`SELECT COUNT(*) AS n FROM pessoa_pref
    WHERE cobranca_autorizada=1 AND COALESCE(cobranca_motivo,'') = ''`).get()?.n || 0
  const bloqueios = d.prepare(`SELECT COUNT(*) AS n, MAX(ts) AS ultimo FROM event
    WHERE type='filtro_bloqueou' AND detail LIKE '%pix_sem_pedido%' AND ts >= ? AND ts <= ?`)
    .get(numero(desde), numero(ate) || Date.now())

  return {
    itens,
    pessoasLigadas: pessoasDistintas.size,
    cobradas: cobradasDistintas.size,
    autorizadas,
    bitSemMotivo,
    chaveSeguradaNoRecorte: numero(bloqueios?.n),
    chaveSeguradaUltima: numero(bloqueios?.ultimo) || null,
  }
}

// COBRANÇA QUE A IA FEZ — a chave PIX saindo dentro de uma frase de cobrança.
//
// `cobranca_envio` só registra o que SAIU PELO MECANISMO de cobrança. Quem manda a chave PIX
// digitando na conversa — pelo celular ou pelo painel — cobra de verdade e não deixa registro
// nenhum: em 15/08/2026 a instancia-b mostrava "0 iniciadas" com a chave já enviada 17 vezes para
// 14 pessoas, todas pela mão de quem opera (nenhuma pela IA). A tela não estava mentindo sobre
// o que media; o que ela media é que não era o que a pessoa chama de cobrança.
//
// A detecção é DETERMINÍSTICA e usa o dado que já existe: a chave cadastrada no painel,
// procurada no texto do que saiu — literal e também só os dígitos, porque CPF vai ora com
// pontuação, ora sem. Sem chave cadastrada, não há o que procurar e a função devolve vazio.
export function cobrancasComAChavePorPessoa({ desde = 0, ate = Date.now() } = {}) {
  // DECISÃO DO DONO (15/08/2026): esta tela mostra o que a IA fez. Cobrança digitada por quem
  // opera não entra — ele sabe o que mandou com a própria mão; o que ele não vê é a automação
  // trabalhando. Por isso o filtro por `author='ia'` fica AQUI, na fonte do número, e não só
  // no desenho: assim a métrica, o cartão e o total contam a mesma coisa.
  const chave = String(lerPix()?.chave || '').trim()
  const porPessoa = new Map()
  if (!chave) return porPessoa
  const digitos = chave.replace(/\D+/g, '')
  const cond = ['direction = ?', 'text IS NOT NULL', "author = 'ia'"]
  const args = ['outgoing']
  const ors = ['text LIKE ?']
  args.push(`%${chave}%`)
  // Chave curta demais em dígitos casaria com qualquer número da conversa (um preço, uma
  // hora). Oito dígitos é o piso: telefone e CPF passam, "1500" não.
  if (digitos.length >= 8) {
    ors.push("replace(replace(replace(replace(text,'.',''),'-',''),' ',''),'/','') LIKE ?")
    args.push(`%${digitos}%`)
  }
  cond.push(`(${ors.join(' OR ')})`)
  if (desde) { cond.push('ts >= ?'); args.push(numero(desde)) }
  if (ate) { cond.push('ts <= ?'); args.push(numero(ate)) }
  const linhas = db().prepare(`SELECT person_id, ts, channel, author, text FROM message
    WHERE ${cond.join(' AND ')} ORDER BY ts DESC`).all(...args)
  for (const l of linhas) {
    const pid = String(l.person_id || '')
    if (!pid) continue
    // A MESMA pergunta que o portão faz antes de enviar. Sem isto, "Pode me chamar 45
    // 99846-8436" — que o portão deixa passar como conversa — virava cobrança na estatística.
    if (!textoCobraComAChave(l.text, chave)) continue
    const lista = porPessoa.get(pid) || []
    // `author` distingue quem escreveu: 'ia' é a IA, o resto é a mão de quem opera (mensagem
    // antiga não tem carimbo, e isso é dito como não sabido em vez de chutado).
    lista.push({ ts: numero(l.ts), canal: l.channel || null, autor: l.author || null })
    porPessoa.set(pid, lista)
  }
  return porPessoa
}

export function resumoCobrancasProgresso({ conversas = [], desde = 0, ate = Date.now(), limite = 60 } = {}) {
  // O JOIN abaixo toca `necessidade`, que também nasce sob demanda: sem esta linha, a aba cai
  // na primeira instância que tem conversa e nunca abriu Necessidades.
  garantirTabelaNecessidade()
  garantirTabelaPedidoUnico()
  const linhas = Array.isArray(conversas) ? conversas.filter((c) => c && c.personId) : []
  if (!linhas.length) {
    return {
      total: 0,
      resumo: {
        pessoas: 0,
        pedidosPendentes: 0,
        pedidosGerando: 0,
        pedidosEnviados: 0,
        pedidosCancelados: 0,
        cobrancasIniciadas: 0,
        cobrancasNaMao: 0,
        pessoasNaMao: 0,
        pessoasChavePelaIa: 0,
        feedbackRecebido: 0,
        feedbackIndireto: 0,
        semResposta: 0,
      },
      itens: [],
    }
  }

  const ids = [...new Set(linhas.map((c) => String(c.personId)).filter(Boolean))]
  const marks = ids.map(() => '?').join(',')
  const pedidoRows = db().prepare(`SELECT p.id, p.person_id, p.necessidade_id, p.estado, p.agendado_em,
      p.atualizado_em, p.enviado_em, p.canal_enviado, p.erro, n.descricao, n.valor_centavos
    FROM necessidade_pedido_unico p
    JOIN necessidade n ON n.id = p.necessidade_id
    WHERE p.person_id IN (${marks})
    ORDER BY COALESCE(p.enviado_em, p.atualizado_em, p.agendado_em) DESC, p.id DESC`).all(...ids)
  const comCobranca = new Set(db().prepare(`SELECT DISTINCT person_id FROM cobranca_envio
    WHERE person_id IN (${marks})`).all(...ids).map((r) => String(r.person_id)))

  const pedidosPorPessoa = new Map()
  for (const row of pedidoRows) {
    if (!pedidoVisivel(row, { desde, ate })) continue
    const pid = String(row.person_id)
    const lista = pedidosPorPessoa.get(pid) || []
    lista.push({
      id: numero(row.id),
      necessidadeId: numero(row.necessidade_id),
      descricao: row.descricao || 'necessidade',
      valorFormatado: formatarBRL(numero(row.valor_centavos)),
      estado: row.estado || 'pendente',
      agendadoEm: numero(row.agendado_em) || null,
      atualizadoEm: numero(row.atualizado_em) || null,
      enviadoEm: numero(row.enviado_em) || null,
      canal: row.canal_enviado || null,
      erro: row.erro || null,
    })
    pedidosPorPessoa.set(pid, lista)
  }

  const comAChave = cobrancasComAChavePorPessoa({ desde, ate })
  const resumo = {
    pessoas: 0,
    pedidosPendentes: 0,
    pedidosGerando: 0,
    pedidosEnviados: 0,
    pedidosCancelados: 0,
    cobrancasIniciadas: 0,
    cobrancasNaMao: 0,
    pessoasNaMao: 0,
    pessoasChavePelaIa: 0,
    feedbackRecebido: 0,
    feedbackIndireto: 0,
    semResposta: 0,
  }
  const itens = []

  for (const linha of linhas) {
    const personId = String(linha.personId)
    const pedidos = pedidosPorPessoa.get(personId) || []
    const historico = comCobranca.has(personId)
      ? historicoNoRecorte(historicoCobrancas(personId).itens, { desde, ate })
      : []
    const chaveNaMao = comAChave.get(personId) || []
    if (!pedidos.length && !historico.length && !chaveNaMao.length) continue
    if (chaveNaMao.length) {
      resumo.cobrancasNaMao += chaveNaMao.length
      resumo.pessoasNaMao += 1
      if (chaveNaMao.some((x) => x.autor === 'ia')) resumo.pessoasChavePelaIa += 1
    }

    for (const pedido of pedidos) {
      if (pedido.estado === 'pendente' || pedido.estado === 'aguardando') resumo.pedidosPendentes++
      else if (pedido.estado === 'gerando') resumo.pedidosGerando++
      else if (pedido.estado === 'enviado') resumo.pedidosEnviados++
      else if (pedido.estado === 'cancelado' || pedido.estado === 'recusado') resumo.pedidosCancelados++
    }
    for (const item of historico) {
      resumo.cobrancasIniciadas++
      const estado = item.feedback?.estado || 'sem_resposta'
      if (estado === 'recebido') resumo.feedbackRecebido++
      else if (estado === 'indireto') resumo.feedbackIndireto++
      else resumo.semResposta++
    }

    itens.push({
      personId,
      nome: linha.nome || personId,
      canal: linha.canal || null,
      canais: linha.canais || [],
      estagio: linha.estagio || 'parada',
      ultima: numero(linha.ultima) || 0,
      vez: linha.vez || 'dela',
      pedidos,
      historico: { total: historico.length, itens: historico },
      // Cobrança digitada na conversa: conta como iniciada, e a tela diz que foi na mão.
      naMao: {
        total: chaveNaMao.length,
        ultima: chaveNaMao[0]?.ts || null,
        canal: chaveNaMao[0]?.canal || null,
        pelaIa: chaveNaMao.some((x) => x.autor === 'ia'),
      },
      ultimaMovimentacao: Math.max(
        0,
        ...pedidos.map((p) => numero(p.enviadoEm) || numero(p.atualizadoEm) || numero(p.agendadoEm)),
        ...historico.map((h) => numero(h.ts)),
        ...chaveNaMao.map((x) => numero(x.ts)),
      ),
    })
  }

  itens.sort((a, b) => {
    const aAtivo = a.pedidos.some((p) => p.estado === 'pendente' || p.estado === 'gerando' || p.estado === 'aguardando') ? 1 : 0
    const bAtivo = b.pedidos.some((p) => p.estado === 'pendente' || p.estado === 'gerando' || p.estado === 'aguardando') ? 1 : 0
    return bAtivo - aAtivo
      || b.ultimaMovimentacao - a.ultimaMovimentacao
      || b.ultima - a.ultima
      || String(a.nome).localeCompare(String(b.nome), 'pt-BR')
  })

  resumo.pessoas = itens.length
  return { total: itens.length, resumo, itens: itens.slice(0, limite) }
}
