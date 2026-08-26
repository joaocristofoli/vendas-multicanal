// Detector de contato compartilhado (F3 do docs/PLANO-IDENTIDADE-VINCULO.md).
//
// Hoje o vendas-multicanal vê que a pessoa passou um contato e joga o VALOR fora: o sync do Tinder só
// acende um booleano (`shared_contact`) e o `@` do Instagram some. Sem o valor não dá pra
// vincular nada — foi por isso que 13 matches passaram contato e nunca viraram conversa.
//
// Aqui a gente colhe o valor com a frase de origem e guarda em `contact_hint`. Esta fase
// NÃO vincula nada: só colhe. Quem decide é o resolvedor (F4), e ele só age sobre hints.
import { addContactHint, getWaSession, db } from '../core/db.mjs'
import { extractPhones, numerosIncertos } from '../wa/phone.mjs'

// @ do Instagram escrito explicitamente, ou o link do perfil. Estes são de confiança alta:
// ninguém escreve "@fulana" por acaso.
const IG_ARROBA = /(^|[\s(:,])@([a-z0-9](?:[a-z0-9._]{1,28})[a-z0-9])(?=$|[\s).,!?;])/gi
const IG_URL = /instagram\.com\/(?!p\/|reel\/|stories\/|explore\/|direct\/)([a-z0-9._]{2,30})/gi
// "Instagram: fulana", "meu insta é fulana.silva" — sem @. Confiança menor, e por isso a
// regra é ESTREITA: exige um separador explícito (`:` `=` `é` `eh`). A versão frouxa (que
// aceitava só o espaço) colhia prosa no corpus real — "me chama no insta então" virava o
// perfil "ent", "insta mais fácil" virava "mais". Ver docs/PLANO-IDENTIDADE-VINCULO.md §3/F3.
const IG_PALAVRA = /\b(?:insta|instagram|ig)\b\s*(?:é|eh|:|=)\s*@?([a-z0-9][a-z0-9._]{2,29})\b/gi
// Palavras que aparecem depois de "insta é" e claramente não são um perfil.
const IG_NAO_PERFIL = new Set(['privado', 'privada', 'fechado', 'fechada', 'igual', 'mesmo', 'esse', 'essa',
  'aqui', 'ali', 'meu', 'seu', 'sua', 'minha', 'nao', 'não', 'sim', 'la', 'lá', 'so', 'só', 'tambem', 'também',
  'antigo', 'novo', 'nova', 'principal', 'desativado', 'desativada', 'trancado', 'trancada', 'com', 'sem',
  'http', 'https', 'www', 'melhor', 'facil', 'fácil', 'ruim', 'bom', 'boa', 'legal', 'chato', 'isso', 'aquilo'])

// A mensagem está falando de Instagram?
const MENCIONA_IG = /\b(insta|instagram|ig)\b/i
// Token com cara de @: letras misturadas com ponto, underline ou dígito. "joicy.teste44"
// passa; "conversar", "aqui", "entro" não. Precisa de letra no começo (senão pega número).
// O ponto/underline/dígito tem que ser INTERNO — seguido de mais alguma coisa. Sem isso o
// ponto final da frase fazia toda palavra virar handle ("arrogante." -> "arrogante"): 244
// falsos positivos no corpus real contra 2 antes. Agora: "joicy.teste44" passa,
// "arrogante." não.
const TOKEN_COM_CARA_DE_HANDLE = /(?:^|[\s(:,@])([a-z][a-z0-9._]*[._\d][a-z0-9]+[a-z0-9._]*)(?=$|[\s).,!?;])/gi

// Um token sem @ só é aceito como perfil se PARECER perfil: tem ponto, underline ou dígito
// (a marca de um @ de verdade), ou é comprido o bastante pra não ser palavra solta de frase.
function pareceHandle(h) {
  if (/[._\d]/.test(h)) return true
  return h.length >= 5
}

// Um @ que faz parte de e-mail (pessoa@example.com) ou de um id cru do WhatsApp
// (88899900011122@lid) não é perfil do Instagram.
function ehArrobaDeVerdade(texto, indice, handle) {
  const antes = texto[indice - 1] || ' '
  if (/[\w.]/.test(antes)) return false                      // e-mail: tem palavra colada antes do @
  if (/^\d+$/.test(handle)) return false                     // só dígitos: é id, não perfil
  if (/\.(com|net|org|br|io|me)$/i.test(handle)) return false // domínio de e-mail
  return true
}

function normalizaHandle(h) {
  return String(h || '').trim().toLowerCase().replace(/^@+/, '').replace(/[.]+$/, '')
}

// Colhe os contatos de UM texto. `ignorar` = números que nunca viram hint (o do próprio o dono).
// Devolve [{ kind, raw, normalized, confidence }] sem repetidos.
export function extractHints(text, { ignorar = [] } = {}) {
  const bruto = String(text == null ? '' : text)
  if (!bruto.trim()) return []
  const achados = []
  const vistos = new Set()
  const push = (kind, raw, normalized, confidence) => {
    const chave = kind + ':' + normalized
    if (!normalized || vistos.has(chave)) return
    vistos.add(chave)
    achados.push({ kind, raw, normalized, confidence })
  }

  for (const p of extractPhones(bruto, { ignorar })) {
    push(p.origem === 'link' ? 'wa_link' : 'phone', p.bruto, p.e164, p.origem === 'link' ? 1 : 0.95)
  }
  // O que PARECE telefone e o parse recusou entra como incerto em vez de sumir. Confiança
  // baixa de propósito: incerto nunca vira vínculo sozinho, vai pra fila de revisão.
  for (const n of numerosIncertos(bruto, { ignorar })) {
    push(n.assinante ? 'phone_sem_ddd' : 'phone_ilegivel', n.bruto, n.digitos, 0.3)
  }
  for (const m of bruto.matchAll(IG_URL)) push('instagram', m[0], normalizaHandle(m[1]), 1)
  for (const m of bruto.matchAll(IG_ARROBA)) {
    const inicioArroba = m.index + (m[1] ? m[1].length : 0)
    if (!ehArrobaDeVerdade(bruto, inicioArroba, m[2])) continue
    push('instagram', '@' + m[2], normalizaHandle(m[2]), 0.95)
  }
  for (const m of bruto.matchAll(IG_PALAVRA)) {
    const h = normalizaHandle(m[1])
    if (IG_NAO_PERFIL.has(h) || /^\d+$/.test(h) || !pareceHandle(h)) continue
    push('instagram', m[0].trim(), h, 0.6)
  }
  // A mensagem FALA de Instagram e tem um token com cara de @ (ponto, underline ou dígito no
  // meio de letras) em qualquer lugar? É perfil. Caso real: "Quer me chama no insta eu não
  // entro mt aqui joicy.teste44" — o handle vem solto, longe da palavra, sem separador
  // nenhum. Sem esta regra o @ dela era jogado fora (achado no teste com a fixture sintética, 25/07/2026).
  // O formato do token é a trava: palavra comum de frase não tem ponto/underline/dígito.
  if (MENCIONA_IG.test(bruto)) {
    for (const m of bruto.matchAll(TOKEN_COM_CARA_DE_HANDLE)) {
      const h = normalizaHandle(m[1])
      if (IG_NAO_PERFIL.has(h) || h.length < 5) continue
      if (/^\d+$/.test(h)) continue                       // só dígitos é número, não perfil
      if (/^(insta|instagram|ig)\b/i.test(h)) continue     // é a própria palavra, não um perfil
      // domínio ou nome de tecnologia ("next.js", "v0.dev", "loja.com.br") não é perfil
      if (/\.(com|net|org|br|io|me|gov|js|dev|app|ai|co|tv)\b/i.test(h)) continue
      push('instagram', m[1], h, 0.75)
    }
  }
  return achados
}

// Número do próprio o dono (pra ele nunca virar "contato" de terceiro quando alguém repassa).
export function meusNumeros(accountKey) {
  const jid = getWaSession(accountKey)?.jid
  return jid ? [String(jid).split(':')[0].split('@')[0]] : []
}

// Colhe e GRAVA os hints de uma mensagem. Só mensagem RECEBIDA: o que o dono escreve é o
// contato dele, não o da pessoa. Devolve os hints gravados (novos).
// Canais onde passar o PRÓPRIO número é o caso de uso. Só neles um número ilegível vira
// incerto: no WhatsApp, número solto numa conversa é quase sempre de terceiro (pedido,
// código, fornecedor) e encher a fila de revisão com isso esconde o que importa — foi a
// correção do dono em 24/07/2026, e ela vale igual pro incerto.
const CANAIS_DE_APP = new Set(['tinder', 'badoo', 'instagram'])

export function colherDaMensagem({ accountKey, personId, channel, messageId, text, direction }) {
  if (direction && direction !== 'incoming') return []
  const hints = extractHints(text, { ignorar: meusNumeros(accountKey) })
  const gravados = []
  for (const h of hints) {
    if ((h.kind === 'phone_sem_ddd' || h.kind === 'phone_ilegivel') && !CANAIS_DE_APP.has(channel)) continue
    const id = addContactHint({ accountKey, personId, sourceChannel: channel, sourceMessageId: messageId,
      kind: h.kind, raw: h.raw, normalized: h.normalized, quote: text, confidence: h.confidence })
    if (id) gravados.push({ id, ...h })
  }
  return gravados
}

// Varre o histórico inteiro e colhe tudo que já foi dito (idempotente: o índice único do
// contact_hint impede duplicata, então dá pra rodar quantas vezes quiser).
export function colherHistorico(accountKey, { limite = 100000 } = {}) {
  const msgs = db().prepare(`SELECT message_id, person_id, channel, text FROM message
    WHERE direction='incoming' AND text IS NOT NULL AND text!='' ORDER BY ts DESC LIMIT ?`).all(limite)
  const ignorar = meusNumeros(accountKey)
  let novos = 0
  const porTipo = { phone: 0, instagram: 0, wa_link: 0 }
  for (const m of msgs) {
    for (const h of extractHints(m.text, { ignorar })) {
      // mesma trava do colherDaMensagem: incerto só nos canais onde ela passa o PRÓPRIO
      // número. Sem isto, a varredura do histórico despejaria todo número mal escrito de
      // conversa de WhatsApp na fila de revisão.
      if ((h.kind === 'phone_sem_ddd' || h.kind === 'phone_ilegivel') && !CANAIS_DE_APP.has(m.channel)) continue
      const id = addContactHint({ accountKey, personId: m.person_id, sourceChannel: m.channel,
        sourceMessageId: m.message_id, kind: h.kind, raw: h.raw, normalized: h.normalized,
        quote: m.text, confidence: h.confidence })
      if (id) { novos++; porTipo[h.kind] = (porTipo[h.kind] || 0) + 1 }
    }
  }
  return { mensagens: msgs.length, novos, porTipo }
}
