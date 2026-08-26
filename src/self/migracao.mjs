// QUANTAS PESSOAS SAÍRAM DO TINDER PRA OUTRO CANAL.
//
// A fonte é a tabela de MENSAGENS, não a de vínculo — de propósito. O vínculo Tinder↔Instagram
// guarda o lado do Instagram como canônico e o do Tinder como alias (direção que confunde);
// contar por ali seria frágil e dependeria de qual mecanismo linkou. Já "teve conversa nos dois
// canais" é o fato direto: a pessoa migrou se existe mensagem dela no Tinder E no canal novo,
// depois de resolver os aliases pra não contar a mesma pessoa duas vezes.
//
// Migrou = a MESMA pessoa (canônica) tem pelo menos uma mensagem no Tinder e uma no destino.
import { db } from '../core/db.mjs'
import { canonicalPersonId } from '../projects/store.mjs'

const DESTINOS = ['instagram', 'telegram', 'whatsapp', 'meupatrocinio', 'badoo']

// Conta, por canal de destino, quantas pessoas do Tinder também têm conversa lá. Devolve
// { instagram: n, telegram: n, ... , totalTinder: n }.
export function migracaoDoTinder() {
  const linhas = db().prepare(`SELECT DISTINCT person_id, channel FROM message`).all()
  const canaisPorPessoa = new Map()
  for (const r of linhas) {
    let c
    try { c = canonicalPersonId(r.person_id) } catch { c = r.person_id }
    if (!canaisPorPessoa.has(c)) canaisPorPessoa.set(c, new Set())
    canaisPorPessoa.get(c).add(r.channel)
  }
  const out = { totalTinder: 0 }
  for (const d of DESTINOS) out[d] = 0
  for (const canais of canaisPorPessoa.values()) {
    if (!canais.has('tinder')) continue
    out.totalTinder++
    for (const d of DESTINOS) if (canais.has(d)) out[d]++
  }
  return out
}
