import type { BufferGeometry } from 'three';
import { type RefineMesh, vertexNormal, weldedCorner } from '../../src/core/refine-mesh';
import { type SurfaceSample, modelOf } from './refine';
import { trianglesWhere } from './refine-region';

/** Distance of (x, y, z) from the surface of `softElbow(bend, tube)`'s torus. */
export const torusOffset = (x: number, y: number, z: number, bend: number, tube: number) =>
  Math.hypot(Math.hypot(x, z) - bend, y) - tube;

/** Distance of welded vertex `v` of `mesh` from the torus of `softElbow(bend, tube)`. */
export const torusDistance = (mesh: RefineMesh, v: number, bend: number, tube: number) =>
  Math.abs(
    torusOffset(
      mesh.position[v * 3],
      mesh.position[v * 3 + 1],
      mesh.position[v * 3 + 2],
      bend,
      tube,
    ),
  );

export const mean = (values: ArrayLike<number>) =>
  Array.from(values).reduce((a, b) => a + b, 0) / values.length;

/** Triangles of a `softElbow`'s curved tube: every triangle but those of its two flat end caps. */
export function tubeTriangles(mesh: RefineMesh) {
  const cap = (x: number, z: number) => x < 0.02 || z < 0.02;
  const kept: number[] = [];
  const normal = [0, 0, 0];
  for (let t = 0; t < mesh.triangleCount; t++) {
    const [a, b, c] = ([0, 1, 2] as const).map((k) =>
      [0, 1, 2].map((axis) => mesh.position[weldedCorner(mesh, t, k) * 3 + axis]),
    );
    const u = [0, 1, 2].map((k) => b[k] - a[k]),
      w = [0, 1, 2].map((k) => c[k] - a[k]);
    normal[0] = u[1] * w[2] - u[2] * w[1];
    normal[1] = u[2] * w[0] - u[0] * w[2];
    normal[2] = u[0] * w[1] - u[1] * w[0];
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    const flatCap =
      cap(a[0], a[2]) &&
      cap(b[0], b[2]) &&
      cap(c[0], c[2]) &&
      Math.max(Math.abs(normal[0]), Math.abs(normal[2])) > 0.9 * length;
    if (!flatCap) kept.push(t);
  }
  return Uint32Array.from(kept);
}

/**
 * Welded vertices of a `softElbow`'s tube clear of its end caps (x and z over 0.05) that `keep`
 * accepts, with their area-weighted normals.
 */
export function elbowSurface(
  geometry: BufferGeometry,
  keep: (x: number, y: number, z: number) => boolean = () => true,
): SurfaceSample {
  const { mesh, topology } = modelOf(geometry);
  const points: number[] = [],
    normals: number[] = [];
  const normal = new Float32Array(3);
  for (let v = 0; v < mesh.weldedCount; v++) {
    const [x, y, z] = mesh.position.subarray(v * 3, v * 3 + 3);
    if (x < 0.05 || z < 0.05 || !keep(x, y, z)) continue;
    vertexNormal(mesh, topology, v, normal);
    points.push(x, y, z);
    normals.push(...normal);
  }
  return [new Float32Array(points), new Float32Array(normals)];
}

/** The sample with the points of `b` appended. */
export const joined = (a: SurfaceSample, b: SurfaceSample): SurfaceSample => [
  Float32Array.from([...a[0], ...b[0]]),
  Float32Array.from([...a[1], ...b[1]]),
];

/** The sample turned half a turn about the vertical line through (x, z). */
export const halfTurned = (
  [points, normals]: SurfaceSample,
  x: number,
  z: number,
): SurfaceSample => [
  points.map((p, i) => (i % 3 === 1 ? p : 2 * (i % 3 === 0 ? x : z) - p)),
  normals.map((n, i) => (i % 3 === 1 ? n : -n)),
];

/** Triangles of `mesh` whose centroid `keep` accepts, among the elbow's tube triangles. */
export const tubeTrianglesWhere = (
  mesh: RefineMesh,
  keep: (x: number, y: number, z: number) => boolean,
) => {
  const tube = new Set(tubeTriangles(mesh));
  return trianglesWhere(mesh, keep).filter((t) => tube.has(t));
};

/**
 * Points around a straight tube of `radius` from `from` to `to`, `step` apart along it and around
 * it, each moved along its normal by a seeded uniform offset of up to `noise`.
 */
export function straightTube(
  from: [number, number, number],
  to: [number, number, number],
  radius: number,
  step = 0.06,
  noise = 0.004,
  seed = 7,
): SurfaceSample {
  const axis = [0, 1, 2].map((k) => to[k] - from[k]);
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  const t = axis.map((v) => v / length);
  const helper = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const h = helper[0] * t[0] + helper[1] * t[1] + helper[2] * t[2];
  const u0 = helper.map((v, k) => v - h * t[k]);
  const ul = Math.hypot(u0[0], u0[1], u0[2]);
  const u = u0.map((v) => v / ul);
  const v = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
  let state = seed;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296) * 2 - 1;
  };
  const points: number[] = [],
    normals: number[] = [];
  const rings = Math.round(length / step),
    around = Math.round((2 * Math.PI * radius) / step);
  for (let i = 0; i <= rings; i++)
    for (let j = 0; j < around; j++) {
      const angle = (2 * Math.PI * (j + 0.5 * (i % 2))) / around;
      const n = [0, 1, 2].map((k) => Math.cos(angle) * u[k] + Math.sin(angle) * v[k]);
      const r = radius + noise * random();
      for (let k = 0; k < 3; k++) points.push(from[k] + (axis[k] * i) / rings + r * n[k]);
      normals.push(...n);
    }
  return [new Float32Array(points), new Float32Array(normals)];
}
