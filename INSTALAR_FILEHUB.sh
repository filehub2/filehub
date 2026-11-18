#!/bin/bash
set -Eeuo pipefail

# Instalador FileHub para Debian ARM64/AMD64. Execute como root.
APP_DIR="/root/filehub"
SHARE_DIR="/mnt/pendrive/FileHub/Compartilhados"
DATA_DIR="/root/.filehub-data"
SERVICE_NAME="filehub"

if [ "$(id -u)" -ne 0 ]; then
  echo "Execute como root: sudo bash INSTALAR_FILEHUB.sh"
  exit 1
fi

clear || true
echo "=============================================="
echo "        INSTALADOR AUTOMATICO FILEHUB"
echo "=============================================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "ERRO: Node.js nao encontrado. Instale Node.js 18.20.8 antes de continuar."
  exit 1
fi
NODE_VERSION="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERRO: Node.js $NODE_VERSION e antigo. O FileHub requer Node.js 18 ou superior."
  exit 1
fi
echo "Node.js detectado: v$NODE_VERSION"
echo "O instalador NAO atualiza nem substitui o Node.js existente."
echo

if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  apt-get update
  apt-get install -y git curl ca-certificates
fi

if [ ! -d "$APP_DIR/.git" ]; then
  echo "Informe a URL HTTPS do NOVO repositorio GitHub do FileHub."
  read -r -p "URL do GitHub: " REPO_URL
  if [ -z "$REPO_URL" ]; then echo "URL vazia. Cancelando."; exit 1; fi
  if [ -e "$APP_DIR" ]; then
    echo "A pasta $APP_DIR ja existe e nao e um repositorio Git."
    echo "Nao vou apagar seus arquivos. Renomeie essa pasta ou faca backup e tente novamente."
    exit 1
  fi
  git clone "$REPO_URL" "$APP_DIR"
else
  echo "Repositorio existente encontrado em $APP_DIR."
  read -r -p "Deseja atualizar o codigo com git pull? [s/N]: " DO_PULL
  if [[ "$DO_PULL" =~ ^[sS]$ ]]; then
    git -C "$APP_DIR" pull --ff-only
  fi
fi

if [ ! -f "$APP_DIR/server.js" ] || [ ! -f "$APP_DIR/tunnel-manager.js" ] || [ ! -f "$APP_DIR/public/index.html" ]; then
  echo "ERRO: o repositorio nao contem server.js, tunnel-manager.js e public/index.html."
  exit 1
fi

mkdir -p "$SHARE_DIR" "$DATA_DIR" "$DATA_DIR/tmp"
chmod 700 "$DATA_DIR" "$DATA_DIR/tmp"

# Instala cloudflared apenas se ainda nao estiver instalado.
if ! command -v cloudflared >/dev/null 2>&1; then
  ARCH="$(dpkg --print-architecture)"
  case "$ARCH" in
    arm64) CF_FILE="cloudflared-linux-arm64.deb" ;;
    amd64) CF_FILE="cloudflared-linux-amd64.deb" ;;
    armhf) CF_FILE="cloudflared-linux-armhf.deb" ;;
    *) echo "Arquitetura $ARCH nao suportada por este instalador automatico."; exit 1 ;;
  esac
  echo "Baixando cloudflared para arquitetura $ARCH..."
  curl -fL "https://github.com/cloudflare/cloudflared/releases/latest/download/$CF_FILE" -o /tmp/cloudflared-filehub.deb
  apt-get install -y /tmp/cloudflared-filehub.deb
  rm -f /tmp/cloudflared-filehub.deb
fi

cd "$APP_DIR"
npm install --omit=dev

# Arquivo inicial; o tunnel-manager.js o atualiza automaticamente ao detectar nova URL.
if [ ! -f "$APP_DIR/public/config.json" ]; then
  cat > "$APP_DIR/public/config.json" <<'JSON'
{
  "app": "FileHub",
  "version": "1.0.1",
  "publicUrl": "",
  "tunnelStatus": "starting",
  "updatedAt": null,
  "message": "Aguardando Cloudflare Tunnel"
}
JSON
fi

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=FileHub file manager and Cloudflare Tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=PORT=3001
Environment=FILEHUB_SHARE_DIR=${SHARE_DIR}
Environment=FILEHUB_DATA_DIR=${DATA_DIR}
ExecStart=$(command -v node) ${APP_DIR}/tunnel-manager.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
sleep 3

echo
echo "=============================================="
echo " FILEHUB INSTALADO"
echo "=============================================="
echo "Pasta compartilhada: $SHARE_DIR"
echo "Contas/configuracao: $DATA_DIR"
echo "Porta local: 3001"
echo
echo "Ver logs e encontrar o link do Cloudflare:"
echo "  journalctl -u filehub -f"
echo
echo "Ver estado do servico:"
echo "  systemctl status filehub"
echo
echo "Reiniciar FileHub e Tunnel:"
echo "  systemctl restart filehub"
echo
echo "Parar:"
echo "  systemctl stop filehub"
echo
echo "O endereco publico atual tambem fica em:"
echo "  $APP_DIR/public/config.json"
echo
echo "Abra o endereco https://....trycloudflare.com exibido nos logs."
echo "Na primeira abertura, use o codigo de configuracao mostrado nos logs do FileHub."
