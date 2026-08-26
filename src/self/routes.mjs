// Rotas do "eu": fatos (memória estruturada), asserções (o que já foi dito) e encontros
// (interruptor de propor date + janelas de disponibilidade). Mesmo formato dos outros
// handlers modulares do projeto (projects/routes.mjs, bridge/routes.mjs).
import { listarFatos, salvarFato, apagarFato, invalidarFato, contagemFatos, assercoesRecentes, assercoesDaPessoa, CATEGORIAS, SENSIBILIDADES } from './fatos.mjs'
import { extrairFatos } from './extrair.mjs'
import { extrairSobreMim } from './sobre-mim.mjs'
import { listarJanelas, salvarJanela, apagarJanela, proporDatesGlobal, setProporDatesGlobal, proporDatesPessoa, setProporDatesPessoa, marcarAtendimentoGlobal, setMarcarAtendimentoGlobal, marcarAtendimentoPessoa, setMarcarAtendimentoPessoa, slotsLivres, descreverSlot, TIPOS } from './encontros.mjs'
import { listarLugares, salvarLugar, apagarLugar, lugarBase, listarPeriodos, salvarPeriodo, apagarPeriodo, periodoDoEvento, lugarAtivoEm, dataDe } from './lugares.mjs'
import { memoriaDaPessoa, mensagensNovas, listarMemorias, pessoasParaConsolidar, consolidarPessoa, apagarMemoria, nomeDaPessoa } from './memoria-pessoa.mjs'
import { procurarUnioes, listarSugestoes, decidirSugestao } from './uniao.mjs'
import { migracaoDoTinder } from './migracao.mjs'
import { listarVinculos, contagemVinculos, salvarVinculo, vinculoDaPessoa, CATALOGO, listarModulos, lerModulo, salvarModulo } from './vinculos.mjs'
import { cobrancaDaPessoa, historicoCobrancas, salvarCobrancaPessoa } from './pix.mjs'
import { listarProgramadas, programarCobranca, cancelarProgramada, buscarPessoasCobranca } from './cobranca-programada.mjs'
import { getSetting, setSetting, logEvent } from '../core/db.mjs'
import { ocupacaoAgenda } from '../agenda/context.mjs'
import { nomeParaMostrar } from '../core/nome.mjs'
import { pessoaCanonica } from './identidade.mjs'
import { listarRotina, salvarRotina, apagarRotina, rotinaAgora, DIAS as DIAS_ROTINA } from './rotina.mjs'

let extraindo = false
let extraindoSobreMim = false
let consolidando = false

function estadoExtracaoSobreMim() {
  const salvo = getSetting('sobre_mim_extracao', null)
  if (!salvo) return null
  if (!extraindoSobreMim && salvo.status === 'rodando') return { ...salvo, status: 'interrompida', etapa: 'interrompida antes de terminar' }
  return salvo
}

export async function handleSelfApi({ p, method, res, url, json, body, broadcast, account = 'main', buscarFoto, prepararSobreMim }) {
  if (!p.startsWith('/api/self')) return false

  // ---------------- rotina de quem opera ----------------
  // É recorrência do cotidiano, não disponibilidade para compromisso. Cada instância do
  // TIM pertence a uma pessoa, então esta API sempre edita a rotina daquela instância.
  if (p === '/api/self/rotina' && method === 'GET') {
    const itens = listarRotina()
    const atuais = new Set(rotinaAgora().map((r) => r.id))
    json(res, 200, { itens: itens.map((r) => ({ ...r, agora: atuais.has(r.id) })), dias: DIAS_ROTINA })
    return true
  }
  if (p === '/api/self/rotina' && method === 'POST') {
    const b = await body()
    try {
      const id = salvarRotina(b || {})
      logEvent({ type: 'rotina_salva', detail: `${b?.id ? 'editou' : 'criou'} "${String(b?.titulo || '').slice(0, 80)}"` })
      broadcast({ t: 'state' })
      json(res, 200, { ok: true, id })
    } catch (e) { json(res, 400, { error: e.message }) }
    return true
  }
  if (p.startsWith('/api/self/rotina/') && method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/self/rotina/'.length))
    const alvo = listarRotina().find((r) => r.id === id)
    const apagado = apagarRotina(id)
    if (apagado) logEvent({ type: 'rotina_apagada', detail: alvo?.titulo || 'horário removido' })
    broadcast({ t: 'state' })
    json(res, 200, { ok: true, apagado })
    return true
  }

  // ---------------- fatos ----------------
  // ---------------------------------------------------------------- módulos de vínculo
  //   GET  /api/self/vinculos/modulos            a lista: quantas pessoas, se já tem texto
  //   GET  /api/self/vinculos/modulo?vinculo=x   o texto de um
  //   POST /api/self/vinculos/modulo             salva { vinculo, texto } (texto vazio apaga)
  if (p === '/api/self/vinculos/modulos' && method === 'GET') {
    json(res, 200, { modulos: await listarModulos() })
    return true
  }
  if (p === '/api/self/vinculos/modulo' && method === 'GET') {
    try { json(res, 200, { texto: await lerModulo(url.searchParams.get('vinculo')) }) }
    catch (e) { json(res, 400, { erro: e.message }) }
    return true
  }
  if (p === '/api/self/vinculos/modulo' && method === 'POST') {
    const b = await body()
    try { json(res, 200, await salvarModulo(b?.vinculo, b?.texto)) }
    catch (e) { json(res, 400, { erro: e.message }) }
    return true
  }

  if (p === '/api/self/fatos' && method === 'GET') {
    const status = url.searchParams.get('status') || null
    json(res, 200, {
      fatos: listarFatos({ status }),
      contagem: contagemFatos(),
      categorias: CATEGORIAS,
      sensibilidades: SENSIBILIDADES,
      awareness: getSetting('fatos_awareness', true) !== false,
      extraindo,
      sobreMim: { extraindo: extraindoSobreMim, estado: estadoExtracaoSobreMim() },
    })
    return true
  }
  if (p === '/api/self/fatos' && method === 'POST') {
    const b = await body()
    try {
      const id = salvarFato({
        id: b.id, texto: b.texto, categoria: b.categoria, sensibilidade: b.sensibilidade,
        status: b.status, gatilhos: b.gatilhos, confianca: b.confianca, origem: b.origem || 'manual',
        validFrom: b.validFrom || null, validTo: b.validTo || null,
      })
      broadcast({ t: 'state' })
      json(res, 200, { ok: true, id })
    } catch (e) { json(res, 400, { error: e.message }) }
    return true
  }
  if (p === '/api/self/fatos/awareness' && method === 'POST') {
    const b = await body()
    setSetting('fatos_awareness', !!b.enabled)
    json(res, 200, { ok: true, awareness: !!b.enabled })
    return true
  }
  // Leitura ampla: primeiro tenta trazer mais histórico dos dois canais, depois mede todo o
  // corpus local. Conversas brutas não são enviadas a provedor; só estatísticas e padrões
  // determinísticos viram os manuais de voz. Fatos continuam propostos até aprovação.
  if (p === '/api/self/sobre-mim/extrair' && method === 'POST') {
    if (extraindoSobreMim) { json(res, 409, { error: 'o Sobre mim já está sendo extraído' }); return true }
    extraindoSobreMim = true
    const iniciadoEm = Date.now()
    const atualizar = (parte) => {
      const estado = { status: 'rodando', iniciadoEm, atualizadoEm: Date.now(), ...parte }
      setSetting('sobre_mim_extracao', estado)
      broadcast({ t: 'sobre-mim-progresso', ...estado })
    }
    atualizar({ etapa: 'preparando', feito: 0, total: 1, detalhe: 'ampliando a cobertura dos canais' })
    extrairSobreMim({
      sincronizar: typeof prepararSobreMim === 'function' ? prepararSobreMim : null,
      onProgress: atualizar,
    }).then((r) => {
      const estado = { status: 'pronto', iniciadoEm, atualizadoEm: Date.now(), resultado: r }
      setSetting('sobre_mim_extracao', estado)
      logEvent({ type: 'sobre_mim_extraido', detail: `${r.mensagensLidas} mensagens em ${r.conversasLidas} conversas; ${r.propostos} fatos propostos; leitura local` })
      broadcast({ t: 'sobre-mim-pronto', ...estado })
      broadcast({ t: 'state' })
    }).catch((e) => {
      const estado = { status: 'erro', iniciadoEm, atualizadoEm: Date.now(), erro: e.message }
      setSetting('sobre_mim_extracao', estado)
      logEvent({ type: 'sobre_mim_erro', detail: e.message })
      broadcast({ t: 'sobre-mim-erro', ...estado })
    }).finally(() => { extraindoSobreMim = false })
    json(res, 202, { ok: true, iniciadoEm })
    return true
  }
  if (p === '/api/self/fatos/extrair' && method === 'POST') {
    if (extraindo) { json(res, 409, { error: 'já está extraindo' }); return true }
    extraindo = true
    const b = await body().catch(() => ({}))
    // Roda solto: a extração é lenta (vários turnos) e o painel acompanha pelo WebSocket.
    extrairFatos({ limite: Number(b?.limite) || 400, onProgress: (i, n) => broadcast({ t: 'fatos-extraindo', lote: i, total: n }) })
      .then((r) => { logEvent({ type: 'fatos_extraidos', detail: `${r.propostos} propostos de ${r.lidas} mensagens (${r.duplicados} duplicados)` }); broadcast({ t: 'fatos-extraidos', ...r, fatos: undefined }); broadcast({ t: 'state' }) })
      .catch((e) => { logEvent({ type: 'fatos_erro', detail: e.message }); broadcast({ t: 'fatos-erro', erro: e.message }) })
      .finally(() => { extraindo = false })
    json(res, 200, { ok: true })
    return true
  }
  if (p.startsWith('/api/self/fatos/') && (method === 'DELETE' || method === 'PATCH')) {
    const id = decodeURIComponent(p.slice('/api/self/fatos/'.length)).split('/')[0]
    if (method === 'DELETE') { apagarFato(id); broadcast({ t: 'state' }); json(res, 200, { ok: true }); return true }
    const b = await body()
    if (b.acao === 'invalidar') { invalidarFato(id, b.quando || Date.now()); broadcast({ t: 'state' }); json(res, 200, { ok: true }); return true }
    json(res, 400, { error: 'ação' })
    return true
  }

  // ---------------- asserções (o que o clone já disse) ----------------
  if (p === '/api/self/assercoes' && method === 'GET') {
    const personId = url.searchParams.get('personId')
    json(res, 200, personId ? assercoesDaPessoa(personId, 100) : assercoesRecentes(120))
    return true
  }

  // ---------------- memória por pessoa ----------------
  if (p === '/api/self/memoria' && method === 'GET') {
    const personId = url.searchParams.get('personId')
    if (personId) {
      const m = memoriaDaPessoa(personId)
      json(res, 200, { personId, canonico: m?.canonico || personId, memoria: m || null, novas: mensagensNovas(personId), nome: nomeParaMostrar(personId) })
      return true
    }
    const memorias = listarMemorias().map((m) => ({ ...m, nome: nomeParaMostrar(m.person_id), novas: mensagensNovas(m.person_id) }))
    json(res, 200, { memorias, aguardando: pessoasParaConsolidar({ limite: 50 }).length, consolidando, auto: getSetting('memoria_auto', true) !== false })
    return true
  }
  if (p === '/api/self/memoria/consolidar' && method === 'POST') {
    const b = await body().catch(() => ({}))
    if (b?.personId) {
      try { const r = await consolidarPessoa(b.personId, { forcar: true }); json(res, 200, { ok: true, resultado: r }) }
      catch (e) { json(res, 500, { error: e.message }) }
      return true
    }
    if (consolidando) { json(res, 409, { error: 'já está consolidando' }); return true }
    consolidando = true
    const limite = Math.min(Number(b?.limite) || 20, 100)
    ;(async () => {
      const alvos = pessoasParaConsolidar({ limite })
      let feitas = 0
      for (let i = 0; i < alvos.length; i++) {
        broadcast({ t: 'memoria-progresso', feita: i, total: alvos.length, nome: nomeDaPessoa(alvos[i].personId) })
        try { if (await consolidarPessoa(alvos[i].personId)) feitas++ } catch { /* uma pessoa que falha não para a fila */ }
      }
      logEvent({ type: 'memoria_consolidada', detail: `${feitas} pessoa(s) de ${alvos.length}` })
      broadcast({ t: 'memoria-pronta', feitas, total: alvos.length })
      broadcast({ t: 'state' })
    })().catch((e) => { logEvent({ type: 'memoria_erro', detail: e.message }); broadcast({ t: 'memoria-erro', erro: e.message }) })
      .finally(() => { consolidando = false })
    json(res, 200, { ok: true })
    return true
  }
  if (p === '/api/self/memoria/auto' && method === 'POST') {
    const b = await body()
    setSetting('memoria_auto', !!b.enabled)
    json(res, 200, { ok: true, auto: !!b.enabled })
    return true
  }
  if (p === '/api/self/memoria' && method === 'DELETE') {
    const personId = url.searchParams.get('personId')
    if (personId) apagarMemoria(personId)
    broadcast({ t: 'state' })
    json(res, 200, { ok: true })
    return true
  }

  // ---------------- uniões sugeridas (identidade) ----------------
  if (p === '/api/self/uniao' && method === 'GET') {
    const sugestoes = listarSugestoes()
    // Pede a foto que falta do lado do WhatsApp (não espera; chega pelo 'state' do WS).
    if (typeof buscarFoto === 'function') {
      for (const s of sugestoes) for (const lado of [s.a, s.b]) {
        if (!lado.avatar && lado.canal === 'whatsapp') buscarFoto(String(lado.id).slice(3))
      }
    }
    json(res, 200, { sugestoes })
    return true
  }
  if (p === '/api/self/migracao' && method === 'GET') {
    // Quantas pessoas saíram do Tinder pra cada canal (mensagem nos dois lados).
    json(res, 200, migracaoDoTinder())
    return true
  }
  if (p === '/api/self/uniao/procurar' && method === 'POST') {
    const r = procurarUnioes({ accountKey: account })
    logEvent({ type: 'uniao_procurada', detail: `${r.autoVinculados} vínculo(s) automático(s), ${r.propostas} sugestão(ões) nova(s), ${r.pendentes} pendente(s)` })
    broadcast({ t: 'state' })
    json(res, 200, { ok: true, ...r })
    return true
  }
  if (p.startsWith('/api/self/uniao/') && method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/self/uniao/'.length))
    const b = await body()
    const r = decidirSugestao(id, b.acao)
    // Unir muda quem é a pessoa: a memória velha das duas partes deixa de valer sozinha.
    if (r.ok && r.status === 'unida' && r.canonico) { try { apagarMemoria(r.canonico) } catch { /* */ } }
    broadcast({ t: 'state' })
    json(res, r.ok ? 200 : 404, r)
    return true
  }

  // ---------------- vínculos (o tagueamento das 294) ----------------
  if (p === '/api/self/vinculos' && method === 'GET') {
    const personId = url.searchParams.get('personId')
    if (personId) {
      const v = vinculoDaPessoa(personId)
      // catalogo vai junto: o menu do painel não tem lista própria (era assim que existiam
      // duas verdades — 5 modos na tela contra 20 vínculos no banco).
      json(res, 200, { personId, vinculo: v, catalogo: CATALOGO, padrao: v?.origem === 'padrao-tinder' })
      return true
    }
    json(res, 200, { vinculos: listarVinculos(), contagem: contagemVinculos(), catalogo: CATALOGO })
    return true
  }
  if (p === '/api/self/vinculos' && method === 'POST') {
    const b = await body()
    try {
      const pid = salvarVinculo({ personId: b.personId, vinculo: b.vinculo, extras: b.extras || '', camadas: b.camadas || '', iaPode: b.iaPode, evidencia: b.evidencia || '', origem: 'manual-ui' })
      broadcast({ t: 'state' })
      json(res, 200, { ok: true, personId: pid })
    } catch (e) { json(res, 400, { error: e.message }) }
    return true
  }

  // ---------------- cobrança por pessoa ----------------
  if (p === '/api/self/cobranca/pessoa' && method === 'GET') {
    const personId = url.searchParams.get('personId') || ''
    json(res, 200, { personId, ...cobrancaDaPessoa(personId), historico: historicoCobrancas(personId) })
    return true
  }
  if (p === '/api/self/cobranca/autorizar' && method === 'POST') {
    const b = await body()
    if (!b?.personId) { json(res, 400, { error: 'personId obrigatório' }); return true }
    try {
      const regra = salvarCobrancaPessoa(b.personId, { enabled: !!b.enabled, motivo: b.motivo })
      logEvent({ type: 'cobranca_regra', detail: `${regra.cobrancaAutorizada ? 'regra de cobrança autorizada' : 'cobrança bloqueada'} para ${b.personId}` })
      broadcast({ t: 'state' })
      json(res, 200, { ok: true, personId: b.personId, ...regra, historico: historicoCobrancas(b.personId) })
    } catch (e) { json(res, 400, { error: e.message }) }
    return true
  }

  if (p === '/api/self/cobranca/programadas' && method === 'GET') {
    json(res, 200, { programadas: listarProgramadas() })
    return true
  }
  if (p === '/api/self/cobranca/programar' && method === 'POST') {
    const b = await body()
    try {
      const prog = programarCobranca({
        quando: b.quando,
        motivo: b.motivo,
        valorCentavos: b.valorCentavos,
        servico: b.servico,
        faixa: b.faixa,
        acao: b.acao,
        personIds: b.personIds,
        etiquetaId: b.etiquetaId,
      })
      broadcast({ t: 'state' })
      json(res, 200, { ok: true, programada: prog })
    } catch (e) { json(res, 400, { ok: false, erro: e.message }) }
    return true
  }
  if (p === '/api/self/cobranca/programadas/cancelar' && method === 'POST') {
    const b = await body()
    try {
      const prog = cancelarProgramada(b.id)
      broadcast({ t: 'state' })
      json(res, 200, { ok: true, programada: prog })
    } catch (e) { json(res, 400, { ok: false, erro: e.message }) }
    return true
  }
  if (p === '/api/self/cobranca/pessoas' && method === 'GET') {
    json(res, 200, { pessoas: buscarPessoasCobranca(url.searchParams.get('q') || '') })
    return true
  }

  // ---------------- encontros ----------------
  if (p === '/api/self/encontros' && method === 'GET') {
    const janelas = listarJanelas()
    const slots = slotsLivres({ janelas, eventos: ocupacaoAgenda() })
    json(res, 200, {
      proporDates: proporDatesGlobal(),
      janelas,
      proximos: slots.map((s) => ({ startMs: s.startMs, endMs: s.endMs, descricao: descreverSlot(s) })),
    })
    return true
  }
  // Estado do interruptor NESTA conversa: diz também se ainda está herdando o global,
  // porque "não propõe" por herança e "não propõe" por decisão são coisas diferentes na UI.
  if (p === '/api/self/encontros/pessoa' && method === 'GET') {
    const personId = url.searchParams.get('personId') || ''
    const { db } = await import('../core/db.mjs')
    const canonicalId = personId ? pessoaCanonica(personId) : ''
    const row = canonicalId ? db().prepare(`SELECT propor_dates, marcar_atendimento FROM pessoa_pref WHERE person_id=?`).get(canonicalId) : null
    const herdando = !row || row.propor_dates === null || row.propor_dates === undefined
    const herdandoAtendimento = !row || row.marcar_atendimento === null || row.marcar_atendimento === undefined
    json(res, 200, {
      personId, canonicalId, proporDates: proporDatesPessoa(personId), herdando, global: proporDatesGlobal(),
      marcarAtendimento: marcarAtendimentoPessoa(personId), herdandoAtendimento, globalAtendimento: marcarAtendimentoGlobal(),
    })
    return true
  }
  if (p === '/api/self/encontros/propor' && method === 'POST') {
    const b = await body()
    if (b.personId) {
      setProporDatesPessoa(b.personId, b.enabled === null ? null : !!b.enabled)
      logEvent({ type: 'dates_toggle', personId: pessoaCanonica(b.personId),
        detail: b.enabled === null ? 'encontro voltou a herdar o geral' : (b.enabled ? 'propor encontro LIGADO nesta pessoa' : 'propor encontro DESLIGADO nesta pessoa') })
      broadcast({ t: 'state' })
      json(res, 200, { ok: true, personId: b.personId, proporDates: proporDatesPessoa(b.personId), herdando: b.enabled === null })
      return true
    }
    setProporDatesGlobal(!!b.enabled)
    logEvent({ type: 'dates_toggle', detail: b.enabled ? 'propor encontro LIGADO' : 'propor encontro DESLIGADO' })
    broadcast({ t: 'state' })
    json(res, 200, { ok: true, proporDates: proporDatesGlobal() })
    return true
  }
  // Interruptor do ATENDIMENTO. Mesma forma do de encontro (global ou por pessoa, com
  // `enabled: null` voltando a herdar), e de propósito uma porta SEPARADA: desligar romance
  // não pode desligar trabalho, que foi o que aconteceu em 15/08/2026.
  if (p === '/api/self/atendimento/marcar' && method === 'POST') {
    const b = await body()
    if (b.personId) {
      setMarcarAtendimentoPessoa(b.personId, b.enabled === null ? null : !!b.enabled)
      logEvent({ type: 'atendimento_toggle', personId: pessoaCanonica(b.personId),
        detail: b.enabled === null ? 'atendimento voltou a herdar o geral' : (b.enabled ? 'marcar atendimento LIGADO nesta pessoa' : 'marcar atendimento DESLIGADO nesta pessoa') })
      broadcast({ t: 'state' })
      json(res, 200, { ok: true, personId: b.personId, marcarAtendimento: marcarAtendimentoPessoa(b.personId), herdando: b.enabled === null })
      return true
    }
    setMarcarAtendimentoGlobal(!!b.enabled)
    logEvent({ type: 'atendimento_toggle', detail: b.enabled ? 'marcar atendimento LIGADO' : 'marcar atendimento DESLIGADO' })
    broadcast({ t: 'state' })
    json(res, 200, { ok: true, marcarAtendimento: marcarAtendimentoGlobal() })
    return true
  }
  if (p === '/api/self/encontros/janela' && method === 'POST') {
    const b = await body()
    try { const id = salvarJanela(b); broadcast({ t: 'state' }); json(res, 200, { ok: true, id }) }
    catch (e) { json(res, 400, { error: e.message }) }
    return true
  }
  if (p.startsWith('/api/self/encontros/janela/') && method === 'DELETE') {
    apagarJanela(decodeURIComponent(p.slice('/api/self/encontros/janela/'.length)))
    broadcast({ t: 'state' })
    json(res, 200, { ok: true })
    return true
  }

  // ---------------- disponibilidade (janelas + lugares + períodos) ----------------
  // Uma chamada só devolve a tela inteira: as duas famílias de janela, os lugares, os
  // períodos daqui pra frente e os próximos horários que cada família produz. O painel não
  // precisa costurar quatro requisições pra desenhar uma coisa que é uma só.
  if (p === '/api/self/disponibilidade' && method === 'GET') {
    const eventos = ocupacaoAgenda()
    // Uma entrada por família declarada em TIPOS: família nova (atendimento, 15/08/2026)
    // aparece na tela sozinha, e nenhuma fica com `undefined` caindo no slotsLivres.
    const jan = Object.fromEntries(TIPOS.map((t) => [t, listarJanelas({ tipo: t })]))
    const proximos = {}
    for (const t of TIPOS) {
      proximos[t] = slotsLivres({ janelas: jan[t], eventos })
        .map((s) => ({ startMs: s.startMs, endMs: s.endMs, descricao: descreverSlot(s), lugar: s.lugar }))
    }
    const agoraMs = Date.now()
    json(res, 200, {
      proporDates: proporDatesGlobal(),
      marcarAtendimento: marcarAtendimentoGlobal(),
      tipos: TIPOS,
      lugares: listarLugares(),
      base: lugarBase(),
      periodos: listarPeriodos({ desde: agoraMs }),
      janelas: jan,
      proximos,
      hoje: { data: dataDe(agoraMs), ...lugarAtivoEm(agoraMs) },
    })
    return true
  }
  if (p === '/api/self/disponibilidade/janela' && method === 'POST') {
    const b = await body()
    try { const id = salvarJanela(b); broadcast({ t: 'state' }); json(res, 200, { ok: true, id }) }
    catch (e) { json(res, 400, { error: e.message }) }
    return true
  }
  if (p.startsWith('/api/self/disponibilidade/janela/') && method === 'DELETE') {
    apagarJanela(decodeURIComponent(p.slice('/api/self/disponibilidade/janela/'.length)))
    broadcast({ t: 'state' })
    json(res, 200, { ok: true })
    return true
  }

  // ---------------- lugares ----------------
  if (p === '/api/self/lugar' && method === 'POST') {
    const b = await body()
    try {
      const id = salvarLugar({ id: b.id, nome: b.nome, cidades: b.cidades, base: !!b.base })
      logEvent({ type: 'lugar_salvo', detail: `${b.id ? 'editou' : 'criou'} o lugar "${String(b.nome || '').slice(0, 60)}"` })
      broadcast({ t: 'state' })
      json(res, 200, { ok: true, id })
    } catch (e) { json(res, 400, { error: e.message }) }
    return true
  }
  // Apagar leva janela e período do lugar junto, e a resposta DIZ quantos foram: apagar
  // três janelas em silêncio é a diferença entre "removi o lugar" e "removi o lugar e a sua
  // disponibilidade de sexta". Ele tem que ver o que aconteceu de fato.
  if (p.startsWith('/api/self/lugar/') && method === 'DELETE') {
    const r = apagarLugar(decodeURIComponent(p.slice('/api/self/lugar/'.length)))
    broadcast({ t: 'state' })
    json(res, 200, { ok: true, ...r })
    return true
  }

  // ---------------- períodos ----------------
  if (p === '/api/self/periodo' && method === 'POST') {
    const b = await body()
    try {
      const id = salvarPeriodo({ id: b.id, de: b.de, ate: b.ate, tipo: b.tipo, lugarId: b.lugarId, titulo: b.titulo, eventId: b.eventId })
      logEvent({ type: 'periodo_salvo', detail: `${b.de} a ${b.ate}: ${b.tipo === 'ocupado' ? 'ocupado' : 'em outro lugar'}` })
      broadcast({ t: 'state' })
      json(res, 200, { ok: true, id })
    } catch (e) { json(res, 400, { error: e.message }) }
    return true
  }
  if (p.startsWith('/api/self/periodo/evento/') && method === 'GET') {
    json(res, 200, { periodo: periodoDoEvento(decodeURIComponent(p.slice('/api/self/periodo/evento/'.length))) })
    return true
  }
  if (p.startsWith('/api/self/periodo/') && method === 'DELETE') {
    apagarPeriodo(decodeURIComponent(p.slice('/api/self/periodo/'.length)))
    broadcast({ t: 'state' })
    json(res, 200, { ok: true })
    return true
  }

  return false
}
