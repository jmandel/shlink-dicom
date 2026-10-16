// Shares a folder of DICOM files on a server with the Share page's packer (offset tables added),
// for files the server's seed can't pack (JPEG XL). Prints the viewer link.
//   bun perf/sessions/share-files.ts <base> <dir> [label]
import { readdirSync, readFileSync } from "node:fs";
import { packAndShare } from "../../web/checks/pack-share";
const [base, dir, label = "perf sessions"] = process.argv.slice(2);
if (base.startsWith("https")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const files = readdirSync(dir).filter((f) => f.endsWith(".dcm")).map((f) => ({ name: f, bytes: new Uint8Array(readFileSync(`${dir}/${f}`)) }));
const s = await packAndShare(base, files, { addOffsetTables: true });
const { shlink } = await s.mint(s.bundle, { label });
console.log(shlink.slice(shlink.indexOf("shlink:/")));
