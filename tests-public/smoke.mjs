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
  assert.ok(db().prepare('PRAGMA table_info(saved_image)').all().some((c) => c.name === 'duration_sec'))

  // VÍDEO NO BANCO DE FOTOS (07/10/2026). A foto HEIC do iPhone usa a mesma caixa 'ftyp' do
  // MP4: se a assinatura não separar as duas, a foto vira um "vídeo" de um quadro.
  const midia = await import('../src/wa/saved-image.mjs')
  const caixa = (marca) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp' + marca), Buffer.alloc(16)])
  assert.equal(midia.pareceVideo(caixa('isom')), true)
  assert.equal(midia.pareceVideo(caixa('qt  ')), true)
  assert.equal(midia.pareceVideo(caixa('heic')), false)
  assert.equal(midia.pareceVideo(Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.alloc(16)])), true)
  assert.equal(midia.tipoDaMidiaSalva('abc.mp4'), 'video')
  assert.equal(midia.tipoDaMidiaSalva('abc.jpg'), 'image')
  assert.equal(midia.capaDoVideo('abc.mp4'), 'abc-capa.jpg')
  // Celular grava deitado e marca a rotação: a medida que vale é a de quem assiste.
  const sondado = midia.lerSondagem(`  Duration: 00:01:02.40, start: 0.000000, bitrate: 9000 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 8000 kb/s, 30 fps
      Side data:
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s`)
  assert.deepEqual(sondado, { video: { codec: 'hevc', pixfmt: 'yuv420p', width: 1080, height: 1920 }, audio: { codec: 'aac' }, durationSec: 62 })
  await assert.rejects(() => midia.persistSavedImage('x', Buffer.from('não é mídia nenhuma')), /nem vídeo/)

  // O WhatsApp recebe vídeo como `video`, com mimetype de MP4 — não como foto.
  fs.mkdirSync(midia.SAVED_IMAGE_DIR, { recursive: true })
  fs.writeFileSync(midia.savedImagePath('teste.mp4'), caixa('isom'))
  const enviados = []
  const sock = { sendPresenceUpdate: async () => {}, sendMessage: async (jid, conteudo) => { enviados.push(conteudo); return { key: { id: 'x' } } } }
  await midia.sendSavedImage(sock, '0@s.whatsapp.net', { file: 'teste.mp4', duration_sec: 12, width: 720, height: 1280 })
  assert.equal(enviados[0].mimetype, 'video/mp4')
  assert.ok(Buffer.isBuffer(enviados[0].video) && !enviados[0].image)
  assert.equal(enviados[0].seconds, 12)

  // A IA vê o vídeo marcado, e só nos canais que mandam vídeo.
  const listaIa = await import('../src/wa/saved-image-ai.mjs')
  assert.match(listaIa.buildSavedImagesPrompt([{ active: 1, nivel: 'livre', shortcut: 'praia', descricao: 'na praia', file: 'a.mp4', duration_sec: 9 }]), /\[foto:praia\] \(vídeo de 9 s\): na praia/)
  assert.ok(listaIa.CANAIS_SEM_VIDEO.has('instagram') && listaIa.CANAIS_SEM_VIDEO.has('badoo') && !listaIa.CANAIS_SEM_VIDEO.has('whatsapp'))

  console.log('Smoke público aprovado: padrões neutros, telefone, preços, banco vazio e vídeo no banco de fotos.')
} finally {
  fs.rmSync(temporario, { recursive: true, force: true })
}
