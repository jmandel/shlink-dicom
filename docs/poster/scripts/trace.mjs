// Trace one slice of the live sample, from link to pixels, and write the numbers with their sources.
// usage: node trace.mjs [site] [out.json]   (default https://shlink-dicom.exe.xyz, ../data/trace.json)
import fs from "fs";
const SITE = process.argv[2] || "https://shlink-dicom.exe.xyz";
const OUT = process.argv[3] || new URL("../data/trace.json", import.meta.url).pathname;
const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const R = 65520, LF = "/linked-file", LEN = "/instance-length";
const ext = (o, s) => o.extension?.find((e) => e.url.endsWith(s));
const sub = (e, n) => e.extension.find((x) => x.url === n).valueString;

const red = await fetch(`${SITE}/sample`, { redirect: "manual" });
const viewUrl = red.headers.get("location");
const shlink = "shlink:/" + viewUrl.split("shlink:/")[1];
const link = JSON.parse(new TextDecoder().decode(b64(shlink.slice(8))));
const jwe = (await (await fetch(link.url)).text()).trim();
const [header, , iv, ct, tag] = jwe.split(".");
const hdr = JSON.parse(new TextDecoder().decode(b64(header)));
const k = await crypto.subtle.importKey("raw", b64(link.key), "AES-GCM", false, ["decrypt"]);
let plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(iv), additionalData: new TextEncoder().encode(header) }, k, new Uint8Array([...b64(ct), ...b64(tag)]));
if (hdr.zip === "DEF") plain = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
const bundle = JSON.parse(new TextDecoder().decode(plain));
const types = {}; for (const e of bundle.entry) types[e.resource.resourceType] = (types[e.resource.resourceType] || 0) + 1;
const base = link.url.replace(/bundle\.jwe$/, "");
const files = []; let T = null, instances = 0, series = 0;
for (const st of bundle.entry.map((e) => e.resource).filter((r) => r.resourceType === "ImagingStudy")) {
  const sfile = ext(st, LF); const off = {};
  for (const s of st.series) {
    series++; instances += s.instance.length;
    const f = ext(s, LF) || sfile; const id = sub(f, "id"); off[id] ??= 0; const sOff = off[id];
    const L = s.instance.map((i) => ext(i, LEN).valueDecimal); const sBytes = L.reduce((x, y) => x + y, 0);
    if (/BRAIN/.test(st.description) && s.number === 16) {
      const kk = s.instance.findIndex((i) => i.number === 11);
      const a = sOff + L.slice(0, kk).reduce((x, y) => x + y, 0), b = a + L[kk];
      T = { study: st.description, series: s.number, seriesDescription: s.description, instance: 11, instancesInSeries: L.length,
        seriesBefore: st.series.slice(0, st.series.indexOf(s)).length, seriesOffset: sOff, seriesBytes: sBytes,
        seriesFirstRecord: Math.floor(sOff / R), seriesLastRecord: Math.floor((sOff + sBytes - 1) / R),
        instanceOffset: a, instanceEnd: b - 1, instanceBytes: L[kk], firstRecord: Math.floor(a / R), lastRecord: Math.floor((b - 1) / R),
        fileId: id, key: sub(f, "key"), sopClass: s.instance[kk].sopClass?.code };
    }
    off[id] += sBytes;
  }
  for (const [id, p] of Object.entries(off)) {
    const n = Math.max(1, Math.ceil(p / R)), C = p + 16 * n;
    const h = await fetch(`${base}${id}.bin`, { method: "HEAD" });
    files.push({ study: st.description, id, plaintext: p, ciphertext: C, records: n, served: +h.headers.get("content-length") });
  }
}
const f = files.find((x) => x.id === T.fileId);
Object.assign(T, { fileBytes: f.ciphertext, fileRecords: f.records });
T.rangeStart = T.firstRecord * 65536; T.rangeEnd = Math.min(f.ciphertext, (T.lastRecord + 1) * 65536) - 1;
T.range = `bytes=${T.rangeStart}-${T.rangeEnd}`; T.responseBytes = T.rangeEnd - T.rangeStart + 1; T.records = T.lastRecord - T.firstRecord + 1;
T.offsetInFirstRecord = T.instanceOffset - T.firstRecord * R;
// live Range request, tag check, and the instance's transfer syntax
const res = await fetch(`${base}${T.fileId}.bin`, { headers: { Range: T.range } });
const body = new Uint8Array(await res.arrayBuffer());
const K = await crypto.subtle.importKey("raw", b64(T.key), "AES-GCM", false, ["decrypt"]);
const pt = new Uint8Array(T.records * R); let tagsOk = 0;
for (let i = T.firstRecord; i <= T.lastRecord; i++) {
  const n = new Uint8Array(12); new DataView(n.buffer).setUint32(8, i);
  const rec = body.subarray((i - T.firstRecord) * 65536, Math.min(body.length, (i - T.firstRecord + 1) * 65536));
  pt.set(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: n }, K, rec)), (i - T.firstRecord) * R); tagsOk++;
}
const inst = pt.subarray(T.offsetInFirstRecord, T.offsetInFirstRecord + T.instanceBytes);
const ts = new TextDecoder().decode(inst).match(/1\.2\.840\.10008\.1\.2[0-9.]*/g)?.find((u) => u.startsWith("1.2.840.10008.1.2")) ?? null;
fs.writeFileSync(new URL("../data/slice.dcm", import.meta.url).pathname, inst);
delete T.key;
const out = {
  measuredAt: new Date().toISOString(), site: SITE, sampleRedirect: `${SITE}/sample`, linkUrl: link.url, linkFlag: link.flag, linkKeyBytes: b64(link.key).length,
  jwe: { bytes: jwe.length, header: hdr }, bundle: { types, studies: types.ImagingStudy, series, instances },
  files, filesCount: files.length, totalCiphertext: files.reduce((x, y) => x + y.ciphertext, 0), allServedMatch: files.every((x) => x.served === x.ciphertext),
  slice: { ...T, liveStatus: res.status, liveContentRange: res.headers.get("content-range"), liveBytes: body.length, tagsOk, dicm: new TextDecoder().decode(inst.subarray(128, 132)), transferSyntax: ts },
  source: "docs/poster/scripts/trace.mjs against the live /sample link",
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ jwe: out.jwe.bytes, files: out.filesCount, total: out.totalCiphertext, ok: out.allServedMatch, slice: { file: T.fileBytes, rec: T.fileRecords, r: [T.firstRecord, T.lastRecord], range: T.range, resp: T.responseBytes, status: res.status, tagsOk, ts } }));
