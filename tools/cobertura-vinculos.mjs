#!/usr/bin/env node
// Confere se todo vínculo do catálogo tem como ser renderizado: ou tem módulo próprio,
// ou é romântico (usa o manual completo). Vínculo sem nenhum dos dois cai no estilo
// integral sem registro — funciona, mas perde o vocabulário certo daquela relação.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATALOGO, VINCULOS_ROMANTICOS } from '../src/self/vinculos.mjs'

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const arquivos = new Set(fs.readdirSync(path.join(RAIZ, 'sobre-mim-vinculos')).map((f) => f.replace('.md', '')))
const sem = CATALOGO.filter((c) => !arquivos.has(c.valor) && !VINCULOS_ROMANTICOS.has(c.valor))
console.log(`catálogo: ${CATALOGO.length} vínculos`)
console.log(`  com módulo próprio: ${arquivos.size} (${[...arquivos].sort().join(', ')})`)
console.log(`  românticos (manual completo): ${[...VINCULOS_ROMANTICOS].join(', ')}`)
console.log(`  SEM cobertura: ${sem.map((c) => c.valor).join(', ') || 'nenhum'}`)
process.exit(sem.length ? 1 : 0)
