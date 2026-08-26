// Modos de conversa (camada aditiva do "sobre mim v2"): cada modo é um .md curto
// que descreve como o dono conversa com AQUELE tipo de pessoa (paquera, romance,
// amigo, negócio, cívico). Ver docs/SOBRE-MIM-V2-ANALISE-E-PROPOSTA.md.
// Sem modo (null) => nada é carregado e o prompt fica IDÊNTICO ao comportamento
// anterior. Opt-in por conversa, escolhido pelo dono no painel.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODOS_DIR as MODOS_DIR_PADRAO } from '../core/caminhos.mjs'

const MODOS_DIR = MODOS_DIR_PADRAO
// fallback pro repo local (dev no Mac)
const LOCAL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'sobre-mim-modos')

export const VALID_MODES = ['romance-paquera', 'romance-quente', 'amigo', 'negocio', 'civico']

const cache = new Map() // mode -> { text, at }
const TTL = 60_000 // relê do disco no máximo 1x/min (permite editar o .md sem reiniciar)

// Texto do módulo de um modo, ou null (modo inválido/ausente => comportamento antigo).
export async function readMode(mode) {
  if (!mode || !VALID_MODES.includes(mode)) return null
  const hit = cache.get(mode)
  if (hit && Date.now() - hit.at < TTL) return hit.text
  for (const dir of [MODOS_DIR, LOCAL_DIR]) {
    try {
      const text = (await readFile(path.join(dir, mode + '.md'), 'utf8')).trim().slice(0, 4000)
      if (text) { cache.set(mode, { text, at: Date.now() }); return text }
    } catch { /* tenta o próximo diretório */ }
  }
  cache.set(mode, { text: null, at: Date.now() })
  return null
}
