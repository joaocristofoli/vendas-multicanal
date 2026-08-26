// Rotas do progresso das conversas. Mesmo formato dos outros handlers modulares
// (projects/routes.mjs, self/routes.mjs): devolve true se tratou, false se não é dele.
//
//   GET /api/conversas/progresso?dias=30&canal=whatsapp[&desde=&ate=]
//        o conjunto, a série semanal e a comparação com o período anterior — numa foto só,
//        pra tela nunca misturar dois instantes diferentes de leitura.
//   GET /api/conversas/cobrancas?dias=30&canal=whatsapp[&desde=&ate=]
//        pedidos únicos e cobranças iniciadas, com histórico por pessoa
//   GET /api/conversas/saude?pessoa=<id>&canal=<canal>     a faixa de uma conversa
//   GET /api/conversas/dados.csv?dias=&canal=              as linhas por trás dos números
import { resumoConversas, serieConversas, compararPeriodo, saudeDaConversa, REGUA } from './progresso.mjs'
import { resumoCobrancasProgresso, necessidadesLigadasProgresso } from './cobrancas.mjs'

const CANAIS = new Set(['tinder', 'whatsapp', 'instagram', 'badoo'])
const canalDe = (url) => (CANAIS.has(url.searchParams.get('canal')) ? url.searchParams.get('canal') : null)
// dias=0 é "a vida inteira"; qualquer lixo vira o padrão de 30
function diasDe(url) {
  const cru = url.searchParams.get('dias')
  if (cru === '0') return 0
  const n = Number(cru)
  return n > 0 ? Math.min(n, 3650) : 30
}
const msDe = (url, k) => { const n = Number(url.searchParams.get(k)); return Number.isFinite(n) && n > 0 ? n : null }

export function handleConversasApi({ p, method, res, url, json, account = 'main' }) {
  if (!p.startsWith('/api/conversas')) return false

  if (p === '/api/conversas/progresso' && method === 'GET') {
    const dias = diasDe(url), canal = canalDe(url)
    const desde = msDe(url, 'desde'), ate = msDe(url, 'ate')
    // recorte explícito (uma semana clicada no gráfico) não tem série nem comparação:
    // seria série de um ponto só e comparação com um período que ninguém pediu.
    const recorte = desde != null
    json(res, 200, {
      ...resumoConversas({ accountKey: account, dias, canal, desde, ate }),
      // O gráfico tem horizonte PRÓPRIO (26 semanas) e não segue o filtro de período: com
      // "30 dias" a série teria 5 pontos e não daria pra ver tendência nenhuma, que é o
      // motivo de ela existir. O filtro manda nos números e nas listas.
      serie: recorte ? null : serieConversas({ accountKey: account, dias: 182, canal }),
      comparacao: recorte ? null : compararPeriodo({ accountKey: account, dias, canal }),
      regua: REGUA,
    })
    return true
  }

  if (p === '/api/conversas/cobrancas' && method === 'GET') {
    const dias = diasDe(url), canal = canalDe(url)
    const desde = msDe(url, 'desde'), ate = msDe(url, 'ate')
    const r = resumoConversas({ accountKey: account, dias, canal, desde, ate, incluirTodas: true, limite: 5000 })
    json(res, 200, {
      ...resumoCobrancasProgresso({
        conversas: r.todas || [],
        desde: r.janela?.desde || 0,
        ate: r.janela?.ate || Date.now(),
      }),
      // Estado atual das necessidades ligadas — "ligada e ainda não cobrada" também é dado.
      ligadas: necessidadesLigadasProgresso({
        desde: r.janela?.desde || 0,
        ate: r.janela?.ate || Date.now(),
      }),
    })
    return true
  }

  if (p === '/api/conversas/saude' && method === 'GET') {
    const pessoa = url.searchParams.get('pessoa')
    if (!pessoa) { json(res, 400, { error: 'pessoa' }); return true }
    json(res, 200, { saude: saudeDaConversa(pessoa, canalDe(url), { accountKey: account }) })
    return true
  }

  // As linhas por trás dos números. Existe pra medida poder ser conferida fora do painel e
  // pra alimentar o trabalho de melhorar a IA depois — número que não dá pra abrir é fé.
  if (p === '/api/conversas/dados.csv' && method === 'GET') {
    const r = resumoConversas({ accountKey: account, dias: diasDe(url), canal: canalDe(url), incluirTodas: true })
    // uma linha por PESSOA (a conversa é com ela, não com a rede), e a repartição por rede
    // vai numa coluna própria pra o dado não se perder na união
    const cols = ['nome', 'canais', 'canalDeHoje', 'estagio', 'vez', 'total', 'dela', 'minhas', 'idasEVindas',
      'tentativas', 'respondidas', 'vacuos', 'pct', 'retomadas', 'retomadasRespondidas', 'pctRetomada',
      'tempoRespostaMs', 'reciprocidade', 'primeira', 'ultima']
    const esc = (v) => {
      if (v == null) return ''
      const s = String(v)
      return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }
    const linha = (c) => cols.map((k) => {
      if (k === 'canais') return esc((c.canais || []).map((x) => `${x.canal}:${x.n}`).join(' '))
      if (k === 'canalDeHoje') return esc(c.canal)
      return esc(c[k])
    }).join(';')
    const corpo = r.todas.map(linha).join('\n')
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="conversas-${new Date().toISOString().slice(0, 10)}.csv"`,
    })
    res.end('﻿' + cols.join(';') + '\n' + corpo)
    return true
  }

  return false
}
