// Rotas do assistente. Mesmo contrato dos outros módulos: devolve true se tratou.
// A aba do painel e a barra de comando falam só com isto.
import { assistMsgs, assistAcoes, getSetting, setSetting, permissoesPendentes, acoesDaMensagem } from '../core/db.mjs'
import { conversar, desfazerAcao, confirmarPendencia, cancelarPendencia, executarAcao } from './conversa.mjs'
import { ACOES } from './acoes.mjs'
import { enviarEnqueteNoSelfChat } from './canal.mjs'
import { proativoConfig } from './contexto.mjs'
import { textoDoDia } from './proativo.mjs'

function serializaMsg(m) {
  return {
    id: m.id, ts: m.ts, papel: m.papel, origem: m.origem, texto: m.texto,
    acoes: acoesDaMensagem(m.id).map((a) => ({
      id: a.id, nome: a.nome, nivel: a.nivel, estado: a.estado, resumo: a.resumo,
      temDesfazer: !!a.desfazer, resultado: a.resultado ? JSON.parse(a.resultado) : null, erro: a.erro || null,
    })),
  }
}

// UM pedido de ação, UM executor — venha ele do HTTP (painel, `tools/acao.mjs`) ou da fila de
// arquivo do modo códex (`src/assistente/ipc-acoes.mjs`, criada porque o sandbox do agente não
// tem rede nem loopback). Os dois canos desembocam aqui de propósito: catálogo, registro,
// comprovante, desambiguação e desfazer têm que ser os MESMOS, senão a resposta de um caminho
// mente sobre o outro. Devolve { ok, status, dados } — a forma que a fila também transporta.
export async function executarPedidoAcao(b, base) {
  const nome = String(b?.nome || '').trim()
  if (!ACOES[nome]) return { ok: false, status: 400, dados: { error: `ação desconhecida: ${nome}`, acoes: Object.keys(ACOES) } }
  const acao = { nome, args: b.args && typeof b.args === 'object' ? b.args : {} }
  if (b.pessoaId) acao.args.__personId = String(b.pessoaId)
  let r = await executarAcao({ acao, ctx: base })
  // --ja: o modo códex não faz o dono confirmar duas vezes. A ordem dele (26/07) é que
  // nada recuse caladinho quando ele pede — mas o registro (e o desfazer) continua igual.
  // A AMBIGUIDADE nunca é pulada por aqui: essa pergunta é sobre pontaria, não permissão.
  if (b.ja && r.tipo === 'pendente' && r.id) {
    const c = await confirmarPendencia(r.id, base)
    r = { ...r, tipo: c.ok ? 'feito' : 'erro', texto: c.texto, confirmadaNaHora: true }
  }
  return { ok: r.tipo !== 'erro', status: r.tipo === 'erro' ? 400 : 200, dados: r }
}

// ctx = { p, method, res, url, json, body, broadcast, account, sock, enviarParaPessoa }
export async function handleAssistenteApi(ctx) {
  const { p, method, res, json, body, broadcast, account } = ctx
  if (!p.startsWith('/api/assistente')) return false
  const base = { accountKey: account, sock: ctx.sock(), broadcast, enviarParaPessoa: ctx.enviarParaPessoa }

  if (p === '/api/assistente' && method === 'GET') {
    return json(res, 200, {
      ligado: getSetting('assistente_enabled', true) !== false,
      proativo: proativoConfig(),
      mensagens: assistMsgs(60).map(serializaMsg),
      pendentes: assistAcoes({ estado: 'pendente', limit: 10 }).map((a) => ({ id: a.id, nome: a.nome, nivel: a.nivel, resumo: a.resumo })),
      permissoes: permissoesPendentes().map((x) => ({ id: x.id, tipo: x.tipo, alvo: x.alvo, motivo: x.motivo })),
    }), true
  }

  // Manda uma ENQUETE de teste pro self-chat (prova o caminho poll: envio + guardar + voto).
  if (p === '/api/assistente/enquete-teste' && method === 'POST') {
    const b = await body()
    const r = await enviarEnqueteNoSelfChat({ sock: base.sock, accountKey: account, pergunta: b.pergunta || 'Teste: qual você prefere?', opcoes: Array.isArray(b.opcoes) ? b.opcoes : ['Opção A', 'Opção B', 'Opção C'], multipla: !!b.multipla })
    if (broadcast) broadcast({ t: 'assistente' })
    return json(res, 200, r), true
  }

  // O catálogo do assistente, executável de fora do chat. Existe pro MODO CÓDEX: o agente
  // tem shell, e `node tools/acao.mjs ...` cai aqui. Roda DENTRO do núcleo de propósito —
  // é este processo que tem o socket do WhatsApp e o enviarParaPessoa; um segundo processo
  // teria que abrir outro pareamento e derrubaria o primeiro.
  if (p === '/api/assistente/acao' && method === 'POST') {
    const b = await body()
    const r = await executarPedidoAcao(b, base)
    broadcast({ t: 'assistente' })
    return json(res, r.status, r.dados), true
  }

  if (p === '/api/assistente/falar' && method === 'POST') {
    const b = await body()
    const texto = String(b.texto || '').trim()
    if (!texto) return json(res, 400, { error: 'texto' }), true
    const r = await conversar({ texto, origem: 'painel', ctx: base })
    return json(res, r.ok ? 200 : 400, r), true
  }

  if (p === '/api/assistente/config' && method === 'POST') {
    const b = await body()
    if ('ligado' in b) setSetting('assistente_enabled', !!b.ligado)
    if (b.proativo && typeof b.proativo === 'object') {
      const mapa = {
        compromissos_do_dia: 'assistente_proativo_dia',
        alertas_de_sistema: 'assistente_proativo_alertas',
        avisos_de_resposta: 'assistente_proativo_respostas',
      }
      for (const [k, chave] of Object.entries(mapa)) if (k in b.proativo) setSetting(chave, !!b.proativo[k])
      if (b.proativo.hora_do_resumo && /^\d{1,2}:\d{2}$/.test(b.proativo.hora_do_resumo)) setSetting('assistente_proativo_hora', b.proativo.hora_do_resumo)
    }
    broadcast({ t: 'assistente' })
    return json(res, 200, { ok: true, ligado: getSetting('assistente_enabled', true) !== false, proativo: proativoConfig() }), true
  }

  // Prévia do resumo do dia (o botão "ver como fica" na configuração)
  if (p === '/api/assistente/resumo-do-dia' && method === 'GET') {
    return json(res, 200, { texto: await textoDoDia({ accountKey: account }) }), true
  }

  const m = p.match(/^\/api\/assistente\/acao\/([^/]+)\/(desfazer|confirmar|cancelar)$/)
  if (m && method === 'POST') {
    const id = decodeURIComponent(m[1])
    let r
    if (m[2] === 'desfazer') r = await desfazerAcao(id)
    else if (m[2] === 'confirmar') r = await confirmarPendencia(id, base)
    else r = cancelarPendencia(id)
    broadcast({ t: 'assistente' })
    return json(res, r.ok ? 200 : 400, r), true
  }

  return false
}
