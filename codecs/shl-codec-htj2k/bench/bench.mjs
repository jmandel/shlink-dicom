// wasm32 timing: node bench.mjs path/to/shl_htj2k_bench.wasm BENCH_DIR
import { readFileSync, readdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
const [wasmPath, dir] = process.argv.slice(2);
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const { memory, bench_alloc, bench_decode } = instance.exports;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".j2c")).sort()) {
  const cs = readFileSync(`${dir}/${f}`);
  const info = JSON.parse(readFileSync(`${dir}/${f.replace(/\.j2c$/, ".json")}`, "utf8"));
  const ptr = bench_alloc(cs.length);
  new Uint8Array(memory.buffer, ptr, cs.length).set(cs);
  const rgb = info.samples_per_pixel === 3 ? 1 : 0;
  for (const [codec, name] of [[0, "hayro"], [1, "oxideav"]]) {
    const call = () => bench_decode(codec, ptr, cs.length, info.rows, info.columns, info.samples_per_pixel,
      info.bits_allocated, info.bits_stored, info.pixel_representation, rgb);
    if (call() < 0n) { console.log(`${f.padEnd(28)} ${name.padEnd(8)} error`); continue; }
    const runs = cs.length > 2e6 ? 3 : 7, t = [];
    for (let i = 0; i < runs; i++) { const s = performance.now(); call(); t.push(performance.now() - s); }
    t.sort((a, b) => a - b);
    console.log(`${f.padEnd(28)} ${name.padEnd(8)} ${t[runs >> 1].toFixed(1).padStart(8)} ms`);
  }
}
