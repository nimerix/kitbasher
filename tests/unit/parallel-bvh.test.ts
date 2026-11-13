import { afterEach, expect, it, vi } from 'vitest';
import { BoxGeometry } from 'three';
const mock = vi.hoisted(() => ({ run: vi.fn(), dispose: vi.fn() }));
vi.mock('three-mesh-bvh/worker', () => ({
  ParallelMeshBVHWorker: class {
    worker = {};
    runTask = mock.run;
    dispose = mock.dispose;
  },
}));
import { buildParallelIndex } from '../../src/core/parallel-bvh';
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

it('settles cancellation even when a nested worker never replies', async () => {
  mock.run.mockReturnValue(new Promise(() => {}));
  const geometry = new BoxGeometry(),
    controller = new AbortController();
  const pending = buildParallelIndex(geometry, controller.signal, () => {});
  controller.abort();
  await pending;
  expect(mock.dispose).toHaveBeenCalledOnce();
  expect(geometry.boundsTree).toBeUndefined();
  expect(geometry.attributes.position.array.byteLength).toBeGreaterThan(0);
});

it('reports worker errors without an orphaned rejected promise', async () => {
  mock.run.mockRejectedValue(new Error('Shared memory unavailable'));
  await expect(
    buildParallelIndex(new BoxGeometry(), new AbortController().signal, () => {}),
  ).rejects.toThrow('Shared memory');
  expect(mock.dispose).toHaveBeenCalledOnce();
});

it('rejects a stalled builder so the caller can use its normal worker', async () => {
  vi.useFakeTimers();
  mock.run.mockReturnValue(new Promise(() => {}));
  const pending = expect(
    buildParallelIndex(new BoxGeometry(), new AbortController().signal, () => {}),
  ).rejects.toThrow('stopped responding');
  await vi.advanceTimersByTimeAsync(30_000);
  await pending;
  expect(mock.dispose).toHaveBeenCalledOnce();
});
