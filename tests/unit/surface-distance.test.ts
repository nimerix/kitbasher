import { afterEach, expect, it, vi } from 'vitest';
import { BoxGeometry, Matrix4 } from 'three';
import { surfaceDistances } from '../../src/core/surface-distance';
afterEach(() => vi.unstubAllGlobals());

it('measures transformed original surfaces and clamps beyond the requested range', async () => {
  const geometry = new BoxGeometry(10, 8, 4);
  const original = geometry.index!.array.slice();
  const sources = [{ geometry, matrix: new Matrix4().makeScale(-2, 0.5, 1) }];
  const result = await surfaceDistances(
    sources,
    new Float32Array([0, 0, 0, 12, 0, 0, 10, 2, 2, 30, 30, 30]),
    8,
    { gpu: false },
  );
  expect(result.backend).toBe('cpu');
  expect(result.distances).toEqual(new Float32Array([2, 2, 0, 8]));
  expect(geometry.index!.array).toEqual(original);
  expect((await surfaceDistances([], new Float32Array([0, 0, 0]), 4)).distances[0]).toBe(4);
});

it('rejects invalid batch queries', async () => {
  await expect(surfaceDistances([], new Float32Array([NaN, 0, 0]), 4)).rejects.toThrow('finite');
  await expect(surfaceDistances([], new Float32Array([0, 0]), 4)).rejects.toThrow('finite');
});

it('skips software adapters and falls back after device creation fails', async () => {
  const device = vi.fn().mockRejectedValue(new Error('GPU unavailable'));
  const adapter = { info: { isFallbackAdapter: true }, requestDevice: device };
  vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => adapter } });
  const sources = [{ geometry: new BoxGeometry(), matrix: new Matrix4() }];
  expect((await surfaceDistances(sources, new Float32Array([2, 0, 0]), 4)).backend).toBe('cpu');
  expect(device).not.toHaveBeenCalled();
  adapter.info.isFallbackAdapter = false;
  expect((await surfaceDistances(sources, new Float32Array([2, 0, 0]), 4)).distances[0]).toBe(1.5);
  expect(device).toHaveBeenCalledOnce();
});
