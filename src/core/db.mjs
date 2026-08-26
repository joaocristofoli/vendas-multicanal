// Fundação de dados do vendas-multicanal (SQLite via better-sqlite3). Uma pessoa canônica (person)
// com canais (identity: tinder/whatsapp); timeline unificada (message.channel);
// pendências, IA auto por pessoa/canal, comprovantes, sessão e revisão de vínculo do
// WhatsApp. Schema derivado de docs/ENTENDIMENTO-IA-DADOS.md §8.7 e PLANO-WHATSAPP §4.
import Database from 'better-sqlite3'
import { ehExplicito, marcarPapoQuente } from '../ai/cadencia-quente.mjs'
// Import CIRCULAR de propósito, igual ao de cima: `etiquetas` também importa `db`. É seguro
// porque nenhum dos dois chama o outro no carregamento — só em runtime, com os dois prontos.
import { aplicarRegras as etiquetasAuto } from '../self/etiquetas.mjs'
import { aplicarCidadeDeTexto } from '../self/cidade-pessoa.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { DB_PATH as CAMINHO_DO_BANCO } from '../core/caminhos.mjs'

const DB_PATH = CAMINHO_DO_BANCO

let _db = null
export function db() {
  if (_db) return _db
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  migrate(_db)
  return _db
}

function migrate(d) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS person (
    person_id TEXT PRIMARY KEY, account_key TEXT, display_name TEXT,
    primary_photo TEXT, created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS identity (
    account_key TEXT, channel TEXT, channel_id TEXT, person_id TEXT,
    link_method TEXT, linked_at INTEGER,
    PRIMARY KEY (channel, channel_id, account_key)
  );
  CREATE INDEX IF NOT EXISTS idx_identity_person ON identity(person_id);

  CREATE TABLE IF NOT EXISTS message (
    message_id TEXT PRIMARY KEY, account_key TEXT, person_id TEXT, channel TEXT,
    direction TEXT, text TEXT, media_json TEXT, ts INTEGER, dedupe_key TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_message_person ON message(person_id, ts);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_message_dedupe ON message(dedupe_key);

  CREATE TABLE IF NOT EXISTS tinder_match (
    account_key TEXT, match_id TEXT, person_id TEXT, other_id TEXT,
    name TEXT, bio TEXT, age INTEGER, city TEXT, photos_json TEXT,
    has_conversation INTEGER DEFAULT 0, pending INTEGER DEFAULT 0,
    last_dir TEXT, last_text TEXT, last_ts INTEGER, shared_contact INTEGER DEFAULT 0,
    history_checked_at INTEGER, active INTEGER DEFAULT 1, updated_at INTEGER,
    PRIMARY KEY (account_key, match_id)
  );
  CREATE INDEX IF NOT EXISTS idx_match_person ON tinder_match(person_id);

  CREATE TABLE IF NOT EXISTS ai_setting (
    person_id TEXT, channel TEXT, enabled INTEGER DEFAULT 0, state TEXT,
    last_attempted_fp TEXT, last_sent_fp TEXT, updated_at INTEGER,
    enabled_at INTEGER,
    PRIMARY KEY (person_id, channel)
  );

  -- Direção opcional da conversa com uma pessoa. Não é tarefa nem projeto: é um
  -- contexto suave que a IA considera somente quando existe.
  CREATE TABLE IF NOT EXISTS person_objective (
    person_id TEXT PRIMARY KEY, objective TEXT NOT NULL, updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS send_receipt (
    account_key TEXT, channel TEXT, target_id TEXT, command_id TEXT,
    text_fp TEXT, state TEXT, provider_msg_id TEXT, ts INTEGER,
    PRIMARY KEY (account_key, channel, target_id)
  );

  CREATE TABLE IF NOT EXISTS wa_session (
    account_key TEXT PRIMARY KEY, status TEXT, jid TEXT, name TEXT,
    qr_data_url TEXT, requires_repair INTEGER DEFAULT 0, updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS wa_link_review (
    id TEXT PRIMARY KEY, account_key TEXT, wa_jid TEXT, wa_push_name TEXT,
    wa_first_text TEXT, candidate_person_id TEXT, candidate_name TEXT,
    candidate_score REAL, reason TEXT, status TEXT DEFAULT 'pending',
    created_at INTEGER, resolved_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS wa_chat (
    account_key TEXT, jid TEXT, name TEXT, last_text TEXT, last_ts INTEGER,
    from_tinder INTEGER DEFAULT 0, adopted INTEGER DEFAULT 0, updated_at INTEGER,
    PRIMARY KEY (account_key, jid)
  );

  CREATE TABLE IF NOT EXISTS ig_chat (
    account_key TEXT, thread_id TEXT, name TEXT, username TEXT, avatar TEXT,
    last_text TEXT, last_ts INTEGER, unread INTEGER DEFAULT 0,
    adopted INTEGER DEFAULT 0, mode TEXT, updated_at INTEGER,
    PRIMARY KEY (account_key, thread_id)
  );

  -- Cache autoritativo LID <-> PN do WhatsApp. O sistema LID entrega a mesma pessoa por duas
  -- identidades: o número (@s.whatsapp.net) e o @lid. A conversa quase sempre chega no @lid,
  -- mas o onWhatsApp só sabe responder em número — é essa tabela que costura os dois lados e
  -- deixa o vínculo do Tinder cair no jid CERTO. Ver docs/PLANO-IDENTIDADE-VINCULO.md §2.3.
  -- source: lidmap (getPNForLID/getLIDForPN do baileys) | msg (veio no evento) | manual.
  CREATE TABLE IF NOT EXISTS wa_identity (
    lid TEXT PRIMARY KEY, pn TEXT, source TEXT, first_seen INTEGER, last_seen INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_wa_identity_pn ON wa_identity(pn);

  -- Contato que a pessoa passou numa conversa (telefone, @ do Instagram, link de WhatsApp).
  -- É a matéria-prima auditável do vínculo: guarda o valor BRUTO, o normalizado e a FRASE
  -- de origem, pra você poder ver depois por que o vendas-multicanal achou que aquilo era um contato.
  -- kind: phone | instagram | wa_link. status: novo | resolvido | ignorado | ambiguo.
  CREATE TABLE IF NOT EXISTS contact_hint (
    id TEXT PRIMARY KEY, account_key TEXT, person_id TEXT, source_channel TEXT,
    source_message_id TEXT, kind TEXT, raw TEXT, normalized TEXT, quote TEXT,
    confidence REAL DEFAULT 1, status TEXT DEFAULT 'novo',
    created_at INTEGER, resolved_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_hint_unico ON contact_hint(person_id, kind, normalized);
  CREATE INDEX IF NOT EXISTS idx_hint_status ON contact_hint(status, created_at);

  -- Veredito humano sobre um envio: "enviou certo" ou "enviou errado" (e por quê). É a
  -- ÚNICA prova de ground-truth sobre um vínculo — só quem opera sabe se quem respondeu é
  -- mesmo a pessoa do Tinder. Realimenta o estado do vínculo (PLANO §2.7).
  -- verdict: certo | errado. reason: pessoa_errada | nao_entregou | texto_ruim | outro.
  CREATE TABLE IF NOT EXISTS send_verdict (
    id TEXT PRIMARY KEY, account_key TEXT, channel TEXT, target_id TEXT,
    message_id TEXT, person_id TEXT, verdict TEXT, reason TEXT, note TEXT, created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_verdict_msg ON send_verdict(message_id);
  CREATE INDEX IF NOT EXISTS idx_verdict_pessoa ON send_verdict(person_id, created_at);

  -- Números/perfis que quem opera marcou como NÃO sendo a pessoa: nunca mais viram vínculo
  -- automático. É o freio de mão do veredito "pessoa errada".
  CREATE TABLE IF NOT EXISTS contato_negado (
    valor TEXT PRIMARY KEY, kind TEXT, person_id TEXT, motivo TEXT, created_at INTEGER
  );

  -- Conversas do Badoo. Mesmo desenho do ig_chat: a conversa e a unidade, a pessoa e
  -- 'b:'+chat_id, e as mensagens moram na tabela message com channel='badoo'. Assim o
  -- Badoo herda de graca o detector de contato, o vinculo e a memoria unificada.
  CREATE TABLE IF NOT EXISTS badoo_chat (
    account_key TEXT, chat_id TEXT, name TEXT, previa TEXT, foto TEXT,
    last_ts INTEGER, unread INTEGER DEFAULT 0, adopted INTEGER DEFAULT 0, mode TEXT,
    updated_at INTEGER,
    PRIMARY KEY (account_key, chat_id)
  );
  CREATE INDEX IF NOT EXISTS idx_badoo_ts ON badoo_chat(account_key, last_ts);

  -- ---------- Telegram (5º canal) ----------
  -- Espelha o badoo_chat: person_id e 'tg:'+chat_id e as mensagens moram na tabela message
  -- com channel='telegram', então memória unificada, vínculo e IA por pessoa funcionam de
  -- graça, sem caso especial.
  --
  -- O ENVIO AQUI TEM DESTINATÁRIO EXPLÍCITO (chat_id como parâmetro na chamada MTProto), ao
  -- contrário do composer do Instagram, onde o alvo é a conversa em foco. É a diferença que
  -- fez duas fotos irem parar com terceiros em 03/08/2026.
  --
  -- O campo username pode ser null: no Telegram muita gente nao tem @. Quem identifica e o chat_id.
  CREATE TABLE IF NOT EXISTS telegram_chat (
    account_key TEXT, chat_id TEXT, nome TEXT, username TEXT, telefone TEXT,
    previa TEXT, last_ts INTEGER, unread INTEGER DEFAULT 0, adopted INTEGER DEFAULT 0, mode TEXT,
    updated_at INTEGER,
    PRIMARY KEY (account_key, chat_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tg_ts ON telegram_chat(account_key, last_ts);

  -- ---------- Meu Patrocinio (6o canal) ----------
  -- DUAS NUMERACOES, guardadas separadas de proposito: peer_id identifica a PESSOA (a leitura
  -- usa ele) e conversation_id identifica a CONVERSA (o envio usa ele). Numa das conversas
  -- capturadas os dois numeros coincidiram — e e esse tipo de coincidencia que faz alguem
  -- tratar como campo unico e descobrir o contrario mandando mensagem pra pessoa errada.
  -- person_id e 'mp:'+peer_id; as mensagens vao pra tabela message com channel='meupatrocinio'.
  CREATE TABLE IF NOT EXISTS mp_chat (
    account_key TEXT, peer_id TEXT, conversation_id TEXT, nome TEXT, foto TEXT,
    previa TEXT, last_ts INTEGER, unread INTEGER DEFAULT 0, adopted INTEGER DEFAULT 0, mode TEXT,
    updated_at INTEGER,
    PRIMARY KEY (account_key, peer_id)
  );
  CREATE INDEX IF NOT EXISTS idx_mp_ts ON mp_chat(account_key, last_ts);

  -- As "opções do que quero enviar" da primeira mensagem sem modelo de linguagem: texto do
  -- quem opera, guardado como está. canal NULL = serve pros dois.
  CREATE TABLE IF NOT EXISTS modelo_msg (
    id TEXT PRIMARY KEY, canal TEXT, texto TEXT NOT NULL,
    ativo INTEGER DEFAULT 1, criado_em INTEGER
  );

  CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE IF NOT EXISTS event (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT,
    person_id TEXT, channel TEXT, detail TEXT
  );

  -- Agenda: propostas de compromisso detectadas pela IA (sugere -> quem opera confirma).
  -- status: pending | created | rejected. fp = impressão pra não repropor o mesmo.
  CREATE TABLE IF NOT EXISTS agenda_proposal (
    id TEXT PRIMARY KEY, account_key TEXT, person_id TEXT, channel TEXT,
    title TEXT, starts_at INTEGER, ends_at INTEGER, with_person TEXT,
    confidence REAL, source_quote TEXT, fp TEXT, status TEXT DEFAULT 'pending',
    google_event_id TEXT, google_html_link TEXT, created_at INTEGER, resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_proposal_status ON agenda_proposal(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_proposal_fp ON agenda_proposal(fp);

  -- Até onde a varredura de compromissos já leu cada conversa (última msg recebida).
  CREATE TABLE IF NOT EXISTS agenda_scan (person_id TEXT PRIMARY KEY, last_ts INTEGER, updated_at INTEGER);

  -- Monitoramento do WhatsApp: TUDO que não é mensagem (apagou, editou, reagiu, leu/ouviu,
  -- chamada, trocou foto/recado…). NÃO entra na timeline nem no contexto da IA — é um
  -- fluxo à parte (aba Monitor). kind = tipo do evento; detail = JSON com o específico.
  CREATE TABLE IF NOT EXISTS wa_monitor (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_key TEXT, ts INTEGER,
    kind TEXT, jid TEXT, name TEXT, summary TEXT, detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_monitor_ts ON wa_monitor(ts);
  CREATE INDEX IF NOT EXISTS idx_monitor_kind ON wa_monitor(kind, ts);

  -- Interpretação de mídia do Instagram (imagem/vídeo/reel): a descrição vive AQUI (não na
  -- mensagem), keyed pela URL sem query (estável no re-sync) — assim não re-interpreta/re-gasta
  -- quando a thread é relida. status: pending|done|error. Preenchido só quando o setting
  -- media_interpret está ligado (a "visão" é o que custa; transcrição de áudio é local/grátis).
  CREATE TABLE IF NOT EXISTS ig_media (
    mkey TEXT PRIMARY KEY, account_key TEXT, kind TEXT, src TEXT,
    person_id TEXT, thread_id TEXT,
    description TEXT, transcript TEXT, status TEXT DEFAULT 'pending', created_at INTEGER, done_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_igmedia_status ON ig_media(account_key, status);

  -- Enquetes que NÓS mandamos (pra decifrar o voto quando chega). enc_key = messageSecret
  -- que geramos no envio; options_json = as opções na ordem; answered_at trava o re-processo.
  CREATE TABLE IF NOT EXISTS wa_poll (
    msg_id TEXT PRIMARY KEY, account_key TEXT, person_id TEXT, jid TEXT,
    question TEXT, options_json TEXT, enc_key TEXT, creator_jid TEXT, multipla INTEGER DEFAULT 0,
    created_at INTEGER, answered_at INTEGER
  );

  -- ===== Projetos (gestão da vida de quem opera): projetos/tarefas/lembretes/hábitos/notas =====
  -- Aditivo e isolado dos canais. Compromisso NÃO tem tabela: compromisso É evento na
  -- Google Agenda (carimbado com timProjectId), fonte única. Ver docs/PROJETOS-PROMPT.md.
  CREATE TABLE IF NOT EXISTS project (
    id TEXT PRIMARY KEY, account_key TEXT, name TEXT, type TEXT,          -- trabalho|pessoal|objetivo
    color TEXT, status TEXT DEFAULT 'ativo',                              -- ativo|pausado|concluido
    description TEXT, due_date INTEGER,                                    -- prazo alvo opcional (ms)
    metric_name TEXT, metric_target REAL, metric_current REAL, metric_unit TEXT,  -- só type=objetivo
    created_at INTEGER, updated_at INTEGER, completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_project_status ON project(account_key, status, updated_at);

  CREATE TABLE IF NOT EXISTS task (
    id TEXT PRIMARY KEY, account_key TEXT, project_id TEXT,               -- project_id NULL = avulsa (caixa de entrada)
    title TEXT, done INTEGER DEFAULT 0, due_date INTEGER, is_next INTEGER DEFAULT 0,  -- is_next: o próximo passo (máx 1/projeto)
    position INTEGER DEFAULT 0, created_at INTEGER, completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_task_project ON task(project_id, position);
  CREATE INDEX IF NOT EXISTS idx_task_due ON task(account_key, done, due_date);

  CREATE TABLE IF NOT EXISTS reminder (
    id TEXT PRIMARY KEY, account_key TEXT, project_id TEXT, task_id TEXT, text TEXT,
    at INTEGER,                                                           -- próxima ocorrência (ms)
    recurrence TEXT, recurrence_detail TEXT,                              -- NULL|daily|weekly|monthly|yearly (+ JSON)
    status TEXT DEFAULT 'ativo',                                          -- ativo|pausado|feito
    last_fired_at INTEGER, snooze_until INTEGER, created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_reminder_due ON reminder(account_key, status, at);

  -- O CALENDARIO DA CASA. Ate 15/08/2026 a ocupacao da agenda vinha SO da Google: sem ela
  -- conectada, slotsLivres achava o dia inteiro livre e a IA oferecia horario em cima de
  -- compromisso ja marcado — e aprovar uma proposta simplesmente falhava, porque o unico
  -- caminho de gravacao era criar evento la fora. Agora todo compromisso nasce AQUI; a
  -- Google, quando conectada, e ESPELHO (google_event_id guarda o par, pra nao contar duas
  -- vezes o mesmo compromisso). Duracao e folgas ficam na linha porque e o que decide se
  -- cabe outro atendimento colado (ver docs/SERVICOS.md).
  CREATE TABLE IF NOT EXISTS compromisso (
    id TEXT PRIMARY KEY, account_key TEXT,
    titulo TEXT NOT NULL, inicio_ms INTEGER NOT NULL, fim_ms INTEGER NOT NULL,
    person_id TEXT, canal TEXT, project_id TEXT,
    servico TEXT, faixa TEXT,                                             -- da tabela de serviços, quando veio de lá
    folga_antes_min INTEGER DEFAULT 0, folga_depois_min INTEGER DEFAULT 0,
    lugar TEXT, observacao TEXT,
    origem TEXT DEFAULT 'manual',                                         -- manual | proposta | projeto
    google_event_id TEXT,                                                 -- espelho, quando a Google está conectada
    status TEXT DEFAULT 'marcado',                                        -- marcado | cancelado
    criado_em INTEGER, atualizado_em INTEGER, cancelado_em INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_compromisso_janela ON compromisso(status, inicio_ms);
  CREATE INDEX IF NOT EXISTS idx_compromisso_google ON compromisso(google_event_id);

  -- Aviso antecipado de COMPROMISSO da Google Agenda. Uma linha por evento avisado.
  -- Precisa existir porque o evento é de outro sistema: não dá pra marcar nada nele, e sem
  -- registro o tick de 30s repetiria o mesmo aviso a manhã inteira. O start_ms fica junto de
  -- propósito — remarcou o compromisso, o aviso vale de novo.
  CREATE TABLE IF NOT EXISTS agenda_aviso (
    event_id TEXT PRIMARY KEY, start_ms INTEGER, fired_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS habit (
    id TEXT PRIMARY KEY, account_key TEXT, name TEXT, days TEXT,          -- JSON [0-6] ou 'daily'
    time_hint TEXT, streak_current INTEGER DEFAULT 0, streak_best INTEGER DEFAULT 0,
    paused INTEGER DEFAULT 0, position INTEGER DEFAULT 0, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS habit_log (
    habit_id TEXT, date TEXT, done_at INTEGER,                            -- date = 'YYYY-MM-DD' em TZ São Paulo
    PRIMARY KEY (habit_id, date)
  );

  CREATE TABLE IF NOT EXISTS note (
    id TEXT PRIMARY KEY, account_key TEXT, project_id TEXT, text TEXT, created_at INTEGER  -- project_id NULL = ideia solta
  );
  CREATE INDEX IF NOT EXISTS idx_note_project ON note(project_id, created_at);

  CREATE TABLE IF NOT EXISTS project_person (
    project_id TEXT, person_id TEXT, role TEXT, created_at INTEGER,
    PRIMARY KEY (project_id, person_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pp_person ON project_person(person_id);

  CREATE TABLE IF NOT EXISTS project_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, ts INTEGER, type TEXT, detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_plog_project ON project_log(project_id, ts);

  -- Agrupamento lógico de identidade (unificação manual "essa do insta = a mesma do whats").
  -- NÃO re-aponta o message store (o Instagram tem personId fixo 'ig:threadId' e re-sincroniza
  -- destrutivamente — mover mensagens seria revertido e duplicaria). Em vez disso mapeamos o id
  -- bruto (wa:jid / ig:threadId / person do Tinder) pra um id canônico. As threads de cada canal
  -- seguem intactas; a pessoa unificada é resolvida na leitura (envolvidos de projeto, cérebro).
  CREATE TABLE IF NOT EXISTS person_alias (
    alias_person_id TEXT PRIMARY KEY, canonical_person_id TEXT, created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_alias_canonical ON person_alias(canonical_person_id);
  -- Auditoria/desfazer da unificação (guarda o par pra separar depois).
  CREATE TABLE IF NOT EXISTS person_merge (
    id TEXT PRIMARY KEY, ts INTEGER, primary_person_id TEXT, merged_person_id TEXT, detail TEXT
  );

  -- Áudios salvos (biblioteca de notas de voz de quem opera): o painel grava, o atalho "/"
  -- envia rápido, e a IA pode mandar quando o conteúdo encaixa. Ver docs/AUDIOS-SALVOS.md.
  -- shortcut = slug do título (/atalho no composer); transcript alimenta a decisão da IA;
  -- active=0 é soft delete (nunca apagamos arquivo nem linha). file = <id>.ogg no disco.
  -- Auto-deslizar (docs/TINDER-DESCOBERTA.md). A idempotência mora na PK: o mesmo
  -- user_id nunca é deslizado duas vezes, mesmo se o processo morrer no meio.
  -- decided_at = quando o motor decidiu; sent_at = quando o Tinder aceitou (null = modo
  -- sombra ou envio que não aconteceu).
  CREATE TABLE IF NOT EXISTS swipe (
    user_id TEXT PRIMARY KEY, name TEXT, age INTEGER, distance INTEGER,
    decision TEXT, reason TEXT, layer TEXT, score INTEGER, source TEXT,
    session_id TEXT, decided_at INTEGER, sent_at INTEGER, http_status INTEGER,
    matched INTEGER DEFAULT 0, payload TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_swipe_sessao ON swipe(session_id, decided_at);
  CREATE INDEX IF NOT EXISTS idx_swipe_quando ON swipe(decided_at);

  CREATE TABLE IF NOT EXISTS swipe_session (
    id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER,
    planned INTEGER, done INTEGER DEFAULT 0, likes INTEGER DEFAULT 0,
    city TEXT, mode TEXT, ended_reason TEXT
  );

  CREATE TABLE IF NOT EXISTS saved_audio (
    id TEXT PRIMARY KEY, title TEXT, shortcut TEXT UNIQUE, descricao TEXT,
    file TEXT, duration_sec INTEGER, size_bytes INTEGER,
    transcript TEXT, transcript_status TEXT DEFAULT 'pending',
    active INTEGER DEFAULT 1, usage_count INTEGER DEFAULT 0,
    last_used_at INTEGER, created_at INTEGER
  );

  -- ---------- banco de FOTOS que a IA sabe usar ----------
  -- Irmão do saved_audio, com uma diferença que decide o desenho: o áudio ganha a
  -- transcrição sozinho (whisper), então o sistema SABE o que ele diz. A foto não tem de
  -- onde: a descricao escrita pelo dono é a UNICA fonte do que ela mostra e de quando usar.
  -- Descrição vazia = foto que a IA não tem como escolher, e por isso não entra na lista.
  --
  -- O campo "nivel" existe porque foto erra pior que áudio: áudio trocado é constrangedor,
  -- foto trocada é irreversível.
  --   'livre'    -> entra na lista do prompt; a IA escolhe quando couber.
  --   'travada'  -> NUNCA é renderizada no prompt. Mesma política do fato 'nunca'
  --                 (src/self/fatos.mjs): o modelo não pode vazar o que não recebeu.
  --                 Só sai pela mão do dono, pelo painel.
  CREATE TABLE IF NOT EXISTS saved_image (
    id TEXT PRIMARY KEY, title TEXT, shortcut TEXT UNIQUE, descricao TEXT,
    file TEXT, width INTEGER, height INTEGER, size_bytes INTEGER,
    nivel TEXT DEFAULT 'livre',
    active INTEGER DEFAULT 1, usage_count INTEGER DEFAULT 0,
    last_used_at INTEGER, created_at INTEGER
  );

  -- ---------- memória estruturada sobre quem opera (o "eu") ----------
  -- Cada linha é UM fato em uma frase. Substitui, aos poucos, o retrato em prosa: aqui
  -- o fato tem fonte, data de validade e política de uso, então dá pra saber de onde veio,
  -- desde quando vale e quando pode ser dito. Nada entra sozinho: nasce 'proposto'.
  --
  -- sensibilidade é POLÍTICA, aplicada na seleção (src/self/fatos.mjs), não pedido ao
  -- modelo: 'nunca' jamais é renderizado no prompt — o modelo não pode vazar o que não
  -- recebeu. 'sob_pedido' só entra quando o assunto da conversa encosta no fato.
  -- valid_from/valid_to = quando o fato foi verdade no mundo; recorded_at = quando o
  -- sistema soube (bitemporal: "morei na cidade A, depois na B, hoje na C" sem apagar
  -- nada e sem a IA dizer que ele mora onde morava em 2015).
  CREATE TABLE IF NOT EXISTS fato (
    id TEXT PRIMARY KEY,
    texto TEXT NOT NULL,
    categoria TEXT,
    sensibilidade TEXT DEFAULT 'livre',   -- livre | sob_pedido | nunca
    status TEXT DEFAULT 'proposto',       -- proposto | aprovado | rejeitado
    origem TEXT, origem_ref TEXT, confianca REAL DEFAULT 0.5,
    gatilhos TEXT,                        -- JSON: palavras que tornam o fato relevante
    valid_from INTEGER, valid_to INTEGER, recorded_at INTEGER,
    usos INTEGER DEFAULT 0, ultimo_uso_at INTEGER, updated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_fato_status ON fato(status, sensibilidade);

  -- Ledger: o que o clone AFIRMOU, pra quem e com base em quê. É o que permite auditar
  -- o que já foi dito no mundo em nome de quem opera, achar contradição entre canais e não
  -- repetir a mesma história pra mesma pessoa. Passivo: não influencia a geração.
  CREATE TABLE IF NOT EXISTS fato_assercao (
    id TEXT PRIMARY KEY, person_id TEXT, channel TEXT, message_id TEXT,
    texto TEXT, fatos TEXT, ts INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_assercao_pessoa ON fato_assercao(person_id, ts);

  -- ---------- rotina recorrente de quem opera ----------
  -- Diferente de disponibilidade: aqui fica o que a pessoa normalmente FAZ, em que
  -- horários e onde. Cada instância tem a própria rotina; vazia, não muda o prompt.
  -- dias é JSON com 0=domingo .. 6=sábado. Uma faixa pode atravessar a meia-noite.
  CREATE TABLE IF NOT EXISTS rotina (
    id TEXT PRIMARY KEY,
    titulo TEXT NOT NULL,
    detalhes TEXT,
    local TEXT,
    dias TEXT NOT NULL,
    inicio TEXT NOT NULL,
    fim TEXT NOT NULL,
    ativo INTEGER DEFAULT 1,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_rotina_horario ON rotina(ativo, inicio, fim);

  -- ---------- encontros: quando quem opera aceita marcar ----------
  -- Janela semanal recorrente. Sem nenhuma janela cadastrada o bloco não entra no prompt
  -- e a IA se comporta exatamente como antes (aditivo, opt-in).
  CREATE TABLE IF NOT EXISTS date_janela (
    id TEXT PRIMARY KEY, dow INTEGER, inicio TEXT, fim TEXT, ativo INTEGER DEFAULT 1, updated_at INTEGER
  );
  -- Preferência por pessoa. propor_dates é exceção ao global; cobranca_autorizada
  -- é trava local, desligada por padrão, para permitir cobrança só onde ele marcou.
  -- O motivo é obrigatório para a autorização ter efeito: a IA não pode inventar por
  -- que alguém deve dinheiro.
  CREATE TABLE IF NOT EXISTS pessoa_pref (
    person_id TEXT PRIMARY KEY,
    propor_dates INTEGER,
    cobranca_autorizada INTEGER DEFAULT 0,
    cobranca_motivo TEXT,
    updated_at INTEGER
  );

  -- Uma linha por RAJADA de cobrança comprovadamente enviada. Uma cobrança pode sair em
  -- até três bolhas, então contar a tabela de mensagens inflaria o número. receipt_key aponta para o
  -- evento único do envio e torna o registro idempotente mesmo depois de restart/backfill.
  CREATE TABLE IF NOT EXISTS cobranca_envio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    receipt_key TEXT NOT NULL UNIQUE,
    tipo TEXT DEFAULT 'regra',
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cobranca_envio_pessoa ON cobranca_envio(person_id, ts);

  -- ---------- disponibilidade: onde ele está e quando pode ----------
  -- LUGAR é um GRUPO de cidades que ele alcança de onde está, não uma cidade só: de casa
  -- ele chega na cidade dele e em duas vizinhas, então as três são o MESMO lugar pra efeito
  -- de "posso marcar aí". Foi decisão dele (26/07/2026) — o modelo de uma cidade por
  -- janela obrigaria a cadastrar a mesma faixa de horário três vezes.
  CREATE TABLE IF NOT EXISTS lugar (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    cidades TEXT,                     -- JSON: ["Cidade A","Cidade B","Cidade C"]
    base INTEGER DEFAULT 0,           -- 1 = onde ele está quando nenhum período diz o contrário
    updated_at INTEGER
  );
  -- PERÍODO é a linha do tempo do lugar: um intervalo de datas em que ele NÃO está na base
  -- (viagem) ou está indisponível de qualquer forma. Datas inclusivas, dia inteiro — viagem
  -- se conta em dias, não em horas.
  --   tipo 'em_lugar' -> nesse intervalo ele está em lugar_id; janela de outro lugar não vale
  --   tipo 'ocupado'  -> nada pode ser marcado, mesmo com a Google Agenda vazia
  -- event_id guarda o evento do Google que originou o período (a viagem que já estava no
  -- calendário), pra ele não redigitar datas e pra a origem ficar visível na tela.
  CREATE TABLE IF NOT EXISTS periodo (
    id TEXT PRIMARY KEY,
    de TEXT, ate TEXT,                -- 'YYYY-MM-DD' inclusive, fuso de São Paulo
    tipo TEXT DEFAULT 'em_lugar',
    lugar_id TEXT, titulo TEXT, event_id TEXT,
    updated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_periodo_datas ON periodo(de, ate);

  -- ---------- memória POR PESSOA (não por conversa) ----------
  -- person_id é sempre o CANÔNICO: uma pessoa com WhatsApp + Instagram + Tinder tem UMA
  -- memória. Quem responde é a thread (a IA liga/desliga por rede); quem lembra é a pessoa.
  --
  -- Existe porque o histórico cru é cortado em 1.000 mensagens / 48 mil caracteres: quem
  -- tem 7.000 mensagens perdia quase 6.000. O resumo carrega o que ficou fora da janela.
  -- ate_ts = até onde já foi lido (a próxima consolidação continua daí, não relê tudo).
  CREATE TABLE IF NOT EXISTS pessoa_memoria (
    person_id TEXT PRIMARY KEY,
    resumo TEXT, combinados TEXT, tom TEXT,
    ate_ts INTEGER, msgs_lidas INTEGER DEFAULT 0, total_msgs INTEGER DEFAULT 0,
    versao INTEGER DEFAULT 0, updated_at INTEGER
  );

  -- ---------- vínculo por pessoa (o tagueamento das 294, 25/07/2026) ----------
  -- Quem cada pessoa É para quem opera (persistente), separado do assunto do momento (que muda
  -- mensagem a mensagem — o registro fica no módulo do vínculo, não em troca de modo).
  -- ia_pode: 'sim' | 'cuidado' | 'nao'. 'nao' é TRAVA DURA: o autoreply nunca roda, mesmo
  -- com o toggle da conversa ligado — pai, cliente/família de paciente, autoridade,
  -- fornecedor e bot (bot respondido por IA = duas IAs conversando, já aconteceu).
  CREATE TABLE IF NOT EXISTS pessoa_vinculo (
    person_id TEXT PRIMARY KEY,
    vinculo TEXT, extras TEXT, camadas TEXT,
    ia_pode TEXT DEFAULT 'cuidado',
    evidencia TEXT, origem TEXT, updated_at INTEGER
  );

  -- Iniciativas sugeridas (nível 1, 25/07/2026): a IA detecta motivo pra PUXAR papo
  -- (combinado pendente, conversa esfriando), escreve o rascunho e espera quem opera aprovar
  -- na aba Vínculos. NADA é enviado sem decisão dele; expira em 48h.
  CREATE TABLE IF NOT EXISTS iniciativa (
    id TEXT PRIMARY KEY, person_id TEXT, channel TEXT,
    gatilho TEXT, motivo TEXT, rascunho TEXT,
    status TEXT DEFAULT 'pendente',  -- pendente | enviada | rejeitada | expirada | erro
    criado_em INTEGER, decidido_em INTEGER, detalhe TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_iniciativa_status ON iniciativa(status, criado_em);

  -- Sugestões de "é a mesma pessoa" que o sistema encontrou e quem opera ainda não julgou.
  -- Nunca vira vínculo sozinha: união entre canais é decisão dele (as travas do
  -- docs/PLANO-IDENTIDADE-VINCULO.md valem aqui igual).
  CREATE TABLE IF NOT EXISTS uniao_sugerida (
    id TEXT PRIMARY KEY, a_person_id TEXT, b_person_id TEXT,
    motivo TEXT, forca REAL, status TEXT DEFAULT 'pendente', criado_em INTEGER, decidido_em INTEGER,
    UNIQUE(a_person_id, b_person_id)
  );

  -- CONVITE: "eu passei o meu contato pra esta pessoa, nesta rede, nesta hora".
  --
  -- Existe por causa de uma assimetria: quando a PESSOA passa o contato dela, sobra um
  -- contact_hint e o vínculo fecha sozinho. Quando é QUEM OPERA que passa o dela (o fluxo
  -- que o dono prefere: quem se move é o outro), não sobra rastro nenhum — e a conversa que
  -- nasce no Instagram vira uma pessoa nova, solta, sem ligação com as centenas de mensagens
  -- do Tinder. O convite é esse rastro.
  --
  -- Ele não autoriza união por horário sozinho. A chegada vira sugestão; só uma identidade
  -- forte e isolada (nome/apresentação/origem) conclui automaticamente, sempre por um merge
  -- reversível. Pode ser qualquer outra pessoa chegando no mesmo dia.
  CREATE TABLE IF NOT EXISTS convite_rede (
    person_id TEXT, canal TEXT, contato TEXT, ts INTEGER,
    source_channel TEXT, source_message_id TEXT, quote TEXT,
    PRIMARY KEY (person_id, canal)
  );
  CREATE INDEX IF NOT EXISTS idx_convite_ts ON convite_rede(canal, ts);

  -- ===== Assistente pessoal: o chat de quem opera COM o vendas-multicanal (self-chat + painel) =====
  -- Mora FORA da tabela message DE PROPÓSITO. Duas razões, as duas load-bearing:
  --   1. O cérebro que fala com as PESSOAS nunca pode enxergar isto (ele escreve como o
  --      quem opera; aqui o vendas-multicanal fala com quem opera — personas opostas).
  --   2. A timeline de uma pessoa nunca pode misturar conversa real com comando de operação.
  -- wa_msg_id guarda o id REAL do WhatsApp de tudo que NÓS enviamos no self-chat: é a trava
  -- anti-eco (no self-chat toda mensagem é fromMe, então id é a única forma de distinguir
  -- o que ele escreveu do que nós escrevemos).
  CREATE TABLE IF NOT EXISTS assistente_msg (
    id TEXT PRIMARY KEY, ts INTEGER,
    papel TEXT,      -- humano | vendas-multicanal
    origem TEXT,     -- whatsapp | painel | sistema
    texto TEXT, wa_msg_id TEXT, acoes TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_assist_ts ON assistente_msg(ts);
  CREATE INDEX IF NOT EXISTS idx_assist_wa ON assistente_msg(wa_msg_id);

  -- Toda ação executada pelo assistente, com o suficiente pra DESFAZER. Sem esta linha
  -- gravada antes do efeito, "ele age sozinho" não teria volta.
  CREATE TABLE IF NOT EXISTS assistente_acao (
    id TEXT PRIMARY KEY, ts INTEGER, msg_id TEXT,
    nome TEXT, args TEXT, nivel TEXT,
    estado TEXT,     -- feita | erro | desfeita | pendente | cancelada | desambiguando
                     -- desambiguando = a ação está guardada inteira, sem nenhum efeito, à
                     -- espera de quem opera dizer QUAL pessoa (o nome casou com mais de uma).
    resumo TEXT, resultado TEXT, desfazer TEXT, erro TEXT, desfeita_em INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_assist_acao_ts ON assistente_acao(ts);
  CREATE INDEX IF NOT EXISTS idx_assist_acao_estado ON assistente_acao(estado, ts);

  -- Pedidos de permissão pra tocar no sistema (decisão 3 de quem opera: pode, mas pede).
  CREATE TABLE IF NOT EXISTS assistente_permissao (
    id TEXT PRIMARY KEY, ts INTEGER, tipo TEXT, alvo TEXT, motivo TEXT,
    estado TEXT,     -- pendente | aprovada | negada | expirada
    decidido_em INTEGER, saida TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_assist_perm ON assistente_permissao(estado, ts);
  `)
  // Colunas acrescentadas depois (idempotente: SQLite não tem ADD COLUMN IF NOT EXISTS).
  // Hash do CONTEÚDO da foto. Sem ele, a mesma imagem entrando com dois nomes vira duas
  // linhas com `file` diferente — e a trava de "nunca repete pra mesma pessoa", que casa por
  // `file`, deixaria a IA mandar a mesma foto duas vezes. Aconteceu já na primeira pasta
  // importada: um arquivo estava duplicado com outro nome.
  const imgCols = d.prepare(`PRAGMA table_info(saved_image)`).all().map((c) => c.name)
  if (imgCols.length && !imgCols.includes('sha')) d.exec(`ALTER TABLE saved_image ADD COLUMN sha TEXT`)
  // `descricao` diz O QUE a foto mostra; `contexto` diz QUANDO mandar. São perguntas
  // diferentes e a IA precisa das duas: "eu no espelho arrumada" não informa se isso serve
  // pra quem perguntou do meu dia ou pra quem chamou pra sair. Regra configurada (12/08/2026)
  // depois de a IA passar 1h07 prometendo uma foto — parte do problema era ela não saber
  // QUANDO uma foto cabe.
  if (imgCols.length && !imgCols.includes('contexto')) d.exec(`ALTER TABLE saved_image ADD COLUMN contexto TEXT`)

  const waCols = d.prepare(`PRAGMA table_info(wa_chat)`).all().map((c) => c.name)
  if (!waCols.includes('avatar')) d.exec(`ALTER TABLE wa_chat ADD COLUMN avatar TEXT`)
  if (!waCols.includes('unread')) d.exec(`ALTER TABLE wa_chat ADD COLUMN unread INTEGER DEFAULT 0`)
  if (!waCols.includes('pn')) d.exec(`ALTER TABLE wa_chat ADD COLUMN pn TEXT`) // número real (PN) resolvido de um @lid
  // modo de conversa da pessoa (romance-paquera|romance-quente|amigo|negocio|civico).
  // NULL = sem modo -> a IA se comporta EXATAMENTE como antes (aditivo, opt-in).
  if (!waCols.includes('mode')) d.exec(`ALTER TABLE wa_chat ADD COLUMN mode TEXT`)
  // override manual do dono: 1 = "não é do Tinder" (força o selo a sumir mesmo que
  // exista vínculo). NULL/0 = usa o critério automático (tem match do Tinder).
  if (!waCols.includes('not_tinder')) d.exec(`ALTER TABLE wa_chat ADD COLUMN not_tinder INTEGER DEFAULT 0`)
  // Quando foi a última tentativa de buscar a foto. Sem isso, o preenchimento ficaria
  // batendo eternamente em quem não tem foto ou não deixa ver (privacidade do WhatsApp).
  if (!waCols.includes('avatar_tried_at')) d.exec(`ALTER TABLE wa_chat ADD COLUMN avatar_tried_at INTEGER`)
  // Projeto sugerido pra uma proposta de compromisso (F6): quando a pessoa da conversa é
  // envolvida de UM projeto ativo, a proposta nasce com esse project_id (o dono pode trocar).
  // Estado e prova do vínculo (docs/PLANO-IDENTIDADE-VINCULO.md §2.4). Sem isso, um vínculo
  // criado e nunca usado fica invisível — foi assim que 17 vínculos mortos passaram meses
  // despercebidos. link_state: candidato | confirmado_servidor | confirmado_conversa | frio
  // | ambiguo | rejeitado. evidence_hint_id aponta pro contact_hint que originou (a frase).
  const idCols = d.prepare(`PRAGMA table_info(identity)`).all().map((c) => c.name)
  if (!idCols.includes('link_state')) d.exec(`ALTER TABLE identity ADD COLUMN link_state TEXT`)
  if (!idCols.includes('evidence_hint_id')) d.exec(`ALTER TABLE identity ADD COLUMN evidence_hint_id TEXT`)
  if (!idCols.includes('confirmed_at')) d.exec(`ALTER TABLE identity ADD COLUMN confirmed_at INTEGER`)
  if (!idCols.includes('last_seen_at')) d.exec(`ALTER TABLE identity ADD COLUMN last_seen_at INTEGER`)
  // Uma pessoa PODE ter dois WhatsApp ou dois Instagram (número antigo, ou usa dois mesmo).
  // O que não pode é a IA escrever no morto. Então em vez de proibir o segundo vínculo,
  // marca-se qual é o de ENVIO: is_primary=1. Sem nenhum marcado, vale a ordem de
  // waJidForPerson (conversa de verdade primeiro), que é como funcionava antes.
  if (!idCols.includes('is_primary')) d.exec(`ALTER TABLE identity ADD COLUMN is_primary INTEGER DEFAULT 0`)
  // Uma revisão ambígua nasce de N candidatos (as variantes do número com e sem o 9, por
  // exemplo). A tabela só guardava o PRIMEIRO em wa_jid, então os outros sumiam antes de
  // chegar na tela — e a pergunta "qual desses?" virava um botão solto de recusar, sem
  // nenhuma opção do lado. Aqui ficam todos, e a tela pergunta de verdade.
  // Perfil da pessoa no Badoo (JSON), lido do pacote `user` do app deles. Sem isto a IA
  // escrevia às cegas nesse canal: o prompt dizia "nenhum dado detalhado disponível".
  const bdCols = d.prepare(`PRAGMA table_info(badoo_chat)`).all().map((c) => c.name)
  if (!bdCols.includes('perfil_json')) d.exec(`ALTER TABLE badoo_chat ADD COLUMN perfil_json TEXT`)
  const revCols = d.prepare(`PRAGMA table_info(wa_link_review)`).all().map((c) => c.name)
  if (!revCols.includes('options_json')) d.exec(`ALTER TABLE wa_link_review ADD COLUMN options_json TEXT`)
  const propCols = d.prepare(`PRAGMA table_info(agenda_proposal)`).all().map((c) => c.name)
  if (!propCols.includes('project_id')) d.exec(`ALTER TABLE agenda_proposal ADD COLUMN project_id TEXT`)
  // AVISO ANTES DA HORA. Lembrete que só toca na hora marcada chega tarde pra tudo que exige
  // fazer algo ("mandar mensagem pra fulano às 19h" às 19h em ponto já é 19h). `pre_minutes`
  // é quanto antes avisar (NULL = o padrão do sistema, ajuste `lembrete_aviso_min`; 0 = não
  // avisar); `pre_fired_at` é o que garante UM aviso só — sem ele o tick de 30s repetiria o
  // recado a cada meio minuto durante os 10 minutos inteiros.
  // O id da conversa na API do Instagram NÃO é o da URL (/direct/t/<id>/), que é o que
  // `thread_id` guarda. São numerações diferentes e usar uma no lugar da outra devolve um 500
  // enganoso. Aqui fica o da API, casado por @username na primeira vez que a API vê a conversa.
  const igCols2 = d.prepare(`PRAGMA table_info(ig_chat)`).all().map((c) => c.name)
  if (!igCols2.includes('api_thread_id')) d.exec(`ALTER TABLE ig_chat ADD COLUMN api_thread_id TEXT`)
  const remCols = d.prepare(`PRAGMA table_info(reminder)`).all().map((c) => c.name)
  if (!remCols.includes('pre_minutes')) d.exec(`ALTER TABLE reminder ADD COLUMN pre_minutes INTEGER`)
  if (!remCols.includes('pre_fired_at')) d.exec(`ALTER TABLE reminder ADD COLUMN pre_fired_at INTEGER`)
  // Cadência humana de resposta: a IA não responde na hora — agenda pra daqui a um tempo
  // variável (reciprocidade + interesse). scheduled_fp = pendência agendada; reply_at = quando.
  const aiCols = d.prepare(`PRAGMA table_info(ai_setting)`).all().map((c) => c.name)
  if (!aiCols.includes('scheduled_fp')) d.exec(`ALTER TABLE ai_setting ADD COLUMN scheduled_fp TEXT`)
  if (!aiCols.includes('reply_at')) d.exec(`ALTER TABLE ai_setting ADD COLUMN reply_at INTEGER`)
  // Quando a IA foi LIGADA neste canal. `updated_at` muda a cada geração — não serve
  // pra "há quantos dias a IA está ligada". Só grava na virada 0→1; apaga no 1→0.
  if (!aiCols.includes('enabled_at')) d.exec(`ALTER TABLE ai_setting ADD COLUMN enabled_at INTEGER`)
  // A mídia precisa apontar pra conversa para a visão respeitar o interruptor daquela pessoa
  // e para o livro-caixa atribuir os tokens. As linhas antigas continuam válidas, mas ficam
  // sem atribuição até a próxima sincronização reencontrar a mídia.
  const igMediaCols = d.prepare(`PRAGMA table_info(ig_media)`).all().map((c) => c.name)
  if (!igMediaCols.includes('person_id')) d.exec(`ALTER TABLE ig_media ADD COLUMN person_id TEXT`)
  if (!igMediaCols.includes('thread_id')) d.exec(`ALTER TABLE ig_media ADD COLUMN thread_id TEXT`)
  // QUEM ESCREVEU a mensagem que saiu daqui. `direction` só diz o lado (entrou/saiu) e no
  // WhatsApp toda mensagem minha é fromMe — o eco da IA e o que o dono digitou no celular
  // chegam idênticos. Sem esta coluna não existe resposta honesta pra "isso fui eu ou foi
  // a IA?", e ele perguntou justamente isso.
  //   'ia'   -> o modelo compôs e o sistema mandou (auto-resposta, iniciativa, assistente)
  //   'humano' -> as palavras são dele (celular, painel, áudio salvo que ele disparou)
  //   NULL   -> não sei (histórico anterior a esta coluna; nunca chutar)
  // Vale pra TODO canal, não só WhatsApp: no Instagram/Tinder/Badoo o envio passa pelos
  // mesmos pontos, então o carimbo é o mesmo.
  const msgCols = d.prepare(`PRAGMA table_info(message)`).all().map((c) => c.name)
  if (!msgCols.includes('author')) d.exec(`ALTER TABLE message ADD COLUMN author TEXT`)
  const conviteCols = d.prepare(`PRAGMA table_info(convite_rede)`).all().map((c) => c.name)
  if (!conviteCols.includes('source_channel')) d.exec(`ALTER TABLE convite_rede ADD COLUMN source_channel TEXT`)
  if (!conviteCols.includes('source_message_id')) d.exec(`ALTER TABLE convite_rede ADD COLUMN source_message_id TEXT`)
  if (!conviteCols.includes('quote')) d.exec(`ALTER TABLE convite_rede ADD COLUMN quote TEXT`)
  // Disponibilidade ganhou TIPO e LUGAR (regra do sistema, 26/07/2026). As janelas que já
  // existiam são todas de encontro e todas na base, então o default reproduz exatamente o
  // que elas significavam antes: nada muda de sentido sem ele mexer.
  //   tipo 'encontro'    -> paquera; é o que alimenta o prompt do clone desde 25/07
  //   tipo 'compromisso' -> resto da vida (reunião, café de trabalho, dentista)
  //   lugar_id NULL      -> a base (não é "sem lugar": é "onde ele mora")
  const janCols = d.prepare(`PRAGMA table_info(date_janela)`).all().map((c) => c.name)
  if (!janCols.includes('tipo')) d.exec(`ALTER TABLE date_janela ADD COLUMN tipo TEXT DEFAULT 'encontro'`)
  if (!janCols.includes('lugar_id')) d.exec(`ALTER TABLE date_janela ADD COLUMN lugar_id TEXT`)
  d.exec(`UPDATE date_janela SET tipo='encontro' WHERE tipo IS NULL OR tipo=''`)
  const prefCols = d.prepare(`PRAGMA table_info(pessoa_pref)`).all().map((c) => c.name)
  if (!prefCols.includes('cobranca_autorizada')) d.exec(`ALTER TABLE pessoa_pref ADD COLUMN cobranca_autorizada INTEGER DEFAULT 0`)
  if (!prefCols.includes('cobranca_motivo')) d.exec(`ALTER TABLE pessoa_pref ADD COLUMN cobranca_motivo TEXT`)
  if (!prefCols.includes('cobranca_nunca')) d.exec(`ALTER TABLE pessoa_pref ADD COLUMN cobranca_nunca INTEGER NOT NULL DEFAULT 0`)
  // NULL = herda o interruptor geral de atendimento. Coluna à parte de `propor_dates` de
  // propósito: marcar TRABALHO e marcar ROMANCE são autorizações diferentes (15/08/2026).
  if (!prefCols.includes('marcar_atendimento')) d.exec(`ALTER TABLE pessoa_pref ADD COLUMN marcar_atendimento INTEGER`)
  const tinderCols = d.prepare(`PRAGMA table_info(tinder_match)`).all().map((c) => c.name)
  if (!tinderCols.includes('history_checked_at')) d.exec(`ALTER TABLE tinder_match ADD COLUMN history_checked_at INTEGER`)
  if (!tinderCols.includes('active')) d.exec(`ALTER TABLE tinder_match ADD COLUMN active INTEGER DEFAULT 1`)
  // O perfil INTEIRO dela (interesses, prompts respondidos, o que procura, faculdade,
  // trabalho, pets, signo) vindo de /user/{id}. `bio` sozinha não era perfil: em 27/07/2026,
  // de 461 matches só 158 tinham bio, então em dois terços das aberturas a IA escrevia às
  // cegas. `perfil_checked_at` existe pra saber o que já foi buscado sem re-buscar tudo.
  if (!tinderCols.includes('perfil_json')) d.exec(`ALTER TABLE tinder_match ADD COLUMN perfil_json TEXT`)
  if (!tinderCols.includes('perfil_checked_at')) d.exec(`ALTER TABLE tinder_match ADD COLUMN perfil_checked_at INTEGER`)
  // Uma mensagem já persistida é prova suficiente de conversa iniciada. Esta migração
  // deixa pendentes de auditoria somente os matches cujo histórico realmente está vazio.
  d.exec(`UPDATE tinder_match
    SET has_conversation=1, history_checked_at=COALESCE(history_checked_at, updated_at)
    WHERE EXISTS (
      SELECT 1 FROM message
      WHERE message.person_id=tinder_match.person_id AND message.channel='tinder'
    )`)

  // Limpeza de mensagens do WhatsApp herdadas (idempotente): remove bolhas de CONTROLE
  // que nunca deviam ter sido guardadas, e retag os áudios que ficaram como texto cru
  // (download falhou) pra virarem bolha de áudio ("indisponível") em vez de "[audio]".
  try {
    d.exec(`DELETE FROM message WHERE channel='whatsapp' AND text IN
      ('[protocolMessage]','[senderKeyDistributionMessage]','[messageContextInfo]','[reactionMessage]','[pollUpdateMessage]','[keepInChatMessage]','[pinInChatMessage]')`)
    d.exec(`UPDATE message SET media_json='{"kind":"audio","file":null,"status":"nofile"}'
      WHERE channel='whatsapp' AND text='[audio]' AND media_json IS NULL`)
  } catch { /* migração best-effort: não derruba o boot */ }

  // Lugar base semeado UMA VEZ, e SÓ se o dono declarar qual é. A marca no `setting` é o que
  // impede o zumbi: se ele apagar ou renomear o lugar, o próximo boot não recria nada. Sem a
  // marca, "apagar" seria impossível — o sistema devolveria o lugar toda vez que reiniciasse.
  //
  // O QUE MUDOU NO vendas-multicanal (31/07/2026): antes o nome da região e as cidades vinham chumbados
  // aqui, com a base do dono anterior. Um banco novo nascia dizendo que a pessoa mora numa
  // cidade que ela nunca viu, e isso alimenta disponibilidade, encontros e a ponte de conversa.
  // Agora vem de TIM_LUGAR_BASE (JSON: {"nome":"...","cidades":["...","..."]}). Sem a variável,
  // nada é semeado e a tela pede pra criar — banco vazio é honesto, banco com a vida de outra
  // pessoa não é.
  try {
    const semeado = d.prepare(`SELECT value FROM setting WHERE key='lugar_seed'`).get()
    if (!semeado) {
      let base = null
      try { base = process.env.TIM_LUGAR_BASE ? JSON.parse(process.env.TIM_LUGAR_BASE) : null } catch { base = null }
      const cidades = Array.isArray(base?.cidades) ? base.cidades.filter((c) => typeof c === 'string' && c.trim()) : []
      const vazio = !d.prepare(`SELECT 1 FROM lugar LIMIT 1`).get()
      if (vazio && base?.nome && cidades.length) {
        d.prepare(`INSERT INTO lugar(id,nome,cidades,base,updated_at) VALUES(?,?,?,1,?)`)
          .run('base', String(base.nome), JSON.stringify(cidades), Date.now())
        d.prepare(`INSERT OR REPLACE INTO setting(key,value) VALUES('lugar_seed',?)`).run(JSON.stringify(Date.now()))
      }
    }
  } catch { /* semear é conveniência, não requisito: nunca derruba o boot */ }
}

const now = () => Date.now()

// ---------- person / identity ----------
export function upsertPerson({ personId, accountKey, name, photo }) {
  db().prepare(`INSERT INTO person(person_id,account_key,display_name,primary_photo,created_at,updated_at)
    VALUES(@id,@ak,@name,@photo,@t,@t)
    ON CONFLICT(person_id) DO UPDATE SET display_name=COALESCE(@name,display_name),
      primary_photo=COALESCE(@photo,primary_photo), updated_at=@t`)
    .run({ id: personId, ak: accountKey, name: name || null, photo: photo || null, t: now() })
  return personId
}

export function linkIdentity({ accountKey, channel, channelId, personId, method }) {
  db().prepare(`INSERT INTO identity(account_key,channel,channel_id,person_id,link_method,linked_at)
    VALUES(@ak,@ch,@cid,@pid,@m,@t)
    ON CONFLICT(channel,channel_id,account_key) DO UPDATE SET person_id=@pid, link_method=@m`)
    .run({ ak: accountKey, ch: channel, cid: channelId, pid: personId, m: method, t: now() })
}

export function personByIdentity(accountKey, channel, channelId) {
  const r = db().prepare(`SELECT person_id FROM identity WHERE account_key=? AND channel=? AND channel_id=?`).get(accountKey, channel, channelId)
  return r?.person_id || null
}

// ---------- objetivo opcional por pessoa ----------
// Resolve aliases sem importar o módulo de Projetos (que depende deste arquivo).
// Assim WhatsApp/Instagram unificados leem o mesmo objetivo da pessoa canônica.
function canonicalObjectivePersonId(personId) {
  let current = String(personId || '').trim()
  let guard = 0
  while (current && guard++ < 20) {
    const row = db().prepare(`SELECT canonical_person_id FROM person_alias WHERE alias_person_id=?`).get(current)
    if (!row?.canonical_person_id || row.canonical_person_id === current) break
    current = row.canonical_person_id
  }
  return current
}

function objectivePersonIds(personId) {
  const canonical = canonicalObjectivePersonId(personId)
  if (!canonical) return []
  const ids = new Set([canonical, String(personId || '').trim()])
  for (const row of db().prepare(`SELECT alias_person_id FROM person_alias WHERE canonical_person_id=?`).all(canonical)) ids.add(row.alias_person_id)
  return [...ids].filter(Boolean)
}

export function getPersonObjective(personId) {
  const canonical = canonicalObjectivePersonId(personId)
  if (!canonical) return ''
  const ids = objectivePersonIds(canonical)
  const placeholders = ids.map(() => '?').join(',')
  const row = db().prepare(`SELECT objective FROM person_objective WHERE person_id IN (${placeholders})
    ORDER BY (person_id=?) DESC, updated_at DESC LIMIT 1`).get(...ids, canonical)
  return String(row?.objective || '').trim()
}

export function setPersonObjective(personId, value) {
  const canonical = canonicalObjectivePersonId(personId)
  if (!canonical) throw new Error('person_id inválido')
  const objective = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500)
  const ids = objectivePersonIds(canonical)
  const placeholders = ids.map(() => '?').join(',')
  const tx = db().transaction(() => {
    db().prepare(`DELETE FROM person_objective WHERE person_id IN (${placeholders})`).run(...ids)
    if (objective) db().prepare(`INSERT INTO person_objective(person_id,objective,updated_at) VALUES(?,?,?)`).run(canonical, objective, now())
  })
  tx()
  return objective
}

// ---------- messages (timeline unificada) ----------
export function addMessage({ messageId, accountKey, personId, channel, direction, text, media, ts, author = null }) {
  const dedupe = `${channel}:${messageId}`
  try {
    db().prepare(`INSERT INTO message(message_id,account_key,person_id,channel,direction,text,media_json,ts,dedupe_key,author)
      VALUES(@mid,@ak,@pid,@ch,@dir,@txt,@media,@ts,@dk,@au)`)
      .run({ mid: messageId, ak: accountKey, pid: personId, ch: channel, dir: direction, txt: text || '', media: media ? JSON.stringify(media) : null, ts: ts || now(), dk: dedupe, au: author || null })
    // "Houve papo quente com esta pessoa": marcado aqui porque é o ÚNICO ponto por onde passa
    // mensagem de TODO canal, dos dois lados. É o que alimenta o descanso do dia seguinte
    // (src/ai/cadencia-quente.mjs). Só marca quando entrou de fato (depois do INSERT), nunca em
    // duplicata. O import de cadencia-quente é CIRCULAR (ela também importa `db`), mas seguro:
    // ninguém chama o outro no carregamento, só em runtime, quando os dois já estão prontos.
    if (text && personId && ehExplicito(text)) { try { marcarPapoQuente(personId, ts || now()) } catch { /* nunca derruba a gravação */ } }
    // ETIQUETA AUTOMÁTICA: a regra de uma etiqueta pode casar com o que a pessoa acabou de
    // escrever. Fica aqui pelo mesmo motivo do papo quente — é o único ponto por onde passa
    // mensagem de TODO canal — e vale mesmo com a IA desligada, porque etiquetar não é
    // responder. Só mensagem RECEBIDA, só depois do INSERT, e nunca derruba a gravação.
    if (text && personId && direction === 'incoming') {
      try {
        const postas = etiquetasAuto({ personId, texto: text, direction })
        for (const e of postas) {
          logEvent({ type: 'etiqueta_automatica', personId, channel,
            detail: `${e.nome} — regra ${e.regra.tipo === 'exata' ? 'frase exata' : 'palavra'}: "${e.regra.texto}"` })
        }
        aplicarCidadeDeTexto({ personId, texto: text, direction })
      } catch { /* etiqueta é conveniência; mensagem é o dado */ }
    }
    return true
  } catch { return false } // dedupe_key único: ignora duplicata
}

// Carimba a autoria numa mensagem que JÁ existe. Existe por causa de uma corrida real: o
// eco do WhatsApp (messages.upsert, fromMe) pode chegar ANTES do addMessage do caminho que
// enviou. Nesse caso o INSERT da IA é engolido pelo dedupe e a linha ficaria marcada como
// escrita pelo dono. Quem envia chama isto DEPOIS do addMessage e a verdade prevalece.
// Só sobe de "não sei" pra uma resposta, ou corrige humano->ia; nunca apaga uma autoria de IA.
export function marcarAutor({ channel, messageId, author }) {
  if (!messageId || !author) return false
  const r = db().prepare(`UPDATE message SET author=? WHERE dedupe_key=? AND (author IS NULL OR author!='ia')`)
    .run(author, `${channel}:${messageId}`)
  return r.changes > 0
}

// Troca o id PROVISÓRIO de uma mensagem que nós mesmos enviamos pelo id real do provedor.
// Existe por causa do Badoo: a bolha entra na hora com `b:out:<ts>` (pra aparecer sem esperar
// a releitura), e minutos depois o mesmo texto volta do servidor com o `uid` de verdade. Sem
// esta troca, o dedupe (que é por id) não reconheceria a mensagem e a conversa ficaria com
// ela em dobro. Só toca em id provisório, e nunca reescreve um id real por outro.
export function reidentificarMensagem({ channel, personId, direction, text, desdeTs, novoId, prefixoProvisorio }) {
  if (!novoId || !text) return false
  // UMA linha por chamada, a mais antiga que ainda está sem id real. Mandar o mesmo texto
  // duas vezes na mesma janela (acontece: "kkk", "oi") casaria com as duas de uma vez, e o
  // UPDATE em bloco daria as duas o mesmo id — violação de dedupe_key, exceção no meio do
  // sync. Uma por vez, da mais velha pra mais nova, faz o segundo uid achar a segunda bolha.
  const r = db().prepare(`UPDATE message SET message_id=?, dedupe_key=?
    WHERE message_id = (SELECT message_id FROM message
      WHERE person_id=? AND channel=? AND direction=? AND text=? AND ts>=? AND message_id LIKE ?
      ORDER BY ts ASC LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM message m2 WHERE m2.dedupe_key=?)`)
    .run(novoId, `${channel}:${novoId}`, personId, channel, direction, text, desdeTs || 0,
      (prefixoProvisorio || 'b:out:') + '%', `${channel}:${novoId}`)
  return r.changes > 0
}

// Retrato de uma conversa em NÚMEROS — determinístico, sem modelo nenhum no caminho.
// É o que responde "o que tudo eu conversei com fulano" sem depender de a IA lembrar:
// quantas mensagens, de quando até quando, por canal, e quantas das minhas foram na
// verdade escritas pela IA. `personIds` já vem unificado (a pessoa e seus aliases).
export function estatisticaConversa(personIds) {
  const ids = (Array.isArray(personIds) ? personIds : [personIds]).filter(Boolean).map(String)
  if (!ids.length) return null
  const q = ids.map(() => '?').join(',')
  const tot = db().prepare(`SELECT COUNT(*) n, MIN(ts) primeira, MAX(ts) ultima,
      SUM(direction='incoming') dela, SUM(direction='outgoing') minhas,
      SUM(direction='outgoing' AND author='ia') pela_ia,
      SUM(direction='outgoing' AND author='humano') por_mim
    FROM message WHERE person_id IN (${q})`).get(...ids)
  if (!tot || !tot.n) return { total: 0, canais: [] }
  const canais = db().prepare(`SELECT channel, COUNT(*) n, MIN(ts) primeira, MAX(ts) ultima
    FROM message WHERE person_id IN (${q}) GROUP BY channel ORDER BY n DESC`).all(...ids)
  return {
    total: tot.n, primeira: tot.primeira, ultima: tot.ultima,
    dela: tot.dela || 0, minhas: tot.minhas || 0,
    pelaIa: tot.pela_ia || 0, porMim: tot.por_mim || 0,
    // o que sobra de outgoing sem carimbo é histórico anterior à coluna: honesto dizer "não sei"
    semCarimbo: (tot.minhas || 0) - (tot.pela_ia || 0) - (tot.por_mim || 0),
    canais: canais.map((c) => ({ canal: c.channel, n: c.n, primeira: c.primeira, ultima: c.ultima })),
  }
}

// Dois ids apontam para a MESMA mensagem do Tinder quando são iguais ou quando um é
// sufixo do outro: o id atual é uuid ("019f9634-1ed0-<hex24>") e o caminho legado
// (/v2/matches) gravava só a cauda hex. Exige cauda longa pra não casar por acaso.
export function sameTinderMessageId(a, b) {
  const x = String(a || ''), y = String(b || '')
  if (!x || !y) return false
  if (x === y) return true
  const [long, short] = x.length >= y.length ? [x, y] : [y, x]
  return short.length >= 16 && long.endsWith(short)
}

// A bolha gravada na hora do envio (id `local:`) vira a mensagem real quando o sync traz
// o id do Tinder: o histórico converge para os ids autoritativos sem duplicar.
function promoteTinderMessageId(rowid, newId, ts) {
  try {
    db().prepare(`UPDATE message SET message_id=?,dedupe_key=?,ts=? WHERE rowid=?`).run(newId, 'tinder:' + newId, ts, rowid)
  } catch { db().prepare(`DELETE FROM message WHERE rowid=?`).run(rowid) } // o id real já está no banco
}

// Insere mensagem do Tinder. Além do dedupe por id, casa com uma bolha existente de mesmo
// texto/direção na janela de 10 min APENAS quando as duas são de fato a mesma mensagem:
// (1) uma delas é o eco do envio (id `local:`, porque o POST não devolve id) ou
// (2) os ids são a mesma mensagem em formatos diferentes (hex legado x uuid).
// Texto igual com DOIS ids reais distintos é mensagem repetida de verdade ("Sim" duas
// vezes seguidas) e precisa entrar — descartar isso era perda silenciosa de histórico.
// Retorna true se inseriu.
export function addTinderMessage({ messageId, accountKey, personId, direction, text, ts, author = null }) {
  const t = ts || now()
  const incoming = String(messageId || '')
  if (text) {
    const twins = db().prepare(`SELECT rowid,message_id FROM message
      WHERE person_id=? AND channel='tinder' AND direction=? AND text=? AND abs(ts-?)<600000`)
      .all(personId, direction, text, t)
    for (const twin of twins) {
      const existing = String(twin.message_id || '')
      const echo = existing.startsWith('local:') || incoming.startsWith('local:')
      if (!echo && !sameTinderMessageId(existing, incoming)) continue // repetida legítima
      if (existing.startsWith('local:') && incoming && !incoming.startsWith('local:')) {
        promoteTinderMessageId(twin.rowid, incoming, t)
      }
      // a gêmea já existe: a autoria ainda pode estar faltando nela (o sync do Tinder traz
      // a mesma bolha sem saber quem escreveu). Carimba e sai.
      if (author) marcarAutor({ channel: 'tinder', messageId: existing || incoming, author })
      return false
    }
  }
  return addMessage({ messageId, accountKey, personId, channel: 'tinder', direction, text, ts: t, author })
}

// Últimas bolhas do Tinder de uma pessoa (mais recente primeiro). É contra ISSO que o
// polling decide se falta histórico — o campo `last_text` do match é escrito por vários
// caminhos e não prova que as mensagens estão no banco.
export function recentTinderMessages(personId, limit = 10) {
  return db().prepare(`SELECT message_id,direction,text,ts FROM message
    WHERE person_id=? AND channel='tinder' ORDER BY ts DESC,rowid DESC LIMIT ?`).all(personId, limit)
}

export function timeline(personId, limit = 500) {
  // as `limit` mensagens MAIS RECENTES, em ordem cronológica (senão conversa longa mostra
  // só o começo e corta as recentes — bug do LIMIT com ASC).
  return db().prepare(`SELECT channel,direction,text,ts,media_json,author FROM
    (SELECT channel,direction,text,ts,media_json,author FROM message WHERE person_id=? ORDER BY ts DESC LIMIT ?)
    ORDER BY ts ASC`).all(personId, limit)
}

// ---------- tinder matches ----------
export function upsertTinderMatch(m) {
  db().prepare(`INSERT INTO tinder_match(account_key,match_id,person_id,other_id,name,bio,age,city,photos_json,
      has_conversation,pending,last_dir,last_text,last_ts,shared_contact,history_checked_at,active,updated_at)
    VALUES(@ak,@mid,@pid,@oid,@name,@bio,@age,@city,@photos,@hc,@pend,@ld,@lt,@lts,@sc,@hca,COALESCE(@active,1),@t)
    ON CONFLICT(account_key,match_id) DO UPDATE SET person_id=@pid,other_id=@oid,name=@name,
      -- COALESCE, não atribuição direta: quem grava aqui são DOIS caminhos, e o roster leve
      -- (/v1/chat/channels) não conhece bio, idade nem cidade. Com "bio=@bio" ele passava
      -- NULL por cima do que o sync completo tinha capturado, a cada polling. Foi assim que
      -- a cidade ficou 0 de 461 e a bio 158 de 461 — a IA abrindo conversa sem perfil
      -- porque o próprio sistema apagava o perfil, em silêncio, minuto a minuto (27/07/2026).
      bio=COALESCE(@bio,bio), age=COALESCE(@age,age), city=COALESCE(@city,city),
      -- Mesma história nas fotos: o roster manda UMA (a do card) e o sync completo manda
      -- todas. Vence quem trouxe mais, nunca quem escreveu por último.
      photos_json=CASE WHEN json_array_length(@photos) >= json_array_length(COALESCE(photos_json,'[]'))
        THEN @photos ELSE photos_json END,
      -- QUEM MANDA AQUI É O SERVIDOR — e a tentativa de mudar isso durou uma hora.
      -- Em 11/08/2026 eu vi o roster das 18:41 "apagar" o resumo de 86 conversas logo depois
      -- de a IA mandar 139 primeiras mensagens, e concluí que era foto velha atropelando
      -- verdade local. Era o contrário: o Tinder estava CERTO, as mensagens nunca chegaram
      -- (o canal não existia e o envio falhou em silêncio, ver licoes/envio-sem-comprovante).
      -- Proteger o dado local ali teria transformado um bug de envio em mentira permanente na
      -- tela. Enquanto o envio não provar entrega com id do provedor, a leitura do servidor
      -- vence — inclusive quando ela diz "não existe conversa nenhuma aqui".
      has_conversation=CASE WHEN @verified=1 OR @evidence=1 THEN @hc ELSE has_conversation END,
      pending=CASE WHEN @verified=1 OR @evidence=1 THEN @pend ELSE pending END,
      last_dir=CASE WHEN @verified=1 OR @evidence=1 THEN @ld ELSE last_dir END,
      last_text=CASE WHEN @verified=1 OR @evidence=1 THEN @lt ELSE last_text END,
      last_ts=CASE WHEN (@verified=1 OR @evidence=1) AND @lts IS NOT NULL THEN @lts ELSE last_ts END,
      shared_contact=MAX(shared_contact,@sc),
      history_checked_at=CASE WHEN @verified=1 THEN @hca ELSE history_checked_at END,
      active=COALESCE(@active,active),
      updated_at=@t`)
    .run({ ak: m.accountKey, mid: m.matchId, pid: m.personId, oid: m.otherId || null, name: m.name || null,
      bio: m.bio || null, age: m.age || null, city: m.city || null, photos: JSON.stringify(m.photos || []),
      hc: m.hasConversation ? 1 : 0, pend: m.pending ? 1 : 0, ld: m.lastDir || null, lt: m.lastText || null,
      lts: m.lastTs || null, sc: m.sharedContact ? 1 : 0, hca: m.historyCheckedAt || null,
      active: m.active === true ? 1 : m.active === false ? 0 : null,
      verified: m.historyCheckedAt ? 1 : 0, evidence: m.hasConversation ? 1 : 0, t: now() })
}

// O perfil completo dela. Guardado porque buscar é uma ida à API do Tinder: em conversa
// isso não pode acontecer a cada mensagem, e o perfil de uma pessoa não muda de hora em hora.
// `perfil_checked_at` marca mesmo quando veio vazio — senão a IA volta lá toda vez pra
// receber nada de novo, e é assim que se toma rate limit.
export function setTinderPerfil({ accountKey, matchId, perfil }) {
  db().prepare(`UPDATE tinder_match SET perfil_json=?, perfil_checked_at=? WHERE account_key=? AND match_id=?`)
    .run(perfil ? JSON.stringify(perfil) : null, now(), accountKey, matchId)
  if (perfil?.city) {
    const pid = db().prepare(`SELECT person_id FROM tinder_match WHERE account_key=? AND match_id=?`)
      .get(accountKey, matchId)?.person_id
    if (pid) {
      import('../self/cidade-pessoa.mjs')
        .then((C) => C.aplicarCidadeDePerfil({ personId: pid, city: perfil.city, fonte: 'perfil_tinder' }))
        .catch(() => {})
    }
  }
}

export function getTinderPerfil(accountKey, matchId) {
  const r = db().prepare(`SELECT perfil_json FROM tinder_match WHERE account_key=? AND match_id=?`).get(accountKey, matchId)
  if (!r || !r.perfil_json) return null
  try { return JSON.parse(r.perfil_json) } catch { return null }
}

// O match de uma pessoa. Existe porque nem todo caminho que gera mensagem tem a linha do
// match na mão — a iniciativa e o "chamar" só têm o person_id — e sem isto cada um desses
// caminhos conversaria sem perfil, que é o defeito que este pacote inteiro veio consertar.
export function tinderMatchPorPessoa(accountKey, personId) {
  return db().prepare(`SELECT * FROM tinder_match WHERE account_key=? AND person_id=? AND active=1
    ORDER BY COALESCE(last_ts,0) DESC LIMIT 1`).get(accountKey, personId) || null
}

// Fila da varredura: quem ainda não teve o perfil buscado, ou teve há mais de `dias`.
// Ordena pelas conversas mais recentes — se a varredura for interrompida no meio, o que já
// foi buscado é justamente o que a IA vai precisar primeiro.
export function tinderSemPerfil(accountKey, { limite = 50, dias = 30 } = {}) {
  const corte = now() - dias * 86400000
  return db().prepare(`SELECT match_id, person_id, other_id, name FROM tinder_match
    WHERE account_key=? AND active=1 AND other_id IS NOT NULL
      AND (perfil_checked_at IS NULL OR perfil_checked_at < ?)
    ORDER BY COALESCE(last_ts,0) DESC LIMIT ?`).all(accountKey, corte, limite)
}

export function tinderMatches(accountKey, { pendingOnly = false, includeInactive = false } = {}) {
  const sql = `SELECT * FROM tinder_match WHERE account_key=?`
    + (includeInactive ? `` : ` AND active=1`)
    + (pendingOnly ? ` AND pending=1` : ``)
    + ` ORDER BY last_ts DESC`
  return db().prepare(sql).all(accountKey)
}
export function reconcileActiveTinderMatches(accountKey, matchIds) {
  const ids = [...new Set((matchIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
  const deactivate = db().prepare(`UPDATE tinder_match SET active=0,updated_at=? WHERE account_key=?`)
  const activate = db().prepare(`UPDATE tinder_match SET active=1,updated_at=? WHERE account_key=? AND match_id=?`)
  const cancelInactiveOpeners = db().prepare(`UPDATE send_receipt SET state='cancelled',ts=?
    WHERE account_key=? AND channel='tinder-opener' AND state='queued'
      AND target_id IN (SELECT match_id FROM tinder_match WHERE account_key=? AND active=0)`)
  const tx = db().transaction(() => {
    const at = now()
    deactivate.run(at, accountKey)
    for (const matchId of ids) activate.run(at, accountKey, matchId)
    cancelInactiveOpeners.run(at, accountKey, accountKey)
  })
  tx()
  return ids.length
}
// Atualização parcial de uma conversa do Tinder (só preview/pendência), sem tocar em
// bio/idade/cidade/fotos — usada pelo polling incremental via canais. Retorna nº de linhas.
export function updateTinderConversation({ accountKey, matchId, lastText, lastTs, lastDir, pending, hasConversation = true }) {
  return db().prepare(`UPDATE tinder_match SET
      last_text=CASE WHEN @lts IS NULL OR last_ts IS NULL OR @lts>=last_ts THEN @lt ELSE last_text END,
      last_ts=CASE WHEN @lts IS NULL OR last_ts IS NULL OR @lts>=last_ts THEN COALESCE(@lts,last_ts) ELSE last_ts END,
      last_dir=CASE WHEN @lts IS NULL OR last_ts IS NULL OR @lts>=last_ts THEN @ld ELSE last_dir END,
      pending=CASE WHEN @lts IS NULL OR last_ts IS NULL OR @lts>=last_ts THEN @pend ELSE pending END,
      has_conversation=CASE WHEN @hc=1 THEN 1 ELSE has_conversation END, active=1, updated_at=@t
    WHERE account_key=@ak AND match_id=@mid`)
    .run({ ak: accountKey, mid: matchId, lt: lastText || null, lts: lastTs || null, ld: lastDir || null,
      pend: pending ? 1 : 0, hc: hasConversation ? 1 : 0, t: now() }).changes
}
export function updateTinderHistoryState({ accountKey, matchId, hasConversation, pending, lastDir, lastText, lastTs, sharedContact, historyCheckedAt }) {
  return db().prepare(`UPDATE tinder_match SET
      has_conversation=@hc,pending=@pend,last_dir=@ld,last_text=@lt,
      last_ts=CASE WHEN @lts IS NULL THEN last_ts ELSE @lts END,
      shared_contact=MAX(shared_contact,@sc),history_checked_at=@hca,updated_at=@t
    WHERE account_key=@ak AND match_id=@mid`)
    .run({ ak: accountKey, mid: matchId, hc: hasConversation ? 1 : 0, pend: pending ? 1 : 0,
      ld: lastDir || null, lt: lastText || null, lts: lastTs || null, sc: sharedContact ? 1 : 0,
      hca: historyCheckedAt || now(), t: now() }).changes
}

// Persiste uma mensagem enviada e o resumo exibido na lista na mesma transação.
// Todo caminho de envio deve passar por aqui para o chat e a bolinha de pendência
// nunca divergirem quando a mensagem parte do painel ou da IA automática.
export function recordTinderOutgoingMessage({ messageId, accountKey, matchId, personId, text, ts, author = null }) {
  const sentAt = ts || now()
  return db().transaction(() => {
    const inserted = addTinderMessage({
      messageId,
      accountKey,
      personId,
      direction: 'outgoing',
      text,
      ts: sentAt,
      author,
    })
    const updated = updateTinderHistoryState({
      accountKey,
      matchId,
      hasConversation: true,
      pending: false,
      lastDir: 'eu',
      lastText: text,
      lastTs: sentAt,
      historyCheckedAt: sentAt,
    })
    return { inserted, updated, sentAt }
  })()
}

// Defesa para dados legados: a timeline é a fonte mais detalhada. No boot, alinha
// preview, direção, horário e pendência de cada match ativo à sua última mensagem.
export function reconcileTinderConversationSummaries(accountKey) {
  const rows = db().prepare(`SELECT tm.match_id,tm.has_conversation,tm.pending,tm.last_dir,tm.last_text,tm.last_ts,
      m.direction AS message_direction,m.text AS message_text,m.ts AS message_ts
    FROM tinder_match tm
    JOIN message m ON m.message_id=(
      SELECT m2.message_id FROM message m2
      WHERE m2.account_key=tm.account_key AND m2.person_id=tm.person_id AND m2.channel='tinder'
      ORDER BY m2.ts DESC,m2.message_id DESC LIMIT 1
    )
    WHERE tm.account_key=? AND tm.active=1`).all(accountKey)
  const update = db().prepare(`UPDATE tinder_match SET
      has_conversation=1,pending=@pending,last_dir=@lastDir,last_text=@lastText,last_ts=@lastTs,
      history_checked_at=CASE WHEN COALESCE(history_checked_at,0)>0 THEN history_checked_at ELSE @checkedAt END,
      updated_at=@updatedAt
    WHERE account_key=@accountKey AND match_id=@matchId`)
  let repaired = 0
  db().transaction(() => {
    for (const row of rows) {
      const lastDir = row.message_direction === 'outgoing' ? 'eu' : 'ela'
      const pending = row.message_direction === 'incoming' ? 1 : 0
      const matches = row.has_conversation === 1
        && row.pending === pending
        && row.last_dir === lastDir
        && (row.last_text || '') === (row.message_text || '')
        && Number(row.last_ts || 0) === Number(row.message_ts || 0)
      if (matches) continue
      const updatedAt = now()
      update.run({
        accountKey,
        matchId: row.match_id,
        pending,
        lastDir,
        lastText: row.message_text || null,
        lastTs: row.message_ts || null,
        checkedAt: row.message_ts || updatedAt,
        updatedAt,
      })
      repaired++
    }
  })()
  return { checked: rows.length, repaired }
}

export function unverifiedTinderMatches(accountKey, limit = 20) {
  return db().prepare(`SELECT tm.* FROM tinder_match tm
    WHERE tm.account_key=? AND tm.active=1 AND COALESCE(tm.history_checked_at,0)=0
      AND NOT EXISTS (SELECT 1 FROM message m WHERE m.person_id=tm.person_id AND m.channel='tinder')
    ORDER BY CASE WHEN tm.has_conversation=1 THEN 0 ELSE 1 END, tm.last_ts DESC
    LIMIT ?`).all(accountKey, limit)
}
export function getTinderMatchTs(accountKey, matchId) {
  return db().prepare(`SELECT last_ts FROM tinder_match WHERE account_key=? AND match_id=?`).get(accountKey, matchId)?.last_ts || 0
}
export function getTinderMatchState(accountKey, matchId) {
  return db().prepare(`SELECT person_id,active,has_conversation,pending,last_dir,last_ts,last_text,history_checked_at
    FROM tinder_match WHERE account_key=? AND match_id=?`).get(accountKey, matchId)
    || { person_id: null, active: 0, has_conversation: 0, pending: 0, last_dir: null, last_ts: 0, last_text: null, history_checked_at: null }
}
export function queueTinderOpeners({ accountKey, personIds }) {
  const unique = [...new Set((personIds || []).map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 100)
  const accepted = []
  const skipped = []
  const select = db().prepare(`SELECT * FROM tinder_match
    WHERE account_key=? AND person_id=? AND active=1
      AND has_conversation=0 AND COALESCE(history_checked_at,0)>0`)
  const receipt = db().prepare(`SELECT state FROM send_receipt
    WHERE account_key=? AND channel='tinder-opener' AND target_id=?`)
  const enqueue = db().prepare(`INSERT INTO send_receipt(account_key,channel,target_id,command_id,text_fp,state,provider_msg_id,ts)
    VALUES(@ak,'tinder-opener',@tid,@cid,NULL,'queued',NULL,@t)
    ON CONFLICT(account_key,channel,target_id) DO UPDATE SET
      command_id=@cid,text_fp=NULL,state='queued',provider_msg_id=NULL,ts=@t`)
  const tx = db().transaction(() => {
    for (const personId of unique) {
      const match = select.get(accountKey, personId)
      if (!match) { skipped.push({ personId, reason: 'not-unmessaged' }); continue }
      const current = receipt.get(accountKey, match.match_id)
      if (current && ['queued', 'generating', 'sending', 'sent'].includes(current.state)) {
        skipped.push({ personId, reason: current.state }); continue
      }
      const commandId = `opener:${match.match_id}:${now()}`
      enqueue.run({ ak: accountKey, tid: match.match_id, cid: commandId, t: now() })
      accepted.push({ ...match, commandId })
    }
  })
  tx()
  return { accepted, skipped }
}
export function nextTinderOpener(accountKey) {
  return db().prepare(`SELECT tm.*,r.command_id,r.state AS opener_state,r.ts AS queued_at
    FROM send_receipt r JOIN tinder_match tm
      ON tm.account_key=r.account_key AND tm.match_id=r.target_id
    WHERE r.account_key=? AND r.channel='tinder-opener' AND r.state='queued' AND tm.active=1
    ORDER BY r.ts ASC LIMIT 1`).get(accountKey) || null
}
export function tinderOpenerQueueCount(accountKey) {
  return db().prepare(`SELECT COUNT(*) n FROM send_receipt
    WHERE account_key=? AND channel='tinder-opener' AND state IN ('queued','generating','sending')`).get(accountKey)?.n || 0
}

// ---------- IA auto por pessoa/canal ----------
export function setAiSetting({ personId, channel, enabled, state, lastAttemptedFp, lastSentFp, enabledAt }) {
  const cur = getAiSetting(personId, channel) || {}
  const vaiLigar = enabled != null ? !!enabled : !!cur.enabled
  const estava = !!cur.enabled
  let at = cur.enabled_at ?? null
  if (enabledAt != null) at = Number(enabledAt) || null
  else if (enabled != null) {
    if (vaiLigar && !estava) at = now()
    else if (!vaiLigar) at = null
    // já ligada sem data: não carimba "agora". Quem preenche é garantirEnabledAt, pelo Diário.
  }
  db().prepare(`INSERT INTO ai_setting(person_id,channel,enabled,state,last_attempted_fp,last_sent_fp,updated_at,enabled_at)
    VALUES(@pid,@ch,@en,@st,@laf,@lsf,@t,@eat)
    ON CONFLICT(person_id,channel) DO UPDATE SET enabled=@en,state=@st,last_attempted_fp=@laf,last_sent_fp=@lsf,updated_at=@t,enabled_at=@eat`)
    .run({ pid: personId, ch: channel, en: enabled != null ? (enabled ? 1 : 0) : (cur.enabled ? 1 : 0),
      st: state ?? cur.state ?? null, laf: lastAttemptedFp ?? cur.last_attempted_fp ?? null,
      lsf: lastSentFp ?? cur.last_sent_fp ?? null, t: now(), eat: at })
}

// Completa `enabled_at` nas linhas que já estavam ligadas antes da coluna existir.
// Fonte: o último `ai_on` depois do último `ai_off` no Diário. Sem evento, não inventa.
export function garantirEnabledAt() {
  const rows = db().prepare(`SELECT person_id, channel FROM ai_setting WHERE enabled=1 AND enabled_at IS NULL`).all()
  if (!rows.length) return 0
  const upd = db().prepare(`UPDATE ai_setting SET enabled_at=? WHERE person_id=? AND channel=? AND enabled=1 AND enabled_at IS NULL`)
  let n = 0
  for (const r of rows) {
    const evs = db().prepare(`SELECT type, ts FROM event WHERE person_id=? AND type IN ('ai_on','ai_off')
      AND (channel=? OR channel IS NULL) ORDER BY ts`).all(r.person_id, r.channel)
    let inicio = null
    for (const e of evs) {
      if (e.type === 'ai_on') { if (inicio == null) inicio = e.ts }
      else inicio = null
    }
    if (!inicio) {
      const todos = db().prepare(`SELECT type, ts FROM event WHERE person_id=? AND type IN ('ai_on','ai_off') ORDER BY ts`).all(r.person_id)
      for (const e of todos) {
        if (e.type === 'ai_on') { if (inicio == null) inicio = e.ts }
        else inicio = null
      }
    }
    if (!inicio) continue
    n += upd.run(inicio, r.person_id, r.channel).changes
  }
  return n
}
// GERAÇÃO ÓRFÃ: o processo morreu DEPOIS de marcar a tentativa e ANTES de enviar — deploy
// no meio do caminho, crash, OOM. A marca `last_attempted_fp` é gravada antes de gerar de
// propósito (é o que garante não mandar duas vezes), mas ela sobrevive ao processo: a
// pessoa some do loop e só volta a ser elegível se mandar mensagem NOVA. Foi o que
// aconteceu com a Isabella em 25/07 — resposta agendada pras 17:51:59, restart às 17:52:09.
//
// No boot ninguém pode estar gerando, então todo 'generating' encontrado aqui é órfão:
// solta a marca e o loop tenta de novo. Só 'generating' — quem já passou pra 'sending' ou
// 'sent' pode ter mensagem na rua e NÃO volta, senão a correção vira mensagem duplicada.
// Soltar a marca de "já tentei" numa conversa específica. Existe porque `setAiSetting`
// NÃO limpa com null: `lastAttemptedFp ?? cur.last_attempted_fp` cai no valor atual, então
// pedir `null` não apaga nada. Dois consertos de 27/07/2026 dependiam de apagar essa marca
// (a falha de geração que virava silêncio permanente, e o toggle que responde na hora) e os
// dois teriam falhado calados sem isto.
export function soltarTentativa(personId, channel) {
  db().prepare(`UPDATE ai_setting SET last_attempted_fp=NULL, updated_at=? WHERE person_id=? AND channel=?`)
    .run(now(), personId, channel)
}

export function recuperarGeracoesOrfas() {
  const orfas = db().prepare(`SELECT person_id, channel FROM ai_setting WHERE state='generating'`).all()
  if (!orfas.length) return []
  db().prepare(`UPDATE ai_setting SET last_attempted_fp=NULL, state='interrompida', updated_at=? WHERE state='generating'`).run(now())
  return orfas
}

// PASSAGEM DE BASTÃO ENTRE CANAIS (regra do sistema, 25/07/2026).
// Quando a conversa migra (ela passou o número no Tinder e agora é WhatsApp), o toggle
// tem que ir junto: a conversa mudou de casa, não a decisão dele.
//
// A sutileza que faz isso ser seguro: TRANSFERE, não LIGA. Se a IA estava ligada no canal
// de origem, ela acende no destino e apaga na origem. Se estava desligada, NADA acontece —
// a regra "IA automática nasce desligada" continua valendo, porque ligar sozinha numa
// pessoa que ele nunca autorizou seria a IA decidindo escrever pra alguém por conta própria.
// Devolve o que aconteceu (ou null quando não havia nada a transferir).
export function transferirIaEntreCanais({ personId, de, para }) {
  if (!personId || !de || !para || de === para) return null
  const origem = getAiSetting(personId, de)
  if (!origem || !origem.enabled) return null            // desligada na origem: nada a fazer
  const destino = getAiSetting(personId, para)
  if (destino && destino.enabled) {                       // já ligada no destino: só apaga a origem
    setAiSetting({ personId, channel: de, enabled: false, state: 'idle' })
    return { personId, de, para, acao: 'origem_desligada' }
  }
  setAiSetting({ personId, channel: para, enabled: true, state: 'idle', enabledAt: origem.enabled_at || now() })
  setAiSetting({ personId, channel: de, enabled: false, state: 'idle' })
  // limpa a cadência pendente da origem: resposta agendada lá não deve disparar depois
  try { db().prepare(`UPDATE ai_setting SET scheduled_fp=NULL, reply_at=NULL WHERE person_id=? AND channel=?`).run(personId, de) } catch { /* coluna nova */ }
  logEvent({ type: 'ia_transferida', personId, channel: para, detail: `a conversa migrou de ${de} para ${para}: IA acompanhou` })
  return { personId, de, para, acao: 'transferida' }
}

export function getAiSetting(personId, channel) {
  return db().prepare(`SELECT * FROM ai_setting WHERE person_id=? AND channel=?`).get(personId, channel) || null
}
// Agenda a resposta desta pendência (fp) para reply_at. Cria a linha se não existir,
// preservando enabled/state. Usada pela cadência humana (src/ai/cadence.mjs).
export function setReplySchedule({ personId, channel, fp, replyAt }) {
  const cur = getAiSetting(personId, channel) || {}
  db().prepare(`INSERT INTO ai_setting(person_id,channel,enabled,state,scheduled_fp,reply_at,updated_at)
    VALUES(@pid,@ch,@en,@st,@sfp,@ra,@t)
    ON CONFLICT(person_id,channel) DO UPDATE SET scheduled_fp=@sfp,reply_at=@ra,updated_at=@t`)
    .run({ pid: personId, ch: channel, en: cur.enabled ? 1 : 0, st: cur.state ?? 'waiting', sfp: fp, ra: replyAt, t: now() })
}
export function aiEnabledPeople(channel) {
  return db().prepare(`SELECT person_id,last_attempted_fp,last_sent_fp FROM ai_setting WHERE channel=? AND enabled=1`).all(channel)
}

// ---------- comprovantes de envio (idempotência) ----------
export function getReceipt(accountKey, channel, targetId) {
  return db().prepare(`SELECT * FROM send_receipt WHERE account_key=? AND channel=? AND target_id=?`).get(accountKey, channel, targetId) || null
}
export function saveReceipt({ accountKey, channel, targetId, commandId, textFp, state, providerMsgId }) {
  db().prepare(`INSERT INTO send_receipt(account_key,channel,target_id,command_id,text_fp,state,provider_msg_id,ts)
    VALUES(@ak,@ch,@tid,@cid,@fp,@st,@pmid,@t)
    ON CONFLICT(account_key,channel,target_id) DO UPDATE SET command_id=@cid,text_fp=@fp,state=@st,provider_msg_id=@pmid,ts=@t`)
    .run({ ak: accountKey, ch: channel, tid: targetId, cid: commandId, fp: textFp, st: state, pmid: providerMsgId || null, t: now() })
}

// ---------- WhatsApp: sessão + revisão de vínculo ----------
export function upsertWaSession({ accountKey, status, jid, name, qrDataUrl, requiresRepair }) {
  db().prepare(`INSERT INTO wa_session(account_key,status,jid,name,qr_data_url,requires_repair,updated_at)
    VALUES(@ak,@st,@jid,@name,@qr,@rr,@t)
    ON CONFLICT(account_key) DO UPDATE SET status=@st,jid=COALESCE(@jid,jid),name=COALESCE(@name,name),
      qr_data_url=@qr,requires_repair=@rr,updated_at=@t`)
    .run({ ak: accountKey, st: status, jid: jid || null, name: name || null, qr: qrDataUrl || null, rr: requiresRepair ? 1 : 0, t: now() })
}
export function getWaSession(accountKey) {
  return db().prepare(`SELECT * FROM wa_session WHERE account_key=?`).get(accountKey) || null
}
export function setBadooPerfil(accountKey, chatId, perfil) {
  db().prepare(`UPDATE badoo_chat SET perfil_json=? WHERE account_key=? AND chat_id=?`)
    .run(perfil ? JSON.stringify(perfil) : null, accountKey, chatId)
  if (perfil?.city) {
    import('../self/cidade-pessoa.mjs')
      .then((C) => C.aplicarCidadeDePerfil({ personId: 'b:' + chatId, city: perfil.city, fonte: 'perfil_badoo' }))
      .catch(() => {})
  }
}
export function getBadooPerfil(accountKey, chatId) {
  const r = db().prepare(`SELECT perfil_json FROM badoo_chat WHERE account_key=? AND chat_id=?`).get(accountKey, chatId)
  if (!r || !r.perfil_json) return null
  try { return JSON.parse(r.perfil_json) } catch { return null }
}

export function addLinkReview(r) {
  const opcoes = Array.isArray(r.opcoes) ? r.opcoes.filter(Boolean) : (r.waJid ? [r.waJid] : [])
  db().prepare(`INSERT OR REPLACE INTO wa_link_review(id,account_key,wa_jid,wa_push_name,wa_first_text,
      candidate_person_id,candidate_name,candidate_score,reason,options_json,status,created_at)
    VALUES(@id,@ak,@jid,@pn,@ft,@cpid,@cn,@sc,@rs,@op,'pending',@t)`)
    .run({ id: r.id, ak: r.accountKey, jid: r.waJid, pn: r.pushName || null, ft: r.firstText || null,
      cpid: r.candidatePersonId || null, cn: r.candidateName || null, sc: r.candidateScore || 0, rs: r.reason || null,
      op: opcoes.length ? JSON.stringify(opcoes) : null, t: now() })
}
export function pendingLinkReviews(accountKey) {
  return db().prepare(`SELECT * FROM wa_link_review WHERE account_key=? AND status='pending' ORDER BY created_at DESC`).all(accountKey)
}
export function resolveLinkReview(id, status) {
  db().prepare(`UPDATE wa_link_review SET status=?, resolved_at=? WHERE id=?`).run(status, now(), id)
}

// ---------- WhatsApp: lista de conversas ----------
// unreadInc: soma 1 ao contador de não-lidas (mensagem recebida). avatar: url da foto.
export function upsertWaChat({ accountKey, jid, name, lastText, lastTs, fromTinder, adopted, avatar, unreadInc }) {
  db().prepare(`INSERT INTO wa_chat(account_key,jid,name,last_text,last_ts,from_tinder,adopted,avatar,unread,updated_at)
    VALUES(@ak,@jid,@name,@lt,@lts,@ft,@ad,@av,@ui,@t)
    ON CONFLICT(account_key,jid) DO UPDATE SET
      name=COALESCE(@name,name),
      last_text=CASE WHEN @lts>=last_ts THEN COALESCE(@lt,last_text) ELSE last_text END,
      last_ts=MAX(last_ts,@lts),
      from_tinder=MAX(from_tinder,@ft),
      adopted=CASE WHEN @ad IS NULL THEN adopted ELSE @ad END,
      avatar=COALESCE(@av,avatar),
      unread=unread+@ui,
      updated_at=@t`)
    .run({ ak: accountKey, jid, name: name || null, lt: lastText || null, lts: lastTs || 0,
      ft: fromTinder ? 1 : 0, ad: adopted == null ? null : (adopted ? 1 : 0), av: avatar || null, ui: unreadInc ? 1 : 0, t: now() })
}
export function waChats(accountKey) { return db().prepare(`SELECT * FROM wa_chat WHERE account_key=? ORDER BY last_ts DESC`).all(accountKey) }
export function getWaChat(accountKey, jid) { return db().prepare(`SELECT * FROM wa_chat WHERE account_key=? AND jid=?`).get(accountKey, jid) || null }
export function waChatSetAvatar(accountKey, jid, avatar) { db().prepare(`UPDATE wa_chat SET avatar=? WHERE account_key=? AND jid=?`).run(avatar || null, accountKey, jid) }
export function waChatSetPn(accountKey, jid, pn) { db().prepare(`UPDATE wa_chat SET pn=? WHERE account_key=? AND jid=?`).run(pn || null, accountKey, jid) }
export function waChatMarkRead(accountKey, jid) { db().prepare(`UPDATE wa_chat SET unread=0 WHERE account_key=? AND jid=?`).run(accountKey, jid) }
export function waChatSetMode(accountKey, jid, mode) { db().prepare(`UPDATE wa_chat SET mode=? WHERE account_key=? AND jid=?`).run(mode || null, accountKey, jid) }
export function waChatSetNotTinder(accountKey, jid, val) { db().prepare(`UPDATE wa_chat SET not_tinder=? WHERE account_key=? AND jid=?`).run(val ? 1 : 0, accountKey, jid) }
// Conserta chats cujo last_text/last_ts foi "bombado" por uma mensagem de CONTROLE
// (protocolMessage etc.): repõe o cabeçalho a partir da última mensagem REAL da conversa
// (posição correta, como o WhatsApp faz). Se não sobrou nenhuma msg real, remove o chat.
const WA_CONTROL_MARKERS = ['[protocolMessage]', '[senderKeyDistributionMessage]', '[reactionMessage]', '[messageContextInfo]', '[pollUpdateMessage]', '[keepInChatMessage]', '[pinInChatMessage]']
export function pruneControlChatMetadata(accountKey) {
  const q = WA_CONTROL_MARKERS.map(() => '?').join(',')
  const rows = db().prepare(`SELECT jid FROM wa_chat WHERE account_key=? AND last_text IN (${q})`).all(accountKey, ...WA_CONTROL_MARKERS)
  let fixed = 0, removed = 0
  for (const { jid } of rows) {
    const pid = personByIdentity(accountKey, 'whatsapp', jid) || ('wa:' + jid)
    const last = db().prepare(`SELECT text,ts FROM message WHERE person_id=? AND channel='whatsapp' ORDER BY ts DESC LIMIT 1`).get(pid)
    if (last) { db().prepare(`UPDATE wa_chat SET last_text=?, last_ts=?, updated_at=? WHERE account_key=? AND jid=?`).run(last.text, last.ts, now(), accountKey, jid); fixed++ }
    else { db().prepare(`DELETE FROM wa_chat WHERE account_key=? AND jid=?`).run(accountKey, jid); removed++ }
  }
  return { fixed, removed }
}

// Funde o chat 'fromJid' no 'toJid' (mesma pessoa no sistema LID: número + @lid). Move as
// mensagens (person_id 'wa:'+jid), consolida os metadados no destino e apaga a duplicata.
//
// Conserto de 24/07/2026 (D2 do docs/PLANO-IDENTIDADE-VINCULO.md): a versão anterior recusava
// fundir sempre que o lado do NÚMERO estivesse vinculado a uma pessoa do Tinder — que é
// exatamente o que o vínculo determinístico cria. Resultado: as pessoas que vieram do Tinder
// eram as ÚNICAS que ficavam duplicadas pra sempre, e a conversa que chegava no @lid não caía
// na pessoa certa. Agora, quando só um lado tem vínculo, o vínculo MIGRA pro @lid (a chave
// canônica) e as mensagens vão pra essa pessoa. Conflito real (os dois lados vinculados a
// pessoas DIFERENTES) continua recusado — aí é caso de revisão humana, não de palpite.
export function mergeWaChatInto(accountKey, fromJid, toJid) {
  if (!fromJid || !toJid || fromJid === toJid) return false
  const from = getWaChat(accountKey, fromJid), to = getWaChat(accountKey, toJid)
  if (!from || !to) return false
  const fromLinked = personByIdentity(accountKey, 'whatsapp', fromJid)
  const toLinked = personByIdentity(accountKey, 'whatsapp', toJid)
  // conflito real: cada lado aponta pra uma pessoa diferente. Não funde, não escolhe.
  if (fromLinked && toLinked && fromLinked !== toLinked) return false
  // pessoa de destino: quem já tiver vínculo (de qualquer um dos lados); senão 'wa:'+@lid.
  const toPid = toLinked || fromLinked || ('wa:' + toJid)
  const fromPid = fromLinked || ('wa:' + fromJid)
  // o vínculo passa a morar no jid de destino (o @lid), que é onde a conversa realmente chega
  if (fromLinked && !toLinked) {
    db().prepare(`DELETE FROM identity WHERE account_key=? AND channel='whatsapp' AND channel_id=?`).run(accountKey, fromJid)
    db().prepare(`INSERT INTO identity(account_key,channel,channel_id,person_id,link_method,linked_at)
      VALUES(?,'whatsapp',?,?,'lid-canonical',?)
      ON CONFLICT(channel,channel_id,account_key) DO UPDATE SET person_id=excluded.person_id`)
      .run(accountKey, toJid, fromLinked, now())
  }
  // Move pro destino TODAS as mensagens que estavam espalhadas pelas identidades dos dois
  // lados: as do número (vinculado ou 'wa:'+número) E as que chegaram no @lid antes de ele
  // ganhar o vínculo ('wa:'+lid). Sem esta última, a conversa que veio pelo @lid ficava
  // órfã depois da fusão — a pessoa do Tinder recebia só metade do histórico.
  const origens = new Set([fromPid, 'wa:' + fromJid, 'wa:' + toJid])
  origens.delete(toPid)
  const mover = db().prepare(`UPDATE message SET person_id=? WHERE person_id=? AND channel='whatsapp'`)
  for (const origem of origens) mover.run(toPid, origem)
  // consolida metadados: mantém o @lid (tem nome), puxa o que for mais novo do número
  const lastTs = Math.max(to.last_ts || 0, from.last_ts || 0)
  const lastText = (from.last_ts || 0) > (to.last_ts || 0) ? from.last_text : to.last_text
  db().prepare(`UPDATE wa_chat SET last_ts=?, last_text=COALESCE(?,last_text), unread=unread+?, updated_at=? WHERE account_key=? AND jid=?`)
    .run(lastTs, lastText, from.unread || 0, now(), accountKey, toJid)
  db().prepare(`DELETE FROM wa_chat WHERE account_key=? AND jid=?`).run(accountKey, fromJid)
  return true
}

// ---------- veredito de envio (certo/errado) ----------
export function addSendVerdict(v) {
  // SUFIXO ALEATÓRIO, não só o milissegundo. Dois vereditos do mesmo alvo no MESMO ms geravam
  // o mesmo id e o segundo estourava com UNIQUE constraint — em produção isso derruba o
  // registro do veredito, que é justamente a prova de quem recebeu o quê. O mesmo defeito já
  // tinha sido corrigido noutro id deste arquivo; este ficou pra trás e só aparecia quando a
  // máquina estava rápida o bastante (falhou no `npm run check` de 03/08/2026).
  const id = v.id || `vd:${v.messageId || v.targetId}:${now()}:${Math.random().toString(36).slice(2, 7)}`
  db().prepare(`INSERT INTO send_verdict(id,account_key,channel,target_id,message_id,person_id,verdict,reason,note,created_at)
    VALUES(@id,@ak,@ch,@tid,@mid,@pid,@v,@r,@n,@t)`)
    .run({ id, ak: v.accountKey, ch: v.channel, tid: v.targetId || null, mid: v.messageId || null,
      pid: v.personId || null, v: v.verdict, r: v.reason || null, n: v.note || null, t: now() })
  return id
}
export function verdictForMessage(messageId) {
  return db().prepare(`SELECT * FROM send_verdict WHERE message_id=? ORDER BY created_at DESC LIMIT 1`).get(messageId) || null
}
export function verdictsByMessageIds(ids) {
  if (!ids || !ids.length) return {}
  const q = ids.map(() => '?').join(',')
  const out = {}
  for (const r of db().prepare(`SELECT message_id, verdict, reason FROM send_verdict WHERE message_id IN (${q}) ORDER BY created_at ASC`).all(...ids)) {
    out[r.message_id] = { verdict: r.verdict, reason: r.reason }
  }
  return out
}
export function verdictCounts(accountKey) {
  return db().prepare(`SELECT channel, verdict, reason, COUNT(*) n FROM send_verdict WHERE account_key=? GROUP BY channel, verdict, reason`).all(accountKey)
}
export function negarContato({ valor, kind, personId, motivo }) {
  if (!valor) return false
  db().prepare(`INSERT INTO contato_negado(valor,kind,person_id,motivo,created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(valor) DO UPDATE SET motivo=excluded.motivo`).run(String(valor), kind || null, personId || null, motivo || null, now())
  return true
}
export function contatoNegado(valor) { return !!db().prepare(`SELECT 1 FROM contato_negado WHERE valor=?`).get(String(valor || '')) }
export function contatosNegados() { return db().prepare(`SELECT * FROM contato_negado ORDER BY created_at DESC`).all() }
// Desfaz um vínculo: apaga a identity (a conversa desgruda da pessoa) e devolve o que tinha.
export function desvincular({ accountKey, channel, channelId }) {
  const row = identityRow(accountKey, channel, channelId)
  if (!row) return null
  db().prepare(`DELETE FROM identity WHERE account_key=? AND channel=? AND channel_id=?`).run(accountKey, channel, channelId)
  return row
}

// ---------- estado do vínculo ----------
export function setIdentityState({ accountKey, channel, channelId, state, evidenceHintId }) {
  const confirmado = state === 'confirmado_servidor' || state === 'confirmado_conversa'
  return db().prepare(`UPDATE identity SET link_state=@st,
      evidence_hint_id=COALESCE(@hint,evidence_hint_id),
      confirmed_at=CASE WHEN @conf=1 AND confirmed_at IS NULL THEN @t ELSE confirmed_at END,
      last_seen_at=@t
    WHERE account_key=@ak AND channel=@ch AND channel_id=@cid`)
    .run({ ak: accountKey, ch: channel, cid: channelId, st: state, hint: evidenceHintId || null, conf: confirmado ? 1 : 0, t: now() }).changes
}
export function identityRow(accountKey, channel, channelId) {
  return db().prepare(`SELECT * FROM identity WHERE account_key=? AND channel=? AND channel_id=?`).get(accountKey, channel, channelId) || null
}
export function identitiesByState(accountKey, channel, state) {
  return db().prepare(`SELECT * FROM identity WHERE account_key=? AND channel=? AND COALESCE(link_state,'')=?`).all(accountKey, channel, state || '')
}
// Reconcilia o estado de todos os vínculos de um canal contra a REALIDADE: vínculo que já
// tem mensagem virou conversa de verdade; vínculo confirmado só pelo servidor e parado há
// mais de `friosDepoisDeMs` vira 'frio' (aparece na aba pra você revisar em vez de sumir).
export function reconcileLinkStates(accountKey, channel = 'whatsapp', friosDepoisDeMs = 14 * 86400000) {
  const linhas = db().prepare(`SELECT i.*,
      (SELECT COUNT(*) FROM message m WHERE m.person_id=i.person_id AND m.channel=i.channel) AS msgs
    FROM identity i WHERE i.account_key=? AND i.channel=?`).all(accountKey, channel)
  const upd = db().prepare(`UPDATE identity SET link_state=?, confirmed_at=COALESCE(confirmed_at,?), last_seen_at=?
    WHERE account_key=? AND channel=? AND channel_id=?`)
  const contagem = {}
  const t = now()
  db().transaction(() => {
    for (const l of linhas) {
      if (l.link_state === 'rejeitado' || l.link_state === 'ambiguo') { contagem[l.link_state] = (contagem[l.link_state] || 0) + 1; continue }
      let estado
      if (l.msgs > 0) estado = 'confirmado_conversa'
      else if ((t - (l.confirmed_at || l.linked_at || t)) > friosDepoisDeMs) estado = 'frio'
      else estado = l.link_state || 'confirmado_servidor'
      if (estado !== l.link_state) upd.run(estado, l.confirmed_at || l.linked_at || t, t, accountKey, channel, l.channel_id)
      contagem[estado] = (contagem[estado] || 0) + 1
    }
  })()
  return contagem
}

// Quando um jid ganha vínculo, as mensagens que já estavam guardadas na conversa CRUA
// ('wa:'+jid) precisam ir junto pra pessoa vinculada — senão a conversa abre VAZIA no
// painel e a IA perde o histórico. Regressão real de 24/07/2026: o resolvedor passou a
// vincular conversas que já tinham conversa (o código antigo só pegava as vazias), e 3
// conversas ficaram com 32, 99 e 153 mensagens órfãs.
// Idempotente: sem órfãs, não faz nada. Devolve quantas mensagens moveu.
export function adoptWaConversation(accountKey, jid, personId) {
  if (!jid || !personId) return 0
  const cru = 'wa:' + jid
  if (cru === personId) return 0
  return db().prepare(`UPDATE message SET person_id=? WHERE person_id=? AND channel='whatsapp'`).run(personId, cru).changes
}

// Varre TODOS os vínculos e adota as mensagens órfãs de cada um. Roda no boot e depois de
// cada passada do resolvedor: é a rede de segurança pra nenhuma conversa abrir vazia.
export function repairOrphanWaMessages(accountKey) {
  const linhas = db().prepare(`SELECT channel_id, person_id FROM identity
    WHERE account_key=? AND channel='whatsapp' AND person_id != 'wa:'||channel_id`).all(accountKey)
  let movidas = 0, conversas = 0
  db().transaction(() => {
    for (const l of linhas) {
      const n = adoptWaConversation(accountKey, l.channel_id, l.person_id)
      if (n) { movidas += n; conversas++ }
    }
  })()
  return { conversas, movidas }
}

// A mesma pessoa pode acabar com MAIS DE UM vínculo de WhatsApp — o antigo, criado no
// número, e o novo, no @lid pra onde a conversa realmente chega. Isso é perigoso e não
// teórico: `jidForPerson` pega uma linha sem ordem definida, então a IA podia responder
// pro jid morto. Aqui a gente consolida: fica o vínculo que tem conversa de verdade
// (chat existente ou mensagens); os outros são removidos. Empate: o @lid ganha.
export function consolidateWaIdentities(accountKey) {
  const duplicadas = db().prepare(`SELECT person_id FROM identity
    WHERE account_key=? AND channel='whatsapp' GROUP BY person_id HAVING COUNT(*)>1`).all(accountKey)
  const linhas = db().prepare(`SELECT i.*,
      (SELECT COUNT(*) FROM wa_chat c WHERE c.account_key=i.account_key AND c.jid=i.channel_id) AS tem_chat,
      (SELECT COALESCE(MAX(c.last_ts),0) FROM wa_chat c WHERE c.account_key=i.account_key AND c.jid=i.channel_id) AS quando,
      (SELECT COUNT(*) FROM message m WHERE m.person_id='wa:'||i.channel_id AND m.channel='whatsapp') AS msgs_crus
    FROM identity i WHERE i.account_key=? AND i.channel='whatsapp' AND i.person_id=?`)
  const apagar = db().prepare(`DELETE FROM identity WHERE account_key=? AND channel='whatsapp' AND channel_id=?`)
  let removidos = 0
  let mantidos = 0
  db().transaction(() => {
    for (const { person_id } of duplicadas) {
      const cands = linhas.all(accountKey, person_id)
      const nota = (c) => (c.link_method === 'manual-ui' ? 2000 : c.link_method === 'manual' ? 1000 : 0)
        + (c.tem_chat ? 100 : 0) + (c.msgs_crus > 0 ? 50 : 0)
        + (String(c.channel_id).endsWith('@lid') ? 10 : 0)
      // Empate na nota (os dois têm conversa): vale a conversa mais RECENTE — é a que a
      // pessoa realmente usa. Sem esse desempate a escolha dependia da ordem do banco.
      cands.sort((a, b) => (nota(b) - nota(a)) || ((b.quando || 0) - (a.quando || 0)))
      // ANTES: apagava todos os perdedores — o que impedia a pessoa de ter dois WhatsApp
      // de verdade (número antigo + atual, ou dois chips). O risco original era a IA
      // escrever no jid morto; quem resolve isso é a ordem de waJidForPerson + a marcação
      // de principal. Então aqui só some o que é ARTEFATO: vínculo sem conversa e sem
      // mensagem nenhuma. Vínculo com sinal de vida fica, virando o segundo número dela.
      // A escolha do dono manda. Se ele marcou um número como o de envio, a consolidação
      // NÃO rebaixa esse — ela só arruma o resto. Sem isso, a rotina desfazia a escolha
      // dele na passada seguinte, em silêncio.
      const escolhido = cands.find((c) => c.is_primary)
      for (const perdedor of cands.slice(1)) {
        const vazio = !perdedor.tem_chat && !perdedor.msgs_crus
        if (vazio) { apagar.run(accountKey, perdedor.channel_id); removidos++; continue }
        if (escolhido && perdedor.channel_id === escolhido.channel_id) { mantidos++; continue }
        db().prepare(`UPDATE identity SET is_primary=0 WHERE account_key=? AND channel='whatsapp' AND channel_id=?`).run(accountKey, perdedor.channel_id)
        mantidos++
      }
      // ninguém escolhido: o de maior nota (conversa de verdade, mais recente) recebe
      if (!escolhido) db().prepare(`UPDATE identity SET is_primary=1 WHERE account_key=? AND channel='whatsapp' AND channel_id=?`).run(accountKey, cands[0].channel_id)
    }
  })()
  return { pessoas: duplicadas.length, removidos, mantidos }
}

// jid de WhatsApp de uma pessoa, com ORDEM DEFINIDA: vale o vínculo que tem conversa de
// verdade. Sem isso o `.get()` cru escolhia qualquer um — inclusive um vínculo morto.
export function waJidForPerson(accountKey, personId) {
  return db().prepare(`SELECT i.channel_id FROM identity i
    WHERE i.account_key=? AND i.channel='whatsapp' AND i.person_id=?
    ORDER BY i.is_primary DESC, (i.link_method='manual-ui') DESC, (i.link_method='manual') DESC,
             (SELECT COUNT(*) FROM wa_chat c WHERE c.account_key=i.account_key AND c.jid=i.channel_id) DESC,
             (i.channel_id LIKE '%@lid') DESC,
             i.linked_at DESC
    LIMIT 1`).get(accountKey, personId)?.channel_id || null
}

// Escolhe qual vínculo de um canal é o de ENVIO daquela pessoa. Os outros continuam
// vinculados (a memória lê todos), mas a IA escreve só neste.
export function setPrimaryIdentity(accountKey, personId, channel, channelId) {
  const tx = db().transaction(() => {
    db().prepare(`UPDATE identity SET is_primary=0 WHERE account_key=? AND channel=? AND person_id=?`).run(accountKey, channel, personId)
    db().prepare(`UPDATE identity SET is_primary=1 WHERE account_key=? AND channel=? AND channel_id=?`).run(accountKey, channel, channelId)
  })
  tx()
  return true
}

// ---------- contatos que a pessoa passou (hints) ----------
// Insere se for novo; se já existe o mesmo contato pra essa pessoa, não duplica (o índice
// único resolve) e mantém o registro original — a PRIMEIRA vez que ela mandou é a que vale.
export function addContactHint(h) {
  const id = h.id || `hint:${h.personId}:${h.kind}:${String(h.normalized).replace(/\W+/g, '')}`.slice(0, 120)
  try {
    db().prepare(`INSERT INTO contact_hint(id,account_key,person_id,source_channel,source_message_id,
        kind,raw,normalized,quote,confidence,status,created_at)
      VALUES(@id,@ak,@pid,@ch,@mid,@kind,@raw,@norm,@quote,@conf,'novo',@t)`)
      .run({ id, ak: h.accountKey, pid: h.personId, ch: h.sourceChannel, mid: h.sourceMessageId || null,
        kind: h.kind, raw: h.raw, norm: h.normalized, quote: (h.quote || '').slice(0, 400),
        conf: h.confidence == null ? 1 : h.confidence, t: now() })
    return id
  } catch { return null } // já existia
}
export function contactHints({ status = null, personId = null, kind = null, limit = 200 } = {}) {
  const cond = ['1=1']; const p = []
  if (status) { cond.push('status=?'); p.push(status) }
  if (personId) { cond.push('person_id=?'); p.push(personId) }
  if (kind) { cond.push('kind=?'); p.push(kind) }
  p.push(limit)
  return db().prepare(`SELECT * FROM contact_hint WHERE ${cond.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...p)
}
export function getContactHint(id) { return db().prepare(`SELECT * FROM contact_hint WHERE id=?`).get(id) || null }
export function setContactHintStatus(id, status) {
  db().prepare(`UPDATE contact_hint SET status=?, resolved_at=? WHERE id=?`).run(status, now(), id)
}
export function contactHintCounts() {
  return db().prepare(`SELECT kind, status, COUNT(*) n FROM contact_hint GROUP BY kind, status`).all()
}

// ---------- WhatsApp: cache canônico LID <-> PN ----------
// Guarda o par assim que ele aparece (resolução via baileys, evento de mensagem ou manual).
// É a memória que sobrevive a restart: sem ela, todo boot recomeça sem saber que o @lid
// 123@lid é o número 5545...@s.whatsapp.net, e o vínculo do Tinder erra o alvo de novo.
export function rememberWaIdentity({ lid, pn, source = 'lidmap' }) {
  // sufixo de dispositivo ('...:0@dominio') nunca entra no cache: envenena toda comparação
  // por número (o dígito do device gruda no telefone quando se tira a pontuação).
  lid = String(lid || '').replace(/:\d+@/, '@')
  pn = pn ? String(pn).replace(/:\d+@/, '@') : pn
  if (!lid || !String(lid).endsWith('@lid')) return false
  db().prepare(`INSERT INTO wa_identity(lid,pn,source,first_seen,last_seen) VALUES(@lid,@pn,@src,@t,@t)
    ON CONFLICT(lid) DO UPDATE SET pn=COALESCE(@pn,pn), source=@src, last_seen=@t`)
    .run({ lid, pn: pn || null, src: source, t: now() })
  return true
}
export function waLidForPn(pn) {
  if (!pn) return null
  return db().prepare(`SELECT lid FROM wa_identity WHERE pn=? ORDER BY last_seen DESC LIMIT 1`).get(pn)?.lid || null
}
export function waPnForLid(lid) {
  if (!lid) return null
  return db().prepare(`SELECT pn FROM wa_identity WHERE lid=?`).get(lid)?.pn || null
}
export function waIdentitiesSemPn() {
  return db().prepare(`SELECT lid FROM wa_identity WHERE pn IS NULL`).all().map((r) => r.lid)
}
export function waIdentityPairs() { return db().prepare(`SELECT lid,pn FROM wa_identity WHERE pn IS NOT NULL`).all() }

// Re-aponta um vínculo de canal pra outro channel_id (mesma pessoa). É o que leva um
// vínculo que nasceu no número pro @lid, sem perder o método nem a data originais.
export function relinkIdentity({ accountKey, channel, fromChannelId, toChannelId }) {
  if (!fromChannelId || !toChannelId || fromChannelId === toChannelId) return false
  const cur = db().prepare(`SELECT * FROM identity WHERE account_key=? AND channel=? AND channel_id=?`).get(accountKey, channel, fromChannelId)
  if (!cur) return false
  const jaTem = db().prepare(`SELECT person_id FROM identity WHERE account_key=? AND channel=? AND channel_id=?`).get(accountKey, channel, toChannelId)
  if (jaTem && jaTem.person_id !== cur.person_id) return false // conflito: não sobrescreve
  db().transaction(() => {
    db().prepare(`DELETE FROM identity WHERE account_key=? AND channel=? AND channel_id=?`).run(accountKey, channel, fromChannelId)
    db().prepare(`INSERT INTO identity(account_key,channel,channel_id,person_id,link_method,linked_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(channel,channel_id,account_key) DO UPDATE SET person_id=excluded.person_id`)
      .run(accountKey, channel, toChannelId, cur.person_id, cur.link_method, cur.linked_at || now())
  })()
  return true
}

// Mensagens de UM canal de uma pessoa (thread), em ordem cronológica. Usado pela
// conversa do WhatsApp no painel (person_id = pessoa vinculada OU 'wa:'+jid).
export function channelMessages(personId, channel, limit = 300) {
  // as `limit` mensagens MAIS RECENTES da thread, em ordem cronológica (o ASC+LIMIT
  // pegava as mais ANTIGAS e cortava as recentes em conversas longas). rowid desempata
  // mensagens do mesmo minuto sem inverter a ordem em que o provedor as entregou.
  return db().prepare(`SELECT message_id,direction,text,ts,media_json,author FROM
    (SELECT rowid AS source_order,message_id,direction,text,ts,media_json,author FROM message
      WHERE person_id=? AND channel=? ORDER BY ts DESC, rowid DESC LIMIT ?)
    ORDER BY ts ASC, source_order ASC`).all(personId, channel, limit)
}

// ---------- mídia / transcrição de áudio ----------
export function setMessageMedia(messageId, media) {
  db().prepare(`UPDATE message SET media_json=? WHERE message_id=?`).run(media ? JSON.stringify(media) : null, messageId)
}
// Áudios já baixados e ainda não transcritos (status 'pending'), mais novos primeiro.
export function pendingAudioMessages(limit = 4) {
  return db().prepare(`SELECT message_id, person_id, media_json FROM message
    WHERE media_json LIKE '%"kind":"audio"%' AND media_json LIKE '%"status":"pending"%'
    ORDER BY ts DESC LIMIT ?`).all(limit)
}

// ---------- Instagram: lista de conversas (thread_id = chave canônica) ----------
export function upsertIgChat({ accountKey, threadId, name, username, avatar, lastText, lastTs, unread }) {
  const unreadValue = unread == null ? null : Math.max(0, Math.floor(Number(unread) || 0))
  db().prepare(`INSERT INTO ig_chat(account_key,thread_id,name,username,avatar,last_text,last_ts,unread,updated_at)
    VALUES(@ak,@tid,@name,@un,@av,@lt,@lts,@unr,@t)
    ON CONFLICT(account_key,thread_id) DO UPDATE SET
      name=COALESCE(@name,name), username=COALESCE(@un,username), avatar=COALESCE(@av,avatar),
      last_text=COALESCE(@lt,last_text), last_ts=MAX(COALESCE(last_ts,0),COALESCE(@lts,0)),
      unread=COALESCE(@unr,unread), updated_at=@t`)
    .run({ ak: accountKey, tid: threadId, name: name || null, un: username || null, av: avatar || null,
      lt: lastText || null, lts: lastTs || 0, unr: unreadValue, t: now() })
}
export function igChatSetApiId(accountKey, threadId, apiThreadId) {
  db().prepare(`UPDATE ig_chat SET api_thread_id=? WHERE account_key=? AND thread_id=?`).run(String(apiThreadId), accountKey, threadId)
}
export function igChatPorUsername(accountKey, username) {
  if (!username) return null
  return db().prepare(`SELECT * FROM ig_chat WHERE account_key=? AND lower(username)=lower(?)`).get(accountKey, String(username).replace(/^@/, '')) || null
}
export function igChatPorApiId(accountKey, apiThreadId) {
  if (!apiThreadId) return null
  return db().prepare(`SELECT * FROM ig_chat WHERE account_key=? AND api_thread_id=?`).get(accountKey, String(apiThreadId)) || null
}
export function igChats(accountKey) { return db().prepare(`SELECT * FROM ig_chat WHERE account_key=? ORDER BY last_ts DESC`).all(accountKey) }
export function getIgChat(accountKey, threadId) { return db().prepare(`SELECT * FROM ig_chat WHERE account_key=? AND thread_id=?`).get(accountKey, threadId) || null }
export function igChatSetMode(accountKey, threadId, mode) { db().prepare(`UPDATE ig_chat SET mode=? WHERE account_key=? AND thread_id=?`).run(mode || null, accountKey, threadId) }
export function igChatSetAdopted(accountKey, threadId, val) { db().prepare(`UPDATE ig_chat SET adopted=? WHERE account_key=? AND thread_id=?`).run(val ? 1 : 0, accountKey, threadId) }
export function igChatMarkRead(accountKey, threadId) { db().prepare(`UPDATE ig_chat SET unread=0 WHERE account_key=? AND thread_id=?`).run(accountKey, threadId) }
// Atualização AUTORITATIVA vinda do inbox ao vivo: seta last_ts/last_text/unread DIRETO
// (sem o MAX do upsert), porque o tempo real do inbox pode ser "mais antigo" que o
// timestamp inflado que estava salvo. É o que deixa a lista com hora certa e realtime.
export function igChatTouch(accountKey, threadId, { lastText, lastTs, unread } = {}) {
  const unreadValue = unread == null ? null : Math.max(0, Math.floor(Number(unread) || 0))
  db().prepare(`UPDATE ig_chat SET
      last_text=COALESCE(?,last_text), last_ts=COALESCE(?,last_ts),
      unread=COALESCE(?,unread), updated_at=?
    WHERE account_key=? AND thread_id=?`)
    .run(lastText ?? null, lastTs ?? null, unreadValue, now(), accountKey, threadId)
}
// Instagram DOM não dá id/timestamp estável por mensagem: a cada sync de uma thread
// substituímos as mensagens dela (replace) pelo que o DOM mostra. Simples e consistente.
export function deleteChannelMessages(personId, channel) { db().prepare(`DELETE FROM message WHERE person_id=? AND channel=?`).run(personId, channel) }

// ---------- Instagram: interpretação de mídia (descrição keyed por URL sem query) ----------
export const igMediaKey = (src) => String(src || '').split('?')[0]
// Registra uma mídia vista (pendente de interpretar). Não sobrescreve descrição já feita.
export function registerIgMedia({ accountKey, src, kind, personId = null, threadId = null }) {
  const mkey = igMediaKey(src); if (!mkey) return
  db().prepare(`INSERT INTO ig_media(mkey,account_key,kind,src,person_id,thread_id,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)
    ON CONFLICT(mkey) DO UPDATE SET src=excluded.src, kind=COALESCE(excluded.kind,kind),
      person_id=COALESCE(excluded.person_id,person_id), thread_id=COALESCE(excluded.thread_id,thread_id)`)
    .run(mkey, accountKey, kind || 'imagem', src, personId, threadId, now())
}
export function pendingIgMedia(accountKey, limit = 3) {
  return db().prepare(`SELECT * FROM ig_media WHERE account_key=? AND status='pending' ORDER BY created_at DESC LIMIT ?`).all(accountKey, limit)
}
export function setIgMediaResult(mkey, { description, transcript, status = 'done' } = {}) {
  db().prepare(`UPDATE ig_media SET description=?, transcript=?, status=?, done_at=? WHERE mkey=?`).run(description || null, transcript || null, status, now(), mkey)
}
// Descrição pronta pra uma mídia (pelo src). null se ainda não interpretada.
export function igMediaDescription(src) {
  const r = db().prepare(`SELECT description FROM ig_media WHERE mkey=? AND status='done'`).get(igMediaKey(src))
  return r?.description || null
}
export function countChannelMessages(personId, channel) { return db().prepare(`SELECT COUNT(*) n FROM message WHERE person_id=? AND channel=?`).get(personId, channel).n }

// ---------- Enquetes do WhatsApp (guardar a que mandamos pra decifrar o voto) ----------
export function saveWaPoll({ msgId, accountKey, personId, jid, question, options, encKey, creatorJid, multipla }) {
  db().prepare(`INSERT OR REPLACE INTO wa_poll(msg_id,account_key,person_id,jid,question,options_json,enc_key,creator_jid,multipla,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(msgId, accountKey, personId, jid, question, JSON.stringify(options || []), encKey, creatorJid, multipla ? 1 : 0, now())
}
export function getWaPoll(msgId) { return db().prepare(`SELECT * FROM wa_poll WHERE msg_id=?`).get(msgId) }
export function markWaPollAnswered(msgId) { db().prepare(`UPDATE wa_poll SET answered_at=? WHERE msg_id=?`).run(now(), msgId) }

// ---------- Badoo: conversas ----------
export function upsertBadooChat({ accountKey, chatId, name, previa, foto, lastTs, unread }) {
  db().prepare(`INSERT INTO badoo_chat(account_key,chat_id,name,previa,foto,last_ts,unread,updated_at)
    VALUES(@ak,@id,@n,@p,@f,@ts,@u,@t)
    ON CONFLICT(account_key,chat_id) DO UPDATE SET
      name=COALESCE(@n,name), previa=COALESCE(@p,previa), foto=COALESCE(@f,foto),
      last_ts=MAX(COALESCE(last_ts,0),COALESCE(@ts,0)),
      unread=COALESCE(@u,unread), updated_at=@t`)
    .run({ ak: accountKey, id: chatId, n: name || null, p: previa || null, f: foto || null,
      ts: lastTs || 0, u: unread == null ? null : (unread ? 1 : 0), t: now() })
}
export function badooChats(accountKey) {
  return db().prepare(`SELECT * FROM badoo_chat WHERE account_key=? ORDER BY last_ts DESC`).all(accountKey)
}
export function getBadooChat(accountKey, chatId) {
  return db().prepare(`SELECT * FROM badoo_chat WHERE account_key=? AND chat_id=?`).get(accountKey, chatId) || null
}
export function badooChatSetMode(accountKey, chatId, mode) {
  db().prepare(`UPDATE badoo_chat SET mode=? WHERE account_key=? AND chat_id=?`).run(mode || null, accountKey, chatId)
}
export function badooChatMarkRead(accountKey, chatId) {
  db().prepare(`UPDATE badoo_chat SET unread=0 WHERE account_key=? AND chat_id=?`).run(accountKey, chatId)
}

// ---------- settings + diário ----------
export function getSetting(key, def = null) { const r = db().prepare(`SELECT value FROM setting WHERE key=?`).get(key); return r ? JSON.parse(r.value) : def }
export function setSetting(key, value) { db().prepare(`INSERT INTO setting(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(value)) }
export function logEvent({ type, personId, channel, detail }) {
  const r = db().prepare(`INSERT INTO event(ts,type,person_id,channel,detail) VALUES(?,?,?,?,?)`).run(now(), type, personId || null, channel || null, typeof detail === 'string' ? detail : JSON.stringify(detail || {}))
  return Number(r.lastInsertRowid)
}
export function recentEvents(limit = 100) { return db().prepare(`SELECT * FROM event ORDER BY id DESC LIMIT ?`).all(limit) }

// ---------- monitor do WhatsApp (sinais que não são mensagem) ----------
export function logMonitor({ accountKey, kind, jid, name, summary, detail }) {
  db().prepare(`INSERT INTO wa_monitor(account_key,ts,kind,jid,name,summary,detail) VALUES(?,?,?,?,?,?,?)`)
    .run(accountKey || 'main', now(), kind, jid || null, name || null, summary || null,
      detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)))
}
export function recentMonitor(accountKey, { limit = 200, kind = null } = {}) {
  const sql = `SELECT * FROM wa_monitor WHERE account_key=?` + (kind ? ` AND kind=?` : ``) + ` ORDER BY id DESC LIMIT ?`
  return kind ? db().prepare(sql).all(accountKey, kind, limit) : db().prepare(sql).all(accountKey, limit)
}
// Texto de uma mensagem do WhatsApp já guardada, pelo id do provedor (key.id do baileys).
// Usado pra recuperar o CONTEÚDO de uma mensagem que foi apagada (revoke).
export function waMessageText(keyId) {
  if (!keyId) return null
  const r = db().prepare(`SELECT text FROM message WHERE message_id=? AND channel='whatsapp'`).get('wa:' + keyId)
  return r?.text || null
}

// ---------- agenda: propostas + varredura ----------
export function personDisplayName(personId) {
  const p = db().prepare(`SELECT display_name FROM person WHERE person_id=?`).get(personId)
  if (p?.display_name) return p.display_name
  const t = db().prepare(`SELECT name FROM tinder_match WHERE person_id=? AND name IS NOT NULL LIMIT 1`).get(personId)
  if (t?.name) return t.name
  if (String(personId).startsWith('wa:')) {
    const w = db().prepare(`SELECT name FROM wa_chat WHERE jid=? AND name IS NOT NULL LIMIT 1`).get(String(personId).slice(3))
    if (w?.name) return w.name
  }
  return null
}
// Pessoas com mensagem RECEBIDA depois de sinceTs, com o canal da última recebida.
export function peopleWithRecentIncoming(sinceTs, limit = 40) {
  return db().prepare(`SELECT m.person_id, m.channel, m.ts AS last_ts FROM message m
    JOIN (SELECT person_id, MAX(ts) AS mx FROM message WHERE direction='incoming' AND ts>? GROUP BY person_id) g
      ON g.person_id=m.person_id AND g.mx=m.ts
    ORDER BY last_ts DESC LIMIT ?`).all(sinceTs, limit)
}
export function getAgendaScan(personId) { return db().prepare(`SELECT last_ts FROM agenda_scan WHERE person_id=?`).get(personId)?.last_ts || 0 }
export function setAgendaScan(personId, ts) {
  db().prepare(`INSERT INTO agenda_scan(person_id,last_ts,updated_at) VALUES(?,?,?)
    ON CONFLICT(person_id) DO UPDATE SET last_ts=excluded.last_ts, updated_at=excluded.updated_at`).run(personId, ts || 0, now())
}
export function agendaProposalSeen(fp) { return !!db().prepare(`SELECT 1 FROM agenda_proposal WHERE fp=?`).get(fp) }
// Já existe proposta pra ESTA pessoa perto DESTE horário? (qualquer status: pendente,
// criada ou rejeitada). É a trava anti-duplicata: independe do título (que a IA varia),
// então o mesmo compromisso re-detectado não vira 2 propostas. Janela = tolerância.
export function agendaProposalNear(accountKey, personId, startMs, windowMs = 1800000) {
  return db().prepare(`SELECT id, title, confidence FROM agenda_proposal
    WHERE account_key=? AND person_id=? AND ABS(starts_at - ?) <= ? ORDER BY confidence DESC LIMIT 1`)
    .get(accountKey, personId, startMs, windowMs) || null
}
export function addAgendaProposal(p) {
  db().prepare(`INSERT INTO agenda_proposal(id,account_key,person_id,channel,title,starts_at,ends_at,with_person,confidence,source_quote,fp,status,project_id,created_at)
    VALUES(@id,@ak,@pid,@ch,@ti,@sa,@ea,@wp,@cf,@sq,@fp,'pending',@prj,@t)`)
    .run({ id: p.id, ak: p.accountKey, pid: p.personId, ch: p.channel, ti: p.title, sa: p.startsAt, ea: p.endsAt || null,
      wp: p.withPerson || null, cf: p.confidence || 0, sq: p.sourceQuote || null, fp: p.fp, prj: p.projectId || null, t: now() })
}
export function pendingAgendaProposals(accountKey) {
  return db().prepare(`SELECT * FROM agenda_proposal WHERE account_key=? AND status='pending' ORDER BY created_at DESC`).all(accountKey)
}
export function getAgendaProposal(id) { return db().prepare(`SELECT * FROM agenda_proposal WHERE id=?`).get(id) || null }
export function resolveAgendaProposal(id, status, { googleEventId, googleHtmlLink } = {}) {
  db().prepare(`UPDATE agenda_proposal SET status=?, google_event_id=?, google_html_link=?, resolved_at=? WHERE id=?`)
    .run(status, googleEventId || null, googleHtmlLink || null, now(), id)
}

// ---------- áudios salvos (biblioteca de notas de voz do dono) ----------
// Slug do título pro atalho "/": minúsculas, sem acento, só [a-z0-9-]. Colisão resolve
// com sufixo -2, -3… (o UNIQUE do shortcut é a última linha de defesa). Nunca vazio.
export function slugifyShortcut(title) {
  const base = String(title || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return base || 'audio'
}
export function uniqueShortcut(title, exceptId = null) {
  const base = slugifyShortcut(title)
  let candidate = base
  for (let i = 2; i < 1000; i++) {
    const row = db().prepare(`SELECT id FROM saved_audio WHERE shortcut=?`).get(candidate)
    if (!row || row.id === exceptId) return candidate
    candidate = `${base}-${i}`
  }
  return `${base}-${Date.now()}`
}
// Lista os áudios. activeOnly=true para o picker/IA; ordem: mais usados e mais recentes.
export function listSavedAudios({ activeOnly = false } = {}) {
  const sql = `SELECT * FROM saved_audio` + (activeOnly ? ` WHERE active=1` : ``)
    + ` ORDER BY usage_count DESC, created_at DESC`
  return db().prepare(sql).all()
}
export function getSavedAudio(id) { return db().prepare(`SELECT * FROM saved_audio WHERE id=?`).get(id) || null }
export function getSavedAudioByShortcut(slug) { return db().prepare(`SELECT * FROM saved_audio WHERE shortcut=? AND active=1`).get(slug) || null }
export function insertSavedAudio({ id, title, shortcut, descricao, file, durationSec, sizeBytes }) {
  db().prepare(`INSERT INTO saved_audio(id,title,shortcut,descricao,file,duration_sec,size_bytes,transcript,transcript_status,active,usage_count,created_at)
    VALUES(@id,@ti,@sc,@de,@fi,@du,@sz,NULL,'pending',1,0,@t)`)
    .run({ id, ti: title || null, sc: shortcut, de: descricao || null, fi: file, du: durationSec || 0, sz: sizeBytes || 0, t: now() })
  return getSavedAudio(id)
}
// Edita metadados (title/shortcut/descricao/active). Só troca o que veio definido —
// undefined preserva o valor atual. Retorna a linha atualizada.
export function updateSavedAudioMeta(id, { title, shortcut, descricao, active } = {}) {
  const cur = getSavedAudio(id)
  if (!cur) return null
  db().prepare(`UPDATE saved_audio SET title=@ti, shortcut=@sc, descricao=@de, active=@ac WHERE id=@id`)
    .run({ id,
      ti: title !== undefined ? (title || null) : cur.title,
      sc: shortcut !== undefined ? shortcut : cur.shortcut,
      de: descricao !== undefined ? (descricao || null) : cur.descricao,
      ac: active !== undefined ? (active ? 1 : 0) : cur.active })
  return getSavedAudio(id)
}
export function bumpSavedAudioUsage(id) {
  db().prepare(`UPDATE saved_audio SET usage_count=usage_count+1, last_used_at=? WHERE id=?`).run(now(), id)
}
export function setSavedAudioTranscript(id, { transcript, status }) {
  db().prepare(`UPDATE saved_audio SET transcript=?, transcript_status=? WHERE id=?`).run(transcript ?? null, status || 'done', id)
}

// ---------- auto-deslizar (docs/TINDER-DESCOBERTA.md) ----------

// Já deslizamos nessa pessoa? `enviado: true` pergunta só pelo que FOI PRO TINDER — é a
// trava de idempotência de verdade. Decisão de modo sombra (sent_at null) não queima a
// pessoa: se queimasse, todo mundo julgado em teste ficaria fora do envio pra sempre.
export function swipeSeen(userId, { enviado = false } = {}) {
  const sql = enviado ? `SELECT 1 FROM swipe WHERE user_id=? AND sent_at IS NOT NULL` : `SELECT 1 FROM swipe WHERE user_id=?`
  return !!db().prepare(sql).get(userId)
}

// Grava a decisão ANTES de mandar pro Tinder. Regrava por cima quando a linha existente
// ainda não foi enviada (critério pode ter mudado desde o modo sombra). Devolve false
// quando a pessoa JÁ FOI DESLIZADA de verdade — aí o chamador não envia nada.
export function recordSwipe({ userId, name, age, distance, decision, reason, layer, score, source, sessionId, payload }) {
  const r = db().prepare(`INSERT INTO swipe
    (user_id,name,age,distance,decision,reason,layer,score,source,session_id,decided_at,payload)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      name=excluded.name, age=excluded.age, distance=excluded.distance, decision=excluded.decision,
      reason=excluded.reason, layer=excluded.layer, score=excluded.score, source=excluded.source,
      session_id=excluded.session_id, decided_at=excluded.decided_at, payload=excluded.payload
    WHERE swipe.sent_at IS NULL`).run(
    userId, name || null, age ?? null, distance ?? null, decision, reason || null, layer || null,
    score ?? null, source || null, sessionId || null, now(), payload ? JSON.stringify(payload) : null)
  return r.changes > 0
}

// Carimba o comprovante do envio (o que separa "decidido" de "entregue").
export function markSwipeSent(userId, { httpStatus, matched } = {}) {
  db().prepare(`UPDATE swipe SET sent_at=?, http_status=?, matched=? WHERE user_id=?`)
    .run(now(), httpStatus ?? null, matched ? 1 : 0, userId)
}

export function listSwipes({ limit = 200, sessionId = null, decision = null, sentOnly = false } = {}) {
  const cond = ['1=1']
  const args = []
  if (sessionId) { cond.push('session_id=?'); args.push(sessionId) }
  if (decision) { cond.push('decision=?'); args.push(decision) }
  if (sentOnly) cond.push('sent_at IS NOT NULL')
  args.push(limit)
  return db().prepare(`SELECT * FROM swipe WHERE ${cond.join(' AND ')} ORDER BY decided_at DESC LIMIT ?`).all(...args)
}

// Contagem para os tetos diários. Conta só o que foi REALMENTE enviado.
export function swipeCountsSince(ts) {
  const r = db().prepare(`SELECT count(*) n, sum(decision='like') likes FROM swipe WHERE sent_at IS NOT NULL AND sent_at>=?`).get(ts)
  return { swipes: r?.n || 0, likes: r?.likes || 0 }
}

export function startSwipeSession({ id, planned, city, mode }) {
  db().prepare(`INSERT INTO swipe_session(id,started_at,planned,city,mode) VALUES(?,?,?,?,?)`).run(id, now(), planned, city || null, mode || 'sombra')
  return id
}
export function endSwipeSession(id, { done, likes, reason } = {}) {
  db().prepare(`UPDATE swipe_session SET ended_at=?, done=?, likes=?, ended_reason=? WHERE id=?`).run(now(), done ?? 0, likes ?? 0, reason || null, id)
}
export function listSwipeSessions(limit = 30) {
  return db().prepare(`SELECT * FROM swipe_session ORDER BY started_at DESC LIMIT ?`).all(limit)
}

// ---------- assistente pessoal (chat do dono com o vendas-multicanal) ----------
// Um id por milissegundo colide (foi o bug do addSendVerdict); aqui o id leva sufixo
// aleatório curto, então dois registros no mesmo ms não se atropelam.
function idUnico(prefixo) { return `${prefixo}:${now().toString(36)}:${Math.random().toString(36).slice(2, 8)}` }

export function addAssistMsg({ papel, origem, texto, waMsgId = null, acoes = null, ts = null }) {
  const id = idUnico('am')
  db().prepare(`INSERT INTO assistente_msg(id,ts,papel,origem,texto,wa_msg_id,acoes) VALUES(?,?,?,?,?,?,?)`)
    .run(id, ts || now(), papel, origem, String(texto || ''), waMsgId || null, acoes ? JSON.stringify(acoes) : null)
  return id
}
export function assistMsgs(limit = 40) {
  return db().prepare(`SELECT * FROM assistente_msg ORDER BY ts DESC, rowid DESC LIMIT ?`).all(limit).reverse()
}
// A trava anti-eco: esta mensagem do WhatsApp foi enviada por NÓS?
// papel='vendas-multicanal' é load-bearing: as mensagens DELE também são gravadas com o id do WhatsApp
// (pra não reprocessar em duplicidade), e sem esse filtro a própria pergunta dele seria
// classificada como eco nosso — o assistente ficaria mudo.
export function assistMsgByWaId(waMsgId) {
  if (!waMsgId) return null
  return db().prepare(`SELECT * FROM assistente_msg WHERE wa_msg_id=? AND papel='vendas-multicanal'`).get(String(waMsgId)) || null
}
// Já processamos esta mensagem do WhatsApp (dele ou nossa)? Trava de reentrância: o
// baileys reentrega o mesmo upsert em reconexão, e responder duas vezes seria pior que
// não responder.
export function assistJaViu(waMsgId) {
  if (!waMsgId) return false
  return !!db().prepare(`SELECT 1 FROM assistente_msg WHERE wa_msg_id=? LIMIT 1`).get(String(waMsgId))
}
// Segundo cinto: texto igual saído de nós numa janela recente (caso o id não bata).
export function assistEnviouTextoRecente(texto, janelaMs = 15 * 60 * 1000) {
  const t = String(texto || '').trim()
  if (!t) return false
  return !!db().prepare(`SELECT 1 FROM assistente_msg WHERE papel='vendas-multicanal' AND texto=? AND ts>=? LIMIT 1`).get(t, now() - janelaMs)
}
// Terceiro cinto (disjuntor): quantas respostas nossas saíram na última janela.
export function assistRespostasDesde(ts) {
  return db().prepare(`SELECT count(*) n FROM assistente_msg WHERE papel='vendas-multicanal' AND ts>=?`).get(ts)?.n || 0
}

export function addAssistAcao({ msgId, nome, args, nivel, estado = 'feita', resumo = null, resultado = null, desfazer = null, erro = null }) {
  const id = idUnico('ac')
  db().prepare(`INSERT INTO assistente_acao(id,ts,msg_id,nome,args,nivel,estado,resumo,resultado,desfazer,erro)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, now(), msgId || null, nome, JSON.stringify(args || {}), nivel || null,
    estado, resumo || null, resultado ? JSON.stringify(resultado) : null, desfazer ? JSON.stringify(desfazer) : null, erro || null)
  return id
}
export function getAssistAcao(id) { return db().prepare(`SELECT * FROM assistente_acao WHERE id=?`).get(id) || null }
export function setAssistAcaoEstado(id, estado, extra = {}) {
  const a = getAssistAcao(id); if (!a) return null
  db().prepare(`UPDATE assistente_acao SET estado=?, erro=COALESCE(?,erro), resultado=COALESCE(?,resultado), desfeita_em=? WHERE id=?`)
    .run(estado, extra.erro || null, extra.resultado ? JSON.stringify(extra.resultado) : null, estado === 'desfeita' ? now() : (a.desfeita_em || null), id)
  return getAssistAcao(id)
}
export function assistAcoes({ limit = 40, estado = null } = {}) {
  return estado
    ? db().prepare(`SELECT * FROM assistente_acao WHERE estado=? ORDER BY ts DESC LIMIT ?`).all(estado, limit)
    : db().prepare(`SELECT * FROM assistente_acao ORDER BY ts DESC LIMIT ?`).all(limit)
}
// A última ação que ainda dá pra desfazer (tem plano de desfazer e está feita).
export function ultimaAcaoDesfazivel() {
  return db().prepare(`SELECT * FROM assistente_acao WHERE estado='feita' AND desfazer IS NOT NULL ORDER BY ts DESC LIMIT 1`).get() || null
}
export function acoesDaMensagem(msgId) {
  return db().prepare(`SELECT * FROM assistente_acao WHERE msg_id=? ORDER BY ts ASC`).all(msgId)
}

// ---------- aviso antecipado de compromisso da agenda ----------
// "Já avisei deste?" é por evento E por horário: remarcar o compromisso reabre o aviso, senão
// mover a reunião das 15h pras 18h herdava o "já avisado" e o aviso das 17h50 nunca sairia.
export function agendaAvisoJaFeito(eventId, startMs) {
  const r = db().prepare(`SELECT start_ms FROM agenda_aviso WHERE event_id=?`).get(String(eventId))
  return !!r && Number(r.start_ms) === Number(startMs)
}
export function marcarAgendaAviso(eventId, startMs, quando = now()) {
  db().prepare(`INSERT INTO agenda_aviso(event_id,start_ms,fired_at) VALUES(?,?,?)
    ON CONFLICT(event_id) DO UPDATE SET start_ms=excluded.start_ms, fired_at=excluded.fired_at`)
    .run(String(eventId), Number(startMs) || 0, quando)
}
// Compromisso de ontem não precisa de linha. Sem isto a tabela cresceria pra sempre.
export function limparAgendaAvisos(antesDe = now() - 2 * 86400000) {
  return db().prepare(`DELETE FROM agenda_aviso WHERE start_ms < ?`).run(antesDe).changes
}

export function addPermissao({ tipo, alvo, motivo }) {
  const id = idUnico('pm')
  db().prepare(`INSERT INTO assistente_permissao(id,ts,tipo,alvo,motivo,estado) VALUES(?,?,?,?,?,'pendente')`)
    .run(id, now(), tipo, String(alvo || ''), motivo || null)
  return id
}
export function getPermissao(id) { return db().prepare(`SELECT * FROM assistente_permissao WHERE id=?`).get(id) || null }
export function permissoesPendentes() {
  return db().prepare(`SELECT * FROM assistente_permissao WHERE estado='pendente' ORDER BY ts DESC`).all()
}
export function decidirPermissao(id, estado, saida = null) {
  db().prepare(`UPDATE assistente_permissao SET estado=?, decidido_em=?, saida=COALESCE(?,saida) WHERE id=?`).run(estado, now(), saida, id)
  return getPermissao(id)
}

// ---------------------------------------------------------------- convite de rede
// Registra que a IA passou o contato da dona pra esta pessoa. Idempotente por (pessoa,canal):
// convidar duas vezes não cria duas linhas, só atualiza a hora.
export function registrarConvite({ personId, canal, contato, sourceChannel = null, sourceMessageId = null, quote = null, ts = null }) {
  if (!personId || !canal) return false
  const quando = Number(ts) || now()
  const atual = db().prepare(`SELECT ts,contato,source_channel,source_message_id,quote FROM convite_rede
    WHERE person_id=? AND canal=?`).get(personId, canal)
  // A varredura histórica anda do antigo pro novo, mas esta trava torna a função segura
  // mesmo se um adaptador entregar eventos fora de ordem: convite velho nunca apaga o novo.
  if (atual && Number(atual.ts || 0) > quando) return false
  if (atual && Number(atual.ts || 0) === quando && atual.contato === (contato || null)
    && atual.source_channel === (sourceChannel || null) && atual.source_message_id === (sourceMessageId || null)
    && atual.quote === (quote || null)) return false
  db().prepare(`INSERT INTO convite_rede(person_id,canal,contato,ts,source_channel,source_message_id,quote)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(person_id,canal) DO UPDATE SET
      contato=excluded.contato, ts=excluded.ts, source_channel=excluded.source_channel,
      source_message_id=excluded.source_message_id, quote=excluded.quote`)
    .run(personId, canal, contato || null, quando, sourceChannel || null, sourceMessageId || null, quote || null)
  return true
}
// Convites de um canal, mais recentes primeiro. `desde` corta por idade: uma conversa nova
// hoje não se explica por um convite de três semanas atrás.
export function convitesDoCanal(canal, { desde = 0, limite = 50 } = {}) {
  return db().prepare(`SELECT person_id, canal, contato, ts, source_channel, source_message_id, quote FROM convite_rede
    WHERE canal=? AND ts>=? ORDER BY ts DESC LIMIT ?`).all(canal, desde || 0, limite)
}

// ---------- banco de fotos (irmão do saved_audio; ver o CREATE TABLE lá em cima) ----------
//
// OS NÍVEIS DA FOTO (15/08/2026). Antes eram dois — 'livre' e 'travada' — e isso não dava
// conta da vida real de quem trabalha com isso: a mesma biblioteca guarda selfie vestida,
// foto de lingerie e foto com o FILHO. Sem separar, ou a IA não manda nada, ou manda o que
// não devia.
//
//   livre    — vestida, mostrável a qualquer um. A IA manda quando pedirem foto.
//   quente   — sensual/lingerie. Só sai quando a conversa já é disso (etiqueta que abre).
//   familia  — tem criança na foto. NUNCA sai por automação, em nenhuma hipótese, e nunca
//              chega ao contexto da IA. É a regra de colisão criança+atração vista do outro
//              lado: lá o texto, aqui a imagem. Ver `licoes/ia-nunca-perto-de-crianca`.
//   travada  — não usar, sem motivo declarado (o antigo "não manda isso").
export const NIVEIS_FOTO = ['livre', 'quente', 'familia', 'travada']
export const NIVEIS_ENVIAVEIS_PELA_IA = ['livre', 'quente']
const nivelValido = (v, padrao = 'livre') => (NIVEIS_FOTO.includes(String(v || '')) ? String(v) : padrao)
export function listSavedImages({ activeOnly = false, apenasLivres = false, niveis = null } = {}) {
  const cond = []
  if (activeOnly) cond.push('active=1')
  if (apenasLivres) cond.push(`nivel='livre'`)
  if (Array.isArray(niveis) && niveis.length) {
    cond.push(`nivel IN (${niveis.filter((n) => NIVEIS_FOTO.includes(n)).map((n) => `'${n}'`).join(',') || `'nenhum'`})`)
  }
  const sql = `SELECT * FROM saved_image` + (cond.length ? ` WHERE ${cond.join(' AND ')}` : ``)
    + ` ORDER BY usage_count DESC, created_at DESC`
  return db().prepare(sql).all()
}
export function getSavedImage(id) { return db().prepare(`SELECT * FROM saved_image WHERE id=?`).get(id) || null }
// Só devolve foto ATIVA e LIVRE: é este o caminho que o envio automático usa, e a trava do
// nível tem que valer no CÓDIGO, não só na ausência dela no prompt. Um rascunho gerado antes
// de a foto virar 'travada' ainda carregaria o marcador — e aqui ele morre.
export function getSavedImageByShortcut(slug, { permitirQuente = false } = {}) {
  const niveis = permitirQuente ? NIVEIS_ENVIAVEIS_PELA_IA : ['livre']
  const marcas = niveis.map(() => '?').join(',')
  // `familia` e `travada` NUNCA entram nesta lista: é a trava de código, não de prompt. Um
  // rascunho gerado antes de a foto mudar de nível ainda carregaria o marcador — e morre aqui.
  return db().prepare(`SELECT * FROM saved_image WHERE shortcut=? AND active=1 AND nivel IN (${marcas})`).get(slug, ...niveis) || null
}
// Busca sem filtro de nível: para o painel, onde quem manda é o dono.
export function getSavedImageByShortcutQualquer(slug) {
  return db().prepare(`SELECT * FROM saved_image WHERE shortcut=?`).get(slug) || null
}
export function insertSavedImage({ id, title, shortcut, descricao, contexto, file, width, height, sizeBytes, nivel, sha }) {
  db().prepare(`INSERT INTO saved_image(id,title,shortcut,descricao,contexto,file,width,height,size_bytes,nivel,sha,active,usage_count,created_at)
    VALUES(@id,@ti,@sc,@de,@ctx,@fi,@w,@h,@sz,@nv,@sha,1,0,@t)`)
    .run({ id, ti: title || null, sc: shortcut, de: descricao || null, ctx: contexto || null, fi: file,
      w: width || 0, h: height || 0, sz: sizeBytes || 0, nv: nivelValido(nivel), sha: sha || null, t: now() })
  return getSavedImage(id)
}
// A MESMA IMAGEM já está no banco? Casa por conteúdo, não por nome: nome é escolha de quem
// salvou, conteúdo é o que a pessoa do outro lado recebe.
export function getSavedImageBySha(sha) {
  if (!sha) return null
  return db().prepare(`SELECT * FROM saved_image WHERE sha=?`).get(sha) || null
}
export function updateSavedImageMeta(id, { title, shortcut, descricao, contexto, active, nivel } = {}) {
  const cur = getSavedImage(id)
  if (!cur) return null
  db().prepare(`UPDATE saved_image SET title=@ti, shortcut=@sc, descricao=@de, contexto=@ctx, active=@ac, nivel=@nv WHERE id=@id`)
    .run({ id,
      ctx: contexto !== undefined ? (contexto || null) : cur.contexto,
      ti: title !== undefined ? (title || null) : cur.title,
      sc: shortcut !== undefined ? shortcut : cur.shortcut,
      de: descricao !== undefined ? (descricao || null) : cur.descricao,
      ac: active !== undefined ? (active ? 1 : 0) : cur.active,
      nv: nivel !== undefined ? nivelValido(nivel, cur.nivel) : cur.nivel })
  return getSavedImage(id)
}
export function bumpSavedImageUsage(id) {
  db().prepare(`UPDATE saved_image SET usage_count=usage_count+1, last_used_at=? WHERE id=?`).run(now(), id)
}
// Atalho único DENTRO DAS FOTOS. Espelha `uniqueShortcut` (que só olha os áudios): as duas
// tabelas têm namespaces separados de propósito — o marcador que a IA escreve diz o tipo
// (`[foto:slug]` x `[audio:slug]`), então um `/praia` de foto e um `/praia` de áudio nunca se
// confundem. Até hoje só o importador de pasta criava foto, e ele resolvia colisão sozinho;
// com upload pelo painel isso precisa existir no banco, perto do UNIQUE que é a defesa final.
export function uniqueImageShortcut(title, exceptId = null) {
  const base = slugifyShortcut(title) === 'audio' ? 'foto' : slugifyShortcut(title)
  let candidate = base
  for (let i = 2; i < 1000; i++) {
    const row = db().prepare(`SELECT id FROM saved_image WHERE shortcut=?`).get(candidate)
    if (!row || row.id === exceptId) return candidate
    candidate = `${base}-${i}`
  }
  return `${base}-${Date.now()}`
}

// ---------- Telegram: conversas ----------
export function upsertTelegramChat({ accountKey, chatId, nome, username, telefone, previa, lastTs, unread }) {
  db().prepare(`INSERT INTO telegram_chat(account_key,chat_id,nome,username,telefone,previa,last_ts,unread,updated_at)
    VALUES(@ak,@id,@no,@un,@tel,@pv,@ts,@ur,@t)
    ON CONFLICT(account_key,chat_id) DO UPDATE SET
      nome=COALESCE(@no,nome), username=COALESCE(@un,username), telefone=COALESCE(@tel,telefone),
      previa=COALESCE(@pv,previa), last_ts=MAX(COALESCE(last_ts,0),COALESCE(@ts,0)),
      unread=COALESCE(@ur,unread), updated_at=@t`)
    .run({ ak: accountKey, id: String(chatId), no: nome || null, un: username || null, tel: telefone || null,
      pv: previa || null, ts: lastTs || 0, ur: unread == null ? null : Math.max(0, Number(unread) || 0), t: now() })
}
export function telegramChats(accountKey) {
  return db().prepare(`SELECT * FROM telegram_chat WHERE account_key=? ORDER BY last_ts DESC`).all(accountKey)
}
export function getTelegramChat(accountKey, chatId) {
  return db().prepare(`SELECT * FROM telegram_chat WHERE account_key=? AND chat_id=?`).get(accountKey, String(chatId)) || null
}
export function telegramChatSetMode(accountKey, chatId, mode) {
  db().prepare(`UPDATE telegram_chat SET mode=? WHERE account_key=? AND chat_id=?`).run(mode || null, accountKey, String(chatId))
}

// ---------- Meu Patrocínio: conversas ----------
export function upsertMpChat({ accountKey, peerId, conversationId, nome, foto, previa, lastTs, unread }) {
  db().prepare(`INSERT INTO mp_chat(account_key,peer_id,conversation_id,nome,foto,previa,last_ts,unread,updated_at)
    VALUES(@ak,@pe,@co,@no,@fo,@pv,@ts,@ur,@t)
    ON CONFLICT(account_key,peer_id) DO UPDATE SET
      conversation_id=COALESCE(@co,conversation_id), nome=COALESCE(@no,nome), foto=COALESCE(@fo,foto),
      previa=COALESCE(@pv,previa), last_ts=MAX(COALESCE(last_ts,0),COALESCE(@ts,0)),
      unread=COALESCE(@ur,unread), updated_at=@t`)
    .run({ ak: accountKey, pe: String(peerId), co: conversationId == null ? null : String(conversationId),
      no: nome || null, fo: foto || null, pv: previa || null, ts: lastTs || 0,
      ur: unread == null ? null : Math.max(0, Number(unread) || 0), t: now() })
}
export function mpChats(accountKey) {
  return db().prepare(`SELECT * FROM mp_chat WHERE account_key=? ORDER BY last_ts DESC`).all(accountKey)
}
export function getMpChat(accountKey, peerId) {
  return db().prepare(`SELECT * FROM mp_chat WHERE account_key=? AND peer_id=?`).get(accountKey, String(peerId)) || null
}
