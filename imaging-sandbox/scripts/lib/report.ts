// Builds a sample radiology report as lines of text. The same lines become
// the text/plain attachment and the body of the PDF, so the two match.

import type { PdfLine } from "./pdf.ts";

export const BANNER = "SAMPLE REPORT FOR DEMONSTRATION. NOT A CLINICAL INTERPRETATION.";
export const WIDTH = 84; // Courier 10 pt across a 504 pt text column

export interface ReportInput {
  kind?: "radiology" | "pathology"; // default radiology
  title: string;
  code: { system: string; code: string; display: string };
  indication: string;
  comparison: string;
  techniqueIntro: string;
  findings: string[];
  impression: string[];
  imageSource?: string; // attribution for images from a public collection
}

export interface ReportContext {
  patientName: string; // "RIVERA, MORGAN"
  birthDate: string;
  mrn: string;
  accession: string;
  examDateTime: string; // "2020-07-29 07:42"
  equipment: string;
  series: { number?: number; description: string; images: number; unit?: [string, string] }[];
}

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

export function reportLines(r: ReportInput, c: ReportContext): PdfLine[] {
  const L: PdfLine[] = [];
  const body = (t: string) => L.push({ text: t, style: "body" });
  const heading = (t: string) => { body(""); L.push({ text: t, style: "heading" }); };
  const kv = (k: string, v: string) => wrap(v, WIDTH - 16).forEach((t, i) => body(`${(i ? "" : k + ":").padEnd(16)}${t}`));

  L.push({ text: `${r.kind === "pathology" ? "PATHOLOGY" : "RADIOLOGY"} REPORT: ${r.title}`, style: "title" });
  body("Imaging sandbox, demonstration data");
  body("");
  kv("Patient", c.patientName);
  kv("Date of birth", c.birthDate);
  kv("MRN", c.mrn);
  kv("Accession", c.accession);
  kv("Exam date", c.examDateTime);
  kv("Exam", `${r.title} (LOINC ${r.code.code}, ${r.code.display})`);
  kv("Equipment", c.equipment);

  heading("CLINICAL INDICATION (illustrative)");
  wrap(r.indication).forEach(body);

  heading("TECHNIQUE");
  const perInstance = c.series.some((x) => x.unit);
  wrap(`${r.techniqueIntro} ${perInstance ? "Instances" : "Series"} in this study, from the DICOM headers:`).forEach(body);
  for (const s of c.series) {
    const n = s.number === undefined ? "" : String(s.number);
    const [one, many] = s.unit ?? ["image", "images"];
    body(`  ${s.unit ? "Instance" : "Series"} ${n.padEnd(4)}${s.description.padEnd(28)}${s.images} ${s.images === 1 ? one : many}`);
  }

  heading("COMPARISON");
  wrap(r.comparison).forEach(body);

  heading("FINDINGS (illustrative, not an interpretation of these images)");
  for (const f of r.findings) wrap(f).forEach(body);

  heading("IMPRESSION (illustrative)");
  r.impression.forEach((t, i) => wrap(`${i + 1}. ${t}`, WIDTH - 3).forEach((l, j) => body(j ? `   ${l}` : l)));

  if (r.imageSource) {
    heading("IMAGE SOURCE");
    wrap(r.imageSource).forEach(body);
  }

  body("");
  wrap(
    "The imaging sandbox generated this sample report to demonstrate report exchange. Its indication, findings and impression are illustrative: no one produced them by reading these images.",
  ).forEach(body);
  for (const l of L) if (l.text.length > WIDTH) throw new Error(`report line too long: ${l.text}`);
  return L;
}

export function reportText(lines: PdfLine[]): string {
  return [BANNER, "", ...lines.map((l) => l.text), "", BANNER, ""].join("\n");
}

export function conclusion(r: ReportInput): string {
  return `${BANNER} Illustrative impression: ${r.impression.join(" ")}`;
}
