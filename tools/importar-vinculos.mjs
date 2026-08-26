#!/usr/bin/env node
// Importa um CSV privado de vínculos para a tabela
// pessoa_vinculo, canonicalizando os ids (uma pessoa unida entre canais = uma linha).
// Idempotente: rodar de novo atualiza, não duplica. O CSV nunca deve entrar no Git.
import fs from 'node:fs'
import path from 'node:path'
import { db } from '../src/core/db.mjs'
import { pessoaCanonica } from '../src/self/identidade.mjs'
import { salvarVinculo, contagemVinculos } from '../src/self/vinculos.mjs'

const CSV = process.argv[2] ? path.resolve(process.argv[2]) : null
if (!CSV) {
  console.error('uso: node tools/importar-vinculos.mjs /caminho/privado/vinculos.csv')
  process.exit(1)
}

// Parser CSV mínimo e correto (campos com vírgula e aspas duplas escapadas "").
function parseCsv(texto) {
  const linhas = []
  let campo = '', linha = [], aspas = false
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++ }
      else if (c === '"') aspas = false
      else campo += c
    } else if (c === '"') aspas = true
    else if (c === ',') { linha.push(campo); campo = '' }
    else if (c === '\n') { linha.push(campo); campo = ''; if (linha.some((x) => x !== '')) linhas.push(linha); linha = [] }
    else if (c !== '\r') campo += c
  }
  if (campo !== '' || linha.length) { linha.push(campo); if (linha.some((x) => x !== '')) linhas.push(linha) }
  const cab = linhas[0]
  return linhas.slice(1).map((l) => Object.fromEntries(cab.map((h, i) => [h, l[i] ?? ''])))
}

const rows = parseCsv(fs.readFileSync(CSV, 'utf8'))
console.log(`${rows.length} pessoas no CSV`)

let importadas = 0, mescladas = 0
const porCanonico = new Map()
// CSV está ordenado por volume (idx): a primeira ocorrência de uma pessoa canônica é a de
// maior conversa — ela define o vínculo principal; as outras entram como extras.
for (const r of rows) {
  const canonico = pessoaCanonica(r.person_id)
  if (!porCanonico.has(canonico)) {
    porCanonico.set(canonico, r)
    continue
  }
  // mesma pessoa, outro canal: mescla extras/camadas, MANTÉM o ia_pode mais restritivo
  const base = porCanonico.get(canonico)
  const extras = new Set([...(base.vinculos_extras || '').split('|'), r.vinculo, ...(r.vinculos_extras || '').split('|')].map((s) => s.trim()).filter(Boolean))
  extras.delete(base.vinculo)
  base.vinculos_extras = [...extras].join('|')
  const camadas = new Set([...(base.camadas || '').split('|'), ...(r.camadas || '').split('|')].map((s) => s.trim()).filter(Boolean))
  base.camadas = [...camadas].join('|')
  const ordem = { nao: 3, cuidado: 2, sim: 1 }
  if ((ordem[r.ia_pode_escrever] || 2) > (ordem[base.ia_pode_escrever] || 2)) base.ia_pode_escrever = r.ia_pode_escrever
  mescladas++
}

for (const [canonico, r] of porCanonico) {
  salvarVinculo({
    personId: canonico,
    vinculo: r.vinculo,
    extras: r.vinculos_extras || '',
    camadas: r.camadas || '',
    iaPode: r.ia_pode_escrever,
    evidencia: (r.evidencia || '').slice(0, 300),
    origem: 'importacao-csv',
  })
  importadas++
}

console.log(`importadas: ${importadas} pessoas canônicas (${mescladas} eram a mesma pessoa em outro canal)`)
console.log('por vínculo:', JSON.stringify(contagemVinculos()))
const gate = db().prepare(`SELECT ia_pode, COUNT(*) n FROM pessoa_vinculo GROUP BY ia_pode`).all()
console.log('gate:', gate.map((g) => `${g.ia_pode}=${g.n}`).join(' · '))
