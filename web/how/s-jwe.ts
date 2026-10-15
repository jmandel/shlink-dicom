// Step 2: the JWE the link's url points to: its header, and its size before and after decryption.
import { b64urlDecode, fromUtf8 } from "../core/index";
import { code, excerpt, h, mb, n, para, S } from "./state";

export function mountJwe(pic: HTMLElement, exact: HTMLElement) {
  const parts = S.jwe.split(".");
  let header = "{}";
  try {
    header = JSON.stringify(JSON.parse(fromUtf8(b64urlDecode(parts[0]))), null, 2);
  } catch {}
  const clip = (s: string) => (s.length > 18 ? `${s.slice(0, 14)}…` : s || "(empty)");
  pic.replaceChildren(
    h("p", { class: "cap", text: "The JWE header:" }),
    excerpt(header, [/"enc"/, /"zip"/], "The JWE header"),
    h("p", { class: "cap", text: "The JWE as fetched: five parts separated by dots." }),
    h("pre", { class: "code wrap", text: parts.map(clip).join(" . ") }),
    h(
      "dl",
      { class: "facts" },
      h("dt", { text: "Downloaded" }),
      h("dd", { text: `${mb(S.jwe.length)} (${n(S.jwe.length)} bytes)` }),
      h("dt", { text: "Decrypted" }),
      h("dd", { text: `${mb(S.share!.bundleBytes.length)} of JSON (${n(S.share!.bundleBytes.length)} bytes)` }),
    ),
  );
  const names = ["header", "encrypted key", "initialisation vector", "ciphertext", "authentication tag"];
  exact.replaceChildren(
    para("A compact JWE is five base64url parts:"),
    h("ul", {}, ...parts.map((p, i) => h("li", {}, `${names[i]}: ${n(p.length)} characters`, i === 1 ? " (empty: with “dir”, the link's key is used directly)" : ""))),
    para(code("alg: dir"), " uses the link's key directly. ", code("enc: A256GCM"), " is AES-256-GCM: the header is checked along with the ciphertext, and the 16-byte tag must match. ", code("zip: DEF"), " means the JSON was DEFLATE-compressed before encryption, which is why it shrinks so much."),
  );
}
