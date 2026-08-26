// Funcoes PURAS de manipulacao de numero/JID do WhatsApp.
// Nenhuma dependencia do baileys aqui de proposito: da pra testar tudo isso
// sem socket, sem rede, sem sessao. O "pulo do gato" do 9o digito brasileiro
// (ENTENDIMENTO-BAILEYS.md, secao "9o digito BR") mora aqui: geramos as duas
// variantes possiveis e deixamos o onWhatsApp dizer qual existe — nunca chutamos.

// A regra do numero brasileiro (9o digito, DDD valido, celular x fixo) mora em phone.mjs,
// que e o nucleo testado (tests-tim/phone-br.mjs). Aqui ficam so as funcoes de JID.
import { parseBrazilianPhone, phoneCandidates } from './phone.mjs'

const WA_USER_DOMAIN = 's.whatsapp.net'

// So digitos.
function onlyDigits(raw) {
  return String(raw == null ? '' : raw).replace(/\D+/g, '')
}

// Normaliza um telefone brasileiro para os digitos NACIONAIS (sem DDI 55).
// - tira tudo que nao e digito;
// - se tiver 12+ digitos e comecar com 55, remove o DDI 55;
// - valida que sobrou 10 (fixo/DDD+8) ou 11 (celular/DDD+9) digitos;
// - senao, lanca erro claro.
// Retorna a string de 10 ou 11 digitos nacionais.
export function normalizeBrazilianPhone(raw) {
  const p = parseBrazilianPhone(raw)
  if (!p.ok) throw new Error(`Numero brasileiro invalido (${p.motivo}): ${JSON.stringify(raw)}`)
  return p.nacional
}

// Gera os candidatos de JID (@s.whatsapp.net) a partir de um numero cru.
// Cobre o 9o digito: se o numero de 11 digitos tem '9' como 3o digito
// (primeiro digito depois do DDD), adiciona a variante SEM esse 9; se for de
// 10 digitos, adiciona a variante COM o 9 inserido apos o DDD.
// O prefixo 55 (DDI) e sempre adicionado. Devolve array (ordem estavel), sem
// duplicatas (usa Set internamente).
export function buildBrazilianJidCandidates(raw) {
  const jids = phoneCandidates(raw)
  if (!jids.length) normalizeBrazilianPhone(raw) // reaproveita a mensagem de erro exata
  return jids
}

// Normaliza um JID recebido do baileys removendo o sufixo de dispositivo:
//   'user:NN@dominio' -> 'user@dominio'
// Preserva o dominio (@s.whatsapp.net, @g.us, @lid, @newsletter, ...).
// Retorna null se o JID for invalido (sem '@' ou sem parte de usuario).
export function normalizeJid(rawJid) {
  const jid = String(rawJid == null ? '' : rawJid).trim()
  if (!jid) return null
  const at = jid.indexOf('@')
  if (at <= 0) return null
  const userPart = jid.slice(0, at)
  const domain = jid.slice(at + 1)
  if (!domain) return null
  // Remove sufixo de device (':NN' apos o usuario).
  const user = userPart.split(':')[0]
  if (!user) return null
  return `${user}@${domain}`
}

// Extrai os digitos da parte antes do '@' de um JID.
//
// CUIDADO — isto NÃO é "o telefone da pessoa". Num jid @lid (a conta do dono está no
// sistema LID: ~70% das conversas) esta função devolve os dígitos do LID, que não têm
// relação nenhuma com o número. Ela não estoura e não devolve null: devolve uma string
// plausível e errada, e é exatamente por isso que decidir identidade com ela falha em
// silêncio na produção depois de passar em todo teste.
//
// Pra decidir "é a mesma pessoa?" / "sou eu?", use digitosDeContato / mesmoContato
// (src/wa/identity.mjs), que resolvem o LID pelo mapa e devolvem null quando não sabem.
// Aqui só serve pra exibição e pra montar índice a partir de um PN já resolvido.
export function phoneFromJid(jid) {
  const normalized = normalizeJid(jid)
  if (!normalized) return ''
  const userPart = normalized.slice(0, normalized.indexOf('@'))
  return onlyDigits(userPart)
}

// Diz se um JID e "rastreavel": um chat 1:1 de pessoa, que o vendas-multicanal pode processar.
// Retorna false para grupos (@g.us), canais (@newsletter), broadcast (@broadcast
// e status@broadcast); true caso contrario. Isso e um filtro estrutural — a
// allowlist propriamente dita (so contatos vindos do Tinder) e aplicada depois.
export function isTrackableJid(jid) {
  const raw = String(jid == null ? '' : jid).trim().toLowerCase()
  if (!raw) return false
  if (raw === 'status@broadcast') return false
  if (raw.endsWith('@g.us')) return false
  if (raw.endsWith('@newsletter')) return false
  if (raw.endsWith('@broadcast')) return false
  return true
}
