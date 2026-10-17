# web/core: the shared receive path

Plain TypeScript modules used by the View (`web/view/`), How it works and Share experiences. Each experience imports only what it needs, and `bun build --splitting` puts shared code in common chunks.

Two entry points:
- `web/core/index.ts`: everything that runs anywhere WebCrypto runs (browsers, workers, Bun, Node 20+);
- `images.ts`, `render.ts` and `wl.ts`: browser only (workers, canvas, WebGL). Import them directly.

## Quick start

```ts
import { openShare, pickInitialSeries, PasscodeError, LinkError } from "../core/index";
import { getDecoderPool, ImageStore, PoolDecryptor, Priority } from "../core/images";
import { Viewport, showImage } from "../core/render";

const pool = getDecoderPool();                     // start early: compiles the decoder wasm, starts workers
const share = await openShare(location.hash, { passcode, recipient: "My page", decryptor: new PoolDecryptor(pool) });
// share.index: StudyIndex; share.loader: InstanceLoader; share.resolver: LinkResolver
const images = new ImageStore(share.loader, await pool);
const study = share.index.studies[0];
const series = study.series[pickInitialSeries(study)];
const img = await images.get(series, 0, { priority: Priority.Visible });   // decoded with its header
const vp = new Viewport(document.getElementById("stage")!);
const plan = showImage(vp, img);           // the display transform the file's maker chose (displayPlan)
vp.setView({ windowCenter: 40, windowWidth: 400, zoom: 2, panX: 0, panY: 0 }); // uniforms only
```

`web/checks/fixtures.ts` (with `pack-share.ts`, which uses the Share page's packer) runs these modules in Bun to make test links, as a sharer would.

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
| `resolver.fetchRange(plan, signal?, onProgress?)` | One Range read of `{fileId}.bin` against the base URL, with `?recipient=`; `onProgress` gets the bytes received so far. In manifest mode a 404 re-resolves the manifest once, with the remembered passcode, for a fresh `/cap/` prefix, then retries. Checks the byte count. A 200 answer is sliced locally. |
| `resolver.fileUrl(fileId)` | The URL it reads from. |
| `onRequest(e: RequestEvent)` | Called for every exchange: `{ method, url, range, status, bytes, ms, purpose: "manifest" \| "bundle" \| "file" }`. Use it for network panels. |
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

`parseStudyIndex(bytes | string | object): StudyIndex` reads spec/README.md §8:

```ts
StudyIndex  { lastUpdated, patient: { name, birthDate, id }, reports: ReportEntry[], studies: StudyEntry[], bundle }
StudyEntry  { id, studyInstanceUid, description, started, modalities[], notes[], accession, files[], numberOfSeries, numberOfInstances, bytes, series[] }
FileEntry   { fileId, key, plaintextLength, ciphertextLength, recordCount }
SeriesEntry { uid, number, modality, description, bodySite, id, file, offset, bytes, firstRecord, lastRecord, instances[] }
InstanceEntry { uid, sopClass, number, offset, length, firstRecord, lastRecord }
ReportEntry { id, status, title, conclusion, issued, effective, studyIds[], text }
```

Each series is in a file: its own `linked-file`, else its study's. Offsets run per file, through the series and instances in Bundle order (spec/README.md §8.1), so `instance.offset` and `series.offset` are positions in `series.file`. There is one `FileEntry` object per file id, shared by its series; `study.files` lists them in first-use order. `series.bytes` is the series' own size; `series.file.plaintextLength` is the whole file's. Several series share a file, so key caches and maps by `series.id` (`${file.fileId}@${offset}`), not by the file id.

The field names match the Rust `StudyIndex` in `shl-dicom-core`, with additions.

Helpers:
- `reportsForStudy(index, study)`;
- `pickInitialSeries(study)`: the largest axial non-localizer series of a CT, MR, PT or NM study, else the first non-localizer series, else series 0.

### Byte ranges: `range.ts`

- Constants: `RECORD_PLAINTEXT` (65,520), `TAG` (16) and `RECORD_CIPHERTEXT` (65,536).
- `recordCount(P)`, `ciphertextLength(P)` and `recordNonce(i)`.
- `planInstances(series, first, last?)`, `planBytes(series, a, b)` (bytes of the series' file) and `planSeries(series)` each return a `RangePlan` in `series.file`: `{ fileId, firstInstance, lastInstance, plaintextStart, plaintextEnd, firstRecord, lastRecord, ciphertextStart, ciphertextEnd, rangeHeader }`.
- `planRuns(series, maxBytes = 8 MiB)` splits a series into consecutive runs of instances, for streaming downloads.

### Record decryption: `decrypt.ts`

```ts
interface RecordDecryptor {
  decrypt(series, plan, ciphertext): Promise<Uint8Array>;  // plaintext [plaintextStart, plaintextEnd), fresh buffer
}
```

Both implementations run viewer-kit's `record-decrypt.ts` (WebCrypto AES-256-GCM; see `perf-spikes/decrypt/RESULTS.md` for why WebCrypto, about 800 MB/s against about 50 MB/s for wasm):
- `WebCryptoDecryptor` (the default in `openShare`) decrypts on the calling thread. The How page uses it to show single records being checked.
- `PoolDecryptor(pool)` (`images.ts`) decrypts in the decoder workers. The View page uses it, so its main thread never runs AES.

Helpers: `seriesKey(series)` imports the key of the series' file once per file as a non-extractable, decrypt-only `CryptoKey`; `decryptParams(series, plan)` gives `decryptRecords`' arguments (first record, window, file length) for a plan.

**Failures.** A record that fails its tag, or whose length is wrong for its position, throws `RecordAuthenticationError` (`recordIndex`, `reason`). No bytes from it are returned.

### Loading: `loader.ts`, `share.ts`

**`new InstanceLoader(resolver, decryptor, opts?)`** fetches ciphertext through one priority queue.

Options:
- `concurrency`: requests in flight, default 6;
- `cacheBytes`: instance ciphertext kept for re-use (a thumbnail and the full image start from the same bytes), default 96 MiB;
- `onRecords(fileId, first, last, "fetching" | "verified" | "failed")`: records of a file, for record maps and the trust count;
- `onBytes(n)`.

Methods:
- `ciphertext(series, i, { priority, signal, onProgress })` returns `{ plan, bytes }`: instance i's records, in a fresh buffer the caller may transfer. Requests for the same instance are deduplicated, and every caller's `onProgress` hears the bytes received. Asking again with a lower `priority` number moves a queued request up. Aborting removes a queued request once it has no other waiters.
- `instance(series, i, o)` returns one verified, decrypted Part 10 file (through the decryptor).
- `run(series, plan, o)` returns the instances of a multi-instance plan from one Range read, verified and decrypted. It is used by downloads and is not cached.
- `report(plan, state)` records a verify outcome from a decryptor running elsewhere (ImageStore's worker jobs).
- `cancelQueued((seriesId, priority) => boolean)` drops queued requests, for example the prefetch of a series the user has left (`seriesId` is `SeriesEntry.id`).
- `bytesFetched`.

`FetchPriority` is `{ Visible: 0, Near: 1, Prefetch: 2, Background: 3 }`, the same numbers as viewer-kit's `Priority`.

**`openShare(link | resolver, { passcode, recipient, decryptor, onRecords, onRequest, … })`** wraps all of this: it resolves the link, decrypts and indexes the Bundle, and creates the loader. It returns `{ resolver, index, decryptor, loader, bundleBytes, openMs }`. To retry with a passcode, pass the same resolver back, so that it keeps count of the attempts.

### Decoding and the frame cache: `images.ts` (browser)

- `getDecoderPool(workers?)` returns the page's viewer-kit `DecoderPool`. It loads `assets/decoder-worker.js` and `assets/shl_dicom_decode.wasm`.
- `new ImageStore(loader, pool, budgetBytes?)` keeps an LRU of raw decoded images, keyed by `${series.id}/${index}` (and `…@1/2^s` when reduced). The default budget is `min(512 MiB, deviceMemory × 64 MiB)`, at least 128 MiB.
  - `get(series, i, { priority, signal, scale })` takes the instance's ciphertext from the loader and hands it to one worker job that verifies, decrypts and decodes it; the main thread gets pixels only. The same priority orders the fetch and the decode. With `scale` (thumbnails) it decodes at 1/2^scale, falls back to full size when the decoder reports the syntax as unsupported at that scale, and returns a cached full-size image when there is one.
  - `peek(series, i)` returns the cached full-size image without loading anything.
  - `getFrame(series, i, k, o)` returns an image with frame k ready: the cached whole image, or, for a multi-frame instance read a frame at a time, the image being filled (below). `peekFrame(series, i, k)` is the same without loading.
  - `frameStream(series, i)` opens that reading (it reads the instance's header), or gives null when the instance is read whole.
  - While an instance is read a frame at a time, `get` waits for all its frames (with `scale`, for its middle frame), so a thumbnail or a reformat does not fetch it a second time.
- `PoolDecryptor(pool)`: see above.
- `Priority` is re-exported from viewer-kit.

### Multi-frame images a frame at a time: `frames.ts`

An enhanced CT or MR, an ultrasound cine or a tomosynthesis is one instance of tens of megabytes. Read whole, its first frame waits for all of it. `FrameStream` instead reads the header, finds the frame from the Extended or Basic Offset Table, native frame arithmetic, or a walk over the fragment items when there is no table (the slide viewer's `FrameLocator`, `wsi-source.ts`), reads that frame's bytes and decodes them. The other frames follow in stored order at Prefetch priority, a few hundred kilobytes to 4 MiB per request; a frame asked for meanwhile goes first.

- **Which instances.** `mayStreamFrames(series, i)`: instances of 1 MiB or more of the SOP classes that are usually multi-frame (enhanced CT, MR, PET and XA, ultrasound multi-frame, multi-frame secondary capture, tomosynthesis, NM, angiography, ophthalmic tomography). The header then decides: one frame, float pixel data, big endian, deflated data sets and JPEG 2000 Part 2 volumes are read whole.
- **Decoding a frame.** The decoder gets a one-frame Part 10 file (`frame-file.ts`, also used for slide tiles): the instance's own header with Number of Frames 1, only that frame's item of the Per-Frame Functional Groups Sequence, no Extended Offset Table and no ICC profiles, and the frame's pixel data (its fragment items, or its native bytes). The frames fill one `DecodedImage` with every frame's slot; `ready[k]` says which are in. When all are in, it has the pixels and attributes a whole decode gives, and goes into the frame cache. One difference: on some enhanced files (CT0070, fo-dicom's GH1876) a whole decode reports per-frame rescale and window values for frame 1 only, while here every frame has its own.
- **Reads.** Through `InstanceLoader.range` (`LoaderBytes`), so the frames share the loader's queue, record cache and record states with every other read of the instance.
- **Checked by** `bun web/checks/frame-identity.ts [files or dirs]`: for every multi-frame file, a stream over the file's bytes must finish with the pixels, metadata, palette and header of the whole decode.


### Rendering: `render.ts`, `wl.ts` (browser)

**`new Viewport(container, { forceCpu?, allowSoftwareGl?, maxDpr? })`** creates a canvas that fills the container and resizes with it. It uses viewer-kit's `createRenderer`: WebGL2, or the CPU renderer when WebGL2 is missing or is SwiftShader.
- `show(img, frame, view, displayFrame?)` uploads a frame; `showImage(vp, img, frame?, choice?)` shows it through `displayPlan`, which every view of an image uses.
- `setView({ windowCenter, windowWidth, zoom, panX, panY, invert, interpolation })` changes uniforms only, and redraws on the next animation frame.
- An image larger than the GPU's maximum texture size switches to the CPU renderer on a fresh canvas.
- Other members: `scale` (canvas pixels per CSS pixel, for pointer maths), `image`, `kind` and `onDraw(ms)`.

**Thumbnails.** `drawThumbnail(canvas2d, img, frame?, header?)` draws with the CPU renderer (no WebGL context per thumbnail), through `displayPlan` with the image's own header (`headerOf(img)` when it was decoded with `header: true`), so a thumbnail looks like the image in the viewer.

**Window presets.** `wl.ts` `presetsFor(modality, model)`: Auto, the header's windows and VOI LUTs, and for CT Soft tissue, Lung, Bone and Brain.

### DICOM objects and display: `dicom.ts`, `objects.ts`, `reports.ts`, `sr.ts`, `derived.ts`, `waveform.ts`, `mesh.ts`, `geometry.ts`, `display.ts`, `overlays.ts`, `volume.ts`

**Parsing.** `parseDicom(bytes, { untilPixelData? })` reads a Part 10 file into a `DataSet` tree: explicit and implicit VR little endian, explicit big endian, deflated data sets, sequences of any length, encapsulated fragments, and files without a preamble. Accessors read on demand: `str`, `strs`, `num`, `nums`, `seq`, `raw`, `code`. `T` names the tags this code reads; implicit VR files get VRs from a small dictionary, and an unknown element whose value starts with an item is read as a sequence. `parseDicomSync` is the same without deflate. On the 942 codec-corpus files it agrees with pydicom on element counts and key attributes. `readDicomHeader` (`dicom-header.ts`) is the DICOMDIR/Share subset on top of it.

**Headers of decoded images.** `ImageStore` decodes with `header: true`, so each `DecodedImage` carries the bytes before Pixel Data; `imageHeader(img)` parses them once (`imageHeaderNow` when already parsed).

**What an instance is.** `sopInfo(sopClass)` gives a plain name and a kind (`image`, `slide`, `video`, `sr`, `pdf`, `cda`, `seg`, `rtstruct`, `pmap`, `pr`, `ko`, `waveform`, `model`, `other`); `seriesKind` for a series; `KIND_LABEL` for counts.

**Reports from the clinical record.** `linkReports(index)` links each FHIR DiagnosticReport to a study: by its `imagingStudy` reference (an entry's `fullUrl` or `ImagingStudy/<id>`), by a Study Instance UID it names, by accession number (from the Bundle, or from an image header via `noteAccession`), or by date and exam type (a guess, said so by `linkBasisText`). `ReportEntry.attachments` holds presentedForm data or URLs.

**Object readers.**
- `readSr(ds)`: the SR content tree (TEXT, CODE, NUM with units, dates, PNAME, UIDREF, IMAGE/COMPOSITE/WAVEFORM references, SCOORD), for text, enhanced, comprehensive, measurement (TID 1500) and dose (TID 10011) reports.
- `readSegmentation`, `readStructureSet`, `readParametricMap`, `readPresentationState`, `readKeyObjects` (`derived.ts`): segments with colours and per-frame sources and positions; parametric map frames with sources and geometry, Real World Value Mapping, window and Palette Color LUT; ROIs with contours in patient coordinates; GSPS windows, annotations, shutters, displayed area, rotation and flip; key image references.
- `readWaveforms(ds)` and `toWav(group)`: calibrated channels (sensitivity, baseline, units; mu-law and A-law), and a WAV for audio.
- `parseStl`, `parseObj`, `parseMtl` (`mesh.ts`): triangle meshes with normals and material colours.

**Geometry.** `geometryOf(ds, frame?)`: position, orientation and pixel spacing, from per-frame and shared functional groups for enhanced images; the spacing's source (`Pixel Spacing`, `Imager Pixel Spacing`, magnification-corrected, ultrasound region, none) for measurements (`spacingSourceText`). `patientToPixel`, `pixelToPatient`.

**Display pipeline.** One function, `displayPlan(img, frame, header, choice)`, turns an image into what the renderer draws: Modality LUT (or the header's Rescale), then the VOI (a window with its function, LINEAR, LINEAR_EXACT or SIGMOID, or a VOI LUT), then Presentation LUT Shape; the renderer inverts MONOCHROME1. `choice` is "auto" (the file's first window, else its first VOI LUT, else the 1st–99th percentile; a stored window with under 1% of the frame's values inside it gives way to the percentile window, so it never draws a flat grey), a window, one of the file's windows or LUTs, or the full range. The viewer (GL and CPU), thumbnails, /share previews and How all draw through it. `displayModel(ds, frame)` reads what the header asks for; the Modality LUT Sequence of XA and XRF images is not applied for display (it describes the pixel intensity relationship), as dcmtk does.

**LUT depth.** `lutOutputBits(declared, max)`: the descriptor's third value is the bits per entry (PS3.3 C.11.1.1.1, C.11.2.1.1.1). Data wider than declared take the bits their maximum needs; a declaration two or more bits wider than the data (CR VOI LUTs declared 16 bits with entries 0–4095) takes the smallest of 8, 10, 12, 14 and 16 bits that holds the maximum. Descriptor entries 0 mean 65536; the first mapped value is signed when the LUT's input is. `web/checks/display-conformance.ts` and `.py` hold the pipeline to dcmtk and pydicom over every grayscale file in the corpus, and to expected renderings of each LUT edge (`display-synthetic.py`).

**Float pixel data and real-world values.** `realWorldOf(ds, frame)` reads the Real World Value Mapping (per-frame, shared, top level) with its label, UCUM units and the stored range it covers; `imageRealWorld(img)` is the decoder's copy, for before the header is read. `realValue` applies it (else Rescale). The renderers take integer samples, so `floatFrame(frame, realWorld, floatRange(img, realWorld))` spreads the real values over 16-bit stored values whose rescale gives them back, to 1/65534 of the range; NaN becomes black. Float images are windowed in real values with the LINEAR_EXACT formula, so any width above 0 works. `formatValue` and `unitText` print values and units for the cursor readout and legends. ICC profiles: the shared `icc.ts` (`iccToSrgb`).

**Overlays.** `readOverlays(ds)`: 60xx planes from Overlay Data; `overlayBitsFromPixels` fills planes stored in the pixel data's high bits from the raw native pixel data.

**Volumes and reformats.** `buildVolume(slices)` stacks parallel, equally sized, evenly spaced slices (or enhanced frames) as a lattice in patient space: the step from one slice to the next may lean (gantry tilt up to 45°), and slice positions that do not follow one direction are refused with the reason. `planeGrid(volume, { plane, turn, tilt })` lays out true axial, sagittal or coronal planes (optionally turned and tilted) over the volume; `reformat(volume, grid, index, slab?)` samples one with trilinear interpolation, with ITK's edge rules, and combines a slab's planes (maximum, minimum or mean). `GpuReformatter` (`volume-gl.ts`) does the same with the volume in one integer 3D texture; `finishPlane` makes both paths' frames. display-checks.mjs holds both to SimpleITK (`objects/mpr-ref.py`).

**Thumbnails before the image.** `readIcon(head)` (`icon.ts`) reads the Icon Image Sequence from a file's first bytes (8-bit grey, RGB or palette).

### Downloads: `export.ts`, `zip.ts`, `dicomdir.ts`, `dicom-header.ts`, `save.ts`

**ZIPs.** `exportZip({ kind: "all" | "study" | "series", … }, loader, sink, onProgress?, signal?)` writes a stored ZIP:
- `DICOM/ST000001/SE000001/IM000001`… are the shared files, byte for byte (one ST folder per study);
- `DICOMDIR` holds PATIENT → STUDY → SERIES → IMAGE records.

Series are read in runs of up to 8 MiB, so memory stays bounded. ZIP64 records are added past 4 GiB.

**Other exports:**
- `exportInstance(loader, series, i, onProgress?)` returns one instance's bytes;
- `exportSize(scope)` and `exportBaseName(study, series?)` give the size and a file name;
- `readDicomHeader(bytes)` reads the DICOMDIR attributes from a Part 10 header;
- `buildDicomdir(entries)` builds the DICOMDIR;
- `ZipWriter` writes the ZIP.

**Saving.** `openSaveTarget(name, mime, ext)` streams to a file with `showSaveFilePicker` where the browser has it, and otherwise collects a Blob and saves it with a link. Call it first in the click handler, before any other `await`. It returns null if the user cancels.

### Configuration and samples: `config.ts`, `samples.ts`, `format.ts`

**Configuration.** `loadConfig()` returns `{ apiBase, viewerPrefix }`. Sources apply in this order, later winning:
1. defaults: the API on this origin, the viewer at `<site>/view`;
2. `<site>/config.json`, which the build writes as `{}`;
3. `?api=` in the URL.

**Site URLs.** `siteUrl(path)` and `assetUrl(name)` resolve from where the bundles are served (`<site>/assets/`), so the static pages work under any path prefix.

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
| `assets/` | one bundle per page, shared `chunk-*.js`, `decoder-worker.js`, `shl_dicom_decode.wasm`, `shl_dicom_wasm_bg.wasm` (Share: offset tables), CSS |
| `config.json` | `{}`. A static deployment sets `apiBase` here. |

**Adding a page.** Pages reference `../assets/…` relatively. To add `how.ts` or `share.ts`, add it to `entrypoints` in `web/build.ts` and copy its HTML, as is done for `view`.

**Server routes.** The Rust server maps `/view`, `/how`, `/share`, and `/share/manage`, with or without a trailing slash, to those pages. Everything else is a static file, and unknown paths get the landing page with status 404.
