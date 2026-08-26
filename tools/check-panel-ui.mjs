import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const css = fs.readFileSync(path.join(root, 'src/panel/public/style.css'), 'utf8')
const js = fs.readFileSync(path.join(root, 'src/panel/public/panel.js'), 'utf8')
const server = fs.readFileSync(path.join(root, 'src/index.mjs'), 'utf8')
const selfRoutes = fs.readFileSync(path.join(root, 'src/self/routes.mjs'), 'utf8')
const rotina = fs.readFileSync(path.join(root, 'src/self/rotina.mjs'), 'utf8')
const prompt = fs.readFileSync(path.join(root, 'src/ai/prompt.mjs'), 'utf8')
const autoreply = fs.readFileSync(path.join(root, 'src/tinder/autoreply.mjs'), 'utf8')
const assistenteContexto = fs.readFileSync(path.join(root, 'src/assistente/contexto.mjs'), 'utf8')
const conversasRoutes = fs.readFileSync(path.join(root, 'src/conversas/rotas.mjs'), 'utf8')

function fail(message) {
  console.error(`UI check failed: ${message}`)
  process.exitCode = 1
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function token(name) {
  const pattern = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'gi')
  const values = [...css.matchAll(pattern)]
  assert(values.length > 0, `missing hexadecimal token --${name}`)
  return values.at(-1)?.[1]
}

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => {
    const channel = Number.parseInt(value, 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrast(foreground, background) {
  const light = Math.max(luminance(foreground), luminance(background))
  const dark = Math.min(luminance(foreground), luminance(background))
  return (light + 0.05) / (dark + 0.05)
}

const contrastPairs = [
  ['texto principal / célula', 'ink', 'cal-cell-bg', 4.5],
  ['texto principal / célula hover', 'ink', 'cal-cell-hover', 4.5],
  ['texto principal / célula selecionada', 'ink', 'cal-cell-selected', 4.5],
  ['dia fora do mês / célula externa', 'cal-day-out', 'cal-cell-out', 4.5],
  ['dia fora do mês / hover', 'cal-day-out', 'cal-cell-hover', 4.5],
  ['texto secundário / painel', 'ink-dim', 'panel', 4.5],
  ['texto do destaque / destaque', 'accent-ink', 'accent', 4.5],
  // Selos de canal nos cartões de identidade (aba Vínculos): texto de 11px sobre o painel.
  ['selo WhatsApp / painel', 'wa', 'panel', 4.5],
  ['selo Instagram / painel', 'ig-txt', 'panel', 4.5],
  ['selo Tinder / painel', 'love', 'panel', 4.5],
]

for (const [label, foregroundName, backgroundName, minimum] of contrastPairs) {
  const ratio = contrast(token(foregroundName), token(backgroundName))
  assert(ratio >= minimum, `${label} has ${ratio.toFixed(2)}:1; expected at least ${minimum}:1`)
  if (ratio >= minimum) console.log(`✓ ${label}: ${ratio.toFixed(2)}:1`)
}

const calendarRule = css.match(/\.cal-cell\s*\{([^}]*)\}/s)?.[1] ?? ''
assert(/appearance:\s*none/.test(calendarRule), 'calendar buttons must reset native appearance')
assert(/background:\s*var\(--cal-cell-bg\)/.test(calendarRule), 'calendar cells need an explicit base background')
assert(!/\.cal-cell\.out\s*\{[^}]*opacity\s*:/s.test(css), 'out-of-month state must not reduce all content with opacity')
assert(/\.agenda-expired-list\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s.test(css), 'hidden expired list must override flex display')

assert(/setExpiredOpen\(false\)/.test(js), 'expired commitments must start collapsed')
assert(/expiredList\.hidden\s*=\s*!open/.test(js), 'expired list visibility must follow disclosure state')
assert(/setAttribute\('aria-expanded',\s*String\(open\)\)/.test(js), 'expired disclosure must synchronize aria-expanded')
assert(/setAttribute\('aria-controls',\s*expiredList\.id\)/.test(js), 'expired disclosure must identify the controlled region')
assert(/function renderAgendaSidebar\(key,\s*evs\)/.test(js), 'selected calendar day must control the agenda sidebar')
assert(/Dia selecionado/.test(js) && /Voltar para compromissos a revisar/.test(js), 'selected-day sidebar needs context and a clear return action')
assert(/openAgendaEvent\(ev\)/.test(js), 'calendar events must open their management details')
assert(/method:\s*'PATCH'/.test(js) && /method:\s*'DELETE'/.test(js), 'event editor must connect edit and cancel actions')
assert(/\/api\/agenda\/events\//.test(server) && /agendaUpdateEvent/.test(server) && /agendaDeleteEvent/.test(server), 'event management routes must stay connected to Google Agenda')

const declaredFunctions = [...js.matchAll(/\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)].map((match) => match[1])
const duplicateFunctions = [...new Set(declaredFunctions.filter((name, index) => declaredFunctions.indexOf(name) !== index))]
assert(duplicateFunctions.length === 0, `duplicate function declarations can silently override navigation: ${duplicateFunctions.join(', ')}`)

if (!process.exitCode) console.log('✓ calendar and disclosure invariants')

assert(/Mandar primeira mensagem/.test(js), 'unmessaged matches need a direct first-message action')
assert(/selectedOpeners:\s*new Set\(\)/.test(js), 'bulk opener selection must use canonical person ids')
assert(/\/api\/tinder\/openers/.test(js) && /\/api\/tinder\/openers/.test(server), 'bulk opener UI and endpoint must stay connected')
assert(/conversationState === 'unmessaged'/.test(server), 'the first-message filter must use the verified conversation state')
assert(/min-height:\s*42px/.test(css), 'first-message actions need comfortable click targets')

if (!process.exitCode) console.log('✓ direct and bulk first-message actions')

// ---- Config em grupos (12/08/2026) -------------------------------------------------------
// A Config tinha 14 seções empilhadas (7.660px, 8,5 telas). Agora cada seção mora num grupo e
// só um grupo aparece por vez. As duas coisas que quebram isso EM SILÊNCIO:
//
//   1. seção nova que ninguém pôs num grupo: ela é construída, os listeners ligam, e ela
//      simplesmente nunca aparece. Nada dá erro;
//   2. o botão "Ler documento" voltar a existir só no CSS do celular: o texto nasce fechado
//      nos dois tamanhos, então sem o botão no desktop o documento fica fechado PRA SEMPRE.
const secoesDeclaradas = [...js.matchAll(/\bS_\.([A-Za-z0-9_]+)\s*=\s*configSection\(/g)].map((m) => m[1])
const secoesEmGrupo = [...js.matchAll(/secoes:\s*\[([^\]]*)\]/g)]
  .flatMap((m) => [...m[1].matchAll(/S_\.([A-Za-z0-9_]+)/g)].map((x) => x[1]))
assert(secoesDeclaradas.length >= 12, 'the config page should still declare its sections through S_')
const orfas = secoesDeclaradas.filter((k) => !secoesEmGrupo.includes(k))
assert(orfas.length === 0, `config sections outside every group are built but never shown: ${orfas.join(', ')}`)
const fantasmas = secoesEmGrupo.filter((k) => !secoesDeclaradas.includes(k))
assert(fantasmas.length === 0, `groups point at sections that do not exist: ${fantasmas.join(', ')}`)
assert(/const GRUPOS = \[/.test(js) && /function abrirGrupoConfig/.test(js), 'the config group switcher must stay in place')
assert(/S\.cfgGrupo/.test(js), 'the chosen config group must survive a reload of the page')
assert(/if \(id === 'midia'\)[\s\S]{0,120}desenharLinhas\(\)/.test(js),
  'the photo/need lines are drawn by measurement: they must be redrawn when their group appears')

// Tira TODO bloco @media (contando chaves): `split('@media')[0]` só pegava o começo do
// arquivo e daria verde pra uma regra escrita depois da primeira media query.
function semMediaQueries(fonte) {
  let saida = '', i = 0
  while (i < fonte.length) {
    const m = fonte.indexOf('@media', i)
    if (m === -1) { saida += fonte.slice(i); break }
    saida += fonte.slice(i, m)
    let j = fonte.indexOf('{', m), nivel = 0
    if (j === -1) break
    for (; j < fonte.length; j++) {
      if (fonte[j] === '{') nivel++
      else if (fonte[j] === '}' && --nivel === 0) { j++; break }
    }
    i = j
  }
  return saida
}
const foraDeMedia = semMediaQueries(css)
assert(/\.cfg-doc-toggle\s*\{[^}]*display:\s*flex/.test(foraDeMedia),
  'the "Ler documento" button must exist outside the mobile media query, or the collapsed text can never be opened')
assert(/\{\n\s*body\.hidden = true/.test(js) || /body\.hidden = true/.test(js), 'knowledge documents must start collapsed')

if (!process.exitCode) console.log('✓ config groups and document disclosure')

// ---- Rotina de cada instância ---------------------------------------------------------
// A seção não pode ser só formulário: precisa persistir, editar, mostrar o que vale agora e
// chegar ao gerador único. O seletor de horário continua sendo componente nosso.
assert(/S_\.rotina\s*=\s*configSection\(/.test(js), 'Config → Você precisa declarar a seção Rotina')
assert(/secoes:\s*\[S_\.sobremim,\s*S_\.rotina,/.test(js), 'Rotina precisa aparecer junto de Sobre mim no grupo Você')
assert(/function abrirEditorRotina/.test(js) && /Adicionar à rotina/.test(js), 'Rotina precisa ter um fluxo visível de cadastro')
assert(/data-editar>Editar/.test(js) && /data-apagar>Apagar/.test(js), 'cada horário da rotina precisa poder ser editado e apagado')
assert(/post\('\/api\/self\/rotina',\s*\{/.test(js), 'editor da rotina precisa salvar pela API')
assert(/id:\s*atual\?\.id\s*\|\|\s*undefined/.test(js), 'edição da rotina precisa preservar o id do item')
assert(/dias:\s*\[\.\.\.escolhidos\]/.test(js) && /detalhes:/.test(js) && /local:/.test(js), 'a UI precisa salvar dias, trabalho/detalhes e local')
assert(!/rotina[^\n]{0,100}<input[^>]+type=["']time["']/i.test(js), 'Rotina deve usar o seletor de horário do painel, não o controle nativo')
assert(/p === '\/api\/self\/rotina' && method === 'GET'/.test(selfRoutes), 'API precisa listar a rotina')
assert(/p === '\/api\/self\/rotina' && method === 'POST'/.test(selfRoutes), 'API precisa salvar a rotina')
assert(/p\.startsWith\('\/api\/self\/rotina\/'\) && method === 'DELETE'/.test(selfRoutes), 'API precisa apagar um horário da rotina')
assert(/export function rotinaBlock/.test(rotina) && /não confirmação em tempo real/.test(rotina), 'rotina precisa produzir contexto com ressalva de plano recorrente')
assert(/input\.rotinaContext \? cleanText\(input\.rotinaContext/.test(prompt), 'prompt precisa aceitar o contexto de rotina apenas quando existir')
assert(/rotinaContext = rotinaBlock\(\)/.test(autoreply) && /rotinaContext, personObjective/.test(autoreply), 'gerador único precisa carregar a rotina para todos os canais')
assert(/rotina = rotinaBlock\(\)/.test(assistenteContexto), 'assistente pessoal também precisa conhecer a rotina declarada')
assert(/\.rotina-item\s*\{/.test(css) && /\.rotina-editor\s*\{/.test(css), 'Rotina precisa de componentes visuais próprios')

if (!process.exitCode) console.log('✓ rotina visível, editável e conectada ao contexto da IA')

assert(/id="sobreMimExtrair"/.test(js), 'Sobre mim precisa ter o botão de extração ampla')
assert(/\/api\/self\/sobre-mim\/extrair/.test(js), 'botão do Sobre mim precisa chamar a rota ampla')
assert(/\/api\/self\/sobre-mim\/extrair/.test(selfRoutes), 'rota ampla do Sobre mim precisa existir no servidor')
assert(/\.sobre-mim-extrator\s*\{/.test(css), 'extração do Sobre mim precisa de componente visual próprio')
assert(/total remoto não é informado/.test(js), 'a tela não pode apresentar o WhatsApp parcial como total')
assert(/Modo quente:/.test(js), 'resultado da extração precisa declarar a cobertura do modo quente')

if (!process.exitCode) console.log('✓ extração ampla do Sobre mim conectada e cobertura honesta')

// ---- Cobrança por pessoa ---------------------------------------------------------------
// A autorização não pode existir como toggle cego: o Tim precisa receber a justificativa
// factual do usuário, e todos os canais devem abrir o mesmo editor dessa regra.
assert(/id="cobrancaMotivoInput"/.test(js), 'a UI precisa ter um campo explícito para o motivo da cobrança')
assert(/for="cobrancaMotivoInput">Por que esta pessoa deve pagar\?/.test(js), 'o campo deve explicar claramente qual justificativa será usada')
assert(/id="cobrancaMotivoInput" maxlength="500"/.test(js), 'o motivo precisa ter limite compatível com o backend')
assert(/post\('\/api\/self\/cobranca\/autorizar', \{ personId, enabled, motivo \}\)/.test(js), 'a UI deve enviar autorização e motivo juntos')
assert(/wireCobrancaHeadToggle\([^\n]+WhatsApp/.test(js) && /wireCobrancaHeadToggle\([^\n]+Instagram/.test(js), 'WhatsApp e Instagram devem usar o editor compartilhado de cobrança')
assert(/openCobrancaEditor\(\{[\s\S]{0,220}personId: S\.open/.test(js), 'o Tinder deve abrir o editor de motivo da cobrança')
// Badoo, Telegram e Meu Patrocínio usam o MESMO gerador de rascunho, que lê a regra por
// personId. Canal com IA e sem interruptor de cobrança não é canal sem cobrança: é canal
// onde ela existe e ninguém consegue autorizar.
assert(/wireCobrancaHeadToggle\([^\n]+'Badoo'/.test(js), 'o Badoo deve usar o editor compartilhado de cobrança')
assert(/wireCobrancaHeadToggle\([^\n]+cfg\.nome/.test(js), 'Telegram e Meu Patrocínio devem usar o editor compartilhado de cobrança')
assert(/pid: 'tg:'/.test(js) && /pid: 'mp:'/.test(js), 'os canais simples precisam declarar o prefixo de personId que a cobrança usa')
const cabecalhosIa = (js.match(/wc-head-toggle wc-ai-toggle/g) || []).length
const cabecalhosCobr = (js.match(/wc-head-toggle wc-cobr-toggle/g) || []).length
assert(cabecalhosIa >= 4 && cabecalhosCobr === cabecalhosIa,
  `todo cabeçalho de conversa com interruptor de IA precisa ter também o de cobrança (IA: ${cabecalhosIa}, cobrança: ${cabecalhosCobr})`)
assert(!/class="wc-ai-toggle"/.test(js), 'cabeçalho de conversa não pode usar o interruptor de IA solto: ele tem que estar dentro de .wc-head-toggles, ao lado do de cobrança')
assert(/salvarCobrancaPessoa\(b\.personId, \{ enabled: !!b\.enabled, motivo: b\.motivo \}\)/.test(selfRoutes), 'a API de cobrança deve devolver e salvar a justificativa por pessoa')
assert(/\.cobranca-permissao\s*\{/.test(css), 'o editor de cobrança precisa de controle visual próprio')
assert(/Histórico de cobranças/.test(js) && /historico\.itens/.test(js), 'o editor deve mostrar cada cobrança confirmada')
assert(/function tempoDesdeCobranca/.test(js) && /há \$\{dias\}/.test(js), 'cada cobrança precisa mostrar há quanto tempo aconteceu, inclusive depois de sete dias')
assert(/Feedback recebido/.test(js) && /Sem resposta até agora/.test(js), 'cada cobrança precisa mostrar o retorno recebido ou a ausência dele')
assert(/não dá para atribuir este retorno diretamente à cobrança/.test(js), 'a UI não pode chamar de feedback direto uma resposta que veio depois de outra saída')
assert(/\.cobranca-history\s*\{/.test(css), 'o histórico de cobranças precisa de componente visual próprio')
assert(/\.cobranca-feedback\s*\{/.test(css), 'o feedback da cobrança precisa de componente visual próprio')

if (!process.exitCode) console.log('✓ cobrança exige motivo, guarda o histórico confirmado e usa o mesmo editor nos canais')

// ---- Historico de cobrancas em Progresso ----------------------------------------------
// A ficha individual nao basta para acompanhar o conjunto. Progresso precisa juntar pedidos
// ainda na fila, envios confirmados e o primeiro retorno posterior, sempre por pessoa.
assert(/\/api\/conversas\/cobrancas/.test(js), 'Progresso precisa carregar o resumo de cobrancas')
assert(/p === '\/api\/conversas\/cobrancas' && method === 'GET'/.test(conversasRoutes), 'a API de Progresso precisa servir cobrancas')
assert(/id="progVisao" role="tablist"/.test(js) && />Conversas<\/button>/.test(js) && />Cobranças<\/button>/.test(js), 'cobrancas precisam ter uma aba propria dentro de Progresso')
assert(/PROG\.visao === 'cobrancas'[\s\S]{0,500}progCobrancas\(d\.cobrancas\)/.test(js), 'a aba de cobrancas precisa renderizar o historico separado das metricas gerais')
assert(/csv\.hidden = PROG\.visao !== 'conversas'/.test(js), 'o download de metricas de conversa nao deve aparecer como se fosse de cobrancas')
assert(/function progCobrancas/.test(js) && /Cobranças e pedidos/.test(js), 'Progresso precisa renderizar a secao de cobrancas')
assert(/resumo\.cobrancasIniciadas[\s\S]{0,80}'iniciadas'/.test(js), 'o resumo precisa contar envios confirmados como cobrancas iniciadas')
assert(/Ligar uma necessidade por si só não inicia cobrança/.test(js), 'a tela precisa distinguir necessidade ligada de pedido iniciado')
assert(/historicoCobrancaItemHtml/.test(js), 'Progresso e o editor precisam usar a mesma leitura de feedback')
assert(/\.prog-visoes\s*\{/.test(css) && /\.prog-cobr-card\s*\{/.test(css) && /\.prog-cobr-metas\s*\{/.test(css), 'a aba de cobrancas precisa de componentes visuais proprios')

if (!process.exitCode) console.log('✓ progresso mostra pedidos e histórico de cobranças por pessoa')

// ---- Ações em lote no Badoo ------------------------------------------------------------
// A lista do Badoo agora precisa permitir seleção múltipla e aplicação de ações já
// suportadas pelo sistema, sem perder o clique normal de abrir a conversa.
assert(/selected:\s*new Set\(\)/.test(js) && /bulkAction:\s*'ia_on'/.test(js), 'o estado do Badoo precisa guardar seleção múltipla e a ação escolhida')
assert(/function badooBulkToolbar/.test(js) && /data-badoo-bulk-action/.test(js), 'a lista do Badoo precisa ter uma barra de ações em lote')
assert(/Agendar pedido 1x/.test(js) && /Cancelar pedido 1x/.test(js), 'o menu de lote do Badoo precisa expor ações de pedido único')
assert(/api\('\/api\/badoo\/ia'/.test(js) && /api\('\/api\/necessidades\/pedido'/.test(js), 'as ações em lote do Badoo precisam reutilizar as rotas reais de IA e pedido')
assert(/class="opener-select badoo-select"/.test(js) && /Selecionar .*ação em lote/.test(js), 'cada conversa do Badoo precisa ter controle explícito de seleção')
assert(/\.badoo-bulk-toolbar\s*\{/.test(css) && /\.badoo-item-actions\s*\{/.test(css), 'a seleção e a barra de lote do Badoo precisam de componentes visuais próprios')

if (!process.exitCode) console.log('✓ Badoo permite seleção múltipla com ações em lote')

// ---- Pedido único pela UI --------------------------------------------------------------
// "Pode falar" e "vai pedir" são ações diferentes. O segundo precisa de botão, confirmação,
// cancelamento e estado visível — se virar só objetivo do modelo, volta a ser opcional.
assert(/Pedir 1x/.test(js), 'a ficha da pessoa precisa expor o botão de pedido único')
assert(/\/api\/necessidades\/pedido/.test(js), 'o botão de pedido único precisa estar ligado à API')
assert(/acao: 'cancelar'/.test(js) && /Aguardando a próxima resposta/.test(js), 'a UI precisa mostrar e cancelar a fila antes do envio')
assert(/Pedido enviado/.test(js) && /Pedir de novo/.test(js), 'a UI precisa mostrar comprovante e exigir novo clique para repetir')
assert(/\.pss-nec-pedido\s*\{/.test(css), 'o pedido único precisa de estado visual próprio')

if (!process.exitCode) console.log('✓ pedido único configurável e auditável pela UI')

// ---- Necessidades editáveis -------------------------------------------------------------
assert(/const bEdit = el\('button', 'btn ghost', 'Editar'\)/.test(js), 'cada necessidade precisa ter botão Editar')
assert(/id: editando \|\| undefined/.test(js), 'salvar uma edição precisa mandar o id da necessidade')
assert(/bCancelEdit/.test(js), 'edição precisa ter cancelamento visível')
assert(/tipos: tiposForm\.valor\(\)/.test(js), 'editar uma necessidade não pode apagar os tipos por omissão')
const trechoNecessidades = js.slice(js.indexOf('function renderNecessidades'), js.indexOf('// ---------------------------------------------------------------- PIX'))
assert(!/horário de Brasília|America\/Sao_Paulo|UTC-3/.test(trechoNecessidades), 'a UI de necessidades pode ter horário, mas não deve expor o fuso')
assert(/dias com a IA ligada/.test(trechoNecessidades), 'a espera precisa da régua da IA ligada, senão a tela só oferece idade da conversa')
assert(/\/api\/necessidades\/msgs/.test(trechoNecessidades), 'a tela precisa gravar o mínimo de mensagens sem mandar a necessidade inteira')
assert(/\/api\/necessidades\/cobrar/.test(trechoNecessidades), 'a tela precisa ligar o PIX da necessidade sem abrir ficha por ficha')

if (!process.exitCode) console.log('✓ necessidades editáveis sem expor fuso')
