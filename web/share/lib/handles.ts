// Remembering the picked files across a reload. Where the browser has the File System Access API
// (Chromium), the picked files or folder are kept as handles in IndexedDB, and an interrupted upload
// can read them again after one permission click. Elsewhere the person picks the same files again,
// and they are matched to the upload by name, size and a quick hash (quickId).

const DB = "shl-dicom-share";
const STORE = "handles";
const KEY = "upload";

export type PickedHandles = { kind: "files"; handles: FileSystemFileHandle[] } | { kind: "folder"; handles: FileSystemDirectoryHandle[] };

export const canPickHandles = () => typeof (window as any).showOpenFilePicker === "function" && typeof (window as any).showDirectoryPicker === "function";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

/** The files of the upload to share `sid`, kept to continue it after a reload. */
export async function saveHandles(sid: string, h: PickedHandles): Promise<boolean> {
  try {
    await tx("readwrite", (s) => s.put(h, `${KEY}:${sid}`));
    return true;
  } catch {
    return false;
  }
}

export async function loadHandles(sid: string): Promise<PickedHandles | null> {
  try {
    return ((await tx("readonly", (s) => s.get(`${KEY}:${sid}`))) as PickedHandles) ?? null;
  } catch {
    return null;
  }
}

export async function clearHandles(sid: string) {
  try {
    await tx("readwrite", (s) => s.delete(`${KEY}:${sid}`));
  } catch {}
}

/** Read permission for every handle; asks (needs a click) when the browser hasn't kept it. */
export async function permitted(h: PickedHandles): Promise<boolean> {
  for (const x of h.handles as any[]) {
    let p = (await x.queryPermission?.({ mode: "read" })) ?? "granted";
    if (p === "prompt") p = await x.requestPermission({ mode: "read" });
    if (p !== "granted") return false;
  }
  return true;
}

function named(f: File, path: string): File {
  Object.defineProperty(f, "webkitRelativePath", { value: path });
  return f;
}

async function walk(dir: FileSystemDirectoryHandle, path: string, out: File[]) {
  for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind === "file") out.push(named(await (h as FileSystemFileHandle).getFile(), `${path}${name}`));
    else await walk(h as FileSystemDirectoryHandle, `${path}${name}/`, out);
  }
}

/** The files behind the handles, with folder paths as webkitRelativePath. */
export async function filesFrom(h: PickedHandles): Promise<File[]> {
  const out: File[] = [];
  if (h.kind === "files") for (const x of h.handles) out.push(await x.getFile());
  else for (const d of h.handles) await walk(d, `${d.name}/`, out);
  return out;
}

/** Opens the browser's picker; null when the person cancels. */
export async function pick(kind: "files" | "folder"): Promise<PickedHandles | null> {
  try {
    if (kind === "files") return { kind, handles: await (window as any).showOpenFilePicker({ multiple: true }) };
    return { kind, handles: [await (window as any).showDirectoryPicker({ mode: "read" })] };
  } catch {
    return null;
  }
}

/** SHA-256 of a file's size and its first and last 64 KiB: enough to tell a different file. */
export async function quickId(f: File): Promise<string> {
  const n = 64 << 10;
  const head = new Uint8Array(await f.slice(0, n).arrayBuffer());
  const tail = new Uint8Array(await f.slice(Math.max(0, f.size - n)).arrayBuffer());
  const buf = new Uint8Array(8 + head.length + tail.length);
  new DataView(buf.buffer).setFloat64(0, f.size);
  buf.set(head, 8);
  buf.set(tail, 8 + head.length);
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return Array.from(d.subarray(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const pathOf = (f: File) => (f as any).webkitRelativePath || f.name;
