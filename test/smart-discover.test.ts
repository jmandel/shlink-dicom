// bun test test/smart-discover.test.ts: SMART discovery (web/share/lib/smart.ts) accepts only https
// addresses for the portal, its imaging server and its authorization and token endpoints (http only
// on this machine), since the portal's token goes to them.
import { afterEach, describe, expect, test } from "bun:test";
import { discover, secureUrl } from "../web/share/lib/smart";

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

/** A portal whose SMART configuration is `conf` (merged over a valid one). */
function portal(conf: Record<string, unknown>) {
  const base = {
    capabilities: ["smart-imaging-access", "http://fhir.org/argonaut/smart-imaging/capabilities/app-launch"],
    code_challenge_methods_supported: ["S256"],
    authorization_endpoint: "https://portal.example/auth",
    token_endpoint: "https://portal.example/token",
  };
  globalThis.fetch = (async () => new Response(JSON.stringify({ ...base, ...conf }), { headers: { "content-type": "application/json" } })) as any;
}

describe("secureUrl", () => {
  test("https is accepted", () => expect(secureUrl("https://portal.example/fhir", "address")).toBe("https://portal.example/fhir"));
  test("http on this machine is accepted", () => {
    for (const u of ["http://localhost:3334/fhir", "http://127.0.0.1:3334/fhir", "http://[::1]:3334/fhir"]) expect(secureUrl(u, "address")).toBe(u);
  });
  test("http elsewhere is refused", () => expect(() => secureUrl("http://portal.example/fhir", "address")).toThrow("https"));
  test("other schemes are refused", () => expect(() => secureUrl("javascript:alert(1)", "address")).toThrow());
  test("garbage is refused", () => expect(() => secureUrl("not a url", "address")).toThrow("valid"));
});

describe("discover", () => {
  test("a portal on https is accepted", async () => {
    portal({});
    expect((await discover("https://portal.example/fhir")).imagingBase).toBe("https://portal.example/fhir");
  });
  test("a portal on plain http is refused before any request", async () => {
    let asked = false;
    globalThis.fetch = (async () => ((asked = true), new Response("{}"))) as any;
    await expect(discover("http://portal.example/fhir")).rejects.toThrow("https");
    expect(asked).toBe(false);
  });
  for (const [what, conf] of [
    ["authorization endpoint", { authorization_endpoint: "http://evil.example/auth" }],
    ["token endpoint", { token_endpoint: "http://evil.example/token" }],
    ["imaging server", { capabilities: [], associated_endpoints: [{ url: "http://evil.example/dicomweb", capabilities: ["smart-imaging-access", "http://fhir.org/argonaut/smart-imaging/capabilities/app-launch"] }] }],
  ] as const) {
    test(`an ${what} on plain http is refused`, async () => {
      portal(conf);
      await expect(discover("https://portal.example/fhir")).rejects.toThrow("https");
    });
  }
});
