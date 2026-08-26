#!/usr/bin/env node
// `node tools/acao.mjs <ação> '<json dos args>' [--ja] [--pessoa-id <id>]`
// `node tools/acao.mjs listar`
//
// O CATÁLOGO DO ASSISTENTE, na mão do modo códex. É o que faz o modo códex ser o modo normal
// MAIS a engenharia, e não um modo paralelo que sabe programar mas não sabe marcar um
// compromisso — foi o que aconteceu em 28/07/2026: o dono pediu "avise o contato_teste_p que estou
// quase terminando o app" no self-chat, o chat estava em modo códex, e a resposta foi "estou
// no modo de engenharia e não envio mensagens".
//
// Por que uma ferramenta de shell e não uma segunda IA: o agente do códex JÁ entendeu o
// pedido. Mandar ele reescrever tudo em português pra outro modelo interpretar de novo é
// telefone-sem-fio caro. Ele escolhe a ação e os argumentos direto.
//
// Por que passa pelo núcleo por HTTP (e não executa aqui): o socket do WhatsApp, a sessão do
// Instagram e o token do Tinder vivem DENTRO do processo do vendas-multicanal-core. Um segundo processo não
// tem nada disso — mesmo motivo do tools/mandar.mjs.
//
// O que ele NÃO faz: escolher pessoa quando o nome é ambíguo. Aí ele PARA e mostra as opções
// (saída 3). Essa pergunta é sobre pontaria, não sobre permissão, e --ja não a pula.
import { ACOES, catalogoParaPrompt } from '../src/assistente/acoes.mjs'
import { postNoPainel, PAINEL } from './painel.mjs'
import { pedirAcaoPorArquivo } from './ipc-acao.mjs'

const argv = process.argv.slice(2)

if (!argv.length || argv[0] === 'listar' || argv[0] === '--ajuda' || argv[0] === '-h') {
  console.log(`uso: node tools/acao.mjs <ação> '<json dos args>' [--ja] [--pessoa-id <id>]

  --ja         não espera o "ok" de quem opera numa ação externa (mandar mensagem): executa na hora.
               O registro e o desfazer continuam iguais.
  --pessoa-id  quando o nome casou com mais de uma pessoa, repita passando o id que a saída
               anterior mostrou.

AÇÕES:
${catalogoParaPrompt()}`)
  process.exit(argv.length && argv[0] !== 'listar' ? 1 : 0)
}

const nome = argv[0]
if (!ACOES[nome]) {
  console.error(`não existe a ação "${nome}". rode: node tools/acao.mjs listar`)
  process.exit(1)
}

let args = {}
const cru = argv[1] && !argv[1].startsWith('--') ? argv[1] : null
if (cru) {
  try { args = JSON.parse(cru) } catch (e) { console.error(`os argumentos não são JSON válido: ${e.message}`); process.exit(1) }
}
const ja = argv.includes('--ja')
const iPid = argv.indexOf('--pessoa-id')
const pessoaId = iPid >= 0 ? argv[iPid + 1] : null

// DOIS CANOS PRO MESMO EXECUTOR. O HTTP é o de sempre. Mas dentro do sandbox do modo códex
// não existe rede — nem loopback: `curl` pro núcleo devolve http=000 enquanto de fora devolve
// 401. Foi assim que o dono pediu pra desligar a IA de um telefone e ouviu três vezes que "o
// vendas-multicanal-core está inacessível", com o núcleo vivo na mesma VM. A fila de arquivo passa por baixo
// disso: `/opt/vendas-multicanal/app` é compartilhado com o núcleo, e o núcleo continua sendo o ÚNICO
// executor — mesmo catálogo, mesmo registro, mesmo desfazer. Ver licoes/catalogo-inacessivel-no-sandbox.
const corpo = { nome, args, ja, pessoaId }
let resp
try {
  resp = await postNoPainel('/api/assistente/acao', corpo)
} catch (e) {
  try {
    resp = await pedirAcaoPorArquivo(corpo)
  } catch (e2) {
    console.error(`não consegui falar com o vendas-multicanal-core nem por HTTP (${PAINEL}: ${e.message}) nem pela fila (${e2.message})`)
    process.exit(4)
  }
}
const body = resp.dados || {}
const r = { ok: resp.ok }

// Ambiguidade tem saída própria (3) porque o agente precisa DISTINGUIR "deu erro" de "falta
// você escolher" — no primeiro caso ele tenta outra coisa, no segundo ele pergunta ao dono.
if (body.tipo === 'desambiguar') {
  console.error(`"${body.termo}" casa com ${body.enquete.opcoes.length} pessoas. Pergunte a quem opera qual é e repita com --pessoa-id:`)
  const acao = body.id
  for (const o of body.enquete.opcoes) console.error(`  ${o}`)
  console.error('\nids (na mesma ordem):')
  for (const c of (body.candidatos || [])) console.error(`  ${c.personId}  ${c.rotulo}`)
  console.error(`\n(a escolha também pode ser respondida no chat; a pergunta ficou aberta como ${acao})`)
  process.exit(3)
}

if (body.tipo === 'erro' || !r.ok) { console.error(body.texto || body.error || 'falhou'); process.exit(2) }
// Leitura devolve `dados` (o texto que o assistente leria); escrita devolve `texto` (o
// comprovante). Imprimir o JSON cru fazia o agente ter que desembrulhar string escapada.
console.log(body.tipo === 'leitura' ? body.dados : (body.texto || JSON.stringify(body)))
if (body.tipo === 'pendente') console.log(`(esperando o ok dele — pra executar agora: node tools/acao.mjs confirmar '{"id":"${body.id}"}')`)
if (body.temDesfazer) console.log(`(pra desfazer: node tools/acao.mjs desfazer '{"id":"${body.id}"}')`)
