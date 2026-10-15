// Viewer controls for the checks, on wide and narrow layouts alike. On narrow screens the report,
// downloads and encryption details are in the More sheet, and the window presets, planes and
// measure tools open as sheets (Display, Measure); on wide screens they are in the top bar and
// the toolbar's selects.

const visible = (page, sel) => page.isVisible(sel);

/** Opens a More-sheet item by its title. */
async function more(page, title) {
  await page.click("#btn-more");
  await page.waitForSelector("#sheet-more:not(.hidden)");
  await page.locator("#sheet-more .more-item", { hasText: title }).first().click();
}

export const narrow = (page) => visible(page, "#btn-more");

export async function openDownloads(page) {
  if (await visible(page, "#btn-download-menu")) await page.click("#btn-download-menu");
  else await more(page, "Other downloads");
  await page.waitForSelector("#sheet-download:not(.hidden)");
}

export async function openTrust(page) {
  if (await visible(page, "#btn-trust")) await page.click("#btn-trust");
  else await more(page, "Encrypted");
  await page.waitForSelector("#sheet-trust:not(.hidden)");
}

/** Opens the report panel (if the study has reports). Returns false when there is none. */
export async function openReport(page) {
  if (await visible(page, "#btn-report")) {
    if ((await page.getAttribute("#btn-report", "aria-expanded")) !== "true") await page.click("#btn-report");
    return true;
  }
  if (!(await narrow(page))) return false;
  await page.click("#btn-more");
  await page.waitForSelector("#sheet-more:not(.hidden)");
  const item = page.locator("#sheet-more .more-item", { hasText: "Report" });
  if (!(await item.count())) {
    await page.click("#sheet-more [data-close]");
    return false;
  }
  await item.first().click();
  return true;
}

/** The download default as offered: { label, bytesText }. */
export async function downloadDefault(page) {
  if (await visible(page, "#btn-download")) return { label: await page.getAttribute("#btn-download", "aria-label"), size: await page.textContent("#dl-size") };
  await page.click("#btn-more");
  await page.waitForSelector("#sheet-more:not(.hidden)");
  const item = page.locator("#sheet-more .more-item", { hasText: "Download study" }).first();
  const text = (await item.count()) ? await item.textContent() : "";
  await page.click("#sheet-more [data-close]");
  return { label: text.replace(/(Download study)/, "$1 ").trim(), size: (text.match(/[\d.]+ [KMG]?B/) ?? [""])[0] };
}

/** Options of a toolbar select, by label (whether it shows as a select or in a sheet). */
export async function selectLabels(page, id) {
  return page.locator(`#${id} option`).allTextContents();
}

async function choose(page, id, value, sheetButton, sheet) {
  if (await visible(page, `#${id}`)) return page.selectOption(`#${id}`, value);
  const label = await page.$eval(`#${id}`, (s, v) => [...s.options].find((o) => o.value === v)?.textContent ?? "", value);
  await page.click(sheetButton);
  await page.waitForSelector(`${sheet}:not(.hidden)`);
  await page.locator(`${sheet} .choice`, { hasText: label || "Off" }).first().click();
}

export const pickPreset = (page, value) => choose(page, "preset", value, "#btn-display", "#sheet-display");
export const pickPlane = (page, value) => choose(page, "view-plane", value, "#btn-display", "#sheet-display");
export const pickMeasure = (page, value) => choose(page, "measure-tool", value, "#btn-measure", "#sheet-measure");

/** Whether a toolbar select's choices are offered (as a select, or in the Display sheet). */
export async function offered(page, id) {
  if (await visible(page, `#${id}`)) return true;
  return (await narrow(page)) && !(await page.$eval(`#${id}`, (s) => s.classList.contains("hidden")));
}

/** Opens the angle and slab sheet. */
export async function openPlaneOptions(page) {
  if (await visible(page, "#btn-plane-opts")) await page.click("#btn-plane-opts");
  else {
    await page.click("#btn-display");
    await page.waitForSelector("#sheet-display:not(.hidden)");
    await page.locator("#sheet-display .choice", { hasText: "Angle and slab" }).click();
  }
  await page.waitForSelector("#sheet-plane:not(.hidden)");
}
