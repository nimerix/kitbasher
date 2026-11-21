import { describe, expect, it, vi } from 'vitest';
import { type EdgeBand, buildBand, estimateBand, estimateWidth } from '../../src/core/refine-band';
import { drawnCurve } from '../../src/core/refine-curve';
import {
  type EdgeInput,
  applyEdge,
  fitMeet,
  largestGap,
  solveEdge,
} from '../../src/core/refine-edge';
import { cloneRefineMesh } from '../../src/core/refine-mesh';
import type { Vec3 } from '../../src/core/types';
import { chainPieces, modelFrom, modelOf, pointOn } from '../helpers/refine';
import { extrudedProfile, softBox, softCylinder, variedProfile } from '../helpers/soft-edges';

/** When `zones` is set, every band the solver builds moves and cuts by the zones its slices found. */
const found = vi.hoisted(() => ({ zones: false }));
vi.mock('../../src/core/refine-band', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/refine-band')>();
  return {
    ...actual,
    buildBand: (...args: Parameters<typeof actual.buildBand>) => {
      const band = actual.buildBand(...args);
      return band && found.zones ? { ...band, zone: band.foundZone } : band;
    },
  };
});

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

const deg = (d: number) => (d * Math.PI) / 180;
/** The point `length` mm from `from` at `angle` degrees in (x, y). */
const step = (from: [number, number], angle: number, length: number): [number, number] => [
  from[0] + Math.cos(deg(angle)) * length,
  from[1] + Math.sin(deg(angle)) * length,
];

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

/** The 90 degree edge along z at the origin, the top face at y = 0, rounded 0.08 mm. */
const corner = (seed = 1) =>
  modelOf(
    extrudedProfile(
      [
        [-2, 0],
        [0, 0],
        [0, -2],
      ],
      [0.08],
      4,
      { ...scan, seed },
    ),
  );

/** A guide on `corner`'s top face from 0.05 mm off the edge at z = -1.4 to 0.6 mm off at 1.4. */
const straying = (model: Model) => [
  pointOn(model.mesh, [-0.05, 0, -1.4]),
  pointOn(model.mesh, [-0.6, 0, 1.4]),
];

/**
 * Vertices of `corner`'s side face within the band's own width of the solved edge, along the
 * guide, that the band leaves out, and how many there are to leave out. Within means at most the
 * width less 0.05 mm below the corner: the rounding makes the way round it shorter than to the
 * corner and back.
 */
function sideLeftOut(model: Model, band: EdgeBand) {
  const kept = new Set(band.vertices);
  const p = model.mesh.position;
  const near: number[] = [];
  for (let v = 0; v < model.mesh.weldedCount; v++)
    if (p[v * 3] > -0.02 && p[v * 3 + 1] < -0.1 && p[v * 3 + 1] >= 0.05 - band.width)
      if (Math.abs(p[v * 3 + 2]) <= 1.3) near.push(v);
  return { near: near.length, left: near.filter((v) => !kept.has(v)) };
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
    const m = corner();
    const band = buildBand(m.mesh, m.topology, 'line', straying(m), 0.55, m.noise);
    expect(band).not.toBeNull();
    const { near, left } = sideLeftOut(m, band!);
    expect(near).toBeGreaterThan(100);
    expect(left).toEqual([]);
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

  it('holds a band asked past what its classification covers to that coverage', () => {
    // Past `gathered` the band could leave out vertices within the width of the solved edge, which
    // no gather reached: it comes back at the width it covers, and holds every vertex within that.
    for (const seed of [1, 2, 3]) {
      const model = corner(seed);
      const { found } = estimateBand(
        model.mesh,
        model.topology,
        'line',
        straying(model),
        model.noise,
      );
      const band = found!.result(found!.gathered + 0.3);
      expect(band).not.toBeNull();
      expect(band!.width).toBe(found!.gathered);
      const { near, left } = sideLeftOut(model, band!);
      expect(near).toBeGreaterThan(20);
      expect(left).toEqual([]);
    }
  });
});

describe('a path whose bands hold different widths', () => {
  // A spline along the top front crest of a 16 mm box to its right end, then along the right crest,
  // a sharp joint between them: the front band, past the slices at the box's end, covers only 0.267
  // of the 0.6 asked for (measured); the right one covers all of it.
  const path = () => {
    const model = modelOf(softBox([8, 2, 2], 0.3, { step: 0.04 }));
    const inset = 0.3 - 0.3 / Math.SQRT2;
    const front = [-8, -4, 0, 4, 8 - inset].map((x) =>
      pointOn(model.mesh, [x, 2 - inset, 2 - inset]),
    );
    const right = [2 - inset, 0, inset - 2].map((z) =>
      pointOn(model.mesh, [8 - inset, 2 - inset, z]),
    );
    const input: EdgeInput = {
      segments: [
        { kind: 'spline', points: front },
        { kind: 'spline', points: right },
      ],
      joints: ['sharp'],
      closed: false,
      width: 0.6,
      strength: 1,
    };
    return { model, solve: solveEdge(model.mesh, model.topology, input, model.noise)! };
  };

  it('solves each segment at its own band width, the path at the width asked for', () => {
    // Before, the whole path was solved at 0.267.
    const { solve } = path();
    expect(solve).not.toBeNull();
    expect(solve.bands[0].width).toBeLessThan(0.5);
    expect(solve.bands[1].width).toBe(0.6);
    expect(solve.width).toBe(0.6);
  }, 60_000);

  it('edits nothing outside both bands past the narrower band width from the joint', () => {
    // The joint takes in vertices no band holds out to the narrower of the two bands' widths. Before,
    // it reached the 0.6 asked for, and edited 5 such vertices from 0.27 to 0.49 mm from the joint
    // (measured; now the farthest is 0.20).
    const { model, solve } = path();
    const out = cloneRefineMesh(model.mesh, true);
    const { changed } = applyEdge(out, model.topology, solve, 1, true);
    const held = new Set(solve.bands.flatMap((band) => [...band.vertices]));
    // The joint, where the right crest's guide starts.
    const joint = solve.bands[1].drawn.points;
    const p = model.mesh.position;
    const narrower = Math.min(...solve.bands.map((band) => band.width));
    const outside = [...changed].filter(
      (v) =>
        v < model.mesh.weldedCount &&
        !held.has(v) &&
        Math.hypot(p[v * 3] - joint[0], p[v * 3 + 1] - joint[1], p[v * 3 + 2] - joint[2]) >
          narrower,
    );
    expect(outside).toEqual([]);
  }, 60_000);
});

describe('a band about slices that did not find the edge', () => {
  // A spline along the top front crest of a 16 mm box, out to its end faces: near each end the
  // slices find no flank of their own on either side (measured), and their solved offsets could lie
  // further from the guide than the band's coverage allowed for.
  const box = () => {
    const model = modelOf(softBox([8, 2, 2], 0.3, { step: 0.04 }));
    const inset = 0.3 - 0.3 / Math.SQRT2;
    const guide = [-8, -4, 0, 4, 8].map((x) => pointOn(model.mesh, [x, 2 - inset, 2 - inset]));
    const band = (width: number) =>
      buildBand(model.mesh, model.topology, 'spline', guide, width, model.noise)!;
    return { band };
  };

  it('holds every vertex within its width of the edge offset each slice uses', () => {
    const { band } = box();
    const small = band(0.5);
    const large = band(2.5);
    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    // Each vertex's distance from the small band's edge, read as membership reads it: its offset
    // across the guide less the edge's offset, interpolated between the two nearest slices.
    const slices = small.offset.length;
    const total = small.drawn.lengths[small.drawn.lengths.length - 1];
    const kept = new Set(small.vertices);
    let checked = 0;
    const left: number[] = [];
    for (let j = 0; j < large.vertices.length; j++) {
      const f = Math.min(
        slices - 1,
        Math.max(0, ((large.station[j] - total / 2) / total) * slices + (slices - 1) / 2),
      );
      const k = Math.min(slices - 2, Math.floor(f));
      const at = small.offset[k] * (1 - (f - k)) + small.offset[k + 1] * (f - k);
      if (Math.abs(large.cross[j] - at) > small.width - 1e-9) continue;
      checked++;
      if (!kept.has(large.vertices[j])) left.push(large.vertices[j]);
    }
    expect(checked).toBeGreaterThan(1000);
    expect(left).toEqual([]);
  }, 60_000);
});

describe('a narrow flank', () => {
  /**
   * A bead and groove border: a plate face from `plate` to the crest at (0, 0), fillet 0.10; a wall
   * falling at -50 degrees, fillet 0.08; a rise at 20 degrees for 0.35 mm, fillet 0.12; a fall at
   * -60 degrees for 1.2 mm. Length 6. `run` is the wall's straight length between its two fillets.
   */
  const border = (plate: [number, number], run: number) => {
    const tilt = (Math.atan2(-plate[1], -plate[0]) * 180) / Math.PI;
    const tangents = 0.1 * Math.tan(deg((50 + tilt) / 2)) + 0.08 * Math.tan(deg(35));
    const groove = step([0, 0], -50, run + tangents);
    const second = step(groove, 20, 0.35);
    return modelOf(
      extrudedProfile(
        [plate, [0, 0], groove, second, step(second, -60, 1.2)],
        [0.1, 0.08, 0.12],
        6,
        scan,
      ),
    );
  };
  const crestGuide = (model: Model, width: number | null, strength: number) =>
    line(model, [0, -0.02, -2.5], [0, -0.02, 2.5], width, strength);

  it('solves a groove wall of 0.20 to 0.30 mm straight run', () => {
    for (const plate of [[-2, 0] as [number, number], [-2, -0.8] as [number, number]])
      for (const run of [0.2, 0.22, 0.24, 0.26, 0.28, 0.3]) {
        const model = border(plate, run);
        for (const width of [null, 0.45]) {
          const r = outcome(model, crestGuide(model, width, 0.8));
          expect(
            r.solved && [r.pieces, r.skipped, r.folded],
            `plate ${plate}, run ${run}, width ${width ?? 'auto'}`,
          ).toEqual([1, 0, 0]);
        }
      }
  }, 60_000);

  /**
   * A 90 degree edge, fillet 0.08, with domes of radius 0.25 mm and height 0.10 mm on its top face
   * centred 0.35 mm from the corner at z = -0.9 and 0.9: each dome's foot is 0.10 mm from the
   * corner. A Line guide 3.4 mm long on the crest.
   */
  const rivets = () => {
    const lift = (x: number, y: number, z: number) => {
      if (y < -1e-6) return 0;
      return Math.max(
        ...[-0.9, 0.9].map((c) => {
          const d = Math.hypot(x + 0.35, z - c) / 0.25;
          return d >= 1 ? 0 : 0.1 * (1 - d * d) ** 2;
        }),
      );
    };
    const model = modelOf(
      variedProfile(
        () => [
          [-2, 0],
          [0, 0],
          [0, -2],
        ],
        [0.08],
        4,
        scan,
        0,
        lift,
      ),
    );
    const c = 0.08 - 0.08 / Math.SQRT2;
    return { model, guide: line(model, [-c, -c, -1.7], [-c, -c, 1.7], 0.5, 1) };
  };

  it('cuts in one piece past two rivets beside the edge and leaves them alone', () => {
    const { model, guide } = rivets();
    const r = outcome(model, guide);
    expect(r.solved && [r.pieces, r.skipped, r.folded]).toEqual([1, 0, 0]);
    expect(chainOff(r, [0, 0], 1)).toBeLessThan(0.02); // measured 0.007
    // Every vertex standing 0.03 mm or more above the top face stays where it stood: each rivet has
    // some.
    const standing = [0, 0];
    let rivetMove = 0;
    for (let v = 0; v < model.mesh.weldedCount; v++) {
      const [x, y, z] = [0, 1, 2].map((a) => model.mesh.position[v * 3 + a]);
      if (y < 0.03) continue;
      standing[z < 0 ? 0 : 1]++;
      if (r.solved)
        rivetMove = Math.max(
          rivetMove,
          Math.hypot(
            r.out.position[v * 3] - x,
            r.out.position[v * 3 + 1] - y,
            r.out.position[v * 3 + 2] - z,
          ),
        );
    }
    expect(standing[0]).toBeGreaterThan(0);
    expect(standing[1]).toBeGreaterThan(0);
    expect(rivetMove).toBe(0);
  });

  /** The level border with the wall's straight run 0.30 mm, narrowing to `low` round each dip. */
  const narrowing = (low: number, dips: number[]) => {
    const tangents = 0.1 * Math.tan(deg(25)) + 0.08 * Math.tan(deg(35));
    // Each dip is 0.4 mm long at `low`, with 0.2 mm ramps either side.
    const runAt = (z: number) => {
      let run = 0.3;
      for (const c of dips) {
        const d = Math.abs(z - c);
        const f = d <= 0.2 ? 1 : d >= 0.4 ? 0 : (0.4 - d) / 0.2;
        run = Math.min(run, 0.3 + (low - 0.3) * f);
      }
      return run;
    };
    const model = modelOf(
      variedProfile(
        (z) => {
          const groove = step([0, 0], -50, runAt(z) + tangents);
          const second = step(groove, 20, 0.35);
          return [[-2, 0], [0, 0], groove, second, step(second, -60, 1.2)];
        },
        [0.1, 0.08, 0.12],
        6,
        scan,
        1.8,
      ),
    );
    return { model, guide: crestGuide(model, 0.45, 0.8) };
  };

  it('cuts in one piece along a wall that narrows in two places, and in four', () => {
    // Dips to 0.06 mm of straight run at z = -1.0 and 0.9, and at z = -1.5, -0.5, 0.5 and 1.5.
    for (const dips of [
      [-1.0, 0.9],
      [-1.5, -0.5, 0.5, 1.5],
    ]) {
      const { model, guide } = narrowing(0.06, dips);
      const r = outcome(model, guide);
      expect(r.solved && [r.pieces, r.skipped, r.folded]).toEqual([1, 0, 0]);
    }
  });

  it('refuses a wall that has its own flank in fewer than half of the slices', () => {
    // Five dips, at z = -2, -1, 0, 1 and 2.
    const { model, guide } = narrowing(0.06, [-2, -1, 0, 1, 2]);
    expect(outcome(model, guide).solved).toBe(false);
  });

  it('changes nothing visible when run again over a narrow wall', () => {
    // Two limits: the second pass shifts a few cut-line vertices near the guide's free ends by about
    // 0.01 (measured 0.0106 at z = 2.33), as it did before filling (0.006 to 0.009 on the runs that
    // solved then), and filling plays no part. Away from the ends it moves 0.0028 at most (measured).
    const model = border([-2, 0], 0.24);
    const first = outcome(model, crestGuide(model, 0.45, 1));
    expect(first.solved && [first.pieces, first.skipped, first.folded]).toEqual([1, 0, 0]);
    if (!first.solved) return;
    const again = modelFrom(first.out);
    const second = outcome(again, crestGuide(again, 0.45, 1));
    expect(second.solved && [second.pieces, second.skipped, second.folded]).toEqual([1, 0, 0]);
    if (!second.solved) return;
    const p = again.mesh.position,
      q = second.out.position;
    let inner = 0;
    for (let v = 0; v < again.mesh.weldedCount; v++)
      if (Math.abs(p[v * 3 + 2]) <= 2)
        inner = Math.max(
          inner,
          Math.hypot(q[v * 3] - p[v * 3], q[v * 3 + 1] - p[v * 3 + 1], q[v * 3 + 2] - p[v * 3 + 2]),
        );
    expect(inner).toBeLessThan(0.005);
    expect(second.max).toBeLessThan(0.02);
  });

  it('fits, orients and decides its ends from the zones its slices found', () => {
    // Filling a slice changes only what is moved and cut: the solve is the one its bands would give
    // with their filled zones replaced by the zones their slices found.
    for (const { model, guide } of [rivets(), narrowing(0.06, [-1.0, 0.9])]) {
      const { points } = guide.segments[0];
      const band = buildBand(model.mesh, model.topology, 'line', points, guide.width!, model.noise);
      expect(band!.zone.some((z, i) => z !== band!.foundZone[i])).toBe(true);
      const filled = solveEdge(model.mesh, model.topology, guide, model.noise)!;
      found.zones = true;
      const unfilled = solveEdge(model.mesh, model.topology, guide, model.noise)!;
      found.zones = false;
      expect(filled).not.toBeNull();
      expect(unfilled).not.toBeNull();
      expect(Array.from(filled.curve.points)).toEqual(Array.from(unfilled.curve.points));
      expect(filled.deviation).toBe(unfilled.deviation);
      expect(Array.from(filled.sign)).toEqual(Array.from(unfilled.sign));
      expect(filled.ends).toEqual(unfilled.ends);
    }
  });
});

describe('a rivet close to the edge', () => {
  /**
   * A 90 degree edge along z, fillet 0.08, with domes of radius 0.25 mm and height `height` on one
   * face centred at z = -0.9 and 0.9, their feet `foot` mm from the ideal corner. Convex: the top
   * face at y = 0 and a side face falling from it, the domes on the top. Concave: a floor at y = 0
   * and a wall rising from it, the domes on the floor. A Line guide 3.4 mm long on the fillet's
   * crest, Width 0.5, full strength.
   */
  const rivets = (seed: number, foot: number, height: number, concave = false) => {
    const centre = -(0.25 + foot);
    const lift = (x: number, y: number, z: number) => {
      if (concave ? y > 1e-6 : y < -1e-6) return 0;
      return Math.max(
        ...[-0.9, 0.9].map((c) => {
          const d = Math.hypot(x - centre, z - c) / 0.25;
          return d >= 1 ? 0 : height * (1 - d * d) ** 2;
        }),
      );
    };
    const fall = concave ? 2 : -2;
    const model = modelOf(
      variedProfile(
        () => [
          [-2, 0],
          [0, 0],
          [0, fall],
        ],
        [0.08],
        4,
        { ...scan, seed },
        0,
        lift,
      ),
    );
    const c = 0.08 - 0.08 / Math.SQRT2;
    const y = concave ? c : -c;
    return { model, guide: line(model, [-c, y, -1.7], [-c, y, 1.7], 0.5, 1) };
  };
  /**
   * The largest move of a vertex standing 0.03 mm or more off the face the domes are on: above
   * y = 0.03, and on a concave edge more than 0.09 mm out from the wall, past the fillet.
   */
  const rivetMove = (model: Model, r: ReturnType<typeof outcome>, concave = false) => {
    if (!r.solved) return NaN;
    const p = model.mesh.position;
    let worst = 0;
    for (let v = 0; v < model.mesh.weldedCount; v++) {
      if (!(p[v * 3 + 1] >= 0.03) || (concave && !(p[v * 3] < -0.09))) continue;
      worst = Math.max(
        worst,
        Math.hypot(
          r.out.position[v * 3] - p[v * 3],
          r.out.position[v * 3 + 1] - p[v * 3 + 1],
          r.out.position[v * 3 + 2] - p[v * 3 + 2],
        ),
      );
    }
    return worst;
  };

  it('leaves rivets beside a convex edge where they stand', () => {
    // Before, filled slices moved rivets up to 0.103 (foot 0.02, height 0.1) and a slice's own
    // classification moved them up to 0.064 (foot 0.02, height 0.05), as it did before slices were
    // filled. Now every rivet vertex standing 0.03 mm or more off the face stays exactly where it
    // stood, and every cut is in 1 piece with nothing skipped or folded (measured). Feet 0.005 are
    // the two-rivet fixture with its domes centred 0.255 mm from the corner.
    const cases = [0.02, 0.04, 0.06].flatMap((foot) => [0.05, 0.1].map((height) => [foot, height]));
    for (const seed of [1, 2, 3, 4])
      for (const [foot, height] of [...cases, [0.005, 0.1]]) {
        const { model, guide } = rivets(seed, foot, height);
        const r = outcome(model, guide);
        const label = `seed ${seed}, foot ${foot}, height ${height}`;
        expect(r.solved && [r.skipped, r.folded], label).toEqual([0, 0]);
        expect(rivetMove(model, r), label).toBe(0);
      }
  }, 60_000);

  it('leaves rivets beside a concave edge where filling would have moved them', () => {
    // Before, filled slices moved rivets with feet 0.02 mm from the corner by up to 0.103, and with
    // feet 0.06 by up to 0.053. Now every cut is in 1 piece with nothing skipped or folded, and no
    // rivet vertex standing 0.03 mm or more off the floor moves, except on seed 3 at foot 0.02: its
    // own slices find the rivet's edge as rounding and move it 0.0082, as before slices were filled
    // (measured on both).
    for (const seed of [1, 2, 3, 4])
      for (const foot of [0.02, 0.06, 0.1, 0.2])
        for (const height of foot === 0.02 ? [0.1] : [0.05, 0.1]) {
          const { model, guide } = rivets(seed, foot, height, true);
          const r = outcome(model, guide);
          const label = `seed ${seed}, foot ${foot}, height ${height}`;
          expect(r.solved && [r.skipped, r.folded], label).toEqual([0, 0]);
          if (foot === 0.02) expect(rivetMove(model, r, true), label).toBeLessThan(0.01);
          else expect(rivetMove(model, r, true), label).toBe(0);
        }
  }, 60_000);
});

/**
 * The largest distance of the chain over the middle half of a guide along `axis` from -1.6 to 1.6,
 * in the chain's own order, from the line through its two end vertices. NaN when fewer than three
 * chain vertices lie there.
 */
function straightness(result: ReturnType<typeof outcome>, axis: number) {
  if (!result.solved) return NaN;
  const middle = result.chain
    .map((v) => [0, 1, 2].map((a) => result.out.position[v * 3 + a]))
    .filter((p) => Math.abs(p[axis]) <= 0.8);
  if (middle.length < 3) return NaN;
  const [a, b] = [middle[0], middle[middle.length - 1]];
  const d = [0, 1, 2].map((k) => b[k] - a[k]);
  const length = Math.hypot(...d);
  let worst = 0;
  for (const p of middle) {
    const e = [0, 1, 2].map((k) => p[k] - a[k]);
    const along = (e[0] * d[0] + e[1] * d[1] + e[2] * d[2]) / length;
    worst = Math.max(worst, Math.sqrt(Math.max(0, e[0] ** 2 + e[1] ** 2 + e[2] ** 2 - along ** 2)));
  }
  return worst;
}

describe('a line over an edge that curves', () => {
  it('follows the rim of a cylinder of radius 5', () => {
    const model = modelOf(softCylinder(5, 1, 0.15, scan));
    // Two points on the rim's crest 3.4 mm apart: the chord sags 0.29 mm inside the rim.
    const inset = 0.15 - 0.15 / Math.SQRT2;
    const half = Math.asin(1.7 / 5);
    const at = (angle: number): Vec3 => [
      (5 - inset) * Math.cos(angle),
      1 - inset,
      (5 - inset) * Math.sin(angle),
    ];
    const r = outcome(model, line(model, at(-half), at(half), 0.52, 0.65));
    expect(r.solved && [r.pieces, r.skipped, r.folded]).toEqual([1, 0, 0]);
    if (!r.solved) return;
    expect(r.deviation).toBeLessThan(0.01); // measured 0.0001
    // Every chain vertex over the middle half of the guide lies on the rim.
    let seen = 0,
      worst = 0;
    for (const v of r.chain) {
      const [x, , z] = [0, 1, 2].map((a) => r.out.position[v * 3 + a]);
      if (Math.abs(Math.atan2(z, x)) > half / 2) continue;
      seen++;
      worst = Math.max(worst, Math.abs(Math.hypot(x, z) - 5));
    }
    expect(seen).toBeGreaterThan(0);
    expect(worst).toBeLessThan(0.03); // measured 0.023
  });

  it('follows the rim along a path of two lines, at a smooth joint and a sharp one', () => {
    // Each line follows the rim as an arc through the refits at its joint and the join itself: with
    // either left a line, the chain lies 0.08 from the rim and, at the sharp joint, folds.
    const model = modelOf(softCylinder(5, 1, 0.15, scan));
    const inset = 0.15 - 0.15 / Math.SQRT2;
    const half = Math.asin(1.7 / 5);
    const [a, b, c] = [-1.5 * half, 0.25 * half, 2 * half].map((angle) =>
      pointOn(model.mesh, [
        (5 - inset) * Math.cos(angle),
        1 - inset,
        (5 - inset) * Math.sin(angle),
      ]),
    );
    for (const joint of ['smooth', 'sharp'] as const) {
      const r = outcome(model, {
        segments: [
          { kind: 'line', points: [a, b] },
          { kind: 'line', points: [b, c] },
        ],
        joints: [joint],
        closed: false,
        width: 0.52,
        strength: 0.65,
      });
      expect(r.solved && [r.pieces, r.skipped, r.folded], joint).toEqual([1, 0, 0]);
      if (!r.solved) continue;
      expect(r.deviation, joint).toBeLessThan(0.01); // measured 0.0001
      // Every chain vertex clear of the path's free ends lies on the rim.
      let seen = 0,
        worst = 0;
      for (const v of r.chain) {
        const [x, , z] = [0, 1, 2].map((k) => r.out.position[v * 3 + k]);
        const angle = Math.atan2(z, x);
        if (angle < -0.9 * half || angle > 1.4 * half) continue;
        seen++;
        worst = Math.max(worst, Math.abs(Math.hypot(x, z) - 5));
      }
      expect(seen, joint).toBeGreaterThan(0);
      expect(worst, joint).toBeLessThan(0.04); // measured 0.032 smooth, 0.031 sharp
    }
  });

  /** A point on the crest of softCylinder(5, 1, 0.15)'s top rim at `angle` radians about y. */
  const rimPoint = (mesh: Model['mesh'], angle: number) => {
    const inset = 0.15 - 0.15 / Math.SQRT2;
    return pointOn(mesh, [(5 - inset) * Math.cos(angle), 1 - inset, (5 - inset) * Math.sin(angle)]);
  };
  /** Largest distance from radius 5 of the chain vertices from angle `from` to `to`, and how many. */
  const offRim = (result: ReturnType<typeof outcome>, from: number, to: number) => {
    if (!result.solved) return { worst: NaN, seen: 0 };
    let worst = 0,
      seen = 0;
    for (const v of result.chain) {
      const [x, , z] = [0, 1, 2].map((k) => result.out.position[v * 3 + k]);
      const angle = Math.atan2(z, x);
      if (angle < from || angle > to) continue;
      seen++;
      worst = Math.max(worst, Math.abs(Math.hypot(x, z) - 5));
    }
    return { worst, seen };
  };

  it('follows the rim along a line between two joints', () => {
    // Three lines along the rim: the middle one, 3.4 mm, is fitted as an arc; the two beside it, 1.4
    // and 1.7 mm, sag too little from the rim to be (measured).
    const model = modelOf(softCylinder(5, 1, 0.15, scan));
    const half = Math.asin(1.7 / 5);
    const p = [-1.8 * half, -half, half, 2 * half].map((angle) => rimPoint(model.mesh, angle));
    for (const joint of ['smooth', 'sharp'] as const) {
      const r = outcome(model, {
        segments: [0, 1, 2].map((i) => ({ kind: 'line' as const, points: [p[i], p[i + 1]] })),
        joints: [joint, joint],
        closed: false,
        width: 0.52,
        strength: 0.65,
      });
      expect(r.solved && [r.pieces, r.skipped, r.folded], joint).toEqual([1, 0, 0]);
      if (!r.solved) continue;
      expect(chainPieces(r.out, Uint32Array.from(r.chain)), joint).toEqual([
        { size: r.chain.length, ends: 2 },
      ]);
      // Along the middle line and across both joints the chain lies on the rim: measured 0.023 along
      // the middle, 0.027 and 0.028 across the joints, at either kind of joint.
      for (const [from, to] of [
        [-1.3 * half, -0.7 * half],
        [-half, half],
        [0.7 * half, 1.3 * half],
      ]) {
        const { worst, seen } = offRim(r, from, to);
        expect(seen, `${joint} ${from}`).toBeGreaterThan(10);
        expect(worst, `${joint} ${from}`).toBeLessThan(0.04);
      }
    }
  });

  it('ties a line along the rim to the edge restored before it', () => {
    // An arc restored first along the rim, held at its start; then a line, fitted as an arc, drawn
    // from the far side up to where that arc starts.
    const model = modelOf(softCylinder(5, 1, 0.15, scan));
    const half = Math.asin(1.7 / 5);
    const earlier = outcome(model, {
      segments: [{ kind: 'arc', points: [1, 1.8, 2.6].map((k) => rimPoint(model.mesh, k * half)) }],
      joints: [],
      closed: false,
      width: 0.52,
      strength: 1,
      ends: ['hold', 'taper'],
    });
    expect(earlier.solved && [earlier.pieces, earlier.skipped, earlier.folded]).toEqual([1, 0, 0]);
    if (!earlier.solved) return;
    const after = modelFrom(earlier.out);
    const creased: number[] = [];
    for (let v = 0; v < after.mesh.weldedCount; v++) if (after.mesh.crease[v]) creased.push(v);
    expect(creased.length).toBeGreaterThan(20);
    const input: EdgeInput = {
      segments: [
        { kind: 'line', points: [rimPoint(after.mesh, -half), rimPoint(after.mesh, half)] },
      ],
      joints: [],
      closed: false,
      width: 0.52,
      strength: 0.65,
    };
    const solve = solveEdge(after.mesh, after.topology, input, after.noise);
    expect(solve?.ends).toEqual(['taper', 'hold']);
    const r = outcome(after, input);
    expect(r.solved && [r.pieces, r.skipped, r.folded]).toEqual([1, 0, 0]);
    if (!r.solved) return;
    // The new chain runs into the earlier one, which goes on from it without a branch or a second
    // line beside it.
    const both = Uint32Array.from(new Set([...r.chain, ...creased]));
    expect(chainPieces(r.out, both)).toEqual([{ size: both.length, ends: 2 }]);
    // Where they meet the chain lies on the rim: measured 0.031.
    const { worst, seen } = offRim(r, 0.7 * half, 1.3 * half);
    expect(seen).toBeGreaterThan(10);
    expect(worst).toBeLessThan(0.04);
    // A tie takes in the earlier edge's creased vertices out to the band's width from the tie, so
    // the new chain goes on along the earlier crease that far. It did so before lines were fitted as
    // arcs: an Arc guide over this rim gives the same chain past the tie at eb6c2e8.
    const p = r.out.position;
    const angle = (v: number) => Math.atan2(p[v * 3 + 2], p[v * 3]);
    // Distance from the tie, on the rim's sharp edge at radius 5 and height 1.
    const fromTie = (v: number) =>
      Math.hypot(
        p[v * 3] - 5 * Math.cos(half),
        p[v * 3 + 1] - 1,
        p[v * 3 + 2] - 5 * Math.sin(half),
      );
    // The edge length as the solver reads it: the median length of the mesh edges at the band's
    // vertices.
    const q = after.mesh.position;
    const lengths: number[] = [];
    for (const v of solve!.bands[0].vertices)
      for (
        let j = after.topology.neighbourStart[v];
        j < after.topology.neighbourStart[v + 1];
        j++
      ) {
        const w = after.topology.neighbours[j];
        lengths.push(
          Math.hypot(q[v * 3] - q[w * 3], q[v * 3 + 1] - q[w * 3 + 1], q[v * 3 + 2] - q[w * 3 + 2]),
        );
      }
    const edge = lengths.sort((a, b) => a - b)[lengths.length >> 1];
    const onCrease = new Set(creased);
    const start = creased.reduce((a, b) => (angle(a) <= angle(b) ? a : b));
    const past = r.chain.filter((v) => angle(v) > half);
    const bridging = past.filter((v) => !onCrease.has(v));
    const gap = (v: number) => Math.hypot(...[0, 1, 2].map((k) => p[v * 3 + k] - p[start * 3 + k]));
    // Past the tie the new chain keeps to the earlier crease: 14 of its 16 vertices there are the
    // crease's own, and the other 2 bridge to where the crease starts, 0.111 and 0.057 from it, within
    // two edge lengths of 0.067 (measured).
    expect(past.length - bridging.length).toBeGreaterThan(0);
    for (const v of bridging) expect(gap(v)).toBeLessThanOrEqual(2 * edge);
    // It reaches no farther past the tie than the band's width: measured 0.507 at width 0.52.
    expect(Math.max(...past.map(fromTie))).toBeLessThanOrEqual(solve!.bands[0].width);
  });

  it('stays a line on a straight edge of a rippled, noisy box', () => {
    const c = 0.3 - 0.3 / Math.SQRT2;
    for (const seed of [1, 2, 3, 4]) {
      const model = modelOf(
        softBox([2, 1.5, 1], 0.3, { step: 0.06, ripple: 0.02, noise: 0.01, seed }),
      );
      const r = outcome(model, line(model, [-1.6, 1.5 - c, 1 - c], [1.6, 1.5 - c, 1 - c], null));
      expect(r.solved, `seed ${seed}`).toBe(true);
      if (!r.solved) continue;
      // Measured under 0.0001 on every seed: the flanks fit as planes, which meet in a line.
      expect(straightness(r, 0), `seed ${seed}`).toBeLessThan(0.02);
    }
  });
  it('stays a line on a straight edge between two faces that twist along it', () => {
    // A 90 degree edge along z, rounded 0.08, whose two faces tilt by up to 0.2 radians and back
    // along it: neither is one shape, so each is fitted with a profile per slice, and where they
    // meet scatters about the edge. The line misses that meet by 0.0097 to 0.0171 on these seeds
    // (measured), against an edge length of 0.061.
    for (const seed of [1, 2, 3, 4]) {
      const model = modelOf(
        variedProfile(
          (z) => {
            const t = Math.tan(0.2 * Math.sin((Math.PI * z) / 2));
            return [
              [-2, 2 * t],
              [0, 0],
              [2 * t, -2],
            ];
          },
          [0.08],
          4,
          { step: 0.06, ripple: 0.02, noise: 0.01, seed },
        ),
      );
      const r = outcome(model, line(model, [-0.02, -0.02, -1.6], [-0.02, -0.02, 1.6], null));
      expect(r.solved && [r.pieces, r.skipped, r.folded], `seed ${seed}`).toEqual([1, 0, 0]);
      if (!r.solved) continue;
      expect(r.fits, `seed ${seed}`).toBe('profile/profile');
      expect(r.deviation, `seed ${seed}`).toBeLessThan(0.03);
      expect(straightness(r, 2), `seed ${seed}`).toBeLessThan(0.02); // measured under 0.0001
    }
  });
});

describe("the meet's largest gap from its curve", () => {
  it('is zero over an exactly straight interior, whatever lies in the end tapers', () => {
    // A guide 4 mm along x, edge length 0.06: each end taper is 0.5 mm. The meet lies on the guide
    // from x = 1 to 3, with one point 0.3 mm off it 0.1 mm from the start.
    const guide = drawnCurve('line', [0, 0, 0, 4, 0, 0], 0.06);
    const points = [0.1, 0.3, 0, ...[1, 1.5, 2, 2.5, 3].flatMap((x) => [x, 0, 0])];
    expect(largestGap(guide, guide, points, 0.06)).toBe(0);
    // With nothing clear of the tapers, the gap is the largest of them all.
    expect(largestGap(guide, guide, [0.1, 0.3, 0, 3.9, 0, 0], 0.06)).toBeCloseTo(0.3, 9);
  });
});

describe('the kind a meet is fitted as', () => {
  // Meets 3.4 mm long along x, with a guide drawn straight between their ends, edge length 0.067.
  const edge = 0.067;
  /** `count` points on a circle of `radius` through (+-1.7, 0, 0), bowing toward +z. */
  const rim = (count: number, radius = 5) => {
    const half = Math.asin(1.7 / radius);
    return Array.from({ length: count }, (_, i) => {
      const angle = -half + (2 * half * i) / (count - 1);
      return [radius * Math.sin(angle), 0, radius * Math.cos(angle) - radius * Math.cos(half)];
    }).flat();
  };
  const decide = (kind: 'line' | 'arc' | 'spline', points: number[]) => {
    const n = points.length;
    const drawn = drawnCurve('line', [...points.slice(0, 3), ...points.slice(n - 3)], 0.06);
    return fitMeet(kind, drawn, points, 2, edge).kind;
  };

  it('fits a Line guide whose meet follows a circle as an arc, from nine points', () => {
    // On radius 5 the line misses the meet by 0.12 and the arc by 0.0001 (measured).
    expect(decide('line', rim(13))).toBe('arc');
    expect(decide('line', rim(9))).toBe('arc');
    expect(decide('line', rim(8))).toBe('line');
  });

  it('keeps a line where the meet scatters about a straight line by under an edge length', () => {
    // The line misses it by 0.043 (measured).
    const points = Array.from({ length: 13 }, (_, i) => [
      -1.7 + (3.4 * i) / 12,
      0,
      i % 2 ? 0.04 : -0.04,
    ]).flat();
    expect(decide('line', points)).toBe('line');
  });

  it('keeps a line where the meet bows from it by under an edge length', () => {
    // On radius 15 the line misses the meet by 0.038 (measured), though an arc follows it.
    expect(decide('line', rim(13, 15))).toBe('line');
  });

  it('keeps a line where the meet bends but an arc follows it hardly better', () => {
    // Flat along the middle, turning up steeply near the ends: the line misses it by 0.090 and the
    // arc that fits by 0.078 (measured), not half as much.
    const points = Array.from({ length: 25 }, (_, i) => {
      const x = -1.7 + (3.4 * i) / 24;
      return [x, 0, -0.5 * (x / 1.7) ** 6];
    }).flat();
    expect(decide('line', points)).toBe('line');
  });

  it('keeps a line where the arc that fits closes on itself', () => {
    // A meet all the way round a circle of radius 1, as a line drawn across it.
    const points = Array.from({ length: 48 }, (_, i) => {
      const angle = (2 * Math.PI * i) / 48;
      return [Math.cos(angle), 0, Math.sin(angle)];
    }).flat();
    expect(decide('line', points)).toBe('line');
  });
});

describe('a wide rounding', () => {
  /** A fin edge: a flat face, a 0.27 mm round and an edge face 0.25 mm wide, along z. */
  const fin = () => {
    const back = step([0, 0], -95, 0.25 + 0.295 + 0.227);
    const end = step(back, -175, 1.5);
    return modelOf(extrudedProfile([[-2, 0], [0, 0], back, end], [0.27, 0.27], 4, scan));
  };

  it('finds a fin edge across a 0.27 mm round', () => {
    const model = fin();
    // This guide already solved before flank seeds could start past the reach.
    // The guide lies where the round leaves the flat face, 0.295 mm before the ideal corner.
    const r = outcome(model, line(model, [-0.295, 0, -1.1], [-0.295, 0, 1.1], 0.48, 0.65));
    expect(r.solved && [r.pieces, r.skipped, r.folded]).toEqual([1, 0, 0]);
    if (!r.solved) return;
    expect(r.angle).toBeGreaterThan(90);
    expect(r.angle).toBeLessThan(99); // measured 94.5
    expect(chainOff(r, [0, 0], 0.5)).toBeLessThan(0.07); // measured 0.05
  });

  it('finds a fin edge from 0.4 mm onto the flat face, its far flank past the reach', () => {
    const model = fin();
    // The edge face starts past the reach of a guide 0.4 mm before the ideal corner: its seed must
    // start farther out than the reach for the guide to find the edge.
    const r = outcome(model, line(model, [-0.4, 0, -1.1], [-0.4, 0, 1.1], 0.48, 0.65));
    expect(r.solved && [r.pieces, r.skipped, r.folded]).toEqual([1, 0, 0]);
    if (!r.solved) return;
    expect(r.angle).toBeGreaterThan(90);
    expect(r.angle).toBeLessThan(99); // measured 94.8
    expect(chainOff(r, [0, 0], 0.5)).toBeLessThan(0.07); // measured 0.0517
  });

  it('keeps the edge it finds from seeds within reach over one past a wide rounding', () => {
    // A face with a 90 degree edge rounded 0.04 at x = near and a 60 degree edge rounded 0.35 at
    // x = 0. The guide lies 0.25 mm from the first edge and 0.12 mm before the second's round. Its
    // own face and the side face past the first edge seed within reach; the face past the round
    // seeds only from past the reach. Both edges meet within reach, and the guide's face on both
    // sides is no pair, so the two pairs left tie in the order they are tried.
    const round = 0.35 * Math.tan(deg(30));
    const back = step([0, 0], -60, round + 0.25 + 0.227);
    const end = step(back, -140, 1.5);
    const x = -(round + 0.12),
      near = x - 0.25;
    for (const seed of [1, 2, 3]) {
      const profile = extrudedProfile(
        [[near, -2], [near, 0], [0, 0], back, end],
        [0.04, 0.35, 0.27],
        4,
        {
          ...scan,
          seed,
        },
      );
      const model = modelOf(profile);
      for (const from of [-1.1, 1.1]) {
        const r = outcome(model, line(model, [x, 0, from], [x, 0, -from], 0.48, 0.65));
        const label = `seed ${seed}, from z = ${from}`;
        expect(r.solved && [r.pieces, r.skipped, r.folded], label).toEqual([1, 0, 0]);
        if (!r.solved) continue;
        // Measured 91.1 to 91.5 degrees and 0.0099 to 0.011 mm; the 60 degree edge is 0.57 mm away.
        expect(r.angle, label).toBeGreaterThan(85);
        expect(r.angle, label).toBeLessThan(95);
        expect(chainOff(r, [near, 0], 0.5), label).toBeLessThan(0.05);
      }
    }
  });

  it('still refuses 1.2 mm onto the flat face', () => {
    const model = fin();
    const r = outcome(model, line(model, [-1.2, 0, -1.1], [-1.2, 0, 1.1], 0.48, 0.65));
    expect(r.solved).toBe(false);
  });

  it('still refuses a line and an arc on a cylinder wall', () => {
    // A cylinder wall of radius 3 has no edge.
    const model = modelOf(softCylinder(3, 2, 0.3, scan));
    const wall = line(model, [3, -1, 0], [3, 1, 0], null);
    const round: EdgeInput = {
      segments: [
        {
          kind: 'arc',
          points: [-0.4, 0, 0.4].map((a) =>
            pointOn(model.mesh, [3 * Math.cos(a), 0, 3 * Math.sin(a)]),
          ),
        },
      ],
      joints: [],
      closed: false,
      width: 0.5,
      strength: 1,
    };
    expect(outcome(model, wall).solved).toBe(false);
    expect(outcome(model, round).solved).toBe(false);
  });
});
