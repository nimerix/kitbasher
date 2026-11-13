import { describe, expect, it } from 'vitest';
import { BoxGeometry, SphereGeometry } from 'three';
import { MeshoptSimplifier as original } from 'meshoptimizer/simplifier';
import { MeshoptSimplifier as bounded } from '../../src/vendor/meshoptimizer/simplifier';

describe('bounded remeshing binding', () => {
  it.each([24, 64, 128])('preserves exact output at resolution %s', async (resolution) => {
    await Promise.all([original.ready, bounded.ready]);
    for (const geometry of [new BoxGeometry(10, 8, 6), new SphereGeometry(10, 32, 24)]) {
      const positions = geometry.attributes.position.array as Float32Array;
      const indices = new Uint32Array(geometry.index!.array);
      expect(bounded.remesh(indices, positions, 3, resolution)).toEqual(
        original.remesh(indices, positions, 3, resolution),
      );
    }
  });

  it('rejects truncated output and leaves the heap usable for another attempt', async () => {
    await bounded.ready;
    const geometry = new BoxGeometry(10, 10, 10);
    const positions = geometry.attributes.position.array as Float32Array;
    const indices = new Uint32Array(geometry.index!.array);
    expect(() => bounded.remesh(indices, positions, 3, 32, [], 1)).toThrow('exceeded');
    expect(bounded.remesh(indices, positions, 3, 32)).toEqual(
      original.remesh(indices, positions, 3, 32),
    );
  });
});
