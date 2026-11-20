import { type RefineMesh, type RefineTopology, weldedCorner } from './refine-mesh';
import type { Vec3 } from './types';

/**
 * Largest angle in degrees between a vertex's normal and the hit triangle's normal for the vertex to
 * face the brush: under 90 so the wall of a square inside corner and the back of a thin part are out,
 * with room for a rivet's dome (44 degrees at its steepest on the test plate) and a scan's noise.
 */
export const facingAngle = 70;
const facing = Math.cos((facingAngle * Math.PI) / 180);

/** Per topology: a visit stamp per welded vertex and per triangle, reused by every brush. */
interface Marks {
  vertex: Uint32Array;
  triangle: Uint32Array;
  mark: number;
}
const marksOf = new WeakMap<RefineTopology, Marks>();

/** A fresh stamp for one walk, without clearing the per-vertex arrays. */
export function nextMark(mesh: RefineMesh, topology: RefineTopology): Marks {
  let marks = marksOf.get(topology);
  if (
    !marks ||
    marks.vertex.length < mesh.weldedCount ||
    marks.triangle.length < mesh.triangleCount ||
    marks.mark === 0xffffffff
  ) {
    marks = {
      vertex: new Uint32Array(mesh.weldedCount),
      triangle: new Uint32Array(mesh.triangleCount),
      mark: 0,
    };
    marksOf.set(topology, marks);
  }
  marks.mark++;
  return marks;
}

/** Per topology: welded vertex -> index in the current working set, -1 when outside it. */
const slotsOf = new WeakMap<RefineTopology, Int32Array>();
export function slotsFor(mesh: RefineMesh, topology: RefineTopology): Int32Array {
  let slots = slotsOf.get(topology);
  if (!slots || slots.length < mesh.weldedCount) {
    slots = new Int32Array(mesh.weldedCount).fill(-1);
    slotsOf.set(topology, slots);
  }
  return slots;
}

/** Cross product of triangle `t`'s edges from its first corner: its normal times twice its area. */
function crossInto(mesh: RefineMesh, t: number, out: Float64Array) {
  const { position } = mesh;
  const a = weldedCorner(mesh, t, 0) * 3,
    b = weldedCorner(mesh, t, 1) * 3,
    c = weldedCorner(mesh, t, 2) * 3;
  const ux = position[b] - position[a],
    uy = position[b + 1] - position[a + 1],
    uz = position[b + 2] - position[a + 2];
  const vx = position[c] - position[a],
    vy = position[c + 1] - position[a + 1],
    vz = position[c + 2] - position[a + 2];
  out[0] = uy * vz - uz * vy;
  out[1] = uz * vx - ux * vz;
  out[2] = ux * vy - uy * vx;
}

/** Length of (x, y[, z]); Math.hypot is several times slower in the walk's inner loops. */
const norm = (x: number, y: number, z = 0) => Math.sqrt(x * x + y * y + z * z);

/** Growable binary min-heap of (key, value) pairs. */
class Heap {
  keys: number[] = [];
  values: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, value: number) {
    const { keys, values } = this;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }
  /** Removes the smallest pair and returns its value; its key is left in `top`. */
  pop() {
    const { keys, values } = this;
    const value = values[0];
    this.top = keys[0];
    const key = keys.pop()!,
      last = values.pop()!;
    const n = keys.length;
    if (n) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = key;
      values[i] = last;
    }
    return value;
  }
  top = 0;
}

/**
 * Distance from a source to `c` through the edge from `a` (at `da` from it) to `b` (at `db`), with
 * the triangle a, b, c unfolded flat: exact on a plane. NaN when no straight path crosses the edge.
 */
function unfolded(position: Float64Array, a: number, b: number, c: number, da: number, db: number) {
  const ex = position[b * 3] - position[a * 3],
    ey = position[b * 3 + 1] - position[a * 3 + 1],
    ez = position[b * 3 + 2] - position[a * 3 + 2];
  const fx = position[c * 3] - position[a * 3],
    fy = position[c * 3 + 1] - position[a * 3 + 1],
    fz = position[c * 3 + 2] - position[a * 3 + 2];
  const edge = norm(ex, ey, ez);
  if (!(edge > 0)) return NaN;
  // c at (cx, cy) with cy > 0, a at the origin and b at (edge, 0); the source opposite c.
  const cx = (fx * ex + fy * ey + fz * ez) / edge;
  const cy = Math.sqrt(Math.max(0, fx * fx + fy * fy + fz * fz - cx * cx));
  const sx = (da * da - db * db + edge * edge) / (2 * edge);
  const sy2 = da * da - sx * sx;
  if (!(sy2 >= 0) || !(cy > 0)) return NaN;
  const sy = -Math.sqrt(sy2);
  const cross = sx + ((cx - sx) * -sy) / (cy - sy);
  return cross >= 0 && cross <= edge ? norm(cx - sx, cy - sy) : NaN;
}

/**
 * Welded vertices of the surface under the brush, ascending, with their distance from `center`
 * along the surface. The walk starts at `seed`'s corners, each at its straight-line distance from
 * `center`, and grows in order of distance, over edges and across triangles unfolded flat, so a
 * flat face measures exactly; it stops at `radius`. It enters only vertices whose normal is within
 * `facingAngle` of the hit triangle's normal (the sum of its corners' normals, so one noisy facet
 * does not tilt it): it never wraps round a rim or a fold, or climbs the other wall of an inside
 * corner. It visits only the vertices it reaches.
 */
export function walkUnderBrush(
  mesh: RefineMesh,
  topology: RefineTopology,
  seed: number,
  center: Vec3,
  radius: number,
): { vertices: Uint32Array; distance: Float64Array } {
  const none = { vertices: new Uint32Array(0), distance: new Float64Array(0) };
  if (seed < 0 || seed >= mesh.triangleCount || !(radius > 0)) return none;
  const { position, corners, weldOf } = mesh;
  const { neighbourStart, neighbours, triangleStart, trianglesOf } = topology;
  const cross = new Float64Array(3);
  const normal = new Float64Array(3);
  // Area-weighted normal of welded vertex v into `normal`; false when it has none.
  const normalOf = (v: number) => {
    let x = 0,
      y = 0,
      z = 0;
    for (let j = triangleStart[v]; j < triangleStart[v + 1]; j++) {
      crossInto(mesh, trianglesOf[j], cross);
      x += cross[0];
      y += cross[1];
      z += cross[2];
    }
    const size = norm(x, y, z);
    if (!(size > 0)) return false;
    normal[0] = x / size;
    normal[1] = y / size;
    normal[2] = z / size;
    return true;
  };
  let nx = 0,
    ny = 0,
    nz = 0;
  for (const k of [0, 1, 2] as const)
    if (normalOf(weldedCorner(mesh, seed, k))) {
      nx += normal[0];
      ny += normal[1];
      nz += normal[2];
    }
  const size = norm(nx, ny, nz);
  if (!(size > 0)) return none;
  nx /= size;
  ny /= size;
  nz /= size;
  const faces = (v: number) =>
    normalOf(v) && normal[0] * nx + normal[1] * ny + normal[2] * nz >= facing;
  const slots = slotsFor(mesh, topology);
  const visited: number[] = [];
  // Per visited vertex: its best distance so far, -1 when it does not face the brush.
  const best: number[] = [];
  const done: boolean[] = [];
  const heap = new Heap();
  const offer = (w: number, d: number) => {
    if (!(d < radius)) return;
    let i = slots[w];
    if (i < 0) {
      i = slots[w] = visited.length;
      visited.push(w);
      best.push(faces(w) ? Infinity : -1);
      done.push(false);
    }
    if (best[i] < 0 || done[i] || d >= best[i]) return;
    best[i] = d;
    heap.push(d, i);
  };
  const distanceOf = (w: number) => {
    const i = slots[w];
    return i >= 0 && done[i] ? best[i] : -1;
  };
  for (const k of [0, 1, 2] as const) {
    const v = weldedCorner(mesh, seed, k);
    offer(
      v,
      norm(
        position[v * 3] - center[0],
        position[v * 3 + 1] - center[1],
        position[v * 3 + 2] - center[2],
      ),
    );
  }
  const found: number[] = [];
  while (heap.size) {
    const i = heap.pop();
    if (done[i] || heap.top > best[i]) continue;
    done[i] = true;
    const v = visited[i];
    found.push(v);
    const d = best[i];
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const w = neighbours[j];
      offer(
        w,
        d +
          norm(
            position[w * 3] - position[v * 3],
            position[w * 3 + 1] - position[v * 3 + 1],
            position[w * 3 + 2] - position[v * 3 + 2],
          ),
      );
    }
    // Across each triangle with another corner already measured, to its third corner.
    for (let j = triangleStart[v]; j < triangleStart[v + 1]; j++) {
      const t = trianglesOf[j];
      for (let c = 0; c < 3; c++) {
        const a = weldOf[corners[t * 3 + c]];
        const da = a === v ? -1 : distanceOf(a);
        if (da < 0) continue;
        const b = weldOf[corners[t * 3 + ((c + 1) % 3)]],
          e = weldOf[corners[t * 3 + ((c + 2) % 3)]];
        const third = b === v ? e : b;
        const reach = unfolded(position, v, a, third, d, da);
        if (reach === reach) offer(third, reach);
      }
    }
  }
  found.sort((a, b) => a - b);
  const vertices = Uint32Array.from(found);
  const distance = Float64Array.from(found, (v) => best[slots[v]]);
  for (const v of visited) slots[v] = -1;
  return { vertices, distance };
}

/** Triangles connected to `seed` with a vertex within `radius` of `center`. */
export function trianglesUnderBrush(
  mesh: RefineMesh,
  topology: RefineTopology,
  seed: number,
  center: Vec3,
  radius: number,
): Uint32Array {
  const { vertices } = walkUnderBrush(mesh, topology, seed, center, radius);
  const { triangle: stamp, mark } = nextMark(mesh, topology);
  const { triangleStart, trianglesOf } = topology;
  const found: number[] = [];
  for (const v of vertices)
    for (let j = triangleStart[v]; j < triangleStart[v + 1]; j++) {
      const t = trianglesOf[j];
      if (stamp[t] === mark) continue;
      stamp[t] = mark;
      found.push(t);
    }
  return Uint32Array.from(found).sort();
}

/**
 * Welded vertices connected to `seed`'s triangle within `radius`, with a (1 - (d/r)^2)^2 falloff each.
 * The footprint is measured along the surface (`walkUnderBrush`). The falloff takes d in a straight
 * line: exact on a flat face, free of the walk's edge-path excess, and within the footprint d < r.
 */
export function verticesUnderBrush(
  mesh: RefineMesh,
  topology: RefineTopology,
  seed: number,
  center: Vec3,
  radius: number,
): { vertices: Uint32Array; falloff: Float32Array } {
  const { vertices } = walkUnderBrush(mesh, topology, seed, center, radius);
  const { position } = mesh;
  const falloff = Float32Array.from(vertices, (v) => {
    const dx = position[v * 3] - center[0],
      dy = position[v * 3 + 1] - center[1],
      dz = position[v * 3 + 2] - center[2];
    const u = 1 - (dx * dx + dy * dy + dz * dz) / (radius * radius);
    return u * u;
  });
  return { vertices, falloff };
}
