import { type EdgeCurve, closestOnCurve, fitCurve } from './refine-curve';
import { fitShape } from './refine-fit';

export interface Sweep {
  /** The centre line: an arc when one fits within noise, else a spline. */
  path: EdgeCurve;
  pathKind: 'arc' | 'spline';
  /**
   * Radius of the cross-section at 64 evenly spaced angles about the path, in the path's
   * rotation-minimising frame. Negative when the surface's normals face the path.
   */
  profile: Float32Array;
  /** True when the profile is a circle within noise; it is then replaced by its mean. */
  round: boolean;
}

const bins = 64;
/** A fit reads at most this many points, evenly spread over the patch. */
const fitPoints = 20000;
/** Slabs and stations are this many edge lengths thick. */
const slabEdges = 8;
/** Points one slab's cylinder fit reads at most, evenly spread over the slab. */
const slabPoints = 800;
/** Rounds of refitting each station's circle about the centre line and the line through them. */
const polishRounds = 4;
const tukey = 4.685;
const madScale = 1.4826;
/** A station with under this fraction of the median station's weight is left out. */
const stationShare = 0.5;
/** A tube covers at least this many profile bins (45 degrees) of its circumference. */
const minimumCoverage = 8;
/** At least this fraction of the weight lies within 3 * noise of the sweep, as for a shape fit. */
const minimumSupport = 0.5;
/** A profile bin with less than this many points' weight has no data. */
const binPoints = 3;
/** A slab's cylinder is fitted at up to this many times the noise, until half its points fit. */
const slabCoarsest = 64;
/** A slab's cylinder counts only when its axis is within 60 degrees of the slabs' own axis. */
const slabAlignment = 0.5;
/** Neighbouring centre-line segments may turn by no more than 90 degrees. */
const foldCosine = 0;
/** At least this fraction of the stations keep a radius within tolerance of their median. */
const agreeing = 2 / 3;
/** Stations may differ in radius by this many noise widths, or this fraction of the radius. */
const radiusNoise = 6;
const radiusFraction = 0.05;
/** A profile is round when no bin with data lies this many noise widths off their mean. */
const roundNoise = 3;
/** The path runs on past the farthest point by this many stations at each end. */
const pathMargin = 2;

type V3 = [number, number, number];

/**
 * A constant cross-section swept along a centre line, fitted robustly so detail standing off the
 * tube does not move it. Null when the points hold no tube: fewer than three slabs take a
 * cylinder, the points cover under 45 degrees of its circumference, the centre line folds back
 * on itself, the stations disagree in radius, or under half the weight lies within 3 * noise.
 * With `weights`, each point counts by its weight and points of zero weight are left out.
 * `spacing` is the points' edge length, estimated from their nearest neighbours when null. A
 * `start` sweep, fitted before to nearly the same points, keeps its centre line and only the
 * cross-section is fitted again: weights that narrow a partial tube's view would let the centre
 * line slide toward or away from the visible side.
 */
export function fitSweep(
  points: Float32Array,
  normals: Float32Array,
  noise: number,
  weights: Float64Array | null = null,
  spacing: number | null = null,
  start: Sweep | null = null,
): { sweep: Sweep; rms: number } | null {
  const cloud = sampled(cloudOf(points, normals, weights));
  if (cloud.count < 12) return null;
  const floor = Math.max(noise, 1e-9);
  const edge = spacing ?? spacingOf(cloud);
  if (!(edge > 0)) return null;
  const thick = slabEdges * edge;
  let path: PathFit;
  if (start) path = { curve: start.path, kind: start.pathKind };
  else {
    const centres = slabCentres(cloud, floor, thick);
    if (!centres) return null;
    path = pathThrough(centres, floor, edge, null);
  }
  let local = localOf(cloud, path, thick);
  for (let round = 0; round < (start ? 0 : polishRounds); round++) {
    const stations = polish(cloud, local, thick, floor);
    if (stations.length < 3) return null;
    const flat = Float64Array.from(stations.flatMap((s) => s.centre));
    if (folds(flat)) return null;
    path = pathThrough(flat, floor, edge, median(stations.map((s) => s.radius)));
    local = localOf(cloud, path, thick);
  }
  if (!radiiAgree(cloud, local, thick, floor)) return null;
  const built = profileOf(cloud, local, floor);
  if (!built) return null;
  const sweep: Sweep = { path: local.path.path, pathKind: path.kind, ...built };
  const { rms, support } = rmsOf(cloud, sweep, floor);
  return support >= minimumSupport ? { sweep, rms } : null;
}

/** Writes the point of the sweep's surface nearest (x, y, z) along its cross-section. */
export function projectToSweep(
  sweep: Sweep,
  x: number,
  y: number,
  z: number,
  out: Float32Array | Float64Array,
): void {
  const at = locate(sweep, x, y, z);
  const r = Math.abs(radiusAt(sweep, at.angle));
  const c = Math.cos(at.angle),
    s = Math.sin(at.angle);
  for (let k = 0; k < 3; k++)
    out[k] = at.centre[k] + at.along * at.t[k] + r * (c * at.u[k] + s * at.v[k]);
}

/** Signed distance off the sweep along its cross-section, positive on the side its normals face. */
export function sweepDistance(sweep: Sweep, x: number, y: number, z: number): number {
  const at = locate(sweep, x, y, z);
  const r = radiusAt(sweep, at.angle);
  return Math.sign(r || 1) * (at.radius - Math.abs(r));
}

/** Unit normal of the sweep where the point projects, on the side `sweepDistance` counts plus. */
export function sweepNormal(
  sweep: Sweep,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): void {
  const at = locate(sweep, x, y, z);
  const r = radiusAt(sweep, at.angle);
  const step = (2 * Math.PI) / bins;
  const slope =
    (Math.abs(radiusAt(sweep, at.angle + step / 2)) -
      Math.abs(radiusAt(sweep, at.angle - step / 2))) /
    step;
  const c = Math.cos(at.angle),
    s = Math.sin(at.angle);
  // Outward normal of the polar curve r(angle): r along the radius less r' along the turn.
  const a = Math.abs(r) * c + slope * s,
    b = Math.abs(r) * s - slope * c;
  const length = Math.hypot(a, b) || 1;
  const sign = r < 0 ? -1 : 1;
  for (let k = 0; k < 3; k++) out[k] = (sign * (a * at.u[k] + b * at.v[k])) / length;
}

interface Cloud {
  count: number;
  p: Float32Array;
  n: Float32Array;
  w: Float64Array;
  total: number;
}

/** The points with weight, and their weights scaled to a largest of 1. */
function cloudOf(points: Float32Array, normals: Float32Array, weights: Float64Array | null): Cloud {
  const count = points.length / 3;
  if (!weights) {
    return { count, p: points, n: normals, w: new Float64Array(count).fill(1), total: count };
  }
  const used: number[] = [];
  let largest = 0;
  weights.forEach((w, i) => {
    if (!(w > 0)) return;
    used.push(i);
    largest = Math.max(largest, w);
  });
  const p = new Float32Array(used.length * 3),
    n = new Float32Array(used.length * 3),
    w = new Float64Array(used.length);
  let total = 0;
  used.forEach((i, k) => {
    p.set(points.subarray(i * 3, i * 3 + 3), k * 3);
    n.set(normals.subarray(i * 3, i * 3 + 3), k * 3);
    w[k] = weights[i] / largest;
    total += w[k];
  });
  return { count: used.length, p, n, w, total };
}

/** The cloud thinned to `fitPoints` evenly spread points when it has more. */
function sampled(cloud: Cloud): Cloud {
  if (cloud.count <= fitPoints) return cloud;
  const picked = spread(cloud.count, fitPoints);
  const w = pickWeights(cloud.w, picked);
  return {
    count: picked.length,
    p: pickOf(cloud.p, picked),
    n: pickOf(cloud.n, picked),
    w,
    total: w.reduce((sum, x) => sum + x, 0),
  };
}

/** Median distance from up to 400 evenly spread points to their nearest neighbour. */
function spacingOf(cloud: Cloud) {
  const { count, p } = cloud;
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count * 3; i++) {
    low[i % 3] = Math.min(low[i % 3], p[i]);
    high[i % 3] = Math.max(high[i % 3], p[i]);
  }
  let cell = Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]) / Math.sqrt(count);
  if (!(cell > 0)) return 0;
  const probes = Math.min(400, count);
  for (let attempt = 0; attempt < 8; attempt++, cell *= 2) {
    const key = (i: number) =>
      [0, 1, 2].map((k) => Math.floor((p[i * 3 + k] - low[k]) / cell)).join(',');
    const grid = new Map<string, number[]>();
    for (let i = 0; i < count; i++) {
      const k = key(i);
      const list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    }
    const nearest: number[] = [];
    for (let q = 0; q < probes; q++) {
      const i = Math.floor((q * count) / probes);
      const c = [0, 1, 2].map((k) => Math.floor((p[i * 3 + k] - low[k]) / cell));
      let best = Infinity;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++)
            for (const j of grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) ?? []) {
              if (j === i) continue;
              const d = Math.hypot(
                p[j * 3] - p[i * 3],
                p[j * 3 + 1] - p[i * 3 + 1],
                p[j * 3 + 2] - p[i * 3 + 2],
              );
              if (d > 0) best = Math.min(best, d);
            }
      if (best <= cell) nearest.push(best);
    }
    if (nearest.length >= probes / 2) return median(nearest);
  }
  return 0;
}

/**
 * Slabs across the points' longest principal axis, a cylinder fitted to each, and the axis points
 * nearest the slabs' centroids chained by nearest neighbour. Null with fewer than three
 * cylinders or when the chain folds back.
 */
function slabCentres(cloud: Cloud, noise: number, thick: number) {
  const { count, p, n, w } = cloud;
  const mean = [0, 0, 0];
  for (let i = 0; i < count; i++)
    for (let k = 0; k < 3; k++) mean[k] += (w[i] * p[i * 3 + k]) / cloud.total;
  const covariance = new Float64Array(9);
  for (let i = 0; i < count; i++)
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        covariance[r * 3 + c] += w[i] * (p[i * 3 + r] - mean[r]) * (p[i * 3 + c] - mean[c]);
  const principal = largestEigenvector(covariance);
  const across = (axis: V3) => centresAcross(cloud, noise, thick, mean, axis);
  const first = across(principal);
  if (first) return first;
  // A piece of tube little longer than it is wide may lie longest across itself.
  const picked = spread(cloud.count, slabPoints * 4);
  const fit = coarseCylinder(pickOf(p, picked), pickOf(n, picked), noise, pickWeights(w, picked));
  return fit && fit.shape.kind === 'cylinder' ? across(fit.shape.axis) : null;
}

/** Centres of the slabs across `axis`; see `slabCentres`. */
function centresAcross(cloud: Cloud, noise: number, thick: number, mean: number[], axis: V3) {
  const { count, p, n, w } = cloud;
  const along = Float64Array.from(
    { length: count },
    (_, i) =>
      (p[i * 3] - mean[0]) * axis[0] +
      (p[i * 3 + 1] - mean[1]) * axis[1] +
      (p[i * 3 + 2] - mean[2]) * axis[2],
  );
  let low = Infinity,
    high = -Infinity;
  for (const a of along) {
    low = Math.min(low, a);
    high = Math.max(high, a);
  }
  const slabs = Math.max(1, Math.floor((high - low) / thick));
  const members: number[][] = Array.from({ length: slabs }, () => []);
  along.forEach((a, i) =>
    members[Math.min(slabs - 1, Math.floor(((a - low) / (high - low)) * slabs))].push(i),
  );
  const centres: V3[] = [];
  for (const list of members) {
    const picked = spread(list.length, slabPoints).map((k) => list[k]);
    if (picked.length < 6) continue;
    const fit = coarseCylinder(pickOf(p, picked), pickOf(n, picked), noise, pickWeights(w, picked));
    if (!fit || fit.shape.kind !== 'cylinder') continue;
    const { point, axis: direction } = fit.shape;
    // A slab cut along the tube rather than across it places its centre poorly.
    if (Math.abs(dot3(direction, axis)) < slabAlignment) continue;
    const centroid = [0, 0, 0];
    let total = 0;
    for (const i of picked) {
      total += w[i];
      for (let k = 0; k < 3; k++) centroid[k] += w[i] * p[i * 3 + k];
    }
    const offset = [0, 1, 2].map((k) => centroid[k] / total - point[k]);
    const h = offset[0] * direction[0] + offset[1] * direction[1] + offset[2] * direction[2];
    centres.push([0, 1, 2].map((k) => point[k] + h * direction[k]) as V3);
  }
  if (centres.length < 3) return null;
  return unfolded(chain(centres, axis));
}

/**
 * The chain without the centres at which it turns back, each a stray slab of an out-of-round or
 * rough tube; null when that would drop over a quarter of them, or leave fewer than three.
 */
function unfolded(flat: Float64Array) {
  const points = Array.from({ length: flat.length / 3 }, (_, i) =>
    Array.from(flat.subarray(i * 3, i * 3 + 3)),
  );
  const most = Math.floor(points.length / 4);
  for (let dropped = 0; ; dropped++) {
    const at = foldAt(Float64Array.from(points.flat()));
    if (at < 0) return points.length >= 3 ? Float64Array.from(points.flat()) : null;
    if (dropped === most) return null;
    points.splice(at, 1);
  }
}

/** Up to `most` indices evenly spread over `count`. */
function spread(count: number, most: number) {
  const stride = Math.max(1, count / most);
  const picked: number[] = [];
  for (let k = 0; k < count; k += stride) picked.push(Math.floor(k));
  return picked;
}

const pickOf = (values: Float32Array, picked: number[]) =>
  Float32Array.from(
    { length: picked.length * 3 },
    (_, m) => values[picked[(m / 3) | 0] * 3 + (m % 3)],
  );
const pickWeights = (w: Float64Array, picked: number[]) => Float64Array.from(picked, (i) => w[i]);

/**
 * A cylinder on which at least half the points lie, fitted at the noise and then at four times it
 * and so on up to `slabCoarsest` times: an out-of-round tube leaves most points off any cylinder
 * at the noise, and coarser fits still place its axis.
 */
function coarseCylinder(
  points: Float32Array,
  normals: Float32Array,
  noise: number,
  weights: Float64Array,
) {
  for (let scale = 1; scale <= slabCoarsest; scale *= 4) {
    const fit = fitShape(points, normals, 'cylinder', scale * noise, weights);
    if (fit && fit.support >= 0.5) return fit;
  }
  return null;
}

/** Points ordered by nearest neighbour from the one lowest along `axis`. */
function chain(points: V3[], axis: ArrayLike<number>) {
  const along = (q: V3) => q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2];
  let current = 0;
  points.forEach((q, i) => {
    if (along(q) < along(points[current])) current = i;
  });
  const left = new Set(points.keys());
  const ordered: number[] = [];
  for (;;) {
    left.delete(current);
    ordered.push(...points[current]);
    let next = -1,
      best = Infinity;
    for (const i of left) {
      const d = Math.hypot(...([0, 1, 2].map((k) => points[i][k] - points[current][k]) as V3));
      if (d < best) {
        best = d;
        next = i;
      }
    }
    if (next < 0) break;
    current = next;
  }
  return Float64Array.from(ordered);
}

/** The first point of the flat polyline at which it turns by more than 90 degrees, or -1. */
function foldAt(flat: Float64Array) {
  const count = flat.length / 3;
  for (let i = 1; i < count - 1; i++) {
    let dot = 0;
    for (let k = 0; k < 3; k++)
      dot += (flat[i * 3 + k] - flat[i * 3 - 3 + k]) * (flat[i * 3 + 3 + k] - flat[i * 3 + k]);
    if (dot < foldCosine) return i;
  }
  return -1;
}

const folds = (flat: Float64Array) => foldAt(flat) >= 0;

interface PathFit {
  curve: EdgeCurve;
  kind: 'arc' | 'spline';
}

/**
 * An arc through the centres when it stays within 2 * noise of them in rms, else the spline with
 * the fewest controls, from four up to one per half radius of length, that does.
 */
function pathThrough(
  centres: Float64Array,
  noise: number,
  step: number,
  radius: number | null,
): PathFit {
  const arc = fitCurve('arc', centres, 0, step);
  if (centreRms(arc, centres) <= 2 * noise) return { curve: arc, kind: 'arc' };
  const count = centres.length / 3;
  let length = 0;
  for (let i = 1; i < count; i++)
    length += Math.hypot(
      centres[i * 3] - centres[i * 3 - 3],
      centres[i * 3 + 1] - centres[i * 3 - 2],
      centres[i * 3 + 2] - centres[i * 3 - 1],
    );
  const most = Math.min(count, radius ? Math.max(4, Math.round((2 * length) / radius)) : count);
  let curve = arc;
  for (let controls = Math.min(4, most); controls <= most; controls++) {
    curve = fitCurve('spline', centres, controls, step);
    if (centreRms(curve, centres) <= 2 * noise) break;
  }
  return { curve, kind: 'spline' };
}

/** RMS distance of the centres from the curve. */
function centreRms(curve: EdgeCurve, centres: Float64Array) {
  const count = centres.length / 3;
  const near = new Float64Array(3);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    closestOnCurve(curve, centres[i * 3], centres[i * 3 + 1], centres[i * 3 + 2], near);
    sum +=
      (near[0] - centres[i * 3]) ** 2 +
      (near[1] - centres[i * 3 + 1]) ** 2 +
      (near[2] - centres[i * 3 + 2]) ** 2;
  }
  return Math.sqrt(sum / count);
}

/** Per point: station along the path, and its offset across the path in the path's frame. */
interface Local {
  path: Sweep;
  station: Float64Array;
  a: Float64Array;
  b: Float64Array;
}

/**
 * Each point located against `path`, after running the path on along its own curve (an arc) or
 * straight on (a spline) past the farthest point by `pathMargin` stations at each end.
 */
function localOf(cloud: Cloud, fit: PathFit, thick: number): Local {
  const { count, p } = cloud;
  let probe: Sweep = {
    path: fit.curve,
    pathKind: fit.kind,
    profile: new Float32Array(bins),
    round: true,
  };
  let before = 0,
    after = 0;
  const total = fit.curve.lengths[fit.curve.lengths.length - 1];
  for (let i = 0; i < count; i++) {
    const at = locate(probe, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    if (at.station <= 0) before = Math.max(before, -at.along);
    if (at.station >= total) after = Math.max(after, at.along);
  }
  // A path that already runs on past every point, as a start sweep's does, is kept as it is.
  if (!fit.curve.closed && (before > 0 || after > 0))
    probe = {
      ...probe,
      path: extended(
        fit,
        before > 0 ? before + pathMargin * thick : 0,
        after > 0 ? after + pathMargin * thick : 0,
      ),
    };
  const station = new Float64Array(count),
    a = new Float64Array(count),
    b = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const at = locate(probe, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    station[i] = at.station;
    a[i] = at.radius * Math.cos(at.angle);
    b[i] = at.radius * Math.sin(at.angle);
  }
  return { path: probe, station, a, b };
}

/**
 * The path run on by `before` and `after` past its ends, around its own circle when it is an arc
 * and around the circle through its end and the points a quarter and half its length in when it is
 * a spline, straight on when that circle would turn the run by over 45 degrees.
 */
function extended(fit: PathFit, before: number, after: number): EdgeCurve {
  const p = fit.curve.points,
    count = p.length / 3;
  const point = (i: number): V3 => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  const step = count > 1 ? fit.curve.lengths[count - 1] / (count - 1) : 1;
  const whole =
    fit.kind === 'arc' && count >= 3
      ? circleThrough(point(0), point(count >> 1), point(count - 1))
      : null;
  const span = count >> 2;
  const circleAt = (end: number, inward: number, distance: number) => {
    const circle =
      whole ??
      (span >= 1
        ? circleThrough(point(end), point(end + inward * span), point(end + 2 * inward * span))
        : null);
    return circle && distance <= (Math.PI / 4) * circle.radius ? circle : null;
  };
  const head: V3[] = [],
    tail: V3[] = [];
  const run = (end: number, next: number, distance: number, into: V3[]) => {
    const segments = Math.ceil(distance / step);
    const from = point(end);
    const circle = circleAt(end, next - end, distance);
    for (let k = 1; k <= segments; k++) {
      const s = (distance * k) / segments;
      if (circle) {
        // Rotate the end about the circle's axis, away from its neighbour.
        const sense = Math.sign(
          dot3(cross3(sub3(from, circle.centre), sub3(point(next), from)), circle.normal),
        );
        into.push(rotated(from, circle.centre, circle.normal, (-sense * s) / circle.radius));
      } else {
        const d = unit3(sub3(from, point(next)));
        into.push([0, 1, 2].map((k2) => from[k2] + s * d[k2]) as V3);
      }
    }
  };
  if (count >= 2) {
    run(0, 1, before, head);
    run(count - 1, count - 2, after, tail);
  }
  const all = [...head.reverse(), ...Array.from({ length: count }, (_, i) => point(i)), ...tail];
  const points = Float64Array.from(all.flat());
  const lengths = new Float64Array(all.length);
  for (let i = 1; i < all.length; i++)
    lengths[i] = lengths[i - 1] + Math.hypot(...sub3(all[i], all[i - 1]));
  return { points, lengths, corner: new Uint8Array(all.length), closed: false };
}

interface Station {
  centre: V3;
  radius: number;
}

/**
 * Stations `thick` apart along the path, each one's centre moved to the least-squares circle of
 * its points about the path, all sharing one radius, with points standing off it (detail) down-
 * weighted by Tukey's biweight. Stations with too few points or too narrow a view are dropped.
 */
function polish(cloud: Cloud, local: Local, thick: number, noise: number): Station[] {
  const { count, w } = cloud;
  const { station, a, b } = local;
  let low = Infinity,
    high = -Infinity;
  for (const s of station) {
    low = Math.min(low, s);
    high = Math.max(high, s);
  }
  const slots = Math.max(1, Math.round((high - low) / thick));
  const slotOf = (s: number) =>
    Math.min(slots - 1, Math.floor(((s - low) / (high - low || 1)) * slots));
  const rho = Float64Array.from({ length: count }, (_, i) => Math.hypot(a[i], b[i]));
  const radius = weightedMedian(rho, w);
  const residual = Float64Array.from(rho, (r) => r - radius);
  const scale = Math.max(noise, madScale * weightedMedian(residual.map(Math.abs), w));
  // Per slot: the normal equations of its centre shift (2 x 2), their coupling to the shared
  // radius, the right-hand side, the station sum and the weight.
  const A = new Float64Array(slots * 3),
    e = new Float64Array(slots * 2),
    y = new Float64Array(slots * 2),
    along = new Float64Array(slots),
    total = new Float64Array(slots),
    seen = new Uint32Array(slots);
  let W = 0,
    Y = 0;
  for (let i = 0; i < count; i++) {
    const u = residual[i] / (tukey * scale);
    if (Math.abs(u) >= 1 || !(rho[i] > 0)) continue;
    const k = w[i] * (1 - u * u) ** 2;
    const slot = slotOf(station[i]);
    const da = a[i] / rho[i],
      db = b[i] / rho[i];
    A[slot * 3] += k * da * da;
    A[slot * 3 + 1] += k * da * db;
    A[slot * 3 + 2] += k * db * db;
    e[slot * 2] += k * da;
    e[slot * 2 + 1] += k * db;
    y[slot * 2] += k * da * residual[i];
    y[slot * 2 + 1] += k * db * residual[i];
    along[slot] += k * station[i];
    total[slot] += k;
    seen[slot]++;
    W += k;
    Y += k * residual[i];
  }
  // Solve A_b dc_b + e_b dR = y_b per slot and sum(e_b . dc_b) + W dR = Y, eliminating dc_b.
  const usable: number[] = [];
  const inverse = new Float64Array(slots * 3);
  const typical = median(Array.from(total).filter((t) => t > 0));
  for (let s = 0; s < slots; s++) {
    // A station the points only graze, at an end of the tube, places its centre poorly.
    if (seen[s] < 6 || total[s] < stationShare * typical) continue;
    const [p, q, r] = [A[s * 3], A[s * 3 + 1], A[s * 3 + 2]];
    const det = p * r - q * q;
    // A view of under about 25 degrees leaves the centre undetermined across it.
    if (!(det > 0.002 * (p + r) * (p + r))) continue;
    inverse.set([r / det, -q / det, p / det], s * 3);
    usable.push(s);
  }
  const solveSlot = (s: number, ra: number, rb: number) => [
    inverse[s * 3] * ra + inverse[s * 3 + 1] * rb,
    inverse[s * 3 + 1] * ra + inverse[s * 3 + 2] * rb,
  ];
  let schur = W,
    right = Y;
  for (const s of usable) {
    const [ia, ib] = solveSlot(s, e[s * 2], e[s * 2 + 1]);
    schur -= e[s * 2] * ia + e[s * 2 + 1] * ib;
    right -=
      e[s * 2] * solveSlot(s, y[s * 2], y[s * 2 + 1])[0] +
      e[s * 2 + 1] * solveSlot(s, y[s * 2], y[s * 2 + 1])[1];
  }
  const dR = schur > 1e-9 * W ? right / schur : 0;
  const result: Station[] = [];
  const at = new Float64Array(3),
    frame = new Float64Array(9);
  for (const s of usable) {
    const [ca, cb] = solveSlot(s, y[s * 2] - e[s * 2] * dR, y[s * 2 + 1] - e[s * 2 + 1] * dR);
    frameAt(local.path, along[s] / total[s], at, frame);
    result.push({
      centre: [0, 1, 2].map((k) => at[k] + ca * frame[3 + k] + cb * frame[6 + k]) as V3,
      radius: radius + dR,
    });
  }
  return result;
}

/**
 * Whether at least two thirds of the stations keep a median distance from the path within
 * max(6 * noise, 5% of the radius) of the median over stations.
 */
function radiiAgree(cloud: Cloud, local: Local, thick: number, noise: number) {
  const { station, a, b } = local;
  const groups = new Map<number, { r: number[]; w: number[] }>();
  let low = Infinity;
  for (const s of station) low = Math.min(low, s);
  station.forEach((s, i) => {
    const key = Math.floor((s - low) / thick);
    const group = groups.get(key) ?? { r: [], w: [] };
    group.r.push(Math.hypot(a[i], b[i]));
    group.w.push(cloud.w[i]);
    groups.set(key, group);
  });
  const radii: number[] = [];
  for (const { r, w } of groups.values())
    if (r.length >= 6) radii.push(weightedMedian(Float64Array.from(r), Float64Array.from(w)));
  if (radii.length < 3) return false;
  const middle = median(radii);
  const tolerance = Math.max(radiusNoise * noise, radiusFraction * middle);
  return radii.filter((r) => Math.abs(r - middle) <= tolerance).length >= agreeing * radii.length;
}

/**
 * The weighted median distance from the path in each of 64 angle bins. Bins without data take the
 * mean when the profile is round, else the straight run in angle between their nearest neighbours
 * with data. Null when under 45 degrees have data.
 */
function profileOf(cloud: Cloud, local: Local, noise: number) {
  const { count, n, w } = cloud;
  const { a, b, station } = local;
  const radii: number[][] = Array.from({ length: bins }, () => []);
  const weights: number[][] = Array.from({ length: bins }, () => []);
  let facing = 0;
  const at = new Float64Array(3),
    frame = new Float64Array(9);
  for (let i = 0; i < count; i++) {
    const rho = Math.hypot(a[i], b[i]);
    if (!(rho > 0)) continue;
    const angle = Math.atan2(b[i], a[i]);
    const bin = ((Math.floor((angle / (2 * Math.PI)) * bins) % bins) + bins) % bins;
    radii[bin].push(rho);
    weights[bin].push(w[i]);
    frameAt(local.path, station[i], at, frame);
    let outward = 0;
    for (let k = 0; k < 3; k++)
      outward += n[i * 3 + k] * ((a[i] * frame[3 + k] + b[i] * frame[6 + k]) / rho);
    facing += w[i] * outward;
  }
  const profile = new Float32Array(bins).fill(NaN);
  const filled: number[] = [];
  for (let k = 0; k < bins; k++) {
    const total = weights[k].reduce((s, x) => s + x, 0);
    if (radii[k].length < binPoints || !(total > 0)) continue;
    profile[k] = weightedMedian(Float64Array.from(radii[k]), Float64Array.from(weights[k]));
    filled.push(k);
  }
  if (filled.length < minimumCoverage) return null;
  const mean = filled.reduce((s, k) => s + profile[k], 0) / filled.length;
  const round = filled.every((k) => Math.abs(profile[k] - mean) <= roundNoise * noise);
  if (round) profile.fill(mean);
  else {
    const data = profile.slice();
    for (let k = 0; k < bins; k++) {
      if (!Number.isNaN(data[k])) continue;
      let back = 1,
        ahead = 1;
      while (Number.isNaN(data[(k - back + bins) % bins])) back++;
      while (Number.isNaN(data[(k + ahead) % bins])) ahead++;
      const from = data[(k - back + bins) % bins],
        to = data[(k + ahead) % bins];
      profile[k] = from + ((to - from) * back) / (back + ahead);
    }
  }
  if (facing < 0) for (let k = 0; k < bins; k++) profile[k] = -profile[k];
  return { profile, round };
}

/**
 * RMS distance of the points within Tukey's cut of the sweep, each counting by its weight, and the
 * fraction of the weight within 3 * noise of it.
 */
function rmsOf(cloud: Cloud, sweep: Sweep, noise: number) {
  const { count, p, w } = cloud;
  const distance = Float64Array.from({ length: count }, (_, i) =>
    sweepDistance(sweep, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]),
  );
  const scale = Math.max(noise, madScale * weightedMedian(distance.map(Math.abs), w));
  let sum = 0,
    kept = 0,
    near = 0;
  distance.forEach((d, i) => {
    if (Math.abs(d) <= 3 * noise) near += w[i];
    if (Math.abs(d) >= tukey * scale) return;
    sum += w[i] * d * d;
    kept += w[i];
  });
  return { rms: kept > 0 ? Math.sqrt(sum / kept) : Infinity, support: near / cloud.total };
}

/** Per path point: the unit tangent and the rotation-minimising frame's first normal. */
interface Frames {
  tangent: Float64Array;
  normal: Float64Array;
}
const frameCache = new WeakMap<EdgeCurve, Frames>();

/** Rotation-minimising frames along the path by double reflection (Wang et al. 2008). */
function framesOf(curve: EdgeCurve): Frames {
  const cached = frameCache.get(curve);
  if (cached) return cached;
  const p = curve.points,
    count = p.length / 3;
  const tangent = new Float64Array(count * 3),
    normal = new Float64Array(count * 3);
  const point = (i: number): V3 => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  for (let i = 0; i < count; i++) {
    const before = point(Math.max(0, i - 1)),
      after = point(Math.min(count - 1, i + 1));
    tangent.set(count > 1 ? unit3(sub3(after, before)) : [1, 0, 0], i * 3);
  }
  const t0 = tangent.subarray(0, 3);
  const helper: V3 =
    Math.abs(t0[0]) <= Math.abs(t0[1]) && Math.abs(t0[0]) <= Math.abs(t0[2])
      ? [1, 0, 0]
      : Math.abs(t0[1]) <= Math.abs(t0[2])
        ? [0, 1, 0]
        : [0, 0, 1];
  const h = dot3(helper, t0);
  normal.set(unit3([0, 1, 2].map((k) => helper[k] - h * t0[k]) as V3), 0);
  for (let i = 0; i < count - 1; i++) {
    const v1 = sub3(point(i + 1), point(i));
    const c1 = dot3(v1, v1);
    const r = Array.from(normal.subarray(i * 3, i * 3 + 3)) as V3;
    const t = Array.from(tangent.subarray(i * 3, i * 3 + 3)) as V3;
    if (!(c1 > 0)) {
      normal.set(r, i * 3 + 3);
      continue;
    }
    const rL = r.map((x, k) => x - (2 / c1) * dot3(v1, r) * v1[k]) as V3;
    const tL = t.map((x, k) => x - (2 / c1) * dot3(v1, t) * v1[k]) as V3;
    const next = Array.from(tangent.subarray(i * 3 + 3, i * 3 + 6)) as V3;
    const v2 = sub3(next, tL);
    const c2 = dot3(v2, v2);
    const out = c2 > 0 ? (rL.map((x, k) => x - (2 / c2) * dot3(v2, rL) * v2[k]) as V3) : rL;
    const along = dot3(out, next);
    normal.set(unit3(out.map((x, k) => x - along * next[k]) as V3), i * 3 + 3);
  }
  const frames = { tangent, normal };
  frameCache.set(curve, frames);
  return frames;
}

/** Writes the path point at `station` and its frame (tangent, normal, binormal) packed in nine. */
function frameAt(sweep: Sweep, station: number, at: Float64Array, frame: Float64Array) {
  const { points, lengths } = sweep.path;
  const count = lengths.length;
  const { tangent, normal } = framesOf(sweep.path);
  let i = 0,
    f = 0;
  if (count > 1) {
    let low = 0,
      high = count - 2;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lengths[middle] <= station) low = middle;
      else high = middle - 1;
    }
    i = low;
    const span = lengths[i + 1] - lengths[i];
    f = span > 0 ? Math.min(1, Math.max(0, (station - lengths[i]) / span)) : 0;
  }
  const j = Math.min(count - 1, i + 1);
  for (let k = 0; k < 3; k++) {
    at[k] = points[i * 3 + k] + (points[j * 3 + k] - points[i * 3 + k]) * f;
    frame[k] = tangent[i * 3 + k] + (tangent[j * 3 + k] - tangent[i * 3 + k]) * f;
    frame[3 + k] = normal[i * 3 + k] + (normal[j * 3 + k] - normal[i * 3 + k]) * f;
  }
  normalizeAt(frame, 0);
  const along = frame[0] * frame[3] + frame[1] * frame[4] + frame[2] * frame[5];
  for (let k = 0; k < 3; k++) frame[3 + k] -= along * frame[k];
  normalizeAt(frame, 3);
  frame[6] = frame[1] * frame[5] - frame[2] * frame[4];
  frame[7] = frame[2] * frame[3] - frame[0] * frame[5];
  frame[8] = frame[0] * frame[4] - frame[1] * frame[3];
}

const located = {
  station: 0,
  centre: new Float64Array(3),
  t: new Float64Array(3),
  u: new Float64Array(3),
  v: new Float64Array(3),
  along: 0,
  radius: 0,
  angle: 0,
};
const scratchFrame = new Float64Array(9);

/**
 * The nearest path point, its frame, and the point's offset from it: along the tangent (nonzero
 * only past the path's ends) and across it as a radius and an angle from the frame's normal.
 */
function locate(sweep: Sweep, x: number, y: number, z: number) {
  const station = closestOnCurve(sweep.path, x, y, z, located.centre);
  frameAt(sweep, station, located.centre, scratchFrame);
  located.t.set(scratchFrame.subarray(0, 3));
  located.u.set(scratchFrame.subarray(3, 6));
  located.v.set(scratchFrame.subarray(6, 9));
  const d = [x - located.centre[0], y - located.centre[1], z - located.centre[2]];
  const along = dot3(d, located.t);
  const a = dot3(d, located.u),
    b = dot3(d, located.v);
  located.station = station;
  located.along = along;
  located.radius = Math.hypot(a, b);
  located.angle = Math.atan2(b, a);
  return located;
}

/** The profile's radius at `angle`, linear between bin centres. */
function radiusAt(sweep: Sweep, angle: number) {
  const { profile } = sweep;
  const position = (angle / (2 * Math.PI)) * bins - 0.5;
  const floor = Math.floor(position);
  const f = position - floor;
  const k = ((floor % bins) + bins) % bins;
  return profile[k] + (profile[(k + 1) % bins] - profile[k]) * f;
}

function largestEigenvector(m: Float64Array): V3 {
  // Power iteration on the symmetric 3 x 3, started from its largest column.
  let best = 0;
  for (let c = 1; c < 3; c++) if (m[c * 4] > m[best * 4]) best = c;
  let v: V3 = [m[best], m[3 + best], m[6 + best]];
  for (let round = 0; round < 100; round++) {
    const next = unit3([
      m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
      m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
      m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ]);
    if (Math.abs(dot3(next, v)) > 1 - 1e-15) return next;
    v = next;
  }
  return v;
}

function circleThrough(a: V3, b: V3, c: V3) {
  const ab = sub3(b, a),
    ac = sub3(c, a);
  const normal = cross3(ab, ac);
  const nn = dot3(normal, normal);
  if (!(nn > 1e-18 * dot3(ab, ab) * dot3(ac, ac))) return null;
  const term = [0, 1, 2].map(
    (k) => (dot3(ac, ac) * cross3(normal, ab)[k] + dot3(ab, ab) * cross3(ac, normal)[k]) / (2 * nn),
  );
  const centre = [0, 1, 2].map((k) => a[k] + term[k]) as V3;
  return { centre, normal: unit3(normal), radius: Math.hypot(...sub3(a, centre)) };
}

/** `point` turned by `angle` about the line through `centre` along unit `axis`. */
function rotated(point: V3, centre: V3, axis: V3, angle: number): V3 {
  const d = sub3(point, centre);
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const k = cross3(axis, d);
  const along = dot3(axis, d) * (1 - c);
  return [0, 1, 2].map((m) => centre[m] + d[m] * c + k[m] * s + axis[m] * along) as V3;
}

function normalizeAt(a: Float64Array, offset: number) {
  const length = Math.hypot(a[offset], a[offset + 1], a[offset + 2]) || 1;
  for (let k = 0; k < 3; k++) a[offset + k] /= length;
}

const sub3 = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit3 = (a: V3): V3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

function median(values: number[]) {
  const sorted = [...values].sort((x, y) => x - y);
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function weightedMedian(values: Float64Array, weights: Float64Array) {
  const order = Array.from(values.keys()).sort((x, y) => values[x] - values[y]);
  let total = 0;
  for (const w of weights) total += w;
  let running = 0;
  for (const i of order) {
    running += weights[i];
    if (running >= total / 2) return values[i];
  }
  return values[order[order.length - 1]] ?? 0;
}
