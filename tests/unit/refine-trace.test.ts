import { describe, expect, it } from 'vitest';
import type { GuidePoint } from '../../src/core/refine-band';
import { edgeUnderStroke, fitTrace } from '../../src/core/refine-trace';
import type { Vec3 } from '../../src/core/types';
import { modelOf, pointOn } from '../helpers/refine';
import { softBox } from '../helpers/soft-edges';

/** Seeded uniform numbers in [0, 1). */
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const fillet = 0.3;
/** The middle of the rounding of softBox([2, 1.5, 1], 0.3)'s top front edge, in (y, z). */
const rounding = [1.5 - fillet + fillet * Math.SQRT1_2, 1 - fillet + fillet * Math.SQRT1_2];

function pathOn(
  mesh: Parameters<typeof pointOn>[0],
  at: (x: number) => Vec3,
  from = -1.2,
  to = 1.2,
  spacing = 0.2,
): GuidePoint[] {
  const count = Math.round((to - from) / spacing);
  return Array.from({ length: count + 1 }, (_, i) => pointOn(mesh, at(from + i * spacing)));
}

describe('Refine trace: the edge beside a stroke', () => {
  const model = modelOf(softBox([2, 1.5, 1], fillet));
  const { mesh, topology } = model;
  const step = 0.06;

  for (const [where, at] of [
    ['on the top, 0.2 mm off the rounding', (x: number): Vec3 => [x, 1.5, 0.5]],
    ['on the wall, 0.2 mm below the rounding', (x: number): Vec3 => [x, 1.0, 1]],
    ['on the rounding', (x: number): Vec3 => [x, rounding[0], rounding[1]]],
  ] as const)
    it(`finds the middle of the rounding from a stroke ${where}`, () => {
      const path = pathOn(mesh, at);
      const found = edgeUnderStroke(mesh, topology, path, 0.6, step);
      const points = found.filter((p) => p !== null);
      expect(points.length).toBeGreaterThanOrEqual(path.length - 1);
      for (const { position: p, triangle } of points) {
        expect(Math.hypot(p[1] - rounding[0], p[2] - rounding[1])).toBeLessThan(0.03);
        expect(triangle).toBeGreaterThanOrEqual(0);
      }
    });

  it('finds no edge where the surface under the brush is flat', () => {
    const path = pathOn(mesh, (x) => [x, 1.5, -0.2]);
    const found = edgeUnderStroke(mesh, topology, path, 0.3, step);
    expect(found.every((p) => p === null)).toBe(true);
  });
});

describe('Refine trace: fitting the edge', () => {
  const noisy = (points: Vec3[], noise: number, seed = 5) => {
    const next = random(seed);
    return points.map((p) => p.map((v) => v + (2 * next() - 1) * noise) as Vec3);
  };
  const line = (from: Vec3, to: Vec3, spacing = 0.2) => {
    const count = Math.round(Math.hypot(...from.map((v, a) => to[a] - v)) / spacing);
    return Array.from(
      { length: count + 1 },
      (_, i) => from.map((v, a) => v + ((to[a] - v) * i) / count) as Vec3,
    );
  };
  const arc = (centre: Vec3, r: number, from: number, to: number, spacing = 0.2) => {
    const count = Math.max(2, Math.round((Math.abs(to - from) * r) / spacing));
    return Array.from({ length: count + 1 }, (_, i) => {
      const a = from + ((to - from) * i) / count;
      return [centre[0] + r * Math.cos(a), 0, centre[2] + r * Math.sin(a)] as Vec3;
    });
  };

  it('fits a straight edge as one line', () => {
    const traced = fitTrace(noisy(line([-3, 0, 0], [3, 0, 0]), 0.005), false, 0.01, 0.6)!;
    expect(traced.segments.map((s) => s.kind)).toEqual(['line']);
    const [a, b] = traced.segments[0].points;
    expect(Math.abs(a[0] + 3)).toBeLessThan(0.02);
    expect(Math.abs(b[0] - 3)).toBeLessThan(0.02);
    expect(traced.closed).toBe(false);
  });

  it('fits a slot end as a line, an arc and a line joined smoothly', () => {
    const points = [
      ...line([-2, 0, -1], [1.5, 0, -1]),
      ...arc([1.5, 0, 0], 1, -Math.PI / 2, Math.PI / 2).slice(1),
      ...line([1.5, 0, 1], [-2, 0, 1]).slice(1),
    ];
    const traced = fitTrace(noisy(points, 0.004), false, 0.01, 0.6)!;
    expect(traced.segments.map((s) => s.kind)).toEqual(['line', 'arc', 'line']);
    expect(traced.joints).toEqual(['smooth', 'smooth']);
    const [start, middle, end] = traced.segments[1].points;
    expect(Math.hypot(start[0] - 1.5, start[2] + 1)).toBeLessThan(0.15);
    expect(Math.hypot(middle[0] - 2.5, middle[2])).toBeLessThan(0.02);
    expect(Math.hypot(end[0] - 1.5, end[2] - 1)).toBeLessThan(0.15);
  });

  it('splits an L at its corner into two lines meeting there sharply', () => {
    // The corner rounded off over 0.3 mm, as a traced crest is.
    const points = [
      ...line([-3, 0, 0], [-0.3, 0, 0]),
      ...arc([-0.3, 0, 0.3], 0.3, -Math.PI / 2, 0, 0.1).slice(1),
      ...line([0, 0, 0.3], [0, 0, 3]).slice(1),
    ];
    const traced = fitTrace(noisy(points, 0.004), false, 0.01, 0.6)!;
    expect(traced.segments.map((s) => s.kind)).toEqual(['line', 'line']);
    expect(traced.joints).toEqual(['sharp']);
    const meet = traced.segments[0].points[1];
    expect(Math.hypot(meet[0], meet[2])).toBeLessThan(0.02);
    expect(traced.segments[1].points[0]).toEqual(meet);
  });

  it('fits a closed ring as one closed arc', () => {
    const ring = arc([0, 0, 0], 2, 0, 2 * Math.PI).slice(1);
    const traced = fitTrace(noisy(ring, 0.004), true, 0.01, 0.6)!;
    expect(traced).toMatchObject({ closed: true, joints: ['smooth'] });
    expect(traced.segments.map((s) => s.kind)).toEqual(['arc']);
  });

  it('fits a closed slot as two lines and two arcs', () => {
    const loop = [
      ...line([-1.5, 0, -1], [1.5, 0, -1]),
      ...arc([1.5, 0, 0], 1, -Math.PI / 2, Math.PI / 2).slice(1),
      ...line([1.5, 0, 1], [-1.5, 0, 1]).slice(1),
      ...arc([-1.5, 0, 0], 1, Math.PI / 2, (3 * Math.PI) / 2).slice(1, -1),
    ];
    // Starting part way along a line, as a stroke may.
    const start = loop.slice(5).concat(loop.slice(0, 5));
    const traced = fitTrace(noisy(start, 0.004), true, 0.01, 0.6)!;
    expect(traced.closed).toBe(true);
    expect(traced.segments.map((s) => s.kind).sort()).toEqual(['arc', 'arc', 'line', 'line']);
    expect(traced.joints).toEqual(['smooth', 'smooth', 'smooth', 'smooth']);
  });

  it('fits a wandering edge as one spline', () => {
    const points = Array.from({ length: 81 }, (_, i) => {
      const x = -4 + i * 0.1;
      return [x, 0, 0.4 * Math.sin(1.1 * x) + 0.15 * Math.sin(2.3 * x)] as Vec3;
    });
    const traced = fitTrace(points, false, 0.01, 0.6)!;
    expect(traced.segments.map((s) => s.kind)).toEqual(['spline']);
    expect(traced.segments[0].points.length).toBeGreaterThanOrEqual(4);
  });
});
