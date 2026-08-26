// Motor de resposta automática. Geração paralela (cérebro) + envio idempotente (mão),
// por pessoa, com IA auto nascendo desligada. Mesmo motor serve Tinder e WhatsApp.
import crypto from 'node:crypto'
import {
  tinderMatches,
  getAiSetting,
  setAiSetting,
  getReceipt,
  saveReceipt,
  logEvent,
  getSetting,
  setSetting,
  recordTinderOutgoingMessage,
  nextTinderOpener,
  getTinderMatchState,
  getPersonObjective,
  listSavedAudios, listSavedImages,
  getTinderPerfil, setReplySchedule, soltarTentativa } from '../core/db.mjs'
import { buildReplyPrompt, parseGeneratedReply, MAX_BOLHAS } from '../ai/prompt.mjs'
import { perfilDoMatch } from './perfil.mjs'
import { buildSavedAudiosPrompt } from '../wa/saved-audio-ai.mjs'
import { buildSavedImagesPrompt, fotosParaPrompt } from '../wa/saved-image-ai.mjs'
import { etiquetaAbreFotoQuente } from '../self/etiquetas.mjs'
import { replyGate } from '../ai/cadence.mjs'
import { iaPausada, pausa as pausaAtual } from '../ai/cota.mjs'
import { getCodex, readCommunicationProfile } from '../ai/codex.mjs'
import { readMode } from '../ai/modos.mjs'
import { janelaAberta, blocoComNecessidades, marcarContado, rascunhoTocouNoAssunto } from '../ai/assunto-grana.mjs'
import { blocoCadenciaQuente, marcarPapoQuente, ehExplicito } from '../ai/cadencia-quente.mjs'
import { buildHistory, pendingFingerprint } from '../bridge/bridge.mjs'
import { redesAutorizadas, chamarLigado } from '../bridge/chamar.mjs'
import { meuContatoNaRede, registrarConviteDaSaida } from '../bridge/convites.mjs'
import { ensureAgendaFresh, agendaBlock, ocupacaoAgenda } from '../agenda/context.mjs'
import { projectsBlock } from '../projects/context.mjs'
import { fatosBlock, registrarAssercao } from '../self/fatos.mjs'
import { encontrosBlock, proporDatesPessoa, temAlgumaJanela, marcarAtendimentoPessoa, temJanelaDeAtendimento } from '../self/encontros.mjs'
import { atendimentoDaConversa, ehClienteDeServico } from '../self/atendimento.mjs'
import { detectarNoHistorico } from '../self/blindagem.mjs'
import { memoriaBlock } from '../self/memoria-pessoa.mjs'
import { idadeBlock, perguntaramIdadeDela } from '../self/idade.mjs'
import { rotinaBlock } from '../self/rotina.mjs'
import { vinculoDaPessoa, moduloDoVinculo, vinculoContextoCurto, VINCULOS_ROMANTICOS, avisoDeVinculo } from '../self/vinculos.mjs'
import { otherIdFromMatch } from './api.mjs'
import { syncTinderMatchHistory } from './sync.mjs'
import { gerarResposta } from '../ai/ia.mjs'
import { avaliarRascunho, instrucaoDeCorrecao, anunciarBloqueio } from '../ai/filtro.mjs'
import { blocoDeSituacao, precisaDeIniciativa } from '../ai/conversa-estado.mjs'
import { jaDisseIsso, instrucaoDeNaoRepetir } from '../ai/repeticao.mjs'
import { soouEscrito, instrucaoDeFalarAssim } from '../ai/soou-escrito.mjs'
import { passouDoTamanho, instrucaoDeEncurtar, medirRascunho } from '../ai/tamanho-voz.mjs'
import { propoeEncontro, instrucaoSemEncontro } from '../ai/encontro-trava.mjs'
import { prometeMidia, instrucaoSemPromessa } from '../ai/promessa-midia.mjs'
import { blocoGenero, erroDeGenero, instrucaoDeGenero } from '../ai/genero.mjs'
import { assuntosLargados, instrucaoDeCobrirMais } from '../ai/cobertura.mjs'
import { cabeMaisUmaChamada } from '../ai/prazo.mjs'
import { blocoDeTecnica } from '../ai/tecnica.mjs'
import { lerPix, pixBlock, podeInformarPixNoTurno, pagamentoDeServicoNoTurno, cobrancaDaPessoa, ehCobrancaProativa, registrarCobrancaEnviada } from '../self/pix.mjs'
import { servicosBlock } from '../self/servicos.mjs'
import { reservarPedidoUnico, liberarPedidoUnico, concluirPedidoUnico, pedidoAguardandoDaPessoa, cobrancaQuerEsquentar, pedidoEsperandoSituacao, fingerprintIniciativaCobranca, deslizeAlmocoDaPessoa, falaColadaNaLinha, vaciloCobrancaBlock } from '../necessidades/pedido-unico.mjs'
import { caminhoDinheiro, padroesDinheiroBlock } from '../self/dinheiro-padroes.mjs'

export const textFp = (t) => 'tx-' + crypto.createHash('sha1').update((t || '').toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)

// Permissão de encontro é opt-in e falha fechada. Uma leitura quebrada de banco ou identidade
// não pode virar autorização implícita para assumir um compromisso na vida de outra pessoa.
function encontrosDesligados(personId) {
  try { return !proporDatesPessoa(personId) } catch { return true }
}

// Gera um rascunho para uma pessoa num canal. NÃO envia. Recusa reply sem histórico.
// chatMode (opcional): modo da conversa (amigo/romance/...) — aditivo; null = como antes.
// meta (opcional): objeto preenchido com o que entrou no contexto (ids dos fatos usados),
// pra quem envia registrar no ledger de asserções depois de a mensagem sair de verdade.
export async function generateDraft({
  personId,
  name,
  channel,
  profile,
  chatMode,
  mode: requestedMode,
  meta,
  manual = false,
  usageOrigin = null,
  usageTrigger = null,
}) {
  // ---- freio de cota (27/07/2026) ----
  // Com o provedor no talo, tentar de novo só queima o que sobrou e deixa a conversa muda.
  // `manual` é o botão que o dono apertou: ali quem decide é ele, e ele vê o erro na tela.
  if (!manual && iaPausada()) {
    const p = pausaAtual()
    const e = new Error(`IA pausada: ${p?.motivo || 'pausa manual'}`)
    e.iaPausada = true
    throw e
  }
  // ---- registro pela pessoa (o tagueamento das 294) ----
  // Modo manual da conversa continua mandando quando existe. Sem modo manual, o VÍNCULO
  // decide: não-romântico com módulo próprio -> registro do vínculo + núcleo de voz enxuto
  // (economia de ~3.700 tokens e vocabulário certo — o manual de paquera não fala com sócio).
  // Paquera/romance/sem-vínculo -> byte a byte o comportamento aprovado de hoje.
  const vinc = (() => { try { return vinculoDaPessoa(personId) } catch { return null } })()
  let modeProfile = await readMode(chatMode)
  let estiloEnxuto = false
  if (!modeProfile && vinc && !VINCULOS_ROMANTICOS.has(vinc.vinculo)) {
    const modulo = await moduloDoVinculo(vinc.vinculo)
    if (modulo) {
      const contexto = vinculoContextoCurto(vinc)
      modeProfile = contexto ? `${modulo}\n\nCONTEXTO DESTA RELAÇÃO: ${contexto}` : modulo
      estiloEnxuto = true
    }
  }
  // PARA ONDE LEVAR A CONVERSA. Uma fonte só: a mesma lista que decide onde o sistema abre
  // conversa (`chamar_redes`). Se o "chamar" está desligado ou nenhuma rede autorizada, isso
  // fica null e a linha some do prompt — o comportamento volta a ser exatamente o de antes.
  // Já estando NA rede preferida, também some: não faz sentido pedir Instagram no Instagram.
  const redePreferida = (() => {
    try {
      if (!chamarLigado()) return null
      const redes = redesAutorizadas()
      const alvo = redes.length === 1 ? redes[0] : null   // com 2+ autorizadas não há preferência a declarar
      return alvo && alvo !== channel ? alvo : null
    } catch { return null }
  })()

  // O contato DELA na rede preferida (o @ do Instagram, o número do WhatsApp). Sem sessão
  // conectada isso é null e a IA volta a PEDIR o contato em vez de passar o dela — nunca
  // inventa um contato.
  const meuContato = redePreferida ? meuContatoNaRede(redePreferida, accountKey) : null

  const cp = await readCommunicationProfile({ enxuto: estiloEnxuto })
  if (meta) meta.vinculo = vinc?.vinculo || null
  // Consciência da agenda: injeta os próximos compromissos do dono (cache curto).
  // Guardado por setting (default ligado); sem agenda conectada, agendaBlock() é ''.
  let agendaContext = ''
  if (getSetting('agenda_awareness', true)) { await ensureAgendaFresh(); agendaContext = agendaBlock() }
  // DATAS COMEMORATIVAS: escritas à mão pela dona, valem só NO DIA e não dependem do Google
  // estar conectado. Entram junto do bloco da agenda porque são a mesma conversa — o que o
  // dia de hoje tem de especial.
  try {
    const { comemorativasBlock } = await import('../agenda/comemorativas.mjs')
    const hoje = comemorativasBlock()
    if (hoje) agendaContext = [agendaContext, hoje].filter(Boolean).join('\n\n')
  } catch { /* data comemorativa nunca derruba a resposta */ }
  // Consciência dos projetos (aditivo/opt-in): '' quando não há projeto ativo -> prompt idêntico.
  const projectsContext = projectsBlock()
  // Rotina recorrente do dono (aditivo/opt-in): descreve o pano de fundo do horário atual,
  // mas não substitui agenda nem disponibilidade. Vazia, some por completo.
  let rotinaContext = ''
  try { rotinaContext = rotinaBlock() } catch { /* rotina nunca derruba uma resposta */ }
  // Objetivo por pessoa (aditivo/opt-in): vazio mantém o comportamento anterior intacto.
  const personObjective = getPersonObjective(personId)
  // Idade: fato calculado da data de nascimento do retrato (nunca escrito, nunca pedido ao
  // modelo). '' enquanto o retrato não declarar a data.
  let idade = ''
  try { idade = idadeBlock() } catch { /* idade nunca derruba a resposta */ }
  // Ritmo/descanso do papo quente: a régua de ir mais devagar, ou o descanso do dia seguinte.
  // Decisão determinística (conta os dias); o prompt só recebe o veredito.
  let cadenciaQuente = ''
  try { cadenciaQuente = blocoCadenciaQuente(personId, { ativo: chatMode === 'romance-quente' }) } catch { /* nunca derruba a resposta */ }
  // Áudios salvos (aditivo/opt-in — WhatsApp e Badoo): '' quando o setting está desligado,
  // não há áudio ativo, ou nenhum tem transcrição pronta -> prompt idêntico ao de antes.
  // Os dois canais têm entrega real de nota de voz; Tinder/Instagram ainda não.
  let savedAudios = ''
  if ((channel === 'whatsapp' || channel === 'badoo') && getSetting('saved_audio_ai', false)) {
    savedAudios = buildSavedAudiosPrompt(listSavedAudios({ activeOnly: true }))
  }
  // BANCO DE FOTOS (aditivo/opt-in). WhatsApp, Instagram, Telegram e Badoo têm envio
  // conferido (Badoo em src/badoo/foto.mjs, alvo conferido na página duas vezes).
  // NÃO vale no Tinder (não há envio de imagem lá).
  // `apenasLivres` é a trava do nível: a foto 'travada' nunca chega ao modelo, então ele não
  // tem como pedir o que não pode mandar.
  let savedImages = ''
  if ((channel === 'whatsapp' || channel === 'instagram' || channel === 'telegram' || channel === 'badoo') && getSetting('saved_image_ai', false)) {
    // `fotosParaPrompt` já traz o vínculo de necessidade resolvido: é ele que diz à IA que
    // aquela foto pertence a um assunto, e não à conversa em geral.
    // A etiqueta da pessoa decide se as fotos sensuais entram na lista. Sem etiqueta que
    // abra, ela só enxerga as fotos livres — e as de família, nunca.
    savedImages = buildSavedImagesPrompt(await fotosParaPrompt({ permitirQuente: etiquetaAbreFotoQuente(personId) }))
  }
  // Memória DA PESSOA (aditivo/opt-in): o resumo do que já rolou com ela em todos os
  // canais. Lida ANTES do histórico de propósito: quando a memória existe, o transcript
  // não precisa carregar a vida inteira — a memória cobre o que ficou pra trás e a janela
  // encolhe (economia de até ~9k tokens nas conversas grandes). Sem memória, janela cheia
  // e prompt idêntico ao de sempre. Reversível: setting `janela_com_memoria`.
  let memoriaPessoa = ''
  try { memoriaPessoa = memoriaBlock(personId) } catch { /* memória nunca derruba a resposta */ }
  const janelaReduzida = !!memoriaPessoa && getSetting('janela_com_memoria', true)
  const history = buildHistory(personId, name, { max: janelaReduzida ? 240 : 1000 })
  const maxTranscriptChars = janelaReduzida ? 16_000 : undefined
  const mode = requestedMode === 'opener' || requestedMode === 'reply'
    ? requestedMode
    : (history.messages.length ? 'reply' : 'opener')
  if (mode === 'reply' && !history.messages.length) throw new Error('sem histórico estruturado')
  // A chave é conhecimento da IA, mas a permissão para ESCREVÊ-LA dura só o turno em que a
  // pessoa pediu o PIX ou disse que vai mandar o dinheiro. O filtro final recebe a mesma
  // decisão determinística.
  const pix = lerPix()
  const cobranca = mode === 'reply' ? cobrancaDaPessoa(personId) : { cobrancaAutorizada: false, motivo: '' }
  const pedidoAguardando = mode === 'reply' ? pedidoAguardandoDaPessoa(personId) : null
  // A chave NÃO sai só porque a cobrança está ligada. Três tempos: situação, pedido, chave
  // se ela topar. Autorização sozinha libera contar o aperto, não o PIX.
  const etapaCobranca = pedidoAguardando?.etapa === 'chave' || pedidoAguardando?.etapa === 'pedir'
    ? pedidoAguardando.etapa
    : (cobranca.cobrancaAutorizada ? 'situacao' : null)
  const permitirCobrancaPix = false
  // DOIS DINHEIROS DIFERENTES (ordem dele, 15/08/2026). Cliente do trabalho pode receber o
  // preço e a forma de pagamento sem o "pode cobrar" ligado — esse interruptor é da
  // NECESSIDADE, que é ela pedindo ajuda a quem não comprou nada. Ver self/atendimento.mjs.
  // Duas condições, as duas determinísticas: é cliente (por etiqueta) e a fala DELE chegou no
  // pagamento. Nenhuma das duas é o modelo decidindo.
  const clienteDeServico = mode === 'reply' && ehClienteDeServico(personId)
  const pagandoServico = clienteDeServico && pagamentoDeServicoNoTurno(history.messages)
  let pixContext = pixBlock({
    cobrancaAutorizada: cobranca.cobrancaAutorizada,
    cobrancaMotivo: cobranca.motivo,
    etapa: etapaCobranca,
    incluirChave: false,
    pagamentoDeServico: pagandoServico,
    deslizeAlmoco: !pagandoServico && !!pedidoAguardando && deslizeAlmocoDaPessoa(personId),
  })
  const vacilo = mode === 'reply' ? vaciloCobrancaBlock(personId) : ''
  if (vacilo) pixContext = [vacilo, pixContext].filter(Boolean).join('\n')
  // Tabela de serviços: quanto ela cobra e por quanto tempo. Diferente do PIX, o gestor
  // autorizou a IA a puxar o assunto por iniciativa — o que a política proíbe é inventar
  // valor fora da tabela. Sem serviço cadastrado o bloco é vazio e o prompt não muda.
  // O ACIONAMENTO acontece aqui: serviço com etiqueta só entra se ESTA pessoa tiver a
  // etiqueta, e serviço com palavra só entra se ela apareceu no turno recebido agora. Serviço
  // sem gatilho continua sempre visível. É filtro determinístico — o modelo nunca decide se
  // um serviço "vale" para esta conversa, ele só recebe o que passou.
  let servicosContext = ''
  let etiquetasContext = ''
  let turnoTexto = ''
  let etiquetasDaPessoa = []
  try {
    const turno = []
    for (let i = (history.messages || []).length - 1; i >= 0; i--) {
      const m = history.messages[i]
      if (m?.direction !== 'incoming') break
      turno.unshift(m?.text || '')
    }
    turnoTexto = turno.join(' ')
    let etiquetas = []
    try { const E = await import('../self/etiquetas.mjs'); etiquetas = E.etiquetasDaPessoa(personId) } catch { /* sem etiquetas, sem filtro */ }
    etiquetasDaPessoa = etiquetas
    let datasDeHoje = []
    try { const C = await import('../agenda/comemorativas.mjs'); datasDeHoje = C.servicosDeHoje() } catch { /* sem data, sem serviço do dia */ }
    servicosContext = servicosBlock({ etiquetasDaPessoa: etiquetas, textoRecebido: turnoTexto, datasDeHoje })
    try { const E = await import('../self/etiquetas.mjs'); etiquetasContext = E.blocoComportamento(etiquetas) } catch { /* sem tom, o prompt não muda */ }
  } catch { /* tabela nunca derruba a resposta */ }

  // PERGUNTARAM A IDADE E O RETRATO NÃO TEM A DATA. A IA vai desconversar — está certo, fato
  // que não existe não se inventa — mas isso não pode acontecer em silêncio: na instancia-b duas
  // pessoas perguntaram em dois dias, as duas levaram "essa parte te conto depois", e o
  // retrato seguiu vazio porque ninguém ficou sabendo. Uma linha por dia no Diário, com a
  // receita do conserto. Ver src/self/idade.mjs.
  try {
    if (mode === 'reply' && !idade && perguntaramIdadeDela(turnoTexto)) {
      const hojeBr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
      if (getSetting('idade_faltando_avisada_em', null) !== hojeBr) {
        setSetting('idade_faltando_avisada_em', hojeBr)
        logEvent({ type: 'identidade_faltando', personId, channel,
          detail: 'perguntaram a idade e o retrato não tem "Nascimento: AAAA-MM-DD" — a IA vai desconversar até a data ser escrita em quem-eu-sou.md' })
      }
    }
  } catch { /* o aviso nunca derruba a resposta */ }
  const permitirInformarPix = mode === 'reply' && (podeInformarPixNoTurno(history.messages) || pagandoServico)

  // PEDIDO ÚNICO. A reserva é atômica (uma rede só). A CHAVE continua fala
  // exata — número errado não se improvisa. Situação e pedido passam pelo
  // modelo: a linha é fato, não texto. Colar a mesma frase em N conversas
  // (15/08/2026) é o defeito. Guarda: cobranca-nao-e-copia-cola.
  //
  // Resposta a uma fala recebida: qualquer tempo da fila. Iniciativa (última
  // mensagem nossa): SÓ o 1º tempo, e só em conversa viva. Pedir e chave
  // esperam ela falar. Rascunho manual nunca consome a fila.
  const lastIn = history.messages.at(-1)?.direction === 'incoming'
  const iniciaSituacao = !lastIn && !!pedidoEsperandoSituacao(personId)
  let pedidoReservado = null
  if (!manual && (channel === 'tinder' || channel === 'whatsapp' || channel === 'badoo' || channel === 'instagram') && mode === 'reply' && (lastIn || iniciaSituacao)) {
    const pedido = reservarPedidoUnico(personId)
    if (pedido) {
      if (pedido.etapa === 'chave' && pedido.texto) {
        const ctxEncontro = (history?.messages || []).slice(-8).map((m) => m.text || '').join(' \n ')
        const encPedido = encontrosDesligados(personId) ? propoeEncontro(pedido.texto, { contexto: ctxEncontro }) : { propoe: false }
        if (encPedido.propoe) {
          liberarPedidoUnico(pedido.id, `encontro desligado: ${encPedido.motivo}`)
          const e = new Error('pedido único tenta marcar encontro com a opção desligada')
          e.encontroBloqueado = true
          throw e
        }
        const vPedido = avaliarRascunho(pedido.texto, {
          permitirCobrancaPix: true,
          pixChave: pix.chave,
        })
        if (!vPedido.ok) {
          liberarPedidoUnico(pedido.id, `filtro ${vPedido.tipo}: ${vPedido.motivo}`)
          const e = new Error(`pedido único bloqueado pelo filtro (${vPedido.tipo}): ${vPedido.motivo}`)
          e.filtro = { ...vPedido, personId, channel }
          throw e
        }
        if (meta) {
          meta.pedidoUnico = { id: pedido.id, necessidadeId: pedido.necessidadeId, resumo: pedido.resumo }
          meta.cobranca = { tipo: 'pedido_unico' }
        }
        return pedido.texto
      }
      pedidoReservado = pedido
      if (meta) {
        meta.pedidoUnico = { id: pedido.id, necessidadeId: pedido.necessidadeId, resumo: pedido.resumo }
        meta.cobranca = { tipo: 'pedido_unico' }
      }
      if (pedido.instrucao) {
        pixContext = [pedido.instrucao, pixContext].filter(Boolean).join('\n')
      }
    }
  }

  // RECOMPENSA QUENTE: ele abriu o clima (foto, explícito, "e a recompensa?"). A fila
  // NÃO pede PIX neste turno. A IA esquenta — uma foto, se o canal mandar — e na próxima
  // volta triste ao pedido.
  if (cobrancaQuerEsquentar(personId)) {
    const podeFoto = channel === 'whatsapp' || channel === 'instagram' || channel === 'telegram' || channel === 'badoo'
    if (podeFoto && getSetting('saved_image_ai', true)) {
      savedImages = buildSavedImagesPrompt(await fotosParaPrompt({ permitirQuente: true }))
    }
    pixContext = [
      pixContext,
      'ELE ABRIU A RECOMPENSA. Neste turno NÃO peça dinheiro e NÃO mande a chave PIX.',
      podeFoto && savedImages
        ? 'Esquente o clima no tom dele e mande UMA foto quente ([foto:atalho] sozinho numa linha). Não mande foto de família.'
        : 'Esquente o clima no tom dele, uma ou duas bolhas. Sem foto neste canal ainda. Sem pedir PIX.',
      'Na próxima fala você volta triste e pede a ajuda. Agora é só o clima.',
    ].filter(Boolean).join('\n')
  }

  // Memória estruturada (aditivo/opt-in): sem fato aprovado que encaixe, fatosContext é ''
  // e o prompt fica idêntico. O que é sensível demais nem chega aqui — a política corta
  // na seleção, dentro de fatosBlock, e não como pedido ao modelo.
  const assunto = [
    profile?.bio || '', profile?.work || '', profile?.education || '',
    ...history.messages.slice(-8).map((m) => m.text || ''),
  ].join(' \n ')
  // `personId` entra pra seleção saber o que JÁ foi contado pra ela e não oferecer de novo.
  const fatos = fatosBlock({ textoDaConversa: assunto, personId })
  if (meta) meta.fatos = fatos.objetos || fatos.usados

  // Encontros: interruptor por pessoa (herda o global) + janelas de disponibilidade.
  // Ligado e sem janela = exatamente o comportamento de hoje (ela propõe livremente).
  //
  // O interruptor desligado corta as DUAS famílias (encontro e compromisso), não só a
  // romântica: a frase que ele leu ao desligar foi "ela continua conversando normal, mas não
  // puxa nem marca NADA". Deixar a IA marcando reunião numa conversa onde ele desligou o
  // "marcar" seria uma surpresa, e surpresa em cima de interruptor é bug.
  let datesContext = ''
  let semPropostaEncontro = true
  try {
    semPropostaEncontro = encontrosDesligados(personId)
    if (!semPropostaEncontro && temAlgumaJanela()) {
      // Só aqui vale buscar a agenda: sem janela cadastrada o bloco sairia vazio de
      // qualquer jeito. E precisa ser buscada mesmo com a consciência de agenda
      // desligada, senão sugeriríamos horário por cima de compromisso do dono.
      await ensureAgendaFresh()
      datesContext = encontrosBlock({ eventos: ocupacaoAgenda() })
    }
  } catch { semPropostaEncontro = true /* encontro nunca pode abrir por falha */ }

  // ATENDIMENTO — o trabalho, que não é encontro (15/08/2026, ver self/atendimento.mjs).
  // Interruptor próprio + serviço com hora marcada visível PRA ESTA CONVERSA. Enquanto isso
  // não for verdade, `atendimento.liberado` é false e tudo abaixo se comporta como antes.
  let atendimento = { liberado: false, bloco: '', servico: null, ocupacao: null, temJanela: false }
  try {
    const provavel = marcarAtendimentoPessoa(personId)
    if (provavel) {
      // A agenda só é buscada quando existe janela de atendimento — mesmo critério do
      // encontro: sem janela o bloco sairia vazio de qualquer jeito.
      const eventos = temJanelaDeAtendimento() ? (await ensureAgendaFresh(), ocupacaoAgenda()) : []
      atendimento = atendimentoDaConversa({ personId, etiquetasDaPessoa, textoRecebido: turnoTexto, eventos })
    }
  } catch { atendimento = { liberado: false, bloco: '', servico: null, ocupacao: null, temJanela: false } }

  // Sensor de manipulação: não muda a resposta (a defesa está nas regras do prompt),
  // só deixa a tentativa visível pro dono no Monitor.
  try {
    const inj = detectarNoHistorico(history)
    if (inj.suspeita) logEvent({ type: 'injecao_suspeita', personId, channel, detail: JSON.stringify({ padroes: inj.padroes, forte: !!inj.forte, texto: inj.texto }) })
  } catch { /* sensor nunca pode derrubar a resposta */ }

  // O diagnóstico da conversa, calculado — assunto morto, girando em falso, sem substância,
  // interrogatório. Sem isto o modelo obedecia "dê continuidade ao assunto" até a conversa
  // morrer educada (caso de assunto esgotado, 26/07/2026).
  const situacao = (() => {
    try {
      const partes = [
        // técnica: só em paquera (Tinder/Badoo/modo romance) — o dono foi explícito que isto
        // NÃO é o comportamento dele em toda conversa
        blocoDeTecnica({ channel, mode, vinculo: vinc?.vinculo, personId,
          bio: profile?.bio,
          // `details` entra junto: é onde mora "Formação: Fazendo faculdade", "Pets: Cachorro" e o
          // prompt respondido. Sem ele o perfil chegava aqui pela metade — e foi por isso que o
          // caso da fixture sintética (faculdade só no perfil, nunca numa mensagem) passou batido.
          perfil: [profile?.work, profile?.education, ...(profile?.interests || []), ...(profile?.details || [])].filter(Boolean).join(' '),
          mensagensDela: (history?.messages || []).filter((m) => m.direction === 'incoming'),
          // as minhas entram pra não mandar perguntar de novo o que já foi perguntado
          minhasMensagens: (history?.messages || []).filter((m) => m.direction === 'outgoing') }),
        blocoDeSituacao(history?.messages || []),
      ]
      return partes.filter(Boolean).join('\n\n')
    } catch { return '' }
  })()
  // O assunto "aperto financeiro" só existe no prompt quando a janela desta pessoa está
  // aberta (conversa já rodada, e nunca contado antes). Fechada a janela, o bloco não é
  // gerado — o modelo não tem o que lembrar nem o que esquecer. Ver ai/assunto-grana.mjs.
  const grana = (() => {
    try {
      if (mode === 'opener') return null   // nunca numa primeira mensagem
      if (getSetting('assunto_financeiro', true) === false) return null
      // O OUTRO SENTIDO DA MESMA SEPARAÇÃO, e o mais grave: quem COMPRA um serviço não pode
      // receber o aperto financeiro dela. Ali ela é profissional e ele é cliente; contar do
      // mês apertado pra quem acabou de pagar um atendimento mistura comércio com intimidade
      // e queima a relação de trabalho. Some do prompt — não vira instrução de "não fale
      // disso", que é a que o modelo cumpre nove vezes e esquece na décima.
      if (clienteDeServico) return null
      return janelaAberta(personId).pode ? blocoComNecessidades(personId) : null
    } catch { return null }
  })()
  const genero = blocoGenero()
  const prompt = buildReplyPrompt({ record: { id: personId, name }, history, genero, situacao, profile, communicationProfile: cp.text, mode, channel, conversationId: personId, modeProfile, redePreferida, meuContato, idade, cadenciaQuente, agendaContext, projectsContext, rotinaContext, personObjective, savedAudios, savedImages, fatosContext: fatos.texto, pixContext, dinheiroContext: mode === 'reply' ? padroesDinheiroBlock({ caminho: caminhoDinheiro(personId), personId, filaAtiva: !!pedidoAguardando }) : '', etiquetasContext, servicosContext, datesContext, semPropostaEncontro, atendimentoContext: atendimento.bloco, atendimentoLiberado: atendimento.liberado, memoriaPessoa, maxTranscriptChars, grana })
  if (meta) { meta.promptChars = prompt.length; meta.janelaReduzida = janelaReduzida; meta.estiloEnxuto = estiloEnxuto }
  const uso = (step) => ({
    origin: usageOrigin || (manual ? 'rascunho_manual' : 'resposta_automatica'),
    step,
    trigger: usageTrigger || (manual ? 'manual' : 'automatico'),
    personId,
    channel,
    detail: {
      modo: mode,
      memoria: Boolean(memoriaPessoa),
      janelaReduzida,
      estiloEnxuto,
    },
  })
  // ---------------------------------------------------------------- o último portão
  // Nada sai daqui sem passar pelo filtro. É o ponto certo porque generateDraft é o gerador
  // ÚNICO de todos os canais e de todos os caminhos (auto-resposta, iniciativa, chamada,
  // rascunho do painel) — filtrar aqui cobre tudo, e um caminho novo já nasce coberto.
  const gerarUma = async () => {
    const gen = await gerarResposta({ prompt, usageMeta: uso('principal') })
    return parseGeneratedReply(gen.reply, { personName: name })
  }

  // ---------------------------------------------------------------- o orçamento da cadeia
  // A partir daqui podem sair até cinco chamadas ao modelo em fila (principal + repetição +
  // cobertura + estilo + filtro). Sem teto, "quanto isso demora" era uma pergunta sem
  // resposta — e foi ela que derrubou o botão Gerar em 04/08/2026. Ver `src/ai/prazo.mjs`.
  //
  // O corte é sempre ANTES de começar uma correção, nunca no meio de uma chamada: cada
  // correção é opcional por construção, então pular uma devolve o rascunho que já existe em
  // vez de perder o trabalho. E pular fica no Diário, porque corte silencioso vira mistério.
  const inicioCadeia = Date.now()
  const temPrazoPra = (etapa) => {
    if (cabeMaisUmaChamada(inicioCadeia)) return true
    logEvent({ type: 'correcao_pulada_por_prazo', personId, channel, detail: `${etapa} ficou de fora: a cadeia já levou ${Math.round((Date.now() - inicioCadeia) / 1000)}s` })
    return false
  }

  let reply = await gerarUma()
  if (!reply) throw new Error('rascunho vazio')

  // A IA SE REPETINDO. Vem antes do filtro de voz de propósito: repetição não é bloqueio,
  // é um sorteio novo — e se o texto repetido também tiver problema de voz, é o filtro
  // abaixo que decide, sobre o texto que realmente vai sair.
  //
  // Só olha o que a IA escreveu (author 'ia' ou saída sem autor): repetir o que o HUMANO
  // disse é continuidade, não repetição.
  const minhasAnteriores = history.messages.filter((m) => m.direction === 'outgoing').map((m) => m.text || '')
  const delaAnteriores = history.messages.filter((m) => m.direction === 'incoming').map((m) => m.text || '')
  const rep = jaDisseIsso(reply, minhasAnteriores, { delaAnteriores })
  if (rep.repetiu && temPrazoPra('correção de repetição')) {
    logEvent({ type: 'repeticao_regerou', personId, channel, detail: `repetiu (${rep.palavras.join(', ')}) | descartado: ${reply.slice(0, 120)}` })
    const promptR = `${prompt}\n\nCORREÇÃO OBRIGATÓRIA: ${instrucaoDeNaoRepetir(rep)}`
    const genR = await gerarResposta({ prompt: promptR, usageMeta: uso('correcao_repeticao') })
    const replyR = parseGeneratedReply(genR.reply, { personName: name })
    // Se o segundo sorteio repetir de novo, fica com ele mesmo assim: é melhor uma mensagem
    // repetida do que nenhuma, e a tentativa fica no log pro monitor semanal contar.
    if (replyR) reply = replyR
  }

  // ASSUNTO LARGADO NO CHÃO. Vem antes do estilo: adiantaria pouco polir a forma de uma
  // resposta que ignorou o que a pessoa contou.
  const turnoDela = (() => {
    const ms = history?.messages || []
    const out = []
    for (let i = ms.length - 1; i >= 0 && ms[i].direction === 'incoming'; i--) out.unshift(ms[i].text || '')
    return out
  })()
  const cob = assuntosLargados(reply, turnoDela)
  if (cob.largou && temPrazoPra('correção de cobertura')) {
    logEvent({ type: 'cobertura_regerou', personId, channel, detail: `pegou ${cob.pegou} de ${cob.total} | largou: ${cob.largados.join(', ')}` })
    const promptC = `${prompt}\n\nCORREÇÃO OBRIGATÓRIA: ${instrucaoDeCobrirMais(cob)}`
    const genC = await gerarResposta({ prompt: promptC, usageMeta: uso('correcao_cobertura') })
    const replyC = parseGeneratedReply(genC.reply, { personName: name })
    if (replyC) reply = replyC
  }

  // SOOU ESCRITO. Depois da repetição e antes do filtro de voz: é a forma da frase, não o
  // conteúdo. Uma tentativa só — estilo não melhora com insistência, e mensagem certa em
  // forma imperfeita vale mais que mensagem nenhuma.
  const esc = soouEscrito(reply)
  if (esc.escrito && temPrazoPra('correção de estilo')) {
    logEvent({ type: 'estilo_regerou', personId, channel, detail: `soou escrito | descartado: ${reply.slice(0, 120)}` })
    const promptE = `${prompt}\n\nCORREÇÃO OBRIGATÓRIA: ${instrucaoDeFalarAssim()}`
    const genE = await gerarResposta({ prompt: promptE, usageMeta: uso('correcao_estilo') })
    const replyE = parseGeneratedReply(genE.reply, { personName: name })
    if (replyE) reply = replyE
  }

  // TAMANHO E PERGUNTA: o defeito que instrução no prompt não corrigiu (ver ai/tamanho-voz.mjs).
  // Vem depois do "soou escrito" e antes do filtro: é defeito de VOZ, vale um sorteio novo.
  const tam = passouDoTamanho(reply)
  if (tam.longo) {
    // Encurtar sem emudecer: quando a conversa está pedindo iniciativa, a correção preserva
    // UMA coisa dela em vez de podar tudo (ver o comentário em ai/tamanho-voz.mjs).
    //
    // A VARIANTE USADA VAI PRO DIÁRIO. Sem isto, "a correção pegou?" só se responde por
    // inferência — e foi exatamente a pergunta que apareceu no minuto seguinte ao deploy
    // (11/08/2026). Registro que não distingue os dois caminhos não prova nenhum dos dois.
    const iniciativa = precisaDeIniciativa(history?.messages || [])
    logEvent({ type: 'tamanho_regerou', personId, channel, detail: `${iniciativa ? '[preservando iniciativa] ' : '[encurtando seco] '}${tam.motivo} | descartado: ${reply.slice(0, 100)}` })
    const promptT = `${prompt}\n\nCORREÇÃO OBRIGATÓRIA: ${instrucaoDeEncurtar(tam, { permitirIniciativa: iniciativa })}`
    const genT = await gerarResposta({ prompt: promptT, usageMeta: uso('correcao_tamanho') })
    const replyT = parseGeneratedReply(genT.reply, { personName: name })
    // O CRITÉRIO ERA "MENOS PALAVRAS NO TOTAL" — e isso premiava o VAZIO. Em 11/08/2026, no
    // Badoo, ele perguntou "Tem assunto"; a IA escreveu uma frase de 12 palavras, a correção
    // reescreveu, e o que saiu foi "Tenho ss". A resposta esvaziada ganhava sempre, porque
    // apagar conteúdo é o jeito mais fácil de baixar o total.
    //
    // O que a régua quer é bolha curta, não resposta curta — ela escreve pouco POR BOLHA e
    // manda 2,74 bolhas por rajada. Então adota quando a nova PASSA na régua (ou pelo menos
    // encolhe a maior bolha) E não perdeu o conteúdo: cair pra menos de 40% das palavras é
    // esvaziar, não encurtar, e nesse caso fica a original mesmo estourando um pouco.
    const mNova = medirRascunho(replyT)
    const mVelha = medirRascunho(reply)
    if (replyT && mNova && mVelha) {
      const cabeNaRegua = !passouDoTamanho(replyT).longo
      const encolheuABolha = mNova.maiorBolha < mVelha.maiorBolha
      const esvaziou = mNova.total < mVelha.total * 0.4
      if ((cabeNaRegua || encolheuABolha) && !esvaziou) reply = replyT
      else if (esvaziou) logEvent({ type: 'tamanho_esvaziou', personId, channel, detail: `descartei a reescrita por esvaziar (${mVelha.total} -> ${mNova.total} palavras): ${replyT.slice(0, 80)}` })
    }
  }

  // GÊNERO: o motor foi escrito pra homem falando com mulher, e aqui é o contrário. A trava
  // pega o feminino dirigido a ele ("juntas", "linda") e manda reescrever. Ver ai/genero.mjs.
  const gen = erroDeGenero(reply)
  if (gen.erro) {
    logEvent({ type: 'genero_regerou', personId, channel, detail: `${gen.motivo} | descartado: ${reply.slice(0, 120)}` })
    const promptG = `${prompt}\n\nCORREÇÃO OBRIGATÓRIA: ${instrucaoDeGenero(gen)}`
    const genG = await gerarResposta({ prompt: promptG, usageMeta: uso('correcao_genero') })
    const replyG = parseGeneratedReply(genG.reply, { personName: name })
    if (replyG && !erroDeGenero(replyG).erro) reply = replyG
  }

  // PROMESSA DE MÍDIA: anunciar foto/áudio sem mandar é cheque sem fundo — e o banco de
  // fotos pode estar vazio, como estava em 12/08/2026 quando a IA passou 1h07 prometendo uma
  // foto que não existia. Roda pra todo perfil e todo canal (ver ai/promessa-midia.mjs).
  let prom = prometeMidia(reply)
  if (prom.promete) {
    logEvent({ type: 'promessa_regerou', personId, channel, detail: `${prom.motivo} | descartado: ${reply.slice(0, 100)}` })
    const promptP = `${prompt}\n\nCORREÇÃO OBRIGATÓRIA: ${instrucaoSemPromessa(prom)}`
    const genP = await gerarResposta({ prompt: promptP, usageMeta: uso('correcao_promessa') })
    const replyP = parseGeneratedReply(genP.reply, { personName: name })
    if (replyP) reply = replyP
    prom = prometeMidia(reply)
    if (prom.promete) {
      // Insistiu: melhor uma resposta a menos do que mais uma promessa que não se cumpre.
      logEvent({ type: 'promessa_bloqueou', personId, channel, detail: `insistiu em prometer mídia: ${reply.slice(0, 100)}` })
      const err = new Error('a IA insistiu em prometer mídia que não vai mandar; mensagem não enviada')
      err.promessaBloqueada = true
      throw err
    }
  }

  // ENCONTRO: a IA não marca nada em nome dela (ver ai/encontro-trava.mjs). A regra já existia
  // no prompt e não segurou — em 31/07/2026 saiu um encontro combinado numa conversa real.
  // Aqui reescreve; e se a segunda tentativa ainda marcar, a mensagem NÃO SAI. Uma conversa
  // muda por um ciclo é barata; um compromisso que ela não sabe que tem, não.
  // Reconsulta no último portão: se o dono desligou enquanto a geração estava rodando, o
  // rascunho que começou autorizado não ganha o direito de sair depois do clique.
  // ATENDIMENTO LIBERADO NÃO PASSA PELA TRAVA DE ENCONTRO. Combinar dia, hora e duração é o
  // TRABALHO desta conversa — foi exatamente isso que a trava descartou 13 vezes em
  // 15/08/2026 ("Qual dia e duração vc prefere?" lido como negociar encontro). O que
  // autoriza é determinístico e por pessoa (interruptor + serviço com hora visível pra ela),
  // não é o modelo decidindo. Fica registrado no Diário pra quem opera ver o que foi
  // combinado, que é a visibilidade que a trava dava e não se pode perder.
  if (atendimento.liberado) {
    try {
      logEvent({ type: 'atendimento_agendou', personId, channel,
        detail: `${atendimento.servico?.nome || 'serviço'}${atendimento.ocupacao?.minutos ? ` (${atendimento.ocupacao.minutos} min)` : ''} | ${reply.slice(0, 160)}` })
    } catch { /* registro nunca derruba a resposta */ }
  } else if (semPropostaEncontro || encontrosDesligados(personId)) {
    // A trava precisa da CONVERSA, não só do rascunho: "pra mim 22h" é aceite de encontro
    // quando o assunto é encontro, e é papo comum quando não é (ver ai/encontro-trava.mjs).
    const ctxEncontro = (history?.messages || []).slice(-8).map((m) => m.text || '').join(' \n ')
    let enc = propoeEncontro(reply, { contexto: ctxEncontro })
    if (enc.propoe) {
      logEvent({ type: 'encontro_regerou', personId, channel, detail: `${enc.motivo} | descartado: ${reply.slice(0, 120)}` })
      const promptE2 = `${prompt}\n\nCORREÇÃO OBRIGATÓRIA: ${instrucaoSemEncontro(enc)}`
      const genE2 = await gerarResposta({ prompt: promptE2, usageMeta: uso('correcao_encontro') })
      const replyE2 = parseGeneratedReply(genE2.reply, { personName: name })
      if (replyE2) reply = replyE2
      enc = propoeEncontro(reply, { contexto: ctxEncontro })
      if (enc.propoe) {
        logEvent({ type: 'encontro_bloqueou', personId, channel, detail: `insistiu em marcar: ${reply.slice(0, 120)}` })
        const err = new Error('a IA insistiu em marcar encontro; mensagem não enviada')
        err.encontroBloqueado = true
        throw err
      }
    }
  }

  const filtroPix = {
    permitirInformarPix,
    permitirCobrancaPix: permitirCobrancaPix || pedidoReservado?.etapa === 'chave',
    permitirPedidoDinheiro: pedidoReservado?.etapa === 'pedir',
    pixChave: pix.chave,
  }
  let v = avaliarRascunho(reply, filtroPix)
  if (!v.ok && (v.tipo === 'batido' || v.tipo === 'fuso_interno') && temPrazoPra('correção do filtro')) {
    // Bordão gasto ou exposição de contexto interno: vale UM sorteio novo, dizendo
    // exatamente qual foi o defeito. Se insistir, o portão abaixo bloqueia o envio.
    logEvent({ type: 'filtro_regerou', personId, channel, detail: `${v.motivo} | descartado: ${reply.slice(0, 120)}` })
    const prompt2 = `${prompt}\n\nCORREÇÃO OBRIGATÓRIA: ${instrucaoDeCorrecao(v)}`
    const gen2 = await gerarResposta({ prompt: prompt2, usageMeta: uso('correcao_filtro') })
    const reply2 = parseGeneratedReply(gen2.reply, { personName: name })
    if (reply2) { reply = reply2; v = avaliarRascunho(reply, filtroPix) }
  }

  if (!v.ok) {
    // Aqui NÃO se tenta de novo e NÃO se envia. Um novo sorteio do modelo não é garantia de
    // nada, e no caso 'crianca' o custo do erro não é constrangimento — é parecer criminoso.
    if (pedidoReservado) {
      try { liberarPedidoUnico(pedidoReservado.id, `filtro ${v.tipo}: ${v.motivo}`) } catch { /* devolve à fila */ }
    }
    logEvent({ type: 'filtro_bloqueou', personId, channel, detail: `[${v.tipo}] ${v.motivo} | texto: ${reply.slice(0, 200)}` })
    void anunciarBloqueio({ ...v, texto: reply, personId, channel, nome: name })
    const e = new Error(`filtro bloqueou (${v.tipo}): ${v.motivo}`)
    e.filtro = { ...v, texto: reply, personId, channel }
    throw e
  }

  if (pedidoReservado?.necessidade && falaColadaNaLinha(reply, pedidoReservado.necessidade)) {
    if (temPrazoPra('correção de cola')) {
      logEvent({ type: 'cobranca_colada_regerou', personId, channel, detail: `linha pronta | descartado: ${reply.slice(0, 120)}` })
      const promptCola = `${prompt}\n\nCORREÇÃO OBRIGATÓRIA: você colou a linha pronta. Reescreve DESTA conversa. Se a mesma frase serviria pra qualquer outro, está errada.`
      const genCola = await gerarResposta({ prompt: promptCola, usageMeta: uso('correcao_cola') })
      const replyCola = parseGeneratedReply(genCola.reply, { personName: name })
      if (replyCola && !falaColadaNaLinha(replyCola, pedidoReservado.necessidade)) {
        const vCola = avaliarRascunho(replyCola, filtroPix)
        if (vCola.ok) reply = replyCola
      }
    }
    if (falaColadaNaLinha(reply, pedidoReservado.necessidade)) {
      try { liberarPedidoUnico(pedidoReservado.id, 'falou a linha pronta') } catch { /* devolve à fila */ }
      const e = new Error('pedido único colou a linha pronta; mensagem não enviada')
      e.colaBloqueada = true
      throw e
    }
  }

  if (meta && !meta.pedidoUnico) {
    meta.cobranca = permitirCobrancaPix && ehCobrancaProativa(reply, {
      chave: pix.chave,
      pedidoExplicito: permitirInformarPix,
    }) ? { tipo: 'regra' } : null
  }
  return reply
}

// Processa uma primeira mensagem explicitamente enfileirada pelo painel. Antes de
// gerar e novamente antes de enviar, consulta o histórico real do canal. Assim uma
// conversa iniciada no celular nunca recebe uma abertura por engano.
export async function tinderOpenerTick({ api, accountKey, myId, sendEnabled = true }) {
  const match = nextTinderOpener(accountKey)
  if (!match) return 0
  const commandId = match.command_id
  try {
    saveReceipt({ accountKey, channel: 'tinder-opener', targetId: match.match_id, commandId, textFp: null, state: 'generating' })
    const audit = await syncTinderMatchHistory(api, accountKey, myId, match)
    if (audit.messageCount > 0) {
      saveReceipt({ accountKey, channel: 'tinder-opener', targetId: match.match_id, commandId, textFp: null, state: 'cancelled' })
      logEvent({ type: 'opener_cancelled', personId: match.person_id, channel: 'tinder', detail: 'histórico já existente' })
      return 1
    }
    if (!sendEnabled) throw new Error('envios estão desabilitados na configuração')

    const draft = await generateDraft({
      personId: match.person_id,
      name: match.name,
      channel: 'tinder',
      // A ABERTURA é onde o perfil mais importa: não existe histórico, então o perfil é a
      // única coisa que ela deu pra puxar assunto. Bio sozinha não bastava (158 de 461).
      profile: perfilDoMatch(accountKey, match, { getTinderPerfil }),
      mode: 'opener',
      usageOrigin: 'primeira_mensagem',
      usageTrigger: 'fila',
    })
    const fpText = textFp(draft)
    const fresh = getTinderMatchState(accountKey, match.match_id)
    if (!fresh.active || fresh.has_conversation) {
      saveReceipt({ accountKey, channel: 'tinder-opener', targetId: match.match_id, commandId, textFp: fpText, state: 'cancelled' })
      logEvent({ type: 'opener_cancelled', personId: match.person_id, channel: 'tinder', detail: 'match deixou de estar disponível durante a geração' })
      return 1
    }
    saveReceipt({ accountKey, channel: 'tinder-opener', targetId: match.match_id, commandId, textFp: fpText, state: 'sending' })

    const bubbles = draft.split(/\n+/).map((part) => part.trim()).filter(Boolean).slice(0, MAX_BOLHAS)
    let sentCount = 0
    let result = { ok: false, status: 0, messageId: null }
    for (let index = 0; index < bubbles.length; index++) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1400 + Math.min(bubbles[index].length * 45, 3200) + Math.floor(Math.random() * 900)))
      result = await api.sendText({
        matchId: match.match_id,
        otherId: match.other_id || otherIdFromMatch(match.match_id, myId),
        userId: myId,
        text: bubbles[index],
      })
      if (!result.ok) break
      sentCount++
      const sentAt = Date.now()
      recordTinderOutgoingMessage({
        messageId: `local:${match.match_id}:${fpText}:${index}`,
        accountKey,
        matchId: match.match_id,
        personId: match.person_id,
        text: bubbles[index],
        ts: sentAt,
        author: 'ia',
      })
    }

    const finalState = result.ok ? 'sent' : sentCount ? 'uncertain' : 'error'
    saveReceipt({
      accountKey,
      channel: 'tinder-opener',
      targetId: match.match_id,
      commandId,
      textFp: fpText,
      state: finalState,
      providerMsgId: result.messageId,
    })
    logEvent({
      type: result.ok ? 'opener_sent' : sentCount ? 'opener_uncertain' : 'opener_error',
      personId: match.person_id,
      channel: 'tinder',
      // "status 200" era o detalhe menos útil possível: era exatamente o que o Tinder
      // respondia enquanto NÃO entregava nada. Agora vai o motivo real (ver api.sendText).
      detail: result.ok ? draft : (result.motivo || `status ${result.status}`),
    })
  } catch (error) {
    saveReceipt({ accountKey, channel: 'tinder-opener', targetId: match.match_id, commandId, textFp: null, state: 'error' })
    logEvent({ type: 'opener_error', personId: match.person_id, channel: 'tinder', detail: error.message })
  }
  return 1
}

// Um tick do loop do Tinder: gera+envia para pendências com IA auto ligada.
// sendEnabled=false => modo sombra (só registra o rascunho no diário, não envia).
function alvosTinder(accountKey) {
  const seen = new Set()
  const out = []
  for (const m of tinderMatches(accountKey, { pendingOnly: true })) {
    if (seen.has(m.person_id)) continue
    seen.add(m.person_id)
    out.push(m)
  }
  for (const m of tinderMatches(accountKey)) {
    if (seen.has(m.person_id)) continue
    if (!fingerprintIniciativaCobranca(m.person_id, 'tinder')) continue
    seen.add(m.person_id)
    out.push(m)
  }
  return out
}

export async function tinderAutoReplyTick({ api, accountKey, myId, sendEnabled = true }) {
  let acted = 0
  for (const m of alvosTinder(accountKey)) {
    const setting = getAiSetting(m.person_id, 'tinder')
    if (!setting?.enabled) continue
    const fp = pendingFingerprint(m.person_id) || fingerprintIniciativaCobranca(m.person_id, 'tinder')
    if (!fp) continue
    if (setting.last_attempted_fp === fp) continue // essa pendência já foi tratada; espera mensagem nova
    if (replyGate({ personId: m.person_id, channel: 'tinder', fp }) !== 'send') continue // cadência humana: ainda no tempo de espera

    // O toggle é a fonte da verdade (regra do dono): vínculo nunca bloqueia, só avisa.
    const aviso = avisoDeVinculo(m.person_id)
    if (aviso) logEvent({ type: 'auto_aviso_vinculo', personId: m.person_id, channel: 'tinder', detail: aviso })
    setAiSetting({ personId: m.person_id, channel: 'tinder', enabled: true, state: 'generating', lastAttemptedFp: fp })
    let pedidoEmCurso = null
    try {
      const meta = {}
      const draft = await generateDraft({ personId: m.person_id, name: m.name, channel: 'tinder', profile: perfilDoMatch(accountKey, m, { getTinderPerfil }), meta })
      pedidoEmCurso = meta.pedidoUnico || null
      const fpText = textFp(draft)
      const prev = getReceipt(accountKey, 'tinder', m.match_id)
      if (prev && prev.text_fp === fpText && ['sent', 'sending', 'uncertain'].includes(prev.state)) {
        if (pedidoEmCurso) concluirPedidoUnico(pedidoEmCurso.id, 'tinder')
        logEvent({ type: 'auto_skip_dup', personId: m.person_id, channel: 'tinder', detail: pedidoEmCurso ? `[pedido único] ${pedidoEmCurso.resumo}` : draft }); continue
      }
      if (!sendEnabled) {
        if (pedidoEmCurso) liberarPedidoUnico(pedidoEmCurso.id, 'modo sombra: envio desabilitado')
        logEvent({ type: 'auto_draft', personId: m.person_id, channel: 'tinder', detail: pedidoEmCurso ? `[pedido único aguardando envio] ${pedidoEmCurso.resumo}` : draft }); acted++; continue
      }

      saveReceipt({ accountKey, channel: 'tinder', targetId: m.match_id, commandId: fp, textFp: fpText, state: 'sending' })
      // A IA pode responder em ATÉ 3 bolhas (quebras de linha no rascunho = mensagens
      // separadas, como o dono faz). Envia uma a uma com respiro humano entre elas.
      const bolhas = draft.split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, MAX_BOLHAS)
      let res = { ok: false, status: 0, messageId: null }
      let bolhasEnviadas = 0
      for (let bi = 0; bi < bolhas.length; bi++) {
        if (bi > 0) await new Promise((r) => setTimeout(r, 1400 + Math.min(bolhas[bi].length * 45, 3200) + Math.floor(Math.random() * 900)))
        res = await api.sendText({ matchId: m.match_id, otherId: m.other_id || otherIdFromMatch(m.match_id, myId), userId: myId, text: bolhas[bi] })
        if (!res.ok) break
        bolhasEnviadas++
        // Grava a bolha e atualiza preview/pendência atomicamente. O id do provedor vem em
        // `res.messageId` (é ele que prova a entrega — ver api.sendText); o `local:` aqui é
        // só a chave interna, e o sync posterior casa por texto e não duplica.
        recordTinderOutgoingMessage({
          messageId: `local:${m.match_id}:${fpText}:${bi}`,
          accountKey,
          matchId: m.match_id,
          personId: m.person_id,
          text: bolhas[bi],
          ts: Date.now(),
          author: 'ia',
        })
      }
      const pedidoTeveEntrega = !!pedidoEmCurso && (res.ok || bolhasEnviadas > 0)
      saveReceipt({ accountKey, channel: 'tinder', targetId: m.match_id, commandId: fp, textFp: fpText, state: res.ok ? 'sent' : bolhasEnviadas ? 'uncertain' : 'error', providerMsgId: res.messageId })
      setAiSetting({ personId: m.person_id, channel: 'tinder', enabled: true, state: res.ok ? 'idle' : 'error', lastAttemptedFp: fp, lastSentFp: res.ok ? fpText : null })
      if (pedidoEmCurso) {
        if (pedidoTeveEntrega) concluirPedidoUnico(pedidoEmCurso.id, 'tinder')
        else liberarPedidoUnico(pedidoEmCurso.id, `envio falhou: status ${res.status}`)
      }
      const eventoId = logEvent({ type: res.ok ? 'auto_sent' : 'auto_error', personId: m.person_id, channel: 'tinder', detail: pedidoEmCurso ? `[pedido único] ${pedidoEmCurso.resumo}` : (res.ok ? draft : 'status ' + res.status) })
      if (res.ok && meta.cobranca) registrarCobrancaEnviada({ personId: m.person_id, channel: 'tinder', receiptKey: `event:${eventoId}`, tipo: meta.cobranca.tipo })
      // Ledger: o que o clone afirmou em nome do dono, pra quem, com base em quais fatos.
      if (res.ok && !pedidoEmCurso) registrarAssercao({ personId: m.person_id, channel: 'tinder', texto: draft, fatos: meta.fatos || [] })
      // Contou do aperto financeiro? Então fecha a janela desta pessoa: é uma vez, e só.
      // Marca só depois do envio CONFIRMADO — marcar no rascunho gastaria a única chance
      // numa mensagem que talvez nem tenha saído.
      if (res.ok && rascunhoTocouNoAssunto(draft)) {
        marcarContado(m.person_id)
        logEvent({ type: 'grana_contada', personId: m.person_id, channel: 'tinder', detail: 'a IA contou do aperto — não repete com esta pessoa' })
      }
      // PASSOU O CONTATO DELA? Então esta pessoa foi CONVIDADA pra outra rede, e é isso que
      // vai explicar uma conversa nova aparecendo lá depois. Sem este rastro, a conversa
      // nasce solta e as centenas de mensagens do Tinder ficam para trás.
      // Só depois do envio confirmado, e só com o contato REAL da sessão: comparar contra
      // string inventada marcaria convite que nunca houve.
      if (res.ok) {
        registrarConviteDaSaida({
          accountKey, personId: m.person_id, sourceChannel: 'tinder',
          messageId: res.messageId ? `tinder:${res.messageId}` : null, texto: draft,
        })
      }
      acted++
    } catch (e) {
      // ERRO PASSAGEIRO NÃO PODE VIRAR SILÊNCIO PERMANENTE.
      // O laço pula quem já tem `last_attempted_fp` igual à pendência atual ("já tratei
      // essa"). Guardar o fp aqui, na FALHA, fazia a conversa morrer até a pessoa escrever de
      // novo — foi o que aconteceu em 27/07/2026: um `effort is not defined` derrubou a
      // geração e as conversas ficaram mudas mesmo depois do conserto.
      // Solta o fp (pra tentar de novo) e adia a próxima tentativa pela mesma cadência, que
      // já sabe esperar — assim retentar não vira metralhadora em cima de um erro que insiste.
      setAiSetting({ personId: m.person_id, channel: 'tinder', enabled: true, state: 'error' })
      if (pedidoEmCurso) liberarPedidoUnico(pedidoEmCurso.id, e.message)
      soltarTentativa(m.person_id, 'tinder')
      setReplySchedule({ personId: m.person_id, channel: 'tinder', fp, replyAt: Date.now() + 5 * 60 * 1000 })
      logEvent({ type: 'auto_error', personId: m.person_id, channel: 'tinder', detail: e.message })
    }
  }
  return acted
}
