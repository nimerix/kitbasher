import { describe, expect, it } from 'vitest';
import {
  type EdgeCurve,
  closestOnCurve,
  curveTangent,
  drawnCurve,
  fitCurve,
  joinCurves,
} from '../../src/core/refine-curve';
import {
  cornersOf,
  largestGap,
  maxDistance,
  nearestRectangleCorner,
  noisyArc,
  noisyLine,
  noisyWave,
  rectangleSides,
  rms,
  waveDistance,
} from '../helpers/refine';

/** An open curve through the given points, as it is, with its lengths. */
function curveThrough(points: number[]): EdgeCurve {
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
  return {
    points: Float64Array.from(points),
    lengths,
    corner: new Uint8Array(count),
    closed: false,
  };
}

/** Exact samples 0.05 apart on the circle of `radius` in the XZ plane, from angle `from` to `to`. */
function arcSamples(radius: number, from: number, to: number) {
  const count = Math.ceil((radius * Math.abs(to - from)) / 0.05);
  const points: number[] = [];
  for (let i = 0; i <= count; i++) {
    const angle = from + ((to - from) * i) / count;
    points.push(radius * Math.cos(angle), 0, radius * Math.sin(angle));
  }
  return Float64Array.from(points);
}

/** Distance from a point to the infinite line through two points. */
function lineDistance(p: ArrayLike<number>, a: ArrayLike<number>, b: ArrayLike<number>) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const f = (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / dd;
  return Math.hypot(w[0] - d[0] * f, w[1] - d[1] * f, w[2] - d[2] * f);
}

/** Distance from a point to the segment between two points. */
function segmentDistance(p: ArrayLike<number>, a: ArrayLike<number>, b: ArrayLike<number>) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const f = Math.min(1, Math.max(0, (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / dd));
  return Math.hypot(w[0] - d[0] * f, w[1] - d[1] * f, w[2] - d[2] * f);
}

/** Length of a curve including its closing span. */
function totalLength(curve: EdgeCurve) {
  const count = curve.lengths.length,
    p = curve.points;
  const closing = curve.closed
    ? Math.hypot(p[0] - p[count * 3 - 3], p[1] - p[count * 3 - 2], p[2] - p[count * 3 - 1])
    : 0;
  return curve.lengths[count - 1] + closing;
}

describe('refine curves', () => {
  it('fits a straight line through noisy samples', () => {
    const c = fitCurve('line', noisyLine([0, 0, 0], [10, 0, 0], 0.02), 2, 0.05);
    expect(maxDistance(c.points, (_x, y, z) => Math.hypot(y, z))).toBeLessThan(0.005);
    expect(c.lengths[c.lengths.length - 1]).toBeCloseTo(10, 1);
    expect(largestGap(c)).toBeLessThanOrEqual(0.05 * (1 + 1e-4));
  });

  it('fits an arc and a full circle', () => {
    const quarter = fitCurve('arc', noisyArc(5, 0, Math.PI / 2, 0.02), 3, 0.05);
    expect(
      maxDistance(quarter.points, (x, y, z) => Math.abs(Math.hypot(x, z) - 5) + Math.abs(y)),
    ).toBeLessThan(0.01);
    expect(quarter.closed).toBe(false);
    const end = quarter.points.length - 3;
    expect(Math.hypot(quarter.points[0] - 5, quarter.points[2])).toBeLessThan(0.01);
    expect(Math.hypot(quarter.points[end], quarter.points[end + 2] - 5)).toBeLessThan(0.01);
    expect(quarter.lengths[quarter.lengths.length - 1]).toBeCloseTo((5 * Math.PI) / 2, 1);
    const full = fitCurve('arc', noisyArc(5, 0, Math.PI * 2, 0.02), 3, 0.05);
    expect(full.closed).toBe(true);
    expect(largestGap(full)).toBeLessThanOrEqual(0.05 * (1 + 1e-4));
  });

  it('fits far from the origin', () => {
    const samples = noisyArc(5, 0, Math.PI / 2, 0.02).map((v, i) => v + [200, -150, 300][i % 3]);
    const quarter = fitCurve('arc', samples, 3, 0.05);
    expect(
      maxDistance(
        quarter.points,
        (x, y, z) => Math.abs(Math.hypot(x - 200, z - 300) - 5) + Math.abs(y + 150),
      ),
    ).toBeLessThan(0.01);
  });

  it('gives a spline more freedom with more controls', () => {
    const wave = noisyWave(0.02);
    expect(rms(fitCurve('spline', wave, 12, 0.05), waveDistance)).toBeLessThan(
      rms(fitCurve('spline', wave, 4, 0.05), waveDistance),
    );
    expect(rms(fitCurve('spline', wave, 12, 0.05), waveDistance)).toBeLessThan(0.02);
  });

  it('joins four lines into a closed rectangle with exact corners', () => {
    const sides = rectangleSides(4, 3, 0.02).map((s) => fitCurve('line', s, 2, 0.05));
    const loop = joinCurves(
      sides,
      ['line', 'line', 'line', 'line'],
      ['sharp', 'sharp', 'sharp', 'sharp'],
      true,
      0.05,
    );
    expect(loop.closed).toBe(true);
    expect(cornersOf(loop)).toHaveLength(4);
    for (const c of cornersOf(loop)) expect(nearestRectangleCorner(c, 4, 3)).toBeLessThan(0.01);
    expect(largestGap(loop)).toBeLessThanOrEqual(0.05 * (1 + 1e-4));
  });

  it('joins a line to an arc smoothly without a corner', () => {
    // A slot end: a line along z = 1, a half circle of radius 1 through (1, 0, 0), a line back
    // along z = -1. Each piece stops short of the tangent points.
    const curves = [
      fitCurve('line', noisyLine([-5, 0, 1], [-0.3, 0, 1], 0.02), 2, 0.05),
      fitCurve('arc', noisyArc(1, Math.PI / 2 - 0.3, -Math.PI / 2 + 0.3, 0.02), 3, 0.05),
      fitCurve('line', noisyLine([-0.3, 0, -1], [-5, 0, -1], 0.02), 2, 0.05),
    ];
    const slot = joinCurves(curves, ['line', 'arc', 'line'], ['smooth', 'smooth'], false, 0.05);
    expect(slot.closed).toBe(false);
    expect(slot.corner.every((sharp) => sharp === 0)).toBe(true);
    expect(largestGap(slot)).toBeLessThanOrEqual(0.05 * (1 + 1e-4));
    const slotDistance = (x: number, y: number, z: number) =>
      (x <= 0 ? Math.min(Math.abs(z - 1), Math.abs(z + 1)) : Math.abs(Math.hypot(x, z) - 1)) +
      Math.abs(y);
    expect(maxDistance(slot.points, slotDistance)).toBeLessThan(0.01);
  });

  it('finds the closest point and station', () => {
    const c = fitCurve('line', noisyLine([0, 0, 0], [10, 0, 0], 0.02), 2, 0.05);
    const out = new Float32Array(3);
    expect(closestOnCurve(c, 3, 1, 0, out)).toBeCloseTo(3, 1);
    expect(Math.hypot(out[0] - 3, out[1], out[2])).toBeLessThan(0.01);
  });

  it('finds the closest point on the closing span of a closed curve', () => {
    const full = fitCurve('arc', noisyArc(5, 0, Math.PI * 2, 0), 3, 0.05);
    const count = full.lengths.length;
    const last = full.points.subarray(count * 3 - 3);
    const [mx, my, mz] = [0, 1, 2].map((axis) => (last[axis] + full.points[axis]) / 2);
    const out = new Float32Array(3);
    const station = closestOnCurve(full, mx * 1.1, my, mz * 1.1, out);
    expect(station).toBeGreaterThan(full.lengths[count - 1]);
    expect(station).toBeLessThan(totalLength(full));
    expect(Math.hypot(out[0] - mx, out[1] - my, out[2] - mz)).toBeLessThan(1e-4);
  });

  it('gives tangents along the curve and wraps stations on a closed curve', () => {
    const full = fitCurve('arc', noisyArc(5, 0, Math.PI * 2, 0), 3, 0.05);
    const out = new Float32Array(3);
    const wrapped = new Float32Array(3);
    curveTangent(full, 1.3, out);
    curveTangent(full, 1.3 + totalLength(full), wrapped);
    expect(Math.hypot(out[0], out[1], out[2])).toBeCloseTo(1, 5);
    for (let axis = 0; axis < 3; axis++) expect(wrapped[axis]).toBeCloseTo(out[axis], 3);
    const point = new Float32Array(3);
    const station = closestOnCurve(full, 5 * Math.cos(0.26), 0, 5 * Math.sin(0.26), point);
    curveTangent(full, station, out);
    const radial = [point[0] / 5, point[1] / 5, point[2] / 5];
    expect(Math.abs(out[0] * radial[0] + out[1] * radial[1] + out[2] * radial[2])).toBeLessThan(
      0.01,
    );
  });

  it('draws a chord, a circle through three points and a Catmull-Rom spline', () => {
    const chord = drawnCurve('line', new Float32Array([0, 0, 0, 2, 0, 0, 4, 1, 0]), 0.05);
    expect(chord.lengths[chord.lengths.length - 1]).toBeCloseTo(Math.hypot(4, 1), 4);
    const arc = drawnCurve('arc', new Float32Array([5, 0, 0, 0, 0, 5, -5, 0, 0]), 0.05);
    expect(
      maxDistance(arc.points, (x, y, z) => Math.abs(Math.hypot(x, z) - 5) + Math.abs(y)),
    ).toBeLessThan(1e-4);
    expect(arc.lengths[arc.lengths.length - 1]).toBeCloseTo(5 * Math.PI, 2);
    const through = new Float32Array(3);
    closestOnCurve(arc, 0, 0, 5, through);
    expect(Math.hypot(through[0], through[1], through[2] - 5)).toBeLessThan(1e-3);
    const controls = new Float32Array([0, 0, 0, 1, 1, 0, 2, 0, 0, 3, 1, 0]);
    const spline = drawnCurve('spline', controls, 0.05);
    const out = through;
    for (let i = 0; i < 4; i++) {
      const [x, y, z] = controls.subarray(i * 3, i * 3 + 3);
      closestOnCurve(spline, x, y, z, out);
      expect(Math.hypot(out[0] - x, out[1] - y, out[2] - z)).toBeLessThan(1e-3);
    }
    expect(largestGap(spline)).toBeLessThanOrEqual(0.05 * (1 + 1e-4));
  });

  it('fits collinear samples given as an arc with their line', () => {
    for (const noise of [0, 0.02]) {
      const c = fitCurve('arc', noisyLine([0, 0, 0], [6, 0, 0], noise), 3, 0.05);
      expect(maxDistance(c.points, (_x, y, z) => Math.hypot(y, z))).toBeLessThan(0.01);
      expect(Math.abs(c.lengths[c.lengths.length - 1] - 6)).toBeLessThan(0.05);
    }
  });

  it('keeps a 350 degree arc open and a closed circle closed through joining', () => {
    const sweep = (350 * Math.PI) / 180;
    const open = fitCurve('arc', noisyArc(5, 0, sweep, 0.02), 3, 0.05);
    expect(open.closed).toBe(false);
    expect(Math.abs(totalLength(open) / (5 * sweep) - 1)).toBeLessThan(0.01);
    const circle = fitCurve('arc', noisyArc(5, 0, Math.PI * 2, 0.02), 3, 0.05);
    expect(circle.closed).toBe(true);
    const joined = joinCurves([circle], ['arc'], [], true, 0.05);
    expect(joined.closed).toBe(true);
    expect(joined.points.length / 3).toBeGreaterThan(3);
    expect(Math.abs(totalLength(joined) / totalLength(circle) - 1)).toBeLessThan(0.01);
  });

  it('keeps sparse splines on their samples', () => {
    const sparse = new Float32Array([0, 0, 0, 0.1, 0.06, 0, 0.25, 0, 0, 2, 0.03, 0]);
    const c = fitCurve('spline', sparse, 4, 0.05);
    expect(c.lengths[c.lengths.length - 1]).toBeLessThan(2.2);
    for (let i = 1; i < c.points.length; i += 3) {
      expect(c.points[i]).toBeGreaterThanOrEqual(-0.06);
      expect(c.points[i]).toBeLessThanOrEqual(0.12);
    }
    const out = new Float32Array(3);
    for (const samples of [
      new Float32Array([0, 0, 0, 1, 0.05, 0, 2, 0, 0]),
      new Float32Array([0, 0, 0, 2, 0.5, 0]),
    ]) {
      const fitted = fitCurve('spline', samples, 4, 0.05);
      for (let i = 0; i < samples.length; i += 3) {
        const [x, y, z] = samples.subarray(i, i + 3);
        closestOnCurve(fitted, x, y, z, out);
        expect(Math.hypot(out[0] - x, out[1] - y, out[2] - z)).toBeLessThan(1e-4);
      }
    }
  });

  it('joins lines at a shallow intersection far beyond their ends', () => {
    const lines = [
      fitCurve('line', noisyLine([0, 0, 0], [1, 0, 0], 0), 2, 0.05),
      fitCurve('line', noisyLine([8, 0.2, 0], [9, 0.3, 0], 0), 2, 0.05),
    ];
    const joined = joinCurves(lines, ['line', 'line'], ['sharp'], false, 0.05);
    const [joint] = cornersOf(joined);
    expect(Math.hypot(joint[0] - 6, joint[1], joint[2])).toBeLessThan(0.01);
  });

  it('joins a spline to a line touching it far along', () => {
    // Crests 2 pi apart, lower the farther they are from x = 42.04, so only that one touches.
    const samples: number[] = [];
    for (let i = 0; i <= 1000; i++) {
      const x = i * 0.05;
      samples.push(x, (1 - 0.0005 * Math.abs(x - 42.04)) * Math.cos(x - 42.04), 0);
    }
    const spline = fitCurve('spline', new Float32Array(samples), 60, 0.05);
    const p = spline.points;
    let top = 0;
    for (let i = 0; i < p.length / 3; i++)
      if (Math.abs(p[i * 3] - 42.04) < 0.5 && p[i * 3 + 1] > p[top * 3 + 1]) top = i;
    const contact = p.subarray(top * 3, top * 3 + 3);
    const [cx, cy, cz] = contact;
    const line = fitCurve('line', noisyLine([cx, cy, cz], [cx + 10, cy, cz], 0), 2, 0.05);
    const joined = joinCurves([spline, line], ['spline', 'line'], ['sharp'], false, 0.05);
    const [joint] = cornersOf(joined);
    expect(Math.hypot(joint[0] - cx, joint[1] - cy, joint[2] - cz)).toBeLessThan(0.01);
  });

  it('notices a curve reversed in place after a lookup', () => {
    const c = fitCurve('line', noisyLine([0, 0, 0], [50, 0, 0], 0), 2, 0.05);
    const out = new Float32Array(3);
    closestOnCurve(c, 0, 0.01, 0, out);
    const count = c.points.length / 3;
    for (let i = 0; i < count / 2; i++)
      for (let axis = 0; axis < 3; axis++) {
        const [a, b] = [i * 3 + axis, (count - 1 - i) * 3 + axis];
        [c.points[a], c.points[b]] = [c.points[b], c.points[a]];
      }
    for (const end of [0, count - 1]) {
      const [x, y, z] = c.points.subarray(end * 3, end * 3 + 3);
      closestOnCurve(c, x, y + 0.01, z, out);
      expect(Math.hypot(out[0] - x, out[1] - y, out[2] - z)).toBeLessThan(1e-4);
    }
  });

  it('keeps degenerate controls and one-point curves', () => {
    const repeated = new Float32Array([0, 0, 0, 0, 0, 0, 4, 0, 0]);
    for (const c of [drawnCurve('arc', repeated, 0.05), fitCurve('arc', repeated, 3, 0.05)]) {
      expect(c.points.length).toBeGreaterThan(0);
      expect(c.points.every(Number.isFinite)).toBe(true);
      expect(c.lengths[c.lengths.length - 1]).toBeCloseTo(4, 4);
    }
    const single = fitCurve('line', new Float32Array([1, 2, 3]), 2, 0.05);
    const joined = joinCurves([single], ['line'], [], false, 0.05);
    expect(Array.from(joined.points)).toEqual([1, 2, 3]);
  });

  it('keeps points within step far from the origin', () => {
    const c = fitCurve('line', noisyLine([300, 0, 0], [305, 0, 0], 0), 2, 0.05);
    expect(largestGap(c)).toBeLessThanOrEqual(0.05 * (1 + 1e-9));
  });

  it('keeps an arc open when its largest gap beats three times the median gap', () => {
    const samples = new Float64Array(
      [0, 20, 50, 130].flatMap((degrees) => {
        const angle = (degrees * Math.PI) / 180;
        return [5 * Math.cos(angle), 0, 5 * Math.sin(angle)];
      }),
    );
    const arc = fitCurve('arc', samples, 3, 0.05);
    expect(arc.closed).toBe(false);
    const expected = (5 * 130 * Math.PI) / 180;
    expect(Math.abs(totalLength(arc) / expected - 1)).toBeLessThan(0.02);
  });

  it('joins lines at shallow angles where they intersect', () => {
    for (const degrees of [5, 2, 1]) {
      const slope = Math.tan((degrees * Math.PI) / 180);
      const lines = [
        fitCurve('line', noisyLine([0, 0, 0], [1, 0, 0], 0), 2, 0.05),
        fitCurve('line', noisyLine([8, 2 * slope, 0], [9, 3 * slope, 0], 0), 2, 0.05),
      ];
      const joined = joinCurves(lines, ['line', 'line'], ['sharp'], false, 0.05);
      const [joint] = cornersOf(joined);
      expect(Math.hypot(joint[0] - 6, joint[1], joint[2])).toBeLessThan(0.01);
    }
  });

  it('joins a line and a circle at the intersection nearer the nominal joint', () => {
    const radians = (degrees: number) => (degrees * Math.PI) / 180;
    const cases: [number, number, number, [number, number, number]][] = [
      [-8, 150, 250, [-4, 0, 3]],
      [2, 30, -60, [4, 0, 3]],
    ];
    for (const [end, from, to, expected] of cases) {
      const line = fitCurve('line', Float64Array.of(-10, 0, 3, end, 0, 3), 2, 0.05);
      const arc = fitCurve('arc', arcSamples(5, radians(from), radians(to)), 3, 0.05);
      const joined = joinCurves([line, arc], ['line', 'arc'], ['sharp'], false, 0.05);
      const [joint] = cornersOf(joined);
      expect(
        Math.hypot(joint[0] - expected[0], joint[1] - expected[1], joint[2] - expected[2]),
      ).toBeLessThan(1e-6);
    }
  });

  it('prefers a true intersection to a small gap nearer the nominal joint', () => {
    const line = fitCurve('line', Float64Array.of(-3, 0, 0, 1.5, 0, 0), 2, 0.05);
    // Comes within 5e-8 of the line at x = 1.02, then crosses it at x = 0.98.
    const spline = curveThrough([
      1.1, 0.05, 0, 1.02, 5e-8, 0, 1, 0.02, 0, 0.96, -0.02, 0, 0.5, -1, 0,
    ]);
    const joined = joinCurves([line, spline], ['line', 'spline'], ['sharp'], false, 0.05);
    const [joint] = cornersOf(joined);
    expect(Math.hypot(joint[0] - 0.98, joint[1], joint[2])).toBeLessThan(1e-6);
  });

  it('bridges parallel lines without moving them', () => {
    const first = fitCurve('line', noisyLine([0, 0, 0], [4, 0, 0], 0), 2, 0.05);
    const second = fitCurve('line', noisyLine([5, 1, 0], [9, 1, 0], 0), 2, 0.05);
    const joined = joinCurves([first, second], ['line', 'line'], ['sharp'], false, 0.05);
    const ends = (c: EdgeCurve) => [
      c.points.subarray(0, 3),
      c.points.subarray(c.points.length - 3),
    ];
    const [a0, a1] = ends(first);
    const [b0, b1] = ends(second);
    const [joint] = cornersOf(joined);
    const middle = [4.5, 0.5, 0];
    expect(
      Math.hypot(joint[0] - middle[0], joint[1] - middle[1], joint[2] - middle[2]),
    ).toBeLessThan(1e-9);
    // Along the first line, then the bridge between the lines, then along the second line.
    const bridge = [
      [4.5, 0, 0],
      [4.5, 1, 0],
    ];
    let stage = 0;
    const p = joined.points;
    expect(Array.from(p.subarray(0, 3))).toEqual(Array.from(a0));
    expect(Array.from(p.subarray(p.length - 3))).toEqual(Array.from(b1));
    for (let i = 0; i < p.length / 3; i++) {
      const point = p.subarray(i * 3, i * 3 + 3);
      if (stage === 0 && lineDistance(point, a0, a1) >= 1e-9) stage = 1;
      if (stage === 1 && segmentDistance(point, bridge[0], bridge[1]) >= 1e-9) stage = 2;
      if (stage === 2) expect(lineDistance(point, b0, b1)).toBeLessThan(1e-9);
    }
    expect(largestGap(joined)).toBeLessThanOrEqual(0.05 * (1 + 1e-9));
  });

  it('joins a single point into one point when closed', () => {
    const single = fitCurve('line', Float64Array.of(1, 2, 3), 2, 0.05);
    const joined = joinCurves([single], ['line'], ['sharp'], true, 0.05);
    expect(Array.from(joined.points)).toEqual([1, 2, 3]);
  });

  it('keeps gaps within a fine step far from the origin', () => {
    const step = 2 ** -14;
    const c = fitCurve('line', noisyLine([300, 0, 0], [305, 0, 0], 0), 2, step);
    expect(largestGap(c)).toBeLessThanOrEqual(step * (1 + 1e-9));
  });

  it('resamples a very long line and refuses one too long for its step', () => {
    const long = fitCurve('line', Float64Array.of(0, 0, 0, 1048576, 0, 0), 2, 0.25);
    expect(long.points.length / 3).toBe(4194305);
    expect(() => fitCurve('line', Float64Array.of(0, 0, 0, 2000000, 0, 0), 2, 0.25)).toThrow(
      new RangeError('This guide is too long for its step.'),
    );
  }, 10000);
});
