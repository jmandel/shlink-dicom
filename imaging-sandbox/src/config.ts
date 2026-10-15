// Runtime configuration, all from environment variables. See README.md.

import { resolve } from "node:path";

export interface ClientRegistration {
  client_id: string;
  redirect_uris: string[];
  name?: string;
}

export type EndpointMode = "external" | "contained" | "capability";

export interface Config {
  port: number;
  hostname: string;
  baseUrl: string; // public origin + optional path prefix, no trailing slash
  allowedOrigins: "*" | string[];
  datasetDir: string;
  testPatientsFile: string;
  accessTokenTtl: number; // seconds
  refreshTokenTtl: number; // seconds
  capabilityTtl: number; // seconds
  endpointMode: EndpointMode;
  clients: ClientRegistration[];
  openClients: boolean;
  introspectionKey: string;
  logRequests: boolean;
}

const here = import.meta.dir;

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}

function num(v: string | undefined, dflt: number): number {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const port = num(env.PORT, 3334);
  const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, "");
  const originsRaw = (env.ALLOWED_ORIGINS ?? "*").trim();
  const allowedOrigins = originsRaw === "*" ? "*" : originsRaw.split(/[\s,]+/).filter(Boolean).map((o) => o.replace(/\/+$/, ""));
  const mode = (env.ENDPOINT_MODE || "external") as EndpointMode;
  if (!["external", "contained", "capability"].includes(mode)) throw new Error(`ENDPOINT_MODE must be external, contained or capability (got ${mode})`);

  let clients: ClientRegistration[] = [
    {
      client_id: "shlink-dicom-share",
      name: "SHLink DICOM Share",
      redirect_uris: (env.SHARE_REDIRECT_URIS || "http://localhost:3000/share/smart-callback,http://127.0.0.1:3000/share/smart-callback")
        .split(/[\s,]+/)
        .filter(Boolean),
    },
  ];
  if (env.CLIENTS_JSON) clients = JSON.parse(env.CLIENTS_JSON);

  return {
    port,
    hostname: env.HOST || "0.0.0.0",
    baseUrl,
    allowedOrigins,
    datasetDir: resolve(env.DATASET_DIR || resolve(here, "../build/dataset")),
    testPatientsFile: resolve(env.TEST_PATIENTS_FILE || resolve(here, "../data/test-patients.json")),
    accessTokenTtl: num(env.ACCESS_TOKEN_TTL, 3600),
    refreshTokenTtl: num(env.REFRESH_TOKEN_TTL, 30 * 24 * 3600),
    capabilityTtl: num(env.CAPABILITY_TTL, 900),
    endpointMode: mode,
    clients,
    openClients: bool(env.OPEN_CLIENTS, true),
    introspectionKey: env.INTROSPECTION_KEY || crypto.randomUUID().replace(/-/g, ""),
    logRequests: bool(env.LOG_REQUESTS, true),
  };
}
