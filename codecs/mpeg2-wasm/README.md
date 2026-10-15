# mpeg2-wasm: the MPEG-2 video decoder for /view

No browser plays MPEG-2 video, and WebCodecs has no MPEG-2 decoder. DICOM MPEG-2 video (transfer syntaxes 1.2.840.10008.1.2.4.100, .101 and their fragmentable .100.1 and .101.1 forms) is decoded by FFmpeg compiled to WebAssembly.

The build contains:
- libavformat with the MPEG-PS, MPEG-TS and raw MPEG video demuxers;
- libavcodec with the MPEG-1 and MPEG-2 video decoders and the MPEG video parser;
- libavutil.

There are no encoders, no filters and no scaler. `mpeg2dec.c` puts five functions in front of them (`dec_open`, `dec_info`, `dec_next`, `dec_seek`, `dec_close`) and reads the stream through a JavaScript callback.

| File | What |
|---|---|
| `ffmpeg-source.json` | The FFmpeg version, its release URL and SHA-256. `build.sh` and `web/build.ts` both read it. |
| `build.sh` | Downloads FFmpeg 7.1.1, checks its SHA-256, configures it, and builds it with Emscripten 3.1.74 in Docker (`emscripten/emsdk:3.1.74`). |
| `mpeg2dec.c` | The wrapper. |
| `dist/mpeg2dec.js`, `dist/mpeg2dec.wasm` | The build output (about 17 KB and 620 KB), committed so that the site builds without Docker. |
| `dist/COPYING.LGPLv2.1` | FFmpeg's licence text, taken from the tarball. |
| `dist/ffmpeg-7.1.1.tar.xz` | The exact FFmpeg source, 11 MB. Not committed: `web/build.ts` (or `build.sh`) fetches it from ffmpeg.org and checks its SHA-256. |

`web/build.ts` copies all of these into `dist/web/assets/`, with the wrapper source in `assets/mpeg2dec-source/`.

In the viewer:
- `web/core/video-mpeg2-worker.ts` runs the decoder in a worker;
- `web/core/video-mpeg2.ts` draws the frames on a canvas;
- the page loads both only when a study contains MPEG-2 video.

## Licence: what we must do

The configure step runs without `--enable-gpl`, `--enable-version3` and `--enable-nonfree`. FFmpeg's generated `config.h` confirms the result: `FFMPEG_LICENSE "LGPL version 2.1 or later"`, `CONFIG_GPL 0`, `CONFIG_NONFREE 0`. So the decoder is under the GNU LGPL 2.1 or later. None of the enabled components is GPL-only.

Our wrapper and viewer code are a "work that uses the Library" (LGPL 2.1 §5–6). We distribute the library compiled into `mpeg2dec.wasm`, so we must:

1. **Say that FFmpeg is used, and under which licence.** The player shows "Decoded with FFmpeg (LGPL)" below the picture, linked to the licence text and the source.
2. **Ship the licence text.** It is served at `assets/ffmpeg-COPYING.LGPLv2.1.txt`.
3. **Offer the complete corresponding source of the library, from the same place as the binary (§6(d)).** We serve the exact upstream tarball as `assets/ffmpeg-7.1.1.tar.xz`, beside the wasm. We made no changes to FFmpeg; the configure flags are in `build.sh`.
4. **Let users relink against a modified FFmpeg (§6(a)).**
   - Our wrapper source and build script are served in `assets/mpeg2dec-source/`, and are in this repository.
   - `build.sh` rebuilds `mpeg2dec.wasm` from a changed FFmpeg tree.
   - The decoder is a separate file the page fetches, so a user can swap it for their own build.
5. **Add no terms that forbid modifying the library or reverse-engineering it for debugging.** We have none.

Not required:
- releasing our own code under the LGPL;
- a written offer, because the source is served next to the binary rather than on request.

`web/build.ts` fetches the tarball when it is missing and fails on a checksum mismatch, so every build of the site serves the source beside the decoder.

## Rebuilding

```sh
codecs/mpeg2-wasm/build.sh        # about 2 minutes; work files in /media/barracuda/shlink-video/mpeg2-build
bun web/build.ts
```

Checks: `web/checks/video-checks.mjs` covers the MPEG-2 cases:
- MPEG-TS SD with MP2 audio;
- MPEG-PS HD in fragments;
- ETIAM_video_002, an elementary stream, from fo-dicom.

For each case it checks the frame count, the duration, the first frame against ffmpeg's decode, frame stepping, and playback to the last frame in real time.
