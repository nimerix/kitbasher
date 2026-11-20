import {
  type EdgeCurve,
  type GuideKind,
  closestOnCurve,
  curveTangent,
  drawnCurve,
} from './refine-curve';
import { type Shape, type ShapeKind, fitAuto, shapeDistance } from './refine-fit';
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
/** How a flank was fitted: one shape over the whole flank, or a straight profile per slice. */
export type BandFit = ShapeKind | 'profile';
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
  /** The Left and Right flank fits. */
  fits: [BandFit, BandFit];
}

/** Fewest degrees between the two flanks' normals near the guide for the band to show an edge. */
export const minBandAngle = 10;

/** Fewest vertices a flank may have. */
const minimumFlank = 12;
/** Stations per slice of the frame normals and of the straight-profile fallback. */
const sliceSteps = 4;
/** Longest path from the spine over the surface, as a multiple of the width. */
const surfaceReach = 1.25;
/** Rounds of refitting each flank on what it grew to. */
const refits = 3;
const unset = -1;

/** Min-heap of (distance, index) pairs on typed arrays that grow as needed. */
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

/** Open-addressed map from welded vertex to a small integer, sized by what it holds, not by the mesh. */
class VertexMap {
  private bits = 10;
  private keys = new Int32Array(1 << this.bits).fill(unset);
  private values = new Int32Array(1 << this.bits);
  private size = 0;

  private home(v: number) {
    return Math.imul(v, 0x9e3779b1) >>> (32 - this.bits);
  }

  get(v: number) {
    const mask = (1 << this.bits) - 1;
    for (let h = this.home(v); ; h = (h + 1) & mask) {
      if (this.keys[h] === v) return this.values[h];
      if (this.keys[h] === unset) return unset;
    }
  }

  set(v: number, value: number) {
    if (2 * (this.size + 1) > this.keys.length) {
      const { keys, values } = this;
      this.bits++;
      this.keys = new Int32Array(1 << this.bits).fill(unset);
      this.values = new Int32Array(1 << this.bits);
      this.size = 0;
      for (let h = 0; h < keys.length; h++) if (keys[h] !== unset) this.set(keys[h], values[h]);
    }
    const mask = (1 << this.bits) - 1;
    let h = this.home(v);
    while (this.keys[h] !== unset && this.keys[h] !== v) h = (h + 1) & mask;
    if (this.keys[h] === unset) this.size++;
    this.keys[h] = v;
    this.values[h] = value;
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

/**
 * The band's welded vertices, ascending, with the station, distance and closest point of each and
 * its neighbours inside the band. Null when the clicks are not joined over the surface near the
 * drawn guide.
 */
function gather(
  mesh: RefineMesh,
  topology: RefineTopology,
  drawn: EdgeCurve,
  total: number,
  points: GuidePoint[],
  width: number,
  edge: number,
) {
  const { position } = mesh;
  const { neighbourStart, neighbours } = topology;
  const slots = new VertexMap();
  const welded: number[] = [],
    station: number[] = [],
    distance: number[] = [],
    closest: number[] = [],
    open: boolean[] = [];
  const p = drawn.points,
    last = p.length / 3 - 1;
  const startTangent = new Float64Array(3),
    endTangent = new Float64Array(3);
  curveTangent(drawn, 0, startTangent);
  curveTangent(drawn, total, endTangent);
  const ends = 1e-9 * (1 + total);
  const at = new Float64Array(3);
  // Measures a vertex once; `open` is false past an end of an open guide.
  const measure = (v: number) => {
    const known = slots.get(v);
    if (known !== unset) return known;
    const x = position[v * 3],
      y = position[v * 3 + 1],
      z = position[v * 3 + 2];
    const s = closestOnCurve(drawn, x, y, z, at);
    let inside = true;
    if (!drawn.closed) {
      const before =
        s <= ends &&
        (x - p[0]) * startTangent[0] + (y - p[1]) * startTangent[1] + (z - p[2]) * startTangent[2] <
          0;
      const after =
        s >= total - ends &&
        (x - p[last * 3]) * endTangent[0] +
          (y - p[last * 3 + 1]) * endTangent[1] +
          (z - p[last * 3 + 2]) * endTangent[2] >
          0;
      inside = !before && !after;
    }
    const k = welded.length;
    slots.set(v, k);
    welded.push(v);
    station.push(s);
    distance.push(Math.hypot(x - at[0], y - at[1], z - at[2]));
    closest.push(at[0], at[1], at[2]);
    open.push(inside);
    return k;
  };

  // Spine: the vertices near the drawn guide connected to the first click, widened until it
  // reaches every clicked triangle, never past `width`.
  const corners = points.map((point) =>
    ([0, 1, 2] as const).map((k) => measure(weldedCorner(mesh, point.triangle, k))),
  );
  let spine: number[] = [];
  for (let limit = Math.min(width, 2 * edge); ; limit = Math.min(width, 2 * limit)) {
    const inTube = new Set<number>();
    const queue: number[] = [];
    for (const k of corners[0])
      if (distance[k] <= limit && open[k] && !inTube.has(k)) {
        inTube.add(k);
        queue.push(k);
      }
    for (let q = 0; q < queue.length; q++) {
      const v = welded[queue[q]];
      for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
        const k = measure(neighbours[j]);
        if (inTube.has(k) || distance[k] > limit || !open[k]) continue;
        inTube.add(k);
        queue.push(k);
      }
    }
    if (corners.every((triangle) => triangle.some((k) => inTube.has(k)))) {
      spine = queue;
      break;
    }
    if (limit >= width) return null;
  }

  // The band: within `width` of the drawn guide and within the reach of the spine over the surface.
  const reach: number[] = [];
  const reachOf = (k: number) => reach[k] ?? Infinity;
  const budget = surfaceReach * width;
  const heap = new Heap();
  for (const k of spine) {
    reach[k] = 0;
    heap.push(0, k);
  }
  while (heap.size) {
    const k = heap.pop();
    if (heap.top > reachOf(k)) continue;
    const v = welded[k];
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const w = measure(neighbours[j]);
      if (distance[w] > width || !open[w]) continue;
      const g = reachOf(k) + length3(position, v, welded[w]);
      if (g > budget || g >= reachOf(w)) continue;
      reach[w] = g;
      heap.push(g, w);
    }
  }
  const members: number[] = [];
  for (let k = 0; k < welded.length; k++) if (reachOf(k) !== Infinity) members.push(k);
  members.sort((a, b) => welded[a] - welded[b]);
  const count = members.length;
  const slotIndex = new Int32Array(welded.length).fill(unset);
  members.forEach((k, i) => (slotIndex[k] = i));
  const vertices = new Uint32Array(count);
  const result = {
    vertices,
    station: new Float64Array(count),
    distance: new Float64Array(count),
    closest: new Float64Array(count * 3),
    /** Band index of every spine vertex. */
    spine: spine.map((k) => slotIndex[k]),
    /** CSR of each band vertex's neighbours inside the band. */
    linkStart: new Uint32Array(count + 1),
    links: [] as number[],
    /** 1 where a band vertex has a neighbour outside the band. */
    edgeOfBand: new Uint8Array(count),
  };
  for (let i = 0; i < count; i++) {
    const k = members[i],
      v = welded[k];
    vertices[i] = v;
    result.station[i] = station[k];
    result.distance[i] = distance[k];
    for (let a = 0; a < 3; a++) result.closest[i * 3 + a] = closest[k * 3 + a];
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const w = slots.get(neighbours[j]);
      const index = w === unset ? unset : slotIndex[w];
      if (index === unset) result.edgeOfBand[i] = 1;
      else result.links.push(index);
    }
    result.linkStart[i + 1] = result.links.length;
  }
  return result;
}

type Band = NonNullable<ReturnType<typeof gather>>;

/** Visits every band vertex reachable from `seeds` through band vertices that `pass` accepts. */
function grow(seeds: Iterable<number>, pass: (i: number) => boolean, band: Band) {
  const mark = new Uint8Array(band.vertices.length);
  const queue: number[] = [];
  for (const i of seeds)
    if (!mark[i] && pass(i)) {
      mark[i] = 1;
      queue.push(i);
    }
  const { linkStart, links } = band;
  for (let q = 0; q < queue.length; q++)
    for (let j = linkStart[queue[q]]; j < linkStart[queue[q] + 1]; j++) {
      const i = links[j];
      if (mark[i] || !pass(i)) continue;
      mark[i] = 1;
      queue.push(i);
    }
  return mark;
}

/** The cross-section frame at each band vertex and where the vertex lies in it. */
interface Frame {
  /** Unit normal of the frame and unit offset direction across the guide, 3 per vertex. */
  normal: Float64Array;
  across: Float64Array;
  cross: Float64Array;
  height: Float64Array;
  /** Angle of the vertex normal from the frame normal, toward `across`. */
  turn: Float64Array;
  facing: Uint8Array;
  vertexNormals: Float32Array;
  /** Lower slice and weight of the upper one, laid out symmetrically about the guide's middle. */
  slice: Int32Array;
  blend: Float64Array;
  slices: number;
}

function frameOf(
  mesh: RefineMesh,
  topology: RefineTopology,
  band: Band,
  drawn: EdgeCurve,
  total: number,
  width: number,
  edge: number,
): Frame {
  const { vertices, station, distance, closest } = band;
  const count = vertices.length;
  const { position } = mesh;
  const slices = Math.max(1, Math.round(total / (sliceSteps * edge)));
  const slice = new Int32Array(count),
    blend = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    // Slice centres sit symmetrically about the middle, so reversing the guide mirrors the weights.
    const f = Math.min(
      slices - 1,
      Math.max(0, ((station[i] - total / 2) / total) * slices + (slices - 1) / 2),
    );
    slice[i] = Math.min(slices - 2, Math.floor(f));
    if (slices === 1) slice[i] = 0;
    blend[i] = slices === 1 ? 0 : f - slice[i];
  }
  const upper = (i: number) => Math.min(slices - 1, slice[i] + 1);
  const vertexNormals = new Float32Array(count * 3);
  const sliceNormal = new Float64Array(slices * 3);
  const n = new Float32Array(3);
  for (let i = 0; i < count; i++) {
    vertexNormal(mesh, topology, vertices[i], n);
    vertexNormals.set(n, i * 3);
    const weight = 1 - distance[i] / width;
    for (let a = 0; a < 3; a++) {
      sliceNormal[slice[i] * 3 + a] += (1 - blend[i]) * weight * n[a];
      sliceNormal[upper(i) * 3 + a] += blend[i] * weight * n[a];
    }
  }
  const frame: Frame = {
    normal: new Float64Array(count * 3),
    across: new Float64Array(count * 3),
    cross: new Float64Array(count),
    height: new Float64Array(count),
    turn: new Float64Array(count),
    facing: new Uint8Array(count),
    vertexNormals,
    slice,
    blend,
    slices,
  };
  const t = new Float64Array(3);
  for (let i = 0; i < count; i++) {
    curveTangent(drawn, station[i], t);
    const s0 = slice[i] * 3,
      s1 = upper(i) * 3;
    const m = [0, 1, 2].map(
      (a) => sliceNormal[s0 + a] * (1 - blend[i]) + sliceNormal[s1 + a] * blend[i],
    );
    const along = m[0] * t[0] + m[1] * t[1] + m[2] * t[2];
    for (let a = 0; a < 3; a++) m[a] -= along * t[a];
    const mLength = Math.hypot(m[0], m[1], m[2]) || 1;
    for (let a = 0; a < 3; a++) m[a] /= mLength;
    // normal x tangent points left of travel, seen from outside the surface.
    const b = [m[1] * t[2] - m[2] * t[1], m[2] * t[0] - m[0] * t[2], m[0] * t[1] - m[1] * t[0]];
    const bLength = Math.hypot(b[0], b[1], b[2]) || 1;
    for (let a = 0; a < 3; a++) b[a] /= bLength;
    frame.normal.set(m, i * 3);
    frame.across.set(b, i * 3);
    let c = 0,
      h = 0,
      nb = 0,
      nm = 0;
    for (let a = 0; a < 3; a++) {
      const d = position[vertices[i] * 3 + a] - closest[i * 3 + a];
      c += d * b[a];
      h += d * m[a];
      nb += vertexNormals[i * 3 + a] * b[a];
      nm += vertexNormals[i * 3 + a] * m[a];
    }
    frame.cross[i] = c;
    frame.height[i] = h;
    frame.turn[i] = Math.atan2(nb, nm);
    // A vertex facing away from the edge lies on another surface, never a flank or the soft zone.
    frame.facing[i] = +(nm > 0);
  }
  return frame;
}

/** A flank's fitted surface, read at band vertices. */
interface FlankFit {
  kind: BandFit;
  /** Signed distance of a band vertex from the fit. */
  distance(i: number): number;
  /** Unit normal of the fit at a band vertex. */
  normal(i: number): number[];
}

function shapeFit(shape: Shape, position: Float64Array, vertices: Uint32Array): FlankFit {
  const at = (i: number, a: number) => position[vertices[i] * 3 + a];
  const step = 1e-4;
  return {
    kind: shape.kind,
    distance: (i) => shapeDistance(shape, at(i, 0), at(i, 1), at(i, 2)),
    normal: (i) => {
      const g = [0, 1, 2].map((a) => {
        const p = [at(i, 0), at(i, 1), at(i, 2)];
        p[a] += step;
        const forward = shapeDistance(shape, p[0], p[1], p[2]);
        p[a] -= 2 * step;
        return forward - shapeDistance(shape, p[0], p[1], p[2]);
      });
      const length = Math.hypot(g[0], g[1], g[2]) || 1;
      return g.map((v) => v / length);
    },
  };
}

/**
 * A straight line per slice in that slice's cross-section (offset across the guide against height
 * along the frame normal), from at most two slices either side when a slice has too few points.
 * Points beyond 3 * noise are dropped and the lines refitted.
 */
function profileFit(members: number[], frame: Frame, noise: number): FlankFit | null {
  const { slices, slice, blend, cross, height } = frame;
  const upper = (i: number) => Math.min(slices - 1, slice[i] + 1);
  // Per slice: offset, height and unit normal of its line, or NaN when it has none.
  const line = new Float64Array(slices * 4);
  const sliceDistance = (k: number, i: number) =>
    (cross[i] - line[k * 4]) * line[k * 4 + 2] + (height[i] - line[k * 4 + 1]) * line[k * 4 + 3];
  const mix = (i: number, of: (k: number) => number) => {
    const k0 = slice[i],
      k1 = upper(i);
    const a = of(k0),
      b = of(k1);
    if (Number.isNaN(a)) return b;
    if (Number.isNaN(b)) return a;
    return a * (1 - blend[i]) + b * blend[i];
  };
  const distance = (i: number) => {
    const d = mix(i, (k) => sliceDistance(k, i));
    return Number.isNaN(d) ? Infinity : d;
  };
  let active = members;
  const stats = new Float64Array(slices * 6);
  for (let round = 0; round < 4; round++) {
    stats.fill(0);
    for (const i of active)
      for (const [k, w] of [
        [slice[i], 1 - blend[i]],
        [upper(i), blend[i]],
      ]) {
        if (w <= 0) continue;
        const c = cross[i],
          h = height[i];
        stats[k * 6] += w;
        stats[k * 6 + 1] += w * c;
        stats[k * 6 + 2] += w * h;
        stats[k * 6 + 3] += w * c * c;
        stats[k * 6 + 4] += w * c * h;
        stats[k * 6 + 5] += w * h * h;
      }
    let any = false;
    for (let k = 0; k < slices; k++) {
      const sum = new Float64Array(6);
      let fitted = false;
      for (let r = 0; r <= 2 && !fitted; r++) {
        sum.fill(0);
        for (let j = Math.max(0, k - r); j <= Math.min(slices - 1, k + r); j++)
          for (let a = 0; a < 6; a++) sum[a] += stats[j * 6 + a];
        const w = sum[0];
        if (w < 3) continue;
        const c = sum[1] / w,
          h = sum[2] / w;
        const cc = sum[3] / w - c * c,
          ch = sum[4] / w - c * h,
          hh = sum[5] / w - h * h;
        if (!(cc > 0)) continue;
        // The line runs along the principal direction of the points; its normal faces +height.
        const angle = 0.5 * Math.atan2(2 * ch, cc - hh);
        let nx = -Math.sin(angle),
          ny = Math.cos(angle);
        if (ny < 0) {
          nx = -nx;
          ny = -ny;
        }
        line.set([c, h, nx, ny], k * 4);
        fitted = any = true;
      }
      if (!fitted) line.fill(NaN, k * 4, k * 4 + 4);
    }
    if (!any) return null;
    if (round < 3) active = members.filter((i) => Math.abs(distance(i)) <= 3 * noise);
  }
  return {
    kind: 'profile',
    distance,
    normal: (i) => {
      const nx = mix(i, (k) => line[k * 4 + 2]),
        ny = mix(i, (k) => line[k * 4 + 3]);
      const v = [0, 1, 2].map((a) => nx * frame.across[i * 3 + a] + ny * frame.normal[i * 3 + a]);
      const length = Math.hypot(v[0], v[1], v[2]) || 1;
      return v.map((x) => x / length);
    },
  };
}

/** `fitAuto` over the members when it is within the noise, else the straight-profile fallback. */
function flankFit(
  members: number[],
  position: Float64Array,
  band: Band,
  frame: Frame,
  noise: number,
): FlankFit | null {
  if (members.length < minimumFlank) return null;
  const p = new Float32Array(members.length * 3),
    n = new Float32Array(members.length * 3);
  members.forEach((i, k) => {
    p.set(position.subarray(band.vertices[i] * 3, band.vertices[i] * 3 + 3), k * 3);
    n.set(frame.vertexNormals.subarray(i * 3, i * 3 + 3), k * 3);
  });
  try {
    const fit = fitAuto(p, n, noise);
    if (fit.within) return shapeFit(fit.shape, position, band.vertices);
  } catch {
    // No single shape fits the members; the per-slice profile below may.
  }
  return profileFit(members, frame, noise);
}

/**
 * Seeds of the flank on one side: the window of offsets nearest the guide where the vertex normals
 * stop turning, against the fastest turn seen on that side. Empty when the side has no such window.
 */
function flankSeeds(frame: Frame, sign: number, width: number, edge: number) {
  const { cross, turn, facing } = frame;
  const side: number[] = [];
  for (let i = 0; i < cross.length; i++) if (facing[i] && sign * cross[i] > 0) side.push(i);
  side.sort((a, b) => sign * cross[a] - sign * cross[b] || a - b);
  if (!side.length) return [];
  const extent = sign * cross[side[side.length - 1]];
  const span = Math.max(3 * edge, 0.2 * width),
    stride = span / 3;
  const windows: { from: number; to: number; slope: number; error: number }[] = [];
  let from = 0,
    to = 0;
  for (let low = 0; low + span <= extent; low += stride) {
    while (from < side.length && sign * cross[side[from]] < low) from++;
    while (to < side.length && sign * cross[side[to]] <= low + span) to++;
    const count = to - from;
    if (count < minimumFlank) continue;
    let mc = 0,
      mt = 0;
    for (let k = from; k < to; k++) {
      mc += sign * cross[side[k]];
      mt += turn[side[k]];
    }
    mc /= count;
    mt /= count;
    let cc = 0,
      ct = 0;
    for (let k = from; k < to; k++) {
      const dc = sign * cross[side[k]] - mc;
      cc += dc * dc;
      ct += dc * (turn[side[k]] - mt);
    }
    if (!(cc > 0)) continue;
    const slope = ct / cc;
    let residual = 0;
    for (let k = from; k < to; k++) {
      const r = turn[side[k]] - mt - slope * (sign * cross[side[k]] - mc);
      residual += r * r;
    }
    windows.push({ from, to, slope, error: Math.sqrt(residual / Math.max(1, count - 2) / cc) });
  }
  const peak = Math.max(0, ...windows.map((w) => Math.abs(w.slope)));
  const flat = windows.find((w) => Math.abs(w.slope) <= Math.max(0.3 * peak, 2 * w.error));
  return flat ? side.slice(flat.from, flat.to).sort((a, b) => a - b) : [];
}

/** Median of a non-empty list. */
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The band and whether a flank met a second softened zone, or null when no edge lies under the guide. */
function classify(
  mesh: RefineMesh,
  topology: RefineTopology,
  kind: GuideKind,
  points: GuidePoint[],
  width: number,
  noise: number,
  edge: number,
) {
  if (points.length < 2 || !(width > 0) || !(edge > 0)) return null;
  const drawn = drawnCurve(
    kind,
    points.flatMap((p) => p.position),
    edge,
  );
  const total = drawn.lengths[drawn.lengths.length - 1];
  if (!(total > 0)) return null;
  const band = gather(mesh, topology, drawn, total, points, width, edge);
  if (!band) return null;
  const { vertices, distance, linkStart, links } = band;
  const count = vertices.length;
  const frame = frameOf(mesh, topology, band, drawn, total, width, edge);
  const { cross, facing } = frame;
  const { position } = mesh;
  const tolerance = 3 * noise;

  // Flanks: seeded nearest the guide outside the soft zone, grown within the noise, then refitted
  // on what they grew to until they stop changing.
  const fits: FlankFit[] = [];
  const claims: Uint8Array[] = [];
  for (const sign of [1, -1]) {
    const seeds = flankSeeds(frame, sign, width, edge);
    // Refits read the flank from its seed outward, clear of the fillet it grew back over.
    const inner = seeds.reduce((least, i) => Math.min(least, sign * cross[i]), Infinity);
    let fit = flankFit(seeds, position, band, frame, noise);
    if (!fit) return null;
    const claimFor = (shape: FlankFit) =>
      grow(seeds, (i) => facing[i] === 1 && Math.abs(shape.distance(i)) <= tolerance, band);
    let claim = claimFor(fit);
    let used = seeds;
    for (let round = 0; round < refits; round++) {
      const members: number[] = [];
      for (let i = 0; i < count; i++) if (claim[i] && sign * cross[i] >= inner) members.push(i);
      if (members.length === used.length && members.every((i, k) => i === used[k])) break;
      const refit = flankFit(members, position, band, frame, noise);
      if (!refit) break;
      fit = refit;
      used = members;
      claim = claimFor(fit);
    }
    fits.push(fit);
    claims.push(claim);
  }
  const [leftClaim, rightClaim] = claims;
  const zone = new Uint8Array(count).fill(BandZone.Beyond);
  for (let i = 0; i < count; i++)
    if (leftClaim[i] !== rightClaim[i]) zone[i] = leftClaim[i] ? BandZone.Left : BandZone.Right;
  const flankMedian = (z: BandZone, sign: number) => {
    const offsets: number[] = [];
    for (let i = 0; i < count; i++) if (zone[i] === z) offsets.push(sign * cross[i]);
    return offsets.length ? median(offsets) : 0;
  };
  const reachLeft = flankMedian(BandZone.Left, 1),
    reachRight = flankMedian(BandZone.Right, -1);

  // Soft: from the spine, through facing vertices that no single flank claims (where the faces meet
  // within the noise both claim it), and never past the middle of either flank.
  const soft = grow(
    band.spine,
    (i) =>
      facing[i] === 1 &&
      zone[i] === BandZone.Beyond &&
      cross[i] <= reachLeft &&
      -cross[i] <= reachRight,
    band,
  );
  for (let i = 0; i < count; i++) if (soft[i]) zone[i] = BandZone.Soft;

  const second = trimAtSecondZones(zone, cross, band, position);

  // Evidence of an edge: two flanks, a soft zone near the guide touching both, and a turn between them.
  let left = 0,
    right = 0,
    softCount = 0,
    nearest = Infinity;
  const nearestFlank = [unset, unset];
  for (let i = 0; i < count; i++) {
    const z = zone[i];
    if (z === BandZone.Soft) {
      softCount++;
      nearest = Math.min(nearest, distance[i]);
    } else if (z === BandZone.Left || z === BandZone.Right) {
      if (z === BandZone.Left) left++;
      else right++;
      const f = z - 1;
      if (nearestFlank[f] === unset || distance[i] < distance[nearestFlank[f]]) nearestFlank[f] = i;
    }
  }
  if (left < minimumFlank || right < minimumFlank || !softCount) return null;
  if (nearest > width / 2) return null;
  const boundary: number[] = [];
  const touches = [false, false];
  for (let i = 0; i < count; i++) {
    if (zone[i] !== BandZone.Soft) continue;
    for (let j = linkStart[i]; j < linkStart[i + 1]; j++) {
      const k = links[j];
      if (zone[k] !== BandZone.Left && zone[k] !== BandZone.Right) continue;
      touches[zone[k] - 1] = true;
      boundary.push((Math.abs(cross[i]) + Math.abs(cross[k])) / 2);
    }
  }
  if (!touches[0] || !touches[1]) return null;
  const a = fits[0].normal(nearestFlank[0]),
    b = fits[1].normal(nearestFlank[1]);
  const cosine = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  if ((Math.acos(cosine) * 180) / Math.PI < minBandAngle) return null;

  const result: EdgeBand = {
    vertices,
    station: Float32Array.from(band.station),
    cross: Float32Array.from(cross),
    zone,
    drawn,
    soft: median(boundary),
    fits: [fits[0].kind, fits[1].kind],
  };
  return { band: result, second };
}

/**
 * Where a flank runs on to a second softened zone, the part of the flank nearer to that zone than
 * to the guide's soft zone becomes Beyond. The evidence is a connected set of vertices fitting
 * neither flank, on the flank's side and farther out than its middle, that reaches the band's
 * boundary. Returns whether any flank was trimmed.
 */
function trimAtSecondZones(
  zone: Uint8Array,
  cross: Float64Array,
  band: Band,
  position: Float64Array,
) {
  const { vertices, linkStart, links, edgeOfBand } = band;
  const count = vertices.length;
  const component = new Int32Array(count).fill(unset);
  const evidence: boolean[] = [];
  const middles = [BandZone.Left, BandZone.Right].map((z) => {
    const offsets: number[] = [];
    const sign = z === BandZone.Left ? 1 : -1;
    for (let i = 0; i < count; i++) if (zone[i] === z) offsets.push(sign * cross[i]);
    return offsets.length ? median(offsets) : Infinity;
  });
  for (let start = 0; start < count; start++) {
    if (zone[start] !== BandZone.Beyond || component[start] !== unset) continue;
    const id = evidence.length;
    const queue = [start];
    component[start] = id;
    let reaches = false;
    const touching = [false, false];
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      if (edgeOfBand[i]) reaches = true;
      for (let j = linkStart[i]; j < linkStart[i + 1]; j++) {
        const k = links[j];
        if (zone[k] === BandZone.Left || zone[k] === BandZone.Right) touching[zone[k] - 1] = true;
        else if (zone[k] === BandZone.Beyond && component[k] === unset) {
          component[k] = id;
          queue.push(k);
        }
      }
    }
    const offset = median(queue.map((i) => cross[i]));
    const side = offset > 0 ? 0 : 1;
    const sign = side === 0 ? 1 : -1;
    evidence.push(
      reaches && queue.length >= minimumFlank && touching[side] && sign * offset > middles[side],
    );
  }
  if (!evidence.some(Boolean)) return false;
  // Multi-source shortest paths over each flank, from the edge under the guide and from the second
  // zone. The edge is wherever the flank meets the soft zone or the other flank.
  const reached = new Float64Array(count).fill(Infinity);
  const far = new Uint8Array(count);
  const heap = new Heap();
  for (let i = 0; i < count; i++) {
    if (zone[i] !== BandZone.Left && zone[i] !== BandZone.Right) continue;
    let nearEdge = false,
      nearSecond = false;
    for (let j = linkStart[i]; j < linkStart[i + 1]; j++) {
      const k = links[j];
      if (zone[k] === zone[i]) continue;
      if (zone[k] !== BandZone.Beyond) nearEdge = true;
      else if (evidence[component[k]] && cross[k] > 0 === (zone[i] === BandZone.Left))
        nearSecond = true;
    }
    if (nearEdge || nearSecond) {
      reached[i] = 0;
      far[i] = +!nearEdge;
      heap.push(0, i);
    }
  }
  while (heap.size) {
    const i = heap.pop();
    if (heap.top > reached[i]) continue;
    for (let j = linkStart[i]; j < linkStart[i + 1]; j++) {
      const k = links[j];
      if (zone[k] !== zone[i]) continue;
      const d = reached[i] + length3(position, vertices[i], vertices[k]);
      // Ties go to the guide's side, the same whichever way the guide was drawn.
      if (d < reached[k] || (d === reached[k] && far[k] && !far[i])) {
        reached[k] = d;
        far[k] = far[i];
        heap.push(d, k);
      }
    }
  }
  let trimmed = false;
  for (let i = 0; i < count; i++)
    if (far[i]) {
      zone[i] = BandZone.Beyond;
      trimmed = true;
    }
  return trimmed;
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
  const edge = localEdge(mesh, topology, points);
  return classify(mesh, topology, kind, points, width, noise, edge)?.band ?? null;
}

/**
 * A width that leaves flank on both sides: soft + max(2 * soft, 6 * the local edge length). 0 when
 * no trial band shows an edge.
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
  // A band narrower than the soft zone reads it too narrow, so trials widen by half until one
  // agrees with the next; a trial that met a second softened zone is never the answer.
  const trials: number[] = [];
  for (let w = 6 * edge; w < 24 * edge; w *= 1.5) trials.push(w);
  trials.push(24 * edge);
  const results = trials.map(() => undefined as ReturnType<typeof classify> | undefined);
  const trial = (k: number) =>
    (results[k] ??= classify(mesh, topology, kind, points, trials[k], noise, edge));
  for (let k = 0; k + 1 < trials.length; k++) {
    const here = trial(k);
    if (!here || here.second) continue;
    const next = trial(k + 1);
    if (next && Math.abs(next.band.soft - here.band.soft) <= edge)
      return here.band.soft + Math.max(2 * here.band.soft, 6 * edge);
  }
  return 0;
}
