// LIÇÕES: cada erro pode virar uma guarda determinística que roda para sempre.
//
// A diferença entre isto e "anotar no doc": um doc depende de alguém lembrar de ler. Uma
// LIÇÃO é código que roda sozinho e REPROVA quando a condição do erro volta a existir. Não
// tem como esquecer o que falha o build.
//
// A forma de uma lição:
//   licao.json   a história: o que deu errado, quando, e qual invariante foi violado
//   guarda.mjs   export async function guarda() -> { ok, detalhe }
//
// TRÊS REGRAS QUE O CÓDIGO IMPÕE (não são convenção, são verificadas):
//
// 1. GUARDA NÃO USA LLM. Verificado por leitura do próprio arquivo antes de rodar. Uma
//    guarda que chamasse modelo seria cara, lenta e não determinística — exatamente o que
//    ele mandou evitar. E pior: passaria a falhar por motivo errado (cota, rede, humor do
//    modelo) e viraria ruído que todo mundo aprende a ignorar.
//
// 2. GUARDA TEM QUE PEGAR O PRÓPRIO BUG. Toda lição declara `comoReproduzir` — o estado que
//    fazia o erro acontecer. O teste da suíte usa isso pra provar que a guarda REPROVA
//    quando o bug volta. Guarda que sempre passa não guarda nada.
//
// 3. LIÇÃO NASCE DE ERRO REPRODUZÍVEL. `quando` e `oQueAconteceu` são obrigatórios, mas
//    detalhes pessoais ficam fora; registre apenas o contexto técnico necessário.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logEvent } from '../core/db.mjs'

const exec = promisify(execFile)
const GUARDA_TIMEOUT_MS = Number(process.env.TIM_GUARDA_TIMEOUT_MS || 60_000)

const RAIZ = process.env.TIM_APP_DIR || path.resolve(new URL('../..', import.meta.url).pathname)
export const DIR = process.env.TIM_LICOES_DIR || path.join(RAIZ, 'licoes')

// O que denuncia uma guarda que foi virar prompt. Deliberadamente amplo: falso positivo aqui
// custa renomear uma variável; falso negativo custa uma guarda que não é determinística.
// Procura CHAMADA, não menção: o `\s*\(` no fim é o que separa "este código chama o
// modelo" de "este código fala sobre chamar o modelo".
const CHEIRO_DE_LLM = /\b(getCodex|runAgentTurn|runTurn|turnoDeAgente|pensarCodex|generateDraft|generateReply)\s*\(|api\.(openai|anthropic)\.com/

export function garantirDir() { fs.mkdirSync(DIR, { recursive: true }); return DIR }
const caminho = (slug) => path.join(DIR, String(slug).replace(/[^a-z0-9-]/gi, '-').toLowerCase())

export function ler(slug) {
  const dir = caminho(slug)
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'licao.json'), 'utf8'))
    return { ...m, slug: m.slug || path.basename(dir), dir, temGuarda: fs.existsSync(path.join(dir, 'guarda.mjs')) }
  } catch { return null }
}

export function listar() {
  garantirDir()
  const out = []
  for (const d of fs.readdirSync(DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const l = ler(d.name)
    if (l) out.push(l)
  }
  return out.sort((a, b) => String(a.quando || '').localeCompare(String(b.quando || '')))
}

export function criar({ slug, oQueAconteceu, invariante, quando, comoReproduzir = null, guarda = null }) {
  if (!slug || !oQueAconteceu || !invariante) throw new Error('lição precisa de slug, oQueAconteceu e invariante')
  if (!quando) throw new Error('lição precisa de `quando` (a data do erro real). Lição sem história vira regra de estilo.')
  if (!guarda) throw new Error('lição precisa de guarda.mjs: o código que REPROVA quando o erro voltar. Sem guarda, é só um bilhete.')
  if (CHEIRO_DE_LLM.test(guarda)) throw new Error('guarda NÃO pode chamar modelo: tem que ser determinística. Resolva com leitura de arquivo, SQL, regex ou execução direta.')
  garantirDir()
  const dir = caminho(slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'licao.json'), JSON.stringify({ slug: path.basename(dir), oQueAconteceu, invariante, quando, comoReproduzir, criadaEm: Date.now() }, null, 2))
  fs.writeFileSync(path.join(dir, 'guarda.mjs'), guarda)
  logEvent({ type: 'licao_criada', detail: `${path.basename(dir)}: ${invariante}` })
  return ler(path.basename(dir))
}

// Roda UMA guarda. Nunca lança: guarda quebrada é uma reprovação com o motivo, não um crash
// que derruba a suíte inteira e esconde as outras.
export async function rodar(slug) {
  const l = ler(slug)
  if (!l) return { slug, ok: false, detalhe: 'lição não existe' }
  const arq = path.join(l.dir, 'guarda.mjs')
  if (!fs.existsSync(arq)) return { slug, ok: false, detalhe: 'lição sem guarda.mjs' }
  // Regra 1, verificada em TODA execução (e não só na criação): alguém pode editar depois.
  const fonte = fs.readFileSync(arq, 'utf8')
  if (CHEIRO_DE_LLM.test(fonte)) return { slug, ok: false, detalhe: 'a guarda passou a chamar modelo — guarda tem que ser determinística' }
  // PROCESSO SEPARADO, e não import. Três motivos:
  //   1. a guarda precisa mexer no ambiente (ex.: TIM_DB_PATH pra não tocar o banco de
  //      produção), e no mesmo processo o db.mjs já tinha resolvido o caminho no import;
  //   2. cache de módulo do pai contamina o que a guarda enxerga;
  //   3. guarda que estoura não pode derrubar o runner das outras.
  const runner = `
    import { guarda } from ${JSON.stringify(arq)}
    const r = await guarda()
    process.stdout.write('\\u0000' + JSON.stringify(r || {}))
  `
  try {
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', runner],
      { timeout: GUARDA_TIMEOUT_MS, cwd: l.dir, env: { ...process.env } })
    const i = String(stdout).lastIndexOf('\u0000')
    const r = i >= 0 ? JSON.parse(String(stdout).slice(i + 1)) : null
    if (!r) return { slug, ok: false, detalhe: 'a guarda não devolveu resultado', invariante: l.invariante }
    return { slug, ok: !!r.ok, detalhe: r.detalhe || (r.ok ? 'ok' : 'reprovou sem detalhe'), invariante: l.invariante }
  } catch (e) {
    const saida = `${e.stdout || ''}${e.stderr || ''}`.trim()
    return { slug, ok: false, detalhe: `a guarda estourou: ${saida || e.message}`.slice(0, 600), invariante: l.invariante }
  }
}

export async function rodarTodas() {
  const out = []
  for (const l of listar()) out.push(await rodar(l.slug))
  return out
}

// O índice pro prompt do agente. Uma linha por lição, só o invariante — a história fica no
// disco. É o que impede ele de repetir um erro que o sistema já pagou pra aprender.
const TETO = Number(process.env.TIM_LICOES_INDICE_MAX || 20)
export function indice({ max = TETO } = {}) {
  const l = listar()
  if (!l.length) return 'LIÇÕES: nenhuma ainda.'
  const mostra = l.slice(-max)
  return ['LIÇÕES DE ERROS JÁ COMETIDOS (cada uma tem uma guarda que reprova se voltar):',
    ...mostra.map((x) => `  ${x.slug}: ${x.invariante}`),
    l.length > max ? `  (+${l.length - max} — node tools/licao.mjs listar)` : null,
    '  Errou de um jeito novo? `node tools/licao.mjs criar` — a guarda é obrigatória e não pode usar modelo.',
  ].filter(Boolean).join('\n')
}
