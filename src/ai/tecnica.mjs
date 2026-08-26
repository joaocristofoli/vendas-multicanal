// Técnica de conversa calculada por pessoa e momento. O movimento sugerido é:
// reagir ao que o contato disse, compartilhar algo verdadeiro e deixar um gancho.
// Evita técnicas manipulativas e só usa fatos configurados pela própria pessoa usuária.
import { readFileSync } from 'node:fs'
import { pontesPath } from '../core/caminhos.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../core/db.mjs'

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// ---------------------------------------------------------------- a ponte (rapport)
// A ponte não é "fale de você" — é cruzar um fato DELA com a vida DE QUEM FALA. A diferença
// importa: "eu curto BoJack" é sobre quem fala; "tu é dessa cidade? passo lá direto" é sobre
// os dois. A segunda cria vínculo, a primeira só informa.
//
// A ponte é sempre SUGESTÃO, nunca texto pronto: quem escreve é o modelo, que tem o tom. E
// só entram fatos REAIS de quem fala — inventar coincidência é mentira que desmonta na
// primeira pergunta de volta.
//
// POR QUE O FATO NÃO MORA AQUI (mudança do vendas-multicanal, 31/07/2026): antes cada terreno trazia
// o fato biográfico do dono chumbado no código, em texto corrido. Isso amarra o motor a UMA
// pessoa: ao clonar o sistema para outra, a biografia do dono antigo viaja dentro do .js e
// vaza na voz da pessoa nova — sem aparecer em nenhum arquivo de identidade, que é onde
// alguém procuraria. Agora o código guarda só o MECANISMO (que tema o texto dela toca) e o
// fato vem de `pontes.json`, junto do resto da identidade. Chave sem fato = terreno sem
// ponte: o silêncio é o padrão seguro, nunca um fato herdado.
//
// O terreno 'cidade' não tem gatilho embutido pelo mesmo motivo: a lista de cidades é a
// região de QUEM FALA, não uma constante do mundo. Ela vem do arquivo (campo `gatilhos`).
const TERRENOS = [
  { chave: 'cidade', dela: null },
  { chave: 'saude/hospital', dela: /\b(enfermeir|medic|médic|fisioterap|farmac|hospital|enfermagem|tecnic[oa] de enfermagem|cuidador|saude|saúde|psicolog|nutri|odonto|dentista|biomedic)\b/i },
  { chave: 'biologia/ambiental', dela: /\b(biolog|agronom|ambient|veterinar|veterinár|zootec|quimic|químic|engenharia ambiental|ecolog)\b/i },
  // 'analista', 'dados' e 'programa' saíram daqui em 27/07/2026: analista pode ser de banco,
  // de RH ou clínico; 'programa' casa com programa de TV; 'dados' casa com jogo de dados.
  // Foi assim que a IA afirmou uma coincidência de profissão que não existia, e a pessoa
  // respondeu que o trabalho dela não tinha nada a ver. Palavra ambígua não vira ponte:
  // vira PERGUNTA (ver VAGOS abaixo).
  { chave: 'tecnologia', dela: /\b(ti\b|programa(dor|ç|c)|desenvolv|sistemas|computac|computaç|tecnolog)\b/i },
  { chave: 'aviacao', dela: /\b(aviac|aviaç|aeroport|piloto|comissari|comissári|voo|aeronaut)\b/i },
  { chave: 'musica', dela: /\b(musica|música|trap|rap|funk|show|cantar|banda|sertanej|pagode|forro|forró|festival)\b/i },
  { chave: 'cinema/serie', dela: /\b(serie|série|filme|netflix|cinema|anime|desenho|ficcao|ficção|comedia|comédia|assist)\b/i },
  { chave: 'academia/esporte', dela: /\b(academia|treino|musculac|musculaç|corrida|crossfit|luta|futebol|volei|vôlei|bike|pedal|trilha)\b/i },
  { chave: 'faculdade', dela: /\b(faculdade|universidade|mestrado|doutorado|tcc|estagi|formanda|formando)\b/i },
  { chave: 'pet', dela: /\b(cachorr|gat[oa]s?\b|pet|dog|bichinho)\b/i },
]

// Os fatos de quem fala, por terreno. Arquivo JSON simples ({ "<chave>": "<fato>" }) que vive
// junto da identidade, não do código, e é relido sozinho — dá pra corrigir um fato errado sem
// deploy. Leitura SÍNCRONA de propósito: `pontes()` é chamada dentro da montagem do prompt,
// que é síncrona, e o arquivo tem algumas linhas.
const LOCAL_PONTES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'sobre-mim-fontes', 'pontes.json')
const TTL_PONTES = 60_000
let cachePontes = { fatos: null, at: 0 }

// Cada chave aceita duas formas:
//   "chave": "o fato"                                  -> usa o gatilho embutido do terreno
//   "chave": { "fato": "...", "gatilhos": ["x","y"] }  -> troca o gatilho pelo dela
// Os gatilhos são ESCAPADOS antes de virar regex: vêm de um arquivo editável à mão, e um
// parêntese solto derrubaria o detector inteiro em silêncio (é a lição dos chips crus na UI).
const escapaRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function fatosDePonte() {
  if (cachePontes.fatos && Date.now() - cachePontes.at < TTL_PONTES) return cachePontes.fatos
  let cru = {}
  for (const p of [pontesPath(), LOCAL_PONTES]) {
    try {
      const lido = JSON.parse(readFileSync(p, 'utf8'))
      if (lido && typeof lido === 'object') { cru = lido; break }
    } catch { /* sem arquivo = sem ponte, e isso é um estado válido */ }
  }
  const fatos = {}
  for (const [chave, v] of Object.entries(cru)) {
    const fato = typeof v === 'string' ? v : v?.fato
    if (!fato || typeof fato !== 'string' || !fato.trim()) continue
    const lista = Array.isArray(v?.gatilhos) ? v.gatilhos.filter((g) => typeof g === 'string' && g.trim()) : []
    let re = null
    if (lista.length) {
      try { re = new RegExp(`\\b(${lista.map(escapaRe).join('|')})\\b`, 'i') } catch { re = null }
    }
    fatos[chave] = { fato: fato.trim(), re }
  }
  cachePontes = { fatos, at: Date.now() }
  return fatos
}

// O QUE ELA DISSE MAS NÃO EXPLICOU. Rótulo que descreve a pessoa e não diz nada de concreto:
// "analista" (de banco? de RH? clínico?), "faço faculdade" (de quê?), "trabalho numa empresa"
// (fazendo o quê?). Antes, "analista" era gatilho de ponte com tecnologia e a IA afirmava a
// coincidência; a pessoa respondeu que o trabalho dela não tinha nada a ver com o dele.
//
// O regra do sistema: "quando não tiver certeza de algo da pessoa, pergunte". Perguntar aqui é
// barato e rende: é interesse genuíno em cima de algo que ELA trouxe, que é exatamente a
// pergunta que funciona (medido: com pergunta 72% de resposta, sem 38%).
//
// A negativa `(?!\s+(de|em|da|do|na|no)\s)` é o que separa vago de específico: "analista de
// dados" já está explicado e não vira pergunta; "analista" sozinho vira.
const VAGOS = [
  { chave: 'analista', re: /\banalist[ao]\b(?!\s+(de|em|da|do|na|no)\s)/i, pergunta: 'analista de quê, de qual área' },
  { chave: 'trabalho', re: /\b(trabalho|trabalha|empresa|servi[cç]o)\b(?!\s+(de|com|em|na|no|numa|num)\s)/i, pergunta: 'com o que ela trabalha exatamente' },
  { chave: 'area', re: /\b([áa]rea|setor|ramo)\b(?!\s+(de|da|do)\s)/i, pergunta: 'qual área' },
]

// O PERFIL DO TINDER DÁ O RECIPIENTE, NUNCA O CONTEÚDO. Caso que mostrou isso (fixture sintética
// Monteiro, 27/07/2026): o perfil trazia `education: "Universidade da Amazônia"` e o
// descritor "Formação: Fazendo faculdade" — a instituição e o NÍVEL. O curso não estava em
// lugar nenhum. A IA escreveu "juntou dois universitários de lados opostos do país, eu fiz
// o mesmo curso": afirmou identidade em comum e contou o curso DELE sem nunca perguntar o
// dela. Ela mesma teve que oferecer depois ("passei em biologia mas escolhi a odontologia").
//
// Isso não é regex de palavra vaga, é uma regra ESTRUTURAL: sabe-se que ela estuda e não se
// sabe O QUÊ. Por isso a checagem é "existe sinal de faculdade E não existe nome de curso em
// nada que se sabe dela".
// Sem `\b` no fim de propósito: estes são PREFIXOS. Com a barra final, "universit[áa]ri"
// nunca casaria com "universitária" — o defeito que a primeira versão desta regra teve.
const SINAL_FACULDADE = /\b(faculdade|universidade|universit[áa]ri|gradua[cç][ãa]o|cursando|curso superior|estudante|formand[oa]|semestre|superior (completo|incompleto)|fazendo faculdade)/i

// Nome de curso. Lista curta de propósito: o custo de errar é UMA pergunta a mais sobre algo
// que ela já contou, e a trava de "já perguntei" impede insistir. O custo de não perguntar é
// a IA supor — que é o defeito que estamos consertando.
const CURSOS = /\b(direito|medicina|enfermagem|psicolog|odontolog|biolog|agronom|veterin[áa]r|engenharia|arquitetur|administra[cç]|cont[áa]beis|pedagog|farm[áa]c|nutri[cç]|fisioterap|design|computa[cç]|sistemas de informa|an[áa]lise e desenvolvimento|letras|hist[óo]ria|geografia|jornalismo|publicidade|marketing|educa[cç][ãa]o f[íi]sica|est[ée]tica|radiolog|biomedic|zootecn|qu[íi]mica|f[íi]sica|matem[áa]tica|servi[cç]o social|turismo|gastronomia|fonoaudiolog|terapia ocupacional|ci[êe]ncias? (sociais|cont[áa]beis|biol[óo]gicas)|rela[cç][õo]es internacionais|com[ée]rcio exterior)/i

// O que ela deixou no ar e ainda não foi perguntado. `minhasMensagens` entra pra não mandar
// perguntar duas vezes a mesma coisa — insistir numa pergunta que já foi feita é pior que
// não perguntar.
export function incertezas({ mensagensDela = [], minhasMensagens = [], perfilTexto = '' } = {}) {
  const doTexto = (ms) => (ms || []).slice(-8).map((m) => (typeof m === 'string' ? m : m?.text) || '').join(' ')
  const falas = doTexto(mensagensDela)
  // O PERFIL entra junto. Sem isto, o caso que gerou esta regra passaria batido: a fixture sintética
  // nunca escreveu "faculdade" numa mensagem — estava só no perfil dela.
  const tudoDela = `${falas} ${perfilTexto || ''}`.trim()
  if (!tudoDela) return []
  const minhas = norm(doTexto(minhasMensagens))
  const jaPerguntei = (marca) => minhas.includes(norm(marca)) && /\?/.test(minhas)

  const out = []
  // A estrutural primeiro: é a que mais rende, porque quase todo perfil de Tinder tem
  // instituição ou nível e quase nenhum tem o curso.
  const fac = tudoDela.match(SINAL_FACULDADE)
  if (fac && !CURSOS.test(tudoDela) && !jaPerguntei('curso') && !jaPerguntei('faculdade')) {
    out.push({ chave: 'curso', gatilho: fac[0], pergunta: 'QUAL curso ela faz — o perfil dá a faculdade e o nível, nunca a matéria' })
  }
  for (const v of VAGOS) {
    const m = tudoDela.match(v.re)
    if (!m || jaPerguntei(m[0])) continue
    out.push({ chave: v.chave, gatilho: m[0], pergunta: v.pergunta })
    if (out.length >= 2) break   // duas já é muito; mais que isso vira formulário
  }
  return out.slice(0, 2)
}

// Procura terreno comum entre o que se sabe DELA (bio, perfil, o que ela escreveu) e a vida
// dele. Devolve no máximo 2 — mais que isso vira lista, e lista o modelo ignora.
export function pontes({ bio = '', perfil = '', mensagensDela = [] } = {}) {
  const dela = norm([bio, perfil, ...(mensagensDela || []).slice(-12).map((m) => m.text || m)].join(' '))
  if (!dela.trim()) return []
  const achou = []
  const fatos = fatosDePonte()
  for (const t of TERRENOS) {
    // Sem fato declarado pra esta chave não existe ponte: o tema até casa, mas não há nada
    // REAL pra cruzar, e ponte inventada é mentira que cai na primeira pergunta de volta.
    const decl = fatos[t.chave]
    if (!decl) continue
    const re = decl.re || t.dela
    if (!re) continue // terreno sem gatilho embutido e sem gatilho declarado: não dá pra detectar
    const m = dela.match(re)
    if (m) achou.push({ chave: t.chave, gatilho: m[0], dele: decl.fato })
    if (achou.length >= 2) break
  }
  return achou
}

// ---------------------------------------------------------------- o jeito DELA
// Nem todo mundo responde igual. Medido: pergunta ajuda em 28 de 43 pessoas, é neutra em 11
// e ATRAPALHA em 4. Então o padrão é forte (perguntar), e isto é só a correção quando a
// evidência daquela pessoa for clara — nunca um chute com 3 mensagens.
export function jeitoDaPessoa(personId, { minimo = 10 } = {}) {
  let ms = []
  try {
    ms = db().prepare(`SELECT direction, text, ts FROM message WHERE person_id=? AND text IS NOT NULL ORDER BY ts`).all(personId)
  } catch { return null }
  if (ms.length < minimo) return null

  const casos = []
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i]
    if (m.direction !== 'outgoing') continue
    if (!ms.slice(0, i).some((x) => x.direction === 'incoming')) continue
    const prox = ms[i + 1]
    casos.push({ resp: !!(prox && prox.direction === 'incoming'), perg: /\?/.test(m.text), longa: (m.text || '').length > 45 })
  }
  const comP = casos.filter((c) => c.perg), semP = casos.filter((c) => !c.perg)
  const taxa = (a) => (a.length ? a.filter((c) => c.resp).length / a.length : null)

  const sinais = []
  // só fala quando há amostra dos dois lados — sem isso é ruído com cara de dado
  if (comP.length >= 4 && semP.length >= 4) {
    const ganho = taxa(comP) - taxa(semP)
    if (ganho <= -0.15) sinais.push('com ESTA pessoa, pergunta atrapalha: ela responde menos quando você pergunta. Prefira afirmar e comentar; deixe a pergunta pra quando for realmente necessária.')
    else if (ganho >= 0.25) sinais.push('com ESTA pessoa, pergunta funciona muito: ela quase sempre volta quando você deixa um gancho.')
  }
  const dela = ms.filter((m) => m.direction === 'incoming')
  const tamDela = dela.length ? dela.reduce((s, m) => s + (m.text || '').length, 0) / dela.length : 0
  if (dela.length >= 5 && tamDela < 15) sinais.push('ela escreve MUITO curto. Não despeje texto: mensagem curta, um gancho por vez.')
  else if (dela.length >= 5 && tamDela > 60) sinais.push('ela escreve bastante. Pode desenvolver mais e contar coisa sua com detalhe.')

  return sinais.length ? sinais : null
}

// ---------------------------------------------------------------- o bloco do prompt
// Só entra quando é conversa de paquera — o dono foi explícito que isto NÃO é o
// comportamento padrão dele em toda conversa, e sim no Tinder/Badoo e no modo paquera.
const MODOS_PAQUERA = new Set(['romance-paquera', 'romance-quente'])
export function valeAqui({ channel, mode, vinculo }) {
  if (channel === 'tinder' || channel === 'badoo') return true
  if (mode && MODOS_PAQUERA.has(mode)) return true
  if (vinculo && /paquera|romance|ficante/i.test(String(vinculo))) return true
  return false
}

// O movimento base. Curto de propósito: instrução longa dilui, e isto precisa ser o que o
// modelo lembra na hora de escrever.
const MOVIMENTO = [
  'COMO CONSTRUIR A MENSAGEM (nesta ordem, sem precisar dos três sempre):',
  '1. REAJA ao que ela acabou de dizer — uma linha que mostra que você leu, não que você esperou a vez de falar.',
  '2. CONTE algo concreto seu que se encaixe: o que você tava fazendo, um gosto, uma história curta. CONCRETO ganha de genérico ("BoJack" e não "desenhos"; "o nome do bairro ou da cidade" e não "aqui perto"). Dê o contexto — de onde saiu esse assunto —, senão soa do nada.',
  '3. DEIXE um gancho: uma pergunta genuína, ou um assunto no ar que peça continuação.',
  'Nunca só o passo 3 (vira interrogatório) e nunca só o passo 2 (vira monólogo). Contar algo seu SEM abrir espaço pra ela é o pior dos dois mundos — medido.',
  'Quando algo dito lá atrás voltar a fazer sentido, retome ("me lembrei disso agora"). Isso cria um fio só de vocês.',
  'NOMEIE A COISA, não a categoria: diga "BoJack" e não "desenho adulto", "o nome do bairro ou da cidade" e não "aqui perto", "o nome do curso" e não "a área". Categoria soa vago e às vezes soa mal; nome próprio dá o que responder.',
].join('\n')

export function blocoDeTecnica({ channel, mode, vinculo, personId, bio, perfil, mensagensDela, minhasMensagens } = {}) {
  if (!valeAqui({ channel, mode, vinculo })) return ''
  const linhas = [MOVIMENTO, '']
  const inc = incertezas({ mensagensDela, minhasMensagens, perfilTexto: `${bio || ''} ${perfil || ''}` })
  if (inc.length) {
    linhas.push('O QUE VOCÊ AINDA NÃO SABE SOBRE ELA (pergunte, não suponha):')
    for (const i of inc) linhas.push(`- ela falou "${i.gatilho}" e isso não diz ${i.pergunta}. NÃO trate como se você soubesse e NÃO afirme que tem a ver com o que você faz. Pergunte, com interesse de verdade, não como quem preenche ficha.`)
    linhas.push('')
  }
  const ps = pontes({ bio, perfil, mensagensDela })
  if (ps.length) {
    linhas.push('TERRENO COMUM (use se couber, com naturalidade — nunca force e nunca invente):')
    for (const p of ps) linhas.push(`- ela tem a ver com "${p.gatilho}" e ${p.dele}. Se der, comente essa coincidência de um jeito leve e deixe um gancho — é o que cria conexão de verdade.`)
    linhas.push('Regra: só use se for VERDADE sobre você. Coincidência inventada desmonta na primeira pergunta de volta.')
  }
  const jeito = personId ? jeitoDaPessoa(personId) : null
  if (jeito) { linhas.push('COMO ESTA PESSOA RESPONDE (medido nas conversas de vocês):'); for (const s of jeito) linhas.push(`- ${s}`) }
  return linhas.join('\n')
}

export { TERRENOS, VAGOS, CURSOS, SINAL_FACULDADE }
