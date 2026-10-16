// Video and cine in a shared study: which instances hold video, how they are timed, and their
// encapsulated stream read through byte ranges of its encrypted file.
//
//   const probe = await probeInstance(share, series, 0);       // reads the header only (64 KiB+)
//   probe.video   // { codec: "h264" | "hevc" | "mpeg2", label, view, … } or null
//   cineTiming(probe.header)                                    // frame durations for multi-frame images
//   for await (const piece of videoPayload(share, series, 0, probe.header)) …  // the stream, in order
//
// Reads go through the link's resolver and the share's decryptor, a few MiB at a time, so a video
// of any size streams without holding its encrypted copy.
import type { SeriesEntry } from "./bundle";
import { planBytes, RECORD_PLAINTEXT } from "./range";
import { RecordAuthenticationError } from "./decrypt";
import type { OpenShare } from "./share";
import { DicomParseError, parseDicomSync, T, tag } from "./dicom";

// ------------------------------------------------------------------------------------- syntaxes

export type VideoCodec = "h264" | "hevc" | "mpeg2";

export interface VideoSyntax {
  codec: VideoCodec;
  /** Plain name, e.g. "H.264 video". */
  label: string;
  /** How a stereo or 3D syntax is shown. */
  view: "2d" | "3d" | "stereo";
}

const VS = (codec: VideoCodec, label: string, view: VideoSyntax["view"] = "2d"): VideoSyntax => ({ codec, label, view });

/** Video transfer syntaxes (PS3.5 §8.2.5–8.2.11, §10.x), including the fragmentable .x.1 forms. */
export const VIDEO_SYNTAXES: Record<string, VideoSyntax> = {
  "1.2.840.10008.1.2.4.100": VS("mpeg2", "MPEG-2 video"),
  "1.2.840.10008.1.2.4.100.1": VS("mpeg2", "MPEG-2 video"),
  "1.2.840.10008.1.2.4.101": VS("mpeg2", "MPEG-2 HD video"),
  "1.2.840.10008.1.2.4.101.1": VS("mpeg2", "MPEG-2 HD video"),
  "1.2.840.10008.1.2.4.102": VS("h264", "H.264 video"),
  "1.2.840.10008.1.2.4.102.1": VS("h264", "H.264 video"),
  "1.2.840.10008.1.2.4.103": VS("h264", "H.264 video"),
  "1.2.840.10008.1.2.4.103.1": VS("h264", "H.264 video"),
  "1.2.840.10008.1.2.4.104": VS("h264", "H.264 video"),
  "1.2.840.10008.1.2.4.104.1": VS("h264", "H.264 video"),
  "1.2.840.10008.1.2.4.105": VS("h264", "H.264 3D video", "3d"),
  "1.2.840.10008.1.2.4.105.1": VS("h264", "H.264 3D video", "3d"),
  "1.2.840.10008.1.2.4.106": VS("h264", "H.264 stereo video", "stereo"),
  "1.2.840.10008.1.2.4.106.1": VS("h264", "H.264 stereo video", "stereo"),
  "1.2.840.10008.1.2.4.107": VS("hevc", "HEVC (H.265) video"),
  "1.2.840.10008.1.2.4.108": VS("hevc", "HEVC (H.265) Main 10 video"),
};

/**
 * SOP classes whose instances can be video or multi-frame cine: the video IODs, ultrasound,
 * X-ray angiography and fluoroscopy, multi-frame secondary capture, ophthalmic photography.
 * Only these are probed; other series go straight to the image viewer.
 */
const MEDIA_CLASSES = new Set([
  "1.2.840.10008.5.1.4.1.1.77.1.1.1", // Video Endoscopic
  "1.2.840.10008.5.1.4.1.1.77.1.2.1", // Video Microscopic
  "1.2.840.10008.5.1.4.1.1.77.1.4.1", // Video Photographic
  "1.2.840.10008.5.1.4.1.1.3.1", // US Multi-frame
  "1.2.840.10008.5.1.4.1.1.6.2", // Enhanced US Volume
  "1.2.840.10008.5.1.4.1.1.12.1", // X-Ray Angiographic
  "1.2.840.10008.5.1.4.1.1.12.1.1", // Enhanced XA
  "1.2.840.10008.5.1.4.1.1.12.2", // X-Ray Radiofluoroscopic
  "1.2.840.10008.5.1.4.1.1.12.2.1", // Enhanced XRF
  "1.2.840.10008.5.1.4.1.1.7.1", // Multi-frame Single Bit SC
  "1.2.840.10008.5.1.4.1.1.7.2", // Multi-frame Grayscale Byte SC
  "1.2.840.10008.5.1.4.1.1.7.3", // Multi-frame Grayscale Word SC
  "1.2.840.10008.5.1.4.1.1.7.4", // Multi-frame True Color SC
  "1.2.840.10008.5.1.4.1.1.77.1.5.1", // Ophthalmic Photography 8 Bit
  "1.2.840.10008.5.1.4.1.1.77.1.5.2", // Ophthalmic Photography 16 Bit
]);

/** Whether a series may hold video or cine (decided from its SOP classes, without reading). */
export function mayHoldMedia(series: SeriesEntry): boolean {
  return series.instances.some((i) => MEDIA_CLASSES.has(i.sopClass));
}

// ------------------------------------------------------------------------------------- header

export interface MediaHeader {
  transferSyntax: string;
  sopClass: string;
  rows: number;
  columns: number;
  frames: number;
  photometric: string;
  /** (0018,1063) ms */
  frameTime: number | null;
  /** (0018,1065) ms; the first value is 0 */
  frameTimeVector: number[] | null;
  /** (0028,0009) tags, as numbers (group << 16 | element) */
  frameIncrementPointer: number[];
  /** (0018,0040) frames/s */
  cineRate: number | null;
  /** (0008,2144) frames/s */
  recommendedRate: number | null;
  /** (0018,1244): 0 looping, 1 sweeping */
  playbackSequencing: number | null;
  /** (0008,2142), (0008,2143): 1-based frame numbers */
  startTrim: number | null;
  stopTrim: number | null;
  /** Offset (in the instance) of the first item of encapsulated Pixel Data; -1 when not encapsulated. */
  pixelDataItems: number;
}

export class MediaHeaderError extends Error {}

/** Thrown when the bytes end before Pixel Data: read more and parse again. */
class NeedMore extends Error {}

const ITEM = 0xfffee000;
const SEQ_END = 0xfffee0dd;

/**
 * Reads the attributes video and cine need from the start of a Part 10 file, with the shared
 * parser (dicom.ts). `b` may stop anywhere after Pixel Data's header; if it stops before, this
 * throws NeedMore (internally) and probeInstance reads further.
 */
export function parseMediaHeader(b: Uint8Array): MediaHeader {
  let p: ReturnType<typeof parseDicomSync>;
  try {
    p = parseDicomSync(b);
  } catch (e) {
    // A sequence cut off by the end of the bytes reads as damaged: more bytes may fix it.
    throw e instanceof DicomParseError ? new NeedMore() : e;
  }
  const ds = p.ds;
  const pixel = ds.get(T.PixelData);
  if (!pixel) throw new NeedMore();
  const num = (t: number) => ds.num(t);
  const fiv = ds.nums(tag(0x0028, 0x0009));
  const ftv = ds.nums(T.FrameTimeVector);
  return {
    transferSyntax: p.transferSyntax,
    sopClass: ds.str(T.SOPClassUID) ?? p.meta.str(tag(0x0002, 0x0002)) ?? "",
    rows: num(T.Rows) ?? 0,
    columns: num(T.Columns) ?? 0,
    frames: Math.max(1, Math.round(num(T.NumberOfFrames) ?? 1)),
    photometric: ds.str(T.PhotometricInterpretation) ?? "",
    frameTime: num(T.FrameTime),
    frameTimeVector: ftv.length ? ftv : null,
    frameIncrementPointer: fiv,
    cineRate: num(T.CineRate),
    recommendedRate: num(T.RecommendedDisplayFrameRate),
    playbackSequencing: num(tag(0x0018, 0x1244)),
    startTrim: num(tag(0x0008, 0x2142)),
    stopTrim: num(tag(0x0008, 0x2143)),
    // Encapsulated: the value starts with the first item (the Basic Offset Table).
    pixelDataItems: pixel.fragments ? pixel.offset : -1,
  };
}

// ------------------------------------------------------------------------------------- cine timing

export interface CineTiming {
  /** Display time of each frame in ms. */
  durations: number[];
  /** Where the timing came from, for the UI: "Frame Time", "Frame Time Vector", … or null (none recorded). */
  source: string | null;
  /** First and last frame to play (0-based, inclusive), from Start/Stop Trim. */
  first: number;
  last: number;
  /** Preferred Playback Sequencing: back and forth instead of looping. */
  sweep: boolean;
}

/** Frame rate used when a file records no timing. */
export const DEFAULT_FPS = 25;

/**
 * Frame durations for a multi-frame image (PS3.3 C.7.6.5): Frame Time Vector when Frame Increment
 * Pointer names it, else Frame Time, else Cine Rate, else Recommended Display Frame Rate.
 */
export function cineTiming(h: MediaHeader, frames = h.frames): CineTiming {
  const n = Math.max(1, frames);
  let durations: number[] | null = null;
  let source: string | null = null;
  const ftv = h.frameTimeVector;
  if (ftv && ftv.length >= n && (h.frameIncrementPointer.includes(0x00181065) || !h.frameTime)) {
    // FTV[i] is the time from frame i-1 to frame i (FTV[0] is 0): frame i shows for FTV[i+1].
    durations = [];
    for (let i = 0; i < n; i++) durations.push(ftv[i + 1] ?? ftv[i]);
    const ok = durations.filter((d) => d > 0);
    const mean = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 1000 / DEFAULT_FPS;
    durations = durations.map((d) => (d > 0 ? d : mean));
    source = "Frame Time Vector";
  } else if (h.frameTime && h.frameTime > 0) {
    durations = new Array(n).fill(h.frameTime);
    source = "Frame Time";
  } else if (h.cineRate && h.cineRate > 0) {
    durations = new Array(n).fill(1000 / h.cineRate);
    source = "Cine Rate";
  } else if (h.recommendedRate && h.recommendedRate > 0) {
    durations = new Array(n).fill(1000 / h.recommendedRate);
    source = "Recommended Display Frame Rate";
  }
  durations ??= new Array(n).fill(1000 / DEFAULT_FPS);
  let first = 0, last = n - 1;
  if (h.startTrim && h.startTrim >= 1 && h.startTrim <= n) first = h.startTrim - 1;
  if (h.stopTrim && h.stopTrim >= first + 1 && h.stopTrim <= n) last = h.stopTrim - 1;
  return { durations, source, first, last, sweep: h.playbackSequencing === 1 };
}

// ------------------------------------------------------------------------------------- reading

export interface ReadOptions {
  signal?: AbortSignal;
  /** Fetch priority (FetchPriority; default Visible). */
  priority?: number;
}

/**
 * Plaintext bytes [a, b) of instance i: one Range request, verified and decrypted by the share's
 * decryptor. Record outcomes go to the loader's onRecords (the trust count).
 */
export async function readInstanceBytes(share: OpenShare, series: SeriesEntry, i: number, a: number, b: number, o: ReadOptions = {}): Promise<Uint8Array> {
  const inst = series.instances[i];
  const end = Math.min(b, inst.length);
  const plan = planBytes(series, inst.offset + a, inst.offset + end);
  // Through the loader: its queue and record cache (the instance's full read reuses these records).
  const ct = await share.loader.range(series, plan, { signal: o.signal, priority: o.priority });
  try {
    const pt = await share.decryptor.decrypt(series, plan, ct);
    share.loader.report(plan, "verified");
    return pt;
  } catch (e) {
    if (e instanceof RecordAuthenticationError) share.loader.report(plan, "failed");
    throw e;
  }
}

export interface InstanceProbe {
  header: MediaHeader;
  /** The video syntax, or null for an image. */
  video: VideoSyntax | null;
}

/** Reads instance i's header (64 KiB, more if the header is longer) and classifies it. */
export async function probeInstance(share: OpenShare, series: SeriesEntry, i: number, o: ReadOptions = {}): Promise<InstanceProbe> {
  const len = series.instances[i].length;
  let n = Math.min(len, RECORD_PLAINTEXT);
  for (;;) {
    const bytes = await readInstanceBytes(share, series, i, 0, n, o);
    try {
      const header = parseMediaHeader(bytes);
      return { header, video: VIDEO_SYNTAXES[header.transferSyntax] ?? null };
    } catch (e) {
      if (!(e instanceof NeedMore) || n >= len) throw e instanceof NeedMore ? new MediaHeaderError("the file ends inside its header") : e;
      n = Math.min(len, n * 4);
    }
  }
}

export interface PayloadProgress {
  /** Instance bytes read so far, and the instance's length. */
  read: number;
  total: number;
}

/**
 * The encapsulated stream of instance i: every Pixel Data fragment after the Basic Offset Table,
 * concatenated, yielded in pieces as the instance is read (`chunk` bytes per request, one request
 * ahead). Video fragments are joined as they are (PS3.5 §8.2.5–8.2.11).
 */
export async function* videoPayload(
  share: OpenShare,
  series: SeriesEntry,
  i: number,
  header: MediaHeader,
  o: ReadOptions & { chunk?: number; onProgress?: (p: PayloadProgress) => void } = {},
): AsyncGenerator<Uint8Array> {
  if (header.pixelDataItems < 0) throw new MediaHeaderError("the video's Pixel Data is not encapsulated");
  const total = series.instances[i].length;
  const chunk = o.chunk ?? 64 * RECORD_PLAINTEXT; // 4 MiB of plaintext
  let next = header.pixelDataItems;
  const fetch = (a: number) => (a < total ? readInstanceBytes(share, series, i, a, Math.min(total, a + chunk), o) : null);
  let ahead: Promise<Uint8Array> | null = fetch(next);
  let buf = new Uint8Array(0);
  /** Next chunk into buf (keeps unread bytes). Returns false at the end of the instance. */
  const more = async (): Promise<boolean> => {
    if (!ahead) return false;
    const got = await ahead;
    next += got.length;
    ahead = fetch(next);
    o.onProgress?.({ read: next, total });
    const merged = new Uint8Array(buf.length + got.length);
    merged.set(buf);
    merged.set(got, buf.length);
    buf = merged;
    return true;
  };
  const ensure = async (n: number) => {
    while (buf.length < n) if (!(await more())) throw new MediaHeaderError("the video ends inside its data");
  };
  let first = true;
  try {
    for (;;) {
      await ensure(8);
      const dv = new DataView(buf.buffer, buf.byteOffset, 8);
      const item = ((dv.getUint16(0, true) << 16) | dv.getUint16(2, true)) >>> 0;
      const len = dv.getUint32(4, true);
      buf = buf.subarray(8);
      if (item === SEQ_END) return;
      if (item !== ITEM) throw new MediaHeaderError("bad item in the video's Pixel Data");
      let left = len;
      const skip = first; // the Basic Offset Table
      first = false;
      while (left > 0) {
        if (!buf.length && !(await more())) throw new MediaHeaderError("the video ends inside its data");
        const take = Math.min(left, buf.length);
        if (!skip) yield buf.slice(0, take);
        buf = buf.subarray(take);
        left -= take;
      }
    }
  } finally {
    // Let a request in flight finish quietly.
    (ahead as Promise<Uint8Array> | null)?.catch(() => {});
  }
}

// ------------------------------------------------------------------------------------- containers

export type Container = "mp4" | "ts" | "mpeg-ps" | "mpeg-es" | "unknown";

/** What the first bytes of a video payload are (PS3.5 allows MP4 or MPEG-2 TS for H.264 and HEVC). */
export function sniffContainer(b: Uint8Array): Container {
  if (b.length >= 8) {
    const t = String.fromCharCode(b[4], b[5], b[6], b[7]);
    if (["ftyp", "styp", "moov", "mdat", "free", "skip", "wide"].includes(t)) return "mp4";
  }
  if (b[0] === 0x47 && (b.length < 189 || b[188] === 0x47)) return "ts";
  if (b.length > 196 && b[4] === 0x47 && b[196] === 0x47) return "ts";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0xba) return "mpeg-ps";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && (b[3] === 0xb3 || b[3] === 0xb5)) return "mpeg-es";
  return "unknown";
}

// ------------------------------------------------------------------------------------- MP4 index

export interface Mp4VideoTrack {
  /** Video samples (frames) and the track's duration in seconds. */
  frames: number;
  duration: number;
  /** Sample entry type, e.g. avc1, hvc1. */
  codec: string;
}

/**
 * Reads the first video track's sample count and duration from an MP4 file's moov box (wherever it
 * is in the file), so frame stepping follows the stream rather than the DICOM header.
 */
export async function mp4VideoTrack(file: Blob): Promise<Mp4VideoTrack | null> {
  const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const type = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  let pos = 0;
  let moov: Uint8Array | null = null;
  while (pos + 8 <= file.size) {
    const h = new Uint8Array(await file.slice(pos, pos + 16).arrayBuffer());
    let size = u32(h, 0);
    if (size === 1) size = u32(h, 8) * 2 ** 32 + u32(h, 12);
    else if (size === 0) size = file.size - pos;
    if (size < 8) return null;
    if (type(h, 4) === "moov") {
      moov = new Uint8Array(await file.slice(pos, pos + size).arrayBuffer());
      break;
    }
    pos += size;
  }
  if (!moov) return null;
  /** Child boxes of [a, b). */
  const children = (a: number, b: number) => {
    const out: { t: string; s: number; e: number }[] = [];
    for (let o = a; o + 8 <= b; ) {
      const size = u32(moov!, o);
      if (size < 8) break;
      out.push({ t: type(moov!, o + 4), s: o + 8, e: Math.min(b, o + size) });
      o += size;
    }
    return out;
  };
  const find = (list: { t: string; s: number; e: number }[], t: string) => list.find((x) => x.t === t);
  for (const trak of children(8, moov.length).filter((x) => x.t === "trak")) {
    const mdia = find(children(trak.s, trak.e), "mdia");
    if (!mdia) continue;
    const parts = children(mdia.s, mdia.e);
    const hdlr = find(parts, "hdlr");
    if (!hdlr || type(moov, hdlr.s + 8) !== "vide") continue;
    const mdhd = find(parts, "mdhd")!;
    const v1 = moov[mdhd.s] === 1;
    const timescale = u32(moov, mdhd.s + (v1 ? 20 : 12));
    const dur = v1 ? u32(moov, mdhd.s + 24) * 2 ** 32 + u32(moov, mdhd.s + 28) : u32(moov, mdhd.s + 16);
    const minf = find(parts, "minf");
    const stbl = minf && find(children(minf.s, minf.e), "stbl");
    if (!stbl) continue;
    const sb = children(stbl.s, stbl.e);
    const stsz = find(sb, "stsz");
    const stsd = find(sb, "stsd");
    const frames = stsz ? u32(moov, stsz.s + 8) : 0;
    if (!frames || !timescale) return null;
    return { frames, duration: dur / timescale, codec: stsd ? type(moov, stsd.s + 12) : "" };
  }
  return null;
}
