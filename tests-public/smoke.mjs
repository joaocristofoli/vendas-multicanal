import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const temporario = fs.mkdtempSync(path.join(os.tmpdir(), 'vendas-multicanal-publico-'))
process.env.TIM_SISTEMA = 'instancia-publica-teste'
process.env.TIM_DATA_DIR = temporario
process.env.TIM_DB_PATH = path.join(temporario, 'teste.db')

try {
  const { lerEnv } = await import('../tools/env.mjs')
  assert.deepEqual(lerEnv('A=1\nB="dois três"\nexport C=ok\n# comentário'), { A: '1', B: 'dois três', C: 'ok' })

  const pacote = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const comando of ['configurar', 'chrome', 'diagnostico', 'start']) assert.ok(pacote.scripts[comando])
  const fontePainel = fs.readFileSync(new URL('../src/panel/public/panel.js', import.meta.url), 'utf8')
  const fonteServidor = fs.readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8')
  assert.match(fontePainel, /Usar conta aberta no Chrome/)
  assert.match(fontePainel, /\/api\/canais\/importar-chrome/)
  assert.match(fonteServidor, /\/api\/canais\/importar-chrome/)
  const { importarSessaoDoChrome } = await import('../src/browser/importar-sessoes.mjs')
  await assert.rejects(() => importarSessaoDoChrome('rede-inexistente'), /canal não suportado/)

  const { CRITERIOS_PADRAO, validaCriterios } = await import('../src/tinder/criteria.mjs')
  assert.deepEqual(CRITERIOS_PADRAO.idade, { min: 18, max: 99 })
  assert.equal(CRITERIOS_PADRAO.regras.excluirTrans.ativa, false)
  assert.deepEqual(CRITERIOS_PADRAO.regras.excluirTrans.termos, [])
  assert.equal(validaCriterios({ idade: { min: 16, max: 120 } }).criterios.idade.min, 18)

  const genero = await import('../src/ai/genero.mjs')
  assert.match(genero.blocoGenero(), /não declarado|neutras/)

  const grana = await import('../src/ai/assunto-grana.mjs')
  assert.equal(grana.janelaAberta('p:exemplo').pode, false)
  const quente = await import('../src/ai/cadencia-quente.mjs')
  assert.equal(quente.blocoCadenciaQuente('p:exemplo'), '')

  const fonteResposta = fs.readFileSync(new URL('../src/tinder/autoreply.mjs', import.meta.url), 'utf8')
  assert.match(fonteResposta, /getSetting\('saved_audio_ai', false\)/)
  assert.match(fonteResposta, /getSetting\('saved_image_ai', false\)/)
  const fonteIniciativa = fs.readFileSync(new URL('../src/self/iniciativa.mjs', import.meta.url), 'utf8')
  assert.match(fonteIniciativa, /getSetting\('iniciativa_enabled', false\)/)

  const telefone = await import('../src/wa/phone.mjs')
  assert.equal(telefone.parseBrazilianPhone('11 99127-4058').e164, '5511991274058')
  assert.equal(telefone.parseBrazilianPhone('123.456.789-01').ok, false)

  const servicos = await import('../src/self/servicos.mjs')
  assert.equal(servicos.paraCentavos('1.200,50'), 120050)
  assert.equal(servicos.formatarBRL(15000), 'R$ 150,00')
  const tabela = servicos.salvarServicos({ itens: [{
    nome: 'Pacote de fotos de exemplo',
    tipo: 'online',
    faixas: [{ tempo: '10 fotos', valor: '150,00' }],
    entrega: { link: 'https://example.com/entrega', instrucao: 'Exemplo sintético' },
  }] })
  assert.equal(tabela.itens[0].faixas[0].centavos, 15000)

  const { db } = await import('../src/core/db.mjs')
  assert.equal(db().prepare('SELECT COUNT(*) total FROM person').get().total, 0)
  assert.equal(db().prepare('SELECT COUNT(*) total FROM message').get().total, 0)

  console.log('Smoke público aprovado: padrões neutros, telefone, preços e banco vazio.')
} finally {
  fs.rmSync(temporario, { recursive: true, force: true })
}
