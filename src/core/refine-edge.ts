import {
  BandZone,
  type EdgeBand,
  type GuidePoint,
  buildBand,
  estimateWidth,
  minBandAngle,
} from './refine-band';
import { type CutResult, cutAlongField } from './refine-cut';
import {
  type EdgeCurve,
  type GuideJoint,
  type GuideKind,
  closestOnCurve,
  curveTangent,
  fitCurve,
} from './refine-curve';
import {
  type Shape,
  type ShapeKind,
  fitAuto,
  fitShape,
  projectToShape,
  shapeDistance,
} from './refine-fit';
import {
  type RefineMesh,
  type RefineTopology,
  foldedTriangles,
  moveVertex,
  vertexNormal,
} from './refine-mesh';

export interface Flank {
  kind: ShapeKind | 'swept';
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

/** Length, mm, over which the rebuilt edge fades out toward each free end of the guide. */
export const edgeFade = (width: number) => width;

/** Fewest vertices a flank fit reads. */
const minimumFlank = 12;
/** A flank is fitted from this many edge lengths past the solved edge, or farther past a wide soft zone. */
const seedStart = 2;
/**
 * How far out `buildBand` reads to classify, for a mesh of this edge length: its reach plus a seed
 * (refine-band's reachWidth, reachEdges, seedStart, seedEdges, seedSpan). At every width up to this
 * the band's zones are the same, so flanks are fitted on the band read this far.
 */
const analysisWidth = (edge: number) =>
  Math.max(0.35, 6 * edge) + 2 * edge + Math.max(6 * edge, 0.3);
/** Fraction of `analysisWidth` read, to stay inside it where this edge length differs from the band's. */
const analysisMargin = 0.95;
/** Deepest the solved edge may lie below or above the surface, as a fraction of the band's width. */
const deepestEdge = 0.5;
/** Most points a flank fit reads. */
const fitPoints = 1024;
/** Stations per slice of a swept flank's straight profiles. */
const sliceSteps = 4;
/** Edge lengths over which a flank's move fades out before an unmoved vertex. */
const endEdges = 2;
/** Largest move, mm, of a vertex next to one that does not move. */
const seamMove = 0.005;
const empty = new Uint32Array(0);

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
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

function shapeFlank(shape: Shape): Flank {
  const signed = (x: number, y: number, z: number) => shapeDistance(shape, x, y, z);
  return {
    kind: shape.kind,
    signed,
    distance: (x, y, z) => Math.abs(signed(x, y, z)),
    project: (x, y, z, out) => projectToShape(shape, x, y, z, out),
  };
}

/** Weighted least squares polynomial in `t` of the given degree; coefficients from the constant up. */
function polynomial(t: number[], v: number[], w: number[], degree: number) {
  const n = degree + 1;
  const a = Array.from({ length: n }, () => new Float64Array(n + 1));
  t.forEach((x, i) => {
    const powers = Array.from({ length: n }, (_, k) => x ** k);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) a[r][c] += w[i] * powers[r] * powers[c];
      a[r][n] += w[i] * powers[r] * v[i];
    }
  });
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    if (!(Math.abs(a[c][c]) > 1e-12)) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  return Array.from({ length: n }, (_, k) => a[k][n] / a[k][k]);
}

/**
 * A surface swept along the drawn guide: per slice of `slice` mm a straight profile in the guide's
 * cross-section, its direction and offset then smoothed along the guide by a cubic least squares fit.
 */
function sweptFlank(points: Float32Array, normals: Float32Array, drawn: EdgeCurve, slice: number) {
  const count = points.length / 3;
  const mean = [0, 0, 0];
  for (let i = 0; i < count; i++) for (let a = 0; a < 3; a++) mean[a] += normals[i * 3 + a];
  const reference = unit(mean);
  const at = new Float64Array(3),
    tangent = new Float64Array(3);
  // A point's station and its coordinates across and up in that station's cross-section.
  const frame = (x: number, y: number, z: number) => {
    const station = closestOnCurve(drawn, x, y, z, at);
    curveTangent(drawn, station, tangent);
    const along = dot(reference, tangent);
    const m = unit([0, 1, 2].map((a) => reference[a] - along * tangent[a]));
    const b = crossOf(tangent, m);
    const w = [x - at[0], y - at[1], z - at[2]];
    return { station, b, m, across: dot(w, b), up: dot(w, m) };
  };
  const slices = new Map<number, { s: number[]; x: number[]; y: number[] }>();
  for (let i = 0; i < count; i++) {
    const f = frame(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
    const k = Math.floor(f.station / slice);
    const entry = slices.get(k) ?? { s: [], x: [], y: [] };
    entry.s.push(f.station);
    entry.x.push(f.across);
    entry.y.push(f.up);
    slices.set(k, entry);
  }
  const stations: number[] = [],
    angles: number[] = [],
    offsets: number[] = [],
    weights: number[] = [];
  for (const { s, x, y } of slices.values()) {
    if (s.length < 3) continue;
    const n = s.length;
    const cx = x.reduce((a, b) => a + b, 0) / n,
      cy = y.reduce((a, b) => a + b, 0) / n;
    let sxx = 0,
      sxy = 0,
      syy = 0;
    for (let i = 0; i < n; i++) {
      sxx += (x[i] - cx) ** 2;
      sxy += (x[i] - cx) * (y[i] - cy);
      syy += (y[i] - cy) ** 2;
    }
    // The profile's normal is the scatter's minor axis, turned toward the reference normal (+up).
    const major = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let nx = -Math.sin(major),
      ny = Math.cos(major);
    if (ny < 0) [nx, ny] = [-nx, -ny];
    stations.push(s.reduce((a, b) => a + b, 0) / n);
    angles.push(Math.atan2(nx, ny));
    offsets.push(nx * cx + ny * cy);
    weights.push(n);
  }
  if (!stations.length) return null;
  const low = Math.min(...stations),
    high = Math.max(...stations);
  const scale = high > low ? 2 / (high - low) : 0;
  const t = stations.map((s) => (s - low) * scale - 1);
  const degree = Math.min(3, stations.length - 1);
  const angle = polynomial(t, angles, weights, degree),
    offset = polynomial(t, offsets, weights, degree);
  if (!angle || !offset) return null;
  const evaluate = (c: number[], s: number) => {
    const x = Math.min(1, Math.max(-1, (s - low) * scale - 1));
    return c.reduce((sum, k, i) => sum + k * x ** i, 0);
  };
  const solve = (x: number, y: number, z: number) => {
    const f = frame(x, y, z);
    const theta = evaluate(angle, f.station);
    const [sin, cos] = [Math.sin(theta), Math.cos(theta)];
    const d = f.across * sin + f.up * cos - evaluate(offset, f.station);
    return { d, direction: [0, 1, 2].map((a) => sin * f.b[a] + cos * f.m[a]) };
  };
  const flank: Flank = {
    kind: 'swept',
    signed: (x, y, z) => solve(x, y, z).d,
    distance: (x, y, z) => Math.abs(solve(x, y, z).d),
    project: (x, y, z, out) => {
      const { d, direction } = solve(x, y, z);
      out[0] = x - d * direction[0];
      out[1] = y - d * direction[1];
      out[2] = z - d * direction[2];
    },
  };
  return flank;
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

/** The band's solved edge as an offset across the guide, sampled along the guide. */
interface EdgeOffsets {
  stations: number[];
  /** Offset across the guide, 3 values per station (the first used), for `interpolate`. */
  offsets: number[];
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

const allMembers = (band: EdgeBand) => Array.from({ length: band.vertices.length }, (_, i) => i);

/** At each point of the band's solved edge: its station and offset, those of the nearest band vertex. */
function edgeOffsets(mesh: RefineMesh, band: EdgeBand, edgeLength: number): EdgeOffsets {
  const edge = band.edge;
  const find = nearestMember(mesh, band, allMembers(band), 4 * edgeLength);
  const samples: [number, number][] = [];
  for (let k = 0; k < edge.length; k += 3) {
    const { nearest } = find(edge[k], edge[k + 1], edge[k + 2]);
    samples.push([band.station[nearest], band.cross[nearest]]);
  }
  samples.sort((a, b) => a[0] - b[0]);
  return { stations: samples.map((s) => s[0]), offsets: samples.flatMap((s) => [s[1], 0, 0]) };
}

/** Signed offset of each band vertex across the guide from the solved edge, along the surface. */
function offsetsFromEdge(band: EdgeBand, edge: EdgeOffsets) {
  const value = [0, 0, 0];
  return Float64Array.from(band.cross, (cross, i) => {
    interpolate(edge.stations, edge.offsets, band.station[i], value);
    return cross - value[0];
  });
}

/**
 * The surface over one side's flank vertices: the `fitAuto` shape when it is within the noise, else
 * a surface swept along the guide. Null when the side has too few vertices to fit.
 */
function fitFlank(
  mesh: RefineMesh,
  topology: RefineTopology,
  band: EdgeBand,
  zone: BandZone,
  noise: number,
  edge: number,
  offset: Float64Array,
): Flank | null {
  const side: number[] = [];
  band.zone.forEach((z, i) => z === zone && side.push(i));
  if (side.length < minimumFlank) return null;
  const members = side.map((i) => band.vertices[i]);
  const sampleOf = (picked: number[]) => {
    const points = new Float32Array(picked.length * 3),
      normals = new Float32Array(picked.length * 3);
    const normal = new Float32Array(3);
    picked.forEach((v, i) => {
      for (let a = 0; a < 3; a++) points[i * 3 + a] = mesh.position[v * 3 + a];
      vertexNormal(mesh, topology, v, normal);
      normals.set(normal, i * 3);
    });
    return { points, normals };
  };
  // An even sample, as the band takes for its own flank fit.
  const stride = Math.max(1, members.length / fitPoints);
  const sample = sampleOf(
    Array.from(
      { length: Math.min(members.length, fitPoints) },
      (_, k) => members[Math.floor(k * stride)],
    ),
  );
  try {
    const fit = fitAuto(sample.points, sample.normals, noise);
    if (fit.within && fit.shape.kind === 'plane') {
      // As the band reseeds: from past the flank's start by an edge and by its own width, so that
      // the fillet's shoulder, within the noise of the face, does not tilt the plane toward the edge.
      const start = Math.max(seedStart * edge, band.soft + edge, 2 * band.soft);
      const outer = side.filter((i) => Math.abs(offset[i]) >= start).map((i) => band.vertices[i]);
      const away = Math.max(1, outer.length / fitPoints);
      const far =
        outer.length >= minimumFlank
          ? sampleOf(
              Array.from(
                { length: Math.min(outer.length, fitPoints) },
                (_, k) => outer[Math.floor(k * away)],
              ),
            )
          : null;
      const plane = far && fitShape(far.points, far.normals, 'plane', noise);
      return shapeFlank(plane?.within ? plane.shape : fit.shape);
    }
    if (fit.within) return shapeFlank(fit.shape);
  } catch {
    // No single shape describes these points; the swept surface below may.
  }
  const all = sampleOf(members);
  return sweptFlank(all.points, all.normals, band.drawn, sliceSteps * edge);
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

/**
 * Null when the band finds no edge under the guide or a flank cannot be fitted. This handles one
 * open segment; paths of several segments and closed loops also give null.
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
  const reach = analysisMargin * analysisWidth(edge);
  const wide =
    width < reach ? (buildBand(mesh, topology, kind, points, reach, noise) ?? band) : band;
  const offset = offsetsFromEdge(wide, edgeOffsets(mesh, wide, edge));
  const left = fitFlank(mesh, topology, wide, BandZone.Left, noise, edge, offset),
    right = fitFlank(mesh, topology, wide, BandZone.Right, noise, edge, offset);
  if (!left || !right) return null;
  const flanks: [Flank, Flank] = [left, right];
  const meet = meetFlanks(band, flanks, width);
  if (meet.angles.length < 2 || median(meet.angles) < minBandAngle) return null;
  // An edge that lies farther from the surface than half the band's width, as at a fin whose faces
  // nearly meet, cannot be reached by moving the band's vertices.
  const find = nearestMember(mesh, band, allMembers(band), 4 * edge);
  const depths: number[] = [];
  for (let k = 0; k < meet.points.length; k += 3)
    depths.push(find(meet.points[k], meet.points[k + 1], meet.points[k + 2]).distance);
  if (median(depths) > deepestEdge * width) return null;
  const curve = fitCurve(kind, meet.points, points.length, edge);
  return {
    bands: [band],
    flanks: [flanks],
    curve,
    sign: Int8Array.of(edgeSign(mesh, topology, band, flanks, meet.points, edge)),
    width,
  };
}

/** The point of `curve` nearest (x, y, z), past an end along the end's tangent. */
function onCurve(curve: EdgeCurve, x: number, y: number, z: number, out: Float64Array) {
  const station = closestOnCurve(curve, x, y, z, out);
  const total = curve.lengths[curve.lengths.length - 1];
  if (curve.closed || (station > 0 && station < total)) return station;
  const tangent = new Float64Array(3);
  curveTangent(curve, station, tangent);
  const along = (x - out[0]) * tangent[0] + (y - out[1]) * tangent[1] + (z - out[2]) * tangent[2];
  if ((station <= 0 && along < 0) || (station >= total && along > 0))
    for (let a = 0; a < 3; a++) out[a] += along * tangent[a];
  return station;
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
 * Moves the band onto the flanks. With `cut`, also puts mesh edges on the solved edge (mesh must be a
 * topology clone). At strength 0 nothing moves and nothing is cut.
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
  const { curve, width } = solve;
  const { position } = mesh;
  const edge = bandEdgeLength(mesh, topology, band);
  const count = band.vertices.length;
  const candidate = (i: number) => band.zone[i] !== BandZone.Beyond;
  const indexOf = new Map<number, number>();
  for (let i = 0; i < count; i++) if (candidate(i)) indexOf.set(band.vertices[i], i);

  // Where the flanks meet at each station, and how far the solved edge lies from that.
  const meet = meetFlanks(band, flanks, width).points;
  const at = new Float64Array(3);
  const samples = Array.from({ length: meet.length / 3 }, (_, k) => {
    const p = [meet[k * 3], meet[k * 3 + 1], meet[k * 3 + 2]];
    const station = onCurve(curve, p[0], p[1], p[2], at);
    return { station, correction: [at[0] - p[0], at[1] - p[1], at[2] - p[2]] };
  });
  samples.sort((a, b) => a.station - b.station);
  const corrections = samples.flatMap((s) => s.correction);
  const curveStations = samples.map((s) => s.station);
  const edgeAt = edgeOffsets(mesh, band, edge);
  const offsets = offsetsFromEdge(band, edgeAt);

  // Fade toward the free ends of the guide.
  const total = band.drawn.lengths[band.drawn.lengths.length - 1];
  const fade = edgeFade(width);
  const endWeight = (station: number) => smooth(Math.min(station, total - station) / fade);

  // Distance over the surface from the nearest band vertex next to one that may not move.
  const seam = new Float64Array(count).fill(Infinity);
  const queue: number[] = [];
  for (const [v, i] of indexOf)
    for (let j = topology.neighbourStart[v]; j < topology.neighbourStart[v + 1]; j++)
      if (!indexOf.has(topology.neighbours[j])) {
        seam[i] = 0;
        queue.push(i);
        break;
      }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head],
      v = band.vertices[i];
    for (let j = topology.neighbourStart[v]; j < topology.neighbourStart[v + 1]; j++) {
      const w = topology.neighbours[j];
      const k = indexOf.get(w);
      if (k === undefined) continue;
      const d =
        seam[i] +
        Math.hypot(
          position[v * 3] - position[w * 3],
          position[v * 3 + 1] - position[w * 3 + 1],
          position[v * 3 + 2] - position[w * 3 + 2],
        );
      if (d < seam[k]) {
        seam[k] = d;
        queue.push(k);
      }
    }
  }

  const soft = Math.max(band.soft, 2 * edge);
  const move = new Float64Array(count * 3);
  const weights = new Float64Array(count);
  const moved = new Uint8Array(count),
    inner = new Uint8Array(count);
  const projected = new Float32Array(3);
  const correction = [0, 0, 0];
  for (const [v, i] of indexOf) {
    const p = [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]];
    // Lateral weight: 1 to half the width from the solved edge, then down to 0 at the band's limit.
    const offset = offsets[i];
    const limit = width - Math.sign(offset) * (band.cross[i] - offset);
    const from = Math.min(width / 2, limit / 2);
    const distance = Math.abs(offset);
    const lateral = distance <= from ? 1 : smooth((limit - distance) / (limit - from));
    const weight =
      strength * lateral * endWeight(band.station[i]) * smooth(seam[i] / (endEdges * edge));
    if (!(weight > 0)) continue;
    weights[i] = weight;
    const zone = band.zone[i];
    const flank =
      zone === BandZone.Left
        ? flanks[0]
        : zone === BandZone.Right
          ? flanks[1]
          : flanks[+(flanks[1].distance(p[0], p[1], p[2]) < flanks[0].distance(p[0], p[1], p[2]))];
    flank.project(p[0], p[1], p[2], projected);
    const station = closestOnCurve(curve, projected[0], projected[1], projected[2], at);
    interpolate(curveStations, corrections, station, correction);
    const near = Math.max(0, 1 - distance / soft);
    for (let a = 0; a < 3; a++)
      move[i * 3 + a] = weight * (projected[a] + near * correction[a] - p[a]);
    moved[i] = +(move[i * 3] !== 0 || move[i * 3 + 1] !== 0 || move[i * 3 + 2] !== 0);
  }
  // A vertex next to one that stays may move only a little, so no step opens at the seam.
  for (const [v, i] of indexOf) {
    if (!moved[i]) continue;
    let still = false;
    for (let j = topology.neighbourStart[v]; j < topology.neighbourStart[v + 1] && !still; j++) {
      const k = indexOf.get(topology.neighbours[j]);
      still = k === undefined || !moved[k];
    }
    inner[i] = +!still;
    const length = Math.hypot(move[i * 3], move[i * 3 + 1], move[i * 3 + 2]);
    if (still && length > seamMove)
      for (let a = 0; a < 3; a++) move[i * 3 + a] *= seamMove / length;
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

  // The cut runs only among vertices that moved with every neighbour, so that no vertex it places
  // on the edge stands next to one that stays.
  const cutting: number[] = [];
  for (const [v, i] of indexOf) if (inner[i]) cutting.push(v);
  const vertices = Uint32Array.from(cutting);
  const field = new Float32Array(vertices.length);
  const cells = new Map<number, number[]>();
  const cellOf = (x: number, y: number, z: number) =>
    Math.imul(Math.floor(x / edge), 73856093) ^
    Math.imul(Math.floor(y / edge), 19349663) ^
    Math.imul(Math.floor(z / edge), 83492791);
  vertices.forEach((v, k) => {
    const [x, y, z] = [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]];
    field[k] = flanks[0].distance(x, y, z) - flanks[1].distance(x, y, z);
    const key = cellOf(x, y, z);
    const list = cells.get(key);
    if (list) list.push(v);
    else cells.set(key, [v]);
  });
  // A point on the edge moves onto it by the weight of the cut vertex nearest it.
  const weightAt = (x: number, y: number, z: number) => {
    let best = Infinity,
      weight = 0;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const v of cells.get(cellOf(x + dx * edge, y + dy * edge, z + dz * edge)) ?? []) {
            const d = Math.hypot(
              position[v * 3] - x,
              position[v * 3 + 1] - y,
              position[v * 3 + 2] - z,
            );
            if (d < best) {
              best = d;
              weight = weights[indexOf.get(v)!];
            }
          }
    return weight;
  };
  const target = new Float64Array(3);
  const result = cutAlongField(mesh, topology, vertices, field, (x, y, z, out) => {
    onCurve(curve, x, y, z, target);
    const weight = weightAt(x, y, z);
    out[0] = x + weight * (target[0] - x);
    out[1] = y + weight * (target[1] - y);
    out[2] = z + weight * (target[2] - z);
  });
  const all = new Set(changed);
  for (const v of result.chain) all.add(v);
  return {
    changed: Uint32Array.from(all).sort(),
    cut: result,
    skipped: result.skipped,
    folded,
  };
}
