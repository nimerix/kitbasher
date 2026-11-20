import { Matrix, SingularValueDecomposition, solve } from 'ml-matrix';
import { type RefineMesh, type RefineTopology, vertexNormal } from './refine-mesh';
import type { Vec3 } from './types';

export type ShapeKind = 'plane' | 'cylinder' | 'cone' | 'sphere';
/**
 * A sphere or cylinder with a negative radius has normals facing its centre or axis. A cone is the
 * surface at `angle` from `axis` about `apex`; its normals face away from the axis when the angle
 * is below 90 degrees.
 */
export type Shape =
  | { kind: 'plane'; point: Vec3; normal: Vec3 }
  | { kind: 'sphere'; center: Vec3; radius: number }
  | { kind: 'cylinder'; point: Vec3; axis: Vec3; radius: number }
  | { kind: 'cone'; apex: Vec3; axis: Vec3; angle: number };
export interface ShapeFit {
  shape: Shape;
  /** RMS distance of inliers. */
  rms: number;
  /** Fraction of the input points within 3 * noise of the shape. */
  support: number;
  /**
   * True when rms <= 2 * noise and at least half of the points support the fit. Noise is floored at
   * 1e-9 mm so exact data passes at zero noise.
   */
  within: boolean;
}

const tukey = 4.685;
const rounds = 10;
const minimumPoints: Record<ShapeKind, number> = { plane: 3, sphere: 4, cylinder: 5, cone: 6 };
/** Floor of the noise in mm, so exact data keeps its points and passes at zero noise. */
const exact = 1e-9;
/** Medians closer than this, in units of the scaled cloud, are equal to rounding. */
const medianTie = 1e-12;

/** Chance of drawing at least one sample wholly on a surface that holds half of the points. */
const confidence = 0.999;
/** Most points a seed candidate is scored on. */
const scoringPoints = 4096;
/** Share of all points within the noise that ends the seed search before every draw is scored. */
const settling = 0.9;

/** Eigenvalues ascending and their unit eigenvectors (row i for value i) of a symmetric 3x3. */
function eigen3(matrix: ArrayLike<number>) {
  const m = Float64Array.from(matrix);
  const v = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = m[1] * m[1] + m[2] * m[2] + m[5] * m[5];
    if (off <= 1e-30 * (m[0] * m[0] + m[4] * m[4] + m[8] * m[8])) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      const apq = m[p * 3 + q];
      if (apq === 0) continue;
      const theta = (m[q * 3 + q] - m[p * 3 + p]) / (2 * apq);
      const t = (theta < 0 ? -1 : 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1),
        s = t * c;
      for (let k = 0; k < 3; k++) {
        const kp = m[k * 3 + p],
          kq = m[k * 3 + q];
        m[k * 3 + p] = c * kp - s * kq;
        m[k * 3 + q] = s * kp + c * kq;
      }
      for (let k = 0; k < 3; k++) {
        const pk = m[p * 3 + k],
          qk = m[q * 3 + k];
        m[p * 3 + k] = c * pk - s * qk;
        m[q * 3 + k] = s * pk + c * qk;
      }
      for (let k = 0; k < 3; k++) {
        const kp = v[k * 3 + p],
          kq = v[k * 3 + q];
        v[k * 3 + p] = c * kp - s * kq;
        v[k * 3 + q] = s * kp + c * kq;
      }
    }
  }
  const order = [0, 1, 2].sort((a, b) => m[a * 4] - m[b * 4]);
  return {
    values: order.map((i) => m[i * 4]),
    vectors: order.map((i) => [v[i], v[3 + i], v[6 + i]] as Vec3),
  };
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function normalize(a: number[]): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
}

/** Two unit vectors perpendicular to unit `a` and to each other. */
function perpendiculars(a: ArrayLike<number>): [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(a[0]) < 0.6 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize([
    a[1] * helper[2] - a[2] * helper[1],
    a[2] * helper[0] - a[0] * helper[2],
    a[0] * helper[1] - a[1] * helper[0],
  ]);
  return [u, [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]]];
}

/** The value a sort would put at index `k`, found by selection; reorders `a`. */
function selectInPlace(a: Float64Array, k: number) {
  let low = 0,
    high = a.length - 1;
  while (low < high) {
    const pivot = a[(low + high) >> 1];
    let i = low,
      j = high;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i++] = a[j];
        a[j--] = t;
      }
    }
    if (k <= j) high = j;
    else if (k >= i) low = i;
    else break;
  }
  return a[k];
}

/** The lower median, the value a sort would put at (length - 1) >> 1. */
function median(values: Float64Array) {
  return values.length ? selectInPlace(Float64Array.from(values), (values.length - 1) >> 1) : 0;
}

/** One murmur-style mixing step of a 32-bit hash. */
function mix(hash: number, word: number) {
  hash = Math.imul(hash ^ word, 0x5bd1e995);
  return hash ^ (hash >>> 13);
}

/**
 * Indices of at most `limit` points, a seeded random selection in a seeded random order. Both come
 * from a hash of each point's own position and normal bits, so the input order cannot change them.
 */
function samplingOrder(points: Float32Array, normals: Float32Array, limit: number) {
  const count = Math.floor(points.length / 3);
  const position = new Uint32Array(points.buffer, points.byteOffset, count * 3);
  const normal = new Uint32Array(normals.buffer, normals.byteOffset, normals.length);
  const keys = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    let hash = 0x2545f491;
    for (let k = 0; k < 3; k++) hash = mix(hash, position[i * 3 + k]);
    for (let k = 0; k < 3; k++) hash = mix(hash, normal[i * 3 + k] ?? 0);
    hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
    keys[i] = (hash ^ (hash >>> 16)) >>> 0;
  }
  let indices: number[] = [];
  if (count > limit) {
    // The hashes are uniform, so this bound almost always holds the smallest `limit` of them.
    const guess = ((limit * 1.1 + 64) / count) * 2 ** 32;
    for (let i = 0; i < count; i++) if (keys[i] < guess) indices.push(i);
    if (indices.length < limit) {
      const threshold = selectInPlace(Float64Array.from(keys), limit - 1);
      indices = [];
      for (let i = 0; i < count; i++) if (keys[i] <= threshold) indices.push(i);
    }
  } else indices = Array.from({ length: count }, (_, i) => i);
  indices.sort((a, b) => {
    if (keys[a] !== keys[b]) return keys[a] - keys[b];
    for (let k = 0; k < 3; k++) {
      const d = points[a * 3 + k] - points[b * 3 + k] || normals[a * 3 + k] - normals[b * 3 + k];
      if (d) return d;
    }
    return 0;
  });
  return Uint32Array.from(indices.slice(0, limit));
}

/** Points centred on their mean and scaled to unit RMS radius, so every fit is well conditioned. */
interface Cloud {
  count: number;
  p: Float64Array;
  n: Float64Array;
  centre: Vec3;
  scale: number;
}

function cloudOf(points: Float32Array, normals: Float32Array): Cloud | null {
  const count = Math.floor(points.length / 3);
  const centre: Vec3 = [0, 0, 0];
  for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) centre[k] += points[i * 3 + k];
  for (let k = 0; k < 3; k++) centre[k] /= count;
  const p = new Float64Array(count * 3),
    n = new Float64Array(count * 3);
  let spread = 0;
  for (let i = 0; i < count * 3; i++) {
    p[i] = points[i] - centre[i % 3];
    spread += p[i] * p[i];
  }
  const scale = Math.sqrt(spread / count);
  if (!(scale > 0)) return null;
  for (let i = 0; i < count * 3; i++) p[i] /= scale;
  for (let i = 0; i < count; i++) {
    const length = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
    if (length > 0) for (let k = 0; k < 3; k++) n[i * 3 + k] = normals[i * 3 + k] / length;
  }
  return { count, p, n, centre, scale };
}

/**
 * A model in cloud units: `residuals` writes the distance of every point, `gradient` the outward
 * direction of the distance at a point, and `perturb` moves the state by a small parameter step.
 */
interface Model {
  parameters: number;
  residuals(state: Float64Array, out: Float64Array): void;
  gradient(state: Float64Array, i: number): Vec3;
  perturb(state: Float64Array, step: Float64Array): Float64Array;
}

/** Tukey biweights from residuals, with a scale of 1.4826 times the median absolute residual. */
function reweight(
  residual: Float64Array,
  noise: number,
  weight: Float64Array,
  absolute: Float64Array,
) {
  for (let i = 0; i < residual.length; i++) absolute[i] = Math.abs(residual[i]);
  const scale = Math.max(1.4826 * selectInPlace(absolute, (absolute.length - 1) >> 1), noise);
  const cut = tukey * scale;
  for (let i = 0; i < residual.length; i++) {
    const u = residual[i] / cut;
    weight[i] = Math.abs(u) < 1 ? (1 - u * u) ** 2 : 0;
  }
}

/** Damped Gauss-Newton on the weighted squared residuals, with a forward-difference Jacobian. */
function refine(model: Model, cloud: Cloud, state: Float64Array, weight: Float64Array) {
  const { count } = cloud;
  const size = model.parameters,
    h = 1e-6;
  let residual = new Float64Array(count),
    trial = new Float64Array(count);
  const jacobian = Array.from({ length: size }, () => new Float64Array(count));
  const cost = (r: Float64Array) => {
    let sum = 0;
    for (let i = 0; i < count; i++) sum += weight[i] * r[i] * r[i];
    return sum;
  };
  model.residuals(state, residual);
  let current = cost(residual),
    damping = 1e-3;
  const step = new Float64Array(size);
  for (let iteration = 0; iteration < 20; iteration++) {
    for (let j = 0; j < size; j++) {
      step.fill(0);
      step[j] = h;
      const column = jacobian[j];
      model.residuals(model.perturb(state, step), column);
      for (let i = 0; i < count; i++) column[i] = (column[i] - residual[i]) / h;
    }
    const normal = new Matrix(size, size),
      gradient = new Matrix(size, 1);
    for (let a = 0; a < size; a++) {
      const ja = jacobian[a];
      let g = 0;
      for (let i = 0; i < count; i++) g += weight[i] * ja[i] * residual[i];
      gradient.set(a, 0, -g);
      for (let b = a; b < size; b++) {
        const jb = jacobian[b];
        let sum = 0;
        for (let i = 0; i < count; i++) sum += weight[i] * ja[i] * jb[i];
        normal.set(a, b, sum);
        normal.set(b, a, sum);
      }
    }
    let improved = false;
    while (damping < 1e8) {
      const damped = normal.clone();
      for (let a = 0; a < size; a++) damped.set(a, a, normal.get(a, a) * (1 + damping) + 1e-12);
      const delta = Float64Array.from(solve(damped, gradient).getColumn(0));
      const next = delta.every(Number.isFinite) ? model.perturb(state, delta) : null;
      if (next) model.residuals(next, trial);
      const value = next ? cost(trial) : Infinity;
      if (next && value <= current) {
        const settled = current - value <= 1e-12 * current;
        state = next;
        current = value;
        [residual, trial] = [trial, residual];
        damping = Math.max(damping / 10, 1e-9);
        improved = !settled;
        break;
      }
      damping *= 10;
    }
    if (!improved) break;
  }
  return state;
}

interface Fitted {
  state: Float64Array;
  /** True when the normals face against the model's outward direction. */
  inward: boolean;
  weight: Float64Array;
}

type Scorer = Pick<Model, 'residuals' | 'gradient'>;

/** How one kind of shape is measured, started and refitted. */
interface Fitter<M extends Scorer> {
  /** Points a minimal sample needs to define the shape. */
  size: number;
  model(cloud: Cloud): M;
  /** Start states from the points with weight, one for each orientation the normals leave open. */
  starts(cloud: Cloud, weight: Float64Array): (Float64Array | null)[];
  refit(cloud: Cloud, model: M, weight: Float64Array, previous: Float64Array): Float64Array | null;
}

/** The points at `indices`, in the cloud's own frame. */
function subset(cloud: Cloud, indices: ArrayLike<number>): Cloud {
  const count = indices.length;
  const p = new Float64Array(count * 3),
    n = new Float64Array(count * 3);
  for (let j = 0; j < count; j++)
    for (let k = 0; k < 3; k++) {
      p[j * 3 + k] = cloud.p[indices[j] * 3 + k];
      n[j * 3 + k] = cloud.n[indices[j] * 3 + k];
    }
  return { count, p, n, centre: cloud.centre, scale: cloud.scale };
}

/** Number of distinct k-subsets of n items. */
function subsets(n: number, k: number) {
  let total = 1;
  for (let i = 0; i < k; i++) total = (total * (n - i)) / (i + 1);
  return total;
}

/**
 * Iteratively reweighted fit started from whichever of the all-point start and minimal samples has
 * the least median absolute residual. Candidates are scored on the points at `order` and samples
 * are drawn from them: enough to find a surface that holds half of them with the chance
 * `confidence`, or every sample when that is fewer, so a minority off the surface cannot move it.
 * Drawing stops early only once a candidate keeps more than `settling` of all points within the
 * noise. A candidate `refused` on the scored points can never be the start.
 */
function robust<M extends Scorer>(
  cloud: Cloud,
  noise: number,
  fitter: Fitter<M>,
  order: Uint32Array,
  refused: (cloud: Cloud, candidate: Fitted) => boolean,
  prior: Float64Array | null,
): Fitted | null {
  const { count } = cloud;
  const model = fitter.model(cloud);
  const scored = subset(cloud, order);
  const scorer = fitter.model(scored);
  const distance = new Float64Array(scored.count),
    full = scored.count < count ? new Float64Array(count) : null,
    scoredWeight = new Float64Array(scored.count),
    scoredAbsolute = new Float64Array(scored.count);
  const confirmed = (candidate: Float64Array) => {
    if (!full) return true;
    model.residuals(candidate, full);
    let near = 0;
    for (let i = 0; i < count; i++) if (Math.abs(full[i]) <= noise) near++;
    return near > settling * count;
  };
  const allowed = (candidate: Float64Array) => {
    reweight(distance, noise, scoredWeight, scoredAbsolute);
    return !refused(scored, { state: candidate, inward: false, weight: scoredWeight });
  };
  let state: Float64Array | null = null,
    least = Infinity,
    most = -1,
    settled = false;
  const consider = (candidates: (Float64Array | null)[]) => {
    for (const candidate of candidates) {
      if (!candidate || !candidate.every(Number.isFinite)) continue;
      scorer.residuals(candidate, distance);
      let near = 0,
        below = 0,
        level = 0;
      for (let i = 0; i < scored.count; i++) {
        distance[i] = Math.abs(distance[i]);
        if (distance[i] <= noise) near++;
        if (distance[i] < least) below++;
        if (distance[i] <= least + medianTie) level++;
      }
      // The median is below the least so far only when more than half of the values are.
      const lower = below > (scored.count - 1) >> 1;
      // Two samples that each fit their own points exactly tie on the median; more points wins.
      const tied = !lower && level > (scored.count - 1) >> 1 && near > most;
      const better = lower || tied;
      // Nearly all of the sample alone can be far fewer of the cloud.
      const settles = near > settling * scored.count && confirmed(candidate);
      if (!(better || settles) || !allowed(candidate)) continue;
      if (settles) settled = true;
      if (better) {
        least = median(distance);
        most = near;
        state = candidate;
      }
    }
  };
  consider(fitter.starts(cloud, prior ?? new Float64Array(count).fill(1)));
  const { size } = fitter,
    n = scored.count,
    half = Math.ceil(n / 2);
  const ones = new Float64Array(size).fill(1),
    picked = new Uint32Array(size);
  const sample = () => consider(fitter.starts(subset(scored, picked), ones));
  if (n > size) {
    let p = 1;
    for (let i = 0; i < size; i++) p *= Math.max(0, half - i) / (n - i);
    // The 0.999 chance is stated for clouds of at least 4 * size points. When half the cloud
    // cannot hold a minimal sample the chance is 0, and every subset of so small a cloud is tried.
    const draws =
      p <= 0 ? Infinity : p < 1 ? Math.ceil(Math.log(1 - confidence) / Math.log(1 - p)) : 1;
    if (subsets(n, size) <= draws) {
      for (let k = 0; k < size; k++) picked[k] = k;
      for (;;) {
        sample();
        if (settled) break;
        let k = size - 1;
        while (k >= 0 && picked[k] === n - size + k) k--;
        if (k < 0) break;
        picked[k]++;
        for (let j = k + 1; j < size; j++) picked[j] = picked[j - 1] + 1;
      }
    } else {
      let seed = 0x2545f491;
      const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
      for (let draw = 0; !settled && draw < draws; draw++) {
        for (let filled = 0; filled < size;) {
          const i = Math.floor(random() * n);
          if (!picked.subarray(0, filled).includes(i)) picked[filled++] = i;
        }
        sample();
      }
    }
  }
  const weight = new Float64Array(count),
    residual = new Float64Array(count),
    absolute = new Float64Array(count);
  for (let round = 0; state && round < rounds; round++) {
    model.residuals(state, residual);
    reweight(residual, noise, weight, absolute);
    if (prior) for (let i = 0; i < count; i++) weight[i] *= prior[i];
    state = fitter.refit(cloud, model, weight, state);
  }
  const final: Float64Array | null = state;
  if (!final || !final.every(Number.isFinite)) return null;
  model.residuals(final, residual);
  reweight(residual, noise, weight, absolute);
  if (prior) for (let i = 0; i < count; i++) weight[i] *= prior[i];
  let inliers = 0,
    facing = 0;
  for (let i = 0; i < count; i++) {
    if (weight[i] <= 0) continue;
    inliers++;
    facing += weight[i] * dot(model.gradient(final, i), cloud.n.subarray(i * 3, i * 3 + 3));
  }
  if (!inliers) return null;
  return { state: final, inward: facing < 0, weight };
}

const at = (cloud: Cloud, i: number): Vec3 => [
  cloud.p[i * 3],
  cloud.p[i * 3 + 1],
  cloud.p[i * 3 + 2],
];

/** Weighted principal plane of the points: point (3), unit normal (3). */
function planeThrough(cloud: Cloud, weight: Float64Array) {
  let total = 0;
  const mean = [0, 0, 0];
  for (let i = 0; i < cloud.count; i++) {
    total += weight[i];
    for (let k = 0; k < 3; k++) mean[k] += weight[i] * cloud.p[i * 3 + k];
  }
  if (!(total > 0)) return null;
  for (let k = 0; k < 3; k++) mean[k] /= total;
  const covariance = new Float64Array(9);
  for (let i = 0; i < cloud.count; i++) {
    if (!weight[i]) continue;
    const d = at(cloud, i).map((v, k) => v - mean[k]);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) covariance[r * 3 + c] += weight[i] * d[r] * d[c];
  }
  const { values, vectors } = eigen3(covariance);
  if (values[1] <= 1e-10 * values[2]) return null;
  return Float64Array.from([...mean, ...vectors[0]]);
}

const planeFitter: Fitter<Scorer> = {
  size: 3,
  model: (cloud) => ({
    residuals(state, out) {
      for (let i = 0; i < cloud.count; i++)
        out[i] =
          (cloud.p[i * 3] - state[0]) * state[3] +
          (cloud.p[i * 3 + 1] - state[1]) * state[4] +
          (cloud.p[i * 3 + 2] - state[2]) * state[5];
    },
    gradient: (s) => [s[3], s[4], s[5]],
  }),
  starts: (cloud, weight) => [planeThrough(cloud, weight)],
  refit: (cloud, _, weight) => planeThrough(cloud, weight),
};

/** Solves the weighted least squares rows . x = rhs; null when the rows do not fix x. */
function leastSquares(
  count: number,
  size: number,
  row: (i: number, out: Float64Array) => number,
  weight: Float64Array,
) {
  const normal = new Matrix(size, size),
    right = new Matrix(size, 1);
  const values = new Float64Array(size);
  for (let i = 0; i < count; i++) {
    if (weight[i] <= 0) continue;
    const rhs = row(i, values);
    for (let a = 0; a < size; a++) {
      right.set(a, 0, right.get(a, 0) + weight[i] * values[a] * rhs);
      for (let b = 0; b < size; b++)
        normal.set(a, b, normal.get(a, b) + weight[i] * values[a] * values[b]);
    }
  }
  if (!(new SingularValueDecomposition(normal).condition < 1e12)) return null;
  const x = Float64Array.from(solve(normal, right).getColumn(0));
  return x.every(Number.isFinite) ? x : null;
}

/** State: centre (3), radius. */
const sphereFitter: Fitter<Model> = {
  size: 4,
  model: (cloud) => ({
    parameters: 4,
    perturb: (state, step) => state.map((v, i) => v + step[i]),
    residuals(s, out) {
      for (let i = 0; i < cloud.count; i++) {
        const x = cloud.p[i * 3] - s[0],
          y = cloud.p[i * 3 + 1] - s[1],
          z = cloud.p[i * 3 + 2] - s[2];
        out[i] = Math.sqrt(x * x + y * y + z * z) - s[3];
      }
    },
    gradient: (s, i) => normalize(at(cloud, i).map((v, k) => v - s[k])),
  }),
  starts(cloud, weight) {
    const x = leastSquares(
      cloud.count,
      4,
      (i, row) => {
        const p = at(cloud, i);
        row.set([2 * p[0], 2 * p[1], 2 * p[2], 1]);
        return dot(p, p);
      },
      weight,
    );
    if (!x) return [];
    const radius = Math.sqrt(x[3] + x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
    return Number.isFinite(radius) ? [Float64Array.from([x[0], x[1], x[2], radius])] : [];
  },
  refit: (cloud, model, weight, previous) => refine(model, cloud, previous, weight),
};

/**
 * Unit axis from the normals of the points with weight: the eigenvector of least spread, about
 * their mean when `centred`.
 */
function normalAxis(cloud: Cloud, centred: boolean, weight: Float64Array) {
  const mean = [0, 0, 0];
  let total = 0;
  const used = (i: number) =>
    weight[i] > 0 && (cloud.n[i * 3] !== 0 || cloud.n[i * 3 + 1] !== 0 || cloud.n[i * 3 + 2] !== 0);
  for (let i = 0; i < cloud.count; i++) {
    if (!used(i)) continue;
    total++;
    for (let k = 0; k < 3; k++) mean[k] += cloud.n[i * 3 + k];
  }
  if (total < 3) return null;
  for (let k = 0; k < 3; k++) mean[k] = centred ? mean[k] / total : 0;
  const covariance = new Float64Array(9);
  for (let i = 0; i < cloud.count; i++) {
    if (!used(i)) continue;
    const n = cloud.n.subarray(i * 3, i * 3 + 3);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) covariance[r * 3 + c] += (n[r] - mean[r]) * (n[c] - mean[c]);
  }
  const { values, vectors } = eigen3(covariance);
  if (values[1] <= 1e-10 * values[2]) return null;
  return { axis: vectors[0], mean };
}

/** Unit axis moved by a tilt of (a, b) along its perpendiculars. */
function tilted(axis: ArrayLike<number>, a: number, b: number) {
  const [u, v] = perpendiculars(axis);
  return normalize([0, 1, 2].map((k) => axis[k] + a * u[k] + b * v[k]));
}

/** State: point on the axis nearest the cloud centre (3), unit axis (3), radius. */
const cylinderFitter: Fitter<Model> = {
  size: 3,
  model: (cloud) => ({
    parameters: 5,
    residuals(s, out) {
      for (let i = 0; i < cloud.count; i++) {
        const x = cloud.p[i * 3] - s[0],
          y = cloud.p[i * 3 + 1] - s[1],
          z = cloud.p[i * 3 + 2] - s[2];
        const h = x * s[3] + y * s[4] + z * s[5];
        out[i] = Math.sqrt(Math.max(0, x * x + y * y + z * z - h * h)) - s[6];
      }
    },
    gradient(s, i) {
      const w = at(cloud, i).map((v, k) => v - s[k]);
      const h = dot(w, s.subarray(3, 6));
      return normalize(w.map((v, k) => v - h * s[3 + k]));
    },
    perturb(s, step) {
      const [u, v] = perpendiculars(s.subarray(3, 6));
      const axis = tilted(s.subarray(3, 6), step[0], step[1]);
      const point = [0, 1, 2].map((k) => s[k] + step[2] * u[k] + step[3] * v[k]);
      const along = dot(point, axis);
      return Float64Array.from([
        ...point.map((value, k) => value - along * axis[k]),
        ...axis,
        s[6] + step[4],
      ]);
    },
  }),
  starts(cloud, weight) {
    const start = normalAxis(cloud, false, weight);
    if (!start) return [];
    const { axis } = start;
    const [u, v] = perpendiculars(axis);
    const x = leastSquares(
      cloud.count,
      3,
      (i, row) => {
        const p = at(cloud, i);
        const a = dot(p, u),
          b = dot(p, v);
        row.set([2 * a, 2 * b, 1]);
        return a * a + b * b;
      },
      weight,
    );
    if (!x) return [];
    const radius = Math.sqrt(x[2] + x[0] * x[0] + x[1] * x[1]);
    if (!Number.isFinite(radius)) return [];
    const point = [0, 1, 2].map((k) => x[0] * u[k] + x[1] * v[k]);
    return [Float64Array.from([...point, ...axis, radius])];
  },
  refit: (cloud, model, weight, previous) => refine(model, cloud, previous, weight),
};

/** State: apex (3), unit axis (3), angle from the axis. */
const coneFitter: Fitter<Model> = {
  size: 3,
  model: (cloud) => ({
    parameters: 6,
    residuals(s, out) {
      const frame = coneFrame(s.subarray(3, 6), s[6]);
      for (let i = 0; i < cloud.count; i++)
        out[i] = coneDistance(
          cloud.p[i * 3] - s[0],
          cloud.p[i * 3 + 1] - s[1],
          cloud.p[i * 3 + 2] - s[2],
          frame,
        );
    },
    gradient(s, i) {
      const w = at(cloud, i).map((v, k) => v - s[k]);
      const frame = coneFrame(s.subarray(3, 6), s[6]);
      const h = w[0] * frame[0] + w[1] * frame[1] + w[2] * frame[2];
      const radial = normalize(w.map((v, k) => v - h * frame[k]));
      const rho = Math.sqrt(Math.max(0, dot(w, w) - h * h));
      if (h * frame[3] + rho * frame[4] < 0)
        return normalize(w.map((v) => (coneDistance(w[0], w[1], w[2], frame) < 0 ? -v : v)));
      return [0, 1, 2].map((k) => frame[3] * radial[k] - frame[4] * frame[k]) as Vec3;
    },
    perturb(s, step) {
      const [u, v] = perpendiculars(s.subarray(3, 6));
      const axis = tilted(s.subarray(3, 6), step[0], step[1]);
      return Float64Array.from([
        ...[0, 1, 2].map((k) => s[k] + step[2] * u[k] + step[3] * v[k] + step[4] * s[3 + k]),
        ...axis,
        s[6] + step[5],
      ]);
    },
  }),
  starts(cloud, weight) {
    const start = normalAxis(cloud, true, weight);
    if (!start) return [];
    // Normals make the angle (90 degrees + half angle) with the axis toward the opening, whichever
    // way they face, so the axis is tried both ways.
    const angle = Math.asin(Math.min(1, Math.abs(dot(start.mean, start.axis))));
    // Every tangent plane passes through the apex.
    const apex = leastSquares(
      cloud.count,
      3,
      (i, row) => {
        row.set(cloud.n.subarray(i * 3, i * 3 + 3));
        return dot(row, at(cloud, i));
      },
      weight,
    );
    if (!apex || !(angle > 0)) return [];
    return [1, -1].map((k) => Float64Array.from([...apex, ...start.axis.map((v) => k * v), angle]));
  },
  refit: (cloud, model, weight, previous) => refine(model, cloud, previous, weight),
};

const world = (cloud: Cloud, p: ArrayLike<number>): Vec3 => [
  p[0] * cloud.scale + cloud.centre[0],
  p[1] * cloud.scale + cloud.centre[1],
  p[2] * cloud.scale + cloud.centre[2],
];

function shapeOf(
  kind: ShapeKind,
  cloud: Cloud,
  state: Float64Array,
  inward: boolean,
): Shape | null {
  const sign = inward ? -1 : 1;
  const axis = (k = 1): Vec3 => normalize([state[3] * k, state[4] * k, state[5] * k]);
  switch (kind) {
    case 'plane':
      return { kind, point: world(cloud, state), normal: axis(sign) };
    case 'sphere':
      return { kind, center: world(cloud, state), radius: sign * Math.abs(state[3]) * cloud.scale };
    case 'cylinder':
      return {
        kind,
        point: world(cloud, state),
        axis: axis(),
        radius: sign * Math.abs(state[6]) * cloud.scale,
      };
    case 'cone': {
      // (axis, -angle) is the same surface as (-axis, angle); (axis, angle) above 90 degrees is
      // (-axis, 180 - angle) with the sides swapped.
      let flip = state[6] < 0 ? -1 : 1;
      let angle = Math.abs(state[6]) % (2 * Math.PI);
      if (angle > Math.PI) return null;
      if (angle > Math.PI / 2) {
        flip = -flip;
        angle = Math.PI - angle;
        inward = !inward;
      }
      if (!(angle > 1e-6 && angle < Math.PI / 2 - 1e-6)) return null;
      return inward
        ? { kind, apex: world(cloud, state), axis: axis(-flip), angle: Math.PI - angle }
        : { kind, apex: world(cloud, state), axis: axis(flip), angle };
    }
  }
}

/**
 * Robust fit that ignores points standing off the surface. Null when the points cannot define the
 * shape. With `weights`, each point counts by its weight in the reweighted refit and the all-point
 * start.
 */
export function fitShape(
  points: Float32Array,
  normals: Float32Array,
  kind: ShapeKind,
  noise: number,
  weights: Float64Array | null = null,
): ShapeFit | null {
  const order = samplingOrder(points, normals, scoringPoints);
  return fitKind(points, normals, kind, noise, order, weights);
}

/** `fitShape` scoring and sampling the points at `order`. */
function fitKind(
  points: Float32Array,
  normals: Float32Array,
  kind: ShapeKind,
  noise: number,
  order: Uint32Array,
  weights: Float64Array | null = null,
): ShapeFit | null {
  if (points.length / 3 < minimumPoints[kind]) return null;
  const cloud = cloudOf(points, normals);
  if (!cloud) return null;
  const floor = Math.max(noise, exact);
  const scaled = floor / cloud.scale;
  const fitter: Fitter<Scorer> = {
    plane: planeFitter,
    sphere: sphereFitter,
    cylinder: cylinderFitter,
    cone: coneFitter,
  }[kind];
  const refused = (points: Cloud, candidate: Fitted) =>
    kind !== 'plane' &&
    flatness(points, kind, candidate) < scaled &&
    !normalsResolve(points, kind, candidate);
  const fitted = robust(cloud, scaled, fitter, order, refused, weights);
  if (!fitted) return null;
  const shape = shapeOf(kind, cloud, fitted.state, fitted.inward);
  if (!shape || refused(cloud, fitted)) return null;
  let sum = 0,
    kept = 0,
    near = 0;
  for (let i = 0; i < cloud.count; i++) {
    const d = shapeDistance(shape, points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
    // Counted against the noise itself: the weights' own scale always keeps at least half.
    if (Math.abs(d) <= 3 * floor) near++;
    if (fitted.weight[i] <= 0) continue;
    sum += d * d;
    kept++;
  }
  const rms = Math.sqrt(sum / kept);
  const support = near / cloud.count;
  return { shape, rms, support, within: rms <= 2 * floor && support >= 0.5 };
}

/**
 * RMS distance of the inliers, projected onto a curved fit, from their own best plane: below the
 * noise the points do not define the curvature, and the fit would only chase it.
 */
function flatness(cloud: Cloud, kind: ShapeKind, fitted: Fitted) {
  const local = shapeOf(kind, { ...cloud, centre: [0, 0, 0], scale: 1 }, fitted.state, false);
  if (!local) return Infinity;
  const projected = new Float32Array(3);
  const sum = [0, 0, 0],
    products = new Float64Array(9);
  let count = 0;
  for (let i = 0; i < cloud.count; i++) {
    if (fitted.weight[i] <= 0) continue;
    projectToShape(local, cloud.p[i * 3], cloud.p[i * 3 + 1], cloud.p[i * 3 + 2], projected);
    count++;
    for (let r = 0; r < 3; r++) {
      sum[r] += projected[r];
      for (let c = 0; c < 3; c++) products[r * 3 + c] += projected[r] * projected[c];
    }
  }
  const covariance = products.map((v, k) => v - (sum[Math.floor(k / 3)] * sum[k % 3]) / count);
  return Math.sqrt(Math.max(0, eigen3(covariance).values[0]) / count);
}

/**
 * True when the measured normals of the inliers follow a curved fit's own normals far more closely
 * than its normals spread over the points: the normals resolve the curvature the positions cannot.
 */
function normalsResolve(cloud: Cloud, kind: ShapeKind, fitted: Fitted) {
  const local = shapeOf(kind, { ...cloud, centre: [0, 0, 0], scale: 1 }, fitted.state, false)!;
  const fittedNormals: Vec3[] = [],
    measured: Vec3[] = [];
  const h = 1e-6;
  for (let i = 0; i < cloud.count; i++) {
    const n = cloud.n.subarray(i * 3, i * 3 + 3);
    if (fitted.weight[i] <= 0 || (n[0] === 0 && n[1] === 0 && n[2] === 0)) continue;
    const p = at(cloud, i);
    const g = [0, 1, 2].map((k) => {
      const q = [...p];
      q[k] += h;
      const forward = shapeDistance(local, q[0], q[1], q[2]);
      q[k] -= 2 * h;
      return forward - shapeDistance(local, q[0], q[1], q[2]);
    });
    if (!(Math.hypot(g[0], g[1], g[2]) > 0)) continue;
    fittedNormals.push(normalize(g));
    measured.push([n[0], n[1], n[2]]);
  }
  if (!fittedNormals.length) return false;
  const products = new Float64Array(9);
  for (const g of fittedNormals)
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) products[r * 3 + c] += g[r] * g[c];
  const principal = eigen3(products).vectors[2];
  const angle = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, Math.abs(dot(a, b))));
  let spread = 0,
    error = 0;
  fittedNormals.forEach((g, i) => {
    spread += angle(g, principal) ** 2;
    error += angle(g, measured[i]) ** 2;
  });
  return error < spread / 4;
}

/**
 * Among the fits within noise, those keeping at least 0.9 of the largest support compete: the
 * plane first, then the better of sphere and of cylinder or cone (a cone over a cylinder only at
 * under half its rms). With none within, the lowest rms of all.
 */
export function fitAuto(points: Float32Array, normals: Float32Array, noise: number): ShapeFit {
  const order = samplingOrder(points, normals, scoringPoints);
  const fit = (kind: ShapeKind) => fitKind(points, normals, kind, noise, order);
  const plane = fit('plane');
  // No fit keeps more than every point, so a plane keeping over 0.9 of them always wins.
  if (plane?.within && plane.support > 0.9) return plane;
  const cylinder = fit('cylinder');
  const cone = fit('cone');
  const sphere = fit('sphere');
  const all = [plane, cylinder, cone, sphere];
  const best = (fits: (ShapeFit | null)[]) =>
    fits.reduce<ShapeFit | null>((a, b) => (b && (!a || b.rms < a.rms) ? b : a), null);
  const most = Math.max(0, ...all.map((fit) => (fit?.within ? fit.support : 0)));
  const near = (fit: ShapeFit | null) => (fit?.within && fit.support >= 0.9 * most ? fit : null);
  if (near(plane)) return plane!;
  const [tube, taper] = [near(cylinder), near(cone)];
  const round = taper && (!tube || taper.rms < tube.rms / 2) ? taper : tube;
  const result = best([round, near(sphere)]) ?? best(all);
  if (!result) throw new Error('These points do not define a surface.');
  return result;
}

/** Signed distance, positive on the side the fitted points' normals face. */
export function shapeDistance(shape: Shape, x: number, y: number, z: number): number {
  switch (shape.kind) {
    case 'plane': {
      const { point: p, normal: n } = shape;
      return (x - p[0]) * n[0] + (y - p[1]) * n[1] + (z - p[2]) * n[2];
    }
    case 'sphere': {
      const c = shape.center;
      return (
        Math.sign(shape.radius) *
        (Math.hypot(x - c[0], y - c[1], z - c[2]) - Math.abs(shape.radius))
      );
    }
    case 'cylinder': {
      const { point: p, axis: a } = shape;
      const w = [x - p[0], y - p[1], z - p[2]];
      const h = dot(w, a);
      const rho = Math.sqrt(Math.max(0, dot(w, w) - h * h));
      return Math.sign(shape.radius) * (rho - Math.abs(shape.radius));
    }
    case 'cone': {
      const { apex: p } = shape;
      return coneDistance(x - p[0], y - p[1], z - p[2], coneFrame(shape.axis, shape.angle));
    }
  }
}

/** Axis, cosine and sine of a cone; (axis, -angle) is the same nappe as (-axis, angle). */
function coneFrame(axis: ArrayLike<number>, angle: number) {
  const k = angle < 0 ? -1 : 1;
  return Float64Array.of(
    k * axis[0],
    k * axis[1],
    k * axis[2],
    Math.cos(k * angle),
    Math.sin(k * angle),
  );
}

/** Signed distance of the offset `w` from a cone's apex to the cone's one nappe. */
function coneDistance(wx: number, wy: number, wz: number, frame: Float64Array) {
  const cos = frame[3],
    sin = frame[4];
  const h = wx * frame[0] + wy * frame[1] + wz * frame[2];
  const rho = Math.sqrt(Math.max(0, wx * wx + wy * wy + wz * wz - h * h));
  const along = h * cos + rho * sin;
  const side = rho * cos - h * sin;
  // Behind the apex the nearest surface point is the apex itself.
  if (along >= 0) return side;
  return (side < 0 ? -1 : 1) * Math.hypot(wx, wy, wz);
}

export function projectToShape(
  shape: Shape,
  x: number,
  y: number,
  z: number,
  out: Float32Array | Float64Array,
  offset = 0,
): void {
  const write = (px: number, py: number, pz: number) => {
    out[offset] = px;
    out[offset + 1] = py;
    out[offset + 2] = pz;
  };
  switch (shape.kind) {
    case 'plane': {
      const d = shapeDistance(shape, x, y, z);
      const n = shape.normal;
      return write(x - d * n[0], y - d * n[1], z - d * n[2]);
    }
    case 'sphere': {
      const c = shape.center;
      const w = [x - c[0], y - c[1], z - c[2]];
      const length = Math.hypot(w[0], w[1], w[2]);
      const k = length > 0 ? Math.abs(shape.radius) / length : 0;
      if (!k) return write(c[0] + Math.abs(shape.radius), c[1], c[2]);
      return write(c[0] + w[0] * k, c[1] + w[1] * k, c[2] + w[2] * k);
    }
    case 'cylinder': {
      const { point: p, axis: a } = shape;
      const w = [x - p[0], y - p[1], z - p[2]];
      const h = dot(w, a);
      const radial = w.map((v, k) => v - h * a[k]);
      const rho = Math.hypot(radial[0], radial[1], radial[2]);
      const direction = rho > 0 ? radial.map((v) => v / rho) : perpendiculars(a)[0];
      const r = Math.abs(shape.radius);
      return write(
        p[0] + h * a[0] + r * direction[0],
        p[1] + h * a[1] + r * direction[1],
        p[2] + h * a[2] + r * direction[2],
      );
    }
    case 'cone': {
      const { apex: p, axis: a, angle } = shape;
      const w = [x - p[0], y - p[1], z - p[2]];
      const h = dot(w, a);
      const radial = w.map((v, k) => v - h * a[k]);
      const rho = Math.hypot(radial[0], radial[1], radial[2]);
      const direction = rho > 0 ? radial.map((v) => v / rho) : perpendiculars(a)[0];
      const cos = Math.cos(angle),
        sin = Math.sin(angle);
      const t = Math.max(0, h * cos + rho * sin);
      return write(
        p[0] + t * (cos * a[0] + sin * direction[0]),
        p[1] + t * (cos * a[1] + sin * direction[1]),
        p[2] + t * (cos * a[2] + sin * direction[2]),
      );
    }
  }
}

/** Relative size below which a pivot of the quadric's QR adds no term the points support. */
const pivotTolerance = 1e-6;

/**
 * Residual sum of squares of the least squares fit of `z` by the richest model the six columns of
 * `a` (column-major, `rows` per column: 1, x, y, x^2, xy, y^2) support. Householder QR pivots the
 * plane terms first and then the quadratic terms by size, and stops at the first pivot below
 * `pivotTolerance` of the first. Overwrites `a` and `z`; NaN when even a plane is unsupported or
 * no residual is left.
 */
function heightResidual(a: Float64Array, z: Float64Array, rows: number) {
  let first = 0,
    rank = 0;
  for (let k = 0; k < 6; k++) {
    let pivot = k,
      largest = -1;
    for (let c = k; c <= (k < 3 ? k : 5); c++) {
      let sum = 0;
      for (let r = k; r < rows; r++) sum += a[c * rows + r] ** 2;
      if (sum > largest) ((largest = sum), (pivot = c));
    }
    const size = Math.sqrt(largest);
    if (k === 0) first = size;
    if (!(size > pivotTolerance * first)) break;
    if (pivot !== k)
      for (let r = 0; r < rows; r++) {
        const t = a[k * rows + r];
        a[k * rows + r] = a[pivot * rows + r];
        a[pivot * rows + r] = t;
      }
    // Householder reflection taking column k below the diagonal to zero.
    const head = a[k * rows + k];
    const alpha = head > 0 ? -size : size;
    a[k * rows + k] = head - alpha;
    const length = largest - head * head + (head - alpha) ** 2;
    const reflect = (column: Float64Array, offset: number) => {
      let projection = 0;
      for (let r = k; r < rows; r++) projection += a[k * rows + r] * column[offset + r];
      const f = (2 * projection) / length;
      for (let r = k; r < rows; r++) column[offset + r] -= f * a[k * rows + r];
    };
    for (let c = k + 1; c < 6; c++) reflect(a, c * rows);
    reflect(z, 0);
    rank = k + 1;
  }
  if (rank < 3 || rows <= rank) return NaN;
  let squared = 0;
  for (let r = rank; r < rows; r++) squared += z[r] * z[r];
  return squared;
}

const maximumSamples = 2000;

/** Rings spanning about 0.4 mm at an edge length of `step`, so noise is read at one real scale. */
export const noiseRings = (step: number) => Math.min(24, Math.max(4, Math.round(0.4 / step)));

/**
 * Surface roughness at the scale of `rings` rings: the median over sampled vertices of the RMS
 * residual of a quadric height field fitted to each vertex's neighbourhood, so curvature is
 * absorbed and ripple and noise remain. A neighbourhood too narrow for the quadric drops the terms
 * it cannot support, down to a plane.
 */
export function estimateNoise(
  mesh: RefineMesh,
  topology: RefineTopology,
  vertices?: Uint32Array,
  rings = 6,
): number {
  const eligible = vertices ? vertices.length : mesh.weldedCount;
  const samples = Math.min(eligible, maximumSamples);
  const stride = eligible / Math.max(samples, 1);
  const { position, weldedCount } = mesh;
  const { neighbourStart, neighbours } = topology;
  const residuals = new Float64Array(samples);
  const stamp = new Uint32Array(weldedCount);
  let gathered = new Uint32Array(256);
  const normal = new Float32Array(3);
  let design = new Float64Array(256 * 6),
    heights = new Float64Array(256);
  let used = 0;
  for (let s = 0; s < samples; s++) {
    const i = Math.floor(s * stride);
    const seed = vertices ? vertices[i] : i;
    const mark = s + 1;
    stamp[seed] = mark;
    gathered[0] = seed;
    let count = 1,
      ringStart = 0;
    for (let ring = 0; ring < rings; ring++) {
      const ringEnd = count;
      for (let g = ringStart; g < ringEnd; g++) {
        const v = gathered[g];
        for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
          const w = neighbours[j];
          if (stamp[w] === mark) continue;
          stamp[w] = mark;
          if (count === gathered.length) {
            const grown = new Uint32Array(count * 2);
            grown.set(gathered);
            gathered = grown;
          }
          gathered[count++] = w;
        }
      }
      ringStart = ringEnd;
    }
    // A plane needs more than three points to leave a residual; rank is checked by the QR.
    if (count <= 3) continue;
    let nx = 0,
      ny = 0,
      nz = 0,
      cx = 0,
      cy = 0,
      cz = 0;
    for (let g = 0; g < count; g++) {
      const v = gathered[g];
      vertexNormal(mesh, topology, v, normal);
      nx += normal[0];
      ny += normal[1];
      nz += normal[2];
      cx += position[v * 3];
      cy += position[v * 3 + 1];
      cz += position[v * 3 + 2];
    }
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-9) continue;
    const n: Vec3 = [nx / length, ny / length, nz / length];
    const [u, w] = perpendiculars(n);
    cx /= count;
    cy /= count;
    cz /= count;
    let spread = 0;
    for (let g = 0; g < count; g++) {
      const v = gathered[g] * 3;
      spread += (position[v] - cx) ** 2 + (position[v + 1] - cy) ** 2 + (position[v + 2] - cz) ** 2;
    }
    // Local coordinates are scaled to unit RMS radius so the pivots compare like with like.
    const scale = Math.sqrt(spread / count) || 1;
    if (design.length < count * 6) {
      design = new Float64Array(count * 12);
      heights = new Float64Array(count * 2);
    }
    for (let g = 0; g < count; g++) {
      const v = gathered[g] * 3;
      const dx = position[v] - cx,
        dy = position[v + 1] - cy,
        dz = position[v + 2] - cz;
      const x = (dx * u[0] + dy * u[1] + dz * u[2]) / scale;
      const y = (dx * w[0] + dy * w[1] + dz * w[2]) / scale;
      design[g] = 1;
      design[count + g] = x;
      design[2 * count + g] = y;
      design[3 * count + g] = x * x;
      design[4 * count + g] = x * y;
      design[5 * count + g] = y * y;
      heights[g] = (dx * n[0] + dy * n[1] + dz * n[2]) / scale;
    }
    const squared = heightResidual(design, heights, count);
    if (!Number.isFinite(squared)) continue;
    residuals[used++] = Math.sqrt(squared / count) * scale;
  }
  return median(residuals.subarray(0, used));
}

/** Unit normal of `shape` where the point projects, on the side `shapeDistance` counts positive. */
export function shapeNormal(
  shape: Shape,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): void {
  const h = 1e-5;
  for (let k = 0; k < 3; k++) {
    const q = [x, y, z];
    q[k] += h;
    const forward = shapeDistance(shape, q[0], q[1], q[2]);
    q[k] -= 2 * h;
    out[k] = forward - shapeDistance(shape, q[0], q[1], q[2]);
  }
  const length = Math.hypot(out[0], out[1], out[2]);
  if (length > 0) for (let k = 0; k < 3; k++) out[k] /= length;
}
