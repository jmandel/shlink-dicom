import { ApiClient } from "./api-client";
import { renderQrSvg, showQrModal } from "./qr-code";
import {
  WasmPacker,
  build_link_bundle_wasm,
  encode_shlink_wasm,
} from "../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js";

export interface StudySummary {
  id: string;
  studyInstanceUid: string;
  description?: string;
  started?: string;
  series: SeriesSummary[];
}

export interface SeriesSummary {
  uid: string;
  number?: number;
  modality?: string;
  description?: string;
  fileId: string;
  key: string;
  plaintextLength: number;
  ciphertextLength: number;
  recordCount: number;
  instances: Array<{ uid: string; sopClass?: string; number?: number; offset: number; length: number }>;
}

export interface StudyIndex {
  patientName?: string;
  patientId?: string;
  patientBirthDate?: string;
  studies: StudySummary[];
}

export interface SandboxLinkItem {
  lid: string;
  label: string;
  shlinkUri: string;
  studiesSummary: string;
  online: boolean;
  revoked?: boolean;
  hasPasscode?: boolean;
  remainingAttempts?: number | null;
}

export interface SandboxState {
  sid: string;
  controlToken: string;
  ownerBundleJson: string;
  links: SandboxLinkItem[];
  sseAbort?: AbortController;
}

export function renderStudySubsetPicker(studyIndex: StudyIndex | null) {
  const container = document.getElementById("study-subset-picker")!;
  container.innerHTML = "";
  if (!studyIndex) return;

  studyIndex.studies.forEach((st, idx) => {
    const sliceCount = st.series.reduce((acc, s) => acc + s.instances.length, 0);
    const bytes = st.series.reduce((acc, s) => acc + s.ciphertextLength, 0);
    const row = document.createElement("label");
    row.className = "study-cb-card";
    row.innerHTML = `
      <div>
        <input type="checkbox" class="study-subset-cb" data-study-idx="${idx}" checked />
        <strong>${st.description ?? `Study ${idx + 1}`}</strong>
      </div>
      <span class="pill-subtle">${st.series.length} series · ${sliceCount} slices · ${(bytes / (1024 * 1024)).toFixed(1)} MB</span>
    `;
    container.appendChild(row);
  });
}

export function renderSandboxLinks(
  api: ApiClient,
  sandbox: SandboxState | null,
  onTryInCurrentTab: (uri: string) => void,
  onRefresh: () => void,
  onStatus: (msg: string, isErr?: boolean) => void,
) {
  const container = document.getElementById("sandbox-links-list")!;
  container.innerHTML = "";
  if (!sandbox || sandbox.links.length === 0) {
    container.innerHTML = `<div class="empty-state">No links created yet. Choose studies above and click Create link.</div>`;
    return;
  }

  for (const lk of sandbox.links) {
    const card = document.createElement("div");
    card.className = `link-item ${lk.revoked ? "link-revoked" : !lk.online ? "link-offline" : ""}`;

    let statusText = "🟢 Online · Direct link";
    if (lk.revoked) {
      statusText = "Revoked: this link now returns 404";
    } else if (!lk.online) {
      statusText = "Offline: requests return 404 until you bring it back online";
    } else if (lk.hasPasscode) {
      statusText = `🔒 Passcode required (attempts left: ${lk.remainingAttempts ?? 5})`;
    }

    card.innerHTML = `
      <div class="link-card-body">
        <button class="qr-thumb" title="Click to enlarge QR code for ${lk.label}" aria-label="Enlarge QR code for ${lk.label}">
          <div class="qr-thumb-svg">${renderQrSvg(lk.shlinkUri, 2, 1)}</div>
          <span class="qr-thumb-label">${lk.label}</span>
        </button>
        <div class="link-card-main">
          <div class="link-item-header">
            <div>
              <strong>${lk.label}</strong>
              <span class="link-studies-badge">${lk.studiesSummary}</span>
            </div>
            <span class="pill-subtle link-state-pill">${statusText}</span>
          </div>
          <input class="link-uri-box" type="text" readonly value="${lk.shlinkUri}" />
          <div class="btn-group">
            ${
              lk.revoked
                ? `<button class="btn btn-sm btn-try-revoked">Try revoked link</button>`
                : `
                  <button class="btn btn-sm btn-copy-lk">Copy URL</button>
                  <a class="btn btn-sm btn-primary btn-open-lk" href="${lk.shlinkUri}" target="_blank" rel="noopener">Open in Viewer ↗</a>
                  <button class="btn btn-sm btn-toggle-lk">${lk.online ? "Take Offline" : "Bring online"}</button>
                  <button class="btn btn-sm btn-expire-lk">End open sessions</button>
                  <button class="btn btn-sm btn-danger btn-revoke-lk">Revoke</button>
                `
            }
          </div>
        </div>
      </div>
    `;

    card.querySelector(".qr-thumb")?.addEventListener("click", () => {
      showQrModal(lk.label, lk.shlinkUri);
    });

    if (lk.revoked) {
      card.querySelector(".btn-try-revoked")?.addEventListener("click", () => {
        onTryInCurrentTab(lk.shlinkUri);
      });
    } else {
      card.querySelector(".btn-copy-lk")!.addEventListener("click", () => {
        navigator.clipboard?.writeText(lk.shlinkUri);
        onStatus(`Copied SMART Health Link for "${lk.label}".`);
      });
      card.querySelector(".btn-toggle-lk")!.addEventListener("click", async () => {
        await api.patchLink(sandbox.sid, lk.lid, sandbox.controlToken, { online: !lk.online });
        lk.online = !lk.online;
        onRefresh();
      });
      card.querySelector(".btn-expire-lk")!.addEventListener("click", async () => {
        const revoked = await api.endLinkSessions(sandbox.sid, lk.lid, sandbox.controlToken);
        onStatus(`Ended ${revoked} open session(s).`);
      });
      card.querySelector(".btn-revoke-lk")!.addEventListener("click", async () => {
        await api.deleteLink(sandbox.sid, lk.lid, sandbox.controlToken);
        lk.revoked = true;
        lk.online = false;
        onRefresh();
      });
    }

    container.appendChild(card);
  }
}

export async function syncSandboxLinkStates(api: ApiClient, sandbox: SandboxState) {
  try {
    const share = await api.getShare(sandbox.sid, sandbox.controlToken);
    const byId = new Map(share.links.map((l) => [l.id, l]));
    for (const lk of sandbox.links) {
      if (lk.revoked) continue;
      const srv = byId.get(lk.lid);
      if (!srv) {
        lk.revoked = true;
        lk.online = false;
      } else {
        lk.online = srv.online;
        lk.hasPasscode = srv.hasPasscode;
        lk.remainingAttempts = srv.remainingAttempts;
      }
    }
  } catch {}
}

export async function mintStudyLinkOnSandbox(
  api: ApiClient,
  sandbox: SandboxState,
  studyIndex: StudyIndex,
  label: string,
  passcode: string | undefined,
  longLived: boolean,
) {
  const checkedEls = Array.from(document.querySelectorAll<HTMLInputElement>(".study-subset-cb:checked"));
  const checkedStudyIndices = checkedEls.length > 0
    ? checkedEls.map((el) => Number(el.dataset.studyIdx))
    : studyIndex.studies.map((_, i) => i);

  const selectedFileIds: string[] = [];
  const selectedNames: string[] = [];
  for (const sIdx of checkedStudyIndices) {
    const st = studyIndex.studies[sIdx];
    if (st) {
      selectedNames.push(st.description ?? `Study ${sIdx + 1}`);
      for (const ser of st.series) selectedFileIds.push(ser.fileId);
    }
  }
  if (selectedFileIds.length === 0) throw new Error("Select at least one study to share.");

  const studiesSummary =
    selectedNames.length === 1 && studyIndex.studies.length > 1
      ? `${selectedNames[0]} only`
      : selectedNames.join(" + ");

  const built = JSON.parse(
    build_link_bundle_wasm(sandbox.ownerBundleJson, JSON.stringify(selectedFileIds), undefined, new Date().toISOString()),
  ) as { bundleJwe: string; shlKeyB64: string; allowedFiles: string[] };

  const linkRes = await api.createLink(sandbox.sid, sandbox.controlToken, {
    label,
    passcode,
    longLived,
    allowedFiles: built.allowedFiles,
  });
  const updated = await api.putLinkBundle(sandbox.sid, linkRes.id, sandbox.controlToken, built.bundleJwe);
  const shlinkUri = encode_shlink_wasm(
    JSON.stringify({
      url: updated.url,
      key: built.shlKeyB64,
      flag: updated.flag ?? "U",
      label,
      v: 1,
    }),
    `${globalThis.location.origin}/`,
  );
  sandbox.links.unshift({
    lid: updated.id,
    label,
    shlinkUri,
    studiesSummary,
    online: true,
    hasPasscode: Boolean(passcode),
    remainingAttempts: updated.remainingAttempts,
  });
  return { linkRes: updated, shlinkUri };
}

export async function packUploadedFilesToSandbox(api: ApiClient, files: FileList): Promise<SandboxState> {
  const packer = new WasmPacker();
  for (const f of Array.from(files)) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const low = f.name.toLowerCase();
    if (low.endsWith(".tgz") || low.endsWith(".tar.gz")) packer.add_tgz(bytes);
    else if (low.endsWith(".zip")) packer.add_zip(bytes);
    else packer.add_dicom_file(f.name, bytes);
  }
  const packed = packer.pack(new Date().toISOString(), undefined);
  const created = await api.createShare();
  const sid = created.share.id;
  const token = created.controlToken;
  await api.putOwnerBundle(sid, token, packed.owner_jwe);
  for (let i = 0; i < packed.series_file_count; i++) {
    await api.putSeriesFile(sid, token, packed.series_file_id(i), packed.series_file_ciphertext(i));
  }
  const index: StudyIndex = JSON.parse(packed.index_json);
  const sb: SandboxState = { sid, controlToken: token, ownerBundleJson: packed.owner_bundle_json, links: [] };
  await mintStudyLinkOnSandbox(api, sb, index, "Browser-Packed Link", undefined, false);
  return sb;
}
