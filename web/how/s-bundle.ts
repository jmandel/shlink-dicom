// Step 3: the FHIR Bundle. Its entries, trimmed to one line each, and an excerpt of the
// DiagnosticReport for the MRI study.
import { reportsForStudy } from "../core/index";
import { code, excerpt, h, n, para, S } from "./state";

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** One line per entry: its type, id and a name. */
function entryLine(r: any): string {
  const name =
    r.resourceType === "Patient"
      ? r.name?.[0] && `${r.name[0].family ?? ""}^${(r.name[0].given ?? []).join(" ")}`
      : r.resourceType === "ImagingStudy"
        ? r.description
        : r.resourceType === "DiagnosticReport"
          ? r.code?.text ?? r.code?.coding?.[0]?.display
          : "";
  return `    { "resourceType": "${r.resourceType}", "id": "${r.id}"${name ? `, … ${JSON.stringify(name)}` : ""} }`;
}

/** The raw DiagnosticReport for the MRI study, if the sample has one. */
export function mriReport(): any | null {
  const idx = S.share!.index;
  const rep = reportsForStudy(idx, S.study!)[0];
  if (!rep) return null;
  return idx.bundle.entry.map((e: any) => e.resource).find((r: any) => r?.resourceType === "DiagnosticReport" && r.id === rep.id) ?? null;
}

export function mountBundle(pic: HTMLElement, exact: HTMLElement) {
  const b = S.share!.index.bundle;
  const entries = (b.entry ?? []).map((e: any) => e.resource).filter(Boolean);
  const lines = ["{", `  "resourceType": "Bundle",`, `  "type": "${b.type}",`, `  "entry": [`, ...entries.map(entryLine), "  ]", "}"];
  const mri = S.study!.id;
  const report = mriReport();
  const kids: (HTMLElement | string)[] = [
    h("p", { class: "cap", text: `The FHIR Bundle, one line per entry (${entries.length} entries):` }),
    excerpt(lines.join("\n"), [new RegExp(`"id": "${mri}"`), ...(report ? [new RegExp(`"id": "${report.id}"`)] : [])], "The FHIR Bundle's entries"),
  ];
  if (report) {
    const conclusion = report.conclusion ?? "";
    const ex = {
      resourceType: "DiagnosticReport",
      id: report.id,
      status: report.status,
      code: { text: report.code?.text ?? report.code?.coding?.[0]?.display },
      imagingStudy: report.imagingStudy,
      conclusion: conclusion ? clip(conclusion, 140) : undefined,
      presentedForm: (report.presentedForm ?? []).map((f: any) => ({ contentType: f.contentType, data: f.data ? `… ${n(f.data.length)} base64 characters` : undefined })),
    };
    kids.push(h("p", { class: "cap", text: "The MRI's DiagnosticReport, the radiology report, trimmed:" }), excerpt(JSON.stringify(ex, null, 2), [/"imagingStudy"/, /"reference"/, /"conclusion"/], "The DiagnosticReport"));
  }
  pic.replaceChildren(...kids);

  const patient = entries.find((r: any) => r.resourceType === "Patient");
  exact.replaceChildren(
    para("A FHIR Bundle of type ", code(String(b.type)), " is a plain list of resources. A client that knows only SMART Health Links can read it as it would any FHIR data: the Patient, the reports, and each ImagingStudy's series and instances."),
    para("The Patient, in full:"),
    h("pre", { class: "code", text: JSON.stringify(patient, null, 2) }),
    ...(report ? [para("The DiagnosticReport refers to the ImagingStudy by its entry's ", code("fullUrl"), ". Its ", code("presentedForm"), " carries the report itself, here as an attachment inside the Bundle.")] : []),
  );
}
