import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(root, 'data')
const dbPath = path.join(dataDir, 'demo.db')
const reset = process.argv.includes('--reset')

process.chdir(root)
fs.mkdirSync(dataDir, { recursive: true })

if (reset) {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = dbPath + suffix
    if (path.dirname(target) !== dataDir || !path.basename(target).startsWith('demo.db')) throw new Error('alvo de reset inválido')
    if (fs.existsSync(target)) fs.rmSync(target)
  }
}

Object.assign(process.env, {
  TIM_DEMO_MODE: '1',
  TIM_SISTEMA: 'vendas-multicanal-demo',
  TIM_APP_DIR: root,
  TIM_DATA_DIR: dataDir,
  TIM_DB_PATH: dbPath,
  TIM_MEDIA_DIR: path.join(dataDir, 'wa-media'),
  TIM_WA_AUTH_DIR: path.join(dataDir, 'wa-auth'),
  TIM_SAVED_IMAGE_DIR: path.join(dataDir, 'wa-saved-image'),
  TIM_SAVED_AUDIO_DIR: path.join(dataDir, 'wa-saved-audio'),
  TIM_VIDEO_DIR: path.join(dataDir, 'videos'),
  TIM_PANEL_HOST: process.env.TIM_PANEL_HOST || '127.0.0.1',
  TIM_PANEL_PORT: process.env.TIM_PANEL_PORT || '8099',
  TIM_PANEL_PASSWORD: process.env.TIM_PANEL_PASSWORD || 'demo2026',
  TIM_PANEL_SECRET: process.env.TIM_PANEL_SECRET || 'somente-demonstracao-local-nao-usar-em-producao',
  TIM_ACCOUNT_KEY: 'demo',
  TIM_LOOP_MS: '2147483647',
  TIM_IG_SYNC_MS: '2147483647',
  TIM_IG_INBOX_MS: '2147483647',
  TIM_IG_MEDIA_MS: '2147483647',
  TIM_IG_AUDIO_MS: '2147483647',
  TIM_BADOO_SYNC_MS: '2147483647',
  TIM_BADOO_SWIPE_MS: '2147483647',
  TIM_BADOO_ENCONTROS_MS: '2147483647',
  TIM_WA_IMAGE_MS: '2147483647',
  TIM_FAXINA_MS: '2147483647',
  TIM_COTA_TICK_MS: '2147483647',
  TIM_SAUDE_TICK_MS: '2147483647',
  TIM_TG_TICK_MS: '2147483647',
  TIM_MP_TICK_MS: '2147483647',
  TIM_MONITOR_VOZ_MS: '2147483647',
  TIM_AGENDA_MS: '2147483647',
  TIM_REMINDER_MS: '2147483647',
  TIM_MISSAO_TICK_MS: '2147483647',
  TIM_SKILL_CRON_MS: '2147483647',
  TIM_WA_LID_MS: '2147483647',
  TIM_CHAMAR_MS: '0',
  TIM_RESOLVE_MS: '0',
  TIM_INICIATIVA_MS: '0',
  TIM_AVATAR_MS: '0',
  TIM_MEMORIA_MS: '0',
  TIM_WA_BACKFILL_MS: '0',
})

const { prepararDemo } = await import('../src/demo/seed.mjs')
const result = prepararDemo()
console.log(`[demo] base ${result.seeded ? 'criada' : 'carregada'} · versão ${result.version} · somente localhost`)
console.log(`[demo] login: http://${process.env.TIM_PANEL_HOST}:${process.env.TIM_PANEL_PORT} · senha: ${process.env.TIM_PANEL_PASSWORD}`)

await import('../src/index.mjs')

