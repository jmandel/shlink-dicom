// Builds the correctness fixtures for the decrypt spike:
//   fixtures/vector.bin + vector.json   copy of the PROPOSAL Appendix B vector (fixtures/golden/)
//   fixtures/wrist.bin + wrist.json     a real series file: the three wrist-low-res instances,
//                                       concatenated and encrypted with reference/series-file.ts
// Run from the repository root: bun perf-spikes/decrypt/make-fixtures.ts
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64urlEncode, ciphertextLength, encryptSeries } from "../../reference/series-file.ts";

const here = new URL(".", import.meta.url).pathname;
const root = join(here, "../..");
const out = join(here, "fixtures");
mkdirSync(out, { recursive: true });
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (b: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));

// Appendix B vector.
const v = JSON.parse(readFileSync(join(root, "fixtures/golden/vector.json"), "utf8"));
copyFileSync(join(root, `fixtures/golden/${v.fileId}.bin`), join(out, "vector.bin"));
writeFileSync(join(out, "vector.json"), JSON.stringify({ ...v, name: "Appendix B vector" }, null, 2));

// Real series: wrist-low-res, instances in file-name order.
const tmp = mkdtempSync(join(tmpdir(), "wrist-"));
execFileSync("tar", ["xzf", join(root, "data/samples/wrist-low-res.tgz"), "-C", tmp]);
const names = ["lateral.dcm", "oblique.dcm", "posteroanterior.dcm"];
const parts = names.map((n) => new Uint8Array(readFileSync(join(tmp, "wrist", n))));
for (const p of parts) if (new TextDecoder().decode(p.subarray(128, 132)) !== "DICM") throw new Error("not Part 10");
const plaintext = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
let o = 0;
for (const p of parts) (plaintext.set(p, o), (o += p.length));
const key = crypto.getRandomValues(new Uint8Array(32));
const ct = await encryptSeries(plaintext, key);
if (ct.length !== ciphertextLength(plaintext.length)) throw new Error("length");
writeFileSync(join(out, "wrist.bin"), ct);
writeFileSync(
  join(out, "wrist.json"),
  JSON.stringify(
    {
      name: "wrist-low-res series (3 DICOM Part 10 instances)",
      seriesKey: b64urlEncode(key),
      seriesKeyHex: hex(key),
      instanceLengths: parts.map((p) => p.length),
      plaintextLength: plaintext.length,
      ciphertextLength: ct.length,
      plaintextSha256: await sha256(plaintext),
      ciphertextSha256: await sha256(ct),
    },
    null,
    2,
  ),
);
console.log("wrote", out);
