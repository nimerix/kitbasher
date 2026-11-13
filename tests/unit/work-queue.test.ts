import { expect, it, vi } from 'vitest';
import { WorkQueue } from '../../src/core/work-queue';

it('bounds concurrency and aggregate memory, admits oversized jobs alone, and removes cancellations', async () => {
  const queue = new WorkQueue(2, 100);
  const releases: (() => void)[] = [];
  const run = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
  const a = queue.run(40, run),
    b = queue.run(40, run),
    c = queue.run(80, run);
  const abort = new AbortController();
  const cancelled = queue.run(20, run, abort.signal);
  const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort();
  const large = queue.run(200, run);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  releases[0]();
  await a;
  expect(run).toHaveBeenCalledTimes(2);
  releases[1]();
  await b;
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  releases[2]();
  await c;
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4));
  releases[3]();
  await large;
  await rejected;
});

it('releases admission after an exception', async () => {
  const queue = new WorkQueue(1, 100);
  await expect(
    queue.run(50, async () => {
      throw new Error('failed');
    }),
  ).rejects.toThrow('failed');
  await expect(queue.run(50, async () => 42)).resolves.toBe(42);
});
