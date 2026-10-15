#!/usr/bin/env bash
# Builds the MPEG-2 video decoder used by /view for MPEG-2 DICOM video (.100, .101 and .x.1):
# FFmpeg's libavformat + libavcodec, LGPL-2.1-or-later configuration (no --enable-gpl, no
# --enable-nonfree), with only the MPEG-2 decoder, its parser and the MPEG-PS, MPEG-TS and raw
# MPEG video demuxers, compiled to WebAssembly with Emscripten in a pinned Docker image.
#
#   codecs/mpeg2-wasm/build.sh            → codecs/mpeg2-wasm/dist/mpeg2dec.{js,wasm}
#
# The exact FFmpeg source used is downloaded, checked against its SHA-256, and copied next to the
# output (dist/ffmpeg-<version>.tar.xz) so it can be published with the decoder (LGPL §6).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# Version and checksum: ffmpeg-source.json (web/build.ts reads the same file).
FFMPEG_VERSION=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$here/ffmpeg-source.json")
FFMPEG_SHA256=$(sed -n 's/.*"sha256": "\(.*\)".*/\1/p' "$here/ffmpeg-source.json")
EMSDK_IMAGE=emscripten/emsdk:3.1.74
work="${MPEG2_WASM_WORK:-/media/barracuda/shlink-video/mpeg2-build}"
mkdir -p "$work" "$here/dist"
tarball="$work/ffmpeg-$FFMPEG_VERSION.tar.xz"
if [ ! -f "$tarball" ]; then
  curl -fsSL -o "$tarball.part" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
  mv "$tarball.part" "$tarball"
fi
echo "$FFMPEG_SHA256  $tarball" | sha256sum -c -
cp "$tarball" "$here/dist/"
tar -xOf "$tarball" "ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv2.1" > "$here/dist/COPYING.LGPLv2.1"

docker run --rm -u "$(id -u):$(id -g)" -v "$work:/work" -v "$here:/src" -e FFMPEG_VERSION="$FFMPEG_VERSION" "$EMSDK_IMAGE" bash -euc '
cd /work
if [ ! -f ffmpeg-$FFMPEG_VERSION/.built ]; then
  rm -rf ffmpeg-$FFMPEG_VERSION && tar xf ffmpeg-$FFMPEG_VERSION.tar.xz
  cd ffmpeg-$FFMPEG_VERSION
  emconfigure ./configure --prefix=/work/prefix --target-os=none --arch=x86_32 --enable-cross-compile \
    --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
    --disable-everything --disable-programs --disable-doc --disable-network --disable-autodetect \
    --disable-asm --disable-inline-asm --disable-x86asm --disable-pthreads --disable-w32threads --disable-os2threads \
    --disable-debug --disable-runtime-cpudetect --disable-swresample --disable-swscale --disable-avfilter --disable-avdevice --disable-postproc \
    --enable-small --extra-cflags="-O3" \
    --enable-decoder=mpeg2video,mpeg1video --enable-parser=mpegvideo \
    --enable-demuxer=mpegps,mpegts,mpegvideo --enable-protocol=file
  emmake make -j"$(nproc)"
  emmake make install
  touch .built
  cd /work
fi
emcc -O3 -I/work/prefix/include /src/mpeg2dec.c /work/prefix/lib/libavformat.a /work/prefix/lib/libavcodec.a /work/prefix/lib/libavutil.a \
  -o /src/dist/mpeg2dec.js -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=worker -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=1gb \
  -sEXPORTED_FUNCTIONS=_dec_open,_dec_next,_dec_seek,_dec_close,_dec_info,_malloc,_free -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32,HEAPF64,addFunction \
  -sALLOW_TABLE_GROWTH=1 -sFILESYSTEM=0
'
ls -la "$here/dist"
