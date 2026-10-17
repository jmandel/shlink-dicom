// Packs the sandbox's code into one release tarball, which deploy/bootstrap-sandbox.sh installs on
// a VM that has only Bun (.github/workflows/sandbox-release.yml publishes it):
//
//   bun scripts/pack-release.ts --tag sandbox-<shortsha> --commit <sha> [--out DIR]
//
// Needs the two wasm packages built (README.md, "Running it"). The release holds code only; the VM
// builds the dataset from the pinned sources with it and checks the digest. Paths inside mirror the
// repository, so the scripts run unchanged:
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
// Writes DIR/imaging-sandbox-<tag>.tar.gz, its .sha256 (as sha256sum writes it) and
// DIR/imaging-sandbox-<tag>.json (the manifest). DIR defaults to build/release.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SANDBOX = resolve(import.meta.dir, "..");
const REPO = resolve(SANDBOX, "..");
const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const tag = opt("--tag");
const commit = opt("--commit");
if (!tag || !/^sandbox-[0-9a-f]{7,40}$/.test(tag) || !commit || !/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error("usage: bun scripts/pack-release.ts --tag sandbox-<shortsha> --commit <40-hex sha> [--out DIR]");
}
const out = resolve(opt("--out") ?? join(SANDBOX, "build/release"));
const name = `imaging-sandbox-${tag}`;
const stage = join(out, name);
const sha256 = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const fail = (m: string): never => {
  console.error(`pack-release: ${m}`);
  process.exit(1);
};

rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const copy = (rel: string) => {
  const from = join(REPO, rel);
  if (!existsSync(from)) fail(`${rel} missing${rel.includes("/pkg/") ? ": build the wasm packages first (README.md, Running it)" : ""}`);
  mkdirSync(dirname(join(stage, rel)), { recursive: true });
  cpSync(from, join(stage, rel), { recursive: true });
};

// The server, bundled; it reads build/dataset and build/variants next to dist/ (src/config.ts).
const b = await Bun.build({ entrypoints: [join(SANDBOX, "src/server.ts")], target: "bun", outdir: join(stage, "imaging-sandbox/dist"), naming: "server.js" });
if (!b.success) fail(b.logs.join("\n"));
// The dataset build, as source (Bun runs TypeScript), with what it imports and reads.
for (const rel of [
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
]) copy(rel);

const walk = (d: string): string[] => readdirSync(d).sort().flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = walk(stage).map((p) => {
  const bytes = readFileSync(p);
  return { path: p.slice(stage.length + 1), size: bytes.length, sha256: sha256(bytes) };
});
const manifest = {
  name: "imaging-sandbox",
  tag,
  commit,
  bun: Bun.version,
  // The SHA-256 of build/dataset/SHA256SUMS that this release's dataset build must produce.
  datasetDigest: readFileSync(join(SANDBOX, "data/SHA256SUMS.sha256"), "utf8").split(/\s+/)[0],
  files,
};
writeFileSync(join(stage, "MANIFEST.json"), JSON.stringify(manifest, null, 1) + "\n");
writeFileSync(join(out, `${name}.json`), JSON.stringify(manifest, null, 1) + "\n");

const tgz = join(out, `${name}.tar.gz`);
const tar = Bun.spawnSync(["tar", "--sort=name", "--owner=0", "--group=0", "--numeric-owner", "--mode=a+rX,u+w,go-w", "-czf", tgz, "-C", out, name]);
if (tar.exitCode !== 0) fail(tar.stderr.toString());
const tgzSha = sha256(readFileSync(tgz));
writeFileSync(`${tgz}.sha256`, `${tgzSha}  ${name}.tar.gz\n`);
rmSync(stage, { recursive: true, force: true });
console.log(`${name}.tar.gz: ${(statSync(tgz).size / 1e6).toFixed(2)} MB, ${files.length} files, SHA-256 ${tgzSha}`);
