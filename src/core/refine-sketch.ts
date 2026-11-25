import type { GuidePoint } from './refine-band';
import { type RefineMesh, type RefineTopology, weldedCorner } from './refine-mesh';
import type { Vec3 } from './types';

/**
 * A sketch plane of a Refine session: an origin, a unit normal and unit in-plane axes `u` and `v`
 * (v = normal x u). Guides drawn on it keep their points in it.
 */
export interface SketchPlane {
  id: string;
  /** Shown as Plane 1, Plane 2, and so on, in the order the session made them. */
  name: string;
  origin: Vec3;
  normal: Vec3;
  u: Vec3;
  v: Vec3;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: ArrayLike<number>): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

/** A plane through `origin` with `normal`, `u` along `along` taken into the plane. Null when `along` is along the normal. */
export function planeOf(
  id: string,
  name: string,
  origin: ArrayLike<number>,
  normal: ArrayLike<number>,
  along: ArrayLike<number>,
): SketchPlane | null {
  const n = unit(normal);
  const t = dot(along, n);
  const inPlane = [along[0] - t * n[0], along[1] - t * n[1], along[2] - t * n[2]];
  if (!(Math.hypot(inPlane[0], inPlane[1], inPlane[2]) > 1e-9)) return null;
  const u = unit(inPlane);
  return { id, name, origin: [origin[0], origin[1], origin[2]], normal: n, u, v: cross(n, u) };
}

/** The plane through three points, `u` from the first to the second. Null when they are collinear. */
export function planeThrough(id: string, name: string, a: Vec3, b: Vec3, c: Vec3) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = cross(ab, ac);
  const scale = Math.hypot(...ab) * Math.hypot(...ac);
  if (!(Math.hypot(n[0], n[1], n[2]) > 1e-6 * scale) || !(scale > 0)) return null;
  return planeOf(id, name, a, n, ab);
}

/** The point of the plane nearest `p`. */
export function ontoPlane(plane: SketchPlane, p: ArrayLike<number>): Vec3 {
  const { origin, normal } = plane;
  const h =
    (p[0] - origin[0]) * normal[0] +
    (p[1] - origin[1]) * normal[1] +
    (p[2] - origin[2]) * normal[2];
  return [p[0] - h * normal[0], p[1] - h * normal[1], p[2] - h * normal[2]];
}

/** `p` in the plane's (u, v) coordinates. */
export function planeCoordinates(plane: SketchPlane, p: ArrayLike<number>): [number, number] {
  const d = [p[0] - plane.origin[0], p[1] - plane.origin[1], p[2] - plane.origin[2]];
  return [dot(d, plane.u), dot(d, plane.v)];
}

/** The world point at (u, v) in the plane. */
export function planePoint(plane: SketchPlane, u: number, v: number): Vec3 {
  const { origin: o, u: a, v: b } = plane;
  return [o[0] + u * a[0] + v * b[0], o[1] + u * a[1] + v * b[1], o[2] + u * a[2] + v * b[2]];
}

/** Where a ray meets the plane, or null when it runs along it or the plane lies behind it. */
export function rayOnPlane(
  plane: SketchPlane,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
): Vec3 | null {
  const along = dot(direction, plane.normal);
  if (Math.abs(along) < 1e-9) return null;
  const d = [plane.origin[0] - origin[0], plane.origin[1] - origin[1], plane.origin[2] - origin[2]];
  const t = dot(d, plane.normal) / along;
  if (!(t >= 0)) return null;
  return [origin[0] + t * direction[0], origin[1] + t * direction[1], origin[2] + t * direction[2]];
}

/**
 * The normal of the plane that best fits `points` (xyz), or null when they lie near one line: the
 * normal is the axis of least spread, given a middle spread of at least a tenth of the largest, in
 * standard deviation.
 */
export function bestPlaneNormal(points: ArrayLike<number>): Vec3 | null {
  const n = points.length / 3;
  if (n < 3) return null;
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) c[a] += points[i * 3 + a] / n;
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const d = [0, 1, 2].map((a) => points[i * 3 + a] - c[a]);
    for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) m[r * 3 + s] += d[r] * d[s];
  }
  // Power iteration for the largest axis, then for the largest in the plane across it.
  const largest = (deflate: Vec3[]) => {
    let x: number[] = [0.577, 0.578, 0.579];
    for (let k = 0; k < 100; k++) {
      for (const q of deflate) {
        const t = dot(x, q);
        x = x.map((value, a) => value - t * q[a]);
      }
      const y = [0, 1, 2].map((r) => m[r * 3] * x[0] + m[r * 3 + 1] * x[1] + m[r * 3 + 2] * x[2]);
      const length = Math.hypot(y[0], y[1], y[2]);
      if (!(length > 0)) return { axis: unit(x), spread: 0 };
      x = y.map((value) => value / length);
    }
    const y = [0, 1, 2].map((r) => m[r * 3] * x[0] + m[r * 3 + 1] * x[1] + m[r * 3 + 2] * x[2]);
    return { axis: unit(x), spread: dot(x, y) };
  };
  const first = largest([]);
  const second = largest([first.axis]);
  if (!(first.spread > 0) || second.spread < 0.01 * first.spread) return null;
  return unit(cross(first.axis, second.axis));
}

/** The point of triangle (a, b, c) nearest p (Ericson's regions). */
export function closestOnTriangle(
  p: ArrayLike<number>,
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  c: ArrayLike<number>,
): Vec3 {
  const sub = (x: ArrayLike<number>, y: ArrayLike<number>) => [
    x[0] - y[0],
    x[1] - y[1],
    x[2] - y[2],
  ];
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a);
  const along = (s: ArrayLike<number>, t: number[], f: number): Vec3 => [
    s[0] + t[0] * f,
    s[1] + t[1] * f,
    s[2] + t[2] * f,
  ];
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [a[0], a[1], a[2]];
  const bp = sub(p, b);
  const d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [b[0], b[1], b[2]];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return along(a, ab, d1 / (d1 - d3));
  const cp = sub(p, c);
  const d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [c[0], c[1], c[2]];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return along(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
    return along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  const denom = 1 / (va + vb + vc);
  const v = vb * denom,
    w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/** Rings of triangles `nearestOnSurface` always searches round a point's own triangle. */
const surfaceRings = 3;
/** Most rings it searches while the nearest point keeps moving. */
const surfaceRingsMost = 64;

/**
 * The surface point nearest a guide point, and its triangle: searched from the point's own triangle
 * outward over shared vertices, `surfaceRings` rings and on while each ring finds a nearer point. The
 * point's triangle must be the nearest, or near it.
 */
export function nearestOnSurface(
  mesh: RefineMesh,
  topology: RefineTopology,
  point: GuidePoint,
): GuidePoint {
  const { position } = mesh;
  const corner = (t: number, k: 0 | 1 | 2) => {
    const w = weldedCorner(mesh, t, k) * 3;
    return position.subarray(w, w + 3);
  };
  const p = point.position;
  let best: GuidePoint = point,
    nearest = Infinity;
  const seen = new Set<number>([point.triangle]);
  let ring = [point.triangle];
  for (let r = 0; ring.length && r <= surfaceRingsMost; r++) {
    let improved = false;
    for (const t of ring) {
      const q = closestOnTriangle(p, corner(t, 0), corner(t, 1), corner(t, 2));
      const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      if (d < nearest) {
        nearest = d;
        best = { triangle: t, position: q };
        improved = true;
      }
    }
    if (r >= surfaceRings && !improved) break;
    const next: number[] = [];
    for (const t of ring)
      for (const k of [0, 1, 2] as const) {
        const w = weldedCorner(mesh, t, k);
        for (let i = topology.triangleStart[w]; i < topology.triangleStart[w + 1]; i++) {
          const u = topology.trianglesOf[i];
          if (!seen.has(u)) {
            seen.add(u);
            next.push(u);
          }
        }
      }
    ring = next;
  }
  return best;
}

/** How a guide point is held: sliding along a line through `origin` along unit `direction`, or fixed. */
export type PointLock = { kind: 'line'; origin: Vec3; direction: Vec3 } | { kind: 'fixed' };

/** The point of the line nearest `p`. */
export function ontoLine(lock: Extract<PointLock, { kind: 'line' }>, p: ArrayLike<number>): Vec3 {
  const { origin: o, direction: d } = lock;
  const t = (p[0] - o[0]) * d[0] + (p[1] - o[1]) * d[1] + (p[2] - o[2]) * d[2];
  return [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
}

/** The line lock through two points, or null when they coincide. */
export function lineThrough(a: ArrayLike<number>, b: ArrayLike<number>): PointLock | null {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  if (!(Math.hypot(d[0], d[1], d[2]) > 1e-9)) return null;
  return { kind: 'line', origin: [a[0], a[1], a[2]], direction: unit(d) };
}

/** The point of the line nearest a ray: where the ray passes closest to it. */
export function lineNearRay(
  lock: Extract<PointLock, { kind: 'line' }>,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
): Vec3 {
  const { origin: o, direction: d } = lock;
  const w = [o[0] - origin[0], o[1] - origin[1], o[2] - origin[2]];
  const b = dot(d, direction),
    c = dot(direction, direction),
    e = dot(d, w),
    f = dot(direction, w);
  const denominator = c - b * b;
  // Along the ray's direction the line has no nearest point; it stays at its origin.
  const t = Math.abs(denominator) < 1e-12 ? 0 : (b * f - c * e) / denominator;
  return [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
}

/**
 * Where a guide point asked to go to `p` may go: nowhere for a fixed point, the nearest point of its
 * line, else of its guide's plane, else `p`. A line lock on a guide with a plane is in that plane.
 */
export function heldPoint(
  lock: PointLock | undefined,
  plane: SketchPlane | null | undefined,
  from: Vec3,
  p: ArrayLike<number>,
): Vec3 {
  if (lock?.kind === 'fixed') return from;
  if (lock?.kind === 'line') return ontoLine(lock, p);
  if (plane) return ontoPlane(plane, p);
  return [p[0], p[1], p[2]];
}

/** A uniform grid of each triangle's centroid, for the triangle nearest a point. */
interface TriangleGrid {
  cell: number;
  min: Vec3;
  cells: Map<number, number[]>;
  /** Largest distance from a triangle's centroid to its corners. */
  reach: number;
}
const grids = new WeakMap<object, TriangleGrid>();

function gridOf(mesh: RefineMesh): TriangleGrid {
  const known = grids.get(mesh.position);
  if (known) return known;
  const { position, triangleCount } = mesh;
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < mesh.weldedCount; v++)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], position[v * 3 + a]);
      max[a] = Math.max(max[a], position[v * 3 + a]);
    }
  const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-6);
  const cell = Math.max(size / 256, Math.cbrt((size * size * size) / Math.max(1, triangleCount)));
  const cells = new Map<number, number[]>();
  let reach = 0;
  for (let t = 0; t < triangleCount; t++) {
    const c = [0, 0, 0];
    const corners = ([0, 1, 2] as const).map((k) => weldedCorner(mesh, t, k) * 3);
    for (const w of corners) for (let a = 0; a < 3; a++) c[a] += position[w + a] / 3;
    for (const w of corners)
      reach = Math.max(
        reach,
        Math.hypot(position[w] - c[0], position[w + 1] - c[1], position[w + 2] - c[2]),
      );
    const key = keyOf(
      Math.floor((c[0] - min[0]) / cell),
      Math.floor((c[1] - min[1]) / cell),
      Math.floor((c[2] - min[2]) / cell),
    );
    const list = cells.get(key);
    if (list) list.push(t);
    else cells.set(key, [t]);
  }
  const grid = { cell, min, cells, reach };
  grids.set(mesh.position, grid);
  return grid;
}
/** Rings of cells searched before a point is taken to be far from the part. */
const nearRings = 8;
const keyOf = (i: number, j: number, k: number) => (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);

/**
 * The surface point nearest `p` and its triangle, over the whole mesh: the triangles whose centroids
 * lie in rings of grid cells about it, until no nearer one can remain, then refined over its
 * neighbours. Null on an empty mesh.
 */
export function nearestTriangle(
  mesh: RefineMesh,
  topology: RefineTopology,
  p: ArrayLike<number>,
): GuidePoint | null {
  if (!mesh.triangleCount) return null;
  const grid = gridOf(mesh);
  const { cell, min, cells, reach } = grid;
  const { position } = mesh;
  const at = [0, 1, 2].map((a) => Math.floor((p[a] - min[a]) / cell));
  let best = -1,
    nearest = Infinity;
  const corner = (t: number, k: 0 | 1 | 2) => {
    const w = weldedCorner(mesh, t, k) * 3;
    return position.subarray(w, w + 3);
  };
  const consider = (t: number) => {
    const q = closestOnTriangle(p, corner(t, 0), corner(t, 1), corner(t, 2));
    const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (d < nearest || (d === nearest && t < best)) [nearest, best] = [d, t];
  };
  for (let r = 0; ; r++) {
    // Every triangle with a point within `nearest` has its centroid within nearest + reach.
    if (best >= 0 && (r - 1) * cell > nearest + reach) break;
    if (best < 0 && r > nearRings) {
      // Far from the part: every triangle, once.
      for (let t = 0; t < mesh.triangleCount; t++) consider(t);
      break;
    }
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++)
        for (let k = -r; k <= r; k++) {
          if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== r) continue;
          for (const t of cells.get(keyOf(at[0] + i, at[1] + j, at[2] + k)) ?? []) consider(t);
        }
  }
  if (best < 0) return null;
  return nearestOnSurface(mesh, topology, { triangle: best, position: [p[0], p[1], p[2]] });
}

/** A guide point at `p` itself, on the triangle nearest it. */
export function pointAt(mesh: RefineMesh, topology: RefineTopology, p: ArrayLike<number>) {
  const found = nearestTriangle(mesh, topology, p);
  return found && { triangle: found.triangle, position: [p[0], p[1], p[2]] as Vec3 };
}

/**
 * The plane fitted to the surface within `radius` of a clicked point, over the triangles joined to
 * the clicked one: through their area-weighted centroid, with the normal of least spread facing as
 * the clicked triangle does, and `u` along the spread's longest axis. Null where the surface there
 * is not flat to a tenth of the radius.
 */
export function planeOfFace(
  mesh: RefineMesh,
  topology: RefineTopology,
  point: GuidePoint,
  radius: number,
  id: string,
  name: string,
): SketchPlane | null {
  const { position } = mesh;
  const p = point.position;
  const seen = new Set<number>([point.triangle]);
  const queue = [point.triangle];
  const flat: number[] = [];
  for (let q = 0; q < queue.length; q++) {
    const t = queue[q];
    const corners = ([0, 1, 2] as const).map((k) => weldedCorner(mesh, t, k));
    for (const w of corners) flat.push(position[w * 3], position[w * 3 + 1], position[w * 3 + 2]);
    for (const w of corners) {
      if (
        Math.hypot(position[w * 3] - p[0], position[w * 3 + 1] - p[1], position[w * 3 + 2] - p[2]) >
        radius
      )
        continue;
      for (let i = topology.triangleStart[w]; i < topology.triangleStart[w + 1]; i++) {
        const u = topology.trianglesOf[i];
        if (!seen.has(u)) {
          seen.add(u);
          queue.push(u);
        }
      }
    }
  }
  const normal = bestPlaneNormal(flat);
  if (!normal) return null;
  const n = flat.length / 3;
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) c[a] += flat[i * 3 + a] / n;
  let off = 0;
  for (let i = 0; i < n; i++)
    off = Math.max(
      off,
      Math.abs(
        dot(
          [0, 1, 2].map((a) => flat[i * 3 + a] - c[a]),
          normal,
        ),
      ),
    );
  if (off > radius / 10) return null;
  // The clicked triangle's own facing.
  const [a, b, d] = ([0, 1, 2] as const).map((k) => {
    const w = weldedCorner(mesh, point.triangle, k) * 3;
    return [position[w], position[w + 1], position[w + 2]];
  });
  const facing = cross(
    [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    [d[0] - a[0], d[1] - a[1], d[2] - a[2]],
  );
  const sign = dot(facing, normal) * (mesh.flipped ? -1 : 1) >= 0 ? 1 : -1;
  const oriented = normal.map((x) => x * sign);
  // The longest spread in the plane.
  let along: number[] = [1, 0, 0],
    widest = -1;
  for (let k = 0; k < 18; k++) {
    const angle = (k * Math.PI) / 18;
    const helper = Math.abs(oriented[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = unit(cross(oriented, helper));
    const e2 = cross(oriented, e1);
    const axis = e1.map((x, i) => Math.cos(angle) * x + Math.sin(angle) * e2[i]);
    let spread = 0;
    for (let i = 0; i < n; i++)
      spread +=
        dot(
          [0, 1, 2].map((a) => flat[i * 3 + a] - c[a]),
          axis,
        ) ** 2;
    if (spread > widest) [widest, along] = [spread, axis];
  }
  return planeOf(id, name, c, oriented, along);
}
