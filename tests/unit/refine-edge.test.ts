import { Matrix4 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  type EdgeInput,
  type EdgeSolve,
  applyEdge,
  correctedFlanks,
  moveWeights,
  solveEdge,
} from '../../src/core/refine-edge';
import { type RefineMesh, cloneRefineMesh } from '../../src/core/refine-mesh';
import type { GuidePoint } from '../../src/core/refine-band';
import { type GuideKind, closestOnCurve } from '../../src/core/refine-curve';
import {
  closedMesh,
  dihedralAcross,
  facesOffSurfaces,
  fullWeightChain,
  maxMove,
  meshMinTriangleArea,
  modelFrom,
  modelOf,
  movedOutside,
  pointOn,
  reversedAgainstFlanks,
  seamMove,
  straddlingCurve,
  straightness,
} from '../helpers/refine';
import {
  type SoftOptions,
  bulgedBox,
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
/** Length at each end of the guide, mm, that the tests leave out as within the blend to the scan. */
const fade = 0.6;
/** Chain vertices clear of both ends' blends: |x| <= 1.6 - fade. */
const core = (out: RefineMesh, chain: Uint32Array) =>
  [...chain].filter((v) => Math.abs(out.position[v * 3]) <= 1.6 - fade);
const offEdge = (out: RefineMesh, v: number, y: number, z: number) =>
  Math.hypot(out.position[v * 3 + 1] - y, out.position[v * 3 + 2] - z);
const moveOf = (before: RefineMesh, after: RefineMesh, v: number) =>
  Math.hypot(...[0, 1, 2].map((a) => after.position[v * 3 + a] - before.position[v * 3 + a]));

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
    // The arc runs from angle 0 to 240 degrees; its fades cover fade mm of each end.
    const clear = fade / 1.5;
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
    // Its taper of 8 edge lengths along the stretched edge is longer than `fade`.
    const weights = moveWeights(model.mesh, model.topology, solve);
    const chain = fullWeightChain(out, solve, weights, cut!.chain).filter(
      (v) => Math.abs(out.position[v * 3]) <= 2.4 - fade,
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

  it('puts the edge on its true line where one flank is a profile per slice', () => {
    const model = modelOf(bulgedBox([2, 1.5, 1], 0.3, 0.15));
    const bump = (x: number) => 0.15 * Math.exp(-((x / 0.5) ** 2));
    const lift = (x: number, y: number) => (bump(x) * (y + 1.5)) / 3;
    const points = [-1.2, -0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9, 1.2].map((x) =>
      pointOn(model.mesh, [x, 1.5 - crest + lift(x, 1.5 - crest), 1 - crest]),
    );
    const solve = solveEdge(model.mesh, model.topology, inputOf('spline', points), model.noise)!;
    expect(solve).not.toBeNull();
    expect(solve.flanks[0].map((flank) => flank.kind)).toEqual(['profile', 'plane']);
    const out = cloneRefineMesh(model.mesh, true);
    const { cut } = applyEdge(out, model.topology, solve, 1, true);
    const chain = [...cut!.chain].filter((v) => Math.abs(out.position[v * 3]) <= 1.2 - fade);
    expect(chain.length).toBeGreaterThan(10);
    for (const v of chain)
      expect(offEdge(out, v, 1.5 + bump(out.position[v * 3]), 1)).toBeLessThan(0.03);
  });

  it('finishes where both flanks are profiles per slice', () => {
    // Both faces bulge 0.2 mm over 0.5 mm along the edge, so neither flank fits one shape.
    const geometry = softBox([2, 1.5, 1], 0.3);
    const position = geometry.getAttribute('position');
    const bump = (x: number) => 0.2 * Math.exp(-((x / 0.5) ** 2));
    for (let i = 0; i < position.count; i++) {
      const [x, y, z] = [position.getX(i), position.getY(i), position.getZ(i)];
      position.setXYZ(i, x, y + (bump(x) * (y + 1.5)) / 3, z + (bump(x) * (z + 1)) / 2);
    }
    const model = modelOf(geometry);
    const points = [-1.2, -0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9, 1.2].map((x) =>
      pointOn(model.mesh, [
        x,
        1.5 - crest + (bump(x) * (3 - crest)) / 3,
        1 - crest + (bump(x) * (2 - crest)) / 2,
      ]),
    );
    const start = performance.now();
    const solve = solveEdge(model.mesh, model.topology, inputOf('spline', points), model.noise);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(solve).not.toBeNull();
    expect(solve!.flanks[0].map((flank) => flank.kind)).toEqual(['profile', 'profile']);
  });

  it('changes nothing it made sharp when run again over its own result', () => {
    const { model, solve, out } = refineBoxEdge();
    const weights = moveWeights(model.mesh, model.topology, solve);
    const again = modelFrom(out);
    const points = [pointOn(out, [-1.6, 1.5, 1]), pointOn(out, [1.6, 1.5, 1])];
    const second = solveEdge(again.mesh, again.topology, inputOf('line', points), again.noise)!;
    expect(second).not.toBeNull();
    const twice = cloneRefineMesh(again.mesh, true);
    applyEdge(twice, again.topology, second, 1, true);
    let full = 0,
      firstBlend = 0,
      secondBlend = 0;
    solve.bands[0].vertices.forEach((v, i) => {
      if (weights[i] === 1) full = Math.max(full, moveOf(out, twice, v));
      else if (weights[i] > 0) {
        firstBlend = Math.max(firstBlend, moveOf(model.mesh, out, v));
        secondBlend = Math.max(secondBlend, moveOf(out, twice, v));
      }
    });
    expect(full).toBeLessThan(0.002);
    expect(secondBlend).toBeLessThan(firstBlend);
  });

  it('cuts without reversing a face against the flank it belongs to', () => {
    for (const { model, solve } of [boxCase(), stepCase(), rimCase()]) {
      const out = cloneRefineMesh(model.mesh, true);
      const { cut } = applyEdge(out, model.topology, solve, 1, true);
      const surfaces = correctedFlanks(model.mesh, model.topology, solve);
      expect(reversedAgainstFlanks(out, solve, cut!.children, surfaces, cut!.skipped)).toBe(0);
      expect(closedMesh(out)).toBe(true);
    }
  });

  it('solves an edge from flank clear of the rounding', () => {
    // A 0.12 mm fillet sampled at 0.06 mm: its shoulder lies within the flanks' tolerance.
    const model = modelOf(softBox([2.5, 1.5, 1], 0.12, sharpEdge));
    const solve = solveEdge(
      model.mesh,
      model.topology,
      autoWidth(smallCrest(model.mesh)),
      model.noise,
    )!;
    expect(solve).not.toBeNull();
    expect(curveOff(solve, (p) => Math.hypot(p[1] - 1.5, p[2] - 1), 1)).toBeLessThan(0.02);
    const out = cloneRefineMesh(model.mesh, true);
    const { cut } = applyEdge(out, model.topology, solve, 1, true);
    const weights = moveWeights(model.mesh, model.topology, solve);
    const chain = fullWeightChain(out, solve, weights, cut!.chain);
    expect(chain.length).toBeGreaterThan(20);
    for (const v of chain) expect(offEdge(out, v, 1.5, 1)).toBeLessThan(0.02);
  });

  it('meets the tolerances on a mirrored part scaled unevenly across its edge', () => {
    // The world-space box is half [2, 3, 1]: its 0.15 mm fillet is 0.3 mm tall on the front face.
    const matrix = new Matrix4().makeScale(1, 2, -1);
    const c = 0.15 - 0.15 / Math.SQRT2;
    const model = modelOf(softBox([2, 1.5, 1], 0.15), matrix);
    const points = [-1.6, 1.6].map((x) => pointOn(model.mesh, [x, 3 - 2 * c, -(1 - c)]));
    const solve = solveEdge(model.mesh, model.topology, inputOf('line', points), model.noise)!;
    expect(solve).not.toBeNull();
    expect(solve.sign[0]).toBe(1);
    const out = cloneRefineMesh(model.mesh, true);
    const { cut } = applyEdge(out, model.topology, solve, 1, true);
    const chain = core(out, cut!.chain);
    expect(chain.length).toBeGreaterThan(20);
    for (const v of chain) expect(offEdge(out, v, 3, -1)).toBeLessThan(0.02);
    expect(closedMesh(out)).toBe(true);
  });

  it('reports how far the solved edge strays from the meet it straightens', () => {
    const straight = modelOf(softBox([2.5, 1.5, 1], 0.12, sharpEdge));
    const level = solveEdge(
      straight.mesh,
      straight.topology,
      autoWidth(smallCrest(straight.mesh)),
      straight.noise,
    )!;
    expect(level.deviation).toBeLessThan(0.005);
    // A 0.07 mm bump on the top face: a line guide straightens it and says by how much.
    const bulged = modelOf(bulgedBox([2.5, 1.5, 1], 0.12, 0.07, sharpEdge));
    const bent = solveEdge(
      bulged.mesh,
      bulged.topology,
      autoWidth(smallCrest(bulged.mesh)),
      bulged.noise,
    )!;
    expect(bent).not.toBeNull();
    expect(bent.deviation).toBeGreaterThan(0.03);
    expect(bent.deviation).toBeLessThan(0.07);
  });

  it('puts the faces beside the chain on the corrected surfaces', () => {
    const bulged = modelOf(bulgedBox([2.5, 1.5, 1], 0.12, 0.07, sharpEdge));
    const bent = solveEdge(
      bulged.mesh,
      bulged.topology,
      autoWidth(smallCrest(bulged.mesh)),
      bulged.noise,
    )!;
    for (const { model, solve } of [boxCase(), { model: bulged, solve: bent }]) {
      const out = cloneRefineMesh(model.mesh, true);
      const { cut } = applyEdge(out, model.topology, solve, 1, true);
      const weights = moveWeights(model.mesh, model.topology, solve);
      const chain = fullWeightChain(out, solve, weights, cut!.chain);
      const surfaces = correctedFlanks(model.mesh, model.topology, solve);
      const worst = facesOffSurfaces(out, cut!.edges, chain, surfaces);
      expect(worst).toBeGreaterThanOrEqual(0);
      expect(worst).toBeLessThan(0.005);
    }
  });

  it('refuses a width that leaves no sharp core', () => {
    const model = modelOf(softBox([2.5, 1.5, 1], 0.12, sharpEdge));
    const points = [-1.1, 1.1].map((x) => pointOn(model.mesh, [x, 1.5 - smallC, 1 - smallC]));
    const narrow = { ...inputOf('line', points), width: 0.12 };
    expect(solveEdge(model.mesh, model.topology, narrow, model.noise)).toBeNull();
  });

  it('keeps the middle of the edge when the width is far larger than the estimate', () => {
    const model = modelOf(softBox([2.5, 1.5, 1], 0.12, sharpEdge));
    const points = [-1.1, 1.1].map((x) => pointOn(model.mesh, [x, 1.5 - smallC, 1 - smallC]));
    const run = (width: number | null) => {
      const solve = solveEdge(
        model.mesh,
        model.topology,
        { ...inputOf('line', points), width },
        model.noise,
      )!;
      const out = cloneRefineMesh(model.mesh, false);
      applyEdge(out, model.topology, solve, 1, false);
      return { solve, out };
    };
    const estimate = run(null);
    const wide = run(2.5);
    expect(wide.solve.width).toBe(2.5);
    const weights = moveWeights(model.mesh, model.topology, estimate.solve);
    let worst = 0,
      count = 0;
    estimate.solve.bands[0].vertices.forEach((v, i) => {
      if (weights[i] !== 1) return;
      count++;
      worst = Math.max(worst, moveOf(estimate.out, wide.out, v));
    });
    expect(count).toBeGreaterThan(50);
    expect(worst).toBeLessThan(0.002);
  });

  it("moves a vertex beside one that stays, along the band's sides, by at most 0.005 mm", () => {
    // Clear of the ends, where the taper along the guide sets the blend.
    const turn = (x: number, z: number) => (Math.atan2(z, x) + 2 * Math.PI) % (2 * Math.PI);
    for (const { model, solve, sides } of [
      { ...boxCase(), sides: (x: number) => Math.abs(x) <= 1 },
      { ...rimCase(), sides: (x: number, _: number, z: number) => Math.abs(turn(x, z) - 2) <= 1 },
    ]) {
      const out = cloneRefineMesh(model.mesh, false);
      applyEdge(out, model.topology, solve, 1, false);
      const seam = seamMove(model.mesh, out, model.topology, sides);
      expect(seam).toBeGreaterThan(0);
      expect(seam).toBeLessThan(0.005);
    }
  });

  it('holds an edge drawn from corner to corner and tapers one that stops mid-edge', () => {
    const model = modelOf(softBox([2, 1.5, 1], 0.3));
    const ends = (x0: number, x1: number) =>
      solveEdge(
        model.mesh,
        model.topology,
        inputOf('line', edgeGuide(model.mesh, x0, x1)),
        model.noise,
      )!.ends;
    expect(ends(-1, 1)).toEqual(['taper', 'taper']);
    expect(ends(-1.85, 1.85)).toEqual(['hold', 'hold']);
    expect(ends(-0.5, 1.85)).toEqual(['taper', 'hold']);
  });

  it('cuts along the whole guide and creases only where the weight is at least 0.5', () => {
    const model = modelOf(softBox([2, 1.5, 1], 0.3));
    const solve = solveEdge(
      model.mesh,
      model.topology,
      inputOf('line', edgeGuide(model.mesh, -1, 1)),
      model.noise,
    )!;
    const out = cloneRefineMesh(model.mesh, true);
    const { cut, skipped } = applyEdge(out, model.topology, solve, 1, true);
    expect(skipped.length).toBe(0);
    const weights = moveWeights(model.mesh, model.topology, solve);
    const weightOf = new Map<number, number>();
    solve.bands[0].vertices.forEach((v, i) => weightOf.set(v, weights[i]));
    // The chain reaches into the tapers, where the weight is under 0.5 and nothing is creased.
    const xs = [...cut!.chain].map((v) => out.position[v * 3]);
    expect(Math.min(...xs)).toBeLessThan(-0.75);
    expect(Math.max(...xs)).toBeGreaterThan(0.75);
    const creased = [...cut!.chain].filter((v) => out.crease[v] === 1);
    expect(creased.length).toBeGreaterThan(0);
    expect(creased.length).toBeLessThan(cut!.chain.length);
    for (const v of cut!.chain)
      if (v < model.mesh.weldedCount && weightOf.get(v)! < 0.4) expect(out.crease[v]).toBe(0);
  });

  it('keeps neighbouring moves within 0.025 mm of each other where an edge tapers', () => {
    const box = modelOf(softBox([2, 1.5, 1], 0.3));
    const step = stepCase();
    const cases = [
      {
        model: box,
        solve: solveEdge(
          box.mesh,
          box.topology,
          inputOf('line', edgeGuide(box.mesh, -1, 1)),
          box.noise,
        )!,
      },
      step,
      rimCase(),
    ];
    for (const { model, solve } of cases) {
      expect(solve.ends).toEqual(['taper', 'taper']);
      expect(weightStep(model, solve)).toBeLessThan(0.025);
    }
  });

  it("moves a vertex beside one that stays, along an interior step's sides, by at most 0.006 mm", () => {
    const { model, solve } = stepCase();
    const out = cloneRefineMesh(model.mesh, false);
    applyEdge(out, model.topology, solve, 1, false);
    const seam = seamMove(model.mesh, out, model.topology, (_x, _y, z) => Math.abs(z) <= 1);
    expect(seam).toBeGreaterThan(0);
    expect(seam).toBeLessThan(0.006);
  });

  it('puts the chain on the solved edge where the weight is full', () => {
    for (const { model, solve } of [boxCase(), stepCase(), rimCase()]) {
      const out = cloneRefineMesh(model.mesh, true);
      const { cut } = applyEdge(out, model.topology, solve, 1, true);
      const weights = moveWeights(model.mesh, model.topology, solve);
      const chain = fullWeightChain(out, solve, weights, cut!.chain);
      expect(chain.length).toBeGreaterThan(20);
      const at = new Float64Array(3);
      for (const v of chain) {
        const p = [0, 1, 2].map((a) => out.position[v * 3 + a]);
        closestOnCurve(solve.curve, p[0], p[1], p[2], at);
        expect(Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2])).toBeLessThan(0.001);
      }
    }
  });

  it('creases exactly where the placement weight is at least 0.5, whatever room the buffers have', () => {
    const fillet = 0.3,
      shift = fillet * (1 - Math.SQRT1_2);
    const model = modelOf(softCylinder(1.5, 1, fillet, { step: 0.06 }));
    const points = [0, 1, 2].map((k) => {
      const theta = (k * 2 * Math.PI) / 3;
      return pointOn(model.mesh, [
        (1.5 - shift) * Math.cos(theta),
        1 - shift,
        (1.5 - shift) * Math.sin(theta),
      ]);
    });
    const solve = solveEdge(model.mesh, model.topology, inputOf('arc', points), model.noise)!;
    const tight = cloneRefineMesh(model.mesh, true),
      roomy = cloneRefineMesh(model.mesh, true);
    tight.position = tight.position.slice(0, model.mesh.weldedCount * 3);
    roomy.position = new Float64Array(2 * tight.position.length);
    roomy.position.set(tight.position);
    const first = applyEdge(tight, model.topology, solve, 1, true).cut!;
    const second = applyEdge(roomy, model.topology, solve, 1, true).cut!;
    expect(first).toStrictEqual(second);
    const creased = [...first.chain].filter((v) => tight.crease[v]);
    expect(creased.length).toBeGreaterThan(0);
    expect([...first.chain].filter((v) => tight.crease[v] !== roomy.crease[v])).toEqual([]);
  });

  it('holds an end whose flanks stop within the 0.3 mm past it, and tapers one whose flanks go on', () => {
    const radius = 0.12,
      c = radius * (1 - Math.SQRT1_2);
    const model = modelOf(softBox([2, 1.5, 1], radius, sharpEdge));
    // The straight flanks end where the corner's rounding starts, at x = 2 - radius.
    const endOf = (remaining: number) => {
      const points = [-1, 2 - radius - remaining].map((x) =>
        pointOn(model.mesh, [x, 1.5 - c, 1 - c]),
      );
      return solveEdge(model.mesh, model.topology, autoWidth(points), model.noise)!.ends[1];
    };
    expect(endOf(0.18)).toBe('hold');
    expect(endOf(0.21)).toBe('hold');
    expect(endOf(0.36)).toBe('taper');
  });

  it('uses the ends the input sets and decides only those it leaves null', () => {
    const radius = 0.12,
      c = radius * (1 - Math.SQRT1_2);
    const model = modelOf(softBox([2, 1.5, 1], radius, sharpEdge));
    const solveTo = (remaining: number, ends?: EdgeInput['ends']) => {
      const points = [-1, 2 - radius - remaining].map((x) =>
        pointOn(model.mesh, [x, 1.5 - c, 1 - c]),
      );
      return solveEdge(model.mesh, model.topology, { ...autoWidth(points), ends }, model.noise)!;
    };
    expect(solveTo(0.36).ends).toEqual(['taper', 'taper']);
    expect(solveTo(0.36, [null, 'hold']).ends).toEqual(['taper', 'hold']);
    expect(solveTo(0.18).ends[1]).toBe('hold');
    expect(solveTo(0.18, ['hold', 'taper']).ends).toEqual(['hold', 'taper']);
    // The weights follow the end used: in the last 0.05 mm a held end keeps its blend from the
    // surface past it, a tapered one has faded out.
    const held = solveTo(0.36, [null, 'hold']),
      tapered = solveTo(0.36);
    const endWeight = (solve: EdgeSolve) => {
      const weights = moveWeights(model.mesh, model.topology, solve);
      let most = 0;
      solve.bands[0].vertices.forEach((v, i) => {
        if (model.mesh.position[v * 3] > 2 - radius - 0.36 - 0.05)
          most = Math.max(most, weights[i]);
      });
      return most;
    };
    expect(endWeight(held)).toBeGreaterThan(0.3);
    expect(endWeight(tapered)).toBeLessThan(0.05);
  });

  it('cuts one chain in one piece, nothing left straddling or facing against its surface', () => {
    for (const { model, solve } of [boxCase(), stepCase(), rimCase()]) {
      const out = cloneRefineMesh(model.mesh, true);
      const result = applyEdge(out, model.topology, solve, 1, true);
      expect(result.pieces).toBe(1);
      expect(result.skipped).toHaveLength(0);
      expect(result.folded).toHaveLength(0);
      expect(closedMesh(out)).toBe(true);
    }
  });

  it('passes both corrected surfaces through the solved edge', () => {
    for (const { model, solve } of [boxCase(), stepCase(), rimCase()]) {
      const surfaces = correctedFlanks(model.mesh, model.topology, solve);
      const p = solve.curve.points;
      for (let k = 0; k < p.length; k += 3)
        for (const surface of surfaces)
          expect(surface(p[k], p[k + 1], p[k + 2])).toBeLessThan(0.0005);
    }
  });
});

/**
 * Largest difference the weights make between two neighbours' moves at full strength: |w_u - w_v|
 * times the larger of their full moves. The raw difference is not used: across the rounding's middle
 * two neighbours at full weight move onto different flanks.
 */
function weightStep(model: ReturnType<typeof modelOf>, solve: EdgeSolve) {
  const out = cloneRefineMesh(model.mesh, false);
  applyEdge(out, model.topology, solve, 1, false);
  const weights = moveWeights(model.mesh, model.topology, solve);
  const w = new Float64Array(model.mesh.weldedCount);
  solve.bands[0].vertices.forEach((v, i) => (w[v] = weights[i]));
  const full = (v: number) => (w[v] > 0 ? moveOf(model.mesh, out, v) / w[v] : 0);
  let worst = 0;
  for (const v of solve.bands[0].vertices)
    for (let j = model.topology.neighbourStart[v]; j < model.topology.neighbourStart[v + 1]; j++) {
      const u = model.topology.neighbours[j];
      worst = Math.max(worst, Math.abs(w[v] - w[u]) * Math.max(full(v), full(u)));
    }
  return worst;
}

/** A sharp 0.12 mm fillet sampled at 0.06 mm without ripple. */
const sharpEdge = { step: 0.06, noise: 0.004, ripple: 0 };
const smallC = 0.12 * (1 - Math.SQRT1_2);
const smallCrest = (mesh: RefineMesh) =>
  [-1.7, 1.7].map((x) => pointOn(mesh, [x, 1.5 - smallC, 1 - smallC]));
const autoWidth = (points: GuidePoint[]): EdgeInput => ({
  ...inputOf('line', points),
  width: null,
});
/** Largest distance from the solved curve, where |x| <= `reach`, of `off`. */
const curveOff = (solve: EdgeSolve, off: (p: number[]) => number, reach: number) => {
  let worst = 0;
  const p = solve.curve.points;
  for (let k = 0; k < p.length; k += 3)
    if (Math.abs(p[k]) <= reach) worst = Math.max(worst, off([p[k], p[k + 1], p[k + 2]]));
  return worst;
};
const boxCase = () => {
  const { model, solve } = refineBoxEdge();
  return { model, solve };
};
const stepCase = () => {
  const model = modelOf(softStep(0.3));
  const points = [
    pointOn(model.mesh, [crest, crest, -1.6]),
    pointOn(model.mesh, [crest, crest, 1.6]),
  ];
  return {
    model,
    solve: solveEdge(model.mesh, model.topology, inputOf('line', points), model.noise)!,
  };
};
const rimCase = () => {
  const model = modelOf(softCylinder(1.5, 1, 0.3));
  const r = 1.2 + 0.3 / Math.SQRT2,
    y = 0.7 + 0.3 / Math.SQRT2;
  const points = [0, 1, 2].map((k) => {
    const angle = (k * 2 * Math.PI) / 3;
    return pointOn(model.mesh, [r * Math.cos(angle), y, r * Math.sin(angle)]);
  });
  return {
    model,
    solve: solveEdge(model.mesh, model.topology, inputOf('arc', points), model.noise)!,
  };
};
