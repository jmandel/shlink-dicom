# Sharing full DICOM studies through SMART Health Links

Status: draft proposal, October 2026. Reference code and a test vector are in `reference/`.

## 1. Summary

A patient or a provider should be able to share a complete imaging study, with every original DICOM file, by handing over one SMART Health Link. The files may be hosted on a server that cannot read them, including a static file host, and the receiver should be able to show the first images before the whole study has downloaded.

This proposal adds no new link type. The link resolves, as any SMART Health Link does, to an encrypted FHIR Bundle. The Bundle holds an `ImagingStudy` that lists every series and instance and gives each series a random file id and a random 32-byte key. Each series is one file alongside the Bundle (`{fileId}.bin`): the original DICOM files laid end to end, encrypted in fixed-size records under that series' key. A client that does not know this convention still gets a valid FHIR description of the study. A client that does can fetch any series, or any byte range within one, and decrypt and verify it.

## 2. Background: SMART Health Links in brief

A SMART Health Link (SHL) is a way to share health data by handing over a link or QR code. It is specified in the HL7 *SMART Health Cards and Links* implementation guide ([Health Links specification](https://build.fhir.org/ig/HL7/smart-health-cards-and-links/links-specification.html)). The parts this proposal depends on:

- **The link.** An SHL is the string `shlink:/` followed by base64url-encoded JSON, optionally prefixed by a viewer URL ending in `#`. The JSON (the *SHL payload*) holds:
  - `url`, where the data is fetched;
  - `key`, a 32-byte random key, base64url-encoded;
  - optional `exp` (expiry hint), `flag`, `label` and `v`.

  Because the key travels inside the link, whoever has the link can decrypt the data. The server that hosts the data never needs the key.
- **Flags.**
  - `L`: the link is long-lived and its content may change.
  - `P`: a passcode is required.
  - `U`: `url` points directly at a single encrypted file. `U` may not be combined with `P`.
- **Retrieval.** Without `U`, the client POSTs `{recipient, passcode?}` to `url` and receives a *manifest*: a list of files, each with a `contentType` and either an `embedded` ciphertext or a `location` URL. A `location` must be valid for at most one hour. With `U`, the client sends `GET url?recipient=…` and receives the one file.
- **Files.** Each file is a JSON Web Encryption (JWE) in compact serialization, with `alg: dir`, `enc: A256GCM`, encrypted directly under the link's key and optionally DEFLATE-compressed. Only three content types are defined:
  - `application/smart-health-card`;
  - `application/fhir+json` (any FHIR resource, usually a Bundle);
  - `application/smart-api-access` (an OAuth token for a FHIR server).
- **Plain SHLs.** The specification defines a *Plain SHL* as one that a client implementing only the core specification can parse, retrieve and decrypt. Only Plain SHLs may use the `shlink:` scheme and the SMART Health Link name. Clients must ignore properties, flags and FHIR extensions they do not understand.

## 3. The problem

Imaging is one of the most requested kinds of record, and one of the hardest to move:

- **Size.** A study runs from a few MB (a radiograph) to several GB (a thin-slice CT, a breast tomosynthesis study, a whole-slide pathology image).
- **How studies move today.** They usually travel on CDs, through vendor image-exchange networks, or as DICOMweb access between organizations that have set up trust in advance.

SHLs already let a patient share FHIR data with anyone, without prior arrangement, but their file format is a poor fit for imaging:

- **No streaming.** A compact JWE can't be checked or used until it has been read to the end, because the GCM tag comes last.
- **Size overhead.** It is base64url-encoded, which adds a third to the size.
- **No partial access.** There is no way to read part of a file.
- **Short-lived locations.** A one-hour `location` is awkward for a multi-GB download.
- **No content type for DICOM,** and adding one would make the link not Plain.

## 4. Goals

1. **Full fidelity.** The receiver gets every DICOM file of the study, byte-identical to what the source exported.
2. **Works with any DICOM source.** No assumptions about modality, transfer syntax, vendor or file sizes.
3. **Host cannot read the data.** A host that stores the files learns nothing about the images or the patient beyond file sizes and access patterns.
4. **Static hosting works.** A U-mode link and its files can be served from a static file host that supports HTTP Range requests (for example S3, R2, or GitHub Pages).
5. **Partial and progressive access.** A client can fetch one series, one instance or one frame without downloading the rest, and can stream a series and show images as they arrive.
6. **Integrity.** The client detects any change, truncation, reordering or substitution of the files.
7. **Still a Plain SHL.** A client that knows only the core SHL specification can still resolve the link and read a valid FHIR description of the study.
8. **Small to implement.** A browser client needs only WebCrypto (`AES-GCM`) and `fetch`. No new cryptographic primitive and no new container format.

## 5. Non-goals

- De-identification, burning in annotations, or any other change to image content.
- Replacing DICOMweb or existing image-exchange networks between organizations that already trust each other.
- Querying across studies. The link shares the studies its Bundle lists.
- A viewer. Section 11 sketches how an existing DICOMweb viewer can be used.
- Authenticating the receiver beyond what SHLs already offer (possession of the link, optional passcode, the `recipient` string).
- Verifying who produced the study or the Bundle. Any DICOM Digital Signatures inside the files pass through untouched; signing the Bundle itself is left to future SHL signing profiles.

## 6. Design principles

- **Reuse the units DICOM and FHIR already have.** DICOM organizes every instance into exactly one series. FHIR `ImagingStudy` already lists series and instances by UID. The series is the unit of storage and retrieval, and `ImagingStudy` is the index. No new container, segment or chunk concept is visible to the client.
- **One way to do each thing.** There are no modes or options in the file format: no optional compression, no optional framing. A client has one code path.
- **Do not touch the DICOM files.** Any compression a source applied lives inside the DICOM files and is described by their own Transfer Syntax UID. The format neither adds compression nor removes it.
- **The authenticated Bundle carries everything the client must trust.** Lengths, file identifiers and series keys come from the encrypted Bundle, never from the series files. A series file is only ciphertext.
- **Stay inside the core SHL specification.** The link, the manifest, the Bundle encryption and the flags are used exactly as specified. Everything new lives in a profile and two FHIR extensions on `ImagingStudy`, which clients that do not understand them ignore.

## 7. Overview

```
Sharer                                  Host (cannot decrypt)                  Receiver
------                                  ---------------------                  --------
read DICOM files, group by series
for each series:
  random 16-byte file id, 32-byte key
  concatenate instances
  encrypt in 64 KiB records  ───────►  {fileId}.bin  (one file/series)
build Bundle: Patient, ImagingStudy,
  DiagnosticReport?
encrypt Bundle as JWE (SHL key) ─────►  SHL file (U) or manifest entry
make SHL (url, key, flags, label)  ─────── link / QR ──────────────────────►  resolve SHL, decrypt Bundle
                                                                              read ImagingStudy
                                        GET/Range {fileId}.bin  ◄───────────  fetch series or byte range
                                                                              decrypt records with series key,
                                                                              verify, hand DICOM to viewer
```

## 8. The Bundle

The SHL resolves to one `application/fhir+json` file whose plaintext is a FHIR R4 Bundle of type `collection`. In U mode it is the single file behind `url`; in manifest mode it is one of the manifest's files. The Bundle contains:

- one `Patient`;
- one or more `ImagingStudy` resources, one per shared study;
- optionally, `DiagnosticReport` resources (for example the radiology report), referring to the `ImagingStudy` through `DiagnosticReport.imagingStudy`.

### 8.1 ImagingStudy

Standard R4 `ImagingStudy`, with these rules:

- `meta.profile` includes `"https://example.org/shl-dicom/v1"` (placeholder namespace, see §15), so a client can recognize the convention and its version without scanning extensions.
- `identifier` carries the Study Instance UID as `{ system: "urn:dicom:uid", value: "urn:oid:<StudyInstanceUID>" }`.
- `subject` references the `Patient` in the Bundle.
- `numberOfSeries` and `numberOfInstances` are populated and count the series and instances **shared in this Bundle**. If the link shares only a subset of a study's series, `ImagingStudy.note` SHOULD state that the shared study is partial. The series is the smallest unit of sharing; sharing a small selection of key images means packing them as a series or including a Key Object Selection series.
- Every shared series appears in `series`, and every shared instance in `series.instance`. Each `series.instance` has `uid` (SOP Instance UID), `sopClass` (`urn:ietf:rfc:3986` / `urn:oid:<SOP Class UID>`) and, if known, `number` (Instance Number).
- **The order of `series.instance` is the order of the bytes in the series file.**

Two extensions (one complex extension on `series`, one simple extension on `series.instance`):

| Extension / Sub-extension | On | Type | Meaning |
|---|---|---|---|
| `https://example.org/shl-dicom/series-file` | `ImagingStudy.series` | complex | Groups the series file identifier and encryption key: |
| ↳ `id` | `series-file` | `valueString` | The series file id: 16 random bytes, base64url-encoded without padding (22 characters). Names the immutable file (`{id}.bin`). |
| ↳ `key` | `series-file` | `valueString` | The series encryption key: 32 random bytes, base64url-encoded without padding (43 characters). |
| `https://example.org/shl-dicom/length` | `ImagingStudy.series.instance` | `valueDecimal` (a non-negative integer) | Length in bytes of this instance's DICOM file. |

`valueDecimal` is used because R4 `integer` is 32-bit, and a single whole-slide image instance can exceed 2 GB.

The start of instance *k* within its series file is the sum of the lengths of instances 0..*k*−1. The series' plaintext length is the sum of all its instance lengths.

### 8.2 Example

A one-series CT with two instances (UIDs shortened). Appendix A has a complete Bundle.

```json
{
  "resourceType": "ImagingStudy",
  "id": "ct1",
  "meta": { "profile": ["https://example.org/shl-dicom/v1"] },
  "status": "available",
  "identifier": [{ "system": "urn:dicom:uid", "value": "urn:oid:1.2.840.113619.2.55.3.604688119" }],
  "subject": { "reference": "Patient/p1" },
  "started": "2026-09-30T14:12:00-05:00",
  "numberOfSeries": 1,
  "numberOfInstances": 2,
  "series": [{
    "extension": [{
      "url": "https://example.org/shl-dicom/series-file",
      "extension": [
        { "url": "id", "valueString": "AAECAwQFBgcICQoLDA0ODw" },
        { "url": "key", "valueString": "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8" }
      ]
    }],
    "uid": "1.2.840.113619.2.55.3.604688119.971",
    "number": 2,
    "modality": { "system": "http://dicom.nema.org/resources/ontology/DCM", "code": "CT" },
    "description": "Abdomen 5mm",
    "numberOfInstances": 2,
    "instance": [
      { "extension": [{ "url": "https://example.org/shl-dicom/length", "valueDecimal": 70000 }],
        "uid": "1.2.840.113619.2.55.3.604688119.971.1",
        "sopClass": { "system": "urn:ietf:rfc:3986", "code": "urn:oid:1.2.840.10008.5.1.4.1.1.2" },
        "number": 1 },
      { "extension": [{ "url": "https://example.org/shl-dicom/length", "valueDecimal": 80000 }],
        "uid": "1.2.840.113619.2.55.3.604688119.971.2",
        "sopClass": { "system": "urn:ietf:rfc:3986", "code": "urn:oid:1.2.840.10008.5.1.4.1.1.2" },
        "number": 2 }
    ]
  }]
}
```

For scale: a 2,000-instance series listed this way is about 470 KB of minified JSON (the `series-file` extension adds about 100 bytes per series). Under the SHL file's DEFLATE it is about 60 KB.

## 9. Series files

### 9.1 Plaintext

A series file's plaintext is the series' instances, each a complete DICOM Part 10 file (128-byte preamble, `DICM`, file meta information, data set), concatenated in `series.instance` order with nothing between them. The bytes are those the source exported.

### 9.2 Encryption

Input:
- the series key *K_s* (32 bytes, the base64url-decoded `key` sub-extension of `series-file` on `ImagingStudy.series`).

```
R = 65,520                               plaintext bytes per record
n = max(1, ceil(P / R))                  records, where P = plaintext length
chunk_i = plaintext[i·R, min(P, (i+1)·R))
nonce_i = uint96_be(i)                   record index i as a 12-byte big-endian unsigned integer
record_i = AES-256-GCM-Encrypt(K_s, nonce_i, chunk_i, no additional data)    ciphertext || 16-byte tag
file  = record_0 || record_1 || … || record_{n−1}
```

- Every record except the last is exactly 65,536 bytes; the last is its chunk length plus 16.
- The ciphertext length is `P + 16·n`.

There is no header, no padding and no end marker:
- **Key:** the series key *K_s* comes from the authenticated Bundle.
- **Length:** the expected length follows from the Bundle's instance lengths, so truncation and extension are detected by comparing lengths.
- **Order:** each record's nonce is its index *i*, so moving a record to another position makes its tag fail.

This is the STREAM construction for online authenticated encryption, with the length known in advance instead of signalled by a final-record flag.

### 9.3 Locating and authenticating byte ranges

Each full record holds 65,520 bytes of plaintext and occupies 65,536 bytes of ciphertext (65,520 encrypted bytes followed by its 16-byte GCM authentication tag):

```
Plaintext (DICOM bytes):
|←────── Record 0 (65,520 B) ──────→|←────── Record 1 (65,520 B) ──────→|←─ Record 2 ─→|
0                             65,520                              131,040              P

Ciphertext ({fileId}.bin on server):
|←─── Record 0 (65,520 + 16 tag) ───→|←─── Record 1 (65,520 + 16 tag) ───→|←─ Record 2 + 16 ─→|
0                              65,536                              131,072                   C
```

Plaintext byte *p* lives in record ⌊*p* / 65,520⌋, which starts at ciphertext offset `65,536 · ⌊p / 65,520⌋`. To read plaintext bytes [*a*, *b*):

```
first = floor(a / 65520),  last = floor((b − 1) / 65520)
fetch ciphertext bytes [65536·first, min(C, 65536·(last+1)))      C = ciphertext length
for each record i in first..last:
  verify tag and decrypt record i with (K_s, uint96_be(i))
concatenate decrypted records, then slice from (a − 65520·first), length b − a
```

Because each 65,536-byte record carries its own 16-byte GCM tag and binds its record index *i* in the nonce, the client cryptographically authenticates the fetched records immediately without downloading the rest of the file. Only a whole-file read checks the total ciphertext length *C*; a range read checks that the server returned the expected byte count for records `first..last` and verifies each record's tag. Reading one instance costs at most one extra partial record (under 64 KiB) at each end.

### 9.4 Why these choices

- **AES-256-GCM** matches the A256GCM the SHL specification already uses, so the images are not protected more weakly than the Bundle, and needs no other cryptographic primitive.
- **A random 32-byte key per series** separates the series keys from the SHL key (which is used only for the Bundle JWE) and from each other, so a simple sequential counter nonce (`uint96_be(i)`) is safe. It also lets the same encrypted series files be shared across multiple links—each with its own SHL key, passcode, expiry, or subset of series—by encrypting only a new Bundle.
- **64 KiB records** keep the overhead to 16 bytes per 64 KiB (0.02%). They also keep the over-fetch on a range read small, and fit comfortably in memory for streaming.

## 10. Fetch contract

Series files sit alongside the Bundle. The URL of a series file is `{fileId}.bin` resolved relative to `baseUrl` using standard RFC 3986 resolution (`new URL(fileId + ".bin", baseUrl)`):
- in **U mode**, `baseUrl` is the SHL's `url`;
- in **manifest mode**, the Bundle MUST be delivered via `location` (not `embedded`), and `baseUrl` is that `location` URL.

`baseUrl` MUST end in `/` or a file name within the link's own directory (for example `https://host.example/s/abc/bundle.jwe`), so that `{fileId}.bin` resolves to `https://host.example/s/abc/{fileId}.bin` and does not collide with other shares in a parent path. Because standard relative resolution drops any query string on `baseUrl`, access tokens MUST live in the URL path (not in query-string signatures such as `?sas=…` or `?X-Amz-Signature=…`, which also sign only a single object). Because the Bundle carries only the relative `fileId`, the encrypted Bundle and `.bin` files can be generated offline and placed on any host without knowing the final URL in advance.

- **Immutability and caching:** A `fileId` always names the exact same ciphertext bytes, encrypted under the same series key, and MUST NOT be reused for different content. Receivers MAY cache `{fileId}.bin` (or verified plaintext records) indefinitely by `fileId`, including across link updates and across different links.
- **Sharing files across links:** When a server hosts multiple links over the same study, each link resolves files under its own path (for example `/shl/{linkId}/{fileId}.bin`), backed by the same underlying `.bin` files on disk or object storage, so each link can be revoked independently. On a static host with no server routing, links either use separate folders (via copies or symlinks) for independent revocation, or share one folder and are revoked together.

### 10.1 Server (the host of series files)

1. `GET {fileId}.bin` (resolved against `baseUrl`) returns the series file with `Content-Type: application/octet-stream`, without any `Content-Encoding`.
2. The server MUST honour a single byte range (`Range: bytes=a-b`) with `206 Partial Content`. It MAY ignore multi-range requests.
3. Requests carry `?recipient=<string>`, the same string the client sent when resolving the SHL. The server SHOULD record it with the access, and MUST NOT require it to match anything.
4. Cross-origin access: the server SHOULD send `Access-Control-Allow-Origin` (for example `*`). A single byte range is a CORS-safelisted request header in the current Fetch standard, so no preflight is needed in conforming browsers. Servers that can, SHOULD also answer preflight requests for `Range`, for older browsers.
5. **Lifetime.**
   - **U mode, or a manifest without `P`.** The series files MUST be available exactly as long as the SHL itself resolves, and MUST return `404` once the SHL is revoked or expired. Putting `{fileId}.bin` alongside the Bundle arranges this automatically. A static host meets the requirement by deleting the folder when the link is withdrawn.
   - **Manifest with `P`.** The series files MUST NOT be reachable using only what the link contains. Each manifest response serves the Bundle via a `location` URL with a fresh, unguessable path prefix (at least 256 bits of entropy, for example `https://host.example/cap/{token}/bundle.jwe`) valid for at most one hour, under which `{fileId}.bin` also resolves. Although the SHL specification notes that `location` is intended for single use, the server MUST allow multiple `GET` and `Range` requests for `{fileId}.bin` under that prefix until the prefix expires. Because `location` is in the unencrypted manifest response, the host never needs the SHL key to mint fresh prefixes. If a download spans the one-hour expiry, the client re-resolves the SHL with the passcode to get a new `location` prefix and resumes with Range requests from the next needed record.

### 10.2 Client

1. Resolve the SHL as the core specification describes, decrypt the Bundle, and find each `ImagingStudy` declaring `https://example.org/shl-dicom/v1` (or carrying the `https://example.org/shl-dicom/series-file` extension on `series`). The rest of the Bundle is used as ordinary FHIR.
2. For each series to fetch, compute:
   - the URL `new URL(fileId + ".bin", baseUrl)`;
   - the 32-byte series key *K_s* by base64url-decoding `key` (browser clients SHOULD import *K_s* into WebCrypto with `extractable: false`);
   - the plaintext length *P* as the sum of instance lengths;
   - the expected ciphertext length *C* = *P* + 16·*n*.
3. **Whole series:** GET the file and decrypt record by record as bytes arrive, passing each completed instance on as soon as its last byte is decrypted. Check that exactly *C* bytes arrived.
4. **Part of a series** (one instance, or a frame whose offset the client knows): compute the record range (§9.3) and send one Range request. If the server answers `200` with the whole file, seek locally.
5. Reject the series if any record fails authentication or the byte counts differ from those computed. Never pass bytes from a record that failed authentication to a viewer.
6. Hand each instance to the application as a DICOM Part 10 file.

### 10.3 Updates (`L` flag)

A long-lived link may gain studies, series or instances (for example a new prior study, or an amended report).

- **New or changed series:** a series whose content changes is written to a new file with a **new random file id and a new random 32-byte series key**, and the Bundle is re-encrypted (with a fresh random 12-byte JWE IV, as JWE requires) referencing the new file id and key. Neither file ids nor series keys may be reused with different content.
- **Publish order:** upload all new `{fileId}.bin` files first, then publish the new Bundle, and delete any replaced `.bin` files last, so a receiver never sees a Bundle naming a file that is not yet present.
- **Detecting changes cheaply:** the sharer SHOULD populate `Bundle.meta.lastUpdated`. In manifest mode, the manifest entry's `lastUpdated` already signals changes; in U mode, servers SHOULD send an `ETag` on the Bundle and answer `If-None-Match` with `304 Not Modified`. Clients SHOULD honour `Retry-After` when polling, as the SHL specification recommends, and fetch only series whose `fileId` they have not yet cached.

## 11. Building and using series files

### 11.1 Sharer

1. Read the DICOM source: a CD or DICOMDIR file set, a folder, a ZIP, or a DICOMweb retrieve. Ignore the DICOMDIR itself; it is an index, not an instance.
2. Parse each file's header. Group instances by (Study Instance UID, Series Instance UID); grouping by the pair keeps a series UID wrongly reused across studies from merging them.
3. Handle broken data explicitly:
   - **Missing UID.** A file without a Series Instance UID, which DICOM requires but some exporters omit, is either rejected or placed in a series of its own with a newly generated UID. That choice is recorded in the Bundle, for example in `series.description`.
   - **Bare data set.** A file that is a bare data set without Part 10 wrapping is given the Part 10 preamble and file meta header. This is the only change a sharer makes to file bytes.
4. Order each series by Instance Number, then by SOP Instance UID for ties or missing numbers.
5. For each series:
   - draw a random 16-byte file id and a random 32-byte series key;
   - concatenate the files;
   - encrypt (§9.2) and upload, using a resumable or multipart upload for large files.
6. Build the Bundle (§8), encrypt it as the SHL file or manifest entry, and create the link.

A sharer may offer, as a separate step before packing, to transcode uncompressed images to a lossless compressed transfer syntax (for example HTJ2K lossless or JPEG-LS) to reduce size. The result is still DICOM and declares its own transfer syntax, so the format is unchanged. The files are then no longer byte-identical to the source's, and the sharer should say so.

### 11.2 Receiver and viewing (informative)

Existing web viewers such as OHIF read DICOMweb. A receiver page can install a Service Worker that answers DICOMweb requests from decrypted series files:

| DICOMweb request | Answered from |
|---|---|
| `…/studies/{s}/series/{se}/metadata` | DICOM JSON, built from each instance's header (the client fetches and parses only the headers, using ranges) |
| `…/series/{se}` | The whole series file, streamed, re-wrapped as `multipart/related` |
| `…/instances/{i}` | One byte range |
| `…/instances/{i}/frames/{f}` | One byte range |

For frames, the client first reads the instance header to find frame offsets: the Basic or Extended Offset Table for encapsulated pixel data, or the fixed frame size for native pixel data. It then requests only the frames being displayed.

To save a study to disk, the receiver writes each instance as its own file, or builds an uncompressed ZIP on the fly.

## 12. Relationship to Plain SHLs

A client implementing only the core SHL specification can parse the link, retrieve the Bundle (in U or manifest mode) and decrypt it. The Bundle is valid FHIR R4. Such a client sees the patient, the study and series structure, and any `DiagnosticReport`. It ignores the profile and the two extensions on `ImagingStudy` as the specification requires, and does not fetch the series files.

This proposal therefore treats these links as Plain SHLs. The counter-argument is that for imaging the pixels are the fundamental data, and a client that cannot get them has not fully processed the link. If the SHL community takes that view, the convention would need its own URI scheme (for example `shlink-dicom:/`) and an entry on the SHL extensions registry, with no change to anything else in this proposal.

## 13. Security and privacy

- **Confidentiality from the host.** The Bundle is encrypted under the SHL key, and each series file is encrypted under its own random 32-byte key carried inside the Bundle; the host sees neither.
  - **What the host can see:** the number of series files and their sizes, the request times and ranges, the `recipient` strings, and the file ids (which are random).
  - **What it can't see:** DICOM UIDs, which do not appear in URLs, or anything in the Bundle.

  File sizes and the pattern of range requests can hint at modality and study shape.
- **Integrity, not origin identity.** Every record is authenticated, and its position is bound through the nonce. The total length and the series key come from the authenticated Bundle. A host cannot alter, truncate, extend, reorder or swap files, or serve an older version, without detection. This proves the files match what the Bundle's creator packed, but does not verify who created the Bundle.
- **Treat the decrypted Bundle as secret.** Anyone with the link can decrypt the Bundle, and the decrypted Bundle holds the keys for the series it lists (and no others). Forwarding or storing the decrypted Bundle therefore forwards the ability to decrypt those series files wherever their ciphertext is reachable. A receiver that imports the `ImagingStudy` into an EHR or FHIR server SHOULD strip the `series-file` extension (or its `key` sub-extension) first, or keep the keys only in its image cache. U mode cannot be combined with a passcode; sharers should use `exp`, revocation and passcodes (manifest mode) as the sensitivity of the study warrants.
- **Correlation across recipients.** When two links share the same underlying `.bin` file, both Bundles carry the same `id` and `key`, so recipients who compare decrypted Bundles can tell they received identical series data. When that matters, the sharer can re-encrypt the series with a fresh `id` and `key` for each link.
- **Nonce safety.** The SHL key is used only for the Bundle JWE, which draws a fresh random 12-byte IV each time the Bundle is encrypted. Each series file is encrypted under its own random 32-byte key *K_s* and uses a sequential counter (`uint96_be(i)`) per record. Because each *K_s* is used for at most one immutable series file, no `(K_s, nonce)` pair is ever reused. A sharer MUST draw series keys and file ids from a cryptographically secure random source and MUST NOT reuse either for different content.
- **The `recipient` string** is supplied by the client and is not authenticated. It is an access log hint, not access control.
- **DICOM content is sensitive throughout.** Headers carry names, identifiers and dates, and some images carry burned-in text. Nothing in this proposal removes them; the receiver gets the study as exported.

## 14. Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Each instance as a FHIR `Binary` inside an `application/fhir+json` file | Plain without any extension, but each instance is base64 inside JSON inside a base64url JWE. There's no partial access, and no streaming within a file. Workable for small studies only. |
| An `application/smart-api-access` token plus the source's DICOMweb server (SMART imaging access) | Good when a provider shares from its own PACS, and needs no new format. It doesn't work for studies the patient holds, or for hosts that can't read the data. It can sit beside this convention in the same Bundle. |
| One file per study | Cannot fetch one series without the rest, and adding a series means rewriting the whole file. |
| One file per instance | Thousands of files and requests per CT, more upload overhead, and it shows the host each instance's size. Kept in mind only as a fallback for hosts without Range support. |
| ZIP container inside the encrypted file | The Bundle already gives offsets, and the encryption already authenticates, so ZIP's directory and CRCs add a second offset scheme and nothing else. Receivers can build a ZIP for download themselves. |
| Optional compression of series files (deflate when it helps) | Gives the client two code paths, and a compressed file can't be range-read. Compression that matters for DICOM belongs inside the DICOM files, where the transfer syntax already describes it. |
| RFC 8188 (`aes128gcm` content coding) as-is | Uses AES-128, has a header and a final-record delimiter, and is built for when the length isn't known in advance. Here the length and key come from the authenticated Bundle, so the simpler construction in §9 suffices. |
| File URL derived from the Series Instance UID | Simple, but it exposes UIDs to the host (UIDs often embed an organization's OID root), and a changed series would keep the same URL. A random file id avoids both. |

## 15. Open questions

1. **Profile and extension URLs.** The `ImagingStudy` profile URL (`v1`) and the two extension URLs (`series-file` and `length`) need a permanent namespace, for example under the SHL implementation guide or an extensions registry entry. `https://example.org/shl-dicom` is a placeholder.
2. **Plain or not.** Whether the SHL community accepts §12's reading.
3. **FHIR version.** The proposal targets R4, as the SHL guide does. In R5, `length` could use `integer64`.
4. **Frame offsets.** Whether to add an optional per-instance list of frame offsets to the Bundle, so viewers can fetch a frame without first reading the instance header. The cost is a larger Bundle for multi-frame studies.
5. **Several studies in one link.** Allowed as written, with one `ImagingStudy` each. Any limits are untested.
6. **Hosts without Range support.** Whether to define the one-file-per-instance fallback formally, or simply require Range support.
7. **CORS.** Behaviour of Range requests from browsers that still preflight them, against hosts that reject `OPTIONS`. GitHub Pages answers `OPTIONS` with 405.

## Appendix A. Complete example Bundle

```json
{
  "resourceType": "Bundle",
  "meta": { "lastUpdated": "2026-09-30T15:00:00Z" },
  "type": "collection",
  "entry": [
    { "fullUrl": "urn:uuid:7b1d0f7e-3c9e-4b0a-9a51-0d8a4f0c2e11",
      "resource": {
        "resourceType": "Patient",
        "id": "p1",
        "name": [{ "family": "Okafor", "given": ["Linda"] }],
        "birthDate": "1965-03-02"
      } },
    { "fullUrl": "urn:uuid:9a4e2c71-5b3d-4e8f-b0a2-6c7d8e9f0a13",
      "resource": {
        "resourceType": "ImagingStudy",
        "id": "ct1",
        "meta": { "profile": ["https://example.org/shl-dicom/v1"] },
        "status": "available",
        "identifier": [{ "system": "urn:dicom:uid", "value": "urn:oid:1.2.840.113619.2.55.3.604688119" }],
        "subject": { "reference": "Patient/p1" },
        "started": "2026-09-30T14:12:00-05:00",
        "numberOfSeries": 1,
        "numberOfInstances": 2,
        "series": [{
          "extension": [{
            "url": "https://example.org/shl-dicom/series-file",
            "extension": [
              { "url": "id", "valueString": "AAECAwQFBgcICQoLDA0ODw" },
              { "url": "key", "valueString": "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8" }
            ]
          }],
          "uid": "1.2.840.113619.2.55.3.604688119.971",
          "number": 2,
          "modality": { "system": "http://dicom.nema.org/resources/ontology/DCM", "code": "CT" },
          "description": "Abdomen 5mm",
          "numberOfInstances": 2,
          "instance": [
            { "extension": [{ "url": "https://example.org/shl-dicom/length", "valueDecimal": 70000 }],
              "uid": "1.2.840.113619.2.55.3.604688119.971.1",
              "sopClass": { "system": "urn:ietf:rfc:3986", "code": "urn:oid:1.2.840.10008.5.1.4.1.1.2" },
              "number": 1 },
            { "extension": [{ "url": "https://example.org/shl-dicom/length", "valueDecimal": 80000 }],
              "uid": "1.2.840.113619.2.55.3.604688119.971.2",
              "sopClass": { "system": "urn:ietf:rfc:3986", "code": "urn:oid:1.2.840.10008.5.1.4.1.1.2" },
              "number": 2 }
          ]
        }]
      } },
    { "fullUrl": "urn:uuid:c3d4e5f6-0718-4a29-b3c4-d5e6f7a8b9c0",
      "resource": {
        "resourceType": "DiagnosticReport",
        "id": "r1",
        "status": "final",
        "code": { "coding": [{ "system": "http://loinc.org", "code": "18748-4", "display": "Diagnostic imaging study" }] },
        "subject": { "reference": "Patient/p1" },
        "imagingStudy": [{ "reference": "ImagingStudy/ct1" }],
        "conclusion": "No acute abnormality."
      } }
  ]
}
```

The patient, UIDs and report are made up. The two instance lengths match the test vector in Appendix B, whose plaintext stands in for the two DICOM files.

## Appendix B. Test vector

Produced by `bun reference/test-vector.ts`. The ciphertext and tags were reproduced independently in Python using `cryptography.hazmat.primitives.ciphers.aead.AESGCM`.

| Input | Value |
|---|---|
| Series key | `ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8` (bytes `20 21 22 … 3f`) |
| Plaintext | 150,000 bytes, byte *k* = *k* mod 251. Two "instances" of 70,000 and 80,000 bytes. |

| Output | Value |
|---|---|
| Plaintext SHA-256 | `02675bf9284bd74223e98ceea96ebee4c9a469272ead358f462d89753f8c909b` |
| Ciphertext length | 150,048 (records of 65,536, 65,536 and 18,976 bytes, with nonces `00…00`, `00…01` and `00…02`) |
| Ciphertext SHA-256 | `f3205658d3fee29b343d3ba3ef20f52b3e66c2cb05974a93b65504866665fc4e` |
| Record tags | `9a8421bd6740aeac5eb211cf59511b2f`, `4cd810f700957e87ae68edc29e40caf9`, `cf980ddc661684644fa17e5b00b08819` |
| Instance 2 | Plaintext bytes 70,000–149,999, in records 1–2, which are ciphertext bytes 65,536–150,047 |

The script also checks that:
- a range read of instance 2 decrypts correctly;
- a flipped bit is rejected;
- swapped records are rejected;
- a truncated file is rejected;
- a file encrypted under a different series key is rejected.

## Appendix C. Hosting notes

These were tested in October 2026 against GitHub Pages:
- **Ranges:** single byte ranges are honoured (`206`, correct `Content-Range`).
- **Compression:** text types are gzip-encoded, and a range then applies to the gzipped bytes. Binary types (PNG in the test) are not. The `.bin` suffix is expected to make static hosts serve series files as `application/octet-stream` without compression; verify per host.
- **CORS:** `Access-Control-Allow-Origin: *` is sent, and `OPTIONS` is answered with 405.

GitHub's documented limits (1 GB per site, a 100 MB file limit for sites published from a branch, no Git LFS) make Pages suitable for demonstrations. Object stores such as S3, R2 and GCS support Range requests and suit full-size studies.
