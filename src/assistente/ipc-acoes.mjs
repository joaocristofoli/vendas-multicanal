// Canal de RPC por arquivo entre o sandbox do Códix e o vendas-multicanal-core.
//
// Por que arquivo: o sandbox workspace-write compartilha /opt/vendas-multicanal/app com o núcleo, mas não
// compartilha rede nem loopback. A fila carrega só pedidos do catálogo fechado; nunca comando
// arbitrário. O núcleo continua sendo o único executor, então socket, registro e desfazer
// permanecem exatamente no mesmo caminho do painel.
import fs from 'node:fs'
import path from 'node:path'
import { ACOES_IPC_DIR } from '../core/caminhos.mjs'

export const IPC_ACOES_DIR = ACOES_IPC_DIR
const INTERVALO_MS = 50
const EXPIRA_MS = 10 * 60_000

function gravarAtomico(arquivo, dados) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true, mode: 0o700 })
  const tmp = `${arquivo}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(dados), { mode: 0o600 })
  fs.renameSync(tmp, arquivo)
}

function limparVelhos(dir, agora = Date.now()) {
  for (const nome of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!nome.isFile()) continue
    const arquivo = path.join(dir, nome.name)
    try {
      if (agora - fs.statSync(arquivo).mtimeMs > EXPIRA_MS) fs.unlinkSync(arquivo)
    } catch { /* outro processo terminou ou removeu enquanto limpávamos */ }
  }
}

export function iniciarIpcAcoes({ dir = IPC_ACOES_DIR, executar, aoErro = () => {} }) {
  if (typeof executar !== 'function') throw new Error('executar é obrigatório')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  let ocupado = false

  async function tick() {
    if (ocupado) return
    ocupado = true
    try {
      const nomes = fs.readdirSync(dir).filter((n) => /^req-[a-f0-9-]+\.json$/.test(n)).sort()
      for (const nome of nomes) {
        const origem = path.join(dir, nome)
        const trabalhando = origem.replace(/\.json$/, '.processando')
        try { fs.renameSync(origem, trabalhando) } catch { continue }
        const id = nome.slice(4, -5)
        const resposta = path.join(dir, `resp-${id}.json`)
        try {
          const pedido = JSON.parse(fs.readFileSync(trabalhando, 'utf8'))
          if (pedido?.versao !== 1 || pedido?.id !== id || !pedido?.corpo) throw new Error('pedido IPC inválido')
          const r = await executar(pedido.corpo)
          gravarAtomico(resposta, r)
        } catch (e) {
          gravarAtomico(resposta, { ok: false, status: 500, dados: { tipo: 'erro', texto: e.message } })
          aoErro(e)
        } finally {
          try { fs.unlinkSync(trabalhando) } catch {}
        }
      }
      limparVelhos(dir)
    } catch (e) { aoErro(e) }
    finally { ocupado = false }
  }

  const timer = setInterval(() => void tick(), INTERVALO_MS)
  if (timer.unref) timer.unref()
  void tick()
  return { parar: () => clearInterval(timer), tick }
}
