# Sharing a Whole Imaging Study with a Link

Getting your medical imaging to another clinician still usually means carrying a CD, or logging into a patient portal that lets you view the pictures in a browser but gives you no way to download the original DICOM files [[CHECK: patient portals commonly expose a web viewer without a bulk DICOM download option]]. Even when a hospital supports DICOMweb, those endpoints sit behind provider logins rather than something a patient can hand to an outside specialist [[CHECK: provider DICOMweb endpoints are rarely patient-shareable across institutions]].

[SMART Health Links](https://docs.smarthealthit.org/smart-health-links/) already solve this for clinical summaries and lab results. A link or QR code carries a retrieval URL and a 256-bit key in its URL fragment; the browser fetches an encrypted FHIR Bundle and decrypts it locally, while the server never sees the key.

I wanted the same model for full diagnostic imaging: every original DICOM file preserved byte for byte, viewable in a browser, without downloading a 400 MB archive before the first slice appears.

I wrote a [specification](https://github.com/jmandel/shlink-dicom/blob/main/PROPOSAL.md), a Rust and WebAssembly reference implementation, a [sharing app](https://shlink-dicom.exe.xyz/share), a [browser viewer](https://shlink-dicom.exe.xyz/view), an [interactive explainer](https://shlink-dicom.exe.xyz/how), and a [SMART Imaging Access sandbox portal](https://smart-imaging-sandbox.exe.xyz).

**[FIGURE F1] Cover image.** *A SMART Health Link QR code on a phone opens the encrypted brain MRI study in a browser viewer beside it.*

> **TL;DR:** Try the [sample study in the viewer](https://shlink-dicom.exe.xyz/view), [share your own imaging](https://shlink-dicom.exe.xyz/share) from files or our [SMART Imaging sandbox](https://smart-imaging-sandbox.exe.xyz), explore [how the protocol works on live byte ranges](https://shlink-dicom.exe.xyz/how), or read the [specification](https://github.com/jmandel/shlink-dicom/blob/main/PROPOSAL.md) and [code on GitHub](https://github.com/jmandel/shlink-dicom).

Thanks to the authors of the [Argonaut SMART Imaging Access Implementation Guide](https://build.fhir.org/ig/argonautproject/smart-imaging/) and to the [NCI Imaging Data Commons](https://portal.imaging.datacommons.cancer.gov/) for the public clinical imaging archives we used to test decoder coverage.

**[SCREENSHOT S1]** *The landing page on desktop, with links to share imaging, open a sample study, or inspect how the protocol works.*

**[SCREENSHOT S2]** *The landing page on a phone.*

## One study, traced end to end

The public sample link carries "Josh Example"'s de-identified studies: a brain MRI, a contrast CT of the abdomen and pelvis, three hand and wrist X-ray studies, and a whole-slide pathology image [[VERIFY: 5 studies in my-health-data 911ee41 plus 1 CC BY slide, docs/COORDINATION.md]].

**[SCREENSHOT S3]** *The study overview in the viewer on desktop, listing the shared studies and their report summaries.*

**[SCREENSHOT S4]** *The study overview on a phone.*

When you open the link and pick the brain MRI, the browser runs six steps:

1. **Read the URL fragment.** The `#shlink:/...` fragment stays in the browser and holds the retrieval URL, the 32-byte link key, and mode flags.
2. **Fetch and decrypt the FHIR Bundle.** The viewer downloads `bundle.jwe` ([[MEASURE: exact bundle.jwe byte size on shlink-dicom.exe.xyz public sample, Playwright network capture]]) and decrypts it with AES-256-GCM and DEFLATE decompression.
3. **Read the ImagingStudy index.** The ImagingStudy resource names the study's encrypted file, carries that file's 32-byte key, and lists every series and DICOM instance in order with its byte length.
4. **Request the byte range for one slice.** To display the middle slice of the axial T2 series, the viewer maps the slice's byte offset to the 64 KiB encrypted records that cover it and sends a single HTTP `Range` request (`206 Partial Content`) for those records.
5. **Authenticate and decrypt the records.** WebCrypto verifies the 16-byte AES-GCM tag on each 64 KiB record using the file key and the record number as the nonce, then trims out the slice's DICOM bytes.
6. **Decode and draw the pixels.** A Web Worker decodes the DICOM frame in WebAssembly and hands the pixels to the WebGL2 renderer.

Opening the sample fetches [[MEASURE: bytes fetched to first image and first thumbnail strip vs total study size on shlink-dicom.exe.xyz, scripted Playwright + PerformanceResourceTiming run]] and draws the first image in [[MEASURE: median time to first image in ms across 3 runs in Chromium, scripted Playwright run]].

**[FIGURE F2] Request waterfall for opening the sample.** *The browser fetches the encrypted FHIR Bundle first, then requests only the 64 KiB records covering the visible slice.*

**[FIGURE F3] Bytes fetched versus study size.** *The viewer fetches only the bytes it draws.*

**[SCREENSHOT S5]** *The viewer on desktop showing a mid-brain axial T2 slice with the series strip alongside it.*

**[SCREENSHOT S6]** *The same brain MRI study on a phone, with the image above and the series strip below.*

## How the files are encrypted and found

A standard SMART Health Link works well when the payload is a few kilobytes of FHIR JSON, because the client downloads and decrypts the whole file at once. A CT or MRI study is tens or hundreds of megabytes, and a whole-slide pathology image is over a gigabyte. We keep the FHIR Bundle small and store each DICOM study as a sequence of fixed-size 64 KiB encrypted records alongside it:

- **One file per study, in 64 KiB records.** Every full record holds 65,520 bytes of concatenated DICOM files plus a 16-byte AES-256-GCM authentication tag, totaling 65,536 bytes on disk [[VERIFY: 65,520 B plaintext + 16 B tag = 65,536 B record, PROPOSAL.md §9.2]]. Each record uses its 0-based record index as the 96-bit nonce, so any record range can be fetched with an HTTP `Range` request and verified on its own.
- **A random 32-byte key per study.** Each study's file has its own random key, stored alongside its random 22-character file ID inside the ImagingStudy resource [[VERIFY: linked-file extension with id and key, PROPOSAL.md §8.1]]. A series added to a study later can go in a file of its own. When you create a second link that shares only one study from a multi-study share, the browser encrypts a new `bundle.jwe` carrying only that study's key, without re-encrypting or re-uploading any files.
- **The ImagingStudy resource is the byte-offset index.** Each instance entry carries its byte length, so summing earlier lengths gives the exact byte span of any slice [[VERIFY: length extension on series.instance, PROPOSAL.md §7.3]]. Listing 2,000 instances takes about 470 KB of FHIR JSON, which compresses to about 61 KB inside `bundle.jwe` [[VERIFY: 470 KB JSON / 61 KB deflated for 2,000 instances, docs/PROCESS-NOTES.md §2.10]].
- **An opaque host.** The host stores and serves `bundle.jwe` and the encrypted study files. It sees random file names, file sizes, 64 KiB-aligned byte ranges, request times, client addresses and the `recipient` string the client sends, but no names, UIDs or pixels.
- **No outer compression and no ZIP wrapper.** Compressing an entire file with DEFLATE or gzip would make byte offsets unpredictable and break random access; pixel compression already lives inside each DICOM file. A ZIP wrapper would only duplicate the directory and byte offsets that the ImagingStudy resource already carries.

**[FIGURE F4] How one slice is found and decrypted.** *An instance's cumulative byte offset in the ImagingStudy resource maps to the 64 KiB ciphertext records that cover it.*

**[FIGURE F5] What the host sees and what the browser sees.** *The host serves bytes it cannot read.*

**[SCREENSHOT S9]** *The "What the host sees" widget on the explainer page, showing the host's raw range log beside the browser's decrypted view.*

**[SCREENSHOT S10]** *The record map widget on the explainer page, showing the records and `Range` header for a chosen slice.*

**[SCREENSHOT S11]** *The tamper switch on the explainer page, where flipping one ciphertext bit causes AES-GCM authentication to reject the record.*

## Sharing

The [sharing flow](https://shlink-dicom.exe.xyz/share) accepts imaging from local files or a hospital CD (skipping Windows viewer executables and wrapping bare DICOM files in Part 10 headers [[VERIFY: eFilmLite non-DICOM filtering and Part 10 wrapping, docs/PROCESS-NOTES-pi.md §3]]), from an existing SMART Health Link, or from a SMART on FHIR imaging portal. For the portal flow we built a standalone sandbox following the [Argonaut SMART Imaging Access Implementation Guide](https://build.fhir.org/ig/argonautproject/smart-imaging/) [[VERIFY: sandbox implementation details, docs/PROCESS-NOTES.md §10]], and filed two issues on the draft guide ([#2](https://github.com/argonautproject/smart-imaging/issues/2) on missing token response fields and [#3](https://github.com/argonautproject/smart-imaging/issues/3) on transfer-syntax negotiation) [[VERIFY: 14 ambiguities and issues #2 and #3, docs/PROCESS-NOTES.md §10–11]].

The review step shows what is in each study with series thumbnails, slice counts, and sizes, and can insert a frame offset table into multi-frame slides that lack one [[VERIFY: pack-time Basic Offset Table insertion, docs/COORDINATION.md]]. You then pick which studies to include, set a label, an optional passcode, and an expiry up to 31 days [[VERIFY: 31-day max expiry, docs/PROCESS-NOTES.md §12]], and the browser encrypts and uploads one file per study.

**[SCREENSHOT S24]** *The passcode prompt on a phone when opening a passcode-protected link.*

At hand-over you receive the recipient's link and QR code, plus a management link that requires no account. The management link keeps your control token and owner key in its URL fragment (deriving per-link keys with HKDF so the host never stores them [[VERIFY: HKDF(ownerKey, linkId) for management link reconstruction, docs/PROCESS-NOTES.md §12]]), shows open counts, and lets you revoke or extend links or mint a new link for someone else.

**[FIGURE F6] The share flow.** *Files, portal studies, or an existing link are packed and encrypted in the browser; the host receives only ciphertext while the recipient gets the link and key.*

**[SCREENSHOT S12]** *Step 1 of the share flow on a phone: choosing a source.*

**[SCREENSHOT S13]** *Logging into the SMART Imaging Access sandbox portal on a phone.*

**[SCREENSHOT S14]** *Reviewing study cards and thumbnails before encrypting.*

**[SCREENSHOT S15]** *Encrypting study files in the browser and uploading ciphertext.*

**[SCREENSHOT S16]** *The hand-over screen with the recipient's QR code and the management link.*

**[SCREENSHOT S17]** *The accountless management page showing open counts and revocation controls.*

## Reports beside the images

In clinical systems, the imaging archive and the medical record are separate [[CHECK: PACS/VNA stores DICOM while the EHR/RIS stores the finalised radiology report]]. DICOM series rarely contain the radiology read; reports live in the EHR as FHIR DiagnosticReport resources.

Because a SMART Health Link carries a FHIR Bundle, it can hold DiagnosticReport resources alongside ImagingStudy resources. The viewer shows the report beside the images on desktop (or as a sheet on a phone), labels where each piece came from, and does not pretend they came from one source. For our de-identified sample studies, we wrote synthetic reports clearly marked as sample reports [[VERIFY: synthetic DiagnosticReports marked SAMPLE REPORT with LOINC 24590-2 and 37550-1, docs/PROCESS-NOTES.md §10 & docs/COORDINATION.md]].

**[FIGURE F7] Two sources, one view.** *DICOM series from the imaging system and DiagnosticReport resources from the clinical record travel together in one Bundle and render side by side.*

**[SCREENSHOT S7]** *The desktop viewer showing an abdominal CT slice beside its DiagnosticReport.*

**[SCREENSHOT S8]** *The same report opened as a sheet on a phone.*

## Decoding everything in the browser

Clinical scanners write pixels in many formats: uncompressed integers and floats, RLE, JPEG (8-bit, 12-bit, lossless, progressive, arithmetic, and hierarchical), JPEG-LS, JPEG 2000 (Part 1 and Part 2), HTJ2K, and JPEG XL [[VERIFY: codec list in codecs/ and docs/COVERAGE-PLAN.md]]. Rather than compiling C libraries to WebAssembly, we built a pure-Rust decoder suite that compiles directly to WebAssembly [[VERIFY: codecs/shl-dicom-decode architecture, docs/PROCESS-NOTES.md §4]].

To know the decoders were right, we built an oracle-first test corpus (`codec-corpus/`) before writing codec code:

- **Independent reference decoders.** Every test file is checked against multiple independent reference implementations (pydicom with libjpeg, OpenJPEG, GDCM, and CharLS, plus DCMTK, OpenJPEG, and OpenJPH command-line tools [[VERIFY: reference decoder families in codec-corpus, docs/PROCESS-NOTES.md §4]]). For lossless encodings of our own synthetic seed images, the seed pixels are the truth.
- **Written rulings where references disagree.** Across the 935 cases in the corpus [[VERIFY: 935/935 corpus cases passing, docs/PROCESS-NOTES.md §12]] ([[VERIFY: final corpus case count after coverage round, check.py report]]), we found bugs in the reference tools themselves, including pydicom applying Planar Configuration to JPEG output where the standard says it does not apply, OpenJPEG and pydicom double-converting subsampled JPEG 2000 slides into magenta images, and 16-bit lossless JPEG files with the Cornell encoder bug [[VERIFY: pydicom PlanarConfiguration, OpenJPEG sYCC double conversion, and Cornell bug rulings, docs/PROCESS-NOTES.md §6]]. Each disagreement is recorded with a written ruling and checked against a repaired copy.
- **A stratified sweep of the NCI Imaging Data Commons.** After querying 58,784,975 instances in IDC's BigQuery table [[VERIFY: 58,784,975 instances / 11.9 GB scanned in IDC BigQuery, docs/PROCESS-NOTES.md §5]], we tested 9,537 instances chosen to cover rare combinations across 118 manufacturers, 425 scanner models, 17 toolkits, and 25 SOP classes, alongside a random control [[VERIFY: 9,537 instances, 118 manufacturers, 425 models, 17 toolkits, 25 SOP classes, docs/OUTLINE.md §7 & docs/PROCESS-NOTES.md §11]]:
  - **Random control:** 1,000 of 1,000 randomly chosen clinical files passed (95% confidence interval: 99.62% to 100%) [[VERIFY: 1,000/1,000 random control and 99.62–100% CI, docs/blog/OUTLINE.md §7]].
  - **All 9,537 stratified instances:** 99.84% passed [[VERIFY: 99.84% of 9,537 instances, docs/blog/OUTLINE.md §7]]. The remaining 0.16% were files missing the required Planar Configuration tag (which our decoder now infers from pixel smoothness), minor chroma rounding on Leica 4:2:2 slides, floating-point pixel data (now supported), and empty zero-byte frames [[VERIFY: four non-passing buckets and smoothness inference on 8 real IDC files, docs/PROCESS-NOTES.md §11–12 & docs/COORDINATION.md]].

We timed our WebAssembly and native decoders against the reference C libraries run both natively and in WebAssembly (`codecs/bench/`), verifying every output against the oracle. WebAssembly SIMD made our JPEG decoder 5.6× faster natively while staying bit-identical to libjpeg across all 2,806 corpus frames [[VERIFY: 5.6× JPEG SIMD speedup and 2,806 frames bit-identical, docs/PROCESS-NOTES.md §7]]; porting HT block decoding into our JPEG 2000 pipeline brought a 2048×2048 lossless HTJ2K frame from 458 ms down to 71 ms in WebAssembly (2 to 3× faster than OpenJPH natively) [[VERIFY: HTJ2K 2048² 458ms -> 71ms wasm / 41ms native / 2–3× OpenJPH, docs/PROCESS-NOTES.md §12]]; and switching AES-GCM decryption from WebAssembly to WebCrypto raised throughput from about 50 MB/s to about 800 MB/s [[VERIFY: ~800 MB/s WebCrypto vs ~50 MB/s wasm AES, docs/PROCESS-NOTES.md §11]]. [[MEASURE: final quiet-machine benchmark ratios across all formats for Figure F10, codecs/bench/ rerun]].

For whole-slide pathology images, the viewer maps each visible viewport tile through the offset table to its 64 KiB records and fetches only the tiles on screen. Panning and zooming to full resolution on a 1,206 MB lung slide fetches 13.8 MB (1.15%), compared with 379 MB to reach the first full-resolution screen without an offset table [[VERIFY: 13.8 MB of 1,206 MB (1.15%) vs 379 MB without offset tables, docs/blog/OUTLINE.md §7 Figure F11]].

**[FIGURE F8] Corpus coverage by format.** *Passing and refused cases per transfer syntax in `codec-corpus`, with the count of reference decoders used for each format.*

**[FIGURE F9] The IDC sweep.** *The sweep picked rare combinations on purpose; the random control shows the typical case.*

**[FIGURE F10] Decode speed versus the C libraries.** *Decode time per megapixel in WebAssembly and native builds compared with the reference C libraries.*

**[FIGURE F11] A slide, streamed.** *Panning and zooming to full resolution on a 1.2 GB pathology slide fetches 13.8 MB (1.15%) of the encrypted file.*

**[SCREENSHOT S18]** *The whole-slide viewer at full resolution on desktop with the live streaming stats panel.*

**[SCREENSHOT S19]** *The whole-slide viewer on a phone.*

**[SCREENSHOT S20]** *The codec coverage section on the explainer page.*

**[SCREENSHOT S21]** *The benchmark report page.*

**[SCREENSHOT S25]** *The viewer rendering a non-image object type from the coverage work.*

## Sample data

The sample set is my own brain MRI, abdominal CT, and hand and wrist X-rays, de-identified as "Josh Example" and published in [`jmandel/my-health-data`](https://github.com/jmandel/my-health-data/tree/master/imaging), plus a CC BY lung slide from IDC [[VERIFY: 5 studies de-identified as Josh Example in jmandel/my-health-data 911ee41 plus CC BY IDC slide, docs/COORDINATION.md]]. Rather than dropping series that showed identity in the pixels (a radiation dose report, viewer captures, and a scanned document), we rebuilt those screens with synthetic "Josh Example" data so the sample behaves like a real hospital export [[VERIFY: synthetic rebuild of dose screens, viewer captures, and scanned documents, docs/COORDINATION.md & docs/blog/OUTLINE.md §8]].

**[SCREENSHOT S22]** *The `imaging/` folder in `jmandel/my-health-data` on GitHub.*

**[SCREENSHOT S23]** *The sandbox portal's patient picker showing Josh Example.*

## Caveats

- **Three formats are refused by design.** We refuse JPIP referenced transfer syntaxes (which hold a URL to an external server rather than pixels), Hologic private tomosynthesis slices (undocumented, though the standard centre slice is shown), and undocumented vendor compression in private tags, each with a message naming the format (`docs/COVERAGE-PLAN.md`) [[VERIFY: three refused categories in docs/COVERAGE-PLAN.md]].
- **Demo servers, not a product.** The hosted servers are demos with storage quotas and expiry limits.
- **Security model.** Holding a direct link grants access until it expires or is revoked. Passcode links enforce a limit of 5 failed attempts on the server before permanent revocation [[VERIFY: 5-attempt lifetime passcode counter, PROPOSAL.md §8.2 & docs/storage.md]].

## Building it with Claude Code

This project used two AI coding harnesses in the same repository: a Claude Code coordinator session running Claude Opus 5.5 that designed the architecture, dispatched Claude Opus 5.5 subagents, and verified every deliverable, and a `pi` CLI agent running `google/gemini-4-argon` in a `tmux` pane.

My messages fell into [[MEASURE: number of sittings, transcript]] sittings. I sent [[MEASURE: total messages sent by Josh across Claude Code + pi, session logs]] messages with [[MEASURE: Josh's word count across Claude Code + pi, session logs]] words of my own. Assuming I read 575 to 1,000 words a minute and wrote 120 to 200 words a minute, that took about [[MEASURE: estimated hours of Josh's reading and writing attention, session logs]] of my attention, while the agents worked for [[MEASURE: total agent wall-clock hours including time away, session logs]] in total, including time while I was away.

**[FIGURE F12] Hours.** *Total agent-working hours, split into my active attention and hours while I was away.*

**[FIGURE F13] Words, as areas.** *Squares with area proportional to my words, the agents' words, and tool output read.*

- **The Claude subagents (21 agents across the codec, app, and coverage waves [[VERIFY: exact subagent count from docs/COORDINATION.md]]).** Each subagent owned a separate directory (`codec-corpus/AGENTS.md` and `docs/COORDINATION.md`) so parallel workers never touched the same files: foundation parsing, RLE, JPEG, JPEG-LS, JPEG 2000 and HTJ2K, prevalence census, IDC sampling, quirk hunting, the BigQuery long-tail sweep, benchmarks, decryption spikes, the WebGL2 renderer and Worker pool, the SMART Imaging sandbox, the three web experiences, whole-slide streaming, and the coverage round.
- **The `pi` agent ($19.81 of a $32 cap [[VERIFY: $19.81 of $32 cap, docs/COORDINATION.md]]).** The `pi` agent, running `google/gemini-4-argon`, co-authored `PLAN.md`, built the first end-to-end Rust core, SQLite server, WebAssembly bindings, and web viewer, wired `shl-dicom-decode` beneath a 24-slice decoded frame cache for sub-millisecond window/level updates, and worked through five UX review rounds (`docs/ux-review-1..5.md`) steered by the coordinator over `tmux` (`docs/PROCESS-NOTES-pi.md`). It hit trouble in two places: rewriting all 960 lines of `web/main.ts` in single tool calls triggered repeated upstream idle timeouts until the coordinator compacted its context and nudged it to split the code into small modules under 150 lines, and wiring a local `~/Downloads` performance test into the server's default demo seed exposed real patient metadata on localhost until the coordinator's first UX review caught it.
- **The coordinator.** The main Claude Code session built the `codec-corpus/` oracle and `docs/storage.md`, ran a 10-minute `tmux` watcher on `pi`, re-ran `check.py` and headless Chromium scripts itself before accepting any subagent's report, maintained `docs/COORDINATION.md` across context compactions, and made all commits.

**[FIGURE F14] Agent timeline.** *Swimlanes showing when the coordinator, `pi`, and each subagent worked across the project.*

Across [[MEASURE: total commit count on main, git rev-list --count HEAD]] commits, the agents added [[MEASURE: lines added excluding vendored hayro/oxideav, generated cases.json/bench JSON, and lockfiles, git diff/loc script]] lines and deleted [[MEASURE: lines deleted with same exclusions, git diff/loc script]] lines (excluding vendored `hayro-jpeg2000` and `oxideav-jpeg2000` code, generated `cases.json` and benchmark JSON files, and lockfiles).

**[FIGURE F15] Lines added and deleted.** *Lines added and deleted by area, with vendored code, generated data, and lockfiles excluded.*

My role was to ask short questions that cut unnecessary layers and to check the results:

- **Steering by cutting:** Asking *"What's the zip buying us?"*, *"Why use HKDF at that point?"*, and *"Final record delimiter… why is that needed? Doesn't ending at that point also accomplish the same?"* stripped away the ZIP container, segments, series-key derivation, the Endpoint resource, and the delimiter byte [[VERIFY: quotes from docs/PROCESS-NOTES.md §2 & §3]]. Later instructions (*"Detect what we can in order to have the most robust behavior"*, *"keep our code clean and to the point"*, *"Rather than dropping data … create a synthetic equivalent"*, and *"come back at the proposal that addresses everything we plausibly can"*) drove the inference rules, the de-identification rebuild, and the full coverage plan [[VERIFY: quotes from docs/PROCESS-NOTES.md §4, §11 & docs/blog/OUTLINE.md §10]].
- **Problems I caught:** a benchmark table that compared our WebAssembly decoder in Chromium against C libraries run natively [[VERIFY: native vs browser C comparison catch, docs/PROCESS-NOTES.md §7]]; a 2 GB harness cap that had skipped 12 whole-slide images during the sweep [[VERIFY: 12 skipped whole-slide images caught by Josh, docs/PROCESS-NOTES.md §12]]; an early UI that forced users to tick 17 individual series checkboxes and crammed a multi-step share workflow into a sidebar [[VERIFY: series-picker and sidebar UX critique, docs/PROCESS-NOTES.md Addendum]]; and an overstatement that DICOM CDs must always be uncompressed (the rule binds only `STD-GEN-CD` / IHE PDI discs) [[VERIFY: STD-GEN-CD pushback, docs/PROCESS-NOTES.md §5]].

## Links

- **Live sites:** [Sample viewer](https://shlink-dicom.exe.xyz/view) · [Share your imaging](https://shlink-dicom.exe.xyz/share) · [How it works](https://shlink-dicom.exe.xyz/how) · [SMART Imaging sandbox](https://smart-imaging-sandbox.exe.xyz/)
- **Specification and code:** [`PROPOSAL.md`](https://github.com/jmandel/shlink-dicom/blob/main/PROPOSAL.md) · [`jmandel/shlink-dicom`](https://github.com/jmandel/shlink-dicom) · [`codec-corpus/`](https://github.com/jmandel/shlink-dicom/tree/main/codec-corpus)
- **Sample data:** [`jmandel/my-health-data/tree/master/imaging`](https://github.com/jmandel/my-health-data/tree/master/imaging)
- **Standards:** [Argonaut SMART Imaging Access IG](https://build.fhir.org/ig/argonautproject/smart-imaging/) ([Issue #2](https://github.com/argonautproject/smart-imaging/issues/2), [Issue #3](https://github.com/argonautproject/smart-imaging/issues/3))

