# Lições locais

O mecanismo de lições continua em `src/licoes/registro.mjs`, mas os incidentes da instalação
original não fazem parte da edição pública. Novas guardas criadas durante a operação ficam
ignoradas pelo Git por padrão, pois podem conter contexto privado.

Antes de publicar uma lição, substitua pessoas, contas, datas, volumes, mensagens e caminhos
por exemplos sintéticos e rode `npm run check:public`.
