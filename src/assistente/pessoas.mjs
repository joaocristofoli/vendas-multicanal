// QUEM É "o contato_teste_p". O assistente resolve nome de pessoa em toda ação que mexe com gente
// (mandar mensagem, ligar IA, mudar modo). Até 27/07/2026 isso era uma linha:
//
//     return exato || achados[0]
//
// que, sem nome idêntico, PEGAVA O PRIMEIRO DA LISTA EM SILÊNCIO — e a lista vem na ordem
// das tabelas (WhatsApp, Instagram, Tinder), não por relevância. Com dois contatos de teste homônimos, um deles
// recebia uma mensagem com o nome do dono sem ninguém ter escolhido. Pior: o modelo nem
// ficava sabendo que havia dois, porque o código escolhia antes dele — então ele não tinha
// como perguntar.
//
// Aqui a ambiguidade vira um resultado explícito (PessoaAmbigua), que o orquestrador
// transforma numa ENQUETE pro dono escolher. É código, não instrução de prompt: não depende
// do modelo perceber nada.
import * as S from '../projects/store.mjs'
import { db } from '../core/db.mjs'
import { nomeParaMostrar } from '../core/nome.mjs'
import { ehSelfPerson } from './guarda.mjs'

// O WhatsApp aceita 12 opções por enquete. Acima de MAX_OPCOES a pergunta deixa de ajudar
// (rolar 9 nomes iguais é pior que digitar o sobrenome), então vira pedido de precisão.
export const MAX_OPCOES = 8
// Limite prático de uma opção de enquete do WhatsApp. Truncar aqui e não na hora de enviar
// porque o rótulo TEM que ser idêntico ao que volta no voto — é por ele que se casa a escolha.
const MAX_ROTULO = 90

const NOME_CANAL = { whatsapp: 'WhatsApp', instagram: 'Instagram', tinder: 'Tinder', badoo: 'Badoo' }

// Comparação de nome sem armadilha: acento, caixa e os INVISÍVEIS que vêm do WhatsApp
// (contato salvo como "ㅤAna Vitória" pra pular pro topo da agenda dele — sem tirar
// isso, o nome não "começa com ana" e a pessoa some da comparação sem ninguém ver).
export function normalizar(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[​-‏⁠ㅤ﻿]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim()
}

export class PessoaAmbigua extends Error {
  constructor(termo, candidatos) {
    super(`mais de uma pessoa chamada "${termo}"`)
    this.name = 'PessoaAmbigua'
    this.termo = String(termo)
    this.candidatos = candidatos
  }
}

// Quando a última mensagem foi — o que de fato distingue dois homônimos na cabeça do dono
// ("o contato_teste_p" é com quem ele fala, não o que existe no banco). Lê a timeline unificada:
// pessoa canônica pode ter várias redes, e a mais recente de qualquer uma delas vale.
function ultimaMensagem(personId) {
  const ids = S.personAliases(S.canonicalPersonId(personId))
  if (!ids.length) return 0
  const marcas = ids.map(() => '?').join(',')
  const r = db().prepare(`SELECT max(ts) mx FROM message WHERE person_id IN (${marcas})`).get(...ids)
  return r?.mx || 0
}

// Por onde falar com ela. Três perguntas, nesta ordem, e a ordem é o ponto:
//   1. o canal que ele pediu, SE ela tiver — o pedido dele manda;
//   2. senão, onde a conversa está VIVA (última mensagem), não onde ela nasceu;
//   3. senão, WhatsApp.
//
// O passo 2 existe porque `personChannels` devolve em ordem FIXA com 'tinder' na frente:
// quem veio do Tinder e migrou pro WhatsApp meses atrás (é o caso comum aqui) receberia
// pelo Tinder, num chat morto, enquanto a conversa de verdade segue no WhatsApp.
export function canalPreferido(personId, pedido = null, canaisQueTem = null) {
  const validos = ['whatsapp', 'instagram', 'tinder', 'badoo']
  const tem = canaisQueTem && canaisQueTem.length ? canaisQueTem : S.personChannels(S.canonicalPersonId(personId))
  if (pedido && validos.includes(pedido) && (!tem.length || tem.includes(pedido))) return pedido
  const ids = S.personAliases(S.canonicalPersonId(personId))
  if (ids.length) {
    const marcas = ids.map(() => '?').join(',')
    const r = db().prepare(`SELECT channel FROM message WHERE person_id IN (${marcas}) ORDER BY ts DESC LIMIT 1`).get(...ids)
    if (r?.channel && (!tem.length || tem.includes(r.channel))) return r.channel
  }
  if (tem.includes('whatsapp')) return 'whatsapp'
  return tem[0] || 'whatsapp'
}

function haQuantoTempo(ts) {
  if (!ts) return 'sem conversa'
  const dias = Math.floor((Date.now() - ts) / 86400000)
  if (dias <= 0) return 'falaram hoje'
  if (dias === 1) return 'falaram ontem'
  if (dias < 30) return `falaram há ${dias} dias`
  const meses = Math.floor(dias / 30)
  return meses < 12 ? `falaram há ${meses} ${meses === 1 ? 'mês' : 'meses'}` : 'falaram há mais de um ano'
}

// O rótulo é o que aparece na enquete E o que volta no voto: precisa ser legível, curto e
// ÚNICO. Sem unicidade, dois rótulos iguais tornam o voto indecifrável (o WhatsApp devolve
// o texto da opção, não o índice) — por isso quem chama passa por rotulosUnicos.
// nomeParaMostrar é obrigatório aqui: identificador interno nunca chega aos olhos do dono.
export function rotuloPessoa(c) {
  const nome = nomeParaMostrar(c.personId) || c.name || 'contato sem nome'
  const canais = (c.channels && c.channels.length ? c.channels : [c.channel]).map((x) => NOME_CANAL[x] || x).join('+')
  const partes = [canais, c.sub, haQuantoTempo(c.ultimaMsg)].filter(Boolean)
  const bruto = `${nome} — ${partes.join(', ')}`
  return bruto.length > MAX_ROTULO ? bruto.slice(0, MAX_ROTULO - 1).trimEnd() + '…' : bruto
}

// Desempata rótulos repetidos (dois contatos com o mesmo nome, mesmo canal e mesma idade de
// conversa). Numerar é feio, mas rótulo ambíguo quebraria a leitura do voto.
function rotulosUnicos(cands) {
  const vistos = new Map()
  return cands.map((c) => {
    let r = rotuloPessoa(c)
    if (vistos.has(r)) {
      const n = vistos.get(r) + 1
      vistos.set(r, n)
      const sufixo = ` (${n})`
      r = (r.length + sufixo.length > MAX_ROTULO ? r.slice(0, MAX_ROTULO - sufixo.length) : r) + sufixo
    } else vistos.set(r, 1)
    return { ...c, rotulo: r }
  })
}

// Todo mundo que pode ser "o contato_teste_p", em ordem de recência. O próprio o dono nunca entra:
// ele não é um contato (a mesma regra da acharPessoa original).
export function candidatosPessoa(accountKey, termo, limite = 20) {
  const t = String(termo || '').trim()
  if (!t) return []
  const achados = S.searchPeople(accountKey, t, limite).filter((p) => !ehSelfPerson(accountKey, p.personId))
  const comData = achados.map((p) => ({ ...p, ultimaMsg: ultimaMensagem(p.personId) }))
  comData.sort((a, b) => (b.ultimaMsg || 0) - (a.ultimaMsg || 0))
  return rotulosUnicos(comData)
}

// Resolve o nome que ele falou numa pessoa só — ou recusa.
//
// Ordem: (1) escolha já feita (__personId, que é como o voto da enquete volta pra cá);
// (2) nome idêntico ganha (preserva o comportamento de sempre: quem escreve o nome inteiro
// não é interrogado); (3) um candidato só; (4) mais de um => PessoaAmbigua.
export function resolverPessoa(accountKey, termo, { personId = null } = {}) {
  if (personId) {
    const canon = S.canonicalPersonId(personId)
    const card = S.personCard(canon, accountKey)
    // A escolha da enquete é soberana, mas nem ela pode virar o próprio o dono.
    if (ehSelfPerson(accountKey, canon)) throw new Error('essa conversa é a sua comigo')
    return card
  }
  const t = String(termo || '').trim()
  if (!t) throw new Error('faltou dizer quem')
  const cands = candidatosPessoa(accountKey, t)
  if (!cands.length) {
    const ehTelefone = t.replace(/\D/g, '').length >= 8
    throw new Error(ehTelefone
      ? `nenhuma conversa com o número ${t} em nenhum canal (procurei pelas duas formas do celular, com e sem o 9)`
      : `não achei ninguém chamado "${t}"`)
  }
  // Quem AMEAÇA ser a pessoa é quem o nome COMEÇA com o que ele falou. A busca casa por
  // substring em qualquer posição (é o certo pra achar: "empresa" tem que achar "fixture sintética -
  // empresa exemplo"), mas isso não serve pra ESCOLHER — "contato_teste_p" casava um perfil chamado
  // "Perfil Exemplo" só porque o @ dele é contato_teste_t, e perguntar entre esses dois é ruído.
  //
  // Também é aqui que morre o falso alívio do nome idêntico: existe um contato chamado
  // literalmente "Ana", e por causa dele "avisa a ana" escolhia sozinho entre Ana, Ana
  // Clara, Ana Claudia e Ana Vitória. O nome do cadastro ser curto é coincidência, não
  // intenção dele — se mais alguém começa igual, a pergunta continua valendo.
  const alvo = normalizar(t)
  const comecam = cands.filter((c) => normalizar(c.name).startsWith(alvo))
  const conjunto = comecam.length ? comecam : cands
  if (conjunto.length === 1) return conjunto[0]
  if (conjunto.length > MAX_OPCOES) {
    throw new Error(`achei ${conjunto.length} pessoas com "${t}" — muita gente pra escolher numa lista. me diz o sobrenome ou o número. os primeiros: ${conjunto.slice(0, 5).map((c) => nomeParaMostrar(c.personId)).join(', ')}`)
  }
  throw new PessoaAmbigua(t, conjunto)
}
