import fs from 'node:fs'
import path from 'node:path'

function tirarAspas(valor) {
  const v = String(valor ?? '').trim()
  if (v.length < 2) return v
  const abre = v[0], fecha = v[v.length - 1]
  if ((abre === '"' && fecha === '"') || (abre === "'" && fecha === "'")) {
    const miolo = v.slice(1, -1)
    return abre === '"'
      ? miolo.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : miolo
  }
  return v
}

export function lerEnv(texto) {
  const saida = {}
  for (const linhaCrua of String(texto || '').split(/\r?\n/)) {
    const linha = linhaCrua.trim()
    if (!linha || linha.startsWith('#')) continue
    const limpa = linha.startsWith('export ') ? linha.slice(7).trim() : linha
    const i = limpa.indexOf('=')
    if (i < 1) continue
    const chave = limpa.slice(0, i).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(chave)) continue
    saida[chave] = tirarAspas(limpa.slice(i + 1))
  }
  return saida
}

export function carregarEnv(arquivo = path.resolve('.env'), { sobrescrever = false } = {}) {
  if (!fs.existsSync(arquivo)) return { arquivo, existe: false, carregadas: [] }
  const valores = lerEnv(fs.readFileSync(arquivo, 'utf8'))
  const carregadas = []
  for (const [chave, valor] of Object.entries(valores)) {
    if (!sobrescrever && process.env[chave] != null) continue
    process.env[chave] = valor
    carregadas.push(chave)
  }
  return { arquivo, existe: true, carregadas }
}
