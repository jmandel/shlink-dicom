// Minimal PDF 1.4 writer for plain text reports: US Letter pages, the
// standard 14 fonts (no embedding), uncompressed content streams, and a
// correct cross-reference table. Output is deterministic: no dates or IDs.

export interface PdfLine {
  text: string; // ASCII only
  style: "title" | "heading" | "body";
}

export interface PdfOptions {
  title: string;
  banner: string; // printed at the top and bottom of every page
  lines: PdfLine[];
}

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 44;
const LEADING = 11.5;

function esc(s: string): string {
  if (/[^\x20-\x7e]/.test(s)) throw new Error(`non-ASCII text in PDF: ${JSON.stringify(s)}`);
  return s.replace(/[\\()]/g, (c) => `\\${c}`);
}

export function buildPdf(o: PdfOptions): Uint8Array {
  const top = PAGE_H - MARGIN - 44; // below the banner box
  const bottom = MARGIN + 30; // above the footer
  const perPage = Math.floor((top - bottom) / LEADING);
  const pages: PdfLine[][] = [];
  for (let i = 0; i < o.lines.length; i += perPage) pages.push(o.lines.slice(i, i + perPage));
  if (pages.length === 0) pages.push([]);

  const streams = pages.map((lines, p) => {
    const ops: string[] = [];
    // Banner box at the top.
    ops.push("0.6 0 0 RG 1 w", `${MARGIN} ${PAGE_H - MARGIN - 22} ${PAGE_W - 2 * MARGIN} 22 re S`);
    ops.push("BT 0.6 0 0 rg /F3 10 Tf", `${MARGIN + 8} ${PAGE_H - MARGIN - 15} Td (${esc(o.banner)}) Tj ET`);
    // Body.
    let y = top;
    for (const l of lines) {
      if (l.text !== "") {
        const font = l.style === "title" ? "/F3 13" : l.style === "heading" ? "/F2 10" : "/F1 10";
        ops.push(`BT 0 0 0 rg ${font} Tf ${MARGIN} ${y.toFixed(2)} Td (${esc(l.text)}) Tj ET`);
      }
      y -= LEADING;
    }
    // Footer.
    ops.push("0.6 0 0 RG 0.5 w", `${MARGIN} ${MARGIN + 16} m ${PAGE_W - MARGIN} ${MARGIN + 16} l S`);
    ops.push(`BT 0.6 0 0 rg /F3 8 Tf ${MARGIN} ${MARGIN + 4} Td (${esc(o.banner)}) Tj ET`);
    ops.push(`BT 0 0 0 rg /F1 8 Tf ${PAGE_W - MARGIN - 66} ${MARGIN + 4} Td (${esc(`Page ${p + 1} of ${pages.length}`)}) Tj ET`);
    return ops.join("\n") + "\n";
  });

  // Object numbers: 1 catalog, 2 pages, 3-5 fonts, 6 info, then page/content pairs.
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 7 + 2 * i);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>";
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objs[6] = `<< /Title (${esc(o.title)}) /Producer (imaging-sandbox scripts/lib/pdf.ts) >>`;
  streams.forEach((s, i) => {
    objs[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
    objs[pageIds[i] + 1] = `<< /Length ${s.length} >>\nstream\n${s}endstream`;
  });

  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Latin-1: every char is one byte, so string offsets are byte offsets.
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}
