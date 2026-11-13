import type { BufferGeometry } from 'three';
import { liveSession } from './store';
import { processMeshLocally } from './local-mesh';
import { binaryGeometry } from './geometry';
import { geometryKey, restoreGeometry } from './geometry-transfer';
import type { MeshProcessOptions } from './mesh-processing';
import { cancelTask, completeTask, failTask, startTask, updateTask } from './activity';

interface MeshJobActivity {
  /** A queued owner can supply its task and retain responsibility for its final state. */
  taskId?: string;
  title?: string;
  notify?: boolean;
  onTask?: (id: string) => void;
}

// Retain at most one idle worker, for at most 30 seconds. Large jobs release their
// WASM heaps immediately; source disposal also evicts the worker's prepared copy.
let idle: { worker: Worker; key: string; release: () => void; claim: () => void } | undefined;
export function releaseIdleMeshWorker() {
  idle?.release();
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', releaseIdleMeshWorker);

function keepWorker(worker: Worker, source: BufferGeometry, key: string) {
  idle?.release();
  const entry = {
    worker,
    key,
    release: () => {
      entry.claim();
      worker.terminate();
    },
    claim: () => {
      clearTimeout(timer);
      source.removeEventListener('dispose', entry.release);
      if (idle === entry) idle = undefined;
    },
  };
  const timer = setTimeout(entry.release, 30_000);
  source.addEventListener('dispose', entry.release);
  idle = entry;
}

/** Never transfer the scene's buffers: exports, undo and picking continue to own them. */
export function processMeshInWorker(
  geometry: BufferGeometry,
  options: MeshProcessOptions,
  signal?: AbortSignal,
  activity: MeshJobActivity = {},
) {
  return new Promise<{ geometry: BufferGeometry; error: number | null }>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    let worker: Worker | undefined;
    const localController = new AbortController();
    let settled = false;
    let taskId: string;
    const key = geometryKey(geometry);
    let reusable = false;
    let disposed = false;
    const dispose = () => {
      disposed = true;
    };
    geometry.addEventListener('dispose', dispose);
    const owned = !activity.taskId;
    const finish = (success = false) => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      localController.abort();
      geometry.removeEventListener('dispose', dispose);
      if (success && reusable && !disposed && worker) {
        keepWorker(worker, geometry, key);
      } else worker?.terminate();
      return true;
    };
    const cancel = () => {
      if (!finish()) return;
      if (owned) cancelTask(taskId, 'Mesh processing cancelled.');
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    const fail = (error: unknown) => {
      if (!finish()) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      if (owned) failTask(taskId, failure.message);
      reject(failure);
    };
    taskId =
      activity.taskId ??
      startTask({
        title: activity.title ?? (options.mode === 'decimate' ? 'Reduce mesh' : 'Remesh surface'),
        detail: 'Preparing mesh data',
        progress: null,
        cancel,
        notify: activity.notify,
      });
    updateTask(taskId, { status: 'running', detail: 'Preparing mesh data', progress: null });
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      activity.onTask?.(taskId);
      if (settled) return;
      const startWorker = () => {
        if (settled) return;
        const previous = idle;
        const reuse = previous?.key === key;
        if (previous) {
          previous.claim();
          worker = previous.worker;
        } else
          worker = new Worker(new URL('./mesh-processing.worker.ts', import.meta.url), {
            type: 'module',
          });
        worker.onmessage = ({ data }) => {
          if (settled) return;
          if (data.type === 'progress') {
            updateTask(taskId, { detail: data.detail, progress: null });
            return;
          }
          try {
            if (data.errorMessage) throw new Error(data.errorMessage);
            const result = { geometry: restoreGeometry(data.geometry), error: data.error };
            finish(true);
            if (owned) completeTask(taskId, 'Mesh ready to review and apply.');
            resolve(result);
          } catch (error) {
            fail(error);
          }
        };
        worker.onerror = (event) => fail(new Error(event.message || 'Mesh processing failed.'));
        worker.onmessageerror = () =>
          fail(new Error('The mesh worker returned an unreadable result.'));
        const mesh = reuse ? undefined : binaryGeometry(geometry);
        const size = mesh
          ? Object.values(mesh).reduce((sum, array) => sum + (array?.byteLength ?? 0), 0)
          : 0;
        reusable = size <= 128 * 1024 * 1024;
        worker.postMessage({ mesh, key, retain: reusable, options });
      };
      if (liveSession) {
        void processMeshLocally(geometry, options, localController.signal)
          .then((result) => {
            if (settled) {
              result?.geometry.dispose();
              return;
            }
            if (!result) return startWorker();
            finish(true);
            if (owned) completeTask(taskId, 'Mesh ready to review and apply.');
            resolve(result);
          })
          .catch(fail);
      } else startWorker();
    } catch (error) {
      fail(error);
    }
  });
}
