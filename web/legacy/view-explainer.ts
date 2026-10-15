import type { StudySummary, SeriesSummary } from "./view-sharer";
import type { SeriesRecordTracker } from "./record-map";

export interface ExplainerContext {
  shlUri: string;
  shlPayload: any;
  baseUrl: string;
  study: StudySummary | undefined;
  series: SeriesSummary | undefined;
  instanceIdx: number;
  tracker: SeriesRecordTracker;
}

export function renderExplainerView(ctx: ExplainerContext) {
  const { shlPayload, baseUrl, study, series, instanceIdx, tracker } = ctx;

  const flagEl = document.getElementById("exp-shl-flag");
  const urlEl = document.getElementById("exp-shl-url");
  const shlJsonEl = document.getElementById("exp-shl-json");
  if (flagEl) flagEl.textContent = shlPayload ? `"${shlPayload.flag}" (${shlPayload.flag.includes("P") ? "Passcode / Manifest" : "Direct U-mode"})` : "—";
  const rawUrl = baseUrl || shlPayload?.url || "—";
  if (urlEl) {
    urlEl.textContent = rawUrl.replaceAll("/", "/\u200b");
    urlEl.title = rawUrl;
  }
  if (shlJsonEl) shlJsonEl.textContent = shlPayload ? JSON.stringify(shlPayload, null, 2) : "—";

  if (!study || !series) return;
  const inst = series.instances[instanceIdx] ?? series.instances[0];
  if (!inst) return;

  const labelEl = document.getElementById("exp-slice-label");
  if (labelEl) {
    labelEl.textContent = `${series.description ?? series.modality ?? "Series"} · Slice ${instanceIdx + 1}/${series.instances.length}`;
  }

  const sfEl = document.getElementById("exp-series-file");
  const offEl = document.getElementById("exp-inst-offset");
  if (sfEl) sfEl.textContent = `${series.fileId}.bin`;
  if (offEl) {
    offEl.textContent = `[${inst.offset.toLocaleString()} .. ${(inst.offset + inst.length).toLocaleString()}) (${(inst.length / 1024).toFixed(1)} KB)`;
  }

  const fhirExcerpt = {
    resourceType: "ImagingStudy",
    meta: { profile: ["https://example.org/shl-dicom/v1"] },
    identifier: [{ system: "urn:dicom:uid", value: `urn:oid:${study.studyInstanceUid}` }],
    series: [
      {
        uid: series.uid,
        modality: { code: series.modality ?? "OT" },
        description: series.description,
        extension: [
          {
            url: "https://example.org/shl-dicom/series-file",
            extension: [
              { url: "id", valueString: series.fileId },
              { url: "key", valueString: series.key },
            ],
          },
        ],
        instance: [
          {
            uid: inst.uid,
            number: inst.number ?? instanceIdx + 1,
            extension: [{ url: "https://example.org/shl-dicom/length", valueInteger: inst.length }],
          },
        ],
      },
    ],
  };
  const fhirEl = document.getElementById("exp-fhir-json");
  if (fhirEl) fhirEl.textContent = JSON.stringify(fhirExcerpt, null, 2);

  const firstRec = Math.floor(inst.offset / 65520);
  const lastRec = Math.floor((inst.offset + inst.length - 1) / 65520);
  const cStart = firstRec * 65536;
  const cEnd = Math.min((lastRec + 1) * 65536, series.ciphertextLength) - 1;
  const skip = inst.offset - firstRec * 65520;
  const nonceHex = `0x${firstRec.toString(16).padStart(24, "0")}`;

  const mathEl = document.getElementById("exp-math-box");
  if (mathEl) {
    mathEl.innerHTML = [
      `1. Plaintext span : bytes [${inst.offset.toLocaleString()} .. ${(inst.offset + inst.length).toLocaleString()})`,
      `2. Record indices : floor(${inst.offset} / 65520) .. floor(${inst.offset + inst.length - 1} / 65520)  →  Records #${firstRec}..#${lastRec}`,
      `3. HTTP 206 Range : GET ${series.fileId}.bin  (Range: bytes=${cStart}-${cEnd})`,
      `4. AES-256-GCM    : nonce = uint96_be(${firstRec}) = ${nonceHex}, trim skip=${skip} B`,
    ].join("\n");
  }

  const fileIdEl = document.getElementById("record-map-fileid");
  if (fileIdEl) fileIdEl.textContent = `${series.fileId}.bin (${series.recordCount} records)`;

  const expCanvas = document.getElementById("explainer-record-canvas") as HTMLCanvasElement | null;
  if (expCanvas) {
    tracker.drawCanvasBar(expCanvas, series.fileId, firstRec, lastRec);
  }

  const csIdEl = document.getElementById("bridge-cs-id");
  const wadoEl = document.getElementById("bridge-wado-url");
  if (csIdEl) csIdEl.textContent = `shl-dicom://${study.studyInstanceUid}/${series.uid}/${inst.uid}`;
  if (wadoEl) wadoEl.textContent = `/dicomweb/studies/${study.studyInstanceUid}/series/${series.uid}/instances/${inst.uid}`;
}
