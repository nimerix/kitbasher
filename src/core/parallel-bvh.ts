import type { BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { BVHOptions } from 'three-mesh-bvh';
import { ParallelMeshBVHWorker } from 'three-mesh-bvh/worker';
import { geometryKey } from './geometry-transfer';
import { spatialIndexOptions } from './spatial-index';

// 0.9.18's generate() creates an unhandled rejected promise with an ignored finally().
// Invoke its single-job implementation directly so resource-limit failures can fall back.
// Keep this adapter isolated and regression-tested when upgrading three-mesh-bvh.
type Runner = ParallelMeshBVHWorker & {
  worker: Worker;
  runTask(worker: Worker, geometry: BufferGeometry, options: BVHOptions): Promise<MeshBVH>;
};

export async function buildParallelIndex(
  geometry: BufferGeometry,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
) {
  if (signal.aborted) return;
  const worker = new ParallelMeshBVHWorker() as Runner;
  worker.maxWorkerCount = 2;
  const copy = geometry.clone(),
    key = geometryKey(geometry);
  let disposed = false;
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      worker.dispose();
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      // A failed nested worker can leave the upstream async handler without a reply.
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        dispose();
        reject(new Error('Parallel surface preparation stopped responding.'));
      }, 30_000);
      const abort = () => {
        clearTimeout(timeout);
        dispose();
        resolve();
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        signal.removeEventListener('abort', abort);
        return abort();
      }
      try {
        worker
          .runTask(worker.worker, copy, { ...spatialIndexOptions, onProgress })
          .then((tree) => {
            if (!signal.aborted) {
              if (geometryKey(geometry) !== key) throw new Error('Mesh changed while indexing.');
              const data = MeshBVH.serialize(tree, { cloneBuffers: false });
              geometry.boundsTree = MeshBVH.deserialize({ ...data, index: null }, geometry, {
                setIndex: false,
              });
            }
            resolve();
          })
          .catch(reject)
          .finally(() => {
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
          });
      } catch (error) {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    });
  } finally {
    dispose();
    copy.dispose();
  }
}
