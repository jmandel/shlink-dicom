# viewer-kit performance

Measured 2026-10-15 in headless Chromium 154 on an AMD Ryzen 5 3600 (6 cores, 12 threads), with `node viewer-kit/bench/run.mjs`. The raw results are in `bench/results/`.

**Machine load.** Other agents were running on the machine throughout. The load average was 13.6–14.4 during the pool run and 12.6–15.8 during the window/level runs, on 12 hardware threads. Absolute times are therefore pessimistic, and scaling above 4 workers is understated. Re-run on a quiet machine before quoting the numbers as final.

**No hardware GPU.** The NVIDIA driver on this machine was unusable: `nvidia-smi` reports "Driver/library version mismatch", which needs a reboot. Headless Chromium could only use WebGL backends that rasterise on the CPU:
- SwiftShader, Chromium's default;
- Mesa llvmpipe, with `VK_ANGLE=gl-egl`.

The GPU timings below therefore measure software rasterisers. On a real GPU, drawing a full-screen triangle with four texel fetches per pixel takes well under a millisecond. To measure that here, run `node viewer-kit/bench/run.mjs wl` after the reboot.

## Decoder pool scaling

**Method.** All instances are fetched into memory first. The timed region is `Promise.all(files.map(f => pool.decode(f.slice(0))))`, so the timings include:
- one copy of the input on the main thread;
- the transfer to the worker;
- the copy into wasm memory;
- the decode;
- the copy out of wasm memory and the transfer back.

Each figure is the median of 3 runs, after one warm-up run per pool size. Every decoded slice of the CT series was compared with the seed volume, and all 100 were identical for every encoder.

**CT series:** 100 slices, 512², 12 bits stored in 16 (`bench/make_series.py`, a synthetic phantom with per-slice variation). Times are wall-clock ms for the whole series.

| Transfer syntax | Size | 1 worker | 2 | 4 | 8 | 8 vs 1 |
|---|---:|---:|---:|---:|---:|---:|
| Explicit VR LE (uncompressed) | 52.5 MB | 116 | 125 | 75 | 72 | 1.6× |
| RLE | 15.8 MB | 109 | 60 | 47 | 40 | 2.7× |
| JPEG Lossless SV1 | 15.3 MB | 268 | 195 | 111 | 101 | 2.7× |
| JPEG-LS lossless | 11.2 MB | 520 | 270 | 191 | 156 | 3.3× |
| JPEG 2000 lossless | 12.4 MB | 3729 | 1847 | 879 | 672 | 5.5× |
| HTJ2K lossless | 13.2 MB | 3414 | 1644 | 966 | 692 | 4.9× |

**Large multi-frame instances,** with `pool.decodeFrames`. The frames are split into one range per worker; with 1 worker the instance is one job.

| Instance | 1 worker | 2 | 4 | 8 | 8 vs 1 |
|---|---:|---:|---:|---:|---:|
| MG tomosynthesis, 1890×2457 × 22 frames, 16-bit, J2K lossless (12.5 MB) | 4062 | 2350 | 1446 | 1111 | 3.7× |
| Slide tiles, 256² × 888 RGB, J2K (8.1 MB) | 5386 | 2806 | 1583 | 1084 | 5.0× |
| US, 640×480 × 120 RGB, JPEG baseline (6.1 MB) | 472 | 355 | 387 | 251 | 1.9× |
| XA, 512² × 67, 8-bit, JPEG lossless (5.7 MB) | 198 | 121 | 95 | 94 | 2.1× |

**What the numbers say:**
- **Slow codecs scale best.** For JPEG 2000 and HTJ2K the decode dominates, and scaling is close to linear up to 4 workers.
- **Fast codecs scale less.** For RLE, JPEG Lossless and uncompressed data, the per-instance overhead dominates: about 0.5–1 ms per 512² slice in copies and messages. Scaling stops at about 4 workers.
- **The default pool size is right.** `hardwareConcurrency − 1`, capped at 8, is a good default. On this 6-core machine, 8 workers gain little over 4.
- **Per-slice decode cost in one worker:**
  - JPEG 2000: about 37 ms;
  - HTJ2K: about 34 ms;
  - JPEG-LS: about 5 ms;
  - JPEG Lossless: about 2.7 ms;
  - RLE: about 1 ms.

  HTJ2K costing about the same as JPEG 2000 is unexpected, since HTJ2K's block coder is designed to be several times faster. It is a codec matter (`shl-codec-htj2k`), not a pool matter.

## Window/level drag

**Method.** 120 window/level changes in a row, each followed by waiting for the next animation frame. Reported values are medians (p90 in brackets), in ms.

- **GPU, submit:** setting uniforms and `drawArrays` on the main thread.
- **GPU, complete:** submit plus a 1-pixel `readPixels`, so the time includes rasterisation. `gl.finish()` does not block in Chromium.
- **Current CPU path:** a faithful JS port of today's `render_instance_rgba` path (`legacyToRgba`). For each change it:
  1. builds RGBA from cached f32 values;
  2. makes the copy `rgba_bytes()` makes;
  3. calls `putImageData` at image size.
- **viewer-kit CPU fallback:** `renderCpu`, which includes zoom and pan, into the GL canvas size, plus `putImageData`.
- **Frame interval:** the time between animation frames during the drag. 16.7 ms means 60 fps.

**512² 16-bit CT slice, canvas 512²**

| Path | Submit | Complete | Frame interval |
|---|---:|---:|---:|
| GPU on llvmpipe | 0.06 | 2.7 (4.1) | 16.7 |
| GPU on SwiftShader | 0.06 | 8.9 (10.6) | 16.7 |
| Current CPU path (RGBA re-render) | – | 5.5 (8.8)* | 16.7 |
| viewer-kit CPU fallback | – | 3.2 | – |

\* 2.9 ms (3.5) in the SwiftShader run. The runs differ only in machine load.

**2048² 16-bit DX, canvas 2048²**

| Path | Submit | Complete | Frame interval |
|---|---:|---:|---:|
| GPU on llvmpipe | 0.05 | 32.5 (41.5) | 33.3 |
| GPU on SwiftShader | 0.07 | 131 (165) | 150 |
| Current CPU path (RGBA re-render) | – | 31–35 (34–40) | 33.3 |
| viewer-kit CPU fallback | – | 36–55 | – |

**2048² 16-bit DX, canvas 1920×1080** (the GPU and fallback paths draw at canvas size; the current path still renders the whole image)

| Path | Submit | Complete | Frame interval |
|---|---:|---:|---:|
| GPU on llvmpipe | 0.05 | 22.7 | 16.7 |
| GPU on SwiftShader | 0.07 | 64 | 67 |
| Current CPU path | – | 32–35 | 33.3 |
| viewer-kit CPU fallback | – | 20 | – |

**What the numbers say:**
- **The GPU path barely touches the main thread.** It costs 0.05–0.07 ms of main-thread time per window change at any image size, against 3 ms (512²) and 31–35 ms (2048²) for the current path. The current path drops to 30 fps on a 2048² image even with nothing else to do.
- **Even a software GL keeps up.** llvmpipe matches or beats the current CPU path. On a hardware GPU the GPU column will be a small fraction of a millisecond.
- **SwiftShader is the one bad case.** It is slower than the CPU path (131 ms against 31 ms at 2048²), so `createRenderer()` detects it (`isSwiftShader()`) and uses `CpuRenderer` instead. The demo passes `allowSoftwareGl: true`, so it always shows the GL path.

## Shader against the CPU reference

`node viewer-kit/test/gl-vs-cpu.mjs` covers 17 corpus frames:
- CT, DX, CR, MONOCHROME1 (unsigned and signed), signed 8-of-16 bit, signed 12-bit, 8-bit XA, 1-bit SEG, 32-bit RT dose;
- three PALETTE COLOR images (8-bit, 16-bit, signed);
- RGB at 8 bits (twice) and 16 bits.

For each frame it renders 9 views with `GlRenderer` into an OffscreenCanvas, reads them back, and compares every RGBA sample with `renderCpu`. The views are: default window, narrow window (7), threshold (window width 1), wide and inverted, a colour map, and nearest and linear sampling at 1:1, ×2.37 with pan, and ×0.61.

**Tolerance: ±1 per 8-bit sample.**
- **Why there are differences at all.** The shader evaluates the window in float32 and the CPU in float64. A value within float32 rounding of a `k + 0.5` quantisation boundary can land one level apart. Linear sampling adds float32 interpolation weights.
- **No sample was ever off by more than 1.** The results were identical on SwiftShader and on llvmpipe.

| View | Samples differing by 1 | Of |
|---|---:|---:|
| 1:1 nearest, 1:1 linear, threshold, wide+invert, colour map, ×2.37 nearest | 0 | 54.8 M each |
| narrow window (7), 1:1 | 159 (all on one CT image, at exact .5 ties) | 54.8 M |
| ×2.37 + pan, linear | 3,796 | 54.8 M |
| ×0.61, linear | 2,738 | 54.8 M |

Palette and 1-bit images never differ. A lose/restore context cycle (`WEBGL_lose_context`) redraws pixel-identically on every case.

## Decoder correctness in the pool's wasm

`bun viewer-kit/test/verify-oracle.ts` checks the exact `.wasm` the workers load against the codec-corpus oracle for every case, using the comparison in `check.py`: equal within `max_abs`, and exit 2 for `expect=error`.

| Format | Pass | Unsupported |
|---|---:|---:|
| uncompressed | 241 | 2 |
| rle | 53 | – |
| jpeg-dct | 139 | – |
| jpeg-lossless | 208 | – |
| jpeg-ls | 69 | – |
| jpeg2000 | 166 | – |
| htj2k | 40 | – |

- **The 2 unsupported cases:** `ext-orthanc-2026-05-26-oob-monochrome-46341` and `-65535`. They return exit 3 "image too large", because their frame size overflows wasm32's 4 GiB address space.
- **Frame ranges:** for the 150 multi-frame encapsulated cases, decoding the frames as 3 ranges (the `decodeFrames` path) gave bytes identical to the whole-file decode.
- **CT series:** the bench also verified all 100 slices of each CT series against the seed volume.

## Reproduce

```sh
node viewer-kit/scripts/build.mjs                                  # wasm (simd128, fat LTO) + bundles
uv run --project codec-corpus python viewer-kit/bench/make_series.py   # CT series -> viewer-kit/data/
bun  viewer-kit/test/verify-oracle.ts [--per-format 6]             # pool wasm vs oracle
bun  viewer-kit/test/scaled.ts [--per-format 4]                   # pool wasm at scale 1-3 vs native decode_file_scaled
node viewer-kit/test/pool.mjs                                      # pool behaviour
node viewer-kit/test/gl-vs-cpu.mjs                                 # shader vs CPU reference
node viewer-kit/bench/run.mjs [pool|wl]                            # this file's numbers
VK_ANGLE=gl-egl node viewer-kit/bench/run.mjs wl                   # same, on llvmpipe
node viewer-kit/scripts/serve.mjs                                  # demo at http://localhost:8787/kit/demo/
```
