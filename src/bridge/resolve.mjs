// Resolvedor de vínculo (F4 do docs/PLANO-IDENTIDADE-VINCULO.md).
//
// Pega um contato colhido (contact_hint) e transforma em vínculo — ou em pendência de
// revisão, quando não dá pra ter certeza. O princípio inteiro do plano mora aqui:
// NUNCA CHUTAR. A gente gera hipóteses; quem decide qual existe é o servidor.
//
// O que mudou em relação ao linkDeterministic antigo:
//  1. pega TODOS os candidatos que existem, não o primeiro que aparecer na resposta;
//  2. desempata pelo LID (mesmo LID = mesma pessoa) em vez de pela ordem do servidor;
//  3. grava o vínculo no @lid, que é onde a conversa realmente chega;
//  4. ambiguidade real vira revisão humana, não palpite;
//  5. vínculo manual é intocável — o automático não sobrescreve o que o dono decidiu.
import crypto from 'node:crypto'
import {
  db, linkIdentity, personByIdentity, identityRow, setIdentityState, setContactHintStatus,
  contactHints, getContactHint, addLinkReview, getIgChat, logEvent, getWaChat, upsertWaChat, personDisplayName,
  adoptWaConversation, transferirIaEntreCanais, getSetting, getWaSession,
} from '../core/db.mjs'
import { phoneCandidates, prettyPhone, completarComDDD } from '../wa/phone.mjs'
import { resolveLidForPn } from '../wa/identity.mjs'

const uid = () => crypto.randomUUID().slice(0, 8)

// Vínculo que o dono criou/confirmou na mão nunca é mexido pelo automático.
const MANUAL = new Set(['manual', 'manual-ui', 'confirmado'])
export function ehManual(row) { return !!row && MANUAL.has(row.link_method) }

// De quem é o número que apareceu na conversa? Esta pergunta é a diferença entre vincular
// certo e misturar duas pessoas — e foi um erro real em produção (24/07/2026): alguém
// mandou "Fornecedor- Marcio, contato- 11 99999-0023" numa conversa de WhatsApp e o
// resolvedor vinculou aquela conversa ao WhatsApp do Marcio.
//
// A regra que separa os dois mundos:
//  - pessoa do TINDER: ela está passando o PRÓPRIO contato pra conversa continuar em outro
//    canal. É o caso de uso inteiro do vendas-multicanal. Vincula sozinho.
//  - conversa de WhatsApp/Instagram: um número citado ali é quase sempre de TERCEIRO
//    (fornecedor, cliente, amigo). Só vincula sozinho se apontar pra própria conversa;
//    qualquer outra coisa vai pra revisão.
// A regra nunca foi "do Tinder": é "de app de namoro". Lá, passar o próprio número é o
// caso de uso inteiro. No WhatsApp, um número citado é quase sempre de terceiro. Com o
// Badoo entrando (25/07/2026), a pergunta certa passou a ser esta.
export function ehPessoaDeApp(accountKey, personId) {
  const doTinder = db().prepare(`SELECT 1 FROM tinder_match WHERE account_key=? AND person_id=? LIMIT 1`).get(accountKey, personId)
  if (doTinder) return true
  return !!db().prepare(`SELECT 1 FROM badoo_chat WHERE account_key=? AND chat_id=? LIMIT 1`)
    .get(accountKey, String(personId).replace(/^b:/, ''))
}
// nome antigo mantido: era usado como "pessoa que passa o próprio contato"
export const ehPessoaDoTinder = ehPessoaDeApp

// A pessoa já tem vínculo neste canal? Devolve a linha (pra decidir se mexe ou não).
function vinculoAtual(accountKey, channel, personId) {
  return db().prepare(`SELECT * FROM identity WHERE account_key=? AND channel=? AND person_id=?`).get(accountKey, channel, personId) || null
}

// ---------------------------------------------------------------- telefone -> WhatsApp
// Devolve { estado, jid?, motivo?, opcoes? }:
//   'vinculado'  criou/confirmou o vínculo (jid = onde ele mora)
//   'ambiguo'    dois números existem e são pessoas diferentes -> foi pra revisão
//   'inexistente' nenhum candidato existe no WhatsApp
//   'pulado'     já havia vínculo manual, ou nada a fazer
export async function resolverTelefone(acc, { accountKey, personId, numero, hintId, quote }) {
  const atual = vinculoAtual(accountKey, 'whatsapp', personId)
  if (ehManual(atual)) return { estado: 'pulado', motivo: 'vínculo manual existente' }

  const candidatos = phoneCandidates(numero)
  if (!candidatos.length) return { estado: 'inexistente', motivo: 'número não passou na validação' }

  let existentes = []
  try {
    const r = await acc.onWhatsApp(...candidatos)
    existentes = (r || []).filter((x) => x && x.exists && x.jid).map((x) => x.jid)
  } catch (e) {
    return { estado: 'pulado', motivo: 'consulta falhou: ' + (e && e.message ? e.message : e) }
  }
  if (!existentes.length) return { estado: 'inexistente', motivo: 'nenhuma variante existe no WhatsApp' }

  // Uma só existe: caminho feliz. Resolve o LID pra o vínculo nascer no jid certo.
  if (existentes.length === 1) {
    const jid = await ancorarNoLid(acc, existentes[0])
    return aplicarVinculo({ accountKey, personId, jid, hintId, numero })
  }

  // Duas ou mais existem (o clássico "com 9" e "sem 9"): o LID diz se é a mesma pessoa.
  const lids = []
  for (const pn of existentes) lids.push({ pn, lid: await resolveLidForPn(acc, pn) })
  const distintos = [...new Set(lids.map((l) => l.lid).filter(Boolean))]

  if (distintos.length === 1) {
    // Mesmo LID: é a mesma conta nas duas formas. Vincula no LID.
    const jid = distintos[0]
    return aplicarVinculo({ accountKey, personId, jid, hintId, numero })
  }
  if (distintos.length === 0) {
    // Nenhum LID resolveu: não dá pra saber se é a mesma pessoa. Não escolhe — manda revisar.
    filaDeRevisao({ accountKey, personId, opcoes: existentes, hintId, quote, numero, motivo: 'duas variantes existem e o LID não resolveu' })
    return { estado: 'ambiguo', opcoes: existentes, motivo: 'LID não resolvido' }
  }
  // LIDs diferentes = contas diferentes de verdade. É exatamente o caso que fazia o sistema
  // antigo vincular a pessoa errada calado.
  filaDeRevisao({ accountKey, personId, opcoes: distintos, hintId, quote, numero, motivo: 'as duas variantes são contas diferentes' })
  return { estado: 'ambiguo', opcoes: distintos, motivo: 'contas diferentes' }
}

// Traz o vínculo pro @lid quando ele existir (a conversa chega lá). Se não resolver, fica
// no número mesmo — melhor um vínculo no PN do que nenhum; o backfill conserta depois.
async function ancorarNoLid(acc, pnJid) {
  const lid = await resolveLidForPn(acc, pnJid)
  return lid || pnJid
}

function aplicarVinculo({ accountKey, personId, jid, hintId, numero }) {
  const dono = personByIdentity(accountKey, 'whatsapp', jid)
  if (dono && dono !== personId) {
    // esse jid já é de outra pessoa: não rouba. Vai pra revisão.
    filaDeRevisao({ accountKey, personId, opcoes: [jid], hintId, numero, motivo: `jid já vinculado a ${personDisplayName(dono) || dono}` })
    return { estado: 'ambiguo', motivo: 'jid já é de outra pessoa' }
  }
  // Número citado dentro de uma conversa que NÃO é do Tinder: só vincula se for a própria
  // conversa (a pessoa mandando o próprio número). Apontando pra outro lugar, é terceiro —
  // e terceiro NÃO VAI PRA FILA. A fila é só sobre as meninas que passaram contato no
  // Tinder; encher ela com número de fornecedor, de ar-condicionado e de cliente fez o
  // o dono perder o que importa no meio do ruído (correção dele, 24/07/2026). O contato fica
  // guardado como 'ignorado' — se um dia ele quiser unir na mão, o autofill da aba Vínculos
  // acha essas conversas do mesmo jeito.
  if (!ehPessoaDeApp(accountKey, personId) && personId !== 'wa:' + jid) {
    if (hintId) setContactHintStatus(hintId, 'ignorado')
    logEvent({ type: 'vinculo_ignorado', personId, channel: 'whatsapp', detail: `número de terceiro (${numero || jid})` })
    return { estado: 'ignorado', motivo: 'número citado fora de conversa do Tinder' }
  }
  linkIdentity({ accountKey, channel: 'whatsapp', channelId: jid, personId, method: 'deterministic' })
  // A conversa pode já ter histórico guardado no id cru ('wa:'+jid). Sem trazer junto, ela
  // abriria VAZIA no painel e a IA perderia o contexto — regressão real de 24/07/2026.
  const adotadas = adoptWaConversation(accountKey, jid, personId)
  if (adotadas) logEvent({ type: 'vinculo_adotou_historico', personId, channel: 'whatsapp', detail: `${adotadas} mensagens de ${jid}` })
  setIdentityState({ accountKey, channel: 'whatsapp', channelId: jid, state: 'confirmado_servidor', evidenceHintId: hintId })
  // A conversa mudou de casa: o toggle vai junto (transfere, não liga do nada — ver
  // transferirIaEntreCanais). Reversível pelo setting `transferir_ia_no_vinculo`.
  if (getSetting('transferir_ia_no_vinculo', true)) {
    try { transferirIaEntreCanais({ personId, de: 'tinder', para: 'whatsapp' }) } catch { /* nunca derruba o vínculo */ }
  }
  if (hintId) setContactHintStatus(hintId, 'resolvido')
  // marca a conversa como vinda do Tinder pro selo do painel (se ela já existir)
  if (getWaChat(accountKey, jid)) upsertWaChat({ accountKey, jid, fromTinder: true })
  logEvent({ type: 'vinculo_criado', personId, channel: 'whatsapp', detail: jid })
  return { estado: 'vinculado', jid }
}

// ---------------------------------------------------------------- número sem DDD
// DDDs que fazem sentido tentar pra um assinante solto ("98673-4658"). Ordem = do mais
// específico pro mais genérico, e tudo vem do BANCO, não de chute: o DDD do próprio o dono,
// os DDDs que essa pessoa já usou, e os mais comuns na agenda dele.
export function dddsPlausiveis(accountKey, personId) {
  const out = []
  const junta = (d) => { const dd = String(d || '').replace(/\D/g, '').slice(-2); if (dd.length === 2 && !out.includes(dd)) out.push(dd) }
  for (const h of contactHints({ personId, limit: 20 })) {
    if (h.kind === 'phone' || h.kind === 'wa_link') {
      const dig = String(h.normalized || '').replace(/\D/g, '')
      if (dig.startsWith('55') && dig.length >= 12) junta(dig.slice(2, 4))
    }
  }
  const meu = getWaSession(accountKey)?.jid
  if (meu) { const d = String(meu).split(/[:@]/)[0]; if (d.startsWith('55')) junta(d.slice(2, 4)) }
  for (const r of db().prepare(`SELECT substr(pn,3,2) ddd, COUNT(*) n FROM wa_chat
      WHERE account_key=? AND pn IS NOT NULL AND pn LIKE '55%' GROUP BY 1 ORDER BY 2 DESC LIMIT 4`).all(accountKey)) junta(r.ddd)
  return out.slice(0, 5)
}

// Resolve um assinante sem DDD. NUNCA vincula sozinho: o DDD é hipótese NOSSA, então mesmo
// com uma única resposta do servidor a decisão volta pro dono na fila de revisão. O que este
// caminho garante é que o número não some — antes ele nem virava hint.
export async function resolverSemDDD(acc, { accountKey, personId, digitos, hintId, quote }) {
  const assinante = String(digitos || '').replace(/\D/g, '').replace(/^0+/, '')
  const ddds = dddsPlausiveis(accountKey, personId)
  const nacionais = completarComDDD(assinante, ddds)
  if (!nacionais.length) return { estado: 'inexistente', motivo: 'não consegui montar nenhum número válido com esses dígitos' }
  const candidatos = []
  for (const n of nacionais) for (const j of phoneCandidates(n)) if (!candidatos.includes(j)) candidatos.push(j)
  let existentes = []
  try {
    const r = await acc.onWhatsApp(...candidatos)
    existentes = (r || []).filter((x) => x && x.exists && x.jid).map((x) => x.jid)
  } catch (e) {
    return { estado: 'pulado', motivo: 'consulta falhou: ' + (e && e.message ? e.message : e) }
  }
  if (!existentes.length) {
    // Não achar é um RESULTADO, não um motivo pra sumir. Marcar como 'ignorado' e seguir foi
    // o mesmo silêncio de antes com outra roupa: ela passou o número, ele não leva a lugar
    // nenhum, e o dono precisa saber pra perguntar de novo. Vai pra revisão sem opção.
    if (hintId) setContactHintStatus(hintId, 'ambiguo')
    filaDeRevisao({
      accountKey, personId, opcoes: [], hintId, quote, numero: null,
      motivo: `ela escreveu ${assinante} sem DDD e esse número não existe no WhatsApp em nenhum DDD que testei (${ddds.join(', ')})`,
    })
    logEvent({ type: 'vinculo_sem_ddd_vazio', personId, channel: 'whatsapp', detail: `${assinante} não existe em nenhum DDD testado (${ddds.join(', ')})` })
    return { estado: 'ambiguo', motivo: `nenhum DDD testado (${ddds.join(', ')}) tem esse número no WhatsApp` }
  }
  filaDeRevisao({
    accountKey, personId, opcoes: existentes, hintId, quote,
    numero: null,
    motivo: `ela escreveu o número sem DDD (${assinante}) e eu completei com os DDDs mais prováveis`,
  })
  return { estado: 'ambiguo', opcoes: existentes, motivo: 'número sem DDD' }
}

// A revisão só serve se você conseguir DECIDIR olhando pra ela. Por isso ela guarda: o
// número como a pessoa escreveu (não o identificador interno do WhatsApp, que não diz
// nada), a frase de origem, e o nome de quem é o outro lado quando a gente sabe.
function filaDeRevisao({ accountKey, personId, opcoes, hintId, quote, motivo, numero }) {
  const alvo = (opcoes && opcoes[0]) || null
  const hint = hintId ? getContactHint(hintId) : null
  const numeroEscrito = numero || hint?.normalized || null
  const frase = quote || hint?.quote || null
  const chatAlvo = alvo ? getWaChat(accountKey, alvo) : null
  addLinkReview({
    id: 'rev:' + uid(),
    accountKey,
    waJid: alvo,
    // TODAS as candidatas, não só a primeira: é isso que a tela precisa pra perguntar
    // "qual dessas?" em vez de oferecer só um botão de recusar
    opcoes: (opcoes || []).filter(Boolean),
    // nome de quem está do outro lado do número (se já existe conversa com ele)
    pushName: chatAlvo?.name || (numeroEscrito ? prettyPhone(numeroEscrito) : null),
    firstText: frase,
    candidatePersonId: personId,
    candidateName: personDisplayName(personId),
    candidateScore: 0,
    reason: `${motivo}${numeroEscrito ? ` | número: ${prettyPhone(numeroEscrito)}` : ''}`,
  })
  if (hintId) setContactHintStatus(hintId, 'ambiguo')
  logEvent({ type: 'vinculo_ambiguo', personId, channel: 'whatsapp', detail: motivo })
}

// ---------------------------------------------------------------- @ -> Instagram
// O casamento aqui é por IDENTIFICADOR EXATO (o username da thread), não por nome — por
// isso pode ser automático sem medo. Sem thread ainda, o hint fica pendente: se ela
// responder um dia, a thread nasce e o vínculo fecha sozinho na próxima passada.
export function resolverInstagram({ accountKey, personId, username, hintId }) {
  const alvo = String(username || '').toLowerCase()
  if (!alvo) return { estado: 'pulado' }
  const thread = db().prepare(`SELECT thread_id, name FROM ig_chat WHERE account_key=? AND lower(username)=?`).get(accountKey, alvo)
  if (!thread) return { estado: 'sem_thread' }
  const igPersonId = 'ig:' + thread.thread_id
  if (igPersonId === personId) { if (hintId) setContactHintStatus(hintId, 'resolvido'); return { estado: 'pulado', motivo: 'é a própria conversa' } }
  // Mesmo cuidado do telefone: um @ citado numa conversa que não é do Tinder pode ser de
  // outra pessoa ("me manda o insta deles?"). Só une sozinho quando é a pessoa do Tinder
  // passando o próprio perfil; o resto vai pra revisão.
  if (!ehPessoaDeApp(accountKey, personId)) {
    if (hintId) setContactHintStatus(hintId, 'ignorado')
    return { estado: 'ignorado', motivo: '@ citado fora de conversa do Tinder' }
  }
  return { estado: 'vinculavel', igPersonId, threadId: thread.thread_id, nome: thread.name }
}

// ---------------------------------------------------------------- passada geral
// Roda sobre os hints ainda não resolvidos. `acc` pode ser null: aí só o Instagram anda
// (não precisa de socket) e os telefones ficam pra quando o WhatsApp estiver conectado.
// `hintId` resolve UM contato específico. Existe porque o botão "É contato dela" da aba
// Vínculos aponta pra uma pessoa na tela: rodar a fila inteira e torcer pra ela estar dentro
// é outra coisa, e era o que acontecia (o painel mandava `limite: 5` sem dizer qual).
export async function resolverPendentes(acc, accountKey, { limite = 25, mergePeople, hintId = null } = {}) {
  const pend = hintId
    ? [getContactHint(hintId)].filter((h) => h && h.status === 'novo')
    : contactHints({ status: 'novo', limit: limite })
  const resumo = { vistos: pend.length, vinculados: 0, ambiguos: 0, inexistentes: 0, semThread: 0, pulados: 0, ignorados: 0 }
  for (const h of pend) {
    try {
      if (h.kind === 'instagram') {
        const r = resolverInstagram({ accountKey, personId: h.person_id, username: h.normalized, hintId: h.id })
        if (r.estado === 'vinculavel' && typeof mergePeople === 'function') {
          mergePeople(h.person_id, r.igPersonId)
          setContactHintStatus(h.id, 'resolvido')
          logEvent({ type: 'vinculo_criado', personId: h.person_id, channel: 'instagram', detail: '@' + h.normalized })
          resumo.vinculados++
        } else if (r.estado === 'sem_thread') resumo.semThread++
        else if (r.estado === 'ignorado') resumo.ignorados++
        else resumo.pulados++
        continue
      }
      // número que a pessoa escreveu sem DDD: hipótese nossa + veredito do servidor + revisão
      if (h.kind === 'phone_sem_ddd') {
        if (!acc || !acc.sock) { resumo.pulados++; continue }
        if (!ehPessoaDeApp(accountKey, h.person_id)) { setContactHintStatus(h.id, 'ignorado'); resumo.ignorados++; continue }
        const r = await resolverSemDDD(acc, { accountKey, personId: h.person_id, digitos: h.normalized, hintId: h.id, quote: h.quote })
        if (r.estado === 'ambiguo') resumo.ambiguos++
        else if (r.estado === 'inexistente') resumo.inexistentes++
        else resumo.pulados++
        continue
      }
      // número que nem dá pra ler: fica de fora do automático, mas registrado (o hint existe
      // e aparece em "Pra revisar" — o que não pode é sumir calado, que era o comportamento).
      if (h.kind === 'phone_ilegivel') { resumo.pulados++; continue }
      // telefone / link de whatsapp
      if (!acc || !acc.sock) { resumo.pulados++; continue }
      const r = await resolverTelefone(acc, { accountKey, personId: h.person_id, numero: h.normalized, hintId: h.id, quote: h.quote })
      if (r.estado === 'vinculado') resumo.vinculados++
      else if (r.estado === 'ambiguo') resumo.ambiguos++
      else if (r.estado === 'ignorado') resumo.ignorados++
      else if (r.estado === 'inexistente') { setContactHintStatus(h.id, 'ignorado'); resumo.inexistentes++ }
      else resumo.pulados++
    } catch (e) {
      logEvent({ type: 'vinculo_erro', personId: h.person_id, detail: e && e.message ? e.message : String(e) })
    }
  }
  return resumo
}
