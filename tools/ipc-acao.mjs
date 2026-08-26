// Lado do Códix no RPC por arquivo. Não executa ação nenhuma: só entrega um pedido fechado
// ao vendas-multicanal-core e espera o comprovante escrito por ele.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { IPC_ACOES_DIR } from '../src/assistente/ipc-acoes.mjs'

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function gravarAtomico(arquivo, dados) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true, mode: 0o700 })
  const tmp = `${arquivo}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(dados), { mode: 0o600 })
  fs.renameSync(tmp, arquivo)
}

export async function pedirAcaoPorArquivo(corpo, { dir = IPC_ACOES_DIR, timeoutMs = 120_000 } = {}) {
  const id = crypto.randomUUID()
  const req = path.join(dir, `req-${id}.json`)
  const resp = path.join(dir, `resp-${id}.json`)
  gravarAtomico(req, { versao: 1, id, criadoEm: Date.now(), corpo })

  const limite = Date.now() + timeoutMs
  while (Date.now() < limite) {
    if (fs.existsSync(resp)) {
      try {
        const r = JSON.parse(fs.readFileSync(resp, 'utf8'))
        fs.unlinkSync(resp)
        return r
      } catch (e) {
        throw new Error(`resposta IPC inválida: ${e.message}`)
      }
    }
    await esperar(50)
  }
  // O pedido fica na fila: apagar no timeout criaria a corrida "o núcleo pegou, mas ainda
  // não terminou". O id único impede confundir a resposta quando o núcleo voltar.
  throw new Error(`vendas-multicanal-core não respondeu pela fila em ${Math.round(timeoutMs / 1000)}s; o pedido ficou enfileirado`)
}
