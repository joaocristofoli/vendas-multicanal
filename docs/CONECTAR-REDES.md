# Conectar Tinder, Badoo, WhatsApp e Instagram

Há dois métodos para Tinder, Badoo e Instagram:

1. **Conta aberta no Chrome**, recomendado para computador com tela.
2. **Credencial colada**, alternativa para servidor ou recuperação.

O WhatsApp sempre usa QR. Use somente contas próprias e nunca envie token, cookie ou QR por mensagem.

## Antes de começar

Em um terminal:

```bash
npm run chrome
```

Em outro:

```bash
npm start
```

Abra o painel e vá a **Configurações → Sistema → Conectar os canais**.

## Tinder

### Método recomendado

1. Na aba Tinder do Chrome dedicado, conclua o login.
2. Confirme que a página de recomendações ou matches abriu, sem tela de login.
3. No painel, clique em **Usar conta aberta no Chrome** na caixa Tinder.
4. Aguarde a consulta do perfil.
5. Confira o nome mostrado ao lado de “conectado”.

Se aparecer “sem sessão”, atualize a aba Tinder, conclua verificações pendentes e tente novamente.

### Alternativa manual

1. Abra `tinder.com` em um navegador autenticado.
2. Abra as ferramentas do desenvolvedor com `F12` ou `Option+Command+I` no macOS.
3. Na aba **Console**, execute:

```js
copy(localStorage.getItem('TinderWeb/APIToken'))
```

4. No painel, abra **Alternativa manual**, cole o token e conecte.
5. Confira o nome da conta. Nunca salve esse token em arquivo ou issue.

### Confirmação

O indicador Tinder deve ficar conectado e a aba deve carregar matches/conversas após a sincronização. Token recusado ou HTTP 401 significa sessão expirada; entre novamente e repita.

## Badoo

### Método recomendado

1. Entre no Badoo na aba do Chrome dedicado.
2. Abra a lista de conversas para garantir que a conta terminou de carregar.
3. Clique em **Usar conta aberta no Chrome** na caixa Badoo.
4. Aguarde: a prova da sessão pode abrir/navegar uma aba e levar até dois minutos.
5. Confira se o painel informa que a sessão foi conectada.

O Chrome precisa permanecer aberto para operações que dependem da página. Recursos como ver quem curtiu podem continuar limitados pelo plano da própria conta.

### Alternativa manual

1. Em `badoo.com`, abra `F12` → **Network/Rede**.
2. Atualize a página e selecione uma requisição para `badoo.com`.
3. Em **Request Headers/Cabeçalhos da solicitação**, copie o valor inteiro de `cookie`.
4. Abra **Alternativa manual** no painel, cole a linha e conecte.

Não copie apenas um cookie isolado. Se a prova falhar, faça logout/login no navegador e capture novamente.

### Confirmação

A aba Badoo deve listar conversas. Erro 9012 é tratado pelo caminho do navegador; se persistir, mantenha o Chrome aberto, abra a lista de mensagens e tente novamente.

## Instagram

### Método recomendado

1. Entre no Instagram na aba do Chrome dedicado.
2. Abra o Direct e conclua desafios de segurança, confirmação de login ou avisos.
3. Clique em **Usar conta aberta no Chrome** na caixa Instagram.
4. Confira o `@` mostrado pelo painel.

### Alternativa manual

1. Em `instagram.com`, abra `F12` → **Application/Aplicativo** → **Cookies** → `https://www.instagram.com`.
2. Confirme que existe `sessionid`.
3. Pela aba **Network/Rede**, abra uma requisição e copie o valor inteiro do cabeçalho `cookie`.
4. Cole em **Alternativa manual** e conecte.

### Confirmação

A aba Instagram deve carregar os Directs. HTTP 401/403 normalmente indica sessão vencida ou checkpoint; conclua o login no Chrome. HTTP 429 significa limite temporário: pare as tentativas e aguarde antes de sincronizar novamente.

## WhatsApp

1. Abra a aba **WhatsApp** no painel.
2. Clique em **Conectar WhatsApp**.
3. Espere o QR aparecer.
4. No celular, abra WhatsApp → **Aparelhos conectados** → **Conectar aparelho**.
5. Leia o QR mostrado no painel.
6. Aguarde a tela mudar para **WhatsApp conectado**.

O QR expira e é renovado. Se o painel disser que não conseguiu gerar o código, espere alguns minutos e clique em **Tentar de novo**.

Use **Re-parear** apenas quando a sessão foi removida, o aparelho saiu da lista ou você precisa refazer o vínculo. Re-parear derruba a sessão atual até um novo QR ser lido.

- Código 401: sessão removida; re-parear costuma resolver.
- Código 403: conta restringida; não insista em QR, verifique a conta no aplicativo oficial.
- Código 440: a mesma sessão foi substituída por outra conexão.
- Código 515 logo após parear: reinício normal do WhatsApp; aguarde a reconexão.

## Estado dos indicadores

- **Conectado/verde**: a última prova da rede funcionou.
- **Pendente**: existe sessão, mas ainda não foi verificada nesta execução.
- **Caído/vermelho**: a rede recusou ou perdeu a sessão; abra o Diário para ver o motivo.
- **Não configurado**: nenhuma sessão foi salva.

## Segurança das sessões

- Mantenha `TIM_CDP_ENDPOINT` em `http://127.0.0.1:9222`.
- Não abra a porta 9222 no roteador, firewall ou proxy.
- Não publique `data/`, `.env`, banco, cookies, tokens ou capturas do QR.
- Confira sempre o nome da conta antes de sincronizar ou enviar.
- Se conectou a conta errada, saia dela no Chrome dedicado e conecte a correta antes de sincronizar ou enviar.
