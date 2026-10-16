# Process notes: how shlink-dicom was designed and built

A running journal of how this project happened: the questions, the turns, the mistakes, the checks we built to keep ourselves honest, and how several AI agents were coordinated. It is written for a later blog post, so it keeps the process, not just the outcomes. The coordinator (Claude, Opus 5.5, running in Claude Code) keeps it up to date. Times are local (US Central) and approximate unless quoted from a log.

Cast:
- **Josh**, the project owner. He is also an author of the SMART Health Links specification.
- **Coordinator.** The Claude Code session this journal comes from. It designs, reviews, runs checks itself, and dispatches subagents.
- **Subagents.** Claude agents launched by the coordinator for focused jobs; listed per phase below.
- **pi.** A separate coding agent (the `pi` CLI running Google Gemini, "gemini-4-argon") working in the same repository in a tmux pane. It did the authoring and app work: PLAN.md, the Rust server, WASM and web UI. The coordinator monitored and steered it through tmux.

---

## 1. Origin: a side quest from another project

- **Where it started.** The session began on a different project (FOLIO, an experiment in signed native record items with AI-written mappers). Josh then asked: "are you familiar with smart health links? Read the spec."
- **First reading.** The coordinator fetched the current HL7 *SMART Health Cards and Links* IG page (continuous build) and read it in full rather than relying on memory. It first tried to connect SHL to FOLIO.
- **The redirect.** Josh redirected: "This side quest is about shl, not folio." Lesson for the post: the human set the scope in one line, and everything after was SHL.
- **Early critique.** The coordinator gave a short critique of the spec:
  - `U` mode puts `recipient` in a GET query string, so it ends up in logs;
  - polling with the `L` flag re-downloads the whole manifest;
  - `exp` is only a hint;
  - a handful of typos.

## 2. Design by dialogue: Josh asks, the coordinator proposes, Josh pushes back

The protocol design came from a long run of short, pointed questions from Josh. Almost every important simplification came from Josh questioning something the coordinator had proposed. The sequence, as it happened:

1. **"Open question: how to share full DICOM data via shl (may require extension, cleverness, new ideas)."** The coordinator laid out three options:
   1. each instance as a FHIR `Binary` (works today, Plain, small studies only);
   2. an `smart-api-access` token to the source's DICOMweb, with SMART Imaging Access;
   3. patient-held studies on a host that can't read them: encrypted blobs in RFC 8188-style records, a Service Worker DICOMweb shim, OHIF in the browser.
2. **"Let's focus on U mode… variation on option 2? or hash links from imaging study in bundle to full DICOM encrypted with same key?"** Josh also proposed **tying the image files' lifetime to the U-mode link's lifetime**, instead of the SHL spec's one-hour rule for file locations. Both ideas went into the design.
3. **"Does U mode work with passcode?"** No: the spec forbids `U` with `P`. The consequence: in passcode mode, image files must sit under a fresh, unguessable prefix per manifest response, or anyone holding the link without the passcode could fetch the files directly. They hold the key anyway, because the key is in the link.
4. **"I wasn't saying option 3 was too much, I totally wanted to explore it."** The coordinator had misread a garbled line as rejection. It then expanded option 3: records you can decrypt at any position, HTTP Range access, a Service Worker presenting the files as DICOMweb.
5. **"Why 128 not 256?"** RFC 8188 is AES-128 because it was built for Web Push. The coordinator recommended an AES-256 variant to match the A256GCM the SHL spec already uses.
6. **"Clean way to download full study or series, or expose instance level?"** One object per study with Range access; a ZIP container was proposed at this point.
7. **"Does GH pages support ranges?"** Tested rather than guessed, with `curl`:
   - `206` responses work;
   - text types are gzipped, so a byte range applies to the gzipped bytes;
   - PNG is not gzipped;
   - `Access-Control-Allow-Origin: *` is sent, but `OPTIONS` returns 405.
8. **"How do ranges help when we're trying to access records in enc(zip(data))?"** This exposed that compression would break random access. Answer: a stored (uncompressed) ZIP plus fixed-size encrypted records, so offsets are simple arithmetic.
9. **"Don't we need compression?"**, then **"compatible with lots of DICOM sources; forcing user to re-encode not ideal"**, then **"I don't want to overfit on a few examples. What about cut points at series level"**, then **"What's the zip buying us"**, then **"I don't love new segment concept, broken addressing"**. Each answer removed a layer:
   - re-encoding became optional;
   - "segments" were invented and then dropped;
   - the ZIP was dropped;
   - one file per series was adopted.
10. **"How big would ImagingStudy FHIR be if we list every instance explicitly? I'm looking for simple."** Measured by script, not guessed: about 470 KB of JSON for 2,000 instances, about 61 KB after the DEFLATE the SHL file already applies. So list every instance in `ImagingStudy`, with just a byte-length extension each.
11. **"Do DICOM always organize data into series?"** Yes: Series Instance UID is Type 1. Also "study, series or instance as the primary retrieval unit?" The series.
12. **"…stay uncompressed --??"** Josh caught confusing wording: the coordinator had used "compressed" for two different things (compression inside the DICOM files, and our own deflate step). Then **"I don't love optionality here, how does a client even know what's deflated."** Result: never deflate. One code path; any compression lives inside DICOM, where the transfer syntax already describes it.
13. **"Sketch what the ImagingStudy would look like and the contract for fetching the data."**
14. **"Final record delimiter… why is that needed? Doesn't ending at that point also accomplish the same?"** Josh spotted that the authenticated Bundle already fixes the length. Result: no end marker and no file header, with the key and length taken from the Bundle. The format became a plain counter-nonce scheme (essentially STREAM) with the length known in advance.
15. **Proposal write-up.** "Write up a full proposal for a naive reader who may not have heard of SHLinks but knows FHIR, self-contained, in a new ~/hobby/shlink-dicom folder." The coordinator wrote:
    - PROPOSAL.md;
    - a small TypeScript reference implementation;
    - a test vector, **independently reproduced in Python** before it went into the document.

## 3. Two agents on one repo: proposal and plan reviews

- **Two authors from here on.** Josh and pi (Gemini) edited PROPOSAL.md and wrote PLAN.md: a Rust core plus WASM plus an Axum server plus a web UI. The coordinator became the reviewer.
- **Review 1 (Josh: "review updates to proposal and plan").**
  - **Proposal.** pi had dropped the `Endpoint` resource: series files became `{fileId}.bin`, resolved relative to the Bundle's URL. The coordinator checked `new URL()` behaviour by running it:
    - a base URL ending in an id (no trailing slash) loses its last path segment;
    - query-signed URLs (S3 `?X-Amz-Signature=…`) lose their signature.

    Both became MUST rules.
  - **Plan.**
    - the demo endpoint exposed the `controlToken`;
    - uploads were open to anyone;
    - the plain-text passcode was stored;
    - no protection against compression middleware;
    - a risky plan to decode JPEG 2000 in Rust/WASM through C libraries;
    - unbounded memory, against wasm32's 4 GB limit.
  - **Secrets.** An untracked `.env` holding an OpenRouter API key, and no `.gitignore`. The coordinator added `.gitignore` before anything was committed.
- **Review 2.** pi fixed nearly everything. The coordinator flagged that the sample studies were described as "de-identified" when they were Josh's own studies, published by choice. The wording was changed.
- **"Is the plan clear enough… what can be parallelized, what is the dependency tree?"** The coordinator drew the dependency graph and introduced "F0": a golden test share produced by the reference code, so the server and web work could start without waiting for the Rust core.
- **Management API rounds:**
  - **"What about API shapes exposed by our server for managing shlinks."** The coordinator split the model into a **Share** (the files) and a **Link** (an access policy), so that changing a passcode can't revive an old link;
  - **"How do I add more DICOMs to a link or remove them"**;
  - **"can a user manage a share with 10 DICOMs and only include 3 in a link"**;
  - Josh: **"it'd be nice if we aren't exposing keys in links beyond what they can access… maybe your separation is overwrought anyway."** This was the key change: **a random key per series, carried inside each link's own Bundle**. A link's key opens its Bundle, and the Bundle holds keys only for the series that link includes;
  - **"Why use HKDF at that point?"** It was no longer needed. Key derivation was dropped, leaving a random 32-byte key per file and nonce = record index;
  - **"What other protocol adjustments should we consider given these patterns of usage?"** Immutable `fileId`s for caching, cheap change detection (ETag and `lastUpdated`), treating the decrypted Bundle as secret, marking partial studies, a declared profile, static-host trade-offs, correlation between recipients, and signing as an explicit non-goal.
- **Server storage:**
  - **"where will the data live… how do we ensure it can't nav to paths outside of itself"**;
  - then **"should the server manage everything in sqlite?"**, **"why not put series in db"**, **"one sqlite per user or something"**.

  The result was a design note, `docs/storage.md`: a `catalog.db` for routing, plus **one SQLite file per share**, with series stored as 64 KiB record rows, so no filesystem path is ever built from request text. The coordinator ran the schema's SQL in SQLite 3.54 before handing it over, checking the foreign-key 409 and the atomic passcode-counter statement.

## 4. "How much progress could we make with pure Rust?": the codec program

- **The trigger.** Reviewing pi's implementation, the coordinator found that the viewer was a custom WASM renderer (not Cornerstone), with a hand-written 12-bit JPEG decoder, no JPEG 2000 support, and a bug on multi-frame JPEG.
- **Josh's question.** "How much progress could we make with pure rust / zero deps, with a frontier agent and a pile of examples to test against known-good decoders?" He clarified that "zero deps" meant "only cargo Rust deps". The coordinator surveyed crates.io live (`cargo search`, the crates.io API for download counts) rather than relying on memory.
- **The instructions that started the build** (each sent while the coordinator was mid-task):
  - "prepare a subdir with a clean structure of formats and oracular content and scripts we can use for processing / checking our work";
  - "then prepare an AGENTS.md… such that we can do subagent work in parallel on the different subdirs, with strong enough patterns / guidance that for the non-dependent codecs we can work in parallel, and you can think through the path to working out the serial dependencies";
  - "if you need any tools we don't have, just let me know";
  - "once you write this up, organize subagents to implement and test :)";
  - "I would enjoy being able to say that we can process an estimated 98% of real world studies or something like that."

### What the coordinator built before any agent wrote code

- **`codec-corpus/`** (Python, uv).
  - **Reference decoders, from different code families:**
    - pydicom with the pylibjpeg (libjpeg/OpenJPEG), GDCM and pyjpegls (CharLS) plugins;
    - DCMTK command-line tools;
    - OpenJPEG `opj_decompress`;
    - OpenJPH `ojph_expand`.

    All of these were already installed on Josh's machine.
  - **Scripts:**
    - `discover.py`: pydicom's test data and the local studies;
    - `generate.py`: deterministic **synthetic seed images** (8/12/16-bit, signed, RGB, odd sizes, multi-frame, 1×1) encoded by pydicom, DCMTK and OpenJPH;
    - `oracle.py`;
    - `check.py`;
    - `ref_decode.py`.
  - **Key idea: for lossless encodings of our own seeds, the seed pixels are the truth.** No decoder needs to be trusted for those cases. Elsewhere the oracle comes from the references. Agreement is counted **per implementation family**, so GDCM and pylibjpeg both wrapping OpenJPEG count as one witness. Cases where references disagree on lossless data are marked *disputed*; those with only one family behind them are marked *weak*.
  - **The checker was tested before anything relied on it,** by running a reference decoder through it as if it were a candidate.
  - **`CONTRACT.md`:** the decoder command, its exit codes (0, 2 refused, 3 unsupported, anything else a crash) and the exact canonical pixel format.
  - **`AGENTS.md`:**
    - ownership rules: each agent writes only in its own crate and format directory; shared files belong to the coordinator;
    - separate `CARGO_TARGET_DIR`s;
    - phases and their dependencies;
    - rules for adopting a crate versus building our own;
    - what "done" means: corpus 100%, clippy, a wasm32 build, fuzzing, and a write-up in FORMAT.md.
  - **`FORMAT.md` per format:** the known traps for that codec, written up front for its agent.
- **`codecs/`:** a separate Cargo workspace. The coordinator wrote the shared types and **a stub crate for every codec**, so the dispatch table was complete on day one and format agents never needed to touch shared files.
- **`extract_frames.py`:** dumps each case's per-frame codestreams, so codec agents could test before the command-line decoder existed.
- **Mistake caught by the coordinator's own checks.** Four valid JPEG-LS files had been marked "should fail" because they lack the DICOM Part 10 header. Fixed by reading with `force=True`.

### Phase 0/1 in parallel: six agents

- **The agents:** the foundation (CLI and DICOM parsing), RLE, JPEG (DCT plus lossless), JPEG-LS, a JPEG 2000/HTJ2K crate survey, and prevalence.
- **About 30 minutes of wall-clock time later,** every format except JPEG 2000/HTJ2K passed the whole corpus. Josh: "So all the work up to this point has been completed in about 30 clock minutes. Is there any reason not to take on the jpeg 2000 and htj2k formats?"
- **The foundation agent went against its brief and said why.** It wrote its own small DICOM reader instead of using dicom-rs, because dicom-rs allocates whatever length a field declares (an abort in wasm), loses raw bytes in its OW handling, and doesn't handle files without the Part 10 header.
- **JPEG and JPEG-LS were built from scratch** after the candidate crates were tested and fell short:
  - `jpeg-decoder` couldn't do 12-bit;
  - `pure_jpegls` couldn't do colour, and choked on a fill byte that DCMTK writes before the end marker.

  The JPEG decoder reproduces libjpeg's integer IDCT and upsampling bit for bit.
- **The JPEG 2000 survey tested 12 crates on every corpus frame,** with fuzzing. Decision: adopt `hayro-jpeg2000` for JPEG 2000 and `oxideav-jpeg2000` for HTJ2K. It also found that **the three "disputed" oracle cases were a bug in the coordinator's reference wrapper** (sign handling); a later fix found the wrapper was also reading the SIZ marker 2 bytes off.

## 5. Coverage: power laws, BigQuery and a census

- **"Tell me more about this bigquery dataset… you should be able to run that using my existing gcloud tools."** The coordinator queried the NCI Imaging Data Commons' public `dicom_all` table through the BigQuery REST API (`bq` wasn't installed): **58,784,975 instances, 11.9 GB scanned, a few cents**. Result: 99.3% of IDC images are uncompressed, a reminder that a research archive is not clinical reality. A second query gave the set of profiles per study, for study-level coverage.
- **"Exhaustive listing of all file formats… followed by web research."** A census agent covered every transfer syntax in DICOM PS3.6 (including retired ones), pixel-level variations, and 15 kinds of non-conforming file. It assigned tiers and estimated clinical coverage at about 97–99.5% for tier 1 and about 99–99.8% for tiers 1 and 2, clearly marked as a guess.
- **Josh pushed back twice:**
  - **"I'm not sure what having real CDs would make a difference about…"** Answer: real files don't add formats; they add frequency weights and encoder quirks. IDC can supply real files more cheaply.
  - **"you mentioned that CDs can only be used with uncompressed content, what are you talking about, whose rule is that?"** The coordinator corrected an overstatement: the rule is the DICOM General Purpose CD-R profile (STD-GEN-CD) and IHE PDI, which bind only discs that claim them. Other CD profiles allow compression.
- **Coverage measured by `coverage.py`:** IDC studies went from 67% (exact match) to 94% after the IDC sampler added 296 real files from 64 collections. Profiles with no test case fell from 46 to 5.
- **Josh's own patient exports** (two zip files that pi had found in `~/Downloads`): 737 instances, all uncompressed (matching STD-GEN-CD), and **all 737 decode exactly**. Profiled locally; only counts were kept.

## 6. Quirks, rulings and the oracle as a living thing

- **"Close gaps against that corpus and formats, and look for files that exercise quirks."** Two agents:
  - an **IDC sampler**: one real file per profile, plus up to 3 per make and model for compressed formats;
  - a **quirk hunter**: GDCM's gdcmData, pylibjpeg-data, Orthanc, cornerstone3D, fo-dicom, dcm4che, and files attached to 25 GitHub issues, with licences recorded.
- **Rulings became first-class.** Several failures were the oracle's fault, not ours:
  - pydicom applies Planar Configuration to JPEG and JPEG 2000 output (PS3.5 says it doesn't apply), which scrambles colour;
  - pylibjpeg and GDCM colour-convert lossless JPEG that has a JFIF marker;
  - OpenJPEG treats subsampled 3-component JPEG 2000 as sYCC, and pydicom then converts a second time (magenta slides).

  The coordinator added ruling fields to `cases.json` (`expect_override`, `oracle_ref`, `oracle_case`), plus a `repairs.py` that builds **repaired copies** of broken files. A repaired copy is registered as its own case, and its oracle serves the quirky original. Every ruling carries its evidence in that format's FORMAT.md.
- **Notable files:**
  - a Cornell-encoder 16-bit lossless bug file: first ruled "must be refused"; then the JPEG agent implemented DCMTK's Cornell workaround, and the ruling was reversed to "decode";
  - a lossless JPEG labelled YBR but holding RGB (R = G = B on 97.8% of pixels);
  - a file with a second header group in its data set;
  - OsiriX 10-bit data labelled 8-bit;
  - a Leica slide where one tile in 110 tripped a hayro bug, which was patched in a vendored copy.
- **Concurrency bugs in our own tooling,** found and fixed as several agents shared one corpus:
  - `oracle.py` rewrote a whole `cases.json`, which once wiped another agent's new expectations. Fixed with a locked, merge-by-id `save_cases` that only saves the cases it rebuilt;
  - a non-idempotent repair script blanked two oracles;
  - two benchmark runs rebuilding one shared binary at the same time (ETXTBSY), fixed with a build lock.
- **Running total:** about 920 corpus cases, all passing.

## 7. Performance: measure, then argue

- **"re: speed, are these good? how do we compare?"** The coordinator timed our decoder against DCMTK, pylibjpeg, GDCM and libjpeg-turbo on the same files. 12-bit and lossless JPEG were on par with IJG libjpeg; 8-bit colour was 2.7× slower than libjpeg-turbo.
- **"please do spikes on perf including simd if you think relevant, and def build a wasm perf infra that'll be easy for us to understand and improve browser perf from."**
  - **The JPEG SIMD spike:** 5.6× natively, with every step checked for byte-identical output across all JPEG files, and a test that the SIMD path equals the scalar path on all 2,806 frames.
  - **HTJ2K:** oxideav was 4× over budget. Two patches made it about 21× faster: a block-wide scan run per coefficient, and a linear table search per bit. A 512² image now decodes in 30 ms in the browser.
  - **The benchmark setup** (`codecs/bench/`) covers native, Node, a Chromium worker and the Chromium main thread, plus the reference C libraries.
    - **Every result is checked against the oracle,** so a fast result can never be a wrong one.
    - **Builds run interleaved per case,** after load from other agents made SIMD falsely look slower.
    - **Native was run with glibc keeping freed memory,** as WebAssembly effectively does, to make the two comparable.
    - **Profiles carry readable names,** for both V8 and `perf`.
    - **An HTML report** compares each run against a saved baseline.
- **Josh caught an unfair comparison:** "When you compare us to the C library… do you mean you ran the C library in the browser… It's strange to me that the sign flips." The report had compared our wasm in the browser with the C libraries run natively. The fix in progress: run Cornerstone's C-compiled-to-wasm codecs in the same browser, and label the columns so the two comparisons are never mixed.
- **"Is browser able to take advantage of GPU here?"** Answer: yes for display (WebGL2 window/level in a shader); only partly for decoding (the transforms, not the entropy coding). Multiple CPU cores through a Worker pool come first. Josh: "Oh gpu yes 1/2", and a viewer-kit agent is building both.
- **"Any more performance optimization available to us now that we have benchmark results."** Next up:
  - decryption: WebCrypto's hardware AES versus software AES in WebAssembly, possibly the real bottleneck;
  - reduced-resolution decoding for thumbnails;
  - `wasm-opt` (Josh: "Install dep for (4)"; binaryen 133 was installed into `~/.local` without sudo);
  - the fetch strategy.
- **Post-decode processing** in the CLI: 3–13× faster, with an exhaustive 2^24-input test that the YBR→RGB conversion still equals pydicom's float32 formula.

## 8. Working with pi (Gemini) through tmux

- **"I also have tmux available where you can monitor the other agent's work or communicate via pi cli harness."** The coordinator found pi's pane with `tmux capture-pane` and sent it messages with `tmux send-keys`, which pi queues as "steering" messages.
- **"monitor it every 10min or so and if it seems broken like api 429 errors you can give it a quick nudge; if it runs out of dollars by hitting $32 total you can take over its work with your own subagents."** The coordinator wrote a watcher script, `~/.local/share/pi-watch/watch.sh`. It polls the pane every 10 minutes, reads the cost from pi's status bar, and wakes the coordinator on errors, on two idle polls in a row, or at $32.
- **What happened:**
  - **Repeated "Upstream idle timeout exceeded".** pi's spend stayed flat, so nothing was getting through. The coordinator ran `/compact` (context went from 343k tokens to about 4%) and nudged it to work in smaller steps.
  - **It timed out again with a small context.** The coordinator diagnosed single very long responses (rewriting a 960-line `web/main.ts` in one go) and asked for edits under about 150 lines, or new modules. That worked.
  - **What pi built meanwhile:**
    - wired our `shl-dicom-decode` into its Rust core and WASM;
    - added a cache of decoded frames (window/level under 1 ms);
    - seeded Josh's Downloads studies as demos.
- **"Work with pi on clean demo UX, review and guide it."** Five review rounds, each a markdown file in `docs/ux-review-N.md`, each verified by the coordinator with headless Chromium scripts (Playwright), not taken on pi's word:
  1. **Privacy first.** The demo had opened on Josh's unpublished CT with his real name and birth date. Fixed to the public dataset, with "Demo Patient" shown. Also: mislabelled buttons, no intro, a "Zero-Knowledge" tagline (inaccurate jargon), and a broken phone layout.
  2. Scroll-on-load, window/level defaults, the default series, how the intro band behaves, and wording.
  3. The sharing story: a QR code per link, opening in a new tab while the host log updates live, links with a subset of studies, revoke and offline states, passcode attempt counts. Verified with a scripted end-to-end flow: create a link, open it, watch the log, revoke it, see the viewer's message.
  4. The recipient's view, and failure panels.
  5. **Phone ("Work on phone UX too"):** the image handled only the mouse wheel, so the coordinator asked for Pointer Events gestures. Also 44 px touch targets, `100dvh` and safe-area insets, landscape, and showing the passcode prompt in the passcode demo. Verified with touch emulation: a one-finger vertical drag synthesised through CDP moved slice 10 to 18; no control under 40 px; no overflow at 390, 360 or 844 px wide.
- **pi's spend at the time of writing: $19.52.**

## 9. Long tail

- **"Do you take a stratified sample of all the complex stuff from bigquery to ensure we handle it correctly"**, then **"Long tail stratification via metadata clues."** A sweep agent:
  - chooses clue columns: the writing toolkit and its version, manufacturer, model and software version, SOP class, high-bit oddities, compression history, padding, LUTs, offset tables, file-size outliers;
  - selects files greedily so every rare (clue, value) pair appears at least once, plus a random control of about 1,000 files for an unbiased pass rate with a confidence interval;
  - downloads, decodes with us and with the references, compares, and deletes, keeping only failures as new corpus cases.
- **"Do we have disk space here or on external 4TB drive?"**
  - internal: 111 GB free;
  - `/media/barracuda` (1.8 TB, 991 GB free) is mounted and is used for sweep temp files, since `/tmp` is RAM-backed;
  - no 4 TB drive is attached at the moment.

---

## Themes worth writing about

- **Socratic protocol design.** The human's short "why?" questions removed most of the complexity: the end delimiter, optional compression, segments, the ZIP, key derivation, shared keys across subsets. The agent generated options quickly; the human chose and cut.
- **Verify claims by running something.** GitHub Pages Range behaviour (`curl`), URL resolution (`new URL`), JSON size (a generated `ImagingStudy`), SQLite schemas (executed), test vectors (cross-checked in Python), BigQuery cost (dry runs first).
- **Oracle-first engineering.** Truth from seeds where possible; independent reference families; disputed and weak flags; rulings with evidence; repaired copies as oracles. The test data, not the code, was the main product of the first hour.
- **Parallel agents need ownership rules.** One directory per agent, shared files owned by the coordinator, stubs so no one blocks, separate build directories, locks on shared manifests. The concurrency bugs that did happen were all in shared tooling.
- **The coordinator's own mistakes, caught by its checks or by Josh:**
  - misreading "option 3";
  - overstating the CD rule;
  - two reference-wrapper bugs (sign handling, SIZ offsets);
  - the unfair native-versus-browser comparison;
  - a non-canonical base64 key in a golden fixture (caught in review);
  - an oracle-overwrite race.
- **Multi-model collaboration.** Claude coordinating Claude subagents plus a Gemini agent through tmux, with budgets, a watcher, nudges and review files, and verification by screenshot and script instead of trusting summaries.
- **From "side quest" to a measured claim.** In about a day the project went from reading a spec, to a protocol proposal, to a pure-Rust decoder for every common DICOM pixel encoding, checked on about 920 cases and on IDC data, with a browser benchmark setup and a polished demo.

## Artefacts (where to look)

- **The protocol and implementation plan:**
  - `PROPOSAL.md`;
  - `PLAN.md`;
  - `reference/`;
  - `docs/storage.md`.
- **The decoder corpus and its agent instructions:**
  - `codec-corpus/` (README, CONTRACT, AGENTS, `formats/*/FORMAT.md`, `scripts/`);
  - `prevalence/` (SOURCES, CENSUS, IDC_SAMPLES, QUIRKS, LONGTAIL).
- **Code and performance:**
  - `codecs/`: the decoder workspace, plus `bench/` and the vendored hayro and oxideav with their patches;
  - `formats/*/PERF.md`;
  - `codecs/bench/report.html`;
  - `viewer-kit/` and `perf-spikes/`.
- **The UX work with pi:** `docs/ux-review-1..5.md`.
- **Monitoring pi:** `~/.local/share/pi-watch/` (the watcher script and its log).

---

## Addendum (15 Oct): Josh's parallel thread with pi, recovered from pi's session log

pi stores sessions as JSONL (`~/.pi/agent/sessions/--home-jmandel-hobby-shlink-dicom--/`). The tmux scrollback (2,000 lines; pi redraws the screen) had none of this. Josh's 65 messages to pi show a second design conversation running alongside the one with the coordinator:

- **20:16–20:33, design questions to pi on PROPOSAL.md:**
  - "I am interested in what we could remove in endpoint, please brainstorm with me"; this is where `{fileId}.bin` relative to the Bundle came from;
  - "at what point do we get to 'trust' that a server hasn't messed with our bytes", on authenticating range reads;
  - "help me with the math" on record offsets;
  - "64k seems a bit arbitrary, how to pick wisely" and "what about 1MB ciphertext records?";
  - "we have to worry about IVs not just in the chunks but in our manifest too, yes?".
- **20:37–20:50, planning:**
  - "a rust lang reference implementation + a browser-side bridge that can resolve this and do cool streaming stuff that shows off the nimbleness", using images from `jmandel/my-health-data`;
  - a server you can post DICOM to, with a control capability for passcodes, online/offline and expiry;
  - code that compiles to wasm;
  - export of the originals;
  - "a Cornerstone or OHIF option soon after";
  - multi-study bundles;
  - then the API design, test plan, file layout and crate boundaries.
- **Josh as a human bridge between agents.** Before the tmux channel existed, Josh pasted the coordinator's reviews into pi verbatim ("here is an outside review: … what do you think?"), then argued the points with pi: signed URLs, why presigned URLs are only needed in manifest mode, prefix-scoped tokens in U mode, and "I don't like custom semantics on carryover … this is getting too complex". The same relay carried the Share/Link split, the per-series key options ("maybe option 2? what do you think"; "what about 3 extensions and the key is optional … or do we KISS"; "let's do a."), and the protocol-adjustment list.
- **21:40, a question that foreshadowed the codec program:** "if you're writing your own decoders do you have ability to compare against source of truth to be sure they're right."
- **20:03–20:15 local (01:03–01:15 UTC), the UX turning point:**
  - "this viewer will be usable as a https://viewer#shlink:/ viewer prefix";
  - "make the ui less idiosyncratic and vomited on the page, and build in more affordances for explaining / subtly showing how the spec works; also do perf testing with chrome";
  - "don't make me pick series by series, just do at study level by default. and seriously this UI is a dumpster fire";
  - "it's vomiting huge complexity on the screen, think more about showing people flows/paths that they can understand, and don't do full-on multistep workflows crammed into a little sidebar";
  - the pointer to the two identified studies in ~/Downloads for performance testing. This is how they ended up in the demo, and why the coordinator's review 1 led with privacy.
- **After that:** a run of "proceed"s from Josh, then the coordinator's tmux messages took over steering pi.
- **15 Oct, reframing:** with the UX "a lot better" after five review rounds, Josh said the job to be done still wasn't settled. He asked to factor the work into three experiences: consumer sharing, a viewer for recipients, and a technology demo with insight for developers. A brainstorm began (see the chat; a design document is planned).

## 10. Three experiences, a SMART Imaging sandbox, and exe.dev (15 Oct)

- **Josh's brief.**
  - **Sharing:** "via a smart on FHIR imaging DICOM enabled portal source :) even (1) can have a bit of flair like thumbnail, series count, bytes because this is a technical demo after all".
  - **The explainer:** "should be powered with live interactivity demo widgets … on a public sample SHLink built in".
  - **Audience:** all of the above.
- **Decisions, captured with the question tool:**
  - one site that can be split later; the sharing site and the explainer will later move to separate GitHub Pages sites, configured to talk to the server;
  - everything first on exe.dev, since it needs a database;
  - manage links, no accounts;
  - download-only import;
  - our own sandbox "based on https://build.fhir.org/ig/argonautproject/smart-imaging/";
  - subagents rather than pi as builders.

  Recorded in docs/EXPERIENCES.md.
- **Checkpoint commit.** 68e6b9a: 443 files, a 5.8 MB repo, no images.
- **Wave 1:**
  - **Core + View agent:** a shared `web/core/`, a three-door landing page, a lean `/view#shlink:/…` with the worker pool and GPU renderer, and DICOMDIR ZIP export. 154 scripted Chromium checks on desktop, 390, 360 and landscape. WebCrypto became the default decrypt, from measured numbers: about 800 MB/s against about 45 MB/s for wasm.
  - **Imaging sandbox agent:** a SMART Imaging Access server (Bun, one process) with an authorization server (PKCE, introspection, a consent page with per-study opt-out), clinical FHIR, imaging FHIR (all three Endpoint modes) and WADO-RS.
    - 86 end-to-end checks in Chromium from another origin; 266 instances byte-identical; HL7 validator clean.
    - It found **14 unclear points in the Argonaut IG**: `aud` across servers; 403 or 404 for studies the token doesn't cover; 401 or 403 for an expired capability; whether `.s` or `.r` covers retrieval; what a capability is bound to; reading a study in capability mode; `_lastUpdated` after a consent change; omitted transfer-syntax; the token response example; `payloadMimeType` failing R4 validation. Possible feedback for the IG.
  - **Finding:** the published my-health-data archives are already anonymized (`Anonymized1` and `Anonymized2`, no dates). Earlier sightings of the real name came only from the unpublished Downloads CT.
- **exe.dev.** Josh asked: "do you have exe.dev hostname picked out?" The coordinator read exe.dev's llms.txt and proxy docs. Since each VM gets one public port, it proposed two VMs: separate origins are also realistic, because the portal is a different organisation. Josh: "we could always reverse proxy ourselves with subpaths". The coordinator created `smart-imaging-sandbox.exe.xyz` and `shlink-dicom.exe.xyz`, both private, tagged `#health-skillz-mgmt` like Josh's other VMs.
- **Josh's data request for the sandbox:** a sample patient with a real-looking name rewritten into the DICOM headers, with pixel bytes untouched; everything scripted and reproducible from git; DiagnosticReports carrying PDF and text attachments, marked as sample reports. These are real images, so no invented clinical reads are presented as real.
- **Wave 2:** a How agent (live widgets on the sample link, a runnable 50-line receiver) and a Share agent (files, CD, ZIP; the SMART portal through the sandbox; re-share; manage page with activity) run in parallel. Each owns its `web/<x>/` directory, and changes to the shared core may only add files.

## 11. IG feedback, public VMs, inference, and the sweep at two thirds (15 Oct, afternoon)

- **Josh's rulings on the 14 IG ambiguities the sandbox surfaced:**
  - `aud` is internal to the token format; RFC 7519 allows it to be an array;
  - responses never reveal whether a study exists;
  - `.rs` covers search plus retrieval, `.r` retrieval alone;
  - capabilities are bound to the grant, not the access token;
  - the consent-related edge cases don't matter.
- **Transfer syntax.** Josh: "I don't fully understand. So I need you to break this down for me." The coordinator checked the current PS3.18 text before explaining it. When the `transfer-syntax` parameter is absent, the default is Explicit VR Little Endian, unless the server has only lossy data. Josh chose the IG rule "apps send `*`", and decided the sandbox should "just refuse" (406) when the parameter is omitted.
- **The first outward-facing actions.** With Josh's approval, the coordinator opened GitHub issues argonautproject/smart-imaging#2 (the token response example lacks `token_type` and `scope`) and #3 (transfer-syntax guidance). It quoted the IG's own source, fetched by cloning the repo, rather than paraphrasing, and fixed a typo in #3 after posting. The payloadMimeType point was explained to Josh first ("explain it to me first") and then dropped as a tooling quirk.
- **Speed results landed:**
  - **Decryption:** WebCrypto at about 800 MB/s against about 50 MB/s for wasm AES. For uncompressed and lossless data, wasm decryption had been the real bottleneck. WebCrypto is now the default; moving decryption into the decoder workers is next.
  - **JPEG-LS:** greyscale is now at or faster than CharLS; RGB cine is about 1.25×.
  - **Reduced-resolution decoding:** the JPEG thumbnail path, a `decode_file_scaled` API, and a `scale` option in the browser pool. A 2048² colour image decodes in 9.9 ms instead of 42.6 ms.
- **Surviving compaction.** Josh: "make sure that you have a plan for all the balls that you're juggling … written out to disc". The result is `docs/COORDINATION.md`: every agent's id and what it owns, decisions made and pending, and an ordered queue, plus a memory entry pointing at it.
- **Three decisions in one message:**
  - the public sample matches the sandbox's fictional patient;
  - the VMs go public now; the coordinator ran `share set-public` on both, and the proxy is on port 8000;
  - "detect what we can in order to have the most robust behavior". This became an inference round: missing Planar Configuration is decided by image smoothness, and other safe "infer instead of refuse" cases follow, each reported as a warning.
- **The long-tail sweep at 66%** (6,344 of 9,557 files, about an hour in). It covers 118 manufacturers, 425 models, 17 writing-toolkit versions and 25 SOP classes.
  - **Random control:** 998 of 998 decodable files pass, so the 95% lower bound is about 99.6%.
  - **Failures in the long-tail selection:**
    - RGB with no Planar Configuration (Philips IntelliSpace Portal; GE LOGIQ E9, written by the same converter version "0.5"), where every reference decoder fails too;
    - Leica JPEG 2000 YBR_FULL_422 mismatches, likely the known sYCC double conversion in the reference decoders;
    - one float-pixel-data file (highdicom).

    No new codec bug so far.

## 12. Wave 2 lands; slides; size limits; repo hygiene (15 Oct, late afternoon)

- **The sweep checkpoint at 66% prompted Josh to ask about the size limit.** "I'm concerned about the size limit. Can you explain this to me?" The coordinator traced it to the harness's own memory cap (`--max-decoded-gb 2`). It had skipped 12 whole-slide images that decode to 2.4–11.8 GB, so those files had gone unchecked. Fix: frame-by-frame verification with bounded memory, about 30 sampled tiles per slide against references, plus a hash pass over every frame.
- **Josh then raised the ambition.** "I definitely want to be able to support these kinds of slide images and our viewers should do something with them … zoom and navigate to prove that our streaming model works … include … a scaled down version … in our sample data." Two tracks:
  - a whole-slide viewer agent: the pyramid read from headers fetched by range; tile→frame→byte mapping; a deep-zoom view that fetches only visible tiles; live "bytes fetched against slide size" stats as the proof of streaming. It also prototypes an optional Bundle extension with per-instance frame offsets (PROPOSAL open question 4), held for Josh to decide;
  - the sandbox agent queued to add a scaled-down but real CC BY IDC slide to the fictional patient's data.
- **"Is webassembly really limited to 4 GB?"**
  - **Answer:** yes, for wasm32 (32-bit addresses). Memory64 (WebAssembly 3.0) lifts it: Chrome and Firefox shipped it around early 2025, Safari lagged, Rust has only a tier-3 target, and bounds checks cost performance.
  - **Design consequence:** we never need more than 4 GB in one instance, because decoding works per frame or tile, each worker has its own instance, and downloads stream without decoding.
- **Wave 2 verified by the coordinator, not just reported.**
  - **Reruns:** How it works passed 68/68 and Share 123/123. View had 11 failures, all stale checks (placeholders that no longer exist; a passcode fixture exhausted by an earlier run).
  - **Highlights:**
    - the explainer's record map, with live 206 requests and "9 records verified … SOP Instance UID matches the Bundle";
    - a 49-line receiver that runs in the page, Node and Bun;
    - Share's portal flow (SMART launch against the sandbox, "Morgan Rivera", reports carried as PDF and text);
    - a manage page with a plain activity log and a technical request log behind a disclosure.
  - **Decisions the Share agent made to document in the proposal:**
    - link keys derived as HKDF(owner key, link id), so the manage link can rebuild any link while the server never holds link keys;
    - share expiry made settable, up to 31 days. The demo server had been deleting every share after 24 hours, which would have made "1 month" untrue.
- **Repo hygiene lesson.** The checkpoint commit jumped from 5.8 MB to 38 MB because the check scripts' screenshots (about 30 MB) were swept in by `git add -A`. The commit had not been pushed, so the coordinator amended it, gitignored `docs/shots/` (regenerable) and expired the reflog. The repo went back to 2.7 MB (ed67c94). Rule going forward: dry-run `git add` and check sizes before each checkpoint.
- **Other decisions recorded in COORDINATION.md:**
  - both exe.dev VMs are public (the proxy on port 8000);
  - the public sample will use the sandbox's fictional patient;
  - "detect what we can": an inference round in the decoder (missing Planar Configuration by smoothness, plus other safe inferences, each reported as a warning).

- **Inference round finished.** The decoder now infers missing or impossible pixel attributes and reports each one.
  - **Planar Configuration** is decided by within-channel smoothness, horizontal plus vertical, with the smoother reading required to win by at least 1.25×; images smaller than 16×16 are refused. It gave the right answer on the 8 real IDC files (2 Philips planar, 6 GE ultrasound interleaved), by margins of 1.8–8.4×.
  - **Other attributes:** Bits Stored, Samples per Pixel and Photometric, plus dimensions and bit depth from the JPEG or JPEG 2000 header.
  - **Deliberately still refused:** truncated pixel data, possibly-packed 12-bit native data, and ambiguous layouts.
  - **Effect on the corpus:** three formerly "must refuse" GDCM quirk files now decode, matching DCMTK, GDCM and OpenJPEG on repaired copies. The coordinator recorded them as repaired-copy rulings. One gotcha: a repair case's oracle must be built before the original that points at it. The corpus went to 935/935.

- **HTJ2K speed, round 2.** The agent switched to option B: HT block decoding now runs inside the vendored hayro pipeline, porting the MIT/BSD-licensed `ndic-htj2k` and OpenJPH decoders, with oxideav as the fallback for MIXED streams. Patches to hayro's wavelet and memory copies helped both formats.
  - **HTJ2K:** 22–27× OpenJPH became about 2–3× natively. A 2048² lossless frame went from 384 to 41 ms natively, and from 458 to 71 ms in wasm.
  - **JPEG 2000:** averages 1.20× OpenJPEG.
  - **Measurement under load:** the machine sat at load 13–27, so the agent timed our decoder and the C library alternately on the same frame, so both ran under the same load. Benchmarking around other agents became a skill of its own.
- **exe.dev SSH outage (about 16:30).** SSH into every VM on Josh's account, old ones included, dropped right after authentication, and the lobby relay failed with "handshake failed: EOF", so the sandbox deploy stalled. The coordinator showed it wasn't project-specific by trying an untouched VM, and set up a background poll every 10 minutes.

- **Deploying around a broken SSH path (15 Oct, afternoon).** The coordinator first ruled out its own side: both account keys, OpenSSH 10.6 and paramiko, and a VM restart all failed the same way. exe.dev's HTTPS `/exec` API failed too, with the lobby's own connection to the VM reset, so the fault sat inside exe.dev's network. The fix was to stop depending on SSH: two bootstrap scripts that build everything from the public repo with only `curl`, runnable from the web terminal or as a first-boot setup script.
  - **Testing in a container caught three bugs before any VM saw the scripts.** The container ran exe.dev's own published image, with a small `systemctl` stand-in.
    - `main` didn't build: a two-line wasm fix had stayed uncommitted while an agent kept working.
    - The `/how` page baked its numbers from a gitignored corpus report.
    - The server needed `libsqlite3-dev`.
  - **The lesson:** "it builds on my machine" had been hiding gaps between the working tree and git for a day.

## 15 Oct, late morning to evening: from "it works" to "it handles everything"

- **The slide viewer and the offset-table question.** The whole-slide agent built a deep-zoom viewer that fetches only visible tiles: 13.8 MB to look around a 1.2 GB slide at full resolution.
  - **The catch:** most IDC slides converted by PixelMed have no frame offset table, so the viewer had to read 128–379 MB of fragment headers before the first sharp screen.
  - **The agent's answer:** it prototyped putting frame offsets in the Bundle.
  - **Josh's question:** "Is this suggestion only to rescue slides that lack metadata that could be present in DICOM?" It was.
  - **Decision:** fix the files, not the protocol. The sandbox writes Basic Offset Tables into the sample slide, and the packer can add them at share time (fragments byte-identical). The Bundle prototype was deleted.
  - **Follow-up:** Josh asked that a large first screen at least show progress, so the viewer gained a "Finding tiles: 42 MB of about 101 MB read" card, checked on a throttled 20 Mbit/s connection.
- **"Greenfield, no legacy."** When the coordinator mentioned removing `/legacy`, Josh made it a standing rule: "we want to keep our code clean and to the point without accumulating tech debt within our own never-announced, unused-by-anyone repos". That day the repo lost:
  - pi's original single page and its end-to-end test;
  - the core Rust render path;
  - most of the wasm session API, taking the wasm from 2.6 MB to 50 KB;
  - viewer-kit's "legacy" CPU helpers.
- **Uniform, realistic sample data.**
  - **The decision:** Josh replaced the fictional Morgan Rivera with his own studies, de-identified as "Josh Example". "Just stripping names and identifiers is fine… I would like to have a uniform sample data set that is realistic." The five studies (brain MRI, CT abdomen/pelvis, three hand and wrist radiograph studies) went into his public `my-health-data` repo, one tgz per series.
  - **The plan:** he asked for it before any work started. The coordinator wrote it out: Example^Josh; birth date reduced to 1 January of the real year; study dates kept; every other identifier, private tag and UID replaced or removed; burned-in text reviewed on contact sheets.
  - **The coordinator's own review before pushing:**
    - read every remaining header value;
    - searched all files for the real name, birth date and record numbers, reading them from the sources at run time so they never landed in a repo;
    - looked at full-resolution radiographs for CR ID flashes;
    - found that the agent's first pass had kept the real insurer on a reconstructed order form, and sent it back.
  - **"Synthesize, don't drop":** the agent had dropped a CT dose screen, a scanned order form and four MRI viewer captures because they showed identity. Josh: "Rather than dropping data from my report, please create a synthetic equivalent… to maintain verisimilitude." They were rebuilt from the sources with fictional identities and marked "(reconstructed)", plus a CT dose SR built from the screen's values.
- **Reports come from somewhere else.** Josh pointed out that DICOM from imaging systems rarely carries the report: reports are FHIR DiagnosticReports from the clinical side. The viewer shows them beside the images and labels where each part came from.
  - Because we create the sample, Josh rejected any "labelled as a guess" matching for our own data. Every report carries the same accession, Study UID and imagingStudy reference as its images, and a data check asserts it.
  - The bland "SAMPLE REPORT" texts became realistic synthetic reports from fictional clinicians and facilities, with one plain footer line saying they are synthetic.
- **"You're not really thinking big."** After the long-tail sweep, the coordinator called floating-point pixel data "out of scope". Josh asked what else was being swept under the rug. The honest answer: "out of scope" was the coordinator's own tier label, not a decision. The first proposal listed defensive fixes. Josh: "I'm seeing a bunch of overly defensive ideas here and you're not really thinking big. Please come back at the proposal that addresses everything we plausibly can."
  - **The result:** docs/COVERAGE-PLAN.md, with seven workstreams and five agents in parallel. Only three things stay refused: JPIP references, Hologic's private tomosynthesis and undocumented vendor compression.
  - **What landed the same day:**
    - every JPEG mode, JPEG XL, JPEG 2000 Part 2, float pixel data and the retired colour models (corpus 942 → 1,176);
    - SR, PDF/CDA, waveforms, 3D models, SEG/RTSTRUCT/presentation-state layers;
    - LUT-accurate display and MPR;
    - focal planes, fluorescence, slide annotations;
    - H.264/HEVC playback through the browser, and MPEG-2 through an LGPL FFmpeg wasm whose source is served alongside;
    - resumable streaming uploads that took a 3.36 GB CT from a phone with flat memory.
- **Josh caught what the checks missed.**
  - A "Glass slide" button showed on a CT after visiting a slide.
  - The Download button crashed on the CT. Only the MRI's download had a check, so the matrix of studies and view states became a test.
  - Josh also redefined downloads: the whole study is the one-click default, and viewer-made images (reformats) are never offered as files.
  - On reformats, he asked "do we use algorithms that match, say, Cornerstone?" They were simple axis cuts checked only against our own numpy. They are now being rebuilt against SimpleITK/vtk with patient-space resampling, oblique planes and slabs.
- **Coordination failures and fixes.**
  - **A commit swept in staged work.** A commit meant for two files also took another agent's staged deletions, which broke the build. The fix was a forward commit, and from then on every commit uses an explicit pathspec. (Josh: rewriting history is fine before launch.)
  - **Builds collided.** Five agents rebuilding `dist/web` produced phantom check failures, because the build deleted the site before writing it. The build now assembles in a private folder and swaps it into place.
  - **Two lost writes, one caught.** The objects agent overwrote the slide agent's new `icc.ts`, then rebuilt it from that agent's transcript, and the slide agent confirmed the rebuild exact. The slide agent briefly reverted and restored shared files to prove a test caught its bug; nothing was lost, but only because the timing was lucky.
- **exe.dev was the infrastructure lesson.** SSH failed on our VMs and on some of Josh's older ones, yet worked on others. Josh's observation that one old VM worked pointed at broken hosts rather than our setup. The SSH keys here can't change the account's region, so Josh moved it to Dallas himself. The VMs, recreated there, worked at once, including first-boot setup scripts.
- **Upload design with Josh.**
  - **His priority:** network hiccups matter more than page reloads. The client now retries without limit with offset checks, holds a re-shared link's passcode in memory ("we receive passcodes on every access attempt"), and follows the IETF resumable-upload draft.
  - **Study-level files:** a second pi session wrote the study-file and S3 plan. Josh and the coordinator refined it:
    - a hybrid `linked-file` (study default, optional per-series override);
    - HL7 canonical extension addresses;
    - proxy or redirect as a server setting, with no "unguessable public objects" ("doesn't pass the sniff test");
    - no protocol change.
- **Blog.** pi drafted the post from both journals and the annotated outline (figure specs and a screenshot list). Josh's corrections: he is the author of both SMART Health Links and the SMART Imaging IG, so the post shouldn't thank "their authors", but it shouldn't announce his authorship either. The Codex header image was first started without closing stdin and sat waiting for input; the coordinator noticed hours later.

## 15 Oct, afternoon: one file per study, a review loop, and an X-ray that rendered white

- **Study files landed.** The Part 1 agent worked on its own branch and worktree, with separate build output and servers inside a private network namespace, so the other agents' shared servers and fixtures stayed untouched. The suites found three real bugs before any review:
  - re-share sliced instances using series-relative offsets inside a study file (456 instances differed);
  - the How tour read a slice header from one record when the slice began 492 bytes before that record's end;
  - a stale import name that only a clean-clone deploy build caught.
- **pi was replaced as reviewer by a fresh Claude agent.** The new reviewer read the plan and the diff cold and found nothing blocking, but it did find 12 items. The ones that mattered were places where the spec allowed what all three implementations rejected (zero-length instances, empty series), and one where TypeScript and Rust disagreed: an unused study-level key would have been handed to recipients of a subset link. The fixes added tests in Rust, TypeScript and the reference, and the coordinator reran the gates before a fast-forward push.
- **Josh: "align everything to latest designs."** The coordinator had proposed redoing the blog visuals after the deploy. Josh wanted them aligned at once, so the visuals agent recomputed the trace diagram from the branch's real files. It verified the computed Range request by decrypting those records back to the identical slice.
- **The white X-ray.** On his phone, Josh found his oblique hand X-ray rendered almost white while its thumbnail looked fine. The file is MONOCHROME1 with only a VOI LUT, whose descriptor claims 16-bit output but whose data stops at 4095. Our LUT reader corrected data wider than the descriptor, but not narrower. The thumbnail looked right only because some thumbnail paths never received the header and auto-windowed from the pixels. Josh: don't spot-fix it for his files. The brief became one display pipeline for every pixel path, a two-way bit-depth rule with citations, and a conformance check against dcmtk and pydicom across the corpus, the IDC files that use LUTs, and synthetic edge cases.
- **Blog edits from Josh's LinkedIn read-through.** He cut the "What went wrong" section and reworded the standards paragraph ("I think it would be very interesting to bring this approach into the standards ecosystem…"). LinkedIn edits are made in place, scripted against the editor. Focus emulation over CDP avoids stealing the tab Josh is using, and every sync starts with a diff to catch his own edits.

## 15–16 Oct, night: compression, our own encoders and decoder, interaction, and the post scheduled

- **Lossless compression by default.** Josh asked why patient apps would download bloated uncompressed CD data. The measurement on his real studies (733 images) gave SV1 2.46×, JPEG 2000 2.96×, JPEG-LS 2.98×, HTJ2K 2.80× and Deflate/gzip 1.82×.
  - **Defaults:** JPEG Lossless SV1, with a JPEG 2000 option, both chosen because DICOM's DVD/USB profiles require readers to decode them.
  - **Upstream:** Josh opened smart-imaging PR #5, transfer syntax negotiation with `*` as the fallback, by branching in the repo rather than forking, and the measured ratios were posted there.
  - **Sandbox:** it became the reference server, with dcmtk/OpenJPEG copies.
- **"We wrote our own decoder, are we not writing an encoder?"** OpenJPEG was dropped before it landed. Both encoders are pure Rust, with a mandatory bit-exact self-check and deterministic output.
  - **Performance pass:** memory fell sharply (165 → 25 MB for a cine) with byte-identical output.
  - **Then the decoder:** Josh saw the poster's code map and asked "we're not using our own code??". The vendored hayro/oxideav JPEG 2000 decoders were replaced by our own (shl-jpeg2000) once every gate passed, removing about 89,600 lines. Only jxl-oxide remains.
- **Synthetic numbers stay out of print.** A synthetic 3.36 GB CT compressed 9×. Josh: test with it, don't cite it. Footnote 3 was cut, and the generator was made realistic (2.7×).
- **Object-type sweep.**
  - **Census:** 38 SOP classes and 58.8M instances in IDC, with no Enhanced or Legacy Converted CT/MR/PET.
  - **Results:** 156 cases, which found 7 defects: PET rescale in reformats, frame order, upside-down NLST SEGs (138,665 in IDC), GSPS, a black breast projection, per-frame decoding, and deflated SEG ingest. All are fixed and live.
- **Viewer interaction.** Josh disagreed with deferring it ("we can and should make it great").
  - **Desktop:** OHIF mappings.
  - **Touch:** Photos-app gestures, with an explicit Adjust mode replacing hidden gestures.
  - **Coverage:** one model across slices, MPR, video and slides.
- **The post.** Josh's edits made it first person throughout, with agents as tools, and protocol-first ("any client can follow these steps"). The post message was redone with pi after Josh called Claude's drafts slop. The article was scheduled for Fri 16 Oct, 9 am ET, through LinkedIn's own scheduler.
- **Process lessons.**
  - **Commits:** `git add` followed by a bare `git commit` swept another agent's staged rename into a commit and broke a deploy. Now commits take a pathspec, and agents never touch the index.
  - **Rules from Josh:** short-lived branches that land promptly; never characterize the Ditch the Disk working group's scope.
