import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENV = path.join(RAIZ, '.env')
const DADOS = path.join(RAIZ, 'data')
const SOBRE_MIM = path.join(DADOS, 'sobre-mim')
const MODELOS = path.join(RAIZ, 'sobre-mim-fontes')

const padrao = (valor, fallback) => String(valor || '').trim() || fallback
const seguro = (n = 24) => crypto.randomBytes(n).toString('base64url')
const escaparEnv = (valor) => JSON.stringify(String(valor ?? ''))

async function perguntar(rl, texto, fallback = '') {
  const sufixo = fallback ? ` [${fallback}]` : ''
  return padrao(await rl.question(`${texto}${sufixo}: `), fallback)
}

async function principal() {
  const versao = Number(process.versions.node.split('.')[0])
  if (versao < 22) {
    console.error(`Node.js ${process.versions.node} encontrado. Instale o Node.js 22 ou superior.`)
    process.exit(1)
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('\nConfiguração inicial do Vendas Multicanal')
  console.log('Os dados informados ficam somente em data/ e .env, ambos ignorados pelo Git.\n')

  if (fs.existsSync(ENV)) {
    const resposta = (await rl.question('Já existe um .env. Substituir a configuração? [s/N]: ')).trim().toLowerCase()
    if (!['s', 'sim'].includes(resposta)) {
      rl.close()
      console.log('Configuração preservada. Rode "npm run diagnostico" para conferir o ambiente.')
      return
    }
  }

  const nome = await perguntar(rl, 'Nome que a IA deve usar para você', '')
  const generoCru = (await perguntar(rl, 'Gênero para concordância: f, m ou deixe vazio', '')).toLowerCase()
  const genero = ['f', 'm'].includes(generoCru) ? generoCru : null
  const cidade = await perguntar(rl, 'Cidade ou região base', 'Minha cidade')
  const portaCrua = await perguntar(rl, 'Porta do painel', '8080')
  const portaNumero = Number(portaCrua)
  const porta = Number.isInteger(portaNumero) && portaNumero >= 1024 && portaNumero <= 65535 ? String(portaNumero) : '8080'
  const senhaSugerida = seguro(16)
  let senha = await perguntar(rl, 'Senha do painel (pode aceitar a gerada)', senhaSugerida)
  while (senha.length < 12) {
    console.log('A senha precisa ter pelo menos 12 caracteres.')
    senha = await perguntar(rl, 'Senha do painel', senhaSugerida)
  }
  rl.close()

  fs.mkdirSync(SOBRE_MIM, { recursive: true })
  fs.cpSync(MODELOS, SOBRE_MIM, { recursive: true, force: false, errorOnExist: false })
  fs.mkdirSync(path.join(DADOS, 'chrome-profile'), { recursive: true })

  const dono = {
    nome: nome || null,
    genero,
    _leia: 'Arquivo privado desta instalação. Não envie para o GitHub.',
  }
  fs.writeFileSync(path.join(SOBRE_MIM, 'dono.json'), JSON.stringify(dono, null, 2) + '\n', { mode: 0o600 })

  const linhas = [
    '# Criado por npm run configurar. Este arquivo é privado e ignorado pelo Git.',
    'TIM_SISTEMA=vendas-multicanal',
    `TIM_APP_DIR=${escaparEnv(RAIZ)}`,
    `TIM_DATA_DIR=${escaparEnv(DADOS)}`,
    `TIM_DB_PATH=${escaparEnv(path.join(DADOS, 'vendas-multicanal.db'))}`,
    '',
    'TIM_PANEL_HOST=127.0.0.1',
    `TIM_PANEL_PORT=${porta}`,
    `TIM_PANEL_PASSWORD=${escaparEnv(senha)}`,
    `TIM_PANEL_SECRET=${escaparEnv(seguro(32))}`,
    `TIM_PUBLIC_URL=http://127.0.0.1:${porta}`,
    '',
    'TIM_CDP_ENDPOINT=http://127.0.0.1:9222',
    `TIM_LUGAR_BASE=${escaparEnv(cidade)}`,
    '',
    '# Integrações opcionais:',
    '# GOOGLE_AGENDA_CLIENT_ID=',
    '# GOOGLE_AGENDA_CLIENT_SECRET=',
    '# TIM_CODEX_BINARY=codex',
    '# TIM_FFMPEG=ffmpeg',
  ]
  fs.writeFileSync(ENV, linhas.join('\n') + '\n', { mode: 0o600 })
  fs.chmodSync(ENV, 0o600)

  console.log('\nConfiguração criada com sucesso.')
  console.log(`Painel: http://127.0.0.1:${porta}`)
  console.log(`Senha: ${senha}`)
  console.log('\nPróximos comandos:')
  console.log('  npm run chrome')
  console.log('  npm start')
  console.log('\nDepois abra o painel e siga Configurações → Sistema → Conectar os canais.')
}

principal().catch((erro) => {
  console.error('Não foi possível configurar:', erro.message)
  process.exit(1)
})
