// A passcode link to re-share in share-checks: packs the DICOM files in <dir> on <base> the way the
// Share page does and mints a link with passcode 4321. Prints { link, sid, token }.
//   bun web/checks/share-source.ts <base> <dir>
import { readdirSync, readFileSync } from "node:fs";
import { packAndShare } from "./pack-share";

const [base, dir] = process.argv.slice(2);
const files = readdirSync(dir).filter((f) => f.endsWith(".dcm")).sort().map((f) => ({ name: f, bytes: new Uint8Array(readFileSync(`${dir}/${f}`)) }));
const s = await packAndShare(base, files);
const { shlink } = await s.mint(s.bundle, { label: "Re-share source", passcode: "4321" });
console.log(JSON.stringify({ link: shlink, sid: s.sid, token: s.token }));
