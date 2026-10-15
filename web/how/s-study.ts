// Step 4: the ImagingStudy for the MRI: the linked-file extension (key elided), and series 16
// with a few instance-length values, this slice's highlighted.
import { EXT_LINKED_FILE } from "../core/index";
import { code, excerpt, h, n, para, S } from "./state";

const isLength = (e: any) => /instance-length$/.test(e?.url ?? "");

export function mountStudy(pic: HTMLElement, exact: HTMLElement) {
  const raw = S.share!.index.bundle.entry.map((e: any) => e.resource).find((r: any) => r?.resourceType === "ImagingStudy" && r.id === S.study!.id);
  const linked = (raw.extension ?? []).find((e: any) => e.url === EXT_LINKED_FILE);
  const seIdx = raw.series.findIndex((s: any) => s.uid === S.series!.uid);
  const se = raw.series[seIdx];
  const len = (i: any) => (i.extension ?? []).find(isLength)?.valueDecimal;
  const k = S.slice;
  const instLine = (i: any, j: number) => `        { "number": ${i.number ?? j + 1}, "extension": [{ "url": "…/instance-length", "valueDecimal": ${len(i)} }] }`;
  const shown = [0, 1, k].filter((j, a, all) => all.indexOf(j) === a && j < se.instance.length);
  const instLines: string[] = [];
  shown.forEach((j, a) => {
    if (a > 0 && j > shown[a - 1] + 1) instLines.push(`        … ${j - shown[a - 1] - 1} more …`);
    instLines.push(instLine(se.instance[j], j) + ",");
  });
  if (se.instance.length - 1 > shown[shown.length - 1]) instLines.push(`        … ${se.instance.length - 1 - shown[shown.length - 1]} more`);
  const fileLines = linked
    ? [
        `  "extension": [{`,
        `    "url": "${linked.url}",`,
        `    "extension": [`,
        `      { "url": "id", "valueString": "${linked.extension.find((x: any) => x.url === "id")?.valueString}" },`,
        `      { "url": "key", "valueString": "… 43 characters, left out here" }`,
        `    ]`,
        `  }],`,
      ]
    : [];
  const text = [
    "{",
    `  "resourceType": "ImagingStudy",`,
    `  "id": "${raw.id}",`,
    ...fileLines,
    `  "description": ${JSON.stringify(raw.description)},`,
    `  "numberOfSeries": ${raw.numberOfSeries}, "numberOfInstances": ${raw.numberOfInstances},`,
    `  "series": [`,
    seIdx > 0 ? `    … ${seIdx} series before this one …` : "",
    `    { "number": ${se.number}, "description": ${JSON.stringify(se.description)}, "modality": { "code": "${se.modality?.code ?? ""}" },`,
    `      "instance": [`,
    ...instLines,
    `      ] },`,
    raw.series.length - 1 > seIdx ? `    … ${raw.series.length - 1 - seIdx} series after it` : "",
    `  ]`,
    "}",
  ].filter(Boolean);
  const inst = S.series!.instances[k];
  const sliceMark = new RegExp(`"number": ${se.instance[k].number ?? k + 1}, "extension"`);
  pic.replaceChildren(
    h("p", { class: "cap", text: `The MRI's ImagingStudy, trimmed to series ${se.number} and three of its ${se.instance.length} instances:` }),
    excerpt(text.join("\n"), [/"url": "id"/, sliceMark], "The ImagingStudy"),
    h(
      "p",
      { class: "cap" },
      `Instance ${k + 1} is this slice: ${n(inst.length)} bytes, starting at byte ${n(inst.offset)} of the encrypted file's contents. That is the sum of the instance-length values before it, through every earlier series in the file.`,
    ),
  );
  exact.replaceChildren(
    para("The ", code("linked-file"), " extension names one encrypted file for the whole study (", code("id"), ") and carries a key for that file alone (", code("key"), "). A series may carry its own ", code("linked-file"), " instead, for example a series added later. The link's key decrypts the Bundle; each file's key decrypts that file."),
    para("Instances are listed in the order their bytes appear in the file, so a client needs no other index: an instance's offset is the sum of the lengths before it. Here:"),
    h("pre", { class: "code wrap", text: `offset of instance ${k + 1} = ${n(inst.offset)}\nlength = ${n(inst.length)}\nlast byte = ${n(inst.offset + inst.length - 1)}\nthe file's contents = ${n(S.series!.file.plaintextLength)} bytes (the whole study)` }),
    para("Series ", String(se.number), ", in full:"),
    h("pre", { class: "code", text: JSON.stringify(se, null, 1) }),
  );
}
