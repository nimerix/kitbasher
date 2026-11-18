import { expect, test, type Page } from '@playwright/test';

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
});

async function brushes(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor, warpBrushRadius } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const root = (await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!))._roots
      .get(document.querySelector('canvas'))
      .store.getState();
    let ring: number | null = null;
    root.scene.traverse((object: any) => {
      if (object.geometry?.type === 'RingGeometry') ring = object.geometry.parameters.innerRadius;
    });
    const state = useEditor.getState();
    return { warp: warpBrushRadius(state) as number, align: state.brushRadius as number, ring };
  });
}

test("Warp's brush is fitted to the part and has its own radius", async ({ page }) => {
  // The sample opens with its 31 mm torso selected.
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.keyboard.press('w');
  const radius = page.getByRole('spinbutton', { name: 'Brush radius', exact: true }),
    slider = page.getByRole('slider', { name: 'Brush radius slider' });
  await expect(radius).toHaveValue('0.93');
  const start = await brushes(page);
  expect(start.warp).toBe(0.93);

  // 0.1 mm to a quarter of the part, each doubling taking the same travel.
  await slider.fill('100');
  expect((await brushes(page)).warp).toBeCloseTo(Math.sqrt(0.1 * 7.8), 2);
  await slider.fill('200');
  expect((await brushes(page)).warp).toBe(7.8);
  await radius.fill('2.4');
  await radius.press('Enter');
  await expect(slider).toHaveValue(String(Math.round((Math.log(24) / Math.log(78)) * 200)));
  const typed = await brushes(page);
  expect(typed.warp).toBe(2.4);
  expect(typed.align).toBe(start.align);

  // The cursor ring draws Warp's radius.
  const box = (await page.locator('canvas').boundingBox())!;
  // The middle of the torso's front.
  const [x, y] = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => url.includes('/@react-three_fiber.js'))!;
    const root = (await import(url))._roots.get(document.querySelector('canvas')).store.getState();
    return root.camera.position.clone().set(0, 76, 10).project(root.camera).toArray();
  });
  await page.mouse.move(box.x + ((x + 1) / 2) * box.width, box.y + ((1 - y) / 2) * box.height);
  await expect.poll(async () => (await brushes(page)).ring).toBe(2.4);
});

test("each key press moves Warp's brush slider and radius one step", async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.keyboard.press('w');
  const slider = page.getByRole('slider', { name: 'Brush radius slider' });
  await slider.focus();
  await slider.press('Home');
  await expect(slider).toHaveValue('0');
  let previous = (await brushes(page)).warp;
  expect(previous).toBe(0.1);
  for (let step = 1; step <= 10; step++) {
    await slider.press('ArrowRight');
    await expect(slider).toHaveValue(String(step));
    const { warp } = await brushes(page);
    expect(warp).toBeGreaterThan(previous);
    previous = warp;
  }
  await slider.press('End');
  await expect(slider).toHaveValue('200');
  expect((await brushes(page)).warp).toBe(7.8);
  await slider.press('ArrowLeft');
  await expect(slider).toHaveValue('199');
  expect((await brushes(page)).warp).toBeLessThan(7.8);
  await slider.press('ArrowRight');
  await expect(slider).toHaveValue('200');
  expect((await brushes(page)).warp).toBe(7.8);
});

test("Warp's radius stays with each part when switching between them", async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  const radius = page.getByRole('spinbutton', { name: 'Brush radius', exact: true });
  const warpOn = async (name: string) => {
    if (await page.getByRole('button', { name: 'Cancel', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.locator(`.part-select[title="${name}"]`).click();
    await page.keyboard.press('w');
    await expect(radius).toBeVisible();
  };
  await warpOn('Torso shell');
  await radius.fill('2.4');
  await radius.press('Enter');
  await expect(radius).toHaveValue('2.4');
  await warpOn('Left foot');
  await radius.fill('4');
  await radius.press('Enter');
  await expect(radius).toHaveValue('4');
  await warpOn('Torso shell');
  await expect(radius).toHaveValue('2.4');
  await warpOn('Left foot');
  await expect(radius).toHaveValue('4');
});
