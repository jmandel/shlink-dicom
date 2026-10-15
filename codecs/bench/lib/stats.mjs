// Run-count rule and summary statistics, shared by every runner (Node, browser, report).

export const STAGES = ["total", "parse", "codec", "normalise"];

/** Measured runs: enough to fill budget_ms, within [min_runs, max_runs]; only 3 when one
 *  decode takes over 2 s (so a very slow codec cannot stall the whole run). */
export function runCount(estMs, o) {
  if (estMs > 2000) return 3;
  return Math.max(o.min_runs, Math.min(o.max_runs, Math.ceil(o.budget_ms / Math.max(estMs, 1e-3))));
}

export function quantile(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const k = (sorted.length - 1) * p, lo = Math.floor(k), hi = Math.ceil(k);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

/** runs: array of [total, parse, codec, normalise] in ms -> {stage: {p10, median, p90}} */
export function summarize(runs) {
  const out = {};
  STAGES.forEach((s, i) => {
    const xs = runs.map((r) => r[i]).sort((a, b) => a - b);
    out[s] = { p10: quantile(xs, 0.1), median: quantile(xs, 0.5), p90: quantile(xs, 0.9) };
  });
  return out;
}
