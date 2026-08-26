// Perfil completo do Tinder usado para contextualizar uma conversa. Bio sozinha não cobre
// interesses, prompts, intenção, formação, trabalho e outros campos estruturados.
// Duas regras preservam os dados:
//   1. o roster leve regravava o match sem bio/cidade e o UPSERT punha NULL por cima
//      (corrigido com COALESCE em `upsertTinderMatch`);
//   2. bio nunca foi o perfil. O endpoint `/user/{id}` entrega interesses, prompts
//      respondidos, o que ela procura, faculdade, trabalho, pets, signo, distância.
//
// RECEITA (como isto funciona sem gastar token, pra sempre): uma requisição GET autenticada
// a `api.gotinder.com/user/{other_id}` com os headers de device do dono, e uma função pura
// que recorta o JSON pro formato que o `compactProfile` já sabe ler. Nenhum modelo participa
// da extração — o modelo só recebe o resultado pronto e escreve. Descobrir custou tokens;
// usar custa zero.
//
// O `other_id` é o id dela dentro do match — já está no banco (`tinder_match.other_id`).

// Distância vem em milhas na API e ninguém no Brasil pensa em milhas.
function km(distanceMi) {
  const n = Number(distanceMi)
  if (!Number.isFinite(n) || n < 0) return null
  return `${Math.round(n * 1.60934)} km de você`
}

function idade(birthDate) {
  if (!birthDate) return null
  const d = new Date(birthDate)
  if (Number.isNaN(d.getTime())) return null
  const anos = Math.floor((Date.now() - d.getTime()) / 31557600000)
  return anos > 0 && anos < 120 ? anos : null
}

const texto = (v) => {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim()
  return s || null
}

// "Trabalho" no Tinder é `{title:{name}, company:{name}}`, e qualquer um dos dois pode faltar.
function trabalho(jobs) {
  const partes = (Array.isArray(jobs) ? jobs : []).map((j) => {
    const t = texto(j?.title?.name)
    const c = texto(j?.company?.name)
    return t && c ? `${t} na ${c}` : t || c
  }).filter(Boolean)
  return partes.length ? partes.join('; ') : null
}

function estudo(schools) {
  const nomes = (Array.isArray(schools) ? schools : []).map((s) => texto(s?.name)).filter(Boolean)
  return nomes.length ? nomes.join('; ') : null
}

// Os "descritores" são as fichinhas do perfil: pets, signo, bebida, linguagem do amor.
// Alguns vêm com `name` indefinido (categoria que o app não rotula) — esses saem fora, e é
// por isso que o filtro é por par completo e não por presença de chave.
function descritores(lista) {
  const out = []
  for (const d of Array.isArray(lista) ? lista : []) {
    const rotulo = texto(d?.name) || texto(d?.prompt)
    const valor = (Array.isArray(d?.choice_selections) ? d.choice_selections : [])
      .map((c) => texto(c?.name)).filter(Boolean).join(', ')
    if (rotulo && valor) out.push(`${rotulo}: ${valor}`)
  }
  return out
}

// Os prompts respondidos são o melhor material de abertura que existe no perfil: é ela
// escrevendo por escolha própria, sobre um assunto que ela mesma escolheu.
function prompts(up) {
  const lista = Array.isArray(up?.prompts) ? up.prompts : Array.isArray(up) ? up : []
  return lista.map((p) => {
    const q = texto(p?.question_text || p?.question)
    const a = texto(p?.answer_text || p?.answer)
    return q && a ? `${q} ${a}` : null
  }).filter(Boolean)
}

function interesses(ui) {
  const sel = ui?.selected_interests || ui?.interests || ui
  return (Array.isArray(sel) ? sel : []).map((i) => texto(i?.name) || texto(i)).filter(Boolean)
}

// FUNÇÃO PURA: entra o JSON cru do Tinder, sai o formato que `compactProfile` já consome.
// Pura de propósito — dá pra testar com um JSON salvo, sem rede e sem sessão viva.
export function normalizarPerfil(bruto) {
  const p = bruto && typeof bruto === 'object' ? (bruto.results || bruto) : null
  if (!p) return null

  const detalhes = [...prompts(p.user_prompts), ...descritores(p.selected_descriptors)]
  const musica = (Array.isArray(p.spotify_top_artists) ? p.spotify_top_artists : [])
    .map((a) => texto(a?.name)).filter(Boolean).slice(0, 5)
  if (musica.length) detalhes.push(`Escuta: ${musica.join(', ')}`)
  // Interesse em comum é o melhor material de abertura que existe, e vai DENTRO de
  // `details` de propósito: `compactProfile` tem chaves fixas e descartaria uma chave nova
  // em silêncio — além de que acrescentar chave lá mudaria o prompt de todos os canais, e a
  // regra é otimizar sem mudar o comportamento de quem não pediu.
  const comum = (Array.isArray(p.common_interests) ? p.common_interests : [])
    .map((i) => texto(i?.name)).filter(Boolean)
  if (comum.length) detalhes.unshift(`Vocês dois curtem: ${comum.join(', ')}`)

  const perfil = {
    age: idade(p.birth_date),
    city: texto(p.city?.name),
    distance: km(p.distance_mi),
    bio: texto(p.bio),
    work: trabalho(p.jobs),
    education: estudo(p.schools),
    // O que ela procura ("Algo sério, mas vamos ver...") é intenção declarada por ela.
    goals: [texto(p.relationship_intent?.body_text)].filter(Boolean),
    interests: interesses(p.user_interests),
    details: detalhes,
  }
  const temAlgo = Object.values(perfil).some((v) => (Array.isArray(v) ? v.length > 0 : v != null))
  return temAlgo ? perfil : null
}

// Quanto o perfil realmente diz. Serve pra decidir se vale a pena buscar de novo e pra
// relatar honestamente quanto da base tem material — "158 de 461" em vez de "tem perfil".
export function riquezaDoPerfil(perfil) {
  if (!perfil) return 0
  return (perfil.bio ? 2 : 0) + (perfil.work ? 1 : 0) + (perfil.education ? 1 : 0)
    + (perfil.interests?.length ? 2 : 0) + (perfil.details?.length ? Math.min(3, perfil.details.length) : 0)
    + (perfil.goals?.length ? 1 : 0)
}

// O QUE A IA VÊ. Ponto único: todo lugar que gera mensagem no Tinder chama isto, pra não
// existir de novo um caminho que manda só a bio e outro que manda o perfil.
// As colunas do match são o piso e o perfil completo enriquece por cima — nunca o contrário,
// porque a coluna pode estar preenchida e o perfil ter vindo vazio.
export function perfilDoMatch(accountKey, match, { getTinderPerfil }) {
  const base = { bio: match?.bio || null, city: match?.city || null, age: match?.age || null }
  const cheio = match?.match_id ? getTinderPerfil(accountKey, match.match_id) : null
  if (!cheio) return base
  return { ...cheio, bio: cheio.bio || base.bio, city: cheio.city || base.city, age: cheio.age || base.age }
}

// O mesmo, quando só se tem o person_id (o botão do painel, a iniciativa, o "chamar").
// Devolve `undefined` fora do Tinder de propósito: `profile: undefined` é exatamente o que
// esses caminhos já passavam nos outros canais, então nada muda pra quem não é do Tinder.
export function perfilDaPessoa(accountKey, personId, { tinderMatchPorPessoa, getTinderPerfil }) {
  const row = personId ? tinderMatchPorPessoa(accountKey, personId) : null
  return row ? perfilDoMatch(accountKey, row, { getTinderPerfil }) : undefined
}

// A VARREDURA. Percorre quem ainda não teve perfil buscado e guarda. Roda devagar de
// propósito: são centenas de matches e a API do Tinder corta quem vai rápido demais — e um
// corte aqui derruba a sessão inteira, que é o que sustenta o envio de mensagem.
//
// Marca `perfil_checked_at` inclusive quando o perfil vem vazio ou some (404): sem isso a
// varredura volta nos mesmos perfis pobres pra sempre e nunca alcança o resto da fila.
export async function varrerPerfis({ api, accountKey, limite = 40, pausaMs = 1200, deps }) {
  const { tinderSemPerfil, setTinderPerfil, logEvent } = deps
  const fila = tinderSemPerfil(accountKey, { limite })
  let guardados = 0, vazios = 0, sumiram = 0, erros = 0
  for (const m of fila) {
    try {
      const bruto = await api.userProfile(m.other_id)
      if (!bruto) { setTinderPerfil({ accountKey, matchId: m.match_id, perfil: null }); sumiram++; continue }
      const perfil = normalizarPerfil(bruto)
      setTinderPerfil({ accountKey, matchId: m.match_id, perfil })
      perfil ? guardados++ : vazios++
    } catch (e) {
      erros++
      // Erro seguido é rate limit ou sessão caída; insistir piora. Para e volta no próximo tick.
      if (erros >= 3) { logEvent?.({ type: 'tinder_perfil_parou', detail: `parou em ${guardados + vazios + sumiram} de ${fila.length}: ${e?.message || e}` }); break }
    }
    if (pausaMs) await new Promise((r) => setTimeout(r, pausaMs))
  }
  // O total da fila vai junto para que uma execução parcial nunca pareça cobertura completa.
  return { pedidos: fila.length, guardados, vazios, sumiram, erros }
}
