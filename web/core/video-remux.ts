// MPEG-2 Transport Stream → fragmented MP4, for H.264 and HEVC video carried in DICOM
// (PS3.5 §8.2.8, §8.2.11). Pure byte work: no decoding. Audio and other streams are dropped.
//
//   const r = new TsRemuxer({ frameDuration90k });   // hint from Frame Time, used when PTS is missing
//   for (const chunk of tsChunks) r.push(chunk);
//   const out = r.finish();        // { parts: [init, moof+mdat, …], codec, width, height, … }
//   new Blob(out.parts, { type: "video/mp4" })
//
// Video: the first H.264 (stream_type 0x1B) or HEVC (0x24) elementary stream in the PMT. Base view
// or base layer only: H.264 MVC NAL units (14, 15, 20) and HEVC NAL units with nuh_layer_id > 0 are
// dropped, so a stereo stream plays as its base view. Timestamps come from PES PTS/DTS (90 kHz).

// ------------------------------------------------------------------------------------- bits

/** Removes emulation-prevention bytes (00 00 03 → 00 00). */
export function unescapeRbsp(b: Uint8Array): Uint8Array {
  let n = 0;
  for (let i = 2; i < b.length; i++) if (b[i] === 3 && b[i - 1] === 0 && b[i - 2] === 0) n++;
  if (!n) return b;
  const out = new Uint8Array(b.length - n);
  let o = 0;
  let zeros = 0;
  for (let i = 0; i < b.length; i++) {
    const v = b[i];
    if (zeros >= 2 && v === 3) {
      zeros = 0;
      continue;
    }
    out[o++] = v;
    zeros = v === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

export class BitReader {
  private pos = 0;
  private b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  get bitsLeft() {
    return this.b.length * 8 - this.pos;
  }
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.pos >> 3];
      if (byte === undefined) throw new RangeError("read past the end of a parameter set");
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  skip(n: number) {
    this.pos += n;
  }
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      if (++zeros > 31) throw new RangeError("bad Exp-Golomb code");
    }
    return 2 ** zeros - 1 + this.u(zeros);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

// ------------------------------------------------------------------------------------- NAL units

/** Splits an Annex B byte stream into NAL units (start codes removed). */
export function splitAnnexB(b: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  const n = b.length;
  while (i + 2 < n) {
    if (b[i + 2] > 1) {
      i += 3;
      continue;
    }
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && b[end - 1] === 0) end--; // trailing zeros / 4-byte start code
        if (end > start) out.push(b.subarray(start, end));
      }
      start = i + 3;
      i += 3;
    } else i++;
  }
  if (start >= 0 && start < n) {
    let end = n;
    while (end > start && b[end - 1] === 0) end--;
    if (end > start) out.push(b.subarray(start, end));
  }
  return out;
}

export interface VideoParams {
  codec: "h264" | "hevc";
  /** RFC 6381 codec string, e.g. avc1.640029 or hvc1.1.6.L153.B0. */
  codecString: string;
  width: number;
  height: number;
  /** Sample aspect ratio, 1:1 when not signalled. */
  sarW: number;
  sarH: number;
  bitDepth: number;
  chromaFormat: number;
  /** H.264 only: frame_mbs_only_flag and log2_max_frame_num, to pair field pictures. */
  frameMbsOnly?: boolean;
  log2MaxFrameNum?: number;
  separateColourPlane?: boolean;
}

const hex2 = (v: number) => v.toString(16).padStart(2, "0");

const SAR_TABLE: [number, number][] = [
  [1, 1], [1, 1], [12, 11], [10, 11], [16, 11], [40, 33], [24, 11], [20, 11], [32, 11],
  [80, 33], [18, 11], [15, 11], [64, 33], [160, 99], [4, 3], [3, 2], [2, 1],
];

function skipScalingList(r: BitReader, size: number) {
  let last = 8, next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/** H.264 sequence parameter set (NAL type 7, header byte included). */
export function parseAvcSps(nal: Uint8Array): VideoParams {
  const r = new BitReader(unescapeRbsp(nal.subarray(1)));
  const profile = r.u(8);
  const constraints = r.u(8);
  const level = r.u(8);
  r.ue(); // seq_parameter_set_id
  let chromaFormat = 1, bitDepth = 8, separateColourPlane = false;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chromaFormat = r.ue();
    if (chromaFormat === 3) separateColourPlane = r.u(1) === 1;
    bitDepth = r.ue() + 8;
    r.ue(); // bit_depth_chroma_minus8
    r.u(1); // qpprime_y_zero_transform_bypass_flag
    if (r.u(1)) {
      for (let i = 0; i < (chromaFormat !== 3 ? 8 : 12); i++) if (r.u(1)) skipScalingList(r, i < 6 ? 16 : 64);
    }
  }
  const log2MaxFrameNum = r.ue() + 4;
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.u(1);
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.u(1); // gaps_in_frame_num_value_allowed_flag
  const wMbs = r.ue() + 1;
  const hMapUnits = r.ue() + 1;
  const frameMbsOnly = r.u(1) === 1;
  if (!frameMbsOnly) r.u(1); // mb_adaptive_frame_field_flag
  r.u(1); // direct_8x8_inference_flag
  let cl = 0, cr = 0, ct = 0, cb = 0;
  if (r.u(1)) {
    cl = r.ue();
    cr = r.ue();
    ct = r.ue();
    cb = r.ue();
  }
  const arrayType = separateColourPlane ? 0 : chromaFormat;
  const cropX = arrayType === 0 ? 1 : arrayType === 3 ? 1 : 2;
  const cropY = (arrayType === 0 ? 1 : arrayType === 1 ? 2 : 1) * (frameMbsOnly ? 1 : 2);
  const width = wMbs * 16 - cropX * (cl + cr);
  const height = (frameMbsOnly ? 1 : 2) * hMapUnits * 16 - cropY * (ct + cb);
  let sarW = 1, sarH = 1;
  try {
    if (r.u(1) && r.u(1)) {
      // vui_parameters_present_flag, aspect_ratio_info_present_flag
      const idc = r.u(8);
      if (idc === 255) {
        sarW = r.u(16);
        sarH = r.u(16);
      } else if (SAR_TABLE[idc]) [sarW, sarH] = SAR_TABLE[idc];
    }
  } catch {
    // A truncated VUI only loses the aspect ratio.
  }
  if (!sarW || !sarH) sarW = sarH = 1;
  return {
    codec: "h264",
    codecString: `avc1.${hex2(profile)}${hex2(constraints)}${hex2(level)}`,
    width,
    height,
    sarW,
    sarH,
    bitDepth,
    chromaFormat,
    frameMbsOnly,
    log2MaxFrameNum,
    separateColourPlane,
  };
}

/** HEVC profile_tier_level general fields, as hvcC wants them. */
interface HevcPtl {
  profileSpace: number;
  tier: number;
  profileIdc: number;
  compat: number;
  constraint: Uint8Array; // 6 bytes
  levelIdc: number;
}

function parseHevcPtl(r: BitReader, maxSubLayersMinus1: number): HevcPtl {
  const profileSpace = r.u(2);
  const tier = r.u(1);
  const profileIdc = r.u(5);
  const compat = r.u(32);
  const constraint = new Uint8Array(6);
  for (let i = 0; i < 6; i++) constraint[i] = r.u(8);
  const levelIdc = r.u(8);
  const subProfile: boolean[] = [], subLevel: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    subProfile.push(r.u(1) === 1);
    subLevel.push(r.u(1) === 1);
  }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.u(2);
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (subProfile[i]) r.skip(88);
    if (subLevel[i]) r.skip(8);
  }
  return { profileSpace, tier, profileIdc, compat, constraint, levelIdc };
}

/** Bit-reverses a 32-bit value (for the compatibility flags in the codec string). */
function reverse32(v: number): number {
  let o = 0;
  for (let i = 0; i < 32; i++) o = o * 2 + ((v >>> i) & 1);
  return o;
}

export interface HevcSpsInfo extends VideoParams {
  ptl: HevcPtl;
  maxSubLayersMinus1: number;
  temporalIdNesting: boolean;
}

/** HEVC sequence parameter set (NAL type 33, 2-byte header included). */
export function parseHevcSps(nal: Uint8Array): HevcSpsInfo {
  const r = new BitReader(unescapeRbsp(nal.subarray(2)));
  r.u(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.u(3);
  const temporalIdNesting = r.u(1) === 1;
  const ptl = parseHevcPtl(r, maxSubLayersMinus1);
  r.ue(); // sps_seq_parameter_set_id
  const chromaFormat = r.ue();
  let separateColourPlane = false;
  if (chromaFormat === 3) separateColourPlane = r.u(1) === 1;
  let width = r.ue();
  let height = r.ue();
  if (r.u(1)) {
    const subW = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
    const subH = chromaFormat === 1 ? 2 : 1;
    const l = r.ue(), rr = r.ue(), t = r.ue(), b = r.ue();
    width -= subW * (l + rr);
    height -= subH * (t + b);
  }
  const bitDepth = r.ue() + 8;
  // Codec string per ISO/IEC 14496-15 Annex E: hvc1.<space><profile>.<compat reversed>.<tier><level>.<constraints>
  const space = ["", "A", "B", "C"][ptl.profileSpace];
  let cons = [...ptl.constraint];
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  const consStr = cons.map((c) => c.toString(16).toUpperCase()).join(".");
  const codecString = `hvc1.${space}${ptl.profileIdc}.${reverse32(ptl.compat).toString(16).toUpperCase()}.${ptl.tier ? "H" : "L"}${ptl.levelIdc}${consStr ? "." + consStr : ""}`;
  return {
    codec: "hevc",
    codecString,
    width,
    height,
    sarW: 1,
    sarH: 1,
    bitDepth,
    chromaFormat,
    separateColourPlane,
    ptl,
    maxSubLayersMinus1,
    temporalIdNesting,
  };
}

/** H.264 frame packing arrangement SEI (payload 45): 3 side by side, 4 top and bottom, 5 frame alternation. */
export function avcFramePacking(seiNal: Uint8Array): number | null {
  const b = unescapeRbsp(seiNal.subarray(1));
  let i = 0;
  while (i + 2 <= b.length - 1) {
    let type = 0, size = 0;
    while (b[i] === 0xff) (type += 255), i++;
    type += b[i++];
    while (b[i] === 0xff) (size += 255), i++;
    size += b[i++];
    if (type === 45) {
      try {
        const r = new BitReader(b.subarray(i, i + size));
        r.ue();
        if (r.u(1)) return null; // cancel
        return r.u(7);
      } catch {
        return null;
      }
    }
    i += size;
  }
  return null;
}

// ------------------------------------------------------------------------------------- MP4 boxes

class W {
  private parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    return this.u8(v >>> 8).u8(v);
  }
  u24(v: number) {
    return this.u8(v >>> 16).u16(v & 0xffff);
  }
  u32(v: number) {
    return this.u16((v >>> 16) & 0xffff).u16(v & 0xffff);
  }
  i32(v: number) {
    return this.u32(v >>> 0);
  }
  u64(v: number) {
    return this.u32(Math.floor(v / 2 ** 32)).u32(v >>> 0);
  }
  bytes(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]);
    return this;
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.parts.push(s.charCodeAt(i));
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

const full = (version: number, flags: number) => new W().u8(version).u24(flags);
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

function avcC(sps: Uint8Array[], pps: Uint8Array[], p: VideoParams): Uint8Array {
  const s = sps[0];
  const w = new W().u8(1).u8(s[1]).u8(s[2]).u8(s[3]).u8(0xff).u8(0xe0 | sps.length);
  for (const x of sps) w.u16(x.length).bytes(x);
  w.u8(pps.length);
  for (const x of pps) w.u16(x.length).bytes(x);
  if (![66, 77, 88].includes(s[1])) {
    w.u8(0xfc | p.chromaFormat).u8(0xf8 | (p.bitDepth - 8)).u8(0xf8 | (p.bitDepth - 8)).u8(0);
  }
  return box("avcC", w.done());
}

function hvcC(vps: Uint8Array[], sps: Uint8Array[], pps: Uint8Array[], p: HevcSpsInfo): Uint8Array {
  const w = new W()
    .u8(1)
    .u8((p.ptl.profileSpace << 6) | (p.ptl.tier << 5) | p.ptl.profileIdc)
    .u32(p.ptl.compat)
    .bytes(p.ptl.constraint)
    .u8(p.ptl.levelIdc)
    .u16(0xf000) // min_spatial_segmentation_idc 0
    .u8(0xfc) // parallelismType 0
    .u8(0xfc | p.chromaFormat)
    .u8(0xf8 | (p.bitDepth - 8))
    .u8(0xf8 | (p.bitDepth - 8))
    .u16(0) // avgFrameRate
    .u8((0 << 6) | ((p.maxSubLayersMinus1 + 1) << 3) | ((p.temporalIdNesting ? 1 : 0) << 2) | 3);
  const arrays: [number, Uint8Array[]][] = [
    [32, vps],
    [33, sps],
    [34, pps],
  ];
  w.u8(arrays.filter(([, a]) => a.length).length);
  for (const [t, a] of arrays) {
    if (!a.length) continue;
    w.u8(0x80 | t).u16(a.length);
    for (const x of a) w.u16(x.length).bytes(x);
  }
  return box("hvcC", w.done());
}

const TIMESCALE = 90000;
const TRACK = 1;

function initSegment(p: VideoParams, codecBox: Uint8Array, durationTicks: number, mediaStart: number): Uint8Array {
  const ftyp = box("ftyp", new W().str("isom").u32(0x200).str("isomiso6").str(p.codec === "h264" ? "avc1" : "hvc1").str("mp41").done());
  const mvhd = box(
    "mvhd",
    full(0, 0).u32(0).u32(0).u32(TIMESCALE).u32(durationTicks).u32(0x10000).u16(0x100).u16(0).u32(0).u32(0)
      .bytes(MATRIX.flatMap((m) => [m >>> 24, (m >>> 16) & 0xff, (m >>> 8) & 0xff, m & 0xff]))
      .bytes(new Uint8Array(24)).u32(TRACK + 1).done(),
  );
  const dispW = Math.round((p.width * p.sarW) / p.sarH);
  const tkhd = box(
    "tkhd",
    full(0, 3).u32(0).u32(0).u32(TRACK).u32(0).u32(durationTicks).u32(0).u32(0).u16(0).u16(0).u16(0).u16(0)
      .bytes(MATRIX.flatMap((m) => [m >>> 24, (m >>> 16) & 0xff, (m >>> 8) & 0xff, m & 0xff]))
      .u32(dispW * 0x10000).u32(p.height * 0x10000).done(),
  );
  const mdhd = box("mdhd", full(0, 0).u32(0).u32(0).u32(TIMESCALE).u32(durationTicks).u16(0x55c4).u16(0).done());
  const hdlr = box("hdlr", full(0, 0).u32(0).str("vide").u32(0).u32(0).u32(0).str("VideoHandler").u8(0).done());
  const vmhd = box("vmhd", full(0, 1).u16(0).u16(0).u16(0).u16(0).done());
  const dref = box("dref", full(0, 0).u32(1).done(), box("url ", full(0, 1).done()));
  const dinf = box("dinf", dref);
  const entry = box(
    p.codec === "h264" ? "avc1" : "hvc1",
    new W().bytes(new Uint8Array(6)).u16(1).bytes(new Uint8Array(16)).u16(p.width).u16(p.height)
      .u32(0x480000).u32(0x480000).u32(0).u16(1).bytes(new Uint8Array(32)).u16(0x18).u16(0xffff).done(),
    codecBox,
    ...(p.sarW !== p.sarH ? [box("pasp", new W().u32(p.sarW).u32(p.sarH).done())] : []),
  );
  const stsd = box("stsd", full(0, 0).u32(1).done(), entry);
  const empty = (t: string) => box(t, full(0, 0).u32(0).done());
  const stsz = box("stsz", full(0, 0).u32(0).u32(0).done());
  const stbl = box("stbl", stsd, empty("stts"), empty("stsc"), stsz, empty("stco"));
  const minf = box("minf", vmhd, dinf, stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  // Edit list: presentation starts at the first picture (media time `mediaStart`).
  const elst = box("elst", full(0, 0).u32(1).u32(durationTicks).u32(mediaStart).u16(1).u16(0).done());
  const trak = box("trak", tkhd, box("edts", elst), mdia);
  const mehd = box("mehd", full(0, 0).u32(durationTicks).done());
  const trex = box("trex", full(0, 0).u32(TRACK).u32(1).u32(0).u32(0).u32(0).done());
  const mvex = box("mvex", mehd, trex);
  return concat([ftyp, box("moov", mvhd, trak, mvex)]);
}

interface Sample {
  data: Uint8Array[]; // NAL units (no start codes)
  size: number; // bytes with 4-byte length prefixes
  dts: number;
  pts: number;
  duration: number;
  sync: boolean;
  /** An unpaired first field (H.264 field pictures). */
  field?: { frameNum: number; bottom: boolean };
}

function fragment(seq: number, samples: Sample[], baseDts: number): Uint8Array {
  // trun: data offset, duration, size, flags, composition offset (signed, version 1).
  const trunFlags = 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800;
  const build = (dataOffset: number) => {
    const tr = full(1, trunFlags).u32(samples.length).i32(dataOffset);
    for (const s of samples) {
      tr.u32(s.duration).u32(s.size).u32(s.sync ? 0x02000000 : 0x01010000).i32(s.pts - s.dts);
    }
    const traf = box(
      "traf",
      box("tfhd", full(0, 0x020000).u32(TRACK).done()), // default-base-is-moof
      box("tfdt", full(1, 0).u64(baseDts).done()),
      box("trun", tr.done()),
    );
    return box("moof", box("mfhd", full(0, 0).u32(seq).done()), traf);
  };
  const moofLen = build(0).length;
  const moof = build(moofLen + 8);
  let mdatLen = 8;
  for (const s of samples) mdatLen += s.size;
  const mdat = new Uint8Array(mdatLen);
  const dv = new DataView(mdat.buffer);
  dv.setUint32(0, mdatLen);
  mdat.set([0x6d, 0x64, 0x61, 0x74], 4);
  let o = 8;
  for (const s of samples) {
    for (const n of s.data) {
      dv.setUint32(o, n.length);
      mdat.set(n, o + 4);
      o += 4 + n.length;
    }
  }
  return concat([moof, mdat]);
}

// ------------------------------------------------------------------------------------- TS demux

export interface RemuxOptions {
  /** Frame duration in 90 kHz ticks for access units without a PTS (from Frame Time). Default 3003. */
  frameDuration90k?: number;
}

export interface RemuxResult {
  /** The init segment (ftyp+moov); it comes first in the file. */
  init: Uint8Array;
  /** Fragments not yet drained. */
  fragments: Uint8Array[];
  params: VideoParams;
  /** Video samples written. */
  frames: number;
  /** Presentation duration in seconds. */
  duration: number;
  /** Elementary streams dropped, e.g. "AC-3 audio". */
  dropped: string[];
  /** NAL units dropped because they belong to a non-base view or layer. */
  droppedNonBase: number;
  /** H.264 frame packing arrangement type (3 side by side, 4 top and bottom), if signalled. */
  framePacking: number | null;
}

export class RemuxError extends Error {}

const STREAM_NAMES: Record<number, string> = {
  0x02: "MPEG-2 video",
  0x03: "MPEG-1 audio",
  0x04: "MPEG-2 audio",
  0x0f: "AAC audio",
  0x11: "AAC audio",
  0x1b: "H.264 video",
  0x20: "H.264 MVC video (second view)",
  0x24: "HEVC video",
  0x80: "LPCM audio",
  0x81: "AC-3 audio",
  0x87: "E-AC-3 audio",
};

function streamName(type: number, descriptors: Uint8Array): string {
  // stream_type 0x06 (private PES) carries AC-3 with descriptor 0x6A, E-AC-3 with 0x7A.
  if (type === 0x06) {
    for (let i = 0; i + 1 < descriptors.length; i += 2 + descriptors[i + 1]) {
      if (descriptors[i] === 0x6a) return "AC-3 audio";
      if (descriptors[i] === 0x7a) return "E-AC-3 audio";
    }
    return "private data";
  }
  return STREAM_NAMES[type] ?? `stream type 0x${hex2(type)}`;
}

/** Does this look like an MPEG-2 Transport Stream (188- or 192-byte packets)? */
export function sniffTs(b: Uint8Array): 188 | 192 | 0 {
  for (const size of [188, 192] as const) {
    const off = size === 192 ? 4 : 0;
    let ok = b.length >= off + size * 2 + 1;
    for (let k = 0; ok && k < 3 && off + k * size < b.length; k++) ok = b[off + k * size] === 0x47;
    if (ok) return size;
  }
  return 0;
}

export class TsRemuxer {
  private carry = new Uint8Array(0);
  private packetSize: 188 | 192 | 0 = 0;
  private pmtPid = -1;
  private videoPid = -1;
  private videoType = 0;
  private others = new Map<number, string>();
  private pes: Uint8Array[] = [];
  private pesPts: number | null = null;
  private pesDts: number | null = null;
  // Elementary stream state
  private vps: Uint8Array[] = [];
  private sps: Uint8Array[] = [];
  private pps: Uint8Array[] = [];
  private params: VideoParams | HevcSpsInfo | null = null;
  private au: Uint8Array[] = [];
  private auHasVcl = false;
  private auSync = false;
  private auPts: number | null = null;
  private auDts: number | null = null;
  private auField: { frameNum: number; bottom: boolean } | null = null;
  private pendingTs: { pts: number | null; dts: number | null } | null = null;
  /** Samples not yet written to a fragment (the newest is kept: it may get a second field). */
  private samples: Sample[] = [];
  private out: Uint8Array[] = [];
  private seq = 1;
  private frames = 0;
  private dts0 = 0;
  /** Presentation time of the first picture shown (the reorder delay), in 90 kHz ticks. */
  private delay: number | null = null;
  private end = 0;
  private lastDuration: number;
  private framePacking: number | null = null;
  private droppedNonBase = 0;
  private lastTs = -1;
  private readonly frameDur: number;

  constructor(o: RemuxOptions = {}) {
    this.frameDur = Math.max(1, Math.round(o.frameDuration90k ?? 3003));
    this.lastDuration = this.frameDur;
  }

  /** Feeds Transport Stream bytes (any chunking). */
  push(chunk: Uint8Array) {
    let b = chunk;
    if (this.carry.length) b = concat([this.carry, chunk]);
    if (!this.packetSize) {
      this.packetSize = sniffTs(b);
      if (!this.packetSize) {
        if (b.length > 4096) throw new RemuxError("not an MPEG-2 Transport Stream");
        this.carry = b.slice();
        return;
      }
    }
    const size = this.packetSize;
    const off = size === 192 ? 4 : 0;
    let i = 0;
    while (i + size <= b.length) {
      if (b[i + off] !== 0x47) {
        // Lost sync: find the next sync byte.
        i++;
        continue;
      }
      this.packet(b.subarray(i + off, i + off + 188));
      i += size;
    }
    this.carry = b.slice(i);
  }

  private packet(p: Uint8Array) {
    const pusi = (p[1] & 0x40) !== 0;
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    const afc = (p[3] >> 4) & 3;
    let o = 4;
    if (afc === 2 || afc === 0) return; // adaptation only / reserved
    if (afc === 3) o += 1 + p[4];
    if (o >= 188) return;
    const payload = p.subarray(o);
    if (pid === 0) {
      if (pusi) this.pat(payload.subarray(1 + payload[0]));
    } else if (pid === this.pmtPid) {
      if (pusi) this.pmt(payload.subarray(1 + payload[0]));
    } else if (pid === this.videoPid) {
      if (pusi) {
        this.flushPes();
        this.pes = [payload.slice()];
      } else if (this.pes.length) this.pes.push(payload.slice());
    }
  }

  private pat(s: Uint8Array) {
    const len = ((s[1] & 0x0f) << 8) | s[2];
    for (let i = 8; i + 4 <= 3 + len - 4; i += 4) {
      const prog = (s[i] << 8) | s[i + 1];
      const pid = ((s[i + 2] & 0x1f) << 8) | s[i + 3];
      if (prog !== 0) {
        this.pmtPid = pid;
        return;
      }
    }
  }

  private pmt(s: Uint8Array) {
    const len = ((s[1] & 0x0f) << 8) | s[2];
    const end = Math.min(s.length, 3 + len - 4);
    const infoLen = ((s[10] & 0x0f) << 8) | s[11];
    for (let i = 12 + infoLen; i + 5 <= end; ) {
      const type = s[i];
      const pid = ((s[i + 1] & 0x1f) << 8) | s[i + 2];
      const esLen = ((s[i + 3] & 0x0f) << 8) | s[i + 4];
      const desc = s.subarray(i + 5, i + 5 + esLen);
      if ((type === 0x1b || type === 0x24) && this.videoPid < 0) {
        this.videoPid = pid;
        this.videoType = type;
      } else if (pid !== this.videoPid) this.others.set(pid, streamName(type, desc));
      i += 5 + esLen;
    }
  }

  private flushPes() {
    if (!this.pes.length) return;
    const b = concat(this.pes);
    this.pes = [];
    if (b.length < 9 || b[0] !== 0 || b[1] !== 0 || b[2] !== 1) return;
    const flags = b[7];
    const hlen = b[8];
    let pts: number | null = null, dts: number | null = null;
    const ts = (k: number) => (b[k] & 0x0e) * 2 ** 29 + b[k + 1] * 2 ** 22 + (b[k + 2] & 0xfe) * 2 ** 14 + b[k + 3] * 2 ** 7 + (b[k + 4] >> 1);
    if (flags & 0x80) pts = this.unwrap(ts(9));
    if ((flags & 0xc0) === 0xc0) dts = this.unwrap(ts(14));
    this.pendingTs = { pts, dts: dts ?? pts };
    for (const nal of splitAnnexB(b.subarray(9 + hlen))) this.nal(nal);
  }

  /** Unwraps the 33-bit timestamp so it stays near the previous one. */
  private unwrap(t: number): number {
    if (this.lastTs < 0) {
      this.lastTs = t;
      return t;
    }
    const wrap = 2 ** 33;
    let v = t + Math.round((this.lastTs - t) / wrap) * wrap;
    this.lastTs = v;
    return v;
  }

  private nal(n: Uint8Array) {
    if (!n.length) return;
    const hevc = this.videoType === 0x24;
    if (hevc) {
      if (n.length < 2) return;
      const type = (n[0] >> 1) & 0x3f;
      const layer = ((n[0] & 1) << 5) | (n[1] >> 3);
      if (layer > 0) {
        this.droppedNonBase++;
        return;
      }
      const vcl = type < 32;
      const startsAu = type === 35 || (this.auHasVcl && ((type >= 32 && type <= 34) || type === 39 || (type >= 41 && type <= 44) || (type >= 48 && type <= 55))) || (vcl && this.auHasVcl && n.length > 2 && (n[2] & 0x80) !== 0);
      if (startsAu) this.endAu();
      this.takeTs();
      if (type === 32) this.vps = this.upsertParam(this.vps, n);
      else if (type === 33) {
        this.sps = this.upsertParam(this.sps, n);
        this.params ??= parseHevcSps(n);
      } else if (type === 34) this.pps = this.upsertParam(this.pps, n);
      if (type === 35 || type === 36 || type === 37 || type === 38) return; // AUD, EOS, EOB, filler: not stored
      if (type >= 32 && type <= 34) return; // parameter sets live in hvcC
      this.au.push(n);
      if (vcl) {
        this.auHasVcl = true;
        if (type >= 16 && type <= 23) this.auSync = true;
      }
      return;
    }
    const type = n[0] & 0x1f;
    if (type === 14 || type === 15 || type === 20) {
      this.droppedNonBase++;
      return;
    }
    const vcl = type === 1 || type === 5;
    let field: { frameNum: number; bottom: boolean } | null = null;
    let firstMb = -1;
    if (vcl && this.params) {
      const h = this.sliceHeader(n);
      firstMb = h.firstMb;
      field = h.field;
    } else if (vcl) firstMb = new BitReader(unescapeRbsp(n.subarray(1, 8))).ue();
    const startsAu = type === 9 || (this.auHasVcl && (type === 6 || type === 7 || type === 8 || (type >= 13 && type <= 18))) || (vcl && this.auHasVcl && firstMb === 0);
    if (startsAu) this.endAu();
    this.takeTs();
    if (type === 7) {
      this.sps = this.upsertParam(this.sps, n);
      if (!this.params) this.params = parseAvcSps(n);
      return;
    }
    if (type === 8) {
      this.pps = this.upsertParam(this.pps, n);
      return;
    }
    if (type === 9 || type === 10 || type === 11 || type === 12) return; // AUD, end of seq/stream, filler
    if (type === 6 && this.framePacking === null) this.framePacking = avcFramePacking(n);
    this.au.push(n);
    if (vcl) {
      if (!this.auHasVcl) this.auField = field;
      this.auHasVcl = true;
      if (type === 5) this.auSync = true;
    }
  }

  private sliceHeader(n: Uint8Array): { firstMb: number; field: { frameNum: number; bottom: boolean } | null } {
    const p = this.params!;
    const r = new BitReader(unescapeRbsp(n.subarray(1, Math.min(n.length, 24))));
    try {
      const firstMb = r.ue();
      r.ue(); // slice_type
      r.ue(); // pps id
      if (p.separateColourPlane) r.u(2);
      const frameNum = r.u(p.log2MaxFrameNum ?? 4);
      if (p.frameMbsOnly) return { firstMb, field: null };
      if (r.u(1)) return { firstMb, field: { frameNum, bottom: r.u(1) === 1 } };
      return { firstMb, field: null };
    } catch {
      return { firstMb: 0, field: null };
    }
  }

  private upsertParam(list: Uint8Array[], n: Uint8Array): Uint8Array[] {
    if (list.some((x) => x.length === n.length && x.every((v, i) => v === n[i]))) return list;
    if (list.length >= 8) return list;
    return [...list, n.slice()];
  }

  /** The first NAL of an access unit takes the PES timestamps. */
  private takeTs() {
    if (this.pendingTs && !this.au.length) {
      this.auPts = this.pendingTs.pts;
      this.auDts = this.pendingTs.dts;
      this.pendingTs = null;
    }
  }

  private endAu() {
    if (!this.auHasVcl) {
      // Non-VCL units before the first slice stay with the next access unit.
      return;
    }
    let size = 0;
    for (const n of this.au) size += 4 + n.length;
    const prev = this.samples[this.samples.length - 1] as Sample | undefined;
    // The second field of a field pair joins the first field's sample (MP4 stores frames).
    const f = this.auField;
    if (prev?.field && f && f.frameNum === prev.field.frameNum && f.bottom !== prev.field.bottom) {
      prev.data.push(...this.au);
      prev.size += size;
      prev.field = undefined;
      prev.sync ||= this.auSync;
      this.resetAu();
      return;
    }
    const dts = this.auDts ?? (prev ? prev.dts + this.frameDur : 0);
    const pts = this.auPts ?? (this.auDts !== null ? this.auDts : prev ? dts + (prev.pts - prev.dts) : dts);
    const first = !prev && this.frames === 0;
    if (first) this.dts0 = dts;
    this.samples.push({ data: this.au, size, dts, pts, duration: 0, sync: this.auSync || first, field: f ?? undefined });
    this.resetAu();
    this.maybeEmit();
  }

  private resetAu() {
    this.au = [];
    this.auHasVcl = false;
    this.auSync = false;
    this.auPts = this.auDts = null;
    this.auField = null;
  }

  /** Writes pending samples [0, n) as one fragment; the sample after them gives the last duration. */
  private emit(n: number) {
    const s = this.samples.splice(0, n);
    const next = this.samples[0];
    for (let i = 0; i < s.length; i++) {
      const nd = i + 1 < s.length ? s[i + 1].dts : next?.dts;
      s[i].duration = nd !== undefined ? Math.max(1, nd - s[i].dts) : this.lastDuration;
      this.lastDuration = s[i].duration;
    }
    // Decode times start at 0. Presentation times keep the reorder delay (composition offsets
    // stay positive); the edit list in the init segment starts presentation at the first picture.
    for (const x of s) {
      x.dts -= this.dts0;
      x.pts -= this.dts0;
      this.end = Math.max(this.end, x.pts + x.duration);
    }
    if (this.delay === null) {
      this.delay = Infinity;
      for (const x of s) this.delay = Math.min(this.delay, x.pts);
      this.delay = Math.max(0, this.delay);
    }
    this.out.push(fragment(this.seq++, s, s[0].dts));
    this.frames += s.length;
  }

  /** After a sync sample (or 120 samples), the samples before it can be written. */
  private maybeEmit() {
    const s = this.samples;
    if (s.length > 1 && s[s.length - 1].sync) this.emit(s.length - 1);
    else if (s.length > 120) this.emit(120);
  }

  /** Fragments (moof+mdat) finished so far; they follow the init segment that finish() returns. */
  drain(): Uint8Array[] {
    const o = this.out;
    this.out = [];
    return o;
  }

  /** Ends the stream. The file is `init`, then every drained fragment, then `fragments`. */
  finish(): RemuxResult {
    if (this.packetSize === 0 && this.carry.length) throw new RemuxError("not an MPEG-2 Transport Stream");
    this.flushPes();
    this.endAu();
    if (this.videoPid < 0) throw new RemuxError("the Transport Stream has no H.264 or HEVC video stream");
    if (!this.params || !this.sps.length || !this.pps.length || (!this.samples.length && !this.frames)) throw new RemuxError("the video stream has no parameter sets or pictures");
    if (this.samples.length) this.emit(this.samples.length);
    const p = this.params;
    const codecBox = p.codec === "h264" ? avcC(this.sps, this.pps, p) : hvcC(this.vps, this.sps, this.pps, p as HevcSpsInfo);
    return {
      init: initSegment(p, codecBox, this.end - (this.delay ?? 0), this.delay ?? 0),
      fragments: this.drain(),
      params: p,
      frames: this.frames,
      duration: (this.end - (this.delay ?? 0)) / TIMESCALE,
      dropped: [...new Set(this.others.values())],
      droppedNonBase: this.droppedNonBase,
      framePacking: this.framePacking,
    };
  }
}
