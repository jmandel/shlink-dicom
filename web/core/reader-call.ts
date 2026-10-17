// The reader module's calls (crates/shl-dicom-reader), shared by reader.ts (in place) and
// reader-worker.ts (in the worker).
/** A failure of the reader, with its stable code (crates/shl-dicom-reader/README.md). */
export class ReaderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReaderError";
  }
}

export type Call = { fn: "parse_link"; args: [string, number] } | { fn: "manifest_location"; args: [string] } | { fn: "open_bundle"; args: [string, string] } | { fn: "parse_index"; args: [Uint8Array] } | { fn: "decrypt_bundle"; args: [string, string] } | { fn: "has_frame_start_marker"; args: [string] } | { fn: "is_frame_start"; args: [string, Uint8Array[]] };

export type ReaderModule = typeof import("../../crates/shl-dicom-reader/pkg/shl_dicom_reader.js");

/** The module's functions on their results: what the worker sends back for each call. */
export function runCall(m: ReaderModule, c: Call): { value: any; transfer?: ArrayBuffer[] } {
  switch (c.fn) {
    case "parse_link":
      return { value: m.parse_link(c.args[0], c.args[1]) };
    case "manifest_location":
      return { value: m.manifest_location(c.args[0]) };
    case "parse_index":
      return { value: m.parse_index(c.args[0]) };
    case "has_frame_start_marker":
      return { value: m.has_frame_start_marker(c.args[0]) };
    case "is_frame_start":
      // Several fragments' heads in one call.
      return { value: c.args[1].map((head) => m.is_frame_start(c.args[0], head)) };
    case "decrypt_bundle": {
      const b = m.decrypt_bundle(c.args[0], c.args[1]);
      return { value: b, transfer: [b.buffer as ArrayBuffer] };
    }
    case "open_bundle": {
      const o = m.open_bundle(c.args[0], c.args[1]);
      const value = { index: o.index, bundle: o.bundle };
      o.free();
      return { value, transfer: [value.bundle.buffer as ArrayBuffer] };
    }
  }
}

/** The module's thrown error as a ReaderError (its message is JSON {code, message}). */
export function readerError(e: unknown): ReaderError {
  const msg = (e as Error)?.message ?? String(e);
  try {
    const j = JSON.parse(msg);
    if (typeof j?.code === "string") return new ReaderError(j.code, String(j.message ?? j.code));
  } catch {}
  return new ReaderError("internal", msg);
}

