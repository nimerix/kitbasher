import { BufferAttribute, BufferGeometry, Mesh } from 'three';
import type { Intersection, Raycaster } from 'three';
import { acceleratedRaycast, computeBoundsTree, MeshBVH } from 'three-mesh-bvh';
import { triangleCount } from './geometry';
import { useEditor } from './store';

const bvhOptions = { indirect: true, targetLeafSize: 10 } as const;
const indexedTriangles = 30000;
// Building takes about 0.2 s per million triangles, which is too long to hold the main thread.
const workerTriangles = 1000000;

export interface BvhRequest {
  positions: Float32Array;
  index?: Uint8Array | Uint16Array | Uint32Array;
  options: typeof bvhOptions;
}

function buildInWorker(geometry: BufferGeometry) {
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL('./bvh.worker.ts', import.meta.url), { type: 'module' });
    const finish = (error?: string) => {
      worker.terminate();
      if (error === undefined) resolve();
      else reject(new Error(error));
    };
    worker.onmessage = ({ data }) => {
      if (data.error) return finish(data.error);
      geometry.boundsTree = MeshBVH.deserialize(data.bvh, geometry, { setIndex: false });
      finish();
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
  });
}

const building = new WeakSet<BufferGeometry>();
let queue: Promise<void> = Promise.resolve();

export function prepareForPicking(geometry: BufferGeometry) {
  const triangles = triangleCount(geometry);
  if (triangles <= indexedTriangles || geometry.boundsTree || building.has(geometry)) return;
  if (triangles <= workerTriangles) {
    computeBoundsTree.call(geometry, bvhOptions);
    return;
  }
  building.add(geometry);
  const count = (change: number) =>
    useEditor.setState((state) => ({ indexingMeshes: state.indexingMeshes + change }));
  count(1);
  // One at a time, since each build briefly holds another copy of its mesh.
  queue = queue.then(async () => {
    try {
      await buildInWorker(geometry);
    } catch {
      useEditor
        .getState()
        .notify(
          'A dense mesh could not be prepared for clicking. Select it in the parts list.',
          'error',
        );
    } finally {
      building.delete(geometry);
      count(-1);
    }
  });
}

/** Testing every triangle of a dense mesh would freeze each pointer move until its index is built. */
export function pickRaycast(this: Mesh, raycaster: Raycaster, intersects: Intersection[]) {
  if (this.geometry.boundsTree || triangleCount(this.geometry) <= workerTriangles)
    acceleratedRaycast.call(this, raycaster, intersects);
}
