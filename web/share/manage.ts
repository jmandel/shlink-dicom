// Manage (/share/manage#share=…&token=…&key=…): the share's links with their status and activity;
// revoke, extend, take offline, change studies, and new links for other people. The owner key in
// the hash decrypts the owner Bundle and derives each link's key; it is never sent to the server.
import { loadConfig, siteUrl, type SiteConfig } from "../core/config";
import { formatBytes, plural, formatDate } from "../core/format";
import { parseStudyIndex, type StudyEntry, type StudyIndex } from "../core/bundle";
import {
  ApiError, ShareApi, forgetShare, manageUrl, parseManageHash, publishLinkBundle, readOwnerBundle, saveShare, savedShares, shlinkFor,
  type AccessEvent, type LinkResource, type OwnerCredential, type ShareResource,
} from "./lib/api";
import { subsetBundle } from "./lib/pack";
import { plainStudyTitle, studyDisplayDate } from "./lib/ingest";
import { $, h, copyText, flash, qrSvg, when, dateOnly, expiryFieldset, expiryFrom, SERVER_MAX_DAYS } from "./lib/ui";

let cfg: SiteConfig;
let cred: OwnerCredential;
let api: ShareApi;
let share: ShareResource;
let owner: any;
let index: StudyIndex;
let events: AccessEvent[] = [];
/** fileId → study */
const fileStudy = new Map<string, StudyEntry>();
const openPanels = new Map<string, "link" | "studies">();
const labels = new Map<string, string>();

const main = $("mg");
const now = () => Math.floor(Date.now() / 1000);
const studyName = (s: StudyEntry) => plainStudyTitle(s.description, s.modalities);

let toastTimer = 0;
function toast(msg: string) {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: "toast", role: "status" }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.remove(), 3200);
}

function confirmBox(title: string, text: string, ok: string): Promise<boolean> {
  const d = $<HTMLDialogElement>("confirm");
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = ok;
  d.returnValue = "";
  d.showModal();
  return new Promise((res) => d.addEventListener("close", () => res(d.returnValue === "ok"), { once: true }));
}

// ------------------------------------------------------------------------------------ start

(async () => {
  cfg = await loadConfig();
  const c = parseManageHash(location.hash);
  if (!c) return renderPicker();
  cred = c;
  api = new ShareApi(cfg.apiBase, cred);
  try {
    [share, owner] = await Promise.all([api.getShare(), readOwnerBundle(api, cred.ownerKey)]);
  } catch (x) {
    const e = x as ApiError;
    main.replaceChildren(
      h("h1", null, "This share can't be opened"),
      h("p", { class: "lede" }, e.status === 404 ? "The server no longer has it. It may have expired or been deleted." : e.status === 403 ? "The manage link is not valid for this share." : `${e.message || "The owner data did not decrypt with this manage link."}`),
      h("p", null, h("a", { class: "btn", href: siteUrl("share/manage"), onclick: () => e.status === 404 && forgetShare(cred.sid) }, "Your shares")),
    );
    return;
  }
  index = parseStudyIndex(owner);
  for (const st of index.studies) for (const se of st.series) fileStudy.set(se.fileId, st);
  const title = index.studies.map(studyName).join(", ");
  if (!savedShares().some((s) => s.sid === cred.sid)) saveShare({ ...cred, title, createdAt: share.createdAt, apiBase: cfg.apiBase });
  await loadEvents();
  render();
  setInterval(async () => {
    if (document.hidden) return;
    try {
      share = await api.getShare();
      await loadEvents();
      refreshStatus();
    } catch {}
  }, 15000);
})();

async function loadEvents() {
  try {
    events = await api.access({ limit: 3000 });
  } catch {
    events = [];
  }
}

function renderPicker() {
  const saved = savedShares().filter((s) => s.apiBase === cfg.apiBase);
  const input = h("input", { type: "text", id: "in-manage", placeholder: "https://…/share/manage#share=…", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const err = h("p", { class: "error hidden", role: "alert" });
  main.replaceChildren(
    h("h1", null, "Your shares"),
    saved.length
      ? h("ul", { class: "saved-list-page links" }, saved.map((s) => h("li", null, h("a", { class: "card choice", href: manageUrl(siteUrl("share/manage"), s), onclick: () => setTimeout(() => location.reload(), 0) }, h("span", { class: "c-text" }, h("span", { class: "c-title" }, s.title || "Shared imaging"), h("span", { class: "c-sub" }, `Made ${dateOnly(s.createdAt)}`))))))
      : h("p", { class: "lede" }, "No shares are saved in this browser."),
    h(
      "form",
      { class: "stack mg-section", onsubmit: (e: Event) => {
        e.preventDefault();
        const c = parseManageHash(input.value);
        if (!c) {
          err.textContent = "That isn't a manage link. It should contain #share=…&token=…&key=….";
          err.classList.remove("hidden");
          return;
        }
        location.href = manageUrl(siteUrl("share/manage"), c);
        location.reload();
      } },
      h("label", { for: "in-manage" }, "Open a manage link"),
      input,
      h("button", { class: "btn btn-primary", type: "submit" }, "Open"),
      err,
    ),
    h("p", { class: "mg-section" }, h("a", { class: "btn", href: siteUrl("share") }, "Share imaging")),
  );
}

// ----------------------------------------------------------------------------------- render

function render() {
  const linksBox = h("div", { class: "links", id: "links" });
  main.replaceChildren(
    h("h1", null, "Manage your share"),
    h(
      "p",
      { class: "mg-summary" },
      [index.patient.name, index.studies.map(studyName).join(", ")].filter(Boolean).join(" · "),
    ),
    h("p", { class: "tech", id: "share-tech" }),
    h("section", { class: "mg-section" }, h("h2", null, "Links"), linksBox, h("button", { class: "btn btn-primary", id: "new-link-btn", onclick: () => toggleNewLink() }, "New link for someone else"), h("div", { id: "new-link" })),
    h(
      "section",
      { class: "mg-section", id: "activity" },
      h("h2", null, "Activity"),
      h("ol", { class: "timeline", id: "timeline" }),
      h("details", { class: "tech-details", id: "techlog" }, h("summary", null, "Show technical log"), h("p", { class: "hint" }, "Every request the server logged for this share, newest first. The server sees which encrypted files and byte ranges were read, not what is in them."), h("div", { class: "log-wrap", id: "log" })),
      h("button", { class: "btn", onclick: async (e: Event) => {
        share = await api.getShare();
        await loadEvents();
        refreshStatus();
        flash(e.currentTarget as HTMLElement, "Updated");
      } }, "Refresh"),
    ),
    h(
      "section",
      { class: "danger-zone" },
      h("h2", null, "Delete this share"),
      h("p", { class: "hint" }, "Removes the encrypted files and every link from the server. The links stop working at once."),
      h("button", { class: "btn btn-danger", id: "delete-share", onclick: deleteShare }, "Delete share"),
    ),
  );
  refreshStatus();
}

function refreshStatus() {
  $("share-tech").textContent = `${plural(index.studies.length, "study", "studies")} · ${plural(share.files.length, "encrypted file")} · ${formatBytes(share.quota.bytesUsed)} stored, all encrypted · kept on the server until ${share.expiresAt ? dateOnly(share.expiresAt) : "deleted"}`;
  for (const l of share.links) labels.set(l.id, l.label || "Link without a name");
  const box = $("links");
  if (!share.links.length) box.replaceChildren(h("p", { class: "muted" }, "No links. Make one below."));
  else box.replaceChildren(...share.links.map(linkCard));
  renderActivity();
}

function linkStudies(l: LinkResource): StudyEntry[] {
  const files = new Set(l.allowedFiles.map((f) => f.replace(/\.bin$/, "")));
  return index.studies.filter((st) => st.series.some((se) => files.has(se.fileId)));
}

function linkState(l: LinkResource): { text: string; cls: string } {
  if (l.hasPasscode && l.remainingAttempts === 0) return { text: "Locked", cls: "bad" };
  if (l.exp && l.exp <= now()) return { text: "Expired", cls: "bad" };
  if (!l.online) return { text: "Offline", cls: "off" };
  return { text: "Active", cls: "" };
}

function linkCard(l: LinkResource): HTMLElement {
  const st = linkState(l);
  const studies = linkStudies(l);
  const opened = l.openCount ?? 0;
  const status = opened ? `Opened ${plural(opened, "time")}, last ${when(l.lastOpenedAt!)}` : "Not opened yet";
  const expText = l.exp
    ? l.exp <= now()
      ? `Expired ${dateOnly(l.exp)}`
      : `Works until ${dateOnly(l.exp)}`
    : `No end date; the server keeps the share until ${share.expiresAt ? dateOnly(share.expiresAt) : "it is deleted"}`;
  const panel = h("div", { class: "lc-panel" });
  const card = h(
    "article",
    { class: "card link-card" + (st.cls ? " off" : ""), "data-lid": l.id },
    h("div", { class: "lc-head" }, h("h3", null, labels.get(l.id)!), h("span", { class: `pill ${st.cls}` }, st.text)),
    h("p", { class: "lc-studies" }, studies.map(studyName).join(", ") || "No studies"),
    h("p", { class: "lc-status" }, status),
    h("p", { class: "hint" }, expText + (l.hasPasscode ? ` · passcode, ${plural(l.remainingAttempts ?? 0, "try", "tries")} left` : "") + (l.longLived ? " · updates allowed" : "")),
    h("p", { class: "tech" }, `${formatBytes(l.bytesServed ?? 0)} sent in ${plural(l.accessCount, "request")} · made ${when(l.createdAt)} · flag ${l.flag ?? "none"}`),
    h(
      "div",
      { class: "lc-actions" },
      h("button", { class: "btn", "aria-expanded": String(openPanels.get(l.id) === "link"), onclick: () => togglePanel(l, "link") }, "Show link"),
      l.exp ? h("button", { class: "btn", onclick: () => extend(l) }, "Extend by a week") : null,
      h("button", { class: "btn", onclick: () => setOnline(l, !l.online) }, l.online ? "Take offline" : "Bring back online"),
      l.longLived ? h("button", { class: "btn", "aria-expanded": String(openPanels.get(l.id) === "studies"), onclick: () => togglePanel(l, "studies") }, "Change studies") : null,
      h("button", { class: "btn btn-danger", onclick: () => revoke(l) }, "Revoke"),
    ),
    panel,
  );
  const which = openPanels.get(l.id);
  if (which === "link") fillLinkPanel(panel, l);
  if (which === "studies") fillStudiesPanel(panel, l);
  return card;
}

function togglePanel(l: LinkResource, which: "link" | "studies") {
  if (openPanels.get(l.id) === which) openPanels.delete(l.id);
  else openPanels.set(l.id, which);
  refreshStatus();
}

async function fillLinkPanel(panel: HTMLElement, l: LinkResource) {
  const shlink = await shlinkFor(l, cred.ownerKey, cfg.viewerPrefix);
  const qr = h("div", { class: "qr", role: "img", "aria-label": `QR code for ${labels.get(l.id)}` });
  qr.innerHTML = qrSvg(shlink);
  panel.replaceChildren(
    h(
      "div",
      { class: "lc-qr" },
      qr,
      h(
        "div",
        null,
        h("p", { class: "mono break" }, shlink),
        h("div", { class: "lc-actions" }, h("button", { class: "btn btn-primary", onclick: async (e: Event) => flash(e.currentTarget as HTMLElement, (await copyText(shlink)) ? "Copied" : "Copy failed") }, "Copy link"), h("a", { class: "btn", href: shlink, target: "_blank", rel: "noopener" }, "Open it")),
        h("p", { class: "hint" }, "This is the same link you sent. It is rebuilt here from the manage link; the server does not have its key."),
      ),
    ),
  );
}

function studyChecks(name: string, checked: (s: StudyEntry) => boolean): HTMLElement {
  return h(
    "fieldset",
    { class: "field" },
    h("legend", null, "Studies"),
    index.studies.map((s, i) => {
      const d = studyDisplayDate({ started: s.started, description: s.description });
      return h("label", { class: "check-row" }, h("input", { type: "checkbox", name, value: s.id, checked: checked(s) }), h("span", { class: "box", "aria-hidden": "true" }), h("span", null, studyName(s) + (d ? ` · ${formatDate(d)}` : "")));
    }),
  );
}
const checkedStudies = (root: HTMLElement, name: string) => [...root.querySelectorAll<HTMLInputElement>(`input[name=${name}]:checked`)].map((x) => x.value);

function fillStudiesPanel(panel: HTMLElement, l: LinkResource) {
  const have = new Set(linkStudies(l).map((s) => s.id));
  const err = h("p", { class: "error hidden", role: "alert" });
  const form = h(
    "form",
    { class: "inline-form", onsubmit: async (e: Event) => {
      e.preventDefault();
      const ids = checkedStudies(form, `cs-${l.id}`);
      if (!ids.length) {
        err.textContent = "Choose at least one study.";
        err.classList.remove("hidden");
        return;
      }
      const { bundle, allowedFiles } = subsetBundle(owner, ids);
      try {
        // Publish order (PLAN.md §5.2): files the new Bundle needs are allowed first, the Bundle is
        // replaced, then files it no longer needs are removed.
        const union = [...new Set([...l.allowedFiles, ...allowedFiles])];
        await api.patchLink(l.id, { allowedFiles: union });
        await publishLinkBundle(api, cred.ownerKey, l.id, bundle);
        await api.patchLink(l.id, { allowedFiles });
        openPanels.delete(l.id);
        share = await api.getShare();
        refreshStatus();
        toast("Saved. The link now shows the studies you chose.");
      } catch (x) {
        err.textContent = (x as Error).message;
        err.classList.remove("hidden");
      }
    } },
    studyChecks(`cs-${l.id}`, (s) => have.has(s.id)),
    h("p", { class: "hint" }, "The recipient keeps the same link. A viewer that already has it open sees the change when it reloads."),
    h("button", { class: "btn btn-primary", type: "submit" }, "Save"),
    err,
  ) as HTMLFormElement;
  panel.replaceChildren(form);
}

// ---------------------------------------------------------------------------------- actions

async function ensureShareLasts(until: number | null) {
  const want = until ?? now() + SERVER_MAX_DAYS * 86400;
  if (share.expiresAt && share.expiresAt < want) share = await api.setShareExpiry(until);
}

async function extend(l: LinkResource) {
  const exp = Math.max(now(), l.exp ?? now()) + 7 * 86400;
  try {
    await ensureShareLasts(exp);
    await api.patchLink(l.id, { exp });
    share = await api.getShare();
    refreshStatus();
    const capped = share.expiresAt && share.expiresAt < exp;
    toast(capped ? `Extended to ${dateOnly(share.expiresAt!)}, the longest this server keeps a share.` : `Extended to ${dateOnly(exp)}. The link itself is unchanged.`);
  } catch (x) {
    toast((x as Error).message);
  }
}

async function setOnline(l: LinkResource, online: boolean) {
  try {
    await api.patchLink(l.id, { online });
    if (!online) await api.endSessions(l.id).catch(() => {});
    share = await api.getShare();
    refreshStatus();
    toast(online ? "Back online. The link opens again." : "Offline. The link does not open until you bring it back online.");
  } catch (x) {
    toast((x as Error).message);
  }
}

async function revoke(l: LinkResource) {
  const ok = await confirmBox(`Revoke the link for ${labels.get(l.id)}?`, "It stops working at once and can't be turned back on. You can make a new link later.", "Revoke");
  if (!ok) return;
  try {
    await api.deleteLink(l.id);
    labels.set(l.id, `${labels.get(l.id)} (revoked)`);
    share = await api.getShare();
    refreshStatus();
    toast("Revoked. The link no longer opens.");
  } catch (x) {
    toast((x as Error).message);
  }
}

async function deleteShare() {
  const ok = await confirmBox("Delete this share?", "The encrypted files and all links are removed from the server. This can't be undone.", "Delete");
  if (!ok) return;
  try {
    await api.deleteShare();
  } catch (x) {
    if ((x as ApiError).status !== 404) return toast((x as Error).message);
  }
  forgetShare(cred.sid);
  main.replaceChildren(h("h1", null, "Share deleted"), h("p", { class: "lede" }, "The files and links are gone from the server."), h("p", null, h("a", { class: "btn btn-primary", href: siteUrl("share") }, "Share imaging")));
}

function toggleNewLink() {
  const box = $("new-link");
  if (box.firstChild) {
    box.replaceChildren();
    $("new-link-btn").setAttribute("aria-expanded", "false");
    return;
  }
  $("new-link-btn").setAttribute("aria-expanded", "true");
  const err = h("p", { class: "error hidden", role: "alert" });
  const recipient = h("input", { type: "text", id: "nl-recipient", maxlength: 60, placeholder: "Dr. Lee, Orthopedics", autocomplete: "off" }) as HTMLInputElement;
  const pass = h("input", { type: "text", id: "nl-pass", maxlength: 40, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const updates = h("input", { type: "checkbox", id: "nl-updates" }) as HTMLInputElement;
  const form = h(
    "form",
    { class: "inline-form", onsubmit: async (e: Event) => {
      e.preventDefault();
      const ids = checkedStudies(form, "nl-study");
      if (!ids.length) {
        err.textContent = "Choose at least one study.";
        err.classList.remove("hidden");
        return;
      }
      const exp = expiryFrom(form, "nl-exp");
      const btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
      btn.disabled = true;
      try {
        await ensureShareLasts(exp);
        const { bundle, allowedFiles } = subsetBundle(owner, ids);
        let link = await api.createLink({ label: recipient.value.trim() || null, passcode: pass.value, exp, longLived: updates.checked, allowedFiles });
        link = await publishLinkBundle(api, cred.ownerKey, link.id, bundle);
        share = await api.getShare();
        box.replaceChildren();
        openPanels.set(link.id, "link");
        refreshStatus();
        document.querySelector(`[data-lid="${link.id}"]`)?.scrollIntoView({ block: "start" });
        toast("Link made. Send it from its card.");
      } catch (x) {
        btn.disabled = false;
        err.textContent = (x as Error).message;
        err.classList.remove("hidden");
      }
    } },
    h("h3", null, "New link"),
    h("p", { class: "hint" }, "It uses the files already uploaded, with its own key, so nothing is encrypted or uploaded again."),
    h("div", { class: "field" }, h("label", { for: "nl-recipient" }, "Who is it for?"), recipient),
    studyChecks("nl-study", () => true),
    expiryFieldset("nl-exp", "1w"),
    h("label", { class: "toggle-row" }, h("span", { class: "switch" }, updates, h("span", { class: "track", "aria-hidden": "true" })), h("span", null, h("strong", null, "Allow updates"), h("span", { class: "hint" }, "You can change which studies this link shows later."))),
    h("div", { class: "field" }, h("label", { for: "nl-pass" }, "Passcode (optional)"), pass, h("p", { class: "hint" }, "Send it separately. After 5 wrong tries the link stops working.")),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => toggleNewLink() }, "Cancel"), h("button", { class: "btn btn-primary", type: "submit" }, "Make link")),
    err,
  ) as HTMLFormElement;
  box.replaceChildren(form);
  recipient.focus();
}

// --------------------------------------------------------------------------------- activity

interface Item {
  ts: number;
  lid: string | null;
  text: string;
  detail?: string;
  reqs: number;
  bytes: number;
  last: number;
}

const isBundle = (e: AccessEvent) => /\/bundle\.jwe$/.test(e.path) && (e.status === 200 || e.status === 304);
const isSeries = (e: AccessEvent) => /\.bin$/.test(e.path);

/** Groups the raw log into what a person did: opened a link, loaded images, typed a wrong passcode. */
function timeline(): Item[] {
  const asc = [...events].reverse(); // the server sends newest first (ts, then insertion order)
  const items: Item[] = [];
  const lastOpen = new Map<string, Item>();
  for (const e of asc) {
    const lid = e.lid ?? "";
    if (isBundle(e)) {
      const it: Item = { ts: e.ts, lid: e.lid, text: e.status === 304 ? "Checked for changes" : "Opened", reqs: 0, bytes: 0, last: e.ts };
      items.push(it);
      lastOpen.set(lid, it);
    } else if (e.method === "POST" && e.status === 401) {
      items.push({ ts: e.ts, lid: e.lid, text: "Wrong passcode entered", reqs: 0, bytes: 0, last: e.ts });
    } else if (isSeries(e)) {
      let it = lastOpen.get(lid);
      if (!it || e.ts - it.last > 1800) {
        it = { ts: e.ts, lid: e.lid, text: "Loaded images", reqs: 0, bytes: 0, last: e.ts };
        items.push(it);
        lastOpen.set(lid, it);
      }
      it.reqs++;
      it.bytes += e.bytes;
      it.last = e.ts;
    }
  }
  return items.reverse();
}

function renderActivity() {
  const tl = $("timeline");
  const items = timeline();
  tl.replaceChildren(
    ...(items.length
      ? items.slice(0, 50).map((it) =>
          h(
            "li",
            null,
            h("time", { datetime: new Date(it.ts * 1000).toISOString() }, when(it.ts)),
            h(
              "div",
              null,
              h("span", null, `${it.text} · ${it.lid ? labels.get(it.lid) ?? "a revoked link" : "unknown link"}`),
              it.reqs ? h("span", { class: "tech", style: "display:block" }, `${formatBytes(it.bytes)} of encrypted image data in ${plural(it.reqs, "request")}`) : null,
            ),
          ),
        )
      : [h("li", { class: "muted" }, h("span", null, "Nothing yet. When someone opens a link, it shows here."))]),
  );
  const rows = [...events].sort((a, b) => b.ts - a.ts).slice(0, 400);
  const short = (p: string) => p.replace(/^\/(shl|cap)\/([A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/, "/$1/$2…").replace(/\/([A-Za-z0-9_-]{6})[A-Za-z0-9_-]{16}\.bin$/, "/$1….bin");
  $("log").replaceChildren(
    rows.length
      ? h(
          "table",
          { class: "log-table" },
          h("thead", null, h("tr", null, ["Time", "Link", "Request", "Range", "Status", "Bytes"].map((x) => h("th", null, x)))),
          h(
            "tbody",
            null,
            rows.map((e) =>
              h(
                "tr",
                null,
                h("td", null, new Date(e.ts * 1000).toLocaleTimeString()),
                h("td", null, e.lid ? labels.get(e.lid) ?? e.lid.slice(0, 6) : ""),
                h("td", null, `${e.method} ${short(e.path)}`),
                h("td", null, e.range ?? ""),
                h("td", null, String(e.status)),
                h("td", null, String(e.bytes)),
              ),
            ),
          ),
        )
      : h("p", { class: "muted" }, "No requests logged."),
  );
}

(window as any).__manage = {
  get share() {
    return share;
  },
  get events() {
    return events;
  },
};
