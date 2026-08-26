// WaPool: registro de WaAccounts (um socket Baileys por accountKey).
// Guarda o ciclo de vida das contas e permite operar todas em paralelo.
// Nao acopla ao banco: os callbacks (onQr, onStatus, onMessage, isAllowed) sao
// repassados ao WaAccount na criacao.
import { WaAccount } from './account.mjs'

export class WaPool {
  constructor() {
    // accountKey -> WaAccount
    this.accounts = new Map()
  }

  // Retorna a conta existente para accountKey ou cria uma nova com os callbacks
  // dados. Idempotente: chamadas repetidas devolvem a mesma instancia (os
  // callbacks so sao usados na primeira criacao).
  getOrCreate(accountKey, callbacks = {}) {
    let account = this.accounts.get(accountKey)
    if (!account) {
      account = new WaAccount(accountKey, callbacks)
      this.accounts.set(accountKey, account)
    }
    return account
  }

  // Devolve a conta de accountKey, ou undefined se nao existir.
  get(accountKey) {
    return this.accounts.get(accountKey)
  }

  // Todas as contas registradas (array).
  all() {
    return Array.from(this.accounts.values())
  }

  // Mapa accountKey -> snapshot de estado, pro painel.
  snapshots() {
    const out = {}
    for (const [accountKey, account] of this.accounts) {
      out[accountKey] = account.getSnapshot()
    }
    return out
  }
}
