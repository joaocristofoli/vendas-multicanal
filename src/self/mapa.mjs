// O MAPA DE SI. É como a IA sabe ONDE está, DO QUE é feita e COMO se mover.
//
// Três decisões que definem este arquivo:
//
// 1. NADA AQUI É ESCRITO À MÃO. Tudo é sonda: lê o metadado da nuvem, o systemd, o disco, o
//    package.json, o banco, o binário. Documento escrito à mão apodrece e mente; sonda erra
//    junto com a realidade. Se a VM mudar de nuvem, o mapa muda sozinho.
//
// 2. É EM CAMADAS, POR CAUSA DE TOKEN. Auto-consciência que custa 8 mil tokens por turno é
//    auto-consciência desligada na prática. Então:
//      cracha()  ~40 tokens  -> vai SEMPRE no prompt. Onde estou, em uma linha.
//      indice()  ~120 tokens -> a lista de seções que existem, sem o conteúdo.
//      secao(x)             -> só o que ela pediu, quando pediu.
//    O agente puxa o resto pelo shell (`node tools/eu.mjs maquina`), então o custo é dele e
//    só acontece quando ele precisa. É o mesmo princípio de um humano que sabe onde fica o
//    manual em vez de decorar o manual.
//
// 3. PROVEDOR-AGNÓSTICO DE VERDADE. As sondas de nuvem tentam GCP, AWS e Azure na mesma
//    chamada e aceitam "nenhuma" (rodando local) como resposta legítima. O dono já disse
//    que pode migrar pra AWS, Azure ou pro próprio computador — o mapa não pode assumir GCE.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { db, getSetting } from '../core/db.mjs'
import { oDono, doDono, pronomeDono, ddonoPossessivo } from '../core/dono.mjs'
import { APP_DIR, DATA_DIR, ENV_PATH } from '../core/caminhos.mjs'

const exec = promisify(execFile)
export const RAIZ = APP_DIR
export const DADOS = DATA_DIR

// Cache com validade: sonda de máquina não muda a cada segundo e custa processo.
const cache = new Map()
async function cacheado(chave, ttlMs, fn) {
  const hit = cache.get(chave)
  if (hit && Date.now() - hit.t < ttlMs) return hit.v
  const v = await fn()
  cache.set(chave, { t: Date.now(), v })
  return v
}
export function esquecerCache() { cache.clear() }

const sh = async (cmd, args, timeout = 6000) => {
  try { const { stdout } = await exec(cmd, args, { timeout }); return String(stdout).trim() }
  catch { return null }
}
const existe = async (bin) => (await sh('command', ['-v', bin]).catch(() => null)) || (await sh('/usr/bin/which', [bin]))

// ---------------------------------------------------------------- nuvem
// As três grandes expõem metadados em IPs link-local diferentes, cada uma com o seu
// cabeçalho. Tenta as três em paralelo com timeout curto: fora de nuvem todas falham rápido
// e a resposta honesta é "local".
async function buscar(url, headers, ms = 1500) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal })
    return r.ok ? (await r.text()).trim() : null
  } catch { return null } finally { clearTimeout(t) }
}

export async function nuvem() {
  return cacheado('nuvem', 3600_000, async () => {
    const G = { 'Metadata-Flavor': 'Google' }
    const [gTipo, gZona, gNome, gProj, gIp] = await Promise.all([
      buscar('http://metadata.google.internal/computeMetadata/v1/instance/machine-type', G),
      buscar('http://metadata.google.internal/computeMetadata/v1/instance/zone', G),
      buscar('http://metadata.google.internal/computeMetadata/v1/instance/name', G),
      buscar('http://metadata.google.internal/computeMetadata/v1/project/project-id', G),
      buscar('http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip', G),
    ])
    if (gTipo) {
      return { provedor: 'gcp', instancia: gNome, tipo: gTipo.split('/').pop(), regiao: (gZona || '').split('/').pop(), projeto: gProj, ipPublico: gIp,
        comoEuAcesso: `gcloud compute ssh ${gNome} --project=${gProj} --zone=${(gZona || '').split('/').pop()}` }
    }
    // AWS IMDSv2 pede token; IMDSv1 responde direto. Tenta o v1 (barato) e cai fora se não for AWS.
    const aTipo = await buscar('http://169.254.169.254/latest/meta-data/instance-type', {})
    if (aTipo) {
      const [aId, aRegiao, aIp] = await Promise.all([
        buscar('http://169.254.169.254/latest/meta-data/instance-id', {}),
        buscar('http://169.254.169.254/latest/meta-data/placement/region', {}),
        buscar('http://169.254.169.254/latest/meta-data/public-ipv4', {}),
      ])
      return { provedor: 'aws', instancia: aId, tipo: aTipo, regiao: aRegiao, ipPublico: aIp, comoEuAcesso: `aws ssm start-session --target ${aId}` }
    }
    const az = await buscar('http://169.254.169.254/metadata/instance?api-version=2021-02-01', { Metadata: 'true' })
    if (az) {
      try {
        const j = JSON.parse(az).compute || {}
        return { provedor: 'azure', instancia: j.name, tipo: j.vmSize, regiao: j.location, projeto: j.subscriptionId, comoEuAcesso: `az ssh vm --name ${j.name}` }
      } catch { /* json estranho: cai pro local */ }
    }
    return { provedor: 'local', instancia: os.hostname(), tipo: `${os.cpus().length} cpu`, regiao: Intl.DateTimeFormat().resolvedOptions().timeZone, ipPublico: null, comoEuAcesso: 'já estou na máquina' }
  })
}

// ---------------------------------------------------------------- máquina
export async function maquina() {
  return cacheado('maquina', 60_000, async () => {
    const n = await nuvem()
    const disco = await sh('/bin/df', ['-h', RAIZ])
    const linhaDisco = (disco || '').split('\n')[1] || ''
    const [, tamanho, , , usoPct, ] = linhaDisco.split(/\s+/)
    const ipSaida = await buscar('https://api.ipify.org', {}, 5000)
    return {
      nuvem: n,
      so: `${os.type()} ${os.release()}`,
      distro: (await sh('/bin/cat', ['/etc/os-release']) || '').match(/PRETTY_NAME="([^"]+)"/)?.[1] || null,
      cpus: os.cpus().length,
      ramTotalGb: +(os.totalmem() / 1024 ** 3).toFixed(1),
      ramLivreGb: +(os.freemem() / 1024 ** 3).toFixed(1),
      disco: tamanho ? `${tamanho} (${usoPct} usado)` : null,
      ligadaHa: `${Math.round(os.uptime() / 3600)}h`,
      // O IP de SAÍDA é diferente do IP da instância quando há VPN/proxy no caminho. É por
      // ele que se sabe se uma VPN está de fato ativa — não pela configuração.
      ipDeSaida: ipSaida,
      ipDaInstancia: n.ipPublico || null,
      vpnAtiva: !!(ipSaida && n.ipPublico && ipSaida !== n.ipPublico),
    }
  })
}

// ---------------------------------------------------------------- processo
export function processo() {
  const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')) } catch { return {} } })()
  return {
    quemSouEu: 'vendas-multicanal-core',
    pid: process.pid,
    node: process.version,
    versaoApp: pkg.version || null,
    raizDoCodigo: RAIZ,
    raizDosDados: DADOS,
    banco: process.env.TIM_DB_PATH || path.join(DADOS, 'vendas-multicanal.db'),
    servico: 'systemd: vendas-multicanal-core.service',
    reiniciar: 'sudo systemctl restart vendas-multicanal-core (NUNCA daqui de dentro: use o "aplicar")',
    logs: 'sudo journalctl -u vendas-multicanal-core -f',
    noArHa: `${Math.round(process.uptime() / 60)} min`,
    memoriaMb: Math.round(process.memoryUsage().rss / 1024 ** 2),
  }
}

// ---------------------------------------------------------------- do que sou feito
// Lido do CÓDIGO, não de uma lista mantida à mão: módulos que existem, rotas que o painel
// serve e tabelas que o banco tem. Se alguém acrescentar um canal novo, o mapa sabe sozinho.
export function codigo() {
  const modulos = {}
  try {
    for (const dir of fs.readdirSync(path.join(RAIZ, 'src'), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      modulos[dir.name] = fs.readdirSync(path.join(RAIZ, 'src', dir.name)).filter((f) => f.endsWith('.mjs')).map((f) => f.replace('.mjs', ''))
    }
  } catch { /* fora da VM */ }
  let rotas = []
  try {
    const idx = fs.readFileSync(path.join(RAIZ, 'src', 'index.mjs'), 'utf8')
    rotas = [...idx.matchAll(/p === '([^']+)'/g)].map((m) => m[1]).sort()
  } catch { /* idem */ }
  let tabelas = []
  try { tabelas = db().prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name) } catch { /* idem */ }
  return { modulos, rotas, tabelas, docs: (() => { try { return fs.readdirSync(path.join(RAIZ, 'docs')).filter((f) => f.endsWith('.md')) } catch { return [] } })() }
}

// ---------------------------------------------------------------- do que dependo
// Binário que existe e binário que NÃO existe são as duas metades da mesma resposta: sem a
// segunda, o agente promete o que a máquina não tem.
const BINARIOS = [
  ['node', 'roda o vendas-multicanal'], ['npm', 'instala dependência'], ['codex', 'motor de IA (OpenAI)'],
  ['claude', 'motor de IA (Anthropic) — alternativa ao codex'], ['google-chrome', 'Instagram, Badoo e Tinder rodam por ele'],
  ['gcloud', 'só serve na GCP'], ['aws', 'só serve na AWS'], ['az', 'só serve na Azure'],
  ['docker', 'empacotar pra migrar'], ['sqlite3', 'inspecionar o banco na mão'], ['jq', 'ler json no shell'],
  ['nordvpn', 'VPN (NordVPN)'], ['openvpn', 'VPN genérica'], ['wg-quick', 'WireGuard'],
]
export async function dependencias() {
  return cacheado('dependencias', 300_000, async () => {
    const tem = {}, falta = {}
    await Promise.all(BINARIOS.map(async ([bin, pra]) => {
      const caminho = await existe(bin)
      if (caminho) tem[bin] = { caminho: caminho.split('\n')[0], versao: (await sh(bin, ['--version']) || '').split('\n')[0] || null }
      else falta[bin] = pra
    }))
    return { tem, falta }
  })
}

// ---------------------------------------------------------------- por onde eu falo
// Estado real dos canais, do banco. É o que separa "o canal existe no código" de "o canal
// está de pé agora".
export function sessoes() {
  const conta = (sql, ...p) => { try { return db().prepare(sql).get(...p) } catch { return null } }
  const wa = conta(`SELECT status, jid, name FROM wa_session WHERE account_key='main'`)
  const porCanal = (() => { try { return db().prepare(`SELECT channel, COUNT(*) n, MAX(ts) ultima FROM message GROUP BY channel`).all() } catch { return [] } })()
  return {
    whatsapp: { estado: wa?.status || 'IDLE', numero: wa?.jid || null },
    instagram: { conversas: conta(`SELECT COUNT(*) n FROM ig_chat`)?.n ?? 0, sessaoImportada: !!getSetting('ig_cookies', null) },
    tinder: { matches: conta(`SELECT COUNT(*) n FROM tinder_match`)?.n ?? 0 },
    badoo: { conversas: conta(`SELECT COUNT(*) n FROM badoo_chat`)?.n ?? 0, sessaoImportada: !!getSetting('badoo_cookies', null) },
    mensagensPorCanal: porCanal.map((c) => ({ canal: c.channel, n: c.n, ultima: c.ultima })),
  }
}

// ---------------------------------------------------------------- como eu me mudo
// O dono disse que pode ir pra AWS, Azure, ou rodar local. Então a resposta não pode ser
// "roda o deploy/push.sh": aquilo é uma máquina que JÁ existe. Mudança é outra coisa —
// levar junto o que não se reconstrói.
//
// A distinção que faz esta seção valer alguma coisa é entre:
//   INSUBSTITUÍVEL — se perder, acabou. Sessões (o Chrome logado no Instagram/Badoo/Tinder,
//                    as credenciais do WhatsApp), o banco, os segredos, o retrato do dono.
//   RECONSTRUÍVEL  — pesado, mas volta com um comando. node_modules, o venv do whisper, o
//                    próprio Chrome.
// Empacotar o segundo grupo é o erro clássico: 433MB de venv atravessando a rede à toa,
// enquanto o que importa cabe em pouco.
export async function mudanca() {
  const m = await maquina()
  const d = await dependencias()
  return {
    ondeEstou: `${m.nuvem.provedor} / ${m.nuvem.instancia} (${m.nuvem.tipo}, ${m.nuvem.regiao})`,
    insubstituivel: [
      { o_que: `${DADOS}/vendas-multicanal.db`, porque: 'o banco: conversas, identidades, memória, fatos, projetos' },
      { o_que: `${DADOS}/chrome-profile/`, porque: 'AS SESSÕES. Instagram, Badoo e Tinder logados vivem aqui. Perder = refazer login em tudo.' },
      { o_que: `${DADOS}/wa-auth/ (ou onde o baileys guarda)`, porque: 'o pareamento do WhatsApp. Perder = ler QR de novo no celular.' },
      { o_que: `${DADOS}/sobre-mim/`, porque: `quem ${oDono()} é, na voz ${ddonoPossessivo()}. É o que a IA lê pra escrever como ${pronomeDono()}.` },
      { o_que: ENV_PATH, porque: 'segredos: senha do painel, chaves. Nunca vai pro git.' },
      { o_que: '~/.codex/ e /opt/vendas-multicanal/contas/', porque: 'as credenciais de LLM. Sem isso a IA não pensa.' },
    ],
    reconstruivel: [
      { o_que: 'node_modules', comando: 'npm install --omit=dev' },
      { o_que: 'whisper-venv (433MB)', comando: 'python3 -m venv + pip install (só se usar transcrição local)' },
      { o_que: 'google-chrome', comando: 'apt install google-chrome-stable' },
      { o_que: 'codex CLI', comando: 'npm i -g @openai/codex' },
    ],
    passos: [
      '1. Na máquina NOVA: instalar node 22+, google-chrome, codex CLI. (`bash deploy/bootstrap.sh` faz isso)',
      '2. Na máquina VELHA: `bash deploy/migrar.sh empacotar` -> gera /tmp/vendas-multicanal-mudanca.tgz com o insubstituível.',
      '3. Copiar o pacote (scp/rsync — o caminho depende da nuvem; veja `comoEuAcesso` em maquina).',
      '4. Na nova: `bash deploy/migrar.sh restaurar /caminho/vendas-multicanal-mudanca.tgz`.',
      '5. `npm install --omit=dev` e subir os serviços (as units vão no pacote).',
      '6. Conferir com `node tools/eu.mjs sessoes`: WhatsApp CONNECTED e as contagens batendo com as de antes.',
      'ATENÇÃO ao passo 6: enquanto as DUAS máquinas estiverem de pé com o mesmo pareamento, o WhatsApp pode derrubar uma. Desligue o vendas-multicanal-core da velha ANTES de subir na nova.',
    ],
    ubuntu2404: 'Se a nova for Ubuntu 23.10+, o sandbox do Codex precisa do perfil /etc/apparmor.d/codex-bwrap (vai no pacote). Sem ele o modo códex não roda comando nenhum.',
    ferramentaDaNuvemNova: {
      gcp: d.tem.gcloud ? 'gcloud presente' : 'falta gcloud',
      aws: d.tem.aws ? 'aws presente' : 'falta aws cli (apt install awscli ou o instalador oficial)',
      azure: d.tem.az ? 'az presente' : 'falta az cli',
      local: 'nenhuma ferramenta de nuvem é necessária',
    },
    script: `${RAIZ}/deploy/migrar.sh`,
  }
}

// ---------------------------------------------------------------- o crachá
// A camada 0: o que vai em TODO turno. Uma linha. Se isto crescer, a economia morre.
export async function cracha() {
  const m = await maquina()
  const p = processo()
  return `Você é o vendas-multicanal, rodando em ${m.nuvem.provedor}/${m.nuvem.instancia} (${m.nuvem.tipo}, ${m.nuvem.regiao}), ${m.distro || m.so}, código em ${RAIZ}, dados em ${DADOS}, node ${p.node}, no ar há ${p.noArHa}.`
}

// A camada 1: o que EXISTE pra ser consultado, sem o conteúdo. É o índice do manual.
export const SECOES = {
  maquina: 'onde eu rodo: nuvem, instância, região, cpu/ram/disco, IP de saída, se tem VPN ativa',
  processo: 'o processo que eu sou: pid, node, caminhos, serviço, como reiniciar, logs',
  codigo: 'do que eu sou feito: módulos, rotas do painel, tabelas do banco, docs',
  dependencias: 'binários que a máquina TEM e os que NÃO tem (com pra que serviriam)',
  sessoes: 'por onde eu falo agora: WhatsApp, Instagram, Tinder, Badoo e o volume de cada um',
  contas: 'as contas de LLM, quanto de cota cada uma já gastou e qual está ativa',
  ia: 'qual IA está rodando TUDO agora (OpenAI ou Claude) e o que dá pra usar nesta máquina',
  travas: 'toda trava que existe no sistema, o que ela protege e como levantá-la',
  gosto: `o que o Instagram revela sobre o gosto ${doDono()}: quem ${pronomeDono()} segue, quem ${pronomeDono()} mais curte, que assuntos se repetem`,
  mudanca: 'como me mudar pra outra máquina/nuvem, passo a passo, com os comandos reais',
}

export function indice() {
  return ['O que você pode consultar sobre si (rode `node tools/eu.mjs <seção>` no shell, custa token só quando você pede):',
    ...Object.entries(SECOES).map(([k, v]) => `  ${k} — ${v}`)].join('\n')
}
