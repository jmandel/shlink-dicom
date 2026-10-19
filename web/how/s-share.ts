// Step 10: a second link, then revocation. Makes a SMART Health Link to the MRI study only (on the
// visitor's own copy of the sample share), opens it, revokes it, and shows the next request
// failing. Uses the server's API as a sharer would (see web/checks/fixtures.ts).
import qrcode from "qrcode-generator";
import { decryptParams, encodeShlink, encryptJwe, LinkError, LinkResolver, parseIndex, planInstances, randomKeyB64, utf8, viewerUrl } from "../core/index";
import { drawThumbnail } from "../core/render";
import { h, linkButtons, n, para, reqRow, S } from "./state";

const RECIPIENT = "How it works, step 10";

export function mountShare(pic: HTMLElement, exact: HTMLElement) {
  const idx = S.share!.index;
  const make = h("button", { id: "sh-make", class: "btn btn-primary", type: "button", text: "Make a link to the MRI only", disabled: !S.sampleSid }) as HTMLButtonElement;
  const open = h("button", { id: "sh-open", class: "btn", type: "button", text: "Open it", disabled: true }) as HTMLButtonElement;
  const revoke = h("button", { id: "sh-revoke", class: "btn btn-danger", type: "button", text: "Revoke it", disabled: true }) as HTMLButtonElement;
  const result = h("div", { class: "share-result", "aria-live": "polite" });
  const plan = h(
    "ul",
    { class: "study-list" },
    ...idx.studies.map((st) => h("li", { class: st === S.study ? "this" : "out" }, h("strong", { text: st.description ?? st.modalities.join(", ") }), st === S.study ? " · in the new link" : " · left out")),
  );
  pic.replaceChildren(h("p", { class: "cap", text: "The new link will hold:" }), plan, h("div", { class: "row wrap controls" }, make, open, revoke), result);

  const facts = h("p");
  const log = h("div", { class: "reqs" });
  exact.replaceChildren(
    para("The new link has its own key and its own FHIR Bundle, which lists only the MRI's ImagingStudy and its DiagnosticReport. The encrypted file is not encrypted again: the new Bundle names the same file, with the same file key. The server is told which files the new link may serve."),
    para("Revoking deletes the link on the server, which then answers 404 for the link and for files under it. It stops new downloads; it can't take back what a recipient already has."),
    facts,
    para("The server's access log for your copy of the sample, as stored:"),
    log,
  );

  let sb: { sid: string; token: string; lid: string; shlink: string } | null = null;
  const api = (p: string) => `${S.cfg!.apiBase}${p}`;
  const j = async (r: Response) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const showLog = async () => {
    if (!sb) return;
    await new Promise((r) => setTimeout(r, 250));
    const { events } = await j(await fetch(api(`/api/shares/${sb.sid}/access`), { headers: { Authorization: `Bearer ${sb.token}` }, cache: "no-store" }));
    log.replaceChildren(...events.slice(0, 20).map((e: any) => reqRow({ method: e.method, url: new URL(e.path, location.origin).toString(), range: e.range ?? undefined, status: e.status, bytes: e.bytes, recipient: e.recipient }, true)));
  };

  make.addEventListener("click", async () => {
    make.disabled = true;
    try {
      // A copy of the sample share that this visitor controls: the same encrypted files, for 24 hours.
      const c = await j(await fetch(api(`/api/shares/${S.sampleSid}/clone`), { method: "POST" }));
      const keep = S.study!.id;
      // This ImagingStudy, and reports that refer to it (by entry fullUrl or ImagingStudy/id).
      const names = new Set([`ImagingStudy/${keep}`]);
      for (const e of idx.bundle.entry) if (e.resource?.resourceType === "ImagingStudy" && e.resource.id === keep && e.fullUrl) names.add(e.fullUrl);
      const bundle = {
        ...idx.bundle,
        entry: idx.bundle.entry.filter((e: any) => {
          const r = e.resource;
          if (r?.resourceType === "ImagingStudy") return r.id === keep;
          if (r?.resourceType === "DiagnosticReport" && Array.isArray(r.imagingStudy) && r.imagingStudy.length) return r.imagingStudy.some((x: any) => names.has(String(x.reference ?? "")));
          return true;
        }),
      };
      const files = S.study!.files.map((f) => `${f.fileId}.bin`);
      const label = `MRI only (${S.study!.description ?? "MRI"})`;
      const headers = { Authorization: `Bearer ${c.controlToken}`, "Content-Type": "application/json" };
      const link = await j(await fetch(api(`/api/shares/${c.share.id}/links`), { method: "POST", headers, body: JSON.stringify({ allowedFiles: files }) }));
      const key = randomKeyB64();
      const text = JSON.stringify(bundle);
      const jwe = await encryptJwe(utf8(text), key);
      const up = await j(await fetch(api(`/api/shares/${c.share.id}/links/${link.id}/bundle.jwe`), { method: "PUT", headers: { ...headers, "Content-Type": "application/jose" }, body: jwe }));
      sb = { sid: c.share.id, token: c.controlToken, lid: link.id, shlink: encodeShlink({ url: up.url, key, flag: up.flag ?? undefined, label, v: 1 }) };
      const url = viewerUrl(S.cfg!, sb.shlink);
      const qr = qrcode(0, "L");
      qr.addData(url);
      qr.make();
      const q = h("div", { class: "qr small-qr", role: "img", "aria-label": "QR code of your link" });
      q.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
      result.replaceChildren(h("p", { class: "status-line good", text: "A new link to the MRI only:" }), h("div", { class: "qr-row" }, q, linkButtons(url, "newlink")));
      const studies = (await parseIndex(bundle)).studies.length;
      facts.textContent = `Your link's Bundle: ${n(jwe.length)} bytes as a JWE, listing ${studies} of the ${idx.studies.length} ImagingStudies. The server may serve ${files.length} file under it: ${files.join(", ")}.`;
      open.disabled = false;
      revoke.disabled = false;
      await showLog();
    } catch (e) {
      result.replaceChildren(h("p", { class: "status-line bad", text: `Could not make the link: ${(e as Error).message}` }));
      make.disabled = false;
    }
  });

  open.addEventListener("click", async () => {
    if (!sb) return;
    open.disabled = true;
    const status = h("p", { class: "status-line", text: "Opening your link…" });
    const reqs = h("div", { class: "reqs" });
    result.replaceChildren(status, reqs);
    try {
      const res = await LinkResolver.fromLink(sb.shlink, { recipient: RECIPIENT, onRequest: (r) => reqs.prepend(reqRow({ ...r, recipient: RECIPIENT })) });
      const opened = await res.open();
      const index = opened.index;
      const series = index.studies[0].series.find((s) => s.uid === S.series!.uid)!;
      const p = planInstances(series, S.slice);
      const ct = await res.fetchRange(p);
      const pool = await S.pool!;
      const img = await pool.decode(ct, { encrypted: await decryptParams(series, p), header: true });
      const cv = h("canvas", { width: 160, height: 160, class: "thumb-160" });
      drawThumbnail(cv, img);
      status.className = "status-line good";
      status.textContent = `Opened. Its Bundle lists ${index.studies.length} ImagingStudy; this is slice ${S.slice + 1} from it.`;
      result.insertBefore(cv, reqs);
    } catch (e) {
      status.className = "status-line bad";
      status.textContent = e instanceof LinkError && e.status === 404 ? "The server answered 404: this link no longer works." : `It did not open: ${(e as Error).message}`;
    } finally {
      open.disabled = false;
      await showLog().catch(() => {});
    }
  });

  revoke.addEventListener("click", async () => {
    if (!sb) return;
    revoke.disabled = true;
    const r = await fetch(api(`/api/shares/${sb.sid}/links/${sb.lid}`), { method: "DELETE", headers: { Authorization: `Bearer ${sb.token}` } });
    result.replaceChildren(h("p", { class: `status-line ${r.ok ? "bad" : ""}`, text: r.ok ? "Revoked. Press “Open it” again: the next request fails." : `The server answered ${r.status}.` }));
    if (!r.ok) revoke.disabled = false;
    await showLog().catch(() => {});
  });
}
