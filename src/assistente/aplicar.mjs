// APLICAR: pôr no ar o que o modo códex escreveu.
//
// Existe como função determinística — e não como "peça pro modelo rodar systemctl" — por
// dois motivos concretos:
//
//  1. O agente do modo códex roda como filho do vendas-multicanal-core. Se ELE reiniciar o serviço, morre
//     no meio do próprio turno e o dono nunca recebe a resposta: o sintoma é silêncio, que é
//     o pior jeito de falhar. Aqui a ordem é fixa: testar, AVISAR, e só então reiniciar
//     destacado do processo que vai morrer.
//  2. O portão é o mesmo pra sempre. Um modelo decidindo a cada vez se roda os testes vai,
//     alguma hora, não rodar. Aqui não tem "alguma hora": sem suíte verde, não reinicia.
import { spawn } from 'node:child_process'
import { logEvent } from '../core/db.mjs'
import { RAIZ } from './codex-modo.mjs'
import { peloDono } from '../core/dono.mjs'

const TESTE_TIMEOUT_MS = Number(process.env.TIM_CHECK_TIMEOUT_MS || 300_000)
const MAX_SAIDA = 3000

// Roda a suíte inteira. Devolve { ok, saida } — saida é a CAUDA, que é onde o erro aparece.
export function rodarTestes({ cwd = RAIZ, timeoutMs = TESTE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const p = spawn('npm', ['run', 'check'], { cwd, env: { ...process.env, CI: '1' } })
    let buf = ''
    const junta = (c) => { buf += String(c); if (buf.length > 200_000) buf = buf.slice(-100_000) }
    p.stdout.on('data', junta)
    p.stderr.on('data', junta)
    const timer = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* já morreu */ } }, timeoutMs)
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, saida: `não consegui rodar os testes: ${e.message}` }) })
    p.on('close', (code) => {
      clearTimeout(timer)
      const cauda = buf.trim().split('\n').slice(-24).join('\n').slice(-MAX_SAIDA)
      resolve({ ok: code === 0, codigo: code, saida: cauda || '(sem saída)' })
    })
  })
}

// Reinicia o vendas-multicanal-core DESTACADO: o comando sobrevive à morte deste processo porque não é
// filho dele no grupo de processos (setsid + unref). O atraso dá tempo da resposta sair
// pelo WhatsApp antes do serviço cair.
export function reiniciarDestacado({ atrasoSeg = 4 } = {}) {
  const p = spawn('/bin/bash', ['-c', `sleep ${Number(atrasoSeg) || 4}; sudo systemctl restart vendas-multicanal-core`], {
    detached: true, stdio: 'ignore',
  })
  p.unref()
  logEvent({ type: 'tim_restart_agendado', detail: `reinício em ${atrasoSeg}s (pedido ${peloDono()})` })
  return { agendado: true, emSegundos: Number(atrasoSeg) || 4 }
}

// O fluxo completo, na ordem que não pode mudar.
// `avisar` é chamado com a mensagem de resultado ANTES do reinício acontecer.
export async function aplicar({ avisar } = {}) {
  logEvent({ type: 'tim_aplicar', detail: 'rodando a suíte antes de reiniciar' })
  const t = await rodarTestes()
  if (!t.ok) {
    const msg = `não apliquei: a suíte falhou (código ${t.codigo}). O que quebrou:\n${t.saida}`
    logEvent({ type: 'tim_aplicar_bloqueado', detail: `suíte vermelha (${t.codigo})` })
    if (avisar) await avisar(msg)
    return { ok: false, texto: msg }
  }
  const msg = 'suíte verde. reiniciando o vendas-multicanal agora, volto em uns segundos'
  if (avisar) await avisar(msg)
  reiniciarDestacado({ atrasoSeg: 4 })
  return { ok: true, texto: msg }
}
