// The pre-existing decrypt path: WasmShlSession in crates/shl-dicom-wasm (Rust AES-GCM).
// Loaded only when config.decrypt is "wasm". It decrypts instance-aligned plans only.
import initWasm, { WasmShlSession } from "../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js";
import type { SeriesEntry } from "./bundle";
import type { RangePlan } from "./range";
import { RecordAuthenticationError, type RecordDecryptor } from "./decrypt";
import { assetUrl } from "./config";

let ready: Promise<unknown> | null = null;

export class WasmSessionDecryptor implements RecordDecryptor {
  readonly name = "wasm" as const;
  private constructor(
    private session: WasmShlSession,
    private where: Map<string, [number, number]>,
  ) {}

  static async create(bundleBytes: Uint8Array): Promise<WasmSessionDecryptor> {
    ready ??= initWasm({ module_or_path: assetUrl("shl_dicom_wasm_bg.wasm") });
    await ready;
    const session = WasmShlSession.from_bundle_json(new TextDecoder().decode(bundleBytes));
    const idx = JSON.parse(session.index_json());
    const where = new Map<string, [number, number]>();
    idx.studies.forEach((st: any, a: number) => st.series.forEach((se: any, b: number) => where.set(se.fileId, [a, b])));
    return new WasmSessionDecryptor(session, where);
  }

  async decrypt(series: SeriesEntry, plan: RangePlan, ciphertext: Uint8Array): Promise<Uint8Array> {
    const loc = this.where.get(series.fileId);
    if (!loc || plan.firstInstance < 0) throw new Error("wasm decryptor: instance-aligned plans only");
    try {
      this.session.ingest_ciphertext_range(series.fileId, plan.firstRecord, ciphertext);
    } catch (e) {
      throw new RecordAuthenticationError(series.fileId, plan.firstRecord, `failed its integrity check (${e})`);
    }
    const out = new Uint8Array(plan.plaintextEnd - plan.plaintextStart);
    let o = 0;
    for (let i = plan.firstInstance; i <= plan.lastInstance; i++) {
      const b = this.session.get_instance_dicom(loc[0], loc[1], i);
      out.set(b, o);
      o += b.length;
    }
    return out;
  }
}
