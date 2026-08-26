# Disponibilidade e agenda

O sistema separa três tipos de janela:

- `encontro`: disponibilidade pessoal;
- `atendimento`: horário para serviço cadastrado;
- `compromisso`: bloqueio comum de agenda.

Encontros e atendimentos têm interruptores independentes e começam desligados. A automação
só pode sugerir um horário quando a capacidade correspondente estiver autorizada, existir uma
janela compatível e não houver conflito na agenda local ou no Google Agenda.

Um `lugar` representa uma região atendida. Um `período` pode trocar temporariamente o lugar
ativo ou bloquear todos os horários. Endereço exato não entra no prompt por padrão; use apenas
uma referência pública e revele o endereço completo manualmente, no momento apropriado.

Serviços presenciais podem ter duração, folga antes/depois e custo adicional de local. A
duração escolhida precisa caber inteira na janela. Cadastre tudo na aba Agenda e valide as
sugestões manualmente antes de ligar qualquer automação.
