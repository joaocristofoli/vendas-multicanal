// MONITORAMENTO CONTÍNUO DA IA: ela está conversando melhor ou pior, esta semana?
//
// A régua não é opinião nem "soou bem": é O QUE ACONTECEU DEPOIS. Para cada mensagem que a
// IA mandou, olha-se a seguinte na conversa — a pessoa respondeu? respondeu com conteúdo ou
// com um "ah sim"? Isso é desfecho, não estilo, e é comparável semana a semana.
//
// A referência é o PRÓPRIO HUMANO no mesmo período. Comparar a IA com ela mesma de duas
// semanas atrás confunde melhora com sorte (as pessoas mudam, os canais mudam, o volume
// muda); comparar com ele no mesmo período controla tudo isso de graça.
//
import { db, logEvent } from '../core/db.mjs'

const SEM_CONTEUDO = /^(ah?\s*(sim|ta|tá|é|eh|bom|legal)?|sim|nao|não|aham|uhum|entendi|nossa|legal|top|show|kk+|ha(ha)+|rs+|\.+)$/i
const CANAIS = "('tinder','badoo','instagram','whatsapp')"

// Mede um autor num intervalo. Só conta mensagem no MEIO de conversa (ela já tinha falado):
// abertura é outro jogo e misturar os dois esconde o que interessa.
export function medir({ autor, desde, ate = Date.now() }) {
  const linhas = db().prepare(`SELECT person_id, direction, text, ts, author FROM message
    WHERE channel IN ${CANAIS} AND text IS NOT NULL AND length(text) > 0
      AND person_id IN (SELECT person_id FROM message WHERE author=? AND ts BETWEEN ? AND ?)
    ORDER BY person_id, ts`).all(autor, desde, ate)

  const porP = new Map()
  for (const l of linhas) { if (!porP.has(l.person_id)) porP.set(l.person_id, []); porP.get(l.person_id).push(l) }

  let n = 0, respondeu = 0, comConteudo = 0, comPergunta = 0, comSubstancia = 0, ambos = 0, chars = 0
  for (const ms of porP.values()) {
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]
      if (m.direction !== 'outgoing' || m.author !== autor) continue
      if (m.ts < desde || m.ts > ate) continue
      if (!ms.slice(0, i).some((x) => x.direction === 'incoming')) continue   // no meio da conversa
      const t = String(m.text).trim()
      const prox = ms[i + 1]
      const veio = !!(prox && prox.direction === 'incoming')
      const rico = veio && !SEM_CONTEUDO.test(String(prox.text).trim()) && String(prox.text).trim().length > 12
      const perg = /\?/.test(t)
      const subs = /\b(eu (to|tô|sou|faço|faco|trabalho|moro|curto|odeio|acho|prefiro)|meu |minha |tô aqui|to aqui)\b/i.test(t)
      n++; chars += t.length
      if (veio) respondeu++
      if (rico) comConteudo++
      if (perg) comPergunta++
      if (subs) comSubstancia++
      if (perg && subs) ambos++
    }
  }
  if (!n) return null
  const pct = (x) => +(x / n * 100).toFixed(1)
  return { autor, n, taxaResposta: pct(respondeu), respostaComConteudo: pct(comConteudo),
    perguntou: pct(comPergunta), contouAlgoSeu: pct(comSubstancia), fezOsDois: pct(ambos), tamanhoMedio: Math.round(chars / n) }
}

// A comparação da semana. Devolve os dois lados e a leitura pronta — número sem leitura é
// número que ninguém olha duas vezes.
export function semana({ dias = 7 } = {}) {
  const desde = Date.now() - dias * 86400000
  const ia = medir({ autor: 'ia', desde })
  const humano = medir({ autor: 'humano', desde })
  const alertas = []
  if (ia) {
    if (ia.perguntou < 30) alertas.push(`a IA perguntou em só ${ia.perguntou}% das mensagens; confira se a conversa está ficando fechada demais`)
    if (ia.fezOsDois < 10) alertas.push(`só ${ia.fezOsDois}% das mensagens dela contaram algo e deixaram gancho`)
    if (ia.contouAlgoSeu > 25 && ia.fezOsDois < ia.contouAlgoSeu / 2) alertas.push('ela está contando coisas sem deixar espaço para a outra pessoa responder')
    if (humano && ia.respostaComConteudo < humano.respostaComConteudo - 10) alertas.push(`as pessoas respondem com conteúdo ${ia.respostaComConteudo}% das vezes pra IA e ${humano.respostaComConteudo}% pra você — ela está rendendo menos que você`)
  }
  return { periodoDias: dias, ia, humano, alertas }
}

export function comoTexto(r = semana()) {
  if (!r.ia) return 'MONITOR DA IA: sem mensagens da IA no período.'
  const l = (x) => x ? `n=${x.n}  resposta ${x.taxaResposta}%  com conteúdo ${x.respostaComConteudo}%  perguntou ${x.perguntou}%  contou algo seu ${x.contouAlgoSeu}%  fez os dois ${x.fezOsDois}%  ${x.tamanhoMedio} chars` : '(sem amostra)'
  return [
    `MONITOR DA IA — últimos ${r.periodoDias} dias`,
    `  IA:   ${l(r.ia)}`,
    `  VOCÊ: ${l(r.humano)}`,
    ...(r.alertas.length ? ['  o que dá pra melhorar:', ...r.alertas.map((a) => `   - ${a}`)] : ['  nada fora do esperado']),
  ].join('\n')
}

// O tick semanal. Só fala quando há o que dizer — relatório que chega toda semana sem
// novidade é relatório que se aprende a ignorar, e aí o importante passa junto.
const CHAVE = 'monitor_voz_ultimo'
export async function tick({ avisar, getSetting, setSetting, agora = Date.now() } = {}) {
  const ultimo = Number(getSetting(CHAVE, 0)) || 0
  if (agora - ultimo < 7 * 86400000) return { pulou: 'ainda não fez uma semana' }
  const r = semana()
  setSetting(CHAVE, agora)
  if (!r.ia) return { pulou: 'sem amostra da IA' }
  logEvent({ type: 'monitor_voz', detail: JSON.stringify({ ia: r.ia, humano: r.humano, alertas: r.alertas.length }) })
  if (!r.alertas.length) return { ok: true, calado: true, relatorio: r }
  if (avisar) await avisar(comoTexto(r))
  return { ok: true, avisou: true, relatorio: r }
}
