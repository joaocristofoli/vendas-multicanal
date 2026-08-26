// ONDE ESTA INSTÂNCIA GUARDA AS COISAS — uma fonte só.
//
// Antes disto, cada módulo escrevia o próprio padrão: `process.env.X || '/opt/vendas-multicanal/...'`,
// vinte e duas vezes. Funciona na instância de origem e é uma bomba no clone: basta UMA
// variável faltar no env pra aquela instância gravar dentro da pasta da anterior.
//
// FOI O QUE ACONTECEU EM 13/08/2026. `src/wa/account.mjs` tinha duas constantes SEM variável
// nenhuma (a sessão do WhatsApp e a mídia). No clone recém-criado, parear o WhatsApp virava
// `EACCES: permission denied, mkdir '/opt/vendas-multicanal'` — e na tela isso aparecia como "o
// WhatsApp derrubou a conexão antes de mandar o QR", que manda a investigação pro lado
// errado (o WhatsApp, a rede, o histórico) enquanto o defeito era de caminho.
//
// A REGRA: o padrão ACOMPANHA a instância. Sem env nenhum, o clone ainda grava na pasta
// dele, porque o padrão é derivado do nome — não é uma constante escrita à mão.
//
// Este arquivo não importa nada de propósito: ele é lido no topo de módulos que já são
// importados por todo mundo (db, wa), e qualquer import aqui viraria ciclo.

export const SISTEMA = process.env.TIM_SISTEMA || 'vendas-multicanal'
export const RAIZ = `/opt/${SISTEMA}`

export const APP_DIR = process.env.TIM_APP_DIR || `${RAIZ}/app`
export const DATA_DIR = process.env.TIM_DATA_DIR || `${RAIZ}/data`
export const CONTAS_DIR = process.env.TIM_CONTAS_DIR || `${RAIZ}/contas`
export const ENV_PATH = `${RAIZ}/env`
export const WHISPER_PY = process.env.TIM_WHISPER_PY || `${RAIZ}/whisper-venv/bin/python`

export const DB_PATH = process.env.TIM_DB_PATH || `${DATA_DIR}/${SISTEMA}.db`
export const MEDIA_DIR = process.env.TIM_MEDIA_DIR || `${DATA_DIR}/wa-media`
// A SESSÃO do WhatsApp. Era literal e sem env: o clone tentava parear na pasta da origem.
export const WA_AUTH_DIR = process.env.TIM_WA_AUTH_DIR || `${DATA_DIR}/wa-auth`
export const SAVED_IMAGE_DIR = process.env.TIM_SAVED_IMAGE_DIR || `${DATA_DIR}/wa-saved-image`
export const SAVED_AUDIO_DIR = process.env.TIM_SAVED_AUDIO_DIR || `${DATA_DIR}/wa-saved-audio`
export const VIDEO_DIR = process.env.TIM_VIDEO_DIR || `${DATA_DIR}/videos`
export const ENTREVISTA_DIR = process.env.TIM_ENTREVISTA_DIR || `${DATA_DIR}/entrevista`
export const ACOES_IPC_DIR = process.env.TIM_ACOES_IPC_DIR || `${APP_DIR}/.vendas-multicanal-ipc/acoes`

// A identidade viva — o "eu" que a IA lê. É a que mais dói errar: apontar pro caminho da
// origem faz uma pessoa falar com o retrato de outra.
const SOBRE_MIM = `${DATA_DIR}/sobre-mim`
export const DONO_PATH = process.env.TIM_DONO_PATH || `${SOBRE_MIM}/dono.json`
export const PERFIL_PATH = process.env.TIM_PERSONAL_PROFILE_PATH || `${SOBRE_MIM}/quem-eu-sou.md`
export const ESTILO_PATH = process.env.TIM_CONVERSATION_STYLE_PATH || `${SOBRE_MIM}/como-eu-converso.md`
export const NUCLEO_VOZ_PATH = process.env.TIM_NUCLEO_VOZ_PATH || `${SOBRE_MIM}/nucleo-voz.md`
export const EXEMPLOS_VOZ_PATH = process.env.TIM_EXEMPLOS_VOZ_PATH || `${SOBRE_MIM}/exemplos-voz.json`
export const PONTES_PATH = process.env.TIM_PONTES_PATH || `${SOBRE_MIM}/pontes.json`

// LEITURA TARDIA. As constantes acima são resolvidas quando ESTE módulo carrega — e ele
// carrega cedo, porque `db.mjs` o importa. Quem definir a variável DEPOIS (todo teste que
// escreve uma fixture e só então importa o módulo) seria ignorado em silêncio, e foi o que
// aconteceu com as pontes: o teste passou a ler o arquivo de produção em vez da fixture.
// Onde o caminho pode mudar em tempo de execução, resolva com estas funções.
export const pontesPath = () => process.env.TIM_PONTES_PATH || `${DATA_DIR}/sobre-mim/pontes.json`
export const perfilPath = () => process.env.TIM_PERSONAL_PROFILE_PATH || `${DATA_DIR}/sobre-mim/quem-eu-sou.md`
export const exemplosVozPath = () => process.env.TIM_EXEMPLOS_VOZ_PATH || `${DATA_DIR}/sobre-mim/exemplos-voz.json`
export const MODOS_DIR = process.env.TIM_MODOS_DIR || `${SOBRE_MIM}/modos`
export const VINCULOS_DIR = process.env.TIM_VINCULOS_DIR || `${SOBRE_MIM}/vinculos`
