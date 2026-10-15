#!/usr/bin/env bash
# Deploys the imaging sandbox to an exe.dev VM and runs it under systemd.
#
#   scripts/deploy.sh                       # smart-imaging-sandbox.exe.xyz
#   DEPLOY_HOST=other.exe.xyz scripts/deploy.sh
#
# Steps: copy the code (no build output), install a pinned Bun if needed,
# rebuild the dataset on the VM from the pinned sources, check that its
# SHA256SUMS matches a local build, install the systemd unit, restart, and
# check the service on the VM.
#
# The exe.dev proxy forwards https://<vm>.exe.xyz/ to the VM's port 8000
# (see `ssh exe.dev share show <vm>`). The VM stays private: this script
# never runs `share set-public`.

set -euo pipefail

HOST="${DEPLOY_HOST:-smart-imaging-sandbox.exe.xyz}"
VM="${HOST%%.*}"
PORT="${DEPLOY_PORT:-8000}"
BASE_URL="${DEPLOY_BASE_URL:-https://$HOST}"
BUN_VERSION="1.4.3"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_DIR="imaging-sandbox"

echo "== local build (reference hashes)"
(cd "$HERE" && bun scripts/build-data.ts --quiet)
LOCAL_SUMS="$(sha256sum "$HERE/build/dataset/SHA256SUMS" | cut -d' ' -f1)"
echo "local SHA256SUMS digest: $LOCAL_SUMS"

echo "== copy code to $HOST"
rsync -az --delete \
  --exclude build/ --exclude node_modules/ --exclude test/.work/ \
  "$HERE/" "$HOST:$REMOTE_DIR/"

echo "== install Bun $BUN_VERSION, build data, install service"
ssh "$HOST" bash -s -- "$BUN_VERSION" "$PORT" "$BASE_URL" "$REMOTE_DIR" <<'REMOTE'
set -euo pipefail
BUN_VERSION="$1"; PORT="$2"; BASE_URL="$3"; DIR="$HOME/$4"
BUN="$HOME/.bun/bin/bun"
if [ ! -x "$BUN" ] || [ "$("$BUN" --version)" != "$BUN_VERSION" ]; then
  command -v unzip >/dev/null || sudo apt-get install -y -qq unzip
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" >/dev/null
fi
echo "bun $("$BUN" --version)"

cd "$DIR"
"$BUN" scripts/build-data.ts --quiet
echo "remote SHA256SUMS digest: $(sha256sum build/dataset/SHA256SUMS | cut -d' ' -f1)"

# Settings live in /etc/imaging-sandbox.env. The introspection key is
# generated once and kept across deploys.
if ! sudo test -f /etc/imaging-sandbox.env; then
  echo "INTROSPECTION_KEY=$(openssl rand -hex 24)" | sudo tee /etc/imaging-sandbox.env >/dev/null
fi
sudo sed -i '/^\(PORT\|BASE_URL\|HOST\|ALLOWED_ORIGINS\|LOG_REQUESTS\)=/d' /etc/imaging-sandbox.env
sudo tee -a /etc/imaging-sandbox.env >/dev/null <<EOF
PORT=$PORT
HOST=0.0.0.0
BASE_URL=$BASE_URL
ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-*}
LOG_REQUESTS=true
EOF
sudo chmod 600 /etc/imaging-sandbox.env

sudo tee /etc/systemd/system/imaging-sandbox.service >/dev/null <<EOF
[Unit]
Description=SMART Imaging Access sandbox
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$DIR
EnvironmentFile=/etc/imaging-sandbox.env
ExecStart=$BUN src/server.ts
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable imaging-sandbox >/dev/null 2>&1
sudo systemctl restart imaging-sandbox
for i in $(seq 1 30); do curl -sf "http://localhost:$PORT/healthz" >/dev/null && break; sleep 1; done
systemctl is-active imaging-sandbox
curl -s "http://localhost:$PORT/fhir/.well-known/smart-configuration" | head -c 160; echo
REMOTE

REMOTE_SUMS="$(ssh "$HOST" "sha256sum $REMOTE_DIR/build/dataset/SHA256SUMS | cut -d' ' -f1")"
if [ "$REMOTE_SUMS" = "$LOCAL_SUMS" ]; then
  echo "dataset on the VM is byte-identical to the local build ($REMOTE_SUMS)"
else
  echo "dataset differs: local $LOCAL_SUMS, VM $REMOTE_SUMS" >&2
  exit 1
fi
echo "deployed: $BASE_URL (private; exe.dev login required)"
