// MPEG-2 video playback on a canvas (browser only). No browser plays MPEG-2, so the stream is
// decoded by FFmpeg compiled to WebAssembly (codecs/mpeg2-wasm, LGPL-2.1-or-later) in a worker
// that is created only when a study contains MPEG-2 video. Frames come back as YUV planes and are
// drawn through VideoFrame where the browser has it, else converted to RGB here.
//
//   const p = await Mpeg2Player.open(blob, canvas, { frames, frameSec });
//   p.play(); p.step(1); p.seekFrame(100); p.close();
import { assetUrl } from "./config";
import type { Playable } from "./video-view";

interface Frame {
  seq: number;
  width: number;
  height: number;
  format: "I420" | "I422";
  fullRange: boolean;
  pts: number;
  interlaced: boolean;
  data: ArrayBuffer;
}

export interface Mpeg2Info {
  width: number;
  height: number;
  fps: number;
  duration: number;
  sarNum: number;
  sarDen: number;
}

const AHEAD = 8;

export class Mpeg2Player implements Playable {
  playing = false;
  loop = false;
  onChange: (() => void) | null = null;
  frame = 0;
  /** Frame count: estimated at open, exact once the decoder has reached the end. */
  frames: number;
  readonly period: number;
  private lastIndex = -1;
  /** Frames drawn, and frames dropped to keep time (for checks). */
  readonly stats = { drawn: 0, late: 0, decoded: 0 };
  private queue: Frame[] = [];
  private requested = 0;
  private ended = false;
  private seq = 0;
  private raf = 0;
  private due = 0;
  private pendingSeek: ((f: Frame | null) => void) | null = null;
  private g: CanvasRenderingContext2D;
  private interlaced = false;

  private constructor(
    private worker: Worker,
    readonly info: Mpeg2Info,
    readonly canvas: HTMLCanvasElement,
    o: { frames: number; frameSec: number; useStreamDuration?: boolean },
  ) {
    const fps = info.fps > 0 ? info.fps : 1 / o.frameSec;
    this.period = 1 / fps;
    const fromStream = info.duration > 0 ? Math.max(1, Math.round(info.duration * fps)) : 0;
    this.frames = (o.useStreamDuration && fromStream) || (o.frames > 1 ? o.frames : fromStream || 1);
    canvas.width = info.width;
    canvas.height = info.height;
    this.g = canvas.getContext("2d")!;
    worker.onmessage = (e) => this.message(e.data);
  }

  /** Starts the decoder worker on a stream and shows its first frame. */
  static async open(blob: Blob, canvas: HTMLCanvasElement, o: { frames: number; frameSec: number; useStreamDuration?: boolean }): Promise<Mpeg2Player> {
    const worker = new Worker(assetUrl("video-mpeg2-worker.js"), { type: "module" });
    const info = await new Promise<Mpeg2Info>((resolve, reject) => {
      worker.onmessage = (e) => (e.data.type === "info" ? resolve(e.data) : e.data.type === "error" ? reject(new Error(e.data.message)) : 0);
      worker.onerror = (e) => reject(new Error(e.message || "the MPEG-2 decoder could not start"));
      worker.postMessage({ type: "open", blob, jsUrl: assetUrl("mpeg2dec.js"), wasmUrl: assetUrl("mpeg2dec.wasm") });
    });
    const p = new Mpeg2Player(worker, info, canvas, o);
    await p.seekTo(0);
    return p;
  }

  /** Whether the stream is interlaced (shown as decoded: both fields woven into each frame). */
  get isInterlaced() {
    return this.interlaced;
  }

  private message(m: any) {
    if (m.type === "frame") {
      if (m.seq !== this.seq) return;
      this.stats.decoded++;
      if (Number.isFinite(m.pts)) this.lastIndex = Math.max(this.lastIndex, Math.round(m.pts / this.period));
      this.requested = Math.max(0, this.requested - 1);
      if (this.pendingSeek) {
        const r = this.pendingSeek;
        this.pendingSeek = null;
        r(m);
        return;
      }
      this.queue.push(m);
    } else if (m.type === "end") {
      if (m.seq !== this.seq) return;
      this.ended = true;
      this.requested = 0;
      // The last frame decoded is the last frame there is.
      if (this.lastIndex >= 0 && this.lastIndex + 1 !== this.frames) {
        this.frames = this.lastIndex + 1;
        this.onChange?.();
      }
      if (this.pendingSeek) {
        const r = this.pendingSeek;
        this.pendingSeek = null;
        r(null);
      }
    } else if (m.type === "error") {
      console.error(`MPEG-2 decoder: ${m.message}`);
    }
  }

  private fill() {
    const want = AHEAD - this.queue.length - this.requested;
    if (want > 0 && !this.ended && !this.pendingSeek) {
      this.requested += want;
      this.worker.postMessage({ type: "decode", count: want });
    }
  }

  private indexOf(f: Frame) {
    return Number.isFinite(f.pts) ? Math.round(f.pts / this.period) : this.frame + 1;
  }

  private draw(f: Frame) {
    this.frame = Math.max(0, Math.min(this.frames - 1, this.indexOf(f)));
    this.interlaced ||= f.interlaced;
    const VF = (globalThis as any).VideoFrame;
    if (VF) {
      const vf = new VF(new Uint8Array(f.data), {
        format: f.format,
        codedWidth: f.width,
        codedHeight: f.height,
        timestamp: Math.round((Number.isFinite(f.pts) ? f.pts : 0) * 1e6),
        colorSpace: { matrix: f.height > 576 ? "bt709" : "smpte170m", primaries: f.height > 576 ? "bt709" : "smpte170m", transfer: f.height > 576 ? "bt709" : "smpte170m", fullRange: f.fullRange },
      });
      this.g.drawImage(vf, 0, 0, this.canvas.width, this.canvas.height);
      vf.close();
    } else this.drawRgb(f);
    this.stats.drawn++;
    this.onChange?.();
  }

  /** Fallback without VideoFrame: limited-range YCbCr to RGB (BT.601 for SD, BT.709 for HD). */
  private drawRgb(f: Frame) {
    const { width: w, height: h } = f;
    const y = new Uint8Array(f.data);
    const cw = Math.ceil(w / 2), ch = f.format === "I422" ? h : Math.ceil(h / 2);
    const u0 = w * h, v0 = u0 + cw * ch;
    const hd = h > 576;
    const [rv, gu, gv, bu] = hd ? [1.793, 0.213, 0.533, 2.112] : [1.596, 0.392, 0.813, 2.017];
    const img = this.g.createImageData(w, h);
    const d = img.data;
    for (let j = 0; j < h; j++) {
      const cj = f.format === "I422" ? j : j >> 1;
      for (let i = 0; i < w; i++) {
        const Y = 1.164 * (y[j * w + i] - 16);
        const ci = cj * cw + (i >> 1);
        const U = y[u0 + ci] - 128, V = y[v0 + ci] - 128;
        const o = (j * w + i) * 4;
        d[o] = Y + rv * V;
        d[o + 1] = Y - gu * U - gv * V;
        d[o + 2] = Y + bu * U;
        d[o + 3] = 255;
      }
    }
    this.g.putImageData(img, 0, 0);
  }

  /** Seeks to the frame covering `seconds` and draws it. */
  private seekTo(seconds: number): Promise<void> {
    this.seq++;
    this.queue = [];
    this.requested = 0;
    this.ended = false;
    return new Promise((resolve) => {
      this.pendingSeek = (f) => {
        if (f) this.draw(f);
        resolve();
        this.fill();
      };
      this.worker.postMessage({ type: "seek", seconds, half: this.period / 2, seq: this.seq });
    });
  }

  play() {
    if (this.playing) return;
    if (this.frame >= this.frames - 1) void this.seekTo(0);
    this.playing = true;
    this.due = performance.now() + this.period * 1000;
    this.fill();
    this.raf = requestAnimationFrame(this.tick);
    this.onChange?.();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.onChange?.();
  }

  step(d: number) {
    this.pause();
    if (d === 1 && this.queue.length) {
      this.draw(this.queue.shift()!);
      this.fill();
      return;
    }
    this.seekFrame(this.frame + d);
  }

  seekFrame(f: number) {
    const t = Math.max(0, Math.min(this.frames - 1, f));
    void this.seekTo(t * this.period);
  }

  private tick = (now: number) => {
    if (!this.playing) return;
    if (now >= this.due) {
      // Drop frames that are already late, keep the one that is due.
      let f = this.queue.shift();
      while (f && this.queue.length && now - this.due > this.period * 1000) {
        this.stats.late++;
        this.due += this.period * 1000;
        f = this.queue.shift();
      }
      if (f) {
        this.draw(f);
        this.due += this.period * 1000;
        if (now - this.due > 500) this.due = now;
      } else if (this.ended) {
        if (this.loop) void this.seekTo(0);
        else {
          this.pause();
          return;
        }
      }
      this.fill();
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  close() {
    this.pause();
    this.worker.postMessage({ type: "close" });
    setTimeout(() => this.worker.terminate(), 1000);
  }
}
