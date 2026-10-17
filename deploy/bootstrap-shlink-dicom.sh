#!/usr/bin/env bash
# Installs or updates the shlink-dicom server and web app on a VM from a release that CI built
# (.github/workflows/server-release.yml), on x86_64 or aarch64 Linux. Needs curl, unzip, tar and
# sudo: no git checkout, no Rust, no C toolchain. Runs from a web terminal or as a first-boot
# setup script:
#
#   curl -fsSL https://raw.githubusercontent.com/jmandel/shlink-dicom/main/deploy/bootstrap-shlink-dicom.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/jmandel/shlink-dicom/main/deploy/bootstrap-shlink-dicom.sh | bash -s server-1a2b3c4
#
# With no argument it installs the release named in the server-latest release's latest.json; with a
# tag, that release. Rollback is running it with an older tag (a release already built here is
# reused).
#
# Steps:
#   1. pick the release build for this machine (linux-x86_64 or linux-aarch64; on x86_64 the
#      x86-64-v3 server when the CPU has the whole set, else the baseline one; SHL_CPU=baseline
#      forces the baseline); install the SQLite runtime library and a pinned Bun (checked by
#      SHA-256), which builds the sample;
#   2. download the release for this architecture, check its SHA-256, every file against its
#      MANIFEST.json and that the C library is new enough, and unpack it into $ROOT/releases/<tag>;
#   3. build the public sample with the release's code: the sandbox dataset (Josh Example,
#      de-identified, plus the CC BY slide) from its pinned sources (each checked by SHA-256, kept in
#      $ROOT/sources), checked against the release's expected digest, and its reports;
#   4. put the sample in $DATA/samples and seed it when it changed, point $ROOT/current at the
#      release, write the systemd unit, restart, and check /, /view/ and /sample; if that fails,
#      go back to the previous release.
# Server data lives in $DATA (/var/lib/shlink-dicom).
#
# Encrypted files are kept in $DATA/blobs unless $ENV_FILE (default /etc/shlink-dicom.env) names
# an S3 bucket, with lines such as these (SHL_S3_ENDPOINT only for a service other than AWS;
# SHL_S3_READ_MODE proxy or redirect, and redirect needs the bucket CORS in docs/storage.md):
#   SHL_S3_BUCKET=my-bucket
#   SHL_S3_ENDPOINT=https://s3.example.net
#   SHL_S3_REGION=us-east-1
#   SHL_S3_READ_MODE=proxy
#   AWS_ACCESS_KEY_ID=...
#   AWS_SECRET_ACCESS_KEY=...
# The seed and the service both read it; the file is made root-owned, mode 600.
# Log: /var/log/shlink-bootstrap.log

set -euo pipefail
trap 'echo "bootstrap-shlink-dicom: failed at line $LINENO" >&2' ERR

TAG="${1:-${TAG:-}}"
REPO="${REPO:-jmandel/shlink-dicom}"
ROOT="${ROOT:-/opt/shlink-dicom-server}"
DATA="${DATA:-/var/lib/shlink-dicom}"
PORT="${PORT:-8000}"
ORIGIN="${ORIGIN:-https://shlink-dicom.exe.xyz}"
MAX_SHARE_BYTES="${MAX_SHARE_BYTES:-20G}"  # per share; the sample is not counted
MAX_SHARES="${MAX_SHARES:-256}"         # shares at once
ENV_FILE="${ENV_FILE:-/etc/shlink-dicom.env}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
# Bun, pinned, for this architecture (the same block as in deploy/bootstrap-sandbox.sh).
BUN_VERSION="1.4.3"
case "$(uname -m)" in
  x86_64)
    if grep -qw avx2 /proc/cpuinfo; then BUN_BUILD=bun-linux-x64; BUN_SHA256=3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18
    else BUN_BUILD=bun-linux-x64-baseline; BUN_SHA256=1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b; fi ;;
  aarch64 | arm64) BUN_BUILD=bun-linux-aarch64; BUN_SHA256=efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21 ;;
  *) echo "no pinned Bun for $(uname -m) (x86_64 and aarch64 Linux are supported)" >&2; exit 1 ;;
esac
BUN="$ROOT/bun/bun-$BUN_VERSION"
# Where releases are downloaded from (CI points it at a local file:// directory to test one before publishing).
RELEASES="${RELEASES:-https://github.com/$REPO/releases/download}"

SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
# The log is written by this shell (tee, not under sudo), so it belongs to whoever runs this,
# readable by no one else.
$SUDO touch /var/log/shlink-bootstrap.log
$SUDO chown "$(id -u):$(id -g)" /var/log/shlink-bootstrap.log
$SUDO chmod 600 /var/log/shlink-bootstrap.log
exec > >(tee -a /var/log/shlink-bootstrap.log) 2>&1
echo "== bootstrap-shlink-dicom $(date -Is)"

# 1. The machine, and the runtime.
# Releases are built for linux-x86_64 (baseline x86-64, plus an x86-64-v3 build of the server) and
# linux-aarch64.
case "$(uname -m)" in
  x86_64) ARCH=x86_64 ;;
  aarch64 | arm64) ARCH=aarch64 ;;
  *) echo "no server release is built for $(uname -m); x86_64 and aarch64 Linux are" >&2; exit 1 ;;
esac
# On x86_64, the x86-64-v3 server when the CPU has the whole set (LZCNT shows as abm), unless
# SHL_CPU=baseline.
CPU=baseline
if [ "$ARCH" = x86_64 ] && [ "${SHL_CPU:-}" != baseline ]; then
  CPU=x86-64-v3
  for f in avx2 bmi1 bmi2 fma movbe f16c; do grep -qw "$f" /proc/cpuinfo || CPU=baseline; done
  grep -qwE 'abm|lzcnt' /proc/cpuinfo || CPU=baseline
fi
need=""
for c in curl unzip tar; do command -v "$c" >/dev/null || need="$need $c"; done
# The server links the system SQLite (libsqlite3.so.0).
dpkg -s libsqlite3-0 >/dev/null 2>&1 || need="$need libsqlite3-0"
if [ -n "$need" ]; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq $need; fi
$SUDO mkdir -p "$ROOT/releases" "$ROOT/sources" "$ROOT/bun"
$SUDO chown "$(id -u):$(id -g)" "$ROOT" "$ROOT/releases" "$ROOT/sources" "$ROOT/bun"
if [ ! -x "$BUN" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$BUN_BUILD.zip"
  echo "$BUN_SHA256  $tmp/bun.zip" | sha256sum -c --quiet
  unzip -q "$tmp/bun.zip" -d "$tmp"
  install -m 755 "$tmp/$BUN_BUILD/bun" "$BUN"
  rm -rf "$tmp"
fi
echo "bun $("$BUN" --version)"
manifest() { "$BUN" -e "console.log(JSON.parse(await Bun.file('$1/MANIFEST.json').text())['$2'])"; }

# 2. The release.
if [ -z "$TAG" ]; then
  TAG="$(curl -fsSL "$RELEASES/server-latest/latest.json" | "$BUN" -e 'console.log(JSON.parse(await Bun.stdin.text()).tag)')"
fi
case "$TAG" in server-[0-9a-f]*) ;; *) echo "not a server release tag: $TAG" >&2; exit 1 ;; esac
NAME="shlink-dicom-$TAG-linux-$ARCH"
DIR="$ROOT/releases/$TAG"
if [ -f "$DIR/.built" ]; then
  echo "release $TAG: already unpacked and built in $DIR"
else
  tmp="$(mktemp -d)"
  if ! curl -fsSL -o "$tmp/$NAME.tar.gz" "$RELEASES/$TAG/$NAME.tar.gz"; then
    echo "release $TAG has no $NAME.tar.gz: no build for linux-$ARCH in that release" >&2
    exit 1
  fi
  curl -fsSL -o "$tmp/$NAME.tar.gz.sha256" "$RELEASES/$TAG/$NAME.tar.gz.sha256"
  (cd "$tmp" && sha256sum -c --quiet "$NAME.tar.gz.sha256")
  echo "release $TAG: SHA-256 $(cut -d' ' -f1 "$tmp/$NAME.tar.gz.sha256") ok"
  rm -rf "$DIR" "$DIR.part"
  mkdir -p "$DIR.part"
  tar -xzf "$tmp/$NAME.tar.gz" -C "$DIR.part" --strip-components=1
  rm -rf "$tmp"
  (cd "$DIR.part" && "$BUN" -e '
    const m = JSON.parse(await Bun.file("MANIFEST.json").text());
    for (const f of m.files) {
      const h = new Bun.CryptoHasher("sha256").update(await Bun.file(f.path).bytes()).digest("hex");
      if (h !== f.sha256) { console.error(`${f.path}: SHA-256 differs from MANIFEST.json`); process.exit(1); }
    }
    console.log(`release ${m.tag}: commit ${m.commit}, ${m.files.length} files match MANIFEST.json; linux-${m.arch}, glibc ${m.glibc}, ${Object.entries(m.binaries).map(([f, c]) => `${f} (${c})`).join(", ")}`);')
  want="$(manifest "$DIR.part" glibc)"
  # (sed, not head: with pipefail, a reader that stops early fails the pipeline.)
  have="$(ldd --version 2>&1 | sed -n '1s/.* \([0-9][0-9]*\.[0-9][0-9]*\)$/\1/p')"
  if [ "$(printf '%s\n%s\n' "$want" "$have" | sort -V | sed -n 1p)" != "$want" ]; then
    echo "the release's server needs glibc $want or newer; this system has $have" >&2
    exit 1
  fi

  # 3. The public sample, built with the release's code.
  (cd "$DIR.part/imaging-sandbox" && "$BUN" scripts/build-data.ts --quiet --no-variants --export none --sources "$ROOT/sources")
  want="$(manifest "$DIR.part" sampleDigest)"
  got="$(sha256sum "$DIR.part/imaging-sandbox/build/dataset/SHA256SUMS" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    echo "sample dataset digest $got differs from the expected $want; $ROOT/current is unchanged" >&2
    exit 1
  fi
  echo "sample dataset matches the expected digest ($got)"
  # One archive per study (byte-stable, so an unchanged sample is not seeded again), its reports
  # (the sandbox's DiagnosticReports, PDF and text inline, which the seed adds to the Bundle), and
  # its title. The dataset itself is not kept.
  mkdir -p "$DIR.part/sample"
  for d in "$DIR.part"/imaging-sandbox/build/dataset/dicom/*/; do
    s="$(basename "$d")"
    tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - -C "$DIR.part/imaging-sandbox/build/dataset/dicom" "$s" | gzip -n > "$DIR.part/sample/$s.tgz"
  done
  (cd "$DIR.part" && "$BUN" deploy/sample-reports.ts imaging-sandbox/build/dataset sample)
  cat > "$DIR.part/sample/sample.json" <<'EOF2'
{
  "title": "Sample imaging: Josh Example",
  "description": "Brain MRI, CT of the abdomen and pelvis, and hand and wrist X-rays: real images of one person, de-identified as Josh Example and published by him. Also a lung pathology slide from a different person, from the NCI Imaging Data Commons (CPTAC-LUAD, CC BY 4.0), relabelled for this sample (see the study note)."
}
EOF2
  rm -rf "$DIR.part/imaging-sandbox/build"
  touch "$DIR.part/.built"
  chmod -R a+rX "$DIR.part"
  mv "$DIR.part" "$DIR"
fi

# 4. The sample share, the unit, and the switch.
# bin/server, which the seed and the unit run, links the build for this CPU.
SERVER_BIN=shl-dicom-server
if [ "$CPU" = x86-64-v3 ]; then
  if [ -x "$DIR/bin/shl-dicom-server.v3" ]; then SERVER_BIN=shl-dicom-server.v3; else echo "release $TAG has no x86-64-v3 build; using the baseline one"; fi
fi
ln -sfn "$SERVER_BIN" "$DIR/bin/server"
case "$SERVER_BIN" in
  *.v3) echo "server: bin/$SERVER_BIN (x86-64-v3: this CPU has AVX2, BMI1/2, FMA, MOVBE, LZCNT and F16C)" ;;
  *) echo "server: bin/$SERVER_BIN (linux-$ARCH baseline${SHL_CPU:+, SHL_CPU=$SHL_CPU})" ;;
esac
id shlink >/dev/null 2>&1 || $SUDO useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin shlink
$SUDO mkdir -p "$DATA/samples"
$SUDO rm -f "$DATA"/samples/*.tgz
$SUDO cp "$DIR"/sample/*.tgz "$DIR/sample/reports.json" "$DIR/sample/sample.json" "$DATA/samples/"
# One-time wipe for the blob-store layout (random storage keys, the files and uploads tables):
# shares made before it can't be read. Only the sample matters, and it is packed again below.
LAYOUT=blob-store-1
if [ -d "$DATA/shares" ] && [ "$(cat "$DATA/.layout" 2>/dev/null)" != "$LAYOUT" ]; then
  $SUDO systemctl stop shlink-dicom 2>/dev/null || true
  $SUDO rm -rf "$DATA/catalog.db" "$DATA"/catalog.db-* "$DATA/shares" "$DATA/blobs" "$DATA/seeded_demos.json"
  echo "== one-time wipe: shares from before the blob-store layout removed; the sample is packed again"
fi
echo "$LAYOUT" | $SUDO tee "$DATA/.layout" >/dev/null
$SUDO chown -R shlink:shlink "$DATA"
if [ -f "$ENV_FILE" ]; then
  $SUDO chown root:root "$ENV_FILE"
  $SUDO chmod 600 "$ENV_FILE"
fi
# Pack the sample into its share when it changed (or there is none). The server only loads it, so
# restarts are immediate. Packing streams one record at a time from scratch files in $DATA.
# A change to $ENV_FILE (a different store) also packs it again.
store_env() { $SUDO cat "$ENV_FILE" 2>/dev/null || true; }
sums="$( (cd "$DATA/samples" && sha256sum *.tgz sample.json reports.json; store_env | sha256sum) | sha256sum | cut -d' ' -f1)"
if [ "$(cat "$DATA/samples/.sums" 2>/dev/null)" != "$sums" ] || [ ! -f "$DATA/seeded_demos.json" ]; then
  # Read as systemd reads an EnvironmentFile: KEY=value lines, # and ; comments, surrounding
  # whitespace and one pair of quotes around the value removed.
  store_env | sudo -u shlink sh -c 'while read -r l; do
      case "$l" in [A-Za-z_]*=*) ;; *) continue ;; esac
      k=$(printf %s "${l%%=*}" | tr -d " \t"); v=${l#*=}; v=${v#"${v%%[! ]*}"}
      case "$v" in \"*\") v=${v#\"}; v=${v%\"} ;; \'"'"'*\'"'"') v=${v#\'"'"'}; v=${v%\'"'"'} ;; esac
      export "$k=$v"
    done
    exec "$0" seed --data-dir "$1"' "$DIR/bin/server" "$DATA"
  echo "$sums" | $SUDO tee "$DATA/samples/.sums" >/dev/null
fi

$SUDO tee /etc/systemd/system/shlink-dicom.service >/dev/null <<EOF
[Unit]
Description=shlink-dicom server and web app
After=network-online.target
Wants=network-online.target

[Service]
User=shlink
WorkingDirectory=$ROOT/current
Environment=PORT=$PORT
Environment=SHL_DICOM_DATA_DIR=$DATA
# The only source of absolute URLs; forwarded headers are not trusted.
Environment=SHL_PUBLIC_ORIGIN=$ORIGIN
# Upload limits (see shl-dicom-server serve --help). 0 means no limit.
Environment=SHL_MAX_SHARE_BYTES=$MAX_SHARE_BYTES
Environment=SHL_MAX_SHARES=$MAX_SHARES
# The S3 store, when $ENV_FILE exists.
EnvironmentFile=-$ENV_FILE
ExecStart=$ROOT/current/bin/server serve
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

PREVIOUS="$(readlink "$ROOT/current" 2>/dev/null || true)"
switch_to() { ln -sfn "$1" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"; }
code() { curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT$1"; }
healthy() {
  for _ in $(seq 1 60); do curl -sf "http://localhost:$PORT/api/demo-shares" >/dev/null && break; sleep 1; done
  local root view sample
  root="$(code /)"; view="$(code /view/)"
  sample="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://localhost:$PORT/sample")"
  echo "/ $root, /view/ $view, /sample $sample" | cut -c1-140
  [ "$root" = 200 ] && [ "$view" = 200 ] && [[ "$sample" == 30[27]\ *"#shlink:/"* ]]
}
switch_to "$DIR"
$SUDO systemctl daemon-reload
$SUDO systemctl enable shlink-dicom >/dev/null 2>&1
$SUDO systemctl restart shlink-dicom
if ! healthy; then
  echo "release $TAG: the server did not come up as expected on port $PORT" >&2
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$DIR" ]; then
    echo "going back to $PREVIOUS" >&2
    [ -e "$PREVIOUS/bin/server" ] || ln -sfn shl-dicom-server "$PREVIOUS/bin/server"  # a release installed before bin/server
    switch_to "$PREVIOUS"
    $SUDO systemctl restart shlink-dicom
    healthy || echo "the previous release did not come up either" >&2
  fi
  exit 1
fi
systemctl is-active shlink-dicom
echo "$TAG" > "$ROOT/current-tag"

# Releases other than the current one and the $KEEP_RELEASES - 1 most recent are removed.
ls -1dt "$ROOT"/releases/server-* 2>/dev/null | { grep -v -x "$DIR" || true; } | tail -n "+$KEEP_RELEASES" | xargs -r rm -rf
echo "== done: $TAG at $ORIGIN"
