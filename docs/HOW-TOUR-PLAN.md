# How it works: a guided tour

Status: draft for Josh, 15 Oct 2026. It replaces the current `/how` page with one coherent guided tour. Nothing is copied over as is; any existing widget that stays is redesigned to fit the tour.

## Decisions (Josh)

- **One slice is the thread.** The reader follows one real slice of Josh Example's brain MRI (a T2 axial slice from mid-brain) from the link to pixels on screen. Each step changes the same image the reader is looking at.
- **Format: scrollytelling.** A sticky panel shows the slice and whatever the current step is about. Short steps scroll past and drive it.
  - On desktop, the panel sits beside the text; on phones, above it.
  - It's a guided tour, not a quiz: no prompts, guesses or scores.
- **Two audiences, one tour.** The default text is for a broad audience: plain words, no jargon.
  - A "Show the details" switch (off by default, remembered per browser) adds a technical layer to every step for technical non-specialists: byte offsets, record numbers, the Range header, nonces, DICOM tags, code.
  - Every term is explained once when the details are on.
- **Real data only.** Every number and byte shown comes from the live public sample through the real protocol.
- **Heavy work never freezes the page.** It runs in workers with real, determinate progress (no indeterminate bars), and can be cancelled.

## The tour

| Step | Panel shows | Plain text says | Details layer adds |
|---|---|---|---|
| 1. The link | A QR code; then the decoded link card | A link holds an address and a key. The key never leaves your device. | The `shlink:/` payload as JSON: `url`, `key` (32 bytes), `flag`, `label`; why the fragment never reaches a server |
| 2. The index | The study list unfolding to series, then to this slice | Your browser fetches a small locked file, unlocks it with the key, and finds a table of contents for the whole study. | The Bundle size, JWE header, ImagingStudy and per-instance lengths |
| 3. The pieces | The file drawn as a strip of numbered pieces; this slice's pieces light up. The reader can drag across the strip: every image wholly inside the selection decodes and appears as a thumbnail, and images cut off at the edge say they need the next piece | The study is stored as small locked pieces. Your phone asks for just the pieces that hold this slice. | 64 KiB records, the byte offset to record arithmetic, the exact `Range` header, the requests the page actually made |
| 3b. What the host sees | The panel flips to the host's side of the same requests: random file names and byte ranges | The server delivering the pieces can't read them. This is everything it sees. | The access log lines as stored |
| 4. Unlocking | The pieces shown as noise, then unlocking into bytes. A "tamper" switch flips one bit in transit, and the piece is refused | Each piece is sealed so any change is detected. | AES-256-GCM, nonce = record index, the 16-byte tag, why each record can be checked on its own |
| 5. Bytes to pixels | The unlocked bytes with a few labels on the DICOM header (the file marker, the patient name "Example^Josh", rows and columns, where the pixels start), then the pixels drawn as the slice, with a brightness and contrast control | Inside is the original scanner file. Its header says what the image is; the rest is the picture. | Tags and values, transfer syntax, bits stored, window centre and width |
| 5b. A compressed image | The same step on one compressed slice from the corpus (JPEG 2000 or JPEG-LS), decoding in a worker | Many scanners compress their images; your browser decodes them itself. | The codec, decode time, and that the decoder is ours (pure Rust in WebAssembly) |
| 6. Fetching less | Scroll through the series, or zoom the lung slide; a live counter shows bytes fetched against the whole study | You only download what you look at, even for a gigabyte slide. | Bytes per request, the records reused from cache, the offset table on slides |
| 7. Share and revoke | Make a link for just this study, open it in the panel, revoke it, and watch the next request fail | You can share part of what you have, and take it back. | The new link's Bundle, the server's 404 after revocation, what revocation can and can't undo |

## Ending

- **Default:** "Now open it yourself", which opens the full viewer on the same sample, plus "Share your own".
- **With the details on, the ending adds a build path:**
  - **Build your own:** the short reference receiver that resolves the sample link using only `fetch` and WebCrypto, runnable here in a worker; the spec; the test vector.
  - **Decoder speed:** the in-browser benchmark against the C libraries, in a worker with real progress.

## Left out of the page

- **"How we know the decoders are right"** (the corpus and rulings) and the codec coverage tables: these belong to the blog post and the repo; the page links to them.
- **The sharing sandbox's wider controls,** beyond step 7.

## Engineering standards

- **Workers:** all decryption, decoding, the receiver and the benchmark run in workers. No main-thread task over 100 ms; a check enforces it.
- **Progress:** progress bars measure real work against a known total; the text and the bar agree.
- **Motion:** the steps animate the panel; `prefers-reduced-motion` turns transitions into cuts.
- **Dark mode and phones:** both supported and checked, with targets of at least 44 px.
- **Copy:** plain, true and short, per the repo's copy rules. One plain sentence per step, with the detail layer for the rest.
- **Format change:** it works on the current format and on the study-level files from docs/STUDY-FILES-AND-S3-PLAN.md. Copy says "file" and "pieces", not "series file", and reads offsets through `web/core`.
- **Checks:** scripted desktop and phone runs through every step, with the details off and on. They also confirm that the tamper switch refuses, that revocation gives 404, that the receiver and benchmark finish with progress and without long tasks, and that every number shown matches the live sample.
