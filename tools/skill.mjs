#!/usr/bin/env node
// `node tools/skill.mjs <comando>` — o que o vendas-multicanal aprendeu a fazer.
//
//   listar                       o que já sei fazer
//   ver <nome>                   detalhes de uma skill (inclui o resultado da última prova)
//   criar <nome> --oque "..." [--quando "..."]   cria o esqueleto (exige prova)
//   provar <nome>                roda a prova; é ISTO que decide se está pronta
//   provar-todas
//   rodar <nome> [args...]       executa a skill
//   apagar <nome>
import fs from 'node:fs'
import path from 'node:path'
import { listar, ler, criar, provar, provarTodas, carregar, apagar, DIR, garantirDir } from '../src/skills/registro.mjs'

const [cmd, nome, ...resto] = process.argv.slice(2)
const opt = (n) => { const i = resto.indexOf('--' + n); return i >= 0 ? resto[i + 1] : null }

// O esqueleto da prova. Escrito assim de propósito: quem for implementar tem que TROCAR o
// caso de teste por um real. Uma prova que passa sem exercitar nada é pior que nenhuma.
const PROVA_MODELO = (n) => `#!/usr/bin/env node
// PROVA da skill "${n}". Sai 0 = funciona. Qualquer outra saída = não funciona.
//
// Regra: use um caso REAL. Prova com mock passa e não prova nada — e é assim que uma missão
// termina "cumprida" com a coisa quebrada.
import { skill } from './index.mjs'

const casos = [
  // { entrada: ..., esperado: ... }
]
if (!casos.length) {
  console.error('PROVA VAZIA: escreva ao menos um caso real antes de dizer que funciona.')
  process.exit(1)
}
let falhas = 0
for (const c of casos) {
  const obtido = await skill(c.entrada)
  const ok = JSON.stringify(obtido) === JSON.stringify(c.esperado)
  console.log(\`\${ok ? 'ok  ' : 'FALHA'} \${JSON.stringify(c.entrada).slice(0, 60)}\`)
  if (!ok) { falhas++; console.log(\`      esperado: \${JSON.stringify(c.esperado)}\`); console.log(\`      obtido:   \${JSON.stringify(obtido)}\`) }
}
process.exit(falhas ? 1 : 0)
`

const CODIGO_MODELO = (n, oQue) => `// SKILL: ${n}
// ${oQue}
//
// Regra da casa: função eterna. Resolva com endpoint, binário, SQL ou Playwright — o modelo
// só entra se a tarefa for genuinamente de linguagem. Comente POR QUE é assim, não o quê.

export async function skill(entrada) {
  throw new Error('não implementado ainda')
}
`

try {
  switch (cmd) {
    case undefined:
    case 'listar': {
      const s = listar()
      if (!s.length) { console.log(`nenhuma skill ainda (elas moram em ${garantirDir()})`); break }
      for (const x of s) {
        console.log(`${x.pronta ? '[provada]' : '[NAO PROVADA]'} ${x.nome} — ${x.oQue}`)
        if (x.quando) console.log(`            usar quando: ${x.quando}`)
        if (x.ultimaProva) console.log(`            última prova: ${x.ultimaProva.ok ? 'passou' : 'FALHOU'} em ${new Date(x.ultimaProva.em).toISOString().slice(0, 16)}`)
      }
      break
    }
    case 'ver': {
      const s = ler(nome)
      if (!s) { console.error(`não achei a skill "${nome}"`); process.exit(1) }
      console.log(JSON.stringify(s, null, 1))
      const cf = path.join(s.dir, 'COMO-FUNCIONA.md')
      if (fs.existsSync(cf)) { console.log('\n--- COMO FUNCIONA ---'); console.log(fs.readFileSync(cf, 'utf8')) }
      break
    }
    case 'criar': {
      const oQue = opt('oque') || opt('o-que')
      if (!nome || !oQue) { console.error('uso: node tools/skill.mjs criar <nome> --oque "o que ela faz" [--quando "quando usar"]'); process.exit(1) }
      const s = criar({ nome, oQue, quando: opt('quando'), codigo: CODIGO_MODELO(nome, oQue), prova: PROVA_MODELO(nome) })
      console.log(`criada em ${s.dir}`)
      console.log('  index.mjs  <- implemente aqui (função eterna, não chamada de modelo)')
      console.log('  prova.mjs  <- TROQUE o caso de teste por um real; é ele que decide se está pronta')
      console.log(`\ndepois: node tools/skill.mjs provar ${s.nome}`)
      break
    }
    case 'provar': {
      if (!nome) { console.error('qual skill?'); process.exit(1) }
      const r = await provar(nome)
      console.log(r.saida || '(sem saída)')
      console.log(r.ok ? `\n${nome}: PROVADA` : `\n${nome}: NÃO PASSOU`)
      process.exit(r.ok ? 0 : 1)
    }
    case 'provar-todas': {
      const rs = await provarTodas()
      for (const r of rs) console.log(`${r.ok ? 'ok   ' : 'FALHA'} ${r.nome}`)
      process.exit(rs.every((r) => r.ok) ? 0 : 1)
    }
    case 'rodar': {
      const mod = await carregar(nome)
      const fn = mod.skill || mod.default
      if (typeof fn !== 'function') throw new Error(`a skill "${nome}" não exporta skill()`)
      const { contarUso } = await import('../src/skills/economia.mjs')
      contarUso(nome)   // uso é uso, venha da rota, do evento, do cron ou da mão
      const r = await fn(...resto)
      console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1))
      break
    }
    case 'economia': {
      const { comoTexto, relatorio } = await import('../src/skills/economia.mjs')
      console.log(comoTexto())
      console.log()
      console.log(JSON.stringify(relatorio(), null, 1))
      break
    }
    case 'gatilhos': {
      const { comoTexto, rotas } = await import('../src/skills/gatilhos.mjs')
      console.log(comoTexto())
      const rs = rotas()
      if (rs.length) { console.log('\n  Rotas no ar:'); for (const r of rs) console.log(`    ${r.metodo} ${r.caminho}  ->  ${r.skill}`) }
      break
    }
    case 'apagar':
      console.log(apagar(nome) ? `apagada: ${nome}` : `não achei "${nome}"`)
      break
    default:
      console.error(`comando "${cmd}" não existe. Tem: listar, ver, criar, provar, provar-todas, rodar, gatilhos, economia, apagar`)
      process.exit(1)
  }
} catch (e) {
  console.error('falhou:', e.message)
  process.exit(1)
}
process.exit(0)
