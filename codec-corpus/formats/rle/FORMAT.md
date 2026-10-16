# rle

**Crate:** `shl-codec-rle`

**Specifications:** DICOM PS3.5 Annex G (RLE Lossless): 64-byte header with up to 15 segment offsets; PackBits per segment

## Corpus

| Transfer syntax | Cases |
|---|---|
| `1.2.840.10008.1.2.5` | 34 |

Sources: generated 22, pydicom 12. Multi-frame cases: 8. Ground truth from seeds: 22.

## Traps

- Segments run most-significant byte first: a 16-bit sample is 2 segments (high byte, then low), and an RGB 16-bit pixel is 6.
- Segment order for colour is all bytes of R, then G, then B. The output is planar by nature, so interleave it.
- Each segment decodes to exactly rows × columns bytes; stop at that count. A segment up to one row short is padded with 0 (see [Rulings](#rulings)); a larger shortfall is an error.
- 32-bit samples (4 segments per sample) and multi-frame data (one fragment per frame).

## Candidate crates

None needed: about 200 lines. Write it yourself with `#![forbid(unsafe_code)]`.

## Decision

**Built**, as planned: `codecs/shl-codec-rle/src/lib.rs`, about 150 lines of decoder plus unit tests, `#![forbid(unsafe_code)]`, no dependencies beyond `shl-codec-common`. No crate was evaluated; the format is small enough that a dependency would cost more to vet than to write.

How it decodes:

- Header: segment count 1 to 15, then one offset per segment. Segment *i* runs from its offset to the next segment's offset; the last runs to the end of the frame. Unused offset slots are ignored.
- The segment count must equal Samples per Pixel × Bits Allocated / 8 exactly.
- Segment *k* of sample *s* (k = 0 is the most significant byte) fills byte `bps − 1 − k` of each little-endian sample in plane *s*.
- Output is planar (`planar: true`) whatever Planar Configuration says, because RLE segments are planar by construction (PS3.5 G.2). Colour is `AsDeclared`; the CLI converts YBR_FULL to RGB.
- Before allocating, the frame must be at least `frame_bytes / 64` bytes long (PackBits expands 2 bytes to at most 128).

## Rulings

No corpus case is disputed. The rulings below cover one real-world defect and the decoder's leniency choices, with the standard's position on each.

- **Segment decodes past rows × columns.** PS3.5 G.3.1 says each segment holds exactly rows × columns bytes and that runs do not cross row boundaries, but it gives a decoder no instruction for overruns. We stop at rows × columns and ignore the rest of the segment (trailing pad bytes, a run that overshoots, any extra data). pydicom's RLE decoder (`pydicom/pixels/decoders/rle.py`) does the same: it warns about "non-conformant padding" and keeps the first rows × columns bytes. Refusing would reject real files for no gain.
- **Segment decodes short of rows × columns, by at most one row (coordinator ruling).** Case `ext-gdcm-ALOKA_SSD-8-MONO2-RLE-SQ` (420 × 608, 8-bit MONOCHROME2) has a segment that decodes to 255,359 bytes instead of 255,360, one byte short. PS3.5 G.3.1 requires exactly rows × columns bytes, so the file is non-conformant. dcmtk pads the missing bytes and decodes it; pydicom and pylibjpeg refuse it. The oracle comes from dcmtk only, so it is marked WEAK. The encoding census (`prevalence/CENSUS.md`) recommends tolerating defects like this. Ruling: a segment that ends at most `columns` bytes short is accepted, and the missing bytes are set to 0, as dcmtk does. A larger shortfall is still `Invalid` (exit 2), because by then real image data is missing. The limit applies to each segment separately, so a 16-bit or colour frame can have a short tail in several planes. Unit test: `short_segment_up_to_one_row_padded_with_zero`.
- **Literal run cut short by the end of the segment.** Uses the bytes that are present, then applies the shortfall rule above.
- **First offset not 64.** G.5 says the first segment follows the header, so its offset is 64. We accept any offset at or after 64 and up to the frame length, as long as offsets don't decrease, since a gap between header and data is harmless. Offsets below 64, past the end of the frame, or decreasing are `Invalid`.
- **Segment count mismatch** (for example 1 segment for 16-bit data, or more segments than needed): `Invalid`. pydicom refuses these too ("The number of RLE segments ... doesn't match the expected amount").
- **Bits Allocated other than 8, 16 or 32, or Samples per Pixel other than 1 or 3:** `Unsupported` (exit 3). Rows or Columns of zero: `Invalid`.
- **-128 header byte:** no-op, as in PackBits and G.3.1.

## STATUS

**check.py (CLI): 53 of 53 cases pass**, with `shl-dicom-decode` built from `codecs/` (`check.py --name rle --format rle`). That is the 34 original cases plus 3 generated benchmark cases (640×480×30 RGB cine, 512² CT, 2048² 12-bit DX) and the 16 `ext-*` quirk-set cases. Among them:
- YBR_FULL data (dcm4che, ACUSON, Orthanc with Planar Configuration 1);
- RGB48 multi-frame;
- fragmented frames (`D_CLUNIE_CT1_RLE_FRAGS`);
- palette colour;
- the one-byte-short ALOKA segment (see [Rulings](#rulings)).

There are no `expect=error` cases.

**Codec level: 53 cases, 263 frames.** The test is `codecs/shl-codec-rle/tests/corpus.rs`. It decodes every frame dumped by `scripts/extract_frames.py --format rle`, interleaves the planes, masks or sign-extends to Bits Stored as the CLI will, and compares with `oracle/<case>.npy`. All non-YBR frames match exactly. The 4 YBR frames decode but are not compared at this level, because the oracle is RGB and the conversion happens in the CLI; check.py covers them.

**Other checks:** these all pass.
- `cargo test`: 10 unit tests, the corpus test and the fuzz test.
- `cargo clippy --all-targets -- -D warnings`.
- `cargo build --target wasm32-unknown-unknown`, using toolchain 1.96.0 via rustup; the system toolchain has no wasm target.

**Fuzzing:** two harnesses.
- `fuzz/fuzz_targets/decode.rs` (cargo-fuzz) checks every frame `decode_frame` accepts against a direct per-segment reading of PS3.5 Annex G (each segment decoded on its own, its bytes placed sample by sample). The input picks rows, columns, samples per pixel and Bits Allocated. Seeded with the corpus frames, with debug assertions on: 1.7 million runs, no crash and no difference. It ran with `-s none` under `RUSTC_BOOTSTRAP=1 cargo fuzz`, as for [JPEG-LS](../jpeg-ls/FORMAT.md#status).
- `tests/fuzz_mutate.rs` mutates corpus frames under `cargo test`: byte flips, insertions, deletions, truncation, header-word rewrites and PackBits control-byte fills. A quarter of the inputs also perturb FrameInfo (rows, columns, samples, bits, including huge dimensions). It asserts no panic, and that every successful decode returns exactly `frame_bytes`. It runs 20,000 iterations under `cargo test`; set `RLE_FUZZ_ITERS` and `RLE_FUZZ_SEED` for longer runs.
  - Before the shortfall ruling: 4 seeds × 50 million inputs, no panics or hangs.
  - After it: 4 seeds × 25 million inputs (100 million in total, about 90 CPU-minutes, seeded from all 53 cases), no panics or hangs. About 30% of the mutated inputs still decoded, each to the right length.

There were no findings, so no regression tests came from fuzzing.

**Known gaps:** none in scope. RLE with Bits Allocated 1 is returned as `Unsupported`; no corpus case uses it.
