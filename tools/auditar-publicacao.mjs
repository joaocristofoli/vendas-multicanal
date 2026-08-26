#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ignorarPastas = new Set(['.git', 'node_modules', 'data', 'coverage'])
const ignorarConteudo = new Set(['src/panel/public/lottie.min.js'])
const extensoesPrivadas = /\.(?:db|sqlite3?|har|pem|p12|pfx|jpe?g|png|webp|heic|gif|mp4|mov|m4a|mp3|ogg|wav|opus)$/i

const problemas = []

function relativo(p) {
  return path.relative(raiz, p).split(path.sep).join('/')
}

function andar(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory() && ignorarPastas.has(item.name)) continue
    const absoluto = path.join(dir, item.name)
    if (item.isDirectory()) andar(absoluto)
    else verificarArquivo(absoluto)
  }
}

function linhaDo(texto, indice) {
  return texto.slice(0, indice).split('\n').length
}

function registrar(arquivo, texto, indice, motivo) {
  problemas.push(`${relativo(arquivo)}:${linhaDo(texto, indice)}: ${motivo}`)
}

function ipPublico(ip) {
  const n = ip.split('.').map(Number)
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false
  if (n[0] === 10 || n[0] === 127 || n[0] === 0) return false
  if (n[0] === 169 && n[1] === 254) return false
  if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return false
  if (n[0] === 192 && n[1] === 168) return false
  if (n[0] === 192 && n[1] === 0 && n[2] === 2) return false
  if (n[0] === 198 && n[1] === 51 && n[2] === 100) return false
  if (n[0] === 203 && n[1] === 0 && n[2] === 113) return false
  return true
}

function verificarArquivo(arquivo) {
  const rel = relativo(arquivo)
  if (extensoesPrivadas.test(rel)) {
    problemas.push(`${rel}: arquivo de mídia, banco, captura ou chave não pode ser versionado`)
    return
  }
  if (ignorarConteudo.has(rel)) return

  const buffer = fs.readFileSync(arquivo)
  if (buffer.includes(0) || buffer.length > 2_000_000) return
  const texto = buffer.toString('utf8')

  const regras = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'chave privada'],
    [/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, 'token do GitHub'],
    [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, 'chave da OpenAI'],
    [/\bAKIA[0-9A-Z]{16}\b/g, 'chave da AWS'],
    [/\b1\/\/[A-Za-z0-9_-]{20,}\b/g, 'refresh token OAuth'],
    [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'JWT literal'],
    [/[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b|s\.whatsapp\.net\b|g\.us\b|broadcast\b|newsletter\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'e-mail que não usa domínio de exemplo'],
    [/\/(?:Users|home)\/(?!appuser\b|\.\.\.|exemplo\b)[A-Za-z0-9._-]+/g, 'caminho de usuário local'],
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, 'UUID literal; use fixture evidentemente fictícia'],
  ]

  for (const [regex, motivo] of regras) {
    for (const achado of texto.matchAll(regex)) registrar(arquivo, texto, achado.index, motivo)
  }

  for (const achado of texto.matchAll(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g)) {
    const linha = texto.slice(texto.lastIndexOf('\n', achado.index) + 1, texto.indexOf('\n', achado.index) < 0 ? texto.length : texto.indexOf('\n', achado.index))
    const pareceVersaoOuSvg = /Mozilla\//.test(linha) || /<path\b/.test(linha) || /\b(?:app-version|app_version|version)\b/i.test(linha)
    if (!pareceVersaoOuSvg && ipPublico(achado[0])) registrar(arquivo, texto, achado.index, `IPv4 público literal (${achado[0]})`)
  }

  for (const achado of texto.matchAll(/^([A-Z][A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY))=(.+)$/gm)) {
    const valor = achado[2].trim()
    if (valor && !valor.startsWith('$') && !/(troque|exemplo|placeholder|changeme)/i.test(valor)) {
      registrar(arquivo, texto, achado.index, `${achado[1]} contém valor literal`)
    }
  }
}

if (fs.existsSync(path.join(raiz, 'data'))) {
  const itens = fs.readdirSync(path.join(raiz, 'data'))
  if (itens.length) problemas.push('data/: a pasta privada deve ficar fora da publicação')
}

andar(raiz)

if (problemas.length) {
  console.error('Auditoria pública reprovada:')
  for (const problema of problemas) console.error(`- ${problema}`)
  process.exit(1)
}

console.log('Auditoria pública aprovada: sem mídia, banco, credencial ou identificador privado não autorizado; atribuição pública do mantenedor preservada.')
