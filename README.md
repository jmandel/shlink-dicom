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

Builds are portable by default: native code is built for the host's baseline (x86-64, or aarch64 on Arm, including Apple Silicon), so a binary runs on any machine of its architecture. For the full speed of your machine, build with `RUSTFLAGS="-C target-cpu=native"` ([codecs/README.md, CPU targets](codecs/README.md#cpu-targets)). The code is built and tested on x86_64 and aarch64 Linux and on macOS (Apple Silicon); see [Platforms](#platforms).

## Deploying

CI builds both services and publishes them as GitHub Releases; a VM installs a release with one script and needs no git checkout, Rust or C toolchain.

- **The server.** [`.github/workflows/server-release.yml`](.github/workflows/server-release.yml) runs on pushes to `main` that change the code it ships, and on manual dispatch. It builds one tarball per architecture, each on its own runner: linux-x86_64 (the server for baseline x86-64, plus a second build for x86-64-v3) and linux-aarch64 (on GitHub's Arm runner). Each holds the server, the wasm modules and the web app, and the sandbox's dataset build ([`deploy/pack-server-release.ts`](deploy/pack-server-release.ts); `MANIFEST.json` gives the commit, the architecture, the glibc it needs, each server binary's CPU level, the sample's expected digest and every file's SHA-256). Each runner installs its tarball with the bootstrap script and checks `/`, `/view/`, `/sample` and a Range read; on x86_64 it does so with the v3 server and again with the baseline one. Both are published together as `server-<short commit>`. On `main` it also points `server-latest`'s `latest.json` at that tag and keeps the last five releases. All of these are GitHub pre-releases, so none is labelled the repository's Latest.
- **On the VM.** [`deploy/bootstrap-shlink-dicom.sh`](deploy/bootstrap-shlink-dicom.sh) picks the tarball for `uname -m` (x86_64 or aarch64; it stops with a clear message on anything else, or if the release has no build for it), installs the SQLite runtime library and a pinned Bun for that architecture, downloads the release (the latest, or the tag given as its argument), checks its SHA-256, every file and the glibc it needs, and unpacks it into `/opt/shlink-dicom-server/releases/<tag>`. With the release's code it builds the public sample from the pinned sources (my-health-data and IDC, each checked by SHA-256) and stops unless the dataset digest matches. On x86_64 it runs the x86-64-v3 server when `/proc/cpuinfo` shows the whole set (AVX2, BMI1, BMI2, FMA, MOVBE, LZCNT, F16C), else the baseline one, and logs which; `SHL_CPU=baseline` forces the baseline. It then seeds the sample share in `/var/lib/shlink-dicom` when the sample changed, points `/opt/shlink-dicom-server/current` at the release, restarts the `shlink-dicom` unit and checks `/`, `/view/` and `/sample`; if that fails it goes back to the previous release. S3 storage is configured in `/etc/shlink-dicom.env` (see the script's header).

  ```sh
  curl -fsSL https://raw.githubusercontent.com/jmandel/shlink-dicom/main/deploy/bootstrap-shlink-dicom.sh | bash                   # the latest release
  curl -fsSL https://raw.githubusercontent.com/jmandel/shlink-dicom/main/deploy/bootstrap-shlink-dicom.sh | bash -s server-1a2b3c4  # a given release
  ```

  Rollback is running it with an older tag; a release already built on the VM is reused.
- **The sandbox** works the same way: [imaging-sandbox/README.md](imaging-sandbox/README.md#deploying).
- The workflows share their build steps in [`.github/actions/`](.github/actions/).

## Platforms

| Platform | Native build | Tested by |
|---|---|---|
| Linux x86_64 | baseline x86-64 (the server release also carries an x86-64-v3 build) | the server, sandbox and Pages workflows: builds, the wasm modules and web app, the dataset checks, and an install of the server release with its bootstrap under systemd (with the v3 and the baseline server) |
| Linux aarch64 | aarch64 | the server release workflow on `ubuntu-24.04-arm` (build and bootstrap install), and [`.github/workflows/portability.yml`](.github/workflows/portability.yml) |
| macOS, Apple Silicon | aarch64 | `portability.yml` on `macos-14`: both Rust workspaces built and tested, the wasm modules, `bun web/build.ts`, a packer run and the test vector. Releases and the bootstraps are for Linux only. |

`portability.yml` runs on every push to `main` and on pull requests. The browser checks in `web/checks/` run on x86_64 Linux with Chromium.

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
