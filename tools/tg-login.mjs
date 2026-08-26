#!/usr/bin/env node
// Login do TELEGRAM da dona da instância (MTProto, conta de pessoa — nunca bot).
//
// POR QUE EXISTE: `src/telegram/session.mjs` sempre soube pedir código e entrar, mas ninguém
// chamava essas funções — nem painel, nem rota, nem ferramenta. Na prática o login saía de um
// `node -e` colado no terminal, que some quando a janela fecha e não deixa rastro de como foi
// feito. Aqui ele vira um passo repetível, igual pra toda instância da linhagem.
//
// O LOGIN É EM DOIS TEMPOS e não tem como ser diferente: o código chega no aplicativo dela e
// nenhum processo daqui pode adivinhá-lo. Entre um passo e outro o estado fica no banco
// (`tg_login_session` + `tg_login_hash`), então não é preciso deixar processo pendurado.
//
// USO (dentro da VM, em /opt/<instancia>/app):
//   node tools/tg-login.mjs estado
//   node tools/tg-login.mjs cred <api_id> <api_hash>     <- de my.telegram.org
//   node tools/tg-login.mjs codigo +5541999999999        <- o Telegram manda o código no app dela
//   node tools/tg-login.mjs entrar 12345 [senha-2etapas]
//   node tools/tg-login.mjs sair                         <- esquece a sessão salva
//
// O api_id/api_hash é do APLICATIVO, não da conta: sai de my.telegram.org logando com um
// número. Um mesmo par serve pra logar qualquer conta, mas instâncias diferentes usarem o
// mesmo par junta as duas no mesmo aplicativo aos olhos do Telegram — se ele derrubar o
// aplicativo, derruba todas de uma vez. Por instância, um par.
//
// SEGURANÇA: `entrar` mostra QUEM entrou (nome, @ e número) antes de dizer que deu certo. Uma
// credencial pode estar apontando pra conta errada e o único jeito de saber é perguntando ao
// servidor de quem é a conta — nunca confiar em quem digitou.
import { getSetting, setSetting } from '../src/core/db.mjs'
import { estado, pedirCodigo, confirmarCodigo, credenciaisDeclaradas } from '../src/telegram/session.mjs'

const [cmd, ...args] = process.argv.slice(2)
const sistema = process.env.TIM_SISTEMA || 'tim'

function ajuda() {
  console.log(`uso: node tools/tg-login.mjs <comando>

  estado                        o que o canal sabe hoje
  cred <api_id> <api_hash>      grava a credencial do aplicativo (my.telegram.org)
  codigo <telefone>             pede o código; ele chega no aplicativo dela
  entrar <codigo> [senha]       entra com o código (e a senha de 2 etapas, se houver)
  sair                          apaga a sessão salva (o próximo boot fica sem Telegram)

instância: ${sistema}`)
}

async function main() {
  if (!cmd || cmd === 'ajuda' || cmd === '--help') { ajuda(); return }

  if (cmd === 'estado') {
    const e = await estado()
    console.log(`[${sistema}] api_id/api_hash: ${credenciaisDeclaradas() ? 'declarados' : 'FALTAM (crie em my.telegram.org)'}`)
    console.log(`[${sistema}] sessão salva:    ${getSetting('tg_session', null) ? 'sim' : 'não'}`)
    const emAndamento = getSetting('tg_login_phone', null)
    if (emAndamento) console.log(`[${sistema}] login em andamento para ${emAndamento} — falta "entrar <codigo>"`)
    console.log(`[${sistema}] conexão:         ${e.ok ? `ok, logado como ${e.me}` : `não — ${e.motivo}`}`)
    return
  }

  if (cmd === 'cred') {
    const [apiId, apiHash] = args
    if (!apiId || !apiHash) { console.error('faltou: node tools/tg-login.mjs cred <api_id> <api_hash>'); process.exit(1) }
    if (!/^\d+$/.test(apiId)) { console.error(`api_id é só número; veio "${apiId}"`); process.exit(1) }
    const anterior = getSetting('tg_api_id', 0)
    if (anterior && String(anterior) !== String(apiId) && getSetting('tg_session', null)) {
      console.error(`ATENÇÃO: já existe sessão salva com o api_id ${anterior}. Trocar a credencial invalida ela.`)
      console.error('rode "sair" antes se é isso mesmo que você quer.')
      process.exit(1)
    }
    setSetting('tg_api_id', Number(apiId))
    setSetting('tg_api_hash', String(apiHash).trim())
    console.log(`[${sistema}] credencial gravada (api_id ${apiId}). Agora: node tools/tg-login.mjs codigo <telefone>`)
    return
  }

  if (cmd === 'codigo') {
    const telefone = args[0]
    if (!telefone) { console.error('faltou o telefone, com país: +5541999999999'); process.exit(1) }
    if (!/^\+\d{10,15}$/.test(telefone)) { console.error(`telefone tem que vir com + e só dígitos; veio "${telefone}"`); process.exit(1) }
    await pedirCodigo({ telefone })
    console.log(`[${sistema}] código pedido para ${telefone}. Ele chega NO APLICATIVO Telegram dela (não por SMS, se ela já usa o app).`)
    console.log('em seguida: node tools/tg-login.mjs entrar <codigo>')
    return
  }

  if (cmd === 'entrar') {
    const [codigo, senha] = args
    if (!codigo) { console.error('faltou o código que chegou no aplicativo'); process.exit(1) }
    const r = await confirmarCodigo({ codigo, senha: senha || null })
    if (r.precisaSenha) {
      console.log(`[${sistema}] a conta tem verificação em duas etapas: rode de novo com a senha`)
      console.log('  node tools/tg-login.mjs entrar <codigo> <senha>')
      console.log('(o código ainda vale por alguns minutos; se expirar, peça outro com "codigo")')
      process.exit(2)
    }
    // De quem é a conta que acabou de entrar. Pergunta ao servidor, não a quem digitou.
    const { conectar } = await import('../src/telegram/session.mjs')
    const c = await conectar()
    const eu = c ? await c.getMe() : null
    console.log(`[${sistema}] ENTROU como:`)
    console.log(`  nome:     ${[eu?.firstName, eu?.lastName].filter(Boolean).join(' ') || '(sem nome)'}`)
    console.log(`  usuário:  ${eu?.username ? '@' + eu.username : '(sem @)'}`)
    console.log(`  telefone: ${eu?.phone ? '+' + eu.phone : '(não exposto)'}`)
    console.log(`  id:       ${eu?.id || '?'}`)
    console.log('CONFIRA se é a conta certa. Se não for: node tools/tg-login.mjs sair')
    try { await c?.disconnect() } catch { /* já caiu */ }
    return
  }

  if (cmd === 'sair') {
    setSetting('tg_session', null)
    setSetting('tg_me', null)
    setSetting('tg_login_session', null)
    setSetting('tg_login_hash', null)
    setSetting('tg_login_phone', null)
    console.log(`[${sistema}] sessão esquecida. As conversas já baixadas continuam no banco.`)
    console.log('a sessão do lado do Telegram continua viva: pra matar de verdade, ela remove o aparelho em Configurações > Dispositivos.')
    return
  }

  ajuda()
  process.exit(1)
}

main().then(() => process.exit(0)).catch((e) => {
  // O erro do MTProto é a informação, não um detalhe: PHONE_CODE_INVALID, PHONE_CODE_EXPIRED,
  // FLOOD_WAIT_x e PHONE_NUMBER_UNOCCUPIED dizem exatamente o próximo passo. Nunca truncar.
  console.error(`ERRO: ${e && e.message || e}`)
  const m = String(e && e.message || '')
  if (/PHONE_CODE_EXPIRED/.test(m)) console.error('-> o código venceu; peça outro: node tools/tg-login.mjs codigo <telefone>')
  if (/PHONE_CODE_INVALID/.test(m)) console.error('-> código errado; confira no aplicativo e tente de novo')
  if (/FLOOD_WAIT_(\d+)/.test(m)) console.error(`-> o Telegram pediu ${m.match(/FLOOD_WAIT_(\d+)/)[1]}s de espera antes da próxima tentativa`)
  if (/PHONE_NUMBER_UNOCCUPIED/.test(m)) console.error('-> não existe conta nesse número (esse fluxo não cria conta nova)')
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(m)) console.error('-> api_id/api_hash não conferem; refaça em my.telegram.org')
  process.exit(1)
})
