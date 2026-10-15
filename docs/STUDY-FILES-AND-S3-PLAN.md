# Plan: Study-Level Encrypted Files and S3 Blob Storage

Status: approved by Josh, October 2026.

This document specifies two changes to `shlink-dicom`, sequenced to run after the in-flight Share work (remembering picked files and deploy-time CLI sample packing) lands, with Part 1 completed and verified before Part 2 begins:

1. **Part 1 — Study-level encrypted files with optional series-level override (`linked-file` and `instance-length` under `http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/`).**
2. **Part 2 — Storage abstraction (`BlobStore` trait with `LocalFsStore` and `S3Store`).**

---

## Part 1: Study-Level Encrypted Files (with Optional Series Override)

### 1.1 Motivation

Today `PROPOSAL.md` §8–9 uses placeholder `https://example.org/shl-dicom/*` URLs, places `{ id, key }` on every `ImagingStudy.series`, and writes one `{fileId}.bin` per series. Moving the default file and key boundary up to `ImagingStudy` (while allowing an optional series-level override for later appends) changes the system in five ways:

1. **Range access is unchanged.**
   - `PROPOSAL.md` §10.1 already requires HTTP `Range` (`206 Partial Content`).
   - In a study file whose plaintext is the study's instances concatenated in `series[].instance[]` order, every series, every instance, and every frame or tile is still a contiguous byte range inside `{fileId}.bin`.
   - Fetching one slice, one whole-slide tile, or one series still uses a single `Range: bytes=a-b` request and the same 64 KiB AES-256-GCM record layout (`R = 65,520`, 16-byte tag, `nonce = uint96_be(i)`).
2. **Fewer files and less metadata visible at rest.**
   - A clinical CT or MRI study often contains 10–30 series (localizers, axial/coronal/sagittal reconstructions, thin slices, dose reports, secondary captures). Our 6-study sample currently produces 36 `.bin` files on disk, showing the host the series count and exact byte size of each series.
   - Packing one file per study by default means the host sees one `.bin` file per study at rest (6 files for 6 studies) and only the total study size. As a viewer fetches slices or series via `Range` requests, the requested offsets still reveal the boundaries of the parts that are viewed (§13).
3. **Matches the sharing and management flow.**
   - `/share` and `/share/manage` select, upload, and subset whole studies (`subsetBundle(owner, studyIds)`).
   - Giving each `ImagingStudy` its own `{fileId}.bin` and 32-byte key preserves cryptographic separation when an owner creates a link for a subset of studies in a multi-study share.
4. **Supports appending a series later without re-encrypting the study.**
   - Because `linked-file` is allowed on `ImagingStudy` (the default for all series in the study) and optionally on `ImagingStudy.series` (overriding the default for that series), a sharer updating a long-lived (`L`) link with a new series can write only the new series to a fresh `{fileId}.bin` and attach `linked-file` to that `series` without re-encrypting or re-uploading the original study file.
5. **HL7 SMART Health Cards and Links canonical URLs.**
   - Replaces the `https://example.org/shl-dicom/*` placeholder namespace with canonical URLs under `http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/` (where this profile will be published), closing Open Question 1 in `PROPOSAL.md` §15.

---

### 1.2 Wire Format and Spec Changes (`PROPOSAL.md`)

1. **Profile and extension URLs (`§8.1`):**
   - `ImagingStudy.meta.profile`: `["http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/dicom-imaging-study"]`
   - Extensions:

   | Extension / Sub-extension | On | Type | Meaning |
   |---|---|---|---|
   | `http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/linked-file` | `ImagingStudy`, `ImagingStudy.series` | complex | Groups the encrypted file identifier and encryption key. On `ImagingStudy`, sets the default file for all series in the study; on `ImagingStudy.series`, overrides that default for the series: |
   | ↳ `id` | `linked-file` | `valueString` | The file id: 16 random bytes, base64url-encoded without padding (22 characters). Names the immutable file (`{id}.bin`). |
   | ↳ `key` | `linked-file` | `valueString` | The encryption key: 32 random bytes, base64url-encoded without padding (43 characters). |
   | `http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/instance-length` | `ImagingStudy.series.instance` | `valueDecimal` (a non-negative integer) | Length in bytes of this instance's DICOM file. |

   - Every shared `series` MUST resolve to a `linked-file` either from its own `extension` or from its parent `ImagingStudy.extension`.
   - If two series in the same `ImagingStudy` resolve to the same `fileId`, they MUST carry the same `key`.
   - Nothing else is sent on the wire: series offsets, series byte totals, file plaintext length `P`, ciphertext length `C`, and record count `n` are computed in memory by summing `instance` lengths per `fileId`.

2. **Byte order and offset rules (`§8.1`, `§9.1`):**
   - **Within each distinct `fileId`, the order of `series` and `series.instance` referencing that `fileId` is the order of the bytes in `{fileId}.bin`.**
   - Walking `ImagingStudy.series` in array order and each `series.instance` in array order while maintaining a running byte offset per `fileId` (starting at `0` for each `fileId`):
     - Each instance occupies `[inst.offset, inst.offset + inst.length)` in the plaintext of its series' resolved `{fileId}.bin`.
     - Each series occupies `[series.offset, series.offset + series.bytes)` in that `{fileId}.bin`, where `series.offset` is its first instance's `offset` and `series.bytes` is the sum of its instances' lengths.
     - For a given `{fileId}.bin`, its total plaintext length `P` is the final running offset for that `fileId` after all series referencing it have been walked.
   - **Default packing rule (`§11.1`):** When packing a study from scratch, a sharer writes one `{fileId}.bin` per `ImagingStudy`, places `linked-file` once on `ImagingStudy`, and omits `linked-file` from `ImagingStudy.series`.

3. **Security and trade-off notes (`§10.3`, `§13`, `§14`, `§15`):**
   - **§10.3 Updates (`L` flag):** Adding a new study uploads a new `{fileId}.bin`. Adding a new series to an existing study can either write a new `{fileId}.bin` for just that series (attaching `linked-file` to the new `series` element) or rewrite the study's file with a fresh `id` and `key`.
   - **§13 Security and privacy:** At rest, packing one file per study hides the count and individual sizes of the study's series (the host sees one file per study and the total study size). During viewing, the byte ranges requested by a client still reveal the offsets and sizes of the instances or series being read.
   - **§14 Alternatives considered:** Note why one file per study (with optional series override for appends) is preferred over always splitting into one file per series (which multiplies file/key count by 10–30× per CT/MR study and leaks every series size at rest).
   - **§15 Open questions:** Remove Open Question 1 (profile and extension URLs are now under `http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/`).

---

### 1.3 In-Memory Data Model (`crates/shl-dicom-core` and `web/core/`)

Each distinct `fileId` is represented once by a `FileEntry` (`FileSummary` in Rust) holding `{ fileId, key, plaintextLength, ciphertextLength, recordCount }`. Each `SeriesEntry` holds a `file: FileEntry` reference plus its own `offset`, `bytes`, `firstRecord`, and `lastRecord`, and each `StudyEntry` holds `files: FileEntry[]` (the distinct files referenced by its series, in first-use order). Downstream functions continue to take `series: SeriesEntry` alone while file-level facts live in one place (`series.file`):

#### TypeScript (`web/core/bundle.ts`, `web/core/range.ts`, `web/core/decrypt.ts`)
```ts
export const PROFILE_URL =
  "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/dicom-imaging-study";
export const EXT_LINKED_FILE =
  "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/linked-file";
export const EXT_INSTANCE_LENGTH =
  "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/instance-length";

export interface FileEntry {
  /** 22-character file id; the file is `{fileId}.bin` next to the Bundle. */
  fileId: string;
  /** 43-character base64url 32-byte encryption key. */
  key: string;
  /** Total plaintext length of `{fileId}.bin` across all series that reference it. */
  plaintextLength: number;
  ciphertextLength: number;
  recordCount: number;
}

export interface InstanceEntry {
  uid: string;
  sopClass: string;
  number: number | null;
  /** Byte offset of this Part 10 file in `{series.file.fileId}.bin` plaintext [0, series.file.plaintextLength). */
  offset: number;
  length: number;
  firstRecord: number;
  lastRecord: number;
}

export interface SeriesEntry {
  uid: string;
  number: number | null;
  modality: string | null;
  description: string | null;
  bodySite: string | null;
  /** The encrypted file (`{fileId}.bin`) this series lives in. */
  file: FileEntry;
  /** Byte offset of this series' first instance in `{file.fileId}.bin` plaintext. */
  offset: number;
  /** Sum of this series' instance lengths (used for UI size display and series downloads). */
  bytes: number;
  /** First and last 64 KiB record indices covering this series in `{file.fileId}.bin`. */
  firstRecord: number;
  lastRecord: number;
  instances: InstanceEntry[];
}

export interface StudyEntry {
  id: string;
  studyInstanceUid: string;
  description: string | null;
  started: string | null;
  modalities: string[];
  notes: string[];
  accession: string | null;
  /** Distinct encrypted files referenced by this study's series, in first-use order. */
  files: FileEntry[];
  numberOfSeries: number;
  numberOfInstances: number;
  /** Sum of `series.bytes` across all series in this study. */
  bytes: number;
  series: SeriesEntry[];
}
```

- **Range planning (`web/core/range.ts`):**
  - `planBytes(series: SeriesEntry, a: number, b: number): RangePlan` checks `0 <= a < b <= series.file.plaintextLength`, clamps `ciphertextEnd` to `series.file.ciphertextLength`, and sets `fileId: series.file.fileId`.
  - `planInstances(series: SeriesEntry, first: number, last = first): RangePlan` plans `[series.instances[first].offset, series.instances[last].offset + series.instances[last].length)` in `{series.file.fileId}.bin`.
  - `planSeries(series: SeriesEntry): RangePlan` plans `[series.offset, series.offset + series.bytes)` in `{series.file.fileId}.bin`.
  - `planRuns(series: SeriesEntry, maxBytes = 8 * 1024 * 1024): RangePlan[]`.
- **Decryption (`web/core/decrypt.ts`):**
  - `seriesKey(series: SeriesEntry)` imports `series.file.key` cached by `series.file.fileId`.
  - `decryptParams(series: SeriesEntry, plan: RangePlan)` passes `seriesPlaintextLength: series.file.plaintextLength` to `viewer-kit`'s `decryptRecords`.
- **WSI (`web/core/wsi-source.ts`):**
  - `SeriesReader.run` clamps `(job.last + 1) * RECORD_PLAINTEXT` to `s.file.plaintextLength` and reports records against `s.file.fileId`.
  - `SlideSource.plaintextBytes` returns `this.series.bytes` (the slide series' own byte size) and `SlideSource.ciphertextBytes` returns `this.series.file.ciphertextLength`, while `inst.offset` indexes directly into `{series.file.fileId}.bin`.

#### Rust (`crates/shl-dicom-core/src/bundle.rs` and `packer.rs`)
- Update `PROFILE_URL`, `EXT_LINKED_FILE`, and `EXT_INSTANCE_LENGTH`.
- Define `FileSummary { file_id, key, plaintext_length, ciphertext_length, record_count }`.
- `StudySummary` holds `files: Vec<FileSummary>` (distinct files in first-use order) and `series: Vec<SeriesSummary>`.
- `SeriesSummary` holds `file: FileSummary`, `offset`, `bytes`, `first_record`, `last_record`, and `instances: Vec<InstanceSummary>`.
- `build_fhir_bundle`: writes `EXT_LINKED_FILE` once on each `ImagingStudy` (and on `series` only if a `SeriesBuildInput` specifies an override `file_id`/`key_b64` different from the study's).
- `parse_imaging_study`: resolves `(file_id, key)` from `series` or parent `ImagingStudy`, accumulates `offset` per `file_id` across the study's series, builds one `FileSummary` per `file_id`, and attaches `file: FileSummary` plus `offset`, `bytes`, `first_record`, `last_record` to each `SeriesSummary`.
- `IngestSession::pack`:
  - Sorts series by `(series_number, series_uid)` and deduplicates/sorts instances within each series by `(instance_number, sop_instance_uid)`.
  - Draws one 16-byte `file_id` and one 32-byte `key` per study, concatenates all instances of the study, encrypts once, and emits one `PackedStudyFile` per study.

---

## Part 2: Storage Abstraction (`BlobStore` Trait + `LocalFsStore` + `S3Store`)

### 2.1 Protocol and Routing Invariant

- **No protocol change:** Bundles and manifests never contain S3 URLs or presigned URLs. Every read request from a viewer still goes to `/shl/{lid}/{fileId}.bin` (U mode) or `/cap/{token}/{fileId}.bin` (manifest mode) on `shl-dicom-server`.
- **SQLite stays on local disk:** `catalog.db` and `shares/{sid}.db` stay on the server's local filesystem (`journal_mode=WAL`) for atomic passcode attempt decrements, link/file foreign-key checks, and access logging. Only the `.bin` ciphertext blobs move behind `BlobStore`.

---

### 2.2 Read Modes for S3: `proxy` (Default) vs. `redirect`

When blobs are stored in S3, the server supports two configurable read delivery modes via `--s3-read-mode proxy|redirect` (`SHL_S3_READ_MODE`, default `proxy`). `LocalFsStore` always proxies from disk.

In **both** modes, `GET /shl/{lid}/{fileId}.bin` and `GET /cap/{token}/{fileId}.bin` first run the exact same SQLite checks on the server:
1. Validate `lid` / `token` and `fileId` format (`^[A-Za-z0-9_-]{22}$`).
2. Lookup `sid` in `catalog.db` (checking share expiry and capability expiry).
3. In `shares/{sid}.db`, verify the link is `online`, not expired, has no unverified passcode, and lists `fileId` in `link_files`.
4. Read `size` and `storage_key` from `files` and parse/validate the single HTTP `Range: bytes=a-b` header (`416 Range Not Satisfiable` if out of bounds or multi-range).

Then:

#### Mode 1: `proxy` (default)
- The server sends an S3 `GetObject` request with `Range: bytes=a-b` and streams the response body into Axum's `Body::from_stream`, returning `206 Partial Content` (or `200 OK`) directly to the client.
- `access_log.bytes` records the range length served.
- Requires no CORS configuration on the S3 bucket; the browser only ever connects to `shl-dicom-server`.

#### Mode 2: `redirect`
- After step 4, the server records the access in `access_log` with `bytes = b - a + 1` (documented in the technical log UI and `docs/storage.md` as *requested* bytes rather than socket-measured bytes) and returns `307 Temporary Redirect`:
  - `Location: <presigned S3 GetObject URL>` (valid for 60 seconds).
  - `Cache-Control: no-store`.
  - `Access-Control-Allow-Origin: *`.
- **Local presigning and caching:** Presigning is pure local HMAC-SHA256 math (no S3 network call on the request path). Because the browser forwards its `Range: bytes=a-b` header to the redirected `Location` and the `Range` header is not part of the presigned URL signature, the server caches the presigned URL per `storage_key` for 30 seconds (with a 60-second signature expiry).
- **Revocation:** Revoking a link, taking it offline, or deleting a share takes effect immediately on the server; only a presigned URL already issued within the last 60 seconds remains usable until its TTL expires.
- **Bucket CORS requirements for `redirect` mode:**
  - When a browser on `https://viewer.example` requests `https://server.example/shl/.../{fileId}.bin` with `Range` and follows a cross-origin `307` redirect to `https://<bucket>.s3.<region>.amazonaws.com`, the W3C Fetch specification sets the redirected request's `Origin` header to `null`.
  - The S3 bucket CORS policy must therefore be:
    - `AllowedOrigins`: `["*"]` (required to match `Origin: null` as well as same-origin viewers)
    - `AllowedMethods`: `["GET", "HEAD"]`
    - `AllowedHeaders`: `["Range"]`
    - `ExposeHeaders`: `["Content-Range", "Content-Length", "Accept-Ranges", "ETag"]`
    - No `AllowCredentials` (requests use `credentials: "omit"`).
- **Browser compatibility verification:** We will build an automated Playwright test running Chromium, Firefox, and WebKit (Safari engine) that performs ranged `fetch()` requests across a `307` redirect to MinIO, testing both when the viewer page is on the server's origin and when it is served from a separate origin (`Origin: null` on the MinIO hop).

---

### 2.3 S3 Crate Selection: `object_store` vs. `rusty-s3`

| Crate | Pros | Cons |
|---|---|---|
| **`object_store`** (Apache Arrow) | Built-in S3, GCS, Azure, and local FS backends; exposes `MultipartStore` (`create_multipart`, `put_part`, `complete_multipart`, `abort_multipart`) and `Signer`. | Heavy dependency tree; abstracts away S3-specific operations and custom presigned query parameters. |
| **`rusty-s3`** + **`reqwest`** | Minimal, pure-data S3 URL and SigV4 builder (~0 dependencies beyond HMAC/SHA2/time); pairs directly with `reqwest` streaming bodies; supports `GetObject`, `PutObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `DeleteObjects`, and microsecond local presigned URL generation. | S3-protocol only (native Azure would be a separate implementation of our `BlobStore` trait later). |

**Decision:** Use **`rusty-s3` + `reqwest` (with `stream` feature)** behind our own `BlobStore` trait, and test `S3Store` against a local `minio` process in automated tests.

---

### 2.4 Resumable Uploads (`draft-ietf-httpbis-resumable-upload-13`), S3 Limits, and Sequential Streaming

Building on the resumable upload implementation from commit `1dc953e` (`PUT` with `Upload-Complete` and `Upload-Length`, `HEAD` returning `Upload-Offset`, `PATCH` with `application/partial-upload`, 30-second `BODY_IDLE` timeout keeping partial bytes):

1. **Sequential upload per encrypted file:**
   - Each `.bin` file is one upload resource (`/api/shares/{sid}/files/{fileId}.bin`). Under `draft-ietf-httpbis-resumable-upload-13`, `PATCH` appends are sequential (`Upload-Offset` must match the server's current offset, and `claim()` permits one active request per file).
   - We accept sequential part uploads per file: the browser (`web/share/lib/upload.ts`) already pipelines WebCrypto encryption of the next 8 MiB chunk (`CHUNK_RECORDS = 128`) while the current 8 MiB `PATCH` is in flight over the network. Flushed parts are in S3 and the in-progress part is on local disk (`shares/{sid}/{fileId}.part`) until it reaches `part_target` and is flushed; if the server's local disk is lost mid-upload, at most that in-progress part is lost and the client re-sends from `HEAD`'s `Upload-Offset`.

2. **S3 5 MiB minimum part size & 10,000-part maximum:**
   - S3 requires every part except the last to be at least `5 MiB` (`5,242,880` bytes), and allows at most `10,000` parts per multipart upload.
   - For a declared `Upload-Length` of `total` bytes, `S3Store` computes the part flush threshold:
     ```
     part_target = max(8 MiB, ceil(total / 9500) rounded up to 64 KiB)
     ```
     (8 MiB matches the browser's default `CHUNK_RECORDS = 128` for files up to 76 GB, and scales up automatically for larger files so part count never approaches 10,000.)
   - **Local staging of the active part only:**
     - If `total <= 8 MiB` and the client sends a single `PUT` (`Upload-Complete: ?1`), `S3Store` buffers the body and sends a single S3 `PutObject` (no multipart upload needed).
     - Otherwise, `start_upload` calls S3 `CreateMultipartUpload`, records `s3_upload_id` in `uploads`, and opens a local staging file `shares/{sid}/{fileId}.part`.
     - As `append_body` receives bytes from `PUT` or `PATCH`, it writes to `{fileId}.part`. The total logical offset is `flushed_bytes + part_file_len`.
     - If a request is interrupted (`BODY_IDLE` timeout or dropped connection), the bytes in `{fileId}.part` are kept on local disk; `HEAD` reports `Upload-Offset = flushed_bytes + part_file_len`, so byte-exact resumption works even mid-chunk or when a proxy forces smaller `PATCH` bodies (`MIN_CHUNK_RECORDS = 4`).
     - Whenever `part_file_len >= part_target` (or when `flushed_bytes + part_file_len == total` on the final byte), `S3Store` uploads `{fileId}.part` via S3 `UploadPart`, records `(file_id, part_num, etag, size)` in `upload_parts`, increments `uploads.flushed_bytes`, and truncates `{fileId}.part` back to `0` bytes.
     - Local disk usage per in-progress upload is therefore bounded to `part_target` (~8 MiB).
     - When `flushed_bytes == total` with `Upload-Complete: ?1`, `S3Store` calls S3 `CompleteMultipartUpload` with the ordered `(part_num, etag)` list from `upload_parts`, removes `{fileId}.part`, inserts the `files` row, and deletes the `uploads` row (cascading to `upload_parts`).

3. **5 GB `CopyObject` limit and share cloning (`POST /api/shares/{sid}/clone`):**
   - S3 `CopyObject` fails on objects larger than 5 GB.
   - Instead of copying multi-gigabyte objects in S3 on clone, `files` stores `storage_key TEXT NOT NULL` (defaulting to `{sid}/{file_id}.bin` when uploaded, and copied verbatim into the cloned share's `files` table), and `catalog.db` tracks blob ownership in a `blobs(storage_key TEXT PRIMARY KEY, ref_count INTEGER NOT NULL)` table:
     - Publishing a file inserts `storage_key` with `ref_count = 1`.
     - Cloning a share increments `ref_count` for each cloned `storage_key` in `catalog.db` (no S3 copy request, works for any file size, and avoids doubling S3 storage).
     - Deleting a file or expiring/deleting a share decrements `ref_count`, and only deletes the underlying S3 object (or local file) when `ref_count` reaches `0`.

4. **Abandoned multipart cleanup:**
   - **On `DELETE /api/shares/{sid}/files/{name}`:** If `uploads` has a row with `s3_upload_id`, call S3 `AbortMultipartUpload` and remove `{fileId}.part`.
   - **On share delete / expiry (`run_sweep` and `DELETE /api/shares/{sid}`):** Before removing `shares/{sid}.db`, query all rows in `uploads` with `s3_upload_id IS NOT NULL` and call `AbortMultipartUpload`, then decrement `blobs.ref_count` for all rows in `files` and delete any S3 objects whose `ref_count` hits `0`.
   - **Stale upload sweep:** `run_sweep` also aborts and removes any `uploads` row older than `MAX_UPLOAD_AGE_SECS` (24 hours).
   - **Bucket lifecycle backstop:** Document in `docs/storage.md` that operators should configure an S3 bucket lifecycle rule (`AbortIncompleteMultipartUpload` after 1 day) to clean up multipart uploads if a server is destroyed without its local disk.

5. **Deploy-time CLI sample packing:**
   - The server's sample share will be packed by a deploy-time CLI command (being added by the Share agent) that writes through `BlobStore`, so sample `.bin` files are uploaded to S3 when S3 is configured.

---

### 2.5 Reconciled SQLite Schemas (`docs/storage.md`)

#### `catalog.db`
```sql
PRAGMA foreign_keys = ON;

CREATE TABLE shares (
  sid         TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  read_only   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE links (
  lid  TEXT PRIMARY KEY,
  sid  TEXT NOT NULL REFERENCES shares(sid) ON DELETE CASCADE
);

CREATE TABLE caps (
  token       TEXT PRIMARY KEY,
  lid         TEXT NOT NULL REFERENCES links(lid) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX caps_expiry ON caps(expires_at);

-- Reference count for underlying blob objects (supports instant zero-copy clone of >5 GB studies).
CREATE TABLE blobs (
  storage_key  TEXT PRIMARY KEY,           -- "{origin_sid}/{file_id}.bin"
  ref_count    INTEGER NOT NULL
);
```

#### `shares/{sid}.db`
```sql
PRAGMA foreign_keys = ON;

CREATE TABLE share (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  control_token_hash  BLOB NOT NULL,
  owner_bundle        BLOB,
  owner_updated_at    INTEGER
);

-- Complete encrypted files (study-level by default, or series-level overrides).
CREATE TABLE files (
  file_id      TEXT PRIMARY KEY,           -- 22-char base64url
  storage_key  TEXT NOT NULL,              -- "{sid}/{file_id}.bin" (or source share's key when cloned)
  size         INTEGER NOT NULL,           -- ciphertext length C
  uploaded_at  INTEGER NOT NULL
);

-- Uploads in progress (draft-ietf-httpbis-resumable-upload-13).
-- Logical Upload-Offset = flushed_bytes + len(shares/{sid}/{file_id}.part).
CREATE TABLE uploads (
  file_id        TEXT PRIMARY KEY,
  size           INTEGER NOT NULL,         -- Upload-Length
  s3_upload_id   TEXT,                     -- NULL for LocalFsStore; S3 uploadId for S3Store
  flushed_bytes  INTEGER NOT NULL DEFAULT 0,
  started_at     INTEGER NOT NULL
);

CREATE TABLE upload_parts (
  file_id   TEXT NOT NULL REFERENCES uploads(file_id) ON DELETE CASCADE,
  part_num  INTEGER NOT NULL,              -- 1-based S3 partNumber
  etag      TEXT NOT NULL,
  size      INTEGER NOT NULL,
  PRIMARY KEY (file_id, part_num)
) WITHOUT ROWID;

CREATE TABLE links (
  lid                 TEXT PRIMARY KEY,
  label               TEXT,
  long_lived          INTEGER NOT NULL,
  online              INTEGER NOT NULL DEFAULT 1,
  exp                 INTEGER,
  passcode_salt       BLOB,
  passcode_hash       BLOB,
  remaining_attempts  INTEGER,
  bundle              BLOB,
  bundle_etag         TEXT,
  bundle_updated_at   INTEGER,
  created_at          INTEGER NOT NULL
);

CREATE TABLE link_files (
  lid      TEXT NOT NULL REFERENCES links(lid) ON DELETE CASCADE,
  file_id  TEXT NOT NULL REFERENCES files(file_id),   -- no cascade: blocks deletion (409)
  PRIMARY KEY (lid, file_id)
) WITHOUT ROWID;

CREATE TABLE access_log (
  ts         INTEGER NOT NULL,
  lid        TEXT,
  method     TEXT NOT NULL,
  path       TEXT NOT NULL,
  range      TEXT,
  status     INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,
  recipient  TEXT
);
CREATE INDEX access_ts ON access_log(ts);
```

---

### 2.6 `BlobStore` Trait and Server Settings

```rust
pub enum ReadDelivery {
    Stream(Pin<Box<dyn futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>> + Send>>),
    Redirect(String), // Presigned URL (used when --s3-read-mode=redirect)
}

#[async_trait]
pub trait BlobStore: Send + Sync {
    /// Returns either a byte stream or a 60s presigned redirect URL for inclusive range [start, end_inclusive].
    async fn read_range(
        &self,
        storage_key: &str,
        start: u64,
        end_inclusive: u64,
    ) -> Result<ReadDelivery, String>;

    /// Initializes an upload (calls CreateMultipartUpload on S3 when total > part_target).
    async fn begin_upload(&self, sid: &str, file_id: &str, total: u64) -> Result<Option<String>, String>;

    /// Flushes the staged local `.part` file as the next S3 part (no-op for LocalFsStore).
    async fn flush_part(
        &self,
        sid: &str,
        file_id: &str,
        s3_upload_id: &str,
        part_num: u32,
        part_path: &Path,
    ) -> Result<(String, u64), String>;

    /// Publishes a completed upload: renames `.part` to `.bin` on LocalFs, or runs PutObject / CompleteMultipartUpload on S3.
    async fn complete_upload(
        &self,
        sid: &str,
        file_id: &str,
        total: u64,
        s3_upload_id: Option<&str>,
        parts: &[(u32, String)],
        part_path: &Path,
    ) -> Result<String, String>;

    /// Aborts an incomplete multipart upload and removes local `.part`.
    async fn abort_upload(&self, sid: &str, file_id: &str, s3_upload_id: Option<&str>, part_path: &Path);

    /// Deletes unreferenced storage keys from S3 or local disk.
    async fn delete_blobs(&self, storage_keys: &[String]);
}
```

#### CLI and Environment Flags (`shl-dicom-server serve`)

| Flag | Environment | Default | Meaning |
|---|---|---|---|
| `--s3-endpoint` | `SHL_S3_ENDPOINT` | None | S3 endpoint URL (when unset with `--s3-bucket`, uses AWS regional endpoint) |
| `--s3-bucket` | `SHL_S3_BUCKET` | None | S3 bucket name; enables `S3Store` when set, otherwise `LocalFsStore` |
| `--s3-region` | `SHL_S3_REGION` | `us-east-1` | S3 region for SigV4 signing |
| `--s3-access-key-id` | `AWS_ACCESS_KEY_ID` | None | S3 access key ID |
| `--s3-secret-access-key` | `AWS_SECRET_ACCESS_KEY` | None | S3 secret access key |
| `--s3-prefix` | `SHL_S3_PREFIX` | `""` | Optional object key prefix inside the bucket |
| `--s3-read-mode` | `SHL_S3_READ_MODE` | `proxy` | `proxy` (stream `206` through server) or `redirect` (`307` to 60s presigned URL) |
| `--s3-path-style` | `SHL_S3_PATH_STYLE` | `false` | Use path-style S3 URLs (for MinIO or local test endpoints) |

---

## Part 3: Sequencing and File-by-File Checklist

### Sequencing
1. **Prerequisite:** Wait for the Share agent to finish remembering picked files and deploy-time CLI sample packing.
2. **Phase 1 (Part 1 — Study-level files + HL7 UV URLs on local disk):** Update spec, reference vector, `shl-dicom-core`, `shl-dicom-server`, `web/core`, `web/share`, `web/view`, `web/how`, re-pack the sample, and pass all Rust, unit, and Playwright checks.
3. **Phase 2 (Part 2 — `BlobStore` + `S3Store`):** Add `BlobStore`, `LocalFsStore`, `S3Store` (`rusty-s3` + `reqwest`), `blobs` refcounting, `upload_parts`, `proxy` and `redirect` modes, MinIO integration tests, and cross-browser redirected-Range Playwright checks.

### Checklist — Phase 1 (Study-Level Files + HL7 UV URLs)
- [ ] **`PROPOSAL.md`**
  - §1, §6, §7: Update prose and overview diagram from one file per series to one file per study (`ImagingStudy`) by default.
  - §8.1–8.2 & Appendix A: Update profile URL to `http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/dicom-imaging-study` and extension URLs to `.../linked-file` (on `ImagingStudy`, with optional override on `ImagingStudy.series`) and `.../instance-length` (on `ImagingStudy.series.instance`). Define per-`fileId` cumulative instance offsets.
  - §9–11: Update file terminology and packer rules (default one file per study; optional series-level `linked-file` when appending a series to an existing study).
  - §10.3, §13, §14, §15: Add trade-off notes (range requests still reveal accessed instance/series boundaries during viewing; why study-default + optional series override beats per-series files) and close Open Question 1.
- [ ] **`reference/` and `fixtures/golden/`**
  - Update `reference/series-file.ts` and `reference/test-vector.ts` and regenerate `fixtures/golden/` with the new HL7 UV URLs and `linked-file` on `ImagingStudy`.
- [ ] **`crates/shl-dicom-core/`**
  - `src/bundle.rs`: Update `PROFILE_URL`, `EXT_LINKED_FILE`, and `EXT_INSTANCE_LENGTH`; place `linked-file` on `ImagingStudy` in `build_fhir_bundle` (with optional series override); in `parse_imaging_study`, resolve `(file_id, key)` from `series` or parent `ImagingStudy` and accumulate `offset` per `file_id`; update `subset_fhir_bundle` to keep `ImagingStudy` entries matching `selected_file_ids`.
  - `src/packer.rs`: Pack one `{fileId}.bin` per study (`PackedStudyFile`).
  - `tests/stage1_core.rs`: Test both default study-level `linked-file` across multiple series and a series-level `linked-file` override.
- [ ] **`web/core/`**
  - `bundle.ts`, `range.ts`, `decrypt.ts`, `loader.ts`, `images.ts`, `wsi-source.ts`, `export.ts`, `README.md`: Update to the data model in §1.3 (`EXT_LINKED_FILE`, `EXT_INSTANCE_LENGTH`, `FileEntry`, `StudyEntry.files`, `SeriesEntry.file`, per-`fileId` offset accumulation, `series.bytes` vs `series.file.plaintextLength`).
- [ ] **`web/share/`**
  - `lib/pack.ts`, `lib/upload.ts`, `lib/sources.ts`, `share.ts`, `manage.ts`: Pack one `.bin` file per `StudyModel` (`planStudyFiles`, concatenating `study.series.flatMap(s => s.instances)`); write `EXT_LINKED_FILE` on `ImagingStudy`; update upload progress log and `planFromOwner`.
- [ ] **`web/view/`**
  - `view.ts`, `wsi-tools/static-pack.ts`, `WSI.md`: Use `se.bytes` for series byte-size labels and update `static-pack.ts` to the new extension URLs.
- [ ] **`web/how/`**
  - `index.html`, `s-bundle.ts`, `s-series.ts`, `s-verify.ts`, `s-host.ts`, `s-sandbox.ts`, `s-codecs.ts`, `receiver.js`, `bake.ts`, `checks.mjs`: Update interactive widgets, `receiver.js`, and explanatory text for `linked-file` and `instance-length`.
- [ ] **`PLAN.md`, `docs/storage.md`, `docs/blog/DRAFT.md`, `docs/blog/OUTLINE.md`, `viewer-kit/INTEGRATION.md`, `perf-spikes/decrypt/`**
  - Update extension URLs, terminology, and examples.

### Checklist — Phase 2 (`BlobStore` and `S3Store`)
- [ ] **`crates/shl-dicom-server/`**
  - Add `rusty-s3` and `reqwest` (`stream`) to `crates/shl-dicom-server/Cargo.toml`.
  - Create `src/storage.rs` (`BlobStore` trait, `LocalFsStore`, `S3Store` with local presigning cache, 5 MiB+ part staging, `blobs` refcounting).
  - Update `src/state.rs`, `src/routes_api.rs`, `src/routes_shl.rs`, `src/cli.rs`, `src/main.rs` to use `BlobStore`, `files`, `uploads(s3_upload_id, flushed_bytes)`, `upload_parts`, and `--s3-read-mode proxy|redirect`.
  - Ensure the deploy-time CLI sample packer writes through `BlobStore`.
- [ ] **Tests (`crates/shl-dicom-server/tests/stage2_server.rs` & Playwright)**
  - Run `stage2_server` tests against both `LocalFsStore` and `S3Store` backed by a local `minio` instance (covering `PUT`, multi-part `PATCH`, interrupted `PATCH` resume, `proxy` range reads, `redirect` `307` range reads, `>5 GB` refcounted share clone, and `AbortMultipartUpload` on delete/sweep).
  - Run a cross-browser Playwright test (Chromium, Firefox, WebKit) verifying ranged `fetch` across a `307` redirect to MinIO from both same-origin and cross-origin (`Origin: null`) viewer pages.
  - Update `docs/storage.md` and `PLAN.md` §5.2–5.3 with the final schema and S3 flags.
