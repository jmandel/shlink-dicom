// PDF pages drawn with pdf.js (loaded on first use from assets/pdfjs/), so PDFs show the same way
// on phones, where browsers do not display PDFs inline, and on desktop.
import { assetUrl } from "../core/config";

let lib: Promise<any> | null = null;

function pdfjs(): Promise<any> {
  lib ??= import(assetUrl("pdfjs/pdf.min.mjs")).then((m) => {
    m.GlobalWorkerOptions.workerSrc = assetUrl("pdfjs/pdf.worker.min.mjs");
    return m;
  });
  return lib;
}

/**
 * Renders every page of a PDF into `container`, fitted to its width (re-rendered when the width
 * changes). Returns the page count. The bytes are copied; the caller keeps its buffer.
 */
export async function renderPdf(container: HTMLElement, bytes: Uint8Array, signal?: AbortSignal): Promise<number> {
  const m = await pdfjs();
  const doc = await m.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  container.textContent = "";
  container.classList.add("pdf-pages");
  const pages: { canvas: HTMLCanvasElement; page: any }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-page";
    canvas.setAttribute("aria-label", `Page ${i} of ${doc.numPages}`);
    container.append(canvas);
    pages.push({ canvas, page });
  }
  let lastWidth = 0;
  const draw = async () => {
    const width = Math.max(200, container.clientWidth);
    if (Math.abs(width - lastWidth) < 8) return;
    lastWidth = width;
    const dpr = Math.min(2, devicePixelRatio || 1);
    for (const { canvas, page } of pages) {
      if (signal?.aborted) return;
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (width / base.width) * dpr });
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      canvas.style.width = `${width}px`;
      await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
    }
    container.dataset.rendered = String(pages.length);
  };
  await draw();
  const ro = new ResizeObserver(() => void draw());
  ro.observe(container);
  signal?.addEventListener("abort", () => ro.disconnect(), { once: true });
  return doc.numPages;
}
