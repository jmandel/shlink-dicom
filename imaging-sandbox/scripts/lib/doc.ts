// A report document as a list of blocks. pdf.ts renders it as a PDF and
// renderText() as the text/plain attachment, with the same words in the
// same order (checked by test/data-check.ts).

export type Block =
  | { kind: "letterhead"; name: string; lines: string[]; title: string }
  | { kind: "fields"; rows: [string, string][][] } // rows of up to two label/value pairs
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string; bold?: boolean; indent?: number }
  | { kind: "list"; items: string[] } // numbered
  | { kind: "signature"; lines: string[] }
  | { kind: "note"; text: string }; // small grey print

export interface Doc {
  title: string; // PDF document title
  blocks: Block[];
  footer: string; // printed on every PDF page, and once at the end of the text
}

const WIDTH = 78;

function wrap(text: string, width = WIDTH, indent = ""): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : `${indent}${word}`;
    if (next.length > width && line) { out.push(line); line = `${indent}${word}`; }
    else line = next;
  }
  if (line) out.push(line);
  return out;
}

export function renderText(doc: Doc): string {
  const L: string[] = [];
  for (const b of doc.blocks) {
    switch (b.kind) {
      case "letterhead":
        L.push(b.name, ...b.lines, "", b.title, "");
        break;
      case "fields":
        for (const row of b.rows) L.push(row.map(([k, v]) => `${k}: ${v}`.padEnd(38)).join(" ").trimEnd());
        L.push("");
        break;
      case "heading":
        if (L.length && L[L.length - 1] !== "") L.push("");
        L.push(b.text);
        break;
      case "para":
        L.push(...wrap(b.text, WIDTH, b.indent ? "   " : ""));
        if (!b.indent) L.push("");
        break;
      case "list":
        b.items.forEach((item, i) => wrap(`${i + 1}. ${item}`, WIDTH - 3).forEach((l, j) => L.push(j ? `   ${l}` : l)));
        L.push("");
        break;
      case "signature":
        L.push("", ...b.lines, "");
        break;
      case "note":
        L.push(...wrap(b.text), "");
        break;
    }
  }
  L.push("", doc.footer, "");
  return L.join("\n");
}
