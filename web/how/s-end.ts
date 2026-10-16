// The ending: open the full viewer on the same sample. "Build your own": the reference receiver,
// the test vector and the decoder comparison, all run in a worker.
import { assetUrl, siteUrl, viewerUrl } from "../core/index";
import receiverSource from "./receiver.js" with { type: "text" };
import { $, code, h, mb, para, progressBar, S } from "./state";

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

export function mountEnd(_pic: HTMLElement, exact: HTMLElement) {
  $<HTMLAnchorElement>("open-viewer").href = viewerUrl(S.cfg!, S.shlink);

  const rxRun = h("button", { id: "rx-run", class: "btn btn-primary", type: "button", text: "Run it on the sample" }) as HTMLButtonElement;
  const rxOut = h("pre", { id: "rx-out", class: "code hidden", "aria-live": "polite" });
  rxRun.addEventListener("click", async () => {
    rxRun.disabled = true;
    rxOut.classList.remove("hidden");
    rxOut.textContent = "Running in a worker…";
    try {
      const m = await ask({ type: "receive", link: S.shlink });
      rxOut.textContent = `// receive(sampleLink) returned in ${Math.round(m.ms)} ms\n${JSON.stringify(m.result, null, 2)}`;
    } catch (e) {
      rxOut.textContent = `// receive(sampleLink) threw\n${(e as Error).message}`;
    } finally {
      rxRun.disabled = false;
    }
  });

  const tvRun = h("button", { id: "tv-run", class: "btn", type: "button", text: "Check the test vector here" }) as HTMLButtonElement;
  const tvOut = h("dl", { id: "tv-out", class: "facts" });
  tvRun.addEventListener("click", async () => {
    tvRun.disabled = true;
    try {
      const { rows } = await ask({ type: "testvector" });
      tvOut.replaceChildren(...rows.flatMap((r: any) => [h("dt", { text: r.label }), h("dd", {}, h("span", { class: r.ok ? "good" : "bad", text: r.ok ? "✓ " : "✗ " }), r.value)]));
    } catch (e) {
      tvOut.textContent = (e as Error).message;
    } finally {
      tvRun.disabled = false;
    }
  });

  const bxRun = h("button", { id: "bx-run", class: "btn", type: "button", text: "Run the comparison" }) as HTMLButtonElement;
  const bxProgress = h("div", { id: "bx-progress" });
  const bxOut = h("div", { id: "bx-out" });
  bxRun.addEventListener("click", async () => {
    bxRun.disabled = true;
    const runs = 5;
    const bar = progressBar("Decodes");
    bxProgress.replaceChildren(bar.el);
    bar.set(0, BENCH.length * 2 * (runs + 1));
    bxOut.replaceChildren();
    try {
      const { rows } = await ask({ type: "bench", base: siteUrl("how/bench/"), wasm: assetUrl("shl_dicom_decode.wasm"), cases: BENCH, runs }, (m) => bar.set(m.done, m.total));
      bxOut.replaceChildren(
        h(
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
        ),
        h("p", { class: "cap", text: `Median of ${runs} decodes each, after one warm-up. Ours is timed on the whole DICOM file (reading it and decoding); the C library on the compressed image alone. The test images are synthetic, made for the benchmark.` }),
      );
    } catch (e) {
      bxOut.replaceChildren(h("p", { class: "bad", text: (e as Error).message }));
    } finally {
      bxRun.disabled = false;
    }
  });

  exact.replaceChildren(
    para("This receiver resolves the sample link with only ", code("fetch"), " and WebCrypto, reads the first instance of a series with one Range request, and checks every record's tag. It runs here in a worker; the same file runs in Node 24 and Bun."),
    h("pre", { id: "rx-code", class: "code", tabindex: "0", text: receiverSource }),
    h("div", { class: "row wrap" }, rxRun, h("a", { class: "btn", href: "../how/receiver.mjs", download: "receiver.mjs", text: "Download" })),
    rxOut,
    para("The protocol: ", h("a", { href: "https://github.com/jmandel/shlink-dicom/blob/main/spec/README.md", text: "the specification" }), ", with a ", h("a", { href: "https://github.com/jmandel/shlink-dicom/blob/main/spec/README.md#appendix-b-test-vector", text: "test vector" }), " for the record format."),
    tvRun,
    tvOut,
    h("h3", { text: "Decoder speed" }),
    para("Our decoders against the C libraries a browser viewer would otherwise use (OpenJPEG, OpenJPH and CharLS, compiled to WebAssembly), on the same files, in a worker on this device."),
    bxRun,
    bxProgress,
    bxOut,
    h("p", { class: "cap" }, "How we check that the decoders are right: ", h("a", { href: "https://github.com/jmandel/shlink-dicom/tree/main/codec-corpus", text: "the codec corpus" }), " and ", h("a", { href: "https://github.com/jmandel/shlink-dicom/tree/main/codecs/bench", text: "the benchmarks" }), "."),
  );
}
