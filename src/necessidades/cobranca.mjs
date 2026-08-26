// LIGA a cobrança (PIX) de uma necessidade pra quem já passou nas travas.
//
// A necessidade sozinha só entra no prompt. Pedir a chave exige autorização por pessoa.
// Sem isto, "pode passar o PIX" virava procedimento: abrir a ficha uma a uma.
//
// Quem já tem cobrança autorizada com OUTRO motivo não é tocado — a autorização é da
// pessoa, não um empilhamento.
import { db, garantirEnabledAt } from '../core/db.mjs'
import { pessoaCanonica, idsBrutosDaPessoa } from '../self/identidade.mjs'
import { vinculoDaPessoa } from '../self/vinculos.mjs'
import { cobrancaDaPessoa, salvarCobrancaPessoa, lerPix } from '../self/pix.mjs'
import { agendarPedidoUnico, statusPedidoUnico } from './pedido-unico.mjs'
import { nomeParaMostrar } from '../core/nome.mjs'
import { reguasDaConversa } from '../ai/assunto-grana.mjs'
import {
  garantirTabela, listar, definirPessoa, decisoesDaPessoa,
  necessidadeAbertaPara, formatarBRL,
} from './store.mjs'
import { caminhoDinheiro } from '../self/dinheiro-padroes.mjs'

function necessidadeDe(id) {
  garantirTabela()
  return db().prepare(`SELECT * FROM necessidade WHERE id=?`).get(Number(id)) || null
}

export function montarMotivoCobranca(n) {
  const valor = Number(n.valor_centavos || 0) ? formatarBRL(n.valor_centavos).replace(/\u00a0/g, ' ') : ''
  const linha = String(n.linha || '').replace(/\r/g, '').trim()
  const partes = []
  if (n.descricao) partes.push(String(n.descricao).trim())
  if (valor) partes.push(valor)
  if (linha) partes.push(linha.replace(/\n+/g, ' / '))
  return partes.filter(Boolean).join('. ').slice(0, 500)
}

export function pessoasComIaLigada() {
  garantirEnabledAt()
  const rows = db().prepare(`SELECT DISTINCT person_id FROM ai_setting WHERE enabled=1`).all()
  const vistos = new Set()
  const out = []
  for (const r of rows) {
    const id = pessoaCanonica(r.person_id) || r.person_id
    if (!id || vistos.has(id)) continue
    vistos.add(id)
    out.push(id)
  }
  return out
}

export function pessoasElegiveisNecessidade(necessidadeId) {
  const n = necessidadeDe(necessidadeId)
  if (!n || n.status !== 'aberta') return []
  const out = []
  for (const personId of pessoasComIaLigada()) {
    let tipo = null
    let decisoes = null
    let ids = [personId]
    try { ids = idsBrutosDaPessoa(personId) } catch { /* banco parcial */ }
    try { tipo = vinculoDaPessoa(personId)?.vinculo || null } catch { /* sem tagueamento */ }
    try { decisoes = decisoesDaPessoa(ids) } catch { /* banco parcial */ }
    const contas = reguasDaConversa(personId)
    if (cobrancaDaPessoa(personId).nunca) continue
    if (caminhoDinheiro(personId) === 'servico') continue
    if (!necessidadeAbertaPara(n, contas, { tipoDaPessoa: tipo, decisoes })) continue
    out.push({
      personId,
      nome: nomeParaMostrar(personId),
      iaLigada: contas.iaLigada,
      mensagens: contas.mensagens,
    })
  }
  return out
}

export function aplicarCobrancaNecessidades({ necessidadeId = null } = {}) {
  garantirTabela()
  garantirEnabledAt()
  const pix = lerPix()
  const alvo = necessidadeId
    ? [necessidadeDe(necessidadeId)].filter((n) => n && n.status === 'aberta')
    : listar({ incluirResolvidas: false }).filter((n) => Number(n.cobrar) === 1)
  let ligadas = 0
  let puladas = 0
  let semPix = 0
  const itens = []
  for (const n of alvo) {
    if (!Number(n.cobrar) && necessidadeId == null) continue
    if (!Number(n.valor_centavos || 0) || !String(n.linha || '').trim()) {
      itens.push({ id: n.id, erro: 'precisa de valor e linha de conversa pra cobrar' })
      continue
    }
    if (!pix.nome || !pix.chave) {
      semPix++
      itens.push({ id: n.id, erro: 'cadastre nome e chave PIX antes de cobrar' })
      continue
    }
    const motivo = montarMotivoCobranca(n)
    const elegiveis = pessoasElegiveisNecessidade(n.id)
    let desta = 0
    let pulo = 0
    for (const p of elegiveis) {
      const atual = cobrancaDaPessoa(p.personId)
      if (!atual.cobrancaAutorizada) {
        definirPessoa(n.id, p.personId, 'sim')
        salvarCobrancaPessoa(p.personId, { enabled: true, motivo })
        desta++
      } else {
        pulo++
      }
      const st = statusPedidoUnico(n.id, p.personId)
      if (!st || !['pendente', 'gerando', 'aguardando'].includes(st.estado)) {
        try { agendarPedidoUnico(n.id, p.personId) } catch { /* sem valor/linha/PIX: a autorização já ficou */ }
      }
    }
    ligadas += desta
    puladas += pulo
    itens.push({ id: n.id, descricao: n.descricao, elegiveis: elegiveis.length, ligadas: desta, puladas: pulo })
  }
  return { ligadas, puladas, semPix, itens }
}

export function resumoCobrancaNecessidade(necessidadeId) {
  const n = necessidadeDe(necessidadeId)
  if (!n) return { ok: false, erro: 'necessidade não encontrada' }
  const elegiveis = pessoasElegiveisNecessidade(n.id)
  const autorizadas = elegiveis.filter((p) => cobrancaDaPessoa(p.personId).cobrancaAutorizada).length
  return {
    ok: true,
    id: n.id,
    descricao: n.descricao,
    cobrar: !!Number(n.cobrar),
    elegiveis: elegiveis.length,
    autorizadas,
    pessoas: elegiveis,
  }
}
