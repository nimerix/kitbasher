import { EigenvalueDecomposition, Matrix, solve } from 'ml-matrix';

export type GuideKind = 'line' | 'arc' | 'spline';
export type GuideJoint = 'sharp' | 'smooth';
/**
 * A guide curve. Curves are immutable: never write into `points`, `lengths` or `corner` after one
 * is made. `closestOnCurve` caches a lookup index per curve and only notices edits that change
 * the point count or a few sampled points.
 */
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

/** `step` less the worst Float32 rounding of a gap between coordinates up to `extent` in size. */
const safeStep = (step: number, extent: number) => step - 4 * extent * 2 ** -24;

function extentOf(flat: ArrayLike<number>) {
  let extent = 0;
  for (let i = 0; i < flat.length; i++) extent = Math.max(extent, Math.abs(flat[i]));
  return extent;
}

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
  if (!(total > 0)) return [flat[0], flat[1], flat[2]];
  const segments = Math.max(1, Math.ceil(total / safeStep(step, extentOf(flat))));
  const result: number[] = [];
  let j = 0;
  for (let i = 0; i <= segments; i++) {
    const s = (total * i) / segments;
    while (j < count - 2 && lengths[j + 1] < s) j++;
    const span = lengths[j + 1] - lengths[j];
    const f = i === segments ? 1 : span > 0 ? clamp((s - lengths[j]) / span, 0, 1) : 0;
    for (let axis = 0; axis < 3; axis++)
      result.push(flat[j * 3 + axis] + (flat[j * 3 + 3 + axis] - flat[j * 3 + axis]) * f);
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
  const spacing = safeStep(step, norm(centre) + r);
  const segments = Math.max(1, Math.ceil((r * Math.abs(sweep)) / spacing));
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
  const median = gaps.sort((x, y) => x - y)[count >> 1];
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
function splineThrough(samples: Float32Array, params: Float64Array, mean: V3, controls: number) {
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
function staysNear(flat: number[], samples: Float32Array, chord: Float64Array, limit: number) {
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

function fitSpline(samples: Float32Array, controls: number, step: number) {
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
  samples: Float32Array,
  controls: number,
  step: number,
): EdgeCurve {
  const count = samples.length / 3;
  if (count < 2) return makeCurve(samples, false);
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

/**
 * A straight run `o + d t` or a circular arc `c + r (cos t u + sin t v)` for t in [lo, hi], with
 * a bounding sphere (infinite radius for an unbounded run).
 */
type Run = { lo: number; hi: number; centre: V3; radius: number } & (
  | {
      arc: false;
      o: V3;
      d: V3;
      /** Station of t = 0. */
      base: number;
      /** The t nearest the joint, preferred among equally close points. */
      anchor: number;
    }
  | { arc: true; c: V3; u: V3; v: V3; r: number }
);

const runPoint = (run: Run, t: number): V3 =>
  run.arc
    ? ([0, 1, 2].map(
        (k) => run.c[k] + run.r * (Math.cos(t) * run.u[k] + Math.sin(t) * run.v[k]),
      ) as V3)
    : [run.o[0] + run.d[0] * t, run.o[1] + run.d[1] * t, run.o[2] + run.d[2] * t];
const runStation = (run: Run, t: number) => (run.arc ? run.r * t : run.base + t);

/** The parameter of the point of `run` nearest `p`, exactly. */
function nearestOnRun(run: Run, p: V3) {
  if (!run.arc) return clamp(dot(sub(p, run.o), run.d), run.lo, run.hi);
  const w = sub(p, run.c);
  const turn = Math.PI * 2;
  const angle =
    run.lo + ((((Math.atan2(dot(w, run.v), dot(w, run.u)) - run.lo) % turn) + turn) % turn);
  if (angle <= run.hi) return angle;
  return angle - run.hi <= run.lo + turn - angle ? run.hi : run.lo;
}

/** Runs of one side of a curve, with a sphere around them all. */
interface Group {
  runs: Run[];
  centre: V3;
  radius: number;
}

/** A lower bound on the distance between two bounded or single-run groups. */
function gapBetween(g: Group | Run, h: Group | Run) {
  const single = (x: Group | Run) => ('runs' in x ? x.runs[0] : x);
  if (Number.isFinite(g.radius) && Number.isFinite(h.radius))
    return Math.max(0, distance(g.centre, h.centre) - g.radius - h.radius);
  if (Number.isFinite(g.radius)) {
    const run = single(h);
    return Math.max(0, distance(g.centre, runPoint(run, nearestOnRun(run, g.centre))) - g.radius);
  }
  if (Number.isFinite(h.radius)) return gapBetween(h, g);
  return 0;
}

function groupOf(runs: Run[]): Group {
  if (runs.length === 1) return { runs, centre: runs[0].centre, radius: runs[0].radius };
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (const run of runs)
    for (let a = 0; a < 3; a++) {
      low[a] = Math.min(low[a], run.centre[a] - run.radius);
      high[a] = Math.max(high[a], run.centre[a] + run.radius);
    }
  const centre = [0, 1, 2].map((a) => (low[a] + high[a]) / 2) as V3;
  return {
    runs,
    centre,
    radius: Math.max(...runs.map((r) => distance(r.centre, centre) + r.radius)),
  };
}

/** Distances that differ by less than this are equally close. */
const tolerance = 1e-7;

/** The closest approach found so far between the end of curve A and the start of curve B. */
class Approach {
  lengthA: number;
  low = Infinity;
  distance = Infinity;
  reach = Infinity;
  stationA = 0;
  stationB = 0;
  pointA: V3 = [0, 0, 0];
  pointB: V3 = [0, 0, 0];
  constructor(lengthA: number) {
    this.lengthA = lengthA;
  }
  /** Among points within `tolerance` of the closest, keeps the one nearest both curves' ends. */
  offer(stationA: number, pointA: V3, stationB: number, pointB: V3) {
    const d = distance(pointA, pointB);
    const reach = Math.abs(stationA - this.lengthA) + Math.abs(stationB);
    this.low = Math.min(this.low, d);
    if (d > this.low + tolerance) return;
    if (this.distance <= this.low + tolerance && reach >= this.reach) return;
    Object.assign(this, { distance: d, reach, stationA, stationB, pointA, pointB });
  }
}

/** Closed form closest approach of two straight runs, including their boundaries and anchors. */
function straightPair(x: Run & { arc: false }, y: Run & { arc: false }, best: Approach) {
  const r = sub(x.o, y.o);
  const [a, b, e, c, f] = [dot(x.d, x.d), dot(x.d, y.d), dot(y.d, y.d), dot(x.d, r), dot(y.d, r)];
  const forX = (t: number) => clamp(a > 0 ? (b * t - c) / a : 0, x.lo, x.hi);
  const forY = (s: number) => clamp(e > 0 ? (b * s + f) / e : 0, y.lo, y.hi);
  const offer = (s: number, t: number) =>
    best.offer(runStation(x, s), runPoint(x, s), runStation(y, t), runPoint(y, t));
  const denominator = a * e - b * b;
  if (denominator > 1e-12 * a * e) {
    const [s, t] = [(b * f - c * e) / denominator, (a * f - b * c) / denominator];
    if (s >= x.lo && s <= x.hi && t >= y.lo && t <= y.hi) offer(s, t);
  }
  for (const s of [x.lo, x.hi, clamp(x.anchor, x.lo, x.hi)])
    if (Number.isFinite(s)) offer(s, forY(s));
  for (const t of [y.lo, y.hi, clamp(y.anchor, y.lo, y.hi)])
    if (Number.isFinite(t)) offer(forX(t), t);
}

/**
 * Closest approach of a bounded run `x` to a run `y`, by branch and bound over x's parameter:
 * the exact distance to y is Lipschitz in it, so an interval is dropped only when it cannot hold
 * a closer point.
 */
function sweepPair(x: Run, y: Run, xIsA: boolean, best: Approach) {
  const lipschitz = x.arc ? x.r : norm(x.d);
  const evaluate = (t: number) => {
    const px = runPoint(x, t);
    const u = nearestOnRun(y, px);
    const py = runPoint(y, u);
    if (xIsA) best.offer(runStation(x, t), px, runStation(y, u), py);
    else best.offer(runStation(y, u), py, runStation(x, t), px);
    return distance(px, py);
  };
  evaluate(x.lo);
  if (!(x.hi > x.lo) || lipschitz === 0) return;
  evaluate(x.hi);
  const queue = [x.lo, x.hi];
  for (let head = 0, budget = 1 << 14; head < queue.length && budget > 0; head += 2, budget--) {
    const [lo, hi] = [queue[head], queue[head + 1]];
    const middle = (lo + hi) / 2;
    const width = lipschitz * (hi - lo);
    if (evaluate(middle) - width / 2 > best.low + tolerance || width <= tolerance) continue;
    queue.push(lo, middle, middle, hi);
  }
}

function runPair(x: Run, y: Run, best: Approach) {
  if (!x.arc && !y.arc) return straightPair(x, y, best);
  const cost = (run: Run) => (run.arc ? run.r : 1) * (run.hi - run.lo);
  if (cost(x) <= cost(y)) sweepPair(x, y, true, best);
  else sweepPair(y, x, false, best);
}

/** Exact closest approach between two sides, visiting group pairs in order of their lower bounds. */
function closestApproach(ends: Group[], starts: Group[], best: Approach) {
  const pairs = ends
    .flatMap((g) => starts.map((h) => ({ g, h, bound: gapBetween(g, h) })))
    .sort((p, q) => p.bound - q.bound);
  for (const { g, h, bound } of pairs) {
    if (bound > best.low + tolerance) break;
    for (const x of g.runs)
      for (const y of h.runs) if (gapBetween(x, y) <= best.low + tolerance) runPair(x, y, best);
  }
}

/** A curve with its analytic extension, as the runs near each of its ends. */
interface Guide {
  length: number;
  at(station: number): V3;
  /** Points strictly between two stations. */
  inner(from: number, to: number, step: number): number[];
  ends: Group[];
  starts: Group[];
}

const forever = Infinity;

function straightGuide(first: V3, last: V3): Guide {
  const length = distance(first, last);
  const d: V3 = length > 0 ? unit(sub(last, first)) : [0, 0, 0];
  const run = (lo: number, hi: number, anchor: number): Run => ({
    arc: false,
    o: first,
    d,
    lo,
    hi,
    base: 0,
    anchor,
    centre: first,
    radius: length > 0 ? forever : 0,
  });
  return {
    length,
    at: (s) => [first[0] + d[0] * s, first[1] + d[1] * s, first[2] + d[2] * s],
    inner: () => [],
    ends: [groupOf([length > 0 ? run(length / 2, forever, length) : run(0, 0, 0)])],
    starts: [groupOf([length > 0 ? run(-forever, length / 2, 0) : run(0, 0, 0)])],
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
  if (sweep <= 0) sweep += Math.PI * 2;
  const run = (lo: number, hi: number): Run => ({
    arc: true,
    c,
    u,
    v,
    r,
    lo,
    hi,
    centre: c,
    radius: r,
  });
  const at = (s: number): V3 => runPoint(run(0, 0), s / r);
  return {
    length: r * sweep,
    at,
    inner: (from, to, step) => {
      const pieces = Math.ceil((to - from) / (step / 4));
      const result: number[] = [];
      for (let i = 1; i < pieces; i++) result.push(...at(from + ((to - from) * i) / pieces));
      return result;
    },
    // Each end reaches half way round the rest of the circle, so the two cover it once.
    ends: [groupOf([run(sweep / 2, sweep / 2 + Math.PI)])],
    starts: [groupOf([run(sweep / 2 - Math.PI, sweep / 2)])],
  };
}

function polylineGuide(curve: EdgeCurve): Guide {
  const p = Float64Array.from(curve.points),
    count = p.length / 3;
  const [first, last] = [pointAt(p, 0), pointAt(p, count - 1)];
  if (count < 2) return straightGuide(first, last);
  const lengths = cumulative(p);
  const length = lengths[count - 1];
  const [head, tail] = [unit(sub(pointAt(p, 1), first)), unit(sub(last, pointAt(p, count - 2)))];
  const segment = (k: number): Run => {
    const [a, b] = [pointAt(p, k), pointAt(p, k + 1)];
    const span = distance(a, b);
    return {
      arc: false,
      o: a,
      d: unit(sub(b, a)),
      lo: 0,
      hi: span,
      base: lengths[k],
      anchor: 0,
      centre: [0, 1, 2].map((i) => (a[i] + b[i]) / 2) as V3,
      radius: span / 2,
    };
  };
  const blocks = (runs: Run[]) => {
    const size = Math.max(8, Math.ceil(Math.sqrt(runs.length)));
    const result: Group[] = [];
    for (let i = 0; i < runs.length; i += size) result.push(groupOf(runs.slice(i, i + size)));
    return result;
  };
  const ray = (o: V3, d: V3, lo: number, hi: number, base: number): Run => ({
    arc: false,
    o,
    d,
    lo,
    hi,
    base,
    anchor: 0,
    centre: o,
    radius: forever,
  });
  const segments = Array.from({ length: count - 1 }, (_, k) => segment(k));
  return {
    length,
    at: (s) => {
      if (s <= 0) return [first[0] + head[0] * s, first[1] + head[1] * s, first[2] + head[2] * s];
      if (s >= length) return runPoint(ray(last, tail, 0, forever, length), s - length);
      let k = 0;
      while (k < count - 2 && lengths[k + 1] < s) k++;
      return runPoint(segments[k], s - lengths[k]);
    },
    inner: (from, to) => {
      const result: number[] = [];
      for (let k = 0; k < count; k++)
        if (lengths[k] > from && lengths[k] < to) result.push(...pointAt(p, k));
      return result;
    },
    ends: [
      ...blocks(segments.filter((_, k) => lengths[k + 1] > length / 2)),
      groupOf([ray(last, tail, 0, forever, length)]),
    ],
    starts: [
      groupOf([ray(first, head, -forever, 0, 0)]),
      ...blocks(segments.filter((_, k) => lengths[k] < length / 2)),
    ],
  };
}

function guideOf(curve: EdgeCurve, kind: GuideKind): Guide {
  const p = curve.points,
    count = p.length / 3;
  if (kind === 'line' || count < 2) return straightGuide(pointAt(p, 0), pointAt(p, count - 1));
  return kind === 'arc' ? circleGuide(curve) : polylineGuide(curve);
}

/**
 * Trims or extends neighbours to where they come closest and joins them into one curve. A single
 * curve that is already closed comes back unchanged.
 */
export function joinCurves(
  curves: EdgeCurve[],
  kinds: GuideKind[],
  joints: GuideJoint[],
  closed: boolean,
  step: number,
): EdgeCurve {
  const n = curves.length;
  if (n === 1 && curves[0].closed)
    return makeCurve(curves[0].points, true, Uint8Array.from(curves[0].corner));
  if (joints.length !== (closed ? n : n - 1))
    throw new Error('A path needs one joint between each pair of neighbouring curves.');
  const guides = curves.map((curve, i) => guideOf(curve, kinds[i]));
  const starts: ({ station: number; point: V3 } | undefined)[] = guides.map(() => undefined);
  const ends = [...starts];
  joints.forEach((_, k) => {
    const [A, B] = [guides[k], guides[(k + 1) % n]];
    const best = new Approach(A.length);
    closestApproach(A.ends, B.starts, best);
    const middle = [0, 1, 2].map((a) => (best.pointA[a] + best.pointB[a]) / 2) as V3;
    ends[k] = { station: best.stationA, point: middle };
    starts[(k + 1) % n] = { station: best.stationB, point: middle };
  });
  const flat: number[] = [],
    corner: number[] = [];
  guides.forEach((guide, i) => {
    const from = starts[i] ?? { station: 0, point: guide.at(0) };
    const to = ends[i] ?? { station: guide.length, point: guide.at(guide.length) };
    const piece = [...from.point, ...guide.inner(from.station, to.station, step), ...to.point];
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
