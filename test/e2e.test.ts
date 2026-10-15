import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

test("Stage 4 & 5 E2E: Live Server, CLI inspect, Browser SHL Viewer (#shlink:/), Contact Sheet, 64KiB Record Map, Sandbox Clone & Cornerstone/WADO-RS SW Bridge", async () => {
  const port = 3456;
  const serverProc = spawn(
    "./target/release/shl-dicom-server",
    ["serve", "--port", String(port), "--data-dir", "./data"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    // Wait for server to finish seeding and start listening
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timed out")), 60000);
      serverProc.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("listening on")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      serverProc.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited early with code ${code}`));
      });
    });

    // 1. Check /api/demo-shares and run CLI `inspect` on both U-mode and P-mode links
    const demoRes = await fetch(`http://localhost:${port}/api/demo-shares`);
    expect(demoRes.ok).toBe(true);
    const demoData = await demoRes.json();
    expect(demoData.shares.length).toBeGreaterThanOrEqual(2);
    expect(demoData.shares[0].controlToken).toBeUndefined(); // never leaks controlToken

    const uModeShlink: string = demoData.shares[0].shlinkUri;
    const pModeShlink: string = demoData.shares[1].shlinkUri;
    expect(uModeShlink).toContain("#shlink:/");

    // Test CLI `inspect` against U-mode and P-mode links
    const inspectU = Bun.spawnSync([
      "target/release/shl-dicom-server",
      "inspect",
      uModeShlink,
    ]);
    expect(inspectU.exitCode).toBe(0);
    expect(inspectU.stdout.toString()).toContain("Verified Range read");

    const inspectP = Bun.spawnSync([
      "target/release/shl-dicom-server",
      "inspect",
      pModeShlink,
      "--passcode",
      "1234",
    ]);
    expect(inspectP.exitCode).toBe(0);
    expect(inspectP.stdout.toString()).toContain("Verified Range read");

    // 2. Launch headless Chromium and open the viewer directly via its `#shlink:/...` viewer prefix URL
    const browser = await chromium.launch({
      executablePath: "/usr/bin/chromium",
      headless: true,
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(uModeShlink);

    // Wait for clinical header and study tabs to populate
    await page.waitForSelector(".study-tab", { state: "attached", timeout: 15000 });
    const studyTabs = await page.locator(".study-tab").count();
    expect(studyTabs).toBeGreaterThanOrEqual(2);

    // Wait for Contact Sheet thumbnails and active slice to render via HTTP 206 Range reads
    await page.waitForFunction(
      () => {
        const stat = document.getElementById("stat-records")?.textContent ?? "";
        const m = /^(\d+)\s*\/\s*(\d+)/.exec(stat);
        return m !== null && Number(m[1]) > 0;
      },
      { timeout: 20000 },
    );

    // Verify 64 KiB Record Map has verified cells
    const verifiedCells = await page.locator(".record-cell.record-verified").count();
    expect(verifiedCells).toBeGreaterThan(0);

    // Verify canvas rendered non-zero dimensions
    const canvasDims = await page.evaluate(() => {
      const c = document.getElementById("dicom-canvas") as HTMLCanvasElement;
      return { w: c.width, h: c.height };
    });
    expect(canvasDims.w).toBeGreaterThan(100);
    expect(canvasDims.h).toBeGreaterThan(100);

    // 3. Test Stage 5: Switch to "How it works" view, expand Developer section, and verify Cornerstone & WADO-RS SW bridge
    await page.click("#tab-explainer");
    await page.click(".dev-details summary");
    await page.click("#btn-test-bridges");
    await page.waitForFunction(
      () => (document.getElementById("bridge-test-result")?.textContent ?? "").startsWith("OK: Cornerstone"),
      { timeout: 10000 },
    );
    const bridgeText = await page.locator("#bridge-test-result").textContent();
    expect(bridgeText).toContain("OK: Cornerstone");

    // 4. Test Sharer & Host Control Lab: Switch to "Share & Host Lab", auto-clone to Sandbox, Mint Link & Open
    await page.click("#tab-sharer");
    await page.waitForSelector("#sandbox-links-list .link-item", { timeout: 20000 });

    const sandboxLinksCount = await page.locator("#sandbox-links-list .link-item").count();
    expect(sandboxLinksCount).toBe(1);

    // Click "Open in Viewer" on the newly minted sandbox link and verify live Host SSE log receives 206 Range events
    await page.click("#sandbox-links-list .link-item .btn-primary");
    await page.waitForTimeout(800);
    await page.click("#tab-sharer");
    await page.waitForSelector("#host-sse-log .sse-row", { timeout: 15000 });
    const sseText = await page.locator("#host-sse-log").textContent();
    expect(sseText).toContain("206");

    await browser.close();
  } finally {
    serverProc.kill();
  }
}, 90000);
