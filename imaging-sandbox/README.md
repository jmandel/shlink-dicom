# Imaging sandbox

A small server that plays every actor in the Argonaut [SMART Imaging Access](https://build.fhir.org/ig/argonautproject/smart-imaging/) IG, so the Share experience can connect to a "patient portal" and pull imaging the way it would from a real health system:

- an **Authorization Server** (SMART App Launch 2.x, standalone launch, public clients, PKCE S256, refresh tokens, token introspection and revocation), with a demo sign-in and consent page;
- a **Clinical FHIR Server** with `Patient`, `DiagnosticReport` and the reports' `Binary` attachments (PDF and plain text);
- an **Imaging FHIR Server** with `ImagingStudy` search and WADO-RS `Endpoint`s;
- a **DICOMweb server** for WADO-RS retrieval, which accepts the same access token.

All four run in one Bun process. The patient is fictional, **Morgan Rivera**; the images are real. They are Josh Mandel's published sample studies (a brain MRI and wrist radiographs from [jmandel/my-health-data](https://github.com/jmandel/my-health-data)), with the fictional identity written into their DICOM headers by a reproducible build. How each IG requirement is met is in [CONFORMANCE.md](CONFORMANCE.md).

Deployed (private for now) at **https://smart-imaging-sandbox.exe.xyz**: see [Deploying](#deploying).

## Running it

Requires Bun 1.4.3. The server has no runtime dependencies. The tests use `playwright-core` and `pdfjs-dist`, pinned in `package.json` (`bun install`).

```sh
cd imaging-sandbox
bun scripts/build-data.ts         # once: builds build/dataset/ (about 1 s; downloads the sources if needed)
bun src/server.ts                 # http://localhost:3334
```

On startup the server prints its URLs, the number of studies and instances it loaded, and the introspection key.

## The dataset

`scripts/build-data.ts` builds everything the server serves into `build/dataset/` (gitignored), using only committed inputs:

- **`data/studies.json`:**
  - the source archives, each pinned by commit URL and SHA-256 (a local copy with the right hash, in `build/sources/` or `../data/samples/`, is used instead of downloading);
  - each study's date, time, UTC offset and accession number;
  - the report content.
- **`data/patient.json`:** the fictional patient (name, birth date, MRN). The sources carry no sex, so none is set.
- **`data/test-patients.json`:** a synthetic second patient with no imaging, Robin Example, used to test a token for another patient.

### Header rewrite

The build rewrites these DICOM headers:

| Attribute | Value |
|---|---|
| PatientName, PatientID, PatientBirthDate | `RIVERA^MORGAN`, `SBX4417302`, `19790314` |
| StudyDate, StudyTime, ContentDate, ContentTime, AccessionNumber | from `data/studies.json`. The brain MRI keeps 29 Jul 2020 (from its description `BRAIN 7/29/20`). The wrist study uses 24 Jul 2011, the date in its Instance Creation Date. |
| Study, Series, SOP Instance, Frame of Reference and referenced instance UIDs | new UIDs under `2.25`, minted deterministically from `uidNamespace` and the original UID |
| Patient Identity Removed (0012,0062) | removed, since the headers now carry an identity |

The UIDs are replaced because the original files are public in my-health-data and seeded as the project's public sample share under their own UIDs. Keeping those UIDs would make two different patients claim the same instances.

What is left alone:
- **Pixel Data.** Its element is copied byte for byte, encapsulated JPEG fragments included.
- **Transfer syntaxes.** The brain MRI stays Explicit VR Little Endian and the wrist radiographs stay JPEG Baseline.
- **Everything else.** Every other element is copied verbatim; only changed elements, and the sequences and group lengths around them, are re-encoded.

The build stops if any of these checks fails, and `test/data-check.ts` checks them again against the sources.

### Reports

Each study gets one sample report, as a PDF and as plain text with the same content:
- **Structure:** patient, exam, date, equipment, technique listing the actual series from the headers, findings and impression.
- **Marking:** every PDF page carries **SAMPLE REPORT FOR DEMONSTRATION. NOT A CLINICAL INTERPRETATION.** at the top and bottom, and the text file starts and ends with it.
- **Content:** the indication, findings and impression are generic and labelled illustrative; the report says no one produced them by reading the images.
- **PDF format:** written by a small hand-made PDF writer (`scripts/lib/pdf.ts`). It passes `qpdf --check`, and PDF.js extracts the same text as the text file.

The output is deterministic: two builds give identical bytes. `build/dataset/SHA256SUMS` lists every file.

### Plain export for other consumers

The build also writes a plain copy of the rewritten studies to **`imaging-sandbox/out/`** (gitignored). The shlink-dicom server seeds its public sample share from there, so the viewer, the explainer and the portal all show the same fictional patient. The layout:

```
out/index.json                                   patient, studies (Study Instance UID, accession, date, report paths)
out/dicom/<study>/S<series number>-<description>/IM<instance number>-<uid tail>.dcm
out/reports/<study>.pdf, out/reports/<study>.txt
```

`<study>` is `mri-brain-2020` or `wrist-low-res`. The DICOM files are byte-identical to what WADO-RS serves, and the export is as deterministic as the dataset; `test/data-check.ts` checks both. `--export DIR` writes it elsewhere, and `--export none` skips it.

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

- **Response format.** Retrieval returns `multipart/related; type="application/dicom"`, one part per instance, each part being the served Part 10 file. Parts carry `Content-Type: application/dicom; transfer-syntax=<stored syntax>`, `Content-Length` and `Content-Location`.
- **Accept header.** It must name a transfer syntax:
  - `transfer-syntax=*` returns the stored bytes;
  - the stored syntax's UID also works: `1.2.840.10008.1.2.1` for the brain MRI, `1.2.840.10008.1.2.4.51` (JPEG Baseline) for the wrist radiographs;
  - with no `transfer-syntax` parameter, or with any other UID, the server answers `406` and a JSON body that says what to send. The server does not transcode.
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

- **Morgan Rivera** (`Patient/morgan-rivera`, born 1979-03-14, MRN SBX4417302) is fictional and owns both studies:
  - MRI Brain, 29 Jul 2020: 14 series, 263 images;
  - XR wrist, left, 3 views, 24 Jul 2011: 3 images.
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
   - `scope=launch/patient patient/Patient.rs patient/DiagnosticReport.rs patient/ImagingStudy.rs` (add `offline_access` for a refresh token);
   - `aud=<BASE_URL>/fhir`;
   - a random `state`;
   - `code_challenge` and `code_challenge_method=S256`.
3. **Token.** On the callback, check `state`, then POST `application/x-www-form-urlencoded` to `token_endpoint` with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id` and `code_verifier`. The response has `access_token`, `token_type`, `expires_in` (3600 s), `scope`, `patient`, and `refresh_token` if `offline_access` or `online_access` was granted.
4. **Find studies and reports.**
   - `GET <imaging base>/ImagingStudy?patient=<patient>&_include=ImagingStudy:endpoint`. Resolve each `ImagingStudy.endpoint` within the Bundle: it may be a contained `#id`, an included `Endpoint/…`, or a `urn:uuid:` entry, and the client must handle all three. Use `Endpoint.address` as the WADO-RS base.
   - `GET <clinical base>/DiagnosticReport?patient=<patient>&category=RAD`. Reports link to studies through `imagingStudy` (reference and Study Instance UID). Fetch `presentedForm[].url` with the token.
5. **Retrieve.** `GET <address>/studies/<uid>/series/<uid>` (or the whole study) with the same Bearer token and `Accept: multipart/related; type="application/dicom"; transfer-syntax=*`.

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

**`test/data-check.ts`** builds the dataset twice and compares every file's hash. It extracts the pinned sources with the system `tar` and checks that, for all 266 instances:
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
- negative cases: no token, another patient's token, an unshared study, wrong scopes, expired and revoked tokens, grant-bound capabilities, transfer-syntax negotiation, PKCE and code replay;
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
