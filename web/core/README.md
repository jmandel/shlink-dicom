# web/core: the shared receive path

Plain TypeScript modules used by the View (`web/view/`), How it works and Share experiences. Each experience imports only what it needs, and `bun build --splitting` puts shared code in common chunks.

Two entry points:
- `web/core/index.ts`: everything that runs anywhere WebCrypto runs (browsers, workers, Bun, Node 20+);
- `images.ts`, `render.ts` and `wl.ts`: browser only (workers, canvas, WebGL). Import them directly.

## Quick start

```ts
import { openShare, pickInitialSeries, PasscodeError, LinkError } from "../core/index";
import { getDecoderPool, ImageStore, Priority } from "../core/images";
import { Viewport, drawThumbnail } from "../core/render";
import { autoWindow } from "../core/wl";

const pool = getDecoderPool();                     // start early: compiles the decoder wasm, starts workers
const share = await openShare(location.hash, { passcode, recipient: "My page" });
// share.index: StudyIndex; share.loader: InstanceLoader; share.resolver: LinkResolver
const images = new ImageStore(share.loader, await pool);
const study = share.index.studies[0];
const series = study.series[pickInitialSeries(study)];
const img = await images.get(series, 0, { priority: Priority.Visible });
const vp = new Viewport(document.getElementById("stage")!);
const w = autoWindow(img);
vp.show(img, 0, { windowCenter: w.center, windowWidth: w.width });
vp.setView({ windowCenter: 40, windowWidth: 400, zoom: 2, panX: 0, panY: 0 }); // uniforms only
```

`web/checks/fixtures.ts` uses the same modules from Bun, as a sharer would, to mint test links.

## Modules

### Links: `shlink.ts`, `resolver.ts`, `jwe.ts`, `b64.ts`

| Export | What it does |
|---|---|
| `parseShlink(input)` | Decodes the payload from a bare `shlink:/…`, a viewer URL (`https://x/view#shlink:/…`) or a hash. Throws `InvalidLinkError`. |
| `extractShlink(input)` | Returns the `shlink:/…` part, or null. |
| `encodeShlink(payload, viewerPrefix?)` | The reverse. With a prefix it gives `${prefix}#shlink:/…`. |
| `hasFlag(payload, "L" \| "P" \| "U")` | Tests a flag. |
| `new LinkResolver(link, { recipient?, onRequest?, fetch? })` | One link. Properties: `payload`, `label`, `expires`, `needsPasscode`, `isDirect`, `isLongLived`, `base`. |
| `resolver.open(passcode?)` | U mode: GETs the file. Manifest mode: POSTs `{recipient, passcode}`, then GETs `files[0].location`. Decrypts the JWE and returns `{ bundleBytes, baseUrl, manifest }`. Checks `exp` before any request. |
| `resolver.fetchRange(plan, signal?)` | One Range read of `{fileId}.bin` against the base URL, with `?recipient=`. In manifest mode a 404 re-resolves the manifest once, with the remembered passcode, for a fresh `/cap/` prefix, then retries. Checks the byte count. A 200 answer is sliced locally. |
| `resolver.seriesUrl(fileId)` | The URL it reads from. |
| `onRequest(e: RequestEvent)` | Called for every exchange: `{ method, url, range, status, bytes, ms, purpose: "manifest" \| "bundle" \| "series" }`. Use it for network panels. |
| `decryptJwe(compact, key)` / `encryptJwe(bytes, key)` | Compact JWE: `dir`, `A256GCM`, `zip: DEF`. Uses WebCrypto and `(De)CompressionStream("deflate-raw")`. |
| `randomKeyB64()` | 32 random bytes, base64url. |

**Errors.** Everything the UI must explain is typed:

| Error | `reason` / `kind` | Meaning |
|---|---|---|
| `PasscodeError` | `"required"` | P link, no passcode given yet |
| | `"incorrect"` | Host said 401; `remainingAttempts` when the host says |
| `LinkError` | `"expired"` | The payload's `exp` has passed; no request was made |
| | `"unavailable"` | 404/410: revoked, offline, or expired on the server. The host does not say which. |
| | `"locked"` | Attempts ran out: 401 with `remainingAttempts: 0`, or 404 after a wrong passcode in this session |
| | `"network"` | `fetch` threw: offline (`navigator.onLine === false`), DNS, CORS or connection refused |
| | `"invalid"` | Damaged link, or the key does not decrypt the file |
| | `"server"` | Any other HTTP status, or a short Range answer |
| `InvalidLinkError` | | Not a SMART Health Link |

### The Bundle: `bundle.ts`

`parseStudyIndex(bytes | string | object): StudyIndex` reads PROPOSAL.md §8:

```ts
StudyIndex  { lastUpdated, patient: { name, birthDate, id }, reports: ReportEntry[], studies: StudyEntry[], bundle }
StudyEntry  { id, studyInstanceUid, description, started, modalities[], notes[], numberOfSeries, numberOfInstances, bytes, series[] }
SeriesEntry { uid, number, modality, description, bodySite, fileId, key, plaintextLength, ciphertextLength, recordCount, instances[] }
InstanceEntry { uid, sopClass, number, offset, length, firstRecord, lastRecord }
ReportEntry { id, status, title, conclusion, issued, effective, studyIds[], text }
```

The field names match the Rust `StudyIndex` in `shl-dicom-core`, with additions.

Helpers:
- `reportsForStudy(index, study)`;
- `pickInitialSeries(study)`: the largest axial non-localizer series of a CT, MR, PT or NM study, else the first non-localizer series, else series 0;
- `isLocalizer(series)` and `isAxial(series)`.

### Byte ranges: `range.ts`

- Constants: `RECORD_PLAINTEXT` (65,520), `TAG` (16) and `RECORD_CIPHERTEXT` (65,536).
- `recordCount(P)`, `ciphertextLength(P)` and `recordNonce(i)`.
- `planInstances(series, first, last?)`, `planBytes(series, a, b)` and `planSeries(series)` each return a `RangePlan`: `{ fileId, firstInstance, lastInstance, plaintextStart, plaintextEnd, firstRecord, lastRecord, ciphertextStart, ciphertextEnd, rangeHeader }`.
- `planRuns(series, maxBytes = 8 MiB)` splits a series into consecutive runs of instances, for streaming downloads.

### Record decryption: `decrypt.ts`, `decrypt-wasm.ts`

```ts
interface RecordDecryptor {
  name: "webcrypto" | "wasm";
  decrypt(series, plan, ciphertext): Promise<Uint8Array>;  // plaintext [plaintextStart, plaintextEnd), fresh buffer
}
```

**Implementations:**
- `WebCryptoDecryptor` is the default. It imports each series key once, non-extractable and decrypt-only, and decrypts each record with its own `subtle.decrypt` call, all records of a plan in flight at once.
- `WasmSessionDecryptor` is the previous path: Rust AES-GCM in `WasmShlSession`. It loads `shl_dicom_wasm_bg.wasm` (2.6 MB) on demand and handles instance-aligned plans only.

**Choosing one.** Use `createDecryptor(kind, bundleBytes)`. The kind comes from `config.json` (`"decrypt"`) or `?decrypt=wasm`.

**Why WebCrypto is the default.** In `perf-spikes/decrypt/results/latest.json`, WebCrypto ran at about 750–840 MB/s in one worker, against about 40–52 MB/s for wasm. It also avoids the 2.6 MB download. `perf-spikes/decrypt/RESULTS.md` was not written when this was built; if it reaches a different conclusion, change the default in `config.ts`.

**Failures.** A record that fails its tag, or whose length is wrong for its position, throws `RecordAuthenticationError(fileId, recordIndex)`. No bytes from it are returned.

### Loading: `loader.ts`, `share.ts`

**`new InstanceLoader(resolver, decryptor, opts?)`** fetches, verifies and decrypts series bytes through one priority queue.

Options:
- `concurrency`: requests in flight, default 6;
- `plaintextBudgetBytes`: decrypted instances kept for re-use, default 96 MiB;
- `onRecords(fileId, first, last, "fetching" | "verified" | "failed")`: for record maps and the trust count;
- `onBytes(n)`.

Methods:
- `instance(series, i, { priority, signal })` returns one Part 10 file in a fresh buffer, which the caller may transfer. Requests for the same instance are deduplicated. Asking again with a lower `priority` number moves a queued request up. Aborting removes a queued request once it has no other waiters.
- `run(series, plan, o)` returns the instances of a multi-instance plan from one Range read. It is used by downloads and is not cached.
- `cancelQueued((fileId, priority) => boolean)` drops queued requests, for example the prefetch of a series the user has left.
- `has(series, i)` and `bytesFetched`.

`FetchPriority` is `{ Visible: 0, Near: 1, Prefetch: 2, Background: 3 }`, the same numbers as viewer-kit's `Priority`.

**`openShare(link | resolver, { passcode, recipient, decrypt, onRecords, onRequest, … })`** wraps all of this: it resolves the link, decrypts and indexes the Bundle, and creates the decryptor and the loader. It returns `{ resolver, index, decryptor, loader, bundleBytes, openMs }`. To retry with a passcode, pass the same resolver back, so that it keeps count of the attempts.

### Decoding and the frame cache: `images.ts` (browser)

- `getDecoderPool(workers?)` returns the page's viewer-kit `DecoderPool`. It loads `assets/decoder-worker.js` and `assets/shl_dicom_decode.wasm`.
- `new ImageStore(loader, pool, budgetBytes?)` keeps an LRU of raw decoded images, keyed by `${fileId}/${index}`. The default budget is `min(512 MiB, deviceMemory × 64 MiB)`, at least 128 MiB.
  - `get(series, i, { priority, signal })` fetches, decrypts, decodes and caches the image, using the same priority for the fetch and the decode.
  - `peek(series, i)` returns the cached image without loading anything.
  - `getFrames(series, i, { onChunk })` decodes a multi-frame instance in parallel chunks. The result is not cached.
- `Priority` is re-exported from viewer-kit.

### Rendering: `render.ts`, `wl.ts` (browser)

**`new Viewport(container, { forceCpu?, allowSoftwareGl?, maxDpr? })`** creates a canvas that fills the container and resizes with it. It uses viewer-kit's `createRenderer`: WebGL2, or the CPU renderer when WebGL2 is missing or is SwiftShader.
- `show(img, frame, view)` uploads a frame.
- `setView({ windowCenter, windowWidth, zoom, panX, panY, invert, interpolation })` changes uniforms only, and redraws on the next animation frame.
- An image larger than the GPU's maximum texture size switches to the CPU renderer on a fresh canvas.
- Other members: `scale` (canvas pixels per CSS pixel, for pointer maths), `image`, `kind` and `onDraw(ms)`.

**Thumbnails.** `drawThumbnail(canvas2d, img, frame?)` draws with the CPU renderer, so thumbnails never create WebGL contexts.

**Windows.** `wl.ts` provides:
- `presetsFor(modality)`: CT gets Auto, Soft tissue, Lung, Bone and Brain; every other modality gets Auto only;
- `autoWindow(img, frame)`: the file's own Window Center and Width, else the 1st–99th percentile of the frame's values;
- `percentileWindow(img)` and `valueRange(img)`.

### Downloads: `export.ts`, `zip.ts`, `dicomdir.ts`, `dicom-header.ts`, `save.ts`

**ZIPs.** `exportZip({ kind: "study" | "series", … }, loader, sink, onProgress?, signal?)` writes a stored ZIP:
- `DICOM/ST000001/SE000001/IM000001`… are the shared files, byte for byte;
- `DICOMDIR` holds PATIENT → STUDY → SERIES → IMAGE records.

Series are read in runs of up to 8 MiB, so memory stays bounded. ZIP64 records are added past 4 GiB.

**Other exports:**
- `exportInstance(loader, series, i)` returns one instance's bytes;
- `exportSize(scope)` and `exportBaseName(study, series?)` give the size and a file name;
- `readDicomHeader(bytes)` reads the DICOMDIR attributes from a Part 10 header;
- `buildDicomdir(entries)` builds the DICOMDIR;
- `ZipWriter` and `crc32` are the ZIP pieces.

**Saving.** `openSaveTarget(name, mime, ext)` streams to a file with `showSaveFilePicker` where the browser has it, and otherwise collects a Blob and saves it with a link. Call it first in the click handler, before any other `await`. It returns null if the user cancels.

### Configuration and samples: `config.ts`, `samples.ts`, `format.ts`

**Configuration.** `loadConfig()` returns `{ apiBase, viewerPrefix, decrypt }`. Sources apply in this order, later winning:
1. defaults: the API on this origin, the viewer at `<site>/view`, WebCrypto;
2. `<site>/config.json`, which the build writes as `{}`;
3. `?api=` and `?decrypt=` in the URL.

**Site URLs.** `siteRoot`, `siteUrl(path)` and `assetUrl(name)` resolve from where the bundles are served (`<site>/assets/`), so the static pages work under any path prefix.

**Samples.** `fetchSampleLinks(cfg)` reads `GET {apiBase}/api/demo-shares`. The first entry without a passcode is the public sample. `viewerUrl(cfg, shlink)` gives the address to open a link in the viewer.

**Formatting.** `format.ts` has `formatPersonName` ("MANDEL^JOSHUA" becomes "Joshua Mandel"), `formatDate`, `formatBytes`, `plural`, `modalityName` and `studyTitle`.

## Build and layout

`bun run build:web` runs `web/build.ts` and writes `dist/web/`:

| Path | What |
|---|---|
| `index.html` | Landing (`/`). A `/#shlink:/…` URL forwards to `/view`. |
| `view/index.html` | View (`/view#shlink:/…`) |
| `how/` | How it works, with its baked data and linked pages |
| `share/`, `share/manage/`, `share/smart-callback/` | Share |
| `assets/` | `landing.js`, `view.js`, shared `chunk-*.js`, `decoder-worker.js`, `shl_dicom_decode.wasm`, `shl_dicom_wasm_bg.wasm` (wasm decrypt only), CSS |
| `config.json` | `{}`. A static deployment sets `apiBase` here. |

**Adding a page.** Pages reference `../assets/…` relatively. To add `how.ts` or `share.ts`, add it to `entrypoints` in `web/build.ts` and copy its HTML, as is done for `view`.

**Server routes.** The Rust server maps `/view`, `/how`, `/share`, and `/share/manage`, with or without a trailing slash, to those pages. Everything else is a static file, and unknown paths get the landing page with status 404.
