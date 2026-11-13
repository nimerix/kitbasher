import { BufferGeometry, Vector3 } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { drawLimit, exceedsDrawLimit, triangleCount, uid } from './geometry';
import type { Part } from './types';
import { cancelTask, completeTask, failTask, startTask, updateTask } from './activity';
import { hasClosedEdges, weldedPositionIndex } from './mesh-topology';
import { geometryKey, restoreGeometry, snapshotGeometry } from './geometry-transfer';
import type { GeometrySnapshot } from './geometry-transfer';

// Bound memory use while checking every edge of a solid.
const maxUnionTriangles = 10_000_000;

function assertUnionSize(part: Part) {
  if (triangleCount(part.geometry) > maxUnionTriangles)
    throw new Error(
      `${part.name} has too many triangles for a Boolean union. The limit is 10 million per part. Use Combine meshes instead.`,
    );
}

/** Reject open/non-manifold inputs before attempting a solid Boolean. */
export function assertClosed(part: Part) {
  assertUnionSize(part);
  const key = geometryKey(part.geometry);
  if (validated.get(part.geometry) === key) return;
  let closed: boolean;
  if (part.geometry.getAttribute('position').itemSize === 3) {
    const { indices, vertices } = weldedPositionIndex(part.geometry);
    closed = hasClosedEdges(indices, vertices);
  } else {
    const geometry = new BufferGeometry().setAttribute(
      'position',
      part.geometry.getAttribute('position'),
    );
    geometry.setIndex(part.geometry.index);
    const welded = mergeVertices(geometry, 1e-5);
    closed = hasClosedEdges(welded.index!.array, welded.getAttribute('position').count);
    welded.dispose();
    geometry.dispose();
  }
  if (!closed)
    throw new Error(
      `${part.name} has open or non-manifold edges. Use Combine meshes, or repair the scan before a Boolean union.`,
    );
  validated.set(part.geometry, key);
}

export interface MergeProgress {
  detail: string;
  progress: number | null;
}
interface MergeOptions {
  signal?: AbortSignal;
  onProgress?: (progress: MergeProgress) => void;
  onWorker?: (worker: Worker) => void;
}
export interface MergeWorkerRequest {
  mode: 'combine' | 'union';
  name: string;
  parts: (Pick<Part, 'name' | 'position' | 'quaternion' | 'scale' | 'color'> & {
    geometry: GeometrySnapshot;
    key: string;
    validated: boolean;
  })[];
}

const validated = new WeakMap<BufferGeometry, string>();
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const cancelled = () => new DOMException('Merge cancelled', 'AbortError');

function mergeInWorker(
  parts: Part[],
  mode: 'combine' | 'union',
  name: string,
  signal: AbortSignal,
  progress: (value: MergeProgress) => void,
  onWorker?: (worker: Worker) => void,
) {
  return new Promise<Part>((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    let worker: Worker | undefined;
    let terminate = () => {};
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener('abort', cancel);
      terminate();
      return true;
    };
    const fail = (error: unknown) => {
      if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
    };
    const cancel = () => fail(cancelled());
    signal.addEventListener('abort', cancel, { once: true });
    const keys = parts.map((part) => geometryKey(part.geometry));
    try {
      worker = new Worker(new URL('./merge.worker.ts', import.meta.url), { type: 'module' });
      terminate = worker.terminate.bind(worker);
      // Preserve the old worker callback, including cancellation by calling terminate().
      worker.terminate = cancel;
      worker.onmessage = ({ data }) => {
        if (settled) return;
        if (data.type === 'progress') {
          progress(data.progress);
          return;
        }
        if (data.type === 'validated') {
          for (const i of data.indices as number[])
            if (parts[i] && geometryKey(parts[i].geometry) === keys[i])
              validated.set(parts[i].geometry, keys[i]);
          return;
        }
        if (data.error) return fail(new Error(data.error));
        try {
          const geometry = restoreGeometry(data.geometry);
          if (finish()) resolve({ ...data.part, geometry });
          else geometry.dispose();
        } catch (error) {
          fail(error);
        }
      };
      worker.onerror = (event) => fail(new Error(event.message || 'The Boolean worker stopped.'));
      worker.onmessageerror = () =>
        fail(new Error('The Boolean worker returned an unreadable result.'));
      onWorker?.(worker);
      if (settled) return;
      progress({ detail: 'Preparing meshes in background', progress: null });
      // One clone of source data. Validation, transforms, colors, merging, normals
      // and bounds all run in the worker; no baked meshes return to the UI midway.
      worker.postMessage({
        mode,
        name,
        parts: parts.map((part, i) => ({
          name: part.name,
          position: part.position,
          quaternion: part.quaternion,
          scale: part.scale,
          color: part.color,
          geometry: snapshotGeometry(part.geometry),
          key: keys[i],
          validated: validated.get(part.geometry) === keys[i],
        })),
      } satisfies MergeWorkerRequest);
    } catch (error) {
      fail(error);
    }
  });
}

export async function mergeParts(
  parts: Part[],
  mode: 'combine' | 'union',
  name: string,
  options: MergeOptions | ((worker: Worker) => void) = {},
): Promise<Part> {
  if (parts.length < 2) throw new Error('Select at least two parts to merge.');
  const settings = typeof options === 'function' ? { onWorker: options } : options;
  if (settings.signal?.aborted) throw cancelled();
  const controller = new AbortController();
  const abort = () => controller.abort();
  settings.signal?.addEventListener('abort', abort, { once: true });
  const taskId = startTask({
    title: mode === 'union' ? 'Boolean union' : 'Combine meshes',
    detail: `Preparing ${parts.length} parts`,
    progress: null,
    cancel: abort,
    notify: false,
  });
  const progress = (value: MergeProgress) => {
    updateTask(taskId, value);
    settings.onProgress?.(value);
  };
  try {
    if (mode === 'union') parts.forEach(assertUnionSize);
    await yieldToUi();
    if (controller.signal.aborted) throw cancelled();
    const part = await mergeInWorker(
      parts,
      mode,
      name,
      controller.signal,
      progress,
      settings.onWorker,
    );
    if (controller.signal.aborted) {
      part.geometry.dispose();
      throw cancelled();
    }
    completeTask(taskId, 'Merged mesh ready to apply.');
    return part;
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
      cancelTask(taskId, 'Merge cancelled. Original parts retained.');
    else failTask(taskId, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    settings.signal?.removeEventListener('abort', abort);
  }
}

/** Wraps world-space merged geometry in a part, without moving the surface. */
export function mergedPart(geometry: BufferGeometry, name: string, source: string): Part {
  if (exceedsDrawLimit(geometry)) {
    geometry.dispose();
    throw new Error(
      `The merged mesh would be too large for a browser to draw. ${drawLimit} Merge fewer parts.`,
    );
  }
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
    source,
  };
}
