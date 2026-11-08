import { expect, test, type Page } from '@playwright/test';
import { PlaneGeometry, Quaternion, Vector3 } from 'three';
import { serializeGeometry } from '../../src/core/geometry';
import { readSavedScene } from './saved-scene';

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
      brushRadius: state.brushRadius,
      brushErase: state.brushErase,
      brushPlane: state.brushPlane,
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
async function openFixture(page: Page, scene = fixture) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'paint.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scene)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Moving plate"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await expect(page.locator('.document-title')).toContainText(fixture.name);
  await expect(page).toHaveTitle('Kitbasher — Assembly workbench');
}

for (const method of ['contact', 'flush']) {
  test(`adjusts the ${method} brush by right-click without changing paint picks, selection, or right-drag navigation`, async ({
    page,
  }) => {
    await openFixture(page);
    await page.keyboard.press('b');
    await page.getByRole('combobox', { name: 'Surface relationship' }).selectOption(method);
    await page.getByRole('combobox', { name: 'Target part', exact: true }).selectOption('target');
    await paint(page, 'moving', [-8, 0, 0]);
    const before = await editorState(page);
    const target = await screenPoint(page, 'target', [0, 0, 0]);
    await page.mouse.click(target.x, target.y, { button: 'right' });
    const popup = page.getByRole('dialog', { name: 'Paint brush settings' });
    await expect(popup).toBeVisible();
    const radius = popup.getByRole('spinbutton', { name: 'Brush radius', exact: true });
    await expect(radius).toBeFocused();
    await radius.fill('6.5');
    await radius.press('Enter');
    await expect(popup).toBeVisible();
    await expect(
      page
        .locator('.assembly-inspector')
        .getByRole('spinbutton', { name: 'Brush radius', exact: true }),
    ).toHaveValue('6.5');
    const slider = popup.getByRole('slider', { name: 'Brush radius slider' });
    await slider.focus();
    await slider.press('ArrowLeft');
    await expect(radius).toHaveValue('6.4');
    await popup.getByRole('button', { name: 'Erase', exact: true }).click();
    expect((await editorState(page)).brushErase).toBe(true);
    await popup.getByRole('button', { name: 'Paint', exact: true }).click();
    await popup.getByRole('switch', { name: 'Restrict brush to seed plane' }).click();
    const angle = popup.getByRole('spinbutton', { name: 'Brush plane angle tolerance' });
    await angle.fill('15');
    await angle.press('Enter');
    const distance = popup.getByRole('spinbutton', { name: 'Brush plane distance tolerance' });
    await distance.fill('0.2');
    await distance.press('Enter');
    const settings = await editorState(page);
    expect(settings.brushPlane).toEqual({ enabled: true, angle: 15, distance: 0.2 });
    expect(settings.operation).toEqual(before.operation);
    expect(settings.selected).toEqual(before.selected);
    expect(settings.camera).toEqual(before.camera);
    expect(settings.parts).toEqual(before.parts);
    await radius.fill('7.5');
    await popup.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(popup).toHaveCount(0);
    expect((await editorState(page)).brushRadius).toBe(7.5);
    await paint(page, 'moving', [-8, 0, 0]);
    expect(
      (await editorState(page)).operation.surfacePairs[0].source!.faces.length,
    ).toBeGreaterThan(before.operation.surfacePairs[0].source!.faces.length);
    const bounds = (await page.locator('canvas').boundingBox())!;
    const blank = { x: bounds.x + bounds.width * 0.45, y: bounds.y + bounds.height * 0.2 };
    await page.mouse.click(blank.x, blank.y, { button: 'right' });
    await expect(popup).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await page.locator('.viewport').focus();
    await page.keyboard.press('Shift+F10');
    await expect(popup).toBeVisible();
    await popup.getByRole('spinbutton', { name: 'Brush radius', exact: true }).fill('8.5');
    await page.mouse.click(blank.x - 20, blank.y - 20);
    await expect(popup).toHaveCount(0);
    expect((await editorState(page)).brushRadius).toBe(8.5);
    const beforePan = await editorState(page);
    await page.mouse.move(blank.x, blank.y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(blank.x - 85, blank.y - 20, { steps: 10 });
    await page.mouse.up({ button: 'right' });
    await expect(popup).toHaveCount(0);
    const afterPan = await editorState(page);
    expect(afterPan.camera).not.toEqual(beforePan.camera);
    expect(afterPan.operation).toEqual(beforePan.operation);
    expect(afterPan.selected).toEqual(beforePan.selected);
  });
}

test('paints across gaps in either direction, previews all seams, and applies an undoable flush correction', async ({
  page,
}) => {
  const scene = structuredClone(fixture);
  scene.parts[0].position = [-17, 54, 0.8];
  scene.parts[0].quaternion = new Quaternion()
    .setFromAxisAngle(new Vector3(0, 1, 0), 0.08)
    .toArray();
  scene.parts[1].position = [17, 54, 0];
  await openFixture(page, scene);
  await page.keyboard.press('b');
  await page.getByRole('combobox', { name: 'Surface relationship' }).selectOption('flush');
  await expect(page.getByRole('button', { name: 'Apply flush fit', exact: true })).toBeDisabled();
  await expect(
    page.getByRole('switch', { name: 'Opposing face normals', exact: true }),
  ).toHaveCount(0);
  const before = await editorState(page);
  for (const [index, height] of [-8, 8].entries()) {
    if (index) await page.getByRole('button', { name: 'Add seam', exact: true }).click();
    const moving = await screenPoint(page, 'moving', [12, height, 0]);
    const target = await screenPoint(page, 'target', [-12, height, 0]);
    const [start, end] = index ? [target, moving] : [moving, target];
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 24 });
    await page.mouse.up();
    const pair = (await editorState(page)).operation.surfacePairs[index];
    expect(pair.source!.faces.length).toBeGreaterThan(0);
    expect(pair.target!.faces.length).toBeGreaterThan(0);
  }
  await expect(page.getByLabel('Flush alignment residual')).toContainText('mm height RMS');
  await expect(page.getByText(/Seam 2:.*mm height/)).toBeVisible();
  expect((await editorState(page)).parts).toEqual(before.parts);
  expect((await editorState(page)).camera).toEqual(before.camera);
  const ghost = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => url.includes('/@react-three_fiber.js'))!;
    const fiber = await import(url);
    return !!fiber._roots
      .get(document.querySelector('canvas'))
      .store.getState()
      .scene.getObjectByName('flush-preview:moving');
  });
  expect(ghost).toBe(true);
  await page.screenshot({ path: '/tmp/kitbasher-flush-preview.png' });
  await page.getByRole('button', { name: 'Undo last paint stroke', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply flush fit', exact: true })).toBeDisabled();
  expect((await editorState(page)).operation.surfacePairs[1]).toMatchObject({
    source: null,
    target: null,
  });
  const moving = await screenPoint(page, 'moving', [12, 8, 0]);
  const target = await screenPoint(page, 'target', [-12, 8, 0]);
  await page.mouse.move(moving.x, moving.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 24 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Apply flush fit', exact: true }).click();
  await expect(page.getByText(/Flush fit applied · 2 seams/)).toBeVisible();
  const applied = await editorState(page);
  expect(applied.parts[1]).toEqual(before.parts[1]);
  expect(Math.abs(applied.parts[0].position[0] + 17)).toBeLessThan(0.2);
  expect(Math.abs(applied.parts[0].position[2])).toBeLessThan(0.01);
  expect(new Quaternion(...applied.parts[0].quaternion).angleTo(new Quaternion())).toBeLessThan(
    0.001,
  );
  await page.keyboard.press('Control+z');
  expect((await editorState(page)).parts).toEqual(before.parts);
  await page.keyboard.press('Control+Shift+z');
  expect((await editorState(page)).parts).toEqual(applied.parts);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const saved = await readSavedScene((await (await download).path())!);
  expect(saved.scene.parts[0].position).toEqual(applied.parts[0].position);
});

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
  const { scene: file, bytes } = await readSavedScene((await (await downloaded).path())!);
  expect(file.parts[0].pivot).toEqual(localPivot);
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'pivot.kitbash',
    mimeType: 'application/octet-stream',
    buffer: bytes,
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
  await page.getByRole('button', { name: 'Show inspector', exact: true }).click();
  await page.getByRole('combobox', { name: 'Surface relationship' }).selectOption('flush');
  await expect(page.getByRole('button', { name: 'Apply flush fit', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply flush fit', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add seam', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: '/tmp/kitbasher-flush-mobile.png' });
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  const canvas = (await page.locator('canvas').boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width - 12, canvas.y + canvas.height / 2, {
    button: 'right',
  });
  const popup = page.getByRole('dialog', { name: 'Paint brush settings' });
  await expect(popup).toBeVisible();
  await popup.getByRole('switch', { name: 'Restrict brush to seed plane' }).click();
  await expect(
    popup.getByRole('spinbutton', { name: 'Brush plane angle tolerance' }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const bounds = (await popup.boundingBox())!;
      return (
        bounds.x >= 8 &&
        bounds.y >= 8 &&
        bounds.x + bounds.width <= 382 &&
        bounds.y + bounds.height <= 836
      );
    })
    .toBe(true);
  await popup.getByRole('button', { name: 'Done', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(popup.getByRole('button', { name: 'Paint', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(popup.getByRole('button', { name: 'Done', exact: true })).toBeFocused();
  await page.screenshot({ path: '/tmp/kitbasher-brush-context-mobile.png' });
  const radius = (await editorState(page)).brushRadius;
  await popup.getByRole('spinbutton', { name: 'Brush radius', exact: true }).fill('9');
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  expect((await editorState(page)).brushRadius).toBe(radius);
});
