#!/usr/bin/env node
// `node tools/missao.mjs <comando>` — objetivos que só terminam quando a prova passa.
//
//   nova "<objetivo>" [--skill <nome>] [--prova "<comando>"] [--voltas 6]
//   listar
//   ver <id>
//   volta <id>        roda UMA volta agora (o tick do núcleo faz isso sozinho)
//   cancelar <id>
//
// A missão vive no banco e é retomada pelo tick do vendas-multicanal-core, então ela sobrevive a deploy e
// a restart — inclusive aos deploys que o próprio agente faz pra testar o que escreveu.
import { criar, listar, pegar, cancelar, umaVolta, rodarProva } from '../src/skills/missao.mjs'

const [cmd, arg, ...resto] = process.argv.slice(2)
const opt = (n) => { const i = resto.indexOf('--' + n); return i >= 0 ? resto[i + 1] : null }
const fmt = (m) => `${m.id}  [${m.estado}]  ${m.voltas}/${m.max_voltas} voltas  ${m.objetivo}`

try {
  switch (cmd) {
    case 'nova': {
      if (!arg) { console.error('uso: node tools/missao.mjs nova "<objetivo>" [--skill <nome>] [--prova "<comando>"]'); process.exit(1) }
      const m = criar({ objetivo: arg, skill: opt('skill'), provaCmd: opt('prova'), maxVoltas: Number(opt('voltas') || 6) })
      console.log(fmt(m))
      if (!m.skill && !m.prova_cmd) console.log('\n(sem prova definida: a primeira coisa do agente é criar a skill e a prova dela)')
      console.log('\nO tick do vendas-multicanal-core toca a missão sozinho. Pra forçar uma volta agora:')
      console.log(`  node tools/missao.mjs volta ${m.id}`)
      break
    }
    case undefined:
    case 'listar':
      for (const m of listar()) console.log(fmt(m))
      break
    case 'ver': {
      const m = pegar(arg)
      if (!m) { console.error('não achei essa missão'); process.exit(1) }
      console.log(fmt(m))
      console.log(`prova: ${m.skill ? `skill ${m.skill}` : m.prova_cmd || '(indefinida)'}`)
      console.log('\n--- última saída ---')
      console.log(m.ultima_saida || '(nada ainda)')
      break
    }
    case 'prova': {
      const m = pegar(arg)
      if (!m) { console.error('não achei essa missão'); process.exit(1) }
      const r = await rodarProva(m)
      console.log(r.saida || '(sem saída)')
      console.log(r.ok ? '\nPASSOU' : '\nNÃO PASSOU')
      process.exit(r.ok ? 0 : 1)
    }
    case 'volta': {
      const m = await umaVolta(arg)
      console.log(fmt(m))
      console.log('\n--- última saída ---')
      console.log(String(m.ultima_saida || '').slice(-2000))
      break
    }
    case 'cancelar':
      console.log(fmt(cancelar(arg)))
      break
    default:
      console.error(`comando "${cmd}" não existe. Tem: nova, listar, ver, prova, volta, cancelar`)
      process.exit(1)
  }
} catch (e) {
  console.error('falhou:', e.message)
  process.exit(1)
}
process.exit(0)
