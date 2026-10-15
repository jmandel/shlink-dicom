// Build step for /how (called from web/build.ts with the build's output directory):
//
//   assets/how-worker.js   the page's worker (receiver, test vector, decoder comparison)
//   how/receiver.mjs       the reference receiver, as shown on the page
//   how/bench/             three test images and the C decoders for the comparison
//
// The files come from web/how/data (see its LICENSES.txt).
import { cpSync, mkdirSync } from "node:fs";

export async function bakeHow(root: string, out: string) {
  const dir = `${out}/how`;
  const data = `${root}web/how/data`;
  mkdirSync(`${dir}/bench`, { recursive: true });

  const w = await Bun.build({
    entrypoints: [`${root}web/how/worker.ts`],
    outdir: `${out}/assets`,
    target: "browser",
    format: "esm",
    minify: process.env.MINIFY !== "0",
    naming: "how-worker.[ext]",
  });
  if (!w.success) {
    for (const l of w.logs) console.error(l);
    throw new Error("how-worker build failed");
  }

  cpSync(`${root}web/how/receiver.js`, `${dir}/receiver.mjs`);
  cpSync(`${data}/bench`, `${dir}/bench`, { recursive: true });
  cpSync(`${data}/cwasm`, `${dir}/bench`, { recursive: true });
  cpSync(`${data}/LICENSES.txt`, `${dir}/LICENSES.txt`);
}
