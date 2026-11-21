import {
  type Shape,
  type ShapeFit,
  type ShapeKind,
  fitAuto,
  fitShape,
  projectToShape,
  shapeDistance,
  shapeNormal,
} from './refine-fit';
import {
  type RefineMesh,
  type RefineTopology,
  moveVertex,
  vertexNormal,
  weldedCorner,
} from './refine-mesh';
import { smoothScale, smoothTargets } from './refine-smooth';
import { type Sweep, fitSweep, sweepAt } from './refine-sweep';

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
  /**
   * Smooth's reach in mm along the surface: no vertex reads beyond it. Null or absent uses
   * max(0.9, 15 edges).
   */
  scale?: number | null;
}
export interface RegionSolve {
  vertices: Uint32Array;
  /**
   * Per region vertex: the world position `applyRegion` writes where its 0-1 weight is above 0,
   * already blended by that weight and checked for collapsed and turned triangles; the weight; and
   * 1 where it is kept as it stands (detail, or a face turned away from the fitted surface), 2 where
   * its move eases into kept detail or a restored edge.
   */
  target: Float64Array;
  weight: Float32Array;
  detail: Uint8Array;
  /** What the first patch's surface was fitted as; null for Smooth. */
  fitted: ShapeKind | 'sweep' | null;
  /** Per edge-connected patch, in order of its smallest triangle: what it was fitted as. */
  fits: (ShapeKind | 'sweep' | null)[];
  /** Per patch, as `fits`: the settings the solve used, where the input left them automatic. */
  resolved: (RegionResolved | null)[];
}
/** The mm a patch's solve used for each setting an input may leave null. */
export interface RegionResolved {
  blend: number;
  scale: number;
  /** Null when no detail was looked for. */
  detail: number | null;
}

/** Detail stands this many times the region's roughness off its surface. */
const detailScale = 4;
/** Rings of base vertices around an island whose moves carry it. */
const ringDepth = 4;
/** The scale of a normal distribution from its median absolute value. */
const madScale = 1.4826;
/** Edge lengths over which the base eases into kept detail, and into a restored edge. */
const islandEase = 3;
const creaseEase = 2;
/** Smooth moves every vertex its own way, so it eases into detail more gradually. */
const smoothIslandEase = 6;
/**
 * An island lower than `warpPeak` times the detail threshold and wider than `warpWidth` mm in every
 * direction is a gentle warp of the surface, not detail.
 */
const warpPeak = 2;
const warpWidth = 1.5;
/** Rounds of local fits that Smooth runs. */
const smoothRounds = 2;
/** A vertex whose normal is within this cosine of facing away from the fitted surface stays put. */
const facing = 0.2;
/** A moved triangle may keep no less than this fraction of its area. */
const collapse = 1e-3;
/** Rounds of holding the corners of failed triangles before the solve is refused. */
const checkRounds = 5;
/** Refits of Flatten and Shape to the base weighted by its blend, until its weights repeat. */
const fitRounds = 3;
/** The least total blend weight that determines a fitted surface. */
const minimumWeight = 3;
/**
 * Each vertex counts in a refit by its blend to this power: the band, which a run moves only part
 * way, pulls the next run's fit by little, so a second run refits nearly the same surface.
 */
const fitWeightPower = 8;

interface Region {
  vertices: Uint32Array;
  /** Welded vertex -> index in `vertices`, or -1. */
  indexOf: Int32Array;
  /** 1 where a region vertex is also used by a triangle outside the region. */
  border: Uint8Array;
}

/**
 * Null when any patch fails its triangle check, so a selection is treated whole or not at all, and
 * when no patch can be fitted or each is all detail.
 */
export function solveRegion(
  mesh: RefineMesh,
  topology: RefineTopology,
  input: RegionInput,
  noise: number,
): RegionSolve | null {
  const { vertices, indexOf } = regionOf(mesh, topology, input.triangles);
  const count = vertices.length;
  const { position } = mesh;
  const target = new Float64Array(count * 3);
  for (let i = 0; i < count; i++)
    target.set(position.subarray(vertices[i] * 3, vertices[i] * 3 + 3), i * 3);
  const weight = new Float32Array(count);
  const detail = new Uint8Array(count);
  const fits: (Fitted | null)[] = [];
  const resolved: (RegionResolved | null)[] = [];
  let solved = false;
  // Each patch has its own fit, detail and blend; a vertex two patches share is on both borders.
  for (const triangles of patchesOf(mesh, topology, input.triangles)) {
    const patch = solvePatch(mesh, topology, triangles, input, noise);
    if (patch === 'refused') return null;
    fits.push(patch?.fitted ?? null);
    resolved.push(patch?.resolved ?? null);
    if (!patch) continue;
    solved = true;
    patch.vertices.forEach((v, i) => {
      const n = indexOf[v];
      if (patch.detail[i]) detail[n] = patch.detail[i];
      if (!(patch.weight[i] > 0)) return;
      weight[n] = patch.weight[i];
      target.set(patch.target.subarray(i * 3, i * 3 + 3), n * 3);
    });
  }
  if (!solved) return null;
  return { vertices, target, weight, detail, fitted: fits[0], fits, resolved };
}

/** Writes the solve's checked positions, unchanged, wherever its weight is above 0. */
export function applyRegion(mesh: RefineMesh, solve: RegionSolve): Uint32Array {
  const { vertices, target, weight } = solve;
  const written: number[] = [];
  for (let i = 0; i < vertices.length; i++) {
    if (!(weight[i] > 0)) continue;
    moveVertex(mesh, vertices[i], target[i * 3], target[i * 3 + 1], target[i * 3 + 2]);
    written.push(vertices[i]);
  }
  return Uint32Array.from(written);
}

type Fitted = ShapeKind | 'sweep';
/** The surface Flatten and Shape fit: one of the fitted shapes, or a sweep. */
type Surface = Shape | { kind: 'sweep'; sweep: Sweep };

/**
 * Per point: the surface's normal where it projects, and its offset when `offsets` is set. A sweep
 * finds each point's place on its path once, so its projection comes too.
 */
function sampled(surface: Surface, points: Float32Array, offsets: boolean) {
  const count = points.length / 3;
  const normal = new Float64Array(count * 3);
  const offset = offsets ? new Float64Array(count) : null;
  const projected = surface.kind === 'sweep' ? new Float32Array(count * 3) : null;
  const n = new Float64Array(3);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
    if (surface.kind === 'sweep') {
      const d = sweepAt(surface.sweep, x, y, z, projected!.subarray(i * 3, i * 3 + 3), n);
      if (offset) offset[i] = d;
    } else {
      shapeNormal(surface, x, y, z, n);
      if (offset) offset[i] = shapeDistance(surface, x, y, z);
    }
    normal.set(n, i * 3);
  }
  return { normal, offset, projected };
}

/** Per patch vertex: its move at full weight, whether it is detail, and whether it stays put. */
interface Base {
  move: Float64Array;
  detail: Uint8Array;
  held: Uint8Array;
  fitted: Fitted | null;
  /** The offset that counted as detail, or null when none was looked for. */
  limit: number | null;
}

interface PatchSolve {
  vertices: Uint32Array;
  target: Float64Array;
  weight: Float32Array;
  detail: Uint8Array;
  fitted: Fitted | null;
  resolved: RegionResolved;
}

function solvePatch(
  mesh: RefineMesh,
  topology: RefineTopology,
  triangles: Uint32Array,
  input: RegionInput,
  noise: number,
): PatchSolve | 'refused' | null {
  const region = regionOf(mesh, topology, triangles);
  const { vertices, border } = region;
  const count = vertices.length;
  if (!border.includes(0)) return null;
  const edge = medianEdge(mesh, triangles);
  const blend = blendWeights(mesh, topology, region, input.blend ?? 4 * edge);
  const normals = new Float32Array(count * 3);
  const normal = new Float32Array(3);
  for (let i = 0; i < count; i++) {
    vertexNormal(mesh, topology, vertices[i], normal);
    normals.set(normal, i * 3);
  }
  const base =
    input.treatment === 'smooth'
      ? smoothBase(mesh, topology, region, input, noise, normals, edge)
      : fitBase(mesh, topology, region, input, noise, normals, edge, blend);
  if (!base) return null;
  for (let i = 0; i < count; i++)
    if (!border[i] && !base.detail[i] && !base.held[i]) {
      const settled = settle(mesh, topology, region, base, blend, input.strength, edge);
      if (settled === 'refused') return settled;
      const resolved = {
        blend: input.blend ?? 4 * edge,
        scale: input.scale ?? smoothScale(edge),
        detail: base.limit,
      };
      return { ...settled, resolved };
    }
  return null;
}

/**
 * Flatten and Shape: base vertices project onto the fitted surface. The surface is fitted again to
 * every base vertex clear of detail, of eased rings and of faces turned away, weighted by its blend
 * to `fitWeightPower`, so the full-weight interior decides it and a second run over the result,
 * where that interior already lies on it, finds nearly the same surface. A vertex facing away from the surface (a wall,
 * or the far side of a thin part) stays put. Null when the weighted base cannot fix the surface.
 */
function fitBase(
  mesh: RefineMesh,
  topology: RefineTopology,
  region: Region,
  input: RegionInput,
  noise: number,
  normals: Float32Array,
  edge: number,
  blend: Float32Array,
): Base | null {
  const { vertices, border } = region;
  const count = vertices.length;
  const { position, crease } = mesh;
  const points = new Float32Array(count * 3);
  for (let i = 0; i < count; i++)
    points.set(position.subarray(vertices[i] * 3, vertices[i] * 3 + 3), i * 3);
  // A sweep's first fit reads every vertex, as a narrow strip of tube needs all of its width, but
  // is checked along its path counting each by its blend as the refits below are: the band, which
  // a run moves only part way, would otherwise fail a second run.
  const blended = Float64Array.from(blend, (b, i) => (border[i] ? 0 : b ** fitWeightPower));
  const first = fitOf(points, normals, input, noise, edge, blended);
  if (!first) return null;
  const kind = first.kind;
  let projected: Float32Array | null = null;
  const offsetUsed: { limit: number | null } = { limit: null };
  const classify = (shape: Surface) => {
    const sample = sampled(shape, points, input.keepDetail);
    projected = sample.projected;
    const detail = sample.offset
      ? detailOf(topology, region, sample.offset, noise, input.detail, points, normals, offsetUsed)
      : new Uint8Array(count);
    return { detail, held: facingAway(sample.normal, normals, detail) };
  };
  let shape = first;
  let { detail, held } = classify(shape);
  let used: Float64Array | null = null;
  for (let round = 0; round < fitRounds; round++) {
    const near = surfaceDistance(
      mesh,
      topology,
      region,
      Int32Array.from(detail, (d, i) => (d || held[i] ? 0 : -1)),
      islandEase * edge,
    ).distance;
    const nearCrease = surfaceDistance(
      mesh,
      topology,
      region,
      Int32Array.from(vertices, (v) => (crease[v] ? 0 : -1)),
      creaseEase * edge,
    ).distance;
    const weights = Float64Array.from(blend, (b, i) =>
      border[i] || near[i] < Infinity || nearCrease[i] < Infinity ? 0 : b ** fitWeightPower,
    );
    if (used && weights.every((w, i) => w === used![i])) break;
    const next = weightedFit(points, normals, shape, noise, weights, edge);
    if (!next) return null;
    shape = next;
    used = weights;
    ({ detail, held } = classify(shape));
  }
  // A sweep's last classification is of the surface fitted, at the vertices' own positions.
  if (!projected) {
    projected = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const v = vertices[i] * 3;
      projectToShape(
        shape as Shape,
        position[v],
        position[v + 1],
        position[v + 2],
        projected.subarray(i * 3, i * 3 + 3),
      );
    }
  }
  const move = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const v = vertices[i] * 3;
    for (let axis = 0; axis < 3; axis++)
      move[i * 3 + axis] = projected[i * 3 + axis] - position[v + axis];
  }
  return { move, detail, held, fitted: kind, limit: offsetUsed.limit };
}

/**
 * The surface of `previous`'s kind fitted to the points with weight, each counting by its weight;
 * null when their total weight is under 3 or they lie on one line.
 */
function weightedFit(
  points: Float32Array,
  normals: Float32Array,
  previous: Surface,
  noise: number,
  weights: Float64Array,
  edge: number,
): Surface | null {
  const used: number[] = [];
  let total = 0;
  const mean = [0, 0, 0];
  weights.forEach((w, i) => {
    if (!(w > 0)) return;
    used.push(i);
    total += w;
    for (let axis = 0; axis < 3; axis++) mean[axis] += w * points[i * 3 + axis];
  });
  if (total < minimumWeight) return null;
  const c = new Float64Array(9);
  for (const i of used)
    for (let r = 0; r < 3; r++)
      for (let k = 0; k < 3; k++)
        c[r * 3 + k] +=
          weights[i] *
          (points[i * 3 + r] - mean[r] / total) *
          (points[i * 3 + k] - mean[k] / total);
  // The sum of the covariance's pairwise eigenvalue products: 0 when the points lie on one line.
  const trace = c[0] + c[4] + c[8];
  const pairs = c[0] * c[4] + c[0] * c[8] + c[4] * c[8] - c[1] * c[3] - c[2] * c[6] - c[5] * c[7];
  if (!(pairs > 1e-10 * trace * trace)) return null;
  if (previous.kind === 'sweep') {
    // On the first fit's centre line: the weights narrow a partial tube's view of it.
    const fit = fitSweep(points, normals, noise, weights, edge, previous.sweep);
    return fit && { kind: 'sweep', sweep: fit.sweep };
  }
  const pick = (values: Float32Array) =>
    Float32Array.from(
      { length: used.length * 3 },
      (_, n) => values[used[(n / 3) | 0] * 3 + (n % 3)],
    );
  const fit = fitShape(
    pick(points),
    pick(normals),
    previous.kind,
    noise,
    Float64Array.from(used, (i) => weights[i]),
  );
  return fit?.shape ?? null;
}

/**
 * Base vertices whose normal is within `facing` of turning away from the surface's own normal where
 * they project (`surface`, per vertex), with the surface's side taken from the vertices' normals as
 * a whole.
 */
function facingAway(surface: Float64Array, normals: Float32Array, detail: Uint8Array) {
  const count = detail.length;
  const along = new Float64Array(count);
  let side = 0;
  for (let i = 0; i < count; i++) {
    along[i] =
      surface[i * 3] * normals[i * 3] +
      surface[i * 3 + 1] * normals[i * 3 + 1] +
      surface[i * 3 + 2] * normals[i * 3 + 2];
    side += along[i];
  }
  const sign = side < 0 ? -1 : 1;
  return Uint8Array.from(along, (a, i) => (!detail[i] && sign * a < facing ? 1 : 0));
}

/**
 * The first fit of a patch; Auto picks among the shapes only, never a sweep. A sweep is checked
 * along its path counting each vertex by `judged`.
 */
function fitOf(
  points: Float32Array,
  normals: Float32Array,
  input: RegionInput,
  noise: number,
  edge: number,
  judged: Float64Array,
): Surface | null {
  const shape = (fit: ShapeFit | null) => fit?.shape ?? null;
  if (input.treatment === 'flatten') return shape(fitShape(points, normals, 'plane', noise));
  if (input.shape === 'sweep') {
    const fit = fitSweep(points, normals, noise, null, edge, null, judged);
    return fit && { kind: 'sweep', sweep: fit.sweep };
  }
  if (input.shape !== 'auto') return shape(fitShape(points, normals, input.shape, noise));
  try {
    return fitAuto(points, normals, noise).shape;
  } catch {
    return null;
  }
}

/**
 * Smooth: each vertex moves onto a quadric fitted to the surface within `scale` of it, so ripples
 * shorter than `scale` go and the surface's own curvature stays. Detail is what stands off the
 * same projection at twice the scale; the smoothing runs with it pressed onto that base.
 */
function smoothBase(
  mesh: RefineMesh,
  topology: RefineTopology,
  region: Region,
  input: RegionInput,
  noise: number,
  normals: Float32Array,
  edge: number,
): Base {
  const { vertices, border } = region;
  const count = vertices.length;
  const { position, crease } = mesh;
  const scale = input.scale ?? smoothScale(edge);
  const free = Uint8Array.from(vertices, (v, i) => (border[i] || crease[v] ? 0 : 1));
  let detail: Uint8Array = new Uint8Array(count);
  const offsetUsed: { limit: number | null } = { limit: null };
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
    detail = detailOf(topology, region, offset, noise, input.detail, points, normals, offsetUsed);
    if (detail.includes(1)) {
      start = position.slice();
      for (let i = 0; i < count; i++)
        if (detail[i] && free[i])
          for (let axis = 0; axis < 3; axis++) start[vertices[i] * 3 + axis] = base[i * 3 + axis];
    }
  }
  const target = smoothTargets(mesh, topology, vertices, free, scale, smoothRounds, crease, start);
  const move = new Float64Array(count * 3);
  for (let i = 0; i < count; i++)
    if (free[i])
      for (let axis = 0; axis < 3; axis++)
        move[i * 3 + axis] = target[i * 3 + axis] - position[vertices[i] * 3 + axis];
  return { move, detail, held: new Uint8Array(count), fitted: null, limit: offsetUsed.limit };
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
  used?: { limit: number | null },
): Uint8Array {
  const { vertices, indexOf } = region;
  const count = vertices.length;
  const local = roughness(offset, noise);
  const limit = threshold ?? detailScale * local;
  if (used) used.limit = limit;
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
 * Final moves. Each vertex's weight is its blend times the strength, 0 on the border, on a restored
 * edge and where it stays put. An island of detail moves rigidly by the mean move of the base
 * within `ringDepth` rings of it, at the least weight of any of its vertices. The base near islands
 * and held vertices eases continuously from its own move to theirs, and into restored edges. Then
 * every triangle that moves is checked; the corners of one that would collapse or turn over are
 * held and the moves found again, and after `checkRounds` such rounds the patch is refused. The
 * positions checked are the ones written.
 */
function settle(
  mesh: RefineMesh,
  topology: RefineTopology,
  region: Region,
  base: Base,
  blend: Float32Array,
  strength: number,
  edge: number,
): Omit<PatchSolve, 'resolved'> | 'refused' {
  const { vertices, border } = region;
  const count = vertices.length;
  const { position, crease } = mesh;
  const { move, detail } = base;
  const held = base.held.slice();
  const { island, islands } = islandsOf(topology, region, detail);
  const members: number[][] = Array.from({ length: islands }, () => []);
  island.forEach((n, i) => n >= 0 && members[n].push(i));
  const carry = carried(topology, region, members, detail, held, move);
  const islandHeld = new Uint8Array(islands);
  const toCrease = surfaceDistance(
    mesh,
    topology,
    region,
    Int32Array.from(vertices, (v) => (crease[v] ? 0 : -1)),
    creaseEase * edge,
  ).distance;
  const reach = (base.fitted ? islandEase : smoothIslandEase) * edge;
  const own = Float32Array.from(blend, (b, i) =>
    border[i] || crease[vertices[i]] ? 0 : b * strength,
  );
  for (let round = 0; ; round++) {
    const weight = Float32Array.from(own, (w, i) => (held[i] ? 0 : w));
    const islandWeight = new Float64Array(islands);
    members.forEach((list, n) => {
      let least = islandHeld[n] ? 0 : Infinity;
      for (const i of list) least = Math.min(least, weight[i]);
      islandWeight[n] = least;
      for (const i of list) weight[i] = least;
    });
    // Per base vertex: the product of its own shares, and the sums of the anchors' shares and moves.
    const keep = new Float64Array(count).fill(1);
    const share = new Float64Array(count);
    const shared = new Float64Array(count * 3);
    const anchor = (sources: Int32Array, x: number, y: number, z: number) => {
      const { distance } = surfaceDistance(mesh, topology, region, sources, reach);
      for (let i = 0; i < count; i++) {
        const d = distance[i];
        if (d === Infinity || d === 0) continue;
        const s = smoothstep(d / reach);
        keep[i] *= s;
        share[i] += 1 - s;
        shared[i * 3] += (1 - s) * x;
        shared[i * 3 + 1] += (1 - s) * y;
        shared[i * 3 + 2] += (1 - s) * z;
      }
    };
    members.forEach((list, n) => {
      const sources = new Int32Array(count).fill(-1);
      for (const i of list) sources[i] = 0;
      const w = islandWeight[n];
      anchor(sources, w * carry[n * 3], w * carry[n * 3 + 1], w * carry[n * 3 + 2]);
    });
    if (held.includes(1))
      anchor(
        Int32Array.from(held, (h, i) => (h && island[i] < 0 ? 0 : -1)),
        0,
        0,
        0,
      );
    const displacement = new Float64Array(count * 3);
    const eased = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const n = island[i];
      if (n >= 0) {
        for (let axis = 0; axis < 3; axis++)
          displacement[i * 3 + axis] = islandWeight[n] * carry[n * 3 + axis];
        continue;
      }
      const w = weight[i];
      if (!(w > 0)) continue;
      const sc = smoothstep(toCrease[i] / (creaseEase * edge));
      const k = keep[i];
      const total = k + share[i];
      for (let axis = 0; axis < 3; axis++)
        displacement[i * 3 + axis] =
          (sc * (k * w * move[i * 3 + axis] + shared[i * 3 + axis])) / total;
      if (share[i] > 0 || sc < 1) eased[i] = 1;
    }
    const target = new Float64Array(count * 3);
    for (let i = 0; i < count; i++) {
      const v = vertices[i] * 3;
      const moved = weight[i] > 0;
      for (let axis = 0; axis < 3; axis++)
        target[i * 3 + axis] = position[v + axis] + (moved ? displacement[i * 3 + axis] : 0);
    }
    const failed = collapsed(mesh, topology, region, target);
    if (!failed.length) {
      const flags = Uint8Array.from(island, (n, i) => (n >= 0 || held[i] ? 1 : eased[i] ? 2 : 0));
      return { vertices, target, weight, detail: flags, fitted: base.fitted };
    }
    if (round === checkRounds) return 'refused';
    for (const i of failed) {
      if (island[i] >= 0) islandHeld[island[i]] = 1;
      else held[i] = 1;
    }
  }
}

/**
 * Region indices of the corners of triangles that moving the region's vertices to `target` would
 * shrink below `collapse` of their area or turn by more than 90 degrees.
 */
function collapsed(
  mesh: RefineMesh,
  topology: RefineTopology,
  region: Region,
  target: Float64Array,
): number[] {
  const { vertices, indexOf } = region;
  const { position, corners, weldOf } = mesh;
  const { triangleStart, trianglesOf } = topology;
  const failed = new Set<number>();
  const checked = new Set<number>();
  const was = new Float64Array(9),
    now = new Float64Array(9);
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    const p = v * 3;
    if (
      target[i * 3] === position[p] &&
      target[i * 3 + 1] === position[p + 1] &&
      target[i * 3 + 2] === position[p + 2]
    )
      continue;
    for (let j = triangleStart[v]; j < triangleStart[v + 1]; j++) {
      const t = trianglesOf[j];
      if (checked.has(t)) continue;
      checked.add(t);
      for (let c = 0; c < 3; c++) {
        const w = weldOf[corners[t * 3 + c]];
        const k = indexOf[w];
        for (let axis = 0; axis < 3; axis++) {
          was[c * 3 + axis] = position[w * 3 + axis];
          now[c * 3 + axis] = k >= 0 ? target[k * 3 + axis] : was[c * 3 + axis];
        }
      }
      const [ax, ay, az] = crossOf(was),
        [bx, by, bz] = crossOf(now);
      const before = Math.hypot(ax, ay, az),
        after = Math.hypot(bx, by, bz);
      if (after >= collapse * before && ax * bx + ay * by + az * bz >= 0) continue;
      for (let c = 0; c < 3; c++) {
        const k = indexOf[weldOf[corners[t * 3 + c]]];
        if (k >= 0) failed.add(k);
      }
    }
  }
  return [...failed].sort((x, y) => x - y);
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

/**
 * Each island's move: the mean move of the base vertices within `ringDepth` rings of it. The nearest
 * ring alone sits where the island's growth stopped, off the surface on the island's side, and
 * would sink it.
 */
function carried(
  topology: RefineTopology,
  region: Region,
  members: number[][],
  detail: Uint8Array,
  held: Uint8Array,
  move: Float64Array,
) {
  const { vertices, indexOf } = region;
  const { neighbourStart, neighbours } = topology;
  const carry = new Float64Array(members.length * 3);
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
          if (held[k]) continue;
          x += move[k * 3];
          y += move[k * 3 + 1];
          z += move[k * 3 + 2];
          rung++;
        }
      }
      front = next;
    }
    if (rung) carry.set([x / rung, y / rung, z / rung], n * 3);
  });
  return carry;
}

/** The region's triangles split into edge-connected patches, ordered by smallest triangle. */
function patchesOf(mesh: RefineMesh, topology: RefineTopology, triangles: Uint32Array) {
  const slot = new Int32Array(mesh.triangleCount).fill(-1);
  const sorted = Uint32Array.from(triangles).sort();
  let count = 0;
  for (const t of sorted) if (slot[t] < 0) sorted[(slot[t] = count++)] = t;
  const parent = Int32Array.from({ length: count }, (_, n) => n);
  const root = (n: number): number => {
    while (parent[n] !== n) n = parent[n] = parent[parent[n]];
    return n;
  };
  const { triangleStart, trianglesOf } = topology;
  const { corners, weldOf } = mesh;
  for (let n = 0; n < count; n++) {
    const t = sorted[n];
    for (let k = 0; k < 3; k++) {
      const a = weldOf[corners[t * 3 + k]],
        b = weldOf[corners[t * 3 + ((k + 1) % 3)]];
      for (let j = triangleStart[a]; j < triangleStart[a + 1]; j++) {
        const u = trianglesOf[j];
        const m = slot[u];
        if (m < 0 || u === t) continue;
        const shares =
          weldOf[corners[u * 3]] === b ||
          weldOf[corners[u * 3 + 1]] === b ||
          weldOf[corners[u * 3 + 2]] === b;
        if (!shares) continue;
        const x = root(n),
          y = root(m);
        if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let n = 0; n < count; n++) {
    const r = root(n);
    const list = groups.get(r);
    if (list) list.push(sorted[n]);
    else groups.set(r, [sorted[n]]);
  }
  return [...groups.values()].map((list) => Uint32Array.from(list));
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

/** Smoothstep of the distance along the surface from the border, reaching 1 at `blend`. */
function blendWeights(
  mesh: RefineMesh,
  topology: RefineTopology,
  region: Region,
  blend: number,
): Float32Array {
  const sources = Int32Array.from(region.border, (b) => (b ? 0 : -1));
  const { distance } = surfaceDistance(mesh, topology, region, sources, Infinity);
  return Float32Array.from(distance, (d) => {
    if (d === 0) return 0;
    return blend > 0 ? smoothstep(d / blend) : 1;
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
