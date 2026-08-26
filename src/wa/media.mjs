// Transcrição de áudio local (offline) via faster-whisper, rodado num venv separado.
// O áudio nunca sai da VM. Subprocess por chamada (carrega o modelo ~5s); se o volume
// crescer, dá pra trocar por um daemon que mantém o modelo quente.
//
// DUAS FALHAS QUE NÃO SÃO A MESMA COISA. "não entendi esse áudio" é sobre o ÁUDIO e acaba
// nele. "o transcritor não está instalado" é sobre a MÁQUINA e vale pra todos os áudios que
// vierem. Em 01/08/2026 o fork subiu sem o venv do whisper e as duas falhas eram a mesma:
// 54 áudios ao vivo receberam `status:'error'` por `spawn .../whisper-venv/bin/python ENOENT`
// — e a fila só reprocessa `status:'pending'`, então os 54 ficariam mudos PRA SEMPRE, mesmo
// depois de instalar o whisper. Quem separa as duas é `falhaDeInfraestrutura`.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WHISPER_PY } from '../core/caminhos.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VENV_PY = WHISPER_PY
const SCRIPT = process.env.TIM_TRANSCRIBE || path.join(__dirname, '..', '..', 'tools', 'transcribe.py')

// O transcritor em si está quebrado/ausente? (≠ "esse áudio não deu pra entender")
//
// A lista é de sintomas de MÁQUINA, não de conteúdo: o binário do venv não existe (ENOENT),
// não dá pra executar (EACCES/EPERM), o venv existe mas a lib não foi instalada
// (ModuleNotFoundError), ou o modelo não está em disco e não deu pra baixar.
//
// O que NÃO entra aqui, de propósito: `timeout`. Um áudio de 40 minutos estoura os 180s sem
// que a máquina tenha nada de errado — tratar timeout como infra faria a fila retentar pra
// sempre o mesmo arquivo gigante e nunca chegar nos outros.
export function falhaDeInfraestrutura(erro) {
  const e = String(erro || '')
  if (!e) return false
  return /ENOENT|EACCES|EPERM|ENOTDIR/.test(e)
    || /ModuleNotFoundError|No module named/i.test(e)
    || /command not found|não encontrado|not found/i.test(e)
    || /spawn .* failed/i.test(e)
    || /(Unable to (open|load)|could not download|Repository Not Found|HTTPError).*(model|whisper)/i.test(e)
}

// Transcreve um arquivo de áudio. Resolve { text, duration, language } ou { error }.
// Nunca rejeita — erro vira { error }.
export function transcribeAudio(filePath) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let p
    try {
      p = spawn(VENV_PY, [SCRIPT, filePath])
    } catch (e) {
      return finish({ error: e && e.message ? e.message : 'spawn falhou' })
    }
    const killer = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* já morreu */ } finish({ error: 'timeout' }) }, 180000)
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => { clearTimeout(killer); finish({ error: e && e.message ? e.message : 'erro' }) })
    p.on('close', () => {
      clearTimeout(killer)
      try {
        const line = out.trim().split('\n').filter(Boolean).pop()
        finish(JSON.parse(line))
      } catch {
        finish({ error: (err || 'saída inválida').slice(0, 200) })
      }
    })
  })
}
