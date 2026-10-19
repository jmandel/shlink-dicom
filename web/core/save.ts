// Saving a download: straight to a file chosen with the File System Access API where the browser
// has it (bytes go to disk as they are produced), else collected into a Blob and saved by a link.
import type { ByteSink } from "./zip";

export interface SaveTarget extends ByteSink {
  /** "file": streaming to a file the user chose. "blob": saved when closed. */
  readonly kind: "file" | "blob";
}

/** A Blob retains all output, so it cannot promise the streaming destination's size support. */
export const MAX_BLOB_DOWNLOAD_BYTES = 512 * 1024 * 1024;
export class BlobDownloadLimitError extends Error {
  constructor() { super("This download is too large for this browser's in-memory save. Open the link in a desktop browser that supports saving directly to a file, or download a smaller series."); this.name = "BlobDownloadLimitError"; }
}
const blobLimitError = () => new BlobDownloadLimitError();

/**
 * Opens a save target. Call it directly from the click handler, before any other await, so the
 * browser still treats the save dialog as user-initiated. Resolves null if the user cancels.
 */
export async function openSaveTarget(suggestedName: string, mime: string, ext: string, expectedBytes = 0): Promise<SaveTarget | null> {
  const picker = (globalThis as any).showSaveFilePicker as undefined | ((o: any) => Promise<any>);
  if (typeof picker === "function") {
    try {
      const handle = await picker({
        suggestedName,
        types: [{ description: ext.toUpperCase().replace(".", "") + " file", accept: { [mime]: [ext] } }],
      });
      const w = await handle.createWritable();
      return {
        kind: "file",
        write: (c) => w.write(c),
        close: () => w.close(),
        abort: (r) => w.abort(r),
      };
    } catch (e) {
      if ((e as any)?.name === "AbortError") return null;
      // SecurityError (no user activation) or an unsupported environment: fall back to a Blob.
    }
  }
  if (expectedBytes > MAX_BLOB_DOWNLOAD_BYTES) throw blobLimitError();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  return {
    kind: "blob",
    write: async (c) => {
      if (bytes + c.length > MAX_BLOB_DOWNLOAD_BYTES) { parts.length = 0; throw blobLimitError(); }
      bytes += c.length;
      parts.push(c);
    },
    close: async () => {
      saveBlob(new Blob(parts as BlobPart[], { type: mime }), suggestedName);
      parts.length = 0;
    },
    abort: async () => {
      parts.length = 0;
    },
  };
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
