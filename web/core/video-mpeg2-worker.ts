// MPEG-2 decoding worker: runs codecs/mpeg2-wasm (FFmpeg, LGPL) over a Blob holding the video
// stream (MPEG-PS, MPEG-TS or a raw MPEG-2 video stream), reading it with FileReaderSync so the
// stream never has to fit in wasm memory. Loaded only when a study contains MPEG-2 video.
//
// In:  { type: "open", blob, wasmUrl, jsUrl } | { type: "decode", count } | { type: "seek", seconds } | { type: "close" }
// Out: { type: "info", width, height, fps, duration, sarNum, sarDen } | { type: "frame", … } | { type: "end" } | { type: "error", message }
declare const FileReaderSync: { new (): { readAsArrayBuffer(b: Blob): ArrayBuffer } };

interface Mod {
  HEAPU8: Uint8Array;
  HEAPF64: Float64Array;
  readAt: (pos: number, ptr: number, len: number) => number;
  _dec_open(size: number): number;
  _dec_info(): number;
  _dec_next(): number;
  _dec_seek(s: number): number;
  _dec_close(): void;
}

let mod: Mod | null = null;
let blob: Blob | null = null;
let seq = 0;
/** True until the first seek: the file is still at its start. */
let opened = false;
/** Presentation time of the first frame; frame times are sent relative to it. */
let pts0 = 0;
const reader = new FileReaderSync();
const post = (m: any, t: Transferable[] = []) => (self as any).postMessage(m, t);

/** The decoder's current frame, copied out as tightly packed planes (I420 or I422). */
function takeFrame(p: number, seq: number) {
  const m = mod!;
  const r = m.HEAPF64.subarray(p / 8, p / 8 + 16);
  const w = r[6], h = r[7], fmt = r[10];
  // AV_PIX_FMT_YUV420P = 0, YUV422P = 4, YUVJ420P = 12, YUVJ422P = 13
  const c422 = fmt === 4 || fmt === 13;
  const cw = Math.ceil(w / 2), ch = c422 ? h : Math.ceil(h / 2);
  const out = new Uint8Array(w * h + 2 * cw * ch);
  let o = 0;
  const plane = (ptr: number, stride: number, pw: number, ph: number) => {
    for (let y = 0; y < ph; y++) {
      out.set(m.HEAPU8.subarray(ptr + y * stride, ptr + y * stride + pw), o);
      o += pw;
    }
  };
  plane(r[0], r[3], w, h);
  plane(r[1], r[4], cw, ch);
  plane(r[2], r[5], cw, ch);
  post({ type: "frame", seq, width: w, height: h, format: c422 ? "I422" : "I420", fullRange: fmt === 12 || fmt === 13, pts: r[8] - pts0, key: r[9] === 1, interlaced: r[11] === 1, data: out.buffer }, [out.buffer]);
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === "open") {
      blob = msg.blob as Blob;
      const factory = (await import(/* @vite-ignore */ msg.jsUrl)).default;
      mod = (await factory({ locateFile: () => msg.wasmUrl })) as Mod;
      mod.readAt = (pos, ptr, len) => {
        const ab = reader.readAsArrayBuffer(blob!.slice(pos, Math.min(blob!.size, pos + len)));
        mod!.HEAPU8.set(new Uint8Array(ab), ptr);
        return ab.byteLength;
      };
      const r = mod._dec_open(blob.size);
      if (r < 0) throw new Error(`the stream could not be opened (FFmpeg error ${r})`);
      // The first frame's time is the origin. Decode it, then go back to the start.
      const p0 = mod._dec_next();
      pts0 = p0 ? mod.HEAPF64[p0 / 8 + 8] || 0 : 0;
      if (Number.isNaN(pts0)) pts0 = 0;
      mod._dec_seek(-1);
      opened = true;
      const i = mod.HEAPF64.subarray(mod._dec_info() / 8, mod._dec_info() / 8 + 8);
      post({ type: "info", width: i[0], height: i[1], fps: i[2], duration: i[3], sarNum: i[4] || 1, sarDen: i[5] || 1, mpeg: i[7] });
    } else if (msg.type === "decode") {
      for (let k = 0; k < msg.count; k++) {
        const p = mod!._dec_next();
        if (!p) {
          post({ type: "end", seq });
          return;
        }
        takeFrame(p, seq);
      }
    } else if (msg.type === "seek") {
      seq = msg.seq;
      const m = mod!;
      // The first request decodes from where the file opened; later ones seek to the key frame
      // before the target, or back to the first byte when that lands past the target.
      if (opened) {
        opened = false;
      } else {
        const r = m._dec_seek(Math.max(0, msg.seconds - 0.5));
        if (r < 0) m._dec_seek(-1);
      }
      let rewound = false;
      for (;;) {
        const p = m._dec_next();
        if (!p) {
          post({ type: "end", seq });
          return;
        }
        const pts = m.HEAPF64[p / 8 + 8] - pts0;
        if (pts > msg.seconds + msg.half && !rewound && msg.seconds < pts) {
          // Landed after the target: start over from the beginning.
          rewound = true;
          m._dec_seek(-1);
          continue;
        }
        if (Number.isNaN(pts) || pts + msg.half >= msg.seconds) {
          takeFrame(p, seq);
          return;
        }
      }
    } else if (msg.type === "close") {
      mod?._dec_close();
      self.close();
    }
  } catch (err) {
    post({ type: "error", message: (err as Error)?.message ?? String(err) });
  }
};
