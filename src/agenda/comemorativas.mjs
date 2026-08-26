// DATAS COMEMORATIVAS: as datas que a dona escreve à mão e que, NO DIA, podem virar assunto.
//
// Por que não é a agenda do Google: aquilo são compromissos com hora, vindos de fora, e a
// conexão pode nem existir (é o caso hoje). Isto é dela, nasce vazio, e a maioria se repete
// TODO ANO — Natal, Dia dos Namorados, aniversário de alguém. Por isso o ano é opcional:
// sem ano, repete sempre; com ano, é uma data única.
//
// O FUSO É SEMPRE `America/Sao_Paulo`, como manda `docs/TEMPO.md`: "hoje" é o hoje do Brasil,
// não o da VM. Uma data comemorativa que aparece no dia errado é pior que não aparecer.
import { db } from '../core/db.mjs'
import { lerServicos } from '../self/servicos.mjs'

const TZ = 'America/Sao_Paulo'
const agora = () => Date.now()
const MAX_TITULO = 60
const MAX_NOTA = 200

let pronto = false
function garantirTabela() {
  if (pronto) return
  db().exec(`CREATE TABLE IF NOT EXISTS data_comemorativa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL,
    dia INTEGER NOT NULL,
    mes INTEGER NOT NULL,
    ano INTEGER,
    nota TEXT,
    ativa INTEGER NOT NULL DEFAULT 1,
    criada_em INTEGER NOT NULL
  )`)
  // Coluna adicionada depois: quem já tem a tabela só ganha a coluna. A ligação com serviço
  // guarda o NOME, não uma posição na lista — nome de serviço é único (o salvamento recusa
  // repetido) e sobrevive a reordenar/apagar outro serviço, coisa que um índice não faria.
  try { db().exec(`ALTER TABLE data_comemorativa ADD COLUMN servicos TEXT`) } catch { /* já existe */ }
  pronto = true
}

const limpar = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

// O dia de hoje NO BRASIL, em partes. `en-CA` dá YYYY-MM-DD, que é o formato que não confunde
// dia com mês — o erro clássico de quem monta data por string.
export function hojeNoBrasil(ms = Date.now()) {
  const [ano, mes, dia] = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ })
    .format(new Date(ms)).split('-').map(Number)
  return { ano, mes, dia }
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
export const nomeDoDia = ({ dia, mes, ano }) => `${String(dia).padStart(2, '0')} de ${MESES[mes - 1]}${ano ? ` de ${ano}` : ''}`

// Os serviços ligados a esta data, já filtrados pelos que AINDA EXISTEM. Serviço apagado (ou
// renomeado) some da ligação em vez de virar oferta fantasma no dia.
function servicosVivos(json) {
  let nomes = []
  try { nomes = JSON.parse(json || '[]') } catch { nomes = [] }
  if (!Array.isArray(nomes) || !nomes.length) return []
  let existentes = []
  try { existentes = lerServicos().itens.map((s) => s.nome) } catch { return [] }
  return nomes.map((n) => String(n || '').trim()).filter((n) => existentes.includes(n))
}

export function listarComemorativas() {
  garantirTabela()
  return db().prepare(`SELECT id, titulo, dia, mes, ano, nota, ativa, servicos, criada_em AS criadaEm
    FROM data_comemorativa ORDER BY mes, dia, titulo COLLATE NOCASE`).all()
    .map((d) => ({ ...d, ativa: !!d.ativa, quando: nomeDoDia(d), servicos: servicosVivos(d.servicos) }))
}

// 30 de fevereiro não existe, e "dia 31" em mês de 30 nunca chegaria — recusar na entrada é
// melhor que guardar uma data que jamais vai acontecer.
const DIAS_NO_MES = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

export function salvarComemorativa({ id = null, titulo, dia, mes, ano = null, nota = '', ativa = true, servicos = null } = {}) {
  garantirTabela()
  const t = limpar(titulo, MAX_TITULO)
  if (!t) throw new Error('dê um nome para a data')
  const d = Number(dia), m = Number(mes)
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error('mês inválido')
  if (!Number.isInteger(d) || d < 1 || d > DIAS_NO_MES[m - 1]) throw new Error(`dia inválido para ${MESES[m - 1]}`)
  const a = ano === null || ano === '' || ano === undefined ? null : Number(ano)
  if (a !== null && (!Number.isInteger(a) || a < 1900 || a > 2200)) throw new Error('ano inválido')
  if (a !== null && m === 2 && d === 29 && !((a % 4 === 0 && a % 100 !== 0) || a % 400 === 0)) {
    throw new Error(`${a} não é bissexto: não existe 29 de fevereiro nesse ano`)
  }
  const n = limpar(nota, MAX_NOTA)
  // `null` = não mexeu nos serviços (edição parcial); lista = substitui a ligação inteira.
  const srv = servicos === null || servicos === undefined ? null
    : JSON.stringify([...new Set((Array.isArray(servicos) ? servicos : []).map((x) => limpar(x, 80)).filter(Boolean))].slice(0, 20))
  if (id) {
    const alvo = db().prepare(`SELECT id FROM data_comemorativa WHERE id=?`).get(Number(id))
    if (!alvo) throw new Error('data não encontrada')
    db().prepare(`UPDATE data_comemorativa SET titulo=?, dia=?, mes=?, ano=?, nota=?, ativa=?, servicos=COALESCE(?, servicos) WHERE id=?`)
      .run(t, d, m, a, n || null, ativa ? 1 : 0, srv, alvo.id)
    return listarComemorativas().find((x) => x.id === alvo.id)
  }
  const r = db().prepare(`INSERT INTO data_comemorativa(titulo,dia,mes,ano,nota,ativa,servicos,criada_em) VALUES(?,?,?,?,?,?,?,?)`)
    .run(t, d, m, a, n || null, ativa ? 1 : 0, srv, agora())
  return listarComemorativas().find((x) => x.id === Number(r.lastInsertRowid))
}

export function apagarComemorativa(id) {
  garantirTabela()
  const r = db().prepare(`DELETE FROM data_comemorativa WHERE id=?`).run(Number(id))
  return { apagou: r.changes > 0 }
}

// As datas de HOJE. Sem ano = vale todo ano; com ano = só naquele.
export function comemorativasDeHoje(ms = Date.now()) {
  garantirTabela()
  const h = hojeNoBrasil(ms)
  return listarComemorativas().filter((d) => d.ativa && d.dia === h.dia && d.mes === h.mes && (d.ano === null || d.ano === h.ano))
}

// Os serviços que as datas de HOJE acionam — é o que o motor de serviços consulta. A data
// ABRE o serviço, nunca o fecha: quem não tem gatilho continua sempre disponível, e quem tem
// ganha mais um caminho para acordar.
export function servicosDeHoje(ms = Date.now()) {
  const out = []
  for (const d of comemorativasDeHoje(ms)) {
    for (const nome of d.servicos || []) if (!out.some((x) => x.servico === nome)) out.push({ servico: nome, data: d.titulo })
  }
  return out
}

// A próxima que vem, para a tela mostrar o que está por vir sem obrigar ninguém a fazer conta.
export function proximaComemorativa(ms = Date.now()) {
  const h = hojeNoBrasil(ms)
  const ordenadas = listarComemorativas().filter((d) => d.ativa)
  const chave = (d) => d.mes * 100 + d.dia
  const hoje = h.mes * 100 + h.dia
  const daFrente = ordenadas.filter((d) => chave(d) >= hoje && (d.ano === null || d.ano >= h.ano))
  return (daFrente[0] || ordenadas[0]) || null
}

// O bloco do prompt. Só entra NO DIA — e é isso que ele pediu: a data serve de assunto naquele
// dia, não a semana inteira. Sem data hoje, devolve '' e o prompt fica idêntico ao de antes.
export function comemorativasBlock(ms = Date.now()) {
  const hoje = comemorativasDeHoje(ms)
  if (!hoje.length) return ''
  return [
    'HOJE É UMA DATA QUE O USUÁRIO MARCOU:',
    ...hoje.map((d) => `- ${d.titulo}${d.nota ? ` — ${d.nota}` : ''}`),
    '- Pode usar como assunto se couber naturalmente na conversa; é gancho, não pauta. Se a',
    '  conversa está em outra coisa, deixe passar: forçar a data é o que soa a robô de marketing.',
    '- Não parabenize por algo que seja da OUTRA pessoa (aniversário dela, conquista dela) a não',
    '  ser que ela mesma tenha contado. Estas datas são do usuário.',
    '- Nunca invente outra data, e não fale de data que não está aqui.',
  ].join('\n')
}
