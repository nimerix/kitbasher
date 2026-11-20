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
  /** True when rms <= 2 * noise. */
  within: boolean;
}

const tukey = 4.685;
const rounds = 10;
const minimumPoints: Record<ShapeKind, number> = { plane: 3, sphere: 4, cylinder: 5, cone: 6 };
/** Points in each seeded sample a fit is started from, and how many samples are tried. */
const sampleSize: Record<ShapeKind, number> = { plane: 3, sphere: 6, cylinder: 6, cone: 8 };
const samples = 64;
/** Floor of the weighting scale in cloud units, so exact data keeps its points. */
const exact = 1e-9;

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

/** The lower median, the value a sort would put at (length - 1) >> 1, found by selection. */
function median(values: Float64Array) {
  if (!values.length) return 0;
  const a = Float64Array.from(values);
  const k = (a.length - 1) >> 1;
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
function reweight(residual: Float64Array, noise: number, weight: Float64Array) {
  const scale = Math.max(1.4826 * median(residual.map(Math.abs)), noise, exact);
  const cut = tukey * scale;
  for (let i = 0; i < residual.length; i++) {
    const u = residual[i] / cut;
    weight[i] = Math.abs(u) < 1 ? (1 - u * u) ** 2 : 0;
  }
}

/** Damped Gauss-Newton on the weighted squared residuals, with a central-difference Jacobian. */
function refine(model: Model, cloud: Cloud, state: Float64Array, weight: Float64Array) {
  const { count } = cloud;
  const size = model.parameters,
    h = 1e-6;
  const residual = new Float64Array(count),
    plus = new Float64Array(count),
    minus = new Float64Array(count);
  const jacobian = Array.from({ length: size }, () => new Float64Array(count));
  const cost = (s: Float64Array) => {
    model.residuals(s, residual);
    let sum = 0;
    for (let i = 0; i < count; i++) sum += weight[i] * residual[i] * residual[i];
    return sum;
  };
  let current = cost(state),
    damping = 1e-3;
  for (let iteration = 0; iteration < 20; iteration++) {
    const step = new Float64Array(size);
    for (let j = 0; j < size; j++) {
      step.fill(0);
      step[j] = h;
      const forward = model.perturb(state, step);
      step[j] = -h;
      const backward = model.perturb(state, step);
      model.residuals(forward, plus);
      model.residuals(backward, minus);
      for (let i = 0; i < count; i++) jacobian[j][i] = (plus[i] - minus[i]) / (2 * h);
    }
    model.residuals(state, residual);
    const normal = new Matrix(size, size),
      gradient = new Matrix(size, 1);
    for (let a = 0; a < size; a++) {
      let g = 0;
      for (let i = 0; i < count; i++) g += weight[i] * jacobian[a][i] * residual[i];
      gradient.set(a, 0, -g);
      for (let b = a; b < size; b++) {
        let sum = 0;
        for (let i = 0; i < count; i++) sum += weight[i] * jacobian[a][i] * jacobian[b][i];
        normal.set(a, b, sum);
        normal.set(b, a, sum);
      }
    }
    let improved = false;
    while (damping < 1e8) {
      const damped = normal.clone();
      for (let a = 0; a < size; a++) damped.set(a, a, normal.get(a, a) * (1 + damping) + 1e-12);
      const delta = Float64Array.from(solve(damped, gradient).getColumn(0));
      const next = delta.every(Number.isFinite) ? model.perturb(state, delta) : state;
      const value = next === state ? Infinity : cost(next);
      if (value <= current) {
        const settled = current - value <= 1e-12 * current;
        state = next;
        current = value;
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

/**
 * Iteratively reweighted fit: `fit` takes weights and the previous state and returns a state. It
 * starts from whichever of the all-point start and `samples` seeded samples of `size` points has
 * the least median absolute residual, so a minority of points off the surface cannot move it.
 */
function robust(
  cloud: Cloud,
  noise: number,
  size: number,
  model: Pick<Model, 'residuals' | 'gradient'>,
  fit: (weight: Float64Array, previous: Float64Array | null) => Float64Array | null,
): Fitted | null {
  const { count } = cloud;
  const weight = new Float64Array(count).fill(1),
    residual = new Float64Array(count);
  let state: Float64Array | null = null,
    least = Infinity;
  const consider = (candidate: Float64Array | null) => {
    if (!candidate || !candidate.every(Number.isFinite)) return;
    model.residuals(candidate, residual);
    for (let i = 0; i < count; i++) residual[i] = Math.abs(residual[i]);
    const score = median(residual);
    if (score < least) {
      least = score;
      state = candidate;
    }
  };
  consider(fit(weight, null));
  let seed = 0x2545f491;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let sample = 0; count > size && sample < samples; sample++) {
    weight.fill(0);
    for (let picked = 0; picked < size;) {
      const i = Math.floor(random() * count);
      if (!weight[i]) ((weight[i] = 1), picked++);
    }
    consider(fit(weight, null));
  }
  for (let round = 0; state && round < rounds; round++) {
    model.residuals(state, residual);
    reweight(residual, noise, weight);
    state = fit(weight, state);
  }
  const final: Float64Array | null = state;
  if (!final || !final.every(Number.isFinite)) return null;
  model.residuals(final, residual);
  reweight(residual, noise, weight);
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

/** State: point (3), unit normal (3). */
function fitPlane(cloud: Cloud, noise: number) {
  const residuals = (state: Float64Array, out: Float64Array) => {
    for (let i = 0; i < cloud.count; i++)
      out[i] =
        (cloud.p[i * 3] - state[0]) * state[3] +
        (cloud.p[i * 3 + 1] - state[1]) * state[4] +
        (cloud.p[i * 3 + 2] - state[2]) * state[5];
  };
  const model = { residuals, gradient: (s: Float64Array): Vec3 => [s[3], s[4], s[5]] };
  return robust(cloud, noise, sampleSize.plane, model, (weight) => {
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
  });
}

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
function fitSphere(cloud: Cloud, noise: number) {
  const model: Model = {
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
  };
  return robust(cloud, noise, sampleSize.sphere, model, (weight, previous) => {
    if (previous) return refine(model, cloud, previous, weight);
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
    if (!x) return null;
    const radius = Math.sqrt(x[3] + x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
    return Number.isFinite(radius) ? Float64Array.from([x[0], x[1], x[2], radius]) : null;
  });
}

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
function fitCylinder(cloud: Cloud, noise: number) {
  const model: Model = {
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
  };
  return robust(cloud, noise, sampleSize.cylinder, model, (weight, previous) => {
    if (previous) return refine(model, cloud, previous, weight);
    const start = normalAxis(cloud, false, weight);
    if (!start) return null;
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
    if (!x) return null;
    const radius = Math.sqrt(x[2] + x[0] * x[0] + x[1] * x[1]);
    if (!Number.isFinite(radius)) return null;
    const point = [0, 1, 2].map((k) => x[0] * u[k] + x[1] * v[k]);
    return Float64Array.from([...point, ...axis, radius]);
  });
}

/** State: apex (3), unit axis (3), angle from the axis. */
function fitCone(cloud: Cloud, noise: number) {
  const model: Model = {
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
  };
  return robust(cloud, noise, sampleSize.cone, model, (weight, previous) => {
    if (previous) return refine(model, cloud, previous, weight);
    const start = normalAxis(cloud, true, weight);
    if (!start) return null;
    let axis = start.axis;
    // Outward normals of a cone make the angle (90 degrees + half angle) with the axis.
    let along = dot(start.mean, axis);
    if (along > 0) {
      axis = axis.map((v) => -v) as Vec3;
      along = -along;
    }
    const angle = Math.asin(Math.min(1, -along));
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
    return apex && angle > 0 ? Float64Array.from([...apex, ...axis, angle]) : null;
  });
}

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

/** Robust fit that ignores points standing off the surface. Null when the points cannot define the shape. */
export function fitShape(
  points: Float32Array,
  normals: Float32Array,
  kind: ShapeKind,
  noise: number,
): ShapeFit | null {
  if (points.length / 3 < minimumPoints[kind]) return null;
  const cloud = cloudOf(points, normals);
  if (!cloud) return null;
  const scaled = noise / cloud.scale;
  const fitted =
    kind === 'plane'
      ? fitPlane(cloud, scaled)
      : kind === 'sphere'
        ? fitSphere(cloud, scaled)
        : kind === 'cylinder'
          ? fitCylinder(cloud, scaled)
          : fitCone(cloud, scaled);
  if (!fitted) return null;
  const shape = shapeOf(kind, cloud, fitted.state, fitted.inward);
  if (!shape) return null;
  if (
    kind !== 'plane' &&
    flatness(cloud, kind, fitted) < scaled &&
    !normalsResolve(cloud, kind, fitted)
  )
    return null;
  let sum = 0,
    kept = 0;
  for (let i = 0; i < cloud.count; i++) {
    if (fitted.weight[i] <= 0) continue;
    const d = shapeDistance(shape, points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
    sum += d * d;
    kept++;
  }
  const rms = Math.sqrt(sum / kept);
  return { shape, rms, within: rms <= 2 * Math.max(noise, exact * cloud.scale) };
}

/**
 * RMS distance of the inliers, projected onto a curved fit, from their own best plane: below the
 * noise the points do not define the curvature, and the fit would only chase it.
 */
function flatness(cloud: Cloud, kind: ShapeKind, fitted: Fitted) {
  const local = shapeOf(kind, { ...cloud, centre: [0, 0, 0], scale: 1 }, fitted.state, false)!;
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
 * Plane when it is within noise; else the best within noise of sphere and of cylinder or cone (a
 * cone over a cylinder only at under half its rms); else the lowest rms of all.
 */
export function fitAuto(points: Float32Array, normals: Float32Array, noise: number): ShapeFit {
  const plane = fitShape(points, normals, 'plane', noise);
  if (plane?.within) return plane;
  const cylinder = fitShape(points, normals, 'cylinder', noise);
  const cone = fitShape(points, normals, 'cone', noise);
  const sphere = fitShape(points, normals, 'sphere', noise);
  const within = (fit: ShapeFit | null) => (fit?.within ? fit : null);
  const [tube, taper] = [within(cylinder), within(cone)];
  const round = taper && (!tube || taper.rms < tube.rms / 2) ? taper : tube;
  const best = (fits: (ShapeFit | null)[]) =>
    fits.reduce<ShapeFit | null>((a, b) => (b && (!a || b.rms < a.rms) ? b : a), null);
  const result = best([round, within(sphere)]) ?? best([plane, cylinder, cone, sphere]);
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
  out: Float32Array,
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

/** Solves the 6x6 system `a x = b` in place by Gaussian elimination; false if rank deficient. */
function solve6(a: Float64Array, b: Float64Array) {
  let largest = 0;
  for (let c = 0; c < 6; c++) largest = Math.max(largest, Math.abs(a[c * 7]));
  const tiny = 1e-12 * largest;
  for (let c = 0; c < 6; c++) {
    let pivot = c;
    for (let r = c + 1; r < 6; r++)
      if (Math.abs(a[r * 6 + c]) > Math.abs(a[pivot * 6 + c])) pivot = r;
    if (!(Math.abs(a[pivot * 6 + c]) > tiny)) return false;
    if (pivot !== c) {
      for (let k = 0; k < 6; k++) {
        const t = a[c * 6 + k];
        a[c * 6 + k] = a[pivot * 6 + k];
        a[pivot * 6 + k] = t;
      }
      const t = b[c];
      b[c] = b[pivot];
      b[pivot] = t;
    }
    for (let r = c + 1; r < 6; r++) {
      const f = a[r * 6 + c] / a[c * 6 + c];
      for (let k = c; k < 6; k++) a[r * 6 + k] -= f * a[c * 6 + k];
      b[r] -= f * b[c];
    }
  }
  for (let r = 5; r >= 0; r--) {
    let sum = b[r];
    for (let k = r + 1; k < 6; k++) sum -= a[r * 6 + k] * b[k];
    b[r] = sum / a[r * 6 + r];
  }
  return true;
}

const maximumSamples = 2000;

/**
 * Surface roughness at the scale of `rings` rings: the median over sampled vertices of the RMS
 * residual of a quadric height field fitted to each vertex's neighbourhood, so curvature is
 * absorbed and ripple and noise remain.
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
  const normalMatrix = new Float64Array(36);
  const rhs = new Float64Array(6);
  const row = new Float64Array(6);
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
    // A quadric needs more than six points to leave a residual; rank is checked by the solve.
    if (count <= 6) continue;
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
    // Local coordinates are scaled to unit RMS radius so the normal equations stay conditioned.
    const scale = Math.sqrt(spread / count) || 1;
    normalMatrix.fill(0);
    rhs.fill(0);
    for (let g = 0; g < count; g++) {
      const v = gathered[g] * 3;
      const dx = position[v] - cx,
        dy = position[v + 1] - cy,
        dz = position[v + 2] - cz;
      const x = (dx * u[0] + dy * u[1] + dz * u[2]) / scale;
      const y = (dx * w[0] + dy * w[1] + dz * w[2]) / scale;
      const z = (dx * n[0] + dy * n[1] + dz * n[2]) / scale;
      row[0] = 1;
      row[1] = x;
      row[2] = y;
      row[3] = x * x;
      row[4] = x * y;
      row[5] = y * y;
      for (let r = 0; r < 6; r++) {
        rhs[r] += row[r] * z;
        for (let c = 0; c < 6; c++) normalMatrix[r * 6 + c] += row[r] * row[c];
      }
    }
    if (!solve6(normalMatrix, rhs)) continue;
    let squared = 0;
    for (let g = 0; g < count; g++) {
      const v = gathered[g] * 3;
      const dx = position[v] - cx,
        dy = position[v + 1] - cy,
        dz = position[v + 2] - cz;
      const x = (dx * u[0] + dy * u[1] + dz * u[2]) / scale;
      const y = (dx * w[0] + dy * w[1] + dz * w[2]) / scale;
      const z = (dx * n[0] + dy * n[1] + dz * n[2]) / scale;
      const fit =
        rhs[0] + rhs[1] * x + rhs[2] * y + rhs[3] * x * x + rhs[4] * x * y + rhs[5] * y * y;
      squared += (z - fit) ** 2;
    }
    residuals[used++] = Math.sqrt(squared / count) * scale;
  }
  return median(residuals.subarray(0, used));
}
