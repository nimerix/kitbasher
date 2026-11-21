import { describe, expect, it } from 'vitest';
import { estimateWidth } from '../../src/core/refine-band';
import { type EdgeInput, applyEdge, solveEdge } from '../../src/core/refine-edge';
import { cloneRefineMesh } from '../../src/core/refine-mesh';
import type { Vec3 } from '../../src/core/types';
import { modelOf, pointOn } from '../helpers/refine';
import { extrudedProfile } from '../helpers/soft-edges';

const scan = { step: 0.06, ripple: 0.01, noise: 0.006 };
type Model = ReturnType<typeof modelOf>;

/** The guide solved and applied once, with what the cut did, or `{ solved: false }`. */
function outcome(model: Model, input: EdgeInput) {
  const solve = solveEdge(model.mesh, model.topology, input, model.noise);
  if (!solve) return { solved: false as const };
  const out = cloneRefineMesh(model.mesh, true);
  const result = applyEdge(out, model.topology, solve, input.strength, true);
  let max = 0;
  for (let i = 0; i < model.mesh.weldedCount * 3; i += 3)
    max = Math.max(
      max,
      Math.hypot(
        out.position[i] - model.mesh.position[i],
        out.position[i + 1] - model.mesh.position[i + 1],
        out.position[i + 2] - model.mesh.position[i + 2],
      ),
    );
  return {
    solved: true as const,
    pieces: result.pieces,
    skipped: result.skipped.length,
    folded: result.folded.length,
    max: +max.toFixed(4),
    angle: +solve.bands[0].angle.toFixed(1),
    fits: solve.bands[0].fits.join('/'),
    deviation: +solve.deviation.toFixed(4),
    chain: result.cut ? Array.from(result.cut.chain) : [],
    out,
  };
}

const line = (model: Model, a: Vec3, b: Vec3, width: number | null, strength = 1): EdgeInput => ({
  segments: [{ kind: 'line', points: [pointOn(model.mesh, a), pointOn(model.mesh, b)] }],
  joints: [],
  closed: false,
  width,
  strength,
});

/** Largest distance in (x, y) of the chain within `half` mm of z = 0 from the point `at`. */
function chainOff(result: ReturnType<typeof outcome>, at: [number, number], half: number) {
  if (!result.solved) return NaN;
  let worst = 0;
  for (const v of result.chain) {
    const [x, y, z] = [0, 1, 2].map((a) => result.out.position[v * 3 + a]);
    if (Math.abs(z) > half) continue;
    worst = Math.max(worst, Math.hypot(x - at[0], y - at[1]));
  }
  return +worst.toFixed(4);
}

describe('a guide laid beside the edge', () => {
  const edge = () =>
    modelOf(
      extrudedProfile(
        [
          [-2, 0],
          [0, 0],
          [0, -2],
        ],
        [0.08],
        4,
        scan,
      ),
    );

  it('finds a 90 degree edge from 0.28 mm onto one face at width 0.5', () => {
    const model = edge();
    const r = outcome(model, line(model, [-0.28, 0, -1.4], [-0.28, 0, 1.4], 0.5, 0.65));
    expect(r.solved && [r.pieces, r.skipped, r.folded]).toEqual([1, 0, 0]);
    expect(chainOff(r, [0, 0], 0.7)).toBeLessThan(0.03); // measured 0.017
  });

  it('estimates the same width on the crest and 0.2 mm beside it', () => {
    const { mesh, topology, noise } = edge();
    const at = (x: number) => [pointOn(mesh, [x, 0, -1.4]), pointOn(mesh, [x, 0, 1.4])];
    const on = estimateWidth(mesh, topology, 'line', at(-0.02), noise);
    const beside = estimateWidth(mesh, topology, 'line', at(-0.2), noise);
    expect(on).toBeGreaterThan(0);
    expect(Math.abs(beside - on)).toBeLessThan(0.06);
  });

  it('solves or refuses cleanly at a width under its distance from the edge', () => {
    const model = edge();
    const r = outcome(model, line(model, [-0.28, 0, -1.4], [-0.28, 0, 1.4], 0.2, 0.65));
    if (r.solved) expect([r.pieces, r.skipped, r.folded]).toEqual([1, 0, 0]);
    // A refusal is a plain one, with nothing cut.
    else expect(r).toEqual({ solved: false });
  });

  it('takes the nearer of two edges 0.5 mm apart', () => {
    // A belt: a face 0.5 mm wide between a 90 degree edge at x = 0 and another at x = -0.5.
    for (const seed of [1, 2, 3]) {
      const m = modelOf(
        extrudedProfile(
          [
            [-0.5, -2],
            [-0.5, 0],
            [0, 0],
            [0, -2],
          ],
          [0.08, 0.08],
          4,
          { ...scan, seed },
        ),
      );
      const r = outcome(m, line(m, [-0.15, 0, -1.4], [-0.15, 0, 1.4], 0.4, 0.65));
      expect(r.solved).toBe(true);
      expect(chainOff(r, [0, 0], 0.7)).toBeLessThan(0.05);
    }
  });
});
