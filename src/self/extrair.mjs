// Extrator de fatos: lê o que a pessoa usuária escreveu nos canais conectados e propõe
// fatos para o painel. É como o "eu" cresce sem ninguém digitar formulário.
//
// Duas travas de desenho:
//   1. Só lê mensagens OUTGOING. O que o contato disse não é fato sobre quem usa o sistema.
//   2. Todo fato nasce 'proposto' e com sensibilidade sugerida. Nada entra no prompt antes
//      de o dono aprovar. Uma IA que se auto-atualiza sem revisão inventa memória.
import { db } from '../core/db.mjs'
import { gerarTexto } from '../ai/ia.mjs'
import { listarFatos, salvarFato, chave, CATEGORIAS, SENSIBILIDADES } from './fatos.mjs'

const INSTRUCOES = [
  'Você extrai fatos objetivos sobre UMA pessoa a partir de mensagens que ela mesma escreveu.',
  'Responda somente com JSON válido, sem markdown, sem comentário e sem texto fora do JSON.',
].join('\n')

// Mensagens da pessoa usuária, das conversas mais ativas, sem repetir fatos existentes.
export function coletarMensagens({ limite = 400, minChars = 40 } = {}) {
  return db().prepare(`
    SELECT text, channel, ts FROM message
    WHERE direction='outgoing' AND text IS NOT NULL AND length(text) >= ?
    ORDER BY ts DESC LIMIT ?`).all(minChars, limite)
}

function montarPrompt(mensagens) {
  return [
    'Abaixo estão mensagens escritas por uma pessoa brasileira em conversas nos canais conectados.',
    'Extraia FATOS sobre a vida dessa pessoa que apareçam de forma clara: trabalho, formação, família, história pessoal, gostos, rotina, lugares e relacionamento.',
    '',
    'Regras:',
    '- Cada fato em UMA frase curta, em primeira pessoa ("Faço academia de manhã").',
    '- Só o que está EXPLÍCITO nas mensagens. Não deduza, não complete, não generalize. Na dúvida, não extraia.',
    '- Nada de fato sobre as outras pessoas da conversa: só sobre quem escreveu.',
    '- Nada de dado identificador (telefone, endereço, documento, placa, senha, link de pagamento).',
    '- Ignore combinação pontual ("te ligo às 19h"): fato é o que continua verdade depois.',
    '',
    'Para cada fato devolva:',
    '- texto: a frase',
    `- categoria: uma de ${CATEGORIAS.join(', ')}`,
    '- sensibilidade: "livre" (pode falar quando encaixar), "sob_pedido" (só se a conversa chegar no assunto: saúde, dinheiro, família, questões íntimas, temas delicados) ou "nunca" (nada que exponha ou constranja: processo, dívida, uso de substância, saúde de terceiro, conteúdo sexual)',
    '- gatilhos: 2 a 5 palavras que indicam que o assunto chegou perto do fato',
    '- confianca: 0 a 1, o quanto a mensagem sustenta o fato',
    '',
    'Formato exato: {"fatos":[{"texto":"...","categoria":"...","sensibilidade":"...","gatilhos":["..."],"confianca":0.8}]}',
    'Se não houver fato claro, devolva {"fatos":[]}.',
    '',
    '--- mensagens ---',
    mensagens.map((m) => `- ${String(m.text).replace(/\s+/g, ' ').slice(0, 400)}`).join('\n'),
  ].join('\n')
}

function parseFatos(texto) {
  const t = String(texto || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  try {
    const o = JSON.parse(t)
    return Array.isArray(o?.fatos) ? o.fatos : []
  } catch {
    const m = t.match(/\{[\s\S]*\}/)
    if (!m) return []
    try { const o = JSON.parse(m[0]); return Array.isArray(o?.fatos) ? o.fatos : [] } catch { return [] }
  }
}

// Duas frases diferentes que dizem a mesma coisa não podem virar dois fatos: a memória
// encheria de duplicata e o prompt gastaria token repetindo. Comparação por palavras
// significativas em comum (barata e suficiente pro volume aqui).
export function pareceDuplicado(texto, existentes) {
  const pal = (s) => new Set(chave(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4))
  const a = pal(texto)
  if (!a.size) return true
  for (const e of existentes) {
    const b = pal(e.texto)
    if (!b.size) continue
    let comuns = 0
    for (const w of a) if (b.has(w)) comuns++
    if (comuns / Math.min(a.size, b.size) >= 0.6) return true
  }
  return false
}

// Roda a extração e devolve o que foi proposto. Não aprova nada.
export async function extrairFatos({ limite = 400, lote = 80, onProgress } = {}) {
  const mensagens = coletarMensagens({ limite })
  if (!mensagens.length) return { lidas: 0, propostos: 0, duplicados: 0, fatos: [] }
  const existentes = listarFatos()
  const novos = []
  let duplicados = 0
  const lotes = []
  for (let i = 0; i < mensagens.length; i += lote) lotes.push(mensagens.slice(i, i + lote))

  for (let i = 0; i < lotes.length; i++) {
    if (typeof onProgress === 'function') { try { onProgress(i + 1, lotes.length) } catch { /* */ } }
    let bruto = ''
    try {
      const r = await gerarTexto({
        prompt: montarPrompt(lotes[i]),
        baseInstructions: INSTRUCOES,
        effort: 'low',
        usageMeta: { origin: 'fatos_extracao', step: `lote_${i + 1}`, trigger: 'manual', channel: 'self' },
      })
      bruto = r.text
    } catch { continue } // um lote que falha não derruba a extração inteira
    for (const f of parseFatos(bruto)) {
      const texto = String(f?.texto || '').replace(/\s+/g, ' ').trim()
      if (texto.length < 8 || texto.length > 300) continue
      if (pareceDuplicado(texto, [...existentes, ...novos])) { duplicados++; continue }
      const item = {
        texto,
        categoria: CATEGORIAS.includes(f.categoria) ? f.categoria : 'outro',
        sensibilidade: SENSIBILIDADES.includes(f.sensibilidade) ? f.sensibilidade : 'sob_pedido',
        gatilhos: Array.isArray(f.gatilhos) ? f.gatilhos.slice(0, 6) : [],
        confianca: typeof f.confianca === 'number' ? Math.max(0, Math.min(1, f.confianca)) : 0.5,
        origem: 'extração das minhas conversas',
        status: 'proposto',
      }
      item.id = salvarFato(item)
      novos.push(item)
    }
  }
  return { lidas: mensagens.length, propostos: novos.length, duplicados, fatos: novos }
}
