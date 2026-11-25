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
 * smallest spread is the normal's when the middle spread is at least a tenth of the largest.
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
