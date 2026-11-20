import {
  type BandFit,
  type BandFlank,
  BandZone,
  type EdgeBand,
  type GuidePoint,
  buildBand,
  estimateWidth,
  minBandAngle,
} from './refine-band';
import { type CutResult, cutAlongField } from './refine-cut';
import { type Shape, type ShapeKind, fitShape, projectToShape, shapeDistance } from './refine-fit';
import {
  type EdgeCurve,
  type GuideJoint,
  type GuideKind,
  closestOnCurve,
  curveTangent,
  fitCurve,
  joinCurves,
} from './refine-curve';
import {
  type RefineMesh,
  type RefineTopology,
  addGeometryVertex,
  cloneRefineMesh,
  addTriangle,
  addWeldedVertex,
  foldedTriangles,
  moveVertex,
  setTriangle,
  vertexNormal,
  weldedCorner,
} from './refine-mesh';
import type { Vec3 } from './types';

export interface Flank {
  kind: BandFit;
  /** Signed distance, positive on the side the flank's own vertices' normals face. */
  signed(x: number, y: number, z: number): number;
  distance(x: number, y: number, z: number): number; // unsigned
  project(x: number, y: number, z: number, out: Float32Array): void;
}
export interface EdgeSegment {
  kind: GuideKind;
  points: GuidePoint[];
}
export interface EdgeInput {
  segments: EdgeSegment[];
  /** One per joint between consecutive segments, plus one closing joint when `closed`. */
  joints: GuideJoint[];
  closed: boolean;
  /** Null uses `estimateWidth`. */
  width: number | null;
  /** 0 to 1; 1 is fully sharp. */
  strength: number;
}
/** How the sharpness ends at an open guide's end: tapered along the edge, or held to the end. */
export type EdgeEnd = 'taper' | 'hold';
export interface EdgeSolve {
  bands: EdgeBand[];
  flanks: [Flank, Flank][];
  /** The solved edge, all segments joined. */
  curve: EdgeCurve;
  /** +1 exterior, -1 interior, per segment. */
  sign: Int8Array;
  width: number;
  /**
   * Largest distance, mm, between `curve` and the points where the flanks meet that it was fitted
   * to, clear of the ends' tapers.
   */
  deviation: number;
  /**
   * Per end of the path (start, finish): `taper` where the edge continues past it, so the sharpness
   * fades along the edge; `hold` where it does not or where it meets an edge already restored, so the
   * edge stays sharp to the end. Both `hold` on a closed path.
   */
  ends: [EdgeEnd, EdgeEnd];
  /** One per joint between consecutive segments, plus the closing one on a closed path. */
  joints: GuideJoint[];
  /**
   * Station along `curve` at which each segment's stretch starts, then where the last one ends; on a
   * closed path that is the first plus the curve's length.
   */
  bounds: Float64Array;
}
export interface EdgeResult {
  /** Welded vertices moved or created. */
  changed: Uint32Array;
  cut: CutResult | null;
  /** Triangles the cut left straddling the edge. */
  skipped: Uint32Array;
  /** Band triangles whose normal the move reversed. */
  folded: Uint32Array;
}

/** Deepest the solved edge may lie below or above the surface, as a fraction of the band's width. */
const deepestEdge = 0.5;
/**
 * A vertex's move is weighted by its distance over the surface from the nearest vertex that does not
 * move, over a blend of half the band's width, held between these many edge lengths.
 */
const blendEdges = [2, 4];
/** At an open guide's ends the weight also tapers along the edge over this many mm, or edge lengths. */
const taperLength = 0.5;
const taperEdges = 8;
/** Fewest edge lengths of the edge that keep full weight; the taper shortens to leave them. */
const coreEdges = 4;
/** The cut runs among vertices of more than this weight; below it the surface is only moved. */
const cutWeight = 0.05;
/** Least weight of a chain vertex that is marked as a crease. */
const creaseWeight = 0.5;
/**
 * An end continues when, of the vertices within `endEdges` edge lengths past the flanks' start of
 * the edge extended `endReach` mm past it, `endShare` lie within tolerance of a flank, `endSide` on
 * each.
 */
const endReach = 0.3;
const endEdges = 4;
const endShare = 0.6;
const endSide = 0.2;
/**
 * The flanks are refitted from vertices past the soft zone plus these many edge lengths from the
 * edge, then this many more each step, until the edge they meet at moves no more than `settled` mm.
 */
const clearEdges = 2;
const settled = 0.01;
/** Fewest vertices, and edge lengths of run past the threshold, a refitted flank reads. */
const refitVertices = 12;
const refitRun = 3;
/** Most vertices a flank refit reads. */
const refitPoints = 1024;
const empty = new Uint32Array(0);

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const curveLength = (curve: EdgeCurve) => curve.lengths[curve.lengths.length - 1];
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};
const unit = (v: number[]) => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};
const crossOf = (a: ArrayLike<number>, b: ArrayLike<number>) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/** Two unit vectors perpendicular to `t` and to each other. */
function perpendiculars(t: number[]) {
  const helper = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const b = unit(crossOf(t, helper));
  return [b, crossOf(t, b)];
}

/** Gradient of a flank's signed distance, by central differences. */
function gradient(flank: Flank, p: number[]) {
  const h = 1e-6;
  const g = [0, 0, 0];
  const q = [p[0], p[1], p[2]];
  for (let a = 0; a < 3; a++) {
    q[a] = p[a] + h;
    const forward = flank.signed(q[0], q[1], q[2]);
    q[a] = p[a] - h;
    g[a] = (forward - flank.signed(q[0], q[1], q[2])) / (2 * h);
    q[a] = p[a];
  }
  return g;
}

/** The vertices a flank was last refitted from. */
interface FlankSample {
  points: Float32Array;
  normals: Float32Array;
  kind: ShapeKind;
}

/** A band flank as a signed surface: positive on the side its normal faces. */
function flankOf(surface: BandFlank): Flank {
  const at = new Float64Array(3),
    normal = new Float64Array(3);
  return {
    kind: surface.kind,
    signed: (x, y, z) => {
      surface.project(x, y, z, at);
      surface.normal(x, y, z, normal);
      return (x - at[0]) * normal[0] + (y - at[1]) * normal[1] + (z - at[2]) * normal[2];
    },
    distance: (x, y, z) => surface.distance(x, y, z),
    project: (x, y, z, out) => surface.project(x, y, z, out),
  };
}

/** Median length of the edges at the band's vertices. */
function bandEdgeLength(mesh: RefineMesh, topology: RefineTopology, band: EdgeBand) {
  const { position } = mesh;
  const lengths: number[] = [];
  const stride = Math.max(1, Math.floor(band.vertices.length / 2000));
  for (let i = 0; i < band.vertices.length; i += stride) {
    const v = band.vertices[i];
    for (let j = topology.neighbourStart[v]; j < topology.neighbourStart[v + 1]; j++) {
      const w = topology.neighbours[j];
      lengths.push(
        Math.hypot(
          position[v * 3] - position[w * 3],
          position[v * 3 + 1] - position[w * 3 + 1],
          position[v * 3 + 2] - position[w * 3 + 2],
        ),
      );
    }
  }
  return lengths.length ? median(lengths) : 0;
}

/**
 * Finds which of `members` (indices into the band) lies nearest a point, through a grid of `cell` mm.
 * The search widens ring by ring until no closer member can remain. -1 when there are no members.
 */
function nearestMember(mesh: RefineMesh, band: EdgeBand, members: number[], cell: number) {
  const { position } = mesh;
  const cells = new Map<number, number[]>();
  const key = (i: number, j: number, k: number) =>
    Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791);
  for (const m of members) {
    const v = band.vertices[m] * 3;
    const id = key(
      Math.floor(position[v] / cell),
      Math.floor(position[v + 1] / cell),
      Math.floor(position[v + 2] / cell),
    );
    const list = cells.get(id);
    if (list) list.push(m);
    else cells.set(id, [m]);
  }
  const rings = Math.ceil(Math.cbrt(cells.size)) + 2;
  return (x: number, y: number, z: number) => {
    const [ci, cj, ck] = [Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell)];
    let nearest = -1,
      best = Infinity;
    for (let r = 0; r <= rings && !(best <= (r - 1) * cell); r++)
      for (let i = -r; i <= r; i++)
        for (let j = -r; j <= r; j++)
          for (let k = -r; k <= r; k++) {
            if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== r) continue;
            for (const m of cells.get(key(ci + i, cj + j, ck + k)) ?? []) {
              const v = band.vertices[m] * 3;
              const d = Math.hypot(position[v] - x, position[v + 1] - y, position[v + 2] - z);
              if (d < best || (d === best && m < nearest)) {
                best = d;
                nearest = m;
              }
            }
          }
    if (nearest < 0)
      for (const m of members) {
        const v = band.vertices[m] * 3;
        const d = Math.hypot(position[v] - x, position[v + 1] - y, position[v + 2] - z);
        if (d < best) {
          best = d;
          nearest = m;
        }
      }
    return { nearest, distance: best };
  };
}

/**
 * Where the two flanks meet, refined from each point of the band's own solved edge by Newton's
 * method in the cross-section plane there, with the angle between the flanks' normals.
 */
function meetFlanks(band: EdgeBand, flanks: [Flank, Flank], width: number) {
  const edge = band.edge;
  const n = edge.length / 3;
  const points: number[] = [],
    angles: number[] = [];
  const tangent = new Float64Array(3);
  for (let k = 0; k < n; k++) {
    const start = [edge[k * 3], edge[k * 3 + 1], edge[k * 3 + 2]];
    const [before, after] = [Math.max(0, k - 1), Math.min(n - 1, k + 1)];
    let t = [0, 1, 2].map((a) => edge[after * 3 + a] - edge[before * 3 + a]);
    if (!(Math.hypot(t[0], t[1], t[2]) > 0)) {
      const station = closestOnCurve(band.drawn, start[0], start[1], start[2], tangent);
      curveTangent(band.drawn, station, tangent);
      t = Array.from(tangent);
    }
    const [b, m] = perpendiculars(unit(t));
    let x = 0,
      y = 0,
      solved = false;
    const p = [...start];
    for (let iteration = 0; iteration < 40 && !solved; iteration++) {
      for (let a = 0; a < 3; a++) p[a] = start[a] + x * b[a] + y * m[a];
      const g1 = gradient(flanks[0], p),
        g2 = gradient(flanks[1], p);
      const f1 = flanks[0].signed(p[0], p[1], p[2]),
        f2 = flanks[1].signed(p[0], p[1], p[2]);
      const [a11, a12, a21, a22] = [dot(g1, b), dot(g1, m), dot(g2, b), dot(g2, m)];
      const det = a11 * a22 - a12 * a21;
      if (!(Math.abs(det) > 1e-9)) break;
      const dx = (f1 * a22 - f2 * a12) / det,
        dy = (a11 * f2 - a21 * f1) / det;
      x -= dx;
      y -= dy;
      if (!(Math.hypot(x, y) < width)) break;
      solved = Math.hypot(dx, dy) < 1e-10;
    }
    if (!solved) continue;
    for (let a = 0; a < 3; a++) p[a] = start[a] + x * b[a] + y * m[a];
    const [g1, g2] = [unit(gradient(flanks[0], p)), unit(gradient(flanks[1], p))];
    points.push(...p);
    angles.push((Math.acos(Math.min(1, Math.max(-1, dot(g1, g2)))) * 180) / Math.PI);
  }
  return { points: Float64Array.from(points), angles };
}

/**
 * +1 when the solved edge lies on the outward side of the soft zone's surface: at each point where
 * the flanks meet, the side of the nearest Soft vertex's normal it lies on, by majority. Without Soft
 * vertices, +1 when each flank lies behind the other's surface.
 */
function edgeSign(
  mesh: RefineMesh,
  topology: RefineTopology,
  band: EdgeBand,
  flanks: [Flank, Flank],
  meet: Float64Array,
  edgeLength: number,
) {
  const { position } = mesh;
  const soft: number[] = [];
  band.zone.forEach((z, i) => z === BandZone.Soft && soft.push(i));
  const find = nearestMember(mesh, band, soft, 4 * edgeLength);
  const normal = new Float32Array(3);
  let vote = 0;
  for (let k = 0; k < meet.length && soft.length; k += 3) {
    const nearest = band.vertices[find(meet[k], meet[k + 1], meet[k + 2]).nearest];
    vertexNormal(mesh, topology, nearest, normal);
    let outward = 0;
    for (let a = 0; a < 3; a++) outward += (meet[k + a] - position[nearest * 3 + a]) * normal[a];
    vote += Math.sign(outward);
  }
  if (vote !== 0) return vote > 0 ? 1 : -1;
  const middle = (meet.length / 3) >> 1;
  const p = [meet[middle * 3], meet[middle * 3 + 1], meet[middle * 3 + 2]];
  const centres = [BandZone.Left, BandZone.Right].map((zone) => {
    const c = [0, 0, 0];
    let n = 0;
    band.zone.forEach((z, i) => {
      if (z !== zone) return;
      for (let a = 0; a < 3; a++) c[a] += position[band.vertices[i] * 3 + a];
      n++;
    });
    return c.map((v, a) => v / n - p[a]);
  });
  const facing = dot(gradient(flanks[0], p), centres[1]) + dot(gradient(flanks[1], p), centres[0]);
  return facing < 0 ? 1 : -1;
}

/** A fitted shape as a signed surface: positive on the side its fitted points' normals face. */
function shapeFlank(shape: Shape): Flank {
  return {
    kind: shape.kind,
    signed: (x, y, z) => shapeDistance(shape, x, y, z),
    distance: (x, y, z) => Math.abs(shapeDistance(shape, x, y, z)),
    project: (x, y, z, out) => projectToShape(shape, x, y, z, out),
  };
}

/**
 * The point of `curve` nearest (x, y, z), past an end along the end's tangent, into `out`; returns
 * its station, continued past the ends.
 */
function onCurve(curve: EdgeCurve, x: number, y: number, z: number, out: Float64Array) {
  const station = closestOnCurve(curve, x, y, z, out);
  const total = curveLength(curve);
  if (curve.closed || (station > 0 && station < total)) return station;
  const tangent = new Float64Array(3);
  curveTangent(curve, station, tangent);
  const along = (x - out[0]) * tangent[0] + (y - out[1]) * tangent[1] + (z - out[2]) * tangent[2];
  if ((station <= 0 && along < 0) || (station >= total && along > 0)) {
    for (let a = 0; a < 3; a++) out[a] += along * tangent[a];
    return station + along;
  }
  return station;
}

/**
 * The stretch of the solved edge the guide covers: the stations, along `curve` continued past its
 * ends, of the drawn guide's two ends, and the taper at each end.
 */
function guideSpan(curve: EdgeCurve, drawn: EdgeCurve, edge: number, tapers = 2) {
  const at = new Float64Array(3);
  const p = drawn.points,
    n = p.length - 3;
  const stations = [
    onCurve(curve, p[0], p[1], p[2], at),
    onCurve(curve, p[n], p[n + 1], p[n + 2], at),
  ];
  const [from, to] = stations[0] <= stations[1] ? stations : [stations[1], stations[0]];
  return { from, to, stations, taper: taperOf(to - from, edge, tapers) };
}

/** The point of `curve` at `station`, continued past its ends along their tangents, into `out`. */
function curveAt(curve: EdgeCurve, station: number, out: Float64Array) {
  const { points, lengths } = curve;
  const n = lengths.length;
  const total = lengths[n - 1];
  const s = Math.min(total, Math.max(0, station));
  let j = 0;
  while (j < n - 2 && lengths[j + 1] < s) j++;
  const span = lengths[j + 1] - lengths[j];
  const f = span > 0 ? (s - lengths[j]) / span : 0;
  for (let a = 0; a < 3; a++) out[a] = points[j * 3 + a] * (1 - f) + points[(j + 1) * 3 + a] * f;
  if (station === s || curve.closed) return;
  const tangent = new Float64Array(3);
  curveTangent(curve, s, tangent);
  for (let a = 0; a < 3; a++) out[a] += (station - s) * tangent[a];
}

/**
 * Distance from the solved edge at which the flanks start: per side, per stretch of 4 edge lengths,
 * the nearest of its vertices to `curve`; the median over the stretches, the larger side.
 */
function flankStart(mesh: RefineMesh, band: EdgeBand, curve: EdgeCurve, edge: number) {
  const { position } = mesh;
  const at = new Float64Array(3);
  const nearest = [new Map<number, number>(), new Map<number, number>()];
  band.vertices.forEach((v, i) => {
    const zone = band.zone[i];
    if (zone !== BandZone.Left && zone !== BandZone.Right) return;
    const station = onCurve(curve, position[v * 3], position[v * 3 + 1], position[v * 3 + 2], at);
    const d = Math.hypot(
      position[v * 3] - at[0],
      position[v * 3 + 1] - at[1],
      position[v * 3 + 2] - at[2],
    );
    const bins = nearest[zone - 1];
    const bin = Math.floor(station / (4 * edge));
    bins.set(bin, Math.min(bins.get(bin) ?? Infinity, d));
  });
  return Math.max(...nearest.map((bins) => (bins.size ? median([...bins.values()]) : 0)));
}

/**
 * Whether the edge continues past the guide's end at `station`, going `direction` along the curve.
 * The vertices past the end within `endReach` of it along the edge, as near the extended edge as the
 * flanks start plus `endEdges` edge lengths, are reached over the surface from the band. Of those
 * past where the flanks start, at least `endShare` lie within tolerance of a flank, `endSide` of
 * them on each.
 */
function continues(
  mesh: RefineMesh,
  topology: RefineTopology,
  band: EdgeBand,
  flanks: [Flank, Flank],
  curve: EdgeCurve,
  station: number,
  direction: 1 | -1,
  edge: number,
) {
  const { position } = mesh;
  const start = flankStart(mesh, band, curve, edge);
  const radius = start + endEdges * edge;
  const at = new Float64Array(3);
  // Distance past the end along the edge, and from the extended edge, of a vertex.
  const place = (v: number) => {
    const s = onCurve(curve, position[v * 3], position[v * 3 + 1], position[v * 3 + 2], at);
    const past = (s - station) * direction;
    curveAt(curve, station + direction * Math.min(endReach, Math.max(0, past)), at);
    const off = Math.hypot(
      position[v * 3] - at[0],
      position[v * 3 + 1] - at[1],
      position[v * 3 + 2] - at[2],
    );
    return { past, off };
  };
  const inside = ({ past, off }: { past: number; off: number }) =>
    past >= -edge && past <= endReach && off <= radius;
  const seen = new Set<number>();
  const queue: number[] = [];
  for (const v of band.vertices)
    if (inside(place(v))) {
      seen.add(v);
      queue.push(v);
    }
  let count = 0;
  const sides = [0, 0];
  const tolerance = band.flanks.map((flank) => 3 * flank.local);
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head];
    const { past, off } = place(v);
    if (past > 0 && off > start) {
      count++;
      const [x, y, z] = [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]];
      const ratio = flanks.map((flank, s) => flank.distance(x, y, z) / tolerance[s]);
      if (Math.min(ratio[0], ratio[1]) <= 1) sides[ratio[0] <= ratio[1] ? 0 : 1]++;
    }
    for (let j = topology.neighbourStart[v]; j < topology.neighbourStart[v + 1]; j++) {
      const w = topology.neighbours[j];
      if (seen.has(w) || !inside(place(w))) continue;
      seen.add(w);
      queue.push(w);
    }
  }
  return (
    count > 0 &&
    sides[0] + sides[1] >= endShare * count &&
    Math.min(sides[0], sides[1]) >= endSide * count
  );
}

/** Linear interpolation of `values` (3 per sample) at `station` among ascending `stations`. */
function interpolate(stations: number[], values: number[], station: number, out: number[]) {
  const n = stations.length;
  let j = 0;
  while (j < n - 1 && stations[j + 1] < station) j++;
  const k = Math.min(n - 1, j + 1);
  const span = stations[k] - stations[j];
  const f = span > 0 ? Math.min(1, Math.max(0, (station - stations[j]) / span)) : 0;
  for (let a = 0; a < 3; a++) out[a] = values[j * 3 + a] * (1 - f) + values[k * 3 + a] * f;
}

/**
 * Length of the taper at each end of an edge `length` mm long: `taperLength` or `taperEdges` edge
 * lengths, shortened so that `coreEdges` edge lengths keep full weight.
 */
function taperOf(length: number, edge: number, tapers = 2) {
  const taper = Math.max(taperLength, taperEdges * edge);
  if (!tapers || length >= tapers * taper + coreEdges * edge) return taper;
  return Math.max(0, (length - coreEdges * edge) / tapers);
}

/** Largest distance from `points` (xyz) to `curve`, among those clear of the guide's end tapers. */
function largestGap(curve: EdgeCurve, drawn: EdgeCurve, points: ArrayLike<number>, edge: number) {
  const { from, to, taper } = guideSpan(curve, drawn, edge);
  const at = new Float64Array(3);
  let clear = 0,
    all = 0;
  for (let k = 0; k < points.length; k += 3) {
    const station = onCurve(curve, points[k], points[k + 1], points[k + 2], at);
    const gap = Math.hypot(points[k] - at[0], points[k + 1] - at[1], points[k + 2] - at[2]);
    all = Math.max(all, gap);
    if (station >= from + taper && station <= to - taper) clear = Math.max(clear, gap);
  }
  return clear || all;
}

/**
 * The flanks, refitted from vertices clear of the rounding's shoulder, where they meet and the curve
 * fitted there. Vertices a little way up the rounding lie within tolerance of a flank and tilt its
 * fit toward the rounding, pulling the edge inward: each flank is refitted from its vertices past
 * `soft + clearEdges` edge lengths from the edge, then `clearEdges` more each step, until the edge
 * moves no more than `settled` between steps or too few vertices remain. A profile flank is kept.
 */
function unbiasedFlanks(
  mesh: RefineMesh,
  topology: RefineTopology,
  band: EdgeBand,
  kind: GuideKind,
  controls: number,
  width: number,
  noise: number,
  edge: number,
) {
  const { position } = mesh;
  const normal = new Float32Array(3);
  const sides = [BandZone.Left, BandZone.Right].map((zone) => {
    const members: number[] = [];
    band.zone.forEach((z, i) => z === zone && members.push(band.vertices[i]));
    const normals = new Float32Array(members.length * 3);
    members.forEach((v, k) => {
      vertexNormal(mesh, topology, v, normal);
      normals.set(normal, k * 3);
    });
    return { members, normals };
  });
  const at = new Float64Array(3);
  const samples: (FlankSample | null)[] = [null, null];
  const refit = (threshold: number, curve: EdgeCurve): [Flank, Flank] | null => {
    const fitted = sides.map(({ members, normals }, s) => {
      const fit = band.fits[s];
      samples[s] = null;
      if (fit === 'profile') return flankOf(band.flanks[s]);
      const chosen: number[] = [];
      let reach = 0;
      members.forEach((v, k) => {
        onCurve(curve, position[v * 3], position[v * 3 + 1], position[v * 3 + 2], at);
        const d = Math.hypot(
          position[v * 3] - at[0],
          position[v * 3 + 1] - at[1],
          position[v * 3 + 2] - at[2],
        );
        if (d <= threshold) return;
        chosen.push(k);
        reach = Math.max(reach, d);
      });
      if (chosen.length < refitVertices || reach - threshold < refitRun * edge) return null;
      const count = Math.min(chosen.length, refitPoints);
      const stride = chosen.length / count;
      const p = new Float32Array(count * 3),
        n = new Float32Array(count * 3);
      for (let j = 0; j < count; j++) {
        const k = chosen[Math.floor(j * stride)];
        p.set(position.subarray(members[k] * 3, members[k] * 3 + 3), j * 3);
        n.set(normals.subarray(k * 3, k * 3 + 3), j * 3);
      }
      const shape = fitShape(p, n, fit, noise);
      if (!shape?.within) return null;
      samples[s] = { points: p, normals: n, kind: fit };
      return shapeFlank(shape.shape);
    });
    return fitted[0] && fitted[1] ? [fitted[0], fitted[1]] : null;
  };
  const meetWith = (flanks: [Flank, Flank], read: (FlankSample | null)[]) => {
    const meet = meetFlanks(band, flanks, width);
    if (meet.angles.length < 2) return null;
    return { flanks, meet, curve: fitCurve(kind, meet.points, controls, edge), samples: read };
  };
  // The band's own flanks seed the first step; once two steps agree, the nearer one is kept.
  let solved = meetWith([flankOf(band.flanks[0]), flankOf(band.flanks[1])], [null, null]);
  for (let step = clearEdges; solved; step += clearEdges) {
    const flanks = refit(band.soft + step * edge, solved.curve);
    const next = flanks && meetWith(flanks, [...samples]);
    if (!next) break;
    if (
      step > clearEdges &&
      largestGap(solved.curve, band.drawn, next.meet.points, edge) <= settled
    )
      break;
    solved = next;
  }
  return solved;
}

/** One segment of a path, solved on its own as a single edge. */
interface Part {
  kind: GuideKind;
  band: EdgeBand;
  edge: number;
  flanks: [Flank, Flank];
  meet: { points: Float64Array; angles: number[] };
  curve: EdgeCurve;
  samples: (FlankSample | null)[];
  controls: number;
}

/**
 * Neighbouring flanks are one surface when one fit takes each one's refit vertices within its own
 * tolerance: `sameShare` of them within 3 local of the fit and their mean within local.
 */
const sameShare = 0.9;
/** A flank refitted at a corner keeps clear of the other face by this many soft half-widths. */
const cornerClear = 2;
/** Rings of cells, each an edge length, searched for the cut vertices nearest a point. */
const weightRings = 4;
/** Snap fractions a path's cut tries, the cutter's own first. */
const pathSnaps = [0.25, 0.15, 0.05];
/** A sharp joint's corner reaches this many band widths from the joint. */
const jointReach = 2;

/** The segment solved as Task 7's single edge, or null when it shows no edge. */
function solvePart(
  mesh: RefineMesh,
  topology: RefineTopology,
  kind: GuideKind,
  points: GuidePoint[],
  width: number,
  noise: number,
): Part | null {
  const band = buildBand(mesh, topology, kind, points, width, noise);
  if (!band) return null;
  const edge = bandEdgeLength(mesh, topology, band);
  const solved = unbiasedFlanks(mesh, topology, band, kind, points.length, width, noise, edge);
  if (!solved) return null;
  const { flanks, meet, curve, samples } = solved;
  if (median(meet.angles) < minBandAngle) return null;
  // An edge that lies farther from the surface than half the band's width, as at a fin whose faces
  // nearly meet, cannot be reached by moving the band's vertices.
  const members = Array.from({ length: band.vertices.length }, (_, i) => i);
  const find = nearestMember(mesh, band, members, 4 * edge);
  const depths: number[] = [];
  for (let k = 0; k < meet.points.length; k += 3)
    depths.push(find(meet.points[k], meet.points[k + 1], meet.points[k + 2]).distance);
  if (median(depths) > deepestEdge * width) return null;
  return { kind, band, edge, flanks, meet, curve, samples, controls: points.length };
}

/** True when `sample` lies within tolerance of `flank`: `sameShare` within 3 local, mean within local. */
function liesOn(sample: FlankSample, flank: Flank, local: number) {
  const p = sample.points;
  const count = p.length / 3;
  let sum = 0,
    within = 0;
  for (let k = 0; k < count; k++) {
    const d = flank.distance(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]);
    sum += d;
    if (d <= 3 * local) within++;
  }
  return sum <= local * count && within >= sameShare * count;
}

/** Shape kinds from simplest; a group of flanks is fitted by the simplest kind among its own. */
const simplest: ShapeKind[] = ['plane', 'cylinder', 'cone', 'sphere'];

/** One flank fitted to side s of every part in `group`, or null when no shape fits them all. */
function fitTogether(parts: Part[], group: number[], s: number, noise: number) {
  const samples = group.map((i) => parts[i].samples[s]);
  if (samples.some((sample) => !sample)) return null;
  const all = samples.flatMap((sample) =>
    Array.from({ length: sample!.points.length / 3 }, (_, k) => [sample!, k] as const),
  );
  const count = Math.min(all.length, refitPoints);
  const stride = all.length / count;
  const p = new Float32Array(count * 3),
    normals = new Float32Array(count * 3);
  for (let j = 0; j < count; j++) {
    const [sample, k] = all[Math.floor(j * stride)];
    p.set(sample.points.subarray(k * 3, k * 3 + 3), j * 3);
    normals.set(sample.normals.subarray(k * 3, k * 3 + 3), j * 3);
  }
  for (const kind of simplest) {
    if (!samples.some((sample) => sample!.kind === kind)) continue;
    const shape = fitShape(p, normals, kind, noise);
    if (!shape?.within) continue;
    const flank = shapeFlank(shape.shape);
    // The parts share a surface when each one's flank lies within its own tolerance of the one fit.
    if (group.every((i) => liesOn(parts[i].samples[s]!, flank, parts[i].band.flanks[s].local)))
      return flank;
  }
  return null;
}

/**
 * Refits, as one flank, each run of neighbouring segments' flanks on one side that are one surface,
 * so the face they share has no step where segments meet, then solves each changed segment's edge
 * again. False when a changed segment's flanks no longer meet.
 */
function shareFlanks(parts: Part[], closed: boolean, width: number, noise: number) {
  const n = parts.length;
  const changed = new Set<number>();
  for (const s of [0, 1]) {
    const root = parts.map((_, i) => i);
    const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const j = (i + 1) % n;
      if (i !== j && fitTogether(parts, [i, j], s, noise)) root[find(i)] = find(j);
    }
    const groups = new Map<number, number[]>();
    parts.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
    for (const group of groups.values()) {
      const flank = group.length > 1 && fitTogether(parts, group, s, noise);
      if (!flank) continue;
      for (const i of group) {
        parts[i].flanks[s] = flank;
        changed.add(i);
      }
    }
  }
  return resolveParts(parts, changed, width);
}

/**
 * At a sharp joint whose two flanks on one side are different faces, the ends of each lie beside the
 * rounding of the edge between those faces, which tilts its fit: each such flank is refitted from its
 * vertices farther than `cornerClear` soft half-widths from the other face, then its segment's edge
 * solved again. False when a changed segment's flanks no longer meet.
 */
function clearCorners(parts: Part[], joints: GuideJoint[], width: number, noise: number) {
  const n = parts.length;
  const far: { part: number; side: number; from: Flank; reach: number }[] = [];
  joints.forEach((joint, k) => {
    const [i, j] = [k, (k + 1) % n];
    if (joint !== 'sharp' || i === j) return;
    const [a, b] = [parts[i].curve.points, parts[j].curve.points];
    const point = [0, 1, 2].map((c) => (a[a.length - 3 + c] + b[c]) / 2);
    for (const side of [0, 1]) {
      const [f, g] = [parts[i].flanks[side], parts[j].flanks[side]];
      const [u, v] = [unit(gradient(f, point)), unit(gradient(g, point))];
      if ((Math.acos(Math.min(1, Math.abs(dot(u, v)))) * 180) / Math.PI < minBandAngle) continue;
      far.push({ part: i, side, from: g, reach: cornerClear * parts[j].band.soft });
      far.push({ part: j, side, from: f, reach: cornerClear * parts[i].band.soft });
    }
  });
  const changed = new Set<number>();
  for (const [index, part] of parts.entries())
    for (const side of [0, 1]) {
      const rules = far.filter((rule) => rule.part === index && rule.side === side);
      const sample = part.samples[side];
      if (!rules.length || !sample) continue;
      const kept: number[] = [];
      for (let k = 0; k < sample.points.length / 3; k++) {
        const [x, y, z] = sample.points.subarray(k * 3, k * 3 + 3);
        if (rules.every((rule) => rule.from.distance(x, y, z) > rule.reach)) kept.push(k);
      }
      if (kept.length === sample.points.length / 3 || kept.length < refitVertices) continue;
      const points = new Float32Array(kept.length * 3),
        normals = new Float32Array(kept.length * 3);
      kept.forEach((k, j) => {
        points.set(sample.points.subarray(k * 3, k * 3 + 3), j * 3);
        normals.set(sample.normals.subarray(k * 3, k * 3 + 3), j * 3);
      });
      const shape = fitShape(points, normals, sample.kind, noise);
      if (!shape?.within) continue;
      part.flanks[side] = shapeFlank(shape.shape);
      part.samples[side] = { points, normals, kind: sample.kind };
      changed.add(index);
    }
  return resolveParts(parts, changed, width);
}

/** Solves again where the flanks of each changed part meet. False when they no longer do. */
function resolveParts(parts: Part[], changed: Set<number>, width: number) {
  for (const i of changed) {
    const part = parts[i];
    part.meet = meetFlanks(part.band, part.flanks, width);
    if (part.meet.angles.length < 2 || median(part.meet.angles) < minBandAngle) return false;
    part.curve = fitCurve(part.kind, part.meet.points, part.controls, part.edge);
  }
  return true;
}

/** Length of a curve, the closing span included when it is closed. */
function pathLength(curve: EdgeCurve) {
  const p = curve.points,
    n = p.length / 3;
  const last = curve.lengths[n - 1];
  if (!curve.closed) return last;
  return last + Math.hypot(p[0] - p[n * 3 - 3], p[1] - p[n * 3 - 2], p[2] - p[n * 3 - 1]);
}

/** The point at `station` along `curve`: around a closed one, past an open one's ends along them. */
function pathPoint(curve: EdgeCurve, station: number, out: Float64Array) {
  if (!curve.closed) return curveAt(curve, station, out);
  const total = pathLength(curve);
  const s = ((station % total) + total) % total;
  const p = curve.points,
    n = p.length / 3;
  const last = curve.lengths[n - 1];
  if (s <= last) return curveAt(curve, s, out);
  const f = (s - last) / (total - last);
  for (let a = 0; a < 3; a++) out[a] = p[(n - 1) * 3 + a] * (1 - f) + p[a] * f;
}

/** The open stretch of `curve` from station `from` to `to`, wrapping round a closed curve. */
function pieceOf(curve: EdgeCurve, from: number, to: number): EdgeCurve {
  const total = pathLength(curve);
  const at = new Float64Array(3);
  const inside: number[] = [];
  for (const lap of curve.closed ? [-1, 0, 1, 2] : [0])
    curve.lengths.forEach((station, k) => {
      const s = station + lap * total;
      if (s > from && s < to) inside.push(s, k);
    });
  const order = Array.from({ length: inside.length / 2 }, (_, i) => i).sort(
    (a, b) => inside[a * 2] - inside[b * 2],
  );
  const flat: number[] = [];
  pathPoint(curve, from, at);
  flat.push(...at);
  for (const i of order) {
    const k = inside[i * 2 + 1];
    flat.push(curve.points[k * 3], curve.points[k * 3 + 1], curve.points[k * 3 + 2]);
  }
  pathPoint(curve, to, at);
  flat.push(...at);
  const points = Float64Array.from(flat);
  const count = points.length / 3;
  const lengths = new Float64Array(count);
  for (let i = 1; i < count; i++)
    lengths[i] =
      lengths[i - 1] +
      Math.hypot(
        points[i * 3] - points[i * 3 - 3],
        points[i * 3 + 1] - points[i * 3 - 2],
        points[i * 3 + 2] - points[i * 3 - 1],
      );
  return { points, lengths, corner: new Uint8Array(count), closed: false };
}

/** The circle through three points: centre, radius, and two unit axes in its plane, `u` toward `a`. */
function circleOf(a: Vec3, b: Vec3, c: Vec3) {
  const ab = [0, 1, 2].map((k) => b[k] - a[k]),
    ac = [0, 1, 2].map((k) => c[k] - a[k]);
  const n = crossOf(ab, ac);
  const nn = dot(n, n);
  if (!(nn > 1e-18)) return null;
  // Circumcentre: a + (|ac|^2 (n x ab) + |ab|^2 (ac x n)) / (2 |n|^2).
  const [p, q] = [crossOf(n, ab), crossOf(ac, n)];
  const centre = [0, 1, 2].map((k) => a[k] + (dot(ac, ac) * p[k] + dot(ab, ab) * q[k]) / (2 * nn));
  const radius = Math.hypot(a[0] - centre[0], a[1] - centre[1], a[2] - centre[2]);
  const u = unit([0, 1, 2].map((k) => a[k] - centre[k]));
  const v = crossOf(unit(n), u);
  return { centre, radius, u, v };
}

/**
 * An arc closed on itself, split into arcs of at most a third of a turn so each can be read as a
 * band: through the three clicked points, then the points between. Null when they are collinear.
 */
function splitCircle(mesh: RefineMesh, topology: RefineTopology, points: GuidePoint[]) {
  if (points.length !== 3) return null;
  const circle = circleOf(points[0].position, points[1].position, points[2].position);
  if (!circle) return null;
  const { centre, radius, u, v } = circle;
  const { position } = mesh;
  const angleOf = (p: Vec3) => {
    const d = [0, 1, 2].map((k) => p[k] - centre[k]);
    const angle = Math.atan2(dot(d, v), dot(d, u));
    return angle < 0 ? angle + 2 * Math.PI : angle;
  };
  // A point on the circle, clicked on a triangle of the welded vertex nearest it.
  const clicked = (angle: number): GuidePoint => {
    const p = [0, 1, 2].map(
      (k) => centre[k] + radius * (Math.cos(angle) * u[k] + Math.sin(angle) * v[k]),
    ) as Vec3;
    let nearest = 0,
      best = Infinity;
    for (let w = 0; w < mesh.weldedCount; w++) {
      const d = Math.hypot(
        position[w * 3] - p[0],
        position[w * 3 + 1] - p[1],
        position[w * 3 + 2] - p[2],
      );
      if (d < best) [best, nearest] = [d, w];
    }
    return { triangle: topology.trianglesOf[topology.triangleStart[nearest]], position: p };
  };
  const stops = [0, angleOf(points[1].position), angleOf(points[2].position), 2 * Math.PI];
  const ends = [points[0], points[1], points[2], points[0]];
  const arcs: EdgeSegment[] = [];
  for (let k = 0; k < 3; k++) {
    const pieces = Math.ceil((stops[k + 1] - stops[k]) / ((2 * Math.PI) / 3) - 1e-9);
    let from = ends[k];
    for (let j = 1; j <= pieces; j++) {
      const a0 = stops[k] + ((stops[k + 1] - stops[k]) * (j - 1)) / pieces,
        a1 = stops[k] + ((stops[k + 1] - stops[k]) * j) / pieces;
      const to = j === pieces ? ends[k + 1] : clicked(a1);
      arcs.push({ kind: 'arc', points: [from, clicked((a0 + a1) / 2), to] });
      from = to;
    }
  }
  return arcs;
}

/**
 * Whether the path's edge goes on past its end at the guide's point `which` (0 first, 1 last) of
 * `part`: `taper` when the edge continues past it and no vertex already creased by an earlier
 * restore lies within two edge lengths of the end, else `hold`.
 */
function endOf(mesh: RefineMesh, topology: RefineTopology, part: Part, which: 0 | 1): EdgeEnd {
  const { band, flanks, curve, edge } = part;
  const span = guideSpan(curve, band.drawn, edge);
  const station = span.stations[which];
  const direction = station >= span.stations[1 - which] ? 1 : -1;
  if (!continues(mesh, topology, band, flanks, curve, station, direction, edge)) return 'hold';
  const at = new Float64Array(3);
  curveAt(curve, station, at);
  return creasedNear(mesh, at, 2 * edge) ? 'hold' : 'taper';
}

/** True when a welded vertex with `crease` lies within `reach` of `point`. */
function creasedNear(mesh: RefineMesh, point: ArrayLike<number>, reach: number) {
  const { position, crease } = mesh;
  for (let v = 0; v < mesh.weldedCount; v++)
    if (
      crease[v] &&
      Math.hypot(
        position[v * 3] - point[0],
        position[v * 3 + 1] - point[1],
        position[v * 3 + 2] - point[2],
      ) <= reach
    )
      return true;
  return false;
}

/**
 * Solves a path of one or more segments, open or closed. Each segment is solved as a single edge;
 * neighbouring flanks that are one surface are refitted as one; the solved curves are joined at the
 * joints, sharp or smooth. A closed path of one arc is a full circle. Null when a segment shows no
 * edge, or when the width leaves no usable core: fewer than `coreEdges` edge lengths of the edge at
 * full weight, or no fully weighted vertex on a flank.
 */
export function solveEdge(
  mesh: RefineMesh,
  topology: RefineTopology,
  input: EdgeInput,
  noise: number,
): EdgeSolve | null {
  const { closed } = input;
  const count = input.segments.length;
  if (!count || input.joints.length !== (closed ? count : count - 1)) return null;
  const circle = closed && count === 1;
  if (circle && input.segments[0].kind !== 'arc') return null;
  const segments = circle ? splitCircle(mesh, topology, input.segments[0].points) : input.segments;
  if (!segments) return null;
  const joints: GuideJoint[] = circle ? segments.map(() => 'smooth') : input.joints;
  let width = input.width;
  if (width === null) {
    width = 0;
    for (const { kind, points } of segments) {
      const estimate = estimateWidth(mesh, topology, kind, points, noise);
      if (!(estimate > 0)) return null;
      width = Math.max(width, estimate);
    }
  }
  if (!(width > 0)) return null;
  const parts: Part[] = [];
  for (const { kind, points } of segments) {
    const part = solvePart(mesh, topology, kind, points, width, noise);
    if (!part) return null;
    parts.push(part);
  }
  const n = parts.length;
  if (n > 1 && !clearCorners(parts, joints, width, noise)) return null;
  if (n > 1 && !shareFlanks(parts, closed, width, noise)) return null;
  const edge = median(parts.map((part) => part.edge));

  let curve: EdgeCurve;
  let bounds: number[];
  if (n === 1) {
    curve = parts[0].curve;
    bounds = [0, curveLength(curve)];
  } else if (circle) {
    curve = fitCurve(
      'arc',
      Float64Array.from(parts.flatMap((part) => [...part.meet.points])),
      3,
      edge,
    );
    if (!curve.closed) return null;
    const total = pathLength(curve);
    const at = new Float64Array(3);
    bounds = segments.map(({ points: [{ position: p }] }) =>
      closestOnCurve(curve, p[0], p[1], p[2], at),
    );
    for (let i = 1; i < n; i++) while (bounds[i] < bounds[i - 1]) bounds[i] += total;
    bounds.push(bounds[0] + total);
  } else {
    const curves = parts.map((part) => part.curve);
    const kinds = parts.map((part) => part.kind);
    curve = joinCurves(curves, kinds, joints, closed, edge);
    // The same join with every joint marked, to find where each segment's stretch starts.
    const marked = joinCurves(
      curves,
      kinds,
      joints.map(() => 'sharp'),
      closed,
      edge,
    );
    if (marked.points.length !== curve.points.length) return null;
    const starts: number[] = [];
    marked.corner.forEach((c, k) => c && starts.push(curve.lengths[k]));
    if (starts.length !== (closed ? n : n - 1)) return null;
    bounds = closed
      ? [...starts, starts[0] + pathLength(curve)]
      : [0, ...starts, curveLength(curve)];
  }

  const ends: [EdgeEnd, EdgeEnd] = closed
    ? ['hold', 'hold']
    : [endOf(mesh, topology, parts[0], 0), endOf(mesh, topology, parts[n - 1], 1)];
  const solve: EdgeSolve = {
    bands: parts.map((part) => part.band),
    flanks: parts.map((part) => part.flanks),
    curve,
    sign: Int8Array.from(parts, (part) =>
      edgeSign(mesh, topology, part.band, part.flanks, part.meet.points, part.edge),
    ),
    width,
    deviation: Math.max(
      ...parts.map((part) => largestGap(part.curve, part.band.drawn, part.meet.points, part.edge)),
    ),
    ends,
    joints,
    bounds: Float64Array.from(bounds),
  };
  const frame = frameOf(mesh, topology, solve);
  return usableCore(mesh, solve, frame, frameWeights(mesh, topology, solve, frame)) ? solve : null;
}

/** A joint of a solved path. */
interface Joint {
  sharp: boolean;
  station: number;
  point: number[];
  /** Unit directions of the curve arriving at and leaving the joint, and the mitre between them. */
  before: number[];
  after: number[];
  mitre: number[];
  /** The segments it joins. */
  from: number;
  to: number;
  soft: number;
  /** Per side, whether the two segments' flanks there are different faces meeting in an edge. */
  apart: [boolean, boolean];
  /**
   * At a sharp joint, the side whose flanks are one face when the other side's are two: the joint is
   * the corner of three faces. Else -1.
   */
  shared: number;
}

/** What `moveWeights`, `applyEdge` and `correctedFlanks` read of a solved path. */
interface Frame {
  /** Every band's welded vertices, each once, in order of first appearance. */
  vertices: Uint32Array;
  index: Map<number, number>;
  /** Per vertex: the segment whose stretch of the curve is nearest, and its zone in that band. */
  owner: Int32Array;
  zone: Uint8Array;
  /** Per vertex: 1 where a corner holds it still, and 1 where it is cut but not moved. */
  held: Uint8Array;
  pinned: Uint8Array;
  edge: number;
  /** Each segment's stretch of the curve. */
  pieces: EdgeCurve[];
  joints: Joint[];
  /** The sharp joints. */
  corners: Joint[];
  /** The segment whose stretch of the curve is nearest a point. */
  ownerAt(x: number, y: number, z: number): number;
}

function frameOf(mesh: RefineMesh, topology: RefineTopology, solve: EdgeSolve): Frame {
  const { bands, curve, bounds, joints } = solve;
  const n = bands.length;
  const { position } = mesh;
  const total = pathLength(curve);
  const at = new Float64Array(3);
  const ownerAt =
    n === 1
      ? () => 0
      : (x: number, y: number, z: number) => {
          let s = closestOnCurve(curve, x, y, z, at);
          if (curve.closed && s < bounds[0]) s += total;
          let i = 0;
          while (i < n - 1 && s >= bounds[i + 1]) i++;
          return i;
        };
  const pieces =
    n === 1 && !curve.closed
      ? [curve]
      : bands.map((_, i) => pieceOf(curve, bounds[i], bounds[i + 1]));
  const all: Joint[] = joints.map((joint, k) => {
    const station = bounds[k + 1];
    pathPoint(curve, station, at);
    const point = [at[0], at[1], at[2]];
    const [from, to] = [k, (k + 1) % n];
    // Directions read a soft half-width either side, past any short bridge the join put in.
    const reach = Math.max(bands[from].soft, bands[to].soft);
    const p = new Float64Array(3),
      q = new Float64Array(3);
    pathPoint(curve, station - reach, p);
    pathPoint(curve, station + reach, q);
    const before = unit([0, 1, 2].map((a) => point[a] - p[a]));
    const after = unit([0, 1, 2].map((a) => q[a] - point[a]));
    const apart = [0, 1].map((side) => {
      const [f, g] = [solve.flanks[from][side], solve.flanks[to][side]];
      if (joint !== 'sharp' || f === g) return false;
      const [a, b] = [unit(gradient(f, point)), unit(gradient(g, point))];
      return (Math.acos(Math.min(1, Math.abs(dot(a, b)))) * 180) / Math.PI >= minBandAngle;
    }) as [boolean, boolean];
    return {
      sharp: joint === 'sharp',
      station,
      point,
      before,
      after,
      mitre: unit([0, 1, 2].map((a) => before[a] + after[a])),
      from,
      to,
      soft: Math.max(bands[from].soft, bands[to].soft),
      apart,
      shared: apart[0] !== apart[1] ? +apart[0] : -1,
    };
  });
  const corners = all.filter((joint) => joint.sharp);
  const index = new Map<number, number>();
  const places: number[][] = [];
  bands.forEach((band, b) =>
    band.vertices.forEach((v, i) => {
      let k = index.get(v);
      if (k === undefined) {
        k = places.length;
        index.set(v, k);
        places.push([]);
      }
      places[k].push(b, i);
    }),
  );
  // A joint takes in the vertices around it, out to the band's width, that no band may move: no band
  // reaches past its guide's end, and a band's own end, or a corner's rounding, may be Beyond.
  const patch: number[] = places.map(() => -1);
  all.forEach((joint, c) => {
    const near = (v: number) =>
      Math.hypot(
        position[v * 3] - joint.point[0],
        position[v * 3 + 1] - joint.point[1],
        position[v * 3 + 2] - joint.point[2],
      ) <= solve.width;
    const queue = [...index.keys()].filter(near);
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head];
      for (let j = topology.neighbourStart[v]; j < topology.neighbourStart[v + 1]; j++) {
        const w = topology.neighbours[j];
        if (index.has(w) || !near(w)) continue;
        index.set(w, places.length);
        places.push([]);
        patch.push(-1);
        queue.push(w);
      }
    }
    for (const v of queue) if (patch[index.get(v)!] < 0) patch[index.get(v)!] = c;
  });
  // At an open end tied to an edge restored earlier, the vertices out to the band's width that are
  // reached from the band beyond that reach without crossing the earlier edge's creased vertices are
  // taken in, those creased vertices too; any there not reached lie across the earlier edge.
  const tied: number[] = places.map(() => 0);
  if (!curve.closed)
    [0, 1].forEach((which) => {
      if (solve.ends[which] !== 'hold') return;
      const band = bands[which ? n - 1 : 0];
      const drawn = band.drawn.points;
      const k = which ? drawn.length - 3 : 0;
      onCurve(curve, drawn[k], drawn[k + 1], drawn[k + 2], at);
      const end = [at[0], at[1], at[2]];
      if (!creasedNear(mesh, end, 2 * bandEdgeLength(mesh, topology, band))) return;
      const near = (v: number) =>
        Math.hypot(
          position[v * 3] - end[0],
          position[v * 3 + 1] - end[1],
          position[v * 3 + 2] - end[2],
        ) <= solve.width;
      const mark = (v: number, state: number) => {
        let k = index.get(v);
        if (k === undefined) {
          k = places.length;
          index.set(v, k);
          places.push([]);
          patch.push(-1);
          tied.push(0);
        }
        tied[k] = state;
      };
      const queue = [...band.vertices].filter((v) => !near(v) && !mesh.crease[v]);
      const seen = new Set(queue);
      for (let head = 0; head < queue.length; head++) {
        const v = queue[head];
        for (let j = topology.neighbourStart[v]; j < topology.neighbourStart[v + 1]; j++) {
          const w = topology.neighbours[j];
          if (seen.has(w) || !near(w)) continue;
          seen.add(w);
          mark(w, 1);
          if (!mesh.crease[w]) queue.push(w);
        }
      }
      for (const v of band.vertices) if (near(v) && !seen.has(v)) mark(v, 2);
    });
  const vertices = Uint32Array.from(index.keys());
  const owner = Int32Array.from(vertices, (v) =>
    ownerAt(position[v * 3], position[v * 3 + 1], position[v * 3 + 2]),
  );
  const held = new Uint8Array(vertices.length);
  const pinned = new Uint8Array(vertices.length);
  // A vertex takes its zone in its owner's band; one outside that band, its first zone elsewhere
  // that is not Beyond. A joint's vertex that no band moves is Soft: at a corner of three faces
  // within the soft half-width of the face the segments share, below that held, the rounding
  // between the two faces they do not share left as it is; elsewhere within `cornerClear` soft
  // half-widths of the solved edge. At a tied end the earlier edge's creased vertices join the cut
  // but stay where they are.
  const zone = Uint8Array.from(places, (list, k) => {
    let found: number = BandZone.Beyond;
    for (let j = 0; j < list.length; j += 2) {
      const z = bands[list[j]].zone[list[j + 1]];
      if (list[j] === owner[k]) {
        found = z;
        break;
      }
      if (found === BandZone.Beyond) found = z;
    }
    const joint = all[patch[k]];
    patch[k] = -1;
    const v = vertices[k];
    if (tied[k] === 2) return BandZone.Beyond;
    if (tied[k] && mesh.crease[v]) {
      pinned[k] = 1;
      return BandZone.Soft;
    }
    if (found !== BandZone.Beyond || !(joint || tied[k])) return found;
    const p = [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]];
    if (!joint) {
      onCurve(curve, p[0], p[1], p[2], at);
      const off = Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]);
      return off <= cornerClear * Math.max(...bands.map((band) => band.soft))
        ? BandZone.Soft
        : BandZone.Beyond;
    }
    if (joint.shared >= 0) {
      const depth = solve.flanks[joint.from][joint.shared].distance(p[0], p[1], p[2]);
      if (depth <= joint.soft) return BandZone.Soft;
      held[k] = 1;
      return BandZone.Beyond;
    }
    onCurve(curve, p[0], p[1], p[2], at);
    const off = Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]);
    return off <= cornerClear * joint.soft ? BandZone.Soft : BandZone.Beyond;
  });
  const edge = median(bands.map((band) => bandEdgeLength(mesh, topology, band)));
  return {
    vertices,
    index,
    owner,
    zone,
    held,
    pinned,
    edge,
    pieces,
    joints: all,
    corners,
    ownerAt,
  };
}

/**
 * True when at least `coreEdges` edge lengths of the edge, unbroken, have a vertex of full weight in
 * the soft zone or as near the edge as the soft zone is wide, and each side has a vertex of full
 * weight on its flank.
 */
function usableCore(mesh: RefineMesh, solve: EdgeSolve, frame: Frame, weights: Float64Array) {
  const { position } = mesh;
  const { edge } = frame;
  const near = Math.max(Math.max(...solve.bands.map((band) => band.soft)), 2 * edge);
  const sides = [false, false];
  const stations: number[] = [];
  const at = new Float64Array(3);
  frame.vertices.forEach((v, k) => {
    if (weights[k] < 1) return;
    const zone = frame.zone[k];
    if (zone === BandZone.Left) sides[0] = true;
    if (zone === BandZone.Right) sides[1] = true;
    const station = onCurve(
      solve.curve,
      position[v * 3],
      position[v * 3 + 1],
      position[v * 3 + 2],
      at,
    );
    const d = Math.hypot(
      position[v * 3] - at[0],
      position[v * 3 + 1] - at[1],
      position[v * 3 + 2] - at[2],
    );
    if (zone === BandZone.Soft || d <= near) stations.push(station);
  });
  if (!sides[0] || !sides[1] || !stations.length) return false;
  stations.sort((a, b) => a - b);
  let from = stations[0],
    longest = 0;
  for (let k = 1; k < stations.length; k++) {
    if (stations[k] - stations[k - 1] > 2 * edge) from = stations[k];
    longest = Math.max(longest, stations[k] - from);
  }
  // Each vertex stands for half an edge length of the edge either side of it.
  return longest + edge >= coreEdges * edge;
}

/**
 * Per frame vertex, the share of its full move it makes at strength 1: smoothstep of its distance
 * over the surface from the nearest vertex that does not move (outside every band, or Beyond), over
 * a blend of half the band's width held between 2 and 4 edge lengths. At an open path's end that
 * tapers, also smoothstep of its distance along the edge from that end over the taper.
 */
function frameWeights(mesh: RefineMesh, topology: RefineTopology, solve: EdgeSolve, frame: Frame) {
  const { curve, bands } = solve;
  const { position } = mesh;
  const { vertices, edge } = frame;
  const count = vertices.length;
  const indexOf = new Map<number, number>();
  for (let i = 0; i < count; i++)
    if (frame.zone[i] !== BandZone.Beyond) indexOf.set(vertices[i], i);
  const length = (v: number, w: number) =>
    Math.hypot(
      position[v * 3] - position[w * 3],
      position[v * 3 + 1] - position[w * 3 + 1],
      position[v * 3 + 2] - position[w * 3 + 2],
    );
  // Shortest paths over mesh edges from the vertices that stay into the editable ones.
  const reach = new Float64Array(count).fill(Infinity);
  const queue: number[] = [];
  // A vertex a corner holds still does not move by design, so it does not fade its neighbours.
  const seeds = (w: number) => !indexOf.has(w) && !frame.held[frame.index.get(w) ?? -1];
  for (const [v, i] of indexOf)
    for (let j = topology.neighbourStart[v]; j < topology.neighbourStart[v + 1]; j++) {
      const w = topology.neighbours[j];
      // An earlier edge's creased vertex stands between what is fixed beyond it and what moves.
      if (!seeds(w) || frame.pinned[i]) continue;
      if (reach[i] === Infinity) queue.push(i);
      reach[i] = Math.min(reach[i], length(v, w));
    }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head],
      v = vertices[i];
    for (let j = topology.neighbourStart[v]; j < topology.neighbourStart[v + 1]; j++) {
      const w = topology.neighbours[j];
      const k = indexOf.get(w);
      if (k === undefined) continue;
      const d = reach[i] + length(v, w);
      if (d < reach[k]) {
        reach[k] = d;
        queue.push(k);
      }
    }
  }
  const blend = Math.max(blendEdges[0] * edge, Math.min(solve.width / 2, blendEdges[1] * edge));
  const tapering = solve.ends.filter((end) => end === 'taper').length;
  const first = bands[0].drawn.points,
    last = bands[bands.length - 1].drawn.points;
  const at = new Float64Array(3);
  const stations = [
    onCurve(curve, first[0], first[1], first[2], at),
    onCurve(curve, last[last.length - 3], last[last.length - 2], last[last.length - 1], at),
  ];
  const taper = taperOf(Math.abs(stations[1] - stations[0]), edge, tapering);
  // Around a joint the vertices move in full out to half the band's width, so the faces meeting
  // there stay whole where no band holds them, then fade out by the band's width.
  const cornered = frame.joints;
  const cornerWeight = (v: number) => {
    let weight = 0;
    for (const { point } of cornered) {
      const r = Math.hypot(
        position[v * 3] - point[0],
        position[v * 3 + 1] - point[1],
        position[v * 3 + 2] - point[2],
      );
      weight = Math.max(weight, 1 - smooth((2 * r) / solve.width - 1));
    }
    return weight;
  };
  return Float64Array.from(reach, (d, i) => {
    const v = vertices[i];
    if (!indexOf.has(v)) return 0;
    let weight = Math.max(smooth(d / blend), cornered.length ? cornerWeight(v) : 0);
    if (curve.closed || !tapering || !(taper > 0)) return weight;
    const station = onCurve(curve, position[v * 3], position[v * 3 + 1], position[v * 3 + 2], at);
    stations.forEach((end, k) => {
      if (solve.ends[k] !== 'taper') return;
      const inward = end <= stations[1 - k] ? station - end : end - station;
      weight *= smooth(inward / taper);
    });
    return weight;
  });
}

/**
 * Per band vertex, bands in order, the share of its full move it makes at strength 1 (see
 * `frameWeights`); a vertex in several bands has one weight. 0 for a vertex that does not move.
 */
export function moveWeights(mesh: RefineMesh, topology: RefineTopology, solve: EdgeSolve) {
  const frame = frameOf(mesh, topology, solve);
  const weights = frameWeights(mesh, topology, solve, frame);
  return Float64Array.from(
    solve.bands.flatMap((band) => [...band.vertices]),
    (v) => weights[frame.index.get(v)!],
  );
}

/**
 * A flank's corrected surface: the flank plus the offset that carries the flanks' own meet onto
 * `curve`, the segment's stretch of the solved edge, faded by smoothstep from the meet out to that
 * flank's own start. Both surfaces pass through the solved edge.
 */
function correctedSurfaces(
  mesh: RefineMesh,
  band: EdgeBand,
  flanks: [Flank, Flank],
  curve: EdgeCurve,
  width: number,
  edge: number,
) {
  const { position } = mesh;
  const meet = meetFlanks(band, flanks, width).points;
  const at = new Float64Array(3);
  const samples = Array.from({ length: meet.length / 3 }, (_, k) => {
    const p = [meet[k * 3], meet[k * 3 + 1], meet[k * 3 + 2]];
    const station = onCurve(curve, p[0], p[1], p[2], at);
    return { station, p, correction: [at[0] - p[0], at[1] - p[1], at[2] - p[2]] };
  });
  samples.sort((a, b) => a.station - b.station);
  const stations = samples.map((s) => s.station);
  const meets = samples.flatMap((s) => s.p);
  const corrections = samples.flatMap((s) => s.correction);
  const m = [0, 0, 0],
    c = [0, 0, 0];
  // Distance of a flank point from the meet at its station, leaving that station's offset in `c`.
  const fromMeet = (x: number, y: number, z: number) => {
    const station = onCurve(curve, x, y, z, at);
    interpolate(stations, meets, station, m);
    interpolate(stations, corrections, station, c);
    return { station, r: Math.hypot(x - m[0], y - m[1], z - m[2]) };
  };
  // Each flank's own start: per stretch of 4 edge lengths the nearest of its vertices to the meet,
  // the median over the stretches, at least 2 edge lengths.
  const q = new Float32Array(3);
  const starts = [BandZone.Left, BandZone.Right].map((zone, s) => {
    const nearest = new Map<number, number>();
    band.vertices.forEach((v, i) => {
      if (band.zone[i] !== zone) return;
      flanks[s].project(position[v * 3], position[v * 3 + 1], position[v * 3 + 2], q);
      const { station, r } = fromMeet(q[0], q[1], q[2]);
      const bin = Math.floor(station / (4 * edge));
      nearest.set(bin, Math.min(nearest.get(bin) ?? Infinity, r));
    });
    return Math.max(2 * edge, nearest.size ? median([...nearest.values()]) : band.soft);
  });
  // The offset of side s at the flank point q, into `out`.
  const offset = (s: number, out: number[]) => {
    const f = 1 - smooth(fromMeet(q[0], q[1], q[2]).r / starts[s]);
    for (let a = 0; a < 3; a++) out[a] = f * c[a];
  };
  const d = [0, 0, 0];
  return {
    /** The point of side s's corrected surface over (x, y, z)'s projection onto its flank. */
    target(s: number, x: number, y: number, z: number, out: number[]) {
      flanks[s].project(x, y, z, q);
      offset(s, d);
      for (let a = 0; a < 3; a++) out[a] = q[a] + d[a];
    },
    /** Distance from (x, y, z) to side s's corrected surface, unsigned. */
    distance(s: number, x: number, y: number, z: number) {
      const p = [x, y, z];
      flanks[s].project(x, y, z, q);
      for (let iteration = 0; iteration < 4; iteration++) {
        offset(s, d);
        flanks[s].project(p[0] - d[0], p[1] - d[1], p[2] - d[2], q);
      }
      return flanks[s].distance(p[0] - d[0], p[1] - d[1], p[2] - d[2]);
    },
  };
}
type Surfaces = ReturnType<typeof correctedSurfaces>;

/** Each segment's corrected surfaces, made when first asked for. */
function surfacesOf(mesh: RefineMesh, topology: RefineTopology, solve: EdgeSolve, frame: Frame) {
  const made: (Surfaces | undefined)[] = solve.bands.map(() => undefined);
  return (i: number) =>
    (made[i] ??= correctedSurfaces(
      mesh,
      solve.bands[i],
      solve.flanks[i],
      frame.pieces[i],
      solve.width,
      bandEdgeLength(mesh, topology, solve.bands[i]),
    ));
}

/**
 * Exported for the tests: each side's corrected surface, as `applyEdge` moves the band onto it, read
 * from the segment whose stretch of the curve is nearest the point.
 */
export function correctedFlanks(mesh: RefineMesh, topology: RefineTopology, solve: EdgeSolve) {
  const frame = frameOf(mesh, topology, solve);
  const surfaces = surfacesOf(mesh, topology, solve, frame);
  return [0, 1].map(
    (s) => (x: number, y: number, z: number) =>
      surfaces(frame.ownerAt(x, y, z)).distance(s, x, y, z),
  );
}

/**
 * The point on the solved edge a point of the cut goes to: the nearest, except near a sharp joint,
 * where the station is drawn toward the joint as the point nears the mitre between the two
 * segments, so the cut's point on the mitre lands on the corner itself.
 */
function placerOf(solve: EdgeSolve, frame: Frame) {
  const { curve } = solve;
  const total = pathLength(curve);
  const reach = jointReach * solve.width;
  return (x: number, y: number, z: number, out: Float64Array) => {
    const s = onCurve(curve, x, y, z, out);
    for (const corner of frame.corners) {
      let along = s - corner.station;
      if (curve.closed) along -= total * Math.round(along / total);
      if (Math.abs(along) > reach) continue;
      const sign = along > 0 ? 1 : -1;
      const r = [x - corner.point[0], y - corner.point[1], z - corner.point[2]];
      const toward = sign > 0 ? corner.after : corner.before;
      const mitre = Math.max(0, (sign * dot(corner.mitre, r)) / dot(corner.mitre, toward));
      const pull = 1 - smooth(mitre / corner.soft);
      const from = Math.abs(along);
      pathPoint(curve, corner.station + sign * (from - pull * (from - mitre)), out);
      return;
    }
  };
}

/**
 * The share of its move a vertex of segment `owner` keeps on side `side`. At a sharp joint where the
 * neighbouring segment's flank on that side is a different face, the edge between the two faces is
 * not sharpened: the move fades by smoothstep over the soft half-width of how much farther the
 * vertex lies from the neighbour's flank than from its own, so it is 0 where the two are equally far.
 */
function cornerFade(solve: EdgeSolve, frame: Frame, owner: number, side: number, p: number[]) {
  let fade = 1;
  for (const corner of frame.corners) {
    if (!corner.apart[side] || (corner.from !== owner && corner.to !== owner)) continue;
    const near = Math.hypot(p[0] - corner.point[0], p[1] - corner.point[1], p[2] - corner.point[2]);
    if (near > jointReach * solve.width) continue;
    const flank = solve.flanks[corner.from === owner ? corner.to : corner.from][side];
    const other = flank.distance(p[0], p[1], p[2]);
    fade *= smooth((other - solve.flanks[owner][side].distance(p[0], p[1], p[2])) / corner.soft);
    if (corner.shared < 0) continue;
    // Below the face the segments share, the rounding between the two faces is left as it is, out to
    // `cornerClear` soft half-widths from the neighbour's flank.
    const depth = solve.flanks[owner][corner.shared].distance(p[0], p[1], p[2]);
    fade *= Math.max(
      1 - smooth((2 * depth) / corner.soft - 1),
      smooth(other / corner.soft - cornerClear),
    );
  }
  return fade;
}

/**
 * The outward normal a cut child on `side` at (x, y, z) should have, into `out`: that of its
 * segment's flank, or near a sharp joint whose two flanks on that side are different faces, that of
 * the nearer one, and between the two the normal halfway between theirs, as on the rounding of the
 * edge the two faces meet in.
 */
function facingAt(
  solve: EdgeSolve,
  frame: Frame,
  x: number,
  y: number,
  z: number,
  side: number,
  out: Float64Array,
) {
  const owner = frame.ownerAt(x, y, z);
  const p = [x, y, z];
  let normal = unit(gradient(solve.flanks[owner][side], p));
  for (const corner of frame.corners) {
    if (!corner.apart[side] || (corner.from !== owner && corner.to !== owner)) continue;
    const [px, py, pz] = corner.point;
    if (Math.hypot(x - px, y - py, z - pz) > jointReach * solve.width) continue;
    const own = solve.flanks[owner][side];
    const other = solve.flanks[corner.from === owner ? corner.to : corner.from][side];
    const [near, far] = [own.distance(x, y, z), other.distance(x, y, z)];
    if (far < cornerClear * corner.soft && near < cornerClear * corner.soft) {
      const [a, b] = [unit(gradient(own, p)), unit(gradient(other, p))];
      normal = unit([0, 1, 2].map((k) => a[k] + b[k]));
    } else if (far < near) normal = unit(gradient(other, p));
  }
  out[0] = normal[0];
  out[1] = normal[1];
  out[2] = normal[2];
}

/**
 * Moves the bands onto the flanks' corrected surfaces, each vertex by `strength` times its
 * `moveWeights` share of its full move. With `cut`, also puts one chain of mesh edges along the
 * whole path wherever the weight is above `cutWeight`, each moved toward the solved edge by its
 * weight, and marks those of at least `creaseWeight` as a crease (mesh must be a topology clone).
 * At strength 0 nothing moves and nothing is cut.
 */
export function applyEdge(
  mesh: RefineMesh,
  topology: RefineTopology,
  solve: EdgeSolve,
  strength: number,
  cut: boolean,
): EdgeResult {
  if (!(strength > 0)) return { changed: empty, cut: null, skipped: empty, folded: empty };
  const { position } = mesh;
  const frame = frameOf(mesh, topology, solve);
  const { edge } = frame;
  const count = frame.vertices.length;
  const indexOf = new Map<number, number>();
  for (let i = 0; i < count; i++)
    if (frame.zone[i] !== BandZone.Beyond) indexOf.set(frame.vertices[i], i);
  const surfaces = surfacesOf(mesh, topology, solve, frame);
  const weights = frameWeights(mesh, topology, solve, frame);

  const move = new Float64Array(count * 3);
  const moved = new Uint8Array(count);
  // Per vertex, the cut's field: its start's distance from where the corrected surfaces are equally
  // far, signed by the side it moves to.
  const apartAt = new Float64Array(count);
  const target = [0, 0, 0];
  for (const [v, i] of indexOf) {
    const p = [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]];
    const weight = strength * weights[i];
    if (!(weight > 0)) continue;
    const owner = frame.owner[i];
    const flanks = solve.flanks[owner];
    const zone = frame.zone[i];
    const side =
      zone === BandZone.Left
        ? 0
        : zone === BandZone.Right
          ? 1
          : +(flanks[1].distance(p[0], p[1], p[2]) < flanks[0].distance(p[0], p[1], p[2]));
    const surface = surfaces(owner);
    // The cut reads where the vertex was, signed by the side it moves to: vertices near the middle of
    // the rounding stay near the zero set and snap to it rather than pass each other on the way out.
    const apart = surface.distance(0, p[0], p[1], p[2]) - surface.distance(1, p[0], p[1], p[2]);
    apartAt[i] = side ? Math.abs(apart) : -Math.abs(apart);
    surface.target(side, p[0], p[1], p[2], target);
    if (frame.pinned[i]) {
      // On the zero set already, so the cut takes it as it is.
      apartAt[i] = 0;
      moved[i] = 2;
      continue;
    }
    let share = weight;
    if (frame.corners.length) share *= cornerFade(solve, frame, owner, side, p);
    for (let a = 0; a < 3; a++) move[i * 3 + a] = share * (target[a] - p[a]);
    moved[i] = +(move[i * 3] !== 0 || move[i * 3 + 1] !== 0 || move[i * 3 + 2] !== 0);
  }
  const before = position.slice(0, mesh.weldedCount * 3);
  const changed: number[] = [];
  for (const [v, i] of indexOf) {
    if (moved[i] !== 1) continue;
    moveVertex(
      mesh,
      v,
      position[v * 3] + move[i * 3],
      position[v * 3 + 1] + move[i * 3 + 1],
      position[v * 3 + 2] + move[i * 3 + 2],
    );
    changed.push(v);
  }
  const folded = foldedTriangles(mesh, topology, before, Uint32Array.from(changed));
  if (!cut) return { changed: Uint32Array.from(changed), cut: null, skipped: empty, folded };

  // One cut runs along the whole path, among vertices of more than `cutWeight`; each point on it
  // moves toward the solved edge by its own weight, so the edge's sharpness fades with the weight.
  const cutting: number[] = [];
  for (const [v, i] of indexOf) if (moved[i] && weights[i] > cutWeight) cutting.push(v);
  const vertices = Uint32Array.from(cutting);
  const field = new Float32Array(vertices.length);
  const cells = new Map<number, number[]>();
  const cellOf = (x: number, y: number, z: number) =>
    Math.imul(Math.floor(x / edge), 73856093) ^
    Math.imul(Math.floor(y / edge), 19349663) ^
    Math.imul(Math.floor(z / edge), 83492791);
  vertices.forEach((v, k) => {
    const [x, y, z] = [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]];
    field[k] = apartAt[indexOf.get(v)!];
    const key = cellOf(x, y, z);
    const list = cells.get(key);
    if (list) list.push(v);
    else cells.set(key, [v]);
  });
  // The weight at a point: the cut vertices' weights within an edge length of it, averaged by
  // inverse distance, else the nearest one's.
  const weightAt = (x: number, y: number, z: number) => {
    let best = Infinity,
      nearest = 0,
      sum = 0,
      total = 0;
    // The cells around the point, then further rings out until one holds a cut vertex.
    for (let ring = 1; ring <= weightRings && best === Infinity; ring++)
      for (let dx = -ring; dx <= ring; dx++)
        for (let dy = -ring; dy <= ring; dy++)
          for (let dz = -ring; dz <= ring; dz++) {
            if (ring > 1 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) < ring) continue;
            for (const v of cells.get(cellOf(x + dx * edge, y + dy * edge, z + dz * edge)) ?? []) {
              const p = mesh.position;
              const d = Math.hypot(p[v * 3] - x, p[v * 3 + 1] - y, p[v * 3 + 2] - z);
              const w = weights[indexOf.get(v)!];
              if (d <= edge) {
                if (d === 0) return w;
                sum += w / d;
                total += 1 / d;
              }
              if (d < best) {
                best = d;
                nearest = w;
              }
            }
          }
    return total > 0 ? sum / total : nearest;
  };

  // Corners of the triangles around the cut, so that their children can be checked against them.
  const parents = new Map<number, number[]>();
  for (const v of vertices)
    for (let j = topology.triangleStart[v]; j < topology.triangleStart[v + 1]; j++) {
      const t = topology.trianglesOf[j];
      if (!parents.has(t))
        parents.set(
          t,
          [0, 1, 2].map((k) => weldedCorner(mesh, t, k as 0 | 1 | 2)),
        );
    }
  const on = new Float64Array(3);
  const pathPlace = placerOf(solve, frame);
  const kept: number[] = [];
  for (const [v, i] of indexOf) if (frame.pinned[i]) kept.push(v);
  // An earlier edge's creased vertex stays where it is.
  const place = (x: number, y: number, z: number, out: Float64Array) => {
    for (const v of kept)
      if (x === position[v * 3] && y === position[v * 3 + 1] && z === position[v * 3 + 2]) {
        out[0] = x;
        out[1] = y;
        out[2] = z;
        return;
      }
    pathPlace(x, y, z, out);
  };
  const placer = (x: number, y: number, z: number, out: Float32Array) => {
    place(x, y, z, on);
    const weight = strength * weightAt(x, y, z);
    out[0] = x + weight * (on[0] - x);
    out[1] = y + weight * (on[1] - y);
    out[2] = z + weight * (on[2] - z);
  };
  // A child faces outward from its segment's flank on its side: the field is positive nearer side 1.
  const facing = (x: number, y: number, z: number, side: 1 | -1, out: Float64Array) =>
    facingAt(solve, frame, x, y, z, side > 0 ? 1 : 0, out);
  // A path's one chain breaks wherever a triangle is left straddling it. Which vertices the cutter
  // snaps onto the chain decides that, so a path tries each snap in turn on a copy and keeps the
  // first that leaves nothing straddling, else the one that leaves least.
  let snap = pathSnaps[0];
  if (solve.bands.length > 1 || solve.curve.closed) {
    let fewest = Infinity;
    for (const candidate of pathSnaps) {
      const trial = cloneRefineMesh(mesh, true);
      const left = cutAlongField(trial, topology, vertices, field, placer, candidate, facing)
        .skipped.length;
      if (left < fewest) [fewest, snap] = [left, candidate];
      if (!left) break;
    }
  }
  const cutResult = cutAlongField(mesh, topology, vertices, field, placer, snap, facing);
  // The cut grows the mesh's arrays: positions are read afresh.
  for (const v of cutResult.chain) {
    const p = [mesh.position[v * 3], mesh.position[v * 3 + 1], mesh.position[v * 3 + 2]];
    if (weightAt(p[0], p[1], p[2]) < creaseWeight) mesh.crease[v] = 0;
  }
  const result = frame.corners.length ? splitCorners(mesh, frame, cutResult, strength) : cutResult;
  const reversed = new Set(folded);
  for (const t of reversedChildren(mesh, before, parents, result.children)) reversed.add(t);
  const all = new Set(changed);
  for (const v of result.chain) all.add(v);
  return {
    changed: Uint32Array.from(all).sort(),
    cut: result,
    skipped: result.skipped,
    folded: Uint32Array.from(reversed).sort(),
  };
}

/**
 * Puts a vertex on each sharp joint's corner. The chain points within the soft half-width of it are
 * tried nearest first, each moved to the corner by the strength, until one reverses and collapses none
 * of the triangles around it: a chain vertex moves; inside a chain edge the edge is split there, its
 * two triangles into four. Returns the cut with any new vertices.
 */
function splitCorners(mesh: RefineMesh, frame: Frame, cut: CutResult, strength: number): CutResult {
  const { position } = mesh;
  const at = (w: number) => [position[w * 3], position[w * 3 + 1], position[w * 3 + 2]];
  const area = (p: number[][]) =>
    crossOf(
      [0, 1, 2].map((a) => p[1][a] - p[0][a]),
      [0, 1, 2].map((a) => p[2][a] - p[0][a]),
    );
  const pairs: number[][] = [];
  for (let k = 0; k < cut.edges.length; k += 2) pairs.push([cut.edges[k], cut.edges[k + 1]]);
  const key = (a: number, b: number) => Math.min(a, b) * mesh.weldedCount + Math.max(a, b);
  // Per corner, its chain points within reach: a vertex (t 0) or a point inside an edge.
  const options = frame.corners.map((corner) => {
    const found = new Map<string, { a: number; b: number; t: number; d: number }>();
    for (const [a, b] of pairs) {
      const pa = at(a);
      const ab = [0, 1, 2].map((k) => position[b * 3 + k] - pa[k]);
      const toward = [0, 1, 2].map((k) => corner.point[k] - pa[k]);
      const t = Math.min(1, Math.max(0, dot(toward, ab) / (dot(ab, ab) || 1)));
      const d = Math.hypot(...[0, 1, 2].map((k) => pa[k] + t * ab[k] - corner.point[k]));
      if (d > corner.soft) continue;
      const option = t <= 0 || t >= 1 ? { a: t <= 0 ? a : b, b: -1, t: 0, d } : { a, b, t, d };
      found.set(`${option.a},${option.b}`, option);
    }
    return [...found.values()].sort((p, q) => p.d - q.d || p.a - q.a || p.b - q.b);
  });
  const vertices = new Set(options.flatMap((list) => list.map(({ a }) => a)));
  const edges = new Set(
    options.flatMap((list) => list.filter(({ b }) => b >= 0).map(({ a, b }) => key(a, b))),
  );
  if (!vertices.size) return cut;
  const fans = new Map<number, number[]>();
  const sides = new Map<number, number[]>();
  for (let t = 0; t < mesh.triangleCount; t++)
    for (let k = 0; k < 3; k++) {
      const a = weldedCorner(mesh, t, k as 0 | 1 | 2),
        b = weldedCorner(mesh, t, ((k + 1) % 3) as 0 | 1 | 2);
      if (vertices.has(a)) fans.set(a, [...(fans.get(a) ?? []), t]);
      if (edges.has(key(a, b))) sides.set(key(a, b), [...(sides.get(key(a, b)) ?? []), t, k]);
    }
  const keeps = (was: number[], now: number[]) =>
    dot(was, now) > 0 && Math.hypot(now[0], now[1], now[2]) / 2 > 1e-12;
  const chain = [...cut.chain];
  const children = new Map(cut.children);
  const parentOf = new Map<number, number>();
  for (const [parent, list] of children) for (const child of list) parentOf.set(child, parent);
  const size = mesh.colorSize;
  frame.corners.forEach((corner, c) => {
    for (const { a, b, t } of options[c]) {
      const on = b < 0 ? at(a) : at(a).map((x, k) => x * (1 - t) + position[b * 3 + k] * t);
      // A joint has full weight (see `frameWeights`).
      const to = on.map((x, k) => x + strength * (corner.point[k] - x));
      if (b < 0) {
        const fits = (fans.get(a) ?? []).every((f) => {
          const w = [0, 1, 2].map((k) => weldedCorner(mesh, f, k as 0 | 1 | 2));
          return keeps(area(w.map(at)), area(w.map((u) => (u === a ? to : at(u)))));
        });
        if (!fits) continue;
        moveVertex(mesh, a, to[0], to[1], to[2]);
        return;
      }
      const found = sides.get(key(a, b)) ?? [];
      if (found.length !== 4) continue;
      // Each side's triangle splits in two at the new vertex, keeping its corners' order.
      const plan = [0, 2].map((j) => ({ f: found[j], k: found[j + 1] }));
      const fits = plan.every(({ f, k }) => {
        const w = [0, 1, 2].map((m) => weldedCorner(mesh, f, ((k + m) % 3) as 0 | 1 | 2));
        const was = area(w.map(at));
        return (
          keeps(was, area([at(w[0]), to, at(w[2])])) && keeps(was, area([to, at(w[1]), at(w[2])]))
        );
      });
      if (!fits) continue;
      const welded = addWeldedVertex(mesh, to[0], to[1], to[2]);
      mesh.crease[welded] = +(strength >= creaseWeight);
      chain.push(welded);
      for (const { f, k } of plan) {
        const g = [0, 1, 2].map((m) => mesh.corners[f * 3 + ((k + m) % 3)]);
        // How far along this triangle's edge, from its corner g[0], the new vertex lies.
        const along = mesh.weldOf[g[0]] === a ? t : 1 - t;
        const color = new Float32Array(size);
        if (mesh.color)
          for (let m = 0; m < size; m++)
            color[m] =
              mesh.color[g[0] * size + m] * (1 - along) + mesh.color[g[1] * size + m] * along;
        const vertex = addGeometryVertex(mesh, welded, color);
        const corners = [0, 1, 2].map((m) => mesh.corners[f * 3 + m]);
        corners[(k + 1) % 3] = vertex;
        setTriangle(mesh, f, corners[0], corners[1], corners[2]);
        const added = addTriangle(mesh, vertex, g[1], g[2]);
        const parent = parentOf.get(f) ?? f;
        children.set(parent, [...(children.get(parent) ?? [parent]), added]);
        parentOf.set(added, parent);
      }
      const index = pairs.findIndex(([p, q]) => p === a && q === b);
      pairs.splice(index, 1, [a, welded], [welded, b]);
      return;
    }
  });
  return {
    chain: Uint32Array.from(chain),
    edges: Uint32Array.from(pairs.flat()),
    children,
    skipped: cut.skipped,
  };
}

/** Triangles, children included, whose normal opposes that of their parent's corners at `before`. */
function reversedChildren(
  mesh: RefineMesh,
  before: Float64Array,
  parents: Map<number, number[]>,
  children: Map<number, number[]>,
) {
  const normal = (source: ArrayLike<number>, corners: number[]) => {
    const [a, b, c] = corners.map((w) => w * 3);
    const u = [0, 1, 2].map((k) => source[b + k] - source[a + k]);
    const v = [0, 1, 2].map((k) => source[c + k] - source[a + k]);
    return crossOf(u, v);
  };
  const reversed: number[] = [];
  for (const [t, corners] of parents) {
    const was = normal(before, corners);
    for (const child of children.get(t) ?? [t]) {
      const now = normal(
        mesh.position,
        [0, 1, 2].map((k) => weldedCorner(mesh, child, k as 0 | 1 | 2)),
      );
      if (dot(was, now) < 0) reversed.push(child);
    }
  }
  return reversed;
}
