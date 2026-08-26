import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { carregarEnv } from './env.mjs'

carregarEnv(path.resolve('.env'))

const endpoint = process.env.TIM_CDP_ENDPOINT || 'http://127.0.0.1:9222'
const dataDir = path.resolve(process.env.TIM_DATA_DIR || './data')
const perfil = path.join(dataDir, 'chrome-profile')
const paginas = [
  'https://tinder.com/app/recs',
  'https://badoo.com/',
  'https://www.instagram.com/direct/inbox/',
]

async function chromeAtivo() {
  try {
    const r = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1800) })
    return r.ok
  } catch { return false }
}

async function abrirAbas() {
  let abertas = []
  try {
    const r = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(2500) })
    if (r.ok) abertas = await r.json()
  } catch { /* tenta abrir mesmo sem a lista */ }
  for (const url of paginas) {
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (abertas.some((a) => { try { return new URL(a.url).hostname.replace(/^www\./, '') === host } catch { return false } })) continue
    try { await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(2500) }) } catch { /* a aba inicial já ajuda */ }
  }
}

function candidatos() {
  if (process.platform === 'darwin') return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  if (process.platform === 'win32') return [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ]
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
}

async function principal() {
  if (await chromeAtivo()) {
    await abrirAbas()
    console.log(`Chrome dedicado já está ativo em ${endpoint}. Abri as páginas das redes.`)
    return
  }

  const executavel = candidatos().find((p) => p && fs.existsSync(p))
  if (!executavel) {
    console.error('Não encontrei Google Chrome ou Chromium. Instale um deles e rode novamente.')
    process.exit(1)
  }
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error('Este Linux não tem tela gráfica. Para servidor, use o guia docs/INSTALAR-EM-SERVIDOR.md.')
    process.exit(1)
  }

  fs.mkdirSync(perfil, { recursive: true })
  const porta = new URL(endpoint).port || '9222'
  const args = [
    `--user-data-dir=${perfil}`,
    `--remote-debugging-port=${porta}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    ...paginas,
  ]
  const filho = spawn(executavel, args, { detached: true, stdio: 'ignore' })
  filho.unref()

  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (await chromeAtivo()) {
      console.log('Chrome dedicado aberto. Entre nas suas contas nas três abas e mantenha-o aberto.')
      return
    }
  }
  console.error('O Chrome abriu, mas a porta local de conexão não respondeu. Rode "npm run diagnostico".')
  process.exit(1)
}

principal().catch((erro) => {
  console.error('Não foi possível abrir o Chrome dedicado:', erro.message)
  process.exit(1)
})
