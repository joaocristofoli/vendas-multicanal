#!/usr/bin/env bash
# Instala/atualiza o vendas-multicanal na VM: deps, env, systemd (Xvfb+Chrome+core), Caddy HTTPS.
# Roda NA VM com o usuário que executará o serviço, após o código estar em /opt/$TIM_SISTEMA/app.
set -euo pipefail
# O NOME DA INSTÂNCIA MANDA NOS CAMINHOS. Este script era chumbado em /opt/vendas-multicanal, o que
# fazia todo clone gravar dentro da pasta da instância de origem. Com TIM_SISTEMA, a mesma
# receita serve pra vendas-multicanal e pra qualquer clone (ver deploy/clonar.sh).
NOME="${TIM_SISTEMA:-vendas-multicanal}"
RAIZ="/opt/$NOME"
APP="$RAIZ/app"
ENV="$RAIZ/env"
log(){ echo "[setup $(date +%H:%M:%S)] $*"; }

log "== npm install (better-sqlite3/baileys compilam nativo; playwright-core não baixa browser) =="
cd "$APP"
npm install --omit=dev --no-audit --no-fund

log "== env (só cria se não existir) =="
if [ ! -f "$ENV" ]; then
  # NUNCA usar senha fixa aqui: este arquivo vai pro git. Sem TIM_PANEL_PASSWORD no
  # ambiente, sorteia uma forte e imprime no log do setup (o dono copia de lá).
  PW=${TIM_PANEL_PASSWORD:-$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-22)}
  SECRET=$(openssl rand -hex 32)
  cat > "$ENV" <<EOF
TIM_PANEL_PORT=8080
TIM_PANEL_HOST=127.0.0.1
TIM_PANEL_PASSWORD=$PW
TIM_PANEL_SECRET=$SECRET
TIM_CDP_ENDPOINT=http://127.0.0.1:9222
TIM_SISTEMA=$NOME
TIM_APP_DIR=$APP
TIM_DATA_DIR=$RAIZ/data
TIM_DB_PATH=$RAIZ/data/$NOME.db
# Google Agenda (OAuth). Preencha com o client web criado no Google Cloud Console e
# reinicie o vendas-multicanal-core. O redirect_uri é derivado do Host (dominio sslip via Caddy).
#GOOGLE_AGENDA_CLIENT_ID=
#GOOGLE_AGENDA_CLIENT_SECRET=
EOF
  chmod 600 "$ENV"
  log "SENHA_DO_PAINEL=$PW"
else
  log "env preservado (senha mantida)"
fi

log "== systemd units =="
RUN_USER="${TIM_RUN_USER:-$(id -un)}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
[ -n "$RUN_HOME" ] || { log "usuário de serviço inexistente: $RUN_USER"; exit 1; }
for ORIGEM in "$APP/deploy/systemd/vendas-multicanal-"*.service; do
  UNIT="$(basename "$ORIGEM" | sed "s/vendas-multicanal/$NOME/g")"
  sed -e "s/vendas-multicanal/$NOME/g" \
      -e "s#User=appuser#User=$RUN_USER#g" \
      -e "s#Environment=HOME=/home/appuser#Environment=HOME=$RUN_HOME#g" \
      "$ORIGEM" | sudo tee "/etc/systemd/system/$UNIT" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now "$NOME-xvfb.service"
sleep 1
sudo systemctl restart "$NOME-chrome.service"
sudo systemctl enable "$NOME-chrome.service"
sleep 4
sudo systemctl restart "$NOME-core.service"
sudo systemctl enable "$NOME-core.service"

log "== dependências externas do motor (o que o sistema CHAMA por fora do Node) =="
# TRÊS BINÁRIOS, TRÊS CAPACIDADES QUE SOMEM EM SILÊNCIO SE FALTAREM.
#   codex   -> a IA escreve. Sem ele: `spawn codex ENOENT` na primeira geração.
#   ffmpeg  -> converte o áudio gravado pra OGG/Opus (o formato de nota de voz do WhatsApp).
#              Sem ele: "não deu pra salvar o áudio", e a pessoa procura defeito no celular.
#   whisper -> transcreve o áudio recebido. Sem ele: os áudios entram sem texto e a IA
#              responde no escuro (já custou 54 áudios em erro no sistema de origem).
# Nenhum deles quebra o boot: o painel sobe verde e a capacidade some calada. Por isso a
# instalação vem junto do resto e o estado final REPORTA os três.
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null 2>&1 || log "  AVISO: apt falhou ao instalar o ffmpeg"

# WHISPER (transcrição). O venv e o modelo entram no setup para que a primeira
# mensagem de áudio não dependa de instalação manual.
if [ ! -x "$RAIZ/whisper-venv/bin/python" ]; then
  log "  provisionando o whisper (venv + faster-whisper + modelo; demora alguns minutos)"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv >/dev/null 2>&1 || true
  sudo mkdir -p "$RAIZ"/whisper-venv "$RAIZ"/data/whisper-models
  sudo chown -R "$(id -un):$(id -gn)" "$RAIZ"/whisper-venv "$RAIZ"/data/whisper-models
  python3 -m venv "$RAIZ"/whisper-venv >/dev/null 2>&1 || log "  AVISO: venv falhou"
  "$RAIZ"/whisper-venv/bin/pip install --quiet --upgrade pip >/dev/null 2>&1 || true
  "$RAIZ"/whisper-venv/bin/pip install --quiet faster-whisper >/dev/null 2>&1 || log "  AVISO: faster-whisper falhou"
  # O MODELO BAIXA AQUI, não na primeira transcrição: senão o primeiro áudio que chegar
  # espera ~500MB dentro do timeout de 180s da fila e falha parecendo áudio ruim.
  TIM_WHISPER_MODELS="$RAIZ/data/whisper-models" "$RAIZ/whisper-venv/bin/python" - <<'PYW' >/dev/null 2>&1 || log "  AVISO: modelo do whisper nao baixou"
import os
from faster_whisper import WhisperModel
WhisperModel("small", device="cpu", compute_type="int8", download_root=os.environ["TIM_WHISPER_MODELS"])
PYW
fi

log "== Codex (o CÉREBRO — sem ele a IA não escreve em canal nenhum) =="
# A geração de texto depende do binário Codex; instale e valide no próprio setup.
if ! command -v codex >/dev/null 2>&1; then
  sudo npm i -g @openai/codex >/dev/null 2>&1 || log "  AVISO: npm falhou ao instalar o codex"
fi
mkdir -p "$HOME/.codex"
# O login é individual e interativo. Nunca copie auth.json de outra máquina ou conta.
if [ ! -f "$HOME/.codex/auth.json" ]; then
  log "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  log "  !! SEM CREDENCIAL DO CODEX (~/.codex/auth.json) — A IA VAI FICAR MUDA !!"
  log "  !! entre nesta VM como $RUN_USER, rode 'codex' e conclua o login.     !!"
  log "  !! depois confira com: codex exec 'responda apenas: ok'               !!"
  log "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
fi

log "== Caddy (HTTPS via sslip.io do IP externo) =="
IP=$(curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip)
DOMAIN="${IP}.sslip.io"
printf '%s {\n  reverse_proxy 127.0.0.1:8080\n}\n' "$DOMAIN" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl restart caddy

log "== estado =="
for s in "$NOME-xvfb" "$NOME-chrome" "$NOME-core" caddy; do
  printf '  %-12s %s\n' "$s" "$(systemctl is-active $s 2>/dev/null)"
done
# O cérebro entra na MESMA lista dos serviços: quem lê o fim do setup tem que ver o estado
# do Codex do lado do Chrome e do Caddy, não em outro lugar que dá pra não olhar.
printf '  %-12s %s\n' "codex" "$(command -v codex >/dev/null 2>&1 && ([ -f "$HOME/.codex/auth.json" ] && echo "instalado e com credencial" || echo "INSTALADO SEM CREDENCIAL -> IA MUDA") || echo "AUSENTE -> IA MUDA")"
printf '  %-12s %s\n' "ffmpeg" "$(command -v ffmpeg >/dev/null 2>&1 && echo "ok" || echo "AUSENTE -> nao salva nem manda audio")"
printf '  %-12s %s\n' "whisper" "$([ -x "$RAIZ/whisper-venv/bin/python" ] && echo "ok" || echo "AUSENTE -> audio recebido entra sem transcricao (rode deploy/whisper.sh)")"
log "PAINEL=https://$DOMAIN"
log "setup OK"
