// Transfer syntaxes (PS3.5 §10, PS3.6 Annex A): names, which are lossless, which hold video, which
// carry native (uncompressed) pixel data. The one table the browser code reads.

export const TS = {
  ImplicitLE: "1.2.840.10008.1.2",
  ExplicitLE: "1.2.840.10008.1.2.1",
  Deflated: "1.2.840.10008.1.2.1.99",
  ExplicitBE: "1.2.840.10008.1.2.2",
  /** GE private: implicit VR little endian with big endian pixel data. */
  GEPrivate: "1.2.840.113619.5.2",
  RLE: "1.2.840.10008.1.2.5",
  JPEGBaseline: "1.2.840.10008.1.2.4.50",
  JPEGExtended: "1.2.840.10008.1.2.4.51",
  JPEGLossless: "1.2.840.10008.1.2.4.57",
  JPEGLosslessHierarchical: "1.2.840.10008.1.2.4.58",
  JPEGLosslessHierarchical28: "1.2.840.10008.1.2.4.65",
  JPEGLosslessHierarchical29: "1.2.840.10008.1.2.4.66",
  JPEGLosslessSV1: "1.2.840.10008.1.2.4.70",
  JPEGLSLossless: "1.2.840.10008.1.2.4.80",
  JPEGLSNearLossless: "1.2.840.10008.1.2.4.81",
  J2KLossless: "1.2.840.10008.1.2.4.90",
  J2K: "1.2.840.10008.1.2.4.91",
  J2KPart2Lossless: "1.2.840.10008.1.2.4.92",
  J2KPart2: "1.2.840.10008.1.2.4.93",
  JXLLossless: "1.2.840.10008.1.2.4.110",
  JXLJPEGRecompression: "1.2.840.10008.1.2.4.111",
  JXL: "1.2.840.10008.1.2.4.112",
  HTJ2KLossless: "1.2.840.10008.1.2.4.201",
  HTJ2KLosslessRPCL: "1.2.840.10008.1.2.4.202",
  HTJ2K: "1.2.840.10008.1.2.4.203",
} as const;

export interface SyntaxInfo {
  /** Plain name, e.g. "JPEG 2000 Lossless". */
  name: string;
  /** The family, for short summaries: "uncompressed", "JPEG", "JPEG 2000"… */
  family: string;
  /** Decoding gives back every stored value exactly. */
  lossless: boolean;
}

const S = (name: string, family: string, lossless: boolean): SyntaxInfo => ({ name, family, lossless });

export const SYNTAXES: Record<string, SyntaxInfo> = {
  [TS.ImplicitLE]: S("Implicit VR Little Endian (uncompressed)", "uncompressed", true),
  [TS.ExplicitLE]: S("Explicit VR Little Endian (uncompressed)", "uncompressed", true),
  [TS.ExplicitBE]: S("Explicit VR Big Endian (uncompressed)", "uncompressed", true),
  [TS.Deflated]: S("Deflated Explicit VR Little Endian", "deflated", true),
  [TS.GEPrivate]: S("GE private implicit VR (uncompressed)", "uncompressed", true),
  [TS.RLE]: S("RLE Lossless", "RLE", true),
  [TS.JPEGBaseline]: S("JPEG Baseline", "JPEG", false),
  [TS.JPEGExtended]: S("JPEG Extended", "JPEG", false),
  [TS.JPEGLossless]: S("JPEG Lossless", "JPEG lossless", true),
  [TS.JPEGLosslessHierarchical]: S("JPEG Lossless, hierarchical", "JPEG lossless", true),
  [TS.JPEGLosslessHierarchical28]: S("JPEG Lossless, hierarchical (process 28)", "JPEG lossless", true),
  [TS.JPEGLosslessHierarchical29]: S("JPEG Lossless, hierarchical (process 29)", "JPEG lossless", true),
  [TS.JPEGLosslessSV1]: S("JPEG Lossless, first-order prediction (SV1)", "JPEG lossless", true),
  [TS.JPEGLSLossless]: S("JPEG-LS Lossless", "JPEG-LS", true),
  [TS.JPEGLSNearLossless]: S("JPEG-LS near-lossless", "JPEG-LS", false),
  [TS.J2KLossless]: S("JPEG 2000 Lossless", "JPEG 2000", true),
  [TS.J2K]: S("JPEG 2000", "JPEG 2000", false),
  [TS.J2KPart2Lossless]: S("JPEG 2000 Part 2 Lossless", "JPEG 2000", true),
  [TS.J2KPart2]: S("JPEG 2000 Part 2", "JPEG 2000", false),
  [TS.JXLLossless]: S("JPEG XL Lossless", "JPEG XL", true),
  [TS.JXLJPEGRecompression]: S("JPEG XL JPEG Recompression", "JPEG XL", false),
  [TS.JXL]: S("JPEG XL", "JPEG XL", false),
  [TS.HTJ2KLossless]: S("HTJ2K Lossless", "HTJ2K", true),
  [TS.HTJ2KLosslessRPCL]: S("HTJ2K Lossless RPCL", "HTJ2K", true),
  [TS.HTJ2K]: S("HTJ2K", "HTJ2K", false),
};

/** Syntaxes whose Pixel Data is native (not encapsulated). */
export const NATIVE_SYNTAXES: ReadonlySet<string> = new Set([TS.ImplicitLE, TS.ExplicitLE, TS.ExplicitBE, TS.Deflated, TS.GEPrivate]);

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
