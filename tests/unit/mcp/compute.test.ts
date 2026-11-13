import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoxGeometry, SphereGeometry, Float32BufferAttribute } from 'three';
import { binaryGeometry } from '../../../src/core/geometry';
import { MeshProcessor } from '../../../src/core/mesh-processing';
import { restoreGeometry } from '../../../src/core/geometry-transfer';
import { nativeMeshExecutable, runNativeKernel } from '../../../mcp/native-mesh';
import { releaseComputeWorkers, runCompute } from '../../../mcp/compute';
import { Session } from '../../../mcp/session';

afterAll(releaseComputeWorkers);

it('uses the server WASM fallback when native processing is disabled', async () => {
  const previous = process.env.KITBASHER_NATIVE_MESH;
  process.env.KITBASHER_NATIVE_MESH = '0';
  try {
    const result = await runCompute({
      kind: 'process',
      mesh: binaryGeometry(new BoxGeometry()),
      options: { mode: 'remesh', resolution: 24 },
    });
    expect(result.backend).toBe('wasm');
  } finally {
    if (previous === undefined) delete process.env.KITBASHER_NATIVE_MESH;
    else process.env.KITBASHER_NATIVE_MESH = previous;
  }
});

describe.skipIf(!nativeMeshExecutable())('native kernels', () => {
  const previous = process.env.KITBASHER_NATIVE_MESH;
  beforeAll(() => {
    process.env.KITBASHER_NATIVE_MESH = 'all';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.KITBASHER_NATIVE_MESH;
    else process.env.KITBASHER_NATIVE_MESH = previous;
  });
  for (const colored of [false, true])
    it(`matches WASM processing (${colored ? 'colored' : 'plain'})`, async () => {
      const sphere = new SphereGeometry(8, 40, 24);
      if (colored)
        sphere.setAttribute(
          'color',
          new Float32BufferAttribute(
            Array.from(
              { length: sphere.attributes.position.count * 3 },
              (_, i) => ((i * 13) % 97) / 96,
            ),
            3,
          ),
        );
      const mesh = binaryGeometry(sphere);
      for (const options of [
        { mode: 'decimate', ratio: 0.5, error: 0.05, lockBorder: true },
        { mode: 'remesh', resolution: 24 },
      ] as const) {
        if (colored && options.mode === 'remesh') continue;
        const source = options.mode === 'remesh' ? binaryGeometry(new BoxGeometry(10, 8, 7)) : mesh;
        const expected = await new MeshProcessor(source).process(options);
        const result = await runCompute({ kind: 'process', mesh: source, options });
        expect(result.backend).toBe('native');
        const actual = binaryGeometry(restoreGeometry(result.geometry));
        expect(actual.positions).toEqual(expected.mesh.positions);
        expect(actual.indices).toEqual(expected.mesh.indices);
        expect(actual.colors).toEqual(expected.mesh.colors);
        if (expected.error !== null) expect(result.error).toBeCloseTo(expected.error, 6);
      }
    });
  it('rejects invalid native indices and supports cancellation', async () => {
    const mesh = binaryGeometry(new BoxGeometry());
    await expect(
      runNativeKernel({
        mode: 'decimate',
        mesh: { ...mesh, indices: new Uint32Array([0, 1, 999999]) },
        target: 3,
        error: 0.1,
        lockBorder: false,
      }),
    ).rejects.toThrow('index');
    const controller = new AbortController();
    controller.abort();
    await expect(
      runNativeKernel({ mode: 'remesh', mesh, resolution: 128 }, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

it('keeps the server responsive, cancels work and runs the following job', async () => {
  const mesh = binaryGeometry(new BoxGeometry(10, 8, 7, 120, 120, 120));
  const controller = new AbortController();
  const pending = runCompute(
    { kind: 'process', mesh, options: { mode: 'remesh', resolution: 128 } },
    controller.signal,
  );
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await cancelled;
  const result = await runCompute({
    kind: 'process',
    mesh: binaryGeometry(new BoxGeometry()),
    options: { mode: 'remesh', resolution: 24 },
  });
  expect(result.geometry.attributes.position.array.length).toBeGreaterThan(0);
});

it('refuses to apply a background merge after a concurrent scene edit', async () => {
  const session = new Session();
  session.addParts(
    ['a', 'b'].map((id) => ({ id, name: id, shapes: [{ type: 'box', size: [10, 10, 10] }] })),
  );
  const merging = session.mergePartsAsync(['a', 'b'], 'union');
  session.updateParts([{ id: 'a', position: [30, 0, 0] }]);
  await expect(merging).rejects.toThrow('scene changed');
});
