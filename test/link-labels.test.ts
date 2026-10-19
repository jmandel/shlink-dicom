import { expect, test } from "bun:test";
import { b64urlDecode, b64urlEncode, fromUtf8, utf8 } from "../web/core/b64";
import { encryptJwe, randomKeyB64 } from "../web/core/jwe";
import { ShareApi, shlinkFor } from "../web/share/lib/api";
import { decryptLabel, encryptLabel } from "../web/share/lib/labels";

test("labels use fresh authenticated encryption and require the owner key and share", async () => {
  const key = randomKeyB64(), label = "Dr. García — wrist review";
  const a = (await encryptLabel(label, key, "share-a"))!;
  const b = (await encryptLabel(label, key, "share-a"))!;
  expect(a.iv).not.toBe(b.iv);
  expect(JSON.stringify(a)).not.toContain(label);
  expect(await decryptLabel(a, key, "share-a")).toBe(label);
  await expect(decryptLabel(a, randomKeyB64(), "share-a")).rejects.toThrow();
  await expect(decryptLabel(a, key, "share-b")).rejects.toThrow();
  const corrupted = b64urlDecode(a.ciphertext);
  corrupted[0] ^= 1;
  await expect(decryptLabel({ ...a, ciphertext: b64urlEncode(corrupted) }, key, "share-a")).rejects.toThrow();
  expect(await encryptLabel("   ", key, "share-a")).toBeNull();
  await expect(encryptLabel("x".repeat(81), key, "share-a")).rejects.toThrow();
  const longest = "界".repeat(80);
  expect(await decryptLabel((await encryptLabel(longest, key, "share-a"))!, key, "share-a")).toBe(longest);
});

async function fixture(run: (f: { api: ShareApi; fresh: () => ShareApi; wire: () => any; requests: string[]; key: string; base: string; legacy: () => void }) => Promise<void>) {
  const key = randomKeyB64(), sid = "test-share", requests: string[] = [];
  const ownerJwe = await encryptJwe(utf8(JSON.stringify({ resourceType: "Bundle", entry: [] })), key);
  let link: any;
  const server = Bun.serve({ port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/owner.jwe")) return new Response(ownerJwe);
    if (req.method === "GET") return Response.json({ id: sid, links: link ? [link] : [] });
    const bodyText = await req.text();
    requests.push(bodyText);
    const body = JSON.parse(bodyText);
    if (Object.hasOwn(body, "label")) return Response.json({ error: "plaintext label" }, { status: 400 });
    if (req.method === "POST") link = { id: "link-id", url: "https://host.example/shl/link-id/bundle.jwe", flag: "U", exp: null, labelEncrypted: body.labelEncrypted };
    else if (Object.hasOwn(body, "labelEncrypted") && (!body.migrateLabel || (link.label != null && !link.labelEncrypted))) {
      link = { ...link, labelEncrypted: body.labelEncrypted };
      delete link.label;
    }
    return Response.json(link);
  } });
  const base = server.url.origin;
  const fresh = () => new ShareApi(base, { sid, token: "control-token", ownerKey: key });
  try {
    await run({ api: fresh(), fresh, wire: () => structuredClone(link), requests, key, base, legacy: () => {
      link = { id: "link-id", url: "https://host.example/shl/link-id/bundle.jwe", label: "Legacy recipient", labelEncrypted: null };
    } });
  } finally { server.stop(true); }
}

test("create, edit, fresh owner browser and SHLink use one label without sending its plaintext", () => fixture(async (f) => {
  const original = "For Dr. Patel", renamed = "Wrist review — García";
  const link = await f.api.createLink({ label: original, exp: null, longLived: false, allowedFiles: [] });
  expect(link.label).toBe(original);
  expect(f.wire().label).toBeUndefined();
  expect(f.wire().labelEncrypted.v).toBe(1);
  const oldUrl = await shlinkFor(link, f.key, "https://viewer.example/");
  const edited = await f.api.patchLink(link.id, { label: renamed });
  expect(edited.label).toBe(renamed);
  expect((await f.fresh().getShare()).links[0].label).toBe(renamed);
  const newUrl = await shlinkFor(edited, f.key, "https://viewer.example/");
  const payload = (s: string) => JSON.parse(fromUtf8(b64urlDecode(s.split("shlink:/")[1])));
  expect(payload(oldUrl).label).toBe(original);
  expect(payload(newUrl).label).toBe(renamed);
  expect(payload(oldUrl).key).toBe(payload(newUrl).key);
  expect(payload(oldUrl).url).toBe(payload(newUrl).url);
  for (const body of f.requests) {
    expect(body).not.toContain(original);
    expect(body).not.toContain(renamed);
    expect(body).not.toContain(f.key);
    expect(JSON.parse(body).label).toBeUndefined();
  }
  await expect(new ShareApi(f.base, { sid: "test-share", token: "control-token", ownerKey: randomKeyB64() }).getShare()).rejects.toThrow();
  await f.api.patchLink(link.id, { online: true });
  expect((await f.fresh().getShare()).links[0].label).toBe(renamed);
  await f.api.patchLink(link.id, { label: null });
  expect(f.wire().labelEncrypted).toBeNull();
  expect((await f.fresh().getShare()).links[0].label).toBeNull();
}));

test("legacy labels migrate with a verified owner key and are never sent back in plaintext", () => fixture(async (f) => {
  f.legacy();
  const share = await f.api.getShare();
  expect(share.links[0].label).toBe("Legacy recipient");
  expect(f.wire().label).toBeUndefined();
  expect(await decryptLabel(f.wire().labelEncrypted, f.key, "test-share")).toBe("Legacy recipient");
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).not.toContain("Legacy recipient");
  expect((await f.fresh().getShare()).links[0].label).toBe("Legacy recipient");
  expect(f.requests).toHaveLength(1);
}));

test("a wrong owner key cannot migrate a legacy label", () => fixture(async (f) => {
  f.legacy();
  const wrong = new ShareApi(f.base, { sid: "test-share", token: "control-token", ownerKey: randomKeyB64() });
  await expect(wrong.getShare()).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
  expect(f.wire().label).toBe("Legacy recipient");
}));
