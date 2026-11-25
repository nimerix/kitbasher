import { EigenvalueDecomposition, Matrix } from 'ml-matrix';
import type { Vec3 } from './types';

// Polylines as flat [x, y, z, ...] arrays: arc length, corners, and line and circle fits.

/** Arc length at each point of a polyline. */
export function stations(points: number[], closed: boolean) {
  const count = points.length / 3;
  const s = new Float64Array(count + (closed ? 1 : 0));
  for (let i = 1; i < s.length; i++) {
    const a = (i - 1) * 3,
      b = (i % count) * 3;
    s[i] =
      s[i - 1] +
      Math.hypot(
        points[b] - points[a],
        points[b + 1] - points[a + 1],
        points[b + 2] - points[a + 2],
      );
  }
  return s;
}

/** Point at arc length `at` along a polyline with `stations` `s`. */
export function pointAt(points: number[], s: Float64Array, at: number, closed: boolean): Vec3 {
  const count = points.length / 3;
  const total = s[s.length - 1];
  if (closed) at = ((at % total) + total) % total;
  else at = Math.min(Math.max(at, 0), total);
  let lo = 0,
    hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= at) lo = mid;
    else hi = mid;
  }
  const f = s[hi] > s[lo] ? (at - s[lo]) / (s[hi] - s[lo]) : 0;
  const a = lo * 3,
    b = (hi % count) * 3;
  return [0, 1, 2].map((k) => points[a + k] + f * (points[b + k] - points[a + k])) as Vec3;
}

/** Mean of a polyline's points between two arc lengths, sampled evenly. */
export function meanBetween(
  points: number[],
  s: Float64Array,
  from: number,
  to: number,
  closed: boolean,
) {
  const mean: Vec3 = [0, 0, 0];
  const samples = 8;
  for (let j = 0; j < samples; j++) {
    const p = pointAt(points, s, from + ((to - from) * (j + 0.5)) / samples, closed);
    for (let k = 0; k < 3; k++) mean[k] += p[k] / samples;
  }
  return mean;
}

/** Indices where the polyline turns by more than `limit` degrees over `window` behind and ahead. */
export function corners(points: number[], closed: boolean, window: number, limit: number) {
  const count = points.length / 3;
  const s = stations(points, closed);
  const total = s[s.length - 1];
  const turn = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    if (!closed && (s[i] < window || s[i] > total - window)) continue;
    // Directions from the mean of the window behind to the middle, and on to the mean ahead.
    const before = meanBetween(points, s, s[i] - window, s[i], closed),
      here = meanBetween(points, s, s[i] - window / 4, s[i] + window / 4, closed),
      after = meanBetween(points, s, s[i], s[i] + window, closed);
    const u = [0, 1, 2].map((k) => here[k] - before[k]),
      w = [0, 1, 2].map((k) => after[k] - here[k]);
    const lu = Math.hypot(u[0], u[1], u[2]),
      lw = Math.hypot(w[0], w[1], w[2]);
    if (!(lu > 0 && lw > 0)) continue;
    const cos = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (lu * lw);
    turn[i] = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
  }
  // The sharpest point of each run of turning points.
  const cuts: number[] = [];
  for (let i = 0; i < count; i++) {
    if (turn[i] <= limit) continue;
    let best = i;
    let j = i;
    while (j + 1 < count && turn[j + 1] > limit) if (turn[++j] > turn[best]) best = j;
    cuts.push(best);
    i = j;
  }
  return cuts;
}

export interface Circle {
  rms: number;
  centre: Vec3;
  radius: number;
  /** Unit axes of the circle's plane. */
  u: Vec3;
  v: Vec3;
}

export function principalAxes(points: number[]) {
  const count = points.length / 3;
  const mean: Vec3 = [0, 0, 0];
  for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) mean[k] += points[i * 3 + k] / count;
  const c = new Matrix(3, 3);
  for (let i = 0; i < count; i++)
    for (let r = 0; r < 3; r++)
      for (let q = 0; q < 3; q++)
        c.set(r, q, c.get(r, q) + (points[i * 3 + r] - mean[r]) * (points[i * 3 + q] - mean[q]));
  const e = new EigenvalueDecomposition(c, { assumeSymmetric: true });
  const order = [0, 1, 2].sort((a, b) => e.realEigenvalues[b] - e.realEigenvalues[a]);
  const vectors = order.map((j) => [0, 1, 2].map((r) => e.eigenvectorMatrix.get(r, j)) as Vec3);
  return { mean, vectors };
}

/** RMS distance of the points from their best line. */
export function lineRms(points: number[]) {
  const count = points.length / 3;
  const { mean, vectors } = principalAxes(points);
  const d = vectors[0];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const w = [0, 1, 2].map((k) => points[i * 3 + k] - mean[k]);
    const t = w[0] * d[0] + w[1] * d[1] + w[2] * d[2];
    sum += w[0] ** 2 + w[1] ** 2 + w[2] ** 2 - t * t;
  }
  return Math.sqrt(Math.max(0, sum) / count);
}

/** Circle in the points' best plane, by least squares on x^2 + y^2 + D x + E y + F. */
export function fitCircle(points: number[]): Circle | null {
  const count = points.length / 3;
  if (count < 3) return null;
  const { mean, vectors } = principalAxes(points);
  const [u, v, normal] = vectors;
  const a = new Matrix(3, 3),
    r = new Matrix(3, 1);
  const xy: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const w = [0, 1, 2].map((k) => points[i * 3 + k] - mean[k]);
    const x = w[0] * u[0] + w[1] * u[1] + w[2] * u[2],
      y = w[0] * v[0] + w[1] * v[1] + w[2] * v[2];
    xy.push([x, y]);
    const row = [x, y, 1];
    const rhs = -(x * x + y * y);
    for (let p = 0; p < 3; p++) {
      r.set(p, 0, r.get(p, 0) + row[p] * rhs);
      for (let q = 0; q < 3; q++) a.set(p, q, a.get(p, q) + row[p] * row[q]);
    }
  }
  let solution: Matrix;
  try {
    solution = solve3(a, r);
  } catch {
    return null;
  }
  const cx = -solution.get(0, 0) / 2,
    cy = -solution.get(1, 0) / 2;
  const radius = Math.sqrt(Math.max(0, cx * cx + cy * cy - solution.get(2, 0)));
  if (!Number.isFinite(radius) || radius <= 0) return null;
  let sum = 0;
  xy.forEach(([x, y], i) => {
    const h = [0, 1, 2].reduce((acc, k) => acc + (points[i * 3 + k] - mean[k]) * normal[k], 0);
    sum += h * h + (Math.hypot(x - cx, y - cy) - radius) ** 2;
  });
  const centre = [0, 1, 2].map((k) => mean[k] + cx * u[k] + cy * v[k]) as Vec3;
  return { rms: Math.sqrt(sum / count), centre, radius, u, v };
}

function solve3(a: Matrix, r: Matrix) {
  const m = a.to2DArray();
  const det = (q: number[][]) =>
    q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) -
    q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) +
    q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
  const d = det(m);
  if (!(Math.abs(d) > 1e-30)) throw new Error('singular');
  const out = new Matrix(3, 1);
  for (let k = 0; k < 3; k++)
    out.set(
      k,
      0,
      det(m.map((row, i) => row.map((value, j) => (j === k ? r.get(i, 0) : value)))) / d,
    );
  return out;
}

/** Point on a fitted circle at the angle of `p`. */
export function onCircle(fit: Circle, p: Vec3): Vec3 {
  const { centre, radius, u, v } = fit;
  const w = [0, 1, 2].map((k) => p[k] - centre[k]);
  const angle = Math.atan2(
    w[0] * v[0] + w[1] * v[1] + w[2] * v[2],
    w[0] * u[0] + w[1] * u[1] + w[2] * u[2],
  );
  return [0, 1, 2].map(
    (k) => centre[k] + radius * (Math.cos(angle) * u[k] + Math.sin(angle) * v[k]),
  ) as Vec3;
}
