// The download menu on whatever the viewer shows: every choice offered with the right size, the
// default on the button, and (when asked) the files themselves byte for byte against the
// originals. Shared by view-checks (the sample) and object-checks (objects, video).
//   originals: { sop: { path, size, series, study } } for every file in the share
//   (sample-originals.py makes it from a directory of the shared files).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : [`${d}/${f}`]));
const sum = (xs) => xs.reduce((a, x) => a + x.size, 0);

async function save(page, choice, tag) {
  const dl = page.waitForEvent("download", { timeout: 300000 });
  await page.click(`#sheet-download .dl-option[data-choice="${choice}"]`);
  const d = await dl;
  const path = `/tmp/dlm-${tag}-${d.suggestedFilename()}`;
  await d.saveAs(path);
  return { path, name: d.suggestedFilename() };
}

async function reopen(page) {
  await page.waitForSelector("#dl-status:has-text('Saved')", { timeout: 300000 });
  await page.click("#sheet-download [data-close]");
  await page.click("#btn-download-menu", { timeout: 10000 }).catch(async (e) => {
    await page.screenshot({ path: "/tmp/dlm-reopen.png" });
    throw e;
  });
  await page.waitForSelector("#sheet-download .dl-option");
}

/** Same files, byte for byte (as multisets of SHA-256). */
function sameFiles(paths, originals) {
  const a = paths.map(sha).sort(), b = originals.map((o) => sha(o.path)).sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function unzip(path, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync("unzip", ["-q", path, "-d", dir]);
  return walk(dir);
}

/**
 * Checks the menu for the view on screen. `downloads`: which choices to save and compare
 * ({ image, series, study }). Returns the choices seen.
 */
export async function downloadMatrix(page, label, originals, check, downloads = {}) {
  const all = Object.entries(originals).map(([sop, o]) => ({ sop, ...o }));
  const cur = await page.evaluate(() => window.__viewHooks.current());
  const series = all.filter((o) => o.series === cur.series), study = all.filter((o) => o.study === cur.study);
  const want = { image: cur.onScreen?.uid ? originals[cur.onScreen.uid]?.size : undefined, series: cur.series ? sum(series) : undefined, study: study.length ? sum(study) : undefined, all: sum(all) };
  // The button: the default choice and its size.
  const aria = await page.getAttribute("#btn-download", "aria-label");
  const def = "study";
  const defBytes = want.study;
  check(`${label}: button offers the ${def} by default, with its size`, new RegExp(`^Download this ${def}, `).test(aria ?? "") && (await page.isVisible("#dl-size")), aria);
  // The menu.
  await page.click("#btn-download-menu");
  await page.waitForSelector("#sheet-download:not(.hidden)");
  const opts = await page.$$eval("#sheet-download .dl-option", (bs) => bs.map((b) => ({ choice: b.dataset.choice, bytes: b.dataset.bytes === undefined ? undefined : Number(b.dataset.bytes), reason: b.dataset.reason, disabled: b.disabled, height: b.getBoundingClientRect().height })));
  const got = Object.fromEntries(opts.filter((o) => !o.disabled).map((o) => [o.choice, o.bytes]));
  const bad = Object.entries(want).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k}: ${got[k]} vs ${v}`);
  check(`${label}: menu choices and sizes match the original files`, bad.length === 0, bad.join("; ") || opts.map((o) => `${o.choice} ${o.bytes}`).join(", "));
  check(`${label}: default size on the button matches its choice`, defBytes !== undefined && got[def] === defBytes, `${def} ${got[def]}`);
  const img = opts.find((o) => o.choice === "image");
  if (cur.onScreen?.reason) check(`${label}: "This image" greyed out, with the reason`, img?.disabled === true && img.reason === cur.onScreen.reason, img?.reason ?? "missing");
  check(`${label}: choices at least 44 px tall`, opts.every((o) => o.height >= 44), opts.map((o) => Math.round(o.height)).join(","));
  const tag = label.replace(/[^a-z0-9]+/gi, "-");
  if (downloads.image && got.image !== undefined) {
    const { path, name } = await save(page, "image", tag);
    check(`${label}: image download is the original file`, name === `${cur.onScreen.uid}.dcm` && sha(path) === sha(originals[cur.onScreen.uid].path), name);
    rmSync(path, { force: true });
    await reopen(page);
  }
  for (const scope of ["series", "study"]) {
    if (!downloads[scope] || got[scope] === undefined) continue;
    const { path } = await save(page, scope, `${tag}-${scope}`);
    const files = unzip(path, `/tmp/dlm-${tag}-${scope}`);
    const dicom = files.filter((f) => /\/DICOM\/ST\d{6}\/SE\d{6}\/IM\d{6}$/.test(f));
    const dicomdir = files.find((f) => f.endsWith("/DICOMDIR"));
    const ok = sameFiles(dicom, scope === "series" ? series : study);
    let records = 0;
    try {
      records = (execFileSync("dcmdump", ["--search", "0004,1500", dicomdir]).toString().match(/\(0004,1500\)/g) ?? []).length;
    } catch {}
    check(`${label}: ${scope} ZIP holds the original files, with a DICOMDIR listing each`, ok && records === dicom.length, `${dicom.length} files, ${records} DICOMDIR file records${ok ? "" : ", contents differ"}`);
    rmSync(path, { force: true });
    rmSync(`/tmp/dlm-${tag}-${scope}`, { recursive: true, force: true });
    await reopen(page);
  }
  await page.click("#sheet-download [data-close]");
  return { cur, got };
}
