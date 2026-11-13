import type { BufferGeometry } from 'three';
import { binaryGeometry, deserializeGeometry } from './geometry';
import type { MeshProcessOptions } from './mesh-processing';
import { cancelTask, completeTask, failTask, startTask, updateTask } from './activity';

interface MeshJobActivity {
  /** A queued owner can supply its task and retain responsibility for its final state. */
  taskId?: string;
  title?: string;
  notify?: boolean;
  onTask?: (id: string) => void;
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
    let settled = false;
    let taskId: string;
    const owned = !activity.taskId;
    const finish = () => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      worker?.terminate();
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
          const result = { geometry: deserializeGeometry(data.mesh), error: data.error };
          finish();
          if (owned) completeTask(taskId, 'Mesh ready to review and apply.');
          resolve(result);
        } catch (error) {
          fail(error);
        }
      };
      worker.onerror = (event) => fail(new Error(event.message || 'Mesh processing failed.'));
      worker.onmessageerror = () =>
        fail(new Error('The mesh worker returned an unreadable result.'));
      worker.postMessage({ mesh: binaryGeometry(geometry), options });
    } catch (error) {
      fail(error);
    }
  });
}
