// bun test test/bundle.test.ts: the viewer's Bundle index (web/core/reader.ts parseIndex: the
// reader module) and the Share page's link subsetting (web/share/lib/pack.ts) on the golden Bundle
// of spec/README.md Appendix A.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EXT_LINKED_FILE } from "../web/core/bundle";
import { parseIndex } from "../web/core/reader";
import { subsetBundle } from "../web/share/lib/pack";
import { useShlWasm } from "../web/checks/shl-wasm-bun";

beforeAll(() => useShlWasm());

const golden = JSON.parse(readFileSync(new URL("../fixtures/golden/bundle.json", import.meta.url), "utf8"));
const copy = () => structuredClone(golden);
const study = (b: any) => b.entry.find((e: any) => e.resource.resourceType === "ImagingStudy").resource;
const vector = JSON.parse(readFileSync(new URL("../fixtures/golden/vector.json", import.meta.url), "utf8"));
const [A, B] = vector.files.map((f: any) => f.fileId);

describe("parseIndex", () => {
  test("study default file, series override, offsets per file", async () => {
    const st = (await parseIndex(golden)).studies[0];
    expect(st.series.map((s) => `${s.file.fileId}@${s.offset}+${s.bytes}`)).toEqual(vector.layout.map((l: any) => `${l.fileId}@${l.offset}+${l.length}`));
    expect(st.files.map((f) => [f.fileId, f.plaintextLength])).toEqual(vector.files.map((f: any) => [f.fileId, f.plaintextLength]));
    expect(st.series[1].file).toBe(st.files[0]);
    expect(new Set(st.series.map((s) => s.id)).size).toBe(3);
  });
  test("an instance length of 0 is rejected", async () => {
    const b = copy();
    study(b).series[0].instance[0].extension[0].valueDecimal = 0;
    await expect(parseIndex(b)).rejects.toThrow();
  });
  test("a series without instances is rejected", async () => {
    const b = copy();
    study(b).series[1].instance = [];
    await expect(parseIndex(b)).rejects.toThrow();
  });
  test("an ImagingStudy with a linked-file and no series is skipped", async () => {
    const b = copy();
    study(b).series = [];
    expect((await parseIndex(b)).studies.length).toBe(0);
  });
  test("a series-level linked-file giving the study's file another key is rejected", async () => {
    const b = copy();
    const s = study(b);
    // Every series that uses file A names it itself, with another key than the study gives.
    for (const se of s.series.slice(0, 2)) se.extension = [{ url: EXT_LINKED_FILE, extension: [{ url: "id", valueString: A }, { url: "key", valueString: s.series[2].extension[0].extension[1].valueString }] }];
    await expect(parseIndex(b)).rejects.toThrow();
  });
  test("a study-level linked-file no series uses names no file", async () => {
    const b = copy();
    study(b).series = [study(b).series[2]];
    expect((await parseIndex(b)).studies[0].files.map((f) => f.fileId)).toEqual([B]);
  });
});

describe("subsetBundle", () => {
  test("allows the files the series use, and drops a study-level key no series uses", async () => {
    const b = copy();
    study(b).series = [study(b).series[2]];
    const { bundle, allowedFiles } = subsetBundle(b, ["ct1"]);
    expect(allowedFiles).toEqual([`${B}.bin`]);
    expect(study(bundle).extension).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain(study(golden).extension[0].extension[1].valueString);
  });
  test("keeps the study's file and the override for the whole study", async () => {
    const { allowedFiles } = subsetBundle(copy(), ["ct1"]);
    expect(allowedFiles).toEqual([`${A}.bin`, `${B}.bin`]);
  });
});
