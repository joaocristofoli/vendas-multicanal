#!/usr/bin/env node
// `node tools/ig-reconciliar.mjs [--aplicar]`
//
// A troca do DOM pela API deixa a MESMA mensagem gravada duas vezes: o DOM a escreveu com um id
// posicional (`ig:<thread>:<idx>:<ts>`) e a API com o id real do Instagram (`ig:<item_id>`).
// Sem reconciliar, a thread aparece duplicada na tela.
//
// A API vence — ela tem hora certa, direção certa e não inventa citação. Mas há UMA coisa que
// só o DOM tinha: a TRANSCRIÇÃO dos áudios (ele clicava em "View transcription" e o texto da
// Meta virava mensagem). A API entrega `[áudio]`. Então antes de apagar, a transcrição é
// TRANSPLANTADA para a linha da API — senão a IA ficaria surda no histórico recente.
//
// Só apaga do DOM o que está DENTRO da janela que a API cobriu. Histórico mais antigo que a
// API não puxou continua intacto: apagar ali seria perder conversa de verdade.
//
// Sem --aplicar, só mostra o que faria.
import { db } from '../src/core/db.mjs'

const APLICAR = process.argv.includes('--aplicar')
const ehDoDom = (id) => (String(id).match(/:/g) || []).length >= 3
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const MARCADOR_MIDIA = /^\[(áudio|audio|imagem|vídeo|video|gif|respondeu um story)\]$/i
const JANELA_CASAMENTO_MS = 4000

let totalApagar = 0
let totalTranscricoes = 0
const porConversa = []

for (const chat of db().prepare(`SELECT thread_id, username FROM ig_chat WHERE api_thread_id IS NOT NULL`).all()) {
  const pid = 'ig:' + chat.thread_id
  const todas = db().prepare(`SELECT message_id, direction, text, ts FROM message WHERE person_id=? AND channel='instagram' ORDER BY ts ASC`).all(pid)
  const daApi = todas.filter((m) => !ehDoDom(m.message_id))
  if (!daApi.length) continue
  const desde = daApi[0].ts
  const doDom = todas.filter((m) => ehDoDom(m.message_id) && m.ts >= desde - JANELA_CASAMENTO_MS)
  if (!doDom.length) continue

  // REGRA DE SEGURANÇA: só morre a linha do DOM que a API COMPROVADAMENTE tem. "Está dentro da
  // janela de tempo" NÃO basta — o inbox traz as últimas ~20 mensagens, e numa conversa antiga
  // essas 20 podem cobrir um ano inteiro. Apagar tudo na janela jogaria fora dezenas de
  // mensagens reais que a API não trouxe (visto em @contato.exemplo1: 48 do DOM contra 20 da API).
  const disponiveis = daApi.map((m) => ({ ...m, usada: false }))
  const casar = (d, exigirTextoIgual) => disponiveis.find((a) => !a.usada
    && a.direction === d.direction
    && Math.abs(a.ts - d.ts) <= (exigirTextoIgual ? 6 * 60 * 60 * 1000 : JANELA_CASAMENTO_MS)
    && (exigirTextoIgual ? norm(a.text) === norm(d.text) : MARCADOR_MIDIA.test(norm(a.text))))

  const transplantes = []
  const paraApagar = []
  // 1ª passada: texto idêntico = é a mesma mensagem, a do DOM some.
  for (const d of doDom) {
    const a = casar(d, true)
    if (a) { a.usada = true; paraApagar.push(d) }
  }
  // 2ª passada: a API diz mídia e o DOM tinha texto no mesmo instante — aquele texto é a
  // TRANSCRIÇÃO do áudio (o DOM clicava em "View transcription"). Transplanta e só então apaga.
  for (const d of doDom) {
    if (paraApagar.includes(d)) continue
    if (!norm(d.text) || MARCADOR_MIDIA.test(norm(d.text))) continue
    const a = casar(d, false)
    if (!a) continue
    a.usada = true
    transplantes.push({ para: a.message_id, texto: d.text })
    paraApagar.push(d)
  }
  const doDomNaJanela = paraApagar

  porConversa.push({ user: chat.username, apagar: doDomNaJanela.length, total: doDom.length, transplantes: transplantes.length, desde })
  totalApagar += doDomNaJanela.length
  totalTranscricoes += transplantes.length

  if (!APLICAR) continue
  const tx = db().transaction(() => {
    for (const t of transplantes) db().prepare(`UPDATE message SET text=? WHERE message_id=?`).run(t.texto, t.para)
    for (const m of doDomNaJanela) db().prepare(`DELETE FROM message WHERE message_id=? AND person_id=?`).run(m.message_id, pid)
  })
  tx()
}

const dia = (ms) => new Date(ms).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
for (const c of porConversa.sort((a, b) => b.apagar - a.apagar).slice(0, 12)) {
  console.log(` @${String(c.user).padEnd(20)} apaga ${String(c.apagar).padStart(4)} de ${String(c.total).padStart(4)} do DOM${c.transplantes ? `, salva ${c.transplantes} transcrição(ões)` : ''}`)
}
console.log(`\n${porConversa.length} conversas | ${totalApagar} linhas do DOM ${APLICAR ? 'APAGADAS' : 'a apagar'} | ${totalTranscricoes} transcrições ${APLICAR ? 'transplantadas' : 'a transplantar'}`)
if (!APLICAR) console.log('\n(nada foi alterado — repita com --aplicar)')
