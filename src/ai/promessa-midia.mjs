// PROMESSA QUE O SISTEMA NÃO PODE CUMPRIR.
//
// Badoo, 12/08/2026, uma hora e sete minutos:
//
//     IA:  Agr criei coragem com a foto / Parei d enrolar kkk
//     ELE: Ta
//     IA:  Ja troquei essa várias vezes / Mais vai essa msm
//     ELE: Ta
//     IA:  Agr vou parar d enrolar / Ta preparado pra foto?
//     ELE: Ta
//     IA:  Então se prepara / Passei a tarde escolhendo essa kkk
//     ELE: Tá
//
// Cinco rodadas anunciando uma foto que nunca foi — o banco de fotos estava VAZIO. Não era
// falta de vontade do modelo: era uma promessa que o sistema não tinha como cumprir, e ele
// não sabia disso. Do outro lado, cada "Ta" é uma pessoa desistindo.
//
// A REGRA: anunciar mídia sem MANDAR na mesma resposta é proibido. Se ela vai mandar foto, o
// rascunho traz `[foto:atalho]` — o marcador é o compromisso. Sem marcador, falar em "vou te
// mandar uma foto" é cheque sem fundo, e o custo é a conversa inteira.
//
// Vale pra todo perfil e todo canal: é regra do sistema, não da pessoa.
const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// O marcador que significa "estou mandando AGORA" (ver wa/saved-image-ai.mjs e saved-audio-ai.mjs).
const MARCADOR = /\[(foto|audio|áudio):[a-z0-9-]+\]/i

// Anúncio de mídia futura. Só o que é PROMESSA — descrever uma foto que já existe na
// conversa ("nessa foto eu tava...") não entra aqui.
const PROMESSA = [
  /\b(vou|vo|posso|podia|ia)\s+(te\s+)?(mandar|manda|enviar|passar|tirar|gravar)\b[^.?!]{0,24}\b(foto|selfie|audio|video|nude)/,
  /\b(te\s+)?(mando|envio|passo)\b[^.?!]{0,20}\b(foto|selfie|audio|video)\b/,
  /\b(foto|selfie|audio|video)\b[^.?!]{0,20}\b(depois|mais tarde|jaja|ja ja|logo|agora)\b/,
  /\bpreparad[oa]\s+pra\s+(a\s+)?(foto|audio|video)\b/,
  /\bse prepara\b[^.?!]{0,18}\b(foto|audio|video)\b/,
  /\b(escolhendo|escolhi|separei|criei coragem)\b[^.?!]{0,18}\b(a\s+)?(foto|selfie)\b/,
  /\b(foto|selfie)\b[^.?!]{0,14}\bvai (sair|indo|essa)\b/,
]

// Devolve { promete, motivo }. `promete:true` = o rascunho ANUNCIA mídia e NÃO manda.
export function prometeMidia(texto) {
  const t = norm(texto)
  if (!t.trim()) return { promete: false }
  if (MARCADOR.test(texto)) return { promete: false }   // está mandando de verdade: pode falar
  for (const re of PROMESSA) {
    const m = t.match(re)
    if (m) return { promete: true, motivo: `anuncia mídia sem mandar ("${m[0].trim().slice(0, 40)}")` }
  }
  return { promete: false }
}

export function instrucaoSemPromessa(v) {
  return [
    `A resposta anterior ${v.motivo}, e isso não pode sair.`,
    'Você NUNCA anuncia foto, áudio ou vídeo que não está mandando nesta mesma mensagem: prometer e não entregar mata a conversa (aconteceu — cinco rodadas de "ta" seguidas).',
    'Se quiser mandar mídia, mande AGORA com o marcador na linha. Se não vai mandar, não fale nela: responda o que ele disse e siga em outro assunto.',
    'Reescreva sem qualquer promessa de mídia.',
  ].join(' ')
}
