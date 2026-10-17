// Scope coverage at refresh: a subset, including a narrower interaction string, is allowed.
//   bun test/scopes.ts
import { scopeCovered } from "../src/scopes.ts";

const granted = ["launch/patient", "offline_access", "patient/ImagingStudy.rs", "patient/Patient.rs"];
const cases: [string, boolean][] = [
  ["patient/ImagingStudy.rs", true],
  ["patient/ImagingStudy.r", true],
  ["patient/ImagingStudy.s", true],
  ["patient/Patient.r", true],
  ["launch/patient", true],
  ["patient/ImagingStudy.rsc", false],
  ["patient/DiagnosticReport.r", false],
  ["patient/*.r", false],
  ["user/ImagingStudy.r", false],
  ["online_access", false],
];
let bad = 0;
for (const [s, want] of cases) {
  const got = scopeCovered(granted, s);
  if (got !== want) bad++;
  console.log(`${got === want ? "ok  " : "FAIL"} ${s}: ${got}`);
}
console.log(scopeCovered(["patient/*.rs"], "patient/ImagingStudy.r") ? "ok   patient/*.rs covers patient/ImagingStudy.r" : (bad++, "FAIL patient/*.rs"));
process.exit(bad ? 1 : 0);
