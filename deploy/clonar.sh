#!/usr/bin/env bash
# Prepara uma instalação independente em /opt/<nome>.
# Rode na VM nova depois de colocar o código em /opt/<nome>/app.
#
#   bash deploy/clonar.sh minha-instancia --dono "Nome" --genero f
#
# A identidade nasce dos modelos vazios do repositório. Banco, sessão, mídia,
# credenciais e histórico de outra instalação nunca são copiados.
set -euo pipefail

NOME="${1:-}"
DONO=""
GENERO=""
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --dono) DONO="${2:-}"; shift 2 ;;
    --genero) GENERO="${2:-}"; shift 2 ;;
    *) echo "opção desconhecida: $1" >&2; exit 2 ;;
  esac
done

log(){ echo "[clonar $(date +%H:%M:%S)] $*"; }
morre(){ echo "[clonar] ERRO: $*" >&2; exit 1; }

[ -n "$NOME" ] || morre "uso: bash deploy/clonar.sh <nome> [--dono \"Nome\"] [--genero f|m]"
echo "$NOME" | grep -qE '^[a-z][a-z0-9-]{2,30}$' || morre "nome inválido: use minúsculas, números e hífen"
[ -z "$GENERO" ] || [ "$GENERO" = "f" ] || [ "$GENERO" = "m" ] || morre "gênero aceita f ou m"

RAIZ="/opt/$NOME"
APP="$RAIZ/app"
DADOS="$RAIZ/data"
ENV="$RAIZ/env"
FONTES="$APP/sobre-mim-fontes"
VIVO="$DADOS/sobre-mim"

[ -d "$APP" ] || morre "coloque o código em $APP antes de clonar"
[ -d "$FONTES" ] || morre "modelos de identidade não encontrados em $FONTES"
mkdir -p "$VIVO" "$RAIZ/contas"

if [ ! -f "$ENV" ]; then
  PW="${TIM_PANEL_PASSWORD:-$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-22)}"
  SECRET="$(openssl rand -hex 32)"
  umask 077
  {
    echo "TIM_SISTEMA=$NOME"
    echo "TIM_APP_DIR=$APP"
    echo "TIM_DATA_DIR=$DADOS"
    echo "TIM_DB_PATH=$DADOS/$NOME.db"
    echo "TIM_PANEL_HOST=127.0.0.1"
    echo "TIM_PANEL_PORT=8080"
    echo "TIM_PANEL_PASSWORD=$PW"
    echo "TIM_PANEL_SECRET=$SECRET"
    echo "TIM_CDP_ENDPOINT=http://127.0.0.1:9222"
    echo "TIM_DONO_PATH=$VIVO/dono.json"
    echo "TIM_PERSONAL_PROFILE_PATH=$VIVO/quem-eu-sou.md"
    echo "TIM_CONVERSATION_STYLE_PATH=$VIVO/como-eu-converso.md"
    echo "TIM_NUCLEO_VOZ_PATH=$VIVO/nucleo-voz.md"
  } > "$ENV"
  log "SENHA_DO_PAINEL=$PW"
else
  log "env existente preservado"
fi

# Só preenche o que ainda não existe. Reexecutar não apaga uma identidade já configurada.
for arquivo in dono.json criancas.json pontes.json exemplos-voz.json quem-eu-sou.md como-eu-converso.md nucleo-voz.md; do
  [ -f "$VIVO/$arquivo" ] || cp "$FONTES/$arquivo" "$VIVO/$arquivo"
done

if [ -n "$DONO" ]; then
  DONO_JSON="$DONO" GENERO_JSON="$GENERO" DESTINO_JSON="$VIVO/dono.json" node --input-type=module -e '
    import fs from "node:fs"
    fs.writeFileSync(process.env.DESTINO_JSON, JSON.stringify({
      nome: process.env.DONO_JSON,
      genero: process.env.GENERO_JSON || null,
    }, null, 2) + "\n", { mode: 0o600 })
  '
  log "identidade básica declarada"
fi

log "instalando dependências e serviços"
TIM_SISTEMA="$NOME" bash "$APP/deploy/setup-vm.sh"

log "instalação pronta em $RAIZ"
log "preencha $VIVO, conecte os canais e valide rascunhos antes de ligar automações"
