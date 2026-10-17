// Packs the shlink-dicom server release that deploy/bootstrap-shlink-dicom.sh installs
// (.github/workflows/server-release.yml publishes it):
//
//   bun deploy/pack-server-release.ts --tag server-<shortsha> --commit <sha> [--out DIR]
//
// Needs the native server (cargo build --release -p shl-dicom-server), the wasm packages and the
// web build (dist/web). Code only: the VM builds the public sample with the sandbox's dataset build
// in the release, from the pinned sources, and checks its digest. Inside shlink-dicom-<tag>/:
//
//   MANIFEST.json            tag, commit, cpu (x86-64-v3), glibc, Bun version, sampleDigest, files
//   bin/shl-dicom-server     the server and CLI, native x86-64-v3 (.cargo/config.toml)
//   dist/web/                the site it serves (web/build.ts)
//   imaging-sandbox/src/, scripts/, data/, deploy/sample-reports.ts, deploy/lib/pinned-fetch.ts,
//   crates/shl-dicom-wasm/pkg/, codecs/shl-dicom-transcode-wasm/pkg/
//                            the sample's build: the sandbox dataset and its reports
//
// Writes DIR/shlink-dicom-<tag>.tar.gz, its .sha256 and DIR/shlink-dicom-<tag>.json. DIR defaults
// to dist/release.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packRelease, releaseArgs } from "./lib/pack-release.ts";

const REPO = resolve(import.meta.dir, "..");
const { tag, commit, out } = releaseArgs("server", "deploy/pack-server-release.ts");
const server = join(process.env.CARGO_TARGET_DIR ?? join(REPO, "target"), "release/shl-dicom-server");
if (!existsSync(server)) throw new Error(`${server} missing: cargo build --release -p shl-dicom-server`);
// The C library the binary was linked against: the VM needs this version or newer.
const glibc = /(\d+\.\d+)\s*$/.exec(Bun.spawnSync(["ldd", "--version"]).stdout.toString().split("\n")[0])?.[1];
if (!glibc) throw new Error("could not read the glibc version (ldd --version)");

await packRelease({
  repo: REPO,
  out: resolve(out ?? join(REPO, "dist/release")),
  product: "shlink-dicom",
  name: `shlink-dicom-${tag}`,
  tag,
  commit,
  include: [
    "dist/web",
    "imaging-sandbox/src",
    "imaging-sandbox/scripts/build-data.ts",
    "imaging-sandbox/scripts/lib",
    "imaging-sandbox/data",
    "deploy/sample-reports.ts",
    "deploy/lib/pinned-fetch.ts",
    "crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js",
    "crates/shl-dicom-wasm/pkg/shl_dicom_wasm_bg.wasm",
    "codecs/shl-dicom-transcode-wasm/pkg/shl_dicom_transcode_wasm.js",
    "codecs/shl-dicom-transcode-wasm/pkg/shl_dicom_transcode_wasm_bg.wasm",
  ],
  stage: async (dir) => {
    mkdirSync(join(dir, "bin"));
    copyFileSync(server, join(dir, "bin/shl-dicom-server"));
    chmodSync(join(dir, "bin/shl-dicom-server"), 0o755);
  },
  fields: {
    cpu: "x86-64-v3",
    glibc,
    // The SHA-256 of the sample dataset's SHA256SUMS (imaging-sandbox/build/dataset) that the VM's build must produce.
    sampleDigest: readFileSync(join(REPO, "imaging-sandbox/data/SHA256SUMS.sha256"), "utf8").split(/\s+/)[0],
  },
});
