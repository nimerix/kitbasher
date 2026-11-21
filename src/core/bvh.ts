import { BufferAttribute, BufferGeometry, Mesh } from 'three';
import type { Intersection, Raycaster } from 'three';
import { acceleratedRaycast, computeBoundsTree, MeshBVH } from 'three-mesh-bvh';
import { triangleCount } from './geometry';
import { cancelTask, completeTask, failTask, startTask, updateTask } from './activity';
import { useEditor } from './store';
import { spatialIndexOptions as bvhOptions, workerIndexTriangles } from './spatial-index';
import { backgroundWork, meshWorkBytes } from './work-queue';
import { geometryKey } from './geometry-transfer';

const indexedTriangles = 30000;

export interface BvhRequest {
  positions: Float32Array;
  index?: Uint8Array | Uint16Array | Uint32Array;
  options: typeof bvhOptions;
}

/** Geometries whose positions may be edited while their index builds; see prepareEditedForPicking. */
const edited = new WeakSet<BufferGeometry>();

/** What a tree's triangle layout depends on: the attributes and index, not the positions' values. */
function layoutKey(geometry: BufferGeometry) {
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  return [position, position?.count, index, index?.array, index?.count, index?.version];
}
const sameLayout = (a: unknown[], b: unknown[]) => a.every((value, i) => value === b[i]);

/** Thrown when an edited geometry's layout changed while its index was built, so it is built again. */
class LayoutChanged extends Error {}

function buildInWorker(geometry: BufferGeometry, signal: AbortSignal, taskId: string) {
  const key = geometryKey(geometry);
  const layout = layoutKey(geometry);
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return resolve();
    let worker: Worker | undefined;
    let settled = false;
    const finish = (error?: string | Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      worker?.terminate();
      if (error === undefined) resolve();
      else reject(error instanceof Error ? error : new Error(error));
    };
    const cancel = () => finish();
    signal.addEventListener('abort', cancel, { once: true });
    updateTask(taskId, { status: 'running', detail: 'Preparing surface data', progress: null });
    try {
      worker = new Worker(new URL('./bvh.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (settled || signal.aborted) return;
        if (data.type === 'progress') {
          updateTask(taskId, { detail: 'Building surface index', progress: data.progress });
          return;
        }
        if (data.error) return finish(data.error);
        try {
          const moved = geometryKey(geometry) !== key;
          if (moved && edited.has(geometry) && !sameLayout(layout, layoutKey(geometry)))
            throw new LayoutChanged('The mesh changed while preparing its surface index.');
          if (moved && !edited.has(geometry))
            throw new Error('The mesh changed while preparing its surface index.');
          const tree = MeshBVH.deserialize(data.bvh, geometry, { setIndex: false });
          // Its triangles are unchanged, so the tree stands once its bounds follow the edits.
          if (moved) tree.refit();
          geometry.boundsTree = tree;
          finish();
        } catch (error) {
          finish(error instanceof LayoutChanged ? error : (error as Error).message);
        }
      };
      worker.onerror = (event) => finish(event.message || 'The worker stopped.');
      worker.onmessageerror = () => finish('The worker could not return its result.');

      // Copies, because the renderer keeps drawing the mesh while the worker reads it.
      const position = geometry.getAttribute('position');
      let positions: Float32Array;
      if (position instanceof BufferAttribute && position.array instanceof Float32Array) {
        positions = position.array.slice();
      } else {
        positions = new Float32Array(position.count * 3);
        for (let i = 0; i < position.count; i++) {
          positions[i * 3] = position.getX(i);
          positions[i * 3 + 1] = position.getY(i);
          positions[i * 3 + 2] = position.getZ(i);
        }
      }
      const index = geometry.index?.array.slice() as BvhRequest['index'];
      const transfer: Transferable[] = [positions.buffer];
      if (index) transfer.push(index.buffer);
      const request: BvhRequest = { positions, index, options: bvhOptions };
      worker.postMessage(request, transfer);
    } catch (error) {
      finish(error instanceof Error ? error.message : String(error));
    }
  });
}

const building = new WeakSet<BufferGeometry>();

async function buildIndex(geometry: BufferGeometry, signal: AbortSignal, taskId: string) {
  if (
    globalThis.crossOriginIsolated &&
    typeof SharedArrayBuffer !== 'undefined' &&
    triangleCount(geometry) >= 500_000 &&
    navigator.hardwareConcurrency >= 4
  ) {
    try {
      const { buildParallelIndex } = await import('./parallel-bvh');
      await buildParallelIndex(geometry, signal, (progress) =>
        updateTask(taskId, {
          status: 'running',
          detail: 'Building surface index across CPU cores',
          progress,
        }),
      );
      return;
    } catch {
      if (signal.aborted) return;
      // Shared-memory builds can fail under a browser's resource limits.
    }
  }
  await buildInWorker(geometry, signal, taskId);
}

/**
 * As prepareForPicking, for a geometry whose positions are edited in place while its index builds:
 * the finished tree is refitted to the positions of that moment, and an index whose triangles no
 * longer match is built again, so the geometry always ends up indexed.
 */
export function prepareEditedForPicking(geometry: BufferGeometry) {
  edited.add(geometry);
  prepareForPicking(geometry);
}

export function prepareForPicking(geometry: BufferGeometry) {
  const triangles = triangleCount(geometry);
  if (triangles <= indexedTriangles || geometry.boundsTree || building.has(geometry)) return;
  if (triangles <= workerIndexTriangles) {
    computeBoundsTree.call(geometry, bvhOptions);
    return;
  }
  building.add(geometry);
  const controller = new AbortController();
  const name = useEditor.getState().scene.parts.find((part) => part.geometry === geometry)?.name;
  const taskId = startTask({
    title: name ? `Prepare surfaces · ${name}` : 'Prepare surfaces for picking',
    detail: `${triangles.toLocaleString()} triangles · waiting for another mesh`,
    status: 'queued',
    progress: null,
    notify: false,
    cancel: () => controller.abort(),
  });
  controller.signal.addEventListener(
    'abort',
    () => cancelTask(taskId, 'Surface preparation cancelled. Select this mesh in the parts list.'),
    { once: true },
  );
  const dispose = () => controller.abort();
  geometry.addEventListener('dispose', dispose);
  const count = (change: number) =>
    useEditor.setState((state) => ({ indexingMeshes: state.indexingMeshes + change }));
  count(1);
  let rebuild = false;
  void backgroundWork
    .run(
      meshWorkBytes(geometry),
      async () => {
        try {
          await buildIndex(geometry, controller.signal, taskId);
          if (!controller.signal.aborted)
            completeTask(taskId, 'Surface index ready for picking and fitting.');
        } catch (error) {
          if (error instanceof LayoutChanged && !controller.signal.aborted) {
            rebuild = true;
            cancelTask(taskId, 'The mesh changed, so its surface index is built again.');
            return;
          }
          failTask(
            taskId,
            `${error instanceof Error ? error.message : String(error)} Select this mesh in the parts list.`,
          );
        }
      },
      controller.signal,
    )
    .catch((error) => {
      if (!controller.signal.aborted) failTask(taskId, String(error));
    })
    .finally(() => {
      geometry.removeEventListener('dispose', dispose);
      building.delete(geometry);
      count(-1);
      if (rebuild && !controller.signal.aborted) prepareForPicking(geometry);
    });
}

/** Testing every triangle of a dense mesh would freeze each pointer move until its index is built. */
export function pickRaycast(this: Mesh, raycaster: Raycaster, intersects: Intersection[]) {
  if (this.geometry.boundsTree || triangleCount(this.geometry) <= workerIndexTriangles)
    acceleratedRaycast.call(this, raycaster, intersects);
}
