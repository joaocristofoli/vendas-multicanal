#!/usr/bin/env node
// Importa uma PASTA de fotos pro banco de fotos que a IA sabe usar.
//
// A DESCRIÇÃO VEM DO NOME DO ARQUIVO, de propósito: é o jeito de a dona escrever o que a foto
// mostra sem precisar de tela nenhuma — ela renomeia o arquivo e pronto. "foto no espelho do
// quarto, pronta pra ir trabalhar.jpeg" vira exatamente essa descrição, que é o ÚNICO texto
// que a IA lê pra decidir quando usar aquela foto (a foto não tem transcrição como o áudio).
//
// DEDUPE POR CONTEÚDO, não por nome. Na primeira pasta importada havia o mesmo arquivo com
// dois nomes diferentes. Entrando duas vezes, a trava de "nunca repete pra essa pessoa" —
// que casa por arquivo — deixaria a IA mandar a MESMA foto duas vezes.
//
// Uso (na VM, em /opt/vendas-multicanal/app):
//   node tools/importar-fotos.mjs <pasta>              # mostra o que faria, não escreve
//   node tools/importar-fotos.mjs <pasta> --aplicar
//   node tools/importar-fotos.mjs <pasta> --aplicar --travadas   # tudo entra como 'travada'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { db, insertSavedImage, getSavedImageBySha, listSavedImages } from '../src/core/db.mjs'
import { persistSavedImage, tipoDaImagem } from '../src/wa/saved-image.mjs'

const pasta = process.argv[2]
const aplicar = process.argv.includes('--aplicar')
const travadas = process.argv.includes('--travadas')

if (!pasta || !fs.existsSync(pasta)) {
  console.error('uso: node tools/importar-fotos.mjs <pasta> [--aplicar] [--travadas]')
  process.exit(1)
}

// Atalho a partir da descrição: [a-z0-9-], que é o que o marcador [foto:atalho] aceita.
//
// Palavras vazias saem fora. Sem isso, "foto no provador de uma loja" e "foto no provador de
// uma loja com roupa preta" viravam `foto-no-provador-de` e `foto-no-provador-de-2`: dois
// atalhos quase idênticos pra fotos diferentes, e a IA erraria o alvo por uma letra.
const VAZIAS = new Set(['foto', 'de', 'da', 'do', 'das', 'dos', 'uma', 'um', 'no', 'na', 'nos', 'nas', 'em', 'e', 'a', 'o', 'com', 'pra', 'para', 'meu', 'minha', 'que', 'eu'])
function atalhoDe(texto, usados) {
  const palavras = String(texto).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((w) => w && !VAZIAS.has(w))
  const base = (palavras.length ? palavras : ['foto']).slice(0, 4).join('-')
  let s = base, i = 2
  while (usados.has(s)) { s = `${base}-${i++}` }
  usados.add(s)
  return s
}
// Título curto pra tela; a descrição inteira continua sendo o que a IA lê.
const tituloDe = (d) => d.length <= 40 ? d : d.slice(0, 39).trimEnd() + '…'

db()
const usados = new Set(listSavedImages().map((f) => f.shortcut))
const arquivos = fs.readdirSync(pasta).filter((n) => !n.startsWith('.')).sort()

const entram = []
const pulados = []

for (const nome of arquivos) {
  const caminho = path.join(pasta, nome)
  if (!fs.statSync(caminho).isFile()) continue
  const buf = fs.readFileSync(caminho)
  const tipo = tipoDaImagem(buf)
  if (!tipo) { pulados.push([nome, 'não é uma imagem que eu saiba mandar']); continue }

  const sha = crypto.createHash('sha256').update(buf).digest('hex')
  const jaNoBanco = getSavedImageBySha(sha)
  if (jaNoBanco) { pulados.push([nome, `mesmo conteúdo de "${jaNoBanco.descricao || jaNoBanco.shortcut}" que já está no banco`]); continue }
  const irmao = entram.find((e) => e.sha === sha)
  if (irmao) { pulados.push([nome, `arquivo DUPLICADO de "${irmao.nome}" (mesmo conteúdo, nome diferente)`]); continue }

  // a descrição é o nome sem extensão, limpo
  const descricao = nome.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
  entram.push({ nome, caminho, buf, sha, descricao, atalho: atalhoDe(descricao, usados) })
}

console.log(`pasta: ${pasta}`)
console.log(`arquivos: ${arquivos.length} | entram: ${entram.length} | pulados: ${pulados.length}\n`)
for (const e of entram) console.log(`  [foto:${e.atalho}]  ${e.descricao}`)
if (pulados.length) {
  console.log('\n  PULADOS:')
  for (const [n, motivo] of pulados) console.log(`   - ${n}\n       ${motivo}`)
}

// Descrição fraca é avisada, não corrigida: inventar o que a foto mostra é justamente o que
// não se pode fazer — quem sabe é a dona.
const fracas = entram.filter((e) => e.descricao.split(/\s+/).length < 3)
if (fracas.length) {
  console.log('\n  ATENÇÃO — descrição curta demais pra IA escolher direito:')
  for (const f of fracas) console.log(`   - "${f.descricao}"  (renomeie o arquivo dizendo o que a foto mostra)`)
}

if (!aplicar) { console.log('\nsimulação — rode com --aplicar pra gravar.'); process.exit(0) }

let n = 0
for (const e of entram) {
  const id = crypto.randomBytes(16).toString('hex')
  const { file, sizeBytes, width, height } = await persistSavedImage(id, e.buf)
  insertSavedImage({ id, title: tituloDe(e.descricao), shortcut: e.atalho, descricao: e.descricao,
    file, width, height, sizeBytes, nivel: travadas ? 'travada' : 'livre', sha: e.sha })
  n++
}
console.log(`\n${n} foto(s) no banco, como ${travadas ? 'TRAVADAS' : 'livres'}.`)
console.log('Conferir/editar nível e descrição: painel (aba de fotos) ou tools/importar-fotos.mjs de novo.')
