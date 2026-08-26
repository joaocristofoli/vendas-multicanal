// Carregamento dinâmico e memoizado do módulo baileys.
// Nunca importamos makeWASocket estaticamente: a RC (7.0.0-rc13) expõe formas
// diferentes conforme o build (default export vs. named export), e o import
// dinâmico cobre os dois casos sem quebrar em tempo de parse. O resultado é
// resolvido uma única vez e reaproveitado (memoização via _cache).

let _cache = null
let _loading = null

// Retorna as peças da API do baileys que o vendas-multicanal usa:
//   { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestWaWebVersion }
// Valida que todas existem; se alguma faltar, lança erro claro (versão errada
// do baileys instalada, ou pacote ausente).
export async function getBaileys() {
  if (_cache) return _cache
  if (_loading) return _loading

  _loading = (async () => {
    let baileys
    try {
      baileys = await import('baileys')
    } catch (err) {
      throw new Error(`Falha ao carregar o modulo 'baileys' (esperado 7.0.0-rc13): ${err && err.message ? err.message : err}`)
    }

    // Cobre os dois shapes da RC: default export OU named export.
    const makeWASocket = baileys.default || baileys.makeWASocket
    const { useMultiFileAuthState, Browsers, fetchLatestWaWebVersion, downloadMediaMessage, downloadContentFromMessage, generateWAMessageFromContent, decryptPollVote } = baileys

    const faltando = []
    if (typeof makeWASocket !== 'function') faltando.push('makeWASocket (default || makeWASocket)')
    if (typeof useMultiFileAuthState !== 'function') faltando.push('useMultiFileAuthState')
    if (!Browsers) faltando.push('Browsers')
    if (typeof fetchLatestWaWebVersion !== 'function') faltando.push('fetchLatestWaWebVersion')
    if (faltando.length) {
      throw new Error(`Modulo 'baileys' carregado mas incompleto — faltando: ${faltando.join(', ')}. Verifique a versao instalada (baileys 7.0.0-rc13).`)
    }

    // downloadMediaMessage é opcional (baixa/descriptografa áudio/imagem); se faltar,
    // a captura de mídia fica desligada mas o resto funciona.
    _cache = { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestWaWebVersion, downloadMediaMessage: typeof downloadMediaMessage === 'function' ? downloadMediaMessage : null, downloadContentFromMessage: typeof downloadContentFromMessage === 'function' ? downloadContentFromMessage : null, generateWAMessageFromContent: typeof generateWAMessageFromContent === 'function' ? generateWAMessageFromContent : null, decryptPollVote: typeof decryptPollVote === 'function' ? decryptPollVote : null }
    return _cache
  })()

  try {
    return await _loading
  } finally {
    _loading = null
  }
}
