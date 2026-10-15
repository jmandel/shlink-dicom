// Step 7: share and revoke. Makes a link to the MRI study only (on the visitor's own copy of the
// sample share), opens it in the panel, revokes it, and shows the next request failing.
// Uses the public API as a sharer would (see web/checks/fixtures.ts).
import qrcode from "qrcode-generator";
import { decryptParams, encodeShlink, encryptJwe, LinkError, LinkResolver, parseStudyIndex, planInstances, randomKeyB64, utf8, viewerUrl } from "../core/index";
import { drawThumbnail } from "../core/render";
import type { Scene } from "./how";
import { $, h, n, S } from "./state";
import { reqRow } from "./t-pieces";

const RECIPIENT = "How it works, step 7";

export function shareScene(): Scene {
  const idx0 = S.share!.index;
  const plan = h(
    "ul",
    { class: "toc-tree" },
    ...idx0.studies.map((st) =>
      h("li", { class: st === S.study ? "this" : "", style: st === S.study ? "" : "opacity:0.55" }, h("strong", { text: st.description ?? st.modalities.join(", ") }), h("span", { class: "meta", text: st === S.study ? " · in the new link" : " · left out" })),
    ),
  );
  const body = h("div", { class: "grow", style: "display:flex;flex-direction:column;gap:10px;overflow:auto" }, h("p", { class: "small muted", style: "margin:0", text: "The new link will hold:" }), plan);
  const el = h("section", { class: "scene", "data-scene": "share", "aria-label": "Share and revoke" }, h("p", { class: "scene-title", text: "Your link" }), body);
  const make = $<HTMLButtonElement>("sh-make"), open = $<HTMLButtonElement>("sh-open"), revoke = $<HTMLButtonElement>("sh-revoke");
  make.disabled = !S.sampleSid;
  let sb: { sid: string; token: string; lid: string; shlink: string; bundleBytes: number } | null = null;
  let revoked = false;
  const api = (p: string) => `${S.cfg!.apiBase}${p}`;
  const auth = () => ({ Authorization: `Bearer ${sb!.token}` });
  const j = async (r: Response) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const logBox = $("d-share-log");
  const showLog = async () => {
    if (!sb) return;
    await new Promise((r) => setTimeout(r, 250));
    const { events } = await j(await fetch(api(`/api/shares/${sb.sid}/access`), { headers: auth(), cache: "no-store" }));
    logBox.replaceChildren(
      h("p", { class: "small", text: "The server's access log for your copy, as stored:" }),
      ...events.slice(0, 20).map((e: any) => reqRow({ method: e.method, url: new URL(e.path, location.origin).toString(), range: e.range ?? undefined, status: e.status, bytes: e.bytes, recipient: e.recipient }, true)),
    );
  };

  make.addEventListener("click", async () => {
    make.disabled = true;
    try {
      // A copy of the sample share that this visitor controls (same encrypted files; 24 hours).
      const c = await j(await fetch(api(`/api/shares/${S.sampleSid}/clone`), { method: "POST" }));
      const idx = S.share!.index;
      const keep = S.study!.id;
      // Keep this ImagingStudy, and reports that refer to it (by entry fullUrl or ImagingStudy/id).
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
      const files = [...new Set(S.study!.series.map((s) => `${((s as any).file ?? s).fileId}.bin`))];
      const label = `MRI only (${S.study!.description ?? "MRI"})`;
      const headers = { Authorization: `Bearer ${c.controlToken}`, "Content-Type": "application/json" };
      const link = await j(await fetch(api(`/api/shares/${c.share.id}/links`), { method: "POST", headers, body: JSON.stringify({ label, allowedFiles: files }) }));
      const key = randomKeyB64();
      const bundleText = JSON.stringify(bundle);
      const jwe = await encryptJwe(utf8(bundleText), key);
      const up = await j(await fetch(api(`/api/shares/${c.share.id}/links/${link.id}/bundle.jwe`), { method: "PUT", headers: { ...headers, "Content-Type": "application/jose" }, body: jwe }));
      sb = { sid: c.share.id, token: c.controlToken, lid: link.id, shlink: encodeShlink({ url: up.url, key, flag: up.flag ?? undefined, label, v: 1 }), bundleBytes: jwe.length };
      revoked = false;
      const url = viewerUrl(S.cfg!, sb.shlink);
      const qr = qrcode(0, "L");
      qr.addData(url);
      qr.make();
      const q = h("div", { class: "qr", style: "flex:0 0 auto;height:140px", role: "img", "aria-label": "QR code of your link" });
      q.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
      body.replaceChildren(
        h("p", { class: "big-status good", text: "A new link to the MRI only" }),
        q,
        h("p", { class: "small", style: "margin:0" }, h("a", { href: url, target: "_blank", rel: "noopener", text: "Open it in a new tab" })),
      );
      const studies = parseStudyIndex(bundleText).studies.length;
      $("d-share").textContent = `Its index: ${n(jwe.length)} bytes locked, listing ${studies} of the ${idx.studies.length} studies. The server was told to serve ${files.length} files under the new link.`;
      open.disabled = false;
      revoke.disabled = false;
      await showLog();
    } catch (e) {
      body.replaceChildren(h("p", { class: "big-status bad", text: `Could not make the link: ${(e as Error).message}` }));
    } finally {
      make.disabled = false;
    }
  });

  open.addEventListener("click", async () => {
    if (!sb) return;
    open.disabled = true;
    const status = h("p", { class: "big-status", text: "Opening your link…" });
    const reqs = h("div", { class: "reqs" });
    body.replaceChildren(status, reqs);
    try {
      const res = new LinkResolver(sb.shlink, { recipient: RECIPIENT, onRequest: (r) => reqs.prepend(reqRow({ ...r, recipient: RECIPIENT })) });
      const opened = await res.open();
      const idx = parseStudyIndex(opened.bundleBytes);
      const series = idx.studies[0].series.find((s) => s.uid === S.series!.uid)!;
      const plan = planInstances(series, S.slice);
      const ct = await res.fetchRange(plan);
      const pool = await S.pool!;
      const img = await pool.decode(ct, { encrypted: await decryptParams(series, plan) });
      const cv = h("canvas", { width: 160, height: 160, style: "width:160px;height:160px;border-radius:8px;background:#000" });
      drawThumbnail(cv, img);
      status.className = "big-status good";
      status.textContent = `Opened. Its index lists ${idx.studies.length} study; this is slice ${S.slice + 1} from it.`;
      body.insertBefore(cv, reqs);
    } catch (e) {
      status.className = "big-status bad";
      const st = e instanceof LinkError ? e.status : undefined;
      status.textContent = st === 404 ? "The server answered 404: this link no longer works." : `It did not open: ${(e as Error).message}`;
    } finally {
      open.disabled = false;
      await showLog().catch(() => {});
    }
  });

  revoke.addEventListener("click", async () => {
    if (!sb || revoked) return;
    revoke.disabled = true;
    const r = await fetch(api(`/api/shares/${sb.sid}/links/${sb.lid}`), { method: "DELETE", headers: auth() });
    revoked = r.ok;
    body.replaceChildren(
      h("p", { class: `big-status ${r.ok ? "bad" : ""}`, text: r.ok ? "Revoked" : `The server answered ${r.status}` }),
      h("p", { text: r.ok ? "Press “Open it” again: the next request fails." : "" }),
    );
    if (!r.ok) revoke.disabled = false;
    await showLog().catch(() => {});
  });

  return { id: "share", el };
}
