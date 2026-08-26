// ETIQUETAS: marcas que quem opera põe nas pessoas, para agrupar por conta própria.
//
// POR QUE NÃO SÃO AS DO WHATSAPP. Etiqueta do WhatsApp é recurso do WhatsApp BUSINESS, e a
// conta desta instância é o app comum (`creds.json` diz `platform: iphone`). Além disso, uma
// etiqueta que só vale no WhatsApp deixaria de fora Tinder, Badoo, Instagram e Telegram — e a
// mesma pessoa costuma existir em mais de um. Regra configurada (14/08/2026): etiqueta é
// NOSSA, vale em todos os canais.
//
// POR QUE NÃO É O VÍNCULO. `self/vinculos.mjs` responde "quem esta pessoa É para a dona" e é
// UM por pessoa — é o registro de fala. Etiqueta é outra coisa: são VÁRIAS por pessoa, livres,
// criadas por quem opera, e servem para acionar coisas (hoje, serviços).
//
// A CHAVE É A PESSOA CANÔNICA, nunca o id de um canal. A mesma pessoa no WhatsApp e no Tinder
// é uma pessoa só: etiquetar por id bruto faria a etiqueta sumir quando a conversa migrasse de
// canal, e é exatamente esse o caso de uso.
import { db } from '../core/db.mjs'
import { pessoaCanonica, idsBrutosDaPessoa } from './identidade.mjs'

const agora = () => Date.now()
const MAX_NOME = 40
const MAX_ETIQUETAS = 60

// Paleta fechada: cor é enum, não texto livre. Um valor de cor vindo do cliente e injetado no
// style vira caminho de CSS injection, e a UI já é escura o bastante para não sobreviver a uma
// cor qualquer.
export const CORES = ['verde', 'azul', 'roxo', 'rosa', 'ambar', 'vermelho', 'cinza']

let pronto = false
function garantirTabelas() {
  if (pronto) return
  db().exec(`CREATE TABLE IF NOT EXISTS etiqueta (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cor TEXT NOT NULL DEFAULT 'cinza',
    criada_em INTEGER NOT NULL
  )`)
  // Nome único SEM diferenciar maiúscula: "Cliente" e "cliente" seriam duas etiquetas na tela
  // e uma confusão só na hora de acionar serviço.
  db().exec(`CREATE UNIQUE INDEX IF NOT EXISTS etiqueta_nome_unico ON etiqueta (lower(nome))`)
  db().exec(`CREATE TABLE IF NOT EXISTS pessoa_etiqueta (
    person_id TEXT NOT NULL,
    etiqueta_id INTEGER NOT NULL,
    criada_em INTEGER NOT NULL,
    PRIMARY KEY (person_id, etiqueta_id)
  )`)
  db().exec(`CREATE INDEX IF NOT EXISTS pessoa_etiqueta_por_etiqueta ON pessoa_etiqueta (etiqueta_id)`)
  // Coluna adicionada depois da tabela existir: quem já tem banco criado não recria nada, só
  // ganha a coluna. O erro de "duplicate column" é o caminho normal na segunda execução.
  try { db().exec(`ALTER TABLE etiqueta ADD COLUMN regras TEXT`) } catch { /* já existe */ }
  // Etiqueta da LINHAGEM (hoje: Fatal). Não se apaga, não se renomeia, regras vêm do código.
  // Sem a coluna, o clone antigo não distingue a que o motor criou da que alguém digitou.
  try { db().exec(`ALTER TABLE etiqueta ADD COLUMN sistema INTEGER NOT NULL DEFAULT 0`) } catch { /* já existe */ }
  // tipo: null = criada por quem opera; 'cidade' = origem automática da cidade da pessoa.
  // Sem isso, "Toledo" misturava com uma etiqueta livre e a união de canais podia deixar
  // DUAS cidades na mesma pessoa.
  try { db().exec(`ALTER TABLE etiqueta ADD COLUMN tipo TEXT`) } catch { /* já existe */ }
  // Como CONVERSAR com quem tem esta marca. É da instância (o texto), não da linhagem
  // (o mecanismo). Fatal nas duas irmãs é a mesma origem; o que isso MUDA na fala é de
  // cada dona — por isso o campo se edita mesmo na etiqueta de sistema.
  try { db().exec(`ALTER TABLE etiqueta ADD COLUMN comportamento TEXT`) } catch { /* já existe */ }
  // FOTO SENSUAL NESTA MARCA (15/08/2026). Quem chega por anúncio adulto pede foto e é
  // atendido; conversa comum, não. A permissão é da ETIQUETA, não do código: assim vale para
  // qualquer marca que a dona criar, e não fica "Fatal" chumbado no motor.
  // Foto de nível `familia` nunca sai, com etiqueta nenhuma — isso é trava de código.
  try { db().exec(`ALTER TABLE etiqueta ADD COLUMN fotos_quentes INTEGER NOT NULL DEFAULT 0`) } catch { /* já existe */ }
  pronto = true
}

const limparNome = (v) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOME)
const corValida = (c) => CORES.includes(String(c || '')) ? String(c) : 'cinza'
const NOME_LINHAGEM = 'fatal'

function rowEtiqueta(id) {
  return db().prepare(`
    SELECT e.id, e.nome, e.cor, e.criada_em AS criadaEm, e.sistema, e.tipo, e.comportamento, e.fotos_quentes AS fotosQuentes,
           (SELECT COUNT(*) FROM pessoa_etiqueta pe WHERE pe.etiqueta_id = e.id) AS pessoas
    FROM etiqueta e WHERE e.id=?`).get(id)
}

export function etiquetaEhSistema(id) {
  garantirTabelas()
  return !!db().prepare(`SELECT sistema FROM etiqueta WHERE id=?`).get(Number(id))?.sistema
}

// A lista, já com quantas pessoas cada uma tem. A contagem é o que mostra a etiqueta esquecida
// sem precisar abrir uma por uma.
export function listarEtiquetas() {
  garantirTabelas()
  return db().prepare(`
    SELECT e.id, e.nome, e.cor, e.criada_em AS criadaEm, e.sistema, e.tipo, e.comportamento,
           (SELECT COUNT(*) FROM pessoa_etiqueta pe WHERE pe.etiqueta_id = e.id) AS pessoas
    FROM etiqueta e ORDER BY e.nome COLLATE NOCASE`).all()
}

export function criarEtiqueta({ nome, cor = 'cinza', sistema = false, tipo = null } = {}) {
  garantirTabelas()
  const limpo = limparNome(nome)
  if (!limpo) throw new Error('dê um nome para a etiqueta')
  // "Fatal" é da linhagem: quem opera não cria outra com o mesmo nome, e o motor
  // só chega aqui com sistema:true (origem-fatal.mjs).
  if (!sistema && limpo.toLowerCase() === NOME_LINHAGEM) {
    throw new Error('Fatal é da linhagem — nasce com o motor, não se cria no painel')
  }
  const tipoLimpo = tipo === 'cidade' ? 'cidade' : null
  // Cidade automática não come a cota de quem opera — senão 40 cidades trancam o painel.
  const manuais = listarEtiquetas().filter((e) => !e.sistema && e.tipo !== 'cidade').length
  if (!sistema && !tipoLimpo && manuais >= MAX_ETIQUETAS) throw new Error(`o máximo é ${MAX_ETIQUETAS} etiquetas`)
  try {
    const r = db().prepare(`INSERT INTO etiqueta(nome,cor,criada_em,sistema,tipo) VALUES(?,?,?,?,?)`)
      .run(limpo, corValida(cor), agora(), sistema ? 1 : 0, tipoLimpo)
    return rowEtiqueta(r.lastInsertRowid)
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) throw new Error(`já existe uma etiqueta chamada "${limpo}"`)
    throw e
  }
}

export function editarEtiqueta({ id, nome, cor } = {}) {
  garantirTabelas()
  const alvo = db().prepare(`SELECT * FROM etiqueta WHERE id=?`).get(Number(id))
  if (!alvo) throw new Error('etiqueta não encontrada')
  if ((alvo.sistema || alvo.tipo === 'cidade') && nome !== undefined && limparNome(nome) !== alvo.nome) {
    throw new Error(alvo.sistema
      ? `"${alvo.nome}" é da linhagem e não muda de nome`
      : `"${alvo.nome}" é cidade da pessoa — o nome é a cidade`)
  }
  const nomeNovo = nome === undefined ? alvo.nome : limparNome(nome)
  if (!nomeNovo) throw new Error('dê um nome para a etiqueta')
  try {
    db().prepare(`UPDATE etiqueta SET nome=?, cor=? WHERE id=?`)
      .run(nomeNovo, cor === undefined ? alvo.cor : corValida(cor), alvo.id)
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) throw new Error(`já existe uma etiqueta chamada "${nomeNovo}"`)
    throw e
  }
  return rowEtiqueta(alvo.id)
}

// Apagar a etiqueta leva junto as marcações dela — e SÓ elas. Nenhuma pessoa é tocada: o que
// some é a marca, nunca o registro de quem quer que seja.
export function apagarEtiqueta(id) {
  garantirTabelas()
  const alvo = Number(id)
  if (!Number.isInteger(alvo)) throw new Error('etiqueta inválida')
  const row = db().prepare(`SELECT nome, sistema FROM etiqueta WHERE id=?`).get(alvo)
  if (row?.sistema) throw new Error(`"${row.nome}" é da linhagem e não se apaga`)
  const marcas = db().prepare(`DELETE FROM pessoa_etiqueta WHERE etiqueta_id=?`).run(alvo).changes
  const apagou = db().prepare(`DELETE FROM etiqueta WHERE id=?`).run(alvo).changes
  return { apagou: apagou > 0, marcasRemovidas: marcas }
}

export function etiquetasDaPessoa(personIdBruto) {
  garantirTabelas()
  const personId = pessoaCanonica(personIdBruto)
  if (!personId) return []
  return db().prepare(`
    SELECT e.id, e.nome, e.cor, e.sistema, e.tipo, e.comportamento FROM pessoa_etiqueta pe
    JOIN etiqueta e ON e.id = pe.etiqueta_id
    WHERE pe.person_id = ? ORDER BY e.nome COLLATE NOCASE`).all(personId)
}

// Todas as pessoas com esta etiqueta, com o nome que a UI mostra. Serve para a Config dizer
// QUEM está marcado, em vez de só um número.
export function pessoasDaEtiqueta(etiquetaId) {
  garantirTabelas()
  return db().prepare(`
    SELECT pe.person_id AS personId, p.display_name AS nome
    FROM pessoa_etiqueta pe LEFT JOIN person p ON p.person_id = pe.person_id
    WHERE pe.etiqueta_id = ? ORDER BY p.display_name COLLATE NOCASE`).all(Number(etiquetaId))
}

// Marca/desmarca. Idempotente dos dois lados: marcar duas vezes não duplica, desmarcar o que
// não estava marcado não é erro.
export function marcarPessoa({ personId, etiquetaId, marcar = true } = {}) {
  garantirTabelas()
  const canonica = pessoaCanonica(personId)
  if (!canonica) throw new Error('não consegui identificar esta pessoa')
  const id = Number(etiquetaId)
  if (!db().prepare(`SELECT 1 FROM etiqueta WHERE id=?`).get(id)) throw new Error('etiqueta não encontrada')
  if (marcar) {
    db().prepare(`INSERT OR IGNORE INTO pessoa_etiqueta(person_id,etiqueta_id,criada_em) VALUES(?,?,?)`)
      .run(canonica, id, agora())
    // A pessoa pode ter sido etiquetada por um id de canal antes de a união acontecer. Junta
    // tudo na canônica em vez de deixar a marca presa num id que ninguém mais consulta.
    try {
      for (const bruto of idsBrutosDaPessoa(canonica)) {
        if (bruto !== canonica) db().prepare(`DELETE FROM pessoa_etiqueta WHERE person_id=? AND etiqueta_id=?`).run(bruto, id)
      }
    } catch { /* sem união registrada, nada a juntar */ }
  } else {
    db().prepare(`DELETE FROM pessoa_etiqueta WHERE person_id=? AND etiqueta_id=?`).run(canonica, id)
  }
  return etiquetasDaPessoa(canonica)
}

// ---------------------------------------------------------------- REGRAS AUTOMÁTICAS
// Regra configurada (14/08/2026): uma etiqueta pode se colocar sozinha quando a pessoa escreve
// certa coisa. Duas formas, porque ele pediu as duas:
//   'contem' — a palavra ou expressão aparece na mensagem (é o caso comum);
//   'exata'  — a mensagem inteira é aquela frase, e nada mais.
//
// A regra só MARCA, nunca desmarca: tirar etiqueta é ato de quem opera. E vale apenas para
// mensagem RECEBIDA daqui em diante — nada de reescrever o passado, para não aparecer
// marcação que ninguém viu acontecer.
const semAcento = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const escaparRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// A frase exata é comparada sem pontuação e sem espaço sobrando: "bora marcar!" e "Bora
// marcar" são a mesma frase para quem escreveu, e seriam duas para uma comparação literal.
const soEssencial = (s) => semAcento(s).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()

export function regraCasa(regra, texto) {
  const alvo = String(regra?.texto || '').trim()
  if (!alvo) return false
  if (regra?.tipo === 'exata') return soEssencial(texto) === soEssencial(alvo)
  // 'contem' com BORDA de palavra: "hora" não pode disparar dentro de "agora".
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaparRegex(semAcento(alvo))}([^\\p{L}\\p{N}]|$)`, 'iu')
    .test(semAcento(texto))
}

function lerRegras(row) {
  try {
    const r = JSON.parse(row?.regras || '[]')
    return Array.isArray(r) ? r.filter((x) => x && x.texto).map((x) => ({
      tipo: x.tipo === 'exata' ? 'exata' : 'contem',
      texto: String(x.texto).slice(0, 120),
    })) : []
  } catch { return [] }
}

export function salvarRegras({ id, regras, sistema = false } = {}) {
  garantirTabelas()
  const alvo = db().prepare(`SELECT * FROM etiqueta WHERE id=?`).get(Number(id))
  if (!alvo) throw new Error('etiqueta não encontrada')
  // Regras da linhagem só o código grava. O painel chega sem sistema:true.
  if (alvo.sistema && !sistema) {
    throw new Error(`as regras de "${alvo.nome}" vêm do código da linhagem`)
  }
  const lista = []
  for (const bruta of Array.isArray(regras) ? regras : []) {
    const texto = String(bruta?.texto ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
    if (!texto) continue
    if (texto.length < 2) throw new Error(`"${texto}" é curto demais para virar regra`)
    const tipo = bruta?.tipo === 'exata' ? 'exata' : 'contem'
    if (!lista.some((r) => r.tipo === tipo && r.texto.toLowerCase() === texto.toLowerCase())) lista.push({ tipo, texto })
  }
  if (lista.length > 20) throw new Error('o máximo é 20 regras por etiqueta')
  db().prepare(`UPDATE etiqueta SET regras=? WHERE id=?`).run(JSON.stringify(lista), alvo.id)
  return lista
}

export function regrasDaEtiqueta(id) {
  garantirTabelas()
  return lerRegras(db().prepare(`SELECT regras FROM etiqueta WHERE id=?`).get(Number(id)))
}

const MAX_COMPORTAMENTO = 700

export function salvarComportamento({ id, texto } = {}) {
  garantirTabelas()
  const alvo = db().prepare(`SELECT * FROM etiqueta WHERE id=?`).get(Number(id))
  if (!alvo) throw new Error('etiqueta não encontrada')
  if (alvo.tipo === 'cidade') throw new Error('cidade não tem jeito de conversa — o nome já é o fato')
  const limpo = String(texto ?? '').replace(/\r/g, '').trim().slice(0, MAX_COMPORTAMENTO)
  db().prepare(`UPDATE etiqueta SET comportamento=? WHERE id=?`).run(limpo || null, alvo.id)
  return limpo
}

export function comportamentoDaEtiqueta(id) {
  garantirTabelas()
  return String(db().prepare(`SELECT comportamento FROM etiqueta WHERE id=?`).get(Number(id))?.comportamento || '')
}

// Bloco do prompt: só as marcas DESTA pessoa que têm um jeito escrito. Sem isso o
// prompt fica idêntico — aditivo, como o resto. A tabela de serviços (quando a
// etiqueta abre um serviço) é a verdade dos valores; isto aqui é o TOM.
// Esta conversa pode receber foto sensual? Basta UMA etiqueta da pessoa abrir. Barato: uma
// consulta com join, chamada uma vez por resposta gerada.
export function etiquetaAbreFotoQuente(personId) {
  garantirTabelas()
  if (!personId) return false
  try {
    return !!db().prepare(`SELECT 1 FROM pessoa_etiqueta pe JOIN etiqueta e ON e.id = pe.etiqueta_id
      WHERE pe.person_id = ? AND e.fotos_quentes = 1 LIMIT 1`).get(String(personId))
  } catch { return false }
}

export function definirFotosQuentes(id, permitido) {
  garantirTabelas()
  const alvo = db().prepare(`SELECT * FROM etiqueta WHERE id=?`).get(Number(id))
  if (!alvo) throw new Error('etiqueta não encontrada')
  db().prepare(`UPDATE etiqueta SET fotos_quentes=? WHERE id=?`).run(permitido ? 1 : 0, alvo.id)
  return !!permitido
}

export function blocoComportamento(etiquetasDaPessoa = []) {
  const linhas = []
  for (const e of etiquetasDaPessoa || []) {
    const t = String(e?.comportamento || '').trim()
    if (!t) continue
    linhas.push(`- ${e.nome}: ${t.replace(/\s+/g, ' ')}`)
  }
  if (!linhas.length) return ''
  return [
    'COMO CONVERSAR COM ESTA PESSOA (cada etiqueta muda o tom; não misture o jeito de uma marca com o de outra):',
    ...linhas,
    '- Se uma etiqueta abrir serviço/valor, a tabela de serviços é a verdade. Não invente preço nem ofereça o serviço de uma marca para quem não a tem.',
  ].join('\n')
}

// Chamado do `addMessage` — o único ponto por onde passa mensagem de TODO canal, dos dois
// lados. Recebe só o que entrou de fato (depois do INSERT) e nunca pode derrubar a gravação:
// etiqueta é conveniência, mensagem é o dado.
export function aplicarRegras({ personId, texto, direction = 'incoming' } = {}) {
  if (direction !== 'incoming') return []
  const t = String(texto || '').trim()
  if (!t) return []
  garantirTabelas()
  const comRegra = db().prepare(`SELECT id, nome, cor, regras FROM etiqueta WHERE regras IS NOT NULL AND regras != '[]'`).all()
  if (!comRegra.length) return []
  const canonica = pessoaCanonica(personId)
  if (!canonica) return []
  const jaTem = new Set(etiquetasDaPessoa(canonica).map((e) => e.id))
  const postas = []
  for (const row of comRegra) {
    if (jaTem.has(row.id)) continue
    const regra = lerRegras(row).find((r) => regraCasa(r, t))
    if (!regra) continue
    marcarPessoa({ personId: canonica, etiquetaId: row.id })
    postas.push({ id: row.id, nome: row.nome, cor: row.cor, regra })
  }
  return postas
}

export function contagemEtiquetas() {
  garantirTabelas()
  const etiquetas = db().prepare(`SELECT COUNT(*) AS n FROM etiqueta`).get()?.n || 0
  const marcadas = db().prepare(`SELECT COUNT(DISTINCT person_id) AS n FROM pessoa_etiqueta`).get()?.n || 0
  return { etiquetas, pessoasMarcadas: marcadas }
}
