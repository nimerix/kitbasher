import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SphereGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';

// Opt-in: KITBASHER_WARP_GRID_BENCH=1. Rendered drag frames with the grid overlay against the
// old 1 px chords (`?warp-grid=1px`), in the same app and browser. KITBASHER_WARP_GRID_BENCH_SCAN
// may name an STL file, such as a real scan, to time as well, framed as it is for work.
type Case = { name: string; density: number } & (
  { segments: readonly [number, number] } | { scan: string }
);
const scan = process.env.KITBASHER_WARP_GRID_BENCH_SCAN;
const rounds = Number(process.env.KITBASHER_WARP_GRID_BENCH_ROUNDS ?? 5);
const cases: Case[] = [
  // The grid test's ball: 6,050 welded vertices.
  { name: '502 nodes, 6,050 vertices', segments: [96, 64], density: 3 },
  { name: '4,002 nodes, 6,050 vertices', segments: [96, 64], density: 6 },
  // Large enough that a drag moves the grid alone and the surface follows at the end.
  { name: '4,002 nodes, 125,582 vertices', segments: [460, 274], density: 6 },
  ...(scan
    ? [
        // The default for a painted region, and for a whole part.
        { name: 'scan, density 3', scan, density: 3 },
        { name: 'scan, density 5', scan, density: 5 },
        { name: 'scan, highest density', scan, density: 6 },
      ]
    : []),
];

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

async function open(page: Page, legacy: boolean, source: Case) {
  await page.goto(legacy ? '/?warp-grid=1px' : '/');
  await expect(page.locator('canvas')).toBeVisible();
  if ('scan' in source) {
    await page.getByLabel('Open Kitbasher scene').setInputFiles({
      name: 'empty.kitbash',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...scene([3, 2]), parts: [] })),
    });
    await page.getByRole('button', { name: 'Open scene', exact: true }).click();
    await expect(page.locator('.part-select')).toHaveCount(0);
    await page.getByRole('button', { name: 'File', exact: true }).click();
    await page.locator('.dropdown-menu button', { hasText: 'Import' }).first().click();
    await page.getByLabel('Choose model files').setInputFiles(source.scan);
    await page.locator('.modal-footer .button.primary').click();
    await expect(page.locator('.part-select')).toHaveCount(1, { timeout: 60_000 });
    await page.locator('.part-select').click();
  } else {
    await page.getByLabel('Open Kitbasher scene').setInputFiles({
      name: 'bench.kitbash',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(scene(source.segments))),
    });
    await page.getByRole('button', { name: 'Open scene', exact: true }).click();
    await page.locator('.part-select[title="Scanned ball"]').click();
  }
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page.keyboard.press('w');
  await page.getByRole('radio', { name: 'Whole part', exact: true }).click();
}

/** Drags a point across the part's front, timing each frame through rendering and a readback. */
function dragFrames(page: Page, density: number, frames: number, ball: boolean) {
  return page.evaluate(
    async ({ density, frames, ball }) => {
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
      const { camera, gl } = root;
      const mesh = root.scene.getObjectByName(`part:${warp.partId}`);
      // A point at the middle of the view, dragged out along its normal.
      let point: number[], normal: number[], face: number, world: number[];
      if (ball) {
        // The front of the ball, facing the camera.
        const centre = camera.position.clone().set(0, 15, 0);
        camera.position.set(0, 15, 70);
        camera.lookAt(centre);
        root.controls?.target.copy(centre);
        root.controls?.update();
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
        [point, normal, face, world] = [[0, 15, 15], [0, 0, 1], best, [0, 15, 15]];
      } else {
        const THREE = await import(urls.find((url) => /\/deps\/three\.js/.test(url))!);
        camera.updateMatrixWorld();
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
        const hit = raycaster.intersectObject(mesh, false)[0];
        const local = mesh.worldToLocal(hit.point.clone());
        const n = hit.face.normal.clone().transformDirection(mesh.matrixWorld);
        [point, normal, face, world] = [
          local.toArray(),
          n.toArray(),
          hit.faceIndex,
          hit.point.toArray(),
        ];
      }
      editor().addWarpPoint({ partId: warp.partId, point, normal }, face);
      const id = editor().warp.points.at(-1).id;
      // Let the trace finish, and the points drawn be chosen on the surface, before timing.
      for (let i = 0; i < 6000; i++) {
        const space = root.scene.getObjectByName('warp-grid');
        const drawing = space?.userData.drawing;
        const settled = !drawing || drawing.refined === drawing.written;
        if (!space || (space.userData.traced !== false && settled)) break;
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
              target: ball
                ? [0.04 * (frame % 50), 15 + 0.02 * (frame % 50), 15 + 0.04 * (frame % 50)]
                : world.map((v, axis) => v + 0.04 * (frame % 50) * normal[axis]),
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
      editor().moveWarpPoints([{ id, target: world }], 'end');
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
    { density, frames, ball },
  );
}

test('times rendered warp drag frames against the old 1 px grid', async ({ page }) => {
  test.skip(!process.env.KITBASHER_WARP_GRID_BENCH, 'Opt-in timing diagnostic.');
  test.setTimeout(scan ? 3_600_000 : 600_000);
  const result: Record<string, unknown> = {};
  const only = process.env.KITBASHER_WARP_GRID_BENCH_ONLY;
  for (const source of cases.filter((c) => !only || c.name.includes(only))) {
    const { name, density } = source;
    const runs: Record<string, { median: number[]; p95: number[] }> = {
      old: { median: [], p95: [] },
      new: { median: [], p95: [] },
    };
    // Alternate, so drift in the machine's state falls on both alike.
    for (let round = 0; round < rounds; round++)
      for (const legacy of round % 2 ? [false, true] : [true, false]) {
        await open(page, legacy, source);
        await page.getByRole('button', { name: 'Lay grid', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Close gap', exact: true })).toBeEnabled();
        const timing = await dragFrames(page, density, 130, !('scan' in source));
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
  const out =
    process.env.KITBASHER_WARP_GRID_BENCH_OUT ??
    join(tmpdir(), 'kitbasher-warp-grid-benchmark.json');
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`Wrote ${out}`);
});
