// A IDADE É CALCULADA, NUNCA ESCRITA.
//
// "Tenho 25 anos" escrito num arquivo é verdade que estraga sozinha: no próximo aniversário
// vira mentira, e ninguém lembra de trocar. Pior que estar errado é estar errado em silêncio,
// porque a pessoa do outro lado confere e quem sustenta é a dona.
//
// Também não se pede a conta ao modelo. Ele tem a data de hoje no prompt e poderia subtrair,
// mas conta de data é exatamente onde modelo escorrega — e aqui errar é dizer uma idade
// errada pra alguém. Função eterna antes de LLM (regra do projeto).
//
// A FONTE é o retrato (`sobre-mim-fontes/quem-eu-sou.md`), não uma constante aqui: fato
// biográfico mora em arquivo de identidade, nunca em código. Ver `licoes/identidade-de-outro-dono`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PERFIL_PATH } from '../core/caminhos.mjs'

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const RETRATO_RUNTIME = PERFIL_PATH
const RETRATO_LOCAL = path.join(RAIZ, 'sobre-mim-fontes', 'quem-eu-sou.md')

// Linha esperada: "Nascimento: 2001-02-07" (em qualquer lugar do arquivo, com ou sem negrito).
const LINHA = /Nascimento:\s*\**\s*(\d{4})-(\d{2})-(\d{2})/i

function lerRetrato() {
  for (const p of [RETRATO_RUNTIME, RETRATO_LOCAL]) {
    try { return fs.readFileSync(p, 'utf8') } catch { /* tenta o próximo */ }
  }
  return null
}

// Devolve { iso, dia, mes, ano } ou null. Null é resposta legítima: enquanto o retrato não
// declarar a data, o sistema simplesmente não fala de idade — em vez de chutar.
export function nascimentoDeclarado() {
  const txt = lerRetrato()
  if (!txt) return null
  const m = txt.match(LINHA)
  if (!m) return null
  const [, ano, mes, dia] = m
  const iso = `${ano}-${mes}-${dia}`
  // sanidade: data impossível não vira idade absurda em silêncio
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  return { iso, ano: Number(ano), mes: Number(mes), dia: Number(dia) }
}

// Hoje no fuso da dona (a VM roda em UTC; das 21h à meia-noite os dois discordam de um dia,
// e é justamente aí que uma idade poderia virar no dia errado).
function hojeNoBrasil() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const g = Object.fromEntries(p.map((x) => [x.type, x.value]))
  return { ano: Number(g.year), mes: Number(g.month), dia: Number(g.day) }
}

// Idade em anos completos. null quando não há data declarada.
export function idadeHoje() {
  const n = nascimentoDeclarado()
  if (!n) return null
  const h = hojeNoBrasil()
  let anos = h.ano - n.ano
  // ainda não fez aniversário este ano?
  if (h.mes < n.mes || (h.mes === n.mes && h.dia < n.dia)) anos -= 1
  return anos >= 0 && anos < 130 ? anos : null
}

// PERGUNTARAM A IDADE DELA? (15/08/2026, depois de acontecer)
//
// Sem data no retrato, `idadeBlock()` sai vazio e a IA desconversa — "essa parte te conto
// depois", "idade é só número". Está certo: fato que não existe não se inventa. O errado é
// isso acontecer EM SILÊNCIO, para sempre. Na instancia-b duas pessoas diferentes perguntaram a
// idade em dois dias e as duas levaram esquiva, enquanto o retrato seguia vazio e ninguém
// sabia. Quem opera precisa descobrir no dia, não meses depois.
//
// Só a pergunta sobre a idade DELA. "Seu filho tem quantos anos?" é a IA perguntando, e
// "tenho 30 anos" é a outra pessoa se apresentando: nenhum dos dois abre pendência.
const semAcento = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
export function perguntaramIdadeDela(texto) {
  const t = semAcento(texto)
  if (!t.trim()) return false
  return [
    /\b(quantos|qnts|qts|quantos)\s+anos\s+(vc|voce|tu|tens|tem|tu tem|vc tem)\b/,
    /\b(vc|voce|tu)\s+tem\s+quantos\s+anos\b/,
    /\bqual\s+(a\s+)?(sua|tua)\s+idade\b/,
    /\b(sua|tua)\s+idade\b\s*\??$/,
    /\bidade\s*\?$/,
  ].some((re) => re.test(t))
}

// A linha que entra no prompt. '' quando não há data — e aí o prompt fica idêntico ao de
// antes, com a IA respondendo que não sabe (regra do fato ausente).
export function idadeBlock() {
  const n = nascimentoDeclarado()
  const anos = idadeHoje()
  if (!n || anos == null) return ''
  const br = `${String(n.dia).padStart(2, '0')}/${String(n.mes).padStart(2, '0')}/${n.ano}`
  // O aniversário vai junto porque a pergunta costuma vir em par ("quantos anos?" / "quando
  // faz?"), e porque sem ele a IA poderia inventar uma data pra combinar com a idade.
  return `IDADE (fato, já calculado — não recalcule): o usuário tem ${anos} anos, nascido em ${br}. Quando perguntarem a idade, responda ${anos}. Nunca diga um número diferente deste e nunca calcule de cabeça.`
}
