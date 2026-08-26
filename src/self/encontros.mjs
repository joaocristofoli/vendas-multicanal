// Encontros e compromissos: quando ele topa marcar, onde ele está, e o interruptor de propor.
//
// Três controles:
//   1. INTERRUPTOR — autorizar proposta de encontro (global e por conversa). Desligado é o
//      padrão seguro: ausência de configuração nunca pode valer como autorização. Ligado +
//      sem janela cadastrada deixa a IA propor em aberto.
//   2. DISPONIBILIDADE — janelas semanais, em três tipos: 'encontro' (paquera),
//      'compromisso' (o resto da vida: reunião, café de trabalho, dentista) e 'atendimento'
//      (o trabalho: serviço presencial marcado com hora). Pedido dele em
//      26/07/2026. A janela é DECLARADA: vazio na Google Agenda nunca cria horário, e
//      compromisso na agenda só subtrai. Sem janela, a IA propõe como sempre propôs
//      (aberto, sem horário), que é como ela marcou o date que ele elogiou.
//   3. LUGAR — cada janela pertence a um lugar, e um período de viagem troca o lugar ativo.
//      Enquanto ele está fora, a janela da região de casa não produz horário
//      nenhum. Ver `lugares.mjs`, que é onde essa regra mora.
//
// A IA nunca vê a agenda inteira aqui — só os intervalos livres dentro das janelas que ele
// escolheu. Compromisso de terceiro não vaza pra conversa de paquera.
import crypto from 'node:crypto'
import { db, getSetting, setSetting } from '../core/db.mjs'
import { pessoaCanonica } from './identidade.mjs'
import { lugarBase, listarPeriodos, lugarAtivoEm, janelaValeNoLugar, lugarPorId } from './lugares.mjs'

const TZ = 'America/Sao_Paulo'
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
// ATENDIMENTO é a terceira família, criada em 15/08/2026 depois de acontecer: com o
// interruptor de encontro desligado, a IA de uma instância que vive de serviço presencial
// respondeu "No momento não consigo confirmar disponibilidade" para clientes que chegaram
// pelo anúncio pedindo horário. As respostas certas ("qual dia e duração vc prefere?")
// existiram e foram DESCARTADAS pela trava de encontro — 13 regerações num dia. Marcar
// trabalho e marcar romance viraram famílias separadas, com interruptor próprio cada uma.
export const TIPOS = ['encontro', 'compromisso', 'atendimento']
const agora = () => Date.now()
const id8 = () => crypto.randomBytes(6).toString('hex')
const normTipo = (t) => (TIPOS.includes(t) ? t : 'encontro')

// ---------- interruptor ----------
export function proporDatesGlobal() { return getSetting('propor_dates', false) === true }
export function setProporDatesGlobal(v) { setSetting('propor_dates', !!v) }

export function proporDatesPessoa(personId) {
  if (!personId) return proporDatesGlobal()
  // Canônico: desligar encontro "com a Fulana" vale no WhatsApp e no Instagram dela.
  const r = db().prepare(`SELECT propor_dates FROM pessoa_pref WHERE person_id=?`).get(pessoaCanonica(personId))
  if (!r || r.propor_dates === null || r.propor_dates === undefined) return proporDatesGlobal()
  return !!r.propor_dates
}

// ---------- interruptor do ATENDIMENTO ----------
// Separado do de encontro DE PROPÓSITO: quem desliga "a IA marca encontro" está falando de
// romance, não de trabalho. Nasce DESLIGADO, como todo automatismo da casa — ausência de
// configuração nunca vale como autorização. Ligado, a IA pode combinar dia, hora e duração
// de um SERVIÇO com quem já é cliente daquele serviço (quem decide isso é atendimento.mjs,
// olhando a tabela de serviços; este interruptor sozinho não abre nada).
export function marcarAtendimentoGlobal() { return getSetting('marcar_atendimento', false) === true }
export function setMarcarAtendimentoGlobal(v) { setSetting('marcar_atendimento', !!v) }

export function marcarAtendimentoPessoa(personId) {
  if (!personId) return marcarAtendimentoGlobal()
  const r = db().prepare(`SELECT marcar_atendimento FROM pessoa_pref WHERE person_id=?`).get(pessoaCanonica(personId))
  if (!r || r.marcar_atendimento === null || r.marcar_atendimento === undefined) return marcarAtendimentoGlobal()
  return !!r.marcar_atendimento
}

export function setMarcarAtendimentoPessoa(personIdBruto, valor) {
  const personId = pessoaCanonica(personIdBruto)
  if (valor === null || valor === undefined) {
    db().prepare(`UPDATE pessoa_pref SET marcar_atendimento=NULL, updated_at=? WHERE person_id=?`).run(agora(), personId)
    return
  }
  db().prepare(`INSERT INTO pessoa_pref(person_id,marcar_atendimento,updated_at) VALUES(?,?,?)
    ON CONFLICT(person_id) DO UPDATE SET marcar_atendimento=excluded.marcar_atendimento, updated_at=excluded.updated_at`)
    .run(personId, valor ? 1 : 0, agora())
}

// null = volta a herdar o global (é o estado natural, não um terceiro modo).
export function setProporDatesPessoa(personIdBruto, valor) {
  const personId = pessoaCanonica(personIdBruto)
  if (valor === null || valor === undefined) {
    db().prepare(`UPDATE pessoa_pref SET propor_dates=NULL, updated_at=? WHERE person_id=?`).run(agora(), personId)
    return
  }
  db().prepare(`INSERT INTO pessoa_pref(person_id,propor_dates,updated_at) VALUES(?,?,?)
    ON CONFLICT(person_id) DO UPDATE SET propor_dates=excluded.propor_dates, updated_at=excluded.updated_at`)
    .run(personId, valor ? 1 : 0, agora())
}

// ---------- janelas ----------
const hhmm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); if (!m) return null; const h = +m[1], mi = +m[2]; return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 ? `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : null }

// O padrão é 'encontro' porque toda janela que existia antes de 26/07/2026 é de encontro:
// quem chamava `listarJanelas()` continua recebendo exatamente o mesmo conjunto de antes.
// `tipo: '*'` traz as duas famílias, pra tela que mostra tudo.
export function listarJanelas({ tipo = 'encontro' } = {}) {
  const base = lugarBase()
  const rows = tipo === '*'
    ? db().prepare(`SELECT * FROM date_janela ORDER BY tipo, dow, inicio`).all()
    : db().prepare(`SELECT * FROM date_janela WHERE COALESCE(tipo,'encontro')=? ORDER BY dow, inicio`).all(normTipo(tipo))
  return rows.map((j) => {
    const l = j.lugar_id ? lugarPorId(j.lugar_id) : base
    return {
      ...j,
      tipo: normTipo(j.tipo),
      ativo: !!j.ativo,
      diaNome: DIAS[j.dow],
      lugar: l ? { id: l.id, nome: l.nome, cidades: l.cidades, base: !!l.base } : null,
    }
  })
}

export function salvarJanela({ id, dow, inicio, fim, ativo = true, tipo = 'encontro', lugarId = null }) {
  const i = hhmm(inicio), f = hhmm(fim)
  const d = Number(dow)
  if (!(d >= 0 && d <= 6)) throw new Error('dia da semana inválido')
  if (!i || !f) throw new Error('horário inválido')
  if (f <= i) throw new Error('o fim tem que ser depois do início')
  if (lugarId && !lugarPorId(lugarId)) throw new Error('esse lugar não existe mais')
  const idJ = id || id8()
  db().prepare(`INSERT INTO date_janela(id,dow,inicio,fim,ativo,tipo,lugar_id,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET dow=excluded.dow, inicio=excluded.inicio, fim=excluded.fim,
      ativo=excluded.ativo, tipo=excluded.tipo, lugar_id=excluded.lugar_id, updated_at=excluded.updated_at`)
    .run(idJ, d, i, f, ativo ? 1 : 0, normTipo(tipo), lugarId || null, agora())
  return idJ
}

export function apagarJanela(id) { db().prepare(`DELETE FROM date_janela WHERE id=?`).run(id) }

// Tem alguma janela ativa desse tipo? Barato, e serve pra decidir se vale consultar a Google
// Agenda antes de gerar uma resposta (sem janela, o bloco sairia vazio de qualquer forma).
export function temJanela(tipo = 'encontro') {
  try { return !!db().prepare(`SELECT 1 FROM date_janela WHERE ativo=1 AND COALESCE(tipo,'encontro')=? LIMIT 1`).get(normTipo(tipo)) } catch { return false }
}
export function temJanelaDeEncontro() { return temJanela('encontro') }
export function temJanelaDeAtendimento() { return temJanela('atendimento') }
// Vale consultar a agenda? Qualquer uma das duas famílias já justifica a busca.
export function temAlgumaJanela() { return temJanela('encontro') || temJanela('compromisso') }

// ---------- slots livres ----------
const fmtDia = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: TZ })
const fmtHora = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ })
const partes = (ms) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(new Date(ms))
  const g = Object.fromEntries(p.map((x) => [x.type, x.value]))
  return { data: `${g.year}-${g.month}-${g.day}`, hora: `${g.hour}:${g.minute}`, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g.weekday) }
}

// Converte "2026-07-26" + "19:00" (horário de São Paulo) em epoch ms. São Paulo é UTC-3
// o ano inteiro desde 2019 (não há mais horário de verão), então o deslocamento é fixo.
const OFFSET_SP_MS = 3 * 60 * 60 * 1000
function paraMs(dataIso, hora) { return Date.parse(`${dataIso}T${hora}:00.000Z`) + OFFSET_SP_MS }

// HORA REDONDA (ordem dele, 15/08/2026, depois de acontecer). Um cliente perguntou o horário
// e recebeu "tenho horário a partir das 16:53 hj" — que é a conta certa (agora + 1h de
// antecedência) e a frase errada: gente marca às 17h ou 17h30, não às 16h53. O número quebrado
// entrega que tem uma máquina calculando atrás.
//
// Arredonda SEMPRE pra cima, pro próximo meio-horário: pra baixo cairia dentro da hora de
// antecedência, e antecedência é o que existe pra ela conseguir se preparar. 30 minutos divide
// a hora certinho, então a conta pode ser feita em epoch mesmo — não depende do fuso.
const MEIA_HORA_MS = 30 * 60 * 1000
export function emHoraRedonda(ms) { return Math.ceil(ms / MEIA_HORA_MS) * MEIA_HORA_MS }

// Próximos horários livres dentro das janelas, já descontando o que está na agenda e o lugar
// onde ele vai estar naquele dia.
// eventos: [{startMs, endMs}] (o que veio da Google Agenda no intervalo).
// periodos/base entram por parâmetro pra dar pra testar sem banco; o padrão é ler do banco.
// A agenda está livre no bloco [ini, fim)? Evento sem fim conta 1h, o padrão antigo.
export function agendaLivreEm(ini, fim, eventos = []) {
  return !eventos.filter((e) => e.startMs).some((e) => {
    const oIni = e.startMs
    const oFim = e.endMs || e.startMs + 3600000
    return oIni < fim && oFim > ini
  })
}

// Folga + duração: livre de (start - antes) até (start + minutos + depois).
export function cabeNaAgenda(startMs, ocupacao, eventos = []) {
  const min = Number(ocupacao?.minutos) || 0
  if (!min || !Number.isFinite(startMs)) return { ok: false, motivo: 'sem-duracao' }
  const antes = Math.max(0, Number(ocupacao.folgaAntesMin) || 0) * 60000
  const depois = Math.max(0, Number(ocupacao.folgaDepoisMin) || 0) * 60000
  const ini = startMs - antes
  const fim = startMs + min * 60000 + depois
  if (agendaLivreEm(ini, fim, eventos)) return { ok: true, ini, fim }
  return { ok: false, motivo: 'agenda-ocupada', ini, fim }
}

export function slotsLivres({ janelas, eventos = [], dias = 10, max = 6, desde = agora(), duracaoMin = 90, periodos = null, base = undefined, ocupacao = null }) {
  const ativas = janelas.filter((j) => j.ativo)
  if (!ativas.length) return []
  const ocupado = eventos.filter((e) => e.startMs).map((e) => ({ ini: e.startMs, fim: e.endMs || e.startMs + 3600000 }))
  const listaPeriodos = periodos || listarPeriodos()
  const b = base === undefined ? lugarBase() : base
  const out = []
  const duracaoServico = Number(ocupacao?.minutos) || 0
  const precisa = duracaoServico || duracaoMin
  for (let d = 0; d < dias && out.length < max; d++) {
    const base_ = desde + d * 86400000
    const { data, dow } = partes(base_)
    // Onde ele está NESTE dia. Um dia 'ocupado' não produz horário nenhum, e um dia de
    // viagem só produz horário das janelas daquele lugar.
    const ativo = lugarAtivoEm(base_, { periodos: listaPeriodos, base: b })
    if (ativo.ocupado) continue
    for (const j of ativas.filter((x) => x.dow === dow)) {
      if (!janelaValeNoLugar(j, ativo, b)) continue
      const ini = paraMs(data, j.inicio)
      const fim = paraMs(data, j.fim)
      if (fim <= desde + 60 * 60 * 1000) continue          // já passou (ou é já já)
      const comeco = emHoraRedonda(Math.max(ini, desde + 60 * 60 * 1000)) // nunca daqui a 5 min, e nunca 16:53
      if (fim - comeco < precisa * 60000) continue      // sobrou pouco tempo
      if (duracaoServico) {
        // Serviço com duração: corta a janela em começos possíveis. A DURAÇÃO tem que
        // caber na janela; a FOLGA só precisa estar livre na agenda (pode sair um pouco
        // da janela — é deslocamento, não atendimento).
        const passo = Math.min(15, duracaoServico) * 60000
        for (let t = comeco; t + duracaoServico * 60000 <= fim && out.length < max; t += passo) {
          if (!cabeNaAgenda(t, ocupacao, eventos).ok) continue
          out.push({ startMs: t, endMs: t + duracaoServico * 60000, dow, data, tipo: j.tipo || 'encontro', lugar: ativo.fora ? { nome: ativo.nome, cidades: ativo.cidades } : null, servico: ocupacao.servico || null, faixa: ocupacao.faixa || null })
        }
        continue
      }
      const colide = ocupado.some((o) => o.ini < fim && o.fim > comeco)
      if (colide) continue
      out.push({ startMs: comeco, endMs: fim, dow, data, tipo: j.tipo || 'encontro', lugar: ativo.fora ? { nome: ativo.nome, cidades: ativo.cidades } : null })
      if (out.length >= max) break
    }
  }
  return out.sort((a, b2) => a.startMs - b2.startMs)
}

// A frase do slot. O lugar só aparece quando ele está FORA da base: sem viagem cadastrada a
// frase é idêntica à de antes, e é isso que mantém o golden set válido.
export function descreverSlot(s) {
  const dia = fmtDia.format(new Date(s.startMs)).replace(/^(\w)/, (c) => c.toUpperCase())
  const base = `${dia} a partir das ${fmtHora.format(new Date(s.startMs))} (até ${fmtHora.format(new Date(s.endMs))})`
  return s.lugar && s.lugar.nome ? `${base}, em ${s.lugar.nome}` : base
}

// ---------- bloco do prompt ----------
// Devolve '' quando não há janela cadastrada — nesse caso a IA propõe encontro como sempre
// propôs, sem horário, que é o comportamento atual aprovado.
//
// INVARIANTE: com apenas janelas de encontro, nenhum período e nenhum lugar além da base, a
// saída é byte a byte a de 25/07/2026. O parágrafo de compromisso e o nome da cidade só
// entram quando ele cadastra a coisa nova. Prova: tests-tim/disponibilidade.mjs e o
// dump-prompts antes/depois.
export function encontrosBlock({ eventos = [], desde = agora() } = {}) {
  const base = lugarBase()
  const periodos = listarPeriodos()
  const enc = slotsLivres({ janelas: listarJanelas({ tipo: 'encontro' }), eventos, desde, periodos, base })
  const com = slotsLivres({ janelas: listarJanelas({ tipo: 'compromisso' }), eventos, desde, periodos, base })
  if (!enc.length && !com.length) return ''
  const partesBloco = []
  if (enc.length) {
    partesBloco.push([
      'QUANDO O USUÁRIO PODE MARCAR ALGO (agenda dele já descontada; horário de Brasília).',
      'Use SÓ se a conversa chegar naturalmente em marcar algo: aí proponha dentro de um destes horários, com jeito de convite, nunca listando as opções todas nem soando como agenda. Se ela sugerir outro horário, não recuse na hora: diga que vai ver e siga a conversa. Nunca diga que consultou agenda, sistema ou calendário.',
      enc.map((s) => `- ${descreverSlot(s)}`).join('\n'),
    ].join('\n'))
  }
  if (com.length) {
    partesBloco.push([
      'QUANDO ELE PODE MARCAR ALGO QUE NÃO É ENCONTRO (trabalho, reunião, resolver alguma coisa; mesma agenda já descontada).',
      'Vale a mesma regra: só se a conversa pedir, e sem soar como agenda. Não use esses horários pra convite romântico.',
      com.map((s) => `- ${descreverSlot(s)}`).join('\n'),
    ].join('\n'))
  }
  return partesBloco.join('\n\n')
}

// ---------- bloco do prompt: ATENDIMENTO ----------
// Família própria, texto próprio. O de encontro é convite ("com jeito de convite, nunca
// listando as opções"); este é TRABALHO: quem chegou pelo anúncio perguntando horário quer
// uma resposta de horário, e desconversar aqui é perder cliente — foi o que aconteceu em
// 15/08/2026. Fora isso vale a mesma disciplina do outro bloco: nunca dizer que consultou
// agenda, sistema ou calendário.
//
// `ocupacao` (duração + folga do serviço, de servicos.mjs) entra quando se sabe qual tempo a
// pessoa quer: aí a janela é cortada em começos que CABEM. Sem ela, o comportamento é o
// mesmo de sempre e o horário sai sem compromisso de duração.
//
// Devolve '' sem janela de atendimento cadastrada — e nesse caso quem chama deixa a IA
// combinar em aberto, que é o comportamento de quem tem o interruptor ligado e nada escrito.
export function atendimentoBlock({ eventos = [], desde = agora(), ocupacao = null } = {}) {
  const base = lugarBase()
  const periodos = listarPeriodos()
  const slots = slotsLivres({ janelas: listarJanelas({ tipo: 'atendimento' }), eventos, desde, periodos, base, ocupacao })
  if (!slots.length) return ''
  return [
    'SEUS HORÁRIOS DE ATENDIMENTO (o que já está ocupado na sua agenda já foi descontado; horário de Brasília).',
    'Isto é trabalho, não é encontro: quando a pessoa perguntar quando você tem horário, ou quiser marcar um atendimento, RESPONDA com horário de verdade daqui de baixo. Ofereça um ou dois, do jeito que você fala, sem listar tudo e sem tom de agenda. Se ela pedir um horário que não está aqui, não recuse seco: diga que nesse não dá e ofereça o mais perto que dá. Nunca diga que consultou agenda, sistema ou calendário, e nunca confirme um horário que não esteja nesta lista.',
    ...(ocupacao?.minutos ? [`A pessoa está falando de ${ocupacao.minutos} minutos: os horários abaixo já cabem esse tempo${(ocupacao.folgaAntesMin || ocupacao.folgaDepoisMin) ? ' com o preparo/deslocamento que você precisa antes e depois' : ''}.`] : []),
    slots.map((s) => `- ${descreverSlot(s)}`).join('\n'),
  ].join('\n')
}

// ---------- conferência de um horário ----------
// Um horário proposto cabe? Devolve o veredito com o motivo em português, pra o painel AVISAR
// quando um compromisso detectado cai fora — nunca pra bloquear. Quem decide é ele, e o
// interruptor é a fonte da verdade (CLAUDE.md).
//
// `semRegra: true` significa "ele não declarou HORÁRIO desse tipo", e nesse caso não se aponta
// "fora do horário": quem não declarou disponibilidade não pode ser avisado de estar fora dela.
// Mas semRegra NÃO implica aprovado: um período de viagem é uma regra que ele declarou de
// outro jeito, e vale sozinho.
export function conferirHorario(ms, { tipo = 'compromisso', eventos = [], duracaoMin = 60, ocupacao = null } = {}) {
  const quandoMs = Number(ms)
  if (!Number.isFinite(quandoMs)) return { ok: true, semRegra: true, motivos: [] }
  const base = lugarBase()
  const periodos = listarPeriodos()
  const ativo = lugarAtivoEm(quandoMs, { periodos, base })
  const motivos = []

  if (ativo.ocupado) {
    motivos.push(ativo.motivo === 'lugar removido'
      ? 'nesse dia o período aponta pra um lugar que foi removido'
      : `nesse dia você marcou como ocupado${ativo.periodo?.titulo ? ` (${ativo.periodo.titulo})` : ''}`)
    return { ok: false, motivos, lugar: null, ocupado: true }
  }

  const janelas = listarJanelas({ tipo }).filter((j) => j.ativo)
  const lugar = { nome: ativo.nome, cidades: ativo.cidades, fora: !!ativo.fora }

  // ESTAR FORA DA BASE não depende de janela. O período é um fato que ELE declarou — "de 4 a 7
  // de agosto eu estou em São Paulo" — e um compromisso detectado dentro dele merece o aviso
  // mesmo que ele nunca tenha cadastrado horário de compromisso nenhum. Sem isto, quem tem
  // zero janela de compromisso (o caso dele em 26/07/2026) nunca seria avisado de nada: a
  // viagem estaria registrada e o cartão continuaria oferecendo "adicionar" em silêncio.
  // O texto é informativo, não acusação: ninguém aqui sabe se o compromisso é em São Paulo.
  if (ativo.fora) {
    motivos.push(`nesse dia você está em ${ativo.nome}${ativo.periodo?.titulo ? ` (${ativo.periodo.titulo})` : ''}, longe de ${base ? base.nome : 'sua base'}`)
  }

  // Sem janela daquele tipo não existe "fora do horário" pra apontar; o aviso do lugar, se
  // houver, sai de qualquer forma.
  if (!janelas.length) return { ok: !motivos.length, semRegra: true, motivos, lugar }

  const { data, dow } = partes(quandoMs)
  const doDia = janelas.filter((j) => j.dow === dow)
  const noLugar = doDia.filter((j) => janelaValeNoLugar(j, ativo, base))
  const minutosServico = Number(ocupacao?.minutos) || duracaoMin
  const dentro = noLugar.some((j) => quandoMs >= paraMs(data, j.inicio) && quandoMs + minutosServico * 60000 <= paraMs(data, j.fim))

  if (!dentro) {
    // O lugar já foi dito acima quando ele está fora da base; aqui só se acrescenta o que
    // ainda não foi dito, pra o aviso não repetir "você está em São Paulo" duas vezes.
    if (doDia.length && !noLugar.length) motivos.push(ativo.fora ? 'e a sua disponibilidade desse dia é de outro lugar' : 'sua disponibilidade desse dia é de outro lugar')
    else if (!doDia.length) motivos.push('você não tem disponibilidade cadastrada nesse dia da semana')
    else motivos.push(`fora do seu horário (${noLugar.map((j) => `${j.inicio} às ${j.fim}`).join(', ')})`)
  }

  const bloco = ocupacao
    ? cabeNaAgenda(quandoMs, ocupacao, eventos)
    : { ok: agendaLivreEm(quandoMs, quandoMs + minutosServico * 60000, eventos) }
  if (!bloco.ok) {
    const colide = eventos.filter((e) => e.startMs).find((e) => {
      const oIni = e.startMs
      const oFim = e.endMs || e.startMs + 3600000
      const bIni = ocupacao ? quandoMs - (ocupacao.folgaAntesMin || 0) * 60000 : quandoMs
      const bFim = ocupacao ? quandoMs + minutosServico * 60000 + (ocupacao.folgaDepoisMin || 0) * 60000 : quandoMs + minutosServico * 60000
      return oIni < bFim && oFim > bIni
    })
    const folga = ocupacao && (ocupacao.folgaAntesMin || ocupacao.folgaDepoisMin)
      ? ` (precisa de ${ocupacao.folgaAntesMin || 0} min livres antes e ${ocupacao.folgaDepoisMin || 0} min depois)`
      : ''
    motivos.push(colide
      ? `bate com "${colide.title || 'outro compromisso'}" na sua agenda${folga}`
      : `a agenda não tem o bloco livre${folga}`)
  }

  return { ok: !motivos.length, motivos, lugar, ocupado: false }
}
