# Vendored crates

## hayro-jpeg2000 0.4.1, patched

Source: crates.io `hayro-jpeg2000` 0.4.1 (MIT OR Apache-2.0, <https://github.com/LaurenzV/hayro>),
copied unchanged except for the patches below and a trimmed `Cargo.toml` (no `image`
feature, no examples or dev-dependencies; `src/integration.rs` removed with that feature).
`hayro-jpeg2000-0.4.1-shl.patch` is the full source diff against the crates.io release.
Upstream master (commit 9fbc9ef, 2026-10-14, unreleased) still has the bugs behind
patches 1 and 4. It has rewritten the progression iterators (the patch 2 fixture decodes
there without a panic) and adds RGN and POC support, which would replace patch 3. When a
release after 0.4.1 ships, re-vendor it and keep only the patches it still needs.

| # | File | Change | Why |
|---|---|---|---|
| 1 | `src/j2c/codestream.rs` | `MAX_LAYER_COUNT` 32 → 255 | Layers are counted in a `u8` and nothing else depends on the cap. RareCyte slides in IDC use 33 layers and failed with "failed to parse COD marker". |
| 2 | `src/j2c/progression.rs` | LRCP iterator wraps at the largest resolution count over all components and skips components that lack the current resolution, as the RLCP iterator already did | Components may have different decomposition levels (COC). The old code compared against one component's count and then panicked in `ResolutionTile::new`. Found by fuzzing. |
| 3 | `src/j2c/codestream.rs` | Main-header RGN is refused as unsupported (it was skipped) | Region-of-interest scaling is not implemented in 0.4.1, so skipping the marker decoded wrong samples silently. A tile-part RGN was already refused. |
| 4 | `src/reader.rs` | The bit stuffed after an 0xFF byte in a packet header is skipped whatever its value | T.800 B.10.1 says it is 0, but an Aperio encoder in IDC writes a 1. Hayro treated that as an error, and in its lenient mode silently dropped the rest of the tile (max \|diff\| 89 on a lossless frame). OpenJPEG reads only the low 7 bits of that byte, so it ignores the bit too. |
| – | `src/lib.rs` | `#![allow(clippy::all)]` | The crate is a workspace member by path; upstream style is not linted against our `clippy -D warnings`. |

Regression tests for patches 1–4 are in `../tests/regressions.rs`. Patches 1 and 4 are
worth offering upstream; patch 4 also matters for hayro's PDF use.
