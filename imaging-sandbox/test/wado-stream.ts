// WADO-RS responses stream their parts (a compressed copy is read only when its part is sent), and
// capabilities are reused per consent and study, with the map bounded.
//   bun test/wado-stream.ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { multipart, CapabilityStore, MAX_CAPABILITIES, type Part } from "../src/wado.ts";

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

// 1. Streaming: the second copy is read only after the first part has gone out.
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "wado-stream-"));
const a = join(dir, "a.dcm"), b = join(dir, "b.dcm");
writeFileSync(a, new Uint8Array(1000).fill(1));
writeFileSync(b, new Uint8Array(1000).fill(2));
const inst = (uid: string) => ({ sopInstanceUID: uid }) as any;
const parts: Part[] = [
  { instance: inst("1"), ts: "1.2.840.10008.1.2.4.70", size: 1000, body: new Uint8Array(0), file: a },
  { instance: inst("2"), ts: "1.2.840.10008.1.2.4.70", size: 1000, body: new Uint8Array(0), file: b },
];
const res = multipart(parts, (i: any) => `x/${i.sopInstanceUID}`);
const reader = res.body!.getReader();
let seen = 0;
while (seen < 1000) {
  const { value, done } = await reader.read();
  if (done) break;
  seen += value.byteLength;
}
// The first part is out; now the second copy changes on disk before it is read.
writeFileSync(b, new Uint8Array(10).fill(3));
let failed = false;
try {
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
} catch {
  failed = true;
}
check("a copy is read from disk only when its part is sent", failed, failed ? "" : "the whole study was read before streaming");
rmSync(dir, { recursive: true, force: true });

// 2. Capabilities: one per consent and study, and the map stays bounded.
const caps = new CapabilityStore({ capabilityTtl: 3600 } as any);
const tok = { grant: { id: "g1" } } as any;
const c1 = caps.issue(tok, "1.2.3"), c2 = caps.issue(tok, "1.2.3"), c3 = caps.issue(tok, "1.2.4");
check("the same consent and study reuse one capability", c1 === c2 && c1 !== c3);
for (let n = 0; n < MAX_CAPABILITIES + 500; n++) caps.issue({ grant: { id: `g${n}` } } as any, "1.2.3");
check(`at most ${MAX_CAPABILITIES} capabilities are kept`, caps.size <= MAX_CAPABILITIES, String(caps.size));
process.exit(bad ? 1 : 0);
