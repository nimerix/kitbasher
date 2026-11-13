import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';

const fixture = {
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Transform controls',
  joints: [],
  parts: [
    {
      id: 'cube',
      name: 'Test cube',
      geometry: serializeGeometry(new BoxGeometry(30, 30, 30)),
      position: [0, 15, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: '#d4a272',
      locked: false,
      visible: true,
      source: 'test',
    },
  ],
};

async function openFixture(page: Page) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'transforms.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Test cube"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
}

async function state(page: Page) {
  return page.evaluate(async () => {
    const path = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!;
    const { useEditor } = await import(path);
    const s = useEditor.getState();
    return {
      past: s.past.length,
      parts: s.scene.parts.map((p: any) => ({ position: p.position, quaternion: p.quaternion })),
      view: s.view,
    };
  });
}

test('steps precisely by button or keyboard, keeps drafts cancellable, and undoes each step', async ({
  page,
}) => {
  await openFixture(page);
  await page.getByRole('button', { name: 'Move (G)', exact: true }).click();
  const step = page.getByRole('spinbutton', { name: 'Move step', exact: true });
  await step.fill('0.25');
  await step.press('Enter');
  expect((await state(page)).past).toBe(0);
  await page.getByRole('button', { name: 'Move X positive', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue(
    '0.25',
  );
  const button = page.getByRole('button', { name: 'Move X positive', exact: true });
  await button.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(button).toBeFocused();
  expect(await button.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid');
  await page.keyboard.press('Space');
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue(
    '0.5',
  );
  expect((await state(page)).past).toBe(2);
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue(
    '0.25',
  );
  await step.fill('10');
  await step.press('Escape');
  await expect(step).toHaveValue('0.25');
  await step.fill('0');
  await step.press('Enter');
  await expect(step).toHaveValue('0.25');
  expect((await state(page)).past).toBe(1);
});

test('local steps follow the part while absolute position stays explicitly in world coordinates', async ({
  page,
}) => {
  await openFixture(page);
  const rotation = page.getByRole('spinbutton', { name: 'Rotation Z', exact: true });
  await rotation.fill('90');
  await rotation.press('Enter');
  await page.getByRole('button', { name: 'Move (G)', exact: true }).click();
  await page
    .getByRole('group', { name: 'Handle and step axes' })
    .getByRole('button', { name: 'Local', exact: true })
    .click();
  await page.getByRole('button', { name: 'Move X positive', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('0');
  await expect(page.getByRole('spinbutton', { name: 'Position Y', exact: true })).toHaveValue('16');
  await expect(page.getByText('mm · world', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Preferred transform axes' })).toHaveValue(
    'local',
  );
});

test('shows the actual rotation snap and uses a custom angle for a real handle drag', async ({
  page,
}) => {
  await openFixture(page);
  await page.getByRole('button', { name: 'Rotate (R)', exact: true }).click();
  const step = page.getByRole('spinbutton', { name: 'Rotation step', exact: true });
  await step.fill('7');
  await step.press('Enter');
  await page.getByRole('button', { name: 'Snap dragging', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Snap angle' })).toHaveValue('7');
  const box = (await page.locator('canvas').boundingBox())!;
  const at = (angle: number) => ({
    x: box.x + box.width / 2 + 100 * Math.cos((angle * Math.PI) / 180),
    y: box.y + box.height / 2 + 100 * Math.sin((angle * Math.PI) / 180),
  });
  const from = at(-135),
    to = at(-103);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  const after = await state(page);
  const degrees = (Math.acos(Math.min(1, Math.abs(after.parts[0].quaternion[3]))) * 360) / Math.PI;
  expect(degrees).toBeGreaterThan(7);
  expect(degrees / 7).toBeCloseTo(Math.round(degrees / 7), 4);
  expect(Math.abs(degrees / 15 - Math.round(degrees / 15))).toBeGreaterThan(0.01);
  expect(after.past).toBe(1);
  await page.keyboard.press('Control+z');
  expect((await state(page)).parts[0].quaternion).toEqual([0, 0, 0, 1]);
  await page.getByRole('button', { name: 'Move (G)', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Snap distance' })).toHaveValue('1');
  await page.getByRole('button', { name: 'Rotate (R)', exact: true }).click();
  await expect(step).toHaveValue('7');
});

test('explains locked joints and selections, and offers precise group transforms', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.locator('.part-select[title="Optics & head"]').click();
  await page.getByRole('button', { name: 'Rotate (R)', exact: true }).click();
  await expect(page.getByText('Joint axes', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rotate X positive', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Rotate Y positive', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Rotate Y positive', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Rotation Y', exact: true })).toHaveValue('15');
  await page.locator('.part-select[title="Display base"]').click();
  await expect(
    page.getByText('Select a visible, unlocked part to adjust it.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rotate Y positive', exact: true })).toBeDisabled();
  await page.locator('.part-select[title="Left arm"]').click();
  await page.locator('.part-select[title="Right arm"]').click({ modifiers: ['Shift'] });
  await expect(page.getByText('Groups use world axes and move together.')).toBeVisible();
  await expect(page.getByText('Pivot: selection center')).toBeVisible();
  const before = await state(page);
  await page.getByRole('button', { name: 'Rotate Z positive', exact: true }).click();
  expect((await state(page)).past).toBe(before.past + 1);
  await page.keyboard.press('Control+z');
  expect((await state(page)).parts).toEqual(before.parts);
  await page.getByRole('slider', { name: 'Exploded view amount' }).fill('30');
  await expect(
    page.getByText('Reset the exploded view to adjust parts.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rotate Z positive', exact: true })).toBeDisabled();
});

test('keeps axis adjustments and increments usable at 320px width', async ({ page }) => {
  await openFixture(page);
  await page.setViewportSize({ width: 320, height: 780 });
  await page.getByRole('button', { name: 'Move (G)', exact: true }).click();
  await page.getByRole('button', { name: 'Show inspector', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Properties inspector' });
  await expect(panel).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Move step', exact: true }).fill('0.1');
  await page.getByRole('spinbutton', { name: 'Move step', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Move Z positive', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Position Z', exact: true })).toHaveValue(
    '0.1',
  );
  const sizes = await page.locator('.transform-adjustments').evaluate((element) => ({
    width: element.clientWidth,
    scroll: element.scrollWidth,
    controls: [...element.querySelectorAll('button, input')].map((e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, height: r.height };
    }),
  }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.width);
  for (const rect of sizes.controls) {
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(320);
    expect(rect.width).toBeGreaterThanOrEqual(24);
    expect(rect.height).toBeGreaterThanOrEqual(24);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  // Scale retains its axis preference even when the toolbar selector is hidden.
  await page.getByRole('button', { name: 'Scale (S)', exact: true }).click();
  await page
    .getByRole('group', { name: 'Handle and step axes' })
    .getByRole('button', { name: 'Local', exact: true })
    .click();
  expect((await state(page)).view.space).toBe('local');
});
