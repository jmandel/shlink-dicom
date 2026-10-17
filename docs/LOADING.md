# Loading encrypted files in the viewer

What the viewer does to fetch an encrypted study file over HTTP Range requests, what has been measured, and what is still open. It covers main's loader, the `scheduler` branch, the record-size experiments, and the causes found for the stalls. Every number below is from local runs on the sample share and the second share described in `perf/sessions/README.md`, through the shaped links in that README.

## Main's loader

**Records.** A study's file is cut into AES-GCM records: 65,520 plaintext bytes plus a 16-byte tag, so 64 KiB of ciphertext per record (spec/README.md §9). Reads are planned in whole records. Instances seldom end on a record boundary, so neighbouring instances share records.

**InstanceLoader** (`web/core/loader.ts`) does the slice, header and frame reads:
- **Spans.** Missing records become spans, one Range request each. A record already cached or already on its way is not asked for again.
- **Queue.** Spans wait in a priority queue: Visible (the image on screen), Near, Prefetch, Background. Within a priority, first asked goes first.
- **In flight.** 6 requests at once. A Visible request may go 2 over the limit.
- **Prefetch reads.** These and background reads use at most 4 of the 6 slots. A new prefetch read starts only while running prefetch reads have under 1 MiB (`BULK_BYTES`) still to arrive.
- **Merging.** When a span starts, queued spans of the same series next to it in the file join it:
  - up to 32 records (`MERGE_RECORDS`, 2 MiB);
  - up to 512 KiB for a Prefetch span;
  - a span before it joins only if it is at least as urgent.
- **Delivery.** Records are handed on as they arrive, so the front of a long request isn't held back by its end.
- **Cancellation.** A request every caller has abandoned is dropped if queued, or aborted if running.
- **Cache.** 96 MiB of ciphertext.

**The viewer's requests** (`web/view/view.ts`):
- The slice on screen is asked for at Visible.
- `prefetch()` asks for every other slice of the series, nearest first: ±1–3 at Near, the rest at Prefetch.
- Moving the slice raises the new ±3 to Near.
- Switching series drops the queued prefetch of the old one.
- Overview thumbnails are asked for at Visible. Large files, including slides, go one after another, smallest first. Opening a study aborts the overview's requests for other studies.

**Slides** have their own reader, `SeriesReader` in `web/core/wsi-source.ts`, separate from the InstanceLoader:
- its own queue, 6 at a time per series;
- runs of up to 64 records (4 MiB);
- a 64 MiB cache of decrypted records;
- no merging across reads;
- a running request is not aborted when its waiters go away.

**HTTP/2.** All requests share one connection to the server.
- **How a link is shared.** Our shaper (`perf/sessions/shaper.mjs`) shares the link round-robin across streams. A request competes with every other running request for the link, so a long background read takes a share for as long as it runs.
- **Why a read can't be paused.** Chromium advertises a per-stream receive window of several MB, larger than our requests (at most 4 MiB). If the page stops reading a response body, the server keeps sending until the window is full. So a read can be stopped (aborted) but not paused. This is from Chromium's HTTP/2 settings, not measured here.

## The scheduler branch

Branch `scheduler` (tip 9d988bb, on JPEG XL's #6 commit rebased onto main of 17 Oct). It is not merged. It changes:
- **One queue.** Slide reads go through the InstanceLoader. `SeriesReader` keeps its own cache of decrypted records and asks the loader with `cache: false`. Slide tiles, headers, overview thumbnails and slices share one queue, and running slide reads can now be aborted.
- **`planRecords` in range.ts.** The loader's and the slide reader's hand-built plans are gone.
- **Distance as a tie-break.** Within a priority, queued reads go nearest the slice on screen first (`setFocus`; slices in the scrub direction count half), or by a tile's distance from the view's centre. Then first asked.
- **Tile coalescing.** Reads that carry a rank (tiles) are queued one task before any starts, so a view's tiles can merge. Merges may include a gap of up to 64 KiB.
- **Screen first.** While a Visible read runs, no Near or Prefetch read starts.
- **Fetch Priority.** Range reads carry `priority`: high for Visible, low for Prefetch and Background, auto for Near. Chromium's request log showed High and Low for these.

## Experiments

Load is the 1-minute load average when each session ended. The benchmark's own browsers add about 4–6 to it.

### Record size on main of 16 Oct

**Setup**
- Builds: main at 64 KiB, and scratch builds at 32 and 16 KiB with request caps rescaled to the same bytes.
- 1,116 sessions, 12 kinds, home / Fast 4G / Slow 4G, desktop and phone.
- 65 sessions with load over 8 left out.
- Runs per build: home desktop 12–13, Fast 4G desktop 5–6, Fast 4G phone 3, Slow 4G 2–4.

**Open p50, 64 → 32 → 16 KiB:**

| Cell | 64 KiB | 32 KiB | 16 KiB |
|---|---|---|---|
| Fast 4G desktop CT | 1080 ms | 332 ms | 286 ms |
| Fast 4G desktop MR | 2331 ms | 1445 ms | 1255 ms |
| Fast 4G desktop LUAD slide | 1134 ms | 861 ms | 770 ms |
| Slow 4G desktop CT | 10.2 s | 8.7 s | 7.9 s |
| Slow 4G desktop slide | 5.6 s | 4.3 s | 3.7 s |

- **At home:** no difference.
- **J2K slide:** 5.2 → 3.9 → 3.8 MB; 70 → 94 → 124 requests.
- **MR scrub back on Fast 4G desktop:** step p50 22 → 4928 / 4850 ms.
- **Decryption** (`perf/sessions/record-bench.mjs`, 64 MiB, 3 runs, load under 1):
  - desktop: 1030–1046 → 832–882 → 668–674 MB/s;
  - 4× CPU: 245–254 → 215–225 → 173–179 MB/s.
- **Video:** the scratch builds' video at 16 KiB was slower (home open 1.10 → 1.61 s), because `video.ts` read 64 records at a time. Later scratch builds size that read, and `frames.ts`'s, in bytes.

### Record size on main of 17 Oct

**Setup**
- Builds: main (with mf-first-frame) and scratch builds at 32 and 16 KiB.
- CT, MR, LUAD and J2K slides; Fast 4G (10 runs per build) and Slow 4G (5), desktop and phone.
- 360 sessions, 4 workers. 2 sessions left out (other processes over 2 cores).

**Open p50 (ms), 64 → 32 → 16 KiB:**

| Cell | 64 KiB | 32 KiB | 16 KiB |
|---|---|---|---|
| Fast 4G desktop CT | 1060 | 653 | 391 |
| Fast 4G desktop MR | 2285 | 1608 | 1455 |
| Slow 4G desktop MR | 16569 | 13920 | 13450 |
| Slow 4G desktop slide | 5597 | 4305 | 3682 |

- **J2K pan, Fast 4G desktop, p50:** 90 → 247 → 266 ms.
- **MR scrub back, Fast 4G desktop, p50/p95:** 22/2320 → 4786/5233 → 2598/5795 ms. This is the race described under "MR scroll-back stall"; record size did not cause it.

### Scheduler A/B, 17 Oct

**Setup**
- Builds: main, scheduler at 64 KiB, scheduler at 32 KiB.
- Cells: Fast 4G ×5 and Slow 4G ×3 runs per build, desktop and phone.
- 192 sessions. The first two runs ran at load 13–19 and are left out (60 sessions), leaving 2–3 sessions per cell.

**Fast 4G desktop, open p50 (ms):**

| Kind | main | scheduler 64 KiB | scheduler 32 KiB |
|---|---|---|---|
| CT | 1129 | 955 | 448 |
| MR | 2326 | 2156 | 1518 |
| LUAD slide | 1070 | 1064 | 824 |
| J2K slide | 812 | 734 | 531 |

**Requests:** LUAD 183 → 70 → 70; J2K 70 → 56 → 60.

**MR scrub back, step p50/p95 (ms):**

| Cell | main | scheduler 64 KiB | scheduler 32 KiB |
|---|---|---|---|
| Fast 4G desktop | 25/226 | 18/265 | 3076/3364 |
| Slow 4G desktop | 5779/6626 | 8044/9345 | 12627/13343 |

**Slow 4G desktop CT:**

| | main | scheduler 64 KiB | scheduler 32 KiB |
|---|---|---|---|
| Scroll step p95 | 51 s | 13.5 s | 26.3 s |
| Stall time per session | about 1,410 s | about 375 s | |
| MPR first plane | 33 s | 74 s | |

The scheduler's MPR is asked for 36 s sooner in that session (the scrolls before it stall less). The volume finishes at the same time: first MPR draw at 121.8 s against 123.0 s in one traced pair.

**J2K pan p50 (ms):**

| Cell | main | scheduler 64 KiB | scheduler 32 KiB |
|---|---|---|---|
| Fast 4G desktop | 89 | 113 | 289 |
| Slow 4G desktop | 98 | 99 | 834 |
| Phones | 96–105 | 96–105 | 96–105 |

With 2–3 sessions per cell, the 64 vs 32 KiB differences in this A/B are mostly the race below. See "Measurement".

### Loader variants tried

All on Fast 4G desktop MR unless noted, 2–4 sessions each, load 9–17. Most ran on a 32 KiB scratch build; the later ones on the scheduler at both sizes.

| Variant | Result | Kept? |
|---|---|---|
| Latest on-screen slice first (earlier ones drop to Near), plus a separate request when a slice waits behind more than 256 KiB of a running read | MR scrub-back p95 6.4–6.6 s, against 4.4–5.1 s before. At 64 KiB it fetched 1.4 MB more and the rock step went 286 → 418 ms | Dropped |
| Near and Prefetch merges capped at 512 KiB (old loader) | 4.1–4.4 s | Dropped |
| Merge size limited to 0.4 s at the measured per-request rate | MR 2.2–3.5 s; CT jump 2.3–3.4 s, MPR 8–12 s, session 32–40 s against 24 s | Dropped |
| On-screen reads don't merge with each other | MR 4.0–6.1 s; CT open and switches slower | Dropped |
| Scheduler cutting running reads more than 6 slices away (and demoting stale on-screen reads) | MR scrub-back up to 26 s; CT MPR 5–9 s (load about 15) | Dropped |
| Merge only reads of the same priority | Didn't fix the stall | Dropped |
| Every request batched one task | Enhanced CT on Slow 4G: open 8.0–8.9 s against 9.3–9.8 s, but jump 7.1–8.0 s against 5.4–6.0 s, because a first frame merged with its prefetch into one 786 kB request (2 sessions each) | Only tile reads batched |
| One-tile margin ring around the slide view at Near | J2K pan at 32 KiB unchanged (297 ms); LUAD 15.2 → 21.5 MB; zoom 2.3 → 3.8 s | Dropped |
| Background merges at 512 KiB on the scheduler | MR scrub-back max 2.6–3.6 s at 64 KiB, 2.7–5.3 s at 32 KiB, no longer bimodal | Dropped |
| Screen first (on the scheduler) | Below | Kept on the branch |
| Fetch Priority | Requests carry High and Low; the local shaper ignores priority, so there is no measured effect | Kept on the branch |

**Screen first, against main** (scheduler at 64 KiB, Fast 4G desktop, 3 sessions; main 2 sessions):

| | main | screen first |
|---|---|---|
| MR open | 2459–2574 ms | 566–1593 ms |
| MR scrub-back max | 264 ms and 6.8 s | 1.5–2.3 s |
| CT open | 1355–1466 ms | 614–1454 ms |
| CT scroll p95 | 9.6–10.4 s | 7.3 s |
| CT jump | 36–968 ms | 21–283 ms |
| MPR first plane | 30–48 ms | 1.6–3.1 s |

### Overview reads and the opened study

The overview's slide thumbnail read (3.7 MB of another study's file, I7eKgDnI71, bytes 7143424–10878975) can share the link with an opened study's first frame:
- **Main:** the slide reader doesn't abort a running read, so it runs to the end.
- **Scheduler:** the read goes through the loader. In one Fast 4G session, opening the enhanced CT aborted it with 0 bytes received.
- On main, the read didn't appear in the 3 enhanced-CT sessions logged.

## Causes found

**MR scroll-back stall.** Eight sessions with the request log, Fast 4G desktop, scheduler branch, 4 at each size.
- **Scrub-back max step:**
  - 64 KiB: 311, 296, 298, 5191 ms;
  - 32 KiB: 296, 5163, 2329, 309 ms.
- **The background read in every session.** One Near read of 2 MB, merged up to the 2 MiB cap, covers the neighbours on the side away from the scrub (instances 12/13–18/19). It runs from about 1.1 s to 10 s at about 0.23 MB/s on the 1 MB/s link.
- **The extra read in stalled sessions.** In the stalled ones, the slices the slow scrub skipped (instances 0–3 or 0–4, 1.38–1.41 MB) were also merged into one Visible read, in the order the back-scrub needs them. With the link shared it took about 5 s: 1376 kB in 5548–10429 ms. In the others those slices went out as smaller requests at different times and were in by then.
- **What decides it.** Whether the skipped slices merge depends on what is queued when one of them starts. Record size shifts the instance boundaries and so the odds, not the mechanism.
- **CPU.** The main thread was 76–82% idle at both sizes. No loader function was in the top 8, and there were 50–52 requests either way.

**CT scroll stalls on Slow 4G.** Step p95 is 51 s on main, against 13.5 s with distance ordering. With slices fetched in file order, a scroll overtakes the fetching and waits for the series to arrive.

**Renderer crashes.** "Target crashed" and "Page crashed" happen while the machine has 1–6 GB of memory available:
- 2 of 40 parallel sessions;
- the view checks' dark, mpr-ui and overflow flows on both main and the branch.

One scheduler session (1 of 64) drew no first slice for about 2 minutes although the whole series arrived. It didn't recur in 48 targeted sessions. The cause wasn't found.

## Open trade-offs and candidate designs

- **Screen first against MPR.**
  - It opens and scrolls faster because background loading waits while the screen's read runs. MPR then needs the rest of the volume, and its first plane comes later (1.6–3.1 s against about 40 ms on Fast 4G).
  - A candidate: keep screen first, but let background reads of the volume continue at a set share once the slice on screen is drawn.
  - It would need to show MPR within about 0.5 s of main and keep the open and scroll gains, over at least 10 sessions per cell.
- **Fetch Priority with a server that honours it.**
  - It needs a shaper, or a real server path, that schedules streams by priority. Then measure scrub-back and open against main.
- **J2K pan at 32 KiB.**
  - A pan reads its tiles in several view updates. The reader log showed 6 waves over about 2 s. At 64 KiB the next tiles are often already in a record fetched for a neighbour.
  - Coalescing within one update doesn't help, and a margin ring cost 40% more bytes for no gain.
  - A candidate: request the tiles of the whole pan path at once (the view knows where it is going). It would need J2K pan p50 within 20% of 64 KiB at under 10% more bytes.
- **Record size.**
  - Smaller records open faster on slow links in every run (Fast 4G CT 1.06 → 0.39–0.65 s; Slow 4G 1–3 s less).
  - Costs:
    - more requests;
    - the pan cost above;
    - decryption about 20% (32 KiB) and 35% (16 KiB) slower per MB on desktop;
    - spec, test-vector and compatibility changes (listed in docs/E2E-PERF.md).
  - Any comparison has to hold the loader's ordering race fixed (see "Measurement").

## Measurement

- **Tools.**
  - `perf/sessions`: scripted reading sessions.
  - `shaper.mjs`: TLS HTTP/2, one round trip per request, a shared downlink and uplink, round-robin across streams, no priority.
  - `--reqlog`: the browser's Range requests with first and last byte times, the loader's spans with their priority and instances, and the drawn pictures.
  - `--profile`: the main-thread CPU profile.
  - `aggregate.py`.
- **Interleaving.** Builds are interleaved run by run with the order rotating, and blobs are read into the page cache first. A cold disk added 3–9 s to whichever build went first.
- **Load.**
  - Other agents' jobs pushed load to 10–40 during several runs. Main's opens then varied from 2 to 12 s.
  - Leave out sessions that ran beside other heavy processes: CPU used outside the matrix over 2 cores, logged every 30 s. The load average counts the benchmark's own browsers too.
- **Sample size.**
  - 2–3 sessions per cell were not enough. The scrub-back difference between 64 and 32 KiB in the A/B (p50 25 against 3076 ms) came from a race that both sizes hit (above).
  - Bimodal results need at least 8–10 sessions per cell, and the per-session values reported, not only p50 and p95.
- **Per-operation latency penalises reaching an operation sooner.** MPR, and on Slow 4G the scrub back, look slower when the steps before them got faster. Check the session time and the absolute time the operation finished.
- **Why DevTools throttling isn't used.** It serializes response headers and request starts, which overstates request counts.
