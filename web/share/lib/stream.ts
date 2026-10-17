// Compressing while uploading: each study's file goes to the server as its images are compressed,
// instead of after all of them are. Instances join their file in file order; an instance whose
// compression finishes early waits for the ones before it. lib/upload.ts sends a file's records as
// its plaintext grows and gives the server the length with the last append.
import { ciphertextLength, RECORD_CIPHERTEXT, RECORD_PLAINTEXT, recordCount } from "../../core/range";
import type { Instance } from "./ingest";
import { Growing, type UploadFile, type UploadProgress } from "./upload";

export class StreamPlan {
  /** Each instance's size before compression: the progress bar's unit. */
  private input = new Map<Instance, number>();
  /** Bytes of every instance before compression: the progress bar's known total. */
  readonly inputTotal: number;
  private where = new Map<Instance, UploadFile>();
  private ready = new Set<Instance>();
  /** Per file, how many of its instances (from the start) are in. */
  private cursor = new Map<UploadFile, number>();

  /** `pending`: instances whose bytes are not final yet (images still to compress). */
  constructor(
    readonly files: UploadFile[],
    pending: (inst: Instance) => boolean,
  ) {
    let total = 0;
    for (const p of files) {
      p.growing = new Growing();
      this.cursor.set(p, 0);
      for (const inst of p.instances) {
        this.input.set(inst, inst.src.size);
        total += inst.src.size;
        this.where.set(inst, p);
        if (!pending(inst)) this.ready.add(inst);
      }
    }
    this.inputTotal = total;
    for (const p of files) this.advance(p);
  }

  /** An instance's final bytes are in place. */
  done(inst: Instance) {
    this.ready.add(inst);
    const p = this.where.get(inst);
    if (p) this.advance(p);
  }

  /** The rest will never come: uploads waiting for it fail with `e`. */
  fail(e: unknown) {
    for (const p of this.files) if (!p.growing!.done) p.growing!.fail(e);
  }

  private advance(p: UploadFile) {
    let k = this.cursor.get(p)!;
    let P = p.growing!.ready;
    while (k < p.instances.length && this.ready.has(p.instances[k])) P += p.instances[k++].src.size;
    this.cursor.set(p, k);
    p.plaintextLength = P;
    p.records = recordCount(P);
    p.growing!.grow(P, k === p.instances.length);
  }

  /**
   * Input bytes done: each instance counts by the share of its bytes (as uploaded, compressed or
   * not) that the server has. Reaches `inputTotal` when every file is complete.
   */
  inputDone(u: Pick<UploadProgress, "offsets" | "sending">): number {
    let sum = 0;
    for (const p of this.files) {
      let off = Math.max(0, u.offsets.get(p.fileId) ?? 0);
      if (u.sending?.fileId === p.fileId) off = Math.max(off, u.sending.offset);
      const whole = p.growing!.done && off >= ciphertextLength(p.plaintextLength);
      const U = whole ? p.plaintextLength : Math.floor(off / RECORD_CIPHERTEXT) * RECORD_PLAINTEXT;
      const k = this.cursor.get(p)!;
      let a = 0;
      for (let i = 0; i < k && a < U; i++) {
        const inst = p.instances[i];
        const b = a + inst.src.size;
        sum += this.input.get(inst)! * Math.min(1, (U - a) / (b - a || 1));
        a = b;
      }
    }
    return Math.min(this.inputTotal, sum);
  }
}
