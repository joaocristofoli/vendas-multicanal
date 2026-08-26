import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { carregarEnv } from './env.mjs'

const env = carregarEnv(path.resolve('.env'))
const resultados = []
const item = (nivel, nome, detalhe) => resultados.push({ nivel, nome, detalhe })
const existeComando = (cmd, args = ['--version']) => {
  try { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 }).status === 0 } catch { return false }
}

const nodeMajor = Number(process.versions.node.split('.')[0])
item(nodeMajor >= 22 ? 'ok' : 'erro', 'Node.js', `${process.versions.node}${nodeMajor >= 22 ? '' : ' — precisa ser 22 ou superior'}`)
item(env.existe ? 'ok' : 'erro', '.env', env.existe ? 'encontrado e carregado' : 'ausente — rode npm run configurar')

const senha = process.env.TIM_PANEL_PASSWORD || ''
item(senha.length >= 12 && !/troque-por/i.test(senha) ? 'ok' : 'erro', 'Senha do painel', senha ? 'configurada' : 'ausente')
const segredo = process.env.TIM_PANEL_SECRET || ''
item(segredo.length >= 32 && !/troque-por/i.test(segredo) ? 'ok' : 'erro', 'Segredo do painel', segredo ? 'configurado' : 'ausente')

const dataDir = path.resolve(process.env.TIM_DATA_DIR || './data')
const sobreMim = path.join(dataDir, 'sobre-mim')
item(fs.existsSync(dataDir) ? 'ok' : 'erro', 'Pasta de dados', fs.existsSync(dataDir) ? dataDir : `${dataDir} não existe`)
item(fs.existsSync(path.join(sobreMim, 'dono.json')) ? 'ok' : 'aviso', 'Identidade privada', fs.existsSync(path.join(sobreMim, 'dono.json')) ? 'modelo instalado' : 'rode npm run configurar')
item(fs.existsSync(path.resolve('node_modules/better-sqlite3')) ? 'ok' : 'erro', 'Dependências Node', fs.existsSync(path.resolve('node_modules/better-sqlite3')) ? 'instaladas' : 'rode npm ci')
item(existeComando(process.env.TIM_FFMPEG || 'ffmpeg', ['-version']) ? 'ok' : 'aviso', 'FFmpeg', 'necessário para áudio, vídeo e figurinhas')
item(existeComando(process.env.TIM_CODEX_BINARY || 'codex') ? 'ok' : 'aviso', 'Codex CLI', 'necessário somente para gerar texto com IA')

const endpoint = process.env.TIM_CDP_ENDPOINT || 'http://127.0.0.1:9222'
try {
  const r = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) })
  item(r.ok ? 'ok' : 'erro', 'Chrome dedicado', r.ok ? `conectado em ${endpoint}` : `respondeu HTTP ${r.status}`)
} catch {
  item('aviso', 'Chrome dedicado', `não está ativo — rode npm run chrome`)
}

const painel = `http://${process.env.TIM_PANEL_HOST || '127.0.0.1'}:${process.env.TIM_PANEL_PORT || '8080'}`
try {
  const r = await fetch(painel, { redirect: 'manual', signal: AbortSignal.timeout(1800) })
  item(r.status > 0 ? 'ok' : 'aviso', 'Painel', `respondendo em ${painel}`)
} catch {
  item('aviso', 'Painel', `não está ativo — depois da configuração, rode npm start`)
}

const simbolo = { ok: '✓', aviso: '!', erro: '✗' }
console.log('\nDiagnóstico do Vendas Multicanal\n')
for (const r of resultados) console.log(`${simbolo[r.nivel]} ${r.nome}: ${r.detalhe}`)
const erros = resultados.filter((r) => r.nivel === 'erro').length
const avisos = resultados.filter((r) => r.nivel === 'aviso').length
console.log(`\n${erros ? `${erros} erro(s)` : 'nenhum erro'} · ${avisos ? `${avisos} aviso(s)` : 'nenhum aviso'}`)
if (erros) process.exitCode = 1
