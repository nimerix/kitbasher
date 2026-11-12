import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry } from 'three';
import { processMeshInWorker } from '../../src/core/mesh-job';

afterEach(() => vi.unstubAllGlobals());

describe('mesh workers', () => {
  function mockWorker() {
    const worker = {
      terminate: vi.fn(),
      postMessage: vi.fn(),
      onerror: null as null | ((event: { message: string }) => void),
    };
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          return worker;
        }
      },
    );
    return worker;
  }
  const options = { mode: 'decimate' as const, ratio: 0.5, error: 0.01, lockBorder: true };

  it('cancels running work, terminates the worker, and never transfers source buffers', async () => {
    const worker = mockWorker(),
      controller = new AbortController(),
      source = new BoxGeometry();
    const position = source.attributes.position.array;
    const task = processMeshInWorker(source, options, controller.signal);
    expect(worker.postMessage.mock.calls[0]).toHaveLength(1);
    expect(worker.postMessage.mock.calls[0][0].mesh.positions).toBe(position);
    controller.abort();
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(position.byteLength).toBeGreaterThan(0);
  });

  it('reports failures and frees a stopped worker', async () => {
    const worker = mockWorker();
    const task = processMeshInWorker(new BoxGeometry(), options);
    worker.onerror!({ message: 'Worker unavailable' });
    await expect(task).rejects.toThrow('Worker unavailable');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('does not start work for an already-cancelled request', async () => {
    const worker = mockWorker(),
      controller = new AbortController();
    controller.abort();
    await expect(
      processMeshInWorker(new BoxGeometry(), options, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.postMessage).not.toHaveBeenCalled();
  });
});
