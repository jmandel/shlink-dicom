// Isolated download UI checks, using the real coordinator/execution with controlled save targets.
// Run: node web/checks/downloads-check.mjs (Bun builds the browser-only fixture).
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./downloads-test-page.ts", import.meta.url));
const script = execFileSync("bun", ["build", entry, "--target", "browser", "--format", "iife"], { encoding: "utf8", maxBuffer: 2 ** 20 });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ content: script });
  const checks = await page.evaluate(() => window.__downloadsChecks());
  if (errors.length) throw new Error(errors.join("\n"));
  const result = { success: true, checks, pageErrors: errors };
  if (process.env.CHECK_OUT) {
    await mkdir(process.env.CHECK_OUT, { recursive: true });
    await writeFile(`${process.env.CHECK_OUT}/downloads-check.json`, JSON.stringify(result, null, 2) + "\n");
  }
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
