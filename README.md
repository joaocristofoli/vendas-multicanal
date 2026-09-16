# Vendas Multicanal

> Quer gravar uma apresentação sem conectar contas reais? Abra o [guia da demonstração local](README-DEMO.md). A demo vem com seis redes, pessoas sintéticas, conversas, preços, fotos, agenda, projetos e automações já preenchidos.

Painel único para atender conversas do Tinder, Badoo, WhatsApp e Instagram, cadastrar fotos e serviços com preço, organizar agenda e preparar respostas com IA.

O sistema nasce vazio e seguro: nenhuma conta vem conectada, não existem fotos ou clientes de exemplo e a resposta automática começa desligada. Cada pessoa instala, coloca os próprios dados na área privada e decide manualmente o que pode ser oferecido ou enviado.

> Projeto mantido por [@eujoaocris](https://www.instagram.com/eujoaocris/). Se o projeto ajudou você, a doação é voluntária: **PIX Itaú `(11)973964702`**. Confira o destinatário no aplicativo do banco antes de confirmar. Veja [todas as informações de apoio](APOIE.md).

## Comece por aqui

Você precisa de:

- [Node.js](https://nodejs.org/) 22 ou superior;
- Google Chrome ou Chromium;
- Git;
- FFmpeg se quiser trabalhar com áudio, vídeo ou figurinhas;
- Codex CLI autenticado se quiser gerar textos com IA.

No terminal:

```bash
git clone https://github.com/joaocristofoli/vendas-multicanal.git
cd vendas-multicanal
npm ci
npm run configurar
npm run chrome
npm start
```

O assistente `npm run configurar` pergunta nome, cidade, porta e senha. Ele cria `.env` e `data/sobre-mim/`, que são privados e ignorados pelo Git. Você não precisa executar `source .env`: `npm start` carrega o arquivo automaticamente.

Abra `http://127.0.0.1:8080` e entre com a senha mostrada pelo assistente. Se escolheu outra porta, use a porta escolhida.

Se algo não abrir, rode:

```bash
npm run diagnostico
```

O diagnóstico confere Node.js, configuração, dependências, Chrome, FFmpeg, Codex e painel. Veja o passo a passo completo em [Primeiro uso](docs/PRIMEIRO-USO.md).

## O que fazer na primeira entrada

Siga esta ordem:

1. Abra **Configurações → Sistema → Conectar os canais**.
2. Entre em Tinder, Badoo e Instagram nas abas criadas por `npm run chrome`.
3. Clique em **Usar conta aberta no Chrome** para cada rede; confira a conta exibida quando a rede fornece essa informação.
4. Abra a aba **WhatsApp**, clique em **Conectar WhatsApp** e leia o QR pelo celular.
5. Preencha **Configurações → Grana → PIX para receber**.
6. Cadastre produtos em **Configurações → Grana → Serviços e valores**.
7. Adicione fotos em **Configurações → Fotos e áudios → Banco de fotos**.
8. Teste uma conversa e uma entrega manual com uma conta sua.
9. Somente depois revise e ligue a IA para pessoas específicas.

O guia [Conectar as redes](docs/CONECTAR-REDES.md) mostra cada clique, como confirmar que funcionou e como corrigir os erros mais comuns.

## Como cada parte funciona

| Área | Para que serve | Onde usar |
|---|---|---|
| Tinder | Matches, conversas, perfil, rascunhos e swipes controlados | Aba **Tinder** |
| WhatsApp | QR, conversas, texto, foto, áudio, figurinha e entrega | Aba **WhatsApp** |
| Instagram | Directs, resposta e envio de foto com conferência do destinatário | Aba **Instagram** |
| Badoo | Conversas, encontros, foto, áudio e descoberta | Aba **Badoo** |
| Pessoas | Unifica a mesma pessoa entre redes e controla a IA por canal | Aba **Pessoas/Vínculos** |
| Agenda | Disponibilidade, compromissos e Google Agenda opcional | Aba **Agenda** |
| Grana | PIX, serviços, preços, entregas e regras comerciais | **Configurações → Grana** |
| Fotos e áudios | Biblioteca privada e permissão para a IA utilizar mídia | **Configurações → Fotos e áudios** |
| Diário e Monitor | Mostram envios, sincronizações, quedas e eventos | **Configurações → Sistema** |

Uma mensagem recebida é salva no banco local. O painel mostra a conversa, permite resposta manual e, quando solicitado, gera um rascunho. Ativar a IA em uma conversa permite respostas automáticas apenas naquela pessoa e naquele canal; não liga as outras conversas.

Veja a explicação detalhada de telas e botões em [Guia do painel](docs/GUIA-DO-PAINEL.md).

### O que pode ser enviado em cada rede

| Rede | Texto | Foto individual | Entrega cadastrada de serviço |
|---|---:|---:|---:|
| Tinder | Sim | Não | Não; combine a mudança consentida para outro canal |
| WhatsApp | Sim | Sim | Sim, incluindo texto, link e várias fotos |
| Instagram | Sim | Sim | Não em lote; envie a foto individual manualmente |
| Badoo | Sim | Sim | Texto/link; pacotes de fotos devem ser entregues por canal compatível |

O painel nunca finge que uma rede aceita um tipo de envio que ela não aceita. Uma venda pode começar no Tinder ou Badoo e ser entregue no WhatsApp depois que a própria pessoa compartilhar o contato e o vínculo for conferido.

## Como vender fotos

O preço não fica solto no arquivo da foto. A foto é ligada a um serviço, pois é o serviço que define quantidade, valor e entrega.

Fluxo recomendado:

1. Em **Fotos e áudios → Banco de fotos**, envie as imagens e descreva exatamente o que cada uma mostra e quando pode ser usada.
2. Classifique cada foto como **normal**, **sensual**, **com criança** ou **travada**. Fotos com criança nunca saem por automação.
3. Em **Grana → Serviços e valores**, crie um serviço do tipo **Online**, como “Pacote de fotos”.
4. Crie faixas exatas, por exemplo “3 fotos” e “10 fotos”, cada uma com seu preço.
5. Selecione fotos de exemplo e, separadamente, as fotos ou o link da entrega.
6. Salve o PIX.
7. Na conversa, confirme pacote, preço e pagamento. Verifique o recebimento fora do sistema.
8. No WhatsApp, abra **Entregar**, confira pessoa e pacote e confirme o envio em dois cliques. No Instagram, envie fotos individualmente; Tinder não envia fotos.

O sistema não consulta sua conta bancária e não confirma PIX sozinho. Nunca entregue com base apenas em mensagem ou comprovante enviado por cliente. Leia [Como vender fotos](docs/VENDER-FOTOS.md).

## Como vender serviços ou marcar encontros

Em **Grana → Serviços e valores**, cada serviço aceita:

- nome e descrição;
- tipo **Presencial**, **Online** ou **Os dois**;
- várias durações ou quantidades com preços diferentes;
- local público e endereço privado;
- folga de agenda antes e depois;
- palavras e etiquetas que indicam quando o serviço é pertinente;
- fotos de exemplo;
- link, instruções e fotos de entrega.

O fluxo é: entender o pedido, apresentar somente opções cadastradas, confirmar duração/quantidade, informar preço exato, combinar pagamento, confirmar disponibilidade e registrar o compromisso. Endereço completo só deve ser enviado no momento apropriado e para a pessoa correta.

Leia [Como vender serviços](docs/VENDER-SERVICOS.md) para exemplos de cadastro, venda, agenda e entrega.

## Conectar as redes sem copiar credenciais

O comando abaixo abre um perfil separado do Chrome com Tinder, Badoo e Instagram:

```bash
npm run chrome
```

Faça login normalmente em cada aba e mantenha esse Chrome aberto. Depois, no painel, vá a **Configurações → Sistema → Conectar os canais** e clique em **Usar conta aberta no Chrome**. O sistema:

1. procura a aba correta;
2. lê a sessão apenas na máquina local;
3. consulta a rede para provar que a sessão funciona;
4. mostra de qual conta é a sessão;
5. salva a sessão na área privada `data/`, no banco e/ou no perfil dedicado do Chrome.

WhatsApp é diferente: o pareamento acontece por QR na própria aba WhatsApp. A alternativa manual para Tinder, Badoo e Instagram fica recolhida no painel para servidores ou recuperação.

Não publique `.env`, `data/`, cookies, tokens, QR, banco, fotos ou capturas de tela com conversas.

## IA: comece com rascunhos

Para gerar texto, instale a Codex CLI, execute `codex` e conclua o login na própria máquina. Não copie `auth.json` de outra pessoa. Consulte a [documentação oficial do Codex CLI](https://learn.chatgpt.com/docs/codex/cli).

Use primeiro o botão de gerar rascunho e revise tom, identidade, valores e destinatário. A resposta automática começa desligada por pessoa e canal. Fotos automáticas também começam desligadas.

A IA só pode mencionar preços cadastrados. Ela não deve inventar desconto, confirmar pagamento, prometer disponibilidade, pressionar após recusa ou enviar conteúdo incompatível com idade e consentimento.

## Onde ficam seus dados

Tudo que pertence à instalação fica em `TIM_DATA_DIR`, normalmente `./data`:

- banco SQLite;
- sessões das redes;
- mídia recebida e salva;
- identidade e estilo da pessoa operadora;
- histórico de conversas e agenda local.

Essa pasta não entra no Git. Faça backup criptografado dela separadamente. Antes de publicar um fork, rode `npm run check:public` e siga [Privacidade e publicação](docs/PRIVACIDADE-E-PUBLICACAO.md).

## Comandos principais

```bash
npm run configurar    # cria a configuração privada inicial
npm run chrome        # abre o Chrome dedicado das redes
npm start             # inicia painel e integrações
npm run diagnostico   # explica o que está pronto ou faltando
npm run check         # auditoria pública e testes
```

## Guias

- [Primeiro uso](docs/PRIMEIRO-USO.md)
- [Conectar Tinder, Badoo, WhatsApp e Instagram](docs/CONECTAR-REDES.md)
- [Guia de todas as áreas do painel](docs/GUIA-DO-PAINEL.md)
- [Vender fotos](docs/VENDER-FOTOS.md)
- [Vender serviços e organizar encontros](docs/VENDER-SERVICOS.md)
- [Resolver erros comuns](docs/ERROS-COMUNS.md)
- [Instalar continuamente em servidor](docs/INSTALAR-EM-SERVIDOR.md)
- [Privacidade e publicação](docs/PRIVACIDADE-E-PUBLICACAO.md)

## Limites e uso responsável

- Use somente contas próprias e respeite os termos atuais de cada rede.
- Integrações baseadas na interface web podem precisar de atualização quando a rede muda o site.
- WhatsApp usa pareamento de aparelho e não é a API oficial WhatsApp Cloud.
- Não use para spam, assédio, fraude, identidade falsa ou automação agressiva.
- Conteúdo adulto e encontros são exclusivamente entre adultos maiores de 18 anos, capazes de consentir.
- Venda apenas conteúdo próprio ou licenciado, com consentimento de todas as pessoas retratadas.
- O sistema não processa pagamentos, não garante recebimento e não substitui cuidados de segurança em encontros presenciais.

## Autoria e apoio

O mantenedor público é [@eujoaocris](https://www.instagram.com/eujoaocris/). Doações para manter o projeto podem ser feitas pelo PIX Itaú `(11)973964702`; confirme o destinatário no seu banco. A doação é opcional e não altera a licença MIT nem cria direito a suporte ou serviço.

Veja [APOIE.md](APOIE.md) e [NOTICE.md](NOTICE.md). A atribuição também consta no aviso de copyright da licença.

## Licença

MIT. Veja [LICENSE](LICENSE).
