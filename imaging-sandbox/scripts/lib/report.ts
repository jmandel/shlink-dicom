// Builds each study's synthetic report as a Doc (doc.ts): a radiology or
// surgical pathology report in the style of a hospital report, for the
// sample patient, from fictional clinicians and facilities in
// data/clinical.json. The content is in data/studies.json.

import type { Doc, Block } from "./doc.ts";

export const FOOTER = "Synthetic report written for this sample; not a clinical interpretation.";

export interface Code { system: string; code: string; display: string }

export interface ReportInput {
  kind?: "radiology" | "pathology"; // default radiology
  category?: Code;
  code: Code;
  title: string;
  indication: string;
  comparison?: string;
  technique?: string; // radiology: lead sentence; series from the headers follow
  findings?: string[]; // "Label: text"
  impression: string[];
  // pathology
  specimen?: string;
  gross?: string;
  microscopic?: string[];
  diagnosis?: string[];
  imageSource?: string; // attribution and provenance note for public images
}

export interface Practitioner { id: string; given: string[]; family: string; suffix?: string; role: string; organization: string }
export interface Organization { id: string; name: string; address: string[]; phone: string; department?: Record<string, string> }

export interface ReportContext {
  patient: { family: string; given: string[]; birthDate: string; gender: string; mrn: string };
  accession: string;
  examDateTime: string; // "2012-10-09 20:52 PDT"
  location: string; // "Emergency Department"
  equipment: string;
  series: { number?: number; description: string; images: number; unit?: [string, string] }[];
  orderedBy: Practitioner;
  readBy: Practitioner;
  signed: string; // "2012-10-09 21:34 PDT"
  facility: Organization;
}

export function practitionerName(p: Practitioner): string {
  return `${p.given.join(" ")} ${p.family}${p.suffix ? `, ${p.suffix}` : ""}`;
}

export function buildReport(r: ReportInput, c: ReportContext): Doc {
  const pathology = r.kind === "pathology";
  const dept = pathology ? "Department of Pathology" : "Department of Radiology";
  const sexText = { male: "M", female: "F", other: "O", unknown: "U" }[c.patient.gender] ?? c.patient.gender;
  const B: Block[] = [
    { kind: "letterhead", name: c.facility.name, lines: [dept, ...c.facility.address, `Tel ${c.facility.phone}`], title: pathology ? "SURGICAL PATHOLOGY REPORT" : "RADIOLOGY REPORT" },
    {
      kind: "fields",
      rows: [
        [["Patient", `${c.patient.family.toUpperCase()}, ${c.patient.given.join(" ").toUpperCase()}`], ["MRN", c.patient.mrn]],
        [["Date of birth", c.patient.birthDate], ["Sex", sexText]],
        [[pathology ? "Specimen" : "Exam", r.title]],
        [[pathology ? "Collected" : "Exam date", c.examDateTime], ["Accession", c.accession]],
        [["Location", c.location], ["Ordered by", practitionerName(c.orderedBy)]],
      ],
    },
  ];
  if (pathology) {
    B.push({ kind: "heading", text: "CLINICAL HISTORY" }, { kind: "para", text: r.indication });
    if (r.specimen) B.push({ kind: "heading", text: "SPECIMEN" }, { kind: "para", text: r.specimen });
    if (r.gross) B.push({ kind: "heading", text: "GROSS DESCRIPTION" }, { kind: "para", text: r.gross });
    const levels = c.series.map((s) => `${s.description}: ${s.images} ${s.images === 1 ? (s.unit ?? ["image", "images"])[0] : (s.unit ?? ["image", "images"])[1]}`);
    B.push({ kind: "heading", text: "MICROSCOPIC DESCRIPTION" }, ...(r.microscopic ?? []).map((t): Block => ({ kind: "para", text: t })));
    B.push({ kind: "para", text: `Whole-slide image, ${c.equipment}. Levels stored: ${levels.join("; ")}.` });
    B.push({ kind: "heading", text: "DIAGNOSIS" }, { kind: "list", items: r.diagnosis ?? r.impression });
  } else {
    B.push({ kind: "heading", text: "CLINICAL INDICATION" }, { kind: "para", text: r.indication });
    B.push({ kind: "heading", text: "COMPARISON" }, { kind: "para", text: r.comparison ?? "None." });
    B.push({ kind: "heading", text: "TECHNIQUE" }, { kind: "para", text: `${r.technique ?? ""} Performed on ${c.equipment}.`.trim() });
    for (const s of c.series) {
      const [one, many] = s.unit ?? ["image", "images"];
      B.push({ kind: "para", indent: 12, text: `Series ${s.number ?? ""}: ${s.description}, ${s.images} ${s.images === 1 ? one : many}` });
    }
    B.push({ kind: "heading", text: "FINDINGS" }, ...(r.findings ?? []).map((t): Block => ({ kind: "para", text: t })));
    B.push({ kind: "heading", text: "IMPRESSION" }, { kind: "list", items: r.impression });
  }
  B.push({ kind: "signature", lines: [practitionerName(c.readBy), `${c.readBy.role}, ${c.facility.name}`, `Electronically signed ${c.signed}`] });
  if (r.imageSource) B.push({ kind: "note", text: r.imageSource });
  return { title: `${pathology ? "Surgical pathology report" : "Radiology report"}: ${r.title}`, blocks: B, footer: FOOTER };
}

export function conclusion(r: ReportInput): string {
  return (r.kind === "pathology" ? r.diagnosis ?? r.impression : r.impression).join(" ");
}
