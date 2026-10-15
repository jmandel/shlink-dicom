# Vendored crates

## oxideav-jpeg2000 0.0.17, patched for speed

Since phase 2d, `shl-codec-htj2k` decodes through the vendored hayro in `shl-codec-jpeg2000`
(its patch 5 adds HT decoding). oxideav is the fallback for what hayro declines (MIXED
code-blocks, more than one HT set) and the cross-check in `../tests/cross_check.rs`.

Source: crates.io `oxideav-jpeg2000` 0.0.17 (MIT, <https://github.com/OxideAV/oxideav-jpeg2000>).
The crates.io source is identical to the repository's `v0.0.17` tag. It is copied unchanged
except for the patches below and these trims:
- `Cargo.toml` is rewritten without the optional `registry` feature (the `oxideav-core`
  bridge), and `src/registry.rs` is removed;
- `tests/data/` holds the five fixtures from the `v0.0.17` tag that the crate's own unit
  tests read with `include_bytes!` (crates.io excludes `/tests`, so `cargo test` would not
  build without them).

`oxideav-jpeg2000-0.0.17-shl.patch` is the full source diff against the crates.io release,
apart from the removed `registry.rs`.

| # | File | Change | Why |
|---|---|---|---|
| 1 | `src/t1.rs`, `src/reassemble.rs` | `CodeBlock::effective_nb_map` resolves the per-coefficient `Nb(u, v)` source once per code-block; the 5/3 and 9/7 sub-band reassembly loops use it, and the 5/3 loop returns `qb` directly when `Nb ≥ Mb` instead of going through `f64` | `effective_nb` called `max_decoded_bits()`, a scan of the whole block, for every coefficient: quadratic in the block size, 4,096 × 4,096 reads per 64×64 block. This was the 67% "reassembly" share of the profile. |
| 2 | `src/ht.rs` | `test_match` looks the CxtVLC codeword up in a `(cq, length, codeword)` index built at compile time from the same tables, instead of searching the 444- or 358-entry table linearly after every bit | 70% of the time once patch 1 was in. The first match in table order wins, as before; a unit test (`cxt_vlc_index_matches_linear_search`) checks the index against the linear search for every input. |
| – | `src/lib.rs` | `#![forbid(unsafe_code)]` (upstream has no `unsafe`); `#![allow(clippy::all, unexpected_cfgs)]` | The crate is a workspace member by path; upstream style is not linted against our `clippy -D warnings`, and the removed `registry` feature is still named in `cfg`s. |

Both patches change speed only. On 2,320 inputs (corpus frames and the HTJ2K fuzz corpus),
the patched crate returns exactly the same samples or the same error as crates.io 0.0.17.
The method and timings are in `codec-corpus/formats/htj2k/PERF.md`. Both patches are worth
offering upstream.

When a release after 0.0.17 ships, check whether it fixes both hot spots; if it does, go
back to the crates.io dependency, pinned exactly.
