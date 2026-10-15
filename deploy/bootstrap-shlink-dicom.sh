#!/usr/bin/env bash
# Installs or updates the shlink-dicom server and web app on a fresh VM,
# built from this public repository. Needs only curl and sudo, so it runs
# from a web terminal or as a first-boot setup script:
#
#   curl -fsSL https://raw.githubusercontent.com/jmandel/shlink-dicom/main/deploy/bootstrap-shlink-dicom.sh | bash
#
# Steps: clone or update the repo in /opt/shlink-dicom, install Rust (with the
# wasm32 target), wasm-bindgen and a pinned Bun, build the wasm modules, the
# web app and the server, build the sandbox dataset (Morgan Rivera, a
# fictional patient) and seed it as the public sample share, then install and
# start the systemd unit. Server data lives in /var/lib/shlink-dicom.
# Log: /var/log/shlink-bootstrap.log

set -euo pipefail

REPO="${REPO:-https://github.com/jmandel/shlink-dicom}"
REF="${REF:-main}"
DIR="${DIR:-/opt/shlink-dicom}"
DATA="${DATA:-/var/lib/shlink-dicom}"
PORT="${PORT:-8000}"
ORIGIN="${ORIGIN:-https://shlink-dicom.exe.xyz}"
BUN_VERSION="1.4.3"
WASM_BINDGEN_VERSION="0.2.128"
export BUN_INSTALL=/opt/bun
export RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo
export PATH="$CARGO_HOME/bin:$BUN_INSTALL/bin:$PATH"

SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
$SUDO touch /var/log/shlink-bootstrap.log
$SUDO chmod 666 /var/log/shlink-bootstrap.log
exec > >(tee -a /var/log/shlink-bootstrap.log) 2>&1
echo "== bootstrap-shlink-dicom $(date -Is)"

need=""
for c in git curl unzip cc pkg-config; do command -v "$c" >/dev/null || need="$need $c"; done
dpkg -s libsqlite3-dev >/dev/null 2>&1 || need="$need libsqlite3-dev"
if [ -n "$need" ]; then
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq git curl unzip build-essential pkg-config libsqlite3-dev
fi

$SUDO mkdir -p "$DIR" "$BUN_INSTALL" /opt/rust
$SUDO chown "$(id -u):$(id -g)" "$DIR" "$BUN_INSTALL" /opt/rust
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$REF" && git -C "$DIR" checkout -q --detach FETCH_HEAD
else
  git clone -q --depth 1 --branch "$REF" "$REPO" "$DIR"
fi
echo "repo at $(git -C "$DIR" rev-parse --short HEAD)"

# Toolchains. viewer-kit's build calls `$HOME/.cargo/bin/cargo +stable`, so
# HOME points at a directory whose .cargo is the shared install.
if ! command -v rustup >/dev/null; then
  curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --profile minimal --default-toolchain stable --no-modify-path
fi
rustup target add wasm32-unknown-unknown >/dev/null
mkdir -p /opt/rust/home && ln -sfn "$CARGO_HOME" /opt/rust/home/.cargo
if [ "$(wasm-bindgen --version 2>/dev/null)" != "wasm-bindgen $WASM_BINDGEN_VERSION" ]; then
  t="wasm-bindgen-$WASM_BINDGEN_VERSION-x86_64-unknown-linux-musl"
  curl -fsSL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/$WASM_BINDGEN_VERSION/$t.tar.gz" \
    | tar -xz -C "$CARGO_HOME/bin" --strip-components=1 "$t/wasm-bindgen"
fi
if [ ! -x "$BUN_INSTALL/bin/bun" ] || [ "$(bun --version)" != "$BUN_VERSION" ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" >/dev/null
fi
echo "$(cargo --version); $(wasm-bindgen --version); bun $(bun --version)"

cd "$DIR"
echo "== wasm modules"
cargo build -q --release --target wasm32-unknown-unknown -p shl-dicom-wasm
wasm-bindgen --target web --out-dir crates/shl-dicom-wasm/pkg target/wasm32-unknown-unknown/release/shl_dicom_wasm.wasm
HOME=/opt/rust/home bun viewer-kit/scripts/build.mjs

echo "== web app"
bun install --frozen-lockfile --production
bun web/build.ts

echo "== server"
cargo build -q --release -p shl-dicom-server

echo "== public sample (sandbox dataset, fictional patient)"
(cd imaging-sandbox && bun scripts/build-data.ts --quiet)
id shlink >/dev/null 2>&1 || $SUDO useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin shlink
$SUDO mkdir -p "$DATA/samples"
for s in mri-brain-2020 wrist-low-res; do
  tar -czf "$DIR/$s.tgz" -C imaging-sandbox/build/dataset/dicom "$s"
  $SUDO mv "$DIR/$s.tgz" "$DATA/samples/$s.tgz"
done
$SUDO chown -R shlink:shlink "$DATA"

$SUDO tee /etc/systemd/system/shlink-dicom.service >/dev/null <<EOF
[Unit]
Description=shlink-dicom server and web app
After=network-online.target
Wants=network-online.target

[Service]
User=shlink
WorkingDirectory=$DIR
Environment=PORT=$PORT
Environment=SHL_DICOM_DATA_DIR=$DATA
Environment=PUBLIC_ORIGIN=$ORIGIN
ExecStart=$DIR/target/release/shl-dicom-server serve
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable shlink-dicom >/dev/null 2>&1
$SUDO systemctl restart shlink-dicom
for i in $(seq 1 60); do curl -sf "http://localhost:$PORT/api/demo-shares" >/dev/null && break; sleep 1; done
systemctl is-active shlink-dicom
curl -s "http://localhost:$PORT/api/demo-shares" | head -c 200; echo
echo "== done: $ORIGIN"
