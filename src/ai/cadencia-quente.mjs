// Ritmo opcional para o modo explícito entre adultos e descanso no dia seguinte.
//
// Por que isso é CÓDIGO e não só instrução de prompt: "faz pelo menos 1 dia" é contagem de
// tempo, e o modelo não conta dia de forma confiável (é o mesmo motivo da idade calculada e
// da medida do silêncio). A decisão de estar ou não em descanso é determinística; o prompt só
// recebe o veredito pronto.
//
// O detector é de VOZ, não de moral: ele marca quando a mensagem foi explícita pra saber que
// "houve papo quente hoje". Some por design: ele não julga a pessoa, só cronometra o assunto.
import { db } from '../core/db.mjs'

function garantirTabela() {
  db().exec(`CREATE TABLE IF NOT EXISTS papo_quente (
    person_id TEXT PRIMARY KEY,
    ultimo_ts INTEGER,          -- quando rolou papo explícito pela última vez
    ultimo_dia TEXT             -- o dia (America/Sao_Paulo) desse último papo
  )`)
}

// Palavras/expressões que marcam papo explícito. Lista curta e crua de propósito: é pra
// detectar o REGISTRO, não pra ser dicionário. Erra pra menos (só marca o que é claramente
// sexual), porque marcar de menos custa um pouco de ritmo e marcar de mais cala a conversa à
// toa. A colisão criança+sexo já é barrada antes, em src/ai/filtro.mjs.
const EXPLICITO = /\b(transar|transa|foder|fode|foda|gozar|gozo|goza|tesão|tesao|pau|buceta|xoxota|piru|rola|chupar|chupa|meter|mete|sexo|sexual|gemer|gozada|punheta|siririca|nudes?|pelad[ao]|safad[ao]|delicia de|te comer|me comer|sentar em|sentar na|sarrar)\b/i

export function ehExplicito(texto) {
  return EXPLICITO.test(String(texto || ''))
}

const TZ = 'America/Sao_Paulo'
function diaDe(ts) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ts))
  const g = Object.fromEntries(p.map((x) => [x.type, x.value]))
  return `${g.year}-${g.month}-${g.day}`
}

// Registra que houve papo explícito com esta pessoa AGORA. Chamado depois de a mensagem sair,
// e também quando a pessoa manda algo explícito (o "houve papo quente" vale pros dois lados).
export function marcarPapoQuente(personId, ts = Date.now()) {
  if (!personId) return
  garantirTabela()
  db().prepare(`INSERT INTO papo_quente(person_id,ultimo_ts,ultimo_dia) VALUES(?,?,?)
    ON CONFLICT(person_id) DO UPDATE SET ultimo_ts=excluded.ultimo_ts, ultimo_dia=excluded.ultimo_dia`)
    .run(personId, ts, diaDe(ts))
}

// Está em DESCANSO? Devolve { descanso, porque } — o `porque` vai pro Diário, decisão calada é
// decisão que ninguém audita depois.
//
// A régua é por CALENDÁRIO (fuso dela), não por 24h corridas, porque o dono pediu "no dia
// SEGUINTE" — e 24h corridas dariam um descanso torto: papo às 2h da manhã só descansaria até
// as 2h do outro dia, deixando o resto do "dia seguinte" liberado. Por calendário:
//   - MESMO dia do último papo  -> não descansa (não se corta o papo no meio)
//   - dia imediatamente seguinte -> DESCANSA o dia inteiro
//   - 2+ dias depois            -> liberado de novo
// O Brasil não tem horário de verão desde 2019, então subtrair 24h dá o "ontem" certo no fuso.
export function emDescansoQuente(personId, agora = Date.now()) {
  if (!personId) return { descanso: false }
  garantirTabela()
  const r = db().prepare(`SELECT ultimo_dia FROM papo_quente WHERE person_id=?`).get(personId)
  if (!r || !r.ultimo_dia) return { descanso: false }
  const hoje = diaDe(agora)
  if (r.ultimo_dia === hoje) return { descanso: false }         // mesmo dia: segue
  const ontem = diaDe(agora - 86400000)
  if (r.ultimo_dia === ontem) return { descanso: true, porque: 'houve papo explícito ontem; hoje é dia de descanso' }
  return { descanso: false }                                    // 2+ dias: liberado
}

// O bloco que entra no prompt. '' quando não há descanso (o modo quente, se ligado, segue
// normal, só mais devagar). Em descanso, a instrução é desconversar leve, nunca entrar.
export function blocoCadenciaQuente(personId, { ativo = false } = {}) {
  if (!ativo) return ''
  const d = emDescansoQuente(personId)
  if (d.descanso) {
    return `DESCANSO DO PAPO QUENTE (regra absoluta hoje): vocês tiveram papo explícito recentemente, e o usuário não repete esse assunto no dia seguinte. HOJE, se a pessoa puxar sexo/explícito, NÃO entre: desconverse com leveza e carinho ("hoje não, vem cá", "tô de bom humor pra outra coisa kk", muda de assunto sem cortar o clima), sem soar recatada e sem explicar que "é regra". Papo normal, flerte leve e afeto continuam liberados — o que fica de fora hoje é só o explícito.`
  }
  // Sem descanso: a régua de RITMO. Vale sempre que a conversa tende ao quente, ligada ou não
  // ao modo — é a calibragem de "mais devagar" que o dono pediu.
  return `RITMO DO PAPO QUENTE: o usuário topa papo explícito, mas não corre pra ele. NÃO escale na primeira deixa nem transforme um flerte leve em sexo de imediato — deixe o clima subir aos poucos, com mais troca antes. Quando já estiver claramente nesse ponto e for recíproco, aí sim acompanha no registro dela. Pressa demais é o que ela não gosta.`
}
