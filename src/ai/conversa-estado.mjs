// O QUE ESTÁ ACONTECENDO NESTA CONVERSA, AGORA — calculado, não intuído.
// Detectores baratos identificam assunto esgotado, interrogatório, falta de reciprocidade
// e turnos longos. O modelo recebe o diagnóstico pronto e decide como responder.

// Interjeição pura: ela respondeu, mas não trouxe nada. É o "Ah sim".
// Respostas mínimas como "tá", "sim" e "né" também podem sinalizar assunto esgotado.
const SEM_CONTEUDO = /^(ah?\s*(sim|ta|tá|é|eh|bom|legal)?|sim|nao|não|aham|ahan|uhum|entendi|entendo|nossa|serio|sério|legal|bacana|massa|top|show|que bom|ata|ah ta|ah tá|ta|tá|tah|ss|sm|ne|né|ok|okay|blz|beleza|certo|humm?|hmm+|kk+|ha(ha)+|rs+|😂+|👍+|\.+)$/i

// Assunto de preenchimento — o que a IA repete sem perceber.
// 'hj', 'sextou', 'sono' e 'dormir' entraram em 27/07/2026: a lista antiga não pegava a
// forma abreviada, e "Fez algo de bom hj?" passava batido justamente por causa do 'hj'.
const FIADA = /\b(dia|domingo|sabado|sábado|segunda|sexta|sextou|semana|fim de semana|fds|manha|manhã|tarde|noite|hoje|hj|rotina|correria|descanso|descansar|descansando|folga|tranquil|sono|dormir|dormiu|como (ta|tá|foi|vai)|tudo bem|de boa)\b/i

// Marca de que a mensagem traz algo DELE — fato, opinião, história.
const SUBSTANCIA = /\b(eu (to|tô|sou|faço|faco|trabalho|moro|curto|odeio|acho|prefiro|nunca|sempre)|meu |minha |projeto|acho que|prefiro|odeio|amo|melhor|pior|lembrei|uma vez|já me)\b/i

// O que conta como "falar do que eu faço"; a mesma régua alimenta diagnóstico e freio.
const TRABALHO = /\b(projeto|projetos|ia\b|intelig[êe]ncia artificial|sistema|sistemas|app\b|aplicativo|startup|empresa|neg[óo]cio|mestrado|programa[cç][ãa]o|c[óo]digo|desenvolv|profiss[ãa]o|trabalho|carreira)\b/i

// SÓ CORTESIA: cumprimento e devolução de gentileza. Parece resposta e não traz nada — é
// literalmente o texto das conversas que morreram ("Oii" / "Esta bem e a sua?"). Sem separar
// isto de conteúdo de verdade, a fase de aquecimento parecia superada quando não tinha nem
// começado.
const SO_CORTESIA = /^(oi+|ooi+|ola|olá|eai|e ai|opa|hey|oie+|boa (noite|tarde)|bom dia|tudo bem|td bem|tudo bom)?[\s,.!?]*(e (vc|voce|você|tu|a sua|o seu|contigo))?[\s,.!?]*(tudo bem|td bem|tudo bom|bem)?[\s,.!?]*$/i

// ELA TRAZENDO ALGO DELA — régua própria, mais larga que SUBSTANCIA de propósito. SUBSTANCIA
// mede se a MINHA mensagem tem conteúdo e é usada por outros dois sinais; alargar aquela pra
// resolver isto aqui mexeria neles de lado. Aqui basta um sinal de que ela falou de si:
// "eu tava querendo voltar a treinar" conta, e a lista fechada de verbos não pegava "tava".
const TRAZ_DE_SI = /\b(eu|meu|minha)\b|\b(tava|tinha|queria|quero|gosto|curto|odeio|adoro|prefiro|trabalho|estudo|moro|faço|faco|comecei|terminei|passei)\b/i

const limpo = (t) => String(t || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// TURNO = mensagens seguidas da mesma pessoa. Ninguém escreve parágrafo no Tinder, escreve
// três bolhas seguidas; contar bolha por bolha faz um desabafo de três mensagens parecer
// três frases soltas, e é exatamente aí que a IA responde curto sem perceber o tamanho do
// que recebeu.
function turnos(ms) {
  const out = []
  for (const m of ms) {
    const ultimo = out[out.length - 1]
    const texto = String(m.text || '')
    if (ultimo && ultimo.direction === m.direction) { ultimo.textos.push(texto); ultimo.chars += texto.length }
    else out.push({ direction: m.direction, textos: [texto], chars: texto.length })
  }
  return out
}

const PERGUNTA = (t) => /\?/.test(String(t || ''))

// `mensagens` = a timeline no formato do buildHistory ({ direction, text }), em ordem.
export function estadoDaConversa(mensagens) {
  const ms = (Array.isArray(mensagens) ? mensagens : []).filter((m) => m && m.text)
  if (ms.length < 2) return { sinais: [], vazio: true }

  const ultimaDela = [...ms].reverse().find((m) => m.direction === 'incoming')
  const minhas = ms.filter((m) => m.direction === 'outgoing')
  const ultimas3 = minhas.slice(-3)
  const ultimas4 = minhas.slice(-4)

  const ts = turnos(ms)
  const turnoDela = [...ts].reverse().find((t) => t.direction === 'incoming') || null
  const meusTurnos = ts.filter((t) => t.direction === 'outgoing')

  // COMEÇO TRAVADO: conversa nova E ela ainda não engajou. Não é contagem de mensagem — a
  // primeira versão cortava em "6 mensagens" e isso reprovava conversa boa (ela respondendo
  // com conteúdo já na terceira) e calava o detector de interrogatório numa conversa que era
  // interrogatório de verdade. O que separa é ELA: duas respostas com conteúdo de verdade,
  // ou uma que traga algo dela, e a fase de aquecimento acabou.
  const delas = ms.filter((m) => m.direction === 'incoming')
  const comConteudo = delas.filter((m) => !SEM_CONTEUDO.test(limpo(m.text)) && !SO_CORTESIA.test(limpo(m.text))).length
  const elaEngajou = comConteudo >= 2
    || delas.some((m) => !SO_CORTESIA.test(limpo(m.text)) && (TRAZ_DE_SI.test(m.text) || String(m.text).length >= 60))
  const comecoTravado = ms.length <= 6 && !elaEngajou

  const sinais = []

  // 1. Resposta sem conteúdo: trate o assunto como esgotado.
  if (ultimaDela && SEM_CONTEUDO.test(limpo(ultimaDela.text))) {
    sinais.push({
      chave: 'assunto_morreu',
      texto: `A última mensagem dela foi só "${String(ultimaDela.text).trim()}" — isso quer dizer que o assunto ACABOU. NÃO continue nele nem comente sobre ele. Traga algo diferente: uma coisa sua, uma observação, um convite. Se você insistir no mesmo tema, a conversa morre aqui.`,
    })
  }

  // 2. Duas ou mais das minhas últimas 3 foram conversa fiada -> girando em falso.
  const fiadas = ultimas3.filter((m) => FIADA.test(m.text)).length
  if (ultimas3.length >= 2 && fiadas >= 2) {
    sinais.push({
      chave: 'girando_em_falso',
      texto: `Suas últimas mensagens ficaram em cima de dia/rotina/"como vai". Já deu. Puxe um assunto de verdade — algo que VOCÊ curte, faz ou pensa — em vez de mais uma volta no mesmo.`,
    })
  }

  // 3. Nenhuma das últimas 4 trouxe algo da pessoa usuária.
  if (ultimas4.length >= 3 && !ultimas4.some((m) => SUBSTANCIA.test(m.text))) {
    sinais.push({
      chave: 'sem_substancia',
      texto: `Faz várias mensagens que você não conta NADA sobre você — só reage e pergunta. Traga algo concreto seu agora (o que você tava fazendo, uma opinião, uma história curta). É o que faz a outra pessoa ter no que se agarrar.`,
    })
  }

  // 4. Interrogatório: perguntas repetidas sem reciprocidade do outro lado.
  const perguntas = ultimas3.filter((m) => /\?\s*$/.test(String(m.text).trim())).length
  const elaTambemPergunta = ms.slice(-6).some((m) => m.direction === 'incoming' && PERGUNTA(m.text))
  // E não vale no começo travado: ali ela ainda não sabe se tem interesse, então não pergunta
  // de volta — sem esta ressalva o sinal calaria a IA exatamente na fase em que puxar assunto
  // é obrigação de quem tem interesse, e o conselho brigaria com o do começo.
  const interrogando = !comecoTravado && ultimas3.length >= 3 && perguntas >= 2 && !elaTambemPergunta
  if (interrogando) {
    sinais.push({
      chave: 'interrogatorio',
      texto: `Você já fez pergunta em quase toda mensagem recente. Esta NÃO pode terminar em pergunta: afirme, conte, reaja.`,
    })
  }

  // 5. Turno longo merece cobertura proporcional; compara bolhas e caracteres.
  const meuTurnoMedio = meusTurnos.length
    ? Math.round(meusTurnos.reduce((s, t) => s + t.chars, 0) / meusTurnos.length) : 0
  if (turnoDela && (turnoDela.textos.length >= 2 || turnoDela.chars >= 130)
      && turnoDela.textos.some((t) => SUBSTANCIA.test(t) || t.length >= 60)) {
    // Considera o turno inteiro, não apenas a mensagem mais longa.
    const oQueEla = turnoDela.textos.join(' / ').slice(0, 260)
    const cabecalho = `Ela acabou de se abrir: ${turnoDela.textos.length} mensagem(ns), ${turnoDela.chars} caracteres`
      + (meuTurnoMedio ? ` (as suas vêm tendo ${meuTurnoMedio})` : '') + `. Ela disse: "${oQueEla}".`

    // A orientação escala quando o contato abre várias frentes no mesmo turno.
    const muitasFrentes = turnoDela.textos.length >= 3 || turnoDela.chars >= 260
    sinais.push({
      chave: 'ela_se_abriu',
      texto: muitasFrentes
        ? `${cabecalho} São VÁRIAS frentes de uma vez. Responder uma frase só aqui corta a conversa de quem está se abrindo. Use 2 ou 3 bolhas (cada uma numa LINHA), cada uma sobre um assunto DIFERENTE que ela trouxe: responda o que ela perguntou, reaja ao que ela contou, e comente o que ela nomeou — principalmente nome próprio, que é coisa que ELA escolheu citar. Não é lista nem resposta item por item: são falas soltas e curtas, como quem tem o que dizer sobre mais de um ponto.`
        : `${cabecalho} Responder com uma frase seca aqui soa desinteressado. Escolha UMA coisa específica que ela contou — a mais concreta, não a mais fácil — e entre nela de verdade: reaja àquilo, conte o seu lado daquilo, e deixe espaço pra ela seguir. Não responda item por item nem devolva uma lista espelhando a dela.`,
    })
  }

  // 6. Evita voltar ao próprio trabalho/projeto em mensagens próximas.
  const jaFaleiDisso = ultimas3.filter((m) => TRABALHO.test(m.text)).length
  if (jaFaleiDisso >= 1) {
    sinais.push({
      chave: 'ja_falei_do_meu_trampo',
      texto: `Você já falou do seu trabalho/projeto nas últimas mensagens desta conversa. NÃO puxe isso de novo agora — nem como comparação, nem como exemplo. Se for contar algo seu, que seja de outra parte da sua vida.`,
    })
  }

  // 7. No começo, prioriza assunto concreto do perfil em vez de perguntas genéricas de rotina.
  if (comecoTravado) {
    sinais.push({
      chave: 'comeco_da_conversa',
      texto: `Vocês estão no COMEÇO e ela ainda não contou nada de si — nessa fase ela não sabe se tem interesse, então puxar assunto é obrigação de quem tem. Não deixe a conversa parada e NÃO pergunte sobre o dia, a semana, a rotina ou se ela descansou: metade das conversas que morreram acabou numa pergunta dessas. Pegue algo CONCRETO do perfil dela (interesse, curso, trabalho, o que ela escreveu lá) ou do que ela falou, comente aquilo com uma opinião sua, e pergunte sobre AQUILO. Assunto específico dá a ela o que responder; "como foi seu domingo" não dá.`,
    })
  }

  // 8. Detecta quando só o contato está sustentando a conversa.
  const meusDoisUltimos = meusTurnos.slice(-2)
  if (!interrogando && turnoDela && turnoDela.textos.some(PERGUNTA)
      && meusDoisUltimos.length >= 2 && !meusDoisUltimos.some((t) => t.textos.some(PERGUNTA))) {
    sinais.push({
      chave: 'so_ela_pergunta',
      texto: `Ela perguntou de novo e faz duas rodadas que você só responde, sem devolver nada. Quem está segurando a conversa é ela, e ninguém segura por muito tempo. Responda o que ela perguntou e devolva a bola — sobre o assunto que já está rolando, não um tema novo do nada.`,
    })
  }

  return { sinais, vazio: false }
}

// O bloco que entra no prompt. Vazio quando não há nada a dizer — conversa boa não precisa
// de conselho, e texto inútil no prompt só custa token e dilui o que importa.
// A CONVERSA ESTÁ PEDINDO INICIATIVA? Dois dos sinais acima dizem a mesma coisa por ângulos
// diferentes: `sem_substancia` (faz várias mensagens que eu não trago nada meu) e
// `so_ela_pergunta` (quem segura a conversa é o outro). Quem precisa saber disso é o corretor
// de tamanho: a instrução de encurtar mandava, literalmente, "não acrescente pergunta pra
// puxar assunto, não conte história" — e apagava a iniciativa que o diagnóstico tinha acabado
// de pedir.
//
// Só estes dois, e só quando disparam: iniciativa toda hora vira a outra ponta do defeito —
// a IA monologando em cima de quem não pediu.
export function precisaDeIniciativa(mensagens) {
  const { sinais } = estadoDaConversa(mensagens)
  return sinais.some((s) => s.chave === 'sem_substancia' || s.chave === 'so_ela_pergunta')
}

export function blocoDeSituacao(mensagens) {
  const { sinais } = estadoDaConversa(mensagens)
  if (!sinais.length) return ''
  return ['SITUAÇÃO DESTA CONVERSA AGORA (leia antes de escrever):', ...sinais.map((s) => `- ${s.texto}`)].join('\n')
}

export { SEM_CONTEUDO, FIADA, SUBSTANCIA }
