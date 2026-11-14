import { expect, test, type Page } from '@playwright/test';
import { articleById, articles } from '../../src/docs/content';

const guideUrl = (id: string) => `/docs/?guide=${encodeURIComponent(id)}`;
const searchDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Search documentation', exact: true });

async function expectNoOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
}

test('opens the illustrated manual from both the workbench header and help', async ({ page }) => {
  await page.goto('/');
  const headerLink = page.getByRole('link', { name: 'Documentation', exact: true }).first();
  await expect(headerLink).toHaveAttribute('href', './docs/');

  const headerPopup = page.waitForEvent('popup');
  await headerLink.click();
  const docs = await headerPopup;
  await expect(docs.getByRole('heading', { level: 1 })).toContainText('Your workbench,');
  await expect(docs.getByRole('link', { name: 'Open workbench' })).toHaveAttribute('href', '../');
  await docs.close();

  await page.getByRole('button', { name: 'Help and keyboard shortcuts', exact: true }).click();
  const help = page.getByRole('dialog');
  const helpPopup = page.waitForEvent('popup');
  await help.getByRole('link', { name: 'Open the illustrated documentation' }).click();
  const fromHelp = await helpPopup;
  await expect(fromHelp.getByRole('heading', { level: 1 })).toContainText('Your workbench,');
  await fromHelp.close();
});

test('renders every guide deep link with working illustrations and related-guide destinations', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  for (const article of articles) {
    await test.step(article.title, async () => {
      await page.goto(guideUrl(article.id));
      await expect(
        page.getByRole('heading', { level: 1, name: article.title, exact: true }),
      ).toBeVisible();
      await expect(page).toHaveTitle(`${article.title} · Kitbasher Docs`);

      const expectedImages = [
        article.image,
        ...article.sections.map((section) => section.image),
      ].filter((image) => image !== undefined);
      expect(expectedImages.length, `${article.id} needs an illustration`).toBeGreaterThan(0);
      const images = page
        .locator('main')
        .getByRole('button', { name: /^Enlarge image:/ })
        .locator('img');
      await expect(images).toHaveCount(expectedImages.length);
      await images.evaluateAll((elements) => {
        for (const element of elements) (element as HTMLImageElement).loading = 'eager';
      });
      await expect
        .poll(() =>
          images.evaluateAll((elements) =>
            elements.every((element) => {
              const image = element as HTMLImageElement;
              return image.complete && image.naturalWidth > 0 && image.alt.trim().length > 0;
            }),
          ),
        )
        .toBe(true);

      const related = page.locator('.related-guides a');
      await expect(related).toHaveCount(article.related.length);
      for (const id of article.related) {
        const destination = articleById.get(id);
        expect(destination, `${article.id} links to missing guide ${id}`).toBeDefined();
        await expect(related.filter({ hasText: destination!.title })).toHaveAttribute(
          'href',
          `?guide=${encodeURIComponent(id)}`,
        );
      }
      const guideLinks = await page
        .locator('main a[href*="?guide="]')
        .evaluateAll((links) =>
          links.map((link) => new URL((link as HTMLAnchorElement).href).searchParams.get('guide')),
        );
      for (const id of guideLinks) {
        expect(articleById.has(id!), `${article.id} has a broken local guide link: ${id}`).toBe(
          true,
        );
      }
    });
  }

  expect(errors).toEqual([]);
});

test('searches the full guide body with keyboard shortcuts and preserves browser Back navigation', async ({
  page,
}) => {
  const initial = articleById.get('alignment')!;
  const target = articleById.get('no-clip')!;
  await page.goto(guideUrl(initial.id));
  await page.keyboard.press('Control+k');
  const dialog = searchDialog(page);
  const input = dialog.getByRole('textbox', { name: 'Search documentation', exact: true });
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();

  // This phrase is in a limitation paragraph, rather than the title or description.
  await input.fill('sample spacing');
  await dialog.locator(`a[href="?guide=${target.id}"]`).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: target.title, exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`guide=${target.id}$`));

  await page.goBack();
  await expect(
    page.getByRole('heading', { level: 1, name: initial.title, exact: true }),
  ).toBeVisible();
  await expect(dialog).not.toBeVisible();

  await page.keyboard.press('/');
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue('');
  await input.fill(target.title);
  await input.press('ArrowDown');
  const result = dialog.locator('.search-result').first();
  await expect(result).toBeFocused();
  await result.press('Enter');
  await expect(
    page.getByRole('heading', { level: 1, name: target.title, exact: true }),
  ).toBeVisible();
  await expect(dialog).not.toBeVisible();
});

test('handles empty search results, clearing, closing, and Escape without leaving a stale query', async ({
  page,
}) => {
  await page.goto('/docs/');
  const openSearch = page.getByRole('button', { name: 'Search documentation', exact: true });
  await openSearch.click();
  const dialog = searchDialog(page);
  const input = dialog.getByRole('textbox', { name: 'Search documentation', exact: true });
  await input.fill('no-such-kitbasher-feature-92481');
  await expect(dialog.getByRole('status')).toHaveText('No matching guides');
  await expect(dialog.locator('.search-result')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(dialog.getByRole('status')).toHaveText('Popular guides');
  await expect(dialog.locator('.search-result').first()).toBeVisible();

  await input.fill('anchors');
  await dialog.getByRole('button', { name: 'Close search', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await openSearch.click();
  await expect(input).toHaveValue('');
  await input.fill('STL');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(openSearch).toBeFocused();
  await page.keyboard.press('Meta+k');
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue('');
});

test('keeps section anchors addressable and recovers from an unknown guide', async ({ page }) => {
  const article = articleById.get('transforms')!;
  const section = article.sections.at(-1)!;
  await page.goto(guideUrl(article.id));
  await page
    .getByRole('complementary', { name: 'On this page', exact: true })
    .getByRole('link', { name: section.title, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`#${section.id}$`));
  const heading = page.locator(`main section[id="${section.id}"] h2`);
  await expect(heading).toBeInViewport();
  await page.reload();
  await expect(heading).toBeInViewport();

  await page.goto(guideUrl('missing-guide-92481'));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('This guide isn’t here.');
  await expect(page).toHaveTitle('Guide not found · Kitbasher Docs');
  await page.getByRole('link', { name: 'Back to the overview' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Your workbench,');
  await expect(page).toHaveURL(/\/docs\/$/);
  await page
    .locator('.docs-sidebar')
    .getByRole('link', { name: article.title, exact: true })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: article.title, exact: true }),
  ).toBeVisible();
});

test('supports navigation, long reference tables, and search at 320 pixels without page overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/docs/');
  await expectNoOverflow(page);
  await page.getByRole('button', { name: 'Open documentation navigation', exact: true }).click();
  const navigation = page.getByRole('dialog', { name: 'Documentation navigation', exact: true });
  await expect(navigation).toBeVisible();
  const article = articleById.get('keyboard-shortcuts')!;
  await navigation.getByRole('link', { name: article.title, exact: true }).click();
  await expect(navigation).not.toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: article.title, exact: true }),
  ).toBeVisible();
  const toc = page.locator('.mobile-toc');
  await toc.getByText('On this page', { exact: true }).click();
  const last = article.sections.at(-1)!;
  await toc.getByRole('link', { name: last.title, exact: true }).click();
  await expect(page.locator(`main section[id="${last.id}"] h2`)).toBeInViewport();
  await expectNoOverflow(page);

  await page.getByRole('button', { name: 'Search documentation', exact: true }).click();
  const dialog = searchDialog(page);
  await dialog
    .getByRole('textbox', { name: 'Search documentation', exact: true })
    .fill('sample spacing');
  const target = articleById.get('no-clip')!;
  await expect(dialog.locator(`a[href="?guide=${target.id}"]`)).toBeVisible();
  await expectNoOverflow(page);
  await dialog.locator(`a[href="?guide=${target.id}"]`).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: target.title, exact: true }),
  ).toBeVisible();
  await expectNoOverflow(page);
  await page.getByRole('button', { name: 'Open documentation navigation', exact: true }).click();
  await navigation.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await expect(navigation).not.toBeVisible();
});

test('copies a complete documented command to the clipboard', async ({ page, context }) => {
  const article = articles.find((candidate) => candidate.sections.some((section) => section.code))!;
  const code = article.sections.find((section) => section.code)!.code!.value;
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(guideUrl(article.id));
  const block = page.locator('.code-block').first();
  await block.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect(block.getByText('Copied', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(code);
});

test('enlarges screenshots and diagrams in place with accessible dismissal on desktop and mobile', async ({
  page,
}) => {
  let popupCount = 0;
  page.on('popup', () => popupCount++);
  await page.goto('/docs/');
  const overviewUrl = page.url();
  const screenshot = page.getByRole('button', { name: /^Enlarge image:/ }).first();
  const lightbox = page.getByRole('dialog', { name: 'Enlarged image', exact: true });

  await screenshot.click();
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByRole('img')).toBeVisible();
  await expect(page).toHaveURL(overviewUrl);
  expect(popupCount).toBe(0);
  await lightbox.getByRole('img').click();
  await expect(lightbox).toBeVisible();
  await lightbox.getByRole('button', { name: 'Close image', exact: true }).click();
  await expect(lightbox).not.toBeVisible();
  await expect(screenshot).toBeFocused();

  await screenshot.click();
  await expect(lightbox).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lightbox).not.toBeVisible();
  await expect(screenshot).toBeFocused();

  await screenshot.click();
  await expect(lightbox).toBeVisible();
  await page.mouse.click(3, 3);
  await expect(lightbox).not.toBeVisible();
  await expect(page).toHaveURL(overviewUrl);

  const article = articles.find((candidate) =>
    [candidate.image, ...candidate.sections.map((section) => section.image)].some((image) =>
      image?.src.endsWith('.svg'),
    ),
  )!;
  const diagram = [article.image, ...article.sections.map((section) => section.image)].find(
    (image) => image?.src.endsWith('.svg'),
  )!;
  await page.goto(guideUrl(article.id));
  const articleUrl = page.url();
  await page.getByRole('button', { name: `Enlarge image: ${diagram.alt}`, exact: true }).click();
  await expect(lightbox.getByRole('img')).toBeVisible();
  await expect(lightbox.getByRole('img')).toHaveAttribute('src', diagram.src);
  await expect(lightbox.getByText(diagram.caption, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(articleUrl);
  await page.keyboard.press('Escape');
  await expect(lightbox).not.toBeVisible();

  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/docs/');
  await screenshot.click();
  const enlarged = lightbox.getByRole('img');
  await expect(enlarged).toBeVisible();
  await expect
    .poll(() =>
      enlarged.evaluate((image) => {
        const bounds = image.getBoundingClientRect();
        return (
          bounds.left >= 0 &&
          bounds.top >= 0 &&
          bounds.right <= window.innerWidth + 1 &&
          bounds.bottom <= window.innerHeight + 1
        );
      }),
    )
    .toBe(true);
  const close = lightbox.getByRole('button', { name: 'Close image', exact: true });
  await expect(close).toBeInViewport();
  await close.click();
  await expect(lightbox).not.toBeVisible();
  await expect(screenshot).toBeFocused();
  await expectNoOverflow(page);

  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.mouse.move(160, 650);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollBefore);
  await expect(page).toHaveURL(overviewUrl);
  expect(popupCount).toBe(0);
});
