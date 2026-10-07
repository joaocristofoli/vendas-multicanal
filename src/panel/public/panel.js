// Painel de operações do vendas-multicanal — centro de controle.
// Vanilla, sem framework, sem build. Consome a API HTTP + WebSocket /ws.
// Concept: a cara do Tinder com as funções do bot. Teal = IA no comando.
(() => {
  'use strict'

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel)
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const icon = (id, cls = 'ico') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`
  const MOBILE_BREAKPOINT = 720
  const mobileMq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px), (max-height: 480px) and (pointer: coarse)`)
  const isMobileLayout = () => mobileMq.matches
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

  // fetch tolerante: nunca estoura; devolve null quando a API não responde.
  //
  // MAS FALHA NUNCA É SILENCIOSA. Em 26/07/2026 o dono clicou em "Aprovar" e não aconteceu
  // nada — nem efeito, nem erro. A causa era no servidor (uma rota nova drenava o corpo de
  // todo POST e pendurava as demais), mas o que tornou o defeito INVISÍVEL foi este `catch`
  // devolvendo null caladinho: sem resposta, sem aviso, e o botão parecia só não funcionar.
  //
  // Agora todo caminho de falha avisa na tela, e há TIMEOUT: requisição pendurada era o caso
  // exato do bug e travava pra sempre sem nunca chegar ao catch.
  const API_TIMEOUT_MS = 20000

  // O PRAZO DE UMA GERAÇÃO É OUTRO, E NÃO É PALPITE.
  //
  // 20s serve pra rota que lê banco. Não serve pra rota que chama o modelo: em 04/08/2026 o
  // botão Gerar falhou três vezes seguidas dizendo "o servidor não respondeu", e o servidor
  // tinha respondido — a cadeia (principal + correção de repetição) levava 22s e o navegador
  // desistia aos 20s. No histórico, 30% dos cliques passavam de 20s, p90 52s, pior 66s.
  //
  // Este número é DERIVADO de `src/ai/prazo.mjs` (PRAZO_CADEIA_MS + MARGEM_CLIENTE_MS). Como
  // o painel é arquivo estático e não importa do servidor, ele aparece literal aqui — e a
  // guarda `licoes/prazo-do-cliente-menor-que-o-do-servidor` reprova o build se os dois
  // discordarem. Mexer num sem mexer no outro quebra o check, não a produção.
  const PRAZO_GERACAO_MS = 230000

  // Por que a falha foi de diagnóstico e não só de tempo: "o servidor não respondeu" é
  // mentira quando quem desistiu foi a tela. Isto guarda O QUE aconteceu na última chamada,
  // pra quem chamou conseguir distinguir "desisti de esperar" de "o servidor falhou".
  let ultimaFalha = null

  // O BOTÃO QUE ELE ACABOU DE CLICAR. Um só ouvinte, na fase de captura, guarda a referência
  // e o instante. É o que permite travar QUALQUER botão do painel durante uma ação, sem
  // precisar mexer nos 64 handlers que existem hoje nem lembrar disso nos próximos.
  //
  // Por que isso importa: o dono clicou em "Aprovar", ficou sem retorno e disse "nem acho que
  // deu certo o clique". Um botão que não muda de estado enquanto trabalha é indistinguível
  // de um botão que não registrou o clique — e ainda deixa clicar de novo, disparando a ação
  // duas vezes.
  //
  // A JANELA DE 2s existe porque nem todo clique vira requisição na hora: botão que abre um
  // modal e só depois manda algo travaria o botão errado. Passou da janela, não é dele.
  let ultimoBotao = null
  let ultimoBotaoEm = 0
  const JANELA_CLIQUE_MS = 2000
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button') : null
    if (b) { ultimoBotao = b; ultimoBotaoEm = Date.now() }
  }, true)

  function travarBotao() {
    const b = ultimoBotao
    if (!b || Date.now() - ultimoBotaoEm > JANELA_CLIQUE_MS) return null
    if (b.disabled) return null            // já travado por quem chamou: não mexe
    if (!b.isConnected) return null
    ultimoBotao = null                     // um clique trava UM botão
    b.disabled = true
    b.classList.add('trabalhando')
    return () => { if (b.isConnected) { b.disabled = false; b.classList.remove('trabalhando') } }
  }

  async function api(path, opts) {
    const metodo = (opts && opts.method) || 'GET'
    const timeoutMs = Number(opts?.timeoutMs) || API_TIMEOUT_MS
    const soltar = metodo === 'GET' ? null : travarBotao()
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const requestOptions = Object.assign({ headers: { 'content-type': 'application/json' }, signal: ctrl.signal }, opts || {})
      delete requestOptions.timeoutMs
      const r = await fetch(path, requestOptions)
      if (r.status === 401) { location.href = '/'; return null }
      if (!r.ok) {
        let motivo = `erro ${r.status}`
        try { const j = await r.json(); if (j && (j.error || j.erro)) motivo = j.error || j.erro } catch { /* sem corpo */ }
        ultimaFalha = 'servidor'
        if (!(opts && opts.silencioso)) toast(motivo, 'err')
        return null
      }
      const ct = r.headers.get('content-type') || ''
      return ct.includes('json') ? await r.json() : await r.text()
    } catch (e) {
      // GET que falha costuma ser recarga de tela e o painel já lida; o que não pode passar
      // batido é uma AÇÃO dele (POST/DELETE) sumir sem explicação.
      const desistiu = e && e.name === 'AbortError'
      ultimaFalha = desistiu ? 'desisti' : 'rede'
      // "o servidor não respondeu" é o que estava escrito aqui e é FALSO quando quem desistiu
      // foi esta aba: em 04/08/2026 essa frase mandou a investigação pro lado errado.
      if (metodo !== 'GET' && !(opts && opts.silencioso)) toast(desistiu ? 'desisti de esperar (o servidor pode ter terminado)' : 'não consegui falar com o servidor', 'err')
      return null
    } finally { clearTimeout(t); if (soltar) soltar() }
  }
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) })

  // GERAR RASCUNHO, o caminho único dos quatro canais.
  //
  // Duas coisas que nenhum `post` comum faz: espera o prazo da GERAÇÃO (não o das rotas de
  // banco) e, se ainda assim esta aba desistir, vai buscar o rascunho que o servidor pode ter
  // terminado. O `pedido` é o que amarra as duas pontas — o servidor guarda o texto sob ele.
  async function gerarRascunho(path, corpo) {
    const pedido = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'p' + Date.now() + Math.random().toString(36).slice(2)
    ultimaFalha = null
    const r = await api(path, { method: 'POST', body: JSON.stringify(Object.assign({ pedido }, corpo || {})), timeoutMs: PRAZO_GERACAO_MS })
    if (r) return r
    if (ultimaFalha !== 'desisti') return null
    // uma tentativa de resgate, calada: 404 aqui é o normal (não deu tempo de terminar)
    const g = await api(`/api/rascunho?pedido=${encodeURIComponent(pedido)}`, { silencioso: true })
    if (g && g.draft) { toast('o rascunho ficou pronto depois; recuperei', 'ok'); return g }
    return null
  }
  const del = (path) => api(path, { method: 'DELETE' })

  function timeAgo(ts) {
    if (!ts) return ''
    const d = (typeof ts === 'number' ? ts : Date.parse(ts))
    if (!d) return ''
    const s = Math.max(0, (Date.now() - d) / 1000)
    if (s < 60) return 'agora'
    if (s < 3600) return `${Math.floor(s / 60)} min`
    if (s < 86400) return `${Math.floor(s / 3600)} h`
    const days = Math.floor(s / 86400)
    if (days < 7) return `${days} d`
    return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
  }
  function clockTime(ts) {
    const d = (typeof ts === 'number' ? ts : Date.parse(ts))
    return d ? new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''
  }
  function dayKey(ts) {
    const d = (typeof ts === 'number' ? ts : Date.parse(ts))
    return d ? new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' }) : ''
  }

  // Três réguas da PESSOA inteira (somando redes vinculadas), sempre na mesma ordem:
  // mensagens, dias inteiros desde a primeira e datas em que houve conversa de fato.
  const fmtInteiro = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })
  function metricasNomeHtml(metricas) {
    const m = metricas || {}
    const mensagens = Math.max(0, Number(m.mensagens) || 0)
    const desde = Math.max(0, Number(m.diasDesdePrimeira) || 0)
    const ativos = Math.max(0, Number(m.diasConversados) || 0)
    const aria = `${mensagens} mensagens trocadas; ${desde} dias desde a primeira conversa; ${ativos} dias com conversa`
    return `<span class="conv-metrics" aria-label="${esc(aria)}">
      <span class="conv-metric" title="Mensagens trocadas" aria-hidden="true"><b>${fmtInteiro.format(mensagens)}</b><i>msg</i></span>
      <span class="conv-metric" title="Dias desde a primeira conversa" aria-hidden="true"><b>${fmtInteiro.format(desde)}</b><i>d desde</i></span>
      <span class="conv-metric" title="Total de dias em que houve conversa" aria-hidden="true"><b>${fmtInteiro.format(ativos)}</b><i>d ativos</i></span>
    </span>`
  }
  const metricasNomeKey = (m) => [m?.mensagens || 0, m?.diasDesdePrimeira || 0, m?.diasConversados || 0]
  function atualizarMetricasNoCabecalho(seletor, metricas) {
    const atual = $(`${seletor} .wc-thread-head .conv-metrics`)
    if (atual) atual.outerHTML = metricasNomeHtml(metricas)
  }

  function toast(msg, kind = 'ok') {
    const host = $('#toasts')
    const t = el('div', `toast ${kind}`, `${icon(kind === 'err' ? 'i-x' : 'i-check', 'ico ico-sm')}<span>${esc(msg)}</span>`)
    host.appendChild(t)
    setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; setTimeout(() => t.remove(), 250) }, 2600)
  }

  const destructiveTimers = new WeakMap()
  function confirmDestructive(button, label, action) {
    if (!isMobileLayout()) { action(); return }
    if (button.dataset.confirming === 'true') {
      clearTimeout(destructiveTimers.get(button))
      button.dataset.confirming = 'false'
      action()
      return
    }
    const original = button.innerHTML
    button.dataset.confirming = 'true'
    button.classList.add('confirming')
    button.textContent = label
    const timer = setTimeout(() => {
      if (!button.isConnected) return
      button.dataset.confirming = 'false'
      button.classList.remove('confirming')
      button.innerHTML = original
    }, 4500)
    destructiveTimers.set(button, timer)
  }

  // ---------------------------------------------------------------- objetivo por pessoa
  // Um único editor serve Tinder, WhatsApp e Instagram. Fechado, ocupa apenas um
  // ícone/chip; aberto, vira popover no desktop e sheet no mobile.
  let objectiveDialog = null

  function paintObjectiveTrigger(button, objective, compact = false) {
    if (!button) return
    const value = String(objective || '').trim()
    button.classList.toggle('has-objective', !!value)
    button.setAttribute('aria-label', value ? `Objetivo definido: ${value}. Editar` : 'Definir objetivo com esta pessoa')
    button.title = value || 'Definir objetivo com esta pessoa'
    if (!compact) button.innerHTML = `${icon('i-target', 'ico')}<span>${value ? 'Objetivo ativo' : 'Objetivo'}</span>`
  }

  function closeObjectiveEditor(refocus = true) {
    if (!objectiveDialog) return
    const state = objectiveDialog
    objectiveDialog = null
    document.removeEventListener('keydown', state.onKey, true)
    state.root.remove()
    document.body.classList.remove('objective-open')
    if (refocus && state.anchor?.isConnected) state.anchor.focus()
  }

  function openObjectiveEditor({ personId, name, objective = '', anchor, onSaved }) {
    if (!personId) { toast('Não consegui identificar esta pessoa', 'err'); return }
    closeObjectiveEditor(false)
    const current = String(objective || '').trim()
    const root = el('div', 'objective-overlay')
    root.innerHTML = `
      <section class="objective-sheet" role="dialog" aria-modal="true" aria-labelledby="objectiveTitle" aria-describedby="objectiveHelp">
        <div class="objective-sheet-head">
          <div>
            <span class="objective-kicker">Direção da conversa</span>
            <h2 id="objectiveTitle">Objetivo${name ? ` com ${esc(name)}` : ''}</h2>
          </div>
          <button class="icon-btn objective-close" type="button" aria-label="Fechar">${icon('i-x', 'ico')}</button>
        </div>
        <div class="objective-principle" id="objectiveHelp">
          <span class="objective-principle-icon">${icon('i-target', 'ico')}</span>
          <span><b>Uma direção, não um roteiro</b><small>A IA continua conversando normalmente e só avança nisso quando ficar natural.</small></span>
        </div>
        <label class="objective-label" for="objectiveInput">O que você quer conduzir com esta pessoa?</label>
        <textarea class="objective-input" id="objectiveInput" maxlength="500" rows="4"
          placeholder="Ex.: explicar a proposta com calma antes de falar de preço&#10;Ex.: encontrar naturalmente um horário para marcar um café">${esc(current)}</textarea>
        <div class="objective-input-meta">
          <span>Opcional. Seja específico, mas deixe a conversa respirar.</span>
          <span class="objective-counter">${current.length}/500</span>
        </div>
        <div class="objective-actions">
          <button class="btn ghost objective-remove" type="button"${current ? '' : ' hidden'}>${icon('i-trash', 'ico ico-sm')} Remover</button>
          <span class="objective-action-spacer"></span>
          <button class="btn ghost objective-cancel" type="button">Cancelar</button>
          <button class="btn objective-save" type="button">${icon('i-check', 'ico ico-sm')} Salvar objetivo</button>
        </div>
      </section>`
    document.body.appendChild(root)
    document.body.classList.add('objective-open')
    const sheet = $('.objective-sheet', root)
    const input = $('#objectiveInput', root)
    const counter = $('.objective-counter', root)
    const saveButton = $('.objective-save', root)
    const removeButton = $('.objective-remove', root)
    const cancelButton = $('.objective-cancel', root)
    const closeButton = $('.objective-close', root)

    const updateCounter = () => { counter.textContent = `${input.value.length}/500` }
    input.addEventListener('input', updateCounter)

    let saving = false
    const persist = async (value) => {
      if (saving) return
      saving = true
      saveButton.disabled = true
      if (removeButton) removeButton.disabled = true
      saveButton.innerHTML = '<span class="spin"></span> Salvando…'
      const r = await post(`/api/person/${encodeURIComponent(personId)}/objective`, { objective: value })
      if (!r || !r.ok) {
        saving = false
        saveButton.disabled = false
        if (removeButton) removeButton.disabled = false
        saveButton.innerHTML = `${icon('i-check', 'ico ico-sm')} Salvar objetivo`
        toast('Não deu pra salvar o objetivo', 'err')
        return
      }
      const saved = String(r.objective || '').trim()
      if (typeof onSaved === 'function') onSaved(saved)
      closeObjectiveEditor(false)
      toast(saved ? 'Objetivo salvo para esta pessoa' : 'Objetivo removido')
      if (anchor?.isConnected) anchor.focus()
    }

    saveButton.addEventListener('click', () => persist(input.value.trim()))
    removeButton?.addEventListener('click', () => persist(''))
    cancelButton.addEventListener('click', () => closeObjectiveEditor(true))
    closeButton.addEventListener('click', () => closeObjectiveEditor(true))
    root.addEventListener('pointerdown', (e) => { if (e.target === root) closeObjectiveEditor(true) })

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeObjectiveEditor(true); return }
      if (e.key !== 'Tab') return
      const focusable = $$('button:not([disabled]):not([hidden]), textarea:not([disabled])', sheet)
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    objectiveDialog = { root, anchor, onKey }
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length) })
  }

  // ---------------------------------------------------------------- regra de cobrança por pessoa
  // Cobrar nunca é só um interruptor: a autorização só vale junto do motivo factual escrito
  // pelo usuário. Este editor único é usado por TODOS os canais — Tinder, WhatsApp,
  // Instagram, Badoo, Telegram e Meu Patrocínio. O `generateDraft` é compartilhado e lê a
  // regra por `personId`, então um canal sem o interruptor não é um canal sem cobrança: é um
  // canal onde ela existe e ninguém consegue autorizar.
  let cobrancaDialog = null
  const COBRANCA_CANAIS = { tinder: 'Tinder', whatsapp: 'WhatsApp', instagram: 'Instagram', badoo: 'Badoo', telegram: 'Telegram', meupatrocinio: 'Meu Patrocínio' }

  function tempoDesdeCobranca(ts) {
    const d = Number(ts)
    if (!Number.isFinite(d) || d <= 0) return ''
    const segundos = Math.max(0, Math.floor((Date.now() - d) / 1000))
    if (segundos < 60) return 'agora'
    const minutos = Math.floor(segundos / 60)
    if (minutos < 60) return `há ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}`
    const horas = Math.floor(minutos / 60)
    if (horas < 24) return `há ${horas} ${horas === 1 ? 'hora' : 'horas'}`
    const dias = Math.floor(horas / 24)
    if (dias < 30) return `há ${dias} ${dias === 1 ? 'dia' : 'dias'}`
    const meses = Math.floor(dias / 30)
    if (meses < 12) return `há ${meses} ${meses === 1 ? 'mês' : 'meses'}`
    const anos = Math.max(1, Math.floor(dias / 365))
    return `há ${anos} ${anos === 1 ? 'ano' : 'anos'}`
  }

  function resumoHistoricoCobranca(historico) {
    const total = Math.max(0, Number(historico?.total) || 0)
    if (!total) return 'nenhuma cobrança enviada'
    const ultima = historico?.itens?.[0]?.ts
    const quando = ultima ? tempoDesdeCobranca(ultima) : ''
    return `${total} ${total === 1 ? 'cobrança' : 'cobranças'}${quando ? ` · última ${quando}` : ''}`
  }

  function tempoParaResponder(ms) {
    const minutos = Math.max(1, Math.floor((Number(ms) || 0) / 60_000))
    if (minutos < 60) return `${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}`
    const horas = Math.floor(minutos / 60)
    if (horas < 24) return `${horas} ${horas === 1 ? 'hora' : 'horas'}`
    const dias = Math.floor(horas / 24)
    return `${dias} ${dias === 1 ? 'dia' : 'dias'}`
  }

  function historicoCobrancaItemHtml(item) {
    const quando = tempoDesdeCobranca(item.ts)
    const data = new Date(Number(item.ts)).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    const acao = item.tipo === 'pedido_unico' ? 'Pedido único' : 'Cobrança'
    const feedback = item.feedback || { estado: 'sem_resposta' }
    let feedbackHtml = '<div class="cobranca-feedback aguardando"><b>Feedback</b><span>Sem resposta até agora.</span></div>'
    if (feedback.estado === 'recebido') {
      feedbackHtml = `<div class="cobranca-feedback recebido"><b>Feedback recebido</b><span>${esc(feedback.texto || 'Resposta sem texto.')}</span><small>respondeu ${esc(tempoParaResponder(feedback.aposMs))} depois · ${esc(tempoDesdeCobranca(feedback.ts))}</small></div>`
    } else if (feedback.estado === 'indireto') {
      feedbackHtml = `<div class="cobranca-feedback indireto"><b>Resposta posterior</b><span>${esc(feedback.texto || 'Resposta sem texto.')}</span><small>Outra mensagem saiu antes; não dá para atribuir este retorno diretamente à cobrança.</small></div>`
    }
    return `<li><span class="cobranca-history-mark">${icon('i-check', 'ico ico-sm')}</span><span><b>${acao}</b><small>${esc(COBRANCA_CANAIS[item.canal] || item.canal || 'Canal')}</small></span><time datetime="${new Date(Number(item.ts)).toISOString()}" title="${esc(data)}">${esc(quando)}</time>${feedbackHtml}</li>`
  }

  function closeCobrancaEditor(refocus = true) {
    if (!cobrancaDialog) return
    const state = cobrancaDialog
    cobrancaDialog = null
    document.removeEventListener('keydown', state.onKey, true)
    state.root.remove()
    document.body.classList.remove('cobranca-open')
    if (refocus && state.anchor?.isConnected) state.anchor.focus()
  }

  async function openCobrancaEditor({ personId, name = '', anchor, onSaved } = {}) {
    if (!personId) { toast('Não consegui identificar esta pessoa', 'err'); return }
    closeCobrancaEditor(false)
    closeObjectiveEditor(false)
    const atual = await api(`/api/self/cobranca/pessoa?personId=${encodeURIComponent(personId)}`)
    if (!atual) { toast('Não deu pra abrir a regra de cobrança', 'err'); return }
    const motivoAtual = String(atual.motivo || '').trim()
    const historico = atual.historico || { total: 0, itens: [] }
    const itensHistorico = Array.isArray(historico.itens) ? historico.itens : []
    const historicoHtml = itensHistorico.length
      ? itensHistorico.map((item) => historicoCobrancaItemHtml(item)).join('')
      : '<li class="cobranca-history-empty">O Tim ainda não cobrou esta pessoa.</li>'
    let enabled = !!atual.cobrancaAutorizada
    const root = el('div', 'objective-overlay cobranca-overlay')
    root.innerHTML = `
      <section class="objective-sheet cobranca-sheet" role="dialog" aria-modal="true" aria-labelledby="cobrancaTitle" aria-describedby="cobrancaHelp">
        <div class="objective-sheet-head">
          <div>
            <span class="objective-kicker">Regra por pessoa</span>
            <h2 id="cobrancaTitle">Cobrança${name ? ` de ${esc(name)}` : ''}</h2>
          </div>
          <button class="icon-btn cobranca-close" type="button" aria-label="Fechar">${icon('i-x', 'ico')}</button>
        </div>
        <div class="objective-principle cobranca-principle" id="cobrancaHelp">
          <span class="objective-principle-icon">${icon('i-card', 'ico')}</span>
          <span><b>O Tim usa exatamente a sua justificativa</b><small>Ele não inventa serviço, entrega, valor, dívida ou prazo. Sem motivo, a cobrança não pode ser ativada.</small></span>
        </div>
        <button class="cobranca-permissao" type="button" role="switch" aria-checked="${enabled}" aria-label="Tim pode cobrar esta pessoa">
          <span><b>Tim pode cobrar</b><small class="cobranca-permissao-status"></small></span>
          <span class="toggle" aria-hidden="true"></span>
        </button>
        <label class="objective-label" for="cobrancaMotivoInput">Por que esta pessoa deve pagar?</label>
        <textarea class="objective-input cobranca-motivo-input" id="cobrancaMotivoInput" maxlength="500" rows="4"
          placeholder="Ex.: desenvolvimento do módulo de pagamentos entregue&#10;Ex.: edição de três vídeos concluída">${esc(motivoAtual)}</textarea>
        <div class="objective-input-meta">
          <span>Descreva o trabalho ou a entrega concreta. Inclua valor e prazo somente se quiser que o Tim os mencione.</span>
          <span class="cobranca-counter">${motivoAtual.length}/500</span>
        </div>
        <section class="cobranca-history" aria-labelledby="cobrancaHistoryTitle">
          <div class="cobranca-history-head">
            <span><b id="cobrancaHistoryTitle">Histórico de cobranças</b><small>Envio confirmado e feedback recebido depois.</small></span>
            <strong>${Number(historico.total) || 0} ${(Number(historico.total) || 0) === 1 ? 'vez' : 'vezes'}</strong>
          </div>
          <ul>${historicoHtml}</ul>
        </section>
        <div class="objective-actions">
          <span class="objective-action-spacer"></span>
          <button class="btn ghost cobranca-cancel" type="button">Cancelar</button>
          <button class="btn cobranca-save" type="button">${icon('i-check', 'ico ico-sm')} Salvar regra</button>
        </div>
      </section>`
    document.body.appendChild(root)
    document.body.classList.add('cobranca-open')
    const sheet = $('.cobranca-sheet', root)
    const input = $('#cobrancaMotivoInput', root)
    const counter = $('.cobranca-counter', root)
    const toggle = $('.cobranca-permissao', root)
    const status = $('.cobranca-permissao-status', root)
    const saveButton = $('.cobranca-save', root)
    const cancelButton = $('.cobranca-cancel', root)
    const closeButton = $('.cobranca-close', root)
    const paintEnabled = () => {
      toggle.setAttribute('aria-checked', String(enabled))
      toggle.classList.toggle('on', enabled)
      status.textContent = enabled ? 'autorizado a usar o motivo abaixo' : 'bloqueado; o motivo pode ficar salvo'
    }
    paintEnabled()
    toggle.addEventListener('click', () => { enabled = !enabled; paintEnabled() })
    input.addEventListener('input', () => { counter.textContent = `${input.value.length}/500` })

    let saving = false
    saveButton.addEventListener('click', async () => {
      if (saving) return
      const motivo = input.value.trim()
      if (enabled && !motivo) { toast('Escreva por que esta pessoa deve pagar', 'err'); input.focus(); return }
      saving = true
      saveButton.disabled = true
      toggle.disabled = true
      saveButton.innerHTML = '<span class="spin"></span> Salvando…'
      const r = await post('/api/self/cobranca/autorizar', { personId, enabled, motivo })
      if (!r || !r.ok) {
        saving = false
        saveButton.disabled = false
        toggle.disabled = false
        saveButton.innerHTML = `${icon('i-check', 'ico ico-sm')} Salvar regra`
        return
      }
      if (typeof onSaved === 'function') onSaved(r)
      closeCobrancaEditor(false)
      toast(r.cobrancaAutorizada ? 'Regra salva: o Tim pode cobrar' : 'Cobrança bloqueada; motivo salvo')
      if (anchor?.isConnected) anchor.focus()
    })
    cancelButton.addEventListener('click', () => closeCobrancaEditor(true))
    closeButton.addEventListener('click', () => closeCobrancaEditor(true))
    root.addEventListener('pointerdown', (e) => { if (e.target === root) closeCobrancaEditor(true) })
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCobrancaEditor(true); return }
      if (e.key !== 'Tab') return
      const focusable = $$('button:not([disabled]), textarea:not([disabled])', sheet)
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    cobrancaDialog = { root, anchor, onKey }
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length) })
  }

  // ---------------------------------------------------------------- estado
  const S = {
    tab: 'pessoas',
    lastConversationTab: 'pessoas',
    filter: 'all',          // a aba Tinder abre mostrando todas as conversas, por recência
    peopleQuery: '',
    state: null,           // /api/state
    open: null,            // personId aberto no drawer
    detail: null,          // /api/person/:id atual
    gallery: 0,            // índice da foto no carrossel
    channel: 'tinder',     // canal ativo no compositor
    cfgGrupo: 'ia',        // grupo aberto na Config (sobrevive ao recarregar da própria aba)
    generating: false,
    peopleReq: 0,          // guarda contra respostas fora de ordem
    visiblePeople: [],
    selectedOpeners: new Set(),
  }

  // estado do cliente de WhatsApp (aba WhatsApp)
  const WA = {
    chats: [],             // lista de /api/wa/chats
    sub: 'conversas',      // sub-aba do WhatsApp: 'conversas' | 'aprovacoes'
    query: '',              // busca local na lista
    filtroIa: '',           // '' | 'on' | 'off' — filtro pelo interruptor da IA
    openJid: null,         // conversa aberta na thread
    chat: null,            // /api/wa/chat da conversa aberta
    listTimer: null,       // polling da lista (~10s)
    threadTimer: null,     // polling da thread aberta (~5s)
    connTimer: null,       // polling do estado de conexão durante o pareamento (~2.5s)
    sending: false,        // há um envio em voo (segura o poll pra não sumir a bolha otimista)
    audios: null,          // cache dos áudios salvos ativos (picker "/"); null = recarregar
  }

  // player de áudio único: um <audio> compartilhado toca por vez. O controle visível
  // é próprio (botão + barra), e como a thread se repinta a cada poll, guardamos o
  // arquivo tocando aqui pra re-vincular a bolha nova ao mesmo áudio em andamento.
  const AUDIO = {
    file: null,            // arquivo do áudio carregado no elemento
    node: null,            // <audio> escondido (criado sob demanda)
    ui: null,              // { file, wrap } da bolha atualmente ligada ao player
  }

  // ---------------------------------------------------------------- abas
  const conversationTabs = new Set(['pessoas', 'whatsapp', 'instagram', 'badoo', 'mp', 'tg'])
  function mobileDestinationFor(name) {
    if (conversationTabs.has(name)) return 'conversas'
    if (name === 'monitor') return 'atividade'
    if (name === 'diario' || name === 'config' || name === 'mais') return 'mais'
    return name
  }

  function syncMobileShell(name) {
    const inConversations = conversationTabs.has(name)
    document.body.dataset.activeTab = name
    const channels = $('#mobileChannels')
    if (channels) {
      channels.hidden = !inConversations
      $$('[data-tab]', channels).forEach((b) => {
        const on = b.dataset.tab === name
        b.classList.toggle('active', on)
        b.setAttribute('aria-selected', String(on))
      })
    }
    const destination = mobileDestinationFor(name)
    $$('#mobileNav [data-mobile-dest]').forEach((b) => {
      const on = b.dataset.mobileDest === destination
      b.classList.toggle('active', on)
      if (on) b.setAttribute('aria-current', 'page')
      else b.removeAttribute('aria-current')
    })
  }

  function setTab(name) {
    if (name === 'conversas') name = S.lastConversationTab || 'pessoas'
    if (conversationTabs.has(name)) S.lastConversationTab = name
    S.tab = name
    $$('#tabs .tab').forEach((b) => {
      const on = b.dataset.tab === name
      b.classList.toggle('active', on)
      b.setAttribute('aria-selected', String(on))
    })
    $('#view-assistente').hidden = name !== 'assistente'
    $('#view-pessoas').hidden = name !== 'pessoas'
    $('#view-descoberta').hidden = name !== 'descoberta'
    $('#view-whatsapp').hidden = name !== 'whatsapp'
    $('#view-instagram').hidden = name !== 'instagram'
    $('#view-badoo').hidden = name !== 'badoo'
    $('#view-mp').hidden = name !== 'mp'
    $('#view-tg').hidden = name !== 'tg'
    $('#view-agenda').hidden = name !== 'agenda'
    $('#view-projetos').hidden = name !== 'projetos'
    $('#view-progresso').hidden = name !== 'progresso'
    $('#view-monitor').hidden = name !== 'monitor'
    $('#view-diario').hidden = name !== 'diario'
    $('#view-vinculos').hidden = name !== 'vinculos'
    $('#view-config').hidden = name !== 'config'
    $('#view-hoje').hidden = name !== 'hoje'
    $('#view-mais').hidden = name !== 'mais'
    const fab = $('#captureFab'); if (fab) fab.hidden = name !== 'projetos'
    syncMobileShell(name)
    if (name !== 'whatsapp') stopWaPolling()  // não fica sondando WhatsApp fora da aba
    if (name !== 'instagram') stopIgPolling()  // idem Instagram
    if (name !== 'badoo') stopBadooPolling()   // idem Badoo
    if (name !== 'monitor') stopMonitorPoll()  // idem Monitor
    if (name === 'whatsapp') loadWa()
    if (name === 'instagram') loadIg()
    if (name === 'badoo') loadBadoo()
    if (name === 'mp') loadMp()
    if (name !== 'mp') stopMpPoll()
    if (name === 'tg') loadTg()
    if (name !== 'tg') stopTgPoll()
    if (name === 'agenda') loadAgenda()
    if (name === 'monitor') { loadMonitor(); startMonitorPoll() }
    if (name === 'diario') loadLog()
    if (name === 'config') loadConfig()
    if (name === 'pessoas') loadPeople()
    if (name === 'hoje') loadHome()
    if (name === 'projetos') loadProjetos()
    if (name === 'progresso') loadProgresso()
    if (name === 'vinculos') loadVinculos()
    if (name === 'descoberta') loadDescoberta()
    if (name === 'assistente') loadAssistente()
  }
  $$('#tabs .tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)))
  $$('#mobileChannels [data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)))
  $$('#mobileNav [data-mobile-dest]').forEach((b) => b.addEventListener('click', () => {
    const dest = b.dataset.mobileDest
    setTab(dest === 'atividade' ? 'monitor' : dest)
  }))
  $$('[data-go-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.goTab)))
  $('#mobileTopStatus').addEventListener('click', () => setTab('mais'))

  // ---------------------------------------------------------------- status topo
  function dotClass(kind) { return kind === 'on' ? 'dot on' : kind === 'warn' ? 'dot warn pulse' : kind === 'off' ? 'dot off' : 'dot' }

  async function loadState() {
    const st = await api('/api/state')
    if (!st) return
    S.state = st
    // Tinder
    // O selo diz o que foi OBSERVADO, não o que está salvo no banco (ver `estadoHonesto` no
    // servidor). 'PENDENTE' é amarelo de propósito: credencial existe, prova ainda não —
    // pintar de verde nesse estado é exatamente a mentira que a gente tirou daqui.
    const t = st.tinder || {}
    const tOn = t.status === 'CONNECTED'
    $('#dotTinder').className = dotClass(tOn ? 'on' : t.status === 'PENDENTE' ? 'warn' : t.status === 'CAIDO' ? 'off' : 'idle')
    $('#lblTinder').textContent = tOn ? (t.name || 'Tinder') : t.status === 'CAIDO' ? 'Tinder caiu' : t.status === 'PENDENTE' ? 'Tinder…' : 'Tinder off'
    $('#stTinder').classList.toggle('up', tOn)
    $('#stTinder').title = tOn ? (t.name || 'Tinder conectado')
      : t.status === 'CAIDO' ? `Tinder caiu: ${t.motivo || 'sessão recusada'}${t.comoResolver ? ' — ' + t.comoResolver : ''}`
        : t.status === 'PENDENTE' ? 'sessão salva, ainda não verificada' : 'Tinder nunca foi conectado'
    // WhatsApp
    const w = st.wa || {}
    const waDot = w.status === 'CONNECTED' ? 'on'
      : (w.status === 'CONNECTING' || w.status === 'QR_READY') ? 'warn'
        : (w.status === 'REPAIR_REQUIRED') ? 'off' : 'idle'
    $('#dotWa').className = dotClass(waDot)
    $('#lblWa').textContent = w.status === 'CONNECTED' ? (w.name || 'WhatsApp') : (w.status === 'QR_READY' ? 'ler QR' : w.status === 'CONNECTING' ? 'conectando' : w.status === 'REPAIR_REQUIRED' ? 'reparar' : 'WhatsApp')
    $('#stWa').classList.toggle('up', w.status === 'CONNECTED')
    const mt = $('#mDotTinder')
    const mw = $('#mDotWa')
    if (mt) mt.className = t.connected ? 'on' : 'off'
    if (mw) mw.className = waDot
    // Instagram e Badoo (não vêm no /api/state; puxam o status leve à parte)
    loadIgStatusPill()
    loadBadooStatusPill()
    // contagens nos filtros + badge
    const c = st.counts || {}
    $$('#filters .cnt').forEach((n) => { const k = n.dataset.cnt; if (c[k] != null) n.textContent = c[k] })
    const badge = $('#tabPending')
    if (c.pendentes) { badge.textContent = c.pendentes; badge.hidden = false } else { badge.hidden = true }
    const abadge = $('#tabAgenda')
    if (abadge) { if (c.agenda) { abadge.textContent = c.agenda; abadge.hidden = false } else { abadge.hidden = true } }
    const pbadge = $('#tabProjetos')
    if (pbadge) { if (c.projetos) { pbadge.textContent = c.projetos; pbadge.hidden = false } else { pbadge.hidden = true } }
    const vbadge = $('#tabVinculos')
    if (vbadge) { if (c.vinculos) { vbadge.textContent = c.vinculos; vbadge.hidden = false } else { vbadge.hidden = true } }
    const mp = $('#mobilePendingBadge')
    if (mp) { mp.textContent = c.pendentes || 0; mp.hidden = !c.pendentes }
    const ma = $('#mobileAgendaBadge')
    if (ma) { ma.textContent = c.agenda || 0; ma.hidden = !c.agenda }
    if (S.tab === 'hoje') renderHome(st)
  }

  // ---------------------------------------------------------------- HOJE (dashboard móvel)
  async function loadHome() {
    if (!isMobileLayout() || S.tab !== 'hoje') return
    const host = $('#homeHost')
    if (!host.dataset.loaded) host.replaceChildren(el('div', 'home-loading', '<span class="spin"></span><span>organizando suas prioridades…</span>'))
    const st = S.state || await api('/api/state')
    if (S.tab !== 'hoje') return
    if (st) { S.state = st; renderHome(st) }
  }

  function renderHome(st) {
    const host = $('#homeHost')
    if (!host || S.tab !== 'hoje') return
    host.dataset.loaded = '1'
    const c = st.counts || {}
    const t = st.tinder || {}
    const w = st.wa || {}
    const waOn = w.status === 'CONNECTED'
    const pending = Number(c.pendentes || 0)
    const agenda = Number(c.agenda || 0)
    const priorityCopy = pending || agenda
      ? `${pending ? `${pending} conversa${pending === 1 ? '' : 's'} esperando` : ''}${pending && agenda ? ' · ' : ''}${agenda ? `${agenda} compromisso${agenda === 1 ? '' : 's'} para revisar` : ''}`
      : 'Tudo em dia por enquanto.'
    const wrap = el('div', 'home-stack')
    wrap.innerHTML = `
      <section class="home-priority-card">
        <span class="home-card-kicker">${pending || agenda ? 'Pede atenção' : 'Tudo certo'}</span>
        <h2>${esc(priorityCopy)}</h2>
        <div class="home-priority-actions">
          <button type="button" class="home-action primary" data-home-tab="pessoas">
            ${icon('i-chat')}<span><b>Ver conversas</b><small>${pending ? `${pending} pendente${pending === 1 ? '' : 's'}` : 'nenhuma pendência'}</small></span>
          </button>
          <button type="button" class="home-action" data-home-tab="agenda">
            ${icon('i-cal')}<span><b>Abrir agenda</b><small>${agenda ? `${agenda} para revisar` : 'mês organizado'}</small></span>
          </button>
          <button type="button" class="home-action" data-home-tab="assistente">
            ${icon('i-chat')}<span><b>Falar com o vendas-multicanal</b><small>marcar, lembrar, perguntar</small></span>
          </button>
        </div>
      </section>
      <section class="home-section">
        <div class="home-section-head"><h2>Conexões</h2><button type="button" data-home-tab="mais">Gerenciar</button></div>
        <div class="home-connections">
          <button type="button" data-home-tab="pessoas"><i class="${t.status === 'CONNECTED' ? 'on' : 'off'}"></i>${icon('i-heart')}<span><b>Tinder</b><small>${esc(t.status === 'CONNECTED' ? (t.name || 'conectado') : t.status === 'CAIDO' ? (t.motivo || 'caiu') : t.status === 'PENDENTE' ? 'não verificado' : 'desconectado')}</small></span>${icon('i-arrow-r', 'ico ico-sm')}</button>
          <button type="button" data-home-tab="whatsapp"><i class="${waOn ? 'on' : (w.status === 'CONNECTING' || w.status === 'QR_READY') ? 'warn' : 'off'}"></i>${icon('i-wa')}<span><b>WhatsApp</b><small>${esc(waOn ? (w.name || 'conectado') : w.status === 'QR_READY' ? 'aguardando QR' : 'precisa de atenção')}</small></span>${icon('i-arrow-r', 'ico ico-sm')}</button>
          <button type="button" data-home-tab="instagram"><i id="homeIgDot"></i>${icon('i-ig')}<span><b>Instagram</b><small id="homeIgText">verificando…</small></span>${icon('i-arrow-r', 'ico ico-sm')}</button>
        </div>
      </section>
      <section class="home-projects">
        <span class="home-project-icon">${icon('i-grid')}</span>
        <span><b>Projetos</b><small>A estrutura móvel já está pronta para receber seus projetos sem sobrecarregar a navegação.</small></span>
        <span class="mobile-soon">em breve</span>
      </section>`
    $$('[data-home-tab]', wrap).forEach((b) => b.addEventListener('click', () => setTab(b.dataset.homeTab)))
    host.replaceChildren(wrap)
    api('/api/ig').then((ig) => {
      if (!$('#homeIgDot') || S.tab !== 'hoje') return
      const on = ig && ig.status === 'CONNECTED'
      $('#homeIgDot').className = on ? 'on' : 'off'
      $('#homeIgText').textContent = on ? (ig.me || 'conectado') : 'precisa de atenção'
    })
  }

  // ---------------------------------------------------------------- PESSOAS
  function skeleton() {
    const g = el('div', 'skeleton-grid')
    for (let i = 0; i < 8; i++) g.appendChild(el('div', 'sk'))
    return g
  }
  function emptyState(icoId, title, body) {
    return el('div', 'empty', `${icon(icoId, 'ico')}<h3>${esc(title)}</h3><p>${esc(body)}</p>`)
  }

  const TINDER_LINK_META = {
    whatsapp: { label: 'WhatsApp', ico: 'i-wa' },
    instagram: { label: 'Instagram', ico: 'i-ig' },
    badoo: { label: 'Badoo', ico: 'i-badoo' },
  }
  function tinderLinkedChannels(p) {
    return [...new Set((p?.linkedChannels || p?.identity?.linkedChannels || []).filter((channel) => TINDER_LINK_META[channel]))]
  }
  function tinderLinkTagsHtml(p) {
    return tinderLinkedChannels(p).map((channel) => {
      const meta = TINDER_LINK_META[channel]
      return `<button class="wc-tag wc-tag-btn tinder-link-tag channel-${esc(channel)}" type="button" data-tinder-link="${esc(channel)}" title="Ver ou alterar o vínculo no ${esc(meta.label)}">${icon(meta.ico, 'ico ico-sm')} ${esc(meta.label)}</button>`
    }).join('')
  }
  function bindTinderLinkTags(root, p) {
    $$('[data-tinder-link]', root).forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        void editTinderIdentity(p.personId)
      })
      button.addEventListener('keydown', (event) => event.stopPropagation())
    })
  }

  function personCard(p) {
    const shell = el('article', 'card-shell' + (p.canSendOpener ? ' opener' : ''))
    const c = el('button', 'card')
    c.dataset.id = p.personId
    const photo = p.photo
      ? `<img class="photo" src="${esc(p.photo)}" alt="" loading="lazy" onerror="this.classList.add('ph');this.removeAttribute('src');this.innerHTML=''">`
      : `<div class="photo ph">${icon('i-cam', 'ico ico-lg')}</div>`

    const badges = []
    if (p.pending) badges.push(`<span class="badge pending" title="Aguardando resposta"><span class="pdot"></span></span>`)
    const aiOn = p.aiTinder || p.aiWhatsapp || p.aiInstagram
    if (aiOn) badges.push(`<span class="badge ai push" title="IA automática ligada">${icon('i-bot', 'ico')} IA</span>`)
    const linked = tinderLinkedChannels(p)
    linked.forEach((channel, index) => {
      const meta = TINDER_LINK_META[channel]
      badges.push(`<span class="badge network channel-${esc(channel)} ${!aiOn && index === 0 ? 'push' : ''}" title="Vinculada ao ${esc(meta.label)}">${icon(meta.ico, 'ico')}</span>`)
    })

    const last = p.lastText
      ? `<div class="last">${p.lastDir === 'eu' ? (p.lastAuthor === 'ia' ? '<span class="arrow ia">IA</span>' : '<span class="arrow">↗</span>') : ''}<span class="txt">${esc(p.lastText)}</span></div>`
      : `<div class="last empty">sem mensagens ainda</div>`

    c.innerHTML = `
      ${photo}
      <div class="scrim"></div>
      <div class="badges">${badges.join('')}</div>
      <div class="meta">
        <div class="who"><span class="nm">${esc(p.name || 'Sem nome')}</span>${p.age ? `<span class="ag">${esc(p.age)}</span>` : ''}${metricasNomeHtml(p.metricas)}</div>
        ${last}
      </div>`
    c.addEventListener('click', () => openPerson(p.personId))
    shell.appendChild(c)
    if (linked.length) {
      const edit = el('button', 'card-link-action', `${icon('i-link', 'ico ico-sm')}<span>Vínculos</span>`)
      edit.type = 'button'
      edit.title = `Ver ou alterar: ${linked.map((channel) => TINDER_LINK_META[channel].label).join(' e ')}`
      edit.setAttribute('aria-label', edit.title)
      edit.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        void editTinderIdentity(p.personId)
      })
      shell.appendChild(edit)
    }
    if (p.canSendOpener) shell.appendChild(openerActions(p, 'em-card'))
    return shell
  }

  // Item de LISTA (inbox) de uma pessoa do Tinder — mesma aparência das conversas de
  // WhatsApp/Instagram (.wc-item), em ordem de recência.
  function personListItem(p) {
    const item = el('div', 'wc-item' + (S.open === p.personId ? ' active' : ''))
    item.setAttribute('role', 'button'); item.setAttribute('tabindex', '0')
    item.dataset.pid = p.personId
    const title = (p.name || 'Sem nome') + (p.age ? ', ' + p.age : '')
    // "você:" só quando foi VOCÊ. Mensagem da IA leva o rótulo dela — é a diferença entre
    // saber e não saber o que está saindo em seu nome.
    const quem = p.lastDir === 'eu' ? (p.lastAuthor === 'ia' ? '<b class="prev-ia">IA:</b> ' : 'você: ') : ''
    const prev = p.lastText ? quem + esc(p.lastText) : '<i class="mute">sem mensagens ainda</i>'
    const when = p.lastTs ? timeAgo(p.lastTs) : ''
    const linkTags = tinderLinkTagsHtml(p)
    const pend = p.pending ? '<span class="wc-unread pend" title="Aguardando sua resposta">•</span>' : ''
    const showAi = p.conversationState === 'conversation'
    item.innerHTML = `
      ${avatarHtml(p.name || '?', p.photo)}
      <div class="wc-item-main">
        <div class="wc-item-top">
          <span class="wc-nm">${esc(title)}</span>
          ${metricasNomeHtml(p.metricas)}
          ${linkTags}
          ${when ? `<span class="wc-when">${esc(when)}</span>` : ''}
        </div>
        <div class="wc-item-bot">
          <span class="wc-prev">${prev}</span>
          <span class="wc-flags">${pend}</span>
        </div>
      </div>
      ${showAi ? `<div class="wc-item-ai-wrap">
        <span class="wc-item-ai-lbl">${icon('i-bot', 'ico ico-sm')}<span class="wc-item-ai-text">IA</span></span>
        <button class="toggle sm wc-item-ai" role="switch" aria-checked="${p.aiTinder ? 'true' : 'false'}" aria-label="IA responde no Tinder" title="IA responde no Tinder"></button>
      </div>` : ''}`
    bindTinderLinkTags(item, p)
    if (showAi) {
      const tg = item.querySelector('.wc-item-ai')
      tg.addEventListener('click', (e) => { e.stopPropagation(); toggleTinderAi(p.personId, tg.getAttribute('aria-checked') !== 'true', tg) })
      tg.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleTinderAi(p.personId, tg.getAttribute('aria-checked') !== 'true', tg) } })
    } else if (p.canSendOpener) {
      item.appendChild(openerActions(p, 'list'))
    } else {
      item.appendChild(el('span', 'opener-checking', '<span class="spin"></span> conferindo histórico'))
    }
    item.addEventListener('click', () => openPerson(p.personId))
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPerson(p.personId) } })
    return item
  }

  const OPENER_BUSY = new Set(['queued', 'generating', 'sending'])
  function openerBusy(p) { return OPENER_BUSY.has(p.openerState) }
  function openerButtonLabel(p, compact = false) {
    if (p.openerState === 'queued') return compact ? 'Na fila' : 'Na fila para enviar'
    if (p.openerState === 'generating') return compact ? 'Gerando…' : 'Gerando mensagem…'
    if (p.openerState === 'sending') return compact ? 'Enviando…' : 'Enviando mensagem…'
    if (p.openerState === 'error') return compact ? 'Tentar de novo' : 'Tentar primeira mensagem de novo'
    return compact ? 'Mandar 1ª mensagem' : 'Mandar primeira mensagem'
  }

  function setOpenerSelected(personId, selected) {
    if (selected) S.selectedOpeners.add(personId)
    else S.selectedOpeners.delete(personId)
    refreshOpenerSelectionUi()
  }

  // `place` NUNCA pode ser 'card': `.card` é a classe do componente card inteiro (foto,
  // aspect-ratio 3/4, overflow hidden, fundo). Enquanto foi 'card', esta barrinha herdava
  // TUDO daquilo e virava um card opaco de 100% da altura por cima da foto — medido no
  // navegador em 11/08/2026: altura 256 de 256, display block em vez de flex. Nome de
  // modificador que colide com nome de componente não dá erro em lugar nenhum: só desenha
  // errado, e em silêncio.
  function openerActions(p, place) {
    const wrap = el('div', `opener-actions ${place}`)
    wrap.dataset.openerId = p.personId
    const select = el('button', 'opener-select', icon('i-check', 'ico ico-sm'))
    select.type = 'button'
    select.disabled = openerBusy(p)
    select.setAttribute('aria-pressed', String(S.selectedOpeners.has(p.personId)))
    select.setAttribute('aria-label', `Selecionar ${p.name || 'esta pessoa'} para primeira mensagem`)
    select.title = 'Selecionar para enviar junto com outras pessoas'
    select.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      setOpenerSelected(p.personId, !S.selectedOpeners.has(p.personId))
    })
    const send = el('button', 'opener-send', `${icon(openerBusy(p) ? 'i-bot' : 'i-send', 'ico ico-sm')}<span>${esc(openerButtonLabel(p, place === 'em-card'))}</span>`)
    send.type = 'button'
    send.disabled = openerBusy(p)
    send.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void queueOpeners([p.personId], send)
    })
    wrap.append(select, send)
    return wrap
  }

  function openerToolbar(people) {
    const candidates = people.filter((p) => p.canSendOpener && !openerBusy(p))
    if (!candidates.length && !S.selectedOpeners.size) return null
    const bar = el('section', 'opener-toolbar')
    bar.setAttribute('aria-label', 'Envio de primeiras mensagens em lote')
    const selectAll = el('button', 'opener-select-all', '')
    selectAll.type = 'button'
    selectAll.dataset.openerSelectAll = 'true'
    selectAll.addEventListener('click', () => {
      const allSelected = candidates.length > 0 && candidates.every((p) => S.selectedOpeners.has(p.personId))
      candidates.forEach((p) => setOpenerSelected(p.personId, !allSelected))
      refreshOpenerSelectionUi()
    })
    const hint = el('span', 'opener-toolbar-hint', '<b>Primeiras mensagens</b><small>Selecione várias; o vendas-multicanal confere e envia uma por vez</small>')
    const send = el('button', 'opener-bulk-send', '')
    send.type = 'button'
    send.dataset.openerBulkSend = 'true'
    send.addEventListener('click', () => {
      const selected = candidates.filter((p) => S.selectedOpeners.has(p.personId)).map((p) => p.personId)
      void queueOpeners(selected, send)
    })
    // DUAS INTENÇÕES, DOIS BOTÕES. "Abrir a porta" e "abrir e ficar atendendo" são decisões
    // diferentes, e até 11/08/2026 só existia a primeira — a IA mandava 139 primeiras
    // mensagens e não respondia nenhuma resposta, porque o interruptor dela seguia desligado.
    //
    // O secundário é o de LIGAR, e é secundário de propósito: mensagem enviada não volta, e
    // conversa que responde sozinha também não. A contagem vai no rótulo porque interruptor
    // em massa sem número é o tipo de coisa que se clica sem sentir o peso.
    const sendAi = el('button', 'opener-bulk-send ligar', '')
    sendAi.type = 'button'
    sendAi.dataset.openerBulkSendAi = 'true'
    sendAi.title = 'Manda a primeira mensagem E deixa a IA respondendo essas conversas'
    sendAi.addEventListener('click', () => {
      const selected = candidates.filter((p) => S.selectedOpeners.has(p.personId)).map((p) => p.personId)
      void queueOpeners(selected, sendAi, { ligarIa: true })
    })
    bar.append(selectAll, hint, send, sendAi)
    requestAnimationFrame(refreshOpenerSelectionUi)
    return bar
  }

  function refreshOpenerSelectionUi() {
    const visibleIds = new Set(S.visiblePeople.filter((p) => p.canSendOpener && !openerBusy(p)).map((p) => p.personId))
    for (const control of $$('[data-opener-id]')) {
      const selected = S.selectedOpeners.has(control.dataset.openerId)
      const button = $('.opener-select', control)
      if (button) button.setAttribute('aria-pressed', String(selected))
      control.classList.toggle('selected', selected)
    }
    const selectedVisible = [...S.selectedOpeners].filter((id) => visibleIds.has(id))
    const allSelected = visibleIds.size > 0 && selectedVisible.length === visibleIds.size
    const selectAll = $('[data-opener-select-all]')
    if (selectAll) {
      selectAll.setAttribute('aria-pressed', String(allSelected))
      selectAll.innerHTML = `${icon('i-check', 'ico ico-sm')} ${allSelected ? 'Desmarcar todas' : 'Selecionar todas'}`
    }
    const send = $('[data-opener-bulk-send]')
    if (send) {
      send.disabled = selectedVisible.length === 0
      // "mensagems" não existe: o plural de mensagem é mensagens. E sem seleção o rótulo
      // ficava com espaço duplo ("Mandar  primeiras").
      const n = selectedVisible.length
      send.innerHTML = `${icon('i-send', 'ico ico-sm')} ${n === 1 ? 'Mandar 1 primeira mensagem' : `Mandar${n ? ' ' + n : ''} primeiras mensagens`}`
    }
    const sendAi = $('[data-opener-bulk-send-ai]')
    if (sendAi) {
      sendAi.disabled = selectedVisible.length === 0
      sendAi.innerHTML = `${icon('i-bot', 'ico ico-sm')} Mandar e deixar a IA ligada${selectedVisible.length ? ` (${selectedVisible.length})` : ''}`
    }
  }

  async function queueOpeners(personIds, trigger, { ligarIa = false } = {}) {
    const ids = [...new Set(personIds)].filter(Boolean)
    if (!ids.length) return
    if (trigger) trigger.disabled = true
    const original = trigger?.innerHTML
    if (trigger) trigger.innerHTML = `<span class="spin"></span><span>Colocando na fila…</span>`
    const result = await post('/api/tinder/openers', { personIds: ids })
    if (trigger && trigger.isConnected) trigger.innerHTML = original
    if (!result?.ok) {
      if (trigger && trigger.isConnected) trigger.disabled = false
      toast('Não deu pra preparar as primeiras mensagens', 'err')
      return
    }
    ids.forEach((id) => S.selectedOpeners.delete(id))
    // Liga a IA DEPOIS de a fila aceitar: ligar antes deixaria conversa armada mesmo quando
    // o envio nem entrou na fila. E só nas que foram aceitas, não em toda a seleção.
    let ligadas = 0
    if (ligarIa && result.queued) {
      const alvos = Array.isArray(result.personIds) && result.personIds.length ? result.personIds : ids
      for (const id of alvos) {
        const r = await post(`/api/person/${encodeURIComponent(id)}/ai`, { channel: 'tinder', enabled: true })
        if (r && r.ok) ligadas++
      }
    }
    if (result.queued) {
      const base = result.queued === 1 ? 'Primeira mensagem colocada na fila' : `${result.queued} primeiras mensagens colocadas na fila`
      toast(ligarIa ? `${base} · IA ligada em ${ligadas}` : base)
    } else {
      toast('Essas pessoas já estavam na fila ou começaram a conversar', 'err')
    }
    loadState()
    await loadPeople()
  }

  async function toggleTinderAi(personId, next, tg) {
    if (tg) { tg.setAttribute('aria-checked', String(next)); tg.disabled = true }
    const r = await post(`/api/person/${encodeURIComponent(personId)}/ai`, { channel: 'tinder', enabled: next })
    if (tg) tg.disabled = false
    if (!r || !r.ok) { if (tg) tg.setAttribute('aria-checked', String(!next)); toast('Não deu pra mudar a IA', 'err'); return }
    toast(next ? 'IA ligada nesta conversa' : 'IA desligada')
  }

  // alternador Grade/Lista da aba Tinder (persistido)
  function applyPeopleView() { $$('#peopleView .vsw').forEach((b) => b.classList.toggle('active', b.dataset.view === S.tinderView)) }

  async function loadPeople() {
    if (S.tab !== 'pessoas') return
    const host = $('#peopleHost')
    if (!host.dataset.loaded) host.replaceChildren(skeleton())
    const reqId = ++S.peopleReq
    const people = await api(`/api/people?filter=${encodeURIComponent(S.filter)}`)
    if (reqId !== S.peopleReq) return // resposta obsoleta
    host.dataset.loaded = '1'

    if (people == null) {
      host.replaceChildren(emptyState('i-heart', 'Sem conexão com o vendas-multicanal', 'O painel está no ar, mas o vendas-multicanal ainda não respondeu. Assim que ele subir, as pessoas aparecem aqui automaticamente.'))
      return
    }
    if (!people.length) {
      const map = {
        pending: ['i-inbox', 'Nada pendente', 'Toda conversa está em dia — ninguém esperando resposta agora.'],
        matches: ['i-new', 'Sem matches parados', 'Quando surgir um match sem primeira mensagem, ele aparece aqui pra você abrir a conversa.'],
        whatsapp: ['i-wa', 'Ninguém no WhatsApp ainda', 'Quando uma conversa migrar pro WhatsApp, a pessoa aparece aqui com o histórico junto.'],
        all: ['i-heart', 'Nenhuma conversa ainda', 'Assim que o vendas-multicanal ler o Tinder, seus matches e conversas aparecem nesta grade.'],
      }
      host.replaceChildren(emptyState(...(map[S.filter] || map.all)))
      return
    }
    const visiblePeople = S.peopleQuery
      ? people.filter((p) => norm(`${p.name || ''} ${p.lastText || ''} ${p.city || ''}`).includes(norm(S.peopleQuery)))
      : people
    S.visiblePeople = visiblePeople
    if (!visiblePeople.length) {
      host.replaceChildren(emptyState('i-search', 'Nada encontrado', `Nenhuma conversa corresponde a “${S.peopleQuery}”.`))
      return
    }
    // nada mudou? não encosta no DOM. Sem isso, cada aviso de fundo reconstruía 461 cartões.
    const primeiraVez = !host.querySelector('.people-results')
    if (!primeiraVez && !mudou('pessoas', visiblePeople.map((p) => [p.id, p.lastTs, p.pending, p.aiOn, p.name, p.lastText, ...metricasNomeKey(p.metricas)]))) {
      refreshOpenerSelectionUi()
      return
    }
    const scrollAntes = window.scrollY
    const result = el('div', 'people-results')
    const bulk = openerToolbar(visiblePeople)
    if (bulk) result.appendChild(bulk)
    if (S.tinderView === 'list') {
      const list = el('div', 'wc-items people-list')
      visiblePeople.forEach((p) => list.appendChild(personListItem(p)))
      result.appendChild(list)
    } else {
      const grid = el('div', 'grid')
      visiblePeople.forEach((p, i) => {
        const card = personCard(p)
        // a animação de entrada é pra PRIMEIRA pintura; numa atualização de fundo ela vira
        // um flash na tela inteira sem motivo
        const face = $('.card', card)
        if (face && primeiraVez) face.style.animationDelay = `${Math.min(i * 22, 300)}ms`
        else if (face) face.style.animation = 'none'
        grid.appendChild(card)
      })
      result.appendChild(grid)
    }
    host.replaceChildren(result)
    // o scroll é de quem está lendo, não do repinte
    if (!primeiraVez && scrollAntes) window.scrollTo({ top: scrollAntes })
    refreshOpenerSelectionUi()
  }

  // chips de filtro (só os que filtram: o atalho Descoberta mora na mesma barra)
  $$('#filters .chip[data-filter]').forEach((chip) => chip.addEventListener('click', () => {
    if (S.filter === chip.dataset.filter) return
    S.filter = chip.dataset.filter
    $$('#filters .chip').forEach((c) => c.classList.toggle('active', c === chip))
    $('#peopleHost').dataset.loaded = ''
    loadPeople()
  }))

  $('#btnPrimeira').addEventListener('click', () => abrirPrimeira('tinder', 'peopleHost'))

  // alternador Grade/Lista (persistido)
  S.tinderView = isMobileLayout()
    ? (localStorage.getItem('vendas-multicanal.tinderView.mobile') || 'list')
    : (localStorage.getItem('vendas-multicanal.tinderView') || 'grid')
  applyPeopleView()
  $$('#peopleView .vsw').forEach((b) => b.addEventListener('click', () => {
    if (S.tinderView === b.dataset.view) return
    S.tinderView = b.dataset.view
    localStorage.setItem(isMobileLayout() ? 'vendas-multicanal.tinderView.mobile' : 'vendas-multicanal.tinderView', S.tinderView)
    applyPeopleView()
    $('#peopleHost').dataset.loaded = ''
    loadPeople()
  }))
  $('#peopleSearch').addEventListener('input', (e) => {
    S.peopleQuery = e.currentTarget.value.trim()
    loadPeople()
  })

  // ---------------------------------------------------------------- DRAWER / ficha
  function openDrawer() {
    $('#drawer').classList.add('show')
    $('#drawer').setAttribute('aria-hidden', 'false')
    $('#drawerScrim').classList.add('show')
    document.body.style.overflow = 'hidden'
  }
  function closeDrawer() {
    $('#drawer').classList.remove('show')
    $('#drawer').setAttribute('aria-hidden', 'true')
    $('#drawerScrim').classList.remove('show')
    document.body.style.overflow = ''
    S.open = null; S.detail = null
  }
  $('#drawerClose').addEventListener('click', closeDrawer)
  $('#drawerScrim').addEventListener('click', closeDrawer)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.open) closeDrawer() })

  async function openPerson(id) {
    S.open = id; S.gallery = 0; S.generating = false
    $('#dNm').textContent = 'carregando…'
    $('#dMeta').textContent = ''
    $('#dIdentity').hidden = true
    $('#dObjective').hidden = true
    $('#drawerBody').replaceChildren(el('div', 'convo-empty', 'abrindo conversa…'))
    $('#drawerControls').hidden = true
    openDrawer()

    const d = await api(`/api/person/${encodeURIComponent(id)}`)
    if (S.open !== id) return
    if (!d) {
      $('#dNm').textContent = 'não deu pra abrir'
      $('#drawerBody').replaceChildren(emptyState('i-x', 'Ficha indisponível', 'O vendas-multicanal não devolveu os dados desta pessoa. Tente de novo em instantes.'))
      return
    }
    S.detail = d
    S.channel = defaultChannel()
    renderDetail(d)
  }

  async function refreshTinderIdentity(personId) {
    const listRefresh = loadPeople()
    if (S.open !== personId) { await listRefresh; return }
    const detail = await api(`/api/person/${encodeURIComponent(personId)}`)
    await listRefresh
    if (!detail || S.open !== personId) return
    S.detail = detail
    renderDetail(detail)
  }

  function editTinderIdentity(personId) {
    return abrirIdentidade(personId, () => { void refreshTinderIdentity(personId) })
  }

  function paintTinderIdentityTrigger(d) {
    const button = $('#dIdentity')
    const linked = tinderLinkedChannels(d)
    button.hidden = false
    button.classList.toggle('has-links', linked.length > 0)
    if (!linked.length) {
      button.innerHTML = `${icon('i-link', 'ico ico-sm')}<span class="lbl">Mesma pessoa</span>`
      button.title = 'Ligar esta pessoa a uma conversa do WhatsApp ou Instagram'
      button.setAttribute('aria-label', button.title)
    } else {
      const icons = linked.map((channel) => icon(TINDER_LINK_META[channel].ico, `ico ico-sm channel-${channel}`)).join('')
      const names = linked.map((channel) => TINDER_LINK_META[channel].label)
      button.innerHTML = `<span class="drawer-link-icons">${icons}</span><span class="lbl">${esc(names.join(' + '))}</span>`
      button.title = `Vínculos: ${names.join(' e ')}. Clique para alterar`
      button.setAttribute('aria-label', button.title)
    }
    button.onclick = () => { if (S.open) void editTinderIdentity(S.open) }
  }

  // Canal inicial ao abrir a ficha: SEMPRE o Tinder, porque a ficha só abre pela lista do
  // Tinder — abrir no WhatsApp fazia a tela discordar da conversa que ele acabou de ver na
  // lista (parecia que o painel estava desatualizado). O que o outro canal tem de novo é
  // mostrado no seletor, com a hora, em vez de trocar de conversa por conta própria.
  function defaultChannel() {
    return 'tinder'
  }

  // última mensagem de cada canal na timeline da pessoa (pra carimbar o seletor)
  function ultimaPorCanal(timeline) {
    const fim = { tinder: 0, whatsapp: 0 }
    ;(timeline || []).forEach((m) => { if (m && fim[m.channel] !== undefined && m.ts > fim[m.channel]) fim[m.channel] = m.ts })
    return fim
  }

  function renderDetail(d) {
    const t = d.tinder || {}
    const person = d.person || {}
    $('#dNm').innerHTML = `<span class="drawer-person-name">${esc(person.name || 'Sem nome')}</span>${metricasNomeHtml(d.metricas)}`
    const metaBits = []
    if (t.age) metaBits.push(esc(t.age))
    if (t.city) metaBits.push(esc(t.city))
    $('#dMeta').innerHTML = metaBits.length ? `${icon('i-pin', 'ico ico-sm')} ${metaBits.join(' · ')}` : ''
    paintTinderIdentityTrigger(d)
    const objectiveButton = $('#dObjective')
    objectiveButton.hidden = false
    paintObjectiveTrigger(objectiveButton, d.objective)
    objectiveButton.onclick = () => openObjectiveEditor({
      personId: S.open,
      name: person.name || '',
      objective: S.detail?.objective || '',
      anchor: objectiveButton,
      onSaved: (value) => {
        if (S.detail) S.detail.objective = value
        paintObjectiveTrigger(objectiveButton, value)
      },
    })

    const body = $('#drawerBody')
    body.replaceChildren()

    // galeria de fotos
    const photos = (t.photos && t.photos.length) ? t.photos : []
    body.appendChild(buildGallery(photos))

    // bloco de perfil
    const info = el('div', 'person-info')
    const distance = t.distance ? ` · ${esc(t.distance)}` : ''
    info.innerHTML = `
      <div class="row"><span class="nm">${esc(person.name || 'Sem nome')}</span>${t.age ? `<span class="ag">${esc(t.age)}</span>` : ''}${metricasNomeHtml(d.metricas)}</div>
      ${(t.city || t.distance) ? `<div class="place">${icon('i-pin', 'ico ico-sm')} ${esc(t.city || '')}${distance}</div>` : ''}
      ${t.bio ? `<div class="bio">${esc(t.bio)}</div>` : ''}`
    body.appendChild(info)

    // como essa conversa está indo, no canal que está aberto
    body.appendChild(saudeFaixa(S.open, S.channel))

    // conversa (filtrada pelo canal ativo)
    body.appendChild(buildConvo(d.timeline || [], S.channel))

    // controles
    buildControls(d)
  }

  // troca o canal ativo e repinta conversa + controles (usado pelo seletor)
  function switchChannel(ch) {
    if (S.channel === ch || !S.detail) return
    S.channel = ch
    const old = $('#drawerBody .convo')
    if (old) old.replaceWith(buildConvo(S.detail.timeline || [], ch))
    buildControls(S.detail)
  }

  function buildGallery(photos) {
    const g = el('div', 'gallery')
    if (!photos.length) {
      g.appendChild(el('div', 'ph', icon('i-cam', 'ico ico-lg')))
      return g
    }
    photos.forEach((url, i) => {
      const img = el('img', 'slide' + (i === 0 ? ' on' : ''))
      img.src = url; img.alt = ''; img.loading = i === 0 ? 'eager' : 'lazy'
      img.onerror = () => { img.style.background = 'var(--panel-3)'; img.removeAttribute('src') }
      g.appendChild(img)
    })
    g.appendChild(el('div', 'grad'))
    if (photos.length > 1) {
      const dots = el('div', 'dots')
      photos.forEach((_, i) => dots.appendChild(el('i', i === 0 ? 'on' : '')))
      g.appendChild(dots)
      const prev = el('button', 'nav prev', icon('i-arrow-l', 'ico'))
      const next = el('button', 'nav next', icon('i-arrow-r', 'ico'))
      const go = (dir) => {
        const n = photos.length
        S.gallery = (S.gallery + dir + n) % n
        $$('.slide', g).forEach((s, i) => s.classList.toggle('on', i === S.gallery))
        $$('.dots i', g).forEach((s, i) => s.classList.toggle('on', i === S.gallery))
      }
      prev.addEventListener('click', () => go(-1))
      next.addEventListener('click', () => go(1))
      g.append(prev, next)
      // swipe
      let sx = 0
      g.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX }, { passive: true })
      g.addEventListener('touchend', (e) => { const dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1) }, { passive: true })
    }
    return g
  }

  function buildConvo(timeline, channel) {
    const ch = channel || S.channel
    const wrap = el('div', 'convo')
    // só as mensagens do canal selecionado
    const msgs = (timeline || []).filter((m) => (m.channel || 'tinder') === ch)
    if (!msgs.length) {
      const hasAny = (timeline || []).length > 0
      const empty = ch === 'whatsapp'
        ? (hasAny ? 'Sem conversa no WhatsApp ainda. O que rolou até aqui foi no Tinder.' : 'Sem conversa no WhatsApp ainda.')
        : (hasAny ? 'Sem mensagens no Tinder — a conversa está no WhatsApp.' : 'Nenhuma mensagem trocada ainda. Gere um rascunho abaixo pra começar.')
      wrap.appendChild(el('div', 'convo-empty', esc(empty)))
      return wrap
    }
    let lastDay = null
    msgs.forEach((m) => {
      const dk = dayKey(m.ts)
      if (dk && dk !== lastDay) { wrap.appendChild(el('div', 'day-sep', esc(dk))); lastDay = dk }
      const mine = m.direction === 'eu'
      const row = el('div', `bubble-row ${mine ? 'me' : 'her'}`)
      const b = el('div', 'bubble', `${esc(m.text)}${m.ts ? `<div class="ts">${clockTime(m.ts)}</div>` : ''}`)
      row.appendChild(b)
      wrap.appendChild(row)
    })
    // rola pro fim depois de pintar
    requestAnimationFrame(() => { const body = $('#drawerBody'); body.scrollTop = body.scrollHeight })
    return wrap
  }

  function buildControls(d) {
    const ctl = $('#drawerControls')
    ctl.hidden = false
    ctl.replaceChildren()

    const ai = d.ai || {}
    const hasWa = !!(d.whatsapp && d.whatsapp.linked)
    // WhatsApp só é operável se a pessoa está vinculada; sem vínculo, cai pro Tinder
    if (S.channel === 'whatsapp' && !hasWa) S.channel = 'tinder'

    // seletor de canal: sempre visível; WhatsApp esmaecido/desabilitado sem vínculo.
    // Cada lado carrega a hora da própria última mensagem, e o mais recente fica marcado —
    // assim dá pra ver que o papo continuou no outro canal sem precisar clicar pra descobrir.
    const fim = ultimaPorCanal(d.timeline)
    const seg = el('div', 'seg')
    ;['tinder', 'whatsapp'].forEach((ch) => {
      const isWa = ch === 'whatsapp'
      const disabled = isWa && !hasWa
      const maisNovo = fim[ch] > 0 && fim[ch] > fim[isWa ? 'tinder' : 'whatsapp']
      const quando = fim[ch] ? `<small class="seg-when">${esc(timeAgo(fim[ch]))}</small>` : ''
      const b = el('button', (isWa ? 'wa ' : '') + (ch === S.channel ? 'active' : '') + (disabled ? ' disabled' : '') + (maisNovo && ch !== S.channel ? ' newer' : ''),
        `${icon(isWa ? 'i-wa' : 'i-heart', 'ico ico-sm')} <span class="seg-lbl">${isWa ? 'WhatsApp' : 'Tinder'}</span>${quando}`)
      if (maisNovo && ch !== S.channel) b.title = `a mensagem mais recente está no ${isWa ? 'WhatsApp' : 'Tinder'}`
      if (disabled) {
        b.disabled = true
        b.title = 'ainda não veio pro WhatsApp'
        b.setAttribute('aria-disabled', 'true')
      } else {
        b.addEventListener('click', () => switchChannel(ch))
      }
      seg.appendChild(b)
    })
    ctl.appendChild(seg)
    // dica curta quando o WhatsApp está indisponível
    if (!hasWa) ctl.appendChild(el('div', 'seg-hint', 'ainda não veio pro WhatsApp'))

    // barra da IA automática (do canal ativo)
    const aiOn = S.channel === 'whatsapp' ? !!ai.whatsapp : !!ai.tinder
    const bar = el('div', 'ai-bar' + (aiOn ? ' on' : ''))
    bar.innerHTML = `
      <div class="ai-ico">${icon('i-bot', 'ico ico-lg')}</div>
      <div class="ai-txt">
        <div class="t">IA automática</div>
        <div class="d">${aiOn ? 'ligada — ela responde sozinha no ' + (S.channel === 'whatsapp' ? 'WhatsApp' : 'Tinder') : 'desligada — você aprova cada resposta'}</div>
      </div>`
    const tg = el('button', 'toggle')
    tg.setAttribute('role', 'switch')
    tg.setAttribute('aria-checked', String(aiOn))
    tg.setAttribute('aria-label', 'IA automática')
    tg.addEventListener('click', () => toggleAi(S.channel, !aiOn, tg, bar))
    bar.appendChild(tg)
    ctl.appendChild(bar)

    // Atalho de encontro desta pessoa (o mesmo da Config, mas só pra ela). Nasce herdando
    // o ajuste geral; só vira exceção quando o dono toca aqui.
    const encBar = el('div', 'ai-bar enc-bar')
    const pintaEncBar = (ligado, herdando) => {
      encBar.classList.toggle('on', !!ligado)
      encBar.innerHTML = `
        <div class="ai-ico">${icon('i-cal', 'ico ico-lg')}</div>
        <div class="ai-txt">
          <div class="t">Pode propor encontro</div>
          <div class="d">${ligado ? (herdando ? 'sim, seguindo o ajuste geral' : 'sim, só com esta pessoa') : (herdando ? 'não, seguindo o ajuste geral' : 'não, só com esta pessoa')}</div>
        </div>`
      const b = el('button', 'toggle')
      b.setAttribute('role', 'switch')
      b.setAttribute('aria-checked', String(!!ligado))
      b.setAttribute('aria-label', 'Pode propor encontro com esta pessoa')
      b.addEventListener('click', async () => {
        const r = await post('/api/self/encontros/propor', { personId: S.open, enabled: !ligado })
        if (r && r.ok) { pintaEncBar(r.proporDates, false); toast(r.proporDates ? 'Pode propor encontro com esta pessoa' : 'Não propõe encontro com esta pessoa') }
        else toast('Não deu pra mudar o ajuste', 'err')
      })
      encBar.appendChild(b)
    }
    pintaEncBar(true, true)
    ctl.appendChild(encBar)

    // Atendimento desta pessoa. Interruptor SEPARADO do de cima: desligar romance não pode
    // desligar trabalho (15/08/2026). Mesma herança do geral, mesma forma.
    const atendBar = el('div', 'ai-bar enc-bar')
    const pintaAtendBar = (ligado, herdando) => {
      atendBar.classList.toggle('on', !!ligado)
      atendBar.innerHTML = `
        <div class="ai-ico">${icon('i-cal', 'ico ico-lg')}</div>
        <div class="ai-txt">
          <div class="t">Pode marcar atendimento</div>
          <div class="d">${ligado ? (herdando ? 'sim, seguindo o ajuste geral' : 'sim, só com esta pessoa') : (herdando ? 'não, seguindo o ajuste geral' : 'não, só com esta pessoa')}</div>
        </div>`
      const b = el('button', 'toggle')
      b.setAttribute('role', 'switch')
      b.setAttribute('aria-checked', String(!!ligado))
      b.setAttribute('aria-label', 'Pode marcar atendimento com esta pessoa')
      b.addEventListener('click', async () => {
        const r = await post('/api/self/atendimento/marcar', { personId: S.open, enabled: !ligado })
        if (r && r.ok) { pintaAtendBar(r.marcarAtendimento, false); toast(r.marcarAtendimento ? 'Pode marcar atendimento com esta pessoa' : 'Não marca atendimento com esta pessoa') }
        else toast('Não deu pra mudar o ajuste', 'err')
      })
      atendBar.appendChild(b)
    }
    pintaAtendBar(false, true)
    ctl.appendChild(atendBar)
    api(`/api/self/encontros/pessoa?personId=${encodeURIComponent(S.open)}`).then((st) => {
      if (!st) return
      pintaEncBar(st.proporDates, st.herdando)
      pintaAtendBar(st.marcarAtendimento, st.herdandoAtendimento)
    })

    const cobrBar = el('div', 'ai-bar cobr-bar')
    const pintaCobrBar = (regra = {}) => {
      const ligado = !!regra.cobrancaAutorizada
      const motivo = String(regra.motivo || '').trim()
      const resumo = resumoHistoricoCobranca(regra.historico)
      cobrBar.classList.toggle('on', !!ligado)
      cobrBar.innerHTML = `
        <div class="ai-ico">${icon('i-card', 'ico ico-lg')}</div>
        <div class="ai-txt">
          <div class="t">Pode cobrar</div>
          <div class="d">${esc(resumo)} · ${ligado ? esc(motivo) : (motivo ? `bloqueado · motivo salvo: ${esc(motivo)}` : 'bloqueado · defina por que esta pessoa deve pagar')}</div>
        </div>`
      const b = el('button', 'toggle')
      b.setAttribute('role', 'switch')
      b.setAttribute('aria-checked', String(!!ligado))
      b.setAttribute('aria-label', 'Editar autorização e motivo da cobrança')
      b.title = 'Editar regra de cobrança'
      b.addEventListener('click', () => {
        openCobrancaEditor({
          personId: S.open,
          name: d.person?.name || '',
          anchor: b,
          onSaved: pintaCobrBar,
        })
      })
      cobrBar.appendChild(b)
    }
    pintaCobrBar()
    api(`/api/self/cobranca/pessoa?personId=${encodeURIComponent(S.open)}`).then((st) => { if (st) pintaCobrBar(st) })
    ctl.appendChild(cobrBar)

    // compositor
    const comp = el('div', 'composer')
    comp.innerHTML = `
      <textarea class="draft" id="draft" placeholder="Escreva ou gere um rascunho…"></textarea>
      <div class="gen-state" id="genState"></div>
      <div class="row">
        <button class="btn gen" id="btnGen">${icon('i-spark', 'ico')} Gerar rascunho</button>
        <button class="btn send" id="btnSend" disabled>${icon('i-send', 'ico')} Enviar</button>
      </div>`
    ctl.appendChild(comp)

    const draft = $('#draft', ctl)
    const btnSend = $('#btnSend', ctl)
    const btnGen = $('#btnGen', ctl)
    draft.addEventListener('input', () => { btnSend.disabled = !draft.value.trim() })
    btnGen.addEventListener('click', () => generate(btnGen, draft, btnSend))
    btnSend.addEventListener('click', () => sendMsg(draft, btnSend))
  }

  async function toggleAi(channel, enabled, tg, bar) {
    tg.setAttribute('aria-checked', String(enabled))
    bar.classList.toggle('on', enabled)
    $('.ai-txt .d', bar).textContent = enabled
      ? 'ligada — ela responde sozinha no ' + (channel === 'whatsapp' ? 'WhatsApp' : 'Tinder')
      : 'desligada — você aprova cada resposta'
    const r = await post(`/api/person/${encodeURIComponent(S.open)}/ai`, { channel, enabled })
    if (!r || !r.ok) {
      // reverte em caso de falha
      tg.setAttribute('aria-checked', String(!enabled))
      bar.classList.toggle('on', !enabled)
      toast('Não deu pra mudar a IA', 'err')
      return
    }
    if (S.detail && S.detail.ai) S.detail.ai[channel] = enabled
    toast(enabled ? 'IA automática ligada' : 'IA automática desligada')
  }

  async function generate(btnGen, draft, btnSend) {
    if (S.generating) return
    S.generating = true
    const gs = $('#genState')
    btnGen.disabled = true
    btnGen.innerHTML = `<span class="spin"></span> Gerando…`
    gs.className = 'gen-state'
    gs.innerHTML = `<span class="spin"></span> o vendas-multicanal está pensando na resposta — pode levar alguns segundos`
    const r = await gerarRascunho(`/api/person/${encodeURIComponent(S.open)}/generate`, { channel: S.channel })
    S.generating = false
    btnGen.disabled = false
    btnGen.innerHTML = `${icon('i-spark', 'ico')} Gerar rascunho`
    if (!r || r.draft == null) {
      gs.className = 'gen-state err'
      gs.textContent = 'não consegui gerar agora — tente de novo'
      return
    }
    gs.textContent = ''
    draft.value = r.draft
    btnSend.disabled = !draft.value.trim()
    draft.focus()
  }

  async function sendMsg(draft, btnSend) {
    const text = draft.value.trim()
    if (!text) return
    btnSend.disabled = true
    const original = btnSend.innerHTML
    btnSend.innerHTML = `<span class="spin"></span> Enviando…`
    const r = await post(`/api/person/${encodeURIComponent(S.open)}/send`, { channel: S.channel, text })
    if (!r || !r.ok) {
      btnSend.disabled = false
      btnSend.innerHTML = original
      toast('Falha ao enviar', 'err')
      return
    }
    btnSend.innerHTML = original
    draft.value = ''
    $('#genState').textContent = ''
    toast('Mensagem enviada')
    // recarrega a ficha pra mostrar a bolha nova
    const d = await api(`/api/person/${encodeURIComponent(S.open)}`)
    if (d && S.open) { S.detail = d; body_reloadConvo(d) }
    loadState()
  }
  // atualiza só a conversa sem recriar galeria/controles (mantém o rascunho/scroll)
  function body_reloadConvo(d) {
    const old = $('#drawerBody .convo')
    if (old) old.replaceWith(buildConvo(d.timeline || [], S.channel))
  }

  // ---------------------------------------------------------------- WHATSAPP
  async function loadWa() {
    const host = $('#waHost')
    if (!host.dataset.loaded) host.replaceChildren(el('div', 'empty', `${icon('i-wa', 'ico')}<h3>carregando…</h3>`))
    const wa = await api('/api/wa')
    host.dataset.loaded = '1'
    if (!wa) { host.replaceChildren(emptyState('i-wa', 'WhatsApp indisponível', 'O painel não conseguiu falar com o módulo de WhatsApp do vendas-multicanal.')); return }
    renderWa(wa)
  }

  // Conversa que uma navegação de fora (ex.: o ranking do Progresso) pediu pra abrir. Não dá
  // pra abrir na hora: o carregamento da aba ainda está em voo e renderWa/renderIg/renderBadoo
  // zeram a conversa aberta e reconstroem a tela — a thread abria e sumia meio segundo depois.
  // Quem carrega o canal consome o alvo no fim, quando a tela já existe.
  let alvoConversa = null
  function abrirAlvo(fn) { if (!alvoConversa) return; const a = alvoConversa; alvoConversa = null; fn(a) }

  function renderWa(wa) {
    const host = $('#waHost')
    const status = wa.status || 'IDLE'
    // troca de tela = reinicia o cliente (evita polling/thread/popover/áudio órfãos)
    stopWaThreadPoll(); closeModeMenu(false); closeTinderMenu(false); closeAudioPicker(); stopAudio(); WA.openJid = null; WA.chat = null

    if (status === 'CONNECTED') { stopWaConnPoll(); host.replaceChildren(waConnected(wa)); abrirAlvo(openThread); return }
    // Enquanto parear OU reconectar (inclui DISCONNECTED/CONNECTING transitórios), mostra o
    // QR e SONDA o estado — assim que o celular lê o código, cai direto no cliente, sem clique.
    if (status !== 'IDLE') { host.replaceChildren(waQr(wa)); startWaConnPoll(); return }
    // IDLE = nunca pareado: único caso com botão manual de conectar.
    stopWaConnPoll(); host.replaceChildren(waIdle())
  }

  // Sonda /api/wa durante o pareamento: quando conectar, renderiza o cliente sozinho (não
  // depende só do WebSocket) e injeta o QR assim que ele chega. É o que tira o clique manual
  // de "Conectar" depois de ler o código.
  function startWaConnPoll() {
    if (WA.connTimer) return
    WA.connTimer = setInterval(async () => {
      if (S.tab !== 'whatsapp') { stopWaConnPoll(); return }
      const wa = await api('/api/wa').catch(() => null)
      if (!wa) return
      if (wa.status === 'CONNECTED') { stopWaConnPoll(); renderWa(wa); return }
      // O evento de status pode chegar antes do QR. Reconstroi com a resposta
      // autoritativa da API, em vez de depender da ordem entre WebSocket e polling.
      const qrAtual = $('#qrFrame img')
      if (wa.qrDataUrl && (!qrAtual || qrAtual.getAttribute('src') !== wa.qrDataUrl)) renderWa(wa)
    }, 2500)
  }
  function stopWaConnPoll() { if (WA.connTimer) { clearInterval(WA.connTimer); WA.connTimer = null } }

  function waIdle() {
    const wrap = el('div', 'wa-stage')
    const hero = el('div', 'wa-hero')
    hero.innerHTML = `
      <div class="glyph idle">${icon('i-wa', 'ico ico-lg')}</div>
      <h2>Conectar o WhatsApp</h2>
      <p>Pareie seu WhatsApp uma vez. O vendas-multicanal continua no WhatsApp as conversas que nasceram no Tinder — só com quem veio de lá.</p>
      <button class="btn wa-connect" id="btnWaConnect">${icon('i-wa', 'ico')} Conectar WhatsApp</button>`
    wrap.appendChild(hero)
    $('#btnWaConnect', wrap).addEventListener('click', async (e) => {
      const b = e.currentTarget
      b.disabled = true
      b.innerHTML = `<span class="spin"></span> preparando…`
      await post('/api/wa/connect')
      // o QR chega pelo WebSocket (wa-qr) ou no próximo /api/wa
      loadWa()
    })
    return wrap
  }

  function waQr(wa) {
    const wrap = el('div', 'wa-stage')
    const card = el('div', 'qr-card' + (wa.status === 'CONNECTING' ? ' pairing' : ''))
    card.id = 'qrCard'
    const repair = wa.status === 'REPAIR_REQUIRED'
    // SEM QR E SEM NINGUÉM TENTANDO NÃO É "GERANDO". Em REPAIR_REQUIRED/ERROR o servidor já
    // desistiu: dizer "Gerando o código de pareamento…" transforma uma falha num carregamento
    // eterno — a tela se redesenha a cada sondagem e parece que está quase. Aqui a tela conta
    // o que houve e devolve o único movimento possível, que é tentar de novo.
    const parado = !wa.qrDataUrl && (repair || wa.status === 'ERROR')
    const expect = parado
      ? 'Não deu pra gerar o código. O WhatsApp derrubou a conexão antes de mandar o QR.'
      : (!wa.qrDataUrl
        ? 'Gerando o código de pareamento…'
        : (repair ? 'A sessão caiu. Leia o código de novo pra reconectar.' : 'Aponte a câmera do seu celular pra este código.'))
    const qrInner = wa.qrDataUrl
      ? `<div class="qr-frame" id="qrFrame"><img src="${esc(wa.qrDataUrl)}" alt="QR de pareamento"></div>`
      : `<div class="qr-frame waiting" id="qrFrame">${icon('i-wa', 'ico ico-lg')}</div>`
    card.innerHTML = `
      <div class="expect">${esc(expect)}</div>
      ${qrInner}
      ${parado
        ? `<div class="qr-steps"><div class="qr-step">Isso costuma passar sozinho: o WhatsApp segura novas conexões por alguns minutos quando recebe muitas seguidas do mesmo lugar.</div></div>
           <button class="btn wa-connect" id="btnWaRetry">${icon('i-sync', 'ico')} Tentar de novo</button>`
        : `<div class="qr-steps">
             <div class="qr-step"><span class="n">1</span> Abra o WhatsApp</div>
             <div class="qr-step"><span class="n">2</span> Toque em Aparelhos conectados</div>
             <div class="qr-step"><span class="n">3</span> Conectar aparelho</div>
           </div>
           <div class="pairing-note"><span class="spin"></span> pareando…</div>`}`
    if (parado) {
      $('#btnWaRetry', card).addEventListener('click', async (e) => {
        const b = e.currentTarget
        b.disabled = true
        b.innerHTML = `<span class="spin"></span> tentando…`
        await post('/api/wa/connect')
        loadWa()
      })
    }
    wrap.appendChild(card)
    return wrap
  }

  // ==================================================================
  //  WHATSAPP CONECTADO — cliente de conversas real (master-detail)
  //  Esquerda: lista de conversas.  Direita: thread aberta.
  //  Em telas estreitas a thread cobre a lista, com botão "voltar".
  // ==================================================================
  // Re-parear o WhatsApp: destrutivo (a sessão cai até ler o QR de novo). Confirmação em
  // dois cliques, sem confirm() nativo. Com histórico completo ligado, o novo pareamento
  // baixa TODO o histórico das conversas.
  let waRepairArm = false, waRepairTimer = null
  async function waReparear(e) {
    const b = e.currentTarget, lbl = b.querySelector('.lbl')
    if (!waRepairArm) {
      waRepairArm = true; b.classList.add('danger'); if (lbl) lbl.textContent = 'Confirmar? vai pedir o QR'
      waRepairTimer = setTimeout(() => { waRepairArm = false; b.classList.remove('danger'); if (lbl) lbl.textContent = 'Re-parear (puxar histórico)' }, 4000)
      return
    }
    clearTimeout(waRepairTimer); waRepairArm = false; b.disabled = true; b.classList.remove('danger'); if (lbl) lbl.textContent = 'Gerando QR…'
    const r = await post('/api/wa/reparear')
    toast(r && r.ok ? 'Pronto — escaneie o novo QR no WhatsApp do celular' : 'Não deu pra re-parear', r && r.ok ? 'ok' : 'err')
  }

  function waConnected(wa) {
    const wrap = el('div', 'wa-client')
    wrap.id = 'waClient'
    // sub-banner discreto de status + fila de revisão (se houver)
    const head = el('div', 'wa-client-head ig-head')
    head.innerHTML = `
      <div class="wc-id">
        <div class="wc-dot"></div>
        <div class="wc-txt"><b>WhatsApp conectado</b><span>${esc(wa.name ? wa.name + ' · ' : '')}${esc(wa.jid ? jidToPhone(wa.jid) : '')}</span></div>
      </div>
      <button class="btn ghost" id="waReparear" title="Desconectar e ler o QR de novo pra baixar TODO o histórico das conversas">${icon('i-sync', 'ico ico-sm')}<span class="lbl">Re-parear (puxar histórico)</span></button>`
    head.querySelector('#waReparear').addEventListener('click', waReparear)
    wrap.appendChild(head)

    // Sub-abas do WhatsApp: Conversas | Aprovações. As aprovações moram numa PÁGINA
    // separada (antes ficavam empilhadas em cima da lista e enterravam o inbox).
    const reviews = wa.reviews || []
    WA.reviewCount = reviews.length
    const subtabs = el('div', 'wc-subtabs')
    subtabs.innerHTML = `
      <div class="pj-seg" role="tablist">
        <button role="tab" data-wasub="conversas" class="${WA.sub !== 'aprovacoes' ? 'active' : ''}" aria-selected="${WA.sub !== 'aprovacoes'}">${icon('i-chat', 'ico ico-sm')} Conversas</button>
        <button role="tab" data-wasub="aprovacoes" class="${WA.sub === 'aprovacoes' ? 'active' : ''}" aria-selected="${WA.sub === 'aprovacoes'}">${icon('i-users', 'ico ico-sm')} Aprovações${reviews.length ? ` <span class="vinc-cnt">${reviews.length}</span>` : ''}</button>
      </div>`
    subtabs.querySelectorAll('[data-wasub]').forEach((b) => b.addEventListener('click', () => {
      WA.sub = b.dataset.wasub
      loadWa()
    }))
    wrap.appendChild(subtabs)

    if (WA.sub === 'aprovacoes') {
      const pag = el('div', 'wc-aprovacoes')
      pag.id = 'wcAprovacoes'
      pag.innerHTML = `<p class="wc-aprov-intro">Só sobre as pessoas que te passaram contato <b>no Tinder</b>. Número que apareceu numa conversa de WhatsApp em outro contexto não entra aqui.</p>`
      if (reviews.length) {
        pag.appendChild(el('div', 'section-title', `${icon('i-users', 'ico ico-sm')} Precisam da sua decisão <span class="cnt">${reviews.length}</span>`))
        const rl = el('div', 'review-list'); reviews.forEach((rv) => rl.appendChild(reviewCard(rv))); pag.appendChild(rl)
      }
      pag.appendChild(el('div', 'wc-aprov-loading', 'carregando quem passou contato…'))
      wrap.appendChild(pag)
      carregarContatosDoTinder(pag)   // recebe o elemento: o wrap ainda não está no DOM aqui
      return wrap
    }

    // corpo master-detail
    const body = el('div', 'wc-body')
    body.innerHTML = `
      <aside class="wc-list" id="wcList" aria-label="Conversas">
        <div class="wc-list-head">${icon('i-chat', 'ico ico-sm')} Conversas <span class="cnt" id="wcCnt">·</span></div>
        ${filtroIaHtml(WA.filtroIa)}
        <label class="wc-search mobile-search mobile-only" for="wcSearch">
          ${icon('i-search')}<input id="wcSearch" type="search" inputmode="search" autocomplete="off" placeholder="Buscar no WhatsApp">
        </label>
        <div class="wc-list-scroll" id="wcListScroll">
          <div class="wc-loading">${icon('i-chat', 'ico')}<span>carregando conversas…</span></div>
        </div>
      </aside>
      <section class="wc-thread" id="wcThread" aria-label="Conversa">
        <div class="wc-thread-empty" id="wcThreadEmpty">
          ${icon('i-chat', 'ico ico-lg')}
          <h3>Escolha uma conversa</h3>
          <p>Toque numa pessoa à esquerda pra abrir o histórico e responder.</p>
        </div>
      </section>`
    wrap.appendChild(body)
    body.querySelector('#wcSearch')?.addEventListener('input', (e) => { WA.query = e.currentTarget.value.trim(); renderWaChats() })
    ligarFiltroIa(body, (v) => { WA.filtroIa = v; renderWaChats() })

    // carrega a lista assim que o wrap entrar no documento
    requestAnimationFrame(() => { loadWaChats(); startWaListPoll() })
    return wrap
  }

  // ---------- cor determinística do avatar a partir do nome ----------
  function colorFromName(str) {
    const s = String(str || '?')
    let h = 0
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
    const hue = h % 360
    return { bg: `hsl(${hue} 42% 26%)`, border: `hsl(${hue} 42% 40%)`, fg: `hsl(${hue} 70% 82%)` }
  }
  // avatar: foto redonda ou inicial sobre cor derivada do nome
  function avatarHtml(name, avatar, cls = 'wc-av') {
    const title = String(name || '').trim()
    // primeira letra ou dígito, não o primeiro caractere: quem não tem nome aparece como
    // telefone formatado e "(11) 99999-0004" daria um "(" de inicial em todo mundo.
    const initial = (title.match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase()
    if (avatar) {
      return `<img class="${cls}" src="${esc(avatar)}" alt="" loading="lazy" onerror="this.classList.add('ph');this.removeAttribute('src');this.textContent='${esc(initial)}'">`
    }
    const c = colorFromName(title || '?')
    return `<div class="${cls} ph" style="background:${c.bg};color:${c.fg};box-shadow:inset 0 0 0 1px ${c.border}">${esc(initial)}</div>`
  }

  // ---------------------------------------------------------------- filtro de IA na lista
  // O interruptor da IA é a informação que mais importa numa lista de conversas — e era a
  // única que não dava pra procurar: com 700 conversas, achar as 3 em que a IA responde era
  // rolar até cansar (regra do sistema, 27/07/2026). Mesmo controle nos quatro canais.
  const IA_FILTROS = [['', 'Todas'], ['on', 'IA ligada'], ['off', 'IA desligada']]
  function filtroIaHtml(valor) {
    return `<div class="ia-filtro" role="group" aria-label="Filtrar pela IA">${
      IA_FILTROS.map(([v, rot]) => `<button type="button" class="ia-chip${(valor || '') === v ? ' on' : ''}" data-ia-f="${v}" aria-pressed="${(valor || '') === v}">${rot}</button>`).join('')
    }</div>`
  }
  // liga os botões: `aoTrocar` recebe o valor novo ('' | 'on' | 'off')
  function ligarFiltroIa(raiz, aoTrocar) {
    raiz.querySelectorAll('[data-ia-f]').forEach((b) => b.addEventListener('click', () => {
      raiz.querySelectorAll('[data-ia-f]').forEach((o) => { o.classList.toggle('on', o === b); o.setAttribute('aria-pressed', String(o === b)) })
      aoTrocar(b.dataset.iaF || '')
    }))
  }
  const passaFiltroIa = (ligada, filtro) => !filtro || (filtro === 'on' ? !!ligada : !ligada)

  // ---------------------------------------------------------------- saúde da conversa
  // A mesma medida da aba Progresso, resumida numa faixa dentro da conversa. Os 4 canais
  // usam esta função — a régua é uma só, senão a tela do conjunto e a da conversa discordam.
  const SAUDE_CACHE = new Map() // 'personId|canal' -> { ts, saude }
  const SAUDE_TTL = 60000

  function saudeFaixa(personId, canal) {
    const box = el('div', 'saude')
    box.hidden = true
    if (!personId) return box
    const chave = `${personId}|${canal || ''}`
    const guardado = SAUDE_CACHE.get(chave)
    // a thread se repinta a cada poll; sem cache a faixa piscaria e a medida rodaria à toa
    if (guardado && Date.now() - guardado.ts < SAUDE_TTL) { pintarSaude(box, guardado.saude); return box }
    api(`/api/conversas/saude?pessoa=${encodeURIComponent(personId)}${canal ? '&canal=' + canal : ''}`)
      .then((d) => {
        SAUDE_CACHE.set(chave, { ts: Date.now(), saude: d?.saude || null })
        pintarSaude(box, d?.saude || null)
      })
      .catch(() => {})
    return box
  }

  function pintarSaude(box, s) {
    // sem troca suficiente a faixa some: melhor nada do que um zero que não quer dizer nada
    if (!s) { box.hidden = true; box.replaceChildren(); return }
    const bits = [`<span class="saude-est est-${s.estagio}">${esc(s.estagioLabel)}</span>`]
    bits.push(`<span><b>${s.idasEVindas}</b> idas e vindas</span>`)
    if (s.tempoRespostaMs != null) bits.push(`<span>responde em <b>${dur(s.tempoRespostaMs)}</b></span>`)
    if (s.reciprocidade != null) bits.push(`<span><b>${s.reciprocidade.toFixed(1)}x</b> ela</span>`)
    if (s.pctRetomada != null) bits.push(`<span class="${s.pctRetomada < 50 ? 'ruim' : ''}">volta <b>${s.pctRetomada}%</b> depois do silêncio</span>`)
    if (s.vacuos) bits.push(`<span class="${s.vacuos > 2 ? 'ruim' : ''}"><b>${s.vacuos}</b> sem resposta</span>`)
    bits.push(`<span>${s.vez === 'sua' ? 'a bola é sua' : 'esperando ela'} há <b>${timeAgo(s.ultima)}</b></span>`)
    // a medida é da pessoa inteira: se ela também está em outra rede, a faixa diz de onde
    // vem o número, senão parece que fala só desta thread
    if (s.canais && s.canais.length > 1) {
      bits.push(`<span class="saude-canais" title="a conta é da pessoa, somando as redes">${
        s.canais.map((x) => `${esc(CANAL_LBL[x.canal] || x.canal)} ${pctCanal(x)}`).join(' + ')}</span>`)
    }
    box.innerHTML = bits.join('')
    box.hidden = false
  }

  function waChatTitle(c) {
    return c.name || c.phone || jidToPhone(c.jid) || 'contato'
  }

  // ---------- lista de conversas (GET /api/wa/chats) ----------
  async function loadWaChats() {
    if (!$('#wcListScroll')) return
    const chats = await api('/api/wa/chats')
    if (!$('#wcListScroll')) return // host sumiu enquanto buscava
    WA.chats = Array.isArray(chats) ? chats : []
    renderWaChats()
  }

  function renderWaChats() {
    const host = $('#wcListScroll')
    const cnt = $('#wcCnt')
    if (!host) return
    const chats = (WA.chats || []).filter((c) => passaFiltroIa(c.aiOn, WA.filtroIa))
    const shown = WA.query
      ? chats.filter((c) => norm(`${waChatTitle(c)} ${c.lastText || ''} ${c.phone || ''}`).includes(norm(WA.query)))
      : chats
    if (cnt) cnt.textContent = String(shown.length)

    if (!(WA.chats || []).length) {
      host.replaceChildren(emptyState('i-chat', 'Nenhuma conversa ainda',
        'As conversas aparecem aqui conforme a atividade no WhatsApp. Se acabou de parear, elas chegam nos próximos minutos.'))
      return
    }
    if (!chats.length) {
      host.replaceChildren(emptyState('i-bot', WA.filtroIa === 'on' ? 'A IA não está ligada em nenhuma' : 'A IA está ligada em todas',
        WA.filtroIa === 'on' ? 'Nenhuma conversa do WhatsApp tem a IA respondendo agora.' : 'Todas as conversas daqui estão com a IA ligada.'))
      return
    }
    if (!shown.length) {
      host.replaceChildren(emptyState('i-search', 'Nada encontrado', `Nenhuma conversa corresponde a “${WA.query}”.`))
      return
    }
    // Ordem por RECÊNCIA, como no WhatsApp. As do Tinder ficavam todas no topo — com 8
    // vínculos passava despercebido, com 14 enterrou o inbox inteiro (24/07/2026). O selo
    // "Tinder" continua marcando quem é, sem furar a fila.
    const sorted = shown.slice().sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
    const list = el('div', 'wc-items')
    sorted.forEach((c) => list.appendChild(chatListItem(c)))
    // não repinta o igual, e o scroll é de quem está lendo (avisos de fundo chegam o tempo
    // todo; sem isso a lista pula pro topo sozinha no meio da leitura)
    if (!mudou('wa', shown.map((c) => [c.jid, c.lastTs, c.lastText, c.aiOn, c.unread, (c.etiquetas || []).map((e) => e.id).join(','), ...metricasNomeKey(c.metricas)])) && !listaVazia(host)) return
    const rolagem = host.scrollTop
    host.replaceChildren(list)
    if (rolagem) host.scrollTop = rolagem
  }

  // Chips de etiqueta, do jeito que a etiqueta foi pintada em Config. Cor desconhecida cai em
  // cinza em vez de sumir: classe que não existe no CSS é etiqueta viva e invisível.
  function etiquetasHtml(lista, { max = 2 } = {}) {
    const etqs = Array.isArray(lista) ? lista.filter((e) => e && e.nome) : []
    if (!etqs.length) return ''
    const mostrar = etqs.slice(0, max)
    const resto = etqs.length - mostrar.length
    return mostrar.map((e) => `<span class="etq-chip mini cor-${CORES_ETIQUETA.includes(e.cor) ? e.cor : 'cinza'}"><span class="etq-chip-txt">${esc(e.nome)}</span></span>`).join('')
      + (resto > 0 ? `<span class="etq-chip mini cor-cinza"><span class="etq-chip-txt">+${resto}</span></span>` : '')
  }

  function chatListItem(c) {
    // <div role=button> (não <button>) pra poder aninhar o <button> do toggle sem HTML inválido
    const item = el('div', 'wc-item' + (c.fromTinder ? ' from-tinder' : '') + (WA.openJid === c.jid ? ' active' : ''))
    item.setAttribute('role', 'button')
    item.setAttribute('tabindex', '0')
    item.dataset.jid = c.jid
    const title = waChatTitle(c)
    const preview = c.lastText ? esc(c.lastText) : '<i class="mute">sem mensagens</i>'
    const when = c.lastTs ? timeAgo(c.lastTs) : ''
    const tinderTag = c.fromTinder ? `<span class="wc-tag">${icon('i-heart', 'ico ico-sm')} Tinder</span>` : ''
    // ETIQUETA NA LISTA (15/08/2026). Saber que aquele é cliente da Fatal antes de abrir muda
    // a ordem do dia; a cor é a mesma da etiqueta, então o reconhecimento é de relance.
    const etqTags = etiquetasHtml(c.etiquetas)
    const modeTag = modeChipHtml(c.mode)   // chip discreto só quando tem modo setado
    const unread = c.unread ? `<span class="wc-unread">${c.unread > 99 ? '99+' : c.unread}</span>` : ''

    // o switch da IA já comunica o estado, então dispensa o dot "IA" redundante ao lado
    item.innerHTML = `
      ${avatarHtml(title, c.avatar)}
      <div class="wc-item-main">
        <div class="wc-item-top">
          <span class="wc-nm">${esc(title)}</span>
          ${metricasNomeHtml(c.metricas)}
          ${etqTags}
          ${tinderTag}
          ${modeTag}
          ${when ? `<span class="wc-when">${esc(when)}</span>` : ''}
        </div>
        <div class="wc-item-bot">
          <span class="wc-prev">${preview}</span>
          <span class="wc-flags">${unread}</span>
        </div>
      </div>
      <div class="wc-item-ai-wrap">
        <span class="wc-item-ai-lbl">${icon('i-bot', 'ico ico-sm')}<span class="wc-item-ai-text">IA</span></span>
        <button class="toggle sm wc-item-ai" role="switch" aria-checked="${c.aiOn ? 'true' : 'false'}" aria-label="IA responde nesta conversa" title="IA responde nesta conversa" data-ai-jid="${esc(c.jid)}"></button>
      </div>`

    // o toggle NÃO abre a thread: para a propagação (click e teclado) e usa a função generalizada
    const tg = item.querySelector('.wc-item-ai')
    tg.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleAiForChat(c.jid, tg.getAttribute('aria-checked') !== 'true', tg)
    })
    tg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleAiForChat(c.jid, tg.getAttribute('aria-checked') !== 'true', tg) }
    })
    item.addEventListener('click', () => openThread(c.jid))
    // acessível pelo teclado como um botão (Enter/Espaço abre a conversa)
    item.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === item) { e.preventDefault(); openThread(c.jid) }
    })
    return item
  }

  // ---------- thread (GET /api/wa/chat) ----------
  async function openThread(jid) {
    closeModeMenu(false); closeTinderMenu(false)
    if (WA.openJid !== jid) stopAudio()   // trocou de conversa: silencia o áudio da anterior
    WA.openJid = jid
    // marca item ativo na lista + mostra thread (mobile: cobre)
    $$('#wcListScroll .wc-item').forEach((it) => it.classList.toggle('active', it.dataset.jid === jid))
    const wrap = $('#waClient'); if (wrap) wrap.classList.add('thread-open')

    const cached = (WA.chats || []).find((c) => c.jid === jid)
    renderThreadShell(cached || { jid, name: jidToPhone(jid) }, true)

    const chat = await api(`/api/wa/chat?jid=${encodeURIComponent(jid)}`)
    if (WA.openJid !== jid) return // trocou de conversa enquanto carregava
    if (!chat) {
      const t = $('#wcThread')
      if (t) t.replaceChildren(threadHeader(cached || { jid }), emptyState('i-x', 'Não deu pra abrir', 'O vendas-multicanal não devolveu esta conversa. Tente de novo em instantes.'))
      return
    }
    WA.chat = chat
    renderThread(chat)
    startWaThreadPoll()
  }

  // volta pra lista (mobile)
  function backToList() {
    closeModeMenu(false); closeTinderMenu(false)
    stopAudio()
    WA.openJid = null; WA.chat = null
    stopWaThreadPoll()
    const wrap = $('#waClient'); if (wrap) wrap.classList.remove('thread-open')
    $$('#wcListScroll .wc-item').forEach((it) => it.classList.remove('active'))
    const t = $('#wcThread')
    if (t) {
      const empty = el('div', 'wc-thread-empty')
      empty.id = 'wcThreadEmpty'
      empty.innerHTML = `${icon('i-chat', 'ico ico-lg')}<h3>Escolha uma conversa</h3><p>Toque numa pessoa à esquerda pra abrir o histórico e responder.</p>`
      t.replaceChildren(empty)
    }
  }

  // cabeçalho da thread: avatar + nome + telefone + selo Tinder + modo + toggle IA
  function threadHeader(chat) {
    const head = el('div', 'wc-thread-head')
    const title = chat.name || chat.phone || jidToPhone(chat.jid) || 'contato'
    const phone = chat.phone || jidToPhone(chat.jid)
    // selo Tinder no cabeçalho é interativo (botão): abre popover pra desmarcar
    const tinderTag = chat.fromTinder
      ? `<button class="wc-tag wc-tag-btn" id="wcTinderTag" type="button" aria-haspopup="menu" aria-expanded="false" title="Ver o perfil dela no Tinder">${icon('i-heart', 'ico ico-sm')} Tinder</button>`
      : ''
    head.innerHTML = `
      <button class="icon-btn wc-back" id="wcBack" title="Voltar" aria-label="Voltar">${icon('i-arrow-l', 'ico')}</button>
      ${avatarHtml(title, chat.avatar, 'wc-av wc-av-head')}
      <div class="wc-head-id">
        <div class="wc-head-nm" id="wcHeadNm"><span class="wc-head-person">${esc(title)}</span>${metricasNomeHtml(chat.metricas)}${etiquetasHtml(chat.etiquetas, { max: 3 })}${tinderTag}</div>
        ${phone ? `<div class="wc-head-ph">${esc(phone)}</div>` : ''}
      </div>
      <button class="btn ghost small wc-ident" id="wcIdent" type="button" title="Quem é essa pessoa em cada rede">${icon('i-link', 'ico ico-sm')}<span class="lbl">Mesma pessoa</span></button>
      <div class="wc-mode" id="wcModeWrap">
        <button class="wc-mode-pill" id="wcModePill" type="button" aria-haspopup="menu" aria-expanded="false" title="Contexto da conversa"></button>
      </div>
      <div class="wc-head-toggles">
        <div class="wc-head-toggle wc-ai-toggle">
          <span class="wc-head-toggle-lbl">${icon('i-bot', 'ico ico-sm')} IA responde</span>
          <button class="toggle sm" role="switch" aria-checked="${chat.aiOn ? 'true' : 'false'}" aria-label="IA responde nesta conversa" id="wcAiToggle"></button>
        </div>
        <div class="wc-head-toggle wc-cobr-toggle">
          <span class="wc-head-toggle-lbl">${icon('i-card', 'ico ico-sm')} Pode cobrar</span>
          <button class="toggle sm" role="switch" aria-checked="false" aria-label="Pode cobrar nesta conversa" id="wcCobrToggle"></button>
        </div>
      </div>`
    head.querySelector('#wcBack').addEventListener('click', backToList)
    const btnIdent = head.querySelector('#wcIdent')
    if (btnIdent) btnIdent.addEventListener('click', () => abrirIdentidade(chat.personId, () => openThread(chat.jid)))
    const tg = head.querySelector('#wcAiToggle')
    tg.addEventListener('click', () => toggleAiForChat(chat.jid, tg.getAttribute('aria-checked') !== 'true', tg))
    wireCobrancaHeadToggle(head.querySelector('#wcCobrToggle'), chat.personId || `wa:${chat.jid}`, 'WhatsApp', title)
    // contexto da conversa: modo + objetivo numa única pill, sem poluir o cabeçalho
    const modeWrap = head.querySelector('#wcModeWrap')
    const pill = head.querySelector('#wcModePill')
    paintModePill(pill, chat.mode || null, chat.objective || '')
    pill.addEventListener('click', (e) => {
      e.stopPropagation()
      if (modeMenu && modeMenu.pill === pill) closeModeMenu(false)
      else openModeMenu(modeWrap, pill, chat.jid)
    })
    pill.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && !modeMenu) { e.preventDefault(); e.stopPropagation(); openModeMenu(modeWrap, pill, chat.jid) }
    })
    // selo Tinder interativo: popover "Não é do Tinder"
    wireTinderTag(head, chat.jid)
    return head
  }

  // esqueleto da thread enquanto carrega (mantém cabeçalho estável)
  function renderThreadShell(chat, loading) {
    const t = $('#wcThread')
    if (!t) return
    const body = el('div', 'wc-msgs')
    body.id = 'wcMsgs'
    if (loading) body.appendChild(el('div', 'wc-thread-empty small', `<span class="spin"></span><p>abrindo conversa…</p>`))
    t.replaceChildren(threadHeader(chat), body)
  }

  function renderThread(chat) {
    const t = $('#wcThread')
    if (!t) return
    t.replaceChildren(threadHeader(chat), saudeFaixa(chat.personId, 'whatsapp'), threadMessages(chat), threadComposer(chat))
    scrollThreadToEnd()
  }

  function threadMessages(chat) {
    const wrap = el('div', 'wc-msgs')
    wrap.id = 'wcMsgs'
    const msgs = chat.messages || []
    if (!msgs.length) {
      wrap.appendChild(el('div', 'wc-thread-empty small', `${icon('i-chat', 'ico')}<p>Sem mensagens carregadas — as novas aparecem aqui.</p>`))
      return wrap
    }
    let lastDay = null
    msgs.forEach((m) => {
      const dk = dayKey(m.ts)
      if (dk && dk !== lastDay) { wrap.appendChild(el('div', 'day-sep', esc(dk))); lastDay = dk }
      wrap.appendChild(bubbleFor(m))
    })
    return wrap
  }

  // duração em segundos → "m:ss" (null enquanto não sabe)
  // Item do banco de fotos (foto ou vídeo): a URL do arquivo e a da miniatura. Vídeo mostra a
  // capa tirada no upload; foto mostra ela mesma.
  function ehVideoSalvo(file) { return /\.mp4$/i.test(String(file || '')) }
  function arquivoSalvoUrl(file) { return `/api/fotos/arquivo?file=${encodeURIComponent(file)}` }
  function miniaturaSalva(file) { return arquivoSalvoUrl(ehVideoSalvo(file) ? String(file).replace(/\.mp4$/i, '-capa.jpg') : file) }

  function fmtDur(sec) {
    if (sec == null || !isFinite(sec) || sec < 0) return '--:--'
    const s = Math.floor(sec)
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }

  // ---------- player de áudio (único, compartilhado) ----------
  // Garante o <audio> escondido; um só toca por vez. Ao dar play num arquivo diferente,
  // troca o src. Os handlers só pintam a bolha ligada agora (AUDIO.ui).
  function ensureAudioNode() {
    if (AUDIO.node) return AUDIO.node
    const a = new Audio()
    a.preload = 'none'
    a.addEventListener('timeupdate', () => paintAudioProgress())
    a.addEventListener('loadedmetadata', () => paintAudioProgress())
    a.addEventListener('durationchange', () => paintAudioProgress())
    a.addEventListener('play', () => paintAudioPlaying(true))
    a.addEventListener('pause', () => paintAudioPlaying(false))
    a.addEventListener('ended', () => {
      paintAudioPlaying(false)
      if (AUDIO.ui && AUDIO.ui.wrap && AUDIO.ui.wrap.isConnected) {
        setBar(AUDIO.ui.wrap, 0, true)
        const t = AUDIO.ui.wrap.querySelector('.wc-au-time')
        const total = (isFinite(a.duration) && a.duration > 0) ? a.duration : AUDIO.ui.fallbackDur
        if (t) t.textContent = fmtDur(total)
      }
    })
    a.addEventListener('error', () => { paintAudioPlaying(false) })
    AUDIO.node = a
    return a
  }

  // desenha o botão play/pause da bolha atualmente ligada
  function paintAudioPlaying(playing) {
    const ui = AUDIO.ui
    if (!ui || !ui.wrap || !ui.wrap.isConnected) return
    const btn = ui.wrap.querySelector('.wc-au-btn')
    if (!btn) return
    btn.classList.toggle('playing', playing)
    btn.setAttribute('aria-label', playing ? 'Pausar áudio' : 'Tocar áudio')
    const use = btn.querySelector('use')
    if (use) use.setAttribute('href', playing ? '#i-pause' : '#i-play')
    ui.wrap.classList.toggle('playing', playing)
  }

  // atualiza barra + tempo da bolha ligada, a partir do estado real do <audio>
  function paintAudioProgress() {
    const ui = AUDIO.ui, a = AUDIO.node
    if (!ui || !a || !ui.wrap || !ui.wrap.isConnected) return
    const dur = isFinite(a.duration) && a.duration > 0 ? a.duration : null
    const pct = dur ? Math.min(100, (a.currentTime / dur) * 100) : 0
    setBar(ui.wrap, pct, false)
    const timeEl = ui.wrap.querySelector('.wc-au-time')
    if (timeEl) {
      // enquanto toca mostra corrido/total; parado mostra a duração total
      const total = dur != null ? dur : ui.fallbackDur
      timeEl.textContent = (a.paused && a.currentTime === 0)
        ? fmtDur(total)
        : `${fmtDur(a.currentTime)} / ${fmtDur(total)}`
    }
  }

  // move a barra de progresso (pct 0..100); reset=true zera pro estado inicial
  function setBar(wrap, pct, reset) {
    const fill = wrap.querySelector('.wc-au-fill')
    if (fill) fill.style.width = (reset ? 0 : pct) + '%'
    const knob = wrap.querySelector('.wc-au-knob')
    if (knob) knob.style.left = (reset ? 0 : pct) + '%'
  }

  // URL de stream de um áudio: recebido (wa-media) ou salvo (biblioteca de notas de voz).
  // O identificador do player (AUDIO.file) é a URL inteira — assim áudio recebido e salvo
  // com o mesmo nome de arquivo nunca se confundem no player compartilhado.
  function audioSrcFor(au) {
    const q = `file=${encodeURIComponent(au.file)}`
    return au.saved ? `/api/wa/audios/stream?${q}` : `/api/wa/media?${q}`
  }
  // toca/pausa o áudio de uma bolha. Um por vez: se outro estava tocando, pausa e
  // "solta" a bolha antiga antes de assumir esta. `src` identifica o áudio (URL completa).
  function toggleAudio(src, wrap, fallbackDur) {
    const a = ensureAudioNode()
    const sameFile = AUDIO.file === src
    if (sameFile && !a.paused) { a.pause(); return }        // é o atual e está tocando → pausa
    // assume esta bolha como a ligada agora
    if (AUDIO.ui && AUDIO.ui.wrap !== wrap) { paintAudioPlaying(false) }  // apaga o play da anterior
    AUDIO.ui = { file: src, wrap, fallbackDur }
    if (!sameFile) {
      AUDIO.file = src
      a.src = src
      a.currentTime = 0
    }
    paintAudioProgress()
    const p = a.play()
    if (p && p.catch) p.catch(() => { paintAudioPlaying(false) })
  }

  // para o player e desliga a bolha (ao trocar/fechar conversa)
  function stopAudio() {
    if (AUDIO.node) { try { AUDIO.node.pause() } catch {} }
    if (AUDIO.ui) paintAudioPlaying(false)
    AUDIO.ui = null; AUDIO.file = null
    if (AUDIO.node) { try { AUDIO.node.removeAttribute('src'); AUDIO.node.load() } catch {} }
  }

  // reconcilia uma bolha de áudio recém-pintada com o player: se é o arquivo tocando,
  // re-vincula (pra o timeupdate voltar a mexer nesta bolha) e reflete o estado visual.
  function reattachAudio(file, wrap, fallbackDur) {
    if (AUDIO.file !== file || !AUDIO.node) return
    AUDIO.ui = { file, wrap, fallbackDur }
    paintAudioPlaying(!AUDIO.node.paused)
    paintAudioProgress()
  }

  // monta a bolha de áudio: player custom + transcrição (a cor in/out vem do CSS da linha)
  function audioBubble(m) {
    const au = m.audio || {}
    const b = el('div', 'bubble wc-audio')
    const wrap = el('div', 'wc-au-player')
    const durKnown = (au.dur != null && isFinite(au.dur))
    wrap.innerHTML = `
      <button class="wc-au-btn" type="button" aria-label="Tocar áudio">${icon('i-play', 'ico')}</button>
      <div class="wc-au-mid">
        <div class="wc-au-track" role="presentation"><div class="wc-au-fill"></div><div class="wc-au-knob"></div></div>
        <div class="wc-au-time">${fmtDur(durKnown ? au.dur : null)}</div>
      </div>`
    b.appendChild(wrap)

    if (au.file) {
      const src = audioSrcFor(au) // recebido (wa-media) ou salvo (biblioteca)
      const btn = wrap.querySelector('.wc-au-btn')
      btn.addEventListener('click', () => toggleAudio(src, wrap, durKnown ? au.dur : null))
      // clique na barra busca a posição (só quando este áudio é o que está carregado)
      const track = wrap.querySelector('.wc-au-track')
      track.addEventListener('click', (e) => {
        const a = AUDIO.node
        if (!a || AUDIO.file !== src || !isFinite(a.duration) || a.duration <= 0) return
        const r = track.getBoundingClientRect()
        const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
        a.currentTime = p * a.duration
        paintAudioProgress()
      })
      // se este arquivo já está no player (repintou durante o play), re-vincula
      requestAnimationFrame(() => reattachAudio(src, wrap, durKnown ? au.dur : null))
    } else {
      // sem arquivo pra tocar: botão inerte
      const btn = wrap.querySelector('.wc-au-btn')
      btn.disabled = true
      btn.setAttribute('aria-label', 'Áudio indisponível')
    }

    // transcrição embaixo do player
    b.appendChild(audioTranscript(au))

    // hora, como nas outras bolhas
    let stamp = ''
    if (m.pending) stamp = `<span class="wc-sending"><span class="spin"></span></span>`
    else if (m.failed) stamp = `<span class="wc-err">${icon('i-x', 'ico ico-sm')} falhou</span>`
    else if (m.ts) stamp = clockTime(m.ts)
    if (stamp) b.appendChild(el('div', 'ts', stamp))
    return b
  }

  // bloco de transcrição conforme o status
  function audioTranscript(au) {
    const st = au.status
    const box = el('div', 'wc-au-tr')
    if (st === 'done' && au.transcript != null && String(au.transcript).trim() !== '') {
      box.classList.add('done')
      box.innerHTML = `
        <span class="wc-au-tr-lbl">${icon('i-caption', 'ico ico-sm')} transcrito automaticamente</span>
        <span class="wc-au-tr-txt">${esc(au.transcript)}</span>`
    } else if (st === 'pending') {
      box.classList.add('pending')
      box.innerHTML = `<span class="wc-au-tr-lbl"><span class="wc-au-shimmer"></span> transcrevendo…</span>`
    } else {
      // error / nofile / done-sem-texto
      box.classList.add('fail')
      box.innerHTML = `<span class="wc-au-tr-note">(não deu pra transcrever este áudio)</span>`
    }
    return box
  }

  // bolha de mídia do Instagram (imagem/vídeo). Imagem vira <img> de verdade (servida pela
  // rota-proxy /api/ig/media, porque o CDN do IG bloqueia hotlink); se a URL expirou/falhou,
  // cai no marcador. Vídeo/reel viram marcador (não dá pra tocar o CDN direto). A descrição
  // automática (quando a interpretação estiver ligada) aparece como legenda embaixo.
  function mediaBubble(m) {
    const md = m.media || {}
    const b = el('div', 'bubble wc-media')
    // Item do BANCO DE FOTOS que nós mandamos (saved) mora noutra pasta: a rota é a do banco,
    // não a da mídia recebida. Vídeo do banco mostra a capa e abre o player ao clicar.
    const doBanco = !!(md.saved && md.file)
    const videoDoBanco = doBanco && m.type === 'video'
    const proxied = doBanco
      ? miniaturaSalva(md.file)
      : md.file
        ? `/api/wa/media?file=${encodeURIComponent(md.file)}`
        : md.src ? `/api/ig/media?src=${encodeURIComponent(md.src)}` : ''
    if ((m.type === 'imagem' || videoDoBanco) && proxied) {
      const img = el('img', 'wc-media-img')
      img.loading = 'lazy'; img.alt = md.desc || (videoDoBanco ? 'vídeo' : 'imagem')
      img.src = proxied
      // se não carregar (URL do CDN expirou), troca pelo marcador em vez de quebrar
      img.addEventListener('error', () => { img.replaceWith(el('div', 'wc-marker', esc(videoDoBanco ? '[vídeo]' : '[imagem]'))) })
      // clique abre a imagem grande (lightbox), reusando o overlay do painel; vídeo abre tocando
      img.addEventListener('click', () => {
        const ov = overlay(); ov.classList.add('pj-lightbox')
        if (!videoDoBanco) { ov.appendChild(el('img', 'pj-lightbox-img')).src = proxied; return }
        const v = el('video', 'pj-lightbox-img')
        v.src = arquivoSalvoUrl(md.file); v.controls = true; v.autoplay = true; v.playsInline = true
        ov.appendChild(v)
      })
      if (videoDoBanco) {
        const capa = el('div', 'wc-media-video')
        capa.append(img, el('span', 'fo-play', icon('i-play', 'ico ico-sm')))
        b.appendChild(capa)
      } else b.appendChild(img)
    } else {
      b.appendChild(el('div', 'wc-marker', esc(m.type === 'video' ? '[vídeo]' : '[imagem]')))
    }
    if (md.caption) b.appendChild(el('div', 'wc-media-cap', `<span>${esc(md.caption)}</span>`))
    if (md.desc) b.appendChild(el('div', 'wc-media-cap', `${icon('i-caption', 'ico ico-sm')}<span>${esc(md.desc)}</span>`))
    else if (md.status === 'pending') b.appendChild(el('div', 'wc-media-cap', '<span class="spin"></span><span>analisando imagem…</span>'))
    let stamp = ''
    if (m.ts) stamp = clockTime(m.ts)
    if (stamp) b.appendChild(el('div', 'ts', stamp))
    return b
  }

  // bolha de FIGURINHA do WhatsApp: mostra o .webp (servido por /api/wa/media). Se não baixou,
  // cai no marcador '[figurinha]'. Sem fundo de bolha (figurinha é transparente).
  function stickerBubble(m) {
    const st = m.sticker || {}
    const b = el('div', 'bubble wc-sticker')
    if (st.file) {
      const img = el('img', 'wc-sticker-img')
      img.loading = 'lazy'; img.alt = 'figurinha'
      img.src = `/api/wa/media?file=${encodeURIComponent(st.file)}`
      img.addEventListener('error', () => { img.replaceWith(el('div', 'wc-marker', esc('[figurinha]'))) })
      b.appendChild(img)
    } else {
      b.appendChild(el('div', 'wc-marker', esc('[figurinha]')))
    }
    if (m.ts) b.appendChild(el('div', 'ts', clockTime(m.ts)))
    return b
  }

  // uma bolha de mensagem (in = esquerda, out = direita). Áudio ganha player+transcrição;
  // imagem/vídeo do IG ganham bolha de mídia; outros tipos != texto viram marcador itálico.
  function bubbleFor(m) {
    const mine = m.dir === 'out'
    const row = el('div', `bubble-row ${mine ? 'me' : 'her'}` + (m.pending ? ' pending' : '') + (m.failed ? ' failed' : '') + (m.syncing ? ' syncing' : ''))
    if (m.id != null) row.dataset.mid = String(m.id)
    if (m.type === 'audio') { row.appendChild(audioBubble(m)); return row }
    if (m.type === 'imagem' || m.type === 'video') { row.appendChild(mediaBubble(m)); return row }
    if (m.type === 'figurinha') { row.appendChild(stickerBubble(m)); return row }
    const isMarker = (m.type && m.type !== 'texto') && typeof m.text === 'string' && m.text.trim().startsWith('[')
    const bodyHtml = isMarker
      ? `<span class="wc-marker">${esc(m.text)}</span>`
      : esc(m.text)
    let stamp = ''
    if (m.syncing) stamp = `<span class="wc-syncing"><span class="spin"></span> sincronizando</span>`
    else if (m.pending) stamp = `<span class="wc-sending"><span class="spin"></span></span>`
    else if (m.failed) stamp = `<span class="wc-err">${icon('i-x', 'ico ico-sm')} falhou</span>`
    else if (m.ts) stamp = clockTime(m.ts)
    const b = el('div', 'bubble', `${bodyHtml}${stamp ? `<div class="ts">${stamp}</div>` : ''}`)
    // Veredito: em TODA mensagem que o vendas-multicanal mandou, o dono marca se saiu certo ou errado.
    // É a única prova de ground-truth do vínculo — só ele sabe se quem respondeu é a pessoa.
    if (mine && m.id != null && !m.pending && !m.failed) {
      const ts = b.querySelector('.ts') || b.appendChild(el('div', 'ts'))
      ts.appendChild(vereditoControle(m))
    }
    row.appendChild(b)
    return row
  }

  // Controle de veredito de uma bolha. Já marcado: mostra o selo (clicar troca).
  // Marcar se a mensagem foi pra pessoa certa. Dois ícones nus em toda bolha não diziam nada
  // — o dono olhou e perguntou o que eram (25/07/2026). Agora: some até você passar o mouse
  // na bolha (no celular, até tocar nela), e o que JÁ foi marcado fica sempre visível.
  function vereditoControle(m) {
    const wrap = el('span', 'msg-veredito')
    const marcado = m.veredito && m.veredito.verdict
    if (marcado) {
      wrap.classList.add('marcado')
      const b = el('button', marcado === 'certo' ? 'marcado-certo' : 'marcado-errado',
        `${icon(marcado === 'certo' ? 'i-check' : 'i-x', 'ico ico-sm')}<span class="mv-txt">${marcado === 'certo' ? 'foi pra pessoa certa' : 'pessoa errada'}</span>`)
      b.title = marcado === 'certo'
        ? 'Você marcou: foi pra pessoa certa. Clique pra mudar.'
        : `Você marcou: deu errado${m.veredito.reason ? ' (' + m.veredito.reason.replace(/_/g, ' ') + ')' : ''}. Clique pra mudar.`
      b.setAttribute('aria-label', b.title)
      b.addEventListener('click', () => abrirVeredito(m))
      wrap.appendChild(b)
      return wrap
    }
    const rotulo = el('span', 'mv-hint', 'foi pra pessoa certa?')
    const ok = el('button', 'mv-ok', icon('i-check', 'ico ico-sm'))
    ok.title = 'Sim, foi pra pessoa certa'; ok.setAttribute('aria-label', 'Marcar: foi pra pessoa certa')
    ok.addEventListener('click', async () => { await marcarVeredito(m, { verdict: 'certo' }) })
    const nao = el('button', 'mv-nao', icon('i-x', 'ico ico-sm'))
    nao.title = 'Não — deu errado (escolher o motivo)'; nao.setAttribute('aria-label', 'Marcar: deu errado')
    nao.addEventListener('click', () => abrirVeredito(m))
    wrap.append(rotulo, ok, nao)
    return wrap
  }

  // Contexto da conversa aberta (WhatsApp ou Instagram) pro veredito saber canal e alvo.
  function contextoVeredito() {
    if (S.tab === 'instagram' && IG.openTid) return { canal: 'instagram', alvo: IG.openTid, personId: (IG.chat && IG.chat.personId) || null }
    return { canal: 'whatsapp', alvo: WA.openJid, personId: (WA.chat && WA.chat.personId) || null }
  }
  async function marcarVeredito(m, { verdict, reason }) {
    const ctx = contextoVeredito()
    const r = await post('/api/veredito', { ...ctx, messageId: m.id, verdict, reason })
    if (!r || !r.ok) { toast('Não consegui anotar', 'err'); return }
    m.veredito = { verdict, reason: reason || null }
    toast(r.efeitos && r.efeitos.length ? r.efeitos.join(', ') : 'Anotado')
    if (ctx.canal === 'whatsapp' && WA.openJid) openThread(WA.openJid)
    else if (ctx.canal === 'instagram' && IG.openTid) igOpenThread(IG.openTid)
  }
  function abrirVeredito(m) {
    const ctx = contextoVeredito()
    abrirMotivoErro({ canal: ctx.canal, alvo: ctx.alvo, messageId: m.id, personId: ctx.personId }, () => {
      if (ctx.canal === 'whatsapp' && WA.openJid) openThread(WA.openJid)
      else if (ctx.canal === 'instagram' && IG.openTid) igOpenThread(IG.openTid)
    })
  }

  function threadComposer(chat) {
    const comp = el('div', 'wc-composer')
    comp.innerHTML = `
      <textarea class="draft" id="wcDraft" placeholder='Escreva uma mensagem ou "/" pra áudio salvo…' rows="1"></textarea>
      <div class="wc-comp-actions">
        <button class="btn ghost wc-audio-trigger" id="wcAudio" title="Mandar um áudio salvo" aria-label="Mandar um áudio salvo">${icon('i-play', 'ico')}<span class="lbl">Áudio</span></button>
        <button class="btn ghost" id="wcAdv" title="Envio avançado (mídia, enquete, localização, contato…)" aria-label="Envio avançado">${icon('i-plus', 'ico')}<span class="lbl">Mais</span></button>
        <button class="btn ghost" id="wcLottie" title="Figurinhas animadas (Lottie)" aria-label="Figurinhas animadas">${icon('i-flame', 'ico')}<span class="lbl">Animadas</span></button>
        <button class="btn gen" id="wcGen" title="Gerar rascunho com IA">${icon('i-spark', 'ico')}<span class="lbl">Gerar com IA</span></button>
        <button class="btn send" id="wcSend" disabled title="Enviar">${icon('i-send', 'ico')}<span class="lbl">Enviar</span></button>
      </div>`
    const draft = comp.querySelector('#wcDraft')
    const btnSend = comp.querySelector('#wcSend')
    const btnGen = comp.querySelector('#wcGen')
    const btnAudio = comp.querySelector('#wcAudio')
    comp.querySelector('#wcAdv').addEventListener('click', () => openAdvancedSend(chat))
    comp.querySelector('#wcLottie').addEventListener('click', () => openLottieLib(chat))
    const grow = () => { draft.style.height = 'auto'; draft.style.height = Math.min(draft.scrollHeight, 140) + 'px' }
    // Regra ERP do atalho "/": abre o picker de áudio só quando o texto COMEÇA com "/";
    // o filtro é o que vem depois da barra; um espaço fecha o modo (voltou a ser texto).
    draft.addEventListener('input', () => {
      btnSend.disabled = !draft.value.trim()
      grow()
      const v = draft.value
      if (v.startsWith('/') && !v.includes(' ')) openAudioPicker(chat.jid, comp, draft, btnSend, v.slice(1))
      else closeAudioPicker()
    })
    // Enter envia; Shift+Enter quebra linha. Quando o picker está aberto ele intercepta
    // Enter/setas/Escape ANTES (listener em captura no openAudioPicker), então aqui só cai
    // o envio de texto normal.
    draft.addEventListener('keydown', (e) => {
      if (audioPicker) return // o picker cuida das teclas enquanto está aberto
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (draft.value.trim()) sendWaMsg(chat.jid, draft, btnSend) }
    })
    btnGen.addEventListener('click', () => generateWaDraft(chat.jid, btnGen, draft, btnSend))
    btnSend.addEventListener('click', () => sendWaMsg(chat.jid, draft, btnSend))
    // Botão de microfone: força o modo "/" (descoberta pra quem não conhece o atalho).
    btnAudio.addEventListener('click', () => {
      if (!draft.value.startsWith('/')) draft.value = '/' + draft.value
      draft.focus()
      grow()
      openAudioPicker(chat.jid, comp, draft, btnSend, draft.value.slice(1).split(' ')[0])
    })
    return comp
  }

  // ---------- ENVIO AVANÇADO (mídia, enquete, localização, contato, evento, interativos…) ----------
  // Metadados de cada campo do catálogo: rótulo + tipo de input. 'url|file' vira campo de URL.
  const ADV_CAMPO = {
    texto: ['Texto', 'area'], caption: ['Legenda', 'text'], 'url|file': ['URL da mídia (http/https)', 'text'],
    viewOnce: ['Ver uma vez', 'check'], linkPreview: ['Mostrar prévia de link', 'check-on'],
    mentions: ['Menções (um jid por linha)', 'area-list'], fileName: ['Nome do arquivo', 'text'], mimetype: ['Tipo MIME', 'text'],
    lat: ['Latitude', 'num'], lng: ['Longitude', 'num'], nome: ['Nome', 'text'], endereco: ['Endereço', 'text'],
    telefone: ['Telefone (+55…)', 'text'], pergunta: ['Pergunta', 'text'], opcoes: ['Opções (uma por linha)', 'area-list'],
    multipla: ['Permite múltipla escolha', 'check'], descricao: ['Descrição', 'text'], inicio: ['Início', 'datetime'], fim: ['Fim', 'datetime'],
    local: ['Local (texto)', 'text'], titulo: ['Título', 'text'], corpo: ['Corpo', 'text'], sourceUrl: ['URL do link', 'text'],
    thumbnailUrl: ['URL da miniatura', 'text'], ligar: ['Ligar temporárias', 'check'], segundos: ['Segundos (86400/604800/2592000)', 'num'],
    animado: ['Animada', 'check'], animada: ['Animada (GIF/vídeo)', 'check'], botoes: ['Botões/itens (um por linha)', 'area-list'], itens: ['Itens (um por linha)', 'area-list'], emoji: ['Emoji', 'text'],
  }
  let ADV_CATALOGO = null
  // ---------- BIBLIOTECA DE FIGURINHAS ANIMADAS (Lottie) ----------
  // Lista as Lotties capturadas com PREVIEW animado (lottie-web carregado sob demanda) e manda
  // a escolhida pra conversa atual (via /api/wa/send-lottie, que remonta a Lottie do zero).
  let _lottieWeb = null
  function carregarLottieWeb() {
    if (window.lottie) return Promise.resolve(true)
    if (_lottieWeb) return _lottieWeb
    _lottieWeb = new Promise((resolve) => {
      const s = document.createElement('script'); s.src = '/lottie.min.js'
      s.onload = () => resolve(!!window.lottie); s.onerror = () => resolve(false)
      document.head.appendChild(s)
    })
    return _lottieWeb
  }
  async function openLottieLib(chat) {
    const r = await api('/api/wa/lottie-library')
    const lotties = (r && r.lotties) || []
    const ov = overlay(); const sheet = el('div', 'pj-sheet adv-sheet')
    sheet.innerHTML = `<header class="pj-sheet-head"><h3>Figurinhas animadas</h3><button class="pj-x" aria-label="Fechar">${icon('i-x')}</button></header>
      <div class="adv-body">${lotties.length
        ? `<div class="lot-grid">${lotties.map((l) => `<button class="lot-item" data-file="${esc(l.file)}" title="${esc(l.nome)}"><div class="lot-prev" data-id="lp_${esc(l.file.replace(/\W/g, ''))}"></div><span>${esc(l.nome)}</span></button>`).join('')}</div>`
        : '<div class="adv-note">Nenhuma figurinha animada capturada ainda. Toda Lottie que você receber entra aqui automaticamente.</div>'}</div>`
    ov.appendChild(sheet)
    sheet.querySelector('.pj-x').addEventListener('click', () => ov.remove())
    sheet.querySelectorAll('.lot-item').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true; b.classList.add('sending')
      const r2 = await post('/api/wa/send-lottie', { personId: chat.personId, jid: chat.jid, file: b.dataset.file })
      b.disabled = false; b.classList.remove('sending')
      if (r2 && r2.ok) { toast('figurinha enviada'); ov.remove() } else { toast('falhou: ' + ((r2 && r2.error) || '?'), 'erro') }
    }))
    // previews animados (best-effort): sem a lib, fica só o nome
    if (lotties.length && await carregarLottieWeb() && window.lottie) {
      for (const l of lotties) {
        const cont = sheet.querySelector(`[data-id="lp_${l.file.replace(/\W/g, '')}"]`)
        if (!cont) continue
        try {
          const data = await (await fetch('/api/wa/lottie-json?file=' + encodeURIComponent(l.file))).json()
          window.lottie.loadAnimation({ container: cont, renderer: 'svg', loop: true, autoplay: true, animationData: data })
        } catch { /* preview é enfeite */ }
      }
    }
  }

  async function openAdvancedSend(chat) {
    if (!ADV_CATALOGO) { const r = await api('/api/wa/advanced-catalog'); ADV_CATALOGO = r && r.catalogo; if (!ADV_CATALOGO) { toast('não carreguei o catálogo', 'erro'); return } }
    // No composer só entram os tipos de CRIAR mensagem (os que operam sobre uma mensagem
    // existente — reação/editar/apagar/fixar/responder — vão no menu de cada bolha).
    // "Criar figurinha" é especial (fabrica um webp de imagem/GIF/vídeo via /api/wa/make-sticker,
    // não é um tipo do catálogo de envio). Fica no topo, com aviso.
    const CRIAR_FIG = { type: '__criar_figurinha__', label: 'Criar figurinha (de imagem/GIF/vídeo)', pessoal: 'ok', campos: ['url|file', 'animada'] }
    const tipos = [CRIAR_FIG, ...ADV_CATALOGO.filter((c) => !c.precisaAlvo)]
    const ov = overlay(); const sheet = el('div', 'pj-sheet adv-sheet')
    sheet.innerHTML = `<header class="pj-sheet-head"><h3>Envio avançado</h3><button class="pj-x" aria-label="Fechar">${icon('i-x')}</button></header>
      <div class="adv-body">
        <label class="adv-lbl">Tipo de mensagem
          <select class="adv-sel" id="advType">${tipos.map((c) => `<option value="${c.type}">${esc(c.label)}${c.pessoal === 'nao' ? ' (legado)' : ''}</option>`).join('')}</select>
        </label>
        <div id="advFields"></div>
        <div class="adv-note" id="advNote"></div>
      </div>
      <footer class="pj-sheet-foot"><button class="btn send" id="advSend">${icon('i-send', 'ico')}<span>Enviar</span></button></footer>`
    ov.appendChild(sheet)
    sheet.querySelector('.pj-x').addEventListener('click', () => ov.remove())
    const sel = sheet.querySelector('#advType'); const fieldsBox = sheet.querySelector('#advFields'); const note = sheet.querySelector('#advNote')
    const inputs = {}
    const render = () => {
      const c = tipos.find((x) => x.type === sel.value); fieldsBox.innerHTML = ''; for (const k of Object.keys(inputs)) delete inputs[k]
      for (const campo of (c.campos || [])) {
        const meta = ADV_CAMPO[campo] || [campo, 'text']
        const id = 'adv_' + campo.replace(/\W/g, '')
        const wrap = el('label', 'adv-lbl')
        if (meta[1] === 'check' || meta[1] === 'check-on') {
          wrap.classList.add('row'); wrap.innerHTML = `<input type="checkbox" id="${id}" ${meta[1] === 'check-on' ? 'checked' : ''}><span>${esc(meta[0])}</span>`
        } else if (meta[1] === 'area' || meta[1] === 'area-list') {
          wrap.innerHTML = `<span>${esc(meta[0])}</span><textarea id="${id}" rows="2"></textarea>`
        } else {
          const t = meta[1] === 'num' ? 'number' : meta[1] === 'datetime' ? 'datetime-local' : 'text'
          wrap.innerHTML = `<span>${esc(meta[0])}</span><input type="${t}" id="${id}">`
        }
        fieldsBox.appendChild(wrap); inputs[campo] = { el: wrap.querySelector('#' + id), kind: meta[1] }
      }
      note.textContent = c.pessoal === 'nao' ? 'Tipo legado: o WhatsApp transmite mas normalmente NÃO renderiza em conta pessoal.' : (c.pessoal === 'talvez' ? 'Pode não renderizar dependendo da versão do WhatsApp.' : '')
    }
    sel.addEventListener('change', render); render()
    sheet.querySelector('#advSend').addEventListener('click', async () => {
      const c = tipos.find((x) => x.type === sel.value); const spec = { type: c.type }
      for (const [campo, o] of Object.entries(inputs)) {
        let v = o.kind === 'check' || o.kind === 'check-on' ? o.el.checked : o.el.value
        if (o.kind === 'area-list') v = String(v).split('\n').map((s) => s.trim()).filter(Boolean)
        else if (o.kind === 'num') v = o.el.value === '' ? undefined : Number(o.el.value)
        else if (o.kind === 'datetime') v = o.el.value ? new Date(o.el.value).getTime() : undefined
        // 'url|file' guarda em spec.url; os demais no próprio nome
        if (campo === 'url|file') spec.url = v
        else if (campo === 'linkPreview') { if (v === false) spec.linkPreview = false }
        else if (v !== undefined && v !== '') spec[campo] = v
      }
      const btn = sheet.querySelector('#advSend'); btn.disabled = true
      // Criar figurinha vai por outra rota (fabrica o webp); os demais pela de envio avançado.
      const r = c.type === '__criar_figurinha__'
        ? await post('/api/wa/make-sticker', { personId: chat.personId, jid: chat.jid, url: spec.url, animada: !!spec.animada })
        : await post('/api/wa/send-advanced', { personId: chat.personId, jid: chat.jid, spec })
      btn.disabled = false
      if (r && r.ok) { toast(c.type === '__criar_figurinha__' ? 'figurinha criada e enviada' : 'enviado: ' + c.label); ov.remove() } else { toast('falhou: ' + ((r && r.error) || '?'), 'erro') }
    })
  }

  function scrollThreadToEnd() {
    requestAnimationFrame(() => { const m = $('#wcMsgs'); if (m) m.scrollTop = m.scrollHeight })
  }

  // TROCAR AS BOLHAS SEM ENCOSTAR NO SCROLL DELE.
  //
  // Regra do dono (28/07/2026): "eu controlo o scroll — ele abre embaixo e ali deve
  // permanecer, a menos que eu role". O que acontecia era o contrário, por dois motivos, e o
  // segundo é o que ele sentia como "pula pra cima sozinho":
  //
  //  1. A thread era REFEITA a cada poll (8-10s) mesmo quando nada tinha mudado.
  //  2. `replaceWith` põe um elemento NOVO no lugar, e elemento novo nasce com scrollTop = 0,
  //     ou seja, NO TOPO. Quem estava lendo o meio da conversa era jogado pra cima; quem
  //     estava no fim só não percebia porque o `nearBottom` rolava de volta — e mesmo assim
  //     aparecia como um tranco.
  //
  // Agora: HTML idêntico não toca no DOM (o caso de longe mais comum, e o scroll fica
  // literalmente intocado). Quando muda de verdade, o que se preserva é a DISTÂNCIA DO FUNDO,
  // não o scrollTop: mensagem nova entra embaixo, então guardar o topo faria o texto que ele
  // está lendo escorregar pra cima do mesmo jeito.
  function trocarBolhas(old, novo, rolarPraFim) {
    if (!old || !novo) return
    if (old.innerHTML === novo.innerHTML) return
    const doFundo = old.scrollHeight - old.scrollTop - old.clientHeight
    const estavaNoFim = doFundo < 60
    old.replaceWith(novo)
    if (estavaNoFim) { rolarPraFim(); return }
    requestAnimationFrame(() => { novo.scrollTop = Math.max(0, novo.scrollHeight - novo.clientHeight - doFundo) })
  }

  // ---------- ações da thread ----------
  // Toggle da IA de UMA conversa (usado pelo switch do cabeçalho E pelos da lista).
  // Otimista: reflete o novo estado em WA.chats + WA.chat e mantém os dois switches
  // (lista e cabeçalho) em sincronia. `tg` é o switch clicado (pra reverter em falha).
  async function toggleAiForChat(jid, next, tg) {
    if (tg) { tg.setAttribute('aria-checked', String(next)); tg.disabled = true }
    applyAiState(jid, next)              // otimista: pinta lista + cabeçalho na hora
    const r = await post('/api/wa/chat/ai', { jid, enable: next })
    if (tg) tg.disabled = false
    if (!r || !r.ok) {
      applyAiState(jid, !next)           // reverte todos os switches dessa conversa
      toast('Não deu pra mudar a IA', 'err')
      return
    }
    const on = r.aiOn != null ? !!r.aiOn : next
    applyAiState(jid, on, r.personId)
    toast(on ? 'IA ligada nesta conversa' : 'IA desligada')
  }

  // Sincroniza o estado da IA de um jid no modelo (WA.chats/WA.chat) e no DOM
  // (todos os switches da lista + o do cabeçalho, se a thread aberta é a mesma).
  function applyAiState(jid, on, personId) {
    const listed = (WA.chats || []).find((c) => c.jid === jid)
    if (listed) { listed.aiOn = on; if (personId) listed.personId = personId }
    if (WA.chat && WA.chat.jid === jid) { WA.chat.aiOn = on; if (personId) WA.chat.personId = personId }
    // switches da lista (cada item guarda o jid em data-ai-jid)
    $$(`#wcListScroll .wc-item-ai[data-ai-jid="${CSS.escape(jid)}"]`).forEach((t) => t.setAttribute('aria-checked', String(on)))
    // switch do cabeçalho da thread aberta
    if (WA.openJid === jid) { const h = $('#wcAiToggle'); if (h) h.setAttribute('aria-checked', String(on)) }
  }

  // ---------- MODO DE CONVERSA (registro da IA por pessoa) ----------
  // O dono marca a pessoa e a IA passa a conversar naquele registro.
  // Valor null = sem modo (tom padrão). Labels ↔ valores do contrato:
  // Os 5 "modos" antigos viraram legado: a verdade agora é o VÍNCULO da pessoa (20 tipos,
  // vindos da leitura do corpus), servido por /api/self/vinculos. Duas listas na tela eram
  // duas verdades — o menu mostrava 5 opções enquanto o banco classificava em 20.
  // WA_MODES fica só pra pintar conversa que ainda tenha modo manual antigo gravado.
  const WA_MODES = [
    { value: null,              key: 'none',    label: 'Sem vínculo', desc: 'a IA conversa no tom de sempre' },
    { value: 'romance-paquera', key: 'paquera', label: 'Paquera',  desc: 'flerte inicial, estilo Tinder' },
    { value: 'romance-quente',  key: 'romance', label: 'Romance',  desc: 'relação quente, rotina de carinho' },
    { value: 'amigo',           key: 'amigo',   label: 'Amigo',    desc: 'zoeira e objetividade' },
    { value: 'negocio',         key: 'negocio', label: 'Negócio',  desc: 'trampo, direto e informal' },
    { value: 'civico',          key: 'civico',  label: 'Cívico',   desc: 'pauta pública, mais cuidado' },
  ]
  // cor do pontinho por grupo do catálogo (romântico/pessoal/trabalho/público/outro)
  const GRUPO_KEY = { 'Romântico': 'paquera', Pessoal: 'amigo', Trabalho: 'negocio', 'Público': 'civico', Outro: 'none' }

  // Lista de vínculos do menu de contexto. Vem do backend; enquanto não chega, o menu
  // ainda abre (só sem as opções), então nada trava.
  let CATALOGO_VINC = []
  async function garantirCatalogo() {
    if (CATALOGO_VINC.length) return CATALOGO_VINC
    const r = await api('/api/self/vinculos')
    CATALOGO_VINC = (r && r.catalogo) || []
    return CATALOGO_VINC
  }
  function modeInfo(mode) { return WA_MODES.find((m) => m.value === (mode || null)) || WA_MODES[0] }

  // chip pequeno na linha da lista (sem modo = sem badge, não polui)
  function modeChipHtml(mode) {
    if (!mode) return ''
    const m = modeInfo(mode)
    return `<span class="wc-mode-tag mode-c-${m.key}">${esc(m.label)}</span>`
  }

  // modo atual de um jid pelo modelo local (thread aberta tem prioridade)
  function currentModeFor(jid) {
    if (WA.chat && WA.chat.jid === jid) return WA.chat.mode || null
    const listed = (WA.chats || []).find((c) => c.jid === jid)
    return (listed && listed.mode) || null
  }

  function currentObjectiveFor(jid) {
    if (WA.chat && WA.chat.jid === jid) return WA.chat.objective || ''
    const listed = (WA.chats || []).find((c) => c.jid === jid)
    return (listed && listed.objective) || ''
  }

  function syncHeadToggle(btn, ligado) {
    if (!btn) return
    btn.setAttribute('aria-checked', String(!!ligado))
    const wrap = btn.closest('.wc-head-toggle')
    if (wrap) wrap.classList.toggle('on', !!ligado)
  }

  function wireCobrancaHeadToggle(btn, personId, channelLabel, name = '') {
    if (!btn || !personId) return
    syncHeadToggle(btn, false)
    api(`/api/self/cobranca/pessoa?personId=${encodeURIComponent(personId)}`).then((st) => {
      if (btn.isConnected && st) {
        syncHeadToggle(btn, st.cobrancaAutorizada)
        btn.title = st.motivo ? `Motivo: ${st.motivo}` : 'Definir motivo da cobrança'
      }
    })
    btn.addEventListener('click', () => {
      openCobrancaEditor({
        personId,
        name,
        anchor: btn,
        onSaved: (r) => {
          syncHeadToggle(btn, r.cobrancaAutorizada)
          btn.title = r.motivo ? `Motivo: ${r.motivo}` : `Definir motivo da cobrança no ${channelLabel}`
        },
      })
    })
  }

  // pinta uma única pill de contexto. O alvo só existe quando há objetivo.
  function paintModePill(pill, mode, objective = '') {
    const m = modeInfo(mode)
    const hasObjective = !!String(objective || '').trim()
    pill.className = 'wc-mode-pill' + (mode ? ` has-mode mode-c-${m.key}` : '') + (hasObjective ? ' has-objective' : '')
    pill.innerHTML = `
      <span class="wc-mode-dot"></span>
      ${hasObjective ? `<span class="wc-objective-mark">${icon('i-target', 'ico ico-sm')}</span>` : ''}
      <span class="wc-mode-txt"><span class="pfx">${mode || hasObjective ? 'Contexto: ' : ''}</span><b>${mode ? esc(m.label) : (hasObjective ? 'Objetivo' : 'Contexto')}</b></span>
      <span class="chev">${icon('i-arrow-r', 'ico ico-sm')}</span>`
    pill.setAttribute('aria-label', `Contexto da conversa. Modo: ${mode ? m.label : 'padrão'}. Objetivo: ${hasObjective ? objective : 'não definido'}`)
  }

  // espelha o modo de um jid no modelo (WA.chats/WA.chat) e no DOM (badge da lista + pill)
  function applyModeState(jid, mode) {
    const listed = (WA.chats || []).find((c) => c.jid === jid)
    if (listed) listed.mode = mode
    if (WA.chat && WA.chat.jid === jid) WA.chat.mode = mode
    if ($('#wcListScroll')) renderWaChats()   // repinta a lista (badge aparece/some)
    if (WA.openJid === jid) { const pill = $('#wcModePill'); if (pill) paintModePill(pill, mode, currentObjectiveFor(jid)) }
  }

  function applyObjectiveState(jid, objective) {
    const value = String(objective || '').trim()
    const listed = (WA.chats || []).find((c) => c.jid === jid)
    if (listed) listed.objective = value
    if (WA.chat && WA.chat.jid === jid) WA.chat.objective = value
    if (WA.openJid === jid) {
      const pill = $('#wcModePill')
      if (pill) paintModePill(pill, currentModeFor(jid), value)
    }
  }

  // grava no backend com atualização otimista (reverte se falhar)
  async function setChatMode(jid, mode) {
    const prev = currentModeFor(jid)
    if (prev === mode) return
    applyModeState(jid, mode)
    const r = await post('/api/wa/chat/mode', { jid, mode })
    if (!r || !r.ok) {
      applyModeState(jid, prev)
      toast('Não deu pra mudar o modo', 'err')
      return
    }
    const final = (r.mode !== undefined) ? (r.mode || null) : mode
    if (final !== mode) applyModeState(jid, final)
    toast(final ? `Modo definido: ${modeInfo(final).label}` : 'Modo removido')
  }

  // ---------- popover do modo (menu custom; no mobile vira folha ancorada embaixo) ----------

  // O menu de contexto cresceu (objetivo + encontro + catálogo de vínculos) e passou a
  // estourar a altura da janela no desktop, deixando as últimas opções fora de alcance.
  // A altura vira o espaço REAL abaixo da pill (rola por dentro); se nem isso der, o menu
  // sobe. Medida em px, então continua valendo quando o catálogo chega depois, por rede.
  const MENU_ALTURA_MIN = 200
  function ajustaMenuNaTela(menu, pill) {
    if (!menu || !menu.isConnected || !pill || !pill.isConnected) return
    menu._anchor = pill
    if (window.matchMedia('(max-width: 640px)').matches) {   // folha ancorada embaixo: o CSS resolve
      menu.classList.remove('up')
      menu.style.maxHeight = ''
      return
    }
    const MARGEM = 16, GAP = 8
    const r = pill.getBoundingClientRect()
    const abaixo = window.innerHeight - r.bottom - GAP - MARGEM
    const acima = r.top - GAP - MARGEM
    const sobe = abaixo < MENU_ALTURA_MIN && acima > abaixo
    menu.classList.toggle('up', sobe)
    menu.style.maxHeight = Math.max(MENU_ALTURA_MIN, Math.round(sobe ? acima : abaixo)) + 'px'
  }
  window.addEventListener('resize', () => {
    $$('.wc-mode-menu').forEach((m) => ajustaMenuNaTela(m, m._anchor))
  })

  // traz o item pra dentro da área visível do menu sem mexer na rolagem da página
  function revelaNoMenu(menu, item) {
    if (!menu || !item || menu.scrollHeight <= menu.clientHeight) return
    const topo = item.offsetTop, base = topo + item.offsetHeight
    if (topo < menu.scrollTop) menu.scrollTop = Math.max(0, topo - 6)
    else if (base > menu.scrollTop + menu.clientHeight) menu.scrollTop = base - menu.clientHeight + 6
  }

  let modeMenu = null   // { root, pill, jid, onDoc, onKey }

  function closeModeMenu(refocus) {
    if (!modeMenu) return
    const st = modeMenu; modeMenu = null
    document.removeEventListener('pointerdown', st.onDoc, true)
    document.removeEventListener('keydown', st.onKey, true)
    st.root.remove()
    if (st.pill && st.pill.isConnected) {
      st.pill.setAttribute('aria-expanded', 'false')
      if (refocus) st.pill.focus()
    }
  }

  // Atalho de encontro por conversa: mesmo interruptor da Config, mas só desta pessoa.
  // Nasce herdando o global e só vira exceção quando o dono toca — assim ligar/desligar
  // no geral continua valendo pra todo mundo que ele não marcou à mão.
  // O mesmo "Entregar serviço" fora do menu Contexto: o Badoo não tem aquele menu, e a entrega
  // não podia depender de onde o menu existe. Abre uma folha ancorada no botão do cabeçalho.
  let entregaPop = null
  function fecharEntregaPop() {
    if (!entregaPop) return
    document.removeEventListener('pointerdown', entregaPop.onDoc, true)
    entregaPop.root.remove()
    entregaPop.botao?.setAttribute('aria-expanded', 'false')
    entregaPop = null
  }
  function abrirEntregaPop(botao, ctx) {
    if (entregaPop) { fecharEntregaPop(); return }
    // `position: fixed` calculado na mão: a folha do menu Contexto nasce DENTRO de um pai
    // posicionado, e esta nasce no body — sem isto ela cai no fim da página, fora da vista.
    const root = el('div', 'entrega-pop')
    const scrim = el('div', 'wc-mode-scrim')
    const menu = el('div', 'wc-mode-menu entrega-pop-menu')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', 'Entregar serviço')
    const bloco = entregaMenuOpt(ctx.personId, ctx)
    // Nasce ABERTA e sem simular clique: clicar aqui alternaria o estado e fecharia a gaveta
    // antes de a lista chegar da rede — foi o que aconteceu na primeira versão.
    bloco.dataset.aberta = '1'
    menu.appendChild(bloco)
    root.append(scrim, menu)
    root.addEventListener('click', (e) => e.stopPropagation())
    document.body.appendChild(root)
    botao.setAttribute('aria-expanded', 'true')
    const onDoc = (e) => { if (!menu.contains(e.target) && e.target !== botao && !botao.contains(e.target)) fecharEntregaPop() }
    document.addEventListener('pointerdown', onDoc, true)
    entregaPop = { root, botao, onDoc }
    const r = botao.getBoundingClientRect()
    const largura = 300
    menu.style.width = `${largura}px`
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - largura - 8))}px`
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 120)}px`
  }

  // ENTREGAR UM SERVIÇO. O produto (link, instruções, fotos com direito de uso) sai daqui e
  // só daqui: nenhum caminho automático alcança esta rota, e a IA não conhece o conteúdo.
  // Dois cliques no mesmo botão para confirmar — entregar é irreversível, a mensagem sai.
  function entregaMenuOpt(personId, { jid = null, chatId = null, canal = 'whatsapp' } = {}) {
    const bloco = el('div', 'wc-etq-bloco')
    const opt = el('button', 'wc-mode-opt wc-entrega-opt')
    opt.type = 'button'
    opt.setAttribute('role', 'menuitem')
    const gaveta = el('div', 'wc-etq-gaveta')
    let servicos = null

    const pintaTopo = () => {
      const n = servicos === null ? null : servicos.length
      opt.innerHTML = `
        <span class="wc-objective-menu-icon">${icon('i-send', 'ico')}</span>
        <span class="wc-mode-opt-txt"><b>Entregar serviço</b><small>${n === null
          ? 'carregando…'
          : (n ? `${n} ${n === 1 ? 'serviço pronto' : 'serviços prontos'} para entregar` : 'nenhum serviço com entrega configurada')}</small></span>
        <span class="wc-context-edit">${icon('i-plus', 'ico ico-sm')}</span>`
    }

    const pintaGaveta = () => {
      if (!servicos?.length) {
        gaveta.replaceChildren(el('small', 'wc-etq-vazio',
          'Configure o link ou as fotos em Config → Grana → Serviços e valores.'))
        return
      }
      gaveta.replaceChildren(...servicos.map((s) => {
        const b = el('button', 'btn ghost small wc-entrega-item',
          `<span>${esc(s.nome)}</span><small>${[s.temLink ? 'link' : null, s.fotos ? `${s.fotos} foto${s.fotos === 1 ? '' : 's'}` : null].filter(Boolean).join(' + ')}</small>`)
        b.type = 'button'
        b.addEventListener('click', (ev) => {
          ev.stopPropagation()
          confirmDestructive(b, s.nome, async () => {
            const r = await post('/api/servicos/entregar', { personId, canal, jid, chatId, indice: s.indice })
            if (!r?.ok) { toast(r?.erro || 'Não deu pra entregar.', 'err'); return }
            const f = r.feito || {}
            toast(f.falhas?.length
              ? `Entrega parcial de "${s.nome}": ${f.falhas.join('; ')}`
              : `"${s.nome}" entregue${f.fotos ? ` (${f.fotos} foto${f.fotos === 1 ? '' : 's'})` : ''}.`,
              f.falhas?.length ? 'err' : undefined)
          })
        })
        return b
      }))
    }

    pintaTopo()
    opt.addEventListener('click', (e) => {
      e.stopPropagation()
      const aberta = bloco.dataset.aberta === '1'
      bloco.dataset.aberta = aberta ? '0' : '1'
      if (aberta) gaveta.replaceChildren(); else pintaGaveta()
    })
    api('/api/servicos/entrega').then((r) => {
      servicos = r?.servicos || []
      pintaTopo()
      if (bloco.dataset.aberta === '1') pintaGaveta()
    }).catch(() => { servicos = []; pintaTopo() })
    bloco.append(opt, gaveta)
    return bloco
  }

  // ETIQUETAS DESTA PESSOA, dentro do menu Contexto. Marcar aqui vale para a pessoa inteira —
  // ela pode existir no WhatsApp e no Tinder, e a etiqueta é da PESSOA, não da conversa.
  // Vira um item que abre a lista embaixo dele, para o menu não crescer sem controle.
  function etiquetasMenuOpt(personId) {
    const bloco = el('div', 'wc-etq-bloco')
    const opt = el('button', 'wc-mode-opt wc-etq-opt')
    opt.type = 'button'
    opt.setAttribute('role', 'menuitem')
    const gaveta = el('div', 'wc-etq-gaveta')
    let daPessoa = []

    const pintaTopo = () => {
      opt.innerHTML = `
        <span class="wc-objective-menu-icon">${icon('i-pin', 'ico')}</span>
        <span class="wc-mode-opt-txt"><b>Etiquetas</b><small>${daPessoa.length
          ? esc(daPessoa.map((e) => e.nome).join(', '))
          : 'nenhuma nesta pessoa'}</small></span>
        <span class="wc-context-edit">${icon('i-plus', 'ico ico-sm')}</span>`
    }

    const pintaGaveta = () => {
      const todas = ETIQUETAS || []
      if (!todas.length) {
        gaveta.replaceChildren(el('small', 'wc-etq-vazio', ETIQUETAS === null
          ? 'carregando…'
          : 'Nenhuma etiqueta criada. Crie em Config → Sistema → Etiquetas.'))
        return
      }
      gaveta.replaceChildren(...todas.map((etq) => {
        const tem = daPessoa.some((e) => e.id === etq.id)
        const b = el('button', `etq-chip cor-${etq.cor} wc-etq-chip${tem ? ' on' : ''}`, `<span class="etq-chip-txt">${esc(etq.nome)}</span>`)
        b.type = 'button'
        b.setAttribute('aria-pressed', tem ? 'true' : 'false')
        b.addEventListener('click', async (e) => {
          e.stopPropagation()
          const r = await post('/api/etiquetas/pessoa', { personId, etiquetaId: etq.id, marcar: !tem })
          if (!r?.ok) { toast(r?.erro || 'Não deu pra mudar a etiqueta.', 'err'); return }
          daPessoa = r.etiquetas || []
          pintaTopo(); pintaGaveta()
          toast(tem ? `Tirou "${etq.nome}"` : `Marcou "${etq.nome}"`)
        })
        return b
      }))
    }

    pintaTopo()
    opt.addEventListener('click', (e) => {
      e.stopPropagation()
      const aberta = bloco.dataset.aberta === '1'
      bloco.dataset.aberta = aberta ? '0' : '1'
      if (aberta) gaveta.replaceChildren(); else pintaGaveta()
    })
    Promise.all([
      carregarEtiquetas(),
      api(`/api/etiquetas/pessoa?personId=${encodeURIComponent(personId)}`).catch(() => null),
    ]).then(([, r]) => {
      daPessoa = r?.etiquetas || []
      pintaTopo()
      if (bloco.dataset.aberta === '1') pintaGaveta()
    })
    bloco.append(opt, gaveta)
    return bloco
  }

  function encontroMenuOpt(personId, fecharMenu) {
    const opt = el('button', 'wc-mode-opt wc-enc-opt')
    opt.type = 'button'
    opt.setAttribute('role', 'menuitemcheckbox')
    const pinta = (ligado, herdando) => {
      opt.setAttribute('aria-checked', String(!!ligado))
      opt.classList.toggle('on', !!ligado)
      opt.innerHTML = `
        <span class="wc-objective-menu-icon">${icon('i-cal', 'ico')}</span>
        <span class="wc-mode-opt-txt"><b>Pode propor encontro</b><small>${ligado ? (herdando ? 'sim, seguindo o ajuste geral' : 'sim, só nesta conversa') : (herdando ? 'não, seguindo o ajuste geral' : 'não, só nesta conversa')}</small></span>
        <span class="wc-mode-check">${icon('i-check', 'ico ico-sm')}</span>`
    }
    pinta(true, true)
    api(`/api/self/encontros/pessoa?personId=${encodeURIComponent(personId)}`).then((st) => { if (st) pinta(st.proporDates, st.herdando) })
    opt.addEventListener('click', async (e) => {
      e.stopPropagation()
      const ligado = opt.getAttribute('aria-checked') === 'true'
      const r = await post('/api/self/encontros/propor', { personId, enabled: !ligado })
      if (r && r.ok) { pinta(r.proporDates, false); toast(r.proporDates ? 'Pode propor encontro nesta conversa' : 'Não propõe encontro nesta conversa') }
      else toast('Não deu pra mudar o ajuste', 'err')
      if (typeof fecharMenu === 'function') fecharMenu()
    })
    return opt
  }

  // O irmão do de cima, para o TRABALHO. Existe separado porque desligar romance não pode
  // desligar atendimento — foi o que aconteceu em 15/08/2026. Nasce herdando o geral, que
  // nasce desligado: por isso a pintura otimista aqui é `false`, e não `true`.
  function atendimentoMenuOpt(personId, fecharMenu) {
    const opt = el('button', 'wc-mode-opt wc-enc-opt')
    opt.type = 'button'
    opt.setAttribute('role', 'menuitemcheckbox')
    const pinta = (ligado, herdando) => {
      opt.setAttribute('aria-checked', String(!!ligado))
      opt.classList.toggle('on', !!ligado)
      opt.innerHTML = `
        <span class="wc-objective-menu-icon">${icon('i-cal', 'ico')}</span>
        <span class="wc-mode-opt-txt"><b>Pode marcar atendimento</b><small>${ligado ? (herdando ? 'sim, seguindo o ajuste geral' : 'sim, só nesta conversa') : (herdando ? 'não, seguindo o ajuste geral' : 'não, só nesta conversa')}</small></span>
        <span class="wc-mode-check">${icon('i-check', 'ico ico-sm')}</span>`
    }
    pinta(false, true)
    api(`/api/self/encontros/pessoa?personId=${encodeURIComponent(personId)}`).then((st) => { if (st) pinta(st.marcarAtendimento, st.herdandoAtendimento) })
    opt.addEventListener('click', async (e) => {
      e.stopPropagation()
      const ligado = opt.getAttribute('aria-checked') === 'true'
      const r = await post('/api/self/atendimento/marcar', { personId, enabled: !ligado })
      if (r && r.ok) { pinta(r.marcarAtendimento, false); toast(r.marcarAtendimento ? 'Pode marcar atendimento nesta conversa' : 'Não marca atendimento nesta conversa') }
      else toast('Não deu pra mudar o ajuste', 'err')
      if (typeof fecharMenu === 'function') fecharMenu()
    })
    return opt
  }

  function cobrancaMenuOpt(personId, fecharMenu) {
    const opt = el('button', 'wc-mode-opt wc-cobr-opt')
    opt.type = 'button'
    opt.setAttribute('role', 'menuitemcheckbox')
    const pinta = (ligado, motivo = '', historico = null) => {
      opt.setAttribute('aria-checked', String(!!ligado))
      opt.classList.toggle('on', !!ligado)
      const resumo = String(motivo || '').trim()
      const envios = resumoHistoricoCobranca(historico)
      opt.innerHTML = `
        <span class="wc-objective-menu-icon">${icon('i-card', 'ico')}</span>
        <span class="wc-mode-opt-txt"><b>Cobrança e motivo</b><small>${esc(envios)} · ${ligado ? esc(resumo) : (resumo ? `bloqueada · ${esc(resumo)}` : 'defina por que esta pessoa deve pagar')}</small></span>
        <span class="wc-mode-check">${icon('i-check', 'ico ico-sm')}</span>`
    }
    pinta(false)
    api(`/api/self/cobranca/pessoa?personId=${encodeURIComponent(personId)}`).then((st) => { if (st) pinta(st.cobrancaAutorizada, st.motivo, st.historico) })
    opt.addEventListener('click', (e) => {
      e.stopPropagation()
      openCobrancaEditor({ personId, anchor: opt, onSaved: (r) => pinta(r.cobrancaAutorizada, r.motivo, r.historico) })
      if (typeof fecharMenu === 'function') fecharMenu()
    })
    return opt
  }

  // Opções de VÍNCULO no menu de contexto, agrupadas (Romântico/Pessoal/Trabalho/Público).
  // personId é a chave: vínculo é da PESSOA, não da thread. Enquanto o catálogo não chega,
  // mostra as opções assim que a resposta volta (o menu já está aberto e se completa).
  function montarOpcoesVinculo(menu, personId, aoEscolher) {
    const secao = el('div', 'wc-context-section', 'Vínculo com esta pessoa')
    const host = el('div', 'wc-vinc-opts')
    menu.append(secao, host)
    const pintar = (catalogo, atual, ehPadrao) => {
      host.replaceChildren()
      const nenhum = el('button', 'wc-mode-opt' + (!atual ? ' on' : ''))
      nenhum.type = 'button'
      nenhum.setAttribute('role', 'menuitemradio')
      nenhum.setAttribute('aria-checked', String(!atual))
      nenhum.innerHTML = `<span class="wc-mode-swatch"></span>
        <span class="wc-mode-opt-txt"><b>Sem vínculo <small class="df">(padrão)</small></b><small>a IA conversa no tom de sempre</small></span>
        <span class="wc-mode-check">${icon('i-check', 'ico ico-sm')}</span>`
      nenhum.addEventListener('click', (e) => { e.stopPropagation(); aoEscolher(null) })
      host.appendChild(nenhum)
      let grupoAtual = ''
      catalogo.forEach((c) => {
        if (c.grupo !== grupoAtual) { grupoAtual = c.grupo; host.appendChild(el('div', 'wc-vinc-grupo', esc(c.grupo))) }
        const on = atual === c.valor
        const opt = el('button', `wc-mode-opt mode-c-${GRUPO_KEY[c.grupo] || 'none'}` + (on ? ' on' : ''))
        opt.type = 'button'
        opt.setAttribute('role', 'menuitemradio')
        opt.setAttribute('aria-checked', String(on))
        opt.innerHTML = `<span class="wc-mode-swatch"></span>
          <span class="wc-mode-opt-txt"><b>${esc(c.label)}${on && ehPadrao ? ' <small class="df">(veio do Tinder)</small>' : ''}</b><small>${esc(c.desc)}</small></span>
          <span class="wc-mode-check">${icon('i-check', 'ico ico-sm')}</span>`
        opt.addEventListener('click', (e) => { e.stopPropagation(); aoEscolher(c.valor) })
        host.appendChild(opt)
      })
    }
    // O catálogo vem por rede. Se não vier, o menu abriria só com "Sem vínculo" e pareceria
    // que os vínculos sumiram — então a falha aparece na cara, com jeito de tentar de novo.
    const avisarFalha = () => {
      const retry = el('button', 'wc-mode-opt wc-vinc-retry')
      retry.type = 'button'
      retry.innerHTML = `<span class="wc-mode-swatch"></span>
        <span class="wc-mode-opt-txt"><b>Não consegui carregar os vínculos</b><small>toque pra tentar de novo</small></span>`
      retry.addEventListener('click', (e) => { e.stopPropagation(); carregarVinculos() })
      host.appendChild(retry)
    }
    const carregarVinculos = () => {
      pintar(CATALOGO_VINC, null, false)
      Promise.all([garantirCatalogo(), api(`/api/self/vinculos?personId=${encodeURIComponent(personId)}`)])
        .then(([cat, r]) => {
          const atual = r?.vinculo?.vinculo || null
          pintar(cat, atual, !!r?.padrao)
          if (!cat || !cat.length) avisarFalha()
          // o catálogo chega por rede e muda a altura: remede o teto e, se o dono ainda não
          // rolou, mostra o vínculo que está marcado (pode estar lá embaixo na lista)
          ajustaMenuNaTela(menu, menu._anchor)
          if (atual && menu.scrollTop === 0) revelaNoMenu(menu, host.querySelector('.wc-mode-opt.on'))
        })
        .catch(() => { pintar(CATALOGO_VINC, null, false); avisarFalha() })
    }
    carregarVinculos()
  }

  function openModeMenu(wrap, pill, jid) {
    closeModeMenu(false); closeTinderMenu(false)
    const cur = currentModeFor(jid)
    const root = el('div', 'wc-mode-pop')
    const scrim = el('div', 'wc-mode-scrim')       // só aparece no mobile (folha)
    const menu = el('div', 'wc-mode-menu')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', 'Contexto da conversa')
    const objective = currentObjectiveFor(jid)
    const goal = el('button', 'wc-mode-opt wc-objective-menu-opt' + (objective ? ' has-objective' : ''))
    goal.type = 'button'
    goal.setAttribute('role', 'menuitem')
    goal.innerHTML = `
      <span class="wc-objective-menu-icon">${icon('i-target', 'ico')}</span>
      <span class="wc-mode-opt-txt"><b>Objetivo com esta pessoa</b><small>${objective ? esc(objective) : 'adicione uma direção opcional para a IA'}</small></span>
      <span class="wc-context-edit">${icon('i-edit', 'ico ico-sm')}</span>`
    goal.addEventListener('click', (e) => {
      e.stopPropagation()
      const chat = (WA.chat && WA.chat.jid === jid) ? WA.chat : (WA.chats || []).find((c) => c.jid === jid)
      closeModeMenu(false)
      openObjectiveEditor({
        personId: chat?.personId || `wa:${jid}`,
        name: chat?.name || chat?.phone || '',
        objective,
        anchor: pill,
        onSaved: (value) => applyObjectiveState(jid, value),
      })
    })
    const chatMenu = (WA.chat && WA.chat.jid === jid) ? WA.chat : (WA.chats || []).find((c) => c.jid === jid)
    const pidMenu = chatMenu?.personId || `wa:${jid}`
    menu.append(goal, etiquetasMenuOpt(pidMenu), entregaMenuOpt(pidMenu, { jid, canal: 'whatsapp' }), encontroMenuOpt(pidMenu), atendimentoMenuOpt(pidMenu), cobrancaMenuOpt(pidMenu))
    montarOpcoesVinculo(menu, pidMenu, async (valor) => {
      closeModeMenu(true)
      const r = await post('/api/self/vinculos', { personId: pidMenu, vinculo: valor || '', iaPode: 'cuidado' })
      if (r && r.ok) toast(valor ? `Vínculo definido: ${(CATALOGO_VINC.find((c) => c.valor === valor) || {}).label || valor}` : 'Vínculo removido')
      else toast('Não consegui salvar o vínculo', 'err')
    })
    root.append(scrim, menu)
    // nada aqui vaza pros cliques da thread/lista por trás
    root.addEventListener('click', (e) => e.stopPropagation())
    wrap.appendChild(root)
    pill.setAttribute('aria-expanded', 'true')

    // fecha ao clicar fora (o scrim do mobile também cai neste caminho)
    const onDoc = (e) => { if (!menu.contains(e.target) && e.target !== pill && !pill.contains(e.target)) closeModeMenu(false) }
    // teclado: setas navegam, Esc fecha e devolve o foco, Tab fecha
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeModeMenu(true); return }
      if (e.key === 'Tab') { e.preventDefault(); closeModeMenu(true); return }
      const items = $$('.wc-mode-opt', menu)
      const idx = items.indexOf(document.activeElement)
      if (e.key === 'ArrowDown') { e.preventDefault(); items[idx < 0 ? 0 : (idx + 1) % items.length].focus() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length].focus() }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus() }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus() }
    }
    document.addEventListener('pointerdown', onDoc, true)
    document.addEventListener('keydown', onKey, true)
    modeMenu = { root, pill, jid, onDoc, onKey }
    ajustaMenuNaTela(menu, pill)
    const sel = menu.querySelector('.wc-mode-opt.on') || menu.querySelector('.wc-mode-opt')
    if (sel) { sel.focus({ preventScroll: true }); revelaNoMenu(menu, sel) }
  }

  // ---------- ORIGEM TINDER (override manual do selo) ----------
  // O selo "Tinder" no cabeçalho vira um botão: dá pra desmarcar quando acendeu
  // errado. POST /api/wa/chat/tinder { jid, isTinder } → { ok, fromTinder }.
  function currentFromTinder(jid) {
    if (WA.chat && WA.chat.jid === jid) return !!WA.chat.fromTinder
    const listed = (WA.chats || []).find((c) => c.jid === jid)
    return !!(listed && listed.fromTinder)
  }

  // espelha fromTinder no modelo (WA.chats/WA.chat) e no DOM (badge da lista + selo do cabeçalho)
  function applyTinderState(jid, on) {
    const listed = (WA.chats || []).find((c) => c.jid === jid)
    if (listed) listed.fromTinder = on
    if (WA.chat && WA.chat.jid === jid) WA.chat.fromTinder = on
    if ($('#wcListScroll')) renderWaChats()   // repinta a lista (selo Tinder aparece/some)
    // repinta só o cabeçalho da thread aberta, preservando o popover de modo
    if (WA.openJid === jid) {
      const nm = $('#wcHeadNm')
      if (nm && WA.chat) {
        const title = WA.chat.name || WA.chat.phone || jidToPhone(jid) || 'contato'
        const tag = on
          ? `<button class="wc-tag wc-tag-btn" id="wcTinderTag" type="button" aria-haspopup="menu" aria-expanded="false" title="Ver o perfil dela no Tinder">${icon('i-heart', 'ico ico-sm')} Tinder</button>`
          : ''
        nm.innerHTML = `${esc(title)}${tag}`
        const head = nm.closest('.wc-thread-head')
        if (head) wireTinderTag(head, jid)
      }
    }
  }

  async function setChatTinder(jid, isTinder) {
    const prev = currentFromTinder(jid)
    if (prev === isTinder) return
    closeTinderMenu(false)
    applyTinderState(jid, isTinder)          // otimista
    const r = await post('/api/wa/chat/tinder', { jid, isTinder })
    if (!r || !r.ok) {
      applyTinderState(jid, prev)
      toast('Não deu pra ajustar a origem', 'err')
      return
    }
    const final = (r.fromTinder !== undefined) ? !!r.fromTinder : isTinder
    if (final !== isTinder) applyTinderState(jid, final)
    toast(final ? 'Marcado como Tinder' : 'Não é mais do Tinder')
  }

  // liga o selo Tinder do cabeçalho ao popover (chamado no threadHeader e ao repintar)
  function wireTinderTag(head, jid) {
    const tag = head.querySelector('#wcTinderTag')
    if (!tag) return
    tag.addEventListener('click', (e) => {
      e.stopPropagation()
      if (tinderMenu && tinderMenu.anchor === tag) closeTinderMenu(false)
      else abrirPerfilTinder(jid)
    })
    tag.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && !tinderMenu) { e.preventDefault(); e.stopPropagation(); abrirPerfilTinder(jid) }
    })
  }

  // ---------- popover do selo Tinder (mesmo padrão do modo; mobile = folha ancorada) ----------
  let tinderMenu = null   // { root, anchor, jid, onDoc, onKey }

  function closeTinderMenu(refocus) {
    if (!tinderMenu) return
    const st = tinderMenu; tinderMenu = null
    document.removeEventListener('pointerdown', st.onDoc, true)
    document.removeEventListener('keydown', st.onKey, true)
    st.root.remove()
    if (st.anchor && st.anchor.isConnected) {
      st.anchor.setAttribute('aria-expanded', 'false')
      if (refocus) st.anchor.focus()
    }
  }

  // Perfil do Tinder da pessoa desta conversa. É o que dá CERTEZA de que o vínculo é dela:
  // foto, nome, idade, cidade, bio, o pedaço da conversa do Tinder e a frase em que ela
  // passou o número. Regra do sistema em 25/07/2026.
  async function abrirPerfilTinder(jid) {
    const ov = overlay()
    const sheet = el('div', 'pj-sheet tall perfil-tinder')
    sheet.innerHTML = `<div class="pj-sheet-head"><h2>${icon('i-heart', 'ico ico-sm')} Perfil no Tinder</h2><button class="icon-btn" data-x>${icon('i-x')}</button></div>
      <div class="pj-empty-line" id="ptCorpo">carregando…</div>`
    ov.appendChild(sheet)
    sheet.querySelector('[data-x]').addEventListener('click', () => ov.remove())
    const d = await api(`/api/wa/chat/tinder-perfil?jid=${encodeURIComponent(jid)}`)
    const corpo = $('#ptCorpo', sheet)
    if (!d) { corpo.textContent = 'Não achei o perfil do Tinder dessa conversa.'; return }

    const fotos = (d.fotos || []).slice(0, 6)
    const conf = d.conferencia || {}
    const selo = conf.estado === 'confere'
      ? `<span class="vinc-tag ok">${icon('i-check', 'ico ico-sm')} o número bate com o que ela passou</span>`
      : conf.estado === 'divergente'
        ? '<span class="vinc-tag erro">o número NÃO bate com o que ela passou</span>'
        : `<span class="vinc-tag">${esc(conf.estado || 'sem conferência')}</span>`
    corpo.className = 'pt-corpo'
    corpo.innerHTML = `
      ${fotos.length ? `<div class="pt-fotos">${fotos.map((f) => `<img src="${esc(f)}" alt="" loading="lazy">`).join('')}</div>` : '<div class="pj-empty-line">Sem foto guardada.</div>'}
      <div class="pt-id">
        <b>${esc(d.nome || 'sem nome')}</b>${d.idade ? `<span>${d.idade}</span>` : ''}
        ${d.cidade ? `<span>${esc(d.cidade)}</span>` : ''}
        ${d.ativa ? '' : '<span class="vinc-tag">match desfeito</span>'}
      </div>
      ${d.bio ? `<p class="pt-bio">${esc(d.bio)}</p>` : ''}
      <div class="pt-prova">${selo}</div>
      ${d.provaDoVinculo ? `<blockquote class="vinc-frase">“${esc(d.provaDoVinculo.frase)}”</blockquote>
        <p class="review-motivo">Foi assim que ela passou o contato, na conversa do Tinder.</p>` : ''}
      <div class="section-title">${icon('i-chat', 'ico ico-sm')} Conversa no Tinder <span class="cnt">${d.totalMensagens}</span></div>
      <div class="pt-msgs">${(d.ultimas || []).map((m) => `<div class="pt-msg ${m.dir === 'eu' ? 'eu' : 'ela'}"><b>${m.dir === 'eu' ? 'você' : esc(d.nome || 'ela')}:</b> ${esc(m.texto || '')}</div>`).join('') || '<div class="pj-empty-line">sem mensagens</div>'}</div>
      <div class="vinc-acoes"><button class="btn ghost small danger" data-nao>Não é ela — desfazer o vínculo</button></div>`
    corpo.querySelector('[data-nao]').addEventListener('click', (e) => confirmDestructive(e.currentTarget, 'Confirmar', async () => {
      await post('/api/veredito', { canal: 'whatsapp', alvo: jid, personId: d.personId, verdict: 'errado', reason: 'pessoa_errada' })
      ov.remove(); toast('Vínculo desfeito'); loadWa()
    }))
  }

  function openTinderMenu(anchor, jid) {
    closeTinderMenu(false); closeModeMenu(false)
    // o selo só existe quando fromTinder=true, então a ação é sempre "desmarcar".
    // (mantenho o par simétrico caso um dia o selo seja mostrado desmarcado.)
    const isTinder = currentFromTinder(jid)
    const root = el('div', 'wc-tag-pop')
    const scrim = el('div', 'wc-mode-scrim')       // reaproveita o scrim do mobile
    const menu = el('div', 'wc-mode-menu wc-tag-menu')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', 'Origem da conversa')
    const hint = el('div', 'wc-tag-hint', 'Esta conversa está marcada como vinda do Tinder.')
    menu.appendChild(hint)
    const opt = el('button', 'wc-mode-opt wc-tag-opt' + (isTinder ? ' danger' : ''))
    opt.type = 'button'
    opt.setAttribute('role', 'menuitem')
    const label = isTinder ? 'Não é do Tinder' : 'Voltar a marcar como Tinder'
    const desc = isTinder ? 'some o selo, mesmo com vínculo' : 'volta ao critério automático'
    opt.innerHTML = `
      <span class="wc-tag-opt-ico">${icon(isTinder ? 'i-x' : 'i-heart', 'ico ico-sm')}</span>
      <span class="wc-mode-opt-txt"><b>${esc(label)}</b><small>${esc(desc)}</small></span>`
    opt.addEventListener('click', (e) => { e.stopPropagation(); setChatTinder(jid, !isTinder) })
    menu.appendChild(opt)
    root.append(scrim, menu)
    root.addEventListener('click', (e) => e.stopPropagation())
    // ancora no cabeçalho (posição relativa) pra alinhar embaixo do selo
    const host = anchor.closest('.wc-thread-head') || anchor.parentElement
    host.appendChild(root)
    anchor.setAttribute('aria-expanded', 'true')

    const onDoc = (e) => { if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeTinderMenu(false) }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeTinderMenu(true); return }
      if (e.key === 'Tab') { e.preventDefault(); closeTinderMenu(true); return }
    }
    document.addEventListener('pointerdown', onDoc, true)
    document.addEventListener('keydown', onKey, true)
    tinderMenu = { root, anchor, jid, onDoc, onKey }
    ajustaMenuNaTela(menu, anchor)
    opt.focus({ preventScroll: true })
  }

  async function generateWaDraft(jid, btnGen, draft, btnSend) {
    if (btnGen.disabled) return
    const original = btnGen.innerHTML
    btnGen.disabled = true
    btnGen.innerHTML = `<span class="spin"></span><span class="lbl">Gerando…</span>`
    const r = await gerarRascunho('/api/wa/chat/generate', { jid })
    btnGen.disabled = false
    btnGen.innerHTML = original
    if (!r || r.draft == null) { toast('Não consegui gerar agora', 'err'); return }
    draft.value = r.draft
    btnSend.disabled = !draft.value.trim()
    draft.style.height = 'auto'; draft.style.height = Math.min(draft.scrollHeight, 140) + 'px'
    draft.focus()
  }

  async function sendWaMsg(jid, draft, btnSend) {
    const text = draft.value.trim()
    if (!text) return
    WA.sending = true
    btnSend.disabled = true
    draft.value = ''
    draft.style.height = 'auto'
    // bolha otimista com estado "enviando"
    const tempId = 'tmp-' + Date.now()
    const temp = { id: tempId, dir: 'out', text, ts: Date.now(), pending: true }
    if (WA.chat && WA.chat.jid === jid) (WA.chat.messages = WA.chat.messages || []).push(temp)
    const msgsHost = $('#wcMsgs')
    if (msgsHost) {
      const emptyBox = msgsHost.querySelector('.wc-thread-empty')
      if (emptyBox) emptyBox.remove()
      msgsHost.appendChild(bubbleFor(temp))
      scrollThreadToEnd()
    }
    const r = await post('/api/wa/chat/send', { jid, text })
    WA.sending = false
    const rowEl = msgsHost ? msgsHost.querySelector(`[data-mid="${CSS.escape(tempId)}"]`) : null
    if (!r || !r.ok || !r.message) {
      // marca erro na bolha, mantém o texto pra reenviar
      if (rowEl) rowEl.replaceWith(bubbleFor({ id: tempId, dir: 'out', text, ts: temp.ts, failed: true }))
      if (WA.chat && WA.chat.messages) { const mm = WA.chat.messages.find((x) => x.id === tempId); if (mm) { mm.pending = false; mm.failed = true } }
      draft.value = text
      btnSend.disabled = false
      toast('Falha ao enviar', 'err')
      return
    }
    // confirma: troca a bolha temporária pela real
    const real = r.message
    if (WA.chat && WA.chat.messages) { const i = WA.chat.messages.findIndex((x) => x.id === tempId); if (i >= 0) WA.chat.messages[i] = real }
    if (rowEl) rowEl.replaceWith(bubbleFor(real))
    // atualiza preview na lista
    const listed = (WA.chats || []).find((c) => c.jid === jid)
    if (listed) { listed.lastText = real.text; listed.lastTs = real.ts; renderWaChats() }
    scrollThreadToEnd()
    loadState()
  }

  // ---------- picker de ÁUDIO SALVO (atalho "/" no composer) ----------
  // Cache dos áudios salvos ATIVOS (pro picker). Recarregado sob demanda; o gravador da
  // Config invalida (WA.audios = null) ao salvar/editar pra o picker refletir na hora.
  let audioPicker = null // { root, list, comp, draft, btnSend, jid, items, active, onKey, onDoc }
  async function loadSavedAudios(force) {
    if (WA.audios && !force) return WA.audios
    const all = await api('/api/wa/audios')
    WA.audios = Array.isArray(all) ? all.filter((a) => a.active) : []
    return WA.audios
  }
  function fmtAudioDur(sec) { const s = Math.max(0, Math.floor(Number(sec) || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

  function closeAudioPicker() {
    if (!audioPicker) return
    const st = audioPicker; audioPicker = null
    document.removeEventListener('keydown', st.onKey, true)
    document.removeEventListener('pointerdown', st.onDoc, true)
    st.root.remove()
  }

  // Abre/atualiza o picker acima do composer. filter = texto após a "/". O foco NUNCA sai
  // do textarea: navegação por setas move a seleção visual; Enter envia o áudio marcado.
  async function openAudioPicker(jid, comp, draft, btnSend, filter) {
    const audios = await loadSavedAudios()
    // o textarea pode ter mudado enquanto carregava; só segue se ainda está em modo "/"
    if (!draft.value.startsWith('/') || draft.value.includes(' ')) { closeAudioPicker(); return }
    const q = norm(filter || '')
    const items = (audios || []).filter((a) => {
      if (!q) return true
      return norm(a.shortcut).includes(q) || norm(a.title || '').includes(q) || norm(a.descricao || '').includes(q)
    }).slice(0, 12)

    if (!audioPicker) {
      const root = el('div', 'wc-audio-pop')
      const scrim = el('div', 'wc-audio-scrim') // só no mobile (folha)
      const menu = el('div', 'wc-audio-menu')
      menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', 'Áudios salvos')
      const list = el('div', 'wc-audio-list')
      menu.append(el('div', 'wc-audio-head', `${icon('i-play', 'ico ico-sm')}<span>Áudios salvos</span><small>Enter envia</small>`), list)
      root.append(scrim, menu)
      root.addEventListener('click', (e) => e.stopPropagation())
      comp.appendChild(root)
      const onDoc = (e) => { if (!root.contains(e.target) && e.target !== draft) closeAudioPicker() }
      // O picker intercepta as teclas de navegação/seleção ANTES do textarea (captura).
      const onKey = (e) => {
        if (!audioPicker) return
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); draft.value = ''; draft.style.height = 'auto'; btnSend.disabled = true; closeAudioPicker(); return }
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); moveAudioSel(1); return }
        if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moveAudioSel(-1); return }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); pickCurrentAudio(); return }
      }
      document.addEventListener('pointerdown', onDoc, true)
      document.addEventListener('keydown', onKey, true)
      audioPicker = { root, list, comp, draft, btnSend, jid, items: [], active: 0, onKey, onDoc }
    }
    audioPicker.items = items
    audioPicker.jid = jid
    audioPicker.active = 0
    paintAudioPicker()
  }

  function paintAudioPicker() {
    if (!audioPicker) return
    const { list, items, active } = audioPicker
    list.replaceChildren()
    if (!items.length) {
      list.appendChild(el('div', 'wc-audio-empty', `<b>nenhum áudio salvo ainda</b><small>grave em Config &rsaquo; Áudios salvos</small>`))
      return
    }
    items.forEach((a, i) => {
      const opt = el('button', 'wc-audio-opt' + (i === active ? ' on' : ''))
      opt.type = 'button'
      opt.setAttribute('role', 'option'); opt.setAttribute('aria-selected', String(i === active))
      const pend = a.transcriptStatus === 'pending'
      opt.innerHTML = `
        <span class="wc-audio-opt-play">${icon('i-play', 'ico ico-sm')}</span>
        <span class="wc-audio-opt-body">
          <span class="wc-audio-opt-top"><b>${esc(a.title || a.shortcut)}</b><span class="wc-audio-opt-dur">${fmtAudioDur(a.dur)}</span></span>
          <span class="wc-audio-opt-sub">/${esc(a.shortcut)}${a.descricao ? ` · ${esc(a.descricao)}` : (pend ? ' · transcrevendo…' : '')}</span>
        </span>`
      // onmousedown + preventDefault: seleciona sem tirar o foco do textarea
      opt.addEventListener('mousedown', (e) => { e.preventDefault(); audioPicker.active = i; pickCurrentAudio() })
      opt.addEventListener('mouseenter', () => { audioPicker.active = i; paintAudioPicker() })
      list.appendChild(opt)
    })
  }

  function moveAudioSel(delta) {
    if (!audioPicker || !audioPicker.items.length) return
    const n = audioPicker.items.length
    audioPicker.active = (audioPicker.active + delta + n) % n
    paintAudioPicker()
    const on = audioPicker.list.querySelector('.wc-audio-opt.on')
    if (on) on.scrollIntoView({ block: 'nearest' })
  }

  // Envia o áudio destacado DIRETO (sem confirmação): rota send-audio + toast + limpa o draft.
  async function pickCurrentAudio() {
    if (!audioPicker) return
    const a = audioPicker.items[audioPicker.active]
    const { jid, draft, btnSend } = audioPicker
    if (!a) return
    closeAudioPicker()
    draft.value = ''; draft.style.height = 'auto'; btnSend.disabled = true
    // bolha otimista de áudio "enviando"
    const tempId = 'tmp-au-' + Date.now()
    const temp = { id: tempId, dir: 'out', type: 'audio', ts: Date.now(), pending: true, audio: { file: a.file, dur: a.dur, transcript: a.transcript, status: 'done', saved: true } }
    if (WA.chat && WA.chat.jid === jid) (WA.chat.messages = WA.chat.messages || []).push(temp)
    const msgsHost = $('#wcMsgs')
    if (msgsHost) { const eb = msgsHost.querySelector('.wc-thread-empty'); if (eb) eb.remove(); msgsHost.appendChild(bubbleFor(temp)); scrollThreadToEnd() }
    const r = await post('/api/wa/chat/send-audio', { jid, audioId: a.id })
    const rowEl = msgsHost ? msgsHost.querySelector(`[data-mid="${CSS.escape(tempId)}"]`) : null
    if (!r || !r.ok || !r.message) {
      if (rowEl) rowEl.replaceWith(bubbleFor({ id: tempId, dir: 'out', type: 'audio', ts: temp.ts, failed: true, audio: temp.audio }))
      if (WA.chat && WA.chat.messages) { const mm = WA.chat.messages.find((x) => x.id === tempId); if (mm) { mm.pending = false; mm.failed = true } }
      toast('Falha ao enviar o áudio', 'err')
      return
    }
    const real = r.message
    if (WA.chat && WA.chat.messages) { const i = WA.chat.messages.findIndex((x) => x.id === tempId); if (i >= 0) WA.chat.messages[i] = real }
    if (rowEl) rowEl.replaceWith(bubbleFor(real))
    const listed = (WA.chats || []).find((c) => c.jid === jid)
    if (listed) { listed.lastText = '[áudio]'; listed.lastTs = real.ts; renderWaChats() }
    toast(`Áudio enviado: ${a.title || a.shortcut}`)
    scrollThreadToEnd()
    loadState()
  }

  // atualiza só as mensagens da thread aberta sem recriar cabeçalho/compositor
  function refreshThreadMessages(chat) {
    const t = $('#wcThread'); if (!t) return
    atualizarMetricasNoCabecalho('#wcThread', chat.metricas)
    // mantém a pill de modo em dia com o servidor (sem mexer no popover aberto)
    if (!modeMenu) { const pill = $('#wcModePill'); if (pill) paintModePill(pill, chat.mode || null, chat.objective || '') }
    // reconcilia o selo Tinder se o servidor mudou a origem (compara com o DOM,
    // pois WA.chat já foi atualizado antes desta chamada; não mexe no popover aberto)
    if (!tinderMenu && WA.openJid === chat.jid) {
      const shown = !!$('#wcTinderTag')
      if (shown !== !!chat.fromTinder) applyTinderState(chat.jid, !!chat.fromTinder)
    }
    const old = $('#wcMsgs'); if (!old) return
    trocarBolhas(old, threadMessages(chat), scrollThreadToEnd)
  }

  // ---------- polling leve (só quando a aba WhatsApp está visível) ----------
  function startWaListPoll() {
    stopWaListPoll()
    WA.listTimer = setInterval(() => { if (S.tab === 'whatsapp' && $('#wcListScroll')) loadWaChats() }, 10000)
  }
  function stopWaListPoll() { if (WA.listTimer) { clearInterval(WA.listTimer); WA.listTimer = null } }
  function startWaThreadPoll() {
    stopWaThreadPoll()
    WA.threadTimer = setInterval(async () => {
      if (S.tab !== 'whatsapp' || !WA.openJid) { stopWaThreadPoll(); return }
      if (WA.sending) return // não repinta com envio em voo (sumiria a bolha otimista)
      const jid = WA.openJid
      const chat = await api(`/api/wa/chat?jid=${encodeURIComponent(jid)}`)
      if (!chat || WA.openJid !== jid || WA.sending) return
      WA.chat = chat
      refreshThreadMessages(chat)
    }, 5000)
  }
  function stopWaThreadPoll() { if (WA.threadTimer) { clearInterval(WA.threadTimer); WA.threadTimer = null } }
  function stopWaPolling() { stopWaListPoll(); stopWaThreadPoll(); stopWaConnPoll(); closeModeMenu(false); closeTinderMenu(false); closeAudioPicker(); stopAudio() }

  // Quem passou contato NO TINDER: as que já viraram conversa e as que não fecharam, com o
  // motivo em português e o que dá pra fazer. É a lista que o dono pediu (24/07/2026).
  async function carregarContatosDoTinder(host) {
    if (!host) host = $('#wcAprovacoes')
    if (!host) return
    const d = await api('/api/vinculos/tinder')
    const carregando = $('.wc-aprov-loading', host)
    if (carregando) carregando.remove()
    if (!d) { host.appendChild(el('div', 'pj-empty-line', 'Não consegui carregar.')); return }

    // O contador da sub-aba mostra o que ainda depende de você: as decisões pendentes mais
    // os contatos do Tinder que não viraram conversa.
    const aba = $('[data-wasub="aprovacoes"]')
    if (aba) {
      const total = (WA.reviewCount || 0) + d.pendentes.length
      let badge = $('.vinc-cnt', aba)
      if (!badge && total) { badge = el('span', 'vinc-cnt'); aba.append(' ', badge) }
      if (badge) { badge.textContent = String(total); badge.hidden = !total }
    }
    if (d.pendentes.length) {
      host.appendChild(el('div', 'section-title', `${icon('i-heart', 'ico ico-sm')} Passaram contato e ainda não virou conversa <span class="cnt">${d.pendentes.length}</span>`))
      const lista = el('div', 'review-list')
      d.pendentes.forEach((p) => {
        const c = el('div', 'review-card')
        c.innerHTML = `
          <div class="q"><span class="guess">${esc(p.nome || 'ela')}</span> ${p.valor ? `passou <span class="num">${esc(p.valor)}</span>` : 'compartilhou um contato'} no Tinder.</div>
          ${p.frase ? `<blockquote class="vinc-frase">“${esc(String(p.frase).replace(/\s+/g, ' ').slice(0, 200))}”</blockquote>` : ''}
          <div class="review-motivo">${esc(p.situacao)}${p.oQueFazer ? ` — <b>${esc(p.oQueFazer)}</b>` : ''}</div>
          ${p.alvoInstagram ? '<div class="acts"><button class="btn confirm" data-ig>Chamar no Instagram</button></div>' : ''}`
        const bIg = c.querySelector('[data-ig]')
        if (bIg) bIg.addEventListener('click', async (e) => {
          const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Escrevendo…'
          const r = await post('/api/vinculos/chamar', { canal: 'instagram', personId: p.personId, nome: p.nome, alvo: p.alvoInstagram })
          if (r && r.ok) { toast('Mandei: ' + String(r.texto).slice(0, 60)); loadWa() }
          else { toast((r && r.motivo) || 'Não consegui chamar', 'err'); btn.disabled = false; btn.textContent = 'Chamar no Instagram' }
        })
        lista.appendChild(c)
      })
      host.appendChild(lista)
    }

    if (d.fechados.length) {
      host.appendChild(el('div', 'section-title', `${icon('i-check', 'ico ico-sm')} Já viraram conversa no WhatsApp <span class="cnt">${d.fechados.length}</span>`))
      const ok = el('div', 'wc-aprov-fechados')
      d.fechados.forEach((f) => {
        const linha = el('div', 'wc-aprov-fechado')
        linha.innerHTML = `<b>${esc(f.nome || 'pessoa')}</b><span>${f.mensagens} mensagem${f.mensagens === 1 ? '' : 's'}</span>`
        ok.appendChild(linha)
      })
      host.appendChild(ok)
    }

    if (!d.pendentes.length && !d.fechados.length) {
      host.appendChild(el('div', 'pj-empty-line', 'Nenhuma pessoa do Tinder passou contato ainda.'))
    }
  }

  function reviewCard(rv) {
    const card = el('div', 'review-card')
    const quem = rv.candidateName || 'esta conversa'
    // O que o dono precisa pra decidir: o número COMO FOI ESCRITO (o identificador interno
    // do WhatsApp não diz nada), a frase em que ele apareceu, e o que confirmar significa.
    // A barra de "confiança" saiu: era sempre 0% e não ajudava ninguém. Ver PLANO §2.7.
    const partes = String(rv.reason || '').split('|').map((x) => x.trim())
    const motivo = partes[0] || ''
    const numero = (partes.find((x) => x.startsWith('número:')) || '').replace('número:', '').trim()
      || rv.pushName || jidToPhone(rv.waJid) || 'um número'
    const outroLado = rv.pushName && rv.pushName !== numero ? rv.pushName : null
    card.innerHTML = `
      <div class="q"><span class="guess">${esc(quem)}</span> passou o número <span class="num">${esc(numero)}</span> no Tinder.</div>
      ${rv.firstText ? `<blockquote class="vinc-frase">“${esc(String(rv.firstText).replace(/\s+/g, ' ').slice(0, 220))}”</blockquote>` : ''}
      ${motivo ? `<div class="review-motivo">${esc(motivo)}</div>` : ''}
      <div class="review-motivo">Confirmar liga a conversa do Tinder com o WhatsApp${outroLado ? ` de <b>${esc(outroLado)}</b>` : ' desse número'} — vira uma conversa só, com a mesma memória.</div>
      <div class="acts">
        <button class="btn confirm">${icon('i-check', 'ico ico-sm')} É a mesma pessoa</button>
        <button class="btn reject">${icon('i-x', 'ico ico-sm')} Não é</button>
      </div>`
    const done = (action) => async (e) => {
      $$('.acts button', card).forEach((b) => b.disabled = true)
      const r = await post(`/api/wa/review/${encodeURIComponent(rv.id)}`, { action })
      if (r && r.ok) {
        card.style.transition = 'opacity .25s, transform .25s'
        card.style.opacity = '0'; card.style.transform = 'scale(.96)'
        setTimeout(() => { card.remove(); loadWa() }, 250)
        toast(action === 'confirm' ? 'Vínculo confirmado' : 'Descartado')
      } else {
        $$('.acts button', card).forEach((b) => b.disabled = false)
        toast('Não deu pra registrar', 'err')
      }
    }
    $('.confirm', card).addEventListener('click', done('confirm'))
    $('.reject', card).addEventListener('click', done('reject'))
    return card
  }

  function jidToPhone(jid) {
    if (!jid) return ''
    const num = String(jid).split('@')[0].split(':')[0].replace(/\D/g, '')
    if (num.length >= 12 && num.startsWith('55')) {
      const d = num.slice(2)
      return `+55 ${d.slice(0, 2)} ${d.slice(2, 7)}-${d.slice(7)}`
    }
    return num ? '+' + num : ''
  }

  // ==================================================================
  //  INSTAGRAM — cliente de conversas (DMs)
  //  Mesmo desenho do WhatsApp (master-detail: lista + thread), consumindo
  //  /api/ig/*. A chave é threadId (em vez de jid). Reaproveita os helpers
  //  genéricos (avatarHtml, bubbleFor, WA_MODES, paintModePill, etc.).
  //  Só duplica o mínimo com prefixo `ig` — não toca no cliente do WhatsApp.
  // ==================================================================
  const IG = {
    chats: [],             // lista de /api/ig/chats
    query: '',              // busca local na lista
    filtroIa: '',           // '' | 'on' | 'off' — filtro pelo interruptor da IA
    openTid: null,         // conversa aberta na thread
    chat: null,            // /api/ig/chat da conversa aberta
    listTimer: null,       // polling da lista (~10s)
    threadTimer: null,     // polling da thread aberta (~5s)
    sending: false,        // envio em voo (segura o poll pra não sumir a bolha otimista)
    listReq: 0,            // respostas antigas nunca podem sobrescrever uma lista mais nova
    threadReq: 0,          // idem para a conversa aberta (poll, WS e clique podem concorrer)
  }

  // status do banner de topo (não vem no /api/state)
  async function loadIgStatusPill() {
    const ig = await api('/api/ig')
    const on = ig && ig.status === 'CONNECTED'
    // 'CAIDO' vem do registro de saúde (o servidor deixou de responder pela credencial salva):
    // sessão que caiu é VERMELHO, não cinza de "sei lá".
    const dot = $('#dotIg'); if (dot) dot.className = dotClass(on ? 'on' : ig?.status === 'CAIDO' ? 'off' : ig?.status === 'PENDENTE' ? 'warn' : ig ? 'idle' : 'off')
    const lbl = $('#lblIg'); if (lbl) lbl.textContent = on ? (ig.me || 'Instagram') : ig?.status === 'CAIDO' ? 'Instagram caiu' : 'Instagram'
    const pill = $('#stIg'); if (pill) { pill.classList.toggle('up', !!on); pill.title = on ? (ig.me || '') : ig?.status === 'CAIDO' ? `${ig.motivo || 'sessão recusada'}${ig.comoResolver ? ' — ' + ig.comoResolver : ''}` : '' }
    const mobileDot = $('#mDotIg'); if (mobileDot) mobileDot.className = on ? 'on' : 'off'
  }

  async function loadIg() {
    const host = $('#igHost')
    if (!host.dataset.loaded) host.replaceChildren(el('div', 'empty', `${icon('i-ig', 'ico')}<h3>carregando…</h3>`))
    const ig = await api('/api/ig')
    host.dataset.loaded = '1'
    if (!ig) { host.replaceChildren(emptyState('i-ig', 'Instagram indisponível', 'O painel não conseguiu falar com o módulo de Instagram do vendas-multicanal.')); return }
    renderIg(ig)
  }

  function renderIg(ig) {
    const host = $('#igHost')
    // troca de tela = reinicia o cliente (evita polling/thread/popover órfãos)
    stopIgThreadPoll(); closeIgModeMenu(false); IG.openTid = null; IG.chat = null
    IG.listReq++; IG.threadReq++; ASSINATURAS.delete('ig')
    host.replaceChildren(igClient(ig))
    abrirAlvo(igOpenThread)
  }

  // status do Instagram: CONNECTED → conectado + @me; senão aviso (sem QR).
  function igStatusHead(ig) {
    const connected = ig.status === 'CONNECTED'
    const head = el('div', 'wa-client-head ig-head')
    const info = connected
      ? `<div class="wc-txt"><b>Instagram conectado</b><span>${esc(ig.me || '')}</span></div>`
      : `<div class="wc-txt"><b>Instagram não conectado</b><span>a sessão é importada por fora — sincronize quando estiver logado</span></div>`
    head.innerHTML = `
      <div class="wc-id">
        <div class="wc-dot${connected ? '' : ' off'}"></div>
        ${info}
      </div>
      <div class="ig-head-btns">
        <button class="btn ghost ig-sync" id="igDeep" title="Puxar o máximo de histórico de cada conversa (demora alguns minutos)">${icon('i-sync', 'ico ico-sm')}<span class="lbl">Puxar histórico</span></button>
        <button class="btn ghost ig-sync" id="igSync" title="Sincronizar conversas agora">${icon('i-sync', 'ico ico-sm')}<span class="lbl">Sincronizar agora</span></button>
      </div>`
    head.querySelector('#igSync').addEventListener('click', igSyncNow)
    head.querySelector('#igDeep').addEventListener('click', igDeepScan)
    return head
  }

  // Varredura profunda: puxa o máximo de histórico de cada conversa (roda no servidor,
  // minutos). O progresso chega por WS ('ig-deep' / 'ig-deep-done').
  async function igDeepScan(e) {
    const b = e.currentTarget
    b.disabled = true
    b.querySelector('.lbl').textContent = 'Puxando…'
    const r = await post('/api/ig/deep-scan')
    if (!r || !r.ok) { b.disabled = false; b.querySelector('.lbl').textContent = 'Puxar histórico'; toast('Não deu pra iniciar a varredura', 'err'); return }
    toast('Puxando histórico do Instagram… isso leva alguns minutos', 'ok')
  }

  async function igSyncNow(e) {
    const b = e.currentTarget
    const original = b.innerHTML
    b.disabled = true
    b.innerHTML = `<span class="spin"></span><span class="lbl">Sincronizando…</span>`
    const r = await post('/api/ig/sync')
    // a lista se atualiza via WebSocket 'state'; solta um refresh imediato de reforço
    setTimeout(() => { if (S.tab === 'instagram' && $('#igListScroll')) loadIgChats() }, 800)
    b.disabled = false
    b.innerHTML = original
    toast(r && r.ok ? 'Sincronização iniciada' : 'Não deu pra sincronizar', r && r.ok ? 'ok' : 'err')
    loadIgStatusPill()
  }

  // corpo master-detail (idêntico ao WhatsApp, com ids ig*)
  function igClient(ig) {
    const wrap = el('div', 'wa-client')
    wrap.id = 'igClient'
    wrap.appendChild(igStatusHead(ig))

    const body = el('div', 'wc-body')
    body.innerHTML = `
      <aside class="wc-list" id="igList" aria-label="Conversas do Instagram">
        <div class="wc-list-head">${icon('i-ig', 'ico ico-sm')} Direct <span class="cnt" id="igCnt">·</span></div>
        ${filtroIaHtml(IG.filtroIa)}
        <label class="wc-search mobile-search mobile-only" for="igSearch">
          ${icon('i-search')}<input id="igSearch" type="search" inputmode="search" autocomplete="off" placeholder="Buscar no Instagram">
        </label>
        <div class="wc-list-scroll" id="igListScroll">
          <div class="wc-loading">${icon('i-ig', 'ico')}<span>carregando conversas…</span></div>
        </div>
      </aside>
      <section class="wc-thread" id="igThread" aria-label="Conversa">
        <div class="wc-thread-empty" id="igThreadEmpty">
          ${icon('i-ig', 'ico ico-lg')}
          <h3>Escolha uma conversa</h3>
          <p>Toque numa pessoa à esquerda pra abrir o histórico e responder.</p>
        </div>
      </section>`
    wrap.appendChild(body)
    body.querySelector('#igSearch')?.addEventListener('input', (e) => { IG.query = e.currentTarget.value.trim(); renderIgChats() })
    ligarFiltroIa(body, (v) => { IG.filtroIa = v; renderIgChats() })

    requestAnimationFrame(() => { loadIgChats(); startIgListPoll() })
    return wrap
  }

  function igChatTitle(c) { return c.name || (c.username ? '@' + String(c.username).replace(/^@/, '') : '') || 'contato' }
  function igHandle(username) {
    if (!username) return ''
    return '@' + String(username).replace(/^@/, '')
  }

  // ---------- lista de conversas (GET /api/ig/chats) ----------
  async function loadIgChats() {
    if (!$('#igListScroll')) return
    const reqId = ++IG.listReq
    const chats = await api('/api/ig/chats')
    if (reqId !== IG.listReq || !$('#igListScroll') || !Array.isArray(chats)) return
    IG.chats = chats
    renderIgChats()
    // A lista pode saber da prévia alguns segundos antes de a API materializar a mensagem.
    // Repinta a thread aberta para exibir essa cauda como "sincronizando", sem inventar uma
    // mensagem persistida nem esperar o próximo poll de cinco segundos.
    if (IG.chat && IG.openTid === IG.chat.threadId) {
      IG.chat = igChatWithListIdentity(IG.chat)
      igRefreshThreadMessages(IG.chat)
    }
  }

  function renderIgChats() {
    const host = $('#igListScroll')
    const cnt = $('#igCnt')
    if (!host) return
    const chats = (IG.chats || []).filter((c) => passaFiltroIa(c.aiOn, IG.filtroIa))
    const shown = IG.query
      ? chats.filter((c) => norm(`${igChatTitle(c)} ${c.username || ''} ${c.lastText || ''}`).includes(norm(IG.query)))
      : chats
    if (cnt) cnt.textContent = String(shown.length)
    if (!(IG.chats || []).length) {
      host.replaceChildren(emptyState('i-ig', 'Nenhuma conversa ainda',
        'As conversas do Direct aparecem aqui após sincronizar. Se acabou de importar a sessão, toque em "Sincronizar agora".'))
      return
    }
    if (!chats.length) {
      host.replaceChildren(emptyState('i-bot', IG.filtroIa === 'on' ? 'A IA não está ligada em nenhuma' : 'A IA está ligada em todas',
        IG.filtroIa === 'on' ? 'Nenhuma conversa do Instagram tem a IA respondendo agora.' : 'Todas as conversas daqui estão com a IA ligada.'))
      return
    }
    if (!shown.length) {
      host.replaceChildren(emptyState('i-search', 'Nada encontrado', `Nenhuma conversa corresponde a “${IG.query}”.`))
      return
    }
    const sorted = shown.slice().sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
    const list = el('div', 'wc-items')
    sorted.forEach((c) => list.appendChild(igChatListItem(c)))
    // não repinta o igual, e o scroll é de quem está lendo (avisos de fundo chegam o tempo
    // todo; sem isso a lista pula pro topo sozinha no meio da leitura)
    if (!mudou('ig', sorted.map((c) => [
      c.threadId, c.name, c.username, c.avatar, c.lastTs, c.lastText,
      c.mode, c.objective, c.aiOn, c.unread, ...metricasNomeKey(c.metricas),
    ])) && !listaVazia(host)) return
    const rolagem = host.scrollTop
    host.replaceChildren(list)
    if (rolagem) host.scrollTop = rolagem
  }

  function igChatListItem(c) {
    const item = el('div', 'wc-item' + (IG.openTid === c.threadId ? ' active' : ''))
    item.setAttribute('role', 'button')
    item.setAttribute('tabindex', '0')
    item.dataset.tid = c.threadId
    const title = igChatTitle(c)
    const handle = igHandle(c.username)
    const preview = c.lastText ? esc(c.lastText) : '<i class="mute">sem mensagens</i>'
    const when = c.lastTs ? timeAgo(c.lastTs) : ''
    const modeTag = modeChipHtml(c.mode)
    const unread = c.unread ? `<span class="wc-unread ig">${c.unread > 99 ? '99+' : c.unread}</span>` : ''

    item.innerHTML = `
      ${avatarHtml(title, c.avatar)}
      <div class="wc-item-main">
        <div class="wc-item-top">
          <span class="wc-nm">${esc(title)}</span>
          ${metricasNomeHtml(c.metricas)}
          ${handle ? `<span class="wc-handle">${esc(handle)}</span>` : ''}
          ${modeTag}
          ${when ? `<span class="wc-when">${esc(when)}</span>` : ''}
        </div>
        <div class="wc-item-bot">
          <span class="wc-prev">${preview}</span>
          <span class="wc-flags">${unread}</span>
        </div>
      </div>
      <div class="wc-item-ai-wrap">
        <span class="wc-item-ai-lbl">${icon('i-bot', 'ico ico-sm')}<span class="wc-item-ai-text">IA</span></span>
        <button class="toggle sm wc-item-ai" role="switch" aria-checked="${c.aiOn ? 'true' : 'false'}" aria-label="IA responde nesta conversa" title="IA responde nesta conversa" data-ai-tid="${esc(c.threadId)}"></button>
      </div>`

    const tg = item.querySelector('.wc-item-ai')
    tg.addEventListener('click', (e) => { e.stopPropagation(); igToggleAiForChat(c.threadId, tg.getAttribute('aria-checked') !== 'true', tg) })
    tg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); igToggleAiForChat(c.threadId, tg.getAttribute('aria-checked') !== 'true', tg) }
    })
    item.addEventListener('click', () => igOpenThread(c.threadId))
    item.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === item) { e.preventDefault(); igOpenThread(c.threadId) }
    })
    return item
  }

  // ---------- thread (GET /api/ig/chat) ----------
  async function igOpenThread(tid) {
    closeIgModeMenu(false)
    IG.openTid = tid
    const reqId = ++IG.threadReq
    $$('#igListScroll .wc-item').forEach((it) => it.classList.toggle('active', it.dataset.tid === tid))
    const wrap = $('#igClient'); if (wrap) wrap.classList.add('thread-open')

    const cached = (IG.chats || []).find((c) => c.threadId === tid)
    igRenderThreadShell(cached || { threadId: tid, name: 'Instagram' }, true)

    const chat = await api(`/api/ig/chat?threadId=${encodeURIComponent(tid)}`)
    if (reqId !== IG.threadReq || IG.openTid !== tid) return
    if (!chat) {
      const t = $('#igThread')
      if (t) t.replaceChildren(igThreadHeader(cached || { threadId: tid }), emptyState('i-x', 'Não deu pra abrir', 'O vendas-multicanal não devolveu esta conversa. Tente de novo em instantes.'))
      return
    }
    IG.chat = igChatWithListIdentity(chat)
    igRenderThread(IG.chat)
    startIgThreadPoll()
  }

  function igBackToList() {
    closeIgModeMenu(false)
    IG.threadReq++
    IG.openTid = null; IG.chat = null
    stopIgThreadPoll()
    const wrap = $('#igClient'); if (wrap) wrap.classList.remove('thread-open')
    $$('#igListScroll .wc-item').forEach((it) => it.classList.remove('active'))
    const t = $('#igThread')
    if (t) {
      const empty = el('div', 'wc-thread-empty')
      empty.id = 'igThreadEmpty'
      empty.innerHTML = `${icon('i-ig', 'ico ico-lg')}<h3>Escolha uma conversa</h3><p>Toque numa pessoa à esquerda pra abrir o histórico e responder.</p>`
      t.replaceChildren(empty)
    }
  }

  // cabeçalho da thread: avatar + nome + @username + modo + toggle IA
  function igThreadHeader(chat) {
    const head = el('div', 'wc-thread-head')
    const title = igChatTitle(chat)
    const handle = igHandle(chat.username)
    head.innerHTML = `
      <button class="icon-btn wc-back" id="igBack" title="Voltar" aria-label="Voltar">${icon('i-arrow-l', 'ico')}</button>
      ${avatarHtml(title, chat.avatar, 'wc-av wc-av-head')}
      <div class="wc-head-id">
        <div class="wc-head-nm" id="igHeadNm"><span class="wc-head-person">${esc(title)}</span>${metricasNomeHtml(chat.metricas)}</div>
        ${handle ? `<div class="wc-head-ph">${esc(handle)}</div>` : ''}
      </div>
      <button class="btn ghost small wc-ident" id="igIdent" type="button" title="Quem é essa pessoa em cada rede">${icon('i-link', 'ico ico-sm')}<span class="lbl">Mesma pessoa</span></button>
      <div class="wc-mode" id="igModeWrap">
        <button class="wc-mode-pill" id="igModePill" type="button" aria-haspopup="menu" aria-expanded="false" title="Contexto da conversa"></button>
      </div>
      <div class="wc-head-toggles">
        <div class="wc-head-toggle wc-ai-toggle">
          <span class="wc-head-toggle-lbl">${icon('i-bot', 'ico ico-sm')} IA responde</span>
          <button class="toggle sm" role="switch" aria-checked="${chat.aiOn ? 'true' : 'false'}" aria-label="IA responde nesta conversa" id="igAiToggle"></button>
        </div>
        <div class="wc-head-toggle wc-cobr-toggle">
          <span class="wc-head-toggle-lbl">${icon('i-card', 'ico ico-sm')} Pode cobrar</span>
          <button class="toggle sm" role="switch" aria-checked="false" aria-label="Pode cobrar nesta conversa" id="igCobrToggle"></button>
        </div>
      </div>`
    head.querySelector('#igBack').addEventListener('click', igBackToList)
    const btnIdentIg = head.querySelector('#igIdent')
    if (btnIdentIg) btnIdentIg.addEventListener('click', () => abrirIdentidade(chat.personId, () => igOpenThread(chat.threadId)))
    const tg = head.querySelector('#igAiToggle')
    tg.addEventListener('click', () => igToggleAiForChat(chat.threadId, tg.getAttribute('aria-checked') !== 'true', tg))
    wireCobrancaHeadToggle(head.querySelector('#igCobrToggle'), chat.personId || `ig:${chat.threadId}`, 'Instagram', title)
    const modeWrap = head.querySelector('#igModeWrap')
    const pill = head.querySelector('#igModePill')
    paintModePill(pill, chat.mode || null, chat.objective || '')
    pill.addEventListener('click', (e) => {
      e.stopPropagation()
      if (igModeMenu && igModeMenu.pill === pill) closeIgModeMenu(false)
      else openIgModeMenu(modeWrap, pill, chat.threadId)
    })
    pill.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && !igModeMenu) { e.preventDefault(); e.stopPropagation(); openIgModeMenu(modeWrap, pill, chat.threadId) }
    })
    return head
  }

  function igRenderThreadShell(chat, loading) {
    const t = $('#igThread')
    if (!t) return
    const body = el('div', 'wc-msgs')
    body.id = 'igMsgs'
    if (loading) body.appendChild(el('div', 'wc-thread-empty small', `<span class="spin"></span><p>abrindo conversa…</p>`))
    t.replaceChildren(igThreadHeader(chat), body)
  }

  function igRenderThread(chat) {
    const t = $('#igThread')
    if (!t) return
    t.replaceChildren(igThreadHeader(chat), saudeFaixa(chat.personId, 'instagram'), igThreadMessages(chat), igThreadComposer(chat))
    igScrollToEnd()
  }

  // Nome/@/avatar da lista e o histórico vêm de chamadas diferentes. A lista é a visão
  // mais recente da identidade; copiar seus metadados para a thread impede um cabeçalho
  // antigo de continuar visível depois que a pessoa trocou foto ou nome.
  function igChatWithListIdentity(chat) {
    const listed = (IG.chats || []).find((c) => c.threadId === chat?.threadId)
    if (!listed) return chat
    return {
      ...chat,
      name: listed.name || chat.name,
      username: listed.username || chat.username,
      avatar: listed.avatar || chat.avatar,
      lastText: listed.lastText,
      lastTs: listed.lastTs,
      metricas: listed.metricas || chat.metricas,
    }
  }

  function igPreviewText(value) {
    const raw = String(value || '').trim()
    const mine = /^(you|voc[eê])\s*:/i.test(raw)
    return { text: raw.replace(/^(you|voc[eê])\s*:\s*/i, '').trim(), dir: mine ? 'out' : 'in' }
  }

  // O inbox pode chegar antes do item completo da API. Em vez de deixar a lateral afirmar
  // que há mensagem nova enquanto a thread termina na anterior, mostra uma bolha transitória.
  // Quando o item real chega, a comparação por texto a remove automaticamente.
  function igMessagesWithSidebarTail(chat) {
    const msgs = Array.isArray(chat?.messages) ? chat.messages : []
    const listed = (IG.chats || []).find((c) => c.threadId === chat?.threadId)
    const preview = igPreviewText(listed?.lastText ?? chat?.lastText)
    const previewTs = Number(listed?.lastTs ?? chat?.lastTs) || 0
    if (!preview.text || !previewTs) return msgs
    const sameAtTail = msgs.slice(-12).some((m) =>
      String(m.text || '').trim() === preview.text
      && (!m.ts || Math.abs(Number(m.ts) - previewTs) < 90_000))
    if (sameAtTail) return msgs
    const lastTs = Number(msgs[msgs.length - 1]?.ts) || 0
    if (lastTs && previewTs < lastTs - 90_000) return msgs
    return [...msgs, {
      id: null,
      dir: preview.dir,
      text: preview.text,
      ts: previewTs,
      syncing: true,
    }]
  }

  function igRefreshThreadIdentity(chat) {
    const head = $('#igThread .wc-thread-head')
    if (!head || !chat) return
    const title = igChatTitle(chat)
    const handle = igHandle(chat.username)
    const signature = JSON.stringify([title, handle, chat.avatar || ''])
    if (head.dataset.identity === signature) return
    head.dataset.identity = signature
    const currentAvatar = $('.wc-av-head', head)
    if (currentAvatar) {
      const holder = el('div')
      holder.innerHTML = avatarHtml(title, chat.avatar, 'wc-av wc-av-head')
      currentAvatar.replaceWith(holder.firstElementChild)
    }
    const name = $('#igHeadNm', head)
    if (name) name.textContent = title
    const id = $('.wc-head-id', head)
    let sub = id ? $('.wc-head-ph', id) : null
    if (handle && id && !sub) { sub = el('div', 'wc-head-ph'); id.appendChild(sub) }
    if (sub) { sub.textContent = handle; sub.hidden = !handle }
  }

  function igThreadMessages(chat) {
    const wrap = el('div', 'wc-msgs')
    wrap.id = 'igMsgs'
    const msgs = igMessagesWithSidebarTail(chat)
    if (!msgs.length) {
      wrap.appendChild(el('div', 'wc-thread-empty small', `${icon('i-ig', 'ico')}<p>Sem mensagens carregadas — as novas aparecem aqui.</p>`))
      return wrap
    }
    let lastDay = null
    msgs.forEach((m) => {
      const dk = dayKey(m.ts)
      if (dk && dk !== lastDay) { wrap.appendChild(el('div', 'day-sep', esc(dk))); lastDay = dk }
      wrap.appendChild(bubbleFor(m))   // Instagram é texto; reaproveita a bolha do WhatsApp
    })
    return wrap
  }

  function igThreadComposer(chat) {
    const comp = el('div', 'wc-composer')
    comp.innerHTML = `
      <textarea class="draft" id="igDraft" placeholder="Escreva uma mensagem…" rows="1"></textarea>
      <div class="wc-comp-actions">
        <button class="btn gen" id="igGen" title="Gerar rascunho com IA">${icon('i-spark', 'ico')}<span class="lbl">Gerar com IA</span></button>
        <button class="btn send" id="igSendBtn" disabled title="Enviar">${icon('i-send', 'ico')}<span class="lbl">Enviar</span></button>
      </div>`
    const draft = comp.querySelector('#igDraft')
    const btnSend = comp.querySelector('#igSendBtn')
    const btnGen = comp.querySelector('#igGen')
    const grow = () => { draft.style.height = 'auto'; draft.style.height = Math.min(draft.scrollHeight, 140) + 'px' }
    draft.addEventListener('input', () => { btnSend.disabled = !draft.value.trim(); grow() })
    draft.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (draft.value.trim()) igSendMsg(chat.threadId, draft, btnSend) }
    })
    btnGen.addEventListener('click', () => igGenerateDraft(chat.threadId, btnGen, draft, btnSend))
    btnSend.addEventListener('click', () => igSendMsg(chat.threadId, draft, btnSend))
    return comp
  }

  function igScrollToEnd() {
    requestAnimationFrame(() => { const m = $('#igMsgs'); if (m) m.scrollTop = m.scrollHeight })
  }

  // ---------- ações da thread ----------
  async function igToggleAiForChat(tid, next, tg) {
    if (tg) { tg.setAttribute('aria-checked', String(next)); tg.disabled = true }
    igApplyAiState(tid, next)
    const r = await post('/api/ig/chat/ai', { threadId: tid, enable: next })
    if (tg) tg.disabled = false
    if (!r || !r.ok) {
      igApplyAiState(tid, !next)
      toast('Não deu pra mudar a IA', 'err')
      return
    }
    const on = r.aiOn != null ? !!r.aiOn : next
    igApplyAiState(tid, on, r.personId)
    toast(on ? 'IA ligada nesta conversa' : 'IA desligada')
  }

  function igApplyAiState(tid, on, personId) {
    const listed = (IG.chats || []).find((c) => c.threadId === tid)
    if (listed) { listed.aiOn = on; if (personId) listed.personId = personId }
    if (IG.chat && IG.chat.threadId === tid) { IG.chat.aiOn = on; if (personId) IG.chat.personId = personId }
    $$(`#igListScroll .wc-item-ai[data-ai-tid="${CSS.escape(tid)}"]`).forEach((t) => t.setAttribute('aria-checked', String(on)))
    if (IG.openTid === tid) { const h = $('#igAiToggle'); if (h) h.setAttribute('aria-checked', String(on)) }
  }

  // ---------- modo de conversa (mesmos modos do WhatsApp; escreve em /api/ig/chat/mode) ----------
  function igCurrentModeFor(tid) {
    if (IG.chat && IG.chat.threadId === tid) return IG.chat.mode || null
    const listed = (IG.chats || []).find((c) => c.threadId === tid)
    return (listed && listed.mode) || null
  }
  function igCurrentObjectiveFor(tid) {
    if (IG.chat && IG.chat.threadId === tid) return IG.chat.objective || ''
    const listed = (IG.chats || []).find((c) => c.threadId === tid)
    return (listed && listed.objective) || ''
  }
  function igApplyModeState(tid, mode) {
    const listed = (IG.chats || []).find((c) => c.threadId === tid)
    if (listed) listed.mode = mode
    if (IG.chat && IG.chat.threadId === tid) IG.chat.mode = mode
    if ($('#igListScroll')) renderIgChats()
    if (IG.openTid === tid) { const pill = $('#igModePill'); if (pill) paintModePill(pill, mode, igCurrentObjectiveFor(tid)) }
  }
  function igApplyObjectiveState(tid, objective) {
    const value = String(objective || '').trim()
    const listed = (IG.chats || []).find((c) => c.threadId === tid)
    if (listed) listed.objective = value
    if (IG.chat && IG.chat.threadId === tid) IG.chat.objective = value
    if (IG.openTid === tid) {
      const pill = $('#igModePill')
      if (pill) paintModePill(pill, igCurrentModeFor(tid), value)
    }
  }
  async function igSetChatMode(tid, mode) {
    const prev = igCurrentModeFor(tid)
    if (prev === mode) return
    igApplyModeState(tid, mode)
    const r = await post('/api/ig/chat/mode', { threadId: tid, mode })
    if (!r || !r.ok) {
      igApplyModeState(tid, prev)
      toast('Não deu pra mudar o modo', 'err')
      return
    }
    const final = (r.mode !== undefined) ? (r.mode || null) : mode
    if (final !== mode) igApplyModeState(tid, final)
    toast(final ? `Modo definido: ${modeInfo(final).label}` : 'Modo removido')
  }

  // popover do modo (mesmo padrão/CSS do WhatsApp; estado próprio pra não colidir)
  let igModeMenu = null   // { root, pill, tid, onDoc, onKey }
  function closeIgModeMenu(refocus) {
    if (!igModeMenu) return
    const st = igModeMenu; igModeMenu = null
    document.removeEventListener('pointerdown', st.onDoc, true)
    document.removeEventListener('keydown', st.onKey, true)
    st.root.remove()
    if (st.pill && st.pill.isConnected) {
      st.pill.setAttribute('aria-expanded', 'false')
      if (refocus) st.pill.focus()
    }
  }
  function openIgModeMenu(wrap, pill, tid) {
    closeIgModeMenu(false)
    const cur = igCurrentModeFor(tid)
    const root = el('div', 'wc-mode-pop')
    const scrim = el('div', 'wc-mode-scrim')
    const menu = el('div', 'wc-mode-menu')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', 'Contexto da conversa')
    const objective = igCurrentObjectiveFor(tid)
    const goal = el('button', 'wc-mode-opt wc-objective-menu-opt' + (objective ? ' has-objective' : ''))
    goal.type = 'button'
    goal.setAttribute('role', 'menuitem')
    goal.innerHTML = `
      <span class="wc-objective-menu-icon">${icon('i-target', 'ico')}</span>
      <span class="wc-mode-opt-txt"><b>Objetivo com esta pessoa</b><small>${objective ? esc(objective) : 'adicione uma direção opcional para a IA'}</small></span>
      <span class="wc-context-edit">${icon('i-edit', 'ico ico-sm')}</span>`
    goal.addEventListener('click', (e) => {
      e.stopPropagation()
      const chat = (IG.chat && IG.chat.threadId === tid) ? IG.chat : (IG.chats || []).find((c) => c.threadId === tid)
      closeIgModeMenu(false)
      openObjectiveEditor({
        personId: chat?.personId || `ig:${tid}`,
        name: chat?.name || chat?.username || '',
        objective,
        anchor: pill,
        onSaved: (value) => igApplyObjectiveState(tid, value),
      })
    })
    const chatMenuIg = (IG.chat && IG.chat.threadId === tid) ? IG.chat : (IG.chats || []).find((c) => c.threadId === tid)
    const pidIg = chatMenuIg?.personId || `ig:${tid}`
    menu.append(goal, encontroMenuOpt(pidIg), atendimentoMenuOpt(pidIg), cobrancaMenuOpt(pidIg))
    montarOpcoesVinculo(menu, pidIg, async (valor) => {
      closeIgModeMenu(true)
      const r = await post('/api/self/vinculos', { personId: pidIg, vinculo: valor || '', iaPode: 'cuidado' })
      if (r && r.ok) toast(valor ? `Vínculo definido: ${(CATALOGO_VINC.find((c) => c.valor === valor) || {}).label || valor}` : 'Vínculo removido')
      else toast('Não consegui salvar o vínculo', 'err')
    })
    root.append(scrim, menu)
    root.addEventListener('click', (e) => e.stopPropagation())
    wrap.appendChild(root)
    pill.setAttribute('aria-expanded', 'true')

    const onDoc = (e) => { if (!menu.contains(e.target) && e.target !== pill && !pill.contains(e.target)) closeIgModeMenu(false) }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeIgModeMenu(true); return }
      if (e.key === 'Tab') { e.preventDefault(); closeIgModeMenu(true); return }
      const items = $$('.wc-mode-opt', menu)
      const idx = items.indexOf(document.activeElement)
      if (e.key === 'ArrowDown') { e.preventDefault(); items[idx < 0 ? 0 : (idx + 1) % items.length].focus() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length].focus() }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus() }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus() }
    }
    document.addEventListener('pointerdown', onDoc, true)
    document.addEventListener('keydown', onKey, true)
    igModeMenu = { root, pill, tid, onDoc, onKey }
    ajustaMenuNaTela(menu, pill)
    const sel = menu.querySelector('.wc-mode-opt.on') || menu.querySelector('.wc-mode-opt')
    if (sel) { sel.focus({ preventScroll: true }); revelaNoMenu(menu, sel) }
  }

  async function igGenerateDraft(tid, btnGen, draft, btnSend) {
    if (btnGen.disabled) return
    const original = btnGen.innerHTML
    btnGen.disabled = true
    btnGen.innerHTML = `<span class="spin"></span><span class="lbl">Gerando…</span>`
    const r = await gerarRascunho('/api/ig/chat/generate', { threadId: tid })
    btnGen.disabled = false
    btnGen.innerHTML = original
    if (!r || r.draft == null) { toast('Não consegui gerar agora', 'err'); return }
    draft.value = r.draft
    btnSend.disabled = !draft.value.trim()
    draft.style.height = 'auto'; draft.style.height = Math.min(draft.scrollHeight, 140) + 'px'
    draft.focus()
  }

  async function igSendMsg(tid, draft, btnSend) {
    const text = draft.value.trim()
    if (!text) return
    IG.sending = true
    btnSend.disabled = true
    draft.value = ''
    draft.style.height = 'auto'
    const tempId = 'tmp-' + Date.now()
    const temp = { id: tempId, dir: 'out', text, ts: Date.now(), pending: true }
    if (IG.chat && IG.chat.threadId === tid) (IG.chat.messages = IG.chat.messages || []).push(temp)
    const msgsHost = $('#igMsgs')
    if (msgsHost) {
      const emptyBox = msgsHost.querySelector('.wc-thread-empty')
      if (emptyBox) emptyBox.remove()
      msgsHost.appendChild(bubbleFor(temp))
      igScrollToEnd()
    }
    const r = await post('/api/ig/chat/send', { threadId: tid, text })
    IG.sending = false
    const rowEl = msgsHost ? msgsHost.querySelector(`[data-mid="${CSS.escape(tempId)}"]`) : null
    if (!r || !r.ok || !r.message) {
      if (rowEl) rowEl.replaceWith(bubbleFor({ id: tempId, dir: 'out', text, ts: temp.ts, failed: true }))
      if (IG.chat && IG.chat.messages) { const mm = IG.chat.messages.find((x) => x.id === tempId); if (mm) { mm.pending = false; mm.failed = true } }
      draft.value = text
      btnSend.disabled = false
      toast('Falha ao enviar', 'err')
      return
    }
    const real = r.message
    if (IG.chat && IG.chat.messages) { const i = IG.chat.messages.findIndex((x) => x.id === tempId); if (i >= 0) IG.chat.messages[i] = real }
    if (rowEl) rowEl.replaceWith(bubbleFor(real))
    const listed = (IG.chats || []).find((c) => c.threadId === tid)
    if (listed) { listed.lastText = real.text; listed.lastTs = real.ts; renderIgChats() }
    igScrollToEnd()
    loadState()
  }

  function igRefreshThreadMessages(chat) {
    const t = $('#igThread'); if (!t) return
    chat = igChatWithListIdentity(chat)
    igRefreshThreadIdentity(chat)
    atualizarMetricasNoCabecalho('#igThread', chat.metricas)
    if (!igModeMenu) { const pill = $('#igModePill'); if (pill) paintModePill(pill, chat.mode || null, chat.objective || '') }
    const old = $('#igMsgs'); if (!old) return
    trocarBolhas(old, igThreadMessages(chat), igScrollToEnd)
  }

  // ---------- polling leve (só na aba Instagram) ----------
  function startIgListPoll() {
    stopIgListPoll()
    IG.listTimer = setInterval(() => { if (S.tab === 'instagram' && $('#igListScroll')) loadIgChats() }, 10000)
  }
  function stopIgListPoll() { if (IG.listTimer) { clearInterval(IG.listTimer); IG.listTimer = null } }
  function startIgThreadPoll() {
    stopIgThreadPoll()
    IG.threadTimer = setInterval(async () => {
      if (S.tab !== 'instagram' || !IG.openTid) { stopIgThreadPoll(); return }
      if (IG.sending) return
      const tid = IG.openTid
      const reqId = ++IG.threadReq
      const chat = await api(`/api/ig/chat?threadId=${encodeURIComponent(tid)}`)
      if (!chat || reqId !== IG.threadReq || IG.openTid !== tid || IG.sending) return
      IG.chat = igChatWithListIdentity(chat)
      igRefreshThreadMessages(IG.chat)
    }, 5000)
  }
  function stopIgThreadPoll() { if (IG.threadTimer) { clearInterval(IG.threadTimer); IG.threadTimer = null } }
  function stopIgPolling() { stopIgListPoll(); stopIgThreadPoll(); closeIgModeMenu(false) }

  // WS: refaz a lista/thread do Instagram quando o servidor avisa.
  // O 'message' do IG carrega personId (não threadId), então a granularidade
  // de "é a conversa aberta?" não dá pra afinar — refazemos a lista e, se há
  // thread aberta, relemos ela.
  function igHandleWsRefresh() {
    if (S.tab !== 'instagram' || !$('#igListScroll')) return
    loadIgChats()
    // Enquanto o primeiro GET ainda monta a thread completa, ele é o único dono da tela.
    // Um aviso WS nesse intervalo não pode cancelá-lo e deixar só o esqueleto sem composer.
    if (IG.openTid && IG.chat && !IG.sending) {
      const tid = IG.openTid
      const reqId = ++IG.threadReq
      api(`/api/ig/chat?threadId=${encodeURIComponent(tid)}`).then((chat) => {
        if (chat && reqId === IG.threadReq && IG.openTid === tid && !IG.sending) {
          IG.chat = igChatWithListIdentity(chat)
          igRefreshThreadMessages(IG.chat)
        }
      })
    }
  }

  // ==================================================================
  //  BADOO — cliente de conversas (4º canal)
  //  Mesmo desenho do Instagram (master-detail), consumindo /api/badoo/*.
  //  A chave é chatId (o id opaco de /messages/<id>) e a pessoa é 'b:'+chatId.
  //  Duas diferenças que o desenho tem que respeitar:
  //   - ler a conversa ao vivo é uma NAVEGAÇÃO no Chrome (~8s): o poll da tela lê só o
  //     banco, e a releitura ao vivo só acontece quando a conversa abre (vivo=1);
  //   - enviar demora (digitação + releitura de comprovante), então a bolha entra
  //     otimista e o botão fica travado até o servidor confirmar.
  // ==================================================================
  const BADOO = {
    chats: [],
    visibleChats: [],
    query: '',
    filtroIa: '',
    openId: null,
    chat: null,
    listTimer: null,
    threadTimer: null,
    sending: false,
    selected: new Set(),
    bulkAction: 'ia_on',
    bulkNeedId: '',
    needOptions: null,
    needPromise: null,
  }

  async function loadBadooStatusPill() {
    const bd = await api('/api/badoo')
    const on = bd && bd.status === 'CONNECTED'
    const dot = $('#dotBadoo'); if (dot) dot.className = dotClass(on ? 'on' : bd && bd.status === 'ATENCAO' ? 'warn' : bd ? 'idle' : 'off')
    const pill = $('#stBadoo'); if (pill) pill.classList.toggle('up', !!on)
    const lbl = $('#lblBadoo'); if (lbl) lbl.textContent = on && bd.conversas ? `Badoo · ${bd.conversas}` : 'Badoo'
    const mobileDot = $('#mDotBadoo'); if (mobileDot) mobileDot.className = on ? 'on' : 'off'
  }


  // ---------- CANAL SIMPLES (Meu Patrocínio e Telegram): lista + thread + IA, no padrão do
  // sistema (mesmas classes do Badoo: wa-client / wc-body / wc-list / wc-thread / wc-item /
  // bubbleFor). Um só componente pros dois — parametrizado por cfg — pra não ter clone torto.
  const CANAIS_SIMPLES = {
    // `pid` é o prefixo do personId do canal (o mesmo que o autoreply usa pra voltar ao id
    // nativo). Sem ele o cabeçalho não teria como pedir a regra de cobrança antes de a
    // conversa carregar, e o interruptor nasceria mudo.
    mp: { rota: 'mp', idKey: 'peerId', nome: 'Meu Patrocínio', ico: 'i-mp', pid: 'mp:' },
    tg: { rota: 'tg', idKey: 'chatId', nome: 'Telegram', ico: 'i-tg', pid: 'tg:' },
  }
  const CS = { mp: { chats: [], openId: null, query: '', poll: null }, tg: { chats: [], openId: null, query: '', poll: null } }

  function stopCanalPoll(k) { if (CS[k].poll) { clearInterval(CS[k].poll); CS[k].poll = null } }
  function loadMp() { loadCanal('mp') }
  function loadTg() { loadCanal('tg') }
  function stopMpPoll() { stopCanalPoll('mp') }
  function stopTgPoll() { stopCanalPoll('tg') }

  function loadCanal(k) {
    const cfg = CANAIS_SIMPLES[k]
    const host = $('#' + k + 'Host')
    if (!host) return
    host.replaceChildren(canalShell(k, cfg))
    requestAnimationFrame(() => { loadCanalChats(k); stopCanalPoll(k); CS[k].poll = setInterval(() => { if (S.tab === k) loadCanalChats(k) }, 15000) })
  }

  function canalShell(k, cfg) {
    const wrap = el('div', 'wa-client'); wrap.id = k + 'Client'
    const body = el('div', 'wc-body')
    body.innerHTML = `
      <aside class="wc-list" id="${k}List" aria-label="Conversas do ${esc(cfg.nome)}">
        <div class="wc-list-head">${icon(cfg.ico, 'ico ico-sm')} ${esc(cfg.nome)} <span class="cnt" id="${k}Cnt">·</span></div>
        <label class="wc-search" for="${k}Search">${icon('i-search')}<input id="${k}Search" type="search" inputmode="search" autocomplete="off" placeholder="Buscar"></label>
        <div class="wc-list-scroll" id="${k}ListScroll"><div class="wc-loading">${icon(cfg.ico, 'ico')}<span>carregando conversas…</span></div></div>
      </aside>
      <section class="wc-thread" id="${k}Thread" aria-label="Conversa">
        <div class="wc-thread-empty" id="${k}ThreadEmpty">${icon(cfg.ico, 'ico ico-lg')}<h3>Escolha uma conversa</h3><p>Toque numa pessoa à esquerda pra abrir o histórico e responder.</p></div>
      </section>`
    wrap.appendChild(body)
    body.querySelector('#' + k + 'Search').addEventListener('input', (e) => { CS[k].query = e.currentTarget.value.trim(); renderCanalChats(k) })
    return wrap
  }

  async function loadCanalChats(k) {
    if (!$('#' + k + 'ListScroll')) return
    const chats = await api('/api/' + CANAIS_SIMPLES[k].rota + '/chats')
    if (!$('#' + k + 'ListScroll')) return
    CS[k].chats = Array.isArray(chats) ? chats : []
    renderCanalChats(k)
  }

  function renderCanalChats(k) {
    const cfg = CANAIS_SIMPLES[k]
    const host = $('#' + k + 'ListScroll'); const cnt = $('#' + k + 'Cnt')
    if (!host) return
    const idOf = (c) => c[cfg.idKey]
    const comConversa = (CS[k].chats || []).filter((c) => c.previa || c.mensagens)
    const shown = CS[k].query ? comConversa.filter((c) => norm(`${c.nome || ''} ${c.username || ''} ${c.previa || ''} ${idOf(c)}`).includes(norm(CS[k].query))) : comConversa
    if (cnt) cnt.textContent = String(shown.length)
    if (!shown.length) {
      host.replaceChildren(emptyState(cfg.ico, comConversa.length ? 'Nada encontrado' : 'Nenhuma conversa ainda', comConversa.length ? 'Nenhuma conversa corresponde à busca.' : 'As conversas aparecem aqui depois de sincronizar.'))
      return
    }
    const sorted = shown.slice().sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
    const list = document.createDocumentFragment()
    sorted.forEach((c) => list.appendChild(canalItem(k, cfg, c)))
    host.replaceChildren(list)
  }

  function canalItem(k, cfg, c) {
    const id = c[cfg.idKey]
    const title = c.nome || c.username || ('contato ' + id)
    const it = el('div', 'wc-item' + (CS[k].openId === id ? ' active' : ''))
    it.setAttribute('role', 'button'); it.setAttribute('tabindex', '0'); it.dataset.cid = id
    const when = c.lastTs ? timeAgo(c.lastTs) : ''
    it.innerHTML = `
      ${avatarHtml(title, c.foto || null)}
      <div class="wc-item-main">
        <div class="wc-item-top"><span class="wc-nm">${esc(title)}</span>${metricasNomeHtml(c.metricas)}${when ? `<span class="wc-when">${esc(when)}</span>` : ''}</div>
        <div class="wc-item-bot"><span class="wc-prev">${c.previa ? esc(c.previa) : '<i class="mute">sem mensagens</i>'}</span><span class="wc-flags">${c.aiOn ? `<span class="wc-unread ig" title="IA ligada">${icon('i-bot', 'ico ico-xs')}</span>` : ''}</span></div>
      </div>`
    const abrir = () => canalOpen(k, id)
    it.addEventListener('click', abrir)
    it.addEventListener('keydown', (e) => { if (e.key === 'Enter') abrir() })
    return it
  }

  async function canalOpen(k, id) {
    CS[k].openId = id
    $$('#' + k + 'ListScroll .wc-item').forEach((it) => it.classList.toggle('active', it.dataset.cid === id))
    const wrap = $('#' + k + 'Client'); if (wrap) wrap.classList.add('thread-open')
    const t = $('#' + k + 'Thread')
    if (t) t.replaceChildren(canalThreadHead(k, { [CANAIS_SIMPLES[k].idKey]: id, nome: 'abrindo…' }), el('div', 'wc-msgs', `<div class="wc-thread-empty small"><span class="spin"></span><p>abrindo conversa…</p></div>`))
    const cfg = CANAIS_SIMPLES[k]
    const conv = await api(`/api/${cfg.rota}/conversa?${cfg.idKey}=${encodeURIComponent(id)}`)
    if (CS[k].openId !== id || !$('#' + k + 'Thread')) return
    if (!conv) { $('#' + k + 'Thread').replaceChildren(canalThreadHead(k, { [cfg.idKey]: id }), emptyState('i-x', 'Não deu pra abrir', 'Tente de novo em instantes.')); return }
    canalRenderThread(k, conv)
  }

  function canalBackToList(k) {
    CS[k].openId = null
    const wrap = $('#' + k + 'Client'); if (wrap) wrap.classList.remove('thread-open')
    $$('#' + k + 'ListScroll .wc-item').forEach((it) => it.classList.remove('active'))
    const t = $('#' + k + 'Thread')
    if (t) { const cfg = CANAIS_SIMPLES[k]; const e = el('div', 'wc-thread-empty'); e.innerHTML = `${icon(cfg.ico, 'ico ico-lg')}<h3>Escolha uma conversa</h3><p>Toque numa pessoa à esquerda pra abrir.</p>`; t.replaceChildren(e) }
  }

  function canalThreadHead(k, conv) {
    const cfg = CANAIS_SIMPLES[k]
    const id = conv[cfg.idKey]
    const title = conv.nome || conv.username || ('contato ' + id)
    const head = el('div', 'wc-thread-head')
    head.innerHTML = `
      <button class="icon-btn wc-back" title="Voltar" aria-label="Voltar">${icon('i-arrow-l', 'ico')}</button>
      ${avatarHtml(title, conv.foto || null, 'wc-av wc-av-head')}
      <div class="wc-head-id"><div class="wc-head-nm"><span class="wc-head-person">${esc(title)}</span>${metricasNomeHtml(conv.metricas)}</div><div class="wc-head-ph">${esc(cfg.nome)}</div></div>
      <div class="wc-head-toggles">
        <div class="wc-head-toggle wc-ai-toggle">
          <span class="wc-head-toggle-lbl">${icon('i-bot', 'ico ico-sm')} IA responde</span>
          <button class="toggle sm" role="switch" aria-checked="${conv.aiOn ? 'true' : 'false'}" aria-label="IA responde nesta conversa"></button>
        </div>
        <div class="wc-head-toggle wc-cobr-toggle">
          <span class="wc-head-toggle-lbl">${icon('i-card', 'ico ico-sm')} Pode cobrar</span>
          <button class="toggle sm" role="switch" aria-checked="false" aria-label="Pode cobrar nesta conversa"></button>
        </div>
      </div>`
    head.querySelector('.wc-back').addEventListener('click', () => canalBackToList(k))
    wireCobrancaHeadToggle(head.querySelector('.wc-cobr-toggle .toggle'), conv.personId || (id ? cfg.pid + id : ''), cfg.nome, title)
    const tg = head.querySelector('.wc-ai-toggle .toggle')
    tg.addEventListener('click', async () => {
      const novo = tg.getAttribute('aria-checked') !== 'true'
      await api('/api/' + cfg.rota + '/ia', { method: 'POST', body: JSON.stringify({ [cfg.idKey]: id, enable: novo }) })
      tg.setAttribute('aria-checked', novo ? 'true' : 'false')
      loadCanalChats(k)
    })
    return head
  }

  function canalRenderThread(k, conv) {
    const t = $('#' + k + 'Thread'); if (!t) return
    const cfg = CANAIS_SIMPLES[k]
    const id = conv[cfg.idKey]
    const msgs = el('div', 'wc-msgs'); msgs.id = k + 'Msgs'
    if (!(conv.messages || []).length) msgs.appendChild(el('div', 'wc-thread-empty small', `${icon(cfg.ico, 'ico')}<p>Sem mensagens ainda.</p>`))
    else { let lastDay = null; conv.messages.forEach((m) => { const dk = dayKey(m.ts); if (dk && dk !== lastDay) { msgs.appendChild(el('div', 'day-sep', esc(dk))); lastDay = dk } msgs.appendChild(bubbleFor(m)) }) }
    const comp = el('div', 'wc-composer')
    comp.innerHTML = `
      <textarea class="draft" placeholder="Escreva uma mensagem…" rows="1"></textarea>
      <div class="wc-comp-actions"><button class="btn send" disabled title="Enviar">${icon('i-send', 'ico')}<span class="lbl">Enviar</span></button></div>`
    const draft = comp.querySelector('.draft'); const btnSend = comp.querySelector('.send')
    const grow = () => { draft.style.height = 'auto'; draft.style.height = Math.min(draft.scrollHeight, 140) + 'px' }
    const enviar = async () => {
      const txt = draft.value.trim(); if (!txt) return
      draft.value = ''; btnSend.disabled = true; grow()
      await api('/api/' + cfg.rota + '/enviar', { method: 'POST', body: JSON.stringify({ [cfg.idKey]: id, texto: txt }) })
      canalOpen(k, id)
    }
    draft.addEventListener('input', () => { btnSend.disabled = !draft.value.trim(); grow() })
    draft.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar() } })
    btnSend.addEventListener('click', enviar)
    t.replaceChildren(canalThreadHead(k, conv), msgs, comp)
    requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight })
  }

  async function loadBadoo() {
    const host = $('#badooHost')
    if (!host.dataset.loaded) host.replaceChildren(el('div', 'empty', `${icon('i-badoo', 'ico')}<h3>carregando…</h3>`))
    const bd = await api('/api/badoo')
    host.dataset.loaded = '1'
    if (!bd) { host.replaceChildren(emptyState('i-badoo', 'Badoo indisponível', 'O painel não conseguiu falar com o módulo de Badoo do vendas-multicanal.')); return }
    stopBadooThreadPoll(); BADOO.openId = null; BADOO.chat = null
    host.replaceChildren(badooClient(bd))
    abrirAlvo(badooOpenThread)
  }

  // A chave de deslizar sozinho, com os ajustes na mesma linha. Nasce lendo o estado do
  // servidor — o botão nunca "acha" que está ligado: ele mostra o que o vendas-multicanal respondeu.
  async function montarChaveDeslizar(head) {
    const sw = head.querySelector('#bdDeslizaSw')
    const info = head.querySelector('#bdDeslizaInfo')
    const eng = head.querySelector('#bdDeslizaCfg')
    if (!sw) return
    const pintar = (e) => {
      if (!e) return
      BD_DESLIZA = e
      sw.setAttribute('aria-checked', e.ligado ? 'true' : 'false')
      const partes = []
      if (e.ligado) partes.push(e.sombra ? 'em sombra' : 'valendo')
      partes.push(`${e.votosHoje} de ${e.tetos.porDia} hoje`)
      partes.push(`~${(e.ritmo.medianaMs / 1000).toFixed(1)}s entre deslizes`)
      info.textContent = partes.join(' · ')
    }
    pintar(await api('/api/badoo/encontros'))
    sw.addEventListener('click', async () => {
      const ligar = sw.getAttribute('aria-checked') !== 'true'
      sw.setAttribute('aria-checked', ligar ? 'true' : 'false')   // responde na hora
      pintar(await api('/api/badoo/encontros/config', { method: 'POST', body: JSON.stringify({ ligado: ligar }) }))
      toast(ligar ? 'deslizando sozinho no Badoo' : 'parou de deslizar')
    })
    if (eng) eng.addEventListener('click', () => abrirAjustesDeslizar(eng, pintar))
    // enquanto uma sessão roda, o número do dia sobe sozinho
    clearInterval(BD_DESLIZA_T)
    BD_DESLIZA_T = setInterval(async () => {
      if (S.tab !== 'badoo' || !head.isConnected) { clearInterval(BD_DESLIZA_T); return }
      pintar(await api('/api/badoo/encontros'))
    }, 15000)
  }

  // Ajustes do deslizar, num pop nosso (nada de controle nativo). Três números só, que são
  // os três que mudam o comportamento: quanto por dia, quanto de pausa, e o tamanho da tirada.
  function abrirAjustesDeslizar(ancora, aoSalvar) {
    const e = BD_DESLIZA || {}
    const box = el('div', 'bd-cfg')
    box.innerHTML = `
      <h4>Como deslizar</h4>
      <label class="bd-cfg-l"><span>Quantos por dia</span>
        <input type="text" inputmode="numeric" id="bdCfgDia" value="${e.tetos?.porDia ?? 600}"></label>
      <label class="bd-cfg-l"><span>Pausa típica entre deslizes</span>
        <input type="text" inputmode="decimal" id="bdCfgPausa" value="${((e.ritmo?.medianaMs ?? 1250) / 1000).toFixed(1)}"><i>seg</i></label>
      <label class="bd-cfg-l"><span>Tamanho de cada tirada</span>
        <input type="text" inputmode="numeric" id="bdCfgMin" value="${e.tetos?.tirada?.[0] ?? 25}"><i>a</i>
        <input type="text" inputmode="numeric" id="bdCfgMax" value="${e.tetos?.tirada?.[1] ?? 70}"></label>
      <p class="bd-cfg-nota">A pausa é o intervalo <b>típico</b>: em cima dela ainda entram variação, distração e cansaço, senão vira metrônomo. Na prática o Badoo entrega de 12 a 19 por minuto — o gargalo é ele montando o próximo perfil, não a pausa.</p>
      <div class="bd-cfg-btns"><button class="btn ghost small" id="bdCfgCancel">Cancelar</button><button class="btn small" id="bdCfgOk">Salvar</button></div>`
    box.classList.add('pj-pop')
    floatPop(ancora, box)
    box.querySelector('#bdCfgCancel').addEventListener('click', () => box.remove())
    box.querySelector('#bdCfgOk').addEventListener('click', async () => {
      const num = (id) => Number(String(box.querySelector('#' + id).value).replace(',', '.').replace(/[^\d.]/g, ''))
      const corpo = {
        tetos: { porDia: num('bdCfgDia'), tirada: [num('bdCfgMin'), num('bdCfgMax')] },
        ritmo: { medianaMs: Math.round(num('bdCfgPausa') * 1000) },
      }
      const r = await api('/api/badoo/encontros/config', { method: 'POST', body: JSON.stringify(corpo) })
      if (r) { aoSalvar(r); toast('ajustado') }
      box.remove()
    })
  }

  function badooStatusHead(bd) {
    const head = el('div', 'wa-client-head ig-head')
    const on = bd.status === 'CONNECTED'
    const quando = bd.ultimoSync ? timeAgo(bd.ultimoSync) : null
    const txt = on ? `<div class="wc-txt"><b>Badoo conectado</b><span>${bd.conversas} conversas · última leitura ${esc(quando || 'agora')}</span></div>`
      : bd.status === 'ATENCAO' ? `<div class="wc-txt"><b>Badoo sem leitura recente</b><span>a última lista veio ${esc(quando || 'faz tempo')} — pode ser sessão caída</span></div>`
      : bd.status === 'PENDENTE' ? `<div class="wc-txt"><b>Badoo ainda não sincronizou</b><span>a sessão está salva; toque em sincronizar pra trazer as conversas</span></div>`
      : `<div class="wc-txt"><b>Badoo não conectado</b><span>a sessão é importada por fora (cookies do navegador logado)</span></div>`
    head.innerHTML = `
      <div class="wc-id">
        <div class="wc-dot${on ? '' : ' off'}"></div>
        ${txt}
      </div>
      <div class="ig-head-btns">
        <div class="bd-desliza" id="bdDesliza">
          <span class="bd-desliza-lbl">${icon('i-radar', 'ico ico-sm')} Deslizar sozinho</span>
          <button class="toggle sm" role="switch" aria-checked="false" aria-label="Deslizar sozinho no Badoo" id="bdDeslizaSw"></button>
          <small id="bdDeslizaInfo"></small>
          <button class="icon-btn bd-cfg-btn" id="bdDeslizaCfg" title="Ajustar quanto e com que pausa" aria-label="Ajustes do deslizar">${icon('i-gear', 'ico ico-sm')}</button>
        </div>
        <button class="btn ghost ig-sync" id="badooPrimeira" title="Mandar a primeira mensagem sem IA">${icon('i-send', 'ico ico-sm')}<span class="lbl">Primeira mensagem</span></button>
        <button class="btn ghost ig-sync" id="badooCurtidas" title="Quem já te curtiu no Badoo">${icon('i-heart', 'ico ico-sm')}<span class="lbl">Curtidas</span></button>
        <button class="btn ghost ig-sync" id="badooSync" title="Ler a lista e as conversas que mudaram">${icon('i-sync', 'ico ico-sm')}<span class="lbl">Sincronizar agora</span></button>
      </div>`
    head.querySelector('#badooSync').addEventListener('click', badooSyncNow)
    head.querySelector('#badooCurtidas').addEventListener('click', abrirCurtidasBadoo)
    head.querySelector('#badooPrimeira').addEventListener('click', () => abrirPrimeira('badoo', 'badooHost'))
    montarChaveDeslizar(head)
    return head
  }

  async function badooSyncNow(e) {
    const b = e.currentTarget
    const original = b.innerHTML
    b.disabled = true
    b.innerHTML = `<span class="spin"></span><span class="lbl">Sincronizando…</span>`
    const r = await post('/api/badoo/sync', { assincrono: true })
    setTimeout(() => { if (S.tab === 'badoo' && $('#badooListScroll')) loadBadooChats() }, 1500)
    b.disabled = false
    b.innerHTML = original
    toast(r && r.ok ? 'Sincronização iniciada — leva alguns segundos' : 'Não deu pra sincronizar', r && r.ok ? 'ok' : 'err')
  }

  function badooClient(bd) {
    const wrap = el('div', 'wa-client')
    wrap.id = 'badooClient'
    wrap.appendChild(badooStatusHead(bd))
    const body = el('div', 'wc-body')
    body.innerHTML = `
      <aside class="wc-list" id="badooList" aria-label="Conversas do Badoo">
        <div class="wc-list-head">${icon('i-badoo', 'ico ico-sm')} Conversas <span class="cnt" id="badooCnt">·</span></div>
        ${filtroIaHtml(BADOO.filtroIa)}
        <label class="wc-search mobile-search mobile-only" for="badooSearch">
          ${icon('i-search')}<input id="badooSearch" type="search" inputmode="search" autocomplete="off" placeholder="Buscar no Badoo">
        </label>
        <div class="wc-list-scroll" id="badooListScroll">
          <div class="wc-loading">${icon('i-badoo', 'ico')}<span>carregando conversas…</span></div>
        </div>
      </aside>
      <section class="wc-thread" id="badooThread" aria-label="Conversa">
        <div class="wc-thread-empty" id="badooThreadEmpty">
          ${icon('i-badoo', 'ico ico-lg')}
          <h3>Escolha uma conversa</h3>
          <p>Toque numa pessoa à esquerda pra abrir o histórico e responder.</p>
        </div>
      </section>`
    wrap.appendChild(body)
    body.querySelector('#badooSearch')?.addEventListener('input', (e) => { BADOO.query = e.currentTarget.value.trim(); renderBadooChats() })
    ligarFiltroIa(body, (v) => { BADOO.filtroIa = v; renderBadooChats() })
    requestAnimationFrame(() => { loadBadooChats(); startBadooListPoll() })
    return wrap
  }

  function setBadooSelected(chatId, selected) {
    if (selected) BADOO.selected.add(chatId)
    else BADOO.selected.delete(chatId)
    refreshBadooBulkUi()
  }

  function badooBulkNeedsAction(action = BADOO.bulkAction) {
    return action === 'pedido_on' || action === 'pedido_off'
  }

  function badooBulkSelection() {
    const visiveis = BADOO.visibleChats || []
    return visiveis.filter((c) => BADOO.selected.has(c.chatId))
  }

  async function ensureBadooNeedOptions() {
    if (Array.isArray(BADOO.needOptions)) return BADOO.needOptions
    if (!BADOO.needPromise) {
      BADOO.needPromise = api('/api/necessidades', { silencioso: true }).then((r) => {
        const itens = Array.isArray(r?.itens) ? r.itens : []
        BADOO.needOptions = itens
          .filter((n) => String(n?.status || 'aberta') === 'aberta')
          .map((n) => ({ id: String(n.id), label: `${n.descricao || 'Necessidade'} · ${n.valorFormatado || 'sem valor'}` }))
        if (!BADOO.bulkNeedId || !BADOO.needOptions.some((n) => n.id === BADOO.bulkNeedId)) BADOO.bulkNeedId = BADOO.needOptions[0]?.id || ''
        BADOO.needPromise = null
        refreshBadooBulkUi()
        return BADOO.needOptions
      }).catch(() => {
        BADOO.needOptions = []
        BADOO.bulkNeedId = ''
        BADOO.needPromise = null
        refreshBadooBulkUi()
        return BADOO.needOptions
      })
    }
    return BADOO.needPromise
  }

  function badooBulkActionLabel(action, total) {
    if (action === 'ia_off') return total === 1 ? 'Desligar IA em 1 conversa' : `Desligar IA em ${total} conversas`
    if (action === 'pedido_on') return total === 1 ? 'Agendar 1 pedido' : `Agendar ${total} pedidos`
    if (action === 'pedido_off') return total === 1 ? 'Cancelar 1 pedido' : `Cancelar ${total} pedidos`
    return total === 1 ? 'Ligar IA em 1 conversa' : `Ligar IA em ${total} conversas`
  }

  function badooBulkToolbar() {
    const visiveis = BADOO.visibleChats || []
    if (!visiveis.length && !BADOO.selected.size) return null
    const bar = el('section', 'opener-toolbar badoo-bulk-toolbar')
    bar.setAttribute('aria-label', 'Ações em lote no Badoo')
    const selectAll = el('button', 'opener-select-all', '')
    selectAll.type = 'button'
    selectAll.dataset.badooBulkSelectAll = 'true'
    selectAll.addEventListener('click', () => {
      const allSelected = visiveis.length > 0 && visiveis.every((c) => BADOO.selected.has(c.chatId))
      visiveis.forEach((c) => setBadooSelected(c.chatId, !allSelected))
      refreshBadooBulkUi()
    })
    const hint = el('span', 'opener-toolbar-hint', '<b>Badoo em lote</b><small>Selecione várias conversas e escolha a ação</small>')
    const fields = el('div', 'badoo-bulk-fields')
    const acao = el('select', 'field badoo-bulk-action')
    acao.dataset.badooBulkAction = 'true'
    acao.innerHTML = [
      ['ia_on', 'Ligar IA'],
      ['ia_off', 'Desligar IA'],
      ['pedido_on', 'Agendar pedido 1x'],
      ['pedido_off', 'Cancelar pedido 1x'],
    ].map(([v, label]) => `<option value="${v}">${esc(label)}</option>`).join('')
    acao.value = BADOO.bulkAction
    acao.addEventListener('change', async () => {
      BADOO.bulkAction = acao.value || 'ia_on'
      if (badooBulkNeedsAction()) await ensureBadooNeedOptions()
      refreshBadooBulkUi()
    })
    fields.appendChild(acao)
    const necessidade = el('select', 'field badoo-bulk-need')
    necessidade.dataset.badooBulkNeed = 'true'
    necessidade.hidden = !badooBulkNeedsAction()
    necessidade.addEventListener('change', () => { BADOO.bulkNeedId = necessidade.value || '' })
    fields.appendChild(necessidade)
    const apply = el('button', 'opener-bulk-send', '')
    apply.type = 'button'
    apply.dataset.badooBulkApply = 'true'
    apply.addEventListener('click', () => { void runBadooBulkAction(apply) })
    bar.append(selectAll, hint, fields, apply)
    requestAnimationFrame(() => refreshBadooBulkUi())
    if (badooBulkNeedsAction()) void ensureBadooNeedOptions()
    return bar
  }

  function refreshBadooBulkUi() {
    const visiveis = BADOO.visibleChats || []
    const visibleIds = new Set(visiveis.map((c) => c.chatId))
    for (const control of $$('[data-badoo-chat-id]')) {
      const selected = BADOO.selected.has(control.dataset.badooChatId)
      const button = $('.badoo-select', control)
      if (button) button.setAttribute('aria-pressed', String(selected))
      const item = control.closest('.wc-item')
      if (item) item.classList.toggle('selected', selected)
    }
    const selectedVisible = [...BADOO.selected].filter((id) => visibleIds.has(id))
    const allSelected = visibleIds.size > 0 && selectedVisible.length === visibleIds.size
    const selectAll = $('[data-badoo-bulk-select-all]')
    if (selectAll) {
      selectAll.setAttribute('aria-pressed', String(allSelected))
      selectAll.innerHTML = `${icon('i-check', 'ico ico-sm')} ${allSelected ? 'Desmarcar todas' : 'Selecionar todas'}`
    }
    const acao = $('[data-badoo-bulk-action]')
    if (acao && acao.value !== BADOO.bulkAction) acao.value = BADOO.bulkAction
    const need = $('[data-badoo-bulk-need]')
    const usaNeed = badooBulkNeedsAction()
    if (need) {
      need.hidden = !usaNeed
      need.disabled = !usaNeed || !!BADOO.needPromise || !(BADOO.needOptions || []).length
      if (!usaNeed) {
        need.innerHTML = ''
      } else if (BADOO.needPromise && !BADOO.needOptions) {
        need.innerHTML = '<option value="">Carregando necessidades…</option>'
      } else if (!(BADOO.needOptions || []).length) {
        need.innerHTML = '<option value="">Nenhuma necessidade aberta</option>'
      } else {
        need.innerHTML = BADOO.needOptions.map((n) => `<option value="${esc(n.id)}">${esc(n.label)}</option>`).join('')
        if (!BADOO.bulkNeedId || !BADOO.needOptions.some((n) => n.id === BADOO.bulkNeedId)) BADOO.bulkNeedId = BADOO.needOptions[0]?.id || ''
        need.value = BADOO.bulkNeedId
      }
    }
    const apply = $('[data-badoo-bulk-apply]')
    if (apply) {
      const total = selectedVisible.length
      const semNecessidade = usaNeed && !BADOO.bulkNeedId
      apply.disabled = total === 0 || semNecessidade || !!BADOO.needPromise
      apply.innerHTML = `${icon(BADOO.bulkAction === 'ia_off' ? 'i-x' : BADOO.bulkAction.startsWith('pedido_') ? 'i-send' : 'i-bot', 'ico ico-sm')} ${badooBulkActionLabel(BADOO.bulkAction, total || 0)}`
    }
  }

  async function runBadooBulkAction(trigger) {
    const selecionadas = badooBulkSelection()
    if (!selecionadas.length) return
    const action = BADOO.bulkAction || 'ia_on'
    const precisaNecessidade = badooBulkNeedsAction(action)
    const necessidadeId = BADOO.bulkNeedId
    if (precisaNecessidade && !necessidadeId) { toast('Escolha a necessidade primeiro', 'err'); return }
    const original = trigger?.innerHTML
    if (trigger) { trigger.disabled = true; trigger.innerHTML = '<span class="spin"></span><span>Aplicando…</span>' }
    let ok = 0
    let falhas = 0
    let detalheFalha = ''
    for (const chat of selecionadas) {
      let r = null
      if (action === 'ia_off') {
        r = await api('/api/badoo/ia', { method: 'POST', body: JSON.stringify({ chatId: chat.chatId, enable: false }), silencioso: true })
      } else if (action === 'pedido_on') {
        r = await api('/api/necessidades/pedido', { method: 'POST', body: JSON.stringify({ id: necessidadeId, personId: chat.personId, acao: 'agendar' }), silencioso: true })
      } else if (action === 'pedido_off') {
        r = await api('/api/necessidades/pedido', { method: 'POST', body: JSON.stringify({ id: necessidadeId, personId: chat.personId, acao: 'cancelar' }), silencioso: true })
      } else {
        r = await api('/api/badoo/ia', { method: 'POST', body: JSON.stringify({ chatId: chat.chatId, enable: true }), silencioso: true })
      }
      if (r && r.ok) {
        ok++
        if (action === 'ia_on' || action === 'ia_off') {
          const ligado = action === 'ia_on'
          const alvo = (BADOO.chats || []).find((c) => c.chatId === chat.chatId)
          if (alvo) alvo.aiOn = ligado
          if (BADOO.chat && BADOO.chat.chatId === chat.chatId) BADOO.chat.aiOn = ligado
        }
      } else {
        falhas++
        if (!detalheFalha) detalheFalha = chat.nome || chat.chatId
      }
    }
    for (const chat of selecionadas) BADOO.selected.delete(chat.chatId)
    refreshBadooBulkUi()
    if (trigger?.isConnected) trigger.innerHTML = original
    if (trigger?.isConnected) trigger.disabled = false
    if (ok) {
      const base = action === 'ia_off'
        ? (ok === 1 ? 'IA desligada em 1 conversa' : `IA desligada em ${ok} conversas`)
        : action === 'pedido_on'
          ? (ok === 1 ? 'Pedido 1x agendado em 1 conversa' : `Pedido 1x agendado em ${ok} conversas`)
          : action === 'pedido_off'
            ? (ok === 1 ? 'Pedido 1x cancelado em 1 conversa' : `Pedido 1x cancelado em ${ok} conversas`)
            : (ok === 1 ? 'IA ligada em 1 conversa' : `IA ligada em ${ok} conversas`)
      toast(falhas ? `${base} · ${falhas} falharam${detalheFalha ? ` (${detalheFalha})` : ''}` : base, falhas ? 'warn' : 'ok')
    } else {
      toast(action.startsWith('pedido_') ? 'Nenhuma conversa aceitou a ação escolhida' : 'Nenhuma conversa foi atualizada', 'err')
    }
    await loadBadooChats()
    if (BADOO.openId) {
      const head = $('#badooAiToggle')
      if (head && BADOO.chat) head.setAttribute('aria-checked', String(!!BADOO.chat.aiOn))
    }
  }

  // ---------- lista (GET /api/badoo/chats) ----------
  async function loadBadooChats() {
    if (!$('#badooListScroll')) return
    const chats = await api('/api/badoo/chats')
    if (!$('#badooListScroll')) return
    BADOO.chats = Array.isArray(chats) ? chats : []
    renderBadooChats()
  }

  function renderBadooChats() {
    const host = $('#badooListScroll')
    const cnt = $('#badooCnt')
    if (!host) return
    const chats = BADOO.chats || []
    // Sem prévia = ninguém falou nada ainda (o Badoo lista até quem só te curtiu). A lista
    // mostra conversa; quem nunca trocou mensagem só polui.
    const comConversa = chats.filter((c) => (c.previa || c.mensagens) && passaFiltroIa(c.aiOn, BADOO.filtroIa))
    const shown = BADOO.query
      ? comConversa.filter((c) => norm(`${c.nome || ''} ${c.previa || ''}`).includes(norm(BADOO.query)))
      : comConversa
    if (cnt) cnt.textContent = String(shown.length)
    if (!comConversa.length) {
      const temAlguma = chats.some((c) => c.previa || c.mensagens)
      host.replaceChildren(temAlguma
        ? emptyState('i-bot', BADOO.filtroIa === 'on' ? 'A IA não está ligada em nenhuma' : 'A IA está ligada em todas',
          BADOO.filtroIa === 'on' ? 'Nenhuma conversa do Badoo tem a IA respondendo agora.' : 'Todas as conversas daqui estão com a IA ligada.')
        : emptyState('i-badoo', 'Nenhuma conversa ainda',
          'As conversas aparecem aqui depois de sincronizar. Se acabou de importar a sessão, toque em "Sincronizar agora".'))
      BADOO.visibleChats = []
      refreshBadooBulkUi()
      return
    }
    if (!shown.length) {
      host.replaceChildren(emptyState('i-search', 'Nada encontrado', `Nenhuma conversa corresponde a “${BADOO.query}”.`))
      BADOO.visibleChats = []
      refreshBadooBulkUi()
      return
    }
    const sorted = shown.slice().sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
    BADOO.visibleChats = sorted
    const list = el('div', 'wc-items')
    const bulk = badooBulkToolbar()
    if (bulk) list.appendChild(bulk)
    sorted.forEach((c) => list.appendChild(badooChatListItem(c)))
    // não repinta o igual, e o scroll é de quem está lendo (avisos de fundo chegam o tempo
    // todo; sem isso a lista pula pro topo sozinha no meio da leitura)
    if (!mudou('badoo', shown.map((c) => [c.chatId, c.lastTs, c.lastText, c.aiOn, c.unread, ...metricasNomeKey(c.metricas)])) && !listaVazia(host)) {
      refreshBadooBulkUi()
      return
    }
    const rolagem = host.scrollTop
    host.replaceChildren(list)
    if (rolagem) host.scrollTop = rolagem
    refreshBadooBulkUi()
  }

  function badooChatListItem(c) {
    const item = el('div', 'wc-item' + (BADOO.openId === c.chatId ? ' active' : ''))
    item.setAttribute('role', 'button')
    item.setAttribute('tabindex', '0')
    item.dataset.cid = c.chatId
    const title = c.nome || 'contato'
    const preview = c.previa ? esc(c.previa) : '<i class="mute">sem mensagens</i>'
    const when = c.lastTs ? timeAgo(c.lastTs) : ''
    item.innerHTML = `
      ${avatarHtml(title, c.foto)}
      <div class="wc-item-main">
        <div class="wc-item-top">
          <span class="wc-nm">${esc(title)}</span>
          ${metricasNomeHtml(c.metricas)}
          ${when ? `<span class="wc-when">${esc(when)}</span>` : ''}
        </div>
        <div class="wc-item-bot">
          <span class="wc-prev">${preview}</span>
          <span class="wc-flags">${c.naoLida ? '<span class="wc-unread ig">1</span>' : ''}</span>
        </div>
      </div>
      <div class="badoo-item-actions" data-badoo-chat-id="${esc(c.chatId)}">
        <button class="opener-select badoo-select" type="button" aria-pressed="${BADOO.selected.has(c.chatId) ? 'true' : 'false'}" aria-label="Selecionar ${esc(title)} para ação em lote" title="Selecionar para ação em lote">${icon('i-check', 'ico ico-sm')}</button>
        <div class="wc-item-ai-wrap">
          <span class="wc-item-ai-lbl">${icon('i-bot', 'ico ico-sm')}<span class="wc-item-ai-text">IA</span></span>
          <button class="toggle sm wc-item-ai" role="switch" aria-checked="${c.aiOn ? 'true' : 'false'}" aria-label="IA responde nesta conversa" title="IA responde nesta conversa" data-ai-cid="${esc(c.chatId)}"></button>
        </div>
      </div>`
    const select = item.querySelector('.badoo-select')
    select.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      setBadooSelected(c.chatId, !BADOO.selected.has(c.chatId))
    })
    const tg = item.querySelector('.wc-item-ai')
    tg.addEventListener('click', (e) => { e.stopPropagation(); badooToggleAi(c.chatId, tg.getAttribute('aria-checked') !== 'true', tg) })
    tg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); badooToggleAi(c.chatId, tg.getAttribute('aria-checked') !== 'true', tg) }
    })
    item.addEventListener('click', () => badooOpenThread(c.chatId))
    item.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === item) { e.preventDefault(); badooOpenThread(c.chatId) }
    })
    return item
  }

  // ---------- conversa (GET /api/badoo/conversa) ----------
  async function badooOpenThread(cid) {
    BADOO.openId = cid
    $$('#badooListScroll .wc-item').forEach((it) => it.classList.toggle('active', it.dataset.cid === cid))
    const wrap = $('#badooClient'); if (wrap) wrap.classList.add('thread-open')
    const cached = (BADOO.chats || []).find((c) => c.chatId === cid)
    badooRenderThreadShell(cached || { chatId: cid, nome: 'Badoo' }, true)
    // vivo=1: ao ABRIR vale a navegação, pra thread nascer em dia com o site
    const chat = await api(`/api/badoo/conversa?vivo=1&chatId=${encodeURIComponent(cid)}`)
    if (BADOO.openId !== cid) return
    if (!chat) {
      const t = $('#badooThread')
      if (t) t.replaceChildren(badooThreadHeader(cached || { chatId: cid }), emptyState('i-x', 'Não deu pra abrir', 'O vendas-multicanal não devolveu esta conversa. Tente de novo em instantes.'))
      return
    }
    BADOO.chat = chat
    badooRenderThread(chat)
    startBadooThreadPoll()
  }

  function badooBackToList() {
    BADOO.openId = null; BADOO.chat = null
    stopBadooThreadPoll()
    const wrap = $('#badooClient'); if (wrap) wrap.classList.remove('thread-open')
    $$('#badooListScroll .wc-item').forEach((it) => it.classList.remove('active'))
    const t = $('#badooThread')
    if (t) {
      const empty = el('div', 'wc-thread-empty')
      empty.id = 'badooThreadEmpty'
      empty.innerHTML = `${icon('i-badoo', 'ico ico-lg')}<h3>Escolha uma conversa</h3><p>Toque numa pessoa à esquerda pra abrir o histórico e responder.</p>`
      t.replaceChildren(empty)
    }
  }

  function badooThreadHeader(chat) {
    const head = el('div', 'wc-thread-head')
    const title = chat.nome || 'contato'
    head.innerHTML = `
      <button class="icon-btn wc-back" id="badooBack" title="Voltar" aria-label="Voltar">${icon('i-arrow-l', 'ico')}</button>
      ${avatarHtml(title, chat.foto, 'wc-av wc-av-head')}
      <div class="wc-head-id">
        <div class="wc-head-nm"><span class="wc-head-person">${esc(title)}</span>${metricasNomeHtml(chat.metricas)}</div>
        <div class="wc-head-ph">Badoo</div>
      </div>
      <button class="btn ghost small wc-ident" id="badooIdent" type="button" title="Quem é essa pessoa em cada rede">${icon('i-link', 'ico ico-sm')}<span class="lbl">Mesma pessoa</span></button>
      <button class="btn ghost small wc-entregar" id="badooEntregar" type="button" aria-haspopup="menu" aria-expanded="false" title="Entregar um serviço para esta pessoa">${icon('i-send', 'ico ico-sm')}<span class="lbl">Entregar</span></button>
      <div class="wc-head-toggles">
        <div class="wc-head-toggle wc-ai-toggle">
          <span class="wc-head-toggle-lbl">${icon('i-bot', 'ico ico-sm')} IA responde</span>
          <button class="toggle sm" role="switch" aria-checked="${chat.aiOn ? 'true' : 'false'}" aria-label="IA responde nesta conversa" id="badooAiToggle"></button>
        </div>
        <div class="wc-head-toggle wc-cobr-toggle">
          <span class="wc-head-toggle-lbl">${icon('i-card', 'ico ico-sm')} Pode cobrar</span>
          <button class="toggle sm" role="switch" aria-checked="false" aria-label="Pode cobrar nesta conversa" id="badooCobrToggle"></button>
        </div>
      </div>`
    head.querySelector('#badooBack').addEventListener('click', badooBackToList)
    const ident = head.querySelector('#badooIdent')
    if (ident && chat.personId) ident.addEventListener('click', () => abrirIdentidade(chat.personId, () => badooOpenThread(chat.chatId)))
    const btEntregar = head.querySelector('#badooEntregar')
    if (btEntregar) btEntregar.addEventListener('click', (e) => {
      e.stopPropagation()
      abrirEntregaPop(btEntregar, { personId: chat.personId || `b:${chat.chatId}`, canal: 'badoo', chatId: chat.chatId })
    })
    const tg = head.querySelector('#badooAiToggle')
    tg.addEventListener('click', () => badooToggleAi(chat.chatId, tg.getAttribute('aria-checked') !== 'true', tg))
    wireCobrancaHeadToggle(head.querySelector('#badooCobrToggle'), chat.personId || (chat.chatId ? `b:${chat.chatId}` : ''), 'Badoo', title)
    return head
  }

  function badooRenderThreadShell(chat, loading) {
    const t = $('#badooThread')
    if (!t) return
    const body = el('div', 'wc-msgs')
    body.id = 'badooMsgs'
    if (loading) body.appendChild(el('div', 'wc-thread-empty small', `<span class="spin"></span><p>abrindo conversa…</p>`))
    t.replaceChildren(badooThreadHeader(chat), body)
  }

  function badooRenderThread(chat) {
    const t = $('#badooThread')
    if (!t) return
    t.replaceChildren(badooThreadHeader(chat), saudeFaixa(chat.personId, 'badoo'), badooThreadMessages(chat), badooThreadComposer(chat))
    badooScrollToEnd()
  }

  function badooThreadMessages(chat) {
    const wrap = el('div', 'wc-msgs')
    wrap.id = 'badooMsgs'
    const msgs = chat.messages || []
    if (!msgs.length) {
      wrap.appendChild(el('div', 'wc-thread-empty small', `${icon('i-badoo', 'ico')}<p>Sem mensagens carregadas — as novas aparecem aqui.</p>`))
      return wrap
    }
    let lastDay = null
    msgs.forEach((m) => {
      const dk = dayKey(m.ts)
      if (dk && dk !== lastDay) { wrap.appendChild(el('div', 'day-sep', esc(dk))); lastDay = dk }
      wrap.appendChild(bubbleFor(m))
    })
    return wrap
  }

  function badooThreadComposer(chat) {
    const comp = el('div', 'wc-composer')
    comp.innerHTML = `
      <textarea class="draft" id="badooDraft" placeholder="Escreva uma mensagem…" rows="1"></textarea>
      <div class="wc-comp-actions">
        <button class="btn ghost wc-audio-trigger" id="badooAudio" title="Mandar um áudio salvo" aria-label="Mandar um áudio salvo">${icon('i-play', 'ico')}<span class="lbl">Áudio</span></button>
        <button class="btn gen" id="badooGen" title="Gerar rascunho com IA">${icon('i-spark', 'ico')}<span class="lbl">Gerar com IA</span></button>
        <button class="btn send" id="badooSendBtn" disabled title="Enviar">${icon('i-send', 'ico')}<span class="lbl">Enviar</span></button>
      </div>`
    const draft = comp.querySelector('#badooDraft')
    const btnSend = comp.querySelector('#badooSendBtn')
    const btnGen = comp.querySelector('#badooGen')
    const btnAudio = comp.querySelector('#badooAudio')
    const grow = () => { draft.style.height = 'auto'; draft.style.height = Math.min(draft.scrollHeight, 140) + 'px' }
    draft.addEventListener('input', () => { btnSend.disabled = !draft.value.trim(); grow() })
    draft.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (draft.value.trim()) badooSendMsg(chat.chatId, draft, btnSend) }
    })
    btnGen.addEventListener('click', () => badooGenerateDraft(chat.chatId, btnGen, draft, btnSend))
    btnSend.addEventListener('click', () => badooSendMsg(chat.chatId, draft, btnSend))
    btnAudio.addEventListener('click', () => badooOpenAudioPicker(chat.chatId, comp, btnAudio))
    return comp
  }

  function badooScrollToEnd() {
    requestAnimationFrame(() => { const m = $('#badooMsgs'); if (m) m.scrollTop = m.scrollHeight })
  }

  // ---------- ações ----------
  async function badooToggleAi(cid, next, tg) {
    tg.setAttribute('aria-checked', String(next))
    const r = await post('/api/badoo/ia', { chatId: cid, enable: next })
    if (!r || !r.ok) { tg.setAttribute('aria-checked', String(!next)); toast('Não deu pra mudar a IA', 'err'); return }
    const listed = (BADOO.chats || []).find((c) => c.chatId === cid)
    if (listed) listed.aiOn = next
    if (BADOO.chat && BADOO.chat.chatId === cid) BADOO.chat.aiOn = next
    $$(`#badooListScroll [data-ai-cid="${CSS.escape(cid)}"]`).forEach((b) => b.setAttribute('aria-checked', String(next)))
    const head = $('#badooAiToggle'); if (head && BADOO.openId === cid) head.setAttribute('aria-checked', String(next))
    toast(next ? 'IA vai responder essa conversa' : 'IA desligada nessa conversa', 'ok')
  }

  async function badooGenerateDraft(cid, btnGen, draft, btnSend) {
    const original = btnGen.innerHTML
    btnGen.disabled = true
    btnGen.innerHTML = `<span class="spin"></span><span class="lbl">Gerando…</span>`
    const r = await gerarRascunho('/api/badoo/gerar', { chatId: cid })
    btnGen.disabled = false
    btnGen.innerHTML = original
    if (!r || !r.ok || !r.draft) { toast('Não deu pra gerar o rascunho', 'err'); return }
    draft.value = r.draft
    draft.dispatchEvent(new Event('input'))
    draft.focus()
  }

  async function badooSendMsg(cid, draft, btnSend) {
    const text = draft.value.trim()
    if (!text) return
    BADOO.sending = true
    btnSend.disabled = true
    draft.value = ''
    draft.style.height = 'auto'
    const tempId = 'tmp-' + Date.now()
    const temp = { id: tempId, dir: 'out', text, ts: Date.now(), pending: true }
    if (BADOO.chat && BADOO.chat.chatId === cid) (BADOO.chat.messages = BADOO.chat.messages || []).push(temp)
    const msgsHost = $('#badooMsgs')
    if (msgsHost) {
      const emptyBox = msgsHost.querySelector('.wc-thread-empty')
      if (emptyBox) emptyBox.remove()
      msgsHost.appendChild(bubbleFor(temp))
      badooScrollToEnd()
    }
    // demora de propósito: o servidor digita no site e confere se a mensagem voltou
    const r = await post('/api/badoo/enviar', { chatId: cid, texto: text })
    BADOO.sending = false
    const rowEl = msgsHost ? msgsHost.querySelector(`[data-mid="${CSS.escape(tempId)}"]`) : null
    if (!r || !r.ok) {
      if (rowEl) rowEl.replaceWith(bubbleFor({ id: tempId, dir: 'out', text, ts: temp.ts, failed: true }))
      if (BADOO.chat && BADOO.chat.messages) { const mm = BADOO.chat.messages.find((x) => x.id === tempId); if (mm) { mm.pending = false; mm.failed = true } }
      draft.value = text
      btnSend.disabled = false
      toast('Falha ao enviar', 'err')
      return
    }
    if (!r.comprovado) toast('Enviado, mas sem comprovante — confira na conversa', 'warn')
    const chat = await api(`/api/badoo/conversa?chatId=${encodeURIComponent(cid)}`)
    if (chat && BADOO.openId === cid) { BADOO.chat = chat; badooRefreshThreadMessages(chat) }
    loadBadooChats()
    badooScrollToEnd()
  }

  // Áudios salvos também são notas de voz reais no Badoo. O picker é separado do WhatsApp
  // porque cada rede envia pela própria rota, mas reaproveita a mesma biblioteca e a mesma
  // aparência: uma escolha, um clique, e o backend só devolve sucesso com o recibo do Badoo.
  async function badooOpenAudioPicker(cid, comp, trigger) {
    const audios = await loadSavedAudios()
    const old = comp.querySelector('.wc-audio-pop')
    if (old) { old.remove(); return }
    const root = el('div', 'wc-audio-pop')
    const menu = el('div', 'wc-audio-menu')
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', 'Áudios salvos')
    const list = el('div', 'wc-audio-list')
    menu.append(el('div', 'wc-audio-head', `${icon('i-play', 'ico ico-sm')}<span>Áudios salvos</span>`), list)
    root.appendChild(menu); comp.appendChild(root)
    if (!audios.length) {
      list.appendChild(el('div', 'wc-audio-empty', `<b>nenhum áudio salvo ainda</b><small>grave em Config &rsaquo; Áudios salvos</small>`))
      return
    }
    for (const a of audios) {
      const opt = el('button', 'wc-audio-opt')
      opt.type = 'button'
      opt.innerHTML = `
        <span class="wc-audio-opt-play">${icon('i-play', 'ico ico-sm')}</span>
        <span class="wc-audio-opt-body">
          <span class="wc-audio-opt-top"><b>${esc(a.title || a.shortcut)}</b><span class="wc-audio-opt-dur">${fmtAudioDur(a.dur)}</span></span>
          <span class="wc-audio-opt-sub">/${esc(a.shortcut)}${a.descricao ? ` · ${esc(a.descricao)}` : ''}</span>
        </span>`
      opt.addEventListener('click', () => badooSendAudio(cid, a, root, trigger))
      list.appendChild(opt)
    }
  }

  async function badooSendAudio(cid, audio, picker, trigger) {
    picker.remove(); trigger.disabled = true
    const original = trigger.innerHTML
    trigger.innerHTML = `<span class="spin"></span><span class="lbl">Enviando…</span>`
    const r = await post('/api/badoo/enviar-audio', { chatId: cid, audioId: audio.id })
    trigger.disabled = false; trigger.innerHTML = original
    if (!r || !r.ok) { toast(r?.error || 'Falha ao enviar o áudio', 'err'); return }
    toast(`Áudio enviado: ${audio.title || audio.shortcut}`)
    const chat = await api(`/api/badoo/conversa?chatId=${encodeURIComponent(cid)}`)
    if (chat && BADOO.openId === cid) { BADOO.chat = chat; badooRefreshThreadMessages(chat); badooScrollToEnd() }
    loadBadooChats()
  }

  function badooRefreshThreadMessages(chat) {
    const t = $('#badooThread'); if (!t) return
    atualizarMetricasNoCabecalho('#badooThread', chat.metricas)
    const old = $('#badooMsgs'); if (!old) return
    trocarBolhas(old, badooThreadMessages(chat), badooScrollToEnd)
  }

  // ---------- polling (só na aba Badoo; lê o banco, não navega) ----------
  function startBadooListPoll() {
    stopBadooListPoll()
    BADOO.listTimer = setInterval(() => { if (S.tab === 'badoo' && $('#badooListScroll')) loadBadooChats() }, 15000)
  }
  function stopBadooListPoll() { if (BADOO.listTimer) { clearInterval(BADOO.listTimer); BADOO.listTimer = null } }
  function startBadooThreadPoll() {
    stopBadooThreadPoll()
    BADOO.threadTimer = setInterval(async () => {
      if (S.tab !== 'badoo' || !BADOO.openId) { stopBadooThreadPoll(); return }
      if (BADOO.sending) return
      const cid = BADOO.openId
      const chat = await api(`/api/badoo/conversa?chatId=${encodeURIComponent(cid)}`)
      if (!chat || BADOO.openId !== cid || BADOO.sending) return
      BADOO.chat = chat
      badooRefreshThreadMessages(chat)
    }, 8000)
  }
  function stopBadooThreadPoll() { if (BADOO.threadTimer) { clearInterval(BADOO.threadTimer); BADOO.threadTimer = null } }
  function stopBadooPolling() { stopBadooListPoll(); stopBadooThreadPoll() }

  // ---------- Curtidas do Badoo: quem já te curtiu ----------
  // Vale mais que o baralho: curtir de volta aqui é match na hora, e esta fila não depende da
  // cota diária de curtidas (em 26/07 o baralho de Encontros veio VAZIO e esta tinha 17).
  // A grade do Badoo só entrega a FOTO — nome e idade exigem abrir o perfil, e é por isso que
  // "Ver perfil" é um botão e não um dado que já vem na lista.
  async function abrirCurtidasBadoo() {
    const host = $('#badooHost')
    if (!host) return
    stopBadooPolling()
    host.replaceChildren(el('div', 'wc-loading', `${icon('i-heart', 'ico')}<span>abrindo a fila de curtidas…</span>`))
    const d = await api('/api/badoo/curtidas')
    if (!$('#badooHost')) return
    if (!d || d.error) { host.replaceChildren(emptyState('i-x', 'Não deu pra abrir', (d && d.error) || 'O Badoo não devolveu a fila agora.')); return }
    renderCurtidasBadoo(d)
  }

  function renderCurtidasBadoo(d) {
    const host = $('#badooHost')
    const wrap = el('div', 'bcu')
    const e = d.estado || {}
    wrap.innerHTML = `
      <div class="bcu-head">
        <button class="icon-btn" id="bcuVoltar" title="Voltar pras conversas" aria-label="Voltar">${icon('i-arrow-l', 'ico')}</button>
        <div class="bcu-tit"><b>${d.fila.length} já te curtiram</b><small>curtir de volta aqui vira match na hora</small></div>
        <button class="btn ghost small" id="bcuRecarregar">${icon('i-sync', 'ico ico-sm')} Recarregar</button>
      </div>
      <div class="bcu-auto">
        <label class="vinc-autoriza"><span>curtir sozinho</span><button type="button" class="toggle sm" id="bcuLigado" role="switch" aria-checked="${e.ligado ? 'true' : 'false'}" aria-label="Deixar o vendas-multicanal curtir sozinho"></button></label>
        <label class="vinc-autoriza"><span>modo sombra</span><button type="button" class="toggle sm" id="bcuSombra" role="switch" aria-checked="${e.sombra ? 'true' : 'false'}" aria-label="Modo sombra: decide e não clica"></button></label>
        <button class="btn ghost small" id="bcuRodar">${icon('i-spark', 'ico ico-sm')} Julgar a fila agora</button>
        <p class="bcu-nota">Em <b>modo sombra</b> ele decide e não clica em ninguém — é assim que se confere o critério antes de gastar uma curtida, que não volta. Os critérios são os mesmos do Tinder.</p>
      </div>
      <div class="bcu-travado">${icon('i-x', 'ico ico-sm')}
        <div><b>Os nomes vieram; os rostos não</b>
        <small>Nome, id e contagem de fotos saem do protocolo do Badoo, não da tela — por isso aparecem aqui. Já a <b>foto o servidor de imagem deles entrega borrada</b> enquanto a conta está sem cota de curtidas, e o clique no cartão devolve pra "você já não tem mais curtidas". Rosto só quando a cota renovar ou com Premium.</small></div></div>
      <div class="bcu-grade" id="bcuGrade"></div>
      <div id="bcuSaida"></div>`
    host.replaceChildren(wrap)
    wrap.querySelector('#bcuVoltar').addEventListener('click', () => loadBadoo())
    wrap.querySelector('#bcuRecarregar').addEventListener('click', abrirCurtidasBadoo)
    const mexer = async (btn, campo) => {
      const v = btn.getAttribute('aria-checked') !== 'true'
      btn.setAttribute('aria-checked', String(v))
      const r = await post('/api/badoo/curtidas/config', { [campo]: v })
      if (!r) { btn.setAttribute('aria-checked', String(!v)); toast('Não deu pra mudar', 'err'); return }
      toast(campo === 'ligado' ? (v ? 'Vou curtir sozinho nessa fila' : 'Parei de curtir sozinho')
        : (v ? 'Modo sombra: decide e não clica' : 'Fora da sombra: os cliques valem'))
    }
    wrap.querySelector('#bcuLigado').addEventListener('click', (ev) => mexer(ev.currentTarget, 'ligado'))
    wrap.querySelector('#bcuSombra').addEventListener('click', (ev) => mexer(ev.currentTarget, 'sombra'))
    wrap.querySelector('#bcuRodar').addEventListener('click', async (ev) => {
      const b = ev.currentTarget; b.disabled = true; b.innerHTML = `<span class="spin"></span> Julgando…`
      const r = await post('/api/badoo/curtidas/rodar', { max: 20, sombra: true })
      b.disabled = false; b.innerHTML = `${icon('i-spark', 'ico ico-sm')} Julgar a fila agora`
      const saida = $('#bcuSaida')
      if (!r || r.error) { toast((r && r.error) || 'Não deu', 'err'); return }
      saida.replaceChildren(el('div', 'bcu-decisoes', `<b>${r.decisoes.length} decisões (sombra, ninguém foi curtido)</b>` +
        r.decisoes.map((x) => `<div class="bcu-dec"><span class="bcu-dec-${x.decisao}">${x.decisao === 'like' ? 'curtir' : 'passar'}</span> perfil ${x.indice}${x.nome && x.nome !== '⏰' ? ' · ' + esc(x.nome) : ''} <small>${esc(x.motivo || '')}</small></div>`).join('')))
    })

    const grade = wrap.querySelector('#bcuGrade')
    d.fila.forEach((c) => grade.appendChild(cartaoCurtida(c)))
  }

  function cartaoCurtida(c) {
    const card = el('article', 'bcu-card')
    card.innerHTML = `
      <div class="bcu-foto">${c.foto ? `<img src="${esc(c.foto)}" alt="" loading="lazy">` : `<span class="bcu-sem-foto">${icon('i-users', 'ico')}</span>`}
        <span class="bcu-num">${c.indice}</span></div>
      <div class="bcu-info" data-info>${c.nome
        ? `<b>${esc(c.nome)}${c.idade ? ', ' + c.idade : ''}</b><small>${c.quantasFotos || 1} foto${(c.quantasFotos || 1) === 1 ? '' : 's'}${c.curtiuVoce ? ' · curtiu você' : ''}</small>`
        : '<small>a grade não deu o nome — abra o perfil</small>'}</div>
      <div class="bcu-acoes">
        <button class="btn ghost small" data-ver>Ver perfil</button>
        <button class="btn small" data-like>${icon('i-heart', 'ico ico-sm')} Curtir</button>
        <button class="btn ghost small" data-pass>Passar</button>
      </div>`
    card.querySelector('[data-ver]').addEventListener('click', async (ev) => {
      const b = ev.currentTarget; b.disabled = true; b.textContent = 'Abrindo…'
      const r = await post('/api/badoo/curtidas/perfil', { indice: c.indice })
      b.disabled = false; b.textContent = 'Ver perfil'
      const info = card.querySelector('[data-info]')
      if (!r || r.erro || r.error) { toast((r && (r.erro || r.error)) || 'Não deu pra abrir', 'err'); return }
      info.innerHTML = `<b>${esc(r.nome || 'sem nome')}${r.idade ? ', ' + r.idade : ''}</b>${r.cidade ? `<small>${esc(r.cidade)}</small>` : ''}<small class="bcu-bio">${esc((r.texto || '').slice(0, 220))}</small>`
    })
    const agir = async (ev, acao) => {
      const b = ev.currentTarget; b.disabled = true
      const r = await post('/api/badoo/curtidas/acao', { indice: c.indice, acao })
      if (r && r.ok) { toast(acao === 'like' ? 'Curtida enviada' : 'Passou'); abrirCurtidasBadoo() }
      else { b.disabled = false; toast((r && (r.motivo || r.error)) || 'Não deu', 'err') }
    }
    card.querySelector('[data-like]').addEventListener('click', (ev) => agir(ev, 'like'))
    card.querySelector('[data-pass]').addEventListener('click', (ev) => agir(ev, 'pass'))
    return card
  }

  // WS: o servidor avisou que algo mudou — refaz a lista e a conversa aberta.
  function badooHandleWsRefresh() {
    if (S.tab !== 'badoo' || !$('#badooListScroll')) return
    loadBadooChats()
    if (BADOO.openId && !BADOO.sending) {
      const cid = BADOO.openId
      api(`/api/badoo/conversa?chatId=${encodeURIComponent(cid)}`).then((chat) => {
        if (chat && BADOO.openId === cid && !BADOO.sending) { BADOO.chat = chat; badooRefreshThreadMessages(chat) }
      })
    }
  }

  // ---------------------------------------------------------------- DIÁRIO
  const LOG = { mode: 'highlights' }

  function logEventText(ev) {
    const legacy = ev.text || ev.message || ''
    if (!isMobileLayout()) return legacy
    const labels = {
      auto_sent: 'A IA respondeu',
      auto_draft: 'A IA preparou um rascunho',
      auto_error: 'Falha ao responder com IA',
      auto_skip_dup: 'Resposta duplicada evitada',
      manual_sent: 'Mensagem enviada',
      manual_error: 'Falha no envio manual',
      ai_on: 'IA ativada na conversa',
      ai_off: 'IA desativada na conversa',
      wa_mode: 'Modo de conversa atualizado',
      ig_mode: 'Modo de conversa atualizado',
      bridge_linked: 'Contato do WhatsApp vinculado ao Tinder',
      agenda_proposal: 'Compromisso detectado',
      agenda_event_created: 'Compromisso adicionado à agenda',
      agenda_connected: 'Google Agenda conectada',
      agenda_detect_error: 'Falha ao detectar compromissos',
      wa_audio_transcribed: 'Áudio transcrito',
      wa_repair: 'WhatsApp reiniciado',
      wa_reparear: 'WhatsApp reiniciado',
      ig_sync: 'Instagram sincronizado',
      ig_deep_scan: 'Histórico do Instagram atualizado',
      ig_error: 'Falha na sincronização do Instagram',
      tinder_sync: 'Tinder sincronizado',
      tinder_updates: 'Conversas do Tinder atualizadas',
      boot: 'vendas-multicanal iniciado',
    }
    const label = labels[ev.type] || String(ev.type || 'Atividade').replace(/[_-]+/g, ' ')
    let detail = String(ev.detail || legacy || '').trim()
    if (/you.ve hit your usage limit|usage limit/i.test(detail)) detail = 'limite de uso da IA atingido'
    else if (/opera[cç][aã]o .+ excedeu \d+s/i.test(detail)) detail = 'tempo limite excedido'
    else if (ev.type === 'wa_reparear' && /reset solicitado/i.test(detail)) detail = 'novo pareamento solicitado'
    if (ev.type === 'agenda_proposal') {
      const proposal = detail.match(/^(.+?)\s+@\s+(\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?)$/)
      const proposalMs = proposal ? Date.parse(proposal[2]) : NaN
      if (proposal && Number.isFinite(proposalMs)) detail = `${proposal[1]} · ${fmtWhen(proposalMs, false)}`
    }
    if (!detail || detail === '{}' || detail === label) return label
    return `${label} · ${detail}`
  }

  async function loadLog() {
    const host = $('#logHost')
    if (!host.dataset.loaded) host.replaceChildren(el('div', 'empty', `${icon('i-book', 'ico')}<h3>carregando…</h3>`))
    const log = await api('/api/log')
    host.dataset.loaded = '1'
    if (log == null || !Array.isArray(log)) {
      host.replaceChildren(emptyState('i-book', 'Sem atividade ainda', 'Cada coisa que o vendas-multicanal fizer — resposta enviada, IA ligada, vínculo confirmado — vai aparecer aqui em ordem.'))
      return
    }
    if (!log.length) {
      host.replaceChildren(emptyState('i-book', 'Sem atividade ainda', 'Cada coisa que o vendas-multicanal fizer — resposta enviada, IA ligada, vínculo confirmado — vai aparecer aqui em ordem.'))
      return
    }
    const mobile = isMobileLayout()
    const routineTypes = new Set(['tinder_sync', 'tinder_updates', 'boot', 'ig_sync', 'ig_deep_scan'])
    let visibleLog = log
    if (mobile && LOG.mode === 'highlights') {
      visibleLog = log.filter((ev) => {
        const type = String(ev.type || '').toLowerCase()
        return !routineTypes.has(type) || type.includes('error')
      })
      if (!visibleLog.length) visibleLog = log.slice(0, 8)
      const grouped = new Map()
      visibleLog.forEach((ev) => {
        const key = `${dayKey(ev.ts)}|${String(ev.type || '')}|${logEventText(ev)}`
        const found = grouped.get(key)
        if (found) found._count += 1
        else grouped.set(key, Object.assign({ _count: 1 }, ev))
      })
      visibleLog = Array.from(grouped.values())
    }

    const tl = el('div', 'timeline')
    let lastLogDay = null
    visibleLog.forEach((ev) => {
      if (mobile) {
        const dk = dayKey(ev.ts)
        if (dk && dk !== lastLogDay) {
          tl.appendChild(el('div', 'timeline-day', esc(dk)))
          lastLogDay = dk
        }
      }
      const kind = ev.channel === 'whatsapp' ? 'wa' : ev.channel === 'tinder' ? 'love' : ''
      const item = el('div', `tl-item ${kind}`)
      item.innerHTML = `
        <div class="marker">${icon(ev.channel === 'whatsapp' ? 'i-wa' : ev.channel === 'tinder' ? 'i-heart' : 'i-spark', 'ico')}</div>
        <div class="when">${esc(timeAgo(ev.ts))}${ev.ts ? ' · ' + clockTime(ev.ts) : ''}</div>
        <div class="what">${esc(logEventText(ev))}${ev._count > 1 ? ` <span class="diary-group-count">×${ev._count}</span>` : ''}</div>`
      tl.appendChild(item)
    })

    if (mobile) {
      const toolbar = el('div', 'diary-view-filter', `
        <button type="button" class="${LOG.mode === 'highlights' ? 'active' : ''}" aria-pressed="${LOG.mode === 'highlights'}">Destaques</button>
        <button type="button" class="${LOG.mode === 'all' ? 'active' : ''}" aria-pressed="${LOG.mode === 'all'}">Tudo</button>`)
      toolbar.querySelectorAll('button').forEach((btn, index) => btn.addEventListener('click', () => {
        const next = index === 0 ? 'highlights' : 'all'
        if (next === LOG.mode) return
        LOG.mode = next
        loadLog()
      }))
      host.replaceChildren(toolbar, tl)
    } else {
      host.replaceChildren(tl)
    }
  }

  // ---------------------------------------------------------------- MONITOR (WhatsApp não-mensagens)
  const MON = { timer: null, kind: '', query: '' }
  const MON_KINDS = [
    { k: '', label: 'Tudo', ico: 'i-radar' },
    { k: 'deleted', label: 'Apagadas', ico: 'i-trash' },
    { k: 'edited', label: 'Editadas', ico: 'i-edit' },
    { k: 'reaction', label: 'Reações', ico: 'i-emoji' },
    { k: 'receipt', label: 'Visto', ico: 'i-eye' },
    { k: 'call', label: 'Chamadas', ico: 'i-phone' },
    { k: 'profile_pic', label: 'Perfil', ico: 'i-cam' },
    { k: 'control', label: 'Sistema', ico: 'i-gear' },
  ]
  function monIcon(kind) {
    return ({ deleted: 'i-trash', edited: 'i-edit', reaction: 'i-emoji', receipt: 'i-eye', call: 'i-phone',
      profile_pic: 'i-cam', profile_status: 'i-book', profile_name: 'i-users', control: 'i-bot' })[kind] || 'i-radar'
  }
  function renderMonFilters() {
    const host = $('#monFilters'); if (!host || host.dataset.done) return
    host.dataset.done = '1'
    const search = el('label', 'mobile-search mon-search mobile-only', `${icon('i-search')}<input type="search" inputmode="search" autocomplete="off" placeholder="Buscar atividade" aria-label="Buscar atividade">`)
    search.querySelector('input').addEventListener('input', (e) => { MON.query = e.currentTarget.value.trim(); loadMonitor() })
    host.appendChild(search)
    const rail = el('div', 'mon-chip-rail')
    MON_KINDS.forEach((f) => {
      const chip = el('button', 'chip' + (MON.kind === f.k ? ' active' : ''), `${icon(f.ico, 'ico ico-sm')} ${f.label}`)
      chip.addEventListener('click', () => { MON.kind = f.k; $$('#monFilters .chip').forEach((c) => c.classList.remove('active')); chip.classList.add('active'); loadMonitor() })
      rail.appendChild(chip)
    })
    host.appendChild(rail)
  }
  async function loadMonitor() {
    renderMonFilters()
    const host = $('#monHost'); if (!host) return
    if (!host.dataset.loaded) host.replaceChildren(el('div', 'empty', `${icon('i-radar', 'ico')}<h3>carregando…</h3>`))
    const rows = await api('/api/wa/monitor' + (MON.kind ? `?kind=${encodeURIComponent(MON.kind)}` : ''))
    if (!$('#monHost')) return
    host.dataset.loaded = '1'
    let visibleRows = Array.isArray(rows) ? rows : []
    if (isMobileLayout() && !MON.kind) visibleRows = visibleRows.filter((m) => m.kind !== 'control')
    if (MON.query) visibleRows = visibleRows.filter((m) => norm(`${m.summary || ''} ${m.name || ''} ${m.kind || ''}`).includes(norm(MON.query)))
    if (isMobileLayout()) {
      const grouped = new Map()
      visibleRows.forEach((m) => {
        const key = `${m.kind}|${m.name || ''}|${m.summary || ''}`
        const found = grouped.get(key)
        if (found) found._count += 1
        else grouped.set(key, Object.assign({ _count: 1 }, m))
      })
      visibleRows = Array.from(grouped.values())
    }
    if (!visibleRows.length) {
      host.replaceChildren(emptyState('i-radar', 'Nada no monitor ainda', 'Quando alguém apagar, editar, reagir, ler seu recado, te ligar ou trocar a foto, aparece aqui — sem poluir as conversas.'))
      return
    }
    const tl = el('div', 'mon-list')
    visibleRows.forEach((m) => {
      const item = el('div', `mon-item k-${esc(m.kind)}`)
      item.innerHTML = `
        <div class="mon-ico">${icon(monIcon(m.kind), 'ico')}</div>
        <div class="mon-body">
          <div class="mon-sum">${esc(m.summary || m.kind)}${m._count > 1 ? ` <span class="mon-group-count">×${m._count}</span>` : ''}</div>
          <div class="mon-meta">${esc(m.name || '')}${m.name ? ' · ' : ''}${esc(timeAgo(m.ts))} · ${esc(clockTime(m.ts))}</div>
        </div>`
      tl.appendChild(item)
    })
    host.replaceChildren(tl)
  }
  function startMonitorPoll() { stopMonitorPoll(); MON.timer = setInterval(() => { if (S.tab === 'monitor' && $('#monHost')) loadMonitor() }, 8000) }
  function stopMonitorPoll() { if (MON.timer) { clearInterval(MON.timer); MON.timer = null } }

  // ---------------------------------------------------------------- AGENDA (Google Calendar)
  function fmtWhen(ms, allDay) {
    if (!ms) return ''
    const d = new Date(ms)
    const day = d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })
    if (allDay) return `${day} · dia todo`
    return `${day} · ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}`
  }

  const pad2 = (n) => String(n).padStart(2, '0')
  // Analisa hora digitada em vários formatos ("2030","20:30","20h","20h30","8") -> {h,m} ou null.
  function parseHora(str) {
    const digits = String(str || '').replace(/[^\dh:]/gi, '').replace(/h/i, ':')
    const m = digits.match(/^(\d{1,2})(?::?(\d{1,2}))?$/)
    if (!m) return null
    const h = Number(m[1]); const mi = m[2] != null ? Number(m[2]) : 0
    if (h > 23 || mi > 59) return null
    return { h, m: mi }
  }
  // Seletor de data/hora NOSSO (sem controle nativo): chips de dia + campo de hora inteligente.
  // Ao confirmar, chama onPick(isoComOffset). base = ms do horário original (pré-preenche a hora).
  function rescheduleForm(baseMs, onPick, onCancel) {
    const box = el('div', 'agenda-resched')
    const today = new Date()
    const days = []
    for (let i = 0; i < 8; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i)
      const label = i === 0 ? 'hoje' : i === 1 ? 'amanhã' : d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })
      days.push({ key: agKey(d), label })
    }
    const base = new Date(baseMs || Date.now())
    const baseHora = `${pad2(base.getHours())}:${pad2(base.getMinutes())}`
    let selKey = agKey(base) // dia original selecionado por padrão (se estiver no leque; senão hoje)
    if (!days.some((d) => d.key === selKey)) selKey = days[0].key
    box.innerHTML = `
      <div class="resched-lbl">Nova data</div>
      <div class="resched-days"></div>
      <div class="resched-row">
        <span class="resched-lbl">às</span>
        <input class="resched-time field" type="text" inputmode="numeric" value="${baseHora}" maxlength="5" aria-label="Horário">
        <button class="btn small" data-act="pick">${icon('i-check', 'ico ico-sm')} Marcar</button>
        <button class="btn ghost small" data-act="cancel">Cancelar</button>
      </div>`
    const daysHost = box.querySelector('.resched-days')
    days.forEach((d) => {
      const chip = el('button', 'chip' + (d.key === selKey ? ' active' : ''), d.label)
      chip.addEventListener('click', () => { selKey = d.key; daysHost.querySelectorAll('.chip').forEach((c) => c.classList.remove('active')); chip.classList.add('active') })
      daysHost.appendChild(chip)
    })
    const timeEl = box.querySelector('.resched-time')
    timeEl.addEventListener('blur', () => { const t = parseHora(timeEl.value); if (t) timeEl.value = `${pad2(t.h)}:${pad2(t.m)}` })
    box.querySelector('[data-act="cancel"]').addEventListener('click', () => onCancel && onCancel())
    box.querySelector('[data-act="pick"]').addEventListener('click', (e) => {
      const t = parseHora(timeEl.value)
      if (!t) { timeEl.classList.add('err'); toast('Horário inválido (ex: 20:30)', 'err'); return }
      const iso = `${selKey}T${pad2(t.h)}:${pad2(t.m)}:00-03:00`
      onPick(iso, e.currentTarget)
    })
    return box
  }

  function proposalCard(p, { expired = false } = {}) {
    const card = el('div', 'agenda-item prop' + (expired ? ' expired' : ''))
    const who = p.personName || p.withPerson || 'alguém'
    const chan = p.channel === 'whatsapp' ? 'WhatsApp' : p.channel === 'tinder' ? 'Tinder' : p.channel === 'instagram' ? 'Instagram' : (p.channel || '')
    card.innerHTML = `
      <div class="agenda-main">
        <div class="agenda-title">${icon('i-spark', 'ico ico-sm')} ${esc(p.title)}</div>
        <div class="agenda-when">${esc(fmtWhen(p.startsAt))}${expired ? ' · <span class="agenda-vencido">já passou</span>' : ''}</div>
        <div class="agenda-sub">com ${esc(who)}${chan ? ` · ${esc(chan)}` : ''}${p.confidence != null ? ` · confiança ${Math.round(p.confidence * 100)}%` : ''}</div>
        ${p.sourceQuote ? `<div class="agenda-quote">“${esc(p.sourceQuote)}”</div>` : ''}
        ${Array.isArray(p.aviso) && p.aviso.length ? `<div class="agenda-aviso">${icon('i-alert', 'ico ico-sm')}<span>${esc(p.aviso.join('; '))}</span></div>` : ''}
      </div>
      <div class="agenda-actions">
        ${expired ? '' : `<button class="btn small" data-act="approve">${icon('i-check', 'ico ico-sm')} Adicionar</button>`}
        <button class="btn ghost small" data-act="resched">${icon('i-cal', 'ico ico-sm')} Remarcar</button>
        <button class="btn ghost small" data-act="reject">${icon('i-x', 'ico ico-sm')} Descartar</button>
      </div>`
    const actions = card.querySelector('.agenda-actions')
    const approveWith = async (btn, startsAt) => {
      btn.disabled = true
      const r = await post(`/api/agenda/proposal/${encodeURIComponent(p.id)}`, { action: 'approve', ...(startsAt ? { startsAt } : {}) })
      if (r && r.ok) { toast(startsAt ? 'Remarcado e adicionado à agenda' : 'Adicionado à sua agenda'); loadAgenda(); loadState() } else { toast('Não deu pra adicionar', 'err'); btn.disabled = false }
    }
    const approveBtn = card.querySelector('[data-act="approve"]')
    if (approveBtn) approveBtn.addEventListener('click', (e) => approveWith(e.currentTarget))
    card.querySelector('[data-act="resched"]').addEventListener('click', () => {
      if (card.querySelector('.agenda-resched')) return
      actions.hidden = true
      const form = rescheduleForm(p.startsAt, (iso, btn) => approveWith(btn, iso), () => { form.remove(); actions.hidden = false })
      card.appendChild(form)
      const tf = form.querySelector('.resched-time'); if (tf) tf.focus()
    })
    card.querySelector('[data-act="reject"]').addEventListener('click', (e) => {
      confirmDestructive(e.currentTarget, 'Toque para confirmar', async () => {
        e.currentTarget.disabled = true
        const r = await post(`/api/agenda/proposal/${encodeURIComponent(p.id)}`, { action: 'reject' })
        if (r && r.ok) { toast('Compromisso descartado'); loadAgenda(); loadState() } else { toast('Não deu para descartar', 'err'); e.currentTarget.disabled = false }
      })
    })
    return card
  }

  function agendaEventWhen(ev) {
    if (!ev?.startMs) return ''
    const start = new Date(ev.startMs)
    const startDate = start.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })
    if (ev.allDay) {
      const inclusiveEnd = ev.endMs ? new Date(ev.endMs - 1) : start
      const sameDay = agKey(start) === agKey(inclusiveEnd)
      return sameDay
        ? `${startDate} · dia todo`
        : `${startDate} até ${inclusiveEnd.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' })}`
    }
    const end = new Date(ev.endMs || (ev.startMs + 3600000))
    const sameDay = agKey(start) === agKey(end)
    return `${startDate} · ${clockTime(ev.startMs)}–${sameDay ? clockTime(end.getTime()) : `${end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${clockTime(end.getTime())}`}`
  }

  function agendaTimeValue(ms) {
    const d = new Date(ms)
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  }

  function refreshAgendaEventSurface() {
    if (S.tab === 'agenda') return loadAgenda()
    if (S.tab === 'projetos') {
      if (PROJ.openId) return loadProjDetail(PROJ.openId)
      return loadProjetos()
    }
  }

  function openAgendaEvent(sourceEvent, onChanged = refreshAgendaEventSurface) {
    if (!sourceEvent?.id) { toast('Este compromisso não tem identificação para editar', 'err'); return }
    let ev = { ...sourceEvent }
    const ov = overlay()
    const sheet = el('section', 'pj-sheet agenda-event-sheet')
    sheet.setAttribute('role', 'dialog')
    sheet.setAttribute('aria-modal', 'true')
    ov.appendChild(sheet)
    const close = () => ov.remove()

    const renderDetails = () => {
      const attendees = (ev.attendees || []).filter((a) => !a.self)
      sheet.innerHTML = `
        <div class="pj-sheet-head">
          <div><span class="agenda-pane-kicker">Compromisso</span><h2>${esc(ev.title)}</h2></div>
          <button class="icon-btn" data-x type="button" aria-label="Fechar">${icon('i-x')}</button>
        </div>
        <div class="agenda-event-meta">
          <div class="agenda-event-meta-row">${icon('i-cal', 'ico')}<span><b>Quando</b><small>${esc(agendaEventWhen(ev))}</small></span></div>
          ${ev.location ? `<div class="agenda-event-meta-row">${icon('i-pin', 'ico')}<span><b>Local</b><small>${esc(ev.location)}</small></span></div>` : ''}
          ${attendees.length ? `<div class="agenda-event-meta-row">${icon('i-users', 'ico')}<span><b>Convidados</b><small>${attendees.map((a) => esc(a.name || a.email || '')).filter(Boolean).join(', ')}</small></span></div>` : ''}
        </div>
        ${ev.description ? `<div class="agenda-event-description"><span>Descrição</span><p>${esc(ev.description)}</p></div>` : ''}
        <div class="agenda-event-actions">
          <button class="btn" data-act="edit" type="button">${icon('i-edit', 'ico ico-sm')} Editar</button>
          <button class="btn ghost" data-act="periodo" type="button">${icon('i-pin', 'ico ico-sm')} ${eventoJaTemPeriodo(ev) ? 'Período já marcado' : 'Nesse período eu estou em…'}</button>
          ${ev.htmlLink ? `<a class="btn ghost" href="${esc(ev.htmlLink)}" target="_blank" rel="noopener">${icon('i-link', 'ico ico-sm')} Google Agenda</a>` : ''}
          <button class="btn ghost danger-soft" data-act="delete" type="button">${icon('i-trash', 'ico ico-sm')} Cancelar compromisso</button>
        </div>`
      sheet.querySelector('[data-x]').addEventListener('click', close)
      sheet.querySelector('[data-act="edit"]').addEventListener('click', renderEditor)
      // A viagem já está no calendário — ele não redigita data nenhuma. Vem daqui com as
      // datas do próprio evento, e o event_id impede período duplicado no segundo clique.
      const btnPer = sheet.querySelector('[data-act="periodo"]')
      btnPer.addEventListener('click', () => {
        const jaTem = eventoJaTemPeriodo(ev)
        if (jaTem) { close(); setTab('agenda'); toast('esse compromisso já virou período, logo abaixo do calendário'); return }
        close()
        abrirEditorPeriodo({ de: diaIsoDe(ev.startMs), ate: diaIsoDe(fimParaPeriodo(ev)), titulo: ev.title, eventId: ev.id })
      })
      const del = sheet.querySelector('[data-act="delete"]')
      let armed = false
      let armTimer = null
      del.addEventListener('click', async () => {
        if (!armed) {
          armed = true
          del.classList.add('confirming')
          del.textContent = 'Confirmar cancelamento'
          armTimer = setTimeout(() => { if (del.isConnected) renderDetails() }, 5000)
          return
        }
        clearTimeout(armTimer)
        del.disabled = true
        // Compromisso do calendário da casa cancela pela rota da casa — que já derruba o
        // espelho na Google quando ele existe. Mandar pelo id da Google não acharia nada.
        const r = ev.fonte === 'local'
          ? await api(`/api/agenda/compromissos/${encodeURIComponent(ev.localId)}`, { method: 'DELETE' })
          : await api(`/api/agenda/events/${encodeURIComponent(ev.id)}`, { method: 'DELETE' })
        if (!r?.ok) { toast('Não deu para cancelar o compromisso', 'err'); renderDetails(); return }
        close()
        toast('Compromisso cancelado')
        await onChanged?.()
      })
    }

    const renderEditor = () => {
      const startMs = ev.startMs || Date.now()
      const endMs = ev.endMs || (startMs + 3600000)
      const startDate = agKey(new Date(startMs))
      const endDate = agKey(new Date(ev.allDay ? Math.max(startMs, endMs - 1) : endMs))
      sheet.innerHTML = `
        <form class="agenda-event-form">
          <div class="pj-sheet-head">
            <div><span class="agenda-pane-kicker">Editar</span><h2>Compromisso</h2></div>
            <button class="icon-btn" data-x type="button" aria-label="Fechar">${icon('i-x')}</button>
          </div>
          <label class="agenda-event-field agenda-event-field-full"><span>Título</span><input name="title" type="text" maxlength="300" value="${esc(ev.title)}" required></label>
          <label class="agenda-event-allday"><input name="allDay" type="checkbox"${ev.allDay ? ' checked' : ''}><span>Dia todo</span></label>
          <div class="agenda-event-timegrid">
            <label class="agenda-event-field"><span>Data de início</span><input name="startDate" type="date" value="${startDate}" required></label>
            <label class="agenda-event-field agenda-event-clock"><span>Hora</span><input name="startTime" type="time" value="${agendaTimeValue(startMs)}" required></label>
            <label class="agenda-event-field"><span>Data de término</span><input name="endDate" type="date" value="${endDate}" required></label>
            <label class="agenda-event-field agenda-event-clock"><span>Hora</span><input name="endTime" type="time" value="${agendaTimeValue(endMs)}" required></label>
          </div>
          <label class="agenda-event-field agenda-event-field-full"><span>Local</span><input name="location" type="text" maxlength="1000" value="${esc(ev.location || '')}" placeholder="Opcional"></label>
          <label class="agenda-event-field agenda-event-field-full"><span>Descrição</span><textarea name="description" rows="4" maxlength="8000" placeholder="Opcional">${esc(ev.description || '')}</textarea></label>
          <div class="agenda-event-form-actions">
            <button class="btn ghost" data-act="back" type="button">Voltar</button>
            <button class="btn" type="submit">${icon('i-check', 'ico ico-sm')} Salvar alterações</button>
          </div>
        </form>`
      const form = sheet.querySelector('form')
      const syncAllDay = () => {
        const allDay = form.elements.allDay.checked
        $$('.agenda-event-clock', form).forEach((field) => { field.hidden = allDay })
        form.elements.startTime.required = !allDay
        form.elements.endTime.required = !allDay
      }
      syncAllDay()
      form.elements.allDay.addEventListener('change', syncAllDay)
      form.querySelector('[data-x]').addEventListener('click', close)
      form.querySelector('[data-act="back"]').addEventListener('click', renderDetails)
      form.addEventListener('submit', async (e) => {
        e.preventDefault()
        const allDay = form.elements.allDay.checked
        const startDateValue = form.elements.startDate.value
        const endDateValue = form.elements.endDate.value
        const title = form.elements.title.value.trim()
        if (!title) { form.elements.title.focus(); return }
        const payload = {
          title,
          allDay,
          startDate: startDateValue,
          endDate: endDateValue,
          location: form.elements.location.value.trim(),
          description: form.elements.description.value.trim(),
        }
        if (!allDay) {
          payload.startsAtIso = `${startDateValue}T${form.elements.startTime.value}:00-03:00`
          payload.endsAtIso = `${endDateValue}T${form.elements.endTime.value}:00-03:00`
          if (Date.parse(payload.endsAtIso) <= Date.parse(payload.startsAtIso)) {
            toast('O término precisa ser depois do início', 'err')
            return
          }
        } else if (endDateValue < startDateValue) {
          toast('A data de término precisa ser igual ou posterior ao início', 'err')
          return
        }
        const save = form.querySelector('[type="submit"]')
        save.disabled = true
        const r = await api(`/api/agenda/events/${encodeURIComponent(ev.id)}`, { method: 'PATCH', body: JSON.stringify(payload) })
        if (!r?.ok || !r.event) { toast('Não deu para salvar as alterações', 'err'); save.disabled = false; return }
        ev = r.event
        close()
        toast('Compromisso atualizado')
        await onChanged?.()
      })
      form.elements.title.focus()
    }

    renderDetails()
  }

  function agendaDayEventCard(ev) {
    const card = el('button', `agenda-day-event${ev.isTim ? ' vendas-multicanal' : ''}`)
    card.type = 'button'
    card.innerHTML = `
      <span class="agenda-day-time">${ev.allDay ? 'dia todo' : esc(clockTime(ev.startMs))}</span>
      <span class="agenda-day-copy"><b>${esc(ev.title)}</b>${ev.location ? `<small>${icon('i-pin', 'ico ico-sm')}${esc(ev.location)}</small>` : '<small>Ver detalhes e editar</small>'}</span>
      ${icon('i-arrow-r', 'ico ico-sm agenda-day-arrow')}`
    card.addEventListener('click', () => openAgendaEvent(ev))
    return card
  }

  // ---- calendário (grade de mês) ----
  const AG = { year: null, month: null, events: [], proposals: [], expired: [], selKey: null, mobileMode: 'month' }
  const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
  function agKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
  const agKeyMs = (ms) => agKey(new Date(ms))
  const diaIsoDe = (ms) => agKeyMs(ms)

  // O último dia INCLUSIVO de um evento. No Google, evento de dia todo termina no dia
  // SEGUINTE (o fim é exclusivo): uma viagem de 10 a 20 chega aqui com end=21. Sem tirar o
  // milissegundo, o período cobriria um dia que a viagem não cobre.
  function fimParaPeriodo(ev) {
    if (!ev.endMs) return ev.startMs
    return ev.allDay ? ev.endMs - 1 : ev.endMs
  }

  // Esse compromisso já virou período? Evita dois períodos iguais no segundo clique.
  function eventoJaTemPeriodo(ev) {
    return (DISP.dados?.periodos || []).some((p) => p.event_id && p.event_id === ev.id)
  }

  async function agendaGotoMonth(y, m) {
    AG.year = y; AG.month = m
    const first = new Date(y, m, 1)
    const start = new Date(y, m, 1 - first.getDay())                                 // domingo da 1ª semana
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 42) // exclusivo (6 semanas)
    const r = await api(`/api/agenda/events?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`)
    AG.events = (r && Array.isArray(r.events)) ? r.events : []
    renderCalendar()
  }

  // O período que cobre um dia ('AAAA-MM-DD'), pra pintar a célula. Mesma regra do servidor:
  // 'ocupado' vence, porque é a leitura mais restritiva.
  function periodoDoDia(key) {
    const lista = DISP.dados?.periodos || []
    const cobrindo = lista.filter((p) => p.de <= key && key <= (p.ate || p.de))
    return cobrindo.find((p) => p.tipo === 'ocupado') || cobrindo[0] || null
  }

  function renderCalendar() {
    const host = $('#agendaCalHost'); if (!host) return
    const { year: y, month: m } = AG
    const byDay = {}
    AG.events.forEach((ev) => { const k = agKeyMs(ev.startMs); (byDay[k] = byDay[k] || []).push(ev) })
    Object.values(byDay).forEach((list) => list.sort((a, b) => a.startMs - b.startMs))
    const todayKey = agKey(new Date())
    // "julho de 2026" -> "Julho de 2026". Só a primeira letra: o CSS capitalizava cada palavra
    // e escrevia "Julho De 2026", que é erro de português na maior fonte da tela.
    const monthName = new Date(y, m, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
      .replace(/^./, (c) => c.toUpperCase())

    const wrap = el('div', 'cal')
    const head = el('div', 'cal-head')
    head.innerHTML = `
      <button class="icon-btn" id="calPrev" title="Mês anterior">${icon('i-arrow-l')}</button>
      <div class="cal-title">${esc(monthName)}</div>
      <button class="icon-btn" id="calNext" title="Próximo mês">${icon('i-arrow-r')}</button>
      <button class="btn ghost small" id="calToday">Hoje</button>
      <button class="btn ghost small mobile-only" id="calMode" type="button">${AG.mobileMode === 'list' ? 'Ver mês' : 'Ver lista'}</button>`
    wrap.appendChild(head)
    const wd = el('div', 'cal-weekdays')
    WEEKDAYS.forEach((d) => wd.appendChild(el('div', 'cal-wd', d)))
    wrap.appendChild(wd)

    const grid = el('div', 'cal-grid')
    const first = new Date(y, m, 1)
    const start = new Date(y, m, 1 - first.getDay())
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      const key = agKey(d)
      const evs = byDay[key] || []
      const cell = el('button', `cal-cell${d.getMonth() === m ? '' : ' out'}${key === todayKey ? ' today' : ''}${AG.selKey === key ? ' sel' : ''}`)
      cell.type = 'button'
      cell.setAttribute('aria-label', `${d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' })}${evs.length ? `, ${evs.length} compromisso${evs.length === 1 ? '' : 's'}` : ', sem compromissos'}`)
      let chips = evs.slice(0, 3).map((ev) => `<div class="cal-ev${ev.isTim ? ' vendas-multicanal' : ''}${ev.allDay ? ' allday' : ''}">${ev.allDay ? '' : `<span class="t">${clockTime(ev.startMs)}</span> `}${esc(ev.title)}</div>`).join('')
      if (evs.length > 3) chips += `<div class="cal-more">+${evs.length - 3}</div>`
      // Período em cima do dia: a viagem tem que ser visível no mês, senão "configurar no
      // calendário" seria só um formulário que por acaso mora perto de um calendário.
      const per = periodoDoDia(key)
      if (per) {
        cell.classList.add(per.tipo === 'ocupado' ? 'cal-ocupado' : 'cal-fora')
        cell.title = per.tipo === 'ocupado' ? `Ocupado${per.titulo ? `: ${per.titulo}` : ''}` : `Você está em ${per.lugar ? per.lugar.nome : 'outro lugar'}${per.titulo ? ` (${per.titulo})` : ''}`
      }
      if (DISP.marcando) cell.classList.add('cal-marcando')
      if (DISP.marcando && DISP.marcando.de === key) cell.classList.add('cal-marcado')
      cell.innerHTML = `<div class="cal-daynum">${d.getDate()}</div><div class="cal-evs">${chips}</div>`
      cell.addEventListener('click', () => {
        if (DISP.marcando) { cliqueNoDiaMarcando(key); return }
        AG.selKey = key; renderCalendar()
      })
      grid.appendChild(cell)
    }
    wrap.appendChild(grid)

    // Legenda dos dias tingidos. Só aparece quando o mês na tela TEM dia tingido: cor sem
    // legenda é adivinhação, e legenda de cor que não está ali é ruído. O modo de marcação
    // usa o mesmo espaço pra dizer o que ele tem que clicar.
    const tingidos = grid.querySelectorAll('.cal-fora, .cal-ocupado').length
    if (DISP.marcando) {
      const banner = el('div', 'cal-legenda marcando')
      banner.innerHTML = `${icon('i-cal', 'ico ico-sm')}<span>${DISP.marcando.de
        ? `Primeiro dia: <b>${esc(dataBr(DISP.marcando.de))}</b>. Agora clique no último dia.`
        : 'Clique no <b>primeiro</b> dia do período'}</span>`
      const sair = el('button', 'btn ghost small', 'Cancelar')
      sair.type = 'button'
      sair.addEventListener('click', cancelarMarcacaoPeriodo)
      banner.appendChild(sair)
      wrap.appendChild(banner)
      // O aviso também vai ANTES do mês: no mobile o mês tem 6 semanas e a legenda embaixo
      // fica fora da tela justamente enquanto ele precisa dela.
      const topo = banner.cloneNode(true)
      topo.classList.add('no-topo')
      topo.querySelector('button')?.addEventListener('click', cancelarMarcacaoPeriodo)
      wrap.insertBefore(topo, grid)
    } else if (tingidos) {
      const itens = []
      if (grid.querySelector('.cal-fora')) itens.push('<span class="cal-leg-item"><i class="cal-leg-fora"></i>fora da sua base</span>')
      if (grid.querySelector('.cal-ocupado')) itens.push('<span class="cal-leg-item"><i class="cal-leg-ocupado"></i>ocupado</span>')
      wrap.appendChild(el('div', 'cal-legenda', itens.join('')))
    }

    const mobileList = el('div', 'cal-mobile-list')
    const monthEvents = AG.events
      .filter((ev) => { const d = new Date(ev.startMs); return d.getFullYear() === y && d.getMonth() === m })
      .sort((a, b) => a.startMs - b.startMs)
    if (!monthEvents.length) mobileList.innerHTML = '<div class="cal-list-empty">Nenhum compromisso neste mês.</div>'
    else monthEvents.forEach((ev) => {
      const row = el('button', `cal-list-row${ev.isTim ? ' vendas-multicanal' : ''}`)
      row.type = 'button'
      row.innerHTML = `<div class="cal-list-date"><b>${new Date(ev.startMs).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}</b><span>${ev.allDay ? 'dia todo' : esc(clockTime(ev.startMs))}</span></div><div class="cal-list-copy"><b>${esc(ev.title)}</b>${ev.location ? `<span>${icon('i-pin', 'ico ico-sm')}${esc(ev.location)}</span>` : ''}</div>`
      row.addEventListener('click', () => openAgendaEvent(ev))
      mobileList.appendChild(row)
    })
    wrap.appendChild(mobileList)
    wrap.classList.toggle('mobile-list-mode', AG.mobileMode === 'list')

    host.className = ''; host.replaceChildren(wrap)
    $('#calPrev').addEventListener('click', () => { AG.selKey = null; const nm = m - 1; agendaGotoMonth(nm < 0 ? y - 1 : y, (nm + 12) % 12) })
    $('#calNext').addEventListener('click', () => { AG.selKey = null; const nm = m + 1; agendaGotoMonth(nm > 11 ? y + 1 : y, nm % 12) })
    $('#calToday').addEventListener('click', () => { const t = new Date(); AG.selKey = agKey(t); agendaGotoMonth(t.getFullYear(), t.getMonth()) })
    const mode = $('#calMode')
    if (mode) mode.addEventListener('click', () => { AG.mobileMode = AG.mobileMode === 'list' ? 'month' : 'list'; renderCalendar() })
    renderAgendaSidebar(AG.selKey, AG.selKey ? (byDay[AG.selKey] || []) : null)
  }

  function renderAgendaSidebar(key, evs) {
    const pane = $('#agendaSide')
    if (!pane) return
    pane.replaceChildren()
    const head = el('div', 'agenda-proposals-head')
    const list = el('div', 'agenda-proposals-list')

    if (key && evs != null) {
      const [Y, M, D] = key.split('-').map(Number)
      const label = new Date(Y, M - 1, D).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })
      head.innerHTML = `
        <div><span class="agenda-pane-kicker">Dia selecionado</span><h2>${esc(label)}</h2></div>
        <div class="agenda-side-head-actions"><span class="agenda-proposals-count">${evs.length}</span><button class="icon-btn" type="button" aria-label="Voltar para compromissos a revisar">${icon('i-x')}</button></div>`
      head.querySelector('button').addEventListener('click', () => { AG.selKey = null; renderCalendar() })
      if (!evs.length) list.appendChild(el('div', 'agenda-emptyline', 'Nenhum compromisso neste dia. Selecione outro dia ou volte para as revisões.'))
      else evs.forEach((ev) => list.appendChild(agendaDayEventCard(ev)))
      // MARCAR À MÃO. O compromisso nasce no calendário da casa (e espelha na Google, se
      // conectada) — é o que faz o horário ficar ocupado de verdade pra quem calcula os
      // horários de atendimento, com ou sem Google.
      const marcar = el('button', 'btn ghost small agenda-marcar', `${icon('i-cal', 'ico ico-sm')} Marcar compromisso`)
      marcar.type = 'button'
      marcar.addEventListener('click', () => {
        marcar.hidden = true
        const box = el('div', 'agenda-marcar-form')
        const titulo = el('input', 'field')
        titulo.type = 'text'; titulo.maxLength = 200; titulo.placeholder = 'O que é (ex.: atendimento da Ana)'
        titulo.setAttribute('aria-label', 'Título do compromisso')
        const meio = new Date(Y, M - 1, D, 14, 0, 0)
        const form = rescheduleForm(meio.getTime(), async (iso, btn) => {
          const t = titulo.value.trim()
          if (!t) { titulo.classList.add('err'); toast('Escreva o que é o compromisso', 'err'); return }
          btn.disabled = true
          const r = await post('/api/agenda/compromissos', { titulo: t, inicioMs: Date.parse(iso) })
          if (!r?.ok) { toast(r?.erro || 'Não deu pra marcar', 'err'); btn.disabled = false; return }
          toast(r.espelhado ? 'Marcado aqui e na Google Agenda' : 'Marcado no calendário do sistema')
          await agendaGotoMonth(AG.year, AG.month)
        }, () => { box.remove(); marcar.hidden = false })
        box.append(titulo, form)
        list.appendChild(box)
        titulo.focus()
      })
      list.appendChild(marcar)
      pane.setAttribute('aria-label', `Compromissos de ${label}`)
      pane.append(head, list)
      return
    }

    const props = AG.proposals
    head.innerHTML = `<div><span class="agenda-pane-kicker">Detectados pela IA</span><h2>Pra você revisar</h2></div><span class="agenda-proposals-count">${props.length}</span>`
    if (!props.length) list.appendChild(el('div', 'agenda-emptyline', 'Nada pra revisar agora. Selecione um dia no calendário para ver os compromissos.'))
    else props.forEach((p) => list.appendChild(proposalCard(p)))
    pane.setAttribute('aria-label', 'Compromissos detectados nas conversas')
    pane.append(head, list)

    if (AG.expired.length) {
      const det = el('div', 'agenda-expired')
      const expiredHead = el('button', 'agenda-expired-head', `${icon('i-arrow-r', 'ico ico-sm')} <span>Vencidas</span> <span class="agenda-expired-count">${AG.expired.length}</span>`)
      const expiredList = el('div', 'agenda-expired-list')
      expiredList.id = 'agendaExpiredList'
      expiredHead.type = 'button'
      expiredHead.setAttribute('aria-controls', expiredList.id)
      const setExpiredOpen = (open) => {
        expiredList.hidden = !open
        expiredHead.classList.toggle('open', open)
        expiredHead.setAttribute('aria-expanded', String(open))
        expiredHead.setAttribute('aria-label', `${open ? 'Ocultar' : 'Mostrar'} ${AG.expired.length} compromisso${AG.expired.length === 1 ? '' : 's'} vencido${AG.expired.length === 1 ? '' : 's'}`)
      }
      setExpiredOpen(false)
      expiredHead.addEventListener('click', () => setExpiredOpen(expiredHead.getAttribute('aria-expanded') !== 'true'))
      AG.expired.forEach((p) => expiredList.appendChild(proposalCard(p, { expired: true })))
      det.append(expiredHead, expiredList)
      pane.appendChild(det)
    }
  }

  // DATAS COMEMORATIVAS. O que o dia de hoje tem de especial, escrito à mão. Sem ano, repete
  // todo ano (Natal, Dia dos Namorados); com ano, é única. Vale no DIA: é gancho de assunto,
  // não pauta — e é isso que o texto do prompt diz também.
  const MESES_CURTO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
  // `null` = ainda não carregou (diferente de "não há serviço"): dizer "nenhum serviço"
  // enquanto a resposta está no ar seria mentir por um segundo.
  let SERVICOS_NOMES = null

  function renderDatasPane() {
    const pane = el('section', 'agenda-pane datas-pane')
    pane.innerHTML = `<div class="agenda-pane-head">
        <div><h3>Datas comemorativas</h3>
        <p>Datas suas, escritas à mão — não vêm do Google. No dia, a IA pode usar como assunto se couber na conversa. Sem ano, repete todo ano.</p></div>
      </div>`
    const host = el('div', 'datas-host')
    pane.appendChild(host)

    const form = el('form', 'datas-novo')
    const titulo = el('input', 'field datas-titulo')
    titulo.type = 'text'; titulo.maxLength = 60; titulo.placeholder = 'Nome da data (ex: Dia dos Namorados)'
    titulo.autocomplete = 'off'
    const dia = el('input', 'field datas-dia')
    dia.type = 'text'; dia.inputMode = 'numeric'; dia.maxLength = 2; dia.placeholder = 'dia'
    // Seletor de mês com componente nosso: nada de <select> nativo (regra da casa).
    let mesEscolhido = new Date().getMonth() + 1
    const meses = el('div', 'datas-meses')
    const pintarMeses = () => {
      meses.replaceChildren(...MESES_CURTO.map((m, i) => {
        const b = el('button', `datas-mes${i + 1 === mesEscolhido ? ' on' : ''}`, m)
        b.type = 'button'
        b.setAttribute('aria-pressed', i + 1 === mesEscolhido ? 'true' : 'false')
        b.addEventListener('click', () => { mesEscolhido = i + 1; pintarMeses() })
        return b
      }))
    }
    pintarMeses()
    const ano = el('input', 'field datas-ano')
    ano.type = 'text'; ano.inputMode = 'numeric'; ano.maxLength = 4; ano.placeholder = 'ano (deixe vazio p/ todo ano)'
    const nota = el('input', 'field datas-nota')
    nota.type = 'text'; nota.maxLength = 200; nota.placeholder = 'nota opcional — o que é, como puxar o assunto'
    const criar = el('button', 'btn primary small', 'Adicionar data')
    criar.type = 'submit'
    form.append(titulo, dia, meses, ano, nota, criar)

    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const r = await post('/api/agenda/datas', {
        titulo: titulo.value, dia: dia.value, mes: mesEscolhido,
        ano: ano.value.trim() || null, nota: nota.value,
      })
      if (!r?.ok) { toast(r?.erro || 'Não deu pra salvar a data.', 'err'); return }
      titulo.value = ''; dia.value = ''; ano.value = ''; nota.value = ''
      pintar(r.datas, r.hoje)
      toast('Data adicionada.')
    })
    pane.appendChild(form)

    function linha(d, ehHoje) {
      const l = el('div', `datas-linha${ehHoje ? ' hoje' : ''}`)
      const quando = el('span', 'datas-quando', `${String(d.dia).padStart(2, '0')}/${String(d.mes).padStart(2, '0')}${d.ano ? `/${d.ano}` : ''}`)
      const nome = el('div', 'datas-nome', `<b>${esc(d.titulo)}</b>${d.nota ? `<small>${esc(d.nota)}</small>` : ''}`)
      const selo = ehHoje ? el('span', 'datas-selo', 'hoje') : (d.ano ? el('span', 'datas-selo fraco', 'só neste ano') : el('span', 'datas-selo fraco', 'todo ano'))
      const apagar = el('button', 'btn ghost small danger', 'Apagar')
      apagar.type = 'button'
      apagar.addEventListener('click', () => confirmDestructive(apagar, 'Apagar', async () => {
        const r = await del(`/api/agenda/datas?id=${encodeURIComponent(d.id)}`)
        if (!r?.ok) { toast(r?.erro || 'Não deu pra apagar.', 'err'); return }
        carregar()
        toast('Data apagada.')
      }))

      // O QUE ESTA DATA ACIONA. A data ABRE o serviço no dia; nos outros dias nada muda —
      // ligar aqui não esconde o serviço do resto do ano.
      const aciona = el('div', 'datas-aciona')
      const ligados = new Set(d.servicos || [])
      if (SERVICOS_NOMES === null) aciona.appendChild(el('small', 'datas-aciona-vazio', 'carregando serviços…'))
      else if (!SERVICOS_NOMES.length) {
        aciona.appendChild(el('small', 'datas-aciona-vazio', 'Nenhum serviço cadastrado — crie em Config → Grana → Serviços e valores.'))
      } else {
        aciona.appendChild(el('span', 'datas-aciona-rot', 'Aciona'))
        for (const srv of SERVICOS_NOMES) {
          const on = ligados.has(srv.nome)
          const b = el('button', `datas-srv${on ? ' on' : ''}`,
            `<span>${esc(srv.nome)}</span><small>${srv.tipo === 'online' ? 'entrega' : srv.tipo === 'ambos' ? 'os dois' : 'presencial'}</small>`)
          b.type = 'button'
          b.setAttribute('aria-pressed', on ? 'true' : 'false')
          b.addEventListener('click', async () => {
            const novos = on ? [...ligados].filter((x) => x !== srv.nome) : [...ligados, srv.nome]
            const r = await post('/api/agenda/datas', {
              id: d.id, titulo: d.titulo, dia: d.dia, mes: d.mes, ano: d.ano, nota: d.nota, ativa: d.ativa, servicos: novos,
            })
            if (!r?.ok) { toast(r?.erro || 'Não deu pra ligar o serviço.', 'err'); return }
            carregarDatas()
            toast(on ? `"${srv.nome}" desligado de ${d.titulo}` : `"${srv.nome}" entra no dia de ${d.titulo}`)
          })
          aciona.appendChild(b)
        }
      }

      l.append(quando, nome, selo, apagar, aciona)
      return l
    }

    function pintar(datas, hoje) {
      const idsHoje = new Set((hoje || []).map((d) => d.id))
      host.replaceChildren(...(datas || []).map((d) => linha(d, idsHoje.has(d.id))))
      if (!datas?.length) {
        host.appendChild(el('p', 'datas-vazio',
          'Nenhuma data ainda. Adicione as suas: feriados que você comemora, datas de família, o que fizer sentido virar assunto no dia.'))
      }
    }

    async function carregarDatas() {
      const [r, sv] = await Promise.all([
        api('/api/agenda/datas').catch(() => null),
        api('/api/servicos/nomes').catch(() => null),
      ])
      SERVICOS_NOMES = sv?.servicos || []
      pintar(r?.datas || [], r?.hoje || [])
    }
    pintar([], [])
    carregarDatas()
    return pane
  }

  async function loadAgenda() {
    const host = $('#agendaHost')
    if (!host.dataset.loaded) host.replaceChildren(el('div', 'empty', `${icon('i-cal', 'ico')}<h3>carregando…</h3>`))
    const a = await api('/api/agenda')
    host.dataset.loaded = '1'
    if (!a) { host.replaceChildren(emptyState('i-cal', 'Agenda indisponível', 'O painel não conseguiu falar com o servidor. Tente de novo em instantes.')); return }

    const frag = document.createDocumentFragment()
    const conn = el('section', `agenda-conn${a.connected ? ' connected' : ''}`)
    if (!a.configured) {
      conn.innerHTML = `<div class="agenda-conn-status">
          <span class="agenda-state-icon">${icon('i-cal', 'ico')}</span>
          <div class="agenda-conn-copy">
            <b>Integração ainda não configurada</b>
            <span>Cadastre o app OAuth da Google no servidor para ativar a agenda.</span>
          </div>
        </div>`
    } else if (!a.connected) {
      conn.innerHTML = `<div class="agenda-conn-status">
          <span class="agenda-state-icon">${icon('i-cal', 'ico')}</span>
          <div class="agenda-conn-copy">
            <b>Conecte sua Google Agenda</b>
            <span>A IA considera seus horários e você confirma cada novo compromisso.</span>
          </div>
        </div>
        <a class="btn agenda-connect-btn" href="/api/agenda/connect">${icon('i-link', 'ico ico-sm')} Conectar agenda</a>`
    } else {
      conn.innerHTML = `<div class="agenda-conn-status">
          <span class="agenda-state-icon">${icon('i-check', 'ico')}</span>
          <div class="agenda-conn-copy">
            <span class="agenda-conn-title"><b>Google Agenda</b><span class="agenda-live"><i></i>conectada</span></span>
            <span class="agenda-email">${esc(a.email || '')}</span>
          </div>
        </div>
        <button class="agenda-conn-disclosure mobile-only" id="agendaConnDisclosure" type="button" aria-expanded="false">
          <span>Opções da conexão</span>${icon('i-arrow-r', 'ico ico-sm')}
        </button>
        <div class="agenda-aware">
          <span class="agenda-aware-copy">
            <b>IA nas conversas</b>
            <span>Considera sua disponibilidade</span>
          </span>
          <button class="toggle ${a.awareness ? 'on' : ''}" id="awareToggle" type="button" role="switch" aria-label="Usar minha agenda nas conversas" aria-checked="${a.awareness}"></button>
        </div>
        <div class="agenda-conn-actions">
          <button class="btn ghost small" id="agendaRefresh" type="button">${icon('i-sync', 'ico ico-sm')} Atualizar</button>
          <button class="btn ghost small danger-soft" id="agendaDisconnect" type="button">${icon('i-x', 'ico ico-sm')} Desconectar</button>
        </div>`
    }
    frag.appendChild(conn)

    // O calendário aparece SEMPRE, conectada ou não: desde 15/08/2026 o compromisso mora no
    // calendário da casa e a Google é espelho. Deixar a grade dentro do `if (connected)`
    // escondia justamente a agenda de quem ainda não conectou nada — e era ela que decidia
    // se o horário do serviço cabia.
    {
      const props = Array.isArray(a.proposals) ? a.proposals : []
      AG.proposals = props
      AG.expired = Array.isArray(a.expired) ? a.expired : []
      const workspace = el('div', 'agenda-workspace')

      const secE = el('section', 'agenda-calendar-pane')
      secE.setAttribute('aria-label', 'Calendário mensal')
      const calHost = el('div', 'empty'); calHost.id = 'agendaCalHost'
      calHost.innerHTML = `${icon('i-cal', 'ico')}<h3>carregando…</h3>`
      secE.appendChild(calHost)

      const secP = el('aside', 'agenda-proposals-pane')
      secP.id = 'agendaSide'

      workspace.append(secE, secP)
      frag.appendChild(workspace)
    }

    // A disponibilidade mora aqui desde 26/07/2026: dia, horário, lugar e período só fazem
    // sentido junto do mês. E ela NÃO depende da Google Agenda estar conectada — a razão de
    // existir é justamente esta: horário disponível é o que ele DECLARA, não o que sobrou
    // vazio no calendário. Deixar a seção dentro do `if (connected)` faria a conexão cair e
    // levar embora a única tela onde ele diz quando pode.
    frag.appendChild(renderDisponibilidadePane())
    // As datas comemorativas ficam FORA do `if (connected)` pelo mesmo motivo da
    // disponibilidade: elas são dela, escritas à mão, e não podem sumir da tela porque a
    // conexão com o Google caiu (ou nunca existiu).
    frag.appendChild(renderDatasPane())

    host.replaceChildren(frag)
    if (a.connected && isMobileLayout()) conn.classList.add('mobile-collapsed')
    // A disponibilidade carrega ANTES do mês: o calendário pinta os períodos, e sem os dados
    // na mão ele pintaria o mês limpo e só corrigiria no segundo render.
    await loadDisponibilidade()
    renderAgendaSidebar(AG.selKey, null)
    if (AG.year == null) { const t = new Date(); AG.year = t.getFullYear(); AG.month = t.getMonth() }
    agendaGotoMonth(AG.year, AG.month)

    const aware = $('#awareToggle')
    if (aware) aware.addEventListener('click', async () => {
      const on = !aware.classList.contains('on')
      aware.classList.toggle('on', on); aware.setAttribute('aria-checked', String(on))
      await post('/api/agenda/awareness', { enabled: on })
      toast(on ? 'IA usando sua agenda' : 'IA sem usar a agenda')
    })
    const refr = $('#agendaRefresh')
    if (refr) refr.addEventListener('click', async () => { refr.disabled = true; await post('/api/agenda/refresh', {}); loadAgenda() })
    const disc = $('#agendaDisconnect')
    if (disc) disc.addEventListener('click', (e) => {
      confirmDestructive(e.currentTarget, 'Confirmar desconexão', async () => {
        e.currentTarget.disabled = true
        const r = await post('/api/agenda/disconnect', {})
        if (r && r.ok !== false) { toast('Google Agenda desconectada'); loadAgenda(); loadState() }
        else { toast('Não deu para desconectar', 'err'); e.currentTarget.disabled = false }
      })
    })
    const disclosure = $('#agendaConnDisclosure')
    if (disclosure) disclosure.addEventListener('click', () => {
      const open = conn.classList.toggle('mobile-expanded')
      conn.classList.toggle('mobile-collapsed', !open)
      disclosure.setAttribute('aria-expanded', String(open))
      disclosure.querySelector('span').textContent = open ? 'Ocultar opções' : 'Opções da conexão'
    })
  }

  // ---------------------------------------------------------------- CONFIG (sobre mim, só leitura)
  // Mini-render de markdown → HTML. Tudo é escapado ANTES de virar tag (seguro contra HTML injetado).
  // Cobre: headings (#..######), listas (- * + e 1.), citação (>), regra ---, negrito/itálico/código inline.
  function mdInline(s) {
    let t = esc(s)
    t = t.replace(/`([^`]+)`/g, (_, x) => `<code>${x}</code>`)          // código inline
    t = t.replace(/\*\*([^*]+)\*\*/g, (_, x) => `<strong>${x}</strong>`) // **negrito**
    t = t.replace(/__([^_]+)__/g, (_, x) => `<strong>${x}</strong>`)     // __negrito__
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, a, x) => `${a}<em>${x}</em>`) // *itálico*
    t = t.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, (_, a, x) => `${a}<em>${x}</em>`)    // _itálico_
    return t
  }
  function mdToHtml(md) {
    const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n')
    const out = []
    let para = []          // parágrafo em construção
    let list = null        // { type: 'ul'|'ol', items: [] }
    const flushPara = () => { if (para.length) { out.push(`<p>${mdInline(para.join(' '))}</p>`); para = [] } }
    const flushList = () => { if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${mdInline(i)}</li>`).join('')}</${list.type}>`); list = null } }
    const flushAll = () => { flushPara(); flushList() }

    for (const raw of lines) {
      const line = raw.replace(/\s+$/,'')
      if (!line.trim()) { flushAll(); continue }                 // linha em branco separa blocos
      const h = line.match(/^(#{1,6})\s+(.*)$/)
      if (h) { flushAll(); const lvl = h[1].length; out.push(`<h${lvl}>${mdInline(h[2])}</h${lvl}>`); continue }
      if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) { flushAll(); out.push('<hr>'); continue }
      const ul = line.match(/^\s*[-*+]\s+(.*)$/)
      if (ul) { flushPara(); if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] } } list.items.push(ul[1]); continue }
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
      if (ol) { flushPara(); if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] } } list.items.push(ol[1]); continue }
      const bq = line.match(/^\s*>\s?(.*)$/)
      if (bq) { flushAll(); out.push(`<blockquote>${mdInline(bq[1])}</blockquote>`); continue }
      // linha comum acumula no parágrafo (fecha lista aberta)
      flushList(); para.push(line.trim())
    }
    flushAll()
    return out.join('\n')
  }

  const fmtNum = (n) => (typeof n === 'number' && isFinite(n)) ? n.toLocaleString('pt-BR') : null

  function configCard(doc) {
    const card = el('article', 'cfg-card')
    // contadores: novo contrato (usedChars/fullChars) com fallback pro legado (chars)
    const usedChars = fmtNum(doc.usedChars != null ? doc.usedChars : doc.chars)
    const fullChars = fmtNum(doc.fullChars)
    const usesFull = doc.usesFullFile === true
    const head = el('div', 'cfg-head', `
      <div class="cfg-ico">${icon('i-book', 'ico ico-lg')}</div>
      <div class="cfg-titles">
        <div class="cfg-label">${esc(doc.label || doc.id || 'Documento')}</div>
        ${doc.filename ? `<div class="cfg-sub">${esc(doc.filename)}</div>` : ''}
      </div>`)
    card.appendChild(head)

    if (doc.error) {
      card.appendChild(el('div', 'cfg-warn', `${icon('i-x', 'ico ico-sm')}<span>não deu pra ler este documento${doc.error ? ` — ${esc(doc.error)}` : ''}</span>`))
    }

    // ---- conteúdo PRINCIPAL: o que a IA realmente lê (doc.text) ----
    const hasText = doc.text != null && String(doc.text).trim() !== ''
    if (hasText) {
      const meta = el('div', 'cfg-read-meta')
      meta.innerHTML = `<span class="cfg-pill reads">${icon('i-spark', 'ico ico-sm')} A IA lê isto</span>${usedChars ? `<span class="cfg-count">a IA lê ${usedChars} caracteres</span>` : ''}`
      card.appendChild(meta)
      const body = el('div', 'cfg-md')
      body.innerHTML = mdToHtml(doc.text)
      // O documento nasce FECHADO — no celular sempre foi assim, e no desktop passou a ser em
      // 12/08/2026: dois documentos abertos davam 1.444px, quase duas telas de texto que ele
      // já conhece, na frente de tudo que vem depois. O botão é o mesmo; o conteúdo continua
      // a um clique, e o contador de caracteres continua visível fechado.
      {
        body.hidden = true
        const read = el('button', 'cfg-doc-toggle', `${icon('i-book', 'ico ico-sm')}<span>Ler documento</span>${icon('i-arrow-r', 'ico ico-sm chev')}`)
        read.type = 'button'
        read.setAttribute('aria-expanded', 'false')
        read.addEventListener('click', () => {
          const open = read.getAttribute('aria-expanded') === 'true'
          const next = !open
          read.setAttribute('aria-expanded', String(next))
          read.querySelector('span').textContent = next ? 'Fechar documento' : 'Ler documento'
          body.hidden = !next
          card.classList.toggle('document-open', next)
        })
        card.appendChild(read)
      }
      card.appendChild(body)
      if (doc.truncated) card.appendChild(el('div', 'cfg-trunc', 'texto muito longo — mostrando só o começo do que a IA enxerga'))
    } else if (!doc.error) {
      card.appendChild(el('div', 'cfg-empty-text', 'documento vazio'))
    }

    // ---- bloco recolhível com o ARQUIVO COMPLETO (só quando a IA NÃO usa o arquivo inteiro) ----
    const hasFull = doc.fullText != null && String(doc.fullText).trim() !== ''
    if (!usesFull && hasFull) {
      card.appendChild(fullFileBlock(doc, fullChars))
    }
    return card
  }

  // bloco discreto e recolhível: material completo do arquivo (fonte de pesquisa).
  // Sem <details> nativo — botão próprio com aria-expanded; conteúdo renderizado só ao abrir.
  function fullFileBlock(doc, fullCharsStr) {
    const block = el('div', 'cfg-full')
    const btn = el('button', 'cfg-full-toggle')
    btn.type = 'button'
    btn.setAttribute('aria-expanded', 'false')
    btn.innerHTML = `
      <span class="chev">${icon('i-arrow-r', 'ico ico-sm')}</span>
      <span class="cfg-full-lbl">
        <b>Material completo do arquivo</b>
        <small>fonte de pesquisa — a IA usa só o trecho acima${fullCharsStr ? ` · arquivo completo: ${fullCharsStr}` : ''}</small>
      </span>`
    const panel = el('div', 'cfg-full-panel')
    panel.hidden = true
    block.append(btn, panel)
    let rendered = false
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true'
      const next = !open
      btn.setAttribute('aria-expanded', String(next))
      block.classList.toggle('open', next)
      panel.hidden = !next
      if (next && !rendered) {           // renderiza o markdown grande só na primeira abertura
        const md = el('div', 'cfg-md cfg-md-full')
        md.innerHTML = mdToHtml(doc.fullText)
        panel.appendChild(md)
        rendered = true
      }
    })
    return block
  }

  function openAiPlanLabel(plan) {
    return ({
      free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite',
      team: 'Team', self_serve_business_usage_based: 'Business',
      business: 'Business', enterprise_cbp_usage_based: 'Enterprise',
      enterprise: 'Enterprise', edu: 'Edu',
    })[String(plan || '').toLowerCase()] || (plan ? String(plan) : 'Não informado')
  }

  function formatCompactNumber(value) {
    const n = Number(value)
    if (!Number.isFinite(n)) return '—'
    return new Intl.NumberFormat('pt-BR', { notation: n >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n)
  }

  function rateResetLabel(value) {
    const raw = Number(value)
    if (!Number.isFinite(raw) || raw <= 0) return 'renovação não informada'
    const ms = raw < 1e12 ? raw * 1000 : raw
    const date = new Date(ms)
    const sameDay = date.toDateString() === new Date().toDateString()
    return `renova ${sameDay ? 'hoje' : date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} às ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
  }

  function rateWindowLabel(window, fallback) {
    const mins = Number(window?.windowDurationMins)
    if (!Number.isFinite(mins) || mins <= 0) return fallback
    if (mins % 10080 === 0) return mins === 10080 ? 'Uso semanal' : `Janela de ${Math.round(mins / 10080)} semanas`
    if (mins % 1440 === 0) return mins === 1440 ? 'Uso diário' : `Janela de ${Math.round(mins / 1440)} dias`
    if (mins % 60 === 0) return `Janela de ${Math.round(mins / 60)} h`
    return `Janela de ${mins} min`
  }

  function renderRateWindow(window, label) {
    if (!window) return ''
    const used = Math.max(0, Math.min(100, Number(window.usedPercent) || 0))
    const remaining = Math.max(0, 100 - used)
    return `
      <div class="cfg-rate-window">
        <div class="cfg-rate-top">
          <span><b>${esc(rateWindowLabel(window, label))}</b><small>${esc(rateResetLabel(window.resetsAt))}</small></span>
          <strong>${Math.round(used)}% <small>usado</small></strong>
        </div>
        <div class="cfg-rate-track" role="progressbar" aria-label="${esc(rateWindowLabel(window, label))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(used)}">
          <i style="width:${used}%"></i>
        </div>
        <div class="cfg-rate-foot"><span>${Math.round(remaining)}% disponível</span><span>${Math.round(used)}% consumido</span></div>
      </div>`
  }

  function openAiAccountResetLabel(value) {
    if (!value) return 'reset não informado'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return 'reset não informado'
    return `libera ${date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} às ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
  }

  function renderProviderPicker(ia, { onConnectClaude = null } = {}) {
    const active = ia?.ativo || 'codex'
    const providers = ia?.providers || {}
    const wrap = el('div', 'cfg-provider-picker')
    wrap.innerHTML = `
      <div class="cfg-provider-copy">
        <span class="cfg-kicker">Cérebro do sistema</span>
        <h3>Escolha a LLM</h3>
        <p>A troca vale para o vendas-multicanal inteiro. Canais, memória, regras, filas e automações continuam iguais.</p>
      </div>
      <div class="cfg-provider-options" role="group" aria-label="Provider de IA">
        <button type="button" class="cfg-provider-option ${active === 'codex' ? 'active' : ''}" data-provider="codex" aria-pressed="${active === 'codex'}">
          <span class="cfg-provider-icon">${icon('i-spark', 'ico')}</span>
          <span><b>OpenAI</b><small>${providers.codex?.conta ? `Codex · ${esc(providers.codex.conta)}` : 'Codex OAuth'}</small></span>
          <em>${active === 'codex' ? 'Em uso' : 'Usar'}</em>
        </button>
        <button type="button" class="cfg-provider-option ${active === 'claude' ? 'active' : ''} ${providers.claude?.pronto ? '' : 'unavailable'}" data-provider="claude" aria-pressed="${active === 'claude'}" title="${esc(providers.claude?.falta || '')}">
          <span class="cfg-provider-icon">${icon('i-bot', 'ico')}</span>
          <span><b>Claude</b><small>${providers.claude?.pronto ? `OAuth${providers.claude?.conta?.subscriptionType ? ` · ${esc(providers.claude.conta.subscriptionType)}` : ''}` : esc(providers.claude?.falta || 'indisponível')}</small></span>
          <em>${providers.claude?.pronto ? (active === 'claude' ? 'Em uso' : 'Usar') : (active === 'claude' ? 'Reconectar' : 'Conectar')}</em>
        </button>
      </div>`
    // Modelo e esforço, logo abaixo da escolha de provedor. Só aparecem no Codex — o caminho
    // do Claude não tem esses dois botões.
    const motor = el('div', 'cfg-motor'); motor.id = 'cfgMotor'
    wrap.appendChild(motor)
    // o `wrap` ainda não está na página aqui; passar o elemento evita depender de
    // document.getElementById, que devolvia null e deixava o bloco vazio
    if (active === 'codex') pintarMotorIa(motor)

    $$('.cfg-provider-option', wrap).forEach((button) => {
      button.addEventListener('click', async () => {
        const provider = button.dataset.provider
        if (provider === 'claude' && !providers.claude?.pronto) {
          if (onConnectClaude) onConnectClaude()
          return
        }
        if (provider === active) return
        const result = await post('/api/ia/provedor', { provedor: provider })
        if (!result?.ok) return
        toast(provider === 'claude' ? 'Claude agora é o cérebro do vendas-multicanal' : 'OpenAI agora é o cérebro do vendas-multicanal')
        await loadConfig(true)
      })
    })
    return wrap
  }

  // ---------------------------------------------------------------- motor da IA
  // A lista de modelos é a PROVADA: só entra aqui o que respondeu no teste. O "Light" da
  // interface do Codex não está — a API recusa; o valor que funciona é `low`.
  async function pintarMotorIa(elemento = null) {
    const host = elemento || $('#cfgMotor')
    if (!host) return
    const d = await api('/api/ia/motor')
    if (!d || !host.isConnected && !elemento) return
    const opc = (lista, atual, tipo) => lista.map((x) => {
      const on = x.id === atual
      return `<button type="button" class="cfg-motor-op${on ? ' on' : ''}" data-tipo="${tipo}" data-id="${esc(x.id)}" aria-pressed="${on}">
        <b>${esc(x.nome)}</b>${x.nota ? `<small>${esc(x.nota)}</small>` : ''}</button>`
    }).join('')
    host.innerHTML = `
      <div class="cfg-motor-bloco">
        <div class="cfg-motor-head"><b>Modelo</b><small>${d.modelo ? '' : 'sem escolha: vale o padrão do Codex'}</small></div>
        <div class="cfg-motor-ops">${opc(d.modelos, d.modelo, 'modelo')}</div>
      </div>
      <div class="cfg-motor-bloco">
        <div class="cfg-motor-head"><b>Esforço</b><small>quanto ele pensa antes de responder</small></div>
        <div class="cfg-motor-ops">${opc(d.esforcos, d.esforco, 'esforco')}</div>
      </div>
      <div class="cfg-motor-pe">
        <button class="btn ghost small" id="cfgMotorTestar">Testar todos os modelos</button>
        <small id="cfgMotorRes">a lista acima só tem modelo que já respondeu num teste real</small>
      </div>`
    $$('.cfg-motor-op', host).forEach((b) => b.addEventListener('click', async () => {
      const corpo = b.dataset.tipo === 'modelo' ? { modelo: b.dataset.id } : { esforco: b.dataset.id }
      const r = await api('/api/ia/motor', { method: 'POST', body: JSON.stringify(corpo) })
      if (r && r.ok) { toast(b.dataset.tipo === 'modelo' ? 'modelo trocado' : 'esforço trocado'); pintarMotorIa(host) }
    }))
    host.querySelector('#cfgMotorTestar').addEventListener('click', async () => {
      const alvo = host.querySelector('#cfgMotorRes')
      alvo.textContent = 'testando um por um, cada um custa uma chamada de verdade…'
      const r = await api('/api/ia/motor/testar', { method: 'POST', body: '{}', timeoutMs: 10 * 60 * 1000 })
      if (!r) { alvo.textContent = 'o teste não voltou'; return }
      const ok = r.resultados.filter((x) => x.ok)
      alvo.innerHTML = `${ok.length} de ${r.resultados.length} responderam · ` +
        r.resultados.map((x) => `${esc(x.modelo.replace('gpt-', ''))} ${x.ok ? Math.round(x.ms / 100) / 10 + 's' : 'FALHOU'}`).join(' · ')
    })
  }

  function renderClaudeAccount(claude, active) {
    const ready = !!claude?.pronto
    const account = claude?.conta || {}
    const card = el('article', 'cfg-openai-card cfg-claude-card')
    card.innerHTML = `
      <div class="cfg-openai-head">
        <div class="cfg-openai-brand">${icon('i-bot', 'ico')}</div>
        <div class="cfg-openai-identity">
          <span class="cfg-kicker">Conta Claude</span>
          <h2>${ready ? esc(account.email || account.orgName || 'Claude conectado') : 'Claude não está pronto'}</h2>
          <p>${ready ? `O vendas-multicanal usa esta conta do Claude${active ? ' em todo o sistema' : ''}.` : esc(claude?.falta || 'Faça login no Claude Code desta máquina.')}</p>
        </div>
        <div class="cfg-openai-badges">
          <span class="cfg-status ${ready ? 'ok' : 'off'}">${ready ? 'Conectada' : 'Desconectada'}</span>
          <span class="cfg-status">OAuth</span>
          ${account.subscriptionType ? `<span class="cfg-status plan">${esc(account.subscriptionType)}</span>` : ''}
          ${active ? '<span class="cfg-status plan">Em uso</span>' : ''}
        </div>
      </div>
      <div class="cfg-account-facts">
        <div><span>Autenticação</span><strong>${esc(account.authMethod || 'Claude OAuth')}</strong></div>
        <div><span>Plano</span><strong>${esc(account.subscriptionType || 'Não informado')}</strong></div>
        <div><span>Motor</span><strong>Claude Code ${esc(claude?.versao || '')}</strong></div>
        <div><span>Escopo</span><strong>Todo o vendas-multicanal</strong></div>
      </div>
      <div class="cfg-claude-note">
        <span class="cfg-kicker">Mesmo corpo, outro cérebro</span>
        <h3>Nada além da LLM muda</h3>
        <p>As mesmas conversas, memórias, regras de escrita, filtros, filas, ferramentas e automações continuam sendo usadas. O Claude Code não expõe ao painel a porcentagem da assinatura; por isso o consumo percentual permanece disponível nas contas OpenAI.</p>
      </div>`
    return card
  }

  function renderClaudeLoginPanel(existingLogin = null) {
    const panel = el('div', 'cfg-oauth-flow')

    const showCode = (login) => {
      panel.replaceChildren()
      panel.innerHTML = `
        <div class="cfg-oauth-head">
          <div><span class="cfg-kicker">Conta Claude</span><h3>Concluir o OAuth</h3></div>
          <span class="cfg-status plan">Claude Code</span>
        </div>
        <ol>
          <li>Abra o login e entre na conta Claude que será usada pelo vendas-multicanal.</li>
          <li>Ao final, a Anthropic mostrará um código de autorização.</li>
          <li>Copie o código inteiro e cole abaixo.</li>
        </ol>
        <a class="btn small cfg-oauth-link" href="${esc(login.authUrl || '#')}" target="_blank" rel="noopener noreferrer">${icon('i-arrow-r', 'ico ico-sm')} Abrir login Claude</a>
        <label class="cfg-oauth-label" for="cfgClaudeCode">Código da Anthropic</label>
        <textarea id="cfgClaudeCode" rows="2" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="Cole aqui o código exibido ao final do login"></textarea>
        <p class="cfg-oauth-status" aria-live="polite">O cérebro atual continua ativo até o Claude confirmar este código.</p>
        <div class="cfg-oauth-actions">
          <button type="button" class="btn primary" data-claude-complete>Concluir e usar Claude</button>
          <button type="button" class="btn" data-claude-cancel>Cancelar</button>
        </div>`
      $('[data-claude-complete]', panel).addEventListener('click', async () => {
        const codigo = $('#cfgClaudeCode', panel)?.value.trim()
        if (!codigo) { toast('Cole o código da Anthropic primeiro', 'err'); return }
        $('.cfg-oauth-status', panel).textContent = 'Validando o código e conectando o Claude…'
        const result = await api('/api/ia/claude/codigo', {
          method: 'POST',
          body: JSON.stringify({ codigo }),
          timeoutMs: 55_000,
        })
        if (!result?.ok) return
        toast('Claude conectado e selecionado como cérebro do vendas-multicanal')
        await loadConfig(true)
      })
      $('[data-claude-cancel]', panel).addEventListener('click', async () => {
        await post('/api/ia/claude/login/cancelar')
        panel.remove()
      })
    }

    if (existingLogin?.authUrl) {
      showCode(existingLogin)
      return panel
    }

    panel.innerHTML = `
      <div class="cfg-oauth-head">
        <div><span class="cfg-kicker">Conta Claude</span><h3>Conectar Claude por OAuth</h3></div>
      </div>
      <p class="cfg-oauth-intro">O Claude usará o mesmo corpo do vendas-multicanal: conversas, memória, regras, filas, ferramentas e automações. Só a LLM muda.</p>
      <div class="cfg-oauth-actions">
        <button type="button" class="btn primary" data-claude-start>Iniciar login Claude</button>
        <button type="button" class="btn" data-claude-close>Fechar</button>
      </div>`
    $('[data-claude-close]', panel).addEventListener('click', () => panel.remove())
    $('[data-claude-start]', panel).addEventListener('click', async () => {
      const placeholder = window.open('about:blank', '_blank')
      const result = await api('/api/ia/claude/login', {
        method: 'POST',
        body: '{}',
        timeoutMs: 20_000,
      })
      if (!result?.ok || !result.login) {
        try { placeholder?.close() } catch { /* bloqueado */ }
        return
      }
      if (placeholder && result.login.authUrl) {
        try {
          placeholder.opener = null
          placeholder.location.replace(result.login.authUrl)
        } catch { /* o link continuará visível no painel */ }
      }
      showCode(result.login)
    })
    return panel
  }

  // `relogin` = entrar de novo NA MESMA conta (cartão com credencial expirada). Sem ele,
  // seria necessário criar outra pasta, deixando a anterior com credencial obsoleta.
  function renderOpenAiLoginPanel(existingLogin = null, relogin = null) {
    const panel = el('div', 'cfg-oauth-flow')

    const showFallback = (login) => {
      panel.replaceChildren()
      panel.innerHTML = `
        <div class="cfg-oauth-head">
          <div><span class="cfg-kicker">Nova conta OpenAI</span><h3>Concluir pelo fallback</h3></div>
          <span class="cfg-status plan">${esc(login.nome)}</span>
        </div>
        <ol>
          <li>Abra o login e entre na outra conta ChatGPT.</li>
          <li>Quando terminar na página de <b>localhost</b> que não abriu, copie a URL inteira da barra do navegador.</li>
          <li>Cole essa URL abaixo. O vendas-multicanal entrega o fallback ao Codex dentro do servidor.</li>
        </ol>
        <a class="btn small cfg-oauth-link" href="${esc(login.authUrl || '#')}" target="_blank" rel="noopener noreferrer">${icon('i-arrow-r', 'ico ico-sm')} Abrir login OpenAI</a>
        <label class="cfg-oauth-label" for="cfgOAuthFallback">URL de fallback</label>
        <textarea id="cfgOAuthFallback" rows="3" spellcheck="false" placeholder="http://localhost:.../auth/callback?code=...&state=..."></textarea>
        <p class="cfg-oauth-status" aria-live="polite">A conta atual continua salva e em uso até este login terminar.</p>
        <div class="cfg-oauth-actions">
          <button type="button" class="btn primary" data-oauth-complete>Concluir e usar esta conta</button>
          <button type="button" class="btn" data-oauth-cancel>Cancelar</button>
        </div>`
      const fallback = $('[data-oauth-complete]', panel)
      fallback.addEventListener('click', async () => {
        const value = $('#cfgOAuthFallback', panel)?.value.trim()
        if (!value) { toast('Cole a URL de fallback primeiro', 'err'); return }
        $('.cfg-oauth-status', panel).textContent = 'Validando o fallback e salvando a conta…'
        const result = await api('/api/ia/contas/fallback', {
          method: 'POST',
          body: JSON.stringify({ nome: login.nome, fallback: value }),
          timeoutMs: 35_000,
        })
        if (!result?.ok) return
        toast(`Conta ${result.conta?.email || login.nome} salva e selecionada`)
        await loadConfig(true)
      })
      $('[data-oauth-cancel]', panel).addEventListener('click', async () => {
        await post('/api/ia/contas/login/cancelar', { nome: login.nome })
        panel.remove()
      })
    }

    if (existingLogin?.nome && existingLogin?.authUrl) {
      showFallback(existingLogin)
      return panel
    }

    panel.innerHTML = relogin?.nome
      ? `
      <div class="cfg-oauth-head">
        <div><span class="cfg-kicker">Entrar de novo</span><h3>Mesma conta, sessão nova</h3></div>
        <span class="cfg-status plan">${esc(relogin.nome)}</span>
      </div>
      <p class="cfg-oauth-intro">A sessão de ${esc(relogin.email || relogin.nome)} foi encerrada pelo provedor. O login novo reaproveita a mesma vaga, sem criar conta repetida.</p>
      <div class="cfg-oauth-actions">
        <button type="button" class="btn primary" data-oauth-start>Iniciar login OAuth</button>
        <button type="button" class="btn" data-oauth-close>Fechar</button>
      </div>`
      : `
      <div class="cfg-oauth-head">
        <div><span class="cfg-kicker">Nova conta OpenAI</span><h3>Adicionar sem substituir a atual</h3></div>
      </div>
      <p class="cfg-oauth-intro">Cada conta fica salva numa credencial isolada. Dê um apelido opcional para reconhecê-la.</p>
      <label class="cfg-oauth-label" for="cfgOAuthName">Apelido da conta</label>
      <input id="cfgOAuthName" type="text" maxlength="48" autocomplete="off" placeholder="ex.: trabalho ou conta-2">
      <div class="cfg-oauth-actions">
        <button type="button" class="btn primary" data-oauth-start>Iniciar login OAuth</button>
        <button type="button" class="btn" data-oauth-close>Fechar</button>
      </div>`
    $('[data-oauth-close]', panel).addEventListener('click', () => panel.remove())
    $('[data-oauth-start]', panel).addEventListener('click', async () => {
      const placeholder = window.open('about:blank', '_blank')
      const name = relogin?.nome || $('#cfgOAuthName', panel)?.value.trim() || ''
      const result = await post('/api/ia/contas/login', { nome: name, substituir: !!relogin?.nome })
      if (!result?.ok || !result.login) {
        try { placeholder?.close() } catch { /* bloqueado */ }
        return
      }
      if (placeholder && result.login.authUrl) {
        try {
          placeholder.opener = null
          placeholder.location.replace(result.login.authUrl)
        } catch { /* o link continuará visível no painel */ }
      }
      showFallback(result.login)
    })
    return panel
  }

  function renderOpenAiAccountsManager(ia) {
    const state = ia?.openai || {}
    const accounts = Array.isArray(state.contas) ? state.contas : []
    const wrap = el('div', 'cfg-saved-accounts')
    const heading = el('div', 'cfg-saved-head', `
      <div><span class="cfg-kicker">Contas OpenAI salvas</span><h3>${accounts.length ? `${accounts.length} ${accounts.length === 1 ? 'conta disponível' : 'contas disponíveis'}` : 'Nenhuma conta adicionada'}</h3><p>Trocar de conta não apaga a anterior. A porcentagem e a data de liberação continuam visíveis para você voltar depois.</p></div>`)
    const add = el('button', 'btn small cfg-add-account', `${icon('i-spark', 'ico ico-sm')} Adicionar conta`)
    add.type = 'button'
    heading.appendChild(add)
    wrap.appendChild(heading)

    const list = el('div', 'cfg-saved-list')
    // O fluxo de OAuth nasce mais abaixo; os cartões só precisam saber CHAMAR por ele.
    let abrirLoginOpenAi = () => {}
    accounts.forEach((account) => {
      const used = Number(account.usadoPct)
      const hasUsage = Number.isFinite(used)
      const selected = !!account.ativa
      // Conta com credencial revogada não é "em uso": ela está escolhida, mas não gera.
      const morta = account.precisaRelogin === true
      const inUse = selected && ia?.ativo === 'codex' && !morta
      const card = el('article', `cfg-saved-account ${selected ? 'selected' : ''}${morta ? ' morta' : ''}`)
      const statusTexto = morta ? 'Entre de novo' : inUse ? 'Em uso' : selected ? 'Selecionada' : account.conectada ? 'Salva' : 'Falhou'
      const usoTexto = morta ? 'Credencial expirada' : hasUsage ? `${Math.round(used)}% usado` : 'Sem leitura de uso'
      const usoDetalhe = morta
        ? 'entre de novo nesta conta para ela voltar a responder'
        : hasUsage ? openAiAccountResetLabel(account.viraEm) : 'o provedor não informou a cota agora'
      card.innerHTML = `
        <div class="cfg-saved-account-main">
          <span class="cfg-saved-avatar">${icon('i-spark', 'ico')}</span>
          <span class="cfg-saved-identity"><b>${esc(account.email || account.nome)}</b><small>${esc(account.nome)}${account.plano ? ` · ${esc(openAiPlanLabel(account.plano))}` : ''}</small></span>
          <span class="cfg-status ${morta ? 'err' : account.conectada ? 'ok' : 'off'}">${esc(statusTexto)}</span>
        </div>
        <div class="cfg-saved-usage">
          <span><b>${esc(usoTexto)}</b><small>${esc(usoDetalhe)}</small></span>
          <div class="cfg-saved-track ${hasUsage && !morta ? '' : 'desconhecido'}" aria-hidden="true"><i style="width:${hasUsage && !morta ? Math.max(0, Math.min(100, used)) : 100}%"></i></div>
        </div>
        <div class="cfg-saved-actions"></div>`
      const actions = $('.cfg-saved-actions', card)
      if (morta) {
        // Trocar para uma conta revogada não adianta nada: o único caminho é refazer o OAuth.
        const relogar = el('button', 'btn small danger', 'Entrar de novo')
        relogar.type = 'button'
        relogar.addEventListener('click', () => abrirLoginOpenAi({ nome: account.nome, email: account.email }))
        actions.appendChild(relogar)
      } else if (!inUse) {
        const use = el('button', 'btn small', selected ? 'Usar OpenAI' : 'Usar esta conta')
        use.type = 'button'
        use.addEventListener('click', async () => {
          const result = await post('/api/ia/contas/trocar', { nome: account.nome })
          if (!result?.ok) return
          toast(`${account.email || account.nome} agora é a conta da IA`)
          await loadConfig(true)
        })
        actions.appendChild(use)
      } else {
        actions.appendChild(el('span', 'cfg-current-account', `${icon('i-check', 'ico ico-sm')} Conta ativa`))
      }
      list.appendChild(card)
    })
    if (!accounts.length) list.appendChild(el('p', 'cfg-account-empty', 'Adicione a primeira conta OpenAI por OAuth.'))
    wrap.appendChild(list)

    const flowHost = el('div', 'cfg-oauth-host')
    wrap.appendChild(flowHost)
    const openFlow = (login = null, relogin = null) => {
      flowHost.replaceChildren(renderOpenAiLoginPanel(login, relogin))
      $('input, textarea', flowHost)?.focus()
    }
    abrirLoginOpenAi = (relogin = null) => openFlow(null, relogin)
    add.addEventListener('click', () => openFlow())
    if (state.loginPendente?.nome) openFlow(state.loginPendente)
    return wrap
  }

  function renderAiWorkspace(cfg) {
    const ia = cfg?.ia || { ativo: 'codex', providers: {}, openai: { contas: [] } }
    const wrap = el('div', 'cfg-ai-workspace')
    const claude = ia.providers?.claude || {}
    const claudeFlowHost = el('div', 'cfg-oauth-host')
    const openClaudeFlow = () => {
      claudeFlowHost.replaceChildren(renderClaudeLoginPanel(claude.loginPendente))
      claudeFlowHost.scrollIntoView({ behavior: 'smooth', block: 'center' })
      $('textarea, input', claudeFlowHost)?.focus()
    }
    // A IA muda tem que ser a PRIMEIRA coisa desta tela. Em 14/08/2026 ela passou 13h sem
    // conseguir gerar uma linha e o painel seguiu mostrando conta conectada e barra em 0%.
    const saude = ia.saude || null
    if (saude?.muda) {
      const alerta = el('div', 'cfg-ia-muda')
      alerta.innerHTML = `
        <b>A IA não está conseguindo responder</b>
        <p>${saude.falhasSeguidas} tentativa${saude.falhasSeguidas === 1 ? '' : 's'} seguida${saude.falhasSeguidas === 1 ? '' : 's'} falhou sem nenhum acerto${saude.conta ? ` na conta <b>${esc(saude.conta)}</b>` : ''}${saude.mudaDesde ? `, desde ${esc(relWhen(saude.mudaDesde))}` : ''}.</p>
        ${saude.erro ? `<small>${esc(saude.erro)}</small>` : ''}`
      wrap.appendChild(alerta)
    }
    wrap.appendChild(renderProviderPicker(ia, { onConnectClaude: openClaudeFlow }))
    if (ia.ativo === 'claude') wrap.appendChild(renderClaudeAccount(ia.providers?.claude, true))
    else wrap.appendChild(renderOpenAiAccount(cfg?.openai))
    if (!claude.pronto) {
      wrap.appendChild(claudeFlowHost)
      if (claude.loginPendente?.authUrl) openClaudeFlow()
    }
    wrap.appendChild(renderOpenAiAccountsManager(ia))
    return wrap
  }

  function renderOpenAiAccount(openai) {
    const card = el('article', 'cfg-openai-card')
    if (!openai) {
      card.innerHTML = `
        <div class="cfg-openai-head">
          <div class="cfg-openai-brand">${icon('i-spark', 'ico')}</div>
          <div><span class="cfg-kicker">OpenAI</span><h2>Conta indisponível</h2><p>Não foi possível consultar a sessão OAuth agora.</p></div>
        </div>`
      return card
    }

    const account = openai.account || {}
    const connected = !!openai.connected
    const plan = openAiPlanLabel(account.planType)
    const limits = Array.isArray(openai.limits) ? openai.limits : []
    const credits = limits.find((limit) => limit?.credits)?.credits || null
    const individual = limits.find((limit) => limit?.individual)?.individual || null
    const reached = limits.find((limit) => limit?.reachedType)?.reachedType || null
    const windows = []
    limits.forEach((limit) => {
      if (limit?.primary) windows.push({ key: `${limit.id || 'openai'}-primary`, label: limit.name || 'Uso principal', window: limit.primary })
      if (limit?.secondary) windows.push({ key: `${limit.id || 'openai'}-secondary`, label: limit.name ? `${limit.name} · secundário` : 'Uso secundário', window: limit.secondary })
    })
    const summary = openai.usage?.summary || null
    const daily = Array.isArray(openai.usage?.daily) ? openai.usage.daily : []
    const dailyMax = Math.max(1, ...daily.map((d) => Number(d.tokens) || 0))
    const updated = openai.fetchedAt ? `atualizado ${timeAgo(openai.fetchedAt)}` : 'estado atual'

    card.innerHTML = `
      <div class="cfg-openai-head">
        <div class="cfg-openai-brand">${icon('i-spark', 'ico')}</div>
        <div class="cfg-openai-identity">
          <span class="cfg-kicker">Conta OpenAI</span>
          <h2>${connected ? esc(account.email || 'Conta conectada') : 'Autenticação necessária'}</h2>
          <p>${connected ? `A IA do painel usa esta conta via OAuth · ${esc(updated)}` : 'Conecte a conta usada pelo Codex para ativar a IA.'}</p>
        </div>
        <div class="cfg-openai-badges">
          <span class="cfg-status ${connected ? 'ok' : 'off'}">${connected ? 'Conectada' : 'Desconectada'}</span>
          <span class="cfg-status">OAuth</span>
          ${connected ? `<span class="cfg-status plan">${esc(plan)}</span>` : ''}
        </div>
      </div>
      <div class="cfg-account-facts">
        <div><span>Autenticação</span><strong>${account.type === 'chatgpt' ? 'ChatGPT OAuth' : esc(account.type || '—')}</strong></div>
        <div><span>Plano</span><strong>${esc(plan)}</strong></div>
        <div><span>Motor</span><strong>Codex app-server ${esc(openai.hostVersion || '')}</strong></div>
        <div><span>Créditos adicionais</span><strong>${credits ? (credits.unlimited ? 'Ilimitados' : (credits.balance != null ? esc(credits.balance) : (credits.hasCredits ? 'Disponíveis' : 'Sem saldo'))) : '—'}</strong></div>
      </div>
      <div class="cfg-openai-body">
        <section class="cfg-account-block">
          <div class="cfg-block-head"><div><span class="cfg-kicker">Limites atuais</span><h3>Capacidade da conta</h3></div></div>
          <div class="cfg-rate-list">
            ${windows.length ? windows.map((entry) => renderRateWindow(entry.window, entry.label)).join('') : '<p class="cfg-account-empty">A OpenAI não informou janelas percentuais para esta conta.</p>'}
          </div>
          <div class="cfg-limit-details">
            <span><small>Créditos de reset</small><b>${openai.resetCredits?.availableCount != null ? formatCompactNumber(openai.resetCredits.availableCount) : '—'}</b></span>
            ${individual ? `<span><small>Limite individual</small><b>${esc(individual.used || '0')} de ${esc(individual.limit || '—')}</b></span>` : ''}
            ${reached ? `<span class="warn"><small>Estado do limite</small><b>Limite atingido</b></span>` : ''}
          </div>
        </section>
        <section class="cfg-account-block">
          <div class="cfg-block-head"><div><span class="cfg-kicker">Consumo</span><h3>Uso do Codex</h3></div></div>
          ${summary ? `
            <div class="cfg-token-stats">
              <div><strong>${formatCompactNumber(summary.lifetimeTokens)}</strong><span>tokens acumulados</span></div>
              <div><strong>${formatCompactNumber(summary.peakDailyTokens)}</strong><span>pico em um dia</span></div>
              <div><strong>${formatCompactNumber(summary.currentStreakDays)}</strong><span>dias seguidos</span></div>
              <div><strong>${summary.longestRunningTurnSec != null ? `${formatCompactNumber(summary.longestRunningTurnSec)} s` : '—'}</strong><span>maior execução</span></div>
            </div>` : '<p class="cfg-account-empty">O resumo de tokens não está disponível.</p>'}
          ${daily.length ? `
            <div class="cfg-token-chart" aria-label="Tokens usados nos últimos dias">
              ${daily.map((d) => {
                const height = Math.max(6, Math.round(((Number(d.tokens) || 0) / dailyMax) * 100))
                const label = new Date(`${d.startDate}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
                return `<span title="${esc(`${label}: ${formatCompactNumber(d.tokens)} tokens`)}"><i style="height:${height}%"></i><small>${esc(label.slice(0, 2))}</small></span>`
              }).join('')}
            </div>` : ''}
        </section>
      </div>`
    return card
  }

  function renderConfigTools() {
    const wrap = el('div', 'cfg-tools-grid')
    const tools = [
      { tab: 'monitor', icon: 'i-radar', eyebrow: 'Sinais e eventos', title: 'Monitor', description: 'Apagadas, edições, reações, chamadas e mudanças de perfil.' },
      { tab: 'diario', icon: 'i-book', eyebrow: 'Histórico da automação', title: 'Diário do vendas-multicanal', description: 'Respostas, sincronizações, falhas e compromissos detectados.' },
    ]
    tools.forEach((tool) => {
      const button = el('button', 'cfg-tool-card', `
        <span class="cfg-tool-icon">${icon(tool.icon, 'ico')}</span>
        <span class="cfg-tool-copy"><small>${esc(tool.eyebrow)}</small><b>${esc(tool.title)}</b><span>${esc(tool.description)}</span></span>
        ${icon('i-arrow-r', 'ico cfg-tool-arrow')}`)
      button.type = 'button'
      button.addEventListener('click', () => setTab(tool.tab))
      wrap.appendChild(button)
    })
    return wrap
  }

  // INTERRUPTOR GERAL DA IA + FREIO DE COTA.
  // Dois controles no mesmo lugar porque são a mesma pergunta: "a IA está respondendo?".
  // O de cima é a mão dele; o de baixo é o automático que pausa quando a cota do provedor
  // chega no teto. Quando o monitor pausa, o de cima aparece desligado com o motivo escrito —
  // sem isso ele veria a IA muda sem entender por quê.
  function renderIaPausa() {
    const wrap = el('div', 'cfg-ia-pausa')
    wrap.innerHTML = `
      <div class="sa-ai-row">
        <div class="sa-ai-txt"><b>IA respondendo</b><small id="iaPausaMotivo">carregando…</small></div>
        <button type="button" class="toggle" id="iaPausaToggle" role="switch" aria-checked="true" aria-label="IA respondendo"></button>
      </div>
      <div class="sa-ai-row">
        <div class="sa-ai-txt"><b>Pausar sozinha quando a cota estourar</b><small id="iaCotaUso">uso do provedor: —</small></div>
        <button type="button" class="toggle" id="iaMonitorToggle" role="switch" aria-checked="true" aria-label="Pausar sozinha quando a cota estourar"></button>
      </div>`
    requestAnimationFrame(async () => {
      const tg = $('#iaPausaToggle'), mon = $('#iaMonitorToggle')
      const motivo = $('#iaPausaMotivo'), usoEl = $('#iaCotaUso')
      if (!tg || !mon) return
      const pintar = (st) => {
        if (!st) return
        tg.setAttribute('aria-checked', st.pausada ? 'false' : 'true')
        mon.setAttribute('aria-checked', st.monitor ? 'true' : 'false')
        motivo.textContent = st.pausada
          ? (st.pausa && st.pausa.auto ? `pausada sozinha: ${st.pausa.motivo}` : `pausada por você: ${(st.pausa && st.pausa.motivo) || ''}`)
          : 'respondendo normalmente nos canais com IA ligada'
        usoEl.textContent = st.uso && typeof st.uso.usadoPct === 'number'
          ? `uso do provedor: ${st.uso.usadoPct.toFixed(0)}% (pausa em ${st.teto}%)`
          : `sem leitura de uso agora (pausa em ${st.teto}%)`
      }
      pintar(await api('/api/ia/pausa'))
      tg.addEventListener('click', async () => {
        const vaiPausar = tg.getAttribute('aria-checked') === 'true'
        tg.disabled = true
        const r = await post('/api/ia/pausa', { pausar: vaiPausar })
        tg.disabled = false
        if (r && r.ok) { pintar({ ...r, teto: r.teto || 99 }); toast(r.pausada ? 'IA pausada em todos os canais' : 'IA respondendo de novo') }
        else toast('Não deu pra mudar agora', 'err')
      })
      mon.addEventListener('click', async () => {
        const next = mon.getAttribute('aria-checked') !== 'true'
        mon.disabled = true
        const r = await post('/api/ia/pausa', { pausar: $('#iaPausaToggle').getAttribute('aria-checked') === 'false', monitor: next })
        mon.disabled = false
        if (r && r.ok) { mon.setAttribute('aria-checked', r.monitor ? 'true' : 'false'); toast(r.monitor ? 'O freio de cota fica ligado' : 'Freio de cota desligado') }
        else toast('Não deu pra mudar agora', 'err')
      })
    })
    return wrap
  }

  const TOKEN_ORIGENS = {
    resposta_automatica: 'Resposta automática',
    rascunho_manual: 'Gerar com IA',
    primeira_mensagem: 'Primeira mensagem',
    chamada_outra_rede: 'Chamar em outra rede',
    iniciativa: 'Iniciativa',
    agenda_compromissos: 'Leitura da agenda',
    projeto_classificacao: 'Captura de projeto',
    assistente: 'Assistente pessoal',
    modo_agente: 'Modo agente',
    instagram_visao: 'Visão do Instagram',
    memoria_automatica: 'Memória automática',
    memoria_manual: 'Memória manual',
    fatos_extracao: 'Extração de fatos',
    nao_informado: 'Sem origem informada',
  }
  const TOKEN_PASSOS = {
    principal: 'principal',
    correcao_repeticao: 'corrigiu repetição',
    correcao_cobertura: 'cobriu assuntos',
    correcao_estilo: 'corrigiu estilo',
    correcao_filtro: 'corrigiu filtro',
  }

  function renderTokenMonitor(initialUsage) {
    const wrap = el('div', 'cfg-usage-monitor')
    let hours = 24
    let usage = initialUsage

    const draw = () => {
      const total = usage?.total || {}
      const grupos = Array.isArray(usage?.grupos) ? usage.grupos : []
      const measuredMissing = Math.max(0, Number(total.calls || 0) - Number(total.measuredCalls || 0))
      const start = usage?.monitorandoDesde
        ? new Date(usage.monitorandoDesde).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
        : 'agora'
      wrap.innerHTML = `
        <div class="cfg-usage-toolbar">
          <div>
            <span class="cfg-kicker">Livro-caixa em tempo real</span>
            <h3>Monitorando desde ${esc(start)}</h3>
            <p>Cada ida ao OpenAI ou Claude fica registrada com origem, conversa, etapa e medição devolvida pelo provedor.</p>
          </div>
          <div class="cfg-usage-periods" role="group" aria-label="Período do consumo">
            ${[[1, '1 h'], [24, '24 h'], [168, '7 dias']].map(([h, label]) => `<button type="button" data-hours="${h}" class="${hours === h ? 'active' : ''}">${label}</button>`).join('')}
            <button type="button" data-refresh="1" title="Atualizar">${icon('i-sync', 'ico ico-sm')}</button>
          </div>
        </div>
        <div class="cfg-usage-summary">
          <div><strong>${formatCompactNumber(total.totalTokens || 0)}</strong><span>tokens no período</span></div>
          <div><strong>${formatCompactNumber(total.calls || 0)}</strong><span>chamadas de IA</span></div>
          <div><strong>${formatCompactNumber(total.cachedInputTokens || 0)}</strong><span>tokens lidos do cache</span></div>
          <div class="${Number(total.offToggleCalls || 0) ? 'warn' : 'ok'}"><strong>${formatCompactNumber(total.offToggleCalls || 0)}</strong><span>automáticas fora do botão</span></div>
        </div>
        ${measuredMissing ? `<p class="cfg-usage-warning">${icon('i-alert', 'ico ico-sm')} ${measuredMissing} chamada(s) foram registradas, mas o provedor não devolveu contagem de tokens. Elas continuam na tabela.</p>` : ''}
        <div class="cfg-usage-table-wrap">
          <table class="cfg-usage-table">
            <thead><tr>
              <th>Uso</th><th>Provider</th><th>Conversa</th><th>Chamadas</th>
              <th>Entrada</th><th>Cache lido</th><th>Cache criado</th>
              <th>Saída</th><th>Raciocínio</th><th>Total</th><th>Botão IA</th>
            </tr></thead>
            <tbody>
              ${grupos.length ? grupos.map((g) => {
                const origem = TOKEN_ORIGENS[g.origin] || g.origin || 'Não informado'
                const passo = TOKEN_PASSOS[g.step] || String(g.step || '').replaceAll('_', ' ')
                const pessoa = g.personName || g.person_id || (g.channel === 'self' ? 'Você' : 'Sistema')
                const conversa = [pessoa, g.channel].filter(Boolean).join(' · ')
                const automatico = g.trigger === 'automatico'
                const toggle = g.ai_enabled == null
                  ? (automatico ? '<span class="cfg-usage-toggle unknown">sem conversa</span>' : '<span class="cfg-usage-toggle manual">ação manual</span>')
                  : g.ai_enabled
                    ? '<span class="cfg-usage-toggle on">ligada</span>'
                    : automatico
                      ? '<span class="cfg-usage-toggle off">fora do botão</span>'
                      : '<span class="cfg-usage-toggle manual">ação manual</span>'
                return `<tr>
                  <td><b>${esc(origem)}</b><small>${esc(passo)} · ${esc(g.trigger || '—')}</small></td>
                  <td><b>${esc(g.provider || '—')}</b><small>${esc(g.account_name || g.model || '')}</small></td>
                  <td title="${esc(g.person_id || '')}">${esc(conversa)}</td>
                  <td>${formatCompactNumber(g.calls || 0)}${g.failedCalls ? `<small>${g.failedCalls} falhou</small>` : ''}</td>
                  <td>${formatCompactNumber(g.inputTokens || 0)}</td>
                  <td>${formatCompactNumber(g.cachedInputTokens || 0)}</td>
                  <td>${formatCompactNumber(g.cacheWriteTokens || 0)}</td>
                  <td>${formatCompactNumber(g.outputTokens || 0)}</td>
                  <td>${formatCompactNumber(g.reasoningOutputTokens || 0)}</td>
                  <td><b>${formatCompactNumber(g.totalTokens || 0)}</b>${g.measuredCalls < g.calls ? '<small>parcial</small>' : ''}</td>
                  <td>${toggle}</td>
                </tr>`
              }).join('') : '<tr><td colspan="11" class="cfg-usage-empty">Nenhuma chamada de IA neste período. O monitor já está ativo e a tabela preenche sozinha quando houver uso real.</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="cfg-usage-memory">
          <span>${icon('i-spark', 'ico')}</span>
          <div><b>Memória econômica ativa</b><p>O resumo por pessoa tem teto de 1.400 caracteres e reduz o histórico enviado de até 1.000 para 240 mensagens. A consolidação automática só roda com IA ligada, em conversa longa (240 mensagens ou 24 mil caracteres) e depois de 80 mensagens novas; o botão manual continua disponível.</p></div>
        </div>`

      $$('[data-hours]', wrap).forEach((button) => button.addEventListener('click', async () => {
        hours = Number(button.dataset.hours) || 24
        button.disabled = true
        const next = await api(`/api/ia/uso?horas=${hours}`)
        if (next) usage = next
        draw()
      }))
      $('[data-refresh]', wrap)?.addEventListener('click', async (event) => {
        event.currentTarget.disabled = true
        const next = await api(`/api/ia/uso?horas=${hours}`)
        if (next) usage = next
        draw()
      })
    }
    draw()
    return wrap
  }

  // ---------------------------------------------------------------- necessidades
  // O que está apertando e quanto falta. Pedido dela: "um campo pra eu colocar quais
  // dificuldades tenho e quantos reais eu preciso".
  //
  // A MÁSCARA É CENTAVOS-FIRST, e isso não é detalhe: o campo lê SÓ dígitos e vai enchendo da
  // direita pra esquerda (digitou 5 -> R$ 0,05; 50 -> R$ 0,50; 12345 -> R$ 123,45). O jeito
  // ingênuo (deixar digitar "1.200,00" livre e converter no fim) erra de duas formas que já
  // custaram caro em outro sistema: vírgula e ponto trocados viram valor 100x menor, e o
  // cursor pula quando a máscara reescreve o campo no meio da digitação.
  //
  // O valor viaja pra API SEMPRE em centavos inteiros. Nada de float em dinheiro.
  const soDigitos = (s) => String(s || '').replace(/\D+/g, '')
  const centavosParaBRL = (c) => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  const hojeIsoSp = () => {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date())
    const g = Object.fromEntries(p.map((x) => [x.type, x.value]))
    return `${g.year}-${g.month}-${g.day}`
  }

  function campoDinheiro(valorInicialCentavos = 0) {
    const input = el('input', 'nec-money')
    input.type = 'text'
    input.inputMode = 'numeric'          // teclado numérico no celular, sem <input type=number>
    input.autocomplete = 'off'
    input.placeholder = 'R$ 0,00'
    input.dataset.centavos = String(valorInicialCentavos || 0)
    const pinta = () => {
      const c = Number(input.dataset.centavos) || 0
      input.value = c ? centavosParaBRL(c) : ''
      // cursor sempre no fim: a máscara reescreve o texto inteiro, e sem isso o cursor
      // volta pro começo a cada tecla
      requestAnimationFrame(() => { try { input.setSelectionRange(input.value.length, input.value.length) } catch { /* campo fora da tela */ } })
    }
    input.addEventListener('input', () => {
      const digitos = soDigitos(input.value).slice(0, 11)   // teto de R$ 999.999.999,99
      input.dataset.centavos = String(Number(digitos) || 0)
      pinta()
    })
    input.addEventListener('focus', () => pinta())
    pinta()
    input.setCentavos = (valor) => {
      input.dataset.centavos = String(Math.max(0, Math.round(Number(valor) || 0)))
      pinta()
    }
    return input
  }

  // Textarea que cresce com o texto. `scrollHeight` não inclui a borda e o painel é todo
  // border-box: sem somar a diferença, o campo fecha alguns pixels curto e come a última
  // linha — foi o que aconteceu com a linha de conversa, que nasceu cortada ao meio.
  // Uma vez só: a altura vai em PIXELS, então mudar a largura (girar o celular, redimensionar
  // a janela) deixa o campo curto pro texto que agora quebra em mais linhas.
  let resizeDasLinhas = false
  function ligarResizeDasLinhas() {
    if (resizeDasLinhas) return
    resizeDasLinhas = true
    window.addEventListener('resize', () => { for (const t of $$('.nec-linha')) crescerTextarea(t) })
  }

  function crescerTextarea(t, max = 160) {
    t.style.height = 'auto'
    const borda = t.offsetHeight - t.clientHeight
    t.style.height = `${Math.min(max, t.scrollHeight + borda)}px`
  }

  // O campo de janela de horário. Usa o seletor de hora do painel (popover próprio) porque
  // controle nativo de hora não entra aqui — e porque o nativo não tem "qualquer hora", que é
  // justamente o estado normal.
  //
  // `aoMudar` só existe na lista (grava na hora). No formulário, quem lê é o botão Adicionar.
  function campoHorario(de, ate, aoMudar) {
    const box = el('div', 'nec-horario')
    const bLigar = el('button', 'btn ghost small nec-hr-qualquer', 'qualquer hora')
    bLigar.type = 'button'
    const rot = el('span', 'nec-hr-rot', 'entre')
    const bDe = el('button', 'enc-hour', de || '08:00')
    bDe.type = 'button'; bDe.dataset.h = de || '08:00'
    const sep = el('span', 'enc-sep', 'e')
    const bAte = el('button', 'enc-hour', ate || '22:00')
    bAte.type = 'button'; bAte.dataset.h = ate || '22:00'
    const bLimpar = el('button', 'icon-btn nec-hr-limpar', icon('i-x', 'ico ico-sm'))
    bLimpar.type = 'button'; bLimpar.title = 'Voltar pra qualquer hora'
    bLimpar.setAttribute('aria-label', 'Voltar pra qualquer hora')
    box.append(bLigar, rot, bDe, sep, bAte, bLimpar)

    let ligado = !!(de && ate)
    const pintar = () => {
      bLigar.hidden = ligado
      for (const n of [rot, bDe, sep, bAte, bLimpar]) n.hidden = !ligado
    }
    const valor = () => (ligado ? { de: bDe.dataset.h, ate: bAte.dataset.h } : { de: null, ate: null })
    const avisar = () => { if (aoMudar) aoMudar(valor()) }
    bLigar.addEventListener('click', () => { ligado = true; pintar(); avisar() })
    bLimpar.addEventListener('click', () => { ligado = false; pintar(); avisar() })
    // 0h a 23h: quem some às 2h da manhã existe, e a janela pode virar a meia-noite.
    for (const b of [bDe, bAte]) b.addEventListener('click', () => abrirSeletorHora(b, { de: 0, ate: 23 }))
    // O seletor escreve em `data-h` e some. Escutar a mudança do atributo é o que avisa a
    // lista sem precisar mexer no seletor, que é compartilhado com a disponibilidade.
    for (const b of [bDe, bAte]) {
      new MutationObserver(() => avisar()).observe(b, { attributes: true, attributeFilter: ['data-h'] })
    }
    pintar()
    const set = (novoDe, novoAte) => {
      const temJanela = !!(novoDe && novoAte)
      ligado = temJanela
      bDe.dataset.h = novoDe || '08:00'; bDe.textContent = bDe.dataset.h
      bAte.dataset.h = novoAte || '22:00'; bAte.textContent = bAte.dataset.h
      pintar()
    }
    return { el: box, valor, set, limpar: () => set(null, null) }
  }

  // O PREPARO: o que a IA tem que fazer ANTES de poder citar a necessidade (regra configurada,
  // 13/08/2026: "1 dia antes conversar por 40 minutos", "conversar 30 minutos de tal forma").
  //
  // Nasce recolhido em "sem preparo" pelo mesmo motivo do horário: é exceção, e exceção
  // ocupando espaço o tempo todo vira ruído numa lista que ele lê de relance.
  function campoPreparo(n, aoMudar) {
    const box = el('div', 'nec-preparo')
    const bLigar = el('button', 'btn ghost small nec-pr-abrir', 'sem preparo')
    bLigar.type = 'button'
    const corpo = el('div', 'nec-pr-corpo')
    const iMin = el('input', 'nec-num')
    iMin.type = 'number'; iMin.min = '0'; iMin.max = '100000'; iMin.step = '5'
    iMin.value = String(n?.preparoMinutos || 30)
    iMin.setAttribute('aria-label', 'Minutos de conversa antes de citar')
    const iDias = el('input', 'nec-num')
    iDias.type = 'number'; iDias.min = '0'; iDias.max = '365'; iDias.step = '1'
    iDias.value = String(n?.preparoDias || 0)
    iDias.setAttribute('aria-label', 'Em quantos dias esses minutos contam')
    const iComo = el('textarea', 'nec-linha nec-pr-como')
    iComo.rows = 1; iComo.maxLength = 600; iComo.value = n?.preparoComo || ''
    iComo.placeholder = 'De que jeito conversar até lá (ex: puxar assunto de trabalho, sem falar de dinheiro)'
    iComo.setAttribute('aria-label', 'De que jeito conversar antes de citar')
    const bLimpar = el('button', 'icon-btn nec-hr-limpar', icon('i-x', 'ico ico-sm'))
    bLimpar.type = 'button'; bLimpar.title = 'Tirar o preparo'
    bLimpar.setAttribute('aria-label', 'Tirar o preparo')
    corpo.append(
      el('span', 'nec-pr-rot', 'Antes de citar, conversar'), iMin, el('span', 'nec-dias-suf', 'minutos'),
      el('span', 'nec-pr-rot', 'contando os últimos'), iDias, el('span', 'nec-dias-suf', 'dias (0 = tudo)'),
      bLimpar, iComo,
    )
    box.append(bLigar, corpo)

    let ligado = Number(n?.preparoMinutos || 0) > 0
    const pintar = () => { bLigar.hidden = ligado; corpo.hidden = !ligado }
    const valor = () => (ligado
      ? { minutos: Number(iMin.value) || 0, dias: Number(iDias.value) || 0, como: iComo.value }
      : { minutos: 0, dias: 0, como: '' })
    const avisar = () => { if (aoMudar) aoMudar(valor()) }
    bLigar.addEventListener('click', () => { ligado = true; pintar(); crescerTextarea(iComo); avisar() })
    bLimpar.addEventListener('click', () => { ligado = false; pintar(); avisar() })
    for (const c of [iMin, iDias]) {
      c.addEventListener('change', avisar)
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); c.blur() } })
    }
    iComo.addEventListener('input', () => crescerTextarea(iComo))
    iComo.addEventListener('blur', avisar)
    pintar()
    requestAnimationFrame(() => crescerTextarea(iComo))
    const set = (n) => {
      iMin.value = String(n?.preparoMinutos || 30)
      iDias.value = String(n?.preparoDias || 0)
      iComo.value = n?.preparoComo || ''
      ligado = Number(n?.preparoMinutos || 0) > 0
      pintar()
      requestAnimationFrame(() => crescerTextarea(iComo))
    }
    return { el: box, valor, set, limpar: () => set(null) }
  }

  // QUEM PODE OUVIR — camada do TIPO. Chips dos vínculos que já existem no sistema (os mesmos
  // do menu "Contexto" de cada conversa). Nenhum marcado = todos, que é o padrão de tudo que
  // já estava lá; por isso o botão "todos" é o estado normal e não uma opção a mais.
  function campoTipos(tipos, aoMudar) {
    const box = el('div', 'nec-tipos')
    const resumo = el('button', 'btn ghost small nec-tipos-abrir')
    resumo.type = 'button'
    const lista = el('div', 'nec-tipos-lista')
    lista.hidden = true
    let atual = new Set(tipos || [])

    const pintarResumo = () => {
      const n = atual.size
      resumo.textContent = n === 0
        ? 'fala com todos'
        : `fala com ${n} ${n === 1 ? 'tipo' : 'tipos'}`
      resumo.classList.toggle('tem', n > 0)
    }
    resumo.addEventListener('click', async () => {
      lista.hidden = !lista.hidden
      if (!lista.hidden && !lista.dataset.pronto) {
        // O catálogo vem do servidor na primeira abertura. Sem este aviso, a caixa abre vazia
        // por um instante e parece quebrada — e quem vê caixa vazia clica de novo.
        lista.appendChild(el('span', 'nec-tipos-carregando', 'carregando os tipos…'))
        const cat = await garantirCatalogo()
        lista.replaceChildren()
        lista.dataset.pronto = '1'
        const todos = el('button', 'nec-tipo-chip todos', 'todos')
        todos.type = 'button'
        todos.addEventListener('click', () => {
          atual = new Set()
          for (const c of $$('.nec-tipo-chip', lista)) c.classList.toggle('on', false)
          todos.classList.add('on')
          pintarResumo(); if (aoMudar) aoMudar([...atual])
        })
        lista.appendChild(todos)
        for (const v of cat) {
          const c = el('button', `nec-tipo-chip${atual.has(v.valor) ? ' on' : ''}`, esc(v.label))
          c.dataset.valor = v.valor
          c.type = 'button'; c.title = v.desc || ''
          c.addEventListener('click', () => {
            if (atual.has(v.valor)) atual.delete(v.valor); else atual.add(v.valor)
            c.classList.toggle('on', atual.has(v.valor))
            todos.classList.toggle('on', atual.size === 0)
            pintarResumo(); if (aoMudar) aoMudar([...atual])
          })
          lista.appendChild(c)
        }
        todos.classList.toggle('on', atual.size === 0)
      }
    })
    pintarResumo()
    const set = (tiposNovos) => {
      atual = new Set(tiposNovos || [])
      pintarResumo()
      for (const c of $$('.nec-tipo-chip', lista)) c.classList.toggle('on', c.classList.contains('todos') ? atual.size === 0 : atual.has(c.dataset.valor))
    }
    box.append(resumo, lista)
    return { el: box, valor: () => [...atual], set }
  }

  // CONECTAR OS CANAIS. As três sessões (Tinder, Badoo, Instagram) sempre entraram por rota
  // de API, sem lugar nenhum na tela — então quem opera tinha que mandar a credencial por
  // fora, pra alguém colar num curl. Credencial que passa por conversa é credencial que fica
  // registrada em conversa. Aqui ela vai do navegador da pessoa direto pro sistema.
  //
  // As rotas já PROVAM antes de gravar (o Tinder busca o perfil, o Badoo pede a lista de
  // conversas), então o retorno diz de QUEM é a conta — que é a checagem que impede gravar a
  // sessão da pessoa errada.
  const CANAIS_SESSAO = [
    {
      id: 'tinder', nome: 'Tinder', rota: '/api/tinder/token', campo: 'token', linhas: 2,
      dica: 'Com tinder.com aberto e autenticado: F12 → Console → <code>copy(localStorage.getItem(\'TinderWeb/APIToken\'))</code> e cole aqui.',
      placeholder: 'o token do localStorage (não é cookie)',
    },
    {
      id: 'badoo', nome: 'Badoo', rota: '/api/badoo/session', campo: 'cookies', linhas: 3,
      dica: 'O cookie de sessão do Badoo é HttpOnly — o console não enxerga. Em badoo.com: F12 → Network → clique em qualquer requisição → Request Headers → botão direito no <code>cookie</code> → Copy value.',
      placeholder: 'session=…; uid=…; device_id=… (a linha inteira do cabeçalho cookie)',
    },
    {
      id: 'instagram', nome: 'Instagram', rota: '/api/ig/session', campo: 'cookies', linhas: 3,
      dica: 'Mesmo caminho do Badoo, em instagram.com: F12 → Network → uma requisição → Request Headers → Copy value do <code>cookie</code> (precisa ter o <code>sessionid</code>).',
      placeholder: 'sessionid=…; ds_user_id=…; csrftoken=…',
    },
  ]

  function renderConectarCanais() {
    const wrap = el('div', 'sess-wrap')
    wrap.appendChild(el('div', 'sess-item', `
      <div class="sess-head"><b>Método recomendado</b></div>
      <p class="sess-dica">No computador que executa o sistema, rode <code>npm run chrome</code>. Entre nas suas contas nas abas abertas. Depois use os botões abaixo; o sistema lê a sessão local, confirma a conta e não mostra a credencial.</p>`))
    for (const c of CANAIS_SESSAO) {
      const box = el('div', 'sess-item')
      box.innerHTML = `
        <div class="sess-head"><b>${esc(c.nome)}</b><span class="sess-estado" data-estado></span></div>
        <p class="sess-dica">Primeiro entre em ${esc(c.nome)} na aba correspondente do Chrome dedicado.</p>`
      const estado = $('[data-estado]', box)
      const auto = el('button', 'btn primary small', 'Usar conta aberta no Chrome')
      auto.type = 'button'
      auto.addEventListener('click', async () => {
        auto.disabled = true; estado.textContent = 'procurando a conta…'; estado.className = 'sess-estado'
        const r = await api('/api/canais/importar-chrome', {
          method: 'POST', body: JSON.stringify({ canal: c.id }), timeoutMs: 120_000,
        })
        auto.disabled = false
        if (!r || r.ok === false) {
          estado.textContent = (r && (r.error || r.erro)) || 'não deu'
          estado.className = 'sess-estado ruim'
          toast(`${c.nome}: ${(r && (r.error || r.erro)) || 'sessão não encontrada'}`, 'err')
          return
        }
        const quem = r.me?.nome || r.me?.name || r.me || ''
        estado.textContent = c.id === 'badoo' && Number.isFinite(Number(r.conversas))
          ? `sessão conferida · ${Number(r.conversas)} conversas`
          : (quem ? `conectado · ${quem}` : 'conectado e conferido')
        estado.className = 'sess-estado bom'
        toast(`${c.nome} conectado${quem ? ` · ${quem}` : ''}`)
        loadState()
      })
      box.appendChild(auto)

      const manual = el('details', 'sess-manual')
      manual.innerHTML = `<summary>Alternativa manual</summary><p class="sess-dica">${c.dica}</p>`
      const campo = el('textarea', 'sess-campo')
      campo.rows = c.linhas; campo.placeholder = c.placeholder
      campo.setAttribute('aria-label', `Credencial do ${c.nome}`)
      campo.spellcheck = false
      const acoes = el('div', 'sess-acoes')
      const b = el('button', 'btn ghost small', 'Conectar credencial colada')
      b.type = 'button'
      b.addEventListener('click', async () => {
        const valor = campo.value.trim()
        if (!valor) { toast(`Cole a credencial do ${c.nome}.`, 'err'); campo.focus(); return }
        b.disabled = true; estado.textContent = 'conferindo…'; estado.className = 'sess-estado'
        const r = await api(c.rota, { method: 'POST', body: JSON.stringify({ [c.campo]: valor }), timeoutMs: 120_000 })
        b.disabled = false
        if (!r || r.ok === false) {
          estado.textContent = (r && (r.error || r.erro)) || 'não deu'
          estado.className = 'sess-estado ruim'
          toast(`${c.nome}: ${(r && (r.error || r.erro)) || 'credencial recusada'}`, 'err')
          return
        }
        // De QUEM é a conta — o dado que impede gravar a sessão da pessoa errada.
        const quem = r.me?.nome || r.me?.name || r.me || (r.prova && r.prova.amostra && r.prova.amostra.join(', ')) || ''
        estado.textContent = quem ? `conectado · ${quem}` : 'conectado'
        estado.className = 'sess-estado bom'
        campo.value = ''      // a credencial não fica na tela depois de entrar
        toast(`${c.nome} conectado${quem ? ` · ${quem}` : ''}`)
        loadState()
      })
      acoes.appendChild(b)
      manual.append(campo, acoes)
      box.appendChild(manual)
      wrap.appendChild(box)
    }
    return wrap
  }

  function renderNecessidades(dados) {
    const wrap = el('div', 'nec-wrap')
    // SEM TOTAL SOMADO (decisão dela, 31/07/2026): "cada coisa que ela precisa é uma coisa
    // única". Somar conta de luz com mercado e notebook produz um número que não corresponde
    // a nada — não é uma meta nem uma dívida, é a adição de coisas independentes.
    const itens = dados?.itens || []

    // ---- formulário: descrição + valor + vencimento
    const form = el('div', 'nec-form')
    const iDesc = el('input', 'nec-desc')
    iDesc.type = 'text'; iDesc.maxLength = 200; iDesc.placeholder = 'O que está apertando (ex: conta de luz atrasada)'
    const iVal = campoDinheiro(0)
    const iPrazoTipo = el('select', 'nec-prazo-tipo')
    iPrazoTipo.innerHTML = `
      <option value="">Sem vencimento</option>
      <option value="venceu">Já venceu</option>
      <option value="vence">Vai vencer</option>`
    const iPrazoData = el('input', 'nec-prazo-data')
    iPrazoData.type = 'date'; iPrazoData.inputMode = 'numeric'; iPrazoData.disabled = true
    iPrazoData.min = '2000-01-01'; iPrazoData.max = '2100-12-31'
    const syncPrazo = () => {
      const ativo = !!iPrazoTipo.value
      iPrazoData.disabled = !ativo
      if (!ativo) iPrazoData.value = ''
      else if (!iPrazoData.value) iPrazoData.value = hojeIsoSp()
    }
    iPrazoTipo.addEventListener('change', syncPrazo)
    // A ESPERA: a partir de quantos dias de conversa esta necessidade pode ser comentada com
    // uma pessoa (regra configurada, 13/08/2026). Zero = desde o começo. A conta é a idade da
    // conversa com AQUELA pessoa, então o mesmo número vale diferente pra cada uma.
    const iDias = el('input', 'nec-dias')
    iDias.type = 'number'; iDias.min = '0'; iDias.max = '365'; iDias.step = '1'
    iDias.value = '0'; iDias.title = 'A partir de quantos dias de conversa a IA pode comentar isso'
    iDias.setAttribute('aria-label', 'Dias de conversa antes de poder comentar')
    // A RÉGUA. São duas contas diferentes e elas não se substituem (observação do gestor,
    // 13/08/2026): "às vezes nem todos os dias foram conversados". 12 dias corridos podem ser
    // 3 dias de conversa de verdade.
    const iCrit = el('select', 'nec-criterio')
    // Rótulo curto: a explicação das duas réguas está no parágrafo logo abaixo, e opção
    // comprida aqui espremia o campo da descrição, que é o que mais importa na linha.
    iCrit.innerHTML = `
      <option value="corridos">dias de conversa</option>
      <option value="conversados">dias com conversa</option>
      <option value="ia">dias com a IA ligada</option>`
    const dias = el('label', 'nec-dias-campo')
    dias.append(iDias, iCrit)
    const iMsgs = el('input', 'nec-dias')
    iMsgs.type = 'number'; iMsgs.min = '0'; iMsgs.max = '100000'; iMsgs.step = '1'
    iMsgs.value = '0'
    iMsgs.title = 'A partir de quantas mensagens a IA pode comentar isso'
    iMsgs.setAttribute('aria-label', 'Mensagens mínimas antes de poder comentar')
    const msgs = el('label', 'nec-dias-campo')
    msgs.append(iMsgs, el('span', 'nec-espera-rot', 'mensagens'))
    const iCobrar = el('button', 'toggle sm')
    iCobrar.type = 'button'
    iCobrar.setAttribute('role', 'switch')
    iCobrar.setAttribute('aria-checked', 'false')
    iCobrar.setAttribute('aria-label', 'Tim pode cobrar (PIX) quem passar nas travas')
    const cobrarBox = el('label', 'nec-dias-campo nec-cobrar-campo')
    cobrarBox.append(iCobrar, el('span', 'nec-espera-rot', 'pode passar o PIX'))
    const pintarCobrar = () => {
      const on = iCobrar.getAttribute('aria-checked') === 'true'
      iCobrar.classList.toggle('on', on)
    }
    iCobrar.addEventListener('click', () => {
      iCobrar.setAttribute('aria-checked', iCobrar.getAttribute('aria-checked') === 'true' ? 'false' : 'true')
      pintarCobrar()
    })
    // A LINHA DE CONVERSA: o texto que ela usa pra contar essa situação (regra configurada,
    // 13/08/2026). Campo livre, opcional. Fica numa faixa própria porque é frase, não dado.
    const iLinha = el('textarea', 'nec-linha')
    // Nasce com uma linha e cresce conforme escreve: em duas linhas fixas, o campo ocupava
    // um bloco alto e vazio no meio do formulário só esperando texto que talvez nem venha.
    iLinha.rows = 1; iLinha.maxLength = 600
    iLinha.placeholder = 'Linha de conversa: como ela conta isso (opcional)'
    iLinha.setAttribute('aria-label', 'Linha de conversa')
    // HORÁRIO DE PREFERÊNCIA. A regra de fuso é interna; a UI só mostra o relógio operacional.
    // Nasce em "qualquer hora": janela é exceção, e exceção não pode ser o padrão da tela.
    const janelaForm = campoHorario(null, null)
    const tiposForm = campoTipos([])
    const preparoForm = campoPreparo(null)
    const crescerForm = () => crescerTextarea(iLinha)
    iLinha.addEventListener('input', crescerForm)
    requestAnimationFrame(crescerForm)
    ligarResizeDasLinhas()
    let editando = null
    const bAdd = el('button', 'btn primary', 'Adicionar')
    bAdd.type = 'button'
    const bCancelEdit = el('button', 'btn ghost nec-edit-cancel', 'Cancelar')
    bCancelEdit.type = 'button'
    bCancelEdit.hidden = true
    form.append(iDesc, iVal, iPrazoTipo, iPrazoData, dias, msgs, cobrarBox, bAdd, bCancelEdit, iLinha, janelaForm.el, tiposForm.el, preparoForm.el)
    wrap.appendChild(form)
    wrap.appendChild(el('p', 'nec-ajuda',
      'A espera vale por pessoa e tem três réguas: "dias de conversa" conta o tempo desde a primeira mensagem '
      + '(inclusive os dias em que ninguém falou nada), "dias com conversa" conta só os dias em que vocês se falaram '
      + 'de fato, e "dias com a IA ligada" conta desde que o interruptor da IA foi ligado — não a idade da conversa. '
      + 'Em 0, vale desde o começo. Mensagens mínimas é o tamanho da conversa, todos os canais juntos. '
      + 'Se "pode passar o PIX" estiver ligado, quem passar nas travas ganha autorização de cobrança com a linha desta necessidade. '
      + 'Fora isso, a IA só toca no assunto dinheiro depois de 24h de conversa e umas 20 mensagens, e só uma vez com cada pessoa.'))

    const limparForm = () => {
      editando = null
      iDesc.value = ''
      iVal.setCentavos(0)
      iPrazoTipo.value = ''
      iPrazoData.value = ''
      iDias.value = '0'
      iCrit.value = 'corridos'
      iMsgs.value = '0'
      iCobrar.setAttribute('aria-checked', 'false')
      pintarCobrar()
      iLinha.value = ''
      crescerForm()
      janelaForm.limpar()
      tiposForm.set([])
      preparoForm.limpar()
      syncPrazo()
      bAdd.textContent = 'Adicionar'
      bCancelEdit.hidden = true
      form.classList.remove('editando')
    }

    const editar = (n) => {
      editando = n.id
      iDesc.value = n.descricao || ''
      iVal.setCentavos(n.valor_centavos || 0)
      iPrazoTipo.value = n.prazoTipo || n.prazo_tipo || ''
      iPrazoData.value = n.prazoData || n.prazo_data || ''
      iDias.value = String(n.diasMinimos || 0)
      iCrit.value = n.diasCriterio || 'corridos'
      iMsgs.value = String(n.msgsMinimas || 0)
      iCobrar.setAttribute('aria-checked', n.cobrar ? 'true' : 'false')
      pintarCobrar()
      iLinha.value = n.linha || ''
      janelaForm.set(n.horaDe || null, n.horaAte || null)
      tiposForm.set(n.tipos || [])
      preparoForm.set(n)
      syncPrazo()
      crescerForm()
      bAdd.textContent = 'Salvar'
      bCancelEdit.hidden = false
      form.classList.add('editando')
      iDesc.focus()
      form.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }

    const salvar = async () => {
      const descricao = iDesc.value.trim()
      if (!descricao) { toast('Escreva o que está apertando.', 'err'); iDesc.focus(); return }
      if (iPrazoTipo.value && !iPrazoData.value) { toast('Escolha a data do vencimento.', 'err'); iPrazoData.focus(); return }
      bAdd.disabled = true
      const ok = await post('/api/necessidades', {
        id: editando || undefined,
        descricao,
        valorCentavos: Number(iVal.dataset.centavos) || 0,
        prazoTipo: iPrazoTipo.value || null,
        prazoData: iPrazoData.value || null,
        diasMinimos: Number(iDias.value) || 0,
        diasCriterio: iCrit.value,
        msgsMinimas: Number(iMsgs.value) || 0,
        cobrar: iCobrar.getAttribute('aria-checked') === 'true',
        linha: iLinha.value,
        horaDe: janelaForm.valor().de,
        horaAte: janelaForm.valor().ate,
        tipos: tiposForm.valor(),
        preparoMinutos: preparoForm.valor().minutos,
        preparoDias: preparoForm.valor().dias,
        preparoComo: preparoForm.valor().como,
      })
      bAdd.disabled = false
      if (!ok?.ok) { toast(ok?.erro || 'Não deu pra salvar.', 'err'); return }
      limparForm()
      carregarNecessidades()
    }
    bAdd.addEventListener('click', salvar)
    bCancelEdit.addEventListener('click', limparForm)
    // O textarea fica FORA desta lista de propósito: ali Enter é quebra de linha, porque a
    // linha de conversa pode ter duas bolhas.
    for (const campo of [iDesc, iVal, iPrazoTipo, iPrazoData, iDias, iCrit, iMsgs]) {
      campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); salvar() } })
    }
    syncPrazo()

    // ---- a lista
    if (!itens.length) {
      wrap.appendChild(el('p', 'nec-vazio', 'Nada anotado ainda. O que você colocar aqui fica salvo pra você e pode entrar no contexto da IA quando fizer sentido.'))
      return wrap
    }
    const lista = el('div', 'nec-lista')
    for (const n of itens) {
      const linha = el('div', `nec-item${n.status === 'resolvida' ? ' resolvida' : ''}`)
      const prazoLabel = n.prazoLabel || n.prazo || ''
      linha.appendChild(el('div', 'nec-item-txt', `
        <b>${esc(n.descricao)}</b>
        <span>${n.valor_centavos ? esc(n.valorFormatado) : 'sem valor'}${prazoLabel ? ` · ${esc(prazoLabel)}` : ''}</span>`))

      // A espera fica NA LINHA, editável ali mesmo: é um número que ele vai querer ajustar
      // olhando pra descrição, não numa tela de edição separada.
      const espera = el('label', 'nec-espera')
      const iE = el('input', 'nec-dias')
      iE.type = 'number'; iE.min = '0'; iE.max = '365'; iE.step = '1'
      iE.value = String(n.diasMinimos || 0)
      iE.setAttribute('aria-label', `Dias de conversa antes de comentar "${n.descricao}"`)
      // A legenda só aparece no zero. Com o número preenchido ela repetia o que o campo já
      // dizia ("5 dias" + "depois de 5 dias de conversa"), e repetição na linha é o que faz
      // uma lista curta parecer cheia.
      const cE = el('select', 'nec-criterio')
      cE.innerHTML = `
        <option value="corridos">dias de conversa</option>
        <option value="conversados">dias com conversa</option>
        <option value="ia">dias com a IA ligada</option>`
      cE.value = n.diasCriterio || 'corridos'
      cE.setAttribute('aria-label', `Régua da espera de "${n.descricao}"`)
      // A legenda só aparece no zero. Com número, o campo e a régua já dizem tudo, e
      // repetição na linha é o que faz uma lista curta parecer cheia.
      const legenda = el('span', 'nec-espera-txt', 'vale desde o começo')
      const semEspera = () => Number(iE.value) === 0
      legenda.hidden = !semEspera()
      cE.hidden = semEspera()   // sem espera, escolher régua de quê?
      espera.append(el('span', 'nec-espera-rot', 'Comenta a partir de'), iE, cE, legenda)

      const janela = campoHorario(n.horaDe || null, n.horaAte || null, async (v) => {
        const r = await post('/api/necessidades/horario', { id: n.id, de: v.de, ate: v.ate })
        if (!r?.ok) { toast(r?.erro || 'Não deu pra salvar o horário.', 'err'); return }
        toast(r.horaDe ? `Comenta ${r.horarioLabel}` : 'Comenta em qualquer hora')
      })
      espera.appendChild(janela.el)

      const tipos = campoTipos(n.tipos || [], async (lista) => {
        const r = await post('/api/necessidades/tipos', { id: n.id, tipos: lista })
        if (!r?.ok) { toast(r?.erro || 'Não deu pra salvar os tipos.', 'err'); return }
        toast(lista.length ? `Fala com ${lista.length} ${lista.length === 1 ? 'tipo' : 'tipos'} de pessoa` : 'Fala com todos')
      })
      espera.appendChild(tipos.el)

      const preparo = campoPreparo(n, async (v) => {
        const r = await post('/api/necessidades/preparo', { id: n.id, minutos: v.minutos, dias: v.dias, como: v.como })
        if (!r?.ok) { toast(r?.erro || 'Não deu pra salvar o preparo.', 'err'); return }
        toast(r.preparoMinutos ? `Cita ${r.preparoLabel}` : 'Cita sem preparo')
      })
      let ultimo = `${n.diasMinimos || 0}|${n.diasCriterio || 'corridos'}`
      const gravarDias = async () => {
        const v = String(Math.max(0, Math.min(365, Number(iE.value) || 0)))
        iE.value = v
        legenda.hidden = !semEspera(); cE.hidden = semEspera()
        const chave = `${v}|${cE.value}`
        if (chave === ultimo) return
        const r = await post('/api/necessidades/dias', { id: n.id, dias: Number(v), criterio: cE.value })
        if (!r?.ok) {
          const [d, c] = ultimo.split('|')
          iE.value = d; cE.value = c; legenda.hidden = !semEspera(); cE.hidden = semEspera()
          toast(r?.erro || 'Não deu pra salvar a espera.', 'err'); return
        }
        ultimo = chave
        toast(Number(v) ? `Só ${r.esperaLabel}` : 'Vale desde o começo')
      }
      iE.addEventListener('change', gravarDias)
      iE.addEventListener('blur', gravarDias)
      iE.addEventListener('input', () => { legenda.hidden = !semEspera(); cE.hidden = semEspera() })
      cE.addEventListener('change', gravarDias)
      iE.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); iE.blur() } })

      const iM = el('input', 'nec-dias')
      iM.type = 'number'; iM.min = '0'; iM.max = '100000'; iM.step = '1'
      iM.value = String(n.msgsMinimas || 0)
      iM.setAttribute('aria-label', `Mensagens mínimas antes de comentar "${n.descricao}"`)
      let ultimoMsg = String(n.msgsMinimas || 0)
      const gravarMsgs = async () => {
        const v = String(Math.max(0, Math.min(100000, Number(iM.value) || 0)))
        iM.value = v
        if (v === ultimoMsg) return
        const r = await post('/api/necessidades/msgs', { id: n.id, msgs: Number(v) })
        if (!r?.ok) { iM.value = ultimoMsg; toast(r?.erro || 'Não deu pra salvar as mensagens.', 'err'); return }
        ultimoMsg = v
        toast(Number(v) ? r.msgsLabel : 'Qualquer tamanho de conversa')
      }
      iM.addEventListener('change', gravarMsgs)
      iM.addEventListener('blur', gravarMsgs)
      iM.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); iM.blur() } })
      espera.append(el('span', 'nec-espera-rot', 'e'), iM, el('span', 'nec-espera-rot', 'msgs'))

      const tCobrar = el('button', `toggle sm${n.cobrar ? ' on' : ''}`)
      tCobrar.type = 'button'
      tCobrar.setAttribute('role', 'switch')
      tCobrar.setAttribute('aria-checked', n.cobrar ? 'true' : 'false')
      tCobrar.setAttribute('aria-label', `Pode passar o PIX em "${n.descricao}"`)
      const rotCobrar = el('span', 'nec-espera-rot', n.cobrar ? 'PIX ligado' : 'PIX off')
      tCobrar.addEventListener('click', async () => {
        const next = tCobrar.getAttribute('aria-checked') !== 'true'
        tCobrar.disabled = true
        const r = await post('/api/necessidades/cobrar', { id: n.id, cobrar: next })
        tCobrar.disabled = false
        if (!r?.ok) { toast(r?.erro || 'Não deu pra salvar a cobrança.', 'err'); return }
        tCobrar.setAttribute('aria-checked', next ? 'true' : 'false')
        tCobrar.classList.toggle('on', next)
        rotCobrar.textContent = next ? 'PIX ligado' : 'PIX off'
        const ap = r.aplicacao
        if (next && ap) toast(ap.ligadas ? `PIX ligado · ${ap.ligadas} pessoa(s)` : 'PIX ligado · ninguém passou nas travas ainda')
        else toast('PIX desligado nesta necessidade')
        carregarNecessidades()
      })
      espera.append(tCobrar, rotCobrar)

      linha.appendChild(espera)

      const acoes = el('div', 'nec-item-acoes')
      const bEdit = el('button', 'btn ghost', 'Editar')
      bEdit.type = 'button'
      bEdit.addEventListener('click', () => editar(n))
      const bStatus = el('button', 'btn ghost', n.status === 'resolvida' ? 'Reabrir' : 'Resolvida')
      bStatus.type = 'button'
      bStatus.addEventListener('click', async () => {
        await post('/api/necessidades/status', { id: n.id })
        carregarNecessidades()
      })
      const bDel = el('button', 'btn ghost perigo', 'Apagar')
      bDel.type = 'button'
      bDel.addEventListener('click', async () => {
        // diálogo próprio, nunca confirm() do navegador
        const sim = await descPergunta({ titulo: 'Apagar esta necessidade?', texto: n.descricao, confirmar: 'Apagar', perigo: true })
        if (!sim) return
        await api(`/api/necessidades?id=${n.id}`, { method: 'DELETE' })
        carregarNecessidades()
      })
      acoes.append(bEdit, bStatus, bDel)
      linha.appendChild(acoes)

      // A linha de conversa vive embaixo do item, na largura toda: é frase, e frase espremida
      // numa coluna de 150px não dá pra ler nem pra escrever.
      const linhaFala = el('div', 'nec-linha-box')
      const tl = el('textarea', 'nec-linha')
      tl.rows = 1; tl.maxLength = 600; tl.value = n.linha || ''
      tl.placeholder = 'Linha de conversa: como ela conta isso'
      tl.setAttribute('aria-label', `Linha de conversa de "${n.descricao}"`)
      const crescer = () => crescerTextarea(tl)
      let ultimaFala = tl.value
      const gravarLinha = async () => {
        if (tl.value === ultimaFala) return
        const r = await post('/api/necessidades/linha', { id: n.id, linha: tl.value })
        if (!r?.ok) { tl.value = ultimaFala; crescer(); toast(r?.erro || 'Não deu pra salvar a linha.', 'err'); return }
        ultimaFala = r.linha
        tl.value = r.linha
        crescer()
        toast(r.linha ? 'Linha de conversa salva' : 'Linha de conversa apagada')
      }
      tl.addEventListener('input', crescer)
      tl.addEventListener('blur', gravarLinha)
      linhaFala.appendChild(tl)
      linha.appendChild(linhaFala)
      linha.appendChild(preparo.el)
      requestAnimationFrame(crescer)

      lista.appendChild(linha)
    }
    wrap.appendChild(lista)
    return wrap
  }

  async function carregarNecessidades() {
    const host = document.querySelector('.cfg-nec-section .nec-host')
    if (!host) return
    const dados = await api('/api/necessidades')
    host.replaceChildren(renderNecessidades(dados))
  }

  // ---------------------------------------------------------------- PIX
  // Fica na Config porque é um dado da dona, não de uma conversa. O valor vem sempre do
  // banco; nenhum nome ou chave pessoal fica gravado neste arquivo.
  function renderPixConfig(pix) {
    const atual = pix || {}
    const wrap = el('div', 'pix-card')
    wrap.innerHTML = `
      <div class="pix-card-mark">${icon('i-phone', 'ico')}</div>
      <form class="pix-form" id="cfgPixForm">
        <div class="pix-field">
          <label for="cfgPixNome">Nome que aparece no PIX</label>
          <input class="field" id="cfgPixNome" type="text" maxlength="120" autocomplete="name" value="${esc(atual.nome || '')}" placeholder="Nome do titular">
        </div>
        <div class="pix-field pix-field-chave">
          <label for="cfgPixChave">Chave PIX</label>
          <span class="pix-key-row">
            <input class="field" id="cfgPixChave" type="text" maxlength="150" inputmode="text" autocomplete="off" spellcheck="false" value="${esc(atual.chave || '')}" placeholder="Telefone, CPF, e-mail ou chave aleatória">
            <button class="btn ghost small pix-copy" type="button" ${atual.chave ? '' : 'disabled'}>Copiar chave</button>
          </span>
        </div>
        <div class="pix-actions">
          <small class="pix-status">${atual.atualizadoEm ? `Salvo no sistema · ${esc(new Date(atual.atualizadoEm).toLocaleString('pt-BR'))}` : 'Ainda não há uma chave salva.'}</small>
          <button class="btn primary pix-save" type="submit">Salvar PIX</button>
        </div>
      </form>`

    const form = $('#cfgPixForm', wrap)
    const nome = $('#cfgPixNome', wrap)
    const chave = $('#cfgPixChave', wrap)
    const copiar = $('.pix-copy', wrap)
    const status = $('.pix-status', wrap)

    copiar.addEventListener('click', async () => {
      const valor = chave.value.trim()
      if (!valor) return
      try { await navigator.clipboard.writeText(valor); toast('Chave PIX copiada.') }
      catch { chave.focus(); chave.select(); toast('Chave selecionada. Use copiar no seu aparelho.') }
    })
    chave.addEventListener('input', () => { copiar.disabled = !chave.value.trim() })
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      if (!nome.value.trim()) { toast('Informe o nome que aparece no PIX.', 'err'); nome.focus(); return }
      if (!chave.value.trim()) { toast('Informe a chave PIX.', 'err'); chave.focus(); return }
      const r = await post('/api/config/pix', { nome: nome.value, chave: chave.value })
      if (!r?.ok) { toast(r?.erro || 'Não deu pra salvar o PIX.', 'err'); return }
      nome.value = r.pix.nome
      chave.value = r.pix.chave
      copiar.disabled = false
      status.textContent = `Salvo no sistema · ${new Date(r.pix.atualizadoEm).toLocaleString('pt-BR')}`
      toast('Dados do PIX salvos no sistema.')
    })
    return wrap
  }

  // ---------------------------------------------------------------- ETIQUETAS
  // Marcas que quem opera põe nas pessoas para agrupar por conta própria. NÃO são as etiquetas
  // do WhatsApp: aquelas são recurso do WhatsApp Business (a conta aqui é o app comum) e só
  // valeriam num canal. Estas valem em todos, porque a chave é a pessoa, não a conversa.
  //
  // Diferente do "Contexto" (vínculo), que é UM por pessoa e escolhe o registro de fala: aqui
  // são várias, livres, e servem para acionar coisas — hoje, serviços.
  let ETIQUETAS = null          // cache da sessão; null = ainda não carregou

  async function carregarEtiquetas(force = false) {
    if (ETIQUETAS && !force) return ETIQUETAS
    const r = await api('/api/etiquetas').catch(() => null)
    ETIQUETAS = Array.isArray(r?.etiquetas) ? r.etiquetas : []
    return ETIQUETAS
  }

  const CORES_ETIQUETA = ['verde', 'azul', 'roxo', 'rosa', 'ambar', 'vermelho', 'cinza']

  function pastilhaEtiqueta(etq, { removivel = false, onRemove = null } = {}) {
    const chip = el('span', `etq-chip cor-${CORES_ETIQUETA.includes(etq.cor) ? etq.cor : 'cinza'}`)
    chip.appendChild(el('span', 'etq-chip-txt', esc(etq.nome)))
    if (removivel) {
      const x = el('button', 'etq-chip-x', icon('i-x', 'ico ico-sm'))
      x.type = 'button'
      x.title = `Tirar a etiqueta ${etq.nome}`
      x.addEventListener('click', (e) => { e.stopPropagation(); onRemove && onRemove(etq) })
      chip.appendChild(x)
    }
    return chip
  }

  function renderEtiquetasConfig() {
    const wrap = el('div', 'etq-card')
    const lista = el('div', 'etq-lista')
    const novo = el('form', 'etq-novo')
    let corEscolhida = 'verde'

    const nome = el('input', 'field etq-novo-nome')
    nome.type = 'text'; nome.maxLength = 40; nome.placeholder = 'Nome da etiqueta (ex: Cliente VIP)'
    nome.autocomplete = 'off'

    const cores = el('div', 'etq-cores')
    const pintarCores = () => {
      cores.replaceChildren(...CORES_ETIQUETA.map((c) => {
        const b = el('button', `etq-cor cor-${c}${c === corEscolhida ? ' on' : ''}`)
        b.type = 'button'; b.title = c
        b.setAttribute('aria-label', `cor ${c}`)
        b.setAttribute('aria-pressed', c === corEscolhida ? 'true' : 'false')
        b.addEventListener('click', () => { corEscolhida = c; pintarCores() })
        return b
      }))
    }
    pintarCores()

    const criar = el('button', 'btn primary small', 'Criar etiqueta')
    criar.type = 'submit'
    novo.append(nome, cores, criar)
    novo.addEventListener('submit', async (e) => {
      e.preventDefault()
      const valor = nome.value.trim()
      if (!valor) { toast('Dê um nome para a etiqueta.', 'err'); nome.focus(); return }
      const r = await post('/api/etiquetas', { nome: valor, cor: corEscolhida })
      if (!r?.ok) { toast(r?.erro || 'Não deu pra criar a etiqueta.', 'err'); return }
      ETIQUETAS = r.etiquetas
      nome.value = ''
      pintarEtiquetas()
      toast(`Etiqueta "${valor}" criada.`)
    })

    function linhaEtiqueta(etq) {
      const linha = el('div', 'etq-linha' + (etq.sistema ? ' etq-sistema' : ''))
      const chip = pastilhaEtiqueta(etq)
      const campoNome = el('input', 'field etq-nome')
      campoNome.type = 'text'; campoNome.value = etq.nome; campoNome.maxLength = 40
      if (etq.sistema || etq.tipo === 'cidade') {
        campoNome.readOnly = true
        campoNome.title = etq.sistema
          ? 'Etiqueta da linhagem: o nome não muda, as regras vêm do código'
          : 'Cidade da pessoa — o nome é a cidade, uma verdade por identidade'
      }
      const salvarNome = async () => {
        if (etq.sistema) { campoNome.value = etq.nome; return }
        const v = campoNome.value.trim()
        if (!v || v === etq.nome) { campoNome.value = etq.nome; return }
        const r = await post('/api/etiquetas/editar', { id: etq.id, nome: v })
        if (!r?.ok) { toast(r?.erro || 'Não deu pra renomear.', 'err'); campoNome.value = etq.nome; return }
        ETIQUETAS = r.etiquetas; pintarEtiquetas(); toast('Etiqueta renomeada.')
      }
      campoNome.addEventListener('blur', salvarNome)
      campoNome.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); campoNome.blur() } })

      const paleta = el('div', 'etq-cores etq-cores-linha')
      paleta.replaceChildren(...CORES_ETIQUETA.map((c) => {
        const b = el('button', `etq-cor cor-${c}${c === etq.cor ? ' on' : ''}`)
        b.type = 'button'; b.title = c; b.setAttribute('aria-label', `cor ${c}`)
        b.addEventListener('click', async () => {
          const r = await post('/api/etiquetas/editar', { id: etq.id, cor: c })
          if (!r?.ok) { toast(r?.erro || 'Não deu pra trocar a cor.', 'err'); return }
          ETIQUETAS = r.etiquetas; pintarEtiquetas()
        })
        return b
      }))

      // A contagem é botão: ela abre QUEM está marcado. Número sozinho não mostra a etiqueta
      // que ficou na pessoa errada.
      const quantas = el('button', 'btn ghost small etq-pessoas',
        `${icon('i-users', 'ico ico-sm')}<span>${etq.pessoas} ${etq.pessoas === 1 ? 'pessoa' : 'pessoas'}</span>`)
      quantas.type = 'button'
      const gaveta = el('div', 'etq-gaveta')
      quantas.addEventListener('click', async () => {
        if (gaveta.dataset.aberta === '1') { gaveta.replaceChildren(); gaveta.dataset.aberta = '0'; return }
        gaveta.dataset.aberta = '1'
        gaveta.replaceChildren(el('small', 'etq-gaveta-vazia', 'carregando…'))
        const r = await api(`/api/etiquetas/pessoas?id=${encodeURIComponent(etq.id)}`).catch(() => null)
        const pessoas = r?.pessoas || []
        gaveta.replaceChildren(pessoas.length
          ? el('div', 'etq-gaveta-nomes', pessoas.map((p) => `<span>${esc(p.nome)}</span>`).join(''))
          : el('small', 'etq-gaveta-vazia', 'Ninguém com esta etiqueta ainda. Marque pelo menu Contexto de uma conversa.'))
      })

      const apagar = el('button', 'btn ghost small danger etq-del', 'Apagar')
      apagar.type = 'button'
      if (etq.sistema) {
        apagar.disabled = true
        apagar.title = 'Etiqueta da linhagem — vai em todo clone e não se apaga'
      } else {
        apagar.addEventListener('click', () => confirmDestructive(apagar, 'Apagar', async () => {
          const r = await del(`/api/etiquetas?id=${encodeURIComponent(etq.id)}`)
          if (!r?.ok) { toast(r?.erro || 'Não deu pra apagar.', 'err'); return }
          ETIQUETAS = r.etiquetas; pintarEtiquetas()
          toast(`Etiqueta apagada${r.marcasRemovidas ? ` (saiu de ${r.marcasRemovidas} ${r.marcasRemovidas === 1 ? 'pessoa' : 'pessoas'})` : ''}.`)
        }))
      }

      // REGRAS: o que a pessoa precisa escrever para ganhar esta etiqueta sozinha. Duas
      // formas, e a diferença importa: "contém" acha a palavra no meio da frase; "é
      // exatamente" só casa quando a mensagem inteira é aquilo.
      const regras = el('button', 'btn ghost small etq-regras',
        `${icon('i-spark', 'ico ico-sm')}<span>Automático</span>`)
      regras.type = 'button'
      const painelRegras = el('div', 'etq-regras-painel')
      regras.addEventListener('click', async () => {
        if (painelRegras.dataset.aberto === '1') { painelRegras.replaceChildren(); painelRegras.dataset.aberto = '0'; return }
        painelRegras.dataset.aberto = '1'
        painelRegras.replaceChildren(el('small', 'etq-gaveta-vazia', 'carregando…'))
        const r = await api(`/api/etiquetas/regras?id=${encodeURIComponent(etq.id)}`).catch(() => null)
        const lista = r?.regras || []
        const editor = el('div', 'etq-regras-lista')

        const linhaRegra = (regra) => {
          const l = el('div', 'etq-regra')
          // Alternador de dois estados, componente nosso — nada de <select> nativo.
          const tipo = el('button', 'etq-regra-tipo')
          tipo.type = 'button'
          const pintaTipo = () => {
            tipo.textContent = regra.tipo === 'exata' ? 'é exatamente' : 'contém'
            tipo.title = regra.tipo === 'exata'
              ? 'a mensagem inteira precisa ser essa frase'
              : 'basta a palavra ou expressão aparecer na mensagem'
          }
          pintaTipo()
          tipo.addEventListener('click', () => { regra.tipo = regra.tipo === 'exata' ? 'contem' : 'exata'; pintaTipo() })
          const txt = el('input', 'field etq-regra-txt')
          txt.type = 'text'; txt.value = regra.texto || ''; txt.maxLength = 120
          txt.placeholder = regra.tipo === 'exata' ? 'bora marcar' : 'pernoite'
          txt.addEventListener('input', () => { regra.texto = txt.value })
          const tirar = el('button', 'btn ghost icon', icon('i-trash', 'ico ico-sm'))
          tirar.type = 'button'; tirar.title = 'Remover esta regra'
          tirar.addEventListener('click', () => { lista.splice(lista.indexOf(regra), 1); pintarRegras() })
          l.append(tipo, txt, tirar)
          return l
        }

        function pintarRegras() {
          editor.replaceChildren(...lista.map(linhaRegra))
          if (!lista.length) editor.appendChild(el('small', 'etq-gaveta-vazia',
            'Sem regra: esta etiqueta só entra quando você marcar à mão.'))
        }
        pintarRegras()

        const add = el('button', 'btn ghost small', `${icon('i-plus', 'ico ico-sm')}<span>Nova regra</span>`)
        add.type = 'button'
        add.addEventListener('click', () => { lista.push({ tipo: 'contem', texto: '' }); pintarRegras() })
        const salvar = el('button', 'btn primary small', 'Salvar regras')
        salvar.type = 'button'
        salvar.addEventListener('click', async () => {
          const rr = await post('/api/etiquetas/regras', { id: etq.id, regras: lista })
          if (!rr?.ok) { toast(rr?.erro || 'Não deu pra salvar as regras.', 'err'); return }
          toast(rr.regras.length
            ? `${rr.regras.length} ${rr.regras.length === 1 ? 'regra ativa' : 'regras ativas'} em "${etq.nome}"`
            : `"${etq.nome}" voltou a ser só manual.`)
        })
        const rodape = el('div', 'etq-regras-rodape')
        rodape.append(add, salvar)
        const ajuda = el('small', 'etq-regras-ajuda', etq.sistema
          ? 'Esta é da linhagem: as regras vêm do código (origem do anúncio) e o histórico já é varrido no boot. Tirar de alguém continua sendo decisão sua.'
          : 'Vale para mensagens RECEBIDAS de agora em diante, em qualquer canal. A regra só coloca a etiqueta — tirar continua sendo decisão sua.')
        if (etq.sistema) {
          for (const inp of editor.querySelectorAll('input, button')) inp.disabled = true
          painelRegras.replaceChildren(editor, ajuda)
        } else {
          painelRegras.replaceChildren(editor, rodape, ajuda)
        }
      })

      const jeito = el('button', 'btn ghost small etq-jeito',
        `${icon('i-spark', 'ico ico-sm')}<span>Jeito</span>`)
      jeito.type = 'button'
      const painelJeito = el('div', 'etq-regras-painel')
      if (etq.tipo === 'cidade') {
        jeito.disabled = true
        jeito.title = 'Cidade não tem jeito de conversa'
      } else {
        jeito.addEventListener('click', async () => {
          if (painelJeito.dataset.aberto === '1') { painelJeito.replaceChildren(); painelJeito.dataset.aberto = '0'; return }
          painelJeito.dataset.aberto = '1'
          painelJeito.replaceChildren(el('small', 'etq-gaveta-vazia', 'carregando…'))
          const r = await api(`/api/etiquetas/comportamento?id=${encodeURIComponent(etq.id)}`).catch(() => null)
          const area = el('textarea', 'field etq-jeito-txt')
          area.rows = 4
          area.maxLength = 700
          area.placeholder = 'Como a IA deve conversar com quem tem esta etiqueta (só esta instância).'
          area.value = r?.comportamento || etq.comportamento || ''
          const salvarJeito = el('button', 'btn primary small', 'Salvar jeito')
          salvarJeito.type = 'button'
          salvarJeito.addEventListener('click', async () => {
            const rr = await post('/api/etiquetas/comportamento', { id: etq.id, texto: area.value })
            if (!rr?.ok) { toast(rr?.erro || 'Não deu pra salvar o jeito.', 'err'); return }
            etq.comportamento = rr.comportamento
            toast(rr.comportamento ? `Jeito de "${etq.nome}" salvo.` : `"${etq.nome}" sem jeito especial.`)
          })
          const ajudaJeito = el('small', 'etq-regras-ajuda',
            'Entra no prompt só quando ESTA pessoa tem a etiqueta. Cada marca pode ter um jeito. Preço e serviço continuam na tabela de Grana.')
          const rodapeJeito = el('div', 'etq-regras-rodape')
          rodapeJeito.append(salvarJeito)
          painelJeito.replaceChildren(area, rodapeJeito, ajudaJeito)
        })
      }

      linha.append(chip, campoNome, paleta, quantas, regras, jeito, apagar, gaveta, painelRegras, painelJeito)
      return linha
    }

    function pintarEtiquetas() {
      const itens = ETIQUETAS || []
      lista.replaceChildren(...itens.map(linhaEtiqueta))
      if (!itens.length) {
        lista.appendChild(el('p', 'etq-vazio', ETIQUETAS === null
          ? 'carregando…'
          : 'Nenhuma etiqueta ainda. Crie a primeira acima e marque as pessoas pelo menu Contexto de cada conversa.'))
      }
    }

    pintarEtiquetas()
    wrap.append(novo, lista)
    carregarEtiquetas(true).then(pintarEtiquetas).catch(() => { ETIQUETAS = []; pintarEtiquetas() })
    return wrap
  }

  // ---------------------------------------------------------------- SERVIÇOS
  // O que ela faz e quanto cobra. O desenho do gestor: um MESMO serviço costuma ter preços
  // diferentes conforme o tempo (1 hora, 2 horas, pernoite), então cada serviço carrega uma
  // lista de faixas em vez de um preço só.
  //
  // DINHEIRO NUNCA É FLOAT AQUI. O campo digita em reais e o estado guarda CENTAVOS inteiros;
  // a conversão acontece uma vez, na digitação. É a mesma regra do resto da casa: valor
  // financeiro que passa por ponto flutuante volta com centavo faltando.
  const valorEmReais = (centavos) =>
    ((Number(centavos) || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  function renderServicosConfig(servicos) {
    const estado = {
      itens: (servicos?.itens || []).map((s) => ({
        nome: String(s.nome || ''),
        obs: String(s.obs || ''),
        local: String(s.local || ''),
        endereco: String(s.endereco || ''),
        atendeEm: s.atendeEm || null,
        locais: (s.locais || []).map((l) => ({
          nome: String(l.nome || ''), valorCentavos: Number(l.valorCentavos) || 0,
          quemPaga: l.quemPaga || null, endereco: String(l.endereco || ''),
          enderecoPublico: l.enderecoPublico === true, obs: String(l.obs || ''),
        })),
        faixas: (s.faixas || []).map((f) => ({ tempo: String(f.tempo || ''), centavos: Number(f.centavos) || 0, minutos: Number(f.minutos) || 0 })),
        folgaAntesMin: Number(s.folgaAntesMin) || 0,
        folgaDepoisMin: Number(s.folgaDepoisMin) || 0,
        fotos: (s.fotos || []).map((x) => String(x || '').trim()).filter(Boolean),
        etiquetas: (s.etiquetas || []).map(Number).filter(Number.isInteger),
        palavras: (s.palavras || []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean),
        tipo: s.tipo || 'presencial',
        entrega: {
          link: String(s.entrega?.link || ''),
          instrucao: String(s.entrega?.instrucao || ''),
          fotos: (s.entrega?.fotos || []).map((x) => String(x || '').trim()).filter(Boolean),
        },
      })),
    }
    // As fotos chegam depois: a Config já está na tela quando a lista responde. `null` é
    // "ainda não sei", diferente de `[]`, que é "não há foto salva" — dizer "nenhuma foto"
    // enquanto a resposta está no ar seria mentir por um segundo.
    let fotosSalvas = null

    const wrap = el('div', 'srv-card')
    const lista = el('div', 'srv-list')
    const rodape = el('div', 'srv-actions')
    const status = el('small', 'srv-status', servicos?.atualizadoEm
      ? `Salvo no sistema · ${esc(new Date(servicos.atualizadoEm).toLocaleString('pt-BR'))}`
      : 'Nenhum serviço cadastrado ainda.')
    const addServico = el('button', 'btn ghost small srv-add', `${icon('i-plus', 'ico ico-sm')}<span>Adicionar serviço</span>`)
    addServico.type = 'button'
    const salvar = el('button', 'btn primary srv-save', 'Salvar serviços')
    salvar.type = 'button'
    rodape.append(addServico, status, salvar)

    function campo(valor, placeholder, maxlength, aoMudar, cls = '') {
      const input = el('input', `field ${cls}`.trim())
      input.type = 'text'
      input.value = valor || ''
      input.placeholder = placeholder
      input.maxLength = maxlength
      input.autocomplete = 'off'
      input.spellcheck = false
      input.addEventListener('input', () => aoMudar(input.value))
      return input
    }

    // Faixa = um tempo e o preço dele. O botão de remover é SVG, como todo ícone da casa.
    function linhaFaixa(servico, faixa) {
      const linha = el('div', 'srv-faixa')
      const tempo = campo(faixa.tempo, 'Tempo (ex: 1 hora)', 40, (v) => { faixa.tempo = v }, 'srv-tempo')

      const moeda = el('span', 'srv-moeda')
      const prefixo = el('span', 'srv-prefixo', 'R$')
      const valor = el('input', 'field srv-valor')
      valor.type = 'text'
      valor.inputMode = 'numeric'
      valor.autocomplete = 'off'
      valor.placeholder = '0,00'
      valor.value = faixa.centavos ? valorEmReais(faixa.centavos) : ''
      // Máscara de centavos: os dígitos entram pela direita, como numa calculadora — quem
      // digita 15000 vê 150,00 e o estado guarda 15000 centavos, sem passar por float.
      valor.addEventListener('input', () => {
        const digitos = valor.value.replace(/\D+/g, '').slice(0, 10)
        faixa.centavos = digitos ? Number(digitos) : 0
        valor.value = faixa.centavos ? valorEmReais(faixa.centavos) : ''
        valor.setSelectionRange(valor.value.length, valor.value.length)
      })
      moeda.append(prefixo, valor)

      const remover = el('button', 'btn ghost icon srv-del-faixa', icon('i-trash', 'ico ico-sm'))
      remover.type = 'button'
      remover.title = 'Remover este tempo'
      remover.addEventListener('click', () => {
        if (servico.faixas.length === 1) { toast('Cada serviço precisa de pelo menos um tempo.', 'err'); return }
        servico.faixas.splice(servico.faixas.indexOf(faixa), 1)
        pintarServicos()
      })

      const min = Number(faixa.minutos) || 0
      if (min) {
        const dica = el('small', 'srv-faixa-min', `${min} min na agenda`)
        linha.append(tempo, moeda, remover, dica)
      } else {
        linha.append(tempo, moeda, remover)
      }
      return linha
    }

    function blocoFolga(servico) {
      const caixa = el('div', 'srv-folga')
      const num = (valor, rotulo, set) => {
        const wrap = el('label', 'srv-folga-item')
        const inp = el('input', 'field srv-folga-n')
        inp.type = 'number'
        inp.min = '0'
        inp.max = '240'
        inp.step = '5'
        inp.value = String(valor || 0)
        inp.setAttribute('aria-label', rotulo)
        inp.addEventListener('input', () => {
          const n = Math.max(0, Math.min(240, Number(inp.value) || 0))
          set(n)
        })
        wrap.append(el('span', 'srv-folga-lbl', rotulo), inp, el('span', 'srv-folga-un', 'min'))
        return wrap
      }
      caixa.append(
        el('div', 'srv-fotos-head', '<span>Folga na agenda</span><small>tempo LIVRE além do atendimento, pra deslocar ou arrumar. 0 = só a duração da faixa.</small>'),
        num(servico.folgaAntesMin, 'Antes', (n) => { servico.folgaAntesMin = n }),
        num(servico.folgaDepoisMin, 'Depois', (n) => { servico.folgaDepoisMin = n }),
      )
      return caixa
    }

    function linhaServico(servico) {
      const bloco = el('div', 'srv-item')
      const cabeca = el('div', 'srv-item-head')
      const nome = campo(servico.nome, 'Nome do serviço', 80, (v) => { servico.nome = v }, 'srv-nome')
      const apagar = el('button', 'btn ghost icon srv-del', icon('i-trash', 'ico ico-sm'))
      apagar.type = 'button'
      apagar.title = 'Remover este serviço'
      apagar.addEventListener('click', () => {
        estado.itens.splice(estado.itens.indexOf(servico), 1)
        pintarServicos()
      })
      cabeca.append(nome, apagar)

      const obs = campo(servico.obs, 'Observação (opcional) — o que está incluso', 280, (v) => { servico.obs = v }, 'srv-obs')

      // PRESENCIAL OU ENTREGÁVEL, declarado. Antes era dedução ("tem link, então é entregue"),
      // e dedução não serve para a IA saber como falar do serviço.
      const TIPOS_UI = [
        { valor: 'presencial', label: 'Presencial', dica: 'acontece ao vivo' },
        { valor: 'online', label: 'Online', dica: 'você entrega link, fotos ou arquivo' },
        { valor: 'ambos', label: 'Os dois', dica: 'acontece ao vivo e ainda entrega algo' },
      ]
      const tipos = el('div', 'srv-tipos')
      const pintarTipos = () => {
        tipos.replaceChildren(...TIPOS_UI.map((t) => {
          const b = el('button', `srv-tipo${(servico.tipo || 'presencial') === t.valor ? ' on' : ''}`,
            `<span>${t.label}</span><small>${t.dica}</small>`)
          b.type = 'button'
          b.setAttribute('aria-pressed', (servico.tipo || 'presencial') === t.valor ? 'true' : 'false')
          b.addEventListener('click', () => { servico.tipo = t.valor; pintarTipos() })
          return b
        }))
      }
      pintarTipos()

      const faixas = el('div', 'srv-faixas')
      for (const f of servico.faixas) faixas.appendChild(linhaFaixa(servico, f))

      const addFaixa = el('button', 'btn ghost small srv-add-faixa', `${icon('i-clock', 'ico ico-sm')}<span>Outro tempo</span>`)
      addFaixa.type = 'button'
      addFaixa.addEventListener('click', () => {
        if (servico.faixas.length >= 12) { toast('O máximo é 12 tempos por serviço.', 'err'); return }
        servico.faixas.push({ tempo: '', centavos: 0 })
        pintarServicos()
      })

      bloco.append(cabeca, obs, tipos, faixas, addFaixa, blocoLugar(servico), blocoFolga(servico), blocoFotos(servico), blocoGatilhos(servico), blocoEntrega(servico))
      return bloco
    }

    // ONDE O SERVIÇO ACONTECE. Dois campos com políticas diferentes, e a tela DIZ qual é qual:
    // a referência a IA pode falar; o endereço exato não sai na conversa — ele viaja junto do
    // compromisso quando o horário é confirmado.
    function blocoLugar(servico) {
      const caixa = el('div', 'srv-lugar')
      caixa.appendChild(el('div', 'srv-fotos-head',
        '<span>Onde acontece</span><small>a referência a IA pode dizer na conversa; o endereço exato ela nunca manda</small>'))

      const ATENDE_UI = [
        { valor: 'meu_espaco', label: 'No meu espaço', dica: 'a pessoa vai até você' },
        { valor: 'vou_ate', label: 'Vou até a pessoa', dica: 'você se desloca' },
        { valor: 'combinar', label: 'A combinar', dica: 'decide na hora' },
      ]
      const chips = el('div', 'srv-tipos')
      const pintarChips = () => {
        chips.replaceChildren(...ATENDE_UI.map((t) => {
          const b = el('button', `srv-tipo${servico.atendeEm === t.valor ? ' on' : ''}`, `<span>${t.label}</span><small>${t.dica}</small>`)
          b.type = 'button'
          b.setAttribute('aria-pressed', servico.atendeEm === t.valor ? 'true' : 'false')
          // Clicar no que já está escolhido desmarca: sem isso não dá pra voltar ao "não disse".
          b.addEventListener('click', () => { servico.atendeEm = servico.atendeEm === t.valor ? null : t.valor; pintarChips() })
          return b
        }))
      }
      pintarChips()

      const linhaRef = el('div', 'srv-gat-linha')
      linhaRef.appendChild(el('span', 'srv-gat-rot', 'Referência'))
      const ref = el('input', 'field')
      ref.type = 'text'; ref.value = servico.local || ''; ref.maxLength = 160
      ref.placeholder = 'ex.: meu espaço, no centro da cidade'
      ref.addEventListener('input', () => { servico.local = ref.value })
      linhaRef.appendChild(ref)

      const linhaEnd = el('div', 'srv-gat-linha')
      linhaEnd.appendChild(el('span', 'srv-gat-rot', 'Endereço exato'))
      const end = el('input', 'field')
      end.type = 'text'; end.value = servico.endereco || ''; end.maxLength = 240
      end.placeholder = 'rua, número, complemento — fica só com você'
      end.autocomplete = 'off'
      end.addEventListener('input', () => { servico.endereco = end.value })
      linhaEnd.appendChild(end)

      caixa.append(chips, linhaRef, linhaEnd)
      caixa.appendChild(el('p', 'srv-lugar-nota', 'O endereço exato não entra no contexto da IA. Ele acompanha o compromisso na agenda quando você confirma o horário.'))

      // LUGARES COM PREÇO PRÓPRIO. O valor é do lugar (motel, diária, sala), nunca do
      // serviço: some ao seu valor só se você disser que soma.
      servico.locais = servico.locais || []
      const host = el('div', 'srv-locais')
      host.appendChild(el('div', 'srv-fotos-head',
        '<span>Lugares com valor próprio</span><small>o preço do lugar é outra conta; a IA fala os dois separados</small>'))
      const lista = el('div', 'srv-locais-lista')
      const PAGA_UI = [
        { valor: 'pessoa', label: 'ela paga lá' },
        { valor: 'somado', label: 'soma ao meu' },
        { valor: 'incluso', label: 'já incluso' },
      ]
      const pintarLocais = () => {
        lista.replaceChildren(...servico.locais.map((loc) => {
          const linha = el('div', 'srv-local-item')
          const nome = el('input', 'field srv-local-nome')
          nome.type = 'text'; nome.value = loc.nome || ''; nome.maxLength = 160
          nome.placeholder = 'nome do lugar (ex.: motel Serenata)'
          nome.addEventListener('input', () => { loc.nome = nome.value })

          const moeda = el('input', 'field srv-local-valor')
          moeda.type = 'text'; moeda.inputMode = 'numeric'
          moeda.value = valorEmReais(loc.valorCentavos)
          moeda.setAttribute('aria-label', 'Valor do lugar em reais')
          moeda.addEventListener('input', () => {
            const so = moeda.value.replace(/\D+/g, '')
            loc.valorCentavos = Number(so) || 0
            moeda.value = valorEmReais(loc.valorCentavos)
            pintarQuem()
          })

          const quem = el('div', 'srv-tipos srv-local-quem')
          const pintarQuem = () => {
            quem.hidden = !loc.valorCentavos
            quem.replaceChildren(...PAGA_UI.map((t) => {
              const b = el('button', `srv-tipo${(loc.quemPaga || 'pessoa') === t.valor ? ' on' : ''}`, `<span>${t.label}</span>`)
              b.type = 'button'
              b.setAttribute('aria-pressed', (loc.quemPaga || 'pessoa') === t.valor ? 'true' : 'false')
              b.addEventListener('click', () => { loc.quemPaga = t.valor; pintarQuem() })
              return b
            }))
          }
          pintarQuem()

          const end = el('input', 'field srv-local-end')
          end.type = 'text'; end.value = loc.endereco || ''; end.maxLength = 240
          end.placeholder = 'endereço deste lugar'
          end.addEventListener('input', () => { loc.endereco = end.value; pintarPublico() })

          // A exceção declarada: por padrão endereço não vai para a IA, mas um motel que
          // qualquer um acha no mapa não é a casa dela. O interruptor é por LUGAR.
          const publico = el('button', 'srv-local-publico')
          publico.type = 'button'
          const pintarPublico = () => {
            const podeMarcar = !!String(loc.endereco || '').trim()
            if (!podeMarcar) loc.enderecoPublico = false
            publico.disabled = !podeMarcar
            publico.classList.toggle('on', loc.enderecoPublico === true)
            publico.setAttribute('aria-pressed', loc.enderecoPublico === true ? 'true' : 'false')
            publico.innerHTML = `${icon(loc.enderecoPublico ? 'i-check' : 'i-x', 'ico ico-sm')}<span>${
              loc.enderecoPublico ? 'a IA pode dizer este endereço se perguntarem' : 'endereço fica só com você'}</span>`
          }
          publico.addEventListener('click', () => { loc.enderecoPublico = !loc.enderecoPublico; pintarPublico() })
          pintarPublico()

          const apagar = el('button', 'btn ghost icon srv-del', icon('i-trash', 'ico ico-sm'))
          apagar.type = 'button'
          apagar.title = 'Remover este lugar'
          apagar.addEventListener('click', () => { servico.locais.splice(servico.locais.indexOf(loc), 1); pintarLocais() })

          linha.append(nome, el('span', 'srv-local-rs', 'R$'), moeda, apagar, quem, end, publico)
          return linha
        }))
      }
      pintarLocais()
      const addLocal = el('button', 'btn ghost small', `${icon('i-pin', 'ico ico-sm')}<span>Outro lugar</span>`)
      addLocal.type = 'button'
      addLocal.addEventListener('click', () => {
        if (servico.locais.length >= 8) { toast('O máximo é 8 lugares por serviço.', 'err'); return }
        servico.locais.push({ nome: '', valorCentavos: 0, quemPaga: 'pessoa', endereco: '', enderecoPublico: false, obs: '' })
        pintarLocais()
      })
      host.append(lista, addLocal)
      caixa.appendChild(host)
      return caixa
    }

    // O QUE A PESSOA RECEBE. Isto NÃO vai para a IA: link, instruções e fotos com direito de
    // uso são o produto, e produto só sai quando você manda sair, pelo botão "Entregar" do menu
    // Contexto da conversa. A IA nem sabe que existe — é o que garante que ela não entregue
    // para quem não pagou.
    function blocoEntrega(servico) {
      servico.entrega = servico.entrega || { link: '', instrucao: '', fotos: [] }
      const e = servico.entrega
      const caixa = el('div', 'srv-entrega')
      const temAlgo = !!(String(e.link || '').trim() || String(e.instrucao || '').trim() || (e.fotos || []).length)
      caixa.appendChild(el('div', 'srv-fotos-head',
        `<span>O que a pessoa recebe</span><small>${temAlgo
          ? 'entregue por você, pelo menu Contexto da conversa — a IA nunca manda isto'
          : 'nada configurado: este serviço não tem entrega'}</small>`))

      const linhaLink = el('div', 'srv-gat-linha')
      linhaLink.appendChild(el('span', 'srv-gat-rot', 'Link de acesso'))
      const link = el('input', 'field')
      link.type = 'text'; link.value = e.link || ''; link.maxLength = 500
      link.placeholder = 'https://... (pasta, galeria, área de membros)'
      link.autocomplete = 'off'; link.spellcheck = false
      link.addEventListener('input', () => { e.link = link.value.trim() })
      linhaLink.appendChild(link)

      const linhaTxt = el('div', 'srv-gat-linha')
      linhaTxt.appendChild(el('span', 'srv-gat-rot', 'Instruções'))
      const instr = el('textarea', 'field srv-entrega-txt')
      instr.value = e.instrucao || ''; instr.maxLength = 800; instr.rows = 2
      instr.placeholder = 'o que está incluso, senha, validade, regras de uso da imagem'
      instr.addEventListener('input', () => { e.instrucao = instr.value })
      linhaTxt.appendChild(instr)

      const linhaFotos = el('div', 'srv-gat-linha srv-entrega-fotos')
      linhaFotos.appendChild(el('span', 'srv-gat-rot', 'Fotos entregues'))
      const grade = el('div', 'srv-fotos-grade')
      if (fotosSalvas === null) grade.appendChild(el('small', 'srv-gat-vazio', 'carregando…'))
      else if (!fotosSalvas.length) grade.appendChild(el('small', 'srv-gat-vazio', 'Nenhuma foto salva ainda.'))
      else {
        for (const foto of fotosSalvas) {
          const marcada = (e.fotos || []).includes(foto.id)
          const item = el('button', `srv-foto${marcada ? ' marcada' : ''}`,
            `<img src="${miniaturaSalva(foto.file)}" alt="${esc(foto.descricao || foto.title || '')}" loading="lazy">
             ${ehVideoSalvo(foto.file) ? `<span class="fo-play mini">${icon('i-play', 'ico ico-sm')}</span>` : ''}
             <span class="srv-foto-marca">${icon('i-check', 'ico ico-sm')}</span>
             <span class="srv-foto-nome">${esc(foto.descricao || foto.title || foto.shortcut || '')}</span>`)
          item.type = 'button'
          // Aqui a foto travada NÃO fica em cinza: 'travada' quer dizer "a IA não manda
          // sozinha", e na entrega quem manda é você.
          item.title = foto.descricao || foto.shortcut || ''
          item.addEventListener('click', () => {
            e.fotos = e.fotos || []
            const i = e.fotos.indexOf(foto.id)
            if (i >= 0) e.fotos.splice(i, 1)
            else if (e.fotos.length >= 30) { toast('O máximo é 30 fotos de entrega.', 'err'); return }
            else e.fotos.push(foto.id)
            pintarServicos()
          })
          grade.appendChild(item)
        }
      }
      linhaFotos.appendChild(grade)

      caixa.append(linhaLink, linhaTxt, linhaFotos)
      return caixa
    }

    // QUANDO ESTE SERVIÇO APARECE. Sem gatilho, ele está sempre disponível. Com etiqueta, só
    // para quem tem aquela etiqueta; com palavra, só quando a pessoa escreveu a palavra. O
    // filtro é código, não instrução de prompt: o modelo recebe apenas o que passou.
    function blocoGatilhos(servico) {
      const caixa = el('div', 'srv-gatilhos')
      const etqs = servico.etiquetas || []
      const palavras = servico.palavras || []
      const ligado = etqs.length || palavras.length
      caixa.appendChild(el('div', 'srv-fotos-head',
        `<span>Quando este serviço aparece</span><small>${ligado
          ? 'só quando um destes acontecer'
          : 'sempre — nenhum gatilho definido'}</small>`))

      const linhaEtq = el('div', 'srv-gat-linha')
      linhaEtq.appendChild(el('span', 'srv-gat-rot', 'Etiquetas da pessoa'))
      const chips = el('div', 'srv-gat-chips')
      const disponiveis = ETIQUETAS || []
      if (!disponiveis.length) {
        chips.appendChild(el('small', 'srv-gat-vazio', ETIQUETAS === null
          ? 'carregando…'
          : 'Nenhuma etiqueta criada ainda — crie em Config → Sistema → Etiquetas.'))
      } else {
        for (const etq of disponiveis) {
          const marcada = etqs.includes(etq.id)
          const b = el('button', `etq-chip cor-${etq.cor} srv-gat-chip${marcada ? ' on' : ''}`, `<span class="etq-chip-txt">${esc(etq.nome)}</span>`)
          b.type = 'button'
          b.setAttribute('aria-pressed', marcada ? 'true' : 'false')
          b.addEventListener('click', () => {
            servico.etiquetas = servico.etiquetas || []
            const i = servico.etiquetas.indexOf(etq.id)
            if (i >= 0) servico.etiquetas.splice(i, 1); else servico.etiquetas.push(etq.id)
            pintarServicos()
          })
          chips.appendChild(b)
        }
      }
      linhaEtq.appendChild(chips)

      const linhaPal = el('div', 'srv-gat-linha')
      linhaPal.appendChild(el('span', 'srv-gat-rot', 'Palavras na mensagem'))
      const campo = el('input', 'field srv-gat-palavras')
      campo.type = 'text'
      campo.value = palavras.join(', ')
      campo.placeholder = 'pernoite, dormir, viagem (separadas por vírgula)'
      campo.autocomplete = 'off'
      // A palavra é procurada com borda: "hora" não dispara dentro de "agora". Acento e caixa
      // não importam.
      campo.addEventListener('input', () => {
        servico.palavras = campo.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
      })
      linhaPal.appendChild(campo)

      caixa.append(linhaEtq, linhaPal)
      return caixa
    }

    // FOTOS DE EXEMPLO. As mesmas fotos salvas da biblioteca: aqui você só marca quais mostram
    // este serviço. Marcar não copia a foto e não muda nada nela — o serviço guarda o id.
    //
    // A foto TRAVADA aparece marcável mas com aviso, porque a trava vale no envio: deixá-la
    // fora da lista faria parecer que ela sumiu, e o dono não entenderia por que a foto que ele
    // amarrou nunca é usada.
    function blocoFotos(servico) {
      const caixa = el('div', 'srv-fotos')
      const marcadas = (servico.fotos || []).length
      const titulo = el('div', 'srv-fotos-head',
        `<span>Fotos de exemplo</span><small>${fotosSalvas === null ? 'carregando…' : `${marcadas} de ${fotosSalvas.length} marcada${marcadas === 1 ? '' : 's'}`}</small>`)
      caixa.appendChild(titulo)

      if (fotosSalvas === null) return caixa
      if (!fotosSalvas.length) {
        caixa.appendChild(el('p', 'srv-fotos-vazio', 'Nenhuma foto salva ainda. As fotos que você guardar aparecem aqui para marcar.'))
        return caixa
      }

      const grade = el('div', 'srv-fotos-grade')
      for (const foto of fotosSalvas) {
        const marcada = (servico.fotos || []).includes(foto.id)
        const item = el('button', `srv-foto${marcada ? ' marcada' : ''}${foto.nivel === 'travada' ? ' travada' : ''}`,
          `<img src="${miniaturaSalva(foto.file)}" alt="${esc(foto.descricao || foto.title || '')}" loading="lazy">
           ${ehVideoSalvo(foto.file) ? `<span class="fo-play mini">${icon('i-play', 'ico ico-sm')}</span>` : ''}
           <span class="srv-foto-marca">${icon('i-check', 'ico ico-sm')}</span>
           <span class="srv-foto-nome">${esc(foto.descricao || foto.title || foto.shortcut || '')}</span>`)
        item.type = 'button'
        item.title = foto.nivel === 'travada'
          ? `${foto.descricao || foto.shortcut} — foto travada: a IA não envia enquanto estiver assim`
          : (foto.descricao || foto.shortcut || '')
        item.addEventListener('click', () => {
          servico.fotos = servico.fotos || []
          const i = servico.fotos.indexOf(foto.id)
          if (i >= 0) servico.fotos.splice(i, 1)
          else if (servico.fotos.length >= 12) { toast('O máximo é 12 fotos por serviço.', 'err'); return }
          else servico.fotos.push(foto.id)
          pintarServicos()
        })
        grade.appendChild(item)
      }
      caixa.appendChild(grade)
      return caixa
    }

    function pintarServicos() {
      lista.replaceChildren(...estado.itens.map(linhaServico))
      if (!estado.itens.length) {
        lista.appendChild(el('p', 'srv-vazio', 'Nenhum serviço ainda. Adicione o primeiro e diga quanto custa cada tempo.'))
      }
    }

    addServico.addEventListener('click', () => {
      if (estado.itens.length >= 40) { toast('O máximo é 40 serviços.', 'err'); return }
      estado.itens.push({ nome: '', obs: '', local: '', endereco: '', atendeEm: null, locais: [], tipo: 'presencial', faixas: [{ tempo: '', centavos: 0 }], folgaAntesMin: 0, folgaDepoisMin: 0, fotos: [], etiquetas: [], palavras: [], entrega: { link: '', instrucao: '', fotos: [] } })
      pintarServicos()
      const ultimo = lista.querySelector('.srv-item:last-of-type .srv-nome')
      if (ultimo) ultimo.focus()
    })

    salvar.addEventListener('click', async () => {
      // A validação daqui é só para não gastar uma ida ao servidor com o óbvio: a regra que
      // vale é a do servidor, e é ela que devolve a mensagem exibida abaixo.
      for (const s of estado.itens) {
        if (!s.nome.trim()) { toast('Todo serviço precisa de um nome.', 'err'); return }
        for (const f of s.faixas) {
          if (!f.tempo.trim()) { toast(`Informe o tempo em "${s.nome.trim()}".`, 'err'); return }
          if (!f.centavos) { toast(`Informe o valor de "${f.tempo.trim()}" em "${s.nome.trim()}".`, 'err'); return }
        }
      }
      salvar.disabled = true
      const r = await post('/api/config/servicos', { itens: estado.itens })
      salvar.disabled = false
      if (!r?.ok) { toast(r?.erro || 'Não deu pra salvar os serviços.', 'err'); return }
      status.textContent = `Salvo no sistema · ${new Date(r.servicos.atualizadoEm).toLocaleString('pt-BR')}`
      toast(r.servicos.itens.length ? 'Serviços salvos no sistema.' : 'Tabela de serviços esvaziada.')
    })

    pintarServicos()
    wrap.append(lista, rodape)
    // Carrega a biblioteca de fotos e repinta. Falhar aqui não pode derrubar a tela inteira:
    // sem a lista, o serviço continua editável e só a faixa de fotos avisa que não veio.
    api('/api/fotos').then((r) => {
      fotosSalvas = Array.isArray(r) ? r.filter((f) => f && f.active) : []
      pintarServicos()
    }).catch(() => { fotosSalvas = []; pintarServicos() })
    carregarEtiquetas().then(pintarServicos).catch(() => { ETIQUETAS = []; pintarServicos() })
    return wrap
  }

  // ---------------------------------------------------------------- COBRANÇA PROGRAMADA
  // Em tal horário, ligar a regra e/ou enviar o PIX pra estas pessoas. Não existia na UI:
  // só dava pra autorizar uma a uma, e a IA só cobrava na próxima resposta.
  function renderCobrancasProgramadas() {
    const wrap = el('div', 'cprog-card')
    const lista = el('div', 'cprog-lista')
    const form = el('div', 'cprog-form')

    const quando = el('input', 'field')
    quando.type = 'datetime-local'
    const pad = (n) => String(n).padStart(2, '0')
    const agoraLocal = () => {
      const d = new Date(Date.now() + 60 * 60 * 1000)
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    quando.value = agoraLocal()

    const motivo = el('textarea', 'field cprog-motivo')
    motivo.rows = 3
    motivo.maxLength = 500
    motivo.placeholder = 'Por que essas pessoas devem pagar (o Tim usa exatamente isto).'

    const valor = el('input', 'field')
    valor.type = 'text'
    valor.inputMode = 'numeric'
    valor.placeholder = 'Valor (opcional), ex: 250,00'
    let valorCentavos = 0
    valor.addEventListener('input', () => {
      const d = valor.value.replace(/\D+/g, '').slice(0, 10)
      valorCentavos = d ? Number(d) : 0
      valor.value = valorCentavos
        ? (valorCentavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : ''
    })

    const servicoSel = el('select', 'field cprog-sel')
    servicoSel.appendChild(Object.assign(el('option'), { value: '', textContent: 'Ou escolha uma faixa da tabela' }))
    api('/api/config').then((cfg) => {
      for (const s of cfg?.servicos?.itens || []) {
        for (const f of s.faixas || []) {
          const o = el('option')
          o.value = JSON.stringify({ servico: s.nome, faixa: f.tempo, centavos: f.centavos })
          o.textContent = `${s.nome} — ${f.tempo} (${((f.centavos || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })})`
          servicoSel.appendChild(o)
        }
      }
    }).catch(() => {})

    let acao = 'ambos'
    const acoes = el('div', 'cprog-acoes')
    const pintarAcao = () => {
      acoes.replaceChildren(...[
        { v: 'ligar', l: 'Só ligar a regra', d: 'na próxima conversa o Tim cobra' },
        { v: 'enviar', l: 'Só enviar', d: 'manda o PIX nesse horário' },
        { v: 'ambos', l: 'Ligar e enviar', d: 'autoriza e manda a mensagem' },
      ].map((x) => {
        const b = el('button', `cprog-acao${acao === x.v ? ' on' : ''}`, `<b>${x.l}</b><small>${x.d}</small>`)
        b.type = 'button'
        b.addEventListener('click', () => { acao = x.v; pintarAcao() })
        return b
      }))
    }
    pintarAcao()

    const escolhidas = new Map()
    const chips = el('div', 'cprog-chips')
    const pintarChips = () => {
      chips.replaceChildren(...[...escolhidas.entries()].map(([id, nome]) => {
        const c = el('button', 'cprog-chip', `${esc(nome)} ×`)
        c.type = 'button'
        c.addEventListener('click', () => { escolhidas.delete(id); pintarChips() })
        return c
      }))
      if (!escolhidas.size) chips.appendChild(el('small', 'cprog-vazio', 'Ninguém escolhido ainda.'))
    }
    pintarChips()

    const busca = el('input', 'field')
    busca.type = 'search'
    busca.placeholder = 'Buscar pessoa pelo nome…'
    const sug = el('div', 'cprog-sug')
    let buscaT = null
    busca.addEventListener('input', () => {
      clearTimeout(buscaT)
      const q = busca.value.trim()
      if (q.length < 2) { sug.replaceChildren(); return }
      buscaT = setTimeout(async () => {
        const r = await api(`/api/self/cobranca/pessoas?q=${encodeURIComponent(q)}`).catch(() => null)
        sug.replaceChildren(...(r?.pessoas || []).map((p) => {
          const b = el('button', 'cprog-sug-item', esc(p.nome))
          b.type = 'button'
          b.addEventListener('click', () => {
            escolhidas.set(p.personId, p.nome)
            pintarChips()
            busca.value = ''
            sug.replaceChildren()
          })
          return b
        }))
      }, 200)
    })

    const etqBox = el('div', 'cprog-etqs')
    carregarEtiquetas().then((ets) => {
      etqBox.replaceChildren(...(ets || []).filter((e) => e.tipo !== 'cidade').map((e) => {
        const b = el('button', `cprog-etq cor-${e.cor || 'cinza'}`, `${esc(e.nome)} (${e.pessoas || 0})`)
        b.type = 'button'
        b.title = 'Inclui quem tem esta etiqueta agora'
        b.addEventListener('click', async () => {
          const r = await api(`/api/etiquetas/pessoas?id=${encodeURIComponent(e.id)}`).catch(() => null)
          for (const p of r?.pessoas || []) escolhidas.set(p.personId, p.nome)
          pintarChips()
          toast(`${r?.pessoas?.length || 0} pessoa(s) de ${e.nome} na lista`)
        })
        return b
      }))
    }).catch(() => {})

    const salvar = el('button', 'btn primary', 'Programar cobrança')
    salvar.type = 'button'
    salvar.addEventListener('click', async () => {
      if (!quando.value) { toast('Escolha o horário.', 'err'); return }
      if (!motivo.value.trim()) { toast('Escreva o motivo.', 'err'); return }
      if (!escolhidas.size) { toast('Escolha pelo menos uma pessoa.', 'err'); return }
      const ms = new Date(quando.value).getTime()
      if (!Number.isFinite(ms)) { toast('Horário inválido.', 'err'); return }
      let servico = null, faixa = null, cents = valorCentavos || null
      if (servicoSel.value) {
        try {
          const v = JSON.parse(servicoSel.value)
          servico = v.servico
          faixa = v.faixa
          if (!cents) cents = v.centavos
        } catch { /* ignora */ }
      }
      salvar.disabled = true
      const r = await post('/api/self/cobranca/programar', {
        quando: ms,
        motivo: motivo.value.trim(),
        valorCentavos: cents,
        servico, faixa, acao,
        personIds: [...escolhidas.keys()],
      })
      salvar.disabled = false
      if (!r?.ok) { toast(r?.erro || 'Não deu pra programar.', 'err'); return }
      toast(`Programada pra ${new Date(ms).toLocaleString('pt-BR')} · ${r.programada.alvos.length} pessoa(s)`)
      motivo.value = ''
      escolhidas.clear()
      pintarChips()
      carregarCobrancasProgramadas()
    })

    form.append(
      el('label', 'cprog-lbl', 'Quando'), quando,
      el('label', 'cprog-lbl', 'Motivo'), motivo,
      el('label', 'cprog-lbl', 'Valor (opcional)'), valor,
      el('label', 'cprog-lbl', 'Faixa da tabela (opcional)'), servicoSel,
      el('label', 'cprog-lbl', 'O que fazer na hora'), acoes,
      el('label', 'cprog-lbl', 'Pessoas'), busca, sug, etqBox, chips,
      salvar,
    )

    async function carregarCobrancasProgramadas() {
      const r = await api('/api/self/cobranca/programadas').catch(() => null)
      const itens = r?.programadas || []
      if (!itens.length) {
        lista.replaceChildren(el('p', 'cprog-vazio', 'Nenhuma cobrança programada. Monte uma acima.'))
        return
      }
      lista.replaceChildren(...itens.map((p) => {
        const card = el('div', `cprog-item estado-${p.estado}`)
        const quandoTxt = new Date(p.quando).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
        const acaoTxt = p.acao === 'ligar' ? 'ligar regra' : (p.acao === 'enviar' ? 'enviar' : 'ligar e enviar')
        const valorTxt = p.valorCentavos ? ((p.valorCentavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })) : ''
        card.appendChild(el('div', 'cprog-item-head',
          `<b>${esc(quandoTxt)}</b><span>${esc(p.estado)} · ${esc(acaoTxt)}</span>`))
        card.appendChild(el('p', 'cprog-item-mot', esc(p.motivo) + (valorTxt ? ` · ${valorTxt}` : '') + (p.faixa ? ` · ${esc(p.servico || '')} ${esc(p.faixa)}` : '')))
        card.appendChild(el('small', 'cprog-item-alvos',
          `${p.alvos.length} pessoa(s)${p.feitos ? ` · ${p.feitos} feitas` : ''}${p.falhas ? ` · ${p.falhas} falha(s)` : ''}: ${p.alvos.slice(0, 8).map((a) => a.nome).join(', ')}${p.alvos.length > 8 ? '…' : ''}`))
        if (p.estado === 'pendente') {
          const cancel = el('button', 'btn ghost small', 'Cancelar')
          cancel.type = 'button'
          cancel.addEventListener('click', async () => {
            const rr = await post('/api/self/cobranca/programadas/cancelar', { id: p.id })
            if (!rr?.ok) { toast(rr?.erro || 'Não deu pra cancelar.', 'err'); return }
            toast('Programação cancelada')
            carregarCobrancasProgramadas()
          })
          card.appendChild(cancel)
        }
        return card
      }))
    }

    wrap.append(form, el('h3', 'cprog-h', 'Programadas'), lista)
    carregarCobrancasProgramadas()
    return wrap
  }

  // ---------------------------------------------------------------- ROTINA
  // A rotina descreve o cotidiano recorrente da pessoa dona desta instância. É diferente da
  // Agenda (eventos reais) e da disponibilidade (quando aceita marcar algo): aqui entram
  // trabalho, estudo, deslocamento, cuidado, descanso e o lugar em que normalmente está.
  const ROTINA_DIAS_CURTO = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

  function resumoDiasRotina(dias) {
    const ds = [...new Set((dias || []).map(Number))].sort((a, b) => a - b)
    if (ds.length === 7) return 'todos os dias'
    if (ds.join(',') === '1,2,3,4,5') return 'segunda a sexta'
    if (ds.join(',') === '0,6') return 'fim de semana'
    return ds.map((d) => ROTINA_DIAS_CURTO[d]).filter(Boolean).join(', ')
  }

  function renderRotinaSection() {
    const wrap = el('div', 'rotina-wrap')
    const topo = el('div', 'rotina-topo')
    topo.innerHTML = `<div><b>Seu dia a dia</b><small>A IA usa como contexto do que você normalmente está fazendo. Isso não libera horários na agenda.</small></div>`
    const novo = el('button', 'btn small', 'Adicionar à rotina')
    novo.type = 'button'
    novo.addEventListener('click', () => abrirEditorRotina())
    topo.appendChild(novo)
    wrap.appendChild(topo)
    const host = el('div', 'rotina-lista', '<span class="rotina-carregando">carregando rotina…</span>')
    host.id = 'rotinaLista'
    wrap.appendChild(host)
    return wrap
  }

  async function carregarRotina() {
    const host = $('#rotinaLista')
    if (!host) return
    const r = await api('/api/self/rotina')
    if (!r) { host.replaceChildren(el('p', 'enc-vazio', 'Não deu para carregar sua rotina agora.')); return }
    const itens = Array.isArray(r.itens) ? r.itens : []
    if (!itens.length) {
      host.replaceChildren(emptyState('i-clock', 'Nenhuma rotina cadastrada', 'Adicione os horários que se repetem no seu dia: o que você faz, no que está trabalhando e onde costuma estar.'))
      return
    }
    host.replaceChildren()
    for (const x of itens) {
      const row = el('article', `rotina-item${x.agora ? ' agora' : ''}${x.ativo ? '' : ' pausado'}`)
      const estado = x.agora ? '<span class="rotina-agora">acontecendo agora</span>' : ''
      const lugar = x.local ? `<span>${icon('i-pin', 'ico ico-sm')}${esc(x.local)}</span>` : ''
      const detalhes = x.detalhes ? `<p>${esc(x.detalhes)}</p>` : ''
      row.innerHTML = `
        <div class="rotina-hora"><b>${esc(x.inicio)}</b><span>até</span><b>${esc(x.fim)}</b></div>
        <div class="rotina-copy">
          <div class="rotina-titulo"><b>${esc(x.titulo)}</b>${estado}</div>
          <div class="rotina-meta"><span>${esc(resumoDiasRotina(x.dias))}</span>${lugar}</div>
          ${detalhes}
        </div>
        <div class="rotina-acoes">
          <button type="button" class="btn ghost small" data-editar>Editar</button>
          <button type="button" class="btn ghost small danger" data-apagar>Apagar</button>
        </div>`
      row.querySelector('[data-editar]').addEventListener('click', () => abrirEditorRotina(x))
      row.querySelector('[data-apagar]').addEventListener('click', (e) => confirmDestructive(e.currentTarget, 'Confirmar', async () => {
        const ok = await del(`/api/self/rotina/${encodeURIComponent(x.id)}`)
        if (ok?.ok) { toast('Horário removido da rotina.'); carregarRotina() }
      }))
      host.appendChild(row)
    }
  }

  function abrirEditorRotina(atual = null) {
    const scrim = el('div', 'dmodal-scrim rotina-scrim')
    const box = el('form', 'dmodal rotina-editor')
    box.innerHTML = `
      <div class="rotina-editor-head"><h3>${atual ? 'Editar rotina' : 'Adicionar à rotina'}</h3><p>Cadastre o que costuma acontecer. Pode atravessar a meia-noite, como trabalho das 22h às 06h.</p></div>
      <label class="rotina-campo"><span>O que você está fazendo</span><input id="rotinaTitulo" type="text" maxlength="120" autocomplete="off" placeholder="Ex: trabalhando na clínica" value="${esc(atual?.titulo || '')}"></label>
      <label class="rotina-campo"><span>No que está trabalhando ou outros detalhes <small>(opcional)</small></span><textarea id="rotinaDetalhes" maxlength="500" rows="3" placeholder="Ex: atendendo pacientes e organizando os relatórios">${esc(atual?.detalhes || '')}</textarea></label>
      <label class="rotina-campo"><span>Onde <small>(opcional)</small></span><input id="rotinaLocal" type="text" maxlength="160" autocomplete="off" placeholder="Ex: na clínica do centro" value="${esc(atual?.local || '')}"></label>
      <fieldset class="rotina-fieldset"><legend>Dias</legend><div class="rotina-atalhos"><button type="button" data-dias="uteis">Seg–sex</button><button type="button" data-dias="todos">Todos</button><button type="button" data-dias="limpar">Limpar</button></div><div class="rotina-dias"></div></fieldset>
      <fieldset class="rotina-fieldset"><legend>Horário</legend><div class="rotina-horarios"><button type="button" class="enc-hour" id="rotinaInicio"></button><span>até</span><button type="button" class="enc-hour" id="rotinaFim"></button><small id="rotinaVirada" hidden>termina no dia seguinte</small></div></fieldset>
      <div class="dmodal-acoes"><button type="button" class="btn ghost" data-cancelar>Cancelar</button><button type="submit" class="btn primary">Salvar rotina</button></div>`
    scrim.appendChild(box)
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    $('.rotina-editor-head h3', box).id = 'rotinaEditorTitulo'
    box.setAttribute('aria-labelledby', 'rotinaEditorTitulo')
    document.body.appendChild(scrim)
    requestAnimationFrame(() => scrim.classList.add('show'))

    const escolhidos = new Set((atual?.dias?.length ? atual.dias : [1, 2, 3, 4, 5]).map(Number))
    const diasHost = $('.rotina-dias', box)
    const pintarDias = () => $$('.rotina-dia', diasHost).forEach((b) => {
      const on = escolhidos.has(Number(b.dataset.dow)); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on))
    })
    ROTINA_DIAS_CURTO.forEach((nome, dow) => {
      const b = el('button', 'rotina-dia', nome); b.type = 'button'; b.dataset.dow = dow
      b.addEventListener('click', () => { escolhidos.has(dow) ? escolhidos.delete(dow) : escolhidos.add(dow); pintarDias() })
      diasHost.appendChild(b)
    })
    pintarDias()
    $$('.rotina-atalhos button', box).forEach((b) => b.addEventListener('click', () => {
      escolhidos.clear()
      if (b.dataset.dias === 'uteis') [1, 2, 3, 4, 5].forEach((d) => escolhidos.add(d))
      if (b.dataset.dias === 'todos') [0, 1, 2, 3, 4, 5, 6].forEach((d) => escolhidos.add(d))
      pintarDias()
    }))

    const inicio = $('#rotinaInicio', box), fim = $('#rotinaFim', box), virada = $('#rotinaVirada', box)
    inicio.dataset.h = atual?.inicio || '08:00'; inicio.textContent = inicio.dataset.h
    fim.dataset.h = atual?.fim || '18:00'; fim.textContent = fim.dataset.h
    const pintarVirada = () => { virada.hidden = fim.dataset.h > inicio.dataset.h }
    inicio.addEventListener('click', () => abrirSeletorHora(inicio, { de: 0, ate: 23 }))
    fim.addEventListener('click', () => abrirSeletorHora(fim, { de: 0, ate: 23 }))
    const observarHora = new MutationObserver(pintarVirada)
    observarHora.observe(inicio, { childList: true }); observarHora.observe(fim, { childList: true })
    pintarVirada()

    const fechar = () => { observarHora.disconnect(); scrim.classList.remove('show'); setTimeout(() => scrim.remove(), 180) }
    $('[data-cancelar]', box).addEventListener('click', fechar)
    scrim.addEventListener('click', (e) => { if (e.target === scrim) fechar() })
    box.addEventListener('submit', async (e) => {
      e.preventDefault()
      const titulo = $('#rotinaTitulo', box).value.trim()
      if (!titulo) { toast('Diga o que você faz nesse horário.', 'err'); $('#rotinaTitulo', box).focus(); return }
      if (!escolhidos.size) { toast('Escolha pelo menos um dia.', 'err'); return }
      if (inicio.dataset.h === fim.dataset.h) { toast('Início e fim precisam ser diferentes.', 'err'); return }
      const r = await post('/api/self/rotina', {
        id: atual?.id || undefined,
        titulo,
        detalhes: $('#rotinaDetalhes', box).value,
        local: $('#rotinaLocal', box).value,
        dias: [...escolhidos].sort((a, b) => a - b),
        inicio: inicio.dataset.h,
        fim: fim.dataset.h,
        ativo: atual?.ativo !== false,
      })
      if (!r?.ok) return
      toast(atual ? 'Rotina atualizada. Já vale para a IA.' : 'Horário adicionado à rotina.')
      fechar(); carregarRotina()
    })
    $('#rotinaTitulo', box).focus()
  }

  // ---------------------------------------------------------------- módulos de vínculo
  // Como ela fala com cada tipo de pessoa. Até 01/08/2026 isso só existia como arquivo no
  // servidor: o menu "Contexto" marcava a pessoa como Família ou Cliente e NADA mudava no
  // que a IA escrevia, porque os módulos nunca foram escritos. Menu que não muda nada é pior
  // que menu nenhum — dá a impressão de que a marcação está funcionando.
  //
  // A tela mostra, para cada vínculo: quantas pessoas estão marcadas nele (por onde começar)
  // e se ele já tem texto. Vazio aparece como vazio, sem eufemismo.
  function renderVinculoModulos(modulos) {
    const wrap = el('div', 'vinc-wrap')
    const semTexto = modulos.filter((m) => !m.temTexto && !m.usaManualCompleto).length
    wrap.appendChild(el('p', 'vinc-intro', semTexto
      ? `${semTexto} de ${modulos.filter((m) => !m.usaManualCompleto).length} vínculos ainda não têm jeito de falar definido. Enquanto estiverem vazios, marcar uma pessoa com eles quase não muda o que a IA escreve.`
      : 'Todos os vínculos já têm um jeito de falar definido.'))

    const grupos = [...new Set(modulos.map((m) => m.grupo))]
    for (const g of grupos) {
      wrap.appendChild(el('h4', 'vinc-grupo', esc(g)))
      const lista = el('div', 'vinc-lista')
      for (const m of modulos.filter((x) => x.grupo === g)) {
        const item = el('button', `vinc-item${m.temTexto ? ' tem' : ''}${m.usaManualCompleto ? ' manual' : ''}`)
        item.type = 'button'
        const estado = m.usaManualCompleto
          ? 'usa o manual de voz completo'
          : m.temTexto ? `${m.tamanho} caracteres escritos` : 'sem jeito de falar definido'
        item.innerHTML = `
          <span class="vinc-item-top">
            <b>${esc(m.label)}</b>
            <span class="vinc-pessoas">${m.pessoas ? `${m.pessoas} ${m.pessoas === 1 ? 'pessoa' : 'pessoas'}` : 'ninguém ainda'}</span>
          </span>
          <span class="vinc-desc">${esc(m.desc)}</span>
          <span class="vinc-estado">${esc(estado)}</span>`
        // Romântico não abre editor: ele carrega o manual completo, e escrever um módulo ali
        // seria escrever um arquivo que o sistema nunca lê.
        if (m.usaManualCompleto) item.disabled = true
        else item.addEventListener('click', () => abrirEditorVinculo(m))
        lista.appendChild(item)
      }
      wrap.appendChild(lista)
    }
    return wrap
  }

  async function abrirEditorVinculo(m) {
    const r = await api(`/api/self/vinculos/modulo?vinculo=${encodeURIComponent(m.valor)}`)
    const atual = r?.texto || ''
    const scrim = el('div', 'dmodal-scrim')
    const box = el('div', 'dmodal vinc-editor')
    box.appendChild(el('div', 'dmodal-head', `<h3>${esc(m.label)}</h3><p>${esc(m.desc)} · ${m.pessoas || 0} ${m.pessoas === 1 ? 'pessoa marcada' : 'pessoas marcadas'}</p>`))
    const dica = el('p', 'vinc-dica', 'Escreva como você fala com esse tipo de pessoa: o tom, o que rola e o que não rola, apelido, assunto que aparece sempre. Em português falado, como você diria de verdade. Deixar em branco tira o jeito de falar próprio desse vínculo.')
    const ta = el('textarea', 'vinc-textarea')
    ta.value = atual
    ta.rows = 14
    ta.maxLength = 3500
    ta.placeholder = `Ex: com ${m.label.toLowerCase()} eu falo…`
    const conta = el('span', 'vinc-conta', `${atual.length}/3500`)
    ta.addEventListener('input', () => { conta.textContent = `${ta.value.length}/3500` })
    const acoes = el('div', 'dmodal-acoes')
    const bCancel = el('button', 'btn ghost', 'Cancelar')
    const bSalvar = el('button', 'btn primary', 'Salvar')
    bCancel.type = 'button'; bSalvar.type = 'button'
    acoes.append(conta, bCancel, bSalvar)
    box.append(dica, ta, acoes)
    scrim.appendChild(box)
    document.body.appendChild(scrim)
    ta.focus()

    const fechar = () => scrim.remove()
    bCancel.addEventListener('click', fechar)
    scrim.addEventListener('click', (e) => { if (e.target === scrim) fechar() })
    document.addEventListener('keydown', function esc2(e) { if (e.key === 'Escape') { fechar(); document.removeEventListener('keydown', esc2) } })
    bSalvar.addEventListener('click', async () => {
      bSalvar.disabled = true
      const ok = await post('/api/self/vinculos/modulo', { vinculo: m.valor, texto: ta.value })
      bSalvar.disabled = false
      if (!ok?.ok) { toast(ok?.erro || 'Não deu pra salvar.', 'err'); return }
      toast(ok.apagado ? 'Jeito de falar removido desse vínculo.' : 'Salvo. Vale já na próxima resposta.', 'ok')
      fechar()
      carregarVinculoModulos()
    })
  }

  async function carregarVinculoModulos() {
    const host = document.querySelector('.cfg-vinc-section .vinc-host')
    if (!host) return
    const r = await api('/api/self/vinculos/modulos')
    host.replaceChildren(renderVinculoModulos(r?.modulos || []))
  }

  function configSection(title, description, content, cls = '') {
    const section = el('section', `cfg-section ${cls}`.trim())
    section.appendChild(el('div', 'cfg-section-head', `<div><span class="cfg-kicker">Configurações</span><h2>${esc(title)}</h2><p>${esc(description)}</p></div>`))
    section.appendChild(content)
    return section
  }

  async function loadConfig(force = false) {
    const host = $('#configHost')
    const hadDashboard = !!$('.cfg-dashboard', host)
    if (!host.dataset.loaded && !hadDashboard) host.replaceChildren(el('div', 'empty', `${icon('i-gear', 'ico')}<h3>carregando…</h3>`))
    const [cfg, tokenUsage] = await Promise.all([
      api(force ? '/api/config?atualizar=1' : '/api/config'),
      api('/api/ia/uso?horas=24'),
    ])
    host.dataset.loaded = '1'
    if (!cfg) {
      if (hadDashboard) {
        toast('Não foi possível atualizar agora; os últimos dados foram mantidos.', 'err')
        return
      }
      host.replaceChildren(emptyState('i-gear', 'Config indisponível', 'O painel não conseguiu ler o "sobre mim". Assim que o vendas-multicanal responder, ele aparece aqui.'))
      return
    }
    const docs = Array.isArray(cfg.documents) ? cfg.documents : []
    const page = el('div', 'cfg-dashboard')

    // A Config tinha 14 seções empilhadas: 7.660px, mais de oito telas de rolagem, e a coisa
    // que ele queria estava sempre no meio. Agora as MESMAS seções vivem em grupos e só um
    // aparece por vez. Nada foi removido nem remontado: cada seção continua sendo construída
    // do mesmo jeito, com os mesmos listeners — muda só quem está visível.
    const S_ = {}   // as seções, por chave, pra montagem dos grupos ficar legível

    S_.conta = configSection(
      'Conta e consumo da IA',
      'Escolha o cérebro do sistema, preserve suas contas OAuth e acompanhe os limites de cada uma.',
      renderAiWorkspace(cfg),
      'cfg-account-section',
    )
    const refresh = el('button', 'btn small cfg-refresh', `${icon('i-sync', 'ico ico-sm')} Atualizar`)
    refresh.type = 'button'
    refresh.addEventListener('click', () => loadConfig(true))
    $('.cfg-section-head', S_.conta).appendChild(refresh)

    S_.tokens = configSection(
      'Gasto detalhado de tokens',
      'Veja exatamente qual função chamou a IA, em qual conversa e quantos tokens cada etapa consumiu.',
      renderTokenMonitor(tokenUsage),
      'cfg-usage-section',
    )

    // O interruptor geral da IA. Fica no mesmo grupo do consumo de propósito: é ali que ele
    // olha o percentual, e é ali que ele vai querer o botão quando o número assustar.
    S_.pausa = configSection(
      'Interruptor geral da IA',
      'Pausa a IA automática em todos os canais. Os interruptores por pessoa ficam como estão.',
      renderIaPausa(),
      'cfg-ia-pausa-section',
    )

    // Necessidades: o que está apertando e quanto falta. Fica na Config porque é coisa DELA,
    // não da conversa — e o host é preenchido depois, por carregarNecessidades().
    S_.necessidades = configSection(
      'Necessidades',
      'O que está apertando agora e quanto falta em dinheiro. A IA pode usar esse contexto quando fizer sentido, inclusive citar valores. Cobrança continua dependendo da autorização da pessoa.',
      el('div', 'nec-host'),
      'cfg-nec-section',
    )

    S_.pix = configSection(
      'PIX para receber',
      'Seu nome e sua chave ficam salvos no banco deste sistema e podem ser consultados ou copiados por aqui.',
      renderPixConfig(cfg.pix),
      'cfg-pix-section',
    )

    S_.servicos = configSection(
      'Serviços e valores',
      'O que você faz e quanto cobra, em reais. Um mesmo serviço pode ter vários tempos com preços diferentes. A IA pode falar desses valores nas conversas, inclusive por iniciativa — e nunca pode inventar um valor que não esteja aqui.',
      renderServicosConfig(cfg.servicos),
      'cfg-srv-section',
    )

    S_.cobrancasProg = configSection(
      'Cobranças programadas',
      'Em tal horário, ligue a regra e/ou envie o PIX pra estas pessoas. Quem você escolhe agora é quem recebe — a etiqueta só ajuda a montar a lista.',
      renderCobrancasProgramadas(),
      'cfg-cprog-section',
    )

    // Como ela fala com cada tipo de pessoa. Fica junto do "sobre mim" porque as duas são
    // coisas que só ela sabe responder — o sistema não tem como inferir nenhuma das duas.
    S_.jeito = configSection(
      'Jeito de falar com cada tipo de pessoa',
      'O menu "Contexto" de cada conversa marca o vínculo (família, cliente, amiga…). Aqui você escreve o que cada um desses vínculos muda no jeito de falar.',
      el('div', 'vinc-host'),
      'cfg-vinc-section',
    )

    S_.etiquetas = configSection(
      'Etiquetas',
      'Marcas suas para agrupar pessoas — valem em todos os canais, não são as etiquetas do WhatsApp Business. Uma pessoa pode ter várias, e elas podem acionar um serviço. Para marcar alguém, use o menu Contexto da conversa.',
      renderEtiquetasConfig(),
      'cfg-etq-section',
    )

    S_.sessoes = configSection(
      'Conectar os canais',
      'Tinder, Badoo e Instagram podem usar a conta já aberta no Chrome dedicado. O sistema confere a sessão antes de gravar; a colagem manual fica disponível apenas como alternativa.',
      renderConectarCanais(),
      'cfg-sessoes-section',
    )

    S_.operacao = configSection(
      'Operação e diagnóstico',
      'Monitor e Diário ficam centralizados aqui para manter o cabeçalho mais simples.',
      renderConfigTools(),
      'cfg-operacao-section',
    )

    const docsWrap = el('div', 'cfg-list')
    if (docs.length) docs.forEach((d) => docsWrap.appendChild(configCard(d)))
    else docsWrap.appendChild(emptyState('i-book', 'Nenhum documento configurado', 'Quando o contexto pessoal da IA estiver definido, ele aparecerá aqui.'))
    S_.conhecimento = configSection(
      'Conhecimento da IA',
      'Documentos que orientam sua voz, seu contexto e os fatos usados nas conversas.',
      docsWrap,
      'cfg-docs-section',
    )

    // Áudios salvos: gravador + biblioteca. O dono grava notas de voz na própria voz;
    // o atalho "/" no WhatsApp manda rápido, e a IA pode mandar quando o conteúdo encaixa.
    S_.audios = configSection(
      'Áudios salvos',
      'Notas de voz na sua voz. Use pelo atalho "/" no WhatsApp; a IA também pode mandar quando fizer sentido.',
      renderSavedAudioSection(),
      'cfg-audios-section',
    )

    S_.fotos = configSection(
      'Banco de fotos',
      'Fotos que a IA pode mandar na hora certa. O que decide a escolha é a descrição que você escreve em cada uma.',
      renderSavedImageSection(),
      'cfg-fotos-section',
    )

    // As ligações vêm DEPOIS do banco de fotos: só faz sentido ligar o que já existe.
    S_.ligacoes = configSection(
      'Ligações: foto e necessidade',
      'Arraste de um lado ao outro pra dizer em que assunto cada foto entra. Uma foto pode servir a várias necessidades e uma necessidade pode ter várias fotos.',
      renderLigacoes(),
      'cfg-ligacoes-section',
    )

    // Disponibilidade mudou de casa (pedido dele, 26/07/2026): dia, horário, lugar e período
    // só fazem sentido olhando o mês inteiro, então moram na Agenda, ao lado do calendário.
    // Fica o ponteiro: seção que muda de lugar sem deixar rastro é seção que ele procura.
    S_.encontros = configSection(
      'Encontros e disponibilidade',
      'Dia, horário, lugar e períodos de viagem agora ficam na aba Agenda, junto do calendário.',
      renderDisponibilidadePonteiro(),
      'cfg-encontros-section',
    )

    // Sobre mim: a memória estruturada. Cada fato tem fonte, política de uso e validade.
    S_.sobremim = configSection(
      'Sobre mim',
      'O que a IA sabe de você além do retrato. Fato novo nasce esperando sua aprovação, e o que for marcado como "nunca" jamais entra numa conversa.',
      renderFatosSection(),
      'cfg-fatos-section',
    )

    S_.rotina = configSection(
      'Rotina',
      'O que você costuma fazer ao longo da semana, em quais horários e onde. Cada pessoa tem a própria rotina dentro do seu TIM.',
      renderRotinaSection(),
      'cfg-rotina-section',
    )

    // Pessoas saiu daqui em 26/07/2026: gestão de gente (identidade, memória, IA por canal)
    // mora na aba Pessoas, junto das pessoas. Config é sobre o SISTEMA.
    S_.pessoas = configSection(
      'Pessoas',
      'A gestão de pessoas mudou de lugar: identidade, memória da IA e interruptores por canal agora ficam na aba Pessoas, junto de quem eles descrevem.',
      (() => {
        const ir = el('button', 'btn small', 'Abrir a aba Pessoas')
        ir.type = 'button'
        ir.addEventListener('click', () => setTab('vinculos'))
        return ir
      })(),
      'cfg-pessoas-section',
    )

    // Os grupos. A ordem é a de quem abre a Config: primeiro o cérebro e o que ele custa,
    // depois quem ela é, depois grana, depois o que a IA pode mandar, e por último o que
    // quase nunca se mexe.
    const GRUPOS = [
      { id: 'ia', nome: 'IA', ico: 'i-bot', secoes: [S_.conta, S_.tokens, S_.pausa] },
      { id: 'voce', nome: 'Você', ico: 'i-note', secoes: [S_.sobremim, S_.rotina, S_.conhecimento, S_.jeito] },
      { id: 'grana', nome: 'Grana', ico: 'i-target', secoes: [S_.necessidades, S_.servicos, S_.pix, S_.cobrancasProg] },
      { id: 'midia', nome: 'Fotos e áudios', ico: 'i-cam', secoes: [S_.fotos, S_.ligacoes, S_.audios] },
      { id: 'sistema', nome: 'Sistema', ico: 'i-gear', secoes: [S_.etiquetas, S_.sessoes, S_.operacao, S_.encontros, S_.pessoas] },
    ]

    const nav = el('nav', 'cfg-nav')
    nav.setAttribute('role', 'tablist')
    const corpos = {}
    for (const g of GRUPOS) {
      const b = el('button', 'cfg-nav-btn', `${icon(g.ico, 'ico ico-sm')}<span>${esc(g.nome)}</span>`)
      b.type = 'button'; b.dataset.grupo = g.id
      b.setAttribute('role', 'tab')
      b.addEventListener('click', () => abrirGrupoConfig(g.id))
      nav.appendChild(b)
      const corpo = el('div', 'cfg-grupo')
      corpo.dataset.grupo = g.id
      // O selo de cada seção passa a dizer em que grupo ela está: repetir "Configurações"
      // catorze vezes não informava nada, e agora a palavra útil é o nome do grupo.
      for (const sec of g.secoes) {
        const kicker = $('.cfg-kicker', sec)
        if (kicker) kicker.textContent = g.nome
        corpo.appendChild(sec)
      }
      corpos[g.id] = corpo
    }
    page.appendChild(nav)
    for (const g of GRUPOS) page.appendChild(corpos[g.id])

    host.replaceChildren(page)
    abrirGrupoConfig(GRUPOS.some((g) => g.id === S.cfgGrupo) ? S.cfgGrupo : 'ia')
    carregarNecessidades()   // as seções são preenchidas depois que a página está no DOM
    carregarVinculoModulos()
    carregarRotina()
    loadSavedAudioLibrary() // preenche a lista assim que a Config abre
    loadFatos()
  }

  // Troca o grupo visível da Config. A escolha fica guardada porque `loadConfig` roda de novo
  // sozinho (botão Atualizar, troca de aba) e cair de volta no primeiro grupo apagaria o
  // lugar onde ele estava trabalhando.
  function abrirGrupoConfig(id) {
    S.cfgGrupo = id
    for (const b of $$('.cfg-nav-btn')) {
      const on = b.dataset.grupo === id
      b.classList.toggle('ativo', on)
      b.setAttribute('aria-selected', String(on))
    }
    for (const c of $$('.cfg-grupo')) c.hidden = c.dataset.grupo !== id
    // As linhas das ligações são desenhadas por MEDIÇÃO: dentro de um grupo escondido tudo
    // mede zero e elas sairiam empilhadas no canto. Redesenha quando o grupo aparece.
    if (id === 'midia') requestAnimationFrame(() => { try { desenharLinhas() } catch { /* seção ainda montando */ } })

    const ativo = $(`.cfg-nav-btn[data-grupo="${id}"]`)
    const nav = ativo && ativo.parentElement
    // No celular a fila rola na horizontal: sem isto o grupo escolhido pode ficar fora da
    // tela e a barra mostra outro botão aceso, o que é pior do que não mostrar nenhum.
    if (nav && nav.scrollWidth > nav.clientWidth + 2) {
      nav.scrollTo({ left: Math.max(0, ativo.offsetLeft - (nav.clientWidth - ativo.offsetWidth) / 2), behavior: 'smooth' })
    }
    // E volta pro topo do grupo novo: trocar de grupo com a página rolada caía no meio do
    // conteúdo, que é exatamente a sensação de bagunça que a divisão veio resolver.
    for (let n = nav; n; n = n.parentElement) {
      const st = n.scrollHeight > n.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(n).overflowY)
      if (st) { n.scrollTop = 0; return }
      if (n === document.body) break
    }
    window.scrollTo({ top: 0 })
  }

  // O ponteiro pra Agenda. Mostra o resumo do que está valendo, pra ele não ter que abrir a
  // outra aba só pra conferir se ainda tem disponibilidade cadastrada.
  function renderDisponibilidadePonteiro() {
    const wrap = el('div', 'cfg-enc-ponteiro')
    wrap.innerHTML = `
      <div class="enc-ai-row">
        <div class="enc-ai-txt"><b>Sua disponibilidade</b><small id="cfgDispResumo">carregando…</small></div>
        <button type="button" class="btn small" id="cfgIrAgenda">Abrir Agenda</button>
      </div>`
    wrap.querySelector('#cfgIrAgenda').addEventListener('click', () => setTab('agenda'))
    api('/api/self/disponibilidade').then((d) => {
      const alvo = $('#cfgDispResumo'); if (!alvo || !d) return
      const ne = (d.janelas?.encontro || []).length, nc = (d.janelas?.compromisso || []).length
      const na = (d.janelas?.atendimento || []).length
      const np = (d.periodos || []).length
      const partes = [d.proporDates ? 'a IA pode propor encontro' : 'a IA não propõe encontro']
      partes.push(d.marcarAtendimento ? 'e pode marcar atendimento' : 'e não marca atendimento')
      partes.push(ne ? `${ne} horário${ne === 1 ? '' : 's'} de encontro` : 'nenhum horário de encontro')
      partes.push(nc ? `${nc} de compromisso` : 'nenhum de compromisso')
      partes.push(na ? `${na} de atendimento` : 'nenhum de atendimento')
      if (np) partes.push(`${np} período${np === 1 ? '' : 's'} pela frente`)
      alvo.textContent = partes.join(' · ')
    })
    return wrap
  }

  // ---------------------------------------------------------------- DISPONIBILIDADE (Agenda)
  const DIAS_CURTO = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

  // Seletor de hora sem controle nativo: pop com a lista de meia em meia hora.
  // O seletor de hora do painel (nosso, nunca o <input type="time"> do navegador).
  // `de`/`ate` existem porque a disponibilidade só faz sentido acordado (6h–23h), mas o
  // horário de comentar uma necessidade pode ser madrugada — quem some às 2h da manhã existe.
  function abrirSeletorHora(botao, { de = 6, ate = 23 } = {}) {
    const antigo = $('.hour-pop'); if (antigo) antigo.remove()
    const pop = el('div', 'hour-pop')
    for (let h = de; h <= ate; h++) {
      for (const m of ['00', '30']) {
        const v = `${String(h).padStart(2, '0')}:${m}`
        const b = el('button', 'hour-opt' + (botao.dataset.h === v ? ' on' : ''), v)
        b.type = 'button'
        b.addEventListener('click', () => { botao.dataset.h = v; botao.textContent = v; pop.remove() })
        pop.appendChild(b)
      }
    }
    document.body.appendChild(pop)
    const r = botao.getBoundingClientRect()
    pop.style.top = `${Math.min(window.innerHeight - 260, r.bottom + 6)}px`
    pop.style.left = `${Math.min(window.innerWidth - 130, r.left)}px`
    // Ao editar um horário, abre já no valor atual. Sem isto a lista sempre começava em
    // 00:00 e, no celular, mudar 18:00 para 18:30 exigia rolar 37 opções primeiro.
    requestAnimationFrame(() => pop.querySelector('.hour-opt.on')?.scrollIntoView({ block: 'center' }))
    const fecha = (e) => { if (!pop.contains(e.target) && e.target !== botao) { pop.remove(); document.removeEventListener('mousedown', fecha) } }
    setTimeout(() => document.addEventListener('mousedown', fecha), 0)
  }

  // Estado da tela de disponibilidade. `tipoAtivo` é a família sendo editada (encontro ou
  // compromisso) e `marcando` é o modo em que um clique no calendário escolhe o período.
  const DISP = { dados: null, tipoAtivo: 'encontro', marcando: null }
  const TIPO_LABEL = { encontro: 'Encontro', compromisso: 'Compromisso', atendimento: 'Atendimento' }
  // O que cada família é, em uma frase — some da tela se um dia entrar uma família nova
  // sem texto, em vez de mostrar a explicação errada.
  const TIPO_SUB = {
    encontro: 'Paquera. É o que a IA usa quando a conversa chega em se ver.',
    compromisso: 'O resto da vida: reunião, café de trabalho, dentista. Serve pra você perguntar "quando eu posso" e pra avisar quando um compromisso detectado cai fora.',
    atendimento: 'Trabalho: os horários em que você atende. É o que a IA oferece pra quem chega querendo marcar um serviço — e só vale com o interruptor de atendimento ligado.',
  }
  const TIPO_VAZIO = {
    encontro: 'Sem horário definido: a IA propõe encontro em aberto, sem sugerir dia nem hora, como faz hoje.',
    compromisso: 'Sem horário de compromisso: quando você perguntar "quando eu posso", o sistema vai dizer que não tem como saber — e ele está certo.',
    atendimento: 'Sem horário de atendimento: com o interruptor ligado, a IA combina o horário conversando, sem oferecer um dia certo. Cadastre aqui pra ela oferecer horário de verdade.',
  }
  const dataBr = (iso) => String(iso || '').split('-').reverse().join('/')

  // As cidades do lugar, só quando dizem algo além do nome. "São Paulo / São Paulo" repetido
  // na linha é ruído: o segundo não informa nada que o primeiro já não tenha dito.
  function cidadesExtras(lugar) {
    if (!lugar || !lugar.cidades || !lugar.cidades.length) return ''
    if (lugar.cidades.length === 1 && lugar.cidades[0].toLowerCase() === String(lugar.nome).toLowerCase()) return ''
    return lugar.cidades.join(', ')
  }

  function renderDisponibilidadePane() {
    const sec = el('section', 'disp-pane')
    sec.id = 'dispPane'
    sec.setAttribute('aria-label', 'Sua disponibilidade')
    sec.innerHTML = `<div class="disp-loading">${icon('i-cal', 'ico')}<span>carregando sua disponibilidade…</span></div>`
    return sec
  }

  async function loadDisponibilidade() {
    const host = $('#dispPane'); if (!host) return
    const d = await api('/api/self/disponibilidade')
    if (!d) { host.replaceChildren(emptyState('i-cal', 'Disponibilidade indisponível', 'O painel não conseguiu ler sua disponibilidade. Tente de novo em instantes.')); return }
    DISP.dados = d
    host.replaceChildren(dispCabecalho(d), dispBlocoJanelas(d), dispBlocoPeriodos(d), dispBlocoLugares(d))
  }

  // ---- cabeçalho: onde ele está agora e o interruptor de propor encontro
  function dispCabecalho(d) {
    const box = el('div', 'disp-head')
    const hoje = d.hoje || {}
    const ondeTxt = hoje.ocupado
      ? 'hoje está marcado como ocupado'
      : hoje.nome ? `hoje você está em ${hoje.nome}${hoje.fora ? ' (fora da sua base)' : ''}` : 'nenhuma base cadastrada'
    box.innerHTML = `
      <div class="disp-head-top">
        <div><span class="agenda-pane-kicker">Sua disponibilidade</span><h2>Quando e onde você pode</h2></div>
        <span class="disp-onde${hoje.fora || hoje.ocupado ? ' fora' : ''}">${icon('i-pin', 'ico ico-sm')}${esc(ondeTxt)}</span>
      </div>
      <p class="disp-explica">Horário aqui é <b>declarado</b>: dia vazio na Google Agenda não vira horário livre, e compromisso na agenda desconta do que você declarou.</p>
      <div class="enc-ai-row">
        <div class="enc-ai-txt"><b>A IA pode propor encontro</b><small>desligado: ela continua conversando normal, mas não puxa nem marca nada</small></div>
        <button type="button" class="toggle" id="dispProporToggle" role="switch" aria-checked="${d.proporDates ? 'true' : 'false'}" aria-label="A IA pode propor encontro"></button>
      </div>
      <div class="enc-ai-row">
        <div class="enc-ai-txt"><b>A IA pode marcar atendimento</b><small>isto é trabalho, não é encontro: só vale com quem já tem serviço seu na conversa, e independe do interruptor de cima</small></div>
        <button type="button" class="toggle" id="dispAtendToggle" role="switch" aria-checked="${d.marcarAtendimento ? 'true' : 'false'}" aria-label="A IA pode marcar atendimento"></button>
      </div>`
    const tg = box.querySelector('#dispProporToggle')
    tg.addEventListener('click', async () => {
      const next = tg.getAttribute('aria-checked') !== 'true'
      tg.disabled = true
      const r = await post('/api/self/encontros/propor', { enabled: next })
      tg.disabled = false
      if (r && r.ok) {
        tg.setAttribute('aria-checked', r.proporDates ? 'true' : 'false')
        toast(r.proporDates ? 'A IA pode propor encontro' : 'A IA não propõe mais encontro')
      } else toast('Não deu pra mudar o ajuste', 'err')
    })
    const tgA = box.querySelector('#dispAtendToggle')
    tgA.addEventListener('click', async () => {
      const next = tgA.getAttribute('aria-checked') !== 'true'
      tgA.disabled = true
      const r = await post('/api/self/atendimento/marcar', { enabled: next })
      tgA.disabled = false
      if (r && r.ok) {
        tgA.setAttribute('aria-checked', r.marcarAtendimento ? 'true' : 'false')
        toast(r.marcarAtendimento ? 'A IA pode marcar atendimento' : 'A IA não marca mais atendimento')
      } else toast('Não deu pra mudar o ajuste', 'err')
    })
    return box
  }

  // ---- bloco 1: as janelas semanais, por família
  function dispBlocoJanelas(d) {
    const box = el('div', 'disp-bloco')
    const tipo = DISP.tipoAtivo
    const janelas = (d.janelas && d.janelas[tipo]) || []
    const proximos = (d.proximos && d.proximos[tipo]) || []
    const lugares = d.lugares || []
    const baseId = d.base ? d.base.id : null

    box.innerHTML = `
      <div class="disp-bloco-head">
        <b>Horários que você topa</b>
        <div class="disp-tabs" role="tablist">
          ${d.tipos.map((t) => `<button type="button" class="disp-tab${t === tipo ? ' on' : ''}" data-tipo="${t}" role="tab" aria-selected="${t === tipo}">${TIPO_LABEL[t]}</button>`).join('')}
        </div>
      </div>
      <p class="disp-bloco-sub">${esc(TIPO_SUB[tipo] || '')}</p>
      <div class="enc-add">
        <span class="enc-add-lbl">Disponível em</span>
        <div class="enc-days" id="dispDays">${DIAS_CURTO.map((x, i) => `<button type="button" class="enc-day" data-dow="${i}">${x}</button>`).join('')}</div>
        <div class="enc-hours">
          <button type="button" class="enc-hour" id="dispIni" data-h="19:00">19:00</button>
          <span class="enc-sep">até</span>
          <button type="button" class="enc-hour" id="dispFim" data-h="23:00">23:00</button>
          ${lugares.length > 1 ? `<button type="button" class="enc-hour disp-lugar-pick" id="dispLugar" data-lugar="${esc(baseId || '')}">${esc(d.base ? d.base.nome : 'lugar')}</button>` : ''}
          <button type="button" class="btn small" id="dispAdd">Adicionar</button>
        </div>
      </div>
      <div class="enc-list" id="dispList"></div>
      <div class="enc-next" id="dispNext"></div>`

    box.querySelectorAll('.disp-tab').forEach((b) => b.addEventListener('click', () => {
      DISP.tipoAtivo = b.dataset.tipo
      loadDisponibilidade()
    }))
    const days = box.querySelector('#dispDays')
    days.querySelectorAll('.enc-day').forEach((b) => b.addEventListener('click', () => b.classList.toggle('on')))
    box.querySelector('#dispIni').addEventListener('click', (e) => abrirSeletorHora(e.currentTarget))
    box.querySelector('#dispFim').addEventListener('click', (e) => abrirSeletorHora(e.currentTarget))
    const btnLugar = box.querySelector('#dispLugar')
    if (btnLugar) btnLugar.addEventListener('click', (e) => abrirSeletorLugar(e.currentTarget, lugares))
    box.querySelector('#dispAdd').addEventListener('click', async () => {
      const dows = [...days.querySelectorAll('.enc-day.on')].map((b) => Number(b.dataset.dow))
      if (!dows.length) { toast('Escolha pelo menos um dia', 'err'); return }
      const inicio = box.querySelector('#dispIni').dataset.h, fim = box.querySelector('#dispFim').dataset.h
      const lugarId = btnLugar ? (btnLugar.dataset.lugar || null) : null
      for (const dow of dows) {
        const r = await post('/api/self/disponibilidade/janela', { dow, inicio, fim, tipo, lugarId })
        if (!r || !r.ok) { toast(r?.error || 'Não deu pra salvar', 'err'); return }
      }
      toast('Disponibilidade salva')
      loadDisponibilidade()
    })

    const lista = box.querySelector('#dispList')
    if (!janelas.length) {
      lista.appendChild(el('p', 'enc-vazio', TIPO_VAZIO[tipo] || ''))
      // ATALHO DE MUDANÇA DE FAMÍLIA: quem já tinha os horários cadastrados como "encontro"
      // e passou a atender por eles não deve ter que redigitar catorze linhas. O clique é
      // dele — copiar sozinho seria decidir o que é trabalho e o que é romance por ele.
      const deOnde = (d.janelas?.encontro || []).filter((j) => j.ativo)
      if (tipo === 'atendimento' && deOnde.length) {
        const copiar = el('button', 'btn small', `Copiar os ${deOnde.length} horários de encontro`)
        copiar.type = 'button'
        copiar.addEventListener('click', async () => {
          copiar.disabled = true
          for (const j of deOnde) {
            const r = await post('/api/self/disponibilidade/janela', { dow: j.dow, inicio: j.inicio, fim: j.fim, tipo: 'atendimento', lugarId: j.lugar_id || null })
            if (!r || !r.ok) { toast(r?.error || 'Não deu pra copiar', 'err'); copiar.disabled = false; return }
          }
          toast('Horários copiados pra atendimento')
          loadDisponibilidade()
        })
        lista.appendChild(copiar)
      }
    } else {
      janelas.forEach((j) => {
        const row = el('div', 'enc-item')
        // O lugar só aparece quando NÃO é a base: repetir o nome da região-base em toda linha
        // seria ruído, e o que importa ver de longe é a linha que foge do normal.
        const foraDaBase = j.lugar && baseId && j.lugar.id !== baseId
        row.innerHTML = `<span class="enc-item-dia">${DIAS_CURTO[j.dow]}</span><span class="enc-item-hora">${esc(j.inicio)} às ${esc(j.fim)}</span>${foraDaBase ? `<span class="enc-item-lugar">${icon('i-pin', 'ico ico-sm')}${esc(j.lugar.nome)}</span>` : ''}`
        const x = el('button', 'enc-item-x', '×')
        x.type = 'button'; x.title = 'Remover'
        x.setAttribute('aria-label', `Remover ${DIAS_CURTO[j.dow]} das ${j.inicio} às ${j.fim}`)
        x.addEventListener('click', async () => {
          const r = await del(`/api/self/disponibilidade/janela/${encodeURIComponent(j.id)}`)
          if (r) toast('horário removido')
          loadDisponibilidade()
        })
        row.appendChild(x)
        lista.appendChild(row)
      })
    }

    const next = box.querySelector('#dispNext')
    if (proximos.length) {
      next.appendChild(el('span', 'enc-next-lbl', tipo === 'encontro' ? 'Próximos horários que ela pode oferecer' : 'Próximos horários livres'))
      proximos.slice(0, 4).forEach((s) => next.appendChild(el('span', 'enc-next-chip', esc(s.descricao))))
    } else if (janelas.length) {
      // Diz o MOTIVO quando ele é sabido. "Nenhum horário livre" sem motivo faz ele achar
      // que a tela quebrou; "você está em São Paulo" explica e resolve na hora.
      const hoje = d.hoje || {}
      const motivo = hoje.ocupado ? 'hoje está marcado como ocupado'
        : hoje.fora ? `você está em ${hoje.nome}, e sua disponibilidade cadastrada é de outro lugar`
        : 'a agenda ou um período estão ocupando tudo que você declarou'
      next.appendChild(el('span', 'enc-next-lbl vazio', `Nenhum horário livre nos próximos 10 dias: ${motivo}.`))
    }
    return box
  }

  // ---- bloco 2: os períodos (viagem / ocupado)
  // A explicação longa mora no VAZIO. Com período na tela, o exemplo de São Paulo já está
  // ali em cima na forma de dado — repetir a mesma lição em 43 palavras acima de cada lista
  // transforma o painel num manual. Explica quando não tem nada; sai da frente quando tem.
  function dispBlocoPeriodos(d) {
    const box = el('div', 'disp-bloco')
    const periodos = d.periodos || []
    // Sem calendário na tela (agenda desconectada) não existe onde clicar: em vez de um botão
    // que não faz nada, a linha diz o que falta. Opção visível tem que ter efeito real.
    const temCalendario = !!$('#agendaCalHost')
    box.innerHTML = `
      <div class="disp-bloco-head">
        <b>Períodos${periodos.length ? ` <span class="disp-cont">${periodos.length}</span>` : ''}</b>
        ${temCalendario ? `<button type="button" class="btn small ghost" id="dispPerNovo">${icon('i-cal', 'ico ico-sm')} Marcar no calendário</button>` : '<small class="disp-bloco-nota">conecte a Google Agenda pra marcar período clicando no mês</small>'}
      </div>
      ${periodos.length
        ? '<p class="disp-bloco-sub curto">Enquanto durar, só vale a disponibilidade daquele lugar.</p>'
        : `<p class="disp-bloco-sub">Viagem ou temporada fora. Enquanto durar, sua disponibilidade dos outros lugares não vale — se você está em outro estado, não sai horário na sua região de casa.</p>
           <p class="disp-bloco-sub">Já tem a viagem no calendário? Abre o compromisso e usa "nesse período eu estou em…" — as datas vêm preenchidas.</p>`}
      <div class="disp-per-list" id="dispPerList"></div>`
    const btnNovo = box.querySelector('#dispPerNovo')
    if (btnNovo) btnNovo.addEventListener('click', () => iniciarMarcacaoPeriodo())
    const lista = box.querySelector('#dispPerList')
    if (!periodos.length) lista.appendChild(el('p', 'enc-vazio', 'Nenhum período pela frente: você está sempre na sua base.'))
    else periodos.forEach((p) => {
      const row = el('div', `disp-per${p.tipo === 'ocupado' ? ' ocupado' : ''}`)
      const nomeLugar = p.tipo === 'ocupado' ? 'Ocupado, nada pode ser marcado' : (p.lugar ? `Em ${p.lugar.nome}` : 'lugar removido')
      // A linha inteira é o botão de EDITAR. Antes ela era um div com um × do lado: pra mudar
      // um dia da viagem ele tinha que apagar e refazer, e nada na tela dizia isso.
      const corpo = el('button', 'disp-per-abrir')
      corpo.type = 'button'
      corpo.setAttribute('aria-label', `Editar o período ${nomeLugar}, ${periodoQuando(p).lido}`)
      corpo.innerHTML = `
        <span class="disp-per-txt">
          <b>${esc(nomeLugar)}</b>
          <small>${esc(periodoQuando(p).curto)}</small>
          <small class="disp-per-meta">${[p.titulo ? esc(p.titulo) : '', p.event_id ? 'da sua agenda' : ''].filter(Boolean).join(' · ')}</small>
        </span>
        ${icon('i-arrow-r', 'ico ico-sm')}`
      corpo.addEventListener('click', () => abrirEditorPeriodo({
        id: p.id, de: p.de, ate: p.ate, tipo: p.tipo, lugarId: p.lugar_id, titulo: p.titulo || '', eventId: p.event_id || null,
      }))
      row.appendChild(corpo)
      // Apagar uma viagem por clique errado custa caro: arma antes de fazer.
      const x = el('button', 'fato-x', '×')
      x.type = 'button'; x.title = 'Remover período'
      x.setAttribute('aria-label', `Remover o período de ${periodoQuando(p).lido}`)
      let armado = false, timer = null
      x.addEventListener('click', async () => {
        if (!armado) {
          armado = true
          x.classList.add('armado'); x.textContent = 'apagar?'
          timer = setTimeout(() => { if (x.isConnected) { armado = false; x.classList.remove('armado'); x.textContent = '×' } }, 4000)
          return
        }
        clearTimeout(timer)
        const r = await del(`/api/self/periodo/${encodeURIComponent(p.id)}`)
        if (r) toast('período removido')
        loadDisponibilidade()
      })
      row.appendChild(x)
      lista.appendChild(row)
    })
    return box
  }

  // "4 a 6 de agosto · 3 dias · em 9 dias". A data crua com o ano duas vezes
  // ("04/08/2026 a 06/08/2026") não diz nem quanto dura nem se é longe.
  const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
  function periodoQuando(p) {
    const [ay, am, ad] = String(p.de).split('-').map(Number)
    const [by, bm, bd] = String(p.ate || p.de).split('-').map(Number)
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0)
    const ini = new Date(ay, am - 1, ad), fim = new Date(by, bm - 1, bd)
    const dias = Math.round((fim - ini) / 86400000) + 1
    const faltam = Math.round((ini - hoje) / 86400000)
    const anoAtual = hoje.getFullYear()
    const mesmoMes = am === bm && ay === by
    const trecho = mesmoMes
      ? (ad === bd ? `${ad} de ${MESES[am - 1]}` : `${ad} a ${bd} de ${MESES[am - 1]}`)
      : `${ad} de ${MESES[am - 1]} a ${bd} de ${MESES[bm - 1]}`
    const ano = (ay !== anoAtual || by !== anoAtual) ? ` de ${by}` : ''
    const quando = faltam < 0 && dias + faltam > 0 ? 'agora'
      : faltam === 0 ? 'começa hoje'
      : faltam === 1 ? 'amanhã'
      : faltam > 1 ? `em ${faltam} dias`
      : 'já passou'
    const dur = dias === 1 ? '1 dia' : `${dias} dias`
    return { curto: `${trecho}${ano} · ${dur} · ${quando}`, lido: `${trecho}${ano}, ${dur}, ${quando}` }
  }

  // ---- bloco 3: os lugares
  function dispBlocoLugares(d) {
    const box = el('div', 'disp-bloco')
    const lugares = d.lugares || []
    const temMaisDeUm = lugares.length > 1
    box.innerHTML = `
      <div class="disp-bloco-head">
        <b>Lugares${lugares.length ? ` <span class="disp-cont">${lugares.length}</span>` : ''}</b>
        <button type="button" class="btn small ghost" id="dispLugarNovo">Novo lugar</button>
      </div>
      ${temMaisDeUm
        ? '<p class="disp-bloco-sub curto">Cada lugar é o grupo de cidades que você alcança de onde está.</p>'
        : '<p class="disp-bloco-sub">Um lugar é o grupo de cidades que você alcança de onde está: de casa você chega na sua cidade e nas vizinhas, então as três são o mesmo lugar. A <b>base</b> é onde você está quando nenhum período diz o contrário.</p>'}
      <div class="disp-lug-list" id="dispLugList"></div>`
    box.querySelector('#dispLugarNovo').addEventListener('click', () => abrirEditorLugar(null))
    const lista = box.querySelector('#dispLugList')
    if (!lugares.length) lista.appendChild(el('p', 'enc-vazio', 'Nenhum lugar cadastrado. Sem base, o lugar não filtra nada e todo horário que você declarar vale sempre.'))
    else {
      // Quantas janelas e períodos dependem de cada lugar. Responde a pergunta que a linha
      // realmente levanta ("posso apagar isso?") em vez de "uma cidade só", que não dizia nada.
      const todasJanelas = [...(d.janelas?.encontro || []), ...(d.janelas?.compromisso || [])]
      const baseId = d.base ? d.base.id : null
      lugares.forEach((l) => {
        const nJan = todasJanelas.filter((j) => (j.lugar_id || baseId) === l.id).length
        const nPer = (d.periodos || []).filter((p) => p.lugar_id === l.id).length
        const uso = [nJan ? `${nJan} horário${nJan === 1 ? '' : 's'}` : '', nPer ? `${nPer} período${nPer === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
        const cid = cidadesExtras(l)
        const row = el('button', `disp-lug${l.base ? ' base' : ''}`)
        row.type = 'button'
        row.setAttribute('aria-label', `Editar o lugar ${l.nome}${l.base ? ', sua base' : ''}`)
        row.innerHTML = `
          <span class="disp-lug-txt">
            <b>${esc(l.nome)}${l.base ? '<span class="disp-lug-base">base</span>' : ''}</b>
            ${cid ? `<small>${esc(cid)}</small>` : ''}
            <small class="disp-lug-uso">${esc(uso || 'nada usa esse lugar ainda')}</small>
          </span>
          ${icon('i-arrow-r', 'ico ico-sm')}`
        row.addEventListener('click', () => abrirEditorLugar(l))
        lista.appendChild(row)
      })
    }
    return box
  }

  // Seletor de lugar sem select nativo, no mesmo molde do seletor de hora.
  function abrirSeletorLugar(botao, lugares, aoEscolher) {
    const antigo = $('.hour-pop'); if (antigo) antigo.remove()
    const pop = el('div', 'hour-pop hour-pop-wide')
    lugares.forEach((l) => {
      const b = el('button', 'hour-opt' + (botao.dataset.lugar === l.id ? ' on' : ''), `${esc(l.nome)}${l.base ? ' (base)' : ''}`)
      b.type = 'button'
      b.addEventListener('click', () => {
        botao.dataset.lugar = l.id
        botao.textContent = l.nome
        pop.remove()
        if (aoEscolher) aoEscolher(l)
      })
      pop.appendChild(b)
    })
    document.body.appendChild(pop)
    const r = botao.getBoundingClientRect()
    pop.style.top = `${Math.min(window.innerHeight - 200, r.bottom + 6)}px`
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 240, r.left))}px`
    const fecha = (e) => { if (!pop.contains(e.target) && e.target !== botao) { pop.remove(); document.removeEventListener('mousedown', fecha) } }
    setTimeout(() => document.addEventListener('mousedown', fecha), 0)
  }

  // O que morre junto com o lugar, dito ANTES no rótulo do botão. Descobrir pelo toast depois
  // que os três horários de sexta foram embora é tarde: o aviso tem que estar no botão.
  function levaJunto(lugar) {
    if (!lugar || !DISP.dados) return ''
    const baseId = DISP.dados.base ? DISP.dados.base.id : null
    const jan = [...(DISP.dados.janelas?.encontro || []), ...(DISP.dados.janelas?.compromisso || [])]
      .filter((j) => (j.lugar_id || baseId) === lugar.id).length
    const per = (DISP.dados.periodos || []).filter((p) => p.lugar_id === lugar.id).length
    return [jan ? `${jan} horário${jan === 1 ? '' : 's'}` : '', per ? `${per} período${per === 1 ? '' : 's'}` : ''].filter(Boolean).join(' e ')
  }

  // Editor de lugar: nome, cidades e se é a base. Cidades entram como chips, uma por vez —
  // uma caixa de texto com vírgula funciona, mas dá pra errar sem perceber (espaço, vírgula
  // dupla), e chip mostra exatamente o que foi guardado.
  function abrirEditorLugar(lugar) {
    const eNovo = !lugar
    const cidades = lugar ? [...lugar.cidades] : []
    const sheet = el('section', 'pj-sheet disp-lug-sheet')
    const pinta = () => {
      const host = sheet.querySelector('#lugCidades')
      host.replaceChildren()
      if (!cidades.length) host.appendChild(el('span', 'disp-chip-vazio', 'nenhuma cidade ainda'))
      cidades.forEach((c, i) => {
        const chip = el('span', 'disp-chip', esc(c))
        const x = el('button', 'disp-chip-x', '×')
        x.type = 'button'; x.setAttribute('aria-label', `Tirar ${c}`)
        x.addEventListener('click', () => { cidades.splice(i, 1); pinta() })
        chip.appendChild(x)
        host.appendChild(chip)
      })
    }
    sheet.innerHTML = `
      <div class="pj-sheet-head">
        <div><span class="agenda-pane-kicker">${eNovo ? 'Novo lugar' : 'Lugar'}</span><h2>${esc(eNovo ? 'Onde você pode estar' : lugar.nome)}</h2></div>
        <button class="icon-btn" type="button" id="lugFechar" aria-label="Fechar">${icon('i-x')}</button>
      </div>
      <div class="disp-lug-form">
        <label class="agenda-event-field agenda-event-field-full"><span>Nome</span>
          <input id="lugNome" type="text" maxlength="80" value="${esc(lugar ? lugar.nome : '')}" placeholder="nome da região"></label>
        <div class="agenda-event-field agenda-event-field-full">
          <span>Cidades que você alcança daí</span>
          <div class="disp-chips" id="lugCidades"></div>
          <div class="disp-chip-add">
            <input id="lugCidade" type="text" maxlength="80" placeholder="cidade">
            <button type="button" class="btn small ghost" id="lugCidadeAdd">Adicionar cidade</button>
          </div>
        </div>
        <div class="enc-ai-row">
          <div class="enc-ai-txt"><b>É a minha base</b><small>onde você está quando nenhum período diz o contrário</small></div>
          <button type="button" class="toggle" id="lugBase" role="switch" aria-checked="${lugar && lugar.base ? 'true' : 'false'}" aria-label="É a minha base"></button>
        </div>
        <div class="agenda-event-form-actions">
          ${!eNovo ? `<button type="button" class="btn ghost small danger-soft" id="lugApagar">Apagar${levaJunto(lugar) ? ` (leva ${esc(levaJunto(lugar))})` : ' lugar'}</button>` : ''}
          <button type="button" class="btn" id="lugSalvar">Salvar</button>
        </div>
      </div>`
    pinta()
    const fechar = () => sheet.remove()
    sheet.querySelector('#lugFechar').addEventListener('click', fechar)
    const addCidade = () => {
      const inp = sheet.querySelector('#lugCidade')
      const v = inp.value.trim()
      if (!v) return
      if (!cidades.some((c) => c.toLowerCase() === v.toLowerCase())) cidades.push(v)
      inp.value = ''
      pinta()
    }
    sheet.querySelector('#lugCidadeAdd').addEventListener('click', addCidade)
    sheet.querySelector('#lugCidade').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCidade() } })
    const tgBase = sheet.querySelector('#lugBase')
    tgBase.addEventListener('click', () => tgBase.setAttribute('aria-checked', tgBase.getAttribute('aria-checked') !== 'true' ? 'true' : 'false'))
    sheet.querySelector('#lugSalvar').addEventListener('click', async () => {
      const nome = sheet.querySelector('#lugNome').value.trim()
      if (!nome) { toast('O lugar precisa de um nome', 'err'); return }
      const r = await post('/api/self/lugar', { id: lugar?.id, nome, cidades, base: tgBase.getAttribute('aria-checked') === 'true' })
      if (!r || !r.ok) { toast(r?.error || 'Não deu pra salvar', 'err'); return }
      toast(eNovo ? 'lugar criado' : 'lugar salvo')
      fechar()
      loadDisponibilidade()
    })
    const apagar = sheet.querySelector('#lugApagar')
    // Apagar diz o que levou junto. "removi o lugar" e "removi o lugar e os seus 3 horários"
    // são fatos diferentes, e ele tem que ver o segundo quando for o caso.
    if (apagar) apagar.addEventListener('click', (e) => confirmDestructive(e.currentTarget, 'Confirmar', async () => {
      const r = await del(`/api/self/lugar/${encodeURIComponent(lugar.id)}`)
      if (!r) { toast('Não deu pra apagar', 'err'); return }
      const extras = []
      if (r.janelas) extras.push(`${r.janelas} horário${r.janelas === 1 ? '' : 's'}`)
      if (r.periodos) extras.push(`${r.periodos} período${r.periodos === 1 ? '' : 's'}`)
      toast(extras.length ? `lugar apagado, e com ele ${extras.join(' e ')}` : 'lugar apagado')
      fechar()
      loadDisponibilidade()
    }))
    document.body.appendChild(sheet)
    sheet.querySelector('#lugNome').focus()
  }

  // ---- marcar período clicando no calendário
  // Duas datas, dois cliques, no calendário que ele já está olhando. Sem input de data nativo
  // e sem ele digitar "2026-08-10" — a viagem é um pedaço visível do mês.
  function iniciarMarcacaoPeriodo(preset = null) {
    const cal = $('#agendaCalHost')
    if (!cal) { toast('Conecte a Google Agenda pra marcar período no calendário', 'err'); return }
    DISP.marcando = { de: null, ate: null, ...(preset || {}) }
    if (DISP.marcando.de && DISP.marcando.ate) { abrirEditorPeriodo(DISP.marcando); DISP.marcando = null; return }
    renderCalendar()
    // ROLAR ATÉ O CALENDÁRIO. Sem isto o botão entrava num modo invisível: o mês fica ~900px
    // acima do painel, então o clique só produzia um toast mandando clicar num dia que não
    // estava na tela. Era um botão que, pra quem olha, não fazia nada.
    //
    // O desconto do cabeçalho fixo não é detalhe: com `scrollIntoView` puro, a barra do topo
    // cobria o nome do mês e as setas, e ele ficava escolhendo dias sem ver em que mês estava
    // — nem como ir pro mês seguinte, que é justamente o caso de uma viagem que vira o mês.
    const topoFixo = document.querySelector('.topbar, .app-header, header')
    const folga = (topoFixo ? topoFixo.getBoundingClientRect().height : 0) + 12
    const alvo = cal.getBoundingClientRect().top + window.scrollY - folga
    window.scrollTo({ top: Math.max(0, alvo), behavior: 'smooth' })
    // Escape desiste — modo sem saída é armadilha.
    if (!DISP.escOuvinte) {
      DISP.escOuvinte = (e) => { if (e.key === 'Escape' && DISP.marcando) cancelarMarcacaoPeriodo() }
      document.addEventListener('keydown', DISP.escOuvinte)
    }
  }

  function cancelarMarcacaoPeriodo() {
    if (!DISP.marcando) return
    DISP.marcando = null
    renderCalendar()
    toast('marcação cancelada')
  }

  function cliqueNoDiaMarcando(key) {
    const m = DISP.marcando
    if (!m.de) { m.de = key; renderCalendar(); return }
    const de = key < m.de ? key : m.de
    const ate = key < m.de ? m.de : key
    const resto = { id: m.id, tipo: m.tipo, lugarId: m.lugarId, titulo: m.titulo, eventId: m.eventId }
    DISP.marcando = null
    renderCalendar()
    abrirEditorPeriodo({ de, ate, ...resto })
  }

  // O editor do período. Serve pra criar E pra editar: com `id`, os campos vêm preenchidos e
  // salvar altera em vez de criar outro. Antes só criava — mudar um dia da viagem obrigava a
  // apagar e refazer, e nada na tela dizia isso.
  function abrirEditorPeriodo({ id = null, de, ate, tipo = 'em_lugar', lugarId = null, titulo = '', eventId = null }) {
    const lugares = (DISP.dados?.lugares || [])
    const naoBase = lugares.filter((l) => !l.base)
    // Editando, o lugar que manda é o que está gravado. Criando, o palpite é o primeiro que
    // não é a base — quem cria período quase nunca está criando pra onde já mora.
    const inicial = (lugarId && lugares.find((l) => l.id === lugarId)) || naoBase[0] || lugares[0] || null
    const eNovo = !id
    const sheet = el('section', 'pj-sheet disp-per-sheet')
    const fake = { de, ate }
    sheet.innerHTML = `
      <div class="pj-sheet-head">
        <div><span class="agenda-pane-kicker">${eNovo ? 'Novo período' : 'Período'}</span><h2>${esc(periodoQuando(fake).curto)}</h2></div>
        <button class="icon-btn" type="button" id="perFechar" aria-label="Fechar">${icon('i-x')}</button>
      </div>
      <div class="disp-lug-form">
        ${eventId ? `<p class="disp-per-origem">${icon('i-cal', 'ico ico-sm')} veio de um compromisso da sua agenda</p>` : ''}
        <div class="disp-tabs disp-tabs-full" role="tablist">
          <button type="button" class="disp-tab${tipo !== 'ocupado' ? ' on' : ''}" data-modo="em_lugar" role="tab" aria-selected="${tipo !== 'ocupado'}">Estou em outro lugar</button>
          <button type="button" class="disp-tab${tipo === 'ocupado' ? ' on' : ''}" data-modo="ocupado" role="tab" aria-selected="${tipo === 'ocupado'}">Ocupado, nada marcado</button>
        </div>
        <div class="disp-per-lugar" id="perLugarBox"${tipo === 'ocupado' ? ' hidden' : ''}>
          ${lugares.length
            ? `<span class="enc-add-lbl">Onde você vai estar</span>
               <button type="button" class="enc-hour disp-lugar-pick" id="perLugar" data-lugar="${esc(inicial ? inicial.id : '')}">${esc(inicial ? inicial.nome : 'escolher')}</button>`
            : '<p class="enc-vazio">Você não tem lugar cadastrado ainda. Crie um lugar primeiro, ou marque como ocupado.</p>'}
        </div>
        <label class="agenda-event-field agenda-event-field-full"><span>O que é (opcional)</span>
          <input id="perTitulo" type="text" maxlength="120" value="${esc(titulo)}" placeholder="Viagem a São Paulo"></label>
        <div class="agenda-event-form-actions">
          <button type="button" class="btn ghost small" id="perDatas">${icon('i-cal', 'ico ico-sm')} Mudar as datas no calendário</button>
          <button type="button" class="btn" id="perSalvar">${eNovo ? 'Salvar período' : 'Salvar'}</button>
        </div>
      </div>`
    const fechar = () => sheet.remove()
    sheet.querySelector('#perFechar').addEventListener('click', fechar)
    let modo = tipo === 'ocupado' ? 'ocupado' : 'em_lugar'
    sheet.querySelectorAll('.disp-tab').forEach((b) => b.addEventListener('click', () => {
      modo = b.dataset.modo
      sheet.querySelectorAll('.disp-tab').forEach((o) => { o.classList.toggle('on', o === b); o.setAttribute('aria-selected', String(o === b)) })
      sheet.querySelector('#perLugarBox').hidden = modo === 'ocupado'
    }))
    const btnL = sheet.querySelector('#perLugar')
    if (btnL) btnL.addEventListener('click', (e) => abrirSeletorLugar(e.currentTarget, lugares))
    // Trocar as datas usa o MESMO mecanismo de sempre (dois cliques no mês), carregando o que
    // já foi preenchido aqui — ele não perde o lugar nem o título ao mexer na data.
    sheet.querySelector('#perDatas').addEventListener('click', () => {
      const levar = { id, tipo: modo, lugarId: modo === 'em_lugar' ? (btnL ? btnL.dataset.lugar : null) : null, titulo: sheet.querySelector('#perTitulo').value.trim(), eventId }
      fechar()
      iniciarMarcacaoPeriodo(levar)
    })
    sheet.querySelector('#perSalvar').addEventListener('click', async () => {
      const escolhido = modo === 'em_lugar' ? (btnL ? btnL.dataset.lugar : null) : null
      if (modo === 'em_lugar' && !escolhido) { toast('Escolha o lugar, ou marque como ocupado', 'err'); return }
      const r = await post('/api/self/periodo', { id, de, ate, tipo: modo, lugarId: escolhido, titulo: sheet.querySelector('#perTitulo').value.trim(), eventId })
      if (!r || !r.ok) { toast(r?.error || 'Não deu pra salvar', 'err'); return }
      toast(eNovo ? 'período salvo' : 'período atualizado')
      fechar()
      loadDisponibilidade()
      loadAgenda()
    })
    document.body.appendChild(sheet)
  }

  // ---------------------------------------------------------------- SOBRE MIM / FATOS (Config)
  const SENS_LABEL = { livre: 'pode falar', sob_pedido: 'só se o assunto vier', nunca: 'nunca falar' }

  function renderFatosSection() {
    const wrap = el('div', 'cfg-fatos')
    wrap.innerHTML = `
      <div class="sobre-mim-extrator">
        <div class="sobre-mim-extrator-copy">
          <b>Construir meu Sobre mim pelas conversas</b>
          <small>Sincroniza o que estiver disponível no WhatsApp e Tinder, mede sua escrita e também o padrão adulto do modo quente. Tudo é processado nesta máquina; fatos pessoais ficam esperando sua aprovação.</small>
        </div>
        <button type="button" class="btn" id="sobreMimExtrair">Extrair o Sobre mim das conversas</button>
        <div class="sobre-mim-estado" id="sobreMimEstado" aria-live="polite"></div>
      </div>
      <div class="enc-ai-row">
        <div class="enc-ai-txt"><b>A IA usa esses fatos</b><small>desligado: ela volta a usar só o retrato, como antes</small></div>
        <button type="button" class="toggle" id="fatosAwareToggle" role="switch" aria-checked="true" aria-label="A IA usa esses fatos"></button>
      </div>
      <div class="fatos-actions">
        <button type="button" class="btn small ghost" id="fatosNovo">Escrever um fato</button>
        <span class="fatos-count" id="fatosCount"></span>
      </div>
      <div class="fatos-list" id="fatosList"></div>`
    return wrap
  }

  function linhaFato(f) {
    const row = el('div', `fato-item fato-${f.status} sens-${f.sensibilidade}`)
    const expirado = f.valid_to && f.valid_to < Date.now()
    row.innerHTML = `
      <div class="fato-txt">
        <b${expirado ? ' class="fato-expirado"' : ''}>${esc(f.texto)}</b>
        <small>${esc(f.categoria || 'outro')} · ${esc(SENS_LABEL[f.sensibilidade] || f.sensibilidade)}${f.origem ? ' · ' + esc(f.origem) : ''}${expirado ? ' · não vale mais' : ''}${f.usos ? ` · usado ${f.usos}x` : ''}</small>
      </div>`
    const acoes = el('div', 'fato-acoes')
    if (f.status === 'proposto') {
      // `comAviso` existe porque botão sem retorno é indistinguível de botão quebrado — foi
      // exatamente assim que o dono encontrou o defeito do corpo drenado.
      const comAviso = (btn, fn, okMsg) => btn.addEventListener('click', async () => {
        btn.disabled = true
        const r = await fn()
        btn.disabled = false
        if (r) toast(okMsg)
        loadFatos()
      })
      const sim = el('button', 'btn small', 'Aprovar'); sim.type = 'button'
      comAviso(sim, () => post('/api/self/fatos', { ...f, status: 'aprovado' }), 'aprovado, a IA já pode usar')
      const nao = el('button', 'btn small ghost', 'Descartar'); nao.type = 'button'
      comAviso(nao, () => del(`/api/self/fatos/${encodeURIComponent(f.id)}`), 'descartado')
      acoes.append(sim, nao)
    } else {
      const sens = el('button', 'btn small ghost', SENS_LABEL[f.sensibilidade]); sens.type = 'button'
      sens.title = 'Trocar a política deste fato'
      sens.addEventListener('click', async () => {
        const ordem = ['livre', 'sob_pedido', 'nunca']
        const prox = ordem[(ordem.indexOf(f.sensibilidade) + 1) % ordem.length]
        sens.disabled = true
        const r = await post('/api/self/fatos', { ...f, sensibilidade: prox })
        sens.disabled = false
        if (r) toast(`agora: ${SENS_LABEL[prox]}`)
        loadFatos()
      })
      const x = el('button', 'fato-x', '×'); x.type = 'button'; x.title = 'Apagar'
      x.addEventListener('click', async () => {
        x.disabled = true
        const r = await del(`/api/self/fatos/${encodeURIComponent(f.id)}`)
        x.disabled = false
        if (r) toast('apagado')
        loadFatos()
      })
      acoes.append(sens, x)
    }
    row.appendChild(acoes)
    return row
  }

  function pintarEstadoSobreMim(estado) {
    const host = $('#sobreMimEstado')
    const btn = $('#sobreMimExtrair')
    if (!host || !btn) return
    const rotulo = 'Extrair o Sobre mim das conversas'
    if (!estado) {
      btn.disabled = false; btn.textContent = rotulo
      host.innerHTML = '<span>Ainda não extraído. A cobertura real aparece aqui depois da leitura.</span>'
      return
    }
    if (estado.status === 'rodando') {
      const feito = Number(estado.feito) || 0, total = Number(estado.total) || 0
      btn.disabled = true
      btn.textContent = `${estado.etapa || 'Extraindo'}${total ? ` · ${feito}/${total}` : '…'}`
      host.innerHTML = `<span class="sobre-mim-andando"><i></i><b>${esc(estado.etapa || 'extraindo')}</b>${estado.detalhe ? ` · ${esc(estado.detalhe)}` : ''}</span>`
      return
    }
    btn.disabled = false; btn.textContent = rotulo
    if (estado.status === 'erro' || estado.status === 'interrompida') {
      host.innerHTML = `<span class="sobre-mim-falhou"><b>${estado.status === 'interrompida' ? 'Leitura interrompida' : 'A leitura falhou'}</b>${estado.erro ? ` · ${esc(estado.erro)}` : ' · pode tentar novamente'}</span>`
      return
    }
    const r = estado.resultado
    if (!r) { host.textContent = 'Sem resultado salvo'; return }
    const wa = r.cobertura?.canais?.whatsapp || {}
    const ti = r.cobertura?.canais?.tinder || {}
    const tinderFracao = ti.conversasConhecidas ? `${ti.historicosVerificados || 0} de ${ti.conversasConhecidas} históricos verificados` : 'sem conversa conhecida'
    const quente = r.quente || {}
    const qu = quente.universo || {}
    const quenteLinha = quente.gerado
      ? `Modo quente: ${fmtNum(qu.mensagensDaDonaNoContexto || 0)} mensagens próprias em ${fmtNum(qu.sessoes || 0)} sessões · amostra ${esc(quente.qualidade?.amostra || 'medida')}`
      : `Modo quente: sem amostra adulta suficiente para atualizar${qu.conversasExcluidasPorProtecao ? ` · ${fmtNum(qu.conversasExcluidasPorProtecao)} conversas protegidas ficaram fora` : ''}`
    host.innerHTML = `
      <span class="sobre-mim-pronto"><b>Última leitura concluída</b> · ${fmtNum(r.mensagensLidas)} mensagens em ${fmtNum(r.conversasLidas)} conversas · ${fmtNum(r.mensagensDaDona)} mensagens suas de texto</span>
      <span>WhatsApp: ${fmtNum(wa.mensagensDisponiveis || 0)} disponíveis em ${fmtNum(wa.conversasComMensagens || 0)} conversas; o total remoto não é informado</span>
      <span>Tinder: ${fmtNum(ti.mensagensDisponiveis || 0)} disponíveis · ${esc(tinderFracao)}</span>
      <span>${quenteLinha}</span>
      <span>Voz e comportamento atualizados localmente · ${fmtNum(r.propostos || 0)} fatos esperando aprovação</span>`
  }

  async function loadFatos() {
    const host = $('#fatosList'); if (!host) return
    const st = await api('/api/self/fatos')
    if (!st) return
    const tg = $('#fatosAwareToggle')
    if (tg) {
      tg.setAttribute('aria-checked', st.awareness ? 'true' : 'false')
      if (!tg.dataset.bound) {
        tg.dataset.bound = '1'
        tg.addEventListener('click', async () => {
          const next = tg.getAttribute('aria-checked') !== 'true'
          const r = await post('/api/self/fatos/awareness', { enabled: next })
          if (r && r.ok) { tg.setAttribute('aria-checked', r.awareness ? 'true' : 'false'); toast(r.awareness ? 'A IA usa os fatos' : 'A IA voltou a usar só o retrato') }
        })
      }
    }
    pintarEstadoSobreMim(st.sobreMim?.estado || null)
    const btnEx = $('#sobreMimExtrair')
    if (btnEx && !btnEx.dataset.bound) {
      btnEx.dataset.bound = '1'
      btnEx.addEventListener('click', async () => {
        btnEx.disabled = true; btnEx.textContent = 'Preparando…'
        const r = await post('/api/self/sobre-mim/extrair', {})
        if (!r || !r.ok) {
          toast(r?.error || 'Não deu pra começar', 'err')
          btnEx.disabled = false; btnEx.textContent = 'Extrair o Sobre mim das conversas'
        }
      })
    }
    const btnNovo = $('#fatosNovo')
    if (btnNovo && !btnNovo.dataset.bound) {
      btnNovo.dataset.bound = '1'
      btnNovo.addEventListener('click', () => abrirNovoFato())
    }
    const cont = $('#fatosCount')
    if (cont) cont.textContent = st.contagem.total ? `${st.contagem.aprovado || 0} em uso · ${st.contagem.proposto || 0} esperando você · ${st.contagem.nunca || 0} nunca falar` : ''
    host.replaceChildren()
    if (!st.fatos.length) {
      host.appendChild(el('p', 'enc-vazio', 'Nada aqui ainda. A extração lê o que você escreveu e propõe fatos, mas nenhum entra numa conversa sem você aprovar.'))
      return
    }
    const propostos = st.fatos.filter((f) => f.status === 'proposto')
    const aprovados = st.fatos.filter((f) => f.status === 'aprovado')
    if (propostos.length) {
      host.appendChild(el('div', 'fatos-grupo', `<span>Esperando você (${propostos.length})</span>`))
      propostos.forEach((f) => host.appendChild(linhaFato(f)))
    }
    if (aprovados.length) {
      host.appendChild(el('div', 'fatos-grupo', `<span>Em uso (${aprovados.length})</span>`))
      aprovados.forEach((f) => host.appendChild(linhaFato(f)))
    }
  }

  function abrirNovoFato() {
    const pop = el('div', 'fato-novo-pop')
    pop.innerHTML = `
      <b>Escrever um fato</b>
      <p>Uma frase, do jeito que você contaria.</p>
      <input type="text" id="fnTexto" placeholder="Ex: Toco bateria desde os 15" maxlength="300" autocomplete="off">
      <div class="fn-sens">
        <button type="button" class="fn-opt on" data-s="livre">pode falar</button>
        <button type="button" class="fn-opt" data-s="sob_pedido">só se o assunto vier</button>
        <button type="button" class="fn-opt" data-s="nunca">nunca falar</button>
      </div>
      <div class="fn-acoes"><button type="button" class="btn small ghost" id="fnCancel">Cancelar</button><button type="button" class="btn small" id="fnSalvar">Salvar</button></div>`
    document.body.appendChild(pop)
    const fechar = () => pop.remove()
    pop.querySelectorAll('.fn-opt').forEach((b) => b.addEventListener('click', () => {
      pop.querySelectorAll('.fn-opt').forEach((o) => o.classList.remove('on')); b.classList.add('on')
    }))
    $('#fnCancel', pop).addEventListener('click', fechar)
    $('#fnSalvar', pop).addEventListener('click', async () => {
      const texto = $('#fnTexto', pop).value.trim()
      if (texto.length < 5) { toast('Escreve um pouco mais', 'err'); return }
      const sensibilidade = $('.fn-opt.on', pop).dataset.s
      const r = await post('/api/self/fatos', { texto, sensibilidade, status: 'aprovado', origem: 'escrito por mim', categoria: 'outro' })
      if (r && r.ok) { toast('Fato salvo'); fechar(); loadFatos() } else toast('Não deu pra salvar', 'err')
    })
    setTimeout(() => $('#fnTexto', pop)?.focus(), 30)
  }

  // ---------------------------------------------------------------- ÁUDIOS SALVOS (Config)
  // Estado do gravador (MediaRecorder). Um por vez; o blob fica aqui até o dono salvar.
  const REC = { rec: null, stream: null, chunks: [], mime: '', blob: null, secs: 0, timer: null, t0: 0, iniciando: false }

  function pickRecorderMime() {
    // Ordem: webm/opus (Chrome/Firefox) -> webm -> ogg/opus -> mp4 (fallback Safari).
    const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return ''
    for (const c of cands) { if (MediaRecorder.isTypeSupported(c)) return c }
    return ''
  }

  function renderSavedAudioSection() {
    const wrap = el('div', 'cfg-audios')
    // Toggle: IA pode (ou não) mandar áudios. Desligado = a IA volta a ser 100% texto
    // (prompt idêntico ao sem-áudios); o atalho "/" manual NÃO é afetado.
    const ai = el('div', 'sa-ai-row')
    ai.innerHTML = `
      <div class="sa-ai-txt"><b>IA pode mandar áudios</b><small>desligado: a IA responde só com texto; o atalho "/" manual continua</small></div>
      <button type="button" class="toggle" id="saAiToggle" role="switch" aria-checked="true" aria-label="IA pode mandar áudios"></button>`
    wrap.appendChild(ai)
    requestAnimationFrame(async () => {
      const tg = $('#saAiToggle'); if (!tg) return
      const st = await api('/api/wa/audios/ai')
      if (st) tg.setAttribute('aria-checked', st.enabled ? 'true' : 'false')
      tg.addEventListener('click', async () => {
        const next = tg.getAttribute('aria-checked') !== 'true'
        tg.disabled = true
        const r = await post('/api/wa/audios/ai', { enabled: next })
        tg.disabled = false
        if (r && r.ok) { tg.setAttribute('aria-checked', r.enabled ? 'true' : 'false'); toast(r.enabled ? 'IA pode mandar áudios' : 'IA não manda mais áudios (só texto)') }
        else toast('Não deu pra mudar o ajuste', 'err')
      })
    })
    // Gravador
    const rec = el('div', 'sa-recorder')
    rec.innerHTML = `
      <div class="sa-rec-row">
        <button type="button" class="btn sa-rec-btn" id="saRecBtn" aria-label="Gravar áudio">
          <span class="sa-rec-dot"></span><span class="sa-rec-lbl">Gravar</span>
        </button>
        <div class="sa-rec-meter" id="saRecMeter" hidden><span class="sa-rec-time" id="saRecTime">0:00</span><span class="sa-rec-hint">gravando…</span></div>
        <div class="sa-rec-preview" id="saRecPreview" hidden></div>
      </div>
      <div class="sa-rec-form" id="saRecForm" hidden>
        <label class="sa-field"><span>Título</span>
          <input type="text" id="saTitle" maxlength="120" placeholder="ex: bom dia amor" autocomplete="off"></label>
        <label class="sa-field"><span>Quando usar <small>(ajuda a IA a escolher)</small></span>
          <input type="text" id="saDesc" maxlength="600" placeholder="ex: de manhã, quando ela acabou de acordar" autocomplete="off"></label>
        <div class="sa-rec-actions">
          <button type="button" class="btn ghost" id="saDiscard">Descartar</button>
          <button type="button" class="btn primary" id="saSave" disabled>Salvar áudio</button>
        </div>
      </div>
      <p class="sa-rec-perm" id="saRecPerm" hidden></p>`
    wrap.appendChild(rec)
    // Biblioteca (preenchida por loadSavedAudioLibrary)
    const lib = el('div', 'sa-library', `<div class="sa-lib-loading">${icon('i-play', 'ico')} carregando áudios…</div>`)
    lib.id = 'saLibrary'
    wrap.appendChild(lib)

    // wire do gravador (depois de anexado ao DOM via requestAnimationFrame)
    requestAnimationFrame(() => wireRecorder())
    return wrap
  }

  function wireRecorder() {
    const btn = $('#saRecBtn'); if (!btn) return
    const meter = $('#saRecMeter'), time = $('#saRecTime'), form = $('#saRecForm')
    const preview = $('#saRecPreview'), save = $('#saSave'), discard = $('#saDiscard')
    const perm = $('#saRecPerm')
    const title = $('#saTitle'), desc = $('#saDesc')

    if (!window.MediaRecorder) {
      btn.disabled = true
      if (perm) { perm.hidden = false; perm.textContent = 'Este navegador não grava áudio. Use o Chrome/Firefox no computador.' }
      return
    }
    if (title) title.addEventListener('input', () => { save.disabled = !title.value.trim() || !REC.blob })

    const stopMeter = () => { if (REC.timer) { clearInterval(REC.timer); REC.timer = null } }
    const resetRecorder = () => {
      stopMeter()
      try { REC.stream && REC.stream.getTracks().forEach((t) => t.stop()) } catch {}
      REC.rec = null; REC.stream = null; REC.chunks = []; REC.blob = null; REC.secs = 0
      meter.hidden = true; form.hidden = true; preview.hidden = true; preview.replaceChildren()
      btn.classList.remove('recording'); btn.querySelector('.sa-rec-lbl').textContent = 'Gravar'
      btn.setAttribute('aria-label', 'Gravar áudio')
      if (title) title.value = ''; if (desc) desc.value = ''
      save.disabled = true
      // O RÓTULO TAMBÉM SE RESETA. Só o caminho de FALHA devolvia o texto do botão; no
      // sucesso ele ficava "Enviando…" pra sempre — e a gravação seguinte já nascia com esse
      // rótulo (o `original` do próximo clique passava a ser "Enviando…", então nem falhando
      // ele voltava). Parecia travado, e estava: travado no texto, não no envio.
      save.textContent = 'Salvar áudio'
    }

    const startRec = async () => {
      // PEDIR O MICROFONE DEMORA — e no celular demora mais ainda, porque o navegador ainda
      // mostra o pedido de permissão. Sem esta trava, o segundo toque (ou o "manter
      // pressionado", que solta um clique) entrava aqui de novo enquanto o primeiro esperava:
      // duas gravações, dois streams, e a que o botão controlava não era a que gravava. Pra
      // quem está segurando o celular, isso é "o microfone não funciona".
      if (REC.iniciando || (REC.rec && REC.rec.state === 'recording')) return
      REC.iniciando = true
      btn.querySelector('.sa-rec-lbl').textContent = 'Abrindo o microfone…'
      if (perm) perm.hidden = true
      let stream
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
      catch (e) {
        REC.iniciando = false
        btn.querySelector('.sa-rec-lbl').textContent = 'Gravar'
        if (perm) { perm.hidden = false; perm.textContent = 'Permissão de microfone negada. Libere o microfone para este site nas configurações do navegador e tente de novo.' }
        return
      }
      const mime = pickRecorderMime()
      REC.stream = stream; REC.chunks = []; REC.mime = mime
      try { REC.rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream) }
      catch { REC.rec = new MediaRecorder(stream) }
      REC.rec.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) REC.chunks.push(e.data) })
      REC.rec.addEventListener('stop', () => {
        stopMeter()
        try { REC.stream && REC.stream.getTracks().forEach((t) => t.stop()) } catch {}
        REC.blob = new Blob(REC.chunks, { type: REC.mime || 'audio/webm' })
        btn.classList.remove('recording'); btn.querySelector('.sa-rec-lbl').textContent = 'Regravar'
        meter.hidden = true
        // preview local com <audio>? Não: usamos o mesmo player custom via object URL.
        preview.hidden = false
        preview.replaceChildren(el('div', 'sa-rec-preview-lbl', `${icon('i-check', 'ico ico-sm')} gravado (${fmtAudioDur(REC.secs)}) — dê um título e salve`))
        form.hidden = false
        save.disabled = !(title && title.value.trim())
        if (title) title.focus()
      })
      REC.rec.start(250) // chunks de 250ms
      REC.t0 = Date.now(); REC.secs = 0
      meter.hidden = false; form.hidden = true; preview.hidden = true
      btn.classList.add('recording'); btn.querySelector('.sa-rec-lbl').textContent = 'Parar'
      btn.setAttribute('aria-label', 'Parar gravação')
      REC.timer = setInterval(() => { REC.secs = Math.floor((Date.now() - REC.t0) / 1000); if (time) time.textContent = fmtAudioDur(REC.secs) }, 250)
      REC.iniciando = false
    }

    btn.addEventListener('click', () => {
      if (REC.rec && REC.rec.state === 'recording') { REC.rec.stop() }
      else startRec()
    })
    discard.addEventListener('click', () => resetRecorder())
    save.addEventListener('click', async () => {
      if (!REC.blob || !title.value.trim()) return
      save.disabled = true
      // NUNCA capturar o rótulo transitório: se o botão já estivesse em "Enviando…" (o bug
      // acima), o "original" viraria "Enviando…" e o estado se perpetuava sozinho.
      const original = save.textContent === 'Enviando…' ? 'Salvar áudio' : save.textContent
      save.textContent = 'Enviando…'
      const qs = new URLSearchParams({ title: title.value.trim() })
      if (desc.value.trim()) qs.set('descricao', desc.value.trim())
      let r
      try {
        r = await fetch(`/api/wa/audios?${qs.toString()}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: REC.blob })
      } catch { r = null }
      // O SERVIDOR DIZ O PORQUÊ — e a tela jogava fora. Em 11/08/2026 três tentativas
      // falharam com `spawn ffmpeg ENOENT` (a VM estava sem ffmpeg) e o painel só dizia "não
      // deu pra salvar", que manda a pessoa procurar defeito no celular dela.
      if (!r || !r.ok) {
        let motivo = ''
        try { motivo = (await r.json())?.error || '' } catch { /* sem corpo */ }
        save.disabled = false; save.textContent = original
        toast(motivo ? `Não deu pra salvar: ${motivo}` : 'Não deu pra salvar o áudio', 'err')
        return
      }
      save.textContent = original
      toast('Áudio salvo')
      WA.audios = null // invalida o cache do picker "/"
      resetRecorder()
      loadSavedAudioLibrary()
    })
  }

  async function loadSavedAudioLibrary() {
    const host = $('#saLibrary'); if (!host) return
    const all = await api('/api/wa/audios')
    if (!Array.isArray(all)) { host.replaceChildren(el('div', 'sa-lib-empty', 'Não deu pra carregar os áudios agora.')); return }
    if (!all.length) {
      host.replaceChildren(el('div', 'sa-lib-empty', `<b>nenhum áudio salvo ainda</b><small>grave um acima — ele fica disponível no atalho "/" do WhatsApp</small>`))
      return
    }
    const list = el('div', 'sa-lib-list')
    all.forEach((a) => list.appendChild(savedAudioRow(a)))
    host.replaceChildren(list)
  }

  function savedAudioRow(a) {
    const row = el('div', 'sa-lib-row' + (a.active ? '' : ' inactive'))
    // player custom reusando audioBubble seria pesado; usamos o mesmo motor via wrap simples
    const player = el('div', 'sa-lib-player')
    const durKnown = a.dur != null && isFinite(a.dur)
    player.innerHTML = `
      <button class="wc-au-btn" type="button" aria-label="Tocar áudio">${icon('i-play', 'ico')}</button>
      <div class="wc-au-mid">
        <div class="wc-au-track" role="presentation"><div class="wc-au-fill"></div><div class="wc-au-knob"></div></div>
        <div class="wc-au-time">${fmtAudioDur(durKnown ? a.dur : 0)}</div>
      </div>`
    const src = `/api/wa/audios/stream?file=${encodeURIComponent(a.file)}`
    const btn = player.querySelector('.wc-au-btn')
    btn.addEventListener('click', () => toggleAudio(src, player, durKnown ? a.dur : null))
    const track = player.querySelector('.wc-au-track')
    track.addEventListener('click', (e) => {
      const nd = AUDIO.node
      if (!nd || AUDIO.file !== src || !isFinite(nd.duration) || nd.duration <= 0) return
      const r = track.getBoundingClientRect(); const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
      nd.currentTime = p * nd.duration; paintAudioProgress()
    })
    requestAnimationFrame(() => reattachAudio(src, player, durKnown ? a.dur : null))

    const meta = el('div', 'sa-lib-meta')
    const trLine = a.transcriptStatus === 'done' && a.transcript
      ? `<span class="sa-lib-tr">${icon('i-caption', 'ico ico-sm')} ${esc(a.transcript)}</span>`
      : a.transcriptStatus === 'pending' ? `<span class="sa-lib-tr pending"><span class="wc-au-shimmer"></span> transcrevendo…</span>`
      : `<span class="sa-lib-tr fail">(sem transcrição)</span>`
    meta.innerHTML = `
      <div class="sa-lib-top">
        <b class="sa-lib-title">${esc(a.title || a.shortcut)}</b>
        <span class="sa-lib-chip">/${esc(a.shortcut)}</span>
        <span class="sa-lib-chip soft">${fmtAudioDur(a.dur)}</span>
        <span class="sa-lib-chip soft">${a.usageCount || 0} ${a.usageCount === 1 ? 'uso' : 'usos'}</span>
        ${a.active ? '' : '<span class="sa-lib-chip off">inativo</span>'}
      </div>
      ${a.descricao ? `<div class="sa-lib-desc">${esc(a.descricao)}</div>` : ''}
      ${trLine}`

    const actions = el('div', 'sa-lib-actions')
    const editBtn = el('button', 'icon-btn', icon('i-edit', 'ico ico-sm')); editBtn.type = 'button'; editBtn.title = 'Editar'; editBtn.setAttribute('aria-label', 'Editar áudio')
    editBtn.addEventListener('click', () => openSavedAudioEditor(a))
    const toggleBtn = el('button', 'icon-btn' + (a.active ? ' danger-hover' : ''), icon(a.active ? 'i-x' : 'i-check', 'ico ico-sm')); toggleBtn.type = 'button'
    toggleBtn.title = a.active ? 'Inativar' : 'Reativar'; toggleBtn.setAttribute('aria-label', a.active ? 'Inativar áudio' : 'Reativar áudio')
    // Inativar: confirmação em DOIS cliques (nunca confirm() nativo).
    toggleBtn.dataset.arm = '0'
    toggleBtn.addEventListener('click', async () => {
      if (a.active && toggleBtn.dataset.arm !== '1') {
        toggleBtn.dataset.arm = '1'; toggleBtn.classList.add('arm'); toggleBtn.title = 'Confirmar inativar'
        setTimeout(() => { if (toggleBtn.isConnected) { toggleBtn.dataset.arm = '0'; toggleBtn.classList.remove('arm'); toggleBtn.title = 'Inativar' } }, 3500)
        return
      }
      const r = await post('/api/wa/audios/meta', { id: a.id, active: !a.active })
      if (!r || !r.ok) { toast('Não deu pra atualizar', 'err'); return }
      WA.audios = null
      toast(a.active ? 'Áudio inativado' : 'Áudio reativado')
      loadSavedAudioLibrary()
    })
    actions.append(editBtn, toggleBtn)

    row.append(player, meta, actions)
    return row
  }


  // ==================================================================
  //  LIGAÇÕES: FOTO <-> NECESSIDADE
  //  Arrasta da bolinha de um lado até o outro. Muitos-para-muitos, nos dois sentidos, e
  //  ligar não é obrigatório — foto sem ligação continua valendo pelo contexto escrito.
  //
  //  Por que arrastar e não uma lista de caixinhas: a pergunta aqui é "o que conversa com o
  //  quê", e isso se enxerga como desenho. Uma matriz de checkboxes responde a mesma coisa e
  //  esconde justamente o que importa — quantas linhas saem de cada ponta.
  // ==================================================================
  const LIG = { fotos: [], necs: [], vinculos: [], arrastando: null }

  function renderLigacoes() {
    const wrap = el('div', 'lig-wrap')
    wrap.innerHTML = `
      <div class="lig-cols">
        <div class="lig-col" data-lado="foto"><div class="lig-col-tit">Fotos</div><div class="lig-list" id="ligFotos"></div></div>
        <svg class="lig-svg" id="ligSvg"></svg>
        <div class="lig-col" data-lado="nec"><div class="lig-col-tit">Necessidades</div><div class="lig-list" id="ligNecs"></div></div>
      </div>
      <p class="lig-ajuda">Arraste de uma bolinha até a do outro lado pra ligar, ou toque na bolinha e depois no outro lado. Pra desfazer, <span class="so-desktop">clique na linha ou </span>toque no <b>x</b> da pastilha. Ligar é opcional — sem ligação, a foto vale pelo contexto escrito nela. <span class="lig-aviso" id="ligAviso"></span></p>`
    requestAnimationFrame(() => carregarLigacoes())
    return wrap
  }

  async function carregarLigacoes() {
    const [fotos, necs, v] = await Promise.all([
      api('/api/fotos'), api('/api/necessidades'), api('/api/necessidades/vinculos'),
    ])
    LIG.fotos = Array.isArray(fotos) ? fotos.filter((f) => f.active) : []
    LIG.necs = (necs && (necs.itens || necs.necessidades || necs.lista)) || (Array.isArray(necs) ? necs : [])
    LIG.vinculos = (v && v.vinculos) || []
    pintarLigacoes()
  }

  function pintarLigacoes() {
    const cf = $('#ligFotos'), cn = $('#ligNecs')
    if (!cf || !cn) return
    LIG.armado = null
    cf.replaceChildren(...LIG.fotos.map((f) => itemLigacao('foto', String(f.id),
      `<img src="${miniaturaSalva(f.file)}" alt="">`,
      f.descricao || f.title || f.shortcut)))
    cn.replaceChildren(...LIG.necs.map((n) => itemLigacao('nec', String(n.id),
      `<span class="lig-nec-ico">${icon('i-target', 'ico ico-sm')}</span>`, n.descricao)))
    desenharLinhas()
  }

  // O nome do que está do OUTRO lado, pra desenhar as pastilhas dentro do card.
  function ligadosA(lado, id) {
    return LIG.vinculos
      .filter((v) => (lado === 'foto' ? String(v.fotoId) === id : String(v.necessidadeId) === id))
      .map((v) => (lado === 'foto'
        ? { id: String(v.necessidadeId), nome: (LIG.necs.find((n) => String(n.id) === String(v.necessidadeId)) || {}).descricao || 'necessidade' }
        : { id: String(v.fotoId), nome: (LIG.fotos.find((f) => String(f.id) === String(v.fotoId)) || {}).descricao || 'foto' }))
  }

  function itemLigacao(lado, id, midia, texto) {
    const it = el('div', 'lig-item')
    it.dataset.lado = lado; it.dataset.id = id
    const ligados = ligadosA(lado, id)
    // As pastilhas repetem o que a linha já diz — de propósito. A linha mostra que EXISTE
    // ligação; a pastilha diz COM O QUÊ, sem ter que seguir o traço com o olho. E no celular,
    // onde não cabe linha nenhuma, é o único jeito de ver e desfazer.
    const chips = ligados.length
      ? `<div class="lig-chips">${ligados.map((l) => `<button class="lig-chip" data-off="${esc(l.id)}" title="desfazer">${esc(l.nome)}<span>${icon('i-x', 'ico ico-sm')}</span></button>`).join('')}</div>`
      : ''
    const corpo = `<div class="lig-corpo"><div class="lig-txt">${esc(texto)}</div>${chips}</div>`
    const mini = `<div class="lig-mini${lado === 'nec' ? ' nec' : ''}">${midia}</div>`
    const bolinha = `<span class="lig-dot" data-dot="1" role="button" tabindex="0" title="Arraste daqui, ou toque aqui e depois no outro lado">${ligados.length || ''}</span>`
    it.innerHTML = lado === 'foto' ? mini + corpo + bolinha : bolinha + mini + corpo

    const dot = it.querySelector('[data-dot]')
    dot.addEventListener('pointerdown', (e) => { e.preventDefault(); iniciarArrasto(lado, id, e) })
    // TOCAR pra ligar: no celular não existe arrastar entre colunas (elas ficam empilhadas e
    // sem linha), então a bolinha ARMA e o toque do outro lado fecha. Vale no mouse também.
    dot.addEventListener('click', (e) => { e.stopPropagation(); armar(lado, id) })
    dot.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); armar(lado, id) } })
    it.addEventListener('click', () => { if (LIG.armado && LIG.armado.lado !== lado) fecharLigacao(lado, id) })
    for (const c of it.querySelectorAll('[data-off]')) {
      c.addEventListener('click', (e) => {
        e.stopPropagation()
        const fotoId = lado === 'foto' ? id : c.dataset.off
        const necessidadeId = lado === 'nec' ? id : c.dataset.off
        desligar(fotoId, necessidadeId)
      })
    }
    return it
  }

  function armar(lado, id) {
    const igual = LIG.armado && LIG.armado.lado === lado && LIG.armado.id === id
    LIG.armado = igual ? null : { lado, id }
    for (const it of $$('.lig-item')) {
      it.classList.toggle('armado', !!LIG.armado && it.dataset.lado === LIG.armado.lado && it.dataset.id === LIG.armado.id)
      it.classList.toggle('esperando', !!LIG.armado && it.dataset.lado !== LIG.armado.lado)
    }
    const aviso = $('#ligAviso')
    if (aviso) aviso.textContent = LIG.armado
      ? (LIG.armado.lado === 'foto' ? 'agora toque na necessidade' : 'agora toque na foto')
      : ''
  }

  async function fecharLigacao(lado, id) {
    const fotoId = lado === 'foto' ? id : LIG.armado.id
    const necessidadeId = Number(lado === 'nec' ? id : LIG.armado.id)
    LIG.armado = null
    const aviso = $('#ligAviso'); if (aviso) aviso.textContent = ''
    const r = await api('/api/necessidades/vinculos', { method: 'POST', body: JSON.stringify({ fotoId, necessidadeId }) })
    if (r && r.ok) toast('Ligado')
    carregarLigacoes()
  }

  async function desligar(fotoId, necessidadeId) {
    const q = `fotoId=${encodeURIComponent(fotoId)}&necessidadeId=${encodeURIComponent(necessidadeId)}`
    const r = await api(`/api/necessidades/vinculos?${q}`, { method: 'DELETE' })
    if (r && r.ok) toast('Ligação desfeita')
    carregarLigacoes()
  }

  function centroDoDot(lado, id) {
    const it = $(`.lig-item[data-lado="${lado}"][data-id="${CSS.escape(id)}"]`)
    const svg = $('#ligSvg')
    if (!it || !svg) return null
    const d = it.querySelector('[data-dot]').getBoundingClientRect()
    const s = svg.getBoundingClientRect()
    return { x: d.x + d.width / 2 - s.x, y: d.y + d.height / 2 - s.y }
  }

  function desenharLinhas(temp) {
    const svg = $('#ligSvg')
    if (!svg) return
    const partes = []
    for (const v of LIG.vinculos) {
      const a = centroDoDot('foto', String(v.fotoId)), b = centroDoDot('nec', String(v.necessidadeId))
      if (!a || !b) continue
      // A linha nasce e morre FORA da bolinha (13px), pra não desenhar por baixo dela nem
      // roubar o clique de quem quer pegar a alça.
      const dir = Math.sign(b.x - a.x) || 1
      a.x += 13 * dir; b.x -= 13 * dir
      const meio = (a.x + b.x) / 2
      partes.push(`<path class="lig-linha" data-f="${esc(v.fotoId)}" data-n="${v.necessidadeId}"
        d="M ${a.x} ${a.y} C ${meio} ${a.y}, ${meio} ${b.y}, ${b.x} ${b.y}"><title>clique pra desfazer</title></path>`)
    }
    if (temp) partes.push(`<path class="lig-linha temp" d="M ${temp.x0} ${temp.y0} L ${temp.x1} ${temp.y1}"></path>`)
    svg.innerHTML = partes.join('')
    for (const el2 of svg.querySelectorAll('.lig-linha:not(.temp)')) {
      el2.addEventListener('click', () => desligar(el2.dataset.f, el2.dataset.n))
    }
  }

  function iniciarArrasto(lado, id, ev) {
    const svg = $('#ligSvg'); if (!svg) return
    const origem = centroDoDot(lado, id)
    LIG.arrastando = { lado, id }
    const mover = (e) => {
      const s = svg.getBoundingClientRect()
      desenharLinhas({ x0: origem.x, y0: origem.y, x1: e.clientX - s.x, y1: e.clientY - s.y })
      // realce do lado oposto: mostra ONDE dá pra soltar, em vez de deixar adivinhar
      const alvo = document.elementFromPoint(e.clientX, e.clientY)?.closest('.lig-item')
      for (const it of $$('.lig-item')) it.classList.toggle('alvo', it === alvo && it.dataset.lado !== lado)
    }
    const soltar = async (e) => {
      document.removeEventListener('pointermove', mover)
      document.removeEventListener('pointerup', soltar)
      for (const it of $$('.lig-item')) it.classList.remove('alvo')
      const alvo = document.elementFromPoint(e.clientX, e.clientY)?.closest('.lig-item')
      LIG.arrastando = null
      if (!alvo || alvo.dataset.lado === lado) { desenharLinhas(); return }
      const fotoId = lado === 'foto' ? id : alvo.dataset.id
      const necessidadeId = Number(lado === 'nec' ? id : alvo.dataset.id)
      const r = await api('/api/necessidades/vinculos', { method: 'POST', body: JSON.stringify({ fotoId, necessidadeId }) })
      if (r && r.ok) toast('Ligado')
      carregarLigacoes()
    }
    document.addEventListener('pointermove', mover)
    document.addEventListener('pointerup', soltar)
  }

  // ==================================================================
  //  BANCO DE FOTOS — irmão dos áudios salvos
  //  O motor já existia inteiro (tabela, trava de nível, uso nos 4 canais); só faltava a
  //  tela. A DESCRIÇÃO É O CAMPO QUE IMPORTA: diferente do áudio, que tem transcrição
  //  automática, a foto não tem nada que o sistema consiga ler sozinho — o texto que a dona
  //  escrever aqui é o ÚNICO que a IA vê pra decidir quando mandar aquela foto.
  // ==================================================================
  const FOTOS = { pendentes: [] } // fila local do upload, antes de virar linha no banco

  // VÍDEO NO BANCO (07/10/2026). Mora junto das fotos, com a mesma descrição, o mesmo nível e
  // o mesmo marcador da IA. No disco ele é sempre .mp4 e ganha uma capa (<id>-capa.jpg) no
  // upload: é a capa que aparece em toda miniatura, e o vídeo só toca onde dá pra assistir.
  const MAX_FOTO_MB = 24
  const MAX_VIDEO_MB = 64
  function arquivoEhVideo(f) {
    return /^video\/(mp4|quicktime|webm|x-m4v|3gpp)$/.test(f.type) || (!f.type && /\.(mp4|mov|m4v|webm|3gp)$/i.test(f.name))
  }
  // "3 fotos e 1 vídeo": a contagem fala dos dois sem virar "3 itens".
  function contagemMidias(fotos, videos) {
    const partes = []
    if (fotos || !videos) partes.push(`${fotos} ${fotos === 1 ? 'foto' : 'fotos'}`)
    if (videos) partes.push(`${videos} ${videos === 1 ? 'vídeo' : 'vídeos'}`)
    return partes.join(' e ')
  }

  function renderSavedImageSection() {
    const wrap = el('div', 'cfg-fotos')

    // Toggle: a IA pode (ou não) mandar fotos. Vale nos 4 canais (setting saved_image_ai).
    const ai = el('div', 'sa-ai-row')
    ai.innerHTML = `
      <div class="sa-ai-txt"><b>IA pode mandar fotos e vídeos</b><small>desligado: a IA responde só com texto; mandar pelo painel continua</small></div>
      <button type="button" class="toggle" id="fotoAiToggle" role="switch" aria-checked="true" aria-label="IA pode mandar fotos e vídeos"></button>`
    wrap.appendChild(ai)
    requestAnimationFrame(async () => {
      const tg = $('#fotoAiToggle'); if (!tg) return
      const st = await api('/api/fotos/ai')
      if (st) tg.setAttribute('aria-checked', st.enabled ? 'true' : 'false')
      tg.addEventListener('click', async () => {
        const next = tg.getAttribute('aria-checked') !== 'true'
        tg.disabled = true
        const r = await post('/api/fotos/ai', { enabled: next })
        tg.disabled = false
        if (r && r.ok) { tg.setAttribute('aria-checked', r.enabled ? 'true' : 'false'); toast(r.enabled ? 'IA pode mandar fotos e vídeos' : 'IA não manda mais fotos nem vídeos') }
        else toast('Não deu pra mudar o ajuste', 'err')
      })
    })

    // Área de soltar/escolher. Input de arquivo é o único controle nativo aceitável aqui
    // (não existe equivalente próprio pra abrir o seletor do sistema); ele fica ESCONDIDO
    // atrás do nosso botão, e todo o resto da tela é componente nosso.
    const drop = el('div', 'fo-drop')
    drop.id = 'foDrop'
    drop.innerHTML = `
      <input type="file" id="foInput" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm,video/x-m4v,.mp4,.mov,.m4v,.webm" multiple hidden>
      <div class="fo-drop-in">
        ${icon('i-cam', 'ico ico-lg')}
        <b>Arraste fotos ou vídeos aqui</b>
        <small>ou <button type="button" class="lnk" id="foPick">escolha do computador</button> — fotos jpg, png, gif ou webp até ${MAX_FOTO_MB} MB; vídeos mp4, mov ou webm até ${MAX_VIDEO_MB} MB</small>
      </div>`
    wrap.appendChild(drop)

    // Fila: cada foto escolhida vira um cartão com a descrição já preenchida pelo NOME DO
    // ARQUIVO — mesma ideia do importador de pasta, que existe pra ela escrever o que a foto
    // mostra sem precisar de tela. Aqui ela pode corrigir antes de salvar.
    const fila = el('div', 'fo-fila'); fila.id = 'foFila'; fila.hidden = true
    wrap.appendChild(fila)

    const lib = el('div', 'fo-lib', `<div class="sa-lib-loading">${icon('i-cam', 'ico')} carregando fotos…</div>`)
    lib.id = 'foLibrary'
    wrap.appendChild(lib)

    requestAnimationFrame(() => wireFotoUpload())
    return wrap
  }

  function wireFotoUpload() {
    const drop = $('#foDrop'); if (!drop) return
    const input = $('#foInput')
    $('#foPick')?.addEventListener('click', () => input.click())
    input.addEventListener('change', () => { enfileirarFotos([...input.files]); input.value = '' })
    ;['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over') }))
    ;['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return; drop.classList.remove('over') }))
    drop.addEventListener('drop', (e) => enfileirarFotos([...(e.dataTransfer?.files || [])]))
    loadSavedImageLibrary()
  }

  // Nome do arquivo vira descrição: tira extensão, troca separador por espaço. "foto-no-
  // espelho-do-quarto.jpg" -> "foto no espelho do quarto".
  function descricaoDoNome(nome) {
    return String(nome || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  }

  function enfileirarFotos(files) {
    const aceitos = []
    let recusados = 0
    const grandes = []
    for (const f of files) {
      const video = arquivoEhVideo(f)
      if (!video && !/^image\/(jpeg|png|gif|webp)$/.test(f.type)) { recusados++; continue }
      // O teto se confere AQUI, antes de subir: o servidor corta a conexão no meio de um envio
      // grande demais, e aí a tela só saberia dizer "não deu".
      const teto = video ? MAX_VIDEO_MB : MAX_FOTO_MB
      if (f.size > teto * 1048576) { grandes.push(`${f.name} passa de ${teto} MB`); continue }
      aceitos.push({ f, video })
    }
    if (recusados > 0) toast(`${recusados} ${recusados === 1 ? 'arquivo não é' : 'arquivos não são'} foto nem vídeo que eu saiba mandar`, 'err')
    if (grandes.length) toast(grandes.length === 1 ? grandes[0] : `${grandes.length} arquivos passam do tamanho máximo`, 'err')
    if (!aceitos.length) return
    for (const { f, video } of aceitos) FOTOS.pendentes.push({ file: f, video, descricao: descricaoDoNome(f.name), contexto: '', url: URL.createObjectURL(f), estado: 'espera' })
    renderFilaFotos()
  }

  function renderFilaFotos() {
    const host = $('#foFila'); if (!host) return
    if (!FOTOS.pendentes.length) { host.hidden = true; host.replaceChildren(); return }
    host.hidden = false
    const list = el('div', 'fo-fila-list')
    FOTOS.pendentes.forEach((p, i) => {
      const card = el('div', 'fo-fila-item' + (p.estado === 'erro' ? ' erro' : '') + (p.estado === 'enviando' ? ' enviando' : ''))
      card.innerHTML = `
        ${p.video
          ? `<span class="fo-thumb-wrap"><video class="fo-thumb" src="${p.url}" muted playsinline preload="metadata"></video><span class="fo-play mini">${icon('i-play', 'ico ico-sm')}</span></span>`
          : `<img class="fo-thumb" src="${p.url}" alt="">`}
        <div class="fo-fila-desc">
          <label class="sa-field"><span>O que ${p.video ? 'o vídeo' : 'a foto'} mostra</span>
            <input type="text" data-campo="descricao" maxlength="600" value="${esc(p.descricao)}" placeholder="ex: no espelho do quarto, pronta pra sair"></label>
          <label class="sa-field"><span>Quando mandar <small>(o contexto — é isto que evita a foto certa na hora errada)</small></span>
            <input type="text" data-campo="contexto" maxlength="400" value="${esc(p.contexto || '')}" placeholder="ex: quando perguntarem se eu vou sair hoje"></label>
        </div>
        <div class="fo-fila-acts">
          ${p.estado === 'enviando' ? `<span class="spin"></span>${p.video ? '<span class="fo-enviando">enviando o vídeo, pode levar um minuto</span>' : ''}` : ''}
          ${p.erro ? `<span class="fo-erro">${esc(p.erro)}</span>` : ''}
          <button type="button" class="icon-btn" aria-label="Tirar da fila" title="Tirar da fila">${icon('i-x', 'ico ico-sm')}</button>
        </div>`
      for (const inp of card.querySelectorAll('input[data-campo]')) {
        inp.addEventListener('input', (e) => { FOTOS.pendentes[i][e.currentTarget.dataset.campo] = e.currentTarget.value })
      }
      card.querySelector('.icon-btn').addEventListener('click', () => { URL.revokeObjectURL(p.url); FOTOS.pendentes.splice(i, 1); renderFilaFotos() })
      list.appendChild(card)
    })
    const foot = el('div', 'fo-fila-foot')
    const n = FOTOS.pendentes.length
    const nv = FOTOS.pendentes.filter((x) => x.video).length
    const nf = n - nv
    const umSo = n === 1 ? (nv ? 'vídeo' : 'foto') : null
    foot.innerHTML = `
      <small>Entram <b>livres</b>: a IA já pode usar. Dá pra travar depois, um a um.</small>
      <div class="fo-fila-btns">
        <button type="button" class="btn ghost" id="foLimpar">Descartar ${umSo ? (nv ? 'o vídeo' : 'a foto') : (nv ? 'os ' : 'as ') + n}</button>
        <button type="button" class="btn primary" id="foSalvar">Salvar ${umSo || contagemMidias(nf, nv)}</button>
      </div>`
    list.appendChild(foot)
    host.replaceChildren(list)
    $('#foLimpar', host).addEventListener('click', () => { FOTOS.pendentes.forEach((p) => URL.revokeObjectURL(p.url)); FOTOS.pendentes = []; renderFilaFotos() })
    $('#foSalvar', host).addEventListener('click', () => salvarFilaFotos())
  }

  // Sobe UMA POR VEZ e reporta a FRAÇÃO. Subir em paralelo deixaria a barra mais rápida e o
  // relato pior: com 20 fotos e 3 recusadas por serem repetidas, o que importa é saber quais
  // entraram e quais não — "salvei tudo" seria mentira.
  async function salvarFilaFotos() {
    const btn = $('#foSalvar'); if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spin"></span> salvando…` }
    let ok = 0
    let okVideos = 0
    const falhas = []
    for (const p of FOTOS.pendentes.slice()) {
      const desc = (p.descricao || '').trim()
      if (!desc) { falhas.push([p.file.name, 'sem descrição']); p.estado = 'erro'; p.erro = `escreva o que ${p.video ? 'o vídeo' : 'a foto'} mostra`; continue }
      p.estado = 'enviando'; renderFilaFotos()
      const qs = new URLSearchParams({ descricao: desc, nivel: 'livre' })
      if ((p.contexto || '').trim()) qs.set('contexto', p.contexto.trim())
      let r = null
      try {
        const resp = await fetch(`/api/fotos?${qs.toString()}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: p.file })
        r = await resp.json().catch(() => null)
      } catch { r = null }
      if (r && r.ok) {
        ok++
        if (p.video) okVideos++
        URL.revokeObjectURL(p.url)
        FOTOS.pendentes.splice(FOTOS.pendentes.indexOf(p), 1)
      } else {
        p.estado = 'erro'; p.erro = (r && r.error) || 'não deu pra salvar'
        falhas.push([p.file.name, p.erro])
      }
      renderFilaFotos()
    }
    if (ok) toast(`Salvo: ${contagemMidias(ok - okVideos, okVideos)}${falhas.length ? ` · ${falhas.length} de fora` : ''}`, falhas.length ? 'err' : 'ok')
    else if (falhas.length) toast(`Nenhuma entrou — ${esc(falhas[0][1])}`, 'err')
    loadSavedImageLibrary()
  }

  async function loadSavedImageLibrary() {
    const host = $('#foLibrary'); if (!host) return
    const all = await api('/api/fotos')
    if (!Array.isArray(all)) { host.replaceChildren(el('div', 'sa-lib-empty', 'Não deu pra carregar as fotos agora.')); return }
    if (!all.length) {
      host.replaceChildren(el('div', 'sa-lib-empty', `<b>nenhuma foto ou vídeo no banco ainda</b><small>arraste os primeiros aí em cima — a IA passa a poder usá-los nas conversas</small>`))
      return
    }
    // A conta que interessa nesta tela: quantas a IA pode mandar pra qualquer um, quantas só
    // pra quem tem etiqueta que abre, e quantas nunca saem. Antes só existia "livre x travada"
    // e a biblioteca inteira ficava parecendo liberada.
    const porNivel = (n) => all.filter((f) => f.active && f.nivel === n).length
    const head = el('div', 'fo-lib-head')
    const nVideos = all.filter((f) => ehVideoSalvo(f.file)).length
    head.innerHTML = `<b>${contagemMidias(all.length - nVideos, nVideos)}</b>`
      + `<span class="sa-lib-chip soft">${porNivel('livre')} normais</span>`
      + `<span class="sa-lib-chip soft">${porNivel('quente')} sensuais</span>`
      + (porNivel('familia') ? `<span class="sa-lib-chip alerta">${porNivel('familia')} com criança — nunca saem</span>` : '')
      + (porNivel('travada') ? `<span class="sa-lib-chip soft">${porNivel('travada')} travadas</span>` : '')
    const grid = el('div', 'fo-grid')
    all.forEach((f) => grid.appendChild(savedImageCard(f)))
    host.replaceChildren(head, grid)
  }

  // Os quatro níveis, com o nome que quem opera usa — não o nome do campo no banco.
  const NIVEL_FOTO = {
    livre: { rotulo: 'normal', dica: 'a IA manda pra qualquer um' },
    quente: { rotulo: 'sensual', dica: 'a IA só manda pra etiqueta que abre foto sensual' },
    familia: { rotulo: 'com criança', dica: 'nunca sai por automação, em nenhuma conversa' },
    travada: { rotulo: 'travada', dica: 'só você manda, na mão' },
  }

  function savedImageCard(f) {
    const nivel = NIVEL_FOTO[f.nivel] ? f.nivel : 'livre'
    const card = el('div', 'fo-card' + (f.active ? '' : ' inactive') + ` nv-${nivel}`)
    const usos = f.usageCount || 0
    const video = ehVideoSalvo(f.file)
    const nomeTipo = video ? 'vídeo' : 'foto'
    card.innerHTML = `
      <div class="fo-card-img">
        <img src="${miniaturaSalva(f.file)}" alt="${esc((video ? 'vídeo: ' : '') + (f.descricao || f.title || ''))}" loading="lazy">
        ${video ? `<span class="fo-play">${icon('i-play', 'ico ico-sm')}${f.durationSec ? fmtDur(f.durationSec) : 'vídeo'}</span>` : ''}
        <span class="fo-selo nv-${nivel}">${NIVEL_FOTO[nivel].rotulo}</span>
        ${f.active ? '' : '<span class="fo-selo off">inativa</span>'}
      </div>
      <div class="fo-card-body">
        <div class="fo-card-desc">${esc(f.descricao || f.title || '(sem descrição)')}</div>
        ${f.contexto
          ? `<div class="fo-card-ctx">${icon('i-clock', 'ico ico-sm')} ${esc(f.contexto)}</div>`
          : '<div class="fo-card-ctx falta">sem contexto — a IA não sabe quando mandar</div>'}
        <div class="fo-card-chips">
          <span class="sa-lib-chip">/${esc(f.shortcut)}</span>
          <span class="sa-lib-chip soft">${usos} ${usos === 1 ? 'uso' : 'usos'}</span>
          ${f.lastUsedAt ? `<span class="sa-lib-chip soft">${esc(timeAgo(f.lastUsedAt))}</span>` : ''}
        </div>
      </div>
      <div class="fo-card-acts">
        <div class="fo-niveis" role="group" aria-label="Quem pode receber ${video ? 'este vídeo' : 'esta foto'}">
          ${Object.entries(NIVEL_FOTO).map(([k, v]) => `<button type="button" class="fo-nivel-op nv-${k}${k === nivel ? ' on' : ''}" data-nivel="${k}" aria-pressed="${k === nivel ? 'true' : 'false'}" title="${esc(v.dica)}">${esc(v.rotulo)}</button>`).join('')}
        </div>
        <span class="fo-card-nivel">${esc(NIVEL_FOTO[nivel].dica)}</span>
        <span class="fo-card-sp"></span>
        <button type="button" class="icon-btn" data-a="edit" aria-label="Editar ${nomeTipo}" title="Editar">${icon('i-edit', 'ico ico-sm')}</button>
        <button type="button" class="icon-btn${f.active ? ' danger-hover' : ''}" data-a="onoff" aria-label="${f.active ? 'Inativar' : 'Reativar'} ${nomeTipo}" title="${f.active ? 'Inativar' : 'Reativar'}">${icon(f.active ? 'i-x' : 'i-check', 'ico ico-sm')}</button>
      </div>`
    // Vídeo sem capa (o FFmpeg não conseguiu tirar um quadro) continua no banco e enviável;
    // a miniatura vira o símbolo de vídeo em vez de imagem quebrada.
    if (video) {
      const im = card.querySelector('.fo-card-img img')
      im?.addEventListener('error', () => im.replaceWith(el('div', 'fo-sem-capa', icon('i-play', 'ico ico-lg'))), { once: true })
    }

    // O nível é a trava que decide QUEM pode receber. Um clique, sem confirmação: apertar é
    // sempre reversível, e restringir tem que ser rápido.
    card.querySelectorAll('.fo-nivel-op').forEach((b) => b.addEventListener('click', async () => {
      const novoNivel = b.dataset.nivel
      if (novoNivel === nivel) return
      card.querySelectorAll('.fo-nivel-op').forEach((x) => { x.disabled = true })
      const r = await post('/api/fotos/meta', { id: f.id, nivel: novoNivel })
      if (!r || !r.ok) { toast('Não deu pra mudar', 'err'); card.querySelectorAll('.fo-nivel-op').forEach((x) => { x.disabled = false }); return }
      toast(`Agora é ${NIVEL_FOTO[novoNivel].rotulo}: ${NIVEL_FOTO[novoNivel].dica}`)
      loadSavedImageLibrary()
    }))
    card.querySelector('[data-a=edit]').addEventListener('click', () => openSavedImageEditor(f))
    const onoff = card.querySelector('[data-a=onoff]')
    onoff.dataset.arm = '0'
    onoff.addEventListener('click', async () => {
      if (f.active && onoff.dataset.arm !== '1') {
        onoff.dataset.arm = '1'; onoff.classList.add('arm'); onoff.title = 'Confirmar inativar'
        setTimeout(() => { if (onoff.isConnected) { onoff.dataset.arm = '0'; onoff.classList.remove('arm'); onoff.title = 'Inativar' } }, 3500)
        return
      }
      const r = await post('/api/fotos/meta', { id: f.id, active: !f.active })
      if (!r || !r.ok) { toast('Não deu pra atualizar', 'err'); return }
      toast(video ? (f.active ? 'Vídeo inativado' : 'Vídeo reativado') : (f.active ? 'Foto inativada' : 'Foto reativada'))
      loadSavedImageLibrary()
    })
    return card
  }

  function openSavedImageEditor(f) {
    const video = ehVideoSalvo(f.file)
    const root = el('div', 'objective-overlay')
    root.innerHTML = `
      <section class="objective-sheet" role="dialog" aria-modal="true" aria-labelledby="foEditTitle">
        <div class="objective-sheet-head">
          <div><span class="objective-kicker">${video ? 'Vídeo salvo' : 'Foto salva'}</span><h2 id="foEditTitle">${video ? 'Editar vídeo' : 'Editar foto'}</h2></div>
        </div>
        <div class="objective-sheet-body">
          ${video
            ? `<video class="fo-edit-img" src="${arquivoSalvoUrl(f.file)}" poster="${miniaturaSalva(f.file)}" controls playsinline preload="metadata"></video>`
            : `<img class="fo-edit-img" src="${arquivoSalvoUrl(f.file)}" alt="">`}
          <label class="sa-field"><span>O que ${video ? 'o vídeo' : 'a foto'} mostra <small>(é o único texto que a IA lê pra escolher)</small></span>
            <input type="text" id="foEditD" maxlength="600" value="${esc(f.descricao || '')}"></label>
          <label class="sa-field"><span>Quando mandar <small>(o contexto que a IA usa pra escolher a hora)</small></span>
            <input type="text" id="foEditC" maxlength="400" value="${esc(f.contexto || '')}" placeholder="ex: quando perguntarem do meu dia"></label>
          <label class="sa-field"><span>Título <small>(só pra você achar)</small></span>
            <input type="text" id="foEditT" maxlength="120" value="${esc(f.title || '')}"></label>
        </div>
        <div class="objective-sheet-foot">
          <button type="button" class="btn ghost" id="foEditCancel">Cancelar</button>
          <button type="button" class="btn primary" id="foEditSave">Salvar</button>
        </div>
      </section>`
    document.body.appendChild(root); document.body.classList.add('objective-open')
    const close = () => { root.remove(); document.body.classList.remove('objective-open'); document.removeEventListener('keydown', onKey, true) }
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
    document.addEventListener('keydown', onKey, true)
    root.addEventListener('mousedown', (e) => { if (e.target === root) close() })
    $('#foEditCancel', root).addEventListener('click', close)
    $('#foEditSave', root).addEventListener('click', async () => {
      const d = $('#foEditD', root).value.trim(); const t = $('#foEditT', root).value.trim()
      if (!d) { toast(`Sem descrição a IA não sabe quando usar ${video ? 'o vídeo' : 'a foto'}`, 'err'); return }
      const r = await post('/api/fotos/meta', { id: f.id, descricao: d, contexto: $('#foEditC', root).value.trim(), title: t || d.slice(0, 60) })
      if (!r || !r.ok) { toast((r && r.error) || 'Não deu pra salvar', 'err'); return }
      toast(video ? 'Vídeo atualizado' : 'Foto atualizada')
      close(); loadSavedImageLibrary()
    })
    setTimeout(() => $('#foEditD', root)?.focus(), 30)
  }

  // Editor de metadados (título + quando usar). Popover/sheet no molde do editor de objetivo.
  function openSavedAudioEditor(a) {
    const root = el('div', 'objective-overlay')
    root.innerHTML = `
      <section class="objective-sheet" role="dialog" aria-modal="true" aria-labelledby="saEditTitle">
        <div class="objective-sheet-head">
          <div><span class="objective-kicker">Áudio salvo</span><h2 id="saEditTitle">Editar áudio</h2></div>
        </div>
        <div class="objective-sheet-body">
          <label class="sa-field"><span>Título</span><input type="text" id="saEditT" maxlength="120" value="${esc(a.title || '')}"></label>
          <label class="sa-field"><span>Quando usar <small>(ajuda a IA)</small></span><input type="text" id="saEditD" maxlength="600" value="${esc(a.descricao || '')}"></label>
        </div>
        <div class="objective-sheet-foot">
          <button type="button" class="btn ghost" id="saEditCancel">Cancelar</button>
          <button type="button" class="btn primary" id="saEditSave">Salvar</button>
        </div>
      </section>`
    document.body.appendChild(root); document.body.classList.add('objective-open')
    const close = () => { root.remove(); document.body.classList.remove('objective-open'); document.removeEventListener('keydown', onKey, true) }
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
    document.addEventListener('keydown', onKey, true)
    root.addEventListener('mousedown', (e) => { if (e.target === root) close() })
    $('#saEditCancel', root).addEventListener('click', close)
    $('#saEditSave', root).addEventListener('click', async () => {
      const t = $('#saEditT', root).value.trim(); const d = $('#saEditD', root).value.trim()
      if (!t) { toast('Título não pode ficar vazio', 'err'); return }
      const r = await post('/api/wa/audios/meta', { id: a.id, title: t, descricao: d })
      if (!r || !r.ok) { toast('Não deu pra salvar', 'err'); return }
      WA.audios = null
      toast('Áudio atualizado')
      close(); loadSavedAudioLibrary()
    })
    setTimeout(() => $('#saEditT', root)?.focus(), 30)
  }

  // ---------------------------------------------------------------- logout
  const logout = async () => { await api('/api/logout'); location.href = '/' }
  $('#btnLogout').addEventListener('click', logout)
  $('#mobileLogout').addEventListener('click', (e) => confirmDestructive(e.currentTarget, 'Toque para confirmar a saída', logout))

  // Mantém threads e compositores dentro da área realmente visível quando o teclado
  // virtual abre. Em navegadores sem VisualViewport, 100dvh continua como fallback.
  function syncVisualViewport() {
    if (!isMobileLayout()) {
      document.documentElement.style.removeProperty('--mobile-vh')
      document.body.classList.remove('mobile-keyboard-open')
      return
    }
    const vv = window.visualViewport
    const height = vv ? vv.height : window.innerHeight
    document.documentElement.style.setProperty('--mobile-vh', `${Math.round(height)}px`)
    document.body.classList.toggle('mobile-keyboard-open', height < window.innerHeight - 120)
  }
  syncVisualViewport()
  window.visualViewport?.addEventListener('resize', syncVisualViewport)
  window.visualViewport?.addEventListener('scroll', syncVisualViewport)
  mobileMq.addEventListener('change', () => {
    syncVisualViewport()
    syncMobileShell(S.tab)
    if (S.tab === 'config') { $('#configHost').dataset.loaded = ''; loadConfig() }
    if (S.tab === 'agenda') { $('#agendaHost').dataset.loaded = ''; loadAgenda() }
    if (S.tab === 'diario') { $('#logHost').dataset.loaded = ''; loadLog() }
    if (S.tab === 'monitor') { $('#monHost').dataset.loaded = ''; loadMonitor() }
  })

  // ================================================================ PROJETOS
  const PROJ = { view: localStorage.getItem('vendas-multicanal.projView') || 'hoje', openId: null, detail: null, data: null }
  const PROJ_COLORS = { teal: '#35d0ba', sky: '#56b3e0', violet: '#a78bfa', rose: '#ff5b7f', amber: '#ffb454', lime: '#8bd450', orange: '#ff9068', slate: '#94a3b8' }
  const PROJ_TYPES = { trabalho: 'Trabalho', pessoal: 'Pessoal', objetivo: 'Objetivo' }
  const colorHex = (c) => PROJ_COLORS[c] || PROJ_COLORS.teal
  const jpatch = (path, b) => api(path, { method: 'PATCH', body: JSON.stringify(b || {}) })
  const jdel = (path) => api(path, { method: 'DELETE' })

  // régua de datas viva: "hoje", "amanhã", "sexta", "em 12 dias", "venceu há 3 dias"
  function relDay(ms, { past = 'atrás' } = {}) {
    if (!ms) return ''
    const dayMs = 86400000
    const startOf = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }
    const diff = Math.round((startOf(ms) - startOf(Date.now())) / dayMs)
    if (diff === 0) return 'hoje'
    if (diff === 1) return 'amanhã'
    if (diff === -1) return 'ontem'
    if (diff > 1 && diff <= 6) return new Date(ms).toLocaleDateString('pt-BR', { weekday: 'long' })
    if (diff > 6) return `em ${diff} dias`
    if (diff < -1) return `${Math.abs(diff)} dias ${past}`
    return ''
  }
  function relWhen(ms) { // com hora quando houver
    if (!ms) return ''
    const rel = relDay(ms)
    return `${rel} · ${clockTime(ms)}`
  }

  function loadProjetos() {
    if (PROJ.openId) { loadProjDetail(PROJ.openId); return }
    renderProjShell()
    if (PROJ.view === 'hoje') loadProjHoje()
    else if (PROJ.view === 'projetos') loadProjList()
    else loadProjWeek()
  }

  function renderProjShell() {
    const host = $('#projetosHost')
    if ($('#pjShell')) return // já montado; só troca o conteúdo interno
    const wrap = el('div', 'pj')
    wrap.id = 'pjShell'
    wrap.innerHTML = `
      <div class="view-head pj-head">
        <div><h1>Projetos</h1><span class="sub">sua vida em projetos, tarefas, compromissos e hábitos</span></div>
      </div>
      <div class="pj-seg" role="tablist" aria-label="Ver">
        <button data-pv="hoje" role="tab">Hoje</button>
        <button data-pv="projetos" role="tab">Projetos</button>
        <button data-pv="semana" role="tab">Semana</button>
      </div>
      <div id="pjBody"></div>`
    host.replaceChildren(wrap)
    $$('#pjShell .pj-seg button').forEach((b) => b.addEventListener('click', () => {
      PROJ.view = b.dataset.pv; localStorage.setItem('vendas-multicanal.projView', PROJ.view)
      applyProjSeg(); loadProjetos()
    }))
    applyProjSeg()
  }
  function applyProjSeg() { const v = PROJ.view === 'semana' ? 'semana' : PROJ.view === 'projetos' ? 'projetos' : 'hoje'; $$('#pjShell .pj-seg button').forEach((b) => b.classList.toggle('active', b.dataset.pv === v)) }
  const pjBodyLoading = () => { const b = $('#pjBody'); if (b && !b.children.length) b.replaceChildren(el('div', 'home-loading', '<span class="spin"></span><span>organizando…</span>')) }

  // -------------------------------------------------- HOJE
  async function loadProjHoje() {
    pjBodyLoading()
    const d = await api('/api/today')
    if (!d || S.tab !== 'projetos' || PROJ.view !== 'hoje') return
    renderProjHoje(d)
  }
  function renderProjHoje(d) {
    const body = $('#pjBody'); if (!body) return
    const frag = document.createDocumentFragment()
    const nowMs = Date.now()

    // hábitos do dia
    if (d.habits && d.habits.length) {
      const sec = el('section', 'pj-block')
      sec.innerHTML = `<div class="pj-block-head"><h2>Hábitos de hoje</h2><button class="btn ghost small" data-act="hab">Gerenciar</button></div>`
      const row = el('div', 'pj-habits')
      d.habits.forEach((h) => {
        const chip = el('button', `pj-habit${h.done ? ' done' : ''}${h.planned ? '' : ' off-day'}`)
        chip.innerHTML = `<span class="pj-habit-check">${h.done ? icon('i-check', 'ico ico-sm') : ''}</span><span class="pj-habit-name">${esc(h.name)}</span>${h.streak ? `<span class="pj-habit-streak">${icon('i-flame', 'ico ico-sm')}${h.streak}</span>` : ''}`
        chip.addEventListener('click', async () => { chip.classList.toggle('done'); const r = await post(`/api/habits/${h.id}/check`, {}); if (!r || !r.ok) { chip.classList.toggle('done'); toast('não deu pra marcar', 'err') } else loadProjHoje() })
        row.appendChild(chip)
      })
      sec.appendChild(row)
      sec.querySelector('[data-act="hab"]').addEventListener('click', openHabitsManager)
      frag.appendChild(sec)
    }

    // compromissos de hoje (agenda inteira)
    const evs = (d.events || []).slice().sort((a, b) => a.startMs - b.startMs)
    if (evs.length) {
      const sec = el('section', 'pj-block')
      sec.innerHTML = `<div class="pj-block-head"><h2>Compromissos de hoje</h2></div>`
      const list = el('div', 'pj-today-list')
      evs.forEach((e) => {
        const past = e.startMs < nowMs
        const it = el('button', `pj-today-item pj-event-open${past ? ' past' : ''}`)
        it.type = 'button'
        it.innerHTML = `<span class="pj-today-time">${e.allDay ? 'dia todo' : clockTime(e.startMs)}</span><span class="pj-today-body"><b>${esc(e.title)}</b><small>Ver detalhes, editar ou cancelar</small>${e.projectId ? projChipHtml(e.projectId) : ''}</span>${icon('i-arrow-r', 'ico ico-sm pj-event-arrow')}`
        it.addEventListener('click', () => openAgendaEvent(e, loadProjHoje))
        list.appendChild(it)
      })
      sec.appendChild(list); frag.appendChild(sec)
    }

    // lembretes de hoje
    if (d.reminders && d.reminders.length) {
      const sec = el('section', 'pj-block')
      sec.innerHTML = `<div class="pj-block-head"><h2>Lembretes de hoje</h2></div>`
      const list = el('div', 'pj-today-list')
      d.reminders.forEach((r) => list.appendChild(reminderRow(r, nowMs)))
      sec.appendChild(list); frag.appendChild(sec)
    }

    // tarefas de hoje + atrasadas (atrasadas primeiro)
    if (d.tasks && d.tasks.length) {
      const overdue = d.tasks.filter((t) => t.due_date < d.dayStart)
      const today = d.tasks.filter((t) => t.due_date >= d.dayStart)
      const sec = el('section', 'pj-block')
      sec.innerHTML = `<div class="pj-block-head"><h2>Tarefas</h2></div>`
      const list = el('div', 'pj-today-list')
      ;[...overdue, ...today].forEach((t) => list.appendChild(taskRow(t, { showDue: true })))
      sec.appendChild(list); frag.appendChild(sec)
    }

    // próximos passos dos projetos
    if (d.nextSteps && d.nextSteps.length) {
      const sec = el('section', 'pj-block')
      const collapsed = localStorage.getItem('vendas-multicanal.pjNextCollapsed') === '1'
      sec.innerHTML = `<button class="pj-block-head collapsible${collapsed ? '' : ' open'}"><h2>Próximos passos</h2>${icon('i-arrow-r', 'ico ico-sm chev')}</button>`
      const list = el('div', 'pj-today-list'); list.hidden = collapsed
      d.nextSteps.forEach((n) => {
        const it = el('div', 'pj-today-item next')
        it.innerHTML = `<span class="pj-dot" style="background:${colorHex(n.color)}"></span><span class="pj-today-body"><b>${esc(n.title)}</b><small>${esc(n.projectName)}</small></span><button class="pj-check" aria-label="Concluir">${icon('i-check', 'ico ico-sm')}</button>`
        it.querySelector('.pj-check').addEventListener('click', async () => { await jpatch(`/api/tasks/${n.taskId}`, { done: true }); toast('Passo concluído'); loadProjHoje() })
        it.querySelector('.pj-today-body').addEventListener('click', () => openProject(n.projectId))
        list.appendChild(it)
      })
      sec.appendChild(list)
      sec.querySelector('.collapsible').addEventListener('click', () => { list.hidden = !list.hidden; sec.querySelector('.collapsible').classList.toggle('open', !list.hidden); localStorage.setItem('vendas-multicanal.pjNextCollapsed', list.hidden ? '1' : '0') })
      frag.appendChild(sec)
    }

    if (!frag.childNodes.length) frag.appendChild(emptyState('i-check', 'Nada marcado pra hoje', 'Toque no + pra anotar uma tarefa, um lembrete ou um compromisso.'))
    body.replaceChildren(frag)
  }

  function reminderRow(r, nowMs) {
    const overdue = r.at < nowMs && r.status === 'ativo'
    const it = el('div', `pj-today-item rem${overdue ? ' overdue' : ''}`)
    const rec = r.recurrence ? ` · ${recLabel(r.recurrence)}` : ''
    it.innerHTML = `<span class="pj-today-time">${icon('i-clock', 'ico ico-sm')}${clockTime(r.at)}</span><span class="pj-today-body"><b>${esc(r.text)}</b><small>${overdue ? 'venceu ' + relDay(r.at) : relDay(r.at)}${rec}</small></span>
      <span class="pj-rem-actions"><button class="pj-check" data-act="done" aria-label="Feito">${icon('i-check', 'ico ico-sm')}</button><button class="pj-mini" data-act="snooze" aria-label="Adiar">${icon('i-clock', 'ico ico-sm')}</button></span>`
    it.querySelector('[data-act="done"]').addEventListener('click', async () => { await jpatch(`/api/reminders/${r.id}`, { action: 'done' }); toast('Lembrete concluído'); loadProjetos() })
    it.querySelector('[data-act="snooze"]').addEventListener('click', (e) => openSnooze(e.currentTarget, r))
    return it
  }
  function openSnooze(anchor, r) {
    const pop = el('div', 'pj-pop')
    const opts = [['10 min', 10 * 60000], ['1 hora', 3600000], ['hoje à noite', nightMs()], ['amanhã', tomorrowMs()]]
    pop.innerHTML = opts.map(([l], i) => `<button data-i="${i}">${esc(l)}</button>`).join('')
    $$('button', pop).forEach((b, i) => b.addEventListener('click', async () => { await jpatch(`/api/reminders/${r.id}`, { action: 'snooze', until: opts[i][1] > 100000000 ? opts[i][1] : Date.now() + opts[i][1] }); pop.remove(); toast('Adiado'); loadProjetos() }))
    floatPop(anchor, pop)
  }
  function nightMs() { const d = new Date(); d.setHours(20, 0, 0, 0); return d.getTime() }
  function tomorrowMs() { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime() }

  function taskRow(t, { showDue = false, inProject = false } = {}) {
    const it = el('div', `pj-task${t.done ? ' done' : ''}${t.due_date && t.due_date < Date.now() && !t.done ? ' overdue' : ''}`)
    const due = showDue && t.due_date ? `<small class="pj-task-due">${t.due_date < Date.now() ? 'venceu ' + relDay(t.due_date) : relDay(t.due_date)}</small>` : (t.due_date ? `<small class="pj-task-due">${relDay(t.due_date)}</small>` : '')
    it.innerHTML = `<button class="pj-check-box${t.done ? ' on' : ''}" aria-label="${t.done ? 'Desmarcar' : 'Concluir'}">${t.done ? icon('i-check', 'ico ico-sm') : ''}</button>
      <span class="pj-task-body">${t.is_next ? `<span class="pj-next-tag">${icon('i-target', 'ico ico-sm')} próximo passo</span>` : ''}<b>${esc(t.title)}</b>${due}</span>`
    it.querySelector('.pj-check-box').addEventListener('click', async () => { const r = await jpatch(`/api/tasks/${t.id}`, { done: !t.done }); if (r && r.ok) { if (PROJ.openId) loadProjDetail(PROJ.openId); else loadProjetos() } })
    return it
  }
  function projChipHtml(projectId) {
    const p = (PROJ.data && PROJ.data.projects || []).find((x) => x.id === projectId)
    if (!p) return ''
    return `<span class="pj-chip" style="--pc:${colorHex(p.color)}">${esc(p.name)}</span>`
  }

  // -------------------------------------------------- LISTA DE PROJETOS
  async function loadProjList() {
    pjBodyLoading()
    const d = await api('/api/projects')
    if (!d || S.tab !== 'projetos' || PROJ.view !== 'projetos') return
    PROJ.data = d
    renderProjList(d)
  }
  function renderProjList(d) {
    const body = $('#pjBody'); if (!body) return
    const frag = document.createDocumentFragment()
    const inboxN = (d.inbox.tasks.length + d.inbox.notes.length)
    if (inboxN) {
      const box = el('button', 'pj-inbox-card')
      box.innerHTML = `<span class="pj-inbox-ico">${icon('i-inbox', 'ico')}</span><span><b>Caixa de entrada</b><small>${inboxN} ${inboxN === 1 ? 'item avulso' : 'itens avulsos'}</small></span>${icon('i-arrow-r', 'ico ico-sm')}`
      box.addEventListener('click', () => openInbox(d.inbox))
      frag.appendChild(box)
    }
    const active = d.projects.filter((p) => p.status !== 'concluido')
    const done = d.projects.filter((p) => p.status === 'concluido')
    const grid = el('div', 'pj-grid')
    active.forEach((p) => grid.appendChild(projectCard(p)))
    const addCard = el('button', 'pj-card ghostcard')
    addCard.innerHTML = `${icon('i-new', 'ico')}<span>Novo projeto</span>`
    addCard.addEventListener('click', openNewProject)
    grid.appendChild(addCard)
    frag.appendChild(grid)
    if (done.length) {
      const wrap = el('div', 'pj-done-wrap')
      const collapsed = localStorage.getItem('vendas-multicanal.pjDoneCollapsed') !== '0'
      const head = el('button', 'pj-done-head' + (collapsed ? '' : ' open'), `${icon('i-arrow-r', 'ico ico-sm chev')} <span>Concluídos</span> <span class="pj-done-count">${done.length}</span>`)
      const dg = el('div', 'pj-grid'); dg.hidden = collapsed
      done.forEach((p) => dg.appendChild(projectCard(p)))
      head.addEventListener('click', () => { dg.hidden = !dg.hidden; head.classList.toggle('open', !dg.hidden); localStorage.setItem('vendas-multicanal.pjDoneCollapsed', dg.hidden ? '1' : '0') })
      wrap.append(head, dg); frag.appendChild(wrap)
    }
    body.replaceChildren(frag)
  }
  // Anel de progresso das tarefas. O arco é desenhado por dash-offset sobre a circunferência
  // (nada de conic-gradient: precisa da ponta arredondada e do mesmo traço nos dois anéis).
  function progressRing(pct, size) {
    const s = size || 54, r = (s - 7) / 2, circ = 2 * Math.PI * r
    return `<svg class="pj-ring" viewBox="0 0 ${s} ${s}" width="${s}" height="${s}" aria-hidden="true">
      <circle class="pj-ring-bg" cx="${s / 2}" cy="${s / 2}" r="${r}"></circle>
      <circle class="pj-ring-fg" cx="${s / 2}" cy="${s / 2}" r="${r}" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${(circ * (1 - pct / 100)).toFixed(1)}"></circle>
    </svg>`
  }
  function projectCard(p) {
    const c = el('button', `pj-card status-${p.status}`)
    c.style.setProperty('--pc', colorHex(p.color))
    const pct = p.tasksTotal ? Math.round((p.tasksDone / p.tasksTotal) * 100) : 0
    const next = p.nextStep ? `<div class="pj-card-next">${icon('i-target', 'ico ico-sm')} ${esc(p.nextStep.title)}</div>` : ''
    const nextDate = p.nextDue ? `<span class="pj-card-date">${relDay(p.nextDue)}</span>` : (p.dueDate ? `<span class="pj-card-date">${relDay(p.dueDate)}</span>` : '')
    const metric = p.metric && p.metric.name ? `<div class="pj-card-metric"><span>${esc(p.metric.name)}</span><b>${fmtMetric(p.metric.current)}${p.metric.target ? ' / ' + fmtMetric(p.metric.target) : ''}${p.metric.unit ? ' ' + esc(p.metric.unit) : ''}</b></div>` : ''
    const people = (p.people || []).slice(0, 3).map((pp) => avatarHtml(pp.name, pp.avatar, 'pj-ava')).join('')
    const more = p.peopleCount > 3 ? `<span class="pj-ava more">+${p.peopleCount - 3}</span>` : ''
    c.innerHTML = `
      <div class="pj-card-top"><span class="pj-card-type">${esc(PROJ_TYPES[p.type] || p.type)}</span>${nextDate}</div>
      <div class="pj-card-name">${esc(p.name)}</div>
      ${next}
      ${p.tasksTotal ? `<div class="pj-progress"><i style="width:${pct}%"></i></div><div class="pj-progress-lbl"><b>${pct}%</b> · ${p.tasksDone}/${p.tasksTotal} tarefas</div>` : ''}
      ${metric}
      ${(people || more) ? `<div class="pj-card-people">${people}${more}</div>` : ''}`
    c.addEventListener('click', () => openProject(p.id))
    return c
  }
  function fmtMetric(n) { if (n == null) return '0'; const v = Number(n); if (v >= 1e6) return (v / 1e6).toFixed(v % 1e6 ? 1 : 0) + 'M'; if (v >= 1e3) return (v / 1e3).toFixed(v % 1e3 ? 1 : 0) + 'k'; return String(v) }
  function parseMetric(str) { const s = String(str || '').trim().toLowerCase().replace(',', '.'); const m = s.match(/^([\d.]+)\s*([mk])?/); if (!m) return null; let v = parseFloat(m[1]); if (m[2] === 'm') v *= 1e6; else if (m[2] === 'k') v *= 1e3; return Math.round(v) }

  // -------------------------------------------------- SEMANA
  async function loadProjWeek() {
    pjBodyLoading()
    const [w, projs] = await Promise.all([api('/api/week'), PROJ.data ? Promise.resolve(PROJ.data) : api('/api/projects')])
    if (!w || S.tab !== 'projetos' || PROJ.view !== 'semana') return
    if (projs) PROJ.data = projs
    renderProjWeek(w)
  }
  function renderProjWeek(w) {
    const body = $('#pjBody'); if (!body) return
    const items = []
    ;(w.events || []).forEach((e) => items.push({ ms: e.startMs, kind: 'evento', title: e.title, allDay: e.allDay, projectId: e.projectId, event: e }))
    ;(w.reminders || []).forEach((r) => items.push({ ms: r.at, kind: 'lembrete', title: r.text, projectId: r.projectId, recurrence: r.recurrence }))
    ;(w.tasks || []).forEach((t) => items.push({ ms: t.due_date, kind: 'prazo', title: t.title, projectId: t.project_id }))
    const frag = document.createDocumentFragment()
    for (let i = 0; i < 7; i++) {
      const dayStart = w.from + i * 86400000
      const dayEnd = dayStart + 86400000
      const dd = items.filter((x) => x.ms >= dayStart && x.ms < dayEnd).sort((a, b) => a.ms - b.ms)
      const sec = el('div', 'pj-week-day')
      const label = i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : new Date(dayStart).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })
      sec.innerHTML = `<div class="pj-week-head">${esc(label)}</div>`
      if (!dd.length) sec.appendChild(el('div', 'pj-week-empty', 'livre'))
      else dd.forEach((x) => {
        const row = el('div', `pj-week-item ${x.kind}`)
        const ico = x.kind === 'evento' ? 'i-cal' : x.kind === 'lembrete' ? 'i-clock' : 'i-check'
        row.innerHTML = `<span class="pj-week-time">${x.allDay ? '' : clockTime(x.ms)}</span>${icon(ico, 'ico ico-sm')}<span class="pj-week-title">${esc(x.title)}</span>${x.projectId ? projChipHtml(x.projectId) : ''}`
        if (x.event) {
          row.classList.add('clickable')
          row.tabIndex = 0
          row.setAttribute('role', 'button')
          row.addEventListener('click', () => openAgendaEvent(x.event, loadProjWeek))
          row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAgendaEvent(x.event, loadProjWeek) } })
        }
        sec.appendChild(row)
      })
      frag.appendChild(sec)
    }
    body.replaceChildren(frag)
  }

  // -------------------------------------------------- DETALHE DO PROJETO
  function openProject(id) { PROJ.openId = id; loadProjDetail(id) }
  function backToProjectList() { PROJ.openId = null; PROJ.detail = null; const s = $('#pjShell'); if (s) s.remove(); loadProjetos() }
  async function loadProjDetail(id) {
    const host = $('#projetosHost')
    if (!$('#pjDetail')) host.replaceChildren(el('div', 'home-loading', '<span class="spin"></span><span>abrindo projeto…</span>'))
    const d = await api(`/api/projects/${encodeURIComponent(id)}`)
    if (!d || S.tab !== 'projetos' || PROJ.openId !== id) return
    if (d.error) { toast('projeto não encontrado', 'err'); backToProjectList(); return }
    PROJ.detail = d
    renderProjDetail(d)
  }
  function renderProjDetail(d) {
    const host = $('#projetosHost')
    const p = d.project
    const wrap = el('div', 'pj-detail'); wrap.id = 'pjDetail'
    wrap.style.setProperty('--pc', colorHex(p.color))
    const pct = p.tasksTotal ? Math.round((p.tasksDone / p.tasksTotal) * 100) : 0
    wrap.innerHTML = `
      <div class="pj-detail-head">
        <button class="icon-btn" id="pjBack" aria-label="Voltar">${icon('i-arrow-l')}</button>
        <div class="pj-detail-title"><span class="pj-detail-type">${esc(PROJ_TYPES[p.type] || p.type)}${p.status !== 'ativo' ? ' · ' + (p.status === 'pausado' ? 'pausado' : 'concluído') : ''}</span><h1 id="pjName" tabindex="0">${esc(p.name)}</h1></div>
        <button class="icon-btn" id="pjMenu" aria-label="Opções">${icon('i-more')}</button>
      </div>
      ${p.tasksTotal ? `<div class="pj-prog-banner">
        <div class="pj-ring-wrap">${progressRing(pct)}<span class="pj-ring-pct">${pct}<i>%</i></span></div>
        <div class="pj-prog-txt"><span>Concluído</span><b>${p.tasksDone} de ${p.tasksTotal} tarefas</b></div>
      </div>` : ''}
      ${p.metric && p.metric.name ? `<div class="pj-metric-banner">
        <div><span class="pj-metric-name">${esc(p.metric.name)}</span><b>${fmtMetric(p.metric.current)}${p.metric.target ? ' / ' + fmtMetric(p.metric.target) : ''} ${esc(p.metric.unit || '')}</b></div>
        ${p.metric.target ? `<div class="pj-progress big"><i style="width:${Math.min(100, Math.round((p.metric.current / p.metric.target) * 100))}%"></i></div>` : ''}
        <button class="btn ghost small" id="pjMetricUp">Atualizar</button>
      </div>` : ''}
      <div id="pjNextHost"></div>
      <section class="pj-sec"><div class="pj-sec-head"><h2>Tarefas</h2>${p.tasksTotal ? `<span class="pj-sec-count">${p.tasksDone}/${p.tasksTotal}</span>` : ''}</div><div id="pjTasks"></div>
        <form class="pj-add" id="pjTaskAdd"><input type="text" placeholder="Adicionar tarefa" autocomplete="off"><button class="btn small" type="submit">${icon('i-new', 'ico ico-sm')}</button></form></section>
      <section class="pj-sec"><div class="pj-sec-head"><h2>Compromissos</h2><button class="btn ghost small" id="pjAddEvent">${icon('i-cal', 'ico ico-sm')} Marcar</button></div><div id="pjEvents"></div></section>
      <section class="pj-sec"><div class="pj-sec-head"><h2>Lembretes</h2><button class="btn ghost small" id="pjAddRem">${icon('i-clock', 'ico ico-sm')} Novo</button></div><div id="pjRems"></div></section>
      <section class="pj-sec"><div class="pj-sec-head"><h2>Envolvidos</h2><button class="btn ghost small" id="pjAddPerson">${icon('i-users', 'ico ico-sm')} Adicionar</button></div><div id="pjPeople" class="pj-people"></div></section>
      <section class="pj-sec"><div class="pj-sec-head"><h2>Notas</h2></div><div id="pjNotes"></div>
        <form class="pj-add" id="pjNoteAdd"><input type="text" placeholder="Escrever uma nota" autocomplete="off"><button class="btn small" type="submit">${icon('i-new', 'ico ico-sm')}</button></form></section>
      <section class="pj-sec"><button class="pj-sec-head collapsible" id="pjLogHead"><h2>Histórico</h2>${icon('i-arrow-r', 'ico ico-sm chev')}</button><div id="pjLog" hidden></div></section>`
    host.replaceChildren(wrap)
    $('#pjBack').addEventListener('click', backToProjectList)
    $('#pjMenu').addEventListener('click', (e) => openProjectMenu(e.currentTarget, p))
    $('#pjName').addEventListener('click', () => editProjectName(p))
    if ($('#pjMetricUp')) $('#pjMetricUp').addEventListener('click', (e) => editMetric(e.currentTarget, p))
    renderNextStep(d); renderTasks(d); renderEvents(d); renderRems(d); renderPeople(d); renderNotes(d)
    $('#pjTaskAdd').addEventListener('submit', async (e) => { e.preventDefault(); const inp = e.target.querySelector('input'); const v = inp.value.trim(); if (!v) return; const r = await post(`/api/projects/${p.id}/tasks`, { title: v }); if (r && r.ok) { inp.value = ''; inp.focus(); loadProjDetail(p.id) } })
    $('#pjNoteAdd').addEventListener('submit', async (e) => { e.preventDefault(); const inp = e.target.querySelector('input'); const v = inp.value.trim(); if (!v) return; const r = await post(`/api/projects/${p.id}/notes`, { text: v }); if (r && r.ok) { inp.value = ''; loadProjDetail(p.id) } })
    $('#pjAddEvent').addEventListener('click', (e) => openEventPicker(e.currentTarget, p))
    $('#pjAddRem').addEventListener('click', (e) => openReminderPicker(e.currentTarget, p))
    $('#pjAddPerson').addEventListener('click', () => openPeoplePicker(async (personId) => { await post(`/api/projects/${p.id}/people`, { personId }); loadProjDetail(p.id) }))
    $('#pjLogHead').addEventListener('click', () => { const l = $('#pjLog'); l.hidden = !l.hidden; $('#pjLogHead').classList.toggle('open', !l.hidden); if (!l.hidden) renderLog(d) })
  }
  function renderNextStep(d) {
    const host = $('#pjNextHost'); if (!host) return
    const next = d.tasks.find((t) => t.is_next && !t.done)
    if (!next) { host.replaceChildren(); return }
    const box = el('div', 'pj-next-box')
    box.innerHTML = `<span class="pj-next-kicker">${icon('i-target', 'ico ico-sm')} Próximo passo</span><div class="pj-next-row"><b>${esc(next.title)}</b><button class="pj-check-box big" aria-label="Concluir"></button></div>`
    box.querySelector('.pj-check-box').addEventListener('click', async () => { await jpatch(`/api/tasks/${next.id}`, { done: true }); loadProjDetail(d.project.id) })
    host.replaceChildren(box)
  }
  function renderTasks(d) {
    const host = $('#pjTasks'); if (!host) return
    const open = d.tasks.filter((t) => !t.done)
    const done = d.tasks.filter((t) => t.done)
    const frag = document.createDocumentFragment()
    open.forEach((t, i) => frag.appendChild(taskDetailRow(t, d, i, open.length)))
    if (done.length) {
      const collapsed = true
      const head = el('button', 'pj-done-tasks-head', `${icon('i-arrow-r', 'ico ico-sm chev')} ${done.length} concluída${done.length === 1 ? '' : 's'}`)
      const list = el('div', ''); list.hidden = collapsed
      done.forEach((t) => list.appendChild(taskDetailRow(t, d)))
      head.addEventListener('click', () => { list.hidden = !list.hidden; head.classList.toggle('open', !list.hidden) })
      frag.append(head, list)
    }
    if (!open.length && !done.length) frag.appendChild(el('div', 'pj-empty-line', 'Nenhuma tarefa ainda. Adicione a primeira abaixo.'))
    host.replaceChildren(frag)
  }
  function taskDetailRow(t, d, idx, total) {
    const row = el('div', `pj-task detail${t.done ? ' done' : ''}${t.due_date && t.due_date < Date.now() && !t.done ? ' overdue' : ''}`)
    const due = t.due_date ? `<small class="pj-task-due">${t.due_date < Date.now() && !t.done ? 'venceu ' + relDay(t.due_date) : relDay(t.due_date)}</small>` : ''
    row.innerHTML = `<button class="pj-check-box${t.done ? ' on' : ''}" aria-label="${t.done ? 'Desmarcar' : 'Concluir'}">${t.done ? icon('i-check', 'ico ico-sm') : ''}</button>
      <span class="pj-task-body">${t.is_next ? `<span class="pj-next-tag">${icon('i-target', 'ico ico-sm')} próximo passo</span>` : ''}<b>${esc(t.title)}</b>${due}</span>
      <button class="pj-mini" data-act="menu" aria-label="Opções">${icon('i-more', 'ico ico-sm')}</button>`
    row.querySelector('.pj-check-box').addEventListener('click', async () => { await jpatch(`/api/tasks/${t.id}`, { done: !t.done }); loadProjDetail(d.project.id) })
    row.querySelector('[data-act="menu"]').addEventListener('click', (e) => openTaskMenu(e.currentTarget, t, d, idx, total))
    return row
  }
  function openTaskMenu(anchor, t, d, idx, total) {
    const pop = el('div', 'pj-pop wide')
    const rows = []
    if (!t.done) rows.push(['next', t.is_next ? 'Tirar de próximo passo' : 'Tornar próximo passo', 'i-target'])
    if (!t.done) rows.push(['due', t.due_date ? 'Mudar prazo' : 'Definir prazo', 'i-cal'])
    if (typeof idx === 'number' && idx > 0) rows.push(['up', 'Subir', 'i-arrow-l'])
    if (typeof idx === 'number' && idx < total - 1) rows.push(['down', 'Descer', 'i-arrow-r'])
    rows.push(['del', 'Excluir', 'i-trash'])
    pop.innerHTML = rows.map(([a, l, ic]) => `<button data-a="${a}" class="${a === 'del' ? 'danger' : ''}">${icon(ic, 'ico ico-sm')} ${esc(l)}</button>`).join('')
    $$('button', pop).forEach((b) => b.addEventListener('click', async () => {
      const a = b.dataset.a; pop.remove()
      if (a === 'next') { await jpatch(`/api/tasks/${t.id}`, { isNext: !t.is_next }); loadProjDetail(d.project.id) }
      else if (a === 'due') openTaskDue(anchor, t, d)
      else if (a === 'up') { await post(`/api/tasks/${t.id}/move`, { dir: -1 }); loadProjDetail(d.project.id) }
      else if (a === 'down') { await post(`/api/tasks/${t.id}/move`, { dir: 1 }); loadProjDetail(d.project.id) }
      else if (a === 'del') { await jdel(`/api/tasks/${t.id}`); loadProjDetail(d.project.id) }
    }))
    floatPop(anchor, pop)
  }
  function openTaskDue(anchor, t, d) {
    const box = dateSheet({ base: t.due_date || Date.now(), onPick: async ({ ms }) => { await jpatch(`/api/tasks/${t.id}`, { dueDate: ms }); loadProjDetail(d.project.id) } })
    floatPop(anchor, box, true)
  }
  function renderEvents(d) {
    const host = $('#pjEvents'); if (!host) return
    const now = Date.now()
    const evs = (d.events || []).filter((e) => e.startMs >= now - 3600000).sort((a, b) => a.startMs - b.startMs)
    if (!evs.length) { host.replaceChildren(el('div', 'pj-empty-line', d.agendaOff ? '' : 'Nenhum compromisso marcado.')); return }
    const frag = document.createDocumentFragment()
    evs.forEach((e) => {
      const it = el('button', 'pj-event pj-event-open')
      it.type = 'button'
      it.innerHTML = `${icon('i-cal', 'ico ico-sm')}<span><b>${esc(e.title)}</b><small>${esc(relWhen(e.startMs))} · ver detalhes</small></span>${icon('i-arrow-r', 'ico ico-sm pj-event-arrow')}`
      it.addEventListener('click', () => openAgendaEvent(e, () => loadProjDetail(d.project.id)))
      frag.appendChild(it)
    })
    host.replaceChildren(frag)
  }
  function renderRems(d) {
    const host = $('#pjRems'); if (!host) return
    if (!d.reminders.length) { host.replaceChildren(el('div', 'pj-empty-line', 'Nenhum lembrete.')); return }
    const frag = document.createDocumentFragment()
    d.reminders.forEach((r) => {
      const it = el('div', 'pj-rem-row')
      const rec = r.recurrence ? ` · ${recLabel(r.recurrence)}, próximo ${relDay(r.at)}` : ` · ${relWhen(r.at)}`
      it.innerHTML = `${icon('i-clock', 'ico ico-sm')}<span class="pj-rem-body"><b>${esc(r.text)}</b><small>${esc((r.recurrence ? recLabel(r.recurrence) : relWhen(r.at)) + (r.recurrence ? ', próximo ' + relDay(r.at) : ''))}</small></span><button class="pj-mini" data-act="del" aria-label="Excluir">${icon('i-trash', 'ico ico-sm')}</button>`
      it.querySelector('[data-act="del"]').addEventListener('click', (e) => confirmDestructive(e.currentTarget, 'Confirmar', async () => { await jdel(`/api/reminders/${r.id}`); loadProjDetail(d.project.id) }))
      frag.appendChild(it)
    })
    host.replaceChildren(frag)
  }
  function renderPeople(d) {
    const host = $('#pjPeople'); if (!host) return
    if (!d.people.length) { host.replaceChildren(el('div', 'pj-empty-line', 'Ninguém vinculado ainda.')); return }
    const frag = document.createDocumentFragment()
    d.people.forEach((pp) => {
      const chip = el('div', 'pj-person')
      const chans = (pp.channels || []).map((c) => icon(c === 'whatsapp' ? 'i-wa' : c === 'instagram' ? 'i-ig' : 'i-heart', 'ico ico-sm')).join('')
      chip.innerHTML = `${avatarHtml(pp.name, pp.avatar, 'pj-ava')}<span class="pj-person-body"><b>${esc(pp.name)}</b><small>${chans}${pp.role ? ' · ' + esc(pp.role) : ''}</small></span><button class="pj-mini" data-act="menu" aria-label="Opções">${icon('i-more', 'ico ico-sm')}</button>`
      chip.querySelector('[data-act="menu"]').addEventListener('click', (e) => openPersonMenu(e.currentTarget, pp, d))
      frag.appendChild(chip)
    })
    host.replaceChildren(frag)
  }
  function openPersonMenu(anchor, pp, d) {
    const pop = el('div', 'pj-pop wide')
    const rows = [['role', pp.role ? 'Mudar papel' : 'Definir papel', 'i-edit'], ['same', 'É a mesma pessoa que…', 'i-link']]
    if (pp.merge) rows.push(['unmerge', 'Desfazer união', 'i-x'])
    rows.push(['remove', 'Tirar do projeto', 'i-trash'])
    pop.innerHTML = rows.map(([a, l, ic]) => `<button data-a="${a}" class="${a === 'remove' ? 'danger' : ''}">${icon(ic, 'ico ico-sm')} ${esc(l)}</button>`).join('')
    $$('button', pop).forEach((b) => b.addEventListener('click', async () => {
      const a = b.dataset.a; pop.remove()
      if (a === 'role') editRole(anchor, pp, d)
      else if (a === 'same') openPeoplePicker(async (otherId) => { const r = await post('/api/people/merge', { primaryId: pp.personId, secondaryId: otherId }); if (r && r.ok) toast('Pessoas unificadas'); loadProjDetail(d.project.id) }, { excludeId: pp.personId, title: 'Quem é a mesma pessoa?' })
      else if (a === 'unmerge') { await post('/api/people/merge/undo', { mergeId: pp.merge }); toast('União desfeita'); loadProjDetail(d.project.id) }
      else if (a === 'remove') { await post(`/api/projects/${d.project.id}/people`, { action: 'remove', personId: pp.personId }); loadProjDetail(d.project.id) }
    }))
    floatPop(anchor, pop)
  }
  function editRole(anchor, pp, d) {
    const box = el('div', 'pj-pop input')
    box.innerHTML = `<input type="text" placeholder="papel (ex: designer)" value="${esc(pp.role || '')}"><button class="btn small">${icon('i-check', 'ico ico-sm')}</button>`
    const save = async () => { const v = box.querySelector('input').value.trim(); await post(`/api/projects/${d.project.id}/people`, { action: 'role', personId: pp.personId, role: v || null }); box.remove(); loadProjDetail(d.project.id) }
    box.querySelector('button').addEventListener('click', save)
    box.querySelector('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') save() })
    floatPop(anchor, box); box.querySelector('input').focus()
  }
  function renderNotes(d) {
    const host = $('#pjNotes'); if (!host) return
    if (!d.notes.length) { host.replaceChildren(el('div', 'pj-empty-line', 'Sem notas.')); return }
    const frag = document.createDocumentFragment()
    d.notes.forEach((n) => { const it = el('div', 'pj-note'); it.innerHTML = `<span>${esc(n.text)}</span><small>${timeAgo(n.created_at)}</small><button class="pj-mini" aria-label="Excluir">${icon('i-trash', 'ico ico-sm')}</button>`; it.querySelector('button').addEventListener('click', (e) => confirmDestructive(e.currentTarget, 'Confirmar', async () => { await jdel(`/api/notes/${n.id}`); loadProjDetail(d.project.id) })); frag.appendChild(it) })
    host.replaceChildren(frag)
  }
  function renderLog(d) {
    const host = $('#pjLog'); if (!host) return
    const LT = { created: 'Projeto criado', task_added: 'Tarefa adicionada', task_done: 'Tarefa concluída', note_added: 'Nota', event_created: 'Compromisso marcado', reminder_added: 'Lembrete criado', person_added: 'Pessoa vinculada', metric_update: 'Métrica atualizada', status_change: 'Status' }
    host.replaceChildren(...(d.log || []).map((l) => { const it = el('div', 'pj-log-row'); it.innerHTML = `<span class="pj-log-when">${timeAgo(l.ts)}</span><span>${esc(LT[l.type] || l.type)}${l.detail && !l.detail.startsWith('{') ? ': ' + esc(l.detail) : ''}</span>`; return it }))
    if (!d.log || !d.log.length) host.replaceChildren(el('div', 'pj-empty-line', 'Nada ainda.'))
  }

  // -------------------------------------------------- menus/edições do projeto
  function openProjectMenu(anchor, p) {
    const pop = el('div', 'pj-pop wide')
    const rows = [['color', 'Cor', 'i-edit'],
      [p.status === 'pausado' ? 'resume' : 'pause', p.status === 'pausado' ? 'Retomar' : 'Pausar', p.status === 'pausado' ? 'i-play' : 'i-pause'],
      [p.status === 'concluido' ? 'reopen' : 'done', p.status === 'concluido' ? 'Reabrir' : 'Concluir projeto', 'i-check'],
      ['metric', p.metric && p.metric.name ? 'Editar meta' : 'Adicionar meta', 'i-target'],
      ['del', 'Excluir projeto', 'i-trash']]
    pop.innerHTML = rows.map(([a, l, ic]) => `<button data-a="${a}" class="${a === 'del' ? 'danger' : ''}">${icon(ic, 'ico ico-sm')} ${esc(l)}</button>`).join('')
    $$('button', pop).forEach((b) => b.addEventListener('click', async () => {
      const a = b.dataset.a; pop.remove()
      if (a === 'color') openColorPicker(anchor, p)
      else if (a === 'pause') { await jpatch(`/api/projects/${p.id}`, { status: 'pausado' }); loadProjDetail(p.id) }
      else if (a === 'resume') { await jpatch(`/api/projects/${p.id}`, { status: 'ativo' }); loadProjDetail(p.id) }
      else if (a === 'done') { await jpatch(`/api/projects/${p.id}`, { status: 'concluido' }); toast('Projeto concluído'); loadProjDetail(p.id) }
      else if (a === 'reopen') { await jpatch(`/api/projects/${p.id}`, { status: 'ativo' }); loadProjDetail(p.id) }
      else if (a === 'metric') openMetricEditor(anchor, p)
      else if (a === 'del') confirmDestructive(b, 'Confirmar exclusão', async () => { await jdel(`/api/projects/${p.id}`); toast('Projeto excluído'); backToProjectList() })
    }))
    floatPop(anchor, pop)
  }
  function editProjectName(p) {
    const h = $('#pjName'); if (!h || h.querySelector('input')) return
    const cur = p.name
    h.innerHTML = `<input class="pj-name-input" type="text" value="${esc(cur)}">`
    const inp = h.querySelector('input'); inp.focus(); inp.select()
    const save = async () => { const v = inp.value.trim() || cur; h.textContent = v; if (v !== cur) { await jpatch(`/api/projects/${p.id}`, { name: v }); loadProjDetail(p.id) } }
    inp.addEventListener('blur', save)
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { h.textContent = cur } })
  }
  function openColorPicker(anchor, p) {
    const pop = el('div', 'pj-pop colors')
    pop.innerHTML = Object.keys(PROJ_COLORS).map((c) => `<button class="pj-swatch${c === p.color ? ' on' : ''}" data-c="${c}" style="background:${PROJ_COLORS[c]}" aria-label="${c}"></button>`).join('')
    $$('button', pop).forEach((b) => b.addEventListener('click', async () => { pop.remove(); await jpatch(`/api/projects/${p.id}`, { color: b.dataset.c }); loadProjDetail(p.id) }))
    floatPop(anchor, pop)
  }
  function openMetricEditor(anchor, p) {
    const m = p.metric || {}
    const box = el('div', 'pj-pop input col')
    box.innerHTML = `<input class="mn" type="text" placeholder="nome (ex: seguidores)" value="${esc(m.name || '')}">
      <div class="pj-pop-row"><input class="mt" type="text" inputmode="numeric" placeholder="meta (1M)" value="${m.target != null ? fmtMetric(m.target) : ''}"><input class="mc" type="text" inputmode="numeric" placeholder="atual (870k)" value="${m.current != null ? fmtMetric(m.current) : ''}"></div>
      <button class="btn small">${icon('i-check', 'ico ico-sm')} Salvar</button>`
    box.querySelector('button').addEventListener('click', async () => {
      const name = box.querySelector('.mn').value.trim()
      await jpatch(`/api/projects/${p.id}`, { metricName: name || null, metricTarget: parseMetric(box.querySelector('.mt').value), metricCurrent: parseMetric(box.querySelector('.mc').value) || 0 })
      box.remove(); loadProjDetail(p.id)
    })
    floatPop(anchor, box); box.querySelector('.mn').focus()
  }
  function editMetric(anchor, p) {
    const box = el('div', 'pj-pop input')
    box.innerHTML = `<input type="text" inputmode="numeric" placeholder="valor atual (ex: 870k)"><button class="btn small">${icon('i-check', 'ico ico-sm')}</button>`
    const save = async () => { const v = parseMetric(box.querySelector('input').value); if (v == null) { toast('valor inválido', 'err'); return } await jpatch(`/api/projects/${p.id}`, { metricCurrent: v }); box.remove(); loadProjDetail(p.id) }
    box.querySelector('button').addEventListener('click', save)
    box.querySelector('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') save() })
    floatPop(anchor, box); box.querySelector('input').focus()
  }

  // -------------------------------------------------- novo projeto (inline)
  function openNewProject() {
    const ov = overlay()
    const sheet = el('div', 'pj-sheet')
    sheet.innerHTML = `<div class="pj-sheet-head"><h2>Novo projeto</h2><button class="icon-btn" data-x>${icon('i-x')}</button></div>
      <input class="pj-sheet-name" type="text" placeholder="Nome do projeto" autocomplete="off">
      <div class="pj-sheet-lbl">Tipo</div>
      <div class="pj-chips" id="npType">${Object.entries(PROJ_TYPES).map(([k, v], i) => `<button class="chip${i === 1 ? ' active' : ''}" data-t="${k}">${esc(v)}</button>`).join('')}</div>
      <div class="pj-sheet-lbl">Cor</div>
      <div class="pj-swatches" id="npColor">${Object.keys(PROJ_COLORS).map((c, i) => `<button class="pj-swatch${i === 0 ? ' on' : ''}" data-c="${c}" style="background:${PROJ_COLORS[c]}"></button>`).join('')}</div>
      <button class="btn wide" id="npCreate">Criar projeto</button>`
    ov.appendChild(sheet)
    let type = 'pessoal', color = 'teal'
    $$('#npType .chip', sheet).forEach((b) => b.addEventListener('click', () => { type = b.dataset.t; $$('#npType .chip', sheet).forEach((x) => x.classList.toggle('active', x === b)) }))
    $$('#npColor .pj-swatch', sheet).forEach((b) => b.addEventListener('click', () => { color = b.dataset.c; $$('#npColor .pj-swatch', sheet).forEach((x) => x.classList.toggle('on', x === b)) }))
    sheet.querySelector('[data-x]').addEventListener('click', () => ov.remove())
    const nameInp = sheet.querySelector('.pj-sheet-name'); nameInp.focus()
    $('#npCreate', sheet).addEventListener('click', async () => {
      const name = nameInp.value.trim(); if (!name) { nameInp.focus(); return }
      const r = await post('/api/projects', { name, type, color })
      ov.remove()
      if (r && r.ok) { toast('Projeto criado'); openProject(r.project.id) }
    })
    nameInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#npCreate', sheet).click() })
  }

  // -------------------------------------------------- caixa de entrada
  function openInbox(inbox) {
    const ov = overlay()
    const sheet = el('div', 'pj-sheet tall')
    sheet.innerHTML = `<div class="pj-sheet-head"><h2>Caixa de entrada</h2><button class="icon-btn" data-x>${icon('i-x')}</button></div><div id="inboxList"></div>`
    ov.appendChild(sheet)
    const list = $('#inboxList', sheet)
    const render = (items) => {
      list.replaceChildren()
      if (!items.tasks.length && !items.notes.length) { list.appendChild(emptyState('i-inbox', 'Vazia', 'Nada solto por aqui.')); return }
      items.tasks.forEach((t) => { const it = el('div', 'pj-inbox-item'); it.innerHTML = `${icon('i-check', 'ico ico-sm')}<span>${esc(t.title)}</span><button class="btn ghost small" data-act="move">Mover</button>`; it.querySelector('[data-act="move"]').addEventListener('click', (e) => moveInboxItem(e.currentTarget, 'task', t.id, ov)); list.appendChild(it) })
      items.notes.forEach((n) => { const it = el('div', 'pj-inbox-item'); it.innerHTML = `${icon('i-note', 'ico ico-sm')}<span>${esc(n.text)}</span><button class="btn ghost small" data-act="move">Mover</button>`; it.querySelector('[data-act="move"]').addEventListener('click', (e) => moveInboxItem(e.currentTarget, 'note', n.id, ov)); list.appendChild(it) })
    }
    render(inbox)
    sheet.querySelector('[data-x]').addEventListener('click', () => ov.remove())
  }
  async function moveInboxItem(anchor, kind, id, ov) {
    const d = PROJ.data || await api('/api/projects')
    const pop = el('div', 'pj-pop wide scroll')
    const active = d.projects.filter((p) => p.status === 'ativo')
    if (!active.length) { toast('crie um projeto primeiro', 'err'); return }
    pop.innerHTML = active.map((p) => `<button data-p="${p.id}"><span class="pj-dot" style="background:${colorHex(p.color)}"></span>${esc(p.name)}</button>`).join('')
    $$('button', pop).forEach((b) => b.addEventListener('click', async () => {
      pop.remove()
      if (kind === 'task') await jpatch(`/api/tasks/${id}`, { projectId: b.dataset.p })
      else { await post(`/api/projects/${b.dataset.p}/notes`, { text: anchorText(anchor) }); await jdel(`/api/notes/${id}`) } // nota avulsa -> recria no projeto e apaga a solta
      toast('Movido'); ov.remove(); loadProjetos()
    }))
    floatPop(anchor, pop)
  }
  function anchorText(anchor) { const row = anchor.closest('.pj-inbox-item'); const s = row && row.querySelector('span'); return s ? s.textContent : '' }

  // -------------------------------------------------- captura rápida
  function openCapture() {
    const ov = overlay()
    const sheet = el('div', 'pj-sheet capture')
    sheet.innerHTML = `<div class="pj-sheet-head"><h2>O que tem na cabeça?</h2><button class="icon-btn" data-x>${icon('i-x')}</button></div>
      <textarea class="pj-capture-input" rows="2" placeholder="ex: reunião com contador quinta 15h no escritório" autocomplete="off"></textarea>
      <div id="capPreview"></div>
      <div class="pj-capture-actions"><button class="btn wide" id="capGo" disabled>Interpretar</button></div>`
    ov.appendChild(sheet)
    const ta = sheet.querySelector('.pj-capture-input'); ta.focus()
    const go = $('#capGo', sheet)
    ta.addEventListener('input', () => { go.disabled = !ta.value.trim(); if ($('#capPreview').dataset.for !== ta.value.trim()) $('#capPreview').replaceChildren() })
    sheet.querySelector('[data-x]').addEventListener('click', () => ov.remove())
    let preview = null
    go.addEventListener('click', async () => {
      if (!preview) { // interpretar
        go.disabled = true; go.textContent = 'lendo…'
        const r = await post('/api/capture', { text: ta.value.trim() })
        go.textContent = 'Interpretar'; go.disabled = false
        if (!r || !r.ok) { toast('não deu pra interpretar', 'err'); return }
        preview = r.preview; renderCapturePreview(sheet, preview, () => { preview = null; go.textContent = 'Interpretar' })
        go.textContent = 'Guardar'
      } else { // guardar
        go.disabled = true
        const body = { type: preview.type, projectId: preview.projectId, title: preview.title, text: preview.text, at: preview.at, dueDate: preview.dueDate, recurrence: preview.recurrence }
        const r = await post('/api/capture/commit', body)
        ov.remove()
        if (r && r.ok) { toast(capturedMsg(r.kind)); loadProjetos() } else toast('não deu pra guardar', 'err')
      }
    })
  }
  function capturedMsg(kind) { return kind === 'compromisso' ? 'Compromisso na agenda' : kind === 'lembrete' ? 'Lembrete criado' : kind === 'nota' ? 'Nota guardada' : 'Tarefa criada' }
  function renderCapturePreview(sheet, p, onTypeChange) {
    const host = $('#capPreview', sheet); host.dataset.for = p.text
    const typeLabels = { task: 'Tarefa', compromisso: 'Compromisso', lembrete: 'Lembrete', nota: 'Nota' }
    const whenMs = p.at || p.dueDate
    const box = el('div', 'pj-preview')
    box.innerHTML = `
      <div class="pj-preview-title">${esc(p.title)}</div>
      <div class="pj-preview-chips">
        <button class="pj-pchip" data-k="type">${icon('i-target', 'ico ico-sm')} ${esc(typeLabels[p.type])}</button>
        <button class="pj-pchip" data-k="proj">${icon('i-folder', 'ico ico-sm')} ${esc(p.projectName || 'sem projeto')}</button>
        ${(p.type === 'compromisso' || p.type === 'lembrete' || p.type === 'task') ? `<button class="pj-pchip" data-k="when">${icon('i-cal', 'ico ico-sm')} ${whenMs ? esc(relWhen(whenMs)) + (p.vagueTime ? '?' : '') : 'sem data'}</button>` : ''}
        ${(p.type === 'lembrete') ? `<button class="pj-pchip" data-k="rec">${icon('i-repeat', 'ico ico-sm')} ${esc(p.recurrence ? recLabel(p.recurrence) : 'uma vez')}</button>` : ''}
      </div>`
    host.replaceChildren(box)
    box.querySelector('[data-k="type"]').addEventListener('click', (e) => {
      const pop = el('div', 'pj-pop'); pop.innerHTML = Object.entries(typeLabels).map(([k, v]) => `<button data-t="${k}">${esc(v)}</button>`).join('')
      $$('button', pop).forEach((b) => b.addEventListener('click', () => { p.type = b.dataset.t; if (p.type === 'task') { p.dueDate = p.dueDate || p.at; p.at = null } else { p.at = p.at || p.dueDate; p.dueDate = null } pop.remove(); renderCapturePreview(sheet, p, onTypeChange); onTypeChange && onTypeChange() }))
      floatPop(e.currentTarget, pop)
    })
    box.querySelector('[data-k="proj"]').addEventListener('click', (e) => {
      const pop = el('div', 'pj-pop wide scroll'); pop.innerHTML = `<button data-p="">sem projeto</button>` + (p.projects || []).map((x) => `<button data-p="${x.id}"><span class="pj-dot" style="background:${colorHex(x.color)}"></span>${esc(x.name)}</button>`).join('')
      $$('button', pop).forEach((b) => b.addEventListener('click', () => { p.projectId = b.dataset.p || null; p.projectName = b.dataset.p ? (p.projects.find((x) => x.id === b.dataset.p) || {}).name : null; pop.remove(); renderCapturePreview(sheet, p, onTypeChange) }))
      floatPop(e.currentTarget, pop)
    })
    const whenChip = box.querySelector('[data-k="when"]')
    if (whenChip) whenChip.addEventListener('click', (e) => { const box2 = dateSheet({ base: whenMs || Date.now(), onPick: ({ ms }) => { if (p.type === 'task') p.dueDate = ms; else p.at = ms; p.vagueTime = false; renderCapturePreview(sheet, p, onTypeChange) } }); floatPop(e.currentTarget, box2, true) })
    const recChip = box.querySelector('[data-k="rec"]')
    if (recChip) recChip.addEventListener('click', (e) => { const pop = recPop((rec) => { p.recurrence = rec; renderCapturePreview(sheet, p, onTypeChange) }); floatPop(e.currentTarget, pop) })
  }

  // -------------------------------------------------- date/recurrence pickers
  function recLabel(r) { return { daily: 'todo dia', weekly: 'toda semana', monthly: 'todo mês', yearly: 'todo ano' }[r] || r }
  function recPop(onPick) {
    const pop = el('div', 'pj-pop')
    const opts = [['', 'uma vez'], ['daily', 'todo dia'], ['weekly', 'toda semana'], ['monthly', 'todo mês'], ['yearly', 'todo ano']]
    pop.innerHTML = opts.map(([k, l]) => `<button data-r="${k}">${esc(l)}</button>`).join('')
    $$('button', pop).forEach((b) => b.addEventListener('click', () => { onPick(b.dataset.r || null); pop.remove() }))
    return pop
  }
  // Seletor de data/hora NOSSO: chips de 14 dias + hora inteligente. onPick({ ms })
  function dateSheet({ base, onPick, withRecurrence = false, onRec }) {
    const box = el('div', 'pj-datesheet')
    const today = new Date()
    let selKey = null
    const baseD = new Date(base || Date.now())
    const days = []
    for (let i = 0; i < 14; i++) { const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i); days.push({ key: agKey(d), label: i === 0 ? 'hoje' : i === 1 ? 'amanhã' : d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit' }) }) }
    selKey = agKey(baseD); if (!days.some((d) => d.key === selKey)) selKey = days[0].key
    const baseHora = `${pad2(baseD.getHours())}:${pad2(baseD.getMinutes())}`
    box.innerHTML = `<div class="pj-ds-days"></div>
      <div class="pj-ds-row"><span>às</span><input class="pj-ds-time field" type="text" inputmode="numeric" value="${baseHora}" maxlength="5"><button class="btn small" data-act="ok">${icon('i-check', 'ico ico-sm')} Marcar</button></div>
      ${withRecurrence ? `<div class="pj-ds-rec" id="pjDsRec"></div>` : ''}`
    const daysHost = box.querySelector('.pj-ds-days')
    days.forEach((d) => { const c = el('button', 'chip' + (d.key === selKey ? ' active' : ''), d.label); c.addEventListener('click', () => { selKey = d.key; daysHost.querySelectorAll('.chip').forEach((x) => x.classList.remove('active')); c.classList.add('active') }); daysHost.appendChild(c) })
    const timeEl = box.querySelector('.pj-ds-time')
    timeEl.addEventListener('blur', () => { const t = parseHora(timeEl.value); if (t) timeEl.value = `${pad2(t.h)}:${pad2(t.m)}` })
    box.querySelector('[data-act="ok"]').addEventListener('click', () => { const t = parseHora(timeEl.value); if (!t) { timeEl.classList.add('err'); toast('hora inválida (ex: 15:30)', 'err'); return } const ms = Date.parse(`${selKey}T${pad2(t.h)}:${pad2(t.m)}:00-03:00`); onPick({ ms }) })
    return box
  }

  // -------------------------------------------------- pickers de compromisso/lembrete
  function openEventPicker(anchor, p) {
    const wrap = el('div', 'pj-pop input col')
    wrap.innerHTML = `<input class="ev-title" type="text" placeholder="título do compromisso" value="${esc(p.name)}"><div id="evDate"></div>`
    const ds = dateSheet({ base: Date.now() + 3600000, onPick: async ({ ms }) => { const title = wrap.querySelector('.ev-title').value.trim() || p.name; const r = await post(`/api/projects/${p.id}/commit`, { title, startsAt: new Date(ms).toISOString() }); wrap.remove(); if (r && r.ok) { toast('Compromisso na agenda'); loadProjDetail(p.id) } else toast(r && r.error === 'agenda não conectada' ? 'conecte a Google Agenda primeiro' : 'não deu pra marcar', 'err') } })
    wrap.querySelector('#evDate').appendChild(ds)
    floatPop(anchor, wrap, true)
  }
  function openReminderPicker(anchor, p) {
    const wrap = el('div', 'pj-pop input col')
    wrap.innerHTML = `<input class="rem-title" type="text" placeholder="me lembra de…"><div id="remDate"></div><div class="pj-ds-rec-lbl">Repetir</div><div id="remRec" class="pj-chips"></div>`
    let recurrence = null
    const recHost = wrap.querySelector('#remRec')
    ;[['', 'uma vez'], ['daily', 'todo dia'], ['weekly', 'toda semana'], ['monthly', 'todo mês'], ['yearly', 'todo ano']].forEach(([k, l], i) => { const c = el('button', 'chip' + (i === 0 ? ' active' : ''), l); c.addEventListener('click', () => { recurrence = k || null; $$('.chip', recHost).forEach((x) => x.classList.toggle('active', x === c)) }); recHost.appendChild(c) })
    const ds = dateSheet({ base: Date.now() + 3600000, onPick: async ({ ms }) => { const text = wrap.querySelector('.rem-title').value.trim(); if (!text) { toast('escreva o lembrete', 'err'); return } const r = await post('/api/reminders', { projectId: p.id, text, at: ms, recurrence }); wrap.remove(); if (r && r.ok) { toast('Lembrete criado'); loadProjDetail(p.id) } } })
    wrap.querySelector('#remDate').appendChild(ds)
    floatPop(anchor, wrap, true)
    wrap.querySelector('.rem-title').focus()
  }

  // -------------------------------------------------- busca unificada de pessoas
  function openPeoplePicker(onPick, { excludeId = null, title = 'Adicionar pessoa' } = {}) {
    const ov = overlay()
    const sheet = el('div', 'pj-sheet tall')
    sheet.innerHTML = `<div class="pj-sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-x>${icon('i-x')}</button></div>
      <label class="pj-search"><svg class="ico" aria-hidden="true"><use href="#i-search"/></svg><input type="search" placeholder="buscar por nome, @ ou telefone" autocomplete="off"></label>
      <div id="ppResults" class="pj-pp-results"><div class="pj-empty-line">Digite pra buscar entre Tinder, WhatsApp e Instagram.</div></div>`
    ov.appendChild(sheet)
    sheet.querySelector('[data-x]').addEventListener('click', () => ov.remove())
    const inp = sheet.querySelector('input'); inp.focus()
    let req = 0
    inp.addEventListener('input', async () => {
      const q = inp.value.trim(); const mine = ++req
      if (q.length < 1) { $('#ppResults', sheet).replaceChildren(el('div', 'pj-empty-line', 'Digite pra buscar.')); return }
      const r = await api(`/api/people/search?q=${encodeURIComponent(q)}`)
      if (mine !== req) return
      const host = $('#ppResults', sheet); host.replaceChildren()
      const results = (r && r.results || []).filter((x) => x.personId !== excludeId)
      if (!results.length) { host.appendChild(el('div', 'pj-empty-line', 'Ninguém encontrado.')); return }
      results.forEach((x) => {
        const it = el('button', 'pj-pp-item')
        // Ícone por canal vem do mapa (CANAL_ICO), não de uma escada com o coração no fim:
        // Badoo com ícone do Tinder é a mesma mentira do canal fantasma.
        const chans = (x.channels || []).map((c) => icon(CANAL_ICO[c] || 'i-link', 'ico ico-sm')).join('')
        // Idade só quando ela EXISTE (Tinder e Badoo já guardam; WhatsApp e Instagram não
        // têm). Numa lista de "quem é a mesma pessoa", ela é o desempate mais rápido.
        const idade = x.idade ? `<span class="pj-idade">${esc(String(x.idade))}</span>` : ''
        it.innerHTML = `${avatarHtml(x.name, x.avatar, 'pj-ava')}<span class="pj-person-body"><b>${esc(x.name)}${idade}</b><small>${chans}${x.sub ? ' · ' + esc(x.sub) : ''}</small></span>`
        it.addEventListener('click', () => { ov.remove(); onPick(x.personId) })
        host.appendChild(it)
      })
    })
  }

  // ================================================================ IDENTIDADE DA PESSOA
  // "Quem é essa pessoa em cada rede" — aberto de dentro da conversa (WhatsApp ou Instagram),
  // que é onde você percebe que é a mesma pessoa. Antes isso só existia na aba Vínculos
  // (escolhendo duas pessoas do zero) e num menu dentro de Projetos (o dono, 25/07/2026).
  const CANAL_NOME = { whatsapp: 'WhatsApp', instagram: 'Instagram', tinder: 'Tinder', badoo: 'Badoo' }

  async function abrirIdentidade(personId, aoMudar) {
    const ov = overlay()
    const sheet = el('div', 'pj-sheet tall')
    sheet.innerHTML = `<div class="pj-sheet-head"><h2>${icon('i-link', 'ico ico-sm')} Mesma pessoa</h2><button class="icon-btn" data-x>${icon('i-x')}</button></div>
      <div id="idCorpo" class="pj-empty-line">carregando…</div>`
    ov.appendChild(sheet)
    sheet.querySelector('[data-x]').addEventListener('click', () => ov.remove())
    const fechar = () => { ov.remove(); if (typeof aoMudar === 'function') aoMudar() }

    const pintar = async () => {
      const d = await api(`/api/vinculos/pessoa?personId=${encodeURIComponent(personId)}`)
      const host = $('#idCorpo', sheet)
      if (!d) { host.textContent = 'Não consegui carregar.'; return }
      host.className = 'id-corpo'
      host.replaceChildren()

      const nomes = d.canais.map((c) => CANAL_NOME[c.channel] || c.channel)
      const intro = el('p', 'wc-aprov-intro', d.unificada
        ? `Esta pessoa é uma só no ${nomes.join(' e no ')}. A IA lê tudo como uma conversa só.`
        : 'Esta conversa está só no ' + (nomes[0] || 'canal atual') + '. Se você já fala com ela em outra rede, ligue aqui — a IA passa a ler tudo junto.')
      host.appendChild(intro)

      const lista = el('div', 'id-canais')
      d.canais.forEach((c) => {
        const item = el('div', 'id-canal' + (c.principal ? ' principal' : ''))
        item.innerHTML = `${avatarHtml(c.name, c.avatar, 'pj-ava')}
          <span class="pj-person-body">
            <b>${esc(c.name || 'conversa')}${c.principal && c.escolhivel ? '<span class="id-selo">recebe as mensagens</span>' : ''}</b>
            <small>${icon(CANAL_ICO[c.channel] || 'i-link', 'ico ico-sm')} ${esc(CANAL_NOME[c.channel] || c.channel)}${c.sub ? ' · ' + esc(c.sub) : ''} · ${c.mensagens} mensagem${c.mensagens === 1 ? '' : 's'}</small>
          </span>`
        const acoes = el('span', 'id-canal-acoes')
        // Quando a pessoa tem DOIS do mesmo canal (número antigo + atual, ou dois chips),
        // é preciso dizer em qual a IA escreve. Os dois continuam vinculados: a memória lê
        // os dois, o envio vai só pro escolhido.
        if (c.escolhivel && !c.principal) {
          const usar = el('button', 'btn ghost small', 'Usar este')
          usar.type = 'button'
          usar.title = 'A IA passa a escrever neste'
          usar.addEventListener('click', async () => {
            const r = await post('/api/vinculos/principal', { personId: c.personId, canal: c.channel, alvo: c.alvo })
            if (r && r.ok) { toast('A IA passa a escrever neste'); pintar(); if (typeof aoMudar === 'function') aoMudar() }
            else toast('Não consegui mudar', 'err')
          })
          acoes.appendChild(usar)
        }
        // X por rede: tira SÓ aquela conversa da pessoa, as outras continuam.
        if (c.removivel) {
          const x = el('button', 'id-canal-x', '×')
          x.type = 'button'
          x.title = `Tirar ${CANAL_NOME[c.channel] || c.channel} desta pessoa`
          x.setAttribute('aria-label', `Tirar ${CANAL_NOME[c.channel] || c.channel} desta pessoa`)
          x.addEventListener('click', (e) => confirmDestructive(e.currentTarget, 'Tirar', async () => {
            const corpo = c.tipo === 'alias' ? { aliasId: c.personId } : { canal: c.channel, alvo: c.alvo }
            const r = await post('/api/vinculos/desligar', corpo)
            if (r && r.ok) { toast('Rede separada desta pessoa'); pintar(); if (typeof aoMudar === 'function') aoMudar() }
            else toast('Não consegui separar', 'err')
          }))
          acoes.appendChild(x)
        }
        item.appendChild(acoes)
        lista.appendChild(item)
      })
      host.appendChild(lista)
      // Duas conversas do mesmo canal é situação normal, não erro: vale explicar.
      const repetidos = [...new Set(d.canais.map((c) => c.channel).filter((ch, i, arr) => arr.indexOf(ch) !== i))]
      if (repetidos.length) {
        host.appendChild(el('p', 'id-nota', `Ela tem mais de um ${repetidos.map((r) => CANAL_NOME[r] || r).join(' e mais de um ')}. A IA lê todos, e escreve no que estiver marcado.`))
      }

      const acoes = el('div', 'vinc-acoes')
      const ligar = el('button', 'btn small', `${icon('i-link', 'ico ico-sm')} É a mesma pessoa de…`)
      ligar.addEventListener('click', () => {
        openPeoplePicker(async (outroId) => {
          const r = await post('/api/vinculos/ligar', { primaryId: d.canonico, secondaryId: outroId })
          if (r && r.ok) { toast('Pronto — agora é uma pessoa só'); pintar(); if (typeof aoMudar === 'function') aoMudar() }
          else toast('Não consegui unificar', 'err')
        }, { excludeId: d.canonico, title: 'Quem é a mesma pessoa?' })
      })
      acoes.appendChild(ligar)
      if (d.unificada && d.mergeId) {
        const desfazer = el('button', 'btn ghost small danger', 'Separar de novo')
        desfazer.addEventListener('click', (e) => confirmDestructive(e.currentTarget, 'Confirmar', async () => {
          const r = await post('/api/vinculos/desligar', { mergeId: d.mergeId })
          if (r && r.ok) { toast('Separadas'); pintar(); if (typeof aoMudar === 'function') aoMudar() }
          else toast('Não consegui separar', 'err')
        }))
        acoes.appendChild(desfazer)
      }
      host.appendChild(acoes)
    }
    await pintar()
    return fechar
  }

  // ================================================================ ABA VÍNCULOS
  // Quem é a mesma pessoa em canais diferentes. Quatro listas (revisar / ativos / frios /
  // chamadas), os interruptores do "chamar primeiro" e a edição manual por autofill.
  // Contrato: docs/PLANO-IDENTIDADE-VINCULO.md §2.7 e §2.8.
  // a aba abre na lista de PESSOAS: é a gestão de gente, não a fila de pendências
  const VINC = { aba: 'pessoas', dados: null }

  const CANAL_ICO = { whatsapp: 'i-wa', instagram: 'i-ig', tinder: 'i-heart', badoo: 'i-badoo' }

  // O elo: duas bolinhas, uma por rede, ligadas por um fio. É o vínculo inteiro dito de
  // relance — quem olha entende "essa pessoa do Tinder é essa conversa do WhatsApp" sem ler
  // uma linha de texto. Tem rótulo pra leitor de tela, porque cor e ícone sozinhos não falam.
  function redeBolinha(canal) {
    return `<span class="rede-bolinha canal-${esc(canal || 'x')}">${icon(CANAL_ICO[canal] || 'i-link', 'ico ico-sm')}</span>`
  }
  function eloHtml(origem, destino) {
    const nomeA = CANAL_NOME[origem] || origem || 'rede'
    const nomeB = CANAL_NOME[destino] || destino || 'rede'
    return `<span class="vl-elo" role="img" aria-label="${esc(nomeA)} ligado ao ${esc(nomeB)}" title="${esc(nomeA)} ligado ao ${esc(nomeB)}">${redeBolinha(origem)}<i class="vl-fio" aria-hidden="true"></i>${redeBolinha(destino)}</span>`
  }

  // As caras da pessoa em cada rede, lado a lado, cada uma com o selo de onde veio. Duas
  // fotos com selo dizem "essa daqui é essa dali" mais rápido que qualquer legenda — e é o
  // vínculo inteiro visível sem abrir. Sobrepõe de leve de propósito: é a mesma pessoa.
  function carasDasRedes(nome, redes) {
    const lista = (redes || []).filter(Boolean)
    if (!lista.length) return avatarHtml(nome, null, 'vinc-av')
    const rotulo = lista.map((r) => r.nome || CANAL_NOME[r.canal] || r.canal).join(' e ')
    // o fio entre as caras é o que diz "ligadas". Sobrepor as fotos escondia o selo de
    // quem estava atrás, e o selo é justamente a informação de qual rede é qual.
    return `<span class="vl-caras" role="img" aria-label="A mesma pessoa no ${esc(rotulo)}" title="A mesma pessoa no ${esc(rotulo)}">${
      lista.map((r) => `<span class="vl-cara">${avatarHtml(nome, r.foto, 'vinc-av')}<i class="vl-selo canal-${esc(r.canal)}">${icon(CANAL_ICO[r.canal] || 'i-link', 'ico')}</i></span>`)
        .join('<i class="vl-fio" aria-hidden="true"></i>')
    }</span>`
  }
  const ESTADO_ROTULO = {
    confirmado_conversa: 'conversa acontecendo',
    confirmado_servidor: 'confirmado, sem conversa ainda',
    frio: 'nunca virou conversa',
    ambiguo: 'ambíguo',
    candidato: 'candidato',
    rejeitado: 'rejeitado',
    indefinido: 'sem estado',
  }

  async function loadVinculos() {
    const host = $('#vincHost')
    if (!host.dataset.loaded) host.innerHTML = '<div class="pj-empty-line">Carregando…</div>'
    const [d, u, ini] = await Promise.all([api('/api/vinculos'), api('/api/self/uniao'), api('/api/iniciativas')])
    if (!d) { host.innerHTML = '<div class="pj-empty-line">Não consegui carregar os vínculos.</div>'; return }
    VINC.dados = d
    VINC.uniao = (u && u.sugestoes) || []
    VINC.iniciativas = (ini && ini.iniciativas) || []
    VINC.iniciativasOn = !ini || ini.enabled !== false
    host.dataset.loaded = '1'
    renderVinculos()
    atualizaBadgeVinculos(d)
  }

  function atualizaBadgeVinculos(d) {
    const b = $('#tabVinculos')
    if (!b) return
    const n = ((d && d.contagem && d.contagem.revisar) || 0) + ((VINC.uniao && VINC.uniao.length) || 0) + ((VINC.iniciativas && VINC.iniciativas.length) || 0)
    b.hidden = !n
    b.textContent = String(n)
  }

  function renderVinculos() {
    const d = VINC.dados
    if (!d) return
    const host = $('#vincHost')
    host.replaceChildren()

    // ------- interruptores do chamar primeiro
    // O canal não é escolha sua: é o que ELA passou. Então é UM interruptor ("chamar em
    // outras redes") + a lista de redes que o vendas-multicanal pode usar + quem está autorizado.
    // Antes eram dois interruptores por canal, e quem passasse só o Instagram com o
    // Instagram desligado não era chamada, em silêncio (correção do dono, 25/07/2026).
    const redes = d.redes || []
    const auto = el('section', 'vinc-auto')
    auto.innerHTML = `
      <label class="vinc-auto-row mestre">
        <span><b>Chamar em outras redes</b><small>ela passou o contato no Tinder, o vendas-multicanal abre a conversa lá — com a memória da conversa</small></span>
        <button class="toggle" role="switch" aria-checked="${d.chamar ? 'true' : 'false'}" aria-label="Chamar em outras redes" data-chamar></button>
      </label>
      <div class="vinc-sub ${d.chamar ? '' : 'apagado'}">
        <div class="vinc-auto-head"><b>Redes autorizadas</b><small>o vendas-multicanal usa a rede que ela passou, se estiver autorizada aqui</small></div>
        <div class="vinc-auto-rows">
          <label class="vinc-auto-row">
            <span>${icon('i-wa', 'ico ico-sm')} WhatsApp</span>
            <button class="toggle sm" role="switch" aria-checked="${redes.includes('whatsapp') ? 'true' : 'false'}" aria-label="Autorizar o WhatsApp" data-rede="whatsapp"></button>
          </label>
          <label class="vinc-auto-row">
            <span>${icon('i-ig', 'ico ico-sm')} Instagram</span>
            <button class="toggle sm" role="switch" aria-checked="${redes.includes('instagram') ? 'true' : 'false'}" aria-label="Autorizar o Instagram" data-rede="instagram"></button>
          </label>
        </div>
        <label class="vinc-auto-row larga">
          <span>${icon('i-spark', 'ico ico-sm')} Chamar qualquer pessoa que vier do Tinder</span>
          <button class="toggle sm" role="switch" aria-checked="${d.autorizaTodos ? 'true' : 'false'}" aria-label="Chamar qualquer pessoa que vier do Tinder" data-autotodos></button>
        </label>
        <p class="vinc-auto-nota">Desligado, só sai pra quem você autorizar uma a uma na lista abaixo. Ligado ou não, as travas continuam: o número tem que conferir com o que ela escreveu, e é uma vez só por pessoa.</p>
      </div>`
    const mexer = async (btn, corpo, msgOn, msgOff) => {
      const ligado = btn.getAttribute('aria-checked') !== 'true'
      btn.setAttribute('aria-checked', String(ligado))
      const r = await post('/api/vinculos/auto', { ...corpo, ...(corpo.chamar !== undefined ? { chamar: ligado } : { ligado, ...(corpo.todos !== undefined ? { todos: ligado } : {}) }) })
      if (!r || !r.ok) { btn.setAttribute('aria-checked', String(!ligado)); toast('Não consegui mudar', 'err'); return }
      toast(ligado ? msgOn : msgOff)
      loadVinculos()
    }
    const mestre = auto.querySelector('[data-chamar]')
    if (mestre) mestre.addEventListener('click', () => mexer(mestre, { chamar: true },
      'Ligado — vou chamar nas redes autorizadas', 'Desligado — não chamo ninguém sozinho'))
    auto.querySelectorAll('[data-rede]').forEach((btn) => btn.addEventListener('click', () => {
      const rede = btn.dataset.rede
      mexer(btn, { rede }, `${rede === 'whatsapp' ? 'WhatsApp' : 'Instagram'} autorizado`, `${rede === 'whatsapp' ? 'WhatsApp' : 'Instagram'} fora`)
    }))
    const todos = auto.querySelector('[data-autotodos]')
    if (todos) todos.addEventListener('click', () => mexer(todos, { todos: true },
      'Vou chamar qualquer pessoa que vier do Tinder', 'Voltou a pedir autorização por pessoa'))
    // Os interruptores do "chamar primeiro" são sobre a FILA de chamadas, não sobre a lista
    // de gente. Na aba Pessoas eles só empurravam a lista pra fora da tela, então ficam nas
    // sub-abas onde importam.
    if (VINC.aba !== 'pessoas') host.appendChild(auto)

    // ------- barra de ações
    const barra = el('div', 'vinc-bar')
    barra.innerHTML = `
      <div class="pj-seg" role="tablist">
        ${[['pessoas', 'Pessoas', 0], ['iniciativas', 'Iniciativas', (VINC.iniciativas || []).length], ['revisar', 'Pra revisar', (d.contagem.revisar || 0) + ((VINC.uniao && VINC.uniao.length) || 0)], ['ativos', 'Ativos', d.contagem.ativos], ['frios', 'Frios', d.contagem.frios], ['chamadas', 'Chamadas', d.contagem.chamadas]]
        .map(([k, rot, n]) => `<button role="tab" data-vaba="${k}" class="${VINC.aba === k ? 'active' : ''}" aria-selected="${VINC.aba === k}">${rot}${n ? ` <span class="vinc-cnt">${n}</span>` : ''}</button>`).join('')}
      </div>
      <div class="vinc-bar-acoes">
        <button class="btn ghost small" id="vincLigar">${icon('i-link', 'ico ico-sm')} Ligar duas pessoas</button>
        <button class="btn ghost small" id="vincResolver">${icon('i-sync', 'ico ico-sm')} Procurar vínculos agora</button>
      </div>`
    barra.querySelectorAll('[data-vaba]').forEach((b) => b.addEventListener('click', () => { VINC.aba = b.dataset.vaba; renderVinculos() }))
    barra.querySelector('#vincResolver').addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Procurando…'
      const r = await post('/api/vinculos/resolver', { limite: 60 })
      const res = r && r.resultado
      const uni = await post('/api/self/uniao/procurar', {})
      toast(res ? `${res.vinculados || 0} vinculados, ${res.ambiguos || 0} pra revisar${uni && uni.propostas ? `, ${uni.propostas} possível(is) mesma pessoa` : ''}` : 'Nada novo')
      loadVinculos()
    })
    barra.querySelector('#vincLigar').addEventListener('click', () => abrirLigarManual())
    host.appendChild(barra)

    const lista = el('div', 'vinc-lista')
    host.appendChild(lista)
    if (VINC.aba === 'pessoas') renderPessoas(lista)
    else if (VINC.aba === 'iniciativas') renderIniciativas(lista)
    else if (VINC.aba === 'revisar') renderRevisar(lista, d)
    else if (VINC.aba === 'ativos') renderVinculoCards(lista, d.ativos, 'Nenhum vínculo com conversa ainda.')
    else if (VINC.aba === 'frios') renderVinculoCards(lista, d.frios, 'Nenhum vínculo parado. Ótimo sinal.')
    else renderChamadas(lista, d.chamadas)
  }

  // ================================================================ PESSOAS (central de identidades)
  // Toda pessoa que existe no sistema, com os aliases já somados: as caras dela em cada rede,
  // o peso da conversa, e — dentro da linha — o que a IA lembra dela. A memória morava na
  // Config, longe de quem ela descreve; gestão de pessoas é aqui (decisão do dono, 26/07/2026).
  const PESS = { q: '', canal: '', filtro: '', dados: null, abertas: new Set() }

  function renderPessoas(host) {
    const barra = el('div', 'pss-barra')
    const r = (PESS.dados && PESS.dados.resumo) || { total: 0, unificadas: 0, comIa: 0, porCanal: {}, chamar: {} }
    barra.innerHTML = `
      <label class="pss-busca">${icon('i-search', 'ico ico-sm')}
        <input type="search" id="pssQ" placeholder="Buscar por nome, telefone ou @" autocomplete="off" value="${esc(PESS.q)}">
      </label>
      <div class="pss-chips">
        ${[['', 'Todas', r.total], ['tinder', 'Tinder', r.porCanal.tinder || 0], ['whatsapp', 'WhatsApp', r.porCanal.whatsapp || 0], ['instagram', 'Instagram', r.porCanal.instagram || 0], ['badoo', 'Badoo', r.porCanal.badoo || 0]]
          .map(([k, rot, n]) => `<button type="button" class="pss-chip${PESS.canal === k && !PESS.filtro ? ' on' : ''}" data-canal="${k}">${rot}${n ? ` <i>${n}</i>` : ''}</button>`).join('')}
        <button type="button" class="pss-chip${PESS.filtro === 'unificadas' ? ' on' : ''}" data-filtro="unificadas">Unificadas${r.unificadas ? ` <i>${r.unificadas}</i>` : ''}</button>
        <button type="button" class="pss-chip${PESS.filtro === 'ia' ? ' on' : ''}" data-filtro="ia">Com IA${r.comIa ? ` <i>${r.comIa}</i>` : ''}</button>
        <button type="button" class="pss-chip${PESS.filtro === 'chamar' ? ' on' : ''}" data-filtro="chamar">Chamar${r.chamar?.ligadas ? ` <i>${r.chamar.ligadas}</i>` : ''}</button>
      </div>
      <div class="pss-mem-acoes">
        <label class="vinc-autoriza"><span>memória em dia sozinha</span><button type="button" class="toggle sm" id="pssAuto" role="switch" aria-checked="true" aria-label="Manter a memória em dia sozinha"></button></label>
        <button type="button" class="btn ghost small" id="pssConstruir">${icon('i-spark', 'ico ico-sm')} Construir memórias</button>
      </div>`
    host.appendChild(barra)
    const resumoChamar = el('section', 'pss-call-resumo')
    resumoChamar.id = 'pssCallResumo'
    host.appendChild(resumoChamar)
    const listaHost = el('div', 'pss-lista')
    listaHost.id = 'pssLista'
    host.appendChild(listaHost)
    pintarResumoChamar(r)

    const busca = barra.querySelector('#pssQ')
    let tmr = null
    busca.addEventListener('input', () => {
      clearTimeout(tmr)
      tmr = setTimeout(() => { PESS.q = busca.value.trim(); carregarPessoas() }, 250)
    })
    barra.querySelectorAll('[data-canal]').forEach((b) => b.addEventListener('click', () => {
      PESS.canal = b.dataset.canal; PESS.filtro = ''; carregarPessoas()
    }))
    barra.querySelectorAll('[data-filtro]').forEach((b) => b.addEventListener('click', () => {
      PESS.filtro = PESS.filtro === b.dataset.filtro ? '' : b.dataset.filtro; PESS.canal = ''; carregarPessoas()
    }))
    barra.querySelector('#pssConstruir').addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Construindo…'
      const rr = await post('/api/self/memoria/consolidar', { limite: 20 })
      if (!rr || !rr.ok) { btn.disabled = false; btn.textContent = 'Construir memórias'; toast((rr && rr.error) || 'Não deu pra começar', 'err'); return }
      toast('Construindo a memória em segundo plano')
    })
    const tg = barra.querySelector('#pssAuto')
    api('/api/self/memoria').then((m) => { if (m) tg.setAttribute('aria-checked', m.auto === false ? 'false' : 'true') })
    tg.addEventListener('click', async () => {
      const next = tg.getAttribute('aria-checked') !== 'true'
      const rr = await post('/api/self/memoria/auto', { enabled: next })
      if (rr && rr.ok) { tg.setAttribute('aria-checked', rr.auto ? 'true' : 'false'); toast(rr.auto ? 'A memória se mantém sozinha' : 'A memória só atualiza quando você mandar') }
    })
    carregarPessoas()
  }

  async function carregarPessoas() {
    const host = $('#pssLista')
    if (!host) return
    host.replaceChildren(el('div', 'wc-loading', `${icon('i-users', 'ico')}<span>carregando pessoas…</span>`))
    const qs = new URLSearchParams()
    if (PESS.q) qs.set('q', PESS.q)
    if (PESS.canal) qs.set('canal', PESS.canal)
    if (PESS.filtro) qs.set('filtro', PESS.filtro)
    const d = await api('/api/pessoas?' + qs.toString())
    if (!$('#pssLista')) return
    PESS.dados = d
    pintarResumoChamar(d && d.resumo ? d.resumo : null)
    if (!d || !d.pessoas) { host.replaceChildren(emptyState('i-users', 'Não deu pra listar', 'O vendas-multicanal não devolveu as pessoas agora.')); return }
    if (!d.pessoas.length) { host.replaceChildren(emptyState('i-search', 'Ninguém encontrado', 'Nenhuma pessoa bate com esse filtro.')); return }
    const frag = document.createDocumentFragment()
    d.pessoas.forEach((x) => frag.appendChild(linhaPessoa(x)))
    if (d.encontradas > d.pessoas.length) {
      frag.appendChild(el('p', 'pss-mais', `mostrando ${d.pessoas.length} de ${d.encontradas} — refine a busca pra ver o resto`))
    }
    host.replaceChildren(frag)
    pintarContagensDosChips(d.resumo)
  }

  // Os contadores dos chips descrevem o conjunto INTEIRO e chegam junto com a primeira
  // resposta — depois de a barra já estar desenhada. Sem pintar aqui, os filtros ficam sem
  // número pra sempre (a barra não se redesenha a cada busca, senão o campo perderia o foco).
  function pintarContagensDosChips(resumo) {
    if (!resumo) return
    const num = { '': resumo.total, unificadas: resumo.unificadas, ia: resumo.comIa, chamar: resumo.chamar?.ligadas || 0, ...resumo.porCanal }
    $$('.pss-chip').forEach((b) => {
      const chave = b.dataset.filtro || b.dataset.canal || ''
      const n = num[chave] || 0
      const alvo = b.querySelector('i')
      if (!n) { if (alvo) alvo.remove(); return }
      if (alvo) alvo.textContent = String(n)
      else b.insertAdjacentHTML('beforeend', ` <i>${n}</i>`)
    })
  }

  function pintarResumoChamar(resumo) {
    const host = $('#pssCallResumo')
    if (!host) return
    const ch = (resumo && resumo.chamar) || {
      ligadas: 0, manuais: 0, automaticas: 0, comHistorico: 0,
      tentativas: 0, avaliadas: 0, certas: 0, erradas: 0, pendentes: 0,
    }
    const pctCerto = ch.avaliadas ? Math.round((ch.certas / ch.avaliadas) * 100) : null
    const pctErrado = ch.avaliadas ? Math.round((ch.erradas / ch.avaliadas) * 100) : null
    host.innerHTML = `
      <div class="pss-call-card${ch.ligadas ? '' : ' vazio'}">
        <div class="pss-call-card-head">
          <div>
            <b>${icon('i-link', 'ico ico-sm')} Chamadas em outra rede</b>
            <small>${ch.ligadas
              ? `${ch.ligadas} pessoa(s) estão ligadas para o "chamar em outras redes"`
              : 'Nenhuma pessoa está ligada agora para o "chamar em outras redes"'}</small>
          </div>
          ${ch.comHistorico ? `<span class="pss-call-pill">${ch.comHistorico} com histórico</span>` : ''}
        </div>
        <div class="pss-call-grid">
          <div><b>${ch.ligadas}</b><span>ligadas</span></div>
          <div><b>${ch.tentativas}</b><span>tentativas</span></div>
          <div><b>${ch.certas}</b><span>certas</span></div>
          <div><b>${ch.erradas}</b><span>erradas</span></div>
        </div>
        <div class="pss-call-rates">
          <span class="ok">Certo <b>${pctCerto == null ? '—' : pctCerto + '%'}</b></span>
          <span class="erro">Errado <b>${pctErrado == null ? '—' : pctErrado + '%'}</b></span>
          <span>Sem veredito <b>${ch.pendentes}</b></span>
        </div>
        <p class="pss-call-note">As taxas usam só as ${ch.avaliadas} tentativa(s) que você já marcou.${ch.manuais || ch.automaticas
          ? ` ${ch.manuais ? `${ch.manuais} ligada(s) na mão` : ''}${ch.manuais && ch.automaticas ? ' · ' : ''}${ch.automaticas ? `${ch.automaticas} entram pelo "chamar qualquer pessoa que vier do Tinder"` : ''}.`
          : ''}</p>
      </div>`
  }

  function linhaPessoa(x) {
    const c = el('article', 'vinc-linha')
    const cabeca = el('button', 'vl-head')
    cabeca.type = 'button'
    cabeca.setAttribute('aria-expanded', 'false')
    cabeca.innerHTML = `
      ${carasDasRedes(x.nome, x.redes)}
      <span class="vl-nome">${esc(x.nome)}</span>
      ${x.vinculo ? `<span class="pss-vinc-tag${x.vinculo.padrao ? ' padrao' : ''}">${esc(x.vinculo.label)}</span>` : ''}
      ${x.iaLigada && x.iaLigada.length ? `<span class="pss-ia">${icon('i-bot', 'ico ico-sm')} IA</span>` : ''}
      ${x.chamar && x.chamar.ligada ? `<span class="pss-call-tag${x.chamar.herdada ? ' auto' : ''}">${x.chamar.herdada ? 'chamar geral' : 'chamar ligada'}</span>` : ''}
      ${x.chamar && x.chamar.tentativas ? `<span class="pss-call-mini">${x.chamar.tentativas} chamada${x.chamar.tentativas === 1 ? '' : 's'}${x.chamar.avaliadas ? ` · ${x.chamar.pctCerto}% certo` : x.chamar.pendentes ? ' · sem veredito' : ''}</span>` : ''}
      <span class="vl-meta">${x.mensagens} msg${x.ultima ? ' · ' + esc(timeAgo(x.ultima)) : ''}</span>
      ${icon('i-arrow-r', 'ico ico-sm vl-chev')}`
    const corpo = el('div', 'vl-corpo')
    corpo.hidden = true
    c.append(cabeca, corpo)
    cabeca.addEventListener('click', () => {
      const abrindo = corpo.hidden
      corpo.hidden = !abrindo
      cabeca.setAttribute('aria-expanded', String(abrindo))
      c.classList.toggle('aberta', abrindo)
      if (abrindo) abrirPessoa(x, corpo)
    })
    return c
  }

  function blocoChamarPessoa(x) {
    const c = x.chamar
    if (!c || (!c.ligada && !c.tentativas)) return null
    const taxas = c.avaliadas ? `Taxas sobre ${c.avaliadas} tentativa(s) que você já marcou.` : 'Sem veredito marcado ainda.'
    const canais = []
    if (c.porCanal?.whatsapp) canais.push(`WhatsApp ${c.porCanal.whatsapp}`)
    if (c.porCanal?.instagram) canais.push(`Instagram ${c.porCanal.instagram}`)
    const estado = c.ligada
      ? (c.herdada ? 'ligada pelo "chamar qualquer pessoa que vier do Tinder"' : 'ligada nesta pessoa')
      : 'hoje desligada nesta pessoa'
    const bloco = el('div', 'pss-call-bloco')
    bloco.innerHTML = `
      <div class="pss-call-head">
        <b>${icon('i-link', 'ico ico-sm')} Chamadas em outra rede</b>
        <span class="pss-call-state ${c.ligada ? 'on' : 'off'}${c.herdada ? ' auto' : ''}">${esc(estado)}</span>
      </div>
      <div class="pss-call-grid">
        <div><b>${c.tentativas}</b><span>tentativas</span></div>
        <div><b>${c.certas}</b><span>certas</span></div>
        <div><b>${c.erradas}</b><span>erradas</span></div>
        <div><b>${c.pendentes}</b><span>sem veredito</span></div>
      </div>
      <div class="pss-call-rates">
        <span class="ok">Certo <b>${c.pctCerto == null ? '—' : c.pctCerto + '%'}</b></span>
        <span class="erro">Errado <b>${c.pctErrado == null ? '—' : c.pctErrado + '%'}</b></span>
        ${c.ultimaTentativa ? `<span>Última <b>${esc(timeAgo(c.ultimaTentativa))}</b></span>` : ''}
      </div>
      <p class="pss-call-note">${taxas}${canais.length ? ' Canais: ' + canais.join(' · ') + '.' : ''}</p>`
    return bloco
  }

  // O detalhe só é montado quando abre: são 1029 pessoas, e a memória de cada uma é uma
  // consulta própria. Carregar tudo de véspera seria mil requisições pra ler uma.
  async function abrirPessoa(x, corpo) {
    corpo.replaceChildren(el('div', 'wc-loading', `<span class="spin"></span><span>abrindo…</span>`))
    const mem = await api(`/api/self/memoria?personId=${encodeURIComponent(x.personId)}`)
    const redes = el('div', 'vl-pontas')
    redes.innerHTML = x.redes.map((r) => `
      <div class="vl-ponta">${avatarHtml(x.nome, r.foto, 'vinc-av-sm')}
        <div><b>${esc(r.nome)}</b><small>${r.identificador ? esc(r.identificador) + ' · ' : ''}${r.mensagens} msg</small></div>
        <span class="rede-bolinha canal-${esc(r.canal)}">${icon(CANAL_ICO[r.canal] || 'i-link', 'ico ico-sm')}</span>
      </div>`).join('')

    const bloco = el('div', 'pss-mem-bloco')
    const m = mem && mem.memoria
    bloco.innerHTML = `
      <div class="pss-mem-head"><b>${icon('i-bot', 'ico ico-sm')} O que a IA lembra dela</b>
        ${m ? `<small>versão ${m.versao || 1} · leu ${m.msgs_lidas || 0} de ${m.total_msgs || 0}${mem.novas ? ` · ${mem.novas} nova(s) desde então` : ''}</small>` : ''}
      </div>
      ${m ? `<p class="pss-mem-txt">${esc(m.resumo || '')}</p>` : '<p class="vinc-sem-prova">A IA ainda não guardou nada sobre essa pessoa.</p>'}
      ${m && m.combinados ? `<p class="pss-mem-pend">${icon('i-target', 'ico ico-sm')} em aberto: ${esc(m.combinados)}</p>` : ''}
      <div class="vinc-acoes">
        <button class="btn ghost small" data-mem-up>${icon('i-sync', 'ico ico-sm')} ${m ? 'Atualizar memória' : 'Construir agora'}</button>
        ${m ? '<button class="btn ghost small danger" data-mem-x>Esquecer</button>' : ''}
        <button class="btn ghost small" data-ident>${icon('i-link', 'ico ico-sm')} Mesma pessoa</button>
      </div>`
    bloco.querySelector('[data-mem-up]').addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Lendo as conversas…'
      const rr = await post('/api/self/memoria/consolidar', { personId: x.personId })
      if (!rr || rr.error) { btn.disabled = false; btn.textContent = 'Atualizar memória'; toast((rr && rr.error) || 'Não deu', 'err'); return }
      toast('Memória atualizada')
      abrirPessoa(x, corpo)
    })
    const bx = bloco.querySelector('[data-mem-x]')
    if (bx) bx.addEventListener('click', (e) => confirmDestructive(e.currentTarget, 'Esquecer', async () => {
      await del(`/api/self/memoria?personId=${encodeURIComponent(x.personId)}`)
      toast(`esqueci o que eu sabia de ${x.nome}`)
      abrirPessoa(x, corpo)
    }))
    bloco.querySelector('[data-ident]').addEventListener('click', () => abrirIdentidade(x.personId, () => carregarPessoas()))

    // Vínculo: quem ela É pro dono. É da PESSOA (uma linha por pessoa, gravada no id
    // canônico e lida por todos os ids dela), então mora na ficha, não na conversa — e é
    // trocável aqui pelo mesmo catálogo único do menu das threads.
    const vincWrap = el('div', 'pss-vinc-wrap')
    const pintarVinc = () => {
      const v = x.vinculo
      vincWrap.replaceChildren()
      const chip = el('button', 'pss-vinc-btn' + (v ? '' : ' vazio'))
      chip.type = 'button'
      chip.setAttribute('aria-haspopup', 'menu')
      chip.innerHTML = `${icon('i-link', 'ico ico-sm')}<span>${v ? esc(v.label) : 'Sem vínculo'}</span>${v && v.padrao ? '<small>veio do Tinder</small>' : ''}${icon('i-arrow-r', 'ico ico-sm chev')}`
      chip.addEventListener('click', (e) => {
        e.stopPropagation()
        abrirMenuVinculoPessoa(vincWrap, chip, x.personId, (valor, label) => {
          x.vinculo = valor ? { valor, label, padrao: false } : null
          pintarVinc()
          carregarPessoas()
        })
      })
      vincWrap.appendChild(chip)
    }
    pintarVinc()

    // interruptor da IA por canal: é por pessoa E por canal, e nasce desligado
    const ias = el('div', 'pss-ias')
    ias.innerHTML = x.redes.map((r) => `
      <label class="vinc-autoriza">
        <span>${icon(CANAL_ICO[r.canal] || 'i-link', 'ico ico-sm')} IA no ${esc(r.nome)}</span>
        <button type="button" class="toggle sm" role="switch" aria-checked="${(x.iaLigada || []).includes(r.canal) ? 'true' : 'false'}" aria-label="IA responde no ${esc(r.nome)}" data-ia="${esc(r.canal)}"></button>
      </label>`).join('')
    ias.querySelectorAll('[data-ia]').forEach((b) => b.addEventListener('click', async () => {
      const canal = b.dataset.ia
      const ligado = b.getAttribute('aria-checked') !== 'true'
      b.setAttribute('aria-checked', String(ligado))
      const rr = await post(`/api/person/${encodeURIComponent(x.personId)}/ai`, { channel: canal, enabled: ligado })
      if (!rr || !rr.ok) { b.setAttribute('aria-checked', String(!ligado)); toast('Não deu pra mudar', 'err'); return }
      const set = new Set(x.iaLigada || [])
      ligado ? set.add(canal) : set.delete(canal)
      x.iaLigada = [...set]
      toast(ligado ? `IA vai responder no ${CANAL_NOME[canal] || canal}` : `IA desligada no ${CANAL_NOME[canal] || canal}`)
    }))
    // QUAIS NECESSIDADES VALEM PRA ELA. Camada 2 do "quem pode ouvir": o tipo dela decide o
    // padrão, e aqui dá pra abrir ou fechar caso a caso — a válvula pro caso que a regra
    // geral nunca cobre. Fica DEPOIS do vínculo de propósito: é ele que define o padrão que
    // esta lista mostra herdado.
    const necBloco = el('div', 'pss-nec')
    necBloco.innerHTML = `<div class="pss-nec-head"><b>${icon('i-target', 'ico ico-sm')} Necessidades com esta pessoa</b><small>carregando…</small></div>`
    pintarNecessidadesDaPessoa(necBloco, x.personId)

    const chamarBloco = blocoChamarPessoa(x)
    corpo.replaceChildren(...[redes, chamarBloco, vincWrap, ias, necBloco, bloco].filter(Boolean))
  }

  // A lista de necessidades desta pessoa, com o estado já resolvido pelo servidor: o que o
  // TIPO dela permite (o padrão herdado) e o que foi decidido só pra ela.
  async function pintarNecessidadesDaPessoa(host, personId) {
    const d = await api(`/api/necessidades/por-pessoa?personId=${encodeURIComponent(personId)}`)
    const itens = (d && d.itens) || []
    const tipoLabel = d && d.tipo
      ? ((CATALOGO_VINC.find((c) => c.valor === d.tipo) || {}).label || d.tipo)
      : null
    host.replaceChildren()
    const head = el('div', 'pss-nec-head', `<b>${icon('i-target', 'ico ico-sm')} Necessidades com esta pessoa</b>`)
    head.appendChild(el('small', '', itens.length
      ? (tipoLabel ? `o padrão vem do vínculo: ${esc(tipoLabel)} · o pedido único só sai depois da sua confirmação` : 'sem vínculo definido — o pedido único só sai depois da sua confirmação')
      : 'nenhuma necessidade aberta'))
    host.appendChild(head)
    if (!itens.length) return

    for (const n of itens) {
      const linha = el('div', `pss-nec-item${n.vale ? '' : ' fora'}`)
      linha.appendChild(el('div', 'pss-nec-txt', `<b>${esc(n.descricao)}</b><small>${
        n.estado === 'padrao'
          ? (n.peloTipo ? 'pelo tipo dela: pode' : 'pelo tipo dela: não')
          : n.estado === 'sim' ? 'liberada só pra ela' : 'bloqueada só pra ela'
      }</small>`))
      // Três estados explícitos, sem estado escondido: "padrão" mostra o que ela herda, e
      // sim/não são decisões dela. Um interruptor de dois estados esconderia de onde veio o
      // valor — e é justamente isso que se quer enxergar aqui.
      const seg = el('div', 'pss-nec-seg')
      for (const [valor, rot] of [['padrao', 'padrão'], ['sim', 'sim'], ['nao', 'não']]) {
        const b = el('button', `pss-nec-op${n.estado === valor ? ' on' : ''}`, rot)
        b.type = 'button'
        b.addEventListener('click', async () => {
          const r = await post('/api/necessidades/pessoa', { id: n.id, personId, estado: valor })
          if (!r?.ok) { toast(r?.erro || 'Não deu pra salvar.', 'err'); return }
          toast(valor === 'padrao' ? 'Voltou pro padrão do tipo' : valor === 'sim' ? 'Liberada pra ela' : 'Bloqueada pra ela')
          pintarNecessidadesDaPessoa(host, personId)
        })
        seg.appendChild(b)
      }
      linha.appendChild(seg)

      // PEDIDO ÚNICO: ao contrário do seletor acima (que só deixa a IA SABER do assunto),
      // este botão enfileira uma fala obrigatória para a próxima resposta automática. O
      // estado fica visível e cancelável; envio confirmado vira comprovante, não volta a
      // "livre" silenciosamente.
      const pedido = n.pedido || null
      const pedidoAtivo = pedido && (pedido.estado === 'pendente' || pedido.estado === 'gerando' || pedido.estado === 'aguardando')
      const pedidoEnviado = pedido && pedido.estado === 'enviado'
      const pedidoRecusado = pedido && pedido.estado === 'recusado'
      const pBox = el('div', `pss-nec-pedido${pedidoAtivo ? ' aguardando' : ''}${pedidoEnviado ? ' enviado' : ''}`)
      const pTxt = el('span', 'pss-nec-pedido-txt')
      if (pedido?.estado === 'aguardando') {
        pTxt.innerHTML = `<b>Pediu; espera a resposta pra mandar a chave</b><small>${pedido.erro ? `última tentativa: ${esc(pedido.erro)}` : 'a chave PIX só sai se ele topar'}</small>`
      } else if (pedidoAtivo) {
        pTxt.innerHTML = `<b>Aguardando a próxima resposta</b><small>${pedido.erro ? `última tentativa: ${esc(pedido.erro)}` : 'primeiro pede; a chave só vai se ele topar'}</small>`
      } else if (pedidoEnviado) {
        const canal = pedido.canal === 'whatsapp' ? 'WhatsApp'
          : pedido.canal === 'tinder' ? 'Tinder'
          : pedido.canal === 'badoo' ? 'Badoo'
          : pedido.canal === 'instagram' ? 'Instagram'
          : (pedido.canal || 'conversa')
        pTxt.innerHTML = `<b>Pedido enviado</b><small>${esc(canal)}${pedido.enviadoEm ? ` · ${esc(timeAgo(pedido.enviadoEm))}` : ''}</small>`
      } else {
        const falta = !n.vale ? 'libere esta necessidade para ela primeiro'
          : !n.temValor ? 'coloque o valor na necessidade primeiro'
            : !n.temLinha ? 'escreva a linha de conversa primeiro'
              : pedidoRecusado ? 'ele recusou; pode pedir de novo'
                : 'conta a situação, pede ajuda, chave só se ele topar'
        pTxt.innerHTML = `<b>Pedir na próxima resposta</b><small>${esc(falta)}</small>`
      }
      const pBtn = el('button', `btn small ${pedidoAtivo ? 'ghost perigo' : pedidoEnviado ? 'ghost' : 'primary'} pss-nec-pedido-btn`,
        pedidoAtivo ? 'Cancelar' : pedidoEnviado ? 'Pedir de novo' : 'Pedir 1x')
      pBtn.type = 'button'
      pBtn.disabled = !pedidoAtivo && (!n.vale || !n.temValor || !n.temLinha)
      pBtn.addEventListener('click', async () => {
        if (pedidoAtivo) {
          const r = await post('/api/necessidades/pedido', { id: n.id, personId, acao: 'cancelar' })
          if (!r?.ok) { toast(r?.erro || 'Não deu pra cancelar.', 'err'); return }
          toast('Pedido cancelado antes do envio')
          pintarNecessidadesDaPessoa(host, personId)
          return
        }
        const sim = await descPergunta({
          titulo: pedidoEnviado ? 'Pedir novamente?' : 'Pedir na próxima resposta?',
          texto: `O Tim conta a situação, pergunta se a pessoa pode ajudar com ${n.valorFormatado} e só manda o PIX se ela disser que sim.`,
          confirmar: pedidoEnviado ? 'Pedir novamente' : 'Agendar pedido',
        })
        if (!sim) return
        const r = await post('/api/necessidades/pedido', { id: n.id, personId, acao: 'agendar' })
        if (!r?.ok) { toast(r?.erro || 'Não deu pra agendar.', 'err'); return }
        toast('Pedido agendado para a próxima resposta')
        pintarNecessidadesDaPessoa(host, personId)
      })
      pBox.append(pTxt, pBtn)
      linha.appendChild(pBox)
      host.appendChild(linha)
    }
  }

  // O menu de vínculo da ficha reusa `montarOpcoesVinculo` (o catálogo único de 20 vínculos,
  // o mesmo do menu das conversas) com abertura própria — o menu das threads está amarrado
  // ao estado da thread aberta, e aqui não existe thread nenhuma.
  function abrirMenuVinculoPessoa(wrap, chip, personId, aoSalvar) {
    document.querySelectorAll('.pss-vinc-pop').forEach((n) => n.remove())
    const root = el('div', 'wc-mode-pop pss-vinc-pop')
    const scrim = el('div', 'wc-mode-scrim')
    const menu = el('div', 'wc-mode-menu')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', 'Vínculo com esta pessoa')
    menu._anchor = chip
    const fechar = () => { root.remove(); document.removeEventListener('click', foraDaqui, true); chip.setAttribute('aria-expanded', 'false') }
    const foraDaqui = (e) => { if (!menu.contains(e.target) && e.target !== chip && !chip.contains(e.target)) fechar() }
    montarOpcoesVinculo(menu, personId, async (valor) => {
      fechar()
      const r = await post('/api/self/vinculos', { personId, vinculo: valor || '', iaPode: 'cuidado' })
      const label = (CATALOGO_VINC.find((c) => c.valor === valor) || {}).label || valor
      if (r && r.ok) { toast(valor ? `Vínculo definido: ${label}` : 'Vínculo removido'); aoSalvar(valor || null, label) }
      else toast('Não consegui salvar o vínculo', 'err')
    })
    root.append(scrim, menu)
    root.addEventListener('click', (e) => e.stopPropagation())
    wrap.appendChild(root)
    chip.setAttribute('aria-expanded', 'true')
    setTimeout(() => document.addEventListener('click', foraDaqui, true), 0)
  }

  // Um lado do par de identidade: foto, nome, de que rede é, e o identificador daquela
  // rede (telefone no WhatsApp, @ no Instagram, cidade no Tinder). Sem foto, cai na
  // inicial colorida do avatarHtml, que é o mesmo padrão do resto do painel.
  const CANAL_LBL = { whatsapp: 'WhatsApp', instagram: 'Instagram', tinder: 'Tinder', badoo: 'Badoo' }
  function ladoPessoa(x) {
    return `<div class="vu-lado">
      ${avatarHtml(x.nome, x.avatar, 'vu-av')}
      <div class="vu-info">
        <b>${esc(x.nome || 'pessoa')}</b>
        <span class="vu-canal canal-${esc(x.canal)}">${icon(CANAL_ICO[x.canal] || 'i-chat', 'ico ico-sm')} ${esc(CANAL_LBL[x.canal] || x.canal)}</span>
        ${x.sub ? `<small class="vu-sub">${esc(x.sub)}</small>` : ''}
        <small class="vinc-msgs">${x.msgs} mensagem${x.msgs === 1 ? '' : 's'}</small>
      </div>
    </div>`
  }

  // ------- iniciativas (nível 1): a IA sugere puxar papo; NADA sai sem o dono aprovar
  const GATILHO_LBL = { combinado: 'combinado em aberto', esfriou: 'sinal de vida' }
  function renderIniciativas(host) {
    const head = el('div', 'ini-head')
    head.innerHTML = `
      <p class="ini-explica">A IA percebe quando faz sentido VOCÊ puxar papo (combinado pendente, conversa esfriando) e escreve a mensagem. Nada é enviado sem você mandar.</p>
      <div class="ini-head-acoes">
        <label class="vinc-auto-row"><span>Sugerir iniciativas</span>
          <button class="toggle sm" role="switch" aria-checked="${VINC.iniciativasOn ? 'true' : 'false'}" aria-label="Sugerir iniciativas" data-ini-toggle></button></label>
        <button class="btn small ghost" data-ini-detectar>Procurar agora</button>
      </div>`
    head.querySelector('[data-ini-toggle]').addEventListener('click', async (e) => {
      const tg = e.currentTarget
      const next = tg.getAttribute('aria-checked') !== 'true'
      const r = await post('/api/iniciativas/config', { enabled: next })
      if (r && r.ok) { tg.setAttribute('aria-checked', String(r.enabled)); VINC.iniciativasOn = r.enabled; toast(r.enabled ? 'A IA volta a sugerir iniciativas' : 'Sugestões pausadas') }
    })
    head.querySelector('[data-ini-detectar]').addEventListener('click', async (e) => {
      const b = e.currentTarget; b.disabled = true; b.textContent = 'Procurando…'
      await post('/api/iniciativas/detectar', {})
      toast('Procurando motivos pra puxar papo — as sugestões aparecem aqui em instantes')
      setTimeout(() => { b.disabled = false; b.textContent = 'Procurar agora'; loadVinculos() }, 4000)
    })
    host.appendChild(head)
    const itens = VINC.iniciativas || []
    if (!itens.length) { host.appendChild(el('div', 'pj-empty-line', 'Nenhuma sugestão agora. A IA procura sozinha de tempo em tempo; "Procurar agora" força uma rodada.')); return }
    itens.forEach((i) => {
      const c = el('article', 'vinc-card ini-card')
      c.innerHTML = `
        <div class="vinc-card-top">
          <div class="vinc-quem"><b>${esc(i.nome)}</b><small>${esc(CANAL_NOME[i.channel] || i.channel)} · ${esc(GATILHO_LBL[i.gatilho] || i.gatilho)}</small></div>
          <span class="vinc-tag">${esc(timeAgo(i.criado_em))}</span>
        </div>
        <p class="vinc-motivo">${esc(i.motivo || '')}</p>
        <textarea class="ini-texto" rows="2" aria-label="Mensagem que será enviada">${esc(i.rascunho || '')}</textarea>
        <div class="vinc-opcoes">
          <button class="btn small" data-mandar>Mandar</button>
          <button class="btn ghost small" data-nao>Não mandar</button>
        </div>`
      const ta = c.querySelector('.ini-texto')
      c.querySelector('[data-mandar]').addEventListener('click', async (e) => {
        const b = e.currentTarget; b.disabled = true; b.textContent = 'Enviando…'
        const r = await post(`/api/iniciativas/${encodeURIComponent(i.id)}`, { acao: 'aprovar', texto: ta.value })
        if (r && r.ok) { toast('Enviada'); loadVinculos() }
        else { toast(r?.error || 'Não consegui enviar', 'err'); b.disabled = false; b.textContent = 'Mandar' }
      })
      c.querySelector('[data-nao]').addEventListener('click', async () => {
        await post(`/api/iniciativas/${encodeURIComponent(i.id)}`, { acao: 'rejeitar' })
        toast('Descartada — essa pessoa sai do radar por uns dias')
        loadVinculos()
      })
      host.appendChild(c)
    })
  }

  // ------- lista "pra revisar": ambíguos + contatos colhidos que não fecharam sozinhos
  function renderRevisar(host, d) {
    const duvidosos = (d.hintsPendentes || []).filter((h) => h.confianca < 0.9)
    const sugestoes = VINC.uniao || []
    if (!d.revisoes.length && !duvidosos.length && !sugestoes.length) {
      host.appendChild(el('div', 'pj-empty-line', 'Nada esperando você. Os contatos que dão pra confirmar sozinhos já viraram vínculo.'))
    }
    // "É a mesma pessoa?" — mesma natureza das outras: decisão sua sobre identidade.
    // Fica aqui e não na Config porque é aqui que você vem quando o assunto é quem é quem.
    sugestoes.forEach((s) => {
      const c = el('article', 'vinc-card revisar vinc-uniao')
      c.innerHTML = `<div class="vinc-card-top"><b>É a mesma pessoa?</b><span class="vinc-tag alerta">identidade</span></div>
        <div class="vu-par">
          ${ladoPessoa(s.a)}
          <div class="vu-elo" aria-hidden="true">${icon('i-link', 'ico ico-sm')}</div>
          ${ladoPessoa(s.b)}
        </div>
        <p class="vinc-motivo vu-motivo">${icon('i-search', 'ico ico-sm')} ${esc(s.motivo || '')}</p>
        <div class="vinc-opcoes"></div>`
      const opcoes = c.querySelector('.vinc-opcoes')
      const sim = el('button', 'btn small', 'É a mesma pessoa')
      sim.addEventListener('click', async () => {
        const r = await post(`/api/self/uniao/${encodeURIComponent(s.id)}`, { acao: 'unir' })
        toast(r && r.ok ? 'Juntadas: a memória das duas conversas vira uma só' : 'Não deu pra juntar', r && r.ok ? 'ok' : 'err')
        loadVinculos()
      })
      const nao = el('button', 'btn ghost small', 'Não é')
      nao.addEventListener('click', async () => {
        await post(`/api/self/uniao/${encodeURIComponent(s.id)}`, { acao: 'rejeitar' })
        toast('Descartado'); loadVinculos()
      })
      opcoes.append(sim, nao)
      host.appendChild(c)
    })
    // Uma revisão é uma PERGUNTA com resposta possível na tela. Com uma candidata é sim ou
    // não; com várias, escolhe-se uma. O botão antigo dizia "Nenhum dos dois" ao lado de
    // nenhuma opção desenhada — porque a lista vinha sempre vazia (ver bridge/routes.mjs).
    d.revisoes.forEach((r) => {
      const opcoes = r.opcoes || []
      const uma = opcoes.length === 1
      const c = el('article', 'vinc-card revisar')
      c.innerHTML = `
        <div class="vinc-card-top">
          ${avatarHtml(r.pessoa, r.foto, 'vinc-av')}
          <div class="vinc-quem"><b>${esc(r.pessoa || 'pessoa')}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</div>
          ${eloHtml(r.origem, 'whatsapp')}
          <span class="vinc-tag alerta">precisa de você</span>
        </div>
        <p class="vinc-motivo">${!opcoes.length
          ? `Não achei o WhatsApp de <b>${esc(r.pessoa || 'dela')}</b>`
          : uma
            ? `Esse WhatsApp é <b>${esc(r.pessoa || 'dela')}</b>?`
            : `Qual desses WhatsApp é <b>${esc(r.pessoa || 'dela')}</b>?`}
          <span class="vr-porque">Pergunto porque ${esc(r.porque || 'não consegui confirmar sozinho')}.</span></p>
        ${r.frase ? `<blockquote class="vinc-frase">“${esc(r.frase)}”</blockquote>` : ''}
        <div class="vr-opcoes"></div>
        <div class="vinc-opcoes"></div>`
      const lista = c.querySelector('.vr-opcoes')
      opcoes.forEach((op) => {
        const b = el('button', 'vr-opcao')
        b.type = 'button'
        b.innerHTML = `${avatarHtml(op.nome || op.titulo, op.foto, 'vinc-av-sm')}
          <span class="vr-op-txt"><b>${esc(op.titulo)}</b><small>${op.nome ? esc(op.nome) + ' · ' : ''}${op.mensagens ? `${op.mensagens} ${op.mensagens === 1 ? 'mensagem' : 'mensagens'} nessa conversa` : 'nenhuma conversa ainda'}</small></span>
          <span class="vr-op-escolher">${uma ? 'É ela' : 'É essa'}</span>`
        b.addEventListener('click', async () => {
          await post('/api/vinculos/revisao', { id: r.id, acao: 'confirmar', alvo: op.jid })
          toast('Vínculo confirmado'); loadVinculos()
        })
        lista.appendChild(b)
      })
      if (!opcoes.length) lista.appendChild(el('p', 'vinc-sem-prova', 'Nenhum número candidato existe no WhatsApp — vale conferir com ela, ou ligar na mão em "Ligar duas pessoas".'))
      const recusar = el('button', 'btn ghost small', uma ? 'Não é' : opcoes.length ? 'Nenhuma delas' : 'Descartar')
      recusar.addEventListener('click', async () => { await post('/api/vinculos/revisao', { id: r.id, acao: 'rejeitar' }); toast('Descartado'); loadVinculos() })
      c.querySelector('.vinc-opcoes').appendChild(recusar)
      host.appendChild(c)
    })
    duvidosos.forEach((h) => {
      const c = el('article', 'vinc-card')
      c.innerHTML = `<div class="vinc-card-top">${avatarHtml(h.nome, h.foto, 'vinc-av')}<div class="vinc-quem"><b>${esc(h.nome)}</b>${h.sub ? `<small>${esc(h.sub)}</small>` : ''}</div><span class="vinc-tag">${h.tipo === 'instagram' ? 'Instagram' : 'telefone'}</span></div>
        <p class="vinc-motivo">Colhi <b>${esc(h.valor)}</b> e não tenho certeza — veio de conversa, não de um @ explícito.</p>
        ${h.frase ? `<blockquote class="vinc-frase">“${esc(h.frase)}”</blockquote>` : ''}
        <div class="vinc-opcoes"><button class="btn small" data-ok>É contato dela</button><button class="btn ghost small" data-no>Não é</button></div>`
      c.querySelector('[data-ok]').addEventListener('click', async (e) => {
        // manda o hint DESTE cartão: antes ia `limite: 5` sem dizer qual, e o botão que
        // prometia confirmar essa pessoa na verdade rodava a fila e torcia
        const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Vinculando…'
        const r = await post('/api/vinculos/resolver', { hintId: h.id })
        const res = r && r.resultado
        toast(res && res.vinculados ? 'Vinculado' : res && res.ambiguos ? 'Ficou ambíguo, veja acima'
          : res && res.inexistentes ? 'Esse número não existe no WhatsApp' : 'Não deu pra vincular agora',
        res && res.vinculados ? 'ok' : 'err')
        loadVinculos()
      })
      c.querySelector('[data-no]').addEventListener('click', async () => {
        await post('/api/veredito', { canal: h.tipo === 'instagram' ? 'instagram' : 'whatsapp', alvo: h.valor, personId: h.personId, verdict: 'errado', reason: 'pessoa_errada' })
        toast('Descartado'); loadVinculos()
      })
      host.appendChild(c)
    })
  }

  // ------- cartões de vínculo (ativos e frios)
  // Linha fechada = o vínculo e nada mais: quem é, as duas redes ligadas pelo fio, e o peso
  // da conversa. Frase de origem, identificadores e ações moram DENTRO, e só aparecem quando
  // você abre — 23 cartões abertos viravam uma parede de texto pra dizer 23 vezes a mesma
  // coisa (regra do sistema, 26/07/2026).
  function renderVinculoCards(host, itens, vazio) {
    if (!itens || !itens.length) { host.appendChild(el('div', 'pj-empty-line', vazio)); return }
    itens.forEach((v) => {
      const c = el('article', 'vinc-linha')
      const idade = v.desde ? timeAgo(v.desde) : ''
      const cabeca = el('button', 'vl-head')
      cabeca.type = 'button'
      cabeca.setAttribute('aria-expanded', 'false')
      cabeca.innerHTML = `
        ${carasDasRedes(v.nome, v.redes && v.redes.length ? v.redes : [{ canal: v.origem, foto: v.foto }, { canal: v.canal, foto: v.fotoAlvo }])}
        <span class="vl-nome">${esc(v.nome)}</span>
        <span class="vl-meta">${v.mensagens ? `${v.mensagens} msg` : 'sem conversa'}</span>
        ${icon('i-arrow-r', 'ico ico-sm vl-chev')}`
      const corpo = el('div', 'vl-corpo')
      corpo.hidden = true
      corpo.innerHTML = `
        <div class="vl-pontas">
          <div class="vl-ponta">${avatarHtml(v.nome, v.foto, 'vinc-av-sm')}<div><b>${esc(v.nome)}</b><small>${esc(CANAL_NOME[v.origem] || v.origem || '')}${v.sub ? ' · ' + esc(v.sub) : ''}</small></div></div>
          <div class="vl-ponta">${avatarHtml(v.nome, v.fotoAlvo, 'vinc-av-sm')}<div><b>${esc(v.subAlvo || v.alvoBonito)}</b><small>${esc(CANAL_NOME[v.canal] || v.canal)}${idade ? ' · há ' + idade : ''}</small></div></div>
        </div>
        <div class="vinc-card-top">
          <span class="vinc-tag ${v.mensagens ? 'ok' : 'alerta'}">${esc(ESTADO_ROTULO[v.estado] || v.estado)}</span>
          ${v.manual ? '<span class="vinc-tag">você definiu</span>' : ''}
          ${v.jaChamada ? '<span class="vinc-tag">já chamada</span>' : ''}
        </div>
        ${v.prova ? `<blockquote class="vinc-frase">“${esc(v.prova.frase)}”</blockquote>` : '<p class="vinc-sem-prova">Sem frase de origem (vínculo antigo).</p>'}
        <div class="vinc-acoes">
          ${v.podeChamar ? `<label class="vinc-autoriza"><span>chamar primeiro</span><button class="toggle sm" role="switch" aria-checked="${v.autorizadaPraChamar ? 'true' : 'false'}" aria-label="Autorizar chamada automática" data-autoriza></button></label>` : ''}
          ${v.podeChamar ? '<button class="btn small" data-chamar>Chamar agora</button>' : ''}
          <button class="btn ghost small" data-trocar>Trocar pessoa</button>
          <button class="btn ghost small danger" data-desligar>Desligar</button>
        </div>`
      cabeca.addEventListener('click', () => {
        const abrindo = corpo.hidden
        corpo.hidden = !abrindo
        cabeca.setAttribute('aria-expanded', String(abrindo))
        c.classList.toggle('aberta', abrindo)
      })
      c.append(cabeca, corpo)
      const aut = c.querySelector('[data-autoriza]')
      if (aut) aut.addEventListener('click', async () => {
        const ligado = aut.getAttribute('aria-checked') !== 'true'
        aut.setAttribute('aria-checked', String(ligado))
        await post('/api/vinculos/auto', { personId: v.personId, ligado })
        toast(ligado ? 'Autorizada' : 'Autorização removida')
      })
      const chamar = c.querySelector('[data-chamar]')
      if (chamar) chamar.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Escrevendo…'
        const r = await post('/api/vinculos/chamar', { canal: v.canal, personId: v.personId, nome: v.nome, alvo: v.alvo })
        if (r && r.ok) { toast('Mandei: ' + String(r.texto).slice(0, 60)); loadVinculos() }
        else { toast((r && r.motivo) || 'Não consegui chamar', 'err'); btn.disabled = false; btn.textContent = 'Chamar agora' }
      })
      c.querySelector('[data-trocar]').addEventListener('click', () => {
        openPeoplePicker(async (outroId) => {
          await post('/api/vinculos/trocar', { canal: v.canal, alvo: v.alvo, personId: outroId })
          toast('Vínculo trocado'); loadVinculos()
        }, { excludeId: v.personId, title: 'De quem é essa conversa?' })
      })
      c.querySelector('[data-desligar]').addEventListener('click', (e) => confirmDestructive(e.currentTarget, 'Confirmar', async () => {
        await post('/api/vinculos/desligar', { canal: v.canal, alvo: v.alvo })
        toast('Vínculo desfeito'); loadVinculos()
      }))
      host.appendChild(c)
    })
  }

  // ------- histórico de chamadas, com o veredito
  function renderChamadas(host, chamadas) {
    if (!chamadas || !chamadas.length) { host.appendChild(el('div', 'pj-empty-line', 'Nenhuma primeira mensagem ainda.')); return }
    chamadas.forEach((ch) => {
      const c = el('article', 'vinc-card')
      const vd = ch.veredito === 'certo' ? '<span class="vinc-tag ok">você marcou: certo</span>'
        : ch.veredito === 'errado' ? `<span class="vinc-tag erro">você marcou: errado${ch.motivo ? ' (' + esc(ch.motivo.replace(/_/g, ' ')) + ')' : ''}</span>` : ''
      // o estado vem da CONFIRMAÇÃO do WhatsApp, não do "mandei": entregue é entregue.
      // "no servidor" NÃO é erro: a mensagem saiu e o WhatsApp entrega quando ela abrir o
      // aparelho. Vermelho só quando nem o envio foi confirmado.
      const ROTULO = { entregue: 'ela recebeu', no_servidor: 'saiu — ela está offline, chega quando abrir',
        sent: 'saiu, esperando confirmação', sem_confirmacao: 'o WhatsApp não confirmou nem o envio',
        uncertain: 'incerta', sending: 'mandando…' }
      const bom = ch.estado === 'entregue' || ch.estado === 'no_servidor'
      const ruim = ch.estado === 'sem_confirmacao' || ch.estado === 'uncertain'
      c.innerHTML = `<div class="vinc-card-top"><b>${icon(CANAL_ICO[ch.canal], 'ico ico-sm')} ${esc(ch.alvo)}</b>
          <span class="vinc-tag ${bom ? 'ok' : ruim ? 'erro' : 'alerta'}">${esc(ROTULO[ch.estado] || ch.estado)}</span>${vd}</div>
        <p class="vinc-onde">${esc(ch.canalNome)} · ${timeAgo(ch.quando)}</p>
        ${ch.veredito ? '' : '<div class="vinc-acoes"><button class="btn small" data-certo>Enviou certo</button><button class="btn ghost small danger" data-errado>Enviou errado</button></div>'}`
      const certo = c.querySelector('[data-certo]')
      if (certo) certo.addEventListener('click', async () => {
        await post('/api/veredito', { canal: ch.canal, alvo: ch.alvo, personId: ch.personId || null, verdict: 'certo' })
        toast('Anotado'); loadVinculos()
      })
      const errado = c.querySelector('[data-errado]')
      if (errado) errado.addEventListener('click', () => abrirMotivoErro({ canal: ch.canal, alvo: ch.alvo, personId: ch.personId || null }, () => loadVinculos()))
      host.appendChild(c)
    })
  }

  // ------- por que deu errado (o motivo decide o que o sistema faz com o vínculo)
  function abrirMotivoErro({ canal, alvo, messageId, personId }, aoTerminar) {
    const ov = overlay()
    const sheet = el('div', 'pj-sheet')
    sheet.innerHTML = `<div class="pj-sheet-head"><h2>O que deu errado?</h2><button class="icon-btn" data-x>${icon('i-x')}</button></div>
      <div class="vinc-motivos">
        <button class="vinc-motivo-op" data-r="pessoa_errada"><b>Não é a pessoa</b><small>desfaz o vínculo, desgruda a conversa e desliga a IA dela</small></button>
        <button class="vinc-motivo-op" data-r="nao_entregou"><b>Não chegou</b><small>marca o canal como não confiável pra ela</small></button>
        <button class="vinc-motivo-op" data-r="texto_ruim"><b>A mensagem ficou ruim</b><small>o vínculo estava certo; fica anotado pra calibrar a voz</small></button>
        <button class="vinc-motivo-op" data-r="outro"><b>Outro motivo</b><small>só registra</small></button>
      </div>`
    ov.appendChild(sheet)
    sheet.querySelector('[data-x]').addEventListener('click', () => ov.remove())
    sheet.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', async () => {
      const r = await post('/api/veredito', { canal, alvo, messageId, personId, verdict: 'errado', reason: b.dataset.r })
      ov.remove()
      toast(r && r.efeitos && r.efeitos.length ? r.efeitos.join(', ') : 'Anotado')
      if (typeof aoTerminar === 'function') aoTerminar()
    }))
  }

  // ------- ligar duas pessoas na mão (autofill nos 3 canais)
  function abrirLigarManual() {
    openPeoplePicker((primeiro) => {
      openPeoplePicker(async (segundo) => {
        const r = await post('/api/vinculos/ligar', { primaryId: primeiro, secondaryId: segundo })
        if (r && r.ok) { toast('Pessoas unificadas — a IA passa a ler os dois canais como uma conversa só'); loadVinculos() }
        else toast('Não consegui unificar', 'err')
      }, { excludeId: primeiro, title: '…é a mesma pessoa que' })
    }, { title: 'Quem é essa pessoa?' })
  }

  // -------------------------------------------------- gerenciar hábitos
  async function openHabitsManager() {
    const ov = overlay()
    const sheet = el('div', 'pj-sheet tall')
    sheet.innerHTML = `<div class="pj-sheet-head"><h2>Hábitos</h2><button class="icon-btn" data-x>${icon('i-x')}</button></div><div id="habList"></div>
      <form class="pj-add" id="habAdd"><input type="text" placeholder="Novo hábito (ex: treino)" autocomplete="off"><button class="btn small" type="submit">${icon('i-new', 'ico ico-sm')}</button></form>`
    ov.appendChild(sheet)
    sheet.querySelector('[data-x]').addEventListener('click', () => { ov.remove(); if (S.tab === 'projetos') loadProjetos() })
    const render = async () => {
      const r = await api('/api/habits'); const host = $('#habList', sheet); host.replaceChildren()
      if (!r || !r.habits.length) { host.appendChild(el('div', 'pj-empty-line', 'Nenhum hábito ainda.')); return }
      r.habits.forEach((h) => { const it = el('div', 'pj-hab-row'); it.innerHTML = `<span class="pj-hab-name">${esc(h.name)}${h.streak ? ` <span class="pj-habit-streak">${icon('i-flame', 'ico ico-sm')}${h.streak}</span>` : ''}</span><button class="pj-mini" aria-label="Excluir">${icon('i-trash', 'ico ico-sm')}</button>`; it.querySelector('button').addEventListener('click', (e) => confirmDestructive(e.currentTarget, 'Confirmar', async () => { await jdel(`/api/habits/${h.id}`); render() })); host.appendChild(it) })
    }
    render()
    $('#habAdd', sheet).addEventListener('submit', async (e) => { e.preventDefault(); const inp = e.target.querySelector('input'); const v = inp.value.trim(); if (!v) return; await post('/api/habits', { name: v, days: 'daily' }); inp.value = ''; render() })
  }

  // -------------------------------------------------- utilidades de UI (overlay + pop flutuante)
  function overlay() { const ov = el('div', 'pj-overlay'); ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove() }); document.body.appendChild(ov); return ov }
  function floatPop(anchor, node, big = false) {
    document.querySelectorAll('.pj-pop, .pj-datesheet.floating').forEach((n) => n.remove())
    node.classList.add('floating'); if (big) node.classList.add('big')
    document.body.appendChild(node)
    const r = anchor.getBoundingClientRect()
    const w = node.offsetWidth || 220, h = node.offsetHeight || 120
    let left = Math.min(r.left, window.innerWidth - w - 10); left = Math.max(8, left)
    let top = r.bottom + 6; if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6)
    node.style.left = left + 'px'; node.style.top = top + 'px'
    const close = (e) => { if (!node.contains(e.target) && e.target !== anchor) { node.remove(); document.removeEventListener('mousedown', close); document.removeEventListener('touchstart', close) } }
    setTimeout(() => { document.addEventListener('mousedown', close); document.addEventListener('touchstart', close) }, 0)
  }

  $('#captureFab').addEventListener('click', openCapture)

  // ================================================================ PROGRESSO DAS CONVERSAS
  // Como as conversas estão indo: o conjunto, a série semanal, a comparação com o período
  // anterior e o caminho do número até as conversas que o formaram. Os números vêm prontos
  // de /api/conversas/progresso (SQL puro, sem modelo) — aqui só se desenha.
  //
  // As cores do gráfico passaram no validador de paleta contra o fundo do cartão (#1a222d):
  // faixa de luminosidade, piso de croma, separação para daltonismo e contraste. Não são as
  // do painel por acaso — o verde da marca (#35d0ba) reprova na faixa de luminosidade.
  const PROG_COR = { serie: '#26a693', ia: '#8f6ff2' }
  const PROG = {
    dias: Number(localStorage.getItem('vendas-multicanal.progDias') ?? 30),
    canal: localStorage.getItem('vendas-multicanal.progCanal') || '',
    visao: localStorage.getItem('vendas-multicanal.progVisao') === 'cobrancas' ? 'cobrancas' : 'conversas',
    dados: null,
    recorte: null,       // { desde, fim } quando uma semana do gráfico está selecionada
    tabela: false,       // a série como tabela (alternativa acessível ao gráfico)
    cursor: null,        // índice destacado no gráfico
    carregando: false,
  }
  // abaixo disso a semana não vira ponto no gráfico: 1 de 1 vira "100%" e mente
  const PROG_MIN_SEMANA = 5

  // "2 min", "3 h", "5 d" — duração, não instante (timeAgo() é pra instante)
  function dur(ms) {
    if (ms == null) return '—'
    const m = Math.round(ms / 60000)
    if (m < 1) return 'menos de 1 min'
    if (m < 60) return `${m} min`
    const h = Math.round(m / 60)
    if (h < 48) return `${h} h`
    return `${Math.round(h / 24)} d`
  }
  const progDia = (ts) => new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })

  // ---------------------------------------------------------------- carga
  async function loadProgresso() {
    montarProgShell()
    const body = $('#progBody')
    if (!PROG.dados) body.replaceChildren(el('div', 'wc-loading', `<span class="spin"></span> medindo as conversas…`))
    PROG.carregando = true
    const r = PROG.recorte
    const q = new URLSearchParams({ dias: String(PROG.dias) })
    if (PROG.canal) q.set('canal', PROG.canal)
    if (r) { q.set('desde', String(r.desde)); q.set('ate', String(r.fim)) }
    const [d, cob, mig] = await Promise.all([
      api(`/api/conversas/progresso?${q}`),
      api(`/api/conversas/cobrancas?${q}`),
      api('/api/self/migracao').catch(() => null),
    ])
    if (mig) PROG.migracao = mig
    PROG.carregando = false
    if (S.tab !== 'progresso') return
    if (!d || d.error) {
      body.replaceChildren(emptyState('i-x', 'Não deu pra medir', 'O vendas-multicanal não devolveu os números das conversas. Tente de novo em instantes.'))
      return
    }
    // a série só vem na visão sem recorte; guardamos a última pra não sumir o gráfico
    if (d.serie) PROG.serie = d.serie
    if (cob && !cob.error) d.cobrancas = cob
    PROG.dados = d
    renderProgresso(d)
  }

  function montarProgShell() {
    const host = $('#progressoHost')
    if ($('#progShell')) { pintarProgFiltros(); return }
    const wrap = el('div', 'prog'); wrap.id = 'progShell'
    wrap.innerHTML = `
      <div class="view-head">
        <div><h1>Progresso</h1><span class="sub">como as conversas estão indo, medido no que já foi dito</span></div>
      </div>
      <div class="prog-visoes" id="progVisao" role="tablist" aria-label="Área de Progresso">
        <button id="progTabConversas" data-v="conversas" role="tab" type="button" aria-controls="progBody">Conversas</button>
        <button id="progTabCobrancas" data-v="cobrancas" role="tab" type="button" aria-controls="progBody">Cobranças</button>
      </div>
      <div class="prog-filtros">
        <div class="pj-seg" id="progDias" role="tablist" aria-label="Período">
          <button data-d="7" role="tab" type="button">7 dias</button>
          <button data-d="30" role="tab" type="button">30 dias</button>
          <button data-d="90" role="tab" type="button">90 dias</button>
          <button data-d="0" role="tab" type="button">tudo</button>
        </div>
        <div class="pj-seg" id="progCanal" role="tablist" aria-label="Canal">
          <button data-c="" role="tab" type="button">Todos</button>
          <button data-c="whatsapp" role="tab" type="button">WhatsApp</button>
          <button data-c="tinder" role="tab" type="button">Tinder</button>
          <button data-c="instagram" role="tab" type="button">Instagram</button>
          <button data-c="badoo" role="tab" type="button">Badoo</button>
        </div>
        <a class="btn ghost small prog-csv" id="progCsv" download>${icon('i-book', 'ico ico-sm')} Baixar os dados</a>
      </div>
      <div id="progBody" role="tabpanel"></div>`
    host.replaceChildren(wrap)
    $$('#progVisao button').forEach((b) => b.addEventListener('click', () => {
      const visao = b.dataset.v === 'cobrancas' ? 'cobrancas' : 'conversas'
      if (PROG.visao === visao) return
      PROG.visao = visao
      localStorage.setItem('vendas-multicanal.progVisao', PROG.visao)
      pintarProgFiltros()
      if (PROG.dados) renderProgresso(PROG.dados)
      else loadProgresso()
    }))
    $$('#progDias button').forEach((b) => b.addEventListener('click', () => {
      PROG.dias = Number(b.dataset.d); PROG.recorte = null; PROG.cursor = null
      localStorage.setItem('vendas-multicanal.progDias', String(PROG.dias)); loadProgresso()
    }))
    $$('#progCanal button').forEach((b) => b.addEventListener('click', () => {
      PROG.canal = b.dataset.c; PROG.recorte = null; PROG.cursor = null
      localStorage.setItem('vendas-multicanal.progCanal', PROG.canal); loadProgresso()
    }))
    pintarProgFiltros()
  }

  function pintarProgFiltros() {
    $$('#progVisao button').forEach((b) => {
      const on = b.dataset.v === PROG.visao
      b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1
    })
    $$('#progDias button').forEach((b) => {
      const on = Number(b.dataset.d) === PROG.dias
      b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on))
    })
    $$('#progCanal button').forEach((b) => {
      const on = b.dataset.c === PROG.canal
      b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on))
    })
    const csv = $('#progCsv')
    if (csv) {
      csv.href = `/api/conversas/dados.csv?dias=${PROG.dias}${PROG.canal ? '&canal=' + PROG.canal : ''}`
      csv.hidden = PROG.visao !== 'conversas'
    }
  }

  // ---------------------------------------------------------------- desenho
  function renderProgresso(d) {
    const body = $('#progBody')
    body.setAttribute('aria-labelledby', PROG.visao === 'cobrancas' ? 'progTabCobrancas' : 'progTabConversas')
    const frag = document.createDocumentFragment()
    if (PROG.visao === 'cobrancas') {
      if (PROG.recorte) frag.appendChild(progBanner())
      if (d.cobrancas) frag.appendChild(progCobrancas(d.cobrancas))
      else frag.appendChild(emptyState('i-x', 'Não deu pra abrir as cobranças', 'Tente de novo em instantes.'))
      body.replaceChildren(frag)
      return
    }
    if (PROG.migracao) frag.appendChild(progMigracao(PROG.migracao))
    if (PROG.recorte) frag.appendChild(progBanner())
    frag.appendChild(progCartaoRetomada(d))
    frag.appendChild(progTopo(d))
    frag.appendChild(progQuemResponde(d))
    frag.appendChild(progAutores(d))
    const t = d.totais || {}
    frag.appendChild(progLista('Andando', d.andandoBem, t.andandoBem, 'Nenhuma conversa ativa nesse recorte.', 'andando'))
    frag.appendChild(progLista('Esfriando', d.esfriando, t.esfriando, 'Nenhuma esfriando — ou está tudo vivo, ou tudo já morreu.', 'esfriando'))
    frag.appendChild(progLista('A bola está com você', d.aguardandoVoce, t.aguardandoVoce, 'Você respondeu todo mundo.', 'bola'))
    frag.appendChild(progRodape(d))
    body.replaceChildren(frag)
    if (PROG.cursor != null) progCursor(PROG.cursor, false)
  }

  // banner do recorte: sem ele, uma lista filtrada por semana passa por lista geral
  function progBanner() {
    const r = PROG.recorte
    const b = el('div', 'prog-banner')
    b.innerHTML = `<span>${icon('i-clock', 'ico ico-sm')} Só a semana de <b>${progDia(r.desde)}</b> a <b>${progDia(r.fim)}</b></span>`
    const x = el('button', 'btn ghost small', 'Ver o período inteiro')
    x.addEventListener('click', () => { PROG.recorte = null; PROG.cursor = null; loadProgresso() })
    b.appendChild(x)
    return b
  }

  // Os quatro números do topo são uma FOTO DE HOJE, não medida de janela: "andando" quer
  // dizer "trocou nos últimos 3 dias contados de agora". Por isso não levam comparação com o
  // período anterior — na janela anterior quase nada se qualificaria e a diferença seria um
  // número grande que não quer dizer nada. Quem compara é o cartão de cima.
  function progTopo(d) {
    const e = d.porEstagio
    const topo = el('div', 'prog-topo')
    const num = (valor, rotulo, extra, tom) =>
      `<div class="prog-num${tom ? ' ' + tom : ''}"><b>${valor}</b><span>${esc(rotulo)}</span>${extra ? `<small>${esc(extra)}</small>` : ''}</div>`
    topo.innerHTML = [
      num(e.andando + e.nova, 'andando', `${e.nova} começando`),
      num(e.esfriando, 'esfriando', 'de 4 a 14 dias paradas', e.esfriando ? 'morno' : ''),
      num(e.parada, 'paradas', 'mais de 14 dias'),
      num(d.bolaComVoce, 'com a bola', 'ela falou por último', d.bolaComVoce ? 'alerta' : ''),
    ].join('')
    return topo
  }

  // MIGRAÇÃO DO TINDER: quantas pessoas que começaram no Tinder passaram a conversar em
  // cada outro canal. Fonte: mensagem nos dois lados (não depende de qual mecanismo linkou).
  function progMigracao(m) {
    const sec = el('section', 'prog-migracao')
    const item = (n, canal, ico) => `<div class="prog-mig-item"><span class="prog-mig-ico">${icon(ico, 'ico ico-sm')}</span><b>${n}</b><span class="prog-mig-lbl">${esc(canal)}</span></div>`
    sec.innerHTML = `
      <div class="prog-mig-head">saíram do Tinder pra outra rede <small>de ${m.totalTinder} pessoas do Tinder</small></div>
      <div class="prog-mig-row">
        ${item(m.instagram || 0, 'Instagram', 'i-ig')}
        ${item(m.telegram || 0, 'Telegram', 'i-tg')}
        ${item(m.whatsapp || 0, 'WhatsApp', 'i-wa')}
        ${item(m.meupatrocinio || 0, 'Meu Patrocínio', 'i-mp')}
      </div>`
    return sec
  }

  // o cartão principal: o número que separa, a comparação com antes e a série semanal
  function progCartaoRetomada(d) {
    const sec = el('section', 'prog-hero')
    const c = d.comparacao
    const dp = c && c.retomada.deltaPp
    const cmp = dp == null
      ? (c ? `<span class="prog-cmp fraca">sem amostra pra comparar com os ${c.dias} dias anteriores</span>` : '')
      : `<span class="prog-cmp ${dp > 0 ? 'sobe' : dp < 0 ? 'desce' : ''}">${dp > 0 ? '+' : ''}${dp} p.p. em relação aos ${c.dias} dias anteriores</span>`
    sec.innerHTML = `
      <div class="prog-hero-head">
        <div class="prog-hero-id">
          <h2>Volta depois do silêncio</h2>
          <p>De cada vez que você escreveu depois de 12h ou mais parado, quantas ela voltou. É a medida que separa: dentro de uma conversa viva quase tudo é respondido.</p>
        </div>
        <div class="prog-hero-v">
          <b>${d.taxaRetomada == null ? '—' : d.taxaRetomada + '<i>%</i>'}</b>
          ${cmp}
          <small>${d.retomadasRespondidas} de ${d.retomadas} retomadas</small>
          ${c && c.conversasNoPeriodo.antes != null ? `<small>${d.conversas} conversas com troca no período, contra ${c.conversasNoPeriodo.antes} antes</small>` : ''}
        </div>
      </div>
      <div id="progGrafico"></div>`
    // o gráfico só existe na visão sem recorte (uma semana só não é série)
    if (!PROG.recorte && PROG.serie && PROG.serie.baldes.length > 1) {
      requestAnimationFrame(() => desenharSerie(PROG.serie))
    } else if (PROG.recorte) {
      sec.querySelector('#progGrafico').appendChild(el('p', 'prog-nota', 'A série semanal volta quando você sair do recorte.'))
    }
    return sec
  }

  // ---------------------------------------------------------------- a série semanal
  // Linha de uma série só: sem caixa de legenda (o título já diz o que está plotado).
  // Semana com amostra pequena demais NÃO vira ponto — o traço quebra e a semana aparece
  // como marca vazada na base. Linha reta por cima de "não sei" seria invenção.
  function desenharSerie(serie) {
    const host = $('#progGrafico')
    if (!host) return
    host.replaceChildren()
    const wrap = el('div', 'prog-graf')
    wrap.innerHTML = `
      <div class="prog-graf-topo">
        <span class="prog-graf-tit">${serie.baldes.length} semanas${serie.semanasSemDado ? ` · ${serie.semanasSemDado} sem dado ficaram de fora` : ''}</span>
        <button type="button" class="btn ghost small" id="progTabelaBtn">${PROG.tabela ? 'Ver o gráfico' : 'Ver como tabela'}</button>
      </div>
      <div class="prog-graf-corpo" id="progGrafCorpo"></div>`
    host.appendChild(wrap)
    $('#progTabelaBtn').addEventListener('click', () => { PROG.tabela = !PROG.tabela; desenharSerie(serie) })
    const corpo = $('#progGrafCorpo')
    if (PROG.tabela) { corpo.appendChild(progTabelaSerie(serie)); return }

    const pontos = serie.baldes.map((b, i) => ({
      i, b,
      // a semana só vira ponto quando tem amostra; senão fica buraco declarado
      v: b.retomadas >= PROG_MIN_SEMANA ? b.taxaRetomada : null,
    }))
    const svgHost = el('div', 'prog-svg-host'); svgHost.id = 'progSvgHost'
    corpo.appendChild(svgHost)
    corpo.appendChild(el('p', 'prog-nota', `Cada ponto é uma semana e o gráfico tem horizonte próprio: o período escolhido lá em cima muda os números e as listas, não ele. Ele começa onde o histórico fica denso o bastante pra medir${serie.semanasSemDado ? `, e as ${serie.semanasSemDado} semanas anteriores ficaram de fora por não terem amostra` : ''}. Semana com menos de ${PROG_MIN_SEMANA} retomadas não vira ponto. A última ainda está em curso, por isso o traço até ela é pontilhado. O eixo não começa em zero — o número de baixo diz onde ele começa — pra a variação caber na altura. Clique numa semana pra ver só as conversas dela.`))
    const pintar = () => pintarSvgSerie(svgHost, pontos, serie)
    pintar()
    // redesenha no resize sem repintar a página inteira
    if (PROG.ro) PROG.ro.disconnect()
    PROG.ro = new ResizeObserver(() => { clearTimeout(PROG.roT); PROG.roT = setTimeout(pintar, 120) })
    PROG.ro.observe(svgHost)
  }

  function pintarSvgSerie(host, pontos, serie) {
    const L = 36, R = 16, T = 16, B = 26          // margens: eixo Y à esquerda, meses embaixo
    const W = Math.max(320, host.clientWidth || 640)
    const H = 210
    const pw = W - L - R, ph = H - T - B
    const n = pontos.length
    const x = (i) => L + (n === 1 ? pw / 2 : (i / (n - 1)) * pw)
    // Eixo que cabe nos dados: uma taxa que vive entre 85% e 100% desenhada de 0 a 100 vira
    // uma reta e esconde exatamente o que interessa. O piso desce pro número redondo abaixo
    // do mínimo e APARECE no eixo, então o corte é declarado em vez de disfarçado.
    const vals = pontos.map((p) => p.v).filter((v) => v != null)
    const min = vals.length ? Math.min(...vals) : 0
    const piso = Math.max(0, Math.min(80, Math.floor((min - 5) / 10) * 10))
    const y = (v) => T + ph - ((v - piso) / (100 - piso)) * ph

    const svgNS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(svgNS, 'svg')
    svg.setAttribute('width', W); svg.setAttribute('height', H)
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    svg.setAttribute('class', 'prog-svg')
    svg.setAttribute('role', 'img')
    const comValor = pontos.filter((p) => p.v != null)
    svg.setAttribute('aria-label', comValor.length
      ? `Taxa de retomada por semana, de ${comValor[0].v}% a ${comValor[comValor.length - 1].v}% na última semana medida. A tabela ao lado traz os números.`
      : 'Sem semanas com amostra suficiente no período.')
    const cria = (t, attrs) => { const e = document.createElementNS(svgNS, t); for (const k in attrs) e.setAttribute(k, attrs[k]); return e }

    // grade: hairline sólida, recessiva, e os rótulos do eixo em número redondo
    for (const v of [piso, (piso + 100) / 2, 100]) {
      svg.appendChild(cria('line', { x1: L, y1: y(v), x2: W - R, y2: y(v), class: 'prog-grid' }))
      const t = cria('text', { x: L - 7, y: y(v) + 4, class: 'prog-axis', 'text-anchor': 'end' })
      t.textContent = v + '%'
      svg.appendChild(t)
    }

    // marcas de mês no eixo X, sem repetir
    let mesAnterior = null
    pontos.forEach((p) => {
      const dt = new Date(p.b.inicio)
      const m = dt.getMonth()
      if (m === mesAnterior) return
      mesAnterior = m
      const t = cria('text', { x: x(p.i), y: H - 8, class: 'prog-axis', 'text-anchor': 'middle' })
      t.textContent = dt.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')
      svg.appendChild(t)
    })

    // trechos contínuos: o traço quebra onde não há amostra
    const trechos = []
    let atual = []
    for (const p of pontos) {
      if (p.v == null) { if (atual.length) trechos.push(atual); atual = []; continue }
      atual.push(p)
    }
    if (atual.length) trechos.push(atual)

    for (const tr of trechos) {
      if (tr.length > 1) {
        // Sem preenchimento sob a linha: o eixo começa acima do zero pra caber nos dados, e
        // área sob linha lê como "quantidade a partir do zero". Só o traço é honesto aqui.
        // a última semana está incompleta: o trecho até ela sai tracejado pra não parecer fato
        const cheios = tr.filter((p) => !p.b.parcial)
        const dCheio = cheios.map((p, k) => `${k ? 'L' : 'M'}${x(p.i)} ${y(p.v)}`).join(' ')
        if (cheios.length > 1) svg.appendChild(cria('path', { d: dCheio, class: 'prog-linha', stroke: PROG_COR.serie }))
        const ult = tr[tr.length - 1]
        if (ult.b.parcial && cheios.length) {
          const pen = cheios[cheios.length - 1]
          svg.appendChild(cria('path', {
            d: `M${x(pen.i)} ${y(pen.v)} L${x(ult.i)} ${y(ult.v)}`,
            class: 'prog-linha parcial', stroke: PROG_COR.serie,
          }))
        }
      } else {
        svg.appendChild(cria('circle', { cx: x(tr[0].i), cy: y(tr[0].v), r: 4, fill: PROG_COR.serie, class: 'prog-ponto' }))
      }
    }

    // semanas sem amostra: marca vazada na base, pra o buraco ser declarado e não sumir
    pontos.filter((p) => p.v == null).forEach((p) => {
      svg.appendChild(cria('circle', { cx: x(p.i), cy: y(piso), r: 2.5, class: 'prog-sem-amostra' }))
    })

    // Ponta da série: marcador com anel da superfície. O rótulo direto vai na última semana
    // COMPLETA — rotular a semana em curso destacaria um número que ainda vai mudar, e a
    // leitura seria "a taxa hoje é 100%" quando ainda faltam dias pra semana fechar.
    const ultimo = comValor[comValor.length - 1]
    const ultimoCheio = [...comValor].reverse().find((p) => !p.b.parcial)
    if (ultimo) {
      svg.appendChild(cria('circle', {
        cx: x(ultimo.i), cy: y(ultimo.v), r: 4.5,
        fill: ultimo.b.parcial ? 'var(--panel-2)' : PROG_COR.serie,
        stroke: ultimo.b.parcial ? PROG_COR.serie : 'var(--panel-2)', 'stroke-width': 2,
      }))
    }
    if (ultimoCheio) {
      if (ultimoCheio !== ultimo) {
        svg.appendChild(cria('circle', { cx: x(ultimoCheio.i), cy: y(ultimoCheio.v), r: 4.5, fill: PROG_COR.serie, stroke: 'var(--panel-2)', 'stroke-width': 2 }))
      }
      const lb = cria('text', { x: x(ultimoCheio.i) - 8, y: y(ultimoCheio.v) - 10, class: 'prog-ponta', 'text-anchor': 'end' })
      lb.textContent = ultimoCheio.v + '%'
      svg.appendChild(lb)
    }

    // camada de leitura: cruzeta que gruda na semana mais próxima
    const cruz = cria('line', { x1: 0, y1: T, x2: 0, y2: T + ph, class: 'prog-cruz', opacity: '0' })
    const marca = cria('circle', { r: 5, class: 'prog-marca', opacity: '0' })
    svg.appendChild(cruz); svg.appendChild(marca)
    host.replaceChildren(svg)

    const dica = el('div', 'prog-dica'); dica.hidden = true
    host.appendChild(dica)

    const maisPerto = (px) => {
      const rel = (px - L) / (pw || 1)
      return Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1))))
    }
    const mostrar = (i, foco) => {
      const p = pontos[i]
      cruz.setAttribute('x1', x(i)); cruz.setAttribute('x2', x(i)); cruz.setAttribute('opacity', '1')
      if (p.v != null) {
        marca.setAttribute('cx', x(i)); marca.setAttribute('cy', y(p.v))
        marca.setAttribute('fill', PROG_COR.serie); marca.setAttribute('opacity', '1')
      } else marca.setAttribute('opacity', '0')
      dica.replaceChildren(progDicaConteudo(p))
      dica.hidden = false
      const dw = dica.offsetWidth || 190
      dica.style.left = Math.max(0, Math.min(W - dw, x(i) - dw / 2)) + 'px'
      dica.style.top = (p.v != null ? y(p.v) : y(50)) - dica.offsetHeight - 12 + 'px'
      PROG.cursor = i
      if (foco) svg.focus({ preventScroll: true })
    }
    const esconder = () => { cruz.setAttribute('opacity', '0'); marca.setAttribute('opacity', '0'); dica.hidden = true }

    svg.addEventListener('pointermove', (ev) => {
      const r = svg.getBoundingClientRect()
      mostrar(maisPerto(((ev.clientX - r.left) / r.width) * W))
    })
    svg.addEventListener('pointerleave', esconder)
    svg.addEventListener('click', (ev) => {
      const r = svg.getBoundingClientRect()
      const i = maisPerto(((ev.clientX - r.left) / r.width) * W)
      recortarSemana(pontos[i].b)
    })
    // teclado: a mesma leitura de quem usa mouse
    svg.setAttribute('tabindex', '0')
    svg.addEventListener('keydown', (ev) => {
      const i = PROG.cursor == null ? n - 1 : PROG.cursor
      if (ev.key === 'ArrowRight') { ev.preventDefault(); mostrar(Math.min(n - 1, i + 1)) }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); mostrar(Math.max(0, i - 1)) }
      else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); recortarSemana(pontos[i].b) }
      else if (ev.key === 'Escape') esconder()
    })
    svg.addEventListener('blur', esconder)
    PROG.mostrarCursor = mostrar
  }

  function progCursor(i, foco) { if (PROG.mostrarCursor) PROG.mostrarCursor(i, foco) }

  // Conteúdo da dica: valor em destaque, rótulo em segundo plano, nome via textContent.
  function progDicaConteudo(p) {
    const b = p.b
    const box = el('div')
    const cab = el('div', 'prog-dica-cab')
    cab.textContent = `${progDia(b.inicio)} — ${progDia(b.fim)}${b.parcial ? ' · em curso' : ''}`
    box.appendChild(cab)
    const linha = (valor, rot, cor) => {
      const l = el('div', 'prog-dica-l')
      if (cor) { const k = el('i', 'prog-dica-k'); k.style.background = cor; l.appendChild(k) }
      const v = el('b'); v.textContent = valor; l.appendChild(v)
      const r = el('span'); r.textContent = rot; l.appendChild(r)
      return l
    }
    box.appendChild(linha(p.v == null ? 'sem amostra' : p.v + '%', 'volta depois do silêncio', PROG_COR.serie))
    box.appendChild(linha(`${b.retomadasRespondidas}/${b.retomadas}`, 'retomadas'))
    box.appendChild(linha(String(b.conversasAtivas), 'conversas ativas'))
    box.appendChild(linha(String(b.idasEVindas), 'idas e vindas'))
    if (b.ia.retomadas) box.appendChild(linha(`${b.ia.retomadasRespondidas}/${b.ia.retomadas}`, 'retomadas da IA', PROG_COR.ia))
    const pe = el('div', 'prog-dica-pe'); pe.textContent = 'clique pra ver só essa semana'
    box.appendChild(pe)
    return box
  }

  function recortarSemana(b) {
    PROG.recorte = { desde: b.inicio, fim: b.fim }
    loadProgresso()
  }

  // A série como tabela: alternativa acessível ao gráfico, e é onde os números ficam
  // legíveis sem passar o mouse em nada.
  function progTabelaSerie(serie) {
    const box = el('div', 'prog-tabela-wrap')
    const t = el('table', 'prog-tabela')
    t.innerHTML = `<caption class="sr-only">Progresso semanal das conversas</caption>
      <thead><tr><th scope="col">Semana</th><th scope="col">Volta</th><th scope="col">Retomadas</th><th scope="col">Conversas</th><th scope="col">Idas e vindas</th><th scope="col">IA</th></tr></thead>`
    const tb = el('tbody')
    serie.baldes.slice().reverse().forEach((b) => {
      const tr = el('tr')
      const cel = (txt, cls) => { const td = el('td', cls); td.textContent = txt; return td }
      const th = el('th', ''); th.setAttribute('scope', 'row')
      th.textContent = `${progDia(b.inicio)} — ${progDia(b.fim)}${b.parcial ? ' (em curso)' : ''}`
      tr.appendChild(th)
      tr.appendChild(cel(b.retomadas >= PROG_MIN_SEMANA ? b.taxaRetomada + '%' : 'sem amostra', 'num'))
      tr.appendChild(cel(`${b.retomadasRespondidas}/${b.retomadas}`, 'num'))
      tr.appendChild(cel(String(b.conversasAtivas), 'num'))
      tr.appendChild(cel(String(b.idasEVindas), 'num'))
      tr.appendChild(cel(b.ia.retomadas ? `${b.ia.retomadasRespondidas}/${b.ia.retomadas}` : '—', 'num'))
      tb.appendChild(tr)
    })
    t.appendChild(tb)
    box.appendChild(t)
    return box
  }

  // ---------------------------------------------------------------- os dois lados
  function progQuemResponde(d) {
    const sec = el('section', 'prog-sec')
    const meu = d.seuVacuo || {}
    sec.innerHTML = `
      <div class="prog-sec-head"><h2>Os dois lados</h2></div>
      <div class="prog-dupla">
        <div class="prog-lado">
          <span class="prog-lado-tit">Ela respondendo você</span>
          <div class="prog-lado-nums">
            <div><b>${d.taxaResposta == null ? '—' : d.taxaResposta + '%'}</b><span>das suas falas</span></div>
            <div><b>${d.vacuos}</b><span>morreram sem resposta</span></div>
            <div><b>${dur(d.tempoRespostaMs)}</b><span>pra ela responder</span></div>
          </div>
        </div>
        <div class="prog-lado">
          <span class="prog-lado-tit">Você respondendo ela</span>
          <div class="prog-lado-nums">
            <div><b>${meu.taxa == null ? '—' : meu.taxa + '%'}</b><span>das falas dela</span></div>
            <div><b>${meu.vacuos ?? 0}</b><span>você deixou no vácuo</span></div>
            <div><b>${dur(meu.tempoMs)}</b><span>pra você responder</span></div>
          </div>
        </div>
      </div>
      <p class="prog-nota">A taxa dos dois lados fica sempre alta e é assim mesmo: conversa que não é respondida acaba, então o que sobra são as que foram. O número que vale aqui é o de vácuos, que é absoluto.</p>`
    return sec
  }

  function progAutores(d) {
    const iv = d.iaVsPessoaOperadora
    const cob = iv.cobertura
    const pctCob = cob.outgoing ? Math.round((cob.carimbadas / cob.outgoing) * 100) : 0
    const sec = el('section', 'prog-sec')
    const linha = (nome, o, cor) => {
      const pouca = !o.bastante
      return `<div class="prog-autor">
        <div class="prog-autor-nm"><i class="prog-key" style="background:${cor}"></i>${esc(nome)}</div>
        <div class="prog-autor-barra"><div class="pj-progress"><i style="width:${o.pctRetomada || 0}%;background:${cor}"></i></div></div>
        <div class="prog-autor-v">${o.pctRetomada == null ? '—' : o.pctRetomada + '%'}<small>${o.retomadasRespondidas} de ${o.retomadas} retomadas${pouca ? ' · pouca amostra' : ''}</small></div>
      </div>`
    }
    sec.innerHTML = `
      <div class="prog-sec-head"><h2>A IA segura conversa como você</h2></div>
      <div class="prog-autores">
        ${linha('Você', iv.humano, PROG_COR.serie)}
        ${linha('IA', iv.ia, PROG_COR.ia)}
      </div>
      <p class="prog-nota">Compara quem escreveu de verdade cada fala, na hora mais difícil: voltar depois do silêncio.
      Cobre ${cob.carimbadas.toLocaleString('pt-BR')} de ${cob.outgoing.toLocaleString('pt-BR')} mensagens suas no período (${pctCob}%) — o resto é anterior ao carimbo de autoria e fica de fora em vez de ser chutado.
      ${!iv.ia.bastante ? `Abaixo de ${iv.amostraMinima} retomadas o número aparece mas não conclui nada.` : ''}</p>`
    return sec
  }

  // ---------------------------------------------------------------- listas
  // A contagem do cabeçalho é o TOTAL, não o tamanho da lista mostrada: dizer "12" quando
  // existem 135 é apresentar amostra como universo. Quando corta, a tela fala que cortou.
  const progTag = (txt, ruim) => `<span class="prog-tag${ruim ? ' ruim' : ''}">${esc(txt)}</span>`

  function progLista(titulo, itens, total, vazio, tipo) {
    const t = total == null ? itens.length : total
    const sec = el('section', 'prog-sec')
    sec.appendChild(el('div', 'prog-sec-head', `<h2>${esc(titulo)}</h2><span class="pj-sec-count">${t}</span>`))
    if (!itens.length) { sec.appendChild(el('p', 'prog-vazio', esc(vazio))); return sec }
    const lista = el('div', 'prog-lista')
    itens.forEach((c) => lista.appendChild(progItem(c, tipo)))
    sec.appendChild(lista)
    if (t > itens.length) sec.appendChild(el('p', 'prog-nota', `Mostrando as ${itens.length} primeiras de ${t}.`))
    return sec
  }

  function progItem(c, tipo) {
    const it = el('button', `prog-item est-${c.estagio}`)
    it.type = 'button'
    // o que interessa muda por lista: no "andando" é o quanto anda; no resto, há quanto parou
    const destaque = tipo === 'andando'
      ? `<b>${c.idasEVindas}</b><span>idas e vindas</span>`
      : `<b>${timeAgo(c.ultima)}</b><span>parada</span>`
    const tags = []
    if (c.reciprocidade != null) tags.push(progTag(`${c.reciprocidade.toFixed(1)}x ela`))
    if (c.tempoRespostaMs != null) tags.push(progTag(`responde em ${dur(c.tempoRespostaMs)}`))
    if (c.pctRetomada != null) tags.push(progTag(`volta ${c.pctRetomada}%`, c.pctRetomada < 50))
    if (c.vacuos) tags.push(progTag(`${c.vacuos} sem resposta`, c.vacuos > 2))
    it.innerHTML = `
      ${avatarHtml(c.nome, null, 'wc-av prog-av')}
      <div class="prog-item-id">
        <div class="prog-item-nm">${esc(c.nome)}${progCanais(c)}</div>
        <div class="prog-item-tags">${tags.join('')}</div>
      </div>
      <div class="prog-item-v">${destaque}</div>`
    it.addEventListener('click', () => irParaConversa(c))
    return it
  }

  // As redes onde a conversa acontece, com o peso de cada uma. Uma pessoa pode estar em duas
  // e usar muito mais uma delas — isso é normal e NÃO é sinal de esfriamento, então aparece
  // como repartição e não como selo de canal.
  function progCanais(c) {
    const cs = c.canais && c.canais.length ? c.canais : (c.canal ? [{ canal: c.canal, pct: 100 }] : [])
    if (!cs.length) return ''
    if (cs.length === 1) return `<span class="prog-canal">${esc(CANAL_LBL[cs[0].canal] || cs[0].canal)}</span>`
    return `<span class="prog-canais" title="${esc(cs.map((x) => `${CANAL_LBL[x.canal] || x.canal}: ${x.n} mensagens`).join(' · '))}">${
      cs.map((x) => `<i class="prog-canal">${esc(CANAL_LBL[x.canal] || x.canal)} <b>${pctCanal(x)}</b></i>`).join('')}</span>`
  }

  // arredondar pra 0% uma rede que TEM mensagem é dizer que não tem. O piso honesto é "<1%".
  const pctCanal = (x) => (x.pct === 0 && x.n > 0 ? '<1%' : x.pct + '%')

  function progRodape(d) {
    const r = d.regua || {}
    return el('p', 'prog-nota rodape',
      `Uma conversa é com uma PESSOA, não com uma rede: quando ela é a mesma no Tinder, no WhatsApp e no Instagram, a linha do tempo é uma só e responder por outra rede conta como responder. O quanto cada rede carrega aparece do lado do nome.
       O filtro de canal lá em cima escolhe quem aparece, não separa a medida.
       Fala = mensagens seguidas do mesmo lado, então uma rajada conta uma vez; ${Math.round((r.retomadaMs || 0) / 3600000)}h de silêncio abrem uma retomada; a resposta vale até ${Math.round((r.janelaRespostaMs || 0) / 3600000)}h depois.
       Fala mandada agora e ainda sem resposta fica em aberto e não conta como vácuo.`)
  }

  function progCobrancas(d) {
    const resumo = d?.resumo || {}
    const itens = Array.isArray(d?.itens) ? d.itens : []
    const total = Number(d?.total) || itens.length
    const sec = el('section', 'prog-sec prog-cobr-sec')
    sec.appendChild(el('div', 'prog-sec-head', `<h2>Cobranças e pedidos</h2><span class="pj-sec-count">${total}</span>`))

    const metas = el('div', 'prog-cobr-metas')
    const meta = (valor, rotulo) => `<div class="prog-cobr-meta"><b>${valor}</b><span>${esc(rotulo)}</span></div>`
    // "Na mão" é a chave PIX digitada na conversa. Sem esta coluna, a tela dizia 0 iniciadas
    // com a chave já enviada pra 14 pessoas (instancia-b, 15/08/2026) — verdade sobre o mecanismo,
    // mentira sobre a vida.
    metas.innerHTML = [
      meta(Number(resumo.pedidosPendentes) || 0, 'pendentes'),
      meta(Number(resumo.cobrancasIniciadas) || 0, 'iniciadas'),
      meta(Number(resumo.pessoasNaMao) || 0, 'chave pela IA'),
      meta(Number(resumo.feedbackRecebido) || 0, 'com feedback'),
      meta(Number(resumo.semResposta) || 0, 'sem resposta'),
    ].join('')
    sec.appendChild(metas)
    sec.appendChild(el('p', 'prog-nota', 'Entram pedidos únicos, cobranças confirmadas pelo sistema e a chave PIX que a IA enviou cobrando — passar o contato não conta, e o que você cobrou com a própria mão também não aparece aqui. Ligar uma necessidade por si só não inicia cobrança.'))

    // "Ligada e ainda não cobrada" é um dado. Antes disto a tela dizia "nenhuma cobrança"
    // com uma necessidade ligada em 26 conversas — verdade pela metade que escondia a
    // decisão de quem clicou.
    const ligadas = d?.ligadas
    if (ligadas?.itens?.length) sec.appendChild(progNecessidadesLigadas(ligadas))

    if (!itens.length) {
      sec.appendChild(el('p', 'prog-vazio', ligadas?.itens?.length
        ? 'Nenhuma cobrança iniciada neste recorte — o que existe é o que está ligado acima.'
        : 'Nenhuma cobrança iniciada neste recorte.'))
      return sec
    }

    const lista = el('div', 'prog-cobr-lista')
    itens.forEach((item) => lista.appendChild(progCobrancaItem(item)))
    sec.appendChild(lista)
    if (total > itens.length) sec.appendChild(el('p', 'prog-nota', `Mostrando as ${itens.length} primeiras pessoas de ${total}.`))
    return sec
  }

  // O QUE ESTÁ LIGADO E AINDA NÃO VIROU COBRANÇA.
  //
  // Necessidade ligada entra no contexto da IA e não dispara nada sozinha — mas some da tela
  // se a única coisa desenhada for cobrança confirmada. Aqui ela aparece com o que interessa
  // pra decidir: em quantas pessoas está de pé, desde quando, quantas dessas já foram
  // cobradas de fato, e quantas sequer receberam resposta automática depois do clique.
  function progNecessidadesLigadas(l) {
    const itens = Array.isArray(l?.itens) ? l.itens : []
    const bloco = el('section', 'prog-ligadas')
    const pessoas = Number(l.pessoasLigadas) || 0
    const cobradas = Number(l.cobradas) || 0
    bloco.appendChild(el('div', 'prog-ligadas-head', `
      <span><b>Ligadas e ainda não cobradas</b><small>necessidade ligada entra no contexto da IA; cobrar de verdade exige pedido único enviado ou chave PIX confirmada</small></span>
      <span class="prog-ligadas-conta">${cobradas} de ${pessoas} cobradas</span>`))

    const lista = el('div', 'prog-ligadas-lista')
    itens.forEach((n) => {
      const card = el('article', `prog-ligada${n.cobradas ? '' : ' nenhuma'}`)
      const quando = tempoDesdeCobranca(n.ligadaEm)
      const tags = [
        progTag(`${n.pessoas} ${n.pessoas === 1 ? 'pessoa' : 'pessoas'}`),
        progTag(n.cobradas ? `${n.cobradas} cobrada${n.cobradas === 1 ? '' : 's'}` : 'nenhuma cobrada', !n.cobradas),
        progTag(`${n.comMensagemDepois} com resposta da IA depois`),
      ]
      if (n.pedidosAbertos) tags.push(progTag(`${n.pedidosAbertos} pedido${n.pedidosAbertos === 1 ? '' : 's'} em aberto`, true))
      if (n.status && n.status !== 'aberta') tags.push(progTag(esc(n.status)))
      card.innerHTML = `
        <div class="prog-ligada-topo">
          <span><b>${esc(n.descricao)}</b><small>${esc(n.valorFormatado)}${quando ? ` · ligada ${esc(quando)}` : ''}</small></span>
        </div>
        <div class="prog-item-tags">${tags.join('')}</div>`
      lista.appendChild(card)
    })
    bloco.appendChild(lista)

    // Por que ninguém foi cobrado: a chave PIX é liberada POR PESSOA (interruptor + motivo).
    // Sem isso o filtro segura a mensagem, e o número de vezes que ele segurou é a prova.
    const partes = []
    partes.push(Number(l.autorizadas)
      ? `${l.autorizadas} ${Number(l.autorizadas) === 1 ? 'pessoa autorizada' : 'pessoas autorizadas'} a receber a chave PIX`
      : 'ninguém está autorizado a receber a chave PIX')
    if (Number(l.bitSemMotivo)) partes.push(`${l.bitSemMotivo} com o interruptor ligado e sem motivo escrito (não vale)`)
    if (Number(l.chaveSeguradaNoRecorte)) partes.push(`a chave foi segurada ${l.chaveSeguradaNoRecorte}x neste recorte`)
    bloco.appendChild(el('p', 'prog-nota', `${partes.join(' · ')}.`))
    return bloco
  }

  function progCobrancaItem(c) {
    const card = el('article', 'prog-cobr-card')
    const pedidos = Array.isArray(c.pedidos) ? c.pedidos : []
    const tags = []
    const pend = pedidos.filter((p) => p.estado === 'pendente').length
    const ger = pedidos.filter((p) => p.estado === 'gerando').length
    const env = pedidos.filter((p) => p.estado === 'enviado').length
    if (pend) tags.push(progTag(`${pend} pendente${pend === 1 ? '' : 's'}`, true))
    if (ger) tags.push(progTag(`${ger} gerando`))
    if (env) tags.push(progTag(`${env} enviado${env === 1 ? '' : 's'}`))
    if (c.historico?.total) tags.push(progTag(resumoHistoricoCobranca(c.historico)))
    if (c.naMao?.total) {
      const quando = tempoDesdeCobranca(c.naMao.ultima)
      // Quem mandou muda o que a linha significa: a IA cobrando é automação funcionando; a
      // mão de quem opera é cobrança fora do sistema. Dizer "na mão" nos dois casos mentia.
      tags.push(progTag(`chave PIX enviada pela IA${c.naMao.total > 1 ? ` ${c.naMao.total}x` : ''}${quando ? ` · ${quando}` : ''}`))
    }

    const pedidosHtml = pedidos.length
      ? `<div class="prog-cobr-bloco"><b>Pedidos</b><ul class="prog-cobr-pedidos">${
          pedidos.map((p) => {
            const quando = tempoDesdeCobranca(p.enviadoEm || p.atualizadoEm || p.agendadoEm)
            const estado = p.estado === 'pendente' ? 'pendente'
              : p.estado === 'gerando' ? 'gerando'
                : p.estado === 'aguardando' ? 'esperando resposta pra mandar a chave'
                  : p.estado === 'enviado' ? 'chave enviada'
                    : p.estado === 'recusado' ? 'recusou'
                      : p.estado === 'cancelado' ? 'cancelado' : p.estado
            const detalhe = p.erro
              ? ` · ${esc(String(p.erro).slice(0, 120))}`
              : p.canal ? ` · ${esc(COBRANCA_CANAIS[p.canal] || p.canal)}` : ''
            return `<li><span><b>${esc(p.descricao)}</b><small>${esc(p.valorFormatado)} · ${esc(estado)}${quando ? ` · ${esc(quando)}` : ''}${detalhe}</small></span></li>`
          }).join('')
        }</ul></div>`
      : ''

    const historicoItens = Array.isArray(c.historico?.itens) ? c.historico.itens : []
    const historicoHtml = historicoItens.length
      ? `<div class="prog-cobr-bloco"><b>Histórico</b><ul class="prog-cobr-hist">${historicoItens.map((item) => historicoCobrancaItemHtml(item)).join('')}</ul></div>`
      : ''

    card.innerHTML = `
      <div class="prog-cobr-head">
        <div class="prog-cobr-id">
          ${avatarHtml(c.nome, null, 'wc-av prog-av')}
          <div class="prog-cobr-txt">
            <div class="prog-item-nm">${esc(c.nome)}${progCanais(c)}</div>
            <div class="prog-item-tags">${tags.join('')}</div>
          </div>
        </div>
        <div class="prog-cobr-side">
          <div class="prog-cobr-when"><b>${esc(timeAgo(c.ultima))}</b><span>${c.vez === 'sua' ? 'a bola está com você' : 'ela respondeu por último'}</span></div>
          <button class="btn ghost small prog-cobr-open" type="button">Abrir conversa</button>
        </div>
      </div>
      ${pedidosHtml || historicoHtml ? `<div class="prog-cobr-body">${pedidosHtml}${historicoHtml}</div>` : ''}`
    $('.prog-cobr-open', card).addEventListener('click', () => irParaConversa(c))
    return card
  }

  // Clicar num item leva pra conversa dele, no canal certo. O id carrega o canal no prefixo
  // (wa: / ig: / b: / p:), MENOS quando a conversa do WhatsApp pertence a alguém que veio do
  // Tinder — aí o id é 'p:' e quem sabe abrir é a ficha da pessoa, não a thread por jid.
  function irParaConversa(c) {
    const id = String(c.personId)
    // marca o alvo ANTES de trocar de aba: quem terminar de carregar o canal abre a conversa
    if (c.canal === 'whatsapp' && id.startsWith('wa:')) { alvoConversa = id.slice(3); setTab('whatsapp'); if (S.tab === 'whatsapp' && $('#wcList')) abrirAlvo(openThread) }
    else if (c.canal === 'instagram' && id.startsWith('ig:')) { alvoConversa = id.slice(3); setTab('instagram'); if (S.tab === 'instagram' && $('#igList')) abrirAlvo(igOpenThread) }
    else if (c.canal === 'badoo' && id.startsWith('b:')) { alvoConversa = id.slice(2); setTab('badoo'); if (S.tab === 'badoo' && $('#badooList')) abrirAlvo(badooOpenThread) }
    else { setTab('pessoas'); openPerson(id) }
  }


  // ================================================================ PRIMEIRA MENSAGEM
  // Você escolhe os perfis, escolhe o que mandar entre as suas opções, e dispara. NENHUM
  // modelo de linguagem no caminho: o texto é seu, {nome} e {idade} são substituição, e o
  // rodízio entre as opções é por posição. É o que faz isso não gastar token nenhum.
  let BD_DESLIZA = null, BD_DESLIZA_T = null
  const PRI = { canal: 'tinder', candidatos: [], modelos: [], sel: new Set(), usar: new Set(), host: null }

  async function abrirPrimeira(canal, hostId) {
    PRI.canal = canal
    PRI.host = hostId
    const host = $('#' + hostId)
    if (!host) return
    if (canal === 'badoo') stopBadooPolling()
    host.replaceChildren(el('div', 'wc-loading', `${icon('i-send', 'ico')}<span>abrindo os perfis sem conversa…</span>`))
    const [c, m] = await Promise.all([
      api(`/api/primeira/candidatos?canal=${canal}&limite=400`),
      api(`/api/primeira/modelos?canal=${canal}`),
    ])
    if (!$('#' + hostId)) return
    if (!c || c.error) { host.replaceChildren(emptyState('i-x', 'Não deu pra abrir', (c && c.error) || 'sem resposta')); return }
    PRI.candidatos = c.candidatos || []
    PRI.modelos = (m && m.modelos) || []
    PRI.sel = new Set()
    PRI.usar = new Set(PRI.modelos.filter((x) => x.ativo).map((x) => x.id))
    renderPrimeira()
  }

  function renderPrimeira() {
    const host = $('#' + PRI.host)
    if (!host) return
    const wrap = el('div', 'pri')
    const canalLbl = CANAL_LBL[PRI.canal] || PRI.canal
    wrap.innerHTML = `
      <div class="pri-head">
        <button class="icon-btn" id="priVoltar" title="Voltar" aria-label="Voltar">${icon('i-arrow-l', 'ico')}</button>
        <div class="pri-tit"><b>Primeira mensagem no ${esc(canalLbl)}</b><small>${PRI.candidatos.length} perfis sem conversa · sem IA, o texto é seu</small></div>
        <div class="pri-acoes">
          <button class="btn ghost small" id="priTodos">Selecionar todos</button>
          <button class="btn ghost small" id="priNenhum">Limpar</button>
        </div>
      </div>
      <section class="pri-sec">
        <div class="pri-sec-head"><h2>O que mandar</h2><small>use <b>{nome}</b> e <b>{idade}</b>; com mais de uma opção, elas se revezam</small></div>
        <div id="priModelos" class="pri-modelos"></div>
        <form class="pri-novo" id="priNovoForm">
          <input type="text" id="priNovoTxt" placeholder="escreva uma opção de mensagem" autocomplete="off" maxlength="900">
          <button class="btn small" type="submit">${icon('i-new', 'ico ico-sm')} Adicionar</button>
        </form>
      </section>
      <section class="pri-sec">
        <div class="pri-sec-head"><h2>Pra quem</h2><span class="pj-sec-count" id="priConta">0</span></div>
        <div id="priGrade" class="pri-grade"></div>
      </section>
      <div class="pri-rodape" id="priRodape">
        <div class="pri-resumo" id="priResumo"></div>
        <div class="pri-btns">
          <button class="btn ghost" id="priEnsaio" disabled>Ver o que vai sair</button>
          <button class="btn" id="priEnviar" disabled>${icon('i-send', 'ico ico-sm')} Enviar</button>
        </div>
      </div>`
    host.replaceChildren(wrap)
    $('#priVoltar').addEventListener('click', () => { PRI.canal === 'badoo' ? loadBadoo() : loadPeople() })
    $('#priTodos').addEventListener('click', () => { PRI.candidatos.forEach((c) => PRI.sel.add(c.alvo)); pintarPrimeira() })
    $('#priNenhum').addEventListener('click', () => { PRI.sel.clear(); pintarPrimeira() })
    // Enter na busca do navegador não pode submeter nada aqui; o form só serve pro modelo novo.
    $('#priEnsaio').addEventListener('click', () => dispararPrimeiraUI(true))
    $('#priEnviar').addEventListener('click', () => dispararPrimeiraUI(false))
    $('#priNovoForm').addEventListener('submit', async (e) => {
      e.preventDefault()
      const txt = $('#priNovoTxt').value.trim()
      if (!txt) return
      const r = await api('/api/primeira/modelos', { method: 'POST', body: JSON.stringify({ texto: txt, canal: null }) })
      if (r && r.modelos) { PRI.modelos = r.modelos; if (r.modelo) PRI.usar.add(r.modelo.id); $('#priNovoTxt').value = ''; pintarPrimeira() }
    })
    pintarPrimeira()
  }

  function pintarPrimeira() {
    // opções de mensagem
    const mh = $('#priModelos')
    if (mh) {
      mh.replaceChildren()
      if (!PRI.modelos.length) mh.appendChild(el('p', 'pri-vazio', 'Nenhuma opção ainda. Escreva a primeira aí embaixo.'))
      PRI.modelos.forEach((m) => {
        const on = PRI.usar.has(m.id)
        const it = el('div', 'pri-modelo' + (on ? ' on' : ''))
        it.innerHTML = `
          <button class="pri-check" type="button" role="switch" aria-checked="${on}" aria-label="Usar esta mensagem">${on ? icon('i-check', 'ico ico-sm') : ''}</button>
          <span class="pri-modelo-txt">${esc(m.texto)}</span>
          <button class="icon-btn pri-lixo" type="button" title="Apagar" aria-label="Apagar">${icon('i-trash', 'ico ico-sm')}</button>`
        it.querySelector('.pri-check').addEventListener('click', () => { on ? PRI.usar.delete(m.id) : PRI.usar.add(m.id); pintarPrimeira() })
        it.querySelector('.pri-lixo').addEventListener('click', async () => {
          const r = await api('/api/primeira/modelos', { method: 'POST', body: JSON.stringify({ apagar: m.id }) })
          if (r) { PRI.modelos = r.modelos || []; PRI.usar.delete(m.id); pintarPrimeira() }
        })
        mh.appendChild(it)
      })
    }
    // grade de perfis
    const gh = $('#priGrade')
    if (gh) {
      gh.replaceChildren()
      if (!PRI.candidatos.length) gh.appendChild(el('p', 'pri-vazio', 'Todo mundo dessa lista já tem conversa.'))
      PRI.candidatos.forEach((c) => {
        const on = PRI.sel.has(c.alvo)
        const b = el('button', 'pri-card' + (on ? ' on' : ''))
        b.type = 'button'
        b.setAttribute('role', 'switch')
        b.setAttribute('aria-checked', String(on))
        b.innerHTML = `
          <span class="pri-marca">${on ? icon('i-check', 'ico ico-sm') : ''}</span>
          ${c.foto ? `<img class="pri-foto" src="${esc(c.foto)}" alt="" loading="lazy">` : avatarHtml(c.nome, null, 'pri-foto ph')}
          <span class="pri-nm">${esc(c.nome)}${c.idade ? `<i>${c.idade}</i>` : ''}</span>`
        // alterna SÓ este cartão: repintar a grade inteira a cada clique pisca com 180
        // perfis na tela e desanexa o elemento que acabou de ser clicado
        b.addEventListener('click', () => {
          const agora = !PRI.sel.has(c.alvo)
          if (agora) PRI.sel.add(c.alvo); else PRI.sel.delete(c.alvo)
          b.classList.toggle('on', agora)
          b.setAttribute('aria-checked', String(agora))
          b.querySelector('.pri-marca').innerHTML = agora ? icon('i-check', 'ico ico-sm') : ''
          pintarRodapePrimeira()
        })
        gh.appendChild(b)
      })
    }
    pintarRodapePrimeira()
  }

  // Só os NÚMEROS e o estado dos botões. O rodapé é montado uma vez em renderPrimeira: se ele
  // for reconstruído a cada clique de perfil, o botão de enviar é trocado embaixo do dedo de
  // quem está clicando (e o próprio Playwright reclamou de "elemento instável").
  function pintarRodapePrimeira() {
    const conta = $('#priConta'); if (conta) conta.textContent = String(PRI.sel.size)
    const resumo = $('#priResumo')
    const usados = PRI.modelos.filter((m) => PRI.usar.has(m.id))
    if (resumo) {
      resumo.innerHTML = `${PRI.sel.size ? `<b>${PRI.sel.size}</b> perfis` : 'nenhum perfil'} · ${
        usados.length ? `<b>${usados.length}</b> ${usados.length === 1 ? 'opção' : 'opções'}` : 'nenhuma opção'}`
    }
    const pronto = PRI.sel.size > 0 && usados.length > 0
    for (const id of ['priEnsaio', 'priEnviar']) {
      const b = $('#' + id)
      if (b) b.disabled = !pronto
    }
  }

  async function dispararPrimeiraUI(ensaio) {
    const usados = PRI.modelos.filter((m) => PRI.usar.has(m.id)).map((m) => m.texto)
    const alvos = [...PRI.sel]
    if (!ensaio) {
      // Envio de verdade pra gente de verdade, e não tem desfazer. Confirmação com componente
      // NOSSO, nunca confirm() do navegador.
      const ok = await priPergunta(`Mandar a primeira mensagem pra ${alvos.length} ${alvos.length === 1 ? 'pessoa' : 'pessoas'} no ${CANAL_LBL[PRI.canal]}?`,
        'Vai sair com intervalo de 20 a 75 segundos entre uma e outra. Não tem como desfazer.')
      if (!ok) return
    }
    const rp = $('#priRodape')
    if (rp) rp.innerHTML = `<div class="wc-loading"><span class="spin"></span> ${ensaio ? 'montando a prévia…' : 'enviando… pode demorar, o ritmo é lento de propósito'}</div>`
    const r = await api('/api/primeira/disparar', {
      method: 'POST', timeoutMs: 30 * 60 * 1000,
      body: JSON.stringify({ canal: PRI.canal, alvos, modelos: usados, dryRun: ensaio }),
    })
    if (!r) { pintarPrimeira(); return }
    mostrarResultadoPrimeira(r, ensaio)
  }

  function mostrarResultadoPrimeira(r, ensaio) {
    const rp = $('#priRodape')
    if (!rp) return
    const linhas = r.itens.slice(0, 60).map((i) => {
      const cls = i.situacao === 'enviada' ? 'ok' : i.situacao === 'falhou' ? 'ruim' : i.situacao === 'pulado' ? 'fraco' : ''
      return `<div class="pri-linha ${cls}"><b>${esc(i.nome || i.alvo)}</b><span>${esc(i.texto || i.motivo || i.situacao)}</span></div>`
    }).join('')
    rp.innerHTML = `
      <div class="pri-result">
        <div class="pri-result-top">
          <b>${ensaio ? 'Prévia — nada foi enviado' : `${r.enviadas} enviadas`}</b>
          <span>${r.puladas} puladas${r.falhas ? ` · ${r.falhas} falharam` : ''}</span>
          <button class="btn ghost small" id="priFechar">Voltar</button>
        </div>
        <div class="pri-linhas">${linhas}</div>
        ${r.itens.length > 60 ? `<p class="prog-nota">Mostrando as 60 primeiras de ${r.itens.length}.</p>` : ''}
      </div>`
    $('#priFechar').addEventListener('click', () => {
      if (!ensaio) PRI.sel.clear()
      renderPrimeira()   // remonta o rodapé fixo junto
    })
  }

  // Diálogo de confirmação nosso (nada de confirm() nativo — regra da casa).
  function priPergunta(titulo, corpo) {
    return new Promise((resolve) => {
      const fundo = el('div', 'pri-modal-fundo')
      const cx = el('div', 'pri-modal')
      cx.innerHTML = `<h3>${esc(titulo)}</h3><p>${esc(corpo)}</p>
        <div class="pri-modal-btns"><button class="btn ghost" id="priNao">Cancelar</button><button class="btn" id="priSim">Enviar</button></div>`
      fundo.appendChild(cx)
      document.body.appendChild(fundo)
      const fim = (v) => { fundo.remove(); resolve(v) }
      cx.querySelector('#priNao').addEventListener('click', () => fim(false))
      cx.querySelector('#priSim').addEventListener('click', () => fim(true))
      fundo.addEventListener('click', (e) => { if (e.target === fundo) fim(false) })
      cx.querySelector('#priSim').focus()
    })
  }

  // ---------------------------------------------------------------- repinte por conta do servidor
  // O vendas-multicanal manda `state` de 72 lugares diferentes — cada sync, cada ação, cada tick. O cliente
  // respondia repintando a aba INTEIRA na hora, e com 461 cartões isso pisca, perde o scroll
  // e reanima tudo. Parecia que a página recarregava sozinha (foi o que o dono viu).
  //
  // Três coisas evitam isso, nesta ordem:
  //   1. COALESCER — uma rajada de avisos vira um repinte só, com atraso;
  //   2. NÃO ATROPELAR — se tem menu, pop ou diálogo aberto, ou o cursor está num campo, o
  //      repinte espera; mexer na tela embaixo da mão de quem usa é o pior tipo de refresh;
  //   3. NÃO REPINTAR O IGUAL — quem desenha compara uma assinatura do que já está na tela e
  //      só escreve no DOM se mudou de verdade (ver `mudou()`).
  const REPINTE_MS = 2500
  let repinteT = null
  function ocupado() {
    if (document.querySelector('.pj-pop, .pri-modal-fundo, .bd-cfg, .pj-overlay')) return true
    const a = document.activeElement
    return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable))
  }
  function pedirRepinte() {
    clearTimeout(repinteT)
    repinteT = setTimeout(() => {
      if (ocupado()) { pedirRepinte(); return }   // tenta de novo daqui a pouco
      repintarAgora()
    }, REPINTE_MS)
  }
  function repintarAgora() {
    loadState()
    if (S.tab === 'pessoas' && !$('#priGrade')) loadPeople()
    if (S.tab === 'whatsapp' && $('#wcListScroll')) loadWaChats()
    if (S.tab === 'instagram' && $('#igListScroll')) loadIgChats()
    if (S.tab === 'badoo' && $('#badooListScroll') && !$('#priGrade')) loadBadooChats()
    if (S.tab === 'agenda') loadAgenda()
  }

  // Assinatura do que está desenhado. Se o servidor mandou a mesma coisa, não se toca no DOM —
  // é isso que tira o "pisca" das atualizações de fundo.
  const ASSINATURAS = new Map()
  function mudou(chave, dados) {
    const a = JSON.stringify(dados)
    if (ASSINATURAS.get(chave) === a) return false
    ASSINATURAS.set(chave, a)
    return true
  }

  // "NÃO MUDOU" SÓ AUTORIZA A NÃO PINTAR SE JÁ EXISTE LISTA PINTADA.
  // A assinatura de `mudou()` sobrevive à troca de aba, mas o DOM não: ao voltar pro canal,
  // o host nasce de novo com "carregando conversas…" e os dados são exatamente os da última
  // visita — a assinatura batia, a pintura era pulada, e a lista ficava carregando até
  // alguém mandar uma mensagem (podia levar minutos). Quem manda no repintar é o par
  // (assinatura mudou) OU (a lista ainda não está na tela).
  function listaVazia(host) { return !host || !host.querySelector('.wc-items') }

  // ---------------------------------------------------------------- WebSocket
  let ws = null, reconnectTimer = null
  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    try { ws = new WebSocket(`${proto}://${location.host}/ws`) } catch { scheduleWs(); return }
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data) } catch { return } handleWs(m) }
    ws.onclose = () => { scheduleWs() }
    ws.onerror = () => { try { ws.close() } catch {} }
  }
  function scheduleWs() { if (reconnectTimer) return; reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWs() }, 2000) }

  function handleWs(m) {
    switch (m.t) {
      // Extração de fatos: mostra o progresso no próprio botão e recarrega ao terminar.
      case 'memoria-progresso': {
        const b = $('#pssConstruir')
        if (b) { b.disabled = true; b.textContent = `Construindo… ${m.feita + 1}/${m.total}` }
        break
      }
      case 'memoria-pronta': {
        const b = $('#pssConstruir')
        if (b) { b.disabled = false; b.textContent = 'Construir memórias' }
        toast(`Memória construída para ${m.feitas} pessoa(s)`)
        if ($('#pssLista')) carregarPessoas()
        break
      }
      case 'memoria-erro': {
        const b = $('#pssConstruir')
        if (b) { b.disabled = false; b.textContent = 'Construir memórias' }
        toast(m.erro || 'A construção da memória falhou', 'err')
        break
      }
      case 'sobre-mim-progresso': {
        pintarEstadoSobreMim(m)
        break
      }
      case 'sobre-mim-pronto': {
        pintarEstadoSobreMim(m)
        const r = m.resultado || {}
        toast(`Sobre mim atualizado com ${fmtNum(r.mensagensDaDona || 0)} mensagens suas de texto; ${fmtNum(r.propostos || 0)} fatos esperam aprovação`)
        // Recarrega a Config inteira para os cartões de "Como eu converso" e "Núcleo da
        // voz" mostrarem imediatamente os arquivos que acabaram de ser cristalizados.
        if (S.tab === 'config') loadConfig(true)
        else loadFatos()
        break
      }
      case 'sobre-mim-erro': {
        pintarEstadoSobreMim(m)
        toast(m.erro || 'A extração do Sobre mim falhou', 'err')
        break
      }
      case 'fatos-extraindo': {
        const b = $('#fatosExtrair')
        if (b) { b.disabled = true; b.textContent = `Lendo suas conversas… ${m.lote}/${m.total}` }
        break
      }
      case 'fatos-extraidos': {
        const b = $('#fatosExtrair')
        if (b) { b.disabled = false; b.textContent = 'Aprender com minhas conversas' }
        toast(m.propostos ? `${m.propostos} fato(s) novo(s) esperando você aprovar` : 'Nada novo encontrado nas conversas')
        loadFatos()
        break
      }
      case 'fatos-erro': {
        const b = $('#fatosExtrair')
        if (b) { b.disabled = false; b.textContent = 'Aprender com minhas conversas' }
        toast(m.erro || 'A leitura das conversas falhou', 'err')
        break
      }
      case 'wa-qr': {
        // QR chegou/renovou: a API já o persistiu antes do broadcast. Ler de lá evita
        // a corrida em que a tela "gerando" substituía uma imagem recém-chegada.
        if (S.tab === 'whatsapp') loadWa()
        break
      }
      case 'wa-status': {
        loadState()
        if (S.tab === 'whatsapp') { stopWaPolling(); $('#waHost').dataset.loaded = ''; loadWa() }
        break
      }
      case 'message': {
        // chegou mensagem nova
        loadState()
        if (S.tab === 'pessoas') { const h = $('#peopleHost'); h.dataset.loaded = '1'; loadPeople() }
        // se a ficha aberta é dessa pessoa, atualiza a conversa
        if (S.open && m.personId === S.open) {
          api(`/api/person/${encodeURIComponent(S.open)}`).then((d) => { if (d && S.open === m.personId) { S.detail = d; body_reloadConvo(d) } })
        }
        // aba WhatsApp: atualiza a lista; se a mensagem é da conversa aberta, puxa o histórico
        if (S.tab === 'whatsapp' && $('#wcListScroll')) {
          loadWaChats()
          if (WA.openJid && (m.jid === WA.openJid) && !WA.sending) {
            api(`/api/wa/chat?jid=${encodeURIComponent(WA.openJid)}`).then((chat) => {
              if (chat && WA.openJid === chat.jid && !WA.sending) { WA.chat = chat; refreshThreadMessages(chat) }
            })
          }
        }
        // aba Instagram: o 'message' do IG traz só personId, então refazemos lista + thread aberta
        igHandleWsRefresh()
        badooHandleWsRefresh()   // idem Badoo
        break
      }
      case 'state': { pedirRepinte(); break }
      case 'projects': { // algo mudou nos projetos (outro dispositivo / lembrete disparado)
        loadState()
        if (S.tab === 'projetos' && !PROJ.openId) loadProjetos()
        break
      }
      case 'reminder': { toast('Lembrete enviado no seu WhatsApp: ' + (m.text || ''), 'ok'); break }
      case 'assistente': { // conversa dele com o vendas-multicanal mudou (pelo painel ou pelo WhatsApp)
        if (S.tab === 'assistente') loadAssistente({ manterFoco: true })
        else marcarAssistenteNovo()
        break
      }
      case 'ig-deep': { // progresso da varredura profunda do Instagram
        const b = $('#igDeep'); if (b) { b.disabled = true; const l = b.querySelector('.lbl'); if (l) l.textContent = `Puxando ${m.done}/${m.total}…` }
        break
      }
      case 'ig-deep-done': {
        const b = $('#igDeep'); if (b) { b.disabled = false; const l = b.querySelector('.lbl'); if (l) l.textContent = 'Puxar histórico' }
        toast(`Histórico do Instagram puxado: ${m.total} conversas`, 'ok')
        if (S.tab === 'instagram' && $('#igListScroll')) loadIgChats()
        break
      }
      // 'frame'/'info' (screencast da tela ao vivo antiga) são ignorados aqui de propósito
    }
  }


  // ================================================================ DESCOBERTA
  // Auto-deslizar, critérios, ritmo, passport e perfil do Tinder.
  // Contrato: docs/TINDER-DESCOBERTA.md. Nada aqui envia swipe sozinho: o envio real
  // depende de dois interruptores e o segundo pede confirmação escrita.
  const D = { estado: null, aba: 'auto', rascunho: null, sujo: false, timerFila: null }

  // Diálogo nosso (o painel nunca usa confirm/prompt do navegador). Resolve com false
  // quando cancela; com true no modo confirmar; com o texto no modo campo.
  // `exige` obriga a digitar exatamente aquela palavra pra liberar o botão — é o que
  // protege o passo irreversível de sair do modo sombra.
  function descPergunta({ titulo, texto, tipo = 'confirmar', valor = '', placeholder = '', sufixo = '', confirmar = 'Confirmar', exige = null, perigo = false }) {
    return new Promise((resolve) => {
      const scrim = el('div', 'dmodal-scrim')
      const box = el('div', 'dmodal' + (perigo ? ' perigo' : ''))
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true')
      box.innerHTML = `<h3>${esc(titulo)}</h3>${texto ? `<p>${esc(texto)}</p>` : ''}`
      let campo = null
      if (tipo !== 'confirmar') {
        const linha = el('div', 'dmodal-campo')
        campo = el('input')
        campo.type = tipo === 'numero' ? 'number' : 'text'
        campo.value = valor; campo.placeholder = placeholder
        if (tipo === 'numero') { campo.min = 1; campo.max = 100; campo.inputMode = 'numeric' }
        linha.appendChild(campo)
        if (sufixo) linha.appendChild(el('span', 'desc-suf', esc(sufixo)))
        box.appendChild(linha)
      }
      const acoes = el('div', 'dmodal-acoes')
      const bNao = el('button', 'btn ghost', 'Cancelar')
      const bSim = el('button', 'btn' + (perigo ? ' danger' : ''), esc(confirmar))
      if (exige) bSim.disabled = true
      acoes.appendChild(bNao); acoes.appendChild(bSim)
      box.appendChild(acoes)
      scrim.appendChild(box)
      document.body.appendChild(scrim)
      requestAnimationFrame(() => scrim.classList.add('show'))
      const fecha = (v) => { scrim.classList.remove('show'); document.removeEventListener('keydown', onKey); setTimeout(() => scrim.remove(), 180); resolve(v) }
      const onKey = (ev) => {
        if (ev.key === 'Escape') fecha(false)
        if (ev.key === 'Enter' && !bSim.disabled) { ev.preventDefault(); bSim.click() }
      }
      document.addEventListener('keydown', onKey)
      if (exige && campo) campo.addEventListener('input', () => { bSim.disabled = campo.value.trim() !== exige })
      bNao.addEventListener('click', () => fecha(false))
      scrim.addEventListener('click', (ev) => { if (ev.target === scrim) fecha(false) })
      bSim.addEventListener('click', () => fecha(tipo === 'confirmar' || exige ? true : (campo ? campo.value : true)))
      setTimeout(() => (campo || bSim).focus(), 60)
    })
  }


  function descCard(icoId, titulo, sub, corpo) {
    const card = el('section', 'cfg-card desc-card')
    card.appendChild(el('div', 'cfg-head', `
      <div class="cfg-ico">${icon(icoId, 'ico')}</div>
      <div class="cfg-titles"><h3>${esc(titulo)}</h3><p>${esc(sub)}</p></div>`))
    const body = el('div', 'desc-body')
    if (corpo) body.appendChild(corpo)
    card.appendChild(body)
    return { card, body }
  }

  function campoNumero(rotulo, valor, { min, max, sufixo, dica, onInput }) {
    const wrap = el('label', 'desc-field')
    wrap.innerHTML = `<span class="desc-lbl">${esc(rotulo)}</span>`
    const box = el('div', 'desc-num')
    const inp = el('input')
    inp.type = 'number'; inp.value = valor; inp.min = min; inp.max = max; inp.inputMode = 'numeric'
    box.appendChild(inp)
    if (sufixo) box.appendChild(el('span', 'desc-suf', esc(sufixo)))
    wrap.appendChild(box)
    if (dica) wrap.appendChild(el('span', 'desc-dica', esc(dica)))
    inp.addEventListener('input', () => { marcaSujo(); onInput(inp.value === '' ? null : Number(inp.value)) })
    return wrap
  }

  function campoSwitch(rotulo, ligado, dica, onChange) {
    const row = el('div', 'desc-switch')
    row.appendChild(el('div', 'desc-switch-txt', `<b>${esc(rotulo)}</b>${dica ? `<span>${esc(dica)}</span>` : ''}`))
    const tg = el('button', 'toggle sm')
    tg.setAttribute('role', 'switch'); tg.setAttribute('aria-checked', String(!!ligado)); tg.setAttribute('aria-label', rotulo)
    tg.addEventListener('click', () => {
      const novo = tg.getAttribute('aria-checked') !== 'true'
      tg.setAttribute('aria-checked', String(novo))
      marcaSujo(); onChange(novo)
    })
    row.appendChild(tg)
    return row
  }

  // Editor de chips: adicionar, remover, sem duplicata, sem vazio. É o que o dono pediu
  // pra poder mexer nas listas quando quiser.
  function editorChips(valores, { placeholder = 'adicionar e Enter', onChange }) {
    const host = el('div', 'desc-chips')
    const lista = el('div', 'desc-chips-list')
    const inp = el('input', 'desc-chip-input')
    inp.type = 'text'; inp.placeholder = placeholder; inp.autocomplete = 'off'
    let atual = Array.isArray(valores) ? valores.slice() : []
    const redesenha = () => {
      lista.replaceChildren()
      if (!atual.length) lista.appendChild(el('span', 'desc-chips-vazio', 'nenhum'))
      atual.forEach((v, i) => {
        const c = el('span', 'desc-chip', `${esc(v)}<button type="button" aria-label="remover ${esc(v)}">${icon('i-x', 'ico ico-sm')}</button>`)
        c.querySelector('button').addEventListener('click', () => { atual.splice(i, 1); redesenha(); marcaSujo(); onChange(atual.slice()) })
        lista.appendChild(c)
      })
    }
    const adiciona = () => {
      const v = inp.value.trim()
      if (!v) return
      if (v.length > 40) { toast('palavra longa demais (máx 40)', 'err'); return }
      if (atual.some((x) => norm(x) === norm(v))) { toast('essa já está na lista', 'err'); inp.value = ''; return }
      atual.push(v); inp.value = ''; redesenha(); marcaSujo(); onChange(atual.slice())
    }
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); adiciona() } })
    inp.addEventListener('blur', adiciona)
    redesenha()
    host.appendChild(lista); host.appendChild(inp)
    return host
  }

  function marcaSujo() {
    D.sujo = true
    const b = $('#descSalvar')
    if (b) { b.disabled = false; b.textContent = 'Salvar mudanças' }
  }

  async function loadDescoberta() {
    const host = $('#descHost')
    if (!host.dataset.loaded) host.replaceChildren(el('div', 'empty', `${icon('i-target', 'ico')}<h3>carregando…</h3>`))
    const r = await api('/api/swipe/estado?full=1')
    host.dataset.loaded = '1'
    if (!r || !r.ok) {
      host.replaceChildren(emptyState('i-target', 'Descoberta indisponível', 'O vendas-multicanal não respondeu agora. Assim que voltar, a tela carrega.'))
      return
    }
    D.estado = r.estado
    D.rascunho = JSON.parse(JSON.stringify({ criterios: r.estado.criterios, tetos: r.estado.tetos }))
    D.sujo = false
    desenhaDescoberta()
  }

  function statusTexto(e) {
    if (!e.ligado) return { txt: 'desligado', cls: 'off' }
    if (e.sombra) return { txt: 'ligado — modo sombra (não envia)', cls: 'shadow' }
    return { txt: 'LIGADO — deslizando de verdade', cls: 'live' }
  }

  function desenhaDescoberta() {
    const e = D.estado
    const host = $('#descHost')
    const page = el('div', 'desc-page')
    const st = statusTexto(e)
    const chipStatus = $('#descStatus')
    chipStatus.className = `desc-status ${st.cls}`
    chipStatus.textContent = st.txt

    // ---------- avisos de estado que mudam o que a tela pode fazer ----------
    if (e.semToken) page.appendChild(el('div', 'desc-alerta err', `${icon('i-x', 'ico ico-sm')} Sem token do Tinder: dá pra configurar, mas nada de fila, passport ou perfil até religar a sessão.`))
    if (e.backoffAte) page.appendChild(el('div', 'desc-alerta err', `${icon('i-x', 'ico ico-sm')} Em backoff até ${new Date(e.backoffAte).toLocaleString('pt-BR')} — o Tinder recusou e o vendas-multicanal parou sozinho.`))
    if (e.rodando) page.appendChild(el('div', 'desc-alerta', `${icon('i-bot', 'ico ico-sm')} Tem uma sessão rodando agora.`))

    // ================= 1. auto-deslizar =================
    {
      const { card, body } = descCard('i-bot', 'Auto-deslizar', 'Dois interruptores: o primeiro liga o agendador, o segundo tira do modo sombra.')
      body.appendChild(campoSwitch('Ligado', e.ligado, 'sorteia 3-5 sessões por dia nos teus horários', (v) => salvaDireto({ ligado: v })))
      const swAoVivo = campoSwitch('Deslizar de verdade', !e.sombra, e.sombra ? 'hoje ele só julga e registra o motivo, sem tocar no Tinder' : 'cada decisão vira swipe real na tua conta', (v) => {
        if (v) confirmaAoVivo()
        else salvaDireto({ sombra: true })
      })
      body.appendChild(swAoVivo)

      const hoje = el('div', 'desc-stats')
      hoje.innerHTML = `
        <div><b>${e.hoje.swipes || 0}</b><span>swipes hoje (teto ${e.tetos.porDia})</span></div>
        <div><b>${e.hoje.likes || 0}</b><span>curtidas hoje (teto ${e.tetos.curtidasPorDia})</span></div>
        <div><b>${e.projecao}</b><span>projeção por dia</span></div>`
      body.appendChild(hoje)

      const plano = el('div', 'desc-plano')
      if (e.plano && e.plano.sessoes?.length) {
        plano.appendChild(el('span', 'desc-lbl', `Sessões de hoje (${e.plano.dia})`))
        const chips = el('div', 'desc-chips-list')
        e.plano.sessoes.forEach((s) => chips.appendChild(el('span', `desc-chip plano${s.feita ? ' feita' : ''}`, `${String(s.hora).padStart(2, '0')}:${String(s.minuto).padStart(2, '0')} · ${s.tamanho} swipes${s.feita ? ' · feita' : ''}`)))
        plano.appendChild(chips)
      } else plano.appendChild(el('span', 'desc-dica', 'sem plano pra hoje ainda — ele nasce na primeira volta do loop, ou clique em replanejar'))
      body.appendChild(plano)

      const acoes = el('div', 'desc-acoes')
      const bRodar = el('button', 'btn', `${icon('i-bot', 'ico ico-sm')} Rodar sessão agora`)
      bRodar.addEventListener('click', () => rodarAgora())
      const bReplan = el('button', 'btn ghost', 'Replanejar horários')
      bReplan.addEventListener('click', async () => {
        const r = await post('/api/swipe/replanejar', {})
        if (r?.ok) { toast('horários sorteados de novo'); loadDescoberta() } else toast('não deu', 'err')
      })
      acoes.appendChild(bRodar); acoes.appendChild(bReplan)
      body.appendChild(acoes)
      page.appendChild(card)
    }

    // ================= 2. critérios =================
    {
      const c = D.rascunho.criterios
      const { card, body } = descCard('i-target', 'Critérios', 'Quem entra e quem não entra. Vale pra fila e pra quem já te curtiu.')
      const grade = el('div', 'desc-grid')
      grade.appendChild(campoNumero('Idade mínima', c.idade.min, { min: 18, max: 99, sufixo: 'anos', onInput: (v) => { c.idade.min = v } }))
      grade.appendChild(campoNumero('Idade máxima', c.idade.max, { min: 18, max: 99, sufixo: 'anos', onInput: (v) => { c.idade.max = v } }))
      grade.appendChild(campoNumero('Mínimo de fotos', c.fotosMin, { min: 0, max: 9, sufixo: 'fotos', onInput: (v) => { c.fotosMin = v } }))
      body.appendChild(grade)

      // distância como filtro é opt-in: desligada, ela só pontua; ligada, ela elimina
      const distWrap = el('div', 'desc-dist')
      distWrap.appendChild(campoSwitch('Descartar por distância', c.filtrarPorDistancia, 'desligado: ninguém é reprovado por estar longe', (v) => {
        c.filtrarPorDistancia = v
        campoDistMax.hidden = !v
      }))
      const campoDistMax = campoNumero('Descartar acima de', c.distanciaMax, { min: 1, max: 500, sufixo: 'mi', dica: 'com passport ligado, medida da cidade onde você está', onInput: (v) => { c.distanciaMax = v } })
      campoDistMax.hidden = !c.filtrarPorDistancia
      distWrap.appendChild(campoDistMax)
      // pontuar por distância é o outro lado da mesma moeda: dar ponto pra quem está perto
      // deixa quem está longe abaixo do corte, e a distância volta a negar pela porta dos fundos
      distWrap.appendChild(campoSwitch('Perto ganha ponto', c.pontuarDistancia, 'desligado: distância não muda a pontuação de ninguém', (v) => {
        c.pontuarDistancia = v
        campoPerto.hidden = !v
      }))
      const campoPerto = campoNumero('Considerar "perto" até', c.distanciaPerto, { min: 1, max: 500, sufixo: 'mi', dica: 'dentro disso ganha +1', onInput: (v) => { c.distanciaPerto = v } })
      campoPerto.hidden = !c.pontuarDistancia
      distWrap.appendChild(campoPerto)
      body.appendChild(distWrap)

      body.appendChild(campoSwitch('Exigir bio', c.exigirBio, 'hoje é o filtro que mais reprova nas cidades pequenas', (v) => { c.exigirBio = v }))
      body.appendChild(campoSwitch('Exigir selfie verificada', c.exigirVerificada, 'desligado: verificada só ganha +2 na pontuação', (v) => { c.exigirVerificada = v }))
      body.appendChild(campoSwitch('Exigir atividade recente', c.exigirAtivaRecente, 'só quem o Tinder marca como ativa há pouco', (v) => { c.exigirAtivaRecente = v }))

      body.appendChild(el('div', 'desc-sep', 'Intenção de relacionamento bloqueada'))
      body.appendChild(editorChips(c.intencoesBloqueadas, { placeholder: 'ex: Novas amizades', onChange: (v) => { c.intencoesBloqueadas = v } }))

      body.appendChild(el('div', 'desc-sep', 'Regra: excluir perfis trans'))
      body.appendChild(campoSwitch('Regra ligada', c.regras.excluirTrans.ativa, 'varre bio, nome, gênero customizado e os prompts', (v) => { c.regras.excluirTrans.ativa = v }))
      body.appendChild(el('span', 'desc-dica', 'Termos casam com palavra inteira: "trans" não pega transporte, transtorno nem trânsito.'))
      body.appendChild(editorChips(c.regras.excluirTrans.termos, { placeholder: 'termo + Enter', onChange: (v) => { c.regras.excluirTrans.termos = v } }))
      body.appendChild(el('span', 'desc-dica', 'Símbolos (o ⚧ sozinho já pega a bandeira inteira, porque ela contém esse caractere).'))
      body.appendChild(editorChips(c.regras.excluirTrans.simbolos, { placeholder: 'símbolo + Enter', onChange: (v) => { c.regras.excluirTrans.simbolos = v } }))

      body.appendChild(el('div', 'desc-sep', 'Palavras que reprovam'))
      body.appendChild(editorChips(c.bloqueioTexto, { placeholder: 'palavra + Enter', onChange: (v) => { c.bloqueioTexto = v } }))
      body.appendChild(el('div', 'desc-sep', 'Palavras que dão bônus (+2)'))
      body.appendChild(editorChips(c.bonusTexto, { placeholder: 'palavra + Enter', onChange: (v) => { c.bonusTexto = v } }))

      body.appendChild(el('div', 'desc-sep', 'Pontuação e taxa'))
      const g2 = el('div', 'desc-grid')
      g2.appendChild(campoNumero('Curtir a partir de', c.pontuacao.curtirAcima, { min: 1, max: 12, sufixo: 'pts', onInput: (v) => { c.pontuacao.curtirAcima = v } }))
      g2.appendChild(campoNumero('Passar abaixo de', c.pontuacao.passarAbaixo, { min: 0, max: 12, sufixo: 'pts', dica: 'entre os dois fica a fronteira', onInput: (v) => { c.pontuacao.passarAbaixo = v } }))
      g2.appendChild(campoNumero('Taxa de curtida mínima', Math.round(c.taxaLikeAlvo.min * 100), { min: 0, max: 100, sufixo: '%', onInput: (v) => { c.taxaLikeAlvo.min = (v || 0) / 100 } }))
      g2.appendChild(campoNumero('Taxa de curtida máxima', Math.round(c.taxaLikeAlvo.max * 100), { min: 0, max: 100, sufixo: '%', onInput: (v) => { c.taxaLikeAlvo.max = (v || 0) / 100 } }))
      g2.appendChild(campoNumero('Ruído humano', Math.round(c.ruido * 100), { min: 0, max: 50, sufixo: '%', dica: 'inverte uma fração das decisões de pontuação', onInput: (v) => { c.ruido = (v || 0) / 100 } }))
      body.appendChild(g2)
      page.appendChild(card)
    }

    // ================= 3. ritmo e tetos =================
    {
      const t = D.rascunho.tetos
      const { card, body } = descCard('i-cal', 'Ritmo e tetos', 'O que faz parecer gente: sessões, horários e limite por dia.')
      const g = el('div', 'desc-grid')
      g.appendChild(campoNumero('Swipes por dia', t.porDia, { min: 1, max: 200, onInput: (v) => { t.porDia = v } }))
      g.appendChild(campoNumero('Curtidas por dia', t.curtidasPorDia, { min: 1, max: 200, onInput: (v) => { t.curtidasPorDia = v } }))
      g.appendChild(campoNumero('Sessões por dia (mín)', t.sessoesPorDia[0], { min: 1, max: 12, onInput: (v) => { t.sessoesPorDia[0] = v } }))
      g.appendChild(campoNumero('Sessões por dia (máx)', t.sessoesPorDia[1], { min: 1, max: 12, onInput: (v) => { t.sessoesPorDia[1] = v } }))
      g.appendChild(campoNumero('Tamanho da sessão (mín)', t.tamanhoSessao[0], { min: 1, max: 100, onInput: (v) => { t.tamanhoSessao[0] = v } }))
      g.appendChild(campoNumero('Tamanho da sessão (máx)', t.tamanhoSessao[1], { min: 1, max: 100, onInput: (v) => { t.tamanhoSessao[1] = v } }))
      body.appendChild(g)

      // histograma real do dono, só leitura: é a curva que dá o peso do sorteio
      const hist = el('div', 'desc-hist')
      const max = Math.max(...e.histograma)
      e.histograma.forEach((v, h) => {
        const proibida = e.horasProibidas.includes(h)
        const col = el('div', `desc-hist-col${proibida ? ' off' : ''}`)
        col.title = proibida ? `${h}h — faixa proibida` : `${h}h — ${v} mensagens tuas`
        col.innerHTML = `<i style="height:${Math.max(2, Math.round((v / max) * 46))}px"></i><span>${h % 6 === 0 ? h : ''}</span>`
        hist.appendChild(col)
      })
      body.appendChild(el('span', 'desc-lbl', 'Teus horários reais (as barras apagadas são a faixa onde ele nunca desliza)'))
      body.appendChild(hist)
      page.appendChild(card)
    }

    // ================= 4. passport =================
    {
      const { card, body } = descCard('i-target', 'Localização (passport)', 'Onde a tua conta aparece. Trocar te torna visível naquela cidade.')
      const onde = e.onde
      body.appendChild(el('div', 'desc-onde', onde
        ? `<b>${esc(onde.city || 'sem cidade')}</b><span>${onde.isTraveling ? `viajando — ${onde.offsetMi}mi do teu GPS real` : 'no teu GPS real'}</span>`
        : '<b>desconhecida</b><span>sem token pra consultar</span>'))
      if (e.conta?.endereco) body.appendChild(el('span', 'desc-dica', `endereço resolvido pelo Tinder: ${esc(e.conta.endereco)}`))

      // Os atalhos de cidade são os que ELA salvou, e só. Antes havia uma lista chumbada de
      // fallback (a região do dono anterior): um clique de distância de mandar a conta pra uma
      // cidade sem relação nenhuma com a pessoa. Sem cidade salva, o certo é dizer que não há —
      // o formulário logo abaixo cria a primeira.
      const cidades = el('div', 'desc-chips-list')
      const salvas = e.cidades?.length ? e.cidades : []
      salvas.forEach((c) => {
        const b = el('button', 'desc-chip acao', esc(c.nome))
        b.addEventListener('click', () => trocaPassport(c))
        cidades.appendChild(b)
      })
      body.appendChild(el('span', 'desc-lbl', 'Ir para'))
      if (salvas.length) body.appendChild(cidades)
      else body.appendChild(el('span', 'desc-dica', 'Nenhuma cidade salva ainda. Preencha abaixo e clique em "Ir e salvar" — ela vira atalho aqui.'))

      const manual = el('div', 'desc-inline')
      const iNome = el('input'); iNome.placeholder = 'nome'; iNome.className = 'desc-chip-input'
      const iLat = el('input'); iLat.placeholder = 'latitude'; iLat.className = 'desc-chip-input'; iLat.inputMode = 'decimal'
      const iLon = el('input'); iLon.placeholder = 'longitude'; iLon.className = 'desc-chip-input'; iLon.inputMode = 'decimal'
      const bIr = el('button', 'btn ghost', 'Ir e salvar')
      bIr.addEventListener('click', () => {
        const lat = Number(iLat.value), lon = Number(iLon.value)
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) { toast('coordenadas inválidas', 'err'); return }
        trocaPassport({ nome: iNome.value.trim() || `${lat},${lon}`, lat, lon, salvar: true })
      })
      manual.appendChild(iNome); manual.appendChild(iLat); manual.appendChild(iLon); manual.appendChild(bIr)
      body.appendChild(manual)

      const bReset = el('button', 'btn ghost danger', 'Voltar pro meu GPS real')
      bReset.addEventListener('click', async () => {
        const okReset = await descPergunta({
          titulo: 'Voltar pro GPS real?', perigo: true, confirmar: 'Voltar pro GPS real',
          texto: 'Isso apaga a viagem atual (a cidade onde tua conta aparece) e te devolve pra onde o celular diz que você está.',
        })
        if (!okReset) return
        const r = await post('/api/swipe/passport', { reset: true })
        if (r?.ok) { toast('voltou pro GPS real'); loadDescoberta() } else toast(r?.erro || 'não deu', 'err')
      })
      body.appendChild(bReset)
      page.appendChild(card)
    }

    // ================= 5. perfil do Tinder =================
    {
      const { card, body } = descCard('i-gear', 'Meu perfil no Tinder', 'O que elas veem, e os filtros que o próprio Tinder aplica na fila.')
      body.appendChild(el('span', 'desc-dica', 'carregando perfil…'))
      page.appendChild(card)
      carregaPerfil(body)
    }

    // ================= 6. quem já te curtiu =================
    {
      const { card, body } = descCard('i-heart', 'Já te curtiram', 'Curtir de volta é match na hora. A decisão que o critério daria vem ao lado.')
      body.appendChild(el('span', 'desc-dica', 'carregando…'))
      page.appendChild(card)
      carregaCurtiram(body)
    }

    // ================= 7. decisões =================
    {
      const { card, body } = descCard('i-inbox', 'Decisões', 'Toda decisão com o motivo. "sombra" = julgou e não enviou.')
      const tab = el('div', 'desc-log')
      const decs = e.decisoes || []
      if (!decs.length) tab.appendChild(el('span', 'desc-dica', 'nenhuma decisão ainda'))
      decs.forEach((d) => {
        const linha = el('div', `desc-log-linha ${d.decision}`)
        linha.innerHTML = `
          <span class="dl-dec">${d.decision === 'like' ? 'curtiu' : d.decision === 'pass' ? 'passou' : esc(d.decision)}</span>
          <span class="dl-nome">${esc(d.name || 'sem nome')}${d.age ? `, ${d.age}` : ''}</span>
          <span class="dl-motivo">${esc(d.reason || '')}</span>
          <span class="dl-quando">${d.sent_at ? 'enviada' : 'sombra'} · ${timeAgo(d.decided_at)}</span>`
        tab.appendChild(linha)
      })
      body.appendChild(tab)
      page.appendChild(card)
    }

    // ---------- barra de salvar (fica grudada no rodapé) ----------
    const barra = el('div', 'desc-savebar')
    const bSalvar = el('button', 'btn', 'Salvar mudanças')
    bSalvar.id = 'descSalvar'
    bSalvar.disabled = !D.sujo
    bSalvar.addEventListener('click', salvaConfig)
    const bPadrao = el('button', 'btn ghost', 'Restaurar padrão')
    bPadrao.addEventListener('click', async () => {
      const okPadrao = await descPergunta({ titulo: 'Restaurar o padrão?', texto: 'Critérios e tetos voltam pros valores de fábrica. As decisões já tomadas continuam no histórico.', confirmar: 'Restaurar' })
      if (!okPadrao) return
      const r = await post('/api/swipe/config', { criterios: {}, tetos: {} })
      if (r?.ok) { toast('padrão restaurado'); loadDescoberta() } else toast('não deu', 'err')
    })
    barra.appendChild(bPadrao); barra.appendChild(bSalvar)
    page.appendChild(barra)

    host.replaceChildren(page)
  }

  async function salvaConfig() {
    const r = await fetch('/api/swipe/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ criterios: D.rascunho.criterios, tetos: D.rascunho.tetos }),
    })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j?.ok) {
      const msg = (j?.erros || []).map((x) => x.msg).join(' · ') || 'não deu pra salvar'
      toast(msg, 'err')
      return
    }
    ;(j.avisos || []).forEach((a) => toast(a, 'err'))
    toast('critérios salvos')
    D.sujo = false
    loadDescoberta()
  }

  // liga/desliga direto (sem passar pela barra de salvar)
  async function salvaDireto(patch) {
    const r = await post('/api/swipe/config', Object.assign({ criterios: D.rascunho.criterios, tetos: D.rascunho.tetos }, patch))
    if (r?.ok) { toast('pronto'); loadDescoberta() } else toast((r?.erros || [])[0]?.msg || 'não deu', 'err')
  }

  // Sair do modo sombra é o único passo irreversível: pede a palavra escrita.
  async function confirmaAoVivo() {
    const ok = await descPergunta({
      titulo: 'Deslizar de verdade?', perigo: true, tipo: 'texto', exige: 'DESLIZAR',
      placeholder: 'DESLIZAR', confirmar: 'Ligar ao vivo',
      texto: 'A partir daqui o vendas-multicanal curte e passa sozinho na tua conta, nos horários sorteados. Escreve DESLIZAR pra confirmar.',
    })
    if (!ok) { toast('cancelado — continua em modo sombra'); loadDescoberta(); return }
    const r = await post('/api/swipe/config', { criterios: D.rascunho.criterios, tetos: D.rascunho.tetos, sombra: false, confirmaAoVivo: true })
    if (r?.ok) { toast('auto-deslizar AO VIVO'); loadDescoberta() } else toast('não deu', 'err')
  }

  async function rodarAgora() {
    const e = D.estado
    const resp = await descPergunta({
      titulo: 'Rodar uma sessão agora', tipo: 'numero', valor: '15', sufixo: 'perfis', confirmar: 'Rodar',
      texto: e.sombra ? 'Modo sombra: ela julga e registra o motivo, sem tocar no Tinder.' : 'MODO AO VIVO: cada decisão vira swipe real.',
    })
    const tamanho = Number(resp)
    if (!tamanho || !Number.isFinite(tamanho)) return
    const corpo = { tamanho, sombra: e.sombra }
    if (!e.sombra) {
      const ok = await descPergunta({ titulo: 'Sessão ao vivo', perigo: true, confirmar: 'Deslizar de verdade', texto: `Vai deslizar pra valer em até ${tamanho} perfis, com o ritmo humano (leva minutos).` })
      if (!ok) return
      corpo.confirmaAoVivo = true
    }
    const r = await post('/api/swipe/rodar', corpo)
    if (r?.ok) toast(`sessão iniciada (${tamanho} perfis, ${e.sombra ? 'sombra' : 'ao vivo'}) — leva minutos por causa do ritmo`)
    else toast(r?.erro || 'não deu', 'err')
  }

  async function trocaPassport(c) {
    const ok = await descPergunta({ titulo: `Ir pra ${c.nome}?`, confirmar: 'Ir', texto: 'Teu perfil passa a aparecer nessa cidade, e a fila vem de lá. Curtida dada lá continua valendo depois que você voltar.' })
    if (!ok) return
    const r = await post('/api/swipe/passport', { lat: c.lat, lon: c.lon, nome: c.nome, salvar: c.salvar })
    if (r?.ok) { toast(`passport em ${c.nome}`); loadDescoberta() } else toast(r?.erro || 'não deu', 'err')
  }

  async function carregaPerfil(body) {
    const r = await api('/api/tinder/perfil')
    body.replaceChildren()
    if (!r?.ok) { body.appendChild(el('span', 'desc-dica', r?.erro ? `não deu pra ler: ${r.erro}` : 'sem token do Tinder')); return }
    const p = r.perfil
    const rascunho = { bio: p.bio, idadeMin: p.idadeMin, idadeMax: p.idadeMax, raio: p.raio, descobrivel: p.descobrivel, topPicks: p.topPicks }
    if (p.completo != null) {
      // o Tinder devolve as chaves cruas em inglês; a tela mostra em português
      const NOMES = {
        company: 'empresa', job_title: 'cargo', descriptors_sec_1: 'descritores', media: 'fotos e vídeos',
        passions: 'interesses', living_in: 'cidade onde mora', instagram: 'Instagram', sticker_hub: 'figurinhas',
        spotify_anthem: 'hino do Spotify', top_spotify_artist: 'artista do Spotify', photos: 'mais fotos',
        bio: 'bio', school: 'escola', height: 'altura', anthem: 'hino',
      }
      const falta = (p.falta || []).slice(0, 7).map((f) => (NOMES[f.chave] || f.chave) + (f.ganho && f.ganho.startsWith('+') ? ` ${f.ganho}` : ''))
      body.appendChild(el('div', 'desc-meter', `<b>${p.completo}% completo</b><span>${falta.length ? 'falta: ' + esc(falta.join(', ')) : 'nada faltando'}</span>`))
    }
    const bio = el('textarea', 'desc-bio')
    bio.value = p.bio || ''; bio.rows = 5; bio.maxLength = 500
    bio.addEventListener('input', () => { rascunho.bio = bio.value })
    body.appendChild(el('span', 'desc-lbl', 'Bio'))
    body.appendChild(bio)
    const g = el('div', 'desc-grid')
    g.appendChild(campoNumero('Idade mínima', p.idadeMin, { min: 18, max: 100, sufixo: 'anos', onInput: (v) => { rascunho.idadeMin = v } }))
    g.appendChild(campoNumero('Idade máxima', p.idadeMax, { min: 18, max: 100, sufixo: 'anos', onInput: (v) => { rascunho.idadeMax = v } }))
    g.appendChild(campoNumero('Raio de busca', p.raio, { min: 1, max: 100, sufixo: 'mi', dica: 'é o filtro do próprio Tinder, que monta a fila', onInput: (v) => { rascunho.raio = v } }))
    body.appendChild(g)
    body.appendChild(campoSwitch('Aparecer no Tinder', p.descobrivel, 'desligado, ninguém novo te vê', (v) => { rascunho.descobrivel = v }))
    body.appendChild(campoSwitch('Aparecer em Top Picks', p.topPicks, '', (v) => { rascunho.topPicks = v }))
    const b = el('button', 'btn', 'Salvar no Tinder')
    b.addEventListener('click', async () => {
      const resp = await fetch('/api/tinder/perfil', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rascunho) })
      const j = await resp.json().catch(() => null)
      if (resp.ok && j?.ok) toast('perfil atualizado no Tinder')
      else toast((j?.erros || [])[0]?.msg || j?.erro || 'não deu', 'err')
    })
    body.appendChild(b)
  }

  async function carregaCurtiram(body) {
    const r = await api('/api/swipe/curtiram')
    body.replaceChildren()
    if (!r?.ok) { body.appendChild(el('span', 'desc-dica', r?.erro ? `não deu pra ler: ${r.erro}` : 'sem token do Tinder')); return }
    if (!r.pessoas.length) { body.appendChild(el('span', 'desc-dica', 'ninguém na fila agora')); return }
    const grade = el('div', 'desc-pessoas')
    r.pessoas.forEach((p) => {
      const c = el('article', 'desc-pessoa')
      c.innerHTML = `
        <div class="dp-foto" ${p.fotos[0] ? `style="background-image:url('${esc(p.fotos[0])}')"` : ''}></div>
        <div class="dp-info">
          <b>${esc(p.nome)}${p.idade ? `, ${p.idade}` : ''}</b>
          <span class="dp-meta">${p.distancia != null ? `${p.distancia}mi` : ''}${p.verificada ? ' · verificada' : ''}${p.intencao ? ` · ${esc(p.intencao)}` : ''}</span>
          <span class="dp-bio">${esc((p.bio || '').slice(0, 110))}</span>
          <span class="dp-veredito ${p.decisao}">${p.decisao === 'like' ? 'o critério curtiria' : p.decisao === 'fronteira' ? 'fronteira' : 'o critério passaria'}: ${esc(p.motivo)}</span>
        </div>`
      const acoes = el('div', 'dp-acoes')
      if (p.jaDecidida) acoes.appendChild(el('span', 'desc-dica', 'já deslizada'))
      else {
        const bLike = el('button', 'btn sm', 'Curtir')
        bLike.addEventListener('click', () => manualSwipe(p, 'like', c))
        const bPass = el('button', 'btn ghost sm', 'Passar')
        bPass.addEventListener('click', () => manualSwipe(p, 'pass', c))
        acoes.appendChild(bLike); acoes.appendChild(bPass)
      }
      c.appendChild(acoes)
      grade.appendChild(c)
    })
    body.appendChild(grade)
  }

  async function manualSwipe(p, decisao, card) {
    const ok = await descPergunta({
      titulo: `${decisao === 'like' ? 'Curtir' : 'Passar'} ${p.nome}?`, perigo: decisao === 'pass',
      confirmar: decisao === 'like' ? 'Curtir' : 'Passar',
      texto: decisao === 'like' ? 'Swipe real. Se ela já te curtiu, vira match na hora.' : 'Swipe real, e não tem desfazer por aqui.',
    })
    if (!ok) return
    const r = await post('/api/swipe/manual', { userId: p.id, decisao })
    if (r?.ok) {
      toast(r.match ? `MATCH com ${p.nome}` : (decisao === 'like' ? 'curtida enviada' : 'passou'))
      card.classList.add('feita')
      card.querySelector('.dp-acoes').replaceChildren(el('span', 'desc-dica', r.match ? 'match' : 'feito'))
    } else toast(r?.erro || 'não deu', 'err')
  }

  $('#btnDescoberta').addEventListener('click', () => setTab('descoberta'))
  $('#descVoltar').addEventListener('click', () => setTab('pessoas'))

  // ================================================================ ASSISTENTE
  // A conversa dele COM o vendas-multicanal. Mesma thread do self-chat do WhatsApp: o que ele
  // manda no celular aparece aqui e vice-versa (o banco é a fonte única).
  const ASSIST = { carregando: false, enviando: false, ligado: true, proativo: null }

  function marcarAssistenteNovo() {
    const b = $('#tabAssistente')
    if (!b) return
    b.hidden = false
    b.textContent = '1'
  }

  function acaoChip(a) {
    const estados = { feita: 'ok', erro: 'err', pendente: 'warn', desfeita: 'off', cancelada: 'off' }
    const cls = estados[a.estado] || ''
    const botoes = []
    if (a.estado === 'feita' && a.temDesfazer) botoes.push(`<button type="button" class="btn tiny" data-assist-desfazer="${esc(a.id)}">Desfazer</button>`)
    if (a.estado === 'pendente') {
      botoes.push(`<button type="button" class="btn tiny primary" data-assist-confirmar="${esc(a.id)}">${a.nivel === 'sistema' ? 'Permitir' : 'Pode mandar'}</button>`)
      botoes.push(`<button type="button" class="btn tiny" data-assist-cancelar="${esc(a.id)}">Não</button>`)
    }
    const saida = a.resultado && a.resultado.saida ? `<pre class="assist-saida">${esc(String(a.resultado.saida).slice(0, 1200))}</pre>` : ''
    return `<div class="assist-acao ${cls}">
      <div class="assist-acao-txt"><b>${esc(a.nome.replace(/_/g, ' '))}</b> ${esc(a.resumo || '')}${a.erro ? ` — ${esc(a.erro)}` : ''}</div>
      ${botoes.length ? `<div class="assist-acao-btns">${botoes.join('')}</div>` : ''}
      ${saida}
    </div>`
  }

  function renderAssistente(d) {
    const host = $('#assistThread')
    if (!host) return
    const msgs = d.mensagens || []
    host.innerHTML = msgs.length
      ? msgs.map((m) => `
        <div class="assist-msg ${m.papel === 'humano' ? 'eu' : 'msg-ia'}">
          <div class="assist-bolha">${esc(m.texto).replace(/\n/g, '<br>')}</div>
          <div class="assist-meta">${clockTime(m.ts)}${m.origem === 'whatsapp' ? ' · whatsapp' : m.origem === 'sistema' ? ' · sozinho' : ''}</div>
        </div>
        ${(m.acoes || []).length ? `<div class="assist-acoes">${m.acoes.map(acaoChip).join('')}</div>` : ''}`).join('')
      : `<div class="assist-vazio">
           <p>fala comigo. exemplos:</p>
           <ul>
             <li>marca dentista quinta 9h</li>
             <li>me lembra de pagar o cartão dia 5 todo mês</li>
             <li>quem tá esperando resposta</li>
             <li>o que eu tenho hoje</li>
             <li>desliga a IA da Ana no whatsapp</li>
             <li><b>ia off</b> me desliga aqui, <b>ia on</b> me traz de volta</li>
           </ul>
         </div>`
    host.scrollTop = host.scrollHeight
    const p = d.proativo || {}
    // switches são o componente do painel (button role=switch), nunca checkbox nativo
    const sw = (id, on, rotulo) => `<span class="assist-sw">
      <button class="toggle sm" role="switch" id="${id}" aria-checked="${on ? 'true' : 'false'}" aria-label="${esc(rotulo)}"></button>
      <span>${esc(rotulo)}</span></span>`
    $('#assistHint').innerHTML = `
      ${sw('assistLigado', d.ligado, 'assistente ligado')}
      ${sw('assistDia', p.compromissos_do_dia, 'me manda o dia às')}
      <input type="text" class="assist-hora" id="assistHora" inputmode="numeric" maxlength="5"
             value="${esc(p.hora_do_resumo || '08:00')}" aria-label="hora do resumo do dia">
      ${sw('assistAlertas', p.alertas_de_sistema, 'me avisa se algo cair')}
      ${sw('assistRespostas', p.avisos_de_resposta, 'me avisa quando alguém responder')}`
    const vira = (el2) => { const novo = el2.getAttribute('aria-checked') !== 'true'; el2.setAttribute('aria-checked', String(novo)); return novo }
    $('#assistLigado').addEventListener('click', (e) => salvarAssistConfig({ ligado: vira(e.currentTarget) }))
    $('#assistDia').addEventListener('click', (e) => salvarAssistConfig({ proativo: { compromissos_do_dia: vira(e.currentTarget) } }))
    $('#assistAlertas').addEventListener('click', (e) => salvarAssistConfig({ proativo: { alertas_de_sistema: vira(e.currentTarget) } }))
    $('#assistRespostas').addEventListener('click', (e) => salvarAssistConfig({ proativo: { avisos_de_resposta: vira(e.currentTarget) } }))
    const hora = $('#assistHora')
    // máscara nossa: digita só número e o ':' entra sozinho (o seletor nativo de hora
    // muda de cara e de formato conforme o navegador, e a regra aqui é componente nosso)
    hora.addEventListener('input', () => {
      const d = hora.value.replace(/\D/g, '').slice(0, 4)
      hora.value = d.length <= 2 ? d : `${d.slice(0, 2)}:${d.slice(2)}`
    })
    hora.addEventListener('blur', () => {
      const m = hora.value.match(/^(\d{1,2}):?(\d{2})$/)
      if (!m) { hora.value = (ASSIST.proativo && ASSIST.proativo.hora_do_resumo) || '08:00'; return }
      const hh = String(Math.min(23, Number(m[1]))).padStart(2, '0')
      const mm = String(Math.min(59, Number(m[2]))).padStart(2, '0')
      hora.value = `${hh}:${mm}`
      salvarAssistConfig({ proativo: { hora_do_resumo: hora.value } })
    })
  }

  async function salvarAssistConfig(patch) {
    const r = await post('/api/assistente/config', patch)
    if (r?.ok) toast('anotado')
    else toast('não deu pra salvar', 'err')
  }

  async function loadAssistente({ manterFoco = false } = {}) {
    if (ASSIST.carregando) return
    ASSIST.carregando = true
    const b = $('#tabAssistente'); if (b) b.hidden = true
    try {
      const d = await api('/api/assistente')
      if (d) { ASSIST.ligado = d.ligado; ASSIST.proativo = d.proativo; renderAssistente(d) }
    } finally {
      ASSIST.carregando = false
      if (!manterFoco) { const i = $('#assistInput'); if (i && !isMobileLayout()) i.focus() }
    }
  }

  async function mandarAssistente(texto, { origem = 'aba' } = {}) {
    const t = String(texto || '').trim()
    if (!t || ASSIST.enviando) return null
    ASSIST.enviando = true
    try { return await post('/api/assistente/falar', { texto: t }) } finally { ASSIST.enviando = false }
  }

  const assistInput = $('#assistInput')
  if (assistInput) {
    assistInput.addEventListener('input', () => { assistInput.style.height = 'auto'; assistInput.style.height = Math.min(140, assistInput.scrollHeight) + 'px' })
    assistInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#assistSend').click() }
    })
  }
  const assistSend = $('#assistSend')
  if (assistSend) {
    assistSend.addEventListener('click', async () => {
      const i = $('#assistInput')
      const t = i.value.trim()
      if (!t) return
      i.value = ''; i.style.height = 'auto'
      assistSend.disabled = true
      const host = $('#assistThread')
      host.insertAdjacentHTML('beforeend', `<div class="assist-msg eu"><div class="assist-bolha">${esc(t)}</div></div><div class="assist-msg vendas-multicanal pensando"><div class="assist-bolha">pensando…</div></div>`)
      host.scrollTop = host.scrollHeight
      const r = await mandarAssistente(t)
      assistSend.disabled = false
      if (!r || !r.ok) {
        const porque = r?.motivo === 'desligado' ? 'o assistente está desligado (manda "ia on")'
          : r?.motivo === 'disjuntor' ? 'muita mensagem em pouco tempo, espera um minuto'
          : 'não consegui responder'
        toast(porque, 'err')
      }
      await loadAssistente({ manterFoco: true })
      $('#assistInput').focus()
    })
  }

  document.addEventListener('click', async (e) => {
    const dz = e.target.closest('[data-assist-desfazer]')
    const cf = e.target.closest('[data-assist-confirmar]')
    const cc = e.target.closest('[data-assist-cancelar]')
    if (!dz && !cf && !cc) return
    const btn = dz || cf || cc
    const id = btn.dataset.assistDesfazer || btn.dataset.assistConfirmar || btn.dataset.assistCancelar
    const rota = dz ? 'desfazer' : cf ? 'confirmar' : 'cancelar'
    btn.disabled = true
    const r = await post(`/api/assistente/acao/${encodeURIComponent(id)}/${rota}`, {})
    toast(r?.texto || (r?.ok ? 'feito' : 'não deu'), r?.ok ? 'ok' : 'err')
    await loadAssistente({ manterFoco: true })
  })

  // ---------------------------------------------------------------- barra de comando
  // Ctrl/Cmd+K de qualquer aba: manda pro mesmo assistente e mostra a resposta ali.
  const cmdOverlay = $('#cmdOverlay')
  function abrirCmd() {
    if (!cmdOverlay) return
    cmdOverlay.hidden = false
    $('#cmdOut').hidden = true
    $('#cmdInput').value = ''
    setTimeout(() => $('#cmdInput').focus(), 10)
  }
  function fecharCmd() { if (cmdOverlay) cmdOverlay.hidden = true }
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); abrirCmd() }
    else if (e.key === 'Escape' && cmdOverlay && !cmdOverlay.hidden) fecharCmd()
  })
  if (cmdOverlay) {
    cmdOverlay.addEventListener('click', (e) => { if (e.target === cmdOverlay) fecharCmd() })
    $('#cmdInput').addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return
      const t = $('#cmdInput').value.trim()
      if (!t) return
      const out = $('#cmdOut')
      out.hidden = false
      out.textContent = 'pensando…'
      $('#cmdInput').value = ''
      const r = await mandarAssistente(t, { origem: 'cmd' })
      out.textContent = r?.resposta || (r?.motivo === 'desligado' ? 'o assistente está desligado (manda "ia on" aqui pra voltar)'
        : r?.motivo === 'disjuntor' ? 'muita mensagem em pouco tempo, espera um minuto' : 'não consegui responder')
      if (S.tab === 'assistente') loadAssistente({ manterFoco: true })
    })
  }

  // ---------------------------------------------------------------- boot
  // volta do OAuth da Google Agenda: mostra o resultado e abre a aba.
  const asearch = new URLSearchParams(location.search)
  const returningFromAgenda = asearch.has('agenda')
  if (returningFromAgenda) {
    const r = asearch.get('agenda')
    setTimeout(() => {
      if (r === 'connected') { toast('Google Agenda conectada'); setTab('agenda') }
      else if (r === 'config') { toast('integração ainda não configurada', 'err'); setTab('agenda') }
      else { toast('não deu pra conectar a agenda', 'err'); setTab('agenda') }
    }, 300)
    history.replaceState(null, '', location.pathname)
  }
  loadState()
  if (isMobileLayout() && !returningFromAgenda) setTab('hoje')
  else loadPeople()
  connectWs()
  // fallback: revalida o estado a cada 25s mesmo sem WebSocket
  setInterval(loadState, 25000)
})()
