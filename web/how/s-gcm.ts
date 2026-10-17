// Step 7: the AES-256-GCM tag. The slice's records are drawn as their ciphertext (one byte per
// pixel, so they look like noise). Each record is then checked and decrypted in a worker and marked
// as passed or refused; the slice is decoded only when every record passes. The tamper switch flips
// one bit of the response on arrival: that record is refused, and the image is not shown, because a
// receiver uses no bytes from a refused record. This holds whatever the Pixel Data's encoding.
import { decryptParams, planBytes, planInstances, RECORD_CIPHERTEXT, RECORD_PLAINTEXT, recordCiphertextLength, recordNonce, RecordAuthenticationError } from "../core/index";
import { drawThumbnail } from "../core/render";
import { code, h, hex, n, para, S, wait } from "./state";

const isAuthError = (e: unknown) => e instanceof RecordAuthenticationError || (e as Error)?.name === "RecordAuthenticationError";

/** A record's bytes drawn as grey levels, 128 × 128 (every fourth byte). */
function drawNoise(cv: HTMLCanvasElement, bytes: Uint8Array) {
  const ctx = cv.getContext("2d")!;
  const im = ctx.createImageData(128, 128);
  for (let i = 0; i < 128 * 128; i++) {
    const v = bytes[i * 4] ?? 0;
    im.data[4 * i] = im.data[4 * i + 1] = im.data[4 * i + 2] = v;
    im.data[4 * i + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
}

export function mountGcm(pic: HTMLElement, exact: HTMLElement) {
  const series = S.series!;
  const f = series.file;
  const inst = series.instances[S.slice];
  const recs: number[] = [];
  for (let r = inst.firstRecord; r <= inst.lastRecord; r++) recs.push(r);
  const tiles = recs.map((r) => {
    const cv = h("canvas", { width: 128, height: 128 });
    const mark = h("span", { class: "rec-mark" });
    const el = h("div", { class: "rec-tile" }, h("div", { class: "rec-img" }, cv, mark), h("span", { text: `record ${r}` }));
    return { r, cv, mark, el };
  });
  const image = h("canvas", { width: 512, height: 512, "aria-label": `Slice ${S.slice + 1}, decoded from its records` });
  const refusedNote = h("div", { class: "refused hidden" });
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
    h("p", { class: "cap", text: `The ${recs.length} records holding slice ${S.slice + 1}, as they arrive (encrypted, so they look like noise), each marked once its tag is checked:` }),
    h("div", { class: "rec-tiles" }, ...tiles.map((t) => t.el)),
    verdict,
    h("p", { class: "cap", text: "The slice, decoded only from records that passed:" }),
    h("div", { class: "slice-img" }, image, refusedNote),
  );
  const list = h("div", { class: "reqs" });
  exact.replaceChildren(
    para("Each record is encrypted on its own with AES-256-GCM, under the file's key from the ", code("linked-file"), " extension. The nonce (a number used once) is the record's number, written as 12 bytes. Decryption recomputes the 16-byte tag from the ciphertext and fails if it differs, and then it returns no bytes at all."),
    para("So a changed bit is caught, and so is a record moved to another place, because its nonce no longer matches. Each record can be checked as soon as it arrives, without the rest of the file."),
    para("A refused record leaves a gap in the file's bytes, and a viewer can't show an image with bytes missing, so the whole image is refused."),
    para("This slice's records, with their nonces and tags:"),
    list,
  );

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    again.disabled = true;
    verdict.className = "verdict";
    verdict.textContent = "";
    const plan = planInstances(series, S.slice);
    try {
      S.tamper.flipped = null;
      S.tamper.range = tamperBox.checked ? plan.rangeHeader : null;
      const ct = await S.share!.resolver.fetchRange(plan);
      const flipped = S.tamper.flipped as { byte: number; bit: number } | null;
      const records = tiles.map((t) => {
        const off = (t.r - plan.firstRecord) * RECORD_CIPHERTEXT;
        return { ...t, rec: ct.slice(off, off + recordCiphertextLength(f.plaintextLength, t.r)) };
      });
      for (const x of records) {
        x.el.className = "rec-tile";
        x.mark.textContent = "";
        drawNoise(x.cv, x.rec);
      }
      image.getContext("2d")!.clearRect(0, 0, image.width, image.height);
      refusedNote.classList.add("hidden");
      list.replaceChildren(...records.map((x) => h("div", { text: `record ${x.r}: nonce ${hex(recordNonce(x.r))}, tag ${hex(x.rec.subarray(x.rec.length - 16))}` })));
      await wait(500);
      // Check each record in a worker, one at a time, so the order is visible.
      const pool = await S.pool!;
      let refused = -1;
      for (const x of records) {
        const params = await decryptParams(series, planBytes(series, x.r * RECORD_PLAINTEXT, Math.min(f.plaintextLength, (x.r + 1) * RECORD_PLAINTEXT)));
        try {
          await pool.decrypt(x.rec.slice(), params);
          x.el.className = "rec-tile ok";
          x.mark.textContent = "✓";
        } catch (e) {
          if (!isAuthError(e)) throw e;
          refused = x.r;
          x.el.className = "rec-tile bad";
          x.mark.textContent = "✗";
        }
        await wait(80);
      }
      if (refused >= 0) {
        verdict.className = "verdict bad";
        const where = flipped ? ` Bit ${flipped.bit} of byte ${n(flipped.byte % RECORD_CIPHERTEXT)} in it was flipped on the way.` : "";
        verdict.textContent = `Record ${refused} failed its tag check.${where}`;
        refusedNote.textContent = `Not shown: record ${refused} was refused, so the image's bytes are incomplete.`;
        refusedNote.classList.remove("hidden");
      } else {
        verdict.className = "verdict good";
        verdict.textContent = `All ${records.length} records passed their tag check and decrypted.`;
        // Decrypt and decode the slice in one worker job, from the same ciphertext.
        const img = await pool.decode(ct.slice(), { encrypted: await decryptParams(series, plan), priority: 0, header: true });
        drawThumbnail(image, img);
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
