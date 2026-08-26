// A ENTREGA de um serviço: o link de acesso, as instruções e as fotos com direito de uso.
//
// A REGRA QUE MANDA NESTE ARQUIVO: quem entrega é QUEM OPERA, na mão. Regra configurada em
// 14/08/2026, e ela é o motivo de a entrega nunca entrar no prompt — a IA não sabe o link, não
// sabe que existe foto de entrega, e por isso não tem como mandar para quem não pagou. Aqui não
// há automação nenhuma: este módulo só roda quando alguém clica.
//
// SÓ CANAL COM DESTINATÁRIO EXPLÍCITO. WhatsApp (jid) e Telegram (chatId) recebem o alvo como
// parâmetro. Instagram e Badoo entregam na conversa ABERTA do navegador — foi assim que duas
// fotos foram parar com terceiros em 03/08/2026 — então entrega por lá fica de fora até existir
// um caminho com alvo explícito. Recusar é melhor que acertar por sorte.
import { addMessage, logEvent, getSavedImage } from '../core/db.mjs'
import { lerServicos } from './servicos.mjs'
import { savedImagePath } from '../wa/saved-image.mjs'

export const CANAIS_COM_ENTREGA = ['whatsapp', 'telegram', 'badoo']

// O Badoo entrou em 15/08/2026: ele TEM destinatário explícito (`enviar({ chatId, texto })`,
// com recibo do próprio site), então o link e as instruções saem com a mesma garantia dos
// outros. O que ele ainda não tem é envio de IMAGEM — não existe caminho de foto em
// `src/badoo/`. Então a foto de entrega não vira promessa: é declarada como não enviada.
const CANAIS_SEM_FOTO = new Set(['badoo'])

// O texto que acompanha a entrega. Link e instrução, nessa ordem, sem enfeite: é comprovante
// de entrega, não conversa.
export function textoDaEntrega(servico) {
  const e = servico?.entrega || {}
  return [String(e.link || '').trim(), String(e.instrucao || '').trim()].filter(Boolean).join('\n')
}

export function entregaVazia(servico) {
  const e = servico?.entrega || {}
  return !String(e.link || '').trim() && !String(e.instrucao || '').trim() && !(e.fotos || []).length
}

// As fotos de entrega que existem de verdade. Diferente das fotos de exemplo, a trava de nível
// NÃO se aplica: 'travada' quer dizer "a IA não manda sozinha", e aqui quem manda é o dono.
// Foto apagada some — nunca vira promessa não cumprida.
export function fotosDaEntrega(servico) {
  const out = []
  for (const id of servico?.entrega?.fotos || []) {
    const f = (() => { try { return getSavedImage(id) } catch { return null } })()
    if (!f || !f.file) continue
    out.push(f)
  }
  return out
}

export function servicosComEntrega() {
  return lerServicos().itens
    .map((s, indice) => ({ indice, nome: s.nome, servico: s }))
    .filter((x) => !entregaVazia(x.servico))
    .map((x) => ({
      indice: x.indice,
      nome: x.nome,
      temLink: !!String(x.servico.entrega?.link || '').trim(),
      fotos: fotosDaEntrega(x.servico).length,
    }))
}

// ENTREGA. Recebe o alvo EXPLÍCITO e devolve comprovante: o que saiu, por onde, e com que id.
// Nunca "entrega parcial em silêncio" — se uma foto falha, o resultado diz qual.
export async function entregar({ personId, canal, indice, enviarTexto, enviarFoto } = {}) {
  const servico = lerServicos().itens[Number(indice)]
  if (!servico) throw new Error('serviço não encontrado')
  if (entregaVazia(servico)) throw new Error(`"${servico.nome}" não tem nada configurado para entregar`)
  if (!CANAIS_COM_ENTREGA.includes(canal)) {
    throw new Error(`entrega ainda não vale no ${canal}: só WhatsApp e Telegram têm destinatário explícito`)
  }

  const texto = textoDaEntrega(servico)
  const fotos = fotosDaEntrega(servico)
  const feito = { servico: servico.nome, canal, texto: false, fotos: 0, falhas: [] }

  if (texto) {
    try { await enviarTexto(texto); feito.texto = true }
    catch (e) { feito.falhas.push(`texto: ${e.message}`) }
  }
  if (fotos.length && CANAIS_SEM_FOTO.has(canal)) {
    // Dizer em vez de calar: quem clicou precisa saber que as fotos NÃO foram, para mandar
    // por outro canal. Falha silenciosa aqui vira cliente esperando foto que nunca chega.
    feito.falhas.push(`${fotos.length} foto${fotos.length === 1 ? '' : 's'}: o ${canal} ainda não envia imagem por aqui — mande pelo WhatsApp ou Telegram`)
  } else {
    for (const f of fotos) {
      try { await enviarFoto(f, savedImagePath(f.file)); feito.fotos++ }
      catch (e) { feito.falhas.push(`foto ${f.shortcut || f.id}: ${e.message}`) }
    }
  }

  const resumo = [
    feito.texto ? 'link/instruções' : null,
    feito.fotos ? `${feito.fotos} de ${fotos.length} foto${fotos.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' + ') || 'nada saiu'
  logEvent({
    type: feito.falhas.length ? 'entrega_parcial' : 'entrega_feita',
    personId, channel: canal,
    detail: `${servico.nome}: ${resumo}${feito.falhas.length ? ` | falhou: ${feito.falhas.join('; ')}` : ''}`,
  })
  return feito
}

export { addMessage }
