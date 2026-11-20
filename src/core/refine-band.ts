import {
  type EdgeCurve,
  type GuideKind,
  closestOnCurve,
  curveTangent,
  drawnCurve,
} from './refine-curve';
import { type Shape, fitAuto, fitShape, shapeDistance } from './refine-fit';
import { type RefineMesh, type RefineTopology, vertexNormal, weldedCorner } from './refine-mesh';
import type { Vec3 } from './types';

export interface GuidePoint {
  triangle: number;
  position: Vec3;
}
export const enum BandZone {
  Soft = 0,
  Left = 1,
  Right = 2,
  Beyond = 3,
}
export interface EdgeBand {
  /** Welded vertices within `width` of the drawn guide, connected over the surface to the clicked triangles. */
  vertices: Uint32Array;
  /** Per band vertex: distance along the drawn guide, signed offset across it, and zone. */
  station: Float32Array;
  cross: Float32Array;
  zone: Uint8Array;
  drawn: EdgeCurve;
  /** Half-width of the softened zone, mm. */
  soft: number;
}

/** Fewest vertices a flank may have. */
const minimumFlank = 12;
/** Share of each side's extent, from its outer edge, that seeds the flank fit. */
const outerShare = 0.4;
/** Stations per slice of the straight-profile fallback and of the frame normals. */
const sliceSteps = 4;
/** Longest path across the guide over the surface, as a multiple of the width. */
const lateralReach = 1.5;
const unset = -1;

/** Min-heap of (distance, vertex) pairs on typed arrays that grow as needed. */
class Heap {
  private key = new Float64Array(1024);
  private value = new Uint32Array(1024);
  size = 0;
  /** Key of the entry `pop` last removed. */
  top = 0;

  push(k: number, v: number) {
    if (this.size === this.key.length) {
      const key = new Float64Array(this.size * 2),
        value = new Uint32Array(this.size * 2);
      key.set(this.key);
      value.set(this.value);
      this.key = key;
      this.value = value;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.key[p] <= k) break;
      this.key[i] = this.key[p];
      this.value[i] = this.value[p];
      i = p;
    }
    this.key[i] = k;
    this.value[i] = v;
  }

  /** Removes the smallest entry; returns its value and leaves its key in `top`. */
  pop() {
    const v = this.value[0];
    this.top = this.key[0];
    const last = --this.size;
    const k = this.key[last],
      u = this.value[last];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= last) break;
      if (c + 1 < last && this.key[c + 1] < this.key[c]) c++;
      if (this.key[c] >= k) break;
      this.key[i] = this.key[c];
      this.value[i] = this.value[c];
      i = c;
    }
    this.key[i] = k;
    this.value[i] = u;
    return v;
  }
}

const length3 = (p: Float64Array, a: number, b: number) =>
  Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);

/** Mean length of the edges at the corners of the clicked triangles. */
function localEdge(mesh: RefineMesh, topology: RefineTopology, points: GuidePoint[]) {
  const { neighbourStart, neighbours } = topology;
  let sum = 0,
    count = 0;
  for (const { triangle } of points)
    for (const k of [0, 1, 2] as const) {
      const v = weldedCorner(mesh, triangle, k);
      for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
        sum += length3(mesh.position, v, neighbours[j]);
        count++;
      }
    }
  return count ? sum / count : 0;
}

/** The band's welded vertices, ascending, with the station, distance and closest point of each. */
function flood(
  mesh: RefineMesh,
  topology: RefineTopology,
  drawn: EdgeCurve,
  points: GuidePoint[],
  width: number,
  edge: number,
) {
  const { position, weldedCount } = mesh;
  const { neighbourStart, neighbours } = topology;
  // Slot of each welded vertex whose distance to the curve is known, or unset.
  const slot = new Int32Array(weldedCount).fill(unset);
  const station: number[] = [],
    distance: number[] = [],
    closest: number[] = [],
    welded: number[] = [];
  const lateral: number[] = [];
  const at = new Float64Array(3);
  const measure = (v: number) => {
    if (slot[v] !== unset) return slot[v];
    const x = position[v * 3],
      y = position[v * 3 + 1],
      z = position[v * 3 + 2];
    const s = closestOnCurve(drawn, x, y, z, at);
    slot[v] = welded.length;
    welded.push(v);
    station.push(s);
    distance.push(Math.hypot(x - at[0], y - at[1], z - at[2]));
    closest.push(at[0], at[1], at[2]);
    lateral.push(Infinity);
    return slot[v];
  };
  // Cost of a path is its length across the guide, so it climbs onto no sheet far over the surface.
  const reach = lateralReach * width;
  const heap = new Heap();
  const offer = (i: number, g: number) => {
    if (distance[i] > width || g > reach || g >= lateral[i]) return;
    lateral[i] = g;
    heap.push(g, welded[i]);
  };
  for (const { triangle } of points)
    for (const k of [0, 1, 2] as const) {
      const i = measure(weldedCorner(mesh, triangle, k));
      offer(i, distance[i]);
    }
  while (heap.size) {
    const u = heap.pop();
    const iu = slot[u];
    if (heap.top > lateral[iu]) continue;
    for (let j = neighbourStart[u]; j < neighbourStart[u + 1]; j++) {
      const w = neighbours[j];
      const iw = measure(w);
      const span = length3(position, u, w);
      const along = station[iw] - station[iu];
      const across = Math.sqrt(Math.max(0, span * span - along * along));
      // A vertex beside the guide restarts the path, so creeping along the guide costs nothing.
      offer(iw, Math.min(lateral[iu] + across, distance[iw] <= edge ? distance[iw] : Infinity));
    }
  }
  const vertices = Uint32Array.from(welded.filter((_, i) => lateral[i] !== Infinity)).sort();
  const count = vertices.length;
  const result = {
    vertices,
    station: new Float64Array(count),
    distance: new Float64Array(count),
    closest: new Float64Array(count * 3),
    /** Band index of each welded vertex, or unset. */
    slot,
  };
  for (let i = 0; i < count; i++) {
    const k = slot[vertices[i]];
    result.station[i] = station[k];
    result.distance[i] = distance[k];
    result.closest.set(closest.slice(k * 3, k * 3 + 3), i * 3);
  }
  for (const v of welded) slot[v] = unset;
  vertices.forEach((v, i) => (slot[v] = i));
  return result;
}

/** Slice of `station` among `count` equal slices of `total`, the same from either end. */
const sliceOf = (station: number, total: number, count: number) =>
  Math.min(count - 1, Math.max(0, Math.floor((station / total) * count)));

/** Signed distance of a band vertex from its side's flank fit. */
type FlankDistance = (i: number) => number;

/**
 * The flank fit of one side: `fitAuto` over its outer share, or, when that is not within the
 * noise, a plane per slice of stations. Null when no fit can be made.
 */
function flankFit(
  seeds: number[],
  position: Float64Array,
  vertices: Uint32Array,
  normals: Float32Array,
  station: Float64Array,
  total: number,
  slices: number,
  noise: number,
): FlankDistance | null {
  const sample = (members: number[]) => {
    const p = new Float32Array(members.length * 3),
      n = new Float32Array(members.length * 3);
    members.forEach((i, k) => {
      p.set(position.subarray(vertices[i] * 3, vertices[i] * 3 + 3), k * 3);
      n.set(normals.subarray(i * 3, i * 3 + 3), k * 3);
    });
    return [p, n] as const;
  };
  const distanceTo = (shape: Shape, i: number) => {
    const v = vertices[i] * 3;
    return shapeDistance(shape, position[v], position[v + 1], position[v + 2]);
  };
  if (seeds.length < 3) return null;
  let whole: Shape | null = null;
  try {
    const fit = fitAuto(...sample(seeds), noise);
    if (fit.within) whole = fit.shape;
  } catch {
    // No shape fits the seeds as a whole; the per-slice planes below may still.
  }
  if (whole) {
    const shape = whole;
    return (i) => distanceTo(shape, i);
  }
  const bySlice: number[][] = Array.from({ length: slices }, () => []);
  for (const i of seeds) bySlice[sliceOf(station[i], total, slices)].push(i);
  const planes = bySlice.map((members) =>
    members.length >= 3 ? fitShape(...sample(members), 'plane', noise) : null,
  );
  if (planes.every((plane) => !plane)) return null;
  // A slice without a plane borrows the nearest one, the better fit on a tie.
  const chosen = planes.map((plane, s) => {
    if (plane) return plane.shape;
    for (let d = 1; ; d++) {
      const a = planes[s - d],
        b = planes[s + d];
      if (a && b) return (a.rms <= b.rms ? a : b).shape;
      if (a || b) return (a ?? b)!.shape;
    }
  });
  return (i) => distanceTo(chosen[sliceOf(station[i], total, slices)], i);
}

/** Visits every band vertex reachable from `seeds` through band vertices that `pass` accepts. */
function grow(
  seeds: Iterable<number>,
  pass: (i: number) => boolean,
  mark: Uint8Array,
  vertices: Uint32Array,
  slotOf: (v: number) => number,
  topology: RefineTopology,
) {
  const queue: number[] = [];
  for (const i of seeds)
    if (!mark[i] && pass(i)) {
      mark[i] = 1;
      queue.push(i);
    }
  const { neighbourStart, neighbours } = topology;
  for (let q = 0; q < queue.length; q++) {
    const v = vertices[queue[q]];
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const i = slotOf(neighbours[j]);
      if (i === unset || mark[i] || !pass(i)) continue;
      mark[i] = 1;
      queue.push(i);
    }
  }
}

/** Null when no softened zone lies under the guide. */
export function buildBand(
  mesh: RefineMesh,
  topology: RefineTopology,
  kind: GuideKind,
  points: GuidePoint[],
  width: number,
  noise: number,
): EdgeBand | null {
  if (points.length < 2 || !(width > 0)) return null;
  const edge = localEdge(mesh, topology, points);
  if (!(edge > 0)) return null;
  const drawn = drawnCurve(
    kind,
    points.flatMap((p) => p.position),
    edge,
  );
  const total = drawn.lengths[drawn.lengths.length - 1];
  if (!(total > 0)) return null;
  const { position } = mesh;
  const { neighbourStart, neighbours } = topology;
  const band = flood(mesh, topology, drawn, points, width, edge);
  const { vertices, station, distance, closest, slot } = band;
  const count = vertices.length;
  const slotOf = (v: number) => slot[v];

  // Frame normal per slice: the vertex normals, weighted toward the guide.
  const slices = Math.max(1, Math.round(total / (sliceSteps * edge)));
  const normals = new Float32Array(count * 3);
  const sliceNormal = new Float64Array(slices * 3);
  const normal = new Float32Array(3);
  for (let i = 0; i < count; i++) {
    vertexNormal(mesh, topology, vertices[i], normal);
    normals.set(normal, i * 3);
    const weight = 1 - distance[i] / width,
      s = sliceOf(station[i], total, slices);
    for (let a = 0; a < 3; a++) sliceNormal[s * 3 + a] += weight * normal[a];
  }
  const cross = new Float64Array(count);
  const facing = new Uint8Array(count);
  const tangent = new Float64Array(3);
  for (let i = 0; i < count; i++) {
    // Blended between slice centres, so the frame turns smoothly and the same from either end.
    const f = Math.min(slices - 1, Math.max(0, (station[i] / total) * slices - 0.5));
    const s0 = Math.floor(f),
      s1 = Math.min(slices - 1, s0 + 1),
      t = f - s0;
    curveTangent(drawn, station[i], tangent);
    const n = [0, 1, 2].map((a) => sliceNormal[s0 * 3 + a] * (1 - t) + sliceNormal[s1 * 3 + a] * t);
    const along = n[0] * tangent[0] + n[1] * tangent[1] + n[2] * tangent[2];
    for (let a = 0; a < 3; a++) n[a] -= along * tangent[a];
    // n x tangent points left of travel, seen from outside the surface.
    const b = [
      n[1] * tangent[2] - n[2] * tangent[1],
      n[2] * tangent[0] - n[0] * tangent[2],
      n[0] * tangent[1] - n[1] * tangent[0],
    ];
    const bLength = Math.hypot(b[0], b[1], b[2]) || 1;
    const v = vertices[i] * 3;
    let offset = 0;
    for (let a = 0; a < 3; a++) offset += (position[v + a] - closest[i * 3 + a]) * b[a];
    cross[i] = offset / bLength;
    // A vertex facing away from the edge lies on another surface, never a flank or the soft zone.
    facing[i] = +(
      n[0] * normals[i * 3] + n[1] * normals[i * 3 + 1] + n[2] * normals[i * 3 + 2] >
      0
    );
  }

  // Flanks, from the outside in: fit each side's outer share, then grow while within the noise.
  const tolerance = 3 * noise;
  const claims: Uint8Array[] = [];
  for (const sign of [1, -1]) {
    let extent = 0;
    for (let i = 0; i < count; i++)
      if (facing[i] && cross[i] * sign > 0) extent = Math.max(extent, cross[i] * sign);
    const seeds: number[] = [];
    for (let i = 0; i < count; i++)
      if (facing[i] && cross[i] * sign >= (1 - outerShare) * extent && cross[i] * sign > 0)
        seeds.push(i);
    const fit = flankFit(seeds, position, vertices, normals, station, total, slices, noise);
    if (!fit) return null;
    const claim = new Uint8Array(count);
    grow(
      seeds,
      (i) => facing[i] === 1 && Math.abs(fit(i)) <= tolerance,
      claim,
      vertices,
      slotOf,
      topology,
    );
    claims.push(claim);
  }
  const [leftClaim, rightClaim] = claims;
  const zone = new Uint8Array(count).fill(BandZone.Beyond);
  // A vertex both flanks claim is where the faces meet, so it is left for the soft zone.
  for (let i = 0; i < count; i++)
    if (leftClaim[i] !== rightClaim[i]) zone[i] = leftClaim[i] ? BandZone.Left : BandZone.Right;

  // Soft: what is left between the flanks and connected to the guide.
  const guideSeeds: number[] = [];
  for (const { triangle } of points)
    for (const k of [0, 1, 2] as const) guideSeeds.push(slotOf(weldedCorner(mesh, triangle, k)));
  for (let i = 0; i < count; i++) if (distance[i] <= edge) guideSeeds.push(i);
  const soft = new Uint8Array(count);
  const open = (i: number) => facing[i] === 1 && zone[i] === BandZone.Beyond;
  grow(
    guideSeeds.filter((i) => i !== unset),
    open,
    soft,
    vertices,
    slotOf,
    topology,
  );
  let softCount = 0;
  for (let i = 0; i < count; i++)
    if (soft[i]) {
      zone[i] = BandZone.Soft;
      softCount++;
    }
  if (!softCount) return null;

  splitSharedFlanks(zone, vertices, slotOf, topology, position);

  let left = 0,
    right = 0;
  for (const z of zone) {
    if (z === BandZone.Left) left++;
    else if (z === BandZone.Right) right++;
  }
  if (left < minimumFlank || right < minimumFlank) return null;

  // Half-width: the median offset of the edges where the soft zone meets a flank.
  const boundary: number[] = [];
  for (let i = 0; i < count; i++) {
    if (zone[i] !== BandZone.Soft) continue;
    const v = vertices[i];
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const k = slotOf(neighbours[j]);
      if (k !== unset && (zone[k] === BandZone.Left || zone[k] === BandZone.Right))
        boundary.push((Math.abs(cross[i]) + Math.abs(cross[k])) / 2);
    }
  }
  if (!boundary.length) return null;
  boundary.sort((a, b) => a - b);
  const middle = boundary.length >> 1;
  const half =
    boundary.length % 2 ? boundary[middle] : (boundary[middle - 1] + boundary[middle]) / 2;

  return {
    vertices,
    station: Float32Array.from(station),
    cross: Float32Array.from(cross),
    zone,
    drawn,
    soft: half,
  };
}

/**
 * Where a flank runs on to a second soft zone, which reaches the band's boundary, that zone and
 * the part of the flank nearer to it than to the guide's soft zone become Beyond: that stretch of
 * face belongs to the other edge. Beyond pockets enclosed by a flank stay as they are.
 */
function splitSharedFlanks(
  zone: Uint8Array,
  vertices: Uint32Array,
  slotOf: (v: number) => number,
  topology: RefineTopology,
  position: Float64Array,
) {
  const count = vertices.length;
  const { neighbourStart, neighbours } = topology;
  // Components of Beyond; one with a vertex next to a non-band vertex is a second soft zone.
  const component = new Int32Array(count).fill(unset);
  const outer: boolean[] = [];
  for (let start = 0; start < count; start++) {
    if (zone[start] !== BandZone.Beyond || component[start] !== unset) continue;
    const id = outer.length;
    let reaches = false;
    const queue = [start];
    component[start] = id;
    for (let q = 0; q < queue.length; q++) {
      const v = vertices[queue[q]];
      for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
        const k = slotOf(neighbours[j]);
        if (k === unset) reaches = true;
        else if (zone[k] === BandZone.Beyond && component[k] === unset) {
          component[k] = id;
          queue.push(k);
        }
      }
    }
    outer.push(reaches);
  }
  if (!outer.some(Boolean)) return;
  // Multi-source shortest paths over each flank, from the edge under the guide and from the second
  // soft zone. The edge is wherever the flank meets the soft zone or, across a soft zone narrower
  // than the mesh, the other flank.
  const reached = new Float64Array(count).fill(Infinity);
  const far = new Uint8Array(count);
  const heap = new Heap();
  for (let i = 0; i < count; i++) {
    if (zone[i] !== BandZone.Left && zone[i] !== BandZone.Right) continue;
    const v = vertices[i];
    let nearEdge = false,
      nearBeyond = false;
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const k = slotOf(neighbours[j]);
      if (k === unset || zone[k] === zone[i]) continue;
      if (zone[k] !== BandZone.Beyond) nearEdge = true;
      else if (outer[component[k]]) nearBeyond = true;
    }
    // A vertex touching both stays with the edge under the guide.
    if (nearEdge || nearBeyond) {
      reached[i] = 0;
      far[i] = +!nearEdge;
      heap.push(0, i);
    }
  }
  while (heap.size) {
    const i = heap.pop();
    if (heap.top > reached[i]) continue;
    const v = vertices[i];
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const k = slotOf(neighbours[j]);
      if (k === unset || zone[k] !== zone[i]) continue;
      const d = reached[i] + length3(position, v, neighbours[j]);
      // Ties go to the guide's side, the same whichever way the guide was drawn.
      if (d < reached[k] || (d === reached[k] && far[k] && !far[i])) {
        reached[k] = d;
        far[k] = far[i];
        heap.push(d, k);
      }
    }
  }
  for (let i = 0; i < count; i++) if (far[i]) zone[i] = BandZone.Beyond;
}

/**
 * A width that leaves flank on both sides: soft + max(2 * soft, 6 * the local edge length). 0 when
 * no softened zone is found.
 */
export function estimateWidth(
  mesh: RefineMesh,
  topology: RefineTopology,
  kind: GuideKind,
  points: GuidePoint[],
  noise: number,
): number {
  const edge = localEdge(mesh, topology, points);
  if (!(edge > 0)) return 0;
  // A band narrower than the soft zone fits its flanks on the fillet and reads the zone too narrow,
  // so the trial band widens by half until two in a row agree.
  let trial = 12 * edge,
    previous = NaN;
  for (let round = 0; round < 8; round++, trial *= 1.5) {
    const soft = buildBand(mesh, topology, kind, points, trial, noise)?.soft ?? NaN;
    if (Math.abs(soft - previous) <= Math.max(0.25 * soft, edge))
      return soft + Math.max(2 * soft, 6 * edge);
    previous = soft;
  }
  return 0;
}
