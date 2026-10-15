// SMART scope parsing (App Launch 2.x, with 1.0 compatibility).

export type Perm = "c" | "r" | "u" | "d" | "s";

export interface ResourceScope {
  raw: string;
  level: "patient" | "user" | "system";
  resource: string; // a resource type or "*"
  perms: Set<Perm>;
  query?: string; // SMART v2 granular scope parameters
}

const V2 = /^(c?r?u?d?s?)$/;

export function parseResourceScope(raw: string): ResourceScope | null {
  const m = raw.match(/^(patient|user|system)\/([A-Za-z]+|\*)\.([a-z*]+)(\?.*)?$/);
  if (!m) return null;
  const [, level, resource, permStr, query] = m;
  let perms: Perm[];
  if (permStr === "read") perms = ["r", "s"];
  else if (permStr === "write") perms = ["c", "u", "d"];
  else if (permStr === "*") perms = ["c", "r", "u", "d", "s"];
  else if (permStr && V2.test(permStr)) perms = permStr.split("") as Perm[];
  else return null;
  return { raw, level: level as ResourceScope["level"], resource, perms: new Set(perms), query: query?.slice(1) };
}

// Resource types this sandbox serves at patient level.
export const SERVED_RESOURCES = ["Patient", "DiagnosticReport", "ImagingStudy", "ServiceRequest", "Encounter", "Practitioner", "Organization"];

// Narrow a requested scope to what this read-only sandbox can grant.
// Returns the scope string to grant, or null to drop it.
export function grantableScope(raw: string): string | null {
  if (raw === "launch/patient" || raw === "offline_access" || raw === "online_access") return raw;
  const s = parseResourceScope(raw);
  if (!s || s.level !== "patient") return null; // no user/ or system/ access here
  if (s.query) return null; // granular (query-restricted) scopes are not supported
  if (s.resource !== "*" && !SERVED_RESOURCES.includes(s.resource)) return null;
  const v1 = /\.(read|write|\*)$/.test(raw);
  if (v1) {
    return s.perms.has("r") ? `patient/${s.resource}.read` : null;
  }
  const keep = ["r", "s"].filter((p) => s.perms.has(p as Perm)).join("");
  return keep ? `patient/${s.resource}.${keep}` : null;
}

export function scopeAllows(scopes: string[], resource: string, perm: Perm): boolean {
  for (const raw of scopes) {
    const s = parseResourceScope(raw);
    if (!s || s.level !== "patient" || s.query) continue;
    if ((s.resource === "*" || s.resource === resource) && s.perms.has(perm)) return true;
  }
  return false;
}

export function describeScope(raw: string): string {
  if (raw === "launch/patient") return "Know which patient you chose";
  if (raw === "offline_access") return "Keep access after you close the app (a refresh token)";
  if (raw === "online_access") return "Keep access while you are using the app (a refresh token)";
  const s = parseResourceScope(raw);
  if (!s) return raw;
  const what: Record<string, string> = {
    "*": "all of your records, including imaging",
    Patient: "your name and identifiers",
    DiagnosticReport: "your imaging reports",
    ImagingStudy: "your imaging studies and their images",
    ServiceRequest: "your imaging and pathology orders",
    Encounter: "your visits",
    Practitioner: "your clinicians' names",
    Organization: "the names of your care providers",
  };
  const verbs = s.perms.has("s") && s.perms.has("r") ? "Find and read" : s.perms.has("s") ? "Search" : "Read";
  return `${verbs} ${what[s.resource] ?? s.resource}`;
}
