import { describe, expect, it } from 'vitest';
import { buildBand, estimateBand, estimateWidth } from '../../src/core/refine-band';
import { type EdgeInput, applyEdge, solveEdge } from '../../src/core/refine-edge';
import { cloneRefineMesh } from '../../src/core/refine-mesh';
import type { Vec3 } from '../../src/core/types';
import { modelOf, pointOn } from '../helpers/refine';
import { extrudedProfile, softCylinder } from '../helpers/soft-edges';

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

/**
 * Largest distance in (x, y) of the chain within `half` mm of z = 0 from the point `at`. NaN when
 * nothing was solved or no chain vertex lies in that window, so that no comparison passes on it.
 */
function chainOff(result: ReturnType<typeof outcome>, at: [number, number], half: number) {
  if (!result.solved) return NaN;
  let worst = 0,
    seen = 0;
  for (const v of result.chain) {
    const [x, y, z] = [0, 1, 2].map((a) => result.out.position[v * 3 + a]);
    if (Math.abs(z) > half) continue;
    seen++;
    worst = Math.max(worst, Math.hypot(x - at[0], y - at[1]));
  }
  return seen ? +worst.toFixed(4) : NaN;
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
    const position = model.mesh.position.slice(),
      corners = model.mesh.corners.slice();
    const r = outcome(model, line(model, [-0.28, 0, -1.4], [-0.28, 0, 1.4], 0.2, 0.65));
    if (r.solved) expect([r.pieces, r.skipped, r.folded]).toEqual([1, 0, 0]);
    else {
      // A refusal is a plain one, with nothing cut and the source mesh as it was.
      expect(r).toEqual({ solved: false });
      expect(model.mesh.position).toEqual(position);
      expect(model.mesh.corners).toEqual(corners);
    }
  });

  it('takes the nearer of two edges 0.5 mm apart', () => {
    // A belt: a face 0.5 mm wide between a 90 degree edge at x = 0 and another at x = -0.5. A guide
    // 0.15 mm in from either edge takes that edge.
    for (const [x, nearer] of [
      [-0.15, 0],
      [-0.35, -0.5],
    ])
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
        const r = outcome(m, line(m, [x, 0, -1.4], [x, 0, 1.4], 0.4, 0.65));
        expect(r.solved && [r.pieces, r.skipped, r.folded]).toEqual([1, 0, 0]);
        expect(chainOff(r, [nearer, 0], 0.7)).toBeLessThan(0.05);
      }
  });
});

describe('a guide that strays from its edge', () => {
  it('keeps every vertex within Width of the solved edge where the edge lies past reach', () => {
    // The guide runs from 0.05 mm onto the top face at one end to 0.6 mm at the other. The solved
    // edge is within reach of it (0.41 mm, 6 edge lengths) in over half of the slices, and up to
    // 0.60 mm from it at the far end (measured): there the band reaches further from the guide.
    const m = modelOf(
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
    const width = 0.55;
    const points = [pointOn(m.mesh, [-0.05, 0, -1.4]), pointOn(m.mesh, [-0.6, 0, 1.4])];
    const band = buildBand(m.mesh, m.topology, 'line', points, width, m.noise);
    expect(band).not.toBeNull();
    const kept = new Set(band!.vertices);
    // Vertices on the side face at most Width less 0.05 mm below the corner, along the guide: the
    // 0.08 mm rounding makes the way round it shorter than to the corner and back.
    const p = m.mesh.position;
    const near: number[] = [];
    for (let v = 0; v < m.mesh.weldedCount; v++)
      if (p[v * 3] > -0.02 && p[v * 3 + 1] < -0.1 && p[v * 3 + 1] >= 0.05 - width)
        if (Math.abs(p[v * 3 + 2]) <= 1.3) near.push(v);
    expect(near.length).toBeGreaterThan(100);
    expect(near.filter((v) => !kept.has(v))).toEqual([]);
  });
});

describe('automatic width on a coarse mesh', () => {
  it('keeps six edge lengths of flank past a wide rounding, over 1 mm', () => {
    // The e2e cylinder: radius 3, rims rounded 0.6, edges about 0.23 mm. An Arc on the rim crest.
    const model = modelOf(softCylinder(3, 1.5, 0.6, { step: 0.2, ripple: 0.04, noise: 0.008 }));
    const inset = 0.6 - 0.6 / Math.SQRT2;
    const points = [-0.9, 0, 0.9].map((a) =>
      pointOn(model.mesh, [(3 - inset) * Math.cos(a), 1.5 - inset, (3 - inset) * Math.sin(a)]),
    );
    const width = estimateWidth(model.mesh, model.topology, 'arc', points, model.noise);
    expect(width).toBeGreaterThan(1); // measured 1.70 (soft 0.32 + 6 x 0.23), as 1 is refused
    const input: EdgeInput = {
      segments: [{ kind: 'arc', points }],
      joints: [],
      closed: false,
      width: null,
      strength: 1,
    };
    const r = outcome(model, input);
    expect(r.solved && [r.pieces, r.skipped, r.folded]).toEqual([1, 0, 0]);
  });
});

describe('the automatic width and the classification it hands on', () => {
  it('judges the width on a classification that covers it', () => {
    const corner = (seed: number, radius = 0.08) =>
      modelOf(
        extrudedProfile(
          [
            [-2, 0],
            [0, 0],
            [0, -2],
          ],
          [radius],
          4,
          { ...scan, seed },
        ),
      );
    const cylinder = modelOf(softCylinder(3, 1.5, 0.6, { step: 0.2, ripple: 0.04, noise: 0.008 }));
    const inset = 0.6 - 0.6 / Math.SQRT2;
    const cases: { model: Model; kind: 'line' | 'arc'; points: Vec3[] }[] = [
      ...[1, 2, 3].flatMap((seed) =>
        [-0.02, -0.2].map((x) => ({
          model: corner(seed),
          kind: 'line' as const,
          points: [
            [x, 0, -1.4],
            [x, 0, 1.4],
          ] as Vec3[],
        })),
      ),
      // A rounding 0.45 mm in radius, the guide 0.15 mm off its crest: the width wanted, 0.79 mm,
      // lies past the 0.78 mm a classification read without a width covers (measured).
      {
        model: corner(1, 0.45),
        kind: 'line',
        points: [
          [-0.45 + 0.45 / Math.SQRT2 - 0.15, -0.45 + 0.45 / Math.SQRT2, -1.4],
          [-0.45 + 0.45 / Math.SQRT2 - 0.15, -0.45 + 0.45 / Math.SQRT2, 1.4],
        ],
      },
      {
        model: cylinder,
        kind: 'arc',
        points: [-0.9, 0, 0.9].map((a): Vec3 => [
          (3 - inset) * Math.cos(a),
          1.5 - inset,
          (3 - inset) * Math.sin(a),
        ]),
      },
    ];
    for (const { model, kind, points } of cases) {
      const guide = points.map((p) => pointOn(model.mesh, p));
      const { width, found } = estimateBand(model.mesh, model.topology, kind, guide, model.noise);
      expect(width).toBeGreaterThan(0);
      // `buildBand` reuses this classification for the solve, so the solve reads what was judged.
      expect(found!.gathered).toBeGreaterThanOrEqual(width);
      expect(found!.result(width)).not.toBeNull();
    }
  });
});
