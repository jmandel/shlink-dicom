#!/bin/bash
# Builds libjxl 0.12.0 for wasm32 with simd128 (single-threaded) and the bench wrapper
# decoder.cpp into dist/ (not committed). Needs the Emscripten SDK (emcc on PATH, or EMSDK set),
# cmake and git. The libjxl source and build go to $LIBJXL_WASM_WORK (default
# codecs/target/libjxl-wasm). The result was built with emscripten 6.0.12.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${LIBJXL_WASM_WORK:-$HERE/../../../target/libjxl-wasm}
[ -n "${EMSDK:-}" ] && source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
command -v emcc >/dev/null || { echo "emcc not found: install the Emscripten SDK" >&2; exit 1; }
mkdir -p "$WORK"
if [ ! -d "$WORK/libjxl" ]; then
  git clone -q --depth 1 --branch v0.12.0 https://github.com/libjxl/libjxl.git "$WORK/libjxl"
  git -C "$WORK/libjxl" submodule update -q --init --depth 1 third_party/highway third_party/brotli third_party/skcms
fi
B="$WORK/build"
mkdir -p "$B"
emcmake cmake -S "$WORK/libjxl" -B "$B" -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF -DBUILD_SHARED_LIBS=OFF \
  -DJPEGXL_ENABLE_TOOLS=OFF -DJPEGXL_ENABLE_DEVTOOLS=OFF -DJPEGXL_ENABLE_BENCHMARK=OFF -DJPEGXL_ENABLE_EXAMPLES=OFF \
  -DJPEGXL_ENABLE_JPEGLI=OFF -DJPEGXL_ENABLE_SJPEG=OFF -DJPEGXL_ENABLE_OPENEXR=OFF -DJPEGXL_ENABLE_DOXYGEN=OFF \
  -DJPEGXL_ENABLE_MANPAGES=OFF -DJPEGXL_ENABLE_JNI=OFF -DJPEGXL_ENABLE_SKCMS=ON -DJPEGXL_BUNDLE_LIBPNG=OFF \
  -DJPEGXL_ENABLE_PLUGINS=OFF -DCMAKE_C_FLAGS=-msimd128 -DCMAKE_CXX_FLAGS=-msimd128 >/dev/null
emmake make -C "$B" -j"$(nproc)" jxl_dec >/dev/null
mkdir -p "$HERE/dist"
em++ -O3 -msimd128 -lembind "$HERE/decoder.cpp" -I"$WORK/libjxl/lib/include" -I"$B/lib/include" \
  "$B/lib/libjxl_dec.a" "$B/third_party/brotli/libbrotlidec.a" "$B/third_party/brotli/libbrotlicommon.a" \
  "$B/third_party/highway/libhwy.a" -sMODULARIZE=1 -sEXPORT_NAME=libjxlwasm -sALLOW_MEMORY_GROWTH=1 \
  -sMAXIMUM_MEMORY=4GB -sENVIRONMENT=web,worker -fexceptions -o "$HERE/dist/libjxlwasm_decode.js"
echo "built $HERE/dist/libjxlwasm_decode.js"
