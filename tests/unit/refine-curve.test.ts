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
});
