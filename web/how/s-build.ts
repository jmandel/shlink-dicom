// Step 8: the 50-line receiver (shown and run as is) and the appendix B test vector, checked with
// WebCrypto in this page.
import { b64urlDecode } from "../core/index";
import receiverSource from "./receiver.js" with { type: "text" };
import { $, facts, h, hex, n, on, S } from "./state";

// PROPOSAL.md appendix B.
const TV = {
  key: "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
  plaintextSha256: "02675bf9284bd74223e98ceea96ebee4c9a469272ead358f462d89753f8c909b",
  ciphertextLength: 150048,
  ciphertextSha256: "f3205658d3fee29b343d3ba3ef20f52b3e66c2cb05974a93b65504866665fc4e",
  tags: ["9a8421bd6740aeac5eb211cf59511b2f", "4cd810f700957e87ae68edc29e40caf9", "cf980ddc661684644fa17e5b00b08819"],
};

async function runReceiver() {
  const btn = $<HTMLButtonElement>("rx-run");
  const out = $("rx-out");
  btn.disabled = true;
  out.classList.remove("hidden");
  out.textContent = "Running…";
  const url = URL.createObjectURL(new Blob([receiverSource], { type: "text/javascript" }));
  try {
    const mod = await import(/* @vite-ignore */ url);
    const t0 = performance.now();
    const result = await mod.receive(S.shlink);
    out.textContent = `// receive(sampleLink) returned in ${Math.round(performance.now() - t0)} ms\n${JSON.stringify(result, null, 2)}`;
  } catch (e) {
    out.textContent = `// receive(sampleLink) threw\n${(e as Error).message}`;
  } finally {
    URL.revokeObjectURL(url);
    btn.disabled = false;
  }
}

async function sha256(b: Uint8Array) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource)));
}

async function runTestVector() {
  const btn = $<HTMLButtonElement>("tv-run");
  btn.disabled = true;
  const R = 65520;
  const pt = Uint8Array.from({ length: 150000 }, (_, k) => k % 251);
  const key = await crypto.subtle.importKey("raw", b64urlDecode(TV.key), "AES-GCM", false, ["encrypt", "decrypt"]);
  const nonce = (i: number) => {
    const b = new Uint8Array(12);
    new DataView(b.buffer).setUint32(8, i);
    return b;
  };
  const recs: Uint8Array[] = [];
  for (let i = 0; i * R < pt.length; i++) {
    recs.push(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(i) }, key, pt.subarray(i * R, Math.min(pt.length, (i + 1) * R)))));
  }
  const ct = new Uint8Array(recs.reduce((a, r) => a + r.length, 0));
  recs.reduce((o, r) => (ct.set(r, o), o + r.length), 0);
  const tags = recs.map((r) => hex(r.subarray(r.length - 16)));

  // Instance 2 (bytes 70,000–149,999) from records 1–2 only.
  let rangeOk = false;
  try {
    const parts = await Promise.all([1, 2].map((i) => crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(i) }, key, ct.subarray(i * 65536, Math.min(ct.length, (i + 1) * 65536)))));
    const joined = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
    parts.reduce((o, p) => (joined.set(new Uint8Array(p), o), o + p.byteLength), 0);
    const inst2 = joined.subarray(70000 - R, 70000 - R + 80000);
    rangeOk = inst2.every((v, k) => v === pt[70000 + k]);
  } catch {}
  // A flipped bit and swapped records are refused.
  const refused = async (data: Uint8Array, i: number) =>
    crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(i) }, key, data as BufferSource).then(() => false, () => true);
  const flipped = ct.slice(0, 65536);
  flipped[1000] ^= 1;
  const flipRefused = await refused(flipped, 0);
  const swapRefused = await refused(ct.slice(65536, 131072), 0);

  const ptSha = await sha256(pt);
  const ctSha = await sha256(ct);
  const mark = (ok: boolean) => h("span", { class: ok ? "good" : "bad", text: ok ? "✓ matches " : "✗ differs " });
  const row = (label: string, ok: boolean, val: string): [string, Node, string] => [label, h("span", {}, mark(ok), val), "mono"];
  facts($("tv-facts"), [
    row("Plaintext SHA-256", ptSha === TV.plaintextSha256, ptSha),
    row("Ciphertext length", ct.length === TV.ciphertextLength, n(ct.length)),
    row("Ciphertext SHA-256", ctSha === TV.ciphertextSha256, ctSha),
    ...tags.map((t, i) => row(`Record ${i} tag`, t === TV.tags[i], t)),
    ["Range read", h("span", { class: rangeOk ? "good" : "bad", text: rangeOk ? "✓ Instance 2 decrypted from records 1–2 alone" : "✗ Instance 2 did not decrypt" })],
    ["Tampering", h("span", { class: flipRefused && swapRefused ? "good" : "bad", text: flipRefused && swapRefused ? "✓ A flipped bit and a record moved to another position are both refused" : "✗ Tampering was not detected" })],
  ]);
  btn.disabled = false;
  btn.textContent = "Check it again";
}

export function initBuild() {
  $("rx-code").textContent = receiverSource;
  $("rx-run").addEventListener("click", runReceiver);
  $("tv-run").addEventListener("click", runTestVector);
  on("ready", () => ($<HTMLButtonElement>("rx-run").disabled = false));
}
