// Validates the sandbox's FHIR output with the HL7 FHIR validator against
// the SMART Imaging Access IG package (current CI build).
//
//   bun test/validate.ts
//
// Needs Java 17+ and the validator jar (VALIDATOR_JAR, default below). The
// IG package is downloaded to test/.work/ on first run. Set TX=n/a to skip
// the terminology server.

import { mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { startSandbox } from "../src/server.ts";
import { launchViaForms } from "./launch.ts";

const HERE = import.meta.dir;
const WORK = join(HERE, ".work", "validate");
const PKG = join(HERE, ".work", "smart-imaging-package.tgz");
const JAR = process.env.VALIDATOR_JAR ?? "/home/jmandel/hobby/ehi-to-fhir/tools/validator_cli.jar";
const IG_PKG_URL = "https://build.fhir.org/ig/argonautproject/smart-imaging/package.tgz";

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
if (!existsSync(PKG)) {
  const r = await fetch(IG_PKG_URL);
  if (!r.ok) throw new Error(`download ${IG_PKG_URL}: ${r.status}`);
  writeFileSync(PKG, new Uint8Array(await r.arrayBuffer()));
}

const files: string[] = [];
const save = (name: string, body: unknown) => {
  const f = join(WORK, `${name}.json`);
  writeFileSync(f, JSON.stringify(body, null, 2));
  files.push(f);
};

let port = 3371;
for (const mode of ["external", "contained", "capability"]) {
  const base = `http://localhost:${port}`;
  const sb = await startSandbox({ PORT: String(port++), BASE_URL: base, LOG_REQUESTS: "0", ENDPOINT_MODE: mode });
  const { d, token } = await launchViaForms(base, { scope: "launch/patient patient/*.rs" });
  const get = async (u: string) => (await fetch(u, { headers: { authorization: `Bearer ${token.access_token}` } })).json();
  const bundle = await get(`${d.imagingBase}/ImagingStudy?patient=${token.patient}&_include=ImagingStudy:endpoint`);
  save(`Bundle-search-${mode}`, bundle);
  if (mode === "external") {
    for (const e of bundle.entry) save(`${e.resource.resourceType}-${e.resource.id}`, e.resource);
    save("Patient", await get(`${d.clinicalBase}/Patient/${token.patient}`));
    const reports = await get(`${d.clinicalBase}/DiagnosticReport?patient=${token.patient}`);
    save("Bundle-DiagnosticReport", reports);
    save("CapabilityStatement-clinical", await get(`${d.clinicalBase}/metadata`));
    for (const t of ["ServiceRequest", "Encounter"]) save(`Bundle-${t}`, await get(`${d.clinicalBase}/${t}?patient=${token.patient}`));
    const enc = await get(`${d.clinicalBase}/Encounter?patient=${token.patient}`);
    const prac = new Set<string>(), orgs = new Set<string>();
    for (const e of enc.entry) { orgs.add(e.resource.serviceProvider.reference); for (const p of e.resource.participant ?? []) prac.add(p.individual.reference); }
    const reps = await get(`${d.clinicalBase}/DiagnosticReport?patient=${token.patient}`);
    for (const e of reps.entry) for (const p of e.resource.resultsInterpreter ?? []) prac.add(p.reference);
    for (const ref of [...prac, ...orgs]) save(ref.replace("/", "-"), await get(`${d.clinicalBase}/${ref}`));
    save("CapabilityStatement-imaging", await get(`${d.imagingBase}/metadata`));
  }
  if (mode === "contained") save("ImagingStudy-contained", bundle.entry[0].resource);
  sb.server.stop(true);
}

const cmd = ["java", "-jar", JAR, "-version", "4.0.1", "-ig", PKG, "-tx", process.env.TX ?? "https://tx.fhir.org", "-output", join(WORK, "outcome.json"), ...files];
console.log(`validating ${files.length} resources with ${JAR}`);
const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
const out = p.stdout.toString();
writeFileSync(join(WORK, "validator.log"), out + p.stderr.toString());
// Print the per-file summaries and every non-information message.
for (const line of out.split("\n")) {
  if (/^(-- |Success|\*FAILURE\*|  (Error|Warning) )/.test(line) || /Done\. Times/.test(line)) console.log(line);
}
console.log(`\nfull log: ${resolve(WORK, "validator.log")}`);
process.exit(p.exitCode ?? 1);
