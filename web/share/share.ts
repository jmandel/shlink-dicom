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
  Collection, encodingSummary, plainStudyTitle, reportFromFile, reportTitle, seriesName, studyCounts, studyDisplayDate, studyModalities, type StudyModel,
} from "./lib/ingest";
import { buildBundle, ciphertextSize, planSeriesFiles, subsetBundle, type PackedSeries } from "./lib/pack";
import { ADD_OFFSET_TABLES_DEFAULT, addOffsetTables, anyLacksOffsetTable } from "./lib/offset-tables";
import { clearJob, loadJob, saveJob, uploadSeries, type UploadJob } from "./lib/upload";
import { clearStaging, openStager, type Stager } from "./lib/stage";
import { parseStudyIndex } from "../core/bundle";
import {
  ApiError, ShareApi, manageUrl, publishLinkBundle, readOwnerBundle, saveShare, savedShares, shlinkFor, type LinkResource,
} from "./lib/api";
import { callbackUrl, defaultPortal, finishPortalLaunch, loadFiles, loadLink, loadPortal, startPortalLaunch, type Progress } from "./lib/sources";
import type { SeriesModel } from "./lib/ingest";
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
$("pick-files").addEventListener("click", () => $<HTMLInputElement>("in-files").click());
$("pick-folder").addEventListener("click", () => $<HTMLInputElement>("in-folder").click());
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
  const files = await droppedFiles(e.dataTransfer!);
  if (files.length) startFiles(files);
});

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

function startFiles(files: File[]) {
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
let offsetsLacking = false;

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
  $("loading-bar").classList.remove("hidden");
  col = new Collection();
  loadAbort?.abort();
  const ctl = (loadAbort = new AbortController());
  let last = 0;
  const on = (c: Collection, p: Progress) => {
    const now = performance.now();
    if (now - last < 80) return;
    last = now;
    $("found").textContent = foundLine(c);
    $("doing").textContent = p.doing + (p.bytes ? ` · ${formatBytes(p.bytes)}` : "");
  };
  $("found").textContent = foundLine(col);
  $("doing").textContent = "";
  try {
    await clearStaging(loadJob()?.source.stage ?? null);
    stager = await openStager();
    await fn(col, stager, on, ctl.signal);
    if (ctl.signal.aborted) return;
    sourceInfo.stage = stager.onDisk ? stager.session : undefined;
    $("doing").textContent = "Checking for frame offset tables";
    offsetsLacking = await anyLacksOffsetTable(col.list().flatMap((s) => s.series));
    $("found").textContent = foundLine(col);
    if (!col.studies.size) throw new Error(col.skipped.length ? `No DICOM images were found in ${plural(col.skipped.length, "file")}.` : "No imaging was found.");
    renderReview();
    show(2);
  } catch (x) {
    if (ctl.signal.aborted) return;
    console.warn(x);
    $("loading-cancel").classList.add("hidden");
    $("loading-bar").classList.add("hidden");
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
  box.replaceChildren(...studies.map(studyCard));
  const skipped = col.skipped.length;
  $("rv-skipped").textContent = [
    skipped ? `${plural(skipped, "file")} skipped (not DICOM images, or DICOMDIR)` : "",
    col.duplicates ? `${plural(col.duplicates, "duplicate image")} left out` : "",
  ].filter(Boolean).join(" · ");
  updateTotal();
  // Multi-frame files without an offset table: offer to add one (on by default).
  const lacking = offsetsLacking;
  $("rv-offsets-row").classList.toggle("hidden", !lacking);
  if (lacking && !offsetsTouched) $<HTMLInputElement>("rv-offsets").checked = ADD_OFFSET_TABLES_DEFAULT;
  drawThumbs(studies, ++thumbGen);
}

let offsetsTouched = false;
$("rv-offsets").addEventListener("change", () => (offsetsTouched = true));

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
    reportsBox(st),
    h("p", { class: "tech" }, `${plural(c.series, "series", "series")} · ${plural(c.images, "image")} · ${formatBytes(c.bytes)} · ${encodingSummary(st)}${st.description ? ` · “${st.description}”` : ""}`),
  );
  toggle.addEventListener("change", () => {
    st.include = toggle.checked;
    card.classList.toggle("excluded", !st.include);
    card.querySelector(".sw-text")!.textContent = st.include ? "Included" : "Left out";
    updateTotal();
  });
  return card;
}

function switchRow(checked: boolean, label: string, onChange: (on: boolean) => void): HTMLLabelElement {
  const input = h("input", { type: "checkbox", checked, "aria-label": label }) as HTMLInputElement;
  const text = h("span", { class: "sw-text" }, checked ? "Included" : "Left out");
  input.addEventListener("change", () => {
    text.textContent = input.checked ? "Included" : "Left out";
    onChange(input.checked);
  });
  return h("label", { class: "switch-label" }, h("span", { class: "switch" }, input, h("span", { class: "track", "aria-hidden": "true" })), text);
}

function reportsBox(st: StudyModel): HTMLElement {
  const box = h("div", { class: "reports" });
  const render = () => {
    const file = h("input", { type: "file", class: "hidden", accept: "application/pdf,text/plain,.pdf,.txt" }) as HTMLInputElement;
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (!f) return;
      st.reports.push({ resource: await reportFromFile(f), include: true, from: "attached" });
      render();
    });
    box.replaceChildren(
      ...st.reports.map((r) => {
        const forms = (r.resource.presentedForm ?? []).map((a: any) => `${/pdf/.test(a.contentType) ? "PDF" : "text"} ${formatBytes(a.size ?? Math.floor((a.data?.length ?? 0) * 0.75))}`);
        const row = h(
          "div",
          { class: "report-row" + (r.include ? "" : " excluded") },
          h("div", { class: "report-name" }, h("span", { class: "report-line" }, `Report: ${reportTitle(r.resource)}`), h("span", { class: "tech" }, [r.from === "attached" ? "attached by you" : `from the ${r.from}`, ...forms].join(" · "))),
          switchRow(r.include, `Include report ${reportTitle(r.resource)}`, (on) => {
            r.include = on;
            row.classList.toggle("excluded", !on);
          }),
        );
        return row;
      }),
      h("button", { class: "btn btn-ghost attach", type: "button", onclick: () => file.click() }, "Attach a report (PDF or text)"),
      file,
    );
  };
  render();
  return box;
}

function updateTotal() {
  const inc = col.list().filter((s) => s.include);
  const bytes = inc.reduce((a, s) => a + studyCounts(s).bytes, 0);
  $<HTMLButtonElement>("rv-next").disabled = !inc.length;
  $("rv-total").textContent = inc.length ? `Sharing ${plural(inc.length, "study", "studies")} · ${formatBytes(bytes)}` : "Include at least one study to continue.";
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
          const img = await pool.decode(bytes, { copy: true, scale: 2, priority: 2 });
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
  job: UploadJob;
  api: ShareApi;
  owner: any;
  packed: PackedSeries[];
}
let pending: Pending | null = null;

async function upload() {
  show(4);
  setUploadError(null);
  const form = $("who-form");
  const job: Omit<UploadJob, "sid" | "token" | "ownerKey" | "title" | "startedAt"> = {
    apiBase: cfg.apiBase,
    source: sourceInfo,
    addOffsetTables: !$("rv-offsets-row").classList.contains("hidden") && $<HTMLInputElement>("rv-offsets").checked,
    recipient: $<HTMLInputElement>("in-recipient").value.trim() || null,
    passcode: $<HTMLInputElement>("in-pass").value,
    longLived: $<HTMLInputElement>("in-updates").checked,
    exp: expiryFrom(form, "expiry"),
  };
  const studies = col.list().filter((s) => s.include);
  $("up-log").replaceChildren();
  try {
    if (job.addOffsetTables) {
      await addOffsetTables(studies.flatMap((s) => s.series), (done, total) => {
        $("up-tech").textContent = `Adding frame offset tables: ${done} of ${plural(total, "file")}`;
      });
    }
    const packed = planSeriesFiles(studies);
    const owner = buildBundle(col, packed);
    const ownerKey = randomKeyB64();
    const created = await new ShareApi(cfg.apiBase).createShare(job.exp ?? Math.floor(Date.now() / 1000) + SERVER_MAX_DAYS * 86400);
    const api = new ShareApi(cfg.apiBase, { sid: created.share.id, token: created.controlToken });
    // The owner Bundle first: with the manage credential it is all a reload needs to continue.
    await api.putOwner(await encryptJwe(utf8(JSON.stringify(owner)), ownerKey));
    const titles = studies.map((s) => plainStudyTitle(s.description, studyModalities(s)));
    const full: UploadJob = { ...job, sid: created.share.id, token: created.controlToken, ownerKey, title: titles.join(", "), startedAt: Math.floor(Date.now() / 1000) };
    saveJob(full);
    await runUpload({ job: full, api, owner, packed });
  } catch (x) {
    uploadFailed(x);
  }
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
  pending = p;
  show(4);
  setUploadError(null);
  const { job, api, owner, packed } = p;
  const totalRecords = packed.reduce((a, x) => a + x.records, 0);
  const paint = (sent: number, total: number, done: number) => {
    $<HTMLElement>("up-bar").style.width = `${((sent / total) * 100).toFixed(1)}%`;
    $("up-main").textContent = `Uploaded ${formatBytes(sent)} of ${formatBytes(total)}`;
    $("up-tech").textContent = `Encrypting ${plural(packed.length, "series", "series")} on this device: ${done} done · ${Math.min(totalRecords, Math.floor(sent / 65536))} of ${totalRecords} records uploaded`;
  };
  try {
    await uploadSeries(api, packed, (u) => {
      paint(u.sent, u.total, u.seriesDone);
      if (u.finished) $("up-log").prepend(h("li", null, `${seriesName(u.finished.series)} → ${u.finished.fileId.slice(0, 6)}….bin · ${formatBytes(ciphertextSize(u.finished))} · ${plural(u.finished.records, "record")}`));
    });
    $("up-tech").textContent = `Encrypted ${plural(packed.length, "series", "series")} · ${totalRecords} records uploaded · making the link`;
    const studyIds = owner.entry.filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => e.resource.id);
    const { bundle, allowedFiles } = subsetBundle(owner, studyIds);
    let link = (await api.getShare()).links[0];
    link ??= await api.createLink({ label: job.recipient, passcode: job.passcode, exp: job.exp, longLived: job.longLived, allowedFiles });
    link = await publishLinkBundle(api, job.ownerKey, link.id, bundle);
    const cred = { sid: job.sid, token: job.token, ownerKey: job.ownerKey };
    const shlink = await shlinkFor(link, job.ownerKey, cfg.viewerPrefix);
    const saved = saveShare({ ...cred, title: `${job.title}${job.recipient ? ` · for ${job.recipient}` : ""}`, createdAt: job.startedAt, apiBase: cfg.apiBase });
    clearJob();
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

/** Rebuilds the series plan of a saved job from its owner Bundle and the re-opened source. */
function planFromOwner(owner: any, c: Collection): PackedSeries[] {
  const byUid = new Map<string, { inst: any; study: StudyModel; series: SeriesModel }>();
  for (const st of c.list()) for (const se of st.series) for (const inst of se.instances) byUid.set(inst.h.sopInstanceUid, { inst, study: st, series: se });
  const idx = parseStudyIndex(owner);
  const out: PackedSeries[] = [];
  for (const st of idx.studies) {
    for (const se of st.series) {
      const instances = se.instances.map((i) => {
        const hit = byUid.get(i.uid);
        if (!hit) throw new Error("Some of the files are not the ones this upload started with.");
        if (hit.inst.src.size !== i.length) throw new Error("Some of the files differ from the ones this upload started with.");
        return hit.inst;
      });
      const first = byUid.get(se.instances[0].uid)!;
      out.push({
        study: first.study,
        series: { ...first.series, instances },
        fileId: se.fileId,
        key: se.key,
        plaintextLength: se.plaintextLength,
        records: se.recordCount,
      });
    }
  }
  return out;
}

async function resumeJob(job: UploadJob, files?: File[]) {
  const api = new ShareApi(job.apiBase, { sid: job.sid, token: job.token });
  show(4);
  setUploadError(null);
  $("up-tech").textContent = "Continuing the upload";
  try {
    const owner = await readOwnerBundle(api, job.ownerKey);
    const c = new Collection();
    const st = await openStager(job.source.stage);
    const on = () => {};
    if (job.source.kind === "files") await loadFiles(files ?? [], c, st, on);
    else if (job.source.kind === "portal") {
      for (const [k, src] of (await st.list()).entries()) await c.add(`staged/${k}`, src);
      c.finish();
    } else await loadLink(await openShare(job.source.link!, { recipient: "Share page (re-share)" }), c, on);
    if (job.addOffsetTables) await addOffsetTables(c.list().flatMap((x) => x.series));
    await runUpload({ job, api, owner, packed: planFromOwner(owner, c) });
  } catch (x) {
    pending = null;
    uploadFailed(x);
  }
}

function renderResume(job: UploadJob) {
  $("resume-title").textContent = job.title;
  const needFiles = job.source.kind === "files";
  $("resume-text").textContent = needFiles
    ? `Choose the same ${job.source.files && job.source.files.length > 1 ? "files or folder" : "file"} again to continue. What reached the server is kept.`
    : "What reached the server is kept. Continue to send the rest.";
  $("resume-continue").textContent = needFiles ? "Choose the files" : "Continue";
  $("resume").classList.remove("hidden");
}
$("resume-continue").addEventListener("click", () => {
  const job = loadJob();
  if (!job) return;
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
};
