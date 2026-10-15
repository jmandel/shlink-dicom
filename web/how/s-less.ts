// Step 9: Range requests on demand. Scroll the MRI series; a counter shows what this page has
// fetched from the MRI's encrypted file against the file's size.
import { plural } from "../core/index";
import { ImageStore, Priority } from "../core/images";
import { showImage, Viewport } from "../core/render";
import { bytesFetched, code, h, mb, n, onRequest, para, reqRow, S } from "./state";

export function mountLess(pic: HTMLElement, exact: HTMLElement) {
  const series = S.series!;
  const f = series.file;
  const counter = h("p", { class: "counter", "aria-live": "polite" });
  const bar = h("div", { class: "cbar", "aria-hidden": "true" }, h("i"));
  const stage = h("div", { class: "stage", "aria-label": `The ${series.description} series. Use the slider to move through it.` });
  const slider = h("input", { id: "less-slider", type: "range", min: "0", max: String(series.instances.length - 1), value: String(S.slice), "aria-label": "Slice" }) as HTMLInputElement;
  const sliceLabel = h("span", { class: "small muted" });
  pic.replaceChildren(counter, bar, stage, h("div", { class: "scrub" }, slider, sliceLabel));

  const update = () => {
    const got = bytesFetched(f.fileId);
    counter.replaceChildren(h("b", { text: mb(got) }), ` fetched of the ${S.study!.description ?? "MRI"} study's ${mb(f.ciphertextLength)} encrypted file.`);
    (bar.firstElementChild as HTMLElement).style.width = `${Math.min(100, (100 * got) / f.ciphertextLength)}%`;
  };
  const reqs = h("div", { class: "reqs" });
  const note = h("p");
  exact.replaceChildren(
    para("Each slice is one instance. Showing it takes one Range request for its records, about ", mb(series.instances[S.slice].length), " here; the rest of the file is never fetched. A slice seen before comes from memory, with no new request."),
    note,
    para("Range requests for this file, newest first:"),
    reqs,
  );
  const add = (r: any) => {
    if (r.purpose !== "file" || !r.url.includes(`/${f.fileId}.bin`)) return;
    reqs.prepend(reqRow(r));
    update();
  };
  for (const r of S.requests) add(r);
  onRequest(add);

  let vp: Viewport | null = null;
  let store: ImageStore | null = null;
  const shownSet = new Set<number>();
  const show = async (i: number) => {
    sliceLabel.textContent = `${i + 1} of ${series.instances.length}`;
    const pool = await S.pool!;
    store ??= new ImageStore(S.share!.loader, pool);
    vp ??= new Viewport(stage);
    const img = await store.get(series, i, { priority: Priority.Visible });
    if (Number(slider.value) !== i) return;
    showImage(vp, img);
    shownSet.add(i);
    const count = S.requests.filter((r) => r.purpose === "file" && r.url.includes(`/${f.fileId}.bin`)).length;
    note.replaceChildren(`${plural(shownSet.size, "slice")} shown here so far, from ${plural(count, "Range request")} for this file in all (`, code(`${f.fileId}.bin`), `, ${n(f.ciphertextLength)} bytes).`);
    update();
  };
  slider.addEventListener("input", () => void show(Number(slider.value)));
  update();
  void show(S.slice);
}
