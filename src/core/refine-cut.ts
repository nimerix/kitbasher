import {
  type RefineMesh,
  type RefineTopology,
  addGeometryVertex,
  addTriangle,
  addWeldedVertex,
  moveVertex,
  setTriangle,
} from './refine-mesh';

export interface CutResult {
  /** Welded ids now on the cut. */
  chain: Uint32Array;
  /** Pairs of welded ids, one pair per piece of the zero set that now runs along a mesh edge. */
  edges: Uint32Array;
  /** For each triangle that was split: its id and the ids of the triangles that now cover it. */
  children: Map<number, number[]>;
  /** Triangles that still straddle the zero set because a split or snap was dropped. */
  skipped: Uint32Array;
}

/**
 * Triangles rebuilt as one: the faces that now cover them, each three nodes (a welded vertex, or
 * -1 - i for split i), and the splits inside the patch that the chain no longer passes through.
 */
interface Patch {
  triangles: Set<number>;
  faces: number[][];
  dropped: number[];
  /** Per face, the triangle of the patch it came from (see `ownersOf`). */
  owners?: number[];
}

/** Squared distance from p to the triangle a, b, c (each 3 numbers). */
function triangleDistance(p: number[], a: number[], b: number[], c: number[]) {
  const sub = (u: number[], v: number[]) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a);
  const d1 = dot3(ab, ap),
    d2 = dot3(ac, ap);
  const at = (q: number[]) => dot3(sub(p, q), sub(p, q));
  const along = (u: number[], f: number) => [a[0] + u[0] * f, a[1] + u[1] * f, a[2] + u[2] * f];
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = sub(p, b);
  const d3 = dot3(ab, bp),
    d4 = dot3(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(along(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot3(ab, cp),
    d6 = dot3(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(along(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const f = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at([b[0] + (c[0] - b[0]) * f, b[1] + (c[1] - b[1]) * f, b[2] + (c[2] - b[2]) * f]);
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator,
    w = vc * denominator;
  return at([
    a[0] + ab[0] * v + ac[0] * w,
    a[1] + ab[1] * v + ac[1] * w,
    a[2] + ab[2] * v + ac[2] * w,
  ]);
}

/** A split welded edge: the new welded vertex and where it lies from the lower welded end. */
interface Split {
  welded: number;
  t: number;
}

/** A child is collapsed below this fraction of its parent's area, or below `tinyArea`. */
const collapsedFraction = 1e-6;
const tinyArea = 1e-12;

/** Coarse cells around a plan share bits of a table this size less one. */
const coarseMask = (1 << 20) - 1;

const cellKey = (x: number, y: number, z: number) =>
  Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);

/**
 * Children of a triangle whose edges `cut` (edge k runs from corner k to k + 1) are split. A child
 * names corners 0 to 2 and the split point of edge k as 3 + k. `far` measures two of those points;
 * a quad left by two splits is divided along its shorter diagonal.
 */
function divide(cut: number[], far: (p: number, q: number) => number): number[][] {
  if (cut.length === 0) return [[0, 1, 2]];
  if (cut.length === 1) {
    const k = cut[0];
    const [a, b, c] = [k, (k + 1) % 3, (k + 2) % 3];
    return [
      [a, 3 + k, c],
      [3 + k, b, c],
    ];
  }
  // Two cut edges meet at the apex: a triangle beyond the cut and a quad on this side.
  const k = cut[0] === 0 && cut[1] === 2 ? 0 : cut[1];
  const [a, b, c] = [k, (k + 1) % 3, (k + 2) % 3];
  const ab = 3 + a,
    ca = 3 + c;
  const quad =
    far(ab, c) <= far(b, ca)
      ? [
          [ab, b, c],
          [ab, c, ca],
        ]
      : [
          [ab, b, ca],
          [b, c, ca],
        ];
  return [[a, ab, ca], ...quad];
}

/** Rounds of neighbours a patch takes in around the triangles it rebuilds. */
const patchRounds = 4;

/**
 * Triangles covering the polygon `xy` (2 per corner, in its own winding), by clipping ears: at each
 * step the ear whose smallest angle is largest. `quality` measures a candidate's three corners.
 * Every triangle keeps a corner that is not `chained`. Null when no ear is left.
 */
function clipEars(
  xy: number[],
  chained: boolean[],
  quality: (a: number, b: number, c: number) => number,
) {
  const n = xy.length / 2;
  const cross = (a: number, b: number, c: number) =>
    (xy[b * 2] - xy[a * 2]) * (xy[c * 2 + 1] - xy[a * 2 + 1]) -
    (xy[b * 2 + 1] - xy[a * 2 + 1]) * (xy[c * 2] - xy[a * 2]);
  let winding = 0;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    winding += xy[k * 2] * xy[j * 2 + 1] - xy[j * 2] * xy[k * 2 + 1];
  }
  const sign = Math.sign(winding);
  const left = Array.from({ length: n }, (_, k) => k);
  const result: number[][] = [];
  while (left.length > 3) {
    let best = -1,
      score = -Infinity;
    for (let k = 0; k < left.length; k++) {
      const [a, b, c] = [
        left[(k + left.length - 1) % left.length],
        left[k],
        left[(k + 1) % left.length],
      ];
      if (!(sign * cross(a, b, c) > 0) || (chained[a] && chained[b] && chained[c])) continue;
      if (!chained[b] && left.every((d) => d === b || chained[d])) continue;
      // No other corner may lie inside the ear or on its edges.
      const blocked = left.some(
        (d) =>
          d !== a &&
          d !== b &&
          d !== c &&
          sign * cross(a, b, d) >= 0 &&
          sign * cross(b, c, d) >= 0 &&
          sign * cross(c, a, d) >= 0,
      );
      if (blocked) continue;
      const q = quality(a, b, c);
      if (q > score) [best, score] = [k, q];
    }
    if (best < 0) return null;
    const k = best;
    result.push([left[(k + left.length - 1) % left.length], left[k], left[(k + 1) % left.length]]);
    left.splice(k, 1);
  }
  if (!(sign * cross(left[0], left[1], left[2]) > 0)) return null;
  result.push(left);
  return result;
}

const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossOf = (a: ArrayLike<number>, b: ArrayLike<number>) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Faces of up to this many corners are triangulated every way when ears fail. */
const wholeFace = 7;

/** Every triangulation of the polygon corners `from` to `to`, as triangles of corner indices. */
function fans(from: number, to: number): number[][][] {
  if (to - from < 2) return [[]];
  const result: number[][][] = [];
  for (let k = from + 1; k < to; k++)
    for (const left of fans(from, k))
      for (const right of fans(k, to)) result.push([...left, [from, k, to], ...right]);
  return result;
}

/** Area of the triangle `p` holds; `out` receives its normal scaled by twice the area. */
const area = (p: Float64Array, out: Float64Array) => {
  const ux = p[3] - p[0],
    uy = p[4] - p[1],
    uz = p[5] - p[2];
  const vx = p[6] - p[0],
    vy = p[7] - p[1],
    vz = p[8] - p[2];
  out[0] = uy * vz - uz * vy;
  out[1] = uz * vx - ux * vz;
  out[2] = ux * vy - uy * vx;
  return Math.hypot(out[0], out[1], out[2]) / 2;
};

/**
 * Puts a chain of mesh edges on the zero set of `field` among `vertices`.
 * `place` maps a point on the zero set, at `t` along the welded edge from `a` to `b`, to its final
 * position, and returns false when the chain vertex placed there is not a crease. The mesh must be a
 * topology clone.
 * `field[i]` is the value at `vertices[i]`; `topology` describes the mesh before the cut.
 * The whole cut is planned on final positions first; a split or snap that would collapse a triangle,
 * reverse one, or land on another vertex is revised; with `facing`, triangles no revision keeps
 * facing the surface are rebuilt with their neighbours as one patch around the chain, else the
 * split is dropped, and the triangles left straddling are reported in `skipped`. A child is reversed when its normal opposes `facing`, the outward normal the
 * surface should have at its centroid on its side of the zero set (the field's sign there), or,
 * without `facing`, the normal of the triangle it is cut from. `beside` gives the side of a vertex
 * the field does not cover, so a chain edge beside it can still be told to carry the zero set.
 * `stationary` vertices keep their exact position: the zero set is never snapped to one, one on it
 * already stays where it stands, and it is touched only where a triangle around it is split.
 */
export function cutAlongField(
  mesh: RefineMesh,
  topology: RefineTopology,
  vertices: Uint32Array,
  field: Float32Array,
  place: (
    x: number,
    y: number,
    z: number,
    out: Float32Array,
    a: number,
    b: number,
    t: number,
  ) => boolean | void,
  snap = 0.25,
  facing?: (x: number, y: number, z: number, side: 1 | -1, out: Float64Array) => void,
  beside?: (v: number) => number,
  stationary?: Set<number>,
): CutResult {
  const { neighbourStart, neighbours, triangleStart, trianglesOf } = topology;
  const weldedCount = mesh.weldedCount;
  const vertexCount = mesh.vertexCount;
  const triangleCount = mesh.triangleCount;

  // Band-local ids in ascending welded order, so every pass visits vertices as a scan of the whole
  // mesh would, with storage in proportion to the band.
  const local = new Map<number, number>();
  for (const v of vertices) local.set(v, 0);
  const welded = Uint32Array.from(local.keys()).sort();
  welded.forEach((v, i) => local.set(v, i));
  const count = welded.length;
  const value = new Float64Array(count).fill(NaN);
  vertices.forEach((v, i) => (value[local.get(v)!] = field[i]));
  const valueOf = (v: number) => {
    const i = local.get(v);
    return i === undefined ? NaN : value[i];
  };
  const zero = new Uint8Array(count);
  const isZero = (v: number) => {
    const i = local.get(v);
    return i !== undefined && zero[i] === 1;
  };
  // Point on the zero set each zero vertex is placed from.
  const point = new Float64Array(count * 3);
  // The welded edge and fraction along it of that point.
  const pointEdge = new Float64Array(count * 3);
  const lerp = (a: number, b: number, t: number, out: Float64Array, offset: number) => {
    for (let axis = 0; axis < 3; axis++)
      out[offset + axis] = mesh.position[a * 3 + axis] * (1 - t) + mesh.position[b * 3 + axis] * t;
  };
  for (let i = 0; i < count; i++)
    if (value[i] === 0) {
      zero[i] = 1;
      lerp(welded[i], welded[i], 0, point, i * 3);
      pointEdge.set([welded[i], welded[i], 0], i * 3);
    }

  const edgeA: number[] = [],
    edgeB: number[] = [],
    edgeT: number[] = [];
  const edgeOf = new Map<number, number>();
  for (let k = 0; k < count; k++) {
    const a = welded[k];
    if (Number.isNaN(value[k])) continue;
    for (let i = neighbourStart[a]; i < neighbourStart[a + 1]; i++) {
      const b = neighbours[i];
      if (b <= a || !(value[k] * valueOf(b) < 0)) continue;
      edgeOf.set(a * weldedCount + b, edgeA.length);
      edgeA.push(a);
      edgeB.push(b);
      edgeT.push(value[k] / (value[k] - valueOf(b)));
    }
  }

  // A vertex may snap unless some triangle around it would then lie wholly on the zero set.
  const canSnap = (v: number) => {
    for (let i = triangleStart[v]; i < triangleStart[v + 1]; i++) {
      const t = trianglesOf[i] * 3;
      let others = 0;
      for (let k = 0; k < 3; k++) {
        const w = mesh.weldOf[mesh.corners[t + k]];
        if (w !== v && isZero(w)) others++;
      }
      if (others === 2) return false;
    }
    return true;
  };
  const clamped = new Uint8Array(edgeT.length);
  const near = (i: number) => Math.min(edgeT[i], 1 - edgeT[i]);
  const candidates = edgeT.map((_, i) => i).filter((i) => near(i) < snap);
  candidates.sort((i, j) => near(i) - near(j) || i - j);
  for (const i of candidates) {
    const a = edgeA[i],
      b = edgeB[i];
    if (isZero(a) || isZero(b)) continue;
    const v = edgeT[i] < snap ? a : b;
    // A stationary vertex is never snapped to; the edge is split instead.
    if (stationary?.has(v)) {
      clamped[i] = 1;
      continue;
    }
    if (!canSnap(v)) {
      clamped[i] = 1;
      continue;
    }
    const k = local.get(v)!;
    zero[k] = 1;
    lerp(a, b, edgeT[i], point, k * 3);
    pointEdge.set([a, b, edgeT[i]], k * 3);
  }

  // The plan: final positions of placed zero vertices and splits, as Float32 as the mesh stores them.
  const out = new Float32Array(3);
  const at = new Float64Array(3);
  const placed = new Uint8Array(count);
  const placedAt = new Float32Array(count * 3);
  // Whether each zero vertex and split is a crease, as `place` decided when planning it.
  const creased = new Uint8Array(count);
  const isPlaced = (v: number) => {
    const i = local.get(v);
    return i !== undefined && placed[i] === 1;
  };
  for (let i = 0; i < count; i++) {
    if (!zero[i]) continue;
    const [a, b, t] = pointEdge.subarray(i * 3, i * 3 + 3);
    creased[i] = +(place(point[i * 3], point[i * 3 + 1], point[i * 3 + 2], out, a, b, t) !== false);
    if (stationary?.has(welded[i]))
      placedAt.set(mesh.position.subarray(welded[i] * 3, welded[i] * 3 + 3), i * 3);
    else placedAt.set(out, i * 3);
    placed[i] = 1;
  }
  const splitT = new Float64Array(edgeT.length).fill(NaN);
  const splitAt = new Float32Array(edgeT.length * 3);
  const splitCreased = new Uint8Array(edgeT.length);
  // A split left flat lies where the zero set crosses the edge as the mesh stands, unplaced.
  const flat = new Uint8Array(edgeT.length);
  const flatten = (i: number) => {
    flat[i] = 1;
    splitCreased[i] = 0;
    splitT[i] = edgeT[i];
    lerp(edgeA[i], edgeB[i], splitT[i], at, 0);
    for (let axis = 0; axis < 3; axis++) splitAt[i * 3 + axis] = at[axis];
  };
  const planSplit = (i: number, t: number) => {
    splitT[i] = t;
    flat[i] = 0;
    lerp(edgeA[i], edgeB[i], t, at, 0);
    splitCreased[i] = +(place(at[0], at[1], at[2], out, edgeA[i], edgeB[i], t) !== false);
    splitAt.set(out, i * 3);
  };
  for (let i = 0; i < edgeT.length; i++)
    if (!isZero(edgeA[i]) && !isZero(edgeB[i]))
      planSplit(i, clamped[i] ? Math.min(Math.max(edgeT[i], 0.1), 0.9) : edgeT[i]);
  // Planned split of the welded edge from a to b, or -1.
  const splitOf = (a: number, b: number) => {
    const i = edgeOf.get(Math.min(a, b) * weldedCount + Math.max(a, b));
    return i !== undefined && !Number.isNaN(splitT[i]) ? i : -1;
  };

  // Every triangle the plan can touch: those around zero vertices and around split edges.
  const checked = new Set<number>();
  const touched: number[] = [];
  const around = (v: number) => {
    for (let i = triangleStart[v]; i < triangleStart[v + 1]; i++)
      if (!checked.has(trianglesOf[i])) {
        checked.add(trianglesOf[i]);
        touched.push(trianglesOf[i]);
      }
  };
  for (let i = 0; i < count; i++) if (zero[i]) around(welded[i]);
  for (let i = 0; i < edgeT.length; i++) if (!Number.isNaN(splitT[i])) around(edgeA[i]);

  const w = [0, 0, 0];
  const corner = (k: number) => w[k % 3];
  const cutOf = () => [0, 1, 2].filter((k) => splitOf(corner(k), corner(k + 1)) >= 0);
  const pointOf = (ref: number, target: Float64Array, offset: number) => {
    let source: Float32Array | Float64Array = mesh.position,
      i = corner(ref) * 3;
    if (ref >= 3) {
      source = splitAt;
      i = splitOf(corner(ref), corner(ref + 1)) * 3;
    } else if (isPlaced(corner(ref))) {
      source = placedAt;
      i = local.get(corner(ref))! * 3;
    }
    for (let axis = 0; axis < 3; axis++) target[offset + axis] = source[i + axis];
  };
  const points = new Float64Array(9);
  const parentNormal = new Float64Array(3),
    childNormal = new Float64Array(3);
  const ends = new Float64Array(6);
  const facingNormal = new Float64Array(3);
  // The side of the zero set a child lies on: the field's sign at its corners off the zero set, or 0
  // when they disagree or none has a value.
  const sideOf = (child: number[]): 1 | -1 | 0 => {
    let side = 0;
    for (const ref of child) {
      if (ref >= 3 || isZero(corner(ref))) continue;
      const s = Math.sign(valueOf(corner(ref)));
      if (!s) continue;
      if (side && s !== side) return 0;
      side = s;
    }
    return side as 1 | -1 | 0;
  };
  const far = (p: number, q: number) => {
    pointOf(p, ends, 0);
    pointOf(q, ends, 3);
    return Math.hypot(ends[0] - ends[3], ends[1] - ends[4], ends[2] - ends[5]);
  };
  // Revises the plan behind a collapsed or reversed child: its splits move to the midpoint, then those
  // that are not a crease are left flat, then are dropped, then its placed vertices stay where they
  // are, on the chain still unless a crease; behind flat splits its placed vertices stay first. False
  // when nothing is left to revise.
  // Triangles whose children no midpoint or flat split keeps facing the surface: each is rebuilt,
  // with neighbours along the chain, as one patch around it (see `buildPatch`). A patch that cannot
  // be built marks its triangles, and the plan is made again without patching them.
  const patched = new Set<number>();
  const unpatched = new Set<number>();
  const revise = (child: number[], t: number) => {
    const splits = child
      .filter((ref) => ref >= 3)
      .map((ref) => splitOf(corner(ref), corner(ref + 1)));
    const off = splits.find((i) => splitT[i] !== 0.5 && !flat[i]);
    // Only a split that is not a crease may be left flat; a crease must lie where it is placed.
    const placedSplit = splits.find((i) => !flat[i] && !splitCreased[i]);
    const v = child.map(corner).find(isPlaced);
    if (off !== undefined) planSplit(off, 0.5);
    else if (placedSplit !== undefined) flatten(placedSplit);
    else if (facing && !unpatched.has(t)) patched.add(t);
    else if (splits.length > 0 && !(v !== undefined && splits.every((i) => flat[i])))
      splitT[splits[0]] = NaN;
    else {
      if (v === undefined) return false;
      const k = local.get(v)!;
      placed[k] = 0;
      // A vertex that is not a crease stays on the chain where it stands.
      if (value[k] !== 0 && creased[k]) zero[k] = 0;
    }
    return true;
  };
  // Revises every planned chain vertex within the mesh's clearance of another vertex's final
  // position, where the two could merge on export: the later of two chain vertices. Chain vertices
  // sit in a spatial hash under the 27 cells around their own, so each other vertex needs one lookup.
  const coincident = mesh.clearance;
  const reviseCoincident = () => {
    const ids: number[] = [];
    const at: number[] = [];
    for (let k = 0; k < count; k++)
      if (placed[k]) {
        ids.push(k);
        at.push(placedAt[k * 3], placedAt[k * 3 + 1], placedAt[k * 3 + 2]);
      }
    const firstSplit = ids.length;
    for (let i = 0; i < edgeT.length; i++)
      if (!Number.isNaN(splitT[i])) {
        ids.push(i);
        at.push(splitAt[i * 3], splitAt[i * 3 + 1], splitAt[i * 3 + 2]);
      }
    const cells = new Map<number, number[]>();
    const cell = (x: number) => Math.floor(x / coincident);
    const nearest = (x: number, y: number, z: number, before: number) => {
      for (const e of cells.get(cellKey(cell(x), cell(y), cell(z))) ?? [])
        if (
          e < before &&
          Math.hypot(at[e * 3] - x, at[e * 3 + 1] - y, at[e * 3 + 2] - z) < coincident
        )
          return e;
      return -1;
    };
    const clash = new Uint8Array(ids.length);
    for (let e = 0; e < ids.length; e++) {
      const [x, y, z] = [at[e * 3], at[e * 3 + 1], at[e * 3 + 2]];
      if (nearest(x, y, z, e) >= 0) clash[e] = 1;
      const [cx, cy, cz] = [cell(x), cell(y), cell(z)];
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const key = cellKey(cx + dx, cy + dy, cz + dz);
            const list = cells.get(key);
            if (list) list.push(e);
            else cells.set(key, [e]);
          }
    }
    // Any vertex of the mesh can be landed on, joined to the band or not. One pass over positions
    // reaches each of them; a bit per coarse cell around the plan passes on only those near it.
    const low = [Infinity, Infinity, Infinity],
      high = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < at.length; k++) {
      low[k % 3] = Math.min(low[k % 3], at[k] - coincident);
      high[k % 3] = Math.max(high[k % 3], at[k] + coincident);
    }
    const coarse = Math.max(coincident, ...[0, 1, 2].map((a) => (high[a] - low[a]) / 256));
    const coarseOf = (x: number, y: number, z: number) =>
      cellKey(Math.floor(x / coarse), Math.floor(y / coarse), Math.floor(z / coarse)) & coarseMask;
    const occupied = new Uint8Array(coarseMask + 1);
    for (let k = 0; k < at.length; k += 3)
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++)
            occupied[
              coarseOf(at[k] + dx * coarse, at[k + 1] + dy * coarse, at[k + 2] + dz * coarse)
            ] = 1;
    const { position } = mesh;
    for (let v = 0; v < weldedCount; v++) {
      const x = position[v * 3],
        y = position[v * 3 + 1],
        z = position[v * 3 + 2];
      if (x < low[0] || x > high[0] || y < low[1] || y > high[1] || z < low[2] || z > high[2])
        continue;
      if (!occupied[coarseOf(x, y, z)] || isPlaced(v)) continue;
      const e = nearest(x, y, z, ids.length);
      if (e >= 0) clash[e] = 1;
    }
    let revised = false;
    for (let e = 0; e < ids.length; e++) {
      if (!clash[e]) continue;
      revised = true;
      if (e >= firstSplit) {
        const i = ids[e];
        if (splitT[i] !== 0.5 && !flat[i]) planSplit(i, 0.5);
        else splitT[i] = NaN;
      } else {
        const k = ids[e];
        placed[k] = 0;
        if (value[k] !== 0) zero[k] = 0;
      }
    }
    return revised;
  };
  const cornersOf = (t: number) => [0, 1, 2].map((k) => mesh.weldOf[mesh.corners[t * 3 + k]]);
  // The triangle across the welded edge from a to b from t, or -1.
  const across = (t: number, a: number, b: number) => {
    for (let i = triangleStart[a]; i < triangleStart[a + 1]; i++) {
      const u = trianglesOf[i];
      if (u !== t && cornersOf(u).includes(b)) return u;
    }
    return -1;
  };
  const clustersOf = (triangles: Set<number>) => {
    const seen = new Set<number>();
    const clusters: Set<number>[] = [];
    for (const first of triangles) {
      if (seen.has(first)) continue;
      const cluster = new Set([first]);
      seen.add(first);
      for (const t of cluster) {
        const c = cornersOf(t);
        for (let k = 0; k < 3; k++) {
          const u = across(t, c[k], c[(k + 1) % 3]);
          if (u >= 0 && triangles.has(u) && !seen.has(u)) {
            seen.add(u);
            cluster.add(u);
          }
        }
      }
      clusters.push(cluster);
    }
    return clusters;
  };
  // A node of a patch: a welded vertex, or -1 - i for split i, where it ends.
  const nodeAt = (node: number, out: number[]) => {
    let source: ArrayLike<number> = mesh.position,
      i = node * 3;
    if (node < 0) {
      source = splitAt;
      i = (-node - 1) * 3;
    } else if (isPlaced(node)) {
      source = placedAt;
      i = local.get(node)! * 3;
    }
    out[0] = source[i];
    out[1] = source[i + 1];
    out[2] = source[i + 2];
    return out;
  };
  const p = [0, 0, 0],
    q = [0, 0, 0],
    r = [0, 0, 0];
  const corner3 = [p, q, r];
  const normalOf = (nodes: number[]) => {
    nodes.forEach((node, k) => nodeAt(node, corner3[k]));
    return crossOf(
      [q[0] - p[0], q[1] - p[1], q[2] - p[2]],
      [r[0] - p[0], r[1] - p[1], r[2] - p[2]],
    );
  };
  const smallestAngle = (nodes: number[]) => {
    nodes.forEach((node, k) => nodeAt(node, corner3[k]));
    let least = Infinity;
    for (let k = 0; k < 3; k++) {
      const [a, b, c] = [corner3[k], corner3[(k + 1) % 3], corner3[(k + 2) % 3]];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
        v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cos = dot3(u, v) / (Math.hypot(...u) * Math.hypot(...v) || 1);
      least = Math.min(least, Math.acos(Math.max(-1, Math.min(1, cos))));
    }
    return least;
  };
  // The faces covering the triangles `patch`: its edge as one loop, the splits on it, divided by
  // the chain's paths across it, each path kept only where it advances from its start toward its
  // end, then each face clipped into triangles in the plane the surface faces on its side. Null
  // when the patch is not a disk with every corner off the chain on its edge, or a triangle would
  // collapse or face against the surface.
  const tryPatch = (patch: Set<number>): Omit<Patch, 'triangles'> | null => {
    const next = new Map<number, number>();
    const directed = new Set<number>();
    for (const t of patch) {
      const c = cornersOf(t);
      for (let k = 0; k < 3; k++) directed.add(c[k] * weldedCount + c[(k + 1) % 3]);
    }
    let parentArea = 0;
    for (const t of patch) {
      const c = cornersOf(t);
      for (let k = 0; k < 3; k++) {
        const [a, b] = [c[k], c[(k + 1) % 3]];
        if (directed.has(b * weldedCount + a)) continue;
        if (next.has(a)) return null;
        next.set(a, b);
      }
      parentArea += Math.hypot(...normalOf(c)) / 2;
    }
    const loop: number[] = [];
    const start = next.keys().next().value!;
    for (let v = start; loop.length <= next.size;) {
      loop.push(v);
      v = next.get(v)!;
      if (v === start) break;
    }
    if (loop.length !== next.size) return null;
    const onLoop = new Set(loop);
    for (const t of patch) if (cornersOf(t).some((v) => !onLoop.has(v) && !isZero(v))) return null;
    const ring: number[] = [];
    loop.forEach((a, k) => {
      ring.push(a);
      const i = splitOf(a, loop[(k + 1) % loop.length]);
      if (i >= 0) ring.push(-1 - i);
    });
    // The chain inside the patch: in each triangle its two points.
    const links = new Map<number, number[]>();
    const link = (a: number, b: number) => {
      for (const [x, y] of [
        [a, b],
        [b, a],
      ]) {
        const list = links.get(x) ?? [];
        if (!list.includes(y)) list.push(y);
        links.set(x, list);
      }
    };
    for (const t of patch) {
      const c = cornersOf(t);
      const nodes: number[] = [];
      for (let k = 0; k < 3; k++) {
        if (isZero(c[k])) nodes.push(c[k]);
        const i = splitOf(c[k], c[(k + 1) % 3]);
        if (i >= 0) nodes.push(-1 - i);
      }
      if (nodes.length > 2) return null;
      if (nodes.length === 2) link(nodes[0], nodes[1]);
    }
    const onRing = new Set(ring);
    for (const [node, list] of links) if (!onRing.has(node) && list.length !== 2) return null;
    const paths: number[][] = [];
    const walked = new Set<number>();
    for (const [anchor, list] of links) {
      if (!onRing.has(anchor)) continue;
      for (const first of list) {
        const path = [anchor];
        let [previous, node] = [anchor, first];
        while (!onRing.has(node)) {
          walked.add(node);
          path.push(node);
          const following = links.get(node)!.find((x) => x !== previous)!;
          [previous, node] = [node, following];
        }
        if (node === anchor) return null;
        // Each path once, from its smaller end.
        if (anchor < node) paths.push([...path, node]);
      }
    }
    for (const node of links.keys()) if (!onRing.has(node) && !walked.has(node)) return null;
    // Along each path, the points that advance from its start toward its end by a twentieth of the
    // patch's mean edge.
    let perimeter = 0;
    loop.forEach((a, k) => {
      nodeAt(a, p);
      nodeAt(loop[(k + 1) % loop.length], q);
      perimeter += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    });
    const least = perimeter / loop.length / 20;
    const dropped: number[] = [];
    const cleaned = paths.map((path) => {
      const [from, to] = [nodeAt(path[0], [0, 0, 0]), nodeAt(path[path.length - 1], [0, 0, 0])];
      const direction = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
      const length = Math.hypot(...direction);
      const kept = [path[0]];
      let reached = 0;
      for (const node of path.slice(1, -1)) {
        nodeAt(node, p);
        const along = dot3([p[0] - from[0], p[1] - from[1], p[2] - from[2]], direction) / length;
        if (node < 0 && !(along >= reached + least && along <= length - least)) {
          dropped.push(-1 - node);
          continue;
        }
        kept.push(node);
        reached = along;
      }
      return [...kept, path[path.length - 1]];
    });
    let faces = [ring];
    for (const path of cleaned) {
      const [a, b] = [path[0], path[path.length - 1]];
      const inner = path.slice(1, -1);
      const f = faces.findIndex((face) => face.includes(a) && face.includes(b));
      if (f < 0) return null;
      const face = faces[f];
      const n = face.length;
      const [i, j] = [face.indexOf(a), face.indexOf(b)];
      if (!inner.length && ((i + 1) % n === j || (j + 1) % n === i)) continue;
      const arc = (from: number, to: number) => {
        const result: number[] = [];
        for (let k = from; ; k = (k + 1) % n) {
          result.push(face[k]);
          if (k === to) return result;
        }
      };
      faces = [
        ...faces.slice(0, f),
        [...arc(i, j), ...[...inner].reverse()],
        [...arc(j, i), ...inner],
        ...faces.slice(f + 1),
      ];
    }
    const limit = Math.max((parentArea / patch.size) * collapsedFraction, tinyArea);
    const triangles: number[][] = [];
    const reference = new Float64Array(3);
    for (const face of faces) {
      if (face.length < 3) return null;
      let side = 0;
      for (const node of face) {
        if (node < 0 || isZero(node)) continue;
        const sign = Math.sign(valueOf(node));
        if (!sign) continue;
        if (side && sign !== side) return null;
        side = sign;
      }
      const centre = [0, 0, 0];
      for (const node of face) {
        nodeAt(node, p);
        for (let a = 0; a < 3; a++) centre[a] += p[a] / face.length;
      }
      // The plane the face is laid out in: the surface's on its side, else the face's own.
      let normal = [0, 0, 0];
      if (side) {
        facing!(centre[0], centre[1], centre[2], side as 1 | -1, reference);
        normal = [reference[0], reference[1], reference[2]];
      } else
        for (let k = 1; k + 1 < face.length; k++) {
          const n = normalOf([face[0], face[k], face[k + 1]]);
          for (let a = 0; a < 3; a++) normal[a] += n[a];
        }
      const helper = Math.abs(normal[0]) < 0.9 * Math.hypot(...normal) ? [1, 0, 0] : [0, 1, 0];
      const u = crossOf(normal, helper);
      const v = crossOf(normal, u);
      const xy = face.flatMap((node) => {
        nodeAt(node, p);
        return [dot3(p, u), dot3(p, v)];
      });
      // A triangle needs a corner off the chain, so the chain edges on it can tell their sides.
      const chained = (node: number) => node < 0 || isZero(node);
      // A triangle's smallest angle, or NaN when it collapses or faces against the surface.
      const scored = (nodes: number[]) => {
        const n = normalOf(nodes);
        if (Math.hypot(...n) / 2 < limit) return NaN;
        if (side) {
          facing!(
            (p[0] + q[0] + r[0]) / 3,
            (p[1] + q[1] + r[1]) / 3,
            (p[2] + q[2] + r[2]) / 3,
            side as 1 | -1,
            reference,
          );
          if ((mesh.flipped ? -1 : 1) * dot3(n, reference) <= 0) return NaN;
        }
        return smallestAngle(nodes);
      };
      const worst = (list: number[][]) =>
        Math.min(...list.map((corners) => scored(corners.map((k) => face[k]))));
      let best = clipEars(xy, face.map(chained), (a, b, c) =>
        smallestAngle([face[a], face[b], face[c]]),
      );
      // A small face the plane cannot lay out, or laid out badly, is tried every way.
      if ((!best || Number.isNaN(worst(best))) && face.length <= wholeFace) {
        let score = -Infinity;
        best = null;
        for (const option of fans(0, face.length - 1)) {
          if (option.some((corners) => corners.every((k) => chained(face[k])))) continue;
          const least = worst(option);
          if (least > score) [best, score] = [option, least];
        }
      }
      if (!best || Number.isNaN(worst(best))) return null;
      for (const corners of best) triangles.push(corners.map((k) => face[k]));
    }
    return { faces: triangles, dropped };
  };
  // A patch grown from `seed` by the triangles across its edges around the chain, round by round,
  // never leaving a vertex off the chain inside it; a patch made earlier that it reaches is taken in.
  const buildPatch = (seed: Set<number>, made: Patch[]): Patch | null => {
    const patch = new Set(seed);
    const taken = new Set<Patch>();
    for (let round = 0; ; round++) {
      const built = tryPatch(patch);
      if (built) {
        for (const old of taken) made.splice(made.indexOf(old), 1);
        return { triangles: patch, ...built };
      }
      if (round === patchRounds) return null;
      const added: number[] = [];
      for (const t of [...patch]) {
        const c = cornersOf(t);
        for (let k = 0; k < 3; k++) {
          const u = across(t, c[k], c[(k + 1) % 3]);
          if (u < 0 || patch.has(u) || !checked.has(u)) continue;
          // A corner without a field ends the chain; the patch stops short of it.
          if (cornersOf(u).some((v) => Number.isNaN(valueOf(v)))) continue;
          patch.add(u);
          added.push(u);
        }
      }
      if (!added.length) return null;
      for (const u of added)
        for (const v of cornersOf(u)) {
          if (isZero(v)) continue;
          let inside = true;
          for (let i = triangleStart[v]; i < triangleStart[v + 1] && inside; i++)
            inside = patch.has(trianglesOf[i]);
          if (inside) patch.delete(u);
        }
      for (const old of made)
        if ([...old.triangles].some((t) => patch.has(t))) {
          taken.add(old);
          for (const t of old.triangles) patch.add(t);
        }
    }
  };
  // Each face of a patch belongs to one triangle of the patch as it stands before the rebuild, so a
  // painted triangle keeps its own footprint: faces are taken nearest pair first, each going to the
  // nearest triangle to its centroid that has room, a triangle's room being its share, by its own
  // area, of the faces' area; a face no triangle has room for goes to the nearest. A triangle left
  // with none then takes the face nearest its own centroid from one that has more than one.
  const ownersOf = (patch: Patch) => {
    const parents = [...patch.triangles].sort((a, b) => a - b);
    const at = parents.map((t) =>
      cornersOf(t).map((v) => [0, 1, 2].map((a) => mesh.position[v * 3 + a])),
    );
    const areaOf = (q: number[][]) =>
      Math.hypot(
        ...crossOf(
          [q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]],
          [q[2][0] - q[0][0], q[2][1] - q[0][1], q[2][2] - q[0][2]],
        ),
      ) / 2;
    const corners = patch.faces.map((face) => face.map((node) => nodeAt(node, [0, 0, 0])));
    const centres = corners.map((q) => [0, 1, 2].map((a) => (q[0][a] + q[1][a] + q[2][a]) / 3));
    const faceArea = corners.map(areaOf);
    const parentArea = at.map(areaOf);
    const scale =
      faceArea.reduce((x, y) => x + y, 0) / (parentArea.reduce((x, y) => x + y, 0) || 1);
    const room = parentArea.map((a) => a * scale);
    const distance = centres.map((c) => at.map(([a, b, d]) => triangleDistance(c, a, b, d)));
    const pairs: number[][] = [];
    distance.forEach((row, f) => row.forEach((d, k) => pairs.push([d, f, k])));
    pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    const owners = new Array<number>(centres.length).fill(-1);
    const load = parents.map(() => 0);
    for (const [, f, k] of pairs) {
      if (owners[f] >= 0 || (load[k] > 0 && load[k] + faceArea[f] > room[k])) continue;
      owners[f] = k;
      load[k] += faceArea[f];
    }
    owners.forEach((k, f) => {
      if (k < 0) owners[f] = distance[f].indexOf(Math.min(...distance[f]));
    });
    const count = parents.map((_, k) => owners.filter((o) => o === k).length);
    parents.forEach((_, k) => {
      if (count[k]) return;
      const own = [0, 1, 2].map((a) => (at[k][0][a] + at[k][1][a] + at[k][2][a]) / 3);
      let best = -1,
        least = Infinity;
      centres.forEach((c, f) => {
        if (count[owners[f]] < 2) return;
        const d = (c[0] - own[0]) ** 2 + (c[1] - own[1]) ** 2 + (c[2] - own[2]) ** 2;
        if (d < least) [least, best] = [d, f];
      });
      if (best < 0) return;
      count[owners[best]]--;
      owners[best] = k;
      count[k] = 1;
    });
    return owners.map((k) => parents[k]);
  };
  const saved = [zero, placed, splitT, splitAt, flat, splitCreased].map((list) => list.slice());
  const restore = () =>
    [zero, placed, splitT, splitAt, flat, splitCreased].forEach((list, k) =>
      list.set(saved[k] as never),
    );
  let patches: Patch[] = [];
  for (;;) {
    for (let revised = true; revised;) {
      revised = false;
      for (const t of touched) {
        if (patched.has(t)) continue;
        for (let k = 0; k < 3; k++) w[k] = mesh.weldOf[mesh.corners[t * 3 + k]];
        const cut = cutOf();
        if (cut.length === 0 && !w.some(isPlaced)) continue;
        for (let k = 0; k < 3; k++)
          for (let axis = 0; axis < 3; axis++)
            points[k * 3 + axis] = mesh.position[w[k] * 3 + axis];
        const limit = Math.max(area(points, parentNormal) * collapsedFraction, tinyArea);
        for (const child of divide(cut, far)) {
          child.forEach((ref, k) => pointOf(ref, points, k * 3));
          const collapsed = area(points, childNormal) < limit;
          // A child of flat splits and corners left where they are lies in its parent's plane.
          const level = child.every((ref) =>
            ref >= 3 ? flat[splitOf(corner(ref), corner(ref + 1))] === 1 : !isPlaced(corner(ref)),
          );
          if (level && !collapsed) continue;
          const side = facing ? sideOf(child) : 0;
          let reference = parentNormal;
          if (side !== 0) {
            facing!(
              (points[0] + points[3] + points[6]) / 3,
              (points[1] + points[4] + points[7]) / 3,
              (points[2] + points[5] + points[8]) / 3,
              side,
              facingNormal,
            );
            if (mesh.flipped) for (let a = 0; a < 3; a++) facingNormal[a] = -facingNormal[a];
            reference = facingNormal;
          }
          const reversed =
            childNormal[0] * reference[0] +
              childNormal[1] * reference[1] +
              childNormal[2] * reference[2] <
            0;
          if ((collapsed || reversed) && revise(child, t)) {
            revised = true;
            break;
          }
        }
      }
      if (!revised) revised = reviseCoincident();
    }
    patches = [];
    let failed = false;
    for (const cluster of clustersOf(patched)) {
      const patch = buildPatch(cluster, patches);
      if (patch) patches.push(patch);
      else {
        for (const t of cluster) unpatched.add(t);
        failed = true;
      }
    }
    if (!failed) break;
    restore();
    patched.clear();
  }
  for (const patch of patches) patch.owners = ownersOf(patch);
  const inPatch = new Set(patches.flatMap((patch) => [...patch.triangles]));
  for (const patch of patches) for (const i of patch.dropped) splitT[i] = NaN;
  const chain: number[] = [];
  const splits = new Map<number, Split>();
  for (let i = 0; i < edgeT.length; i++) {
    if (Number.isNaN(splitT[i])) continue;
    const welded = addWeldedVertex(mesh, splitAt[i * 3], splitAt[i * 3 + 1], splitAt[i * 3 + 2]);
    mesh.crease[welded] = splitCreased[i];
    splits.set(edgeA[i] * weldedCount + edgeB[i], { welded, t: splitT[i] });
  }
  for (let k = 0; k < count; k++) {
    if (!zero[k]) continue;
    const v = welded[k];
    if (stationary?.has(v)) {
      chain.push(v);
      mesh.crease[v] = creased[k];
      continue;
    }
    if (placed[k]) moveVertex(mesh, v, placedAt[k * 3], placedAt[k * 3 + 1], placedAt[k * 3 + 2]);
    mesh.touched[v] = 1;
    mesh.crease[v] = creased[k];
    chain.push(v);
  }
  for (const split of splits.values()) chain.push(split.welded);

  // One geometry vertex per split welded edge and pair of end geometry vertices.
  const created = new Map<number, number>();
  const size = mesh.colorSize;
  const color = new Float32Array(size);
  const splitVertex = (ga: number, gb: number): number => {
    let wa = mesh.weldOf[ga],
      wb = mesh.weldOf[gb];
    if (wa > wb) {
      [ga, gb] = [gb, ga];
      [wa, wb] = [wb, wa];
    }
    const key = ga * vertexCount + gb;
    let vertex = created.get(key);
    if (vertex !== undefined) return vertex;
    const split = splits.get(wa * weldedCount + wb)!;
    if (mesh.color)
      for (let k = 0; k < size; k++)
        color[k] = mesh.color[ga * size + k] * (1 - split.t) + mesh.color[gb * size + k] * split.t;
    vertex = addGeometryVertex(mesh, split.welded, color);
    created.set(key, vertex);
    return vertex;
  };

  const children = new Map<number, number[]>();
  const g = [0, 0, 0];
  const vertexOf = (ref: number) => (ref < 3 ? g[ref] : splitVertex(g[ref - 3], g[(ref - 2) % 3]));
  const distance = (p: number, q: number) => {
    // Resolving a split vertex can grow the weld map.
    const vp = vertexOf(p),
      vq = vertexOf(q);
    const a = mesh.weldOf[vp] * 3,
      b = mesh.weldOf[vq] * 3;
    return Math.hypot(
      mesh.position[a] - mesh.position[b],
      mesh.position[a + 1] - mesh.position[b + 1],
      mesh.position[a + 2] - mesh.position[b + 2],
    );
  };
  // Only a triangle around a split edge's lower end can be cut.
  // A patch's triangles keep their corners until the patch is written.
  const geometryOf = new Map<number, number>();
  for (const t of inPatch)
    for (let k = 0; k < 3; k++)
      geometryOf.set(mesh.weldOf[mesh.corners[t * 3 + k]], mesh.corners[t * 3 + k]);
  const edgeGeometry = (a: number, b: number) => {
    for (const t of inPatch) {
      const c = [0, 1, 2].map((k) => mesh.corners[t * 3 + k]);
      const ka = c.findIndex((x) => mesh.weldOf[x] === a),
        kb = c.findIndex((x) => mesh.weldOf[x] === b);
      if (ka >= 0 && kb >= 0) return [c[ka], c[kb]];
    }
    return null;
  };
  for (const t of Uint32Array.from(touched).sort()) {
    if (inPatch.has(t)) continue;
    for (let k = 0; k < 3; k++) {
      g[k] = mesh.corners[t * 3 + k];
      w[k] = mesh.weldOf[g[k]];
    }
    const cut = cutOf();
    if (cut.length === 0) continue;
    const pieces = divide(cut, distance).map((child) => child.map(vertexOf));
    setTriangle(mesh, t, pieces[0][0], pieces[0][1], pieces[0][2]);
    children.set(t, [t, ...pieces.slice(1).map(([a, b, c]) => addTriangle(mesh, a, b, c))]);
  }

  for (const patch of patches) {
    const ids = [...patch.triangles].sort((a, b) => a - b);
    const corners = patch.faces.map((face) =>
      face.map((node) => {
        if (node >= 0) return geometryOf.get(node)!;
        const [ga, gb] = edgeGeometry(edgeA[-node - 1], edgeB[-node - 1])!;
        return splitVertex(ga, gb);
      }),
    );
    // Each triangle's first face takes its id; the rest are added.
    const owned = new Map<number, number[]>(ids.map((t) => [t, []]));
    corners.forEach(([a, b, c], k) => {
      const owner = patch.owners![k];
      const list = owned.get(owner)!;
      if (list.length === 0) {
        setTriangle(mesh, owner, a, b, c);
        list.push(owner);
      } else list.push(addTriangle(mesh, a, b, c));
    });
    for (const [t, list] of owned) children.set(t, list);
  }
  // A stationary chain vertex is touched only where a triangle around it was split.
  if (stationary)
    for (const v of chain) {
      if (!stationary.has(v)) continue;
      for (let i = triangleStart[v]; i < triangleStart[v + 1] && !mesh.touched[v]; i++)
        if (children.has(trianglesOf[i])) mesh.touched[v] = 1;
    }

  // Sides after the cut: chain vertices are on the zero set, other vertices keep their field sign.
  const total = mesh.weldedCount;
  const onChain = new Set<number>(chain);
  const side = (v: number) => (onChain.has(v) || v >= weldedCount ? 0 : Math.sign(valueOf(v)) || 0);
  const thirds = new Map<number, number[]>();
  const skipped: number[] = [];
  const s = [0, 0, 0];
  // Only a triangle with two band vertices, or one the cut added, can straddle or hold a chain edge.
  const nearCut = new Set<number>();
  for (const v of welded)
    for (let i = triangleStart[v]; i < triangleStart[v + 1]; i++) nearCut.add(trianglesOf[i]);
  for (let t = triangleCount; t < mesh.triangleCount; t++) nearCut.add(t);
  for (const t of Uint32Array.from(nearCut).sort()) {
    for (let k = 0; k < 3; k++) {
      w[k] = mesh.weldOf[mesh.corners[t * 3 + k]];
      s[k] = side(w[k]);
    }
    if (s.includes(1) && s.includes(-1)) skipped.push(t);
    for (let k = 0; k < 3; k++) {
      const a = w[k],
        b = w[(k + 1) % 3];
      if (!onChain.has(a) || !onChain.has(b)) continue;
      const key = Math.min(a, b) * total + Math.max(a, b);
      const c = w[(k + 2) % 3];
      const third =
        s[(k + 2) % 3] || (beside && !onChain.has(c) && c < weldedCount ? beside(c) : 0);
      const list = thirds.get(key);
      if (list) list.push(third);
      else thirds.set(key, [third]);
    }
  }
  // The zero set runs along a chain edge only when the triangles on it lie on opposite sides.
  const edges: number[] = [];
  for (const [key, list] of thirds)
    if (list.length === 2 && list[0] * list[1] < 0)
      edges.push(Math.floor(key / total), key % total);

  return {
    chain: Uint32Array.from(chain),
    edges: Uint32Array.from(edges),
    children,
    skipped: Uint32Array.from(skipped),
  };
}

/** Replaces split triangles in a painted set with their children. */
export function remapTriangles(
  triangles: Uint32Array,
  children: Map<number, number[]>,
): Uint32Array {
  const result: number[] = [];
  for (const t of triangles) result.push(...(children.get(t) ?? [t]));
  return Uint32Array.from(new Set(result)).sort();
}
