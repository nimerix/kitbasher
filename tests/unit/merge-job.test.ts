import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry } from 'three';
import { binaryGeometry } from '../../src/core/geometry';
import { mergeParts } from '../../src/core/merge';
import { requestTaskCancellation, useActivity } from '../../src/core/activity';
import type { Part } from '../../src/core/types';

const parts = (): Part[] =>
  [0, 1].map((i) => ({
    id: String(i),
    name: `Block ${i}`,
    geometry: new BoxGeometry(10, 10, 10),
    position: [i * 5, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#ffffff',
    visible: true,
    locked: false,
    source: 'test',
  }));
function mockWorker() {
  const stop = vi.fn();
  const worker = {
    terminate: stop,
    postMessage: vi.fn(),
    onmessage: null as null | ((event: { data: unknown }) => void),
    onerror: null as null | ((event: { message: string }) => void),
    onmessageerror: null as null | (() => void),
  };
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        return worker;
      }
    },
  );
  return { worker, stop };
}
beforeEach(() => useActivity.setState({ tasks: [], notifications: [] }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Boolean background jobs', () => {
  it('stays active beyond ninety seconds and reports stages before completing', async () => {
    vi.useFakeTimers();
    const { worker, stop } = mockWorker();
    const source = parts();
    const task = mergeParts(source, 'union', 'United');
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.postMessage.mock.calls[0]).toHaveLength(1);
    expect(worker.postMessage.mock.calls[0][0].meshes[0].positions).toBe(
      source[0].geometry.attributes.position.array,
    );
    worker.onmessage!({
      data: { type: 'progress', progress: { detail: 'Checking closed surface', progress: null } },
    });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(stop).not.toHaveBeenCalled();
    expect(useActivity.getState().tasks[0].status).toBe('running');
    worker.onmessage!({ data: { type: 'validated' } });
    await vi.advanceTimersByTimeAsync(10);
    const [request, transfer] = worker.postMessage.mock.calls[1];
    expect(request.type).toBe('evaluate');
    expect(transfer).not.toContain(source[0].geometry.attributes.position.array.buffer);
    expect(source[0].geometry.attributes.position.array.byteLength).toBeGreaterThan(0);
    worker.onmessage!({ data: { result: binaryGeometry(new BoxGeometry()) } });
    const result = await task;
    expect(useActivity.getState().tasks[0].status).toBe('completed');
    expect(stop).toHaveBeenCalledOnce();
    expect(useActivity.getState().notifications).toHaveLength(0);
    result.geometry.dispose();
  });

  it.each(['signal', 'activity', 'legacy'] as const)(
    'settles %s cancellation and ignores late results',
    async (method) => {
      const { worker, stop } = mockWorker();
      const controller = new AbortController();
      const task = mergeParts(
        parts(),
        'union',
        'United',
        method === 'legacy'
          ? (captured) => {
              expect(captured).toBe(worker);
            }
          : { signal: controller.signal },
      );
      const rejection = expect(task).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
      if (method === 'signal') controller.abort();
      else if (method === 'activity') requestTaskCancellation(useActivity.getState().tasks[0].id);
      else worker.terminate();
      await rejection;
      worker.onmessage!({ data: { result: binaryGeometry(new BoxGeometry()) } });
      expect(stop).toHaveBeenCalledOnce();
      expect(useActivity.getState().tasks[0].status).toBe('cancelled');
      expect(useActivity.getState().notifications).toHaveLength(0);
    },
  );

  it('records unreadable worker output and cleans up immediately', async () => {
    const { worker, stop } = mockWorker();
    const task = mergeParts(parts(), 'union', 'United');
    const rejection = expect(task).rejects.toThrow('unreadable result');
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    worker.onmessageerror!();
    await rejection;
    expect(stop).toHaveBeenCalledOnce();
    expect(useActivity.getState().tasks[0].status).toBe('failed');
    expect(useActivity.getState().notifications[0].kind).toBe('error');
  });

  it('does not start a worker for an already aborted request', async () => {
    const { worker } = mockWorker();
    const controller = new AbortController();
    controller.abort();
    await expect(
      mergeParts(parts(), 'union', 'United', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(useActivity.getState().tasks).toHaveLength(0);
  });
});
