import { describe, expect, it } from 'vitest';
import type { GuidePoint } from '../../src/core/refine-band';
import { type EdgeCurve, closestOnCurve, drawnCurve } from '../../src/core/refine-curve';
import { type EdgeInput, type EdgeRefusal, applyEdge, solveEdge } from '../../src/core/refine-edge';
import { cloneRefineMesh } from '../../src/core/refine-mesh';
import { planeOf } from '../../src/core/refine-sketch';
import type { Vec3 } from '../../src/core/types';
import { chainPieces, edgeLoops, modelOf, pointOn } from '../helpers/refine';
import { extrudedProfile, slottedPlate } from '../helpers/soft-edges';

type Model = ReturnType<typeof modelOf>;
const scan = { step: 0.06, ripple: 0.01, noise: 0.006 };

/** A guide point at `p` itself, on the triangle nearest it, as a click on a sketch plane places it. */
const at = (model: Model, p: Vec3): GuidePoint => ({
  triangle: pointOn(model.mesh, p).triangle,
  position: p,
});

/** The guide solved and applied once at its strength, or why it was refused. */
function outcome(model: Model, input: EdgeInput) {
  const why = { reason: null as EdgeRefusal | null };
  const solve = solveEdge(model.mesh, model.topology, input, model.noise, why);
  if (!solve) return { solve: null, why: why.reason } as const;
  const out = cloneRefineMesh(model.mesh, true);
  const result = applyEdge(out, model.topology, solve, input.strength, true);
  return { solve, out, result, chain: result.cut?.chain ?? new Uint32Array(0) } as const;
}
type Solved = Extract<ReturnType<typeof outcome>, { out: unknown }>;

/** Largest distance from `curve` of the chain's vertices that `inside` admits. */
function chainFrom(r: Solved, curve: EdgeCurve, inside: (p: number[]) => boolean = () => true) {
  const near = new Float64Array(3);
  let worst = 0,
    seen = 0;
  for (const v of r.chain) {
    const p = [0, 1, 2].map((a) => r.out.position[v * 3 + a]);
    if (!inside(p)) continue;
    seen++;
    closestOnCurve(curve, p[0], p[1], p[2], near);
    worst = Math.max(worst, Math.hypot(p[0] - near[0], p[1] - near[1], p[2] - near[2]));
  }
  return seen ? worst : NaN;
}

/** A 90 degree edge along z at the origin: top face y = 0 over x < 0, wall x = 0 below. */
const corner = (fillet: number) =>
  modelOf(
    extrudedProfile(
      [
        [-2, 0],
        [0, 0],
        [0, -2],
      ],
      [fillet],
      4,
      scan,
    ),
  );
const trueCorner = drawnCurve('line', [0, 0, -2, 0, 0, 2], 0.02);
/** Clear of the open guide's tapered ends. */
const middle = (p: number[]) => Math.abs(p[2]) < 0.8;

const lineGuide = (
  model: Model,
  from: [number, number],
  to: [number, number],
  settings: Partial<EdgeInput>,
): EdgeInput => ({
  segments: [{ kind: 'line', points: [at(model, [...from, -1.4]), at(model, [...to, 1.4])] }],
  joints: [],
  closed: false,
  width: 0.6,
  strength: 1,
  ...settings,
});

/** A closed guide round the stadium slot's top rim, at its sharp corner y = 1, on the plane y = 1. */
function slotGuide(model: Model, settings: Partial<EdgeInput>): EdgeInput {
  const p = (x: number, z: number) => at(model, [x, 1, z]);
  const plane = planeOf('plane', 'Plane 1', [0, 1, 0], [0, 1, 0], [1, 0, 0])!;
  return {
    segments: [
      { kind: 'line', points: [p(-1.5, -0.35), p(1.5, -0.35)] },
      { kind: 'arc', points: [p(1.5, -0.35), p(1.85, 0), p(1.5, 0.35)] },
      { kind: 'line', points: [p(1.5, 0.35), p(-1.5, 0.35)] },
      { kind: 'arc', points: [p(-1.5, 0.35), p(-1.85, 0), p(-1.5, -0.35)] },
    ],
    joints: ['smooth', 'smooth', 'smooth', 'smooth'],
    closed: true,
    width: 0.5,
    strength: 1,
    position: 'corner',
    fit: 0,
    path: true,
    plane,
    usePlane: true,
    ...settings,
  };
}

/** Distance from the slot's sharp top rim: the stadium's outline at y = 1. */
function offSlotRim(p: number[]) {
  const [x, y, z] = p;
  const ax = Math.abs(x);
  const flat = ax <= 1.5 ? Math.abs(Math.abs(z) - 0.35) : Math.abs(Math.hypot(ax - 1.5, z) - 0.35);
  return Math.hypot(flat, y - 1);
}

describe('a guide placed at the corner of a slot on a sketch plane', () => {
  const model = modelOf(slottedPlate(0.35, 0.15, { ...scan, step: 0.035 }));

  for (const wallAngle of [90, null])
    it(`cuts the edge on the guide in one piece at wall angle ${wallAngle ?? 'Automatic'}`, () => {
      const r = outcome(model, slotGuide(model, { wallAngle }));
      expect(r.solve, String(r.why)).not.toBeNull();
      const solved = r as Solved;
      let worst = 0;
      for (const v of solved.chain)
        worst = Math.max(worst, offSlotRim([0, 1, 2].map((a) => solved.out.position[v * 3 + a])));
      expect(solved.result.pieces).toBe(1);
      expect(chainPieces(solved.out, solved.chain)).toEqual([
        { size: solved.chain.length, ends: 0 },
      ]);
      expect(edgeLoops(solved.result.cut!.edges, solved.chain)).toEqual([solved.chain.length]);
      expect(worst).toBeLessThan(0.002);
      // The unrounded top starts one fillet radius outside the slot wall.
      const tops: number[] = [];
      const members = new Set(solved.solve.bands.flatMap((b) => [...b.vertices]));
      for (const v of members) {
        const [x, y, z] = model.mesh.position.subarray(v * 3, v * 3 + 3);
        const radius = Math.hypot(Math.max(0, Math.abs(x) - 1.5), z);
        if (y > 0.95 && radius >= 0.35 + 0.15)
          tops.push(Math.abs(solved.out.position[v * 3 + 1] - 1));
      }
      expect(tops.length).toBeGreaterThan(100);
      const top = Math.max(...tops);
      expect(top).toBeLessThan(0.002);
    });
});

describe('Position on a filleted edge', () => {
  const model = corner(0.15);

  it('puts the edge at the true corner from the top or the bottom of the fillet', () => {
    const placed: ['top' | 'bottom', [number, number]][] = [
      ['top', [-0.15, 0]],
      ['bottom', [0, -0.15]],
    ];
    for (const [position, from] of placed) {
      const r = outcome(model, lineGuide(model, from, from, { position, fit: 0, path: true }));
      expect(r.solve, `${position}: ${r.why}`).not.toBeNull();
      expect(chainFrom(r as Solved, trueCorner, middle)).toBeLessThan(0.005);
    }
  });

  it('cuts exactly on a corner guide in the air over the rounding', () => {
    const r = outcome(
      model,
      lineGuide(model, [0, 0], [0, 0], { position: 'corner', fit: 0, path: true }),
    );
    expect(chainFrom(r as Solved, trueCorner, middle)).toBeLessThan(0.002);
  });

  it("solves Along at today's reach as today", () => {
    const guide = lineGuide(model, [-0.04, -0.04], [-0.04, -0.04], {});
    const today = outcome(model, guide) as Solved;
    const along = outcome(model, { ...guide, position: 'along', fit: 0.36 }) as Solved;
    const curve = today.solve.curve;
    expect(chainFrom(along, curve, middle)).toBeLessThan(0.005);
    expect(chainFrom(today, along.solve.curve, middle)).toBeLessThan(0.005);
  });
});

describe('Fit', () => {
  const model = corner(0.15);
  const off = (fit: number) => {
    const r = outcome(
      model,
      lineGuide(model, [-0.2, 0], [-0.2, 0], { position: 'corner', fit, path: true }),
    );
    expect(r.solve, String(r.why)).not.toBeNull();
    const p = (r as Solved).solve.curve.points;
    return Math.hypot(p[0], p[1]);
  };

  it('keeps the edge on the guide at 0', () => expect(off(0)).toBeCloseTo(0.2, 6));
  it('moves it to the corner when Fit reaches it', () => expect(off(0.3)).toBeLessThan(0.01));
  it('moves it no farther than Fit', () => expect(off(0.1)).toBeCloseTo(0.1, 3));
});

describe('Use guide path', () => {
  const model = corner(0.15);

  it('keeps a line straight and parallel to itself', () => {
    // A guide on the rounding, a little askew to the edge.
    const guide = lineGuide(model, [-0.06, -0.01], [-0.03, -0.02], {
      position: 'along',
      fit: 0.3,
      path: true,
    });
    const r = outcome(model, guide) as Solved;
    const p = r.solve.curve.points,
      n = p.length / 3;
    const d = [0, 1, 2].map((a) => p[(n - 1) * 3 + a] - p[a]);
    const g = [0.03, -0.01, 2.8];
    const cross = [d[1] * g[2] - d[2] * g[1], d[2] * g[0] - d[0] * g[2], d[0] * g[1] - d[1] * g[0]];
    expect(Math.hypot(...cross) / (Math.hypot(...d) * Math.hypot(...g))).toBeLessThan(1e-9);
    for (let k = 1; k < n - 1; k++) {
      const t = (p[k * 3 + 2] - p[2]) / d[2];
      const off = [0, 1, 2].map((a) => p[k * 3 + a] - p[a] - t * d[a]);
      expect(Math.hypot(...off)).toBeLessThan(1e-9);
    }
  });
});
