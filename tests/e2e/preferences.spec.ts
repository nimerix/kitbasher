import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';

const box = serializeGeometry(new BoxGeometry(16, 16, 16));
const fixture = {
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Preferences bench',
  joints: [],
  parts: [
    {
      id: 'a',
      name: 'Pivot piece',
      geometry: box,
      position: [0, 30, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: '#c7a48c',
      visible: true,
      locked: false,
      source: 'test',
      pivot: [0, 0, 8],
    },
  ],
};

const errors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on('pageerror', (error) => list.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') list.push(message.text());
  });
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('kitbasher.preferences'));
  await page.reload();
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'fixture.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

const frames = (page: Page, count = 2) =>
  page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const step = (left: number) =>
          left ? requestAnimationFrame(() => step(left - 1)) : resolve();
        step(count);
      }),
    count,
  );

async function cameraDistance(page: Page) {
  return page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => name.includes('/@react-three_fiber.js'))!;
    const root = (await import(url))._roots.get(document.querySelector('canvas')).store.getState();
    return root.camera.position.distanceTo(root.controls.target) as number;
  });
}

async function setPreferences(page: Page, patch: object) {
  await page.evaluate(async (patch) => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\/src\/core\/preferences\.ts(?:\?.*)?$/.test(name))!;
    const { usePreferences } = await import(url);
    const { zoom, markers } = patch as { zoom?: object; markers?: object };
    if (zoom) usePreferences.getState().setZoom(zoom);
    if (markers) usePreferences.getState().setMarkers(markers);
  }, patch);
}

async function wheel(page: Page, deltaY: number) {
  const canvas = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.wheel(0, deltaY);
}

test('the preferences panel opens from the header and keeps the viewport usable', async ({
  page,
}) => {
  await page.getByRole('button', { name: /^Preferences \(/ }).click();
  const panel = page.getByRole('dialog', { name: 'Preferences' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('tab', { name: 'Navigation' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // The panel is not modal: scrolling the viewport still zooms while it is open.
  const before = await cameraDistance(page);
  await wheel(page, -100);
  await expect.poll(() => cameraDistance(page)).toBeLessThan(before);
  await panel.getByRole('tab', { name: 'Navigation' }).press('ArrowRight');
  await expect(panel.getByRole('tab', { name: 'Markers' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('wheel zoom glides, then lands, and follows sensitivity and smoothing', async ({ page }) => {
  await frames(page, 4);
  const start = await cameraDistance(page);
  await wheel(page, -100);
  await frames(page, 2);
  const midway = await cameraDistance(page);
  await page.waitForTimeout(600);
  const landed = await cameraDistance(page);
  expect(midway).toBeLessThan(start);
  expect(landed).toBeLessThan(midway);
  const notch = Math.log(start / landed);
  expect(notch).toBeGreaterThan(0.1);

  await setPreferences(page, { zoom: { smoothing: 0, sensitivity: 2 } });
  await wheel(page, 100);
  await frames(page, 1);
  const doubled = Math.log((await cameraDistance(page)) / landed);
  expect(doubled).toBeCloseTo(notch * 2, 2);
});

test('rebinding a tool key updates the shortcut, its labels, and survives a reload', async ({
  page,
}) => {
  await page.getByRole('button', { name: /^Preferences \(/ }).click();
  const panel = page.getByRole('dialog', { name: 'Preferences' });
  await panel.getByRole('tab', { name: 'Keyboard' }).click();
  await panel.getByRole('button', { name: 'Change G for Move', exact: true }).click();
  await page.keyboard.press('m');
  await expect(panel.getByRole('button', { name: 'Change M for Move', exact: true })).toBeVisible();
  // Taking a key from another action says so.
  await panel.getByRole('button', { name: 'Add shortcut for Move', exact: true }).click();
  await page.keyboard.press('r');
  await expect(panel.getByRole('status')).toContainText('moved here from Rotate');
  // The recorder restores row focus on the next frame before Escape can close the panel.
  await expect(panel.getByRole('button', { name: 'Change M for Move', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  await page.locator('.viewport').focus();
  await page.keyboard.press('v');
  await page.keyboard.press('m');
  await expect(page.getByRole('button', { name: 'Move (M)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('v');
  await page.keyboard.press('g');
  await expect(page.getByRole('button', { name: 'Select (V)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Rotate', exact: true })).toBeVisible();

  await page.reload();
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move (M)', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Preferences \(/ }).click();
  await page.getByRole('tab', { name: 'Keyboard' }).click();
  await page.getByRole('button', { name: 'Reset all', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Move (G)', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rotate (R)', exact: true })).toBeVisible();
});

test('headset bindings can be changed, restored after reload, and reset from preferences', async ({
  page,
}) => {
  const open = async () => {
    await page.getByRole('button', { name: /^Preferences \(/ }).click();
    await page.getByRole('tab', { name: 'Headset' }).click();
    return page.getByRole('dialog', { name: 'Preferences' });
  };
  const panel = await open();
  await panel.getByRole('combobox', { name: 'A · right action', exact: true }).selectOption('redo');
  await panel.getByRole('combobox', { name: 'Right thumbstick action' }).selectOption('rotate');
  await panel.getByRole('radio', { name: 'Left', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('kitbasher.xr-input')!)))
    .toMatchObject({ buttons: { a: 'redo' }, axes: { right: 'rotate' }, dominantHand: 'left' });
  await page.reload();
  await expect(page.locator('canvas')).toBeVisible();
  const restored = await open();
  await expect(
    restored.getByRole('combobox', { name: 'A · right action', exact: true }),
  ).toHaveValue('redo');
  await expect(restored.getByRole('combobox', { name: 'Right thumbstick action' })).toHaveValue(
    'rotate',
  );
  await expect(restored.getByRole('radio', { name: 'Left', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await restored.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(
    restored.getByRole('combobox', { name: 'A · right action', exact: true }),
  ).toHaveValue('advance');
  await expect(restored.getByRole('combobox', { name: 'Right thumbstick action' })).toHaveValue(
    'context',
  );
  await expect(restored.getByRole('radio', { name: 'Right', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('markers keep a fixed screen size and callouts stay vertically aligned above the model', async ({
  page,
}) => {
  await page.locator('.part-select[title="Pivot piece"]').click();
  const dot = page.locator('.annotation-dot.is-pivot');
  const label = page.locator('.pivot-label');
  await expect(label).toBeVisible();
  const width = async () => (await dot.boundingBox())!.width;
  expect(Math.round(await width())).toBe(Math.round(8 * 0.65));
  await setPreferences(page, { markers: { size: 16 } });
  await expect.poll(async () => Math.round(await width())).toBe(Math.round(16 * 0.65));

  // The dot does not grow when the camera moves closer.
  await setPreferences(page, { zoom: { smoothing: 0 } });
  await wheel(page, -300);
  await frames(page, 2);
  expect(Math.round(await width())).toBe(Math.round(16 * 0.65));

  await setPreferences(page, { markers: { style: 'callout', placement: 'model', clearance: 30 } });
  const leader = page.locator('.annotation-leader');
  await expect(leader).toBeVisible();
  await frames(page, 2);
  const [d, l, line] = await Promise.all([dot, label, leader].map((n) => n.boundingBox()));
  const center = (b: typeof d) => b!.x + b!.width / 2;
  expect(Math.abs(center(l) - center(d))).toBeLessThan(1.5);
  expect(Math.abs(center(line) - center(d))).toBeLessThan(1.5);
  // Label, then leader, then point, from top to bottom.
  expect(l!.y + l!.height).toBeLessThanOrEqual(line!.y + 1);
  expect(line!.y + line!.height).toBeLessThanOrEqual(d!.y + d!.height / 2);

  // Orbiting keeps the callout straight above the point.
  const canvas = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(canvas.x + canvas.width / 2 + 160, canvas.y + canvas.height / 2 + 40, {
    steps: 8,
  });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(500);
  const [d2, l2] = await Promise.all([dot, label].map((n) => n.boundingBox()));
  expect(Math.abs(center(l2) - center(d2))).toBeLessThan(1.5);
  expect(l2!.y).toBeLessThan(d2!.y);
});
