# Instalar em servidor

Para uso contínuo, prefira uma VM Ubuntu dedicada. O servidor precisa de Node.js 22+, Chrome, Xvfb, FFmpeg, espaço persistente e HTTPS.

Os scripts de `deploy/` usam systemd e assumem o código em `/opt/$TIM_SISTEMA/app`:

1. configure `GCP_PROJECT_ID`, `GCP_ZONE`, `TIM_SISTEMA` e `TIM_RUN_USER` quando aplicável;
2. execute `deploy/provision.sh` para criar/preparar a máquina;
3. execute `deploy/setup-vm.sh` dentro da VM;
4. autentique a Codex CLI como o mesmo usuário do serviço;
5. conecte as redes pelo painel usando a alternativa manual quando não houver acesso visual ao Chrome;
6. confira os serviços systemd e o Diário.

Não exponha a porta 9222. O Chrome deve escutar somente em `127.0.0.1`. O painel deve ficar atrás de HTTPS e autenticação, com `TIM_PANEL_HOST=127.0.0.1` quando houver proxy reverso local.

O `npm run chrome` é voltado para computador com tela. Em servidor sem tela, o serviço `vendas-multicanal-chrome.service` executa Chrome sob Xvfb e mantém o perfil em `TIM_DATA_DIR`.

Faça backup criptografado de `TIM_DATA_DIR`. O código pode ser clonado novamente; banco, sessões, identidade e mídia não podem.
