// Step 1: the SMART Health Link. A QR code of the sample's viewer address, Copy and Open, and the
// decoded shlink:/ payload.
import qrcode from "qrcode-generator";
import { viewerUrl } from "../core/index";
import { code, excerpt, h, linkButtons, n, para, S } from "./state";

export function mountLink(pic: HTMLElement, exact: HTMLElement) {
  const p = S.share!.resolver.payload;
  const url = viewerUrl(S.cfg!, S.shlink);
  const qr = qrcode(0, "L");
  qr.addData(url);
  qr.make();
  const qrBox = h("div", { class: "qr", role: "img", "aria-label": "QR code of the sample link" });
  qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  pic.replaceChildren(
    h("div", { class: "qr-row" }, qrBox, linkButtons(url, "link")),
    h("p", { class: "cap", text: "The shlink:/ payload, decoded:" }),
    excerpt(JSON.stringify(p, null, 2), [/"url"/, /"key"/], "The shlink:/ payload, decoded"),
  );

  const enc = S.shlink.slice("shlink:/".length);
  exact.replaceChildren(
    para("The link itself, as shared:"),
    h("pre", { class: "code wrap", text: S.shlink }),
    para("After ", code("shlink:/"), ` come ${n(enc.length)} characters of base64url: the payload's JSON bytes, written with letters, digits, `, code("-"), " and ", code("_"), " so they survive in a URL."),
    h(
      "ul",
      {},
      h("li", {}, code("url"), ": where the JWE is. "),
      h("li", {}, code("key"), `: 32 random bytes, base64url-encoded (${p.key.length} characters). It decrypts the JWE, nothing else.`),
      h("li", {}, code("flag"), " ", code(String(p.flag ?? "")), ": ", (p.flag ?? "").includes("U") ? "U means the url is the JWE itself, fetched with one GET. (Without U, the client first POSTs to the url for a manifest, which can require a passcode.)" : "the link's options."),
      h("li", {}, code("label"), ": a name the recipient sees before opening it."),
    ),
    para("In a viewer address the link sits after ", code("#"), ". That part of an address, the fragment, stays in the browser and is never part of a request."),
  );
}
