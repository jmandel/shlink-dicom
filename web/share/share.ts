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
  Collection, encodingSummary, plainStudyTitle, seriesName, studyCounts, studyDisplayDate, studyModalities, type StudyModel,
} from "./lib/ingest";
import { buildBundle, encryptSeries, planSeriesFiles, subsetBundle, type PackedSeries } from "./lib/pack";
import { ADD_OFFSET_TABLES_DEFAULT, addOffsetTables, lacksOffsetTable } from "./lib/offset-tables";
import {
  ApiError, ShareApi, manageUrl, publishLinkBundle, saveShare, savedShares, shlinkFor, type LinkResource,
} from "./lib/api";
import { callbackUrl, defaultPortal, finishPortalLaunch, loadFiles, loadLink, loadPortal, startPortalLaunch, type Progress } from "./lib/sources";
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
  { id: "sample", icon: ICONS.sample, title: "Try with sample imaging", sub: "A brain MRI and wrist X-rays, published by their owner" },
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
  if (id === "sample") return runLoad("Opening the sample", async (c, on, sig) => {
    const samples = await fetchSampleLinks(cfg);
    const pub = samples.find((s) => !s.passcodeHint && s.shlink);
    if (!pub) throw new Error("The sample isn't available from this server right now.");
    const share = await openShare(pub.shlink, { recipient: "Share page (sample)" });
    await loadLink(share, c, on, sig);
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
  runLoad("Reading your imaging", (c, on, sig) => loadFiles(files, c, on, sig));
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
  runLoad("Downloading from the portal", (c, on, sig) => loadPortal(sess, c, on, sig));
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
    runLoad("Downloading from the link", (c, on, sig) => loadLink(share, c, on, sig));
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
type Loader = (c: Collection, on: (c: Collection, p: Progress) => void, signal: AbortSignal) => Promise<void>;

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
    await fn(col, on, ctl.signal);
    if (ctl.signal.aborted) return;
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
  const lacking = studies.some((st) => st.series.some((se) => se.instances.some(lacksOffsetTable)));
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
    st.reports.length
      ? h("p", { class: "report-line" }, `Report included: ${st.reports.map((r) => r.code?.text ?? r.code?.coding?.[0]?.display ?? "imaging report").join(", ")}`)
      : null,
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

function updateTotal() {
  const inc = col.list().filter((s) => s.include);
  const bytes = inc.reduce((a, s) => a + studyCounts(s).bytes, 0);
  $<HTMLButtonElement>("rv-next").disabled = !inc.length;
  $("rv-total").textContent = inc.length ? `Sharing ${plural(inc.length, "study", "studies")} · ${formatBytes(bytes)}` : "Include at least one study to continue.";
}

async function drawThumbs(studies: StudyModel[], gen: number) {
  let pool;
  try {
    pool = await getDecoderPool();
  } catch {
    return;
  }
  const jobs: Promise<void>[] = [];
  for (const st of studies) {
    for (const se of st.series) {
      const inst = se.instances[Math.floor(se.instances.length / 2)];
      const canvas = document.querySelector<HTMLCanvasElement>(`canvas[data-uid="${CSS.escape(se.uid)}"]`);
      if (!canvas || !inst) continue;
      jobs.push(
        pool
          .decode(inst.bytes, { copy: true, scale: 2, priority: 2 })
          .then((img) => {
            if (gen !== thumbGen) return;
            drawThumbnail(canvas, img);
            canvas.classList.add("drawn");
          })
          .catch(() => canvas.classList.add("failed")),
      );
    }
  }
  await Promise.all(jobs);
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
  $("up-title").textContent = msg ? "The upload did not finish" : "Encrypting and uploading";
}
$("up-retry").addEventListener("click", () => upload());

async function upload() {
  show(4);
  setUploadError(null);
  const form = $("who-form");
  const recipient = $<HTMLInputElement>("in-recipient").value.trim() || null;
  const passcode = $<HTMLInputElement>("in-pass").value;
  const allowUpdates = $<HTMLInputElement>("in-updates").checked;
  const exp = expiryFrom(form, "expiry");
  const studies = col.list().filter((s) => s.include);
  if (!$("rv-offsets-row").classList.contains("hidden") && $<HTMLInputElement>("rv-offsets").checked) {
    await addOffsetTables(studies.flatMap((s) => s.series), (done, total) => {
      $("up-tech").textContent = `Adding frame offset tables: ${done} of ${plural(total, "file")}`;
    });
  }
  const packed = planSeriesFiles(studies);
  const totalCt = packed.reduce((a, p) => a + p.plaintextLength + 16 * p.records, 0);
  const totalRecords = packed.reduce((a, p) => a + p.records, 0);
  let encrypted = 0, doneBytes = 0, doneRecords = 0, curBytes = 0;
  const log = $("up-log");
  log.replaceChildren();
  const paint = () => {
    const up = doneBytes + curBytes;
    $<HTMLElement>("up-bar").style.width = `${((up / totalCt) * 100).toFixed(1)}%`;
    $("up-main").textContent = `Uploaded ${formatBytes(up)} of ${formatBytes(totalCt)}`;
    const recs = Math.min(totalRecords, doneRecords + Math.floor(curBytes / 65536));
    $("up-tech").textContent = `Encrypting ${plural(packed.length, "series", "series")} on this device: ${encrypted} done · ${recs} of ${totalRecords} records uploaded`;
  };
  paint();
  const ownerKey = randomKeyB64();
  let api: ShareApi | null = null;
  try {
    const anon = new ShareApi(cfg.apiBase);
    const created = await anon.createShare(exp ?? Math.floor(Date.now() / 1000) + SERVER_MAX_DAYS * 86400);
    api = new ShareApi(cfg.apiBase, { sid: created.share.id, token: created.controlToken });
    // Encrypt the next series while the current one uploads.
    const enc = (p: PackedSeries) => encryptSeries(p).then((ct) => {
      encrypted++;
      paint();
      return ct;
    });
    let next = packed.length ? enc(packed[0]) : null;
    for (let i = 0; i < packed.length; i++) {
      const p = packed[i];
      const ct = await next!;
      next = i + 1 < packed.length ? enc(packed[i + 1]) : null;
      await api.putFile(p.fileId, ct, (loaded) => {
        curBytes = loaded;
        paint();
      });
      curBytes = 0;
      doneBytes += ct.length;
      doneRecords += p.records;
      log.prepend(h("li", null, `${seriesName(p.series)} → ${p.fileId.slice(0, 6)}….bin · ${formatBytes(ct.length)} · ${plural(p.records, "record")}`));
      paint();
    }
    $("up-tech").textContent = `Encrypted ${plural(packed.length, "series", "series")} · ${totalRecords} records uploaded · creating the link`;
    const owner = buildBundle(col, packed);
    await api.putOwner(await encryptJwe(utf8(JSON.stringify(owner)), ownerKey));
    const studyIds = owner.entry.filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => e.resource.id);
    const { bundle, allowedFiles } = subsetBundle(owner, studyIds);
    let link = await api.createLink({ label: recipient, passcode, exp, longLived: allowUpdates, allowedFiles });
    link = await publishLinkBundle(api, ownerKey, link.id, bundle);
    const cred = { sid: created.share.id, token: created.controlToken, ownerKey };
    const shlink = await shlinkFor(link, ownerKey, cfg.viewerPrefix);
    const mUrl = manageUrl(manageBase(), cred);
    const titles = studies.map((s) => plainStudyTitle(s.description, studyModalities(s)));
    const saved = saveShare({ ...cred, title: `${titles.join(", ")}${recipient ? ` · for ${recipient}` : ""}`, createdAt: Math.floor(Date.now() / 1000), apiBase: cfg.apiBase });
    result = { shlink, manage: mUrl, link, studies: studies.length };
    renderDone(saved, !!passcode, recipient);
    show(5);
  } catch (x) {
    console.warn(x);
    if (api) api.deleteShare().catch(() => {});
    const e = x as ApiError;
    setUploadError(
      e.status === 413
        ? "The server refused the files: this share is larger than it accepts."
        : e.status === 429
          ? "The server has too many shares right now. Try again later."
          : `${e.message || "Something went wrong."} Nothing was kept on the server.`,
    );
  }
}

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
