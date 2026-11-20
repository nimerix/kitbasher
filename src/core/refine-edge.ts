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
import { type Shape, fitShape, projectToShape, shapeDistance } from './refine-fit';
import {
  type EdgeCurve,
  type GuideJoint,
  type GuideKind,
  closestOnCurve,
  curveTangent,
  fitCurve,
} from './refine-curve';
import {
  type RefineMesh,
  type RefineTopology,
  foldedTriangles,
  moveVertex,
  vertexNormal,
  weldedCorner,
} from './refine-mesh';

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
/** Least weight of the vertices the cut runs among; below it the surface is only moved. */
const cutWeight = 0.9;
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
function guideSpan(curve: EdgeCurve, drawn: EdgeCurve, edge: number) {
  const at = new Float64Array(3);
  const p = drawn.points,
    n = p.length - 3;
  const ends = [onCurve(curve, p[0], p[1], p[2], at), onCurve(curve, p[n], p[n + 1], p[n + 2], at)];
  const [from, to] = ends[0] <= ends[1] ? ends : [ends[1], ends[0]];
  return { from, to, taper: taperOf(to - from, edge) };
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
function taperOf(length: number, edge: number) {
  const taper = Math.max(taperLength, taperEdges * edge);
  if (length >= 2 * taper + coreEdges * edge) return taper;
  return Math.max(0, (length - coreEdges * edge) / 2);
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
  const refit = (threshold: number, curve: EdgeCurve): [Flank, Flank] | null => {
    const fitted = sides.map(({ members, normals }, s) => {
      const fit = band.fits[s];
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
      return shape?.within ? shapeFlank(shape.shape) : null;
    });
    return fitted[0] && fitted[1] ? [fitted[0], fitted[1]] : null;
  };
  const meetWith = (flanks: [Flank, Flank]) => {
    const meet = meetFlanks(band, flanks, width);
    if (meet.angles.length < 2) return null;
    return { flanks, meet, curve: fitCurve(kind, meet.points, controls, edge) };
  };
  // The band's own flanks seed the first step; once two steps agree, the nearer one is kept.
  let solved = meetWith([flankOf(band.flanks[0]), flankOf(band.flanks[1])]);
  for (let step = clearEdges; solved; step += clearEdges) {
    const flanks = refit(band.soft + step * edge, solved.curve);
    const next = flanks && meetWith(flanks);
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

/**
 * Null when the band finds no edge under the guide, or when the width leaves no usable core: fewer
 * than `coreEdges` edge lengths of the edge at full weight, or no fully weighted vertex on a flank.
 * This handles one open segment; paths of several segments and closed loops also give null.
 */
export function solveEdge(
  mesh: RefineMesh,
  topology: RefineTopology,
  input: EdgeInput,
  noise: number,
): EdgeSolve | null {
  if (input.segments.length !== 1 || input.closed) return null;
  const [{ kind, points }] = input.segments;
  const width = input.width ?? estimateWidth(mesh, topology, kind, points, noise);
  if (!(width > 0)) return null;
  const band = buildBand(mesh, topology, kind, points, width, noise);
  if (!band) return null;
  const edge = bandEdgeLength(mesh, topology, band);
  const solved = unbiasedFlanks(mesh, topology, band, kind, points.length, width, noise, edge);
  if (!solved) return null;
  const { flanks, meet, curve } = solved;
  if (median(meet.angles) < minBandAngle) return null;
  // An edge that lies farther from the surface than half the band's width, as at a fin whose faces
  // nearly meet, cannot be reached by moving the band's vertices.
  const members = Array.from({ length: band.vertices.length }, (_, i) => i);
  const find = nearestMember(mesh, band, members, 4 * edge);
  const depths: number[] = [];
  for (let k = 0; k < meet.points.length; k += 3)
    depths.push(find(meet.points[k], meet.points[k + 1], meet.points[k + 2]).distance);
  if (median(depths) > deepestEdge * width) return null;
  const solve: EdgeSolve = {
    bands: [band],
    flanks: [flanks],
    curve,
    sign: Int8Array.of(edgeSign(mesh, topology, band, flanks, meet.points, edge)),
    width,
    deviation: largestGap(curve, band.drawn, meet.points, edge),
  };
  return usableCore(mesh, topology, solve, edge) ? solve : null;
}

/**
 * True when at least `coreEdges` edge lengths of the edge, unbroken, have a vertex of full weight in
 * the soft zone or as near the edge as the soft zone is wide, and each flank has a vertex of full
 * weight.
 */
function usableCore(mesh: RefineMesh, topology: RefineTopology, solve: EdgeSolve, edge: number) {
  const [band] = solve.bands;
  const { position } = mesh;
  const weights = moveWeights(mesh, topology, solve);
  const near = Math.max(band.soft, 2 * edge);
  const sides = [false, false];
  const stations: number[] = [];
  const at = new Float64Array(3);
  band.vertices.forEach((v, i) => {
    if (weights[i] < 1) return;
    if (band.zone[i] === BandZone.Left) sides[0] = true;
    if (band.zone[i] === BandZone.Right) sides[1] = true;
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
    if (band.zone[i] === BandZone.Soft || d <= near) stations.push(station);
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
 * Per band vertex, the share of its full move it makes at strength 1. Along the band's sides:
 * smoothstep of its distance over the surface from the nearest vertex that does not move (outside
 * the band, or Beyond), over a blend of half the band's width held between 2 and 4 edge lengths. At
 * an open guide's ends, also smoothstep of its distance along the edge from the end over the taper.
 * 0 for a vertex that does not move.
 */
export function moveWeights(mesh: RefineMesh, topology: RefineTopology, solve: EdgeSolve) {
  const [band] = solve.bands;
  const { curve } = solve;
  const { position } = mesh;
  const count = band.vertices.length;
  const indexOf = new Map<number, number>();
  for (let i = 0; i < count; i++)
    if (band.zone[i] !== BandZone.Beyond) indexOf.set(band.vertices[i], i);
  const length = (v: number, w: number) =>
    Math.hypot(
      position[v * 3] - position[w * 3],
      position[v * 3 + 1] - position[w * 3 + 1],
      position[v * 3 + 2] - position[w * 3 + 2],
    );
  // Shortest paths over mesh edges from the vertices that stay into the editable ones.
  const reach = new Float64Array(count).fill(Infinity);
  const queue: number[] = [];
  for (const [v, i] of indexOf)
    for (let j = topology.neighbourStart[v]; j < topology.neighbourStart[v + 1]; j++) {
      const w = topology.neighbours[j];
      if (indexOf.has(w)) continue;
      if (reach[i] === Infinity) queue.push(i);
      reach[i] = Math.min(reach[i], length(v, w));
    }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head],
      v = band.vertices[i];
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
  const edge = bandEdgeLength(mesh, topology, band);
  const blend = Math.max(blendEdges[0] * edge, Math.min(solve.width / 2, blendEdges[1] * edge));
  const { from, to, taper } = guideSpan(curve, band.drawn, edge);
  const at = new Float64Array(3);
  return Float64Array.from(reach, (d, i) => {
    const v = band.vertices[i];
    if (!indexOf.has(v)) return 0;
    if (curve.closed || !(taper > 0)) return smooth(d / blend);
    const station = onCurve(curve, position[v * 3], position[v * 3 + 1], position[v * 3 + 2], at);
    return smooth(d / blend) * smooth(Math.min(station - from, to - station) / taper);
  });
}

/**
 * Each flank's corrected surface: the flank plus the offset that carries the flanks' own meet onto
 * the solved edge, faded by smoothstep from the meet out to that flank's own start. Both surfaces
 * pass through the solved edge.
 */
function correctedSurfaces(mesh: RefineMesh, solve: EdgeSolve, edge: number) {
  const [band] = solve.bands;
  const flanks = solve.flanks[0];
  const { curve, width } = solve;
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

/** Exported for the tests: each side's corrected surface, as `applyEdge` moves the band onto it. */
export function correctedFlanks(mesh: RefineMesh, topology: RefineTopology, solve: EdgeSolve) {
  const surfaces = correctedSurfaces(mesh, solve, bandEdgeLength(mesh, topology, solve.bands[0]));
  return [0, 1].map((s) => (x: number, y: number, z: number) => surfaces.distance(s, x, y, z));
}

/**
 * Moves the band onto the flanks' corrected surfaces, each vertex by `strength` times its
 * `moveWeights` share of its full move. With `cut`, also puts mesh edges on the solved edge where the
 * weight is at least `cutWeight` (mesh must be a topology clone). At strength 0 nothing moves and
 * nothing is cut.
 */
export function applyEdge(
  mesh: RefineMesh,
  topology: RefineTopology,
  solve: EdgeSolve,
  strength: number,
  cut: boolean,
): EdgeResult {
  if (!(strength > 0)) return { changed: empty, cut: null, skipped: empty, folded: empty };
  const [band] = solve.bands;
  const flanks = solve.flanks[0];
  const { curve } = solve;
  const { position } = mesh;
  const edge = bandEdgeLength(mesh, topology, band);
  const count = band.vertices.length;
  const indexOf = new Map<number, number>();
  for (let i = 0; i < count; i++)
    if (band.zone[i] !== BandZone.Beyond) indexOf.set(band.vertices[i], i);
  const surfaces = correctedSurfaces(mesh, solve, edge);
  const weights = moveWeights(mesh, topology, solve);

  const move = new Float64Array(count * 3);
  const moved = new Uint8Array(count);
  const target = [0, 0, 0];
  for (const [v, i] of indexOf) {
    const p = [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]];
    const weight = strength * weights[i];
    if (!(weight > 0)) continue;
    const zone = band.zone[i];
    const side =
      zone === BandZone.Left
        ? 0
        : zone === BandZone.Right
          ? 1
          : +(flanks[1].distance(p[0], p[1], p[2]) < flanks[0].distance(p[0], p[1], p[2]));
    surfaces.target(side, p[0], p[1], p[2], target);
    for (let a = 0; a < 3; a++) move[i * 3 + a] = weight * (target[a] - p[a]);
    moved[i] = +(move[i * 3] !== 0 || move[i * 3 + 1] !== 0 || move[i * 3 + 2] !== 0);
  }
  const before = position.slice(0, mesh.weldedCount * 3);
  const changed: number[] = [];
  for (const [v, i] of indexOf) {
    if (!moved[i]) continue;
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

  // The cut, and the crease on its chain, only where the edge is sharp: among vertices of weight at
  // least `cutWeight`. Elsewhere the surface is only moved.
  const cutting: number[] = [];
  for (const [v, i] of indexOf) if (moved[i] && weights[i] >= cutWeight) cutting.push(v);
  const vertices = Uint32Array.from(cutting);
  const field = new Float32Array(vertices.length);
  const cells = new Map<number, number[]>();
  const cellOf = (x: number, y: number, z: number) =>
    Math.imul(Math.floor(x / edge), 73856093) ^
    Math.imul(Math.floor(y / edge), 19349663) ^
    Math.imul(Math.floor(z / edge), 83492791);
  vertices.forEach((v, k) => {
    const [x, y, z] = [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]];
    field[k] = surfaces.distance(0, x, y, z) - surfaces.distance(1, x, y, z);
    const key = cellOf(x, y, z);
    const list = cells.get(key);
    if (list) list.push(v);
    else cells.set(key, [v]);
  });
  // A point on the edge moves onto it as the least weight of the cut vertices within an edge length
  // of it (else the nearest) rises from `cutWeight` to 1, so that where the cut begins the edge
  // starts flush with the moved surface and is wholly on the solved edge only where it is sharp.
  const weightAt = (x: number, y: number, z: number) => {
    let best = Infinity,
      nearest = 1,
      least = Infinity;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const v of cells.get(cellOf(x + dx * edge, y + dy * edge, z + dz * edge)) ?? []) {
            const d = Math.hypot(
              position[v * 3] - x,
              position[v * 3 + 1] - y,
              position[v * 3 + 2] - z,
            );
            const w = weights[indexOf.get(v)!];
            if (d <= edge) least = Math.min(least, w);
            if (d < best) {
              best = d;
              nearest = w;
            }
          }
    const weight = least < Infinity ? least : nearest;
    return strength * smooth((weight - cutWeight) / (1 - cutWeight));
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
  const result = cutAlongField(mesh, topology, vertices, field, (x, y, z, out) => {
    onCurve(curve, x, y, z, on);
    const weight = weightAt(x, y, z);
    out[0] = x + weight * (on[0] - x);
    out[1] = y + weight * (on[1] - y);
    out[2] = z + weight * (on[2] - z);
  });
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
