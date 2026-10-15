# jpeg-ls

**Crate:** `shl-codec-jpeg-ls`

**Specifications:** ITU-T T.87 | ISO/IEC 14495-1 (JPEG-LS: LOCO-I, context modelling, Golomb coding, run mode); DICOM PS3.5 A.4.3

## Corpus

| Transfer syntax | Cases |
|---|---|
| `1.2.840.10008.1.2.4.80` | 28 |
| `1.2.840.10008.1.2.4.81` | 15 |

Sources: generated 31, pydicom 12. Multi-frame cases: 4. Ground truth from seeds: 21.


## Traps

- Near-lossless (NEAR > 0, `.81`): the reconstruction must use NEAR quantisation exactly. The oracle tolerance is 1 unless references disagree, so aim for exact.
- Interleave modes ILV 0 (plane), 1 (line) and 2 (sample) for colour.
- LSE marker segments: custom preset thresholds (T1/T2/T3, RESET) and, rarely, mapping tables.
- The HP colour transforms (non-standard APP8 'mrfx' markers written by some encoders); CharLS supports them.
- Bit depths 2–16; MAXVAL other than 2^P − 1.
- Four pydicom files (`pydicom-JLS*_RGB_*`) have no DICOM Part 10 header (no preamble or `DICM`), so the CLI must read bare data sets too.

## Candidate crates

`pure_jpegls` (from the dicos.rs project; small user base). Otherwise build: about 1–1.5k lines.

## Decision

**Build.** `shl-codec-jpeg-ls` is our own decoder (`#![forbid(unsafe_code)]`, no dependencies beyond `shl-codec-common`, about 1,100 lines plus tests).

`pure_jpegls` 2.0.0 (MIT OR Apache-2.0, pure Rust) was evaluated by decoding every extracted corpus frame with `jpegls::decode`. It decoded 30 of 43 cases (pixels not compared) and failed the rest:

- **9 colour cases:** it rejects multi-component frames (`Nf != 1`) and interleave modes 1 and 2 as unsupported. Its README states the same scope.
- **4 DCMTK cases:** `expected EOI (0xFFD9) after scan, got 0xFFFF`. DCMTK pads odd-length streams with a fill byte before EOI (`FF FF D9`), which JPEG marker syntax allows.

Adopting it would have meant writing colour and interleave support ourselves, which is most of the remaining work. Building was the smaller job.

## Rulings

None needed. No case is disputed, and every case matches its oracle exactly (maximum difference 0), including the 15 near-lossless cases where the tolerance is 1.

Interpretations taken where T.87 leaves room or the corpus does not reach:

- **Sample-interleaved (ILV 2) run interruption.** All components are coded with run-interruption context 0 (RItype 0): prediction Rb, sign from Rb − Ra. This follows CharLS and matches the T.87 conformance streams T8C2E0/T8C2E3.
- **Restart markers.** At each RSTm the decoder resets the context variables and run indices, and treats the line above as zero, as at the start of a scan. This matches CharLS, which decodes our spliced restart test streams identically.
- **Missing EOI** after a complete image is accepted. Fill bytes (`FF` repeated) before any marker are skipped.
- **Codestream dimensions or component count** that differ from the DICOM Rows, Columns or Samples per Pixel are `Invalid`. So is a precision above Bits Allocated.

## STATUS

**check.py: jpeg-ls pass = 69 / 69** (CLI `shl-dicom-decode`; the corpus grew from 43 cases). The four pydicom files without a Part 10 header pass through the CLI.

**Tests (`cargo test -p shl-codec-jpeg-ls`):**

- **`tests/corpus.rs`:** decodes every frame from `extract_frames.py` and compares it with `oracle/<case>.npy`, applying the CLI's Bits Stored mask and sign extension. 68 of 69 match, all exactly. The YBR_FULL case `ext-orthanc-jpegls80-YBR-FULL` is skipped there, because the codec returns YBR and the CLI converts it to RGB; check.py covers it.
- **`tests/vectors.rs`:** 114 extra vectors from `extra/gen_vectors.py`, compared exactly with CharLS's decode. All pass. The vectors cover:
  - the T.87 conformance streams shipped with pyjpegls (T8C0/1/2 E0/E3, T16E0/E3, T8NDE0/E3 with non-default T1/T2/T3/RESET), except the subsampled T8SS*;
  - CharLS encodes at every precision from 2 to 16 bits with NEAR 0, 1 and 3;
  - 3- and 4-component images at 8, 12 and 16 bits, in ILV 0, 1 and 2, lossless and NEAR 2;
  - edge shapes (1×17, 17×1, 300×3) and a 5000-sample run;
  - DCMTK streams with LSE presets (lossless and NEAR 2), and DCMTK cooked mode;
  - HP colour transforms 1, 2 and 3 (APP8 `mrfx`) at 8 and 16 bits;
  - restart intervals (DRI + RSTm) for mono, ILV 1 and ILV 2, including NEAR > 0.

  The vectors are generated, not committed (`extra/.gitignore`). Without them the test skips.
- **Unit tests:** bit reader (stuffing, unary codes, fill bytes), the short-code Golomb table against the general decoder for every (k, byte), the closed-form Golomb k, default thresholds against T.87 C.2.4.1.1.1, mapping tables (LSE ID 2), and malformed input (every truncation of a stream, bad precision, NEAR, ILV, and dimension mismatch).

**Supported:**

- lossless and near-lossless;
- ILV 0, 1 and 2, with 1 to 4 components (ILV 2) or any number (ILV 0 and 1);
- P = 2 to 16, with Bits Allocated 8, 16 or 32;
- LSE ID 1 (MAXVAL, T1–T3, RESET) and ID 4 (oversize dimensions);
- LSE ID 2 and 3 mapping tables with 1- or 2-byte entries;
- DRI and restart markers;
- HP transforms. The output is then flagged `ColorOut::Rgb`.

**Known gaps (`Unsupported`, exit 3):**

- component subsampling (H/V ≠ 1; DICOM does not use it with JPEG-LS);
- mapping-table entries of 3 bytes or more;
- point transform ≠ 0;
- DNL;
- P > 16.

HP transforms are verified only for ILV 2: CharLS's own legacy-API decode of ILV 1 with a transform does not round-trip, so it cannot serve as a reference there. Mapping tables are covered only by a unit test, because no reference encoder in the environment writes them.

**Fuzzing:** `cargo fuzz` target `fuzz/fuzz_targets/decode.rs` takes Rows, Columns and Samples per Pixel from the input's own SOF55, so mutations reach the scan decoder. Debug assertions are on, so integer overflow also panics. Seeded with all corpus frames and the extra vectors (151 seeds). Three runs, each with 4 forked workers, all with **0 crashes, 0 timeouts and 0 OOMs**:

- the first decoder: 723 s, about 1.7 M executions;
- after the speed work: 725 s, about 9.7 M executions, coverage 3,020;
- after the final bit-reader change: 676 s, about 3.0 M executions under heavy machine load.

Set `TMPDIR` to a directory on disk: libFuzzer's fork mode writes its temp files there, and they can fill a small /tmp. It ran with `-s none` (no ASan; the crate is `forbid(unsafe_code)`) under `RUSTC_BOOTSTRAP=1 cargo +stable fuzz`, because the installed nightly is too old for current cargo-fuzz.

**Speed:** see [PERF.md](PERF.md). Mono lossless and near-lossless decode at or below CharLS's time. Sample-interleaved colour is 1.05–1.26× CharLS (cine is the worst case). The geometric mean over the 8 benchmark cases is about 1.04–1.09× CharLS natively, down from 1.83×.

**Build checks:** `cargo clippy --all-targets -D warnings` is clean, and `cargo build --target wasm32-unknown-unknown -p shl-codec-jpeg-ls` succeeds (with the rustup stable toolchain; the system Arch rustc has no wasm32 std).
