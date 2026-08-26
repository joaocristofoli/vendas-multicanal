// O "estado agora" que vai no prompt do assistente: um retrato compacto do que o vendas-multicanal sabe
// neste segundo. Existe pra 80% das perguntas serem respondidas em UM turno, sem ida e
// volta de consulta (que é o que faz assistente parecer lento).
//
// Regra: compacto e verdadeiro. Nada aqui é opinião — é leitura do banco e da agenda.
import { db, getSetting, getWaSession, aiEnabledPeople, recentEvents } from '../core/db.mjs'
import { nowBrasil } from '../ai/prompt.mjs'
import { ocupacaoAgenda, ensureAgendaFresh } from '../agenda/context.mjs'
import { connectionState as agendaEstado } from '../agenda/google.mjs'
import * as S from '../projects/store.mjs'
import { ehSelfPerson } from './guarda.mjs'
import { permissoesPendentes, assistAcoes } from '../core/db.mjs'
import { nomeParaMostrar } from '../core/nome.mjs'
import { lerPix } from '../self/pix.mjs'
import { oDono, pronomeDono, ddonoPossessivo } from '../core/dono.mjs'
import { rotinaBlock } from '../self/rotina.mjs'

const fmtHora = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
const fmtDia = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })

function quandoLegivel(ms) {
  const hoje = S.dayStampSP(Date.now())
  const alvo = S.dayStampSP(ms)
  if (alvo === hoje) return `hoje ${fmtHora.format(new Date(ms))}`
  if (alvo === S.addDaysStamp(hoje, 1)) return `amanhã ${fmtHora.format(new Date(ms))}`
  return `${fmtDia.format(new Date(ms))} ${fmtHora.format(new Date(ms))}`
}

// Compromissos de hoje e amanhã, já legíveis: o calendário da casa mais a Google, quando
// conectada. Lê do cache de 5 min — quem chama passa por ensureAgendaFresh antes
// (estadoAgora faz isso).
export function compromissos({ dias = 2 } = {}) {
  const events = ocupacaoAgenda({ desde: S.startOfDaySP(S.dayStampSP()), dias: dias + 1 })
  const de = S.startOfDaySP(S.dayStampSP())
  const ate = de + dias * 86400000
  return (events || [])
    .filter((e) => e.startMs && e.startMs >= de && e.startMs < ate)
    .sort((a, b) => a.startMs - b.startMs)
    .slice(0, 12)
    .map((e) => ({ id: e.id, titulo: e.title, quando: quandoLegivel(e.startMs), inicio: e.startMs, diaTodo: !!e.allDay }))
}

// Quem está esperando resposta (última mensagem foi dela) — os três canais.
export function pendencias({ limite = 12, accountKey = 'main' } = {}) {
  const linhas = db().prepare(`
    SELECT m.person_id, m.channel, m.text, m.ts, m.direction FROM message m
    JOIN (SELECT person_id, max(ts) mx FROM message GROUP BY person_id) u
      ON u.person_id=m.person_id AND u.mx=m.ts
    WHERE m.direction='incoming' AND m.ts > ?
    ORDER BY m.ts DESC LIMIT 60`).all(Date.now() - 30 * 86400000)
  const out = []
  for (const l of linhas) {
    if (ehSelfPerson(accountKey, l.person_id)) continue // quem opera nunca é pendência
    out.push({
      personId: l.person_id,
      nome: nomeDe(l.person_id),
      canal: l.channel,
      ultima: String(l.text || '').slice(0, 90),
      quando: quandoLegivel(l.ts),
      ts: l.ts,
    })
    if (out.length >= limite) break
  }
  return out
}

// Delega pro nome de exibição único. A versão anterior caía pro `pn` cru
// ("551199990006:0@s.whatsapp.net") e, no fim, pro próprio person_id — foi assim que um
// `wa:...@lid` foi parar na tela do dono. Nada aqui pode devolver identificador interno,
// porque isto alimenta tanto o painel quanto o que o assistente FALA.
export function nomeDe(personId) { return nomeParaMostrar(personId) }

// Saúde das conexões — é o que responde "tá tudo de pé?" sem eu ter que abrir o painel.
export function saude() {
  const wa = getWaSession('main')
  const erros = recentEvents(60).filter((e) => /err|error|erro|falha/i.test(e.type || '')).slice(0, 5)
  return {
    whatsapp: wa?.status || 'IDLE',
    agenda: agendaEstado().connected ? 'conectada' : 'desconectada',
    ia_whatsapp_ligada: aiEnabledPeople('whatsapp').length,
    ia_instagram_ligada: aiEnabledPeople('instagram').length,
    ia_tinder_ligada: aiEnabledPeople('tinder').length,
    ultimos_erros: erros.map((e) => `${e.type}: ${String(e.detail || '').slice(0, 80)}`),
  }
}

// O bloco de texto que entra no prompt. Curto de propósito.
export async function estadoAgora({ accountKey = 'main' } = {}) {
  try { await ensureAgendaFresh() } catch { /* agenda fora do ar não pode travar a conversa */ }
  const hoje = S.todayData(accountKey)
  const evs = compromissos()
  const pend = pendencias({ limite: 8 })
  const projetos = S.listProjects(accountKey).filter((p) => p.status === 'ativo').map((p) => p.name)
  const permissoes = permissoesPendentes()
  const pendentesAcao = assistAcoes({ estado: 'pendente', limit: 5 })
  const escolha = assistAcoes({ estado: 'desambiguando', limit: 1 })[0] || null
  let escolhaEmAberto = null
  if (escolha) {
    try {
      const d = JSON.parse(escolha.args || '{}')
      escolhaEmAberto = `${escolha.resumo} — opções: ${(d.candidatos || []).map((c, i) => `${i + 1}. ${c.rotulo}`).join(' | ')}`
    } catch { escolhaEmAberto = escolha.resumo }
  }
  const s = saude()
  const pix = lerPix()
  let rotina = ''
  try { rotina = rotinaBlock() } catch { /* rotina nunca derruba o assistente */ }
  const linhas = [
    `Agora: ${nowBrasil()}`,
    // Ele precisa saber que o outro modo existe pra poder falar dele quando o dono perguntar
    // o que dá pra fazer. Quem troca é o interruptor de texto, nunca o modelo.
    `MODO ATUAL: assistente. O outro modo deste mesmo chat é o CÓDEX — um agente que roda dentro da VM, no código-fonte do vendas-multicanal, e edita o sistema. Ele entra com "modo codex" e sai com "modo normal". Você não pode ligá-lo por ação: é ${oDono()} que digita.`,
    '',
    'AGENDA (Google, hoje e amanhã):',
    evs.length ? evs.map((e) => `- ${e.quando} — ${e.titulo}`).join('\n') : '- nada marcado',
    rotina ? `\n${rotina}` : null,
    '',
    'HOJE NO PAINEL:',
    hoje.reminders?.length ? hoje.reminders.map((r) => `- lembrete ${fmtHora.format(new Date(r.at))}: ${r.text}`).join('\n') : '- nenhum lembrete hoje',
    hoje.tasks?.length ? hoje.tasks.map((t) => `- tarefa com prazo hoje: ${t.title}`).join('\n') : '- nenhuma tarefa vencendo hoje',
    hoje.habits?.length ? `- hábitos: ${hoje.habits.map((h) => `${h.name}${h.done ? ' (feito)' : ''}`).join(', ')}` : null,
    '',
    `PROJETOS ATIVOS: ${projetos.length ? projetos.join(', ') : 'nenhum'}`,
    pix.nome && pix.chave ? `PIX PARA RECEBER: titular ${pix.nome}; chave ${pix.chave}.` : 'PIX PARA RECEBER: não configurado.',
    '',
    'ESPERANDO RESPOSTA (últimas mensagens que chegaram e não foram respondidas):',
    pend.length ? pend.map((p) => `- ${p.nome} (${p.canal}, ${p.quando}): ${p.ultima}`).join('\n') : '- ninguém',
    '',
    `SISTEMA: WhatsApp ${s.whatsapp}, agenda ${s.agenda}, IA ligada em ${s.ia_whatsapp_ligada} conversa(s) de WhatsApp, ${s.ia_instagram_ligada} de Instagram, ${s.ia_tinder_ligada} de Tinder.`,
    s.ultimos_erros.length ? `Erros recentes: ${s.ultimos_erros.join(' | ')}` : null,
    permissoes.length ? `PERMISSÕES ESPERANDO RESPOSTA ${ddonoPossessivo().toUpperCase()}: ${permissoes.map((p) => `${p.id} (${p.tipo}: ${p.alvo})`).join(', ')}` : null,
    pendentesAcao.length ? `AÇÕES ESPERANDO CONFIRMAÇÃO ${ddonoPossessivo().toUpperCase()}: ${pendentesAcao.map((a) => `${a.id} — ${a.resumo}`).join(' | ')}` : null,
    // Uma escolha de pessoa em aberto tem que aparecer aqui: se ele responder algo que o
    // casamento por código não reconhece ("o da aviação"), o modelo precisa saber que existe
    // uma pergunta pendente e as opções, em vez de tratar como assunto novo.
    escolhaEmAberto ? `VOCÊ PERGUNTOU QUAL PESSOA E ${pronomeDono().toUpperCase()} AINDA NÃO ESCOLHEU: ${escolhaEmAberto}` : null,
  ].filter((x) => x !== null && x !== undefined)
  return linhas.join('\n')
}

// Bloco separado só com o que o assistente PODE dizer sem ser chamado (decisão do dono:
// ele fala primeiro só no que eu ligar).
export function proativoConfig() {
  return {
    compromissos_do_dia: getSetting('assistente_proativo_dia', true) !== false,
    hora_do_resumo: String(getSetting('assistente_proativo_hora', '08:00')),
    alertas_de_sistema: getSetting('assistente_proativo_alertas', false) === true,
    avisos_de_resposta: getSetting('assistente_proativo_respostas', false) === true,
  }
}
