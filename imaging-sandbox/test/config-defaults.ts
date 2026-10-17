// With no SHARE_REDIRECT_URIS, the Share page's local callback (…/share/smart-callback/, with the
// trailing slash web/share/lib/sources.ts sends) is registered.
//   bun test/config-defaults.ts
import { loadConfig } from "../src/config.ts";

const share = loadConfig({}).clients.find((c) => c.client_id === "shlink-dicom-share");
const uris = share?.redirect_uris ?? [];
const want = "http://localhost:3000/share/smart-callback/";
const ok = uris.includes(want);
console.log(`${ok ? "ok  " : "FAIL"} default redirect URIs include ${want}: ${JSON.stringify(uris)}`);
process.exit(ok ? 0 : 1);
