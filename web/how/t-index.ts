// Step 2: the index. The locked file unlocks, and the table of contents unfolds from the studies
// to the series to this slice.
import { formatPersonName, studyTitle, b64urlDecode, fromUtf8, EXT_SERIES_FILE } from "../core/index";
import type { Scene } from "./how";
import { $, fileOf, h, mb, n, S, wait } from "./state";

/** The slice's entries in the decrypted Bundle JSON (for the details layer). */
function sliceJson() {
  const b = S.share!.index.bundle;
  for (const e of b.entry ?? []) {
    const r = e.resource;
    if (r?.resourceType !== "ImagingStudy") continue;
    for (const se of r.series ?? []) {
      if (se.uid !== S.series!.uid) continue;
      const inst = se.instance?.[S.slice];
      const file = (se.extension ?? []).find((x: any) => x.url === EXT_SERIES_FILE || /file$/.test(x.url ?? ""));
      return { series: { uid: se.uid, description: se.description, extension: file ? [file] : undefined }, instance: inst };
    }
  }
  return null;
}

export function indexScene(): Scene {
  const idx = S.share!.index;
  const jweBytes = S.jwe.length;
  const locked = h("div", { class: "locked-file" }, h("span", { text: `Locked file · ${mb(jweBytes)}` }));
  const tree = h("ul", { class: "toc-tree", "aria-label": "Table of contents" });
  const items: HTMLElement[] = [];
  const item = (el: HTMLElement) => (el.classList.add("hidden-item"), items.push(el), el);
  tree.append(item(h("li", {}, h("strong", { text: formatPersonName(idx.patient.name) || "Patient" }), h("span", { class: "meta", text: idx.patient.birthDate ? ` · born ${idx.patient.birthDate.slice(0, 4)}` : "" }))));
  let thisLi: HTMLElement | null = null;
  for (const st of idx.studies) {
    const li = item(h("li", {}, h("strong", { text: studyTitle(st) }), h("span", { class: "meta", text: ` · ${st.modalities.join(", ")} · ${n(st.numberOfInstances)} images` })));
    tree.append(li);
    if (st !== S.study) continue;
    const ul = h("ul");
    li.append(ul);
    for (const se of st.series) {
      const sli = item(h("li", {}, se.description ?? se.modality ?? "Series", h("span", { class: "meta", text: ` · ${se.instances.length} images` })));
      ul.append(sli);
      if (se !== S.series) continue;
      const inst = se.instances[S.slice];
      thisLi = item(h("li", { class: "this" }, h("strong", { text: `Slice ${S.slice + 1} of ${se.instances.length}` }), h("span", { class: "meta", text: ` · ${n(inst.length)} bytes` })));
      sli.append(h("ul", {}, thisLi));
    }
  }
  // Details: the JWE header and the slice's own entries.
  const hdr = (() => {
    try {
      return JSON.stringify(JSON.parse(fromUtf8(b64urlDecode(S.jwe.split(".")[0]))));
    } catch {
      return "";
    }
  })();
  const sj = sliceJson();
  const det = h("pre", { class: "json only-d", "aria-label": "The JWE header and this slice's entries" });
  det.textContent = `JWE header: ${hdr}\n\nThis slice in the ImagingStudy:\n${JSON.stringify(sj?.instance ?? null, null, 1)}`;

  const scroller = h("div", { class: "grow", style: "overflow:auto" }, tree);
  const el = h("section", { class: "scene", "data-scene": "index", "aria-label": "The index" }, h("p", { class: "scene-title", text: "The index" }), locked, scroller, det);
  const f = fileOf(S.series!);
  const inst = S.series!.instances[S.slice];
  $("d-index").textContent = `Here: ${n(jweBytes)} bytes locked, ${n(S.share!.bundleBytes.length)} bytes of JSON once unlocked. Our slice is ${n(inst.length)} bytes, starting at byte ${n(inst.offset)} of file ${f.fileId}.bin, which is ${n(f.plaintextLength)} bytes long.`;

  let played = false;
  const play = async () => {
    if (played) return;
    played = true;
    await wait(250);
    locked.classList.add("open");
    locked.firstElementChild!.textContent = `Unlocked · ${mb(S.share!.bundleBytes.length)} of JSON`;
    for (const it of items) {
      await wait(it.classList.contains("this") ? 300 : 60);
      it.classList.remove("hidden-item");
    }
    if (thisLi) scroller.scrollTop += thisLi.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientHeight / 2;
  };
  return { id: "index", el, enter: () => void play() };
}
