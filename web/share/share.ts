// Share (/share): add imaging → review → recipient and expiry → encrypt and upload → hand it over.
// One step per screen. See docs/EXPERIENCES.md §1.
import { utf8 } from "../core/b64";
import { encryptJwe, randomKeyB64 } from "../core/jwe";
import { extractShlink, parseShlink, hasFlag } from "../core/shlink";
import { formatBytes, formatDate, plural } from "../core/format";
import { loadConfig, siteUrl, type SiteConfig } from "../core/config";
import { fetchSampleLinks } from "../core/samples";
import { openShare } from "../core/share";
import { PasscodeError, LinkError, LinkResolver } from "../core/resolver";
import { getDecoderPool } from "../core/images";
import { drawThumbnail } from "../core/render";
import {
  Collection, encodingSummary, plainStudyTitle, reportFromFile, reportTitle, type ReportItem, seriesName, studyCounts, studyDisplayDate, studyModalities, type StudyModel,
} from "./lib/ingest";
import { buildBundle, ciphertextSize, planStudyFiles, subsetBundle, type PackedFile } from "./lib/pack";
import { ADD_OFFSET_TABLES_DEFAULT, addOffsetTable, addOffsetTables, anyLacksOffsetTable } from "./lib/offset-tables";
import {
  COMPRESS_DEFAULT, ENCODING_NAME, closeCompressPool, compressPool, compressStudies, estimateSeries, isUncompressedImage, restoreCompressed, uncompressedImages, workers,
  type CompressMode, type CompressProgress, type CompressSummary, type Encoding, type SeriesEstimate,
} from "./lib/compress";
import { clearJob, loadJob, persist, saveJob, uploadFiles, type Connection, type UploadFile, type UploadJob, type UploadProgress } from "./lib/upload";
import { StreamPlan } from "./lib/stream";
import { recordCount } from "../core/range";
import { clearStaging, openStager, type Stager } from "./lib/stage";
import { canPickHandles, clearHandles, filesFrom, loadHandles, pathOf, permitted, pick, quickId, saveHandles, type PickedHandles } from "./lib/handles";
import { parseStudyIndex } from "../core/bundle";
import {
  ApiError, ShareApi, manageUrl, publishLinkBundle, readOwnerBundle, saveShare, savedShares, shlinkFor, type LinkResource,
} from "./lib/api";
import { callbackUrl, defaultPortal, finishPortalLaunch, loadFiles, loadLink, loadPortal, startPortalLaunch, type Progress } from "./lib/sources";
import type { Instance, SeriesModel } from "./lib/ingest";
import { $, h, copyText, flash, qrSvg, ICONS, expiryFieldset, expiryFrom, dateOnly, SERVER_MAX_DAYS } from "./lib/ui";

const STEP_NAMES = ["Add imaging", "Review", "Recipient", "Upload", "Send"];
let cfg: SiteConfig;
let col = new Collection();
let sourceKind: "files" | "portal" | "link" | "sample" = "files";
let loadAbort: AbortController | null = null;
let current = 1;
let result: { shlink: string; manage: string; link: LinkResource; studies: number } | null = null;

const shareUrl = () => siteUrl("share/");
const manageBase = () => siteUrl("share/manage");

// ------------------------------------------------------------------------------------- steps

function show(step: number, sub?: string) {
  current = step;
  for (const s of document.querySelectorAll<HTMLElement>(".screen")) s.classList.toggle("hidden", Number(s.dataset.step) !== step);
  for (const li of document.querySelectorAll<HTMLElement>("#steps li")) {
    const n = Number(li.dataset.step);
    li.classList.toggle("done", n < step);
    li.classList.toggle("current", n === step);
    if (n === step) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  }
  $("step-count").textContent = `Step ${step} of 5 · ${STEP_NAMES[step - 1]}`;
  if (step === 1) addPanel(sub ?? "choose");
  window.scrollTo(0, 0);
  const screen = document.querySelector<HTMLElement>(`.screen[data-step="${step}"]`)!;
  const h1 = [...screen.querySelectorAll<HTMLElement>("h1")].find((x) => !x.closest(".hidden"));
  h1?.focus({ preventScroll: true });
}

function addPanel(which: string) {
  for (const id of ["choose", "files", "portal", "link", "loading"]) $(`add-${id}`).classList.toggle("hidden", id !== which);
  const h1 = $(`add-${which}`).querySelector<HTMLElement>("h1");
  h1?.focus({ preventScroll: true });
}

document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const go = t.closest<HTMLElement>("[data-go]");
  if (go) show(Number(go.dataset.go));
  if (t.closest("[data-back]")) {
    loadAbort?.abort();
    show(1, "choose");
  }
});

// ---------------------------------------------------------------------------- 1. add imaging

const CHOICES = [
  { id: "files", icon: ICONS.files, title: "Files or a folder", sub: "DICOM files, a CD, or a ZIP or TGZ archive" },
  { id: "portal", icon: ICONS.portal, title: "Connect to a patient portal", sub: "Sign in to a portal that supports SMART Imaging Access" },
  { id: "link", icon: ICONS.link, title: "Paste a link from my provider", sub: "Pass on some or all of the studies in a SMART Health Link" },
  { id: "sample", icon: ICONS.sample, title: "Try with sample imaging", sub: "A de-identified brain MRI, CT and X-rays, and a pathology slide" },
] as const;

function renderChoices() {
  const box = $("choices");
  box.replaceChildren(
    ...CHOICES.map((c) => {
      const b = h("button", { class: "choice", "data-src": c.id }, h("span", { class: "c-icon" }), h("span", { class: "c-text" }, h("span", { class: "c-title" }, c.title), h("span", { class: "c-sub" }, c.sub)));
      (b.firstChild as HTMLElement).innerHTML = c.icon;
      b.addEventListener("click", () => choose(c.id));
      return b;
    }),
  );
  const saved = savedShares().filter((s) => s.apiBase === cfg.apiBase);
  $("saved").classList.toggle("hidden", !saved.length);
  $("saved-list").replaceChildren(
    ...saved.slice(0, 5).map((s) =>
      h("li", null, h("a", { class: "btn btn-ghost saved-link", href: manageUrl(manageBase(), s) }, h("span", null, s.title), h("span", { class: "tech" }, `made ${dateOnly(s.createdAt)}`))),
    ),
  );
}

function choose(id: string) {
  sourceKind = id as typeof sourceKind;
  if (id === "sample") return runLoad("Opening the sample", async (c, _st, on) => {
    const samples = await fetchSampleLinks(cfg);
    const pub = samples.find((s) => !s.passcodeHint && s.shlink);
    if (!pub) throw new Error("The sample isn't available from this server right now.");
    const share = await openShare(pub.shlink, { recipient: "Share page (sample)" });
    sourceInfo = { kind: "sample", link: pub.shlink };
    await loadLink(share, c, on);
  });
  addPanel(id);
}

// Files
// Pickers: with the File System Access API the choice is kept (as handles) so an interrupted
// upload can continue after a reload without picking again; otherwise a plain file input.
for (const [btn, kind, input] of [["pick-files", "files", "in-files"], ["pick-folder", "folder", "in-folder"]] as const) {
  $(btn).addEventListener("click", async () => {
    if (!canPickHandles()) return $<HTMLInputElement>(input).click();
    const h = await pick(kind);
    if (!h) return;
    startFiles(await filesFrom(h), h);
  });
}
for (const id of ["in-files", "in-folder"]) {
  $<HTMLInputElement>(id).addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length) startFiles(files);
  });
}
const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const handles = await droppedHandles(e.dataTransfer!);
  const files = await droppedFiles(e.dataTransfer!);
  if (files.length) startFiles(files, handles);
});

/** Handles for dropped items, when the browser gives them and they are all files or all folders. */
async function droppedHandles(dt: DataTransfer): Promise<PickedHandles | null> {
  try {
    const hs = (await Promise.all([...dt.items].map((i) => (i as any).getAsFileSystemHandle?.()))).filter(Boolean);
    if (!hs.length || hs.length !== dt.items.length) return null;
    if (hs.every((h) => h.kind === "file")) return { kind: "files", handles: hs };
    if (hs.every((h) => h.kind === "directory")) return { kind: "folder", handles: hs };
  } catch {}
  return null;
}

async function droppedFiles(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  const entries = [...dt.items].map((i) => (i as any).webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const walk = async (entry: any, path: string): Promise<void> => {
    if (entry.isFile) {
      const f: File = await new Promise((res, rej) => entry.file(res, rej));
      Object.defineProperty(f, "webkitRelativePath", { value: path + f.name });
      out.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const x of batch) await walk(x, `${path}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

/** The picked files (for the quick ids saved with an upload) and their handles, if any. */
let pickedFiles: File[] = [];
let pickedHandles: PickedHandles | null = null;

function startFiles(files: File[], handles: PickedHandles | null = null) {
  pickedFiles = files;
  pickedHandles = handles;
  sourceKind = "files";
  sourceInfo = { kind: "files", files: files.map((f) => ({ name: (f as any).webkitRelativePath || f.name, size: f.size })) };
  runLoad("Reading your imaging", (c, st, on, sig) => loadFiles(files, c, st, on, sig));
}

// Portal
$<HTMLInputElement>("in-portal").value = new URLSearchParams(location.search).get("portal") ?? defaultPortal();
$("portal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("portal-error");
  err.classList.add("hidden");
  const btn = (e.target as HTMLFormElement).querySelector("button")!;
  btn.disabled = true;
  try {
    await startPortalLaunch($<HTMLInputElement>("in-portal").value, callbackUrl(shareUrl()));
  } catch (x) {
    err.textContent = (x as Error).message;
    err.classList.remove("hidden");
    btn.disabled = false;
  }
});

async function resumePortal() {
  let sess;
  try {
    sess = await finishPortalLaunch(location.search);
  } catch (x) {
    history.replaceState(null, "", shareUrl());
    show(1, "portal");
    $("portal-error").textContent = (x as Error).message;
    $("portal-error").classList.remove("hidden");
    return true;
  }
  if (!sess) return false;
  history.replaceState(null, "", shareUrl());
  sourceKind = "portal";
  sourceInfo = { kind: "portal" };
  runLoad("Downloading from the portal", (c, st, on, sig) => loadPortal(sess, c, st, on, sig));
  return true;
}

// Link from a provider
let linkResolver: LinkResolver | null = null;
$<HTMLInputElement>("in-link").addEventListener("input", () => {
  linkResolver = null;
  $("link-pass-row").classList.add("hidden");
});
$("link-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("link-error");
  err.classList.add("hidden");
  const link = extractShlink($<HTMLInputElement>("in-link").value);
  const fail = (m: string) => {
    err.textContent = m;
    err.classList.remove("hidden");
  };
  if (!link) return fail("That doesn't contain a SMART Health Link (shlink:/…).");
  let payload;
  try {
    payload = parseShlink(link);
  } catch {
    return fail("That link is damaged.");
  }
  linkResolver ??= new LinkResolver(link, { recipient: "Share page (re-share)" });
  const passcode = $<HTMLInputElement>("in-link-pass").value || undefined;
  if (hasFlag(payload, "P") && !passcode) {
    $("link-pass-row").classList.remove("hidden");
    $("in-link-pass").focus();
    return fail("This link needs a passcode. The person who sent it should have given it to you separately.");
  }
  const btn = (e.target as HTMLFormElement).querySelector<HTMLButtonElement>("button[type=submit]")!;
  btn.disabled = true;
  try {
    const share = await openShare(linkResolver, { passcode, recipient: "Share page (re-share)" });
    btn.disabled = false;
    sourceKind = "link";
    sourceInfo = { kind: "link", link };
    runLoad("Opening the link", (c, _st, on) => loadLink(share, c, on));
  } catch (x) {
    btn.disabled = false;
    if (x instanceof PasscodeError) {
      $("link-pass-row").classList.remove("hidden");
      return fail(x.kind === "required" ? "This link needs a passcode." : `That passcode is not right.${x.remainingAttempts != null ? ` ${plural(x.remainingAttempts, "try", "tries")} left.` : ""}`);
    }
    if (x instanceof LinkError) {
      const m: Record<string, string> = {
        expired: "This link has expired.",
        unavailable: "This link no longer works. It may have been revoked or taken offline.",
        locked: "This link is locked after too many wrong passcodes.",
        network: "The link's server could not be reached.",
        invalid: "This link is damaged, or its key does not open the file.",
        server: "The link's server answered with an error.",
      };
      return fail(m[x.reason] ?? x.message);
    }
    fail((x as Error).message);
  }
});

// Loading (all sources)
type Loader = (c: Collection, stager: Stager, on: (c: Collection, p: Progress) => void, signal: AbortSignal) => Promise<void>;
/** Where this visit stages decompressed and downloaded files, and the source's description for a resumed upload. */
let stager: Stager | null = null;
let sourceInfo: UploadJob["source"] = { kind: "files" };
/** Studies with multi-frame files that lack a frame offset table. */
let lackingStudies = new Set<StudyModel>();

/**
 * A progress bar driven by measured work: `done` of a known `total` in one unit. With no known
 * total the bar is hidden and only the text (counts so far) is shown.
 */
function setBar(id: string, done: number | undefined, total: number | undefined, text = "") {
  const bar = $(id);
  const known = total !== undefined && total > 0 && done !== undefined;
  bar.classList.toggle("hidden", !known);
  if (!known) return;
  const v = Math.max(0, Math.min(done!, total!));
  bar.setAttribute("aria-valuenow", String(v));
  bar.setAttribute("aria-valuemax", String(total));
  // The same amount in words ("12 MB of 47 MB"), as the text beside the bar says it.
  bar.setAttribute("aria-valuetext", text);
  (bar.firstElementChild as HTMLElement).style.width = `${((v / total!) * 100).toFixed(2)}%`;
}

function foundLine(c: Collection): string {
  const studies = c.studies.size;
  if (!studies && !c.instanceCount) return "Looking for DICOM files…";
  return `Found ${plural(studies, "study", "studies")} · ${plural(c.seriesCount, "series", "series")} · ${plural(c.instanceCount, "image")} · ${formatBytes(c.bytes)}`;
}

async function runLoad(title: string, fn: Loader) {
  show(1, "loading");
  $("loading-title").textContent = title;
  $("loading-error").classList.add("hidden");
  $("loading-cancel").classList.remove("hidden");
  setBar("loading-bar", undefined, undefined);
  col = new Collection();
  loadAbort?.abort();
  const ctl = (loadAbort = new AbortController());
  let last = 0;
  const on = (c: Collection, p: Progress) => {
    const now = performance.now();
    if (now - last < 80) return;
    last = now;
    // The headline describes the whole selection when the source says it up front.
    $("found").textContent = p.expected
      ? `${plural(p.expected.studies, "study", "studies")} · ${plural(p.expected.series, "series", "series")} · ${plural(p.expected.images, "image")}`
      : foundLine(c);
    $("doing").textContent = p.doing;
    setBar("loading-bar", p.done, p.total, p.doing);
  };
  $("found").textContent = foundLine(col);
  $("doing").textContent = "";
  try {
    await clearStaging(loadJob()?.source.stage, loadJob()?.compress?.stage);
    stager = await openStager();
    await fn(col, stager, on, ctl.signal);
    if (ctl.signal.aborted) return;
    sourceInfo.stage = stager.onDisk ? stager.session : undefined;
    setBar("loading-bar", undefined, undefined);
    $("doing").textContent = "Checking for frame offset tables";
    lackingStudies = new Set();
    for (const st of col.list()) if (await anyLacksOffsetTable(st.series)) lackingStudies.add(st);
    $("found").textContent = foundLine(col);
    if (!col.studies.size) throw new Error(col.skipped.length ? `No DICOM images were found in ${plural(col.skipped.length, "file")}.` : "No imaging was found.");
    renderReview();
    show(2);
  } catch (x) {
    if (ctl.signal.aborted) return;
    console.warn(x);
    $("loading-cancel").classList.add("hidden");
    setBar("loading-bar", undefined, undefined);
    $("loading-error-text").textContent = (x as Error).message || "Something went wrong.";
    $("loading-error").classList.remove("hidden");
  }
}
$("loading-cancel").addEventListener("click", () => {
  loadAbort?.abort();
  show(1, "choose");
});

// ------------------------------------------------------------------------------- 2. review

let thumbGen = 0;

function renderReview() {
  const studies = col.list();
  $("rv-patient").textContent = col.patient.name
    ? `${col.patientSource === "fhir" ? "Patient" : "Name in the files"}: ${col.patient.name}${col.patient.birthDate ? `, born ${formatDate(col.patient.birthDate)}` : ""}`
    : "";
  const box = $("rv-studies");
  reportBoxes.clear();
  box.replaceChildren(...studies.map(studyCard), ...[looseReportsCard()].filter(Boolean) as HTMLElement[]);
  const skipped = col.skipped.length;
  $("rv-skipped").textContent = [
    skipped ? `${plural(skipped, "file")} skipped (not DICOM images, or DICOMDIR)` : "",
    col.duplicates ? `${plural(col.duplicates, "duplicate image")} left out` : "",
  ].filter(Boolean).join(" · ");
  updateTotal();
  // Multi-frame files without an offset table: offer to add one (on by default).
  if (!offsetsTouched) $<HTMLInputElement>("rv-offsets").checked = ADD_OFFSET_TABLES_DEFAULT;
  if (!compressTouched) setCompressMode(COMPRESS_DEFAULT);
  const gen = ++thumbGen;
  drawThumbs(studies, gen).then(() => estimateAll(studies, gen));
}

let offsetsTouched = false;
$("rv-offsets").addEventListener("change", () => (offsetsTouched = true));
let compressTouched = false;
for (const r of document.querySelectorAll<HTMLInputElement>("input[name=compress]")) {
  r.addEventListener("change", () => {
    compressTouched = true;
    updateTotal();
  });
}
function compressMode(): CompressMode {
  return (document.querySelector<HTMLInputElement>("input[name=compress]:checked")?.value ?? COMPRESS_DEFAULT) as CompressMode;
}
function setCompressMode(m: CompressMode) {
  for (const r of document.querySelectorAll<HTMLInputElement>("input[name=compress]")) r.checked = r.value === m;
}

/** Each series' estimated compression, once measured (one image encoded per series). */
let estimates = new Map<SeriesModel, SeriesEstimate | null>();

/** What this build's encoder offers: "Smaller files, slower" appears when it makes JPEG 2000. */
let encodings: Encoding[] = ["sv1"];

/** Estimates the saving series by series, after the thumbnails, updating the line as it goes. */
async function estimateAll(studies: StudyModel[], gen: number) {
  if (gen === thumbGen) estimates = new Map();
  try {
    encodings = await compressPool().encodings();
  } catch {}
  for (const st of studies) {
    for (const se of st.series) {
      if (gen !== thumbGen) return;
      if (!se.instances.some(isUncompressedImage)) continue;
      try {
        estimates.set(se, await estimateSeries(se, encodings));
      } catch {
        estimates.set(se, null);
      }
      if (gen === thumbGen) updateTotal();
    }
  }
  if (gen === thumbGen) document.body.dataset.estimate = "done";
}

/** How uncompressed images will be re-encoded, or null: there are none, or the person keeps files exact. */
function chosenEncoding(studies: StudyModel[]): Encoding | null {
  const m = compressMode();
  return m !== "exact" && studies.some((s) => s.series.some((se) => se.instances.some(isUncompressedImage))) ? m : null;
}

/** "about 40 seconds", "about 3 minutes". */
function aboutTime(s: number): string {
  if (s < 50) return `about ${Math.max(5, Math.round(s / 5) * 5)} seconds`;
  const m = Math.round(s / 60);
  return m < 60 ? `about ${plural(m, "minute")}` : `about ${plural(Math.round(m / 6) / 10, "hour")}`;
}

function studyCard(st: StudyModel): HTMLElement {
  const c = studyCounts(st);
  const mods = studyModalities(st);
  const date = studyDisplayDate(st);
  const toggle = h("input", { type: "checkbox", checked: st.include, "aria-label": `Include ${plainStudyTitle(st.description, mods)}` }) as HTMLInputElement;
  const card = h(
    "article",
    { class: "card study" + (st.include ? "" : " excluded") },
    h(
      "div",
      { class: "study-head" },
      h("div", { class: "study-name" }, h("h2", null, plainStudyTitle(st.description, mods)), h("p", { class: "date" }, date ? formatDate(date) : "Date not recorded")),
      h("label", { class: "switch-label" }, h("span", { class: "switch" }, toggle, h("span", { class: "track", "aria-hidden": "true" })), h("span", { class: "sw-text" }, st.include ? "Included" : "Left out")),
    ),
    h(
      "div",
      { class: "thumbs", role: "list" },
      st.series.map((se) =>
        h("figure", { class: "thumb", role: "listitem", title: seriesName(se) }, h("canvas", { width: 144, height: 144, "data-uid": se.uid }), h("figcaption", null, seriesName(se))),
      ),
    ),
    reportsBox(st, st.reports),
    h("p", { class: "tech" }, `${plural(c.series, "series", "series")} · ${plural(c.images, "image")} · ${formatBytes(c.bytes)} · ${encodingSummary(st)}${st.description ? ` · “${st.description}”` : ""}`),
  );
  toggle.addEventListener("change", () => {
    st.include = toggle.checked;
    card.classList.toggle("excluded", !st.include);
    reportBoxes.get(st)?.();
    card.querySelector(".sw-text")!.textContent = st.include ? "Included" : "Left out";
    updateTotal();
  });
  return card;
}

/** An Included / Left out switch. `disabledText`: shown off and disabled, with that reason. */
function switchRow(checked: boolean, label: string, onChange: (on: boolean) => void, disabledText?: string): HTMLLabelElement {
  const off = disabledText !== undefined;
  const input = h("input", { type: "checkbox", checked: checked && !off, disabled: off, "aria-disabled": off ? "true" : undefined, "aria-label": label }) as HTMLInputElement;
  const text = h("span", { class: "sw-text" }, off ? disabledText : checked ? "Included" : "Left out");
  input.addEventListener("change", () => {
    text.textContent = input.checked ? "Included" : "Left out";
    onChange(input.checked);
  });
  return h("label", { class: "switch-label" + (off ? " disabled" : "") }, h("span", { class: "switch" }, input, h("span", { class: "track", "aria-hidden": "true" })), text);
}

/** Re-renders a study's reports when the study is included or left out. */
const reportBoxes = new Map<StudyModel, () => void>();

/**
 * A study's reports. Each has its own Included / Left out choice, which applies while the study is
 * included. A left-out study takes its reports with it: their switches show off and disabled, and
 * re-including the study brings back each report's own choice.
 */
function reportsBox(st: StudyModel | null, items: ReportItem[]): HTMLElement {
  const box = h("div", { class: "reports" });
  const render = () => {
    const studyOff = st !== null && !st.include;
    const file = h("input", { type: "file", class: "hidden", accept: "application/pdf,text/plain,.pdf,.txt" }) as HTMLInputElement;
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (!f) return;
      items.push({ resource: await reportFromFile(f), include: true, from: "attached" });
      render();
      updateTotal();
    });
    box.replaceChildren(
      ...items.map((r) => {
        const forms = (r.resource.presentedForm ?? []).map((a: any) => `${/pdf/.test(a.contentType) ? "PDF" : "text"} ${formatBytes(a.size ?? Math.floor((a.data?.length ?? 0) * 0.75))}`);
        const row = h(
          "div",
          { class: "report-row" + (r.include && !studyOff ? "" : " excluded") + (studyOff ? " follows-study" : "") },
          h("div", { class: "report-name" }, h("span", { class: "report-line" }, `Report: ${reportTitle(r.resource)}`), h("span", { class: "tech" }, [r.from === "attached" ? "attached by you" : `from the ${r.from}`, ...forms].join(" · "))),
          switchRow(
            r.include,
            `Include report ${reportTitle(r.resource)}`,
            (on) => {
              r.include = on;
              row.classList.toggle("excluded", !on);
              updateTotal();
            },
            studyOff ? "Left out with the study" : undefined,
          ),
        );
        return row;
      }),
      st ? h("button", { class: "btn btn-ghost attach", type: "button", disabled: studyOff, "aria-disabled": studyOff ? "true" : undefined, onclick: () => file.click() }, "Attach a report (PDF or text)") : null,
      st ? file : null,
    );
  };
  if (st) reportBoxes.set(st, render);
  render();
  return box;
}

/** Reports that name no study here: their own choice, left out unless the person includes them. */
function looseReportsCard(): HTMLElement | null {
  if (!col.looseReports.length) return null;
  return h(
    "article",
    { class: "card study loose" },
    h("div", { class: "study-head" }, h("div", { class: "study-name" }, h("h2", null, "Reports not linked to a study"), h("p", { class: "date" }, "They name none of these studies. Include one only if it belongs with this imaging."))),
    reportsBox(null, col.looseReports),
  );
}

function updateTotal() {
  const inc = col.list().filter((s) => s.include);
  const bytes = inc.reduce((a, s) => a + studyCounts(s).bytes, 0);
  // What goes into the Bundle: included studies, their included reports, and included loose reports.
  const reports = inc.reduce((a, s) => a + s.reports.filter((r) => r.include).length, 0) + col.looseReports.filter((r) => r.include).length;
  $<HTMLButtonElement>("rv-next").disabled = !inc.length;
  $("rv-total").textContent = inc.length
    ? [`Sharing ${plural(inc.length, "study", "studies")}`, reports ? plural(reports, "report") : null, formatBytes(bytes)].filter(Boolean).join(" · ")
    : "Include at least one study to continue.";
  // Frame offset tables: offered while an included study has files that lack them.
  $("rv-offsets-row").classList.toggle("hidden", !inc.some((s) => lackingStudies.has(s)));
  // Compression: offered while an included study has uncompressed images.
  const raw = inc.flatMap((s) => s.series).filter((se) => se.instances.some(isUncompressedImage));
  $("rv-compress").classList.toggle("hidden", !raw.length);
  if (raw.length) {
    const images = raw.reduce((a, se) => a + se.instances.filter(isUncompressedImage).length, 0);
    const before = raw.reduce((a, se) => a + se.instances.filter(isUncompressedImage).reduce((b, i) => b + i.src.size, 0), 0);
    const known = raw.map((se) => estimates.get(se)).filter((e): e is SeriesEstimate => !!e);
    const measured = raw.every((se) => estimates.has(se));
    $("rv-compress-what").textContent = `${plural(images, "image")} here ${images === 1 ? "is" : "are"} uncompressed (${formatBytes(before)}). Compressing without loss keeps every pixel identical but changes the file bytes.`;
    const est = (m: Encoding) => {
      if (!measured) return null;
      const covered = known.reduce((a, e) => a + e.before, 0);
      const after = known.reduce((a, e) => a + e.after[m], 0) + (before - covered);
      // Speed: what the sample encodes measured here, the first one (which loads the encoder) aside.
      const timed = known.slice(1).filter((e) => e.rate[m] > 0);
      const rate = timed.length ? timed.reduce((a, e) => a + e.rate[m], 0) / timed.length : known[0]?.rate[m] ?? 0;
      return { after, seconds: rate > 0 ? before / (rate * workers()) : 0 };
    };
    const sv1 = est("sv1"), j2k = est("j2k");
    // "Smaller files" is offered when this build's encoder makes JPEG 2000.
    const j2kOffered = encodings.includes("j2k");
    $("rv-c-j2k").closest(".pick")!.classList.toggle("hidden", !j2kOffered);
    if (!j2kOffered && compressMode() === "j2k") setCompressMode("sv1");
    $("rv-c-sv1").textContent = sv1 ? `${ENCODING_NAME.sv1} · about ${formatBytes(sv1.after)}` : `${ENCODING_NAME.sv1} · estimating the size…`;
    // Against the default: how much smaller, and how much longer, measured on this data and device.
    const smaller = sv1 && j2k ? sv1.after - j2k.after : 0, longer = sv1 && j2k ? j2k.seconds - sv1.seconds : 0;
    $("rv-c-j2k").textContent = j2k
      ? [`${ENCODING_NAME.j2k} · about ${formatBytes(j2k.after)}`, smaller > 0 ? `${formatBytes(smaller)} smaller` : null, longer > 5 ? `${aboutTime(longer).replace(/^about /, "about ")} more to compress on this device` : null].filter(Boolean).join(" · ")
      : `${ENCODING_NAME.j2k} · estimating the size and time…`;
    if (sv1?.seconds && sv1.seconds > 20) $("rv-c-sv1").textContent += ` · ${aboutTime(sv1.seconds)} to compress on this device`;
    $("rv-c-exact").textContent = `${formatBytes(before)} · the recipient gets the original files, byte for byte`;
    const m = compressMode();
    const chosen = m === "sv1" ? sv1 : m === "j2k" ? j2k : null;
    if (chosen && chosen.after < before) $("rv-total").textContent += ` (about ${formatBytes(bytes - before + chosen.after)} after compression)`;
  }
}

/** Largest instance read whole for a thumbnail. */
const THUMB_MAX = 64 << 20;

async function drawThumbs(studies: StudyModel[], gen: number) {
  let pool;
  try {
    pool = await getDecoderPool();
  } catch {
    return;
  }
  const todo: (() => Promise<void>)[] = [];
  for (const st of studies) {
    for (const se of st.series) {
      // The middle instance, or else the smallest that can be read whole.
      const mid = se.instances[Math.floor(se.instances.length / 2)];
      const inst = mid && mid.src.size <= THUMB_MAX ? mid : [...se.instances].sort((a, b) => a.src.size - b.src.size).find((i) => i.src.size <= THUMB_MAX);
      const canvas = document.querySelector<HTMLCanvasElement>(`canvas[data-uid="${CSS.escape(se.uid)}"]`);
      if (!canvas) continue;
      if (!inst) {
        canvas.classList.add("failed");
        continue;
      }
      todo.push(async () => {
        if (gen !== thumbGen) return;
        try {
          const bytes = await inst.src.read(0, inst.src.size);
          const img = await pool.decode(bytes, { copy: true, scale: 2, priority: 2, header: true });
          if (gen !== thumbGen) return;
          drawThumbnail(canvas, img);
          canvas.classList.add("drawn");
        } catch {
          canvas.classList.add("failed");
        }
      });
    }
  }
  // A few at a time, so only a few instances are in memory at once.
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let job = todo.shift(); job; job = todo.shift()) await job();
  }));
  if (gen === thumbGen) document.body.dataset.thumbs = "done";
}

$("rv-next").addEventListener("click", () => show(3));

// --------------------------------------------------------------------- 3. who and how long

$("who-expiry").replaceWith(expiryFieldset("expiry", "1w"));
$("who-form").addEventListener("submit", (e) => {
  e.preventDefault();
  upload();
});

// --------------------------------------------------------------------------- 4. upload

function setUploadError(msg: string | null) {
  $("up-error").classList.toggle("hidden", !msg);
  $("up-error-text").textContent = msg ?? "";
  $("up-title").textContent = msg ? "The upload stopped" : "Encrypting and uploading";
}
$("up-retry").addEventListener("click", () => {
  if (pending) runUpload(pending);
  else upload();
});

/** An upload under way: what it needs to continue. */
interface Pending {
  /** True until the first try: the share is new, so the server has nothing yet. */
  fresh?: boolean;
  job: UploadJob;
  api: ShareApi;
  /** The owner Bundle; null until the files are uploaded, when they were compressed on the way. */
  owner: any | null;
  packed: UploadFile[];
  col: Collection;
  /** Set while images are compressed as the files upload. */
  stream?: { plan: StreamPlan; line: () => string; repaint?: () => void };
}
let pending: Pending | null = null;

async function upload() {
  show(4);
  setUploadError(null);
  setBar("up-bar-wrap", undefined, undefined);
  $("up-main").textContent = "";
  const form = $("who-form");
  const job: Omit<UploadJob, "sid" | "token" | "ownerKey" | "title" | "startedAt"> = {
    apiBase: cfg.apiBase,
    source: sourceInfo,
    addOffsetTables: !$("rv-offsets-row").classList.contains("hidden") && $<HTMLInputElement>("rv-offsets").checked,
    compress: null,
    recipient: $<HTMLInputElement>("in-recipient").value.trim() || null,
    passcode: $<HTMLInputElement>("in-pass").value,
    longLived: $<HTMLInputElement>("in-updates").checked,
    exp: expiryFrom(form, "expiry"),
  };
  const studies = col.list().filter((s) => s.include);
  $("up-log").replaceChildren();
  let streaming: ReturnType<typeof startStream> | null = null;
  try {
    const encoding = chosenEncoding(studies);
    if (!encoding) closeCompressPool(); // the review's estimates are done with it
    // Images to compress go to the server as they are compressed (lib/stream.ts).
    const toCompress = new Set(encoding ? uncompressedImages(studies).map((x) => x.inst) : []);
    if (job.addOffsetTables) {
      await addOffsetTables(
        studies.flatMap((s) => s.series),
        (done, total) => {
          $("up-main").textContent = `Adding frame offset tables: ${done} of ${plural(total, "file")}`;
          setBar("up-bar-wrap", done, total, $("up-main").textContent!);
        },
        (inst) => !toCompress.has(inst),
      );
    }
    const packed: UploadFile[] = planStudyFiles(studies);
    // Compressing starts now, while the share is made; uploads start once the job is saved.
    const zst = encoding ? await openStager(`${stager?.session ?? "visit"}-z`) : null;
    if (encoding && zst) {
      job.compress = { mode: encoding, stage: zst.onDisk ? zst.session : undefined, records: {}, kept: [] };
      job.plan = packed.map((p) => ({ fileId: p.fileId, key: p.key, uids: p.instances.map((i) => i.h.sopInstanceUid) }));
      streaming = startStream(packed, studies, encoding, zst, toCompress, job.addOffsetTables, job.compress);
    }
    // Which files these are (to continue after a reload), read while the share is made.
    const ids = job.source.kind === "files" ? Promise.all(pickedFiles.map(async (f) => ({ name: pathOf(f), size: f.size, id: await quickId(f) }))) : null;
    ids?.catch(() => {}); // awaited below; not reported twice if making the share fails first
    const ownerKey = randomKeyB64();
    const early = (c: Connection) => ($("up-main").textContent = c.state === "ok" ? "" : "Connection lost, retrying…");
    const created = await persist(() => new ShareApi(cfg.apiBase).createShare(job.exp ?? Math.floor(Date.now() / 1000) + SERVER_MAX_DAYS * 86400), early);
    const api = new ShareApi(cfg.apiBase, { sid: created.share.id, token: created.controlToken });
    // Nothing to compress: the owner Bundle first; with the manage credential it is all a reload
    // needs to continue. Compressing: the files' sizes come later, so the saved job's plan is.
    let owner: any = null;
    if (!streaming) {
      owner = buildBundle(col, packed);
      const ownerJwe = await encryptJwe(utf8(JSON.stringify(owner)), ownerKey);
      await persist(() => api.putOwner(ownerJwe), early);
    }
    if (job.source.kind === "files") {
      $("up-tech").textContent = "Noting which files these are, to continue after a reload";
      job.source = { ...job.source, files: await ids! };
      if (pickedHandles) await saveHandles(pickedHandles);
      else await clearHandles();
    }
    const titles = studies.map((s) => plainStudyTitle(s.description, studyModalities(s)));
    const full: UploadJob = { ...job, sid: created.share.id, token: created.controlToken, ownerKey, title: titles.join(", "), startedAt: Math.floor(Date.now() / 1000) };
    saveJob(full);
    if (streaming) {
      streaming.saved(full);
      await runUpload({ job: full, api, owner, packed, col, fresh: true, stream: streaming.stream });
    } else await runUpload({ job: full, api, owner, packed, col, fresh: true });
  } catch (x) {
    streaming?.abort(x);
    uploadFailed(x);
  }
}

/**
 * Compresses the images while the files upload: each file goes as its images are done
 * (lib/stream.ts). Each image's record is saved with the job before any of its bytes are sent, so
 * a reload continues with the same bytes; until the job is saved (`saved`), nothing is sent.
 */
function startStream(
  packed: UploadFile[],
  studies: StudyModel[],
  mode: Encoding,
  zst: Stager,
  toCompress: Set<Instance>,
  addTables: boolean,
  comp: NonNullable<UploadJob["compress"]>,
) {
  const plan = new StreamPlan(packed, (inst) => toCompress.has(inst));
  const seriesOf = new Map<Instance, SeriesModel>();
  for (const st of studies) for (const se of st.series) for (const inst of se.instances) seriesOf.set(inst, se);
  let job: UploadJob | null = null;
  const stop = new AbortController();
  let progress: CompressProgress | null = null;
  const stream: NonNullable<Pending["stream"]> = {
    plan,
    line: () => (progress && progress.done < progress.total ? `compressing ${progress.done} of ${plural(progress.total, "image")} without loss` : ""),
  };
  compressStudies(
    col,
    studies,
    mode,
    zst,
    (c) => {
      progress = c;
      stream.repaint?.();
    },
    stop.signal,
    undefined,
    {
      onImage: async (inst, rec) => {
        if (addTables) await addOffsetTable(seriesOf.get(inst)!, inst);
        if (rec) comp.records[inst.h.sopInstanceUid] = rec;
        else comp.kept!.push(inst.h.sopInstanceUid);
        if (job) saveJob(job);
        plan.done(inst);
      },
    },
  )
    .finally(closeCompressPool)
    .then(
      (sum) => $("up-log").prepend(h("li", null, compressedLine(sum))),
      (e) => {
        // Nothing more will come for the files: the upload stops, and Try again starts over.
        pending = null;
        plan.fail(e);
      },
    );
  return {
    stream,
    /** The job is saved: records from here on are saved as they come. */
    saved(j: UploadJob) {
      job = j;
    },
    abort(e: unknown) {
      stop.abort(e);
    },
  };
}

/**
 * Re-encodes the studies' uncompressed images (but `skip`), showing measured progress and the time
 * left. For an upload continuing after a reload: the images not compressed before it.
 */
async function compress(c: Collection, studies: StudyModel[], mode: Encoding, zst: Stager, skip?: ReadonlySet<string>): Promise<CompressSummary> {
  try {
    return await compressStudies(c, studies, mode, zst, (p) => {
      // Time left, from this device's measured speed once a few images are done.
      const left = p.done >= 4 && p.seconds >= 2 && p.before > 0 ? ((p.totalBytes - p.before) * p.seconds) / p.before : 0;
      $("up-main").textContent = `Compressing ${p.done} of ${plural(p.total, "image")} without loss · ${formatBytes(p.before)} → ${formatBytes(p.after)} so far${left > 5 ? ` · ${aboutTime(left)} left` : ""}`;
      setBar("up-bar-wrap", p.done, p.total, `${p.done} of ${p.total} images compressed`);
    }, undefined, undefined, { skip });
  } finally {
    closeCompressPool();
  }
}

function compressedLine(sum: CompressSummary): string {
  const kept = sum.total - sum.compressed;
  return sum.compressed
    ? `Compressed ${plural(sum.compressed, "image")} without loss as ${ENCODING_NAME[sum.mode]} (pixels identical): ${formatBytes(sum.before)} → ${formatBytes(sum.after)} in ${aboutTime(sum.seconds).replace("about ", "")}${kept ? ` · ${plural(kept, "image")} kept as they were` : ""}`
    : `${plural(sum.total, "image")} kept as they were (compressing them would not make them smaller)`;
}

function uploadFailed(x: unknown) {
  console.warn(x);
  const e = x as ApiError;
  setUploadError(
    e.status === 413
      ? `The server refused the files: ${/QUOTA/.test(e.message) ? "this share is larger than it accepts" : e.message}.`
      : e.status === 429
        ? "The server has too many shares right now. Try again later."
        : `${e.message || "Something went wrong."}${pending ? " What reached the server is kept: Try again continues from there." : ""}`,
  );
}

/** Uploads what the server doesn't have yet, then makes the link. */
async function runUpload(p: Pending) {
  pending = { ...p, fresh: false };
  show(4);
  setUploadError(null);
  const { job, api, packed, stream } = p;
  const totalRecords = () => packed.reduce((a, x) => a + x.records, 0);
  let last = { sent: 0, total: packed.reduce((a, x) => a + ciphertextSize(x), 0), done: 0 };
  let lastU: Pick<UploadProgress, "offsets" | "sending"> = { offsets: new Map() };
  let conn: Connection = { state: "ok" };
  const paint = () => {
    const { sent, total, done } = last;
    // Compressing on the way: the bar is the images' bytes done (their total is known; the
    // compressed files' sizes are not yet).
    const amount = stream ? `${formatBytes(stream.plan.inputDone(lastU))} of ${formatBytes(stream.plan.inputTotal)}` : `${formatBytes(sent)} of ${formatBytes(total)}`;
    if (stream) setBar("up-bar-wrap", stream.plan.inputDone(lastU), stream.plan.inputTotal, `${amount} done`);
    else setBar("up-bar-wrap", sent, total, `${amount} sent`);
    const doing = stream ? [`Compressed and uploaded ${amount}`, stream.line()].filter(Boolean).join(" · ") : `Uploaded ${amount}`;
    $("up-main").textContent =
      conn.state === "offline"
        ? `Connection lost. Waiting for the network… ${amount} ${stream ? "done" : "sent"}`
        : conn.state === "retrying"
          ? `Connection lost, retrying… ${amount} ${stream ? "done" : "sent"}`
          : doing;
    $("up-main").classList.toggle("warn", conn.state !== "ok");
    const records = totalRecords();
    $("up-tech").textContent = `Encrypting ${plural(packed.length, "file")} on this device: ${done} done · ${stream && packed.some((x) => !x.growing?.done) ? Math.floor(sent / 65536) : `${Math.min(records, Math.floor(sent / 65536))} of ${records}`} records uploaded${conn.state === "retrying" ? ` · next try in ${Math.round(conn.inMs / 1000)} s (${conn.reason})` : ""}`;
  };
  if (stream) stream.repaint = paint;
  const onConn = (c: Connection) => {
    conn = c;
    document.body.dataset.connection = c.state;
    paint();
  };
  try {
    await uploadFiles(
      api,
      packed,
      (u) => {
        // Bytes sent only go up: a retry that resends some bytes doesn't move the bar back.
        last = { sent: Math.max(u.total === last.total || stream ? last.sent : 0, u.sent), total: u.total, done: u.filesDone };
        lastU = u;
        paint();
        if (u.finished) $("up-log").prepend(h("li", null, `${plainStudyTitle(u.finished.study.description, studyModalities(u.finished.study))} → ${u.finished.fileId.slice(0, 6)}….bin · ${formatBytes(ciphertextSize(u.finished))} · ${plural(u.finished.records, "record")}`));
      },
      onConn,
      { fresh: p.fresh },
    );
    $("up-tech").textContent = `Encrypted ${plural(packed.length, "file")} · ${totalRecords()} records uploaded · making the link`;
    // Compressed on the way: the owner Bundle, now that the files' sizes are known.
    let owner = p.owner;
    if (!owner) {
      owner = buildBundle(p.col, packed);
      const ownerJwe = await encryptJwe(utf8(JSON.stringify(owner)), job.ownerKey);
      await persist(() => api.putOwner(ownerJwe), onConn);
      if (pending) pending.owner = owner;
    }
    const studyIds = owner.entry.filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => e.resource.id);
    const { bundle, allowedFiles } = subsetBundle(owner, studyIds);
    let link = (await persist(() => api.getShare(), onConn)).links[0];
    link ??= await persist(() => api.createLink({ label: job.recipient, passcode: job.passcode, exp: job.exp, longLived: job.longLived, allowedFiles }), onConn);
    const made = link;
    link = await persist(() => publishLinkBundle(api, job.ownerKey, made.id, bundle), onConn);
    const cred = { sid: job.sid, token: job.token, ownerKey: job.ownerKey };
    const shlink = await shlinkFor(link, job.ownerKey, cfg.viewerPrefix);
    const saved = saveShare({ ...cred, title: `${job.title}${job.recipient ? ` · for ${job.recipient}` : ""}`, createdAt: job.startedAt, apiBase: cfg.apiBase });
    clearJob();
    await clearHandles();
    pending = null;
    await clearStaging(null);
    result = { shlink, manage: manageUrl(manageBase(), cred), link, studies: studyIds.length };
    renderDone(saved, !!job.passcode, job.recipient);
    show(5);
  } catch (x) {
    uploadFailed(x);
  }
}

// ------------------------------------------------------------ continuing after a reload

/** The files this upload started with, among those picked again (by name, size and quick id). */
async function sameFiles(job: UploadJob, picked: File[]): Promise<File[]> {
  const want = job.source.files ?? [];
  if (!want.length) return picked;
  const byName = new Map<string, File[]>();
  for (const f of picked) {
    for (const k of new Set([pathOf(f), f.name])) byName.set(k, [...(byName.get(k) ?? []), f]);
  }
  const out: File[] = [];
  for (const w of want) {
    const base = w.name.split("/").pop()!;
    const candidates = [...new Set([...(byName.get(w.name) ?? []), ...(byName.get(base) ?? [])])].filter((f) => f.size === w.size);
    let hit: File | undefined;
    for (const f of candidates) if (!hit && (!w.id || (await quickId(f)) === w.id)) hit = f;
    if (!hit) throw new Error(candidates.length ? `${w.name} is not the same file as before.` : `${w.name} is missing from what you chose.`);
    out.push(hit);
  }
  return out;
}

/** Rebuilds the file plan of a saved job from its owner Bundle and the re-opened source. */
function planFromOwner(owner: any, c: Collection): PackedFile[] {
  const byUid = new Map<string, { inst: Instance; study: StudyModel }>();
  for (const st of c.list()) for (const se of st.series) for (const inst of se.instances) byUid.set(inst.h.sopInstanceUid, { inst, study: st });
  const idx = parseStudyIndex(owner);
  const out: PackedFile[] = [];
  for (const st of idx.studies) {
    for (const file of st.files) {
      // The file's instances in file order: its series in Bundle order (§8.1).
      const instances = st.series
        .filter((se) => se.file === file)
        .flatMap((se) => se.instances)
        .map((i) => {
          const hit = byUid.get(i.uid);
          if (!hit) throw new Error("Some of the files are not the ones this upload started with.");
          if (hit.inst.src.size !== i.length) throw new Error("Some of the files differ from the ones this upload started with.");
          return hit.inst;
        });
      out.push({
        study: byUid.get(st.series[0].instances[0].uid)!.study,
        instances,
        fileId: file.fileId,
        key: file.key,
        plaintextLength: file.plaintextLength,
        records: file.recordCount,
      });
    }
  }
  return out;
}

/** Rebuilds the file plan of a job saved while compressing (`job.plan`) from the re-opened source. */
function planFromJob(plan: NonNullable<UploadJob["plan"]>, c: Collection): PackedFile[] {
  const byUid = new Map<string, { inst: Instance; study: StudyModel }>();
  for (const st of c.list()) for (const se of st.series) for (const inst of se.instances) byUid.set(inst.h.sopInstanceUid, { inst, study: st });
  return plan.map((f) => {
    const hits = f.uids.map((u) => {
      const hit = byUid.get(u);
      if (!hit) throw new Error("Some of the files are not the ones this upload started with.");
      return hit;
    });
    const instances = hits.map((x) => x.inst);
    const P = instances.reduce((a, i) => a + i.src.size, 0);
    return { study: hits[0].study, instances, fileId: f.fileId, key: f.key, plaintextLength: P, records: recordCount(P) };
  });
}

async function resumeJob(job: UploadJob, files?: File[]) {
  const api = new ShareApi(job.apiBase, { sid: job.sid, token: job.token });
  show(4);
  setUploadError(null);
  $("up-tech").textContent = "Continuing the upload";
  $("up-main").textContent = "Reading the files again";
  setBar("up-bar-wrap", undefined, undefined);
  try {
    // Compressed on the way: no owner Bundle until the files are up; the job's plan says what they are.
    const owner = job.plan ? null : await readOwnerBundle(api, job.ownerKey);
    const c = new Collection();
    const st = await openStager(job.source.stage);
    const on = (_c: Collection, p: Progress) => {
      $("up-main").textContent = p.doing;
      setBar("up-bar-wrap", p.done, p.total, p.doing);
    };
    if (job.source.kind === "files") await loadFiles(await sameFiles(job, files ?? []), c, st, on);
    else if (job.source.kind === "portal") {
      for (const [k, src] of (await st.list()).entries()) await c.add(`staged/${k}`, src);
      c.finish();
    } else await loadLink(await openShare(job.source.link!, { recipient: "Share page (re-share)" }), c, on);
    // The same bytes as before: each re-encoded image from its staged copy (or encoded again and checked).
    if (job.compress) {
      const planned = new Set(job.plan?.flatMap((f) => f.uids));
      const inBundle = new Set(owner ? parseStudyIndex(owner).studies.map((s) => s.studyInstanceUid) : []);
      const studies = c.list().filter((s) => (owner ? inBundle.has(s.uid) : s.series.some((se) => se.instances.some((i) => planned.has(i.h.sopInstanceUid)))));
      const zst = await openStager(job.compress.stage ?? `${st.session}-z`);
      try {
        await restoreCompressed(c, studies, job.compress.mode, job.compress.records, zst, (done, total) => {
          $("up-main").textContent = `Finding the compressed images: ${done} of ${total}`;
          setBar("up-bar-wrap", done, total, $("up-main").textContent!);
        });
      } finally {
        closeCompressPool();
      }
      if (job.plan) {
        // The images not compressed before the reload; those kept as they were stay so.
        const sum = await compress(c, studies, job.compress.mode, zst, new Set(job.compress.kept ?? []));
        Object.assign(job.compress.records, sum.records);
        job.compress.kept = [...(job.compress.kept ?? []), ...sum.kept];
        saveJob(job);
      }
    }
    if (job.addOffsetTables) await addOffsetTables(c.list().flatMap((x) => x.series));
    await runUpload({ job, api, owner, packed: job.plan ? planFromJob(job.plan, c) : planFromOwner(owner, c), col: c });
  } catch (x) {
    // Back to the notice, saying what was wrong, so the person can choose again.
    pending = null;
    show(1, "choose");
    await renderResume(job);
    $("resume-error").textContent = (x as Error).message || "Something went wrong.";
    $("resume-error").classList.remove("hidden");
  }
}

async function renderResume(job: UploadJob) {
  $("resume-title").textContent = job.title;
  const needFiles = job.source.kind === "files" && !(await loadHandles());
  $("resume-text").textContent = needFiles
    ? `Choose the same ${job.source.files && job.source.files.length > 1 ? "files or folder" : "file"} again to continue. What reached the server is kept.`
    : "What reached the server is kept. Continue to send the rest.";
  $("resume-continue").textContent = needFiles ? "Choose the files" : "Continue";
  $("resume-error").classList.add("hidden");
  $("resume").classList.remove("hidden");
}
$("resume-continue").addEventListener("click", async () => {
  const job = loadJob();
  if (!job) return;
  if (job.source.kind === "files") {
    // Remembered handles: one permission click, then continue with the same files.
    const h = await loadHandles();
    if (h && (await permitted(h).catch(() => false))) return resumeJob(job, await filesFrom(h));
  }
  if (job.source.kind === "files") $<HTMLInputElement>(job.source.files?.some((f) => f.name.includes("/")) ? "in-resume-folder" : "in-resume").click();
  else resumeJob(job);
});
for (const id of ["in-resume", "in-resume-folder"]) {
  $<HTMLInputElement>(id).addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    const job = loadJob();
    if (job && files.length) resumeJob(job, files);
  });
}
$("resume-discard").addEventListener("click", async () => {
  await clearHandles();
  const job = loadJob();
  if (job) await new ShareApi(job.apiBase, { sid: job.sid, token: job.token }).deleteShare().catch(() => {});
  clearJob();
  await clearStaging(null);
  $("resume").classList.add("hidden");
});

// ---------------------------------------------------------------------------- 5. hand over

function renderDone(saved: boolean, hasPasscode: boolean, recipient: string | null) {
  const r = result!;
  const exp = r.link.exp;
  $("done-sub").textContent = [recipient ? `For ${recipient}` : null, plural(r.studies, "study", "studies"), exp ? `works until ${dateOnly(exp)}` : "works until you revoke it"]
    .filter(Boolean)
    .join(" · ");
  $("qr").innerHTML = qrSvg(r.shlink);
  $("done-link").textContent = r.shlink;
  $<HTMLAnchorElement>("d-open").href = r.shlink;
  const subject = "Imaging shared with you";
  const body = `${recipient ? `For ${recipient}: ` : ""}I've shared imaging with you. Open this link to view it:\n\n${r.shlink}\n${hasPasscode ? "\nI'll send you the passcode separately.\n" : ""}`;
  $<HTMLAnchorElement>("d-email").href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  $("d-share").classList.toggle("hidden", !("share" in navigator));
  $("done-note").textContent = hasPasscode
    ? "The recipient also needs the passcode. Send it a different way, for example by phone."
    : "Anyone who has this link can see the imaging, so send it only to the person it's for.";
  $<HTMLInputElement>("manage-url").value = r.manage;
  $<HTMLAnchorElement>("m-open").href = r.manage;
  $("saved-note").textContent = saved ? "It is also saved in this browser, under Your shares." : "This browser did not let the page save it, so copy it now.";
}

$("d-copy").addEventListener("click", async (e) => flash(e.currentTarget as HTMLElement, (await copyText(result!.shlink)) ? "Copied" : "Copy failed"));
$("m-copy").addEventListener("click", async (e) => flash(e.currentTarget as HTMLElement, (await copyText(result!.manage)) ? "Copied" : "Copy failed"));
$("d-share").addEventListener("click", async () => {
  try {
    await navigator.share({ title: "Imaging shared with you", url: result!.shlink });
  } catch {}
});
$("again").addEventListener("click", () => {
  col = new Collection();
  result = null;
  ($("who-form") as HTMLFormElement).reset();
  renderChoices();
  show(1, "choose");
});

// ---------------------------------------------------------------------------------- start

(async () => {
  cfg = await loadConfig();
  $<HTMLAnchorElement>("top-manage").href = manageBase();
  renderChoices();
  show(1, "choose");
  const job = loadJob();
  if (job && job.apiBase === cfg.apiBase) renderResume(job);
  else await clearStaging(null);
  await resumePortal();
  getDecoderPool().catch(() => {});
})();

// Test hooks for the scripted checks.
(window as any).__share = {
  get step() {
    return current;
  },
  get result() {
    return result;
  },
  get collection() {
    return col;
  },
  /** For the checks: share files behind handles, as if picked with the browser's picker. */
  async pickHandles(h: PickedHandles) {
    startFiles(await filesFrom(h), h);
  },
};
