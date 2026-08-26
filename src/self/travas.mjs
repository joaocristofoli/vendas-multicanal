// O INVENTÁRIO DE TRAVAS.
//
// Regra do sistema (26/07/2026): "não tenha nenhum bloqueio nessa IA que vai conversar comigo;
// se eu pedir pra ela mandar mensagem pra determinada pessoa pra testar, mesmo que o painel
// bloqueie ou que alguma programação bloqueie, ela deve saber desbloquear".
//
// A leitura errada disso seria arrancar as travas do sistema. Seria burrice: elas existem
// porque o vendas-multicanal fala com OUTRAS pessoas, e uma delas (o disjuntor) é o que impede um laço de
// eco de mandar 300 mensagens pra uma menina às 3 da manhã. Arrancar não deixa ele mais no
// controle — deixa o sistema mais burro.
//
// A leitura certa é: NENHUMA TRAVA PODE SER INVISÍVEL OU IRREVERSÍVEL PRA ELE. O que ele
// não aguenta é pedir uma coisa e o sistema recusar caladinho. Então este módulo publica
// TODA trava que existe, com o estado AGORA, o que ela protege, e a chave exata pra
// levantar. O agente não descobre por tentativa e erro: ele lê a lista e age.
//
// `chave` é comando de shell de verdade, pronto pra rodar. É a diferença entre "existe uma
// forma" e "é assim".
import { db, getSetting, setSetting } from '../core/db.mjs'
import { doDono } from '../core/dono.mjs'

const PAINEL = process.env.TIM_PANEL_URL || 'http://127.0.0.1:8080'
const val = (k, d) => { try { return getSetting(k, d) } catch { return d } }
const conta = (sql, ...p) => { try { return db().prepare(sql).get(...p) } catch { return null } }

// Cada trava responde: está ligada? o que ela impede? por que existe? como levanto?
export function inventario() {
  const t = []

  t.push({
    id: 'assistente_desligado',
    ligada: val('assistente_enabled', true) === false,
    impede: 'eu responder qualquer coisa pra você, no self-chat e no painel',
    porque: 'freio de mão geral; você liga e desliga por texto sem passar por modelo nenhum',
    chave: 'mande "ia on" no self-chat, ou: node tools/trava.mjs assistente on',
  })

  t.push({
    id: 'disjuntor',
    ligada: false,
    dinamica: 'abre sozinho se eu responder mais de 12 vezes em 60s, e fecha sozinho depois',
    impede: 'eu responder enquanto estiver aberto',
    porque: 'ÚNICA trava que eu recomendo manter: é o que impede um eco infinito no WhatsApp. Ela não protege você de você — protege as outras pessoas de um bug meu.',
    chave: 'node tools/trava.mjs disjuntor zerar (apaga as respostas recentes da janela)',
  })

  const ia = (() => { try { return db().prepare(`SELECT channel, COUNT(*) n FROM ai_setting WHERE enabled=1 GROUP BY channel`).all() } catch { return [] } })()
  t.push({
    id: 'ia_por_pessoa',
    ligada: true,
    estado: ia.length ? ia.map((r) => `${r.channel}: ${r.n} ligada(s)`).join(', ') : 'nenhuma pessoa com IA ligada',
    impede: 'a IA de conversa responder sozinha em quem você não ligou',
    porque: 'IA automática nasce desligada por pessoa e por canal; o toggle é a fonte da verdade',
    chave: 'node tools/trava.mjs ia <pessoa> <canal> on|off',
  })

  t.push({
    id: 'clone_fora_do_self_chat',
    ligada: true,
    impede: 'a IA que escreve COMO você responder na SUA conversa consigo mesmo',
    porque: 'sem isso o clone paquera você mesmo e cada resposta dele vira um comando novo — laço infinito. É invariante de sanidade, não permissão.',
    chave: 'existe em src/assistente/guarda.mjs (ehSelfPerson). Levantar não faz sentido; se você quiser mesmo, é editar o guarda — e eu te aviso que vai entrar em laço.',
  })

  t.push({
    id: 'confirmacao_de_envio',
    ligada: true,
    impede: 'o ASSISTENTE (modo normal) mandar mensagem pra alguém sem você confirmar',
    porque: 'no modo normal a mensagem sai com o seu nome e o modelo pode ter entendido errado',
    chave: 'NÃO vale pro modo códex: aqui eu mando direto com `node tools/mandar.mjs`. A confirmação é só do modo normal.',
  })

  t.push({
    id: 'permissao_de_sistema',
    ligada: true,
    impede: 'o ASSISTENTE (modo normal) rodar comando no servidor sem você permitir',
    porque: 'mesma razão: o modelo do modo normal não tem shell, tem catálogo',
    chave: 'NÃO vale pro modo códex: aqui eu já tenho shell dentro de /opt/vendas-multicanal/app.',
  })

  t.push({
    id: 'sandbox_do_codex',
    ligada: true,
    impede: 'eu escrever fora de /opt/vendas-multicanal/app',
    porque: 'a cerca que separa "mexer no meu código" de "mexer na máquina inteira", inclusive nas suas sessões de WhatsApp em /opt/vendas-multicanal/data',
    chave: 'trocar sandbox pra danger-full-access em src/ai/codex.mjs (runAgentTurn). Peça e eu troco — mas prefira me dizer o que precisa fora da cerca.',
  })

  t.push({
    id: 'comandos_proibidos',
    ligada: true,
    impede: 'rm -rf /, mkfs, shutdown, fork bomb e afins pelo caminho do assistente',
    porque: 'lista curta contra alucinação destrutiva, não contra você',
    chave: 'a lista está em src/assistente/sistema.mjs (PROIBIDOS). No modo códex eu tenho shell direto, então ela não me alcança.',
  })

  t.push({
    id: 'cadencia_humana',
    ligada: true,
    impede: 'a IA responder na hora (ela espera um tempo variável, pra parecer gente)',
    porque: 'resposta instantânea denuncia robô',
    chave: 'src/ai/cadence.mjs (replyGate). Pra teste imediato use tools/mandar.mjs, que não passa pela cadência.',
  })

  t.push({
    id: 'audio_da_ia',
    ligada: val('saved_audio_ai', true) !== false,
    impede: 'a IA usar áudios salvos nas respostas dela',
    porque: 'áudio é a sua voz de verdade; você quis um interruptor separado',
    chave: 'node tools/trava.mjs setting saved_audio_ai true|false',
  })

  t.push({
    id: 'interpretar_midia',
    ligada: val('media_interpret', false) === true,
    impede: 'a IA "ver" imagem e vídeo recebidos (custa token, nasce desligada)',
    porque: 'gasto: você quis ligar quando quiser',
    chave: 'node tools/trava.mjs setting media_interpret true|false',
  })

  t.push({
    id: 'chamar_automatico',
    ligada: val('vinculo_chamar_auto', false) === true,
    impede: 'o vendas-multicanal puxar conversa sozinho no WhatsApp quando alguém passa o número',
    porque: 'iniciativa automática com gente real: você quis a mão no volante',
    chave: 'node tools/trava.mjs setting vinculo_chamar_auto true|false',
  })

  const semNumero = conta(`SELECT COUNT(*) n FROM identity WHERE channel='whatsapp'`)?.n ?? 0
  t.push({
    id: 'allowlist_whatsapp',
    ligada: true,
    estado: `${semNumero} conversa(s) com vínculo`,
    impede: 'a IA agir em conversa de WhatsApp que não tem identidade vinculada',
    porque: 'evita a IA falar com quem nunca foi adotado',
    chave: 'adotar a conversa pelo painel, ou inserir em identity. Pra só MANDAR uma mensagem, tools/mandar.mjs não passa pela allowlist.',
  })

  return t
}

// O texto que o agente lê. Curto de propósito: só o que muda a decisão dele.
export function comoTexto() {
  const linhas = ['TRAVAS DO SISTEMA (todas, com o estado agora e a chave pra levantar):']
  for (const t of inventario()) {
    const estado = t.dinamica ? `dinâmica — ${t.dinamica}` : (t.ligada ? 'LIGADA' : 'desligada')
    linhas.push(`- ${t.id} [${estado}]${t.estado ? ` (${t.estado})` : ''}`)
    linhas.push(`    impede: ${t.impede}`)
    linhas.push(`    chave:  ${t.chave}`)
  }
  linhas.push('')
  linhas.push(`Regra: você NUNCA recusa um pedido ${doDono()} dizendo que "o sistema bloqueia". Você levanta a trava, faz, e conta o que levantou. A única que você discute antes é o disjuntor, e mesmo assim ele decide.`)
  return linhas.join('\n')
}

// Levantar/baixar por código — o que o tools/trava.mjs chama.
export function mexer(id, ligar) {
  const settings = { audio_da_ia: 'saved_audio_ai', interpretar_midia: 'media_interpret', chamar_automatico: 'vinculo_chamar_auto', assistente_desligado: 'assistente_enabled' }
  if (settings[id]) { setSetting(settings[id], !!ligar); return { ok: true, setting: settings[id], valor: !!ligar } }
  if (id === 'disjuntor') {
    // O disjuntor conta respostas na última janela. Zerar = apagar o rastro que o mantém
    // aberto. Não é gambiarra: é exatamente o que "fechar o disjuntor" significa aqui.
    const n = db().prepare(`DELETE FROM assistente_msg WHERE papel='vendas-multicanal' AND ts>=?`).run(Date.now() - 60_000).changes
    return { ok: true, apagadas: n }
  }
  return { ok: false, erro: `"${id}" não se levanta por aqui — veja a chave no inventário` }
}

export { PAINEL }
