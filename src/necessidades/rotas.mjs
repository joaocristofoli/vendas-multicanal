// Rotas das necessidades. Mesmo formato dos outros handlers modulares: devolve true se
// tratou, false se não é dele.
//
//   GET    /api/necessidades           a lista (sem total somado: ver store.mjs)
//   POST   /api/necessidades           cria ou edita { id?, descricao, valorCentavos, prazo?, prazoTipo?, prazoData?, status }
//   POST   /api/necessidades/status    alterna aberta <-> resolvida { id }
//   POST   /api/necessidades/dias      só a espera { id, dias, criterio } — 0 = desde o começo
//   POST   /api/necessidades/linha     só a linha de conversa { id, linha } — texto livre dele
//   POST   /api/necessidades/horario   só a janela { id, de, ate } em HH:MM de Brasília; vazio = qualquer hora
//   POST   /api/necessidades/tipos     quais vínculos podem ouvir { id, tipos: [] } — vazio = todos
//   POST   /api/necessidades/pessoa    decisão numa pessoa { id, personId, estado: sim|nao|padrao }
//   GET    /api/necessidades/por-pessoa?personId=   o que vale pra ela, já resolvido
//   POST   /api/necessidades/pedido    agenda/cancela pedido único { id, personId, acao }
//   POST   /api/necessidades/preparo   o que fazer antes { id, minutos, dias, como } — 0 minutos = sem preparo
//   DELETE /api/necessidades?id=       apaga
//
// O valor viaja SEMPRE em centavos inteiros, nos dois sentidos. A tela formata; a API não
// manda string formatada nem número quebrado — é o que impede "R$ 1.200,00" virar 1.2.
import { listar, salvar, apagar, alternarStatus, formatarBRL, descreverPrazo, descreverEspera, definirDias, definirLinha, definirHorario, descreverHorario, definirTipos, definirPessoa, tiposDaNecessidade, decisoesDaPessoa, definirPreparo, descreverPreparo,
  definirMsgs, descreverMsgs, definirCobrar,
  vincularFotoNecessidade, desvincularFotoNecessidade, vinculosFotoNecessidade } from './store.mjs'
import { aplicarCobrancaNecessidades, resumoCobrancaNecessidade } from './cobranca.mjs'
import { agendarPedidoUnico, cancelarPedidoUnico, pedidosDaPessoa } from './pedido-unico.mjs'

export function handleNecessidadesApi({ p, method, res, url, json, body }) {
  // LIGAÇÕES FOTO <-> NECESSIDADE (N:N, opcional dos dois lados). A tela desenha as linhas a
  // partir do GET; ligar e desligar são o mesmo endpoint com verbo diferente, porque do ponto
  // de vista de quem arrasta é a MESMA ação em dois sentidos.
  if (p === '/api/necessidades/vinculos' && method === 'GET') {
    json(res, 200, { vinculos: vinculosFotoNecessidade() })
    return true
  }
  // `body` aqui é o corpo JÁ LIDO (objeto), e o servidor só lê corpo em POST — por isso o
  // DELETE recebe os dois lados pela querystring, como o DELETE de necessidade que já existia.
  if (p === '/api/necessidades/vinculos' && (method === 'POST' || method === 'DELETE')) {
    const fotoId = method === 'POST' ? body?.fotoId : url.searchParams.get('fotoId')
    const necessidadeId = method === 'POST' ? body?.necessidadeId : url.searchParams.get('necessidadeId')
    if (!fotoId || !necessidadeId) { json(res, 400, { error: 'fotoId e necessidadeId' }); return true }
    if (method === 'POST') vincularFotoNecessidade(fotoId, necessidadeId)
    else desvincularFotoNecessidade(fotoId, necessidadeId)
    json(res, 200, { ok: true, vinculos: vinculosFotoNecessidade() })
    return true
  }

  if (!p.startsWith('/api/necessidades')) return false

  if (p === '/api/necessidades' && method === 'GET') {
    json(res, 200, { itens: listar().map((n) => ({
      ...n,
      valorFormatado: formatarBRL(n.valor_centavos),
      prazoLabel: descreverPrazo({ prazo: n.prazo, prazoTipo: n.prazo_tipo, prazoData: n.prazo_data }),
      diasMinimos: Number(n.dias_minimos || 0),
      diasCriterio: n.dias_criterio || 'corridos',
      esperaLabel: descreverEspera(n.dias_minimos, n.dias_criterio),
      linha: n.linha || '',
      horaDe: n.hora_de || '', horaAte: n.hora_ate || '',
      horarioLabel: descreverHorario(n.hora_de, n.hora_ate),
      tipos: tiposDaNecessidade(n),
      preparoMinutos: Number(n.preparo_minutos || 0),
      preparoDias: Number(n.preparo_dias || 0),
      preparoComo: n.preparo_como || '',
      preparoLabel: descreverPreparo({ preparoMinutos: n.preparo_minutos, preparoDias: n.preparo_dias, preparoComo: n.preparo_como }),
      msgsMinimas: Number(n.msgs_minimas || 0),
      msgsLabel: descreverMsgs(n.msgs_minimas),
      cobrar: !!Number(n.cobrar || 0),
    })) })
    return true
  }

  if (p === '/api/necessidades' && method === 'POST') {
    try {
      const id = salvar({
        id: body?.id,
        descricao: body?.descricao,
        valorCentavos: body?.valorCentavos,
        prazo: body?.prazo,
        prazoTipo: body?.prazoTipo,
        prazoData: body?.prazoData,
        diasMinimos: body?.diasMinimos,
        diasCriterio: body?.diasCriterio,
        linha: body?.linha,
        horaDe: body?.horaDe, horaAte: body?.horaAte,
        tipos: body?.tipos,
        preparoMinutos: body?.preparoMinutos, preparoDias: body?.preparoDias, preparoComo: body?.preparoComo,
        msgsMinimas: body?.msgsMinimas,
        cobrar: body?.cobrar,
        status: body?.status,
      })
      json(res, 200, { ok: true, id })
    } catch (e) {
      json(res, 400, { ok: false, erro: e.message })
    }
    return true
  }

  // Só a espera, direto da lista. Rota própria (e não o POST inteiro) porque mandar
  // descrição, valor e vencimento de volta a cada ajuste de dias é como um deles se perde.
  if (p === '/api/necessidades/dias' && method === 'POST') {
    const r = definirDias(body?.id, body?.dias, body?.criterio)
    if (r == null) { json(res, 404, { error: 'necessidade não encontrada' }); return true }
    json(res, 200, { ok: true, diasMinimos: r.dias, diasCriterio: r.criterio, esperaLabel: descreverEspera(r.dias, r.criterio) })
    return true
  }

  if (p === '/api/necessidades/msgs' && method === 'POST') {
    const r = definirMsgs(body?.id, body?.msgs)
    if (r == null) { json(res, 404, { error: 'necessidade não encontrada' }); return true }
    json(res, 200, { ok: true, msgsMinimas: r.msgsMinimas, msgsLabel: descreverMsgs(r.msgsMinimas) })
    return true
  }

  if (p === '/api/necessidades/cobrar' && method === 'POST') {
    const r = definirCobrar(body?.id, body?.cobrar)
    if (r == null) { json(res, 404, { error: 'necessidade não encontrada' }); return true }
    let aplicacao = null
    if (r.cobrar) {
      try { aplicacao = aplicarCobrancaNecessidades({ necessidadeId: Number(body.id) }) }
      catch (e) { json(res, 400, { ok: false, erro: e.message, cobrar: true }); return true }
    }
    json(res, 200, { ok: true, cobrar: !!r.cobrar, aplicacao })
    return true
  }

  if (p === '/api/necessidades/cobranca' && method === 'GET') {
    json(res, 200, resumoCobrancaNecessidade(url.searchParams.get('id')))
    return true
  }

  // A LINHA DE CONVERSA (texto livre): como ela conta essa situação. Rota própria pelo mesmo
  // motivo da espera — é campo editado direto na lista.
  if (p === '/api/necessidades/linha' && method === 'POST') {
    const t2 = definirLinha(body?.id, body?.linha)
    if (t2 == null) { json(res, 404, { error: 'necessidade não encontrada' }); return true }
    json(res, 200, { ok: true, linha: t2 })
    return true
  }

  // A JANELA DE HORÁRIO (sempre horário de Brasília). Duas pontas vazias = qualquer hora.
  if (p === '/api/necessidades/horario' && method === 'POST') {
    const h = definirHorario(body?.id, body?.de, body?.ate)
    if (h == null) { json(res, 404, { error: 'necessidade não encontrada' }); return true }
    json(res, 200, { ok: true, ...h, horarioLabel: descreverHorario(h.horaDe, h.horaAte) })
    return true
  }

  // O PREPARO: o que fazer antes de citar { id, minutos, dias, como }. minutos 0 = sem preparo.
  if (p === '/api/necessidades/preparo' && method === 'POST') {
    const r = definirPreparo(body?.id, body?.minutos, body?.dias, body?.como)
    if (r == null) { json(res, 404, { error: 'necessidade não encontrada' }); return true }
    json(res, 200, { ok: true, ...r, preparoLabel: descreverPreparo(r) })
    return true
  }

  // QUEM PODE OUVIR — camada 1: os tipos de pessoa. Lista vazia = todos.
  if (p === '/api/necessidades/tipos' && method === 'POST') {
    const t = definirTipos(body?.id, body?.tipos)
    if (t == null) { json(res, 404, { error: 'necessidade não encontrada' }); return true }
    json(res, 200, { ok: true, tipos: t })
    return true
  }
  // camada 2: a decisão numa pessoa específica, que ganha do tipo. 'sim' | 'nao' | qualquer
  // outra coisa volta pro padrão.
  if (p === '/api/necessidades/pessoa' && method === 'POST') {
    const e = definirPessoa(body?.id, body?.personId, body?.estado)
    if (e == null) { json(res, 404, { error: 'necessidade ou pessoa não encontrada' }); return true }
    json(res, 200, { ok: true, estado: e })
    return true
  }
  // PEDIDO ÚNICO. É ação explícita, diferente de só liberar a necessidade no contexto:
  // `agendar` põe a fala na próxima resposta automática e `cancelar` tira antes de enviar.
  if (p === '/api/necessidades/pedido' && method === 'POST') {
    try {
      const acao = body?.acao === 'cancelar' ? 'cancelar' : 'agendar'
      const pedido = acao === 'cancelar'
        ? cancelarPedidoUnico(body?.id, body?.personId)
        : agendarPedidoUnico(body?.id, body?.personId)
      if (!pedido && acao === 'cancelar') { json(res, 404, { ok: false, erro: 'não há pedido aguardando' }); return true }
      json(res, 200, { ok: true, pedido })
    } catch (e) {
      json(res, 400, { ok: false, erro: e.message })
    }
    return true
  }
  // O que vale PRA UMA PESSOA: a lista com o estado de cada necessidade já resolvido.
  if (p === '/api/necessidades/por-pessoa' && method === 'GET') {
    const personId = url.searchParams.get('personId') || ''
    if (!personId) { json(res, 400, { error: 'personId' }); return true }
    return (async () => {
      const { idsBrutosDaPessoa } = await import('../self/identidade.mjs')
      const { vinculoDaPessoa } = await import('../self/vinculos.mjs')
      let ids = [personId]; let tipo = null
      try { ids = idsBrutosDaPessoa(personId) } catch { /* banco parcial */ }
      try { tipo = vinculoDaPessoa(personId)?.vinculo || null } catch { /* sem tagueamento */ }
      const dec = decisoesDaPessoa(ids)
      const pedidos = pedidosDaPessoa(personId)
      json(res, 200, {
        personId, tipo,
        itens: listar({ incluirResolvidas: false }).map((n) => {
          const tipos = tiposDaNecessidade(n)
          const decidido = dec.get(n.id) || null
          const pedido = pedidos.get(Number(n.id)) || null
          // `peloTipo` é o que aconteceria SEM decisão nenhuma: é o que a tela mostra como
          // "padrão", pra ele ver o que está herdando antes de mudar.
          const peloTipo = !tipos.length ? true : (tipo ? tipos.includes(tipo) : false)
          return {
            id: n.id, descricao: n.descricao, tipos,
            estado: decidido || 'padrao',
            peloTipo,
            vale: decidido === 'nao' ? false : decidido === 'sim' ? true : peloTipo,
            valorFormatado: formatarBRL(n.valor_centavos),
            temValor: Number(n.valor_centavos || 0) > 0,
            temLinha: !!String(n.linha || '').trim(),
            pedido: pedido ? {
              estado: pedido.estado,
              agendadoEm: pedido.agendado_em,
              enviadoEm: pedido.enviado_em,
              canal: pedido.canal_enviado || null,
              erro: pedido.erro || null,
            } : null,
          }
        }),
      })
      return true
    })()
  }

  if (p === '/api/necessidades/status' && method === 'POST') {
    const novo = alternarStatus(body?.id)
    if (!novo) { json(res, 404, { ok: false, erro: 'não achei essa necessidade' }); return true }
    json(res, 200, { ok: true, status: novo })
    return true
  }

  if (p === '/api/necessidades' && method === 'DELETE') {
    const ok = apagar(url.searchParams.get('id'))
    json(res, ok ? 200 : 404, { ok })
    return true
  }

  return false
}
