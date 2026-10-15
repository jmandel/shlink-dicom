// Staging: bytes that can't be read in place (decompressed archive members, portal downloads) are
// written to the origin-private file system, so they never sit in memory and survive a reload
// (an interrupted upload can continue from them). Without that file system, they stay in memory.
import { BlobBytes, MemBytes, type Bytes } from "./bytes";

export interface Stager {
  /** Writes the chunks to a new staged file and returns it as a byte source. */
  stage(name: string, chunks: AsyncIterable<Uint8Array>): Promise<Bytes>;
  /** Staged files from an earlier visit (same session id), in the order they were written. */
  list(): Promise<Bytes[]>;
  readonly session: string;
  readonly onDisk: boolean;
}

const ROOT = "share-staging";

async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return null;
    // createWritable is what we need; older engines have only sync access handles in workers.
    const probe = await (await root.getDirectoryHandle(ROOT, { create: true })).getFileHandle(".probe", { create: true });
    if (typeof (probe as any).createWritable !== "function") return null;
    return root;
  } catch {
    return null;
  }
}

class OpfsStager implements Stager {
  readonly onDisk = true;
  private n = 0;
  constructor(
    readonly session: string,
    private dir: FileSystemDirectoryHandle,
  ) {}
  async stage(_name: string, chunks: AsyncIterable<Uint8Array>): Promise<Bytes> {
    const fh = await this.dir.getFileHandle(String(this.n++).padStart(8, "0"), { create: true });
    const w = await (fh as any).createWritable();
    try {
      for await (const c of chunks) await w.write(c);
    } finally {
      await w.close();
    }
    return new BlobBytes(await fh.getFile());
  }
  async list(): Promise<Bytes[]> {
    const names: string[] = [];
    for await (const [name, h] of (this.dir as any).entries()) if (h.kind === "file") names.push(name);
    names.sort();
    this.n = names.length ? Number(names[names.length - 1]) + 1 : 0;
    const out: Bytes[] = [];
    for (const name of names) out.push(new BlobBytes(await (await this.dir.getFileHandle(name)).getFile()));
    return out;
  }
}

class MemoryStager implements Stager {
  readonly onDisk = false;
  constructor(readonly session: string) {}
  async stage(_name: string, chunks: AsyncIterable<Uint8Array>): Promise<Bytes> {
    const parts: Uint8Array[] = [];
    let n = 0;
    for await (const c of chunks) {
      parts.push(c.slice());
      n += c.length;
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) out.set(p, (o += p.length) - p.length);
    return new MemBytes(out);
  }
  async list() {
    return [];
  }
}

/** A stager for a session (a new one when `session` is omitted). */
export async function openStager(session = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`): Promise<Stager> {
  const root = await opfsRoot();
  if (!root) return new MemoryStager(session);
  const base = await root.getDirectoryHandle(ROOT, { create: true });
  return new OpfsStager(session, await base.getDirectoryHandle(session, { create: true }));
}

/** Removes staged sessions other than `keep`. */
export async function clearStaging(keep: string | null) {
  const root = await opfsRoot();
  if (!root) return;
  try {
    const base = await root.getDirectoryHandle(ROOT, { create: true });
    const names: string[] = [];
    for await (const [name, h] of (base as any).entries()) if (h.kind === "directory" && name !== keep) names.push(name);
    for (const name of names) await base.removeEntry(name, { recursive: true });
  } catch {}
}

/** An in-memory stager for scripts (Bun) and tests. */
export function memoryStager(): Stager {
  return new MemoryStager("memory");
}
