import { EigenvalueDecomposition, Matrix, solve } from 'ml-matrix';

export type GuideKind = 'line' | 'arc' | 'spline';
export type GuideJoint = 'sharp' | 'smooth';
/**
 * A guide curve. Curves are immutable: never write into `points`, `lengths` or `corner` after one
 * is made. `closestOnCurve` caches a lookup index per curve and only notices edits that change
 * the point count or a few sampled points.
 */
export interface EdgeCurve {
  /** Polyline at most `step` apart, in world space. */
  points: Float64Array;
  /** Distance along the curve at each point. */
  lengths: Float64Array;
  /** 1 at points that are sharp joints. */
  corner: Uint8Array;
  closed: boolean;
}

type V3 = [number, number, number];

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
const distance = (a: ArrayLike<number>, b: ArrayLike<number>) => norm(sub(a, b));
const scaled = (a: ArrayLike<number>, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const unit = (a: ArrayLike<number>): V3 => scaled(a, 1 / (norm(a) || 1));
const pointAt = (flat: ArrayLike<number>, i: number): V3 => [
  flat[i * 3],
  flat[i * 3 + 1],
  flat[i * 3 + 2],
];
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Equal segments of at most `step` along a span of `length`. */
function segmentsFor(length: number, step: number) {
  const segments = Math.max(1, Math.ceil(length / step));
  if (!(segments <= 5_000_000)) throw new RangeError('This guide is too long for its step.');
  return segments;
}

/** A curve over `points`, which it keeps. */
function makeCurve(points: Float64Array, closed: boolean, corner?: Uint8Array): EdgeCurve {
  const count = points.length / 3;
  const lengths = new Float64Array(count);
  let total = 0;
  for (let i = 1; i < count; i++) {
    const [dx, dy, dz] = [
      points[i * 3] - points[i * 3 - 3],
      points[i * 3 + 1] - points[i * 3 - 2],
      points[i * 3 + 2] - points[i * 3 - 1],
    ];
    total += Math.sqrt(dx * dx + dy * dy + dz * dz);
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
  if (!(total > 0)) return Float64Array.of(flat[0], flat[1], flat[2]);
  const segments = segmentsFor(total, step);
  const result = new Float64Array((segments + 1) * 3);
  let j = 0;
  for (let i = 0; i <= segments; i++) {
    const s = (total * i) / segments;
    while (j < count - 2 && lengths[j + 1] < s) j++;
    const span = lengths[j + 1] - lengths[j];
    const f = i === segments ? 1 : span > 0 ? clamp((s - lengths[j]) / span, 0, 1) : 0;
    for (let axis = 0; axis < 3; axis++)
      result[i * 3 + axis] = flat[j * 3 + axis] + (flat[j * 3 + 3 + axis] - flat[j * 3 + axis]) * f;
  }
  return result;
}

/** Centroid, principal directions and their variances (largest spread first) of flat points. */
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
  return { mean, axes, values: order.map(({ value }) => Math.max(0, value)) };
}

/** The samples' bounding box grown by its own diagonal, which no fit may leave. */
function boxOf(samples: ArrayLike<number>) {
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < samples.length; i++) {
    low[i % 3] = Math.min(low[i % 3], samples[i]);
    high[i % 3] = Math.max(high[i % 3], samples[i]);
  }
  const diagonal = Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]);
  return (flat: ArrayLike<number>) => {
    for (let i = 0; i < flat.length; i++)
      if (flat[i] < low[i % 3] - diagonal || flat[i] > high[i % 3] + diagonal) return false;
    return true;
  };
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
  const segments = segmentsFor(r * Math.abs(sweep), step);
  const result: number[] = [];
  for (let i = 0; i < (full ? segments : segments + 1); i++) {
    const t = (sweep * i) / segments;
    const [c, s] = [Math.cos(t), Math.sin(t)];
    for (let a = 0; a < 3; a++) result.push(centre[a] + r * (c * u[a] + s * v[a]));
  }
  return Float64Array.from(result);
}

function fitLine(samples: ArrayLike<number>, step: number) {
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

function fitArc(samples: ArrayLike<number>, step: number) {
  const count = samples.length / 3;
  const { mean, axes, values } = principal(samples);
  // Samples with no spread across their line hold no curvature to fit.
  if (!(values[1] > 1e-12 * values[0])) return fitLine(samples, step);
  const [u0, v0, w0] = axes;
  const a = new Float64Array(count),
    b = new Float64Array(count);
  let scatter = 0;
  for (let i = 0; i < count; i++) {
    const d = sub(pointAt(samples, i), mean);
    a[i] = dot(d, u0);
    b[i] = dot(d, v0);
    scatter = Math.max(scatter, Math.hypot(b[i], dot(d, w0)));
  }
  const { cx, cy, r } = fitCircle2(a, b);
  if (!(r > 0) || !Number.isFinite(cx + cy + r)) return fitLine(samples, step);
  const centre: V3 = [0, 1, 2].map((k) => mean[k] + cx * u0[k] + cy * v0[k]) as V3;
  const angles = Array.from(a, (x, i) => Math.atan2(b[i] - cy, x - cx));
  const sorted = [...angles].sort((x, y) => x - y);
  let gap = sorted[0] + Math.PI * 2 - sorted[count - 1],
    gapEnd = sorted[0];
  const gaps = [gap];
  for (let i = 1; i < count; i++) {
    gaps.push(sorted[i] - sorted[i - 1]);
    if (sorted[i] - sorted[i - 1] > gap) {
      gap = sorted[i] - sorted[i - 1];
      gapEnd = sorted[i];
    }
  }
  const span = Math.PI * 2 - gap;
  // The circle only resolves curvature when its sagitta over the samples beats their scatter.
  if (r * (1 - Math.cos(span / 2)) <= scatter) return fitLine(samples, step);
  gaps.sort((x, y) => x - y);
  const median = count % 2 ? gaps[count >> 1] : (gaps[count / 2 - 1] + gaps[count / 2]) / 2;
  const full = gap <= 3 * median;
  const wrap = (t: number) => ((t % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  let start: number, sweep: number;
  if (full) {
    let winding = 0;
    for (let i = 1; i < count; i++) winding += wrap(angles[i] - angles[i - 1] + Math.PI) - Math.PI;
    start = angles[0];
    sweep = winding < 0 ? -Math.PI * 2 : Math.PI * 2;
  } else {
    const forward = wrap(angles[0] - gapEnd) <= wrap(angles[count - 1] - gapEnd);
    start = forward ? gapEnd : gapEnd + span;
    sweep = forward ? span : -span;
  }
  const [c, s] = [Math.cos(start), Math.sin(start)];
  const u = [0, 1, 2].map((k) => c * u0[k] + s * v0[k]) as V3;
  const v = [0, 1, 2].map((k) => c * v0[k] - s * u0[k]) as V3;
  const curve = makeCurve(arcPoints(centre, u, v, r, sweep, step, full), full);
  return boxOf(samples)(curve.points) ? curve : fitLine(samples, step);
}

/** Clamped uniform B-spline basis on [0, 1]; writes the nonzero weights, returns the first index. */
function basis(controls: number, degree: number, t: number, out: Float64Array) {
  const inner = controls - degree;
  const knot = (k: number) => clamp((k - degree) / inner, 0, 1);
  const span = Math.min(controls - 1, degree + Math.floor(t * inner));
  const left = new Float64Array(degree + 1),
    right = new Float64Array(degree + 1);
  out[0] = 1;
  for (let j = 1; j <= degree; j++) {
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
  return span - degree;
}

/** Least squares clamped B-spline with `controls` control points, of degree up to 3. */
function splineThrough(
  samples: ArrayLike<number>,
  params: Float64Array,
  mean: V3,
  controls: number,
) {
  const count = samples.length / 3;
  const degree = Math.min(3, controls - 1);
  const weights = new Float64Array(4);
  const design = Matrix.zeros(count, controls),
    right = new Matrix(count, 3);
  for (let i = 0; i < count; i++) {
    const first = basis(controls, degree, params[i], weights);
    for (let k = 0; k <= degree; k++) design.set(i, first + k, weights[k]);
    right.setRow(i, sub(pointAt(samples, i), mean));
  }
  const control = solve(design, right, true);
  return (t: number): V3 => {
    const first = basis(controls, degree, t, weights);
    const point: V3 = [...mean];
    for (let a = 0; a < 3; a++)
      for (let k = 0; k <= degree; k++) point[a] += weights[k] * control.get(first + k, a);
    return point;
  };
}

/** Distance from `p` to segment `a`-`b`. */
function segmentDistance(p: V3, a: V3, b: V3) {
  const d = sub(b, a);
  const dd = dot(d, d);
  const f = dd > 0 ? clamp(dot(sub(p, a), d) / dd, 0, 1) : 0;
  return distance(p, [a[0] + d[0] * f, a[1] + d[1] * f, a[2] + d[2] * f]);
}

/** Whether every point of `flat` (spread evenly over the samples' chord) lies within `limit` of their polyline. */
function staysNear(flat: number[], samples: ArrayLike<number>, chord: Float64Array, limit: number) {
  const count = samples.length / 3,
    dense = flat.length / 3;
  const total = chord[count - 1];
  const toSegment = (p: V3, k: number) =>
    k < 0 || k > count - 2
      ? Infinity
      : segmentDistance(p, pointAt(samples, k), pointAt(samples, k + 1));
  let k = 0;
  for (let i = 0; i < dense; i++) {
    const p = pointAt(flat, i);
    const s = (total * i) / (dense - 1);
    while (k < count - 2 && chord[k + 1] < s) k++;
    let near = Math.min(toSegment(p, k - 1), toSegment(p, k), toSegment(p, k + 1));
    for (let j = 0; j < count - 1 && near > limit; j++) near = Math.min(near, toSegment(p, j));
    if (near > limit) return false;
  }
  return true;
}

function fitSpline(samples: ArrayLike<number>, controls: number, step: number) {
  const count = samples.length / 3;
  const chord = cumulative(samples);
  const total = chord[count - 1];
  if (!(total > 0)) return fitLine(samples, step);
  const params = chord.map((c) => c / total);
  const { mean } = principal(samples);
  const holds = boxOf(samples);
  const dense = Math.max(16, Math.ceil(total / step) * 4);
  // Fewer controls, down to a line, until the curve stops straying between the samples.
  for (let m = Math.min(Math.max(4, controls), count); m >= 2; m--) {
    const at = splineThrough(samples, params, mean, m);
    let residual = 0;
    for (let i = 0; i < count; i++)
      residual = Math.max(residual, distance(at(params[i]), pointAt(samples, i)));
    const flat: number[] = [];
    for (let i = 0; i <= dense; i++) flat.push(...at(i / dense));
    if (holds(flat) && staysNear(flat, samples, chord, 2 * residual + step))
      return makeCurve(resample(flat, step), false);
  }
  return fitLine(samples, step);
}

/** `controls` is the number of points the user placed; it sets a spline's freedom. */
export function fitCurve(
  kind: GuideKind,
  samples: ArrayLike<number>,
  controls: number,
  step: number,
): EdgeCurve {
  const count = samples.length / 3;
  if (count < 2) return makeCurve(new Float64Array(samples), false);
  if (kind === 'arc' && count >= 3) return fitArc(samples, step);
  if (kind === 'spline') return fitSpline(samples, controls, step);
  return fitLine(samples, step);
}

/** Circle through three points, or undefined when they are collinear or repeated. */
function circleThrough(p0: V3, p1: V3, p2: V3) {
  const a = sub(p1, p0),
    b = sub(p2, p0);
  const n = cross(a, b);
  const nn = dot(n, n);
  if (nn <= 1e-12 * dot(a, a) * dot(b, b)) return undefined;
  const offset = scaled(
    [0, 1, 2].map((k) => dot(a, a) * cross(b, n)[k] + dot(b, b) * cross(n, a)[k]),
    1 / (2 * nn),
  );
  const centre = [0, 1, 2].map((k) => p0[k] + offset[k]) as V3;
  return { centre, normal: unit(n), radius: norm(offset) };
}

/** Gaps within this of the smallest are ties, settled by nearness to the nominal joint. */
const tie = 1e-9;
/** Directions closer than this many radians are parallel: rounding hides where they would cross. */
const parallel = 1e-6;
/** Neighbours whose closest approach is below this many mm meet: no bridge is drawn between them. */
const meet = 1e-6;
/** Circle angles are sampled this many times a turn to bracket each local minimum of a gap. */
const turnSamples = 720;
const turn = Math.PI * 2;

/** A straight piece `o + d t` (d unit, or zero for a point) for t in [lo, hi], at station `base + t`. */
interface Straight {
  o: V3;
  d: V3;
  lo: number;
  hi: number;
  base: number;
  /** Bounding sphere; infinite radius when unbounded. */
  centre: V3;
  radius: number;
}

/** Consecutive pieces `first` to `last` of a straight carrier, inside one sphere. */
interface Group {
  first: number;
  last: number;
  centre: V3;
  radius: number;
}

/** A curve's analytic carrier: its infinite line, its full circle, or its polyline with end rays. */
type Carrier =
  | { kind: 'straight'; pieces: Straight[]; groups: Group[] }
  | { kind: 'circle'; c: V3; u: V3; v: V3; r: number };

const straightPoint = (x: Straight, t: number): V3 => [
  x.o[0] + x.d[0] * t,
  x.o[1] + x.d[1] * t,
  x.o[2] + x.d[2] * t,
];
const nearestOnStraight = (x: Straight, p: V3) =>
  clamp(dot(x.d, x.d) > 0 ? dot(sub(p, x.o), x.d) / dot(x.d, x.d) : 0, x.lo, x.hi);

function straightPiece(o: V3, d: V3, lo: number, hi: number, base: number): Straight {
  const bounded = Number.isFinite(lo) && Number.isFinite(hi);
  return {
    o,
    d,
    lo,
    hi,
    base,
    centre: bounded ? ([0, 1, 2].map((k) => o[k] + (d[k] * (lo + hi)) / 2) as V3) : o,
    radius: bounded ? (norm(d) * (hi - lo)) / 2 : Infinity,
  };
}

function groupOf(pieces: Straight[], first: number, last: number): Group {
  if (first === last)
    return { first, last, centre: pieces[first].centre, radius: pieces[first].radius };
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let k = first; k <= last; k++)
    for (let a = 0; a < 3; a++) {
      low[a] = Math.min(low[a], pieces[k].centre[a] - pieces[k].radius);
      high[a] = Math.max(high[a], pieces[k].centre[a] + pieces[k].radius);
    }
  const centre = [0, 1, 2].map((a) => (low[a] + high[a]) / 2) as V3;
  let radius = 0;
  for (let k = first; k <= last; k++)
    radius = Math.max(radius, distance(pieces[k].centre, centre) + pieces[k].radius);
  return { first, last, centre, radius };
}

/** A lower bound on the gap between a sphere (or an unbounded piece) and another. */
function sphereGap(pa: Straight[], g: Group, pb: Straight[], h: Group) {
  if (Number.isFinite(g.radius) && Number.isFinite(h.radius))
    return Math.max(0, distance(g.centre, h.centre) - g.radius - h.radius);
  if (Number.isFinite(g.radius)) {
    const x = pb[h.first];
    return Math.max(
      0,
      distance(g.centre, straightPoint(x, nearestOnStraight(x, g.centre))) - g.radius,
    );
  }
  if (Number.isFinite(h.radius)) return sphereGap(pb, h, pa, g);
  return 0;
}

/**
 * The closest pair of two straight pieces, exactly: their squared gap is a convex quadratic over
 * the parameter box, so its minimum is the free one or the best of each edge's own minimum.
 */
function piecePair(x: Straight, y: Straight, nominal: V3): [number, number] {
  const r = sub(x.o, y.o);
  const [a, b, e, c, f] = [dot(x.d, x.d), dot(x.d, y.d), dot(y.d, y.d), dot(x.d, r), dot(y.d, r)];
  const forX = (t: number) => clamp(a > 0 ? (b * t - c) / a : 0, x.lo, x.hi);
  const forY = (s: number) => clamp(e > 0 ? (b * s + f) / e : 0, y.lo, y.hi);
  const denominator = a * e - b * b;
  if (denominator > 1e-14 * a * e) {
    const [s, t] = [(b * f - c * e) / denominator, (a * f - b * c) / denominator];
    if (s >= x.lo && s <= x.hi && t >= y.lo && t <= y.hi) return [s, t];
    let best: [number, number] = [0, 0],
      gap = Infinity;
    const offer = (s: number, t: number) => {
      const g = distance(straightPoint(x, s), straightPoint(y, t));
      if (g < gap) [gap, best] = [g, [s, t]];
    };
    for (const s of [x.lo, x.hi]) if (Number.isFinite(s)) offer(s, forY(s));
    for (const t of [y.lo, y.hi]) if (Number.isFinite(t)) offer(forX(t), t);
    return best;
  }
  // Parallel: every overlapping pair is equally close, so take the one level with the nominal joint.
  const t = forY(clamp(a > 0 ? dot(sub(nominal, x.o), x.d) / a : 0, x.lo, x.hi));
  return [forX(t), t];
}

/** A closest approach: points on A and B, their carrier parameters and their gap. */
interface Candidate {
  gap: number;
  a: V3;
  b: V3;
  ta: number;
  tb: number;
}

/**
 * Every local minimum of the gap between two straight carriers, each limited to the pieces in
 * its range [from, to]. Piece pairs are skipped only when their bounding spheres cannot come
 * within `tie` of the closest found.
 */
function straightApproach(
  A: Straight[],
  groupsA: Group[],
  rangeA: [number, number],
  B: Straight[],
  groupsB: Group[],
  rangeB: [number, number],
  nominal: V3,
  found: Candidate[],
) {
  let best = Infinity;
  const pairGap = (i: number, j: number) => {
    const [s, t] = piecePair(A[i], B[j], nominal);
    return { s, t, gap: distance(straightPoint(A[i], s), straightPoint(B[j], t)) };
  };
  // Pieces that share the point at t on piece k: undefined where the range cuts the carrier.
  const sharing = (pieces: Straight[], k: number, t: number, [from, to]: [number, number]) => {
    const result = [k];
    if (t === pieces[k].lo && Number.isFinite(t)) {
      if (k - 1 < from) return undefined;
      result.push(k - 1);
    }
    if (t === pieces[k].hi && Number.isFinite(t)) {
      if (k + 1 > to) return undefined;
      result.push(k + 1);
    }
    return result;
  };
  // Each pair's gap is convex, so a pair's minimum is a local minimum overall exactly when every
  // pair sharing that point has no lower minimum.
  const isLocalMinimum = (i: number, j: number, s: number, t: number, gap: number) => {
    const [around, beside] = [sharing(A, i, s, rangeA), sharing(B, j, t, rangeB)];
    if (!around || !beside) return false;
    const slack = 1e-12 * (1 + Math.max(...straightPoint(A[i], s).map(Math.abs)));
    for (const k of around)
      for (const l of beside)
        if ((k !== i || l !== j) && pairGap(k, l).gap < gap - slack) return false;
    return true;
  };
  const pairs = groupsA
    .flatMap((g) => groupsB.map((h) => ({ g, h, bound: sphereGap(A, g, B, h) })))
    .sort((p, q) => p.bound - q.bound);
  for (const { g, h, bound } of pairs) {
    if (bound > best + tie) break;
    for (let i = Math.max(g.first, rangeA[0]); i <= Math.min(g.last, rangeA[1]); i++)
      for (let j = Math.max(h.first, rangeB[0]); j <= Math.min(h.last, rangeB[1]); j++) {
        const [x, y] = [A[i], B[j]];
        if (distance(x.centre, y.centre) - x.radius - y.radius > best + tie) continue;
        const { s, t, gap } = pairGap(i, j);
        if (gap > best + tie || !isLocalMinimum(i, j, s, t, gap)) continue;
        best = Math.min(best, gap);
        const [a, b] = [straightPoint(A[i], s), straightPoint(B[j], t)];
        found.push({ gap, a, b, ta: A[i].base + s, tb: B[j].base + t });
      }
  }
}

const circlePoint = (c: Carrier & { kind: 'circle' }, t: number): V3 =>
  [0, 1, 2].map((k) => c.c[k] + c.r * (Math.cos(t) * c.u[k] + Math.sin(t) * c.v[k])) as V3;

/** The nearest point of a carrier to `p`, with its parameter. */
function nearestOn(carrier: Carrier, p: V3) {
  if (carrier.kind === 'circle') {
    const w = sub(p, carrier.c);
    const t = Math.atan2(dot(w, carrier.v), dot(w, carrier.u));
    return { t, point: circlePoint(carrier, t) };
  }
  const { pieces, groups } = carrier;
  const order = groups
    .map((g) => ({ g, bound: Math.max(0, distance(p, g.centre) - g.radius) }))
    .sort((x, y) => x.bound - y.bound);
  let best = Infinity,
    t = 0,
    point: V3 = p;
  for (const { g, bound } of order) {
    if (bound >= best) break;
    for (let k = g.first; k <= g.last; k++) {
      const s = nearestOnStraight(pieces[k], p);
      const q = straightPoint(pieces[k], s);
      const gap = distance(p, q);
      if (gap < best) [best, t, point] = [gap, pieces[k].base + s, q];
    }
  }
  return { t, point };
}

/**
 * Every local minimum of the gap from a circle to another carrier, as a function of the circle's
 * angle: bracketed by sampling the whole turn, then narrowed by golden section to 1e-10 mm.
 */
function circleApproach(
  circle: Carrier & { kind: 'circle' },
  other: Carrier,
  circleIsA: boolean,
  found: Candidate[],
) {
  const at = (t: number) => {
    const p = circlePoint(circle, t);
    const q = nearestOn(other, p);
    return { p, q, gap: distance(p, q.point) };
  };
  const h = turn / turnSamples;
  const gaps = Float64Array.from({ length: turnSamples }, (_, i) => at(i * h).gap);
  const brackets: number[] = [];
  for (let i = 0; i < turnSamples; i++) {
    const [before, after] = [
      gaps[(i + turnSamples - 1) % turnSamples],
      gaps[(i + 1) % turnSamples],
    ];
    if (gaps[i] <= before && gaps[i] <= after) brackets.push(i);
  }
  brackets.sort((i, j) => gaps[i] - gaps[j]);
  const ratio = (Math.sqrt(5) - 1) / 2;
  let best = Infinity;
  for (const i of brackets) {
    // The gap changes by at most r per radian, which bounds it over the bracket.
    if (gaps[i] - circle.r * h > best + tie) break;
    let [lo, hi] = [(i - 1) * h, (i + 1) * h];
    let [x, y] = [hi - ratio * (hi - lo), lo + ratio * (hi - lo)];
    let [fx, fy] = [at(x).gap, at(y).gap];
    while (circle.r * (hi - lo) > 1e-10) {
      if (fx <= fy) {
        [hi, y, fy] = [y, x, fx];
        x = hi - ratio * (hi - lo);
        if (!(x > lo && x < y)) break;
        fx = at(x).gap;
      } else {
        [lo, x, fx] = [x, y, fy];
        y = lo + ratio * (hi - lo);
        if (!(y > x && y < hi)) break;
        fy = at(y).gap;
      }
    }
    const t = fx <= fy ? x : y;
    const { p, q, gap } = at(t);
    best = Math.min(best, gap);
    found.push(
      circleIsA
        ? { gap, a: p, b: q.point, ta: t, tb: q.t }
        : { gap, a: q.point, b: p, ta: q.t, tb: t },
    );
  }
}

type Circle = Carrier & { kind: 'circle' };

/**
 * The points of the line `o + d t` (d unit), t in [lo, hi], that meet a circle: by the quadratic
 * when the line lies in the circle's plane, else by the crossing point's distance from the centre.
 */
function lineMeetsCircle(o: V3, d: V3, lo: number, hi: number, circle: Circle) {
  const normal = cross(circle.u, circle.v);
  const w = sub(o, circle.c);
  const [across, off] = [dot(d, normal), dot(w, normal)];
  const params: number[] = [];
  if (Math.abs(across) < Math.sin(parallel)) {
    if (Math.abs(off) >= meet) return [];
    const flatD = sub(d, scaled(normal, across)),
      flatW = sub(w, scaled(normal, off));
    const [a, b, c] = [dot(flatD, flatD), dot(flatW, flatD), dot(flatW, flatW) - circle.r ** 2];
    const discriminant = b * b - a * c;
    if (discriminant < 0) return [];
    // The stable form of the two roots.
    const q = -(b + Math.sign(b || 1) * Math.sqrt(discriminant));
    params.push(q / a);
    if (q !== 0) params.push(c / q);
  } else params.push(-off / across);
  const points: { t: number; point: V3 }[] = [];
  for (const t of params) {
    if (!(t >= lo && t <= hi)) continue;
    const point: V3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    if (distance(point, nearestOn(circle, point).point) < meet) points.push({ t, point });
  }
  return points;
}

/** The meeting of points `pa` on A and `pb` on B, with their carrier parameters. */
function meeting(A: Carrier, B: Carrier, pa: V3, pb: V3): Candidate {
  const [a, b] = [nearestOn(A, pa), nearestOn(B, pb)];
  return { gap: distance(a.point, b.point), a: a.point, b: b.point, ta: a.t, tb: b.t };
}

/**
 * Where two carriers truly meet, in closed form: a line or each polyline piece with a circle, and
 * circle with circle. Carriers that coincide meet everywhere, so they meet at the nominal joint.
 * Undefined when neither applies and the gap must be searched numerically.
 */
function exactApproach(A: Carrier, B: Carrier, nominal: V3): Candidate[] | undefined {
  if (A.kind === 'circle' && B.kind === 'circle') {
    const [na, nb] = [cross(A.u, A.v), cross(B.u, B.v)];
    const line = cross(na, nb);
    if (norm(line) < Math.sin(parallel)) {
      if (Math.abs(dot(sub(B.c, A.c), na)) >= meet) return [];
      if (distance(A.c, B.c) < meet && Math.abs(A.r - B.r) < meet)
        return [meeting(A, B, nominal, nominal)];
      const between = sub(B.c, A.c);
      const flat = sub(between, scaled(na, dot(between, na)));
      const d = norm(flat);
      if (!(d > 0)) return [];
      const along = (d * d + A.r ** 2 - B.r ** 2) / (2 * d);
      const height = A.r ** 2 - along ** 2;
      if (height < 0) return [];
      const e = scaled(flat, 1 / d),
        f = cross(na, e);
      return [-1, 1].map((sign) => {
        const p = [0, 1, 2].map(
          (k) => A.c[k] + along * e[k] + sign * Math.sqrt(height) * f[k],
        ) as V3;
        return meeting(A, B, p, p);
      });
    }
    // The circles can meet only on the line where their planes cross.
    // Measured from the first centre: far from the origin the plane offsets would cancel.
    const k = dot(na, nb),
      hb = dot(nb, sub(B.c, A.c));
    const o = [0, 1, 2].map(
      (axis) => A.c[axis] + (hb * (nb[axis] - k * na[axis])) / (1 - k * k),
    ) as V3;
    return lineMeetsCircle(o, unit(line), -Infinity, Infinity, A)
      .map(({ point }) => meeting(A, B, point, point))
      .filter((c) => c.gap < meet);
  }
  if (A.kind === 'circle' || B.kind === 'circle') {
    const [circle, straight] = (A.kind === 'circle' ? [A, B] : [B, A]) as [
      Circle,
      Carrier & { kind: 'straight' },
    ];
    const found: Candidate[] = [];
    for (const x of straight.pieces) {
      if (!(dot(x.d, x.d) > 0)) continue;
      for (const { t, point } of lineMeetsCircle(x.o, x.d, x.lo, x.hi, circle)) {
        const q = nearestOn(circle, point);
        const gap = distance(point, q.point);
        found.push(
          A === circle
            ? { gap, a: q.point, b: point, ta: q.t, tb: x.base + t }
            : { gap, a: point, b: q.point, ta: x.base + t, tb: q.t },
        );
      }
    }
    return found;
  }
  const [x, y] = [A.pieces, B.pieces];
  if (x.length === 1 && y.length === 1 && dot(x[0].d, x[0].d) > 0 && dot(y[0].d, y[0].d) > 0) {
    const offset = sub(y[0].o, x[0].o);
    const across = sub(offset, scaled(x[0].d, dot(offset, x[0].d)));
    if (norm(cross(x[0].d, y[0].d)) < Math.sin(parallel) && norm(across) < meet)
      return [meeting(A, B, nominal, nominal)];
  }
  return undefined;
}

/** Appends the points after `a` along the straight span to `b`, at most `step` apart. */
function straightRun(a: V3, b: V3, step: number, out: number[]) {
  const length = distance(a, b);
  if (!(length > 0)) return;
  const segments = segmentsFor(length, step);
  for (let k = 1; k < segments; k++)
    for (let axis = 0; axis < 3; axis++) out.push(a[axis] + ((b[axis] - a[axis]) * k) / segments);
  out.push(...b);
}

/** A curve with its carrier, the carrier parameters of its fitted ends, and how to trace it. */
interface Guide {
  carrier: Carrier;
  first: V3;
  last: V3;
  head: number;
  tail: number;
  /** Appends the points after `a` (at t0) along the carrier up to `b` (at t1). */
  run(t0: number, t1: number, a: V3, b: V3, step: number, out: number[]): void;
}

function straightGuide(first: V3, last: V3): Guide {
  const length = distance(first, last);
  const d: V3 = length > 0 ? unit(sub(last, first)) : [0, 0, 0];
  const pieces = [straightPiece(first, d, -Infinity, Infinity, 0)];
  return {
    carrier: { kind: 'straight', pieces, groups: [groupOf(pieces, 0, 0)] },
    first,
    last,
    head: 0,
    tail: length,
    run: (_t0, _t1, a, b, step, out) => straightRun(a, b, step, out),
  };
}

function circleGuide(curve: EdgeCurve): Guide {
  const p = curve.points,
    count = p.length / 3;
  const [first, last] = [pointAt(p, 0), pointAt(p, count - 1)];
  const circle = count >= 3 ? circleThrough(first, pointAt(p, count >> 1), last) : undefined;
  if (!circle) return straightGuide(first, last);
  const { centre: c, radius: r } = circle;
  const u = unit(sub(first, c));
  let v = cross(circle.normal, u);
  const angle = (q: V3) => Math.atan2(dot(sub(q, c), v), dot(sub(q, c), u));
  if (angle(pointAt(p, 1)) < 0) v = scaled(v, -1);
  let sweep = angle(last);
  if (sweep <= 0) sweep += turn;
  const carrier = { kind: 'circle' as const, c, u, v, r };
  return {
    carrier,
    first,
    last,
    head: 0,
    tail: sweep,
    run: (t0, t1, a, b, step, out) => {
      const length = r * Math.abs(t1 - t0);
      const segments = length > 0 ? segmentsFor(length, step) : 1;
      for (let k = 1; k < segments; k++)
        out.push(...circlePoint(carrier, t0 + ((t1 - t0) * k) / segments));
      if (segments > 1 || distance(a, b) > 0) out.push(...b);
    },
  };
}

function polylineGuide(curve: EdgeCurve): Guide {
  const p = curve.points,
    count = p.length / 3;
  const [first, last] = [pointAt(p, 0), pointAt(p, count - 1)];
  const lengths = cumulative(p);
  const length = lengths[count - 1];
  const [head, tail] = [unit(sub(pointAt(p, 1), first)), unit(sub(last, pointAt(p, count - 2)))];
  const pieces = [straightPiece(first, head, -Infinity, 0, 0)];
  for (let k = 0; k < count - 1; k++) {
    const [a, b] = [pointAt(p, k), pointAt(p, k + 1)];
    pieces.push(straightPiece(a, unit(sub(b, a)), 0, distance(a, b), lengths[k]));
  }
  pieces.push(straightPiece(last, tail, 0, Infinity, length));
  const size = Math.max(8, Math.ceil(Math.sqrt(count - 1)));
  const groups = [groupOf(pieces, 0, 0)];
  for (let k = 1; k < count; k += size)
    groups.push(groupOf(pieces, k, Math.min(count - 1, k + size - 1)));
  groups.push(groupOf(pieces, count, count));
  return {
    carrier: { kind: 'straight', pieces, groups },
    first,
    last,
    head: 0,
    tail: length,
    run: (t0, t1, a, b, step, out) => {
      let from = a;
      const [low, high] = [Math.min(t0, t1), Math.max(t0, t1)];
      for (let i = 0; i < count; i++) {
        const k = t1 >= t0 ? i : count - 1 - i;
        if (lengths[k] <= low || lengths[k] >= high) continue;
        const vertex = pointAt(p, k);
        straightRun(from, vertex, step, out);
        from = vertex;
      }
      straightRun(from, b, step, out);
    },
  };
}

function guideOf(curve: EdgeCurve, kind: GuideKind): Guide {
  const p = curve.points,
    count = p.length / 3;
  if (kind === 'line' || count < 2) return straightGuide(pointAt(p, 0), pointAt(p, count - 1));
  return kind === 'arc' ? circleGuide(curve) : polylineGuide(curve);
}

/**
 * The closest approach between the carriers of A and B. The smallest local minimum wins; minima
 * within `tie` of it go to the pair nearest the nominal joint. A curve joined to itself is split
 * at its middle vertex so that its two ends meet rather than any point meeting itself.
 */
function approach(A: Guide, B: Guide, self: boolean): Candidate {
  const nominal = [0, 1, 2].map((k) => (A.last[k] + B.first[k]) / 2) as V3;
  const [a, b] = [A.carrier, B.carrier];
  const exact = exactApproach(a, b, nominal);
  const found: Candidate[] = [];
  // A true meeting always beats a nonzero gap, so the search runs only when there is none.
  // Appended one at a time: a spread of many crossings overflows the stack.
  if (exact?.length) for (const candidate of exact) found.push(candidate);
  else if (a.kind === 'circle') circleApproach(a, b, true, found);
  else if (b.kind === 'circle') circleApproach(b, a, false, found);
  else {
    const all = (pieces: Straight[]): [number, number] => [0, pieces.length - 1];
    const middle = a.pieces.length >> 1;
    const split = self && a.pieces.length > 3;
    straightApproach(
      a.pieces,
      a.groups,
      split ? [middle, a.pieces.length - 1] : all(a.pieces),
      b.pieces,
      b.groups,
      split ? [0, middle - 1] : all(b.pieces),
      nominal,
      found,
    );
  }
  let smallest = Infinity;
  for (const c of found) smallest = Math.min(smallest, c.gap);
  let best: Candidate = {
    gap: distance(A.last, B.first),
    a: A.last,
    b: B.first,
    ta: A.tail,
    tb: B.head,
  };
  let nearest = Infinity;
  for (const c of found) {
    if (c.gap > smallest + tie) continue;
    const away = distance(c.a, nominal) + distance(c.b, nominal);
    if (away < nearest) [nearest, best] = [away, c];
  }
  return best;
}

/**
 * Trims or extends neighbours to where they come closest and joins them into one curve. Each
 * neighbour keeps its shape: it is trimmed or extended along its own carrier to its own closest
 * point, and a straight bridge through their midpoint, the joint, closes any gap of at least
 * `meet`. A single curve that is already closed, or that is not being closed, comes back unchanged.
 */
export function joinCurves(
  curves: EdgeCurve[],
  kinds: GuideKind[],
  joints: GuideJoint[],
  closed: boolean,
  step: number,
): EdgeCurve {
  const n = curves.length;
  if (n === 1 && curves[0].points.length <= 3)
    return makeCurve(new Float64Array(curves[0].points), false);
  if (n === 1 && curves[0].closed)
    return makeCurve(new Float64Array(curves[0].points), true, Uint8Array.from(curves[0].corner));
  if (joints.length !== (closed ? n : n - 1))
    throw new Error('A path needs one joint between each pair of neighbouring curves.');
  if (n === 1 && !closed)
    return makeCurve(new Float64Array(curves[0].points), false, Uint8Array.from(curves[0].corner));
  const guides = curves.map((curve, i) => guideOf(curve, kinds[i]));
  type End = { t: number; point: V3; joint?: V3; gap?: number };
  const starts: (End | undefined)[] = guides.map(() => undefined);
  const ends = [...starts];
  joints.forEach((_, k) => {
    const [i, j] = [k, (k + 1) % n];
    const best = approach(guides[i], guides[j], i === j);
    const joint = [0, 1, 2].map((a) => (best.a[a] + best.b[a]) / 2) as V3;
    ends[i] = { t: best.ta, point: best.a, joint, gap: best.gap };
    starts[j] = { t: best.tb, point: best.b, joint, gap: best.gap };
  });
  const flat: number[] = [],
    corner: number[] = [];
  guides.forEach((guide, i) => {
    const from = starts[i] ?? { t: guide.head, point: guide.first };
    const to = ends[i] ?? { t: guide.tail, point: guide.last };
    let [t0, t1] = [from.t, to.t];
    if (guide.carrier.kind === 'circle') {
      // Joints on a circle are taken within half a turn of the arc's middle.
      const middle = (guide.head + guide.tail) / 2;
      const near = (t: number) => t - turn * Math.round((t - middle) / turn);
      if (starts[i]) t0 = near(t0);
      if (ends[i]) t1 = near(t1);
      // A circle closed on itself meets itself at one point, a whole turn on.
      if (n === 1) t1 = t0 + turn;
    }
    const bridged = (end: End) => end.gap !== undefined && end.gap >= meet;
    const piece = [...(from.joint ?? from.point)];
    let a = from.joint ?? from.point;
    if (bridged(from)) {
      straightRun(a, from.point, step, piece);
      a = from.point;
    }
    const b = bridged(to) ? to.point : (to.joint ?? to.point);
    guide.run(t0, t1, a, b, step, piece);
    if (bridged(to)) straightRun(b, to.joint!, step, piece);
    const keepLast = !closed && i === n - 1;
    const count = piece.length / 3 - (keepLast ? 0 : 1);
    const sharp = i > 0 || closed ? joints[(i + n - 1) % n] === 'sharp' : false;
    for (let k = 0; k < count; k++) {
      flat.push(piece[k * 3], piece[k * 3 + 1], piece[k * 3 + 2]);
      corner.push(k === 0 && sharp ? 1 : 0);
    }
  });
  return makeCurve(Float64Array.from(flat), closed, Uint8Array.from(corner));
}

/** Bounding spheres of runs of segments, for pruning the closest point search. */
interface Blocks {
  fingerprint: Float64Array;
  size: number;
  centres: Float64Array;
  radii: Float64Array;
}
const blockCache = new WeakMap<EdgeCurve, Blocks>();

const segmentCount = (curve: EdgeCurve) => {
  const count = curve.points.length / 3;
  return curve.closed ? count : count - 1;
};

/** Point count, closure and eight evenly spaced points, to notice a curve edited in place. */
function fingerprintOf(curve: EdgeCurve, into?: Float64Array) {
  const p = curve.points,
    count = p.length / 3;
  const result = into ?? new Float64Array(26);
  result[0] = count;
  result[1] = curve.closed ? 1 : 0;
  for (let k = 0; k < 8; k++) {
    const i = Math.round(((count - 1) * k) / 7) * 3;
    for (let a = 0; a < 3; a++) result[2 + k * 3 + a] = p[i + a];
  }
  return result;
}

const probe = new Float64Array(26);

function blocksOf(curve: EdgeCurve) {
  const cached = blockCache.get(curve);
  if (cached) {
    fingerprintOf(curve, probe);
    let same = true;
    for (let i = 0; i < 26 && same; i++) same = probe[i] === cached.fingerprint[i];
    if (same) return cached;
  }
  const fingerprint = fingerprintOf(curve);
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
  const result = { fingerprint, size, centres, radii };
  blockCache.set(curve, result);
  return result;
}

/** Writes the closest point; returns its distance along the curve. */
export function closestOnCurve(
  curve: EdgeCurve,
  x: number,
  y: number,
  z: number,
  out: Float32Array | Float64Array,
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

export function curveTangent(
  curve: EdgeCurve,
  station: number,
  out: Float32Array | Float64Array,
): void {
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
function catmullRom(points: ArrayLike<number>, step: number) {
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
export function drawnCurve(kind: GuideKind, points: ArrayLike<number>, step: number): EdgeCurve {
  const count = points.length / 3;
  if (count < 2) return makeCurve(new Float64Array(points), false);
  let [first, last] = [pointAt(points, 0), pointAt(points, count - 1)];
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
    // Collinear or repeated controls: the chord between the two farthest apart, in order.
    const pairs: [V3, V3][] = [
      [first, last],
      [first, middle],
      [middle, last],
    ];
    [first, last] = pairs.reduce((a, b) => (distance(...b) > distance(...a) ? b : a));
  }
  if (kind === 'spline' && count >= 3)
    return makeCurve(resample(catmullRom(points, step), step), false);
  return makeCurve(resample([...first, ...last], step), false);
}
