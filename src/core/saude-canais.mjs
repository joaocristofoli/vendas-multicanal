// QUANDO UM CANAL CAI, O HUMANO FICA SABENDO.
//
// Em 26/07/2026 a sessão do Tinder expirou às 14:56 e ninguém avisou. O sistema SABIA: o
// `loopTick` chama `checkSession()` a cada volta, via o 401, tentava recuperar pelo Chrome e
// seguia em silêncio quando não conseguia. Quatro horas e meia depois foi o dono que
// percebeu, olhando a tela. É a mesma família dos outros defeitos do dia — botão que não
// responde, rota que pendura: falha que não grita.
//
// O desenho tem três decisões:
//
// 1. QUEM JÁ SABE, CONTA. Não existe um sondador paralelo perguntando "tudo bem?" — isso
//    gastaria chamada de API e ainda poderia discordar do que o tick de verdade viu. Quem
//    descobre é quem já estava lá (o loopTick do Tinder, o onStatus do WhatsApp, o sync do
//    Instagram) e só REGISTRA o que viu.
//
// 2. AVISA NA TRANSIÇÃO, NUNCA NO ESTADO. Canal caído dispara UM aviso, não um por minuto.
//    Alarme que repete vira alarme que se ignora — e aí o próximo, o de verdade, passa batido.
//
// 3. VOLTAR TAMBÉM É NOTÍCIA — MAS SÓ SE A QUEDA FOI. Em 26/07/2026 o dono recebeu 16
//    "o whatsapp voltou" em duas horas sem nunca ter recebido um "caiu": cada reinício do
//    serviço (deploy é rotina) passa por CONNECTING, e a queda de 3 segundos morria antes do
//    tick de 60s que avisa. A volta, essa, era anunciada na hora e sem condição. Volta de
//    queda que ninguém soube que existiu não é notícia, é ruído — e ruído treina a pessoa a
//    ignorar o alarme, que é exatamente o defeito que este arquivo existe pra corrigir.
//    Por isso `registrar` devolve o `avisadaEm` da queda anterior: quem anuncia decide com
//    ele. Quem espera pra ver se é queda de verdade é quem conhece o canal (o núcleo).
import { db, logEvent } from './db.mjs'

export function garantirTabela() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS canal_saude (
      canal TEXT PRIMARY KEY,
      ok INTEGER,              -- 1 de pé, 0 caído
      motivo TEXT,             -- por que caiu, em português
      desde INTEGER,           -- quando entrou NESTE estado
      avisado_em INTEGER,      -- quando o aviso desta queda foi enviado (null = ainda não)
      atualizado_em INTEGER
    );
  `)
  // Receita ESPECÍFICA daquela queda, quando a genérica do canal seria mentira. O mesmo canal
  // cai por motivos que se resolvem de formas opostas: cookie vencido pede reimportar cookie,
  // mas 429 pede ESPERAR — e mandar reimportar cookie num 429 faz a pessoa mexer na sessão à
  // toa e ainda bater mais no Instagram. Conselho errado é pior que conselho nenhum.
  const cols = db().prepare(`PRAGMA table_info(canal_saude)`).all().map((c) => c.name)
  if (!cols.includes('como_resolver')) db().exec(`ALTER TABLE canal_saude ADD COLUMN como_resolver TEXT`)
}

const agora = () => Date.now()

// O que cada canal precisa pra voltar. Escrito aqui porque o momento em que ele lê o aviso é
// exatamente o momento em que ele quer saber o que fazer — mandar "caiu" sem dizer como
// resolver só transfere o problema.
const COMO_RESOLVER = {
  tinder: 'pegue o token novo em tinder.com: Console do navegador -> localStorage.getItem(\'TinderWeb/APIToken\')',
  whatsapp: 'reconectar pelo painel (aba WhatsApp) — pode pedir QR de novo',
  instagram: 'reimportar os cookies do Instagram pelo painel',
  badoo: 'reimportar os cookies do Badoo pelo painel',
  telegram: 'logar de novo no Telegram (precisa do número dela e do código que chega no app)',
  meupatrocinio: 'logar de novo no Meu Patrocínio (o refresh do token venceu)',
  // Não é um canal de conversa, é uma CAPACIDADE — mas cai igual, precisa avisar igual e tem
  // receita igual, então mora na mesma tabela em vez de ganhar um alarme paralelo só dela.
  transcricao: 'rode `bash deploy/whisper.sh` no Mac (provisiona ffmpeg + faster-whisper na VM)',
}

// Como o item é chamado no aviso. Sem isto o texto sairia "o transcricao caiu".
const NOME = { transcricao: 'a transcrição de áudio' }
const comoChamar = (canal) => NOME[canal] || `o ${canal}`

// Registra o que um tick VIU. Idempotente e barato: só escreve quando algo muda de fato.
// Devolve a transição, se houve — é o que dispara o aviso.
export function registrar({ canal, ok, motivo = null, comoResolver = null }) {
  if (!canal) return null
  garantirTabela()
  const antes = db().prepare(`SELECT * FROM canal_saude WHERE canal=?`).get(canal) || null
  const estavaOk = antes ? !!antes.ok : true      // primeiro contato: assume que estava de pé
  const t = agora()

  if (antes && !!antes.ok === !!ok) {
    // mesmo estado: só atualiza o carimbo e o motivo, sem mexer no `desde` nem reavisar
    db().prepare(`UPDATE canal_saude SET motivo=?, como_resolver=?, atualizado_em=? WHERE canal=?`)
      .run(ok ? null : motivo, ok ? null : comoResolver, t, canal)
    return null
  }

  db().prepare(`INSERT INTO canal_saude(canal,ok,motivo,como_resolver,desde,avisado_em,atualizado_em)
    VALUES(@c,@ok,@m,@r,@t,NULL,@t)
    ON CONFLICT(canal) DO UPDATE SET ok=@ok, motivo=@m, como_resolver=@r, desde=@t, avisado_em=NULL, atualizado_em=@t`)
    .run({ c: canal, ok: ok ? 1 : 0, m: ok ? null : motivo, r: ok ? null : comoResolver, t })

  if (!antes) return null   // primeiro registro do canal não é notícia
  const tipo = ok ? 'voltou' : 'caiu'
  logEvent({ type: `canal_${tipo}`, channel: canal, detail: ok ? 'de pé de novo' : (motivo || 'sem motivo') })
  // `avisadaEm`: quando o dono foi avisado DESTA queda que está terminando. Null significa
  // que a queda passou muda — e volta de queda muda não se anuncia.
  return { canal, tipo, motivo, estavaOk, quanto: antes.desde ? t - antes.desde : null, avisadaEm: antes.avisado_em || null }
}

export function estado() {
  garantirTabela()
  return db().prepare(`SELECT * FROM canal_saude ORDER BY ok ASC, canal`).all().map((r) => ({
    canal: r.canal,
    ok: !!r.ok,
    motivo: r.motivo || null,
    desde: r.desde || null,
    comoResolver: r.ok ? null : (r.como_resolver || COMO_RESOLVER[r.canal] || null),
  }))
}

export function caidos() { return estado().filter((c) => !c.ok) }

// Quantas horas/minutos, em português — o aviso fica muito mais útil com "há 4h" do que com
// um timestamp que ele teria que converter de cabeça.
function haQuanto(ms) {
  if (!ms) return ''
  const min = Math.round((agora() - ms) / 60000)
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  return h < 24 ? `há ${h}h${min % 60 ? String(min % 60).padStart(2, '0') : ''}` : `há ${Math.floor(h / 24)} dia(s)`
}

// O tick que AVISA. Só fala de queda ainda não avisada — é o que separa "alarme" de "ruído".
export async function tick({ avisar } = {}) {
  garantirTabela()
  const pendentes = db().prepare(`SELECT * FROM canal_saude WHERE ok=0 AND avisado_em IS NULL`).all()
  const enviados = []
  for (const c of pendentes) {
    const texto = [
      `${comoChamar(c.canal)} caiu ${haQuanto(c.desde)}`,
      c.motivo ? `motivo: ${c.motivo}` : null,
      // a receita da QUEDA vem antes da do canal: um 429 se resolve esperando, não mexendo no cookie
      (c.como_resolver || COMO_RESOLVER[c.canal]) ? `pra voltar: ${c.como_resolver || COMO_RESOLVER[c.canal]}` : null,
    ].filter(Boolean).join('\n')
    try {
      if (avisar) await avisar(texto)
      db().prepare(`UPDATE canal_saude SET avisado_em=? WHERE canal=?`).run(agora(), c.canal)
      enviados.push(c.canal)
    } catch (e) { logEvent({ type: 'canal_aviso_erro', channel: c.canal, detail: e.message }) }
  }
  return { avisados: enviados }
}

// Avisa que VOLTOU. Chamado pelo registrar via quem orquestra — separado porque a volta é
// uma transição e não sobrevive no banco esperando (o estado já é "ok").
export async function avisarVolta({ canal, quanto, avisar }) {
  const texto = `${comoChamar(canal)} voltou${quanto ? ` (ficou fora ${haQuanto(agora() - quanto)})` : ''}`
  try { if (avisar) await avisar(texto) } catch (e) { logEvent({ type: 'canal_aviso_erro', channel: canal, detail: e.message }) }
}

export { COMO_RESOLVER }
