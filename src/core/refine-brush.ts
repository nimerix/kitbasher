import { type GuidePoint, localEdge } from './refine-band';
import type { EdgeInput } from './refine-edge';
import { fitShape } from './refine-fit';
import { type RefineMesh, type RefineTopology, moveVertex, vertexNormal } from './refine-mesh';
import { nextMark, slotsFor, verticesUnderBrush, walkUnderBrush } from './refine-paint';
import { nearestOnSurface } from './refine-sketch';
import { smoothScale, smoothTargets } from './refine-smooth';
import { fitTrace, traceScatter, traceStroke } from './refine-trace';
import type { Vec3 } from './types';

export type RefineBrush = 'crease' | 'flatten' | 'smooth';
export interface Dab {
  triangle: number;
  center: Vec3;
  radius: number;
  strength: number;
  /** The model's noise in mm, the floor of the flatten plane's robust scale; 0 when absent. */
  noise?: number;
}

/** A moved triangle may keep no less than this fraction of its area. */
const collapse = 1e-3;
/** Times a vertex's move is halved for a triangle it would fold or collapse before it is dropped. */
const halvings = 6;
/**
 * A traced edge's points are fitted within this many times the scan's noise, a quarter edge, or this
 * many times their own scatter, whichever is most.
 */
const traceNoise = 2.5;
const traceScatterTimes = 2;
/** A stroke closes when it comes back within a radius of its start after this many radii. */
const closeLength = 6;

/**
 * Projects the vertices under the brush onto local quadric fits of the surface (`smoothTargets`),
 * each `strength * falloff` of the way. The reach is the larger of the brush radius and Smooth's
 * default for the local edge length, so a brush removes waves up to its own size; fits read the
 * connected surface within the radius plus that reach, and only the vertices under the brush move.
 * Returns the welded vertices that moved.
 */
export function smoothDab(mesh: RefineMesh, topology: RefineTopology, dab: Dab): Uint32Array {
  const { triangle, center, radius, strength } = dab;
  if (!(strength > 0) || !(radius > 0)) return new Uint32Array(0);
  const brush = verticesUnderBrush(mesh, topology, triangle, center, radius);
  if (!brush.vertices.length) return new Uint32Array(0);
  const scale = Math.max(radius, smoothScale(meanEdge(mesh, topology, brush.vertices)));
  const read = walkUnderBrush(mesh, topology, triangle, center, radius + scale).vertices;
  const patch = patchOf(mesh, topology, read);
  const { slots } = patch;
  const free = new Uint8Array(read.length);
  const weight = new Float64Array(read.length);
  brush.vertices.forEach((v, i) => {
    if (mesh.crease[v]) return;
    free[slots[v]] = 1;
    weight[slots[v]] = strength * brush.falloff[i];
  });
  const target = smoothTargets(
    patch.mesh,
    patch.topology,
    patch.read,
    free,
    scale,
    1,
    patch.crease,
  );
  const { position } = mesh;
  const moves = new Float64Array(brush.vertices.length * 3);
  brush.vertices.forEach((v, i) => {
    const k = slots[v];
    if (!free[k]) return;
    // A vertex no fit reached comes back as its own position rounded to float.
    if ([0, 1, 2].every((a) => target[k * 3 + a] === Math.fround(position[v * 3 + a]))) return;
    for (let a = 0; a < 3; a++)
      moves[i * 3 + a] = weight[k] * (target[k * 3 + a] - position[v * 3 + a]);
  });
  patch.release();
  return settle(mesh, topology, brush.vertices, moves);
}

/**
 * Fits a plane to the vertices under the brush and moves each toward it along the plane's normal by
 * `strength * falloff`. The plane is a robust fit, so raised detail under the brush, such as rivets,
 * does not tilt it; when that fit fails, the least squares plane.
 * Returns the welded vertices that moved.
 */
export function flattenDab(mesh: RefineMesh, topology: RefineTopology, dab: Dab): Uint32Array {
  const { triangle, center, radius, strength } = dab;
  if (!(strength > 0) || !(radius > 0)) return new Uint32Array(0);
  const { vertices, falloff } = verticesUnderBrush(mesh, topology, triangle, center, radius);
  if (vertices.length < 3) return new Uint32Array(0);
  const { position } = mesh;
  const plane =
    robustPlane(mesh, topology, vertices, dab.noise ?? 0) ?? planeThrough(position, vertices);
  if (!plane) return new Uint32Array(0);
  const [px, py, pz, nx, ny, nz] = plane;
  const moves = new Float64Array(vertices.length * 3);
  vertices.forEach((v, i) => {
    if (mesh.crease[v]) return;
    const h =
      (position[v * 3] - px) * nx +
      (position[v * 3 + 1] - py) * ny +
      (position[v * 3 + 2] - pz) * nz;
    const s = -strength * falloff[i] * h;
    moves[i * 3] = s * nx;
    moves[i * 3 + 1] = s * ny;
    moves[i * 3 + 2] = s * nz;
  });
  return settle(mesh, topology, vertices, moves);
}

/**
 * A freehand stroke as a guide on the rounded edge beside it. The stroke's first pass is smoothed,
 * then traced onto the middle of the rounding within reach of the brush (`edgeUnderStroke`), so the
 * stroke may run on either flank or on the rounding itself. The traced edge is fitted with lines and
 * arcs where they hold, splines where they do not, and corners where it turns sharply
 * (`fitTrace`). A stroke that ends near where it started closes the guide. Where too little of the
 * stroke finds an edge, the smoothed stroke itself is the guide. Width = radius. Null for a stroke
 * shorter than the radius.
 */
export function creaseInput(
  mesh: RefineMesh,
  topology: RefineTopology,
  noise: number,
  stroke: GuidePoint[],
  radius: number,
  strength: number,
): EdgeInput | null {
  if (stroke.length < 2 || !(radius > 0)) return null;
  const whole = new Float64Array(stroke.length);
  for (let i = 1; i < stroke.length; i++) {
    const a = stroke[i - 1].position,
      b = stroke[i].position;
    whole[i] = whole[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  const count = firstPass(stroke, whole, radius) + 1;
  const pass = stroke.slice(0, count);
  const along = whole.subarray(0, count);
  const length = along[count - 1];
  if (!(length >= radius)) return null;
  const step = localEdge(mesh, topology, pass) || radius / 10;
  // Evenly spaced, each a local straight-line fit to the stroke within a radius, on the stroke's
  // own triangle at the same station.
  const samples = Math.max(2, Math.ceil(length / Math.min(radius, Math.max(radius / 3, step))));
  let path: GuidePoint[] = [];
  let nearest = 0;
  for (let j = 0; j <= samples; j++) {
    const s = (j * length) / samples;
    while (nearest < count - 1 && Math.abs(along[nearest + 1] - s) <= Math.abs(along[nearest] - s))
      nearest++;
    path.push({ triangle: pass[nearest].triangle, position: lineFitAt(pass, along, s, radius) });
  }
  const end = closingPoint(path, radius);
  const closed = end > 0;
  if (closed) path = path.slice(0, end);
  const found = traceStroke(mesh, topology, path, radius, step);
  const edge = found.length ? found : path;
  const points = edge.map((p) => p.position);
  const traced = fitTrace(
    points,
    closed,
    Math.max(traceNoise * noise, step / 4, traceScatterTimes * traceScatter(points)),
    radius,
  );
  if (!traced) return null;
  // Each control onto the surface, searched from the traced point nearest it.
  const onSurface = (p: Vec3): GuidePoint => {
    let seed = edge[0],
      closest = Infinity;
    for (const q of edge) {
      const d = Math.hypot(q.position[0] - p[0], q.position[1] - p[1], q.position[2] - p[2]);
      if (d < closest) {
        closest = d;
        seed = q;
      }
    }
    return nearestOnSurface(mesh, topology, { triangle: seed.triangle, position: p });
  };
  return {
    segments: traced.segments.map(({ kind, points }) => ({
      kind,
      points: points.map(onSurface),
    })),
    joints: traced.joints,
    closed: traced.closed,
    width: radius,
    strength,
  };
}

/**
 * Where a stroke that comes back round to its start closes: the index of its point nearest the
 * start, among those at least `closeLength` radii along, when that is within a radius of it; else 0.
 */
function closingPoint(path: GuidePoint[], radius: number) {
  const start = path[0].position;
  let travelled = 0,
    best = 0,
    closest = radius;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1].position,
      b = path[i].position;
    travelled += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (travelled < closeLength * radius) continue;
    const d = Math.hypot(b[0] - start[0], b[1] - start[1], b[2] - start[2]);
    if (d < closest) {
      closest = d;
      best = i;
    }
  }
  return best;
}

/**
 * Index of the last point of the stroke's first pass over the surface. A point within `radius` of
 * the stroke laid at least 2 radius of length before it, travelling against that stroke's direction
 * there, is going back over it; the pass ends at the turnaround between them, the point farthest from
 * that nearest earlier point. A stroke that closes or crosses itself without reversing is kept whole.
 */
function firstPass(stroke: GuidePoint[], along: Float64Array, radius: number): number {
  const count = stroke.length;
  const gap = (i: number, j: number) => {
    const a = stroke[i].position,
      b = stroke[j].position;
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  };
  // The stroke's direction at point i: its chord over the radius of stroke centred there.
  const heading = (i: number) => {
    let from = i,
      to = i;
    while (from > 0 && along[from - 1] >= along[i] - radius / 2) from--;
    while (to < count - 1 && along[to + 1] <= along[i] + radius / 2) to++;
    const a = stroke[from].position,
      b = stroke[to].position;
    return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  };
  for (let k = 1; k < count; k++) {
    let nearest = -1,
      closest = radius;
    for (let j = 0; j < k && along[j] <= along[k] - 2 * radius;) {
      const d = gap(j, k);
      if (d < closest) {
        closest = d;
        nearest = j;
      }
      // A point less than d - closest of stroke further on is still no closer than `closest`.
      const skip = along[j] + d - closest;
      j++;
      while (j < k && along[j] < skip) j++;
    }
    if (nearest < 0) continue;
    const [ax, ay, az] = heading(nearest),
      [bx, by, bz] = heading(k);
    if (ax * bx + ay * by + az * bz >= 0) continue;
    let turn = nearest,
      farthest = 0;
    for (let i = nearest + 1; i < k; i++) {
      const d = gap(nearest, i);
      if (d > farthest) {
        farthest = d;
        turn = i;
      }
    }
    return turn;
  }
  return count - 1;
}

/** The stroke's position at station `s`, from a least squares line through its points within `reach`. */
function lineFitAt(stroke: GuidePoint[], along: Float64Array, s: number, reach: number): Vec3 {
  let n = 0,
    ms = 0;
  const mp = [0, 0, 0];
  for (let i = 0; i < stroke.length; i++) {
    if (Math.abs(along[i] - s) > reach) continue;
    n++;
    ms += along[i];
    for (let a = 0; a < 3; a++) mp[a] += stroke[i].position[a];
  }
  if (n < 2) {
    let best = 0;
    for (let i = 1; i < stroke.length; i++)
      if (Math.abs(along[i] - s) < Math.abs(along[best] - s)) best = i;
    return [...stroke[best].position];
  }
  ms /= n;
  for (let a = 0; a < 3; a++) mp[a] /= n;
  let ss = 0;
  const sp = [0, 0, 0];
  for (let i = 0; i < stroke.length; i++) {
    if (Math.abs(along[i] - s) > reach) continue;
    const ds = along[i] - ms;
    ss += ds * ds;
    for (let a = 0; a < 3; a++) sp[a] += ds * (stroke[i].position[a] - mp[a]);
  }
  return mp.map((m, a) => m + (ss > 0 ? (sp[a] / ss) * (s - ms) : 0)) as Vec3;
}

/** Mean length of the edges at `vertices`, from at most 64 of them. */
function meanEdge(mesh: RefineMesh, topology: RefineTopology, vertices: Uint32Array) {
  const { position } = mesh;
  const { neighbourStart, neighbours } = topology;
  const stride = Math.max(1, Math.floor(vertices.length / 64));
  let sum = 0,
    count = 0;
  for (let i = 0; i < vertices.length; i += stride) {
    const v = vertices[i];
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const w = neighbours[j];
      sum += Math.hypot(
        position[w * 3] - position[v * 3],
        position[w * 3 + 1] - position[v * 3 + 1],
        position[w * 3 + 2] - position[v * 3 + 2],
      );
      count++;
    }
  }
  return count ? sum / count : 0;
}

/**
 * A small mesh of the `read` vertices and every triangle around them, renumbered so `smoothTargets`
 * allocates and walks only this patch, never the whole mesh. `read` are its first vertices, in order.
 * `slots` maps a welded vertex to its patch vertex until `release`.
 */
function patchOf(mesh: RefineMesh, topology: RefineTopology, read: Uint32Array) {
  const slots = slotsFor(mesh, topology);
  const { triangleStart, trianglesOf, neighbourStart, neighbours } = topology;
  const globals: number[] = Array.from(read);
  read.forEach((v, i) => (slots[v] = i));
  const { triangle: stamp, mark } = nextMark(mesh, topology);
  const corners: number[] = [];
  for (const v of read)
    for (let j = triangleStart[v]; j < triangleStart[v + 1]; j++) {
      const t = trianglesOf[j];
      if (stamp[t] === mark) continue;
      stamp[t] = mark;
      for (let c = 0; c < 3; c++) {
        const w = mesh.weldOf[mesh.corners[t * 3 + c]];
        if (slots[w] < 0) {
          slots[w] = globals.length;
          globals.push(w);
        }
        corners.push(slots[w]);
      }
    }
  const count = globals.length;
  const triangleCount = corners.length / 3;
  const position = new Float64Array(count * 3);
  const crease = new Uint8Array(count);
  globals.forEach((v, i) => {
    for (let a = 0; a < 3; a++) position[i * 3 + a] = mesh.position[v * 3 + a];
    crease[i] = mesh.crease[v];
  });
  const patchStart = new Uint32Array(count + 1);
  for (const c of corners) patchStart[c + 1]++;
  for (let i = 0; i < count; i++) patchStart[i + 1] += patchStart[i];
  const patchTriangles = new Uint32Array(corners.length);
  const fill = patchStart.slice(0, count);
  for (let c = 0; c < corners.length; c++) patchTriangles[fill[corners[c]]++] = (c / 3) | 0;
  // Neighbours of the read vertices only: the fits never walk from a vertex outside them.
  const neighbourStartOut = new Uint32Array(count + 1);
  const list: number[] = [];
  for (let i = 0; i < count; i++) {
    neighbourStartOut[i] = list.length;
    if (i >= read.length) continue;
    const v = globals[i];
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) list.push(slots[neighbours[j]]);
  }
  neighbourStartOut[count] = list.length;
  const identity = Uint32Array.from({ length: count }, (_, i) => i);
  const patchMesh: RefineMesh = {
    ...mesh,
    position,
    weldedCount: count,
    weldOf: identity,
    vertexCount: count,
    corners: Uint32Array.from(corners),
    triangleCount,
    color: null,
    colorSize: 0,
    touched: new Uint8Array(count),
    crease,
    sourceVertexCount: count,
    sourceTriangleCount: triangleCount,
  };
  return {
    mesh: patchMesh,
    topology: {
      triangleStart: patchStart,
      trianglesOf: patchTriangles,
      neighbourStart: neighbourStartOut,
      neighbours: Uint32Array.from(list),
    },
    read: Uint32Array.from({ length: read.length }, (_, i) => i),
    crease,
    slots,
    release: () => {
      for (const v of globals) slots[v] = -1;
    },
  };
}

/** `fitShape`'s robust plane through the vertices: a point on it and its unit normal. */
function robustPlane(
  mesh: RefineMesh,
  topology: RefineTopology,
  vertices: Uint32Array,
  noise: number,
) {
  const points = new Float32Array(vertices.length * 3);
  const normals = new Float32Array(points.length);
  const normal = new Float32Array(3);
  vertices.forEach((v, i) => {
    for (let a = 0; a < 3; a++) points[i * 3 + a] = mesh.position[v * 3 + a];
    vertexNormal(mesh, topology, v, normal);
    normals.set(normal, i * 3);
  });
  // Equal weights: by falloff a rivet under the brush centre outweighs the plate and wins the fit.
  const fit = fitShape(points, normals, 'plane', noise);
  return fit?.shape.kind === 'plane' ? [...fit.shape.point, ...fit.shape.normal] : null;
}

/** Principal plane of the vertices' positions: a point on it and its unit normal. */
function planeThrough(position: Float64Array, vertices: Uint32Array) {
  const n = vertices.length;
  let cx = 0,
    cy = 0,
    cz = 0;
  for (const v of vertices) {
    cx += position[v * 3];
    cy += position[v * 3 + 1];
    cz += position[v * 3 + 2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  const m = new Float64Array(9);
  for (const v of vertices) {
    const x = position[v * 3] - cx,
      y = position[v * 3 + 1] - cy,
      z = position[v * 3 + 2] - cz;
    m[0] += x * x;
    m[1] += x * y;
    m[2] += x * z;
    m[4] += y * y;
    m[5] += y * z;
    m[8] += z * z;
  }
  m[3] = m[1];
  m[6] = m[2];
  m[7] = m[5];
  const normal = smallestEigenvector(m);
  return normal ? [cx, cy, cz, ...normal] : null;
}

/** Unit eigenvector of the smallest eigenvalue of a symmetric 3 x 3 matrix, by Jacobi rotations. */
function smallestEigenvector(a: Float64Array): [number, number, number] | null {
  const v = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = a[1] * a[1] + a[2] * a[2] + a[5] * a[5];
    if (off < 1e-30 * (a[0] * a[0] + a[4] * a[4] + a[8] * a[8] + 1e-300)) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      const apq = a[p * 3 + q];
      if (apq === 0) continue;
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1),
        s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p],
          akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k],
          aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p],
          vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  let least = 0;
  for (const k of [1, 2]) if (a[k * 4] < a[least * 4]) least = k;
  const normal: [number, number, number] = [v[least], v[3 + least], v[6 + least]];
  const length = Math.hypot(...normal);
  return length > 0 && Number.isFinite(length)
    ? [normal[0] / length, normal[1] / length, normal[2] / length]
    : null;
}

/**
 * Writes `moves`, three values per vertex of `vertices`. A triangle around a moving vertex that would
 * keep less than `collapse` of its area or turn its normal against its normal before the dab halves
 * the moves of its moving corners; after `halvings` such rounds those moves are dropped. The positions
 * checked are the ones written. Returns the welded vertices that moved, ascending.
 */
function settle(
  mesh: RefineMesh,
  topology: RefineTopology,
  vertices: Uint32Array,
  moves: Float64Array,
): Uint32Array {
  const { position, corners, weldOf } = mesh;
  const { triangleStart, trianglesOf } = topology;
  const count = vertices.length;
  const slots = slotsFor(mesh, topology);
  vertices.forEach((v, i) => (slots[v] = i));
  const factor = new Float64Array(count);
  for (let i = 0; i < count; i++)
    if (moves[i * 3] !== 0 || moves[i * 3 + 1] !== 0 || moves[i * 3 + 2] !== 0) factor[i] = 1;
  const target = new Float64Array(count * 3);
  const place = (i: number) => {
    const v = vertices[i] * 3;
    for (let a = 0; a < 3; a++) target[i * 3 + a] = position[v + a] + factor[i] * moves[i * 3 + a];
  };
  for (let i = 0; i < count; i++) place(i);
  const at = (w: number, out: Float64Array, offset: number, moved: boolean) => {
    const i = slots[w];
    for (let a = 0; a < 3; a++)
      out[offset + a] = moved && i >= 0 ? target[i * 3 + a] : position[w * 3 + a];
  };
  const was = new Float64Array(9),
    now = new Float64Array(9);
  for (let round = 0; ; round++) {
    const { triangle: stamp, mark } = nextMark(mesh, topology);
    const failed: number[] = [];
    for (let i = 0; i < count; i++) {
      if (!factor[i]) continue;
      const v = vertices[i];
      for (let j = triangleStart[v]; j < triangleStart[v + 1]; j++) {
        const t = trianglesOf[j];
        if (stamp[t] === mark) continue;
        stamp[t] = mark;
        for (let c = 0; c < 3; c++) {
          const w = weldOf[corners[t * 3 + c]];
          at(w, was, c * 3, false);
          at(w, now, c * 3, true);
        }
        const [ax, ay, az] = crossOf(was),
          [bx, by, bz] = crossOf(now);
        const before = Math.hypot(ax, ay, az),
          after = Math.hypot(bx, by, bz);
        if (after > 0 && after >= collapse * before && ax * bx + ay * by + az * bz >= 0) continue;
        failed.push(t);
      }
    }
    if (!failed.length) break;
    for (const t of failed)
      for (let c = 0; c < 3; c++) {
        const i = slots[weldOf[corners[t * 3 + c]]];
        if (i < 0 || !factor[i]) continue;
        factor[i] = round < halvings ? factor[i] / 2 : 0;
        place(i);
      }
  }
  const moved: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = vertices[i];
    slots[v] = -1;
    if (!factor[i]) continue;
    const x = target[i * 3],
      y = target[i * 3 + 1],
      z = target[i * 3 + 2];
    if (x === position[v * 3] && y === position[v * 3 + 1] && z === position[v * 3 + 2]) continue;
    moveVertex(mesh, v, x, y, z);
    moved.push(v);
  }
  return Uint32Array.from(moved).sort();
}

/** Cross product of a triangle's two edges from its first corner, corners packed in `p`. */
function crossOf(p: Float64Array): [number, number, number] {
  const ux = p[3] - p[0],
    uy = p[4] - p[1],
    uz = p[5] - p[2];
  const wx = p[6] - p[0],
    wy = p[7] - p[1],
    wz = p[8] - p[2];
  return [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
}
