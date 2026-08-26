// O orquestrador: recebe uma mensagem do dono (do self-chat ou do painel), pensa, executa
// e responde. É o único lugar que fecha o ciclo, e a ordem importa:
//   1. grava o que ele falou      (sem isso, um erro no meio perde a mensagem)
//   2. pensa com o estado atual
//   3. executa as ações           (leitura devolve dado; escrita age com desfazer;
//                                  externa/sistema viram pendência, nunca efeito)
//   4. se houve leitura, pensa de novo com os dados na mão (no máximo uma volta)
//   5. o COMPROVANTE é escrito por código, não pelo modelo
//   6. grava e entrega
import {
  addAssistMsg, assistMsgs, addAssistAcao, setAssistAcaoEstado, getAssistAcao, assistAcoes,
  ultimaAcaoDesfazivel, addPermissao, getPermissao, decidirPermissao, permissoesPendentes, logEvent, setSetting,
} from '../core/db.mjs'
import { ACOES, executarDesfazer } from './acoes.mjs'
import { estadoAgora } from './contexto.mjs'
import { pensar, historicoTexto } from './cerebro.mjs'
import { enviarNoSelfChat, enviarEnqueteNoSelfChat, disjuntorAberto, assistenteLigado, mostrarDigitando } from './canal.mjs'
import { rodarComando, lerArquivo } from './sistema.mjs'
import { interruptorDeModo, modoAtual, definirModo, limparThread, pensarCodex } from './codex-modo.mjs'
import { pediuAjuda, comoTexto as atalhosTexto } from './atalhos.mjs'
import { definirProvedor, provedorAtivo, disponiveis as iaDisponiveis, PROVEDORES } from '../ai/ia.mjs'
import { aplicar } from './aplicar.mjs'
import { gatilhoDeVideo, pediuComoArquivo } from '../midia/video.mjs'

const MAX_HISTORICO = 16

// O interruptor por texto: "ia off" desliga, "ia on" liga. É lido ANTES de qualquer
// outra coisa e NÃO passa pelo modelo, por dois motivos que são o ponto da feature:
//   1. com a IA desligada o cérebro nem é chamado — se o "ia on" dependesse dele, só
//      daria pra religar pelo painel;
//   2. "ia off" é freio de mão: tem que funcionar mesmo com o disjuntor aberto, mesmo
//      com o Codex fora do ar, mesmo no meio de uma bagunça.
export function interruptorDeTexto(texto) {
  const t = String(texto || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // "iá"/"ligá" não podem escapar
    .replace(/^[/!.]+/, '')                              // aceita "/ia off"
    .replace(/\s+/g, ' ')
  if (/^ia (on|liga|ligar|ligada|ligado|volta|voltar)$/.test(t)) return 'on'
  if (/^ia (off|desliga|desligar|desligada|desligado|para|parar|pausa|pausar)$/.test(t)) return 'off'
  return null
}

// Troca QUAL IA roda tudo. Lido antes do modelo, como os outros interruptores — e pelo mesmo
// motivo: se o provedor ativo estiver fora do ar, a única forma de voltar pro outro não pode
// depender dele responder.
export function interruptorDeIa(texto) {
  const t = String(texto || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^[/!.]+/, '').replace(/\s+/g, ' ')
  if (/^ia (claude|anthropic)$/.test(t)) return 'claude'
  if (/^ia (openai|codex|open ai)$/.test(t)) return 'codex'
  return null
}

// Executa uma ação do catálogo e devolve o que aconteceu, já registrado no banco.
// Exportada como executarAcao: é por aqui que o MODO CÓDEX alcança o catálogo do assistente
// (tools/acao.mjs -> POST /api/assistente/acao). Um executor só pros dois modos — se o
// códex tivesse o próprio, os dois iam divergir e um deles ficaria sem desfazer.
// Passa por `tratar` e não por `executarUma` de propósito: assim o códex também alcança as
// meta (desfazer/confirmar/cancelar), que são do orquestrador e não do catálogo.
export async function executarAcao({ acao, msgId = null, ctx }) { return tratar({ acao, msgId, ctx }) }
async function executarUma({ acao, msgId, ctx }) {
  const def = ACOES[acao.nome]
  if (!def) {
    logEvent({ type: 'assistente_acao_desconhecida', detail: acao.nome })
    return { tipo: 'erro', texto: `não conheço a ação "${acao.nome}"` }
  }

  // ---- leitura: executa e devolve o dado pro segundo turno
  if (def.nivel === 'leitura') {
    try {
      const r = await def.executar(acao.args || {}, ctx)
      return { tipo: 'leitura', nome: acao.nome, dados: r?.dados || '' }
    } catch (e) {
      return { tipo: 'leitura', nome: acao.nome, dados: `falhou: ${e.message}` }
    }
  }

  // ---- escrita: age agora, com plano de volta gravado
  if (def.nivel === 'escrita') {
    try {
      const r = await def.executar(acao.args || {}, ctx)
      const id = addAssistAcao({
        msgId, nome: acao.nome, args: acao.args, nivel: 'escrita', estado: 'feita',
        resumo: r.resumo, resultado: r.resultado || null, desfazer: r.desfazer || null,
      })
      logEvent({ type: 'assistente_fez', detail: `${acao.nome}: ${r.resumo}` })
      return { tipo: 'feito', id, texto: r.resumo, temDesfazer: !!r.desfazer }
    } catch (e) {
      // Ambiguidade não é erro: é uma pergunta. As ações resolvem a pessoa na PRIMEIRA
      // linha, então quando isto estoura nada foi tocado e dá pra guardar e perguntar.
      if (e.name === 'PessoaAmbigua') return pedirEscolha({ acao, msgId, erro: e })
      addAssistAcao({ msgId, nome: acao.nome, args: acao.args, nivel: 'escrita', estado: 'erro', erro: e.message })
      logEvent({ type: 'assistente_falhou', detail: `${acao.nome}: ${e.message}` })
      return { tipo: 'erro', texto: `não consegui: ${e.message}` }
    }
  }

  // ---- externa: NUNCA executa aqui. Vira pendência e espera o sim dele.
  if (def.nivel === 'externa') {
    try {
      const prep = await def.preparar(acao.args || {}, ctx)
      const id = addAssistAcao({ msgId, nome: acao.nome, args: { ...acao.args, ...prep.dados }, nivel: 'externa', estado: 'pendente', resumo: prep.resumo })
      return { tipo: 'pendente', id, texto: prep.resumo }
    } catch (e) {
      // Idem: a mensagem nem chegou a ser preparada, então perguntar é gratuito. É aqui que
      // mora o caso que motivou tudo — "avise o contato_teste_p" com dois contatos de teste homônimos no banco.
      if (e.name === 'PessoaAmbigua') return pedirEscolha({ acao, msgId, erro: e })
      return { tipo: 'erro', texto: `não consegui preparar: ${e.message}` }
    }
  }

  // ---- sistema: vira pedido de permissão (decisão 3 do dono)
  if (def.nivel === 'sistema') {
    try {
      const prep = await def.preparar(acao.args || {}, ctx)
      const permId = addPermissao({ tipo: acao.nome, alvo: prep.dados.comando || prep.dados.caminho || '', motivo: prep.dados.motivo || '' })
      const id = addAssistAcao({ msgId, nome: acao.nome, args: { ...prep.dados, permissaoId: permId }, nivel: 'sistema', estado: 'pendente', resumo: prep.resumo })
      return { tipo: 'permissao', id, permId, texto: prep.resumo }
    } catch (e) {
      return { tipo: 'erro', texto: `não consegui preparar: ${e.message}` }
    }
  }

  return { tipo: 'erro', texto: `ação "${acao.nome}" sem nível conhecido` }
}

// Executa uma pendência que ele acabou de autorizar.
export async function confirmarPendencia(id, ctx) {
  const a = id ? getAssistAcao(id) : (assistAcoes({ estado: 'pendente', limit: 1 })[0] || null)
  if (!a || a.estado !== 'pendente') return { ok: false, texto: 'não achei nada esperando confirmação' }
  const args = JSON.parse(a.args || '{}')

  if (a.nivel === 'externa' && a.nome === 'responder_pessoa') {
    try {
      const r = await ctx.enviarParaPessoa({ personId: args.personId, canal: args.canal, texto: args.texto })
      setAssistAcaoEstado(a.id, 'feita', { resultado: r })
      logEvent({ type: 'assistente_enviou', personId: args.personId, channel: args.canal, detail: String(args.texto).slice(0, 120) })
      return { ok: true, texto: `mandei: ${a.resumo}` }
    } catch (e) {
      setAssistAcaoEstado(a.id, 'erro', { erro: e.message })
      return { ok: false, texto: `não consegui mandar: ${e.message}` }
    }
  }

  if (a.nivel === 'sistema') {
    if (args.permissaoId) decidirPermissao(args.permissaoId, 'aprovada')
    const r = a.nome === 'ler_arquivo' ? await lerArquivo(args.caminho) : await rodarComando(args.comando)
    setAssistAcaoEstado(a.id, r.ok ? 'feita' : 'erro', { resultado: { saida: r.saida }, erro: r.ok ? null : 'falhou' })
    if (args.permissaoId) decidirPermissao(args.permissaoId, r.ok ? 'aprovada' : 'negada', r.saida)
    return { ok: r.ok, texto: r.ok ? `rodei. saída:\n${r.saida}` : `deu erro:\n${r.saida}`, saida: r.saida }
  }

  return { ok: false, texto: 'essa pendência eu não sei executar' }
}

export function cancelarPendencia(id) {
  const a = id ? getAssistAcao(id) : (assistAcoes({ estado: 'pendente', limit: 1 })[0] || escolhaAberta() || null)
  // 'desambiguando' também cancela: uma pergunta "qual contato_teste_p?" esquecida em aberto é uma
  // ação armada esperando um "1" que ele pode digitar por outro motivo.
  if (!a || !['pendente', 'desambiguando'].includes(a.estado)) return { ok: false, texto: 'não tinha nada pendente' }
  const args = JSON.parse(a.args || '{}')
  if (args.permissaoId) decidirPermissao(args.permissaoId, 'negada')
  setAssistAcaoEstado(a.id, 'cancelada')
  return { ok: true, texto: `cancelado: ${a.resumo}` }
}

export async function desfazerAcao(id) {
  const a = id ? getAssistAcao(id) : ultimaAcaoDesfazivel()
  if (!a) return { ok: false, texto: 'não tem nada pra desfazer' }
  if (a.estado === 'desfeita') return { ok: false, texto: 'isso já tinha sido desfeito' }
  if (!a.desfazer) return { ok: false, texto: `"${a.resumo}" não tem volta automática` }
  try {
    const texto = await executarDesfazer(JSON.parse(a.desfazer))
    setAssistAcaoEstado(a.id, 'desfeita')
    logEvent({ type: 'assistente_desfez', detail: `${a.nome}: ${a.resumo}` })
    return { ok: true, texto: `desfeito: ${texto}` }
  } catch (e) {
    return { ok: false, texto: `não consegui desfazer: ${e.message}` }
  }
}

// Monta o comprovante — escrito por CÓDIGO, com o que de fato aconteceu.
function comprovante(resultados) {
  const linhas = []
  for (const r of resultados) {
    if (r.tipo === 'feito') linhas.push(`feito: ${r.texto}`)
    else if (r.tipo === 'erro') linhas.push(`não rolou: ${r.texto}`)
    else if (r.tipo === 'pendente') linhas.push(`esperando seu ok: ${r.texto}`)
    else if (r.tipo === 'permissao') linhas.push(`preciso da sua permissão: ${r.texto}`)
    // A enquete é que faz a pergunta; a linha existe pra não parecer que a ação foi feita
    // (o modelo pode ter dito "beleza, mandando" antes de saber que havia dois).
    else if (r.tipo === 'desambiguar') linhas.push(`tem mais de um "${r.termo}" aqui — te mandei as opções`)
    else if (r.tipo === 'meta') linhas.push(r.texto)
  }
  return linhas
}

// ---------------------------------------------------------------- o ciclo
// ctx = { accountKey, sock, broadcast, enviarParaPessoa }
export async function conversar({ texto, origem = 'painel', waMsgId = null, ctx }) {
  const mensagem = String(texto || '').trim()
  if (!mensagem) return { ok: false, motivo: 'vazio' }

  // "?" ANTES DE TUDO, inclusive antes do portão de ligado/desligado. O momento em que ele
  // mais precisa da lista é justamente quando me desligou e não lembra como religar — uma
  // ajuda que só funciona com o sistema de pé não serve. Custo: zero token.
  if (pediuAjuda(mensagem)) {
    addAssistMsg({ papel: 'humano', origem, texto: mensagem, waMsgId })
    const resposta = atalhosTexto()
    await entregar({ texto: resposta, origem, ctx })
    return { ok: true, resposta, atalhos: true, acoes: [] }
  }

  // Troca de IA (OpenAI <-> Claude). Vale pra tudo: clone, assistente, extratores e códex.
  const trocaIa = interruptorDeIa(mensagem)
  if (trocaIa) {
    addAssistMsg({ papel: 'humano', origem, texto: mensagem, waMsgId })
    let resposta
    if (trocaIa === provedorAtivo()) resposta = `já tô rodando em ${PROVEDORES[trocaIa].nome}`
    else {
      const d = await iaDisponiveis().catch(() => null)
      if (trocaIa === 'claude' && d && !d.claude.pronto) resposta = `não dá pra trocar: ${d.claude.falta}`
      else {
        definirProvedor(trocaIa)
        resposta = `agora tudo roda em ${PROVEDORES[trocaIa].nome}, usando ${PROVEDORES[trocaIa].conta}`
        // O aviso vive AQUI, e não só no doc, porque doc depende de alguém lembrar de ler —
        // e o momento em que isso importa é exatamente este. Combinado em 26/07/2026:
        // trocar é livre; deixar o CLONE em produção noutro provedor sem passar pelo golden
        // set, não. Ver docs/PENDENCIAS.md §0.
        if (trocaIa !== 'codex') resposta += '\n\nisso inclui a IA que escreve pras pessoas com o seu nome. antes de deixar assim em produção: node baseline/comparar.mjs (24 cenários, 72 gerações). ver docs/PENDENCIAS.md §0'
      }
    }
    await entregar({ texto: resposta, origem, ctx })
    return { ok: true, resposta, ia: provedorAtivo(), acoes: [] }
  }

  // Interruptor por texto — antes dos portões, de propósito (ver interruptorDeTexto).
  const chave = interruptorDeTexto(mensagem)
  if (chave) {
    const ligando = chave === 'on'
    const jaEstava = assistenteLigado() === ligando
    setSetting('assistente_enabled', ligando)
    addAssistMsg({ papel: 'humano', origem, texto: mensagem, waMsgId })
    const resposta = ligando
      ? (jaEstava ? 'já tava ligada' : 'liguei, tô aqui')
      : (jaEstava ? 'já tava desligada, manda "ia on" pra voltar' : 'desliguei. manda "ia on" quando quiser de volta')
    if (origem === 'whatsapp') {
      try { await enviarNoSelfChat({ sock: ctx.sock, accountKey: ctx.accountKey, texto: resposta, origem: 'whatsapp' }) }
      catch (e) { logEvent({ type: 'assistente_envio_erro', detail: e.message }); addAssistMsg({ papel: 'vendas-multicanal', origem: 'painel', texto: resposta }) }
    } else {
      addAssistMsg({ papel: 'vendas-multicanal', origem, texto: resposta })
    }
    logEvent({ type: ligando ? 'assistente_ligado' : 'assistente_desligado', detail: `por "${mensagem}"` })
    if (ctx.broadcast) ctx.broadcast({ t: 'assistente' })
    return { ok: true, resposta, interruptor: chave, acoes: [] }
  }

  if (!assistenteLigado()) return { ok: false, motivo: 'desligado' }
  if (disjuntorAberto()) return { ok: false, motivo: 'disjuntor' }

  // Troca de modo: também ANTES do modelo, pelo mesmo motivo do "ia off". Um modo que só
  // dá pra sair pedindo pro modelo sair é um modo do qual não se sai quando ele trava.
  const trocaDeModo = interruptorDeModo(mensagem)
  if (trocaDeModo) {
    addAssistMsg({ papel: 'humano', origem, texto: mensagem, waMsgId })
    let resposta
    if (trocaDeModo === 'limpar') { limparThread(); resposta = 'contexto do códex zerado. próxima mensagem começa do zero' }
    else if (trocaDeModo === modoAtual()) resposta = trocaDeModo === 'codex' ? 'já tô em modo códex' : 'já tô no modo normal'
    else {
      definirModo(trocaDeModo)
      resposta = trocaDeModo === 'codex'
        ? 'modo códex. tô dentro da VM, no /opt/vendas-multicanal/app, com o código na mão. manda o que é pra fazer. "aplicar" roda os testes e sobe. "modo normal" pra sair'
        : 'voltei pro normal'
    }
    await entregar({ texto: resposta, origem, ctx })
    return { ok: true, resposta, modo: modoAtual(), acoes: [] }
  }

  // "baixa esse vídeo <link>" — GATILHO, lido ANTES do modelo e ANTES da bifurcação de modo.
  // Fica aqui em cima por três motivos: (1) no modo códex o catálogo de ações não é
  // alcançável (o sandbox do agente não tem rede: `curl` pro núcleo devolve http=000, medido
  // na VM em 29/07/2026), e sem isto a mesma frase funcionaria no modo normal e falharia no
  // códex — pior tipo de comportamento, o que depende de um estado que ele não vê; (2) pedido
  // com link é inequívoco e não precisa de modelo pra ser entendido; (3) custa zero token,
  // pra sempre. O efeito passa pelo executarAcao de sempre, então registro, comprovante e
  // Diário continuam idênticos aos de qualquer outra ação — só o caminho até ele é mais curto.
  const linkVideo = gatilhoDeVideo(mensagem)
  if (linkVideo) {
    const msgId = addAssistMsg({ papel: 'humano', origem, texto: mensagem, waMsgId })
    if (ctx.broadcast) ctx.broadcast({ t: 'assistente' })
    const pararDigitando = origem === 'whatsapp' ? mostrarDigitando({ sock: ctx.sock, accountKey: ctx.accountKey }) : null
    try {
      const formato = pediuComoArquivo(mensagem) ? 'arquivo' : 'video'
      const r = await executarAcao({ acao: { nome: 'baixar_video', args: { link: linkVideo, formato } }, msgId, ctx })
      const texto = r.texto || (r.tipo === 'feito' ? 'baixei' : 'não consegui baixar esse vídeo')
      await entregar({ texto, origem, ctx, acoes: r.id ? [r.id] : null })
      return { ok: r.tipo === 'feito', resposta: texto, gatilho: 'baixar_video', acoes: [] }
    } finally { if (pararDigitando) await pararDigitando() }
  }

  // ---- modo códex: o agente que mexe no próprio código. Caminho separado de propósito —
  // nada do catálogo de ações do assistente passa por aqui, e vice-versa.
  if (modoAtual() === 'codex') return conversarCodex({ mensagem, origem, waMsgId, ctx })

  const msgId = addAssistMsg({ papel: 'humano', origem, texto: mensagem, waMsgId })
  if (ctx.broadcast) ctx.broadcast({ t: 'assistente' })

  // Ele está respondendo "qual contato_teste_p?" — isso não passa pelo modelo. O casamento é com os
  // rótulos que nós geramos, então a escolha dele vira personId sem ninguém adivinhar nada.
  // Se a mensagem não for uma resposta à pergunta, casarEscolha devolve null e a vida segue.
  const aberta = escolhaAberta()
  if (aberta) {
    const escolha = casarEscolha(mensagem, aberta.dados.candidatos || [])
    if (escolha === 'desistiu') {
      setAssistAcaoEstado(aberta.id, 'cancelada')
      const t = 'beleza, deixa pra lá'
      await entregar({ texto: t, origem, ctx })
      return { ok: true, resposta: t, acoes: [] }
    }
    if (escolha) {
      setAssistAcaoEstado(aberta.id, 'feita', { resultado: { personId: escolha.personId, rotulo: escolha.rotulo } })
      const acao = { nome: aberta.dados.acao, args: { ...(aberta.dados.argsOriginais || {}), __personId: escolha.personId } }
      const r = await tratar({ acao, msgId, ctx })
      const linhas = comprovante([r])
      const t = linhas.join('\n') || 'escolhido'
      await entregar({ texto: t, origem, ctx, acoes: r.id ? [r.id] : null })
      return { ok: true, resposta: t, acoes: [r] }
    }
  }
  // "digitando..." no WhatsApp enquanto o turno roda — o silêncio de 6-12s parecia que
  // ninguém tinha lido. Só enfeite: se falhar, a resposta segue igual.
  const pararDigitando = origem === 'whatsapp' ? mostrarDigitando({ sock: ctx.sock, accountKey: ctx.accountKey }) : null

  let resposta = ''
  let enquete = null
  const resultados = []
  // Costura de teste: os testes injetam um cérebro determinístico pra provar o ciclo
  // (execução, comprovante, desfazer, pendências) sem depender do modelo. Em produção
  // ctx.pensar não existe e este é o cérebro de verdade.
  const pensarFn = ctx.pensar || pensar
  try {
    const estado = await estadoAgora({ accountKey: ctx.accountKey })
    const historico = historicoTexto(assistMsgs(MAX_HISTORICO).filter((m) => m.id !== msgId))

    const t1 = await pensarFn({ estado, historico, mensagem })
    resposta = t1.resposta
    enquete = t1.enquete || null

    const leituras = []
    for (const acao of t1.acoes) {
      const r = await tratar({ acao, msgId, ctx })
      if (r.tipo === 'leitura') leituras.push(`[${r.nome}]\n${r.dados}`)
      else resultados.push(r)
    }

    // Uma única volta: com os dados na mão o modelo compõe a resposta de verdade.
    if (leituras.length) {
      const t2 = await pensarFn({ estado, historico, mensagem, dadosDeLeitura: leituras.join('\n\n') })
      resposta = t2.resposta || resposta
      if (t2.enquete) enquete = t2.enquete
      for (const acao of t2.acoes) {
        if (ACOES[acao.nome]?.nivel === 'leitura') continue // sem laço de consulta
        resultados.push(await tratar({ acao, msgId, ctx }))
      }
    }
  } catch (e) {
    logEvent({ type: 'assistente_erro', detail: e.message })
    resposta = `deu ruim aqui do meu lado: ${e.message}`
  }

  // A pergunta "qual dos dois?" vence qualquer enquete que o modelo tenha inventado: ela
  // está no caminho de uma ação que ficou parada esperando resposta.
  const amb = resultados.find((r) => r.tipo === 'desambiguar')
  if (amb) enquete = amb.enquete

  const linhas = comprovante(resultados)
  const final = [resposta, linhas.length ? linhas.join('\n') : null].filter(Boolean).join('\n')
  const idsAcoes = resultados.map((r) => r.id).filter(Boolean)

  if (origem === 'whatsapp') {
    // Se o envio falhar (WhatsApp fora do ar), a resposta não pode sumir: registra do
    // mesmo jeito, pra ele achar no painel.
    try {
      // Se tem comprovante/texto, manda antes; a enquete (quando houver) é a pergunta.
      if (final && final.trim()) await enviarNoSelfChat({ sock: ctx.sock, accountKey: ctx.accountKey, texto: final, origem: 'whatsapp', acoes: idsAcoes })
      if (enquete) await enviarEnqueteNoSelfChat({ sock: ctx.sock, accountKey: ctx.accountKey, pergunta: enquete.pergunta, opcoes: enquete.opcoes, multipla: enquete.multipla })
    } catch (e) {
      logEvent({ type: 'assistente_envio_erro', detail: e.message })
      if (final && final.trim()) addAssistMsg({ papel: 'vendas-multicanal', origem: 'painel', texto: final, acoes: idsAcoes })
    }
    if (pararDigitando) await pararDigitando()
  } else {
    if (final && final.trim()) addAssistMsg({ papel: 'vendas-multicanal', origem, texto: final, acoes: idsAcoes })
    // No painel a enquete vira texto numerado (o painel não renderiza poll do WhatsApp).
    if (enquete) addAssistMsg({ papel: 'vendas-multicanal', origem, texto: `${enquete.pergunta}\n${enquete.opcoes.map((o, i) => `${i + 1}. ${o}`).join('\n')}` })
  }
  if (ctx.broadcast) ctx.broadcast({ t: 'assistente' })
  return { ok: true, resposta: final, acoes: resultados }
}

// Entrega uma resposta pro dono pelo canal de onde veio. Um lugar só, porque o modo códex
// e o assistente têm que falhar igual: se o WhatsApp cair, a resposta ainda fica no painel.
async function entregar({ texto, origem, ctx, acoes = null }) {
  if (origem !== 'whatsapp') { addAssistMsg({ papel: 'vendas-multicanal', origem, texto, acoes }); if (ctx?.broadcast) ctx.broadcast({ t: 'assistente' }); return }
  try { await enviarNoSelfChat({ sock: ctx.sock, accountKey: ctx.accountKey, texto, origem: 'whatsapp', acoes }) }
  catch (e) { logEvent({ type: 'assistente_envio_erro', detail: e.message }); addAssistMsg({ papel: 'vendas-multicanal', origem: 'painel', texto, acoes }) }
  if (ctx?.broadcast) ctx.broadcast({ t: 'assistente' })
}

// ---------------------------------------------------------------- o ciclo do modo códex
// Muito mais simples que o do assistente, e isso é intencional: aqui não existe catálogo de
// ações, comprovante nem desfazer. O agente age direto no disco (dentro da cerca do sandbox)
// e o texto dele É a resposta. O único caminho determinístico é "aplicar".
async function conversarCodex({ mensagem, origem, waMsgId, ctx }) {
  addAssistMsg({ papel: 'humano', origem, texto: mensagem, waMsgId })
  if (ctx.broadcast) ctx.broadcast({ t: 'assistente' })
  const pararDigitando = origem === 'whatsapp' ? mostrarDigitando({ sock: ctx.sock, accountKey: ctx.accountKey }) : null

  const cmd = String(mensagem).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^[/!.]+/, '')
  try {
    // "aplicar" nunca passa pelo modelo: é o portão (testes verdes -> reinício destacado).
    if (/^(aplicar|aplica|sobe|subir|deploy)$/.test(cmd)) {
      const r = await aplicar({ avisar: (t) => entregar({ texto: t, origem, ctx }) })
      return { ok: true, resposta: r.texto, modo: 'codex', acoes: [] }
    }
    const r = await (ctx.pensarCodex || pensarCodex)({ mensagem })
    const texto = String(r.text || '').trim() || 'terminei o turno sem nada pra dizer'
    logEvent({ type: 'codex_turno', detail: `${mensagem.slice(0, 80)} -> ${texto.slice(0, 120)}` })
    await entregar({ texto, origem, ctx })
    return { ok: true, resposta: texto, modo: 'codex', acoes: [] }
  } catch (e) {
    const texto = `o códex deu erro: ${e.message}`
    logEvent({ type: 'codex_erro', detail: e.message })
    await entregar({ texto, origem, ctx })
    return { ok: false, resposta: texto, modo: 'codex', acoes: [] }
  } finally {
    if (pararDigitando) await pararDigitando()
  }
}

// ---------------------------------------------------------------- escolher qual pessoa
// Quando o nome que ele falou casa com mais de uma pessoa, nada é executado: a ação fica
// guardada em estado 'desambiguando' e vira uma ENQUETE. A escolha volta por três caminhos
// (voto no WhatsApp, número no painel, nome digitado) e todos passam por aqui — por isso o
// casamento é por CÓDIGO, comparando com os rótulos que nós mesmos geramos.
//
// Uma escolha aberta por vez, e ela expira: pergunta esquecida de ontem não pode
// sequestrar um "1" digitado hoje.
const JANELA_ESCOLHA_MS = 60 * 60 * 1000

const semAcento = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()

function perguntaDaEscolha(acao, termo) {
  const q = `qual "${termo}"?`
  if (acao.nome === 'responder_pessoa') {
    const t = String(acao.args?.texto || '').trim()
    return t ? `${q} (mensagem: "${t.slice(0, 120)}")` : q
  }
  if (acao.nome === 'ligar_ia') return `${q} (pra ligar a IA)`
  if (acao.nome === 'desligar_ia') return `${q} (pra desligar a IA)`
  if (acao.nome === 'mudar_modo') return `${q} (pra mudar o modo${acao.args?.modo ? ' pra ' + acao.args.modo : ''})`
  return q
}

// Guarda a ação inteira e devolve a enquete. A ação NÃO foi executada e não vai ser até
// ele escolher — é o ponto todo.
function pedirEscolha({ acao, msgId, erro }) {
  for (const a of assistAcoes({ estado: 'desambiguando', limit: 10 })) setAssistAcaoEstado(a.id, 'cancelada')
  const candidatos = erro.candidatos.map((c) => ({ personId: c.personId, rotulo: c.rotulo }))
  const resumo = `escolher qual "${erro.termo}" (${candidatos.length} pessoas com esse nome)`
  const id = addAssistAcao({
    msgId, nome: 'escolher_pessoa', nivel: 'meta', estado: 'desambiguando', resumo,
    args: { acao: acao.nome, argsOriginais: acao.args || {}, termo: erro.termo, candidatos },
  })
  logEvent({ type: 'assistente_ambiguidade', detail: `${acao.nome} "${erro.termo}": ${candidatos.map((c) => c.rotulo).join(' | ')}` })
  return {
    // candidatos com personId vão junto: quem chama pelo chat usa só os rótulos (a enquete),
    // mas o modo códex precisa do id pra repetir a ação já resolvida (--pessoa-id).
    tipo: 'desambiguar', id, texto: resumo, termo: erro.termo, candidatos,
    enquete: { pergunta: perguntaDaEscolha(acao, erro.termo), opcoes: candidatos.map((c) => c.rotulo), multipla: false },
  }
}

export function escolhaAberta() {
  const a = assistAcoes({ estado: 'desambiguando', limit: 1 })[0] || null
  if (!a) return null
  if (Date.now() - (a.ts || 0) > JANELA_ESCOLHA_MS) { setAssistAcaoEstado(a.id, 'cancelada'); return null }
  return { ...a, dados: JSON.parse(a.args || '{}') }
}

const DESISTIR = /^(nenhuma?|nenhum deles|nenhuma delas|cancela|cancelar|deixa|deixa pra la|esquece|esquece isso|nada disso)$/

// Esta mensagem é a resposta da escolha? Devolve o candidato, 'desistiu', ou null (e null
// significa "não é sobre isso" — a mensagem segue o fluxo normal, nada é sequestrado).
export function casarEscolha(mensagem, candidatos) {
  let m = String(mensagem || '').trim()
  // voto de enquete: chega como `escolhi na enquete "pergunta": opção`
  const voto = m.match(/^escolhi na enquete\s+"[\s\S]*?":\s*([\s\S]+)$/i)
  if (voto) m = voto[1].trim()
  const n = semAcento(m)
  if (!n) return null
  if (DESISTIR.test(n)) return 'desistiu'
  const rotulos = candidatos.map((c) => semAcento(c.rotulo))
  const iguais = rotulos.findIndex((r) => r === n)
  if (iguais >= 0) return candidatos[iguais]
  // número da lista (é assim que o painel mostra a enquete: 1., 2., 3.)
  const num = n.match(/^(?:opcao\s*)?(\d{1,2})[.)]?$/)
  if (num) { const i = Number(num[1]) - 1; if (i >= 0 && i < candidatos.length) return candidatos[i] }
  // rótulo inteiro dentro de uma frase ("manda pro fixture sintética - Empresa Exemplo — WhatsApp, ...")
  const contem = rotulos.map((r, i) => ({ i, r })).filter(({ r }) => r.length > 3 && n.includes(r))
  if (contem.length === 1) return candidatos[contem[0].i]
  // o NOME (parte antes do travessão do rótulo), quando só um bate: cobre ele digitando
  // "o contato teste da empresa" em vez de votar. Dois nomes iguais nunca chegam aqui: rotulosUnicos
  // já garantiu que os rótulos diferem, e por isso a checagem exige unicidade.
  const nomes = candidatos.map((c) => semAcento(String(c.rotulo).split(' — ')[0]))
  const porNome = nomes.map((x, i) => ({ i, x })).filter(({ x }) => x.length > 2 && (n === x || n.includes(x) || x.includes(n)))
  if (porNome.length === 1) return candidatos[porNome[0].i]
  return null
}

// Roteia uma ação: as meta (desfazer/confirmar/cancelar) são do orquestrador; o resto
// vai pro executor do catálogo.
async function tratar({ acao, msgId, ctx }) {
  if (acao.nome === 'desfazer') { const r = await desfazerAcao(acao.args?.id || null); return { tipo: 'meta', texto: r.texto } }
  if (acao.nome === 'confirmar') { const r = await confirmarPendencia(acao.args?.id || null, ctx); return { tipo: 'meta', texto: r.texto } }
  if (acao.nome === 'cancelar') { const r = cancelarPendencia(acao.args?.id || null); return { tipo: 'meta', texto: r.texto } }
  return executarUma({ acao, msgId, ctx })
}

export { permissoesPendentes, assistAcoes }
