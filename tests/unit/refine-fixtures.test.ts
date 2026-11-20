import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { hasClosedEdges, weldedPositionIndex } from '../../src/core/mesh-topology';
import { maxBoxDistance, maxEdge, medianEdge, minTriangleArea, radii } from '../helpers/refine';
import {
  type SoftOptions,
  rippledSphere,
  rivetedPlate,
  softBox,
  softCylinder,
  softDefaults,
  softElbow,
  softStep,
} from '../helpers/soft-edges';

const closed = (g: BufferGeometry) => {
  const w = weldedPositionIndex(g);
  return hasClosedEdges(w.indices, w.vertices);
};

const fixtures: [string, (options?: SoftOptions) => BufferGeometry][] = [
  ['softBox', (options) => softBox([2, 1.5, 1], 0.3, options)],
  ['softStep', (options) => softStep(0.3, options)],
  ['softCylinder', (options) => softCylinder(1.5, 1, 0.3, options)],
  ['rivetedPlate', (options) => rivetedPlate(options).geometry],
  ['rippledSphere', (options) => rippledSphere(3, options)],
  ['softElbow', (options) => softElbow(4, 1, options)],
];

describe('softened fixtures', () => {
  it.each(fixtures)('%s is closed, scan-dense and repeatable', (_, make) => {
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
    const plain = softBox([2, 1.5, 1], 0.3);
    const indexed = softBox([2, 1.5, 1], 0.3, { indexed: true });
    expect(plain.index).toBeNull();
    expect(indexed.index).not.toBeNull();
    const a = weldedPositionIndex(plain);
    const b = weldedPositionIndex(indexed);
    expect(b.vertices).toBe(a.vertices);
    expect(Array.from(b.indices)).toEqual(Array.from(a.indices));
  });

  it.each(fixtures)('%s has no zero-area triangle for any seed or step', (_, make) => {
    for (const step of [0.06, 0.1])
      for (const seed of [1, 2, 3]) {
        const g = make({ step, seed });
        expect(closed(g), `step ${step}, seed ${seed}`).toBe(true);
        expect(minTriangleArea(g), `step ${step}, seed ${seed}`).toBeGreaterThan(1e-8);
      }
  });

  it('has no zero-area cap face on softStep(0.3) at step 0.1, seed 2', () => {
    expect(minTriangleArea(softStep(0.3, { step: 0.1, seed: 2 }))).toBeGreaterThan(1e-8);
  });

  it.each(fixtures)('%s has no edge longer than four steps', (_, make) => {
    expect(maxEdge(make())).toBeLessThan(4 * softDefaults.step);
  });
});
