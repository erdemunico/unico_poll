#!/usr/bin/env bash
# Unico Poll — Oracle Always Free (Ubuntu) kurulum
# Sunucuda bir kez calistir: bash oracle-setup.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/unico-poll}"
APP_USER="${APP_USER:-ubuntu}"
REPO_URL="${REPO_URL:-https://github.com/erdemunico/unico_poll.git}"

echo "==> Sistem paketleri"
sudo apt-get update -y
sudo apt-get install -y curl git ca-certificates

if ! command -v node >/dev/null 2>&1; then
  echo "==> Node.js 20 LTS"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Node: $(node -v)  npm: $(npm -v)"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "==> PM2"
  sudo npm install -g pm2
fi

echo "==> Proje klasoru: $APP_DIR"
if [ ! -d "$APP_DIR/.git" ]; then
  sudo mkdir -p "$APP_DIR"
  sudo chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
else
  cd "$APP_DIR"
  git fetch origin
  git checkout main
  git pull --ff-only origin main || true
fi

cd "$APP_DIR"
npm ci --omit=dev

mkdir -p "$APP_DIR/data"

if [ ! -f "$APP_DIR/.env" ]; then
  echo ""
  echo "!!! .env yok. Simdi olustur:"
  echo "    nano $APP_DIR/.env"
  echo "Railway / lokal .env iceriklerini kopyala."
  echo "FAST_TEST_MODE=false ve DATABASE_PATH=./data/unico-poll.json olsun."
  echo ""
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "Sablon kopyalandi: $APP_DIR/.env — tokenlari doldurup tekrar:"
  echo "    pm2 start $APP_DIR/src/index.js --name unico-poll"
  echo "    pm2 save && pm2 startup"
  exit 0
fi

echo "==> PM2 ile baslat"
pm2 delete unico-poll 2>/dev/null || true
pm2 start "$APP_DIR/src/index.js" --name unico-poll
pm2 save
sudo env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "$(eval echo ~$APP_USER)" | tail -n 1 | bash || true

echo ""
echo "Tamam. Log:"
echo "  pm2 logs unico-poll --lines 50"
echo "Slack: Now connected to Slack satiri gelmeli."
echo "Sonra Railway servisini Pause / Delete et (cift bot olmasin)."
