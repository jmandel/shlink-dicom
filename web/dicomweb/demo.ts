import { openDicomweb } from "./shlink-dicomweb";
import { loadConfig } from "../core/config";
import { fetchSampleLinks } from "../core/samples";
import { extractShlink } from "../core/shlink";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const kind = document.body.dataset.viewer!;
let session: Awaited<ReturnType<typeof openDicomweb>> | undefined;
let closeViewer: (() => void) | undefined;
let viewVersion = 0;
let opening = new AbortController();
const status = (s: string, error = false) => { $("status").textContent = s; $("status").dataset.error = String(error); };
const study = $<HTMLSelectElement>("study"), series = $<HTMLSelectElement>("series");
async function showStudy() {
  if (!session) return;
  const version = ++viewVersion, active = session;
  closeViewer?.(); closeViewer = undefined; $("viewer").replaceChildren();
  const st = session.studies.find(s => s.uid === study.value)!;
  if (kind === "ohif") {
    const iframe = document.createElement("iframe"); iframe.title = "OHIF Viewer";
    const u = new URL("../ohif-viewer/viewer/", location.href);
    u.searchParams.set("StudyInstanceUIDs", st.uid); u.searchParams.set("shlSession", session.id);
    const disconnect = session.connectFrame(iframe); iframe.src = u.href; $("viewer").append(iframe);
    status("Link opened in OHIF. Select a series to view its images.");
    closeViewer = () => { disconnect(); iframe.remove(); };
  } else {
    series.replaceChildren(...st.series.map(se => new Option(`${se.modality} · ${se.description || se.uid} (${se.instances})`, se.uid)));
    const preferred = st.series.find(se => ["CT", "MR", "CR", "DX", "US"].includes(se.modality));
    if (preferred) series.value = preferred.uid;
    const { mountCornerstone } = await import("./cornerstone");
    if (version !== viewVersion) return;
    const viewer = await mountCornerstone($("viewer"), active.root, st.uid, (s, error) => { if (version === viewVersion) status(s, error); });
    if (version !== viewVersion) { viewer.dispose(); return; }
    closeViewer = () => viewer.dispose();
    series.onchange = () => { void viewer.showSeries(series.value).catch(e => { if (version === viewVersion && e.name !== "AbortError") status(e.message, true); }); };
    await viewer.showSeries(series.value);
  }
}
async function open(link: string) {
  viewVersion++; opening.abort(); opening = new AbortController(); closeViewer?.(); session?.dispose(); session = undefined;
  $("viewer").replaceChildren(); $("controls").hidden = true;
  const signal = opening.signal; status("Opening the link…");
  try {
    const bare = extractShlink(link); if (!bare) throw new Error("Paste a SMART Health Link or viewer link");
    session = await openDicomweb(bare, { passcode: $<HTMLInputElement>("passcode").value || undefined, signal });
    if (signal.aborted) return;
    // A useful public inspection hook contains only the opaque session URL and inventory.
    (window as any).dicomwebDemo = session;
    study.replaceChildren(...session.studies.map(st => new Option(`${st.modalities.join("/")} · ${st.description || st.uid}`, st.uid)));
    const preferred = session.studies.find(st => st.modalities.includes("MR")) ?? session.studies.find(st => st.modalities.includes("CT"));
    if (preferred) study.value = preferred.uid;
    $("controls").hidden = false;
    await showStudy();
  } catch (e) { if (!signal.aborted) status((e as Error).message, true); }
}
$("open-form").onsubmit = e => { e.preventDefault(); void open($<HTMLInputElement>("link").value); };
study.onchange = () => { void showStudy().catch(e => status(e.message, true)); };
$("sample").onclick = () => { void sample(); };
window.addEventListener("pagehide", () => { opening.abort(); closeViewer?.(); session?.dispose(); });
async function sample() {
  try {
    status("Loading the public sample…");
    const cfg = await loadConfig(), link = cfg.sampleLink ?? (await fetchSampleLinks(cfg)).find(s => !s.passcodeHint)?.shlink;
    if (!link) throw new Error("No public sample is configured. Paste a link above.");
    $<HTMLInputElement>("link").value = link; $<HTMLInputElement>("passcode").value = "";
    await open(link);
  } catch (e) { status((e as Error).message, true); }
}
if (location.hash.includes("shlink:/")) {
  $<HTMLInputElement>("link").value = location.hash.slice(1);
  // The fragment stays in the owning page; neither iframe nor API receives it.
  void open(location.hash.slice(1));
} else void sample();
