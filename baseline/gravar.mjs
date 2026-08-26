#!/usr/bin/env node
// Grava o golden set: para cada cenário, o PROMPT exato que o sistema monta hoje e N
// gerações reais da IA. NÃO ENVIA NADA — só chama o mesmo caminho de geração de rascunho.
//
// Rode na VM (é lá que estão o Codex logado, os perfis do runtime e o banco):
//   node baseline/gravar.mjs                 # todos os cenários x 3 gerações
//   REPS=1 CENARIOS=A1,C2 node baseline/gravar.mjs   # subconjunto, pra teste rápido
//
// A montagem do prompt abaixo espelha generateDraft (src/tinder/autoreply.mjs) linha a
// linha; a única diferença é que o histórico vem do cenário em vez do banco.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CENARIOS, materializar } from './cenarios.mjs'
import { metricas, agregar } from './metricas.mjs'
import { buildReplyPrompt, parseGeneratedReply } from '../src/ai/prompt.mjs'
import { getCodex, readCommunicationProfile } from '../src/ai/codex.mjs'
import { readMode } from '../src/ai/modos.mjs'
import { getSetting, listSavedAudios } from '../src/core/db.mjs'
import { buildSavedAudiosPrompt } from '../src/wa/saved-audio-ai.mjs'
import { ensureAgendaFresh, agendaBlock } from '../src/agenda/context.mjs'
import { projectsBlock } from '../src/projects/context.mjs'

const AQUI = path.dirname(fileURLToPath(import.meta.url))
const SAIDA = process.env.GOLDEN_SAIDA || path.join(AQUI, 'golden')
const REPS = Number(process.env.REPS || 3)
const FILTRO = (process.env.CENARIOS || '').split(',').map((s) => s.trim()).filter(Boolean)

fs.mkdirSync(SAIDA, { recursive: true })

const cp = await readCommunicationProfile()
if (!cp.available) { console.error('FATAL: perfis do sobre-mim não encontrados (rode na VM).'); process.exit(1) }

// Contexto vivo (agenda/projetos) entra igual à produção. Ele muda com o tempo — por isso o
// prompt inteiro fica gravado no golden: comparação futura confere o que mudou de fato.
let agendaContext = ''
if (getSetting('agenda_awareness', true)) { await ensureAgendaFresh(); agendaContext = agendaBlock() }
const projectsContext = projectsBlock()

const codex = getCodex()
const agora = Date.now()
const resumo = []
const alvos = CENARIOS.filter((c) => !FILTRO.length || FILTRO.includes(c.id))
console.log(`golden set: ${alvos.length} cenários x ${REPS} gerações\n`)

for (const cru of alvos) {
  const c = materializar(cru, agora)
  const canal = c.canal === 'whatsapp' ? 'whatsapp' : 'tinder'
  const modeProfile = await readMode(c.modo)
  let savedAudios = ''
  if (canal === 'whatsapp' && getSetting('saved_audio_ai', true)) {
    savedAudios = buildSavedAudiosPrompt(listSavedAudios({ activeOnly: true }))
  }
  const prompt = buildReplyPrompt({
    record: { id: `golden:${c.id}`, name: c.pessoa },
    history: c.history,
    profile: c.perfil || null,
    communicationProfile: cp.text,
    mode: c.mode || (c.history.messages.length ? 'reply' : 'opener'),
    channel: canal,
    conversationId: `golden:${c.id}`,
    accountKey: 'golden',
    modeProfile, agendaContext, projectsContext,
    personObjective: '', savedAudios,
  })

  const geracoes = []
  for (let i = 0; i < REPS; i++) {
    let texto = null, erro = null
    for (let tentativa = 0; tentativa < 2 && texto === null; tentativa++) {
      try {
        const gen = await codex.generateReply({ prompt })
        texto = parseGeneratedReply(gen.reply, { personName: c.pessoa })
      } catch (e) { erro = e.message; await new Promise((r) => setTimeout(r, 3000)) }
    }
    if (texto === null) { console.log(`  ${c.id}#${i + 1} FALHOU: ${erro}`); continue }
    geracoes.push({ texto, metricas: metricas(texto, { pessoa: c.pessoa }) })
    console.log(`  ${c.id}#${i + 1} ${JSON.stringify(texto).slice(0, 110)}`)
  }

  const registro = {
    id: c.id, eixo: c.eixo, titulo: c.titulo, espera: c.espera, canal, pessoa: c.pessoa,
    gravadoEm: new Date(agora).toISOString(),
    promptChars: prompt.length,
    prompt,
    geracoes,
    agregado: agregar(geracoes.map((g) => g.metricas)),
  }
  fs.writeFileSync(path.join(SAIDA, `${c.id}.json`), JSON.stringify(registro, null, 2))
  resumo.push({ id: c.id, eixo: c.eixo, titulo: c.titulo, espera: c.espera, promptChars: prompt.length, agregado: registro.agregado, textos: geracoes.map((g) => g.texto) })
  console.log('')
}

const todas = resumo.flatMap((r) => r.textos.map((t, i) => metricas(t, { pessoa: '' })))
const geral = agregar(todas)
fs.writeFileSync(path.join(SAIDA, '_resumo.json'), JSON.stringify({ gravadoEm: new Date(agora).toISOString(), reps: REPS, geral, cenarios: resumo }, null, 2))
console.log('\n=== agregado geral ===')
console.log(JSON.stringify(geral, null, 2))
console.log(`\ngolden gravado em ${SAIDA}`)
codex.close()
process.exit(0)
