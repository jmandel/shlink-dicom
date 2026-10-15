// What each instance in a study is, from its SOP Class UID (PS3.4 Annex B), and how the viewer
// shows it. Every SOP class maps to a kind; unknown ones are "other" (listed with a download).

export type ObjectKind =
  | "image" // pixel data shown in the slice viewer
  | "slide" // whole-slide microscopy (tiled viewer)
  | "video" // MPEG-2 / H.264 / HEVC encapsulated video
  | "sr" // structured report
  | "pdf"
  | "cda"
  | "seg" // segmentation (overlay)
  | "rtstruct" // RT structure set (overlay)
  | "pmap" // parametric map (image and overlay)
  | "pr" // presentation state
  | "ko" // key object selection
  | "waveform" // ECG, haemodynamic, audio…
  | "model" // STL, OBJ, MTL
  | "other";

interface SopInfo {
  kind: ObjectKind;
  name: string;
}

const P = "1.2.840.10008.5.1.4.1.1.";
const SOP: Record<string, SopInfo> = {};
const add = (kind: ObjectKind, entries: [string, string][]) => entries.forEach(([uid, name]) => (SOP[uid.startsWith("1.2.840.") ? uid : P + uid] = { kind, name }));

add("image", [
  ["1", "Computed radiography image"], ["1.1", "Digital X-ray image"], ["1.1.1", "Digital X-ray image"],
  ["1.2", "Mammography image"], ["1.2.1", "Mammography image"], ["1.3", "Intra-oral X-ray image"], ["1.3.1", "Intra-oral X-ray image"],
  ["2", "CT image"], ["2.1", "Enhanced CT image"], ["2.2", "Legacy converted enhanced CT image"],
  ["3.1", "Ultrasound multi-frame image"], ["6.1", "Ultrasound image"], ["6.2", "Enhanced ultrasound volume"],
  ["4", "MR image"], ["4.1", "Enhanced MR image"], ["4.3", "Enhanced MR colour image"], ["4.4", "Legacy converted enhanced MR image"],
  ["7", "Secondary capture image"], ["7.1", "Secondary capture image (1-bit)"], ["7.2", "Secondary capture image (8-bit)"],
  ["7.3", "Secondary capture image (16-bit)"], ["7.4", "Secondary capture image (colour)"],
  ["12.1", "X-ray angiographic image"], ["12.1.1", "Enhanced X-ray angiographic image"], ["12.2", "X-ray fluoroscopy image"],
  ["12.2.1", "Enhanced X-ray fluoroscopy image"], ["12.3", "X-ray angiographic bi-plane image"],
  ["13.1.1", "X-ray 3D angiographic image"], ["13.1.2", "X-ray 3D craniofacial image"], ["13.1.3", "Breast tomosynthesis image"],
  ["13.1.4", "Breast projection X-ray image (presentation)"], ["13.1.5", "Breast projection X-ray image (processing)"],
  ["14.1", "Intravascular OCT image (presentation)"], ["14.2", "Intravascular OCT image (processing)"],
  ["20", "Nuclear medicine image"], ["128", "PET image"], ["128.1", "Legacy converted enhanced PET image"], ["130", "Enhanced PET image"],
  ["481.1", "RT image"], ["481.2", "RT dose"],
  ["77.1.1", "Visible light endoscopic image"], ["77.1.2", "Visible light microscopic image"],
  ["77.1.3", "Visible light slide-coordinates microscopic image"], ["77.1.4", "Visible light photographic image"],
  ["77.1.5.1", "Ophthalmic photography (8-bit)"], ["77.1.5.2", "Ophthalmic photography (16-bit)"],
  ["77.1.5.4", "Ophthalmic tomography image"], ["77.1.5.5", "Wide-field ophthalmic photography (stereographic)"],
  ["77.1.5.6", "Wide-field ophthalmic photography (3D)"], ["77.1.5.7", "Ophthalmic OCT en face image"],
  ["77.1.5.8", "Ophthalmic OCT B-scan volume analysis"], ["77.1.7", "Dermoscopic photography image"],
  ["78.7", "Ophthalmic thickness map"], ["81.1", "Corneal topography map"],
  ["131", "Basic structured display"],
]);
add("slide", [["77.1.6", "Whole-slide microscopy image"]]);
add("video", [["77.1.1.1", "Video endoscopic image"], ["77.1.2.1", "Video microscopic image"], ["77.1.4.1", "Video photographic image"]]);
add("pmap", [["30", "Parametric map"]]);
add("seg", [["66.4", "Segmentation"], ["66.7", "Label map segmentation"], ["66.5", "Surface segmentation"]]);
add("rtstruct", [["481.3", "RT structure set"]]);
add("sr", [
  ["88.11", "Basic text report"], ["88.22", "Enhanced report"], ["88.33", "Comprehensive report"], ["88.34", "Comprehensive 3D report"],
  ["88.35", "Extensible report"], ["88.40", "Procedure log"], ["88.50", "Mammography CAD report"], ["88.65", "Chest CAD report"],
  ["88.67", "X-ray radiation dose report"], ["88.68", "Radiopharmaceutical radiation dose report"], ["88.69", "Colon CAD report"],
  ["88.70", "Implantation plan report"], ["88.71", "Acquisition context report"], ["88.72", "Simplified adult echo report"],
  ["88.73", "Patient radiation dose report"], ["88.74", "Planned imaging agent administration report"],
  ["88.75", "Performed imaging agent administration report"], ["88.76", "Enhanced X-ray radiation dose report"],
]);
add("ko", [["88.59", "Key object selection"]]);
add("pdf", [["104.1", "Encapsulated PDF"]]);
add("cda", [["104.2", "Encapsulated CDA"]]);
add("model", [["104.3", "Encapsulated STL"], ["104.4", "Encapsulated OBJ"], ["104.5", "Encapsulated MTL"]]);
add("pr", [
  ["11.1", "Grayscale presentation state"], ["11.2", "Colour presentation state"], ["11.3", "Pseudo-colour presentation state"],
  ["11.4", "Blending presentation state"], ["11.5", "XA/XRF grayscale presentation state"], ["11.6", "Grayscale planar MPR presentation state"],
  ["11.7", "Compositing planar MPR presentation state"], ["11.8", "Advanced blending presentation state"],
  ["11.9", "Volume rendering presentation state"], ["11.10", "Segmented volume rendering presentation state"],
  ["11.11", "Multiple volume rendering presentation state"], ["11.12", "Variable modality LUT presentation state"],
]);
add("waveform", [
  ["9.1.1", "12-lead ECG"], ["9.1.2", "General ECG"], ["9.1.3", "Ambulatory ECG"], ["9.1.4", "General 32-bit ECG"],
  ["9.2.1", "Haemodynamic waveform"], ["9.3.1", "Cardiac electrophysiology waveform"], ["9.4.1", "Basic voice audio"],
  ["9.4.2", "General audio waveform"], ["9.5.1", "Arterial pulse waveform"], ["9.6.1", "Respiratory waveform"],
  ["9.6.2", "Multi-channel respiratory waveform"], ["9.7.1", "Routine scalp EEG"], ["9.7.2", "EMG"], ["9.7.3", "EOG"],
  ["9.7.4", "Sleep EEG"], ["9.8.1", "Body position waveform"],
]);
add("other", [
  ["481.4", "RT beams treatment record"], ["481.5", "RT plan"], ["481.6", "RT brachy treatment record"],
  ["481.7", "RT treatment summary record"], ["481.8", "RT ion plan"], ["481.9", "RT ion beams treatment record"],
  ["4.2", "MR spectroscopy"], ["66", "Raw data"], ["66.1", "Spatial registration"], ["66.2", "Spatial fiducials"], ["66.3", "Deformable spatial registration"],
  ["66.6", "Tractography results"], ["67", "Real world value mapping"], ["68.1", "Surface scan mesh"], ["68.2", "Surface scan point cloud"],
  ["77.1.5.3", "Stereometric relationship"], ["78.1", "Lensometry measurements"], ["78.2", "Autorefraction measurements"],
  ["79.1", "Macular grid thickness and volume report"], ["80.1", "Ophthalmic visual field static perimetry measurements"],
  ["82.1", "Ophthalmic axial measurements"], ["90.1", "Content assessment results"], ["200.1", "CT defined procedure protocol"],
  ["200.2", "CT performed procedure protocol"], ["91.1", "Microscopy bulk simple annotations"],
]);

const DICOMDIR = "1.2.840.10008.1.3.10";

/** Kind and plain name of a SOP class; unknown classes are "other". */
export function sopInfo(sopClassUid: string): SopInfo {
  const known = SOP[sopClassUid];
  if (known) return known;
  if (sopClassUid === DICOMDIR) return { kind: "other", name: "Media directory (DICOMDIR)" };
  if (sopClassUid.startsWith("1.2.840.10008.5.1.4.1.1.88.")) return { kind: "sr", name: "Structured report" };
  if (sopClassUid.startsWith("1.2.840.10008.5.1.4.1.1.9.")) return { kind: "waveform", name: "Waveform" };
  if (sopClassUid.startsWith("1.2.840.10008.5.1.4.1.1.11.")) return { kind: "pr", name: "Presentation state" };
  return { kind: "other", name: sopClassUid ? `Object of class ${sopClassUid}` : "Object of unknown class" };
}

/** A series' kind: the kind of its instances (a mixed series takes the first non-image kind). */
export function seriesKind(sopClasses: string[]): ObjectKind {
  const kinds = sopClasses.map((c) => sopInfo(c).kind);
  return kinds.find((k) => k !== "image") ?? "image";
}

/** Plain plural label for a kind, for overview counts. */
export const KIND_LABEL: Record<ObjectKind, [string, string]> = {
  image: ["image", "images"],
  slide: ["slide", "slides"],
  video: ["video", "videos"],
  sr: ["report", "reports"],
  pdf: ["PDF", "PDFs"],
  cda: ["clinical document", "clinical documents"],
  seg: ["segmentation", "segmentations"],
  rtstruct: ["structure set", "structure sets"],
  pmap: ["parametric map", "parametric maps"],
  pr: ["presentation state", "presentation states"],
  ko: ["key image list", "key image lists"],
  waveform: ["waveform", "waveforms"],
  model: ["3D model", "3D models"],
  other: ["other object", "other objects"],
};
