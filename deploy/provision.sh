#!/usr/bin/env bash
# Provisiona a VM da instância (TIM_SISTEMA, padrão vendas-multicanal): Node 22, Google Chrome estável, Xvfb, Caddy, toolchain.
# Idempotente — pode rodar de novo sem quebrar.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
log(){ echo "[$(date +%H:%M:%S)] $*"; }

log "== apt update + base =="
sudo apt-get update -y -q
sudo apt-get install -y -q ca-certificates curl gnupg git build-essential python3 \
  xvfb x11-utils x11-xserver-utils fonts-liberation fonts-noto-color-emoji \
  libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64 sqlite3

log "== Node.js 22 =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | sed 's/v//;s/\..*//')" -lt 22 ] 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y -q nodejs
fi
log "node $(node -v) / npm $(npm -v)"

log "== Google Chrome estável =="
if ! command -v google-chrome >/dev/null 2>&1; then
  curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb
  sudo apt-get install -y -q /tmp/chrome.deb
  rm -f /tmp/chrome.deb
fi
log "$(google-chrome --version)"

log "== fuso horário (America/Sao_Paulo) =="
# O sistema usa regras locais de agenda e cadência no fuso America/Sao_Paulo.
sudo timedatectl set-timezone America/Sao_Paulo

log "== swap (4G) =="
# Chrome, Node e transcrição local podem gerar picos de memória; o swap é uma rede de segurança.
if ! swapon --show | grep -q '/swapfile'; then
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  # 10 = só usa swap sob pressão real; o padrão (60) trocaria página à toa e deixaria o
  # painel lento sem necessidade.
  sudo sysctl -w vm.swappiness=10 >/dev/null
  grep -q 'vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf >/dev/null
fi
log "swap: $(swapon --show --noheadings --bytes | awk '{printf "%.0fG", $3/1073741824}' | head -1)"

log "== Caddy =="
if ! command -v caddy >/dev/null 2>&1; then
  sudo apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y -q
  sudo apt-get install -y -q caddy
fi
log "$(caddy version | head -1)"

log "== diretórios da instância =="
# O nome vem do ambiente: a mesma receita provisiona a origem e qualquer clone.
NOME="${TIM_SISTEMA:-vendas-multicanal}"
sudo mkdir -p "/opt/$NOME"
sudo chown -R "$USER":"$USER" "/opt/$NOME"
mkdir -p "/opt/$NOME/data"

log "PROVISION_OK"
