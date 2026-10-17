// Packs the sandbox's code into one release tarball, which deploy/bootstrap-sandbox.sh installs on
// a VM that has only Bun (.github/workflows/sandbox-release.yml publishes it):
//
//   bun scripts/pack-release.ts --tag sandbox-<shortsha> --commit <sha> [--out DIR]
//
// Needs the two wasm packages built (README.md, "Running it"). The release holds code only; the VM
// builds the dataset from the pinned sources with it and checks the digest. Paths inside mirror the
// repository (deploy/lib/pack-release.ts):
//
//   imaging-sandbox-<tag>/
//     MANIFEST.json                                tag, commit, Bun version, expected dataset digest,
//                                                  every other file with its size and SHA-256
//     imaging-sandbox/dist/server.js               the server, bundled (bun build)
//     imaging-sandbox/scripts/, src/dicom.ts, src/tar.ts, data/   the dataset build and its inputs
//     imaging-sandbox/README.md, CONFORMANCE.md
//     crates/shl-dicom-wasm/pkg/                   frame offset tables (the packer's code)
//     codecs/shl-dicom-transcode-wasm/pkg/         the lossless transcoder (compressed copies)
//     deploy/lib/pinned-fetch.ts                   fetching the pinned sources
//
// Writes DIR/imaging-sandbox-<tag>.tar.gz, its .sha256 and DIR/imaging-sandbox-<tag>.json (the
// manifest). DIR defaults to build/release.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packRelease, releaseArgs } from "../../deploy/lib/pack-release.ts";

const SANDBOX = resolve(import.meta.dir, "..");
const { tag, commit, out } = releaseArgs("sandbox", "scripts/pack-release.ts");
await packRelease({
  repo: resolve(SANDBOX, ".."),
  out: resolve(out ?? join(SANDBOX, "build/release")),
  product: "imaging-sandbox",
  name: `imaging-sandbox-${tag}`,
  tag,
  commit,
  include: [
    "imaging-sandbox/scripts/build-data.ts",
    "imaging-sandbox/scripts/lib",
    "imaging-sandbox/src/dicom.ts",
    "imaging-sandbox/src/tar.ts",
    "imaging-sandbox/data",
    "imaging-sandbox/README.md",
    "imaging-sandbox/CONFORMANCE.md",
    "deploy/lib/pinned-fetch.ts",
    "crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js",
    "crates/shl-dicom-wasm/pkg/shl_dicom_wasm_bg.wasm",
    "codecs/shl-dicom-transcode-wasm/pkg/shl_dicom_transcode_wasm.js",
    "codecs/shl-dicom-transcode-wasm/pkg/shl_dicom_transcode_wasm_bg.wasm",
  ],
  // The server, bundled; it reads build/dataset and build/variants next to dist/ (src/config.ts).
  stage: async (dir) => {
    const b = await Bun.build({ entrypoints: [join(SANDBOX, "src/server.ts")], target: "bun", outdir: join(dir, "imaging-sandbox/dist"), naming: "server.js" });
    if (!b.success) throw new Error(b.logs.join("\n"));
  },
  // The SHA-256 of build/dataset/SHA256SUMS that this release's dataset build must produce.
  fields: { datasetDigest: readFileSync(join(SANDBOX, "data/SHA256SUMS.sha256"), "utf8").split(/\s+/)[0] },
});
