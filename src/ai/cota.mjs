// O FREIO DE COTA. Quando o provedor chega perto de 100%, a IA automática PARA sozinha.
//
// Regra do sistema (27/07/2026): "caso bata 99% o uso do codex a ia geral deve ser desativada".
//
// POR QUE ISTO EXISTE, SENDO QUE JÁ EXISTE A TRAVA DE TEXTO DE FALHA
// A trava de texto (filtro 'sistema' + recusarTextoDeFalha) impede o desastre: a falha do
// provedor nunca vira mensagem. Mas ela age DEPOIS de gastar a chamada, e uma conta no talo
// gera uma sequência de tentativas que falham, cada uma queimando o resto da cota e deixando
// a conversa muda sem ninguém entender por quê. Este arquivo age ANTES: se não tem cota, não
// tenta. É a diferença entre não errar e não se meter em encrenca.
//
// O QUE ELE NÃO FAZ
// Não desliga a IA por pessoa. Os interruptores do dono continuam como ele deixou — o que
// muda é um estado global de pausa, que ele vê e pode desfazer. Quando a cota volta, a pausa
// AUTOMÁTICA se desfaz sozinha (e avisa); a pausa que ele deu na mão nunca se desfaz sozinha,
// porque ali quem manda é ele.
import { getSetting, setSetting, logEvent } from '../core/db.mjs'
import { getCodex } from './codex.mjs'
import { provedorAtivo } from './ia.mjs'
import { ativa as contaAtiva } from './contas.mjs'

const LIMITE_PADRAO = 99   // pausa quando o uso chega aqui
const RETOMA_PADRAO = 90   // e volta sozinha quando cai abaixo disto (só se a pausa foi automática)

export function limitePausa() { return Number(getSetting('ia_pausa_limite', LIMITE_PADRAO)) || LIMITE_PADRAO }
export function limiteRetoma() { return Number(getSetting('ia_retoma_limite', RETOMA_PADRAO)) || RETOMA_PADRAO }
export function monitorLigado() { return getSetting('ia_pausa_auto', true) !== false }

// Estado da pausa: null = IA liberada. Objeto = pausada, com o porquê e quem pausou.
export function pausa() {
  const p = getSetting('ia_pausada', null)
  return p && typeof p === 'object' ? p : null
}
export function iaPausada() { return !!pausa() }

export function pausar({ motivo, auto = false, uso = null }) {
  const p = { motivo: String(motivo || 'sem motivo'), auto: !!auto, em: Date.now(), uso }
  setSetting('ia_pausada', p)
  logEvent({ type: 'ia_pausada', detail: `${auto ? 'automática' : 'manual'}: ${p.motivo}` })
  return p
}

export function retomar({ auto = false, motivo = null } = {}) {
  const antes = pausa()
  setSetting('ia_pausada', null)
  // Ele religou NA MÃO com a cota ainda estourada: o monitor cala a boca até o uso cair de
  // verdade. Sem isso o freio pausaria de novo no tick seguinte e ele levaria um aviso a cada
  // 5 minutos — que é como uma proteção vira inimiga.
  if (!auto) setSetting('ia_pausa_suprimida', true)
  if (antes) logEvent({ type: 'ia_retomada', detail: `${auto ? 'automática' : 'manual'}${motivo ? ': ' + motivo : ''}` })
  return antes
}

// Lê o uso REAL da conta ativa. Devolve null quando o provedor não expõe isso (o Claude Code
// não tem esta leitura) ou quando a chamada falha — e null nunca pausa nada: freio que age
// por falta de informação para o sistema inteiro por causa de uma rede ruim.
export async function lerUso() {
  if (provedorAtivo() !== 'codex') return null
  let ov = null
  try { ov = await getCodex(contaAtiva()?.home || null).accountOverview() } catch { return null }
  // O FORMATO REAL, conferido na conta do dono em 27/07/2026:
  //   limits: [{ id:'codex', planType:'plus', primary:{ usedPercent:99, resetsAt:… },
  //              secondary:null, credits:{ balance:'0' }, individual:null }]
  // A primeira versão disto lia `individualLimit.remainingPercent` — campo que existe no
  // tipo e vem NULO nesta conta. O freio teria ficado mudo pra sempre sem ninguém ver, que é
  // o pior jeito de uma proteção falhar. Agora lê a JANELA (primary/secondary), que é o que
  // o provedor realmente preenche, e o individual só como terceira opção.
  const limites = Array.isArray(ov?.limits) ? ov.limits : []
  let pior = null
  const considerar = (usado, id, resetaEm) => {
    if (typeof usado !== 'number' || !Number.isFinite(usado)) return
    const v = Math.max(0, Math.min(100, usado))
    if (!pior || v > pior.usadoPct) pior = { usadoPct: v, id: id || null, resetaEm: resetaEm || null }
  }
  for (const l of limites) {
    considerar(l?.primary?.usedPercent, l?.id, l?.primary?.resetsAt)
    considerar(l?.secondary?.usedPercent, l?.id, l?.secondary?.resetsAt)
    const rem = l?.individual?.remainingPercent
    if (typeof rem === 'number' && Number.isFinite(rem)) considerar(100 - rem, l?.id, l?.individual?.resetsAt)
  }
  if (!pior) return null
  return { ...pior, conta: contaAtiva()?.nome || ov?.account?.email || null, lidoEm: Date.now() }
}

function quandoVolta(resetaEm) {
  if (!resetaEm) return ''
  const min = Math.round((Number(resetaEm) * (String(resetaEm).length > 11 ? 1 : 1000) - Date.now()) / 60000)
  if (!Number.isFinite(min) || min <= 0) return ''
  return min < 60 ? ` (a cota volta em ~${min} min)` : ` (a cota volta em ~${Math.round(min / 60)}h)`
}

// O tick. Lê, decide e avisa. Idempotente: pausar duas vezes não avisa duas vezes.
// `ler` é injetável só pra prova: a guarda precisa simular 99% sem depender de conta, rede
// nem de estourar a cota de verdade pra ver o que acontece quando ela estoura.
export async function cotaTick({ avisar, ler = lerUso } = {}) {
  if (!monitorLigado()) return { agiu: false, motivo: 'monitor desligado' }
  const uso = await ler()
  if (!uso) return { agiu: false, motivo: 'sem leitura de uso' }
  const p = pausa()
  const teto = limitePausa()

  if (uso.usadoPct >= teto) {
    if (p) return { agiu: false, uso, jaPausada: true }
    if (getSetting('ia_pausa_suprimida', false)) return { agiu: false, uso, suprimido: true }
    const motivo = `uso do provedor em ${uso.usadoPct.toFixed(0)}% (teto ${teto}%)`
    pausar({ motivo, auto: true, uso })
    const texto = `pausei a IA automática: ${motivo}${quandoVolta(uso.resetaEm)}\nos interruptores por pessoa ficaram como estavam; quando a cota voltar eu religo e te aviso`
    try { if (avisar) await avisar(texto) } catch { /* aviso nunca derruba a pausa */ }
    return { agiu: true, pausou: true, uso }
  }

  // Uso abaixo da linha de retomada: a supressão dele já cumpriu o papel e sai de cena, pra
  // que o freio volte a valer na PRÓXIMA vez que a cota estourar.
  if (uso.usadoPct < limiteRetoma() && getSetting('ia_pausa_suprimida', false)) setSetting('ia_pausa_suprimida', false)

  // Voltou a ter cota: só desfaz o que ELE não fez na mão.
  if (p && p.auto && uso.usadoPct < limiteRetoma()) {
    retomar({ auto: true, motivo: `uso caiu para ${uso.usadoPct.toFixed(0)}%` })
    try { if (avisar) await avisar(`religuei a IA automática: o uso do provedor caiu pra ${uso.usadoPct.toFixed(0)}%`) } catch { /* idem */ }
    return { agiu: true, retomou: true, uso }
  }
  return { agiu: false, uso }
}
