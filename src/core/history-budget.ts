import type { BufferGeometry, InterleavedBufferAttribute } from 'three';
import type { SceneDocument } from './types';

export const historyBudgetBytes = 1024 ** 3;

function arrays(geometry: BufferGeometry) {
  const found: ArrayLike<number>[] = [];
  for (const attribute of Object.values(geometry.attributes))
    found.push(
      (attribute as InterleavedBufferAttribute).isInterleavedBufferAttribute
        ? (attribute as InterleavedBufferAttribute).data.array
        : (attribute as { array: ArrayLike<number> }).array,
    );
  if (geometry.index) found.push(geometry.index.array);
  return found;
}

/** Bytes of attribute and index arrays, each array counted once, skipping arrays in `exclude`. */
export function geometryBytes(
  geometries: Iterable<BufferGeometry>,
  exclude: Set<ArrayLike<number>> = new Set(),
) {
  const seen = new Set<ArrayLike<number>>(exclude);
  let bytes = 0;
  for (const geometry of geometries)
    for (const array of arrays(geometry)) {
      if (seen.has(array)) continue;
      seen.add(array);
      bytes += (array as { byteLength?: number }).byteLength ?? 0;
    }
  return bytes;
}

export function arraysOf(geometries: Iterable<BufferGeometry>) {
  const set = new Set<ArrayLike<number>>();
  for (const geometry of geometries) for (const array of arrays(geometry)) set.add(array);
  return set;
}

const sceneGeometries = (scenes: SceneDocument[]) =>
  scenes.flatMap((scene) => scene.parts.map((part) => part.geometry));

/**
 * Drops the oldest `past` entry, then the farthest `future` entry, until the arrays that only
 * history reaches fit the budget. The newest `past` entry always stays.
 */
export function trimHistory(
  past: SceneDocument[],
  future: SceneDocument[],
  keep: SceneDocument[],
  budget = historyBudgetBytes,
) {
  const kept = arraysOf(sceneGeometries(keep));
  const bytes = (p: SceneDocument[], f: SceneDocument[]) =>
    geometryBytes(sceneGeometries([...p, ...f]), kept);
  let start = 0;
  let end = future.length;
  while (bytes(past.slice(start), future.slice(0, end)) > budget) {
    if (past.length - start > 1) start++;
    else if (end > 0) end--;
    else break;
  }
  const trimmed = start > 0 || end < future.length;
  return trimmed
    ? { past: past.slice(start), future: future.slice(0, end), trimmed }
    : { past, future, trimmed };
}
