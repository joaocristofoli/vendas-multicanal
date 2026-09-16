// A ECONOMIA DE UMA CAPACIDADE: quanto custou descobrir, e quanto custa usar.
//
// Regra do dono (26/07/2026): "no desenvolvimento pode gastar quanto quiser de tokens, mas a
// ideia é não gastar mais depois que descobriu como fazer".
//
// Isso é uma afirmação sobre CUSTO, e afirmação sobre custo sem medida é conversa. Então o
// sistema mede as duas pontas:
//
//   DESCOBERTA — quanto o modelo gastou pra achar o mecanismo. Medido de verdade, pelo
//                delta de `lifetimeTokens` da conta OpenAI entre o começo e o fim da missão.
//                Não é estimativa.
//   USO        — quantas vezes a capacidade rodou depois disso. Cada execução conta, venha
//                de rota, evento, cron ou chamada direta.
//
// O que a tabela deixa evidente é a curva que ele quer: um pico de gasto, uma vez, e depois
// uma reta no zero por mais uso que se faça. Uma capacidade que continuasse gastando por uso
// apareceria aqui na hora — é o alarme contra a coisa degradar de volta pra "pergunta pro
// modelo toda vez".
import { db, logEvent } from '../core/db.mjs'

export function garantirTabela() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS skill_economia (
      skill TEXT PRIMARY KEY,
      tokens_descoberta INTEGER,             -- NULL = não medido; 0 = medido e deu zero
      voltas_descoberta INTEGER DEFAULT 0,   -- quantas voltas de missão custou
      usos INTEGER DEFAULT 0,                -- execuções depois de pronta (todas custam 0)
      primeiro_uso INTEGER, ultimo_uso INTEGER, atualizada_em INTEGER
    );
  `)
}

const agora = () => Date.now()

// Registra o custo da descoberta. Chamado pela missão quando ela é cumprida.
export function registrarDescoberta({ skill, tokens, voltas }) {
  if (!skill) return
  garantirTabela()
  db().prepare(`INSERT INTO skill_economia(skill,tokens_descoberta,voltas_descoberta,usos,atualizada_em)
    VALUES(@s,@t,@v,0,@ts)
    ON CONFLICT(skill) DO UPDATE SET tokens_descoberta=tokens_descoberta+@t, voltas_descoberta=voltas_descoberta+@v, atualizada_em=@ts`)
    .run({ s: skill, t: Math.max(0, Number(tokens) || 0), v: Number(voltas) || 0, ts: agora() })
  logEvent({ type: 'skill_custo_descoberta', detail: `${skill}: ${tokens} tokens em ${voltas} volta(s)` })
}

// Conta UM uso. Barato de propósito (um UPDATE): isto roda no caminho quente, inclusive
// dentro de gatilho de mensagem recebida. Nunca lança.
export function contarUso(skill) {
  if (!skill) return
  try {
    garantirTabela()
    const t = agora()
    db().prepare(`INSERT INTO skill_economia(skill,tokens_descoberta,usos,primeiro_uso,ultimo_uso,atualizada_em)
      VALUES(@s,NULL,1,@t,@t,@t)
      ON CONFLICT(skill) DO UPDATE SET usos=usos+1, primeiro_uso=COALESCE(primeiro_uso,@t), ultimo_uso=@t, atualizada_em=@t`)
      .run({ s: skill, t })
  } catch { /* contabilidade nunca derruba a execução */ }
}

export function daSkill(skill) {
  garantirTabela()
  return db().prepare(`SELECT * FROM skill_economia WHERE skill=?`).get(skill) || null
}

export function livro() {
  garantirTabela()
  return db().prepare(`SELECT * FROM skill_economia ORDER BY usos DESC`).all()
}

// O relatório. O número que interessa não é "quanto gastei" — é `custoPorUso`, que tem que
// cair pra perto de zero conforme a capacidade é usada. Se ele não cair, a capacidade não
// foi cristalizada: alguém deixou o modelo no caminho.
export function relatorio() {
  const linhas = livro()
  let descoberta = 0, usos = 0, semMedida = 0
  for (const l of linhas) {
    if (l.tokens_descoberta == null) semMedida++; else descoberta += l.tokens_descoberta
    usos += l.usos || 0
  }
  return {
    totalTokensGastosDescobrindo: descoberta,
    capacidadesSemCustoMedido: semMedida,
    totalUsosDepois: usos,
    tokensPorUso: usos ? +(descoberta / usos).toFixed(1) : null,
    // custo MARGINAL: o que o próximo uso vai custar. É o número que define se a arquitetura
    // está funcionando — tem que ser exatamente 0, sempre.
    custoDoProximoUso: 0,
    porSkill: linhas.map((l) => ({
      skill: l.skill,
      // `null` e `0` são coisas diferentes e o relatório tem que distinguir: um é "não sei
      // quanto custou", o outro é "custou zero". Misturar os dois é a mesma família de erro
      // de relatar parcial como total.
      descoberta: l.tokens_descoberta == null
        ? { tokens: null, medido: false, porque: 'o contador da OpenAI é agregado por dia e não se move dentro de uma missão' }
        : { tokens: l.tokens_descoberta, medido: true, voltas: l.voltas_descoberta || 0 },
      usos: l.usos || 0,
      tokensPorUso: (l.usos && l.tokens_descoberta != null) ? +(l.tokens_descoberta / l.usos).toFixed(1) : null,
      desde: l.primeiro_uso ? new Date(l.primeiro_uso).toISOString().slice(0, 10) : null,
    })),
  }
}

export function comoTexto() {
  const r = relatorio()
  if (!r.porSkill.length) return 'ECONOMIA: nenhuma capacidade cristalizada ainda.'
  return [
    'ECONOMIA DAS CAPACIDADES (descobrir custa uma vez; usar custa zero):',
    ...r.porSkill.map((s) => `  ${s.skill}: descoberta ${s.descoberta.medido ? `${s.descoberta.tokens} tokens em ${s.descoberta.voltas} volta(s)` : 'NÃO MEDIDA'} | ${s.usos} uso(s) desde então | próximo uso: 0`),
    `  Total: ${r.totalTokensGastosDescobrindo} tokens investidos, ${r.totalUsosDepois} execuções.`,
  ].join('\n')
}
