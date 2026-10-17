// FHIR DiagnosticReports shown next to the images: title, status and date, the conclusion, and
// each presentedForm attachment (PDF pages, plain text). Reports come from the clinical record and
// images from the imaging system; the view says so, and says how the report was matched.
import type { ReportAttachment, ReportEntry } from "../core/bundle";
import { formatBytes, formatDate } from "../core/format";
import { linkBasisText, type ReportLink } from "../core/reports";
import { saveBlob } from "../core/save";
import { renderPdf } from "./pdf-view";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const isPdf = (a: ReportAttachment) => /^application\/pdf/i.test(a.contentType);
const isText = (a: ReportAttachment) => /^text\/plain/i.test(a.contentType);
const isHtml = (a: ReportAttachment) => /^text\/html/i.test(a.contentType);

function charsetOf(ct: string): string {
  return /charset=([\w-]+)/i.exec(ct)?.[1] ?? "utf-8";
}

/** Short heading line for a report: title · date · status when not final. */
export function reportHeading(r: ReportEntry): string {
  const date = r.effective ?? r.issued;
  return [r.title ?? "Report", date ? formatDate(date) : null, r.status !== "final" ? r.status : null].filter(Boolean).join(" · ");
}

/**
 * The full view of one or more reports into `box`. Attachments are rendered as they are opened;
 * `signal` stops PDF rendering when the view closes.
 */
export function renderReports(box: HTMLElement, links: ReportLink[], signal?: AbortSignal) {
  box.textContent = "";
  for (const l of links) {
    const r = l.report;
    const sec = el("section", "report-doc");
    sec.dataset.report = r.id;
    sec.append(el("h2", "report-title", reportHeading(r)));
    sec.append(el("p", "report-source", `From the clinical record. ${linkBasisText(l.basis)}`.trim()));
    if (l.basis === "date") sec.querySelector(".report-source")!.classList.add("report-guess");
    if (r.conclusion) {
      sec.append(el("h3", "report-h", "Conclusion"));
      sec.append(el("p", "report-conclusion", r.conclusion));
    }
    const forms = r.attachments;
    if (forms.length) {
      const tabs = el("div", "report-tabs");
      tabs.setAttribute("role", "tablist");
      const body = el("div", "report-body");
      const show = (k: number) => {
        tabs.querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-selected", String(i === k)));
        void renderAttachment(body, forms[k], r, signal);
      };
      forms.forEach((a, k) => {
        const b = el("button", "btn report-tab", isPdf(a) ? "PDF" : isText(a) ? "Text" : isHtml(a) ? "Page" : a.contentType.split(";")[0]);
        b.type = "button";
        b.setAttribute("role", "tab");
        b.addEventListener("click", () => show(k));
        tabs.append(b);
      });
      if (forms.length > 1) sec.append(tabs);
      sec.append(body);
      // Text first when there is one: it reads well at any width; the PDF is a tab away.
      const first = forms.findIndex(isText);
      show(first >= 0 ? first : 0);
    } else if (r.text) {
      sec.append(el("pre", "report-text", r.text));
    }
    box.append(sec);
  }
}

async function renderAttachment(body: HTMLElement, a: ReportAttachment, r: ReportEntry, signal?: AbortSignal) {
  body.textContent = "";
  const name = `${(r.title ?? "report").replace(/[^\w.-]+/g, "-")}${isPdf(a) ? ".pdf" : isText(a) ? ".txt" : ""}`;
  if (!a.data) {
    const p = el("p", "muted", "This part of the report is stored elsewhere. ");
    if (a.url && /^https?:/i.test(a.url)) {
      const link = el("a", undefined, "Open it in a new tab");
      link.href = a.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      p.append(link);
      p.append(document.createTextNode(" (it may ask you to sign in)."));
    }
    body.append(p);
    return;
  }
  const dl = el("button", "btn report-dl", `Download${a.size ? ` (${formatBytes(a.size)})` : ""}`);
  dl.type = "button";
  dl.addEventListener("click", () => saveBlob(new Blob([a.data as BlobPart], { type: a.contentType }), name));
  if (isPdf(a)) {
    const pages = el("div", "pdf-pages");
    pages.append(el("p", "muted small", "Loading the PDF…"));
    body.append(pages, dl);
    try {
      await renderPdf(pages, a.data, signal);
    } catch (e) {
      pages.textContent = "";
      pages.append(el("p", "muted", "This PDF can't be shown here. Download it to open it."));
    }
  } else if (isText(a) || isHtml(a)) {
    let t = new TextDecoder(charsetOf(a.contentType)).decode(a.data);
    if (isHtml(a)) t = new DOMParser().parseFromString(t, "text/html").body.textContent ?? "";
    body.append(el("pre", "report-text", t), dl);
  } else {
    body.append(el("p", "muted", `A ${a.contentType.split(";")[0]} file. Download it to open it.`), dl);
  }
}
