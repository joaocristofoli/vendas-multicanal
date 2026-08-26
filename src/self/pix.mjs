// Dados para receber PIX. São informação pessoal da dona: vivem no banco, nunca no código
// nem no Diário. Entram no contexto privado das IAs com uma política explícita de uso.
import { db, getSetting, setSetting } from '../core/db.mjs'
import { idsBrutosDaPessoa, pessoaCanonica } from './identidade.mjs'

const CHAVE = 'pix_recebimento'
const agora = () => Date.now()

export function lerPix() {
  const salvo = getSetting(CHAVE, null)
  if (!salvo || typeof salvo !== 'object') return { nome: '', chave: '', atualizadoEm: null }
  return {
    nome: typeof salvo.nome === 'string' ? salvo.nome : '',
    chave: typeof salvo.chave === 'string' ? salvo.chave : '',
    atualizadoEm: Number.isFinite(Number(salvo.atualizadoEm)) ? Number(salvo.atualizadoEm) : null,
  }
}

export function salvarPix({ nome, chave } = {}) {
  const nomeLimpo = String(nome || '').trim().replace(/\s+/g, ' ')
  const chaveLimpa = String(chave || '').trim()

  if (!nomeLimpo) throw new Error('informe o nome que aparece no PIX')
  if (!chaveLimpa) throw new Error('informe a chave PIX')
  if (nomeLimpo.length > 120) throw new Error('o nome pode ter no máximo 120 caracteres')
  if (chaveLimpa.length > 150) throw new Error('a chave pode ter no máximo 150 caracteres')
  if (/[\r\n]/.test(chaveLimpa)) throw new Error('a chave PIX precisa ficar em uma linha')

  const pix = { nome: nomeLimpo, chave: chaveLimpa, atualizadoEm: Date.now() }
  setSetting(CHAVE, pix)
  return pix
}

const limparMotivo = (valor) => String(valor || '').trim().replace(/\s+/g, ' ')

function garantirCobrancaNunca() {
  const cols = db().prepare(`PRAGMA table_info(pessoa_pref)`).all().map((c) => c.name)
  if (!cols.includes('cobranca_nunca')) {
    db().exec(`ALTER TABLE pessoa_pref ADD COLUMN cobranca_nunca INTEGER NOT NULL DEFAULT 0`)
  }
}

// Regra por PESSOA para cobrança/PIX. Padrão desligado e, mesmo quando o bit antigo estiver
// ligado, só há autorização efetiva com um motivo escrito pelo usuário. A chave é a pessoa
// canônica, então o mesmo ajuste vale no Tinder, WhatsApp e Instagram daquela pessoa.
export function cobrancaDaPessoa(personIdBruto) {
  garantirCobrancaNunca()
  const personId = pessoaCanonica(personIdBruto)
  if (!personId) return { cobrancaAutorizada: false, motivo: '', nunca: false }
  const row = db().prepare(`SELECT cobranca_autorizada, cobranca_motivo, cobranca_nunca FROM pessoa_pref WHERE person_id=?`).get(personId)
  const nunca = !!row?.cobranca_nunca
  const motivo = limparMotivo(row?.cobranca_motivo)
  return { cobrancaAutorizada: !nunca && !!row?.cobranca_autorizada && !!motivo, motivo, nunca }
}

export function marcarNuncaCobrar(personIdBruto) {
  garantirCobrancaNunca()
  const personId = pessoaCanonica(personIdBruto)
  if (!personId) throw new Error('não consegui identificar esta pessoa')
  db().prepare(`INSERT INTO pessoa_pref(person_id,cobranca_autorizada,cobranca_motivo,cobranca_nunca,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(person_id) DO UPDATE SET cobranca_autorizada=0, cobranca_nunca=1, updated_at=excluded.updated_at`)
    .run(personId, 0, null, 1, agora())
  return cobrancaDaPessoa(personId)
}

export function cobrancaAutorizadaPessoa(personIdBruto) {
  return cobrancaDaPessoa(personIdBruto).cobrancaAutorizada
}

export function salvarCobrancaPessoa(personIdBruto, { enabled = false, motivo = '' } = {}) {
  const personId = pessoaCanonica(personIdBruto)
  if (!personId) throw new Error('não consegui identificar esta pessoa')
  if (cobrancaDaPessoa(personId).nunca) return cobrancaDaPessoa(personId)
  const motivoLimpo = limparMotivo(motivo)
  if (motivoLimpo.length > 500) throw new Error('o motivo pode ter no máximo 500 caracteres')
  if (enabled && !motivoLimpo) throw new Error('descreva por que esta pessoa deve pagar')
  db().prepare(`INSERT INTO pessoa_pref(person_id,cobranca_autorizada,cobranca_motivo,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(person_id) DO UPDATE SET cobranca_autorizada=excluded.cobranca_autorizada,
      cobranca_motivo=excluded.cobranca_motivo, updated_at=excluded.updated_at`)
    .run(personId, enabled ? 1 : 0, motivoLimpo || null, agora())
  return cobrancaDaPessoa(personId)
}

// Compatibilidade para chamadores antigos: ao apenas mudar o interruptor, preserva o
// motivo já salvo. Ligar sem motivo falha fechado em vez de dar licença para a IA inventar.
export function setCobrancaAutorizadaPessoa(personIdBruto, valor, motivo) {
  const atual = cobrancaDaPessoa(personIdBruto)
  salvarCobrancaPessoa(personIdBruto, {
    enabled: !!valor,
    motivo: motivo === undefined ? atual.motivo : motivo,
  })
  return true
}

// Contexto entregue às IAs. A regra de uso viaja junto com o dado: saber não significa
// oferecer. O filtro final em ai/filtro.mjs é a segunda barreira e impede vazamento da chave
// quando o turno atual não pediu PIX nem prometeu mandar o dinheiro.
export function pixBlock({ cobrancaAutorizada = false, cobrancaMotivo = '', etapa = null, incluirChave = false, pagamentoDeServico = false, deslizeAlmoco = false } = {}) {
  const pix = lerPix()
  if (!pix.nome || !pix.chave) return ''
  // PAGAMENTO DE SERVIÇO é outro dinheiro (ordem dele, 15/08/2026). Cliente que comprou um
  // trabalho e vai pagar não passa pela ordem de três tempos da necessidade — ali a chave é o
  // fim de um pedido de ajuda; aqui ela é a maquininha. O bloco inteiro troca de texto pra o
  // modelo não misturar os dois: nada de "conte a situação", nada de "peça ajuda".
  if (pagamentoDeServico) {
    return [
      'PIX DO USUÁRIO (dado privado salvo por ele):',
      `- nome do titular: ${pix.nome}`,
      `- chave PIX: ${pix.chave}`,
      '- ESTA PESSOA É CLIENTE DO SEU TRABALHO e a conversa chegou no pagamento: pode informar a chave e o nome do titular com naturalidade, como quem passa a forma de pagamento. Diga o valor que já foi combinado, sem inventar nem arredondar.',
      '- Isto NÃO é pedido de ajuda: nada de contar aperto, pedir favor, insistir ou agradecer demais. É o pagamento de um trabalho, e a conversa segue normal depois.',
    ].join('\n')
  }
  const motivo = limparMotivo(cobrancaMotivo)
  const autorizada = !!cobrancaAutorizada && !!motivo
  const et = etapa === 'pedir' || etapa === 'chave' || etapa === 'situacao'
    ? etapa
    : (autorizada ? 'situacao' : null)
  const podeChave = !!incluirChave || et === 'chave'
  const linhas = [
    'PIX DO USUÁRIO (dado privado salvo por ele):',
    podeChave
      ? `- nome do titular: ${pix.nome}`
      : '- o nome e a chave EXISTEM, mas NÃO entram nesta fala.',
    podeChave
      ? `- chave PIX: ${pix.chave}`
      : '- CONTA, depois PEDE AJUDA, depois a chave só se a pessoa disser que sim. Esta ordem é da linhagem.',
    autorizada && et === 'situacao'
      ? '- AGORA: conte a situação do motivo abaixo, concreta, com sentimento, como quem está no aperto agora. Sem pedir dinheiro. Sem PIX. Sem chave. Se o motivo tiver recompensa, só insinue — o pedido vem no tempo seguinte.'
      : '',
    autorizada && et === 'pedir'
      ? '- AGORA: feche o pedido. Valor claro. Use a recompensa do motivo se ela existir. Se ele hesitar (tô duro, depois, não recebi), um empurrão curto — não desista neste turno. Se ele puxar o clima da recompensa, acompanhe e amarre o pix como condição. Sem a chave.'
      : '',
    autorizada && et === 'chave'
      ? '- AGORA: ela topou. Informe o nome do titular e a chave, curta, como quem facilita. Sem repetir o drama. Nunca invente valor, motivo ou prazo.'
      : '',
    !autorizada
      ? '- AUTORIZAÇÃO DE COBRANÇA NESTA CONVERSA: não concedida. Não cobre, não peça dinheiro e não ofereça a chave por iniciativa própria.'
      : '',
    deslizeAlmoco
      ? '- DESLIZE DE HORÁRIO (já saiu): você falou de ALMOÇO fora da hora do almoço. Nesta fala, ANTES do resto, brinque: "falei almoço pq nem consegui almoçar, faltou grana". Só porque o deslize já aconteceu. Sem explicar regra de horário.'
      : '',
    autorizada && motivo
      ? `- MOTIVO EXATO DA COBRANÇA (não cole isto; conte com as palavras DESTA conversa): ${motivo}`
      : '',
    '- Mesmo sem autorização de cobrança, pode informar o nome e a chave quando a ÚLTIMA fala da pessoa pedir explicitamente os dados para fazer um PIX ou disser que vai mandar o dinheiro. Não cobre nada nesse caso: apenas facilite o envio informando os dados.',
  ]
  return linhas.filter(Boolean).join('\n')
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim()

// Uma cobrança autorizada sempre leva os dados do PIX. Esta é a marca determinística que
// distingue a cobrança real de um rascunho que recebeu a autorização no prompt mas decidiu
// conversar sobre outra coisa. A frase cobre também registros antigos feitos com uma chave
// anterior, que já não pode mais ser comparada literalmente com a configuração atual.
export function contemDadosPix(texto, chave = lerPix().chave) {
  const t = String(texto || '')
  const chaveLiteral = String(chave || '').trim()
  const chaveDigitos = chaveLiteral.replace(/\D+/g, '')
  const textoDigitos = t.replace(/\D+/g, '')
  const contemChave = !!chaveLiteral && (
    norm(t).includes(norm(chaveLiteral)) ||
    (chaveDigitos.length >= 8 && textoDigitos.includes(chaveDigitos))
  )
  return contemChave || /\b(chave pix|minha chave pix|meu pix)\b/.test(norm(t))
}

// Responder "qual é seu PIX?" ou facilitar depois de "vou mandar o dinheiro" não é
// cobrar. Cobrança é a iniciativa de mandar os dados sem que o turno atual tenha aberto
// essa permissão. O pedido único é marcado à parte, pois ali a ação explícita do usuário
// já prova a intenção mesmo quando o texto variar.
export function ehCobrancaProativa(texto, { chave = lerPix().chave, pedidoExplicito = false } = {}) {
  return !pedidoExplicito && contemDadosPix(texto, chave)
}

// A permissão é por TURNO, não pela conversa inteira: um pedido ou uma promessa antiga
// não pode abrir a chave para sempre. Só o bloco final e contínuo de mensagens recebidas
// conta. A promessa exige primeira pessoa e uma ação de pagamento/envio; falar de dinheiro
// ou do PIX em geral continua insuficiente.
export function podeInformarPixNoTurno(mensagens = []) {
  const turno = []
  for (let i = mensagens.length - 1; i >= 0; i--) {
    const m = mensagens[i]
    if (m?.direction !== 'incoming') break
    turno.unshift(m?.text || '')
  }
  const t = norm(turno.join(' '))
  if (!t) return false
  const pediuPix = /\bpix\b/.test(t) && [
    /\b(qual|manda|mandar|pode mandar|passa|passar|pode passar|envia|enviar|pode enviar|me da|me de|tem)\b.{0,45}\b(chave )?pix\b/,
    /\b(chave pix|seu pix|teu pix|pix)\b.{0,45}\b(qual|manda|passa|envia|pagar|transferir|fazer)\b/,
  ].some((re) => re.test(t))
  if (pediuPix) return true

  // "vou mandar dinheiro pra minha mãe" descreve outro pagamento, não uma oferta para
  // quem está nesta conversa. O caso sem destinatário ("vou mandar o dinheiro") permanece
  // válido porque foi exatamente a autorização dada pelo usuário.
  const dinheiroParaTerceiro = /\b(dinheiro|grana|valor|pix)\b.{0,15}\b(pra|para|pro)\s+(?!voce\b|vc\b|ti\b)/.test(t)
  if (dinheiroParaTerceiro) return false

  return [
    /\b(eu )?(vou|irei)\s+(te\s+)?(mandar|enviar|passar|transferir)\b.{0,35}\b(o dinheiro|dinheiro|a grana|grana|o valor|valor|um pix|pix)\b/,
    /\b(eu )?(vou|irei)\s+(fazer|realizar)\s+(um\s+)?pix\b/,
    /\b(eu )?(te|lhe)\s+(mando|envio|passo|transfiro|pago)\b(?:.{0,35}\b(o dinheiro|dinheiro|a grana|grana|o valor|valor|pix)\b|\s*(hoje|amanha|depois|agora)\b)/,
    /\b(eu )?(vou|irei)\s+(te|lhe)\s+pagar\b/,
  ].some((re) => re.test(t))
}

// Nome antigo mantido para consumidores externos. Agora ele representa todas as falas que
// abrem legitimamente os dados: pedido explícito de PIX ou promessa de mandar o dinheiro.
export const pedidoPixExplicito = podeInformarPixNoTurno

// A CONVERSA DE CLIENTE CHEGOU NO PAGAMENTO? (15/08/2026)
//
// Mais larga que `podeInformarPixNoTurno` de propósito, e só vale para quem JÁ é cliente
// (quem decide isso é `self/atendimento.mjs`, por etiqueta). Com um cliente, "como faço o
// pagamento?" e "aceita pix?" são a mesma pergunta que "me manda a chave" — exigir a fórmula
// exata era o que fazia a conversa travar bem na hora de fechar.
//
// Continua exigindo que a fala seja SOBRE pagar: elogio, foto e "quanto tempo" não abrem a
// chave. E quem não é cliente não chega aqui.
export function pagamentoDeServicoNoTurno(mensagens = []) {
  const turno = []
  for (let i = mensagens.length - 1; i >= 0; i--) {
    const m = mensagens[i]
    if (m?.direction !== 'incoming') break
    turno.unshift(m?.text || '')
  }
  const t = norm(turno.join(' '))
  if (!t) return false
  if (podeInformarPixNoTurno(mensagens)) return true
  return [
    /\baceita\b.{0,20}\b(pix|cartao|dinheiro|transferencia)\b/,
    /\b(como|onde|de que jeito)\b.{0,30}\b(pago|pagar|pagamento|faco o pagamento|te pago)\b/,
    /\b(qual|manda|passa|envia|me da|me de|tem)\b.{0,25}\b(a chave|sua chave|teu pix|seu pix|dados (pra|para) (o )?pagamento)\b/,
    /\b(pagar|pagamento|sinal|deposito)\b.{0,25}\b(adiantado|antes|agora|hoje|pix)\b/,
    /\b(vou|posso)\b.{0,20}\b(pagar|adiantar|deixar o sinal|mandar o sinal)\b/,
    /\b(fechado|combinado|pode ser|ta bom|confirmado)\b.{0,25}\b(vou pagar|pago|mando o pix|manda a chave)\b/,
  ].some((re) => re.test(t))
}

function idsDaPessoa(personIdBruto) {
  try { return idsBrutosDaPessoa(personIdBruto) } catch { return [pessoaCanonica(personIdBruto)].filter(Boolean) }
}

// Recupera cobranças anteriores à criação do ledger a partir do Diário, onde cada
// `auto_sent` já representa UMA rajada confirmada (e não uma bolha). Para separar uma
// cobrança de uma resposta com a chave, olha o turno recebido imediatamente anterior.
// O receipt `event:<id>` é o mesmo usado pelo caminho novo, portanto o backfill é idempotente
// e nunca duplica uma ocorrência que acabou de ser gravada ao vivo.
function backfillCobrancasConhecidas(personIdBruto) {
  const ids = idsDaPessoa(personIdBruto)
  if (!ids.length) return 0
  const marcas = ids.map(() => '?').join(',')
  const eventos = db().prepare(`SELECT id,ts,person_id,channel,detail FROM event
    WHERE type='auto_sent' AND person_id IN (${marcas}) ORDER BY ts`).all(...ids)
  const inserir = db().prepare(`INSERT OR IGNORE INTO cobranca_envio(person_id,channel,receipt_key,tipo,ts) VALUES(?,?,?,?,?)`)
  let novas = 0
  for (const ev of eventos) {
    const detalhe = String(ev.detail || '')
    // Um evento sozinho não é comprovante: versões antigas podiam registrar "auto_sent"
    // mesmo quando um adaptador não materializava texto. Exige a rajada outgoing, já
    // persistida antes do evento, e exige que os dados de PIX estejam no que saiu de fato.
    const anteriores = db().prepare(`SELECT direction,text,ts FROM message
      WHERE person_id IN (${marcas}) AND channel=? AND ts<=?
      ORDER BY ts DESC,rowid DESC LIMIT 40`).all(...ids, ev.channel, ev.ts)
    let i = 0
    while (i < anteriores.length && anteriores[i].direction === 'outgoing') i++
    const rajadaEnviada = anteriores.slice(0, i).reverse().map((m) => m.text || '').join('\n')
    if (!i || !contemDadosPix(rajadaEnviada)) continue

    let tipo = null
    if (/^\[pedido unico\]/.test(norm(detalhe))) tipo = 'pedido_unico'
    else if (contemDadosPix(detalhe)) {
      // As últimas mensagens antes do evento começam pelas bolhas que acabaram de sair.
      // Remove essa rajada e entrega ao detector somente o turno recebido anterior.
      const turno = []
      while (i < anteriores.length && anteriores[i].direction === 'incoming') {
        turno.unshift(anteriores[i])
        i++
      }
      if (ehCobrancaProativa(detalhe, { pedidoExplicito: podeInformarPixNoTurno(turno) })) tipo = 'regra'
    }
    if (!tipo) continue
    const r = inserir.run(pessoaCanonica(ev.person_id), ev.channel || 'desconhecido', `event:${ev.id}`, tipo, ev.ts)
    novas += r.changes
  }
  return novas
}

// Chamado somente DEPOIS do comprovante de envio. `receiptKey` identifica a rajada inteira:
// três bolhas continuam sendo uma cobrança, e uma reexecução do mesmo envio continua uma.
export function registrarCobrancaEnviada({ personId, channel, receiptKey, tipo = 'regra', ts = Date.now() } = {}) {
  const canonica = pessoaCanonica(personId)
  if (!canonica || !channel || !receiptKey) return false
  const r = db().prepare(`INSERT OR IGNORE INTO cobranca_envio(person_id,channel,receipt_key,tipo,ts) VALUES(?,?,?,?,?)`)
    .run(canonica, String(channel), String(receiptKey), tipo === 'pedido_unico' ? 'pedido_unico' : 'regra', Number(ts) || Date.now())
  return r.changes > 0
}

function textoDaMidia(mediaJson) {
  if (!mediaJson) return ''
  try {
    const media = JSON.parse(mediaJson)
    const tipo = String(media?.kind || '').toLowerCase()
    if (tipo === 'audio') return 'Enviou um áudio.'
    if (['image', 'imagem', 'foto'].includes(tipo)) return 'Enviou uma foto.'
    if (['video', 'reel'].includes(tipo)) return 'Enviou um vídeo.'
    if (tipo === 'sticker') return 'Enviou uma figurinha.'
    return tipo ? 'Enviou uma mídia.' : ''
  } catch { return '' }
}

// O feedback é a primeira rajada RECEBIDA depois da cobrança, no mesmo canal. Se alguma
// outra mensagem saiu antes da resposta, o texto continua visível, mas marcado como
// indireto: nesse caso não existe base honesta para afirmar que a pessoa respondeu à
// cobrança, e não à fala posterior.
function feedbackDaCobranca(ids, { canal, ts, ateTs = null }) {
  if (!ids.length) return { estado: 'sem_resposta', ts: null, texto: '', mensagens: 0 }
  const marcas = ids.map(() => '?').join(',')
  const limite = ateTs ? ' AND ts<?' : ''
  const params = ateTs ? [...ids, canal, ts, ateTs] : [...ids, canal, ts]
  const posteriores = db().prepare(`SELECT direction,text,media_json,ts FROM message
    WHERE person_id IN (${marcas}) AND channel=? AND ts>?${limite}
    ORDER BY ts,rowid`).all(...params)
  const primeiraRecebida = posteriores.findIndex((m) => m.direction === 'incoming')
  if (primeiraRecebida < 0) return { estado: 'sem_resposta', ts: null, texto: '', mensagens: 0 }
  const turno = []
  for (let i = primeiraRecebida; i < posteriores.length && posteriores[i].direction === 'incoming'; i++) turno.push(posteriores[i])
  const textos = turno.map((m) => String(m.text || '').trim() || textoDaMidia(m.media_json)).filter(Boolean)
  return {
    estado: primeiraRecebida === 0 ? 'recebido' : 'indireto',
    ts: turno[0]?.ts || null,
    texto: textos.join('\n'),
    mensagens: turno.length,
    aposMs: turno[0]?.ts ? Math.max(0, turno[0].ts - ts) : null,
  }
}

export function historicoCobrancas(personIdBruto) {
  backfillCobrancasConhecidas(personIdBruto)
  const ids = idsDaPessoa(personIdBruto)
  if (!ids.length) return { total: 0, itens: [] }
  const marcas = ids.map(() => '?').join(',')
  const rows = db().prepare(`SELECT channel, tipo, ts FROM cobranca_envio
    WHERE person_id IN (${marcas}) ORDER BY ts DESC,id DESC`).all(...ids)
  const itens = rows.map((r) => {
    const proximaNoCanal = rows.filter((outra) => outra.channel === r.channel && outra.ts > r.ts)
      .reduce((menor, outra) => menor == null || outra.ts < menor ? outra.ts : menor, null)
    return {
      canal: r.channel,
      tipo: r.tipo,
      ts: r.ts,
      feedback: feedbackDaCobranca(ids, { canal: r.channel, ts: r.ts, ateTs: proximaNoCanal }),
    }
  })
  return { total: itens.length, itens }
}
