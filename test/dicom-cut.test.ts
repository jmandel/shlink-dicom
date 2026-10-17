// bun test test/dicom-cut.test.ts: headers cut at every byte. Each reader of the start of a file
// either succeeds or asks for more bytes (or calls the bytes malformed); it never throws anything
// else (a RangeError from reading past the end, say). Real headers: an enhanced CT with a large
// Per-Frame Functional Groups Sequence, an enhanced MR, an ultrasound cine and a slide level.
// The files are local test data (DICOM_CUT_FILES, colon-separated, overrides the list); missing
// ones are skipped. The enhanced CT's 147 KB header takes about half an hour (four readers, each
// about 3 ms a parse): it runs with DICOM_CUT_LONG=1.
import { describe, expect, test } from "bun:test";
import { existsSync, openSync, readSync, statSync } from "node:fs";
import { headerEnd } from "../viewer-kit/src/header-end";
import { DicomParseError, NeedMoreBytes, parseDicomSync } from "../web/core/dicom";
import { MediaHeaderError, NeedMore, parseMediaHeader } from "../web/core/video";
import { parseSlideHeader, SlideHeaderError } from "../web/core/wsi";

const LONG = ["/media/barracuda/sop-sweep/extra/enh-ct-nema-ct0070/1.dcm"];
const FILES = (process.env.DICOM_CUT_FILES ?? [
  ...(process.env.DICOM_CUT_LONG ? LONG : []),
  "/media/barracuda/sop-sweep/extra/enh-mr-orthanc-issue22/1.dcm",
  "/media/barracuda/sop-sweep/dl/1.3.6.1.4.1.14519.5.2.1.207534918351073936173410777062742404217/3033325b-9298-451e-8b18-8f351655d4cd.dcm",
  "/media/barracuda/shlink-dicom-slides/dl/29368d94-3a65-4fdc-a796-9b1a48540c67/501501ef-c302-40cc-86eb-dbe125284b92.dcm",
].join(":")).split(":");

/** The file's first bytes: its header and a little of Pixel Data. */
function head(path: string): Uint8Array {
  const n = Math.min(statSync(path).size, 8 << 20);
  const b = new Uint8Array(n);
  readSync(openSync(path, "r"), b, 0, n, 0);
  return b.slice(0, Math.min(n, headerEnd(b) + 64));
}

const allowed = (e: unknown, ...kinds: Function[]) => kinds.some((k) => e instanceof k);

describe("headers cut at every byte", () => {
  for (const path of FILES) {
    const present = existsSync(path) && statSync(path).isFile();
    test.skipIf(!present)(path.split("/").slice(-2).join("/"), () => {
      const b = head(path);
      const bad: string[] = [];
      for (let n = 0; n <= b.length; n++) {
        const cut = b.subarray(0, n);
        for (const [name, run, kinds] of [
          ["parseDicomSync need", () => parseDicomSync(cut, { untilPixelData: true, need: true }), [DicomParseError, NeedMoreBytes]],
          ["parseDicomSync", () => parseDicomSync(cut, { untilPixelData: true }), [DicomParseError]],
          ["parseSlideHeader", () => parseSlideHeader(cut, { partial: true }), [DicomParseError, NeedMoreBytes, SlideHeaderError]],
          ["parseMediaHeader", () => parseMediaHeader(cut), [NeedMore, MediaHeaderError]],
        ] as [string, () => unknown, Function[]][]) {
          try {
            run();
          } catch (e) {
            if (!allowed(e, ...kinds)) bad.push(`${name} at ${n}: ${(e as Error).name}: ${(e as Error).message}`);
          }
        }
        if (bad.length > 5) break;
      }
      expect(bad).toEqual([]);
      // Whole, the media reader finds Pixel Data.
      expect(() => parseMediaHeader(b)).not.toThrow();
    }, 3_600_000);
  }
});
