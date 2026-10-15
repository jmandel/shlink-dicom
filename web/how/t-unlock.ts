// Step 4: unlocking. The slice is drawn as the bands of rows its pieces hold. Locked, each band
// shows its ciphertext as noise; each piece is then unlocked and checked in a worker, and its band
// turns into those rows of the image. The tamper switch flips one bit of the response on arrival,
// and that piece is refused.
import { decryptParams, parseDicomSync, planBytes, planInstances, RECORD_CIPHERTEXT, RECORD_PLAINTEXT, recordNonce, RecordAuthenticationError, T } from "../core/index";
import type { Scene } from "./how";
import { $, h, hex, n, recordLength, S, wait } from "./state";

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

export function unlockScene(): Scene {
  const series = S.series!;
  const f = series.file;
  const inst = series.instances[S.slice];
  const recs: number[] = [];
  for (let r = inst.firstRecord; r <= inst.lastRecord; r++) recs.push(r);
  const canvas = h("canvas", { "aria-label": `Slice ${S.slice + 1}, drawn from its pieces` });
  const marks = h("div", { class: "bands", "aria-hidden": "true" });
  const box = h("div", { class: "band-box" }, canvas, marks);
  const verdict = h("p", { class: "verdict", "aria-live": "polite" });
  const list = $("d-unlock");
  const el = h(
    "section",
    { class: "scene", "data-scene": "unlock", "aria-label": "Unlocking" },
    h("p", { class: "scene-title", text: `Slice ${S.slice + 1}: pieces ${inst.firstRecord}–${inst.lastRecord}` }),
    h("div", { class: "grow band-wrap" }, box),
    verdict,
  );
  let geo: Geometry | null = null;
  let im: ImageData | null = null;

  /** The image rows' bytes inside piece r: [file offset start, end). */
  const span = (r: number) => [r * RECORD_PLAINTEXT, Math.min(f.plaintextLength, (r + 1) * RECORD_PLAINTEXT)];

  /** Paints the pixels of piece r: real samples, or (locked) the ciphertext read the same way. */
  const paint = (r: number, bytes: Uint8Array, locked: boolean, bad = false) => {
    const g = geo!, d = im!.data;
    const [a] = span(r);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const first = Math.max(0, Math.ceil((a - g.p0) / 2)), last = Math.min(g.rows * g.cols, Math.floor((a + bytes.length - g.p0) / 2));
    for (let k = first; k < last; k++) {
      const off = g.p0 + 2 * k - a;
      if (off < 0 || off + 2 > bytes.length) continue;
      let v: number;
      if (bad) v = -1;
      else if (locked) v = bytes[off];
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

  /**
   * Reads the image geometry from the header (decrypted in a worker). The slice can start near the
   * end of its first piece, so the header is read from its first two pieces.
   */
  const learn = async (ct: Uint8Array, firstRec: number) => {
    const pool = await S.pool!;
    const lastRec = Math.min(inst.lastRecord, firstRec + 1);
    const rec = ct.slice(0, (lastRec - firstRec) * RECORD_CIPHERTEXT + recordLength(f, lastRec));
    const p = await decryptParams(series, planBytes(series, firstRec * RECORD_PLAINTEXT, span(lastRec)[1]));
    const pt = await pool.decrypt(rec, p);
    const start = inst.offset - firstRec * RECORD_PLAINTEXT;
    const head = pt.subarray(start);
    const { ds } = parseDicomSync(head, { untilPixelData: true });
    const rows = ds.nums(T.Rows)[0], cols = ds.nums(T.Columns)[0];
    // Pixel Data (7FE0,0010), explicit VR OW: the value starts 12 bytes after the tag.
    let at = -1;
    for (let i = 132; i + 12 < head.length; i++) if (head[i] === 0xe0 && head[i + 1] === 0x7f && head[i + 2] === 0x10 && head[i + 3] === 0x00) {
      at = i;
      break;
    }
    const vr = at >= 0 ? String.fromCharCode(head[at + 4], head[at + 5]) : "";
    const px = at >= 0 ? { offset: at + (vr === "OW" || vr === "OB" ? 12 : 8) } : null;
    if (!px || !rows || !cols || ds.nums(T.BitsAllocated)[0] !== 16) throw new Error("this slice's pixels are not 16-bit native");
    geo = {
      rows,
      cols,
      p0: inst.offset + px.offset,
      center: ds.nums(T.WindowCenter)[0] ?? 500,
      width: ds.nums(T.WindowWidth)[0] ?? 1000,
      slope: ds.nums(T.RescaleSlope)[0] ?? 1,
      intercept: ds.nums(T.RescaleIntercept)[0] ?? 0,
      signed: ds.nums(T.PixelRepresentation)[0] === 1,
    };
    canvas.width = cols;
    canvas.height = rows;
    im = new ImageData(cols, rows);
    marks.replaceChildren(
      ...recs.map((r) => {
        const y = Math.max(0, (r * RECORD_PLAINTEXT - geo!.p0) / 2 / cols);
        return h("span", { style: `top:${(100 * y) / rows}%`, text: String(r) });
      }),
    );
  };

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    const btn = $<HTMLButtonElement>("refetch");
    btn.disabled = true;
    verdict.className = "verdict";
    verdict.textContent = "";
    const plan = planInstances(series, S.slice);
    const tamper = $<HTMLInputElement>("tamper").checked;
    try {
      if (!geo) await learn((await S.share!.resolver.fetchRange(plan)).slice(), plan.firstRecord);
      S.tamper.flipped = null;
      S.tamper.range = tamper ? plan.rangeHeader : null;
      const ct = await S.share!.resolver.fetchRange(plan);
      const flipped = S.tamper.flipped as { byte: number; bit: number } | null;
      const pieces = recs.map((r) => {
        const off = (r - plan.firstRecord) * RECORD_CIPHERTEXT;
        return { r, rec: ct.slice(off, off + recordLength(f, r)) };
      });
      // Locked: every band is ciphertext.
      for (const p of pieces) paint(p.r, p.rec, true);
      flush();
      list.replaceChildren(...pieces.map((p) => h("div", { text: `piece ${p.r}: nonce ${hex(recordNonce(p.r))}, tag ${hex(p.rec.subarray(p.rec.length - 16))}` })));
      await wait(700);
      // Unlock each piece in a worker, top to bottom.
      const pool = await S.pool!;
      let refused = -1;
      for (const p of pieces) {
        const params = await decryptParams(series, planBytes(series, p.r * RECORD_PLAINTEXT, span(p.r)[1]));
        try {
          const pt = await pool.decrypt(p.rec.slice(), params);
          paint(p.r, pt, false);
        } catch (e) {
          if ((e as Error)?.name !== "RecordAuthenticationError" && !(e instanceof RecordAuthenticationError)) throw e;
          refused = p.r;
          paint(p.r, p.rec, true, true);
        }
        flush();
        await wait(90);
      }
      if (refused >= 0) {
        verdict.className = "verdict bad";
        const where = flipped ? ` Bit ${flipped.bit} of byte ${n(flipped.byte % RECORD_CIPHERTEXT)} in it was flipped on the way.` : "";
        verdict.textContent = `Piece ${refused} was refused, so its rows stay blank.${where}`;
      } else {
        verdict.className = "verdict good";
        verdict.textContent = `All ${pieces.length} pieces unlocked, and every seal matched.`;
      }
    } catch (e) {
      verdict.className = "verdict bad";
      verdict.textContent = (e as Error).message;
    } finally {
      S.tamper.range = null;
      running = false;
      btn.disabled = false;
    }
  };
  $("refetch").addEventListener("click", () => void run());
  $("tamper").addEventListener("change", () => void run());
  let started = false;
  return {
    id: "unlock",
    el,
    enter: () => {
      if (!started) {
        started = true;
        void run();
      }
    },
  };
}
