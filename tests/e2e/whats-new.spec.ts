import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { latestRelease, releaseId, releases } from '../../src/docs/changelog';

// The development server builds from this checkout, so it reports the same short hash.
const commit = execSync('git rev-parse --short=7 HEAD', { encoding: 'utf8' }).trim();

const trigger = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /^What’s new/ });

test('starts new visitors current and announces releases they have not seen', async ({ page }) => {
  await page.goto('/');
  await expect(trigger(page)).toHaveAccessibleName('What’s new');
  await expect(page.locator('.whats-new-dot')).toHaveCount(0);

  await page.evaluate(
    (seen) => localStorage.setItem('kitbasher.seen-release', seen),
    releaseId(releases.at(-1)!),
  );
  await page.reload();
  await expect(trigger(page)).toHaveAccessibleName(`What’s new: ${latestRelease.title}`);
  await expect(page.locator('.whats-new-dot')).toBeVisible();

  await trigger(page).click();
  const panel = page.getByRole('region', { name: 'What’s new' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'What’s new' })).toBeFocused();
  await expect(panel).toContainText(latestRelease.title);
  const shipped = releases.slice(0, 3).find((release) => release.commit)!;
  await expect(panel).toContainText(`${shipped.commit} · `);
  await expect(panel).toContainText(`version ${commit}`);
  await expect(panel.getByRole('link', { name: 'All release notes' })).toHaveAttribute(
    'href',
    `./docs/?guide=whats-new#${releaseId(latestRelease)}`,
  );
  await expect(page.locator('.whats-new-dot')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(trigger(page)).toBeFocused();

  await page.reload();
  await expect(page.locator('.whats-new-dot')).toHaveCount(0);
});

test('fits the release popover on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/');
  await trigger(page).click();
  const box = await page.getByRole('region', { name: 'What’s new' }).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
});
