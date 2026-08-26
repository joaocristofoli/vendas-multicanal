# Filtro final de mensagens

Toda mensagem gerada passa por `src/ai/filtro.mjs` antes de poder ser enviada. O filtro é
determinístico e cobre todos os canais que usam o gerador compartilhado.

As principais travas impedem:

- mistura de atração ou conteúdo sexual com qualquer marcador de criança;
- vazamento de prompt, mensagens de erro do provedor e identificadores internos;
- endereço, documento, chave PIX ou dado privado sem autorização contextual;
- repetição de bordões e respostas incompatíveis com regras configuradas.

Conteúdo envolvendo menores nunca é regenerado nem enviado. Outros problemas corrigíveis
podem ganhar uma única reescrita; se a segunda versão falhar, nada sai e o Diário registra o
bloqueio. Nomes de crianças, quando necessários ao filtro da instalação, pertencem somente a
`data/sobre-mim/criancas.json` e nunca ao Git.

O filtro reduz risco, mas não substitui revisão humana, consentimento, confirmação de idade e
cumprimento das regras de cada plataforma.
