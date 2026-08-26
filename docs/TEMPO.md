# Tempo e fuso — invariante global

O fuso civil do vendas-multicanal é sempre **`America/Sao_Paulo`**. Esta é uma regra do sistema,
não uma preferência de uma tela ou de um módulo.

## O que a regra significa

- Instantes podem ser armazenados como epoch em milissegundos ou enviados em UTC/RFC3339.
  Isso não muda o fuso civil do produto.
- Toda interpretação humana usa `America/Sao_Paulo`: hoje, ontem, amanhã, dia da semana,
  virada do dia, horários, janelas, agenda, lembretes, cadência, métricas por dia e datas
  mostradas na UI.
- O relógio local da VM, do navegador ou do processo nunca é fonte de verdade para essas
  decisões. Código novo deve informar `timeZone: 'America/Sao_Paulo'` explicitamente ou usar
  um helper que já imponha esse fuso.
- Em integrações, converta na borda: entrada civil é interpretada em São Paulo; armazenamento
  continua sendo instante; saída civil volta a ser formatada em São Paulo.
- Para representar o fuso, prefira o identificador IANA `America/Sao_Paulo`. Não derive a
  regra de `UTC-3`, mesmo que o offset atual seja esse.

## Regra de fala

O fuso é contexto interno. A IA que conversa com terceiros pode usar a data e a hora já
calculadas para dizer naturalmente “hoje”, “amanhã”, “de manhã” ou “às 20h”, mas nunca deve
falar, explicar ou revelar que o sistema usa “horário de Brasília”, `America/Sao_Paulo`,
“UTC-3” ou uma regra interna de fuso.

O prompt registra essa separação e o último filtro antes do envio bloqueia uma eventual
exposição. Textos digitados manualmente por quem opera não passam por essa proibição: a
regra é para fala gerada pela IA.

## Onde já é imposto

- `deploy/provision.sh` configura a VM em `America/Sao_Paulo` como rede de segurança.
- `src/ai/prompt.mjs` entrega ao modelo o relógio correto e proíbe expor a origem do fuso.
- Agenda, projetos, necessidades, encontros, cadências, métricas e painel formatam datas com
  `timeZone: 'America/Sao_Paulo'`.
- `src/ai/filtro.mjs` impede que o nome técnico do fuso saia numa resposta automática.

Configurar a VM ajuda código legado que ainda usa hora local, mas não substitui a obrigação
de declarar o fuso no código novo.
