// Detector de compromissos: como o redator do vendas-multicanal é um gerador de texto puro (sem
// tool-call), a detecção é um SEGUNDO turno do Codex. Lê a conversa e devolve JSON
// estrito dizendo se ali ficou combinado um compromisso REAL do dono (encontro, ligação,
// rolê, reunião) com data. Nada é escrito na agenda aqui — só vira proposta pra revisão.
import { getCodex } from '../ai/codex.mjs'
import { buildHistory } from '../bridge/bridge.mjs'
import { recentTranscript } from '../ai/prompt.mjs'
import { TZ } from './google.mjs'
import { gerarTexto } from '../ai/ia.mjs'

const INSTRUCTIONS = [
  'Você é um extrator. Lê uma conversa e responde SOMENTE com um objeto JSON válido, sem markdown, sem comentário.',
  'Não use ferramentas, não pesquise, não execute nada.',
  'Objetivo: descobrir se a conversa combinou um COMPROMISSO REAL do usuário (encontro, ligação, reunião, rolê, viagem, visita) com pelo menos uma DATA definida.',
  'Só considere compromisso quando houver um plano concreto e aceito pelos dois lados. Intenção vaga ("vamos marcar algo qualquer dia", "depois a gente vê") NÃO conta.',
  'REGRA DE DATA (crítica): cada linha começa com [horário real da mensagem] em UTC (Z). Resolva referências como "amanhã", "hoje", "sexta", "às 9" RELATIVO AO HORÁRIO DA MENSAGEM onde o combinado aparece — NUNCA relativo à data de hoje. Ex.: "amanhã" dito numa mensagem de 6 de maio = 7 de maio.',
  'Seja CONSERVADOR: se o dia não for explícito, ou se AM/PM for ambíguo, escolha a interpretação mais provável pelo contexto e BAIXE a confiança (<= 0.5). Não chute com confiança alta.',
].join('\n')

function nowDescriptor() {
  const f = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TZ })
  return f.format(new Date())
}

function buildDetectPrompt({ name, channel, transcriptText }) {
  return [
    `Hoje é ${nowDescriptor()} (fuso America/Sao_Paulo). Isso serve só pra você saber o que é passado/futuro — NÃO use pra resolver "amanhã": resolva relativo ao horário de cada mensagem (ver regra de data).`,
    'Fuso de saída: America/Sao_Paulo (offset -03:00).',
    `Canal: ${channel}. Conversa com: ${name || 'a pessoa'}.`,
    '',
    'Formato de saída (JSON):',
    '{',
    '  "temCompromisso": true|false,',
    '  "titulo": "curto, ex: Encontro com Fulana",',
    '  "inicioIso": "RFC3339 com offset -03:00, ex: 2026-07-25T20:00:00-03:00",',
    '  "fimIso": "RFC3339 ou null — se combinaram duração (15 min, 30 min, 1 hora), CALCULE o fim a partir do início; não deixe null nesses casos",',
    '  "comQuem": "nome da pessoa ou null",',
    '  "confianca": 0.0 a 1.0,',
    '  "trecho": "citação curta da conversa que fundamenta"',
    '}',
    'Regras: se não houver compromisso, responda {"temCompromisso": false}. Se a data foi combinada mas sem horário claro, use um horário plausível e baixe a confiança (<= 0.5). Nunca invente um compromisso que não foi combinado.',
    '',
    'CONVERSA (EU = usuário, ELA = a outra pessoa):',
    transcriptText || '(sem histórico)',
  ].join('\n')
}

function parseJson(text) {
  let t = String(text || '').trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a < 0 || b < 0 || b < a) return null
  try { return JSON.parse(t.slice(a, b + 1)) } catch { return null }
}

// Roda o extrator sobre uma conversa. Devolve o compromisso normalizado ou null.
export async function detectCommitment({ personId, name, channel }) {
  const history = buildHistory(personId, name)
  if (!history.messages || !history.messages.length) return null
  const transcript = recentTranscript(history, 16_000)
  if (!transcript.text) return null
  const prompt = buildDetectPrompt({ name, channel, transcriptText: transcript.text })
  const { text } = await gerarTexto({
    prompt,
    baseInstructions: INSTRUCTIONS,
    effort: 'low',
    usageMeta: { origin: 'agenda_compromissos', trigger: 'automatico', personId, channel },
  })
  const j = parseJson(text)
  if (!j || j.temCompromisso !== true) return null
  const startMs = Date.parse(j.inicioIso)
  if (!j.titulo || Number.isNaN(startMs)) return null
  const confidence = Math.max(0, Math.min(1, Number(j.confianca) || 0))
  return {
    title: String(j.titulo).slice(0, 200),
    startsAtIso: new Date(startMs).toISOString(),
    endsAtIso: j.fimIso && !Number.isNaN(Date.parse(j.fimIso)) ? new Date(Date.parse(j.fimIso)).toISOString() : null,
    withPerson: j.comQuem ? String(j.comQuem).slice(0, 120) : (name || null),
    confidence,
    sourceQuote: j.trecho ? String(j.trecho).slice(0, 400) : null,
  }
}
