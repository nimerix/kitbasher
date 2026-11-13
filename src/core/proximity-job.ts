import type { GeometrySnapshot } from './geometry-transfer';
import { snapshotGeometry } from './geometry-transfer';
import type { FieldLimits, ProximityField, ProximitySource } from './proximity';
import { fieldLimits } from './proximity';
import { backgroundWork, meshWorkBytes } from './work-queue';

export interface ProximityRequest {
  sources: { geometry: GeometrySnapshot; matrix: number[] }[];
  reach: number;
  limits: FieldLimits;
  gpu?: boolean;
  /** Tests can exercise WGSL on SwiftShader; production requires a hardware adapter. */
  allowSoftware?: boolean;
}

/** Source arrays are cloned by postMessage. Cancellation terminates both CPU work and GPU submission. */
export function bakeProximityInWorker(
  sources: ProximitySource[],
  reach: number,
  limits = fieldLimits,
  signal?: AbortSignal,
  options: Pick<ProximityRequest, 'gpu' | 'allowSoftware'> = {},
) {
  return backgroundWork.run(
    sources.reduce((sum, source) => sum + meshWorkBytes(source.geometry), 32 * limits.nodes),
    () =>
      new Promise<{ field: ProximityField | null; backend: 'cpu' | 'webgpu' }>(
        (resolve, reject) => {
          if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
          let worker: Worker | undefined,
            settled = false;
          const finish = (
            error?: Error,
            result?: { field: ProximityField | null; backend: 'cpu' | 'webgpu' },
          ) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', abort);
            worker?.terminate();
            if (error) reject(error);
            else resolve(result!);
          };
          const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
          signal?.addEventListener('abort', abort, { once: true });
          try {
            worker = new Worker(new URL('./proximity.worker.ts', import.meta.url), {
              type: 'module',
            });
            worker.onmessage = ({ data }) =>
              data.error ? finish(new Error(data.error)) : finish(undefined, data);
            worker.onerror = (event) =>
              finish(new Error(event.message || 'Nearby-surface calculation failed.'));
            worker.onmessageerror = () =>
              finish(new Error('Nearby-surface data could not be read.'));
            const request: ProximityRequest = {
              sources: sources.map((source) => {
                const snapshot = snapshotGeometry(source.geometry);
                return {
                  geometry: { ...snapshot, attributes: { position: snapshot.attributes.position } },
                  matrix: source.matrix.toArray(),
                };
              }),
              reach,
              limits,
              ...options,
            };
            worker.postMessage(request);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        },
      ),
    signal,
  );
}
