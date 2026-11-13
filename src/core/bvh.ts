import { BufferAttribute, BufferGeometry, Mesh } from 'three';
import type { Intersection, Raycaster } from 'three';
import { acceleratedRaycast, computeBoundsTree, MeshBVH } from 'three-mesh-bvh';
import { triangleCount } from './geometry';
import { cancelTask, completeTask, failTask, startTask, updateTask } from './activity';
import { useEditor } from './store';
import { spatialIndexOptions as bvhOptions, workerIndexTriangles } from './spatial-index';

const indexedTriangles = 30000;

export interface BvhRequest {
  positions: Float32Array;
  index?: Uint8Array | Uint16Array | Uint32Array;
  options: typeof bvhOptions;
}

function buildInWorker(geometry: BufferGeometry, signal: AbortSignal, taskId: string) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return resolve();
    let worker: Worker | undefined;
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      worker?.terminate();
      if (error === undefined) resolve();
      else reject(new Error(error));
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
          geometry.boundsTree = MeshBVH.deserialize(data.bvh, geometry, { setIndex: false });
          finish();
        } catch (error) {
          finish((error as Error).message);
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
let queue: Promise<void> = Promise.resolve();

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
  // One at a time, since each build briefly holds another copy of its mesh.
  queue = queue.then(async () => {
    try {
      await buildInWorker(geometry, controller.signal, taskId);
      if (!controller.signal.aborted)
        completeTask(taskId, 'Surface index ready for picking and fitting.');
    } catch (error) {
      failTask(
        taskId,
        `${error instanceof Error ? error.message : String(error)} Select this mesh in the parts list.`,
      );
    } finally {
      geometry.removeEventListener('dispose', dispose);
      building.delete(geometry);
      count(-1);
    }
  });
}

/** Testing every triangle of a dense mesh would freeze each pointer move until its index is built. */
export function pickRaycast(this: Mesh, raycaster: Raycaster, intersects: Intersection[]) {
  if (this.geometry.boundsTree || triangleCount(this.geometry) <= workerIndexTriangles)
    acceleratedRaycast.call(this, raycaster, intersects);
}
