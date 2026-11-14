import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';
import { readSavedScene } from './saved-scene';

const fixture = {
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Pin workflow',
  joints: [],
  parts: [
    {
      id: 'moving',
      name: 'Pinned part',
      geometry: serializeGeometry(new BoxGeometry(32, 32, 2)),
      position: [0, 24, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: '#d4a272',
      visible: true,
      locked: false,
      source: 'test',
    },
  ],
};
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on('pageerror', (error) => list.push(error.message));
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));

async function state(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((e) => e.name);
    const { useEditor } = await import(
      urls.find((u) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(u))!
    );
    const { pinGaps } = await import(urls.find((u) => /\/src\/core\/pins\.ts(?:\?.*)?$/.test(u))!);
    const s = useEditor.getState(),
      part = s.scene.parts[0];
    return {
      position: part.position,
      quaternion: part.quaternion,
      scale: part.scale,
      pins: part.pins,
      gaps: pinGaps(part),
      past: s.past.length,
      vertices: Array.from(part.geometry.getAttribute('position').array),
    };
  });
}
async function point(page: Page, name: string, local: number[], geometry?: string) {
  const rect = (await page.locator('canvas').boundingBox())!;
  const ndc = await page.evaluate(
    async ({ name, local, geometry }) => {
      const url = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((u) => u.includes('/@react-three_fiber.js'))!;
      const root = (await import(url))._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      let target: any;
      root.scene.traverse((o: any) => {
        if (!target && o.name === name && (!geometry || o.geometry?.type === geometry)) target = o;
      });
      target.updateWorldMatrix(true, false);
      return root.camera.position
        .clone()
        .fromArray(local)
        .applyMatrix4(target.matrixWorld)
        .project(root.camera)
        .toArray();
    },
    { name, local, geometry },
  );
  return {
    x: rect.x + ((ndc[0] + 1) * rect.width) / 2,
    y: rect.y + ((1 - ndc[1]) * rect.height) / 2,
  };
}
async function open(page: Page) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'pins.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Pinned part"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page.getByTitle('Pin parts in space').click();
}
async function place(page: Page, local: number[]) {
  const p = await point(page, 'part:moving', local);
  await page.mouse.click(p.x, p.y);
}
async function undo(page: Page) {
  await page.getByRole('button', { name: /^Undo \((⌘|Ctrl)\+Z\)$/ }).click();
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

test('places mixed pins, edits priority by number and slider, and saves/reopens them', async ({
  page,
}) => {
  await open(page);
  await place(page, [-10, -10, 1]);
  await page.getByRole('button', { name: 'Soft pin', exact: true }).click();
  await place(page, [10, 10, 1]);
  await page.getByRole('button', { name: 'Finish placing pins', exact: true }).click();
  const field = page.getByRole('spinbutton', { name: 'Soft pin priority', exact: true });
  await field.fill('82');
  await field.press('Enter');
  await page.getByRole('slider', { name: 'Soft pin priority slider' }).focus();
  await page.keyboard.press('ArrowRight');
  expect((await state(page)).pins[1].priority).toBe(83);
  await undo(page);
  expect((await state(page)).pins[1].priority).toBe(82);
  const before = await state(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const { scene, bytes } = await readSavedScene((await (await download).path())!);
  expect(scene.parts[0].pins).toEqual(before.pins);
  await page
    .getByLabel('Open Kitbasher scene')
    .setInputFiles({ name: 'saved.kitbash', mimeType: 'application/octet-stream', buffer: bytes });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Pinned part"]').click();
  expect((await state(page)).pins).toEqual(before.pins);
  expect((await state(page)).vertices).toEqual(before.vertices);
  await page.getByTitle('Pin parts in space').click();
  await expect(page.getByRole('button', { name: 'Select hard pin 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove pin 2', exact: true }).click();
  expect((await state(page)).pins).toHaveLength(1);
});

test('rotates around a hard surface pin using the actual gizmo, as one undo step', async ({
  page,
}) => {
  await open(page);
  await place(page, [-10, -10, 1]);
  await page.getByRole('button', { name: 'Finish placing pins', exact: true }).click();
  await page.keyboard.press('t');
  const before = await state(page);
  const radius = 0.78;
  const from = await point(page, 'transform:rotate:Z', [
    radius * Math.cos(Math.PI / 4),
    radius * Math.sin(Math.PI / 4),
    0,
  ]);
  const to = await point(page, 'transform:rotate:Z', [
    radius * Math.cos(Math.PI / 2.5),
    radius * Math.sin(Math.PI / 2.5),
    0,
  ]);
  await drag(page, from, to);
  const after = await state(page);
  expect(after.quaternion).not.toEqual(before.quaternion);
  expect(after.gaps[0]).toBeLessThan(1e-6);
  expect(after.pins).toEqual(before.pins);
  expect(after.vertices).toEqual(before.vertices);
  expect(after.scale).toEqual(before.scale);
  expect(after.past).toBe(before.past + 1);
  await undo(page);
  expect((await state(page)).position).toEqual(before.position);
  expect((await state(page)).quaternion).toEqual(before.quaternion);
});

test('higher soft-pin priority resists the same pointer movement more strongly', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Soft pin', exact: true }).click();
  await place(page, [0, 0, 1]);
  await page.getByRole('button', { name: 'Finish placing pins', exact: true }).click();
  const priority = page.getByRole('spinbutton', { name: 'Soft pin priority', exact: true });
  await priority.fill('15');
  await priority.press('Enter');
  await page.keyboard.press('t');
  const before = await state(page);
  const move = async () => {
    const handle = await point(page, 'transform:move:X', [0, 0, 0], 'ConeGeometry');
    await drag(page, handle, { x: handle.x + 60, y: handle.y });
  };
  await move();
  const weak = await state(page);
  expect(weak.gaps[0]).toBeGreaterThan(0.1);
  expect(weak.past).toBe(before.past + 1);
  await undo(page);
  await priority.fill('90');
  await priority.press('Enter');
  await page.locator('canvas').focus();
  await move();
  const strong = await state(page);
  expect(strong.gaps[0]).toBeLessThan(weak.gaps[0] / 10);
  expect(strong.pins[0].target).toEqual(before.pins[0].target);
  expect(strong.vertices).toEqual(before.vertices);
});
