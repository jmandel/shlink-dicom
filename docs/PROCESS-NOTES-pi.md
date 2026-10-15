# Building `shlink-dicom`: Process Journal (Pi Agent Perspective)

This journal documents how `shlink-dicom`—a specification and reference implementation for sharing full-fidelity DICOM studies over SMART Health Links (SHLs) using 64 KiB `AES-256-GCM` record-streamed `.bin` files and HTTP `206` byte-range reads—was designed, built, debugged, and refined across its specification (`PROPOSAL.md`), storage architecture (`docs/storage.md`), Rust/WASM crates (`crates/*`), and web application (`web/`).

---

## 1. Simplifying the Protocol Specification (`PROPOSAL.md`)

### Dropping FHIR `Endpoint` and `HKDF`
At the start of the project, the draft specification carried two pieces of unnecessary ceremony:
1. **A separate FHIR `Endpoint` resource inside the `Bundle`:** Originally, `ImagingStudy.endpoint` pointed to a `Bundle`-internal `Endpoint` resource whose `address` repeated the base URL of the share.
2. **An HKDF key-derivation layer:** Series keys were originally derived via `HKDF-SHA-256(ikm = shl.key, salt = fileId, info = "shl-dicom-v1\0" || SeriesInstanceUID)`.

Josh pushed to simplify both:
- **Bundle-relative `{fileId}.bin` resolution:** Because the client already knows the URL from which it fetched `bundle.jwe` (whether directly in `U`-mode at `https://host/shl/{lid}/bundle.jwe` or via a 1-hour capability URL in manifest/`P`-mode at `https://host/cap/{token}/bundle.jwe`), resolving `new URL(`${fileId}.bin`, bundleUrl)` via standard RFC 3986 relative URL resolution works identically in every mode without an `Endpoint` resource and without rewriting the `Bundle` when a capability token rotates.
- **Explicit per-series 32-byte keys inside `ImagingStudy.series`:** Replacing HKDF with an explicit random 32-byte key stored alongside the 22-character base64url `id` in a complex FHIR extension (`https://example.org/shl-dicom/series-file` with sub-extensions `id` and `key`) had a huge architectural payoff:
  - **Zero re-encryption when minting subset links:** A share owner can upload each encrypted `{fileId}.bin` series file *once*, and then mint multiple SMART Health Links (each with its own SHL link key and its own subset of studies or series) simply by encrypting a new `bundle.jwe` that includes only the `ImagingStudy` entries and `(id, key)` pairs for the permitted series.
  - **Simpler STREAM construction:** Each 64 KiB record (`65,520` bytes of DICOM Part 10 plaintext + `16`-byte AES-GCM authentication tag = `65,536` bytes on disk) is encrypted with `AES-256-GCM(key = series.key, nonce = uint96_be(i), aad = "")`.

We updated `PROPOSAL.md`, `reference/series-file.ts`, and `reference/test-vector.ts` to lock in this contract and generated tracked golden fixtures in `fixtures/golden/` (`bundle.jwe`, `AAECAwQFBgcICQoLDA0ODw.bin`, and `vector.json`) so the Rust implementation could be verified byte-for-byte against the TypeScript WebCrypto reference.

---

## 2. Building the Rust Workspace, SQLite Storage & WASM Toolchain

### Three-Crate Architecture & SQLite Storage (`docs/storage.md`)
We structured the Rust workspace (`Cargo.toml`) into three crates:
1. **`crates/shl-dicom-core`**: Pure Rust (no `std::fs`, no `tokio`, no `wasm_bindgen`) so the exact same code compiles to native server/CLI binaries and `wasm32-unknown-unknown`. It implements:
   - 64 KiB STREAM record encryption/decryption and `[a, b)` byte-range coordinate math (`crypto.rs`, `range.rs`),
   - Compact JWE (`alg: "dir"`, `enc: "A256GCM"`, `zip: "DEF"` raw DEFLATE) and `shlink:/` URI encoding/decoding (`jwe.rs`, `shl.rs`),
   - DICOM Part 10 / `.tgz` / `.zip` ingestion, wrapping bare DICOM datasets in Part 10 headers, and lossless `.dcm` / `.zip` reconstruction (`dicom_io.rs`, `packer.rs`, `export.rs`),
   - FHIR R4 `Bundle` construction, `StudyIndex` parsing, and subsetting (`bundle.rs`).
2. **`crates/shl-dicom-server`**: Axum HTTP server + CLI (`pack`, `inspect`, `serve`) backed by the two-tier SQLite design in `docs/storage.md`:
   - `{data-dir}/catalog.db` for fast routing (`shares`, `links`, and 1-hour `caps` capability tokens),
   - `{data-dir}/shares/{sid}.db` for per-share state (`share`, `series_files`, `series_records` storing individual 64 KiB `BLOB` rows keyed by `(file_id, rec_no)`, `links`, `link_files` with `ON DELETE RESTRICT` foreign keys returning `409 Conflict`, and `access_log`).
3. **`crates/shl-dicom-wasm`**: `wasm-bindgen` bindings exposing `WasmShlSession` (sparse 64 KiB record cache, range planner, RGBA slice renderer, `.dcm`/`.zip` exporter) and `WasmPacker` (in-browser zero-knowledge packing).

### Hurdle 1: Missing `wasm32-unknown-unknown` Sysroot & 12-Bit JPEG
When we first went to compile `crates/shl-dicom-wasm`, the host machine's Rust toolchain did not have the `wasm32-unknown-unknown` standard library target installed via `rustup`, and port `3000` was already occupied by another service on the machine.
- **Recovery:** We downloaded and extracted the `rust-wasm` sysroot and `wasm-bindgen-cli` (`0.2.128`) into a local gitignored directory (`data/toolchain/root`) and compiled WASM using `RUSTFLAGS="--sysroot=$(pwd)/data/toolchain/root/usr"`, running our server on port `3333`.
- **12-bit JPEG Extended (`1.2.840.10008.1.2.4.51`):** The sample Wrist X-Ray archive (`data/samples/wrist-low-res.tgz`) used 12-bit lossy JPEG encapsulation, which standard 8-bit `jpeg-decoder` crates reject. We initially wrote a pure-Rust 12-bit Extended Sequential SOF1 Huffman + 64-bit IDCT decoder (`crates/shl-dicom-core/src/jpeg12.rs`) and verified it against DCMTK's `dcmdjpeg` (`max_abs_diff = 1` across 6.8 million pixels).
- **Integrating the Codec Coordinator's `shl-dicom-decode`:** While we were working on the server and UI, a parallel multi-agent team coordinated by the codec coordinator built a comprehensive pure-Rust DICOM pixel decoder workspace in `codecs/shl-dicom-decode` (covering native, RLE, JPEG 8/12-bit/lossless, JPEG-LS, JPEG 2000, and HTJ2K, verified against `codec-corpus/`). Once notified by the coordinator, we wired `shl-dicom-decode` directly beneath `decode_dicom_raw_frame` in `crates/shl-dicom-core/src/dicom_io.rs`. The only hiccup was a Cargo workspace inheritance error (`workspace.package.edition was not defined`) when referencing `../../codecs/shl-dicom-decode`, which we fixed by adding `[workspace.package]` (`edition = "2021"`, `license = "MIT OR Apache-2.0"`) to the root `Cargo.toml`.

---

## 3. Diagnosing Chrome Jank & The First UI Overhaul

### What Went Wrong in Version 1 of the Web UI
After all Stage 1–5 automated tests passed, Josh opened the app in Chrome on `http://localhost:3333` and gave blunt, accurate feedback:
1. *"What is this awful UI here?"* — pointing to a screenshot of the sandbox link creator showing a raw vertical list of 17 individual series checkboxes (`[x] MR · 4 SHOT PG DWI`, `[x] MR · 4 SHOT PG DWI`, …). *"Why do I have to pick series by series? We should just have a study picker at most."*
2. *"Why is it running so slowly? It's weird in Chrome."*
3. *"Way too much visual complexity on the screen right now. Focus on showing understandable flows and paths for users. Don't cram full multistep workflows into a small sidebar."*

### Profiling the Three Performance Bottlenecks
When we inspected the running server and Chromium profile, we found three compounding causes of jank:
1. **Re-decoding DICOM & JPEG on every Window/Level slider pixel move:** Moving the Window Center or Window Width slider called `session.render_instance_rgba(...)`, which re-parsed the DICOM Part 10 bytes and re-ran full pixel decompression on every `mousemove` event!
   - **Fix (`DecodedRawFrame` LRU cache):** We split `decode_dicom_slice` into `decode_dicom_raw_frame(part10_bytes) -> Result<DecodedRawFrame>` (which decodes the pixel data via `shl-dicom-decode` and rescales via `RescaleSlope`/`RescaleIntercept` once into a `Vec<f32>` buffer) and `DecodedRawFrame::to_rgba(override_wc, override_ww)`. In `WasmShlSession` (`crates/shl-dicom-wasm/src/session.rs`), we added a 24-slice `frame_cache` so Window/Level dragging runs in **< 1 ms** at 60 fps.
2. **Firing 17 parallel Range requests + main-thread WASM decodes simultaneously on load:** Loading a study fired `Promise.all` across all 17 series in the Brain MRI and decoded all 17 thumbnails back-to-back on the main thread, while all 17 HTTP requests contended on the server's per-share SQLite `Mutex<Connection>`.
   - **Fix:** We rendered the active series first so the main viewport appears immediately, and then staggered the contact-sheet thumbnail decodes sequentially with `await new Promise(r => setTimeout(r, 0))` yields between series so the browser main thread never blocks. We also replaced a DOM-heavy `<div>`-per-record map with a single `<canvas>` bar (`drawCanvasBar` in `web/record-map.ts`) that renders 6,000+ records in `< 0.1 ms`.
3. **Debug binary + re-seeding on every startup + slow SQLite transactions:** The server had been running from `target/debug/shl-dicom-server` and re-packing the `.tgz` archives on every start.
   - **Fix:** We switched to `cargo build --release`, persisted seed metadata in `data/seeded_demos.json` (`SEED_VERSION = 2`) for `< 10 ms` server restarts, and used `PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY;` during initial seeding and sandbox cloning.

### Testing Against Real Uncompressed Hospital Exports (`~/Downloads`)
Josh also pointed out two real hospital CD `.zip` exports in `~/Downloads` (`dicom-head-mri-jmandel-2020-07-…zip` at 47 MB and `DICOM-20261015T011419Z-1-001.zip` at 190 MB compressed / 391 MB uncompressed across 5 studies, 34 series, and 733 slices).
- **The `eFilmLite/*.dll` bare-DICOM trap:** Hospital CD `.zip` archives bundle Windows viewer binaries (`eFilmLite/MSVCP71.dll`, `efSplash.bmp`, `.xml`, `.ini`, `DICOMDIR`) alongside bare DICOM files (`DICOM/PA000000/ST000000/SE000001/IM000000`) that lack the 128-byte preamble + `"DICM"` magic. Our fallback bare-DICOM parser tried to parse `.dll` and `.bmp` files as bare DICOM datasets!
- **Fix:** In `crates/shl-dicom-core/src/dicom_io.rs`, we added `is_non_dicom_filename` and `looks_like_bare_dicom` (checking that bare little-endian DICOM datasets begin with a Group `0x0008` tag `[0x08, 0x00]`). With that filter and `--release`, `shl-dicom-server pack` packed all **391 MB (5 studies, 34 series, 733 slices)** into 64 KiB `AES-256-GCM` `.bin` files and a `15 KB` `bundle.jwe` in **2.71 seconds**!

### Splitting the Cluttered Screen into Three Focused Views
Instead of jamming the radiology viewer, protocol inspector, and sandbox link lab onto a single screen, we redesigned `web/index.html`, `web/styles.css`, and `web/main.ts` around three dedicated top-level views:
1. **`Viewer`**: A calm radiology layout (study picker + series thumbnails + 1-click `.dcm`/`.zip` export on the left, full-stage canvas with drag-to-W/L in the center, and the `<canvas>` 64 KiB record bar integrated into the bottom scrubber dock).
2. **`How it works`** (`web/view-explainer.ts`): A 3-step live visual walkthrough (`Step 1: Plain SMART Health Link`, `Step 2: FHIR R4 ImagingStudy Extensions`, `Step 3: 64 KiB AES-256-GCM Record Range Read`) driven by the active slice's real byte offsets and record numbers.
3. **`Share`** (`web/view-sharer.ts`): A spacious two-column workspace with **study-level checkboxes** (never series-by-series) on the left and the live SQLite `access_log` SSE stream on the right.

### Hurdle 2: Upstream Idle Timeouts & `camelCase` Serde Mismatch
While rewriting `web/main.ts` in a single large tool call, we hit repeated upstream idle timeouts (`The last request was aborted upstream`). The coordinator nudged us via tmux to split `web/` into smaller modules (`web/view-explainer.ts`, `web/view-sharer.ts`, `web/view-export.ts`, `web/qr-code.ts`) and keep each edit under ~150 lines, which completely eliminated the timeouts.
Immediately after splitting the modules, our first Playwright screenshot of the new UI revealed a red banner:
`Range GET undefined.bin (bytes=1638400-3280099) failed: HTTP 404` and `PUT link bundle.jwe failed: 400`.
- **Root cause:** In Rust (`crates/shl-dicom-core/src/bundle.rs` and `packer.rs`), `StudyIndex`, `SeriesSummary`, and `LinkBundleOutput` carried `#[serde(rename_all = "camelCase")]` (`fileId`, `ciphertextLength`, `recordCount`, `bundleJwe`, `shlKeyB64`, `allowedFiles`), whereas our newly split TypeScript interfaces had used `snake_case` (`file_id`, `bundle_jwe`). Aligning the TypeScript interfaces to `camelCase` fixed both errors on the spot.

---

## 4. Five Iterative UX Review Rounds with the Coordinator (`docs/ux-review-1..5.md`)

Once the 3-view architecture was up and running, the codec coordinator (acting on Josh's behalf) conducted five structured UX review rounds (`docs/ux-review-1.md` through `docs/ux-review-5.md`), inspecting live screenshots at desktop (`1440×900`), mobile portrait (`390×844` and `360×740`), and mobile landscape (`844×390`). This feedback loop was one of the most effective parts of the build.

### Round 1 (`docs/ux-review-1.md`): P0 Privacy, First Impression & Phone Stacking
- **P0 — Real identity on the landing page:** When we benchmarked the `~/Downloads/DICOM-…zip` CT Abdomen/Pelvis archive, we had wired `seed.rs` to automatically ingest `~/Downloads` if present on disk. That meant the default landing page opened onto an unpublished CT scan displaying the real patient name (`MANDEL^JOSHUA^^`) and birth date!
  - **Fix:** We immediately removed all `~/Downloads` paths from `crates/shl-dicom-server/src/seed.rs`, wiped `data/catalog.db` and `data/shares/`, re-seeded strictly from the published `data/samples/mri-brain-2020.tgz` + `wrist-low-res.tgz` archives (`SEED_VERSION = 2`), and masked the displayed patient name in demo mode to `"Demo Patient"` (with birth date hidden unless `?realName=1` is passed, and with DICOM `PN` formatting `"MANDEL^JOSHUA^^"` → `"Joshua Mandel"` when real names are shown) while keeping the underlying DICOM Part 10 bytes 100% untouched.
- **P1 — First impression & terminology:**
  - Added a dismissible intro band explaining what `shlink-dicom` is in one plain sentence.
  - Replaced `"Zero-Knowledge"` (which many readers associate with ZK-SNARKs) with factual language: `"End-to-End Encrypted DICOM over SMART Health Links"` and `"What the Host Never Receives / What the Host Stores & Sees"`.
- **P1 — Phone layout (`390×844`):**
  - At `390px` wide, the desktop side-by-side sidebar + viewport squeezed the MRI canvas to `120px` wide with overlapping HUD text. We added a responsive breakpoint (`@media (max-width: 850px)`) that puts the full-width image stage first (`order: 1`), the scrubber dock second, and converts the series list (`order: 2`) into a horizontal scrollable thumbnail strip.
- **P2 — Polish:** Added an inline SVG favicon to eliminate a console `404`, fixed a space typo in `id="record-hover-readout"`, and tucked the `"Verify Cornerstone & WADO-RS SW Bridge"` button into a collapsed `<details>` developer section.

### Round 2 (`docs/ux-review-2.md`): Auto-Scroll Bug, MR Window/Level & Plain Wording
- **The `scrollIntoView()` page-jump bug:** In Round 1, we had called `element.scrollIntoView({ block: "nearest" })` on the active series card when selecting a study. At `390×844` (where the series strip sits below the viewport), `scrollIntoView()` scrolled the *entire browser window* down by `143px` (`window.scrollY === 143`), pushing the navbar and intro band off-screen on load!
  - **Fix:** Removed `scrollIntoView()` completely, opened on series `0` so the top card is highlighted naturally, and only ever reset `list.scrollTop = 0; list.scrollLeft = 0;` on the `#contact-sheet-list` container. Verified `window.scrollY === 0` after load at both `1440×900` and `390×844`.
- **MR Window/Level investigation:** The coordinator noticed `WL: 6862 / WW: 13724` on `T1 SE SAG` and asked us to make sure we used the instance's `(0028,1050)`/`(0028,1051)` tags when present (or a 1st–99th percentile window when absent). Using `dcmdump` on the Toshiba MR slices inside `mri-brain-2020.tgz`, we confirmed that the scanner itself had written explicit full-range `(0028,1050)`/`(0028,1051)` tags into every slice (`5317 / 10634` on `4 SHOT PG DWI` slice 10; `6862 / 13724` on `T1 SE SAG` slice 9), and we added `percentile_window` (1st to 99th percentile) as the fallback whenever `(0028,1050)`/`(0028,1051)` is absent.
- **Intro band & Share wording:** Persisted intro dismissal in `localStorage`, hid duplicate header demo buttons while the intro band is visible, and simplified button labels (`"Mint SMART Health Link"` → `"Create link"`, `"End /cap/ Sessions"` → `"End open sessions"`, `"Active Sandbox Share: …"` → `"Your sandbox: 2 studies"`).

### Round 3 (`docs/ux-review-3.md`): Telling the Sharing Story in Under a Minute
Round 3 transformed the **Share** tab from a static form into an interactive end-to-end story:
1. **Client-side QR codes (`web/qr-code.ts`):** Bundled `qrcode-generator@1.4.4` directly into `dist/web/main.js` (zero external service or CDN) and rendered an **Error Correction Level M** SVG QR code on every link card that enlarges into a modal on click.
2. **Opening links in a new tab (`Open in Viewer ↗`) with labeled live SSE logs:** Making `Open in Viewer ↗` open a new browser tab (`target="_blank"`) meant the user could keep the **Share** tab open side-by-side and watch `[Hand Clinic] GET /shl/… status=206 Range: bytes=0-1733255` stream into the live host log in real time.
3. **Subset links (`Upper Extremity only`):** Added study-subset badges on each link card and kept `ownerStudyIndex` separate from the currently viewed link's `studyIndex` so viewing a 1-study subset link never shrank the Share tab's study checkboxes.
4. **Greyed-out Revoked & Offline states:** Instead of deleting a card from the DOM when **Revoke** is clicked, we kept the card visible in a greyed-out `.link-revoked` state reading `"Revoked: this link now returns 404"` with a **`Try revoked link`** button, and updated `web/shl-resolver.ts` so `404`/`410` responses throw `"This link was revoked or has expired."`

### Round 4 (`docs/ux-review-4.md`): Recipient View & Centred Failure Panel
- **Recipient context (`#recipient-band`):** When a visitor opens a `#shlink:/` URL directly, they are a recipient rather than a demo explorer. We hid the `"Try a demo"` intro band and added a clean one-line banner: `Shared with you: <link label> · <N studies>`.
- **Full-panel failure state (`#viewer-error-panel`):** Previously, when a link was revoked or a user exhausted all 5 passcode attempts, the error appeared in a top toast banner while the empty viewer skeleton (`"Opening SMART Health Link…"`, `"Slice – / –"`) remained visible underneath. We replaced the entire viewer stage on failure with a single centred card showing the reason (`"This link was revoked or has expired."`), guidance (`"Ask the sender for a new link, or open a sample study to explore the viewer."`), and **`Try a demo`** / **`Paste a different link`** buttons.

### Round 5 (`docs/ux-review-5.md`): Mobile Touch Gestures, 44 px Targets & Landscape
- **Pointer Events on `#canvas-stage` (`touch-action: none`):** Added 1-finger vertical drag to scrub slices (~1 slice per 9 px), 2-finger drag or press-and-hold drag for Window/Level, two-finger pinch zoom (`1×–5×`) with pan while zoomed, and double-tap to reset.
- **44 px coarse-pointer ergonomics:** Under `@media (pointer: coarse)`, enforced `min-height: 44px` on all buttons, tabs, selects, and sliders (`24×24 px` checkboxes, `28×28 px` slider thumbs, `8 px` gaps), verified via script (`smallControls = []` across `390×844`, `360×740`, and `844×390`).
- **Passcode Demo visibility:** Stopped auto-submitting the `1234` hint on `Passcode Demo (1234)` so tapping the button actually reveals the passcode prompt (`"Passcode required (Hint: 1234):"`) pre-filled with `1234` for the visitor to submit.
- **Viewport & Landscape (`844×390`):** Added `100dvh`, `viewport-fit=cover`, `env(safe-area-inset-*)`, a compact 1-line mobile intro band, and a side-by-side landscape media query so the image fills the full height on rotated phones.

---

## 5. What We Would Do Differently Next Time

1. **Keep local benchmark data strictly isolated from demo seed code from day one:** Even a temporary check in `seed.rs` that looks for files in `~/Downloads` is dangerous because it can silently populate a persistent SQLite database with real PHI/identifiable metadata. Benchmark inputs should only ever be passed via explicit CLI flags (`shl-dicom-server pack ~/Downloads/... --out /tmp/bench`).
2. **Generate TypeScript types from Rust `serde` structs (or test UI against live API JSON immediately):** The `camelCase` (`fileId`, `bundleJwe`) vs `snake_case` (`file_id`, `bundle_jwe`) mismatch after splitting `web/*.ts` would have been caught at compile time with shared generated types (e.g. `ts-rs` or `typeshare`).
3. **Start with modular `web/view-*.ts` files and small incremental edits:** Keeping each file and tool call focused (< 150 lines) not only avoided upstream idle timeouts, but also made each UX review round much faster and cleaner to verify.
4. **Always test mobile (`390×844` and `844×390` with `isMobile: true, hasTouch: true`) alongside desktop (`1440×900`):** Automated Playwright checks for `window.scrollY === 0`, `scrollWidth <= innerWidth`, `< 44px` touch targets, and synthetic `PointerEvent` touch drags caught layout and interaction issues that unit tests and desktop screenshots never surface.


