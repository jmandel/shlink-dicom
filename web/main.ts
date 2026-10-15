import initWasm, { WasmShlSession, decode_shlink_wasm } from "../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js";
import { ShlResolver, PasscodeRequiredError } from "./shl-resolver";
import { SeriesRecordTracker } from "./record-map";
import { ApiClient, type DemoShareInfo } from "./api-client";
import { formatCornerstoneImageId, createShlCornerstoneImageLoader } from "./cornerstone-bridge";
import { renderExplainerView } from "./view-explainer";
import { exportCurrentSlice, exportCurrentSeries, exportCurrentStudy } from "./view-export";
import {
  renderStudySubsetPicker,
  renderSandboxLinks,
  syncSandboxLinkStates,
  mintStudyLinkOnSandbox,
  packUploadedFilesToSandbox,
  type SandboxState,
  type StudyIndex,
  type SeriesSummary,
} from "./view-sharer";

const api = new ApiClient();
const tracker = new SeriesRecordTracker();
let wasmReady = false;
let resolver: ShlResolver | null = null;
let session: WasmShlSession | null = null;
let studyIndex: StudyIndex | null = null;
let ownerStudyIndex: StudyIndex | null = null;
let activeStudyIdx = 0;
let activeSeriesIdx = 0;
let activeInstanceIdx = 0;
let overrideWc: number | undefined;
let overrideWw: number | undefined;
let simulateTamper = false;
let isDemoShare = true;
let openedFromHashLink = false;
let activeView: "viewer" | "explainer" | "sharer" = "viewer";
let introDismissed = false;
try {
  introDismissed = globalThis.localStorage?.getItem("shl_intro_dismissed") === "1";
} catch {}
let loadGeneration = 0;

function syncIntroBandVisibility() {
  const showIntro = activeView === "viewer" && !introDismissed && !openedFromHashLink;
  document.getElementById("intro-band")?.classList.toggle("hidden", !showIntro);
  document.querySelector(".nav-right")?.classList.toggle("hidden", showIntro);
  const showRecipient = activeView === "viewer" && openedFromHashLink;
  document.getElementById("recipient-band")?.classList.toggle("hidden", !showRecipient);
}

function updateRecipientBand() {
  const el = document.getElementById("recipient-band-text");
  if (!el || !resolver) return;
  const label = resolver.payload.label || "Medical Imaging Share";
  const n = studyIndex?.studies.length;
  const countPart = n !== undefined ? ` · ${n} ${n === 1 ? "study" : "studies"}` : "";
  el.textContent = `Shared with you: ${label}${countPart}`;
  syncIntroBandVisibility();
}

function showViewerFailure(reason: string) {
  document.getElementById("viewer-sidebar")?.classList.add("hidden");
  document.getElementById("viewer-main-col")?.classList.add("hidden");
  document.getElementById("passcode-bar")?.classList.add("hidden");
  document.getElementById("viewer-error-panel")?.classList.remove("hidden");
  const titleEl = document.getElementById("viewer-error-title");
  if (titleEl) titleEl.textContent = reason;
  const b = document.getElementById("status-banner")!;
  b.textContent = reason;
}

function clearViewerFailure() {
  document.getElementById("viewer-error-panel")?.classList.add("hidden");
  document.getElementById("viewer-sidebar")?.classList.remove("hidden");
  document.getElementById("viewer-main-col")?.classList.remove("hidden");
}

function formatDicomPersonName(raw?: string): string {
  if (!raw) return "Anonymous";
  const parts = raw
    .split("^")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return "Anonymous";
  const tc = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  if (parts.length >= 2) {
    return `${parts.slice(1).map(tc).join(" ")} ${tc(parts[0])}`;
  }
  return tc(parts[0]);
}

function getPatientDisplay(idx: StudyIndex | null): { name: string; dob: string } {
  if (!idx) return { name: "—", dob: "" };
  const showReal = new URLSearchParams(globalThis.location.search).get("realName") === "1";
  if (isDemoShare && !showReal) {
    return { name: "Demo Patient", dob: "" };
  }
  return {
    name: formatDicomPersonName(idx.patientName),
    dob: idx.patientBirthDate ? `DOB ${idx.patientBirthDate}` : "",
  };
}

let totalDownloadedBytes = 0;
let totalCiphertextBytes = 0;
let totalRecordsCount = 0;
let demos: DemoShareInfo[] = [];
let sandbox: SandboxState | null = null;

async function boot() {
  await initWasm();
  wasmReady = true;
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw-dicomweb.js").catch(() => {});
  }
  wireEvents();

  try {
    demos = await api.getDemoShares();
    renderDemoButtons();
  } catch (e) {
    console.warn("Could not load demos:", e);
  }
  syncIntroBandVisibility();

  if (globalThis.location.hash.includes("shlink:/")) {
    openedFromHashLink = true;
    syncIntroBandVisibility();
    await loadFromShlink(globalThis.location.hash, "Interactive Viewer");
  } else if (demos.length > 0) {
    await loadFromShlink(demos[0].shlinkUri, "Interactive Viewer");
  }
}

function switchView(view: "viewer" | "explainer" | "sharer") {
  activeView = view;
  for (const v of ["viewer", "explainer", "sharer"] as const) {
    document.getElementById(`view-${v}`)?.classList.toggle("hidden", v !== view);
    document.getElementById(`tab-${v}`)?.classList.toggle("active", v === view);
  }
  syncIntroBandVisibility();
  if (view === "explainer") refreshExplainer();
  if (view === "sharer") {
    renderStudySubsetPicker(ownerStudyIndex ?? studyIndex);
    if (!sandbox && demos.length > 0) void cloneDemoToSandbox();
    else if (sandbox) {
      void syncSandboxLinkStates(api, sandbox).then(refreshSandboxUI);
      void loadAccessHistory(sandbox.sid, sandbox.controlToken);
    }
  }
}

function refreshExplainer() {
  if (!studyIndex || !resolver) return;
  const st = studyIndex.studies[activeStudyIdx];
  const ser = st?.series[activeSeriesIdx];
  renderExplainerView({
    shlUri: resolver.shlinkUri,
    shlPayload: resolver.payload,
    baseUrl: resolver.getBaseUrl(),
    study: st,
    series: ser,
    instanceIdx: activeInstanceIdx,
    tracker,
  });
}

function renderDemoButtons() {
  const container = document.getElementById("demo-buttons")!;
  const introContainer = document.getElementById("intro-demo-buttons");
  const demoSelect = document.getElementById("demo-select") as HTMLSelectElement | null;
  container.innerHTML = "";
  if (introContainer) introContainer.innerHTML = "";
  if (demoSelect) {
    demoSelect.innerHTML = `<option value="" disabled selected>Open demo…</option>`;
  }

  demos.forEach((d, idx) => {
    const openDemo = () => {
      isDemoShare = true;
      openedFromHashLink = false;
      syncIntroBandVisibility();
      document.getElementById("passcode-bar")!.classList.add("hidden");
      void loadFromShlink(d.shlinkUri, "Interactive Viewer", undefined, d.passcodeHint ?? undefined);
    };

    const btn = document.createElement("button");
    btn.className = "btn btn-sm";
    btn.textContent = d.title;
    btn.addEventListener("click", openDemo);
    container.appendChild(btn);

    if (introContainer) {
      const ibtn = document.createElement("button");
      ibtn.className = "btn btn-sm btn-primary";
      ibtn.textContent = d.title;
      ibtn.addEventListener("click", openDemo);
      introContainer.appendChild(ibtn);
    }

    if (demoSelect) {
      const opt = document.createElement("option");
      opt.value = String(idx);
      opt.textContent = d.title;
      demoSelect.appendChild(opt);
    }
  });
}

async function loadFromShlink(uri: string, recipient: string, passcode?: string, passcodeHint?: string) {
  if (!wasmReady) return;
  hideBanner();
  try {
    const payload = JSON.parse(decode_shlink_wasm(uri));
    resolver = new ShlResolver(uri, recipient, passcode);
    if (openedFromHashLink) updateRecipientBand();
    if ((payload.flag ?? "").includes("P") && passcode === undefined) {
      if (!studyIndex) {
        document.getElementById("viewer-sidebar")?.classList.add("hidden");
        document.getElementById("viewer-main-col")?.classList.add("hidden");
      }
      const hintSuffix = passcodeHint ? ` (Hint: ${passcodeHint})` : "";
      document.getElementById("passcode-message")!.textContent = `Passcode required${hintSuffix}:`;
      document.getElementById("passcode-bar")!.classList.remove("hidden");
      const inputEl = document.getElementById("input-passcode") as HTMLInputElement;
      inputEl.value = passcodeHint ?? "";
      inputEl.type = passcodeHint ? "text" : "password";
      inputEl.focus();
      return;
    }

    const bundleJwe = await resolver.fetchBundleJwe(false);
    if (!bundleJwe) return;

    clearViewerFailure();
    session = new WasmShlSession(uri, bundleJwe);
    studyIndex = JSON.parse(session.index_json());
    if (!ownerStudyIndex) ownerStudyIndex = studyIndex;
    document.getElementById("passcode-bar")!.classList.add("hidden");
    if (openedFromHashLink) updateRecipientBand();

    totalDownloadedBytes = 0;
    totalCiphertextBytes = 0;
    totalRecordsCount = 0;
    for (const st of studyIndex!.studies) {
      for (const s of st.series) {
        tracker.initSeries(s.fileId, s.recordCount);
        totalCiphertextBytes += s.ciphertextLength;
        totalRecordsCount += s.recordCount;
      }
    }

    const pDisp = getPatientDisplay(studyIndex);
    document.getElementById("patient-name")!.textContent = pDisp.name;
    document.getElementById("patient-dob")!.textContent = pDisp.dob;

    renderStudyPicker();
    renderStudySubsetPicker(ownerStudyIndex ?? studyIndex);
    await selectStudy(0);
  } catch (e: any) {
    if (e instanceof PasscodeRequiredError) {
      if (e.remainingAttempts !== undefined && e.remainingAttempts <= 0) {
        showViewerFailure("This link was revoked or has expired.");
      } else {
        document.getElementById("passcode-bar")!.classList.remove("hidden");
        const remMsg = e.remainingAttempts !== undefined ? ` (${e.remainingAttempts} attempts remaining)` : "";
        document.getElementById("passcode-message")!.textContent = `Incorrect passcode${remMsg}:`;
      }
      return;
    }
    showViewerFailure(e.message || "This link was revoked or has expired.");
  }
}

function renderStudyPicker() {
  const select = document.getElementById("study-select") as HTMLSelectElement;
  const tabs = document.getElementById("study-tabs")!;
  select.innerHTML = "";
  tabs.innerHTML = "";
  if (!studyIndex) return;

  studyIndex.studies.forEach((st, idx) => {
    const totalSlices = st.series.reduce((a, s) => a + s.instances.length, 0);
    const title = st.description ?? `Study ${idx + 1}`;
    const opt = document.createElement("option");
    opt.value = String(idx);
    opt.textContent = `${title} (${st.series.length} series, ${totalSlices} slices)`;
    select.appendChild(opt);

    const tab = document.createElement("button");
    tab.className = `study-tab ${idx === activeStudyIdx ? "active" : ""}`;
    tab.textContent = title;
    tab.addEventListener("click", () => void selectStudy(idx));
    tabs.appendChild(tab);
  });
  select.value = String(activeStudyIdx);
}

async function selectStudy(studyIdx: number) {
  if (!studyIndex || !session) return;
  activeStudyIdx = studyIdx;
  const select = document.getElementById("study-select") as HTMLSelectElement;
  if (select) select.value = String(studyIdx);

  const study = studyIndex.studies[studyIdx];
  const totalSlices = study.series.reduce((a, s) => a + s.instances.length, 0);
  const metaBadge = document.getElementById("study-meta-badge");
  if (metaBadge) metaBadge.textContent = `${study.series.length} series · ${totalSlices} slices`;
  document.getElementById("series-count-badge")!.textContent = `${study.series.length} series`;

  const list = document.getElementById("contact-sheet-list")!;
  list.innerHTML = "";
  list.scrollTop = 0;
  list.scrollLeft = 0;
  // Start on the first series in the study so the series list stays at the top
  const initialSeriesIdx = 0;
  study.series.forEach((ser, sIdx) => {
    const card = document.createElement("div");
    card.className = `series-card ${sIdx === initialSeriesIdx ? "active" : ""}`;
    card.id = `series-card-${sIdx}`;
    card.innerHTML = `
      <canvas class="series-thumb" id="thumb-${sIdx}" width="64" height="64"></canvas>
      <div class="series-meta">
        <div class="series-desc">${ser.description ?? ser.modality ?? `Series ${sIdx + 1}`}</div>
        <div class="series-sub">${ser.modality ?? "OT"} · ${ser.instances.length} slice${ser.instances.length === 1 ? "" : "s"} · ${(ser.ciphertextLength / 1024).toFixed(0)} KB</div>
      </div>
    `;
    card.addEventListener("click", () => void selectSeries(sIdx));
    list.appendChild(card);
  });

  const gen = ++loadGeneration;
  await selectSeries(initialSeriesIdx);

  for (let sIdx = 0; sIdx < study.series.length; sIdx++) {
    if (gen !== loadGeneration) return;
    const ser = study.series[sIdx];
    const midIdx = Math.floor(ser.instances.length / 2);
    try {
      await ensureInstanceFetched(studyIdx, sIdx, ser, midIdx);
      if (gen !== loadGeneration) return;
      const rendered = session.render_instance_rgba(studyIdx, sIdx, midIdx, null, null);
      const thumbCanvas = document.getElementById(`thumb-${sIdx}`) as HTMLCanvasElement | null;
      if (thumbCanvas) drawRgbaToCanvas(thumbCanvas, rendered.width, rendered.height, rendered.rgba_bytes());
      await new Promise((r) => setTimeout(r, 0));
    } catch {}
  }
}

async function selectSeries(seriesIdx: number) {
  if (!studyIndex || !session) return;
  activeSeriesIdx = seriesIdx;
  const study = studyIndex.studies[activeStudyIdx];
  const ser = study.series[seriesIdx];

  document.querySelectorAll(".series-card").forEach((el, i) => el.classList.toggle("active", i === seriesIdx));
  document.getElementById("active-series-title")!.textContent = `${ser.description ?? ser.modality ?? "Series"} (${ser.instances.length} slices)`;

  const slider = document.getElementById("slice-slider") as HTMLInputElement;
  slider.max = String(Math.max(0, ser.instances.length - 1));
  slider.disabled = ser.instances.length <= 1;
  (document.getElementById("btn-stream-series") as HTMLButtonElement).disabled = false;

  overrideWc = undefined;
  overrideWw = undefined;
  const midIdx = Math.floor(ser.instances.length / 2);
  slider.value = String(midIdx);
  await renderActiveSlice(midIdx);
}

async function ensureInstanceFetched(studyIdx: number, seriesIdx: number, ser: SeriesSummary, instIdx: number) {
  if (!session || !resolver) return;
  if (session.has_instance(studyIdx, seriesIdx, instIdx) && !simulateTamper) return;

  const plan = JSON.parse(session.plan_instance_range(studyIdx, seriesIdx, instIdx)) as {
    fileId: string;
    firstRecord: number;
    lastRecord: number;
    ciphertextStart: number;
    ciphertextEnd: number;
  };

  tracker.setRangeState(ser.fileId, plan.firstRecord, plan.lastRecord, "fetching");
  updateRecordBar();

  const { bytes } = await resolver.fetchSeriesRange(ser.fileId, plan.ciphertextStart, plan.ciphertextEnd);
  totalDownloadedBytes += bytes.byteLength;

  if (simulateTamper && bytes.length > 10) {
    bytes[10] ^= 0xff;
  }

  try {
    session.ingest_ciphertext_range(ser.fileId, plan.firstRecord, bytes);
    tracker.setRangeState(ser.fileId, plan.firstRecord, plan.lastRecord, "verified");
    updateTelemetry();
    updateRecordBar();
  } catch (e: any) {
    tracker.setRangeState(ser.fileId, plan.firstRecord, plan.lastRecord, "tampered");
    updateRecordBar();
    throw new Error(`Integrity Failure on ${ser.fileId}.bin record #${plan.firstRecord}: ${e.message || e}`);
  }
}

async function ensureFullSeriesFetched(ser: SeriesSummary) {
  if (!session || !resolver) return;
  tracker.setRangeState(ser.fileId, 0, ser.recordCount - 1, "fetching");
  updateRecordBar();
  const { bytes } = await resolver.fetchSeriesRange(ser.fileId, 0, ser.ciphertextLength);
  totalDownloadedBytes += bytes.byteLength;
  session.ingest_ciphertext_range(ser.fileId, 0, bytes);
  tracker.setRangeState(ser.fileId, 0, ser.recordCount - 1, "verified");
  updateTelemetry();
  updateRecordBar();
}

async function renderActiveSlice(instIdx: number) {
  if (!studyIndex || !session) return;
  activeInstanceIdx = instIdx;
  const study = studyIndex.studies[activeStudyIdx];
  const ser = study.series[activeSeriesIdx];
  const inst = ser.instances[instIdx];

  try {
    await ensureInstanceFetched(activeStudyIdx, activeSeriesIdx, ser, instIdx);
    const rendered = session.render_instance_rgba(
      activeStudyIdx,
      activeSeriesIdx,
      instIdx,
      overrideWc ?? null,
      overrideWw ?? null,
    );
    const mainCanvas = document.getElementById("dicom-canvas") as HTMLCanvasElement;
    drawRgbaToCanvas(mainCanvas, rendered.width, rendered.height, rendered.rgba_bytes());

    const wc = Math.round(rendered.window_center);
    const ww = Math.round(rendered.window_width);
    const wcSlider = document.getElementById("wc-slider") as HTMLInputElement;
    const wwSlider = document.getElementById("ww-slider") as HTMLInputElement;
    wcSlider.disabled = false;
    wwSlider.disabled = false;
    wcSlider.min = String(Math.floor(rendered.min_pixel));
    wcSlider.max = String(Math.ceil(rendered.max_pixel));
    wcSlider.value = String(wc);
    wwSlider.max = String(Math.max(256, Math.ceil((rendered.max_pixel - rendered.min_pixel) * 1.5)));
    wwSlider.value = String(ww);

    const pDisp = getPatientDisplay(studyIndex);
    document.getElementById("active-slice-info")!.textContent = `Slice ${instIdx + 1} / ${ser.instances.length}`;
    document.getElementById("hud-top-left")!.textContent = `${pDisp.name}\n${study.description ?? ""}\n${ser.description ?? ""}`;
    document.getElementById("hud-top-right")!.textContent = `${ser.modality ?? "OT"} · ${rendered.width}×${rendered.height}\nRecord #${Math.floor(inst.offset / 65520)}`;
    document.getElementById("hud-wl-text")!.textContent = `WL: ${wc} / WW: ${ww}`;

    updateRecordBar();
    refreshExplainer();
  } catch (e: any) {
    const msg = e.message || String(e);
    if (msg.includes("revoked or has expired")) {
      showViewerFailure(msg);
    } else {
      showBanner(msg, true);
    }
  }
}

function drawRgbaToCanvas(canvas: HTMLCanvasElement, width: number, height: number, rgba: Uint8Array) {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d")!;
  const imgData = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height);
  ctx.putImageData(imgData, 0, 0);
}

function updateRecordBar() {
  if (!studyIndex) return;
  const ser = studyIndex.studies[activeStudyIdx]?.series[activeSeriesIdx];
  if (!ser) return;
  const inst = ser.instances[activeInstanceIdx];
  const firstRec = inst ? Math.floor(inst.offset / 65520) : undefined;
  const lastRec = inst ? Math.floor((inst.offset + inst.length - 1) / 65520) : undefined;
  const vCanvas = document.getElementById("viewer-record-canvas") as HTMLCanvasElement | null;
  if (vCanvas) tracker.drawCanvasBar(vCanvas, ser.fileId, firstRec, lastRec);
}

function updateTelemetry() {
  if (!studyIndex) return;
  let verifiedRecords = 0;
  for (const st of studyIndex.studies) {
    for (const s of st.series) verifiedRecords += tracker.verifiedCount(s.fileId);
  }
  const mbDown = (totalDownloadedBytes / (1024 * 1024)).toFixed(2);
  const mbTotal = (totalCiphertextBytes / (1024 * 1024)).toFixed(2);
  const pct = totalCiphertextBytes > 0 ? ((totalDownloadedBytes / totalCiphertextBytes) * 100).toFixed(1) : "0.0";
  document.getElementById("stat-bytes")!.textContent = `${mbDown} MB / ${mbTotal} MB (${pct}%)`;
  document.getElementById("stat-records")!.textContent = `${verifiedRecords} / ${totalRecordsCount}`;
}

async function cloneDemoToSandbox() {
  if (demos.length === 0 || !studyIndex) return;
  const statusEl = document.getElementById("sandbox-status")!;
  statusEl.textContent = "Cloning demo share into your controllable sandbox…";
  try {
    const cloned = await api.cloneShare(demos[0].id);
    const ownerBundleJson = session ? session.bundle_json() : "{}";
    if (session) {
      ownerStudyIndex = JSON.parse(WasmShlSession.from_bundle_json(ownerBundleJson).index_json());
    }
    const baseIndex = ownerStudyIndex ?? studyIndex;
    sandbox = { sid: cloned.share.id, controlToken: cloned.controlToken, ownerBundleJson, links: [] };
    await mintStudyLinkOnSandbox(api, sandbox, baseIndex, "Full Referral Link", undefined, true);
    const nStudies = baseIndex.studies.length;
    statusEl.textContent = `Your sandbox: ${nStudies} ${nStudies === 1 ? "study" : "studies"}`;
    statusEl.title = `Share ID: ${sandbox.sid}`;
    renderStudySubsetPicker(baseIndex);
    refreshSandboxUI();
    connectHostSse(sandbox.sid, sandbox.controlToken);
  } catch (e: any) {
    showBanner(`Sandbox clone failed: ${e.message}`, true);
  }
}

function refreshSandboxUI() {
  renderSandboxLinks(
    api,
    sandbox,
    (uri) => {
      switchView("viewer");
      void loadFromShlink(uri, "Sandbox Viewer");
    },
    refreshSandboxUI,
    showBanner,
  );
}

function renderEmptySsePlaceholder() {
  const logEl = document.getElementById("host-sse-log")!;
  logEl.innerHTML = `
    <div class="empty-state">
      <p>Open a link in another tab to see each request the host serves.</p>
      <button id="btn-sse-open-shortcut" class="btn btn-sm btn-primary">Open in Viewer ↗</button>
    </div>
  `;
  document.getElementById("btn-sse-open-shortcut")?.addEventListener("click", () => {
    const first = sandbox?.links.find((l) => !l.revoked);
    if (first) {
      globalThis.open(first.shlinkUri, "_blank", "noopener");
    }
  });
}

function appendSseEventRow(ev: { ts: number; lid: string | null; method: string; path: string; status: number; range: string | null; bytes: number; recipient: string | null }) {
  const logEl = document.getElementById("host-sse-log")!;
  logEl.querySelector(".empty-state")?.remove();
  const matchedLink = ev.lid ? sandbox?.links.find((l) => l.lid === ev.lid) : undefined;
  const linkTag = matchedLink ? `[${matchedLink.label}] ` : ev.lid ? `[${ev.lid.slice(0, 8)}…] ` : "";
  const item = document.createElement("div");
  item.className = "sse-row";
  item.textContent = `[${new Date(ev.ts * 1000).toLocaleTimeString()}] ${linkTag}${ev.method} ${ev.path} status=${ev.status} ${ev.range ? `Range: ${ev.range}` : ""} (${ev.bytes} B) ${ev.recipient ? `recipient="${ev.recipient}"` : ""}`;
  logEl.prepend(item);
  if (ev.status === 401 && sandbox) {
    void syncSandboxLinkStates(api, sandbox).then(refreshSandboxUI);
  }
}

async function loadAccessHistory(sid: string, token: string) {
  const events = await api.getAccessHistory(sid, token);
  const logEl = document.getElementById("host-sse-log")!;
  logEl.innerHTML = "";
  if (events.length === 0) {
    renderEmptySsePlaceholder();
    return;
  }
  for (const ev of events) appendSseEventRow(ev);
}

function connectHostSse(sid: string, token: string) {
  sandbox?.sseAbort?.abort();
  renderEmptySsePlaceholder();
  void loadAccessHistory(sid, token);
  const abort = api.subscribeEvents(sid, token, (ev) => {
    appendSseEventRow(ev);
  });
  if (sandbox) sandbox.sseAbort = abort;
}

function wireEvents() {
  for (const v of ["viewer", "explainer", "sharer"] as const) {
    document.getElementById(`tab-${v}`)!.addEventListener("click", () => switchView(v));
  }
  document.getElementById("btn-jump-explainer")!.addEventListener("click", () => switchView("explainer"));
  document.getElementById("btn-back-to-viewer")!.addEventListener("click", () => switchView("viewer"));

  document.getElementById("study-select")!.addEventListener("change", (e) => {
    void selectStudy(Number((e.target as HTMLSelectElement).value));
  });

  document.getElementById("demo-select")?.addEventListener("change", (e) => {
    const idx = Number((e.target as HTMLSelectElement).value);
    const d = demos[idx];
    if (d) {
      isDemoShare = true;
      openedFromHashLink = false;
      syncIntroBandVisibility();
      document.getElementById("passcode-bar")!.classList.add("hidden");
      void loadFromShlink(d.shlinkUri, "Interactive Viewer", undefined, d.passcodeHint ?? undefined);
    }
  });

  document.getElementById("btn-dismiss-intro")?.addEventListener("click", () => {
    introDismissed = true;
    try {
      globalThis.localStorage?.setItem("shl_intro_dismissed", "1");
    } catch {}
    syncIntroBandVisibility();
  });
  document.getElementById("btn-error-try-demo")?.addEventListener("click", () => {
    if (demos.length > 0) {
      isDemoShare = true;
      openedFromHashLink = false;
      syncIntroBandVisibility();
      void loadFromShlink(demos[0].shlinkUri, "Interactive Viewer");
    }
  });
  document.getElementById("btn-error-paste-link")?.addEventListener("click", () => {
    document.getElementById("custom-shl-bar")!.classList.remove("hidden");
    (document.getElementById("input-shl-uri") as HTMLInputElement).focus();
  });
  document.getElementById("btn-intro-paste")?.addEventListener("click", () => {
    document.getElementById("custom-shl-bar")!.classList.remove("hidden");
    (document.getElementById("input-shl-uri") as HTMLInputElement).focus();
  });

  const wireRecordHover = (canvasId: string, outId: string) => {
    const c = document.getElementById(canvasId) as HTMLCanvasElement | null;
    const out = document.getElementById(outId);
    if (!c || !out) return;
    c.addEventListener("mousemove", (e) => {
      const ser = studyIndex?.studies[activeStudyIdx]?.series[activeSeriesIdx];
      if (!ser || ser.recordCount === 0) return;
      const rect = c.getBoundingClientRect();
      const idx = Math.max(0, Math.min(ser.recordCount - 1, Math.floor(((e.clientX - rect.left) / rect.width) * ser.recordCount)));
      const b0 = idx * 65536;
      const b1 = Math.min((idx + 1) * 65536, ser.ciphertextLength) - 1;
      const st = tracker.getSeriesStates(ser.fileId)[idx] ?? "unfetched";
      out.textContent = `Record #${idx} · bytes ${b0.toLocaleString()}–${b1.toLocaleString()} · nonce 0x${idx.toString(16).padStart(24, "0")} · ${st}`;
    });
  };
  wireRecordHover("viewer-record-canvas", "record-hover-readout");
  wireRecordHover("explainer-record-canvas", "exp-record-hover");

  document.getElementById("btn-custom-shl")!.addEventListener("click", () => {
    document.getElementById("custom-shl-bar")!.classList.toggle("hidden");
  });
  document.getElementById("btn-load-shl-uri")!.addEventListener("click", () => {
    const val = (document.getElementById("input-shl-uri") as HTMLInputElement).value.trim();
    if (val) {
      isDemoShare = false;
      void loadFromShlink(val, "Custom SHL Viewer");
    }
  });
  document.getElementById("btn-submit-passcode")!.addEventListener("click", () => {
    const code = (document.getElementById("input-passcode") as HTMLInputElement).value;
    if (resolver) void loadFromShlink(resolver.shlinkUri, "Interactive Viewer", code);
  });

  const slider = document.getElementById("slice-slider") as HTMLInputElement;
  slider.addEventListener("input", () => void renderActiveSlice(Number(slider.value)));

  const stage = document.getElementById("canvas-stage")!;
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (!studyIndex) return;
    const ser = studyIndex.studies[activeStudyIdx]?.series[activeSeriesIdx];
    if (!ser || ser.instances.length <= 1) return;
    const delta = e.deltaY > 0 ? 1 : -1;
    const next = Math.max(0, Math.min(ser.instances.length - 1, activeInstanceIdx + delta));
    if (next !== activeInstanceIdx) {
      slider.value = String(next);
      void renderActiveSlice(next);
    }
  });

  let zoomScale = 1;
  let panX = 0;
  let panY = 0;
  const applyCanvasTransform = () => {
    const c = document.getElementById("dicom-canvas") as HTMLCanvasElement | null;
    if (!c) return;
    c.style.transform = zoomScale > 1.01 ? `translate(${panX}px, ${panY}px) scale(${zoomScale})` : "";
  };
  const resetViewTransformAndWl = () => {
    zoomScale = 1;
    panX = 0;
    panY = 0;
    overrideWc = undefined;
    overrideWw = undefined;
    applyCanvasTransform();
    void renderActiveSlice(activeInstanceIdx);
  };

  const pointers = new Map<number, { x: number; y: number; startX: number; startY: number }>();
  let prevPinchDist = 0;
  let prevMidX = 0;
  let prevMidY = 0;
  let sliceCarryPx = 0;
  let longPressMode = false;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTapTime = 0;

  stage.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).tagName === "BUTTON") return;
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
    sliceCarryPx = 0;

    if (e.pointerType !== "mouse" && pointers.size === 1) {
      const now = Date.now();
      if (now - lastTapTime < 280) {
        resetViewTransformAndWl();
        lastTapTime = 0;
        return;
      }
      lastTapTime = now;
      longPressMode = false;
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        if (pointers.size === 1) longPressMode = true;
      }, 380);
    } else if (pointers.size === 2) {
      if (longPressTimer) clearTimeout(longPressTimer);
      const pts = Array.from(pointers.values());
      prevPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      prevMidX = (pts[0].x + pts[1].x) * 0.5;
      prevMidY = (pts[0].y + pts[1].y) * 0.5;
    }
  });

  stage.addEventListener("pointermove", (e) => {
    const pt = pointers.get(e.pointerId);
    if (!pt) return;
    const dx = e.clientX - pt.x;
    const dy = e.clientY - pt.y;
    pt.x = e.clientX;
    pt.y = e.clientY;

    if (Math.hypot(pt.x - pt.startX, pt.y - pt.startY) > 6 && longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }

    const wcSlider = document.getElementById("wc-slider") as HTMLInputElement;
    const wwSlider = document.getElementById("ww-slider") as HTMLInputElement;

    if (e.pointerType === "mouse") {
      overrideWw = Math.max(1, (overrideWw ?? Number(wwSlider.value)) + dx * 4);
      overrideWc = (overrideWc ?? Number(wcSlider.value)) - dy * 4;
      void renderActiveSlice(activeInstanceIdx);
      return;
    }

    if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const midX = (pts[0].x + pts[1].x) * 0.5;
      const midY = (pts[0].y + pts[1].y) * 0.5;
      if (prevPinchDist > 20 && Math.abs(dist - prevPinchDist) > 2.5) {
        zoomScale = Math.max(1, Math.min(5, zoomScale * (dist / prevPinchDist)));
        if (zoomScale <= 1.02) {
          panX = 0;
          panY = 0;
        }
        applyCanvasTransform();
      } else {
        const mdx = midX - prevMidX;
        const mdy = midY - prevMidY;
        overrideWw = Math.max(1, (overrideWw ?? Number(wwSlider.value)) + mdx * 4);
        overrideWc = (overrideWc ?? Number(wcSlider.value)) - mdy * 4;
        void renderActiveSlice(activeInstanceIdx);
      }
      prevPinchDist = dist;
      prevMidX = midX;
      prevMidY = midY;
      return;
    }

    if (pointers.size === 1) {
      if (longPressMode) {
        overrideWw = Math.max(1, (overrideWw ?? Number(wwSlider.value)) + dx * 4);
        overrideWc = (overrideWc ?? Number(wcSlider.value)) - dy * 4;
        void renderActiveSlice(activeInstanceIdx);
      } else if (zoomScale > 1.02) {
        panX += dx;
        panY += dy;
        applyCanvasTransform();
      } else if (Math.abs(dy) >= Math.abs(dx)) {
        const ser = studyIndex?.studies[activeStudyIdx]?.series[activeSeriesIdx];
        if (!ser || ser.instances.length <= 1) return;
        sliceCarryPx += dy;
        const stepPx = 9;
        const steps = Math.trunc(sliceCarryPx / stepPx);
        if (steps !== 0) {
          sliceCarryPx -= steps * stepPx;
          const next = Math.max(0, Math.min(ser.instances.length - 1, activeInstanceIdx + steps));
          if (next !== activeInstanceIdx) {
            slider.value = String(next);
            void renderActiveSlice(next);
          }
        }
      }
    }
  });

  const endPointer = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      longPressMode = false;
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }
  };
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", endPointer);
  stage.addEventListener("dblclick", resetViewTransformAndWl);

  const wcSlider = document.getElementById("wc-slider") as HTMLInputElement;
  const wwSlider = document.getElementById("ww-slider") as HTMLInputElement;
  wcSlider.addEventListener("input", () => {
    overrideWc = Number(wcSlider.value);
    void renderActiveSlice(activeInstanceIdx);
  });
  wwSlider.addEventListener("input", () => {
    overrideWw = Number(wwSlider.value);
    void renderActiveSlice(activeInstanceIdx);
  });
  document.getElementById("btn-reset-wl")!.addEventListener("click", resetViewTransformAndWl);

  document.getElementById("btn-stream-series")!.addEventListener("click", async () => {
    if (!studyIndex) return;
    const ser = studyIndex.studies[activeStudyIdx].series[activeSeriesIdx];
    try {
      await ensureFullSeriesFetched(ser);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("revoked or has expired")) showViewerFailure(msg);
      else showBanner(msg, true);
    }
  });

  const tamperBtn = document.getElementById("btn-simulate-tamper")!;
  tamperBtn.addEventListener("click", () => {
    simulateTamper = !simulateTamper;
    tamperBtn.textContent = `Simulate Bit-Flip: ${simulateTamper ? "ON" : "OFF"}`;
    tamperBtn.classList.toggle("active", simulateTamper);
  });

  document.getElementById("btn-export-slice")!.addEventListener("click", () => {
    if (!session || !studyIndex) return;
    const ser = studyIndex.studies[activeStudyIdx].series[activeSeriesIdx];
    const inst = ser.instances[activeInstanceIdx];
    exportCurrentSlice(session, activeStudyIdx, activeSeriesIdx, activeInstanceIdx, inst.uid);
  });
  document.getElementById("btn-export-series")!.addEventListener("click", async () => {
    if (!session || !studyIndex) return;
    const ser = studyIndex.studies[activeStudyIdx].series[activeSeriesIdx];
    try {
      await exportCurrentSeries(session, activeStudyIdx, activeSeriesIdx, ser, ensureFullSeriesFetched);
    } catch (e: any) {
      showBanner(e.message || String(e), true);
    }
  });
  document.getElementById("btn-export-study")!.addEventListener("click", async () => {
    if (!session || !studyIndex) return;
    const st = studyIndex.studies[activeStudyIdx];
    try {
      await exportCurrentStudy(session, activeStudyIdx, st, ensureFullSeriesFetched);
    } catch (e: any) {
      showBanner(e.message || String(e), true);
    }
  });

  document.getElementById("btn-test-bridges")!.addEventListener("click", async () => {
    if (!session || !studyIndex) return;
    const loader = createShlCornerstoneImageLoader(async (sIdx, serIdx, iIdx) => {
      const ser = studyIndex!.studies[sIdx].series[serIdx];
      await ensureInstanceFetched(sIdx, serIdx, ser, iIdx);
      const r = session!.render_instance_rgba(sIdx, serIdx, iIdx, null, null);
      const dcmBytes = session!.get_instance_dicom(sIdx, serIdx, iIdx);
      return {
        width: r.width,
        height: r.height,
        rgba: r.rgba_bytes(),
        windowCenter: r.window_center,
        windowWidth: r.window_width,
        minPixel: r.min_pixel,
        maxPixel: r.max_pixel,
        dicomBytes: dcmBytes,
      };
    });
    const csId = formatCornerstoneImageId(activeStudyIdx, activeSeriesIdx, activeInstanceIdx);
    const imgObj = await loader(csId).promise;
    const magic = new TextDecoder().decode(imgObj.dicomBytes.slice(128, 132));
    document.getElementById("bridge-test-result")!.textContent = `OK: Cornerstone ${imgObj.width}×${imgObj.height}, ${imgObj.dicomBytes.byteLength.toLocaleString()} B (magic="${magic}")`;
  });

  document.getElementById("btn-clone-demo")!.addEventListener("click", () => void cloneDemoToSandbox());
  document.getElementById("btn-mint-link")!.addEventListener("click", async () => {
    const baseIndex = ownerStudyIndex ?? studyIndex;
    if (!sandbox || !baseIndex) return;
    const label = (document.getElementById("new-link-label") as HTMLInputElement).value || "Custom Link";
    const pass = (document.getElementById("new-link-passcode") as HTMLInputElement).value.trim() || undefined;
    const longLived = (document.getElementById("new-link-longlived") as HTMLInputElement).checked;
    try {
      await mintStudyLinkOnSandbox(api, sandbox, baseIndex, label, pass, longLived);
      refreshSandboxUI();
      showBanner(`Created SMART Health Link "${label}".`);
    } catch (e: any) {
      showBanner(e.message || String(e), true);
    }
  });

  const fileInput = document.getElementById("input-pack-files") as HTMLInputElement;
  fileInput.addEventListener("change", async () => {
    if (!fileInput.files || fileInput.files.length === 0) return;
    showBanner(`Packing ${fileInput.files.length} file(s) in WebAssembly…`);
    try {
      sandbox = await packUploadedFilesToSandbox(api, fileInput.files);
      connectHostSse(sandbox.sid, sandbox.controlToken);
      refreshSandboxUI();
      if (sandbox.links[0]?.shlinkUri) {
        isDemoShare = false;
        await loadFromShlink(sandbox.links[0].shlinkUri, "Browser Packer");
      }
      showBanner("Packed and uploaded new DICOM share in browser WASM!");
    } catch (e: any) {
      showBanner(`Browser pack failed: ${e.message || e}`, true);
    }
  });
}

function showBanner(msg: string, isError = false) {
  const b = document.getElementById("status-banner")!;
  b.textContent = msg;
  b.classList.remove("hidden");
  b.classList.toggle("error", isError);
}

function hideBanner() {
  document.getElementById("status-banner")!.classList.add("hidden");
}

void boot();
