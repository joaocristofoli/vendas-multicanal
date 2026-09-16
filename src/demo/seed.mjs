import fs from 'node:fs'
import path from 'node:path'

import {
  addMessage,
  db,
  insertSavedAudio,
  insertSavedImage,
  linkIdentity,
  logEvent,
  logMonitor,
  setAiSetting,
  setPersonObjective,
  setSetting,
  setTinderPerfil,
  upsertBadooChat,
  upsertIgChat,
  upsertPerson,
  upsertTinderMatch,
  upsertWaChat,
  upsertWaSession,
} from '../core/db.mjs'
import { salvarPix } from '../self/pix.mjs'
import { salvarServicos } from '../self/servicos.mjs'
import {
  criarEtiqueta,
  definirFotosQuentes,
  marcarPessoa,
  salvarComportamento,
  salvarRegras,
} from '../self/etiquetas.mjs'
import { salvar as salvarNecessidade, definirPessoa, vincularFotoNecessidade } from '../necessidades/store.mjs'
import { salvarRotina } from '../self/rotina.mjs'
import { salvarJanela } from '../self/encontros.mjs'
import { criarCompromisso } from '../agenda/local.mjs'
import {
  addProjectPerson,
  createHabit,
  createNote,
  createProject,
  createReminder,
  createTask,
  dayStampSP,
  setTaskNext,
  toggleHabit,
  updateProject,
  updateTask,
} from '../projects/store.mjs'

const ACCOUNT = process.env.TIM_ACCOUNT_KEY || 'demo'
const DATA_DIR = process.env.TIM_DATA_DIR
const ROOT = path.resolve(DATA_DIR, '..')
const ASSETS_DIR = path.join(DATA_DIR, 'demo-assets')
const IMAGE_DIR = process.env.TIM_SAVED_IMAGE_DIR || path.join(DATA_DIR, 'wa-saved-image')
const AUDIO_DIR = process.env.TIM_SAVED_AUDIO_DIR || path.join(DATA_DIR, 'wa-saved-audio')
const VERSION = 7
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const avatar = (slug) => `/api/demo/assets/perfis/${slug}.png`
const canonical = (slug) => `demo:${slug}`
const alias = (channel, id) => `${channel}:${id}`

const PERSONAS = {
  ana: { nome: 'Ana Martins', idade: 29, cidade: 'São Paulo', bio: 'Fotografia, cafés tranquilos e viagens curtas. Gosto de conversa direta e planos bem combinados.' },
  bruno: { nome: 'Bruno Costa', idade: 34, cidade: 'Campinas', bio: 'Designer, ciclista de fim de semana e fã de boa música. Aqui para conhecer gente interessante.' },
  camila: { nome: 'Camila Rocha', idade: 27, cidade: 'Curitiba', bio: 'Produtora criativa. Amo arte, praia e projetos que saem do papel.' },
  diego: { nome: 'Diego Alves', idade: 38, cidade: 'Rio de Janeiro', bio: 'Empreendedor, cozinheiro amador e viajante. Prefiro clareza a conversa enrolada.' },
  elis: { nome: 'Elis Nascimento', idade: 31, cidade: 'Belo Horizonte', bio: 'Música, bem-estar e fotografia editorial. Sempre com um projeto novo.' },
  felipe: { nome: 'Felipe Tanaka', idade: 30, cidade: 'São Paulo', bio: 'Tecnologia, cinema e restaurantes pequenos. Gosto de pessoas curiosas.' },
  gabi: { nome: 'Gabi Souza', idade: 26, cidade: 'Florianópolis', bio: 'Social media, trilhas e mar. Conversa leve, agenda organizada.' },
  henrique: { nome: 'Henrique Lima', idade: 41, cidade: 'Porto Alegre', bio: 'Arquitetura, viagens e fotografia. Busco boas conexões e discrição.' },
}

const NETWORKS = {
  wa: {
    ana: '5511999910101@s.whatsapp.net', bruno: '5511999910102@s.whatsapp.net',
    elis: '5511999910105@s.whatsapp.net', gabi: '5511999910107@s.whatsapp.net', henrique: '5511999910108@s.whatsapp.net',
  },
  ig: { ana: 'demo-ig-ana', camila: 'demo-ig-camila', felipe: 'demo-ig-felipe', elis: 'demo-ig-elis' },
  badoo: { camila: 'demo-bd-camila', diego: 'demo-bd-diego', gabi: 'demo-bd-gabi', henrique: 'demo-bd-henrique' },
  tg: { diego: 'demo-tg-diego', gabi: 'demo-tg-gabi', bruno: 'demo-tg-bruno' },
  mp: { elis: 'demo-mp-elis', henrique: 'demo-mp-henrique', camila: 'demo-mp-camila' },
  tinder: { ana: 'demo-td-ana', bruno: 'demo-td-bruno', felipe: 'demo-td-felipe', gabi: 'demo-td-gabi', henrique: 'demo-td-henrique' },
}

function copyAsset(from, toDir, toName) {
  fs.mkdirSync(toDir, { recursive: true })
  const src = path.join(ASSETS_DIR, from)
  const dest = path.join(toDir, toName)
  fs.copyFileSync(src, dest)
  return { file: toName, size: fs.statSync(dest).size }
}

function insertAlias(aliasId, canonicalId, now) {
  const d = db()
  upsertPerson({ personId: aliasId, accountKey: ACCOUNT, name: null })
  d.prepare(`INSERT OR REPLACE INTO person_alias(alias_person_id,canonical_person_id,created_at) VALUES(?,?,?)`)
    .run(aliasId, canonicalId, now)
}

function seedPictures() {
  const defs = [
    { id: 'demo-editorial', source: 'catalogo/editorial-vermelho.png', file: 'demo-editorial-vermelho.png', title: 'Editorial vermelho', shortcut: 'editorial', descricao: 'Exemplo de ensaio editorial com luz vermelha e composição elegante.', contexto: 'Amostra pública do pacote editorial digital.', nivel: 'livre', width: 1024, height: 1536 },
    { id: 'demo-praia', source: 'catalogo/praia-dourada.png', file: 'demo-praia-dourada.png', title: 'Praia dourada', shortcut: 'praia', descricao: 'Exemplo de retrato externo no fim de tarde.', contexto: 'Amostra pública de produção em locação.', nivel: 'livre', width: 1024, height: 1536 },
    { id: 'demo-bem-estar', source: 'catalogo/bem-estar.png', file: 'demo-bem-estar.png', title: 'Bem-estar', shortcut: 'bem-estar', descricao: 'Exemplo de fotografia lifestyle em ambiente claro.', contexto: 'Amostra do serviço de consultoria de imagem.', nivel: 'quente', width: 1024, height: 1536 },
    { id: 'demo-retrato-pb', source: 'catalogo/retrato-pb.png', file: 'demo-retrato-pb.png', title: 'Retrato preto e branco', shortcut: 'retrato-pb', descricao: 'Retrato artístico em preto e branco para portfólio.', contexto: 'Arquivo de demonstração travado para mostrar controle de acesso.', nivel: 'travada', width: 1023, height: 1537 },
  ]
  for (const pic of defs) {
    const copied = copyAsset(pic.source, IMAGE_DIR, pic.file)
    insertSavedImage({ ...pic, ...copied, sizeBytes: copied.size, sha: `sha-demo-${pic.id}` })
  }
}

function seedAudios() {
  const defs = [
    { id: 'demo-audio-confirmacao', source: 'audios/confirmacao.ogg', file: 'demo-confirmacao.ogg', title: 'Confirmar horário', shortcut: 'confirmar', descricao: 'Confirmação cordial de horário.', durationSec: 6, transcript: 'Oi! Passando só para confirmar nossa conversa de amanhã. Está tudo certo por aqui.' },
    { id: 'demo-audio-detalhes', source: 'audios/detalhes.ogg', file: 'demo-detalhes.ogg', title: 'Enviar detalhes', shortcut: 'detalhes', descricao: 'Resposta rápida prometendo os detalhes.', durationSec: 5, transcript: 'Adorei a ideia. Vou organizar os detalhes e te mando tudo ainda hoje.' },
  ]
  for (const au of defs) {
    const copied = copyAsset(au.source, AUDIO_DIR, au.file)
    insertSavedAudio({ ...au, ...copied, sizeBytes: copied.size })
    db().prepare(`UPDATE saved_audio SET transcript=?,transcript_status='done' WHERE id=?`).run(au.transcript, au.id)
  }
}

function seedPeople(now) {
  for (const [slug, p] of Object.entries(PERSONAS)) {
    upsertPerson({ personId: canonical(slug), accountKey: ACCOUNT, name: p.nome, photo: avatar(slug) })
  }

  for (const [slug, matchId] of Object.entries(NETWORKS.tinder)) {
    const p = PERSONAS[slug]
    upsertTinderMatch({
      accountKey: ACCOUNT, matchId, personId: canonical(slug), otherId: `demo-user-${slug}`,
      name: p.nome, bio: p.bio, age: p.idade, city: p.cidade, photos: [avatar(slug)],
      hasConversation: true, pending: ['ana', 'gabi'].includes(slug),
      lastDir: ['ana', 'gabi'].includes(slug) ? 'ela' : 'eu',
      lastText: slug === 'ana' ? 'Gostei do pacote editorial. Como funciona a reserva?'
        : slug === 'gabi' ? 'Sábado depois das 16h fica ótimo pra mim.'
          : 'Perfeito, te mando os detalhes por aqui.',
      lastTs: now - ({ ana: 8, gabi: 24, bruno: 55, felipe: 130, henrique: 260 }[slug] || 10) * MIN,
      sharedContact: ['ana', 'bruno', 'gabi'].includes(slug), historyCheckedAt: now - DAY,
    })
    linkIdentity({ accountKey: ACCOUNT, channel: 'tinder', channelId: matchId, personId: canonical(slug), method: 'demo' })
    setTinderPerfil({ accountKey: ACCOUNT, matchId, perfil: { ...p, interests: ['fotografia', 'viagens', 'gastronomia'], verified: true } })
  }

  for (const [slug, jid] of Object.entries(NETWORKS.wa)) {
    const p = PERSONAS[slug]
    upsertWaChat({ accountKey: ACCOUNT, jid, name: p.nome, avatar: avatar(slug),
      lastText: slug === 'elis' ? 'Pode reservar o pacote de 12 imagens pra mim.' : 'Combinado! Te aviso qualquer mudança.',
      lastTs: now - ({ ana: 4, elis: 18, bruno: 46, gabi: 95, henrique: 190 }[slug] || 20) * MIN,
      fromTinder: ['ana', 'bruno', 'gabi'].includes(slug), adopted: true, unreadInc: ['ana', 'elis'].includes(slug) ? 1 : 0 })
    db().prepare(`UPDATE wa_chat SET mode=?,unread=? WHERE account_key=? AND jid=?`)
      .run(slug === 'bruno' ? 'negocio' : slug === 'henrique' ? 'amigo' : 'romance-paquera', ['ana', 'elis'].includes(slug) ? 1 : 0, ACCOUNT, jid)
    linkIdentity({ accountKey: ACCOUNT, channel: 'whatsapp', channelId: jid, personId: canonical(slug), method: 'demo' })
  }

  for (const [slug, threadId] of Object.entries(NETWORKS.ig)) {
    const p = PERSONAS[slug]; const pid = alias('ig', threadId)
    insertAlias(pid, canonical(slug), now)
    upsertIgChat({ accountKey: ACCOUNT, threadId, name: p.nome, username: `${slug}.demo`, avatar: avatar(slug),
      lastText: slug === 'camila' ? 'Vi o editorial vermelho e quero saber os valores.' : 'Adorei, depois te respondo com o melhor horário.',
      lastTs: now - ({ camila: 6, ana: 36, felipe: 88, elis: 220 }[slug] || 40) * MIN, unread: slug === 'camila' ? 2 : 0 })
    db().prepare(`UPDATE ig_chat SET adopted=1,mode=? WHERE account_key=? AND thread_id=?`)
      .run(slug === 'felipe' ? 'negocio' : 'romance-paquera', ACCOUNT, threadId)
    linkIdentity({ accountKey: ACCOUNT, channel: 'instagram', channelId: threadId, personId: pid, method: 'demo' })
  }

  for (const [slug, chatId] of Object.entries(NETWORKS.badoo)) {
    const p = PERSONAS[slug]; const pid = alias('b', chatId)
    insertAlias(pid, canonical(slug), now)
    upsertBadooChat({ accountKey: ACCOUNT, chatId, name: p.nome,
      previa: slug === 'diego' ? 'Curti a proposta de consultoria. Pode ser online?' : 'Qual pacote você recomenda para começar?',
      foto: avatar(slug), lastTs: now - ({ diego: 12, camila: 51, gabi: 105, henrique: 310 }[slug] || 50) * MIN, unread: slug === 'diego' })
    db().prepare(`UPDATE badoo_chat SET adopted=1,mode=?,perfil_json=? WHERE account_key=? AND chat_id=?`)
      .run(slug === 'diego' ? 'negocio' : 'romance-paquera', JSON.stringify({ age: p.idade, city: p.cidade, bio: p.bio, interests: ['arte', 'viagem'] }), ACCOUNT, chatId)
    linkIdentity({ accountKey: ACCOUNT, channel: 'badoo', channelId: chatId, personId: pid, method: 'demo' })
  }

  for (const [slug, chatId] of Object.entries(NETWORKS.tg)) {
    const p = PERSONAS[slug]; const pid = alias('tg', chatId)
    insertAlias(pid, canonical(slug), now)
    db().prepare(`INSERT INTO telegram_chat(account_key,chat_id,nome,username,telefone,previa,last_ts,unread,adopted,mode,updated_at)
      VALUES(?,?,?,?,?,?,?,?,1,?,?)`).run(ACCOUNT, chatId, p.nome, `${slug}_demo`, null,
      slug === 'gabi' ? 'Recebi o orçamento. Pode separar a data?' : 'Obrigado, ficou bem explicado.',
      now - ({ gabi: 22, diego: 74, bruno: 205 }[slug] || 70) * MIN, slug === 'gabi' ? 1 : 0, 'negocio', now)
    linkIdentity({ accountKey: ACCOUNT, channel: 'telegram', channelId: chatId, personId: pid, method: 'demo' })
  }

  for (const [slug, peerId] of Object.entries(NETWORKS.mp)) {
    const p = PERSONAS[slug]; const pid = alias('mp', peerId)
    insertAlias(pid, canonical(slug), now)
    db().prepare(`INSERT INTO mp_chat(account_key,peer_id,conversation_id,nome,foto,previa,last_ts,unread,adopted,mode,updated_at)
      VALUES(?,?,?,?,?,?,?,?,1,?,?)`).run(ACCOUNT, peerId, `conv-${peerId}`, p.nome, avatar(slug),
      slug === 'elis' ? 'Quero conhecer a produção premium e as opções.' : 'Pode me mandar as condições?',
      now - ({ elis: 14, henrique: 83, camila: 280 }[slug] || 80) * MIN, slug === 'elis' ? 1 : 0, 'negocio', now)
    linkIdentity({ accountKey: ACCOUNT, channel: 'meupatrocinio', channelId: peerId, personId: pid, method: 'demo' })
  }
}

const LINES = {
  tinder: [
    ['incoming', 'Oi! Vi que você trabalha com fotografia. É você que responde por aqui?', null],
    ['outgoing', 'Oi! Sou eu sim 😊 Posso te explicar os formatos e os valores sem compromisso.', 'humano'],
    ['incoming', 'Queria entender as opções e como funciona para reservar.', null],
    ['outgoing', 'Tenho opções online e presenciais. Se você me disser o que procura, eu te mostro a mais adequada.', 'ia'],
  ],
  whatsapp: [
    ['incoming', 'Oi, vim da outra rede. Queria continuar por aqui.', null],
    ['outgoing', 'Perfeito, fica mais fácil organizar tudo no WhatsApp.', 'humano'],
    ['incoming', 'Você consegue me mandar os valores e algumas fotos de exemplo?', null],
    ['outgoing', 'Consigo sim. Tenho um pacote digital com 4 imagens por R$ 79 e outro com 12 por R$ 189.', 'ia'],
    ['incoming', 'Gostei. Como fazemos para reservar?', null],
    ['outgoing', 'Escolhemos o pacote, confirmamos a data e eu registro tudo na agenda por aqui.', 'ia'],
  ],
  instagram: [
    ['incoming', 'Oi! Cheguei pelo seu portfólio. Esse estilo editorial está disponível?', null],
    ['outgoing', 'Está sim. Tenho uma produção pensada exatamente para esse tipo de resultado.', 'humano'],
    ['incoming', 'Pode me passar as opções?', null],
    ['outgoing', 'Claro. Posso te mostrar uma opção digital e outra presencial, com os valores certinhos.', 'ia'],
  ],
  badoo: [
    ['incoming', 'Olá! Gostei do seu perfil. Você atende online também?', null],
    ['outgoing', 'Atendo sim. A consultoria pode ser feita por chamada e o material é entregue depois.', 'ia'],
    ['incoming', 'Ótimo. Quero saber qual formato combina comigo.', null],
    ['outgoing', 'Para começar, a conversa de 30 minutos custa R$ 90. A de 60 minutos custa R$ 160.', 'humano'],
  ],
  telegram: [
    ['incoming', 'Recebi seu contato e queria organizar um orçamento.', null],
    ['outgoing', 'Pode falar por aqui. Eu separo serviço, prazo e valor para ficar claro.', 'humano'],
    ['incoming', 'Tem agenda no sábado?', null],
    ['outgoing', 'Tenho uma janela depois das 16h. Posso deixar como proposta para você confirmar.', 'ia'],
  ],
  meupatrocinio: [
    ['incoming', 'Olá. Queria conhecer melhor seus serviços e condições.', null],
    ['outgoing', 'Claro. Trabalho com opções presenciais e digitais, sempre com valor e entrega combinados antes.', 'humano'],
    ['incoming', 'Quero algo premium e com bastante organização.', null],
    ['outgoing', 'A produção premium dura 2 horas e custa R$ 450. Posso explicar cada etapa.', 'ia'],
  ],
}

function seedMessages(now) {
  let seq = 0
  const addThread = (personId, channel, offset, extra = null) => {
    const lines = [...LINES[channel], ...(extra || [])]
    lines.forEach(([direction, text, author], i) => {
      addMessage({ messageId: `demo-msg-${++seq}`, accountKey: ACCOUNT, personId, channel, direction, text,
        ts: now - offset * MIN - (lines.length - i) * 7 * MIN, author })
    })
  }
  for (const slug of Object.keys(NETWORKS.tinder)) addThread(canonical(slug), 'tinder', ({ ana: 1, gabi: 20, bruno: 50, felipe: 120, henrique: 250 }[slug]))
  for (const [slug] of Object.entries(NETWORKS.wa)) addThread(canonical(slug), 'whatsapp', ({ ana: 1, elis: 15, bruno: 42, gabi: 90, henrique: 180 }[slug]))
  for (const [slug, id] of Object.entries(NETWORKS.ig)) addThread(alias('ig', id), 'instagram', ({ camila: 2, ana: 32, felipe: 82, elis: 215 }[slug]))
  for (const [slug, id] of Object.entries(NETWORKS.badoo)) addThread(alias('b', id), 'badoo', ({ diego: 8, camila: 47, gabi: 100, henrique: 300 }[slug]))
  for (const [slug, id] of Object.entries(NETWORKS.tg)) addThread(alias('tg', id), 'telegram', ({ gabi: 18, diego: 70, bruno: 200 }[slug]))
  for (const [slug, id] of Object.entries(NETWORKS.mp)) addThread(alias('mp', id), 'meupatrocinio', ({ elis: 10, henrique: 78, camila: 270 }[slug]))
  addMessage({ messageId: 'demo-msg-tinder-pendente-ana', accountKey: ACCOUNT, personId: canonical('ana'), channel: 'tinder', direction: 'incoming', text: 'Gostei do pacote editorial. Como funciona a reserva?', ts: now - 3 * MIN })
  addMessage({ messageId: 'demo-msg-tinder-pendente-gabi', accountKey: ACCOUNT, personId: canonical('gabi'), channel: 'tinder', direction: 'incoming', text: 'Sábado depois das 16h fica ótimo pra mim.', ts: now - 22 * MIN })
}

function seedSettingsAndCatalog() {
  const settings = {
    demo_mode: true,
    demo_clock: Date.now(),
    send_enabled: false,
    agenda_awareness: true,
    saved_image_ai: true,
    saved_audio_ai: true,
    media_interpret: true,
    projects_awareness: true,
    fatos_awareness: true,
    necessidade_pedidos_enabled: true,
    personal_finance_sharing_enabled: false,
    propor_dates: true,
    marcar_atendimento: true,
    memoria_auto: true,
    iniciativa_enabled: true,
    assistente_enabled: true,
    assistente_proativo_dia: true,
    assistente_proativo_alertas: true,
    assistente_proativo_respostas: true,
    assistente_proativo_hora: '08:30',
    swipe_enabled: true,
    swipe_dry_run: true,
    badoo_swipe_enabled: true,
    badoo_swipe_dry_run: true,
    badoo_encontros_enabled: true,
    badoo_encontros_sombra: true,
    wa_full_history: true,
    transferir_ia_no_vinculo: true,
    reply_cadence: { minMinutes: 2, maxMinutes: 9 },
    tinder_me: { id: 'demo-owner', name: 'Conta Demonstração' },
    ig_me: { id: 'demo-ig-owner', name: 'Estúdio Demonstração', username: 'estudio.demo' },
  }
  for (const [k, v] of Object.entries(settings)) setSetting(k, v)
  upsertWaSession({ accountKey: ACCOUNT, status: 'CONNECTED', jid: '5511999999999@s.whatsapp.net', name: 'WhatsApp Demonstração', requiresRepair: false })
  salvarPix({ nome: 'ESTÚDIO DEMONSTRAÇÃO', chave: 'demo@example.com' })
}

function seedLabelsAndServices() {
  const labels = [
    ['Cliente', 'verde', 'Priorize clareza, confirmação e pós-venda. Não repita valores já aceitos.'],
    ['Lead quente', 'vermelho', 'Responda com objetividade e conduza para uma escolha concreta, sem pressionar.'],
    ['Orçamento enviado', 'azul', 'Retome pelo item e valor já apresentados; não invente desconto.'],
    ['VIP', 'roxo', 'Use um tom cuidadoso, discreto e personalizado.'],
    ['Retorno', 'ambar', 'Há algo para acompanhar; faça uma pergunta curta e útil.'],
    ['Encontro confirmado', 'rosa', 'Confirme data, hora e local sem reabrir negociação.'],
  ].map(([nome, cor, comportamento]) => {
    const e = criarEtiqueta({ nome, cor })
    salvarComportamento({ id: e.id, texto: comportamento })
    return e
  })
  const byName = Object.fromEntries(labels.map((x) => [x.nome, x]))
  salvarRegras({ id: byName['Lead quente'].id, regras: [{ tipo: 'contem', texto: 'quero reservar' }, { tipo: 'contem', texto: 'qual o valor' }] })
  salvarRegras({ id: byName['Encontro confirmado'].id, regras: [{ tipo: 'exata', texto: 'combinado' }, { tipo: 'contem', texto: 'data confirmada' }] })
  definirFotosQuentes(byName.VIP.id, true)
  definirFotosQuentes(byName['Lead quente'].id, true)

  const mark = (slug, names) => names.forEach((name) => marcarPessoa({ personId: canonical(slug), etiquetaId: byName[name].id }))
  mark('ana', ['Lead quente', 'Orçamento enviado'])
  mark('bruno', ['Cliente', 'Retorno'])
  mark('camila', ['Lead quente'])
  mark('diego', ['Orçamento enviado'])
  mark('elis', ['VIP', 'Cliente'])
  mark('felipe', ['Retorno'])
  mark('gabi', ['Encontro confirmado', 'Cliente'])
  mark('henrique', ['VIP', 'Orçamento enviado'])

  salvarServicos({ itens: [
    {
      nome: 'Ensaio express', tipo: 'presencial', obs: 'Ensaio objetivo com direção durante toda a sessão.',
      local: 'estúdio parceiro no centro', atendeEm: 'meu_espaco', folgaAntesMin: 20, folgaDepoisMin: 15,
      faixas: [{ tempo: '45 minutos', centavos: 25000, minutos: 45 }], fotos: ['demo-praia'],
      palavras: ['ensaio', 'fotos profissionais'], locais: [{ nome: 'Estúdio Centro', valorCentavos: 8000, quemPaga: 'somado', enderecoPublico: false, obs: 'Reserva sujeita à agenda.' }],
    },
    {
      nome: 'Consultoria de perfil', tipo: 'online', obs: 'Revisão de perfil, posicionamento e roteiro de publicação.',
      faixas: [{ tempo: '30 minutos', centavos: 9000, minutos: 30 }, { tempo: '60 minutos', centavos: 16000, minutos: 60 }],
      fotos: ['demo-bem-estar'], palavras: ['consultoria', 'perfil'], entrega: { link: 'https://example.com/demo/consultoria', instrucao: 'Link ilustrativo; na operação real substitua pelo material do cliente.', fotos: [] },
    },
    {
      nome: 'Pacote editorial digital', tipo: 'online', obs: 'Seleção digital pronta para uso em perfil e campanha.',
      faixas: [{ tempo: '4 imagens', centavos: 7900 }, { tempo: '12 imagens', centavos: 18900 }],
      fotos: ['demo-editorial'], etiquetas: [byName['Lead quente'].id, byName.VIP.id], palavras: ['pacote', 'editorial', 'fotos'],
      entrega: { link: 'https://example.com/demo/galeria', instrucao: 'Galeria fictícia da demonstração. Em produção, confirme o pagamento antes de entregar.', fotos: ['demo-editorial', 'demo-praia', 'demo-bem-estar'] },
    },
    {
      nome: 'Produção premium', tipo: 'ambos', obs: 'Planejamento, produção guiada e seleção final.', local: 'a combinar', atendeEm: 'combinar',
      faixas: [{ tempo: '2 horas', centavos: 45000, minutos: 120 }], fotos: ['demo-editorial', 'demo-praia'],
      etiquetas: [byName.VIP.id], palavras: ['premium', 'produção'], folgaAntesMin: 30, folgaDepoisMin: 30,
      entrega: { link: 'https://example.com/demo/premium', instrucao: 'Demonstração de entrega premium.', fotos: ['demo-editorial', 'demo-praia'] },
    },
  ] })
  return byName
}

function seedNeeds(labels) {
  const due = new Date(Date.now() + 12 * DAY).toISOString().slice(0, 10)
  const lens = salvarNecessidade({ descricao: 'Lente profissional para ampliar o portfólio', valorCentavos: 180000, prazoTipo: 'vence', prazoData: due, status: 'aberta', diasMinimos: 2, diasCriterio: 'conversados', linha: 'Estou juntando para uma lente nova que vai melhorar bastante as próximas produções.', horaDe: '10:00', horaAte: '21:30', preparoMinutos: 10, preparoDias: 2, preparoComo: 'Só mencionar quando a pessoa demonstrar interesse real no trabalho.', tipos: ['cliente', 'lead'], msgsMinimas: 5, cobrar: false })
  const studio = salvarNecessidade({ descricao: 'Reserva do estúdio para a próxima produção', valorCentavos: 65000, prazoTipo: 'vence', prazoData: due, status: 'aberta', diasMinimos: 0, diasCriterio: 'corridos', linha: 'A próxima produção exige reservar o estúdio com antecedência.', horaDe: '09:00', horaAte: '20:00', preparoMinutos: 0, preparoDias: 0, tipos: ['cliente'], msgsMinimas: 2, cobrar: true })
  const course = salvarNecessidade({ descricao: 'Curso de edição e tratamento', valorCentavos: 42000, prazo: 'sem pressa', status: 'resolvida', diasMinimos: 0, tipos: [], msgsMinimas: 0, cobrar: false })
  definirPessoa(lens, canonical('elis'), 'priorizar')
  definirPessoa(studio, canonical('gabi'), 'agendado')
  definirPessoa(course, canonical('bruno'), 'nao_mencionar')
  vincularFotoNecessidade('demo-editorial', lens)
  vincularFotoNecessidade('demo-praia', studio)
  return { lens, studio, course }
}

function seedPlanning(now) {
  salvarRotina({ id: 'demo-rotina-producao', titulo: 'Produção e atendimento', detalhes: 'Respostas, orçamentos e entregas.', local: 'home office', dias: [1, 2, 3, 4, 5], inicio: '09:00', fim: '12:30', ativo: true })
  salvarRotina({ id: 'demo-rotina-edicao', titulo: 'Edição de imagens', detalhes: 'Bloco sem interrupções.', local: 'estúdio', dias: [2, 4], inicio: '14:00', fim: '17:30', ativo: true })
  salvarRotina({ id: 'demo-rotina-conteudo', titulo: 'Conteúdo e portfólio', detalhes: 'Separar materiais para publicação.', local: 'home office', dias: [3, 5], inicio: '18:00', fim: '19:30', ativo: true })

  db().prepare(`INSERT OR REPLACE INTO lugar(id,nome,cidades,base,updated_at) VALUES(?,?,?,?,?)`)
    .run('demo-base', 'São Paulo e região', JSON.stringify(['São Paulo', 'Campinas', 'Santos']), 1, now)
  for (const row of [
    ['demo-jan-seg', 1, '18:30', '22:00', 'encontro'], ['demo-jan-qua', 3, '18:30', '22:00', 'encontro'],
    ['demo-jan-sab', 6, '15:00', '21:30', 'encontro'], ['demo-at-ter', 2, '09:00', '17:00', 'atendimento'],
    ['demo-at-qui', 4, '09:00', '17:00', 'atendimento'], ['demo-at-sab', 6, '10:00', '14:00', 'atendimento'],
  ]) salvarJanela({ id: row[0], dow: row[1], inicio: row[2], fim: row[3], tipo: row[4], lugarId: 'demo-base' })

  criarCompromisso({ titulo: 'Consultoria de perfil — Ana', inicioMs: now + 25 * HOUR, duracaoMinutos: 60, personId: canonical('ana'), canal: 'whatsapp', servico: 'Consultoria de perfil', faixa: '60 minutos', lugar: 'Google Meet (demo)', observacao: 'Pagamento confirmado — demonstração.', origem: 'demo' })
  criarCompromisso({ titulo: 'Ensaio express — Gabi', inicioMs: now + 3 * DAY + 16 * HOUR, duracaoMinutos: 45, personId: canonical('gabi'), canal: 'tinder', servico: 'Ensaio express', faixa: '45 minutos', folgaAntesMin: 20, folgaDepoisMin: 15, lugar: 'Estúdio Centro', observacao: 'Levar duas opções de composição.', origem: 'demo' })
  criarCompromisso({ titulo: 'Entrega pacote editorial — Elis', inicioMs: now + 5 * DAY + 11 * HOUR, duracaoMinutos: 30, personId: canonical('elis'), canal: 'meupatrocinio', servico: 'Pacote editorial digital', faixa: '12 imagens', lugar: 'Online', origem: 'demo' })

  db().prepare(`INSERT INTO agenda_proposal(id,account_key,person_id,channel,title,starts_at,ends_at,with_person,confidence,source_quote,fp,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('demo-proposta', ACCOUNT, canonical('camila'), 'instagram', 'Reunião rápida com Camila', now + 2 * DAY + 19 * HOUR, now + 2 * DAY + 20 * HOUR, 'Camila Rocha', 0.94, 'Quarta às 19h funciona pra mim.', 'demo-proposta-fp', 'pending', now)

  const p1 = createProject({ accountKey: ACCOUNT, name: 'Campanha editorial de setembro', type: 'trabalho', color: 'rose', description: 'Organizar captação, seleção e entrega da campanha demonstrativa.' })
  updateProject(p1.id, { dueDate: now + 21 * DAY, metricName: 'imagens entregues', metricTarget: 24, metricCurrent: 9, metricUnit: 'fotos' })
  const p1t1 = createTask({ accountKey: ACCOUNT, projectId: p1.id, title: 'Confirmar referências visuais', dueDate: now + DAY })
  createTask({ accountKey: ACCOUNT, projectId: p1.id, title: 'Fechar locação e iluminação', dueDate: now + 4 * DAY })
  const done = createTask({ accountKey: ACCOUNT, projectId: p1.id, title: 'Enviar proposta comercial', dueDate: now - DAY })
  updateTask(done.id, { done: true }); setTaskNext(p1.id, p1t1.id)
  createNote({ accountKey: ACCOUNT, projectId: p1.id, text: 'A paleta principal é vermelho, preto e dourado.' })
  createReminder({ accountKey: ACCOUNT, projectId: p1.id, text: 'Revisar seleção do editorial', at: now + 26 * HOUR, preMinutes: 15 })
  addProjectPerson(p1.id, canonical('elis'), 'cliente')
  addProjectPerson(p1.id, canonical('camila'), 'produção')

  const p2 = createProject({ accountKey: ACCOUNT, name: 'Catálogo digital automatizado', type: 'trabalho', color: 'teal', description: 'Preparar amostras, preços, gatilhos e entrega segura.' })
  updateProject(p2.id, { dueDate: now + 10 * DAY, metricName: 'serviços prontos', metricTarget: 4, metricCurrent: 4, metricUnit: 'serviços' })
  const p2t1 = createTask({ accountKey: ACCOUNT, projectId: p2.id, title: 'Testar entrega de fotos no WhatsApp', dueDate: now + 2 * DAY })
  createTask({ accountKey: ACCOUNT, projectId: p2.id, title: 'Revisar textos automáticos', dueDate: now + 3 * DAY })
  setTaskNext(p2.id, p2t1.id)
  createNote({ accountKey: ACCOUNT, projectId: p2.id, text: 'Todas as imagens da demo são sintéticas e de adultos fictícios.' })
  addProjectPerson(p2.id, canonical('bruno'), 'revisão')

  const h1 = createHabit({ accountKey: ACCOUNT, name: 'Responder prioridades', days: 'daily', timeHint: '09:00' })
  const h2 = createHabit({ accountKey: ACCOUNT, name: 'Atualizar portfólio', days: JSON.stringify([1, 3, 5]), timeHint: '18:00' })
  const h3 = createHabit({ accountKey: ACCOUNT, name: 'Revisar agenda do dia seguinte', days: 'daily', timeHint: '20:30' })
  toggleHabit(h1.id, dayStampSP(now)); toggleHabit(h3.id, dayStampSP(now))
  for (let n = 1; n <= 4; n++) { toggleHabit(h1.id, dayStampSP(now - n * DAY)); toggleHabit(h3.id, dayStampSP(now - n * DAY)) }
  toggleHabit(h2.id, dayStampSP(now - DAY))
}

function seedIntelligence(now) {
  const objectives = {
    ana: 'Fechar o pacote editorial de 12 imagens e confirmar a forma de entrega.',
    bruno: 'Retomar o orçamento sem pressionar e entender o prazo dele.',
    camila: 'Apresentar as opções editorial e premium com valores exatos.',
    diego: 'Converter a dúvida em uma consultoria online agendada.',
    elis: 'Confirmar pagamento e entregar o pacote selecionado manualmente.',
    felipe: 'Entender se ele procura consultoria ou produção presencial.',
    gabi: 'Manter o encontro confirmado e registrar qualquer mudança na agenda.',
    henrique: 'Atender com discrição e explicar a produção premium.',
  }
  for (const [slug, objective] of Object.entries(objectives)) setPersonObjective(canonical(slug), objective)
  for (const slug of Object.keys(NETWORKS.tinder)) setAiSetting({ personId: canonical(slug), channel: 'tinder', enabled: slug !== 'henrique', state: 'idle' })
  for (const slug of Object.keys(NETWORKS.wa)) setAiSetting({ personId: canonical(slug), channel: 'whatsapp', enabled: slug !== 'bruno', state: 'idle' })
  for (const id of Object.values(NETWORKS.ig)) setAiSetting({ personId: alias('ig', id), channel: 'instagram', enabled: true, state: 'idle' })
  for (const id of Object.values(NETWORKS.badoo)) setAiSetting({ personId: alias('b', id), channel: 'badoo', enabled: true, state: 'idle' })
  for (const id of Object.values(NETWORKS.tg)) setAiSetting({ personId: alias('tg', id), channel: 'telegram', enabled: true, state: 'idle' })
  for (const id of Object.values(NETWORKS.mp)) setAiSetting({ personId: alias('mp', id), channel: 'meupatrocinio', enabled: true, state: 'idle' })

  const d = db()
  d.prepare(`INSERT INTO fato(id,texto,categoria,sensibilidade,status,origem,confianca,gatilhos,recorded_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('demo-fato-1', 'O atendimento demonstra serviços digitais e presenciais com preços cadastrados.', 'trabalho', 'livre', 'aprovado', 'demo', 1, JSON.stringify(['serviço', 'valor', 'pacote']), now, now)
  d.prepare(`INSERT INTO fato(id,texto,categoria,sensibilidade,status,origem,confianca,gatilhos,recorded_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('demo-fato-2', 'A entrega de qualquer produto digital só ocorre após confirmação manual.', 'outro', 'sob_pedido', 'aprovado', 'demo', 1, JSON.stringify(['entrega', 'pagamento']), now, now)
  for (const slug of ['ana', 'elis', 'gabi']) {
    d.prepare(`INSERT INTO pessoa_memoria(person_id,resumo,combinados,tom,ate_ts,msgs_lidas,total_msgs,versao,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(canonical(slug), `Contato de demonstração: ${PERSONAS[slug].nome}, interessado em serviços e organização de agenda.`,
      slug === 'gabi' ? 'Ensaio confirmado para sábado.' : 'Enviar opções e aguardar escolha.', slug === 'elis' ? 'Cuidadoso e discreto.' : 'Direto e cordial.', now, 18, 18, 1, now)
  }
  d.prepare(`INSERT INTO iniciativa(id,person_id,channel,gatilho,motivo,rascunho,status,criado_em)
    VALUES(?,?,?,?,?,?,?,?)`).run('demo-iniciativa-1', canonical('bruno'), 'whatsapp', 'retorno_pendente', 'Orçamento enviado há dois dias sem confirmação.', 'Oi, Bruno! Passando só para saber se ficou alguma dúvida sobre as opções que te mandei.', 'pendente', now - 2 * HOUR)
  d.prepare(`INSERT INTO iniciativa(id,person_id,channel,gatilho,motivo,rascunho,status,criado_em)
    VALUES(?,?,?,?,?,?,?,?)`).run('demo-iniciativa-2', canonical('gabi'), 'tinder', 'encontro_proximo', 'Encontro confirmado se aproxima.', 'Oi, Gabi! Nosso horário de sábado segue certinho por aqui 😊', 'aprovada', now - DAY)

  const swipe = d.prepare(`INSERT INTO swipe(user_id,name,age,distance,decision,reason,layer,score,source,session_id,decided_at,sent_at,http_status,matched,payload)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  ;[
    ['demo-rec-1', 'Marina', 28, 4, 'like', 'perfil completo e interesses compatíveis', 'pontuacao', 84, 1],
    ['demo-rec-2', 'Rafael', 33, 9, 'pass', 'fora do raio preferido', 'filtro', 46, 0],
    ['demo-rec-3', 'Luiza', 30, 6, 'like', 'bio detalhada e atividade recente', 'pontuacao', 91, 0],
    ['demo-rec-4', 'Caio', 36, 12, 'pass', 'poucos sinais no perfil', 'pontuacao', 39, 0],
  ].forEach((x, i) => swipe.run(x[0], x[1], x[2], x[3], x[4], x[5], x[6], x[7], 'demo', 'demo-swipe-session', now - (i + 1) * 38 * MIN, now - (i + 1) * 37 * MIN, 200, x[8], JSON.stringify({ demo: true })))
  d.prepare(`INSERT INTO swipe_session(id,started_at,ended_at,planned,done,likes,city,mode,ended_reason)
    VALUES(?,?,?,?,?,?,?,?,?)`).run('demo-swipe-session', now - 4 * HOUR, now - 3.8 * HOUR, 20, 20, 11, 'São Paulo', 'sombra', 'sessão demonstrativa concluída')

  ;[
    ['perfil_visualizado', NETWORKS.wa.ana, 'Ana Martins', 'visualizou o catálogo editorial'],
    ['status_mudou', NETWORKS.wa.gabi, 'Gabi Souza', 'confirmou presença no sábado'],
    ['contato_adicionado', NETWORKS.wa.elis, 'Elis Nascimento', 'novo contato vinculado à conversa'],
    ['foto_atualizada', NETWORKS.wa.bruno, 'Bruno Costa', 'foto de perfil atualizada'],
  ].forEach(([kind, jid, name, summary], i) => {
    logMonitor({ accountKey: ACCOUNT, kind, jid, name, summary, detail: { demo: true, canal: 'whatsapp' } })
    d.prepare(`UPDATE wa_monitor SET ts=? WHERE id=(SELECT MAX(id) FROM wa_monitor)`).run(now - (i + 1) * 33 * MIN)
  })

  ;[
    ['boot', null, null, 'Demonstração local iniciada com dados sintéticos.'],
    ['canal_ok', null, 'tinder', 'Tinder simulado conectado.'],
    ['canal_ok', null, 'whatsapp', 'WhatsApp simulado conectado.'],
    ['canal_ok', null, 'instagram', 'Instagram simulado conectado.'],
    ['canal_ok', null, 'badoo', 'Badoo simulado conectado.'],
    ['manual_sent', canonical('ana'), 'whatsapp', 'Orçamento enviado e comprovado na simulação.'],
    ['agenda_detected', canonical('camila'), 'instagram', 'Proposta de quarta às 19h identificada.'],
    ['servico_entregue', canonical('elis'), 'meupatrocinio', 'Pacote editorial demonstrativo entregue.'],
  ].forEach(([type, personId, channel, detail], i) => {
    logEvent({ type, personId, channel, detail })
    d.prepare(`UPDATE event SET ts=? WHERE id=(SELECT MAX(id) FROM event)`).run(now - (i + 1) * 24 * MIN)
  })

  d.prepare(`INSERT INTO modelo_msg(id,canal,texto,ativo,criado_em) VALUES(?,?,?,?,?)`).run('demo-modelo-1', null, 'Oi! Vi seu perfil e achei que valia vir conversar. Como está seu dia?', 1, now)
  d.prepare(`INSERT INTO modelo_msg(id,canal,texto,ativo,criado_em) VALUES(?,?,?,?,?)`).run('demo-modelo-2', 'instagram', 'Oi! Obrigado por chegar pelo Instagram. O que você procura hoje?', 1, now - HOUR)
  d.prepare(`INSERT INTO assistente_msg(id,ts,papel,origem,texto) VALUES(?,?,?,?,?)`).run('demo-assist-1', now - 70 * MIN, 'humano', 'painel', 'Me dá um resumo do que precisa de atenção hoje.')
  d.prepare(`INSERT INTO assistente_msg(id,ts,papel,origem,texto) VALUES(?,?,?,?,?)`).run('demo-assist-2', now - 69 * MIN, 'vendas-multicanal', 'painel', 'Há duas conversas aguardando resposta, uma proposta de agenda para revisar e três compromissos próximos. As seis redes simuladas estão conectadas.')
  d.prepare(`INSERT INTO assistente_msg(id,ts,papel,origem,texto) VALUES(?,?,?,?,?)`).run('demo-assist-3', now - 32 * MIN, 'humano', 'painel', 'Quais serviços estão prontos para vender?')
  d.prepare(`INSERT INTO assistente_msg(id,ts,papel,origem,texto) VALUES(?,?,?,?,?)`).run('demo-assist-4', now - 31 * MIN, 'vendas-multicanal', 'painel', 'Os quatro estão prontos: ensaio express, consultoria de perfil, pacote editorial digital e produção premium. Valores, amostras e entregas já estão configurados.')
}

function refreshClock(now) {
  const d = db()
  const raw = d.prepare(`SELECT value FROM setting WHERE key='demo_clock'`).get()?.value
  let previous = null
  try { previous = JSON.parse(raw) } catch { previous = null }
  const delta = Number.isFinite(Number(previous)) ? now - Number(previous) : 0
  if (Math.abs(delta) < MIN) return
  const updates = [
    ['message', ['ts']], ['tinder_match', ['last_ts', 'history_checked_at', 'updated_at', 'perfil_checked_at']],
    ['wa_chat', ['last_ts', 'updated_at']], ['ig_chat', ['last_ts', 'updated_at']], ['badoo_chat', ['last_ts', 'updated_at']],
    ['telegram_chat', ['last_ts', 'updated_at']], ['mp_chat', ['last_ts', 'updated_at']], ['event', ['ts']], ['wa_monitor', ['ts']],
    ['compromisso', ['inicio_ms', 'fim_ms', 'criado_em', 'atualizado_em']], ['agenda_proposal', ['starts_at', 'ends_at', 'created_at']],
    ['project', ['due_date', 'created_at', 'updated_at']], ['task', ['due_date', 'created_at', 'completed_at']],
    ['reminder', ['at', 'created_at']], ['project_log', ['ts']], ['iniciativa', ['criado_em', 'decidido_em']],
    ['swipe', ['decided_at', 'sent_at']], ['swipe_session', ['started_at', 'ended_at']], ['pessoa_memoria', ['ate_ts', 'updated_at']],
  ]
  const tx = d.transaction(() => {
    for (const [table, columns] of updates) {
      for (const column of columns) d.prepare(`UPDATE ${table} SET ${column}=${column}+? WHERE ${column} IS NOT NULL`).run(delta)
    }
    setSetting('demo_clock', now)
  })
  tx()
}

export function prepararDemo() {
  if (!DATA_DIR || !path.resolve(DATA_DIR).startsWith(ROOT)) throw new Error('TIM_DATA_DIR da demonstração é inválido')
  const current = Number(db().prepare(`SELECT value FROM setting WHERE key='demo_seed_version'`).get()?.value || 0)
  if (current === VERSION) {
    refreshClock(Date.now())
    return { seeded: false, version: VERSION }
  }
  if (current) throw new Error(`A demo existente usa a versão ${current}; rode npm run demo:reset para recriá-la.`)

  const now = Date.now()
  const tx = db().transaction(() => {
    seedSettingsAndCatalog()
    seedPictures()
    seedAudios()
    seedPeople(now)
    const labels = seedLabelsAndServices()
    seedNeeds(labels)
    seedMessages(now)
    seedPlanning(now)
    seedIntelligence(now)
    setSetting('demo_seed_version', VERSION)
    setSetting('demo_clock', now)
  })
  tx()
  return { seeded: true, version: VERSION }
}
