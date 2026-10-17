// Video and cine test data for web/checks/video-checks.mjs.
//
//   bun web/checks/video-fixtures.ts [base]      (writes /tmp/video-fixtures.json)
//
// Makes short synthetic streams with ffmpeg (testsrc2, so no licence questions), wraps each in a
// DICOM Part 10 file with the video transfer syntax under test, adds the public corpus video files
// when they are in ~/.cache/shl-quirks (codec-corpus/prevalence/QUIRKS.md), and shares everything on
// the local server, one study per case. For each case it also writes ffmpeg's decode of the first
// frame (RGBA) and the stream's frame count and duration, for the checks to compare against.
// Generated files go to /media/barracuda/shlink-video/fixtures (override with VIDEO_FIXTURES).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { packAndShare } from "./pack-share";
import { splitAnnexB } from "../core/video-remux";
import { parseIndex } from "../core/reader";
import { studyTitle } from "../core/format";
import { element, part10 } from "./synthetic";

const base = process.argv[2] ?? "http://localhost:3333";
const dir = process.env.VIDEO_FIXTURES ?? "/media/barracuda/shlink-video/fixtures";
mkdirSync(dir, { recursive: true });
const quirks = `${homedir()}/.cache/shl-quirks`;
const PUBLIC = process.env.VIDEO_PUBLIC ?? "/media/barracuda/shlink-video/public";

const ff = (...args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "inherit"] });
const BT709 = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
const tone = (t: number) => ["-f", "lavfi", "-t", String(t), "-i", "sine=frequency=440:sample_rate=48000"];
const bars = (size: string, rate: string, t: number) => ["-f", "lavfi", "-t", String(t), "-i", `testsrc2=size=${size}:rate=${rate}`];
const x264 = (level: string, extra: string[] = []) => ["-c:v", "libx264", "-profile:v", "high", "-level", level, "-pix_fmt", "yuv420p", "-g", "30", "-bf", "2", ...extra, ...BT709];

/** Streams to generate: file name → ffmpeg arguments (output appended). */
const STREAMS: Record<string, string[]> = {
  "h264-ac3.ts": [...bars("1280x720", "30000/1001", 4), ...tone(4), "-map", "0:v", "-map", "1:a", ...x264("4.1"), "-c:a", "ac3", "-f", "mpegts"],
  // LPCM in a Transport Stream: ffmpeg labels it (stream type 0x80) only in M2TS mode (192-byte packets).
  "h264-lpcm.ts": [...bars("1280x720", "25", 3), ...tone(3), "-map", "0:v", "-map", "1:a", ...x264("4.1"), "-c:a", "pcm_bluray", "-f", "mpegts", "-mpegts_m2ts_mode", "1"],
  "h264-aac.mp4": [...bars("1280x720", "30", 3), ...tone(3), "-map", "0:v", "-map", "1:a", ...x264("4.1"), "-c:a", "aac", "-movflags", "+faststart"],
  "h264-1080i.ts": [...bars("1920x1080", "50", 3), "-vf", "tinterlace=4,setfield=tff", ...x264("4.1", ["-flags", "+ildct+ilme", "-x264-params", "tff=1"]), "-f", "mpegts"],
  "h264-1080p60.mp4": [...bars("1920x1080", "60", 3), ...x264("4.2"), "-movflags", "+faststart"],
  "h264-sbs3d.ts": ["-f", "lavfi", "-t", "3", "-i", "testsrc2=size=960x1080:rate=30,split[a][b];[b]hue=h=90[c];[a][c]hstack", ...x264("4.2", ["-x264-params", "frame-packing=3"]), "-f", "mpegts"],
  "h264-base.h264": [...bars("1280x720", "30", 3), ...x264("4.2", ["-bf", "0"]), "-bsf:v", "h264_mp4toannexb", "-f", "h264"],
  "hevc-main.mp4": [...bars("1920x1080", "30", 3), "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-x265-params", "log-level=error", "-movflags", "+faststart"],
  "hevc-main10.ts": [...bars("1920x1080", "30", 3), ...tone(3), "-map", "0:v", "-map", "1:a", "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=error", "-c:a", "ac3", "-f", "mpegts"],
  "mpeg2-sd.ts": [...bars("720x576", "25", 4), ...tone(4), "-map", "0:v", "-map", "1:a", "-c:v", "mpeg2video", "-b:v", "6M", "-g", "12", "-bf", "2", "-pix_fmt", "yuv420p", "-c:a", "mp2", "-f", "mpegts"],
  "mpeg2-hd.mpg": [...bars("1920x1080", "25", 3), "-c:v", "mpeg2video", "-b:v", "20M", "-g", "12", "-bf", "2", "-pix_fmt", "yuv420p", "-f", "vob"],
};

for (const [name, args] of Object.entries(STREAMS)) {
  if (!existsSync(`${dir}/${name}`)) ff(...args, `${dir}/${name}`);
}

/**
 * H.264 MVC stand-in for the stereo syntax (.106): no free encoder writes MVC, so the base stream
 * gets a prefix NAL unit (14) before each slice and a coded slice extension (20) after it, as an MVC
 * stream carries for its second view. A player must show the base view and ignore the rest.
 */
if (!existsSync(`${dir}/h264-mvc.ts`)) {
  const base = new Uint8Array(readFileSync(`${dir}/h264-base.h264`));
  const out: number[] = [];
  const sc = [0, 0, 0, 1];
  for (const nal of splitAnnexB(base)) {
    const t = nal[0] & 0x1f;
    if (t === 1 || t === 5) out.push(...sc, 0x6e, 0x80, 0x00, 0x00, 0x00, 0x00, 0x80);
    out.push(...sc, ...nal);
    if (t === 1 || t === 5) out.push(...sc, 0x74, 0x80, 0x00, 0x00, 0x40, 0x00, 0x11, 0x22, 0x33, 0x80);
  }
  writeFileSync(`${dir}/h264-mvc.h264`, Uint8Array.from(out));
  ff("-fflags", "+genpts", "-r", "30", "-f", "h264", "-i", `${dir}/h264-mvc.h264`, "-c", "copy", "-f", "mpegts", `${dir}/h264-mvc.ts`);
}

// ------------------------------------------------------------------------------------- DICOM

const UID_ROOT = "2.25.";
let uidSeq = 0;
const uid = () => `${UID_ROOT}${BigInt(Date.now()) * 1000000n + BigInt(++uidSeq)}${Math.floor(Math.random() * 1e6)}`;

/** An element whose value is text, bytes, or US / AT numbers. */
function el(group: number, elem: number, vr: string, value: Uint8Array | string | number[], kind?: "us" | "at"): Uint8Array {
  if (!Array.isArray(value)) return element(group, elem, vr, value);
  const dv = new DataView(new ArrayBuffer(value.length * (kind === "at" ? 4 : 2)));
  value.forEach((x, i) => (kind === "at" ? (dv.setUint16(i * 4, x >>> 16, true), dv.setUint16(i * 4 + 2, x & 0xffff, true)) : dv.setUint16(i * 2, x, true)));
  return element(group, elem, vr, new Uint8Array(dv.buffer));
}

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};

/** Encapsulated Pixel Data: the stream cut into fragments, or the given fragments (one per frame). */
function encapsulate(stream: Uint8Array | Uint8Array[], fragmentBytes: number): Uint8Array[] {
  const parts: Uint8Array[] = [Uint8Array.from([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0, 0, 0xff, 0xff, 0xff, 0xff])];
  parts.push(Uint8Array.from([0xfe, 0xff, 0x00, 0xe0, 0, 0, 0, 0])); // empty Basic Offset Table
  const frags: Uint8Array[] = [];
  if (Array.isArray(stream)) frags.push(...stream);
  else for (let o = 0; o < stream.length; o += fragmentBytes) frags.push(stream.subarray(o, Math.min(stream.length, o + fragmentBytes)));
  for (let f of frags) {
    if (f.length % 2) {
      const g = new Uint8Array(f.length + 1);
      g.set(f);
      f = g;
    }
    parts.push(Uint8Array.from([0xfe, 0xff, 0x00, 0xe0]), u32(f.length), f);
  }
  parts.push(Uint8Array.from([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]));
  return parts;
}

interface VideoDicom {
  ts: string;
  sopClass?: string;
  modality?: string;
  study: string;
  studyUid: string;
  rows: number;
  columns: number;
  frames: number;
  frameTimeMs: number;
  /** Frame Time Vector (ms; the first value 0): Frame Increment Pointer then names it. */
  frameTimeVector?: number[];
  photometric?: string;
  seriesUid?: string;
  seriesDescription?: string;
  instanceNumber?: number;
  stream: Uint8Array | Uint8Array[];
  fragmentBytes?: number;
}

function videoDicom(v: VideoDicom): Uint8Array {
  const sop = v.sopClass ?? "1.2.840.10008.5.1.4.1.1.77.1.1.1";
  const inst = uid();
  const ds = [
    el(8, 0x16, "UI", sop),
    el(8, 0x18, "UI", inst),
    el(8, 0x20, "DA", "20260101"),
    el(8, 0x60, "CS", v.modality ?? "ES"),
    el(8, 0x1030, "LO", v.study),
    el(8, 0x103e, "LO", v.seriesDescription ?? v.study),
    el(0x10, 0x10, "PN", "Video^Test"),
    el(0x10, 0x20, "LO", "VIDEOTEST"),
    el(0x18, 0x1063, "DS", v.frameTimeMs.toFixed(4)),
    ...(v.frameTimeVector ? [el(0x18, 0x1065, "DS", v.frameTimeVector.map((x) => x.toFixed(1)).join("\\"))] : []),
    el(0x20, 0x0d, "UI", v.studyUid),
    el(0x20, 0x0e, "UI", v.seriesUid ?? uid()),
    el(0x20, 0x11, "IS", "1"),
    el(0x20, 0x13, "IS", String(v.instanceNumber ?? 1)),
    el(0x28, 0x02, "US", [3], "us"),
    el(0x28, 0x04, "CS", v.photometric ?? "YBR_PARTIAL_420"),
    el(0x28, 0x06, "US", [0], "us"),
    el(0x28, 0x08, "IS", String(v.frames)),
    el(0x28, 0x09, "AT", [v.frameTimeVector ? 0x00181065 : 0x00181063], "at"),
    el(0x28, 0x10, "US", [v.rows], "us"),
    el(0x28, 0x11, "US", [v.columns], "us"),
    el(0x28, 0x100, "US", [8], "us"),
    el(0x28, 0x101, "US", [8], "us"),
    el(0x28, 0x102, "US", [7], "us"),
    el(0x28, 0x103, "US", [0], "us"),
  ];
  return part10(sop, inst, v.ts, [...ds, ...encapsulate(v.stream, v.fragmentBytes ?? 0x7ffffffe)]);
}

// ------------------------------------------------------------------------------------- cases

interface Probe {
  frames: number;
  duration: number;
  width: number;
  height: number;
  rate: number;
}

function probe(file: string): Probe {
  const j = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames,width,height,r_frame_rate,avg_frame_rate:format=duration", "-of", "json", file]).toString(),
  );
  const s = j.streams[0];
  const [a, b] = String(s.avg_frame_rate !== "0/0" ? s.avg_frame_rate : s.r_frame_rate).split("/").map(Number);
  const frames = Number(s.nb_read_frames), rate = a / (b || 1);
  // Video duration: frames over the frame rate (the container's duration can include audio), or
  // the container's duration for variable frame rate.
  const duration = rate > 0 && rate < 300 ? frames / rate : Number(j.format.duration);
  return { frames, duration, width: s.width, height: s.height, rate };
}

/**
 * ffmpeg's first decoded frame as RGBA, for the browser's first frame to be compared with. A stream
 * that names its colour matrix gets that one; one that doesn't gets both BT.601 and BT.709, because
 * players differ (ffmpeg assumes BT.601, Chrome BT.709 for HD), and the check takes the closer.
 */
function firstFrame(file: string, stem: string): { matrix: string; path: string }[] {
  const cs = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_space", "-of", "csv=p=0", file]).toString().trim();
  const named = cs === "bt709" ? ["bt709"] : cs === "smpte170m" || cs === "bt470bg" ? ["bt601"] : ["bt601", "bt709"];
  return named.map((m) => {
    const path = `${stem}.frame0.${m}.rgba`;
    if (!existsSync(path)) ff("-i", file, "-map", "0:v:0", "-frames:v", "1", "-vf", `scale=flags=bilinear+accurate_rnd+full_chroma_int:in_color_matrix=${m},format=rgba`, "-f", "rawvideo", path);
    return { matrix: m, path };
  });
}

interface Case {
  name: string;
  /** The study's title in the overview (the check finds the study by it). */
  study: string;
  studyUid: string;
  /** Where the instance is in the share: study, series and instance indexes (from the Bundle). */
  at?: { study: number; series: number; instance: number };
  ts: string;
  source: string;
  file: string;
  expect: { plays: "yes" | "if-supported" | "mpeg2"; frames: number; duration: number; width: number; height: number; note?: string; dropped?: string[] };
  refs: { matrix: string; path: string }[];
}

const cases: Case[] = [];
const files: { name: string; bytes: Uint8Array }[] = [];

function addGenerated(name: string, stream: string, ts: string, o: { fragmentBytes?: number; plays?: Case["expect"]["plays"]; note?: string; dropped?: string[] } = {}) {
  const p = probe(`${dir}/${stream}`);
  const study = `Video check: ${name}`;
  const studyUid = uid();
  const bytes = videoDicom({
    ts,
    study,
    studyUid,
    rows: p.height,
    columns: p.width,
    frames: p.frames,
    frameTimeMs: 1000 / p.rate,
    stream: new Uint8Array(readFileSync(`${dir}/${stream}`)),
    fragmentBytes: o.fragmentBytes,
  });
  const file = `${dir}/${name}.dcm`;
  writeFileSync(file, bytes);
  const refs = firstFrame(`${dir}/${stream}`, `${dir}/${stream}`);
  files.push({ name: `${name}.dcm`, bytes });
  cases.push({ name, study, studyUid, ts, source: `synthetic (ffmpeg testsrc2) ${stream}`, file, expect: { plays: o.plays ?? "yes", ...p, note: o.note, dropped: o.dropped }, refs });
}

const TS = (n: string) => `1.2.840.10008.1.2.4.${n}`;
addGenerated("h264-ts-ac3", "h264-ac3.ts", TS("102"), { dropped: ["AC-3 audio"], note: "without sound" });
addGenerated("h264-ts-fragmentable", "h264-ac3.ts", TS("102.1"), { fragmentBytes: 256 * 1024, dropped: ["AC-3 audio"] });
addGenerated("h264-ts-lpcm", "h264-lpcm.ts", TS("102"), { dropped: ["LPCM audio"], note: "without sound" });
addGenerated("h264-mp4-aac", "h264-aac.mp4", TS("102.1"), { fragmentBytes: 64 * 1024 });
addGenerated("h264-bd-1080i", "h264-1080i.ts", TS("103"));
addGenerated("h264-1080p60", "h264-1080p60.mp4", TS("104"));
addGenerated("h264-3d-sbs", "h264-sbs3d.ts", TS("105"), { note: "one of its two views" });
addGenerated("h264-stereo-mvc", "h264-mvc.ts", TS("106"), { note: "one of its two views" });
addGenerated("hevc-main-mp4", "hevc-main.mp4", TS("107"), { plays: "if-supported" });
addGenerated("hevc-main10-ts", "hevc-main10.ts", TS("108"), { plays: "if-supported" });
addGenerated("mpeg2-ts", "mpeg2-sd.ts", TS("100"), { plays: "mpeg2" });
addGenerated("mpeg2-hd-ps", "mpeg2-hd.mpg", TS("101.1"), { fragmentBytes: 512 * 1024, plays: "mpeg2" });

/** Public corpus files (QUIRKS.md), when they are in the local cache. */
const CORPUS: { name: string; path: string; source: string; plays: Case["expect"]["plays"] }[] = [
  { name: "ext-orthanc-Issue42", path: `${quirks}/orthanc/Issue42.dcm`, source: "Orthanc tests (GPL-3.0 repository); same file as fo-dicom test_720.dcm", plays: "yes" },
  { name: "ext-fodicom-ETIAM_video_002", path: `${quirks}/fo-dicom/Tests/FO-DICOM.Tests/Test Data/ETIAM_video_002.dcm`, source: "fo-dicom tests (MS-PL repository)", plays: "mpeg2" },
  {
    name: "ext-issue-fo-dicom_1216",
    path: `${quirks}/issues/fo-dicom_fo-dicom_1216/x-YBR_Partial_420.Files/1.2.826.0.1.3680043.9.7496.1.31320053779239041519419574390352141_1_1631855355654.dcm`,
    source: "fo-dicom issue 1216 attachment (US multi-frame, H.264 in MP4)",
    plays: "yes",
  },
  // Found by a search of public sources (see web/checks/video-checks.mjs for the list).
  {
    name: "ext-ohif-mixedVideo",
    path: `${PUBLIC}/ohif-viewer-testdata/OT.1.3.6.1.4.1.5962.99.3.434174349.6916.500660925.201.dcm`,
    source: "OHIF viewer-testdata dcm/mixedVideo (MIT repository; data from FU Berlin, agreed for OHIF testing): 1080p60 H.264 in MP4, 3,360 frames",
    plays: "yes",
  },
  {
    name: "ext-weasis-video-aac",
    path: `${PUBLIC}/weasis-demo-archive/1.3.51.5146.1682.20140505.1225531.198`,
    source: "Weasis demo-archive (CC BY 4.0): H.264 in MP4 with AAC audio",
    plays: "yes",
  },
  {
    name: "ext-etiam-video-003",
    path: `${PUBLIC}/gdcmSampleData-wayback/ETIAM_video_003.dcm`,
    source: "ETIAM sample from the old GDCM sample folder (Wayback; 'copyright etiam 2005', no licence terms; local checks only): MPEG-2 Program Stream with MPEG audio",
    plays: "mpeg2",
  },
];
for (const c of CORPUS) {
  if (!existsSync(c.path)) {
    console.error(`skipped ${c.name}: ${c.path} not found`);
    continue;
  }
  // Extract the stream for the reference decode (pydicom-free: walk the items after Pixel Data).
  const bytes = new Uint8Array(readFileSync(c.path));
  const stream = extractStream(bytes);
  const streamFile = `${dir}/${c.name}.stream`;
  writeFileSync(streamFile, stream);
  const p = probe(streamFile);
  const refs = firstFrame(streamFile, streamFile);
  files.push({ name: `${c.name}.dcm`, bytes });
  cases.push({ name: c.name, study: "", studyUid: readUi(bytes, 0x0020, 0x000d), ts: readTs(bytes), source: c.source, file: c.path, expect: { plays: c.plays, ...p }, refs });
}

function readTs(b: Uint8Array): string {
  const s = new TextDecoder("latin1").decode(b.subarray(0, 4096));
  return s.match(/1\.2\.840\.10008\.1\.2\.4\.10[0-8](\.1)?/)?.[0] ?? "";
}
/** A UI element of the data set (explicit VR little endian), by a byte scan of the header. */
function readUi(b: Uint8Array, group: number, elem: number): string {
  for (let i = 132; i < Math.min(b.length, 1 << 20); i++) {
    if (b[i] === (group & 0xff) && b[i + 1] === group >> 8 && b[i + 2] === (elem & 0xff) && b[i + 3] === elem >> 8 && b[i + 4] === 0x55 && b[i + 5] === 0x49) {
      const n = b[i + 6] | (b[i + 7] << 8);
      return new TextDecoder("latin1").decode(b.subarray(i + 8, i + 8 + n)).replace(/\0/g, "").trim();
    }
  }
  return "";
}
function extractStream(b: Uint8Array): Uint8Array {
  // Pixel Data (7FE0,0010) OB with undefined length: the last one in the file.
  let p = -1;
  for (let i = b.length - 12; i >= 132; i--) {
    if (b[i] === 0xe0 && b[i + 1] === 0x7f && b[i + 2] === 0x10 && b[i + 3] === 0 && b[i + 8] === 0xff && b[i + 9] === 0xff && b[i + 10] === 0xff && b[i + 11] === 0xff) {
      p = i + 12;
      break;
    }
  }
  if (p < 0) throw new Error("no encapsulated Pixel Data");
  const dv = new DataView(b.buffer, b.byteOffset);
  const out: Uint8Array[] = [];
  let first = true;
  for (;;) {
    const el = dv.getUint16(p + 2, true), len = dv.getUint32(p + 4, true);
    p += 8;
    if (el === 0xe0dd) break;
    if (!first) out.push(b.subarray(p, p + len));
    first = false;
    p += len;
  }
  return Buffer.concat(out);
}

// ------------------------------------------------------------------------------------- cine

/** Multi-frame images for cine: synthetic JPEG cases plus IDC ultrasound and fluoroscopy (CC BY 4.0). */
interface CineCase {
  name: string;
  study: string;
  studyUid: string;
  source: string;
  /** Frames per instance; instances in the series. */
  frames: number;
  instances: number;
  /** Expected timing: where it comes from, and the frame durations (ms). */
  timing: string | null;
  durations: number[];
}
const cineCases: CineCase[] = [];
const cineFiles: { name: string; bytes: Uint8Array }[] = [];

function jpegFrames(name: string, n: number, size: string, hue = 0): Uint8Array[] {
  const d = `${dir}/${name}-jpeg`;
  if (!existsSync(`${d}/f${String(n).padStart(3, "0")}.jpg`)) {
    mkdirSync(d, { recursive: true });
    ff("-f", "lavfi", "-i", `testsrc2=size=${size}:rate=25,hue=h=${hue}`, "-frames:v", String(n), "-c:v", "mjpeg", "-pix_fmt", "yuvj422p", "-q:v", "3", `${d}/f%03d.jpg`);
  }
  return Array.from({ length: n }, (_, i) => new Uint8Array(readFileSync(`${d}/f${String(i + 1).padStart(3, "0")}.jpg`)));
}

{
  // JPEG baseline with a Frame Time Vector: frames alternate 20 ms and 60 ms.
  const n = 40;
  const ftv = [0, ...Array.from({ length: n - 1 }, (_, i) => (i % 2 ? 60 : 20))];
  const studyUid = uid();
  const bytes = videoDicom({
    ts: "1.2.840.10008.1.2.4.50", sopClass: "1.2.840.10008.5.1.4.1.1.3.1", modality: "US", study: "Cine check: JPEG, Frame Time Vector", studyUid,
    rows: 240, columns: 320, frames: n, frameTimeMs: 40, frameTimeVector: ftv, photometric: "YBR_FULL_422", stream: jpegFrames("cine-ftv", n, "320x240"),
  });
  cineFiles.push({ name: "cine-ftv.dcm", bytes });
  const durations = Array.from({ length: n }, (_, i) => ftv[i + 1] ?? ftv[i]);
  cineCases.push({ name: "cine-jpeg-ftv", study: "", studyUid, source: "synthetic (ffmpeg testsrc2, JPEG baseline)", frames: n, instances: 1, timing: "Frame Time Vector", durations });
}
{
  // An echo-style series: three multi-frame clips (JPEG, Frame Time 40 ms) in one series.
  const studyUid = uid(), seriesUid = uid();
  for (let k = 0; k < 3; k++) {
    const bytes = videoDicom({
      ts: "1.2.840.10008.1.2.4.50", sopClass: "1.2.840.10008.5.1.4.1.1.3.1", modality: "US", study: "Cine check: three clips in one series", studyUid, seriesUid,
      seriesDescription: "Three clips", instanceNumber: k + 1, rows: 240, columns: 320, frames: 20, frameTimeMs: 40, photometric: "YBR_FULL_422",
      stream: jpegFrames(`cine-clip${k}`, 20, "320x240", k * 120),
    });
    cineFiles.push({ name: `cine-clip${k}.dcm`, bytes });
  }
  cineCases.push({ name: "cine-clips", study: "", studyUid, source: "synthetic (ffmpeg testsrc2, JPEG baseline)", frames: 20, instances: 3, timing: "Frame Time", durations: new Array(20).fill(40) });
}
const IDC_CINE = process.env.CINE_IDC ?? "/media/barracuda/shlink-video/idc-cine";
/** The IDC files (picked with BigQuery; URLs in picked.txt), with Number of Frames and Frame Time from IDC's index. */
const IDC: Record<string, { collection: string; timing: string | null; frames: number; ms: number }> = {
  "us-mono-ft": { collection: "cmb_crc", timing: "Frame Time", frames: 21, ms: 30.38784 },
  "rf-ft250": { collection: "varepop_apollo", timing: "Frame Time", frames: 16, ms: 250 },
  "us-mono-notiming": { collection: "prostate_mri_us_biopsy", timing: null, frames: 227, ms: 40 },
  "us-ybrfull-ft": { collection: "b_mode_and_ceus_liver", timing: "Frame Time", frames: 23, ms: 111.30384 },
  "us-rgb-ft": { collection: "b_mode_and_ceus_liver", timing: "Frame Time", frames: 13, ms: 51.00032 },
};
for (const [name, meta] of Object.entries(IDC)) {
  const path = `${IDC_CINE}/${name}.dcm`;
  if (!existsSync(path)) {
    console.error(`skipped ${name}: ${path} not found (see ${IDC_CINE}/picked.txt for the IDC URLs)`);
    continue;
  }
  const bytes = new Uint8Array(readFileSync(path));
  const { frames, ms } = meta;
  cineFiles.push({ name: `${name}.dcm`, bytes });
  cineCases.push({
    name: `idc-${name}`, study: "", studyUid: readUi(bytes, 0x0020, 0x000d), source: `IDC ${meta.collection} (CC BY 4.0)`, frames, instances: 1, timing: meta.timing,
    durations: new Array(frames).fill(ms),
  });
}

// ------------------------------------------------------------------------------------- share

// VIDEO_ONLY=a,b: share only the cases whose names contain one of these (a quick run).
const pick = process.env.VIDEO_ONLY?.split(",").filter(Boolean);
if (pick) {
  const want = (n: string) => pick.some((p) => n.includes(p));
  const keep = <T extends { name: string }>(xs: T[], name: (x: T) => string = (x) => x.name) => xs.splice(0, xs.length, ...xs.filter((x) => want(name(x))));
  keep(cases);
  keep(files, (f) => f.name.replace(/\.dcm$/, ""));
  // The cine files are small: all of them, or none when no cine case is picked.
  keep(cineCases);
  if (!cineCases.length) cineFiles.length = 0;
}

const shared = await packAndShare(base, files);
// Where each case is in the share, as the viewer lists it.
const index = await parseIndex(shared.bundle);
for (const c of cases) {
  const sop = readUi(new Uint8Array(readFileSync(c.file)), 0x0008, 0x0018);
  index.studies.forEach((st, i) =>
    st.series.forEach((se, j) =>
      se.instances.forEach((inst, k) => {
        if (inst.uid === sop) {
          c.at = { study: i, series: j, instance: k };
          c.study = studyTitle(st);
        }
      }),
    ),
  );
  if (!c.at) throw new Error(`${c.name}: instance ${sop} not in the Bundle`);
}
const { shlink } = await shared.mint(shared.bundle, { label: "Video checks" });
const cineShared = cineFiles.length ? await packAndShare(base, cineFiles) : null;
const cineLink = cineShared ? (await cineShared.mint(cineShared.bundle, { label: "Cine checks" })).shlink : null;
const cineIndex = cineShared ? await parseIndex(cineShared.bundle) : null;
for (const c of cineCases) {
  const st = cineIndex?.studies.find((s) => s.studyInstanceUid === c.studyUid);
  if (!st) throw new Error(`${c.name}: study ${c.studyUid} not in the Bundle`);
  c.study = studyTitle(st);
}
const out = {
  link: shlink,
  share: { sid: shared.sid, token: shared.token },
  dir,
  cases,
  cine: { link: cineLink, share: cineShared && { sid: cineShared.sid, token: cineShared.token }, cases: cineCases.map((c) => ({ ...c, durations: undefined, meanMs: c.durations.reduce((a, b) => a + b, 0) / c.durations.length, durationsHead: c.durations.slice(0, 6) })) },
};
writeFileSync("/tmp/video-fixtures.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, link: undefined, cine: out.cine.cases.map((c) => `${c.name} "${c.study}" ${c.frames}f×${c.instances} ${c.timing} ${c.meanMs}ms`), cases: cases.map((c) => `${c.name} ${c.ts} ${c.expect.frames}f ${c.expect.duration}s`) }, null, 2));
