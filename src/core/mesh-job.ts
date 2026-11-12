import type { BufferGeometry } from 'three';
import { binaryGeometry, deserializeGeometry } from './geometry';
import type { MeshProcessOptions } from './mesh-processing';

/** Never transfer the scene's buffers: exports, undo and picking continue to own them. */
export function processMeshInWorker(
  geometry: BufferGeometry,
  options: MeshProcessOptions,
  signal?: AbortSignal,
) {
  return new Promise<{ geometry: BufferGeometry; error: number | null }>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    const worker = new Worker(new URL('./mesh-processing.worker.ts', import.meta.url), {
      type: 'module',
    });
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      worker.terminate();
    };
    const cancel = () => {
      finish();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      finish();
      reject(
        new Error(
          'Mesh processing exceeded two minutes. Try a smaller scan or lower voxel resolution.',
        ),
      );
    }, 120_000);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data }) => {
      finish();
      try {
        if (data.errorMessage) throw new Error(data.errorMessage);
        resolve({ geometry: deserializeGeometry(data.mesh), error: data.error });
      } catch (error) {
        reject(error);
      }
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || 'Mesh processing failed.'));
    };
    worker.onmessageerror = () => {
      finish();
      reject(new Error('The mesh worker returned an unreadable result.'));
    };
    try {
      worker.postMessage({ mesh: binaryGeometry(geometry), options });
    } catch (error) {
      finish();
      reject(error);
    }
  });
}
