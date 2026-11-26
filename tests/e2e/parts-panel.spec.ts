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
