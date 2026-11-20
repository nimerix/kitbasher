import { Matrix4 } from 'three';
import { describe, expect, it } from 'vitest';
import { type EdgeInput, applyEdge, edgeFade, solveEdge } from '../../src/core/refine-edge';
import { type RefineMesh, cloneRefineMesh } from '../../src/core/refine-mesh';
import type { GuidePoint } from '../../src/core/refine-band';
import type { GuideKind } from '../../src/core/refine-curve';
import {
  closedMesh,
  dihedralAcross,
  maxMove,
  meshMinTriangleArea,
  modelOf,
  movedOutside,
  pointOn,
  straddlingCurve,
  straightness,
} from '../helpers/refine';
import {
  type SoftOptions,
  extrudedProfile,
  softBox,
  softCylinder,
  softStep,
} from '../helpers/soft-edges';

/** How far a 0.3 mm fillet's crest sits in from each face. */
const crest = 0.3 - 0.3 / Math.SQRT2;
/** The fillet's crest on the box edge y = 1.5, z = 1. */
const edgeGuide = (mesh: RefineMesh, x0: number, x1: number) => [
  pointOn(mesh, [x0, 1.5 - crest, 1 - crest]),
  pointOn(mesh, [x1, 1.5 - crest, 1 - crest]),
];
const inputOf = (kind: GuideKind, points: GuidePoint[]): EdgeInput => ({
  segments: [{ kind, points }],
  joints: [],
  closed: false,
  width: 0.6,
  strength: 1,
});

const refineBoxEdge = (options: SoftOptions = {}, matrix = new Matrix4()) => {
  const model = modelOf(softBox([2, 1.5, 1], 0.3, options), matrix);
  const solve = solveEdge(
    model.mesh,
    model.topology,
    inputOf('line', edgeGuide(model.mesh, -1.6, 1.6)),
    model.noise,
  )!;
  const out = cloneRefineMesh(model.mesh, true);
  const result = applyEdge(out, model.topology, solve, 1, true);
  return { model, solve, out, result };
};
/** Chain vertices clear of both fades: |x| <= 1.6 - edgeFade(0.6). */
const core = (out: RefineMesh, chain: Uint32Array) =>
  [...chain].filter((v) => Math.abs(out.position[v * 3]) <= 1.6 - edgeFade(0.6));
const offEdge = (out: RefineMesh, v: number, y: number, z: number) =>
  Math.hypot(out.position[v * 3 + 1] - y, out.position[v * 3 + 2] - z);

describe('solveEdge and applyEdge on one segment', () => {
  it('puts an exterior edge on the true edge, straight, at 90 degrees', () => {
    const { out, result, solve } = refineBoxEdge();
    expect(solve.sign[0]).toBe(1);
    const chain = core(out, result.cut!.chain);
    expect(chain.length).toBeGreaterThan(20);
    for (const v of chain) expect(offEdge(out, v, 1.5, 1)).toBeLessThan(0.02);
    expect(straightness(out, chain)).toBeLessThan(0.005);
    expect(Math.abs(dihedralAcross(out, result.cut!.edges, chain) - 90)).toBeLessThan(1);
  });

  it('does the same for an interior edge', () => {
    const model = modelOf(softStep(0.3));
    const c = 0.3 - 0.3 / Math.SQRT2;
    const points = [pointOn(model.mesh, [c, c, -1.6]), pointOn(model.mesh, [c, c, 1.6])];
    const solve = solveEdge(model.mesh, model.topology, inputOf('line', points), model.noise)!;
    expect(solve.sign[0]).toBe(-1);
    const out = cloneRefineMesh(model.mesh, true);
    const chain = [...applyEdge(out, model.topology, solve, 1, true).cut!.chain].filter(
      (v) => Math.abs(out.position[v * 3 + 2]) <= 1,
    );
    expect(chain.length).toBeGreaterThan(20);
    for (const v of chain)
      expect(Math.hypot(out.position[v * 3], out.position[v * 3 + 1])).toBeLessThan(0.02);
  });

  it('puts an arc guide on a cylinder rim on the true circle', () => {
    const model = modelOf(softCylinder(1.5, 1, 0.3));
    const r = 1.2 + 0.3 / Math.SQRT2,
      y = 0.7 + 0.3 / Math.SQRT2;
    const points = [0, 1, 2].map((k) => {
      const angle = (k * 2 * Math.PI) / 3;
      return pointOn(model.mesh, [r * Math.cos(angle), y, r * Math.sin(angle)]);
    });
    const solve = solveEdge(model.mesh, model.topology, inputOf('arc', points), model.noise)!;
    expect(solve).not.toBeNull();
    expect(solve.sign[0]).toBe(1);
    const out = cloneRefineMesh(model.mesh, true);
    const { cut } = applyEdge(out, model.topology, solve, 1, true);
    // The arc runs from angle 0 to 240 degrees; its fades cover edgeFade(0.6) mm of each end.
    const clear = edgeFade(0.6) / 1.5;
    const chain = [...cut!.chain].filter((v) => {
      const angle = Math.atan2(out.position[v * 3 + 2], out.position[v * 3]);
      const turn = angle < 0 ? angle + 2 * Math.PI : angle;
      return turn >= clear && turn <= (4 * Math.PI) / 3 - clear;
    });
    expect(chain.length).toBeGreaterThan(40);
    for (const v of chain) {
      const radius = Math.hypot(out.position[v * 3], out.position[v * 3 + 2]);
      expect(Math.hypot(radius - 1.5, out.position[v * 3 + 1] - 1)).toBeLessThan(0.02);
    }
  });

  it('leaves no triangle straddling the edge and keeps the mesh closed', () => {
    const { out, solve, result } = refineBoxEdge();
    expect(straddlingCurve(out, solve)).toBe(0);
    expect(closedMesh(out)).toBe(true);
    expect(meshMinTriangleArea(out)).toBeGreaterThan(1e-12);
    expect(result.skipped.length).toBe(0);
    expect(result.folded.length).toBe(0);
  });

  it('moves nothing outside the band', () => {
    const { model, out, solve } = refineBoxEdge();
    expect(movedOutside(model.mesh, out, solve.bands[0].vertices)).toBe(0);
  });

  it('previews without cutting', () => {
    const { model, solve } = refineBoxEdge();
    const draft = cloneRefineMesh(model.mesh, false);
    expect(applyEdge(draft, model.topology, solve, 1, false).cut).toBeNull();
    expect(draft.triangleCount).toBe(model.mesh.triangleCount);
  });

  it('does nothing at strength 0 and grows steadily with strength', () => {
    const { model, solve } = refineBoxEdge();
    const moves = [0, 0.25, 0.5, 1].map((strength) => {
      const draft = cloneRefineMesh(model.mesh, false);
      applyEdge(draft, model.topology, solve, strength, false);
      return maxMove(model.mesh, draft);
    });
    expect(moves[0]).toBe(0);
    expect(moves[1]).toBeGreaterThan(0);
    expect(moves[1]).toBeLessThan(moves[2]);
    expect(moves[2]).toBeLessThan(moves[3]);
  });

  it('returns null on a flat face and between faces under minBandAngle apart', () => {
    const model = modelOf(softBox([2, 1.5, 1], 0.3));
    const flat = [pointOn(model.mesh, [-1, 1.5, 0]), pointOn(model.mesh, [1, 1.5, 0])];
    expect(solveEdge(model.mesh, model.topology, inputOf('line', flat), model.noise)).toBeNull();
    // Faces 4 degrees either side of level: 8 degrees between their normals.
    const slope = Math.tan((4 * Math.PI) / 180);
    const ridge = modelOf(
      extrudedProfile(
        [
          [-1.5, -1.5 * slope],
          [0, 0],
          [1.5, -1.5 * slope],
        ],
        [0.6],
        3,
      ),
    );
    const top = -0.6 * (1 / Math.cos((4 * Math.PI) / 180) - 1);
    const points = [-1.2, 1.2].map((z) => pointOn(ridge.mesh, [0, top, z]));
    expect(solveEdge(ridge.mesh, ridge.topology, inputOf('line', points), ridge.noise)).toBeNull();
  });

  it('meets the tolerances on a mirrored part scaled unevenly along its edge', () => {
    const matrix = new Matrix4().makeScale(1.5, 1, -1);
    // The world-space box is half [3, 1.5, 1]; its edge y = 1.5, z = -1 is refined to within 0.02.
    const model = modelOf(softBox([2, 1.5, 1], 0.3), matrix);
    const points = [-2.4, 2.4].map((x) => pointOn(model.mesh, [x, 1.5 - crest, -(1 - crest)]));
    const solve = solveEdge(model.mesh, model.topology, inputOf('line', points), model.noise)!;
    expect(solve).not.toBeNull();
    expect(solve.sign[0]).toBe(1);
    const out = cloneRefineMesh(model.mesh, true);
    const { cut } = applyEdge(out, model.topology, solve, 1, true);
    const chain = [...cut!.chain].filter(
      (v) => Math.abs(out.position[v * 3]) <= 2.4 - edgeFade(0.6),
    );
    expect(chain.length).toBeGreaterThan(20);
    for (const v of chain) expect(offEdge(out, v, 1.5, -1)).toBeLessThan(0.02);
    expect(Math.abs(dihedralAcross(out, cut!.edges, chain) - 90)).toBeLessThan(1);
    expect(closedMesh(out)).toBe(true);
  });

  it('meets the tolerances on an indexed mesh', () => {
    const { out, result } = refineBoxEdge({ indexed: true });
    const chain = core(out, result.cut!.chain);
    expect(chain.length).toBeGreaterThan(20);
    for (const v of chain) expect(offEdge(out, v, 1.5, 1)).toBeLessThan(0.02);
    expect(closedMesh(out)).toBe(true);
  });
});
