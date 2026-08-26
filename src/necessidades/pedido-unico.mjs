// Pedido único de uma necessidade para uma pessoa.
//
// Isto é deliberadamente separado do "assunto dinheiro" do prompt. Quando quem opera
// aperta o botão, não está dando uma sugestão ao modelo: está enfileirando uma ação concreta.
//
// A IA ligada NÃO espera a pessoa falar pra começar. O 1º tempo (situação) sai mesmo
// quando a última mensagem foi nossa — senão a fila fica muda e o PIX não anda. Depois
// da situação, o 2º e o 3º tempo esperam a fala dela (pedir ajuda / chave só com o sim).
// Interruptor desligado: nada sai. Guarda: `licoes/cobranca-situacao-nao-espera-fala`.
//
// TRÊS TEMPOS (15/08/2026): a chave na primeira fala soa golpe. A linhagem herda esta ordem.
//   1. `situacao` — conta o aperto (a linha dela). Sem pedido, sem chave.
//   2. `pedir`    — pergunta se a pessoa consegue ajudar. Sem chave.
//   3. `chave`    — só se ela topar ou pedir o PIX. Recusa encerra sem chave.
//      Resposta ambígua deixa a fila quieta e a conversa segue.
import { db, getSetting } from '../core/db.mjs'
import { pessoaCanonica, idsBrutosDaPessoa } from '../self/identidade.mjs'
import { iaLigadaParaPessoa } from '../ai/uso.mjs'
import { lerPix } from '../self/pix.mjs'
import { formatarBRL, minutoAgoraBr, dentroDaJanela } from './store.mjs'
import { refeicaoForaDeHora, deslizeAlmocoNaSaida, textoDeslizeAlmoco } from './refeicao.mjs'
import { caminhoDinheiro } from '../self/dinheiro-padroes.mjs'

const agora = () => Date.now()
const LEASE_MS = 15 * 60 * 1000

export function garantirTabelaPedidoUnico() {
  db().exec(`CREATE TABLE IF NOT EXISTS necessidade_pedido_unico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    necessidade_id INTEGER NOT NULL,
    person_id TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendente', -- pendente | gerando | aguardando | enviado | recusado | cancelado
    agendado_em INTEGER NOT NULL,
    atualizado_em INTEGER NOT NULL,
    enviado_em INTEGER,
    canal_enviado TEXT,
    erro TEXT,
    UNIQUE(necessidade_id, person_id)
  );
  CREATE INDEX IF NOT EXISTS idx_necessidade_pedido_unico_pessoa
    ON necessidade_pedido_unico(person_id, estado, atualizado_em);`)
  const cols = db().prepare(`PRAGMA table_info(necessidade_pedido_unico)`).all().map((c) => c.name)
  if (!cols.includes('etapa')) db().exec(`ALTER TABLE necessidade_pedido_unico ADD COLUMN etapa TEXT DEFAULT 'situacao'`)
  if (!cols.includes('esquentou')) db().exec(`ALTER TABLE necessidade_pedido_unico ADD COLUMN esquentou INTEGER NOT NULL DEFAULT 0`)
  if (!cols.includes('insistiu')) db().exec(`ALTER TABLE necessidade_pedido_unico ADD COLUMN insistiu INTEGER NOT NULL DEFAULT 0`)
}

function necessidadeAberta(id) {
  return db().prepare(`SELECT id, descricao, valor_centavos, linha
    FROM necessidade WHERE id=? AND status='aberta'`).get(Number(id)) || null
}

function validarConfiguracao(necessidade) {
  if (!necessidade) throw new Error('necessidade aberta não encontrada')
  if (!Number(necessidade.valor_centavos || 0)) throw new Error('coloque o valor da necessidade antes de pedir')
  if (!String(necessidade.linha || '').trim()) throw new Error('escreva a linha de conversa antes de pedir')
  const pix = lerPix()
  if (!pix.nome || !pix.chave) throw new Error('cadastre nome e chave PIX antes de pedir')
  return pix
}

export function agendarPedidoUnico(necessidadeId, personIdBruto) {
  if (!getSetting('necessidade_pedidos_enabled', false)) {
    throw new Error('pedidos pessoais estão desligados; habilite necessidade_pedidos_enabled conscientemente')
  }
  garantirTabelaPedidoUnico()
  const personId = pessoaCanonica(personIdBruto)
  if (!personId) throw new Error('não consegui identificar esta pessoa')
  const necessidade = necessidadeAberta(necessidadeId)
  validarConfiguracao(necessidade)
  const t = agora()
  db().prepare(`INSERT INTO necessidade_pedido_unico
      (necessidade_id,person_id,estado,etapa,agendado_em,atualizado_em,enviado_em,canal_enviado,erro)
    VALUES(?,?,'pendente','situacao',?,?,NULL,NULL,NULL)
    ON CONFLICT(necessidade_id,person_id) DO UPDATE SET
      estado='pendente', etapa='situacao', agendado_em=excluded.agendado_em, atualizado_em=excluded.atualizado_em,
      enviado_em=NULL, canal_enviado=NULL, erro=NULL`)
    .run(Number(necessidadeId), personId, t, t)
  return statusPedidoUnico(necessidadeId, personId)
}

export function cancelarPedidoUnico(necessidadeId, personIdBruto) {
  garantirTabelaPedidoUnico()
  const personId = pessoaCanonica(personIdBruto)
  if (!personId) return null
  const r = db().prepare(`UPDATE necessidade_pedido_unico
    SET estado='cancelado', atualizado_em=?, erro=NULL
    WHERE necessidade_id=? AND person_id=? AND estado IN ('pendente','gerando','aguardando')`)
    .run(agora(), Number(necessidadeId), personId)
  return r.changes ? statusPedidoUnico(necessidadeId, personId) : null
}

export function statusPedidoUnico(necessidadeId, personIdBruto) {
  garantirTabelaPedidoUnico()
  const personId = pessoaCanonica(personIdBruto)
  if (!personId) return null
  return db().prepare(`SELECT id, necessidade_id, estado, etapa, agendado_em, atualizado_em,
      enviado_em, canal_enviado, erro
    FROM necessidade_pedido_unico WHERE necessidade_id=? AND person_id=?`)
    .get(Number(necessidadeId), personId) || null
}

export function pedidosDaPessoa(personIdBruto) {
  garantirTabelaPedidoUnico()
  const personId = pessoaCanonica(personIdBruto)
  if (!personId) return new Map()
  const linhas = db().prepare(`SELECT id, necessidade_id, estado, etapa, agendado_em, atualizado_em,
      enviado_em, canal_enviado, erro
    FROM necessidade_pedido_unico WHERE person_id=?`).all(personId)
  return new Map(linhas.map((l) => [Number(l.necessidade_id), l]))
}

export function pedidoAguardandoDaPessoa(personIdBruto) {
  garantirTabelaPedidoUnico()
  const personId = pessoaCanonica(personIdBruto)
  if (!personId) return null
  return db().prepare(`SELECT id, necessidade_id, estado, etapa FROM necessidade_pedido_unico
    WHERE person_id=? AND estado='aguardando' ORDER BY atualizado_em DESC LIMIT 1`).get(personId) || null
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

function linhasDaNecessidade(necessidade) {
  return String(necessidade.linha || '').replace(/\r/g, '').trim().split(/\n+/).map((x) => x.trim()).filter(Boolean)
}

function linhaEhPedido(linha) {
  const n = norm(linha)
  return /\b(ajud|emprest|paga|manda|transfir|consegue|preciso de)\w*/.test(n)
    && /\b(pix|reais|r\$|grana|dinheiro)\b/.test(n)
}

// Fatos da necessidade — o que aconteceu, NÃO a fala que sai.
// Colar a mesma linha pronta em várias conversas parece comportamento automatizado abusivo.
// Estes helpers existem pra o filtro e pra detectar colagem. Quem escreve
// a fala é o modelo, com instrucaoDoTempo. Guarda: cobranca-nao-e-copia-cola.
export function montarTextoSituacao(necessidade) {
  const linhas = linhasDaNecessidade(necessidade).filter((l) => !linhaEhPedido(l)).slice(0, 2)
  if (linhas.length) return linhas.join('\n')
  const desc = String(necessidade.descricao || '').replace(/\s+/g, ' ').trim()
  return desc || 'to numa situacao chata'
}

// Tempo 2: o pedido. Sem a chave. Fecha com valor + recompensa.
// Se a situação de almoço já saiu fora de hora, a primeira linha é a brincadeira
// do deslize — só nesse caso, nunca inventada.
export function montarTextoPedidoAjuda(necessidade, { deslizeAlmoco = false } = {}) {
  const valor = formatarBRL(necessidade.valor_centavos).replace(/\u00a0/g, ' ')
  const pedido = `preciso de ${valor}. você consegue ajudar? se não der tudo bem`
  if (!deslizeAlmoco) return pedido
  return `${textoDeslizeAlmoco()}\n${pedido}`
}

// Um empurrão depois da hesitação. Ainda sem chave. Só uma vez.
export function montarTextoInsistencia(necessidade) {
  return 'se não der tudo bem, não precisa se explicar'
}

// Compatível com quem ainda chama o nome antigo: o 1º tempo é a situação.
export function montarTextoPedidoUnico(necessidade) {
  return montarTextoSituacao(necessidade)
}

export function montarTextoChavePix(pix) {
  const chave = String(pix?.chave || '').trim()
  const nome = String(pix?.nome || '').trim()
  if (!chave) return ''
  return nome ? `se puder é esse\nmeu pix é ${chave} no nome ${nome}` : `se puder é esse\nmeu pix é ${chave}`
}

function fatosDaNecessidade(necessidade) {
  const desc = String(necessidade?.descricao || '').replace(/\s+/g, ' ').trim()
  const valor = Number(necessidade?.valor_centavos || 0)
    ? formatarBRL(necessidade.valor_centavos).replace(/\u00a0/g, ' ')
    : ''
  const linhas = linhasDaNecessidade(necessidade)
  return { desc, valor, linhas }
}

// Instrução pro modelo. A linha e o valor são FATOS. Colar a linha é o defeito.
export function instrucaoDoTempo({ etapa, necessidade, deslizeAlmoco = false } = {}) {
  const { desc, valor, linhas } = fatosDaNecessidade(necessidade)
  const fatos = [desc, valor && `valor ${valor}`, ...linhas].filter(Boolean).join(' · ')
  const unica = [
    'ESTA FALA É DESTA CONVERSA. Se a mesma frase serviria pra qualquer outro, está errada — reescreve.',
    'Seja direto e honesto. Não use intimidade, sexo, culpa, urgência falsa nem detalhes pessoais como pressão.',
    'NÃO cole a linha pronta. NÃO comece com a frase estoque. Os fatos abaixo são o que aconteceu, não o texto.',
  ]
  if (etapa === 'situacao') {
    return [
      'TEMPO 1 — SITUAÇÃO (sem pedido, sem valor, sem chave, sem "me ajuda"):',
      ...unica,
      `Fatos (não são a fala): ${fatos}`,
      'Conte o aperto em 1-2 bolhas, no tom de vocês. Sem slogan de recompensa.',
      deslizeAlmoco ? `Comece com: ${textoDeslizeAlmoco()}` : '',
    ].filter(Boolean).join('\n')
  }
  if (etapa === 'pedir') {
    return [
      'TEMPO 2 — PEDIDO (sem chave):',
      ...unica,
      `Fatos (não são a fala): ${fatos}`,
      valor ? `O valor (${valor}) aparece UMA vez, no meio da fala, não como nota fiscal.` : '',
      'Pergunte uma vez se a pessoa consegue ajudar e deixe claro que uma recusa é aceita. Não prometa recompensa.',
      deslizeAlmoco ? `Comece com: ${textoDeslizeAlmoco()}` : '',
    ].filter(Boolean).join('\n')
  }
  if (etapa === 'insistencia') {
    return [
      'TEMPO 2b — encerre sem pressionar. Sem chave.',
      ...unica,
      valor ? `Não repita nem negocie o valor (${valor}).` : '',
      'Diga que está tudo bem se não puder e encerre o assunto.',
    ].filter(Boolean).join('\n')
  }
  return ''
}

const COLA_SAIDA = /recompenso rsrs|chefe nao me pagou|fica R\$ 70,00 no pix|sem dinheiro pra almocar|vc consegue me ajudar com R\$ 70|falei almo[cç]o pq nem consegui/i

// Nesta conversa já saiu a linha colada. O pedido foi cancelado; o próximo
// turno é papo, não cobrança. Sem isto o deslize e a janela de grana
// repetiam o vacilo.
export function houveVaciloCola(personIdBruto) {
  const personId = pessoaCanonica(personIdBruto)
  if (!personId) return false
  const ids = idsDaPessoa(personId)
  if (!ids.length) return false
  const marks = ids.map(() => '?').join(',')
  const rows = db().prepare(`SELECT text FROM message
    WHERE person_id IN (${marks}) AND direction='outgoing'
    ORDER BY ts DESC, rowid DESC LIMIT 30`).all(...ids)
  return rows.some((r) => COLA_SAIDA.test(String(r.text || '')))
}

export function vaciloCobrancaBlock(personIdBruto) {
  if (!houveVaciloCola(personIdBruto)) return ''
  if (pedidoAguardandoDaPessoa(personIdBruto)) return ''
  return [
    'VACILO DESTA CONVERSA: saiu um pedido de dinheiro colado, fora do tom. Já foi.',
    'Não peça PIX, não conte almoço, não mande chave, não fale de recompensa de dinheiro.',
    'Se ELE tocou nisso (estranhou, perguntou, zoou): uma frase mole assumindo e volta pro fio DELE.',
    'Se ele não tocou: NÃO cite. Siga o que ele está falando agora.',
  ].join('\n')
}

export function falaColadaNaLinha(texto, necessidade) {
  const t = norm(texto).replace(/\s+/g, ' ').trim()
  if (!t) return false
  const iguais = [
    montarTextoSituacao(necessidade),
    montarTextoPedidoAjuda(necessidade),
    montarTextoInsistencia(necessidade),
  ]
  for (const raw of iguais) {
    const n = norm(raw).replace(/\s+/g, ' ').trim()
    if (n && (t === n || t.includes(n))) return true
  }
  for (const l of linhasDaNecessidade(necessidade)) {
    const n = norm(l).replace(/\s+/g, ' ').trim()
    if (n.length >= 24 && t.includes(n)) return true
  }
  return false
}

// Ele abriu o clima da recompensa: pediu foto, puxou o explícito, ou perguntou do
// "depois eu recompenso". Isso NÃO é sim pro PIX — é deixa pra esquentar e só depois pedir.
export function aberturaQuente(texto) {
  const n = norm(texto)
  if (!n.trim()) return false
  const pedeFoto = /\b(foto|fotos|nudes?|pack|print)\b/.test(n)
    && /\b(manda|passa|mostra|quero|envia|me manda|uma foto)\b/.test(n)
  if (pedeFoto) return true
  if (/\b(recompensa|recompensar)\b/.test(n)) return true
  return /\b(transar|foder|gozar|pau|buceta|xoxota|nudes?|pelad[ao]|safad[ao]|cavalgar|mamar|te comer|me comer|sentar em)\b/.test(n)
}

// A primeira fala DELE depois do pedido. Pedir a chave ou topar manda o PIX.
// Foto em troca de PIX, ou puxar a recompensa, é 'quente' — não é sim.
// Recusar encerra. O resto não é resposta ao pedido — a conversa segue e a fila espera.
export function respostaAoPedido(texto) {
  const n = norm(texto)
  if (!n.trim()) return 'incerto'
  if (aberturaQuente(texto)) return 'quente'
  const pedeChave = /\b(pix|chave)\b/.test(n) && /\b(manda|passa|qual|como|pode|envia|chave|pix)\b/.test(n)
  if (pedeChave) return 'aceita'
  const recusa = /\b(nao quero|n quero|esquece|para de pedir|sai fora|nao me enche|n me enche)\b/.test(n)
    || /^(nao|n|nn|nel|nope)[.!?]*$/.test(n)
  if (recusa) return 'recusa'
  const hesita = /\b(nao posso|n posso|nao consigo|n consigo|nao tenho|n tenho|sem grana|sem dinheiro|agora nao|nao da|n da|nao rola|n rola|to duro|to liso|nao recebi|n recebi|depois|hoje nao|ficar te devendo|ficar ti devendo)\b/.test(n)
  if (hesita) return 'hesita'
  // "se a gente se conhecesse pessoalmente sim" NÃO é sim. Gilmar, 15/08/2026:
  // o classificador leu o "sim" condicional e mandou a chave.
  const condicional = /\b(se |caso |quando )\b/.test(n) || /\bpessoalmente\b/.test(n)
  const aceita = /\b(sim|ss|sii+m|claro|ok|blz|pode|mando|te ajudo|consigo|fechou|combinado|sem problema|pode ser|vou te ajudar|e so falar)\b/.test(n)
  if (aceita && !condicional) return 'aceita'
  return 'incerto'
}

// A situação ainda não saiu. É o único tempo que a IA puxa sozinha: os outros
// dependem da resposta dela.
export function pedidoEsperandoSituacao(personIdBruto) {
  garantirTabelaPedidoUnico()
  const personId = pessoaCanonica(personIdBruto)
  if (!personId) return null
  return db().prepare(`SELECT id, necessidade_id, estado, etapa, agendado_em
    FROM necessidade_pedido_unico
    WHERE person_id=? AND estado IN ('pendente','gerando')
      AND (etapa='situacao' OR etapa IS NULL OR etapa='')
    ORDER BY agendado_em, id LIMIT 1`).get(personId) || null
}

function idsDaPessoa(personId) {
  let ids = [personId]
  try { ids = idsBrutosDaPessoa(personId) } catch { /* só o id que temos */ }
  return [...new Set((ids || []).filter(Boolean))]
}

function ultimaMensagem(personId) {
  const ids = idsDaPessoa(personId)
  if (!ids.length) return null
  const marks = ids.map(() => '?').join(',')
  return db().prepare(`SELECT channel, direction, ts FROM message
    WHERE person_id IN (${marks}) ORDER BY ts DESC, rowid DESC LIMIT 1`).get(...ids) || null
}

// Respiro curto depois da nossa última fala: não empilha a situação em cima da
// bolha que acabou de sair. 90s cabem numa volta do laço.
const RESPIRO_INICIATIVA_MS = 90 * 1000
// Conversa fria não leva situação sozinha. O blast de 15/08/2026 mandou a
// mesma linha pra quem não falava há dias. Iniciativa só em conversa viva.
const CONVERSA_VIVA_MS = 36 * 60 * 60 * 1000

function ultimaIncoming(personId) {
  const ids = idsDaPessoa(personId)
  if (!ids.length) return null
  const marks = ids.map(() => '?').join(',')
  return db().prepare(`SELECT ts FROM message
    WHERE person_id IN (${marks}) AND direction='incoming'
    ORDER BY ts DESC, rowid DESC LIMIT 1`).get(...ids) || null
}

// Pendência de cobrança quando ELA não está esperando resposta — a IA é que
// precisa falar. null se a IA está desligada, se o 1º tempo já saiu, se a
// última fala é dela (aí o fingerprint de incoming manda) ou se o canal não
// é o da última mensagem.
export function fingerprintIniciativaCobranca(personIdBruto, channel) {
  if (!getSetting('necessidade_pedidos_enabled', false)) return null
  const personId = pessoaCanonica(personIdBruto)
  if (!personId) return null
  if (caminhoDinheiro(personId) === 'servico') return null
  try { if (!iaLigadaParaPessoa(personId, channel || null)) return null } catch { return null }
  const row = pedidoEsperandoSituacao(personId)
  if (!row) return null
  const last = ultimaMensagem(personId)
  if (!last || last.direction === 'incoming') return null
  if (channel && last.channel !== channel) return null
  if (Date.now() - Number(last.ts || 0) < RESPIRO_INICIATIVA_MS) return null
  const lastIn = ultimaIncoming(personId)
  if (!lastIn || Date.now() - Number(lastIn.ts || 0) > CONVERSA_VIVA_MS) return null
  if (situacaoForaDeHora(row.necessidade_id)) return null
  return `pix-sit-${row.id}-${row.agendado_em}`
}

function situacaoForaDeHora(necessidadeId) {
  const nec = db().prepare(`SELECT descricao, linha, hora_de, hora_ate FROM necessidade WHERE id=?`).get(Number(necessidadeId))
  if (!nec) return false
  if (nec.hora_de && nec.hora_ate && !dentroDaJanela(nec.hora_de, nec.hora_ate, minutoAgoraBr())) return true
  const texto = `${nec.descricao || ''} ${nec.linha || ''} ${montarTextoSituacao(nec)}`
  return !!refeicaoForaDeHora(texto)
}

export function deslizeAlmocoDaPessoa(personId) {
  const ids = idsDaPessoa(personId)
  if (!ids.length) return false
  const marks = ids.map(() => '?').join(',')
  const last = db().prepare(`SELECT text, ts FROM message
    WHERE person_id IN (${marks}) AND direction='outgoing'
      AND text LIKE '%almoc%'
    ORDER BY ts DESC LIMIT 1`).get(...ids)
  return !!(last && deslizeAlmocoNaSaida(last))
}

// Fila em espera que acabou de abrir a porta do clima. O gerador usa isto pra mandar
// UMA foto quente e não pedir dinheiro neste turno.
export function cobrancaQuerEsquentar(personIdBruto) {
  void personIdBruto
  return false
}

function turnoRecebidoDesde(personId, desdeTs) {
  const rows = db().prepare(`SELECT text, direction, ts FROM message
    WHERE person_id=? AND ts>? ORDER BY ts ASC`).all(personId, Number(desdeTs) || 0)
  const last = []
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].direction !== 'incoming') {
      if (last.length) break
      continue
    }
    last.unshift(rows[i].text || '')
  }
  return last.join(' ')
}

// Reserva atômica: duas redes da mesma pessoa podem ter pendência ao mesmo tempo. Só uma
// ganha a linha; a outra segue com a resposta normal. Lease vencida volta a ser reservável
// para um crash não deixar o pedido preso para sempre.
export function reservarPedidoUnico(personIdBruto) {
  if (!getSetting('necessidade_pedidos_enabled', false)) return null
  garantirTabelaPedidoUnico()
  const personId = pessoaCanonica(personIdBruto)
  if (!personId) return null
  if (caminhoDinheiro(personId) === 'servico') return null
  const tx = db().transaction(() => {
    const limite = agora() - LEASE_MS
    const row = db().prepare(`SELECT p.*, n.descricao, n.valor_centavos, n.linha
      FROM necessidade_pedido_unico p
      JOIN necessidade n ON n.id=p.necessidade_id AND n.status='aberta'
      WHERE p.person_id=? AND (
        p.estado IN ('pendente','aguardando')
        OR (p.estado='gerando' AND p.atualizado_em<?)
      )
      ORDER BY p.agendado_em, p.id LIMIT 1`).get(personId, limite)
    if (!row) return null

    const etapaAtual = row.etapa === 'chave' || row.etapa === 'pedir' ? row.etapa : 'situacao'
    if (etapaAtual === 'situacao' && situacaoForaDeHora(row.necessidade_id)) {
      const last = ultimaMensagem(personId)
      if (!last || last.direction !== 'incoming') return null
    }
    let etapa = etapaAtual
    if (row.estado === 'aguardando') {
      const turno = turnoRecebidoDesde(personId, row.atualizado_em)
      const resp = respostaAoPedido(turno)
      if (etapaAtual === 'pedir') {
        if (resp === 'recusa') {
          db().prepare(`UPDATE necessidade_pedido_unico SET estado='recusado', atualizado_em=?, erro=NULL WHERE id=?`)
            .run(agora(), row.id)
          return null
        }
        if (resp === 'quente' && !Number(row.esquentou)) {
          db().prepare(`UPDATE necessidade_pedido_unico SET esquentou=1 WHERE id=?`).run(row.id)
          return null
        }
        if (resp === 'aceita') etapa = 'chave'
        else etapa = 'pedir'
      } else if (etapaAtual === 'chave') {
        if (resp === 'incerto' || resp === 'quente') return null
        if (resp === 'recusa') {
          db().prepare(`UPDATE necessidade_pedido_unico SET estado='recusado', atualizado_em=?, erro=NULL WHERE id=?`)
            .run(agora(), row.id)
          return null
        }
        if (resp === 'hesita') {
          if (Number(row.insistiu)) {
            db().prepare(`UPDATE necessidade_pedido_unico SET estado='recusado', atualizado_em=?, erro=NULL WHERE id=?`)
              .run(agora(), row.id)
            return null
          }
          etapa = 'pedir'
        } else {
          etapa = 'chave'
        }
      }
    }

    const t = agora()
    const ehEmpurrao = etapa === 'pedir' && etapaAtual === 'chave'
    const ganhou = db().prepare(`UPDATE necessidade_pedido_unico
      SET estado='gerando', etapa=?, insistiu=?, atualizado_em=?, erro=NULL
      WHERE id=? AND (estado IN ('pendente','aguardando') OR (estado='gerando' AND atualizado_em<?))`)
      .run(etapa, ehEmpurrao ? 1 : (Number(row.insistiu) || 0), t, row.id, limite).changes
    if (!ganhou) return null
    const pix = validarConfiguracao(row)
    const deslizeAlmoco = (etapa === 'pedir' || ehEmpurrao) && deslizeAlmocoDaPessoa(personId)
    const etapaInstrucao = ehEmpurrao ? 'insistencia' : etapa
    const texto = etapa === 'chave' ? montarTextoChavePix(pix) : null
    const instrucao = etapa === 'chave' ? null : instrucaoDoTempo({ etapa: etapaInstrucao, necessidade: row, deslizeAlmoco })
    return {
      id: row.id,
      necessidadeId: Number(row.necessidade_id),
      etapa,
      texto,
      instrucao,
      necessidade: {
        descricao: row.descricao,
        valor_centavos: row.valor_centavos,
        linha: row.linha,
      },
      resumo: `${row.descricao} · ${formatarBRL(row.valor_centavos).replace(/\u00a0/g, ' ')}`,
    }
  })
  return tx()
}

export function concluirPedidoUnico(id, canal) {
  garantirTabelaPedidoUnico()
  const row = db().prepare(`SELECT id, etapa FROM necessidade_pedido_unico WHERE id=? AND estado='gerando'`).get(Number(id))
  if (!row) return false
  const t = agora()
  const canalTxt = String(canal || '')
  if (row.etapa === 'chave') {
    return db().prepare(`UPDATE necessidade_pedido_unico
      SET estado='enviado', atualizado_em=?, enviado_em=?, canal_enviado=?, erro=NULL
      WHERE id=? AND estado='gerando'`).run(t, t, canalTxt, row.id).changes > 0
  }
  const proxima = row.etapa === 'pedir' ? 'chave' : 'pedir'
  return db().prepare(`UPDATE necessidade_pedido_unico
    SET estado='aguardando', etapa=?, atualizado_em=?, canal_enviado=?, erro=NULL
    WHERE id=? AND estado='gerando'`).run(proxima, t, canalTxt, row.id).changes > 0
}

// Falha e modo sombra devolvem a reserva à fila. A mensagem de erro é curta e nunca recebe
// o rascunho (que na segunda etapa contém a chave PIX).
export function liberarPedidoUnico(id, erro = null) {
  garantirTabelaPedidoUnico()
  const row = db().prepare(`SELECT id, etapa FROM necessidade_pedido_unico WHERE id=? AND estado='gerando'`).get(Number(id))
  if (!row) return false
  const detalhe = String(erro || '').replace(/\s+/g, ' ').trim().slice(0, 240) || null
  const volta = row.etapa === 'situacao' || !row.etapa ? 'pendente' : 'aguardando'
  return db().prepare(`UPDATE necessidade_pedido_unico
    SET estado=?, atualizado_em=?, erro=? WHERE id=? AND estado='gerando'`)
    .run(volta, agora(), detalhe, row.id).changes > 0
}
