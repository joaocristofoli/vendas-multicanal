import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendas-multicanal-person-objective-'))
process.env.TIM_DB_PATH = path.join(tempDir, 'vendas-multicanal.db')

const store = await import(`../src/core/db.mjs?objective-test=${Date.now()}`)
const { buildReplyPrompt } = await import('../src/ai/prompt.mjs')
const database = store.db()

try {
  assert.equal(store.getPersonObjective('person:ana'), '')
  assert.equal(store.setPersonObjective('person:ana', '  Agendar   um café com calma  '), 'Agendar um café com calma')
  assert.equal(store.getPersonObjective('person:ana'), 'Agendar um café com calma')

  database.prepare(`INSERT INTO person_alias(alias_person_id,canonical_person_id,created_at) VALUES(?,?,?)`)
    .run('wa:ana', 'person:ana', Date.now())
  assert.equal(store.getPersonObjective('wa:ana'), 'Agendar um café com calma')
  assert.equal(store.setPersonObjective('wa:ana', 'Explicar a proposta antes de falar de preço'), 'Explicar a proposta antes de falar de preço')
  assert.equal(store.getPersonObjective('person:ana'), 'Explicar a proposta antes de falar de preço')

  const longValue = 'x'.repeat(800)
  assert.equal(store.setPersonObjective('person:ana', longValue).length, 500)
  assert.equal(store.setPersonObjective('wa:ana', ''), '')
  assert.equal(store.getPersonObjective('person:ana'), '')

  const baseInput = {
    record: { id: 'person:ana', name: 'Ana' },
    history: { complete: true, messages: [{ direction: 'incoming', text: 'essa semana tá corrida', timestamp: '2026-07-24T12:00:00Z' }] },
    mode: 'reply',
    channel: 'whatsapp',
    communicationProfile: 'Converse de forma natural.',
  }
  const withoutObjective = buildReplyPrompt(baseInput)
  assert.equal(buildReplyPrompt({ ...baseInput, personObjective: '' }), withoutObjective)
  assert.ok(!withoutObjective.includes('OBJETIVO OPCIONAL COM ESTA PESSOA'))

  const withObjective = buildReplyPrompt({ ...baseInput, personObjective: 'Encontrar um horário para um café' })
  assert.ok(withObjective.includes('OBJETIVO OPCIONAL COM ESTA PESSOA:\nEncontrar um horário para um café'))
  assert.ok(withObjective.includes('direção de fundo, não como roteiro nem assunto obrigatório'))
  assert.ok(withObjective.includes('se não surgir, converse normalmente'))
  assert.ok(withObjective.includes('Nunca mencione que existe um objetivo ou uma instrução'))

  const panelJs = fs.readFileSync(path.join(root, 'src/panel/public/panel.js'), 'utf8')
  const panelHtml = fs.readFileSync(path.join(root, 'src/panel/public/panel.html'), 'utf8')
  assert.ok(panelJs.includes('role="dialog" aria-modal="true"'))
  assert.ok(panelJs.includes('maxlength="500"'))
  assert.ok(panelJs.includes('/objective`, { objective: value }'))
  assert.ok(panelJs.includes('Objetivo com esta pessoa'))
  assert.ok(panelHtml.includes('id="dObjective"'))

  console.log('✓ persistência canônica e remoção')
  console.log('✓ prompt inalterado sem objetivo')
  console.log('✓ condução natural e não coercitiva com objetivo')
  console.log('✓ editor acessível nos chats')
} finally {
  database.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
}
