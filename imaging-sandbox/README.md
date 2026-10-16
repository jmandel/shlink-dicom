# Imaging sandbox

A small server that plays every actor in the Argonaut [SMART Imaging Access](https://build.fhir.org/ig/argonautproject/smart-imaging/) IG, so the Share experience can connect to a "patient portal" and pull imaging the way it would from a real health system:

- an **Authorization Server** (SMART App Launch 2.x, standalone launch, public clients, PKCE S256, refresh tokens, token introspection and revocation), with a demo sign-in and consent page;
- a **Clinical FHIR Server** with `Patient`, `DiagnosticReport` and the reports' `Binary` attachments (PDF and plain text);
- an **Imaging FHIR Server** with `ImagingStudy` search and WADO-RS `Endpoint`s;
- a **DICOMweb server** for WADO-RS retrieval, which accepts the same access token.

All four run in one Bun process. The patient is **Josh Example**, the de-identified name of a real patient:
- **Josh's own studies,** which he published de-identified in [jmandel/my-health-data](https://github.com/jmandel/my-health-data) (`imaging/`, made by `imaging/deid.py` there): a brain MRI, a CT of the abdomen and pelvis, and three sets of hand and wrist radiographs. The sandbox serves those files unchanged.
- **A whole-slide microscopy image** (an H&E lung slide) from the NCI Imaging Data Commons, under CC BY 4.0, rewritten to the same patient. See [the slide's attribution](#slide-attribution).

How each IG requirement is met is in [CONFORMANCE.md](CONFORMANCE.md).

Deployed (private for now) at **https://smart-imaging-sandbox.exe.xyz**: see [Deploying](#deploying).

## Running it

Requires Bun 1.4.3. The server has no runtime dependencies. The tests use `playwright-core` and `pdfjs-dist`, pinned in `package.json` (`bun install`).

The data build also needs dcmtk (`dcmcjpeg`) and `uv`, for the compressed copies; `--no-variants` builds without them.

```sh
cd imaging-sandbox
bun scripts/build-data.ts         # once: builds build/dataset/ (about 1 s; downloads the sources if needed)
bun src/server.ts                 # http://localhost:3334
```

On startup the server prints its URLs, the number of studies and instances it loaded, and the introspection key.

## The dataset

`scripts/build-data.ts` builds everything the server serves into `build/dataset/` (gitignored), using only committed inputs:

- **`data/studies.json`:**
  - The sources, each pinned by URL and SHA-256:
    - the 28 per-series archives of the five my-health-data studies;
    - five instances of the IDC slide series, from public S3 URLs.
  - Downloads are kept in `build/sources/`. A local copy with the right hash is used instead of downloading. It can be in `build/sources/`, `../data/samples/`, or a directory listed in `SOURCE_CACHE` (colon-separated; for example a local `my-health-data/imaging`).
  - The report content for each study.
  - For the slide, its date, time, accession number and header rules.
- **`data/patient.json`:** the patient, as in the DICOM headers:
  - name Josh Example;
  - identifier JEXAMPLE01;
  - birth date 1982-01-01 (the year only);
  - male.
- **`data/test-patients.json`:** a synthetic second patient with no imaging, Robin Example, used to test a token for another patient.

| Study | Date | Series | Images | Size |
|---|---|---|---|---|
| MRI brain (Hitachi Altaire, 0.7 T) | 29 Jul 2020 | 18 | 267 | 44 MB |
| CT abdomen and pelvis with oral and IV contrast (GE LightSpeed VCT) | 9 Oct 2012 | 8 | 458 | 246 MB |
| XR left wrist, 3 views | 10 Oct 2012 | 3 | 3 | 41 MB |
| XR right hand and wrist, 3 views | 10 Oct 2012 | 3 | 3 | 41 MB |
| XR right hand, 3 views, portable, through a splint | 10 Oct 2012 | 3 | 3 | 31 MB |
| Whole-slide image, lung, H&E | 17 Apr 2023 | 1 | 5 | 152 MB |

### The de-identified studies

my-health-data's `imaging/deid.py` made these from the original CD exports, under DICOM PS3.15's Basic Application Level Confidentiality Profile. Dates, descriptions, protocols, equipment and technical attributes are kept. What it changed:

- **Patient:** name, ID and birth date are replaced (the birth date keeps only the year).
- **Accession numbers and study IDs:** replaced with `EXMRI2020`, `EXCT2012` and `EXCR2012A`–`C`.
- **Removed:** other person names, institution and station names, serial numbers, order identifiers, comments and private attributes.
- **UIDs:** all instance UIDs are replaced.
- **Reconstructed series:** the CT dose report screen, the scanned CT order form, and four MRI viewer captures showed the patient's name in their pixels. `imaging/reconstruct.py` redrew each from scratch with the same layout and information, using the sample identity and fictional clinicians and sites. Each is marked "(reconstructed)" in SeriesDescription and explained in ImageComments.
- **Added:** a synthetic CT radiation dose SR (series 997, "Dose Record (synthetic)"), built from the dose screen's values and the image headers.

Pixel data of the original series is unchanged, at full resolution, in the original transfer syntax: Implicit VR Little Endian for the CT and radiographs, Explicit VR Little Endian for the MRI. The sandbox serves these files byte for byte, and its build checks that each one carries the sample patient's name, ID and birth date.

### The slide's header rewrite

The build rewrites the slide's DICOM headers:

| Attribute | Value |
|---|---|
| PatientName, PatientID, PatientBirthDate | `Example^Josh`, `JEXAMPLE01`, `19820101` |
| StudyDate, StudyTime, ContentDate, ContentTime, AccessionNumber | 17 Apr 2023, 13:05; `EXSL2023` |
| Study, Series, SOP Instance, Frame of Reference, Pyramid, Acquisition, Dimension Organization and Specimen UIDs | new UIDs under `2.25`, minted deterministically from `uidNamespace` and the original UID. Coding-scheme, SOP Class and implementation UIDs are kept. |
| Patient Identity Removed (0012,0062) | removed, since the headers now carry an identity |
| Series, acquisition and timezone dates and times, Study ID, Container Identifier, and the specimen identifiers in the Specimen Description Sequence | values from the study's `header` block in `data/studies.json` |
| Clinical Trial attributes (0012,0010–0040), Image Comments (Aperio scan description with the original file name), private groups 0009 (PixelMed) and 0013 (CTP) | removed |
| The empty Basic Offset Table of each multi-frame (tiled) level | filled with 32-bit offsets, one per frame, pointing at each frame's first fragment item. The source has no Extended Offset Table, and none is added. |

What is left alone:
- **Pixel Data.** It is byte-identical in the overview and thumbnail. In the three tiled levels, only the empty Basic Offset Table is filled in; every fragment (item header and bytes) stays identical and in order, so each frame's compressed data is unchanged.
- **Transfer syntaxes.** The slide keeps JPEG Baseline for its pyramid levels and Explicit VR Little Endian for its overview and thumbnail.
- **Everything else.** Every other element is copied verbatim; only changed elements, and the sequences and group lengths around them, are re-encoded.

The build stops if any of these checks fails, and `test/data-check.ts` checks them again against the sources. It also checks that the de-identified studies are byte-identical to their archives, and that no header still contains the slide's source subject, specimen, collection or file names. For each tiled level it also checks that:
- the offsets point exactly at each frame's first fragment;
- dcmdump reads the pixel items;
- pydicom's `get_frame` reads every frame through the table and gets the source's frame. Set `PYDICOM_PYTHON` to a Python with pydicom (3.0.1 tested);
- dcmtk (`dcmj2pnm`) decodes sample frames identically from the source and the rewritten file;
- `shl-dicom-decode` decodes the two smaller levels identically.

### The slide

The whole-slide study is the CPTAC-LUAD C3N-02231 H&E slide recommended in [`docs/wsi-sample.md`](../docs/wsi-sample.md) (IDC series `4a6b5ed5-a7e8-450d-9af6-e739b1807bac`, Leica Aperio at 20×). It is one series of five instances, sharing one Pyramid UID and Frame of Reference:

| Instance | Content | Size |
|---|---|---|
| VOLUME 18,425 × 11,712, 3,773 tiles of 240 × 240 (JPEG Baseline) | the finest level kept, about 2 µm per pixel | 132.1 MB |
| VOLUME 4,606 × 2,928, 260 tiles | | 11.0 MB |
| VOLUME 2,303 × 1,464, 70 tiles | | 3.6 MB |
| OVERVIEW 1,600 × 629 | a photo of the glass slide, with the label end dark | 3.3 MB |
| THUMBNAIL 1,024 × 650 | | 2.3 MB |

Two instances of the source series are not used. The full-resolution level (1.05 GB) is too large for a sample. The label image shows the CPTAC subject ID, which would contradict the sample patient.

#### Slide attribution

> Slide image: CPTAC-LUAD, subject C3N-02231, from the National Cancer Institute Clinical Proteomic Tumor Analysis Consortium (CPTAC), distributed by the NCI Imaging Data Commons (https://imaging.datacommons.cancer.gov), DOI 10.5281/zenodo.12666813. Licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Changed: patient and specimen attributes replaced with those of the sandbox's sample patient; Basic Offset Tables added to the tiled levels; the label image and the full-resolution level were removed.

The same text is in the slide's ImagingStudy (`note`), in its sample pathology report, in `build/dataset/manifest.json`, and in `out/index.json`.

### Reports and clinical context

No reports exist for these studies, so each study gets a synthetic one, written in the style of a hospital report. Each comes as a PDF and as plain text with the same words.

- **Kinds:**
  - radiology reports (category `RAD`): MRI brain (LOINC 24590-2), CT abdomen and pelvis (103859-5), left wrist (37455-3), right hand and wrist (103442-0), and right hand (47371-0);
  - a surgical pathology report for the slide (category `SP`; LOINC 11529-5).
- **Layout of the PDFs:**
  - letterhead of the fictional facility;
  - patient block: Josh Example, JEXAMPLE01, born 1982-01-01, with exam, date and time, accession, location and ordering clinician;
  - clinical indication, comparison, and a technique section that lists the series from the headers;
  - findings by organ system, and the impression;
  - the signing radiologist or pathologist, with the signature time.
- **Content:**
  - Findings were written after looking at the images.
  - They describe what is visible: for example, the ulnar gutter splint on the portable hand views.
  - They use routine normal-style language where a reader would expect it. They invent no pathology.
- **The slide's report** describes the slide, a lung adenocarcinoma from a public research collection. It says plainly that the slide is not tissue from this patient, and carries the attribution.
- **Marking:** each PDF page has one small footer line, "Synthetic report written for this sample; not a clinical interpretation." The text file ends with the same line. In FHIR, each report carries `meta.tag` v3-ActReason `HTEST` ("test health data") and the line in its narrative.
- **PDF writer:** a small hand-made writer (`scripts/lib/pdf.ts`, standard Helvetica). Its output passes `qpdf --check`, and PDF.js extracts the same text as the text file.

`data/clinical.json` holds the context, all fictional, with phone numbers in the 555-01xx range. The server serves it as FHIR resources:
- two Organizations (Example Medical Center, Example Open MRI);
- seven Practitioners;
- four Encounters: an ED visit and an observation stay in Oct 2012, an outpatient MRI visit in Jul 2020, and an outpatient procedure in Apr 2023;
- one ServiceRequest (order) per study.

These are linked:
- `DiagnosticReport.basedOn` and `ImagingStudy.basedOn` point at the order;
- `encounter` points at the visit;
- `resultsInterpreter` and `ImagingStudy.interpreter` point at the reading clinician;
- `ImagingStudy.referrer` points at the ordering clinician.

Dates and times match the studies.

The output is deterministic: two builds give identical bytes. `build/dataset/SHA256SUMS` lists every file. The DICOM files total 555.2 MB. `deploy/bootstrap-sandbox.sh` checks the digest of `SHA256SUMS` (`EXPECTED_SUMS`) after building on the VM.

### Plain export for other consumers

The build also writes a plain copy of the served studies to **`imaging-sandbox/out/`** (gitignored), for other consumers such as the shlink-dicom sample share. The layout:

```
out/index.json                                   patient, studies (Study Instance UID, accession, date, report paths)
out/dicom/<study>/S<series number>-<description>/IM<instance number>-<uid tail>.dcm
out/reports/<study>.pdf, out/reports/<study>.txt
```

`<study>` is `mri-brain-2020`, `ct-abdomen-pelvis-2012`, `xr-wrist-left-2012`, `xr-hand-wrist-right-2012`, `xr-hand-right-2012` or `slide-lung-2023`. The DICOM files are byte-identical to what WADO-RS serves, and the export is as deterministic as the dataset; `test/data-check.ts` checks both. `--export DIR` writes it elsewhere, and `--export none` skips it.

## Endpoints

With the default `BASE_URL` of `http://localhost:3334`:

| Actor | URL | Notes |
|---|---|---|
| Clinical FHIR base | `/fhir` | the base an app starts from |
| Discovery | `/fhir/.well-known/smart-configuration` | lists the imaging base in `associated_endpoints`, with `smart-imaging-access` and the App Launch capability |
| | `/fhir/metadata` | CapabilityStatement |
| | `/fhir/Patient/{id}`, `/fhir/Patient?_id=` | |
| | `/fhir/DiagnosticReport?patient=…` | also `category` (e.g. `RAD`), `code`, `_id`; one report per shared study |
| | `/fhir/DiagnosticReport/{id}` | read |
| | `/fhir/ServiceRequest?patient=…`, `/fhir/Encounter?patient=…` | orders and visits, with reads by id |
| | `/fhir/Practitioner/{id}`, `/fhir/Organization/{id}` | fictional clinicians and facilities |
| | `/fhir/Binary/{id}` | report attachments (`presentedForm.url`): raw bytes, or a FHIR `Binary` with `Accept: application/fhir+json` |
| Imaging FHIR base | `/imaging/fhir` | |
| | `/imaging/fhir/.well-known/smart-configuration` | same Authorization Server; `smart-imaging-access` in the top-level `capabilities` |
| | `/imaging/fhir/metadata` | CapabilityStatement that `instantiates` the IG's server CapabilityStatement |
| | `/imaging/fhir/ImagingStudy?patient=…` | also `identifier`, `_lastUpdated`, `_include=ImagingStudy:endpoint` |
| | `/imaging/fhir/ImagingStudy/{id}` | read |
| | `/imaging/fhir/Endpoint/wado-rs` | read, in `external` mode |
| WADO-RS base | `/wado-rs` | `/studies/{uid}`, `/series/{uid}`, `/instances/{uid}`, and `/metadata` at each level |
| | `/wado-rs/cap/{capability}/studies/…` | capability URLs, in `capability` mode |
| Authorization | `/auth/authorize` | GET or POST |
| | `/auth/token` | `authorization_code` and `refresh_token` grants |
| | `/auth/introspect` | needs the introspection key (below) |
| | `/auth/revoke` | RFC 7009 |
| | `/` | a page listing the endpoints and demo patients |

Every FHIR resource request and every WADO-RS request needs `Authorization: Bearer <access token>`. Discovery documents and CapabilityStatements are public.

### Tokens and scopes

- **Audience.** Every access token is bound to all three resource servers: the clinical base, the imaging base and the WADO-RS base. This holds whichever FHIR base the app sent as `aud`. Each server checks that its own base is in the token's audience, and introspection returns the list as `aud`.
- **Scope permissions.** Search needs `s` and read needs `r`, in SMART v2 (`.rs`) or v1 (`.read`) syntax:
  - `patient/ImagingStudy.rs` allows both search and WADO-RS retrieval;
  - `.s` alone allows search but not retrieval;
  - `.r` alone allows retrieval but not search.
- **Report attachments.** `Binary` attachments need DiagnosticReport read access (or `patient/Binary.r`).

### WADO-RS details

- **Response format.** Retrieval returns `multipart/related; type="application/dicom"`, one part per instance, each part a Part 10 file. Each part carries `Content-Type: application/dicom; transfer-syntax=<the part's actual syntax>`, `Content-Length` and `Content-Location`.
- **Transfer syntax negotiation**, as proposed in [argonautproject/smart-imaging PR #5](https://github.com/argonautproject/smart-imaging/pull/5). Study, series and instance retrieval all negotiate the same way:
  - **The Accept header.** It lists one or more `multipart/related; type="application/dicom"; transfer-syntax=<UID or *>` ranges, each with an optional `q` weight (default 1).
  - **Choosing a syntax.** For each instance the server picks the highest-weighted syntax it can provide; equal weights follow header order. `*` means as stored.
  - **What can be provided.** Every image stored uncompressed (the MRI, CT and radiographs, and the slide's overview and thumbnail) is also available as JPEG Lossless SV1 (`1.2.840.10008.1.2.4.70`) and JPEG 2000 Lossless (`1.2.840.10008.1.2.4.90`), from copies made at build time. Already-compressed images (the slide's JPEG Baseline tiled levels) and the dose SR come back as stored.
  - **Example.** `Accept: multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2.4.70, multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2.4.90; q=0.9, multipart/related; type="application/dicom"; transfer-syntax=*; q=0.5` returns SV1 wherever a copy exists and stored files elsewhere.
  - **406 Not Acceptable,** with a JSON body giving an example `Accept` and the syntaxes available, in three cases:
    - a range without `transfer-syntax` (PS3.18 reads that as Explicit VR Little Endian; the sandbox refuses it so apps learn to send the parameter);
    - every range at `q=0`;
    - a list without `*` that some instance can't meet.
- **The compressed copies.** `scripts/make-variants.py` makes them during `scripts/build-data.ts`, using encoders that are not this project's code:
  - SV1 with dcmtk's `dcmcjpeg`;
  - JPEG 2000 with OpenJPEG, through pinned `pylibjpeg-openjpeg` and `pydicom` run by `uv`.

  A copy is kept only if it decodes (pydicom with libjpeg or OpenJPEG) to exactly the original pixels and its other attributes are unchanged. The UIDs are kept, and `dcmcjpeg` adds a Derivation Description. The copies live in `build/variants/` (gitignored). They are not in `SHA256SUMS`, because their bytes depend on the encoder versions; `test/data-check.ts` decodes every copy with `shl-dicom-decode` and compares it with the stored image. `--no-variants` skips them.

  Sizes of the images stored uncompressed, as stored, SV1 and J2K:

  | Study | Stored | SV1 | J2K |
  |---|---|---|---|
  | MRI brain (263 images) | 44.3 MB | 28.6 MB | 26.7 MB |
  | CT abdomen and pelvis (457 images) | 246.0 MB | 89.9 MB | 69.4 MB |
  | XR left wrist (3) | 40.7 MB | 16.9 MB | 15.3 MB |
  | XR right hand and wrist (3) | 40.7 MB | 16.2 MB | 14.5 MB |
  | XR right hand, portable (3) | 31.3 MB | 12.4 MB | 10.3 MB |
  | Slide overview and thumbnail (2) | 5.6 MB | 2.8 MB | 2.1 MB |

- **Denials.** A study the token does not cover and a study that does not exist get the same `403`, with the same headers and body.
- **Metadata.** `/metadata` returns `application/dicom+json` built from the served headers. Pixel Data is left out (there is no bulk data endpoint).
- **Not implemented.** Frames, rendered images and thumbnails return 404, after the token check.

### Capability URLs

In `capability` mode, each search returns one capability URL per study. The URL is bound to the grant (the user's consent), not to one access token:
- it keeps working after a token refresh;
- it is refused (`403`) once it expires (`CAPABILITY_TTL`, 15 minutes by default) or the grant ends (refresh token revoked or expired).

A request with an expired or revoked access token is refused with `401` before the capability is checked.

## Demo sign-in

The authorize endpoint shows a sign-in page with two demo patients and no passwords:

- **Josh Example** (`Patient/josh-example`, male, born 1982-01-01, identifier JEXAMPLE01) owns six studies:
  - MRI brain, 29 Jul 2020: 18 series, 267 images (four are reconstructed viewer captures);
  - CT abdomen and pelvis with contrast, 9 Oct 2012: 8 series, 458 instances (with a reconstructed dose screen and order form, and a synthetic dose SR);
  - XR left wrist; XR right hand and wrist; and XR right hand, all 10 Oct 2012: 3 images each;
  - a whole-slide image of lung tissue, H&E, 17 Apr 2023: 1 series, 5 instances (three pyramid levels, the overview and a thumbnail).
- **Robin Example** (`Patient/robin-example`) is synthetic and has no imaging.

Next comes a consent page that lists the permissions the app asked for and the patient's studies, all ticked:
- unticking a permission removes it from the granted scopes;
- unticking a study leaves it, and its report, out of searches and retrieval for that grant;
- **Allow** returns to the app with a code; **Deny** returns `error=access_denied`.

## Connecting the Share app

The Share flow should run a standard SMART standalone launch:

1. **Discovery.** Ask the user for, or preconfigure, the clinical FHIR base (`<BASE_URL>/fhir`). Fetch `/.well-known/smart-configuration`. Find the imaging base by looking for `smart-imaging-access` together with `http://fhir.org/argonaut/smart-imaging/capabilities/app-launch`, first in the top-level `capabilities` and then in `associated_endpoints[].capabilities`.
2. **Authorize.** Redirect to `authorization_endpoint` with:
   - `response_type=code`;
   - `client_id=shlink-dicom-share`;
   - `redirect_uri` set to one of `SHARE_REDIRECT_URIS`;
   - `scope=launch/patient patient/Patient.rs patient/DiagnosticReport.rs patient/ImagingStudy.rs`. Add `patient/ServiceRequest.rs patient/Encounter.rs patient/Practitioner.rs patient/Organization.rs` (or use `patient/*.rs`) for orders, visits and clinicians, and `offline_access` for a refresh token;
   - `aud=<BASE_URL>/fhir`;
   - a random `state`;
   - `code_challenge` and `code_challenge_method=S256`.
3. **Token.** On the callback, check `state`, then POST `application/x-www-form-urlencoded` to `token_endpoint` with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id` and `code_verifier`. The response has `access_token`, `token_type`, `expires_in` (3600 s), `scope`, `patient`, and `refresh_token` if `offline_access` or `online_access` was granted.
4. **Find studies and reports.**
   - `GET <imaging base>/ImagingStudy?patient=<patient>&_include=ImagingStudy:endpoint`. Resolve each `ImagingStudy.endpoint` within the Bundle: it may be a contained `#id`, an included `Endpoint/…`, or a `urn:uuid:` entry, and the client must handle all three. Use `Endpoint.address` as the WADO-RS base.
   - `GET <clinical base>/DiagnosticReport?patient=<patient>` (or with `category=RAD` for radiology only; the slide's report is `SP`). Reports link to studies through `imagingStudy` (reference and Study Instance UID). Fetch `presentedForm[].url` with the token.
5. **Retrieve.** `GET <address>/studies/<uid>/series/<uid>` (or the whole study) with the same Bearer token and an `Accept` that names transfer syntaxes and ends with `transfer-syntax=*` (see [WADO-RS details](#wado-rs-details)), for example lossless SV1 and JPEG 2000 first with `*` as the fallback.

`test/client.ts` does these steps using only `fetch` and WebCrypto, and the e2e test runs it in Chromium. The Share app can copy it.

Step 2 is a top-level navigation and needs no CORS. Steps 1 and 3 to 5 are cross-origin `fetch`es, which `ALLOWED_ORIGINS` permits.

## Configuration

All settings are environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3334` | listening port |
| `HOST` | `0.0.0.0` | listening address |
| `BASE_URL` | `http://localhost:$PORT` | public origin (and optional path prefix) used in every returned URL, and in the MRN and accession identifier systems |
| `ALLOWED_ORIGINS` | `*` | CORS: `*`, or a comma-separated list of origins such as `https://share.example.org,http://localhost:3000`. With a list, the server echoes `Origin` only if listed and sends `Vary: Origin`. No cookies are used, so `*` is safe for a public sandbox; a list stops other sites' scripts from using it. |
| `SHARE_REDIRECT_URIS` | `http://localhost:3000/share/smart-callback,http://127.0.0.1:3000/share/smart-callback` | redirect URIs registered for `client_id=shlink-dicom-share` (exact match) |
| `CLIENTS_JSON` | (unset) | replaces the client registrations: `[{"client_id":"…","name":"…","redirect_uris":["…"]}]` |
| `OPEN_CLIENTS` | `true` | also accept any unregistered `client_id` whose `redirect_uri` is `https:`, or `http:` on localhost. Set `false` to allow only registered clients. |
| `ENDPOINT_MODE` | `external` | how search results carry the WADO-RS Endpoint: `external` (one shared `Endpoint/wado-rs`, returned with `_include`), `contained` (`#wado` in each ImagingStudy), or `capability` (one capability URL per study, as a `urn:uuid:` Bundle entry, always included) |
| `ACCESS_TOKEN_TTL` | `3600` | access token lifetime, seconds |
| `REFRESH_TOKEN_TTL` | `2592000` | refresh token lifetime, seconds (30 days) |
| `CAPABILITY_TTL` | `900` | capability URL lifetime, seconds |
| `INTROSPECTION_KEY` | random at startup | credential for `/auth/introspect`, sent as `Authorization: Bearer <key>` or as the password in HTTP Basic |
| `DATASET_DIR` | `build/dataset` | output of `scripts/build-data.ts` |
| `VARIANTS_DIR` | `build/variants` | the lossless compressed copies used for transfer syntax negotiation; copies that don't match the current dataset file are ignored |
| `TEST_PATIENTS_FILE` | `data/test-patients.json` | synthetic patients without imaging |
| `LOG_REQUESTS` | `true` | log method, path, status and time; query strings are never logged and capability IDs are redacted |

Tokens, codes and capabilities are kept in memory, so a restart signs everyone out.

## Tests

```sh
bun scripts/build-data.ts && bun install
bun test/data-check.ts          # dataset: determinism, pixel data, headers, reports
bun test/e2e.ts                 # server: starts four sandboxes on ports 3341-3344 (app stand-in on 3350)
bun test/e2e.ts --base URL      # against a running sandbox
bun test/validate.ts            # HL7 FHIR validator against the IG package
```

**`test/data-check.ts`** builds the dataset twice and compares every file's hash. It extracts the pinned sources with the system `tar` and checks that, for all 271 instances:
- the Pixel Data element is byte-identical;
- the transfer syntax is unchanged;
- every other non-UID top-level element is byte-identical.

It also checks that:
- the new header values are set, and no original UID appears in any served file;
- each PDF passes `qpdf --check` and opens in PDF.js with the banner on every page;
- the PDF's text equals the text attachment.

**`test/e2e.ts`** first runs the whole flow in headless Chromium (`/usr/bin/chromium`, or set `CHROMIUM`) from a page on another origin:
- discovery, then sign-in and consent clicked as a person would;
- the PKCE token exchange;
- Patient, DiagnosticReport and the report PDF;
- the ImagingStudy search;
- WADO-RS retrieval of every series, with each instance compared to the built dataset.

It then covers:
- the three Endpoint forms, search parameters, refresh, introspection and token audience;
- report search, attachments and PDF text;
- transfer syntax negotiation: SV1-first and J2K-first preferences, `*` only, q weights and header order, a mixed study, the 406 cases, exact sizes, and pixel identity of the compressed parts;
- negative cases: no token, another patient's token, an unshared study, wrong scopes, expired and revoked tokens, grant-bound capabilities, PKCE and code replay;
- CORS.

Against a remote server it skips the checks that need special settings, and runs the introspection checks only if `INTROSPECTION_KEY` is set.

**`test/validate.ts`** runs the HL7 validator (`VALIDATOR_JAR`, Java 17+) with the IG's current `package.tgz`.

## Deploying

```sh
scripts/deploy.sh               # DEPLOY_HOST defaults to smart-imaging-sandbox.exe.xyz
```

The script:
1. builds the dataset locally, as a reference;
2. copies the code (no build output) to `~/imaging-sandbox` on the VM;
3. installs Bun 1.4.3 if needed;
4. rebuilds the dataset on the VM from the pinned GitHub sources, and fails unless its `SHA256SUMS` is identical to the local build;
5. writes `/etc/imaging-sandbox.env`: `PORT=8000`, `BASE_URL=https://smart-imaging-sandbox.exe.xyz`, `ALLOWED_ORIGINS`, and an `INTROSPECTION_KEY` generated once and kept across deploys;
6. installs and restarts the `imaging-sandbox` systemd unit, then checks it.

exe.dev's HTTPS proxy forwards `https://smart-imaging-sandbox.exe.xyz/` to port 8000 (`ssh exe.dev share show smart-imaging-sandbox`). The VM is **private**: the proxy asks for an exe.dev login. Publishing it (`ssh exe.dev share set-public smart-imaging-sandbox`) is Josh's call. Logs: `ssh smart-imaging-sandbox.exe.xyz journalctl -u imaging-sandbox -f`.

## Files

- `src/server.ts`: routing, CORS, and token checks for the resource servers
- `src/auth.ts`: the Authorization Server, and the sign-in and consent pages
- `src/fhir.ts`: the clinical and imaging FHIR servers, reports and discovery
- `src/wado.ts`: WADO-RS and capability URLs
- `src/data.ts`, `src/dicom.ts`, `src/tar.ts`: load the dataset and read DICOM
- `src/scopes.ts`: SMART scope parsing
- `scripts/build-data.ts`, `scripts/lib/`: the dataset build, header rewrite, report text and PDF writer
- `scripts/deploy.sh`: deployment to exe.dev
- `data/`: committed inputs for the build
- `test/`: the client, the tests and helpers
