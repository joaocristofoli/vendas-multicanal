// FAXINA DE ABAS. O Chrome da VM é um recurso escasso: 2 núcleos servindo Tinder,
// Instagram, Badoo, o deslizar automático e o painel ao mesmo tempo.
//
// Em 27/07/2026 ele chegou a 27 abas e load 6,3. O sintoma NÃO foi lentidão visível: foi a
// IA parar de entregar mensagem no Badoo, porque o envio ali é clique no DOM e passou a
// estourar 120s de timeout. Ou seja, aba vazada vira conversa sem resposta — e ninguém
// liga uma coisa na outra olhando o painel.
//
// Duas fontes: sessões de deslizar que criavam aba nova a cada volta (corrigido em
// browser.mjs, agora reaproveita), e abas do próprio painel abertas por scripts de teste
// que morreram antes de fechar.
//
// Esta faxina é o cinto: roda sozinha, fecha o que sobrou e REGISTRA. Sem registro, o
// problema volta a ser invisível.
import { connectBrowser, firstContext } from './chrome.mjs'
import { logEvent } from '../core/db.mjs'

// Quantas abas de cada tipo o sistema precisa de verdade. O que passar disso é sobra.
const TETO = [
  { nome: 'painel', re: /^https?:\/\/127\.0\.0\.1:8080/, max: 0 },   // quem opera usa o próprio navegador; aqui é sempre teste esquecido
  { nome: 'badoo-encontros', re: /badoo\.com\/(pt\/)?encounters/, max: 1 },
  { nome: 'badoo', re: /badoo\.com/, max: 1 },
  { nome: 'instagram', re: /instagram\.com/, max: 1 },
  { nome: 'tinder', re: /tinder\.com/, max: 1 },
  { nome: 'em-branco', re: /^about:blank$/, max: 1 },
]

export async function faxinaDeAbas({ seco = false } = {}) {
  let ctx
  try {
    const b = await connectBrowser()
    ctx = firstContext(b)
  } catch (e) { return { erro: e.message } }
  if (!ctx) return { erro: 'Chrome sem contexto' }

  const abas = ctx.pages().filter((p) => !p.isClosed())
  const fechadas = []
  const contagem = {}
  for (const regra of TETO) {
    // as MAIS ANTIGAS primeiro: a última aberta costuma ser a que está em uso
    const doTipo = abas.filter((p) => regra.re.test(p.url()) && !fechadas.includes(p))
    contagem[regra.nome] = doTipo.length
    for (const p of doTipo.slice(0, Math.max(0, doTipo.length - regra.max))) {
      fechadas.push(p)
      if (!seco) await p.close().catch(() => {})
    }
  }
  if (fechadas.length) {
    logEvent({ type: 'chrome_faxina', detail: `${fechadas.length} aba(s) sobrando fechada(s) de ${abas.length} — ${
      Object.entries(contagem).filter(([, n]) => n).map(([k, n]) => `${k}:${n}`).join(', ')}` })
  }
  return { antes: abas.length, fechadas: fechadas.length, agora: abas.length - fechadas.length, contagem, seco }
}
