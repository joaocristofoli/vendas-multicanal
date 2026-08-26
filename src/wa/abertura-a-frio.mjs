// O WHATSAPP NÃO ABRE CONVERSA. NUNCA.
//
// 02/08/2026, medido: das 10 conversas de WhatsApp da conta, exatamente UMA foi aberta por
// nós para alguém sem nenhuma mensagem recebida — "Cheguei por aqui", às 19:25:30. A conexão
// caiu às 19:25:33. Três segundos.
//
// O volume não explica: foram 8 mensagens enviadas em DOIS DIAS. Nenhum antifraude derruba
// conta por isso. O que o WhatsApp marca é o PADRÃO — um número que aborda quem nunca falou
// com ele. Responder conversa é inofensivo; abrir é o gatilho. Foi a leitura do dono, e o
// dado confirmou.
//
// Decisão dele (03/08/2026): bloqueia SEMPRE, sem liberação por pessoa. Quem quiser falar com
// ela escreve primeiro. Vale igual pra IA e pro painel — o gatilho é o ato de abrir, não
// quem digitou.
//
// SEM EXCEÇÃO NENHUMA, nem pro self-chat (decisão do dono, 03/08/2026, depois de avisado do
// custo). O self-chat é a conversa dela com o PRÓPRIO número — tecnicamente ele não podia
// disparar nada, porque não existe abordagem a desconhecido quando o destinatário é você
// mesmo. Mesmo assim ele entra na regra: o dono preferiu uma trava sem buraco a uma trava
// com uma exceção pra manter.
//
// O QUE ISSO CUSTA, e onde o custo foi coberto: o aviso de canal caído saía por ali. Sem a
// exceção, ele passa a morrer no bloqueio — e `avisarNoSelfChat` trata isso registrando o
// alarme no DIÁRIO e dando a tentativa por encerrada. Sem esse tratamento, o tick de saúde
// (que só marca "já avisei" quando o envio dá certo) tentaria de novo A CADA MINUTO, pra
// sempre. Trava nova que gera laço infinito é conserto que cria defeito.
import { db } from '../core/db.mjs'

// Esta pessoa já escreveu pra gente no WhatsApp alguma vez?
function jaEscreveu(personId) {
  if (!personId) return false
  return !!db().prepare(`SELECT 1 FROM message WHERE person_id=? AND channel='whatsapp' AND direction='incoming' LIMIT 1`).get(personId)
}

// Mandar isto seria abrir conversa a frio? Devolve o MOTIVO (string) quando sim, null quando
// pode enviar. Devolver o motivo em vez de um booleano é de propósito: quem chama mostra na
// tela e grava no Diário, e "false" não explica nada pra quem está olhando.
export function motivoParaNaoAbrir(accountKey, { personId, jid }) {
  if (jaEscreveu(personId)) return null                                              // já tem conversa
  return 'essa pessoa nunca te escreveu no WhatsApp. Abrir conversa com quem não tem histórico é o que faz o WhatsApp marcar o número — foi o que derrubou a conexão em 02/08. Peça pra ela chamar, ou fale por outro canal.'
}
