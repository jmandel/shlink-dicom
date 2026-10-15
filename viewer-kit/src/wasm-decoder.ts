// Thin wrapper over the raw exports of codecs/shl-dicom-decode-wasm. Used by the pool's worker
// and, unchanged, by the Node correctness test. One instance decodes one file at a time.
import type { ImageInfo } from "./types";

interface Exports {
  memory: WebAssembly.Memory;
  vk_alloc(len: number): number;
  vk_free(ptr: number, len: number): void;
  vk_decode(ptr: number, len: number, first: number, count: number): number;
  /** Absent from wasm builds older than the reduced-resolution decode. */
  vk_decode_scaled?(ptr: number, len: number, first: number, count: number, scale: number): number;
  vk_probe(ptr: number, len: number): number;
  vk_out_ptr(): number;
  vk_out_len(): number;
  vk_out_free(): void;
  vk_json_ptr(): number;
  vk_json_len(): number;
  vk_msg_ptr(): number;
  vk_msg_len(): number;
  vk_lut_ptr(): number;
  vk_lut_len(): number;
}

export interface Probe {
  frames: number;
  /** True when frames can be decoded separately (encapsulated transfer syntax). */
  encapsulated: boolean;
  transferSyntax: string;
}

export type RawResult =
  | { ok: true; info: ImageInfo & { palette: { first: number; count: number } | null }; pixels: ArrayBuffer; lut: ArrayBuffer | null; ms: number }
  | { ok: false; code: number; message: string; ms: number };

const td = new TextDecoder();

export class WasmDecoder {
  private constructor(private x: Exports) {}

  static async create(module: WebAssembly.Module): Promise<WasmDecoder> {
    const inst = await WebAssembly.instantiate(module, {});
    return new WasmDecoder(inst.exports as unknown as Exports);
  }

  /** Linear memory size in bytes (it only grows; the worker recycles big instances). */
  get memoryBytes(): number {
    return this.x.memory.buffer.byteLength;
  }

  private text(ptr: number, len: number): string {
    return td.decode(new Uint8Array(this.x.memory.buffer, ptr, len));
  }

  private withInput<T>(bytes: Uint8Array, fn: (ptr: number, len: number) => T): T {
    const len = bytes.byteLength;
    const ptr = this.x.vk_alloc(len);
    try {
      new Uint8Array(this.x.memory.buffer, ptr, len).set(bytes);
      return fn(ptr, len);
    } finally {
      this.x.vk_free(ptr, len);
    }
  }

  probe(bytes: Uint8Array): Probe | { error: number; message: string } {
    return this.withInput(bytes, (p, n) => {
      const rc = this.x.vk_probe(p, n);
      if (rc !== 0) return { error: rc, message: this.text(this.x.vk_msg_ptr(), this.x.vk_msg_len()) };
      return JSON.parse(this.text(this.x.vk_json_ptr(), this.x.vk_json_len())) as Probe;
    });
  }

  /**
   * Decode frames first..first+count (count 0: all). Pixels are copied out of wasm memory once.
   * `scale` s > 0 decodes at 1/2^s size (rows and columns rounded up); see INTEGRATION.md.
   */
  decode(bytes: Uint8Array, first = 0, count = 0, scale = 0): RawResult {
    if (scale > 0 && !this.x.vk_decode_scaled) {
      return { ok: false, code: 3, message: "this decoder build has no reduced-resolution decode (vk_decode_scaled)", ms: 0 };
    }
    return this.withInput(bytes, (p, n) => {
      const t0 = performance.now();
      const rc = scale > 0 ? this.x.vk_decode_scaled!(p, n, first, count, scale) : this.x.vk_decode(p, n, first, count);
      const ms = performance.now() - t0;
      if (rc !== 0) return { ok: false, code: rc, message: this.text(this.x.vk_msg_ptr(), this.x.vk_msg_len()), ms };
      const info = JSON.parse(this.text(this.x.vk_json_ptr(), this.x.vk_json_len()));
      const pixels = new Uint8Array(this.x.memory.buffer, this.x.vk_out_ptr(), this.x.vk_out_len()).slice().buffer;
      this.x.vk_out_free();
      const lutLen = this.x.vk_lut_len();
      const lut = lutLen ? new Uint8Array(this.x.memory.buffer, this.x.vk_lut_ptr(), lutLen).slice().buffer : null;
      return { ok: true, info, pixels, lut, ms };
    });
  }
}
