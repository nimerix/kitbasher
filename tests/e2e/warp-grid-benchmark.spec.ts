import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SphereGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';

// Opt-in: KITBASHER_WARP_GRID_BENCH=1. Rendered drag frames with the grid overlay against the
// old 1 px chords (`?warp-grid=1px`), in the same app and browser.
const cases = [
  // The grid test's ball: 6,050 welded vertices.
  { name: '502 nodes, 6,050 vertices', segments: [96, 64], density: 3 },
  { name: '4,002 nodes, 6,050 vertices', segments: [96, 64], density: 6 },
  // Large enough that a drag moves the grid alone and the surface follows at the end.
  { name: '4,002 nodes, 125,582 vertices', segments: [460, 274], density: 6 },
] as const;

const scene = (segments: readonly [number, number]) => ({
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Warp grid benchmark',
  joints: [],
  parts: [
    {
      id: 'ball',
      name: 'Scanned ball',
      position: [0, 15, 0],
      color: '#d4a272',
      geometry: serializeGeometry(new SphereGeometry(15, ...segments)),
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      visible: true,
      locked: false,
      source: 'test',
    },
  ],
});

async function open(page: Page, legacy: boolean, segments: readonly [number, number]) {
  await page.goto(legacy ? '/?warp-grid=1px' : '/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'bench.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scene(segments))),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Scanned ball"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page.keyboard.press('w');
  await page.getByRole('radio', { name: 'Whole part', exact: true }).click();
}

/** Drags a point across the ball's front, timing each frame through rendering and a readback. */
function dragFrames(page: Page, density: number, frames: number) {
  return page.evaluate(
    async ({ density, frames }) => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const root = (
        await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!)
      )._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const { useEditor } = await import(
        urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
      );
      const editor = () => useEditor.getState();
      await editor().setWarpDensity(density);
      for (let i = 0; i < 200 && editor().warp?.stage !== 'warp'; i++)
        await new Promise((done) => setTimeout(done, 50));
      const warp = editor().warp;
      // The front of the ball, facing the camera.
      const { camera, gl } = root;
      const centre = camera.position.clone().set(0, 15, 0);
      camera.position.set(0, 15, 70);
      camera.lookAt(centre);
      root.controls?.target.copy(centre);
      root.controls?.update();
      const mesh = root.scene.getObjectByName('part:ball');
      const face = (() => {
        const position = mesh.geometry.getAttribute('position');
        const index = mesh.geometry.index;
        let best = -1,
          bestZ = -Infinity;
        for (let f = 0; f < (index ? index.count : position.count) / 3; f++) {
          const v = index ? index.getX(f * 3) : f * 3;
          const z = position.getZ(v) - Math.abs(position.getX(v)) - Math.abs(position.getY(v));
          if (z > bestZ) {
            bestZ = z;
            best = f;
          }
        }
        return best;
      })();
      editor().addWarpPoint({ partId: 'ball', point: [0, 15, 15], normal: [0, 0, 1] }, face);
      const id = editor().warp.points.at(-1).id;
      // Let the trace finish before timing.
      for (let i = 0; i < 400; i++) {
        const space = root.scene.getObjectByName('warp-grid');
        if (!space || space.userData.traced !== false) break;
        root.advance(performance.now());
        await new Promise((done) => setTimeout(done, 10));
      }
      root.setFrameloop('never');
      const channel = new MessageChannel();
      const tick = () =>
        new Promise<void>((done) => {
          channel.port1.onmessage = () => done();
          channel.port2.postMessage(0);
        });
      const pixel = new Uint8Array(4);
      const context = gl.getContext() as WebGL2RenderingContext;
      const times: number[] = [];
      for (let frame = 0; frame < frames; frame++) {
        const start = performance.now();
        editor().moveWarpPoints(
          [
            {
              id,
              target: [0.04 * (frame % 50), 15 + 0.02 * (frame % 50), 15 + 0.04 * (frame % 50)],
            },
          ],
          'drag',
        );
        // React commits the store change before the frame is drawn.
        await tick();
        root.advance(performance.now());
        context.readPixels(0, 0, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
        times.push(performance.now() - start);
      }
      editor().moveWarpPoints([{ id, target: [0, 15, 15] }], 'end');
      root.setFrameloop('demand');
      const nodes = warp.model.grid.nodes.length;
      const vertices = warp.model.region.weldedCount;
      times.splice(0, 10);
      const sorted = times.slice().sort((a, b) => a - b);
      return {
        nodes,
        vertices,
        median: sorted[sorted.length >> 1],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        frames: sorted.length,
      };
    },
    { density, frames },
  );
}

test('times rendered warp drag frames against the old 1 px grid', async ({ page }) => {
  test.skip(!process.env.KITBASHER_WARP_GRID_BENCH, 'Opt-in timing diagnostic.');
  test.setTimeout(600_000);
  const result: Record<string, unknown> = {};
  for (const { name, segments, density } of cases) {
    const runs: Record<string, { median: number[]; p95: number[] }> = {
      old: { median: [], p95: [] },
      new: { median: [], p95: [] },
    };
    // Alternate, so drift in the machine's state falls on both alike.
    for (let round = 0; round < 5; round++)
      for (const legacy of round % 2 ? [false, true] : [true, false]) {
        await open(page, legacy, segments);
        await page.getByRole('button', { name: 'Lay grid', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Close gap', exact: true })).toBeEnabled();
        const timing = await dragFrames(page, density, 130);
        const run = runs[legacy ? 'old' : 'new'];
        run.median.push(timing.median);
        run.p95.push(timing.p95);
        result[`${name} shape`] = { nodes: timing.nodes, vertices: timing.vertices };
      }
    const middle = (values: number[]) => values.slice().sort((a, b) => a - b)[values.length >> 1];
    result[name] = {
      old: { median: middle(runs.old.median), p95: middle(runs.old.p95) },
      new: { median: middle(runs.new.median), p95: middle(runs.new.p95) },
      runs,
    };
  }
  const out = join(tmpdir(), 'kitbasher-warp-grid-benchmark.json');
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`Wrote ${out}`);
});
