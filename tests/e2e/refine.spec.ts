import { expect, test } from '@playwright/test';
import { failOnBrowserErrors } from './helpers/warp-grid';
import { chainStraightness, clickSurface, crest, inStore, openRefine } from './helpers/refine';

failOnBrowserErrors();

test('guides a straight edge, accepts it and applies it', async ({ page }) => {
  await openRefine(page);
  await clickSurface(page, crest(-3));
  await clickSurface(page, crest(3));
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
  await page.getByRole('button', { name: 'Apply' }).click();
  const part = await inStore(page, (s) => ({
    source: s.scene.parts[0].source,
    past: s.past.length,
  }));
  expect(part.source).toBe('Refine · Scanned block');
  expect(await chainStraightness(page)).toBeLessThan(0.02);
});
