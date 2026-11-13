import { BufferAttribute, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  bakedPartGeometry,
  binaryGeometry,
  combineParts,
  deserializeGeometry,
  drawLimit,
  exceedsDrawLimit,
  triangleCount,
  uid,
} from './geometry';
import type { BinaryGeometry, Part } from './types';
import { cancelTask, completeTask, failTask, startTask, updateTask } from './activity';

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

export interface MergeProgress {
  detail: string;
  progress: number | null;
}
interface MergeOptions {
  signal?: AbortSignal;
  onProgress?: (progress: MergeProgress) => void;
  onWorker?: (worker: Worker) => void;
}
export interface MergeValidationMesh {
  name: string;
  positions: Float32Array | Float64Array;
  indices?: BinaryGeometry['indices'];
}
export type MergeWorkerRequest =
  | { type: 'validate'; meshes: MergeValidationMesh[] }
  | { type: 'evaluate'; meshes: BinaryGeometry[] };

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const cancelled = () => new DOMException('Merge cancelled', 'AbortError');

/** Capture exact positions for the original local-space closed-surface check. */
function validationMesh(part: Part): MergeValidationMesh {
  const position = part.geometry.getAttribute('position');
  let positions: Float32Array | Float64Array;
  if (
    position instanceof BufferAttribute &&
    !position.normalized &&
    position.itemSize === 3 &&
    (position.array instanceof Float32Array || position.array instanceof Float64Array)
  )
    positions = position.array;
  else {
    positions = new Float64Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      positions[i * 3] = position.getX(i);
      positions[i * 3 + 1] = position.getY(i);
      positions[i * 3 + 2] = position.getZ(i);
    }
  }
  return {
    name: part.name,
    positions,
    indices: part.geometry.index?.array as BinaryGeometry['indices'],
  };
}

function unionInWorker(
  parts: Part[],
  signal: AbortSignal,
  progress: (value: MergeProgress) => void,
  onWorker?: (worker: Worker) => void,
) {
  return new Promise<BinaryGeometry>((resolve, reject) => {
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
    const bake = async () => {
      const meshes: BinaryGeometry[] = [];
      for (let i = 0; i < parts.length; i++) {
        if (settled) return;
        progress({
          detail: `Preparing transforms and colors · ${i + 1} of ${parts.length} parts`,
          progress: i / parts.length,
        });
        await yieldToUi();
        if (settled) return;
        const geometry = bakedPartGeometry(parts[i]);
        try {
          meshes.push(binaryGeometry(geometry));
        } finally {
          geometry.dispose();
        }
      }
      if (settled) return;
      progress({ detail: 'Fusing volumes', progress: null });
      // Only these temporary baked buffers are transferred. Source meshes remain owned by the editor.
      const transfer = [
        ...new Set(
          meshes.flatMap((mesh) =>
            Object.values(mesh)
              .filter((array) => array !== undefined)
              .map((array) => array.buffer),
          ),
        ),
      ];
      worker!.postMessage({ type: 'evaluate', meshes } satisfies MergeWorkerRequest, transfer);
    };
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
          void bake().catch(fail);
          return;
        }
        if (data.error) return fail(new Error(data.error));
        if (finish()) resolve(data.result);
      };
      worker.onerror = (event) => fail(new Error(event.message || 'The Boolean worker stopped.'));
      worker.onmessageerror = () =>
        fail(new Error('The Boolean worker returned an unreadable result.'));
      onWorker?.(worker);
      if (settled) return;
      progress({ detail: 'Checking closed surfaces', progress: null });
      // Structured cloning copies these source buffers; they are never transferred or detached.
      worker.postMessage({
        type: 'validate',
        meshes: parts.map(validationMesh),
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
  let geometry: BufferGeometry | undefined;
  try {
    if (mode === 'union') parts.forEach(assertUnionSize);
    await yieldToUi();
    if (controller.signal.aborted) throw cancelled();
    if (mode === 'combine') {
      progress({ detail: `Combining ${parts.length} meshes`, progress: null });
      geometry = combineParts(parts);
    } else {
      const result = await unionInWorker(parts, controller.signal, progress, settings.onWorker);
      if (controller.signal.aborted) throw cancelled();
      progress({ detail: 'Preparing merged mesh', progress: null });
      geometry = deserializeGeometry(result);
    }
    if (controller.signal.aborted) throw cancelled();
    const part = mergedPart(
      geometry,
      name,
      `${mode === 'union' ? 'Boolean union' : 'Combined'} · ${parts.length} parts`,
    );
    geometry = undefined;
    completeTask(taskId, 'Merged mesh ready to apply.');
    return part;
  } catch (error) {
    geometry?.dispose();
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
