# Decoder work: how agents divide and run it

Goal: a pure-Rust decoder for DICOM pixel data that matches the reference decoders on every case in this corpus, builds for `wasm32-unknown-unknown`, and never panics on bad input. "Pure Rust" means Rust code and crates from crates.io only: no C or C++ (no `-sys` crates, no `build.rs` compiling C), and no JavaScript or WASM codecs.

Read `CONTRACT.md` first. It defines the command every decoder implements and the pixel format it is checked on.

## Layout and ownership

```
codec-corpus/                 test data and checking (Python)
  formats/<fmt>/              one directory per codec family
    FORMAT.md                 scope, spec references, candidate crates, rulings, STATUS
    cases.json                manifest (committed); samples/ and oracle/ are generated
  scripts/ seeds/ prevalence/ reports/
codecs/                       Rust workspace, separate from the main crates/ workspace
  Cargo.toml                  workspace; owned by the coordinator
  shl-codec-common/           shared types (coordinator, phase 0)
  shl-codec-<fmt>/            one crate per codec family; owned by that format's agent
  shl-dicom-decode/           CLI implementing CONTRACT.md; DICOM parsing, frame
                              extraction, colour and sign normalisation, dispatch;
                              coordinator-owned after phase 0
```

**Ownership rules.** These are what let format agents run in parallel without conflicts:

1. **Format agents write only in their own two directories:** `codecs/shl-codec-<fmt>/` and `codec-corpus/formats/<fmt>/`. Each codec crate has its own `Cargo.toml`, so a format agent adds dependencies there without touching shared files.
2. **Shared files belong to the coordinator** and are changed only by it, or by an agent whose brief says so:
   - `codecs/Cargo.toml`;
   - `shl-codec-common`;
   - `shl-dicom-decode`;
   - `codec-corpus/scripts/`, `CONTRACT.md` and this file.

   An agent that needs a change in a shared file stops and describes it in its report.
3. **Separate build directories.** Each agent builds with `CARGO_TARGET_DIR=codecs/target/<fmt>`, so builds don't wait on each other's lock.
4. **New test cases** go in the agent's own `cases.json` through `generate.py` or `discover.py` filtered with `--only <fmt>`. If those scripts can't express the case, ask the coordinator. Never edit another format's cases.
5. **No git commits by subagents.** The coordinator reviews and commits.

## The codec interface (`shl-codec-common`)

```rust
pub struct FrameInfo {
    pub rows: u32, pub columns: u32,
    pub samples_per_pixel: u16,        // 1 or 3
    pub bits_allocated: u16,           // 8, 16, 32
    pub bits_stored: u16,
    pub pixel_representation: u16,     // 0 unsigned, 1 signed
    pub photometric: Photometric,      // as declared in the dataset
    pub planar_configuration: u16,
    pub transfer_syntax: &'static str,
}

pub enum DecodeError {
    Unsupported(String),               // valid but not handled yet  -> CLI exit 3
    Invalid(String),                   // malformed codestream        -> CLI exit 2
}

/// Decode one frame's codestream into samples: (rows, columns, samples) interleaved, little-endian,
/// Bits Allocated width. Codecs that carry their own colour transform (JPEG YCbCr, JPEG 2000 RCT/ICT)
/// return RGB and say so in the result; the CLI converts any remaining YBR photometric to RGB,
/// interleaves planar data, and masks or sign-extends to Bits Stored.
pub fn decode_frame(codestream: &[u8], info: &FrameInfo) -> Result<DecodedFrame, DecodeError>;
```

Each `shl-codec-<fmt>` crate exposes exactly that function. Phase 0 creates every codec crate as a stub returning `Unsupported`, so the dispatch table in `shl-dicom-decode` is complete from the start, and format agents never need to touch it.

## Phases and dependencies

```
Phase 0  foundation (serial, one agent)
         codecs workspace, shl-codec-common, stub crates, shl-dicom-decode CLI,
         DICOM parsing (dicom-rs), frame extraction, colour/sign/planar normalisation,
         uncompressed + deflate  ──►  `uncompressed` passes 100%
            │
Phase 1  in parallel, each needs only phase 0
            ├─ rle             shl-codec-rle
            ├─ jpeg            shl-codec-jpeg      (formats jpeg-dct AND jpeg-lossless:
            │                                       shared marker and Huffman code, one owner)
            ├─ jpeg-ls         shl-codec-jpeg-ls
            ├─ j2k-survey      evaluate pure-Rust JPEG 2000 / HTJ2K crates on the corpus;
            │                  recommend adopt or build, for each of the two formats
            └─ prevalence      real-world frequency of transfer syntaxes and pixel profiles
            │
Phase 2  depends on the j2k-survey decision
            if adopting:  jpeg2000 and htj2k in parallel (thin wrappers + edge cases)
            if building:  jpeg2000 core first (codestream, tier-2, MQ/EBCOT, DWT, MCT),
                          then htj2k (HT block decoder plugged into the jpeg2000 pipeline);
                          the HT block decoder can start in parallel once the
                          code-block interface is fixed by the jpeg2000 agent
            │
Phase 3  integration (serial, coordinator)
         shl-dicom-core uses shl-dicom-decode's library in place of its own pixel code
         (dicom_io.rs decoders, jpeg12.rs); WASM size and speed check; fuzzing across codecs;
         coverage estimate from prevalence × check results
```

## Workflow for a format agent

1. **Set up and record a baseline.**
   ```sh
   cd codec-corpus && uv sync
   uv run python scripts/discover.py && uv run python scripts/generate.py && uv run python scripts/oracle.py   # only if samples/ is empty
   cd ../codecs && CARGO_TARGET_DIR=target/<fmt> cargo build --release -p shl-dicom-decode
   cd ../codec-corpus && uv run python scripts/check.py --name <fmt> --format <fmt> \
       --candidate "../codecs/target/<fmt>/release/shl-dicom-decode {in} {out}" --quiet
   ```
2. **Read `formats/<fmt>/FORMAT.md`:** its scope, spec references, candidate crates and known traps.
3. **Choose to adopt or build:**
   - **Adopt** an existing pure-Rust crate only if all of these hold:
     - it is pure Rust and builds for wasm32;
     - its licence is MIT, Apache-2.0, BSD or zlib;
     - wrapped in your crate, it passes the corpus;
     - a short fuzz run finds no panics or hangs;
     - its code is readable enough to fix.
   - **Otherwise build it,** with `#![forbid(unsafe_code)]`.
   - Record the decision and its evidence in `FORMAT.md`.
4. **Iterate until done.** Implement, then run `check.py` for your format. Write unit tests in your crate for internal pieces (bit readers, Huffman tables, predictors and so on), using small hand-checked vectors. The corpus is the integration test.
5. **Robustness:** no `unwrap`, indexing or arithmetic that can panic on input-derived values. Check lengths and dimensions before allocating, and cap allocations by `rows × columns × samples × bytes` from `FrameInfo`. Run `cargo fuzz` (or a quick loop of mutated corpus files) for at least 10 minutes, and turn every finding into a regression test.
6. **Report:** update the STATUS section of `FORMAT.md` with:
   - pass/fail counts;
   - every case still failing, and why;
   - rulings on disputed cases;
   - known gaps;
   - fuzz results.

   Finish with a short summary for the coordinator, including any shared-file change you need.

**Done means:**
- every `expect=decode` case in your format passes;
- every `expect=error` case exits 2;
- nothing crashes;
- `cargo test`, `cargo clippy -D warnings` and a `wasm32-unknown-unknown` build of your crate succeed;
- `FORMAT.md` STATUS is current.

## Rulings and oracle disputes

- **When the oracle looks wrong:** a disputed case, or references that disagree, means the oracle may be wrong, not you. Investigate against the standard: DICOM PS3.5 Annex A for encapsulation and the codec's own spec. Write the ruling in your `FORMAT.md` with the evidence.
- **Changing an expectation:** if the expectation must change, describe the change for the coordinator, who applies it in `oracle.py` or `cases.json`. Never weaken a check to make a case pass.

## Coverage claims

Two numbers are kept apart in all reporting:

- **What we decode correctly:** check results by format and by pixel profile, from this corpus.
- **How common each profile is in practice:** from `prevalence/`.

The estimate "decodes about N% of real-world studies" is the share of studies, in the prevalence data, whose every instance has a profile we pass. It comes with the dataset it was computed on and that dataset's known biases.
