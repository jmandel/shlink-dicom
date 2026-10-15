import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import init, {
  build_link_bundle_wasm,
  encode_shlink_wasm,
  WasmPacker,
  WasmShlSession,
} from "../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js";

test("Stage 3: WasmPacker, WasmShlSession, bounded LRU cache, RGBA render & DICOM/ZIP export", async () => {
  const wasmBytes = readFileSync("crates/shl-dicom-wasm/pkg/shl_dicom_wasm_bg.wasm");
  await init({ module_or_path: wasmBytes });

  // 1. Pack wrist-low-res.tgz in WASM
  const wristTgz = readFileSync("data/samples/wrist-low-res.tgz");
  const packer = new WasmPacker();
  const count = packer.add_tgz(wristTgz);
  expect(count).toBe(3);

  const packed = packer.pack("2026-10-14T17:00:00Z", undefined);
  expect(packed.series_file_count).toBe(3);
  const fileId = packed.series_file_id(0);
  const seriesCiphertext = packed.series_file_ciphertext(0);
  expect(fileId.length).toBe(22);
  expect(seriesCiphertext.length).toBeGreaterThan(1_500_000);

  // 2. Build a Link Bundle in WASM (subsetting to the first series) and encode shlink:/ URI
  const linkBundleStr = build_link_bundle_wasm(
    packed.owner_bundle_json,
    JSON.stringify([fileId]),
    undefined,
    "2026-10-14T17:00:00Z",
  );
  const linkBundle = JSON.parse(linkBundleStr);
  expect(linkBundle.allowedFiles).toEqual([`${fileId}.bin`]);

  const shlinkUri = encode_shlink_wasm(
    JSON.stringify({
      url: "https://host.example/shl/demo/bundle.jwe",
      key: linkBundle.shlKeyB64,
      flag: "U",
      label: "Wrist Study",
      v: 1,
    }),
    "https://viewer.example/",
  );
  expect(shlinkUri.startsWith("https://viewer.example/#shlink:/")).toBe(true);

  // 3. Initialize WasmShlSession from shlinkUri + bundleJwe
  const session = new WasmShlSession(shlinkUri, linkBundle.bundleJwe);
  const index = JSON.parse(session.index_json());
  expect(index.studies.length).toBe(1);
  expect(index.studies[0].series.length).toBe(1);
  expect(index.studies[0].series[0].instances.length).toBe(1);

  // 4. Plan instance range (instance 0) and ingest those 64 KiB records
  expect(session.has_instance(0, 0, 0)).toBe(false);
  const plan = JSON.parse(session.plan_instance_range(0, 0, 0));
  expect(plan.fileId).toBe(fileId);
  const ctSlice = seriesCiphertext.subarray(plan.ciphertextStart, plan.ciphertextEnd);

  const ingestRes = JSON.parse(
    session.ingest_ciphertext_range(fileId, plan.firstRecord, ctSlice),
  );
  expect(ingestRes.verifiedRecords.length).toBe(plan.lastRecord - plan.firstRecord + 1);
  expect(session.has_instance(0, 0, 0)).toBe(true);

  // 5. Render instance to RGBA8 in WASM
  const rendered = session.render_instance_rgba(0, 0, 0, undefined, undefined);
  expect(rendered.width).toBeGreaterThan(1000);
  expect(rendered.height).toBeGreaterThan(1000);
  expect(rendered.rgba_bytes().length).toBe(rendered.width * rendered.height * 4);

  // 6. Extract exact Part 10 DICOM slice bytes
  const dcmSlice = session.get_instance_dicom(0, 0, 0);
  expect(dcmSlice.length).toBe(index.studies[0].series[0].instances[0].length);
  expect(new TextDecoder().decode(dcmSlice.subarray(128, 132))).toBe("DICM");

  // 7. Export uncompressed ZIP
  const zipBytes = session.export_series_zip(0, 0);
  expect(zipBytes.length).toBeGreaterThan(dcmSlice.length);

  // 8. Verify bounded LRU record cache eviction
  expect(session.cached_record_count()).toBeGreaterThan(10);
  session.set_max_cached_records(5);
  expect(session.cached_record_count()).toBe(5);
});
