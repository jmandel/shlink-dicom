# Sharing full DICOM studies through SMART Health Links

Status: draft proposal, October 2026. Reference code and a test vector are in `reference/`.

## 1. Summary

A patient or a provider should be able to share a complete imaging study, with every original DICOM file, by handing over one SMART Health Link. The files may be hosted on a server that cannot read them, including a static file host, and the receiver should be able to show the first images before the whole study has downloaded.

This proposal adds no new link type. The link resolves, as any SMART Health Link does, to an encrypted FHIR Bundle. The Bundle holds an `ImagingStudy` that lists every series and instance and gives the study a random file id and a random 32-byte key. Each study is one file alongside the Bundle (`{fileId}.bin`): the original DICOM files laid end to end, encrypted in fixed-size records under that key. A series added to the study later can have a file and key of its own. A client that does not know this convention still gets a valid FHIR description of the study. A client that does can fetch any series or instance, or any byte range, and decrypt and verify it.

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

- **Reuse the units DICOM and FHIR already have.** DICOM organizes instances into series and series into studies. FHIR `ImagingStudy` already lists series and instances by UID. The study is the unit of storage, and `ImagingStudy` is the index: every series and every instance is one contiguous byte range of its file. No new container, segment or chunk concept is visible to the client.
- **One way to do each thing.** There are no modes or options in the file format: no optional compression, no optional framing. A client has one code path.
- **Do not touch the DICOM files.** Any compression a source applied lives inside the DICOM files and is described by their own Transfer Syntax UID. The format neither adds compression nor removes it.
- **The authenticated Bundle carries everything the client must trust.** Lengths, file identifiers and file keys come from the encrypted Bundle, never from the encrypted files. An encrypted file is only ciphertext.
- **Stay inside the core SHL specification.** The link, the manifest, the Bundle encryption and the flags are used exactly as specified. Everything new lives in a profile and two FHIR extensions in `ImagingStudy`, which clients that do not understand them ignore.

## 7. Overview

```
Sharer                                  Host (cannot decrypt)                  Receiver
------                                  ---------------------                  --------
read DICOM files, group by study
  and series
for each study:
  random 16-byte file id, 32-byte key
  concatenate instances, series by series
  encrypt in 64 KiB records  ───────►  {fileId}.bin  (one file/study)
build Bundle: Patient, ImagingStudy,
  DiagnosticReport?
encrypt Bundle as JWE (SHL key) ─────►  SHL file (U) or manifest entry
make SHL (url, key, flags, label)  ─────── link / QR ──────────────────────►  resolve SHL, decrypt Bundle
                                                                              read ImagingStudy
                                        GET/Range {fileId}.bin  ◄───────────  fetch series or byte range
                                                                              decrypt records with file key,
                                                                              verify, hand DICOM to viewer
```

## 8. The Bundle

The SHL resolves to one `application/fhir+json` file whose plaintext is a FHIR R4 Bundle of type `collection`. In U mode it is the single file behind `url`; in manifest mode it is one of the manifest's files. The Bundle contains:

- one `Patient`;
- one or more `ImagingStudy` resources, one per shared study;
- optionally, `DiagnosticReport` resources (for example the radiology report), referring to the `ImagingStudy` through `DiagnosticReport.imagingStudy`.

### 8.1 ImagingStudy

Standard R4 `ImagingStudy`, with these rules:

- `meta.profile` includes `"http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/dicom-imaging-study"`, so a client can recognize the convention without scanning extensions.
- `identifier` carries the Study Instance UID as `{ system: "urn:dicom:uid", value: "urn:oid:<StudyInstanceUID>" }`.
- `subject` references the `Patient` in the Bundle.
- `numberOfSeries` and `numberOfInstances` are populated and count the series and instances **shared in this Bundle**. If the link shares only a subset of a study's series, `ImagingStudy.note` SHOULD state that the shared study is partial.
- Every shared series appears in `series`, and every shared instance in `series.instance`. Every shared series lists at least one instance. Each `series.instance` has `uid` (SOP Instance UID), `sopClass` (`urn:ietf:rfc:3986` / `urn:oid:<SOP Class UID>`) and, if known, `number` (Instance Number).

Two extensions. Their URLs are under `http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/`, the canonical base of the SMART Health Cards and Links implementation guide, where this profile is to be published:

| Extension / Sub-extension | On | Type | Meaning |
|---|---|---|---|
| `…/linked-file` | `ImagingStudy`, `ImagingStudy.series` | complex | An encrypted file and its key. On `ImagingStudy` it names the file of every series in the study; on a `series` it names that series' file instead: |
| ↳ `id` | `linked-file` | `valueString` | The file id: 16 random bytes, base64url-encoded without padding (22 characters). Names the immutable file (`{id}.bin`). |
| ↳ `key` | `linked-file` | `valueString` | The file's encryption key: 32 random bytes, base64url-encoded without padding (43 characters). |
| `…/instance-length` | `ImagingStudy.series.instance` | `valueDecimal` (a positive integer) | Length in bytes of this instance's DICOM file. |

`valueDecimal` is used because R4 `integer` is 32-bit, and a single whole-slide image instance can exceed 2 GB.

Rules for `linked-file`:

- Every shared series has a file: the `linked-file` on the series if it has one, else the one on its `ImagingStudy`. A series with neither is an error.
- Each file belongs to one `ImagingStudy`. Two `linked-file` extensions in that `ImagingStudy` that give the same `id` give the same `key`.
- A `linked-file` on `ImagingStudy` MUST be present only if at least one of its series uses it, so a Bundle carries no key for a file none of its series are in.
- A link that shares only some of a study's series MUST point only at files that hold nothing else (§13).
- A sharer packing a study writes one file for the whole study and puts `linked-file` on `ImagingStudy` only. A series-level `linked-file` is for a series added to the study later (§10.3).

**Where each instance's bytes are.** Walk `series` in array order and each series' `instance` in array order, keeping a running offset for each file, starting at 0. Each instance occupies [offset, offset + length) of its series' file, and then advances that file's offset by its length. So:

- a file's plaintext is the instances of the series that use it, in `series` order and then `instance` order, with nothing between them;
- each series is one contiguous range of its file, from its first instance's offset to the end of its last instance;
- a file's plaintext length *P* is its final offset.

Offsets, series sizes and file lengths are not written in the Bundle; the client computes them from the instance lengths.

### 8.2 Example

A one-series CT with two instances (UIDs shortened). Appendix A has a complete Bundle, with a second file for a series added later.

```json
{
  "resourceType": "ImagingStudy",
  "id": "ct1",
  "meta": { "profile": ["http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/dicom-imaging-study"] },
  "extension": [{
    "url": "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/linked-file",
    "extension": [
      { "url": "id", "valueString": "AAECAwQFBgcICQoLDA0ODw" },
      { "url": "key", "valueString": "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8" }
    ]
  }],
  "status": "available",
  "identifier": [{ "system": "urn:dicom:uid", "value": "urn:oid:1.2.840.113619.2.55.3.604688119" }],
  "subject": { "reference": "Patient/p1" },
  "started": "2026-09-30T14:12:00-05:00",
  "numberOfSeries": 1,
  "numberOfInstances": 2,
  "series": [{
    "uid": "1.2.840.113619.2.55.3.604688119.971",
    "number": 2,
    "modality": { "system": "http://dicom.nema.org/resources/ontology/DCM", "code": "CT" },
    "description": "Abdomen 5mm",
    "numberOfInstances": 2,
    "instance": [
      { "extension": [{ "url": "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/instance-length", "valueDecimal": 70000 }],
        "uid": "1.2.840.113619.2.55.3.604688119.971.1",
        "sopClass": { "system": "urn:ietf:rfc:3986", "code": "urn:oid:1.2.840.10008.5.1.4.1.1.2" },
        "number": 1 },
      { "extension": [{ "url": "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/instance-length", "valueDecimal": 80000 }],
        "uid": "1.2.840.113619.2.55.3.604688119.971.2",
        "sopClass": { "system": "urn:ietf:rfc:3986", "code": "urn:oid:1.2.840.10008.5.1.4.1.1.2" },
        "number": 2 }
    ]
  }]
}
```

The file `AAECAwQFBgcICQoLDA0ODw.bin` holds 150,000 bytes of plaintext: instance 1 at [0, 70000) and instance 2 at [70000, 150000).

For scale: a 2,000-instance series listed this way is about 580 KB of minified JSON, most of it the repeated extension URL and UIDs. Under the SHL file's DEFLATE it is about 60 KB. The `linked-file` extension adds about 230 bytes per file.

## 9. Encrypted files

### 9.1 Plaintext

A file's plaintext is the instances that use it, each a complete DICOM Part 10 file (128-byte preamble, `DICM`, file meta information, data set), concatenated in the order §8.1 gives (`series` order, then `series.instance` order) with nothing between them. The bytes are those the source exported.

### 9.2 Encryption

Input:
- the file key *K_f* (32 bytes, the base64url-decoded `key` sub-extension of the file's `linked-file`).

```
R = 65,520                               plaintext bytes per record
n = max(1, ceil(P / R))                  records, where P = plaintext length
chunk_i = plaintext[i·R, min(P, (i+1)·R))
nonce_i = uint96_be(i)                   record index i as a 12-byte big-endian unsigned integer
record_i = AES-256-GCM-Encrypt(K_f, nonce_i, chunk_i, no additional data)    ciphertext || 16-byte tag
file  = record_0 || record_1 || … || record_{n−1}
```

- Every record except the last is exactly 65,536 bytes; the last is its chunk length plus 16.
- The ciphertext length is `P + 16·n`.

There is no header, no padding and no end marker:
- **Key:** the file key *K_f* comes from the authenticated Bundle.
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
  verify tag and decrypt record i with (K_f, uint96_be(i))
concatenate decrypted records, then slice from (a − 65520·first), length b − a
```

Because each 65,536-byte record carries its own 16-byte GCM tag and binds its record index *i* in the nonce, the client cryptographically authenticates the fetched records immediately without downloading the rest of the file. Only a whole-file read checks the total ciphertext length *C*; a range read checks that the server returned the expected byte count for records `first..last` and verifies each record's tag. Reading one instance costs at most one extra partial record (under 64 KiB) at each end.

### 9.4 Why these choices

- **AES-256-GCM** matches the A256GCM the SHL specification already uses, so the images are not protected more weakly than the Bundle, and needs no other cryptographic primitive.
- **A random 32-byte key per file** separates the file keys from the SHL key (which is used only for the Bundle JWE) and from each other, so a simple sequential counter nonce (`uint96_be(i)`) is safe. It also lets the same encrypted files be shared across several links, each with its own SHL key, passcode, expiry or subset of studies, by encrypting only a new Bundle.
- **One file per study** matches how studies are usually shared, whole, and each study has its own key. A series or an instance is still one byte range of the file, so reading one costs one Range request, as it would with a file per series. The host sees one file per study instead of one per series (§13).
- **64 KiB records** keep the overhead to 16 bytes per 64 KiB (0.02%). They also keep the over-fetch on a range read small, and fit comfortably in memory for streaming.

## 10. Fetch contract

Encrypted files sit alongside the Bundle. The URL of a file is `{fileId}.bin` resolved relative to `baseUrl` using standard RFC 3986 resolution (`new URL(fileId + ".bin", baseUrl)`):
- in **U mode**, `baseUrl` is the SHL's `url`;
- in **manifest mode**, the Bundle MUST be delivered via `location` (not `embedded`), and `baseUrl` is that `location` URL.

`baseUrl` MUST end in `/` or a file name within the link's own directory (for example `https://host.example/s/abc/bundle.jwe`), so that `{fileId}.bin` resolves to `https://host.example/s/abc/{fileId}.bin` and does not collide with other shares in a parent path. Because standard relative resolution drops any query string on `baseUrl`, access tokens MUST live in the URL path (not in query-string signatures such as `?sas=…` or `?X-Amz-Signature=…`, which also sign only a single object). Because the Bundle carries only the relative `fileId`, the encrypted Bundle and `.bin` files can be generated offline and placed on any host without knowing the final URL in advance.

- **Immutability and caching:** A `fileId` always names the exact same ciphertext bytes, encrypted under the same key, and MUST NOT be reused for different content. Receivers MAY cache `{fileId}.bin` (or verified plaintext records) indefinitely by `fileId`, including across link updates and across different links.
- **Sharing files across links:** When a server hosts multiple links over the same study, each link resolves files under its own path (for example `/shl/{linkId}/{fileId}.bin`), backed by the same underlying `.bin` files on disk or object storage, so each link can be revoked independently. On a static host with no server routing, links either use separate folders (via copies or symlinks) for independent revocation, or share one folder and are revoked together.

### 10.1 Server (the host of the files)

1. `GET {fileId}.bin` (resolved against `baseUrl`) returns the file with `Content-Type: application/octet-stream`, without any `Content-Encoding`.
2. The server MUST honour a single byte range (`Range: bytes=a-b`) with `206 Partial Content`. It MAY ignore multi-range requests.
3. Requests carry `?recipient=<string>`, the same string the client sent when resolving the SHL. The server SHOULD record it with the access, and MUST NOT require it to match anything.
4. Cross-origin access: the server SHOULD send `Access-Control-Allow-Origin` (for example `*`). A single byte range is a CORS-safelisted request header in the current Fetch standard, so no preflight is needed in conforming browsers. Servers that can, SHOULD also answer preflight requests for `Range`, for older browsers.
5. **Lifetime.**
   - **U mode, or a manifest without `P`.** The encrypted files MUST be available exactly as long as the SHL itself resolves, and MUST return `404` once the SHL is revoked or expired. Putting `{fileId}.bin` alongside the Bundle arranges this automatically. A static host meets the requirement by deleting the folder when the link is withdrawn.
   - **Manifest with `P`.** The encrypted files MUST NOT be reachable using only what the link contains. Each manifest response serves the Bundle via a `location` URL with a fresh, unguessable path prefix (at least 256 bits of entropy, for example `https://host.example/cap/{token}/bundle.jwe`) valid for at most one hour, under which `{fileId}.bin` also resolves. Although the SHL specification notes that `location` is intended for single use, the server MUST allow multiple `GET` and `Range` requests for `{fileId}.bin` under that prefix until the prefix expires. Because `location` is in the unencrypted manifest response, the host never needs the SHL key to mint fresh prefixes. If a download spans the one-hour expiry, the client re-resolves the SHL with the passcode to get a new `location` prefix and resumes with Range requests from the next needed record.

### 10.2 Client

1. Resolve the SHL as the core specification describes, decrypt the Bundle, and find each `ImagingStudy` declaring `http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/dicom-imaging-study` (or carrying `linked-file` on the study or its series). The rest of the Bundle is used as ordinary FHIR.
2. Find each series' file and each instance's offset (§8.1). For each file, compute:
   - the URL `new URL(fileId + ".bin", baseUrl)`;
   - the 32-byte file key *K_f* by base64url-decoding `key` (browser clients SHOULD import *K_f* into WebCrypto with `extractable: false`);
   - the plaintext length *P*, the sum of the lengths of the instances in the file;
   - the expected ciphertext length *C* = *P* + 16·*n*.
3. **A series, an instance or a frame** (a frame when the client knows its offset): compute the record range of its plaintext bytes (§9.3) and send one Range request. Decrypt record by record as bytes arrive, passing each completed instance on as soon as its last byte is decrypted. If the server answers `200` with the whole file, seek locally.
4. **A whole file:** GET it, decrypt the same way, and check that exactly *C* bytes arrived.
5. Reject the read if any record fails authentication or the byte counts differ from those computed. Never pass bytes from a record that failed authentication to a viewer.
6. Hand each instance to the application as a DICOM Part 10 file.

### 10.3 Updates (`L` flag)

A long-lived link may gain studies, series or instances (for example a new prior study, or an amended report).

- **A new study** is packed into a new file with a new random file id and key (§11.1).
- **A new series in a shared study** is either written to a file of its own, with `linked-file` on the new `series` element, or packed with the rest of the study into a replacement study file with a new id and key. The first uploads only the new series; the second keeps one file per study.
- **A changed or removed series or instance** means rewriting the file that holds it, with a new id and key. It cannot be moved out to a file of its own, because the offsets of everything after it in the old file would shift (§8.1). A file's bytes never change.
- Each time, the Bundle is re-encrypted (with a fresh random 12-byte JWE IV, as JWE requires) referencing the new file ids and keys. Neither file ids nor file keys may be reused with different content.
- **Publish order:** upload all new `{fileId}.bin` files first, then publish the new Bundle, and delete any replaced `.bin` files last, so a receiver never sees a Bundle naming a file that is not yet present.
- **Detecting changes cheaply:** the sharer SHOULD populate `Bundle.meta.lastUpdated`. In manifest mode, the manifest entry's `lastUpdated` already signals changes; in U mode, servers SHOULD send an `ETag` on the Bundle and answer `If-None-Match` with `304 Not Modified`. Clients SHOULD honour `Retry-After` when polling, as the SHL specification recommends, and fetch only files whose `fileId` they have not yet cached.

## 11. Building and using the files

### 11.1 Sharer

1. Read the DICOM source: a CD or DICOMDIR file set, a folder, a ZIP, or a DICOMweb retrieve. Ignore the DICOMDIR itself; it is an index, not an instance.
2. Parse each file's header. Group instances by (Study Instance UID, Series Instance UID); grouping by the pair keeps a series UID wrongly reused across studies from merging them.
3. Handle broken data explicitly:
   - **Missing UID.** A file without a Series Instance UID, which DICOM requires but some exporters omit, is either rejected or placed in a series of its own with a newly generated UID. That choice is recorded in the Bundle, for example in `series.description`.
   - **Bare data set.** A file that is a bare data set without Part 10 wrapping is given the Part 10 preamble and file meta header. This is the only change a sharer makes to file bytes.
4. Order each study's series by Series Number, then by Series Instance UID; order each series' instances by Instance Number, then by SOP Instance UID for ties or missing numbers.
5. For each study:
   - draw a random 16-byte file id and a random 32-byte file key;
   - concatenate the files, series by series, in that order;
   - encrypt (§9.2) and upload, using a resumable or multipart upload for large files;
   - put `linked-file` on the `ImagingStudy`, and none on its series.
6. Build the Bundle (§8), encrypt it as the SHL file or manifest entry, and create the link.

A sharer may offer, as a separate step before packing, to transcode uncompressed images to a lossless compressed transfer syntax (for example HTJ2K lossless or JPEG-LS) to reduce size. The result is still DICOM and declares its own transfer syntax, so the format is unchanged. The files are then no longer byte-identical to the source's, and the sharer should say so.

### 11.2 Receiver and viewing (informative)

Existing web viewers such as OHIF read DICOMweb. A receiver page can install a Service Worker that answers DICOMweb requests from the decrypted files:

| DICOMweb request | Answered from |
|---|---|
| `…/studies/{s}/series/{se}/metadata` | DICOM JSON, built from each instance's header (the client fetches and parses only the headers, using ranges) |
| `…/series/{se}` | The series' byte range, streamed, re-wrapped as `multipart/related` |
| `…/instances/{i}` | One byte range |
| `…/instances/{i}/frames/{f}` | One byte range |

For frames, the client first reads the instance header to find frame offsets: the Basic or Extended Offset Table for encapsulated pixel data, or the fixed frame size for native pixel data. It then requests only the frames being displayed.

To save a study to disk, the receiver writes each instance as its own file, or builds an uncompressed ZIP on the fly.

## 12. Relationship to Plain SHLs

A client implementing only the core SHL specification can parse the link, retrieve the Bundle (in U or manifest mode) and decrypt it. The Bundle is valid FHIR R4. Such a client sees the patient, the study and series structure, and any `DiagnosticReport`. It ignores the profile and the two extensions in `ImagingStudy` as the specification requires, and does not fetch the encrypted files.

This proposal therefore treats these links as Plain SHLs. The counter-argument is that for imaging the pixels are the fundamental data, and a client that cannot get them has not fully processed the link. If the SHL community takes that view, the convention would need its own URI scheme (for example `shlink-dicom:/`) and an entry on the SHL extensions registry, with no change to anything else in this proposal.

## 13. Security and privacy

- **Confidentiality from the host.** The Bundle is encrypted under the SHL key, and each file is encrypted under its own random 32-byte key carried inside the Bundle; the host sees neither.
  - **What the host can see:** the number of files and their sizes, the request times and ranges, the `recipient` strings, and the file ids (which are random).
  - **What it can't see:** DICOM UIDs, which do not appear in URLs, or anything in the Bundle.

  File sizes and the pattern of range requests can hint at modality and study shape.
- **Series sizes.** With one file per study, the stored files show the host how many studies there are and how large each is, but not how many series each has or how large they are. Reading reveals more: each Range request names the bytes a viewer wants, so a host that watches the requests learns the boundaries of the series and instances that are viewed. A series stored in a file of its own (§10.3) shows its size at rest.
- **Integrity, not origin identity.** Every record is authenticated, and its position is bound through the nonce. The total length and the file key come from the authenticated Bundle. A host cannot alter, truncate, extend, reorder or swap files, or serve an older version, without detection. This proves the files match what the Bundle's creator packed, but does not verify who created the Bundle.
- **Treat the decrypted Bundle as secret.** Anyone with the link can decrypt the Bundle, and the decrypted Bundle holds the keys for the files it names (and no others). Forwarding or storing the decrypted Bundle therefore forwards the ability to decrypt those files wherever their ciphertext is reachable. A receiver that imports the `ImagingStudy` into an EHR or FHIR server SHOULD strip the `linked-file` extensions (or their `key` sub-extensions) first, or keep the keys only in its image cache. U mode cannot be combined with a passcode; sharers should use `exp`, revocation and passcodes (manifest mode) as the sensitivity of the study warrants.
- **A key opens the whole file.** Whoever holds a file's key can read every instance in it, including instances of series the Bundle does not list. A link that shares only some series of a study MUST point only at files that hold nothing else, so a sharer packs the subset as its own file. (Leaving series out of a Bundle without repacking would also move the offsets of the series after them.) Sharing whole studies avoids this: each study file is shared or not.
- **Correlation across recipients.** When two links share the same underlying `.bin` file, both Bundles carry the same `id` and `key`, so recipients who compare decrypted Bundles can tell they received identical data. When that matters, the sharer can re-encrypt the study with a fresh `id` and `key` for each link.
- **Nonce safety.** The SHL key is used only for the Bundle JWE, which draws a fresh random 12-byte IV each time the Bundle is encrypted. Each file is encrypted under its own random 32-byte key *K_f* and uses a sequential counter (`uint96_be(i)`) per record. Because each *K_f* is used for at most one immutable file, no `(K_f, nonce)` pair is ever reused. A sharer MUST draw file keys and file ids from a cryptographically secure random source and MUST NOT reuse either for different content.
- **The `recipient` string** is supplied by the client and is not authenticated. It is an access log hint, not access control.
- **DICOM content is sensitive throughout.** Headers carry names, identifiers and dates, and some images carry burned-in text. Nothing in this proposal removes them; the receiver gets the study as exported.

## 14. Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Each instance as a FHIR `Binary` inside an `application/fhir+json` file | Plain without any extension, but each instance is base64 inside JSON inside a base64url JWE. There's no partial access, and no streaming within a file. Workable for small studies only. |
| An `application/smart-api-access` token plus the source's DICOMweb server (SMART imaging access) | Good when a provider shares from its own PACS, and needs no new format. It doesn't work for studies the patient holds, or for hosts that can't read the data. It can sit beside this convention in the same Bundle. |
| One file per series, always | A CT or MR study often has 10–30 series, so it multiplies the files, keys and uploads per study by that much, and it shows the host every series' size at rest. Reading one series from a study file is already one Range request. The series-level `linked-file` keeps the one advantage, adding a series without rewriting the study's file. |
| One file per instance | Thousands of files and requests per CT, more upload overhead, and it shows the host each instance's size. Kept in mind only as a fallback for hosts without Range support. |
| ZIP container inside the encrypted file | The Bundle already gives offsets, and the encryption already authenticates, so ZIP's directory and CRCs add a second offset scheme and nothing else. Receivers can build a ZIP for download themselves. |
| Optional compression of the encrypted files (deflate when it helps) | Gives the client two code paths, and a compressed file can't be range-read. Compression that matters for DICOM belongs inside the DICOM files, where the transfer syntax already describes it. |
| RFC 8188 (`aes128gcm` content coding) as-is | Uses AES-128, has a header and a final-record delimiter, and is built for when the length isn't known in advance. Here the length and key come from the authenticated Bundle, so the simpler construction in §9 suffices. |
| File URL derived from the Series Instance UID | Simple, but it exposes UIDs to the host (UIDs often embed an organization's OID root), and a changed series would keep the same URL. A random file id avoids both. |

## 15. Open questions

1. **Plain or not.** Whether the SHL community accepts §12's reading.
2. **FHIR version.** The proposal targets R4, as the SHL guide does. In R5, `instance-length` could use `integer64`.
3. **Frame offsets.** Whether to add an optional per-instance list of frame offsets to the Bundle, so viewers can fetch a frame without first reading the instance header. The cost is a larger Bundle for multi-frame studies.
4. **Several studies in one link.** Allowed as written, with one `ImagingStudy` each. Any limits are untested.
5. **Hosts without Range support.** Whether to define the one-file-per-instance fallback formally, or simply require Range support.
6. **CORS.** Behaviour of Range requests from browsers that still preflight them, against hosts that reject `OPTIONS`. GitHub Pages answers `OPTIONS` with 405.

## Appendix A. Complete example Bundle

A CT study packed as one file, with a series added later in a file of its own. The study's `linked-file` names `AAECAwQFBgcICQoLDA0ODw.bin`, which holds series 2 and 997. Series 3 carries its own `linked-file`, naming `EBESExQVFhcYGRobHB0eHw.bin`.

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
        "meta": { "profile": ["http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/dicom-imaging-study"] },
        "extension": [{
          "url": "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/linked-file",
          "extension": [
            { "url": "id", "valueString": "AAECAwQFBgcICQoLDA0ODw" },
            { "url": "key", "valueString": "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8" }
          ]
        }],
        "status": "available",
        "identifier": [{ "system": "urn:dicom:uid", "value": "urn:oid:1.2.840.113619.2.55.3.604688119" }],
        "subject": { "reference": "Patient/p1" },
        "started": "2026-09-30T14:12:00-05:00",
        "numberOfSeries": 3,
        "numberOfInstances": 3,
        "series": [
          { "uid": "1.2.840.113619.2.55.3.604688119.971",
            "number": 2,
            "modality": { "system": "http://dicom.nema.org/resources/ontology/DCM", "code": "CT" },
            "description": "Abdomen 5mm",
            "numberOfInstances": 1,
            "instance": [
              { "extension": [{ "url": "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/instance-length", "valueDecimal": 70000 }],
                "uid": "1.2.840.113619.2.55.3.604688119.971.1",
                "sopClass": { "system": "urn:ietf:rfc:3986", "code": "urn:oid:1.2.840.10008.5.1.4.1.1.2" },
                "number": 1 }
            ] },
          { "uid": "1.2.840.113619.2.55.3.604688119.997",
            "number": 997,
            "modality": { "system": "http://dicom.nema.org/resources/ontology/DCM", "code": "SR" },
            "description": "Dose report",
            "numberOfInstances": 1,
            "instance": [
              { "extension": [{ "url": "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/instance-length", "valueDecimal": 80000 }],
                "uid": "1.2.840.113619.2.55.3.604688119.997.1",
                "sopClass": { "system": "urn:ietf:rfc:3986", "code": "urn:oid:1.2.840.10008.5.1.4.1.1.88.67" },
                "number": 1 }
            ] },
          { "extension": [{
              "url": "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/linked-file",
              "extension": [
                { "url": "id", "valueString": "EBESExQVFhcYGRobHB0eHw" },
                { "url": "key", "valueString": "YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8" }
              ]
            }],
            "uid": "1.2.840.113619.2.55.3.604688119.973",
            "number": 3,
            "modality": { "system": "http://dicom.nema.org/resources/ontology/DCM", "code": "CT" },
            "description": "Abdomen 5mm delayed",
            "numberOfInstances": 1,
            "instance": [
              { "extension": [{ "url": "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/instance-length", "valueDecimal": 20000 }],
                "uid": "1.2.840.113619.2.55.3.604688119.973.1",
                "sopClass": { "system": "urn:ietf:rfc:3986", "code": "urn:oid:1.2.840.10008.5.1.4.1.1.2" },
                "number": 1 }
            ] }
        ]
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

Where each instance's bytes are (§8.1):

| Series | Instance length | File | Plaintext bytes |
|---|---|---|---|
| 2, Abdomen 5mm | 70,000 | `AAECAwQFBgcICQoLDA0ODw.bin` | 0–69,999 |
| 997, Dose report | 80,000 | `AAECAwQFBgcICQoLDA0ODw.bin` | 70,000–149,999 |
| 3, Abdomen 5mm delayed | 20,000 | `EBESExQVFhcYGRobHB0eHw.bin` | 0–19,999 |

The patient, UIDs and report are made up. The instance lengths match the test vector in Appendix B, whose plaintext stands in for the DICOM files.

## Appendix B. Test vector

Produced by `bun reference/test-vector.ts`, which also writes the Appendix A Bundle, its JWE and both files to `fixtures/golden/`. The ciphertext and tags were reproduced independently in Python using `cryptography.hazmat.primitives.ciphers.aead.AESGCM`.

**The study file** `AAECAwQFBgcICQoLDA0ODw.bin`:

| Input | Value |
|---|---|
| File key | `ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8` (bytes `20 21 22 … 3f`) |
| Plaintext | 150,000 bytes, byte *k* = *k* mod 251. Two "instances" of 70,000 and 80,000 bytes. |

| Output | Value |
|---|---|
| Plaintext SHA-256 | `02675bf9284bd74223e98ceea96ebee4c9a469272ead358f462d89753f8c909b` |
| Ciphertext length | 150,048 (records of 65,536, 65,536 and 18,976 bytes, with nonces `00…00`, `00…01` and `00…02`) |
| Ciphertext SHA-256 | `f3205658d3fee29b343d3ba3ef20f52b3e66c2cb05974a93b65504866665fc4e` |
| Record tags | `9a8421bd6740aeac5eb211cf59511b2f`, `4cd810f700957e87ae68edc29e40caf9`, `cf980ddc661684644fa17e5b00b08819` |
| Instance 2 | Plaintext bytes 70,000–149,999, in records 1–2, which are ciphertext bytes 65,536–150,047 |

**The series-level file** `EBESExQVFhcYGRobHB0eHw.bin` (file id bytes `10 11 12 … 1f`):

| Input | Value |
|---|---|
| File key | `YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8` (bytes `60 61 62 … 7f`) |
| Plaintext | 20,000 bytes, byte *k* = *k* mod 241. One "instance". |

| Output | Value |
|---|---|
| Plaintext SHA-256 | `634ea1475721847569e54de94076768333415624e9558342fd10ed6d078d9739` |
| Ciphertext length | 20,016 (one record, nonce `00…00`) |
| Ciphertext SHA-256 | `acfa75bf344f92fbe3c3122d8391a65c60e12b384ef4459d2c9c5d793488f41c` |
| Record tag | `33f76b60464e2cba93246985761a70eb` |

The script also checks that:
- a range read of instance 2 decrypts correctly;
- a flipped bit is rejected;
- swapped records are rejected;
- a truncated file is rejected;
- a file encrypted under a different key is rejected;
- the Appendix A Bundle resolves each series to the file and offsets in the table above, and a range read of each instance decrypts correctly;
- a Bundle that gives one file id two keys is rejected.

## Appendix C. Hosting notes

These were tested in October 2026 against GitHub Pages:
- **Ranges:** single byte ranges are honoured (`206`, correct `Content-Range`).
- **Compression:** text types are gzip-encoded, and a range then applies to the gzipped bytes. Binary types (PNG in the test) are not. The `.bin` suffix is expected to make static hosts serve the encrypted files as `application/octet-stream` without compression; verify per host.
- **CORS:** `Access-Control-Allow-Origin: *` is sent, and `OPTIONS` is answered with 405.

GitHub's documented limits (1 GB per site, a 100 MB file limit for sites published from a branch, no Git LFS) make Pages suitable for demonstrations. Object stores such as S3, R2 and GCS support Range requests and suit full-size studies.
