import { describe, expect, it } from 'vitest';
import type { GuidePoint } from '../../src/core/refine-band';
import { type GuideJoint, closestOnCurve } from '../../src/core/refine-curve';
import {
  type EdgeInput,
  type EdgeSegment,
  applyEdge,
  correctedFlanks,
  moveWeights,
  solveEdge,
} from '../../src/core/refine-edge';
import { type RefineMesh, cloneRefineMesh } from '../../src/core/refine-mesh';
import type { Vec3 } from '../../src/core/types';
import {
  chainPieces,
  closedMesh,
  loops,
  meshMinTriangleArea,
  modelFrom,
  modelOf,
  nearestChainDistance,
  pointOn,
  topCrestCorners,
} from '../helpers/refine';
import { softBox, softCylinder, softPrism, softSlot } from '../helpers/soft-edges';

/** How far a 0.3 mm fillet's crest sits in from each face. */
const crest = 0.3 - 0.3 / Math.SQRT2;
const boxCorners: Vec3[] = [
  [2, 1.5, 1],
  [2, 1.5, -1],
  [-2, 1.5, 1],
  [-2, 1.5, -1],
];

const pathOf = (
  segments: EdgeSegment[],
  joints: GuideJoint[],
  closed: boolean,
  width: number | null = 0.6,
): EdgeInput => ({ segments, joints, closed, width, strength: 1 });
const line = (from: GuidePoint, to: GuidePoint): EdgeSegment => ({
  kind: 'line',
  points: [from, to],
});

// The four edges around the top face (y = 1.5) of softBox([2, 1.5, 1], 0.3), drawn on their crests.
const perimeter = (mesh: RefineMesh): EdgeInput =>
  pathOf(
    topCrestCorners(mesh).map((from, i, all) => line(from, all[(i + 1) % 4])),
    ['sharp', 'sharp', 'sharp', 'sharp'],
    true,
  );
/** The same path drawn the other way: segments in reverse order, each reversed. */
const reversed = (input: EdgeInput): EdgeInput => {
  const n = input.segments.length;
  const segments = [...input.segments]
    .reverse()
    .map((s) => ({ kind: s.kind, points: [...s.points].reverse() }));
  // Joint k of the reversed path lies between its segments k and k + 1.
  const joints = input.closed
    ? input.joints.map((_, k) => input.joints[(2 * n - 2 - k) % n])
    : [...input.joints].reverse();
  return { ...input, segments, joints };
};

const boxModel = () => modelOf(softBox([2, 1.5, 1], 0.3));
const appliedPerimeter = () => {
  const model = boxModel();
  const solve = solveEdge(model.mesh, model.topology, perimeter(model.mesh), model.noise)!;
  const out = cloneRefineMesh(model.mesh, true);
  const result = applyEdge(out, model.topology, solve, 1, true);
  return { model, solve, out, result };
};
const moveOf = (before: RefineMesh, after: RefineMesh, v: number) =>
  Math.hypot(...[0, 1, 2].map((a) => after.position[v * 3 + a] - before.position[v * 3 + a]));

describe('solveEdge and applyEdge on a path', () => {
  it('closes a four-segment path with four corners and no gap', () => {
    const { solve, out, result } = appliedPerimeter();
    expect(solve.bands.length).toBe(4);
    expect(solve.ends).toEqual(['hold', 'hold']);
    const chain = result.cut!.chain;
    expect(loops(out, chain)).toEqual([chain.length]);
    for (const corner of boxCorners)
      expect(nearestChainDistance(out, chain, corner)).toBeLessThan(0.02);
    expect(closedMesh(out)).toBe(true);
  });

  it.each([1, 2, 4, 5, 7, 8])(
    'closes the four-segment path on the box made with seed %i, nothing straddling or folded',
    (seed) => {
      const model = modelOf(softBox([2, 1.5, 1], 0.3, { seed }));
      const solve = solveEdge(model.mesh, model.topology, perimeter(model.mesh), model.noise)!;
      const out = cloneRefineMesh(model.mesh, true);
      const result = applyEdge(out, model.topology, solve, 1, true);
      const chain = result.cut!.chain;
      expect(result.pieces).toBe(1);
      expect(loops(out, chain)).toEqual([chain.length]);
      for (const corner of boxCorners)
        expect(nearestChainDistance(out, chain, corner)).toBeLessThan(0.02);
      expect(result.skipped).toHaveLength(0);
      expect(result.folded).toHaveLength(0);
      expect(closedMesh(out)).toBe(true);
    },
  );

  it('treats the face inside the path as one flat surface', () => {
    const { model, solve, out } = appliedPerimeter();
    const weights = moveWeights(model.mesh, model.topology, solve);
    const surfaces = correctedFlanks(model.mesh, model.topology, solve);
    const full = new Set<number>();
    let offset = 0;
    for (const band of solve.bands) {
      band.vertices.forEach((v, i) => weights[offset + i] === 1 && full.add(v));
      offset += band.vertices.length;
    }
    let checked = 0;
    for (const v of full) {
      const [x, y, z] = [0, 1, 2].map((a) => out.position[v * 3 + a]);
      if (!(y > 1.4) || Math.abs(x) > 2 - 0.02 || Math.abs(z) > 1 - 0.02) continue;
      // The face inside: vertices that started nearer its corrected surface than the outer faces'.
      const [sx, sy, sz] = [0, 1, 2].map((a) => model.mesh.position[v * 3 + a]);
      if (surfaces[0](sx, sy, sz) > surfaces[1](sx, sy, sz)) continue;
      checked++;
      expect(Math.abs(y - 1.5)).toBeLessThan(0.005);
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('leaves the edges between the outer faces soft', () => {
    const { model, solve, out } = appliedPerimeter();
    const soft = Math.max(...solve.bands.map((band) => band.soft));
    let checked = 0;
    for (let v = 0; v < model.mesh.weldedCount; v++) {
      const [x, y, z] = [0, 1, 2].map((a) => model.mesh.position[v * 3 + a]);
      // On the rounding of an upright edge, more than `soft` below the top.
      if (Math.abs(x) < 2 - 0.3 || Math.abs(z) < 1 - 0.3 || y > 1.5 - soft || y < 0.5) continue;
      checked++;
      expect(moveOf(model.mesh, out, v)).toBe(0);
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('runs a third guide into an existing corner without fading', () => {
    const { model, out } = appliedPerimeter();
    const after = modelFrom(out);
    // Drawn up the upright edge's crest to where it meets the top's corner.
    const input = pathOf(
      [
        line(
          pointOn(out, [2 - crest, -0.5, 1 - crest]),
          pointOn(out, [2 - crest, 1.5 - crest, 1 - crest]),
        ),
      ],
      [],
      false,
    );
    const solve = solveEdge(after.mesh, after.topology, input, model.noise)!;
    expect(solve).not.toBeNull();
    expect(solve.ends[1]).toBe('hold');
    const again = cloneRefineMesh(after.mesh, true);
    const { cut } = applyEdge(again, after.topology, solve, 1, true);
    expect(nearestChainDistance(again, cut!.chain, [2, 1.5, 1])).toBeLessThan(0.02);
    expect(closedMesh(again)).toBe(true);
  });

  it('joins a line to an arc smoothly', () => {
    const model = modelOf(softSlot(0.3));
    const [r, y] = [1 - crest, 1 - crest];
    const at = (x: number, z: number) => pointOn(model.mesh, [x, y, z]);
    const corner = at(1.5, r);
    const input = pathOf(
      [
        line(at(-1, r), corner),
        {
          kind: 'arc',
          points: [corner, at(1.5 + r / Math.SQRT2, r / Math.SQRT2), at(2.5 - crest, 0)],
        },
      ],
      ['smooth'],
      false,
    );
    const solve = solveEdge(model.mesh, model.topology, input, model.noise)!;
    expect(solve).not.toBeNull();
    expect([...solve.curve.corner].every((c) => c === 0)).toBe(true);
    const out = cloneRefineMesh(model.mesh, true);
    const { cut } = applyEdge(out, model.topology, solve, 1, true);
    expect(chainPieces(out, cut!.chain)).toEqual([{ size: cut!.chain.length, ends: 2 }]);
    expect(closedMesh(out)).toBe(true);
  });

  it('holds an open path at its corner joint and decides each free end for itself', () => {
    const model = boxModel();
    const [front, right] = topCrestCorners(model.mesh);
    const input = pathOf(
      [line(pointOn(model.mesh, [-1, 1.5 - crest, 1 - crest]), front), line(front, right)],
      ['sharp'],
      false,
    );
    const solve = solveEdge(model.mesh, model.topology, input, model.noise)!;
    expect(solve.ends).toEqual(['taper', 'hold']);
    expect([...solve.curve.corner].filter((c) => c === 1).length).toBe(1);
    const out = cloneRefineMesh(model.mesh, true);
    const { cut } = applyEdge(out, model.topology, solve, 1, true);
    expect(nearestChainDistance(out, cut!.chain, [2, 1.5, 1])).toBeLessThan(0.02);
    expect(chainPieces(out, cut!.chain)).toEqual([{ size: cut!.chain.length, ends: 2 }]);
  });

  it('moves the same vertices to the same places whichever way a path is drawn', () => {
    const model = boxModel();
    const [front, right] = topCrestCorners(model.mesh);
    const open = pathOf(
      [line(pointOn(model.mesh, [-1, 1.5 - crest, 1 - crest]), front), line(front, right)],
      ['sharp'],
      false,
    );
    for (const input of [open, perimeter(model.mesh)]) {
      const forward = solveEdge(model.mesh, model.topology, input, model.noise)!;
      const backward = solveEdge(model.mesh, model.topology, reversed(input), model.noise)!;
      expect(backward.ends).toEqual([...forward.ends].reverse());
      const [a, b] = [forward, backward].map((solve) => {
        const out = cloneRefineMesh(model.mesh, false);
        applyEdge(out, model.topology, solve, 1, false);
        return out;
      });
      let largest = 0;
      for (let v = 0; v < model.mesh.weldedCount; v++) largest = Math.max(largest, moveOf(a, b, v));
      expect(largest).toBeLessThan(1e-9);
    }
  });

  it('closes one arc into a full circle on a cylinder rim', () => {
    const model = modelOf(softCylinder(1.5, 1, 0.3));
    const r = 1.2 + 0.3 / Math.SQRT2,
      y = 0.7 + 0.3 / Math.SQRT2;
    const points = [0, 1, 2].map((k) => {
      const angle = (k * 2 * Math.PI) / 3;
      return pointOn(model.mesh, [r * Math.cos(angle), y, r * Math.sin(angle)]);
    });
    const input = pathOf([{ kind: 'arc', points }], ['smooth'], true);
    const solve = solveEdge(model.mesh, model.topology, input, model.noise)!;
    expect(solve).not.toBeNull();
    expect(solve.curve.closed).toBe(true);
    expect(solve.ends).toEqual(['hold', 'hold']);
    // A closed path has no ends to set.
    const set = solveEdge(
      model.mesh,
      model.topology,
      { ...input, ends: ['taper', 'taper'] },
      model.noise,
    )!;
    expect(set.ends).toEqual(['hold', 'hold']);
    const out = cloneRefineMesh(model.mesh, true);
    const { cut } = applyEdge(out, model.topology, solve, 1, true);
    const chain = cut!.chain;
    expect(loops(out, chain)).toEqual([chain.length]);
    for (const v of chain) {
      const radius = Math.hypot(out.position[v * 3], out.position[v * 3 + 2]);
      expect(Math.hypot(radius - 1.5, out.position[v * 3 + 1] - 1)).toBeLessThan(0.02);
    }
    expect(closedMesh(out)).toBe(true);
  });

  it('starts each segment of a closed rim of arcs at the joint the guide sets', () => {
    // Three arcs round the cylinder's rim, unequal, meeting at smooth joints.
    const model = modelOf(softCylinder(1.5, 1, 0.3));
    const r = 1.2 + 0.3 / Math.SQRT2,
      y = 0.7 + 0.3 / Math.SQRT2;
    const at = (degrees: number) => {
      const a = (degrees * Math.PI) / 180;
      return pointOn(model.mesh, [r * Math.cos(a), y, r * Math.sin(a)]);
    };
    const stops = [0, 70, 150, 360];
    const segments: EdgeSegment[] = [0, 1, 2].map((k) => ({
      kind: 'arc',
      points: [at(stops[k]), at((stops[k] + stops[k + 1]) / 2), at(stops[k + 1] % 360)],
    }));
    const solve = solveEdge(
      model.mesh,
      model.topology,
      pathOf(segments, ['smooth', 'smooth', 'smooth'], true),
      model.noise,
    )!;
    const total = solve.bounds[3] - solve.bounds[0];
    const on = new Float64Array(3);
    segments.forEach((segment, k) => {
      const [x, y, z] = segment.points[0].position;
      const station = closestOnCurve(solve.curve, x, y, z, on);
      const apart = Math.abs(station - solve.bounds[k]);
      expect(Math.min(apart, total - apart)).toBeLessThan(0.05);
    });
    const out = cloneRefineMesh(model.mesh, true);
    const result = applyEdge(out, model.topology, solve, 1, true);
    expect([result.pieces, result.skipped.length, result.folded.length]).toEqual([1, 0, 0]);
  });

  it('cuts one chain where two segments meet at a shallow joint', () => {
    // A top rim that turns by 19.8 degrees at (0, 1, 1.35).
    const model = modelOf(
      softPrism(
        [
          [-2, -1],
          [2, -1],
          [2, 1],
          [0, 1.35],
          [-2, 1],
        ],
        0.6,
        0.3,
      ),
    );
    const turn = Math.atan2(0.35, 2);
    // A point on the crest above the wall z = 1.35 - 0.175 |x|, inset by the crest along the wall's normal.
    const onCrest = (x: number) => {
      const side = Math.sign(x) || 1;
      const inward = [side * Math.sin(turn), -Math.cos(turn)];
      const z = 1.35 - 0.175 * Math.abs(x);
      return pointOn(model.mesh, [x + crest * inward[0], 1 - crest, z + crest * inward[1]]);
    };
    const joint = pointOn(model.mesh, [0, 1 - crest, 1.35 - crest / Math.cos(turn)]);
    const input = pathOf([line(onCrest(-1.5), joint), line(joint, onCrest(1.5))], ['sharp'], false);
    const solve = solveEdge(model.mesh, model.topology, input, model.noise)!;
    expect(solve).not.toBeNull();
    const [first, second] = solve.bands.map((band) => new Set(band.vertices));
    expect([...first].filter((v) => second.has(v)).length).toBeGreaterThan(20);
    const out = cloneRefineMesh(model.mesh, true);
    const { cut } = applyEdge(out, model.topology, solve, 1, true);
    expect(chainPieces(out, cut!.chain)).toEqual([{ size: cut!.chain.length, ends: 2 }]);
    expect(meshMinTriangleArea(out)).toBeGreaterThan(1e-12);
    expect(closedMesh(out)).toBe(true);
  });
});
