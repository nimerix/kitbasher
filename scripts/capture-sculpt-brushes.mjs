// Capture matched viewport crops before and after real brush strokes on a test part.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const output = new URL('../public/docs/images/sculpt/', import.meta.url);
const baseURL = process.env.DOCS_CAPTURE_URL ?? 'http://127.0.0.1:5173';
const brushes = [
  ['draw', 'Draw', 0.85],
  ['grab', 'Grab', 1.65],
  ['smooth', 'Smooth', 1.65],
  ['flatten', 'Flatten', 1.85],
  ['crease', 'Crease', 0.85],
  ['clay', 'Clay Buildup', 1.1],
  ['inflate', 'Inflate/Deflate', 1.0],
  ['mask', 'Mask', 0.9],
];
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
if (only && !brushes.some(([id]) => id === only)) throw new Error('Unknown brush: ' + only);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader'],
});
try {
  for (const [id, label, radius] of brushes) {
    if (only && only !== id) continue;
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(baseURL);
    await page.locator('.part-select[title="Torso shell"]').waitFor();
    await page.evaluate(async (id) => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const { useEditor } = await import(
        urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))
      );
      const { softBox } = await import('/tests/helpers/soft-edges.ts');
      const geometry = softBox([3.6, 2.4, 0.5], 0.28, {
        indexed: true,
        step: 0.14,
        ripple: 0,
        noise: 0,
      });
      const position = geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i),
          y = position.getY(i),
          z = position.getZ(i);
        if (z < 0.49) continue;
        const envelope = Math.exp(-(x * x + y * y) / 1.45);
        if (id === 'flatten') position.setZ(i, z + envelope);
        if (id === 'inflate') {
          const left = Math.exp(-((x + 1.45) ** 2 + y * y));
          const right = Math.exp(-((x - 1.45) ** 2 + y * y));
          position.setZ(i, z + (left + right) * 0.75);
        }
        if (id === 'smooth')
          position.setZ(i, z + envelope * 0.22 * (Math.sin(x * 13) + Math.cos(y * 11)));
      }
      geometry.computeVertexNormals();
      const state = useEditor.getState();
      const { presetLighting } = await import('/src/core/lighting.ts');
      state.setScene({
        lighting: { ...presetLighting('studio'), shadows: false },
        name: 'Brush example',
        joints: [],
        parts: [
          {
            id: 'tile',
            name: 'Practice tile',
            source: 'Practice tile',
            geometry,
            color: '#bf9270',
            position: [0, 0, 0],
            quaternion: [0, 0, 0, 1],
            scale: [1, 1, 1],
            visible: true,
            locked: false,
          },
        ],
      });
      state.select('tile');
      state.setView({ grid: false });
      window.captureEditor = useEditor;
    }, id);
    await page
      .getByRole('toolbar', { name: 'Assembly tools' })
      .getByRole('button', { name: /^Sculpt\b/ })
      .click();
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.addStyleTag({ content: '.camera-navigation { visibility: hidden }' });
    await page.waitForFunction(async () => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const fiber = urls.find((url) => url.includes('/@react-three_fiber.js'));
      if (!fiber) return false;
      const root = (await import(fiber))._roots.get(document.querySelector('canvas'));
      return !!root?.store.getState().controls;
    });
    const clip = await page.evaluate(
      async ({ radius, id }) => {
        const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
        const { _roots } = await import(urls.find((url) => url.includes('/@react-three_fiber.js')));
        const canvas = document.querySelector('canvas');
        const { camera, controls, invalidate } = _roots.get(canvas).store.getState();
        camera.position.set(4, 5, 20);
        controls.target.set(0, 0, 0);
        controls.update();
        window.captureEditor
          .getState()
          .setSculptSettings({
            radius,
            strength: ['clay', 'draw', 'inflate', 'crease'].includes(id) ? 0.46 : 0.85,
            spacing: 0.2,
          });
        invalidate();
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        const rect = canvas.getBoundingClientRect();
        window.projectStroke = (point) => {
          const p = camera.position.clone().fromArray(point).project(camera);
          return {
            x: rect.x + ((1 + p.x) * rect.width) / 2,
            y: rect.y + ((1 - p.y) * rect.height) / 2,
          };
        };
        const center = window.projectStroke([0, 0, 0]);
        const width = Math.round(Math.abs(window.projectStroke([4.6, 0, 0]).x - center.x) * 2);
        const height = Math.round(width * 0.72);
        return {
          x: Math.round(center.x - width / 2),
          y: Math.round(center.y - height / 2),
          width,
          height,
        };
      },
      { radius, id },
    );
    const capture = async () => {
      await page.mouse.move(10, 10);
      return (await page.screenshot({ clip, animations: 'disabled' })).toString('base64');
    };
    const before = await capture();
    async function stroke(points) {
      const history = await page.evaluate(() => window.captureEditor.getState().sculpt.past.length);
      const path = await page.evaluate((points) => points.map(window.projectStroke), points);
      await page.mouse.move(path[0].x, path[0].y);
      await page.mouse.down();
      for (const p of path.slice(1)) await page.mouse.move(p.x, p.y, { steps: 12 });
      await page.mouse.up();
      await expect
        .poll(() => page.evaluate(() => window.captureEditor.getState().sculpt.past.length))
        .toBeGreaterThan(history);
    }
    if (id === 'grab')
      await stroke([
        [1.5, 2.12, 0.5],
        [2.05, 2.97, 0.5],
      ]);
    else if (id === 'inflate') {
      await stroke([
        [-1.75, 0, 1.18],
        [-1.15, 0, 1.18],
      ]);
      await page.keyboard.down('Alt');
      await stroke([
        [1.15, 0, 1.18],
        [1.75, 0, 1.18],
      ]);
      await page.keyboard.up('Alt');
    } else if (id === 'flatten')
      await stroke([
        [-0.35, 0, 1.45],
        [0.35, 0, 1.45],
      ]);
    else if (id === 'smooth') {
      for (const y of [-0.45, 0, 0.45])
        await stroke([
          [-1.5, y, 0.5],
          [1.5, y, 0.5],
        ]);
    } else if (id === 'clay') {
      for (const y of [-0.55, 0, 0.55])
        await stroke([
          [-1.55, y, 0.5],
          [1.55, y + 0.3, 0.5],
        ]);
    } else
      await stroke([
        [-1.7, -0.65, 0.5],
        [0, 0.25, 0.5],
        [1.7, 0.65, 0.5],
      ]);
    const after = await capture();
    const pair = await page.evaluate(
      async ([before, after]) => {
        const images = await Promise.all(
          [before, after].map(async (png) => {
            const image = new Image();
            image.src = 'data:image/png;base64,' + png;
            await image.decode();
            return image;
          }),
        );
        const [first] = images;
        const canvas = document.createElement('canvas');
        canvas.width = first.width * 2 + 4;
        canvas.height = first.height + 40;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#202225';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = '600 21px system-ui';
        ctx.fillStyle = '#f3f1ef';
        images.forEach((image, i) => {
          const x = i * (image.width + 4);
          ctx.fillText(i ? 'After' : 'Before', x + 12, 28);
          ctx.drawImage(image, x, 40);
        });
        return canvas.toDataURL('image/webp', 0.94).split(',')[1];
      },
      [before, after],
    );
    expect(errors).toEqual([]);
    await writeFile(new URL(id + '.webp', output), Buffer.from(pair, 'base64'));
    console.log('Captured ' + label);
    await page.close();
  }
} finally {
  await browser.close();
}
