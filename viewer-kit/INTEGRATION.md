# Adopting viewer-kit in web/

This guide is for the owner of `web/` and `crates/`. It covers three steps:
- **Decoding:** a pool of workers decodes decrypted instances off the main thread.
- **Caching:** raw frames are cached, not RGBA.
- **Rendering:** window/level, zoom and pan become WebGL uniforms.

Nothing in `crates/` has to change.

## What to ship

Build it with `node viewer-kit/scripts/build.mjs`. That produces the three files in `viewer-kit/dist/`; ship them next to `main.js`.

| File | What it is |
|---|---|
| `shl_dicom_decode.wasm` | 1071 KiB, 341 KiB gzip. `shl_dicom_decode::decode_file` built with simd128 and fat LTO, from `codecs/shl-dicom-decode-wasm` |
| `decoder-worker.js` | the worker script; must be a separate file |
| the API | `viewer-kit/src/index.ts`; import it into `web/main.ts` and bun bundles it |

Add this to `build:web` in `package.json`:

```sh
bun build viewer-kit/src/decoder-worker.ts --outdir dist/web --target browser \
  && cp viewer-kit/dist/shl_dicom_decode.wasm dist/web/
```

The pool needs no COOP/COEP headers. If a Content-Security-Policy is ever added, it needs `worker-src 'self'` and `script-src 'wasm-unsafe-eval'`.

## API

```ts
import { DecoderPool, Priority, FrameCache, createRenderer, frameOf, defaultWindow,
         DicomDecodeError, InvalidDicomError, UnsupportedDicomError } from "../viewer-kit/src/index";

const pool = await DecoderPool.create({ wasm: "shl_dicom_decode.wasm", workerUrl: "decoder-worker.js" });
// workers: navigator.hardwareConcurrency - 1, capped at 8; override with { workers: n }

const img = await pool.decode(bytes, { priority: Priority.Visible, key, signal });
// img: DecodedImage = canonical pixels (CONTRACT.md) + rows, columns, frames, samplesPerPixel,
//      bitsAllocated, bitsStored, pixelRepresentation, photometric, rescaleSlope/Intercept,
//      windowCenter/Width (first value, or null), minValue/maxValue, frameOffsets, palette, decodeMs

const all = await pool.decodeFrames(bytes, { priority, signal, onChunk });  // multi-frame, split over workers

const thumb = await pool.decode(bytes, { scale: 3, key: `${key}@1/8` });   // 1/8 size; see "Thumbnails"

const renderer = createRenderer(canvas);     // WebGL2, or CpuRenderer on SwiftShader or without WebGL2
renderer.setFrame(frameOf(img, k), { windowCenter, windowWidth });   // uploads once
renderer.setView({ windowCenter, windowWidth, zoom, panX, panY, interpolation, invert });  // uniforms only
```

**Pool behaviour:**
- **Priorities.** `Visible` (0) runs before `Near` (1), which runs before `Prefetch` (2). A job starts only when a worker is free, so the slice on screen goes next.
- **`key`.** A second `decode` with the same key returns the first job's promise, and raises that job's priority if it is still queued. Use `${study}/${series}/${instance}` as the key.
- **`signal`.** Aborting a queued job removes it. Aborting a running job rejects its promise at once and drops the result when it arrives; wasm cannot be interrupted.
- **Transfer.** The input `ArrayBuffer` is transferred, so the caller's copy is detached. Pass `copy: true` to keep it. Output pixels come back transferred too.

**Errors:**

| Error | When | What `web/` should do |
|---|---|---|
| `InvalidDicomError` | decoder exit 2: the file is malformed | show `e.decoderMessage` with the slice |
| `UnsupportedDicomError` | exit 3: for example video syntaxes, float pixel data, an image too large for wasm32 | same |
| `DecoderCrashError` | the wasm trapped | the worker has already restarted itself; report it as a bug |

## Where it replaces `render_instance_rgba`

There are three call sites in `web/main.ts`. All of them now get bytes from `session.get_instance_dicom(...)`. Its `Uint8Array` is a fresh copy made by wasm-bindgen, so it is safe to transfer.

**1. `renderActiveSlice` (line ~424)**

```ts
await ensureInstanceFetched(st, se, ser, i);          // unchanged: range fetch + decrypt + verify
const key = `${st}/${se}/${i}`;
let img = cache.get(key);
if (!img) {
  const bytes = session.get_instance_dicom(st, se, i);  // decrypted Part 10 instance
  img = await pool.decode(bytes, { priority: Priority.Visible, key, signal: seriesAbort.signal });
  cache.set(key, img);
}
if (i !== activeInstanceIdx) return;                  // user moved on
const w = defaultWindow(img);
renderer.setFrame(frameOf(img), { windowCenter: overrideWc ?? w.center, windowWidth: overrideWw ?? w.width });
```

Use `img.minValue`, `img.maxValue`, `img.rescaleSlope` and `img.rescaleIntercept` for the slider ranges. They replace `rendered.min_pixel` and `rendered.max_pixel`.

**2. Window/level drag and sliders (lines ~755 and ~827)**

Replace `void renderActiveSlice(...)` with:

```ts
renderer.setView({ windowCenter: overrideWc, windowWidth: overrideWw });
```

This changes uniforms only, and the redraw is coalesced to the next frame.

**3. Pinch zoom and pan**

These currently use a CSS transform on the canvas. Replace it with `renderer.setView({ zoom, panX, panY })`, with pan in canvas pixels. The image is then resampled from the raw frame (nearest or linear), so it stays sharp when zoomed.

To size the canvas, set `canvas.width` and `canvas.height` from `clientWidth * devicePixelRatio` in a ResizeObserver, then call `renderer.draw()`. `demo/demo.ts` does exactly this. It also has working pointer handling for window/level, pan, pinch and wheel.

**4. Thumbnails (line ~340) and the Cornerstone bridge (line ~888)**

Don't create a WebGL context per thumbnail; browsers cap contexts at about 16. Decode with `Priority.Near` and `scale: 3` (see [Thumbnails and first display](#thumbnails-and-first-display-scale)), then draw with the CPU reference:

```ts
const ctx = thumb.getContext("2d")!; const im = ctx.createImageData(64, 64);
renderCpu(frameOf(img), { ...defaultView(), windowCenter: w.center, windowWidth: w.width }, 64, 64, im.data);
ctx.putImageData(im, 0, 0);
```

The Cornerstone bridge needs RGBA. Get it from `renderCpu` at image size with `fit: "none"`.

## Prefetch

When a series is selected:
1. Create `seriesAbort = new AbortController()`, aborting the previous one.
2. Decode the middle slice with `Visible`.
3. Decode ±1–3 with `Near`.
4. Decode the rest with `Prefetch`, working outward.

Each decode still needs its records fetched first, through `ensureInstanceFetched`. The pool's queue orders only decodes, so issue the fetches nearest-first as well. When the slider moves to a slice that is not decoded yet, call `pool.decode` again with `Priority.Visible` and the same key. It moves that queued job to the front.

**Multi-frame instances.** One instance holding many frames, such as cine, enhanced CT/MR or tomosynthesis, should use `pool.decodeFrames(bytes, { onChunk })`. Its frames become the slices, and `onChunk` lets the first frames show while the rest decode. Frames are only decoded in parallel for encapsulated syntaxes. A native (uncompressed) instance is decoded whole in one worker, because its decode is a copy.

## Thumbnails and first display: `scale`

`pool.decode(bytes, { scale: s })` decodes at 1/2^s of the size in each direction. `decodeFrames` takes the same option. Use `scale: 3` (1/8) for thumbnails: a 2048² image becomes 256², and the canvas scales that to 64 px.

**The result:**
- **Size.** `rows` and `columns` are `ceil(fullRows / 2^s)` and `ceil(fullColumns / 2^s)`. `frameBytes` and `pixels` describe the reduced pixels.
- **New fields.** `scale`, `fullRows` and `fullColumns` are set; they are absent on a full-size decode.
- **Everything else is as before.** Samples stay canonical, with the same `bitsAllocated`, signedness, photometric, rescale, window and palette. So `frameOf` and both renderers take a reduced image unchanged.
- **Geometry.** One reduced pixel covers 2^s × 2^s original pixels. Anything measured in pixels, such as Pixel Spacing, overlays or annotations, must be scaled by 2^s.

**What it costs:**
- **JPEG baseline and extended** (`.50`, `.51`, the common lossy syntax) decode through the codec's own reduced decode (scaled IDCT). It does much less work: in one Chromium run, a 2048² colour image took 9.9 ms at 1/8 against 42.6 ms at full size.
- **Every other syntax** is decoded at full size, then box-averaged in the worker. That saves transfer and cache memory but not decode time. JPEG 2000 and HTJ2K are planned to use their resolution levels next.
- **Pixels.** At any scale, they match the native `shl_dicom_decode::decode_file_scaled` (`viewer-kit/test/scaled.ts`).
- **PALETTE COLOR** images keep each block's top-left index, since averaging indices would be meaningless.

**Caching and keys.** A reduced image is a different result from the full one. Give it its own `key` (for example `${key}@1/8`), because a same-key `decode` returns the first job's promise whatever its scale. Cache it under that key too. It costs 1/4^s of the full frame.

A full-size decode of the slice on screen can follow the thumbnail at `Priority.Visible`, and replace the reduced image on the canvas when it arrives.

## Cache: raw frames, with a byte budget

`FrameCache` is an LRU of `DecodedImage` keyed by instance, which costs `pixels.byteLength` per entry.

- **Budget.** Suggested: `512 MiB`, or `min(512 MiB, navigator.deviceMemory * 64 MiB)`. A 512² 16-bit slice costs 0.5 MiB, half its RGBA. A 300-slice CT is 150 MiB.
- **Never cache RGBA.** The renderer applies window/level, so a cached frame never needs CPU re-rendering.
- **Records.** The session's encrypted-record cache in Rust (`records`, 64 KiB plaintext records) stays as it is: it is what `get_instance_dicom` reads.
- **Rust's decoded-frame cache.** `frame_cache` (24 `DecodedRawFrame`) becomes unused once `render_instance_rgba` has no callers.
- **What the renderer holds.** It keeps the one `Frame` on screen, a view on the cached buffer with no copy, to restore after a lost WebGL context. If an evicted image is on screen, it stays valid, because the renderer still references it.

## CPU fallback

`createRenderer(canvas)` returns `CpuRenderer` in two cases:
- WebGL2 is missing;
- WebGL2 is SwiftShader, which is slower than the CPU path (see PERF.md).

`CpuRenderer` has the same API and produces the same pixels, within ±1 per sample; `test/gl-vs-cpu.mjs` checks this. Two more cases need handling:
- **Images too large for a texture.** `GlRenderer.setFrame` throws a `RangeError` when an image exceeds `MAX_TEXTURE_SIZE`, which is 8192 on SwiftShader and usually 16384. Catch it and swap to a `CpuRenderer` on a fresh canvas element, since a canvas keeps its first context type. `setFrame` in `demo/demo.ts` shows how.
- **What to keep in Rust.** Nothing in Rust is needed for the fallback. `DecodedRawFrame::to_rgba` can go once nothing calls it, but keep `get_instance_dicom`.

## Behaviour changes users may notice

- **Window/level is now DICOM PS3.3 C.11.2.1.2** (`(x − (c − 0.5))/(w − 1) + 0.5`, rounded). Today's `to_rgba` uses `(x − (c − w/2)) · 255/w`, truncated. Grey levels can differ by one or two.
- **Default window when the file has none.** `defaultWindow()` uses the stored min/max range, where today's code uses `percentile_window`. If the percentile window should stay, compute it from `frameOf(img).data` once per image.
- **MONOCHROME1 is inverted in the shader.** The user's Invert toggle is XORed with it.
- **PALETTE COLOR images render in colour.** The decoder returns the palette as RGBA in `img.palette`; segmented palettes are not read. 16/32-bit RGB is scaled by Bits Stored.
- **Only LINEAR is rendered.** `img.voiLutFunction` reports SIGMOID when the file asks for it, but it is not drawn that way. VOI LUT sequences and pixel aspect ratio are not applied.

## Notes for the coordinator

`codecs/shl-dicom-decode-wasm` compiles `shl-dicom-decode/src/parse.rs` and `encaps.rs` into itself with `#[path]`, because they are private modules. This means:
- the frame split is exactly `decode_file`'s;
- no shared file was edited;
- frame-range decoding works by re-wrapping the selected frame codestreams in a minimal Part 10 file and calling `decode_file` on it. All 150 multi-frame encapsulated corpus cases decode byte-identically this way.

A cleaner long-term change would be for `shl-dicom-decode` to export these itself:
- a `decode_frames(bytes, range)`;
- the extra attributes: rescale, window and palette.
