import { Matrix4 } from 'three';
import type { GuidePoint } from '../../src/core/refine-band';
import type { GuideKind } from '../../src/core/refine-curve';
import { type EdgeInput, applyEdge, solveEdge } from '../../src/core/refine-edge';
import {
  type RefineMesh,
  type RefineTopology,
  cloneRefineMesh,
  weldedCorner,
} from '../../src/core/refine-mesh';
import type { RegionSolve } from '../../src/core/refine-region';
import { modelOf, pointOn } from './refine';
import { softBox } from './soft-edges';

type Model = ReturnType<typeof modelOf>;
const at = (mesh: RefineMesh, v: number) =>
  [0, 1, 2].map((a) => mesh.position[v * 3 + a]) as [number, number, number];

/** Triangles whose centroid `keep` accepts. */
export function trianglesWhere(
  mesh: RefineMesh,
  keep: (x: number, y: number, z: number) => boolean,
) {
  const kept: number[] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    const c = [0, 0, 0];
    for (const k of [0, 1, 2] as const) {
      const p = at(mesh, weldedCorner(mesh, t, k));
      for (let a = 0; a < 3; a++) c[a] += p[a] / 3;
    }
    if (keep(c[0], c[1], c[2])) kept.push(t);
  }
  return Uint32Array.from(kept);
}

/** Indices into the solve's vertices whose weight and detail flag `keep` accepts. */
export function indicesWhere(
  solve: RegionSolve,
  keep: (weight: number, detail: number) => boolean,
) {
  const kept: number[] = [];
  for (let i = 0; i < solve.vertices.length; i++)
    if (keep(solve.weight[i], solve.detail[i])) kept.push(i);
  return kept;
}

/** Highest point of the surface straight above or below (x, z), by a vertical ray. */
export function heightAt(mesh: RefineMesh, x: number, z: number) {
  let best = -Infinity;
  for (let t = 0; t < mesh.triangleCount; t++) {
    const [a, b, c] = ([0, 1, 2] as const).map((k) => at(mesh, weldedCorner(mesh, t, k)));
    const d = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
    if (d === 0) continue;
    const u = ((x - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (z - a[2])) / d;
    const v = ((b[0] - a[0]) * (z - a[2]) - (x - a[0]) * (b[2] - a[2])) / d;
    if (u < 0 || v < 0 || u + v > 1) continue;
    best = Math.max(best, a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]));
  }
  return best;
}

/**
 * Height of a dome's (or depth of a dimple's) centre over the plate just outside it: the mean
 * height of the top-face vertices within 0.15 mm beyond its foot.
 */
export function heightAbovePlate(
  mesh: RefineMesh,
  feature: { x: number; z: number; radius: number },
) {
  let sum = 0,
    count = 0;
  for (let v = 0; v < mesh.weldedCount; v++) {
    const [x, y, z] = at(mesh, v);
    const r = Math.hypot(x - feature.x, z - feature.z);
    if (y > 0.3 && r >= feature.radius && r <= feature.radius + 0.15) {
      sum += y;
      count++;
    }
  }
  return heightAt(mesh, feature.x, feature.z) - sum / count;
}

/** RMS of each vertex's distance from the origin about their mean: a centred sphere's ripple. */
export function rippleAmplitude(mesh: RefineMesh) {
  const radii = Array.from({ length: mesh.weldedCount }, (_, v) => Math.hypot(...at(mesh, v)));
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  return Math.sqrt(radii.reduce((a, r) => a + (r - mean) ** 2, 0) / radii.length);
}

export function meanRadius(mesh: RefineMesh) {
  let sum = 0;
  for (let v = 0; v < mesh.weldedCount; v++) sum += Math.hypot(...at(mesh, v));
  return sum / mesh.weldedCount;
}

/** Welded vertices of `triangles` used by no triangle outside them. */
export function interiorOf(mesh: RefineMesh, topology: RefineTopology, triangles: Uint32Array) {
  const inside = new Uint8Array(mesh.triangleCount);
  for (const t of triangles) inside[t] = 1;
  const vertices = new Set<number>();
  for (const t of triangles)
    for (const k of [0, 1, 2] as const) vertices.add(weldedCorner(mesh, t, k));
  const { triangleStart, trianglesOf } = topology;
  return Uint32Array.from(
    [...vertices].filter((v) => {
      for (let j = triangleStart[v]; j < triangleStart[v + 1]; j++)
        if (!inside[trianglesOf[j]]) return false;
      return true;
    }),
  );
}

/** Distance along the region's edges from its border vertices, per vertex of `solve`. */
export function borderDistances(model: Model, triangles: Uint32Array, solve: RegionSolve) {
  const { mesh, topology } = model;
  const interior = new Set(interiorOf(mesh, topology, triangles));
  const index = new Map([...solve.vertices].map((v, i) => [v, i]));
  const distance = Array.from(solve.vertices, (v) => (interior.has(v) ? Infinity : 0));
  // Bellman-Ford sweeps: slow, independent of the module's Dijkstra.
  for (let changed = true; changed;) {
    changed = false;
    solve.vertices.forEach((v, i) => {
      for (let j = topology.neighbourStart[v]; j < topology.neighbourStart[v + 1]; j++) {
        const k = index.get(topology.neighbours[j]);
        if (k === undefined) continue;
        const p = at(mesh, v),
          q = at(mesh, solve.vertices[k]);
        const d = distance[k] + Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        if (d < distance[i] - 1e-12) {
          distance[i] = d;
          changed = true;
        }
      }
    });
  }
  return distance;
}

/** Welded vertices on a refined edge. */
export const chainOf = (mesh: RefineMesh) =>
  Array.from({ length: mesh.weldedCount }, (_, v) => v).filter((v) => mesh.crease[v]);

export const distanceMoved = (before: RefineMesh, after: RefineMesh, v: number) =>
  Math.hypot(...[0, 1, 2].map((a) => after.position[v * 3 + a] - before.position[v * 3 + a]));

/** How far a 0.3 mm fillet's crest sits in from each face. */
const crest = 0.3 - 0.3 / Math.SQRT2;

/** Sharpens the softBox([2, 1.5, 1], 0.3) edge at y = 1.5, z = 1 over |x| <= 1.6, as the edge tests do. */
export function refineBoxEdgeOf(model: Model) {
  const points: GuidePoint[] = [-1.6, 1.6].map((x) =>
    pointOn(model.mesh, [x, 1.5 - crest, 1 - crest]),
  );
  const kind: GuideKind = 'line';
  const input: EdgeInput = {
    segments: [{ kind, points }],
    joints: [],
    closed: false,
    width: 0.6,
    strength: 1,
  };
  const solve = solveEdge(model.mesh, model.topology, input, model.noise)!;
  const out = cloneRefineMesh(model.mesh, true);
  const result = applyEdge(out, model.topology, solve, 1, true);
  return { model, solve, out, result };
}

export const refineBoxEdge = () =>
  refineBoxEdgeOf(modelOf(softBox([2, 1.5, 1], 0.3), new Matrix4()));

/**
 * Per vertex of `solve`: its distance along the mesh's edges from the nearest vertex of kept detail
 * (detail 1) or on a refined edge, by Dijkstra over the whole mesh.
 */
export function distanceFromDetail(model: Model, solve: RegionSolve) {
  const { mesh, topology } = model;
  const distance = new Float64Array(mesh.weldedCount).fill(Infinity);
  const queue: [number, number][] = [];
  const push = (d: number, v: number) => {
    queue.push([d, v]);
    for (let i = queue.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (queue[parent][0] <= queue[i][0]) break;
      [queue[parent], queue[i]] = [queue[i], queue[parent]];
      i = parent;
    }
  };
  const pop = () => {
    const top = queue[0];
    const last = queue.pop()!;
    if (queue.length) {
      queue[0] = last;
      for (let i = 0; ;) {
        let child = 2 * i + 1;
        if (child >= queue.length) break;
        if (child + 1 < queue.length && queue[child + 1][0] < queue[child][0]) child++;
        if (queue[i][0] <= queue[child][0]) break;
        [queue[child], queue[i]] = [queue[i], queue[child]];
        i = child;
      }
    }
    return top;
  };
  solve.vertices.forEach((v, i) => {
    if (solve.detail[i] === 1) {
      distance[v] = 0;
      push(0, v);
    }
  });
  for (let v = 0; v < mesh.weldedCount; v++)
    if (mesh.crease[v]) {
      distance[v] = 0;
      push(0, v);
    }
  while (queue.length) {
    const [d, v] = pop();
    if (d > distance[v]) continue;
    for (let j = topology.neighbourStart[v]; j < topology.neighbourStart[v + 1]; j++) {
      const w = topology.neighbours[j];
      const p = at(mesh, v),
        q = at(mesh, w);
      const next = d + Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (next < distance[w]) {
        distance[w] = next;
        push(next, w);
      }
    }
  }
  return Array.from(solve.vertices, (v) => distance[v]);
}

/** RMS about their mean of `measure` over the given vertices, and that mean. */
export function spread(mesh: RefineMesh, vertices: number[], measure: (p: number[]) => number) {
  const values = vertices.map((v) => measure(at(mesh, v)));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    mean,
    rms: Math.sqrt(values.reduce((a, x) => a + (x - mean) ** 2, 0) / values.length),
  };
}
