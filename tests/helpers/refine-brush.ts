import type { GuidePoint } from '../../src/core/refine-band';
import type { Dab } from '../../src/core/refine-brush';
import { type RefineMesh, type RefineTopology, weldedCorner } from '../../src/core/refine-mesh';
import type { Vec3 } from '../../src/core/types';
import { pointOn } from './refine';

const at = (mesh: RefineMesh, v: number): Vec3 => [
  mesh.position[v * 3],
  mesh.position[v * 3 + 1],
  mesh.position[v * 3 + 2],
];

/** A seeded generator, so a stroke is the same on every run. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A full-strength dab of 0.5 mm on the surface point nearest `p`. */
export function dabAt(mesh: RefineMesh, p: Vec3): Dab {
  const { triangle, position } = pointOn(mesh, p);
  return { triangle, center: position, radius: 0.5, strength: 1 };
}

/** Accepts points within `radius` of `center`. */
export const capAt =
  (center: Vec3, radius: number) =>
  (p: Vec3): boolean =>
    Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) < radius;

/** RMS of the distance from the origin about its mean, over the vertices `where` accepts. */
export function rippleAmplitude(mesh: RefineMesh, radius: number, where: (p: Vec3) => boolean) {
  const radii: number[] = [];
  for (let v = 0; v < mesh.weldedCount; v++) {
    const p = at(mesh, v);
    // Scale the point onto the sphere first, so the cap selects the same vertices before and after.
    const r = Math.hypot(...p);
    if (where(p.map((x) => (x / r) * radius) as Vec3)) radii.push(r);
  }
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  return Math.sqrt(radii.reduce((a, r) => a + (r - mean) ** 2, 0) / radii.length);
}

/** Welded vertices at least `radius` from `center` in `before` whose position bits differ in `after`. */
export function movedOutsideRadius(
  before: RefineMesh,
  after: RefineMesh,
  center: Vec3,
  radius: number,
) {
  let moved = 0;
  for (let v = 0; v < before.weldedCount; v++) {
    const p = at(before, v);
    if (Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) < radius) continue;
    if (!Object.is(p[0], after.position[v * 3])) moved++;
    else if (!Object.is(p[1], after.position[v * 3 + 1])) moved++;
    else if (!Object.is(p[2], after.position[v * 3 + 2])) moved++;
  }
  return moved;
}

/** Welded vertices whose position differs between the two positions arrays, ascending. */
export function movedBetween(before: Float64Array, after: Float64Array) {
  const moved: number[] = [];
  for (let v = 0; v < before.length / 3; v++)
    if ([0, 1, 2].some((a) => before[v * 3 + a] !== after[v * 3 + a])) moved.push(v);
  return moved;
}

const crossAt = (mesh: RefineMesh, position: Float64Array, t: number) => {
  const [a, b, c] = ([0, 1, 2] as const).map((k) => weldedCorner(mesh, t, k) * 3);
  const u = [0, 1, 2].map((k) => position[b + k] - position[a + k]),
    v = [0, 1, 2].map((k) => position[c + k] - position[a + k]);
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
};

/**
 * Triangles around `moved` that are zero-area at `after` or whose normal there opposes their normal
 * at `before`.
 */
export function brokenTriangles(
  mesh: RefineMesh,
  topology: RefineTopology,
  before: Float64Array,
  after: Float64Array,
  moved: ArrayLike<number>,
) {
  const seen = new Set<number>();
  let broken = 0;
  for (const v of Array.from(moved))
    for (let j = topology.triangleStart[v]; j < topology.triangleStart[v + 1]; j++) {
      const t = topology.trianglesOf[j];
      if (seen.has(t)) continue;
      seen.add(t);
      const was = crossAt(mesh, before, t),
        now = crossAt(mesh, after, t);
      if (Math.hypot(...now) === 0 || was[0] * now[0] + was[1] * now[1] + was[2] * now[2] < 0)
        broken++;
    }
  return broken;
}

/**
 * A freehand stroke along the crest of the top front edge of softBox([2, 1.5, 1], 0.3), from x =
 * `from` to `to`, a point every 0.1 mm, each pushed up to `jitter` mm across the edge and along it.
 */
export function jitteredCrest(
  mesh: RefineMesh,
  from: number,
  to: number,
  jitter: number,
  seed = 11,
): GuidePoint[] {
  const next = random(seed);
  const fillet = 0.3;
  const crest = fillet - fillet / Math.SQRT2;
  // Across the edge: along the fillet's arc at the crest, the direction (0, 1, -1) / sqrt(2).
  const across = Math.SQRT1_2;
  const count = Math.round((to - from) / 0.1);
  const stroke: GuidePoint[] = [];
  for (let i = 0; i <= count; i++) {
    const side = (2 * next() - 1) * jitter,
      along = (2 * next() - 1) * jitter;
    const p: Vec3 = [
      from + i * 0.1 + along,
      1.5 - crest + side * across,
      1 - crest - side * across,
    ];
    stroke.push(pointOn(mesh, p));
  }
  return stroke;
}
