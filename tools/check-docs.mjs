import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arquivos = [path.join(raiz, 'README.md'), path.join(raiz, 'APOIE.md'), path.join(raiz, 'NOTICE.md')]
const docs = path.join(raiz, 'docs')
for (const nome of fs.readdirSync(docs).filter((n) => n.endsWith('.md'))) arquivos.push(path.join(docs, nome))

const erros = []
for (const arquivo of arquivos) {
  const texto = fs.readFileSync(arquivo, 'utf8')
  for (const achado of texto.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const alvo = achado[1].trim()
    if (!alvo || alvo.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(alvo)) continue
    const semAncora = alvo.split('#')[0]
    const resolvido = path.resolve(path.dirname(arquivo), decodeURIComponent(semAncora))
    if (!fs.existsSync(resolvido)) erros.push(`${path.relative(raiz, arquivo)} aponta para ${alvo}, que não existe`)
  }
}

const readme = fs.readFileSync(path.join(raiz, 'README.md'), 'utf8')
for (const trecho of [
  'npm run configurar',
  'npm run chrome',
  'npm run diagnostico',
  'Como vender fotos',
  'Como vender serviços',
  'Conectar as redes sem copiar credenciais',
  '@eujoaocris',
  '(11)973964702',
]) {
  if (!readme.includes(trecho)) erros.push(`README não explica: ${trecho}`)
}

const pacote = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'))
for (const comando of ['configurar', 'chrome', 'diagnostico', 'start']) {
  if (!pacote.scripts?.[comando]) erros.push(`package.json não oferece npm run ${comando}`)
}

const marcasObrigatorias = [
  ['APOIE.md', ['@eujoaocris', '(11)973964702', 'Itaú']],
  ['NOTICE.md', ['@eujoaocris', '(11)973964702']],
  ['LICENSE', ['@eujoaocris']],
  ['package.json', ['@eujoaocris', 'APOIE.md']],
  ['src/panel/public/panel.html', ['@eujoaocris', '(11)973964702']],
  ['.github/FUNDING.yml', ['APOIE.md']],
]
for (const [nome, trechos] of marcasObrigatorias) {
  const texto = fs.readFileSync(path.join(raiz, nome), 'utf8')
  for (const trecho of trechos) if (!texto.includes(trecho)) erros.push(`${nome} perdeu a atribuição pública obrigatória: ${trecho}`)
}

if (erros.length) {
  console.error('Documentação reprovada:')
  for (const erro of erros) console.error(`- ${erro}`)
  process.exit(1)
}

console.log(`Documentação aprovada: ${arquivos.length} arquivos, links locais e primeiro uso conferidos.`)
