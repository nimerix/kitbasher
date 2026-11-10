import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';

const box = (id: string, name: string, size: number[], position: number[], color: string) => ({
  id,
  name,
  geometry: serializeGeometry(new BoxGeometry(...size)),
  position,
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color,
  visible: true,
  locked: false,
  source: 'test',
});
const fixture = {
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Clipping',
  joints: [],
  parts: [
    box('wall', 'Wall', [10, 40, 40], [0, 20, 0], '#8fa3b8'),
    box('block', 'Block', [10, 10, 10], [30, 20, 0], '#d4a272'),
  ],
};

test.use({ storageState: { cookies: [], origins: [] } });

async function block(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((e) => e.name);
    const { useEditor } = await import(
      urls.find((u) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(u))!
    );
    const s = useEditor.getState();
    return { x: s.scene.parts[1].position[0] as number, past: s.past.length as number };
  });
}

async function handle(page: Page) {
  const bounds = (await page.locator('canvas').boundingBox())!;
  const ndc = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((u) => u.includes('/@react-three_fiber.js'))!;
    const root = (await import(url))._roots.get(document.querySelector('canvas')).store.getState();
    let controls: any;
    root.scene.traverse((object: any) => {
      if (object.isTransformControls && object.visible) controls = object;
    });
    const x = controls.gizmo.picker.translate.children.find((o: any) => o.name === 'X');
    x.geometry.computeBoundingBox();
    const point = x.geometry.boundingBox.getCenter(root.camera.position.clone());
    x.localToWorld(point);
    return point.project(root.camera).toArray();
  });
  return {
    x: bounds.x + ((ndc[0] + 1) * bounds.width) / 2,
    y: bounds.y + ((1 - ndc[1]) * bounds.height) / 2,
  };
}

async function setup(page: Page) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'clipping.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Block"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
}

const toggle = (page: Page) => page.getByRole('button', { name: 'Avoid clipping', exact: true });
const typeX = async (page: Page, value: string) => {
  const field = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await field.fill(value);
  await field.press('Enter');
};

test('typed moves stop at other parts, by an allowance that is adjustable and remembered', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setup(page);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');

  await typeX(page, '2');
  expect((await block(page)).x).toBeCloseTo(9.9, 3);
  await expect(page.getByRole('status').filter({ hasText: 'to clear Wall' })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue(
    '9.9',
  );

  const overlap = page.getByRole('spinbutton', { name: 'Allowed overlap', exact: true });
  await overlap.fill('1');
  await overlap.press('Enter');
  await typeX(page, '2');
  expect((await block(page)).x).toBeCloseTo(9, 3);

  await page.reload();
  await expect(page.getByRole('spinbutton', { name: 'Allowed overlap', exact: true })).toHaveValue(
    '1',
  );

  await setup(page);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('spinbutton', { name: 'Allowed overlap' })).toHaveCount(0);
  await typeX(page, '2');
  expect((await block(page)).x).toBe(2);
  expect(errors).toEqual([]);
});

test('a dragged part stops at a surface instead of passing through, in one undo step', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setup(page);
  await page.keyboard.press('g');
  const from = await handle(page);
  // Far past the wall, which the part would pass through with the toggle off.
  const pixelsPerMm = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((u) => u.includes('/@react-three_fiber.js'))!;
    const root = (await import(url))._roots.get(document.querySelector('canvas')).store.getState();
    const a = root.camera.position.clone().set(0, 20, 0).project(root.camera);
    const b = root.camera.position.clone().set(1, 20, 0).project(root.camera);
    return ((b.x - a.x) * root.size.width) / 2;
  });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 60 * pixelsPerMm, from.y, { steps: 40 });
  await page.mouse.up();
  const after = await block(page);
  expect(after.x).toBeGreaterThan(9.85);
  expect(after.x).toBeLessThan(10.2);
  expect(after.past).toBe(1);
  await page.keyboard.press('ControlOrMeta+z');
  expect((await block(page)).x).toBe(30);

  await toggle(page).click();
  await page.locator('.part-select[title="Block"]').click();
  await page.keyboard.press('g');
  const again = await handle(page);
  await page.mouse.move(again.x, again.y);
  await page.mouse.down();
  await page.mouse.move(again.x - 60 * pixelsPerMm, again.y, { steps: 40 });
  await page.mouse.up();
  expect((await block(page)).x).toBeLessThan(-20);
  expect(errors).toEqual([]);
});
