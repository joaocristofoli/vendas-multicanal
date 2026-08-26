// Biblioteca de figurinhas LOTTIE (as "de efeito grande"): lista as que já capturamos pra o
// o dono mandar qualquer uma pelo painel. Cada Lottie é um ZIP (animation/animation.json + token);
// dá pra reenviar do zero porque o trust_token da Meta viaja dentro (ver docs/FIGURINHAS.md).
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { MEDIA_DIR as MEDIA_DIR_PADRAO } from '../core/caminhos.mjs'

const MEDIA_DIR = MEDIA_DIR_PADRAO

// Extrai UMA entrada de um ZIP (buffer) pela via da central directory (tamanhos confiáveis,
// diferente do local header que às vezes vem zerado). Devolve Buffer ou null.
export function extrairDoZip(buf, alvo) {
  if (!buf || buf.length < 22) return null
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break } }
  if (eocd < 0) return null
  const cdCount = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let k = 0; k < cdCount; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    if (name === alvo) {
      const lhNameLen = buf.readUInt16LE(localOff + 26)
      const lhExtraLen = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + lhNameLen + lhExtraLen
      const comp = buf.subarray(dataStart, dataStart + compSize)
      try { return method === 8 ? zlib.inflateRawSync(comp) : Buffer.from(comp) } catch { return null }
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return null
}

// É um ZIP (Lottie)? (magia PK\x03\x04)
function ehZip(buf) { return buf && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04 }

// Nome amigável a partir do nm interno ("WA_Flump_02_CryLaugh_Core_Lottie_v01" -> "CryLaugh").
function nomeAmigavel(nm) {
  if (!nm) return 'Figurinha'
  const m = /_([A-Za-z][A-Za-z0-9]*)_Core/.exec(nm)
  if (m) return m[1].replace(/([a-z])([A-Z])/g, '$1 $2') // CryLaugh -> Cry Laugh
  return String(nm).replace(/^WA_/, '').replace(/_(Core|Lottie|v\d+)/g, '').replace(/_/g, ' ').trim() || 'Figurinha'
}

// Lê o animation.json de um ZIP e devolve o nm (nome do pack). null se não der.
export function nomeDaLottie(zipBuffer) {
  const aj = extrairDoZip(zipBuffer, 'animation/animation.json')
  if (!aj) return null
  try { return JSON.parse(aj.toString('utf8')).nm || null } catch { return null }
}

// Lista as Lotties capturadas, deduplicadas por conteúdo. [{ file, nome, bytes }].
export function listarLotties() {
  let arquivos = []
  try { arquivos = fs.readdirSync(MEDIA_DIR).filter((f) => f.endsWith('.webp')) } catch { return [] }
  const vistos = new Set()
  const out = []
  for (const f of arquivos) {
    try {
      const buf = fs.readFileSync(path.join(MEDIA_DIR, f))
      if (!ehZip(buf)) continue
      const hash = crypto.createHash('md5').update(buf).digest('hex')
      if (vistos.has(hash)) continue // dedup por conteúdo
      vistos.add(hash)
      out.push({ file: f, nome: nomeAmigavel(nomeDaLottie(buf)), bytes: buf.length })
    } catch { /* arquivo ruim, ignora */ }
  }
  return out.sort((a, b) => a.nome.localeCompare(b.nome))
}
