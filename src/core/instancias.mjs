// ONDE UMA INSTÂNCIA VIVE.
//
// O checkout local pode estar atrás da VM. Para provar o estado de uma instância,
// consulte sempre os caminhos vivos do catálogo, nunca uma pasta local parecida.
//
// A regra: o que uma instância TEM (módulo, tabela, cadastro, sessão, identidade viva)
// se prova em `/opt/<nome>/app` e `/opt/<nome>/data` na `<nome>-vm`. Pasta no computador
// de quem opera — `~/instancia-b`, `~/instancia-c`, `~/vendas-multicanal` — é checkout, não é a instância.
//
// Este módulo é a fonte do ENDEREÇO. Não SSHa, não lê disco local, não aceita caminho
// de pasta: o nome (`instancia-b`) vira a VM e o caminho remoto. Quem precisa olhar o que
// está lá de verdade usa `tools/instancia.mjs`.
//
// Guarda: `licoes/checkout-local-nao-e-a-instancia`.

export const GCP_PROJECT = process.env.GCP_PROJECT_ID || ''
export const GCP_ZONE = process.env.GCP_ZONE || 'southamerica-east1-a'

const NOME = /^[a-z][a-z0-9-]{1,62}$/

function pareceCaminho(s) {
  return /[~/\\]/.test(s) || /^[.]{1,2}($|[\\/])/.test(s)
}

export function nomeDaInstancia(entrada) {
  const s = String(entrada || '').trim()
  if (!s) throw new Error('diga o nome da instância (instancia-b), não o caminho do Mac')
  if (pareceCaminho(s)) {
    throw new Error('checkout local não é a instância. Use o nome (instancia-b), não o caminho do Mac')
  }
  const nome = s
  if (!NOME.test(nome)) throw new Error(`nome de instância inválido: ${s}`)
  return nome
}

export function instanciaViva(entrada) {
  const nome = nomeDaInstancia(entrada)
  return {
    nome,
    vm: `${nome}-vm`,
    app: `/opt/${nome}/app`,
    data: `/opt/${nome}/data`,
    db: `/opt/${nome}/data/${nome}.db`,
    project: GCP_PROJECT,
    zone: GCP_ZONE,
  }
}

export function sshDaInstancia(entrada) {
  const i = instanciaViva(entrada)
  const project = i.project ? ` --project=${i.project}` : ''
  return `gcloud compute ssh ${i.vm}${project} --zone=${i.zone}`
}
