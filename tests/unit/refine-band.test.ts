import { describe, expect, it } from 'vitest';
import {
  BandZone,
  type EdgeBand,
  type GuidePoint,
  buildBand,
  estimateWidth,
} from '../../src/core/refine-band';
import type { RefineMesh } from '../../src/core/refine-mesh';
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
 * Flanks reach the fillet where it lies within 3 * noise of its face, 0.3 (1 - cos a) = 3 * noise,
 * so the soft half-width is 0.3 sin(45 deg - a).
 */
const filletSoft = (noise: number) => 0.3 * Math.sin(Math.PI / 4 - Math.acos(1 - noise / 0.1));
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
    // Flanks fit within 3 * 0.0086 of each face, so 0.3 (1 - cos a) = 0.026 gives a = 23.9 deg and the soft half-width is 0.3 sin(45 - 23.9 deg) = 0.108, +-1/3.
    expect(band.soft).toBeGreaterThan(0.072);
    expect(band.soft).toBeLessThan(0.144);
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

  it('never reaches a folded layer that is near in space but far over the surface', () => {
    const { mesh, topology, noise } = modelOf(foldedStrip(0.3));
    // The concave fillet's crest, where the top layer (y = 0.4) turns up into the wall x = 0.
    const guide = [
      pointOn(mesh, [crest, 0.4 + crest, -1.5]),
      pointOn(mesh, [crest, 0.4 + crest, 1.5]),
    ];
    const band = buildBand(mesh, topology, 'line', guide, 0.6, noise)!;
    expect(band).not.toBeNull();
    // The second layer (y = 0.2) and the third (y = 0) lie within 0.6 of the guide in space.
    expect(countWhere(mesh, band, [...softZones, BandZone.Beyond], (p) => p[1] < 0.3)).toBe(0);
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
    const band = buildBand(mesh, topology, 'line', guide, 1.1, 0.0086)!;
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
    // soft + max(2 soft, 6 edges): 0.108 + max(0.216, 6 * 0.06 mm edge) = 0.47, +-1/3.
    expect(w).toBeGreaterThan(0.31);
    expect(w).toBeLessThan(0.62);
  });

  it('finds no edge under a guide on a flat face', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const flat = [pointOn(mesh, [-1, 1.5, 0]), pointOn(mesh, [1, 1.5, 0])];
    expect(estimateWidth(mesh, topology, 'line', flat, noise)).toBe(0);
    const z = 1 - crest - 0.5;
    const near = [pointOn(mesh, [-1.2, 1.5, z]), pointOn(mesh, [1.2, 1.5, z])];
    expect(estimateWidth(mesh, topology, 'line', near, noise)).toBeLessThan(0.7);
  });
});
