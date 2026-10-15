// Decrypt benchmark: runs on the page's main thread and inside a dedicated worker.
// Every path has the same shape: decrypt(ciphertext, firstRecordIndex) -> Promise<Uint8Array>,
// verifying every tag and returning contiguous plaintext. The same function is used for the
// correctness checks and for timing.
import { decryptRecords, importFileKey } from "./record-decrypt.js";

export const RP = 65520, TAG = 16, RC = 65536;
const MB = 1e6;

export function nonce(i) {
  const n = new Uint8Array(12);
  const v = new DataView(n.buffer);
  v.setUint32(4, Math.floor(i / 2 ** 32));
  v.setUint32(8, i >>> 0);
  return n;
}
const ptLen = (len) => len - Math.ceil(len / RC) * TAG;

// ---------- wasm (aes-gcm 0.10.3 compiled to wasm32) ----------
const BATCH = 16; // records copied into wasm memory per call (1 MiB)

export async function loadWasm(build) {
  const bytes = await (await fetch(new URL(`../out/${build}.wasm`, import.meta.url))).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports;
}

/** Tuned: key schedule once, decrypt in place, copy plaintext out. */
export function wasmTuned(ex, rawKey) {
  const kp = ex.alloc(32);
  new Uint8Array(ex.memory.buffer, kp, 32).set(rawKey);
  const buf = ex.alloc(BATCH * RC);
  return async (ct, first) => {
    ex.set_key(kp); // once per call; the module holds one key at a time
    const out = new Uint8Array(ptLen(ct.length));
    for (let k = 0; k * RC < ct.length; k += BATCH) {
      const chunk = ct.subarray(k * RC, Math.min(ct.length, (k + BATCH) * RC));
      new Uint8Array(ex.memory.buffer, buf, chunk.length).set(chunk);
      const r = ex.decrypt_tuned(buf, chunk.length, first + k);
      if (r !== -1) throw new Error(`record ${r} failed`);
      const n = ptLen(chunk.length);
      out.set(new Uint8Array(ex.memory.buffer, buf, n), k * RP);
    }
    return out;
  };
}

/** As-is: shl-dicom-core decrypt_record per record (fresh Aes256Gcm + Vec per record). */
export function wasmAsis(ex, rawKey) {
  const kp = ex.alloc(32);
  new Uint8Array(ex.memory.buffer, kp, 32).set(rawKey);
  const buf = ex.alloc(BATCH * RC);
  const obuf = ex.alloc(BATCH * RC);
  return async (ct, first) => {
    const out = new Uint8Array(ptLen(ct.length));
    for (let k = 0; k * RC < ct.length; k += BATCH) {
      const chunk = ct.subarray(k * RC, Math.min(ct.length, (k + BATCH) * RC));
      new Uint8Array(ex.memory.buffer, buf, chunk.length).set(chunk);
      const r = ex.decrypt_asis(buf, chunk.length, first + k, kp, obuf);
      if (r !== -1) throw new Error(`record ${r} failed`);
      out.set(new Uint8Array(ex.memory.buffer, obuf, ptLen(chunk.length)), k * RP);
    }
    return out;
  };
}

// ---------- WebCrypto ----------
/** One call per record, each awaited before the next. */
export function wcSequential(key) {
  return async (ct, first) => {
    const out = new Uint8Array(ptLen(ct.length));
    for (let k = 0; k * RC < ct.length; k++) {
      const rec = ct.subarray(k * RC, Math.min(ct.length, (k + 1) * RC));
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(first + k) }, key, rec);
      out.set(new Uint8Array(pt), k * RP);
    }
    return out;
  };
}

/** K calls in flight (the record-decrypt.ts module). */
export function wcInFlight(key, K) {
  return (ct, first) => decryptRecords(key, ct, first, { concurrency: K });
}

export async function importKey(raw) {
  return importFileKey(raw);
}

// ---------- data ----------
/** n full records of ciphertext under `rawKey`, records numbered from 0. */
export async function makeCiphertext(n, rawKey) {
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(n * RC);
  const pt = new Uint8Array(RP);
  for (let k = 0; k < RP; k++) pt[k] = k % 251;
  const pending = [];
  for (let i = 0; i < n; i++) {
    pt[0] = i & 255;
    pending.push(crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(i) }, key, pt).then((c) => ct.set(new Uint8Array(c), i * RC)));
    if (pending.length >= 64) await Promise.all(pending.splice(0));
  }
  await Promise.all(pending);
  return ct;
}

async function sha256hex(b) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const hexToBytes = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));

// ---------- correctness ----------
/** Every path must reproduce the Appendix B vector and the real series file, and reject tampering. */
export async function checkPath(name, makeFn, fixtures) {
  const results = [];
  const rejects = async (what, fn, ct, first) => {
    let ok = false;
    try { await fn(ct, first); } catch { ok = true; }
    results.push({ check: what, ok });
  };
  for (const fx of fixtures) {
    const fn = await makeFn(hexToBytes(fx.meta.seriesKeyHex));
    const ct = fx.ct;
    const pt = await fn(ct, 0);
    results.push({ check: `${fx.id}: whole file sha256`, ok: (await sha256hex(pt)) === fx.meta.plaintextSha256 });
    // A range starting mid-file (records 1..end), as a range read would see it.
    const tail = await fn(ct.subarray(RC), 1);
    results.push({ check: `${fx.id}: records 1..end`, ok: tail.length === pt.length - RP && tail.every((b, i) => b === pt[RP + i]) });
    const flipped = ct.slice(); flipped[RC + 1000] ^= 1;
    await rejects(`${fx.id}: flipped ciphertext bit rejected`, fn, flipped, 0);
    const tagflip = ct.slice(); tagflip[RC - 1] ^= 0x80;
    await rejects(`${fx.id}: flipped tag bit rejected`, fn, tagflip, 0);
    const swapped = ct.slice(); swapped.set(ct.subarray(RC, 2 * RC), 0); swapped.set(ct.subarray(0, RC), RC);
    await rejects(`${fx.id}: swapped records rejected`, fn, swapped, 0);
    await rejects(`${fx.id}: wrong record index rejected`, fn, ct.subarray(RC), 2);
    await rejects(`${fx.id}: truncated final record rejected`, fn, ct.subarray(0, ct.length - 1), 0);
    const other = await makeFn(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));
    await rejects(`${fx.id}: wrong key rejected`, other, ct, 0);
  }
  // Appendix B tags: record i's last 16 bytes.
  const v = fixtures.find((f) => f.id === "vector");
  const tags = [0, 1, 2].map((i) => [...v.ct.subarray(Math.min(v.ct.length, (i + 1) * RC) - 16, Math.min(v.ct.length, (i + 1) * RC))].map((x) => x.toString(16).padStart(2, "0")).join(""));
  results.push({ check: "vector: record tags match Appendix B", ok: tags.join() === v.meta.recordTags.join() });
  return { path: name, ok: results.every((r) => r.ok), results };
}

export async function loadFixtures() {
  const get = async (n) => new Uint8Array(await (await fetch(new URL(`../fixtures/${n}`, import.meta.url))).arrayBuffer());
  const out = [];
  for (const id of ["vector", "wrist"]) {
    out.push({ id, ct: await get(`${id}.bin`), meta: JSON.parse(new TextDecoder().decode(await get(`${id}.json`))) });
  }
  return out;
}

// ---------- timing ----------
function median(xs) { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; }

export async function timePath(fn, ct, reps) {
  const times = [];
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    const pt = await fn(ct, 0);
    times.push(performance.now() - t0);
    if (pt.length !== ptLen(ct.length)) throw new Error("bad length");
  }
  const ms = median(times);
  return { ms, MBps: ct.length / MB / (ms / 1000), runs: reps, minMs: Math.min(...times), maxMs: Math.max(...times) };
}

export function repsFor(bytes) {
  return bytes <= 2e6 ? 30 : bytes <= 60e6 ? 3 : 2;
}

export const SIZES = [
  { label: "1 MB", records: 16 },
  { label: "50 MB", records: 763 },
  { label: "400 MB", records: 6104 },
];

/** Builds the path factories: name -> async (rawKey) => decryptFn. */
export async function pathFactories(builds) {
  const f = {};
  for (const b of builds) {
    const ex = await loadWasm(b);
    // One instance per build; set_key replaces the key for the tuned path.
    f[`${b} tuned`] = async (raw) => wasmTuned(ex, raw);
    f[`${b} as-is`] = async (raw) => wasmAsis(ex, raw);
  }
  f["webcrypto sequential"] = async (raw) => wcSequential(await importKey(raw));
  for (const K of [4, 16, 64]) f[`webcrypto K=${K}`] = async (raw) => wcInFlight(await importKey(raw), K);
  return f;
}

/** Runs the correctness checks and the timing for every path in this context. */
export async function runContext({ builds, sizes = SIZES, only = null, skipSlowAt = Infinity }) {
  const fixtures = await loadFixtures();
  const factories = await pathFactories(builds);
  const names = Object.keys(factories).filter((n) => !only || only.some((o) => n.includes(o)));
  const correctness = [];
  for (const n of names) correctness.push(await checkPath(n, factories[n], fixtures));

  const raw = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i);
  const maxRecords = Math.max(...sizes.map((s) => s.records));
  const ct = await makeCiphertext(maxRecords, raw);
  const timings = [];
  for (const n of names) {
    const fn = await factories[n](raw);
    await fn(ct.subarray(0, 4 * RC), 0); // warm-up / tier-up
    for (const s of sizes) {
      const c = ct.subarray(0, s.records * RC);
      if (n.includes("as-is") && c.length > skipSlowAt) continue;
      const t = await timePath(fn, c, repsFor(c.length));
      timings.push({ path: n, size: s.label, bytes: c.length, ...t });
    }
  }
  return { correctness, timings, overhead: await probeOverhead() };
}

/** Per-call cost of crypto.subtle.decrypt, separated from AES-GCM work:
 *  tiny (16-byte plaintext) calls give the fixed cost; one 16 MiB call gives the bulk rate. */
export async function probeOverhead() {
  const raw = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i);
  const ek = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  const iv = nonce(0);
  const tiny = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ek, new Uint8Array(16)));
  const big = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ek, new Uint8Array(16 * 1048576)));
  const out = {};
  const N = 3000;
  for (let w = 0; w < 300; w++) await crypto.subtle.decrypt({ name: "AES-GCM", iv }, ek, tiny);
  let t0 = performance.now();
  for (let i = 0; i < N; i++) await crypto.subtle.decrypt({ name: "AES-GCM", iv }, ek, tiny);
  out.tinySequentialUs = ((performance.now() - t0) * 1000) / N;
  for (const K of [16, 64]) {
    t0 = performance.now();
    let next = 0;
    await Promise.all(Array.from({ length: K }, async () => { while (next++ < N) await crypto.subtle.decrypt({ name: "AES-GCM", iv }, ek, tiny); }));
    out[`tinyK${K}Us`] = ((performance.now() - t0) * 1000) / N;
  }
  const ts = [];
  for (let r = 0; r < 5; r++) { t0 = performance.now(); await crypto.subtle.decrypt({ name: "AES-GCM", iv }, ek, big); ts.push(performance.now() - t0); }
  out.oneBigCallMBps = big.length / 1e6 / (median(ts) / 1000);
  return out;
}

/** Event-loop turns on this thread while `fn` decrypts `ct`. MessageChannel pings are not
 *  throttled, so zero ticks means the thread ran no other task for the whole call. */
export async function probeJank(fn, ct) {
  const ch = new MessageChannel();
  let last = performance.now(), maxGap = 0, running = true, ticks = 0;
  ch.port1.onmessage = () => {
    const t = performance.now();
    maxGap = Math.max(maxGap, t - last);
    last = t; ticks++;
    if (running) ch.port2.postMessage(0);
  };
  ch.port2.postMessage(0);
  await new Promise((r) => setTimeout(r, 10));
  const ticks0 = ticks;
  const t0 = performance.now();
  last = t0; maxGap = 0;
  await fn(ct, 0);
  const ms = performance.now() - t0;
  const during = ticks - ticks0;
  running = false;
  ch.port1.close();
  return { ms, ticksDuring: during, longestTaskMs: during === 0 ? ms : maxGap };
}
