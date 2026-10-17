# shlink-dicom

Full DICOM imaging studies shared through SMART Health Links (`shlink:/`). Each study is one file of Part 10 instances (a series added later may have its own file), encrypted in 64 KiB AES-256-GCM records, so a receiver can range-read single instances or frames from a host that never sees the key.

## Specification

**[The shlink-dicom profile (`spec/`)](spec/README.md)**: SMART Health Links for DICOM imaging studies. It defines the ImagingStudy index and its `linked-file` and `instance-length` extensions, the encrypted study files and their 64 KiB AES-256-GCM records, the Range fetch contract, security considerations, a complete example Bundle and a test vector. Status: draft profile.

## Contents

- **[`PLAN.md`](PLAN.md)**, **[`docs/`](docs/)**: architecture, server storage ([`docs/storage.md`](docs/storage.md)), the three web experiences ([`docs/EXPERIENCES.md`](docs/EXPERIENCES.md)).
- **`reference/`**: a short WebCrypto reference receiver and the test vector generator.
- **`crates/`**:
  - `shl-dicom-core`: packing, record crypto, JWE, Bundle building and parsing;
  - `shl-dicom-wasm`: the browser binding for adding frame offset tables (the Share page uses it);
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
- **`deploy/`**: the bootstrap scripts that install the server and the sandbox on a VM from releases built in CI (see [Deploying](#deploying)).
- **`pages/`**: the static copy at [joshuamandel.com/shlink-dicom](https://joshuamandel.com/shlink-dicom/): the viewer and one demo link (the brain MRI and left wrist X-rays) served as plain files by GitHub Pages, built by [`.github/workflows/pages.yml`](.github/workflows/pages.yml) with the keys recorded in [`pages/demo-link.json`](pages/demo-link.json).

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

The server seeds a sample share from every `.tgz` in `data/samples/` (`shl-dicom-server seed`). It adds a frame offset table to any multi-frame file that lacks one, and lists every file it skips with the reason. `shl-dicom-server pack` lists skipped files the same way.

Native x86_64 builds target x86-64-v3 (AVX2); for an older CPU see [codecs/README.md](codecs/README.md#cpu-requirement).

## Deploying

CI builds both services and publishes them as GitHub Releases; a VM installs a release with one script and needs no git checkout, Rust or C toolchain.

- **The server.** [`.github/workflows/server-release.yml`](.github/workflows/server-release.yml) runs on pushes to `main` that change the code it ships, and on manual dispatch. It builds the native `shl-dicom-server` (x86-64-v3), the wasm modules and the web app, packs them with the sandbox's dataset build ([`deploy/pack-server-release.ts`](deploy/pack-server-release.ts); `MANIFEST.json` gives the commit, the CPU level, the glibc it needs, the sample's expected digest and every file's SHA-256), installs that tarball on the runner with the bootstrap script, checks `/`, `/view/`, `/sample` and a Range read, and publishes it as `server-<short commit>`. On `main` it also points `server-latest`'s `latest.json` at that tag and keeps the last five releases. All of these are GitHub pre-releases, so none is labelled the repository's Latest.
- **On the VM.** [`deploy/bootstrap-shlink-dicom.sh`](deploy/bootstrap-shlink-dicom.sh) checks the CPU (x86-64-v3) and glibc, installs the SQLite runtime library and a pinned Bun, downloads the release (the latest, or the tag given as its argument), checks its SHA-256 and every file, and unpacks it into `/opt/shlink-dicom-server/releases/<tag>`. With the release's code it builds the public sample from the pinned sources (my-health-data and IDC, each checked by SHA-256) and stops unless the dataset digest matches. It then seeds the sample share in `/var/lib/shlink-dicom` when the sample changed, points `/opt/shlink-dicom-server/current` at the release, restarts the `shlink-dicom` unit and checks `/`, `/view/` and `/sample`; if that fails it goes back to the previous release. S3 storage is configured in `/etc/shlink-dicom.env` (see the script's header).

  ```sh
  curl -fsSL https://raw.githubusercontent.com/jmandel/shlink-dicom/main/deploy/bootstrap-shlink-dicom.sh | bash                   # the latest release
  curl -fsSL https://raw.githubusercontent.com/jmandel/shlink-dicom/main/deploy/bootstrap-shlink-dicom.sh | bash -s server-1a2b3c4  # a given release
  ```

  Rollback is running it with an older tag; a release already built on the VM is reused.
- **The sandbox** works the same way: [imaging-sandbox/README.md](imaging-sandbox/README.md#deploying).
- The three workflows share their build steps in [`.github/actions/`](.github/actions/).

## Tests

```bash
bun reference/test-vector.ts
cargo test -p shl-dicom-core -p shl-dicom-server
bun test test/wasm.test.ts
node web/checks/view-checks.mjs      # with the server on :3333
node web/checks/share-checks.mjs
node web/how/checks.mjs
cd imaging-sandbox && bun test/e2e.ts
# the GitHub Pages copy, served as Pages serves it
bun pages/build.ts --site-url http://localhost:8787/shlink-dicom/ --out dist/pages-local
bun pages/checks/serve.ts dist/pages-local &
node pages/checks/pages-checks.mjs
```
