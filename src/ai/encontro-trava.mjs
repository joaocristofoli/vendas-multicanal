// A IA não marca encontro sem autorização. A trava detecta proposta, confirmação, horário e
// local; tenta reescrever e, se insistir, não envia. Conversa comum sobre lugares continua livre.

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Convite explícito: "bora", "vamos", "topa", "que tal" perto de algo que se faz junto.
const CONVITE = /\b(bora|vamos|vamo|partiu|topa|que tal|quem sabe|a gente podia|a gnt podia|podia ser)\b/
const PROGRAMA = /\b(sushi|jantar|janta|almoc|cafe|cinema|bar|balada|praia|role|rolezinho|sair|encontro|date|drink|cerveja|churrasco|motel|passeio|viajar|dar uma volta)\b/

// Combinação direta: independe de programa, já é marcar.
const MARCAR = [
  /\bmarcar\b/, /\bmarcamos\b/, /\bcombinar\b/, /\bcombinamos\b/, /\bcombinado\b/,
  /\bte busco\b/, /\bte pego\b/, /\bpasso ai\b/, /\bvou ai\b/, /\bvem aqui\b/, /\bvem ca\b/,
  /\bnos ver\b/, /\bte ver\b/, /\bte conhecer pessoalmente\b/, /\bao vivo\b/,
  /\bpessoalmente\b/, /\bcara a cara\b/, /\bolhando pra tua cara\b/,
  /\bte espero\b/, /\bte aguardo\b/, /\bfechado entao\b/, /\bfica combinado\b/,
]

// Marcar dia/hora: "que dia", "quando tu vier", "sexta", "fim de semana" — só conta como
// proposta quando aparece junto de convite ou programa, senão pega conversa comum ("sexta eu
// trabalho").
const QUANDO = /\b(que dia|qual dia|quando (tu|voce|vc)|que horas|fim de semana|final de semana|amanha|sabado|domingo|sexta a noite)\b/

// O convite IMPLÍCITO, que foi o que escapou na primeira versão do detector e é a forma mais
// comum de marcar sem parecer que marcou: "quando tu vier, a gente escolhe um pra testar".
// Não tem "bora" nem "vamos" — tem uma condição de chegada mais um plano no plural. Para a
// pessoa do outro lado, isso É um combinado.
const CHEGADA = /\bquando (tu|voce|vc) (vier|chegar|passar|estiver|vir)\b|\bquando vier\b|\bse tu vier\b/
const PLANO_JUNTOS = /\b(a gente|a gnt|nois|nos dois)\b.{0,40}\b(sai|sair|escolhe|escolher|testa|testar|toma|tomar|janta|jantar|almoca|almocar|marca|marcar|combina|combinar|se ve|se encontra|vai|conhece)\b/


// Aceitar horário ou local também cria compromisso. Estas listas só valem quando a conversa recente já está falando de
// encontro (o `contexto`): "pra mim 22h" respondendo "que horas você dorme" é conversa
// comum, e bloquear isso seria trocar um erro caro por um monte de erro barato — mas
// repetido, que é como se perde uma voz.
const ACEITE_HORA = [
  /\b(pra|por) mim\s*(as|a)?\s*\d{1,2}\s*(h|hrs|horas)?\b/,
  /\b\d{1,2}\s*h\s*(da|ta bom|fica bom|pra mim|serve)\b/,
  /\b(pode ser|fechou|fica|combinado|beleza|blz|ta bom|topo)\s*(as|a|pras|pra)?\s*\d{1,2}\s*(h|hrs|horas)?\b/,
  /\b(nesse|desse|esse) hor[a]rio\b/,
]
const ACEITE_LOCAL = [
  /\bpode ser (outro|nesse|esse|ali|la)\b/,
  /\b(escolhemos|escolho|escolhe voce|voce escolhe|tanto faz o lugar)\b/,
  /\bno centro\b/,
]
// "Me avisa quando chegar" é a frase que fecha um encontro sem parecer que fechou: ela
// pressupõe que o encontro existe e só falta a hora exata.
const AVISO_CHEGADA = [
  /\bme (avisa|avise|chama|fala)\b.{0,30}\b(quando|assim que)\b.{0,20}\b(chegar|estiver|vier|sair|acabar)\b/,
  /\b(quando|assim que)\b.{0,20}\b(chegar|estiver aqui|vier)\b.{0,30}\bme (avisa|avise|chama)\b/,
]

// A conversa recente está tratando de encontro? É o que separa aceite de papo comum.
// `lugar` e `centro` ficaram DE FORA de propósito: são genéricas demais pra dizer que a
// conversa é sobre encontro ("pode ser outro lugar?" falando de vaga de emprego virava
// bloqueio). Elas continuam valendo como ACEITE — mas só depois que outra palavra estabelecer
// que o assunto é encontrar-se.
const CONTEXTO_ENCONTRO = /\b(encontr|sair|sairmos|nos ver|te ver|cafe|cafeteria|jantar|janta|almoc|cinema|bar|balada|role|passeio|drink|cerveja|marcar|combinar|te busco|chegar em|vou pra|venho pra|pessoalmente)\b/

export function propoeEncontro(texto, { contexto = '' } = {}) {
  const t = norm(texto)
  if (!t.trim()) return { propoe: false }
  const ctx = norm(contexto)
  const contextoSobreEncontro = CONTEXTO_ENCONTRO.test(ctx)
  for (const re of MARCAR) {
    if (re.test(t)) return { propoe: true, motivo: `combina ou confirma encontro ("${(t.match(re) || [''])[0]}")` }
  }
  const temConvite = CONVITE.test(t)
  const temPrograma = PROGRAMA.test(t)
  if (temConvite && temPrograma) return { propoe: true, motivo: 'convida pra um programa juntos' }
  // A pergunta pode negociar horário sem repetir o programa; o contexto recente decide.
  if (QUANDO.test(t) && (temPrograma || contextoSobreEncontro)) return { propoe: true, motivo: 'negocia dia ou hora de um encontro já em pauta' }
  if (CHEGADA.test(t)) return { propoe: true, motivo: 'combina algo pra quando ele vier (convite implícito)' }
  if (PLANO_JUNTOS.test(t)) return { propoe: true, motivo: 'propõe um plano no plural ("a gente...")' }

  // ---- ACEITE: só com a conversa já falando de encontro (ver o bloco lá em cima) ----
  // Quem estabelece que o assunto é encontro é a CONVERSA. O rascunho sozinho só conta com
  // marcador forte — senão a própria frase que se quer avaliar cria o contexto que a condena.
  const FORTE = /\b(encontr|nos ver|te ver|pessoalmente|te busco|marcar|combinar)\b/
  const conversaSobreEncontro = contextoSobreEncontro || FORTE.test(t)
  if (conversaSobreEncontro) {
    for (const re of AVISO_CHEGADA) {
      if (re.test(t)) return { propoe: true, motivo: 'trata o encontro como combinado ("me avisa quando chegar")' }
    }
    for (const re of ACEITE_HORA) {
      if (re.test(t)) return { propoe: true, motivo: `aceita horário de encontro ("${(t.match(re) || [''])[0].trim()}")` }
    }
    for (const re of ACEITE_LOCAL) {
      if (re.test(t)) return { propoe: true, motivo: `aceita/escolhe o lugar do encontro ("${(t.match(re) || [''])[0].trim()}")` }
    }
  }
  return { propoe: false }
}

export function instrucaoSemEncontro(v) {
  return [
    `A resposta anterior ${v.motivo}, e isso não pode sair de jeito nenhum.`,
    'Você NUNCA propõe, sugere, confirma ou combina encontro, date, passeio, ligação marcada nem "ver ao vivo" — nem de forma indireta, nem como brincadeira.',
    'Se ele propôs, receba bem, com simpatia, SEM marcar nada: não confirme horário, não escolha nem aceite lugar, não diga "me avisa quando chegar", não dê data e não prometa. Aceitar o que ele propôs vale como marcar.',
    'Reescreva a resposta sem nenhuma marcação de encontro.',
  ].join(' ')
}
