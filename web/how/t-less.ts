// Step 6: fetching less. Scroll through the MRI series, or zoom the slide; a counter shows what
// this page has downloaded against everything the link shares.
import { plural, RECORD_PLAINTEXT } from "../core/index";
import { ImageStore, Priority, type DecodedImage } from "../core/images";
import { Viewport } from "../core/render";
import { autoWindow } from "../core/wl";
import { isSlideSeries, levelForScale, type Pyramid } from "../core/wsi";
import { SlideSource } from "../core/wsi-source";
import type { Scene } from "./how";
import { $, bytesFetched, fileOf, h, mb, n, on, S, type Req } from "./state";
import { reqRow } from "./t-pieces";

/** Total ciphertext of every file the link shares. */
function sharedBytes(): number {
  const seen = new Map<string, number>();
  for (const st of S.share!.index.studies) for (const se of st.series) {
    const f = fileOf(se);
    seen.set(f.fileId, f.ciphertextLength);
  }
  return [...seen.values()].reduce((a, b) => a + b, 0);
}

/** A small deep-zoom view of a slide: the coarsest level first, then the tiles on screen. */
class SlideView {
  readonly canvas = h("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private bitmaps = new Map<string, ImageBitmap>();
  private inflight = new Set<string>();
  private pyr: Pyramid;
  /** Canvas pixels per base pixel, and the base-pixel point at the centre. */
  scale = 1;
  cx = 0;
  cy = 0;
  minScale = 1;
  onTile: (() => void) | null = null;

  constructor(
    readonly src: SlideSource,
    readonly box: HTMLElement,
  ) {
    this.pyr = src.pyramid;
    box.append(this.canvas);
    new ResizeObserver(() => this.fit(false)).observe(box);
    this.fit(true);
  }

  private fit(reset: boolean) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(this.box.clientWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(this.box.clientHeight * dpr));
    this.minScale = Math.min(this.canvas.width / this.pyr.width, this.canvas.height / this.pyr.height);
    if (reset) {
      this.scale = this.minScale;
      this.cx = this.pyr.width / 2;
      this.cy = this.pyr.height / 2;
    }
    this.draw();
  }

  zoom(k: number) {
    this.scale = Math.max(this.minScale, Math.min(2, this.scale * k));
    this.draw();
  }
  pan(dx: number, dy: number) {
    this.cx -= dx / this.scale;
    this.cy -= dy / this.scale;
    this.cx = Math.max(0, Math.min(this.pyr.width, this.cx));
    this.cy = Math.max(0, Math.min(this.pyr.height, this.cy));
    this.draw();
  }

  private tile(L: number, tx: number, ty: number): ImageBitmap | null {
    const key = `${L}/${tx}/${ty}`;
    const b = this.bitmaps.get(key);
    if (b) return b;
    if (this.inflight.has(key) || this.inflight.size >= 8) return null;
    this.inflight.add(key);
    (async () => {
      const file = await this.src.tileFile(L, tx, ty, 0, 0, { priority: 0 });
      if (!file) return;
      const pool = await S.pool!;
      const img = await pool.decode(file, { priority: Priority.Visible });
      const bm = await toBitmap(img);
      this.bitmaps.set(key, bm);
    })()
      .catch(() => {})
      .finally(() => {
        this.inflight.delete(key);
        this.draw();
        this.onTile?.();
      });
    return null;
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.fillStyle = "#f4f2f0";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const x0 = this.cx - canvas.width / 2 / this.scale, y0 = this.cy - canvas.height / 2 / this.scale;
    const coarsest = this.pyr.levels.length - 1;
    const want = levelForScale(this.pyr, this.scale / 1.2);
    for (const L of want === coarsest ? [coarsest] : [coarsest, want]) {
      const lv = this.pyr.levels[L];
      const ds = lv.downsample;
      const tw = lv.tileWidth * ds, th = lv.tileHeight * ds;
      const tx0 = Math.max(0, Math.floor(x0 / tw)), ty0 = Math.max(0, Math.floor(y0 / th));
      const tx1 = Math.min(lv.tilesAcross - 1, Math.floor((x0 + canvas.width / this.scale) / tw));
      const ty1 = Math.min(lv.tilesDown - 1, Math.floor((y0 + canvas.height / this.scale) / th));
      for (let ty = ty0; ty <= ty1; ty++)
        for (let tx = tx0; tx <= tx1; tx++) {
          const bm = this.tile(L, tx, ty);
          if (bm) ctx.drawImage(bm, (tx * tw - x0) * this.scale, (ty * th - y0) * this.scale, bm.width * ds * this.scale, bm.height * ds * this.scale);
        }
    }
  }
}

async function toBitmap(img: DecodedImage): Promise<ImageBitmap> {
  const px = new Uint8Array(img.pixels, img.frameOffsets[0], img.frameBytes);
  const rgba = new Uint8ClampedArray(img.rows * img.columns * 4);
  if (img.samplesPerPixel === 3) {
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) (rgba[i] = px[j]), (rgba[i + 1] = px[j + 1]), (rgba[i + 2] = px[j + 2]), (rgba[i + 3] = 255);
  } else {
    for (let i = 0, j = 0; i < rgba.length; i += 4, j++) (rgba[i] = rgba[i + 1] = rgba[i + 2] = px[j]), (rgba[i + 3] = 255);
  }
  return createImageBitmap(new ImageData(rgba, img.columns, img.rows));
}

export function lessScene(): Scene {
  const series = S.series!;
  const total = sharedBytes();
  const counter = h("p", { class: "counter", "aria-live": "polite", style: "margin:0" });
  const cbar = h("div", { class: "cbar", "aria-hidden": "true" }, h("i"));
  const stage = h("div", { class: "stage grow", "aria-label": "The MRI series. Use the slider to scroll." });
  const slider = h("input", { type: "range", min: "0", max: String(series.instances.length - 1), value: String(S.slice), "aria-label": "Slice" }) as HTMLInputElement;
  const sliceLabel = h("span", { class: "small muted" });
  const scrub = h("div", { class: "scrub" }, slider, sliceLabel);
  const slideBox = h("div", { class: "stage grow hidden", style: "background:#f4f2f0", "aria-label": "The slide. Drag to move; use the buttons to zoom." });
  const el = h("section", { class: "scene", "data-scene": "less", "aria-label": "Fetching less" }, h("p", { class: "scene-title", text: "Downloaded so far" }), counter, cbar, stage, scrub, slideBox);

  let mode: "mri" | "slide" = "mri";
  let slide: { src: SlideSource; view: SlideView } | null = null;
  const slideSeries = S.share!.index.studies.flatMap((s) => s.series).find(isSlideSeries) ?? null;
  if (!slideSeries) $("less-slide").classList.add("hidden");

  const update = () => {
    if (mode === "mri") {
      const got = bytesFetched();
      counter.innerHTML = "";
      counter.append(h("b", { text: mb(got) }), ` of ${mb(total)} shared, for everything this page has shown.`);
      (cbar.firstElementChild as HTMLElement).style.width = `${(100 * got) / total}%`;
    } else if (slide) {
      const got = slide.src.reader.stats.bytes;
      const size = fileOf(slideSeries!).ciphertextLength;
      counter.innerHTML = "";
      counter.append(h("b", { text: mb(got) }), ` of the slide's ${mb(size)}.`);
      (cbar.firstElementChild as HTMLElement).style.width = `${(100 * got) / size}%`;
      const st = slide.src.reader.stats;
      $("d-less").textContent = `The slide is a pyramid of ${slide.src.pyramid.levels.length} levels, each cut into tiles. Each tile's place in the file comes from the offset table at the start of its image, so one request fetches one tile's pieces. So far: ${n(st.requests)} requests, ${n(st.bytes)} bytes; ${n(st.cachedRecords)} pieces are kept and reused.`;
    }
  };

  // MRI: one image per position, through the shared loader (fetch) and the decoder workers.
  let vp: Viewport | null = null;
  let store: ImageStore | null = null;
  let shown = 0;
  const showSlice = async (i: number) => {
    sliceLabel.textContent = `${i + 1} of ${series.instances.length}`;
    const pool = await S.pool!;
    store ??= new ImageStore(S.share!.loader, pool);
    vp ??= new Viewport(stage);
    const img = await store.get(series, i, { priority: Priority.Visible });
    if (Number(slider.value) !== i) return;
    const w = autoWindow(img);
    vp.show(img, 0, { windowCenter: w.center, windowWidth: w.width });
    shown++;
    const reqs = S.requests.filter((r) => r.purpose === "series").length;
    const pieces = series.instances[i].lastRecord - series.instances[i].firstRecord + 1;
    $("d-less").textContent = `Each slice is about ${mb(series.instances[i].length)}, in ${pieces} pieces of ${n(RECORD_PLAINTEXT)} bytes. ${plural(shown, "slice")} shown here so far; a slice seen before comes from memory, with no new request. This page has made ${plural(reqs, "request")} for pieces.`;
    update();
  };
  slider.addEventListener("input", () => void showSlice(Number(slider.value)));

  // Slide: open on first use (reads each image's header).
  const openSlide = async () => {
    if (slide || !slideSeries) return;
    counter.textContent = "Reading the slide's headers…";
    const src = await SlideSource.open({ resolver: S.share!.resolver, decryptor: S.share!.decryptor, index: S.share!.index }, slideSeries);
    const view = new SlideView(src, slideBox);
    view.onTile = update;
    slide = { src, view };
    const zoom = h(
      "div",
      { class: "zoom-btns" },
      h("button", { class: "btn", type: "button", "aria-label": "Zoom in", text: "+", onclick: () => view.zoom(2) }),
      h("button", { class: "btn", type: "button", "aria-label": "Zoom out", text: "−", onclick: () => view.zoom(0.5) }),
    );
    slideBox.append(zoom, h("span", { class: "hint", text: "Drag to move" }));
    let last: { x: number; y: number } | null = null;
    slideBox.style.touchAction = "none";
    view.canvas.addEventListener("pointerdown", (e) => {
      view.canvas.setPointerCapture(e.pointerId);
      last = { x: e.clientX, y: e.clientY };
    });
    view.canvas.addEventListener("pointermove", (e) => {
      if (!last) return;
      const k = view.canvas.width / view.canvas.clientWidth;
      view.pan((e.clientX - last.x) * k, (e.clientY - last.y) * k);
      last = { x: e.clientX, y: e.clientY };
    });
    view.canvas.addEventListener("pointerup", () => (last = null));
    view.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      view.zoom(e.deltaY < 0 ? 1.25 : 0.8);
    }, { passive: false });
    update();
  };

  const setMode = (m: "mri" | "slide") => {
    mode = m;
    $("less-mri").setAttribute("aria-pressed", String(m === "mri"));
    $("less-slide").setAttribute("aria-pressed", String(m === "slide"));
    stage.classList.toggle("hidden", m !== "mri");
    scrub.classList.toggle("hidden", m !== "mri");
    slideBox.classList.toggle("hidden", m !== "slide");
    if (m === "slide") openSlide().catch((e) => (counter.textContent = (e as Error).message));
    update();
  };
  $("less-mri").addEventListener("click", () => setMode("mri"));
  $("less-slide").addEventListener("click", () => setMode("slide"));

  const reqs = $("d-less-reqs");
  on("request", (r: Req) => {
    if (el.classList.contains("on")) {
      reqs.prepend(reqRow(r));
      while (reqs.children.length > 12) reqs.lastElementChild!.remove();
      update();
    }
  });

  let started = false;
  return {
    id: "less",
    el,
    enter: () => {
      update();
      if (!started) {
        started = true;
        void showSlice(S.slice);
      }
    },
  };
}
