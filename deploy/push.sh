#!/usr/bin/env bash
# Envia somente código e modelos públicos para uma VM GCP já instalada.
# Uso: GCP_PROJECT_ID=... TIM_ALVO=minha-instancia bash deploy/push.sh
set -euo pipefail

PROJECT="${GCP_PROJECT_ID:?defina GCP_PROJECT_ID}"
ZONE="${GCP_ZONE:-southamerica-east1-a}"
NOME="${TIM_ALVO:-${TIM_SISTEMA:-vendas-multicanal}}"
VM="${NOME}-vm"
PACOTE="/tmp/vendas-multicanal-app.tgz"
cd "$(dirname "$0")/.."

ALVOS=(
  src package.json package-lock.json deploy tools baseline docs tests-public
  sobre-mim-fontes sobre-mim-modos licoes
  .env.example .gitignore AGENTS.md CLAUDE.md README.md SECURITY.md LICENSE
)

echo "[push] auditando a árvore pública"
npm run check:public

echo "[push] empacotando código"
COPYFILE_DISABLE=1 tar czf "$PACOTE" "${ALVOS[@]}"
for alvo in "${ALVOS[@]}"; do
  tar tzf "$PACOTE" | grep -q "^${alvo}" || { echo "[push] pacote sem $alvo" >&2; exit 1; }
done

echo "[push] enviando para $VM"
gcloud compute scp "$PACOTE" "${VM}:/tmp/" --zone="$ZONE" --project="$PROJECT" --quiet

echo "[push] extraindo, testando e reiniciando $NOME-core"
gcloud compute ssh "$VM" --zone="$ZONE" --project="$PROJECT" --quiet --command='NOME='"${NOME}"'
  set -e
  cd "/opt/$NOME/app"
  sudo chown -R "$(id -un):$(id -gn)" "/opt/$NOME/app"
  tar --overwrite -xzf /tmp/vendas-multicanal-app.tgz
  npm install --omit=dev --no-audit --no-fund
  npm run check
  sudo systemctl restart "$NOME-core"
  sleep 3
  systemctl is-active "$NOME-core"
'

echo "[push] OK"
