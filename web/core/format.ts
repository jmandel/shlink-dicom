// Display formatting shared by the experiences.

/** "MANDEL^JOSHUA^^" → "Joshua Mandel"; FHIR text passes through. */
export function formatPersonName(raw: string | null | undefined): string {
  if (!raw) return "";
  if (!raw.includes("^")) return raw.trim();
  const parts = raw.split("^").map((p) => p.trim()).filter(Boolean);
  const tc = (w: string) => w.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
  if (parts.length >= 2) return `${parts.slice(1).map(tc).join(" ")} ${tc(parts[0])}`;
  return tc(parts[0] ?? "");
}

/** "2020-07-29…" or "20200729" → "29 Jul 2020" (the reader's locale order). */
export function formatDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }): string {
  if (!iso) return "";
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

const MODALITY: Record<string, string> = {
  CT: "CT", MR: "MRI", CR: "X-ray", DX: "X-ray", DR: "X-ray", MG: "Mammogram", US: "Ultrasound",
  PT: "PET", NM: "Nuclear medicine", XA: "Angiography", RF: "Fluoroscopy", OT: "Other",
  SM: "Slide", SR: "Report", SEG: "Segmentation", KO: "Key images", PR: "Presentation state",
};

export function modalityName(m: string | null | undefined): string {
  return (m && MODALITY[m]) || m || "Imaging";
}

/** A study title in plain words: its description, else "MRI" / "X-ray" from its modalities. */
export function studyTitle(study: { description: string | null; modalities: string[] }): string {
  const d = study.description?.trim();
  if (d) return d.charAt(0) + d.slice(1);
  return study.modalities.map(modalityName).join(" + ") || "Imaging study";
}
