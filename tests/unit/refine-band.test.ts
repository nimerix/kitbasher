import { describe, expect, it } from 'vitest';
import {
  BandZone,
  type EdgeBand,
  type GuidePoint,
  buildBand,
  estimateWidth,
} from '../../src/core/refine-band';
import { type RefineMesh, weldedCorner } from '../../src/core/refine-mesh';
import type { Vec3 } from '../../src/core/types';
import {
  countWhere,
  flankOverTolerance,
  maxZoneDistance,
  modelOf,
  pointOn,
  polylineGap,
  zoneCount,
} from '../helpers/refine';
import {
  bulgedBox,
  extrudedProfile,
  foldedStrip,
  heightField,
  rippledSphere,
  softBox,
  softCylinder,
  softStep,
  taperedBox,
  turnedPoint,
  turnedProfile,
} from '../helpers/soft-edges';

/** How far a 0.3 mm fillet's crest sits in from each face. */
const crest = 0.3 - 0.3 / Math.SQRT2;
const edgeGuide = (mesh: RefineMesh, x0: number, x1: number) => {
  // The fillet's crest on the box edge y = 1.5, z = 1.
  return [pointOn(mesh, [x0, 1.5 - crest, 1 - crest]), pointOn(mesh, [x1, 1.5 - crest, 1 - crest])];
};
/**
 * Flanks reach a 0.3 mm fillet where it lies within 3 * local of its face, 0.3 (1 - cos a) = 3 * local,
 * so the soft half-width from the solved edge's crest is 0.3 sin(45 deg - a). Local is the flank fit's
 * robust residual scale, measured at 1.0 to 1.11 * noise on these fixtures, so it is taken as noise.
 */
const filletSoft = (noise: number) => 0.3 * Math.sin(Math.PI / 4 - Math.acos(1 - noise / 0.1));
/**
 * Flank vertices lie within 3 * local of their fit, at most 3 * 1.11 * noise = 0.029 mm on these
 * fixtures, and the fit lies within about 0.006 of the true face.
 */
const flankBound = 0.036;
/** Guide on the box's fillet, `offset` mm along the arc from the crest toward the face z = 1. */
const arcGuide = (mesh: RefineMesh, ends: number[], offset = 0) =>
  ends.map((x) => {
    const angle = Math.PI / 4 + offset / 0.3;
    return pointOn(mesh, [x, 1.2 + 0.3 * Math.cos(angle), 0.7 + 0.3 * Math.sin(angle)]);
  });
/** Mean length of the edges at the clicked triangles' corners. */
function clickedEdge(
  mesh: RefineMesh,
  topology: ReturnType<typeof modelOf>['topology'],
  guide: GuidePoint[],
) {
  let sum = 0,
    count = 0;
  for (const { triangle } of guide)
    for (const k of [0, 1, 2] as const) {
      const v = weldedCorner(mesh, triangle, k);
      for (let j = topology.neighbourStart[v]; j < topology.neighbourStart[v + 1]; j++) {
        const w = topology.neighbours[j];
        sum += Math.hypot(
          ...[0, 1, 2].map((a) => mesh.position[v * 3 + a] - mesh.position[w * 3 + a]),
        );
        count++;
      }
    }
  return sum / count;
}
const softZones = [BandZone.Soft, BandZone.Left, BandZone.Right];

/** The guide reversed must swap Left and Right and negate `cross`, and change nothing else. */
function expectMirrored(forward: EdgeBand, backward: EdgeBand) {
  expect(Array.from(backward.vertices)).toEqual(Array.from(forward.vertices));
  const swap = [BandZone.Soft, BandZone.Right, BandZone.Left, BandZone.Beyond];
  expect(Array.from(backward.zone)).toEqual(Array.from(forward.zone, (z) => swap[z]));
  expect(backward.soft).toBeCloseTo(forward.soft, 6);
  expect(backward.fits).toEqual([forward.fits[1], forward.fits[0]]);
  const length = forward.drawn.lengths[forward.drawn.lengths.length - 1];
  for (let i = 0; i < forward.vertices.length; i++) {
    expect(backward.cross[i]).toBeCloseTo(-forward.cross[i], 5);
    expect(backward.station[i]).toBeCloseTo(length - forward.station[i], 5);
  }
}

describe('buildBand', () => {
  it('finds the softened zone and both flanks of a box edge', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const band = buildBand(mesh, topology, 'line', edgeGuide(mesh, -1.2, 1.2), 0.6, noise)!;
    // Flanks fit within 3 * local = 3 * 0.0086 of each face, 0.3 (1 - cos a) = 0.026 at a = 23.9 deg,
    // so the soft half-width is 0.3 sin(45 - 23.9 deg) = 0.108, +-1/3.
    expect(band.soft).toBeGreaterThan(0.072);
    expect(band.soft).toBeLessThan(0.144);
    expect(zoneCount(band, BandZone.Left)).toBeGreaterThan(50);
    expect(zoneCount(band, BandZone.Right)).toBeGreaterThan(50);
    // Drawn along +x, Left (normal x tangent) is the face y = 1.5 and Right the face z = 1.
    expect(maxZoneDistance(mesh, band, BandZone.Left, (p) => Math.abs(p[1] - 1.5))).toBeLessThan(
      flankBound,
    );
    expect(maxZoneDistance(mesh, band, BandZone.Right, (p) => Math.abs(p[2] - 1))).toBeLessThan(
      flankBound,
    );
  });

  it('returns null on a flat face', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const flat = [pointOn(mesh, [-1, 1.5, 0]), pointOn(mesh, [1, 1.5, 0])];
    expect(buildBand(mesh, topology, 'line', flat, 0.6, noise)).toBeNull();
  });

  it('puts no clean face in the soft zone beside a guide on a flat face near an edge', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const z = 1 - crest - 0.5;
    const near = [pointOn(mesh, [-1.2, 1.5, z]), pointOn(mesh, [1.2, 1.5, z])];
    const band = buildBand(mesh, topology, 'line', near, 0.6, noise);
    if (band) {
      const clean = (p: Vec3) =>
        (Math.abs(p[1] - 1.5) < 0.02 && p[2] < 0.7) || (Math.abs(p[2] - 1) < 0.02 && p[1] < 1.2);
      expect(countWhere(mesh, band, [BandZone.Soft], clean)).toBe(0);
    }
  });

  it('keeps to the edge under the guide on a thin plate', () => {
    // softBox([2, 0.25, 1], 0.1): the plate is 0.5 mm thick, so a 0.6 mm band reaches the edge below.
    const { mesh, topology, noise } = modelOf(softBox([2, 0.25, 1], 0.1));
    const c = 0.1 - 0.1 / Math.SQRT2;
    const guide = [pointOn(mesh, [-1.2, 0.25 - c, 1 - c]), pointOn(mesh, [1.2, 0.25 - c, 1 - c])];
    const band = buildBand(mesh, topology, 'line', guide, 0.6, noise)!;
    expect(band).not.toBeNull();
    let below = 0;
    for (let i = 0; i < band.vertices.length; i++)
      if (mesh.position[band.vertices[i] * 3 + 1] < -0.1) {
        below++;
        expect(band.zone[i]).toBe(BandZone.Beyond);
      }
    expect(below).toBeGreaterThan(0);
  });

  it('edits no folded layer below the guided one', () => {
    // Layers 0.2 apart folding 0.3 past the fillet: at width 1 the band reaches both lower layers.
    const spaced = modelOf(foldedStrip(0.3));
    const guide = [
      pointOn(spaced.mesh, [crest, 0.4 + crest, -1.5]),
      pointOn(spaced.mesh, [crest, 0.4 + crest, 1.5]),
    ];
    const band = buildBand(spaced.mesh, spaced.topology, 'line', guide, 1, spaced.noise)!;
    expect(band).not.toBeNull();
    expect(countWhere(spaced.mesh, band, [BandZone.Beyond], (p) => p[1] < 0.3)).toBeGreaterThan(0);
    expect(countWhere(spaced.mesh, band, softZones, (p) => p[1] < 0.3)).toBe(0);

    // Layers 0.045 apart under a 0.15 fillet, as in the review: 5e6665e edited 555 lower vertices.
    const fillet = 0.15,
      inset = fillet - fillet / Math.SQRT2;
    const tight = modelOf(
      foldedStrip(
        fillet,
        { step: 0.032, ripple: 0.004, noise: 0.002 },
        { gap: 0.045, reach: 0.19, under: 0.21, tail: 0.35, wall: 1.31 },
      ),
    );
    const top = [-1.5, 1.5].map((z) => pointOn(tight.mesh, [inset, 0.09 + inset, z]));
    const close = buildBand(tight.mesh, tight.topology, 'line', top, 0.54, tight.noise)!;
    expect(close).not.toBeNull();
    expect(countWhere(tight.mesh, close, [BandZone.Beyond], (p) => p[1] < 0.0675)).toBeGreaterThan(
      0,
    );
    expect(countWhere(tight.mesh, close, softZones, (p) => p[1] < 0.0675)).toBe(0);
  });

  it('stops at the ends of an open guide', () => {
    const box = modelOf(softBox([2, 1.5, 1], 0.3));
    const boxBand = buildBand(
      box.mesh,
      box.topology,
      'line',
      edgeGuide(box.mesh, -1.2, 1.85),
      0.6,
      box.noise,
    )!;
    expect(boxBand).not.toBeNull();
    expect(countWhere(box.mesh, boxBand, softZones, (p) => p[0] > 2 - 0.02)).toBe(0);

    const step = modelOf(softStep(0.3));
    const guide = [
      pointOn(step.mesh, [crest, crest, -1.5]),
      pointOn(step.mesh, [crest, crest, 1.85]),
    ];
    const stepBand = buildBand(step.mesh, step.topology, 'line', guide, 0.6, step.noise)!;
    expect(stepBand).not.toBeNull();
    expect(countWhere(step.mesh, stepBand, softZones, (p) => p[2] > 2 - 0.02)).toBe(0);
  });

  it('reads the interior edge of a step', () => {
    const { mesh, topology, noise } = modelOf(softStep(0.3));
    const guide = [pointOn(mesh, [crest, crest, -1.5]), pointOn(mesh, [crest, crest, 1.5])];
    const band = buildBand(mesh, topology, 'line', guide, 0.6, noise)!;
    expect(band).not.toBeNull();
    expect(band.soft).toBeGreaterThan((filletSoft(noise) * 2) / 3);
    expect(band.soft).toBeLessThan((filletSoft(noise) * 4) / 3);
    // Drawn along +z with the normal toward (1, 1, 0): Left is the floor y = 0, Right the wall x = 0.
    expect(maxZoneDistance(mesh, band, BandZone.Left, (p) => Math.abs(p[1]))).toBeLessThan(
      flankBound,
    );
    expect(maxZoneDistance(mesh, band, BandZone.Right, (p) => Math.abs(p[0]))).toBeLessThan(
      flankBound,
    );
  });

  it('reads a cylinder rim under an arc guide', () => {
    const { mesh, topology, noise } = modelOf(softCylinder(1.5, 1, 0.3));
    const guide = [0, 1, 2].map((k) => {
      const turn = (k * 2 * Math.PI) / 3;
      return pointOn(mesh, [
        (1.5 - crest) * Math.cos(turn),
        1 - crest,
        (1.5 - crest) * Math.sin(turn),
      ]);
    });
    const band = buildBand(mesh, topology, 'arc', guide, 0.6, noise)!;
    expect(band).not.toBeNull();
    expect(band.soft).toBeGreaterThan((filletSoft(noise) * 2) / 3);
    expect(band.soft).toBeLessThan((filletSoft(noise) * 4) / 3);
    // Drawn with increasing angle about +y: Left is the side wall r = 1.5, Right the cap y = 1.
    const wall = (p: Vec3) => Math.abs(Math.hypot(p[0], p[2]) - 1.5);
    expect(maxZoneDistance(mesh, band, BandZone.Left, wall)).toBeLessThan(flankBound);
    expect(maxZoneDistance(mesh, band, BandZone.Right, (p) => Math.abs(p[1] - 1))).toBeLessThan(
      flankBound,
    );
  });

  it('leaves no flank vertex further than 3 local scales from its surface on a cylinder rim', () => {
    const { mesh, topology, noise } = modelOf(softCylinder(1.5, 1, 0.3));
    const guide = [0, 1, 2].map((k) => {
      const turn = (k * 2 * Math.PI) / 3;
      return pointOn(mesh, [
        (1.5 - crest) * Math.cos(turn),
        1 - crest,
        (1.5 - crest) * Math.sin(turn),
      ]);
    });
    const width = estimateWidth(mesh, topology, 'arc', guide, noise);
    for (const w of [width, 0.6]) {
      const band = buildBand(mesh, topology, 'arc', guide, w, noise)!;
      expect(band).not.toBeNull();
      expect(flankOverTolerance(mesh, band)).toBe(0);
    }
  });

  it('fits a face that is no single shape with a profile per slice', () => {
    const { mesh, topology, noise } = modelOf(bulgedBox([2, 1.5, 1], 0.3, 0.15));
    const lift = (x: number, y: number) => (0.15 * Math.exp(-((x / 0.5) ** 2)) * (y + 1.5)) / 3;
    const guide = [-1.2, -0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9, 1.2].map((x) =>
      pointOn(mesh, [x, 1.5 - crest + lift(x, 1.5 - crest), 1 - crest]),
    );
    const band = buildBand(mesh, topology, 'spline', guide, 0.6, noise)!;
    expect(band).not.toBeNull();
    // Left is the bulged top face, Right the flat face z = 1.
    expect(band.fits).toEqual(['profile', 'plane']);
    expect(zoneCount(band, BandZone.Left)).toBeGreaterThan(50);
    const top = (p: Vec3) => Math.abs(p[1] - 1.5 - lift(p[0], 1.5));
    // The per-slice lines themselves sit off the bump by up to about 0.005 more than a plane does.
    expect(maxZoneDistance(mesh, band, BandZone.Left, top)).toBeLessThan(flankBound + 0.005);
    expect(maxZoneDistance(mesh, band, BandZone.Right, (p) => Math.abs(p[2] - 1))).toBeLessThan(
      flankBound,
    );
    const clean = (p: Vec3) =>
      (top(p) < 0.02 && p[2] < 0.7) || (Math.abs(p[2] - 1) < 0.02 && p[1] < 1.2);
    expect(countWhere(mesh, band, [BandZone.Soft], clean)).toBe(0);
  });

  it('exports each flank surface with one edge point per slice', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const guide = edgeGuide(mesh, -1.2, 1.2);
    const band = buildBand(mesh, topology, 'line', guide, 0.6, noise)!;
    const [left, right] = band.flanks;
    expect([left.kind, right.kind]).toEqual(band.fits);
    // Left is the face y = 1.5 and Right the face z = 1, read well away from the fillet.
    expect(left.distance(0.3, 1.5, 0.2)).toBeLessThan(0.01);
    expect(right.distance(0.3, 1, 1.0)).toBeLessThan(0.01);
    expect(left.distance(0.3, 1.6, 0.2)).toBeCloseTo(0.1, 1);
    const at = new Float64Array(3);
    left.project(0.3, 1.6, 0.2, at);
    expect(Math.abs(at[1] - 1.5)).toBeLessThan(0.01);
    left.normal(0.3, 1.6, 0.2, at);
    expect(at[1]).toBeGreaterThan(0.999);
    right.normal(0.3, 1, 1.0, at);
    expect(at[2]).toBeGreaterThan(0.999);
    expect(left.local).toBeGreaterThan(noise / 2);
    expect(left.local).toBeLessThanOrEqual(2 * noise);
    // Slices are 4 edge lengths long, centred on the guide's middle.
    const length = band.drawn.lengths[band.drawn.lengths.length - 1];
    const slices = Math.max(1, Math.round(length / (4 * clickedEdge(mesh, topology, guide))));
    expect(band.edge.length / 3).toBeGreaterThanOrEqual(slices - 1);
    expect(band.edge.length / 3).toBeLessThanOrEqual(slices + 1);
  });

  it('swaps Left and Right and nothing else when the guide is drawn the other way', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const [a, b] = edgeGuide(mesh, -1.2, 1.2);
    expectMirrored(
      buildBand(mesh, topology, 'line', [a, b], 0.6, noise)!,
      buildBand(mesh, topology, 'line', [b, a], 0.6, noise)!,
    );
  });

  it('stays mirrored with a vertex exactly at the middle of the guide', () => {
    // The rounding grows from 0.15 to 0.35 along x, so the band differs either side of the middle.
    const { mesh, topology, noise } = modelOf(taperedBox([2, 0.5, 0.5], 0.15, 0.35));
    const radius = 0.15 + (0.2 * (0.2 + 2)) / 4,
      inset = radius - radius / Math.SQRT2;
    const target: Vec3 = [0.2, 0.5 - inset, 0.5 - inset];
    let middle = 0;
    for (let v = 1; v < mesh.weldedCount; v++) {
      const d = (w: number) =>
        Math.hypot(...[0, 1, 2].map((k) => mesh.position[w * 3 + k] - target[k]));
      if (d(v) < d(middle)) middle = v;
    }
    const at = (dx: number): GuidePoint => {
      const position: Vec3 = [
        mesh.position[middle * 3] + dx,
        mesh.position[middle * 3 + 1],
        mesh.position[middle * 3 + 2],
      ];
      return { triangle: pointOn(mesh, position).triangle, position };
    };
    // Several lengths, so that both an even and an odd number of slices put a boundary or a centre
    // at the middle vertex.
    for (const half of [0.9, 1, 1.1, 1.2]) {
      const forward = buildBand(mesh, topology, 'line', [at(-half), at(half)], 0.6, noise)!;
      expect(forward).not.toBeNull();
      const i = forward.vertices.indexOf(middle);
      const length = forward.drawn.lengths[forward.drawn.lengths.length - 1];
      expect(forward.station[i]).toBeCloseTo(length / 2, 6);
      expectMirrored(
        forward,
        buildBand(mesh, topology, 'line', [at(half), at(-half)], 0.6, noise)!,
      );
    }
  });

  it('builds a 39,000-vertex band and estimates its width in bounded time', () => {
    const { mesh, topology } = modelOf(softBox([2, 1.5, 1], 0.3, { step: 0.012 }));
    const guide = edgeGuide(mesh, -1.2, 1.2);
    let start = performance.now();
    // The band is the vertices within 1.2 of the guide along the surface.
    const band = buildBand(mesh, topology, 'line', guide, 1.2, 0.0086)!;
    const built = performance.now() - start;
    start = performance.now();
    estimateWidth(mesh, topology, 'line', guide, 0.0086);
    const estimated = performance.now() - start;
    process.stdout.write(
      `buildBand ${built.toFixed(0)} ms, estimateWidth ${estimated.toFixed(0)} ms\n`,
    );
    expect(band.vertices.length).toBeGreaterThan(39000);
    expect(built).toBeLessThan(300);
    expect(estimated).toBeLessThan(1500);
  }, 60000);
});

describe('estimateWidth', () => {
  it('estimates a width from the softened zone', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const w = estimateWidth(mesh, topology, 'line', edgeGuide(mesh, -1.2, 1.2), noise);
    // soft + max(2 soft, 6 edges): 0.108 + max(0.216, 6 * 0.066 mm edge) = 0.50, +-1/3.
    expect(w).toBeGreaterThan(0.33);
    expect(w).toBeLessThan(0.67);
  });

  it('finds no edge under a guide on a flat face', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const flat = [pointOn(mesh, [-1, 1.5, 0]), pointOn(mesh, [1, 1.5, 0])];
    expect(estimateWidth(mesh, topology, 'line', flat, noise)).toBe(0);
    const z = 1 - crest - 0.5;
    const near = [pointOn(mesh, [-1.2, 1.5, z]), pointOn(mesh, [1.2, 1.5, z])];
    expect(estimateWidth(mesh, topology, 'line', near, noise)).toBeLessThan(0.7);
    // 0.3 from the crest line the guide is on the clean face, 0.21 from the soft zone.
    const nearer = [-1.2, 1.2].map((x) => pointOn(mesh, [x, 1.5, 1 - crest - 0.3]));
    expect(estimateWidth(mesh, topology, 'line', nearer, noise)).toBe(0);
    expect(buildBand(mesh, topology, 'line', nearer, 0.6, noise)).toBeNull();
  });

  describe('rebuilds the band it estimates', () => {
    const box = modelOf(softBox([2, 1.5, 1], 0.3));
    const step = modelOf(softStep(0.3));
    const cylinder = modelOf(softCylinder(1.5, 1, 0.3));
    const cases: {
      name: string;
      model: () => ReturnType<typeof modelOf>;
      kind: 'line' | 'arc';
      guide: (mesh: RefineMesh) => GuidePoint[];
    }[] = [
      {
        name: 'box edge on its crest',
        model: () => box,
        kind: 'line',
        guide: (m) => arcGuide(m, [-1.2, 1.2]),
      },
      ...[-0.2, -0.1, 0.1, 0.2].map((offset) => ({
        name: `box edge ${offset} mm off its crest`,
        model: () => box,
        kind: 'line' as const,
        guide: (m: RefineMesh) => arcGuide(m, [-1.2, 1.2], offset),
      })),
      {
        name: 'full-length box edge',
        model: () => box,
        kind: 'line',
        guide: (m) => arcGuide(m, [-1.7, 1.7]),
      },
      {
        name: 'full-length step edge',
        model: () => step,
        kind: 'line',
        guide: (m) => [-2, 2].map((z) => pointOn(m, [crest, crest, z])),
      },
      {
        name: 'cylinder rim',
        model: () => cylinder,
        kind: 'arc',
        guide: (m) =>
          [0, 1, 2].map((k) => {
            const turn = (k * 2 * Math.PI) / 3;
            return pointOn(m, [
              (1.5 - crest) * Math.cos(turn),
              1 - crest,
              (1.5 - crest) * Math.sin(turn),
            ]);
          }),
      },
      {
        name: 'box at 0.012 mm spacing',
        model: () => modelOf(softBox([2, 1.5, 1], 0.3, { step: 0.012 })),
        kind: 'line',
        guide: (m) => arcGuide(m, [-1.2, 1.2]),
      },
    ];
    it.each(cases)(
      'on the $name',
      ({ model, kind, guide }) => {
        const { mesh, topology, noise } = model();
        const points = guide(mesh);
        const width = estimateWidth(mesh, topology, kind, points, noise);
        expect(width).toBeGreaterThan(0);
        const edge = clickedEdge(mesh, topology, points);
        // The classification does not depend on the width, so a generous band reads the same soft.
        const generous = buildBand(mesh, topology, kind, points, Math.max(24 * edge, 1.5), noise)!;
        expect(generous).not.toBeNull();
        const band = buildBand(mesh, topology, kind, points, width, noise)!;
        expect(band).not.toBeNull();
        process.stdout.write(
          `width ${width.toFixed(3)}: soft ${band.soft.toFixed(3)} against ${generous.soft.toFixed(3)}, edge ${edge.toFixed(3)}\n`,
        );
        expect(Math.abs(band.soft - generous.soft)).toBeLessThanOrEqual(edge);
      },
      30000,
    );
  });
});

describe('a single softened edge between clean faces', () => {
  /** Clean-face band vertices off their own flank: on y = 1.5 (Left) and z = 1 (Right), clear of the fillet and ends. */
  const misplaced = (mesh: RefineMesh, band: EdgeBand) => {
    const wrong = [0, 0],
      clean = [0, 0];
    band.vertices.forEach((v, i) => {
      const [x, y, z] = mesh.position.subarray(v * 3, v * 3 + 3);
      if (Math.abs(x) >= 1.67) return;
      if (Math.abs(y - 1.5) < 0.01 && z < 0.68) {
        clean[0]++;
        wrong[0] += +(band.zone[i] !== BandZone.Left);
      }
      if (Math.abs(z - 1) < 0.01 && y < 1.18) {
        clean[1]++;
        wrong[1] += +(band.zone[i] !== BandZone.Right);
      }
    });
    return { wrong, clean };
  };

  it('keeps every clean-face vertex on its flank from the estimated width to three times it', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const guide = edgeGuide(mesh, -1.2, 1.2);
    const width = estimateWidth(mesh, topology, 'line', guide, noise);
    for (const factor of [1, 1.5, 2, 2.5, 3]) {
      const band = buildBand(mesh, topology, 'line', guide, factor * width, noise)!;
      expect(band).not.toBeNull();
      const { wrong, clean } = misplaced(mesh, band);
      expect(Math.min(...clean)).toBeGreaterThan(50);
      expect(wrong).toEqual([0, 0]);
    }
  });

  it('keeps every clean-face vertex on its flank at 0.012 mm spacing', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3, { step: 0.012 }));
    const guide = edgeGuide(mesh, -1.2, 1.2);
    const width = estimateWidth(mesh, topology, 'line', guide, noise);
    for (const w of [0.4, width, 3 * width]) {
      const band = buildBand(mesh, topology, 'line', guide, w, noise)!;
      expect(band).not.toBeNull();
      const { wrong, clean } = misplaced(mesh, band);
      expect(Math.min(...clean)).toBeGreaterThan(100);
      expect(wrong).toEqual([0, 0]);
    }
  }, 60000);
});

describe('cost', () => {
  it('builds a 100,000-vertex band along a 40 mm spline in under a second', () => {
    const { mesh, topology } = modelOf(softBox([20, 2, 2], 0.3, { step: 0.04 }));
    const inset = 0.3 - 0.3 / Math.SQRT2;
    const guide = [-20, -10, 0, 10, 20].map((x) => pointOn(mesh, [x, 2 - inset, 2 - inset]));
    let start = performance.now();
    const band = buildBand(mesh, topology, 'spline', guide, 2.2, 0.0086)!;
    const built = performance.now() - start;
    start = performance.now();
    const width = estimateWidth(mesh, topology, 'spline', guide, 0.0086);
    const estimated = performance.now() - start;
    process.stdout.write(
      `${band?.vertices.length} vertices: buildBand ${built.toFixed(0)} ms, estimateWidth ${estimated.toFixed(0)} ms (${width.toFixed(3)} mm)\n`,
    );
    expect(band).not.toBeNull();
    expect(band.vertices.length).toBeGreaterThan(90000);
    expect(width).toBeGreaterThan(0);
    expect(built).toBeLessThan(1000);
    expect(estimated).toBeLessThan(2000);
  }, 120000);
});

describe('an edge where two flank surfaces meet', () => {
  /** Faces 15 deg either side of level meeting along z at the origin, rounded with radius 0.6. */
  const ridge = () => {
    const slope = Math.tan((15 * Math.PI) / 180);
    const model = modelOf(
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
    // A point on the fillet `offset` mm along it from its crest.
    const guide = (offset = 0) =>
      [-1.2, 1.2].map((z) => {
        const angle = offset / 0.6;
        const crest = -0.6 * (1 / Math.cos((15 * Math.PI) / 180) - 1);
        return pointOn(model.mesh, [0.6 * Math.sin(angle), crest - 0.6 * (1 - Math.cos(angle)), z]);
      });
    return { ...model, guide };
  };
  /** A strip 0.6 wide and 0.4 high on a floor, its two top edges rounded with radius 0.15. */
  const strip = () => {
    const model = modelOf(
      extrudedProfile(
        [
          [-1.5, 0],
          [-0.3, 0],
          [-0.3, 0.4],
          [0.3, 0.4],
          [0.3, 0],
          [1.5, 0],
        ],
        [0, 0.15, 0.15, 0],
        3,
      ),
    );
    const crest: Vec3 = [0.15 + 0.15 / Math.SQRT2, 0.25 + 0.15 / Math.SQRT2, 0];
    const guide = [-1.2, 1.2].map((z) => pointOn(model.mesh, [crest[0], crest[1], z]));
    return { ...model, guide, crest };
  };
  const box = modelOf(softBox([2, 1.5, 1], 0.3));
  const boxGuide = (offset: number) => arcGuide(box.mesh, [-1.2, 1.2], offset);

  it('finds a shallow softened edge between faces 30 degrees apart', () => {
    const { mesh, topology, noise, guide } = ridge();
    const band = buildBand(mesh, topology, 'line', guide(), 0.6, noise)!;
    expect(band).not.toBeNull();
    expect(band.angle).toBeGreaterThan(25);
    expect(band.angle).toBeLessThan(35);
    expect(zoneCount(band, BandZone.Left)).toBeGreaterThan(50);
    expect(zoneCount(band, BandZone.Right)).toBeGreaterThan(50);
    // The true edge is the line x = y = 0 along z.
    for (let k = 0; k < band.edge.length; k += 3)
      expect(Math.hypot(band.edge[k], band.edge[k + 1])).toBeLessThan(0.02);
  });

  it('refuses a rounded rib 0.6 mm wide with no flat top', () => {
    const { mesh, topology, noise } = modelOf(
      extrudedProfile(
        [
          [-1.5, 0],
          [-0.3, 0],
          [-0.3, 0.6],
          [0.3, 0.6],
          [0.3, 0],
          [1.5, 0],
        ],
        [0, 0.3, 0.3, 0],
        3,
      ),
    );
    const top = [-1.2, 1.2].map((z) => pointOn(mesh, [0, 0.6, z]));
    expect(estimateWidth(mesh, topology, 'line', top, noise)).toBe(0);
    for (const width of [0.4, 0.6, 1])
      expect(buildBand(mesh, topology, 'line', top, width, noise)).toBeNull();
  });

  it('keeps the band for one edge of a raised strip short of the other edge', () => {
    const { mesh, topology, noise, guide, crest } = strip();
    const estimate = estimateWidth(mesh, topology, 'line', guide, noise);
    for (const width of [estimate, 0.6, 0.9]) {
      const band = buildBand(mesh, topology, 'line', guide, width, noise)!;
      expect(band).not.toBeNull();
      // The other edge's crest lies at x = -crest[0].
      expect(countWhere(mesh, band, softZones, ([x]) => x <= -crest[0])).toBe(0);
    }
  });

  it('solves the same edge from a guide 0.15 mm off the crest', () => {
    const shallow = ridge();
    for (const [model, guide] of [
      [shallow, shallow.guide],
      [box, boxGuide],
    ] as const) {
      const { mesh, topology, noise } = model;
      const centred = buildBand(mesh, topology, 'line', guide(0), 0.6, noise)!;
      expect(centred).not.toBeNull();
      for (const offset of [-0.15, 0.15]) {
        const shifted = buildBand(mesh, topology, 'line', guide(offset), 0.6, noise)!;
        expect(shifted).not.toBeNull();
        expect(polylineGap(centred.edge, shifted.edge)).toBeLessThan(0.02);
      }
    }
  });

  it.each([
    {
      name: 'shallow edge',
      model: () => ridge(),
      guide: (m: ReturnType<typeof ridge>) => m.guide(),
    },
    { name: 'raised strip', model: () => strip(), guide: (m: ReturnType<typeof strip>) => m.guide },
    {
      name: 'shallow edge 0.15 mm off its crest',
      model: () => ridge(),
      guide: (m: ReturnType<typeof ridge>) => m.guide(0.15),
    },
    {
      name: 'box edge 0.15 mm off its crest',
      model: () => ({ ...box }),
      guide: () => boxGuide(0.15),
    },
  ] as {
    name: string;
    model: () => ReturnType<typeof modelOf>;
    guide: (m: never) => GuidePoint[];
  }[])('rebuilds the band it estimates on the $name', ({ model, guide }) => {
    const m = model();
    const points = guide(m as never);
    const width = estimateWidth(m.mesh, m.topology, 'line', points, m.noise);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(1);
    const band = buildBand(m.mesh, m.topology, 'line', points, width, m.noise)!;
    expect(band).not.toBeNull();
    // Up to reach + 8 edges (0.83 mm here) the width only caps the band, so the band at 0.6 is the
    // classification the estimate read.
    const read = buildBand(m.mesh, m.topology, 'line', points, 0.6, m.noise)!;
    expect(Math.abs(band.soft - read.soft)).toBeLessThanOrEqual(0.03);
  });
});

describe('telling an edge from a smooth surface', () => {
  const refused = (
    { mesh, topology, noise }: ReturnType<typeof modelOf>,
    kind: 'line' | 'arc',
    guide: GuidePoint[],
  ) => {
    expect(estimateWidth(mesh, topology, kind, guide, noise)).toBe(0);
    expect(buildBand(mesh, topology, kind, guide, 0.6, noise)).toBeNull();
  };

  it.each([0.7, 2])('refuses a guide along a smooth cylinder of radius %s mm', (radius) => {
    const model = modelOf(softCylinder(radius, 1.5, 0.1));
    refused(model, 'line', [
      pointOn(model.mesh, [radius, -1, 0]),
      pointOn(model.mesh, [radius, 1, 0]),
    ]);
  });

  it('refuses a guide over a sphere cap of radius 0.5 mm', () => {
    const model = modelOf(rippledSphere(0.5));
    const at = (degrees: number) => {
      const a = (degrees * Math.PI) / 180;
      return pointOn(model.mesh, [0.5 * Math.sin(a), 0.5 * Math.cos(a), 0]);
    };
    refused(model, 'arc', [at(-50), at(0), at(50)]);
  });

  it('refuses a guide along the crown of a cylinder of radius 0.5 mm', () => {
    const model = modelOf(softCylinder(0.5, 1.5, 0.1));
    refused(model, 'line', [pointOn(model.mesh, [0.5, -1, 0]), pointOn(model.mesh, [0.5, 1, 0])]);
  });

  it('refuses a guide over the crown of a sphere of radius 0.6 mm', () => {
    const model = modelOf(rippledSphere(0.6));
    const at = (degrees: number) => {
      const a = (degrees * Math.PI) / 180;
      return pointOn(model.mesh, [0.6 * Math.sin(a), 0.6 * Math.cos(a), 0]);
    };
    refused(model, 'arc', [at(-50), at(0), at(50)]);
  });

  it('refuses a guide on a gently curved quadric patch', () => {
    // Radii of curvature 2 and 3.3 mm.
    const model = modelOf(heightField(1.5, (x, z) => -0.25 * x * x - 0.15 * z * z));
    refused(
      model,
      'line',
      [-1, 1].map((z) => pointOn(model.mesh, [0, -0.15 * z * z, z])),
    );
  });

  it.each([
    { degrees: 30, fillet: 0.4, flank: 0 },
    { degrees: 45, fillet: 0.25, flank: 0 },
    { degrees: 90, fillet: 0.15, flank: 0 },
    { degrees: 45, fillet: 0.25, flank: 2 },
    { degrees: 60, fillet: 0.2, flank: 2 },
  ])(
    'finds a $degrees-degree softened edge with fillet $fillet mm and flank radius $flank mm',
    ({ degrees, fillet, flank }) => {
      const turn = (degrees * Math.PI) / 180,
        bend = flank ? 1.5 / flank : 0;
      const pieces = [
        { length: 1.5, turn: -bend },
        { length: fillet * turn, turn: -turn },
        { length: 1.5, turn: -bend },
      ];
      const { mesh, topology, noise } = modelOf(turnedProfile(pieces, 3));
      const [x, y] = turnedPoint(pieces, 1.5 + (fillet * turn) / 2).point;
      const guide = [-1.2, 1.2].map((z) => pointOn(mesh, [x, y, z]));
      const width = estimateWidth(mesh, topology, 'line', guide, noise);
      expect(width).toBeGreaterThan(0);
      for (const w of [width, 0.6]) {
        const band = buildBand(mesh, topology, 'line', guide, w, noise)!;
        expect(band).not.toBeNull();
        expect(zoneCount(band, BandZone.Left)).toBeGreaterThan(50);
        expect(zoneCount(band, BandZone.Right)).toBeGreaterThan(50);
      }
    },
  );
});
