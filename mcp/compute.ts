import { Worker } from 'node:worker_threads';
import { WorkQueue } from '../src/core/work-queue';
import { useNativeMesh, runNativeKernel } from './native-mesh';
import type { ComputeRequest, ComputeResults } from './compute-types';
import type { NativeKernelRequest } from './native-mesh';

const queue = new WorkQueue(2, 512 * 1024 * 1024);
const idle: { worker: Worker; timer: ReturnType<typeof setTimeout> }[] = [];
export function releaseComputeWorkers() {
  for (const entry of idle) {
    clearTimeout(entry.timer);
    void entry.worker.terminate();
  }
  idle.length = 0;
}

export function runCompute<T extends ComputeRequest>(
  request: T,
  signal?: AbortSignal,
): Promise<ComputeResults[T['kind']]> {
  const bytes =
    request.kind === 'process'
      ? Object.values(request.mesh).reduce((sum, a) => sum + (a?.byteLength ?? 0), 0) * 4 +
        36 * 1024 * 1024
      : request.kind === 'merge'
        ? request.parts.reduce(
            (sum, p) =>
              sum +
              Object.values(p.geometry.attributes).reduce((n, a) => n + a.array.byteLength, 0) * 5 +
              (p.geometry.index?.array.byteLength ?? 0) * 6,
            36 * 1024 * 1024,
          )
        : request.request.meshes.reduce(
            (sum, p) => sum + p.positions.byteLength * 6 + (p.indices?.byteLength ?? 0) * 4,
            36 * 1024 * 1024,
          );
  return queue.run(
    bytes,
    () =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
        const entry = idle.pop();
        if (entry) clearTimeout(entry.timer);
        const worker =
          entry?.worker ??
          new Worker(
            new URL(
              import.meta.url.endsWith('.ts')
                ? '../dist-mcp/kitbasher-compute.js'
                : './kitbasher-compute.js',
              import.meta.url,
            ),
          );
        worker.removeAllListeners();
        worker.ref();
        const nativeController = new AbortController();
        let settled = false;
        const finish = (error?: Error, value?: ComputeResults[T['kind']]) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', abort);
          nativeController.abort();
          worker.removeAllListeners();
          if (error) {
            void worker.terminate();
            reject(error);
          } else {
            if (bytes <= 128 * 1024 * 1024 && idle.length < 2) {
              const item = {
                worker,
                timer: setTimeout(() => {
                  const i = idle.indexOf(item);
                  if (i >= 0) idle.splice(i, 1);
                  void worker.terminate();
                }, 30_000),
              };
              const discard = () => {
                clearTimeout(item.timer);
                const i = idle.indexOf(item);
                if (i >= 0) idle.splice(i, 1);
                void worker.terminate();
              };
              worker.on('error', discard);
              worker.on('exit', discard);
              item.timer.unref();
              worker.unref();
              idle.push(item);
            } else void worker.terminate();
            resolve(value!);
          }
        };
        const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        worker.on('error', (error) =>
          finish(error instanceof Error ? error : new Error(String(error))),
        );
        worker.on('exit', (code) => finish(new Error(`Mesh worker stopped (${code}).`)));
        worker.on(
          'message',
          async (message: {
            type: string;
            request?: NativeKernelRequest;
            value?: ComputeResults[T['kind']];
            error?: string;
          }) => {
            if (settled) return;
            if (message.type === 'native') {
              try {
                const value = await runNativeKernel(message.request!, nativeController.signal);
                if (!settled) worker.postMessage({ type: 'native-result', value });
              } catch (error) {
                if (!settled)
                  worker.postMessage({ type: 'native-result', error: (error as Error).message });
              }
            } else if (message.type === 'error') finish(new Error(message.error));
            else if (message.type === 'result') finish(undefined, message.value);
          },
        );
        const native =
          request.kind === 'process' &&
          useNativeMesh(
            request.options?.mode,
            (request.mesh.indices?.length ?? request.mesh.positions.length / 3) / 3,
          );
        try {
          worker.postMessage({ type: 'run', request, native });
        } catch (error) {
          finish(error as Error);
        }
      }),
    signal,
  );
}
