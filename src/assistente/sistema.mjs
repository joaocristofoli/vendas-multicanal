// Mão no sistema — decisão 3 do dono: "sim, mas deve pedir permissão".
// Aqui não existe caminho que execute sem uma permissão APROVADA: quem chama é o
// executor de pendências, depois do sim dele. A lista de recusa não é sobre confiar
// nele; é sobre um modelo alucinando um comando destrutivo dentro de um pedido inocente.
import { exec } from 'node:child_process'
import fs from 'node:fs/promises'
import { logEvent } from '../core/db.mjs'

const TIMEOUT_MS = 30_000
const MAX_SAIDA = 4000

// Comandos que não rodam nem com permissão: destroem o servidor ou o disco. Se ele
// quiser mesmo, roda no terminal dele — o assistente não é o caminho pra isso.
const PROIBIDOS = [
  /rm\s+-[rf]{1,2}\s+\/(\s|$)/i,
  /mkfs/i,
  /dd\s+[^|]*of=\/dev\//i,
  /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i,
  /:\(\)\s*\{.*\}\s*;\s*:/,            // fork bomb
  /chmod\s+-R\s+777\s+\//i,
  /\bmv\s+\/\s/i,
  />\s*\/dev\/(sd|nvme)/i,
]

export function comandoProibido(cmd) {
  const c = String(cmd || '')
  return PROIBIDOS.some((re) => re.test(c))
}

export function rodarComando(cmd) {
  return new Promise((resolve) => {
    if (comandoProibido(cmd)) { resolve({ ok: false, saida: 'comando recusado: destrutivo demais pra rodar por aqui' }); return }
    exec(String(cmd), { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, shell: '/bin/bash' }, (err, stdout, stderr) => {
      const saida = [String(stdout || '').trim(), String(stderr || '').trim()].filter(Boolean).join('\n').slice(0, MAX_SAIDA)
      logEvent({ type: 'assistente_comando', detail: `${cmd} -> ${err ? 'erro' : 'ok'}` })
      resolve({ ok: !err, saida: saida || (err ? String(err.message).slice(0, 300) : '(sem saída)'), codigo: err?.code ?? 0 })
    })
  })
}

export async function lerArquivo(caminho) {
  try {
    const buf = await fs.readFile(caminho, 'utf8')
    logEvent({ type: 'assistente_leu_arquivo', detail: caminho })
    return { ok: true, saida: buf.slice(0, 20000) + (buf.length > 20000 ? '\n[... cortado]' : '') }
  } catch (e) {
    return { ok: false, saida: `não deu pra ler: ${e.message}` }
  }
}
