// Enviar foto numa conversa do Instagram, com o destinatário CONFERIDO CONTRA ESTADO VIVO.
//
// A história que produziu este arquivo (03/08/2026): duas fotos de teste foram parar com
// terceiros. A investigação mostrou que o envio pelo composer NÃO era o culpado — nas duas
// vezes ele entregou exatamente na conversa que estava aberta. Os erros foram outros:
//
//   1. disparar com a página no INBOX (nenhuma conversa aberta) — aí vai pra qualquer uma;
//   2. abrir a conversa ERRADA, porque o alvo foi escolhido pelo `ig_chat` (um cache que o
//      sync reescreve) e depois CONFERIDO contra esse mesmo cache. Auto-confirmação: a trava
//      aprovou com confiança um destino errado, o que é pior que não ter trava.
//
// Daí as três regras deste módulo, todas contra a PÁGINA e nunca contra o banco:
//   - sem conversa aberta na URL -> aborta;
//   - quem é a conversa quem diz é a própria página (o banco não opina);
//   - não deu pra ler quem é -> aborta. Vazio nunca vira palpite.
//
// E a conferência roda DUAS vezes: antes de anexar e imediatamente antes de disparar. Entre
// uma e outra o Instagram pode navegar sozinho, e foi num intervalo desses que a primeira
// foto escapou.
import { getSetting } from '../core/db.mjs'

// O @ da conversa ABERTA, lido da página. Exclui o perfil da própria dona — foi ele que
// envenenou a primeira versão desta leitura, que devolvia o handle dela e teria barrado
// envios legítimos (ou aprovado errados noutro layout).
export async function quemEstaAberto(page) {
  const meu = String(getSetting('ig_me', '') || '').toLowerCase().replace(/^@/, '')
  return await page.evaluate((meuArroba) => {
    const RESERVADAS = ['direct', 'explore', 'reels', 'accounts', 'stories', 'p', 'legal', 'about']
    for (const a of document.querySelectorAll('a[href^="/"]')) {
      const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9._]+)\/$/)
      if (!m) continue
      const u = m[1].toLowerCase()
      if (RESERVADAS.includes(u) || u === meuArroba) continue
      return u
    }
    return null
  }, meu).catch(() => null)
}

// Confere que a conversa aberta é de `esperado`. Lança com o motivo — nunca devolve false,
// porque um `if` esquecido no chamador viraria foto na conversa de um estranho.
export async function conferirConversaAberta(page, esperado) {
  const alvo = String(esperado || '').toLowerCase().replace(/^@/, '')
  if (!alvo) throw new Error('ABORTADO: não foi dito para quem é o envio.')
  if (!/\/direct\/t\/\d+/.test(String(page.url() || ''))) {
    throw new Error(`ABORTADO: a página não está numa conversa (${String(page.url()).slice(0, 60)}). Sem conversa aberta o envio cai em quem estiver em foco.`)
  }
  const quem = await quemEstaAberto(page)
  if (!quem) throw new Error('ABORTADO: não consegui ler de quem é a conversa aberta. Sem saber o destinatário, não mando.')
  if (quem !== alvo) throw new Error(`ABORTADO: a conversa aberta é do @${quem}, e o envio era pro @${alvo}.`)
  return quem
}

// Abre a conversa e espera a URL FIXAR. O Instagram redireciona pro inbox enquanto a rota
// monta, e é nesse intervalo que um envio escaparia.
export async function abrirConversa(page, threadId, { tentativas = 30 } = {}) {
  await page.goto(`https://www.instagram.com/direct/t/${threadId}/`, { waitUntil: 'domcontentloaded' })
  let firme = 0
  for (let i = 0; i < tentativas; i++) {
    await page.waitForTimeout(1000)
    if (String(page.url()).includes(`/direct/t/${threadId}`)) { if (++firme >= 4) return true } else firme = 0
  }
  throw new Error(`ABORTADO: a conversa ${threadId} não ficou aberta (a página voltou pro inbox).`)
}

// Envia a foto. `paraArroba` é obrigatório: o destinatário é PARÂMETRO, e é conferido contra
// a página antes de anexar e antes de disparar.
export async function enviarFoto(page, { threadId, paraArroba, arquivo }) {
  await abrirConversa(page, threadId)
  await conferirConversaAberta(page, paraArroba)                    // trava 1

  await page.waitForSelector('input[type=file]', { state: 'attached', timeout: 20000 })
  const input = await page.$('input[type=file]')
  if (!input) throw new Error('ABORTADO: o composer não tem campo de arquivo.')
  await input.setInputFiles(arquivo)
  await page.waitForTimeout(4000)

  const confirmado = await conferirConversaAberta(page, paraArroba) // trava 2 — a que faltou
  await page.keyboard.press('Enter')
  await page.waitForTimeout(8000)
  return { enviadoPara: confirmado, threadId }
}
