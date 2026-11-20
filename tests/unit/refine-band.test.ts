import { describe, expect, it } from 'vitest';
import { BandZone, buildBand, estimateWidth } from '../../src/core/refine-band';
import type { RefineMesh } from '../../src/core/refine-mesh';
import { maxFlankError, modelOf, pointOn, zoneCount } from '../helpers/refine';
import { softBox } from '../helpers/soft-edges';

const edgeGuide = (mesh: RefineMesh, x0: number, x1: number) => {
  // The fillet's crest on the box edge y = 1.5, z = 1.
  const c = 0.3 - 0.3 / Math.SQRT2;
  return [pointOn(mesh, [x0, 1.5 - c, 1 - c]), pointOn(mesh, [x1, 1.5 - c, 1 - c])];
};

describe('buildBand', () => {
  it('finds the softened zone and both flanks of a box edge', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const band = buildBand(mesh, topology, 'line', edgeGuide(mesh, -1.2, 1.2), 0.6, noise)!;
    // Flanks fit within 3 * 0.0086 of each face, so 0.3 (1 - cos a) = 0.026 gives a = 23.9 deg and the soft half-width is 0.3 sin(45 - 23.9 deg) = 0.108, +-1/3.
    expect(band.soft).toBeGreaterThan(0.072);
    expect(band.soft).toBeLessThan(0.144);
    expect(zoneCount(band, BandZone.Left)).toBeGreaterThan(50);
    expect(zoneCount(band, BandZone.Right)).toBeGreaterThan(50);
    // Flank vertices lie on the true faces y = 1.5 and z = 1.
    expect(maxFlankError(mesh, band)).toBeLessThan(0.03);
  });

  it('returns null on a flat face', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const flat = [pointOn(mesh, [-1, 1.5, 0]), pointOn(mesh, [1, 1.5, 0])];
    expect(buildBand(mesh, topology, 'line', flat, 0.6, noise)).toBeNull();
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

  it('swaps Left and Right and nothing else when the guide is drawn the other way', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const [a, b] = edgeGuide(mesh, -1.2, 1.2);
    const forward = buildBand(mesh, topology, 'line', [a, b], 0.6, noise)!;
    const backward = buildBand(mesh, topology, 'line', [b, a], 0.6, noise)!;
    expect(Array.from(backward.vertices)).toEqual(Array.from(forward.vertices));
    const swap = [BandZone.Soft, BandZone.Right, BandZone.Left, BandZone.Beyond];
    expect(Array.from(backward.zone)).toEqual(Array.from(forward.zone, (z) => swap[z]));
    expect(backward.soft).toBeCloseTo(forward.soft, 6);
    const length = forward.drawn.lengths[forward.drawn.lengths.length - 1];
    for (let i = 0; i < forward.vertices.length; i++) {
      expect(backward.cross[i]).toBeCloseTo(-forward.cross[i], 5);
      expect(backward.station[i]).toBeCloseTo(length - forward.station[i], 5);
    }
  });
});

describe('estimateWidth', () => {
  it('estimates a width from the softened zone', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const w = estimateWidth(mesh, topology, 'line', edgeGuide(mesh, -1.2, 1.2), noise);
    // soft + max(2 soft, 6 edges): 0.108 + max(0.216, 6 * 0.06 mm edge) = 0.47, +-1/3.
    expect(w).toBeGreaterThan(0.31);
    expect(w).toBeLessThan(0.62);
  });
});
