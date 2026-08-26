// O QUE SAI DAQUI CHEGA IGUAL DO OUTRO LADO? — respondido por MEDIDA, não por opinião.
//
// A dúvida é antiga e legítima: "vídeo no WhatsApp perde qualidade". No aplicativo do celular
// isso é verdade, e é fácil de explicar: quem comprime é o CLIENTE, antes de mandar. A mídia
// do WhatsApp é criptografada ponta a ponta — o servidor guarda um blob que ele não consegue
// nem ler, quanto mais recodificar. Então a pergunta que sobra não é sobre o WhatsApp: é sobre
// o NOSSO cliente. O Baileys mexe nos bytes antes de subir?
//
// Isto responde sem argumentar: manda o arquivo, BAIXA DE VOLTA do próprio WhatsApp,
// descriptografa e compara o sha256 com o que saiu daqui. Se bate, ninguém tocou.
//
// É diagnóstico, não caminho de produção — roda quando alguém pergunta, não a cada envio.
import { createHash } from 'node:crypto'
import { getBaileys } from './baileys.mjs'

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

// Manda `buffer` pro `jid` no formato pedido e devolve o veredito do ida-e-volta.
// comoArquivo=true manda como DOCUMENTO (o "enviar como arquivo" do aplicativo).
export async function provarFidelidade(sock, jid, buffer, { comoArquivo = false, fileName = 'video.mp4', mimetype = 'video/mp4' } = {}) {
  if (!sock) throw new Error('WhatsApp não conectado')
  if (!buffer || !buffer.length) throw new Error('arquivo vazio')
  const conteudo = comoArquivo
    ? { document: buffer, mimetype, fileName }
    : { video: buffer, mimetype }
  const enviado = await sock.sendMessage(jid, conteudo)

  const { downloadMediaMessage } = await getBaileys()
  if (typeof downloadMediaMessage !== 'function') throw new Error('esta versão do baileys não sabe baixar mídia de volta')
  // reuploadRequest: se o WhatsApp já tiver descartado a cópia do servidor, ele pede pro
  // remetente subir de novo. Aqui o remetente somos nós, então o caminho fecha sozinho.
  const volta = await downloadMediaMessage(enviado, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage })

  const enviadoSha = sha(buffer)
  const voltouSha = sha(volta)
  return {
    tipo: comoArquivo ? 'document' : 'video',
    bytesEnviados: buffer.length,
    bytesVoltaram: volta.length,
    shaEnviado: enviadoSha,
    shaVoltou: voltouSha,
    identico: enviadoSha === voltouSha,
    providerMessageId: enviado?.key?.id || null,
  }
}
