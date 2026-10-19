// bun test test/open-share.test.ts: making a share for an upload (web/share/lib/upload.ts
// startShare). Run against a stand-in server that, like the real one, refuses a link to files it
// does not hold.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ShareApi } from "../web/share/lib/api";
import { startShare } from "../web/share/lib/upload";
import { randomKeyB64 } from "../web/core/jwe";
import { decryptLabel } from "../web/share/lib/labels";

const realFetch = globalThis.fetch;
let shares: Map<string, { links: any[] }>;
const held = new Set<string>(); // files the server holds
let failLink = false;

beforeEach(() => {
  shares = new Map();
  held.clear();
  failLink = false;
  let n = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (init.method === "POST" && path === "/api/shares") {
      const id = `s${++n}`;
      shares.set(id, { links: [] });
      return json(200, { share: { id, links: [] }, controlToken: `t-${id}` });
    }
    const m = path.match(/^\/api\/shares\/([^/]+)(\/links)?$/);
    const share = m && shares.get(m[1]);
    if (!share) return json(404, { error: "no such share" });
    if (init.method === "DELETE" && !m![2]) return shares.delete(m![1]), new Response(null, { status: 204 });
    if (init.method === "POST" && m![2]) {
      const o = JSON.parse(String(init.body));
      if (failLink) return json(400, { error: "label too long" });
      if (o.allowedFiles.some((f: string) => !held.has(f.replace(/\.bin$/, "")))) return json(400, { error: "FOREIGN KEY constraint failed" });
      expect(o.label).toBeUndefined();
      const link = { id: `l${share.links.length}`, passcode: !!o.passcode, allowedFiles: o.allowedFiles, ...(o.labelEncrypted ? { labelEncrypted: o.labelEncrypted } : {}) };
      share.links.push(link);
      return json(200, link);
    }
    return json(405, { error: "unexpected" });
  }) as any;
});
afterEach(() => (globalThis.fetch = realFetch));

const open = <T>(passcode: string, start: (api: ShareApi) => Promise<T>) =>
  startShare(
    new ShareApi("https://share.example"),
    (sid, token) => new ShareApi("https://share.example", { sid, token }),
    { expiresAt: 2e9, passcode, link: { label: null, exp: null, longLived: false } },
    () => {},
    (api) => start(api),
  );

describe("making a share for an upload", () => {
  test("with a passcode, the link is made before any file is uploaded", async () => {
    await open("7319", async () => "saved");
    const [share] = [...shares.values()];
    expect(share.links).toEqual([{ id: "l0", passcode: true, allowedFiles: [] }]);
  });
  test("the early passcode link stores an encrypted label before the owner Bundle exists", async () => {
    const ownerKey = randomKeyB64(), label = "Second opinion — Dr. Lee";
    await startShare(
      new ShareApi("https://share.example"),
      (sid, token) => new ShareApi("https://share.example", { sid, token, ownerKey }),
      { expiresAt: 2e9, passcode: "7319", link: { label, exp: null, longLived: false } },
      () => {},
      async () => "saved",
    );
    const [sid, share] = [...shares.entries()][0];
    expect(JSON.stringify(share)).not.toContain(label);
    expect(await decryptLabel(share.links[0].labelEncrypted, ownerKey, sid)).toBe(label);
  });
  test("without a passcode, no link is made yet", async () => {
    await open("", async () => "saved");
    expect([...shares.values()][0].links).toEqual([]);
  });
  test("if the link cannot be made, the share is deleted", async () => {
    failLink = true;
    await expect(open("7319", async () => "saved")).rejects.toThrow("label too long");
    expect(shares.size).toBe(0);
  });
  test("if anything fails before the job is saved, the share is deleted", async () => {
    await expect(open("7319", async () => Promise.reject(new Error("disk full")))).rejects.toThrow("disk full");
    expect(shares.size).toBe(0);
  });
  test("once the job is saved, the share stays", async () => {
    expect(await open("7319", async () => "saved")).toBe("saved");
    expect(shares.size).toBe(1);
  });
});
