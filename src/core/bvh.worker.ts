/// <reference lib="webworker" />
import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { BvhRequest } from './bvh';

self.onmessage = ({ data: { positions, index, options } }: MessageEvent<BvhRequest>) => {
  try {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    if (index) geometry.setIndex(new BufferAttribute(index, 1));
    const serialized = MeshBVH.serialize(new MeshBVH(geometry, options), { cloneBuffers: false });
    const bvh = { ...serialized, index: null };
    const transfer: Transferable[] = [...bvh.roots];
    if (bvh.indirectBuffer) transfer.push(bvh.indirectBuffer.buffer);
    self.postMessage({ bvh }, { transfer });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
