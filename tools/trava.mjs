#!/usr/bin/env node
// `node tools/trava.mjs <o quê> [valor]` — levanta e baixa qualquer trava do sistema.
//
// A contraparte executável do inventário (src/self/travas.mjs). O inventário diz o que
// existe e por quê; este arquivo é a chave na fechadura. Separados de propósito: saber e
// poder são coisas diferentes, e o agente precisa das duas.
//
//   node tools/trava.mjs                          -> lista tudo, com estado
//   node tools/trava.mjs assistente on|off
//   node tools/trava.mjs disjuntor zerar
//   node tools/trava.mjs setting <chave> <true|false>
//   node tools/trava.mjs ia <pessoa> <canal> on|off
//   node tools/trava.mjs ia openai|claude   -> troca QUAL IA roda tudo
//   node tools/trava.mjs conta <nome>             -> troca a conta de LLM ativa
//   node tools/trava.mjs failover on|off [limite%]
import { setAiSetting, getAiSetting, setSetting, getSetting, logEvent } from '../src/core/db.mjs'
import { comoTexto, mexer } from '../src/self/travas.mjs'
import { acharPessoa } from '../src/assistente/acoes.mjs'
import { definirProvedor, provedorAtivo, disponiveis, comoTexto as iaTexto, PROVEDORES } from '../src/ai/ia.mjs'
import { trocar, ligarAuto, resumo as contasResumo } from '../src/ai/contas.mjs'

const [o, a, b, c] = process.argv.slice(2)
const liga = (v) => v === 'on' || v === 'true' || v === '1' || v === 'ligar'

try {
  if (!o) { console.log(comoTexto()); process.exit(0) }

  switch (o) {
    case 'assistente': {
      const v = liga(a)
      setSetting('assistente_enabled', v)
      logEvent({ type: v ? 'assistente_ligado' : 'assistente_desligado', detail: 'por tools/trava.mjs' })
      console.log(`assistente: ${v ? 'LIGADO' : 'desligado'}`)
      break
    }
    case 'disjuntor': {
      const r = mexer('disjuntor', true)
      console.log(`disjuntor zerado (${r.apagadas} resposta(s) recentes apagadas da janela de 60s)`)
      break
    }
    case 'setting': {
      if (!a) throw new Error('qual chave?')
      if (b === undefined) { console.log(`${a} = ${JSON.stringify(getSetting(a, null))}`); break }
      const v = b === 'true' || b === 'false' ? b === 'true' : b
      setSetting(a, v)
      console.log(`${a} = ${JSON.stringify(v)}`)
      break
    }
    case 'ia': {
      if (!a || !b) throw new Error('uso: ia <pessoa> <canal> on|off')
      const p = acharPessoa('main', a)
      if (!p) throw new Error(`não achei "${a}"`)
      const v = liga(c)
      setAiSetting({ personId: p.personId, channel: b, enabled: v })
      console.log(`IA de conversa em ${p.name || p.personId} (${b}): ${v ? 'LIGADA' : 'desligada'}`)
      console.log(`conferindo: ${JSON.stringify(getAiSetting(p.personId, b))}`)
      break
    }
    case 'ia': {
      if (!a) { console.log(iaTexto()); console.log(); console.log(JSON.stringify(await disponiveis(), null, 1)); break }
      const alvo = a === 'openai' || a === 'codex' ? 'codex' : a === 'claude' || a === 'anthropic' ? 'claude' : a
      const d = await disponiveis()
      if (alvo === 'claude' && !d.claude.pronto) throw new Error(`não dá: ${d.claude.falta}`)
      const r = definirProvedor(alvo)
      console.log(`IA: ${r.de} -> ${r.para} (${PROVEDORES[r.para].nome}, ${PROVEDORES[r.para].conta})`)
      console.log('vale pra TUDO: clone, assistente, extratores e modo códex.')
      if (alvo === 'claude') console.log('imagem continua indo pelo Codex (o Claude não recebe imagem por este caminho).')
      if (alvo !== 'codex') {
        console.log('')
        console.log('ANTES DE DEIXAR ASSIM EM PRODUÇÃO: isto inclui o CLONE, que escreve pras pessoas')
        console.log('com o nome de quem opera. Rode  node baseline/comparar.mjs  (24 cenários, 72 gerações).')
        console.log('Critério e o que fazer com o resultado: docs/PENDENCIAS.md §0')
      }
      break
    }
    case 'conta': {
      if (!a) { console.log(JSON.stringify(await contasResumo(), null, 1)); break }
      console.log(JSON.stringify(trocar(a), null, 1))
      break
    }
    case 'failover': {
      const r = ligarAuto(liga(a), b)
      console.log(`troca automática de conta: ${r.auto ? `LIGADA (a partir de ${r.limitePct}%)` : 'desligada'}`)
      break
    }
    default:
      console.error(`não sei mexer em "${o}". Rode sem argumento pra ver o inventário.`)
      process.exit(1)
  }
} catch (e) {
  console.error('falhou:', e.message)
  process.exit(1)
}
process.exit(0)
