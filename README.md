# Vendas Multicanal

Sistema de atendimento para Tinder, Badoo, WhatsApp e Instagram. Centraliza conversas, permite enviar fotos e áudios, cadastrar serviços e preços por foto ou duração, organizar disponibilidade para encontros/atendimentos e gerar rascunhos com IA.

Este repositório nasceu de uma instalação real, mas foi publicado com histórico Git novo e sem banco, sessões, fotos, conversas, credenciais, testes exploratórios ou identidade de qualquer pessoa. Todos os exemplos públicos são sintéticos.

## O que já existe

- Tinder: sincronização, perfil, envio, fila de respostas e swipes controlados.
- Badoo: sessão pelo Chrome, sincronização, encontros e envio de foto/áudio.
- WhatsApp: pareamento por QR, histórico, texto, foto, áudio, figurinha e contatos.
- Instagram: leitura, resposta e envio de foto com conferência do destinatário.
- Catálogo: banco de fotos, preço por foto, pacotes, links de entrega e associação a serviços.
- Serviços: várias durações e preços, regras por etiqueta e agendamento.
- Encontros e atendimentos: disponibilidade, agenda local e Google Agenda opcional.
- Painel web: pessoas, conversas, catálogo, serviços, agenda, automações e diagnóstico.
- IA: rascunho e resposta automática por pessoa/canal, sempre desligada por padrão.

## Requisitos

- Node.js 22 ou superior.
- Google Chrome ou Chromium com porta de depuração local.
- FFmpeg para áudio, vídeo e figurinhas.
- Codex CLI autenticado para a geração de texto.
- Linux é recomendado para execução contínua; os scripts de `deploy/` usam Ubuntu e systemd.

O login do Codex deve ser feito na própria máquina que executará o sistema: instale a CLI, rode `codex` e escolha uma forma de login disponível. Não copie nem publique `auth.json`. Consulte a [documentação oficial do Codex CLI](https://learn.chatgpt.com/docs/codex/cli).

## Instalação local

```bash
git clone https://github.com/joaocristofoli/vendas-multicanal.git
cd vendas-multicanal
npm ci
cp .env.example .env
mkdir -p data/sobre-mim
cp -R sobre-mim-fontes/. data/sobre-mim/
```

Edite `.env` e os arquivos dentro de `data/sobre-mim/`. Essa pasta é ignorada pelo Git e é o lugar correto para nome, voz, biografia, nomes de crianças da casa e outros dados privados.

Para desenvolvimento local:

```bash
set -a
source .env
set +a
npm start
```

Abra `http://127.0.0.1:8080`, entre com `TIM_PANEL_PASSWORD` e conecte cada canal pelo painel. Nunca ligue resposta automática antes de conferir a identidade, os preços, as regras de segurança e alguns rascunhos manuais.

## Configuração mínima

1. Defina uma senha forte em `TIM_PANEL_PASSWORD` e um segredo aleatório em `TIM_PANEL_SECRET`.
2. Preencha `data/sobre-mim/dono.json`, `quem-eu-sou.md` e `nucleo-voz.md`. Se quiser concordância automática, declare o gênero no JSON e `TIM_INTERLOCUTOR_GENERO` no `.env`; sem isso o texto fica neutro.
3. Cadastre serviços e faixas de preço no painel.
4. Importe fotos pelo painel ou com `node tools/importar-fotos.mjs`.
5. Conecte WhatsApp por QR e os demais canais em um perfil de Chrome dedicado.
6. Gere rascunhos e valide destinatário, conteúdo e preço antes de automatizar.

As variáveis mais comuns estão documentadas em [.env.example](.env.example). O sistema mantém banco, sessões e mídias em `TIM_DATA_DIR`; faça backup dessa pasta fora do Git.

## Fotos e preços

O catálogo aceita fotos com título, descrição, estado, uso e preço. Um serviço pode ter várias faixas de duração e preço. A automação só oferece valor quando a regra/etiqueta da conversa permite; o cadastro comercial pertence à instalação e nunca vem preenchido neste repositório.

O projeto não inclui fotos. Use somente conteúdo que você possui e tem direito de vender. Confirme idade e consentimento de todas as pessoas retratadas; conteúdo envolvendo menores é proibido.

## Testes e auditoria de privacidade

```bash
npm run check:public
npm run check
```

`check:public` procura credenciais, dados da instalação original, e-mails reais, IPs públicos, caminhos pessoais e mídia/bancos que não podem entrar no Git. Antes de publicar um fork, siga também [docs/PRIVACIDADE-E-PUBLICACAO.md](docs/PRIVACIDADE-E-PUBLICACAO.md).

## Deploy em VM

Os scripts em `deploy/` assumem Ubuntu, systemd e uma VM dedicada. Configure `GCP_PROJECT_ID`, `GCP_ZONE`, `TIM_SISTEMA` e, se necessário, `TIM_RUN_USER`. Execute `deploy/provision.sh` e `deploy/setup-vm.sh` na VM. `deploy/push.sh` é opcional e usa `gcloud` para atualizações.

Não exponha a porta 9222 do Chrome nem o painel sem HTTPS. Mantenha `TIM_PANEL_HOST=127.0.0.1` atrás de um proxy autenticado/TLS.

## Uso responsável

- Use apenas contas próprias e respeite os termos de Tinder, Badoo, WhatsApp, Instagram e demais provedores.
- Não use para spam, assédio, fraude, falsidade ideológica, exploração sexual ou automação sem consentimento.
- Encontros e conteúdo adulto são exclusivamente para maiores de 18 anos e adultos capazes de consentir.
- Respostas automáticas começam desligadas; a pessoa operadora continua responsável por tudo que for enviado.
- Integrações baseadas na interface web podem quebrar quando o provedor muda a página.

## Licença

MIT. Veja [LICENSE](LICENSE).
