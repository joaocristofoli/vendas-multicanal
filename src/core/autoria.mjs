// QUEM ESCREVEU: reconstrução retroativa da autoria das mensagens que saíram.
//
// A coluna `message.author` nasceu em 26/07/2026 e daí pra frente todo caminho de envio a
// carimba na hora. O histórico anterior não tem carimbo — mas não está perdido: cada envio
// deixou um EVENTO no diário (`event`), com hora, pessoa, canal e o texto que saiu. Este
// módulo casa evento com mensagem e devolve a autoria ao que já estava no banco.
//
// Regras de casamento (severas de propósito — carimbo errado é pior que nenhum):
//   - só mexe em linha `outgoing` que ainda está SEM autoria;
//   - a mensagem tem que ser da MESMA pessoa e do MESMO canal do evento;
//   - a hora tem que cair na janela do envio (a IA escreve em bolhas e o "digitando"
//     humano leva até ~30s por bolha, então a janela olha pra trás, não pra frente);
//   - o texto da mensagem tem que estar CONTIDO no texto do evento (o evento guarda o
//     rascunho inteiro; a mensagem é uma bolha dele).
//
// Idempotente: rodar duas vezes não muda nada, porque só toca em author IS NULL.
import { db } from './db.mjs'

// Evento -> quem escreveu. O que não está aqui não vira carimbo (não chutamos).
const EVENTOS = {
  auto_sent: 'ia',            // auto-resposta (WhatsApp, Tinder)
  auto_sent_audio: 'ia',      // áudio salvo escolhido pela IA
  ig_sent: 'ia',              // auto-resposta do Instagram
  iniciativa_enviada: 'ia',   // a IA puxou assunto, ele aprovou o texto dela
  assistente_enviou: 'ia',    // o assistente redigiu e mandou depois do sim dele
  manual_sent: 'humano',        // ele digitou no painel
  manual_sent_audio: 'humano',  // ele escolheu o áudio
  ig_sent_novo: 'humano',       // conversa nova aberta por ele
  badoo_enviado: 'humano',      // envio manual do Badoo (não existe auto-resposta lá ainda)
}

// Quanto tempo antes do evento a bolha pode ter sido gravada. A IA grava cada bolha assim
// que manda e só loga `auto_sent` no fim da entrega: com 3 bolhas e "digitando" proporcional
// ao texto, o começo fica uns 40s atrás. 5 min cobre com folga sem alcançar outro envio.
const JANELA_ANTES_MS = 5 * 60 * 1000
const JANELA_DEPOIS_MS = 30 * 1000

const norm = (s) => String(s || '').trim().toLowerCase()

// Casa um evento com as mensagens que ele produziu. Exportada pra ser testável sozinha.
export function mensagensDoEvento(ev) {
  if (!ev || !ev.person_id || !ev.channel) return []
  const linhas = db().prepare(`SELECT rowid, text, media_json FROM message
    WHERE person_id=? AND channel=? AND direction='outgoing' AND author IS NULL
      AND ts BETWEEN ? AND ?`)
    .all(ev.person_id, ev.channel, ev.ts - JANELA_ANTES_MS, ev.ts + JANELA_DEPOIS_MS)
  const detalhe = norm(ev.detail)
  if (!detalhe) return []
  return linhas.filter((l) => {
    const t = norm(l.text)
    // bolha de áudio não tem texto: casa pelo evento de áudio, que é da própria pessoa
    // e da própria janela — não há outra mensagem sem texto competindo por ela.
    if (!t) return /audio/i.test(ev.type) && !!l.media_json
    return detalhe.includes(t)
  }).map((l) => l.rowid)
}

// ---------------------------------------------------------------- antes da IA existir
// Canais que só existiram DENTRO deste banco: a integração nasceu junto com o vendas-multicanal, então
// qualquer mensagem enviada antes do primeiro envio da IA naquele canal é necessariamente
// do dono — a IA não existia pra tê-la escrito. Isso é dedução, não chute.
//
// O Tinder fica de fora de propósito: houve um auto-respondedor legado antes deste banco
// (o projeto começou como contador de respostas do Tinder), então "antes do primeiro
// auto_sent" ali NÃO prova que foi ele. Na dúvida, a mensagem continua sem carimbo.
const CANAIS_NASCIDOS_AQUI = ['whatsapp', 'instagram', 'badoo']

export function marcarAnterioresAIa() {
  const marcar = db().prepare(`UPDATE message SET author='humano'
    WHERE channel=? AND direction='outgoing' AND author IS NULL AND ts < ?`)
  let humano = 0
  const detalhe = []
  for (const canal of CANAIS_NASCIDOS_AQUI) {
    // o primeiro envio da IA NAQUELE canal é a fronteira
    const primeiro = db().prepare(`SELECT MIN(ts) t FROM event
      WHERE channel=? AND type IN ('auto_sent','auto_sent_audio','ig_sent','iniciativa_enviada','assistente_enviou')`).get(canal)?.t
    // sem nenhum envio de IA no canal, não há fronteira provada: não marca nada
    if (!primeiro) continue
    const n = marcar.run(canal, primeiro).changes
    if (n) { humano += n; detalhe.push(`${canal}: ${n}`) }
  }
  return { humano, detalhe }
}

// Passa o diário inteiro e devolve o que carimbou, por autoria.
// `desde` limita a varredura (padrão: tudo).
export function reconstruirAutoria({ desde = 0 } = {}) {
  const tipos = Object.keys(EVENTOS)
  const evs = db().prepare(`SELECT ts, type, person_id, channel, detail FROM event
    WHERE type IN (${tipos.map(() => '?').join(',')}) AND ts >= ? AND person_id IS NOT NULL
    ORDER BY ts ASC`).all(...tipos, desde)
  const marcar = db().prepare(`UPDATE message SET author=? WHERE rowid=? AND author IS NULL`)
  let ia = 0, humano = 0
  const tx = db().transaction(() => {
    for (const ev of evs) {
      const autor = EVENTOS[ev.type]
      for (const rowid of mensagensDoEvento(ev)) {
        if (marcar.run(autor, rowid).changes) { if (autor === 'ia') ia++; else humano++ }
      }
    }
  })
  tx()
  // Depois do casamento por evento (que é o caminho preciso), a dedução do "antes da IA
  // existir" cobre o histórico importado do celular. Nesta ordem: o evento manda.
  const antes = marcarAnterioresAIa()
  return { eventos: evs.length, ia, humano, anterioresAIa: antes.humano, detalhe: antes.detalhe }
}

// Quanto do histórico já tem resposta pra "quem escreveu isso".
export function coberturaAutoria() {
  const r = db().prepare(`SELECT COUNT(*) total,
      SUM(author='ia') ia, SUM(author='humano') humano, SUM(author IS NULL) sem
    FROM message WHERE direction='outgoing'`).get()
  return { total: r.total || 0, ia: r.ia || 0, humano: r.humano || 0, semCarimbo: r.sem || 0 }
}
