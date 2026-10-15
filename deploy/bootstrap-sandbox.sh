#!/usr/bin/env bash
# Installs or updates the SMART Imaging Access sandbox on a fresh VM,
# built from this public repository. Needs only curl and sudo, so it runs
# from a web terminal or as a first-boot setup script:
#
#   curl -fsSL https://raw.githubusercontent.com/jmandel/shlink-dicom/main/deploy/bootstrap-sandbox.sh | bash
#
# Steps: clone or update the repo in /opt/shlink-dicom, install a pinned Bun,
# rebuild the dataset from its pinned sources, check its SHA256SUMS digest,
# write /etc/imaging-sandbox.env, install and start the systemd unit.
# Log: /var/log/shlink-bootstrap-sandbox.log

set -euo pipefail

REPO="${REPO:-https://github.com/jmandel/shlink-dicom}"
REF="${REF:-main}"
DIR="${DIR:-/opt/shlink-dicom}"
PORT="${PORT:-8000}"
BASE_URL="${BASE_URL:-https://smart-imaging-sandbox.exe.xyz}"
SHARE_ORIGIN="${SHARE_ORIGIN:-https://shlink-dicom.exe.xyz}"
BUN_VERSION="1.4.3"
EXPECTED_SUMS="${EXPECTED_SUMS:-97e76f83e48ee0d9239a4c2b58b8918a6248f72841af4ebce3af8e4da1d792b7}"
export BUN_INSTALL=/opt/bun
BUN="$BUN_INSTALL/bin/bun"

SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
$SUDO touch /var/log/shlink-bootstrap-sandbox.log
$SUDO chmod 666 /var/log/shlink-bootstrap-sandbox.log
exec > >(tee -a /var/log/shlink-bootstrap-sandbox.log) 2>&1
echo "== bootstrap-sandbox $(date -Is)"

need=""
for c in git curl unzip openssl; do command -v "$c" >/dev/null || need="$need $c"; done
if [ -n "$need" ]; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq $need; fi

$SUDO mkdir -p "$DIR" "$BUN_INSTALL"
$SUDO chown "$(id -u):$(id -g)" "$DIR" "$BUN_INSTALL"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$REF" && git -C "$DIR" checkout -q --detach FETCH_HEAD
else
  git clone -q --depth 1 --branch "$REF" "$REPO" "$DIR"
fi
echo "repo at $(git -C "$DIR" rev-parse --short HEAD)"

if [ ! -x "$BUN" ] || [ "$("$BUN" --version)" != "$BUN_VERSION" ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" >/dev/null
fi
echo "bun $("$BUN" --version)"

cd "$DIR/imaging-sandbox"
"$BUN" scripts/build-data.ts --quiet
SUMS="$(sha256sum build/dataset/SHA256SUMS | cut -d' ' -f1)"
if [ "$SUMS" = "$EXPECTED_SUMS" ]; then
  echo "dataset matches the reference build ($SUMS)"
else
  echo "dataset digest $SUMS differs from the reference $EXPECTED_SUMS" >&2
  exit 1
fi

# The introspection key is generated once and kept across runs.
if ! $SUDO test -f /etc/imaging-sandbox.env; then
  echo "INTROSPECTION_KEY=$(openssl rand -hex 24)" | $SUDO tee /etc/imaging-sandbox.env >/dev/null
fi
$SUDO sed -i '/^\(PORT\|BASE_URL\|HOST\|ALLOWED_ORIGINS\|LOG_REQUESTS\|SHARE_REDIRECT_URIS\)=/d' /etc/imaging-sandbox.env
$SUDO tee -a /etc/imaging-sandbox.env >/dev/null <<EOF
PORT=$PORT
HOST=0.0.0.0
BASE_URL=$BASE_URL
ALLOWED_ORIGINS=*
LOG_REQUESTS=true
SHARE_REDIRECT_URIS=$SHARE_ORIGIN/share/smart-callback/,http://localhost:3333/share/smart-callback/,http://127.0.0.1:3333/share/smart-callback/
EOF
$SUDO chmod 600 /etc/imaging-sandbox.env

$SUDO tee /etc/systemd/system/imaging-sandbox.service >/dev/null <<EOF
[Unit]
Description=SMART Imaging Access sandbox
After=network-online.target
Wants=network-online.target

[Service]
DynamicUser=yes
WorkingDirectory=$DIR/imaging-sandbox
EnvironmentFile=/etc/imaging-sandbox.env
ExecStart=$BUN src/server.ts
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable imaging-sandbox >/dev/null 2>&1
$SUDO systemctl restart imaging-sandbox
for i in $(seq 1 30); do curl -sf "http://localhost:$PORT/healthz" >/dev/null && break; sleep 1; done
systemctl is-active imaging-sandbox
curl -s "http://localhost:$PORT/fhir/.well-known/smart-configuration" | head -c 160; echo
echo "== done: $BASE_URL"
