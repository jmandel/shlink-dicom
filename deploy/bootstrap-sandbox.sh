#!/usr/bin/env bash
# Installs or updates the SMART Imaging Access sandbox on a VM from a release that CI built
# (.github/workflows/sandbox-release.yml), on x86_64 or aarch64 Linux. Needs only curl, unzip, tar
# and sudo: no git checkout, no Rust, no dcmtk, no Python. Runs from a web terminal or as a
# first-boot setup script:
#
#   curl -fsSL https://raw.githubusercontent.com/jmandel/shlink-dicom/main/deploy/bootstrap-sandbox.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/jmandel/shlink-dicom/main/deploy/bootstrap-sandbox.sh | bash -s sandbox-1a2b3c4
#
# With no argument it installs the release named in the sandbox-latest release's latest.json; with
# a tag, that release. Rollback is running it with an older tag (a release already built here is
# reused).
#
# Steps:
#   1. install a pinned Bun binary, checked by SHA-256;
#   2. download the release tarball, check its SHA-256, unpack it into $ROOT/releases/<tag>;
#   3. build the dataset there with the release's code, from the pinned sources (each checked by
#      SHA-256, kept in $ROOT/sources), and stop unless its digest is the expected one;
#   4. point $ROOT/current at the release, write /etc/imaging-sandbox.env and the systemd unit,
#      restart, and check the SMART configuration endpoint; if that fails, go back to the previous
#      release.
# Log: /var/log/shlink-bootstrap-sandbox.log

set -euo pipefail
trap 'echo "bootstrap-sandbox: failed at line $LINENO" >&2' ERR

TAG="${1:-${TAG:-}}"
REPO="${REPO:-jmandel/shlink-dicom}"
ROOT="${ROOT:-/opt/imaging-sandbox}"
PORT="${PORT:-8000}"
BASE_URL="${BASE_URL:-https://smart-imaging-sandbox.exe.xyz}"
SHARE_ORIGIN="${SHARE_ORIGIN:-https://shlink-dicom.exe.xyz}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
# Bun, pinned, for this architecture (the same block as in deploy/bootstrap-shlink-dicom.sh).
BUN_VERSION="1.4.3"
case "$(uname -m)" in
  x86_64)
    if grep -qw avx2 /proc/cpuinfo; then BUN_BUILD=bun-linux-x64; BUN_SHA256=3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18
    else BUN_BUILD=bun-linux-x64-baseline; BUN_SHA256=1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b; fi ;;
  aarch64 | arm64) BUN_BUILD=bun-linux-aarch64; BUN_SHA256=efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21 ;;
  *) echo "no pinned Bun for $(uname -m) (x86_64 and aarch64 Linux are supported)" >&2; exit 1 ;;
esac
BUN="$ROOT/bun/bun-$BUN_VERSION"
RELEASES="https://github.com/$REPO/releases/download"

SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
# The log is written by this shell (tee, not under sudo), so it belongs to whoever runs this,
# readable by no one else.
$SUDO touch /var/log/shlink-bootstrap-sandbox.log
$SUDO chown "$(id -u):$(id -g)" /var/log/shlink-bootstrap-sandbox.log
$SUDO chmod 600 /var/log/shlink-bootstrap-sandbox.log
exec > >(tee -a /var/log/shlink-bootstrap-sandbox.log) 2>&1
echo "== bootstrap-sandbox $(date -Is)"

need=""
for c in curl unzip tar sha256sum openssl; do command -v "$c" >/dev/null || need="$need $c"; done
if [ -n "$need" ]; then
  need="${need/sha256sum/coreutils}"
  $SUDO apt-get update -qq && $SUDO apt-get install -y -qq $need
fi
$SUDO mkdir -p "$ROOT/releases" "$ROOT/sources" "$ROOT/bun"
$SUDO chown "$(id -u):$(id -g)" "$ROOT" "$ROOT/releases" "$ROOT/sources" "$ROOT/bun"

# 1. Bun, the only runtime.
if [ ! -x "$BUN" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$BUN_BUILD.zip"
  echo "$BUN_SHA256  $tmp/bun.zip" | sha256sum -c --quiet
  unzip -q "$tmp/bun.zip" -d "$tmp"
  install -m 755 "$tmp/$BUN_BUILD/bun" "$BUN"
  rm -rf "$tmp"
fi
echo "bun $("$BUN" --version)"

# 2. The release.
if [ -z "$TAG" ]; then
  TAG="$(curl -fsSL "$RELEASES/sandbox-latest/latest.json" | "$BUN" -e 'console.log(JSON.parse(await Bun.stdin.text()).tag)')"
fi
case "$TAG" in sandbox-[0-9a-f]*) ;; *) echo "not a sandbox release tag: $TAG" >&2; exit 1 ;; esac
NAME="imaging-sandbox-$TAG"
DIR="$ROOT/releases/$TAG"
if [ -f "$DIR/.built" ]; then
  echo "release $TAG: already unpacked and built in $DIR"
else
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/$NAME.tar.gz" "$RELEASES/$TAG/$NAME.tar.gz"
  curl -fsSL -o "$tmp/$NAME.tar.gz.sha256" "$RELEASES/$TAG/$NAME.tar.gz.sha256"
  (cd "$tmp" && sha256sum -c --quiet "$NAME.tar.gz.sha256")
  echo "release $TAG: SHA-256 $(cut -d' ' -f1 "$tmp/$NAME.tar.gz.sha256") ok"
  rm -rf "$DIR" "$DIR.part"
  mkdir -p "$DIR.part"
  tar -xzf "$tmp/$NAME.tar.gz" -C "$DIR.part" --strip-components=1
  rm -rf "$tmp"
  # Every file as the manifest lists it.
  (cd "$DIR.part" && "$BUN" -e '
    const m = JSON.parse(await Bun.file("MANIFEST.json").text());
    for (const f of m.files) {
      const h = new Bun.CryptoHasher("sha256").update(await Bun.file(f.path).bytes()).digest("hex");
      if (h !== f.sha256) { console.error(`${f.path}: SHA-256 differs from MANIFEST.json`); process.exit(1); }
    }
    console.log(`release ${m.tag}: commit ${m.commit}, ${m.files.length} files match MANIFEST.json`);')

  # 3. The dataset, built with the release's code from the pinned sources.
  (cd "$DIR.part/imaging-sandbox" && "$BUN" scripts/build-data.ts --quiet --export none --sources "$ROOT/sources")
  want="$(cd "$DIR.part" && "$BUN" -e 'console.log(JSON.parse(await Bun.file("MANIFEST.json").text()).datasetDigest)')"
  EXPECTED_SUMS="${EXPECTED_SUMS:-$want}"
  SUMS="$(sha256sum "$DIR.part/imaging-sandbox/build/dataset/SHA256SUMS" | cut -d' ' -f1)"
  if [ "$SUMS" != "$EXPECTED_SUMS" ]; then
    echo "dataset digest $SUMS differs from the expected $EXPECTED_SUMS; $ROOT/current is unchanged" >&2
    exit 1
  fi
  echo "dataset matches the expected digest ($SUMS)"
  touch "$DIR.part/.built"
  chmod -R a+rX "$DIR.part"
  mv "$DIR.part" "$DIR"
fi

# 4. Configuration, the unit, and the switch.
# The introspection key is generated once and kept across runs.
if ! $SUDO test -f /etc/imaging-sandbox.env; then
  # Made mode 600 before the key is written to it.
  $SUDO install -m 600 -o root -g root /dev/null /etc/imaging-sandbox.env
  echo "INTROSPECTION_KEY=$(openssl rand -hex 24)" | $SUDO tee -a /etc/imaging-sandbox.env >/dev/null
fi
# An existing file (an earlier install may have left it 0644) is closed up before it is rewritten;
# sed -i and tee -a keep its mode.
$SUDO chown root:root /etc/imaging-sandbox.env
$SUDO chmod 600 /etc/imaging-sandbox.env
$SUDO sed -i '/^\(PORT\|BASE_URL\|HOST\|ALLOWED_ORIGINS\|LOG_REQUESTS\|SHARE_REDIRECT_URIS\)=/d' /etc/imaging-sandbox.env
$SUDO tee -a /etc/imaging-sandbox.env >/dev/null <<EOF
PORT=$PORT
HOST=0.0.0.0
BASE_URL=$BASE_URL
ALLOWED_ORIGINS=*
LOG_REQUESTS=true
SHARE_REDIRECT_URIS=$SHARE_ORIGIN/share/smart-callback/,http://localhost:3333/share/smart-callback/,http://127.0.0.1:3333/share/smart-callback/
EOF

$SUDO tee /etc/systemd/system/imaging-sandbox.service >/dev/null <<EOF
[Unit]
Description=SMART Imaging Access sandbox
After=network-online.target
Wants=network-online.target

[Service]
DynamicUser=yes
WorkingDirectory=$ROOT/current/imaging-sandbox
EnvironmentFile=/etc/imaging-sandbox.env
ExecStart=$BUN dist/server.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

PREVIOUS="$(readlink "$ROOT/current" 2>/dev/null || true)"
switch_to() { ln -sfn "$1" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"; }
healthy() {
  for _ in $(seq 1 30); do
    [[ "$(curl -sf "http://localhost:$PORT/fhir/.well-known/smart-configuration")" == *'"token_endpoint"'* ]] && return 0
    sleep 1
  done
  return 1
}
switch_to "$DIR"
$SUDO systemctl daemon-reload
$SUDO systemctl enable imaging-sandbox >/dev/null 2>&1
$SUDO systemctl restart imaging-sandbox
if ! healthy; then
  echo "release $TAG: no SMART configuration on port $PORT" >&2
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$DIR" ]; then
    echo "going back to $PREVIOUS" >&2
    switch_to "$PREVIOUS"
    $SUDO systemctl restart imaging-sandbox
    healthy || echo "the previous release did not come up either" >&2
  fi
  exit 1
fi
systemctl is-active imaging-sandbox
printf '%.160s\n' "$(curl -s "http://localhost:$PORT/fhir/.well-known/smart-configuration")"
echo "$TAG" > "$ROOT/current-tag"

# Releases other than the current one and the $KEEP_RELEASES - 1 most recent are removed.
ls -1dt "$ROOT"/releases/sandbox-* 2>/dev/null | { grep -v -x "$DIR" || true; } | tail -n "+$KEEP_RELEASES" | xargs -r rm -rf
echo "== done: $TAG at $BASE_URL"
