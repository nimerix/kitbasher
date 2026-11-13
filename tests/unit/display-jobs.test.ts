import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BoxGeometry } from 'three';
import { binaryGeometry } from '../../src/core/geometry';
import { displayProxy } from '../../src/core/display-performance';
import { requestTaskCancellation, useActivity } from '../../src/core/activity';

beforeEach(() => useActivity.setState({ tasks: [], notifications: [] }));
afterEach(() => vi.unstubAllGlobals());

it('tracks queued display work once, skips a cancelled queued mesh, and keeps source buffers intact', async () => {
  const workers: {
    terminate: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    onmessage: null | ((event: { data: unknown }) => void);
  }[] = [];
  vi.stubGlobal(
    'Worker',
    class {
      terminate = vi.fn();
      postMessage = vi.fn();
      onmessage = null;
      constructor() {
        workers.push(this);
      }
    },
  );
  const source = new BoxGeometry(10, 10, 10, 100, 100, 100);
  const second = source.clone();
  const original = source.attributes.position.array.slice();
  const task = displayProxy(source);
  const firstId = useActivity.getState().tasks[0].id;
  expect(displayProxy(source)).toBe(task);
  const queued = displayProxy(second);
  expect(useActivity.getState().tasks).toHaveLength(2);
  requestTaskCancellation(useActivity.getState().tasks[0].id);
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  workers[0].onmessage!({ data: { type: 'progress', detail: 'Reducing triangles' } });
  expect(useActivity.getState().tasks.find((item) => item.id === firstId)).toMatchObject({
    status: 'running',
    progress: null,
  });
  workers[0].onmessage!({ data: { mesh: binaryGeometry(new BoxGeometry()), error: 0 } });
  const result = await task;
  expect(await queued).toBeNull();
  expect(workers).toHaveLength(1);
  expect(result).not.toBeNull();
  expect(
    useActivity
      .getState()
      .tasks.map((item) => item.status)
      .sort(),
  ).toEqual(['cancelled', 'completed']);
  expect(useActivity.getState().notifications).toHaveLength(0);
  expect(source.attributes.position.array).toEqual(original);
  const retry = displayProxy(second);
  expect(retry).not.toBe(queued);
  await vi.waitFor(() => expect(workers).toHaveLength(2));
  workers[1].onmessage!({ data: { mesh: binaryGeometry(new BoxGeometry()), error: 0 } });
  expect(await retry).not.toBeNull();
  source.dispose();
  second.dispose();
});
