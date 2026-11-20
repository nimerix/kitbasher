/** Focused UI references from a fresh Scout sample; never uses an existing tab.
 * Run with a dev server: npm run docs:capture:reference [-- --only=file-menu]
 */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const baseURL = process.env.DOCS_CAPTURE_URL ?? 'http://127.0.0.1:5173';
const output = fileURLToPath(new URL('../public/docs/images/reference/', import.meta.url));
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader'],
});
const dimensions = {};
try {
  const encoder = await browser.newPage();
  const capture = async (name, prepare, clip) => {
    if (only && only !== name) return;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(baseURL);
      await page.locator('.part-select[title="Torso shell"]').waitFor();
      await page.evaluate(async () => {
        const { useEditor } = await import('/src/core/store.ts');
        const { createSample } = await import('/src/core/sample.ts');
        useEditor.getState().setScene(createSample());
        useEditor.getState().select('torso');
      });
      await prepare(page);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(700);
      const png = await page.screenshot({ type: 'png', animations: 'disabled', clip });
      const encoded = await encoder.evaluate(async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        return {
          data: canvas.toDataURL('image/webp', 0.92).split(',')[1],
          width: image.width,
          height: image.height,
        };
      }, png.toString('base64'));
      expect(errors, `${name} page errors`).toEqual([]);
      await writeFile(`${output}${name}.webp`, Buffer.from(encoded.data, 'base64'));
      dimensions[name] = { width: encoded.width, height: encoded.height };
      console.log(`Captured ${name}.webp (${encoded.width} × ${encoded.height})`);
    } finally {
      await context.close();
    }
  };
  const unchanged = async () => {};
  const upperLeft = { x: 0, y: 0, width: 760, height: 500 };
  const right = { x: 680, y: 0, width: 760, height: 800 };

  await capture(
    'file-menu',
    async (page) => {
      await page.getByRole('button', { name: 'File', exact: true }).click();
      await expect(page.locator('.dropdown-menu')).toBeVisible();
    },
    upperLeft,
  );
  await capture('toolbar', unchanged, { x: 0, y: 0, width: 1440, height: 164 });
  await capture('placement-settings', unchanged, { x: 960, y: 52, width: 480, height: 100 });
  await capture(
    'parts-controls',
    async (page) => {
      await page.getByRole('button', { name: 'Hide Power pack', exact: true }).click();
      await page.locator('.part-select[title="Torso shell"]').hover();
    },
    { x: 0, y: 96, width: 760, height: 790 },
  );
  await capture(
    'camera-controls',
    async (page) => {
      await page.getByRole('button', { name: /^Orbit tool/ }).click();
    },
    { x: 500, y: 420, width: 650, height: 540 },
  );
  await capture(
    'view-menu',
    async (page) => {
      await page.getByRole('button', { name: 'Perspective', exact: true }).click();
    },
    { x: 260, y: 96, width: 760, height: 440 },
  );
  await capture('isolation', async (page) => {
    await page.keyboard.press('i');
    await page.getByRole('switch', { name: 'Nearby surfaces', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: 'Nearby distance in mm' })).toBeVisible();
    await expect(page.locator('.isolation-nearby .spin')).toHaveCount(0);
  });
  await capture(
    'context-actions',
    async (page) => {
      await page.locator('.part-select[title="Torso shell"]').click({ button: 'right' });
      await expect(page.getByRole('menu', { name: 'Component actions' })).toBeVisible();
    },
    { x: 0, y: 96, width: 760, height: 864 },
  );
  await capture(
    'brush-settings',
    async (page) => {
      await page.keyboard.press('b');
      await page
        .locator('canvas')
        .first()
        .click({ button: 'right', position: { x: 320, y: 220 } });
      const brush = page.getByRole('dialog', { name: 'Paint brush settings' });
      await expect(brush).toBeVisible();
      await brush.getByRole('switch', { name: 'Restrict brush to seed plane' }).click();
    },
    { x: 260, y: 96, width: 890, height: 864 },
  );
  await capture(
    'precision-controls',
    async (page) => {
      await page.keyboard.press('g');
      await expect(page.getByRole('group', { name: 'Move by step' })).toBeVisible();
    },
    right,
  );
  await capture('reference-plane', async (page) => {
    await page.keyboard.press('a');
    await page.getByRole('button', { name: 'Point to plane', exact: true }).click();
    const target = page.getByRole('combobox', { name: 'Target part or plane' });
    await target.selectOption({ label: 'Ground · XZ' });
    await page
      .locator('.reference-planes')
      .getByRole('button', { name: /Ground/ })
      .click();
  });
  for (const tab of ['navigation', 'markers']) {
    await capture(
      `preferences-${tab}`,
      async (page) => {
        await page.evaluate(async (tab) => {
          (await import('/src/core/preferences.ts')).usePreferences.getState().openPanel(tab);
        }, tab);
        await expect(page.getByRole('tab', { name: new RegExp(tab, 'i') })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        if (tab === 'markers')
          await page.getByRole('radio', { name: 'Callout', exact: true }).click();
      },
      tab === 'markers' ? { x: 680, y: 96, width: 760, height: 864 } : right,
    );
  }
  for (const panel of ['Background activity', 'Notifications']) {
    await capture(
      panel === 'Notifications' ? 'notifications' : 'background-activity',
      async (page) => {
        if (panel === 'Notifications') {
          const download = page.waitForEvent('download');
          await page.getByRole('button', { name: 'Save scene', exact: true }).click();
          await (await download).path();
        } else {
          await page.getByRole('button', { name: 'Interference', exact: true }).click();
        }
        await page.getByRole('button', { name: panel, exact: true }).click();
        await expect(page.getByRole('region', { name: panel, exact: true })).toBeVisible();
        if (panel === 'Background activity') {
          await expect(page.locator('.activity-row.activity-completed')).toBeVisible({
            timeout: 30000,
          });
        }
      },
      { x: 760, y: 0, width: 680, height: 540 },
    );
  }
  await capture('refine', async (page) => {
    // A synthetic scan: the softened block of the Refine end-to-end tests.
    await page.evaluate(async () => {
      // The store module as the app loaded it, so the scene reaches the running editor.
      const store = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url));
      const { useEditor } = await import(store);
      const { softBox } = await import('/tests/helpers/soft-edges.ts');
      const geometry = softBox([4, 3, 2], 0.6, { step: 0.2, ripple: 0.04, noise: 0.008 });
      useEditor.getState().setScene({
        name: 'Refine',
        joints: [],
        parts: [
          {
            id: 'block',
            name: 'Scanned block',
            geometry,
            position: [0, 0, 0],
            quaternion: [0, 0, 0, 1],
            scale: [1, 1, 1],
            color: '#d4a272',
            visible: true,
            locked: false,
            source: 'Scanned block',
          },
        ],
      });
      useEditor.getState().select('block');
    });
    await page.locator('.part-select[title="Scanned block"]').waitFor();
    await page.keyboard.press('1');
    await page.keyboard.press('Home');
    const canvas = await page.locator('canvas').first().boundingBox();
    const centre = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(centre.x - 70, centre.y + 45, { steps: 12 });
    await page.mouse.up({ button: 'middle' });
    await page.keyboard.press('Home');
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(2000);
    await page.keyboard.press('e');
    await expect(page.getByRole('radio', { name: 'Edge', exact: true })).toBeVisible({
      timeout: 30000,
    });
    await page.waitForTimeout(800);
    // The crest of a rounded edge of the block: 0.6 mm fillets on a block of half size 4, 3, 2.
    const inset = 0.6 - 0.6 / Math.SQRT2;
    const click = async (world) => {
      const ndc = await page.evaluate(async (world) => {
        const url = performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((url) => url.includes('/@react-three_fiber.js'));
        const root = (await import(url))._roots.get(document.querySelector('canvas')).store;
        const { camera } = root.getState();
        return camera.position.clone().fromArray(world).project(camera).toArray();
      }, world);
      await page.mouse.click(
        canvas.x + ((ndc[0] + 1) * canvas.width) / 2,
        canvas.y + ((1 - ndc[1]) * canvas.height) / 2,
      );
    };
    await click([-3, 3 - inset, 2 - inset]);
    await click([3, 3 - inset, 2 - inset]);
    await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible({ timeout: 30000 });
    await click([4 - inset, 2, 2 - inset]);
    await click([4 - inset, -2, 2 - inset]);
    await expect(page.getByText('1 accepted · 1 proposed')).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(1500);
  });
  await capture('exploded-view', async (page) => {
    await page.getByRole('slider', { name: 'Exploded view amount' }).fill('65');
  });
  await capture('mobile-panels', async (page) => {
    await page.setViewportSize({ width: 640, height: 900 });
  });
  if (only && !dimensions[only]) throw new Error(`Unknown reference capture: ${only}`);
} finally {
  await browser.close();
}
