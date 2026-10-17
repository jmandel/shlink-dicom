# Reading-session benchmark

Scripted reading sessions in headless Chromium, one per kind of study. A person's pace, a fixed script, and the time until the right pixels are on screen for every step. It is for comparing builds of the viewer and the format (for example two record sizes) on the same data, over shaped network links.

## What a session does

`sessions.mjs` holds the scripts. Each step is fixed, with no randomness, so every build sees the same session:

| Kind | Study | Steps |
|---|---|---|
| `ct` | Sample CT (Josh Example), 93-slice axial series | open; scrub 30 slices at 8/s and 30 back at 25/s; rock ±8 slices three times at 15/s; pause 1.5 s; jump to the far end; switch series twice; coronal reformat, then 10 and 20 mm slabs |
| `mri` | Sample brain MRI | open; scrub 16 at 8/s and 16 back at 25/s; rock; pause; jump; switch series twice |
| `cr` | Sample wrist radiographs | open; switch to the next view twice |
| `slide` | Sample lung slide (CPTAC-LUAD) | open; fit; three regions at full resolution, each with four half-screen pans |
| `us` | Ultrasound cine (JPEG baseline, multi-frame) | open; play 4 s; scrub the frames as above |
| `enhct` | Enhanced CT (one multi-frame instance, 112 frames) | open; scrub the frames as above |
| `mg` | Mammography, four views | open; step through the views |
| `tomo` | Breast tomosynthesis (multi-frame) | open; scrub the frames |
| `dx` | Large DX | open |
| `slidej2k` | Slide in JPEG 2000, 256-pixel tiles (CPTAC-OV), shared with offset tables | as `slide` |
| `slidejxl` | Slide in JPEG XL (lossless recompression of a TCGA slide's JPEG tiles) | as `slide` |
| `video` | H.264 video, 1280×720 | open; play 4 s |

## What it measures

**Operations.** Each operation's latency is from its input until the right pixels are on screen:

| Operation | Done when |
|---|---|
| `open` | the study's first picture is drawn: a slice, a slide tile, or a video ready to play |
| `step` | a scrub's slice is drawn, or a slice asked for after it in the same scrub (a step the screen skipped past counts as caught up) |
| `jump`, `switch` | the slice asked for, or the other series' first slice, is drawn |
| `mpr` | the reformatted plane is drawn |
| `play` | the frame moves on; then the frames shown in the next few seconds |
| `fit`, `zoom`, `pan` | every tile the slide view needs is on screen |

The viewer logs every drawn picture in `window.__view.drawLog`, and `window.__wsi.idle()` says when every tile a slide view needs is on screen.

**Sessions.**
- Stalls: steps slower than 250 ms, or never drawn within the cap.
- Session time.
- Bytes and requests, from Resource Timing.

An operation that waits longer than the cap counts as "over cap": 30 s at home, 60 s on Fast 4G and Slow 4G.

## Running it

1. **Servers.** One server per share and build, seeded with `shl-dicom-server seed` (the sample, and the second share in `samples/*.tgz`). Slides the seed can't pack are shared with `share-files.ts`, which uses the Share page's packer with offset tables added.
2. **Shaped links.** Put `shaper.mjs` in front of each server: TLS HTTP/2, one round trip per request, and a shared downlink and uplink.

   ```sh
   node perf/sessions/shaper.mjs 36010=3550:50:20000000:5000000     # home: 50 ms, 20 MB/s down, 5 MB/s up
   node perf/sessions/shaper.mjs 36020=3550:165:1012500:168750      # Fast 4G (Chrome DevTools' figures)
   node perf/sessions/shaper.mjs 36030=3550:562:180000:84375        # Slow 4G
   ```

   It needs a self-signed certificate (`SHAPER_TLS`, a folder with `key.pem` and `cert.pem`).

   Chrome DevTools' own throttling isn't used. It delays response headers one latency after another, and the browser's cache lock does the same to same-URL requests, so request counts would be over-weighted.
3. **Sessions.**

   ```sh
   node perf/sessions/run.mjs --build=main --sample=https://127.0.0.1:36010 --extras=https://127.0.0.1:36011 \
     --j2k=shlink:/… --jxl=shlink:/… --net=home --device=desktop --runs=5 --out=results.jsonl
   ```

   Options:
   - `--device=phone` is 390×844 at DPR 3 with 4× CPU throttling.
   - `--kinds=ct,mri` runs only those sessions.
   - `--reqlog=FILE` also writes each session's encrypted-file requests (Range, start, end, bytes) and the pictures drawn, to see why a step waited.
   - Each session runs in a fresh browser context, with an empty cache.
4. **Comparing builds.** Interleave them run by run: one run of each build, the order rotating. Keep each build's blobs in the page cache before its run: a cold disk adds seconds to whichever build runs first.
5. **Tables.** `python3 perf/sessions/aggregate.py results.jsonl` gives, per profile and kind, every operation's p50 and p95 per build with its sample count, then the session medians.
   - `--summary` adds one table per profile, a row per kind.
   - `--max-load=8` leaves out sessions that ended with the machine busy with other work, and says how many.

`record-bench.mjs` measures the decryption side of the record size on its own: AES-GCM records of 64, 32 and 16 KiB, encrypted as the Share page does and decrypted as the viewer does, at 1× and 4× CPU.

## Data

The sample is the server's own (Josh Example MRI, CT and radiographs; the CPTAC-LUAD slide, CC BY 4.0).

The second share, all CC BY 4.0 unless noted:

| Kind | Source | Licence |
|---|---|---|
| Ultrasound cine | IDC, prostate_mri_us_biopsy, series 1.3.6.1.4.1.14519.5.2.1.207534918351073936173410777062742404217 | CC BY 4.0 |
| Enhanced CT | NEMA sample CT0070, from the fo-dicom test data | MS-PL (repository) |
| Mammography | IDC, cmb_brca, series 1.3.6.1.4.1.14519.5.2.1.207776098961005429284467902411167871841 | CC BY 4.0 |
| Tomosynthesis | IDC, ea1141, series 1.3.6.1.4.1.14519.5.2.1.1620.1225.306449628210154529440732572726 | CC BY 4.0 |
| DX | IDC, covid_19_ny_sbu, series 1.3.6.1.4.1.14519.5.2.1.99.1071.22549893039624978175236037360561 | CC BY 4.0 |
| Slide, JPEG 2000 | IDC, CPTAC-OV (web/view/WSI.md, `ov-j2k`) | CC BY 4.0 |
| Slide, JPEG XL | TCGA-05-5425 BS2, its JPEG tiles recompressed losslessly by cjxl (WSI.md, `jxl-recompress`) | CC BY 4.0 (changed) |
| Video | `test_720.dcm` from the fo-dicom test data | MS-PL (repository) |

None of these files is committed. The scripts that fetch IDC series are in `codec-corpus/scripts/sources/`.
