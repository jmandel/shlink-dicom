// Video and cine playback in the viewer (browser only).
//
//   const media = new MediaController({ stage, toolbar, share: () => share, cineFrame, cineCurrent });
//   media.select(series, retry)      // "shown" | "probing" | false: video series take over the stage
//   media.showingImage(series, inst, frames)   // after a multi-frame image is drawn: cine controls
//   media.leave()
//
// Video: H.264 and HEVC streams play in <video>. MP4 payloads are joined as they are; MPEG-2
// Transport Stream payloads are remuxed to fragmented MP4 (video-remux.ts), dropping audio that
// browsers don't play. MPEG-2 video is decoded by a separate, lazily loaded decoder (video-mpeg2.ts).
// Cine: multi-frame images play at their recorded timing (Frame Time Vector, Frame Time, …).
import type { SeriesEntry } from "./bundle";
import type { OpenShare } from "./share";
import { formatBytes } from "./format";
import { assetUrl } from "./config";
import ffmpegSource from "../../codecs/mpeg2-wasm/ffmpeg-source.json";
import { RemuxError, TsRemuxer } from "./video-remux";
import {
  cineTiming,
  DEFAULT_FPS,
  mayHoldMedia,
  mp4VideoTrack,
  probeInstance,
  sniffContainer,
  videoPayload,
  type CineTiming,
  type InstanceProbe,
  type MediaHeader,
  type VideoSyntax,
} from "./video";

export { mayHoldMedia };

// ------------------------------------------------------------------------------------- styles

const CSS = `
.media-stage { position: absolute; inset: 0; z-index: 4; background: #000; display: flex; align-items: center; justify-content: center; cursor: default; overflow: hidden; touch-action: none; }
.media-stage.hidden, .play-bar.hidden, .play-bar .hidden { display: none; }
.media-frame { position: relative; overflow: hidden; max-width: 100%; max-height: 100%; }
.media-frame video, .media-frame canvas { display: block; width: 100%; height: 100%; }
.media-frame.crop-sbs video { width: 200%; }
.media-frame.crop-tb video { height: 200%; }
.media-hud { position: absolute; top: 8px; left: calc(10px + var(--safe-l, 0px)); z-index: 2; pointer-events: none; white-space: pre-line;
  color: #e6e6e6; font: 12px/1.35 var(--mono, monospace); text-shadow: 0 0 3px #000, 0 0 2px #000; max-width: 60%; }
.play-bar .clip-label { font-size: 0.8125rem; color: var(--text-2); white-space: nowrap; }
.media-credit { position: absolute; right: calc(10px + var(--safe-r, 0px)); top: 8px; z-index: 2; font-size: 0.75rem; color: #ccc;
  padding: 2px 8px; border-radius: 999px; background: rgba(20,20,20,0.75); }
.media-credit a { color: #ddd; }
.media-credit:empty { display: none; }
.media-note { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); z-index: 2; max-width: calc(100% - 24px);
  padding: 4px 10px; border-radius: 999px; background: rgba(20,20,20,0.8); color: #eee; font-size: 0.8125rem; text-align: center; pointer-events: none; }
.media-note:empty { display: none; }
.media-status { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 3; max-width: min(90%, 380px);
  padding: 12px 16px; border-radius: var(--radius-sm, 8px); background: rgba(20,20,20,0.85); color: #fff; font-size: 0.9rem; text-align: center; }
.media-status:empty { display: none; }
.media-status .bar { margin-top: 8px; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.2); overflow: hidden; }
.media-status .bar > div { height: 100%; width: 0; background: #fff; }
body.media-mode .slice-ctl { display: none; }
body.media-mode #preset, body.media-mode #btn-reset { display: none; }
.play-bar { display: flex; align-items: center; gap: 6px; min-width: 0; }
body.media-mode .play-bar { flex: 1; }
.play-bar button { min-width: 40px; min-height: 40px; padding: 0 8px; display: inline-flex; align-items: center; justify-content: center; }
.play-bar button[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.play-bar svg { width: 18px; height: 18px; fill: currentColor; }
.play-bar input[type="range"] { flex: 1; min-width: 60px; accent-color: var(--accent); height: 32px; }
.play-bar .play-info { font-size: 0.8125rem; color: var(--text-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
@media (pointer: coarse) {
  .play-bar button { min-width: 44px; min-height: 44px; }
  .play-bar input[type="range"] { height: 44px; }
}
/* Cine on a narrow screen: the play bar gets its own row above the image tools. */
@media (max-width: 720px) {
  body.cine-on .toolbar { flex-wrap: wrap; row-gap: 6px; }
  body.cine-on .play-bar { flex: 1 1 100%; }
}
@media (max-width: 520px) {
  .play-bar .play-rate { display: none; }
  .play-bar .btn-step { min-width: 36px; padding: 0 4px; }
}
`;

let styled = false;
function injectStyles() {
  if (styled) return;
  styled = true;
  const s = document.createElement("style");
  s.textContent = CSS;
  document.head.append(s);
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2.5v14H6zM20 5v14L9.5 12z"/></svg>',
  fwd: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 5H18v14h-2.5zM4 5v14l10.5-7z"/></svg>',
  loop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zM17 17H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function iconButton(icon: keyof typeof ICONS, label: string, cls = ""): HTMLButtonElement {
  const b = el("button", `btn ${cls}`.trim());
  b.type = "button";
  b.innerHTML = ICONS[icon];
  b.setAttribute("aria-label", label);
  b.title = label;
  return b;
}

const fmtTime = (s: number) => {
  if (!Number.isFinite(s)) return "–";
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
};
const fmtRate = (fps: number) => `${fps >= 10 ? Math.round(fps) : fps.toFixed(1)} frames/s`;

// ------------------------------------------------------------------------------------- play bar

/** What the play bar drives: a <video>, an MPEG-2 canvas player, or the frames of an image. */
export interface Playable {
  readonly frames: number;
  readonly frame: number;
  readonly playing: boolean;
  loop: boolean;
  play(): void;
  pause(): void;
  step(d: number): void;
  seekFrame(f: number): void;
  /** Called on every frame change and play/pause. */
  onChange: (() => void) | null;
}

class PlayBar {
  readonly root = el("div", "play-bar");
  private btnPlay = iconButton("play", "Play");
  private btnBack = iconButton("back", "Previous frame", "btn-step");
  private btnFwd = iconButton("fwd", "Next frame", "btn-step");
  private btnLoop = iconButton("loop", "Loop");
  private scrub = el("input");
  private info = el("span", "play-info mono");
  private rate = el("span", "play-info play-rate");
  private clipPrev = el("button", "btn", "‹");
  private clipLabel = el("span", "clip-label");
  private clipNext = el("button", "btn", "›");
  private target: Playable | null = null;
  /** Clip navigation for a series of several videos. */
  onClip: ((d: number) => void) | null = null;

  constructor() {
    this.scrub.type = "range";
    this.scrub.min = "0";
    this.scrub.step = "1";
    this.scrub.setAttribute("aria-label", "Frame");
    this.root.append(this.btnPlay, this.btnBack, this.btnFwd, this.scrub, this.info, this.rate, this.btnLoop, this.clipPrev, this.clipLabel, this.clipNext);
    this.clipPrev.type = this.clipNext.type = "button";
    this.clipPrev.setAttribute("aria-label", "Previous video");
    this.clipNext.setAttribute("aria-label", "Next video");
    this.clipPrev.title = "Previous video";
    this.clipNext.title = "Next video";
    this.clipPrev.addEventListener("click", () => this.onClip?.(-1));
    this.clipNext.addEventListener("click", () => this.onClip?.(1));
    this.clips(0, 0);
    this.btnPlay.addEventListener("click", () => this.toggle());
    this.btnBack.addEventListener("click", () => this.target?.step(-1));
    this.btnFwd.addEventListener("click", () => this.target?.step(1));
    this.btnLoop.addEventListener("click", () => {
      if (!this.target) return;
      this.target.loop = !this.target.loop;
      this.render();
    });
    this.scrub.addEventListener("input", () => {
      this.target?.pause();
      this.target?.seekFrame(Number(this.scrub.value));
    });
  }

  /** Shows "Video i of n" with previous/next buttons when n > 1. */
  clips(i: number, n: number) {
    for (const e of [this.clipPrev, this.clipLabel, this.clipNext]) e.classList.toggle("hidden", n <= 1);
    this.clipLabel.textContent = `Video ${i + 1} of ${n}`;
    this.clipPrev.disabled = i <= 0;
    this.clipNext.disabled = i >= n - 1;
  }

  rateText() {
    return this.rate.textContent;
  }

  toggle() {
    const t = this.target;
    if (!t) return;
    if (t.playing) t.pause();
    else t.play();
  }

  attach(t: Playable | null, o: { scrubber: boolean; rate: string }) {
    if (this.target) this.target.onChange = null;
    this.target = t;
    this.root.classList.toggle("hidden", !t);
    this.scrub.classList.toggle("hidden", !o.scrubber);
    // Without its own scrubber the slice slider shows the frame number.
    this.info.classList.toggle("hidden", !o.scrubber);
    this.rate.textContent = o.rate ? `· ${o.rate}` : "";
    this.rate.title = o.rate;
    if (t) t.onChange = () => this.render();
    this.render();
  }

  render() {
    const t = this.target;
    if (!t) return;
    this.btnPlay.innerHTML = t.playing ? ICONS.pause : ICONS.play;
    this.btnPlay.setAttribute("aria-label", t.playing ? "Pause" : "Play");
    this.btnPlay.title = t.playing ? "Pause" : "Play";
    this.btnLoop.setAttribute("aria-pressed", String(t.loop));
    this.scrub.max = String(Math.max(0, t.frames - 1));
    if (document.activeElement !== this.scrub || t.playing) this.scrub.value = String(t.frame);
    this.info.textContent = `${t.frame + 1} / ${t.frames}`;
  }
}

// ------------------------------------------------------------------------------------- cine

/** Plays the frames of a multi-frame image through a callback, at the file's own timing. */
class CinePlayer implements Playable {
  playing = false;
  loop = true;
  onChange: (() => void) | null = null;
  private raf = 0;
  private due = 0;
  private dir = 1;
  /** Frames shown while playing, with times (the last 600), for checks. */
  readonly log: { f: number; t: number }[] = [];

  constructor(
    readonly timing: CineTiming,
    readonly frames: number,
    private show: (f: number) => void,
    private current: () => number,
  ) {}

  get frame() {
    return this.current();
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    if (!this.loop && this.frame >= this.timing.last) this.show(this.timing.first);
    this.due = performance.now() + this.timing.durations[this.frame];
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
    this.seekFrame(Math.max(0, Math.min(this.frames - 1, this.frame + d)));
  }

  seekFrame(f: number) {
    this.show(f);
    this.onChange?.();
  }

  private tick = (now: number) => {
    if (!this.playing) return;
    const { first, last, durations, sweep } = this.timing;
    let f = this.frame;
    let steps = 0;
    // Advance as many frames as are due; skip frames rather than fall behind.
    while (now >= this.due && steps < this.frames) {
      let n = f + this.dir;
      if (n > last || n < first) {
        if (!this.loop) {
          this.pause();
          return;
        }
        if (sweep) {
          this.dir = -this.dir;
          n = f + this.dir;
        } else n = this.dir > 0 ? first : last;
      }
      f = Math.max(first, Math.min(last, n));
      this.due += durations[f] ?? 1000 / DEFAULT_FPS;
      steps++;
    }
    if (now - this.due > 1000) this.due = now; // after a stall, don't race to catch up
    if (steps) {
      this.show(f);
      if (this.log.length >= 600) this.log.shift();
      this.log.push({ f, t: now });
      this.onChange?.();
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  dispose() {
    this.pause();
  }
}

// ------------------------------------------------------------------------------------- <video>

/** A <video> element driven by the play bar, with frame stepping at the file's frame time. */
class VideoPlayable implements Playable {
  onChange: (() => void) | null = null;
  readonly frames: number;
  /** Seconds per frame: the duration over Number of Frames, else the file's Frame Time. */
  readonly period: number;
  constructor(
    readonly video: HTMLVideoElement,
    frameSec: number,
    headerFrames: number,
  ) {
    const d = video.duration;
    this.frames = headerFrames > 1 ? headerFrames : Number.isFinite(d) && d > 0 ? Math.max(1, Math.round(d / frameSec)) : 1;
    this.period = Number.isFinite(d) && d > 0 ? d / this.frames : frameSec;
    for (const ev of ["play", "pause", "timeupdate", "seeked", "ended", "durationchange"]) video.addEventListener(ev, () => this.onChange?.());
    // Smooth frame counter while playing.
    const vfc = (video as any).requestVideoFrameCallback?.bind(video);
    if (vfc) {
      const cb = () => {
        this.onChange?.();
        vfc(cb);
      };
      vfc(cb);
    }
  }
  get frame() {
    return Math.max(0, Math.min(this.frames - 1, Math.floor(this.video.currentTime / this.period + 1e-3)));
  }
  get playing() {
    return !this.video.paused && !this.video.ended;
  }
  get loop() {
    return this.video.loop;
  }
  set loop(v: boolean) {
    this.video.loop = v;
  }
  play() {
    if (this.video.ended) this.video.currentTime = 0;
    this.video.play().catch(() => {});
  }
  pause() {
    this.video.pause();
  }
  step(d: number) {
    this.pause();
    this.seekFrame(Math.max(0, Math.min(this.frames - 1, this.frame + d)));
  }
  seekFrame(f: number) {
    // The middle of the frame's interval, so rounding never lands on its neighbour.
    this.video.currentTime = Math.min(this.video.duration || 0, (f + 0.5) * this.period);
  }
}

// ------------------------------------------------------------------------------------- controller

export interface MediaControllerOptions {
  stage: HTMLElement;
  toolbar: HTMLElement;
  share: () => OpenShare | null;
  /** Shows frame f of the image on screen (cine). */
  cineFrame: (f: number) => void;
  /** The frame of the image on screen. */
  cineCurrent: () => number;
}

export type MediaState = "shown" | "probing" | false;

interface Clip {
  series: SeriesEntry;
  inst: number;
  url: string | null;
  abort: AbortController;
}

/** HEVC support needs a platform decoder; check before downloading. */
export function canPlayCodec(codec: string): boolean {
  const t = `video/mp4; codecs="${codec}"`;
  const ms = (globalThis as any).MediaSource;
  if (ms?.isTypeSupported?.(t)) return true;
  return document.createElement("video").canPlayType(t) !== "";
}

const HEVC_PROBE: Record<string, string> = {
  "1.2.840.10008.1.2.4.107": "hvc1.1.6.L153.B0",
  "1.2.840.10008.1.2.4.108": "hvc1.2.4.L153.B0",
};

export class MediaController {
  private probes = new Map<string, Promise<InstanceProbe>>();
  private known = new Map<string, InstanceProbe>();
  private box = el("div", "media-stage hidden");
  private frame = el("div", "media-frame");
  private status = el("div", "media-status");
  private note = el("div", "media-note");
  private hud = el("div", "media-hud");
  private credit = el("div", "media-credit");
  private bar = new PlayBar();
  private clip: Clip | null = null;
  private cine: CinePlayer | null = null;
  private cineKey = "";
  private current: SeriesEntry | null = null;
  /** For scripted checks. */
  readonly metrics = { opened: 0, lastOpenMs: 0, bytes: 0, container: "", codec: "", frames: 0, duration: 0, dropped: [] as string[], note: "", error: "" };

  constructor(private o: MediaControllerOptions) {
    injectStyles();
    this.box.tabIndex = -1;
    this.box.append(this.frame, this.hud, this.credit, this.status, this.note);
    this.bar.onClip = (d) => {
      const c = this.clip;
      if (!c) return;
      const n = c.series.instances.length;
      const i = Math.max(0, Math.min(n - 1, c.inst + d));
      if (i === c.inst) return;
      this.closeClip();
      void this.openClip(c.series, i);
    };
    o.stage.append(this.box);
    this.bar.root.classList.add("hidden");
    o.toolbar.insertBefore(this.bar.root, o.toolbar.firstChild);
    // The stage's slice and window gestures must not see the player's input.
    for (const ev of ["pointerdown", "pointermove", "pointerup", "wheel", "dblclick", "contextmenu"]) this.box.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    this.wireZoom();
    this.box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      this.key(e);
    });
    this.bar.root.addEventListener("keydown", (e) => e.stopPropagation());
    // Using the slice slider pauses cine.
    o.toolbar.querySelector("#slice")?.addEventListener("input", () => this.cine?.pause());
    (globalThis as any).__video = this.hooks();
  }

  /** Zoom and pan of the picture (CSS transform of the frame): 1, 0, 0 is the fitted picture. */
  private view = { z: 1, x: 0, y: 0 };

  private applyView() {
    const v = this.view;
    this.frame.style.transform = v.z === 1 && !v.x && !v.y ? "" : `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
    this.frame.dataset.zoom = String(v.z);
  }

  /** Zoom by k about client point (px, py), keeping that point under the pointer. */
  private zoomAt(k: number, px: number, py: number) {
    const r = this.box.getBoundingClientRect();
    const cx = px - r.left - r.width / 2, cy = py - r.top - r.height / 2;
    const z1 = Math.max(1, Math.min(8, this.view.z * k));
    const kk = z1 / this.view.z;
    this.view = { z: z1, x: cx - (cx - this.view.x) * kk, y: cy - (cy - this.view.y) * kk };
    if (z1 === 1) this.view = { z: 1, x: 0, y: 0 };
    this.applyView();
  }

  /**
   * The viewer's geometry gestures on the picture (there is no window/level for video): drag or
   * middle-drag pans, right-drag and Ctrl/Cmd+wheel (or a trackpad pinch) zoom, pinch zooms and
   * two fingers pan, one finger pans when zoomed in, double-click or double-tap goes back to fit.
   */
  private wireZoom() {
    const box = this.box;
    const pts = new Map<number, { x: number; y: number; x0: number; y0: number; button: number }>();
    let two: { d0: number; z0: number; mx: number; my: number; vx: number; vy: number } | null = null;
    let lastTap = 0;
    this.frame.style.transformOrigin = "50% 50%";
    box.addEventListener("pointerdown", (e) => {
      if ((e.target as Element).closest?.("a, button")) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, button: e.pointerType === "mouse" ? e.button : 0 });
      box.setPointerCapture?.(e.pointerId);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        two = { d0: Math.hypot(b.x - a.x, b.y - a.y), z0: this.view.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, vx: this.view.x, vy: this.view.y };
      }
      if (e.pointerType !== "mouse" && pts.size === 1) {
        const now = performance.now();
        if (now - lastTap < 300) {
          this.view = { z: 1, x: 0, y: 0 };
          this.applyView();
          lastTap = 0;
        } else lastTap = now;
      }
    });
    box.addEventListener("pointermove", (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pts.size === 2 && two) {
        const [a, b] = [...pts.values()];
        const r = box.getBoundingClientRect();
        const z1 = Math.max(1, Math.min(8, two.d0 > 10 ? two.z0 * (Math.hypot(b.x - a.x, b.y - a.y) / two.d0) : two.z0));
        const cx = two.mx - r.left - r.width / 2, cy = two.my - r.top - r.height / 2;
        const kk = z1 / two.z0;
        this.view = { z: z1, x: cx - (cx - two.vx) * kk + ((a.x + b.x) / 2 - two.mx), y: cy - (cy - two.vy) * kk + ((a.y + b.y) / 2 - two.my) };
        this.applyView();
      } else if (pts.size === 1 && p.button === 2) this.zoomAt(Math.exp(-dy * 0.01), p.x0, p.y0);
      else if (pts.size === 1 && this.view.z > 1) {
        this.view.x += dx;
        this.view.y += dy;
        this.applyView();
      }
    });
    const end = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) two = null;
    };
    box.addEventListener("pointerup", end);
    box.addEventListener("pointercancel", end);
    box.addEventListener("contextmenu", (e) => e.preventDefault());
    box.addEventListener("dblclick", () => {
      this.view = { z: 1, x: 0, y: 0 };
      this.applyView();
    });
    box.addEventListener(
      "wheel",
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        this.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      },
      { passive: false },
    );
  }

  /** Whether a video stage is up. */
  get active() {
    return !this.box.classList.contains("hidden");
  }

  /** The probe for instance i, read once. */
  probe(series: SeriesEntry, i = 0): Promise<InstanceProbe> {
    const key = `${series.id}/${i}`;
    let p = this.probes.get(key);
    if (!p) {
      const share = this.o.share();
      if (!share) return Promise.reject(new Error("no share"));
      p = probeInstance(share, series, i).then((r) => {
        this.known.set(key, r);
        return r;
      });
      p.catch(() => this.probes.delete(key));
      this.probes.set(key, p);
    }
    return p;
  }

  /**
   * Thumbnail of a series that may hold video: a video gets a drawn placeholder (decoding a frame
   * would mean downloading the stream). Resolves false for an image, which the caller draws.
   */
  async drawThumb(canvas: HTMLCanvasElement, series: SeriesEntry, current = () => true): Promise<boolean> {
    const p = await this.probe(series, 0).catch(() => null);
    if (!p?.video) return false;
    if (!current()) return true;
    const g = canvas.getContext("2d")!;
    const w = canvas.width, h = canvas.height;
    g.fillStyle = "#1b1d22";
    g.fillRect(0, 0, w, h);
    const r = Math.min(w, h) * 0.22;
    g.fillStyle = "rgba(255,255,255,0.9)";
    g.beginPath();
    g.arc(w / 2, h * 0.44, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#1b1d22";
    g.beginPath();
    g.moveTo(w / 2 - r * 0.35, h * 0.44 - r * 0.5);
    g.lineTo(w / 2 + r * 0.55, h * 0.44);
    g.lineTo(w / 2 - r * 0.35, h * 0.44 + r * 0.5);
    g.closePath();
    g.fill();
    g.fillStyle = "rgba(255,255,255,0.8)";
    g.font = `${Math.round(h * 0.11)}px system-ui, sans-serif`;
    g.textAlign = "center";
    g.fillText(p.video.codec === "mpeg2" ? "MPEG-2" : p.video.codec === "hevc" ? "HEVC" : "H.264", w / 2, h * 0.86);
    return true;
  }

  /** Known to be video (probed). */
  isVideo(series: SeriesEntry): boolean {
    return !!this.known.get(`${series.id}/0`)?.video;
  }

  /**
   * Called when the viewer opens a series. A video series is shown here ("shown"); a series that
   * may hold video is probed first ("probing": `retry` runs when the probe is done); anything
   * else returns false and the image viewer shows it.
   */
  select(series: SeriesEntry, retry: () => void): MediaState {
    this.current = series;
    if (!mayHoldMedia(series)) {
      this.leave();
      return false;
    }
    const key = `${series.id}/0`;
    const p = this.known.get(key);
    if (!p) {
      this.leave();
      this.showBox();
      this.setStatus("Opening…");
      this.probe(series, 0).then(
        () => this.current === series && retry(),
        (e) => {
          // A probe failure leaves the series to the image viewer, which reports its own errors.
          this.known.set(key, { header: null as unknown as MediaHeader, video: null });
          if (this.current === series) retry();
          void e;
        },
      );
      return "probing";
    }
    if (!p.video) {
      this.leave();
      return false;
    }
    if (this.clip?.series === series) return "shown";
    this.leave();
    this.showBox();
    void this.openClip(series, 0);
    return "shown";
  }

  /**
   * Called after the image viewer draws instance `inst` of a series: multi-frame images get cine
   * controls (play at the recorded timing, step, loop).
   */
  showingImage(series: SeriesEntry, inst: number, frames: number) {
    if (this.active) return;
    if (frames <= 1) {
      this.stopCine();
      return;
    }
    const key = `${series.id}/${inst}`;
    if (this.cine && this.cineKey === key) return;
    this.stopCine();
    this.cineKey = key;
    const start = (timing: CineTiming) => {
      if (this.cineKey !== key || this.current !== series) return;
      this.cine = new CinePlayer(timing, frames, this.o.cineFrame, this.o.cineCurrent);
      const fps = 1000 / (timing.durations.reduce((a, b) => a + b, 0) / timing.durations.length);
      const varies = timing.durations.some((d) => Math.abs(d - timing.durations[0]) > 0.5);
      const rate = !timing.source ? `${fmtRate(DEFAULT_FPS)} (no timing in file)` : varies ? `about ${fmtRate(fps)} (varies)` : fmtRate(fps);
      // One multi-frame instance: the slice slider already moves through its frames.
      this.bar.attach(this.cine, { scrubber: series.instances.length > 1, rate });
      document.body.classList.add("cine-on");
      this.bar.root.title = timing.source ? `Timing from ${timing.source}` : "The file records no frame timing";
    };
    const fallback = () => start({ durations: new Array(frames).fill(1000 / DEFAULT_FPS), source: null, first: 0, last: frames - 1, sweep: false });
    if (!mayHoldMedia(series)) {
      fallback();
      return;
    }
    this.probe(series, inst).then((p) => (p.header ? start(cineTiming(p.header, frames)) : fallback()), fallback);
  }

  private stopCine() {
    this.cine?.dispose();
    this.cine = null;
    document.body.classList.remove("cine-on");
    this.cineKey = "";
    if (!this.active) this.bar.attach(null, { scrubber: false, rate: "" });
  }

  /** Leaves video mode (another series, the overview). */
  leave() {
    this.stopCine();
    this.closeClip();
    this.box.classList.add("hidden");
    document.body.classList.remove("media-mode");
  }

  /** Stops and removes the clip on screen. */
  private closeClip() {
    this.view = { z: 1, x: 0, y: 0 };
    this.applyView();
    if (this.clip) {
      this.clip.abort.abort();
      if (this.clip.url) URL.revokeObjectURL(this.clip.url);
      this.clip = null;
    }
    this.mpeg2?.close();
    this.mpeg2 = null;
    this.playable = null;
    this.resize?.disconnect();
    this.frame.textContent = "";
    this.frame.className = "media-frame";
    this.frame.style.width = this.frame.style.height = "";
    this.note.textContent = "";
    this.hud.textContent = "";
    this.credit.textContent = "";
    this.setStatus("");
    this.bar.attach(null, { scrubber: true, rate: "" });
    this.bar.clips(0, 0);
  }

  private showBox() {
    this.box.classList.remove("hidden");
    document.body.classList.add("media-mode");
    this.o.stage.querySelector<HTMLElement>("#stage-msg")?.classList.add("hidden");
    this.o.stage.querySelector<HTMLElement>("#stage-busy")?.classList.add("hidden");
  }

  private setStatus(text: string, progress?: number) {
    this.status.textContent = text;
    if (progress !== undefined) {
      const bar = el("div", "bar");
      const fill = el("div");
      fill.style.width = `${Math.round(progress * 100)}%`;
      bar.append(fill);
      this.status.append(bar);
    }
  }

  private key(e: KeyboardEvent) {
    const t = this.playable;
    if (!t) return;
    if (e.key === " " || e.key === "k") this.bar.toggle();
    else if (e.key === "ArrowRight" || e.key === ".") t.step(1);
    else if (e.key === "ArrowLeft" || e.key === ",") t.step(-1);
    else if (e.key === "Home") t.seekFrame(0);
    else if (e.key === "End") t.seekFrame(t.frames - 1);
    else return;
    e.preventDefault();
  }

  private playable: Playable | null = null;
  private mpeg2: { close(): void } | null = null;
  /** MPEG-2 player stats, for checks. */
  mpeg2Stats() {
    return (this.mpeg2 as any)?.stats ?? null;
  }

  /** Loads and shows clip `inst` of a video series. */
  private async openClip(series: SeriesEntry, inst: number) {
    const share = this.o.share();
    if (!share) return;
    const t0 = performance.now();
    const abort = new AbortController();
    const clip: Clip = { series, inst, url: null, abort };
    this.clip = clip;
    this.metrics.error = "";
    const fail = (msg: string) => {
      if (this.clip !== clip) return;
      this.metrics.error = msg;
      this.setStatus(msg);
    };
    try {
      const probe = await this.probe(series, inst);
      const vs = probe.video;
      if (!vs) return fail("This instance is not video.");
      const h = probe.header;
      const frameSec = h.frameTime && h.frameTime > 0 ? h.frameTime / 1000 : h.cineRate ? 1 / h.cineRate : 1 / 30;
      const total = series.instances[inst].length;
      this.note.textContent = viewNote(vs, null);
      const n = series.instances.length;
      this.hud.textContent = `${series.description ?? vs.label}\n${vs.label} · ${h.columns}×${h.rows}${n > 1 ? ` · video ${inst + 1} of ${n}` : ""}`;
      if (vs.codec === "hevc" && HEVC_PROBE[h.transferSyntax] && !canPlayCodec(HEVC_PROBE[h.transferSyntax])) {
        return fail(`This series is ${vs.label}. This browser can't play HEVC. Download the original to play it in another player.`);
      }
      this.setStatus(`Loading video · 0 of ${formatBytes(total)}`, 0);
      let container = "";
      let remux: TsRemuxer | null = null;
      let blob = new Blob([]);
      let pending: BlobPart[] = [];
      let pendingBytes = 0;
      const add = (parts: Uint8Array[]) => {
        for (const p of parts) {
          pending.push(p as BlobPart);
          pendingBytes += p.length;
        }
        // Fold into the Blob every 16 MiB, so the browser can move it out of the JS heap.
        if (pendingBytes > 16 * 1024 * 1024) {
          blob = new Blob([blob, ...pending]);
          pending = [];
          pendingBytes = 0;
        }
      };
      for await (const piece of videoPayload(share, series, inst, h, {
        signal: abort.signal,
        onProgress: (p) => this.clip === clip && this.setStatus(`Loading video · ${formatBytes(p.read)} of ${formatBytes(p.total)}`, p.read / p.total),
      })) {
        if (this.clip !== clip) return;
        if (!container) {
          container = sniffContainer(piece);
          if (vs.codec === "mpeg2") {
            if (container === "mp4" || container === "unknown") return fail(`This ${vs.label} is in a container the viewer can't open (${container}).`);
          } else if (container === "ts") remux = new TsRemuxer({ frameDuration90k: frameSec * 90000 });
          else if (container !== "mp4") return fail(`This ${vs.label} is in a container browsers can't open (${container}).`);
        }
        if (remux) {
          remux.push(piece);
          add(remux.drain());
        } else add([piece]);
      }
      let init: Uint8Array | null = null;
      let codec = vs.codec === "h264" ? "avc1" : "hvc1";
      if (remux) {
        const r = remux.finish();
        init = r.init;
        add(r.fragments);
        codec = r.params.codecString;
        this.metrics.dropped = r.dropped;
        this.metrics.frames = r.frames;
        this.note.textContent = viewNote(vs, r.framePacking, r.dropped);
        if (r.framePacking === 3) this.frame.classList.add("crop-sbs");
        if (r.framePacking === 4) this.frame.classList.add("crop-tb");
        if (vs.codec === "hevc" && !canPlayCodec(codec)) return fail(`This series is ${vs.label} (${codec}). This browser can't play it. Download the original to play it in another player.`);
      }
      const file = new Blob(init ? [init as BlobPart, blob, ...pending] : [blob, ...pending], { type: vs.codec === "mpeg2" ? "video/mpeg" : "video/mp4" });
      this.metrics.bytes = file.size;
      this.metrics.container = container;
      this.metrics.codec = vs.codec === "mpeg2" ? "mpeg2" : codec;
      if (vs.codec === "mpeg2") {
        await this.openMpeg2(file, h, clip, frameSec, t0, container);
        return;
      }
      // Frames as the stream has them (the header's Number of Frames can disagree).
      let streamFrames = this.metrics.frames;
      if (!remux) {
        const t = await mp4VideoTrack(file).catch(() => null);
        streamFrames = t?.frames ?? 0;
        this.metrics.frames = streamFrames;
      }
      clip.url = URL.createObjectURL(file);
      const video = el("video");
      video.playsInline = true;
      video.preload = "auto";
      video.src = clip.url;
      video.setAttribute("aria-label", vs.label);
      await new Promise<void>((resolve, reject) => {
        video.addEventListener("loadeddata", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(new Error(video.error?.message || `media error ${video.error?.code}`)), { once: true });
      });
      if (this.clip !== clip) return;
      this.metrics.duration = video.duration;
      this.metrics.opened++;
      this.metrics.lastOpenMs = Math.round(performance.now() - t0);
      this.setStatus("");
      this.fitFrame(video.videoWidth, video.videoHeight);
      this.frame.textContent = "";
      this.frame.append(video);
      const pl = new VideoPlayable(video, frameSec, streamFrames || h.frames);
      this.playable = pl;
      this.bar.attach(pl, { scrubber: true, rate: fmtRate(1 / pl.period) });
      this.bar.clips(inst, series.instances.length);
      this.box.focus({ preventScroll: true });
    } catch (e) {
      if ((e as any)?.name === "AbortError" || this.clip !== clip) return;
      const msg = e instanceof RemuxError ? `This video can't be read: ${e.message}.` : `This video can't be played: ${(e as Error)?.message ?? e}`;
      fail(msg);
    }
  }

  /** Sizes the frame box to the video's aspect (one view of a packed 3D frame). */
  private fitFrame(w: number, h: number) {
    if (this.frame.classList.contains("crop-sbs")) w /= 2;
    if (this.frame.classList.contains("crop-tb")) h /= 2;
    const fit = () => {
      const r = this.box.getBoundingClientRect();
      const k = Math.min(r.width / w, r.height / h);
      this.frame.style.width = `${Math.floor(w * k)}px`;
      this.frame.style.height = `${Math.floor(h * k)}px`;
    };
    fit();
    this.resize?.disconnect();
    this.resize = new ResizeObserver(fit);
    this.resize.observe(this.box);
  }
  private resize: ResizeObserver | null = null;

  /** MPEG-2: decoded by a WebAssembly build of FFmpeg, loaded only now (video-mpeg2.ts). */
  private async openMpeg2(file: Blob, h: MediaHeader, clip: Clip, frameSec: number, t0: number, container: string) {
    this.setStatus("Starting the MPEG-2 decoder…");
    const { Mpeg2Player } = await import("./video-mpeg2");
    if (this.clip !== clip) return;
    const canvas = el("canvas");
    // Program and Transport Streams carry timestamps, so their duration gives the frame count; a raw
    // stream's duration is only estimated from its bit rate, so the header's count is used.
    const pl = await Mpeg2Player.open(file, canvas, { frames: h.frames, frameSec, useStreamDuration: container === "ts" || container === "mpeg-ps" });
    if (this.clip !== clip) {
      pl.close();
      return;
    }
    this.mpeg2 = pl;
    this.metrics.duration = pl.frames * pl.period;
    this.metrics.frames = pl.frames;
    this.metrics.opened++;
    this.metrics.lastOpenMs = Math.round(performance.now() - t0);
    this.setStatus("");
    this.fitFrame(pl.info.width * (pl.info.sarNum / pl.info.sarDen), pl.info.height);
    this.frame.textContent = "";
    this.frame.append(canvas);
    this.playable = pl;
    this.bar.attach(pl, { scrubber: true, rate: fmtRate(1 / pl.period) });
    this.bar.clips(clip.inst, clip.series.instances.length);
    // FFmpeg is LGPL: say so, with its licence and the source it was built from.
    const link = (text: string, href: string) => {
      const a = el("a", undefined, text);
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      return a;
    };
    this.credit.append("Decoded with FFmpeg (", link("LGPL", assetUrl("ffmpeg-COPYING.LGPLv2.1.txt")), ") · ", link("source", assetUrl(`ffmpeg-${ffmpegSource.version}.tar.xz`)));
    if (pl.isInterlaced) this.note.textContent = [this.note.textContent, "Interlaced video, shown without deinterlacing."].filter(Boolean).join(" ");
    this.box.focus({ preventScroll: true });
  }

  private hooks() {
    return {
      active: () => this.active,
      metrics: () => this.metrics,
      mpeg2: () => this.mpeg2Stats(),
      note: () => this.note.textContent,
      status: () => this.status.textContent,
      state: () => {
        const t = this.playable && this.active ? this.playable : this.cine;
        return t ? { frames: t.frames, frame: t.frame, playing: t.playing, loop: t.loop, kind: t === this.cine ? "cine" : "video" } : null;
      },
      cine: () => (this.cine ? { timing: this.cine.timing, frames: this.cine.frames, rate: this.bar.rateText() } : null),
      cineLog: () => this.cine?.log.slice() ?? [],
      play: () => (this.active ? this.playable : this.cine)?.play(),
      pause: () => (this.active ? this.playable : this.cine)?.pause(),
      step: (d: number) => (this.active ? this.playable : this.cine)?.step(d),
      seekFrame: (f: number) => (this.active ? this.playable : this.cine)?.seekFrame(f),
      /** The <video>'s current frame as RGBA (base64), at its decoded size. */
      grab: () => {
        const v = this.frame.querySelector("video");
        const cv = this.frame.querySelector("canvas");
        if (!v && !cv) return null;
        const c = document.createElement("canvas");
        c.width = v ? v.videoWidth : cv!.width;
        c.height = v ? v.videoHeight : cv!.height;
        const g = c.getContext("2d", { willReadFrequently: true })!;
        g.drawImage(v ?? cv!, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let bin = "";
        for (let i = 0; i < d.length; i += 0x8000) bin += String.fromCharCode(...d.subarray(i, i + 0x8000));
        return { width: c.width, height: c.height, currentTime: v ? v.currentTime : (this.playable?.frame ?? 0) * ((this.playable as any)?.period ?? 0), b64: btoa(bin) };
      },
    };
  }
}

/** The line under the picture for stereo and 3D syntaxes, and for audio that was left out. */
function viewNote(vs: VideoSyntax, framePacking: number | null, dropped: string[] = []): string {
  const bits: string[] = [];
  if (vs.view === "stereo") bits.push("Stereo video: one of its two views is shown.");
  if (vs.view === "3d") bits.push(framePacking === 3 || framePacking === 4 ? "3D video: one of its two views is shown." : "3D video, shown as recorded.");
  const audio = dropped.filter((d) => /audio/.test(d));
  if (audio.length) bits.push(`Plays without sound: browsers can't play its ${audio.join(" or ")}.`);
  return bits.join(" ");
}
