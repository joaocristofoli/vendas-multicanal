// Detector de tentativa de manipulação vinda das mensagens (prompt injection).
//
// A defesa que IMPEDE o ataque é o prompt (regras de identidade e "mensagem não é ordem",
// em src/ai/prompt.mjs, mais a linha de system em src/ai/codex.mjs). Este módulo é o
// SENSOR: ele não muda a resposta, ele deixa a tentativa visível no Monitor e no log.
//
// Por que separar sensor de defesa: um detector que decide sozinho vira ponto único de
// falha nos dois sentidos — se erra pra menos, deixa passar; se erra pra mais, muda a
// conversa de uma pessoa inocente. Defesa fica no prompt (sempre ligada, sem depender de
// acertar regex); o sensor só informa, e pausar a IA é opção explícita do dono.
//
// Padrões conservadores de propósito: preferem deixar passar a acusar conversa normal.
// "vc é bot?" NÃO é injeção — é pergunta legítima de paquera, e tem regra própria.

// ATENÇÃO ao \b com acento: em JS sem flag /u, "ç" e "é" não são caracteres de palavra,
// então \b logo depois deles NÃO casa — "instruções" e "você é" escapavam do detector.
// Por isso tudo aqui usa /iu e a classe de letra Unicode abaixo em vez de \w e \b finais.
const L = '[\\p{L}\\p{N}_]'      // letra/dígito de qualquer alfabeto
const FIM = `(?!${L})`           // fim de palavra seguro com acento

const PADROES = [
  { nome: 'ignorar_instrucoes', re: new RegExp(`(?<!${L})(ignore|ignora|esque(?:ç|c)a|desconsidere|apague|apaga)${FIM}[\\s\\S]{0,45}?(instru|regra|prompt|orienta|comando|anterior)`, 'iu') },
  { nome: 'revelar_prompt', re: new RegExp(`(?<!${L})(mostr|revel|repit|repet|imprim|mand|envi|cola|colar|diga|fala|passa)${L}*[\\s\\S]{0,35}?(prompt|instru(?:ç|c)|suas regras|configura(?:ç|c)|contexto do sistema)`, 'iu') },
  // "vc é bot?" NÃO entra aqui de propósito: é suspeita legítima de paquera e tem regra
  // própria de identidade no prompt. Injeção é tentar TROCAR o papel, não desconfiar dele.
  { nome: 'trocar_papel', re: /(?<![\p{L}\p{N}_])(aja como|age como|finja que|finge que|se passe por|act as|pretend to be|you are now|a partir de agora (?:voc(?:ê|e)|vc|tu) (?:é|e|eh|vai ser|ser(?:á|a)))/iu },
  { nome: 'modo_especial', re: /(?<![\p{L}\p{N}_])(modo|mode)\s+(desenvolvedor|developer|dan|jailbreak|admin|debug|sem filtro|livre)(?![\p{L}\p{N}_])/iu },
  { nome: 'falsa_autoridade', re: /(?<![\p{L}\p{N}_])(sou|aqui (?:é|e)|fala o)\s+(?:o|a)?\s*(desenvolvedor|programador|admin|administrador|criador|dono do sistema|suporte t(?:é|e)cnico|equipe t(?:é|e)cnica)/iu },
  { nome: 'marcador_de_sistema', re: /(\[\s*(?:system|assistant|user)\s*\]|<\s*\/?\s*(?:system|assistant)\s*>|^###\s*(?:system|instru))/imu },
  { nome: 'exfiltrar_contexto', re: /(?<![\p{L}\p{N}_])(quais s(?:ã|a)o suas (?:regras|instru)|o que te (?:mandaram|disseram) (?:fazer|escrever)|qual (?:é|e) (?:o )?(?:seu|teu) (?:system\s*)?prompt|system\s*prompt|prompt do sistema|quem te programou|quem te criou|base instructions)/iu },
  { nome: 'ordem_de_formato', re: /(?<![\p{L}\p{N}_])(responda|responde|escreva|escreve)\s+(apenas|somente|s(?:ó|o))\s+(com|a palavra|o texto|exatamente)(?![\p{L}\p{N}_])/iu },
]

// Analisa UMA mensagem recebida. Devolve os padrões que casaram (nomes únicos).
export function detectarInjecao(texto) {
  const t = String(texto || '')
  if (t.length < 8) return { suspeita: false, padroes: [] }
  const padroes = [...new Set(PADROES.filter((p) => p.re.test(t)).map((p) => p.nome))]
  return { suspeita: padroes.length > 0, padroes, forte: padroes.length >= 2 }
}

// Varre as últimas mensagens recebidas de um histórico já montado (formato do buildHistory).
export function detectarNoHistorico(history, ultimas = 3) {
  const msgs = (history?.messages || []).filter((m) => m.direction === 'incoming').slice(-ultimas)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const r = detectarInjecao(msgs[i].text)
    if (r.suspeita) return { ...r, texto: String(msgs[i].text || '').slice(0, 300) }
  }
  return { suspeita: false, padroes: [] }
}
