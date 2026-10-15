// Worker for /how's last section: runs the reference receiver, checks the test vector, and times our
// decoder against C libraries compiled to WebAssembly. Nothing here runs on the page's thread.
import { receive } from "./receiver.js";
import { WasmDecoder } from "../../viewer-kit/src/wasm-decoder";
import { parseDicomSync, T } from "../core/dicom";

const post = (m: any) => (self as any).postMessage(m);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// PROPOSAL.md appendix B.
const TV = {
  key: "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
  plaintextSha256: "02675bf9284bd74223e98ceea96ebee4c9a469272ead358f462d89753f8c909b",
  ciphertextLength: 150048,
  ciphertextSha256: "f3205658d3fee29b343d3ba3ef20f52b3e66c2cb05974a93b65504866665fc4e",
  tags: ["9a8421bd6740aeac5eb211cf59511b2f", "4cd810f700957e87ae68edc29e40caf9", "cf980ddc661684644fa17e5b00b08819"],
};

async function testVector() {
  const R = 65520;
  const pt = Uint8Array.from({ length: 150000 }, (_, k) => k % 251);
  const key = await crypto.subtle.importKey("raw", b64(TV.key), "AES-GCM", false, ["encrypt", "decrypt"]);
  const nonce = (i: number) => {
    const b = new Uint8Array(12);
    new DataView(b.buffer).setUint32(8, i);
    return b;
  };
  const recs: Uint8Array[] = [];
  for (let i = 0; i * R < pt.length; i++) recs.push(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(i) }, key, pt.subarray(i * R, Math.min(pt.length, (i + 1) * R)))));
  const ct = new Uint8Array(recs.reduce((a, r) => a + r.length, 0));
  recs.reduce((o, r) => (ct.set(r, o), o + r.length), 0);
  const sha = async (b: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
  const refused = (data: Uint8Array, i: number) => crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(i) }, key, data).then(() => false, () => true);
  const flipped = ct.slice(0, 65536);
  flipped[1000] ^= 1;
  const rows: { label: string; ok: boolean; value: string }[] = [];
  const p = await sha(pt), c = await sha(ct);
  rows.push({ label: "Plaintext SHA-256", ok: p === TV.plaintextSha256, value: p });
  rows.push({ label: "Ciphertext length", ok: ct.length === TV.ciphertextLength, value: ct.length.toLocaleString("en-US") });
  rows.push({ label: "Ciphertext SHA-256", ok: c === TV.ciphertextSha256, value: c });
  recs.forEach((r, i) => {
    const t = hex(r.subarray(r.length - 16));
    rows.push({ label: `Piece ${i} tag`, ok: t === TV.tags[i], value: t });
  });
  const f = await refused(flipped, 0), s = await refused(ct.slice(65536, 131072), 0);
  rows.push({ label: "Tampering", ok: f && s, value: f && s ? "a flipped bit and a moved piece are both refused" : "not detected" });
  return rows;
}

// ------------------------------------------------------------------------------- benchmark

interface BenchCase {
  file: string;
  label: string;
  lib: "openjpeg" | "openjph" | "charls";
}
const LIBS = {
  openjpeg: { js: "openjpeg/openjpegwasm_decode.js", cls: "J2KDecoder", name: "OpenJPEG" },
  openjph: { js: "openjph/openjphjs.js", cls: "HTJ2KDecoder", name: "OpenJPH" },
  charls: { js: "charls/charlswasm_decode.js", cls: "JpegLSDecoder", name: "CharLS" },
};

/** An Emscripten module from the Cornerstone codec packages (UMD scripts). */
async function loadLib(base: string, js: string) {
  const url = new URL(js, base);
  const src = await (await fetch(url)).text();
  const m: any = { exports: {} };
  new Function("module", "exports", src)(m, m.exports);
  const factory = m.exports.default ?? m.exports;
  const dir = url.href.slice(0, url.href.lastIndexOf("/") + 1);
  return factory({ locateFile: (f: string) => dir + f, print: () => {}, printErr: () => {} });
}

/** The codestream of a single-frame encapsulated file: its fragments after the offset table. */
function codestream(bytes: Uint8Array): Uint8Array {
  const { ds } = parseDicomSync(bytes);
  const frags = ds.get(T.PixelData)?.fragments ?? [];
  const parts = frags.slice(1).map((f) => bytes.subarray(f.offset, f.offset + f.length));
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function bench(base: string, wasmUrl: string, cases: BenchCase[], runs: number) {
  const ours = await WasmDecoder.create(await WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer()));
  const total = cases.length * 2 * (runs + 1);
  let done = 0;
  const tick = (what: string) => post({ type: "progress", done: ++done, total, what });
  const rows = [];
  for (const c of cases) {
    const bytes = new Uint8Array(await (await fetch(new URL(c.file, base))).arrayBuffer());
    const cs = codestream(bytes);
    const L = LIBS[c.lib];
    const mod = await loadLib(base, L.js);
    const cDecode = (keep: boolean) => {
      const d = new mod[L.cls]();
      try {
        d.getEncodedBuffer(cs.length).set(cs);
        const t0 = performance.now();
        d.decode();
        const ms = performance.now() - t0;
        return { ms, out: keep ? d.getDecodedBuffer().slice() : null };
      } finally {
        d.delete();
      }
    };
    const ourMs: number[] = [], cMs: number[] = [];
    let ourOut: Uint8Array | null = null, cOut: Uint8Array | null = null, info: any = null;
    for (let i = 0; i <= runs; i++) {
      const r = ours.decode(bytes);
      if (!r.ok) throw new Error(`our decoder: ${r.message}`);
      if (i === 0) (ourOut = new Uint8Array(r.pixels)), (info = r.info);
      else ourMs.push(r.ms);
      tick(`${c.label}: ours`);
      const x = cDecode(i === 0);
      if (i === 0) cOut = x.out;
      else cMs.push(x.ms);
      tick(`${c.label}: ${L.name}`);
    }
    const same = !!ourOut && !!cOut && ourOut.length === cOut.length && ourOut.every((v, k) => v === cOut![k]);
    rows.push({ label: c.label, lib: L.name, size: bytes.length, rows: info.rows, columns: info.columns, ours: median(ourMs), c: median(cMs), same });
  }
  return rows;
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  try {
    if (m.type === "receive") {
      const t0 = performance.now();
      const result = await receive(m.link);
      post({ type: "done", result, ms: performance.now() - t0 });
    } else if (m.type === "testvector") {
      post({ type: "done", rows: await testVector() });
    } else if (m.type === "bench") {
      post({ type: "done", rows: await bench(m.base, m.wasm, m.cases, m.runs) });
    }
  } catch (e) {
    post({ type: "error", message: String((e as Error)?.message ?? e) });
  }
};
