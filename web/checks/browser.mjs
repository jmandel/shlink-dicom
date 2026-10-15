// Chromium for the check suites, with every uncaught page error recorded: in any page of any
// context, whatever flow it happens in. Each suite reports them as one check at the end.
import { chromium } from "playwright-core";

export async function launchBrowser(opts = {}) {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", ...opts });
  const errors = [];
  const watch = (c) => c.on("weberror", (e) => errors.push(`${(e.page()?.url() ?? "?").split("#")[0]}: ${e.error().message}`));
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (o) => {
    const c = await newContext(o);
    watch(c);
    return c;
  };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (o) => {
    const p = await newPage(o);
    watch(p.context());
    return p;
  };
  browser.pageErrors = errors;
  return browser;
}

/** The suite-wide check: no uncaught error in any page. */
export function pageErrorCheck(browser, check) {
  const e = browser.pageErrors;
  check("no uncaught page errors in any flow", e.length === 0, e.length ? `${e.length}: ${[...new Set(e)].slice(0, 4).join(" | ")}` : "");
}
