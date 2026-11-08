import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PlaneGeometry, Vector3 } from 'three';
import { serializeGeometry } from '../../src/core/geometry';

// Browser plugin not available; validate the local editor with regular Playwright.
// Flow: paint 3+ matching patches -> fit; click a surface pivot -> transform -> save/reopen.
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
});
test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

const geometry = serializeGeometry(new PlaneGeometry(32, 32, 16, 16));
const fixture = {
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Painted contact workbench',
  joints: [],
  parts: [-28, 28].map((x, i) => ({
    id: i ? 'target' : 'moving',
    name: i ? 'Target plate' : 'Moving plate',
    geometry,
    position: [x, 54, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: i ? '#8cbeb6' : '#d4a272',
    locked: false,
    visible: true,
    source: 'test',
  })),
};

async function editorState(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const fiber = await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!);
    const root = fiber._roots.get(document.querySelector('canvas')).store.getState();
    const state = useEditor.getState();
    return {
      operation: state.operation,
      selected: state.selected,
      painting: state.painting,
      pivotPicking: state.pivotPicking,
      tool: state.tool,
      parts: state.scene.parts.map((part: any) => ({
        id: part.id,
        position: part.position,
        quaternion: part.quaternion,
        scale: part.scale,
        pivot: part.pivot,
      })),
      camera: root.camera.position.toArray(),
      target: root.controls.target.toArray(),
    };
  });
}
async function screenPoint(page: Page, id: string, local: number[]) {
  const box = (await page.locator('canvas').boundingBox())!;
  const ndc = await page.evaluate(
    async ({ id, local }) => {
      const url = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((url) => url.includes('/@react-three_fiber.js'))!;
      const fiber = await import(url),
        root = fiber._roots.get(document.querySelector('canvas')).store.getState();
      const mesh = root.scene.getObjectByName(`part:${id}`);
      mesh.updateWorldMatrix(true, false);
      const point = root.camera.position.clone().fromArray(local);
      mesh.localToWorld(point);
      point.project(root.camera);
      return point.toArray();
    },
    { id, local },
  );
  return { x: box.x + ((ndc[0] + 1) * box.width) / 2, y: box.y + ((1 - ndc[1]) * box.height) / 2 };
}
async function paint(page: Page, id: string, local: number[]) {
  const point = await screenPoint(page, id, local);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 4, point.y + 1, { steps: 4 });
  await page.mouse.up();
}
async function paintPair(page: Page, index: number, local: number[]) {
  if (index > 1) await page.getByRole('button', { name: 'Add surface pair', exact: true }).click();
  await paint(page, 'moving', local);
  await page.getByRole('button', { name: 'Next: paint target', exact: true }).click();
  await paint(page, 'target', local);
  await page.getByRole('button', { name: 'Finish pair', exact: true }).click();
}
async function openFixture(page: Page) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'paint.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Moving plate"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await expect(page.locator('.document-title')).toContainText(fixture.name);
  await expect(page).toHaveTitle('Kitbasher — Assembly workbench');
}

test('paints real paired patches, erases and undoes strokes, preserves them through navigation, and fits 4 pairs', async ({
  page,
}) => {
  await openFixture(page);
  await page.keyboard.press('b');
  await expect(
    page.getByRole('button', { name: 'Fit contact surfaces', exact: true }),
  ).toBeDisabled();
  await page.getByRole('combobox', { name: 'Target part', exact: true }).selectOption('target');
  await page.getByRole('switch', { name: 'Opposing face normals', exact: true }).click();
  const before = await editorState(page);
  await paintPair(page, 1, [-8, -8, 0]);
  const first = await editorState(page);
  expect(first.operation.surfacePairs[0].source!.faces.length).toBeGreaterThan(3);
  expect(first.operation.surfacePairs[0].target!.faces.length).toBeGreaterThan(3);
  expect(first.camera).toEqual(before.camera);
  expect(first.target).toEqual(before.target);
  expect(first.parts).toEqual(before.parts);
  expect(first.painting).toBe(false);
  await page.getByRole('button', { name: 'Paint moving surface pair 1', exact: true }).click();
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await paint(page, 'moving', [-8, -8, 0]);
  expect((await editorState(page)).operation.surfacePairs[0].source!.faces.length).toBeLessThan(
    first.operation.surfacePairs[0].source!.faces.length,
  );
  await page.getByRole('button', { name: 'Undo last paint stroke', exact: true }).click();
  expect((await editorState(page)).operation.surfacePairs).toEqual(first.operation.surfacePairs);
  await page.getByRole('button', { name: 'Paint', exact: true }).click();
  // Camera mode changes keep the surface workflow, just like point-pair alignment.
  await page.keyboard.press('o');
  await page.keyboard.press('Escape');
  expect((await editorState(page)).operation.surfacePairs).toEqual(first.operation.surfacePairs);
  await page.keyboard.press('Home');
  await paintPair(page, 2, [8, -8, 0]);
  await paintPair(page, 3, [-8, 8, 0]);
  await expect(
    page.getByRole('button', { name: 'Fit contact surfaces', exact: true }),
  ).toBeEnabled();
  await paintPair(page, 4, [8, 8, 0]);
  await expect(page.getByLabel('Surface contact RMS error')).toContainText('mm contact RMS');
  await page.screenshot({ path: '/tmp/kitbasher-surface-pairs-desktop.png' });
  const targetBefore = (await editorState(page)).parts.find((part: any) => part.id === 'target');
  await page.getByRole('button', { name: 'Fit contact surfaces', exact: true }).click();
  await expect(page.getByText(/Fitted 4 surface pairs/)).toBeVisible();
  const fitted = await editorState(page);
  expect(fitted.parts.find((part: any) => part.id === 'target')).toEqual(targetBefore);
  expect(new Vector3(...fitted.parts[0].position).distanceTo(new Vector3(28, 54, 0))).toBeLessThan(
    1.5,
  );
});

test('clicks a persistent custom pivot used by transforms and actual orbit controls, then resets and reopens it', async ({
  page,
}) => {
  await openFixture(page);
  await page.keyboard.press('p');
  await expect(page.getByText('Click a spot on a model to set its pivot')).toBeVisible();
  const point = await screenPoint(page, 'moving', [6, 5, 0]);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByText(/Pivot set · orbit, rotate/)).toBeVisible();
  const picked = await editorState(page),
    localPivot = picked.parts[0].pivot!;
  expect(Math.abs(localPivot[0] - 6)).toBeLessThan(0.15);
  expect(Math.abs(localPivot[1] - 5)).toBeLessThan(0.15);
  const worldPivot = new Vector3(...localPivot).add(new Vector3(...picked.parts[0].position));
  expect(new Vector3(...picked.target).distanceTo(worldPivot)).toBeLessThan(1e-5);
  const rz = page.getByRole('spinbutton', { name: 'Rotation Z', exact: true });
  await rz.fill('60');
  await rz.press('Enter');
  const sx = page.getByRole('spinbutton', { name: 'Scale X', exact: true });
  await sx.fill('1.8');
  await sx.press('Enter');
  const transformed = await editorState(page),
    part = transformed.parts[0];
  const { Quaternion } = await import('three');
  expect(
    new Vector3(...part.pivot!)
      .multiply(new Vector3(...part.scale))
      .applyQuaternion(new Quaternion(...part.quaternion))
      .add(new Vector3(...part.position))
      .distanceTo(worldPivot),
  ).toBeLessThan(1e-5);
  await page.keyboard.press('o');
  await page.getByRole('button', { name: 'Orbit right', exact: true }).click();
  expect(new Vector3(...(await editorState(page)).target).distanceTo(worldPivot)).toBeLessThan(
    1e-5,
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Reset custom pivot', exact: true }).click();
  expect((await editorState(page)).parts[0].pivot).toBeUndefined();
  await page.keyboard.press('Control+z');
  expect((await editorState(page)).parts[0].pivot).toEqual(localPivot);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const file = JSON.parse(await readFile((await (await downloaded).path())!, 'utf8'));
  expect(file.parts[0].pivot).toEqual(localPivot);
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'pivot.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Moving plate"]').click();
  expect((await editorState(page)).parts[0].pivot).toEqual(localPivot);
  await page.screenshot({ path: '/tmp/kitbasher-surface-pivot-desktop.png' });
});

test('keeps paint controls and pivot picking reachable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByTitle('Paint contact surfaces (B)').click();
  await expect(page.getByRole('spinbutton', { name: 'Brush radius', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Paint moving surface pair 1', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: '/tmp/kitbasher-surface-paint-mobile.png' });
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Pick surface pivot', exact: false }).click();
  await expect(page.getByText('Click a spot on a model to set its pivot')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: '/tmp/kitbasher-paint-navigation-mobile.png' });
  expect((await editorState(page)).operation.mode).toBe('surface');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(await page.locator('vite-error-overlay').count()).toBe(0);
});
