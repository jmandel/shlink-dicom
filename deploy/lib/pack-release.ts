// One release tarball from repository paths, for the release workflows: the sandbox
// (imaging-sandbox/scripts/pack-release.ts) and the server (deploy/pack-server-release.ts).
// Paths inside the tarball mirror the repository, so the scripts in it run unchanged.
//
// Writes <out>/<name>.tar.gz (one top-level directory <name>/ with MANIFEST.json), its .sha256 as
// sha256sum writes it, and <out>/<name>.json, the manifest:
//   { name, tag, commit, bun, ...fields, files: [{ path, size, sha256 }] }
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PackOptions {
  repo: string; // repository root
  out: string; // output directory (emptied first)
  product: string; // MANIFEST.json "name"
  name: string; // tarball base name and its top-level directory
  tag: string;
  commit: string;
  /** Repository paths (files or directories) copied in. */
  include: string[];
  /** Adds generated files to the staged tree (for example a bundle) before the manifest. */
  stage?: (dir: string) => Promise<void>;
  /** Extra manifest fields. */
  fields?: Record<string, unknown>;
}

const sha256 = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

/** Throws with a usage line unless tag is <prefix>-<7+ hex> and commit is 40 hex. */
export function releaseArgs(prefix: string, script: string): { tag: string; commit: string; out?: string } {
  const args = process.argv.slice(2);
  const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const tag = opt("--tag"), commit = opt("--commit");
  if (!tag || !new RegExp(`^${prefix}-[0-9a-f]{7,40}$`).test(tag) || !commit || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`usage: bun ${script} --tag ${prefix}-<shortsha> --commit <40-hex sha> [--out DIR]`);
  }
  return { tag, commit, out: opt("--out") };
}

export async function packRelease(o: PackOptions) {
  const stage = join(o.out, o.name);
  rmSync(o.out, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const rel of o.include) {
    const from = join(o.repo, rel);
    if (!existsSync(from)) throw new Error(`${rel} missing${rel.includes("/pkg/") ? ": build the wasm packages first" : ""}`);
    mkdirSync(dirname(join(stage, rel)), { recursive: true });
    cpSync(from, join(stage, rel), { recursive: true });
  }
  await o.stage?.(stage);

  const walk = (d: string): string[] => readdirSync(d).sort().flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const files = walk(stage).map((p) => {
    const bytes = readFileSync(p);
    return { path: p.slice(stage.length + 1), size: bytes.length, sha256: sha256(bytes) };
  });
  const manifest = { name: o.product, tag: o.tag, commit: o.commit, bun: Bun.version, ...o.fields, files };
  const json = JSON.stringify(manifest, null, 1) + "\n";
  writeFileSync(join(stage, "MANIFEST.json"), json);
  writeFileSync(join(o.out, `${o.name}.json`), json);

  const tgz = join(o.out, `${o.name}.tar.gz`);
  // Files world-readable: the services run as other users.
  const tar = Bun.spawnSync(["tar", "--sort=name", "--owner=0", "--group=0", "--numeric-owner", "--mode=a+rX,u+w,go-w", "-czf", tgz, "-C", o.out, o.name]);
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
  const tgzSha = sha256(readFileSync(tgz));
  writeFileSync(`${tgz}.sha256`, `${tgzSha}  ${o.name}.tar.gz\n`);
  rmSync(stage, { recursive: true, force: true });
  const unpacked = files.reduce((n, f) => n + f.size, 0);
  console.log(`${o.name}.tar.gz: ${(statSync(tgz).size / 1e6).toFixed(2)} MB (${files.length} files, ${(unpacked / 1e6).toFixed(1)} MB unpacked), SHA-256 ${tgzSha}`);
  return { tgz, sha256: tgzSha, files: files.length };
}
