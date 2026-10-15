// Minimal PDF 1.4 writer for clinical-style reports: US Letter pages, the
// standard 14 Helvetica fonts (no embedding; widths below are the standard
// Helvetica metrics), uncompressed content streams and a correct
// cross-reference table. Output is deterministic: no dates or IDs.
//
// A report is a list of blocks (doc.ts). The same blocks render to the
// text/plain attachment, so the two carry the same words in the same order.

import type { Doc, Block } from "./doc.ts";

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const BODY = 9.5;
const LEADING = 12.5;

// Advance widths (per 1000 em) for ASCII 32..126.
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

type Face = "R" | "B";

export function textWidth(s: string, face: Face, size: number): number {
  const t = face === "B" ? W_BOLD : W_REG;
  let w = 0;
  for (const ch of s) w += t[ch.charCodeAt(0) - 32] ?? 556;
  return (w * size) / 1000;
}

function esc(s: string): string {
  if (/[^\x20-\x7e]/.test(s)) throw new Error(`non-ASCII text in PDF: ${JSON.stringify(s)}`);
  return s.replace(/[\\()]/g, (c) => `\\${c}`);
}

export function wrapWidth(text: string, face: Face, size: number, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, face, size) > width && line) { out.push(line); line = word; }
    else line = next;
  }
  if (line) out.push(line);
  return out;
}

export function buildPdf(doc: Doc): Uint8Array {
  const pages: string[][] = [[]];
  let y = PAGE_H - MARGIN;
  const ops = () => pages[pages.length - 1];
  const need = (h: number) => {
    if (y - h < MARGIN + 24) { pages.push([]); y = PAGE_H - MARGIN; }
  };
  const text = (x: number, yy: number, s: string, face: Face, size: number, gray = 0) => {
    if (!s) return;
    ops().push(`BT ${gray} g /${face === "B" ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td (${esc(s)}) Tj ET`);
  };
  const right = PAGE_W - MARGIN;
  const width = right - MARGIN;

  for (const b of doc.blocks) {
    switch (b.kind) {
      case "letterhead": {
        text(MARGIN, y - 16, b.name, "B", 16);
        y -= 22;
        for (const l of b.lines) { text(MARGIN, y - 9, l, "R", 8.5, 0.35); y -= 11; }
        y -= 6;
        ops().push(`0.2 G 1 w ${MARGIN} ${y.toFixed(2)} m ${right} ${y.toFixed(2)} l S`);
        y -= 20;
        text(MARGIN, y, b.title, "B", 12);
        y -= 10;
        break;
      }
      case "fields": {
        const rowH = 12;
        const h = b.rows.length * rowH + 10;
        need(h);
        ops().push(`0.94 g ${MARGIN} ${(y - h).toFixed(2)} ${width} ${h.toFixed(2)} re f`);
        let yy = y - 14;
        for (const row of b.rows) {
          row.forEach(([label, value], i) => {
            const x = MARGIN + 6 + i * (width / 2);
            text(x, yy, `${label}:`, "B", 8.5);
            text(x + 78, yy, value, "R", 8.5);
          });
          yy -= rowH;
        }
        y -= h + 8;
        break;
      }
      case "heading":
        need(LEADING * 3);
        y -= 8;
        text(MARGIN, y - BODY, b.text, "B", BODY);
        y -= LEADING;
        break;
      case "para":
        for (const l of wrapWidth(b.text, b.bold ? "B" : "R", BODY, width - (b.indent ?? 0))) {
          need(LEADING);
          text(MARGIN + (b.indent ?? 0), y - BODY, l, b.bold ? "B" : "R", BODY);
          y -= LEADING;
        }
        y -= 3;
        break;
      case "list":
        b.items.forEach((item, i) => {
          wrapWidth(item, "R", BODY, width - 16).forEach((l, j) => {
            need(LEADING);
            if (j === 0) text(MARGIN, y - BODY, `${i + 1}.`, "R", BODY);
            text(MARGIN + 16, y - BODY, l, "R", BODY);
            y -= LEADING;
          });
        });
        y -= 3;
        break;
      case "signature": {
        need(LEADING * 4);
        y -= 10;
        ops().push(`0.6 G 0.5 w ${MARGIN} ${y.toFixed(2)} m ${MARGIN + 220} ${y.toFixed(2)} l S`);
        y -= 4;
        for (const l of b.lines) { text(MARGIN, y - BODY, l, l === b.lines[0] ? "B" : "R", BODY); y -= LEADING; }
        break;
      }
      case "note":
        for (const l of wrapWidth(b.text, "R", 8, width)) {
          need(10);
          text(MARGIN, y - 8, l, "R", 8, 0.35);
          y -= 10;
        }
        y -= 4;
        break;
    }
  }

  const streams = pages.map((p, i) => {
    const foot = [
      `0.75 G 0.5 w ${MARGIN} ${MARGIN + 14} m ${right} ${MARGIN + 14} l S`,
      `BT 0.4 g /F1 7.5 Tf ${MARGIN} ${MARGIN + 4} Td (${esc(doc.footer)}) Tj ET`,
      `BT 0.4 g /F1 7.5 Tf ${(right - textWidth(`Page ${i + 1} of ${pages.length}`, "R", 7.5)).toFixed(2)} ${MARGIN + 4} Td (${esc(`Page ${i + 1} of ${pages.length}`)}) Tj ET`,
    ];
    return [...p, ...foot].join("\n") + "\n";
  });

  // Objects: 1 catalog, 2 pages, 3-4 fonts, 5 info, then page/content pairs.
  const objs: string[] = [];
  const pageIds = streams.map((_, i) => 6 + 2 * i);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${streams.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objs[5] = `<< /Title (${esc(doc.title)}) /Producer (imaging-sandbox scripts/lib/pdf.ts) >>`;
  streams.forEach((s, i) => {
    objs[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
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
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

export type { Block };
