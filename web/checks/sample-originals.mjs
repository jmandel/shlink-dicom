// Runs sample-originals.py and returns its index; a failure throws the script's own message (for
// example "no sample archives under data/samples …") instead of the command line.
import { execFileSync } from "node:child_process";

const ROOT = new URL("../../", import.meta.url).pathname;

export function sampleOriginals(files = []) {
  try {
    return execFileSync("uv", ["run", "--project", `${ROOT}codec-corpus`, "python", `${ROOT}web/checks/sample-originals.py`, ...files], { maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (e) {
    throw new Error(String(e.stderr ?? "").trim().split("\n").pop() || e.message);
  }
}
