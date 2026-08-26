#!/usr/bin/env node
// `node tools/licao.mjs <comando>` — os erros que já pagamos pra aprender.
//
//   listar            o que já sabemos que não pode voltar
//   rodar [slug]      roda as guardas (sem slug: todas). Sai != 0 se alguma reprovar.
//   ver <slug>        a história do erro
//
// A guarda de uma lição é código determinístico, sem modelo. É verificado.
import fs from 'node:fs'
import path from 'node:path'
import { listar, ler, rodar, rodarTodas } from '../src/licoes/registro.mjs'

const [cmd, slug] = process.argv.slice(2)

try {
  switch (cmd) {
    case 'ver': {
      const l = ler(slug)
      if (!l) { console.error(`não achei a lição "${slug}"`); process.exit(1) }
      console.log(JSON.stringify(l, null, 1))
      const g = path.join(l.dir, 'guarda.mjs')
      if (fs.existsSync(g)) { console.log('\n--- GUARDA ---'); console.log(fs.readFileSync(g, 'utf8')) }
      break
    }
    case 'rodar': {
      const rs = slug ? [await rodar(slug)] : await rodarTodas()
      if (!rs.length) { console.log('nenhuma lição registrada ainda'); break }
      for (const r of rs) console.log(`${r.ok ? 'ok    ' : 'REPROVOU'} ${r.slug}${r.ok ? '' : `\n         ${r.detalhe}\n         invariante: ${r.invariante || '?'}`}`)
      const ruins = rs.filter((r) => !r.ok).length
      console.log(`\n${rs.length - ruins}/${rs.length} guardas passaram`)
      process.exit(ruins ? 1 : 0)
    }
    case undefined:
    case 'listar': {
      const ls = listar()
      if (!ls.length) { console.log('nenhuma lição ainda'); break }
      for (const l of ls) {
        console.log(`${l.slug}  (${l.quando})`)
        console.log(`  aconteceu:  ${l.oQueAconteceu}`)
        console.log(`  invariante: ${l.invariante}`)
      }
      break
    }
    default:
      console.error(`comando "${cmd}" não existe. Tem: listar, ver, rodar`)
      process.exit(1)
  }
} catch (e) {
  console.error('falhou:', e.message)
  process.exit(1)
}
process.exit(0)
