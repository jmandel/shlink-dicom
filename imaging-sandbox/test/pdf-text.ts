// Extracts the text of a PDF with PDF.js, one string per line, per page.

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { dirname, join } from "node:path";

const fonts = join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + "/";

export async function pdfPages(bytes: Uint8Array): Promise<string[][]> {
  const doc = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false, standardFontDataUrl: fonts, verbosity: 0 }).promise;
  const pages: string[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const item of content.items as any[]) {
      if (typeof item.str !== "string") continue;
      const y = Math.round(item.transform[5] * 10) / 10;
      const x = item.transform[4];
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y)!.push({ x, s: item.str });
    }
    pages.push(
      [...rows.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, parts]) => parts.sort((a, b) => a.x - b.x).map((q) => q.s).join(" ")),
    );
  }
  await doc.destroy();
  return pages;
}
