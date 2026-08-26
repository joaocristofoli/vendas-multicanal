import path from 'node:path'
import { carregarEnv } from './env.mjs'

const env = carregarEnv(path.resolve('.env'))
if (!env.existe) {
  console.error('Configuração ausente: rode "npm run configurar" antes de iniciar.')
  process.exit(1)
}

if (!process.env.TIM_PANEL_PASSWORD || /troque-por/i.test(process.env.TIM_PANEL_PASSWORD)) {
  console.error('Senha do painel não configurada: rode "npm run configurar".')
  process.exit(1)
}

await import('../src/index.mjs')
