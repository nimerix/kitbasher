import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';
import { fixture, inStore, openScene, screen } from './helpers/refine';
import { failOnBrowserErrors } from './helpers/warp-grid';
import { readSavedScene } from './saved-scene';

failOnBrowserErrors();

const block = {
  ...fixture,
  parts: [
    {
      ...fixture.parts[0],
      name: 'Coarse block',
      source: 'block.stl',
      geometry: serializeGeometry(new BoxGeometry(8, 6, 4)),
    },
  ],
};

async function openSculpt(page: Page) {
  await openScene(page, block);
  await page.locator('.part-select[title="Coarse block"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page
    .getByRole('toolbar', { name: 'Assembly tools' })
    .getByRole('button', { name: /^Sculpt\b/ })
    .click();
}

const mesh = (page: Page) =>
  inStore(page, (state) => {
    const geometry = state.scene.parts[0].geometry;
    const positions = geometry.getAttribute('position');
    let peak = -Infinity;
    for (let i = 0; i < positions.count; i++) peak = Math.max(peak, positions.getZ(i));
    return {
      positions: Array.from(positions.array),
      indices: geometry.index ? Array.from(geometry.index.array) : null,
      triangles: (geometry.index?.count ?? positions.count) / 3,
      peak,
    };
  });

async function penTap(page: Page, pressure: number) {
  const point = await screen(page, [1, 0, 2]);
  const session = await page.context().newCDPSession(page);
  try {
    const sample = { ...point, pointerType: 'pen' as const, button: 'left' as const };
    await session.send('Input.dispatchMouseEvent', {
      ...sample,
      type: 'mousePressed',
      buttons: 1,
      force: pressure,
    });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await session.send('Input.dispatchMouseEvent', {
      ...sample,
      type: 'mouseReleased',
      buttons: 0,
    });
  } finally {
    await session.detach();
  }
}

test('draws into a coarse face with pen pressure and undoes topology with displacement', async ({
  page,
}) => {
  await openSculpt(page);
  const before = await mesh(page);
  await penTap(page, 0.25);
  await expect.poll(async () => (await mesh(page)).peak).toBeGreaterThan(before.peak);
  const light = await mesh(page);
  expect(light.triangles).toBeGreaterThan(before.triangles);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => mesh(page)).toEqual(before);
  await penTap(page, 0.9);
  await expect.poll(async () => (await mesh(page)).peak).toBeGreaterThan(light.peak);
  const heavy = await mesh(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => mesh(page)).toEqual(before);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => mesh(page)).toEqual(heavy);
});

test('cancels an active stroke and reopens the completed stroke from disk', async ({ page }) => {
  await openSculpt(page);
  const before = await mesh(page);
  const point = await screen(page, [1, 0, 2]);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 12, point.y, { steps: 3 });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const url = performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((url) => /\/src\/xr\/part-meshes\.ts(?:\?.*)?$/.test(url))!;
        const { partMeshes } = await import(url);
        const geometry = partMeshes.get('block').geometry;
        return Math.min(
          geometry.drawRange.count,
          geometry.index?.count ?? geometry.getAttribute('position').count,
        );
      }),
    )
    .toBeGreaterThan(before.triangles * 3);
  expect(await mesh(page)).toEqual(before);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await mesh(page)).toEqual(before);
  expect(await inStore(page, (state) => state.sculpt?.past.length)).toBe(0);
  await penTap(page, 0.8);
  await expect.poll(async () => (await mesh(page)).triangles).toBeGreaterThan(before.triangles);
  const completed = await mesh(page);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const file = await readSavedScene((await (await downloading).path())!);
  const oldGeometry = await inStore(page, (state) => state.scene.parts[0].geometry.uuid);
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'sculpt.kitbash',
    mimeType: 'application/octet-stream',
    buffer: file.bytes,
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await expect
    .poll(() => inStore(page, (state) => state.scene.parts[0].geometry.uuid))
    .not.toBe(oldGeometry);
  await expect.poll(() => mesh(page)).toEqual(completed);
});

test('a fully inverted mask protects the coarse surface until cleared', async ({ page }) => {
  await openSculpt(page);
  const before = await mesh(page);
  await page.getByRole('combobox', { name: 'Brush', exact: true }).selectOption('mask');
  await page.getByRole('button', { name: /invert mask/i }).click();
  await page.getByRole('combobox', { name: 'Brush', exact: true }).selectOption('draw');
  await penTap(page, 0.9);
  expect(await mesh(page)).toEqual(before);
  await page.getByRole('combobox', { name: 'Brush', exact: true }).selectOption('mask');
  await page.getByRole('button', { name: /clear mask/i }).click();
  await page.getByRole('combobox', { name: 'Brush', exact: true }).selectOption('draw');
  await penTap(page, 0.9);
  await expect.poll(async () => (await mesh(page)).peak).toBeGreaterThan(before.peak);
});

test('mask paint subdivides without displacement and restores weights with undo and redo', async ({
  page,
}) => {
  await openSculpt(page);
  const before = await mesh(page);
  const weights = () => inStore(page, (state) => Array.from(state.sculpt?.mask ?? []));
  await page.getByRole('combobox', { name: 'Brush', exact: true }).selectOption('mask');
  await penTap(page, 0.8);
  await expect.poll(async () => (await weights()).some((weight) => weight > 0)).toBe(true);
  const painted = await mesh(page);
  expect(painted.triangles).toBeGreaterThan(before.triangles);
  expect(painted.peak).toEqual(before.peak);
  const protection = await weights();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => mesh(page)).toEqual(before);
  expect(await weights()).toEqual([]);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => mesh(page)).toEqual(painted);
  expect(await weights()).toEqual(protection);
});

test('applies Clay Buildup and Inflate and keeps their falloff settings independent', async ({
  page,
}) => {
  await openSculpt(page);
  const before = await mesh(page);
  const brush = page.getByRole('combobox', { name: 'Brush', exact: true });
  const falloff = page.getByRole('combobox', { name: 'Falloff' });
  await page.getByText('Advanced brush settings', { exact: true }).click();
  await brush.selectOption({ label: 'Clay Buildup' });
  await falloff.selectOption('hard');
  await penTap(page, 0.9);
  await expect.poll(async () => (await mesh(page)).peak).toBeGreaterThan(before.peak);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => mesh(page)).toEqual(before);
  await brush.selectOption({ label: 'Inflate/Deflate' });
  await expect(falloff).toHaveValue('soft');
  await penTap(page, 0.9);
  await expect.poll(async () => (await mesh(page)).peak).toBeGreaterThan(before.peak);
  await brush.selectOption({ label: 'Clay Buildup' });
  await expect(falloff).toHaveValue('hard');
  await page.getByRole('button', { name: 'Reset brush settings' }).click();
  await expect(falloff).toHaveValue('soft');
});
