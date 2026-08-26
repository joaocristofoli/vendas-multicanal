// Vínculo por pessoa: quem ela É para o dono (persistente), vindo do tagueamento das 294
// pessoas (25/07/2026, leitura do corpus inteiro — docs/vinculos-pessoas.csv).
//
// A descoberta que manda no desenho: cada pessoa tem UM registro de base estável, e o
// assunto troca de camada mensagem a mensagem DENTRO dele. Então vínculo não é "modo que
// se soma": é o registro base; a variação de assunto fica descrita no próprio módulo.
//
// O que isto controla:
//   1. REGISTRO — vínculo não-romântico seleciona um módulo curto com o vocabulário real
//      daquela relação, e o estilo integral de paquera (17KB) sai do prompt: entra o núcleo
//      de voz (~3KB). É a maior economia de token por geração fora do transcript.
//   2. AVISO — ia_pode='nao' e bot geram aviso no Diário quando a IA responde ali. NUNCA
//      bloqueiam: a fonte da verdade é SEMPRE o toggle da conversa (regra do dono, 25/07).
//   3. Paquera/romance e quem não tem vínculo: NADA muda — comportamento aprovado.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../core/db.mjs'
import { pessoaCanonica, idsBrutosDaPessoa } from './identidade.mjs'
import { VINCULOS_DIR } from '../core/caminhos.mjs'

const agora = () => Date.now()

// Vínculos de base romântica: seguem o comportamento aprovado de hoje (estilo integral,
// sem módulo). O como-eu-converso É o manual de paquera — lá ele é conteúdo, não custo.
// sexting saiu daqui em 25/07: o manual fala de carinho e call, não daquilo — ele tem
// módulo próprio (era um dos buracos que o corpus apontou).
export const VINCULOS_ROMANTICOS = new Set(['paquera', 'romance', 'afeto-antigo'])

// CATÁLOGO ÚNICO — o menu do painel lê daqui (antes a UI tinha uma lista própria de 5
// modos, que não conversava com os 20 vínculos do tagueamento: duas verdades na mesma
// tela). Ordem = a que faz sentido pro dono escolher, não alfabética.
export const CATALOGO = [
  { valor: 'paquera', label: 'Paquera', desc: 'flerte inicial, estilo Tinder', grupo: 'Romântico' },
  { valor: 'romance', label: 'Romance', desc: 'relação quente, rotina de carinho', grupo: 'Romântico' },
  { valor: 'sexting', label: 'Sexting', desc: 'papo explícito, já rolando', grupo: 'Romântico' },
  { valor: 'afeto-antigo', label: 'Afeto antigo', desc: 'história que já foi, carinho que ficou', grupo: 'Romântico' },
  { valor: 'amigo', label: 'Amigo', desc: 'zoeira pesada e objetividade', grupo: 'Pessoal' },
  { valor: 'amiga-confidente', label: 'Amiga confidente', desc: 'íntima, sem ser romance', grupo: 'Pessoal' },
  { valor: 'familia', label: 'Família', desc: 'telegráfico, sem cerimônia', grupo: 'Pessoal' },
  { valor: 'comunidade', label: 'Comunidade', desc: 'grupo, vizinhança, coletivo', grupo: 'Pessoal' },
  { valor: 'socio', label: 'Sócio', desc: 'sócio de empresa ou projeto', grupo: 'Trabalho' },
  { valor: 'parceiro-negocio', label: 'Parceiro de negócio', desc: 'parceria, troca de trampo', grupo: 'Trabalho' },
  { valor: 'equipe', label: 'Equipe', desc: 'quem você paga ou coordena', grupo: 'Trabalho' },
  { valor: 'cliente', label: 'Cliente', desc: 'cliente ou família de paciente', grupo: 'Trabalho' },
  { valor: 'prof-externo', label: 'Profissional externo', desc: 'quem atende você', grupo: 'Trabalho' },
  { valor: 'rede-negocio', label: 'Rede de negócio', desc: 'mentoria, social selling', grupo: 'Trabalho' },
  { valor: 'corre', label: 'Fornecedor', desc: 'corre, combinação curta', grupo: 'Trabalho' },
  { valor: 'institucional', label: 'Institucional', desc: 'autoridade, instituição', grupo: 'Público' },
  { valor: 'politica', label: 'Política', desc: 'articulação, assessoria', grupo: 'Público' },
  { valor: 'imprensa', label: 'Imprensa', desc: 'jornalista, veículo', grupo: 'Público' },
  { valor: 'bot', label: 'Bot / sistema', desc: 'canal automático, não é gente', grupo: 'Outro' },
  { valor: 'self', label: 'Eu mesmo', desc: 'seu próprio número', grupo: 'Outro' },
]

// REGRA DO HUMANO (25/07/2026, dita duas vezes): a fonte da verdade é SEMPRE o toggle da
// conversa. O tagueamento NUNCA bloqueia — ele INFORMA. Se o dono ligar a IA pro pai, pra
// um cliente ou pra um bot, é decisão dele e ela responde. O que o vínculo 'nao' gera é
// um AVISO no Diário quando a IA responde ali, pra decisão nunca ser invisível.

// Vínculos sem gasto de memória de fundo: consolidar "memória" de bot/self é turno jogado fora.
export const SEM_MEMORIA = new Set(['bot', 'self'])

export function salvarVinculo({ personId, vinculo, extras = '', camadas = '', iaPode = 'cuidado', evidencia = '', origem = 'manual' }) {
  const pid = pessoaCanonica(personId)
  // vínculo vazio = "Sem vínculo" no menu: apaga a linha em vez de gravar lixo
  if (!vinculo) { db().prepare(`DELETE FROM pessoa_vinculo WHERE person_id=?`).run(pid); return pid }
  db().prepare(`INSERT INTO pessoa_vinculo(person_id,vinculo,extras,camadas,ia_pode,evidencia,origem,updated_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(person_id) DO UPDATE SET vinculo=excluded.vinculo, extras=excluded.extras,
      camadas=excluded.camadas, ia_pode=excluded.ia_pode, evidencia=excluded.evidencia,
      origem=excluded.origem, updated_at=excluded.updated_at`)
    .run(pid, vinculo, extras, camadas, ['sim', 'cuidado', 'nao'].includes(iaPode) ? iaPode : 'cuidado', evidencia, origem, agora())
  return pid
}

// Vínculo da pessoa, olhando TODOS os ids dela (o tagueamento pode ter sido feito num id
// bruto que depois foi unido). null = pessoa sem tag -> comportamento atual, intacto.
//
// FALLBACK DO TINDER (regra do sistema, 25/07/2026): quem chegou pelo Tinder e nunca foi
// tagueada nasce como PAQUERA — é o que ela é por definição do canal. Sem isso, match novo
// caía em "sem vínculo" e a IA tratava igual a um contato qualquer. É fallback, não
// gravação: basta o dono escolher outro vínculo no menu que a escolha dele vence.
export function vinculoDaPessoa(personId) {
  const ids = (() => { try { return idsBrutosDaPessoa(personId) } catch { return [String(personId)] } })()
  const marks = ids.map(() => '?').join(',')
  const r = db().prepare(`SELECT * FROM pessoa_vinculo WHERE person_id IN (${marks}) ORDER BY updated_at DESC LIMIT 1`).get(...ids)
  if (r) return r
  try {
    const doTinder = db().prepare(`SELECT 1 FROM tinder_match WHERE person_id IN (${marks}) LIMIT 1`).get(...ids)
    if (doTinder) return { person_id: String(personId), vinculo: 'paquera', extras: '', camadas: '', ia_pode: 'cuidado', evidencia: 'veio do Tinder', origem: 'padrao-tinder' }
  } catch { /* banco parcial */ }
  return null
}

// 'sim' | 'cuidado' | 'nao' | null (sem tag). Informação do tagueamento — nunca trava.
export function iaPodeEscrever(personId) {
  return vinculoDaPessoa(personId)?.ia_pode || null
}

// Aviso informativo (NUNCA bloqueia — o toggle manda). String quando o tagueamento marcou
// a pessoa como delicada pra IA; null nos demais. Vai pro Diário quando a IA responde ali.
export function avisoDeVinculo(personId) {
  const v = vinculoDaPessoa(personId)
  if (!v) return null
  if (v.vinculo === 'bot') return 'atenção: este contato é um BOT — a IA está conversando com outra IA'
  if (v.ia_pode === 'nao') return `atenção: o tagueamento marcou este vínculo (${v.vinculo}) como delicado pra IA responder`
  return null
}

// ---------- módulos de registro (um .md curto por vínculo) ----------
const VINC_DIR = VINCULOS_DIR
const LOCAL_VINC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'sobre-mim-vinculos')

const cacheMod = new Map() // vinculo -> { text, at }
const TTL = 60_000

export async function moduloDoVinculo(vinculo) {
  if (!vinculo || VINCULOS_ROMANTICOS.has(vinculo)) return null
  const hit = cacheMod.get(vinculo)
  if (hit && agora() - hit.at < TTL) return hit.text
  for (const dir of [VINC_DIR, LOCAL_VINC]) {
    try {
      const text = (await readFile(path.join(dir, vinculo + '.md'), 'utf8')).trim().slice(0, 3500)
      if (text) { cacheMod.set(vinculo, { text, at: agora() }); return text }
    } catch { /* tenta o próximo diretório */ }
  }
  cacheMod.set(vinculo, { text: null, at: agora() })
  return null
}

// ---------------------------------------------------------------- editar pela tela
// Até 01/08/2026 o comportamento de cada vínculo só existia como arquivo no servidor: pra
// mudar como ela fala com um cliente era preciso editar .md e fazer deploy. Na prática isso
// significava que os 20 vínculos do menu ficavam vazios — o menu marcava a pessoa e não
// mudava nada no que a IA escrevia, o que é pior que não ter o menu.
//
// Estas três funções são o que a Config usa pra ler e escrever esses módulos. O carregador
// acima relê sozinho a cada minuto, então salvar já vale na próxima geração, sem reiniciar.

// O nome do vínculo NUNCA vira caminho sem passar por aqui. Ele vem da tela, e concatenar
// texto de fora com um diretório é como se escreve num lugar que não era pra escrever:
// "../../env" viraria um arquivo do sistema. Só o que está no catálogo passa.
function vinculoValido(vinculo) {
  return CATALOGO.some((c) => c.valor === vinculo) ? String(vinculo) : null
}

// Lista pra tela: cada vínculo do catálogo com quantas pessoas o usam e se já tem texto.
// "Quantas pessoas" existe pra ela saber por onde começar — escrever o módulo de um vínculo
// que ninguém usa é trabalho jogado fora.
export async function listarModulos() {
  const contagem = contagemVinculos()
  const out = []
  for (const c of CATALOGO) {
    const texto = await moduloDoVinculo(c.valor)
    out.push({
      ...c,
      pessoas: contagem[c.valor] || 0,
      temTexto: !!texto,
      // Os românticos não usam módulo: eles carregam o manual de voz COMPLETO, que é mais
      // rico que qualquer módulo curto. Dizer isso na tela evita ela escrever um arquivo
      // que nunca vai ser lido.
      usaManualCompleto: VINCULOS_ROMANTICOS.has(c.valor),
      tamanho: texto ? texto.length : 0,
    })
  }
  return out
}

export async function lerModulo(vinculo) {
  const v = vinculoValido(vinculo)
  if (!v) throw new Error('vínculo desconhecido')
  for (const dir of [VINC_DIR, LOCAL_VINC]) {
    try { return await readFile(path.join(dir, v + '.md'), 'utf8') } catch { /* tenta o próximo */ }
  }
  return ''
}

export async function salvarModulo(vinculo, texto) {
  const v = vinculoValido(vinculo)
  if (!v) throw new Error('vínculo desconhecido')
  const conteudo = String(texto || '').replace(/\r\n?/g, '\n').trim().slice(0, 3500)
  await mkdir(VINC_DIR, { recursive: true })
  const alvo = path.join(VINC_DIR, v + '.md')
  if (!conteudo) {
    // Apagar é um estado válido: o vínculo volta a não ter comportamento próprio, em vez de
    // ficar com um arquivo vazio que o carregador trata como "existe mas não diz nada".
    try { await rm(alvo) } catch { /* já não existia */ }
    cacheMod.delete(v)
    return { ok: true, apagado: true }
  }
  await writeFile(alvo, conteudo + '\n', 'utf8')
  cacheMod.delete(v)   // o cache é de 60s; sem isto a edição só valeria no próximo minuto
  return { ok: true, tamanho: conteudo.length }
}

// Linha compacta com o resto do contexto do vínculo (extras + camadas vivas). Barata (1-2
// linhas) e é o que faz a IA saber que com ESTA pessoa também circula dinheiro/cuidado/zoeira.
export function vinculoContextoCurto(v) {
  if (!v) return null
  const partes = []
  const extras = String(v.extras || '').split('|').map((s) => s.trim()).filter(Boolean)
  if (extras.length) partes.push(`além do registro principal, com esta pessoa também existe: ${extras.join(', ')}`)
  const camadas = String(v.camadas || '').split('|').map((s) => s.trim()).filter((c) => c && !c.startsWith('ia-'))
  if (camadas.length) partes.push(`assuntos que circulam naturalmente: ${camadas.join(', ')} (a conversa alterna entre eles sem mudar o tom de base)`)
  return partes.length ? partes.join('. ') + '.' : null
}

export function listarVinculos({ limite = 400 } = {}) {
  return db().prepare(`SELECT * FROM pessoa_vinculo ORDER BY updated_at DESC LIMIT ?`).all(limite)
}

export function contagemVinculos() {
  const out = {}
  for (const r of db().prepare(`SELECT vinculo, COUNT(*) n FROM pessoa_vinculo GROUP BY vinculo`).all()) out[r.vinculo] = r.n
  return out
}
