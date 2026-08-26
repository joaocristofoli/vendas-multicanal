// O CATÁLOGO. Cada coisa que o assistente sabe fazer mora aqui, com quatro campos que
// não são decoração:
//   nivel     — leitura | escrita | externa | sistema. Decide o que ele faz sozinho.
//   executar  — o efeito. Só código nosso; o modelo nunca toca em nada diretamente.
//   desfazer  — o plano de volta. Sem ele, "age sozinho" seria irreversível (decisão 1
//               do dono foi "ele age, PODENDO DESFAZER" — o desfazer é metade da decisão).
//   resumo    — a frase honesta do que aconteceu DE FATO, escrita por código, nunca pelo
//               modelo. É o comprovante: se o efeito não aconteceu, não existe frase.
//
// Níveis:
//   leitura  -> executa na hora, resultado volta pro modelo compor a resposta.
//   escrita  -> executa na hora e registra o desfazer (o dono decidiu assim).
//   externa  -> NÃO executa: cria uma pendência e pede confirmação (sai com o nome dele).
//   sistema  -> NÃO executa: cria um pedido de permissão (decisão 3 dele).
import fs from 'node:fs'
import path from 'node:path'
import { db, setAiSetting, getAiSetting, waChatSetMode, igChatSetMode, getSetting, setSetting, getWaChat, estatisticaConversa } from '../core/db.mjs'
import * as S from '../projects/store.mjs'
import { personAliases, canonicalPersonId } from '../projects/store.mjs'
import { prettyPhone } from '../wa/phone.mjs'
import { interpretarQuando, interpretarRecorrencia } from '../projects/capture.mjs'
import { createEvent, updateEvent, deleteEvent, listRange, connectionState } from '../agenda/google.mjs'
import { listarCompromissos } from '../agenda/local.mjs'
import { VALID_MODES } from '../ai/modos.mjs'
import { salvarFato, listarFatos, apagarFato } from '../self/fatos.mjs'
import { salvarJanela, listarJanelas, apagarJanela, slotsLivres, descreverSlot, conferirHorario } from '../self/encontros.mjs'
import { listarLugares, listarPeriodos, salvarPeriodo, apagarPeriodo, lugarBase, lugarAtivoEm, dataDe } from '../self/lugares.mjs'
import { memoriaDaPessoa } from '../self/memoria-pessoa.mjs'
import { vinculoDaPessoa } from '../self/vinculos.mjs'
import { buildHistory } from '../bridge/bridge.mjs'
import { nomeDe, pendencias, saude, compromissos } from './contexto.mjs'
import { avisoPadraoMin } from '../projects/reminders.mjs'
import { ehSelfPerson } from './guarda.mjs'
import { candidatosPessoa, resolverPessoa, canalPreferido } from './pessoas.mjs'
import { baixarVideo, descrever } from '../midia/video.mjs'
import { enviarVideoNoSelfChat } from './canal.mjs'
import { oDono, doDono, pronomeDono } from '../core/dono.mjs'
import { ENTREVISTA_DIR as ENTREVISTA_DIR_PADRAO } from '../core/caminhos.mjs'

const ENTREVISTA_DIR = ENTREVISTA_DIR_PADRAO
const TZ = 'America/Sao_Paulo'
const fmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: TZ })
const quando = (ms) => fmt.format(new Date(ms)).replace(',', '')

// Converte o que o modelo mandou em milissegundos. Aceita ISO (ele sabe a hora atual,
// então costuma mandar ISO) e frase em português (mesmo parser da captura rápida).
export function paraMs(valor) {
  if (valor == null || valor === '') return null
  if (typeof valor === 'number' && Number.isFinite(valor)) return valor
  const s = String(valor).trim()
  const iso = Date.parse(s.length <= 16 && /^\d{4}-\d{2}-\d{2}T/.test(s) ? `${s}:00-03:00` : s)
  if (!Number.isNaN(iso) && /^\d{4}-\d{2}-\d{2}/.test(s)) return iso
  const w = interpretarQuando(s)
  return w && w.ms ? w.ms : (Number.isNaN(iso) ? null : iso)
}

// Resolve "pessoa" (o nome que ele falou) num personId de verdade — para LEITURA, onde
// escolher errado custa uma resposta imprecisa e nada mais. Ordem por recência (quem ele
// fala é quem ele quis dizer). Nunca resolve pro próprio o dono: ele não é um contato.
//
// Quem MEXE em alguém (mandar mensagem, ligar IA, mudar modo) não usa esta: usa
// exigirPessoa, que recusa a ambiguidade em vez de chutar. Ver pessoas.mjs.
export function acharPessoa(accountKey, termo) {
  const t = String(termo || '').trim()
  if (!t) return null
  const cands = candidatosPessoa(accountKey, t)
  if (!cands.length) return null
  const exato = cands.find((p) => String(p.name || '').trim().toLowerCase() === t.toLowerCase())
  return exato || cands[0]
}

// A versão que não chuta: devolve a pessoa ou ESTOURA (PessoaAmbigua quando há mais de uma
// candidata, e o orquestrador transforma isso numa enquete). `__personId` é por onde a
// escolha da enquete volta — vem do código, nunca do modelo.
export function exigirPessoa(accountKey, args, campo = 'pessoa') {
  return resolverPessoa(accountKey, args?.[campo], { personId: args?.__personId || null })
}

// O telefone real de uma pessoa: o pn resolvido da conversa (um @lid não carrega número).
// Devolve o jid cru; quem formata é o prettyPhone, que já tira o sufixo de dispositivo.
function telefoneDaPessoa(personId) {
  for (const id of personAliases(canonicalPersonId(personId))) {
    if (!String(id).startsWith('wa:')) continue
    const jid = String(id).slice(3)
    const r = db().prepare(`SELECT pn FROM wa_chat WHERE jid=?`).get(jid)
    if (r?.pn) return r.pn
    const m = db().prepare(`SELECT pn FROM wa_identity WHERE lid=?`).get(jid)
    if (m?.pn) return m.pn
    if (!jid.includes('@lid')) return jid
  }
  return null
}

const diaCurto = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TZ })

// A frase de números da conversa. Escrita por CÓDIGO — é o que responde "o que tudo eu
// conversei com fulano" sem o modelo ter que adivinhar nada. O que não se sabe é dito
// como não sabido: mensagem antiga não tem carimbo de autoria e isso aparece.
function resumoEstatistica(s) {
  const partes = [`${s.total} mensagens`]
  if (s.primeira && s.ultima) partes.push(`de ${diaCurto.format(new Date(s.primeira))} a ${diaCurto.format(new Date(s.ultima))}`)
  partes.push(`${s.dela} dela, ${s.minhas} suas`)
  if (s.pelaIa) partes.push(`${s.pelaIa} das suas foram escritas pela IA`)
  if (s.semCarimbo > 0) partes.push(`${s.semCarimbo} suas sem registro de quem escreveu (anteriores ao carimbo)`)
  if (s.canais.length > 1) partes.push(`por canal: ${s.canais.map((c) => `${c.canal} ${c.n}`).join(', ')}`)
  return partes.join('; ')
}

// Resolve o lugar pelo nome que ele falou ("são paulo", "toledo"), aceitando também o nome de
// uma CIDADE dentro do grupo: ele diz "tô na cidade X", e X é uma das cidades da
// região-base — quem tem que saber disso é o código, não ele.
function acharLugar(termo) {
  const t = String(termo || '').toLowerCase().trim()
  if (!t) return null
  const todos = listarLugares()
  return todos.find((l) => l.nome.toLowerCase() === t)
    || todos.find((l) => l.nome.toLowerCase().includes(t))
    || todos.find((l) => l.cidades.some((c) => c.toLowerCase() === t))
    || todos.find((l) => l.cidades.some((c) => c.toLowerCase().includes(t)))
    || null
}

function projetoPorNome(accountKey, nome) {
  if (!nome) return null
  const alvo = String(nome).toLowerCase()
  return S.listProjects(accountKey).find((p) => p.name.toLowerCase() === alvo)
    || S.listProjects(accountKey).find((p) => p.name.toLowerCase().includes(alvo)) || null
}

// Procura um compromisso pelo que ele falou ("o dentista", "a reunião de quinta").
async function acharEvento(busca, { dias = 45 } = {}) {
  if (!connectionState().connected) throw new Error('agenda não conectada')
  const de = Date.now() - 2 * 86400000
  const ate = Date.now() + dias * 86400000
  const evs = await listRange({ timeMinIso: new Date(de).toISOString(), timeMaxIso: new Date(ate).toISOString() })
  const t = String(busca || '').toLowerCase().trim()
  if (!t) return null
  const porTitulo = evs.filter((e) => e.title.toLowerCase().includes(t))
  if (porTitulo.length) return porTitulo[0]
  // sem casar por título, tenta por dia ("quinta", "amanhã")
  const w = interpretarQuando(t)
  if (w && w.ms) {
    const dia = S.dayStampSP(w.ms)
    const doDia = evs.filter((e) => S.dayStampSP(e.startMs) === dia)
    if (doDia.length === 1) return doDia[0]
  }
  return null
}

// ---------------------------------------------------------------- o catálogo
export const ACOES = {
  // ============================ LEITURA ============================
  consultar_agenda: {
    nivel: 'leitura',
    descricao: 'compromissos da Google Agenda num intervalo',
    args: { dias: 'quantos dias pra frente (padrão 7)' },
    async executar({ dias = 7 }) {
      if (!connectionState().connected) return { dados: 'agenda não conectada' }
      const evs = await listRange({ timeMinIso: new Date().toISOString(), timeMaxIso: new Date(Date.now() + Number(dias || 7) * 86400000).toISOString() })
      return { dados: evs.length ? evs.map((e) => `${quando(e.startMs)} — ${e.title}${e.location ? ` (${e.location})` : ''} [id ${e.id}]`).join('\n') : 'nada marcado nesse período' }
    },
  },
  // "quando eu posso marcar dentista essa semana?" — a resposta é uma CONTA, não um palpite:
  // janela declarada, menos o que está na Google Agenda, menos período ocupado, filtrada pelo
  // lugar onde ele vai estar naquele dia. Quem calcula é slotsLivres; o modelo só redige o
  // que este bloco devolveu. Sem isso, ele responderia de memória e erraria com convicção.
  consultar_disponibilidade: {
    nivel: 'leitura',
    descricao: 'quando ela pode marcar algo: os próximos horários livres dentro da disponibilidade que ela cadastrou, já descontando a agenda, os períodos de viagem e o lugar onde ele vai estar. tipo "compromisso" pra coisa da vida (reunião, dentista) e "encontro" pra paquera',
    args: { tipo: 'encontro|compromisso (padrão compromisso)', dias: 'quantos dias pra frente (padrão 14)', quantos: 'quantos horários listar (padrão 8)', servico: 'nome do serviço (opcional — corta o horário na duração + folga da tabela)', faixa: 'tempo da faixa, ex: 30 minutos', duracao_min: 'minutos (só se não for serviço)' },
    async executar(a) {
      const tipo = a.tipo === 'encontro' ? 'encontro' : 'compromisso'
      const dias = Math.max(1, Math.min(60, Number(a.dias) || 14))
      const max = Math.max(1, Math.min(20, Number(a.quantos) || 8))
      const janelas = listarJanelas({ tipo })
      const linhas = []

      const base = lugarBase()
      const hoje = lugarAtivoEm(Date.now())
      linhas.push(hoje.ocupado
        ? 'hoje está marcado como ocupado'
        : `hoje você está em ${hoje.nome || 'lugar não cadastrado'}${hoje.fora ? ' (fora da sua base)' : ''}`)

      if (!janelas.length) {
        linhas.push(`você não tem NENHUMA disponibilidade de ${tipo} cadastrada — sem isso não existe resposta certa pra "quando eu posso", porque vazio na Google Agenda não significa disponível. Dá pra cadastrar na aba Agenda do painel ou me pedindo aqui.`)
        return { dados: linhas.join('\n') }
      }

      // A agenda entra descontada, das DUAS fontes: o calendário da casa sempre, a Google
      // quando conectada. Só se declara "olhei a agenda" quando a fonte externa respondeu ou
      // quando ela nem existe — o calendário da casa é nosso e está sempre íntegro.
      const naCasa = listarCompromissos({ fromMs: Date.now(), toMs: Date.now() + dias * 86400000 })
      let eventos = naCasa
      let agendaOk = !connectionState().connected
      if (connectionState().connected) {
        try {
          const doGoogle = await listRange({ timeMinIso: new Date().toISOString(), timeMaxIso: new Date(Date.now() + dias * 86400000).toISOString() })
          const idsGoogle = new Set(doGoogle.map((e) => e.id).filter(Boolean))
          eventos = [...doGoogle, ...naCasa.filter((c) => !(c.googleEventId && idsGoogle.has(c.googleEventId)))]
          agendaOk = true
        } catch { /* agenda fora do ar: o cálculo continua com o calendário da casa, e com ressalva */ }
      }

      let ocupacao = null
      if (a.servico || a.duracao_min) {
        try {
          const { resolverDuracaoAgenda } = await import('../self/servicos.mjs')
          const dur = resolverDuracaoAgenda({ texto: [a.servico, a.faixa, a.duracao_min ? `${a.duracao_min} minutos` : ''].filter(Boolean).join(' ') })
          if (dur.fonte !== 'padrao' || Number(a.duracao_min) > 0) {
            ocupacao = Number(a.duracao_min) > 0 && dur.fonte === 'padrao'
              ? { minutos: Number(a.duracao_min), folgaAntesMin: 0, folgaDepoisMin: 0, totalMin: Number(a.duracao_min) }
              : dur.ocupacao
          }
        } catch { /* sem serviço, o cálculo antigo permanece */ }
      }
      const slots = slotsLivres({ janelas, eventos, dias, max, ocupacao })
      linhas.push(`disponibilidade de ${tipo}: ${janelas.filter((j) => j.ativo).map((j) => `${j.diaNome} ${j.inicio}-${j.fim}${j.lugar && (!base || j.lugar.id !== base.id) ? ` em ${j.lugar.nome}` : ''}`).join('; ')}`)
      const per = listarPeriodos({ desde: Date.now() })
      if (per.length) linhas.push(`períodos: ${per.map((p) => `${p.de} a ${p.ate} ${p.tipo === 'ocupado' ? 'ocupado' : `em ${p.lugar?.nome || 'lugar removido'}`}`).join('; ')}`)
      linhas.push(slots.length
        ? `próximos horários (${dias} dias):\n${slots.map((s) => `- ${descreverSlot(s)}`).join('\n')}`
        : `nenhum horário livre nos próximos ${dias} dias dentro da sua disponibilidade`)
      if (!agendaOk) linhas.push('ATENÇÃO: a Google Agenda não foi consultada agora, então esses horários NÃO estão descontados dos seus compromissos. Diga isso a ele.')
      return { dados: linhas.join('\n') }
    },
  },
  consultar_pessoa: {
    nivel: 'leitura',
    // O NÚMERO é caso de uso de primeira classe, não um extra: ele pergunta pelo contato do
    // jeito que o WhatsApp mostra ("+55 11 99999-0010"). Dizer só "nome" no catálogo fazia o
    // modelo nem tentar a consulta quando recebia um telefone.
    descricao: 'quem é a pessoa: aceita NOME ou NÚMERO DE TELEFONE (em qualquer formato, com ou sem DDI/DDD/traço). Devolve o retrato da conversa (quantas mensagens, desde quando, por canal, quantas foram escritas pela IA), memória, vínculo e as últimas mensagens',
    args: { pessoa: 'nome ou telefone', mensagens: 'quantas mensagens recentes mostrar (padrão 14, máx 60)' },
    async executar({ pessoa, mensagens, __personId }, ctx) {
      // Leitura pode escolher sozinha (a mais recente), mas não pode ESCONDER que havia
      // outras: o modelo precisa saber que "contato_teste_p" era ambíguo pra poder perguntar em vez
      // de afirmar sobre a pessoa errada. Por isso os homônimos vão junto, nos dados.
      const cands = __personId ? [] : candidatosPessoa(ctx.accountKey, pessoa)
      const p = __personId ? resolverPessoa(ctx.accountKey, pessoa, { personId: __personId }) : acharPessoa(ctx.accountKey, pessoa)
      const exato = cands.find((c) => String(c.name || '').trim().toLowerCase() === String(pessoa || '').trim().toLowerCase())
      const homonimos = !exato && cands.length > 1 ? cands.filter((c) => c.personId !== p?.personId) : []
      if (!p) {
        // Diferencia "não é um contato" de "esse número não tem conversa aqui": as duas
        // respostas levam ele a coisas diferentes, e a segunda é a verdade sobre um telefone.
        const ehTelefone = String(pessoa || '').replace(/\D/g, '').length >= 8
        return { dados: ehTelefone
          ? `nenhuma conversa com o número ${prettyPhone(pessoa)} em nenhum canal (procurei pelas duas formas do celular, com e sem o 9)`
          : `não achei ninguém chamado "${pessoa}"` }
      }
      const pid = p.personId
      const quantas = Math.min(60, Math.max(1, Number(mensagens) || 14))
      const mem = memoriaDaPessoa(pid)
      const vin = vinculoDaPessoa(pid)
      const stats = estatisticaConversa(personAliases(canonicalPersonId(pid)))
      // buildHistory devolve OBJETO ({name, messages}) — jogar direto num template vira
      // "[object Object]" e o assistente responde "não recebi as mensagens" (aconteceu na
      // primeira prova ao vivo). Aqui vira transcrição legível.
      const h = buildHistory(pid, p.name, { max: quantas })
      const hist = (h.messages || []).slice(-quantas)
        .map((m) => {
          // quem escreveu importa: "você" pode ter sido a IA respondendo por ele
          const quem = m.direction === 'outgoing'
            ? (m.author === 'ia' ? 'a IA (por você)' : 'você')
            : (p.name || 'ela')
          return `${m.timestamp} ${quem}: ${m.text}`
        }).join('\n')
      return {
        dados: [
          homonimos.length
            ? `ATENÇÃO: "${pessoa}" casou com ${homonimos.length + 1} pessoas. Respondi sobre a de conversa mais recente; as outras são: ${homonimos.map((c) => c.rotulo).join(' | ')}. Se a pergunta dele depender de qual é, PERGUNTE (enquete) em vez de supor.`
            : null,
          `Pessoa: ${p.name || nomeDe(pid)} (id ${pid})`,
          telefoneDaPessoa(pid) ? `Telefone: ${prettyPhone(telefoneDaPessoa(pid))}` : null,
          `Canais: ${(p.channels || []).join(', ') || p.channel || 'desconhecido'}`,
          stats && stats.total ? `Conversa: ${resumoEstatistica(stats)}` : 'Conversa: nenhuma mensagem guardada',
          vin ? `Vínculo: ${vin.vinculo}` : null,
          `IA ligada: whatsapp=${!!getAiSetting(pid, 'whatsapp')?.enabled} instagram=${!!getAiSetting(pid, 'instagram')?.enabled} tinder=${!!getAiSetting(pid, 'tinder')?.enabled}`,
          mem?.resumo ? `Memória: ${mem.resumo}` : null,
          mem?.combinados ? `Combinados: ${mem.combinados}` : null,
          `Últimas ${quantas} mensagens:`,
          hist || '(sem histórico)',
        ].filter(Boolean).join('\n'),
      }
    },
  },
  buscar_conversa: {
    nivel: 'leitura',
    descricao: 'procura um termo nas conversas de uma pessoa (ou em todas)',
    args: { termo: 'o que procurar', pessoa: 'nome (opcional)' },
    async executar({ termo, pessoa }, ctx) {
      const t = `%${String(termo || '').trim()}%`
      if (!String(termo || '').trim()) return { dados: 'sem termo de busca' }
      let rows
      if (pessoa) {
        const p = acharPessoa(ctx.accountKey, pessoa)
        if (!p) return { dados: `não achei "${pessoa}"` }
        const ids = S.personAliases(p.personId)
        rows = db().prepare(`SELECT person_id, channel, direction, text, ts FROM message
          WHERE person_id IN (${ids.map(() => '?').join(',')}) AND text LIKE ? ORDER BY ts DESC LIMIT 12`).all(...ids, t)
      } else {
        rows = db().prepare(`SELECT person_id, channel, direction, text, ts FROM message WHERE text LIKE ? ORDER BY ts DESC LIMIT 12`).all(t)
      }
      const linhas = rows.filter((r) => !ehSelfPerson(ctx.accountKey, r.person_id))
        .map((r) => `${quando(r.ts)} ${nomeDe(r.person_id)} (${r.channel}, ${r.direction === 'outgoing' ? 'você' : 'ela'}): ${String(r.text).slice(0, 140)}`)
      return { dados: linhas.length ? linhas.join('\n') : 'nada encontrado' }
    },
  },
  consultar_pendencias: {
    nivel: 'leitura',
    descricao: 'quem está esperando resposta nos três canais',
    args: {},
    async executar() {
      const p = pendencias({ limite: 20 })
      return { dados: p.length ? p.map((x) => `${x.nome} (${x.canal}, ${x.quando}): ${x.ultima}`).join('\n') : 'ninguém esperando' }
    },
  },
  consultar_projetos: {
    nivel: 'leitura',
    descricao: 'projetos, tarefas e o que está por fazer',
    args: {},
    async executar(_a, ctx) {
      const ps = S.listProjectsAggregated(ctx.accountKey)
      const inbox = S.inboxTasks(ctx.accountKey)
      return {
        dados: [
          ps.length ? ps.map((p) => `${p.name} (${p.status}) — ${p.openTasks ?? '?'} tarefa(s) aberta(s)${p.nextTask ? `, próximo: ${p.nextTask.title}` : ''}`).join('\n') : 'nenhum projeto',
          inbox.length ? `Sem projeto: ${inbox.map((t) => t.title).join(', ')}` : null,
        ].filter(Boolean).join('\n'),
      }
    },
  },
  consultar_saude: {
    nivel: 'leitura',
    descricao: 'estado das conexões e erros recentes',
    args: {},
    async executar() { return { dados: JSON.stringify(saude(), null, 1) } },
  },
  consultar_fatos: {
    nivel: 'leitura',
    descricao: `fatos sobre ${oDono()} (propostos e aprovados)`,
    args: { status: 'proposto|aprovado (opcional)' },
    async executar({ status }) {
      const fs2 = listarFatos({ status: status || null }).slice(0, 30)
      return { dados: fs2.length ? fs2.map((f) => `[${f.id}] (${f.status}/${f.sensibilidade}) ${f.texto}`).join('\n') : 'nenhum fato' }
    },
  },

  // ============================ ESCRITA (faz e dá pra desfazer) ============================
  criar_compromisso: {
    nivel: 'escrita',
    descricao: 'cria um compromisso na Google Agenda (aparece no painel também). Se for um serviço cadastrado (ex: Atendimento 30 minutos), a duração e a folga da tabela mandam — não invente 1 hora.',
    args: { titulo: 'texto', quando: 'ISO ou frase (ex: quinta 15h)', duracao_min: 'número (só se NÃO for um serviço da tabela)', servico: 'nome do serviço cadastrado (opcional)', faixa: 'tempo da faixa, ex: 30 minutos (opcional)', pessoa: 'nome de quem vai (opcional)', projeto: 'nome do projeto (opcional)' },
    async executar(a, ctx) {
      if (!connectionState().connected) throw new Error('agenda não conectada')
      const ms = paraMs(a.quando ?? a.data ?? a.inicio)
      if (!ms) throw new Error('não entendi a data/hora')
      const titulo = String(a.titulo || 'Compromisso').trim()
      const { resolverDuracaoAgenda, lerServicos } = await import('../self/servicos.mjs')
      const { etiquetasDaPessoa } = await import('../self/etiquetas.mjs')
      let personId = null
      try { personId = a.pessoa ? acharPessoa(ctx.accountKey, a.pessoa)?.personId || null : null } catch { /* sem pessoa */ }
      const texto = [titulo, a.servico, a.faixa, a.duracao_min ? `${a.duracao_min} minutos` : ''].filter(Boolean).join(' ')
      const dur = resolverDuracaoAgenda({
        personId,
        texto,
        etiquetasDaPessoa: personId ? etiquetasDaPessoa(personId) : [],
      })
      // Se o assistente mandou um número e NÃO casou serviço, o número manda (caso dentista).
      const minutos = (dur.fonte === 'padrao' && Number(a.duracao_min) > 0) ? Number(a.duracao_min) : dur.minutos
      const servicoNome = dur.servico?.nome || (a.servico && lerServicos().itens.some((s) => s.nome.toLowerCase() === String(a.servico).toLowerCase()) ? a.servico : null)
      const proj = projetoPorNome(ctx.accountKey, a.projeto)
      const ev = await createEvent({
        title: titulo, startsAtIso: new Date(ms).toISOString(),
        endsAtIso: new Date(ms + minutos * 60000).toISOString(),
        description: `Criado pelo assistente do vendas-multicanal, a pedido ${doDono()}.`,
        projectId: proj?.id || null,
        personId,
        duracaoMinutos: minutos,
        servico: servicoNome,
        faixa: dur.faixa?.tempo || a.faixa || null,
      })
      if (proj) { S.logProject(proj.id, 'event_created', titulo); S.touchProject(proj.id) }
      return {
        resumo: `compromisso "${titulo}" marcado pra ${quando(ms)} (${minutos} min${dur.faixa ? `, ${dur.faixa.tempo}` : ''})${proj ? ` no projeto ${proj.name}` : ''}`,
        resultado: { eventId: ev.id, link: ev.htmlLink, inicio: ms, minutos },
        desfazer: { tipo: 'evento', eventId: ev.id },
      }
    },
  },
  remarcar_compromisso: {
    nivel: 'escrita',
    descricao: 'muda a data/hora de um compromisso existente',
    args: { busca: 'título ou dia do compromisso', novo_quando: 'ISO ou frase' },
    async executar(a) {
      const ev = await acharEvento(a.busca)
      if (!ev) throw new Error(`não achei o compromisso "${a.busca}"`)
      const ms = paraMs(a.novo_quando ?? a.quando)
      if (!ms) throw new Error('não entendi a nova data/hora')
      const dur = (ev.endMs && ev.startMs) ? (ev.endMs - ev.startMs) : 3600000
      await updateEvent({ eventId: ev.id, startsAtIso: new Date(ms).toISOString(), endsAtIso: new Date(ms + dur).toISOString() })
      return {
        resumo: `"${ev.title}" foi de ${quando(ev.startMs)} pra ${quando(ms)}`,
        resultado: { eventId: ev.id },
        desfazer: { tipo: 'evento_hora', eventId: ev.id, inicio: ev.startMs, fim: ev.endMs || (ev.startMs + 3600000) },
      }
    },
  },
  cancelar_compromisso: {
    nivel: 'escrita',
    descricao: 'apaga um compromisso da agenda',
    args: { busca: 'título ou dia' },
    async executar(a) {
      const ev = await acharEvento(a.busca)
      if (!ev) throw new Error(`não achei o compromisso "${a.busca}"`)
      await deleteEvent(ev.id)
      return {
        resumo: `compromisso "${ev.title}" (${quando(ev.startMs)}) cancelado`,
        resultado: { eventId: ev.id },
        desfazer: { tipo: 'evento_recriar', title: ev.title, inicio: ev.startMs, fim: ev.endMs, projectId: ev.projectId || null },
      }
    },
  },
  criar_lembrete: {
    nivel: 'escrita',
    descricao: 'cria um lembrete que chega no seu WhatsApp. Por padrão ele AVISA ANTES da hora (10 min) e toca de novo na hora marcada',
    args: {
      texto: 'o que lembrar',
      quando: 'ISO ou frase',
      recorrencia: 'daily|weekly|monthly|yearly (opcional)',
      avisar_antes: 'minutos de antecedência do aviso prévio (opcional; vazio = o padrão dele, 0 = só na hora)',
    },
    async executar(a, ctx) {
      const ms = paraMs(a.quando ?? a.at)
      if (!ms) throw new Error('não entendi quando')
      const rec = a.recorrencia || interpretarRecorrencia(String(a.texto || '') + ' ' + String(a.quando || '')) || null
      const pre = a.avisar_antes === undefined || a.avisar_antes === null || a.avisar_antes === ''
        ? null
        : Math.max(0, Math.min(24 * 60, Math.round(Number(a.avisar_antes) || 0)))
      const r = S.createReminder({ accountKey: ctx.accountKey, text: String(a.texto || '').trim(), at: ms, recurrence: rec, preMinutes: pre })
      // O comprovante diz se o aviso prévio vai sair DE FATO: com pouca antecedência ele não
      // sai (ver reminderPreAvisos), e prometer um aviso que não vem é pior que não prometer.
      const min = pre === null ? avisoPadraoMin() : pre
      const vaiAvisar = min > 0 && ms - Date.now() > min * 60000
      return {
        resumo: `lembrete "${r.text}" pra ${quando(ms)}${rec ? ` (${rec})` : ''}${vaiAvisar ? `, com aviso ${min} min antes` : ''}`,
        resultado: { id: r.id, avisoMin: vaiAvisar ? min : 0 },
        desfazer: { tipo: 'lembrete', id: r.id },
      }
    },
  },
  cancelar_lembrete: {
    nivel: 'escrita',
    descricao: 'apaga um lembrete',
    args: { busca: 'texto do lembrete' },
    async executar(a, ctx) {
      const t = String(a.busca || '').toLowerCase()
      const todos = S.remindersRange(ctx.accountKey, Date.now() - 30 * 86400000, Date.now() + 365 * 86400000)
      const alvo = todos.find((r) => r.text.toLowerCase().includes(t))
      if (!alvo) throw new Error(`não achei lembrete com "${a.busca}"`)
      S.deleteReminder(alvo.id)
      return {
        resumo: `lembrete "${alvo.text}" apagado`,
        resultado: { id: alvo.id },
        desfazer: { tipo: 'lembrete_recriar', text: alvo.text, at: alvo.at, recurrence: alvo.recurrence || null, projectId: alvo.project_id || null },
      }
    },
  },
  criar_tarefa: {
    nivel: 'escrita',
    descricao: 'cria uma tarefa (com prazo opcional)',
    args: { titulo: 'texto', prazo: 'ISO ou frase (opcional)', projeto: 'nome (opcional)' },
    async executar(a, ctx) {
      const proj = projetoPorNome(ctx.accountKey, a.projeto)
      const prazo = a.prazo ? paraMs(a.prazo) : null
      const t = S.createTask({ accountKey: ctx.accountKey, projectId: proj?.id || null, title: String(a.titulo || '').trim(), dueDate: prazo })
      return {
        resumo: `tarefa "${t.title}"${proj ? ` em ${proj.name}` : ''}${prazo ? `, prazo ${quando(prazo)}` : ''}`,
        resultado: { id: t.id },
        desfazer: { tipo: 'tarefa', id: t.id },
      }
    },
  },
  concluir_tarefa: {
    nivel: 'escrita',
    descricao: 'marca uma tarefa como feita',
    args: { busca: 'título da tarefa' },
    async executar(a, ctx) {
      const t = String(a.busca || '').toLowerCase()
      const cand = db().prepare(`SELECT * FROM task WHERE account_key=? AND done=0`).all(ctx.accountKey).find((x) => x.title.toLowerCase().includes(t))
      if (!cand) throw new Error(`não achei tarefa "${a.busca}"`)
      S.updateTask(cand.id, { done: true })
      return { resumo: `tarefa "${cand.title}" marcada como feita`, resultado: { id: cand.id }, desfazer: { tipo: 'tarefa_reabrir', id: cand.id } }
    },
  },
  criar_nota: {
    nivel: 'escrita',
    descricao: 'guarda uma ideia/nota',
    args: { texto: 'a nota', projeto: 'nome (opcional)' },
    async executar(a, ctx) {
      const proj = projetoPorNome(ctx.accountKey, a.projeto)
      const n = S.createNote({ accountKey: ctx.accountKey, projectId: proj?.id || null, text: String(a.texto || '').trim() })
      return { resumo: `nota guardada${proj ? ` em ${proj.name}` : ''}`, resultado: { id: n.id }, desfazer: { tipo: 'nota', id: n.id } }
    },
  },
  criar_projeto: {
    nivel: 'escrita',
    descricao: 'cria um projeto',
    args: { nome: 'texto', tipo: 'pessoal|trabalho (opcional)' },
    async executar(a, ctx) {
      const p = S.createProject({ accountKey: ctx.accountKey, name: String(a.nome || '').trim(), type: a.tipo || 'pessoal' })
      return { resumo: `projeto "${p.name}" criado`, resultado: { id: p.id }, desfazer: { tipo: 'projeto', id: p.id } }
    },
  },
  criar_habito: {
    nivel: 'escrita',
    descricao: 'cria um hábito pra acompanhar',
    args: { nome: 'texto', dias: 'daily ou lista (opcional)' },
    async executar(a, ctx) {
      const h = S.createHabit({ accountKey: ctx.accountKey, name: String(a.nome || '').trim(), days: a.dias || 'daily' })
      return { resumo: `hábito "${h.name}" criado`, resultado: { id: h.id }, desfazer: { tipo: 'habito', id: h.id } }
    },
  },
  marcar_habito: {
    nivel: 'escrita',
    descricao: 'marca um hábito como feito hoje',
    args: { nome: 'texto' },
    async executar(a, ctx) {
      const t = String(a.nome || '').toLowerCase()
      const h = S.habitsForDay(ctx.accountKey).find((x) => x.name.toLowerCase().includes(t))
      if (!h) throw new Error(`não achei o hábito "${a.nome}"`)
      const r = S.toggleHabit(h.id)
      return { resumo: `hábito "${h.name}" marcado (sequência ${r.streak_current})`, resultado: { id: h.id }, desfazer: { tipo: 'habito_desmarcar', id: h.id } }
    },
  },
  ligar_ia: {
    nivel: 'escrita',
    descricao: 'liga a IA de conversa numa pessoa, num canal',
    args: { pessoa: 'nome', canal: 'whatsapp|instagram|tinder' },
    async executar(a, ctx) {
      const p = exigirPessoa(ctx.accountKey, a)
      const pid = p.personId
      if (ehSelfPerson(ctx.accountKey, pid)) throw new Error('essa conversa é a sua com o vendas-multicanal — a IA de conversa nunca entra aqui')
      const canal = ['whatsapp', 'instagram', 'tinder'].includes(a.canal) ? a.canal : 'whatsapp'
      const antes = !!getAiSetting(pid, canal)?.enabled
      setAiSetting({ personId: pid, channel: canal, enabled: true })
      return { resumo: `IA ligada na ${p.name || nomeDe(pid)} (${canal})`, resultado: { personId: pid, canal }, desfazer: antes ? null : { tipo: 'ia', personId: pid, canal, valor: false } }
    },
  },
  desligar_ia: {
    nivel: 'escrita',
    descricao: 'desliga a IA de conversa numa pessoa, num canal',
    args: { pessoa: 'nome', canal: 'whatsapp|instagram|tinder' },
    async executar(a, ctx) {
      const p = exigirPessoa(ctx.accountKey, a)
      const pid = p.personId
      const canal = ['whatsapp', 'instagram', 'tinder'].includes(a.canal) ? a.canal : 'whatsapp'
      const antes = !!getAiSetting(pid, canal)?.enabled
      setAiSetting({ personId: pid, channel: canal, enabled: false })
      return { resumo: `IA desligada na ${p.name || nomeDe(pid)} (${canal})`, resultado: { personId: pid, canal }, desfazer: antes ? { tipo: 'ia', personId: pid, canal, valor: true } : null }
    },
  },
  mudar_modo: {
    nivel: 'escrita',
    descricao: 'muda o modo de conversa de uma pessoa no WhatsApp/Instagram',
    args: { pessoa: 'nome', modo: VALID_MODES.join('|') },
    async executar(a, ctx) {
      const p = exigirPessoa(ctx.accountKey, a)
      const pid = p.personId
      const modo = a.modo && VALID_MODES.includes(a.modo) ? a.modo : null
      if (!modo) throw new Error(`modo inválido (use um de: ${VALID_MODES.join(', ')})`)
      if (pid.startsWith('wa:')) {
        const jid = pid.slice(3)
        const antes = getWaChat(ctx.accountKey, jid)?.mode || null
        waChatSetMode(ctx.accountKey, jid, modo)
        return { resumo: `modo da ${p.name || nomeDe(pid)} virou ${modo}`, resultado: { personId: pid }, desfazer: { tipo: 'modo_wa', jid, valor: antes } }
      }
      if (pid.startsWith('ig:')) {
        const th = pid.slice(3)
        const antes = db().prepare(`SELECT mode FROM ig_chat WHERE thread_id=?`).get(th)?.mode || null
        igChatSetMode(ctx.accountKey, th, modo)
        return { resumo: `modo da ${p.name || nomeDe(pid)} virou ${modo}`, resultado: { personId: pid }, desfazer: { tipo: 'modo_ig', threadId: th, valor: antes } }
      }
      throw new Error('essa pessoa não tem conversa de WhatsApp nem de Instagram')
    },
  },
  registrar_fato: {
    nivel: 'escrita',
    // O texto vai pro prompt da IA de conversa junto do retrato, que é escrito em PRIMEIRA
    // pessoa ("Meu nome é o dono..."). Fato em terceira ("O prato favorito do dono é...")
    // fica desencontrado no mesmo bloco — e é como o assistente escrevia antes (25/07).
    descricao: `guarda um fato novo sobre ${oDono()}, JÁ VALENDO (${pronomeDono()} é a fonte: quem contou foi ${pronomeDono()}). ESCREVA O TEXTO NA PRIMEIRA PESSOA, como ${oDono()} contaria: "Meu prato favorito é strogonoff", não "O prato favorito ${doDono()} é strogonoff". Inclua gatilhos quando souber as palavras que fazem o assunto encostar no fato`,
    args: { texto: 'o fato em primeira pessoa', sensibilidade: 'livre|sob_pedido|nunca (padrão sob_pedido)', categoria: 'opcional', gatilhos: 'lista de palavras que ativam o fato (opcional)' },
    async executar(a) {
      const id = salvarFato({
        texto: String(a.texto || '').trim(),
        categoria: a.categoria || 'outro',
        sensibilidade: ['livre', 'sob_pedido', 'nunca'].includes(a.sensibilidade) ? a.sensibilidade : 'sob_pedido',
        gatilhos: Array.isArray(a.gatilhos) ? a.gatilhos : [],
        // JÁ APROVADO (correção do dono, 25/07): a fila de aprovação existe pra fato
        // EXTRAÍDO das conversas, que é inferência e pode estar errado. Quando ele mesmo
        // dita, a fonte é ele — pedir que aprove o que acabou de dizer é burocracia sem
        // função. Errou? o comprovante mostra o texto salvo e "desfaz" apaga na hora.
        status: 'aprovado', origem: 'você me contou', confianca: 1,
      })
      return { resumo: `anotado e já valendo: "${String(a.texto || '').slice(0, 80)}"`, resultado: { id }, desfazer: { tipo: 'fato', id } }
    },
  },
  decidir_fato: {
    nivel: 'escrita',
    descricao: 'aprova ou rejeita um fato proposto',
    args: { id: 'id do fato (ou trecho do texto)', decisao: 'aprovado|rejeitado' },
    async executar(a) {
      const alvo = listarFatos({}).find((f) => f.id === a.id || f.texto.toLowerCase().includes(String(a.id || a.busca || '').toLowerCase()))
      if (!alvo) throw new Error('não achei esse fato')
      const antes = alvo.status
      const decisao = a.decisao === 'rejeitado' ? 'rejeitado' : 'aprovado'
      salvarFato({ ...alvo, status: decisao })
      return { resumo: `fato "${alvo.texto.slice(0, 60)}" ficou ${decisao}`, resultado: { id: alvo.id }, desfazer: { tipo: 'fato_status', id: alvo.id, valor: antes } }
    },
  },
  definir_janela_encontro: {
    nivel: 'escrita',
    descricao: 'diz em que dia/horário você topa marcar algo. tipo "encontro" é paquera; "compromisso" é o resto (reunião, café de trabalho, dentista). lugar é opcional: sem ele, vale a base',
    args: { dia: 'domingo..sabado', de: 'HH:MM', ate: 'HH:MM', tipo: 'encontro|compromisso (padrão encontro)', lugar: 'nome do lugar (opcional)' },
    async executar(a) {
      const dias = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']
      const norm = String(a.dia || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      const dow = dias.findIndex((d) => norm.startsWith(d.slice(0, 3)))
      if (dow < 0) throw new Error('dia da semana inválido')
      const tipo = a.tipo === 'compromisso' ? 'compromisso' : 'encontro'
      const lugar = a.lugar ? acharLugar(a.lugar) : null
      if (a.lugar && !lugar) throw new Error(`não achei o lugar "${a.lugar}"`)
      const id = salvarJanela({ dow, inicio: a.de, fim: a.ate, tipo, lugarId: lugar?.id || null })
      return {
        resumo: `disponibilidade de ${tipo}: ${dias[dow]} das ${a.de} às ${a.ate}${lugar ? ` em ${lugar.nome}` : ''}`,
        resultado: { id, tipo },
        desfazer: { tipo: 'janela', id },
      }
    },
  },
  // Um período é o que responde "essa semana toda eu tô em São Paulo". Não bloqueia a agenda:
  // troca o LUGAR, e a disponibilidade da região onde ele mora deixa de valer sozinha.
  definir_periodo: {
    nivel: 'escrita',
    descricao: 'registra um intervalo de dias em que você está em outro lugar (viagem) ou totalmente ocupado. Enquanto durar, sua disponibilidade dos outros lugares não vale',
    args: { de: 'data (ISO ou frase)', ate: 'data (ISO ou frase)', lugar: 'nome do lugar, ou vazio se for "ocupado"', titulo: 'o que é (opcional)', tipo: 'em_lugar|ocupado (padrão em_lugar)' },
    async executar(a) {
      const de = paraMs(a.de), ate = paraMs(a.ate || a.de)
      if (!de || !ate) throw new Error('não entendi as datas do período')
      const tipo = a.tipo === 'ocupado' || (!a.lugar && a.tipo !== 'em_lugar') ? 'ocupado' : 'em_lugar'
      let lugar = null
      if (tipo === 'em_lugar') {
        lugar = acharLugar(a.lugar)
        if (!lugar) throw new Error(`não achei o lugar "${a.lugar}" — crie ele na aba Agenda ou diga "ocupado"`)
      }
      const id = salvarPeriodo({ de: dataDe(de), ate: dataDe(ate), tipo, lugarId: lugar?.id || null, titulo: a.titulo || '' })
      const q = `${dataDe(de).split('-').reverse().join('/')} a ${dataDe(ate).split('-').reverse().join('/')}`
      return {
        resumo: tipo === 'ocupado' ? `${q}: ocupado, nada pode ser marcado` : `${q}: você está em ${lugar.nome}`,
        resultado: { id, tipo },
        desfazer: { tipo: 'periodo', id },
      }
    },
  },
  anotar_entrevista: {
    nivel: 'escrita',
    descricao: 'guarda uma resposta sua da entrevista estruturada (os 8 blocos sobre quem você é)',
    args: { bloco: 'número 1-8', texto: 'a resposta crua' },
    async executar(a) {
      const n = Math.max(1, Math.min(8, Number(a.bloco) || 1))
      const linha = `\n\n[${new Date().toISOString()}]\n${String(a.texto || '').trim()}\n`
      const arq = path.join(ENTREVISTA_DIR, `bloco-${n}.md`)
      fs.mkdirSync(ENTREVISTA_DIR, { recursive: true })
      const antes = fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8') : null
      fs.appendFileSync(arq, antes ? linha : `# Bloco ${n} — entrevista estruturada${linha}`)
      return { resumo: `resposta do bloco ${n} guardada`, resultado: { arquivo: arq }, desfazer: { tipo: 'arquivo', caminho: arq, conteudo: antes } }
    },
  },
  configurar_proativo: {
    nivel: 'escrita',
    descricao: 'liga/desliga o que o vendas-multicanal pode te falar sem ser chamado',
    args: { tipo: 'compromissos_do_dia|alertas_de_sistema|avisos_de_resposta', ligado: 'true|false', hora: 'HH:MM (só pro resumo do dia)' },
    async executar(a) {
      const mapa = {
        compromissos_do_dia: 'assistente_proativo_dia',
        alertas_de_sistema: 'assistente_proativo_alertas',
        avisos_de_resposta: 'assistente_proativo_respostas',
      }
      const chave = mapa[a.tipo]
      if (!chave) throw new Error('tipo inválido')
      const antes = getSetting(chave, a.tipo === 'compromissos_do_dia')
      const valor = a.ligado === false || a.ligado === 'false' ? false : true
      setSetting(chave, valor)
      if (a.hora && /^\d{1,2}:\d{2}$/.test(a.hora)) setSetting('assistente_proativo_hora', a.hora)
      return { resumo: `${a.tipo.replace(/_/g, ' ')}: ${valor ? 'ligado' : 'desligado'}${a.hora ? ` (${a.hora})` : ''}`, resultado: { chave, valor }, desfazer: { tipo: 'setting', chave, valor: antes } }
    },
  },

  ajustar_aviso_de_lembrete: {
    nivel: 'escrita',
    descricao: 'muda de quantos em quantos minutos ANTES da hora os lembretes avisam (padrão 10; 0 desliga e passa a avisar só na hora)',
    args: { minutos: 'número de minutos de antecedência' },
    async executar(a) {
      const n = Math.round(Number(a.minutos))
      if (!Number.isFinite(n) || n < 0 || n > 24 * 60) throw new Error('diga um número de minutos entre 0 e 1440')
      const antes = getSetting('lembrete_aviso_min', 10)
      setSetting('lembrete_aviso_min', n)
      return {
        resumo: n === 0 ? 'os lembretes passam a avisar só na hora marcada' : `os lembretes passam a avisar ${n} min antes da hora`,
        resultado: { minutos: n },
        desfazer: { tipo: 'setting', chave: 'lembrete_aviso_min', valor: antes },
      }
    },
  },

  // "me baixa esse vídeo" — o link vem, o arquivo volta no próprio self-chat. Nível ESCRITA e
  // não externa: o vídeo é entregue a ELE, na conversa dele comigo. Nada sai com o nome dele
  // pra ninguém, então pedir confirmação seria burocracia num pedido que já é a ordem.
  // O download é `src/midia/video.mjs` (conta, sem navegador e sem modelo); aqui só se decide
  // entregar. Sem `desfazer`: apagar do WhatsApp uma mensagem que ele pediu não é volta, é
  // sumiço — o arquivo fica na VM e a pasta se poda sozinha.
  baixar_video: {
    nivel: 'escrita',
    descricao: 'baixa um vídeo do Instagram (reel, post ou story) na melhor qualidade e te manda aqui no WhatsApp. Só precisa do link. formato "arquivo" manda como documento (mesmos bytes, chega com nome e sem player)',
    args: { link: 'o link do post/reel (aceita o link compartilhado do app)', formato: 'video (padrão) ou arquivo' },
    async executar(a, ctx) {
      const link = String(a.link || '').trim()
      if (!link) throw new Error('me manda o link do vídeo')
      const comoArquivo = /arquivo|documento|doc/i.test(String(a.formato || ''))
      const r = await baixarVideo(link)
      const linha = descrever(r)
      // O teto de ~64 MB é do formato VÍDEO; documento vai até ~2 GB. Então "grande demais"
      // não é mais um beco: passa a arquivo sozinho e diz que passou, em vez de desistir.
      const forcadoPorTamanho = !r.cabeNoWhatsapp && !comoArquivo
      const env = await enviarVideoNoSelfChat({
        sock: ctx?.sock || null, accountKey: ctx?.accountKey || 'main',
        caminho: r.arquivo, legenda: linha, origem: 'assistente',
        comoArquivo: comoArquivo || forcadoPorTamanho,
      })
      if (!env.ok) return { resumo: `baixei (${linha}), mas não consegui te mandar aqui (${env.motivo}) — está na VM em ${r.arquivo}`, resultado: { arquivo: r.arquivo, enviado: false } }
      const como = env.comoArquivo ? 'como arquivo' : 'o vídeo'
      return {
        resumo: `mandei ${como} aqui: ${linha}${forcadoPorTamanho ? ' (passou do teto de vídeo do WhatsApp, então foi como arquivo)' : ''}`,
        resultado: { arquivo: r.arquivo, bytes: r.bytes, enviado: true, comoArquivo: env.comoArquivo, waMsgId: env.waMsgId },
      }
    },
  },

  // ============================ META (controle da própria conversa) ============================
  // Não têm executar: quem trata é o orquestrador (conversa.mjs), que é dono do registro
  // de ações e das pendências. Ficam no catálogo porque o modelo precisa saber que existem.
  desfazer: {
    nivel: 'meta',
    descricao: 'desfaz a última coisa que eu fiz (ou uma ação específica pelo id)',
    args: { id: 'id da ação (opcional; sem id, a última)' },
  },
  confirmar: {
    nivel: 'meta',
    descricao: 'ela autorizou uma pendência (mandar mensagem pra alguém, permissão de sistema)',
    args: { id: 'id da pendência (opcional; sem id, a mais recente)' },
  },
  cancelar: {
    nivel: 'meta',
    descricao: 'ela recusou uma pendência',
    args: { id: 'id da pendência (opcional; sem id, a mais recente)' },
  },

  // ============================ EXTERNA (pede confirmação) ============================
  responder_pessoa: {
    nivel: 'externa',
    descricao: 'manda uma mensagem SUA pra uma pessoa (sai com o seu nome, então eu confirmo antes)',
    args: { pessoa: 'nome', canal: 'whatsapp|instagram|tinder', texto: 'a mensagem' },
    async preparar(a, ctx) {
      // exigirPessoa, não acharPessoa: uma mensagem sai com o NOME DELE. Homônimo aqui não
      // é imprecisão, é mensagem entregue na pessoa errada — então a ambiguidade sobe
      // (PessoaAmbigua) e vira enquete antes de qualquer coisa ser preparada.
      const p = exigirPessoa(ctx.accountKey, a)
      const pid = p.personId
      if (ehSelfPerson(ctx.accountKey, pid)) throw new Error('essa conversa é a sua comigo')
      // O canal é o que a PESSOA tem, não o que o modelo chutou. Ele diz "whatsapp" por
      // reflexo (é o canal principal), e quem só existe no Tinder ia falhar com "essa pessoa
      // não tem WhatsApp vinculado" DEPOIS do ok dele — confirmação gasta num envio que
      // nunca ia sair. Sem pedido válido, vale onde a conversa está viva (canalPreferido).
      const canal = canalPreferido(pid, a.canal, p.channels)
      return { resumo: `mandar pra ${p.name || nomeDe(pid)} (${canal}): "${String(a.texto || '').slice(0, 160)}"`, dados: { personId: pid, canal, texto: String(a.texto || '') } }
    },
  },

  // ============================ SISTEMA (pede permissão) ============================
  rodar_comando: {
    nivel: 'sistema',
    descricao: 'roda um comando no servidor (só depois de você permitir)',
    args: { comando: 'o comando', motivo: 'por que precisa' },
    async preparar(a) {
      const cmd = String(a.comando || '').trim()
      if (!cmd) throw new Error('comando vazio')
      return { resumo: `rodar no servidor: ${cmd}`, dados: { comando: cmd, motivo: String(a.motivo || '') } }
    },
  },
  ler_arquivo: {
    nivel: 'sistema',
    descricao: 'lê um arquivo do servidor (só depois de você permitir)',
    args: { caminho: 'caminho absoluto', motivo: 'por que precisa' },
    async preparar(a) {
      const c = String(a.caminho || '').trim()
      if (!c.startsWith('/')) throw new Error('caminho tem que ser absoluto')
      return { resumo: `ler o arquivo ${c}`, dados: { caminho: c, motivo: String(a.motivo || '') } }
    },
  },
}

// ---------------------------------------------------------------- desfazer
// O plano de volta de cada tipo de efeito. Idempotente: desfazer duas vezes não quebra.
export async function executarDesfazer(plano) {
  if (!plano || !plano.tipo) throw new Error('essa ação não tem volta')
  switch (plano.tipo) {
    case 'evento': await deleteEvent(plano.eventId); return 'compromisso removido da agenda'
    case 'evento_hora':
      await updateEvent({ eventId: plano.eventId, startsAtIso: new Date(plano.inicio).toISOString(), endsAtIso: new Date(plano.fim).toISOString() })
      return `compromisso voltou pra ${quando(plano.inicio)}`
    case 'evento_recriar': {
      const ev = await createEvent({ title: plano.title, startsAtIso: new Date(plano.inicio).toISOString(), endsAtIso: new Date(plano.fim || plano.inicio + 3600000).toISOString(), projectId: plano.projectId || null })
      return `compromisso "${plano.title}" recriado (id ${ev.id})`
    }
    case 'lembrete': S.deleteReminder(plano.id); return 'lembrete apagado'
    case 'lembrete_recriar': { const r = S.createReminder({ accountKey: 'main', text: plano.text, at: plano.at, recurrence: plano.recurrence, projectId: plano.projectId }); return `lembrete "${r.text}" recriado` }
    case 'tarefa': S.deleteTask(plano.id); return 'tarefa apagada'
    case 'tarefa_reabrir': S.updateTask(plano.id, { done: false }); return 'tarefa reaberta'
    case 'nota': S.deleteNote(plano.id); return 'nota apagada'
    case 'projeto': S.deleteProject(plano.id); return 'projeto apagado'
    case 'habito': S.deleteHabit(plano.id); return 'hábito apagado'
    case 'habito_desmarcar': S.toggleHabit(plano.id); return 'hábito desmarcado'
    case 'ia': setAiSetting({ personId: plano.personId, channel: plano.canal, enabled: !!plano.valor }); return `IA ${plano.valor ? 'religada' : 'desligada'}`
    case 'modo_wa': waChatSetMode('main', plano.jid, plano.valor); return 'modo voltou'
    case 'modo_ig': igChatSetMode('main', plano.threadId, plano.valor); return 'modo voltou'
    case 'fato': apagarFato(plano.id); return 'fato apagado'
    case 'fato_status': { const f = listarFatos({}).find((x) => x.id === plano.id); if (f) salvarFato({ ...f, status: plano.valor }); return 'fato voltou pro estado anterior' }
    case 'janela': apagarJanela(plano.id); return 'janela removida'
    case 'periodo': apagarPeriodo(plano.id); return 'período removido'
    case 'setting': setSetting(plano.chave, plano.valor); return 'configuração voltou'
    case 'arquivo':
      if (plano.conteudo == null) { try { fs.unlinkSync(plano.caminho) } catch { /* já não existe */ } return 'arquivo removido' }
      fs.writeFileSync(plano.caminho, plano.conteudo); return 'arquivo voltou ao conteúdo anterior'
    default: throw new Error(`não sei desfazer "${plano.tipo}"`)
  }
}

// Catálogo em texto pro prompt. Compacto de propósito: é o que o modelo lê todo turno.
export function catalogoParaPrompt() {
  const linhas = []
  for (const [nome, a] of Object.entries(ACOES)) {
    const args = Object.keys(a.args || {}).length ? Object.entries(a.args).map(([k, v]) => `${k} (${v})`).join(', ') : 'sem argumentos'
    linhas.push(`- ${nome} [${a.nivel}]: ${a.descricao}. Args: ${args}`)
  }
  return linhas.join('\n')
}

export function nivelDe(nome) { return ACOES[nome]?.nivel || null }
