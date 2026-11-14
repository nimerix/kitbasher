/** Capture the original Scout sample in a fresh browser, never a user's open scene.
 * Start npm run dev, then npm run docs:capture. Override DOCS_CAPTURE_URL if needed.
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const baseURL = process.env.DOCS_CAPTURE_URL ?? 'http://127.0.0.1:5173';
const output = fileURLToPath(new URL('../public/docs/images/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
  });
  const encoder = await browser.newPage();
  await page.goto(baseURL);
  await page.locator('canvas').first().waitFor();
  await page.locator('.part-select[title="Torso shell"]').waitFor();
  const reset = async () => {
    await page.evaluate(async () => {
      const { useEditor } = await import('/src/core/store.ts');
      const { createSample } = await import('/src/core/sample.ts');
      const { usePreferences } = await import('/src/core/preferences.ts');
      const { useDrive } = await import('/src/core/drive-sync.ts');
      usePreferences.getState().closePanel();
      useDrive.setState({ dialogOpen: false });
      useEditor.getState().setScene(createSample());
      useEditor.getState().setLightingPanel(false);
      useEditor.getState().setModal(null);
      useEditor.getState().select('torso');
      useEditor.getState().setTool('select');
      useEditor.getState().setView({
        explode: 0,
        inspection: { ...useEditor.getState().view.inspection, enabled: false },
      });
    });
  };
  const capture = async (name) => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    const png = await page.screenshot({ type: 'png', animations: 'disabled' });
    const webp = await encoder.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return canvas.toDataURL('image/webp', 0.9).split(',')[1];
    }, png.toString('base64'));
    await writeFile(`${output}${name}.webp`, Buffer.from(webp, 'base64'));
    console.log(`Captured ${name}.webp`);
  };
  await reset();
  await capture('workbench');
  await page.keyboard.press('t');
  await capture('transform');
  await reset();
  await page.locator('.part-select[title="Right shoulder"]').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Align A', exact: true }).click();
  await page.getByRole('button', { name: '3+ point fit', exact: true }).click();
  await capture('alignment');
  await page.keyboard.press('b');
  await capture('contact-paint');
  await reset();
  await page.keyboard.press('k');
  for (const point of [
    { x: 676, y: 422 },
    { x: 714, y: 448 },
    { x: 738, y: 420 },
  ])
    await page.mouse.click(point.x, point.y);
  const finishAnchors = page.getByRole('button', { name: 'Finish adding anchors', exact: true });
  if (await finishAnchors.isVisible()) await finishAnchors.click();
  await capture('anchors');
  await reset();
  await page.locator('.part-select[title="Right shoulder"]').click({ modifiers: ['Shift'] });
  await page.keyboard.press('j');
  await capture('joints');
  await reset();
  await page.getByRole('button', { name: 'Interference', exact: true }).click();
  await page.getByRole('combobox', { name: 'Inspection scope' }).selectOption('selected');
  await page.locator('.part-select[title="Power pack"]').click({ modifiers: ['Shift'] });
  await page.waitForTimeout(1500);
  await capture('inspection');
  await reset();
  await page.getByTitle('Part colors and lighting', { exact: true }).click();
  await capture('display');
  await reset();
  await page.evaluate(async () =>
    (await import('/src/core/store.ts')).useEditor.getState().setLightingPanel(true),
  );
  await capture('lighting');
  await reset();
  await page.evaluate(async () =>
    (await import('/src/core/store.ts')).useEditor.getState().setModal('import'),
  );
  await capture('import');
  await reset();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await capture('export');
  await reset();
  await page.getByRole('button', { name: /^Google Drive:/ }).click();
  await capture('drive');
  await reset();
  await page.evaluate(async () =>
    (await import('/src/core/preferences.ts')).usePreferences.getState().openPanel('keyboard'),
  );
  await capture('preferences');
  await reset();
  await page.evaluate(async () =>
    (await import('/src/core/store.ts')).useEditor.getState().setModal('mesh'),
  );
  await capture('mesh-processing');
  await reset();
  await page.evaluate(async () =>
    (await import('/src/core/preferences.ts')).usePreferences.getState().openPanel('headset'),
  );
  await capture('headset');
  await reset();
  await page.keyboard.press('d');
  await page.mouse.click(642, 420);
  await page.mouse.click(737, 420);
  await capture('measurement');
} finally {
  await browser.close();
}
