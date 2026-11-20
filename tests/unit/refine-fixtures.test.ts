import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { hasClosedEdges, weldedPositionIndex } from '../../src/core/mesh-topology';
import { maxBoxDistance, medianEdge, radii } from '../helpers/refine';
import {
  rippledSphere,
  rivetedPlate,
  softBox,
  softCylinder,
  softElbow,
  softStep,
} from '../helpers/soft-edges';

const closed = (g: BufferGeometry) => {
  const w = weldedPositionIndex(g);
  return hasClosedEdges(w.indices, w.vertices);
};

describe('softened fixtures', () => {
  it.each([
    ['softBox', () => softBox([2, 1.5, 1], 0.3)],
    ['softStep', () => softStep(0.3)],
    ['softCylinder', () => softCylinder(1.5, 1, 0.3)],
    ['rivetedPlate', () => rivetedPlate().geometry],
    ['rippledSphere', () => rippledSphere(3)],
    ['softElbow', () => softElbow(4, 1)],
  ])('%s is closed, scan-dense and repeatable', (_, make) => {
    const g = make();
    expect(closed(g)).toBe(true);
    expect(medianEdge(g)).toBeGreaterThan(0.04);
    expect(medianEdge(g)).toBeLessThan(0.08);
    expect(make().getAttribute('position').array).toEqual(g.getAttribute('position').array);
  });

  it('keeps softBox within its fillet and ripple of the sharp box', () => {
    // Farthest point of a filleted corner from the sharp one is fillet * (sqrt(3) - 1).
    expect(maxBoxDistance(softBox([2, 1.5, 1], 0.3), [2, 1.5, 1])).toBeLessThan(
      0.3 * 0.7321 + 0.03,
    );
  });

  it('keeps rippledSphere within ripple and noise of its radius', () => {
    const r = radii(rippledSphere(3));
    expect(Math.max(...r) - 3).toBeLessThan(0.025);
    expect(3 - Math.min(...r)).toBeLessThan(0.025);
  });

  it('makes an indexed form with the same welded topology', () => {
    const a = weldedPositionIndex(softBox([2, 1.5, 1], 0.3));
    const b = weldedPositionIndex(softBox([2, 1.5, 1], 0.3, { indexed: true }));
    expect(b.vertices).toBe(a.vertices);
  });
});
