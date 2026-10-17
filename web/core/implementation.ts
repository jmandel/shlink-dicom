// shlink-dicom's identity in the files it writes: (0002,0012) Implementation Class UID and
// (0002,0013) Implementation Version Name. The source of truth is the Rust transcoder,
// codecs/shl-dicom-transcode/src/lib.rs (IMPLEMENTATION_CLASS_UID, IMPLEMENTATION_VERSION_NAME*);
// re-encoded files already carry these values.

/** (0002,0012) of every file shlink-dicom writes. */
export const IMPLEMENTATION_CLASS_UID = "2.25.222098624467184222580709298353105703221";
/** (0002,0013) of a file re-encoded as JPEG Lossless SV1. */
export const IMPLEMENTATION_VERSION_NAME_SV1 = "SHLDICOM_SV1_1";
/** (0002,0013) of a file re-encoded as JPEG 2000 Lossless. */
export const IMPLEMENTATION_VERSION_NAME_J2K = "SHLDICOM_J2K_1";
/** (0002,0013) of a DICOMDIR written by the downloads (export.ts), in the same naming. */
export const IMPLEMENTATION_VERSION_NAME_DICOMDIR = "SHLDICOM_DIR_1";
