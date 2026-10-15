// A DICOM Part 10 parser for the browser: the whole data set as a tree of elements, with typed
// accessors. Handles explicit and implicit VR little endian, explicit big endian, deflated data
// sets (async), sequences of defined and undefined length, and encapsulated pixel data.
// Values are not copied: accessors read from the file's bytes on demand.
//
//   const { ds, transferSyntax } = await parseDicom(bytes);
//   ds.str(T.Modality); ds.num(T.Rows); ds.seq(T.ContentSequence)[0].code(T.ConceptNameCodeSequence)
//
// In implicit VR files the VR comes from a small dictionary of the attributes this viewer reads;
// an unknown element whose value starts with an item tag is read as a sequence.

export const tag = (g: number, e: number) => ((g << 16) | e) >>> 0;
export const tagHex = (t: number) => `(${(t >>> 16).toString(16).padStart(4, "0").toUpperCase()},${(t & 0xffff).toString(16).padStart(4, "0").toUpperCase()})`;

/** Tags this code reads by name. */
export const T = {
  TransferSyntaxUID: tag(0x0002, 0x0010),
  SpecificCharacterSet: tag(0x0008, 0x0005),
  ImageType: tag(0x0008, 0x0008),
  SOPClassUID: tag(0x0008, 0x0016),
  SOPInstanceUID: tag(0x0008, 0x0018),
  StudyDate: tag(0x0008, 0x0020),
  ContentDate: tag(0x0008, 0x0023),
  StudyTime: tag(0x0008, 0x0030),
  AccessionNumber: tag(0x0008, 0x0050),
  ContentTime: tag(0x0008, 0x0033),
  Modality: tag(0x0008, 0x0060),
  Manufacturer: tag(0x0008, 0x0070),
  StudyDescription: tag(0x0008, 0x1030),
  SeriesDescription: tag(0x0008, 0x103e),
  ReferencedSeriesSequence: tag(0x0008, 0x1115),
  ReferencedImageSequence: tag(0x0008, 0x1140),
  ReferencedSOPClassUID: tag(0x0008, 0x1150),
  ReferencedSOPInstanceUID: tag(0x0008, 0x1155),
  ReferencedFrameNumber: tag(0x0008, 0x1160),
  ReferencedSegmentNumber: tag(0x0062, 0x000b),
  ReferencedInstanceSequence: tag(0x0008, 0x114a),
  ReferencedSOPSequence: tag(0x0008, 0x1199),
  SourceImageSequence: tag(0x0008, 0x2112),
  DerivationImageSequence: tag(0x0008, 0x9124),
  CodeValue: tag(0x0008, 0x0100),
  CodingSchemeDesignator: tag(0x0008, 0x0102),
  CodeMeaning: tag(0x0008, 0x0104),
  PatientName: tag(0x0010, 0x0010),
  FrameTime: tag(0x0018, 0x1063),
  FrameTimeVector: tag(0x0018, 0x1065),
  RecommendedDisplayFrameRate: tag(0x0008, 0x2144),
  CineRate: tag(0x0018, 0x0040),
  ImagerPixelSpacing: tag(0x0018, 0x1164),
  NominalScannedPixelSpacing: tag(0x0018, 0x2010),
  EstimatedRadiographicMagnificationFactor: tag(0x0018, 0x1114),
  SequenceOfUltrasoundRegions: tag(0x0018, 0x6011),
  StudyInstanceUID: tag(0x0020, 0x000d),
  SeriesInstanceUID: tag(0x0020, 0x000e),
  InstanceNumber: tag(0x0020, 0x0013),
  ImagePositionPatient: tag(0x0020, 0x0032),
  ImageOrientationPatient: tag(0x0020, 0x0037),
  FrameOfReferenceUID: tag(0x0020, 0x0052),
  DimensionIndexValues: tag(0x0020, 0x9157),
  PlanePositionSequence: tag(0x0020, 0x9113),
  PlaneOrientationSequence: tag(0x0020, 0x9116),
  FrameContentSequence: tag(0x0020, 0x9111),
  SamplesPerPixel: tag(0x0028, 0x0002),
  PhotometricInterpretation: tag(0x0028, 0x0004),
  PlanarConfiguration: tag(0x0028, 0x0006),
  NumberOfFrames: tag(0x0028, 0x0008),
  Rows: tag(0x0028, 0x0010),
  Columns: tag(0x0028, 0x0011),
  PixelSpacing: tag(0x0028, 0x0030),
  BitsAllocated: tag(0x0028, 0x0100),
  BitsStored: tag(0x0028, 0x0101),
  HighBit: tag(0x0028, 0x0102),
  PixelRepresentation: tag(0x0028, 0x0103),
  PixelSpacingCalibrationType: tag(0x0028, 0x0a02),
  PixelSpacingCalibrationDescription: tag(0x0028, 0x0a04),
  WindowCenter: tag(0x0028, 0x1050),
  WindowWidth: tag(0x0028, 0x1051),
  RescaleIntercept: tag(0x0028, 0x1052),
  RescaleSlope: tag(0x0028, 0x1053),
  RescaleType: tag(0x0028, 0x1054),
  WindowCenterWidthExplanation: tag(0x0028, 0x1055),
  VOILUTFunction: tag(0x0028, 0x1056),
  ICCProfile: tag(0x0028, 0x2000),
  ModalityLUTSequence: tag(0x0028, 0x3000),
  LUTDescriptor: tag(0x0028, 0x3002),
  LUTExplanation: tag(0x0028, 0x3003),
  ModalityLUTType: tag(0x0028, 0x3004),
  LUTData: tag(0x0028, 0x3006),
  VOILUTSequence: tag(0x0028, 0x3010),
  SoftcopyVOILUTSequence: tag(0x0028, 0x3110),
  PixelMeasuresSequence: tag(0x0028, 0x9110),
  FrameVOILUTSequence: tag(0x0028, 0x9132),
  PixelValueTransformationSequence: tag(0x0028, 0x9145),
  PresentationLUTShape: tag(0x2050, 0x0020),
  PresentationLUTSequence: tag(0x2050, 0x0010),
  SharedFunctionalGroupsSequence: tag(0x5200, 0x9229),
  PerFrameFunctionalGroupsSequence: tag(0x5200, 0x9230),
  ContentSequence: tag(0x0040, 0xa730),
  ConceptNameCodeSequence: tag(0x0040, 0xa043),
  ConceptCodeSequence: tag(0x0040, 0xa168),
  ValueType: tag(0x0040, 0xa040),
  RelationshipType: tag(0x0040, 0xa010),
  TextValue: tag(0x0040, 0xa160),
  DateTime: tag(0x0040, 0xa120),
  Date: tag(0x0040, 0xa121),
  Time: tag(0x0040, 0xa122),
  PersonName: tag(0x0040, 0xa123),
  UID: tag(0x0040, 0xa124),
  MeasuredValueSequence: tag(0x0040, 0xa300),
  NumericValue: tag(0x0040, 0xa30a),
  NumericValueQualifierCodeSequence: tag(0x0040, 0xa301),
  MeasurementUnitsCodeSequence: tag(0x0040, 0x08ea),
  GraphicData: tag(0x0070, 0x0022),
  GraphicType: tag(0x0070, 0x0023),
  ReferencedContentItemIdentifier: tag(0x0040, 0xdb73),
  ContinuityOfContent: tag(0x0040, 0xa050),
  CompletionFlag: tag(0x0040, 0xa491),
  VerificationFlag: tag(0x0040, 0xa493),
  CurrentRequestedProcedureEvidenceSequence: tag(0x0040, 0xa375),
  ContentTemplateSequence: tag(0x0040, 0xa504),
  TemplateIdentifier: tag(0x0040, 0xdb00),
  EncapsulatedDocument: tag(0x0042, 0x0011),
  MIMETypeOfEncapsulatedDocument: tag(0x0042, 0x0012),
  DocumentTitle: tag(0x0042, 0x0010),
  SegmentSequence: tag(0x0062, 0x0002),
  SegmentNumber: tag(0x0062, 0x0004),
  SegmentLabel: tag(0x0062, 0x0005),
  SegmentationType: tag(0x0062, 0x0001),
  SegmentedPropertyTypeCodeSequence: tag(0x0062, 0x000f),
  SegmentIdentificationSequence: tag(0x0062, 0x000a),
  RecommendedDisplayCIELabValue: tag(0x0062, 0x000d),
  MaximumFractionalValue: tag(0x0062, 0x000e),
  SegmentationFractionalType: tag(0x0062, 0x0010),
  RealWorldValueMappingSequence: tag(0x0040, 0x9096),
  RealWorldValueSlope: tag(0x0040, 0x9225),
  RealWorldValueIntercept: tag(0x0040, 0x9224),
  LUTLabel: tag(0x0040, 0x9210),
  RealWorldValueFirstValueMapped: tag(0x0040, 0x9216),
  RealWorldValueLastValueMapped: tag(0x0040, 0x9211),
  DoubleFloatRealWorldValueFirstValueMapped: tag(0x0040, 0x9214),
  DoubleFloatRealWorldValueLastValueMapped: tag(0x0040, 0x9213),
  StructureSetLabel: tag(0x3006, 0x0002),
  ReferencedFrameOfReferenceSequence: tag(0x3006, 0x0010),
  StructureSetROISequence: tag(0x3006, 0x0020),
  ROINumber: tag(0x3006, 0x0022),
  ROIName: tag(0x3006, 0x0026),
  ROIContourSequence: tag(0x3006, 0x0039),
  ReferencedROINumber: tag(0x3006, 0x0084),
  ROIDisplayColor: tag(0x3006, 0x002a),
  ContourSequence: tag(0x3006, 0x0040),
  ContourImageSequence: tag(0x3006, 0x0016),
  ContourGeometricType: tag(0x3006, 0x0042),
  ContourData: tag(0x3006, 0x0050),
  GraphicAnnotationSequence: tag(0x0070, 0x0001),
  GraphicLayer: tag(0x0070, 0x0002),
  BoundingBoxTopLeftHandCorner: tag(0x0070, 0x0010),
  BoundingBoxBottomRightHandCorner: tag(0x0070, 0x0011),
  AnchorPoint: tag(0x0070, 0x0014),
  AnchorPointVisibility: tag(0x0070, 0x0015),
  UnformattedTextValue: tag(0x0070, 0x0006),
  TextObjectSequence: tag(0x0070, 0x0008),
  GraphicObjectSequence: tag(0x0070, 0x0009),
  BoundingBoxAnnotationUnits: tag(0x0070, 0x0003),
  AnchorPointAnnotationUnits: tag(0x0070, 0x0004),
  GraphicAnnotationUnits: tag(0x0070, 0x0005),
  NumberOfGraphicPoints: tag(0x0070, 0x0021),
  GraphicFilled: tag(0x0070, 0x0024),
  ImageRotation: tag(0x0070, 0x0042),
  ImageHorizontalFlip: tag(0x0070, 0x0041),
  DisplayedAreaSelectionSequence: tag(0x0070, 0x005a),
  DisplayedAreaTopLeftHandCorner: tag(0x0070, 0x0052),
  DisplayedAreaBottomRightHandCorner: tag(0x0070, 0x0053),
  ContentLabel: tag(0x0070, 0x0080),
  ContentDescription: tag(0x0070, 0x0081),
  ShutterShape: tag(0x0018, 0x1600),
  ShutterLeftVerticalEdge: tag(0x0018, 0x1602),
  ShutterRightVerticalEdge: tag(0x0018, 0x1604),
  ShutterUpperHorizontalEdge: tag(0x0018, 0x1606),
  ShutterLowerHorizontalEdge: tag(0x0018, 0x1608),
  CenterOfCircularShutter: tag(0x0018, 0x1610),
  RadiusOfCircularShutter: tag(0x0018, 0x1612),
  VerticesOfThePolygonalShutter: tag(0x0018, 0x1620),
  ShutterPresentationValue: tag(0x0018, 0x1622),
  WaveformSequence: tag(0x5400, 0x0100),
  MultiplexGroupLabel: tag(0x003a, 0x0020),
  NumberOfWaveformChannels: tag(0x003a, 0x0005),
  NumberOfWaveformSamples: tag(0x003a, 0x0010),
  SamplingFrequency: tag(0x003a, 0x001a),
  ChannelDefinitionSequence: tag(0x003a, 0x0200),
  ChannelLabel: tag(0x003a, 0x0203),
  ChannelSourceSequence: tag(0x003a, 0x0208),
  ChannelSensitivity: tag(0x003a, 0x0210),
  ChannelSensitivityUnitsSequence: tag(0x003a, 0x0211),
  ChannelSensitivityCorrectionFactor: tag(0x003a, 0x0212),
  ChannelBaseline: tag(0x003a, 0x0213),
  WaveformBitsStored: tag(0x003a, 0x021a),
  WaveformOriginality: tag(0x003a, 0x0004),
  WaveformBitsAllocated: tag(0x5400, 0x1004),
  WaveformSampleInterpretation: tag(0x5400, 0x1006),
  WaveformData: tag(0x5400, 0x1010),
  PixelData: tag(0x7fe0, 0x0010),
  IconImageSequence: tag(0x0088, 0x0200),
  FloatPixelData: tag(0x7fe0, 0x0008),
  DoubleFloatPixelData: tag(0x7fe0, 0x0009),
} as const;

/** VRs of binary and sequence attributes this viewer reads, for implicit VR files. Text VRs are read as text. */
const IMPLICIT_VR: Record<number, string> = (() => {
  const m: Record<number, string> = {};
  const set = (vr: string, ...tags: number[]) => tags.forEach((t) => (m[t] = vr));
  set("US", T.SamplesPerPixel, T.Rows, T.Columns, T.BitsAllocated, T.BitsStored, T.HighBit, T.PixelRepresentation,
    T.NumberOfWaveformChannels, T.WaveformBitsAllocated, T.WaveformBitsStored, T.ReferencedSegmentNumber, T.SegmentNumber,
    T.MaximumFractionalValue, T.RecommendedDisplayCIELabValue, T.NumberOfGraphicPoints, T.ImageRotation,
    T.ShutterPresentationValue, T.LUTDescriptor, tag(0x0028, 0x0006), T.RealWorldValueFirstValueMapped, T.RealWorldValueLastValueMapped);
  set("UL", T.NumberOfWaveformSamples, T.ReferencedContentItemIdentifier, T.DimensionIndexValues);
  set("FL", T.GraphicData, T.BoundingBoxTopLeftHandCorner, T.BoundingBoxBottomRightHandCorner, T.AnchorPoint);
  set("SL", T.DisplayedAreaTopLeftHandCorner, T.DisplayedAreaBottomRightHandCorner);
  set("OB", T.EncapsulatedDocument, T.ICCProfile);
  set("OW", T.WaveformData, T.PixelData, tag(0x0028, 0x1201), tag(0x0028, 0x1202), tag(0x0028, 0x1203));
  set("US", tag(0x0028, 0x1101), tag(0x0028, 0x1102), tag(0x0028, 0x1103));
  set("FD", T.RealWorldValueSlope, T.RealWorldValueIntercept, T.DoubleFloatRealWorldValueFirstValueMapped, T.DoubleFloatRealWorldValueLastValueMapped);
  set("OF", T.FloatPixelData);
  set("OD", T.DoubleFloatPixelData);
  return m;
})();

/** Overlay groups (60xx, even) in implicit VR files. */
function overlayVr(g: number, e: number): string | undefined {
  if (g < 0x6000 || g > 0x601e || g & 1) return undefined;
  return ({ 0x0010: "US", 0x0011: "US", 0x0015: "IS", 0x0050: "SS", 0x0100: "US", 0x0102: "US", 0x3000: "OW" } as Record<number, string>)[e];
}

const LONG_VR = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"]);
const UNDEF = 0xffffffff;

export interface Element {
  tag: number;
  vr: string;
  /** Offset of the value in the bytes, and its length (undefined-length values: up to the delimiter). */
  offset: number;
  length: number;
  items?: DataSet[];
  /** Encapsulated pixel data: offsets/lengths of the fragments (the first is the Basic Offset Table). */
  fragments?: { offset: number; length: number }[];
}

export class DicomParseError extends Error {}

export class DataSet {
  readonly elements = new Map<number, Element>();
  constructor(
    readonly bytes: Uint8Array,
    readonly le: boolean,
    readonly explicit: boolean,
    private decoder: TextDecoder,
  ) {}

  has(t: number): boolean {
    return this.elements.has(t);
  }
  get(t: number): Element | undefined {
    return this.elements.get(t);
  }
  /** The value's bytes (a view, not a copy). */
  raw(t: number): Uint8Array | null {
    const e = this.elements.get(t);
    return e ? this.bytes.subarray(e.offset, e.offset + e.length) : null;
  }
  /** All values of a text attribute, split on backslash and trimmed. */
  strs(t: number): string[] {
    const r = this.raw(t);
    if (!r || r.length === 0) return [];
    const s = this.decoder.decode(r).replace(/[\0]+$/, "");
    const e = this.elements.get(t)!;
    // Texts that may contain backslashes are not multi-valued.
    if (e.vr === "LT" || e.vr === "ST" || e.vr === "UT") return [s.replace(/\s+$/, "")];
    return s.split("\\").map((x) => x.trim());
  }
  /** The first value of a text attribute, or null when absent or empty. */
  str(t: number): string | null {
    return this.strs(t)[0] || null;
  }
  /** Numbers: binary VRs read as such; IS/DS (and unknown text) parsed. */
  nums(t: number): number[] {
    const e = this.elements.get(t);
    if (!e) return [];
    const dv = new DataView(this.bytes.buffer, this.bytes.byteOffset + e.offset, e.length);
    const n = (size: number) => Math.floor(e.length / size);
    const out: number[] = [];
    switch (e.vr) {
      case "US": case "OW": for (let i = 0; i < n(2); i++) out.push(dv.getUint16(2 * i, this.le)); return out;
      case "SS": for (let i = 0; i < n(2); i++) out.push(dv.getInt16(2 * i, this.le)); return out;
      case "UL": case "OL": for (let i = 0; i < n(4); i++) out.push(dv.getUint32(4 * i, this.le)); return out;
      case "SL": for (let i = 0; i < n(4); i++) out.push(dv.getInt32(4 * i, this.le)); return out;
      case "FL": case "OF": for (let i = 0; i < n(4); i++) out.push(dv.getFloat32(4 * i, this.le)); return out;
      case "FD": case "OD": for (let i = 0; i < n(8); i++) out.push(dv.getFloat64(8 * i, this.le)); return out;
      case "AT": for (let i = 0; i < n(4); i++) out.push(tag(dv.getUint16(4 * i, this.le), dv.getUint16(4 * i + 2, this.le))); return out;
      case "OB": return Array.from(this.raw(t)!);
      case "UN": {
        // Implicit VR, not in the dictionary: text numbers if it reads as text.
        const r = this.raw(t)!;
        if (r.every((c) => c === 0 || (c >= 0x20 && c < 0x7f))) return this.strs(t).map(Number).filter((x) => Number.isFinite(x));
        return Array.from(r);
      }
      default:
        return this.strs(t).map(Number).filter((x) => Number.isFinite(x));
    }
  }
  num(t: number, k = 0): number | null {
    const v = this.nums(t)[k];
    return v === undefined || !Number.isFinite(v) ? null : v;
  }
  /** Items of a sequence (empty when absent). */
  seq(t: number): DataSet[] {
    const e = this.elements.get(t);
    if (!e) return [];
    if (!e.items) e.items = readItems(this.bytes, e.offset, e.offset + e.length, this.le, this.explicit, this.decoder, 1);
    return e.items;
  }
  /** First item of a code sequence as { value, scheme, meaning }. */
  code(t: number): Code | null {
    const it = this.seq(t)[0];
    return it ? codeOf(it) : null;
  }
}

export interface Code {
  value: string;
  scheme: string;
  meaning: string;
}

export function codeOf(ds: DataSet): Code {
  return {
    value: ds.str(T.CodeValue) ?? ds.str(tag(0x0008, 0x0119)) ?? ds.str(tag(0x0008, 0x0120)) ?? "",
    scheme: ds.str(T.CodingSchemeDesignator) ?? "",
    meaning: ds.str(T.CodeMeaning) ?? "",
  };
}

export interface ParsedDicom {
  meta: DataSet;
  ds: DataSet;
  transferSyntax: string;
}

/** Specific Character Set → TextDecoder label (PS3.3 C.12.1.1.2). With several values (ISO 2022 code extensions), the last one decides. */
const CHARSETS: Record<string, string> = {
  "ISO_IR 100": "windows-1252", "ISO 2022 IR 100": "windows-1252", "ISO_IR 101": "iso-8859-2", "ISO 2022 IR 101": "iso-8859-2",
  "ISO_IR 109": "iso-8859-3", "ISO_IR 110": "iso-8859-4", "ISO_IR 144": "iso-8859-5", "ISO 2022 IR 144": "iso-8859-5",
  "ISO_IR 127": "iso-8859-6", "ISO 2022 IR 127": "iso-8859-6", "ISO_IR 126": "iso-8859-7", "ISO 2022 IR 126": "iso-8859-7",
  "ISO_IR 138": "iso-8859-8", "ISO 2022 IR 138": "iso-8859-8", "ISO_IR 148": "windows-1254", "ISO 2022 IR 148": "windows-1254",
  "ISO_IR 203": "iso-8859-15", "ISO_IR 13": "shift_jis", "ISO 2022 IR 13": "shift_jis", "ISO 2022 IR 87": "iso-2022-jp",
  "ISO 2022 IR 159": "iso-2022-jp", "ISO_IR 166": "windows-874", "ISO 2022 IR 166": "windows-874", "ISO 2022 IR 149": "euc-kr",
  "ISO 2022 IR 58": "gb18030", "ISO_IR 192": "utf-8", GB18030: "gb18030", GBK: "gbk",
};

function decoderFor(charset: string[]): TextDecoder {
  const names = charset.map((c) => c.trim().toUpperCase()).filter(Boolean);
  const label = names.length ? CHARSETS[names[names.length - 1]] ?? "windows-1252" : "windows-1252";
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder("windows-1252");
  }
}

function readElements(
  ds: DataSet,
  b: Uint8Array,
  start: number,
  end: number,
  le: boolean,
  explicit: boolean,
  dec: TextDecoder,
  depth: number,
  stopAt?: number,
): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = start;
  while (p + 8 <= end) {
    const g = dv.getUint16(p, le), el = dv.getUint16(p + 2, le);
    const t = tag(g, el);
    if (g === 0xfffe) return p; // item/sequence delimiter: the caller handles it
    if (stopAt !== undefined && t >= stopAt) return p;
    let vr: string, len: number, vo: number;
    const vrc = String.fromCharCode(b[p + 4], b[p + 5]);
    if (explicit && /^[A-Z]{2}$/.test(vrc)) {
      vr = vrc;
      if (LONG_VR.has(vr)) {
        len = dv.getUint32(p + 8, le);
        vo = p + 12;
      } else {
        len = dv.getUint16(p + 6, le);
        vo = p + 8;
      }
    } else {
      vr = IMPLICIT_VR[t] ?? overlayVr(g, el) ?? (el === 0x0000 ? "UL" : "UN?");
      len = dv.getUint32(p + 4, le);
      vo = p + 8;
    }
    const e: Element = { tag: t, vr, offset: vo, length: len };
    if (len === UNDEF) {
      if (t === T.PixelData || t === T.FloatPixelData || vr === "OB" || vr === "OW") {
        // Encapsulated pixel data: fragments up to the sequence delimiter.
        e.fragments = [];
        let q = vo;
        while (q + 8 <= end) {
          const ig = dv.getUint16(q, le), ie = dv.getUint16(q + 2, le), il = dv.getUint32(q + 4, le);
          if (ig !== 0xfffe) throw new DicomParseError(`bad fragment at ${q}`);
          if (ie === 0xe0dd) { q += 8; break; }
          e.fragments.push({ offset: q + 8, length: il });
          q += 8 + il;
        }
        e.length = q - vo;
        e.vr = vr === "UN?" ? "OB" : vr;
        ds.elements.set(t, e);
        p = q;
        continue;
      }
      // A sequence of undefined length.
      e.vr = "SQ";
      const items: DataSet[] = [];
      let q = vo;
      while (q + 8 <= end) {
        const ig = dv.getUint16(q, le), ie = dv.getUint16(q + 2, le), il = dv.getUint32(q + 4, le);
        if (ig !== 0xfffe) throw new DicomParseError(`bad item in ${tagHex(t)}`);
        if (ie === 0xe0dd) { q += 8; break; }
        const item = new DataSet(b, le, explicit, dec);
        if (il === UNDEF) {
          const r = readElements(item, b, q + 8, end, le, explicit, dec, depth + 1);
          q = r + 8; // past the item delimiter
        } else {
          readElements(item, b, q + 8, q + 8 + il, le, explicit, dec, depth + 1);
          q += 8 + il;
        }
        items.push(item);
      }
      e.items = items;
      e.length = q - vo;
      ds.elements.set(t, e);
      p = q;
      continue;
    }
    if (vo + len > end) {
      // Truncated or mislabelled length: keep what is there and stop, as lenient readers do.
      e.length = Math.max(0, end - vo);
      ds.elements.set(t, e);
      return end;
    }
    if (vr === "UN?") {
      // Implicit VR, not in the dictionary: a sequence if the value starts with an item tag.
      const looksSeq = len >= 8 && dv.getUint16(vo, le) === 0xfffe && dv.getUint16(vo + 2, le) === 0xe000;
      e.vr = looksSeq ? "SQ" : "UN";
    }
    if (vr === "SQ" && depth > 32) throw new DicomParseError("sequences nested too deeply");
    ds.elements.set(t, e);
    p = vo + len;
  }
  return p;
}

function readItems(b: Uint8Array, start: number, end: number, le: boolean, explicit: boolean, dec: TextDecoder, depth: number): DataSet[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const items: DataSet[] = [];
  let q = start;
  while (q + 8 <= end) {
    const ig = dv.getUint16(q, le), ie = dv.getUint16(q + 2, le), il = dv.getUint32(q + 4, le);
    if (ig !== 0xfffe || ie !== 0xe000) break;
    const item = new DataSet(b, le, explicit, dec);
    if (il === UNDEF) q = readElements(item, b, q + 8, end, le, explicit, dec, depth + 1) + 8;
    else {
      readElements(item, b, q + 8, Math.min(end, q + 8 + il), le, explicit, dec, depth + 1);
      q += 8 + il;
    }
    items.push(item);
  }
  return items;
}

/** Raw deflate; padding after the end of the deflate stream (common in DICOM) is ignored. */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  for (let trim = 0; ; trim++) {
    try {
      return await inflateAll(data.subarray(0, data.length - trim));
    } catch (e) {
      if (trim >= 8 || data.length - trim <= 1) throw e;
    }
  }
}

async function inflateAll(data: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.length;
    }
  } catch (e) {
    if (!n) throw e;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Parses a Part 10 file (or, failing the preamble, a bare implicit VR little endian data set).
 * `untilPixelData` stops before Pixel Data, for header-only parsing.
 */
export async function parseDicom(bytes: Uint8Array, o: { untilPixelData?: boolean } = {}): Promise<ParsedDicom> {
  const r = parseDicomSync(bytes, { ...o, inflated: undefined });
  if (r.transferSyntax !== DEFLATED) return r;
  return parseDicomSync(bytes, { ...o, inflated: await inflate(bytes.subarray(r.metaEnd)) });
}

const DEFLATED = "1.2.840.10008.1.2.1.99";

/**
 * The synchronous parser. A deflated data set needs `inflated` (the inflated bytes after the
 * file meta); without it only the file meta is read.
 */
export function parseDicomSync(bytes: Uint8Array, o: { untilPixelData?: boolean; inflated?: Uint8Array } = {}): ParsedDicom & { metaEnd: number } {
  const stopAt = o.untilPixelData ? tag(0x7fe0, 0x0008) : undefined;
  const latin = new TextDecoder("windows-1252");
  const meta = new DataSet(bytes, true, true, latin);
  let start = 0;
  let ts = "1.2.840.10008.1.2";
  const preamble = bytes.length >= 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d;
  const metaAt0 = !preamble && bytes.length > 8 && bytes[0] === 0x02 && bytes[1] === 0x00;
  if (!preamble && !metaAt0 && bytes.length > 8 && /^[A-Z]{2}$/.test(String.fromCharCode(bytes[4], bytes[5]))) {
    ts = "1.2.840.10008.1.2.1"; // no meta, but explicit VR
  }
  if (preamble || metaAt0) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = preamble ? 132 : 0;
    while (p + 8 <= bytes.length && dv.getUint16(p, true) === 0x0002) {
      let vr = String.fromCharCode(bytes[p + 4], bytes[p + 5]);
      let len: number, vo: number;
      if (/^[A-Z]{2}$/.test(vr)) {
        const long = LONG_VR.has(vr);
        len = long ? dv.getUint32(p + 8, true) : dv.getUint16(p + 6, true);
        vo = p + (long ? 12 : 8);
      } else {
        // File meta written in implicit VR (not allowed, but it happens).
        vr = dv.getUint16(p + 2, true) === 0x0000 ? "UL" : "UI";
        len = dv.getUint32(p + 4, true);
        vo = p + 8;
      }
      if (vo + len > bytes.length) break;
      meta.elements.set(tag(0x0002, dv.getUint16(p + 2, true)), { tag: tag(0x0002, dv.getUint16(p + 2, true)), vr, offset: vo, length: len });
      p = vo + len;
    }
    start = p;
    ts = meta.str(T.TransferSyntaxUID) ?? ts;
  }
  const metaEnd = start;
  let body = bytes;
  if (ts === DEFLATED) {
    if (!o.inflated) return { meta, ds: new DataSet(bytes, true, true, latin), transferSyntax: ts, metaEnd };
    body = o.inflated;
    start = 0;
  }
  const le = ts !== "1.2.840.10008.1.2.2";
  const explicit = ts !== "1.2.840.10008.1.2";
  // Read Specific Character Set first, then the data set with the right text decoder.
  const probe = new DataSet(body, le, explicit, latin);
  readElements(probe, body, start, body.length, le, explicit, latin, 0, tag(0x0008, 0x0006));
  const dec = decoderFor(probe.strs(T.SpecificCharacterSet));
  const ds = new DataSet(body, le, explicit, dec);
  readElements(ds, body, start, body.length, le, explicit, dec, 0, stopAt);
  return { meta, ds, transferSyntax: ts, metaEnd };
}

/** Parses a header returned by a decode (`img.header`: the bytes before Pixel Data). */
export function parseHeader(bytes: Uint8Array): Promise<ParsedDicom> {
  return parseDicom(bytes, { untilPixelData: true });
}
