# Three experiences: design draft 1

Status: draft for discussion with Josh, 15 Oct 2026. It replaces the single-page, three-tab demo with three experiences on one site, built so each can be split out later.

## Decisions so far (from Josh)

- **Audience:** all three experiences matter.
- **Site:** one site, three doors, structured so that **Share** and **How it works** can later be deployed as separate static GitHub Pages sites that talk to the server.
- **Hosting:** everything on an **exe.dev** VM first (the server needs SQLite). Static parts later point at it through a config flag or a runtime setting (`?api=` or a small `config.json`).
- **Sharer control:** **owner links**, with no accounts.
- **Recipient import:** **download only** for now: originals as a ZIP with a DICOMDIR.
- **Explainer:** driven by **live interactive widgets** running on a built-in **public sample SHLink**.
- **Sharer sources:** files, CD/ZIP folders, a link a provider gave you, **and a SMART on FHIR imaging source** (a DICOMweb-enabled portal). The sharer can show some technical flair (thumbnails, series counts, bytes), because this is a technology demo too.

## Shared core

All three experiences use the same modules:
- **link resolver:** U and manifest modes, passcode, `/cap` refresh;
- **record decrypt:** WebCrypto if the decrypt-perf spike confirms it is faster;
- **decoder worker pool:** `viewer-kit`;
- **WebGL2 renderer:** with the CPU fallback;
- **ImagingStudy index:** reads the Bundle;
- **packer:** browser-side packing and encryption, for the sharer only.

Each experience imports only what it needs, so it can ship as its own bundle.

## Routes

| Route | Experience | Static-deployable later? |
|---|---|---|
| `/` | Landing: three doors, with the sample link one tap away | yes |
| `/share` and `/share/manage#…` | Sharing: create shares, manage them | yes, talks to the API |
| `/view#shlink:/…` | Viewing: the recipient's viewer; also usable as an SHL viewer prefix | yes, needs only the host serving the link |
| `/how` | How it works: interactive explainer plus developer lab | yes, uses the public sample link |
| `/api/*`, `/shl/*`, `/cap/*` | Server | no (exe.dev) |

---

## 1. Share

**Job:** "I have imaging (a CD, a download, a portal or a provider's link). Someone needs to see it. I want to hand it over safely and keep control."

**Flow:** one step per screen, mobile first, with a step indicator. Technical details are present but secondary: shown small, in grey, or behind a disclosure.

1. **Add imaging.** Four large choices:
   - Choose files or a folder (DICOM files, a CD folder, ZIP or TGZ);
   - Connect to a patient portal (SMART on FHIR imaging);
   - Paste a link from my provider (an existing SHL);
   - Try with sample imaging.

   Files are read in the browser, and a live progress line shows what was found: "Found 2 studies · 17 series · 266 images · 47 MB".
2. **Review what you're sharing.** One card per study:
   - title and date in plain words ("Brain MRI · 29 Jul 2020");
   - a thumbnail strip of the series;
   - for flair, a small grey line: "14 series · 263 images · 41 MB · uncompressed".

   Every study can be included or left out.

   When some images are uncompressed (a CD, or a server that sent them as stored), a choice under the cards:
   - **Compress without loss (recommended)**, the default: JPEG Lossless, with the estimated size;
   - **Smaller files, slower**: JPEG 2000 Lossless, with the estimated size and time on this device (offered when the encoder supports it);
   - **Keep files exactly as they are**: the original files, byte for byte.

   The line above it says what compressing does: every pixel stays identical, the file bytes change.
3. **Who and for how long.**
   - Recipient label: "Dr. Patel, Neurology".
   - Expiry presets: 1 day, 1 week, 1 month, or "until I revoke it".
   - "Allow updates" toggle.
   - Optional passcode.
4. **Encrypt and upload.** Images being compressed are uploaded as they are done, in file order, so compressing and uploading overlap. The bar measures the images' bytes done, a known total ("Compressed and uploaded 60 MB of 246 MB · compressing 120 of 458 images without loss"); without compression it measures bytes sent ("Uploaded 24 MB of 86 MB"). Below it, the real work: "Encrypting 1 file on this device: 0 done · 380 of 1320 records uploaded", with the line "The server stores only scrambled data."
5. **Hand it over.**
   - A large QR code, Copy link, Share (Web Share API) and Email.
   - The owner link, given prominently: "Save this to manage or revoke later". Saved in this browser too.
6. **Manage** (`/share/manage#…`).
   - **The share's links,** each showing:
     - recipient and studies;
     - status ("Opened 2 times, last yesterday 3:12 pm");
     - the actions Revoke, Extend, Take offline and New link for someone else.
   - **The files:** byte for byte as added, or which images were compressed without loss (pixel-identical, not the same bytes).
   - **Activity.** A simple timeline, with a "Show technical log" disclosure for the raw range-request log.

**SMART on FHIR imaging source** (step 1, second option):
- The visitor picks an imaging-enabled FHIR server: for the demo, a sample or sandbox server.
- A SMART App Launch (standalone, patient scope) follows.
- The app lists `ImagingStudy` resources and fetches each series over DICOMweb WADO-RS, using the server's associated endpoint (the SMART Imaging Access pattern).
- It asks for JPEG Lossless first, then JPEG 2000 Lossless, then anything as stored (the SMART Imaging Access negotiation), and compresses what still arrives uncompressed.
- It then packs locally as with files.

Open question 1 below asks which server to use for the demo.

## 2. View

**Job:** "Someone sent me a link. Show me the right images fast, let me read the report, and let me get the originals."

**Entry:** `/view#shlink:/…`, also served as the bare viewer prefix. It shows no demo chrome.

1. **Opening.**
   - **If a passcode is required,** a single centred prompt: "Enter the passcode the sender gave you", with attempts left.
   - **Header line:** "Shared with you: Second opinion · from <label> · expires 22 Oct".
2. **Study overview** (the default; no picking series by series).
   - One card per study, with the report summary if a DiagnosticReport is present.
   - A tap opens the study in the viewer, starting on a sensible series: the first non-localizer series, or the largest axial one.
3. **The viewer.**
   - The image fills the screen, with the series strip along the bottom on phones and down the side on desktop.
   - **Gestures:** drag to scroll slices, two-finger drag for window/level, pinch to zoom, double-tap to reset.
   - **Window/level presets by modality:** CT gets Soft tissue, Lung, Bone and Brain; MR and X-ray get Auto.
   - **Optional:** side-by-side comparison of two series.
   - **Rendering:** the GPU renderer and worker pool from viewer-kit. Thumbnails use reduced-resolution decoding once it lands.
4. **Get the originals:** a "Download originals" sheet offering Study (ZIP with DICOMDIR), Series, or This image. It streams to disk.
5. **Trust and states.**
   - A small "Verified · encrypted end to end" badge, which opens a plain explanation (who shared it, when, integrity checked) and a "How this works" link to `/how`, pre-loaded with this link's structure but none of its private data.
   - Clean screens for expired, revoked, offline and too-many-attempts cases.

## 3. How it works

**Job:** "Show me how this works and convince me the claims hold, so I can evaluate it or implement it."

**Driven by the public sample link** built into the page: a published, non-sensitive study. Every widget runs on real data from that link.

Sections, each pairing a short text with a live widget:

1. **The link.** Paste or tap the sample, and see its payload decoded. The widget highlights `url`, `key`, `flag` and `label`, with notes on what each lets the holder do.
2. **The Bundle.** The decrypted FHIR JSON, collapsible, with `ImagingStudy.series` highlighted. Clicking an instance shows its byte offset in its study's file.
3. **The study file.** An interactive record map: drag a slider across instances, and see the byte range, the records covered, the HTTP `Range` header and the nonce. The real request fires, and the network panel below fills in.
4. **Decrypt and verify.** Shows a 64 KiB record being authenticated, plus the tamper switch: flip a bit in transit and see the record refused.
5. **What the host sees.** Two panes side by side: the host's log (random file names, byte ranges) and the browser's view (patient, study, pixels).
6. **Sharing and revocation.** A mini-sandbox: mint a subset link from the sample share, open it, revoke it, and watch the 404s happen. This replaces today's Share tab.
7. **Codecs and performance.** Coverage by transfer syntax (from the corpus check report), decode speed in this browser (a live micro-benchmark on the sample), and links to the full benchmark report.
8. **Build it.**
   - The spec (spec/README.md) and the reference code.
   - The test vectors.
   - A "receiver in 50 lines" snippet that resolves the sample link using only `fetch` and WebCrypto, runnable in the page.

## Landing (`/`)

- **One sentence:** what this is.
- **Three large doors:**
  - "Share your imaging": Share;
  - "Open a link you received": View, with the sample shown as "Try a sample";
  - "See how it works": How it works.
- **A two-device demo hint:** "Open this page on your phone and laptop: share from one, view on the other."

---

## Build plan (proposal)

1. **Core extraction.** Move the resolver, decrypt, the pool and the renderer into `web/core/`, and add the config flag for the API base URL and the viewer prefix.
2. **View first.** It is the simplest of the three, and adopting viewer-kit pays off here straight away.
3. **How it works.** It reuses View's components; the widgets run on the sample link.
4. **Share.** This is the biggest piece: packer UI, the manage page, and the SMART on FHIR source.
5. **Landing, deployment** to exe.dev (check Range and 206 through the exe proxy, CORS, `share set-public`), then splitting out the static parts.

Each step is checked with the scripted browser checks we already use: desktop and phone screenshots, touch emulation, and end-to-end flows.

## Decisions, round 2 (Josh, 15 Oct)

- **SMART on FHIR imaging source:** build our own sandbox following the Argonaut **SMART Imaging Access** IG (https://build.fhir.org/ig/argonautproject/smart-imaging/), hosted alongside the app on exe.dev:
  - discovery of the imaging endpoint through `.well-known/smart-configuration`;
  - a SMART App Launch authorization server with a demo patient login;
  - a clinical FHIR server (Patient, DiagnosticReport);
  - an Imaging FHIR server returning `ImagingStudy` with WADO-RS `Endpoint`s;
  - a DICOMweb WADO-RS server accepting the same access token, validated by introspection or a shared validator, backed by the sample studies.
- **Public sample link:** Josh's published MRI + wrist studies from `my-health-data`, with the real name shown (they are public by his choice).
- **Builders:** Claude subagents, coordinated and checked by scripted browser runs. pi stays available for small tasks.

## Open questions (resolved above)

1. **SMART on FHIR imaging source for the demo:** which FHIR and DICOMweb server? Options: a sandbox we run on the exe.dev VM (a small FHIR server with ImagingStudy plus DICOMweb backed by the sample studies), or an existing SMART Imaging Access reference server.
2. **The public sample link:** the Brain MRI + Wrist set from `my-health-data`, or a fully synthetic or de-identified study, so the explainer can show real names safely?
3. **Who builds it:** pi (about $12 of budget left), Claude subagents, or both split by experience.
