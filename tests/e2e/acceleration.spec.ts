import { expect, test } from '@playwright/test';

test('repeated Boolean jobs reuse the real worker without detaching input or cached results', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  const result = await page.evaluate(async () => {
    const threeUrl = '/node_modules/three/build/three.module.js',
      mergeUrl = '/src/core/merge.ts';
    const { BoxGeometry } = await import(threeUrl),
      { mergeParts, releaseIdleMergeWorker } = await import(mergeUrl);
    releaseIdleMergeWorker();
    const sources = [0, 1].map((i) => ({
      id: String(i),
      name: 'Box',
      geometry: new BoxGeometry(10, 8, 6, 20, 20, 20),
      position: [i * 4, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: '#ffffff',
      visible: true,
      locked: false,
      source: 'test',
    }));
    const NativeWorker = window.Worker;
    let created = 0;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes('merge.worker')) created++;
      }
    };
    try {
      const first = await mergeParts(sources, 'union', 'First');
      const positions = first.geometry.attributes.position.array.slice();
      first.geometry.dispose();
      const second = await mergeParts(sources, 'union', 'Second');
      const equal = second.geometry.attributes.position.array.every(
        (v: number, i: number) => v === positions[i],
      );
      second.geometry.dispose();
      return {
        created,
        equal,
        intact: sources.every((source) => source.geometry.attributes.position.array.byteLength > 0),
      };
    } finally {
      releaseIdleMergeWorker();
      window.Worker = NativeWorker;
    }
  });
  expect(result).toEqual({ created: 1, equal: true, intact: true });
});

test('worker proximity matches the CPU field exactly, preserves sources and cancels', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  const result = await page.evaluate(async () => {
    const threeUrl = '/node_modules/three/build/three.module.js',
      jobUrl = '/src/core/proximity-job.ts',
      cpuUrl = '/src/core/proximity.ts';
    const { BoxGeometry, Matrix4 } = await import(threeUrl);
    const { bakeProximityInWorker } = await import(jobUrl),
      { bakeProximityField } = await import(cpuUrl);
    const sources = [
      { geometry: new BoxGeometry(10, 8, 4), matrix: new Matrix4().makeTranslation(5, 2, 3) },
    ];
    const limits = { nodes: 30_000, axis: 48 };
    const expected = bakeProximityField(sources, 2, limits);
    let next = expected.next();
    while (!next.done) next = expected.next();
    const actual = await bakeProximityInWorker(sources, 2, limits, undefined, { gpu: false });
    const controller = new AbortController();
    const pending = bakeProximityInWorker(sources, 2, undefined, controller.signal, {
      gpu: false,
    }).then(
      () => false,
      (error: Error) => error.name === 'AbortError',
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    return {
      equal: actual.field.data.every((v: number, i: number) => v === next.value.data[i]),
      backend: actual.backend,
      intact: sources[0].geometry.attributes.position.array.byteLength > 0,
      cancelled: await pending,
    };
  });
  expect(result).toEqual({ equal: true, backend: 'cpu', intact: true, cancelled: true });
});

test('WebGPU distance batches agree with CPU triangles, including degenerate faces', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  const supported = await page.evaluate(
    async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  test.skip(!supported, 'This browser has no WebGPU adapter.');
  const result = await page.evaluate(async () => {
    const threeUrl = '/node_modules/three/build/three.module.js',
      distanceUrl = '/src/core/surface-distance.ts',
      jobUrl = '/src/core/proximity-job.ts';
    const { BoxGeometry, SphereGeometry, BufferGeometry, BufferAttribute, Matrix4 } = await import(
      threeUrl
    );
    const { surfaceDistances } = await import(distanceUrl),
      { bakeProximityInWorker } = await import(jobUrl);
    const degenerate = new BufferGeometry().setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 0, 0, 0, 2, 0, 0]), 3),
    );
    const sources = [
      { geometry: new BoxGeometry(10, 8, 4), matrix: new Matrix4().makeScale(-2, 0.4, 1) },
      { geometry: new SphereGeometry(3, 24, 16), matrix: new Matrix4().makeTranslation(14, 3, 1) },
      { geometry: degenerate, matrix: new Matrix4().makeTranslation(0, 10, 0) },
    ];
    const points = new Float32Array(70_019 * 3);
    let seed = 123;
    for (let i = 0; i < points.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      points[i] = (seed / 4294967296 - 0.5) * 40;
    }
    const cpu = await surfaceDistances(sources, points, 8, { gpu: false });
    const gpu = await surfaceDistances(sources, points, 8, { allowSoftware: true });
    const field = await bakeProximityInWorker(sources, 2, { nodes: 30_000, axis: 48 }, undefined, {
      allowSoftware: true,
    });
    let error = 0,
      worst = 0;
    for (let i = 0; i < cpu.distances.length; i++) {
      const e = Math.abs(cpu.distances[i] - gpu.distances[i]);
      if (e > error) {
        error = e;
        worst = i;
      }
    }
    return {
      backend: gpu.backend,
      fieldBackend: field.backend,
      error,
      valid: field.field.data.length > 0,
      worst: {
        point: Array.from(points.subarray(worst * 3, worst * 3 + 3)),
        cpu: cpu.distances[worst],
        gpu: gpu.distances[worst],
      },
    };
  });
  expect(result.backend).toBe('webgpu');
  expect(result.fieldBackend).toBe('webgpu');
  expect(result.error).toBeLessThan(0.0002);
  expect(result.valid).toBe(true);
});

test('isolated hosts build dense picking indexes across workers without altering mesh buffers', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  test.skip(
    !(await page.evaluate(() => crossOriginIsolated)),
    'Run test:e2e:acceleration for the isolated host.',
  );
  const result = await page.evaluate(async () => {
    const threeUrl = '/node_modules/three/build/three.module.js',
      bvhUrl = '/src/core/parallel-bvh.ts';
    const { BoxGeometry, Vector3 } = await import(threeUrl),
      { buildParallelIndex } = await import(bvhUrl);
    const geometry = new BoxGeometry(10, 8, 6, 210, 210, 210);
    const indices = geometry.index.array.slice(),
      positions = geometry.attributes.position.array.slice();
    await buildParallelIndex(geometry, new AbortController().signal, () => {});
    return {
      isolated: crossOriginIsolated,
      intact:
        geometry.index.array.every((v: number, i: number) => v === indices[i]) &&
        geometry.attributes.position.array.every((v: number, i: number) => v === positions[i]),
      distance: geometry.boundsTree.closestPointToPoint(new Vector3(8, 0, 0)).distance,
    };
  });
  expect(result).toEqual({ isolated: true, intact: true, distance: 3 });
});
