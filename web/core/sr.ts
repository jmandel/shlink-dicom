// Structured reports (PS3.3 C.17.3): the content tree as plain data, for a readable view.
// Works for text, enhanced and comprehensive SR, measurement reports (TID 1500) and radiation
// dose reports (TID 10001/10011). Image and coordinate references keep their SOP Instance UIDs
// and frame numbers so the viewer can link them.
import { codeOf, T, tag, type Code, type DataSet } from "./dicom";

export interface SrRef {
  sopClass: string;
  sopInstance: string;
  frames: number[];
  segments: number[];
}

export interface SrNode {
  /** CONTAINER, TEXT, CODE, NUM, DATE, TIME, DATETIME, PNAME, UIDREF, IMAGE, COMPOSITE, WAVEFORM, SCOORD, SCOORD3D, TCOORD. */
  valueType: string;
  /** CONTAINS, HAS PROPERTIES, HAS OBS CONTEXT, HAS ACQ CONTEXT, INFERRED FROM, SELECTED FROM, HAS CONCEPT MOD. */
  relationship: string;
  concept: Code | null;
  /** The value as text (empty for containers and references). */
  text: string;
  /** NUM: the number and its units. */
  num?: { value: number | null; units: Code | null; qualifier: Code | null };
  /** CODE value. */
  code?: Code;
  /** IMAGE / COMPOSITE / WAVEFORM references; SCOORD's image is in its child. */
  ref?: SrRef;
  /** SCOORD: graphic type and points (column, row pairs, in pixels). */
  scoord?: { type: string; points: number[] };
  /** By-reference content item (PS3.3 C.17.3.2.4), as an index path such as "1.2.3". */
  byReference?: string;
  children: SrNode[];
}

export interface SrDocument {
  title: Code | null;
  template: string | null;
  completion: string | null;
  verification: string | null;
  date: string | null;
  root: SrNode;
  /** Every image or object the report cites, with the node that cites it. */
  references: { ref: SrRef; node: SrNode }[];
}

const DATE = (v: string | null) => (v && /^\d{8}/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v ?? "");
const TIME = (v: string | null) => (v && /^\d{4}/.test(v) ? `${v.slice(0, 2)}:${v.slice(2, 4)}${v.length >= 6 ? ":" + v.slice(4, 6) : ""}` : v ?? "");

function readRef(item: DataSet): SrRef | null {
  const r = item.seq(T.ReferencedSOPSequence)[0];
  if (!r) return null;
  return {
    sopClass: r.str(T.ReferencedSOPClassUID) ?? "",
    sopInstance: r.str(T.ReferencedSOPInstanceUID) ?? "",
    frames: r.nums(T.ReferencedFrameNumber),
    segments: r.nums(T.ReferencedSegmentNumber),
  };
}

function readNode(item: DataSet, refs: SrDocument["references"], depth: number): SrNode {
  const vt = item.str(T.ValueType) ?? (item.has(T.ReferencedContentItemIdentifier) ? "BY REFERENCE" : "");
  const node: SrNode = {
    valueType: vt,
    relationship: item.str(T.RelationshipType) ?? "",
    concept: item.code(T.ConceptNameCodeSequence),
    text: "",
    children: [],
  };
  switch (vt) {
    case "TEXT":
      node.text = item.str(T.TextValue) ?? "";
      break;
    case "CODE": {
      const c = item.code(T.ConceptCodeSequence);
      if (c) {
        node.code = c;
        node.text = c.meaning || c.value;
      }
      break;
    }
    case "NUM": {
      const mv = item.seq(T.MeasuredValueSequence)[0];
      const value = mv ? mv.num(T.NumericValue) : null;
      const units = mv ? mv.code(T.MeasurementUnitsCodeSequence) : null;
      const qualifier = item.code(T.NumericValueQualifierCodeSequence);
      node.num = { value, units, qualifier };
      // UCUM code as the unit ("mm", "mGy.cm"); annotations in braces read better as their meaning.
      const unit = !units || units.value === "1" ? "" : !units.value.includes("{") ? units.value : units.meaning.includes("{") ? "" : units.meaning;
      const u = unit ? ` ${unit}` : "";
      node.text = value !== null ? `${mv!.str(T.NumericValue)}${u}` : qualifier ? qualifier.meaning : "no value";
      break;
    }
    case "DATE":
      node.text = DATE(item.str(T.Date));
      break;
    case "TIME":
      node.text = TIME(item.str(T.Time));
      break;
    case "DATETIME": {
      const v = item.str(T.DateTime) ?? "";
      node.text = `${DATE(v.slice(0, 8))}${v.length > 8 ? " " + TIME(v.slice(8)) : ""}`;
      break;
    }
    case "PNAME":
      node.text = (item.str(T.PersonName) ?? "").split("^").filter(Boolean).reverse().join(" ");
      break;
    case "UIDREF":
      node.text = item.str(T.UID) ?? "";
      break;
    case "IMAGE":
    case "COMPOSITE":
    case "WAVEFORM": {
      const ref = readRef(item);
      if (ref) {
        node.ref = ref;
        refs.push({ ref, node });
      }
      break;
    }
    case "SCOORD":
      node.scoord = { type: item.str(T.GraphicType) ?? "", points: item.nums(T.GraphicData) };
      break;
    case "SCOORD3D":
      node.scoord = { type: item.str(T.GraphicType) ?? "", points: item.nums(tag(0x0070, 0x0022)) };
      break;
    case "BY REFERENCE":
      node.byReference = item.nums(T.ReferencedContentItemIdentifier).join(".");
      break;
  }
  if (depth < 64) for (const c of item.seq(T.ContentSequence)) node.children.push(readNode(c, refs, depth + 1));
  return node;
}

export function readSr(ds: DataSet): SrDocument {
  const references: SrDocument["references"] = [];
  const root = readNode(ds, references, 0);
  root.valueType = "CONTAINER";
  const tpl = ds.seq(T.ContentTemplateSequence)[0];
  return {
    title: ds.code(T.ConceptNameCodeSequence),
    template: tpl ? `TID ${tpl.str(T.TemplateIdentifier) ?? "?"}` : null,
    completion: ds.str(T.CompletionFlag),
    verification: ds.str(T.VerificationFlag),
    date: DATE(ds.str(T.ContentDate)) || null,
    root,
    references,
  };
}

/** The node an SCOORD's image reference belongs to: SCOORD items carry their image as a child. */
export function scoordImage(node: SrNode): SrRef | null {
  return node.children.find((c) => c.valueType === "IMAGE")?.ref ?? null;
}

export { codeOf };
