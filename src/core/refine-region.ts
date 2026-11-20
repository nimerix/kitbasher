import {
  type Shape,
  type ShapeFit,
  type ShapeKind,
  fitAuto,
  fitShape,
  projectToShape,
  shapeDistance,
} from './refine-fit';
import {
  type RefineMesh,
  type RefineTopology,
  cloneRefineMesh,
  moveVertex,
  vertexNormal,
  weldedCorner,
} from './refine-mesh';
import { smoothPasses, smoothVertices } from './refine-smooth';

export type Treatment = 'smooth' | 'flatten' | 'shape';
export type RegionShape = 'auto' | 'cylinder' | 'cone' | 'sphere' | 'sweep';
export interface RegionInput {
  triangles: Uint32Array;
  treatment: Treatment;
  /** Used when treatment is 'shape'. */
  shape: RegionShape;
  /** 0 to 1. */
  strength: number;
  keepDetail: boolean;
  /** mm off the surface that counts as detail. Null uses 6 times the region's own roughness. */
  detail: number | null;
  /** mm over which the change fades in from the border. Null uses 4 * the local edge length. */
  blend: number | null;
}
export interface RegionSolve {
  vertices: Uint32Array;
  /** Per region vertex: target position, 0-1 weight, and 1 where it is kept detail. */
  target: Float32Array;
  weight: Float32Array;
  detail: Uint8Array;
  /** What the surface was fitted as; null for Smooth. */
  fitted: ShapeKind | 'sweep' | null;
}

/** Detail stands this many times the region's roughness off its surface. */
const detailScale = 6;
/** Rings of base vertices around an island whose moves carry it. */
const ringDepth = 4;
/** The scale of a normal distribution from its median absolute value. */
const madScale = 1.4826;

interface Region {
  vertices: Uint32Array;
  /** Welded vertex -> index in `vertices`, or -1. */
  indexOf: Int32Array;
  /** 1 where a region vertex is also used by a triangle outside the region. */
  border: Uint8Array;
}

/** Null when the region is too small to fit or is all detail. */
export function solveRegion(
  mesh: RefineMesh,
  topology: RefineTopology,
  input: RegionInput,
  noise: number,
): RegionSolve | null {
  if (input.treatment === 'shape' && input.shape === 'sweep') return null;
  const region = regionOf(mesh, topology, input.triangles);
  const { vertices, border } = region;
  const count = vertices.length;
  if (!border.includes(0)) return null;
  const blend = input.blend ?? 4 * medianEdge(mesh, input.triangles);
  const weight = blendWeights(mesh, topology, region, blend, input.strength);
  const normals = new Float32Array(count * 3);
  const normal = new Float32Array(3);
  for (let i = 0; i < count; i++) {
    vertexNormal(mesh, topology, vertices[i], normal);
    normals.set(normal, i * 3);
  }
  const solved =
    input.treatment === 'smooth'
      ? smoothRegion(mesh, topology, region, input, noise, normals, weight)
      : fitRegion(mesh, topology, region, input, noise, normals);
  if (!solved) return null;
  const { target, detail } = solved;
  for (let i = 0; i < count; i++)
    if (!border[i] && !detail[i])
      return { vertices, target, weight, detail, fitted: solved.fitted };
  return null;
}

export function applyRegion(mesh: RefineMesh, solve: RegionSolve): Uint32Array {
  const { vertices, target, weight } = solve;
  const { position } = mesh;
  const written: number[] = [];
  for (let i = 0; i < vertices.length; i++) {
    const w = weight[i];
    if (!(w > 0)) continue;
    const v = vertices[i];
    const at = (axis: number) => {
      const p = position[v * 3 + axis],
        t = target[i * 3 + axis];
      return w === 1 ? t : p + w * (t - p);
    };
    moveVertex(mesh, v, at(0), at(1), at(2));
    written.push(v);
  }
  return Uint32Array.from(written);
}

interface Solved {
  target: Float32Array;
  detail: Uint8Array;
  fitted: ShapeKind | null;
}

/** Flatten and Shape: base vertices project onto the fitted surface, detail rides on it. */
function fitRegion(
  mesh: RefineMesh,
  topology: RefineTopology,
  region: Region,
  input: RegionInput,
  noise: number,
  normals: Float32Array,
): Solved | null {
  const { vertices } = region;
  const count = vertices.length;
  const { position } = mesh;
  const points = new Float32Array(count * 3);
  for (let i = 0; i < count; i++)
    points.set(position.subarray(vertices[i] * 3, vertices[i] * 3 + 3), i * 3);
  const fit = fitOf(points, normals, input, noise);
  if (!fit) return null;
  const offsets = (shape: Shape) =>
    Float64Array.from({ length: count }, (_, i) =>
      shapeDistance(shape, points[i * 3], points[i * 3 + 1], points[i * 3 + 2]),
    );
  let shape = fit.shape;
  let detail: Uint8Array = new Uint8Array(count);
  if (input.keepDetail) {
    detail = detailOf(topology, region, offsets(shape), noise, input.detail);
    // Refitted without the detail, whose foot would otherwise lift the surface under it.
    const clear = detail.includes(1) ? refit(points, normals, detail, fit, noise) : null;
    if (clear) {
      shape = clear;
      detail = detailOf(topology, region, offsets(shape), noise, input.detail);
    }
  }
  const target = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const v = vertices[i] * 3;
    projectToShape(shape, position[v], position[v + 1], position[v + 2], target, i * 3);
  }
  if (input.keepDetail) carryIslands(mesh, topology, region, detail, target);
  return { target, detail, fitted: shape.kind };
}

/** The fitted kind again, from the vertices that are not detail. */
function refit(
  points: Float32Array,
  normals: Float32Array,
  detail: Uint8Array,
  fit: ShapeFit,
  noise: number,
): Shape | null {
  const kept: number[] = [];
  detail.forEach((d, i) => d || kept.push(i));
  const pick = (values: Float32Array) => {
    const out = new Float32Array(kept.length * 3);
    kept.forEach((i, n) => out.set(values.subarray(i * 3, i * 3 + 3), n * 3));
    return out;
  };
  return fitShape(pick(points), pick(normals), fit.shape.kind, noise)?.shape ?? null;
}

function fitOf(
  points: Float32Array,
  normals: Float32Array,
  input: RegionInput,
  noise: number,
): ShapeFit | null {
  if (input.treatment === 'flatten') return fitShape(points, normals, 'plane', noise);
  if (input.shape !== 'auto') return fitShape(points, normals, input.shape as ShapeKind, noise);
  try {
    return fitAuto(points, normals, noise);
  } catch {
    return null;
  }
}

/**
 * Smooth: Taubin passes with the strength and blend in each vertex's weight. Detail is what stands
 * off a copy smoothed four times as long; the smoothing runs with it pressed onto that copy.
 */
function smoothRegion(
  mesh: RefineMesh,
  topology: RefineTopology,
  region: Region,
  input: RegionInput,
  noise: number,
  normals: Float32Array,
  weight: Float32Array,
): Solved {
  const { vertices, border } = region;
  const count = vertices.length;
  const { position } = mesh;
  for (let i = 0; i < count; i++) if (mesh.crease[vertices[i]]) weight[i] = 0;
  const work = cloneRefineMesh(mesh, false);
  let detail: Uint8Array = new Uint8Array(count);
  const passes = smoothPasses(1);
  const target = new Float32Array(count * 3);
  if (input.keepDetail) {
    const base = cloneRefineMesh(mesh, false);
    const free = Float32Array.from(vertices, (v, i) => (border[i] || mesh.crease[v] ? 0 : 1));
    smoothVertices(base, topology, vertices, free, 4 * passes);
    const offset = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const v = vertices[i] * 3;
      for (let axis = 0; axis < 3; axis++)
        offset[i] += (position[v + axis] - base.position[v + axis]) * normals[i * 3 + axis];
    }
    // Detail is carried after smoothing; until then it is pressed onto the long-smoothed copy.
    const flagged = detailOf(topology, region, offset, noise, input.detail);
    for (let i = 0; i < count; i++)
      if (flagged[i])
        work.position.set(
          base.position.subarray(vertices[i] * 3, vertices[i] * 3 + 3),
          vertices[i] * 3,
        );
    detail = flagged;
  }
  smoothVertices(work, topology, vertices, weight, passes);
  // The smoothed move is linear in the weight, so the target is the move at weight 1.
  for (let i = 0; i < count; i++) {
    const v = vertices[i] * 3;
    const w = weight[i];
    for (let axis = 0; axis < 3; axis++)
      target[i * 3 + axis] =
        w > 0
          ? position[v + axis] + (work.position[v + axis] - position[v + axis]) / w
          : position[v + axis];
  }
  if (input.keepDetail) carryIslands(mesh, topology, region, detail, target);
  return { target, detail, fitted: null };
}

/**
 * Vertices more than the threshold off the surface, on either side, each island grown down its own
 * flanks while the offset keeps falling and stays above the region's roughness, so a foot that
 * meets the surface gradually stays with its detail.
 */
function detailOf(
  topology: RefineTopology,
  region: Region,
  offset: Float64Array,
  noise: number,
  threshold: number | null,
): Uint8Array {
  const { vertices, indexOf } = region;
  const count = vertices.length;
  const local = roughness(offset, noise);
  const limit = threshold ?? detailScale * local;
  const detail = new Uint8Array(count);
  const queue: number[] = [];
  for (let i = 0; i < count; i++)
    if (Math.abs(offset[i]) > limit) {
      detail[i] = 1;
      queue.push(i);
    }
  const { neighbourStart, neighbours } = topology;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const v = vertices[i];
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const k = indexOf[neighbours[j]];
      if (k < 0 || detail[k]) continue;
      const o = offset[k];
      if (o * offset[i] > 0 && Math.abs(o) > local && Math.abs(o) < Math.abs(offset[i])) {
        detail[k] = 1;
        queue.push(k);
      }
    }
  }
  return detail;
}

/**
 * Robust scale of the offsets the surface keeps (those within 3 * noise): 1.4826 times their
 * median absolute value, held between half and twice `noise`.
 */
function roughness(offset: Float64Array, noise: number) {
  const kept = Float64Array.from(
    offset.filter((o) => Math.abs(o) <= 3 * noise),
    Math.abs,
  );
  kept.sort();
  const middle = kept.length ? kept[(kept.length - 1) >> 1] : noise;
  return Math.max(1e-6, Math.min(2 * noise, Math.max(noise / 2, madScale * middle)));
}

/**
 * Gives every island of detail the mean target move of the base vertices within `ringDepth` rings
 * of it. The nearest ring alone sits where the island's growth stopped, off the surface on the
 * island's side, and would sink it.
 */
function carryIslands(
  mesh: RefineMesh,
  topology: RefineTopology,
  region: Region,
  detail: Uint8Array,
  target: Float32Array,
) {
  const { vertices, indexOf } = region;
  const { position } = mesh;
  const { neighbourStart, neighbours } = topology;
  const count = vertices.length;
  const island = new Int32Array(count).fill(-1);
  const seen = new Int32Array(count).fill(-1);
  for (let seed = 0; seed < count; seed++) {
    if (!detail[seed] || island[seed] >= 0) continue;
    const members = [seed];
    island[seed] = seed;
    seen[seed] = seed;
    for (let m = 0; m < members.length; m++) {
      const v = vertices[members[m]];
      for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
        const k = indexOf[neighbours[j]];
        if (k < 0 || !detail[k] || island[k] >= 0) continue;
        island[k] = seed;
        seen[k] = seed;
        members.push(k);
      }
    }
    let x = 0,
      y = 0,
      z = 0,
      rung = 0;
    let front = members;
    for (let ring = 0; ring < ringDepth; ring++) {
      const next: number[] = [];
      for (const i of front) {
        const v = vertices[i];
        for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
          const k = indexOf[neighbours[j]];
          if (k < 0 || detail[k] || seen[k] === seed) continue;
          seen[k] = seed;
          next.push(k);
          const w = vertices[k] * 3;
          x += target[k * 3] - position[w];
          y += target[k * 3 + 1] - position[w + 1];
          z += target[k * 3 + 2] - position[w + 2];
          rung++;
        }
      }
      front = next;
    }
    if (rung) {
      x /= rung;
      y /= rung;
      z /= rung;
    }
    for (const i of members) {
      const v = vertices[i] * 3;
      target[i * 3] = position[v] + x;
      target[i * 3 + 1] = position[v + 1] + y;
      target[i * 3 + 2] = position[v + 2] + z;
    }
  }
}

function regionOf(mesh: RefineMesh, topology: RefineTopology, triangles: Uint32Array): Region {
  const inside = new Uint8Array(mesh.triangleCount);
  for (const t of triangles) inside[t] = 1;
  const indexOf = new Int32Array(mesh.weldedCount).fill(-1);
  const list: number[] = [];
  for (const t of triangles)
    for (const corner of [0, 1, 2] as const) {
      const v = weldedCorner(mesh, t, corner);
      if (indexOf[v] >= 0) continue;
      indexOf[v] = 0;
      list.push(v);
    }
  const vertices = Uint32Array.from(list).sort();
  const border = new Uint8Array(vertices.length);
  const { triangleStart, trianglesOf } = topology;
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    indexOf[v] = i;
    for (let j = triangleStart[v]; j < triangleStart[v + 1]; j++)
      if (!inside[trianglesOf[j]]) {
        border[i] = 1;
        break;
      }
  }
  return { vertices, indexOf, border };
}

/** Median length of the edges of `triangles`. */
function medianEdge(mesh: RefineMesh, triangles: Uint32Array) {
  const { position } = mesh;
  const lengths = new Float64Array(triangles.length * 3);
  triangles.forEach((t, n) => {
    for (const k of [0, 1, 2] as const) {
      const a = weldedCorner(mesh, t, k) * 3,
        b = weldedCorner(mesh, t, ((k + 1) % 3) as 0 | 1 | 2) * 3;
      lengths[n * 3 + k] = Math.hypot(
        position[a] - position[b],
        position[a + 1] - position[b + 1],
        position[a + 2] - position[b + 2],
      );
    }
  });
  lengths.sort();
  return lengths.length ? lengths[lengths.length >> 1] : 0;
}

/**
 * Smoothstep of the distance along the surface from the border, reaching 1 at `blend`, times the
 * strength. Border vertices get 0.
 */
function blendWeights(
  mesh: RefineMesh,
  topology: RefineTopology,
  region: Region,
  blend: number,
  strength: number,
): Float32Array {
  const distance = borderDistance(mesh, topology, region);
  return Float32Array.from(distance, (d) => {
    if (d === 0) return 0;
    const t = blend > 0 ? Math.min(1, d / blend) : 1;
    return t * t * (3 - 2 * t) * strength;
  });
}

/** Dijkstra over the region's edges from its border vertices; Infinity with no border. */
function borderDistance(mesh: RefineMesh, topology: RefineTopology, region: Region) {
  const { vertices, indexOf, border } = region;
  const { position } = mesh;
  const { neighbourStart, neighbours } = topology;
  const distance = new Float64Array(vertices.length).fill(Infinity);
  const heap = new MinHeap();
  border.forEach((b, i) => {
    if (!b) return;
    distance[i] = 0;
    heap.push(0, i);
  });
  while (heap.size) {
    const [d, i] = heap.pop();
    if (d > distance[i]) continue;
    const v = vertices[i];
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const w = neighbours[j];
      const k = indexOf[w];
      if (k < 0) continue;
      const next =
        d +
        Math.hypot(
          position[w * 3] - position[v * 3],
          position[w * 3 + 1] - position[v * 3 + 1],
          position[w * 3 + 2] - position[v * 3 + 2],
        );
      if (next < distance[k]) {
        distance[k] = next;
        heap.push(next, k);
      }
    }
  }
  return distance;
}

class MinHeap {
  private keys: number[] = [];
  private values: number[] = [];

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

  pop(): [number, number] {
    const { keys, values } = this;
    const top: [number, number] = [keys[0], values[0]];
    const key = keys.pop()!,
      value = values.pop()!;
    const size = keys.length;
    if (size) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= size) break;
        if (child + 1 < size && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = key;
      values[i] = value;
    }
    return top;
  }
}
