import { Vector3 } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  bakedPartGeometry,
  binaryGeometry,
  combineParts,
  deserializeGeometry,
  uid,
} from './geometry';
import type { BinaryGeometry, Part } from './types';

/** Reject open/non-manifold inputs before attempting a solid Boolean. */
export function assertClosed(part: Part) {
  const geometry = part.geometry.clone();
  for (const name of Object.keys(geometry.attributes))
    if (name !== 'position') geometry.deleteAttribute(name);
  const welded = mergeVertices(geometry, 1e-5);
  geometry.dispose();
  const index = welded.index!,
    edges = new Map<string, number>();
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i),
      b = index.getX(i + 1),
      c = index.getX(i + 2);
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  welded.dispose();
  if ([...edges.values()].some((count) => count !== 2))
    throw new Error(
      `${part.name} has open or non-manifold edges. Use Combine meshes, or repair the scan before a Boolean union.`,
    );
}

export async function mergeParts(
  parts: Part[],
  mode: 'combine' | 'union',
  name: string,
  onWorker?: (worker: Worker) => void,
): Promise<Part> {
  if (parts.length < 2) throw new Error('Select at least two parts to merge.');
  let geometry;
  if (mode === 'combine') geometry = combineParts(parts);
  else {
    parts.forEach(assertClosed);
    const worker = new Worker(new URL('./merge.worker.ts', import.meta.url), { type: 'module' });
    onWorker?.(worker);
    const meshes = parts.map((part) => {
      const geometry = bakedPartGeometry(part);
      const data = binaryGeometry(geometry);
      geometry.dispose();
      return data;
    });
    try {
      const result = await new Promise<BinaryGeometry>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          worker.terminate();
          reject(
            new Error('Boolean union exceeded 90 seconds. Try fewer parts or simplify the scan.'),
          );
        }, 90000);
        worker.onmessage = (event) => {
          clearTimeout(timeout);
          event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result);
        };
        worker.onerror = (event) => {
          clearTimeout(timeout);
          reject(new Error(event.message || 'The Boolean worker stopped.'));
        };
        worker.postMessage({ meshes });
      });
      geometry = deserializeGeometry(result);
    } finally {
      worker.terminate();
    }
  }
  // Recenter the local origin without moving the surface in world space.
  geometry.computeBoundingBox();
  const center = geometry.boundingBox!.getCenter(new Vector3());
  geometry.translate(-center.x, -center.y, -center.z);
  return {
    id: uid(),
    name: name.trim() || 'Merged assembly',
    geometry,
    position: center.toArray(),
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#ffffff',
    visible: true,
    locked: false,
    source: `${mode === 'union' ? 'Boolean union' : 'Combined'} · ${parts.length} parts`,
  };
}
