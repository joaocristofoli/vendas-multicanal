# Serviços, fotos e valores

Cadastre serviços em Configurações → Grana → Serviços e valores. Cada serviço pode ter:

- nome, descrição e tipo (`presencial`, `online` ou `ambos`);
- várias faixas de duração/quantidade e preço em centavos;
- referência pública de local, duração de agenda e folga antes/depois;
- etiquetas e palavras que controlam em quais conversas aparece;
- fotos de exemplo e uma entrega separada com link, instrução ou arquivos.

O banco guarda centavos inteiros. O prompt recebe somente valores cadastrados e nunca pode
estimar preço, desconto ou disponibilidade. Endereço completo fica oculto por padrão e deve
ser compartilhado apenas no momento apropriado.

Fotos de exemplo não são fotos de entrega. Arquivos de entrega só saem por ação explícita de
quem opera e depois da confirmação comercial definida na instalação. A automação de fotos e
áudios começa desligada, mesmo que já existam itens no catálogo.

O catálogo fica no banco sob `TIM_DATA_DIR`; o repositório contém apenas o mecanismo vazio.
