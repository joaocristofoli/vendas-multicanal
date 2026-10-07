// Ponte Tinder <-> WhatsApp e memória unificada. Monta o histórico da timeline
// para a IA, faz o vínculo determinístico (telefone compartilhado -> onWhatsApp) e
// a allowlist estrita do WhatsApp.
import crypto from 'node:crypto'
import { timeline, db, linkIdentity, tinderMatches, logEvent, reconcileLinkStates, consolidateWaIdentities, igMediaDescription } from '../core/db.mjs'
import { colherHistorico } from './hints.mjs'
import { resolverPendentes } from './resolve.mjs'
import { mergePeople, canonicalPersonId, personAliases } from '../projects/store.mjs'

// Texto de uma mensagem para o histórico da IA: se for áudio transcrito, usa a
// transcrição (assim a IA "ouve" o que foi dito) em vez do marcador [audio].
function historyText(m) {
  if (m.media_json) {
    try {
      const md = JSON.parse(m.media_json)
      if (md && md.kind === 'audio') return md.transcript ? `[áudio] ${md.transcript}` : '[áudio ainda não transcrito]'
      // Foto do WhatsApp: junta a legenda original com a leitura visual. Enquanto a visão
      // ainda está pendente o autoreply do WhatsApp espera, então o modelo não responde
      // fingindo que viu. `descricao` cobre fotos salvas que a própria IA enviou.
      if (md && md.kind === 'image') {
        const caption = String(md.caption || (m.text !== '[imagem]' ? m.text : '') || '').trim()
        const desc = String(md.description || md.descricao || '').trim()
        const parts = []
        if (caption) parts.push(`legenda: ${caption}`)
        if (desc) parts.push(`conteúdo visual: ${desc}`)
        return parts.length ? `[imagem] ${parts.join(' | ')}` : '[imagem]'
      }
      // Vídeo do BANCO que nós mandamos (07/10/2026). Sem esta linha ele entrava no histórico
      // como mensagem vazia, e a IA não lembrava que já tinha mandado aquele vídeo.
      if (md && md.kind === 'video' && md.saved) {
        const desc = String(md.descricao || '').trim()
        return desc ? `[vídeo] conteúdo visual: ${desc}` : '[vídeo]'
      }
      // imagem/vídeo do IG: usa a descrição interpretada (se o setting media_interpret estiver
      // ligado e já rodou); senão o marcador. A descrição vive em ig_media, keyed pela URL.
      if (md && (md.kind === 'imagem' || md.kind === 'video') && md.src) {
        const desc = igMediaDescription(md.src)
        return desc ? `[${md.kind}] ${desc}` : (m.text || `[${md.kind}]`)
      }
    } catch { /* json inválido */ }
  }
  return m.text
}

// Horário LOCAL legível pra IA ("24/07 12:45"). O ISO UTC de antes confundia o modelo
// (3h adiantado pro Brasil) — foi assim que saiu "como tá sua noite" ao meio-dia.
const TS_FMT = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
export function localStamp(ts) { return TS_FMT.format(new Date(ts)).replace(', ', ' ') }

// Nome do canal como a IA lê (só aparece em pessoa com canais unificados).
const NOME_CANAL = { tinder: 'Tinder', whatsapp: 'WhatsApp', instagram: 'Instagram' }

// Histórico no formato do buildReplyPrompt, a partir da timeline unificada da pessoa.
//
// Pessoa com canais UNIFICADOS (o dono disse "essa do insta é a mesma do whats", ou o
// resolvedor casou o @): junta as threads dos dois lados numa linha do tempo só, em ordem,
// marcando o canal de cada mensagem. Sem isso, unificar identidade era só cosmético — a IA
// continuava lendo cada canal separado e recomeçava o assunto. Ver PLANO §2.9.
//
// Pessoa sem unificação: caminho idêntico ao de antes, byte a byte (nada de marcação).
// `author` viaja junto em cada mensagem ('ia' | 'humano' | null) mas NÃO entra no prompt da
// IA de conversa: messageLine (ai/prompt.mjs) só lê direção, texto e hora, então o texto
// enviado ao modelo continua byte a byte o mesmo do golden set. Quem consome a autoria é
// quem fala COM o dono — o assistente e o painel.
export function buildHistory(personId, name, { max = 1000 } = {}) {
  const ids = idsUnificados(personId)
  if (ids.length <= 1) {
    const msgs = timeline(personId, max)
    return { name, complete: true, messages: msgs.map((m) => ({ direction: m.direction, text: historyText(m), timestamp: localStamp(m.ts), author: m.author || null, channel: m.channel })) }
  }
  const todas = []
  for (const id of ids) for (const m of timeline(id, max)) todas.push(m)
  todas.sort((a, b) => (a.ts || 0) - (b.ts || 0))
  const recortadas = todas.slice(-max)
  const canais = new Set(recortadas.map((m) => m.channel))
  return {
    name,
    complete: true,
    messages: recortadas.map((m) => ({
      direction: m.direction,
      text: historyText(m),
      // o canal entra no carimbo de hora pra não mudar o formato da linha do prompt
      timestamp: canais.size > 1 ? `${localStamp(m.ts)} · ${NOME_CANAL[m.channel] || m.channel}` : localStamp(m.ts),
      author: m.author || null,
      channel: m.channel,
    })),
  }
}

// Todos os person_id que representam ESTA pessoa: ela, o canônico e os aliases. É o que
// costura WhatsApp + Instagram + Tinder quando as threads vivem em ids diferentes.
function idsUnificados(personId) {
  try {
    const canonico = canonicalPersonId(personId)
    const ids = new Set([String(personId), canonico, ...personAliases(canonico)])
    return [...ids].filter(Boolean)
  } catch { return [String(personId)] }
}

// Fingerprint da pendência atual (última mensagem recebida). null se a última foi minha.
export function pendingFingerprint(personId) {
  const last = db().prepare(`SELECT direction,text,ts FROM message WHERE person_id=? ORDER BY ts DESC LIMIT 1`).get(personId)
  if (!last || last.direction !== 'incoming') return null
  return 'in-' + crypto.createHash('sha1').update(`${personId}|${(last.text || '').toLowerCase()}|${last.ts}`).digest('hex').slice(0, 16)
}

// Vínculo determinístico. A partir de 24/07/2026 isto é uma casca fina: quem faz o
// trabalho é o par hints.mjs (colhe o contato com a frase de origem) + resolve.mjs (consulta
// o servidor, desempata pelo LID e vincula no jid certo). A versão anterior extraía o
// telefone com um regex frouxo sobre a conversa CONCATENADA e pegava o primeiro resultado
// que existisse — foi assim que nasceram 17 vínculos apontando pra lugar nenhum.
// Ver docs/PLANO-IDENTIDADE-VINCULO.md §1.4 (D3, D4, D5).
export async function linkDeterministic(waAccount, accountKey, { limite = 40 } = {}) {
  // 1. garante que o que já foi dito virou hint (idempotente e barato)
  try { colherHistorico(accountKey) } catch (e) { logEvent({ type: 'hint_error', detail: e.message }) }
  // 2. resolve os pendentes (telefone precisa do socket; Instagram anda sem ele)
  const r = await resolverPendentes(waAccount, accountKey, { limite, mergePeople })
  // 3. alinha o estado dos vínculos com a realidade (quem virou conversa, quem esfriou)
  const consolidado = consolidateWaIdentities(accountKey)   // 1 vínculo por pessoa
  const estados = reconcileLinkStates(accountKey, 'whatsapp')
  if (consolidado.removidos) logEvent({ type: 'vinculo_consolidado', detail: `${consolidado.removidos} vínculo(s) duplicado(s) removido(s) de ${consolidado.pessoas} pessoa(s)` })
  logEvent({ type: 'bridge_resolve', detail: JSON.stringify({ ...r, estados }) })
  return r
}

// Allowlist estrita: só é permitido o jid que tem identity whatsapp apontando pra uma pessoa.
export function isAllowedWaJid(accountKey, jid) {
  return !!db().prepare(`SELECT 1 FROM identity WHERE account_key=? AND channel='whatsapp' AND channel_id=?`).get(accountKey, jid)
}
export function personByWaJid(accountKey, jid) {
  return db().prepare(`SELECT person_id FROM identity WHERE account_key=? AND channel='whatsapp' AND channel_id=?`).get(accountKey, jid)?.person_id || null
}

// "Veio do Tinder de verdade": a identity do WhatsApp desse jid aponta pra uma pessoa
// que É um match do Tinder (existe em tinder_match). Adoção manual de conversa pura do
// WhatsApp cria person 'wa:{jid}' que NÃO tem match -> não conta como Tinder. Corrige o
// selo que antes acendia pra qualquer vínculo (inclusive ligar a IA numa conversa).
// Regra do selo (o dono, 25/07/2026): só é "do Tinder" quando existe vínculo com uma CONVERSA
// de verdade e uma PESSOA de verdade do Tinder. Não basta ter uma linha em tinder_match: o
// match precisa ter nome e conversa com mensagens. Assim o selo é prova, não enfeite — e o
// perfil dela sempre existe pra você conferir clicando nele.
export function cameFromTinder(accountKey, jid) {
  return !!db().prepare(`SELECT 1 FROM identity i
    JOIN tinder_match m ON m.person_id=i.person_id AND m.account_key=i.account_key
    WHERE i.account_key=? AND i.channel='whatsapp' AND i.channel_id=?
      AND m.name IS NOT NULL AND TRIM(m.name) != ''
      AND EXISTS (SELECT 1 FROM message t WHERE t.person_id=m.person_id AND t.channel='tinder')`)
    .get(accountKey, jid)
}

// Perfil do Tinder da pessoa vinculada a essa conversa do WhatsApp — é o que o selo abre.
// Devolve null quando não há vínculo válido (mesma regra do selo).
export function tinderProfileForWaJid(accountKey, jid) {
  const m = db().prepare(`SELECT m.* FROM identity i
    JOIN tinder_match m ON m.person_id=i.person_id AND m.account_key=i.account_key
    WHERE i.account_key=? AND i.channel='whatsapp' AND i.channel_id=?`).get(accountKey, jid)
  if (!m) return null
  let fotos = []
  try { fotos = JSON.parse(m.photos_json || '[]') } catch { /* json inválido */ }
  const msgs = db().prepare(`SELECT direction, text, ts FROM message
    WHERE person_id=? AND channel='tinder' ORDER BY ts DESC LIMIT 6`).all(m.person_id).reverse()
  // a frase em que ela passou o contato: é a prova de que o vínculo é dela
  const hint = db().prepare(`SELECT kind, normalized, quote FROM contact_hint
    WHERE person_id=? AND kind IN ('phone','wa_link') ORDER BY created_at ASC LIMIT 1`).get(m.person_id)
  return {
    personId: m.person_id, matchId: m.match_id, nome: m.name, idade: m.age || null, cidade: m.city || null,
    bio: m.bio || null, fotos, ativa: !!m.active, totalMensagens: db().prepare(
      `SELECT COUNT(*) n FROM message WHERE person_id=? AND channel='tinder'`).get(m.person_id).n,
    ultimas: msgs.map((x) => ({ dir: x.direction === 'outgoing' ? 'eu' : 'ela', texto: x.text, ts: x.ts })),
    provaDoVinculo: hint ? { valor: hint.normalized, frase: hint.quote } : null,
  }
}

// Person_id para indexar mensagens de uma conversa do WhatsApp: a pessoa VINCULADA
// (veio do Tinder) se existir; senão um id determinístico 'wa:{jid}'. Isso permite
// guardar/ler o histórico de conversas puras do WhatsApp sem criar uma linha em
// `person` — a entidade só é materializada quando o dono adota/liga a IA na conversa.
export function waPersonId(accountKey, jid) {
  return personByWaJid(accountKey, jid) || ('wa:' + jid)
}
