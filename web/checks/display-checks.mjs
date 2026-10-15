// Display fidelity checks (workstream C of docs/COVERAGE-PLAN.md): the viewer's rendering of
// each feature compared with a reference rendering of the same file.
//   - grayscale pipeline (Modality LUT, VOI LUT, SIGMOID, LINEAR_EXACT, Presentation LUT Shape,
//     header windows): DCMTK dcm2img with the matching option;
//   - 60xx overlays: the pixels DCMTK changes when it draws overlays, against the viewer's mask;
//   - ICC profiles: LittleCMS (references made by objects/make-derived.py);
//   - reformats: SimpleITK resampling of the same series (objects/mpr-ref.py), slabs combined with numpy;
//   - calibration: lengths and the calibration source, from the header values read by pydicom;
//   - float pixel data: the default window, the values and units under the cursor (pydicom), and
//     the rendering (numpy, objects/make-derived.py).
// The viewer side renders what is on screen at the image's own size with the CPU reference
// renderer (same pixels as the GPU path, viewer-kit/PERF.md), and compares in the page.
//   uv run --project codec-corpus python web/checks/objects/expect.py > /tmp/objects-expect.json
//   bun web/checks/objects-fixtures.ts http://localhost:3350
//   BASE=http://localhost:3350 node web/checks/display-checks.mjs [--only=case]
import { pickMeasure } from "./ui.mjs";
import { launchBrowser, pageErrorCheck } from "./browser.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3350";
const ROOT = new URL("../../", import.meta.url).pathname;
const SHOTS = `${ROOT}docs/shots/display/`;
const REFS = "/tmp/display-refs/";
mkdirSync(SHOTS, { recursive: true });
mkdirSync(REFS, { recursive: true });
const M = JSON.parse(readFileSync(new URL("./objects/samples.json", import.meta.url), "utf8"));
const F = JSON.parse(readFileSync("/tmp/objects-fixtures.json", "utf8"));
const E = JSON.parse(readFileSync("/tmp/objects-expect.json", "utf8"));
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const file = (c, f) => `${M.dataRoot}/${c}/${f}`;
const exp = (c, f) => E[`${c}/${f}`];

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** A dcm2img reference rendering (PNG, frame 1 unless `frame`), made once. */
function dcmtk(caseId, f, opts, tag) {
  const out = `${REFS}${caseId}-${f.replace(/[\/]/g, "_")}-${tag}.png`;
  execFileSync("dcm2img", ["--write-png", ...opts, file(caseId, f), out], { stdio: "ignore" });
  return out;
}
const dataUrl = (p) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;

const browser = await launchBrowser();

/** Opens a case and shows the image of file `f` (frame `frame`, 0-based). */
async function show(caseId, f, frame = 0, dev = { viewport: { width: 1280, height: 860 } }) {
  const context = await browser.newContext(dev);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/view#${F[caseId].link}`);
  await page.waitForSelector(".study-open");
  const e = exp(caseId, f);
  // The study holding the file's series.
  const studies = await page.locator(".study-open").count();
  for (let si = 0; si < studies; si++) {
    if (si) {
      await page.click("#btn-back");
      await page.waitForSelector("#screen-overview:not(.hidden)");
    }
    await page.locator(".study-open").nth(si).click();
    await page.waitForSelector(".series-btn");
    const btn = page.locator(`.series-btn[data-uid="${e.series}"]`);
    if (!(await btn.count())) continue;
    await btn.click();
    await page.waitForFunction(() => window.__viewHooks.state().seriesIdx >= 0 && !document.querySelector("#stage-busy:not(.hidden)"));
    const idx = await page.evaluate((s) => window.__viewHooks.instanceIndex(s), e.sopInstance);
    const st = await page.evaluate(() => window.__viewHooks.state());
    await page.evaluate((i) => window.__viewHooks.showSlice(i), st.sliceCount > 1 && idx === 0 && frame ? frame : idx >= 0 ? idx : 0);
    await page.waitForTimeout(800);
    return { context, page, errors };
  }
  throw new Error(`series of ${f} not found`);
}

async function compare(page, ref) {
  return page.evaluate((u) => window.__viewHooks.compareWith(u), dataUrl(ref));
}
const fmt = (r) => (r?.error ? r.error : r ? `max ${r.max}, mean ${r.mean.toFixed(2)}, ${(r.over2 * 100).toFixed(2)}% over 2` : "no image");
const close = (r, max = 2, frac = 0.005) => r && !r.error && r.over2 <= frac && r.max <= Math.max(max, 255 * (r.over2 > 0 ? 1 : 0)) && r.mean < 1;

async function grayscale() {
  const cases = [
    // [case, file, label, viewer action, dcm2img options, tolerance]
    ["modality-lut-seq", "mlut_18.dcm", "Modality LUT Sequence (min–max window)", { minmax: true }, ["+Wm"]],
    ["modality-lut-seq", "fodicom-CR-ModalitySequenceLUT.dcm", "Modality LUT Sequence and rescale (min–max)", { minmax: true }, ["+Wm"]],
    ["voi-lut-seq", "vlut_04.dcm", "VOI LUT Sequence", { preset: "lut-0" }, ["+Wl", "1"]],
    ["voi-lut-seq", "gdcm-DX_GE_FALCON_SNOWY-VOI.dcm", "VOI LUT 2 of 3", { preset: "lut-1" }, ["+Wl", "2"]],
    ["window-presets", "gdcm-DX_GE_FALCON_SNOWY-VOI.dcm", "header window 2 of 3 (HARDER)", { preset: "file-1" }, ["+Wi", "2"]],
    ["window-presets", "gdcm-CT-SIEMENS-Icone-With-PaletteColor.dcm", "header window 2 of 2", { preset: "file-1" }, ["+Wi", "2"]],
    ["pres-lut-shape", M.cases.find((c) => c.id === "pres-lut-shape").files[0], "MONOCHROME1 with Presentation LUT Shape INVERSE", {}, ["+Wi", "1"]],
  ];
  const voi = M.cases.find((c) => c.id === "voi-lut-seq");
  for (const f of voi.files.slice(2)) {
    const d = (voi.fileDetails ?? []).find((x) => x.file === f);
    const fn = JSON.stringify(d ?? {}).match(/SIGMOID|LINEAR_EXACT/)?.[0] ?? (f.includes("cmmd") ? "SIGMOID" : "LINEAR_EXACT");
    cases.push(["voi-lut-seq", f, `VOI LUT Function ${fn}`, {}, ["+Wi", "1"]]);
  }
  for (const [c, f, label, act, opts] of cases) {
    if (only && only !== c) continue;
    try {
      const { context, page, errors } = await show(c, f);
      if (act.minmax) await page.evaluate(() => window.__viewHooks.minMaxWindow());
      if (act.preset) {
        const ps = await page.evaluate(() => window.__viewHooks.presets());
        check(`${c}: ${label}: offered as a choice`, ps.some((p) => p.id === act.preset), ps.map((p) => p.label).join(", "));
        await page.evaluate((id) => window.__viewHooks.applyPresetId(id), act.preset);
      }
      await page.waitForTimeout(300);
      const r = await compare(page, dcmtk(c, f, opts, opts.join("")));
      check(`${c}: ${label}: matches DCMTK dcm2img ${opts.join(" ")}`, close(r), fmt(r));
      await page.screenshot({ path: `${SHOTS}${c}-${f.split("/").pop()}-${opts.join("")}.png` });
      check(`${c}: ${label}: no console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
      await context.close();
    } catch (e) {
      check(`${c}: ${label}`, false, String(e).slice(0, 300));
    }
  }
}

async function overlays() {
  for (const [c, f] of [["overlay-separate", "MR-SIEMENS-DICOM-WithOverlays.dcm"], ["overlay-highbits", "dcm4che-ovly_p01.dcm"]]) {
    if (only && only !== c) continue;
    try {
      const { context, page, errors } = await show(c, f);
      await page.waitForFunction(() => +document.querySelector(".layer-canvas")?.dataset.drawn > 0, null, { timeout: 15000 }).catch(() => {});
      const ours = await page.evaluate(() => window.__viewHooks.overlayMask());
      // DCMTK with and without overlays: the pixels that change are overlay pixels.
      const a = dcmtk(c, f, [], "ov"), b = dcmtk(c, f, ["-O"], "noov");
      const diff = await page.evaluate(async ([u1, u2]) => {
        const read = async (u) => {
          const bmp = await createImageBitmap(await (await fetch(u)).blob());
          const g = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d");
          g.drawImage(bmp, 0, 0);
          return g.getImageData(0, 0, bmp.width, bmp.height).data;
        };
        const [x, y] = await Promise.all([read(u1), read(u2)]);
        const m = [];
        for (let i = 0; i < x.length; i += 4) m.push(x[i] !== y[i] ? 1 : 0);
        return m;
      }, [dataUrl(a), dataUrl(b)]);
      let inMask = 0, changed = 0;
      for (let i = 0; i < diff.length; i++) if (diff[i]) { changed++; if (ours?.mask[i]) inMask++; }
      check(`${c}: overlay planes drawn`, (ours?.set ?? 0) > 0, `${ours?.set ?? 0} overlay pixels`);
      check(`${c}: every pixel DCMTK changes for overlays is in the viewer's overlay`, changed > 0 && inMask / changed >= 0.99, `${inMask} of ${changed}`);
      await page.screenshot({ path: `${SHOTS}${c}.png` });
      check(`${c}: no console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
      await context.close();
    } catch (e) {
      check(`${c}: overlays`, false, String(e).slice(0, 300));
    }
  }
}

async function icc() {
  if (only && only !== "icc-photo") return;
  const c = M.cases.find((x) => x.id === "icc-photo");
  for (const f of c.files) {
    try {
      const { context, page, errors } = await show("icc-photo", f);
      const r = await compare(page, file("icc-photo", `references/${f}.srgb.png`));
      check(`icc-photo/${f}: ICC profile applied, compared with LittleCMS`, r && !r.error && r.mean < 1.5 && r.over2 < 0.05, fmt(r));
      const off = await page.evaluate(async () => {
        document.querySelector("#btn-layers").click();
        await new Promise((r) => setTimeout(r, 200));
        const cb = document.querySelector('[data-layer="icc"]');
        return !!cb;
      });
      // An sRGB profile needs no correction: nothing is applied or listed.
      const desc = (c.fileDetails ?? []).find((d) => d.file === f)?.iccDescription ?? "";
      const srgb = /^sRGB\b/i.test(desc) || /IEC ?61966-2[.-]1/.test(desc);
      check(`icc-photo/${f}: ${srgb ? "sRGB profile: nothing to correct, not listed" : "colour profile listed in Layers"}`, off === !srgb, desc);
      await page.screenshot({ path: `${SHOTS}icc-${f}.png` });
      check(`icc-photo/${f}: no console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
      await context.close();
    } catch (e) {
      check(`icc-photo/${f}`, false, String(e).slice(0, 300));
    }
  }
}

async function geometry() {
  // Calibration: a 100-pixel horizontal line, against the header values pydicom reads.
  if (!only || only === "calibration") {
    const c = M.cases.find((x) => x.id === "calibration");
    for (const f of c.files) {
      try {
        const sp = JSON.parse(execFileSync("uv", ["run", "--project", `${ROOT}codec-corpus`, "python", "-c", `import pydicom,json; d=pydicom.dcmread(${JSON.stringify(file("calibration", f))}, stop_before_pixels=True); print(json.dumps({"ps": [float(x) for x in d.get("PixelSpacing", [])], "ips": [float(x) for x in d.get("ImagerPixelSpacing", [])], "mag": float(d.get("EstimatedRadiographicMagnificationFactor", 1) or 1)}))`], { encoding: "utf8" }).trim());
        const { context, page } = await show("calibration", f);
        const r = await page.evaluate(() => window.__viewHooks.measureLength(0, 0, 100, 0));
        // And with the Length tool, by mouse: the result and its calibration source appear on the image.
        await pickMeasure(page, "length");
        const box = await page.locator("#stage").boundingBox();
        await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 5 });
        await page.mouse.up();
        const hud = await page.textContent("#hud-br");
        check(`calibration/${f.split("/")[1]}: Length tool shows a calibrated result`, /\d mm\n/.test(hud) && /Calibrated/.test(hud), hud.replace("\n", " / "));
        await page.screenshot({ path: `${SHOTS}calibration-${f.split("/")[1]}.png` });
        const col = sp.ps.length ? sp.ps[1] : sp.mag !== 1 ? sp.ips[1] / sp.mag : sp.ips[1];
        const want = (100 * col).toFixed(1);
        const src = sp.ps.length ? /Pixel Spacing/ : sp.mag !== 1 ? /magnification/ : /detector/;
        check(`calibration/${f.split("/")[1]}: length from ${sp.ps.length ? "Pixel Spacing" : "Imager Pixel Spacing"}`, r?.text === `${want} mm`, `${r?.text}; expected ${want} mm`);
        check(`calibration/${f.split("/")[1]}: calibration source shown`, src.test(r?.calibration ?? ""), r?.calibration);
        await context.close();
      } catch (e) {
        check(`calibration/${f}`, false, String(e).slice(0, 300));
      }
    }
  }
  // Enhanced multi-frame: per-frame geometry (Pixel Measures, Plane Position) reaches the viewer.
  if (!only || only === "enhanced-mf") {
    for (const f of ["eCT_Supplemental.dcm", "fodicom-mr_brucker-enhanced-mr.dcm"]) {
      try {
        const g = JSON.parse(execFileSync("uv", ["run", "--project", `${ROOT}codec-corpus`, "python", "-c", `
import pydicom,json
d=pydicom.dcmread(${JSON.stringify(file("enhanced-mf", f))}, stop_before_pixels=True)
pf=d.PerFrameFunctionalGroupsSequence[-1]; sh=d.get("SharedFunctionalGroupsSequence",[{}])[0]
pm=(pf.get("PixelMeasuresSequence") or sh.get("PixelMeasuresSequence"))[0]
print(json.dumps({"frames": int(d.NumberOfFrames), "ps":[float(x) for x in pm.PixelSpacing]}))`], { encoding: "utf8" }).trim());
        const { context, page, errors } = await show("enhanced-mf", f);
        const st = await page.evaluate(() => window.__viewHooks.state());
        check(`enhanced-mf/${f}: every frame is a slice`, st.sliceCount === g.frames, `${st.sliceCount} of ${g.frames}`);
        await page.evaluate((i) => window.__viewHooks.showSlice(i), g.frames - 1);
        await page.waitForTimeout(500);
        const r = await page.evaluate(() => window.__viewHooks.measureLength(0, 0, 100, 0));
        check(`enhanced-mf/${f}: per-frame Pixel Measures used`, r?.text === `${(100 * g.ps[1]).toFixed(1)} mm`, `${r?.text}; expected ${(100 * g.ps[1]).toFixed(1)} mm`);
        await page.screenshot({ path: `${SHOTS}enhanced-${f}.png` });
        check(`enhanced-mf/${f}: no console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
        await context.close();
      } catch (e) {
        check(`enhanced-mf/${f}`, false, String(e).slice(0, 300));
      }
    }
  }
  await reformats();
}

/**
 * Reformatted planes against the oracle (objects/mpr-ref.py: SimpleITK, linear, the series'
 * own lattice including gantry tilt): true axial, sagittal and coronal planes, an oblique one, and
 * slabs, on an isotropic CT, the Josh Example CT (5 mm), an oblique MR and a tilted CT.
 */
async function reformats() {
  const AX = { axial: [[1, 0, 0], [0, 1, 0]], coronal: [[1, 0, 0], [0, 0, -1]], sagittal: [[0, 1, 0], [0, 0, -1]] };
  const configs = [
    ["sagittal", {}],
    ["coronal", {}],
    ["axial", {}],
    ["sagittal", { turn: 20, tilt: 15 }],
    ["sagittal", { slab: { thickness: 10, mode: "mip" } }],
    ["coronal", { slab: { thickness: 10, mode: "minip" } }],
    ["axial", { slab: { thickness: 20, mode: "avg" } }],
  ];
  for (const c of ["volume-ct", "mpr-josh-ct", "mpr-oblique-mr", "mpr-tilt"]) {
    if (only && only !== c && only !== "reformats") continue;
    const cs = M.cases.find((x) => x.id === c);
    if (!cs || !F[c]) {
      check(`${c}: reformat case shared`, false, "run make-derived.py and objects-fixtures.ts");
      continue;
    }
    try {
      const { context, page, errors } = await show(c, cs.files[0]);
      for (const engine of ["cpu", "gpu"])
      for (const [plane, opts] of configs) {
        await page.evaluate((e) => window.__viewHooks.setMprEngine(e), engine);
        const label = `${c} (${engine}): ${plane}${opts.turn ? ` turned ${opts.turn}° tilted ${opts.tilt}°` : ""}${opts.slab ? ` ${opts.slab.mode} ${opts.slab.thickness} mm` : ""}`;
        // A slab stays chosen across planes in the viewer: say "thin" explicitly.
        await page.evaluate(([p, o]) => window.__viewHooks.enterMpr(p, o), [plane, { slab: { thickness: 0, mode: "mip" }, ...opts }]);
        await page.waitForFunction(() => !document.querySelector("#stage-busy:not(.hidden)"), null, { timeout: 120000 });
        const m = await page.evaluate(() => window.__viewHooks.mprState());
        if (!m) {
          // The stored slices are this plane: nothing to resample.
          check(`${label}: shows the stored images (the plane they were acquired in)`, plane === "axial" && !opts.turn && !opts.slab, (await page.textContent("#stage-msg")).slice(0, 100));
          continue;
        }
        if (!opts.turn) {
          const [u, v] = AX[plane];
          const ok = m.spec.u.every((x, i) => Math.abs(x - u[i]) < 1e-9) && m.spec.v.every((x, i) => Math.abs(x - v[i]) < 1e-9);
          check(`${label}: a true patient plane`, ok, `u ${m.spec.u.map((x) => x.toFixed(3))} v ${m.spec.v.map((x) => x.toFixed(3))}`);
        }
        check(`${label}: labelled "Reformatted in the viewer"`, /Reformatted in the viewer/.test(m.hud), m.hud.replace(/\n/g, " | "));
        const st = await page.evaluate(() => window.__viewHooks.state());
        const tag = `${c}-${engine}-${plane}-${opts.turn ?? 0}-${opts.slab?.mode ?? "thin"}`;
        const job = { files: cs.files.map((f) => file(c, f)), spec: m.spec, window: { center: st.wc, width: st.ww }, out: `${REFS}mpr-${tag}.png` };
        writeFileSync(`${REFS}mpr-${tag}.json`, JSON.stringify(job));
        execFileSync("uv", ["run", "--project", `${ROOT}codec-corpus`, "--with", "simpleitk", "--with", "pillow", "python", `${ROOT}web/checks/objects/mpr-ref.py`, `${REFS}mpr-${tag}.json`], { stdio: ["ignore", "ignore", "inherit"] });
        const r = await compare(page, job.out);
        if (m.engine !== engine) {
          check(`${label}: runs on the ${engine}`, false, `ran on the ${m.engine}`);
          continue;
        }
        check(`${label}: matches SimpleITK within 1 grey level (${m.spec.width}×${m.spec.height}, ${m.spec.offsets.length} plane${m.spec.offsets.length > 1 ? "s" : ""}, ${m.ms.toFixed(0)} ms)`, r && !r.error && r.max <= 1, fmt(r));
        await page.screenshot({ path: `${SHOTS}mpr-${tag}.png` });
      }
      await page.evaluate(() => window.__viewHooks.enterMpr(""));
      await page.evaluate(() => window.__viewHooks.setMprEngine("auto"));
      check(`${c} reformats: no console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
      await context.close();
    } catch (e) {
      check(`${c}: reformats`, false, String(e).slice(0, 300));
    }
  }
}

/** Float pixel data: default window, cursor values and units, rendering. */
async function floats() {
  const files = [
    ...M.cases.find((c) => c.id === "float-maps").files.map((f) => ["float-maps", f]),
    ["pmap", "pydicom/parametric_map_float.dcm"],
    ["pmap-overlay", "pmap.dcm"],
  ];
  const unitText = (u) => (!u || u === "1" || /^\{[^}]*\}$/.test(u) ? "" : u);
  for (const [c, f] of files) {
    if (only && only !== c) continue;
    const fe = exp(c, f).float;
    for (const frame of [...new Set(fe.samples.map((s) => s.frame))]) {
      const label = `${c}/${f.split("/").pop()} frame ${frame + 1}`;
      try {
        const { context, page, errors } = await show(c, f, frame);
        const st = await page.evaluate(() => window.__viewHooks.state());
        const [ec, ew] = fe.window;
        check(`${label}: default window ${ec}/${ew} (file, else mapped range, else data range)`, Math.abs(st.wc - ec) <= ew * 1e-6 && Math.abs(st.ww - ew) <= ew * 1e-6, `${st.wc}/${st.ww}`);
        const ref = `${file(c, "references")}/${f}.f${frame}.png`;
        if (existsSync(ref)) {
          const r = await compare(page, ref);
          check(`${label}: rendering matches numpy (LINEAR_EXACT, real values)`, r && !r.error && r.max <= 1, fmt(r));
        }
        const bad = [];
        for (const s of fe.samples.filter((s) => s.frame === frame)) {
          const v = await page.evaluate(([x, y]) => window.__viewHooks.valueAt(x, y), [s.x, s.y]);
          const ok = s.value === null ? v && Number.isNaN(v.value) : v && Math.abs(v.value - s.value) <= Math.abs(s.value) * 1e-6 + 1e-12;
          if (!ok || v.units !== unitText(fe.units)) bad.push(`(${s.x},${s.y}) ${v?.value} ${v?.units} vs ${s.value} ${fe.units}`);
        }
        check(`${label}: values and units under the cursor match pydicom`, bad.length === 0, bad.slice(0, 3).join("; ") || `${fe.samples.filter((s) => s.frame === frame).length} points`);
        // The readout itself, with the mouse over a sample.
        const s0 = fe.samples.find((s) => s.frame === frame && s.value !== null);
        const pt = await page.evaluate(([x, y]) => window.__viewHooks.clientAt(x, y), [s0.x, s0.y]);
        await page.mouse.move(pt.x, pt.y);
        await page.waitForTimeout(150);
        const hud = await page.textContent("#hud-bl");
        const u = unitText(fe.units);
        check(`${label}: readout shows the value${u ? ` in ${u}` : ""}`, hud.includes(`(${s0.x}, ${s0.y})`) && (!u || hud.includes(` ${u}`)), JSON.stringify(hud));
        await page.screenshot({ path: `${SHOTS}float-${f.split("/").pop()}-f${frame}.png` });
        check(`${label}: no console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
        await context.close();
      } catch (e) {
        check(`${label}`, false, String(e).slice(0, 300));
      }
    }
  }
}

/**
 * The display transform outside the browser, on the LUT edges (display-synthetic.py) and the Josh
 * Example radiographs, against dcmtk and the expected renderings (display-conformance.ts/.py). The
 * full sweep over every grayscale file is the same two scripts with the corpus as input.
 */
async function conformance() {
  if (only && only !== "conformance") return;
  const out = "/tmp/display-conformance-quick";
  const xr = JSON.parse(execFileSync("uv", ["run", "--project", `${ROOT}codec-corpus`, "python", `${ROOT}web/checks/sample-originals.py`], { maxBuffer: 1 << 26 }).toString());
  const dirs = [...new Set(Object.values(xr).filter((o) => /\/xr-/.test(o.path)).map((o) => o.path.replace(/\/[^/]+$/, "")))];
  execFileSync("uv", ["run", "--project", `${ROOT}codec-corpus`, "--with", "pillow", "python", `${ROOT}web/checks/display-synthetic.py`], { stdio: "ignore" });
  execFileSync("bun", [`${ROOT}web/checks/display-conformance.ts`, out, "/media/barracuda/shlink-display-conformance/synthetic", ...dirs], { stdio: "ignore" });
  execFileSync("uv", ["run", "--project", `${ROOT}codec-corpus`, "--with", "pillow", "python", `${ROOT}web/checks/display-conformance.py`, out], { stdio: "ignore" });
  const rep = JSON.parse(readFileSync(`${out}/report.json`, "utf8"));
  // Where our LUT depth rule (core/display.ts lutOutputBits) departs from dcmtk, which takes the descriptor's depth.
  const depthRule = (r) => r.features.some((f) => /VOI LUT .*\((\d+)→(\d+) bits\)/.test(f) && f.match(/\((\d+)→(\d+)/).slice(1, 3).reduce((a, b) => a !== b));
  for (const r of rep) {
    const name = r.id.replace(/^.*?(synthetic_|xr-)/, "$1").slice(0, 70);
    if (r.expected) check(`conformance ${name}: as the standard and our LUT rule call for`, r.expected.max <= 1, JSON.stringify(r.expected));
    if (r.dcmtk.max !== undefined && !depthRule(r)) check(`conformance ${name}: matches dcmtk`, r.dcmtk.max <= 1, JSON.stringify(r.dcmtk));
  }
  // The radiographs whose VOI LUT declares 16 bits for 12-bit entries: not washed out.
  const cr = rep.filter((r) => /xr-/.test(r.id) && depthRule(r));
  const means = cr.map((r) => {
    const b = readFileSync(`${out}/${r.id}.ours.pgm`);
    const px = b.subarray(b.length - r.size[0] * r.size[1]);
    let s = 0;
    for (const v of px) s += v;
    return Math.round(s / px.length);
  });
  check(`conformance: the ${cr.length} CR views with an overstated VOI LUT depth show the image, not white`, cr.length >= 6 && means.every((m) => m < 200), means.join(", "));
}

try {
  await conformance();
  await floats();
  await grayscale();
  await overlays();
  await icc();
  await geometry();
} finally {
  pageErrorCheck(browser, check);
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
writeFileSync("/tmp/display-checks.json", JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
