// Real >2 GiB original and >4 GiB ZIP64 exports, with bounded generated/encrypted input.
// CHECK_OUT=/path/with/7GB/free bun web/checks/large-export-check.ts
// No multi-gigabyte source allocation. Python independently checks the ZIP CRC and SHA-256.
import { mkdir, open, rm } from "node:fs/promises";
import { exportZip, writeInstance } from "../core/export";
import { ExportExecution } from "../core/export-execution";
import { InstanceLoader } from "../core/loader";
import { WebCryptoDecryptor } from "../core/decrypt";
import { ciphertextLength, recordCount, recordNonce, RECORD_PLAINTEXT as R, RECORD_CIPHERTEXT as C } from "../core/range";
import type { SeriesEntry } from "../core/bundle";
import { element, part10 } from "./synthetic";

const out = process.env.CHECK_OUT ?? "/tmp/shl-large-export";
await mkdir(out, { recursive: true });
const must = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const results: object[] = [];
const raw = new Uint8Array(32).fill(17), key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
for (const kind of ["instance", "zip"] as const) {
  const started = performance.now(), privateSize = kind === "zip" ? (1 << 30) + C : 0;
  const pixelSize = kind === "zip" ? 3 * 2 ** 30 : 2 ** 31 + C;
  const variable = (g: number, e: number, size: number) => {
    const header = element(g, e, "OB", new Uint8Array()); new DataView(header.buffer).setUint32(8, size, true); return header;
  };
  const prefix = part10("1.2.840.10008.5.1.4.1.1.7.2", "2.25.4", "1.2.840.10008.1.2.1", [
    element(8, 0x60, "CS", "OT"), ...(privateSize ? [variable(9, 0x1000, privateSize)] : []),
  ]);
  const rest = [
    element(0x10, 0x10, "PN", "LARGE^STREAM"), element(0x10, 0x20, "LO", "STREAM-TEST"),
    element(0x20, 0x0d, "UI", "2.25.2"), element(0x20, 0x0e, "UI", "2.25.3"),
    variable(0x7fe0, 0x10, pixelSize),
  ];
  const pieces: { offset: number; bytes: Uint8Array }[] = [{ offset: 0, bytes: prefix }];
  let length = prefix.length + privateSize;
  for (const bytes of rest) { pieces.push({ offset: length, bytes }); length += bytes.length; }
  length += pixelSize;
  const packedOffset = R - 1, P = packedOffset + length + 19;
  const source = (a: number, b: number) => {
    const bytes = new Uint8Array(b - a);
    for (const p of pieces) {
      const lo = Math.max(a, p.offset), hi = Math.min(b, p.offset + p.bytes.length);
      if (lo < hi) bytes.set(p.bytes.subarray(lo - p.offset, hi - p.offset), lo - a);
    }
    return bytes;
  };
  const expected = new Bun.CryptoHasher("sha256");
  for (let a = 0; a < length; a += 4 << 20) expected.update(source(a, Math.min(length, a + (4 << 20))));
  const expectedHash = expected.digest("hex");
  const series = { id: "large@" + packedOffset, uid: "2.25.3", offset: packedOffset, bytes: length,
    file: { fileId: "large", key: Buffer.from(raw).toString("base64url"), plaintextLength: P, ciphertextLength: ciphertextLength(P), recordCount: recordCount(P) },
    instances: [{ uid: "2.25.4", offset: packedOffset, length }],
  } as SeriesEntry;
  let networkBytes = 0, maxFetch = 0, maxDecrypt = 0, peakRss = 0, outputBytes = 0, lastReport = 0;
  const decryptor = new WebCryptoDecryptor();
  const loader = new InstanceLoader({ async fetchRange(plan: any) {
    const bytes = new Uint8Array(plan.ciphertextEnd - plan.ciphertextStart);
    maxFetch = Math.max(maxFetch, bytes.length); networkBytes += bytes.length;
    await Promise.all(Array.from({ length: plan.lastRecord - plan.firstRecord + 1 }, async (_, n) => {
      const i = plan.firstRecord + n, a = i * R, b = Math.min(P, a + R);
      const plain = source(a - packedOffset, b - packedOffset);
      const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: recordNonce(i) }, key, plain);
      bytes.set(new Uint8Array(cipher), n * C);
    }));
    return bytes;
  } } as any, { decrypt(s, p, ct) { maxDecrypt = Math.max(maxDecrypt, ct.length); return decryptor.decrypt(s, p, ct); } }, { cacheBytes: 0 });
  const path = `${out}/large.${kind === "zip" ? "zip" : "dcm"}`, file = await open(path, "w");
  const outputHash = new Bun.CryptoHasher("sha256");
  let closed = false;
  const sink = {
    async write(bytes: Uint8Array) {
      let at = 0;
      while (at < bytes.length) at += (await file.write(bytes, at, bytes.length - at)).bytesWritten;
      if (kind === "instance") outputHash.update(bytes);
      outputBytes += bytes.length; peakRss = Math.max(peakRss, process.memoryUsage().rss);
      if (outputBytes - lastReport > 512 * 2 ** 20) { lastReport = outputBytes; console.log(JSON.stringify({ kind, writtenMiB: Math.round(outputBytes / 2 ** 20), rssMiB: Math.round(peakRss / 2 ** 20) })); }
    },
    async close() { await file.close(); closed = true; },
    async abort() { await file.close(); },
  };
  if (kind === "instance") {
    const job = new ExportExecution(1, "large.dcm");
    await job.run(sink, (task, target) => writeInstance(loader, series, 0, target, task));
    must(job.phase === "completed" && job.snapshot.cleanupComplete, "individual job did not complete");
    must(outputHash.digest("hex") === expectedHash && outputBytes === length, "individual output differs from original");
  } else {
    await exportZip({ kind: "series", study: {} as any, series }, loader, sink);
    const p = Bun.spawn(["python3", "-c", `import zipfile,hashlib,json,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 info=z.getinfo('DICOM/ST000001/SE000001/IM000001')
 assert info.file_size>2**32
 h=hashlib.sha256()
 with z.open(info) as f:
  while b:=f.read(4*1024*1024): h.update(b)
 assert h.hexdigest()==sys.argv[2]
 d=z.read('DICOMDIR')
 assert b'LARGE^STREAM' in d and b'STREAM-TEST' in d
 print(json.dumps({'zip64':True,'crcVerified':True,'sha256':h.hexdigest(),'size':info.file_size,'dicomdir':True}))`, path, expectedHash], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    must(code === 0, `independent ZIP64 verification failed: ${stderr}`); console.log(stdout.trim());
  }
  must(closed && maxDecrypt <= 4 * 2 ** 20 && maxFetch <= 4 * 2 ** 20, `unbounded read or unclosed output: ${JSON.stringify({ closed, maxDecrypt, maxFetch })}`);
  must(peakRss < 1024 * 2 ** 20, "process exceeded the 1 GiB integration-test RSS ceiling");
  const result = { kind, success: true, instanceBytes: length, outputBytes, networkBytes, maxFetch, maxDecrypt, peakRss, sha256: expectedHash, ms: Math.round(performance.now() - started) };
  results.push(result); console.log(JSON.stringify(result));
  await Bun.write(`${out}/results.json`, JSON.stringify(results, null, 2) + "\n");
  if (process.env.KEEP_LARGE_EXPORTS !== "1") await rm(path);
}
