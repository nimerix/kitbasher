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
  /**
   * Per band vertex: distance along the drawn guide, signed offset across it (the distance from the
   * guide along the surface, positive on the Left), and zone.
   */
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

/** Degrees a vertex normal may turn from a flank's and still fit it, unless the flank's own normals spread wider. */
const facingAngle = 2 * minBandAngle;
/** Fewest edge lengths a flank must run outward from where it starts, in half of the slices. */
const flankRun = 3;
/** Fewest of the soft vertices whose normals must lie between the two flanks' normals. */
const softBetween = 0.75;
/** Fewest vertices a flank may have. */
const minimumFlank = 12;
/** Stations per slice of the frame normals, the zone boundaries and the profile fallback. */
const sliceSteps = 4;
/** Rounds of refitting each flank from its first boundary outward. */
const rounds = 3;
/** Edge lengths of face each refit reads. */
const refitEdges = 3;
/** Degrees the normals may turn across a run of offsets that seeds a flank. */
const flatTurn = 5;
/** Offset bins that a flat run must span when the band allows it. */
const flatBins = 3;
/** Narrowest offset bin of the flat run, mm, so that a fine mesh still sees a fillet turn across a bin. */
const flatBinWidth = 0.05;
/** Penalty, in vertices, for each change of zone along a slice. */
const switchCost = 1;
/** Weight of a vertex farther than 3 * noise from the flank its run claims it for. */
const farCost = 2;
/** How a vertex fits a flank: off it, within the noise but facing another way, or on it. */
const nearFlank = 1,
  onFlank = 2;
/** The generous width `estimateWidth` classifies at: this many edge lengths, and at least `generousWidth` mm. */
const generousEdges = 24;
const generousWidth = 1.5;
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

/** Median of a non-empty list. */
function median(values: ArrayLike<number>) {
  const sorted = Float64Array.from(values).sort();
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The closest point of a curve to a point, searched from a nearby segment: the distance along the
 * curve is unimodal within a band much narrower than the curve's radius, so a local descent finds it.
 */
class CurveWalker {
  private readonly p: Float64Array;
  private readonly count: number;
  readonly segments: number;
  segment = 0;
  station = 0;
  readonly at = new Float64Array(3);

  constructor(private readonly curve: EdgeCurve) {
    this.p = curve.points;
    this.count = this.p.length / 3;
    this.segments = curve.closed ? this.count : this.count - 1;
  }

  private wrap(i: number) {
    if (this.curve.closed) return ((i % this.segments) + this.segments) % this.segments;
    return i < 0 || i >= this.segments ? unset : i;
  }

  /** Squared distance to segment i, leaving its parameter in `f`. */
  private f = 0;
  private distance(i: number, x: number, y: number, z: number) {
    const { p } = this;
    const j = (i + 1) % this.count;
    const ax = p[i * 3],
      ay = p[i * 3 + 1],
      az = p[i * 3 + 2];
    const dx = p[j * 3] - ax,
      dy = p[j * 3 + 1] - ay,
      dz = p[j * 3 + 2] - az;
    const dd = dx * dx + dy * dy + dz * dz;
    const f =
      dd > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / dd)) : 0;
    this.f = f;
    return (ax + dx * f - x) ** 2 + (ay + dy * f - y) ** 2 + (az + dz * f - z) ** 2;
  }

  /** Measures a point from the segment at `hint`; leaves the segment, station and closest point. */
  measure(x: number, y: number, z: number, hint: number) {
    let best = this.wrap(hint);
    if (best === unset) best = Math.min(this.segments - 1, Math.max(0, hint));
    let bestD = this.distance(best, x, y, z),
      bestF = this.f;
    // Walk while a neighbour is closer, then confirm two segments either way past the minimum.
    for (const direction of [1, -1]) {
      let misses = 0;
      for (let i = this.wrap(best + direction); i !== unset && misses < 3;) {
        const d = this.distance(i, x, y, z);
        if (d < bestD) {
          bestD = d;
          bestF = this.f;
          best = i;
          misses = 0;
        } else misses++;
        const next = this.wrap(i + direction);
        if (next === best) break;
        i = next;
      }
    }
    const { p } = this;
    const j = (best + 1) % this.count;
    for (let a = 0; a < 3; a++)
      this.at[a] = p[best * 3 + a] + (p[j * 3 + a] - p[best * 3 + a]) * bestF;
    const span = Math.hypot(
      p[j * 3] - p[best * 3],
      p[j * 3 + 1] - p[best * 3 + 1],
      p[j * 3 + 2] - p[best * 3 + 2],
    );
    this.segment = best;
    this.station = this.curve.lengths[best] + span * bestF;
    return Math.sqrt(bestD);
  }

  /** The segment holding a distance along the curve. */
  segmentAt(station: number) {
    const { lengths } = this.curve;
    let low = 0,
      high = this.count - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lengths[middle] <= station) low = middle;
      else high = middle - 1;
    }
    return Math.min(low, this.segments - 1);
  }
}

/**
 * The band: welded vertices whose distance from the drawn curve along the surface, `g`, is at most
 * `width`. The search starts from the seeds, each at its own straight-line distance: the clicked
 * triangles' corners and the vertices joined to them that lie within their own edge length of the
 * curve across the surface. Vertices farther than `width` from the curve in space, or past an end of
 * an open guide, are never entered, except seeds. The working edge length is the seeds' median.
 */
function gather(
  mesh: RefineMesh,
  topology: RefineTopology,
  drawn: EdgeCurve,
  total: number,
  points: GuidePoint[],
  widthFor: (edge: number) => number,
  noise: number,
) {
  const { position } = mesh;
  const { neighbourStart, neighbours } = topology;
  const walker = new CurveWalker(drawn);
  const slots = new VertexMap();
  const welded: number[] = [],
    station: number[] = [],
    distance: number[] = [],
    closest: number[] = [],
    segment: number[] = [],
    open: boolean[] = [],
    seed: boolean[] = [];
  const p = drawn.points,
    last = p.length / 3 - 1;
  const startTangent = new Float64Array(3),
    endTangent = new Float64Array(3);
  curveTangent(drawn, 0, startTangent);
  curveTangent(drawn, total, endTangent);
  const ends = 1e-9 * (1 + total);
  const at = new Float64Array(3);
  // Measures a vertex once, from the curve segment of the vertex it was reached from.
  const measure = (v: number, hint: number) => {
    const known = slots.get(v);
    if (known !== unset) return known;
    const x = position[v * 3],
      y = position[v * 3 + 1],
      z = position[v * 3 + 2];
    let d: number;
    if (hint === unset) {
      const s = closestOnCurve(drawn, x, y, z, at);
      d = walker.measure(x, y, z, walker.segmentAt(s));
    } else d = walker.measure(x, y, z, hint);
    const s = walker.station;
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
    distance.push(d);
    closest.push(walker.at[0], walker.at[1], walker.at[2]);
    segment.push(walker.segment);
    open.push(inside);
    seed.push(false);
    return k;
  };

  // Seeds: the clicked triangles' corners, and every vertex within one edge of the curve joined to them.
  const queue: number[] = [];
  for (const point of points)
    for (const corner of [0, 1, 2] as const) {
      const k = measure(weldedCorner(mesh, point.triangle, corner), unset);
      if (!seed[k]) {
        seed[k] = true;
        queue.push(k);
      }
    }
  // A vertex's own edge length, so that uneven density near the clicks cannot starve the seeds.
  const ownEdge = (v: number) => {
    let sum = 0;
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++)
      sum += length3(position, v, neighbours[j]);
    return sum / Math.max(1, neighbourStart[v + 1] - neighbourStart[v]);
  };
  // Offset from the curve within the vertex's tangent plane: the curve runs over the surface, and
  // ripple or noise can lift the surface off a straight guide by more than an edge.
  const normal = new Float32Array(3);
  const lateral = (k: number) => {
    const v = welded[k];
    vertexNormal(mesh, topology, v, normal);
    const d = [0, 1, 2].map((a) => position[v * 3 + a] - closest[k * 3 + a]);
    const h = d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2];
    return Math.hypot(d[0] - h * normal[0], d[1] - h * normal[1], d[2] - h * normal[2]);
  };
  const seedEdges: number[] = [];
  for (let q = 0; q < queue.length; q++) {
    const v = welded[queue[q]];
    seedEdges.push(ownEdge(v));
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const k = measure(neighbours[j], segment[queue[q]]);
      const reach = ownEdge(neighbours[j]);
      if (seed[k] || distance[k] >= reach + 3 * noise || lateral(k) >= reach) continue;
      seed[k] = true;
      queue.push(k);
    }
  }
  const edge = median(seedEdges);
  const width = widthFor(edge);

  // Multi-source shortest paths over mesh edges. Ties go to the lower parent vertex, so the tree
  // is the same whichever way the guide was drawn.
  const g: number[] = [],
    parent: number[] = [];
  const gOf = (k: number) => g[k] ?? Infinity;
  const heap = new Heap();
  queue.sort((a, b) => welded[a] - welded[b]);
  for (const k of queue) {
    g[k] = distance[k];
    parent[k] = unset;
    heap.push(distance[k], k);
  }
  while (heap.size) {
    const k = heap.pop();
    if (heap.top > gOf(k)) continue;
    const v = welded[k];
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const w = measure(neighbours[j], segment[k]);
      if (!seed[w] && (distance[w] > width || !open[w])) continue;
      const d = gOf(k) + length3(position, v, welded[w]);
      if (d > width) continue;
      const known = gOf(w);
      if (d < known || (d === known && parent[w] !== unset && v < welded[parent[w]])) {
        g[w] = d;
        parent[w] = k;
        heap.push(d, w);
      }
    }
  }
  const members: number[] = [];
  for (let k = 0; k < welded.length; k++) if (gOf(k) <= width) members.push(k);
  members.sort((a, b) => welded[a] - welded[b]);
  const count = members.length;
  const slotIndex = new Int32Array(welded.length).fill(unset);
  members.forEach((k, i) => (slotIndex[k] = i));
  const band = {
    /** Median edge length at the seeds, and the width the band was gathered to. */
    edge,
    width,
    vertices: new Uint32Array(count),
    station: new Float64Array(count),
    distance: new Float64Array(count),
    closest: new Float64Array(count * 3),
    /** Distance from the drawn curve along the surface. */
    g: new Float64Array(count),
    /** Band index of the vertex each was reached from, or -1 for a seed. */
    parent: new Int32Array(count),
    /** 0 for a seed past an end of an open guide, which joins the band but is never edited. */
    open: new Uint8Array(count),
  };
  for (let i = 0; i < count; i++) {
    const k = members[i];
    band.vertices[i] = welded[k];
    band.station[i] = station[k];
    band.distance[i] = distance[k];
    band.g[i] = g[k];
    band.parent[i] = parent[k] === unset ? unset : slotIndex[parent[k]];
    band.open[i] = +open[k];
    for (let a = 0; a < 3; a++) band.closest[i * 3 + a] = closest[k * 3 + a];
  }
  return band;
}

type Band = ReturnType<typeof gather>;

/** The cross-section frame at each band vertex and where the vertex lies in it. */
interface Frame {
  /** Unit normal of the frame and unit offset direction across the guide, 3 per vertex. */
  normal: Float64Array;
  across: Float64Array;
  /** Offset across the guide and height along the frame normal, in space. */
  cross: Float64Array;
  height: Float64Array;
  /** Angle of the vertex normal from the frame normal, toward `across`. */
  turn: Float64Array;
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
  const { vertices, station, g, closest } = band;
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
    slice[i] = slices === 1 ? 0 : Math.min(slices - 2, Math.floor(f));
    blend[i] = slices === 1 ? 0 : f - slice[i];
  }
  const upper = (i: number) => Math.min(slices - 1, slice[i] + 1);
  const vertexNormals = new Float32Array(count * 3);
  const sliceNormal = new Float64Array(slices * 3);
  const n = new Float32Array(3);
  for (let i = 0; i < count; i++) {
    vertexNormal(mesh, topology, vertices[i], n);
    vertexNormals.set(n, i * 3);
    const weight = 1 - g[i] / (width + edge);
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
  }
  return frame;
}

/**
 * Signed offset across the guide along the surface. A seed, and a vertex reached straight from one,
 * takes the side its own offset is on; every other vertex the side of the vertex it was reached from.
 * A seed can lie on the curve itself, where its own side is arbitrary, and it reaches both sides.
 */
function signedOffsets(band: Band, frame: Frame) {
  const { g, parent } = band;
  const count = g.length;
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => g[a] - g[b] || a - b);
  const side = new Int8Array(count);
  const u = new Float64Array(count);
  for (const i of order) {
    // A vertex straight past an end of the guide has no offset across it; its normal's turn breaks
    // the tie, and like the offset it changes sign when the guide is drawn the other way.
    const across = frame.cross[i] || frame.turn[i];
    const own = across > 0 ? 1 : -1;
    side[i] = parent[i] === unset || parent[parent[i]] === unset ? own : side[parent[i]];
    u[i] = side[i] * g[i];
  }
  return u;
}

/** A flank's fitted surface, read at band vertices. */
interface FlankFit {
  kind: BandFit;
  /** Signed distance of a band vertex from the fit. */
  distance(i: number): number;
  /** Unit normal of the fit at a band vertex. */
  normal(i: number): number[];
  /** Cosine of the largest angle a fitting vertex's normal may make with the fit's normal. */
  agree?: number;
}

function shapeFit(shape: Shape, position: Float64Array, vertices: Uint32Array): FlankFit {
  const at = (i: number, a: number) => position[vertices[i] * 3 + a];
  const step = 1e-4;
  return {
    kind: shape.kind,
    distance: (i) => shapeDistance(shape, at(i, 0), at(i, 1), at(i, 2)),
    normal: (i) => {
      const n = [0, 1, 2].map((a) => {
        const p = [at(i, 0), at(i, 1), at(i, 2)];
        p[a] += step;
        const forward = shapeDistance(shape, p[0], p[1], p[2]);
        p[a] -= 2 * step;
        return forward - shapeDistance(shape, p[0], p[1], p[2]);
      });
      const length = Math.hypot(n[0], n[1], n[2]) || 1;
      return n.map((v) => v / length);
    },
  };
}

/**
 * A straight line per slice in that slice's cross-section (offset across the guide against height
 * along the frame normal, both in space), from at most two slices either side when a slice has too
 * few points. Points beyond 3 * noise are dropped and the lines refitted.
 */
function profileFit(members: number[], frame: Frame, noise: number): FlankFit | null {
  const { slices, slice, blend, cross, height } = frame;
  const upper = (i: number) => Math.min(slices - 1, slice[i] + 1);
  // Per slice: offset, height and unit normal of its line, or NaN when it has none.
  const line = new Float64Array(slices * 4);
  const sliceDistance = (k: number, i: number) =>
    (cross[i] - line[k * 4]) * line[k * 4 + 2] + (height[i] - line[k * 4 + 1]) * line[k * 4 + 3];
  const mix = (i: number, of: (k: number) => number) => {
    const a = of(slice[i]),
      b = of(upper(i));
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
  const sum = new Float64Array(6);
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
        if (!(cc + hh > 0)) continue;
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
  let fit: FlankFit | null = null;
  try {
    const shape = fitAuto(p, n, noise);
    if (shape.within) fit = shapeFit(shape.shape, position, band.vertices);
  } catch {
    // No single shape fits the members; the per-slice profile below may.
  }
  fit ??= profileFit(members, frame, noise);
  if (!fit) return null;
  // Normals agree within facingAngle, or three times their spread on the fitted members.
  let spread = 0,
    inliers = 0;
  for (const i of members) {
    if (!(Math.abs(fit.distance(i)) <= 3 * noise)) continue;
    const f = fit.normal(i);
    const v = frame.vertexNormals;
    const cosine = v[i * 3] * f[0] + v[i * 3 + 1] * f[1] + v[i * 3 + 2] * f[2];
    spread += Math.acos(Math.min(1, Math.max(-1, cosine))) ** 2;
    inliers++;
  }
  const angle = Math.max((facingAngle * Math.PI) / 180, 3 * Math.sqrt(spread / (inliers || 1)));
  fit.agree = Math.cos(Math.min(Math.PI / 2, angle));
  return fit;
}

/** Band vertices on one side, in order of offset. */
function sideOrder(u: Float64Array, sign: number) {
  const side: number[] = [];
  for (let i = 0; i < u.length; i++) if (sign * u[i] > 0) side.push(i);
  return side.sort((a, b) => sign * u[a] - sign * u[b] || a - b);
}

/**
 * The first guess of a flank on one side: the nearest run of offsets, `flatBins` edge lengths long
 * (or to the band's edge, if at least two), over which the median normal turn stays within
 * `flatTurn` degrees. Returns the vertices of six edge lengths from the start of that run.
 */
function firstGuess(u: Float64Array, frame: Frame, sign: number, edge: number) {
  const side = sideOrder(u, sign);
  if (!side.length) return [];
  const bin = Math.max(edge, flatBinWidth);
  const bins = Math.floor((sign * u[side[side.length - 1]]) / bin) + 1;
  const start = new Int32Array(bins + 1);
  for (const i of side) start[Math.floor((sign * u[i]) / bin) + 1]++;
  for (let b = 0; b < bins; b++) start[b + 1] += start[b];
  const turns = side.map((i) => frame.turn[i]);
  const middle = Array.from({ length: bins }, (_, b) =>
    start[b + 1] > start[b] ? median(turns.slice(start[b], start[b + 1])) : NaN,
  );
  const limit = (flatTurn * Math.PI) / 180;
  for (let b = 0; b < bins; b++) {
    if (Number.isNaN(middle[b])) continue;
    const span = Math.min(flatBins, bins - b);
    if (span < 2) break;
    let flat = true;
    for (let k = b + 1; k < b + span && flat; k++)
      flat = !Number.isNaN(middle[k]) && Math.abs(middle[k] - middle[b]) <= limit;
    if (!flat) continue;
    const from = start[b];
    let to = from;
    while (to < side.length && sign * u[side[to]] < b * bin + 6 * edge) to++;
    return side.slice(from, to).sort((x, y) => x - y);
  }
  return [];
}

/**
 * Splits one side of one slice, its vertices ordered outward, into four runs: the other flank, soft,
 * the side's own flank and beyond. The split minimises the weight of vertices whose fit disagrees
 * with their run, plus `switchCost` per change.
 */
function segment(
  entries: number[],
  weights: number[],
  u: Float64Array,
  ownFits: Uint8Array,
  otherFits: Uint8Array,
  limit: number,
) {
  const n = entries.length;
  const back = new Uint8Array(n * 4);
  let cost = [0, 0, 0, 0];
  for (let j = 0; j < n; j++) {
    const i = entries[j],
      w = weights[j];
    const own = ownFits[i] === onFlank,
      otherOnly = otherFits[i] === onFlank && !own;
    // A vertex off a flank by more than the noise would move by more than the noise if it joined
    // that flank, so it weighs more than one that only faces another way.
    const misfit = (flag: number) => (flag === onFlank ? 0 : flag === nearFlank ? w : farCost * w);
    const local = [
      otherOnly ? 0 : misfit(otherFits[i]),
      own || otherOnly ? w : 0,
      misfit(ownFits[i]),
      own ? w : 0,
    ];
    const next = [0, 0, 0, 0];
    for (let s = 0; s < 4; s++) {
      let best = Infinity,
        from = 0;
      for (let r = 0; r <= s; r++) {
        const c = cost[r] + (r === s || j === 0 ? 0 : switchCost);
        if (c < best) {
          best = c;
          from = r;
        }
      }
      next[s] = best + local[s];
      back[j * 4 + s] = from;
    }
    cost = next;
  }
  const state = new Uint8Array(n);
  let s = 0;
  for (let r = 1; r < 4; r++) if (cost[r] < cost[s]) s = r;
  for (let j = n - 1; j >= 0; j--) {
    state[j] = s;
    s = back[j * 4 + s];
  }
  const offset = (j: number) => Math.abs(u[entries[j]]);
  const boundary = (s: number) => {
    let j = 0;
    while (j < n && state[j] < s) j++;
    if (j === n) return { at: limit, from: n };
    return { at: j === 0 ? 0 : (offset(j - 1) + offset(j)) / 2, from: j };
  };
  return { boundary, extent: n ? offset(n - 1) : 0 };
}

/** Median of each value with its neighbours in slice order, so one odd slice cannot punch a hole. */
function smooth(values: Float64Array) {
  const n = values.length;
  return values.map((_, k) =>
    median([values[Math.max(0, k - 1)], values[k], values[Math.min(n - 1, k + 1)]]),
  );
}

/** The classified band and its soft half-width, or null when no edge lies under the guide. */
function classify(
  mesh: RefineMesh,
  topology: RefineTopology,
  kind: GuideKind,
  points: GuidePoint[],
  widthFor: (edge: number) => number,
  noise: number,
) {
  const clicked = localEdge(mesh, topology, points);
  if (points.length < 2 || !(clicked > 0)) return null;
  const drawn = drawnCurve(
    kind,
    points.flatMap((p) => p.position),
    clicked,
  );
  const total = drawn.lengths[drawn.lengths.length - 1];
  if (!(total > 0)) return null;
  const band = gather(mesh, topology, drawn, total, points, widthFor, noise);
  const { vertices, edge, width } = band;
  const count = vertices.length;
  if (!(width > 0) || !(edge > 0) || count < 2 * minimumFlank) return null;
  const frame = frameOf(mesh, topology, band, drawn, total, width, edge);
  const u = signedOffsets(band, frame);
  const { position } = mesh;
  const tolerance = 3 * noise;
  const { slices, slice, blend } = frame;
  const limit = width + edge;

  // Each side of each slice, ordered outward, with every vertex weighted toward its two slices.
  const lists = Array.from({ length: slices * 2 }, () => ({
    entries: [] as number[],
    weights: [] as number[],
  }));
  for (const sign of [1, -1])
    for (const i of sideOrder(u, sign)) {
      const s = sign > 0 ? 0 : 1;
      const k0 = slice[i],
        k1 = Math.min(slices - 1, k0 + 1);
      if (1 - blend[i] > 0) {
        lists[k0 * 2 + s].entries.push(i);
        lists[k0 * 2 + s].weights.push(1 - blend[i]);
      }
      if (blend[i] > 0) {
        lists[k1 * 2 + s].entries.push(i);
        lists[k1 * 2 + s].weights.push(blend[i]);
      }
    }

  const fits: (FlankFit | null)[] = [1, -1].map((sign) =>
    flankFit(firstGuess(u, frame, sign, edge), position, band, frame, noise),
  );
  if (!fits[0] || !fits[1]) return null;
  const flank = fits as FlankFit[];
  // A vertex fits a flank when it lies within 3 * noise of it and faces the same way: within the
  // noise alone, a small fillet's crest fits both faces and could not be told from a sharp crease.
  const v = frame.vertexNormals;
  const facing = (fit: FlankFit, i: number) => {
    const f = fit.normal(i);
    return v[i * 3] * f[0] + v[i * 3 + 1] * f[1] + v[i * 3 + 2] * f[2];
  };
  const fitFlags = (fit: FlankFit) => {
    const flags = new Uint8Array(count);
    for (let i = 0; i < count; i++)
      if (Math.abs(fit.distance(i)) <= tolerance)
        flags[i] = facing(fit, i) >= fit.agree! ? onFlank : nearFlank;
    return flags;
  };
  const turned = Math.cos((2 * minBandAngle * Math.PI) / 180);

  // Per side, per slice: other, start, stop and end, smoothed over neighbouring slices.
  const split = () => {
    const flags = flank.map(fitFlags);
    return [0, 1].map((s) => {
      const fields = {
        other: new Float64Array(slices),
        start: new Float64Array(slices),
        stop: new Float64Array(slices),
        end: new Float64Array(slices),
        extent: new Float64Array(slices),
      };
      for (let k = 0; k < slices; k++) {
        const { entries, weights } = lists[k * 2 + s];
        const run = segment(entries, weights, u, flags[s], flags[1 - s], limit);
        const other = run.boundary(1).at,
          start = run.boundary(2).at,
          beyond = run.boundary(3);
        let end = limit;
        if (beyond.from < entries.length && start < limit) {
          // A second transition is evidenced when the mean normal just past it turns away from the
          // flank's by more than 2 * minBandAngle: the mean, so that noise and ripple cancel, and
          // just past it, so that layers beyond a fold cannot cancel the fold.
          const mean = [0, 0, 0],
            fitted = [0, 0, 0];
          const near = beyond.at + flankRun * edge;
          for (let j = beyond.from; j < entries.length && Math.abs(u[entries[j]]) <= near; j++) {
            const i = entries[j],
              f = flank[s].normal(i);
            for (let a = 0; a < 3; a++) {
              mean[a] += weights[j] * v[i * 3 + a];
              fitted[a] += weights[j] * f[a];
            }
          }
          const cosine =
            (mean[0] * fitted[0] + mean[1] * fitted[1] + mean[2] * fitted[2]) /
            (Math.hypot(mean[0], mean[1], mean[2]) * Math.hypot(fitted[0], fitted[1], fitted[2]) ||
              1);
          if (cosine < turned) end = (start + beyond.at) / 2;
        }
        fields.other[k] = other;
        fields.start[k] = start;
        fields.stop[k] = beyond.at;
        fields.end[k] = end;
        fields.extent[k] = run.extent;
      }
      return {
        other: smooth(fields.other).map((v, k) => Math.min(v, fields.other[k])),
        // Smoothing may hold a flank back but never lets a vertex that does not fit into it.
        start: smooth(fields.start).map((v, k) => Math.max(v, fields.start[k])),
        rawStart: fields.start,
        stop: smooth(fields.stop),
        end: smooth(fields.end),
        extent: fields.extent,
      };
    });
  };
  const at = (values: Float64Array, i: number) =>
    values[slice[i]] * (1 - blend[i]) + values[Math.min(slices - 1, slice[i] + 1)] * blend[i];
  const touching = (values: Float64Array, i: number, pick: (a: number, b: number) => number) => {
    const k1 = Math.min(slices - 1, slice[i] + 1);
    if (blend[i] === 0) return values[slice[i]];
    if (blend[i] === 1) return values[k1];
    return pick(values[slice[i]], values[k1]);
  };

  // Refit each flank from one edge past where it starts, over `refitEdges` edge lengths and never
  // past where it stops fitting, until the starts move by less than an edge. A flank starts across
  // the guide when the guide lies on it, where the other side's run of it ends. The window is short
  // enough to lie inside the band, so guides off the crest refit the same strip of face.
  let sides = split();
  for (let round = 1; round < rounds; round++) {
    let moved = false;
    for (const s of [0, 1]) {
      const sign = s === 0 ? 1 : -1;
      const members: number[] = [];
      for (let i = 0; i < count; i++) {
        const start = at(sides[s].start, i);
        const from = (start > 0 ? start : -at(sides[1 - s].other, i)) + edge;
        const offset = sign * u[i];
        if (offset >= from && offset <= Math.min(from + refitEdges * edge, at(sides[s].stop, i)))
          members.push(i);
      }
      const refit = flankFit(members, position, band, frame, noise);
      if (refit) {
        flank[s] = refit;
        moved = true;
      }
    }
    if (!moved) break;
    const next = split();
    let shift = 0;
    for (const s of [0, 1])
      for (let k = 0; k < slices; k++)
        shift = Math.max(shift, Math.abs(next[s].start[k] - sides[s].start[k]));
    sides = next;
    if (shift < edge) break;
  }

  const zone = new Uint8Array(count).fill(BandZone.Beyond);
  const own = [BandZone.Left, BandZone.Right];
  const nearest = [unset, unset];
  for (let i = 0; i < count; i++) {
    const s = u[i] > 0 ? 0 : 1;
    const offset = Math.abs(u[i]);
    const { other, start, end } = sides[s];
    // Of the vertex's two slices, the later start and the earlier ends, so a vertex is flank only
    // where both slices make it so.
    const a = touching(start, i, Math.max);
    if (offset < Math.min(touching(other, i, Math.min), a)) zone[i] = own[1 - s];
    else if (offset < a) zone[i] = BandZone.Soft;
    else if (offset < touching(end, i, Math.min)) zone[i] = own[s];
    if (!band.open[i]) zone[i] = BandZone.Beyond;
    if (zone[i] === BandZone.Left || zone[i] === BandZone.Right) {
      const f = zone[i] - 1;
      if (nearest[f] === unset || band.g[i] < band.g[nearest[f]]) nearest[f] = i;
    }
  }

  // Evidence of an edge: long enough flanks on both sides in half the slices, a soft zone near the
  // guide, a turn between the flanks next to the guide, and a soft zone that makes that turn.
  const half = slices / 2;
  for (const s of [0, 1]) {
    let long = 0;
    const { start, stop, extent } = sides[s];
    for (let k = 0; k < slices; k++)
      if (Math.min(stop[k], extent[k]) - start[k] >= flankRun * edge) long++;
    if (long < half) return null;
  }
  // The soft zone must be wider than an edge, and the guide inside it or within half its width.
  let softSlices = 0,
    onEdge = 0;
  const larger = new Float64Array(slices);
  for (let k = 0; k < slices; k++) {
    const [left, right] = sides;
    const softWidth = left.start[k] - left.other[k] + right.start[k] - right.other[k];
    if (softWidth > edge) softSlices++;
    if (Math.max(left.other[k], right.other[k]) <= softWidth / 2) onEdge++;
    larger[k] = Math.max(left.rawStart[k], right.rawStart[k]);
  }
  if (softSlices < half || onEdge < half) return null;
  const counts = [0, 0];
  for (let i = 0; i < count; i++)
    if (zone[i] === BandZone.Left || zone[i] === BandZone.Right) counts[zone[i] - 1]++;
  if (counts[0] < minimumFlank || counts[1] < minimumFlank) return null;
  const angle = (p: ArrayLike<number>, q: ArrayLike<number>) =>
    Math.acos(Math.min(1, Math.max(-1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])));
  if (
    (angle(flank[0].normal(nearest[0]), flank[1].normal(nearest[1])) * 180) / Math.PI <
    minBandAngle
  )
    return null;
  // A softened edge turns from one flank to the other, so its normals lie between theirs. A soft
  // run that turns back, such as a short face and a fold before a lower layer, is no edge.
  const allowance = 2 * Math.max(...flank.map((f) => Math.acos(f.agree!)));
  let softCount = 0,
    between = 0;
  for (let i = 0; i < count; i++) {
    if (zone[i] !== BandZone.Soft) continue;
    const n = v.subarray(i * 3, i * 3 + 3),
      left = flank[0].normal(i),
      right = flank[1].normal(i);
    softCount++;
    if (angle(n, left) + angle(n, right) - angle(left, right) <= allowance) between++;
  }
  if (between < softBetween * softCount) return null;

  const result: EdgeBand = {
    vertices,
    station: Float32Array.from(band.station),
    cross: Float32Array.from(u),
    zone,
    drawn,
    soft: median(larger),
    fits: [flank[0].kind, flank[1].kind],
  };
  return { band: result, edge };
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
  return classify(mesh, topology, kind, points, () => width, noise)?.band ?? null;
}

/**
 * A width that leaves flank on both sides: soft + max(2 * soft, 6 * the local edge length), read from
 * one band at a generous width. 0 when that band shows no edge.
 */
export function estimateWidth(
  mesh: RefineMesh,
  topology: RefineTopology,
  kind: GuideKind,
  points: GuidePoint[],
  noise: number,
): number {
  const found = classify(
    mesh,
    topology,
    kind,
    points,
    (edge) => Math.max(generousEdges * edge, generousWidth),
    noise,
  );
  if (!found) return 0;
  const { soft } = found.band;
  return soft + Math.max(2 * soft, 6 * found.edge);
}
