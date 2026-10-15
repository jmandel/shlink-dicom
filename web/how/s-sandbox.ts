// Step 6: a copy of the sample share the visitor controls; mint a link to some of its studies
// (optionally with a passcode), open it, probe an included and a left-out series, revoke it.
// Uses the public API the way web/checks/fixtures.ts does.
import {
  encodeShlink,
  encryptJwe,
  LinkError,
  LinkResolver,
  planBytes,
  RECORD_PLAINTEXT,
  randomKeyB64,
  studyTitle,
  utf8,
  viewerUrl,
  type RequestEvent,
  type SeriesEntry,
} from "../core/index";
import { $, h, n, on, reqRow, S } from "./state";

const RECIPIENT = "How it works sandbox";

interface Sandbox {
  sid: string;
  token: string;
  lid?: string;
  shlink?: string;
  passcode?: string;
  included: SeriesEntry[];
  excluded: SeriesEntry[];
  /** Base URL the link resolved to before revocation (U url or /cap/ location). */
  base?: string;
}
let sb: Sandbox | null = null;

const api = (p: string) => `${S.cfg!.apiBase}${p}`;
const auth = () => ({ Authorization: `Bearer ${sb!.token}` });

async function j(res: Response) {
  if (!res.ok) throw new Error(`${new URL(res.url).pathname}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

function logSb(e: RequestEvent | { method: string; url: string; range?: string; status: number; bytes: number; ms?: number }) {
  const net = $("sb-net");
  if (net.querySelector("p")) net.replaceChildren();
  net.prepend(reqRow({ ...e, recipient: RECIPIENT }));
}

async function refreshLog() {
  if (!sb) return;
  const box = $("sb-log");
  try {
    await new Promise((r) => setTimeout(r, 250));
    const { events } = await j(await fetch(api(`/api/shares/${sb.sid}/access`), { headers: auth(), cache: "no-store" }));
    box.replaceChildren();
    if (!events.length) box.append(h("p", { class: "small muted", text: "No requests logged yet." }));
    for (const e of events.slice(0, 30)) {
      const row = reqRow({ method: e.method, url: new URL(e.path, location.origin).toString(), range: e.range ?? undefined, status: e.status, bytes: e.bytes, recipient: e.recipient });
      row.querySelector(".d")!.textContent = `${new Date(e.ts * 1000).toLocaleTimeString()} · ${row.querySelector(".d")!.textContent}`;
      box.append(row);
    }
  } catch (e) {
    box.replaceChildren(h("p", { class: "small bad", text: `Could not read the log: ${(e as Error).message}` }));
  }
}

async function clone() {
  const btn = $<HTMLButtonElement>("sb-clone");
  btn.disabled = true;
  const msg = $("sb-clone-msg");
  msg.textContent = "Asking the server for a copy…";
  try {
    const t0 = performance.now();
    const r = await j(await fetch(api(`/api/shares/${S.sampleSid}/clone`), { method: "POST" }));
    sb = { sid: r.share.id, token: r.controlToken, included: [], excluded: [] };
    const files = r.share.files ?? [];
    const bytes = files.reduce((a: number, f: any) => a + (f.size ?? 0), 0);
    msg.textContent = `Done in ${Math.round(performance.now() - t0)} ms: a copy of ${files.length} encrypted series files (${n(bytes)} bytes) that you control until ${new Date((r.share.expiresAt ?? 0) * 1000).toLocaleString()}.`;
    btn.textContent = "Copied";
    ($("sb-form") as HTMLFieldSetElement).disabled = false;
    refreshLog();
  } catch (e) {
    msg.textContent = `The server did not make a copy: ${(e as Error).message}`;
    btn.disabled = false;
  }
}

async function mint() {
  if (!sb) return;
  const btn = $<HTMLButtonElement>("sb-mint");
  const idx = S.share!.index;
  const chosen = [...$("sb-studies").querySelectorAll<HTMLInputElement>("input:checked")].map((x) => Number(x.value));
  if (!chosen.length) {
    say("sb-mint-msg", "Pick at least one study.");
    return;
  }
  btn.disabled = true;
  try {
    const studies = chosen.map((i) => idx.studies[i]);
    const ids = new Set(studies.map((s) => s.id));
    sb.included = studies.flatMap((s) => s.series);
    sb.excluded = idx.studies.filter((s) => !ids.has(s.id)).flatMap((s) => s.series);
    const bundle = {
      ...idx.bundle,
      entry: idx.bundle.entry.filter((e: any) => {
        const r = e.resource;
        if (r?.resourceType === "ImagingStudy") return ids.has(r.id);
        if (r?.resourceType === "DiagnosticReport" && Array.isArray(r.imagingStudy) && r.imagingStudy.length) {
          return r.imagingStudy.some((ref: any) => ids.has(String(ref.reference ?? "").split("/").pop()));
        }
        return true;
      }),
    };
    const label = `Sample: ${studies.map(studyTitle).join(" + ")}`;
    const passcode = $<HTMLInputElement>("sb-pass").value.trim() || undefined;
    const link = await j(
      await fetch(api(`/api/shares/${sb.sid}/links`), {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ label, passcode, allowedFiles: sb.included.map((s) => `${s.fileId}.bin`) }),
      }),
    );
    const key = randomKeyB64();
    const jwe = await encryptJwe(utf8(JSON.stringify(bundle)), key);
    const updated = await j(
      await fetch(api(`/api/shares/${sb.sid}/links/${link.id}/bundle.jwe`), {
        method: "PUT",
        headers: { ...auth(), "Content-Type": "application/jose" },
        body: jwe,
      }),
    );
    sb.lid = link.id;
    sb.passcode = passcode;
    sb.base = undefined;
    sb.shlink = encodeShlink({ url: updated.url, key, flag: updated.flag ?? undefined, label, v: 1 });
    $("sb-link").classList.remove("hidden");
    $("sb-link-text").textContent = sb.shlink;
    $<HTMLAnchorElement>("sb-open").href = viewerUrl(S.cfg!, sb.shlink);
    $<HTMLButtonElement>("sb-probe").disabled = false;
    $<HTMLButtonElement>("sb-revoke").disabled = false;
    $("sb-revoke-msg").textContent = "";
    $("sb-probe-msg").textContent = "";
    $("sb-mint-msg").textContent = passcode
      ? `A passcode link (flag ${updated.flag}). The viewer will ask for “${passcode}”. The server issues a one-hour /cap/ address after the passcode is accepted.`
      : `A direct link (flag ${updated.flag ?? "none"}). ${sb.included.length} series files are reachable under it.`;
    refreshLog();
  } catch (e) {
    say("sb-mint-msg", `Could not make the link: ${(e as Error).message}`);
  } finally {
    btn.disabled = false;
  }
}

function say(id: string, text: string) {
  $(id).textContent = text;
}

/** Fetches record 0 of a series under the link and logs the answer. */
async function readFirstRecord(res: LinkResolver, se: SeriesEntry): Promise<number> {
  try {
    await res.fetchRange(planBytes(se, 0, Math.min(se.plaintextLength, RECORD_PLAINTEXT)));
    return 206;
  } catch (e) {
    return e instanceof LinkError ? (e.status ?? 0) : 0;
  }
}

async function probe() {
  if (!sb?.shlink) return;
  const btn = $<HTMLButtonElement>("sb-probe");
  btn.disabled = true;
  try {
    const res = new LinkResolver(sb.shlink, { recipient: RECIPIENT, onRequest: logSb });
    await res.open(sb.passcode);
    sb.base = res.base ?? undefined;
    const a = await readFirstRecord(res, sb.included[0]);
    let msg = `Included series “${sb.included[0].description ?? ""}”: ${a}.`;
    if (sb.excluded[0]) {
      const b = await readFirstRecord(res, sb.excluded[0]);
      msg += ` Left-out series “${sb.excluded[0].description ?? ""}”: ${b}, though it is the same file on the same server.`;
    } else msg += " Every study is in this link, so there is no left-out series to ask for.";
    say("sb-probe-msg", msg);
  } catch (e) {
    say("sb-probe-msg", `The link did not open: ${(e as Error).message}`);
  } finally {
    btn.disabled = false;
    refreshLog();
  }
}

async function revoke() {
  if (!sb?.lid) return;
  const btn = $<HTMLButtonElement>("sb-revoke");
  btn.disabled = true;
  $<HTMLButtonElement>("sb-probe").disabled = true;
  try {
    const t0 = performance.now();
    const del = await fetch(api(`/api/shares/${sb.sid}/links/${sb.lid}`), { method: "DELETE", headers: auth() });
    logSb({ method: "DELETE" as any, url: del.url, status: del.status, bytes: 0, ms: performance.now() - t0 });
    // The link itself: the Bundle (U) or the manifest (P).
    const res = new LinkResolver(sb.shlink!, { recipient: RECIPIENT, onRequest: logSb });
    let linkStatus = "";
    try {
      await res.open(sb.passcode);
      linkStatus = "still opens (unexpected)";
    } catch (e) {
      linkStatus = e instanceof LinkError ? `${e.status ?? e.reason}` : String(e);
    }
    // A series file under the address the link used before.
    let fileStatus = "";
    if (sb.base) {
      const u = new URL(`${sb.included[0].fileId}.bin`, sb.base);
      u.searchParams.set("recipient", RECIPIENT);
      const t1 = performance.now();
      const r = await fetch(u, { headers: { Range: "bytes=0-65535" }, cache: "no-store" });
      logSb({ method: "GET", url: u.toString(), range: "bytes=0-65535", status: r.status, bytes: Number(r.headers.get("content-length") ?? 0), ms: performance.now() - t1 });
      await r.body?.cancel();
      fileStatus = ` A series file at the address used before: ${r.status}.`;
    }
    say("sb-revoke-msg", `Revoked (${del.status}). The link: ${linkStatus}.${fileStatus} Reload the tab you opened to see what a recipient sees.`);
  } catch (e) {
    say("sb-revoke-msg", `Could not revoke: ${(e as Error).message}`);
    btn.disabled = false;
  } finally {
    refreshLog();
  }
}

export function initSandbox() {
  on("ready", () => {
    const box = $("sb-studies");
    box.replaceChildren();
    S.share!.index.studies.forEach((s, i) => {
      box.append(
        h(
          "label",
          {},
          h("input", { type: "checkbox", value: String(i), checked: i === S.share!.index.studies.length - 1 }),
          `${studyTitle(s)} · ${s.series.length} series · ${s.numberOfInstances} images`,
        ),
      );
    });
    $<HTMLButtonElement>("sb-clone").disabled = !S.sampleSid;
  });
  $("sb-clone").addEventListener("click", clone);
  $("sb-mint").addEventListener("click", mint);
  $("sb-probe").addEventListener("click", probe);
  $("sb-revoke").addEventListener("click", revoke);
  $("sb-copy").addEventListener("click", async () => {
    if (!sb?.shlink) return;
    try {
      await navigator.clipboard.writeText(viewerUrl(S.cfg!, sb.shlink));
      $("sb-copy").textContent = "Copied";
      setTimeout(() => ($("sb-copy").textContent = "Copy"), 1500);
    } catch {
      $("sb-copy").textContent = "Copy failed";
    }
  });
}
