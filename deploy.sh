#!/usr/bin/env bash
# ==============================================================================
# Deploy script CosTeleBot — dijalankan DI VPS (dipanggil oleh GitHub Actions).
# Tugas: tarik kode terbaru → install dep kalau berubah → reload bot via PM2.
#
# .env, stats.json, history.json, browser_profile_* TIDAK tersentuh karena
# di-gitignore (git reset --hard hanya menyentuh file yang dilacak git).
# ==============================================================================
set -euo pipefail

# --- PATH safety untuk shell non-interaktif (SSH) ---
export PATH="$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Dukung node via nvm kalau dipakai
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true

APP_NAME="${APP_NAME:-costelebot}"
BRANCH="${DEPLOY_BRANCH:-main}"

cd "$(dirname "$0")"
echo "==> [$(date '+%F %T')] Deploy $APP_NAME (branch $BRANCH) di $(pwd)"

# pm2 bisa global atau via npx
PM2="$(command -v pm2 || true)"
[ -z "$PM2" ] && PM2="npx pm2"

# --- Notifikasi Telegram (best-effort, ambil token & chat dari .env VPS) ---
read_env() {
  local v
  v="$(grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true)"
  v="${v%$'\r'}"                 # buang CR (file CRLF)
  v="${v%\"}"; v="${v#\"}"       # buang kutip ganda di ujung
  v="${v%\'}"; v="${v#\'}"       # buang kutip tunggal di ujung
  printf '%s' "$v"
}

notify() {
  local msg="$1" token chat
  token="$(read_env BOT_TOKEN)"
  chat="$(read_env DEPLOY_NOTIFY_CHAT)"
  [ -z "$chat" ] && chat="$(read_env ADMIN_IDS | cut -d, -f1)"
  [ -n "$token" ] && [ -n "$chat" ] || return 0
  curl -fsS -m 10 "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat}" \
    --data-urlencode "text=${msg}" >/dev/null 2>&1 || true
}

# Kirim notif kalau deploy gagal di tengah jalan
trap 'notify "❌ Deploy CosTeleBot GAGAL. Cek log GitHub Actions."' ERR

# --- Tarik kode terbaru, paksa samakan dengan origin (deploy box) ---
OLD_REV="$(git rev-parse HEAD 2>/dev/null || echo none)"
git fetch --all --prune
git reset --hard "origin/$BRANCH"
NEW_REV="$(git rev-parse HEAD)"
echo "==> $OLD_REV -> $NEW_REV"

# --- Install dependency HANYA kalau package.json / lockfile berubah ---
CHANGED=1
[ "$OLD_REV" != "none" ] && [ "$OLD_REV" = "$NEW_REV" ] && CHANGED=0

if [ "$CHANGED" = "0" ] && [ "${FORCE_RELOAD:-0}" != "1" ]; then
  echo "==> Tidak ada perubahan (HEAD sama) → skip reload."
  exit 0
fi

if [ "$OLD_REV" = "none" ] || ! git diff --quiet "$OLD_REV" "$NEW_REV" -- package.json package-lock.json; then
  echo "==> Dependency berubah → npm install"
  if [ -f package-lock.json ]; then
    npm ci --omit=dev || npm install --omit=dev
  else
    npm install --omit=dev
  fi
  # Pastikan browser Playwright sesuai versi (idempotent)
  npx playwright install chromium >/dev/null 2>&1 || true
else
  echo "==> Dependency tidak berubah → skip npm install"
fi

# --- Reload / start via PM2 ---
if $PM2 describe "$APP_NAME" >/dev/null 2>&1; then
  echo "==> Reload $APP_NAME"
  $PM2 reload "$APP_NAME" --update-env
else
  echo "==> Proses belum ada → start via ecosystem.config.js"
  $PM2 start ecosystem.config.js
fi
$PM2 save >/dev/null 2>&1 || true

notify "✅ Deploy CosTeleBot sukses → $(git rev-parse --short HEAD) ($(date '+%F %T'))"
echo "==> [$(date '+%F %T')] Deploy selesai ✅"
