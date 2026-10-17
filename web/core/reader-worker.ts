// The link reader's worker (reader.ts): the reader module (crates/shl-dicom-reader) off the page's
// thread. The page sends {init: wasmUrl} once, then calls {id, fn, args}; each answer is
// {id, value} (bytes transferred) or {id, error: {code, message}}.
import init, * as m from "../../crates/shl-dicom-reader/pkg/shl_dicom_reader.js";
import { readerError, runCall } from "./reader-call";

let ready: Promise<unknown> | null = null;

self.onmessage = async (e: MessageEvent) => {
  const d = e.data;
  if (d.init) {
    ready = init({ module_or_path: d.init });
    return;
  }
  try {
    await ready;
    const { value, transfer } = runCall(m, d);
    (self as unknown as Worker).postMessage({ id: d.id, value }, transfer ?? []);
  } catch (err) {
    const r = readerError(err);
    (self as unknown as Worker).postMessage({ id: d.id, error: { code: r.code, message: r.message } });
  }
};
