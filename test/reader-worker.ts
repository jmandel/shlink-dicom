// The Worker test/reader.test.ts starts: opens a Bundle with the reader module, off the main thread.
import { initSync, open_bundle } from "../crates/shl-dicom-reader/pkg/shl_dicom_reader.js";

self.onmessage = (e: MessageEvent) => {
  try {
    initSync({ module: e.data.wasm });
    const o = open_bundle(e.data.jwe, e.data.key);
    const bundle = o.bundle;
    postMessage({ index: o.index, bundle }, [bundle.buffer]);
  } catch (err) {
    postMessage({ error: String(err) });
  }
};
