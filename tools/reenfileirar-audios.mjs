#!/usr/bin/env node
// Devolve pra fila os áudios que falharam por FALTA DE MÁQUINA, não por serem ruins.
//
// POR QUE EXISTE: a fila de transcrição só pega `status:'pending'` (pendingAudioMessages, em
// src/core/db.mjs). Um áudio marcado 'error' está queimado pra sempre. Em 01/08/2026 o fork
// tinha subido sem o venv do whisper e 54 áudios ao vivo levaram
// `spawn /opt/vendas-multicanal/whisper-venv/bin/python ENOENT` — falha da VM, não do áudio. Instalar o
// whisper depois NÃO os traria de volta: alguém tem que desmarcar.
//
// O código novo (src/index.mjs) já não comete mais esse erro — mantém 'pending' e avisa. Esta
// ferramenta é pra dívida ANTIGA, e é idempotente: rodar duas vezes não faz mal.
//
// Uso (na VM, dentro de /opt/vendas-multicanal/app):
//   node tools/reenfileirar-audios.mjs            # mostra o que faria, não escreve
//   node tools/reenfileirar-audios.mjs --aplicar  # escreve
import { db } from '../src/core/db.mjs'
import { falhaDeInfraestrutura } from '../src/wa/media.mjs'

const aplicar = process.argv.includes('--aplicar')

const linhas = db().prepare(`SELECT message_id, person_id, media_json FROM message
  WHERE media_json LIKE '%"kind":"audio"%' AND media_json LIKE '%"status":"error"%'
  ORDER BY ts DESC`).all()

let infra = 0, conteudo = 0, ilegivel = 0
const motivos = new Map()
const alvos = []
for (const l of linhas) {
  let m
  try { m = JSON.parse(l.media_json) } catch { ilegivel++; continue }
  const erro = m && m.error ? String(m.error) : ''
  if (falhaDeInfraestrutura(erro)) {
    infra++
    motivos.set(erro.slice(0, 60), (motivos.get(erro.slice(0, 60)) || 0) + 1)
    alvos.push({ id: l.message_id, media: m })
  } else conteudo++
}

console.log(`áudios marcados 'error': ${linhas.length}`)
console.log(`  falha de MÁQUINA (reenfileirar): ${infra}`)
console.log(`  falha do ÁUDIO (fica como está): ${conteudo}`)
if (ilegivel) console.log(`  media_json ilegível (não mexo): ${ilegivel}`)
for (const [motivo, n] of [...motivos].sort((a, b) => b[1] - a[1])) console.log(`    ${n}x  ${motivo}`)

if (!infra) { console.log('\nnada a fazer.'); process.exit(0) }
if (!aplicar) { console.log('\nsimulação — rode com --aplicar pra escrever.'); process.exit(0) }

// Volta pra 'pending' e APAGA o `error` antigo: deixar o texto do erro lá faria a próxima
// leitura pensar que a falha ainda vale.
const up = db().prepare(`UPDATE message SET media_json=? WHERE message_id=?`)
const tx = db().transaction((lista) => {
  for (const a of lista) {
    const novo = { ...a.media, status: 'pending' }
    delete novo.error
    up.run(JSON.stringify(novo), a.id)
  }
})
tx(alvos)
console.log(`\n${infra} áudios de volta na fila. A fila roda a cada 12s, 3 por vez —`)
console.log(`acompanhe com: sudo journalctl -u vendas-multicanal-core -f | grep -i audio`)
