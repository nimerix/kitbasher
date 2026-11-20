import { describe, expect, it } from 'vitest';
import {
  BandZone,
  type EdgeBand,
  type GuidePoint,
  buildBand,
  estimateWidth,
  minBandAngle,
} from '../../src/core/refine-band';
import { type RefineMesh, weldedCorner } from '../../src/core/refine-mesh';
import type { Vec3 } from '../../src/core/types';
import { countWhere, maxZoneDistance, modelOf, pointOn, zoneCount } from '../helpers/refine';
import {
  bulgedBox,
  foldedStrip,
  softBox,
  softCylinder,
  softStep,
  taperedBox,
} from '../helpers/soft-edges';

/** How far a 0.3 mm fillet's crest sits in from each face. */
const crest = 0.3 - 0.3 / Math.SQRT2;
const edgeGuide = (mesh: RefineMesh, x0: number, x1: number) => {
  // The fillet's crest on the box edge y = 1.5, z = 1.
  return [pointOn(mesh, [x0, 1.5 - crest, 1 - crest]), pointOn(mesh, [x1, 1.5 - crest, 1 - crest])];
};
/**
 * Flanks reach a 0.3 mm fillet where it lies within 3 * noise of its face, 0.3 (1 - cos a) = 3 * noise,
 * and where its normals turn no more than 2 * minBandAngle from the face's, so the soft half-width is
 * 0.3 sin(45 deg - a) with a the smaller of the two angles.
 */
const filletSoft = (noise: number) =>
  0.3 *
  Math.sin(Math.PI / 4 - Math.min(Math.acos(1 - noise / 0.1), (2 * minBandAngle * Math.PI) / 180));
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
    // Flanks fit within 3 * 0.0086 of each face, 0.3 (1 - cos a) = 0.026 at a = 23.9 deg, and face
    // within 20 deg of it, so a = 20 deg and the soft half-width is 0.3 sin(45 - 20 deg) = 0.127, +-1/3.
    expect(band.soft).toBeGreaterThan(0.085);
    expect(band.soft).toBeLessThan(0.169);
    expect(zoneCount(band, BandZone.Left)).toBeGreaterThan(50);
    expect(zoneCount(band, BandZone.Right)).toBeGreaterThan(50);
    // Drawn along +x, Left (normal x tangent) is the face y = 1.5 and Right the face z = 1.
    expect(maxZoneDistance(mesh, band, BandZone.Left, (p) => Math.abs(p[1] - 1.5))).toBeLessThan(
      0.03,
    );
    expect(maxZoneDistance(mesh, band, BandZone.Right, (p) => Math.abs(p[2] - 1))).toBeLessThan(
      0.03,
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
    expect(maxZoneDistance(mesh, band, BandZone.Left, (p) => Math.abs(p[1]))).toBeLessThan(0.03);
    expect(maxZoneDistance(mesh, band, BandZone.Right, (p) => Math.abs(p[0]))).toBeLessThan(0.03);
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
    expect(maxZoneDistance(mesh, band, BandZone.Left, wall)).toBeLessThan(0.03);
    expect(maxZoneDistance(mesh, band, BandZone.Right, (p) => Math.abs(p[1] - 1))).toBeLessThan(
      0.03,
    );
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
    // Within 3 * noise (0.026) of the per-slice lines, which themselves sit off the bump by up to
    // about 0.005, so 0.035 rather than the 0.03 a single plane meets.
    expect(maxZoneDistance(mesh, band, BandZone.Left, top)).toBeLessThan(0.035);
    expect(maxZoneDistance(mesh, band, BandZone.Right, (p) => Math.abs(p[2] - 1))).toBeLessThan(
      0.03,
    );
    const clean = (p: Vec3) =>
      (top(p) < 0.02 && p[2] < 0.7) || (Math.abs(p[2] - 1) < 0.02 && p[1] < 1.2);
    expect(countWhere(mesh, band, [BandZone.Soft], clean)).toBe(0);
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
    // soft + max(2 soft, 6 edges): 0.127 + max(0.254, 6 * 0.066 mm edge) = 0.52, +-1/3.
    expect(w).toBeGreaterThan(0.35);
    expect(w).toBeLessThan(0.7);
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
        // The estimate reads `soft` from one band at max(24 edges, 1.5 mm).
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
