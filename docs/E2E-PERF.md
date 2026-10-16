# End-to-end performance, October 2026

Every workflow of the viewer, sharing and the server, measured as a person would see it, on the sample link (Josh Example: MRI, CT with its report, three X-ray studies, the lung slide; 313 MB in six study files). This page has the numbers and what changed. Branch `e2e-perf`; scripts in `/media/barracuda/e2e/scripts/`.

## How it was measured

- **Browser.** Headless Chromium, through playwright-core. Desktop is 1440×900 at DPR 1; phone is 390×844 at DPR 3 with 4× CPU throttling. "Cold" means a fresh profile; "warm" means a second visit in the same profile. Rendering is the CPU renderer, because the machine has no GPU.
- **Network.** `shaper.mjs` sits in front of each local server and speaks TLS HTTP/2, as the exe.dev proxy does. Each request waits one round trip, and every stream shares one downlink and one uplink in turn. The profiles:

  | Profile | Round trip | Down | Up |
  |---|---|---|---|
  | Home | 50 ms | 20 MB/s | 5 MB/s |
  | Fast 4G | 165 ms | 1.01 MB/s | 0.17 MB/s |
  | Slow 4G | 562 ms | 180 kB/s | 84 kB/s |

  Home matches the live site from this machine: about 20 MB/s, with 50–130 ms per request on a warm connection. The Fast 4G and Slow 4G figures are Chrome DevTools' own.
- **Why not DevTools throttling.** It was not used for the comparisons. It skews them: its responses come back one latency apart, as the cache lock below also makes them.
- **Three builds.** Each configuration ran on three builds, one after another, under the same load:
  - **main** (origin/main);
  - **main+no-store** (main plus only the one-line HTTP cache fix);
  - **branch**.
- **Numbers.** Each cell is the median of 3 runs, with the range in brackets. Load averages were 1–7 for the matrix and 14–20 for the live runs.

## Workflows: main | main+no-store | branch

Times are in ms, desktop, cold, unless a row says otherwise.

| Workflow | Profile | main | main+no-store | branch |
|---|---|---|---|---|
| Open link → overview | home | 715 [691–721] | 711 | 218 [212–243] |
| | home, warm | 595 | 603 | 151 |
| | home, phone | 864 | 866 | 458 |
| | Fast 4G | 3104 [3049–3124] | 3063 | 674 [669–703] |
| | Fast 4G, phone | 3143 | 3148 | 872 |
| | Slow 4G | 13461 | 13312 | 2595 |
| Open link → first thumbnail | home | 849 | 869 | 377 |
| | Fast 4G | 4974 | 5135 | 1603 |
| | Fast 4G, warm | 4495 | 4646 | 1399 |
| | Slow 4G | 23998 | 24548 | 7450 |
| MRI: click → first slice | home | 99 | 85 | 77 |
| | Fast 4G | 982 [971–1229] | 1502 | 182 [182–204] |
| | Fast 4G, phone | 893 | 1139 | 217 |
| | Slow 4G | 8606 | 9160 | 3904 |
| MRI: scroll the 20-slice series, 30 steps/s | home | 2311 | 1641 | 1368 |
| | Fast 4G | 15811 | 14988 | 9776 |
| | Slow 4G | 83942 | 81892 | 47907 |
| CT: far jump (last slice, at once) | home | 397 [393–441] | 171 | 197 [186–219] |
| | Fast 4G | 3393 | 3629 | 3043 |
| CT: scroll the 93 slices | home | 6826 | 5522 | 5178 |
| | Fast 4G | 33963 | 33533 | 20269 |
| CT: report panel; first reformat | home | 61; 63 | 47; 57 | 46; 59 |
| X-ray: click → image (5.7 MB) | home | 741 | 866 | 708 |
| | Fast 4G | 14968 | 14819 | 6077 |
| | Slow 4G | 83029 | 82118 | 32652 |
| Slide: first tile after click | home | 247 | 9 | 164 |
| | Fast 4G | 527 [434–568] | 218 | 1153 [1140–1162] |
| Slide: sharp at fit | home | 2354 | 603 | 751 |
| | Fast 4G | 7187 | 4747 | 4876 |
| Slide: sharp after zoom to full resolution | home | 1554 | 515 | 434 |
| | Fast 4G | 5122 | 3496 | 2805 |
| Download CT study (89.9 MB ZIP) | home, 20 MB/s | 13 MB/s | 13 MB/s | 15 MB/s |

The slide session downloads the same bytes in every build: 10.3 MB and 125 requests on desktop.

**Live data over the real network.** These runs read the live sample link; the page itself was served locally, main against branch, at load 14–15:
- MRI scroll: 2869 → 1303 ms;
- CT far jump: 481 → 225 ms, with stalls during the scroll down from 12 to 0;
- slide sharp at fit: 2199 → 736 ms; sharp at zoom: 1217 → 484 ms;
- download: 14.4 → 19.8 MB/s, on a link measured at 20–22 MB/s.

The live site as deployed (main) opens the overview in 0.45–2.2 s; the spread is wide on the real network. On a warm visit it takes 83 ms.

**Sharing** (/share with the files picked, home profile, 5 MB/s up):

| Study | Files, raw | After SV1 | Upload: main → branch | Link ready after "Share": main → branch |
|---|---|---|---|---|
| MRI (Josh Example) | 267, 44 MB | 27 MB | 7.5 → 7.5 s | 8.6 → 8.5 s |
| CT (Josh Example) | 458, 246 MB | 86 MB | 23.0 → 20.4 s | 24.8 → 22.1 s |
| CT (IDC covid_19_ny_sbu, CC BY 4.0) | 947, 500 MB | 207 MB | 52.8 s | 56.6 s |
| CT (IDC fdg_pet_ct_lesions, CC BY 4.0), unthrottled | 2297, 1.21 GB | 421 MB | 40.6 s | 50.4 s |

- **Without a link limit.** The page uploaded at about 10 MB/s on main. On the branch it uploads at 110 MB/s: the CT went up in 0.8 s instead of 8.9 s.
- **Compression** runs at about 110–120 MB/s of raw images (SV1, four workers), and is mostly done before "Share" is pressed.
- **The protocol path alone** (`upload-bench.ts`, 8 MiB appends) reaches 94% of a 5 MB/s uplink with one file and 98% with two.
- **Owner page** opens in 0.36–0.52 s.
- **Revoke:** 0.17 s until the page confirms, and 0.24–0.29 s until the link answers 404.

**SMART Imaging Access import** of the whole sandbox (313 MB, 72 series), home profile:
- search to review: 25.2 s on main, 20.6 s on the branch;
- pack and upload: 83 s on main, 74 s on the branch;
- total: 109 s on main, 96 s on the branch.

**Server** (`range-bench.ts`, record-aligned random ranges, 8 s per row):

| Store | 64 KiB, 16 clients | 1 MiB, 16 clients |
|---|---|---|
| Local, SQLite on tmpfs: main → branch | 11.5k → 15.3k req/s; p99 2.7 → 2.8 ms | 2.0 → 1.9 GB/s |
| Local, SQLite on a busy disk: main → branch | 2.3k → 13.3k req/s; p99 127 → 2.9 ms | 1.27 → 1.67 GB/s |
| S3 proxy (MinIO), branch before → after TCP_NODELAY | 1 client: p50 42 → 1.4 ms, 36 → 634 req/s | 1.3 GB/s |
| S3 redirect (MinIO), branch | 1 client: p50 1.2 ms; 16 clients: 4.3k req/s | 1.5 GB/s |

## Where the time went

Before the branch, the critical path of opening a link was:
1. HTML;
2. `view.js`, 247 kB uncompressed, then its chunks one round trip later;
3. the Bundle fetch, which started only when the scripts ran;
4. the decoder pool, which waited for the wasm (905 kB uncompressed), and then fetched `decoder-worker.js` eight times, one round trip apart (Fast 4G: 1.35 s);
5. the overview, which waited for the pool;
6. the thumbnails, every study's at once. Three radiographs (2.8–6.5 MB each) and the slide's coarsest level (about 4 MB) all shared the link.

In the viewer, Range reads of one file went one round trip apart, held by the browser's HTTP cache lock (below). Scrolling paid for those round trips, and on a 64 KiB record grid each separate instance read fetched 1.33× (CT) to 1.61× (MR) of its bytes.

## Changes, ranked by effect

1. **Range reads bypass the HTTP cache** (`cache: "no-store"` in `resolver.fetchRange`). With `cache: "default"`, Chromium's cache lock held each concurrent request to the same URL until the previous one's headers had arrived. A file's reads therefore went one round trip apart.
   - Gain: slide sharp at fit 2354 → 603 ms (home), CT far jump 397 → 171 ms.
   - Cost when done alone: more concurrent streams share the link, so the MRI's first slice on Fast 4G goes from 982 to 1502 ms. Change 3 takes this back.
2. **The overview no longer waits for the decoder; the Bundle is fetched from the HTML; assets are compressed, versioned and preloaded.**
   - The overview shows once the Bundle is decrypted.
   - `view/index.html` starts a direct link's Bundle request before the scripts load.
   - The page's assets drop from 1.29 MB to 0.34 MB with brotli, and all chunks are preloaded.
   - The worker script is fetched once.
   - Gain: overview 3.1 → 0.67 s on Fast 4G and 13.3 → 2.6 s on Slow 4G; warm visits need no revalidation.
3. **Record-level loader.**
   - A record already here, or already on its way, is not asked for again.
   - Queued neighbours join the request that starts, up to 2 MiB, or 512 KiB for prefetch, and records are handed on as they stream in.
   - Prefetch keeps less than 1 MiB in flight.
   - The slice on screen may go past the limit on requests.
   - Gain: CT series fetch 93 requests / 23.9 MB → 16–46 / 17.8 MB; MR DWI 18 requests / 1.4 MB → 2–4 / 0.13–0.26 MB; MRI first slice on Fast 4G 982 → 182 ms; CT scroll on Fast 4G 34.0 → 20.3 s.
4. **Overview scheduling.**
   - Small thumbnails first; radiographs and the slide then load one at a time, smallest first.
   - Opening a study stops the other studies' thumbnails and keeps its own.
   - Header reads for accession numbers and study times go at prefetch priority.
   - Gain: first thumbnail 4.97 → 1.60 s on Fast 4G; X-ray click → image 15.0 → 6.1 s on Fast 4G.
5. **Upload appends sent as a Blob.**
   - An XHR typed-array body costs Chromium about 14 MB/s and 120 ms of main thread per 8 MiB; a Blob of the same bytes goes at 170–285 MB/s.
   - Gain: CT unthrottled 8.9 → 0.8 s; on 5 MB/s, 23.0 → 20.4 s.
6. **Access log written by a background thread** (every 25 ms, one transaction per share; flushed before any read of the log).
   - Gain: a range read no longer waits on a SQLite INSERT. On the busy disk: 2.3k → 13.3k req/s, p99 127 → 2.9 ms.
7. **TCP_NODELAY on the server.** S3 proxy mode, 64 KiB ranges: 42 → 1.4 ms per read.
8. **Downloads read three 8 MiB runs ahead.** 13 → 15 MB/s on the home profile; 14.4 → 19.8 MB/s on the live link.
9. **SMART import retrieves three series at once.** Search to review: 23.6 → 20.6 s.

**Slide opened straight from the overview.** Main before these changes loaded the 4 MB slide thumbnail during the overview, so a slide opened at once found its headers and coarsest tiles already there. The branch loads it after the small thumbnails, so a slide opened at once starts from nothing. Fast 4G first tile went 527 → 1153 ms.

The progressive pyramid (e2e-2) takes the slide view part of the way back:
- After the first read of every header, the coarsest level's header is finished first and the pyramid is built from those reads. This applies only when every level is TILED_FULL with one frame per tile.
- The other levels' headers (ICC profiles, offset tables) are read once the first tiles are in, or when a frame of their level is wanted.
- When all headers are in, the pyramid is checked against the full one, and replaced if it differs.

Fast 4G, 1440×900, median of 3: first tile 1121 → 1001 ms, sharp at fit 4892 → 4931 ms, sharp at zoom 2814 → 2808 ms. Home: 158 → 145 ms. The overview is unchanged.

The rest of the 1 s is the first read of every header: about 0.45 MB, needed to find the coarsest level and check the slide is a plain one. Getting to main's 527 ms takes preloading during the overview again, which costs the overview its gain.

**Tried and dropped.** `Cache-Control: private, immutable` on `.bin` responses would let a second visit skip the download. It also made the browser's cache lock serialise every read of a file, and the cached partial entries broke the expiry of passcode capability URLs (the `cap-expiry` check). Josh's decision (16 Oct): share data is kept in memory only (the loader's record cache and the frame cache), never across page loads. The server now sends encrypted files with `Cache-Control: no-store`.

## Proposals (protocol or product: Josh's decision)

1. **Series thumbnails in the Bundle.** *Declined (Josh, 16 Oct): the Bundle carries only ImagingStudy indexing information.*
   - Problem: a radiograph's overview thumbnail costs its whole file (2.8–6.5 MB here). SV1 can't be decoded at reduced size, and none of the sample's files carries an icon.
   - Proposal: about 5–10 kB of JPEG per series, in `ImagingStudy.series`.
   - Gain: on Fast 4G each X-ray thumbnail drops from about 3–6 s to near zero, and on Slow 4G from about 16–36 s.
   - Cost: the Bundle grows by about 0.2 MB for a 26-series study, and the thumbnail is a derived, lossy rendering whose window the sharer chose.
2. **16 KiB records instead of 64 KiB.**
   - Gain: reading one instance on its own would fetch 1.08× its bytes instead of 1.33× (CT), and 1.15× instead of 1.61× (MR). For a slide session it would be 1.14× instead of 1.38× (CPTAC-BRCA, 3–17 kB tiles), or 1.02× instead of 1.05× (CPTAC-LUAD).
   - Cost: tag overhead goes from 0.024% to 0.098%, and decryption makes four times as many calls.
   - With the record-level loader, sequential reads already share boundary records. So the gain is mostly random access (jumps, thumbnails, slide tiles).
3. **Parallel or deferred-length uploads.**
   - Upload is the long pole of sharing: on a 5 MB/s uplink, about 75–85% of the time from "Share" to the link.
   - One file per study uploads as one stream. Two files reached 98% of the link, against 94% for one.
   - Overlapping compression with the upload needs `Upload-Length` to be given later (the draft allows it; the server requires it up front). That would save up to the compression time (2–10 s here).
   - Series-level files for very large studies would also allow parallel appends.

## Findings for other owners

- **Decoders (decode on the critical path).** X-ray click → image is 0.71 s on the home profile, of which the 5.7 MB download takes about 0.3 s (CR, SV1). The phone with 4× CPU throttling takes 0.93 s.
- **Whole-slide viewer.** Build the pyramid progressively (the known regression above), so the coarsest level shows before every level's header is read.
- **Viewer.**
  - `web/view/view.ts` still has a `console.log("DBG jump", …)` line.
  - The overview's slide thumbnail can't be cancelled: `seriesThumb` ignores its signal for slides.
- **Server.**
  - `access_log` has no index on `lid`, so each link's counts scan the whole log on every `/api/demo-shares` and owner page request; the cost grows with the log.
  - The live site sends no `Content-Encoding` and no `Cache-Control` for its assets. The branch fixes both, if the exe.dev proxy passes them on; check after deploying.
- **Checks.** `web/checks/objects/__pycache__/*.pyc` is tracked and changes on each run.
