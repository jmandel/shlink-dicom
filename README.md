# shlink-dicom

Full DICOM imaging studies shared through SMART Health Links (`shlink:/`). Each series is one file of Part 10 instances, encrypted in 64 KiB AES-256-GCM records, so a receiver can range-read single instances or frames from a host that never sees the key.

## Contents

- **[`PROPOSAL.md`](PROPOSAL.md)**: the protocol, covering the ImagingStudy index, series files, record encryption, the Range fetch contract and the test vector.
- **[`PLAN.md`](PLAN.md)**, **[`docs/`](docs/)**: architecture, server storage ([`docs/storage.md`](docs/storage.md)), the three web experiences ([`docs/EXPERIENCES.md`](docs/EXPERIENCES.md)).
- **`reference/`**: a short WebCrypto reference receiver and the test vector generator.
- **`crates/`**:
  - `shl-dicom-core`: packing, record crypto, JWE, Bundle building and parsing;
  - `shl-dicom-wasm`: browser bindings for the packer and session;
  - `shl-dicom-server`: the HTTP server and CLI (`pack`, `inspect`, `serve`).
- **`codecs/`**: pure-Rust pixel decoders (uncompressed, RLE, JPEG, JPEG-LS, JPEG 2000, HTJ2K), plus their wasm build and benchmarks.
- **`codec-corpus/`**: the decoder test corpus, with reference decoders and the check harness.
- **`viewer-kit/`**: the decoder worker pool and WebGL2 renderer.
- **`web/`**: the site.
  - `/` landing;
  - `/view#shlink:/…` the recipient's viewer, including tiled whole-slide images;
  - `/how` how it works;
  - `/share` creating and managing shares;
  - `web/checks/` scripted browser checks.
- **`imaging-sandbox/`**: a SMART Imaging Access sandbox (FHIR, WADO-RS, SMART App Launch) serving a fictional patient's studies.
- **`deploy/`**: bootstrap scripts that build and run the sandbox and the server on a fresh VM.

## Build and run

```bash
# wasm modules
cargo build --release --target wasm32-unknown-unknown -p shl-dicom-wasm
wasm-bindgen --target web --out-dir crates/shl-dicom-wasm/pkg target/wasm32-unknown-unknown/release/shl_dicom_wasm.wasm
node viewer-kit/scripts/build.mjs

# site and server
bun install
bun web/build.ts
cargo run --release -p shl-dicom-server -- serve --port 3333
```

The server seeds a sample share from every `.tgz` in `data/samples/`.

## Tests

```bash
bun reference/test-vector.ts
cargo test -p shl-dicom-core -p shl-dicom-server
bun test test/wasm.test.ts
node web/checks/view-checks.mjs      # with the server on :3333
node web/checks/share-checks.mjs
node web/how/checks.mjs
cd imaging-sandbox && bun test/e2e.ts
```
