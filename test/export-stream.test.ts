import { expect, test } from "bun:test";
import { exportZip, writeInstance } from "../web/core/export";
import { ExportExecution } from "../web/core/export-execution";
import { InstanceLoader, MAX_READ_BYTES } from "../web/core/loader";
import { ciphertextLength, recordCount, recordNonce, planChunks, RECORD_PLAINTEXT as R, RECORD_CIPHERTEXT as C } from "../web/core/range";
import type { SeriesEntry } from "../web/core/bundle";
import { WebCryptoDecryptor } from "../web/core/decrypt";
import { ZipWriter } from "../web/core/zip";
import { DicomdirHeader } from "../web/core/dicomdir-header";
import { readDicomHeader } from "../web/core/dicom-header";
import { part10, element } from "../web/checks/synthetic";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";
import { parseDicomSync } from "../web/core/dicom";

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0; for (const b of parts) { out.set(b, at); at += b.length; } return out;
};
function dicom(pixelBytes = 1024, privateBytes = 0) {
  return part10("1.2.840.10008.5.1.4.1.1.7", "2.25.4", "1.2.840.10008.1.2.1", [
    element(0x0008, 0x0060, "CS", "OT"),
    ...(privateBytes ? [element(0x0009, 0x1000, "OB", new Uint8Array(privateBytes))] : []),
    element(0x0010, 0x0010, "PN", "STREAM^TEST"), element(0x0010, 0x0020, "LO", "stream-patient"),
    element(0x0020, 0x000d, "UI", "2.25.2"), element(0x0020, 0x000e, "UI", "2.25.3"),
    element(0x7fe0, 0x0010, "OB", new Uint8Array(pixelBytes).fill(37)),
  ]);
}

async function encrypted(bytes: Uint8Array, offset = R - 1, tail = 7) {
  const series = fixture(offset, bytes.length), source = new Uint8Array(offset + bytes.length + tail).fill(91);
  source.set(bytes, offset);
  series.file.plaintextLength = source.length;
  series.file.ciphertextLength = ciphertextLength(source.length);
  series.file.recordCount = recordCount(source.length);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  series.file.key = Buffer.from(raw).toString("base64url");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(series.file.ciphertextLength);
  for (let i = 0; i < series.file.recordCount; i++) {
    const b = await crypto.subtle.encrypt({ name: "AES-GCM", iv: recordNonce(i) }, key, source.subarray(i * R, (i + 1) * R));
    ciphertext.set(new Uint8Array(b), i * C);
  }
  const plans: number[] = [], decryptor = new WebCryptoDecryptor();
  const loader = new InstanceLoader({ fetchRange: async (p: any) => ciphertext.slice(p.ciphertextStart, p.ciphertextEnd) } as any, {
    decrypt(s, p, ct) { plans.push(ct.length); return decryptor.decrypt(s, p, ct); },
  }, { cacheBytes: 0 });
  return { series, loader, plans, ciphertext };
}

function fixture(offset: number, length: number): SeriesEntry {
  const plaintextLength = offset + length;
  return { id: "test@" + offset, uid: "2.25.3", offset, bytes: length,
    file: { fileId: "test", key: "unused", plaintextLength, ciphertextLength: ciphertextLength(plaintextLength), recordCount: recordCount(plaintextLength) },
    instances: [{ uid: "2.25.4", sopClass: "1.2.840.10008.5.1.4.1.1.7", offset, length }],
  } as SeriesEntry;
}

test("record-bounded chunks cover unaligned instances exactly, including a short final record", () => {
  for (const offset of [0, 1, R - 1]) for (const length of [1, R, R + 1, 5 * R + 17]) {
    const s = fixture(offset, length), plans = [...planChunks(s, offset, offset + length, 2 * C)];
    expect(plans[0].plaintextStart).toBe(offset);
    expect(plans.at(-1)!.plaintextEnd).toBe(offset + length);
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i]; expect(p.ciphertextEnd - p.ciphertextStart).toBeLessThanOrEqual(2 * C);
      if (i) { expect(p.plaintextStart).toBe(plans[i - 1].plaintextEnd); expect(p.firstRecord).toBe(plans[i - 1].lastRecord + 1); }
    }
  }
});

test("encrypted instance streams byte-identically; a stalled consumer does not start another read", async () => {
  const bytes = dicom(7 * R + 18), f = await encrypted(bytes);
  const stream = f.loader.streamInstance(f.series, 0, { chunkBytes: 2 * C });
  const first = await stream.next();
  expect(first.done).toBe(false); expect(f.plans).toEqual([2 * C]);
  await new Promise(r => setTimeout(r, 10)); expect(f.plans).toEqual([2 * C]);
  const parts = [first.value!]; for await (const b of stream) parts.push(b);
  expect(concat(parts)).toEqual(bytes);
  expect(Math.max(...f.plans)).toBeLessThanOrEqual(2 * C);
});

test("ZIP export preserves a large authenticated instance and its DICOMDIR after a large private element", async () => {
  const bytes = dicom(8 << 20, 5 << 20), f = await encrypted(bytes), parts: Uint8Array[] = [];
  let closed = false;
  await exportZip({ kind: "series", study: {} as any, series: f.series }, f.loader, {
    async write(b) { parts.push(b); }, async close() { closed = true; }, async abort() { throw new Error("unexpected abort"); },
  });
  expect(closed).toBe(true); expect(Math.max(...f.plans)).toBeLessThanOrEqual(4 << 20);
  const dir = await mkdtemp(tmpdir() + "/shl-export-test-");
  try {
    await Bun.write(dir + "/export.zip", concat(parts));
    // Python's independent ZIP implementation verifies descriptor CRCs and original bytes.
    const p = Bun.spawnSync(["python3", "-c", "import zipfile,hashlib,json,sys;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({'bad':z.testzip(),'hash':hashlib.sha256(z.read('DICOM/ST000001/SE000001/IM000001')).hexdigest()}));open(sys.argv[2],'wb').write(z.read('DICOMDIR'))", dir + "/export.zip", dir + "/DICOMDIR"]);
    expect(p.exitCode).toBe(0);
    const result = JSON.parse(new TextDecoder().decode(p.stdout));
    expect(result.bad).toBe(null);
    expect(result.hash).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
    const index = new TextDecoder().decode(await Bun.file(dir + "/DICOMDIR").arrayBuffer());
    expect(index).toContain("STREAM^TEST"); expect(index).toContain("stream-patient"); expect(index).toContain("2.25.4");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30000);

for (const failure of ["authentication", "cancel", "sink"] as const) test(`streaming individual export aborts on ${failure} after earlier verified bytes`, async () => {
  const f = await encrypted(dicom(5 << 20));
  if (failure === "authentication") f.ciphertext[(4 << 20) + 10] ^= 1;
  const job = new ExportExecution(1, "file.dcm");
  let writes = 0, closes = 0, aborts = 0;
  const result = job.run({
    async write() { writes++; if (failure === "cancel") job.cancel(); if (failure === "sink") throw new Error("disk full"); },
    async close() { closes++; }, async abort() { aborts++; },
  }, (task, out) => writeInstance(f.loader, f.series, 0, out, task));
  await expect(result).rejects.toThrow();
  expect(writes).toBe(1); expect(closes).toBe(0); expect(aborts).toBe(1);
  expect(job.phase).toBe(failure === "cancel" ? "cancelled" : "failed"); expect(job.snapshot.cleanupComplete).toBe(true);
}, 30000);

test("ZIP streaming rejects a source that differs from its declared size", async () => {
  for (const size of [1, 3]) {
    const z = new ZipWriter({ async write() {}, async close() {}, async abort() {} });
    await expect(z.addStream("file", size, (async function* () { yield new Uint8Array(2); })())).rejects.toThrow(/declared length/);
  }
});

test("DICOMDIR collection spans tiny chunks and skips a large private value", async () => {
  const bytes = dicom(10, 100000), collector = new DicomdirHeader();
  for (let p = 0; p < bytes.length; p += 19) await collector.feed(bytes.subarray(p, p + 19));
  expect(await collector.finish()).toEqual(await readDicomHeader(bytes));
});

test("DICOMDIR collection incrementally inflates a deflated dataset", async () => {
  const native = dicom(1024), { metaEnd } = parseDicomSync(native);
  const bytes = part10("1.2.840.10008.5.1.4.1.1.7", "2.25.4", "1.2.840.10008.1.2.1.99", [deflateRawSync(native.subarray(metaEnd))]);
  const collector = new DicomdirHeader();
  try {
    for (let p = 0; p < bytes.length; p += 7) await collector.feed(bytes.subarray(p, p + 7));
    expect(await collector.finish()).toEqual(await readDicomHeader(bytes));
  } finally { await collector.dispose(); }
});

test("DICOMDIR collection ignores nested attributes in undefined-length sequences", async () => {
  const bytes = part10("1.2.840.10008.5.1.4.1.1.7", "2.25.4", "1.2.840.10008.1.2.1", [
    new Uint8Array([8,0,17,17,83,81,0,0,255,255,255,255,254,255,0,224,255,255,255,255]),
    element(0x0010, 0x0010, "PN", "WRONG^NESTED"),
    new Uint8Array([254,255,13,224,0,0,0,0,254,255,221,224,0,0,0,0]),
    element(0x0010, 0x0010, "PN", "RIGHT^TOPLEVEL"),
    element(0x7fe0, 0x0010, "OB", new Uint8Array(10)),
  ]);
  const collector = new DicomdirHeader();
  for (let p = 0; p < bytes.length; p += 3) await collector.feed(bytes.subarray(p, p + 3));
  expect(await collector.finish()).toEqual(await readDicomHeader(bytes));
});

// Exercise the real planner, loader and export entry points at the former failure boundary.
// The sink intentionally fails after the first payload chunk: no multi-GB allocation or I/O.
for (const kind of ["instance", "zip"] as const) for (const offset of [0, R - 1]) {
  test(`${kind}: a >2 GiB record range reaches the sink through bounded reads (offset ${offset})`, async () => {
    const series = fixture(offset, MAX_READ_BYTES / C * R - offset + 1);
    const reads: number[] = [];
    const loader = new InstanceLoader({ fetchRange: async (plan: any) => new Uint8Array(plan.ciphertextEnd - plan.ciphertextStart) } as any, {
      async decrypt(_series, plan) {
        const n = plan.plaintextEnd - plan.plaintextStart;
        reads.push(n);
        expect(n).toBeLessThanOrEqual(8 << 20);
        return new Uint8Array(n);
      },
    });
    let aborts = 0, closes = 0, payload = 0;
    const sink = {
      async write(bytes: Uint8Array) { if (bytes.length >= R) { payload += bytes.length; throw new Error("sink reached safely"); } },
      async close() { closes++; }, async abort() { aborts++; },
    };
    const job = new ExportExecution(1, "large.dcm");
    const writing = kind === "zip"
      ? exportZip({ kind: "series", study: {} as any, series }, loader, sink)
      : job.run(sink, (task, out) => writeInstance(loader, series, 0, out, task));
    await expect(writing).rejects.toThrow("sink reached safely");
    expect(payload).toBeGreaterThan(0);
    expect(reads.length).toBe(1); // sink backpressure/failure prevents the next chunk
    expect(aborts).toBe(1); expect(closes).toBe(0);
  });
}
