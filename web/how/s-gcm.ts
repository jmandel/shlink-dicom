// Step 7: the AES-256-GCM tag. The slice is drawn as the bands of rows its records hold. Before
// decryption each band shows its ciphertext as noise; each record is then checked and decrypted in a
// worker, and its band turns into those rows of the image. The tamper switch flips one bit of the
// response on arrival, and that record is refused.
import { decryptParams, parseDicomSync, planBytes, planInstances, RECORD_CIPHERTEXT, RECORD_PLAINTEXT, recordNonce, RecordAuthenticationError, T } from "../core/index";
import { code, h, hex, n, para, recordLength, S, wait } from "./state";

interface Geometry {
  rows: number;
  cols: number;
  /** File offset of the first pixel. */
  p0: number;
  center: number;
  width: number;
  slope: number;
  intercept: number;
  signed: boolean;
}

export function mountGcm(pic: HTMLElement, exact: HTMLElement) {
  const series = S.series!;
  const f = series.file;
  const inst = series.instances[S.slice];
  const recs: number[] = [];
  for (let r = inst.firstRecord; r <= inst.lastRecord; r++) recs.push(r);
  const canvas = h("canvas", { "aria-label": `Slice ${S.slice + 1}, drawn from its records` });
  const marks = h("div", { class: "bands", "aria-hidden": "true" });
  const box = h("div", { class: "band-box" }, canvas, marks);
  const verdict = h("p", { class: "verdict", "aria-live": "polite" });
  const tamperBox = h("input", { id: "tamper", type: "checkbox", role: "switch" }) as HTMLInputElement;
  const again = h("button", { id: "refetch", class: "btn", type: "button", text: "Fetch the records again" }) as HTMLButtonElement;
  pic.replaceChildren(
    h(
      "div",
      { class: "row wrap controls" },
      h("label", { class: "switch" }, tamperBox, h("span", { class: "switch-track", "aria-hidden": "true" }, h("span", { class: "switch-thumb" })), h("span", { text: "Change one bit on the way" })),
      again,
    ),
    box,
    verdict,
  );
  const list = h("div", { class: "reqs" });
  exact.replaceChildren(
    para("Each record is encrypted on its own with AES-256-GCM, under the file's key from the ", code("linked-file"), " extension. The nonce (a number used once) is the record's number, written as 12 bytes. Decryption recomputes the 16-byte tag from the ciphertext and fails if it differs."),
    para("So a changed bit is caught, and so is a record moved to another place, because its nonce no longer matches. Each record can be checked as soon as it arrives, without the rest of the file."),
    para("This slice's records, with their nonces and tags:"),
    list,
  );

  let geo: Geometry | null = null;
  let im: ImageData | null = null;
  const span = (r: number) => [r * RECORD_PLAINTEXT, Math.min(f.plaintextLength, (r + 1) * RECORD_PLAINTEXT)];

  /** Paints record r's pixels: real samples, or (before decryption) its ciphertext bytes. */
  const paint = (r: number, bytes: Uint8Array, cipher: boolean, bad = false) => {
    const g = geo!, d = im!.data;
    const [a] = span(r);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const first = Math.max(0, Math.ceil((a - g.p0) / 2)), last = Math.min(g.rows * g.cols, Math.floor((a + bytes.length - g.p0) / 2));
    for (let k = first; k < last; k++) {
      const off = g.p0 + 2 * k - a;
      if (off < 0 || off + 2 > bytes.length) continue;
      let v: number;
      if (bad) v = -1;
      else if (cipher) v = bytes[off];
      else {
        const raw = g.signed ? dv.getInt16(off, true) : dv.getUint16(off, true);
        const x = raw * g.slope + g.intercept;
        v = Math.max(0, Math.min(255, ((x - (g.center - 0.5)) / (g.width - 1) + 0.5) * 255));
      }
      const i = 4 * k;
      if (v < 0) (d[i] = 180), (d[i + 1] = 30), (d[i + 2] = 30);
      else d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  };
  const flush = () => canvas.getContext("2d")!.putImageData(im!, 0, 0);

  /** The image geometry, from the DICOM header in the slice's first two records (decrypted in a worker). */
  const learn = async (ct: Uint8Array, firstRec: number) => {
    const pool = await S.pool!;
    const lastRec = Math.min(inst.lastRecord, firstRec + 1);
    const rec = ct.slice(0, (lastRec - firstRec) * RECORD_CIPHERTEXT + recordLength(f, lastRec));
    const p = await decryptParams(series, planBytes(series, firstRec * RECORD_PLAINTEXT, span(lastRec)[1]));
    const pt = await pool.decrypt(rec, p);
    const head = pt.subarray(inst.offset - firstRec * RECORD_PLAINTEXT);
    const { ds } = parseDicomSync(head, { untilPixelData: true });
    const rows = ds.nums(T.Rows)[0], cols = ds.nums(T.Columns)[0];
    // Pixel Data (7FE0,0010): explicit VR OW puts the value 12 bytes after the tag.
    let at = -1;
    for (let i = 132; i + 12 < head.length; i++)
      if (head[i] === 0xe0 && head[i + 1] === 0x7f && head[i + 2] === 0x10 && head[i + 3] === 0x00) {
        at = i;
        break;
      }
    const vr = at >= 0 ? String.fromCharCode(head[at + 4], head[at + 5]) : "";
    if (at < 0 || !rows || !cols || ds.nums(T.BitsAllocated)[0] !== 16) throw new Error("this slice's pixels are not 16-bit uncompressed");
    geo = {
      rows,
      cols,
      p0: inst.offset + at + (vr === "OW" || vr === "OB" ? 12 : 8),
      center: ds.nums(T.WindowCenter)[0] ?? 500,
      width: ds.nums(T.WindowWidth)[0] ?? 1000,
      slope: ds.nums(T.RescaleSlope)[0] ?? 1,
      intercept: ds.nums(T.RescaleIntercept)[0] ?? 0,
      signed: ds.nums(T.PixelRepresentation)[0] === 1,
    };
    canvas.width = cols;
    canvas.height = rows;
    im = new ImageData(cols, rows);
    // A label where each record's rows begin; a record whose rows all lie above the next one's is skipped.
    const ys = recs.map((r) => Math.max(0, (r * RECORD_PLAINTEXT - geo!.p0) / 2 / cols));
    marks.replaceChildren(...recs.filter((_, i) => i === recs.length - 1 || ys[i + 1] - ys[i] >= 4).map((r) => h("span", { style: `top:${(100 * ys[recs.indexOf(r)]) / rows}%`, text: `record ${r}` })));
  };

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    again.disabled = true;
    verdict.className = "verdict";
    verdict.textContent = "";
    const plan = planInstances(series, S.slice);
    try {
      if (!geo) await learn((await S.share!.resolver.fetchRange(plan)).slice(), plan.firstRecord);
      S.tamper.flipped = null;
      S.tamper.range = tamperBox.checked ? plan.rangeHeader : null;
      const ct = await S.share!.resolver.fetchRange(plan);
      const flipped = S.tamper.flipped as { byte: number; bit: number } | null;
      const records = recs.map((r) => {
        const off = (r - plan.firstRecord) * RECORD_CIPHERTEXT;
        return { r, rec: ct.slice(off, off + recordLength(f, r)) };
      });
      for (const x of records) paint(x.r, x.rec, true);
      flush();
      list.replaceChildren(...records.map((x) => h("div", { text: `record ${x.r}: nonce ${hex(recordNonce(x.r))}, tag ${hex(x.rec.subarray(x.rec.length - 16))}` })));
      await wait(600);
      const pool = await S.pool!;
      let refused = -1;
      for (const x of records) {
        const params = await decryptParams(series, planBytes(series, x.r * RECORD_PLAINTEXT, span(x.r)[1]));
        try {
          paint(x.r, await pool.decrypt(x.rec.slice(), params), false);
        } catch (e) {
          if ((e as Error)?.name !== "RecordAuthenticationError" && !(e instanceof RecordAuthenticationError)) throw e;
          refused = x.r;
          paint(x.r, x.rec, true, true);
        }
        flush();
        await wait(80);
      }
      if (refused >= 0) {
        verdict.className = "verdict bad";
        const where = flipped ? ` Bit ${flipped.bit} of byte ${n(flipped.byte % RECORD_CIPHERTEXT)} in it was flipped on the way.` : "";
        verdict.textContent = `Record ${refused} failed its tag check, so its rows stay blank.${where}`;
      } else {
        verdict.className = "verdict good";
        verdict.textContent = `All ${records.length} records passed their tag check and decrypted.`;
      }
    } catch (e) {
      verdict.className = "verdict bad";
      verdict.textContent = (e as Error).message;
    } finally {
      S.tamper.range = null;
      running = false;
      again.disabled = false;
    }
  };
  again.addEventListener("click", () => void run());
  tamperBox.addEventListener("change", () => void run());
  void run();
}
