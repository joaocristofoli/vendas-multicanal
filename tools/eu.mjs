#!/usr/bin/env node
// `node tools/eu.mjs [seção]` — como a IA consulta a si mesma.
//
// Existe como CLI e não como bloco no prompt por causa de token. Auto-consciência que entra
// inteira no contexto a cada turno custa milhares de tokens por mensagem e acaba sendo
// desligada. Aqui o agente lê o índice (barato), decide o que precisa e paga só por aquilo —
// que é exatamente como um humano usa um manual.
//
// Sem argumento: crachá + índice. Com argumento: aquela seção, em JSON.
import { cracha, indice, SECOES, maquina, processo, codigo, dependencias, sessoes, mudanca, nuvem } from '../src/self/mapa.mjs'
import { comoTexto as travasTexto, inventario } from '../src/self/travas.mjs'
import { resumo as contasResumo } from '../src/ai/contas.mjs'
import { disponiveis as iaDisponiveis, comoTexto as iaTexto } from '../src/ai/ia.mjs'

const arg = (process.argv[2] || '').toLowerCase()
const json = (o) => console.log(JSON.stringify(o, null, 1))

try {
  if (!arg || arg === 'ajuda' || arg === '--help') {
    console.log(await cracha())
    console.log()
    console.log(indice())
    console.log()
    console.log('  ia — qual IA está rodando tudo (OpenAI ou Claude) e o que dá pra usar aqui')
    process.exit(0)
  }
  switch (arg) {
    case 'cracha': console.log(await cracha()); break
    case 'maquina': json(await maquina()); break
    case 'nuvem': json(await nuvem()); break
    case 'processo': json(processo()); break
    case 'codigo': json(codigo()); break
    case 'dependencias': case 'deps': json(await dependencias()); break
    case 'sessoes': json(sessoes()); break
    case 'contas': json(await contasResumo()); break
    case 'ia': case 'motores': { console.log(iaTexto()); console.log(); json(await iaDisponiveis()); break }
    case 'travas': console.log(travasTexto()); break
    case 'travas-json': json(inventario()); break
    case 'gosto': { const { comoTexto } = await import('../src/self/instagram-eu.mjs'); console.log(comoTexto()); break }
    case 'gosto-json': { const { retrato } = await import('../src/self/instagram-eu.mjs'); json(retrato()); break }
    case 'mudanca': json(await mudanca()); break
    case 'tudo':
      // O despejo completo. Existe pra depurar e pra o dono olhar — NÃO pra entrar em prompt.
      json({ cracha: await cracha(), maquina: await maquina(), processo: processo(), codigo: codigo(),
        dependencias: await dependencias(), sessoes: sessoes(), contas: await contasResumo(),
        ia: await iaDisponiveis(), travas: inventario(), mudanca: await mudanca() })
      break
    default:
      console.error(`não conheço a seção "${arg}". Tem: ${Object.keys(SECOES).join(', ')}, motores, tudo`)
      process.exit(1)
  }
} catch (e) {
  console.error('falhou:', e.message)
  process.exit(1)
}
process.exit(0)
