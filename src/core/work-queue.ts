import type { BufferGeometry } from 'three';

/** FIFO admission control. An oversized job runs alone instead of starving forever. */
export class WorkQueue {
  private active = 0;
  private bytes = 0;
  private pending: { bytes: number; start: () => void; cancel: () => void }[] = [];
  constructor(
    private readonly concurrency = 2,
    private readonly maxBytes = 256 * 1024 * 1024,
  ) {}

  run<T>(bytes: number, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
      const cost = Math.max(1, bytes);
      const entry = {
        bytes: cost,
        start: () => {
          signal?.removeEventListener('abort', entry.cancel);
          this.active++;
          this.bytes += cost;
          Promise.resolve()
            .then(run)
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              this.bytes -= cost;
              this.pump();
            });
        },
        cancel: () => {
          const i = this.pending.indexOf(entry);
          if (i < 0) return;
          this.pending.splice(i, 1);
          signal?.removeEventListener('abort', entry.cancel);
          reject(new DOMException('Cancelled', 'AbortError'));
          this.pump();
        },
      };
      signal?.addEventListener('abort', entry.cancel, { once: true });
      this.pending.push(entry);
      queueMicrotask(() => this.pump());
    });
  }

  private pump() {
    while (this.pending.length && this.active < this.concurrency) {
      if (this.active && this.bytes + this.pending[0].bytes > this.maxBytes) return;
      this.pending.shift()!.start();
    }
  }
}

export const backgroundWork = new WorkQueue(
  typeof navigator !== 'undefined' && navigator.hardwareConcurrency >= 4 ? 2 : 1,
);

/** Includes the source copy, topology and a conservative WASM scratch allowance. */
export function meshWorkBytes(geometry: BufferGeometry) {
  return (
    Object.values(geometry.attributes).reduce((sum, a) => sum + a.array.byteLength, 0) * 3 +
    (geometry.index?.count ?? geometry.attributes.position.count) * 16 +
    36 * 1024 * 1024
  );
}
