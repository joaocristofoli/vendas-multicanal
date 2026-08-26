// Convites de migração entre redes.
//
// Quando quem opera passa o PRÓPRIO contato numa conversa de app (Badoo, Tinder etc.),
// não existe `contact_hint`: o contato enviado é nosso, não da outra pessoa. Este módulo
// guarda esse rastro de forma comum a todas as personas/instâncias e reconhece a chegada
// posterior. Horário sozinho nunca une; identidade forte e única conclui um merge reversível.
import {
  db, getSetting, setSetting, getWaSession, registrarConvite, convitesDoCanal, getReceipt, logEvent,
} from '../core/db.mjs'
import { prettyPhone } from '../wa/phone.mjs'

const JANELA_CONVITE_MS = 14 * 24 * 60 * 60 * 1000
const JANELA_PERGUNTA_MS = 48 * 60 * 60 * 1000
const REDES_COM_CONTATO_PROPRIO = ['whatsapp', 'instagram']

const normaliza = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

export function meuContatoNaRede(canal, accountKey = 'main') {
  try {
    if (canal === 'instagram') {
      const me = getSetting('ig_me', null)
      return me ? { canal, valor: '@' + String(me).replace(/^@/, ''), comoDizer: 'o @ do Instagram dela' } : null
    }
    if (canal === 'whatsapp') {
      const s = getWaSession(accountKey)
      const dig = String(s?.jid || '').split('@')[0].split(':')[0].replace(/\D/g, '')
      return dig ? { canal, valor: prettyPhone(dig), comoDizer: 'o número de WhatsApp dela' } : null
    }
  } catch { /* sessão ainda não existe: não inventa contato */ }
  return null
}

// O texto carrega um contato REAL da sessão ativa? Telefone casa pelos 8 últimos dígitos
// (formatação e o nono dígito variam); Instagram casa pelo handle completo.
function contatoNoTexto(texto, contatos) {
  const t = String(texto || '')
  if (!t) return null
  for (const meu of contatos) {
    if (!meu) continue
    if (meu.canal === 'instagram') {
      const alvo = meu.valor.replace(/^@/, '').toLowerCase()
      if (alvo && t.toLowerCase().includes(alvo)) return meu
    } else {
      const dig = meu.valor.replace(/\D/g, '')
      const noTexto = t.replace(/\D/g, '')
      if (dig.length >= 8 && noTexto.includes(dig.slice(-8))) return meu
    }
  }
  return null
}

export function meuContatoEnviado(texto, accountKey = 'main') {
  return contatoNoTexto(texto, REDES_COM_CONTATO_PROPRIO.map((canal) => meuContatoNaRede(canal, accountKey)))
}

// Chamar só DEPOIS de o provedor confirmar o envio. Retorna null quando a frase não passou
// contato próprio ou quando o contato é do mesmo canal em que a conversa já está.
export function registrarConviteDaSaida({
  accountKey = 'main', personId, sourceChannel, messageId = null, texto, ts = Date.now(), contatoDetectado = null,
} = {}) {
  const contato = contatoDetectado || meuContatoEnviado(texto, accountKey)
  if (!contato || contato.canal === sourceChannel) return null
  const mudou = registrarConvite({
    personId,
    canal: contato.canal,
    contato: contato.valor,
    sourceChannel,
    sourceMessageId: messageId,
    quote: texto,
    ts,
  })
  if (mudou) {
    logEvent({
      type: 'convite_rede', personId, channel: sourceChannel,
      detail: `passou ${contato.valor} — uma conversa nova no ${contato.canal} será correlacionada por nome, horário e conversa`,
    })
  }
  return { ...contato, registrado: mudou }
}

// Rede de segurança para TODO caminho de envio (manual, IA e canais futuros): o tick de
// identidade relê as saídas recentes e cristaliza convites que algum adaptador não marcou
// na hora. Idempotente por pessoa + rede de destino.
export function reconstruirConvitesDasSaidas(accountKey = 'main', opcoes = {}) {
  const temDesdeExplicito = Number.isFinite(Number(opcoes.desde))
  const base = temDesdeExplicito ? Number(opcoes.desde) : Date.now() - JANELA_CONVITE_MS
  const chaveCursor = `convites_saida_scan_ate:${accountKey}`
  const cursor = temDesdeExplicito ? base : Math.max(base, Number(getSetting(chaveCursor, base)) || base)
  const rows = db().prepare(`SELECT message_id,person_id,channel,text,ts FROM message
    WHERE account_key=? AND direction='outgoing' AND text IS NOT NULL AND text!='' AND ts>=?
    ORDER BY ts ASC`).all(accountKey, cursor)
  const contatos = REDES_COM_CONTATO_PROPRIO.map((canal) => meuContatoNaRede(canal, accountKey)).filter(Boolean)
  let encontrados = 0, atualizados = 0
  for (const m of rows) {
    const contato = contatoNoTexto(m.text, contatos)
    if (!contato || contato.canal === m.channel) continue
    encontrados++
    if (registrarConviteDaSaida({
      accountKey, personId: m.person_id, sourceChannel: m.channel,
      messageId: m.message_id, texto: m.text, ts: m.ts, contatoDetectado: contato,
    })?.registrado) atualizados++
  }
  if (!temDesdeExplicito) setSetting(chaveCursor, rows.length ? Math.max(...rows.map((m) => m.ts)) + 1 : cursor)
  return { mensagens: rows.length, encontrados, atualizados }
}

function canalPeloPersonId(personId) {
  const id = String(personId || '')
  if (id.startsWith('b:')) return 'badoo'
  if (id.startsWith('ig:')) return 'instagram'
  if (id.startsWith('tg:')) return 'telegram'
  if (id.startsWith('mp:')) return 'meupatrocinio'
  if (id.startsWith('wa:')) return 'whatsapp'
  return 'tinder'
}

export function nomeInsuficiente(nome) {
  const n = normaliza(nome)
  if (!n || n.length < 2) return true
  if (/^(contato|conversa|sem nome|desconhecido|unknown)$/.test(n)) return true
  return /^\+?\d[\d\s().-]{6,}$/.test(String(nome || '').trim())
}

// Só extrai quando a pessoa realmente se apresenta. Uma resposta vaga não vira nome.
export function nomeDeclaradoNaResposta(texto) {
  const original = String(texto || '').trim().replace(/\s+/g, ' ')
  if (!original || original.length > 100) return null
  const introducao = original.match(/\b(?:me chamo|meu nome (?:e|é)|aqui (?:e|é)|sou (?:o|a)?|(?:e|é) (?:o|a))\s+([a-zà-ÿ][a-zà-ÿ' -]{1,50})/i)
  let nome = introducao?.[1] || null
  if (nome) nome = nome.replace(/\s+(?:do|da|de|no|na|la|lá)\s+(?:badoo|tinder|insta(?:gram)?)\b.*$/i, '').trim()
  if (!nome && /^[a-zà-ÿ][a-zà-ÿ'-]*(?:\s+[a-zà-ÿ][a-zà-ÿ'-]*)?$/i.test(original)) nome = original
  if (!nome) return null
  const n = normaliza(nome)
  if (!n || /^(oi|ola|opa|eai|sou eu|eu|bom dia|boa tarde|boa noite|tudo bem|quem e|quem eh)$/.test(n)) return null
  return nome.split(' ').slice(0, 3).map((p) => p ? p[0].toLocaleUpperCase('pt-BR') + p.slice(1).toLocaleLowerCase('pt-BR') : p).join(' ')
}

// Avalia uma mensagem que acabou de chegar no WhatsApp. Não envia por conta própria: a mão
// (socket + comprovante) fica no index. Aqui só diz se há convite recente e se vale perguntar.
export function avaliarChegadaWhatsapp({ accountKey = 'main', jid, personId, nome, texto, ts = Date.now() } = {}) {
  if (!jid || !personId || !String(personId).startsWith('wa:')) return { relacionada: false }
  const primeira = db().prepare(`SELECT MIN(ts) t FROM message
    WHERE person_id=? AND channel='whatsapp' AND direction='incoming'`).get(personId)?.t || ts
  const convites = convitesDoCanal('whatsapp', { desde: primeira - JANELA_CONVITE_MS, limite: 100 })
    .filter((c) => c.ts <= primeira)
  if (!convites.length) return { relacionada: false }

  const recibo = getReceipt(accountKey, 'wa-identidade', jid)
  const perguntou = !!recibo && ['sending', 'sent', 'uncertain', 'no_servidor', 'entregue', 'sem_confirmacao'].includes(recibo.state)
  let nomeDeclarado = null
  if (nomeInsuficiente(nome) && perguntou && ts > recibo.ts && String(texto || '').trim()) {
    nomeDeclarado = nomeDeclaradoNaResposta(texto)
  }

  const primeiraMensagem = Math.abs(Number(primeira) - Number(ts)) < 1500
  const convitesRecentes = convites.filter((c) => primeira - c.ts <= JANELA_PERGUNTA_MS)
  const podePerguntar = primeiraMensagem && convitesRecentes.length > 0 && nomeInsuficiente(nome) && !perguntou
  const fontes = [...new Set(convitesRecentes.map((c) => c.source_channel || canalPeloPersonId(c.person_id)).filter(Boolean))]
  const fonte = fontes.length === 1 ? fontes[0] : null
  const onde = fonte === 'badoo' ? ' la no badoo' : fonte === 'tinder' ? ' la no tinder' : ''
  const pergunta = onde ? `oii quem fala? qual seu nome${onde}?` : 'oii quem fala? de onde vc me conhece?'

  return {
    relacionada: true,
    convites,
    perguntar: podePerguntar,
    pergunta,
    nomeDeclarado,
    fonte,
    reavaliar: primeiraMensagem || !!nomeDeclarado,
  }
}
