// Step 1: the link, decoded, with a note for each field.
import { extractShlink, parseShlink, type ShlPayload } from "../core/index";
import { $, h, on, S } from "./state";

const FLAG_TEXT: Record<string, string> = {
  U: "U: <code>url</code> points straight at the one encrypted file, so the client fetches it with a plain GET. A U link cannot have a passcode.",
  L: "L: the link is long-lived and what it points to may change. Clients may check it again later.",
  P: "P: the server asks for a passcode before it says where the file is, and counts wrong attempts.",
};

function note(k: string, p: ShlPayload): string {
  switch (k) {
    case "url":
      return `<p><span class="note-k">url</span> is where the encrypted Bundle is.</p>
        <p>${(p.flag ?? "").includes("U") ? "With flag U, a GET of this address returns the file." : "Without flag U, the client POSTs to this address and gets back a manifest that says where the file is."} The series files sit next to it on the same host.</p>
        <p>The address alone gets only ciphertext.</p>`;
    case "key":
      return `<p><span class="note-k">key</span> is 32 random bytes, base64url-encoded. It decrypts the Bundle.</p>
        <p>The Bundle holds a separate key for each series file, so this one key opens everything the link shares. The host does not need it and never receives it.</p>`;
    case "flag": {
      const set = [...(p.flag ?? "")].filter((f) => FLAG_TEXT[f]);
      const unset = ["L", "P", "U"].filter((f) => !set.includes(f));
      return `<p><span class="note-k">flag</span> holds single-letter options.</p>
        ${set.map((f) => `<p>${FLAG_TEXT[f]}</p>`).join("")}
        ${unset.length ? `<p>Not set here: ${unset.join(", ")}.</p>` : ""}`;
    }
    case "label":
      return `<p><span class="note-k">label</span> is a short description for the recipient, shown before anything is fetched. Anyone who sees the link can read it.</p>`;
    case "exp":
      return `<p><span class="note-k">exp</span> is the expiry time, in seconds since 1970: ${new Date((p.exp as number) * 1000).toUTCString()}. A client makes no request after it. The server can also stop serving the link earlier.</p>`;
    case "v":
      return `<p><span class="note-k">v</span> is the version of the payload format.</p>`;
    default:
      return `<p><span class="note-k">${k}</span> is not a field this page knows. Clients ignore fields they do not understand.</p>`;
  }
}

function valueSpan(v: unknown): HTMLElement {
  if (typeof v === "string") return h("span", { class: "j-str", text: JSON.stringify(v) });
  if (typeof v === "number") return h("span", { class: "j-num", text: String(v) });
  return h("span", { class: "j-lit", text: JSON.stringify(v) });
}

function render(shlink: string, p: ShlPayload, initial = "key") {
  $("link-raw").textContent = shlink;
  const pre = $("link-json");
  pre.replaceChildren("{\n");
  const keys = Object.keys(p) as (keyof ShlPayload)[];
  const noteEl = $("link-note");
  const pick = (k: string) => {
    for (const b of pre.querySelectorAll<HTMLButtonElement>(".field-btn")) b.setAttribute("aria-pressed", String(b.dataset.k === k));
    noteEl.innerHTML = note(k, p);
    if (!p.exp && k === "url") noteEl.innerHTML += `<p>This link has no <code>exp</code>, so it carries no expiry date. The sharer can still revoke it on the server.</p>`;
  };
  keys.forEach((k, i) => {
    const btn = h(
      "button",
      { class: "field-btn", type: "button", "aria-pressed": "false", "data-k": k, onclick: () => pick(k) },
      h("span", { class: "j-key", text: JSON.stringify(k) }),
      ": ",
      valueSpan(p[k]),
    );
    pre.append("  ", btn, i < keys.length - 1 ? ",\n" : "\n");
  });
  pre.append("}");
  pick(keys.includes(initial as any) ? initial : keys[0]);
}

export function initLink() {
  on("ready", () => render(S.shlink, S.share!.resolver.payload));
  const input = $<HTMLInputElement>("link-input");
  const msg = $("link-input-msg");
  const decode = () => {
    msg.textContent = "";
    const link = extractShlink(input.value.trim());
    try {
      if (!link) throw new Error("no link");
      render(link, parseShlink(link));
    } catch {
      msg.textContent = "That doesn't contain a SMART Health Link (shlink:/…).";
    }
  };
  $("link-decode").addEventListener("click", decode);
  input.addEventListener("keydown", (e) => e.key === "Enter" && decode());
}
