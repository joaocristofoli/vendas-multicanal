# Demonstração local pronta para gravar

Esta cópia é uma vitrine segura do Vendas Multicanal. Ela usa o painel e o banco reais do projeto, mas substitui toda ação externa por uma simulação local. Nenhuma mensagem, curtida, mídia, cobrança ou compromisso sai do computador.

Todos os nomes, telefones, conversas, perfis e imagens da base são fictícios. As imagens mostram somente adultos sintéticos e não representam pessoas reais. O PIX `demo@example.com`, os links `example.com` e as contas exibidas no painel também são exemplos sem valor operacional.

## Abrir em três passos

Requisitos: macOS, Node.js 22 ou mais recente e dependências instaladas.

```bash
cd vendas-multicanal-demo
npm ci
npm run demo
```

Abra [http://127.0.0.1:8099](http://127.0.0.1:8099) e use a senha:

```text
demo2026
```

Enquanto esse terminal estiver aberto, o painel fica disponível apenas neste computador. Para encerrar, volte ao terminal e pressione `Control+C`.

Se quiser apagar as alterações feitas durante uma gravação e voltar ao estado inicial:

```bash
npm run demo:reset
```

O reset apaga somente `data/demo.db` desta cópia demonstrativa. As imagens sintéticas são preservadas. Nunca execute esse comando na pasta do sistema principal.

## O que já vem preparado

- Tinder: cinco matches mistos, perfis completos, objetivos, conversas, pendências, IA por pessoa, modelos de primeira mensagem e histórico de swipes.
- WhatsApp: cinco conversas vinculadas, mensagens, modos de conversa, etiquetas, catálogo de fotos, áudios sintéticos e entrega simulada.
- Instagram: quatro Directs, perfis, histórico, modo de conversa, rascunho e envio simulado.
- Badoo: quatro conversas, perfis, IA, fila de curtidas, critérios, encontro/descoberta em modo sombra e envio de mídia simulado.
- Telegram: três conversas com histórico, IA e envio simulado.
- Meu Patrocínio: três conversas, serviço premium, IA e envio simulado.
- Configuração comercial: quatro serviços com preço, duração, local, folgas, palavras-gatilho, etiquetas, fotos de exemplo e itens de entrega.
- Organização: necessidades financeiras fictícias, PIX fictício, rotina semanal, disponibilidade, agenda, proposta pendente, projetos, tarefas, notas, lembretes e hábitos.
- Inteligência: memórias de pessoas, objetivos, fatos, iniciativas, interruptores de IA, Monitor e Diário preenchidos.

O selo amarelo `DEMO LOCAL · DADOS FICTÍCIOS` fica sempre visível. Os pontos verdes significam “simulação conectada”, não uma sessão real.

## Roteiro curto para o vídeo

1. Comece no Tinder e mostre os cards, filtros, indicadores verdes e uma conversa. Clique em **Gerar** e depois envie o rascunho: ele aparece imediatamente na linha do tempo.
2. Abra o WhatsApp. Mostre que uma pessoa veio do Tinder, as etiquetas, o objetivo, os modos de conversa e o histórico. Envie um texto, uma foto ou um áudio salvo.
3. Passe por Instagram, Badoo, Telegram e Meu Patrocínio. Abra uma conversa em cada rede e demonstre rascunho, IA e envio.
4. No Badoo, mostre descoberta, curtidas e modo sombra. No Tinder, abra Descoberta para ver critérios, passport, perfil e decisões.
5. Abra **Config → Grana**. Mostre PIX fictício, serviços, valores, durações, fotos de exemplo e entrega protegida.
6. Abra **Config → Fotos** e mostre os níveis livre, quente e travada. Mostre também os dois áudios sintéticos.
7. Abra Agenda, aprove uma proposta e crie um compromisso manual. Depois mostre disponibilidade e rotina.
8. Abra Projetos, conclua uma tarefa e marque um hábito. Termine no Progresso, Monitor e Diário.

## Como cada venda funciona

Uma venda deve seguir uma sequência simples e auditável:

1. Cadastre o serviço em **Config → Grana → Serviços e valores**. Informe tipo, duração, preço, local, folgas e o que será entregue.
2. Cadastre fotos em **Config → Fotos**. Use uma imagem `livre` como amostra comum; `quente` exige uma etiqueta autorizada; `travada` nunca é enviada automaticamente.
3. Ligue as amostras ao serviço. Separe **foto de exemplo** de **foto de entrega**: a primeira ajuda a vender, a segunda é o produto.
4. Na conversa, informe somente os valores cadastrados. O sistema não deve inventar preço, desconto ou prazo.
5. Se houver horário, crie uma proposta de agenda e aprove manualmente.
6. Confirme pagamento fora da automação. Somente então use **Entregar** na conversa correta e confira novamente o destinatário.

Capacidade por rede:

| Rede | Conversa e preço | Foto individual | Pacote/entrega |
|---|---:|---:|---:|
| Tinder | Sim | Não | Mude de canal somente com consentimento |
| WhatsApp | Sim | Sim | Sim: texto, link e várias fotos |
| Instagram | Sim | Sim | Entrega individual; para lote, use link privado |
| Badoo | Sim | Sim | Texto/link; lote por canal compatível |
| Telegram | Sim | Conforme a implementação da conta | Prefira link privado ou fluxo validado |
| Meu Patrocínio | Sim | Conforme a implementação da conta | Prefira link privado ou fluxo validado |

## Conectar redes reais, quando sair da demo

Faça isso somente no repositório operacional, nunca nesta demo. Use apenas contas próprias e respeite os termos das plataformas, consentimento, idade mínima, privacidade, tributação e regras locais.

### Tinder

1. Rode `npm run chrome` e faça login no Tinder no Chrome dedicado.
2. No painel, vá a **Config → Sistema → Conectar os canais**.
3. Em Tinder, clique em **Usar conta aberta no Chrome**.
4. Confirme o nome da conta e aguarde os matches aparecerem.
5. Se houver HTTP 401, a sessão expirou: faça login novamente. Não reaproveite token antigo.

### Badoo

1. Entre no Badoo pelo Chrome dedicado e abra a lista de conversas.
2. No painel, clique em **Usar conta aberta no Chrome**.
3. Mantenha o Chrome dedicado aberto: parte das ações depende da página assinada pela própria rede.
4. Se aparecer erro 9012, faça logout/login, abra novamente as mensagens e repita a importação.

### Instagram

1. Entre no Instagram pelo Chrome dedicado e abra o Direct.
2. Conclua qualquer checkpoint ou confirmação de segurança.
3. No painel, clique em **Usar conta aberta no Chrome** e confira o `@` identificado.
4. HTTP 401/403 pede novo login. HTTP 429 é limite temporário: pare de tentar e aguarde.

### WhatsApp

1. Abra a aba WhatsApp do painel e clique em **Conectar WhatsApp**.
2. No celular, abra **WhatsApp → Aparelhos conectados → Conectar aparelho**.
3. Leia o QR e aguarde o estado **WhatsApp conectado**.
4. Use **Re-parear** somente se a sessão tiver sido removida. Código 403 pode significar restrição; insistir pode piorar.

### Telegram

1. Entre em `my.telegram.org` com a conta própria e crie um aplicativo para obter `api_id` e `api_hash`.
2. Guarde-os apenas no `.env` operacional como `TIM_TG_API_ID` e `TIM_TG_API_HASH`.
3. Inicie o login pelo fluxo Telegram, informe seu número, o código recebido no aplicativo e a senha de duas etapas se existir.
4. Confirme o nome ou `@` da conta antes de sincronizar. A sessão fica no banco privado, nunca no código.

### Meu Patrocínio

1. Use a tela de conexão da instância operacional e informe email e senha da própria conta.
2. Confira o perfil retornado antes de sincronizar.
3. O sistema precisa manter separados `peer_id` (pessoa) e `conversation_id` (destino de envio). Nunca envie se o destino não tiver sido resolvido.
4. Se a rede responder 401/422, refaça o login; não publique token nem credenciais.

O guia operacional completo das integrações por navegador/QR está em [docs/CONECTAR-REDES.md](docs/CONECTAR-REDES.md). Para erros, consulte [docs/ERROS-COMUNS.md](docs/ERROS-COMUNS.md). Para comercialização, consulte [docs/VENDER-FOTOS.md](docs/VENDER-FOTOS.md) e [docs/VENDER-SERVICOS.md](docs/VENDER-SERVICOS.md).

## Limites e segurança

- A demo não testa APIs reais; ela prova interface, fluxo, banco local e comportamento esperado.
- Nunca apresente a demo como prova de parceria oficial com uma rede social.
- Não use perfis ou fotos reais sem autorização. Não simule menores de idade nem material não consentido.
- Não publique `.env`, `data/`, banco, sessões, cookies, tokens, QR ou capturas com dados pessoais.
- A pasta do sistema principal e o clone público não são alterados por esta demonstração; todo o trabalho fica nesta cópia `vendas-multicanal-demo`.
