#!/bin/sh
# Builds everything the benchmark loads: native bench, wasm (base, simd128, each also after
# wasm-opt -O3) and bench/record-decrypt.js from record-decrypt.ts.
set -e
cd "$(dirname "$0")"
CARGO="$HOME/.cargo/bin/cargo +stable"
WASM_OPT="${WASM_OPT:-$HOME/.local/bin/wasm-opt}"
mkdir -p out
( cd rust
  $CARGO build --release --quiet
  RUSTFLAGS="--cfg aes_force_soft --cfg polyval_force_soft" CARGO_TARGET_DIR=target/soft $CARGO build --release --quiet
  CARGO_TARGET_DIR=target/wasm-base $CARGO build --release --lib --quiet --target wasm32-unknown-unknown
  RUSTFLAGS="-C target-feature=+simd128" CARGO_TARGET_DIR=target/wasm-simd $CARGO build --release --lib --quiet --target wasm32-unknown-unknown )
cp rust/target/wasm-base/wasm32-unknown-unknown/release/decrypt_spike.wasm out/wasm-base.wasm
cp rust/target/wasm-simd/wasm32-unknown-unknown/release/decrypt_spike.wasm out/wasm-simd.wasm
F="--enable-bulk-memory --enable-bulk-memory-opt --enable-sign-ext --enable-nontrapping-float-to-int --enable-mutable-globals --enable-multivalue --enable-reference-types"
"$WASM_OPT" -O3 $F out/wasm-base.wasm -o out/wasm-base-opt.wasm
"$WASM_OPT" -O3 $F --enable-simd out/wasm-simd.wasm -o out/wasm-simd-opt.wasm
[ -f fixtures/wrist.bin ] || (cd ../.. && bun perf-spikes/decrypt/make-fixtures.ts >/dev/null)
bun build ../../viewer-kit/src/record-decrypt.ts --target browser --outfile bench/record-decrypt.js >/dev/null
echo built
