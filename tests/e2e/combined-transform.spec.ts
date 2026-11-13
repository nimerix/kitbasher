import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';

const cube = {
  id: 'cube',
  name: 'Transform cube',
  geometry: serializeGeometry(new BoxGeometry(30, 30, 30)),
  position: [0, 15, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#d4a272',
  visible: true,
  locked: false,
  source: 'test',
  pivot: [3, 2, 0],
};
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on('pageerror', (e) => list.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') list.push(m.text());
  });
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));

async function open(page: Page) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'combined.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'kitbasher',
        version: 1,
        units: 'mm',
        name: 'Combined transform',
        parts: [cube],
        joints: [],
      }),
    ),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Transform cube"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page.keyboard.press('t');
  await expect(page.getByRole('button', { name: 'Transform (T)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
}
async function state(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((e) => e.name);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const fiber = await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!);
    const { anchorError } = await import(
      urls.find((url) => /\/src\/core\/constraints\.ts(?:\?.*)?$/.test(url))!
    );
    const root = fiber._roots.get(document.querySelector('canvas')).store.getState(),
      s = useEditor.getState();
    const handles: string[] = [];
    root.scene.traverse((o: any) => {
      if (o.userData.transformHandle && o.name.startsWith('transform:')) handles.push(o.name);
    });
    return {
      tool: s.tool,
      past: s.past.length,
      future: s.future.length,
      selected: s.selected,
      parts: s.scene.parts.map((p: any) => ({
        id: p.id,
        position: p.position,
        quaternion: p.quaternion,
        scale: p.scale,
      })),
      enabled: root.controls.enabled,
      handles,
      jointErrors: s.scene.joints.map((j: any) => anchorError(s.scene.parts, j)),
    };
  });
}
async function point(page: Page, name: string, local = [0, 0, 0], geometry?: string) {
  const rect = (await page.locator('canvas').boundingBox())!;
  const ndc = await page.evaluate(
    async ({ name, local, geometry }) => {
      const url = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((url) => url.includes('/@react-three_fiber.js'))!;
      const fiber = await import(url),
        root = fiber._roots.get(document.querySelector('canvas')).store.getState();
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
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

test('provides move, rotate, and scale together, with one undo step for each real drag', async ({
  page,
}) => {
  await open(page);
  const initial = await state(page);
  expect(initial.handles).toContain('transform:move:X');
  expect(initial.handles).toContain('transform:rotate:Z');
  expect(initial.handles).toContain('transform:scale:X');
  const move = await point(page, 'transform:move:X', [0, 0, 0], 'ConeGeometry');
  await drag(page, move, { x: move.x + 45, y: move.y });
  let after = await state(page);
  expect(after.parts[0].position[0]).toBeGreaterThan(initial.parts[0].position[0] + 1);
  expect(after.parts[0].scale).toEqual(initial.parts[0].scale);
  expect(after.past).toBe(1);
  await page.keyboard.press('Control+z');
  expect((await state(page)).tool).toBe('transform');
  const radius = 0.78,
    a = await point(page, 'transform:rotate:Z', [
      radius * Math.cos(Math.PI / 4),
      radius * Math.sin(Math.PI / 4),
      0,
    ]);
  const b = await point(page, 'transform:rotate:Z', [
    radius * Math.cos(Math.PI / 2.5),
    radius * Math.sin(Math.PI / 2.5),
    0,
  ]);
  await drag(page, a, b);
  after = await state(page);
  expect(Math.abs(after.parts[0].quaternion[2])).toBeGreaterThan(0.05);
  expect(after.parts[0].scale).toEqual(initial.parts[0].scale);
  expect(after.past).toBe(1);
  await page.keyboard.press('Control+z');
  const scale = await point(page, 'transform:scale:X');
  await drag(page, scale, { x: scale.x + 35, y: scale.y });
  after = await state(page);
  expect(after.parts[0].scale[0]).toBeGreaterThan(1.1);
  expect(after.parts[0].scale[1]).toBeCloseTo(1, 8);
  expect(after.past).toBe(1);
  expect(after.selected).toEqual(['cube']);
  expect(after.enabled).toBe(true);
});

test('removes scaling from display and picking, persists the choice, and keeps movement usable', async ({
  page,
}) => {
  await open(page);
  const formerScale = await point(page, 'transform:scale:X');
  await page.getByRole('checkbox', { name: 'Enable scaling', exact: true }).uncheck();
  expect((await state(page)).handles.filter((name) => name.startsWith('transform:scale:'))).toEqual(
    [],
  );
  await drag(page, formerScale, { x: formerScale.x + 35, y: formerScale.y });
  expect((await state(page)).parts[0].scale).toEqual([1, 1, 1]);
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.reload();
  await page.locator('.part-select[title="Transform cube"]').click();
  await page.keyboard.press('t');
  await expect(
    page.getByRole('checkbox', { name: 'Enable scaling', exact: true }),
  ).not.toBeChecked();
  expect((await state(page)).handles.filter((name) => name.startsWith('transform:scale:'))).toEqual(
    [],
  );
  const before = await state(page),
    move = await point(page, 'transform:move:X', [0, 0, 0], 'ConeGeometry');
  await drag(page, move, { x: move.x + 35, y: move.y });
  expect((await state(page)).parts[0].position).not.toEqual(before.parts[0].position);
  expect((await state(page)).parts[0].scale).toEqual(before.parts[0].scale);
  await page.getByRole('button', { name: /^Preferences \(/ }).click();
  await expect(
    page.getByRole('switch', { name: 'Enable scaling in Transform tool', exact: true }),
  ).toHaveAttribute('aria-checked', 'false');
});

test('preserves redo on a click without motion and restores camera input on interruption', async ({
  page,
}) => {
  await open(page);
  const move = await point(page, 'transform:move:X', [0, 0, 0], 'ConeGeometry');
  await drag(page, move, { x: move.x + 35, y: move.y });
  await page.keyboard.press('Control+z');
  const before = await state(page),
    again = await point(page, 'transform:move:X', [0, 0, 0], 'ConeGeometry');
  await page.mouse.click(again.x, again.y);
  expect((await state(page)).past).toBe(before.past);
  expect((await state(page)).future).toBe(before.future);
  await page.mouse.move(again.x, again.y);
  await page.mouse.down();
  await page.mouse.move(again.x + 15, again.y, { steps: 5 });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  expect((await state(page)).enabled).toBe(true);
  const next = await point(page, 'transform:move:X', [0, 0, 0], 'ConeGeometry'),
    changed = await state(page);
  await drag(page, next, { x: next.x + 15, y: next.y });
  expect((await state(page)).parts).not.toEqual(changed.parts);
});

test('shows only free joint rotation axes and keeps the anchor connected', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.locator('.part-select[title="Optics & head"]').click();
  await page
    .locator('.part-row')
    .filter({ has: page.locator('.part-select[title="Torso shell"]') })
    .getByRole('button', { name: 'Lock Torso shell', exact: true })
    .click();
  await page.keyboard.press('t');
  const handles = (await state(page)).handles;
  expect(handles).not.toContain('transform:move:X');
  expect(handles).not.toContain('transform:rotate:X');
  expect(handles).not.toContain('transform:rotate:Z');
  expect(handles).toContain('transform:rotate:Y');
  const from = await point(page, 'transform:rotate:Y', [
    0.78 * Math.cos(Math.PI / 4),
    0.78 * Math.sin(Math.PI / 4),
    0,
  ]);
  const to = await point(page, 'transform:rotate:Y', [
    0.78 * Math.cos(Math.PI / 2.5),
    0.78 * Math.sin(Math.PI / 2.5),
    0,
  ]);
  const before = await state(page);
  await drag(page, from, to);
  const after = await state(page);
  expect(after.parts.find((p: { id: string }) => p.id === 'head')?.quaternion).not.toEqual(
    before.parts.find((p: { id: string }) => p.id === 'head')?.quaternion,
  );
  expect(after.jointErrors.every((error: number) => error < 1e-6)).toBe(true);
});

test('supports planar movement, uniform scaling, and Shift precision', async ({ page }) => {
  await open(page);
  const initialCenter = await state(page),
    center = await point(page, 'transform:move:free');
  await drag(page, center, { x: center.x + 12, y: center.y - 8 });
  const centered = await state(page);
  expect(centered.parts[0].position[0]).toBeGreaterThan(initialCenter.parts[0].position[0]);
  expect(centered.parts[0].position[1]).toBeGreaterThan(initialCenter.parts[0].position[1]);
  expect(centered.parts[0].position[2]).toBe(initialCenter.parts[0].position[2]);
  expect(centered.parts[0].scale).toEqual(initialCenter.parts[0].scale);
  await page.keyboard.press('Control+z');
  const initial = await state(page),
    plane = await point(page, 'transform:plane:2');
  await drag(page, plane, { x: plane.x + 25, y: plane.y - 20 });
  const planar = await state(page);
  expect(planar.parts[0].position[0]).toBeGreaterThan(initial.parts[0].position[0]);
  expect(planar.parts[0].position[1]).toBeGreaterThan(initial.parts[0].position[1]);
  expect(planar.parts[0].position[2]).toBe(initial.parts[0].position[2]);
  await page.keyboard.press('Control+z');
  const uniform = await point(page, 'transform:scale:uniform');
  await drag(page, uniform, { x: uniform.x - 30, y: uniform.y + 30 });
  const scaled = (await state(page)).parts[0].scale;
  expect(scaled[0]).toBeGreaterThan(1.1);
  expect(scaled[0]).toBeCloseTo(scaled[1], 8);
  expect(scaled[1]).toBeCloseTo(scaled[2], 8);
  await page.keyboard.press('Control+z');
  const move = await point(page, 'transform:move:X', [0, 0, 0], 'ConeGeometry');
  await page.mouse.move(move.x, move.y);
  await page.mouse.down();
  await page.mouse.move(move.x + 20, move.y);
  const normal = (await state(page)).parts[0].position[0] - initial.parts[0].position[0];
  await page.keyboard.down('Shift');
  await page.mouse.move(move.x + 40, move.y);
  const fine = (await state(page)).parts[0].position[0] - initial.parts[0].position[0];
  expect((fine - normal) / normal).toBeCloseTo(0.1, 5);
  await page.keyboard.up('Shift');
  await page.mouse.up();
});

test('snaps rotation and ends an active scale drag when scaling is disabled', async ({ page }) => {
  await open(page);
  const step = page.getByRole('spinbutton', { name: 'Transform rotation snap', exact: true });
  await step.fill('7');
  await step.press('Enter');
  await page.getByRole('button', { name: 'Snap', exact: true }).click();
  const from = await point(page, 'transform:rotate:Z', [
    0.78 * Math.cos(Math.PI / 4),
    0.78 * Math.sin(Math.PI / 4),
    0,
  ]);
  const to = await point(page, 'transform:rotate:Z', [
    0.78 * Math.cos(Math.PI / 2.5),
    0.78 * Math.sin(Math.PI / 2.5),
    0,
  ]);
  await drag(page, from, to);
  const q = (await state(page)).parts[0].quaternion;
  const degrees = (Math.acos(Math.abs(q[3])) * 360) / Math.PI;
  expect(degrees).toBeGreaterThan(7);
  expect(degrees / 7).toBeCloseTo(Math.round(degrees / 7), 5);
  await page.keyboard.press('Control+z');
  await page.getByRole('button', { name: 'Snap', exact: true }).click();
  const scale = await point(page, 'transform:scale:X');
  await page.mouse.move(scale.x, scale.y);
  await page.mouse.down();
  await page.mouse.move(scale.x + 20, scale.y, { steps: 6 });
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((url) => /\/src\/core\/preferences\.ts(?:\?.*)?$/.test(url))!;
    (await import(url)).usePreferences.getState().setTransformScaling(false);
  });
  await expect(
    page.getByRole('checkbox', { name: 'Enable scaling', exact: true }),
  ).not.toBeChecked();
  const stopped = (await state(page)).parts[0].scale;
  await page.mouse.move(scale.x + 50, scale.y, { steps: 8 });
  await page.mouse.up();
  expect((await state(page)).parts[0].scale).toEqual(stopped);
  expect((await state(page)).enabled).toBe(true);
});

test('does not apply a rejected minimum scale when finishing clipping', async ({ page }) => {
  await open(page);
  for (const axis of ['X', 'Y', 'Z']) {
    const field = page.getByRole('spinbutton', { name: `Scale ${axis}`, exact: true });
    await field.fill('0.001');
    await field.press('Enter');
  }
  await page.getByRole('button', { name: 'Avoid clipping', exact: true }).click();
  const before = await state(page),
    handle = await point(page, 'transform:scale:X');
  await drag(page, handle, { x: handle.x - 40, y: handle.y });
  const after = await state(page);
  expect(after.parts).toEqual(before.parts);
  expect(after.past).toBe(before.past);
  expect(after.enabled).toBe(true);
});
