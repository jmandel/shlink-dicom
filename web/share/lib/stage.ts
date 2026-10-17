// Staging: bytes that can't be read in place (decompressed archive members, portal downloads) are
// written to the origin-private file system, so they never sit in memory and survive a reload
// (an interrupted upload can continue from them). Without that file system, they stay in memory.
import { BlobBytes, MemBytes, type Bytes } from "./bytes";

export interface Stager {
  /** Writes the chunks to a new staged file and returns it as a byte source. */
  stage(name: string, chunks: AsyncIterable<Uint8Array>): Promise<Bytes>;
  /** Staged files from an earlier visit (same session id), in the order they were written. */
  list(): Promise<Bytes[]>;
  /** One staged file by its name (a staged BlobBytes's File name), or null when it is gone. */
  open(name: string): Promise<Bytes | null>;
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
  /** Numbers files after those already staged, so a reopened session never overwrites one. */
  private counted: Promise<void> | null = null;
  async stage(_name: string, chunks: AsyncIterable<Uint8Array>): Promise<Bytes> {
    await (this.counted ??= this.count());
    const fh = await this.dir.getFileHandle(String(this.n++).padStart(8, "0"), { create: true });
    const w = await (fh as any).createWritable();
    try {
      for await (const c of chunks) await w.write(c);
    } finally {
      await w.close();
    }
    return new BlobBytes(await fh.getFile());
  }
  private async count() {
    for await (const [name, h] of (this.dir as any).entries()) if (h.kind === "file" && /^\d+$/.test(name)) this.n = Math.max(this.n, Number(name) + 1);
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
  async open(name: string): Promise<Bytes | null> {
    try {
      return new BlobBytes(await (await this.dir.getFileHandle(name)).getFile());
    } catch {
      return null;
    }
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
  async open() {
    return null;
  }
}

const stageLock = (session: string) => `shl-dicom-stage:${session}`;
/** Sessions this tab uses, each with its Web Lock's release. */
const heldStages = new Map<string, () => void>();

/** Marks the session as this tab's until the tab closes, so another tab's clearStaging skips it. */
function holdStage(session: string): Promise<void> {
  const locks = (globalThis.navigator as any)?.locks;
  if (!locks || heldStages.has(session)) return Promise.resolve();
  return new Promise((resolve) => {
    locks
      .request(stageLock(session), { ifAvailable: true }, (lock: unknown) => {
        resolve();
        // Another tab has it: it stays theirs (and neither tab clears it while it does).
        if (!lock) return;
        return new Promise<void>((release) => heldStages.set(session, release));
      })
      .catch(() => resolve());
  });
}

/** A stager for a session (a new one when `session` is omitted). */
export async function openStager(session = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`): Promise<Stager> {
  const root = await opfsRoot();
  if (!root) return new MemoryStager(session);
  await holdStage(session);
  const base = await root.getDirectoryHandle(ROOT, { create: true });
  return new OpfsStager(session, await base.getDirectoryHandle(session, { create: true }));
}

/**
 * Removes staged sessions other than those in `keep`, and other than those another tab is using
 * (its Web Lock is held). This tab's own sessions not kept are released and removed.
 */
export async function clearStaging(...keep: (string | null | undefined)[]) {
  const root = await opfsRoot();
  if (!root) return;
  const locks = (globalThis.navigator as any)?.locks;
  try {
    const base = await root.getDirectoryHandle(ROOT, { create: true });
    const names: string[] = [];
    for await (const [name, h] of (base as any).entries()) if (h.kind === "directory" && !keep.includes(name)) names.push(name);
    for (const name of names) {
      const remove = () => base.removeEntry(name, { recursive: true }).catch(() => {});
      const mine = heldStages.get(name);
      if (mine) {
        await remove();
        mine();
        heldStages.delete(name);
      } else if (!locks) await remove();
      else await locks.request(stageLock(name), { ifAvailable: true }, (lock: unknown) => (lock ? remove() : undefined));
    }
  } catch {}
}

/** An in-memory stager for scripts (Bun) and tests. */
export function memoryStager(): Stager {
  return new MemoryStager("memory");
}
