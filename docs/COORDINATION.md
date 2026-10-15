# Coordination state (coordinator's working file)

Last updated 15 Oct 2026, mid-day. This is the coordinator's source of truth for what is in flight, what is decided, and what comes next. **Read this first after a context compaction.** Update it whenever an agent finishes, a decision is made, or the queue changes.

Related docs:
- `docs/EXPERIENCES.md`: the product design for the three experiences, with Josh's decisions.
- `docs/PROCESS-NOTES.md`: the blog journal; keep appending to it. pi's independent version is `docs/PROCESS-NOTES-pi.md`.
- `codec-corpus/AGENTS.md` and `CONTRACT.md`: rules for the codec work.
- `docs/storage.md`: the server's SQLite design.
- `docs/ux-review-*.md`: past UX rounds.

## Standing rules

- **No legacy code (Josh, 15 Oct):** greenfield repo. Delete superseded pages, shims and prototypes outright, together with their routes, checks and docs.

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
| Whole-slide (SM) viewer (DONE, committed 9cf4a1f; WSI checks 60/60) | adcc54c6231290ab4 | `web/view/` (core+View finished), additive `web/core/`, viewer-kit additions | Tiled deep-zoom viewer: pyramid from headers; tile→frame→byte via EOT/BOT/fragment walk; prototype a frame-offset Bundle extension (protocol decision for the coordinator and Josh); live streaming stats; `docs/wsi-sample.md` recommends a CC BY IDC slide for the public sample | Verify; decide the frame-offset extension with Josh; the sandbox agent adds the slide to the sample data |
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

- **BLOCKER (15 Oct, about 16:30): exe.dev cannot reach our VMs.**
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

## Decisions pending (ask Josh)

- (none open)

Resolved 15 Oct:
- **Public sample link:** YES, seed it from the sandbox's rewritten dataset; the sandbox agent writes a plain export for this.
- **VMs:** both made **PUBLIC** (the proxy targets port 8000).
- **Robustness:** "detect what we can for the most robust behaviour". The foundation agent (aac32c9d770084d05) is implementing inferred Planar Configuration by smoothness, plus a survey of other safe "infer instead of refuse" cases, each with a warning and tests.

## Next-step queue (in order once their inputs exist)

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
2b. **Coordinator:** document the Share agent's link-key convention in PROPOSAL.md/PLAN.md (link key = HKDF(owner key, link id), so the manage link can rebuild any link; the server never holds link keys), and the server's new fields (openCount/lastOpenedAt/bytesServed, access ?lid=&limit=, share expiresAt capped at 31 days).
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
