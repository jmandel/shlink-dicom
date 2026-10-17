// bun test test/bundle.test.ts: the viewer's Bundle parser (web/core/bundle.ts) and the Share page's
// link subsetting (web/share/lib/pack.ts) on the golden Bundle of spec/README.md Appendix A.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EXT_LINKED_FILE, parseStudyIndex } from "../web/core/bundle";
import { subsetBundle } from "../web/share/lib/pack";
import { useShlWasm } from "../web/checks/shl-wasm-bun";

beforeAll(() => useShlWasm());

const golden = JSON.parse(readFileSync(new URL("../fixtures/golden/bundle.json", import.meta.url), "utf8"));
const copy = () => structuredClone(golden);
const study = (b: any) => b.entry.find((e: any) => e.resource.resourceType === "ImagingStudy").resource;
const A = "AAECAwQFBgcICQoLDA0ODw", B = "EBESExQVFhcYGRobHB0eHw";

describe("parseStudyIndex", () => {
  test("study default file, series override, offsets per file", () => {
    const st = parseStudyIndex(golden).studies[0];
    expect(st.series.map((s) => `${s.file.fileId}@${s.offset}+${s.bytes}`)).toEqual([`${A}@0+70000`, `${A}@70000+80000`, `${B}@0+20000`]);
    expect(st.files.map((f) => [f.fileId, f.plaintextLength])).toEqual([[A, 150000], [B, 20000]]);
    expect(st.series[1].file).toBe(st.files[0]);
    expect(new Set(st.series.map((s) => s.id)).size).toBe(3);
  });
  test("an instance length of 0 is rejected", () => {
    const b = copy();
    study(b).series[0].instance[0].extension[0].valueDecimal = 0;
    expect(() => parseStudyIndex(b)).toThrow();
  });
  test("a series without instances is rejected", () => {
    const b = copy();
    study(b).series[1].instance = [];
    expect(() => parseStudyIndex(b)).toThrow();
  });
  test("an ImagingStudy with a linked-file and no series is skipped", () => {
    const b = copy();
    study(b).series = [];
    expect(parseStudyIndex(b).studies.length).toBe(0);
  });
  test("a series-level linked-file giving the study's file another key is rejected", () => {
    const b = copy();
    const s = study(b);
    // Every series that uses file A names it itself, with another key than the study gives.
    for (const se of s.series.slice(0, 2)) se.extension = [{ url: EXT_LINKED_FILE, extension: [{ url: "id", valueString: A }, { url: "key", valueString: s.series[2].extension[0].extension[1].valueString }] }];
    expect(() => parseStudyIndex(b)).toThrow();
  });
  test("a study-level linked-file no series uses names no file", () => {
    const b = copy();
    study(b).series = [study(b).series[2]];
    expect(parseStudyIndex(b).studies[0].files.map((f) => f.fileId)).toEqual([B]);
  });
});

describe("subsetBundle", () => {
  test("allows the files the series use, and drops a study-level key no series uses", () => {
    const b = copy();
    study(b).series = [study(b).series[2]];
    const { bundle, allowedFiles } = subsetBundle(b, ["ct1"]);
    expect(allowedFiles).toEqual([`${B}.bin`]);
    expect(study(bundle).extension).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain(study(golden).extension[0].extension[1].valueString);
  });
  test("keeps the study's file and the override for the whole study", () => {
    const { allowedFiles } = subsetBundle(copy(), ["ct1"]);
    expect(allowedFiles).toEqual([`${A}.bin`, `${B}.bin`]);
  });
});
