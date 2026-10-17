# Review findings: fix plan

Written 17 Oct 2026. Status at 18:00 CDT: M1 (d4d60ff), X1 (74e8928), the server round (598b0c5, deployed live on both VMs) and dd-a (0678bcb, with `cty`) are on main. It covers every finding from the second review round that checked out against the code: the Argon and DeepSeek reviews of the server, crypto and client areas. Each was verified on main at 21e5910 or 7bf2c28. Spurious and refuted claims are listed at the end with the reason.

Rule (Josh): every verified finding gets fixed. Spec SHALL violations, over-sharing, persisted secrets and false claims in our own spec are never "Low".

Nothing builds until the end-to-end A/B finishes ("quiet window over"). Agents write and commit on their branches until then.

## Order

1. **M1 lands first, alone** (`m1-alone`, 73d2051), as soon as builds are allowed.
2. **X1 next**: the `javascript:` sign-in XSS on the Share page.
3. Then the server round (`review-fixes-3`), the browser branches and the Rust/spec branch, in parallel. Each lands once its checks match main.
4. Verify the DeepSeek max reports and the rest of the Argon reports (still running) and add confirmed new items to the lanes below.
5. Deploy: a server release from CI to the live VM, with `SHL_PUBLIC_ORIGIN`; reseed the sample (it gets new 256-bit link ids); redeploy the sandbox.
6. Update the review response with the round-2 section and the landed commit hashes.

## Server and sandbox: server agent, branch `review-fixes-3`

Ids are from the server verification (M1–M29).

| Id | Finding | Fix | State |
|---|---|---|---|
| M1 | Any share's token can delete another share's link and end its sessions | Bind `lid` to `sid` in both statements; 404 otherwise | Landed d4d60ff |
| K4 | Link ids are 128 bits; SHL requires ≥256 bits of entropy in the manifest URL | 32-byte link ids, their own 43-character check; state the rule in our spec | Sent |
| M3 | `Upload-Length` overflow gets past the share byte limit | Reject above `i64::MAX`; saturating sums | Written |
| M2 | Clone racing a delete keeps references to deleted blobs | Conditional reference (`ref_count > 0`) | Written |
| M22 | `seed` runs startup sweeps against the live data | No sweeps in seed | Written |
| M5 | Publish racing a delete or expiry leaks the blob; recreates the share dir | Record under the share lock, then reference; no dir recreation | Written / sent |
| M6 | Blob count errors ignored; missing row treated as zero | `Result`, trash only at an observed 0 | Written |
| M7 | Orphan-link sweep can delete a just-created link | Startup only | Written |
| M4 | Tar path traversal in `compress` | `unpack_in` | Written |
| M8 | Access log unbounded; `recipient` up to 32 MiB | 256-byte recipient; newest 10,000 events per share | Written |
| M9 | Whole-file PUT has no body cap | Cap at declared length and remaining quota; cap local staging with S3 | Sent |
| M10 | Unlimited links per share; link bundles outside the quota | 100 links; 16 MiB per bundle | Written |
| M11 | Expired capabilities swept only on share creation | Sweep every minute | Written |
| M12 | Expiry leaves the share's event channel | Remove it | Written |
| M13 | No storage bound across shares (256 × 20 GB) | Global byte cap set from disk size | Sent |
| M14 | Slow-drip upload never ends or gets swept | 2 h request deadline; claims with timestamps | Written |
| M15 | Share byte limit checked outside the insert | One `BEGIN IMMEDIATE` | Written |
| M16 | Public sample passcode locks after 5 wrong guesses | Sample link refills | Written, tested |
| M17 | Origin taken from `X-Forwarded-*` | `SHL_PUBLIC_ORIGIN` | Written |
| M18 | Server: failed non-resumable PUT publish leaves its upload row | `forget_upload` on that path | Sent |
| M19 | S3 mode: signed URL usable up to 60 s after revocation | Keep TTL ≤ 60 s; state it in the spec's deployment section | Sent |
| M20 | Capability lifetime not clamped to 1 h (SHL SHALL) | Clamp | Written |
| M21 | Stale-upload sweep recreates deleted share databases | Open without CREATE | Written |
| — | Clone needs no token | Require the source share's token; sample exempt | Sent |
| — | Reseed gap: `/sample` points at the deleted sample | Close the gap | Sent |
| M23 | Sandbox Endpoint read has no scope check; default redirect URIs | Scope check; trailing `/` | Written |
| M24 | Sandbox refresh rejects narrower scopes | Allow any subset the grant covers | Sent |
| M25 | Sandbox grants never swept | Sweep | Written |
| M28 | Sandbox `q=0.0` accepted | Parse as a number | Written |
| M29 | Bootstrap logs `chmod 666`; env file briefly 0644 | Owner-only from creation | Written |

## Browser: JPEG XL agent (after its current landings)

| Id | Finding | Fix |
|---|---|---|
| X1 | Share page: a crafted portal's `javascript:` sign-in URL runs script on our origin, which can read saved share tokens | `https:` only (`http:` on localhost) for both endpoints and both bases, including `?portal=` |
| T1 | Portal token sent to any report attachment URL, `next` link or Endpoint address; a relative URL sends it to our own origin; attachment `url` copied to recipients | Token only to the portal's origins; resolve against the FHIR base; always strip `url` |
| P1 | Saved upload job keeps the plaintext passcode, file keys, the source link and local paths, with no expiry | No stored passcode; drop the source link once packed; expire at the share's `exp`; clear on every abandon path |
| K7 | Receiver may use file locations more than an hour after the manifest (SHL SHALL NOT) | Record the manifest time; refresh before 60 min |
| R1 | Unchecked offset tables: reads that never settle, a 60 s main-thread freeze, negative lengths | Accept only strictly increasing in-range tables; validate ranges; errors reject |
| R2 | Annotation reader refetches forever above its cache budget (any large bulk annotation) | Build results from fetched records; pin records being read |
| R3 | Focal planes, optical paths and frame counts drive allocation | Clamp against the instance length |
| R4 | Instance length from the Bundle unbounded; per-record promises created up front | Cap lengths; create lazily |
| K3 | No limit on inflating the Bundle (770:1 measured) | 64 MiB inflate cap; JWE size cap |
| K8 | Key cache keyed by file id only | Key by file id and key |
| K6 | `location` shape not checked | Reject a last segment with no `.` and no trailing `/` |
| K2 | Browser JWE reader doesn't check `cty` | Check it, as Rust does |
| S1 | Re-shared links skip compression and offset tables | Read each series' transfer syntax first |
| M18 | Upload never completes after a failed final step | Done: `upload-complete`, 7b73a6f |

Where the logic exists in Rust, the browser calls it through wasm instead of adding a TypeScript copy.

## Rust core and spec: decoder agent

| Id | Finding | Fix |
|---|---|---|
| P2 | A report that names no study goes into every subset link | Subset links carry only reports naming a study in them; a loose report only when the sharer ticks it (unticked by default); in the single Rust Bundle builder |
| K1 | `pack --keys` reuses the Bundle IV and file keys on changed input | Store Bundle and per-study plaintext hashes in `keys.json`; refuse changed input |
| K3 | Rust inflate has no cap | `.take(64 MiB)`; JWE size cap |
| K5 | Spec §13 claims an older version is detected; an older Bundle isn't | Correct §13; any freshness mechanism goes to Josh first |
| K9 | Rust accepts a padded 44-character file key | Exactly 43 |
| W1 | Wasm32 overflow in the header scan's meta loop | `checked_add` |
| K2 | Rust Bundle JWE has no `cty` | Done on dd-a, 9c626aa; lands with that branch |
| D1 | Cut-short headers throw; video without delimiter (round 1, 4.1 and 4.2) | Done on `dedup-syntaxes` (77d35e6, 7b883db); lands with the stack |

## Outside review: interrupted, resumed and changed shares

A second outside review (17 Oct) looked at sharing that is interrupted, resumed or changed. Verified with repros in `/media/barracuda/pireview/verify-ext/`.

| Id | Finding | Verdict | Fix | Owner |
|---|---|---|---|---|
| E1 | `upload-job` (P1) creates the passcode link with files not uploaded yet: 400 foreign key, share stranded | Confirmed, branch only | Early link with no files; nothing stranded on failure | JPEG XL agent |
| E2 | Two patients in one import: the Bundle takes the first patient's demographics and files the other's studies under them, even when the first patient's study is left out | Confirmed, main | Patient from included studies only; refuse more than one patient; state the rule in the spec | Decoder agent (dd-b) |
| E3 | Resume checks only size and the first and last 64 KiB, then re-encrypts the cut record under the same key and nonce: mixed old and new content, and GCM nonce reuse against a host that under-reports its offset | Confirmed, main | Per-chunk plaintext hashes in the saved job; any mismatch gets a new file id and key | JPEG XL agent |
| E4 | Reload during a compressing upload: attached and portal reports lost; a link source's report choices reset, sharing reports the sharer left out | Partly (compressing uploads), worse than stated | Save the final report selection in the job; portal resume keeps the portal's Patient | JPEG XL agent |
| E5 | Opening Share in another tab deletes this tab's staged files; one saved job per browser | Confirmed | Web Lock per staging session; jobs keyed per share | JPEG XL agent |

## DeepSeek max review

Verified against main 5ae64fb (`/media/barracuda/pireview/verify-dsmax/`). 15 of 33 repeat items above; one refuted (sandbox consent, same area as SRV-13). New:

| Id | Finding | Severity | Fix | Owner |
|---|---|---|---|---|
| cl-D1 | A declined re-encode detaches an in-memory source; the Bundle gets `instance-length: 0` and the link can't be opened | High | Copy before transferring to the worker; the builder refuses length ≤ 0 | JPEG XL agent; decoder agent (builder) |
| cr-D1 | `pack` writes the plaintext `bundle.json` with every file key into `--out` | High | Write it only where `--bundle-json` says; fix the help text | Server agent |
| cr-D3 / cl-D4 | Receiver reads whole bodies (Bundle, manifest, a `200` to a range request, a `206` without progress) before any limit | Medium | One capped stream reader | JPEG XL agent |
| cr-D5 | Manifest entry picked without its `contentType` (SHL 1..1) | Medium | Pick the `application/fhir+json` entry with a `location` | JPEG XL agent |
| cr-D6 | `U` with `P`, and `v` > 1, accepted (SHL SHALL NOT / SHOULD NOT) | Medium | Refuse both, browser and Rust | JPEG XL agent; decoder agent |
| cl-D6 | Slide total pixel matrix sizes tile arrays without a bound | Medium | Refuse more than 2^22 tiles | JPEG XL agent |
| sv-S3 | Concurrent appends exceed the share quota (3.5× measured) | Medium | Reserve bytes per chunk under the share lock | Server agent |
| sv-S7 | Unauthenticated 32 MiB bodies, no concurrency limit | Medium | Small limits on those routes; a concurrency limit | Server agent |
| sv-S11 | Capability tokens written to the access log and shown on Manage | Medium | Log the path without the token; scrub old rows | Server agent |
| cl-D3 | Archive members inflated into staging without a cap | Low | Cap | JPEG XL agent |
| cr-D7 | Link-Bundle PUT can reuse the stored Bundle's IV | Low (backstop) | Refuse an equal IV | Server agent |
| cr-D8 | Rust `instance-length` unbounded, unchecked adds | Low | Cap; checked adds | Decoder agent |
| sv-S9 | Release tag pattern not anchored in the bootstraps | Low | Anchor it | Server agent |
| sv-S13 / S14 | Sandbox builds whole studies in memory; capability map unbounded | Low | Stream parts; reuse and bound | Server agent |

Already fixed on pending branches: browser Deflated cap and annotation lengths (`reader-hardening`), bare data sets in the browser (dd-b).

## Outside review: codec test harness

Verified (`/media/barracuda/pireview/verify-codec/`). Owner: decoder agent, after dd-b. Each fix shows the check now catches a deliberately broken input.

| Id | Finding | Severity | Fix |
|---|---|---|---|
| C1 | Transcoding writes the VOI LUT Descriptor as US when the rescaled range is signed: −1024 reads as 64512 (PS3.3 C.11.2.1.1); the self-check compares bytes, not VR | Medium–High | Resolve from the rescale range or decline; self-check compares VR |
| C2 | Encoder thread pools turn a worker panic into silently missing frames | High | Propagate panics; threaded = serial tests at both thresholds |
| C3 | Four JPEG fixtures tolerate errors of 137–192 (dcmtk, which the colour ruling rejects); a solid-gray image passes | Medium | Tolerances 4, 4, 3, 3; constant images must fail every lossy case |
| C4 | Malformed-file checker accepts exit 1, 127 and wrapper-reported crashes as refusals | Medium | No shell; only 2 passes |
| C5 | Browser oracle check passes truncated ranges and exits 0 on failures | Medium | Expected length from the plan; nonzero exit |
| C6 | Encoder corpus gate passes an empty run or an encoder that declines everything | Medium | Baseline of expected outcomes |
| C7 | Mutation test pairs each seed with one target only | Low | Seed × target |

## Not fixing

| Claim | Why |
|---|---|
| Sandbox `/auth` CSRF (Argon SRV-13) | No accounts; PKCE and `state` bind codes to whoever started the flow |
| One token for all three resource servers (M26) | Josh's ruling, recorded in the sandbox's `CONFORMANCE.md` |
| 406 when `transfer-syntax` is omitted (M27) | Deliberate; smart-imaging PR #5 allows it |
| UID path traversal in WADO URLs (Argon C-02 part) | Stays on the same WADO host with the same token |
| "Tab killed" by huge typed arrays (DS C3 part) | Typed arrays allocate lazily; the real freeze is the plane loops, fixed under R3 |
| Access log `pending` queue as a memory problem (Argon SRV-5a part) | Drains every 25 ms |
| `curl … | bash` from main as the trust root (M29 part) | Inherent to a one-line install; the scripts verify everything they download |

## Still to come

- DeepSeek max reports (crypto, server, client): running.
- Argon crypto report (not written yet) and the rest of the Argon client report.

New confirmed findings join the lanes above; this file is updated as items land.
