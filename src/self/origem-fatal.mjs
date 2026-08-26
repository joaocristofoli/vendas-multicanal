// ORIGEM FATAL MODELS — política da linhagem, não identidade.
//
// Medido na instancia-b em 15/08/2026: 352 pessoas no WhatsApp mencionaram "fatal".
// 343 vieram do widget do anúncio ("vi seu perfil na Fatal" + fatal.fm/…). O resto
// escreveu na mão ("te vi no fatal", "vi seu contato na fatal", "do fatal"). UMA
// mensagem com "fatal" NÃO era cliente: o texto da plataforma pedindo vídeo de
// comprovação, que cita "fatal model" como exemplo de logo. `contem: fatal` pega
// as 352 e o staff — é o erro que esta função existe pra não cometer.
//
// Por isso o matcher vive em CÓDIGO, não numa regra editável do painel: apagar ou
// afrouxar a regra no clone faria o próximo anúncio etiquetar a plataforma como
// cliente. A etiqueta "Fatal" nasce com o motor (garantir no boot e no clonar.sh).
// O id do anúncio de UMA pessoa não entra aqui — só o domínio da plataforma.
//
// Retroage UMA vez por instância (o histórico já chegou). Mensagem nova passa
// por addMessage → aplicarRegras, que lê as regras desta etiqueta.
import { db, getSetting, setSetting, logEvent } from '../core/db.mjs'
import { pessoaCanonica } from './identidade.mjs'
import {
  criarEtiqueta, salvarRegras, marcarPessoa,
  pessoasDaEtiqueta, regraCasa, listarEtiquetas,
} from './etiquetas.mjs'

export const FATAL_NOME = 'Fatal'
export const FATAL_COR = 'azul'
export const FATAL_RETROATIVO_CHAVE = 'origem_fatal_retroativo_em'

// A lista é fechada e medida. Frase de ORIGEM (viu o anúncio / veio pelo site),
// nunca a palavra solta. "fatal.fm" pega o link do widget mesmo quando a quebra
// de linha separa o caminho (`fatal.fm` + `\n/…`).
// AMPLIADA EM 15/08/2026, medindo de novo: um cliente escreveu "oii te achei no fatal" e
// passou batido — a lista só conhecia o verbo VER. Medição no corpus (506 mensagens com a
// palavra, 356 pessoas reconhecidas): exatamente 2 escapavam, e uma delas é a mensagem da
// plataforma, que TEM que escapar. Os verbos de descoberta entram um a um, sempre colados a
// "no/na fatal" — a palavra solta continua proibida, que é o erro que esta lista evita.
// O TETO É 20 REGRAS POR ETIQUETA (etiquetas.mjs), e ele é bom: obriga a lista a ficar
// pensada em vez de crescer por acúmulo. Por isso a ancoragem mudou do VERBO para o
// SUBSTANTIVO — "perfil no fatal" cobre "vi seu perfil", "achei seu perfil" e "encontrei seu
// perfil" numa regra só, e o dia em que aparecer um verbo novo ela já estará coberta.
// O que NÃO pode virar regra: "no fatal" solto, porque "no fatal tava 15min 100$" é alguém
// falando do preço do site, não declarando origem.
export const FATAL_REGRAS = [
  { tipo: 'contem', texto: 'perfil no fatal' },
  { tipo: 'contem', texto: 'perfil na fatal' },
  { tipo: 'contem', texto: 'contato no fatal' },
  { tipo: 'contem', texto: 'contato na fatal' },
  { tipo: 'contem', texto: 'anuncio no fatal' },
  { tipo: 'contem', texto: 'anuncio na fatal' },
  { tipo: 'contem', texto: 'achei no fatal' },
  { tipo: 'contem', texto: 'achei na fatal' },
  { tipo: 'contem', texto: 'encontrei no fatal' },
  { tipo: 'contem', texto: 'encontrei na fatal' },
  { tipo: 'contem', texto: 'te vi no fatal' },
  { tipo: 'contem', texto: 'te vi na fatal' },
  { tipo: 'contem', texto: 'pelo fatal' },
  { tipo: 'contem', texto: 'fatal.fm' },
  { tipo: 'exata', texto: 'do fatal' },
  { tipo: 'exata', texto: 'do fatal model' },
  { tipo: 'exata', texto: 'da fatal' },
  { tipo: 'exata', texto: 'pela fatal' },
  { tipo: 'exata', texto: 'vim do fatal' },
  { tipo: 'exata', texto: 'vim da fatal' },
]

export function veioDaFatal(texto) {
  const t = String(texto || '')
  if (!t.trim()) return false
  return FATAL_REGRAS.some((r) => regraCasa(r, t))
}

export function etiquetaFatal() {
  return listarEtiquetas().find((e) => String(e.nome).toLowerCase() === FATAL_NOME.toLowerCase()) || null
}

// Idempotente. Cria se faltar, marca como da linhagem, e REPOE as regras do código:
// o painel não pode afrouxar isto. Cor só é gravada na criação — quem opera pode
// trocar a cor depois sem o próximo boot devolver ao azul.
export function garantirEtiquetaFatal() {
  let etq = etiquetaFatal()
  if (!etq) {
    etq = criarEtiqueta({ nome: FATAL_NOME, cor: FATAL_COR, sistema: true })
  } else if (!etq.sistema) {
    db().prepare(`UPDATE etiqueta SET sistema=1 WHERE id=?`).run(etq.id)
    etq = { ...etq, sistema: 1 }
  }
  salvarRegras({ id: etq.id, regras: FATAL_REGRAS, sistema: true })
  return etiquetaFatal()
}

// Percorre o histórico RECEBIDO e marca quem já veio pela Fatal. Roda UMA vez
// por instância: repetir no boot recolocaria a marca em quem opera tirou à mão.
// `forcar: true` é o caminho de um matcher novo, não o do restart.
export function retroagirFatal({ forcar = false } = {}) {
  const etq = garantirEtiquetaFatal()
  if (!forcar && getSetting(FATAL_RETROATIVO_CHAVE, null)) {
    return { pulou: true, etiquetaId: etq.id, novas: 0, jaTinham: pessoasDaEtiqueta(etq.id).length }
  }
  const ja = new Set(pessoasDaEtiqueta(etq.id).map((p) => p.personId))
  const rows = db().prepare(`
    SELECT person_id, text FROM message
    WHERE direction='incoming' AND text IS NOT NULL AND text != ''
      AND lower(text) LIKE '%fatal%'
    ORDER BY ts ASC`).all()
  const vistas = new Set()
  let novas = 0
  for (const row of rows) {
    if (!veioDaFatal(row.text)) continue
    const canonica = pessoaCanonica(row.person_id) || row.person_id
    if (!canonica || vistas.has(canonica) || ja.has(canonica)) continue
    marcarPessoa({ personId: canonica, etiquetaId: etq.id })
    vistas.add(canonica)
    ja.add(canonica)
    novas++
  }
  setSetting(FATAL_RETROATIVO_CHAVE, Date.now())
  if (novas) {
    logEvent({
      type: 'etiqueta_fatal_retroativa',
      detail: `${novas} pessoa(s) do histórico — regra da linhagem, não palavra solta`,
    })
  }
  return { pulou: false, etiquetaId: etq.id, novas, jaTinham: ja.size - novas }
}
