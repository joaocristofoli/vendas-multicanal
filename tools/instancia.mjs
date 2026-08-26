#!/usr/bin/env node
// Olha a INSTÂNCIA VIVA — a VM — nunca o checkout do Mac.
//
//   node tools/instancia.mjs instancia-b
//   node tools/instancia.mjs instancia-b --ls src/necessidades
//   node tools/instancia.mjs instancia-b --cmd 'ls /opt/instancia-b/data/sobre-mim'
//
// Passar `~/instancia-b` ou `/Users/.../instancia-b` é o erro de 15/08/2026: o comando recusa.
// Guarda: `licoes/checkout-local-nao-e-a-instancia`.
import { spawnSync } from 'node:child_process'
import { instanciaViva, sshDaInstancia } from '../src/core/instancias.mjs'

const args = process.argv.slice(2)
const ajuda = () => {
  console.log(`uso: node tools/instancia.mjs <nome> [--ls <caminho-no-app>] [--cmd "<comando>"]
  O nome é instancia-b, não ~/instancia-b. A instância viva é a VM.`)
}

if (!args.length || args[0] === '-h' || args[0] === '--help') {
  ajuda()
  process.exit(args.length ? 0 : 1)
}

let inst
try { inst = instanciaViva(args[0]) }
catch (e) {
  console.error(e.message)
  process.exit(1)
}

const lsEm = args.indexOf('--ls')
const cmdEm = args.indexOf('--cmd')

function ssh(comando) {
  const r = spawnSync('gcloud', [
    'compute', 'ssh', inst.vm,
    `--project=${inst.project}`,
    `--zone=${inst.zone}`,
    '--command', comando,
  ], { encoding: 'utf8' })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  process.exit(r.status ?? 1)
}

if (lsEm >= 0) {
  const rel = args[lsEm + 1]
  if (!rel) { console.error('falta o caminho depois de --ls'); process.exit(1) }
  if (/^[~/]/.test(rel) || rel.includes('..')) {
    console.error('o caminho do --ls é relativo ao app da VM (src/necessidades), não um caminho do Mac')
    process.exit(1)
  }
  ssh(`ls -la ${inst.app}/${rel}`)
}

if (cmdEm >= 0) {
  const cmd = args[cmdEm + 1]
  if (!cmd) { console.error('falta o comando depois de --cmd'); process.exit(1) }
  ssh(cmd)
}

console.log(JSON.stringify(inst, null, 2))
console.log(sshDaInstancia(args[0]))
