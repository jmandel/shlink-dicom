// The auth server's sweep drops grants nothing can use any more, and keeps the rest.
//   bun test/auth-sweep.ts
import { AuthServer } from "../src/auth.ts";

const srv = new AuthServer({ baseUrl: "http://localhost:0" } as any, {} as any) as any;
const t = Math.floor(Date.now() / 1000);
srv.grants.set("old", { revoked: false, exp: t - 7200 });
srv.grants.set("live", { revoked: false, exp: t + 600 });
srv.grants.set("recent", { revoked: true, exp: t - 60 });
srv.grants.set("unexchanged", { revoked: false, exp: 0 });
srv.codes.set("c", { code: "c", grant: { id: "unexchanged" }, exp: t + 60 });
srv.sweep();
const left = [...srv.grants.keys()].sort().join(",");
const want = "live,recent,unexchanged";
console.log(left === want ? `ok   grants swept: ${left}` : `FAIL grants left: ${left} (want ${want})`);
process.exit(left === want ? 0 : 1);
