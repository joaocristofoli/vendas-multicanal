// Refeição no texto da cobrança, e se AGORA (Brasília) é hora dela.
//
// Em 15/08/2026 a fila do almoço saiu às 19h. "preciso de comida pra almoçar" de noite
// lê golpe ou descuido. A linhagem não espera o operador lembrar da janela: se a linha
// nomeia a refeição, o 1º tempo só sai dentro dela. Se o deslize JÁ saiu, a próxima
// fala brinca — "falei almoço pq não consegui almoçar, faltava grana" — e só então.
import { minutoAgoraBr } from './store.mjs'

const NORM = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

// Janelas civis. Almoço depois das 15h já é tarde demais pra falar como se fosse agora.
const REFEICOES = [
  { chave: 'almoco', re: /\balmoc/, de: 11 * 60, ate: 15 * 60 },
  { chave: 'jantar', re: /\bjant(ar|a)\b/, de: 18 * 60, ate: 22 * 60 },
  { chave: 'cafe', re: /\bcafe(\s+da\s+manha)?\b/, de: 6 * 60, ate: 10 * 60 },
]

let minutoProva = null
export function _forcarMinutoParaProva(n) { minutoProva = n == null ? null : Number(n) }
function minutoAgora(agora) {
  if (minutoProva != null && Number.isFinite(minutoProva)) return minutoProva
  return minutoAgoraBr(agora)
}

export function refeicaoNoTexto(texto) {
  const n = NORM(texto)
  if (!n.trim()) return null
  return REFEICOES.find((r) => r.re.test(n)) || null
}

// Devolve a refeição se o texto a nomeia E o minuto (Brasília) está fora da janela.
export function refeicaoForaDeHora(texto, minuto = minutoAgora()) {
  const r = refeicaoNoTexto(texto)
  if (!r) return null
  const m = Number(minuto)
  if (!Number.isFinite(m)) return null
  if (m >= r.de && m <= r.ate) return null
  return r
}

export function textoDeslizeAlmoco() {
  return 'kk falei almoço pq nem consegui almoçar hoje, faltou grana'
}

// A mensagem NOSSA que já saiu falando de almoço fora da janela. Olha a hora
// em que SAIU, não a hora de agora — o deslize é o que a pessoa leu.
export function deslizeAlmocoNaSaida({ text, ts } = {}) {
  if (!refeicaoNoTexto(text) || refeicaoNoTexto(text).chave !== 'almoco') return false
  if (!ts) return false
  const minutoQuandoSaiu = minutoAgoraBr(new Date(Number(ts)))
  return !!refeicaoForaDeHora(text, minutoQuandoSaiu)
}
