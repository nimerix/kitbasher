import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry } from 'three';
import { processMeshInWorker, releaseIdleMeshWorker } from '../../src/core/mesh-job';
import { snapshotGeometry } from '../../src/core/geometry-transfer';
import { requestTaskCancellation, useActivity } from '../../src/core/activity';

beforeEach(() => {
  releaseIdleMeshWorker();
  useActivity.setState({ tasks: [], notifications: [] });
});
afterEach(() => {
  releaseIdleMeshWorker();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('mesh workers', () => {
  function mockWorker() {
    const worker = {
      terminate: vi.fn(),
      postMessage: vi.fn(),
      onmessage: null as null | ((event: { data: unknown }) => void),
      onmessageerror: null as null | (() => void),
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

  it('reuses prepared input, invalidates changed attributes, and evicts on disposal', async () => {
    const worker = mockWorker(),
      source = new BoxGeometry();
    const complete = () =>
      worker.onmessage!({ data: { geometry: snapshotGeometry(new BoxGeometry()), error: 0 } });
    const first = processMeshInWorker(source, options);
    complete();
    (await first).geometry.dispose();
    const second = processMeshInWorker(source, { ...options, ratio: 0.25 });
    expect(worker.postMessage.mock.calls[1][0].mesh).toBeUndefined();
    complete();
    (await second).geometry.dispose();
    source.attributes.position.needsUpdate = true;
    const third = processMeshInWorker(source, options);
    expect(worker.postMessage.mock.calls[2][0].mesh.positions).toBe(
      source.attributes.position.array,
    );
    expect(worker.postMessage.mock.calls[2][0].key).not.toBe(
      worker.postMessage.mock.calls[0][0].key,
    );
    complete();
    (await third).geometry.dispose();
    expect(worker.terminate).not.toHaveBeenCalled();
    source.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('expires idle workers but never expires a claimed running job', async () => {
    vi.useFakeTimers();
    const worker = mockWorker(),
      source = new BoxGeometry();
    const first = processMeshInWorker(source, options);
    worker.onmessage!({ data: { geometry: snapshotGeometry(new BoxGeometry()), error: 0 } });
    (await first).geometry.dispose();
    await vi.advanceTimersByTimeAsync(29_000);
    const second = processMeshInWorker(source, options);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.onmessage!({ data: { geometry: snapshotGeometry(new BoxGeometry()), error: 0 } });
    (await second).geometry.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

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

  it('does not create a worker when the task callback cancels immediately', async () => {
    const worker = mockWorker();
    await expect(
      processMeshInWorker(new BoxGeometry(), options, undefined, {
        onTask: (id) => requestTaskCancellation(id),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('keeps a long-running job active, accepts progress without settling, and completes once', async () => {
    vi.useFakeTimers();
    const worker = mockWorker();
    const task = processMeshInWorker(new BoxGeometry(), options);
    const id = useActivity.getState().tasks[0].id;
    worker.onmessage!({ data: { type: 'progress', detail: 'Reducing triangles' } });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(useActivity.getState().tasks[0]).toMatchObject({
      id,
      status: 'running',
      detail: 'Reducing triangles',
      progress: null,
    });
    worker.onmessage!({ data: { geometry: snapshotGeometry(new BoxGeometry()), error: 0 } });
    const result = await task;
    expect(useActivity.getState().tasks[0].status).toBe('completed');
    expect(useActivity.getState().notifications).toHaveLength(1);
    worker.onerror!({ message: 'Late failure' });
    expect(useActivity.getState().tasks[0].status).toBe('completed');
    expect(worker.terminate).not.toHaveBeenCalled();
    releaseIdleMeshWorker();
    expect(worker.terminate).toHaveBeenCalledOnce();
    result.geometry.dispose();
  });

  it('cancels through the activity UI and ignores late worker output', async () => {
    const worker = mockWorker();
    const task = processMeshInWorker(new BoxGeometry(), options);
    const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    requestTaskCancellation(useActivity.getState().tasks[0].id);
    await rejected;
    worker.onmessage!({ data: { geometry: snapshotGeometry(new BoxGeometry()), error: 0 } });
    expect(useActivity.getState().tasks[0].status).toBe('cancelled');
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(useActivity.getState().notifications).toHaveLength(0);
  });

  it('retains worker construction failures as failed activity', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('Worker unavailable');
        }
      },
    );
    await expect(processMeshInWorker(new BoxGeometry(), options)).rejects.toThrow(
      'Worker unavailable',
    );
    expect(useActivity.getState().tasks[0].status).toBe('failed');
    expect(useActivity.getState().notifications[0].message).toContain('Worker unavailable');
  });
});
