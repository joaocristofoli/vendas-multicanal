#!/usr/bin/env node
// Importa a sessão do Instagram (cookies) direto pro Chrome da VM, sem passar pelo painel.
//
// POR QUE EXISTE: a única entrada de cookie era a rota `POST /api/ig/session`, que exige o
// cookie assinado de login do painel — ou seja, um curl teria que logar antes. E o painel não
// tem tela pra isso. Resultado prático: a sessão do Instagram só voltava se o cookie passasse
// pela mão de alguém, num chat ou num arquivo. Aqui ele vai do terminal pro Chrome e acabou.
//
// O COOKIE QUE IMPORTA É O `sessionid`, e ele é httpOnly: NÃO aparece no localStorage nem no
// `document.cookie` do Console. Só tem dois lugares certos pra pegar:
//   1. DevTools > Application > Cookies > https://www.instagram.com  (procure `sessionid`)
//   2. DevTools > Network > qualquer requisição > Request Headers > a linha `Cookie:` inteira
//
// USO (dentro da VM, em /opt/vendas-multicanal/app):
//   node tools/ig-cookie.mjs --stdin          <- COLE a linha e dê Enter (não fica no histórico)
//   node tools/ig-cookie.mjs 'sessionid=...; ds_user_id=...'  [user-agent]
//
// Prefira o --stdin: argumento de linha de comando fica no ~/.bash_history e aparece pra
// qualquer `ps` rodando na máquina no momento.
import { importCookies } from '../src/ig/session.mjs'

const args = process.argv.slice(2)
const usaStdin = args.includes('--stdin')
const resto = args.filter((a) => a !== '--stdin')

function lerStdin() {
  return new Promise((resolve) => {
    let d = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { d += c })
    process.stdin.on('end', () => resolve(d.trim()))
  })
}

const cookie = usaStdin ? await (async () => {
  process.stderr.write('cole a linha Cookie do Instagram e tecle Enter (depois Ctrl+D):\n')
  return lerStdin()
})() : resto[0]
const ua = usaStdin ? resto[0] : resto[1]

if (!cookie) {
  console.error('faltou o cookie. Veja o cabeçalho deste arquivo pra saber onde pegar.')
  process.exit(1)
}
if (!/sessionid=/.test(cookie)) {
  // Falha cedo e explica: o erro mais comum é colar o localStorage (que tem `IGSession` e
  // `Session`, e NENHUM dos dois serve) achando que é o cookie.
  console.error('essa string não tem `sessionid=`.')
  console.error('Se o que você copiou tem "IGSession" ou "CacheStorageVersion", isso é o')
  console.error('localStorage — não serve. O sessionid é httpOnly e só aparece em')
  console.error('DevTools > Application > Cookies, ou na linha Cookie: de uma requisição.')
  process.exit(1)
}

try {
  const r = await importCookies(cookie, ua || undefined)
  if (r && r.ok) {
    console.log(`sessão importada e VALIDADA. O Instagram respondeu como: @${r.me || '(sem @)'}`)
    console.log('confira se esse @ é mesmo o da conta certa antes de seguir.')
  } else {
    console.log('os cookies entraram no Chrome, mas a validação NÃO confirmou a sessão.')
    console.log('resposta:', JSON.stringify(r))
    console.log('provável: cookie já vencido, ou copiado de outra conta.')
  }
} catch (e) {
  console.error('falhou:', e.message)
  process.exit(1)
}
