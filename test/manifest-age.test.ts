// bun test test/manifest-age.test.ts: in manifest mode the resolver (web/core/resolver.ts) asks
// for the manifest again before using a location an hour after it was given (SMART Health Links),
// not only after a 403 or 404.
import { describe, expect, test } from "bun:test";
import { encodeShlink } from "../web/core/shlink";
import { LinkResolver, LOCATION_MAX_AGE_MS } from "../web/core/resolver";
import { encryptJwe, randomKeyB64 } from "../web/core/jwe";
import { planBytes } from "../web/core/range";

async function setup() {
  const key = randomKeyB64();
  const jwe = await encryptJwe(new TextEncoder().encode(JSON.stringify({ resourceType: "Bundle", type: "collection", entry: [] })), key);
  let clock = 1_000_000, manifests = 0;
  const reads: string[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      manifests++;
      return new Response(JSON.stringify({ files: [{ contentType: "application/fhir+json", location: `https://host.example/cap/${manifests}/bundle.jwe` }] }));
    }
    if (String(url).includes("bundle.jwe")) return new Response(jwe);
    reads.push(String(url).split("?")[0]);
    return new Response(new Uint8Array(32), { status: 206 });
  }) as any;
  const link = encodeShlink({ url: "https://host.example/shl/x", key, v: 1 });
  const r = await LinkResolver.fromLink(link, { fetch, now: () => clock });
  await r.open();
  const series: any = { file: { fileId: "F", plaintextLength: 16, ciphertextLength: 32 } };
  const plan = planBytes(series, 0, 16);
  return { r, plan, tick: (ms: number) => (clock += ms), manifests: () => manifests, reads };
}

describe("manifest locations", () => {
  test("are used while younger than the limit", async () => {
    const s = await setup();
    s.tick(LOCATION_MAX_AGE_MS - 1000);
    await s.r.fetchRange(s.plan);
    expect(s.manifests()).toBe(1);
    expect(s.reads).toEqual(["https://host.example/cap/1/F.bin"]);
  });
  test("are renewed once older than the limit, before the read", async () => {
    const s = await setup();
    s.tick(LOCATION_MAX_AGE_MS + 1000);
    await s.r.fetchRange(s.plan);
    expect(s.manifests()).toBe(2);
    expect(s.reads).toEqual(["https://host.example/cap/2/F.bin"]);
  });
  test("the limit is under the SHL hour", () => expect(LOCATION_MAX_AGE_MS).toBeLessThan(60 * 60 * 1000));
});
