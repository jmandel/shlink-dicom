// Landing page: three doors. Fills in the sample links from the server.
import { extractShlink, fetchSampleLinks, loadConfig, viewerUrl } from "../core/index";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

$("open-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("input-link");
  const link = extractShlink(input.value);
  if (!link) {
    input.setCustomValidity("That doesn't contain a SMART Health Link (shlink:/…).");
    input.reportValidity();
    return;
  }
  location.href = viewerUrl(await loadConfig(), link);
});
$<HTMLInputElement>("input-link").addEventListener("input", (e) => (e.target as HTMLInputElement).setCustomValidity(""));

(async () => {
  try {
    const cfg = await loadConfig();
    const samples = await fetchSampleLinks(cfg);
    const pub = samples.find((s) => !s.passcodeHint && s.shlink);
    const pass = samples.find((s) => s.passcodeHint && s.shlink);
    if (pub) {
      const a = $<HTMLAnchorElement>("sample-public");
      // The server's /sample keeps working after the sample is re-seeded (its link changes then),
      // so a copied address stays good. Used when the viewer is the server's own.
      const own = cfg.viewerPrefix.replace(/\/+$/, "") === `${cfg.apiBase}/view`;
      a.href = own ? `${cfg.apiBase}/sample` : viewerUrl(cfg, pub.shlink);
      a.removeAttribute("aria-disabled");
    } else throw new Error("no public sample");
    if (pass) {
      const a = $<HTMLAnchorElement>("sample-passcode");
      a.href = cfg.viewerPrefix.replace(/\/+$/, "") === `${cfg.apiBase}/view` ? `${cfg.apiBase}/sample/passcode` : viewerUrl(cfg, pass.shlink);
      a.textContent = `Try a passcode link (the passcode is ${pass.passcodeHint})`;
      a.classList.remove("hidden");
    }
  } catch {
    $("sample-public").classList.add("hidden");
    $("sample-note").textContent = "The sample isn't available from this server right now.";
  }
})();
