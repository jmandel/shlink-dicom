// Step 1: the link. A QR code of the sample's viewer address, the link as a card, and (details)
// the decoded payload.
import qrcode from "qrcode-generator";
import { viewerUrl } from "../core/index";
import type { Scene } from "./how";
import { h, S } from "./state";

function jsonView(obj: Record<string, unknown>): HTMLElement {
  const pre = h("pre", { class: "json only-d", "aria-label": "The link, decoded" });
  pre.append("{\n");
  const keys = Object.keys(obj);
  keys.forEach((k, i) => {
    const v = obj[k];
    pre.append("  ", h("span", { class: "j-key", text: JSON.stringify(k) }), ": ", h("span", { class: typeof v === "number" ? "j-num" : "j-str", text: JSON.stringify(v) }), i < keys.length - 1 ? ",\n" : "\n");
  });
  pre.append("}");
  return pre;
}

export function linkScene(): Scene {
  const p = S.share!.resolver.payload;
  const url = viewerUrl(S.cfg!, S.shlink);
  const qr = qrcode(0, "L");
  qr.addData(url);
  qr.make();
  const qrBox = h("div", { class: "qr", role: "img", "aria-label": "QR code of the sample link" });
  qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  const card = h(
    "dl",
    { class: "linkcard" },
    h("dt", { text: "Label" }),
    h("dd", { text: p.label ?? "(none)" }),
    h("dt", { text: "Where" }),
    h("dd", { text: new URL(p.url).host }),
    h("dt", { text: "Key" }),
    h("dd", {}, h("span", { class: "lock", text: `${p.key.length} characters` }), " that stay in your browser"),
  );
  const el = h("section", { class: "scene", "data-scene": "link", "aria-label": "The link" }, h("p", { class: "scene-title", text: "The sample link" }), qrBox, card, jsonView(p as any));
  return { id: "link", el };
}
