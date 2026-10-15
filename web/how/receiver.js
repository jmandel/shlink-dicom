// A receiver using only fetch and WebCrypto. Resolves a U-mode SMART Health Link, decrypts the
// Bundle, reads the first image of the first series with one Range request, verifies its records,
// and returns the image's file meta header. Runs in a browser, Node 24 or Bun.
const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const aesKey = (raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
const ext = (o, url) => o.extension?.find((e) => e.url === url);
const SD = "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/";
const LENGTH = SD + "instance-length", LINKED = SD + "linked-file";
const R = 65520; // plaintext bytes per record; 65,536 with the tag

export async function receive(shlink) {
  // 1. The link: base64url JSON after "shlink:/".
  const link = JSON.parse(new TextDecoder().decode(b64(shlink.split("shlink:/")[1])));
  if (!link.flag?.includes("U")) throw new Error("this receiver handles U-mode links only");

  // 2. The Bundle: one GET, then a compact JWE (dir, A256GCM, zip DEF) under the link's key.
  const jwe = await (await fetch(`${link.url}?recipient=50-line+receiver`)).text();
  const [header, , iv, ct, tag] = jwe.split(".");
  let plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64(iv), additionalData: new TextEncoder().encode(header) },
    await aesKey(b64(link.key)), new Uint8Array([...b64(ct), ...b64(tag)]));
  if (JSON.parse(new TextDecoder().decode(b64(header))).zip === "DEF") {
    plain = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
  }
  const bundle = JSON.parse(new TextDecoder().decode(plain));

  // 3. The first series' file: its own linked-file, else the study's. The file holds every
  //    instance of the series that use it, in Bundle order, so the first series starts at 0.
  const study = bundle.entry.map((e) => e.resource).find((r) => r.resourceType === "ImagingStudy");
  const fileOf = (s) => (ext(s, LINKED) ?? ext(study, LINKED)).extension;
  const sub = (f, name) => f.find((e) => e.url === name).valueString;
  const series = study.series[0], fileId = sub(fileOf(series), "id");
  const key = await aesKey(b64(sub(fileOf(series), "key")));
  const len = (i) => ext(i, LENGTH).valueDecimal, first = len(series.instance[0]);
  const P = study.series.filter((s) => sub(fileOf(s), "id") === fileId).flatMap((s) => s.instance).reduce((a, i) => a + len(i), 0);
  const C = P + 16 * Math.ceil(P / R);

  // 4. One Range request for the records holding bytes [0, first) of the file.
  const last = Math.floor((first - 1) / R), end = Math.min(C, (last + 1) * 65536);
  const res = await fetch(new URL(`${fileId}.bin?recipient=50-line+receiver`, link.url), { headers: { Range: `bytes=0-${end - 1}` } });
  const body = new Uint8Array(await res.arrayBuffer()).subarray(0, end);
  if (body.length !== end) throw new Error(`expected ${end} bytes, got ${body.length}`);

  // 5. Verify and decrypt each record. The nonce is the record index as 12 bytes, big-endian.
  const dcm = new Uint8Array((last + 1) * R);
  for (let i = 0; i <= last; i++) {
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setUint32(8, i);
    const rec = body.subarray(i * 65536, Math.min(end, (i + 1) * 65536)); // throws below if altered
    dcm.set(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, rec)), i * R);
  }

  // 6. The DICOM file meta header: group 0002, explicit VR little endian, after "DICM" at 128.
  const dv = new DataView(dcm.buffer), meta = {};
  if (new TextDecoder().decode(dcm.subarray(128, 132)) !== "DICM") throw new Error("not a DICOM file");
  for (let p = 132; dv.getUint16(p, true) === 2; ) {
    const vr = String.fromCharCode(dcm[p + 4], dcm[p + 5]), long = ["OB", "OW", "UN", "SQ", "UT"].includes(vr);
    const len = long ? dv.getUint32(p + 8, true) : dv.getUint16(p + 6, true), at = p + (long ? 12 : 8);
    if (vr === "UI") meta[dv.getUint16(p + 2, true)] = new TextDecoder().decode(dcm.subarray(at, at + len)).replace(/\0$/, "");
    p = at + len;
  }
  return {
    series: series.description, modality: series.modality?.code, bytes: first, records: last + 1,
    sopClassUid: meta[2], sopInstanceUid: meta[3], transferSyntax: meta[0x10],
    matchesBundle: meta[3] === series.instance[0].uid,
  };
}
