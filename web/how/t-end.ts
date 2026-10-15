// The ending: open the full viewer on the same sample. With the details on: the reference
// receiver, the test vector and the decoder comparison, all run in a worker.
import { assetUrl, siteUrl, viewerUrl } from "../core/index";
import receiverSource from "./receiver.js" with { type: "text" };
import { $, h, mb, on, progressBar, S } from "./state";

let worker: Worker | null = null;
function ask(msg: any, onProgress?: (m: any) => void): Promise<any> {
  worker ??= new Worker(assetUrl("how-worker.js"), { type: "module" });
  const w = worker;
  return new Promise((resolve, reject) => {
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "progress") onProgress?.(m);
      else if (m.type === "done") resolve(m);
      else reject(new Error(m.message));
    };
    w.onerror = (e) => reject(new Error(e.message || "worker failed"));
    w.postMessage(msg);
  });
}

// One synthetic 512 × 512 test image, compressed three ways (web/how/data/LICENSES.txt).
const BENCH = [
  { file: "j2k.dcm", label: "JPEG 2000 Lossless", lib: "openjpeg" },
  { file: "htj2k.dcm", label: "HTJ2K Lossless", lib: "openjph" },
  { file: "jls.dcm", label: "JPEG-LS Lossless", lib: "charls" },
];

export function initEnd() {
  $("rx-code").textContent = receiverSource;
  on("ready", () => {
    $<HTMLAnchorElement>("open-viewer").href = viewerUrl(S.cfg!, S.shlink);
    $<HTMLButtonElement>("rx-run").disabled = false;
  });

  $("rx-run").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("rx-run");
    const out = $("rx-out");
    btn.disabled = true;
    out.classList.remove("hidden");
    out.textContent = "Running in a worker…";
    try {
      const m = await ask({ type: "receive", link: S.shlink });
      out.textContent = `// receive(sampleLink) returned in ${Math.round(m.ms)} ms\n${JSON.stringify(m.result, null, 2)}`;
    } catch (e) {
      out.textContent = `// receive(sampleLink) threw\n${(e as Error).message}`;
    } finally {
      btn.disabled = false;
    }
  });

  $("tv-run").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("tv-run");
    btn.disabled = true;
    try {
      const { rows } = await ask({ type: "testvector" });
      $("tv-out").replaceChildren(
        ...rows.flatMap((r: any) => [h("dt", { text: r.label }), h("dd", {}, h("span", { class: r.ok ? "good" : "bad", text: r.ok ? "✓ " : "✗ " }), r.value)]),
      );
    } catch (e) {
      $("tv-out").textContent = (e as Error).message;
    } finally {
      btn.disabled = false;
    }
  });

  $("bx-run").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("bx-run");
    btn.disabled = true;
    const bar = progressBar("Decodes");
    $("bx-progress").replaceChildren(bar.el);
    const runs = 5;
    bar.set(0, BENCH.length * 2 * (runs + 1));
    $("bx-out").replaceChildren();
    try {
      const { rows } = await ask({ type: "bench", base: siteUrl("how/bench/"), wasm: assetUrl("shl_dicom_decode.wasm"), cases: BENCH, runs }, (m) => bar.set(m.done, m.total));
      const t = h(
        "table",
        { class: "bx" },
        h("thead", {}, h("tr", {}, h("th", { text: "Image" }), h("th", { class: "n", text: "Ours" }), h("th", { class: "n", text: "C library" }), h("th", { text: "Same pixels" }))),
        h(
          "tbody",
          {},
          ...rows.map((r: any) =>
            h(
              "tr",
              {},
              h("td", {}, `${r.label}, ${r.columns} × ${r.rows}, ${mb(r.size)}`),
              h("td", { class: "n", text: `${r.ours.toFixed(0)} ms` }),
              h("td", { class: "n", text: `${r.c.toFixed(0)} ms (${r.lib})` }),
              h("td", { class: r.same ? "good" : "bad", text: r.same ? "yes" : "no" }),
            ),
          ),
        ),
      );
      $("bx-out").replaceChildren(
        t,
        h("p", { class: "small muted", text: `Median of ${runs} decodes each, after one warm-up. Ours is timed on the whole DICOM file (reading it and decoding); the C library on the compressed image alone. The test images are synthetic, made for the benchmark.` }),
      );
    } catch (e) {
      $("bx-out").replaceChildren(h("p", { class: "bad", text: (e as Error).message }));
    } finally {
      btn.disabled = false;
    }
  });
}
