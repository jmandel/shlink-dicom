# Detailed API Design, Data Structures & Test Plan: `shlink-dicom`

## 1. Core Architectural Contracts

1. **Zero-Knowledge Server Contract (`Share` + `Link` Split with Per-Series Keys & `owner.jwe`):**
   - Each `.bin` series file is encrypted once under its own random 32-byte key (carried inside the Bundle's `https://example.org/shl-dicom/series-file` extension with `id` and `key` sub-extensions).
   - The server stores and serves only ciphertext (`{fileId}.bin` series files, the Share's `owner.jwe`, and per-link `bundle.jwe` files). Neither the owner key, any SHL link key, nor any series key is ever sent to the server.
   - **Resource Split:**
     - **`Share` (`{sid}`):** Owns the pool of encrypted `{fileId}.bin` series files, an encrypted **`owner.jwe`** (the full master Bundle of every series and its 32-byte `key`, encrypted under a 32-byte `ownerKey` held only by the owner), storage quotas, access history, and the `controlToken`.
     - **Management Credential:** `{ sid, controlToken, ownerKey }` (serializable as a management link/token). With `controlToken` and `ownerKey`, the owner can open the Share from any device, fetch and decrypt `owner.jwe`, and mint new Links (for any subset of series) without re-encrypting or re-uploading `.bin` files.
     - **`Link` (`{lid}`):** An access policy over a Share (`label`, `passcode`, `exp`, `longLived`, `online`, its own `bundle.jwe` encrypted under that Link's 32-byte SHL key, and an `allowedFiles` allowlist of `{fileId}.bin` names). Each Link has its own URL (`/shl/{lid}/bundle.jwe` in U-mode when created without a passcode, or `/shl/{lid}` in manifest mode when created with a passcode).
     - **Why this matters:** One Share can issue multiple Links to different recipients (each with its own SHL key, its own subset of series, its own passcode, expiry, revocation, and access log) without re-encrypting or re-uploading `.bin` files. Mode (`U` vs `P`) is fixed at Link creation based on whether a passcode is provided. Changing a passcode means creating a new Link and deleting the old one—and because a deleted Link's `{lid}` is permanently gone (`404`), a revoked link can **never** come back.
2. **Public Demo Protection & Quotas:**
   - Pre-seeded demo shares (`mri-brain-2020.tgz` and `wrist-low-res.tgz`, Josh Mandel's own studies shared publicly by choice in `jmandel/my-health-data`) are **read-only** on `/api/demo-shares` and never expose a `controlToken`.
   - Users can click **"Clone to Sandbox Share"** (`POST /api/shares/{sid}/clone`) or upload their own files to get an isolated, time-limited sandbox share with its own `controlToken` (the client decrypts the public demo Bundle to get the series keys and writes a fresh `owner.jwe` under the user's new `ownerKey`).
   - `POST /api/shares` and file `PUT`s enforce size and count quotas (e.g., max 150 MB per share, max 256 files per share, max 50 active sandbox shares, automatic expiry cleanup) so the server cannot be abused as an open file host.
3. **Persistent SQLite Storage (`--data-dir`, default `./data`, gitignored; see [`docs/storage.md`](docs/storage.md)):**
   ```
   data/
   ├── catalog.db                        # Routing catalog: shares(sid, expires_at), links(lid -> sid), caps(token -> lid, expires_at)
   ├── samples/
   │   ├── mri-brain-2020.tgz
   │   └── wrist-low-res.tgz
   └── shares/
       └── {sid}.db                      # Per-share SQLite DB: share(control_token_hash, owner_bundle), series_files, series_records(64KiB rows), links, link_files, access_log
   ```

---

## 2. Repository File Layout, Crate Boundaries & Responsibilities

### 2.1 Complete Directory & File Tree

```
shlink-dicom/
├── Cargo.toml                          # Rust workspace root (members: crates/*)
├── package.json                        # Bun build scripts for WASM + web/ frontend
├── PROPOSAL.md                         # Protocol specification
├── PLAN.md                             # Architecture, API, file layout & test plan
├── reference/                          # Standalone ~100-line TS/WebCrypto reference
│   ├── series-file.ts
│   └── test-vector.ts
├── fixtures/
│   └── golden/                         # Tracked F0 golden share fixtures (bundle.jwe, AAECAwQFBgcICQoLDA0ODw.bin, vector.json)
├── data/                               # Default --data-dir (gitignored; see docs/storage.md)
│   ├── catalog.db                      # Routing SQLite DB (shares, links, caps)
│   ├── samples/
│   │   ├── mri-brain-2020.tgz          # Cached Brain MRI archive (~34 MB)
│   │   └── wrist-low-res.tgz           # Cached Wrist archive (~6 MB)
│   └── shares/
│       └── {sid}.db                    # Per-share SQLite DB (share, series_files, series_records, links, link_files, access_log)
├── crates/
│   ├── shl-dicom-core/                 # Pure Rust library (NO std::fs, NO tokio, NO wasm_bindgen)
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                  # Public exports & crate-level error type
│   │       ├── crypto.rs               # §9.2 AES-256-GCM 64KiB record encrypt/decrypt (per-series 32B key, uint96_be(i) nonce)
│   │       ├── range.rs                # §9.3 Plaintext [a, b) <-> 64KiB ciphertext record math
│   │       ├── jwe.rs                  # SHL compact JWE (alg:dir, enc:A256GCM, zip:DEF)
│   │       ├── shl.rs                  # shlink:/ URI & payload parser/encoder + flag rules
│   │       ├── bundle.rs               # FHIR R4 Bundle, Patient, ImagingStudy builder & StudyIndex parser
│   │       ├── dicom_io.rs             # Part 10 / .tgz / .zip reader, tag extractor & DecodedRawFrame decoder via codecs/shl-dicom-decode
│   │       ├── packer.rs               # Stateful IngestSession -> PackedStudySet (series .bin + bundle.jwe)
│   │       └── export.rs               # Reconstruct Part 10 .dcm files & uncompressed .zip from decrypted bytes
│   │
│   ├── shl-dicom-wasm/                 # Thin wasm-bindgen wrapper over shl-dicom-core
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                  # Module init & JS error conversion
│   │       ├── session.rs              # WasmShlSession (sparse 64KiB record cache, 24-slice DecodedRawFrame LRU cache for <1ms W/L, range planner, RGBA renderer, .zip export)
│   │       └── packer.rs               # WasmPacker (browser-side zero-knowledge packing & L-flag study append)
│   │
│   └── shl-dicom-server/               # Native CLI + Axum HTTP server
│       ├── Cargo.toml
│       └── src/
│           ├── main.rs                 # Clap CLI (`pack`, `inspect`, `serve`)
│           ├── cli.rs                  # Offline `pack` and client `inspect` command implementations
│           ├── state.rs                # AppState, disk persistence (`meta.json`), capability token store, SSE broadcaster
│           ├── seed.rs                 # Downloads sample .tgz files if missing & seeds demo shares on startup
│           ├── routes_api.rs           # Zero-knowledge upload & Control API (/api/shares/*, /api/demo-shares)
│           ├── routes_shl.rs           # SHL protocol routes (/shl/{id}/*, /cap/{token}/*) + RFC 9110 HTTP 206 Range engine
│           └── dicomweb_import.rs      # Optional WADO-RS study importer for server/CLI
│
└── web/                                # Browser UI + Bridges (bundled by Bun into dist/web/)
    ├── index.html                      # Single-page shell (Viewer + Sharer/Host Control Drawer)
    ├── styles.css                      # Layout, Contact Sheet grid, Scrubber & 64KiB Record Map styles
    ├── main.ts                         # Entry point: routes #shlink:/..., initializes WASM, binds UI
    ├── api-client.ts                   # Client for Zero-Knowledge Share & Link API (supports cross-origin ?api=...)
    ├── shl-resolver.ts                 # Resolves U-mode & P/L-manifest links, refreshes once on 404 under /cap/
    ├── viewer-contact-sheet.ts         # Fires 1 Range request/series for middle slice & renders series cards
    ├── viewer-stack.ts                 # Interactive Canvas stack viewer, scrubber, W/L drag, background streamer
    ├── record-map.ts                   # Live 64KiB Record Map bar (Unfetched / 206 In-Flight / GCM OK / Tamper test)
    ├── exporter.ts                     # Triggers Current Slice (.dcm), Series (.zip), and Full Study (.zip) downloads
    ├── control-drawer.ts               # Browser WASM packer, U<->P/L toggles, QR generator, live Host SSE request log
    ├── cornerstone-bridge.ts           # Stage 5: Custom `shl-dicom:` image loader for Cornerstone
    └── sw-dicomweb.ts                  # Stage 5: Service Worker translating virtual WADO-RS requests to Range reads
```

### 2.2 Strict Crate Boundary Rules (Why WASM Compiles Cleanly)

| Crate | Target(s) | Allowed Dependencies | Forbidden Dependencies |
|---|---|---|---|
| **`shl-dicom-core`** | `native` AND `wasm32-unknown-unknown` | Pure-Rust crates only: `aes-gcm`, `sha2`, `flate2` (`rust_backend`), `tar`, `zip` (pure Rust), `dicom-object`, `base64`, `serde`, `serde_json`, `getrandom` (`js` feature on wasm32). Operates strictly on `&[u8]` and `Read`/`Write` cursors. | **No** `std::fs`, **no** `tokio`, **no** `reqwest`, **no** C `-sys` crates (`zstd-sys`, `openjp2-sys`, etc.), **no** `wasm-bindgen`. |
| **`shl-dicom-wasm`** | `wasm32-unknown-unknown` | `shl-dicom-core`, `wasm-bindgen`, `js-sys`, `serde-wasm-bindgen`. | **No** `tokio`, **no** `std::fs`. Network I/O (`fetch` with `Range`) stays in TypeScript and passes `Uint8Array` chunks into WASM. |
| **`shl-dicom-server`** | `native` (`x86_64` / `aarch64`) | `shl-dicom-core`, `tokio`, `axum`, `tower-http`, `reqwest`, `clap`. Handles all disk I/O (`data/shares/...`) and HTTP serving. | Never linked into WASM. |

### 2.3 File-by-File Responsibilities

#### In `crates/shl-dicom-core/src/`:
- **`crypto.rs`**: Owns the cryptographic primitives in §9.2 (`record_nonce`, `encrypt_series`, `decrypt_record`, `decrypt_range` using AES-256-GCM with each series' 32-byte key and `uint96_be(i)` nonces). Zero knowledge of DICOM or FHIR.
- **`range.rs`**: Pure arithmetic mapping `[plaintext_start, plaintext_end)` to `(first_record, last_record)` and `[ciphertext_start, ciphertext_end)`.
- **`jwe.rs`**: Compact JWE encryption and decryption (`alg: "dir"`, `enc: "A256GCM"`, `zip: "DEF"`).
- **`shl.rs`**: Encodes/decodes `shlink:/` payloads and computes legal `flag` strings (`"U"`, `"LU"`, `"P"`, `"LP"`, `"L"`).
- **`bundle.rs`**: Builds the R4 `Bundle` JSON from ingested DICOM metadata (declaring `meta.profile: ["https://example.org/shl-dicom/v1"]`, `Bundle.meta.lastUpdated`, the complex `series-file` extension with `id` and `key` sub-extensions on `series`, and the `length` extension on `instance`), subsets an owner Bundle for a Link (`subset_fhir_bundle`), and parses a decrypted `Bundle` back into a strongly-typed `StudyIndex` (computing cumulative byte offsets and covering 64 KiB record ranges for every instance).
- **`dicom_io.rs`**: Parses Part 10 files (or bare datasets), extracts study/series/instance metadata, and decodes **uncompressed and RLE** pixel data (pure Rust, zero C dependencies) with DICOM Window Center / Window Width into 8-bit RGBA buffers. Compressed transfer syntaxes (JPEG, JPEG-LS, JPEG 2000, HTJ2K) are handed as raw Part 10 `.dcm` bytes to Cornerstone's WASM codecs in the browser.
- **`packer.rs`**: Split into two clean steps:
  1. `IngestSession::pack()` (`A5`): groups ingested DICOM files by `(StudyInstanceUID, SeriesInstanceUID)`, sorts by `(InstanceNumber, SOPInstanceUID)`, draws random 16-byte `fileId`s and random 32-byte series `key`s, encrypts `{fileId}.bin` files, and produces the master owner `Bundle` JSON (which can be merged with an existing `owner.jwe` for `L`-flag additions).
  2. `build_link_bundle(owner_bundle, selected_file_ids, shl_key)` (`A5b`): filters the owner `Bundle` to `selected_file_ids` and encrypts a per-link `bundle.jwe` under `shl_key`.
- **`export.rs`**: Extracts individual Part 10 `.dcm` instance byte slices from decrypted series records using `instance.length`.

#### In `crates/shl-dicom-wasm/src/`:
- **`session.rs` (`WasmShlSession`)**: Holds the decrypted `StudyIndex` (which carries each series' 32-byte `key`) and a **bounded LRU sparse record cache** (capped at e.g. 64 MiB of verified 65,520 B records so multi-GB studies never exhaust `wasm32` memory). When JS fetches any HTTP `Range`, JS feeds the ciphertext into `ingest_ciphertext_range`, which verifies each 64 KiB record's GCM tag under that series' key and populates the bounded cache.
- **`packer.rs` (`WasmPacker`)**: Allows the browser to pack `.tgz`, `.zip`, or `.dcm` files completely client-side and return `{ shlKey, bundleJwe, seriesFiles }` for zero-knowledge upload to `/api/shares`.

#### In `crates/shl-dicom-server/src/`:
- **`state.rs`**: Manages `{data-dir}/catalog.db` and the LRU pool of `{data-dir}/shares/{sid}.db` SQLite databases (see [`docs/storage.md`](docs/storage.md)), startup/periodic orphan & expiry sweeps, and per-share `tokio::sync::broadcast` channels for live SSE telemetry.
- **`routes_api.rs`**: Implements the Zero-Knowledge Share & Link API (`POST /api/shares`, `PUT /api/shares/{sid}/owner.jwe`, `PUT /api/shares/{sid}/files/{name}`, `POST /api/shares/{sid}/links`, `PATCH /api/shares/{sid}/links/{lid}`, `DELETE /api/shares/{sid}/links/{lid}`, `POST /api/shares/{sid}/links/{lid}/end-sessions`, `GET /api/shares/{sid}/access`, `GET /api/shares/{sid}/events`, `GET /api/demo-shares`).
- **`routes_shl.rs`**: Implements the receiver-facing SHL routes (`GET /shl/{lid}/bundle.jwe`, `POST /shl/{lid}`, `GET /shl/{lid}/{fileId}.bin`, `GET /cap/{token}/...`) and the HTTP `206 Partial Content` byte-range responder querying indexed 64 KiB rows from `series_records`.

---

## 3. `shl-dicom-core` Rust API Signatures (Detailed)

### 3.1 `crypto` & `range` Modules
```rust
pub const RECORD_PLAINTEXT: u64 = 65_520;
pub const TAG_LEN: u64 = 16;
pub const RECORD_CIPHERTEXT: u64 = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CiphertextRange {
    pub first_record: u64,      // floor(start / 65520)
    pub last_record: u64,       // floor((end - 1) / 65520)
    pub ciphertext_start: u64,  // first_record * 65536 (inclusive)
    pub ciphertext_end: u64,    // min(C, (last_record + 1) * 65536) (exclusive)
    pub skip_prefix: usize,     // start - first_record * 65520
    pub length: usize,          // end - start
}

pub fn record_nonce(record_index: u64) -> [u8; 12]; // uint96_be(record_index)
pub fn ciphertext_length(plaintext_len: u64) -> u64;
pub fn ciphertext_range(start: u64, end: u64, plaintext_len: u64) -> Result<CiphertextRange>;
pub fn encrypt_series(plaintext: &[u8], series_key: &[u8; 32]) -> Vec<u8>;
pub fn decrypt_record(record_ct: &[u8], record_index: u64, series_key: &[u8; 32]) -> Result<Vec<u8>>;
pub fn decrypt_range(ciphertext_slice: &[u8], start: u64, end: u64, plaintext_len: u64, series_key: &[u8; 32]) -> Result<Vec<u8>>;
```

### 3.2 `jwe` & `shl` Modules
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShlPayload {
    pub url: String,
    pub key: String,            // 43-char base64url (32 bytes)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag: Option<String>,   // alphabetical: "L", "LP", "LU", "P", "U"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v: Option<u32>,
}

pub fn encrypt_bundle_jwe(bundle_json: &[u8], shl_key: &[u8; 32]) -> Result<String>;
pub fn decrypt_bundle_jwe(jwe_compact: &str, shl_key: &[u8; 32]) -> Result<Vec<u8>>;
pub fn encode_shlink_uri(payload: &ShlPayload, viewer_prefix: Option<&str>) -> String;
pub fn decode_shlink_uri(uri: &str) -> Result<ShlPayload>;
```

### 3.3 `dicom_io`, `bundle` & `export` Modules
- **Inputs accepted by `IngestSession`:**
  - `ingest_dicom_bytes(raw_bytes: Vec<u8>)` (Part 10 file or bare dataset; skips `DICOMDIR`)
  - `ingest_tar_gz(tgz_bytes: &[u8])`
  - `ingest_zip(zip_bytes: &[u8])`
- **Outputs from `IngestSession::pack()` (`A5`) and `build_link_bundle()` (`A5b`):**
  - `PackedStudySet`:
    - `owner_bundle_json: String` (FHIR R4 `Bundle` with `Bundle.meta.lastUpdated`, `Patient`, and one `ImagingStudy` per study declaring `meta.profile: ["https://example.org/shl-dicom/v1"]` and carrying the `series-file` (`id`, `key`) and `length` extensions)
    - `index: StudyIndex`
    - `series_files: Vec<PackedSeriesFile>` (`{ file_id: String, series_key: [u8; 32], plaintext_len: u64, ciphertext: Vec<u8> }`)
  - `build_link_bundle(owner_bundle_json: &str, selected_file_ids: &[String], shl_key: &[u8; 32]) -> Result<LinkBundleOutput>` (`{ shl_key_b64: String, bundle_json: String, bundle_jwe: String, allowed_files: Vec<String> }`)
- **Parsed Index (`StudyIndex` extracted from decrypted FHIR Bundle):**
  - Lists every `StudySummary -> SeriesSummary -> InstanceSummary`:
    ```rust
    pub struct InstanceSummary {
        pub uid: String,
        pub sop_class: String,
        pub number: Option<i32>,
        pub offset: u64,        // computed sum of prior instance lengths in series
        pub length: u64,        // from https://example.org/shl-dicom/length
        pub first_record: u64,  // floor(offset / 65520)
        pub last_record: u64,   // floor((offset + length - 1) / 65520)
    }
    ```
- **Pixel Decoding (`decode_dicom_slice`):**
  - Input: `dicom_part10_bytes: &[u8]`, `override_wc: Option<f64>`, `override_ww: Option<f64>`
  - Output:
    ```rust
    pub struct DecodedSlice {
        pub width: u32,
        pub height: u32,
        pub rgba: Vec<u8>,      // width * height * 4 bytes ready for Canvas ImageData
        pub window_center: f64,
        pub window_width: f64,
        pub min_pixel: f64,
        pub max_pixel: f64,
        pub instance_number: Option<i32>,
        pub sop_instance_uid: String,
    }
    ```
- **Streaming Original DICOM Export (`exporter.ts` + `export.rs`):**
  - Rather than buffering an entire series or study `.zip` inside `wasm32` linear memory, JS streams each series' `{fileId}.bin` (or iterates instance-by-instance), verifies records via WASM, and pipes each reconstructed Part 10 `.dcm` file directly into a streaming JS ZIP writer (with ZIP64 support) or a directory via the browser File System Access API.

---

## 4. `shl-dicom-wasm` Browser API (`wasm-bindgen`)

### 4.1 `WasmShlSession` (Viewing, Range Planning, Decrypting, Exporting)
- `WasmShlSession::from_shlink_and_jwe(shlink_uri: &str, bundle_jwe: &str) -> Result<WasmShlSession, JsError>`
- `session.index_json() -> String`: Returns JSON of `StudyIndex` (patient name/DOB, studies, series, instance offsets, record counts, total byte sizes).
- `session.plan_instance_range(study_idx: usize, series_idx: usize, instance_idx: usize) -> JsValue`:
  - Returns `{ fileId, firstRecord, lastRecord, ciphertextStart, ciphertextEnd, rangeHeader: "bytes=a-b" }`.
- `session.ingest_ciphertext_range(file_id: &str, first_record: u32, ciphertext: &[u8]) -> Result<JsValue, JsError>`:
  - Verifies the GCM tag of each 64 KiB record in `ciphertext`, stores verified plaintext records in the session's sparse record cache for `file_id`, and returns `{ verifiedRecords: [u32, ...], totalVerifiedBytes: u64 }`.
- `session.has_instance(study_idx: usize, series_idx: usize, instance_idx: usize) -> bool`:
  - True if all records `first_record..=last_record` for that instance are in the verified cache.
- `session.get_instance_dicom(study_idx: usize, series_idx: usize, instance_idx: usize) -> Result<Uint8Array, JsError>`:
  - Returns the exact original Part 10 `.dcm` bytes for that instance from the verified record cache.
- `session.render_instance_rgba(study_idx: usize, series_idx: usize, instance_idx: usize, wc: Option<f64>, ww: Option<f64>) -> Result<JsValue, JsError>`:
  - Decodes uncompressed/RLE cached instances and returns `{ width, height, rgba: Uint8Array, windowCenter, windowWidth, minPixel, maxPixel }` (or signals the frontend to pass `get_instance_dicom()` to Cornerstone's codec for compressed transfer syntaxes).

### 4.2 `WasmPacker` (Browser-Side Zero-Knowledge Packing & Link Bundle Builder)
- `WasmPacker::new() -> WasmPacker` (or `WasmPacker::from_owner_jwe(owner_key_b64: &str, owner_jwe: &str)` for `L`-flag study addition!)
- `packer.add_tgz(bytes: &[u8])` / `packer.add_zip(bytes: &[u8])` / `packer.add_dicom_file(bytes: &[u8])`
- `packer.pack(owner_key_b64: Option<String>) -> Result<JsValue, JsError>`:
  - Packs each new series into `{ fileId, key, ciphertext: Uint8Array }`, merges with any prior owner Bundle, encrypts `owner.jwe` under `ownerKey`, and returns `{ ownerKey: string, ownerJwe: string, ownerBundleJson: string, index: StudyIndex, newSeriesFiles: [{ fileId, ciphertext }] }`.
- `build_link_bundle_wasm(owner_bundle_json: &str, selected_file_ids: Vec<String>, shl_key_b64: Option<String>) -> Result<JsValue, JsError>`:
  - Filters `owner_bundle_json` to `selected_file_ids` (or all series if empty), encrypts `bundle.jwe` under a fresh (or supplied) 32-byte `shlKey`, and returns `{ shlKey: string, bundleJwe: string, allowedFiles: string[] }`.

---

## 5. `shl-dicom-server` HTTP REST & SHL Protocol Specification

### 5.1 Resource Schemas (`Share` and `Link`)

```ts
type Share = {
  id: string;
  createdAt: number;          // Unix seconds
  expiresAt: number | null;   // Sandbox TTL (Unix seconds) or null for permanent
  readOnly: boolean;
  hasOwnerBundle: boolean;    // true once PUT /api/shares/{sid}/owner.jwe succeeds
  files: Array<{
    name: string;             // "{22-char base64url}.bin"
    size: number;
    uploadedAt: number;
  }>;
  quota: {
    bytesUsed: number;
    bytesMax: number;         // e.g. 150 MB
    filesMax: number;         // e.g. 256 files
  };
  links: Link[];
};

type Link = {
  id: string;                 // Uniquely identifies this link (/shl/{lid}...)
  label: string | null;
  url: string;                // "{origin}/shl/{lid}/bundle.jwe" (no passcode) or "{origin}/shl/{lid}" (with passcode)
  flag: "U" | "LU" | "P" | "LP" | null;
  exp: number | null;         // Enforced by server; copied by client into SHL payload as a hint
  online: boolean;
  hasPasscode: boolean;
  remainingAttempts: number | null; // e.g. 5 when hasPasscode is true, null otherwise
  hasBundle: boolean;         // true once PUT /api/shares/{sid}/links/{lid}/bundle.jwe succeeds
  allowedFiles: string[];     // Subset of Share's "{fileId}.bin" files accessible through this link
  createdAt: number;
  lastAccessAt: number | null;
  accessCount: number;
};
```

### 5.2 Zero-Knowledge Share & Link Control Endpoints

All `/api/*` routes answer `OPTIONS` preflight requests (`Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization, Range, X-Expected-Size`) so a static web app on GitHub Pages can call an `*.exe.dev` server cross-origin.

| Method & Path | Auth | Request Body / Params | Response |
|---|---|---|---|
| `POST /api/shares` | None (quota-limited) | `{}` | `201 Created`: `{ share: Share, controlToken: string }` (`controlToken` returned once) |
| `POST /api/shares/{sid}/clone` | None (quota-limited) | `{}` (clones a demo share's `.bin` files into a sandbox share) | `201 Created`: `{ share: Share, controlToken: string }` |
| `GET /api/shares/{sid}` | `Bearer {controlToken}` | — | `200 OK`: `Share` |
| `DELETE /api/shares/{sid}` | `Bearer {controlToken}` | — | `204 No Content` (removes all files, links, and active `/cap/` prefixes) |
| `PUT /api/shares/{sid}/owner.jwe` | `Bearer {controlToken}` | Raw compact JWE encrypted under `ownerKey` (`application/jose`) | `200 OK`: `{ ok: true, size: number }` |
| `GET /api/shares/{sid}/owner.jwe` | `Bearer {controlToken}` | — | `200 OK`: raw `owner.jwe` (`application/jose`) |
| `PUT /api/shares/{sid}/files/{name}` | `Bearer {controlToken}` | Raw encrypted series bytes (`name` MUST match `^[A-Za-z0-9_-]{22}\.bin$`, else `400`; optional `X-Expected-Size` checked against body length) | `200 OK`: `{ name, size, uploadedAt }` |
| `DELETE /api/shares/{sid}/files/{name}` | `Bearer {controlToken}` | — | `204 No Content` (returns `409 Conflict` if any existing Link on the Share still lists `{name}` in `allowedFiles`) |
| `POST /api/shares/{sid}/links` | `Bearer {controlToken}` | `{ label?: string, passcode?: string, exp?: number, longLived?: boolean, allowedFiles: string[] }` | `201 Created`: `Link` |
| `PUT /api/shares/{sid}/links/{lid}/bundle.jwe` | `Bearer {controlToken}` | Raw compact JWE encrypted under `{lid}`'s SHL key (`application/jose`) | `200 OK`: `Link` (`hasBundle: true`) |
| `PATCH /api/shares/{sid}/links/{lid}` | `Bearer {controlToken}` | `{ label?: string\|null, exp?: number\|null, online?: boolean, allowedFiles?: string[] }` (no passcode or mode changes) | `200 OK`: `Link` |
| `DELETE /api/shares/{sid}/links/{lid}` | `Bearer {controlToken}` | — | `204 No Content` (permanently `404`s `{lid}` and ends all its `/cap/` prefixes) |
| `POST /api/shares/{sid}/links/{lid}/end-sessions` | `Bearer {controlToken}` | `{}` | `200 OK`: `{ revokedCount: number }` (invalidates open 1-hour `/cap/` prefixes for `{lid}`) |
| `GET /api/shares/{sid}/access?since=` | `Bearer {controlToken}` | Optional `since` timestamp | `200 OK`: `{ events: AccessEvent[] }` |
| `GET /api/shares/{sid}/events` | `Bearer {controlToken}` (via `fetch` stream) | SSE stream | `event: access\ndata: {"ts":...,"lid":"...","method":"GET","path":"...","range":"bytes=65536-131071","status":206,"bytes":65536,"recipient":"..."}\n\n` |
| `GET /api/demo-shares` | None | — | `200 OK`: `{ shares: [{ id, title, description, shlinkUri, readOnly: true, share: Share }] }` (never exposes `controlToken`) |

**Rules enforced by the Share & Link API:**
- **Owner management across sessions (`owner.jwe`):** The owner's client stores `{ sid, controlToken, ownerKey }` (in `localStorage` and exportable as a management link). Fetching and decrypting `GET /api/shares/{sid}/owner.jwe` with `ownerKey` gives the client the full `StudyIndex` (including every `fileId` and 32-byte series `key`) needed to mint new Links or append studies from any device.
- **Each Link has its own SHL key, `bundle.jwe`, and `allowedFiles` list:** Because each `.bin` series file is encrypted under its own random 32-byte key carried inside the Link's Bundle, a Link only exposes the keys and files listed in its own Bundle and `allowedFiles`.
- **Mode follows from passcode at Link creation:**
  - Without `passcode`: U-mode (`flag`: `"LU"` if `longLived` else `"U"`, `url`: `{origin}/shl/{lid}/bundle.jwe`).
  - With `passcode`: Manifest mode (`flag`: `"LP"` if `longLived` else `"P"`, `url`: `{origin}/shl/{lid}`).
- **Changing a passcode:** Create a new Link (`POST /api/shares/{sid}/links` + `PUT .../bundle.jwe` with a fresh SHL key) and delete the old Link (`DELETE /api/shares/{sid}/links/{lid}`). A deleted Link ID is never reused and never revives.
- **Passcode storage & attempt limit:** Only a salted SHA-256 hash (`sha256(salt || passcode)`) is stored in `meta.json`. Each passcode-protected Link has a lifetime `remainingAttempts` counter (initialized to `5`), decremented atomically under a mutex before validating an attempt. Once `remainingAttempts == 0`, the Link permanently returns `404`.
- **Publish order for `L`-flag updates:**
  - **Adding series to a Link:** (1) `PUT` new `{fileId}.bin` files to the Share and update `owner.jwe`, (2) `PATCH` the Link's `allowedFiles` to include the new files, (3) `PUT` the Link's updated `bundle.jwe` (with a fresh 12-byte JWE IV).
  - **Removing series from a Link:** (1) `PUT` the Link's updated `bundle.jwe` (omitting the removed series) first, (2) `PATCH` the Link's `allowedFiles` to narrow the list, (3) `DELETE` obsolete `{oldFileId}.bin` files from the Share (which enforces `409 Conflict` if any Link still lists the file).

### 5.3 SHL Resolution & Range Endpoints (`/shl/{lid}/*` and `/cap/{capToken}/*`)

All inactive, offline, expired, unallowed, or deleted Links and capability prefixes return **`404 Not Found`** consistently. On any `404` under `/cap/{capToken}/*`, the client (`shl-resolver.ts`) re-resolves `POST /shl/{lid}` once to obtain a fresh `/cap/` prefix and resumes its Range request.

| Method & Path | Condition | Behaviour |
|---|---|---|
| `GET /shl/{lid}/bundle.jwe?recipient=...` | Link exists, `hasBundle`, `online`, `!expired`, and `!hasPasscode` | Returns Link `{lid}`'s `bundle.jwe` (`200 OK`, `application/jose`) with an `ETag` header (answering `If-None-Match` with `304 Not Modified`). Returns `404` otherwise. |
| `GET /shl/{lid}/{fileId}.bin` | Link exists, `online`, `!expired`, `!hasPasscode`, and `{fileId}.bin` in `allowedFiles` | Honours `Range: bytes=a-b` (`206 Partial Content` + `Content-Range: bytes a-b/C`, `Content-Type: application/octet-stream`, no `Content-Encoding`, `Access-Control-Allow-Origin: *`) or `200 OK`. Returns `404` otherwise. |
| `POST /shl/{lid}` | Link exists, `hasBundle`, `online`, `!expired`, `hasPasscode`, and `remainingAttempts > 0` | Atomically checks/decrements `remainingAttempts` on mismatch (returns `401` with `remainingAttempts`, or `404` once exhausted). On match, mints a 1-hour `capToken` (32 random bytes, base64url) bound to `(sid, lid)` and returns `{ "status": "can-change" /* if L flag set */, "files": [{ "contentType": "application/fhir+json;fhirVersion=4.0.1", "location": "{origin}/cap/{capToken}/bundle.jwe", "lastUpdated": "..." }] }`. |
| `GET /cap/{capToken}/bundle.jwe` | `capToken` valid (<1 hr, not ended) AND parent Link is `online` and `!expired` | Returns Link `{lid}`'s `bundle.jwe` (`200 OK`). Returns `404` if `capToken` expired/ended or parent Link is offline/expired/deleted. |
| `GET /cap/{capToken}/{fileId}.bin` | `capToken` valid (<1 hr, not ended), parent Link `online`/`!expired`, and `{fileId}.bin` in `allowedFiles` | Honours `Range: bytes=a-b` (`206 Partial Content`, no `Content-Encoding`) or `200 OK`. Returns `404` otherwise. |

---

## 6. Stages, Dependency Tree & Parallel Execution

### 6.1 Dependency Graph

```
F0  Fixtures & contracts ───────────────────────────────────────────────┐
    (sample .tgz, Appendix B vector as JSON, a small "golden share"      │
     folder: bundle.jwe + .bin made by the TS reference, StudyIndex JSON │
     shape, wasm API signatures)                                         │
                                                                         │
Core (Rust)                Server (Rust)              Web (TS)           │
A1 crypto+range ─┐         B1 /shl + /cap routes,     D1 shl-resolver,   │
A2 jwe+shl ──────┤            206 Range engine ◄──────── fetch/Range ◄───┤ (all can start on F0)
A3 dicom_io parse┤         B2 state: meta.json,       D3 record-map      │
                 │            caps, passcode counter                     │
A4 bundle build/parse ◄ A3    │                                          │
A5 packer ◄ A1 A3 A4       B3 upload/control API ◄ B2                    │
A5b link bundle ◄ A2 A4    B4 seed + B5 CLI pack/inspect ◄ A5 A5b        │
A6 export ◄ A4                                                           │
A7 pixel decode ◄ A3                                                     │
                                                                         │
WASM: C1 session ◄ A1 A4 · C2 packer ◄ A5 A5b · C3 render ◄ A7           │
Web:  D2 viewers ◄ C1 C3 · D4 exporter ◄ C1 A6 · D5 control drawer ◄ B3 C2
      D6 Cornerstone bridge + Service Worker ◄ C1 (Stage 5)
E2E:  Playwright ◄ B4 D2 D4 D5
```

### 6.2 What Can Run in Parallel

Fixing `F0` first (generating a small golden share `bundle.jwe` + `{fileId}.bin` from the TypeScript reference, along with the `StudyIndex` JSON shape and WASM signatures) unlocks parallel execution across all three layers without waiting for the Rust packer:

- **Immediately after `F0` (five independent tracks):** `A1`, `A2`, and `A3` (Rust core), `B1` and `B2` (server routes and state tested against the golden share), `D1` and `D3` (browser SHL resolver and 64 KiB record map).
- **Critical path:** `A3 → A4 → A5 → C2 → D5 → E2E` (DICOM parsing → Bundle builder → packer → browser WASM packer → control drawer → end-to-end verification). `A5` is the primary join point because seeding (`B4`), the CLI (`B5`), and browser-side packing (`C2`) all depend on it.
- **Off the critical path:** `A7` and `C3` (pure-Rust pixel decoding for uncompressed/RLE) and `D6` (Cornerstone bridge and Service Worker DICOMweb adapter).

### 6.3 Stage Deliverables & Exit Checks

| Stage | Contents | Deliverable | Done When (Exit Check) |
|---|---|---|---|
| **Stage 0** | `F0` | Sample `.tgz` archives cached; Appendix B vector JSON + golden share (`bundle.jwe` + `{fileId}.bin`) generated by TS reference; `StudyIndex` & WASM TypeScript interfaces committed. | Golden share decrypts and verifies with the TS reference; contracts are committed. |
| **Stage 1** | `A1–A7` | `crates/shl-dicom-core`: STREAM crypto, range math, JWE, SHL URI codec, DICOM parser/pixel decoder, FHIR R4 Bundle builder/index parser, packer, and `.dcm` slice extractor. | `cargo test -p shl-dicom-core` passes: Appendix B matches byte for byte, edge-case ranges pass, and `mri-brain-2020.tgz` + `wrist-low-res.tgz` pass 100% SHA-256 round-trip checks. |
| **Stage 2** | `B1–B5` | `crates/shl-dicom-server`: `/shl` & `/cap` routes with HTTP `206` Range engine, disk state (`meta.json`), atomic passcode counter, zero-knowledge upload/control API, demo seeding, and CLI (`pack`, `inspect`, `serve`). | `cargo test -p shl-dicom-server` passes against both the `F0` golden share and shares built by `A5`. |
| **Stage 3** | `C1–C3` | `crates/shl-dicom-wasm`: `WasmShlSession` (bounded LRU record cache, range planner, instance extractor, RGBA renderer) and `WasmPacker`. | Headless Bun + WASM integration test passes (packing, partial range ingestion, RGBA decode, and `.dcm` extraction). |
| **Stage 4** | `D1–D5` | `web/`: SHL resolver (with 1-hr `/cap/` refresh), Instant Contact Sheet, Stack Viewer, 64 KiB Record Map + tamper simulator, streaming `.dcm`/`.zip` exporter, and Zero-Knowledge Control Drawer. | Playwright end-to-end test passes against the running server and demo shares. |
| **Stage 5** | `D6` | `web/cornerstone-bridge.ts` (`shl-dicom:` loader) and `web/sw-dicomweb.ts` (virtual WADO-RS Service Worker). | Cornerstone / DICOMweb consumer renders a study and frame through the Service Worker Range bridge. |

---

## 7. Comprehensive Test Plan Across Stages

### Stage 0 Tests (`bun reference/test-vector.ts`)
1. Generates and verifies the `F0` golden share (`bundle.jwe` + `AAECAwQFBgcICQoLDA0ODw.bin`) and Appendix B JSON fixture.

### Stage 1 Tests (`cargo test -p shl-dicom-core`)
1. **`test_appendix_b_vector`**: Asserts `encrypt_series`, record tags, ciphertext SHA-256, and instance-2 `decrypt_range(70000, 150000)` match Appendix B and `reference/test-vector.ts` byte-for-byte.
2. **`test_range_and_record_edge_cases`**:
   - Plaintext length that is an exact multiple of `65,520` bytes (e.g., `65,520` and `131,040`).
   - An instance spanning 4+ records (`250,000` bytes).
   - A range starting on an exact record boundary (`start = 65,520`).
   - A range ending in the short final record (`end = P`).
   - A 0-length or inverted range (`start == end` or `start > end`) returning `Err`.
3. **`test_tamper_and_truncation`**: Flipped ciphertext bit, swapped record 0 and 1, truncated final record, wrong series `key` all return `Err`.
4. **`test_jwe_roundtrip_and_fresh_iv`**: Encrypts a FHIR Bundle as `dir` + `A256GCM` + `DEF`, verifies compact format has 5 dot-separated parts with empty encrypted key, verifies two encryptions produce distinct 12-byte IVs, and decrypts back to identical JSON.
5. **`test_pack_and_lossless_roundtrip_mri_and_wrist`**:
   - Ingests `data/samples/mri-brain-2020.tgz` and `data/samples/wrist-low-res.tgz` into one multi-study Bundle.
   - Verifies `Bundle` has 2 `ImagingStudy` resources declaring `meta.profile: ["https://example.org/shl-dicom/v1"]` and valid `series-file` (`id`, `key`) and `length` extensions.
   - For every series, decrypts both full series and individual instances via `decrypt_range`, reconstructs the Part 10 `.dcm` files, and asserts **100% SHA-256 match** against every Part 10 `.dcm` file from the `.tgz` archives (after Part 10 wrapping if any bare dataset was wrapped).
   - Verifies `decode_dicom_slice` produces non-empty RGBA8 buffers with valid dimensions for the middle slice of every series.

### Stage 2 Tests (`cargo test -p shl-dicom-server`)
1. **`test_zero_knowledge_upload_and_u_mode_range`**:
   - Client packs a study locally, calls `POST /api/shares`, `PUT`s `{fileId}.bin` (verifying invalid filenames like `../foo.bin` or `short.bin` are rejected with `400`, and `X-Expected-Size` mismatches are rejected), creates a U-mode Link via `POST /api/shares/{sid}/links`, and `PUT`s `bundle.jwe` to `/api/shares/{sid}/links/{lid}/bundle.jwe`.
   - Receiver resolves `shlink:/`, fetches `bundle.jwe`, computes `ciphertext_range` for middle instance, sends `Range: bytes=from-to` with `Accept-Encoding: gzip, br`, verifies `206 Partial Content`, exact `Content-Range`, `Access-Control-Allow-Origin: *`, **no `Content-Encoding` header**, and verifies SHA-256 of the decrypted instance.
2. **`test_passcode_attempt_limit_and_concurrency`**:
   - Creates a passcode Link (`5` attempts max).
   - Fires 10 concurrent `POST /shl/{lid}` requests with a wrong passcode; verifies atomic counting allows at most 5 failures (`401`) and subsequent requests (even with the *correct* passcode) return `404`.
3. **`test_multiple_links_subset_scoping_and_permanent_deletion`**:
   - Creates Link A (U-mode, subset of series in `allowedFiles` and its own `bundle.jwe`) and Link B (`P`-mode with passcode `"9876"`, `longLived: true`, all series) over the same Share.
   - Verifies Link A can `GET` its allowed `{fileId}.bin` (`200`/`206`) but gets `404` when requesting a `{fileId}.bin` not in Link A's `allowedFiles`.
   - Verifies `POST /shl/{lidB}` with `"9876"` returns `status: "can-change"`, `contentType: "application/fhir+json;fhirVersion=4.0.1"`, and `/cap/{token}/bundle.jwe`.
   - Deletes Link A (`DELETE /api/shares/{sid}/links/{lidA}`); verifies Link A returns `404` and creating a new U-mode Link C gets a new `{lidC}` and **does not revive Link A**.
   - Deletes Link B (`DELETE /api/shares/{sid}/links/{lidB}`); verifies both `/shl/{lidB}` and its previously minted `/cap/{token}/...` immediately return `404`.
4. **`test_link_controls_and_mid_download_session_expiry`**:
   - **Offline & expiry (`exp`) enforcement:** `PATCH /api/shares/{sid}/links/{lid}` with `{ online: false }` -> `/shl/{lid}` and `/cap/{token}` return `404`; `{ online: true }` restores access; setting `exp` in the past returns `404`.
   - **Mid-download `/cap/` expiry & Range resumption:** Fetches first half of a series via `/cap/{token1}/{fileId}.bin`, calls `POST /api/shares/{sid}/links/{lid}/end-sessions`, confirms `token1` now returns `404`, re-POSTs to `/shl/{lid}` to get `token2`, fetches remaining records from `/cap/{token2}/{fileId}.bin`, and verifies full series assembly.
   - **Long-lived (`L`) study append in publish order:** Client `PUT`s new `{fileId}.bin` to Share first, then `PATCH`es `allowedFiles` and `PUT`s updated `bundle.jwe` to the Link, then `DELETE`s replaced `.bin` files; receiver sees both studies.
   - **Read-only demo share protection & cloning:** Confirms `/api/demo-shares` omits `controlToken`, and `POST /api/shares/{sid}/clone` creates a controllable sandbox copy.

### Stage 3 Tests (`bun test/wasm.test.ts`)
1. Loads the compiled `shl-dicom-wasm` module in Bun, runs `WasmPacker` on sample `.dcm` files, initializes `WasmShlSession`, verifies partial range ingestion (`ingest_ciphertext_range`), bounded LRU cache eviction, RGBA rendering (`render_instance_rgba`), and single-instance `.dcm` extraction (`get_instance_dicom`).

### Stage 4 Tests (Playwright E2E)
1. Opens the running server, loads the pre-seeded Brain MRI + Wrist multi-study link, verifies the Contact Sheet renders thumbnails via `206` Range requests, scrubs slices while verifying the 64 KiB Record Map updates, downloads an original `.dcm` and `.zip`, clones a demo share into a sandbox share, and exercises the Control Drawer toggles.

### Stage 5 Tests (Cornerstone & Service Worker DICOMweb E2E)
1. Registers `sw-dicomweb.ts`, requests WADO-RS metadata, instance, and frame URLs (`/dicomweb/studies/{study}/series/{series}/...`), and renders a slice via the `shl-dicom:` Cornerstone loader.
