# Resolver erros comuns

Comece sempre por:

```bash
npm run diagnostico
```

## “Configuração ausente”

Rode `npm run configurar`. O sistema não inicia com o `.env.example` de demonstração nem com senha padrão.

## Painel não abre

1. Confirme que `npm start` continua rodando.
2. Veja se a porta está correta no `.env`.
3. Abra `http://127.0.0.1:PORTA` na mesma máquina.
4. Se a porta estiver ocupada, rode novamente `npm run configurar` e escolha outra.

## Chrome dedicado não conecta

1. Feche apenas o Chrome dedicado, não apague `data/chrome-profile`.
2. Rode `npm run chrome`.
3. Rode `npm run diagnostico` e procure “Chrome dedicado”.
4. Confirme que `TIM_CDP_ENDPOINT` é `http://127.0.0.1:9222`.
5. Não use uma porta 9222 exposta por outra máquina.

## Botão “Usar conta aberta no Chrome” não encontra a conta

- Confirme que é o Chrome aberto por `npm run chrome`.
- Abra a página da rede na aba correspondente.
- Atualize a página e conclua login, captcha ou confirmação.
- Tente novamente.
- Use **Alternativa manual** somente se o método recomendado continuar falhando.

## Tinder sem token ou HTTP 401

A sessão expirou. Faça login novamente na aba Tinder e importe a conta. Não reutilize token antigo.

## Badoo erro 9012

Mantenha o Chrome dedicado aberto, entre no Badoo e abra a lista de conversas. A importação tenta provar a sessão pelo navegador quando a chamada HTTP assinada não funciona. Se ainda falhar, refaça o login.

## Instagram HTTP 401 ou 403

Abra a aba Instagram e conclua login/checkpoint. Depois importe novamente. Não repita chamadas rapidamente.

## Instagram HTTP 429

É limite temporário. Pare sincronizações e aguarde. Repetir imediatamente prolonga o bloqueio.

## WhatsApp não mostra QR

Espere alguns minutos e use **Tentar de novo**. Muitas tentativas seguidas podem fazer o WhatsApp segurar novas conexões. Confira também permissão de escrita em `TIM_DATA_DIR`.

## WhatsApp cai depois do QR

- 515 logo após parear: aguarde o reinício automático.
- 401: use Re-parear.
- 403: não insista; verifique restrição no aplicativo oficial.
- 440: outra sessão substituiu esta conexão.

## IA não escreve

1. Rode `codex --version`.
2. Rode `codex` e conclua o login.
3. No painel, confira provedor e interruptor geral.
4. Confira se a IA está ligada naquela pessoa e canal.
5. Veja cota e erros no Diário.

## Foto não aparece ou não é enviada

- formatos aceitos: JPG, PNG, GIF e WebP;
- máximo: 24 MB por arquivo;
- a descrição é obrigatória;
- foto inativa, travada ou com criança não sai por automação;
- mídia automática e IA da conversa precisam estar autorizadas;
- para entrega, a foto precisa estar selecionada na entrega do serviço.

## Preço incorreto ou ausente

Edite **Configurações → Grana → Serviços e valores**. O preço vem da faixa do serviço, nunca da descrição da foto. Salve os serviços depois de editar.

## Antes de pedir ajuda

Tenha:

- sistema operacional e versão do Node;
- saída de `npm run diagnostico`, removendo caminhos pessoais se for publicar;
- horário do erro;
- canal afetado;
- mensagem do Diário sem nomes, telefones ou conversas.

Nunca envie `.env`, banco, token, cookie, QR ou pasta `data/`.
