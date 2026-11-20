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
  moveVertex,
  vertexNormal,
  weldedCorner,
} from './refine-mesh';
import { smoothScale, smoothTargets } from './refine-smooth';

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
  /** Smooth's reach in mm: ripples shorter than it go. Null or absent uses max(0.6, 10 edges). */
  scale?: number | null;
}
export interface RegionSolve {
  vertices: Uint32Array;
  /**
   * Per region vertex: target position, 0-1 weight, and 1 where it is kept detail (2 where its
   * move eases into kept detail or a restored edge).
   */
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
/** Edge lengths over which the base eases into kept detail, and into a restored edge. */
const islandEase = 3;
const creaseEase = 2;
/**
 * An island lower than `warpPeak` times the detail threshold and wider than `warpWidth` mm in every
 * direction is a gentle warp of the surface, not detail.
 */
const warpPeak = 2;
const warpWidth = 1.5;
/** Rounds of local fits that Smooth runs. */
const smoothRounds = 2;

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
  const edge = medianEdge(mesh, input.triangles);
  const blend = input.blend ?? 4 * edge;
  const weight = blendWeights(mesh, topology, region, blend, input.strength);
  const normals = new Float32Array(count * 3);
  const normal = new Float32Array(3);
  for (let i = 0; i < count; i++) {
    vertexNormal(mesh, topology, vertices[i], normal);
    normals.set(normal, i * 3);
  }
  const solved =
    input.treatment === 'smooth'
      ? smoothRegion(mesh, topology, region, input, noise, normals, edge)
      : fitRegion(mesh, topology, region, input, noise, normals);
  if (!solved) return null;
  const { target, detail } = solved;
  ease(mesh, topology, region, solved, edge, weight);
  for (let i = 0; i < count; i++)
    if (!border[i] && detail[i] !== 1)
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
  /** Per vertex: its island, or -1; and each island's move. */
  island: Int32Array;
  moves: Float64Array;
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
  const judge = (offset: Float64Array) =>
    detailOf(topology, region, offset, noise, input.detail, points, normals);
  if (input.keepDetail) {
    detail = judge(offsets(shape));
    // Refitted without the detail, whose foot would otherwise lift the surface under it.
    const clear = detail.includes(1) ? refit(points, normals, detail, fit, noise) : null;
    if (clear) {
      shape = clear;
      detail = judge(offsets(shape));
    }
  }
  const target = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const v = vertices[i] * 3;
    projectToShape(shape, position[v], position[v + 1], position[v + 2], target, i * 3);
  }
  return {
    target,
    detail,
    fitted: shape.kind,
    ...carryIslands(mesh, topology, region, detail, target),
  };
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
 * Smooth: each vertex moves onto a quadric fitted to the surface within `scale` of it, so ripples
 * shorter than `scale` go and the surface's own curvature stays. Detail is what stands off the
 * same projection at twice the scale; the smoothing runs with it pressed onto that base.
 */
function smoothRegion(
  mesh: RefineMesh,
  topology: RefineTopology,
  region: Region,
  input: RegionInput,
  noise: number,
  normals: Float32Array,
  edge: number,
): Solved {
  const { vertices, border } = region;
  const count = vertices.length;
  const { position, crease } = mesh;
  const scale = input.scale ?? smoothScale(edge);
  const free = Uint8Array.from(vertices, (v, i) => (border[i] || crease[v] ? 0 : 1));
  let detail: Uint8Array = new Uint8Array(count);
  let start = position;
  if (input.keepDetail) {
    const base = smoothTargets(mesh, topology, vertices, free, 2 * scale, smoothRounds, crease);
    const offset = new Float64Array(count);
    const points = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const v = vertices[i] * 3;
      for (let axis = 0; axis < 3; axis++) {
        points[i * 3 + axis] = position[v + axis];
        offset[i] += (position[v + axis] - base[i * 3 + axis]) * normals[i * 3 + axis];
      }
    }
    detail = detailOf(topology, region, offset, noise, input.detail, points, normals);
    if (detail.includes(1)) {
      start = position.slice();
      for (let i = 0; i < count; i++)
        if (detail[i] && free[i])
          for (let axis = 0; axis < 3; axis++) start[vertices[i] * 3 + axis] = base[i * 3 + axis];
    }
  }
  const target = smoothTargets(mesh, topology, vertices, free, scale, smoothRounds, crease, start);
  for (let i = 0; i < count; i++)
    if (!free[i])
      for (let axis = 0; axis < 3; axis++) target[i * 3 + axis] = position[vertices[i] * 3 + axis];
  return { target, detail, fitted: null, ...carryIslands(mesh, topology, region, detail, target) };
}

/**
 * Vertices more than the threshold off the surface, on either side, each island grown down its own
 * flanks while the offset keeps falling and stays above the region's roughness, so a foot that
 * meets the surface gradually stays with its detail. An island that is both low and wide is a
 * gentle warp of the surface, not detail, and is dropped.
 */
function detailOf(
  topology: RefineTopology,
  region: Region,
  offset: Float64Array,
  noise: number,
  threshold: number | null,
  points: Float32Array,
  normals: Float32Array,
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
  const { island, islands } = islandsOf(topology, region, detail);
  const members: number[][] = Array.from({ length: islands }, () => []);
  island.forEach((n, i) => n >= 0 && members[n].push(i));
  for (const list of members) {
    let peak = 0;
    for (const i of list) peak = Math.max(peak, Math.abs(offset[i]));
    if (peak < warpPeak * limit && narrowest(list, points, normals) > warpWidth)
      for (const i of list) detail[i] = 0;
  }
  return detail;
}

/** The island's least extent across its mean normal, over eight directions. */
function narrowest(list: number[], points: Float32Array, normals: Float32Array) {
  let nx = 0,
    ny = 0,
    nz = 0;
  for (const i of list) {
    nx += normals[i * 3];
    ny += normals[i * 3 + 1];
    nz += normals[i * 3 + 2];
  }
  const length = Math.hypot(nx, ny, nz) || 1;
  nx /= length;
  ny /= length;
  nz /= length;
  const helper = Math.abs(nx) < 0.6 ? [1, 0, 0] : [0, 1, 0];
  let ux = ny * helper[2] - nz * helper[1],
    uy = nz * helper[0] - nx * helper[2],
    uz = nx * helper[1] - ny * helper[0];
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const wx = ny * uz - nz * uy,
    wy = nz * ux - nx * uz,
    wz = nx * uy - ny * ux;
  let least = Infinity;
  for (let k = 0; k < 8; k++) {
    const c = Math.cos((k * Math.PI) / 8),
      s = Math.sin((k * Math.PI) / 8);
    const dx = c * ux + s * wx,
      dy = c * uy + s * wy,
      dz = c * uz + s * wz;
    let low = Infinity,
      high = -Infinity;
    for (const i of list) {
      const d = points[i * 3] * dx + points[i * 3 + 1] * dy + points[i * 3 + 2] * dz;
      low = Math.min(low, d);
      high = Math.max(high, d);
    }
    least = Math.min(least, high - low);
  }
  return least;
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

/** Connected islands of detail: each vertex's island index, or -1. */
function islandsOf(topology: RefineTopology, region: Region, detail: Uint8Array) {
  const { vertices, indexOf } = region;
  const { neighbourStart, neighbours } = topology;
  const island = new Int32Array(vertices.length).fill(-1);
  let islands = 0;
  for (let seed = 0; seed < vertices.length; seed++) {
    if (detail[seed] !== 1 || island[seed] >= 0) continue;
    const members = [seed];
    island[seed] = islands;
    for (let m = 0; m < members.length; m++) {
      const v = vertices[members[m]];
      for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
        const k = indexOf[neighbours[j]];
        if (k < 0 || detail[k] !== 1 || island[k] >= 0) continue;
        island[k] = islands;
        members.push(k);
      }
    }
    islands++;
  }
  return { island, islands };
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
  const { island, islands } = islandsOf(topology, region, detail);
  const moves = new Float64Array(islands * 3);
  const members: number[][] = Array.from({ length: islands }, () => []);
  island.forEach((n, i) => n >= 0 && members[n].push(i));
  const seen = new Int32Array(vertices.length).fill(-1);
  members.forEach((list, n) => {
    for (const i of list) seen[i] = n;
    let x = 0,
      y = 0,
      z = 0,
      rung = 0;
    let front = list;
    for (let ring = 0; ring < ringDepth; ring++) {
      const next: number[] = [];
      for (const i of front) {
        const v = vertices[i];
        for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
          const k = indexOf[neighbours[j]];
          if (k < 0 || detail[k] || seen[k] === n) continue;
          seen[k] = n;
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
    moves.set([x, y, z], n * 3);
    for (const i of list) {
      const v = vertices[i] * 3;
      target[i * 3] = position[v] + x;
      target[i * 3 + 1] = position[v + 1] + y;
      target[i * 3 + 2] = position[v + 2] + z;
    }
  });
  return { island, moves };
}

/**
 * Restored-edge vertices never move, and the base eases into them over `creaseEase` edge lengths.
 * The base within `islandEase` edge lengths of kept detail eases from the island's move to its
 * own, so no step or ring of facets forms where the two meet. Eased vertices are marked 2.
 */
function ease(
  mesh: RefineMesh,
  topology: RefineTopology,
  region: Region,
  solved: Solved,
  edge: number,
  weight: Float32Array,
) {
  const { vertices } = region;
  const { position, crease } = mesh;
  const { target, detail, island, moves } = solved;
  const count = vertices.length;
  const creases = Int32Array.from(vertices, (v) => (crease[v] ? 0 : -1));
  const toIsland = surfaceDistance(mesh, topology, region, island, islandEase * edge);
  const toCrease = surfaceDistance(mesh, topology, region, creases, creaseEase * edge);
  for (let i = 0; i < count; i++) {
    if (crease[vertices[i]]) {
      weight[i] = 0;
      continue;
    }
    if (detail[i] === 1) continue;
    const si = smoothstep(toIsland.distance[i] / (islandEase * edge));
    const sc = smoothstep(toCrease.distance[i] / (creaseEase * edge));
    if (si === 1 && sc === 1) continue;
    const n = toIsland.label[i];
    const v = vertices[i] * 3;
    for (let axis = 0; axis < 3; axis++) {
      const own = target[i * 3 + axis] - position[v + axis];
      const carried = si < 1 ? moves[n * 3 + axis] : 0;
      target[i * 3 + axis] = position[v + axis] + sc * ((1 - si) * carried + si * own);
    }
    detail[i] = 2;
  }
}

const smoothstep = (t: number) => (t >= 1 ? 1 : t <= 0 ? 0 : t * t * (3 - 2 * t));

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
  const sources = Int32Array.from(region.border, (b) => (b ? 0 : -1));
  const { distance } = surfaceDistance(mesh, topology, region, sources, Infinity);
  return Float32Array.from(distance, (d) => {
    if (d === 0) return 0;
    return (blend > 0 ? smoothstep(d / blend) : 1) * strength;
  });
}

/**
 * Dijkstra over the region's edges from the vertices with a label (not -1), out to `limit`:
 * each vertex's distance (Infinity beyond the limit) and the label of its nearest source.
 */
function surfaceDistance(
  mesh: RefineMesh,
  topology: RefineTopology,
  region: Region,
  sources: Int32Array,
  limit: number,
) {
  const { vertices, indexOf } = region;
  const { position } = mesh;
  const { neighbourStart, neighbours } = topology;
  const distance = new Float64Array(vertices.length).fill(Infinity);
  const label = Int32Array.from(sources);
  const heap = new MinHeap();
  sources.forEach((n, i) => {
    if (n < 0) return;
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
      if (next < distance[k] && next < limit) {
        distance[k] = next;
        label[k] = label[i];
        heap.push(next, k);
      }
    }
  }
  return { distance, label };
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
