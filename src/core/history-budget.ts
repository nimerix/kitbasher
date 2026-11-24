import type { BufferAttribute } from 'three';
import { SculptGeometrySnapshot, type HistoryGeometry, type HistoryScene } from './sculpt-history';

export const historyLimit = 120;

export const historyBudgetBytes = 1024 ** 3;

function arrays(geometry: HistoryGeometry) {
  if (geometry instanceof SculptGeometrySnapshot) return geometry.arrays;
  const found: BufferAttribute['array'][] = [];
  for (const attribute of Object.values(geometry.attributes)) found.push(attribute.array);
  if (geometry.index) found.push(geometry.index.array);
  return found;
}

/** Bytes of attribute and index arrays, each array counted once, skipping arrays in `exclude`. */
export function geometryBytes(
  geometries: Iterable<HistoryGeometry>,
  exclude: Set<BufferAttribute['array']> = new Set(),
) {
  const seen = new Set(exclude);
  let bytes = 0;
  for (const geometry of geometries)
    for (const array of arrays(geometry)) {
      if (seen.has(array)) continue;
      seen.add(array);
      bytes += array.byteLength;
    }
  return bytes;
}

export function buffersOf(geometries: Iterable<HistoryGeometry>) {
  const set = new Set<ArrayBufferLike>();
  for (const geometry of geometries) for (const array of arrays(geometry)) set.add(array.buffer);
  return set;
}

const sceneGeometries = (scenes: HistoryScene[]) =>
  scenes.flatMap((scene) => scene.parts.map((part) => part.geometry));

/**
 * Drops the oldest `past` entry, then the farthest `future` entry, until the arrays that only
 * history reaches fit the budget. The newest `past` entry always stays.
 */
export function trimHistory(
  past: HistoryScene[],
  future: HistoryScene[],
  keep: HistoryScene[],
  budget = historyBudgetBytes,
) {
  const kept = buffersOf(sceneGeometries(keep));
  // Visit in retention order, so even a large eviction only walks each checkpoint once.
  let bytes = 0;
  const seen = new Set<HistoryGeometry>();
  const count = (scene: HistoryScene) => {
    for (const part of scene.parts) {
      if (seen.has(part.geometry)) continue;
      seen.add(part.geometry);
      for (const array of arrays(part.geometry)) {
        if (kept.has(array.buffer)) continue;
        kept.add(array.buffer);
        bytes += array.buffer.byteLength;
      }
    }
    return bytes <= budget;
  };
  let start = past.length;
  if (start) count(past[--start]);
  let end = 0;
  while (end < future.length && count(future[end])) end++;
  if (end === future.length) while (start > 0 && count(past[start - 1])) start--;
  const trimmed = start > 0 || end < future.length;
  return trimmed
    ? { past: past.slice(start), future: future.slice(0, end), trimmed }
    : { past, future, trimmed };
}
