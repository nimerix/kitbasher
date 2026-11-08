import { expect, it, vi } from 'vitest';
import { BufferAttribute, BufferGeometry } from 'three';
import { mergeParts } from '../../src/core/merge';
import type { Part } from '../../src/core/types';

vi.mock('../../src/core/geometry', async (original) => ({
  ...(await original<typeof import('../../src/core/geometry')>()),
  combineParts: () => {
    const geometry = new BufferGeometry();
    geometry.attributes.position = {
      array: { byteLength: 2 ** 31 },
    } as unknown as BufferAttribute;
    return geometry;
  },
}));

it('refuses to merge meshes into one too large to draw', async () => {
  await expect(mergeParts([{} as Part, {} as Part], 'combine', 'Too large')).rejects.toThrow(
    'merged mesh would be too large for a browser to draw',
  );
});

it('refuses a Boolean union of a part too dense to check', async () => {
  const geometry = new BufferGeometry();
  geometry.attributes.position = { count: 30_000_003 } as unknown as BufferAttribute;
  const part = { name: 'Dense scan', geometry } as Part;
  await expect(mergeParts([part, part], 'union', 'Too large')).rejects.toThrow(
    'Dense scan has too many triangles for a Boolean union',
  );
});
