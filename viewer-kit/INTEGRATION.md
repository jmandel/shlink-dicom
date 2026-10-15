# Using viewer-kit

viewer-kit is the browser's decoding and rendering layer. `web/core` (`images.ts`, `render.ts`) is its user:
- **Decrypting and decoding:** a pool of workers verifies and decrypts series records (WebCrypto) and decodes instances (`shl_dicom_decode.wasm`) off the main thread.
- **Caching:** raw frames are cached, not RGBA.
- **Rendering:** window/level, zoom and pan are WebGL uniforms, with a CPU fallback.

## What to ship

Build it with `node viewer-kit/scripts/build.mjs`. That builds both wasm modules into `viewer-kit/dist/`. `web/build.ts` bundles the worker and the API and copies the wasm into `dist/web/assets/`; both `.wasm` files must sit side by side there.

| File | What it is |
|---|---|
| `shl_dicom_decode.wasm` | 1209 KiB, 387 KiB gzip. `shl_dicom_decode::decode_file` built with simd128 and fat LTO, from `codecs/shl-dicom-decode-wasm`, without JPEG XL |
| `shl_dicom_decode_jxl.wasm` | 2714 KiB, 912 KiB gzip. The same decoder with JPEG XL (jxl-oxide, `--features jpegxl`). Fetched only when a JPEG XL instance arrives; see [JPEG XL](#jpeg-xl) |
| `decoder-worker.js` | the worker script; must be a separate file |
| the API | `viewer-kit/src/index.ts`; `web/core` imports it and bun bundles it |

The pool needs no COOP/COEP headers. If a Content-Security-Policy is ever added, it needs `worker-src 'self'` and `script-src 'wasm-unsafe-eval'`.

## API

```ts
import { DecoderPool, Priority, FrameCache, createRenderer, frameOf, defaultWindow,
         DicomDecodeError, InvalidDicomError, UnsupportedDicomError,
         RecordAuthenticationError } from "../viewer-kit/src/index";

const pool = await DecoderPool.create({ wasm: "shl_dicom_decode.wasm", workerUrl: "decoder-worker.js" });
// workers: navigator.hardwareConcurrency - 1, capped at 8; override with { workers: n }
// jxlWasm: the JPEG XL module; default shl_dicom_decode_jxl.wasm next to `wasm` (see "JPEG XL")

const img = await pool.decode(bytes, { priority: Priority.Visible, key, signal });
const img2 = await pool.decode(ciphertext, { encrypted: { key: cryptoKey, firstRecord, seriesPlaintextLength, window } });
const plain = await pool.decrypt(ciphertext, { key: cryptoKey, firstRecord, seriesPlaintextLength, window });
// img: DecodedImage = canonical pixels (CONTRACT.md) + rows, columns, frames, samplesPerPixel,
//      bitsAllocated, bitsStored, pixelRepresentation, float, photometric, rescaleSlope/Intercept,
//      windowCenter/Width (first value, or null), minValue/maxValue, realWorldValueMapping,
//      frameOffsets, palette, decodeMs

const all = await pool.decodeFrames(bytes, { priority, signal, onChunk });  // multi-frame, split over workers

const thumb = await pool.decode(bytes, { scale: 3, key: `${key}@1/8` });   // 1/8 size; see "Thumbnails"

const renderer = createRenderer(canvas);     // WebGL2, or CpuRenderer on SwiftShader or without WebGL2
renderer.setFrame(frameOf(img, k), { windowCenter, windowWidth });   // uploads once
renderer.setView({ windowCenter, windowWidth, zoom, panX, panY, interpolation, invert });  // uniforms only
```

**Pool behaviour:**
- **Priorities.** `Visible` (0) runs before `Near` (1), which runs before `Prefetch` (2). A job starts only when a worker is free, so the slice on screen goes next.
- **`key`.** A second `decode` with the same key returns the first job's promise, and raises that job's priority if it is still queued. Use `${fileId}/${instance}` as the key.
- **`signal`.** Aborting a queued job removes it. Aborting a running job rejects its promise at once and drops the result when it arrives; wasm cannot be interrupted.
- **Transfer.** The input `ArrayBuffer` is transferred, so the caller's copy is detached. Pass `copy: true` to keep it. Output pixels come back transferred too.

**Errors:**

| Error | When | What `web/` should do |
|---|---|---|
| `InvalidDicomError` | decoder exit 2: the file is malformed | show `e.decoderMessage` with the slice |
| `UnsupportedDicomError` | exit 3: for example video syntaxes, JPIP, an image too large for wasm32 | same |
| `DecoderCrashError` | the wasm trapped | the worker has already restarted itself; report it as a bug |
| `RecordAuthenticationError` | an `encrypted` input or `decrypt` job: a record failed its AES-GCM check, or its length is wrong for its place | refuse the image; nothing from that record reached the decoder |

## Encrypted input

Series files (PROPOSAL.md §9) are decrypted in the workers, so the main thread never runs AES and the series key never enters wasm memory. `record-decrypt.ts` (WebCrypto) does the work; `web/core` calls it through the pool:

```ts
const key = await importSeriesKey(rawKey);   // non-extractable, decrypt-only; posted with each job
const encrypted = {
  key,
  firstRecord: plan.firstRecord,                                  // first record in the ciphertext
  seriesPlaintextLength: series.plaintextLength,                  // for the record-length checks
  window: { start: plan.plaintextStart - plan.firstRecord * 65520, length: plan.plaintextEnd - plan.plaintextStart },
};
const img = await pool.decode(ciphertext, { encrypted, key: `${fileId}/${i}`, priority });  // decrypt + decode in one job
const bytes = await pool.decrypt(ciphertext, encrypted);                                     // plaintext back (downloads, slide records)
```

- **What the worker checks.** Every record's tag, and that each record's length is right for its position in the series. A failure rejects with `RecordAuthenticationError(recordIndex, reason)`; no byte of that record is decoded or returned.
- **Copies.** The ciphertext is transferred to the worker; each record's plaintext is copied once, into a buffer of exactly the window's size, which goes to the decoder.
- **`decodeFrames` with `encrypted`** decrypts on one worker first, then shares out the plaintext.
- `record-decrypt.ts` also runs on the main thread or in Bun (`decryptRecords`), which `web/core`'s `WebCryptoDecryptor` uses where a page wants plaintext itself.

## JPEG XL

JPEG XL (.110–.112) more than doubles the decoder, so it lives in a second module, `shl_dicom_decode_jxl.wasm`, and callers don't change:

- **Lazy.** A worker reads the transfer syntax from the file meta before decoding. For JPEG XL it asks the pool for the second module; the pool fetches and compiles it once, the first time any worker asks, and sends the compiled module to each worker that needs it. Other instances never load it.
- **Where it comes from.** `PoolOptions.jxlWasm`: a URL or a compiled module. When it is left out and `wasm` is a URL, the pool uses `shl_dicom_decode_jxl.wasm` next to it; when `wasm` is a module, there is none. `jxlWasm: null` turns JPEG XL off.
- **Without it,** a JPEG XL instance fails with `UnsupportedDicomError`, as does a failed fetch (which is retried on the next JPEG XL instance).
- **Output.** Colour comes back as RGB. There is no reduced decode: `scale` decodes at full size and box-averages.
- `test/pool.mjs` checks that the module is not fetched for other syntaxes, and that a JPEG XL instance decodes through it on two workers.

## Float pixel data

Parametric maps and other derived images may carry Float Pixel Data (f32) or Double Float Pixel Data (f64) instead of integers. The decode result says so:

- **`img.float`** is true, `bitsAllocated` is 32 or 64, `pixelRepresentation` is 0 and `bitsStored` equals `bitsAllocated`.
- **`pixels`** hold the stored values as little-endian f32 or f64; `frameOf` returns a `Float32Array` or `Float64Array` view. Values can be NaN or infinite.
- **`minValue` / `maxValue`** cover the finite samples only (null if there are none). They are the natural default window when the file has none.
- **`img.realWorldValueMapping`** is the first Real World Value Mapping item (top level, else the Shared Functional Groups, else Per-Frame item 0): `{ slope, intercept, label, units, unitsMeaning }`, where the real value is stored × slope + intercept in `units` (a UCUM code such as `mm2/s`). It is also set for integer images that carry one. Parametric maps usually store real values already (slope 1, intercept 0).
- **Rendering:** the renderers take integer samples today. A float frame needs a float texture (WebGL2 `R32F`, or f64 converted to f32) and a window in real values; the CPU path can read the typed array directly.

## Rendering

```ts
renderer.setFrame(frameOf(img, k), { windowCenter, windowWidth });   // uploads once
renderer.setView({ windowCenter, windowWidth, zoom, panX, panY });   // uniforms only, coalesced to the next frame
```

- **Canvas size.** Set `canvas.width` and `canvas.height` from `clientWidth * devicePixelRatio` in a ResizeObserver, then call `renderer.draw()`. `web/core/render.ts` (`Viewport`) and `demo/demo.ts` do this.
- **Zoom and pan** are view parameters, with pan in canvas pixels. The image is resampled from the raw frame (nearest or linear), so it stays sharp when zoomed.
- **Slider ranges.** Use `img.minValue`, `img.maxValue`, `img.rescaleSlope` and `img.rescaleIntercept`.
- **Thumbnails.** Don't create a WebGL context per thumbnail; browsers cap contexts at about 16. Decode with `scale` (see [below](#thumbnails-and-first-display-scale)) and draw with the CPU reference:

```ts
const ctx = thumb.getContext("2d")!; const im = ctx.createImageData(64, 64);
renderCpu(frameOf(img), { ...defaultView(), windowCenter: w.center, windowWidth: w.width }, 64, 64, im.data);
ctx.putImageData(im, 0, 0);
```

## Prefetch

When a series is selected:
1. Create `seriesAbort = new AbortController()`, aborting the previous one.
2. Decode the middle slice with `Visible`.
3. Decode ±1–3 with `Near`.
4. Decode the rest with `Prefetch`, working outward.

Each decode needs its ciphertext fetched first. The pool's queue orders only decodes, so issue the fetches nearest-first as well (`web/core/loader.ts` does). When the slider moves to a slice that is not decoded yet, call `pool.decode` again with `Priority.Visible` and the same key. It moves that queued job to the front.

**Multi-frame instances.** One instance holding many frames, such as cine, enhanced CT/MR or tomosynthesis, should use `pool.decodeFrames(bytes, { onChunk })`. Its frames become the slices, and `onChunk` lets the first frames show while the rest decode. Frames are only decoded in parallel for encapsulated syntaxes. A native (uncompressed) instance is decoded whole in one worker, because its decode is a copy.

## Thumbnails and first display: `scale`

`pool.decode(bytes, { scale: s })` decodes at 1/2^s of the size in each direction. `decodeFrames` takes the same option. Use `scale: 3` (1/8) for thumbnails: a 2048² image becomes 256², and the canvas scales that to 64 px.

**The result:**
- **Size.** `rows` and `columns` are `ceil(fullRows / 2^s)` and `ceil(fullColumns / 2^s)`. `frameBytes` and `pixels` describe the reduced pixels.
- **New fields.** `scale`, `fullRows` and `fullColumns` are set; they are absent on a full-size decode.
- **Everything else is as before.** Samples stay canonical, with the same `bitsAllocated`, signedness, photometric, rescale, window and palette. So `frameOf` and both renderers take a reduced image unchanged.
- **Geometry.** One reduced pixel covers 2^s × 2^s original pixels. Anything measured in pixels, such as Pixel Spacing, overlays or annotations, must be scaled by 2^s.

**What it costs:**
- **JPEG baseline and extended** (`.50`, `.51`, the common lossy syntax), and the retired progressive and arithmetic-coded DCT processes, decode through the codec's own reduced decode (scaled IDCT). It does much less work: in one Chromium run, a 2048² colour image took 9.9 ms at 1/8 against 42.6 ms at full size.
- **JPEG 2000 and HTJ2K** (`.90`, `.91`, `.201`–`.203`) discard the finest wavelet resolution levels, so their code-blocks are never decoded. At 1/8, natively, a 2048² lossless 12-bit JPEG 2000 frame takes about 7 ms instead of 413 ms, and the HTJ2K version about 2 ms instead of 60 ms ([htj2k PERF.md](../codec-corpus/formats/htj2k/PERF.md#reduced-resolution-decode)). This is the case to use for whole-slide pyramids and large radiographs.
  - A frame these codecs cannot reduce falls back to the full decode and box average: too few levels, a non-zero image origin, unusual subsampling, or MIXED HTJ2K.
- **Every other syntax** (JPEG lossless and hierarchical, JPEG-LS, JPEG XL, RLE, native, float) is decoded at full size, then box-averaged in the worker. That saves transfer and cache memory but not decode time.
- **What the values are:** a wavelet reduction is a smoothed low-pass, not a box average, and it matches OpenJPEG's own reduced decode.
- **Pixels.** At any scale, they match the native `shl_dicom_decode::decode_file_scaled` (`viewer-kit/test/scaled.ts`).
- **PALETTE COLOR** images keep each block's top-left index, since averaging indices would be meaningless.

**Caching and keys.** A reduced image is a different result from the full one. Give it its own `key` (for example `${key}@1/8`), because a same-key `decode` returns the first job's promise whatever its scale. Cache it under that key too. It costs 1/4^s of the full frame.

A full-size decode of the slice on screen can follow the thumbnail at `Priority.Visible`, and replace the reduced image on the canvas when it arrives.

## Cache: raw frames, with a byte budget

`FrameCache` is an LRU of `DecodedImage` keyed by instance, which costs `pixels.byteLength` per entry.

- **Budget.** Suggested: `512 MiB`, or `min(512 MiB, navigator.deviceMemory * 64 MiB)`. A 512² 16-bit slice costs 0.5 MiB, half its RGBA. A 300-slice CT is 150 MiB.
- **Never cache RGBA.** The renderer applies window/level, so a cached frame never needs CPU re-rendering.
- **What the renderer holds.** It keeps the one `Frame` on screen, a view on the cached buffer with no copy, to restore after a lost WebGL context. If an evicted image is on screen, it stays valid, because the renderer still references it.

## CPU fallback

`createRenderer(canvas)` returns `CpuRenderer` in two cases:
- WebGL2 is missing;
- WebGL2 is SwiftShader, which is slower than the CPU path (see PERF.md).

`CpuRenderer` has the same API and produces the same pixels, within ±1 per sample; `test/gl-vs-cpu.mjs` checks this. One more case needs handling:
- **Images too large for a texture.** `GlRenderer.setFrame` throws a `RangeError` when an image exceeds `MAX_TEXTURE_SIZE`, which is 8192 on SwiftShader and usually 16384. Catch it and swap to a `CpuRenderer` on a fresh canvas element, since a canvas keeps its first context type. `setFrame` in `demo/demo.ts` shows how.

## What is rendered

- **Window/level** follows DICOM PS3.3 C.11.2.1.2: `(x − (c − 0.5))/(w − 1) + 0.5`, rounded.
- **Default window when the file has none.** `defaultWindow()` uses the stored min/max range. `web/core/wl.ts` uses a 1st–99th percentile window instead.
- **MONOCHROME1 is inverted in the shader.** The user's Invert toggle is XORed with it.
- **PALETTE COLOR images render in colour.** The decoder returns the palette as RGBA in `img.palette`; segmented palettes are not read. 16/32-bit RGB is scaled by Bits Stored.
- **Only LINEAR is rendered.** `img.voiLutFunction` reports SIGMOID when the file asks for it, but it is not drawn that way. VOI LUT sequences and pixel aspect ratio are not applied.

## Frame ranges

`codecs/shl-dicom-decode-wasm` decodes a frame range with `shl_dicom_decode::decode_frames`: only the requested frames of an encapsulated instance are decoded, and native data is copied only for the range where its layout allows. The pixels are byte-identical to the same frames of a whole decode (`viewer-kit/test/verify-oracle.ts`, `codec-corpus/scripts/check_frames.py`). The crate compiles the decoder's `parse.rs` into itself with `#[path]` for the extra attributes (rescale, window, palette, Real World Value Mapping).
