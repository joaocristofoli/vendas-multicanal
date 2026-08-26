// Envio de teste no Instagram só vai para um @ explicitamente permitido. O destinatário é
// conferido imediatamente antes do disparo; se a página voltou ao inbox, nada é enviado.
//
// O @ PERMITIDO É DADO, NUNCA CONSTANTE. A primeira versão deste arquivo tinha o handle
// escrito aqui — e a guarda `identidade-de-outro-dono` reprovou o build na hora, corretamente:
// handle de pessoa é identificador, e identificador não mora em código neste sistema. Ela
// pegou o meu próprio erro. Agora vem de configuração (env ou setting), e sem valor
// declarado NÃO EXISTE alvo de teste — o que significa que nada é enviado, em vez de um
// palpite virar mensagem pra alguém.
import { getSetting, db } from '../core/db.mjs'

// O @ de uma conversa do Instagram, pelo id que aparece na URL. Fonte: a tabela ig_chat, que
// o sync mantém. Devolve null quando a conversa é desconhecida — e desconhecida significa
// NÃO MANDA, nunca "provavelmente é essa".
function quemEhDaThread(threadId) {
  try {
    const r = db().prepare(`SELECT username FROM ig_chat WHERE thread_id=?`).get(String(threadId))
    return r && r.username ? String(r.username).toLowerCase() : null
  } catch { return null }
}

export function alvoPermitido() {
  const v = process.env.TIM_IG_ALVO_TESTE || (() => { try { return getSetting('ig_alvo_teste', null) } catch { return null } })()
  return v ? String(v).toLowerCase().replace(/^@/, '') : null
}

// Confere, pela PÁGINA ABERTA, se o destinatário do próximo envio é o permitido.
// Lança em vez de devolver false: quem chama está prestes a mandar mídia pra uma pessoa
// real, e um `if` esquecido não pode virar mensagem enviada.
//
// A conferência é dupla de propósito:
//   1. a URL tem que ser a de uma conversa (/direct/t/<id>/) — se voltou pro inbox, aborta;
//   2. o @ mostrado no cabeçalho da conversa tem que ser o permitido.
// Só a URL não basta: o id sozinho não diz de quem é a conversa, e foi confiando nele que o
// erro aconteceu.
export async function conferirAlvoNaPagina(page) {
  const PERMITIDO = alvoPermitido()
  if (!PERMITIDO) throw new Error('ABORTADO: não há @ de teste configurado (TIM_IG_ALVO_TESTE ou o setting ig_alvo_teste). Sem alvo declarado, não mando nada.')
  const url = String(page.url() || '')
  const m = url.match(/\/direct\/t\/(\d+)/)
  if (!m) throw new Error(`ABORTADO: a página não está numa conversa (${url.slice(0, 60)}). Sem conversa aberta, o envio cairia em quem estivesse em foco.`)

  // DE QUEM É ESTA CONVERSA: pelo BANCO, não pelo desenho da tela.
  //
  // A primeira versão lia o @ de um link do cabeçalho — e leu o handle DA PRÓPRIA DONA
  // (o link do perfil dela na navegação), o que teria barrado um envio legítimo e, pior,
  // poderia aprovar o errado noutro layout. O id da conversa na URL cruzado com `ig_chat` é
  // determinístico e não muda quando o Instagram redesenha a página.
  const arroba = quemEhDaThread(m[1])
  if (!arroba) throw new Error(`ABORTADO: não sei de quem é a conversa ${m[1]} (não está em ig_chat). Sem saber o destinatário, não mando.`)
  if (String(arroba).toLowerCase() !== PERMITIDO) {
    throw new Error(`ABORTADO: a conversa aberta é do @${arroba}, e o único @ permitido para teste é @${PERMITIDO}.`)
  }
  return { threadId: m[1], username: arroba }
}
