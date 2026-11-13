import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry, Quaternion, Vector3 } from 'three';
import { serializeGeometry } from '../../src/core/geometry';

const cube = {
  id: 'cube',
  name: 'Free cube',
  geometry: serializeGeometry(new BoxGeometry(30, 30, 30)),
  position: [0, 15, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#d4a272',
  locked: false,
  visible: true,
  source: 'test',
  pivot: [4, 3, 2],
};
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on('pageerror', (error) => list.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') list.push(message.text());
  });
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));

async function openFixture(page: Page, parts = [cube]) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'free.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'kitbasher',
        version: 1,
        units: 'mm',
        name: 'Free placement',
        parts,
        joints: [],
      }),
    ),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Free cube"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  const box = (await page.locator('canvas').boundingBox())!;
  const pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(pointer.x, pointer.y);
  return pointer;
}
async function state(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor, committedScene } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const fiber = await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!);
    const root = fiber._roots.get(document.querySelector('canvas')).store.getState();
    const s = useEditor.getState();
    return {
      past: s.past.length,
      future: s.future.length,
      revision: s.revision,
      free: s.freeTransform ? { mode: s.freeTransform.mode, axis: s.freeTransform.axis } : null,
      parts: s.scene.parts.map((p: any) => ({
        id: p.id,
        position: p.position,
        quaternion: p.quaternion,
        scale: p.scale,
        pivot: p.pivot,
      })),
      committed: committedScene(s).parts.map((p: any) => p.position),
      selected: s.selected,
      camera: root.camera.position.toArray(),
      enabled: root.controls.enabled,
    };
  });
}
const active = (page: Page) => page.locator('.free-transform-prompt');

test('local recovery keeps the committed pose while a free preview is open', async ({ page }) => {
  const pointer = await openFixture(page);
  await page.keyboard.press('Shift+g');
  await page.mouse.move(pointer.x + 80, pointer.y, { steps: 8 });
  await page.waitForTimeout(1200);
  const position = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/src\/core\/recovery\.ts(?:\?.*)?$/.test(url))!;
    return (await (await import(url)).readRecovery()).scene.parts[0].position;
  });
  expect(position).toEqual([0, 15, 0]);
  await page.keyboard.press('Escape');
});

test('moves with the pointer alone and confirms without selecting or orbiting; one undo restores it', async ({
  page,
}) => {
  const pointer = await openFixture(page),
    before = await state(page);
  await page.keyboard.press('Shift+g');
  await expect(active(page)).toBeVisible();
  await expect.poll(async () => (await state(page)).enabled).toBe(false);
  const camera = (await state(page)).camera;
  await page.mouse.move(pointer.x + 60, pointer.y - 25, { steps: 12 });
  const preview = await state(page);
  expect(preview.parts[0].position[0]).toBeGreaterThan(1);
  expect(preview.parts[0].position[1]).toBeGreaterThan(15);
  expect(preview.committed).toEqual(before.committed);
  expect(preview.revision).toBe(before.revision);
  expect(preview.past).toBe(0);
  expect(preview.camera).toEqual(camera);
  await page.mouse.click(pointer.x + 60, pointer.y - 25);
  await expect(active(page)).toHaveCount(0);
  const confirmed = await state(page);
  expect(confirmed.parts).toEqual(preview.parts);
  expect(confirmed.selected).toEqual(['cube']);
  expect(confirmed.past).toBe(1);
  expect(confirmed.camera).toEqual(camera);
  await expect.poll(async () => (await state(page)).enabled).toBe(true);
  await page.keyboard.press('Control+z');
  expect((await state(page)).parts).toEqual(before.parts);
});

test('Esc, right-click and interruption restore the complete preview without consuming redo', async ({
  page,
}) => {
  const pointer = await openFixture(page);
  const field = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await field.fill('5');
  await field.press('Enter');
  await page.keyboard.press('Control+z');
  const before = await state(page);
  for (const cancel of ['Escape', 'right', 'blur', 'pointercancel'] as const) {
    await page.mouse.move(pointer.x, pointer.y);
    await page.keyboard.press('Shift+g');
    await page.mouse.move(pointer.x + 40, pointer.y + 20, { steps: 6 });
    expect((await state(page)).parts).not.toEqual(before.parts);
    if (cancel === 'right')
      await page.mouse.click(pointer.x + 40, pointer.y + 20, { button: 'right' });
    else if (cancel === 'blur' || cancel === 'pointercancel')
      await page.evaluate((name) => window.dispatchEvent(new Event(name)), cancel);
    else await page.keyboard.press(cancel);
    await expect(active(page)).toHaveCount(0);
    const after = await state(page);
    expect(after.parts).toEqual(before.parts);
    expect(after.past).toBe(before.past);
    expect(after.future).toBe(before.future);
    await expect(page.getByRole('menu', { name: 'Component actions' })).toHaveCount(0);
    await expect.poll(async () => (await state(page)).enabled).toBe(true);
  }
  await page.keyboard.press('Control+Shift+z');
  await expect(field).toHaveValue('5');
});

test('rotates freely in 3D about the custom pivot and confirms with Enter', async ({ page }) => {
  const pointer = await openFixture(page),
    before = await state(page);
  const pivot = new Vector3(...cube.pivot).add(new Vector3(...cube.position));
  await page.keyboard.press('Shift+r');
  await page.mouse.move(pointer.x + 70, pointer.y + 40, { steps: 12 });
  const preview = await state(page),
    part = preview.parts[0];
  expect(Math.abs(part.quaternion[0])).toBeGreaterThan(0.01);
  expect(Math.abs(part.quaternion[1])).toBeGreaterThan(0.01);
  const movedPivot = new Vector3(...cube.pivot)
    .applyQuaternion(new Quaternion(...part.quaternion))
    .add(new Vector3(...part.position));
  expect(movedPivot.distanceTo(pivot)).toBeLessThan(1e-6);
  expect(part.scale).toEqual(before.parts[0].scale);
  await page.keyboard.press('Enter');
  expect((await state(page)).past).toBe(1);
  await expect(active(page)).toHaveCount(0);
  await page.keyboard.press('Control+z');
  expect((await state(page)).parts).toEqual(before.parts);
});

test('constrains move and rotation axes, reaches depth, and uses the chosen snap increments', async ({
  page,
}) => {
  const pointer = await openFixture(page);
  await page.getByRole('button', { name: 'Snap', exact: true }).click();
  await page.getByRole('combobox', { name: 'Snap distance' }).selectOption('0.5');
  await page.mouse.move(pointer.x, pointer.y);
  await page.keyboard.press('Shift+g');
  await page.keyboard.press('z');
  await expect(active(page)).toContainText('Z axis');
  await page.mouse.move(pointer.x + 37, pointer.y - 29, { steps: 8 });
  const preview = (await state(page)).parts[0];
  expect(preview.position[0]).toBe(0);
  expect(preview.position[1]).toBe(15);
  expect(preview.position[2]).not.toBe(0);
  expect(preview.position[2] / 0.5).toBeCloseTo(Math.round(preview.position[2] / 0.5), 6);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Rotate (R)', exact: true }).click();
  await page.getByRole('combobox', { name: 'Snap angle' }).selectOption('5');
  await page.mouse.move(pointer.x, pointer.y);
  await page.keyboard.press('Shift+r');
  await page.keyboard.press('z');
  await page.mouse.move(pointer.x + 72, pointer.y, { steps: 8 });
  const q = new Quaternion(...(await state(page)).parts[0].quaternion);
  expect(Math.abs(q.x) + Math.abs(q.y)).toBeLessThan(1e-8);
  const angle = (q.angleTo(new Quaternion()) * 180) / Math.PI;
  expect(angle).toBeGreaterThan(5);
  expect(angle / 5).toBeCloseTo(Math.round(angle / 5), 6);
  await active(page)
    .getByRole('button', { name: /^Confirm/ })
    .click();
  expect((await state(page)).past).toBe(1);
});

test('switches fine sensitivity mid-gesture continuously', async ({ page }) => {
  const pointer = await openFixture(page);
  await page.keyboard.press('Shift+g');
  await page.mouse.move(pointer.x + 30, pointer.y);
  const normal = (await state(page)).parts[0].position[0];
  await page.keyboard.down('Shift');
  expect((await state(page)).parts[0].position[0]).toBe(normal);
  await page.mouse.move(pointer.x + 60, pointer.y);
  const fine = (await state(page)).parts[0].position[0];
  expect((fine - normal) / normal).toBeCloseTo(0.1, 5);
  await page.keyboard.up('Shift');
  expect((await state(page)).parts[0].position[0]).toBe(fine);
  await page.mouse.move(pointer.x + 90, pointer.y);
  expect(((await state(page)).parts[0].position[0] - fine) / normal).toBeCloseTo(1, 5);
  await page.keyboard.press('Escape');
});

test('pauses outside the viewport and resumes without a jump', async ({ page }) => {
  const pointer = await openFixture(page);
  const rect = (await page.locator('canvas').boundingBox())!;
  await page.keyboard.press('Shift+g');
  await page.mouse.move(pointer.x + 30, pointer.y);
  const first = (await state(page)).parts;
  await page.mouse.move(rect.x - 80, pointer.y);
  expect((await state(page)).parts).toEqual(first);
  await page.mouse.move(pointer.x, pointer.y);
  expect((await state(page)).parts).toEqual(first);
  await page.mouse.move(pointer.x + 10, pointer.y);
  expect((await state(page)).parts[0].position[0]).toBeGreaterThan(first[0].position[0]);
  await page.keyboard.press('Escape');
});

test('works in orthographic view with a group and cancels when clicking another control', async ({
  page,
}) => {
  const pointer = await openFixture(page, [
    cube,
    { ...cube, id: 'second', name: 'Second cube', position: [50, 15, 0] },
  ]);
  await page.locator('.part-select[title="Second cube"]').click({ modifiers: ['Shift'] });
  await page.keyboard.press('5');
  const before = await state(page);
  await page.mouse.move(pointer.x, pointer.y);
  await page.keyboard.press('Shift+g');
  await page.mouse.move(pointer.x + 50, pointer.y + 25, { steps: 10 });
  const after = await state(page);
  const deltaA = new Vector3(...after.parts[0].position).sub(
    new Vector3(...before.parts[0].position),
  );
  const deltaB = new Vector3(...after.parts[1].position).sub(
    new Vector3(...before.parts[1].position),
  );
  expect(deltaA.length()).toBeGreaterThan(1);
  expect(deltaA.distanceTo(deltaB)).toBeLessThan(1e-8);
  await page.getByRole('button', { name: 'Select (V)', exact: true }).click();
  expect((await state(page)).parts).toEqual(before.parts);
  expect((await state(page)).past).toBe(before.past);
});

test('allows rebinding free placement and leaves text editing alone', async ({ page }) => {
  const pointer = await openFixture(page);
  await page.getByRole('button', { name: /^Preferences \(/ }).click();
  const panel = page.getByRole('dialog', { name: 'Preferences' });
  await panel.getByRole('tab', { name: 'Keyboard' }).click();
  await panel
    .getByRole('button', { name: 'Change Shift+G for Free move with pointer', exact: true })
    .click();
  await page.keyboard.press('Alt+g');
  await page.keyboard.press('Escape');
  const x = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await x.focus();
  await page.keyboard.press('Alt+g');
  expect((await state(page)).free).toBeNull();
  await x.press('Enter');
  await page.mouse.move(pointer.x, pointer.y);
  await page.keyboard.press('Shift+g');
  expect((await state(page)).free).toBeNull();
  await page.keyboard.press('Alt+g');
  await expect(active(page)).toBeVisible();
  await page.mouse.move(pointer.x + 40, pointer.y);
  await page.keyboard.press('Enter');
  expect((await state(page)).past).toBe(1);
});
