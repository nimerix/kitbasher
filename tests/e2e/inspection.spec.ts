import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry, PlaneGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';

// Browser plugin not available. Flow: enable inspection -> reveal overlap/gap -> adjust threshold.
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', (error) => messages.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') messages.push(message.text());
  });
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

async function fixture(page: Page, open = false) {
  const geometry = serializeGeometry(new BoxGeometry(10, 10, 10));
  const scene = {
    format: 'kitbasher',
    version: 1,
    units: 'mm',
    name: 'Interference workbench',
    joints: [],
    parts: [-4, 4, 40].map((x, i) => ({
      id: `part-${i}`,
      name: ['Moving block', 'Target block', 'Distant block'][i],
      geometry: i === 0 && open ? serializeGeometry(new PlaneGeometry(10, 10)) : geometry,
      position: [x, 54, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: '#d4a272',
      locked: false,
      visible: true,
      source: 'inspection fixture',
    })),
  };
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page).toHaveTitle('Kitbasher — Assembly workbench');
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'interference.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scene)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Moving block"]').click();
  await page.keyboard.press('f');
}

async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
    const editor = (
      await import(resources.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!)
    ).useEditor.getState();
    const root = (
      await import(resources.find((url) => url.includes('/@react-three_fiber.js'))!)
    )._roots
      .get(document.querySelector('canvas'))
      .store.getState();
    const meshes: {
      name: string;
      opacity: number;
      transparent: boolean;
      color: string;
      positions: number;
    }[] = [];
    root.scene.traverse((object: any) => {
      if (object.isMesh && /^(part:|nearby:|overlap:)/.test(object.name))
        meshes.push({
          name: object.name,
          opacity: object.material.opacity,
          transparent: object.material.transparent,
          color: object.material.color.getHexString(),
          positions: object.geometry.attributes.position.count,
        });
    });
    return {
      meshes,
      revision: editor.revision,
      selected: editor.selected,
      settings: editor.view.inspection,
      parts: editor.scene.parts.map((part: any) => ({
        id: part.id,
        position: part.position,
        quaternion: part.quaternion,
        scale: part.scale,
        vertices: part.geometry.attributes.position.count,
      })),
      camera: root.camera.position.toArray(),
    };
  });
}

const ready = async (page: Page) => {
  await expect(page.locator('.inspection-status')).toContainText(/\d+ pairs? checked/);
  await expect(page.locator('.inspection-status')).toHaveAttribute('aria-busy', 'false');
};

async function moveTarget(page: Page, x: number) {
  await page.locator('.part-select[title="Target block"]').click();
  const field = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await field.fill(String(x));
  await field.press('Enter');
}

async function distance(page: Page, value: string) {
  const input = page.getByRole('spinbutton', { name: 'Near-contact distance in mm' });
  await input.fill(value);
  await input.press('Enter');
}

test('renders overlap and contact layers, can isolate them, and preserves editable parts', async ({
  page,
}) => {
  await fixture(page);
  const before = await snapshot(page);
  await page.getByRole('button', { name: 'Interference', exact: true }).click();
  await ready(page);
  await expect(page.locator('.inspection-status')).toContainText('1 overlapping pair');
  await expect(page.locator('.inspection-status')).toContainText('200 mm³ pairwise overlap');
  await expect
    .poll(
      async () =>
        (await snapshot(page)).meshes.filter((mesh) => mesh.name.startsWith('overlap:')).length,
    )
    .toBe(1);
  const active = await snapshot(page);
  expect(active.parts).toEqual(before.parts);
  expect(active.revision).toBe(before.revision);
  expect(active.selected).toEqual(before.selected);
  expect(active.meshes.find((mesh) => mesh.name === 'part:part-0')).toMatchObject({
    opacity: 0.12,
    transparent: true,
    color: 'a4aab4',
  });
  expect(active.meshes.some((mesh) => mesh.name.startsWith('nearby:') && mesh.positions > 0)).toBe(
    true,
  );
  await page.getByRole('checkbox', { name: 'Show surrounding parts' }).uncheck();
  await expect
    .poll(async () =>
      (await snapshot(page)).meshes
        .filter((mesh) => mesh.name.startsWith('part:'))
        .every((mesh) => mesh.opacity === 0),
    )
    .toBe(true);
  await page.getByRole('checkbox', { name: 'Nearby surfaces' }).uncheck();
  await expect
    .poll(
      async () =>
        (await snapshot(page)).meshes.filter((mesh) => mesh.name.startsWith('nearby:')).length,
    )
    .toBe(0);
  await page.getByRole('checkbox', { name: 'Solid overlap' }).uncheck();
  await expect
    .poll(
      async () =>
        (await snapshot(page)).meshes.filter((mesh) => mesh.name.startsWith('overlap:')).length,
    )
    .toBe(0);
  await page.getByRole('button', { name: 'Close interference view' }).click();
  const restored = await snapshot(page);
  expect(restored.parts).toEqual(before.parts);
  expect(restored.revision).toBe(before.revision);
  expect(restored.meshes.find((mesh) => mesh.name === 'part:part-0')).toMatchObject({
    opacity: 1,
    transparent: false,
  });
});

test('updates true gaps and nearby surface bands when distance, visibility, and placement change', async ({
  page,
}) => {
  await fixture(page);
  await moveTarget(page, 6.25);
  await page.getByRole('button', { name: 'Interference', exact: true }).click();
  await ready(page);
  await expect(page.locator('.inspection-status')).toContainText('0 overlapping pairs');
  await expect(page.getByRole('list', { name: 'Contact pairs' })).toContainText('Gap 0.250 mm');
  await page.getByRole('checkbox', { name: 'Closest-point markers' }).check();
  await expect(page.locator('.inspection-gap-label')).toHaveText('0.250 mm');
  await distance(page, '0.2');
  await ready(page);
  await expect(page.locator('.inspection-status')).toContainText('0 within 0.2 mm');
  expect(
    (await snapshot(page)).meshes.filter((mesh) => /^(nearby:|overlap:)/.test(mesh.name)),
  ).toEqual([]);
  await expect(page.locator('.inspection-gap-label')).toHaveCount(0);
  await distance(page, '0.4');
  await ready(page);
  await expect(page.locator('.inspection-status')).toContainText('1 within 0.4 mm');
  await moveTarget(page, 4);
  await ready(page);
  await expect(page.locator('.inspection-status')).toContainText('1 overlapping pair');
  await page.keyboard.press('ControlOrMeta+z');
  await ready(page);
  await expect(page.getByRole('list', { name: 'Contact pairs' })).toContainText('Gap 0.250 mm');
  await page.getByRole('button', { name: 'Hide Target block', exact: true }).click();
  await ready(page);
  await expect(page.locator('.inspection-status')).toContainText('1 pair checked');
  await expect(page.locator('.inspection-status')).toContainText('0 within 0.4 mm');
  await page.getByRole('button', { name: 'Show Target block', exact: true }).click();
  await ready(page);
  await expect(page.getByRole('list', { name: 'Contact pairs' })).toContainText('Gap 0.250 mm');
  await moveTarget(page, 20);
  await ready(page);
  await expect(page.locator('.inspection-status')).toContainText('0 overlapping pairs');
  await expect(page.locator('.inspection-status')).toContainText('0 within 0.4 mm');
});

test('limits analysis to selected visible parts and handles insufficient selection', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Interference', exact: true }).click();
  await ready(page);
  await page.getByRole('combobox', { name: 'Inspection scope' }).selectOption('selected');
  await expect(page.locator('.inspection-status')).toContainText(
    'Select at least two visible parts',
  );
  await page.locator('.part-select[title="Target block"]').click({ modifiers: ['Shift'] });
  await ready(page);
  await expect(page.locator('.inspection-status')).toContainText('1 pair checked');
  await expect(page.locator('.inspection-status')).toContainText('1 overlapping pair');
  // A single choice replaces the comparison and immediately clears the old overlay.
  await page.locator('.part-select[title="Distant block"]').click();
  await expect(page.locator('.inspection-status')).toContainText(
    'Select at least two visible parts',
  );
  expect((await snapshot(page)).meshes.some((mesh) => mesh.name.startsWith('overlap:'))).toBe(
    false,
  );
});

test('reports unavailable solid results for open scans, keeps proximity, and fits narrow screens', async ({
  page,
}) => {
  await fixture(page, true);
  await page.getByRole('button', { name: 'Interference', exact: true }).click();
  await ready(page);
  await expect(page.getByRole('note')).toContainText('solid overlap unavailable');
  expect((await snapshot(page)).meshes.some((mesh) => mesh.name.startsWith('nearby:'))).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.getByRole('region', { name: 'Interference inspection' });
  await expect(panel).toBeInViewport();
  await distance(page, '0.75');
  await ready(page);
  await expect(page.locator('.inspection-status')).toContainText('within 0.75 mm');
  await page.getByRole('button', { name: 'Collapse interference controls' }).click();
  const before = await snapshot(page);
  await page.keyboard.press('o');
  await page.getByRole('button', { name: 'Orbit right', exact: true }).click();
  expect((await snapshot(page)).camera).not.toEqual(before.camera);
  await expect(page.getByRole('button', { name: 'Expand interference controls' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.getByRole('button', { name: 'Close interference view' }).click();
  await expect(panel).toHaveCount(0);
});

test('keeps long inspection work running, exposes progress, and cancels without accepting stale results', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const testWindow = window as typeof window & { inspectionWorkers: any[] };
    testWindow.inspectionWorkers = [];
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        if (!String(url).includes('inspection.worker')) {
          super(url, options);
          return;
        }
        const worker = {
          onmessage: null as null | ((event: { data: unknown }) => void),
          onerror: null,
          onmessageerror: null,
          terminated: false,
          posted: false,
          postMessage() {
            this.posted = true;
            this.onmessage?.({
              data: {
                progress: {
                  stage: 'indexing',
                  detail: 'Indexing detailed scan',
                  fraction: 0.4,
                },
              },
            });
          },
          terminate() {
            this.terminated = true;
          },
        };
        testWindow.inspectionWorkers.push(worker);
        return worker as unknown as Worker;
      }
    };
  });
  await fixture(page);
  await page.getByRole('button', { name: 'Interference', exact: true }).click();
  await expect(page.locator('.inspection-status')).toContainText('Indexing detailed scan');
  await expect(
    page.getByRole('progressbar', { name: 'Interference stage progress' }),
  ).toHaveAttribute('value', '0.4');
  await page.clock.install();
  await page.clock.fastForward(65_000);
  await expect(page.locator('.inspection-status')).toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => (window as any).inspectionWorkers[0].terminated)).toBe(false);
  await page.getByRole('button', { name: 'Cancel inspection', exact: true }).click();
  await expect(page.locator('.inspection-status')).toContainText('Inspection cancelled.');
  expect(await page.evaluate(() => (window as any).inspectionWorkers[0].terminated)).toBe(true);
  await page.evaluate(() =>
    (window as any).inspectionWorkers[0].onmessage({
      data: {
        error: 'A stale worker must not replace the cancellation',
      },
    }),
  );
  await expect(page.locator('.inspection-status')).toContainText('Inspection cancelled.');
  await expect(page.locator('.inspection-status')).not.toContainText('stale');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.clock.runFor(350);
  await expect(page.locator('.inspection-status')).toContainText('Indexing detailed scan');
  expect(await page.evaluate(() => (window as any).inspectionWorkers.length)).toBe(2);
  await page.evaluate(() => (window as any).inspectionWorkers[1].onmessageerror());
  await expect(page.locator('.inspection-status')).toContainText('unreadable result');
  expect(await page.evaluate(() => (window as any).inspectionWorkers[1].terminated)).toBe(true);
});
