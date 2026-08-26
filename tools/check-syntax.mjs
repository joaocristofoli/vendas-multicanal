import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const raiz = path.resolve(new URL('..', import.meta.url).pathname)
const ignorar = new Set(['.git', 'data', 'node_modules'])
const arquivos = []

function visitar(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignorar.has(item.name)) continue
    const destino = path.join(dir, item.name)
    if (item.isDirectory()) visitar(destino)
    else if (/\.(?:mjs|js)$/.test(item.name) && item.name !== 'lottie.min.js') arquivos.push(destino)
  }
}

visitar(raiz)
for (const arquivo of arquivos) execFileSync(process.execPath, ['--check', arquivo], { stdio: 'pipe' })
console.log(`Sintaxe aprovada em ${arquivos.length} arquivos JavaScript.`)
