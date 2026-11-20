import { BufferAttribute, BufferGeometry } from 'three';
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

type Vec = [number, number, number];
/** A centre line at t from 0 to 1: its point and two unit directions across it. */
export type TubePath = (t: number) => [point: Vec, u: Vec, v: Vec];
/** A cross-section's radius at `angle` from u toward v, at t along the path. */
export type CrossSection = (angle: number, t: number) => number;

/** A quarter turn of radius `bend` about the y axis, centred on the x axis. */
export const elbowPath =
  (bend: number): TubePath =>
  (t) => {
    const phi = ((t - 0.5) * Math.PI) / 2;
    return [
      [bend * Math.cos(phi), 0, bend * Math.sin(phi)],
      [Math.cos(phi), 0, Math.sin(phi)],
      [0, 1, 0],
    ];
  };
/** A straight line `length` long along z. */
export const straightPath =
  (length: number): TubePath =>
  (t) => [
    [0, 0, length * t],
    [1, 0, 0],
    [0, 1, 0],
  ];
/** Two quarter turns of radius 4 bending opposite ways, in the xy plane: about 6.3 long. */
export const sBendPath: TubePath = (t) => {
  const phi = ((t - 0.5) * Math.PI) / 2;
  const turn = Math.sign(phi);
  return [
    [4 * Math.sin(phi), 4 * turn * (1 - Math.cos(phi)), 0],
    [-turn * Math.sin(phi), Math.cos(phi), 0],
    [0, 0, 1],
  ];
};
/** One turn of a helix of radius 3 and pitch 8 about z: about 20.5 long. */
export const helixPath: TubePath = (t) => {
  const phi = (t - 0.5) * 2 * Math.PI;
  const axial = 8 / (2 * Math.PI);
  const norm = Math.hypot(3, axial);
  return [
    [3 * Math.cos(phi), 3 * Math.sin(phi), axial * phi],
    [Math.cos(phi), Math.sin(phi), 0],
    [(axial * Math.sin(phi)) / norm, (-axial * Math.cos(phi)) / norm, 3 / norm],
  ];
};
export const round: CrossSection = () => 1;
/** An ellipse `amount` wider along u and as much narrower along v. */
export const oval =
  (amount: number): CrossSection =>
  (angle) =>
    1 / Math.hypot(Math.cos(angle) / (1 + amount), Math.sin(angle) / (1 - amount));
/** A circle of radius 1 whose side toward v is cut flat 0.85 from the centre. */
export const flatSided: CrossSection = (angle) =>
  Math.sin(angle) > 0.85 ? 0.85 / Math.sin(angle) : 1;
/** A circle whose radius grows by `amount` from one end to the other. */
export const tapered =
  (amount: number): CrossSection =>
  (_, t) =>
    1 + amount * (t - 0.5);

/**
 * Rings of points 0.06 apart around a tube swept `length` along `path`, rings 0.06 apart, each
 * point moved out by a ripple of up to `ripple`. `interior` marks the points from 10% to 90% along.
 */
export function sweptTube(path: TubePath, length: number, radius: CrossSection, ripple = 0) {
  const steps = Math.ceil(length / 0.06),
    rings = Math.ceil((2 * Math.PI) / 0.06);
  const points: number[] = [],
    normals: number[] = [],
    interior: number[] = [],
    axis: Vec[] = [];
  for (let along = 0; along <= steps; along++) {
    const t = along / steps;
    const [c, u, v] = path(t);
    axis.push(c);
    for (let around = 0; around < rings; around++) {
      const angle = Math.PI / 2 + (around / rings - 0.5) * 2 * Math.PI;
      const r = radius(angle, t) + ripple * Math.sin(t * 46) * Math.cos(3 * angle + t * 11);
      const slope = (radius(angle + 1e-5, t) - radius(angle - 1e-5, t)) / 2e-5;
      for (let k = 0; k < 3; k++) {
        const out = Math.cos(angle) * u[k] + Math.sin(angle) * v[k];
        const turn = -Math.sin(angle) * u[k] + Math.cos(angle) * v[k];
        points.push(c[k] + r * out);
        normals.push((r * out - slope * turn) / Math.hypot(r, slope));
      }
      interior.push(t > 0.1 && t < 0.9 ? 1 : 0);
    }
  }
  return {
    points: Float32Array.from(points),
    normals: Float32Array.from(normals),
    interior: Uint8Array.from(interior),
    axis,
    rings,
    steps,
  };
}

/**
 * `sweptTube` closed by a fan at each end, as a model, and the triangles of the tube from four rings
 * in from either end: a region the user paints along it.
 */
export function sweptTubeModel(path: TubePath, length: number, radius: CrossSection, ripple = 0) {
  const { points, normals, axis, rings, steps } = sweptTube(path, length, radius, ripple);
  const vertices = [...points, ...axis[0], ...axis[steps]];
  const at = (i: number) => vertices.slice(i * 3, i * 3 + 3);
  const [p0, p1, pr] = [at(0), at(1), at(rings)];
  const a = [0, 1, 2].map((k) => p1[k] - p0[k]),
    b = [0, 1, 2].map((k) => pr[k] - p0[k]);
  const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const forward = cross[0] * normals[0] + cross[1] * normals[1] + cross[2] * normals[2] > 0;
  const indices: number[] = [],
    painted: number[] = [];
  const push = (x: number, y: number, z: number) =>
    indices.push(x, forward ? y : z, forward ? z : y);
  for (let row = 0; row < steps; row++)
    for (let col = 0; col < rings; col++) {
      const lower = row * rings + col,
        next = row * rings + ((col + 1) % rings);
      if (row >= 4 && row < steps - 4) painted.push(indices.length / 3, indices.length / 3 + 1);
      push(lower, next, lower + rings);
      push(next, next + rings, lower + rings);
    }
  for (let col = 0; col < rings; col++) {
    const next = (col + 1) % rings;
    push((steps + 1) * rings, next, col);
    push((steps + 1) * rings + 1, steps * rings + col, steps * rings + next);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(vertices), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return { model: modelOf(geometry), triangles: Uint32Array.from(painted) };
}
