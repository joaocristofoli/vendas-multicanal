# Privacidade e publicação

Antes de publicar um fork:

1. Crie uma exportação sem o diretório `.git`; não reutilize histórico que já teve dados pessoais.
2. Não copie `data/`, `.env`, bancos, sessões, cookies, perfis de Chrome, fotos, áudios, vídeos ou backups.
3. Substitua identidade e voz por modelos vazios.
4. Troque nomes, telefones, documentos, ids de chat, IPs, projetos de nuvem e caminhos locais por fixtures evidentes.
5. Remova relatos de produção que permitam reconhecer pessoas, mesmo sem nome.
6. Rode `npm run check:public` e revise manualmente `git diff --cached`.
7. Inicialize um repositório Git novo e publique somente depois da auditoria.

A única identificação pessoal intencional desta edição pública é a atribuição do mantenedor e o canal de doação declarados em `APOIE.md`, `NOTICE.md`, `LICENSE`, `README.md`, `package.json` e no rodapé do painel: `@eujoaocris` e PIX Itaú `(11)973964702`. Esses dados foram autorizados expressamente para publicação e não devem ser confundidos com identidade, clientes ou credenciais de uma instalação.

Depois da publicação, se um dado real escapar, revogue credenciais/sessões imediatamente e reescreva o histórico ou remova o repositório. Um commit que apenas apaga o arquivo não elimina versões anteriores.

Na operação diária, mantenha todos os dados privados sob `TIM_DATA_DIR`, com acesso restrito e backup criptografado. Defina prazo de retenção para conversas e mídias conforme a lei aplicável.
