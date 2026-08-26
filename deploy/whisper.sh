#!/usr/bin/env bash
# Provisiona a TRANSCRIÇÃO DE ÁUDIO na vendas-multicanal-vm: ffmpeg do sistema + venv do faster-whisper
# + o modelo baixado. Idempotente: rodar de novo não reinstala o que já está de pé.
#
# POR QUE ESTE ARQUIVO EXISTE: o `provision.sh` do fork (31/07/2026) instalou node, Chrome e
# Caddy — e NÃO instalou nem o ffmpeg nem o whisper. O sistema subiu com quatro capacidades
# mortas em silêncio (transcrever áudio do WhatsApp e do Instagram, fazer figurinha, tirar
# frames de vídeo). Em 01/08/2026 o banco tinha 2.273 áudios e ZERO transcritos: 54 tinham
# chegado ao vivo e os 54 morreram com `spawn .../whisper-venv/bin/python ENOENT`.
#
# Uso (do Mac):  bash deploy/whisper.sh
set -euo pipefail
PROJECT="${GCP_PROJECT_ID:?defina GCP_PROJECT_ID}"
ZONE="${GCP_ZONE:-southamerica-east1-a}"
NOME="${TIM_SISTEMA:-vendas-multicanal}"
VM="${NOME}-vm"

echo "[whisper] provisionando na ${VM} (pode levar alguns minutos na primeira vez)..."
gcloud compute ssh "${VM}" --zone="${ZONE}" --project="${PROJECT}" --quiet --command='
set -euo pipefail
NOME='"${NOME}"'
VENV=/opt/$NOME/whisper-venv
MODELOS=/opt/$NOME/data/whisper-models

# 1. ffmpeg + python3-venv. O ffmpeg NÃO é só do whisper: figurinha própria
#    (src/wa/sticker-maker.mjs), áudio salvo (src/wa/saved-audio.mjs) e os frames de vídeo do
#    Instagram (src/ig/media-interpret.mjs) chamam o mesmo binário do sistema.
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "  [1/4] instalando ffmpeg + python3-venv..."
  sudo apt-get update -y -q >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q ffmpeg python3-venv >/dev/null
else
  echo "  [1/4] ffmpeg ja instalado: $(ffmpeg -version | head -1 | cut -d\" \" -f1-3)"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-venv >/dev/null 2>&1 || true
fi

# 2. venv. Dono é o appuser porque é ele que roda o vendas-multicanal-core (ver deploy/systemd).
if [ ! -x "$VENV/bin/python" ]; then
  echo "  [2/4] criando o venv em $VENV..."
  sudo mkdir -p "$VENV"
  sudo chown -R "$(id -un):$(id -gn)" "/opt/$NOME"
  python3 -m venv "$VENV"
else
  echo "  [2/4] venv ja existe"
fi

# 3. faster-whisper. `--quiet` porque o pip cospe centenas de linhas de progresso.
if ! "$VENV/bin/python" -c "import faster_whisper" 2>/dev/null; then
  echo "  [3/4] instalando faster-whisper (baixa ~200MB de rodas)..."
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet faster-whisper
else
  echo "  [3/4] faster-whisper ja instalado"
fi

# 4. Modelo. Baixar AQUI, no provisionamento, e nao na primeira transcricao: senao o primeiro
#    audio que a pessoa mandar espera um download de ~500MB dentro do timeout de 180s da fila
#    (src/wa/media.mjs) e falha parecendo audio ruim.
mkdir -p "$MODELOS"
echo "  [4/4] garantindo o modelo small em $MODELOS..."
"$VENV/bin/python" - <<PY
from faster_whisper import WhisperModel
WhisperModel("small", device="cpu", compute_type="int8", download_root="$MODELOS")
print("      modelo pronto")
PY

echo
echo "  === PROVA (transcrevendo um audio de verdade da VM) ==="
# A prova nao pode ser "o binario existe": tem que SAIR TEXTO de um .ogg real que chegou pelo
# WhatsApp. Se nao houver nenhum arquivo, isso e DITO — nao se finge que passou.
ALVO=$(ls -S "/opt/$NOME/data/wa-media/"*.ogg 2>/dev/null | head -1 || true)
if [ -z "$ALVO" ]; then
  echo "  SEM AUDIO EM DISCO pra provar. ffmpeg/venv/modelo instalados, transcricao NAO comprovada."
  exit 0
fi
echo "  arquivo: $ALVO ($(du -h "$ALVO" | cut -f1))"
cd "/opt/$NOME/app"
time "$VENV/bin/python" tools/transcribe.py "$ALVO"
'
echo
echo "[whisper] pronto. Se a PROVA acima imprimiu {\"text\": ...} com fala de verdade,"
echo "          a transcrição está viva. Reprocessar o que falhou: node tools/reenfileirar-audios.mjs"
