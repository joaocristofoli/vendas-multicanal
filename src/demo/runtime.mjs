import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  addMessage,
  badooChats,
  channelMessages,
  db,
  getAiSetting,
  getBadooChat,
  getIgChat,
  getMpChat,
  getSetting,
  getTelegramChat,
  getWaChat,
  igChats,
  listSavedAudios,
  mpChats,
  pendingAgendaProposals,
  setSetting,
  telegramChats,
  tinderMatches,
  upsertWaSession,
  waChats,
} from '../core/db.mjs'
import { lerPix } from '../self/pix.mjs'
import { lerServicos } from '../self/servicos.mjs'
import { listarCompromissos } from '../agenda/local.mjs'
import { estadoSwipe } from '../tinder/swipe.mjs'
import { estadoEncontros, ligarEncontros } from '../badoo/encontros.mjs'
import { estadoDescobertaBadoo, ligarDescobertaBadoo } from '../badoo/descoberta.mjs'
import { compararPeriodo, REGUA, resumoConversas, serieConversas } from '../conversas/progresso.mjs'

const ASSETS = path.resolve(process.env.TIM_DATA_DIR || 'data', 'demo-assets')
const MIN = 60_000
const HOUR = 60 * MIN

const draftByChannel = {
  tinder: 'Gostei da ideia. Posso te mostrar as opções com os valores certinhos e, se fizer sentido, já deixamos uma data separada.',
  whatsapp: 'Claro! Tenho opções presenciais e digitais. Me diz qual resultado você procura que eu te passo o formato e o valor exatos.',
  instagram: 'Tenho sim 😊 Posso te mostrar duas opções que combinam com o que você descreveu, sem compromisso.',
  badoo: 'Atendo online e presencialmente. Para começar, a consultoria de 30 minutos custa R$ 90 e a de 60 minutos custa R$ 160.',
  telegram: 'Perfeito. Vou organizar serviço, prazo e valor para você decidir com tudo claro.',
  meupatrocinio: 'A produção premium dura 2 horas e custa R$ 450. Se quiser, explico o planejamento e a entrega antes de reservar.',
}

function asset(res, pathname) {
  const relative = decodeURIComponent(pathname.slice('/api/demo/assets/'.length))
  const file = path.resolve(ASSETS, relative)
  if (!file.startsWith(ASSETS + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false
  const ext = path.extname(file).toLowerCase()
  const type = ext === '.png' ? 'image/png' : ext === '.ogg' ? 'audio/ogg' : 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=86400' })
  fs.createReadStream(file).pipe(res)
  return true
}

const nativePersonId = (channel, id) => channel === 'whatsapp' ? null
  : channel === 'instagram' ? `ig:${id}`
    : channel === 'badoo' ? `b:${id}`
      : channel === 'telegram' ? `tg:${id}`
        : channel === 'meupatrocinio' ? `mp:${id}` : id

function personForWa(account, jid) {
  return db().prepare(`SELECT person_id FROM identity WHERE account_key=? AND channel='whatsapp' AND channel_id=?`).get(account, jid)?.person_id || `wa:${jid}`
}

function recordSend({ account, channel, target, text, author = 'humano' }) {
  const personId = channel === 'whatsapp' ? personForWa(account, target) : nativePersonId(channel, target)
  const ts = Date.now()
  const messageId = `demo:${channel}:${target}:${ts}:${crypto.randomBytes(3).toString('hex')}`
  addMessage({ messageId, accountKey: account, personId, channel, direction: 'outgoing', text, ts, author })
  if (channel === 'whatsapp') db().prepare(`UPDATE wa_chat SET last_text=?,last_ts=?,updated_at=? WHERE account_key=? AND jid=?`).run(text, ts, ts, account, target)
  else if (channel === 'instagram') db().prepare(`UPDATE ig_chat SET last_text=?,last_ts=?,updated_at=? WHERE account_key=? AND thread_id=?`).run(text, ts, ts, account, target)
  else if (channel === 'badoo') db().prepare(`UPDATE badoo_chat SET previa=?,last_ts=?,updated_at=? WHERE account_key=? AND chat_id=?`).run(text, ts, ts, account, target)
  else if (channel === 'telegram') db().prepare(`UPDATE telegram_chat SET previa=?,last_ts=?,updated_at=? WHERE account_key=? AND chat_id=?`).run(text, ts, ts, account, target)
  else if (channel === 'meupatrocinio') db().prepare(`UPDATE mp_chat SET previa=?,last_ts=?,updated_at=? WHERE account_key=? AND peer_id=?`).run(text, ts, ts, account, target)
  else if (channel === 'tinder') {
    db().prepare(`UPDATE tinder_match SET last_text=?,last_ts=?,last_dir='eu',pending=0,has_conversation=1,updated_at=? WHERE account_key=? AND person_id=?`)
      .run(text, ts, ts, account, personId)
  }
  return { messageId, personId, ts }
}

function channelConversation(channel, target, account) {
  const personId = nativePersonId(channel, target)
  const messages = channelMessages(personId, channel, 200).map((m) => ({
    id: m.message_id,
    dir: m.direction === 'outgoing' ? 'out' : 'in',
    text: m.text,
    ts: m.ts,
    type: 'texto',
    autor: m.author || null,
  }))
  if (channel === 'badoo') {
    const c = getBadooChat(account, target)
    return { chatId: target, nome: c?.name || null, foto: c?.foto || null, personId, aiOn: !!getAiSetting(personId, channel)?.enabled, messages, metricas: { mensagens: messages.length } }
  }
  if (channel === 'telegram') {
    const c = getTelegramChat(account, target)
    return { chatId: target, nome: c?.nome || null, username: c?.username || null, personId, aiOn: !!getAiSetting(personId, channel)?.enabled, messages, metricas: { mensagens: messages.length } }
  }
  const c = getMpChat(account, target)
  return { peerId: target, nome: c?.nome || null, foto: c?.foto || null, personId, aiOn: !!getAiSetting(personId, channel)?.enabled, messages, metricas: { mensagens: messages.length } }
}

function demoConfig() {
  return {
    available: true,
    documents: [
      { id: 'perfil', label: 'Perfil de demonstração', filename: 'quem-eu-sou.md', available: true, text: 'Profissional criativo que vende serviços e produtos digitais com clareza, consentimento e valores cadastrados.', usedChars: 119, fullText: 'Perfil inteiramente fictício para gravação da demonstração local.', fullChars: 66, usesFullFile: false },
      { id: 'estilo', label: 'Estilo de conversa', filename: 'como-eu-converso.md', available: true, text: 'Português natural, direto, cordial e sem pressão. Nunca inventa preço, prazo ou disponibilidade.', usedChars: 98, fullText: 'Português natural, direto, cordial e sem pressão. Nunca inventa preço, prazo ou disponibilidade.', fullChars: 98, usesFullFile: true },
      { id: 'voz', label: 'Núcleo da voz', filename: 'nucleo-voz.md', available: true, text: 'Clareza, respeito, discrição e próximo passo concreto.', usedChars: 52, fullText: 'Clareza, respeito, discrição e próximo passo concreto.', fullChars: 52, usesFullFile: true },
    ],
    pix: lerPix(),
    servicos: lerServicos(),
    openai: {
      connected: true,
      account: { email: 'modo-local@example.com', planType: 'plus', type: 'chatgpt' },
      limits: [{ id: 'demo', name: 'Uso semanal demonstrativo', primary: { usedPercent: 18, resetsAt: Date.now() + 4 * 24 * 3600_000, windowDurationMins: 10080 }, credits: { hasCredits: true, balance: 'demo' } }],
      usage: { summary: { lifetimeTokens: 214020, peakDailyTokens: 48200, currentStreakDays: 6, longestRunningTurnSec: 41 }, daily: [
        { startDate: new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10), tokens: 28200 },
        { startDate: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10), tokens: 31500 },
        { startDate: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10), tokens: 48200 },
        { startDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10), tokens: 36100 },
        { startDate: new Date().toISOString().slice(0, 10), tokens: 22400 },
      ] },
      resetCredits: { availableCount: 2 }, hostVersion: 'demo-local', fetchedAt: Date.now(),
    },
    ia: {
      ativo: 'codex',
      providers: { ativo: 'codex', codex: { pronto: true, nome: 'OpenAI (simulada)', conta: 'Demonstração local' }, claude: { pronto: true, nome: 'Anthropic (simulada)', conta: { email: 'claude.demo@example.com', authMethod: 'OAuth', subscriptionType: 'simulação' }, versao: 'demo' } },
      openai: { ativa: 'Demonstração local', contas: [{ nome: 'Demonstração local', email: 'modo-local@example.com', plano: 'simulação', conectada: true, usadoPct: 18, sobraPct: 82, ativa: true }], loginPendente: null },
      saude: { ok: true, falhasSeguidas: 0, ultimaGeracao: Date.now() - 3 * MIN },
    },
  }
}

function counts(account) {
  const ms = tinderMatches(account)
  return {
    matches: ms.length,
    conversas: ms.length,
    comConversa: ms.filter((x) => x.has_conversation).length,
    pendentes: ms.filter((x) => x.pending).length,
    semMsg: 0,
    openerQueued: 0,
    contatos: ms.filter((x) => x.shared_contact).length,
    comIa: ms.filter((x) => getAiSetting(x.person_id, 'tinder')?.enabled || getAiSetting(x.person_id, 'whatsapp')?.enabled).length,
    revisoes: 0,
    vinculos: 0,
    agenda: pendingAgendaProposals(account).length,
    projetos: 3,
  }
}

function tinderDiscovery() {
  const base = estadoSwipe()
  const decisions = db().prepare(`SELECT * FROM swipe ORDER BY decided_at DESC LIMIT 60`).all()
  const sessions = db().prepare(`SELECT * FROM swipe_session ORDER BY started_at DESC LIMIT 10`).all()
  return {
    ...base,
    sessoes: sessions,
    decisoes: decisions,
    projecao: 54,
    semToken: false,
    onde: { city: 'São Paulo', isTraveling: false, offsetMi: 0 },
    conta: { gold: true, assinaturaAte: new Date(Date.now() + 90 * 86400000).toISOString(), likesRestantes: 72, superLikes: 4, boosts: 1, perfilCompleto: 92, endereco: 'São Paulo, SP' },
    cidades: [{ nome: 'São Paulo', lat: -23.5505, lon: -46.6333 }, { nome: 'Rio de Janeiro', lat: -22.9068, lon: -43.1729 }, { nome: 'Curitiba', lat: -25.4284, lon: -49.2733 }],
  }
}

const discoverPeople = () => [
  { id: 'demo-like-marina', nome: 'Marina', idade: 28, bio: 'Arquiteta, arte e viagens.', fotos: ['/api/demo/assets/perfis/camila.png'], verificada: true, ativaRecente: true, intencao: 'Relacionamento sério', distancia: 4, decisao: 'like', motivo: 'perfil completo e interesses compatíveis', jaDecidida: false },
  { id: 'demo-like-rafael', nome: 'Rafael', idade: 33, bio: 'Cozinha, cinema e trilhas.', fotos: ['/api/demo/assets/perfis/diego.png'], verificada: true, ativaRecente: true, intencao: 'Conhecer pessoas', distancia: 7, decisao: 'fronteira', motivo: 'bons sinais, mas pouca informação', jaDecidida: false },
  { id: 'demo-like-luiza', nome: 'Luiza', idade: 30, bio: 'Fotógrafa e produtora cultural.', fotos: ['/api/demo/assets/perfis/elis.png'], verificada: true, ativaRecente: true, intencao: 'Relacionamento sério', distancia: 6, decisao: 'like', motivo: 'bio detalhada e atividade recente', jaDecidida: false },
]

export async function handleDemoApi({ req, res, url, p, json, body, broadcast, account }) {
  if (p.startsWith('/api/demo/assets/')) return asset(res, p)
  if (p === '/api/demo') return json(res, 200, { ok: true, demo: true, redes: ['tinder', 'whatsapp', 'instagram', 'badoo', 'telegram', 'meupatrocinio'], dados: '100% sintéticos' }), true

  if (p === '/api/state' && req.method === 'GET') {
    return json(res, 200, {
      demo: true,
      tinder: { connected: true, status: 'CONNECTED', motivo: null, desde: Date.now() - 5 * HOUR, comoResolver: null, name: 'Conta Demonstração' },
      wa: { status: 'CONNECTED', jid: '5511999999999@s.whatsapp.net', name: 'WhatsApp Demonstração' },
      counts: counts(account),
    }), true
  }
  if (p === '/api/wa' && req.method === 'GET') {
    const linkedCount = db().prepare(`SELECT COUNT(*) n FROM identity WHERE account_key=? AND channel='whatsapp'`).get(account).n
    return json(res, 200, { status: 'CONNECTED', qrDataUrl: null, jid: '5511999999999@s.whatsapp.net', name: 'WhatsApp Demonstração', phone: '5511999999999', linkedCount, queueCount: 0, reviews: [], demo: true }), true
  }
  if (p === '/api/ig' && req.method === 'GET') return json(res, 200, { status: 'CONNECTED', motivo: null, desde: Date.now() - 5 * HOUR, comoResolver: null, me: 'Estúdio Demonstração' }), true
  if (p === '/api/badoo' && req.method === 'GET') return json(res, 200, { status: 'CONNECTED', motivo: null, conversas: badooChats(account).length, ultimoSync: Date.now() - 2 * MIN, conectado: true, demo: true }), true
  if (p === '/api/saude/canais' && req.method === 'GET') {
    const canais = ['tinder', 'whatsapp', 'instagram', 'badoo', 'telegram', 'meupatrocinio'].map((canal, i) => ({ canal, ok: true, desde: Date.now() - (5 + i) * HOUR, motivo: null, comoResolver: null }))
    return json(res, 200, { canais, caidos: 0 }), true
  }
  if (p === '/api/config' && req.method === 'GET') return json(res, 200, demoConfig()), true
  if (p === '/api/ia/uso' && req.method === 'GET') return json(res, 200, { total: { requests: 148, inputTokens: 182400, outputTokens: 31620, costUsd: 0 }, porCanal: { tinder: 32, whatsapp: 54, instagram: 28, badoo: 18, telegram: 9, meupatrocinio: 7 }, demo: true }), true
  if (p === '/api/ia/motor' && req.method === 'GET') return json(res, 200, { modelo: 'gpt-5.4', esforco: 'medium', modelos: [{ id: 'gpt-5.4', nome: 'GPT-5.4', nota: 'equilíbrio' }, { id: 'gpt-5.5', nome: 'GPT-5.5', nota: 'mais capacidade' }], esforcos: [{ id: 'low', nome: 'Baixo', nota: 'mais rápido' }, { id: 'medium', nome: 'Médio', nota: 'equilibrado' }, { id: 'high', nome: 'Alto', nota: 'mais análise' }] }), true
  if (p === '/api/ia/motor' && req.method === 'POST') {
    const b = await body(req)
    return json(res, 200, { ok: true, modelo: b.modelo || 'gpt-5.4', esforco: b.esforco || 'medium', demo: true }), true
  }
  if (p === '/api/ia/motor/testar' && req.method === 'POST') return json(res, 200, { resultados: [{ modelo: 'gpt-5.4', ok: true, ms: 420, resposta: 'funciona' }, { modelo: 'gpt-5.5', ok: true, ms: 510, resposta: 'funciona' }] }), true
  if (p === '/api/ia/provedor' && req.method === 'POST') return json(res, 200, { ok: true, ativo: (await body(req)).provedor || 'codex', demo: true }), true

  if (p === '/api/conversas/progresso' && req.method === 'GET') {
    const rawDays = url.searchParams.get('dias')
    const dias = rawDays === '0' ? 0 : Math.max(1, Math.min(Number(rawDays) || 30, 3650))
    const canal = ['tinder', 'whatsapp', 'instagram', 'badoo'].includes(url.searchParams.get('canal')) ? url.searchParams.get('canal') : null
    const desde = Number(url.searchParams.get('desde')) || null
    const ate = Number(url.searchParams.get('ate')) || null
    const recorte = desde != null
    const summary = resumoConversas({ accountKey: account, dias, canal, desde, ate })
    const autoria = summary.iaVsJoao || {}
    return json(res, 200, {
      ...summary,
      iaVsPessoaOperadora: { ia: autoria.ia || {}, humano: autoria.joao || {}, cobertura: autoria.cobertura || { carimbadas: 0, outgoing: 0 }, amostraMinima: autoria.amostraMinima || 20 },
      serie: recorte ? null : serieConversas({ accountKey: account, dias: 182, canal }),
      comparacao: recorte ? null : compararPeriodo({ accountKey: account, dias, canal }),
      regua: REGUA,
    }), true
  }

  if (p === '/api/agenda' && req.method === 'GET') {
    const proposals = pendingAgendaProposals(account).map((r) => ({ id: r.id, title: r.title, startsAt: r.starts_at, endsAt: r.ends_at, withPerson: r.with_person, personId: r.person_id, channel: r.channel, confidence: r.confidence, sourceQuote: r.source_quote, personName: r.with_person, projectId: r.project_id || null, projectName: null }))
    return json(res, 200, { configured: true, connected: true, email: 'agenda.demo@example.com', awareness: getSetting('agenda_awareness', true), events: listarCompromissos({ fromMs: Date.now() - 86400000, toMs: Date.now() + 40 * 86400000 }), proposals, expired: [], demo: true }), true
  }
  if (p === '/api/agenda/refresh' && req.method === 'POST') return json(res, 200, { ok: true, events: listarCompromissos({ fromMs: Date.now(), toMs: Date.now() + 40 * 86400000 }) }), true
  if (p === '/api/agenda/disconnect' && req.method === 'POST') return json(res, 200, { ok: true, simulated: true }), true

  if (p === '/api/swipe/estado' && req.method === 'GET') return json(res, 200, { ok: true, estado: tinderDiscovery() }), true
  if (p === '/api/swipe/curtiram' && req.method === 'GET') return json(res, 200, { ok: true, pessoas: discoverPeople() }), true
  if (p === '/api/swipe/fila' && req.method === 'GET') return json(res, 200, { ok: true, pessoas: discoverPeople(), onde: { city: 'São Paulo' }, offsetMi: 0 }), true
  if (p === '/api/swipe/rodar' && req.method === 'POST') return json(res, 202, { ok: true, iniciada: true, tamanho: Number((await body(req)).tamanho) || 15, sombra: true, simulated: true }), true
  if (p === '/api/swipe/manual' && req.method === 'POST') return json(res, 200, { ok: true, match: true, status: 200, simulated: true }), true
  if (p === '/api/swipe/passport' && req.method === 'POST') return json(res, 200, { ok: true, onde: { city: 'São Paulo', isTraveling: false }, simulated: true }), true
  if (p === '/api/tinder/perfil' && req.method === 'GET') return json(res, 200, { ok: true, perfil: { nome: 'Conta Demonstração', bio: 'Perfil fictício para demonstrar atendimento multicanal com organização e consentimento.', cargo: 'Criador de conteúdo', empresa: 'Estúdio Demonstração', escola: '', idadeMin: 24, idadeMax: 44, raio: 35, descobrivel: true, topPicks: true, fotos: ['/api/demo/assets/perfis/felipe.png'], completo: 92, falta: [{ chave: 'spotify_anthem', ganho: '+3%' }] } }), true
  if (p === '/api/tinder/perfil' && req.method === 'POST') return json(res, 200, { ok: true, simulated: true }), true

  if (p === '/api/badoo/encontros' && req.method === 'GET') return json(res, 200, { ...estadoEncontros(), votosHoje: 47, demo: true }), true
  if (p === '/api/badoo/encontros/config' && req.method === 'POST') return json(res, 200, { ...ligarEncontros(await body(req)), votosHoje: 47, demo: true }), true
  if (p === '/api/badoo/encontros/deslizar' && req.method === 'POST') return json(res, 200, { ok: true, processados: Number((await body(req)).quantos) || 10, curtidos: 6, passados: 4, sombra: true }), true
  if (p === '/api/badoo/curtidas' && req.method === 'GET') return json(res, 200, { estado: estadoDescobertaBadoo(), bloqueada: false, fila: discoverPeople().map((x, i) => ({ indice: i + 1, userId: x.id, nome: x.nome, idade: x.idade, foto: x.fotos[0], fotos: x.fotos, quantasFotos: 4, curtiuVoce: true, chave: x.id, texto: x.bio })) }), true
  if (p === '/api/badoo/curtidas/config' && req.method === 'POST') return json(res, 200, { ...ligarDescobertaBadoo(await body(req)), demo: true }), true
  if (p === '/api/badoo/curtidas/rodar' && req.method === 'POST') return json(res, 200, { ok: true, fila: 3, decisoes: [{ nome: 'Marina', decisao: 'like' }, { nome: 'Rafael', decisao: 'pass' }], sombra: true }), true
  if ((p === '/api/badoo/curtidas/perfil' || p === '/api/badoo/curtidas/acao') && req.method === 'POST') return json(res, 200, { ok: true, perfil: discoverPeople()[0], simulated: true }), true

  if (p === '/api/badoo/conversa' && req.method === 'GET') {
    const target = url.searchParams.get('chatId')
    return json(res, 200, channelConversation('badoo', target, account)), true
  }
  if (p === '/api/badoo/perfil' && req.method === 'POST') {
    const b = await body(req); const chat = getBadooChat(account, b.chatId)
    return json(res, 200, { perfil: chat?.perfil_json ? JSON.parse(chat.perfil_json) : { age: 30, city: 'São Paulo', bio: 'Perfil sintético da demonstração.' } }), true
  }
  if (p === '/api/ig/chat' && req.method === 'GET') {
    const target = url.searchParams.get('threadId'); const c = getIgChat(account, target); const personId = `ig:${target}`
    const messages = channelMessages(personId, 'instagram', 200).map((m) => ({ id: m.message_id, dir: m.direction === 'outgoing' ? 'out' : 'in', text: m.text, ts: m.ts, type: 'texto' }))
    return json(res, 200, { threadId: target, name: c?.name, username: c?.username, avatar: c?.avatar, personId, mode: c?.mode || null, objective: '', aiOn: !!getAiSetting(personId, 'instagram')?.enabled, messages, metricas: { mensagens: messages.length } }), true
  }

  const personAction = p.match(/^\/api\/person\/([^/]+)\/(generate|send)$/)
  if (personAction && req.method === 'POST') {
    const personId = decodeURIComponent(personAction[1]); const b = await body(req); const channel = b.channel || 'tinder'
    if (personAction[2] === 'generate') return json(res, 200, { draft: draftByChannel[channel] || draftByChannel.tinder, demo: true }), true
    if (channel === 'tinder') recordSend({ account, channel, target: personId, text: String(b.text || '') })
    else if (channel === 'whatsapp') {
      const jid = db().prepare(`SELECT channel_id FROM identity WHERE account_key=? AND person_id=? AND channel='whatsapp' LIMIT 1`).get(account, personId)?.channel_id
      if (jid) recordSend({ account, channel, target: jid, text: String(b.text || '') })
    }
    broadcast({ t: 'message', personId })
    return json(res, 200, { ok: true, comprovado: true, demo: true }), true
  }

  const generators = {
    '/api/wa/chat/generate': ['whatsapp', 'jid'], '/api/ig/chat/generate': ['instagram', 'threadId'], '/api/badoo/gerar': ['badoo', 'chatId'],
  }
  if (generators[p] && req.method === 'POST') {
    const [channel] = generators[p]; await body(req)
    return json(res, 200, { ok: true, draft: draftByChannel[channel], comPerfil: true, demo: true }), true
  }

  const sends = {
    '/api/wa/chat/send': ['whatsapp', 'jid', 'text'], '/api/ig/chat/send': ['instagram', 'threadId', 'text'],
    '/api/badoo/enviar': ['badoo', 'chatId', 'texto'], '/api/tg/enviar': ['telegram', 'chatId', 'texto'], '/api/mp/enviar': ['meupatrocinio', 'peerId', 'texto'],
  }
  if (sends[p] && req.method === 'POST') {
    const [channel, idKey, textKey] = sends[p]; const b = await body(req); const text = String(b[textKey] || '').trim()
    const sent = recordSend({ account, channel, target: String(b[idKey]), text, author: b.author || 'humano' })
    broadcast({ t: 'message', personId: sent.personId })
    const out = { ok: true, comprovado: true, providerMessageId: sent.messageId, ts: sent.ts, demo: true }
    if (channel === 'instagram') out.message = { id: sent.messageId, dir: 'out', text, ts: sent.ts }
    return json(res, 200, out), true
  }

  if ((p === '/api/wa/chat/send-audio' || p === '/api/badoo/enviar-audio') && req.method === 'POST') {
    const b = await body(req); const channel = p.startsWith('/api/wa/') ? 'whatsapp' : 'badoo'; const target = channel === 'whatsapp' ? b.jid : b.chatId
    const audio = listSavedAudios().find((x) => x.id === b.audioId)
    const sent = recordSend({ account, channel, target, text: `🎙️ Áudio: ${audio?.title || 'mensagem de voz demonstrativa'}` })
    broadcast({ t: 'message', personId: sent.personId })
    return json(res, 200, { ok: true, comprovado: true, providerMessageId: sent.messageId, demo: true }), true
  }

  if (/^\/api\/(wa\/(send-sticker|make-sticker|send-lottie|send-advanced)|badoo\/foto|servicos\/entregar)$/.test(p) && req.method === 'POST') {
    const b = await body(req); const channel = p.startsWith('/api/badoo') ? 'badoo' : (b.canal === 'instagram' ? 'instagram' : b.canal === 'telegram' ? 'telegram' : b.canal === 'meupatrocinio' ? 'meupatrocinio' : 'whatsapp')
    const target = b.jid || b.chatId || b.threadId || b.peerId
    if (target) recordSend({ account, channel, target, text: p === '/api/servicos/entregar' ? '📦 Entrega demonstrativa enviada com sucesso.' : '🖼️ Mídia demonstrativa enviada.' })
    broadcast({ t: 'state' })
    return json(res, 200, { ok: true, comprovado: true, demo: true, entregue: true }), true
  }

  if (/^\/api\/(wa\/(connect|reparear)|ig\/(sync|deep-scan|session)|badoo\/(sync|session)|tinder\/(sync|token)|canais\/importar-chrome)$/.test(p)) {
    if (p.startsWith('/api/wa/')) upsertWaSession({ accountKey: account, status: 'CONNECTED', jid: '5511999999999@s.whatsapp.net', name: 'WhatsApp Demonstração' })
    broadcast({ t: 'state' })
    return json(res, 200, { ok: true, connected: true, synced: 8, iniciado: true, simulated: true }), true
  }

  if (p === '/api/assistente/falar' && req.method === 'POST') {
    const b = await body(req); const input = String(b.texto || '').trim(); const ts = Date.now()
    const response = /agenda|horário|hoje/i.test(input)
      ? 'Hoje há 3 compromissos demonstrativos e 1 proposta aguardando aprovação. Posso abrir a Agenda para você conferir.'
      : /venda|preço|serviço/i.test(input)
        ? 'Há 4 serviços cadastrados, com valores de R$ 79 a R$ 450. Dois leads estão quentes e uma entrega está pronta para confirmação manual.'
        : 'Tudo certo na simulação: as seis redes estão conectadas, há conversas recentes e nenhuma ação sai deste computador.'
    db().prepare(`INSERT INTO assistente_msg(id,ts,papel,origem,texto) VALUES(?,?,?,?,?)`).run(`demo-assist-u-${ts}`, ts, 'humano', 'painel', input)
    db().prepare(`INSERT INTO assistente_msg(id,ts,papel,origem,texto) VALUES(?,?,?,?,?)`).run(`demo-assist-a-${ts}`, ts + 1, 'vendas-multicanal', 'painel', response)
    broadcast({ t: 'assistente' })
    return json(res, 200, { ok: true, resposta: response, demo: true }), true
  }

  return false
}
