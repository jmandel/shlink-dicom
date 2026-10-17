// Packs the shlink-dicom server release that deploy/bootstrap-shlink-dicom.sh installs
// (.github/workflows/server-release.yml publishes it):
//
//   bun deploy/pack-server-release.ts --tag server-<shortsha> --commit <sha> [--out DIR] [--v3 PATH]
//
// Needs the native server (cargo build --release -p shl-dicom-server: the default target, baseline
// x86-64 or aarch64), the wasm packages and the web build (dist/web). On x86_64, --v3 names a
// second build of the server for x86-64-v3 (CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS=
// "-C target-cpu=x86-64-v3"), which the bootstrap installs on CPUs that have the whole v3 set.
//
// Code only: the VM builds the public sample with the sandbox's dataset build
// in the release, from the pinned sources, and checks its digest. Inside shlink-dicom-<tag>-linux-<arch>/:
//
//   MANIFEST.json            tag, commit, arch, glibc, binaries (file: CPU level), Bun version,
//                            sampleDigest, files
//   bin/shl-dicom-server     the server and CLI for the architecture's baseline
//   bin/shl-dicom-server.v3  (x86_64, with --v3) the same for x86-64-v3
//   dist/web/                the site it serves (web/build.ts)
//   imaging-sandbox/src/, scripts/, data/, deploy/sample-reports.ts, deploy/lib/pinned-fetch.ts,
//   crates/shl-dicom-wasm/pkg/, codecs/shl-dicom-transcode-wasm/pkg/
//                            the sample's build: the sandbox dataset and its reports
//
// Writes DIR/shlink-dicom-<tag>-linux-<arch>.tar.gz, its .sha256 and its .json (the manifest). DIR
// defaults to dist/release.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { arch as nodeArch } from "node:os";
import { join, resolve } from "node:path";
import { packRelease, releaseArgs } from "./lib/pack-release.ts";

const REPO = resolve(import.meta.dir, "..");
const { tag, commit, out } = releaseArgs("server", "deploy/pack-server-release.ts");
const argv = process.argv.slice(2);
const v3 = argv.includes("--v3") ? resolve(argv[argv.indexOf("--v3") + 1]) : null;
const arch = ({ x64: "x86_64", arm64: "aarch64" } as Record<string, string>)[nodeArch()];
if (!arch) throw new Error(`no server release for ${nodeArch()}`);
if (v3 && arch !== "x86_64") throw new Error("--v3 is for x86_64 only");
if (v3 && !existsSync(v3)) throw new Error(`${v3} missing`);
const binaries: Record<string, string> = { "bin/shl-dicom-server": arch === "x86_64" ? "x86-64" : arch, ...(v3 ? { "bin/shl-dicom-server.v3": "x86-64-v3" } : {}) };
const server = join(process.env.CARGO_TARGET_DIR ?? join(REPO, "target"), "release/shl-dicom-server");
if (!existsSync(server)) throw new Error(`${server} missing: cargo build --release -p shl-dicom-server`);
// The C library the binary was linked against: the VM needs this version or newer.
const glibc = /(\d+\.\d+)\s*$/.exec(Bun.spawnSync(["ldd", "--version"]).stdout.toString().split("\n")[0])?.[1];
if (!glibc) throw new Error("could not read the glibc version (ldd --version)");

await packRelease({
  repo: REPO,
  out: resolve(out ?? join(REPO, "dist/release")),
  product: "shlink-dicom",
  name: `shlink-dicom-${tag}-linux-${arch}`,
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
    for (const [rel, from] of [["bin/shl-dicom-server", server], ...(v3 ? [["bin/shl-dicom-server.v3", v3]] : [])]) {
      copyFileSync(from, join(dir, rel));
      chmodSync(join(dir, rel), 0o755);
    }
  },
  fields: {
    arch,
    glibc,
    binaries,
    // The SHA-256 of the sample dataset's SHA256SUMS (imaging-sandbox/build/dataset) that the VM's build must produce.
    sampleDigest: readFileSync(join(REPO, "imaging-sandbox/data/SHA256SUMS.sha256"), "utf8").split(/\s+/)[0],
  },
});
