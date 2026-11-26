import { expect, test, type Page } from '@playwright/test';

const row = (page: Page, name: string) => page.locator('.part-select', { hasText: name }).first();
const selectedNames = (page: Page) =>
  page
    .locator('.part-row.selected .part-select')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('title')));

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
});

test('Shift+click selects a range of parts and Ctrl or ⌘ adds one', async ({ page }) => {
  await row(page, 'Torso shell').click();
  await row(page, 'Optics & head').click({ modifiers: ['Shift'] });
  expect(await selectedNames(page)).toEqual(['Torso shell', 'Power pack', 'Optics & head']);
  // The range is taken again from the same part, so it can shrink.
  await row(page, 'Power pack').click({ modifiers: ['Shift'] });
  expect(await selectedNames(page)).toEqual(['Torso shell', 'Power pack']);
  await row(page, 'Right arm').click({ modifiers: ['ControlOrMeta'] });
  expect(await selectedNames(page)).toEqual(['Torso shell', 'Power pack', 'Right arm']);
  // Ranges run upward too, from the part clicked last.
  await row(page, 'Left arm').click({ modifiers: ['Shift'] });
  expect(await selectedNames(page)).toEqual(['Left arm', 'Right shoulder', 'Right arm']);
});

test('the eye on a selected row shows or hides every selected part', async ({ page }) => {
  const muted = () =>
    page
      .locator('.part-row.muted .part-select')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('title')));
  await row(page, 'Torso shell').click();
  await row(page, 'Optics & head').click({ modifiers: ['Shift'] });
  await page
    .getByRole('button', { name: 'Hide Power pack and 2 more selected', exact: true })
    .click();
  expect(await muted()).toEqual(['Torso shell', 'Power pack', 'Optics & head']);
  // A row outside the selection changes on its own.
  await page.getByRole('button', { name: 'Hide Right arm', exact: true }).click();
  expect(await muted()).toEqual(['Torso shell', 'Power pack', 'Optics & head', 'Right arm']);
  await page
    .getByRole('button', { name: 'Show Torso shell and 2 more selected', exact: true })
    .click();
  expect(await muted()).toEqual(['Right arm']);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await muted()).toEqual(['Torso shell', 'Power pack', 'Optics & head', 'Right arm']);
});

async function screenPoint(page: Page, id: string) {
  const canvas = (await page.locator('canvas').boundingBox())!;
  const ndc = await page.evaluate(async (id) => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => url.includes('/@react-three_fiber.js'))!;
    const root = (await import(url))._roots.get(document.querySelector('canvas')).store.getState();
    const mesh = root.scene.getObjectByName(`part:${id}`);
    mesh.updateWorldMatrix(true, false);
    return mesh
      .localToWorld(root.camera.position.clone().set(0, 0, 0))
      .project(root.camera)
      .toArray();
  }, id);
  return {
    x: canvas.x + ((ndc[0] + 1) * canvas.width) / 2,
    y: canvas.y + ((1 - ndc[1]) * canvas.height) / 2,
  };
}

test('groups parts, selects and hides them together, and ungroups them', async ({ page }) => {
  const group = page.locator('.group-row');
  await row(page, 'Optics & head').click();
  await row(page, 'Right arm').click({ modifiers: ['Shift'] });
  await page.keyboard.press('ControlOrMeta+g');
  await expect(group).toHaveCount(1);
  await expect(group).toContainText('Group 1');
  await expect(group.locator('.tree-count')).toHaveText('5');
  await expect(page.locator('.part-row.in-group')).toHaveCount(5);

  // A click in the viewport takes the whole group; a click in the list takes one part.
  await page.keyboard.press('Escape');
  await expect(page.locator('.part-row.selected')).toHaveCount(0);
  const head = await screenPoint(page, 'head');
  await page.mouse.click(head.x, head.y);
  await expect(page.locator('.part-row.in-group.selected')).toHaveCount(5);
  await expect(group).toHaveClass(/selected/);
  await row(page, 'Left arm').click();
  expect(await selectedNames(page)).toEqual(['Left arm']);
  await group.locator('.part-select').click();
  await expect(page.locator('.part-row.in-group.selected')).toHaveCount(5);

  await page.getByRole('button', { name: 'Collapse Group 1', exact: true }).click();
  await expect(page.locator('.part-row.in-group')).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand Group 1', exact: true }).click();
  await expect(page.locator('.part-row.in-group')).toHaveCount(5);

  await page.getByRole('button', { name: 'Hide Group 1', exact: true }).click();
  await expect(page.locator('.part-row.in-group.muted')).toHaveCount(5);
  await expect(page.locator('.part-row.muted')).toHaveCount(6);
  await page.getByRole('button', { name: 'Show Group 1', exact: true }).click();
  await expect(page.locator('.part-row.muted')).toHaveCount(0);

  await group.locator('.part-select').dblclick();
  await page.getByRole('textbox', { name: 'Group name' }).fill('Upper body');
  await page.keyboard.press('Enter');
  await expect(group).toContainText('Upper body');

  // Groups are saved with the scene.
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Recovered your local assembly')).toBeVisible();
  await expect(page.locator('.group-row')).toContainText('Upper body');

  await page.locator('.group-row .part-select').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Ungroup/ }).click();
  await expect(page.locator('.group-row')).toHaveCount(0);
  await expect(page.locator('.part-row')).toHaveCount(15);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.group-row')).toContainText('Upper body');
});
