// LRU of decoded images (raw canonical pixels, not RGBA) bounded by bytes.
//
// Keep decoded frames, not rendered RGBA: a 512² CT slice is 0.5 MiB raw versus 1 MiB RGBA,
// and window/level is applied by the renderer, so a cached slice never needs re-rendering on the
// CPU. Entries are DecodedImage (whole instances or frame ranges); the cost of an entry is
// pixels.byteLength.
import type { DecodedImage } from "./types";

export class FrameCache<K = string> {
  private map = new Map<K, DecodedImage>();
  private used = 0;

  constructor(public budgetBytes = 512 * 1024 * 1024) {}

  get bytes() { return this.used; }
  get size() { return this.map.size; }

  get(key: K): DecodedImage | undefined {
    const v = this.map.get(key);
    if (v) {
      // Re-insert: Map iteration order is insertion order, so the first key is least recent.
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  has(key: K) { return this.map.has(key); }

  set(key: K, img: DecodedImage) {
    const old = this.map.get(key);
    if (old) { this.used -= old.pixels.byteLength; this.map.delete(key); }
    this.map.set(key, img);
    this.used += img.pixels.byteLength;
    this.evict(key);
  }

  delete(key: K) {
    const old = this.map.get(key);
    if (old) { this.used -= old.pixels.byteLength; this.map.delete(key); }
  }

  clear() { this.map.clear(); this.used = 0; }

  /** Evict least-recently-used entries until within budget, never the entry just added. */
  private evict(keep: K) {
    for (const k of this.map.keys()) {
      if (this.used <= this.budgetBytes) break;
      if (k === keep) continue;
      this.delete(k);
    }
  }
}
