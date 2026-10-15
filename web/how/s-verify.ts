// Step 4: decrypt and verify one record; the tamper switch flips one bit of the response before
// the decryptor sees it, and the record is refused.
import { planBytes, RECORD_PLAINTEXT, recordNonce, RecordAuthenticationError, TAG } from "../core/index";
import { $, currentSeries, facts, h, hex, n, on, S, storePlain } from "./state";
import { markRecords } from "./s-series";

let rec = 0;
let shownFile = "";
let busy = false;

function plan() {
  const { series } = currentSeries();
  return planBytes(series, rec * RECORD_PLAINTEXT, Math.min(series.plaintextLength, (rec + 1) * RECORD_PLAINTEXT));
}

function render() {
  const { series } = currentSeries();
  const slider = $<HTMLInputElement>("vf-slider");
  slider.max = String(series.recordCount - 1);
  slider.value = String(rec);
  slider.setAttribute("aria-valuetext", `Record ${rec} of ${series.recordCount}`);
  $("vf-series").textContent = `Series ${series.number ?? ""} “${series.description ?? series.modality ?? ""}”: ${series.fileId}.bin, ${series.recordCount} records. Follows the series chosen in step 3.`;
  $("vf-run").textContent = `Fetch and decrypt record ${rec}`;
  const p = plan();
  facts($("vf-facts"), [
    ["Record", `${rec} (the file has ${series.recordCount}, numbered 0–${series.recordCount - 1})`],
    ["Ciphertext bytes", `${n(p.ciphertextStart)} to ${n(p.ciphertextEnd - 1)} (${n(p.ciphertextEnd - p.ciphertextStart)} bytes, the last ${TAG} are the tag)`],
    ["Nonce", hex(recordNonce(rec)), "mono"],
    ["Series key", `${series.key.slice(0, 10)}… (from the Bundle)`, "mono"],
  ]);
}

function hexdump(bytes: Uint8Array, start: number, base: number, lines = 6): string {
  const out: string[] = [];
  for (let l = 0; l < lines; l++) {
    const o = start + l * 16;
    if (o >= bytes.length) break;
    const row = bytes.subarray(o, Math.min(bytes.length, o + 16));
    const hx = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
    const asc = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "·")).join("");
    out.push(`${(base + o).toString().padStart(9, " ")}  ${hx}  ${asc}`);
  }
  return out.join("\n");
}

async function run() {
  if (busy) return;
  busy = true;
  const btn = $<HTMLButtonElement>("vf-run");
  btn.disabled = true;
  const sh = S.share!;
  const { series } = currentSeries();
  const p = plan();
  const tamper = $<HTMLInputElement>("vf-tamper").checked;
  const out = $("vf-result");
  out.replaceChildren(h("p", { class: "small muted", text: "Fetching…" }));
  S.tamper.flipped = null;
  S.tamper.range = tamper ? p.rangeHeader : null;
  markRecords(series.fileId, rec, rec, "fetch");
  try {
    const ct = await sh.resolver.fetchRange(p);
    const tag = ct.subarray(ct.length - TAG);
    const flipped = S.tamper.flipped as null | { byte: number; bit: number; before: number; after: number };
    try {
      const pt = await sh.decryptor.decrypt(series, p, ct);
      markRecords(series.fileId, rec, rec, "ok");
      storePlain(series, p.plaintextStart, pt);
      const start = rec === 0 ? 128 : 0;
      out.replaceChildren(
        h("div", { class: "verdict good" }, h("div", {}, h("p", { text: `Verified. Record ${rec} decrypted to ${n(pt.length)} bytes of DICOM.` }), h("p", { class: "sub", text: `Tag ${hex(tag)} matched.` }))),
        h("pre", { class: "hexdump", "aria-label": "Start of the plaintext", text: hexdump(pt, start, rec * RECORD_PLAINTEXT) }),
        h("p", { class: "small muted", text: rec === 0 ? "Plaintext from byte 128 of the series: DICM, then the first file's meta header." : "The first plaintext bytes of this record, with their offsets in the series." }),
      );
    } catch (e) {
      if (!(e instanceof RecordAuthenticationError)) throw e;
      markRecords(series.fileId, rec, rec, "bad");
      const where = flipped ? (flipped.byte >= ct.length - TAG ? "in the tag" : "in the ciphertext") : "";
      out.replaceChildren(
        h(
          "div",
          { class: "verdict bad" },
          h(
            "div",
            {},
            h("p", { text: `Refused. Record ${rec} failed its integrity check, and none of its bytes were used.` }),
            flipped
              ? h("p", { class: "sub", text: `Bit ${flipped.bit} of byte ${n(flipped.byte)} of the record was flipped on arrival (${flipped.before.toString(16).padStart(2, "0")} → ${flipped.after.toString(16).padStart(2, "0")}), ${where}.` })
              : null,
          ),
        ),
      );
    }
  } catch (e) {
    markRecords(series.fileId, rec, rec, "bad");
    out.replaceChildren(h("div", { class: "verdict bad" }, h("p", { text: String((e as Error).message ?? e) })));
  } finally {
    S.tamper.range = null;
    busy = false;
    btn.disabled = false;
  }
}

export function initVerify() {
  const slider = $<HTMLInputElement>("vf-slider");
  slider.addEventListener("input", () => {
    rec = Number(slider.value);
    render();
  });
  const step = (d: number) => {
    const { series } = currentSeries();
    rec = Math.max(0, Math.min(series.recordCount - 1, rec + d));
    render();
  };
  $("vf-prev").addEventListener("click", () => step(-1));
  $("vf-next").addEventListener("click", () => step(1));
  $("vf-run").addEventListener("click", run);
  on("ready", () => {
    render();
    run();
  });
  on("select", () => {
    const { series } = currentSeries();
    const inst = series.instances[S.sel.instance];
    if (shownFile !== series.fileId || !busy) rec = inst.firstRecord;
    shownFile = series.fileId;
    render();
  });
}
