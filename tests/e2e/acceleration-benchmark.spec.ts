import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

test('profiles worker field construction including GPU readback', async ({ page }) => {
  test.skip(!process.env.KITBASHER_ACCELERATION_BENCH, 'Opt-in timing diagnostic.');
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const threeUrl = '/node_modules/three/build/three.module.js',
      jobUrl = '/src/core/proximity-job.ts';
    const { BoxGeometry, Matrix4 } = await import(threeUrl),
      { bakeProximityInWorker } = await import(jobUrl);
    const adapter = await navigator.gpu?.requestAdapter();
    const samples: Record<string, number[]> = {},
      backends: Record<string, string[]> = {};
    for (const dense of [false, true]) {
      const segments = dense ? 128 : 1;
      const sources = [
        {
          geometry: new BoxGeometry(60, 40, 30, segments, segments, segments),
          matrix: new Matrix4(),
        },
      ];
      for (const gpu of [false, true]) {
        const label = `${dense ? 'dense' : 'coarse'}${gpu ? 'Gpu' : 'Cpu'}`;
        samples[label] = [];
        backends[label] = [];
        for (let i = 0; i < 4; i++) {
          const start = performance.now();
          const result = await bakeProximityInWorker(sources, 2, undefined, undefined, { gpu });
          if (i) {
            samples[label].push(performance.now() - start);
            backends[label].push(result.backend);
          }
        }
      }
    }
    return {
      adapter: adapter
        ? {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            device: adapter.info.device,
            description: adapter.info.description,
            fallback: adapter.info.isFallbackAdapter,
          }
        : null,
      samples,
      backends,
    };
  });
  expect(Object.keys(result.samples)).toHaveLength(4);
  writeFileSync('/tmp/kitbasher-gpu-acceleration.json', JSON.stringify(result, null, 2));
});
