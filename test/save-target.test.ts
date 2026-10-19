import { expect, test } from "bun:test";
import { openSaveTarget, MAX_BLOB_DOWNLOAD_BYTES, BlobDownloadLimitError } from "../web/core/save";

test("an oversized Blob download fails before reading source bytes", async () => {
  await expect(openSaveTarget("large.zip", "application/zip", ".zip", MAX_BLOB_DOWNLOAD_BYTES + 1)).rejects.toBeInstanceOf(BlobDownloadLimitError);
});

test("the Blob budget also accounts for archive overhead and unknown-size sources", async () => {
  const target = await openSaveTarget("file.zip", "application/zip", ".zip");
  const chunk = new Uint8Array(64 << 20);
  for (let i = 0; i < 8; i++) await target!.write(chunk);
  await expect(target!.write(new Uint8Array(1))).rejects.toBeInstanceOf(BlobDownloadLimitError);
  await target!.abort();
});

test("direct disk destinations retain support beyond the Blob budget", async () => {
  const g = globalThis as any, previous = g.showSaveFilePicker;
  let closed = false;
  g.showSaveFilePicker = async () => ({ createWritable: async () => ({ async write() {}, async close() { closed = true; }, async abort() {} }) });
  try {
    const target = await openSaveTarget("large.dcm", "application/dicom", ".dcm", 5 * 2 ** 30);
    expect(target!.kind).toBe("file"); await target!.close(); expect(closed).toBe(true);
  } finally { if (previous === undefined) delete g.showSaveFilePicker; else g.showSaveFilePicker = previous; }
});
