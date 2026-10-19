// The attributes a DICOMDIR and the Share page's grouping need, read from a Part 10 header
// (dicom.ts). Pixel data is not read; a truncated file is fine if the header is complete. A deflated
// data set (Deflated Explicit VR Little Endian) is inflated first, as far as the bytes given go.
import { parseDicom, T, tag } from "./dicom";

export interface DicomHeader {
  transferSyntax: string;
  sopClassUid: string;
  sopInstanceUid: string;
  patientName: string;
  patientId: string;
  /** Issuer of Patient ID (0010,0021). */
  patientIdIssuer: string;
  patientBirthDate: string;
  patientSex: string;
  studyDate: string;
  studyTime: string;
  accessionNumber: string;
  studyDescription: string;
  studyInstanceUid: string;
  studyId: string;
  referringPhysician: string;
  seriesInstanceUid: string;
  modality: string;
  seriesNumber: string;
  seriesDescription: string;
  instanceNumber: string;
  specificCharacterSet: string;
  /** Present only when a positive Number of Frames was actually read from the header. */
  numberOfFrames?: number;
}

export async function readDicomHeader(bytes: Uint8Array): Promise<DicomHeader> {
  if (bytes.length < 132 || bytes[128] !== 0x44 || bytes[129] !== 0x49 || bytes[130] !== 0x43 || bytes[131] !== 0x4d) {
    throw new Error("not a Part 10 file");
  }
  const { meta, ds, transferSyntax } = await parseDicom(bytes, { untilPixelData: true });
  const s = (t: number) => ds.str(t) ?? "";
  const frames = ds.num(T.NumberOfFrames);
  return {
    transferSyntax,
    sopClassUid: meta.str(tag(0x0002, 0x0002)) ?? s(T.SOPClassUID),
    sopInstanceUid: meta.str(tag(0x0002, 0x0003)) ?? s(T.SOPInstanceUID),
    patientName: s(T.PatientName),
    patientId: s(tag(0x0010, 0x0020)),
    patientIdIssuer: s(tag(0x0010, 0x0021)),
    patientBirthDate: s(tag(0x0010, 0x0030)),
    patientSex: s(tag(0x0010, 0x0040)),
    studyDate: s(T.StudyDate),
    studyTime: s(T.StudyTime),
    accessionNumber: s(tag(0x0008, 0x0050)),
    studyDescription: s(T.StudyDescription),
    studyInstanceUid: s(T.StudyInstanceUID),
    studyId: s(tag(0x0020, 0x0010)),
    referringPhysician: s(tag(0x0008, 0x0090)),
    seriesInstanceUid: s(T.SeriesInstanceUID),
    modality: s(T.Modality),
    seriesNumber: s(tag(0x0020, 0x0011)),
    seriesDescription: s(T.SeriesDescription),
    instanceNumber: s(T.InstanceNumber),
    specificCharacterSet: s(T.SpecificCharacterSet),
    ...(typeof frames === "number" && Number.isInteger(frames) && frames > 0 ? { numberOfFrames: frames } : {}),
  };
}
