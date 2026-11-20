import { EigenvalueDecomposition, Matrix, solve } from 'ml-matrix';

export type GuideKind = 'line' | 'arc' | 'spline';
export type GuideJoint = 'sharp' | 'smooth';
export interface EdgeCurve {
  /** Polyline at most `step` apart. */
  points: Float32Array;
  /** Distance along the curve at each point. */
  lengths: Float32Array;
  /** 1 at points that are sharp joints. */
  corner: Uint8Array;
  closed: boolean;
}

type V3 = [number, number, number];

/** Samples wrap into a full circle when no angular gap between them is wider than this. */
const wrapGap = Math.PI / 6;

const sub = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: ArrayLike<number>) => Math.hypot(a[0], a[1], a[2]);
const scaled = (a: ArrayLike<number>, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const unit = (a: ArrayLike<number>): V3 => scaled(a, 1 / (norm(a) || 1));
const pointAt = (flat: ArrayLike<number>, i: number): V3 => [
  flat[i * 3],
  flat[i * 3 + 1],
  flat[i * 3 + 2],
];

function makeCurve(flat: ArrayLike<number>, closed: boolean, corner?: Uint8Array): EdgeCurve {
  const points = Float32Array.from(flat);
  const count = points.length / 3;
  const lengths = new Float32Array(count);
  let total = 0;
  for (let i = 1; i < count; i++) {
    total += Math.hypot(
      points[i * 3] - points[i * 3 - 3],
      points[i * 3 + 1] - points[i * 3 - 2],
      points[i * 3 + 2] - points[i * 3 - 1],
    );
    lengths[i] = total;
  }
  return { points, lengths, corner: corner ?? new Uint8Array(count), closed };
}

/** Cumulative lengths of an open flat polyline. */
function cumulative(flat: ArrayLike<number>) {
  const count = flat.length / 3;
  const lengths = new Float64Array(count);
  for (let i = 1; i < count; i++)
    lengths[i] =
      lengths[i - 1] +
      Math.hypot(
        flat[i * 3] - flat[i * 3 - 3],
        flat[i * 3 + 1] - flat[i * 3 - 2],
        flat[i * 3 + 2] - flat[i * 3 - 1],
      );
  return lengths;
}

/** An open polyline resampled at equal spacing of at most `step`, keeping both ends. */
function resample(flat: ArrayLike<number>, step: number) {
  const lengths = cumulative(flat);
  const count = lengths.length;
  const total = lengths[count - 1];
  const segments = Math.max(1, Math.ceil(total / step - 1e-9));
  const result: number[] = [];
  let j = 0;
  for (let i = 0; i <= segments; i++) {
    const s = (total * i) / segments;
    while (j < count - 2 && lengths[j + 1] < s) j++;
    const span = lengths[j + 1] - lengths[j];
    const f = i === segments ? 1 : span > 0 ? Math.min(1, Math.max(0, (s - lengths[j]) / span)) : 0;
    for (let axis = 0; axis < 3; axis++)
      result.push(flat[j * 3 + axis] + (flat[j * 3 + 3 + axis] - flat[j * 3 + axis]) * f);
  }
  return result;
}

/** Centroid and principal directions (largest spread first) of flat points. */
function principal(samples: ArrayLike<number>) {
  const count = samples.length / 3;
  const mean: V3 = [0, 0, 0];
  for (let i = 0; i < count; i++) for (let a = 0; a < 3; a++) mean[a] += samples[i * 3 + a] / count;
  const covariance = Matrix.zeros(3, 3);
  for (let i = 0; i < count; i++) {
    const d = sub(pointAt(samples, i), mean);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) covariance.set(r, c, covariance.get(r, c) + d[r] * d[c]);
  }
  const eigen = new EigenvalueDecomposition(covariance, { assumeSymmetric: true });
  const order = eigen.realEigenvalues
    .map((value, i) => ({ value, i }))
    .sort((a, b) => b.value - a.value);
  const axes = order.map(({ i }) => unit(eigen.eigenvectorMatrix.getColumn(i)));
  return { mean, axes };
}

/** Points along the circle `centre + r (cos t u + sin t v)` for t from 0 to `sweep`. */
function arcPoints(
  centre: V3,
  u: V3,
  v: V3,
  r: number,
  sweep: number,
  step: number,
  full: boolean,
) {
  const segments = Math.max(1, Math.ceil((r * Math.abs(sweep)) / step - 1e-9));
  const result: number[] = [];
  for (let i = 0; i < (full ? segments : segments + 1); i++) {
    const t = (sweep * i) / segments;
    const [c, s] = [Math.cos(t), Math.sin(t)];
    for (let a = 0; a < 3; a++) result.push(centre[a] + r * (c * u[a] + s * v[a]));
  }
  return result;
}

function fitLine(samples: Float32Array, step: number) {
  const count = samples.length / 3;
  const { mean, axes } = principal(samples);
  let direction = axes[0];
  const along = (i: number) => dot(sub(pointAt(samples, i), mean), direction);
  if (along(count - 1) < along(0)) direction = scaled(direction, -1);
  let low = Infinity,
    high = -Infinity;
  for (let i = 0; i < count; i++) {
    low = Math.min(low, along(i));
    high = Math.max(high, along(i));
  }
  const ends = [low, high].flatMap((t) => [0, 1, 2].map((a) => mean[a] + direction[a] * t));
  return makeCurve(resample(ends, step), false);
}

/** Circle fit in 2D: algebraic start, then Gauss-Newton on the geometric distance. */
function fitCircle2(a: Float64Array, b: Float64Array) {
  const count = a.length;
  const design = new Matrix(count, 3),
    right = new Matrix(count, 1);
  for (let i = 0; i < count; i++) {
    design.setRow(i, [a[i], b[i], 1]);
    right.set(i, 0, -(a[i] * a[i] + b[i] * b[i]));
  }
  const [d, e, f] = solve(design, right, true).getColumn(0);
  let cx = -d / 2,
    cy = -e / 2,
    r = Math.sqrt(Math.max(0, cx * cx + cy * cy - f));
  for (let round = 0; round < 20; round++) {
    const jacobian = new Matrix(count, 3),
      residual = new Matrix(count, 1);
    for (let i = 0; i < count; i++) {
      const [dx, dy] = [a[i] - cx, b[i] - cy];
      const distance = Math.hypot(dx, dy) || 1e-12;
      jacobian.setRow(i, [-dx / distance, -dy / distance, -1]);
      residual.set(i, 0, -(distance - r));
    }
    const [sx, sy, sr] = solve(jacobian, residual, true).getColumn(0);
    cx += sx;
    cy += sy;
    r += sr;
    if (Math.hypot(sx, sy, sr) < 1e-12 * Math.max(1, r)) break;
  }
  return { cx, cy, r };
}

function fitArc(samples: Float32Array, step: number) {
  const count = samples.length / 3;
  const { mean, axes } = principal(samples);
  const [u0, v0] = axes;
  const a = new Float64Array(count),
    b = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const d = sub(pointAt(samples, i), mean);
    a[i] = dot(d, u0);
    b[i] = dot(d, v0);
  }
  const { cx, cy, r } = fitCircle2(a, b);
  const centre: V3 = [0, 1, 2].map((k) => mean[k] + cx * u0[k] + cy * v0[k]) as V3;
  const angles = Array.from(a, (x, i) => Math.atan2(b[i] - cy, x - cx));
  const sorted = [...angles].sort((x, y) => x - y);
  let gap = sorted[0] + Math.PI * 2 - sorted[count - 1],
    gapEnd = sorted[0];
  for (let i = 1; i < count; i++)
    if (sorted[i] - sorted[i - 1] > gap) {
      gap = sorted[i] - sorted[i - 1];
      gapEnd = sorted[i];
    }
  const wrap = (t: number) => ((t % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const full = gap < wrapGap;
  let start: number, sweep: number;
  if (full) {
    let winding = 0;
    for (let i = 1; i < count; i++) winding += wrap(angles[i] - angles[i - 1] + Math.PI) - Math.PI;
    start = angles[0];
    sweep = winding < 0 ? -Math.PI * 2 : Math.PI * 2;
  } else {
    const span = Math.PI * 2 - gap;
    const forward = wrap(angles[0] - gapEnd) <= wrap(angles[count - 1] - gapEnd);
    start = forward ? gapEnd : gapEnd + span;
    sweep = forward ? span : -span;
  }
  const [c, s] = [Math.cos(start), Math.sin(start)];
  const u = [0, 1, 2].map((k) => c * u0[k] + s * v0[k]) as V3;
  const v = [0, 1, 2].map((k) => c * v0[k] - s * u0[k]) as V3;
  return makeCurve(arcPoints(centre, u, v, r, sweep, step, full), full);
}

/** Uniform clamped cubic knots over [0, 1] for `controls` control points. */
function basis(controls: number, t: number, out: Float64Array) {
  const inner = controls - 3;
  const knot = (k: number) => Math.min(1, Math.max(0, (k - 3) / inner));
  const span = Math.min(controls - 1, 3 + Math.floor(t * inner));
  const left = new Float64Array(4),
    right = new Float64Array(4);
  out[0] = 1;
  for (let j = 1; j <= 3; j++) {
    left[j] = t - knot(span + 1 - j);
    right[j] = knot(span + j) - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const temp = out[r] / (right[r + 1] + left[j - r]);
      out[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    out[j] = saved;
  }
  return span - 3;
}

function fitSpline(samples: Float32Array, controls: number, step: number) {
  const count = samples.length / 3;
  const m = Math.min(Math.max(4, controls), count);
  const chord = cumulative(samples);
  const total = chord[count - 1] || 1;
  const { mean } = principal(samples);
  const design = Matrix.zeros(count, m),
    right = new Matrix(count, 3);
  const weights = new Float64Array(4);
  for (let i = 0; i < count; i++) {
    const first = basis(m, chord[i] / total, weights);
    for (let k = 0; k < 4; k++) design.set(i, first + k, weights[k]);
    right.setRow(i, sub(pointAt(samples, i), mean));
  }
  const control = solve(design, right, true);
  const dense = Math.max(16, Math.ceil(total / step) * 4);
  const flat: number[] = [];
  for (let i = 0; i <= dense; i++) {
    const first = basis(m, i / dense, weights);
    for (let a = 0; a < 3; a++) {
      let value = mean[a];
      for (let k = 0; k < 4; k++) value += weights[k] * control.get(first + k, a);
      flat.push(value);
    }
  }
  return makeCurve(resample(flat, step), false);
}

/** `controls` is the number of points the user placed; it sets a spline's freedom. */
export function fitCurve(
  kind: GuideKind,
  samples: Float32Array,
  controls: number,
  step: number,
): EdgeCurve {
  const count = samples.length / 3;
  if (count < 2) return makeCurve(samples, false);
  if (kind === 'arc' && count >= 3) return fitArc(samples, step);
  if (kind === 'spline' && count >= 4) return fitSpline(samples, controls, step);
  return fitLine(samples, step);
}

/** Circle through three points, or undefined when they are collinear. */
function circleThrough(p0: V3, p1: V3, p2: V3) {
  const a = sub(p1, p0),
    b = sub(p2, p0);
  const n = cross(a, b);
  const nn = dot(n, n);
  if (nn < 1e-12 * dot(a, a) * dot(b, b)) return undefined;
  const offset = scaled(
    [0, 1, 2].map((k) => dot(a, a) * cross(b, n)[k] + dot(b, b) * cross(n, a)[k]),
    1 / (2 * nn),
  );
  const centre = [0, 1, 2].map((k) => p0[k] + offset[k]) as V3;
  return { centre, normal: unit(n), radius: norm(offset) };
}

/** Points beyond one end of a curve, `step` apart, in the direction of travel away from it. */
function extension(curve: EdgeCurve, kind: GuideKind, atEnd: boolean, step: number) {
  const p = curve.points,
    count = p.length / 3;
  const length = curve.lengths[count - 1];
  const reach = Math.max(length, 50 * step);
  const end = pointAt(p, atEnd ? count - 1 : 0);
  const circle =
    kind === 'arc' && count >= 3
      ? circleThrough(pointAt(p, 0), pointAt(p, count >> 1), pointAt(p, count - 1))
      : undefined;
  if (circle) {
    const angle = Math.min(
      reach / circle.radius,
      Math.max(0, Math.PI - length / circle.radius / 2),
    );
    const u = unit(sub(end, circle.centre));
    const v = scaled(cross(circle.normal, u), atEnd ? 1 : -1);
    return arcPoints(circle.centre, u, v, circle.radius, angle, step, false).slice(3);
  }
  const direction = atEnd ? unit(sub(end, pointAt(p, count - 2))) : unit(sub(end, pointAt(p, 1)));
  const segments = Math.ceil(reach / step);
  const result: number[] = [];
  for (let i = 1; i <= segments; i++)
    for (let a = 0; a < 3; a++) result.push(end[a] + (direction[a] * reach * i) / segments);
  return result;
}

/** A curve extended at both ends, with stations measured from its original start. */
interface Extended {
  flat: Float64Array;
  stations: Float64Array;
  length: number;
}

function extend(curve: EdgeCurve, kind: GuideKind, step: number): Extended {
  const before = extension(curve, kind, false, step),
    after = extension(curve, kind, true, step);
  const back: number[] = [];
  for (let i = before.length / 3 - 1; i >= 0; i--) back.push(...pointAt(before, i));
  const flat = Float64Array.from([...back, ...curve.points, ...after]);
  const stations = cumulative(flat);
  const origin = stations[back.length / 3];
  for (let i = 0; i < stations.length; i++) stations[i] -= origin;
  return { flat, stations, length: curve.lengths[curve.lengths.length - 1] };
}

/** Parameters of the closest points of segments p0-p1 and q0-q1. */
function segmentPair(p0: V3, p1: V3, q0: V3, q1: V3) {
  const d1 = sub(p1, p0),
    d2 = sub(q1, q0),
    r = sub(p0, q0);
  const a = dot(d1, d1),
    e = dot(d2, d2),
    f = dot(d2, r);
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  let s: number, t: number;
  if (a <= 1e-30 && e <= 1e-30) return { s: 0, t: 0 };
  if (a <= 1e-30) {
    s = 0;
    t = clamp(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-30) {
      t = 0;
      s = clamp(-c / a);
    } else {
      const b = dot(d1, d2),
        denominator = a * e - b * b;
      s = denominator > 1e-30 ? clamp((b * f - c * e) / denominator) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a);
      }
    }
  }
  return { s, t };
}

const lerp = (flat: ArrayLike<number>, i: number, f: number): V3 =>
  [0, 1, 2].map((a) => flat[i * 3 + a] + (flat[i * 3 + 3 + a] - flat[i * 3 + a]) * f) as V3;

/** Stations and midpoint of the closest approach of two index ranges of extended curves. */
function closestApproach(A: Extended, a0: number, a1: number, B: Extended, b0: number, b1: number) {
  let best = { distance: Infinity, i: a0, j: b0, s: 0, t: 0 };
  const search = (i0: number, i1: number, j0: number, j1: number, stride: number) => {
    for (let i = i0; i < i1; i += stride) {
      const ie = Math.min(i + stride, i1);
      const [p0, p1] = [pointAt(A.flat, i), pointAt(A.flat, ie)];
      for (let j = j0; j < j1; j += stride) {
        const je = Math.min(j + stride, j1);
        const [q0, q1] = [pointAt(B.flat, j), pointAt(B.flat, je)];
        const { s, t } = segmentPair(p0, p1, q0, q1);
        const distance = norm(sub(lerp([...p0, ...p1], 0, s), lerp([...q0, ...q1], 0, t)));
        if (distance < best.distance) best = { distance, i, j, s: s * (ie - i), t: t * (je - j) };
      }
    }
  };
  const stride = Math.max(1, Math.ceil(Math.max(a1 - a0, b1 - b0) / 128));
  search(a0, a1, b0, b1, stride);
  if (stride > 1) {
    const { i, j } = best;
    best.distance = Infinity;
    search(
      Math.max(a0, i - 2 * stride),
      Math.min(a1, i + 3 * stride),
      Math.max(b0, j - 2 * stride),
      Math.min(b1, j + 3 * stride),
      1,
    );
  }
  // Positions are fractional point indices; the last point is reached as the end of its segment.
  const locate = (E: Extended, position: number) => {
    const k = Math.min(Math.floor(position), E.stations.length - 2);
    const f = position - k;
    return {
      point: lerp(E.flat, k, f),
      station: E.stations[k] + (E.stations[k + 1] - E.stations[k]) * f,
    };
  };
  const [a, b] = [locate(A, best.i + best.s), locate(B, best.j + best.t)];
  const [pa, pb] = [a.point, b.point];
  return {
    stationA: a.station,
    stationB: b.station,
    middle: [0, 1, 2].map((k) => (pa[k] + pb[k]) / 2) as V3,
  };
}

/** First index whose station is at least `s`. */
function indexAt(E: Extended, s: number) {
  let i = 0;
  while (i < E.stations.length - 1 && E.stations[i] < s) i++;
  return i;
}

/** Trims or extends neighbours to where they come closest and joins them into one curve. */
export function joinCurves(
  curves: EdgeCurve[],
  kinds: GuideKind[],
  joints: GuideJoint[],
  closed: boolean,
  step: number,
): EdgeCurve {
  const n = curves.length;
  if (joints.length !== (closed ? n : n - 1))
    throw new Error('A path needs one joint between each pair of neighbouring curves.');
  const extended = curves.map((curve, i) => extend(curve, kinds[i], step));
  const starts = extended.map(() => ({ station: 0, point: undefined as V3 | undefined }));
  const ends = extended.map((E) => ({ station: E.length, point: undefined as V3 | undefined }));
  joints.forEach((_, k) => {
    const [A, B] = [extended[k], extended[(k + 1) % n]];
    const { stationA, stationB, middle } = closestApproach(
      A,
      indexAt(A, A.length / 2),
      A.stations.length - 1,
      B,
      0,
      Math.max(1, indexAt(B, B.length / 2)),
    );
    ends[k] = { station: stationA, point: middle };
    starts[(k + 1) % n] = { station: stationB, point: middle };
  });
  const flat: number[] = [],
    corner: number[] = [];
  extended.forEach((E, i) => {
    const [from, to] = [starts[i], ends[i]];
    const piece: number[] = [...(from.point ?? interpolate(E, from.station))];
    for (let k = 0; k < E.stations.length; k++)
      if (E.stations[k] > from.station && E.stations[k] < to.station)
        piece.push(...pointAt(E.flat, k));
    piece.push(...(to.point ?? interpolate(E, to.station)));
    const points = resample(piece, step);
    const keepLast = !closed && i === n - 1;
    const count = points.length / 3 - (keepLast ? 0 : 1);
    const sharp = i > 0 || closed ? joints[(i + n - 1) % n] === 'sharp' : false;
    for (let k = 0; k < count; k++) {
      flat.push(points[k * 3], points[k * 3 + 1], points[k * 3 + 2]);
      corner.push(k === 0 && sharp ? 1 : 0);
    }
  });
  return makeCurve(flat, closed, Uint8Array.from(corner));
}

function interpolate(E: Extended, s: number): V3 {
  const i = Math.min(Math.max(0, indexAt(E, s) - 1), E.stations.length - 2);
  const span = E.stations[i + 1] - E.stations[i];
  return lerp(E.flat, i, span > 0 ? (s - E.stations[i]) / span : 0);
}

/** Bounding spheres of runs of segments, for pruning the closest point search. */
interface Blocks {
  size: number;
  centres: Float64Array;
  radii: Float64Array;
}
const blockCache = new WeakMap<EdgeCurve, Blocks>();

const segmentCount = (curve: EdgeCurve) => {
  const count = curve.points.length / 3;
  return curve.closed ? count : count - 1;
};

function blocksOf(curve: EdgeCurve) {
  const cached = blockCache.get(curve);
  if (cached) return cached;
  const p = curve.points,
    count = p.length / 3;
  const segments = segmentCount(curve);
  const size = Math.max(8, Math.ceil(Math.sqrt(segments)));
  const blocks = Math.ceil(segments / size);
  const centres = new Float64Array(blocks * 3),
    radii = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    const first = b * size,
      last = Math.min(segments, first + size);
    const low = [Infinity, Infinity, Infinity],
      high = [-Infinity, -Infinity, -Infinity];
    for (let i = first; i <= last; i++)
      for (let a = 0; a < 3; a++) {
        const value = p[(i % count) * 3 + a];
        low[a] = Math.min(low[a], value);
        high[a] = Math.max(high[a], value);
      }
    for (let a = 0; a < 3; a++) centres[b * 3 + a] = (low[a] + high[a]) / 2;
    radii[b] = Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]) / 2;
  }
  const result = { size, centres, radii };
  blockCache.set(curve, result);
  return result;
}

/** Writes the closest point; returns its distance along the curve. */
export function closestOnCurve(
  curve: EdgeCurve,
  x: number,
  y: number,
  z: number,
  out: Float32Array,
): number {
  const p = curve.points,
    count = p.length / 3;
  if (count < 2) {
    out.set(p.subarray(0, 3));
    return 0;
  }
  const segments = segmentCount(curve);
  const { size, centres, radii } = blocksOf(curve);
  const blocks = radii.length;
  let best = Infinity,
    bestSegment = 0,
    bestF = 0;
  const scan = (b: number) => {
    const last = Math.min(segments, (b + 1) * size);
    for (let i = b * size; i < last; i++) {
      const j = (i + 1) % count;
      const [ax, ay, az] = [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
      const [dx, dy, dz] = [p[j * 3] - ax, p[j * 3 + 1] - ay, p[j * 3 + 2] - az];
      const dd = dx * dx + dy * dy + dz * dz;
      const f =
        dd > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / dd)) : 0;
      const distance = (ax + dx * f - x) ** 2 + (ay + dy * f - y) ** 2 + (az + dz * f - z) ** 2;
      if (distance < best) {
        best = distance;
        bestSegment = i;
        bestF = f;
      }
    }
  };
  const bound = (b: number) =>
    Math.max(
      0,
      Math.hypot(centres[b * 3] - x, centres[b * 3 + 1] - y, centres[b * 3 + 2] - z) - radii[b],
    );
  let nearest = 0;
  for (let b = 1; b < blocks; b++) if (bound(b) < bound(nearest)) nearest = b;
  scan(nearest);
  for (let b = 0; b < blocks; b++) if (b !== nearest && bound(b) ** 2 < best) scan(b);
  const j = (bestSegment + 1) % count;
  for (let a = 0; a < 3; a++)
    out[a] = p[bestSegment * 3 + a] + (p[j * 3 + a] - p[bestSegment * 3 + a]) * bestF;
  const span = Math.hypot(
    p[j * 3] - p[bestSegment * 3],
    p[j * 3 + 1] - p[bestSegment * 3 + 1],
    p[j * 3 + 2] - p[bestSegment * 3 + 2],
  );
  return curve.lengths[bestSegment] + span * bestF;
}

export function curveTangent(curve: EdgeCurve, station: number, out: Float32Array): void {
  const p = curve.points,
    count = p.length / 3;
  if (count < 2) {
    out.fill(0);
    return;
  }
  const segments = segmentCount(curve);
  const direction = (i: number) => {
    const k = ((i % segments) + segments) % segments;
    return unit(sub(pointAt(p, (k + 1) % count), pointAt(p, k)));
  };
  const last = curve.lengths[count - 1];
  const total = curve.closed ? last + norm(sub(pointAt(p, 0), pointAt(p, count - 1))) : last;
  let s = curve.closed
    ? ((station % total) + total) % total
    : Math.min(Math.max(station, 0), total);
  let low = 0,
    high = count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (curve.lengths[middle] <= s) low = middle;
    else high = middle - 1;
  }
  const i = Math.min(low, segments - 1);
  const j = (i + 1) % count;
  const span = (j === 0 ? total : curve.lengths[j]) - curve.lengths[i];
  s = span > 0 ? Math.min(1, Math.max(0, (s - curve.lengths[i]) / span)) : 0;
  const here = direction(i);
  const smooth = (vertex: number) =>
    curve.corner[vertex] === 0 && (curve.closed || (vertex > 0 && vertex < count - 1));
  const start = smooth(i) ? unit(direction(i - 1).map((v, a) => v + here[a])) : here;
  const end = smooth(j) ? unit(direction(i + 1).map((v, a) => v + here[a])) : here;
  const blended = unit([0, 1, 2].map((a) => start[a] + (end[a] - start[a]) * s));
  out.set(blended);
}

/** Catmull-Rom (centripetal) through the points, densely sampled. */
function catmullRom(points: Float32Array, step: number) {
  const count = points.length / 3;
  const at = (i: number) => pointAt(points, Math.min(count - 1, Math.max(0, i)));
  const flat: number[] = [];
  for (let k = 0; k < count - 1; k++) {
    let [p0, p1, p2, p3] = [at(k - 1), at(k), at(k + 1), at(k + 2)];
    // Mirrored phantom points at the ends keep the end tangents along the end chords.
    if (k === 0) p0 = sub(scaled(p1, 2), p2);
    if (k === count - 2) p3 = sub(scaled(p2, 2), p1);
    const knot = (a: V3, b: V3) => Math.max(Math.sqrt(norm(sub(b, a))), 1e-9);
    const t1 = knot(p0, p1),
      t2 = t1 + knot(p1, p2),
      t3 = t2 + knot(p2, p3);
    const pieces = Math.max(8, Math.ceil(norm(sub(p2, p1)) / step) * 4);
    for (let i = k === 0 ? 0 : 1; i <= pieces; i++) {
      const t = t1 + ((t2 - t1) * i) / pieces;
      const mix = (a: V3, b: V3, ta: number, tb: number) =>
        [0, 1, 2].map((c) => ((tb - t) * a[c] + (t - ta) * b[c]) / (tb - ta)) as V3;
      const a1 = mix(p0, p1, 0, t1),
        a2 = mix(p1, p2, t1, t2),
        a3 = mix(p2, p3, t2, t3);
      const b1 = mix(a1, a2, 0, t2),
        b2 = mix(a2, a3, t1, t3);
      flat.push(...mix(b1, b2, t1, t2));
    }
  }
  return flat;
}

/** The guide the user drew, before any fitting: a chord, a circle through three points, or Catmull-Rom. */
export function drawnCurve(kind: GuideKind, points: Float32Array, step: number): EdgeCurve {
  const count = points.length / 3;
  if (count < 2) return makeCurve(points, false);
  const [first, last] = [pointAt(points, 0), pointAt(points, count - 1)];
  if (kind === 'arc' && count >= 3) {
    const middle = pointAt(points, count >> 1);
    const circle = circleThrough(first, middle, last);
    if (circle) {
      const u = unit(sub(first, circle.centre));
      const v = cross(circle.normal, u);
      const target = sub(last, circle.centre);
      let sweep = Math.atan2(dot(target, v), dot(target, u));
      if (sweep <= 0) sweep += Math.PI * 2;
      return makeCurve(arcPoints(circle.centre, u, v, circle.radius, sweep, step, false), false);
    }
  }
  if (kind === 'spline' && count >= 3)
    return makeCurve(resample(catmullRom(points, step), step), false);
  return makeCurve(resample([...first, ...last], step), false);
}
