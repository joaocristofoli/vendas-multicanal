# Primeiro uso

Este guia leva uma instalação vazia até a primeira conversa de teste. Não conecte contas de terceiros e não use dados reais enquanto estiver aprendendo.

## 1. Preparar o computador

Instale Node.js 22 ou superior, Git e Google Chrome/Chromium. FFmpeg é necessário para áudio e vídeo; Codex CLI é necessário somente para textos gerados por IA.

Confira o Node:

```bash
node --version
npm --version
```

O primeiro número do Node precisa ser 22 ou maior.

## 2. Baixar e configurar

```bash
git clone https://github.com/joaocristofoli/vendas-multicanal.git
cd vendas-multicanal
npm ci
npm run configurar
```

O assistente cria:

- `.env`: porta, senha, segredo e caminhos;
- `data/sobre-mim/`: identidade e estilo privados;
- `data/chrome-profile/`: perfil isolado do Chrome;
- `data/vendas-multicanal.db`: criado no primeiro início.

`.env` e `data/` são ignorados pelo Git. Mesmo assim, não compartilhe esses arquivos.

## 3. Conferir o ambiente

```bash
npm run diagnostico
```

Erros marcados com `✗` impedem o uso. Avisos `!` indicam recursos opcionais ou processos ainda não iniciados.

## 4. Abrir o Chrome das redes

```bash
npm run chrome
```

Esse Chrome usa um perfil separado do navegador pessoal. Ele abre Tinder, Badoo e Instagram. Faça login apenas nas contas que serão operadas pelo sistema. Deixe as abas abertas.

Não exponha a porta 9222 na rede ou internet. Ela deve continuar em `127.0.0.1`.

## 5. Iniciar o painel

```bash
npm start
```

Abra `http://127.0.0.1:8080`, informe a senha criada e mantenha o terminal aberto. Para encerrar, pressione `Ctrl+C`.

## 6. Conectar as contas

No painel:

1. Abra **Configurações**.
2. Escolha **Sistema**.
3. Abra **Conectar os canais**.
4. Clique em **Usar conta aberta no Chrome** em Tinder, Badoo e Instagram.
5. Confira a conta informada quando a rede fornece essa identificação; no Badoo, confira a prova da sessão e a quantidade de conversas.
6. Abra a aba **WhatsApp** e faça o pareamento por QR.

Veja instruções específicas em [Conectar as redes](CONECTAR-REDES.md).

## 7. Preparar a área comercial

Antes de atender alguém:

1. Salve os dados de recebimento em **Configurações → Grana → PIX para receber**.
2. Crie pelo menos um serviço com preço exato.
3. Se vender mídia, carregue e classifique as fotos.
4. Configure fotos de exemplo e entrega separadamente.
5. Preencha a agenda e a disponibilidade se houver atendimento presencial.

Use [Vender fotos](VENDER-FOTOS.md) ou [Vender serviços](VENDER-SERVICOS.md).

## 8. Fazer um teste seguro

Use uma segunda conta sua ou uma pessoa que concordou com o teste:

1. receba uma mensagem;
2. abra a conversa no painel;
3. responda manualmente;
4. gere um rascunho com IA, mas revise antes de enviar;
5. envie uma foto classificada como normal;
6. teste uma entrega sem valor real;
7. confira o Diário.

Somente depois ligue a IA para uma pessoa específica. Não ligue automação em massa no primeiro dia.

## 9. Rotina de uso

Ao iniciar o computador:

```bash
npm run chrome
npm start
```

O Chrome preserva as sessões no perfil privado. Se uma rede cair, o painel e o Diário mostram o motivo. Rode `npm run diagnostico` quando o painel ou Chrome não responder.
