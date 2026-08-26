#!/usr/bin/env node
// Compara o comportamento ATUAL com o golden set gravado. É o juiz de qualquer
// reorganização: se a banda estourar, a mudança alterou o comportamento e volta atrás.
//
//   node baseline/comparar.mjs              # regrava os cenários e compara
//   node baseline/comparar.mjs --julgar     # só re-julga o que já está em golden-novo
//   REPS=1 node baseline/comparar.mjs       # mais rápido, menos preciso
//
// O QUE DECIDE O VEREDITO (nesta ordem):
//   1. regra absoluta violada a mais que no baseline -> reprova, sem discussão;
//   2. voz no AGREGADO (todas as gerações juntas) fora da banda -> reprova;
//   3. cenário individual fora da banda -> NÃO reprova, entra na lista de "olhar".
//
// Por que o cenário individual não reprova: são 3 gerações por cenário, então uma taxa só
// pode valer 0, 0,33, 0,67 ou 1. Uma única geração diferente move 0,33 — mais que qualquer
// tolerância honesta nesse tamanho de amostra. Quem tem poder estatístico é o agregado
// O cenário serve pra LER com o olho, não pra decidir sozinho.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { dentroDaBanda, bandaPara } from './metricas.mjs'

const AQUI = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN = path.join(AQUI, 'golden')
const NOVO = path.join(AQUI, 'golden-novo')
const soJulgar = process.argv.includes('--julgar')

if (!fs.existsSync(path.join(GOLDEN, '_resumo.json'))) {
  console.error('FATAL: golden set não encontrado. Rode baseline/gravar.mjs primeiro.')
  process.exit(1)
}

if (!soJulgar) {
  fs.rmSync(NOVO, { recursive: true, force: true })
  execFileSync('node', [path.join(AQUI, 'gravar.mjs')], { stdio: 'inherit', env: { ...process.env, GOLDEN_SAIDA: NOVO } })
}
if (!fs.existsSync(path.join(NOVO, '_resumo.json'))) {
  console.error('FATAL: não há execução nova para comparar (rode sem --julgar).')
  process.exit(1)
}

const base = JSON.parse(fs.readFileSync(path.join(GOLDEN, '_resumo.json'), 'utf8'))
const novo = JSON.parse(fs.readFileSync(path.join(NOVO, '_resumo.json'), 'utf8'))

console.log('\n================ COMPARAÇÃO COM O BASELINE ================')
const baseChars = base.cenarios.reduce((a, c) => a + c.promptChars, 0)
const novoChars = novo.cenarios.reduce((a, c) => a + c.promptChars, 0)
const delta = novoChars - baseChars
const porGeracaoAntes = Math.round(baseChars / base.cenarios.length)
const porGeracaoDepois = Math.round(novoChars / novo.cenarios.length)
console.log(`\nTOKEN: ${porGeracaoAntes} -> ${porGeracaoDepois} chars por geração (${Math.round(porGeracaoAntes / 4)} -> ${Math.round(porGeracaoDepois / 4)} tokens, ${delta >= 0 ? '+' : ''}${Math.round((porGeracaoDepois - porGeracaoAntes) / 4)})`)
console.log(`       total dos ${novo.cenarios.length} prompts: ${((delta / baseChars) * 100).toFixed(1)}%`)

const veredito = dentroDaBanda(base.geral, novo.geral)
const tol = bandaPara(novo.geral.n)
console.log(`\nVOZ — agregado de ${novo.geral.n} gerações (é o que decide):`)
for (const k of ['palavrasMedia', 'bolhasMedia', 'taxaRisada', 'taxaPergunta', 'emojisMedia']) {
  const d = (novo.geral[k] - base.geral[k])
  const flag = Math.abs(d) > tol[k] ? '  FORA DA BANDA' : ''
  console.log(`  ${k.padEnd(16)} ${String(base.geral[k]).padStart(6)} -> ${String(novo.geral[k]).padStart(6)}  (tolerância ±${tol[k].toFixed(2)})${flag}`)
}

console.log('\nREGRAS ABSOLUTAS (tolerância zero):')
for (const k of ['pontoFinal', 'exclamacao', 'travessao', 'nome']) {
  const a = base.geral.violacoes?.[k] ?? 0, b = novo.geral.violacoes?.[k] ?? 0
  console.log(`  ${k.padEnd(12)} ${a} -> ${b}${b > a ? '  VIOLAÇÃO NOVA' : ''}`)
}

console.log('\nCENÁRIOS PARA OLHAR (n=3: sinal fraco, não reprova):')
let olhar = 0
for (const c of novo.cenarios) {
  const b = base.cenarios.find((x) => x.id === c.id)
  if (!b?.agregado || !c.agregado) continue
  const v = dentroDaBanda(b.agregado, c.agregado, 3)
  if (!v.ok) { olhar++; console.log(`  ${c.id} ${c.titulo}\n     ${v.problemas.join('\n     ')}`) }
}
if (!olhar) console.log('  (nenhum)')

console.log('\n================ VEREDITO ================')
if (veredito.ok) {
  console.log('PASSOU: no agregado, a voz está dentro da banda e nenhuma regra absoluta foi violada a mais.')
  if (olhar) console.log(`${olhar} cenário(s) merecem uma lida — sinal fraco com 3 gerações, não é reprovação.`)
  console.log('Falta a amostra cega com quem opera antes de considerar a mudança aprovada.')
} else {
  console.log('REPROVOU: o comportamento agregado saiu da banda.')
  for (const p of veredito.problemas) console.log('  - ' + p)
  process.exit(1)
}
