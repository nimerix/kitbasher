import { describe, expect, it } from 'vitest';
import type { GuidePoint } from '../../src/core/refine-band';
import type { GuideKind } from '../../src/core/refine-curve';
import {
  type GuideConstraint,
  type GuideShape,
  constraintRefusal,
  solveGuide,
} from '../../src/core/refine-constraints';
import { planeOf } from '../../src/core/refine-sketch';
import type { Vec3 } from '../../src/core/types';

/** A plane tilted off the axes, so (u, v) are not world coordinates. */
const plane = planeOf('p', 'Plane 1', [0.3, -0.2, 0.5], [0.2, 0.3, 1], [1, 0.1, 0])!;
const at = (u: number, v: number): GuidePoint => ({
  triangle: 0,
  position: [0, 1, 2].map((a) => plane.origin[a] + u * plane.u[a] + v * plane.v[a]) as Vec3,
});
const uv = (p: Vec3) => {
  const d = [0, 1, 2].map((a) => p[a] - plane.origin[a]);
  return [0, 1, 2].reduce((s, a) => s + d[a] * plane.u[a], 0) === undefined
    ? [0, 0]
    : [
        [0, 1, 2].reduce((s, a) => s + d[a] * plane.u[a], 0),
        [0, 1, 2].reduce((s, a) => s + d[a] * plane.v[a], 0),
      ];
};

/** A guide through `points` (shared by value), one segment per entry of `kinds`. */
function shape(
  kinds: GuideKind[],
  points: GuidePoint[],
  constraints: GuideConstraint[],
): GuideShape {
  let k = 0;
  const segments = kinds.map((kind) => {
    const count = kind === 'arc' ? 3 : 2;
    const segment = { kind, points: points.slice(k, k + count) };
    k += count - 1;
    return segment;
  });
  return { segments, plane, constraints };
}
const solvedUV = (s: GuideShape, request = {}) => solveGuide(s, request)?.map(uv) ?? null;
const angleOf = (a: number[], b: number[]) => Math.atan2(b[1] - a[1], b[0] - a[0]);
const circle = (a: number[], b: number[], c: number[]) => {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const sq = (p: number[]) => p[0] ** 2 + p[1] ** 2;
  const x = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
  const y = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
  return { centre: [x, y], radius: Math.hypot(a[0] - x, a[1] - y) };
};
const near = (x: number, y = 0) => expect(Math.abs(x - y)).toBeLessThan(1e-6);

describe('each constraint alone', () => {
  // Three points: two lines meeting at the middle one.
  const twoLines = [at(0, 0), at(2, 0.3), at(2.2, 2)];

  it('horizontal and vertical', () => {
    const h = solvedUV(
      shape(['line'], [at(0, 0), at(2, 0.3)], [{ id: 'h', kind: 'horizontal', segments: [0] }]),
    )!;
    near(h[0][1], h[1][1]);
    const v = solvedUV(
      shape(['line'], [at(0, 0), at(0.3, 2)], [{ id: 'v', kind: 'vertical', segments: [0] }]),
    )!;
    near(v[0][0], v[1][0]);
  });

  it('parallel and perpendicular', () => {
    const four = [at(0, 0), at(2, 0.3), at(2.2, 2), at(0.1, 2.4)];
    const p = solvedUV(
      shape(['line', 'line', 'line'], four, [{ id: 'p', kind: 'parallel', segments: [0, 2] }]),
    )!;
    near(Math.sin(angleOf(p[0], p[1]) - angleOf(p[2], p[3])));
    const q = solvedUV(
      shape(['line', 'line'], twoLines, [{ id: 'q', kind: 'perpendicular', segments: [0, 1] }]),
    )!;
    near(Math.cos(angleOf(q[0], q[1]) - angleOf(q[1], q[2])));
  });

  it('collinear', () => {
    const c = solvedUV(
      shape(
        ['line', 'line'],
        [at(0, 0), at(1, 0.1), at(2, 0.4)],
        [{ id: 'c', kind: 'collinear', segments: [0, 1] }],
      ),
    )!;
    const cross = (a: number[], b: number[], q: number[]) =>
      (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
    near(cross(c[0], c[1], c[2]));
  });

  it('equal lines and equal arcs', () => {
    const e = solvedUV(
      shape(['line', 'line'], twoLines, [{ id: 'e', kind: 'equal', segments: [0, 1] }]),
    )!;
    near(
      Math.hypot(e[1][0] - e[0][0], e[1][1] - e[0][1]),
      Math.hypot(e[2][0] - e[1][0], e[2][1] - e[1][1]),
    );
    const arcs = [at(0, 0), at(1, 1), at(2, 0), at(3.5, -1.5), at(5, 0)];
    const r = solvedUV(
      shape(['arc', 'arc'], arcs, [{ id: 'r', kind: 'equal', segments: [0, 1] }]),
    )!;
    near(circle(r[0], r[1], r[2]).radius, circle(r[2], r[3], r[4]).radius);
  });

  it('concentric', () => {
    const arcs = [at(0, 0), at(1, 1), at(2, 0), at(1.5, -0.6), at(0.4, -0.4)];
    const c = solvedUV(
      shape(['arc', 'arc'], arcs, [{ id: 'c', kind: 'concentric', segments: [0, 1] }]),
    )!;
    const [a, b] = [circle(c[0], c[1], c[2]), circle(c[2], c[3], c[4])];
    near(a.centre[0], b.centre[0]);
    near(a.centre[1], b.centre[1]);
  });

  it('tangent, a line and an arc', () => {
    const t = solvedUV(
      shape(
        ['line', 'arc'],
        [at(-2, 0.3), at(0, 0), at(1, 1), at(2, 0)],
        [{ id: 't', kind: 'tangent', segments: [0, 1] }],
      ),
    )!;
    const { centre } = circle(t[1], t[2], t[3]);
    const d = [t[1][0] - t[0][0], t[1][1] - t[0][1]];
    near((d[0] * (t[1][0] - centre[0]) + d[1] * (t[1][1] - centre[1])) / Math.hypot(...d));
  });

  it('align a point level with another', () => {
    const s = shape(['line', 'line'], twoLines, [
      {
        id: 'a',
        kind: 'align',
        axis: 'horizontal',
        points: [
          { segment: 1, index: 1 },
          { segment: 0, index: 0 },
        ],
      },
    ]);
    const a = solvedUV(s, { heavy: [twoLines[0]] })!;
    near(a[2][1], a[0][1]);
    // The heavy point moves a ten-thousandth as much.
    expect(Math.abs(a[0][1])).toBeLessThan(1e-3);
  });

  it('holds a fixed point and a point on its line', () => {
    const fixed = { ...at(0, 0), lock: { kind: 'fixed' as const } };
    const lined = {
      ...at(2, 0.3),
      lock: { kind: 'line' as const, origin: at(2, 0.3).position, direction: plane.v },
    };
    const s = shape(['line'], [fixed, lined], [{ id: 'h', kind: 'horizontal', segments: [0] }]);
    const p = solvedUV(s)!;
    near(p[0][0]);
    near(p[0][1]);
    near(p[1][0], 2);
    near(p[1][1], 0);
  });
});

describe('a slot under a drag', () => {
  // Two lines and two arcs: lines parallel, arcs tangent to them and of equal radius.
  const points = [
    at(-1.5, -1),
    at(1.5, -1.1),
    at(2.5, 0.1),
    at(1.4, 1),
    at(-1.6, 1.05),
    at(-2.4, 0),
  ];
  const segments = [
    { kind: 'line' as const, points: [points[0], points[1]] },
    { kind: 'arc' as const, points: [points[1], points[2], points[3]] },
    { kind: 'line' as const, points: [points[3], points[4]] },
    { kind: 'arc' as const, points: [points[4], points[5], points[0]] },
  ];
  const constraints: GuideConstraint[] = [
    { id: '1', kind: 'parallel', segments: [0, 2] },
    { id: '2', kind: 'tangent', segments: [0, 1] },
    { id: '3', kind: 'tangent', segments: [1, 2] },
    { id: '4', kind: 'tangent', segments: [2, 3] },
    { id: '5', kind: 'tangent', segments: [3, 0] },
    { id: '6', kind: 'equal', segments: [1, 3] },
  ];
  const slot: GuideShape = { segments, plane, constraints };

  it('keeps every constraint as a point moves, the point following', () => {
    const target = at(2.8, 0.3).position;
    const solved = solveGuide(slot, { moved: { point: points[2], target } })!;
    expect(solved).not.toBeNull();
    const p = solved.map(uv);
    const arcA = circle(p[1], p[2], p[3]),
      arcB = circle(p[4], p[5], p[0]);
    near(arcA.radius, arcB.radius);
    near(Math.sin(angleOf(p[0], p[1]) - angleOf(p[3], p[4])));
    const tangent = (a: number[], b: number[], c: number[]) => {
      const d = [b[0] - a[0], b[1] - a[1]];
      return (d[0] * (b[0] - c[0]) + d[1] * (b[1] - c[1])) / Math.hypot(...d);
    };
    near(tangent(p[0], p[1], arcA.centre));
    near(tangent(p[3], p[4], arcB.centre));
    // The moved point stays close to where it was asked to go.
    const moved = uv(target);
    expect(Math.hypot(p[2][0] - moved[0], p[2][1] - moved[1])).toBeLessThan(0.05);
  });
});

describe('a conflicting constraint', () => {
  it('is refused by the solve, nothing moved', () => {
    const a = { ...at(0, 0), lock: { kind: 'fixed' as const } },
      b = { ...at(2, 0.5), lock: { kind: 'fixed' as const } };
    const s = shape(['line'], [a, b], [{ id: 'h', kind: 'horizontal', segments: [0] }]);
    expect(solveGuide(s)).toBeNull();
  });

  it('is refused off a plane and between segments it does not fit', () => {
    const s = shape(['line', 'arc'], [at(0, 0), at(1, 0), at(2, 1), at(1, 2)], []);
    expect(
      constraintRefusal({ ...s, plane: null }, { id: 'x', kind: 'horizontal', segments: [0] }),
    ).toMatch(/plane/);
    expect(constraintRefusal(s, { id: 'x', kind: 'parallel', segments: [0, 1] })).not.toBeNull();
    expect(constraintRefusal(s, { id: 'x', kind: 'tangent', segments: [0, 1] })).toBeNull();
  });
});
