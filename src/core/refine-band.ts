import {
  type EdgeCurve,
  type GuideKind,
  closestOnCurve,
  curveTangent,
  drawnCurve,
} from './refine-curve';
import { type Shape, type ShapeKind, fitAuto, fitShape, shapeDistance } from './refine-fit';
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
/** A flank's fitted surface, in world space, for rebuilding the edge without refitting it. */
export interface BandFlank {
  kind: BandFit;
  /** Robust scale of the flank's residuals, mm: the tolerance its vertices were classified with. */
  local: number;
  /** Unsigned distance from the surface. */
  distance(x: number, y: number, z: number): number;
  project(x: number, y: number, z: number, out: Float32Array | Float64Array): void;
  /** Unit normal of the surface at the point nearest to (x, y, z), facing out of the part. */
  normal(x: number, y: number, z: number, out: Float32Array | Float64Array): void;
}
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
  /** Half-width of the softened zone, mm: the larger distance from the solved edge to a flank's start. */
  soft: number;
  /** The Left and Right flank fits. */
  fits: [BandFit, BandFit];
  /** The Left and Right flank surfaces. */
  flanks: [BandFlank, BandFlank];
  /**
   * The edge where the two flank surfaces meet, xyz per slice of the guide, in order along it; a
   * slice where they do not meet takes a point interpolated along the guide.
   */
  edge: Float64Array;
  /** Median angle between the two flank surfaces' normals along `edge`, degrees. */
  angle: number;
}

/** Fewest degrees between the two flanks' normals at the solved edge for the band to show an edge. */
export const minBandAngle = 10;
/**
 * Least `flankFlatness` of an edge: on the two reference scans smooth surfaces score up to 1.98 and
 * every edge of 50 degrees and over at least 2.46.
 */
export const minFlankFlatness = 2.2;

/** Degrees added to the flanks' own turn, so that noise on two flat flanks cannot score unbounded. */
const flatNoise = 4;
/** Fewest vertices in each half of a flank for its own turn to be measured. */
const flatHalf = 3;
/** A flank's own turn is read from this many edge lengths past the solved edge outward. */
const flatFrom = 1.5;
/**
 * Fewest edge lengths a flank must run outward from where it starts, in half of the slices; also
 * the most a flank that ends at a second transition gives up to it.
 */
const flankRun = 3;
/**
 * A flank ending at a second transition gives up to it no more than leaves this many edge lengths,
 * and at least `marginFloor`: on a face 0.3 mm wide a full margin would leave no flank to read.
 */
const keptRun = 4.5;
const marginFloor = 0.5;
/** A flank vertex off its surface within this many edge lengths of the flank's start is Soft. */
const shoulderEdges = 1;
/** Fewest vertices a flank may have. */
const minimumFlank = 12;
/** Stations per slice of the frame normals, the solved edge and the zone boundaries. */
const sliceSteps = 4;
/** Rounds of reseeding both flanks from the solved edge. */
const rounds = 3;
/** Seeds run outward from this many edge lengths past the edge, over `seedEdges` edge lengths. */
const seedStart = 2;
const seedEdges = 6;
/** Shortest seed, mm, so that on a fine mesh a seed spans more than the turn of a fillet. */
const seedSpan = 0.3;
/** The solved edge lies within this many mm of the guide, or `reachEdges` edge lengths if more. */
const reachWidth = 0.35;
const reachEdges = 6;
/** Most degrees the measured normals may turn across a flank's first seed. */
const flatTurn = 15;
/** Fewest bins, each a sixth of a seed, over which the normals stop turning to start a first seed. */
const flatBins = 3;
/** Penalty, in vertices, for each change of zone along a slice. */
const switchCost = 1;
/** Weight of a vertex off its side's surface that its run counts as flank. */
const farCost = 2;
/** Most vertices a flank fit reads. */
const fitPoints = 1024;
/** Robust scale of a residual per unit of median absolute residual. */
const madScale = 1.4826;
/** Widest width `estimateWidth` returns, mm, unless the edge cannot be read within it. */
const widestEstimate = 1;
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

  /** The point at a distance along the curve. */
  pointAt(station: number) {
    const i = this.segmentAt(station);
    const j = (i + 1) % this.count;
    const { p } = this;
    const span = this.curve.lengths[i + 1] ?? this.curve.lengths[i];
    const f =
      span > this.curve.lengths[i]
        ? (station - this.curve.lengths[i]) / (span - this.curve.lengths[i])
        : 0;
    const w = Math.min(1, Math.max(0, f));
    return [0, 1, 2].map((a) => p[i * 3 + a] + (p[j * 3 + a] - p[i * 3 + a]) * w);
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
  /** Per slice centre: the curve point, and the frame's normal and offset direction, 3 each. */
  centre: Float64Array;
  centreNormal: Float64Array;
  centreAcross: Float64Array;
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
    centre: new Float64Array(slices * 3),
    centreNormal: new Float64Array(slices * 3),
    centreAcross: new Float64Array(slices * 3),
  };
  const t = new Float64Array(3);
  // The frame at a station from the slice normals either side of it: normal and normal x tangent.
  const frameAt = (k0: number, w: number, station: number, m: number[], b: number[]) => {
    curveTangent(drawn, station, t);
    const k1 = Math.min(slices - 1, k0 + 1);
    for (let a = 0; a < 3; a++)
      m[a] = sliceNormal[k0 * 3 + a] * (1 - w) + sliceNormal[k1 * 3 + a] * w;
    const along = m[0] * t[0] + m[1] * t[1] + m[2] * t[2];
    for (let a = 0; a < 3; a++) m[a] -= along * t[a];
    const mLength = Math.hypot(m[0], m[1], m[2]) || 1;
    for (let a = 0; a < 3; a++) m[a] /= mLength;
    // normal x tangent points left of travel, seen from outside the surface.
    b[0] = m[1] * t[2] - m[2] * t[1];
    b[1] = m[2] * t[0] - m[0] * t[2];
    b[2] = m[0] * t[1] - m[1] * t[0];
    const bLength = Math.hypot(b[0], b[1], b[2]) || 1;
    for (let a = 0; a < 3; a++) b[a] /= bLength;
  };
  const walker = new CurveWalker(drawn);
  for (let k = 0; k < slices; k++) {
    const station = total / 2 + ((k - (slices - 1) / 2) * total) / slices;
    const m = [0, 0, 0],
      b = [0, 0, 0];
    frameAt(k, 0, station, m, b);
    frame.centreNormal.set(m, k * 3);
    frame.centreAcross.set(b, k * 3);
    frame.centre.set(walker.pointAt(station), k * 3);
  }
  const m = [0, 0, 0],
    b = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    frameAt(slice[i], blend[i], station[i], m, b);
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

/** A flank's fitted surface, read at band vertices and at points of a slice's cross-section. */
interface FlankFit {
  kind: BandFit;
  /** The fitted shape, when the flank is one. */
  shape?: Shape;
  /** Signed distance of a point in slice k from the fit. */
  distanceAt(p: ArrayLike<number>, k: number): number;
  /** Unit normal of the fit at a point in slice k. */
  normalAt(p: ArrayLike<number>, k: number): number[];
  /** Signed distance of a band vertex from the fit. */
  distance(i: number): number;
  /** Unit normal of the fit at a band vertex. */
  normal(i: number): number[];
  /** Robust scale of the seeds' distances from the fit, within [noise / 2, 2 * noise]. */
  local: number;
}

type Surface = Omit<FlankFit, 'local'>;

function shapeSurface(shape: Shape, position: Float64Array, vertices: Uint32Array): Surface {
  const distanceAt = (p: ArrayLike<number>) => shapeDistance(shape, p[0], p[1], p[2]);
  const planeNormal = shape.kind === 'plane' ? Array.from(shape.normal) : [];
  const unit = (v: number[]) => {
    const length = Math.hypot(v[0], v[1], v[2]) || 1;
    return v.map((x) => x / length);
  };
  // The gradient of the signed distance, in closed form where it has one.
  const normalAt = (p: ArrayLike<number>): number[] => {
    switch (shape.kind) {
      case 'plane':
        return planeNormal;
      case 'sphere': {
        const c = shape.center,
          sign = Math.sign(shape.radius);
        return unit([(p[0] - c[0]) * sign, (p[1] - c[1]) * sign, (p[2] - c[2]) * sign]);
      }
      case 'cylinder': {
        const { point: q, axis: a } = shape;
        const w = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
        const h = w[0] * a[0] + w[1] * a[1] + w[2] * a[2],
          sign = Math.sign(shape.radius);
        return unit(w.map((v, k) => (v - h * a[k]) * sign));
      }
      default: {
        const step = 1e-4;
        return unit(
          [0, 1, 2].map((a) => {
            const q = [p[0], p[1], p[2]];
            q[a] += step;
            const forward = distanceAt(q);
            q[a] -= 2 * step;
            return forward - distanceAt(q);
          }),
        );
      }
    }
  };
  const at = (i: number) => position.subarray(vertices[i] * 3, vertices[i] * 3 + 3);
  return {
    kind: shape.kind,
    shape,
    distanceAt,
    normalAt,
    distance: (i) => {
      const v = vertices[i] * 3;
      return shapeDistance(shape, position[v], position[v + 1], position[v + 2]);
    },
    normal: (i) => (shape.kind === 'plane' ? planeNormal : normalAt(at(i))),
  };
}

/**
 * A straight line per slice in that slice's cross-section (offset across the guide against height
 * along the frame normal, both in space), from at most two slices either side when a slice has too
 * few points. Points beyond 3 * noise are dropped and the lines refitted.
 */
function profileSurface(members: number[], frame: Frame, noise: number): Surface | null {
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
  // A slice without a line reads the nearest slice that has one.
  const nearest = (k: number) => {
    for (let r = 0; r < slices; r++)
      for (const j of [k - r, k + r])
        if (j >= 0 && j < slices && !Number.isNaN(line[j * 4])) return j;
    return k;
  };
  const local = (p: ArrayLike<number>, k: number) => {
    const j = nearest(k);
    let c = 0,
      h = 0;
    for (let a = 0; a < 3; a++) {
      const d = p[a] - frame.centre[k * 3 + a];
      c += d * frame.centreAcross[k * 3 + a];
      h += d * frame.centreNormal[k * 3 + a];
    }
    return { j, c, h };
  };
  const inPlane = (
    nx: number,
    ny: number,
    across: Float64Array,
    normal: Float64Array,
    o: number,
  ) => {
    const v = [0, 1, 2].map((a) => nx * across[o + a] + ny * normal[o + a]);
    const length = Math.hypot(v[0], v[1], v[2]) || 1;
    return v.map((x) => x / length);
  };
  return {
    kind: 'profile',
    distanceAt: (p, k) => {
      const { j, c, h } = local(p, k);
      return (c - line[j * 4]) * line[j * 4 + 2] + (h - line[j * 4 + 1]) * line[j * 4 + 3];
    },
    normalAt: (_, k) => {
      const j = nearest(k);
      return inPlane(
        line[j * 4 + 2],
        line[j * 4 + 3],
        frame.centreAcross,
        frame.centreNormal,
        k * 3,
      );
    },
    distance,
    normal: (i) =>
      inPlane(
        mix(i, (k) => line[k * 4 + 2]),
        mix(i, (k) => line[k * 4 + 3]),
        frame.across,
        frame.normal,
        i * 3,
      ),
  };
}

/**
 * `fitAuto` over the members when it is within the noise, else the straight-profile fallback when
 * at least half of the members lie within 3 * noise of it. A `kind` refits that kind alone first.
 * The local scale is the robust scale of the members' distances, floored at half the noise and
 * capped at twice it.
 */
function flankFit(
  members: number[],
  position: Float64Array,
  band: Band,
  frame: Frame,
  noise: number,
  kind?: BandFit,
): FlankFit | null {
  if (members.length < minimumFlank) return null;
  // An even sample of a large flank fits it as well, in a bounded time.
  const stride = Math.max(1, members.length / fitPoints);
  const sample = Array.from(
    { length: Math.min(members.length, fitPoints) },
    (_, k) => members[Math.floor(k * stride)],
  );
  const p = new Float32Array(sample.length * 3),
    n = new Float32Array(sample.length * 3);
  sample.forEach((i, k) => {
    p.set(position.subarray(band.vertices[i] * 3, band.vertices[i] * 3 + 3), k * 3);
    n.set(frame.vertexNormals.subarray(i * 3, i * 3 + 3), k * 3);
  });
  let surface: Surface | null = null;
  if (kind && kind !== 'profile') {
    const shape = fitShape(p, n, kind, noise);
    if (shape?.within) surface = shapeSurface(shape.shape, position, band.vertices);
  }
  if (kind === 'profile') surface = profileSurface(members, frame, noise);
  if (!surface)
    try {
      const shape = fitAuto(p, n, noise);
      if (shape.within) surface = shapeSurface(shape.shape, position, band.vertices);
    } catch {
      // No single shape fits the members; the per-slice profile below may.
    }
  surface ??= profileSurface(members, frame, noise);
  if (!surface) return null;
  const residual = members.map((i) => Math.abs(surface.distance(i)));
  if (surface.kind === 'profile') {
    const near = residual.filter((d) => d <= 3 * noise).length;
    if (near < members.length / 2) return null;
  }
  const local = Math.min(2 * noise, Math.max(noise / 2, madScale * median(residual)));
  return { ...surface, local };
}

/**
 * Splits one side of one slice, its vertices ordered outward from the solved edge, into three runs:
 * soft, the side's flank and beyond. The split minimises the weight of vertices whose fit disagrees
 * with their run, plus `switchCost` per change. Without a flank run the side has no flank there.
 */
function runs(entries: number[], weights: number[], offset: Float64Array, fits: Uint8Array) {
  const n = entries.length;
  // The best cost of each run ending at the current vertex, and the run each one came from.
  const back = new Uint8Array(n * 3);
  let inSoft = 0,
    inFlank = 0,
    inBeyond = 0;
  for (let j = 0; j < n; j++) {
    const w = weights[j],
      fit = fits[entries[j]] === 1;
    const change = j === 0 ? 0 : switchCost;
    // Ties go to the earlier run.
    let toFlank = inSoft + change,
      fromFlank = 0;
    if (inFlank < toFlank) {
      toFlank = inFlank;
      fromFlank = 1;
    }
    let toBeyond = inSoft + change,
      fromBeyond = 0;
    if (inFlank + change < toBeyond) {
      toBeyond = inFlank + change;
      fromBeyond = 1;
    }
    if (inBeyond < toBeyond) {
      toBeyond = inBeyond;
      fromBeyond = 2;
    }
    back[j * 3 + 1] = fromFlank;
    back[j * 3 + 2] = fromBeyond;
    inSoft += fit ? w : 0;
    inFlank = toFlank + (fit ? 0 : farCost * w);
    inBeyond = toBeyond + (fit ? w : 0);
  }
  const cost = [inSoft, inFlank, inBeyond];
  const state = new Uint8Array(n);
  let s = 0;
  for (let r = 1; r < 3; r++) if (cost[r] < cost[s]) s = r;
  for (let j = n - 1; j >= 0; j--) {
    state[j] = s;
    s = back[j * 3 + s];
  }
  const at = (j: number) => Math.abs(offset[entries[j]]);
  const boundary = (s: number) => {
    let j = 0;
    while (j < n && state[j] < s) j++;
    if (j === n) return Infinity;
    return j === 0 ? 0 : (at(j - 1) + at(j)) / 2;
  };
  const start = boundary(1),
    end = boundary(2);
  const flank = start < end;
  return {
    start: flank ? start : 0,
    end: flank ? end : 0,
    extent: n ? at(n - 1) : 0,
  };
}

/**
 * How much more the surface turns at the solved edge than within its flanks: the edge's angle in
 * degrees over the sum of each flank's own turn plus `flatNoise` degrees. A flank's own turn is the
 * difference between the median normal turn, in the cross-section, of its outer and inner halves
 * (split at the median offset of its vertices from `from` outward, among those `reads` admits).
 * An edge between flat flanks scores high; a smooth surface, whose flanks turn as the band does,
 * scores near 1. 0 when a flank has too few vertices to measure. The guide's direction does not
 * change it: reversing it swaps the flanks and negates the turn.
 */
function flankFlatness(
  offset: Float64Array,
  turn: Float64Array,
  zone: Uint8Array,
  reads: (i: number) => boolean,
  from: number,
  angle: number,
) {
  let own = flatNoise;
  for (const side of [BandZone.Left, BandZone.Right]) {
    const sign = side === BandZone.Left ? 1 : -1;
    const members: number[] = [];
    for (let i = 0; i < offset.length; i++)
      if (zone[i] === side && sign * offset[i] >= from && reads(i)) members.push(i);
    if (members.length < 2 * flatHalf) return 0;
    const split = median(members.map((i) => sign * offset[i]));
    const inner: number[] = [],
      outer: number[] = [];
    for (const i of members) (sign * offset[i] < split ? inner : outer).push(turn[i]);
    if (inner.length < flatHalf || outer.length < flatHalf) return 0;
    own += (Math.abs(median(outer) - median(inner)) * 180) / Math.PI;
  }
  return angle / own;
}

const dot3 = (p: ArrayLike<number>, q: ArrayLike<number>) =>
  p[0] * q[0] + p[1] * q[1] + p[2] * q[2];

/** A flank fit as a surface in world space; `locate` gives a point's two slices and the weight of the second. */
function bandFlank(fit: FlankFit, locate: (p: number[]) => [number, number, number]): BandFlank {
  const p = [0, 0, 0];
  const n = [0, 0, 0];
  // Signed distance and unit normal at p, left in `n`.
  const read = (x: number, y: number, z: number) => {
    p[0] = x;
    p[1] = y;
    p[2] = z;
    if (fit.shape) {
      const g = fit.normalAt(p, 0);
      for (let a = 0; a < 3; a++) n[a] = g[a];
      return shapeDistance(fit.shape, x, y, z);
    }
    const [k0, k1, w] = locate(p);
    const g0 = fit.normalAt(p, k0),
      g1 = fit.normalAt(p, k1);
    for (let a = 0; a < 3; a++) n[a] = g0[a] * (1 - w) + g1[a] * w;
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    for (let a = 0; a < 3; a++) n[a] /= length;
    return fit.distanceAt(p, k0) * (1 - w) + fit.distanceAt(p, k1) * w;
  };
  return {
    kind: fit.kind,
    local: fit.local,
    distance: (x, y, z) => Math.abs(read(x, y, z)),
    project: (x, y, z, out) => {
      const d = read(x, y, z);
      out[0] = x - d * n[0];
      out[1] = y - d * n[1];
      out[2] = z - d * n[2];
    },
    normal: (x, y, z, out) => {
      read(x, y, z);
      out[0] = n[0];
      out[1] = n[1];
      out[2] = n[2];
    },
  };
}

/** The band classified from the guide as drawn, or null when no edge lies under it. */
function classifyOriented(
  mesh: RefineMesh,
  topology: RefineTopology,
  kind: GuideKind,
  points: GuidePoint[],
  width: number | null,
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
  const reachOf = (edge: number) => Math.max(reachWidth, reachEdges * edge);
  const spanOf = (edge: number) => Math.max(seedEdges * edge, seedSpan);
  // Every vertex the classification reads lies within reach of the guide plus a seed, so a width
  // only caps the band it returns and the classification is the same at every width up to that.
  // The width is measured from the solved edge, which lies within reach of the guide.
  const band = gather(
    mesh,
    topology,
    drawn,
    total,
    points,
    (edge) =>
      Math.max((width ?? 0) + reachOf(edge), reachOf(edge) + seedStart * edge + spanOf(edge)),
    noise,
  );
  const { vertices, edge } = band;
  const count = vertices.length;
  if (!(band.width > 0) || !(edge > 0) || count < 2 * minimumFlank) return null;
  const frame = frameOf(mesh, topology, band, drawn, total, band.width, edge);
  const u = signedOffsets(band, frame);
  const { position } = mesh;
  // A vertex whose normal lies mostly along the guide is on a surface that crosses the guide, such
  // as an end face; it is never on a flank and does not interrupt one.
  const crossing = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const n = frame.vertexNormals.subarray(i * 3, i * 3 + 3);
    const inPlane = Math.hypot(
      dot3(n, frame.normal.subarray(i * 3)),
      dot3(n, frame.across.subarray(i * 3)),
    );
    crossing[i] = +(inPlane < Math.SQRT1_2);
  }
  // Band vertices in order of offset, so that each slice's order outward is nearly sorted already.
  const byOffset = Uint32Array.from({ length: count }, (_, i) => i).sort(
    (a, b) => u[a] - u[b] || a - b,
  );
  const { slices, slice, blend, vertexNormals } = frame;
  const reach = reachOf(edge),
    span = spanOf(edge),
    from = seedStart * edge;
  const analysis = reach + from + span;
  const upper = (i: number) => Math.min(slices - 1, slice[i] + 1);
  const nearestSlice = (i: number) => (blend[i] < 0.5 ? slice[i] : upper(i));
  const bySlice: number[][] = Array.from({ length: slices }, () => []);
  for (let i = 0; i < count; i++) bySlice[nearestSlice(i)].push(i);

  // First seeds: per side, in bins a sixth of a seed wide from the guide outward, the runs that
  // start within reach of it over which the measured normals stop turning, until they turn again.
  // The nearest pair of runs whose normals differ by minBandAngle seeds the two flanks: a guide off
  // the crest sees the face it lies on from both sides, and a rounded rib turns all the way over.
  const limit = (flatTurn * Math.PI) / 180;
  const bin = span / seedEdges;
  const candidates = [1, -1].map((sign) => {
    const bins = Math.ceil((reach + span) / bin);
    const turns = Array.from({ length: bins }, () => [] as number[]);
    const members = Array.from({ length: bins }, () => [] as number[]);
    for (let i = 0; i < count; i++) {
      const b = Math.floor((sign * u[i]) / bin);
      if (b < 0 || b >= bins || crossing[i]) continue;
      turns[b].push(frame.turn[i]);
      members[b].push(i);
    }
    const turn = turns.map((t) => (t.length ? median(t) : NaN));
    const stretches: { seed: number[]; turn: number }[] = [];
    for (let b = 0; b * bin <= reach; b++) {
      let end = b;
      while (
        end + 1 < bins &&
        end + 1 - b < seedEdges &&
        Math.abs(turn[end + 1] - turn[b]) <= limit
      )
        end++;
      if (end - b < flatBins - 1) continue;
      const seedMembers = members.slice(b, end + 1).flat();
      // A seed counts as within reach by its own vertices, not by where its first bin begins.
      if (!seedMembers.some((i) => sign * u[i] <= reach)) continue;
      stretches.push({
        seed: seedMembers,
        turn: median(turn.slice(b, end + 1)),
      });
      b = end;
    }
    return stretches;
  });
  const pairs: [number, number][] = [];
  candidates[0].forEach((left, i) =>
    candidates[1].forEach((right, j) => {
      if (Math.abs(left.turn - right.turn) >= (minBandAngle * Math.PI) / 180) pairs.push([i, j]);
    }),
  );
  pairs.sort((p, q) => p[0] + p[1] - q[0] - q[1] || Math.abs(p[0] - p[1]) - Math.abs(q[0] - q[1]));

  // The edge per slice: the point of the slice's cross-section where both flank surfaces meet, and
  // its offset along the surface from the guide, read at the band vertex nearest it.
  const { centre, centreAcross, centreNormal } = frame;
  const solve = (pair: FlankFit[]) => {
    const point = new Float64Array(slices * 3),
      angle = new Float64Array(slices),
      offset = new Float64Array(slices),
      ok = new Uint8Array(slices);
    const b = centreAcross,
      m = centreNormal;
    const p = [0, 0, 0];
    // The solved point's coordinates in its slice's cross-section.
    const x = new Float64Array(slices),
      y = new Float64Array(slices);
    for (let k = 0; k < slices; k++) {
      let px = 0,
        py = 0,
        solved = false;
      for (let iteration = 0; iteration < 40; iteration++) {
        for (let a = 0; a < 3; a++)
          p[a] = centre[k * 3 + a] + px * b[k * 3 + a] + py * m[k * 3 + a];
        const n1 = pair[0].normalAt(p, k),
          n2 = pair[1].normalAt(p, k);
        const f1 = pair[0].distanceAt(p, k),
          f2 = pair[1].distanceAt(p, k);
        const a11 = dot3(n1, b.subarray(k * 3)),
          a12 = dot3(n1, m.subarray(k * 3)),
          a21 = dot3(n2, b.subarray(k * 3)),
          a22 = dot3(n2, m.subarray(k * 3));
        const det = a11 * a22 - a12 * a21;
        if (!(Math.abs(det) > 1e-6)) break;
        const dx = (f1 * a22 - f2 * a12) / det,
          dy = (a11 * f2 - a21 * f1) / det;
        px -= dx;
        py -= dy;
        if (!(Math.hypot(px, py) < 10 * band.width)) break;
        if (Math.hypot(dx, dy) < 1e-9) {
          solved = true;
          break;
        }
      }
      if (!solved || !bySlice[k].length) continue;
      for (let a = 0; a < 3; a++) p[a] = centre[k * 3 + a] + px * b[k * 3 + a] + py * m[k * 3 + a];
      ok[k] = 1;
      x[k] = px;
      y[k] = py;
      point.set(p, k * 3);
      angle[k] = Math.acos(
        Math.min(1, Math.max(-1, dot3(pair[0].normalAt(p, k), pair[1].normalAt(p, k)))),
      );
      let nearest = bySlice[k][0],
        best = Infinity;
      for (const i of bySlice[k]) {
        const v = vertices[i] * 3;
        const d = Math.hypot(position[v] - p[0], position[v + 1] - p[1], position[v + 2] - p[2]);
        if (d < best || (d === best && vertices[i] < vertices[nearest])) {
          best = d;
          nearest = i;
        }
      }
      let along = 0;
      for (let a = 0; a < 3; a++)
        along += (p[a] - position[vertices[nearest] * 3 + a]) * frame.across[nearest * 3 + a];
      offset[k] = u[nearest] + along;
    }
    const solvedSlices: number[] = [];
    for (let k = 0; k < slices; k++) if (ok[k]) solvedSlices.push(k);
    if (!solvedSlices.length) return null;
    // A slice without a solution takes its point and offset interpolated along the guide between
    // the solved slices either side of it, or those of the nearest past the last.
    let before = unset;
    for (let k = 0; k < slices; k++) {
      if (ok[k]) {
        before = k;
        continue;
      }
      let after = k + 1;
      while (after < slices && !ok[after]) after++;
      const lo = before === unset ? after : before,
        hi = after === slices ? lo : after;
      const w = hi === lo ? 0 : (k - lo) / (hi - lo);
      const lerp = (values: Float64Array) => values[lo] * (1 - w) + values[hi] * w;
      offset[k] = lerp(offset);
      const px = lerp(x),
        py = lerp(y);
      for (let a = 0; a < 3; a++)
        point[k * 3 + a] = centre[k * 3 + a] + px * b[k * 3 + a] + py * m[k * 3 + a];
    }
    return { point, angle, offset, ok, solvedSlices };
  };
  type Solved = NonNullable<ReturnType<typeof solve>>;
  // Median distance the edge moves between two solves, over the slices both solved.
  const moved = (a: Solved, b: Solved) => {
    const moves: number[] = [];
    for (let k = 0; k < slices; k++)
      if (a.ok[k] && b.ok[k])
        moves.push(
          Math.hypot(
            b.point[k * 3] - a.point[k * 3],
            b.point[k * 3 + 1] - a.point[k * 3 + 1],
            b.point[k * 3 + 2] - a.point[k * 3 + 2],
          ),
        );
    return moves.length ? median(moves) : Infinity;
  };

  const own = [BandZone.Left, BandZone.Right];
  const touching = (values: Float64Array, i: number, pick: (a: number, b: number) => number) => {
    if (blend[i] === 0) return values[slice[i]];
    if (blend[i] === 1) return values[upper(i)];
    return pick(values[slice[i]], values[upper(i)]);
  };
  // Zones outward from the solved edge, per side and slice: soft, then the first sustained run that
  // fits the side's surface, then beyond from the first sustained run that does not.
  const split = (pair: FlankFit[], solved: Solved) => {
    const o = new Float64Array(count);
    for (let i = 0; i < count; i++)
      o[i] = u[i] - (solved.offset[slice[i]] * (1 - blend[i]) + solved.offset[upper(i)] * blend[i]);
    // Per side: vertices that fit its surface wherever they lie, and those of them on its side.
    const onSurface = pair.map((fit) => {
      const flags = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        if (!(Math.abs(fit.distance(i)) <= 3 * fit.local)) continue;
        const f = fit.normal(i);
        const n = i * 3;
        if (vertexNormals[n] * f[0] + vertexNormals[n + 1] * f[1] + vertexNormals[n + 2] * f[2] > 0)
          flags[i] = 1;
      }
      return flags;
    });
    const fitting = [0, 1].map((s) =>
      Uint8Array.from(onSurface[s], (f, i) => +(f === 1 && (s === 0 ? o[i] > 0 : o[i] < 0))),
    );
    const sides = [0, 1].map((s) => {
      const sign = s === 0 ? 1 : -1;
      // Each slice's vertices outward from the edge: in order of u they are nearly in order of o,
      // so an insertion sort finishes them in about linear time.
      const lists = Array.from({ length: slices }, () => ({
        entries: [] as number[],
        weights: [] as number[],
      }));
      const push = (k: number, i: number, w: number) => {
        const { entries, weights } = lists[k];
        const key = sign * o[i];
        let j = entries.length;
        entries.push(i);
        weights.push(w);
        while (j > 0) {
          const before = sign * o[entries[j - 1]];
          if (before < key || (before === key && entries[j - 1] < i)) break;
          entries[j] = entries[j - 1];
          weights[j] = weights[j - 1];
          j--;
        }
        entries[j] = i;
        weights[j] = w;
      };
      for (let q = 0; q < count; q++) {
        const i = byOffset[sign > 0 ? q : count - 1 - q];
        if (sign * o[i] <= 0 || crossing[i]) continue;
        if (1 - blend[i] > 0) push(slice[i], i, 1 - blend[i]);
        if (blend[i] > 0) push(upper(i), i, blend[i]);
      }
      const fields = {
        start: new Float64Array(slices),
        end: new Float64Array(slices),
        extent: new Float64Array(slices),
      };
      for (let k = 0; k < slices; k++) {
        const run = runs(lists[k].entries, lists[k].weights, o, fitting[s]);
        // A flank that starts farther from the edge than reach, or runs less than flankRun edges,
        // is no flank: soft would then reach across most of the band.
        const flank =
          run.start <= reach && Math.min(run.end, run.extent) - run.start >= flankRun * edge;
        fields.start[k] = flank ? run.start : 0;
        fields.end[k] = flank ? run.end : 0;
        fields.extent[k] = run.extent;
      }
      return fields;
    });
    const zone = new Uint8Array(count).fill(BandZone.Beyond);
    for (let i = 0; i < count; i++) {
      const s = o[i] > 0 ? 0 : 1;
      const offset = Math.abs(o[i]);
      // Of the vertex's two slices, the later start and the earlier end, so a vertex is flank or
      // soft only where both slices make it so.
      const a = touching(sides[s].start, i, Math.max),
        b = touching(sides[s].end, i, Math.min);
      if (!band.open[i] || crossing[i] || !(a < b)) continue;
      // A vertex that fits both surfaces lies on its own side's flank, not between them.
      if (offset < a) zone[i] = fitting[s][i] && onSurface[1 - s][i] ? own[s] : BandZone.Soft;
      else if (offset < b) zone[i] = own[s];
    }
    return { o, sides, zone };
  };

  const half = slices / 2;
  // True when the solved edge lies within reach of the guide in half of the solved slices.
  const reaches = (at: Solved) =>
    at.solvedSlices.filter((k) => Math.abs(at.offset[k]) <= reach).length >= half;
  // Median angle between the flank surfaces' normals along the solved edge, degrees.
  const apart = (at: Solved) => (median(at.solvedSlices.map((k) => at.angle[k])) * 180) / Math.PI;
  // The nearest pair whose surfaces both fit and meet within reach of the guide, apart there.
  let paired: FlankFit[] | null = null,
    met: Solved | null = null;
  // Each candidate is fitted once, when a pair first needs it.
  const fitted = candidates.map((side) => side.map((): FlankFit | null | undefined => undefined));
  const fitOf = (s: number, i: number) =>
    fitted[s][i] === undefined
      ? (fitted[s][i] = flankFit(
          [...candidates[s][i].seed].sort((x, y) => x - y),
          position,
          band,
          frame,
          noise,
        ))
      : fitted[s][i];
  for (const [i, j] of pairs) {
    const pair = [fitOf(0, i), fitOf(1, j)];
    if (!pair[0] || !pair[1]) continue;
    met = solve(pair as FlankFit[]);
    if (met && reaches(met) && apart(met) >= minBandAngle) {
      paired = pair as FlankFit[];
      break;
    }
  }
  if (!paired || !met) return null;
  let fits = paired,
    solved = met;
  let classified = split(fits, solved);
  // Reseed each flank from 2 to 8 edge lengths past the solved edge and solve again, until the edge
  // stays. A seed starts past the soft zone by an edge and by its own width, so that a wide fillet's
  // shoulder cannot pull the fit toward it, and stops at a second transition.
  for (let round = 0; round < rounds; round++) {
    const { o, sides } = classified;
    const next = [0, 1].map((s) => {
      const sign = s === 0 ? 1 : -1;
      const { start, end } = sides[s];
      const found: number[] = [];
      for (let k = 0; k < slices; k++) if (end[k] > start[k]) found.push(start[k]);
      // A fit that finds a flank in under half of the slices does not describe the side: refit the
      // plain window. Otherwise a slice without a flank seeds from the side's typical start, so a fit
      // too simple for the surface still sees the part it misses.
      const plain = found.length < slices / 2;
      const typical = found.length ? median(found) : 0;
      const startOf = Float64Array.from(start, (v, k) => (end[k] > v ? v : typical));
      const endOf = Float64Array.from(end, (v, k) => (v > start[k] ? v : Infinity));
      const members: number[] = [];
      for (let i = 0; i < count; i++) {
        if (crossing[i] || !band.open[i]) continue;
        const offset = sign * o[i];
        if (plain) {
          if (offset >= from && offset <= from + span) members.push(i);
          continue;
        }
        const first = touching(startOf, i, Math.max);
        const a = Math.max(from, first + edge, 2 * first);
        if (offset < a || offset > a + span || offset >= touching(endOf, i, Math.min)) continue;
        members.push(i);
      }
      return flankFit(members, position, band, frame, noise) ?? fits[s];
    });
    const again = solve(next);
    if (!again) break;
    const move = moved(solved, again);
    fits = next;
    solved = again;
    classified = split(fits, solved);
    if (move < edge / 2) break;
  }

  // The flank surfaces refitted on every flank vertex the classification reads, so that a face with
  // ripple is not judged by a surface through a narrow strip of it: refitted until the edge moves
  // less than half an edge, and kept only once it does.
  {
    let state = { fits, solved, classified };
    let settled = false;
    for (let round = 0; round < rounds && !settled; round++) {
      const whole = [0, 1].map((s) => {
        const members: number[] = [];
        for (let i = 0; i < count; i++)
          if (state.classified.zone[i] === own[s] && band.g[i] <= analysis) members.push(i);
        // After the first refit, the surfaces keep their kind: the members hardly change.
        const kind = round > 0 ? state.fits[s].kind : undefined;
        return flankFit(members, position, band, frame, noise, kind) ?? state.fits[s];
      });
      const again = solve(whole);
      if (!again) break;
      settled = moved(state.solved, again) < edge / 2;
      state = { fits: whole, solved: again, classified: split(whole, again) };
    }
    if (settled) ({ fits, solved, classified } = state);
  }
  const { zone, sides, o } = classified;
  // A flank that ends at a second transition stops short of it: positions within the tolerance
  // reach into the next fillet before they leave the flank's surface. The zones are final from here.
  const stops = sides.map((side) =>
    Float64Array.from(side.end, (end, k) => {
      const run = Math.min(end, side.extent[k]) - side.start[k];
      return end - Math.min(flankRun * edge, Math.max(marginFloor * edge, run - keptRun * edge));
    }),
  );
  for (let i = 0; i < count; i++) {
    if (zone[i] !== BandZone.Left && zone[i] !== BandZone.Right) continue;
    if (Math.abs(o[i]) >= touching(stops[zone[i] - 1], i, Math.min)) zone[i] = BandZone.Beyond;
  }
  // A vertex in a flank's run but off its surface by more than the tolerance would be moved by more
  // than it: on the rounding's shoulder it is Soft, further out Beyond. The evidence below reads the
  // runs as they were.
  const runZone = zone.slice();
  for (let i = 0; i < count; i++) {
    if (zone[i] !== BandZone.Left && zone[i] !== BandZone.Right) continue;
    const s = zone[i] - 1;
    if (Math.abs(fits[s].distance(i)) <= 3 * fits[s].local) continue;
    const shoulder = touching(sides[s].start, i, Math.max) + shoulderEdges * edge;
    zone[i] = Math.abs(o[i]) < shoulder ? BandZone.Soft : BandZone.Beyond;
  }

  // Evidence of an edge that does not depend on the width: the solved edge within reach of the
  // guide, the flank surfaces apart there, and flanks that turn far less than the edge does.
  if (!reaches(solved)) return null;
  const angle = apart(solved);
  if (angle < minBandAngle) return null;
  const flatness = flankFlatness(
    o,
    frame.turn,
    runZone,
    (i) => band.g[i] <= analysis,
    flatFrom * edge,
    angle,
  );
  if (flatness < minFlankFlatness) return null;

  const larger: number[] = [];
  for (let k = 0; k < slices; k++)
    if (sides.every((side) => side.end[k] > side.start[k]))
      larger.push(Math.max(sides[0].start[k], sides[1].start[k]));
  const soft = larger.length ? median(larger) : 0;
  const at = new Float64Array(3);
  const locate = (p: number[]): [number, number, number] => {
    const s = closestOnCurve(drawn, p[0], p[1], p[2], at);
    if (slices === 1) return [0, 0, 0];
    const f = Math.min(
      slices - 1,
      Math.max(0, ((s - total / 2) / total) * slices + (slices - 1) / 2),
    );
    const k = Math.min(slices - 2, Math.floor(f));
    return [k, k + 1, f - k];
  };
  const flanks: [BandFlank, BandFlank] = [bandFlank(fits[0], locate), bandFlank(fits[1], locate)];

  // The band capped to a width measured from the solved edge, so that a guide laid to one side of
  // the edge does not starve the far flank, or null when its flanks there show no edge: on each
  // side enough vertices, running far enough outward in half of the slices.
  const result = (cap: number): EdgeBand | null => {
    const keep: number[] = [];
    const counts = [0, 0];
    const inner = new Float64Array(slices * 2).fill(Infinity),
      outer = new Float64Array(slices * 2).fill(-Infinity);
    for (let i = 0; i < count; i++) {
      if (Math.abs(o[i]) > cap) continue;
      keep.push(i);
      if (runZone[i] !== BandZone.Left && runZone[i] !== BandZone.Right) continue;
      const s = runZone[i] - 1,
        k = nearestSlice(i) * 2 + s,
        offset = Math.abs(o[i]);
      counts[s]++;
      inner[k] = Math.min(inner[k], offset);
      outer[k] = Math.max(outer[k], offset);
    }
    if (counts[0] < minimumFlank || counts[1] < minimumFlank) return null;
    for (let s = 0; s < 2; s++) {
      let long = 0;
      for (let k = 0; k < slices; k++)
        if (outer[k * 2 + s] - inner[k * 2 + s] >= flankRun * edge) long++;
      if (long < half) return null;
    }
    return {
      vertices: Uint32Array.from(keep, (i) => vertices[i]),
      station: Float32Array.from(keep, (i) => band.station[i]),
      cross: Float32Array.from(keep, (i) => u[i]),
      zone: Uint8Array.from(keep, (i) => zone[i]),
      drawn,
      soft,
      fits: [fits[0].kind, fits[1].kind],
      flanks,
      edge: solved.point.slice(),
      angle,
    };
  };
  return { result, soft, edge, gathered: band.width - reach };
}

/** True when the guide's last point comes before its first, in x, then y, then z, then triangle. */
function drawnBackward(points: GuidePoint[]) {
  const a = points[0],
    b = points[points.length - 1];
  for (let k = 0; k < 3; k++)
    if (a.position[k] !== b.position[k]) return b.position[k] < a.position[k];
  return b.triangle < a.triangle;
}

/** The band for the guide drawn the other way: Left and Right swapped, nothing else changed. */
function mirrored(band: EdgeBand): EdgeBand {
  const { drawn } = band;
  const n = drawn.points.length / 3,
    total = drawn.lengths[n - 1];
  const reversed = (values: Float64Array) => {
    const out = new Float64Array(values.length);
    const m = values.length / 3;
    for (let i = 0; i < m; i++) out.set(values.subarray((m - 1 - i) * 3, (m - i) * 3), i * 3);
    return out;
  };
  const swap = [BandZone.Soft, BandZone.Right, BandZone.Left, BandZone.Beyond];
  return {
    vertices: band.vertices,
    station: Float32Array.from(band.station, (s) => total - s),
    cross: Float32Array.from(band.cross, (c) => -c),
    zone: Uint8Array.from(band.zone, (z) => swap[z]),
    drawn: {
      points: reversed(drawn.points),
      lengths: Float64Array.from({ length: n }, (_, i) => total - drawn.lengths[n - 1 - i]),
      corner: Uint8Array.from({ length: n }, (_, i) => drawn.corner[n - 1 - i]),
      closed: drawn.closed,
    },
    soft: band.soft,
    fits: [band.fits[1], band.fits[0]],
    flanks: [band.flanks[1], band.flanks[0]],
    edge: reversed(band.edge),
    angle: band.angle,
  };
}

/**
 * The classified band, read from the guide in one fixed direction whichever way it was drawn, so
 * that reversing it swaps Left and Right exactly and changes nothing else.
 */
function classify(
  mesh: RefineMesh,
  topology: RefineTopology,
  kind: GuideKind,
  points: GuidePoint[],
  width: number | null,
  noise: number,
) {
  if (points.length < 2) return null;
  const backward = drawnBackward(points);
  const found = classifyOriented(
    mesh,
    topology,
    kind,
    backward ? [...points].reverse() : points,
    width,
    noise,
  );
  if (!found || !backward) return found;
  return {
    ...found,
    result: (cap: number) => {
      const band = found.result(cap);
      return band && mirrored(band);
    },
  };
}

/**
 * A guide's classification, which every width up to `gathered`, measured from the solved edge, caps
 * without classifying again.
 */
export type BandClassification = NonNullable<ReturnType<typeof classify>>;

/**
 * The band of vertices within `width` of the solved edge, or null when no edge lies under the guide:
 * two flank surfaces meeting within reach of it. `known`, a classification of the same guide on the
 * same surface, is capped instead when it reaches `width`.
 */
export function buildBand(
  mesh: RefineMesh,
  topology: RefineTopology,
  kind: GuideKind,
  points: GuidePoint[],
  width: number,
  noise: number,
  known?: BandClassification | null,
): EdgeBand | null {
  const found =
    known && width <= known.gathered ? known : classify(mesh, topology, kind, points, width, noise);
  return found?.result(width) ?? null;
}

/**
 * A width, measured from the solved edge, that leaves flank on both sides: soft + max(2 * soft, 6 *
 * the local edge length), from the same classification `buildBand` makes. It is held to 1 mm unless
 * the edge cannot be read within that, as on a coarse mesh with a wide rounding. 0 when it shows no
 * edge, or none at that width.
 */
export function estimateWidth(
  mesh: RefineMesh,
  topology: RefineTopology,
  kind: GuideKind,
  points: GuidePoint[],
  noise: number,
): number {
  return estimateBand(mesh, topology, kind, points, noise).width;
}

/** `estimateWidth` with the classification it read, for `buildBand` to reuse. */
export function estimateBand(
  mesh: RefineMesh,
  topology: RefineTopology,
  kind: GuideKind,
  points: GuidePoint[],
  noise: number,
): { width: number; found: BandClassification | null } {
  const found = classify(mesh, topology, kind, points, null, noise);
  if (!found) return { width: 0, found };
  const wanted = found.soft + Math.max(2 * found.soft, 6 * found.edge);
  const limited = Math.min(widestEstimate, wanted);
  if (found.result(limited)) return { width: limited, found };
  return { width: wanted > limited && found.result(wanted) ? wanted : 0, found };
}
