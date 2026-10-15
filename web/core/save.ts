// Saving a download: straight to a file chosen with the File System Access API where the browser
// has it (bytes go to disk as they are produced), else collected into a Blob and saved by a link.
import type { ByteSink } from "./zip";

export interface SaveTarget extends ByteSink {
  /** "file": streaming to a file the user chose. "blob": saved when closed. */
  readonly kind: "file" | "blob";
}

/**
 * Opens a save target. Call it directly from the click handler, before any other await, so the
 * browser still treats the save dialog as user-initiated. Resolves null if the user cancels.
 */
export async function openSaveTarget(suggestedName: string, mime: string, ext: string): Promise<SaveTarget | null> {
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
  const parts: Uint8Array[] = [];
  return {
    kind: "blob",
    write: async (c) => {
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
