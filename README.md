# shlink-dicom

A specification and reference implementation for sharing complete, full-fidelity DICOM imaging studies through SMART Health Links (`shlink:/`). Series are stored as concatenated Part 10 DICOM instances encrypted in 64 KiB `AES-256-GCM` records so a receiver can stream or range-read individual series, instances, or frames from a zero-knowledge host.

## Contents

- **[`PROPOSAL.md`](PROPOSAL.md)** — The protocol specification: goals, FHIR R4 `ImagingStudy` profile (`https://example.org/shl-dicom/v1`) and extensions (`series-file` and `length`), 64 KiB STREAM record encryption, HTTP `206` Range fetch contract, security considerations, and test vector.
- **[`PLAN.md`](PLAN.md)** & **[`docs/storage.md`](docs/storage.md)** — Architecture, API specification, SQLite storage design (`catalog.db` + per-share `shares/{sid}.db`), dependency graph, and stage-by-stage test plan.
- **`reference/`** — Standalone ~90-line TypeScript/WebCrypto reference implementation (`reference/series-file.ts`) and Appendix B test vector / golden share generator (`reference/test-vector.ts`).
- **`crates/shl-dicom-core/`** — Pure-Rust core library (compiles to native and `wasm32-unknown-unknown`): STREAM record crypto, compact JWE (`dir` + `A256GCM` + `DEF`), DICOM Part 10 / `.tgz` / `.zip` ingestion, 8/12/16-bit + RLE + JPEG pixel decoding, FHIR R4 Bundle builder/parser, and original Part 10 `.dcm` / `.zip` reconstruction.
- **`crates/shl-dicom-wasm/`** — WebAssembly bindings (`WasmShlSession` with bounded LRU 64 KiB record cache, range planner, RGBA renderer, and `.dcm`/`.zip` exporter + `WasmPacker` for browser-side zero-knowledge packing).
- **`crates/shl-dicom-server/`** — Axum HTTP server + CLI (`pack`, `inspect`, `serve`) backed by `catalog.db` + `shares/{sid}.db`.
- **`web/`** — Default DICOM-aware SHL viewer (`https://viewer/#shlink:/...`), Instant Series Contact Sheet, Interactive Stack Viewer with live 64 KiB Record Map & tamper simulator, Original DICOM Exporter, Cornerstone `shl-dicom:` image loader bridge, Service Worker WADO-RS adapter, and Sharer/Host Control Lab.

## Quick Start

```bash
# 1. Verify the Appendix B test vector and generate F0 golden fixtures
bun reference/test-vector.ts

# 2. Run Stage 1 Rust core tests (Appendix B vector, range edge cases, 100% SHA-256 round-trip on Brain MRI + Wrist, and DCMTK pixel comparison)
cargo test -p shl-dicom-core

# 3. Run Stage 2 Rust server integration tests (U-mode & P-mode Range reads, quotas, 409 FK checks, concurrent passcode brute-force limit, mid-download session resumption, traversal defense)
cargo test -p shl-dicom-server

# 4. Run Stage 3 WASM unit tests & Stage 4/5 Chromium E2E tests
bun test test/wasm.test.ts
bun test test/e2e.test.ts

# 5. Start the live demo server & viewer on http://localhost:3000
cargo run -p shl-dicom-server -- serve --port 3000
```
