import { test, expect, type Page } from '@playwright/test';
import { arch, cpus, release, type } from 'node:os';
import type { BufferAttribute, Camera, Mesh } from 'three';
import { inStore, openScene, screen } from './helpers/refine';

// Opt in with KITBASHER_SCULPT_VIEWPORT_BENCH=1. Each native move waits for its first
// changed draw before sending the next one, so these results exclude input queueing.
test.skip(!process.env.KITBASHER_SCULPT_VIEWPORT_BENCH, 'Opt-in viewport benchmark');

interface ProbeWindow extends Window {
  sculptDrawTimes: number[];
}

async function setup(page: Page, segments: number, indexed: boolean) {
  await openScene(page);
  await expect(page.locator('.part-select[title="Scanned block"]')).toBeVisible();
  await page.evaluate(
    async ({ segments, indexed }) => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const three = await import(urls.find((url) => /\/deps\/three\.js/.test(url))!);
      const { useEditor } = await import(
        urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
      );
      const grid = new three.PlaneGeometry(100, 100, segments, segments);
      const geometry = indexed ? grid : grid.toNonIndexed();
      const state = useEditor.getState();
      const part = {
        ...state.scene.parts[0],
        geometry,
        name: 'Benchmark sheet',
        position: [0, 55, 0],
      };
      state.setScene({ ...state.scene, parts: [part] });
    },
    { segments, indexed },
  );
  await page.locator('.part-select[title="Benchmark sheet"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  if (segments > 1)
    await expect
      .poll(() => inStore(page, (state) => !!state.scene.parts[0].geometry.boundsTree), {
        timeout: 60_000,
      })
      .toBe(true);
  // Register capture before Sculpt's window listener consumes active stroke events.
  const gpu = await installProbe(page);
  await page
    .getByRole('toolbar', { name: 'Assembly tools' })
    .getByRole('button', { name: 'Sculpt', exact: true })
    .click();
  return { gpu, settings: await inStore(page, (state) => state.sculpt!.settings) };
}

async function installProbe(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { partMeshes } = await import(
      urls.find((url) => /\/src\/xr\/part-meshes\.ts(?:\?.*)?$/.test(url))!
    );
    const { _roots } = await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!);
    const root = _roots.get(document.querySelector('canvas')).store.getState();
    const mesh: Mesh = partMeshes.get('block');
    const source = mesh.geometry;
    const samples = ((window as unknown as ProbeWindow).sculptDrawTimes = [] as number[]);
    let start = -1;
    let lastVersion = 0;
    let lastPosition = source.getAttribute('position');
    function onPointer(event: PointerEvent) {
      if (event.buttons === 1) start = performance.now();
    }
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('pointermove', onPointer, true);
    const previous = mesh.onAfterRender;
    mesh.onAfterRender = function (...args) {
      previous.apply(this, args);
      const camera: Camera = args[2];
      const version = (this.geometry.getAttribute('position') as BufferAttribute).version;
      if (
        start >= 0 &&
        camera === root.camera &&
        this.geometry !== source &&
        version > 0 &&
        (this.geometry.getAttribute('position') !== lastPosition || version > lastVersion)
      ) {
        samples.push(performance.now() - start);
        lastPosition = this.geometry.getAttribute('position');
        lastVersion = version;
        start = -1;
      }
    };
    const context = root.gl.getContext();
    const extension = context.getExtension('WEBGL_debug_renderer_info');
    return extension
      ? (context.getParameter(extension.UNMASKED_RENDERER_WEBGL) as string)
      : 'unavailable';
  });
}

for (const [name, segments, indexed] of [
  ['coarse', 1, true],
  ['dense indexed', 707, true],
  ['dense unindexed', 707, false],
] as const) {
  test(`times pointer receipt to changed viewport draw on a ${name} sheet`, async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(180_000);
    const { gpu, settings } = await setup(page, segments, indexed);
    const warmSamples = 24;
    const step = settings.radius * settings.spacing * 1.35;
    const start = await screen(page, [(-step * warmSamples) / 2, 56, 0]);
    const end = await screen(page, [(step * warmSamples) / 2, 56, 0]);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let sample = 0; sample <= warmSamples; sample++) {
      if (sample)
        await page.mouse.move(start.x + ((end.x - start.x) * sample) / warmSamples, start.y);
      await page.waitForFunction(
        (count) => (window as unknown as ProbeWindow).sculptDrawTimes.length >= count,
        sample + 1,
        { timeout: 30_000 },
      );
    }
    const [firstMs, ...warmMs] = await page.evaluate(
      () => (window as unknown as ProbeWindow).sculptDrawTimes,
    );
    await page.mouse.up();
    await expect
      .poll(() => inStore(page, (state) => state.sculpt?.past.length), { timeout: 60_000 })
      .toBe(1);
    const sorted = [...warmMs].sort((a, b) => a - b);
    const report = {
      name,
      triangles: segments * segments * 2,
      indexed,
      brushRadius: settings.radius,
      browser: browser.version(),
      os: [type(), release(), arch()].join(' '),
      cpu: cpus()[0].model,
      gpu,
      firstMs,
      warmP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      warmWorstMs: sorted.at(-1),
      warmMs,
    };
    console.log(JSON.stringify(report));
    await info.attach('sculpt-viewport.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
  });
}
