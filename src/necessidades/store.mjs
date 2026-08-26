// AS NECESSIDADES DELA: o que está apertando e quanto falta, em reais.
//
// Pedido dela (31/07/2026): "deve ter um campo pra eu colocar quais dificuldades tenho e
// quantos reais eu preciso".
//
// DUAS DECISÕES QUE VALEM MAIS QUE O CRUD:
//
// 1. DINHEIRO EM CENTAVOS, INTEIRO. Nunca float. `0.1 + 0.2` não dá `0.3` em ponto flutuante,
//    e somar contas assim rende diferença de centavos que ninguém entende depois. O banco
//    guarda `valor_centavos` e a tela formata. É a mesma regra do sistema financeiro do
//    outro projeto, e vale aqui pelo mesmo motivo.
//
// 2. O VALOR PODE IR PRO CONTEXTO DA IA. O pedido/cobrança continua sendo decidido no filtro:
//    mencionar "conta de luz R$ 247,90" é uma coisa; pedir PIX, empréstimo ou pagamento é
//    outra. O que fica aqui é o dado bruto e auditável; o que pode sair em conversa continua
//    passando pelas travas da IA.
import { db } from '../core/db.mjs'

export function garantirTabela() {
  db().exec(`CREATE TABLE IF NOT EXISTS necessidade (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    descricao TEXT NOT NULL,
    valor_centavos INTEGER NOT NULL DEFAULT 0,
    prazo TEXT,                       -- texto legível derivado do vencimento; linhas antigas podem ter texto livre
    prazo_tipo TEXT,                  -- NULL | 'venceu' | 'vence'
    prazo_data TEXT,                  -- YYYY-MM-DD
    status TEXT NOT NULL DEFAULT 'aberta',   -- aberta | resolvida
    dias_minimos INTEGER NOT NULL DEFAULT 0, -- só entra na conversa depois de N dias DELA (0 = sem espera própria)
    dias_criterio TEXT NOT NULL DEFAULT 'corridos', -- corridos (desde a 1ª mensagem) | conversados (dias com conversa)
    linha TEXT,                       -- a LINHA DE CONVERSA: como ela conta essa situação, nas palavras dela
    hora_de TEXT, hora_ate TEXT,      -- janela HH:MM em HORÁRIO DE BRASÍLIA (as duas nulas = qualquer hora)
    tipos TEXT,                       -- JSON com os vínculos que podem ouvir (null/vazio = todos)
    preparo_minutos INTEGER NOT NULL DEFAULT 0,  -- minutos de conversa que precisam existir ANTES de citar (0 = sem preparo)
    preparo_dias INTEGER NOT NULL DEFAULT 0,     -- em que janela esses minutos contam (0 = a conversa toda)
    preparo_como TEXT,                           -- de que jeito conduzir a conversa até lá (texto livre dele)
    msgs_minimas INTEGER NOT NULL DEFAULT 0,     -- só entra depois de N mensagens da pessoa (0 = sem mínimo)
    cobrar INTEGER NOT NULL DEFAULT 0,           -- 1 = quem passa nas travas ganha autorização de PIX
    created_at INTEGER, updated_at INTEGER
  )`)
  const cols = db().prepare(`PRAGMA table_info(necessidade)`).all().map((c) => c.name)
  if (!cols.includes('prazo_tipo')) db().exec(`ALTER TABLE necessidade ADD COLUMN prazo_tipo TEXT`)
  if (!cols.includes('prazo_data')) db().exec(`ALTER TABLE necessidade ADD COLUMN prazo_data TEXT`)
  // Linha antiga nasce com 0: quem já estava anotado continua valendo como sempre valeu.
  if (!cols.includes('dias_minimos')) db().exec(`ALTER TABLE necessidade ADD COLUMN dias_minimos INTEGER NOT NULL DEFAULT 0`)
  if (!cols.includes('dias_criterio')) db().exec(`ALTER TABLE necessidade ADD COLUMN dias_criterio TEXT NOT NULL DEFAULT 'corridos'`)
  if (!cols.includes('linha')) db().exec(`ALTER TABLE necessidade ADD COLUMN linha TEXT`)
  if (!cols.includes('hora_de')) db().exec(`ALTER TABLE necessidade ADD COLUMN hora_de TEXT`)
  if (!cols.includes('hora_ate')) db().exec(`ALTER TABLE necessidade ADD COLUMN hora_ate TEXT`)
  if (!cols.includes('tipos')) db().exec(`ALTER TABLE necessidade ADD COLUMN tipos TEXT`)
  // A decisão PESSOA A PESSOA, que manda por cima do tipo. Linha só existe quando ele
  // resolveu alguma coisa ali: ausência é "segue o tipo", e é o estado da imensa maioria.
  db().exec(`CREATE TABLE IF NOT EXISTS necessidade_pessoa (
    necessidade_id INTEGER NOT NULL, person_id TEXT NOT NULL,
    estado TEXT NOT NULL,             -- 'sim' (vale mesmo fora do tipo) | 'nao' (nunca com ela)
    criado_em INTEGER,
    PRIMARY KEY (necessidade_id, person_id)
  )`)
  if (!cols.includes('preparo_minutos')) db().exec(`ALTER TABLE necessidade ADD COLUMN preparo_minutos INTEGER NOT NULL DEFAULT 0`)
  if (!cols.includes('preparo_dias')) db().exec(`ALTER TABLE necessidade ADD COLUMN preparo_dias INTEGER NOT NULL DEFAULT 0`)
  if (!cols.includes('preparo_como')) db().exec(`ALTER TABLE necessidade ADD COLUMN preparo_como TEXT`)
  if (!cols.includes('msgs_minimas')) db().exec(`ALTER TABLE necessidade ADD COLUMN msgs_minimas INTEGER NOT NULL DEFAULT 0`)
  if (!cols.includes('cobrar')) db().exec(`ALTER TABLE necessidade ADD COLUMN cobrar INTEGER NOT NULL DEFAULT 0`)
}

const agora = () => Date.now()
const limpa = (t, max = 200) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, max)
// A LINHA DE CONVERSA é texto livre dele: aqui não se normaliza espaço nem se corrige nada.
// Se ele escreveu em duas linhas, é porque é assim que ela mandaria — em duas bolhas.
const limpaLinha = (t) => String(t == null ? '' : t).replace(/\r/g, '').trim().slice(0, 600)
const TZ = 'America/Sao_Paulo'
const partesHoje = () => {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const g = Object.fromEntries(p.map((x) => [x.type, x.value]))
  return { ano: g.year, mes: g.month, dia: g.day }
}
const hojeIso = () => { const h = partesHoje(); return `${h.ano}-${h.mes}-${h.dia}` }
const dataBr = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''))
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ''
}
function normalizaDataIso(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim())
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}
export function descreverPrazo({ prazo, prazoTipo, prazoData }) {
  const tipo = prazoTipo === 'venceu' || prazoTipo === 'vence' ? prazoTipo : null
  const data = normalizaDataIso(prazoData)
  if (!tipo || !data) return limpa(prazo, 60) || null
  const hoje = hojeIso()
  if (data === hoje) return tipo === 'venceu' ? `venceu hoje (${dataBr(data)})` : `vence hoje (${dataBr(data)})`
  return `${tipo === 'venceu' ? 'venceu em' : 'vence em'} ${dataBr(data)}`
}
function normalizaPrazo({ prazo, prazoTipo, prazoData }) {
  const tipoCru = String(prazoTipo || '').trim()
  const tipo = tipoCru === 'venceu' || tipoCru === 'vence' ? tipoCru : ''
  const data = normalizaDataIso(prazoData)
  const legado = limpa(prazo, 60) || null
  if (!tipo && !data) return { prazo: legado, prazoTipo: null, prazoData: null }
  if (!tipo) throw new Error('diga se essa necessidade já venceu ou se vai vencer')
  if (!data) throw new Error('escolha a data do vencimento')
  const hoje = hojeIso()
  if (tipo === 'venceu' && data > hoje) throw new Error('essa data ainda não venceu; use "vai vencer"')
  if (tipo === 'vence' && data < hoje) throw new Error('essa data já passou; use "já venceu"')
  return { prazo: descreverPrazo({ prazoTipo: tipo, prazoData: data }), prazoTipo: tipo, prazoData: data }
}

// Aceita o que a tela manda (centavos, inteiro) e recusa lixo silenciosamente virando 0 —
// necessidade sem valor é válida ("tô sem carro pra trabalhar"), valor negativo não é.
function centavos(v) {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

// Dias de espera de UMA necessidade. Inteiro, 0 a 365. Lixo vira 0 (sem espera própria) em
// vez de erro: campo de espera não pode impedir de anotar o que está apertando.
function dias(v) {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : 0
}

// SÃO DUAS RÉGUAS, e a diferença entre elas é o ponto (observação do gestor, 13/08/2026):
// nem todo dia desde o primeiro "oi" teve conversa. `corridos` conta o tempo que faz que
// vocês se falam; `conversados` conta em quantos dias diferentes houve conversa de verdade.
export const CRITERIOS = ['corridos', 'conversados', 'ia']
function criterio(v) { return CRITERIOS.includes(String(v)) ? String(v) : 'corridos' }

// Como isso aparece pra quem opera. Uma frase, não um número solto — "5" na tela não diz se
// são dias de conversa, de atraso ou de prazo.
export function descreverEspera(diasMinimos, diasCriterio) {
  const d = dias(diasMinimos)
  if (!d) return 'desde o começo'
  const c = criterio(diasCriterio)
  const unidade = c === 'conversados'
    ? (d === 1 ? '1 dia com conversa' : `${d} dias com conversa`)
    : c === 'ia'
      ? (d === 1 ? '1 dia com a IA ligada' : `${d} dias com a IA ligada`)
      : (d === 1 ? '1 dia de conversa' : `${d} dias de conversa`)
  return `depois de ${unidade}`
}

export function descreverMsgs(msgsMinimas) {
  const n = dias(msgsMinimas)
  if (!n) return 'qualquer tamanho'
  return n === 1 ? 'a partir de 1 mensagem' : `a partir de ${n} mensagens`
}

// ---------------------------------------------------------------- horário de comentar
// SEMPRE em horário de Brasília (regra configurada, 13/08/2026). O servidor pode rodar em UTC
// — e roda — então nada aqui pode usar a hora da máquina: a hora é FORMATADA no fuso de São
// Paulo antes de virar número. Foi o mesmo cuidado que a régua de "dias com conversa" exigiu.
const TZ_HORA = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
})
export function minutoAgoraBr(agora = new Date()) {
  const [h, m] = TZ_HORA.format(agora).split(':').map(Number)
  return h * 60 + m
}
function hora(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim())
  if (!m) return null
  const h = Number(m[1]); const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}
const emMinutos = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }

// A janela vale AGORA? Vira a meia-noite quando o fim é menor que o começo — "das 22h às 6h"
// é uma janela real, e tratá-la como intervalo simples a deixaria sempre fechada.
export function dentroDaJanela(horaDe, horaAte, minuto) {
  const de = hora(horaDe); const ate = hora(horaAte)
  if (!de || !ate) return true          // sem janela, qualquer hora serve
  const a = emMinutos(de); const b = emMinutos(ate)
  if (a === b) return true              // janela de 24h
  return a < b ? (minuto >= a && minuto <= b) : (minuto >= a || minuto <= b)
}

export function descreverHorario(horaDe, horaAte) {
  const de = hora(horaDe); const ate = hora(horaAte)
  if (!de || !ate) return 'qualquer hora'
  return `das ${de} às ${ate}`
}

// ---------------------------------------------------------------- preparo antes de citar
// "algo para fazer antes de falar sobre a necessidade: conversar de tal forma durante x
// minutos/dias antes de citar" (gestor, 13/08/2026).
//
// São três coisas: QUANTO papo (minutos), EM QUE JANELA (dias — 0 é a conversa toda) e DE QUE
// JEITO até lá (texto livre). Os minutos são medidos como tempo ENGAJADO em
// `ai/assunto-grana.mjs`, e não como a distância entre a primeira e a última mensagem.
const minutos = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, 100_000) : 0 }

export function descreverPreparo({ preparoMinutos, preparoDias, preparoComo } = {}) {
  const m = minutos(preparoMinutos)
  if (!m) return 'sem preparo'
  const d = dias(preparoDias)
  const quanto = m === 1 ? '1 minuto de conversa' : `${m} minutos de conversa`
  const janela = d ? (d === 1 ? ' no último dia' : ` nos últimos ${d} dias`) : ''
  const jeito = limpaLinha(preparoComo) ? ', de um jeito combinado' : ''
  return `depois de ${quanto}${janela}${jeito}`
}

// O preparo desta linha está cumprido? `minutosEm(dias)` vem de fora porque quem sabe medir
// conversa é quem enxerga as mensagens — o store das necessidades não enxerga.
function preparoCumprido(l, minutosEm) {
  const exige = minutos(l.preparo_minutos)
  if (!exige) return true
  if (typeof minutosEm !== 'function') return true   // sem como medir, não inventa resposta
  return minutosEm(dias(l.preparo_dias)) >= exige
}

// ---------------------------------------------------------------- quem pode ouvir
// DUAS CAMADAS, e a de baixo manda (regra configurada, 13/08/2026):
//   1. TIPO — a necessidade lista os vínculos que podem ouvir sobre ela (paquera, amigo,
//      cliente…). Lista vazia é "todos", que é o padrão de tudo que já existia.
//   2. PESSOA — na ficha de alguém dá pra dizer "essa sim" ou "essa nunca", e isso ganha do
//      tipo. É a válvula pro caso que a regra geral não cobre, que sempre aparece.
//
// A camada da pessoa não mexe em espera nem horário: ela responde "pode falar disso COM
// ELA", não "pode falar disso AGORA". Misturar as duas perguntas numa chave só é como se
// perde a explicação de por que a IA ficou calada.
function listaDeTipos(v) {
  const bruta = Array.isArray(v) ? v : (() => { try { return JSON.parse(v || '[]') } catch { return [] } })()
  const limpos = [...new Set(bruta.map((x) => String(x || '').trim()).filter(Boolean))]
  return limpos.slice(0, 40)
}
export function tiposDaNecessidade(row) { return listaDeTipos(row && row.tipos) }

export function definirTipos(id, tipos) {
  garantirTabela()
  const lista = listaDeTipos(tipos)
  const r = db().prepare(`UPDATE necessidade SET tipos=?, updated_at=? WHERE id=?`)
    .run(lista.length ? JSON.stringify(lista) : null, agora(), Number(id))
  return r.changes > 0 ? lista : null
}

// 'sim' | 'nao' | null (volta pro padrão, que é seguir o tipo)
export function definirPessoa(necessidadeId, personId, estado) {
  garantirTabela()
  const pid = String(personId || '').trim()
  if (!pid) return null
  if (!db().prepare(`SELECT 1 FROM necessidade WHERE id=?`).get(Number(necessidadeId))) return null
  if (estado !== 'sim' && estado !== 'nao') {
    db().prepare(`DELETE FROM necessidade_pessoa WHERE necessidade_id=? AND person_id=?`).run(Number(necessidadeId), pid)
    return 'padrao'
  }
  db().prepare(`INSERT INTO necessidade_pessoa(necessidade_id,person_id,estado,criado_em) VALUES(?,?,?,?)
    ON CONFLICT(necessidade_id,person_id) DO UPDATE SET estado=excluded.estado`)
    .run(Number(necessidadeId), pid, estado, agora())
  return estado
}

// O que foi decidido pra ESTA pessoa, por necessidade. Aceita os vários ids da mesma pessoa
// (Tinder + WhatsApp + Instagram): decidir na ficha do Instagram e a regra não valer no
// WhatsApp seria o mesmo defeito que a contagem de dias tinha.
export function decisoesDaPessoa(ids) {
  garantirTabela()
  const lista = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x || '')).filter(Boolean)
  if (!lista.length) return new Map()
  const marks = lista.map(() => '?').join(',')
  const linhas = db().prepare(`SELECT necessidade_id, estado FROM necessidade_pessoa WHERE person_id IN (${marks})`).all(...lista)
  const m = new Map()
  // 'nao' ganha de 'sim' quando os dois existem em ids diferentes da mesma pessoa: entre
  // liberar e proibir por engano, o silêncio é o erro barato.
  for (const l of linhas) {
    const atual = m.get(l.necessidade_id)
    m.set(l.necessidade_id, atual === 'nao' ? 'nao' : l.estado)
  }
  return m
}

export function listar({ incluirResolvidas = true } = {}) {
  garantirTabela()
  const sql = incluirResolvidas
    ? `SELECT * FROM necessidade ORDER BY status='resolvida', updated_at DESC`
    : `SELECT * FROM necessidade WHERE status='aberta' ORDER BY updated_at DESC`
  return db().prepare(sql).all()
}

// NÃO EXISTE TOTAL SOMADO, de propósito (decisão dela, 31/07/2026): "cada coisa que ela
// precisa é uma coisa única". A soma de conta de luz + mercado + notebook não é uma meta nem
// uma dívida — é um número sem referente, e número sem referente na tela vira decisão errada.
// A função de resumo existiu por algumas horas e foi removida junto com o card: deixá-la aqui
// sem ninguém chamar seria código morto esperando alguém achar que significa algo.

export function salvar({ id, descricao, valorCentavos, prazo, prazoTipo, prazoData, status, diasMinimos, diasCriterio, linha, horaDe, horaAte, preparoMinutos, preparoDias, preparoComo, tipos, msgsMinimas, cobrar }) {
  garantirTabela()
  const desc = limpa(descricao)
  if (!desc) throw new Error('a necessidade precisa de uma descrição')
  const st = status === 'resolvida' ? 'resolvida' : 'aberta'
  const venc = normalizaPrazo({ prazo, prazoTipo, prazoData })
  // Janela só existe inteira: uma ponta sozinha não é horário, é metade de uma regra.
  const jDe = hora(horaDe); const jAte = hora(horaAte)
  const janela = jDe && jAte ? [jDe, jAte] : [null, null]
  const lt = listaDeTipos(tipos); const tiposJson = lt.length ? JSON.stringify(lt) : null
  if (id) {
    db().prepare(`UPDATE necessidade SET descricao=?, valor_centavos=?, prazo=?, prazo_tipo=?, prazo_data=?, status=?, dias_minimos=?, dias_criterio=?, linha=?, hora_de=?, hora_ate=?, preparo_minutos=?, preparo_dias=?, preparo_como=?, tipos=?, msgs_minimas=?, cobrar=?, updated_at=? WHERE id=?`)
      .run(desc, centavos(valorCentavos), venc.prazo, venc.prazoTipo, venc.prazoData, st, dias(diasMinimos), criterio(diasCriterio), limpaLinha(linha) || null, janela[0], janela[1], minutos(preparoMinutos), dias(preparoDias), limpaLinha(preparoComo) || null, tiposJson, dias(msgsMinimas), cobrar ? 1 : 0, agora(), Number(id))
    return Number(id)
  }
  const r = db().prepare(`INSERT INTO necessidade(descricao,valor_centavos,prazo,prazo_tipo,prazo_data,status,dias_minimos,dias_criterio,linha,hora_de,hora_ate,preparo_minutos,preparo_dias,preparo_como,tipos,msgs_minimas,cobrar,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(desc, centavos(valorCentavos), venc.prazo, venc.prazoTipo, venc.prazoData, st, dias(diasMinimos), criterio(diasCriterio), limpaLinha(linha) || null, janela[0], janela[1], minutos(preparoMinutos), dias(preparoDias), limpaLinha(preparoComo) || null, tiposJson, dias(msgsMinimas), cobrar ? 1 : 0, agora(), agora())
  return r.lastInsertRowid
}

// Só os dias, sem passar pelo `salvar` inteiro: a tela edita esse campo direto na lista, e
// mandar descrição, valor e vencimento de volta a cada ajuste é como um deles se perde.
export function definirDias(id, diasMinimos, diasCriterio) {
  garantirTabela()
  const d = dias(diasMinimos)
  // Sem critério informado, mantém o que já estava: a tela edita número e régua em campos
  // separados, e um não pode zerar o outro por omissão.
  const atual = db().prepare(`SELECT dias_criterio FROM necessidade WHERE id=?`).get(Number(id))
  if (!atual) return null
  const c = diasCriterio === undefined ? criterio(atual.dias_criterio) : criterio(diasCriterio)
  const r = db().prepare(`UPDATE necessidade SET dias_minimos=?, dias_criterio=?, updated_at=? WHERE id=?`)
    .run(d, c, agora(), Number(id))
  return r.changes > 0 ? { dias: d, criterio: c } : null
}

export function definirMsgs(id, msgsMinimas) {
  garantirTabela()
  const n = dias(msgsMinimas)
  const r = db().prepare(`UPDATE necessidade SET msgs_minimas=?, updated_at=? WHERE id=?`)
    .run(n, agora(), Number(id))
  return r.changes > 0 ? { msgsMinimas: n } : null
}

export function definirCobrar(id, cobrar) {
  garantirTabela()
  const bit = cobrar ? 1 : 0
  const r = db().prepare(`UPDATE necessidade SET cobrar=?, updated_at=? WHERE id=?`)
    .run(bit, agora(), Number(id))
  return r.changes > 0 ? { cobrar: bit } : null
}

// Só a linha de conversa, direto da lista. Mesma razão do `definirDias`: mandar o item
// inteiro de volta a cada ajuste é como descrição ou vencimento se perdem.
export function definirLinha(id, linha) {
  garantirTabela()
  const t = limpaLinha(linha)
  const r = db().prepare(`UPDATE necessidade SET linha=?, updated_at=? WHERE id=?`).run(t || null, agora(), Number(id))
  return r.changes > 0 ? t : null
}

// Só a janela de horário. Mandar as duas pontas vazias volta pra "qualquer hora".
export function definirHorario(id, horaDe, horaAte) {
  garantirTabela()
  const de = hora(horaDe); const ate = hora(horaAte)
  const janela = de && ate ? [de, ate] : [null, null]
  const r = db().prepare(`UPDATE necessidade SET hora_de=?, hora_ate=?, updated_at=? WHERE id=?`)
    .run(janela[0], janela[1], agora(), Number(id))
  return r.changes > 0 ? { horaDe: janela[0], horaAte: janela[1] } : null
}

// Só o preparo, direto da lista.
export function definirPreparo(id, preparoMinutos, preparoDias, preparoComo) {
  garantirTabela()
  const m = minutos(preparoMinutos)
  const d = dias(preparoDias)
  const como = limpaLinha(preparoComo) || null
  const r = db().prepare(`UPDATE necessidade SET preparo_minutos=?, preparo_dias=?, preparo_como=?, updated_at=? WHERE id=?`)
    .run(m, d, como, agora(), Number(id))
  return r.changes > 0 ? { preparoMinutos: m, preparoDias: d, preparoComo: como || '' } : null
}

export function apagar(id) {
  garantirTabela()
  // As decisões por pessoa morrem com a necessidade: linha órfã aqui viraria uma regra
  // invisível grudada no próximo id que o AUTOINCREMENT reaproveitar.
  db().prepare(`DELETE FROM necessidade_pessoa WHERE necessidade_id=?`).run(Number(id))
  // Se o módulo de pedido único já foi usado, a fila não pode sobreviver à necessidade.
  // `try` mantém compatibilidade com bancos em que a tabela ainda não nasceu.
  try { db().prepare(`DELETE FROM necessidade_pedido_unico WHERE necessidade_id=?`).run(Number(id)) } catch { /* tabela ainda não criada */ }
  return db().prepare(`DELETE FROM necessidade WHERE id=?`).run(Number(id)).changes > 0
}

export function alternarStatus(id) {
  garantirTabela()
  const r = db().prepare(`SELECT status FROM necessidade WHERE id=?`).get(Number(id))
  if (!r) return null
  const novo = r.status === 'resolvida' ? 'aberta' : 'resolvida'
  db().prepare(`UPDATE necessidade SET status=?, updated_at=? WHERE id=?`).run(novo, agora(), Number(id))
  if (novo === 'resolvida') {
    try { db().prepare(`UPDATE necessidade_pedido_unico SET estado='cancelado', atualizado_em=? WHERE necessidade_id=? AND estado IN ('pendente','gerando','aguardando')`).run(agora(), Number(id)) } catch { /* tabela ainda não criada */ }
  }
  return novo
}

// O que a IA pode saber: descrição, valor e prazo das necessidades abertas. Sem total somado.
// Serve para a resposta soar concreta quando a janela do assunto abrir; pedir dinheiro ou
// cobrar continua sendo outra decisão, feita mais adiante pelo filtro.
// O que a IA pode citar AGORA, PARA ESTA PESSOA.
//
// Chegam as DUAS contas da conversa com ela: `corridos` (dias desde a primeira mensagem) e
// `conversados` (em quantos dias diferentes houve conversa). Cada necessidade diz qual das
// duas vale pra ela. Quem não passou da espera simplesmente NÃO ENTRA no texto — não é uma
// instrução de "evite falar", é ausência do dado: o modelo não cita o que não recebeu.
// As linhas abertas, cruas. Uma consulta só, usada pelo contexto da IA e pelo preparo
// pendente — duas SELECTs diferentes é como as duas telas passam a discordar.
function abertasCruas() {
  return db().prepare(
    `SELECT id, descricao, valor_centavos, prazo, prazo_tipo, prazo_data, dias_minimos, dias_criterio,
            linha, hora_de, hora_ate, preparo_minutos, preparo_dias, preparo_como, tipos,
            msgs_minimas, cobrar
       FROM necessidade WHERE status='aberta' ORDER BY updated_at DESC`,
  ).all()
}

// QUEM PODE OUVIR. Duas camadas, e a de baixo manda: a necessidade lista os tipos de pessoa
// que podem ouvir (vazio = todos) e a ficha de alguém pode abrir ou fechar por cima disso.
// Fica separado das travas de TEMPO de propósito: esta responde "com ela pode", aquelas
// respondem "agora pode" — juntar as duas perguntas numa função só é como se perde a
// explicação de por que a IA ficou calada.
function podeOuvir(l, { tipoDaPessoa, decisoes }) {
  const decidido = decisoes && decisoes.get ? decisoes.get(l.id) : null
  if (decidido === 'nao') return false
  if (decidido === 'sim') return true
  const permitidos = listaDeTipos(l.tipos)
  if (!permitidos.length) return true      // sem lista = todos
  if (!tipoDaPessoa) return false          // tem lista e a pessoa não tem vínculo: fica de fora
  return permitidos.includes(String(tipoDaPessoa))
}

// Passou nas travas que não são o preparo: espera em dias e janela de horário.
function passouNoResto(l, { corridos, conversados, iaLigada, mensagens, minuto }) {
  if (!dentroDaJanela(l.hora_de, l.hora_ate, minuto)) return false
  const semConta = corridos == null && conversados == null && iaLigada == null
  const espera = Number(l.dias_minimos || 0)
  if (espera && !semConta) {
    const c = criterio(l.dias_criterio)
    const tem = c === 'conversados' ? conversados : c === 'ia' ? iaLigada : corridos
    if (tem == null || espera > Number(tem)) return false
  }
  const minMsg = Number(l.msgs_minimas || 0)
  if (minMsg && mensagens != null && Number(mensagens) < minMsg) return false
  return true
}

export function necessidadeAbertaPara(l, contas = {}, { tipoDaPessoa = null, decisoes = null, minuto = minutoAgoraBr() } = {}) {
  if (!podeOuvir(l, { tipoDaPessoa, decisoes })) return false
  if (!passouNoResto(l, { ...contas, minuto })) return false
  if (!preparoCumprido(l, contas.minutosEm)) return false
  return true
}

export function contextoParaIa({ max = 3, corridos = null, conversados = null, iaLigada = null, mensagens = null, minuto = minutoAgoraBr(), minutosEm = null, tipoDaPessoa = null, decisoes = null } = {}) {
  garantirTabela()
  let linhas = abertasCruas().filter((l) => podeOuvir(l, { tipoDaPessoa, decisoes }))
  // O HORÁRIO é sobre AGORA, não sobre a pessoa: vale sempre, inclusive na chamada sem as
  // contas da conversa. A espera em dias e o preparo dependem de quem é a pessoa, então sem
  // as contas eles não filtram — filtrar por engano esconderia dado de quem só queria listar.
  linhas = linhas
    .filter((l) => passouNoResto(l, { corridos, conversados, iaLigada, mensagens, minuto }))
    .filter((l) => preparoCumprido(l, minutosEm))
  linhas = linhas.slice(0, max)
  if (!linhas.length) return ''
  return linhas.map((l) => {
    const partes = [l.descricao]
    if (Number(l.valor_centavos) > 0) partes.push(formatarBRL(l.valor_centavos))
    const prazo = descreverPrazo({ prazo: l.prazo, prazoTipo: l.prazo_tipo, prazoData: l.prazo_data })
    if (prazo) partes.push(prazo)
    const base = partes.join(' · ')
    // A LINHA DE CONVERSA vai junto do item, não num bloco separado: colada assim, não tem
    // como o modelo usar a frase de uma necessidade pra falar de outra.
    const fala = limpaLinha(l.linha)
    return fala ? `${base} (ela conta assim: "${fala.replace(/\n+/g, ' / ')}")` : base
  }).join('; ')
}

// Formatação de dinheiro em português, a partir de centavos inteiros. Fica aqui (e não só na
// tela) porque o mesmo número aparece em log, em relatório e na API — formatar em três
// lugares diferentes é como duas versões do mesmo valor nascem.
// A necessidade que está NA FILA: passou em tudo, menos no preparo. É ela que dá o jeito de
// conduzir a conversa agora.
//
// Devolve UMA só (a mais recente). Duas instruções de "converse assim" ao mesmo tempo se
// contradizem, e o modelo obedece a média das duas — que não é nenhuma das duas.
export function preparoPendente({ corridos = null, conversados = null, iaLigada = null, mensagens = null, minuto = minutoAgoraBr(), minutosEm = null, tipoDaPessoa = null, decisoes = null } = {}) {
  garantirTabela()
  if (typeof minutosEm !== 'function') return null
  for (const l of abertasCruas()) {
    // Quem não pode ouvir também não pode ser PREPARADO pra ouvir: sem isto, a IA receberia
    // instrução de conduzir a conversa até um assunto que é proibido com aquela pessoa.
    if (!podeOuvir(l, { tipoDaPessoa, decisoes })) continue
    if (!passouNoResto(l, { corridos, conversados, iaLigada, mensagens, minuto })) continue
    if (preparoCumprido(l, minutosEm)) continue
    const como = limpaLinha(l.preparo_como)
    if (!como) continue                    // sem jeito escrito não há o que instruir
    return {
      id: l.id,
      como,
      minutos: minutos(l.preparo_minutos),
      dias: dias(l.preparo_dias),
      faltam: Math.max(0, minutos(l.preparo_minutos) - minutosEm(dias(l.preparo_dias))),
    }
  }
  return null
}

export function formatarBRL(centavosInt) {
  const n = Number(centavosInt) || 0
  return (n / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

// ---------------------------------------------------------------- fotos ligadas
// UMA FOTO PODE SERVIR A VÁRIAS NECESSIDADES, E UMA NECESSIDADE PODE TER VÁRIAS FOTOS.
//
// Regra configurada (12/08/2026). O vínculo é OPCIONAL: foto sem vínculo continua valendo pelo
// contexto escrito nela, e necessidade sem foto continua sendo só texto. Quando existe, a IA
// considera — é o que faz a foto do bebê ser da conversa sobre a nenê, e não de qualquer
// conversa.
//
// Tabela própria (N:N), não uma coluna: coluna forçaria escolher UM dos dois lados como dono,
// e o gestor pediu explicitamente os dois sentidos.
export function garantirTabelaVinculos() {
  db().exec(`CREATE TABLE IF NOT EXISTS foto_necessidade (
    foto_id TEXT NOT NULL,
    necessidade_id INTEGER NOT NULL,
    criado_em INTEGER NOT NULL,
    PRIMARY KEY (foto_id, necessidade_id)
  )`)
}

export function vincularFotoNecessidade(fotoId, necessidadeId) {
  garantirTabelaVinculos()
  db().prepare('INSERT OR IGNORE INTO foto_necessidade(foto_id,necessidade_id,criado_em) VALUES(?,?,?)')
    .run(String(fotoId), Number(necessidadeId), Date.now())
  return true
}

export function desvincularFotoNecessidade(fotoId, necessidadeId) {
  garantirTabelaVinculos()
  db().prepare('DELETE FROM foto_necessidade WHERE foto_id=? AND necessidade_id=?')
    .run(String(fotoId), Number(necessidadeId))
  return true
}

// Todos os pares, pra tela desenhar as linhas de uma vez só.
export function vinculosFotoNecessidade() {
  garantirTabelaVinculos()
  return db().prepare('SELECT foto_id fotoId, necessidade_id necessidadeId FROM foto_necessidade').all()
}

// As necessidades ligadas a uma foto (para a linha do prompt).
export function necessidadesDaFoto(fotoId) {
  garantirTabelaVinculos()
  return db().prepare(`SELECT n.id, n.descricao, n.status FROM foto_necessidade v
    JOIN necessidade n ON n.id = v.necessidade_id WHERE v.foto_id = ?`).all(String(fotoId))
}

// As fotos ligadas a uma necessidade (para o bloco de necessidades no prompt).
export function fotosDaNecessidade(necessidadeId) {
  garantirTabelaVinculos()
  return db().prepare(`SELECT i.id, i.shortcut, i.descricao, i.nivel, i.active FROM foto_necessidade v
    JOIN saved_image i ON i.id = v.foto_id WHERE v.necessidade_id = ?`).all(Number(necessidadeId))
}
