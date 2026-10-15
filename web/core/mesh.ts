// Surface meshes from Encapsulated STL and OBJ (with MTL colours): triangles as flat arrays with
// per-face normals, for the 3D view.

export interface Mesh {
  /** x,y,z per vertex, three vertices per triangle. */
  positions: Float32Array;
  normals: Float32Array;
  /** r,g,b per vertex (0–1), or null for a single colour. */
  colors: Float32Array | null;
  triangles: number;
  min: [number, number, number];
  max: [number, number, number];
}

function finish(pos: number[], col: number[] | null): Mesh {
  const positions = new Float32Array(pos);
  const normals = new Float32Array(pos.length);
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < pos.length; t += 9) {
    const ax = pos[t + 3] - pos[t], ay = pos[t + 4] - pos[t + 1], az = pos[t + 5] - pos[t + 2];
    const bx = pos[t + 6] - pos[t], by = pos[t + 7] - pos[t + 1], bz = pos[t + 8] - pos[t + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (let k = 0; k < 3; k++) {
      normals.set([nx, ny, nz], t + 3 * k);
      for (let d = 0; d < 3; d++) {
        const v = pos[t + 3 * k + d];
        if (v < min[d]) min[d] = v;
        if (v > max[d]) max[d] = v;
      }
    }
  }
  return { positions, normals, colors: col ? new Float32Array(col) : null, triangles: pos.length / 9, min, max };
}

/** Binary or ASCII STL. */
export function parseStl(b: Uint8Array): Mesh {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const binary = b.length >= 84 && 84 + dv.getUint32(80, true) * 50 === b.length;
  const pos: number[] = [];
  if (binary) {
    const n = dv.getUint32(80, true);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      for (let k = 0; k < 9; k++) pos.push(dv.getFloat32(o + 4 * k, true));
    }
  } else {
    const t = new TextDecoder().decode(b);
    for (const m of t.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) pos.push(+m[1], +m[2], +m[3]);
    pos.length -= pos.length % 9;
  }
  if (!pos.length) throw new Error("no triangles in the STL file");
  return finish(pos, null);
}

/** Material colours (Kd) by name from an MTL file. */
export function parseMtl(text: string): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  let cur = "";
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p[0] === "newmtl") cur = p.slice(1).join(" ");
    else if (p[0] === "Kd" && cur) out.set(cur, [+p[1], +p[2], +p[3]]);
  }
  return out;
}

/** OBJ (vertices and faces; polygons are fanned into triangles), coloured from an MTL when given. */
export function parseObj(text: string, materials?: Map<string, [number, number, number]>): Mesh {
  const v: number[][] = [];
  const pos: number[] = [];
  const col: number[] = [];
  let colour: [number, number, number] = [0.8, 0.8, 0.8];
  let coloured = false;
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p[0] === "v") v.push([+p[1], +p[2], +p[3]]);
    else if (p[0] === "usemtl" && materials?.has(p.slice(1).join(" "))) {
      colour = materials.get(p.slice(1).join(" "))!;
      coloured = true;
    } else if (p[0] === "f") {
      const idx = p.slice(1).map((s) => {
        const i = parseInt(s.split("/")[0], 10);
        return i < 0 ? v.length + i : i - 1;
      });
      for (let k = 1; k + 1 < idx.length; k++) {
        for (const i of [idx[0], idx[k], idx[k + 1]]) {
          const q = v[i];
          if (!q) continue;
          pos.push(q[0], q[1], q[2]);
          col.push(...colour);
        }
      }
    }
  }
  pos.length -= pos.length % 9;
  if (!pos.length) throw new Error("no faces in the OBJ file");
  return finish(pos, coloured ? col.slice(0, pos.length) : null);
}
