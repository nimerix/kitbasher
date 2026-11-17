import { buildWarpModel, type WarpModel, type WarpModelInput } from './warp-model';

const cancelled = () => new DOMException('Warp cancelled', 'AbortError');

/** Builds in a worker when available, in-thread otherwise. Transfers the input arrays to the worker. */
export function buildWarpModelJob(input: WarpModelInput, signal: AbortSignal): Promise<WarpModel> {
  if (signal.aborted) return Promise.reject(cancelled());
  if (typeof Worker === 'undefined')
    return buildWarpModel(input).then((model) => {
      if (signal.aborted) throw cancelled();
      return model;
    });

  return new Promise<WarpModel>((resolve, reject) => {
    let worker: Worker | undefined;
    let settled = false;
    const finish = (error?: unknown, model?: WarpModel) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      worker?.terminate();
      if (model) resolve(model);
      else reject(error);
    };
    const cancel = () => finish(cancelled());
    signal.addEventListener('abort', cancel, { once: true });
    try {
      worker = new Worker(new URL('./warp.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (data.error) finish(new Error(data.error));
        else finish(undefined, data.model);
      };
      worker.onerror = (event) => finish(new Error(event.message || 'The warp worker stopped.'));
      worker.onmessageerror = () =>
        finish(new Error('The warp worker returned an unreadable result.'));
      const transfer = new Set<ArrayBufferLike>([input.positions.buffer]);
      if (input.index) transfer.add(input.index.buffer);
      if (input.normals) transfer.add(input.normals.buffer);
      worker.postMessage(input, [...transfer] as ArrayBuffer[]);
    } catch (error) {
      finish(error);
    }
  });
}
