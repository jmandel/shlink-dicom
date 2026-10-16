// Byte views: bytes as hex with their decoding directly beneath, column for column. Each byte is
// a grid column holding its hex pair; a text field puts each character under its own pair, and a
// number or tag field puts its decoding under all of its bytes. Fields wrap as units, so on a
// narrow screen they stack, each still aligned.
import { h, hex } from "./state";

export interface Field {
  /** What the field is (shown small above it), e.g. "tag", "VR", "length", "value". */
  name: string;
  bytes: Uint8Array;
  /** Decoding shown under all the field's bytes. Omit with `chars` to show one character per byte. */
  decoded?: string;
  /** Show each byte's character under it (printable ASCII; others as ·). */
  chars?: boolean;
}

const BYTES_PER_ROW = 8;

const char = (b: number) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·");

/** One row of fields, e.g. one DICOM element or one JPEG marker segment. */
export function byteRow(title: string, fields: Field[]): HTMLElement {
  const row = h("div", { class: "brow", role: "group", "aria-label": title });
  row.append(h("div", { class: "brow-title", text: title }));
  const flow = h("div", { class: "bflow" });
  for (const f of fields) {
    // A long text field wraps onto further rows of BYTES_PER_ROW bytes, each still aligned.
    const chunks = f.chars ? Math.max(1, Math.ceil(f.bytes.length / BYTES_PER_ROW)) : 1;
    for (let c = 0; c < chunks; c++) {
      const part = f.chars ? f.bytes.subarray(c * BYTES_PER_ROW, (c + 1) * BYTES_PER_ROW) : f.bytes;
      const grid = h("div", { class: `bfield${f.chars ? " chars" : ""}`, style: `--n:${Math.max(1, part.length)}` });
      grid.append(h("span", { class: "bname", text: c === 0 ? f.name : `${f.name}, cont.` }));
      [...part].forEach((b, i) => {
        grid.append(h("span", { class: "bx", style: `grid-column:${i + 1}`, text: hex(Uint8Array.of(b)) }));
        if (f.chars) grid.append(h("span", { class: "bc", style: `grid-column:${i + 1}`, text: char(b) }));
      });
      if (!f.chars) grid.append(h("span", { class: "bd", text: f.decoded ?? "" }));
      flow.append(grid);
    }
  }
  row.append(flow);
  return row;
}

/** A stack of rows under a caption. */
export function byteView(label: string, rows: HTMLElement[]): HTMLElement {
  return h("div", { class: "bview", "aria-label": label }, ...rows);
}

// Little-endian readers for the decodings.
export const u16le = (b: Uint8Array) => b[0] | (b[1] << 8);
export const u32le = (b: Uint8Array) => (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
export const u16be = (b: Uint8Array) => (b[0] << 8) | b[1];
