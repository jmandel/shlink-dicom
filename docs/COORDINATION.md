# Coordination state (coordinator's working file)

Last updated 15 Oct 2026, about 18:45. This is the coordinator's source of truth for what is in flight, what is decided, and what comes next. **Read this first after a context compaction.** Update it whenever an agent finishes, a decision is made, or the queue changes.

Related docs:
- `docs/EXPERIENCES.md`: the product design for the three experiences, with Josh's decisions.
- `docs/PROCESS-NOTES.md`: the blog journal; keep appending to it. pi's independent version is `docs/PROCESS-NOTES-pi.md`.
- `codec-corpus/AGENTS.md` and `CONTRACT.md`: rules for the codec work.
- `docs/storage.md`: the server's SQLite design.
- `docs/ux-review-*.md`: past UX rounds.

## Standing rules

- **No legacy code (Josh, 15 Oct):** greenfield repo. Delete superseded pages, shims and prototypes outright, together with their routes, checks and docs.

- **Commit with a pathspec on the commit itself** (`git commit -m … -- <paths>`), never `git add <paths>` then a bare `git commit`: a bare commit takes everything staged, including other agents' `git mv`/`git rm` (2a7f37f, and bc0d95f, which broke a deploy and was fixed by b29a072). Subagents must not touch the index at all.
- **One owner per area.** Each subagent owns specific directories. Shared files belong to the coordinator unless a brief says otherwise. **Subagents never commit; the coordinator commits** after verifying.
- **Verify, don't trust summaries.** Re-run check.py and the scripted Chromium checks, and look at the screenshots, before telling Josh something works.
- **Copy rules.** Plain, true, short; no hype words, no false contrasts, no filler. Fact-check claims.
- **Privacy.** Josh's `~/Downloads` DICOM exports (identified CT/CR) stay local-only: never committed, deployed, or used in demo defaults. The public sample is the my-health-data MRI + wrist; its DICOM headers are already anonymized (`Anonymized1`/`Anonymized2`).
- **Public or outward actions need Josh's OK first:** `exe.dev share set-public`, GitHub issues and comments, pushes.
- **Shared machine.** Many agents run benchmarks and fuzzers, so load is often 10–25. Timing claims need a quiet-machine rerun. `/tmp` is a RAM tmpfs; put large scratch data on `/media/barracuda` (about 990 GB free).

## Agents: in flight (resume with SendMessage to the id)

| Area | Agent id | Owns | Current task | When it reports |
|---|---|---|---|---|
| ~~How it works~~ DONE, committed | a0bd674282e6512f4 | `web/how/`; may add new files to `web/core/` | Live widgets on the sample link; 50-line receiver | Verify the screenshots in `docs/shots/how/` and the widgets; then commit |
| ~~Share~~ DONE, committed | ac9206ae1a4d9228a | `web/share/`; may make additive changes to `crates/shl-dicom-server` | Files/CD/ZIP, SMART portal through the sandbox, re-share, manage page | Verify the flows and `docs/shots/share/`; review the server changes; commit |
| Imaging sandbox (data, reports, rulings DONE; deploy BLOCKED) | ab83241fb7aa4e1f8 | `imaging-sandbox/` | Fictional patient rewritten into the DICOM (pixels untouched); scripted `build-data.ts` reproducible from git; DiagnosticReports with PDF and text, marked "SAMPLE REPORT"; Josh's rulings (aud array, grant-bound capabilities, `.s`/`.r`, **406 when transfer-syntax is omitted**, token_type and scope); deploy **private** to smart-imaging-sandbox.exe.xyz | Verify; commit the scripts and config (no DICOM); ask Josh before set-public |
| ~~JPEG 2000/HTJ2K speed round 2~~ DONE (HTJ2K 2–3× OpenJPH native; J2K 1.2× OpenJPEG) | aeb346615b443d8de | `codecs/shl-codec-jpeg2000/` (including the vendored hayro), `codecs/shl-codec-htj2k/` (including the vendored oxideav), `formats/{jpeg2000,htj2k}/` | Wavelet (5/3, 9/7) and HT block decoder speed; targets about 3× OpenJPH and about 1.2× OpenJPEG; exactness kept | Then tell the reduced-res agent to go ahead with JPEG 2000/HTJ2K scaled decode |
| ~~Foundation inference round~~ DONE (935/935 pass) | aac32c9d770084d05 | `codecs/shl-dicom-decode/`, `formats/uncompressed/` | Infer missing Planar Configuration (smoothness) and other safe inferences, each with a warning | Verify check.py and the ruling write-ups; commit |
| Whole-slide (SM) viewer (DONE: 9cf4a1f, offset tables + prune 7760d55) | adcc54c6231290ab4 | `web/view/` (core+View finished), additive `web/core/`, viewer-kit additions | Tiled deep-zoom viewer: pyramid from headers; tile→frame→byte via EOT/BOT/fragment walk; prototype a frame-offset Bundle extension (protocol decision for the coordinator and Josh); live streaming stats; `docs/wsi-sample.md` recommends a CC BY IDC slide for the public sample | Verify; decide the frame-offset extension with Josh; the sandbox agent adds the slide to the sample data |
| Long-tail IDC sweep | a364a12e7cfb7c05a | `codec-corpus/scripts/sources/` (new files), `codec-corpus/prevalence/`; temp files in `/media/barracuda/shlink-dicom-sweep/` | Rarity-weighted selection plus a random control of about 1,000; decode-verify-delete; failures registered as `idc-lt-*` cases. **Plus:** frame-wise verification of the 12 oversize whole-slide images (2.4–11.8 GB decoded; skipped by the 2 GB harness cap) | Triage its LONGTAIL.md: route failures to owners, record rulings (below) |

## Agents: finished, can be resumed

| Area | Agent id | Owns | Notes |
|---|---|---|---|
| Core + View | a3832d83abfd092fc | `web/` (core, view, landing, build), the server's static routes | 154 checks pass. Follow-ups are queued below. |
| Reduced-resolution decode (ACTIVE: JPEG 2000/HTJ2K scaled; also refreshing jpeg2000 FORMAT.md) | a21f481eac15d1f73 | `shl-codec-common` (scaled API), the JPEG scaled IDCT, `shl-dicom-decode` scaled entry, the wasm scaled export, the `viewer-kit` `scale` option | **Waiting for go-ahead** on JPEG 2000/HTJ2K scaled decode, once aeb346615b443d8de finishes. |
| viewer-kit (GPU renderer and worker pool) | a3d40f96a3198e243 | `viewer-kit/`, `codecs/shl-dicom-decode-wasm/` | The NVIDIA driver needs a reboot for real GPU numbers (Josh). |
| Decrypt spike | a7954095638a32d7f | `perf-spikes/decrypt/` | WebCrypto at about 800 MB/s against wasm AES at about 50 MB/s. Recommends decrypting inside the decoder workers. |
| Bench infrastructure | ac66737003639541f | `codecs/bench/`, `codecs/shl-dicom-wasm-bench/` | C-in-wasm comparisons, wasm-opt builds (not worth it), build lock, noisy-run warning. |
| Foundation (CLI) | aac32c9d770084d05 | `codecs/shl-dicom-decode/`, `formats/uncompressed/` | Parser and framing robustness, normalisation 3–13× faster. |
| JPEG codec (now with SIMD) | a8eb390f05eab14f2 (perf/SIMD); ae12eafa269b903ee (original) | `codecs/shl-codec-jpeg/` | Bit-identical to IJG; 5.6× faster. |
| JPEG-LS | ac0c699a5ce88f74e | `codecs/shl-codec-jpeg-ls/` | Greyscale at or faster than CharLS; RGB cine at about 1.25×. |
| RLE | a197474733c03ffd7 | `codecs/shl-codec-rle/` | Done. |
| J2K survey / J2K wrappers | afd2c99dbf1123087 / ab2cb98566e367faf | – | Done; hayro and oxideav were adopted and vendored with patches. |
| Census, prevalence, IDC sampler, quirk hunter | a43cf75d552ee7267, a1d533a1d600cda5e, abb14d7dea21afa6a, a78263dbe7927e376 | `prevalence/` docs | Done. |

## pi (the Gemini agent in tmux pane 0:0.0)

- **Status:** idle at $19.81 of its $32 cap. It has been told **not** to edit `web/`, `crates/shl-dicom-server`, `crates/shl-dicom-wasm` or `imaging-sandbox/` until further notice.
- **Watcher:** `~/.local/share/pi-watch/watch.sh`, polling every 10 minutes, with its log in the same directory. Run it in the background only while pi has a task.
- **History:** pi's session log is at `~/.pi/agent/sessions/--home-jmandel-hobby-shlink-dicom--/2026-10-14T20-16-22-993Z_*.jsonl`. Josh's messages to pi can be recovered there.

## Infrastructure

- **RESOLVED (15 Oct, about 10:40): exe.dev SSH failures were Los Angeles-host specific.**
  - Some lax VMs (gathergrid, request-my-ehi, ours) lost SSH and first-boot setup scripts; others in lax (kill-the-clipboard, fhir-snapshots) worked.
  - Josh ran `set-region dal`. Our SSH keys can't run `set-region`.
  - Both VMs were recreated in Dallas with `--setup-script`; SSH works and the setup scripts ran.
  - The sandbox is public and passes remote e2e 109/109.
  - The API token `shlink-deploy` is revoked.
  - History:
  - **What fails:** SSH into **every** exe.dev VM, after authentication. Ruled out as causes: both account keys, OpenSSH and paramiko clients, a VM restart. exe.dev's own HTTPS `/exec` API fails the same way: lobby→VM port 4722 "connection reset by peer", trace `2adfa3e5cd5596d6a6cd1d206435ec6e`. So it is on exe.dev's side.
  - **Workaround, committed 9cf4a1f:** `deploy/bootstrap-sandbox.sh` and `deploy/bootstrap-shlink-dicom.sh` build from a public git clone into /opt and need only curl. Run either from Josh's web terminal (`curl -fsSL https://raw.githubusercontent.com/jmandel/shlink-dicom/main/deploy/bootstrap-<x>.sh | bash`) or as a `new --setup-script`. Both pass end to end in the `ghcr.io/boldsoftware/exeuntu` container with a systemctl stub, and are pushed (0bbdee0). Waiting on Josh: run them in the web terminal, or allow recreating the VMs with `--setup-script`.
  - **Token:** a 2-day exe API token `shlink-deploy` (ssh to the two VMs only) is in `$CLAUDE_JOB_DIR/tmp/token`, not in the repo. Revoke it with `ssh exe.dev ssh-key remove shlink-deploy`.
- **Sandbox done:** Morgan Rivera (born 1979-03-14, MRN SBX4417302), new deterministic UIDs under 2.25 (the original UIDs are public), reports with LOINC 24590-2 and 37550-1 (PDF and text), 406 when transfer-syntax is omitted, grant-bound capabilities, aud list. e2e 124/124, data-check 24/24. Export at `imaging-sandbox/out/dicom/`.

- **exe.dev VMs (both **public** (proxy on port 8000); tagged `#health-skillz-mgmt`):**
  - `smart-imaging-sandbox.exe.xyz`, being deployed by the sandbox agent.
  - `shlink-dicom.exe.xyz`, not yet deployed.
  - Only one public port per VM. Use `ssh exe.dev share set-public <vm>` only with Josh's OK.
- **Local servers:** the shlink-dicom server is on localhost:3333; the sandbox runs on localhost:3334 with `cd imaging-sandbox && bun src/server.ts`.
- **GitHub issues opened on argonautproject/smart-imaging (Josh approved):** #2 (the token response example lacks token_type and scope) and #3 (transfer-syntax guidance: apps send `*`; servers may answer 406). Watch them for replies.
- **Tools installed:** binaryen (`~/.local/bin/wasm-opt`, version 133), wasm-tools, rustfilt, and the rustup stable toolchain with wasm32. The system cargo has no wasm32 target, so use `~/.cargo/bin/cargo +stable`.
- **Commits:** see git log; latest checkpoint after the inference round (three experiences, sandbox, scaled decode, JPEG-LS speed). docs/shots/ is gitignored, because check scripts regenerate it. Earlier checkpoint: 68e6b9a.

## Decisions made (Josh)

- **Structure:** three experiences on one site (`/`, `/share`, `/view#shlink:/`, `/how`). Later, split the sharing and explainer pages into separate static GitHub Pages sites, configured to talk to exe.dev with `config.json` or `?api=`.
- **Hosting and roles:** exe.dev for everything first; manage links with no accounts; download-only import; Claude subagents as builders.
- **SMART portal source:** our own sandbox per the Argonaut SMART Imaging IG, on its own origin. Reverse-proxying under subpaths is possible later.
- **Sandbox data:** a fictional named patient in both FHIR and the DICOM headers; reproducible from git; DiagnosticReports with PDF and text.
- **IG rulings:**
  - `aud` is internal; a token may carry several values;
  - existence is never revealed;
  - `.s` covers search and `.r` retrieval;
  - capabilities are bound to the grant;
  - an omitted transfer syntax gets 406 from the sandbox.
- **Not filing:** `payloadMimeType`.
- **The sample link shows Josh's published studies,** with the real name allowed, though the headers are already anonymized.

- **Frame offsets (Josh, 15 Oct): no Bundle extension.**
  - Our sample data carries Basic Offset Tables, written by the sandbox build (agent ab83241fb7aa4e1f8).
  - The packer gains an option to add offset tables to multi-frame files that lack them when a share is created. It covers the CLI, the seed and /share, and is built by agent adcc54c6231290ab4 in shl-dicom-core.
  - The viewer keeps its BOT/EOT/fragment-walk lookup.
- **Public sample:** the bootstrap packs every sandbox study (MRI, wrist, slide; 202 MB). The seed reads `samples/*.tgz` and `samples/sample.json` (9479156).

- **Reports (Josh, 15 Oct):**
  - DICOM usually comes from imaging systems without reports. Reports come from the clinical side as FHIR DiagnosticReports. The viewer shows them side by side with the images, and doesn't assume they came from the same place.
  - Shares and the public sample carry them in the Bundle.
  - Encapsulated PDF in DICOM is the secondary case: only one or two in the demo sample.
- **De-identification (Josh, 15 Oct):** never drop PHI-bearing content. Rebuild it as a synthetic equivalent with fake names (dose screens, scanned documents, viewer captures).

- **Study files and S3 (Josh, 15 Oct):** docs/STUDY-FILES-AND-S3-PLAN.md is approved.
  - **Format:** a hybrid `linked-file` (study default, optional per-series override; offsets per file) under the HL7 SMART Health Cards and Links canonical URLs, to be published in that IG.
  - **Reads:** proxy or redirect is a server setting for S3 (default proxy); the protocol is unchanged.
  - **Storage:** rusty-s3 + reqwest; refcounted blobs.
  - **Who:** pi (tmux session 1) wrote the plan. Part 1 is one new Claude agent once web/view is quiet; Part 2 is the Share agent after its current items; pi reviews Part 1 against the plan.

- **Compression and transfer syntax (Josh, 15 Oct evening).**
  - SMART Imaging Access: servers SHOULD be able to transcode to a lossless compressed transfer syntax. Document a proper negotiation: apps list preferred syntaxes in `Accept`, with `transfer-syntax=*` as the fallback everyone can handle. Clients then decide whether to re-encode what they get, or keep it large. Push this upstream (draft for Josh before anything is posted).
  - shlink-dicom's protocol doesn't change. Only the share page's packing defaults may: what it asks the SMART source for, and whether it re-encodes uncompressed images before encrypting.
  - Candidate encodings: those IHE PDI's DVD/USB options require readers to handle (JPEG Lossless SV1, JPEG 2000 lossless).
  - Upstream PR opened (Josh approved): argonautproject/smart-imaging#5 (transfer syntax negotiation; addresses #3; #4 was the same change from a fork, closed). Branch transfer-syntax-negotiation in the upstream repo (Josh has write access: use branches there, not forks), clone at /media/barracuda/upstream/smart-imaging. Add the measured ratios as a PR comment when they arrive.
  - The measurement agent (a18873dede250f0de) is gathering ratios and speed on the Josh Example studies. Then: the issue draft, the packing defaults, spec §11.1 (it still says HTJ2K/JPEG-LS), and whether the sandbox should serve precomputed compressed copies so the negotiation is exercised.

## Decisions pending (ask Josh)

- **spec §8, DiagnosticReport** (Share agent's suggestion, not yet written into the spec):
  - It refers to its ImagingStudy in the same Bundle via imagingStudy.reference (the entry fullUrl), and SHOULD also give identifier urn:dicom:uid.
  - presentedForm attachments are inline data; url must not point at the source system.
  - **Open:** large attachments as encrypted files, like series files?
- **F changes the server storage** (series files on disk under shares/{sid}/). Existing data dirs become unreadable, so deploys need a fresh data dir. There are no users yet.

- (none open)

Resolved 15 Oct:
- **Public sample link:** YES, seed it from the sandbox's rewritten dataset; the sandbox agent writes a plain export for this.
- **VMs:** both made **PUBLIC** (the proxy targets port 8000).
- **Robustness:** "detect what we can for the most robust behaviour". The foundation agent (aac32c9d770084d05) is implementing inferred Planar Configuration by smoothness, plus a survey of other safe "infer instead of refuse" cases, each with a warning and tests.

## Next-step queue (in order once their inputs exist)

- **16 Oct, about 11:00: performance phase 2 planned** ([PERF-PLAN.md](PERF-PLAN.md), 854ad43). T0 (measurement, stale PERF pages, regression check, small-HTJ2K wasm slowdown) went to the decoder agent a4b3a594727c938f4 on branch perf-t0; it does its quiet full run only once e2e-perf's timing matrices stop. T6 continues in a26e1d2aaf1165705. Next: T1/T3/T4 (decoder agent), T2 (encoder agent a5b9622823f9139f4); at most two benchmarking agents at once.

- **16 Oct, about 10:45: three branches landed and deployed (f522017).**
  - **decoder-perf (a4b3a594727c938f4), 12 commits, byte-identical:** SV1 −25–30%, J2K lossless about −20%, J2K lossy 6–9% faster natively, RLE, Bits Stored masking. Small HTJ2K frames are 3–7% slower in wasm. **Follow-up:** htj2k/PERF.md (broken SCALED table) and the jpeg-dct/PERF.md lossless rows are stale.
  - **jxl-primaries (a26e1d2aaf1165705):** wide-gamut XYB output in the image's own primaries with Bradford adaptation, and the HLG inverse OOTF fix. Gap 2 (ICC-tagged lossy decoding to linear sRGB) stays documented.
  - **how-hex-align (a0bd674282e6512f4):** step 8's bytes aligned column by column; phone overflow from an unwrappable UID fixed. how/checks.mjs: 279/279 on the live site.
  - **Removed:** the dperf, jxlprim and howhex worktrees and branches. /media/barracuda/dperf (45 GB build cache) can be deleted when nothing needs it.
  - **Lesson:** the merge script joined test and push with `;`, so a test run killed by its timeout still pushed. The release-mode re-run passed afterwards. Merge scripts gate the push with `&&` on a test exit status.
  - **Still open:** the JPEG XL speed spike (jxl-simd-spike, ../shlink-dicom-jxlspike), e2e-perf (a4397313d3a700665), codec-simd-spike decisions (Josh), the tracked `web/checks/objects/__pycache__/*.pyc`.

- **16 Oct, early: all decoders become ours (Josh).** The JPEG 2000/HTJ2K decoder is ours (c3ed9a2). A new agent (a26e1d2aaf1165705) is writing our own JPEG XL decoder on branch jxl-decoder (../shlink-dicom-jxl), staged Modular, then VarDCT, then JPEG recompression/brotli, then delete jxl-oxide, against the libjxl conformance oracles. The decoder agent (a4b3a594727c938f4) is doing a decoder performance round on branch decoder-perf. The LinkedIn sentence on patched crates must be fixed after the 9 am ET publish (scheduled articles can't be edited).

- **15 Oct, about 21:50: the LinkedIn article is SCHEDULED** for Fri 16 Oct, 8:00 am CDT (9:00 am ET), Post to Anyone, with the post message from $CLAUDE_JOB_DIR/tmp/post-message.txt (Josh's opener; no links; 1.5 MB of 313 MB). The draft was verified identical to the blog md (44 blocks, 40 links, 8 images). Known stale item: shot-viewer.png predates the thumbnail fix (empty DWI/ADC tiles); Josh said not to chase every screenshot. Josh can change or cancel it via LinkedIn's "View scheduled articles".

- **Josh (15 Oct, about 21:00): schedule the LinkedIn article for Fri 16 Oct, 9:00 am ET,** once the compressed web app is deployed and tested. Steps:
  1. Merge pack-compress and how-compressed, deploy, and verify live.
  2. The visuals agent re-measures and retakes everything (sample size, trace, bytes to the first slice, footnotes 1 and 3, How caption and screenshot, owner page).
  3. Apply edits 2 and 4 plus the numbers to the blog md, then rebuild LinkedIn and verify it.
  4. Update the post message's numbers (Josh's opener version, no links).
  5. Schedule in LinkedIn's publish flow with that post message.
  6. Tell Josh the final text and how to reschedule.
  If anything isn't verified, don't schedule; tell Josh.

- **15 Oct, about 19:30: lossless compression round (Josh: update the reference implementations, then re-measure and update the blog and LinkedIn).**
  - **Decoders agent (a4b3a594727c938f4):** JPEG Lossless SV1 encoder plus a Part 10 transcoder with a mandatory bit-exact self-check; native and wasm. Branch `sv1-encoder`, worktree ../shlink-dicom-sv1.
  - **Sandbox agent (ab83241fb7aa4e1f8):** WADO-RS negotiation per PR #5, with stored SV1/J2K copies made by dcmtk/OpenJPEG. Branch `sandbox-negotiation`, worktree ../shlink-dicom-sandbox.
  - **Share agent (ac9206ae1a4d9228a):**
    - an Accept preference list;
    - in-browser re-encoding by default, with a "Keep files exactly as they are" option;
    - the seed packs the sample compressed;
    - spec §11.1;
    - copy honesty: "pixel-identical" vs "byte for byte".
    - Branch `pack-compress`, worktree ../shlink-dicom-pack. It integrates the encoder when that reports.
  - **Decisions made in this round:**
    - No Bundle extension marks re-encoded files. A re-encoded file instead carries shlink-dicom's Implementation Class UID and Version Name in its file meta (PS3.10).
    - Recipient Downloads copy reads "The DICOM files in this share". "Byte for byte" appears only where it's true.
    - Transcoder API: crate codecs/shl-dicom-transcode (and -wasm), `transcode_part10_sv1`, deterministic output, a mandatory self-check. Implicit VR LE input is required, because the sample's CT and CR use it.
  - **Codec decision (Josh, after the measurement):** SV1 is the default; JPEG 2000 Lossless is a share-page option ('Smaller files, slower'), via OpenJPEG wasm plus our Rust `wrap_part10_encapsulated` with the self-check. Seed stays SV1. Measured on 733 images: SV1 2.46×, J2K 2.96×, JPEG-LS 2.98×, HTJ2K 2.80×, Deflate 1.82×. The 555 MB sample is 403 MB of uncompressed studies plus the 152 MB slide (already JPEG). Results in /media/barracuda/compress-study/results/; numbers posted on smart-imaging PR #5.
  - **Update (Josh): no OpenJPEG.** We write our own lossless JPEG 2000 encoder in Rust after SV1; one entry point, `transcode_part10(input, tsUid)`. The share UI's J2K choice waits for it. Sandbox negotiation is merged (a9c6861) and deployed: the VM built 1,470 copies with dcmtk 3.6.7 and OpenJPEG, and the live e2e passes 153/153 (run with VARIANTS_DIR=/media/barracuda/sbx-variants).
  - **Measurement agent (a18873dede250f0de):** ratios and speeds for SV1, JPEG-LS, J2K, HTJ2K and Deflate on the Josh Example studies.
  - **After merge and deploy:** the visuals agent re-measures everything numeric in the post. Sample size, file and record counts, the link-to-pixels trace, bytes to the first slice, footnotes 1 and 3, and the owner page's "30 MB stored" all change. Also every "byte for byte" claim in the post and on the site. Then sync LinkedIn and update the post message. Add the measured ratios as a comment on smart-imaging PR #5.

- **15 Oct, about 18:45: everything landed on main and deployed (3671bd5).**
  - Study files (d3c8a1b), the display pipeline and LUT fix (fef0a72), pan/Reset (bc0d95f, b29a072), the plain-page How (3b5969c), S3 blob store with review fixes (d5664ff; the public server stays on local disk; the one-time wipe ran), and the phone layout with study times (3671bd5).
  - No branches are left; the study-files and s3-store worktrees are removed.
  - The blog md and the LinkedIn draft are synced and verified (43 blocks, 39 links, 8 images). The section is "How I built it", with 42 subagents.
  - Open: the viewer agent's older queue (thumbnail loading indicator, isLocalizer page error, slide ZIP mismatch in the live download matrix, progress bar going backwards, dark-flow click timeout, dark-mode audit). Ask it for status before calling the demo done.

- **15 Oct, about 15:45:**
  - **Part 1 (ad12646f03ce41389)** is done on `study-files` (4 commits on 8fea40f). A fresh review (ae70a73f51f694415) found nothing blocking; the 12 should-fix and nit items went back to ad12646f03ce41389. **Then:** push `study-files` to main, deploy, and have the viewer agent rebase its uncommitted web/core work onto it (heads-up sent).
  - **Viewer agent (a3832d83abfd092fc):** after its slide gate, the X-ray display bug Josh found (Hand OBLI shows white). The cause: readLut only corrects LUT data wider than the descriptor; NK5 says 16 bits but holds 12-bit data. Thumbnail paths also skip the header (view.ts:304, share.ts:544). **Josh: no spot fix.** One display pipeline for every pixel path, a LUT bit-depth rule for both directions with citations, and a conformance check against dcmtk and pydicom over the corpus, the IDC LUT/MONOCHROME1 files and synthetic edge cases, plus a check that thumbnails match the main view.
  - **Visuals agent (ad67bc6fa7abc2a00):** Josh says to align the blog and every visual with one file per study now. Redo link-to-pixels (and check architecture) from the branch's numbers; after the deploy, retake shot-how and any format-specific shots and re-measure the post's numbers (6 files, the bytes to the first slice, footnote 1). The coordinator then updates the post text (the "work is under way" sentence, footnote 7) and syncs LinkedIn.
  - **Blog/LinkedIn:** "What went wrong" was cut, and the next-steps paragraph reworded per Josh, in both the blog md and LinkedIn (verified after a reload). Leave the LinkedIn draft alone while Josh reviews it; compare it with the md before each sync.

- **15 Oct, about 14:40:**
  - **pi:** Josh stopped the newer pi session (tmux session 1), because Gemini Argon isn't routing reliably. Part 1's review against the plan now goes to a fresh Claude agent.
  - **Share agent:** Part 2 prep is done (MinIO in container shl-minio, /media/barracuda/s3-prep). Now it adds the stable `/sample` link and the /view "Open the sample" button.
  - **Blog:** the Claude writer is editing the argon one-shot draft (/tmp/article-arogn.html → /tmp/article-argon-edit.html): trim "what went wrong", shorten codecs, verify and measure, real links, pi described in one plain line.

- **15 Oct evening: study-file Part 1 started** (agent ad12646f03ce41389).
  - **Now:** the spec, the reference vector, core parsing, web/core and How.
  - **Where:** the whole of Part 1 now happens on branch `study-files` in the worktree ../shlink-dicom-study-files, which keeps main building for the other agents. The agent rebases on main when main is quiet, and the coordinator merges.
  - **Deviation from the plan:** SeriesEntry gains `id` (fileId@offset), replacing fileId as the series identity in caches and layers.
  - **Then:** Part 2 (BlobStore/S3) goes to the Share agent, and pi (tmux session 1) reviews Part 1 against the plan.
  - **Blog:** outline v2 committed (40bee86); the Codex header is being regenerated.

- **15 Oct, about 12:10: coverage plan round 1 launched** (docs/COVERAGE-PLAN.md).
  - **A, decoders:** new agent a4b3a594727c938f4. Owns codecs/, codec-corpus/, viewer-kit/INTEGRATION.md.
  - **B+C, objects and display:** Core+View agent a3832d83abfd092fc. Owns web/view (non-WSI) and web/core (non-wsi, non-video).
  - **D, slides:** adcc54c6231290ab4. Owns web/core/wsi*, web/view/wsi-*.
  - **E, video:** new agent aa651d8c980d68b5e. Owns web/core/video* and a new codecs/ demux crate.
  - **F, scale:** Share agent ac9206ae1a4d9228a. First the share-checks cleanup and a refresh of the local :3333 sample, then F. Owns crates/, web/share/, deploy/.
  - **D is done** (wsi 144/144, verified). Its commit is held until B/C's view.ts work is stable, then they're committed together.
  - **Blog:** pi is drafting docs/blog/DRAFT.md from both journals and the outline (watcher b4vsexp24). Codex makes the illustrations; the header is docs/blog/images/header.png.
  - view.ts is shared by B/C, D and E: small hooks only. The coordinator commits per wave with an explicit pathspec.

- **15 Oct, about 11:50:**
  - **Josh Example data is live.** It is in my-health-data 911ee41 (5 studies, one tgz per series). The sandbox and the shlink-dicom sample were rebuilt from it plus the CC BY slide (f2eac46), and both VMs were redeployed from GitHub.
  - **Public checks:** sandbox e2e 130/130, How 68/68, View 142/142 (828b439).
  - **Still open:**
    - share-checks still reads the old published tgz files in data/samples; move it to the sandbox data or to synthetic data;
    - the local :3333 server still seeds the old sample.
  - **The coverage plan** (docs/COVERAGE-PLAN.md) waits for Josh's go.

- **15 Oct, afternoon:**
  - **Deployed:** both VMs are live in dal; the sandbox passes remote e2e 109/109, and How passes 68/68 against the live site.
  - **Committed:** View follow-ups (2bdb6c8); the sweep (f1dfcde: Leica max_abs 3; empty slide frames stay refused, and the viewer shows them blank).
  - **New data decision (Josh):** one sample set of Josh's own studies (MRI 2020, CT abdomen/pelvis 2012, CR hand/wrist 2012), de-identified as **Josh Example**, published in jmandel/my-health-data; plus the CC BY slide. It replaces Morgan Rivera.
    - Rules: Example^Josh, JEXAMPLE01, birth date YYYY0101, dates kept, all other identifiers removed.
    - Sandbox agent ab83241fb7aa4e1f8 is building it. The coordinator reviews the values report and the contact sheets, then pushes my-health-data, then the sandbox and server redeploy.
  - **Commit rule:** commit with an explicit pathspec, so other agents' staged work can't sneak in. History rewrites are OK (Josh).

- **15 Oct, about 10:00:**
  - **Committed:** reduced-resolution JPEG 2000/HTJ2K (ebe1dd4); offset tables at pack time and the prune (7760d55).
  - **In progress:** Core+View agent a3832d83abfd092fc is resumed on the View follow-ups plus a dead-code cleanup:
    - the passcode fixture;
    - decrypt in the workers;
    - scaled thumbnails;
    - test-only wasm exports, viewer-kit's legacy helpers and stale docs;
    - making the stage1_core tests self-contained;
    - the landing copy.
  - **VMs:** recreated with `--setup-script` (SSH is still failing on them); monitor b6veiskb3 is watching.

1. **When How and Share report:**
   - verify them with my own Chromium scripts, at desktop and phone;
   - review the server changes;
   - commit a checkpoint;
   - update PROCESS-NOTES.
2. **View follow-ups.** Hold until the whole-slide agent (adcc54c6231290ab4), which now owns web/view, finishes; then resume the Core+View agent, a3832d83abfd092fc:
   - update the stale view-checks (/how and /share are no longer placeholders; the 'locked' check reuses an exhausted passcode fixture, so mint a fresh one each run);
   - landing sample note: change it after the sample switches to the sandbox's fictional patient. The 'coming soon' labels are already removed (coordinator, 15 Oct).
   - decrypt inside the decoder workers, using `perf-spikes/decrypt/record-decrypt.ts` and the non-extractable key posted to each worker;
   - scaled thumbnails through `pool.decode(bytes, { scale })`;
   - DONE: `/legacy` removed (01d3508);
   - DONE: `test/e2e.test.ts` deleted and the root README rewritten (01d3508);
   - update the root README;
   - re-measure on a real GPU after Josh reboots.
2b. **Coordinator:** document the Share agent's link-key convention in spec/README.md/PLAN.md (link key = HKDF(owner key, link id), so the manage link can rebuild any link; the server never holds link keys), and the server's new fields (openCount/lastOpenedAt/bytesServed, access ?lid=&limit=, share expiresAt capped at 31 days).
3. **When JPEG 2000/HTJ2K speed reports:**
   - verify and commit;
   - give the reduced-res agent (a21f481eac15d1f73) the go-ahead for JPEG 2000/HTJ2K scaled decode;
   - fix the workspace clippy warning about hayro's unused `filter_step_vertical`.
4. **When the sweep reports:**
   - triage the failure groups;
   - rulings: Planar Configuration (pending decision 3); Float Pixel Data, which is tier 2 and could be implemented in shl-dicom-decode; the JPEG 2000 YBR_FULL_422 case where the references disagree (likely sYCC double conversion, as with Leica);
   - route the work to its owners, rebuild the oracles, rerun the coverage claim.
5. **Seed the public sample from the sandbox export** (`imaging-sandbox/out/dicom/`), replacing the Anonymized sample in the server seed. Then **deploy `shlink-dicom.exe.xyz`.** First check the exe.dev proxy for byte ranges (206, no added gzip, CORS, large bodies). Then install the Rust server plus the web build under systemd, seed the sample, and smoke-test with the scripted checks against the real URL. (Already public.)
6. **Connect Share to the deployed sandbox:** set the portal URL, and the sandbox's `SHARE_REDIRECT_URIS` for the deployed origin.
7. **Quiet-machine benchmark rerun** (all formats, C-in-wasm too), then update the PERF numbers in the docs.
8. **Later: split out static sites,** with the Share and How builds as GitHub Pages sites pointing at shlink-dicom.exe.xyz.
9. **Whole-slide (SM):** Josh wants slides supported (zoom and navigate, proving the streaming), with a scaled-down real slide in the sample data. The viewer agent is running; the sandbox agent has the data item queued (it waits for docs/wsi-sample.md).
10. **Throughout:** keep PROCESS-NOTES.md current and commit after each verified wave.
