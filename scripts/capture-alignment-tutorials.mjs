/** Reproducible tutorial images, using a fresh browser and the editor's real actions.
 * Start Vite first. DOCS_CAPTURE_URL changes the port; --only=<slug> captures one guide.
 * Fixtures contain only original primitive geometry and never access a user's scene.
 */
import { chromium, expect } from '@playwright/test';
import { BoxGeometry, Euler, Quaternion } from 'three';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createAnimationCapture } from './docs-animation.mjs';

const baseURL = process.env.DOCS_CAPTURE_URL ?? 'http://127.0.0.1:5173';
const root = fileURLToPath(new URL('../public/docs/', import.meta.url));
const animations = process.argv.includes('--animations');
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
const slugs = [
  'point-to-point',
  'point-to-plane',
  'plane-to-plane',
  'multi-point',
  'contact',
  'flush',
  'mate',
  'parallel',
  'perpendicular',
  'angle',
  'anchors',
  'hard-pins',
  'soft-pins',
  'joints',
  'precision',
];
if (only && !slugs.includes(only)) throw new Error(`Unknown tutorial: ${only}`);
await mkdir(`${root}images/tutorials`, { recursive: true });
await mkdir(`${root}examples`, { recursive: true });
function fixture(slug) {
  const flush = slug === 'flush';
  const geometry = new BoxGeometry(20, 20, 12, 10, 10, 6);
  const data = {
    positions: Array.from(geometry.attributes.position.array),
    normals: Array.from(geometry.attributes.normal.array),
    indices: Array.from(geometry.index.array),
  };
  geometry.dispose();
  const angle = flush ? [0, 0.12, 0] : [0, 0.16, -0.18];
  return {
    format: 'kitbasher',
    version: 1,
    units: 'mm',
    name: `Alignment practice · ${slug.replaceAll('-', ' ')}`,
    joints: [],
    constraints: [],
    parts: [
      {
        id: 'moving',
        name: 'Moving block',
        position: flush ? [-11, 24, 1.6] : [-18, 28, 3],
        quaternion: new Quaternion().setFromEuler(new Euler(...angle)).toArray(),
        color: '#db9c67',
      },
      {
        id: 'target',
        name: 'Target block',
        position: flush ? [11, 24, 0] : [14, 24, 0],
        quaternion: [0, 0, 0, 1],
        color: '#79b6af',
      },
    ].map((part) => ({
      ...part,
      geometry: data,
      scale: [1, 1, 1],
      visible: true,
      locked: false,
      source: 'Alignment tutorial · original practice geometry',
    })),
  };
}
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader'],
});
const errors = [];
let animation;
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const encoder = await browser.newPage();
  if (animations) animation = await createAnimationCapture(page, `${root}animations`);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(baseURL);
  await page.locator('.part-select[title="Torso shell"]').waitFor();
  const act = async (fn, arg) =>
    page.evaluate(
      async ({ source, arg }) => {
        const { useEditor } = await import('/src/core/store.ts');
        return new Function('s', 'store', 'arg', `return (${source})(s, store, arg)`)(
          useEditor.getState(),
          useEditor,
          arg,
        );
      },
      { source: fn.toString(), arg },
    );
  const button = (name) => page.getByRole('button', { name, exact: true });
  const select = (name, value) =>
    page.getByRole('combobox', { name, exact: true }).selectOption(value);
  const field = async (name, value) => {
    const input = page.getByRole('spinbutton', { name, exact: true });
    await input.fill(String(value));
    await input.press('Enter');
  };
  const pick = (id, point, normal) => act((s, _, a) => s.pick(a), { partId: id, point, normal });
  // Orbit to expose the target's inward face for its picking/painting step.
  const targetView = async () => {
    await page.evaluate(async () => {
      const url = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((entry) => entry.includes('/@react-three_fiber.js'));
      const { _roots } = await import(url);
      const root = _roots.get(document.querySelector('canvas')).store.getState();
      root.camera.position.x =
        root.controls.target.x - Math.abs(root.camera.position.x - root.controls.target.x);
      root.controls.update();
      root.invalidate();
    });
  };
  const paint = async (id, point, normal) => {
    const painted = await page.evaluate(
      async ({ id, point, normal }) => {
        const { useEditor } = await import('/src/core/store.ts');
        const { readFace } = await import('/src/core/surfaces.ts');
        const { Triangle, Vector3 } = await import('/node_modules/.vite/deps/three.js');
        const s = useEditor.getState(),
          part = s.scene.parts.find((p) => p.id === id);
        const triangle = new Triangle(),
          at = new Vector3(...point),
          n = new Vector3(...normal);
        let nearest = Infinity,
          face = -1;
        for (let i = 0; i < part.geometry.index.count / 3; i++) {
          readFace(part.geometry, i, triangle);
          if (triangle.getNormal(new Vector3()).dot(n) < 0.9) continue;
          const distance = triangle.closestPointToPoint(at, new Vector3()).distanceTo(at);
          if (distance < nearest) {
            nearest = distance;
            face = i;
          }
        }
        const ok = s.paintSurface({ partId: id, point, normal }, face, false, true);
        s.endPaintStroke();
        return ok;
      },
      { id, point, normal },
    );
    if (!painted) throw new Error(`Could not paint ${id} at ${point}`);
  };
  const animate = async (action, title) => (animation ? animation.action(action, title) : action());
  const screenshot = async (slug, step, focus) => {
    if (focus) await focus.scrollIntoViewIfNeeded();
    else
      await page.locator('.assembly-content').evaluateAll((els) =>
        els.forEach((el) => {
          el.scrollTop = 0;
        }),
      );
    await page.mouse.move(15, 15);
    await act((s, store) => store.setState({ toast: null }));
    await page.evaluate(async () => (await import('/src/core/activity.ts')).clearNotifications());
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(450);
    const png = await page.screenshot({ type: 'png', animations: 'disabled' });
    if (animation) {
      const title = await page.evaluate(
        async ({ slug, step }) => {
          const { alignmentTutorials } = await import('/src/docs/alignment-tutorials.ts');
          return alignmentTutorials.find((guide) => guide.id === `tutorial-${slug}`).sections[
            step - 1
          ].title;
        },
        { slug, step },
      );
      await animation.still(png, title);
      console.log(`${slug} animation step ${step}`);
      return;
    }
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
    await writeFile(`${root}images/tutorials/${slug}-${step}.webp`, Buffer.from(webp, 'base64'));
    console.log(`${slug} step ${step}`);
  };
  const open = async (slug, tool = 'align') => {
    const scene = fixture(slug);
    if (!animations) await writeFile(`${root}examples/${slug}.kitbash`, JSON.stringify(scene));
    // Open the same downloadable legacy JSON scene through the normal file importer.
    await page.getByLabel('Open Kitbasher scene', { exact: true }).setInputFiles({
      name: `${slug}.kitbash`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(scene)),
    });
    await button('Open scene').click();
    await page.locator('.part-select[title="Moving block"]').waitFor();
    await act((s, store, tool) => {
      s.select('moving');
      s.setView({
        grid: true,
        partColors: 'editor',
        projection: 'orthographic',
        planes: [],
        clip: { enabled: true, overlap: 0.1 },
        explode: 0,
      });
      store.setState({
        activeAnchor: null,
        activePin: null,
        pinPicking: null,
        anchorPicking: false,
        navigationMode: null,
      });
      s.setTool(tool);
      if (tool === 'align' || tool === 'joint')
        s.setOperation({ sourceId: 'moving', targetId: 'target', view: 'scene' });
      s.focus('iso', true);
    }, tool);
    await page.waitForTimeout(600);
  };
  for (const slug of slugs.filter((id) => !only || id === only)) {
    if (animation) await animation.start(slug);
    if (['point-to-point', 'point-to-plane', 'plane-to-plane', 'multi-point'].includes(slug)) {
      await open(slug);
      const labels = {
        'point-to-point': 'Point to point',
        'point-to-plane': 'Point to plane',
        'plane-to-plane': 'Plane to plane',
        'multi-point': '3+ point fit',
      };
      await button(labels[slug]).click();
      if (slug === 'point-to-plane') {
        await select('Target part or plane', 'plane-xz');
        await button('Ground · XZ').click();
      }
      await screenshot(slug, 1);
      const source = slug === 'point-to-plane' ? [0, -10, 0] : [10, 0, 0];
      const normal = slug === 'point-to-plane' ? [0, -1, 0] : [1, 0, 0];
      await pick('moving', source, normal);
      await screenshot(slug, 2, page.locator('.pick-instructions'));
      if (slug !== 'point-to-plane') await targetView();
      await pick(
        slug === 'point-to-plane' ? 'plane-xz' : 'target',
        slug === 'point-to-plane' ? [-18, 0, 3] : [-10, 0, 0],
        slug === 'point-to-plane' ? [0, 1, 0] : [-1, 0, 0],
      );
      await screenshot(slug, 3, page.locator('.picked-pairs'));
      await act((s) => s.focus('iso', true));
      if (slug === 'multi-point') {
        // Replace the central first pair with three spread-out correspondences.
        await button('Reset').click();
        for (const [y, z] of [
          [-6, -4],
          [6, -4],
          [0, 4],
        ]) {
          await pick('moving', [10, y, z], [1, 0, 0]);
          await pick('target', [-10, y, z], [-1, 0, 0]);
        }
        await screenshot(slug, 4, page.locator('.fit-summary'));
      } else {
        await field('Alignment offset', slug === 'point-to-plane' ? 0 : 0.5);
        await screenshot(
          slug,
          4,
          page.getByRole('spinbutton', { name: 'Alignment offset', exact: true }),
        );
      }
      await expect(button('Apply alignment')).toBeEnabled();
      await animate(
        () => button('Apply alignment').click(),
        'the moving block reaches its fitted pose.',
      );
      await expect(page.locator('.assembly-inspector')).toHaveCount(0);
      await screenshot(slug, 5);
    } else if (['contact', 'flush', 'mate', 'parallel', 'perpendicular', 'angle'].includes(slug)) {
      await open(slug);
      await button('Paint contact surfaces').click();
      await select('Surface relationship', slug);
      await field('Brush radius', 3);
      await screenshot(
        slug,
        1,
        page.getByRole('combobox', { name: 'Surface relationship', exact: true }),
      );
      const front = ['flush', 'parallel', 'perpendicular', 'angle'].includes(slug);
      const source = front ? [slug === 'flush' ? 8 : 0, -5, 6] : [10, -6, -3];
      const target = front ? [slug === 'flush' ? -8 : 0, -5, 6] : [-10, -6, -3];
      await paint('moving', source, front ? [0, 0, 1] : [1, 0, 0]);
      await screenshot(slug, 2, page.locator('.surface-pair-list'));
      if (slug !== 'flush') await button('Next: paint target').click();
      if (!front) await targetView();
      await paint('target', target, front ? [0, 0, 1] : [-1, 0, 0]);
      if (slug !== 'flush') await button('Finish pair').click();
      await screenshot(slug, 3, page.locator('.surface-pair-list'));
      await act((s) => s.focus('iso', true));
      if (slug === 'contact' || slug === 'flush') {
        const points =
          slug === 'contact'
            ? [
                [6, -3],
                [0, 4],
              ]
            : [[5, 6]];
        for (const [y, z] of points) {
          await button(slug === 'flush' ? 'Add seam' : 'Add surface pair').click();
          await paint(
            'moving',
            slug === 'flush' ? [8, y, 6] : [10, y, z],
            front ? [0, 0, 1] : [1, 0, 0],
          );
          if (slug !== 'flush') await button('Next: paint target').click();
          await paint(
            'target',
            slug === 'flush' ? [-8, y, 6] : [-10, y, z],
            front ? [0, 0, 1] : [-1, 0, 0],
          );
          if (slug !== 'flush') await button('Finish pair').click();
        }
        await screenshot(slug, 4, page.locator('.fit-summary'));
        await animate(
          () => button(slug === 'flush' ? 'Apply flush fit' : 'Fit contact surfaces').click(),
          slug === 'flush'
            ? 'balance height and tilt across both seams.'
            : 'seat the three matching contact regions.',
        );
        await expect(page.locator('.assembly-inspector')).toHaveCount(0);
        await screenshot(slug, 5);
      } else {
        if (slug === 'parallel')
          await page.getByRole('switch', { name: 'Opposing face normals', exact: true }).click();
        if (slug === 'mate') await field('Alignment offset', 0.5);
        if (slug === 'angle') await field('Plane alignment angle', 45);
        await page
          .getByRole('switch', { name: 'Keep plane constraints active', exact: true })
          .click();
        await screenshot(
          slug,
          4,
          page.getByRole('switch', { name: 'Keep plane constraints active', exact: true }),
        );
        await animate(
          () => button('Create plane constraints').click(),
          `apply the ${slug} plane relationship.`,
        );
        await expect(page.locator('.assembly-inspector')).toHaveCount(0);
        await page.getByRole('button', { name: /^Constraints/ }).click();
        await screenshot(slug, 5);
        const control = page.locator('.constraint-card').getByRole('switch');
        await control.click();
        await screenshot(slug, 6);
        await page.getByRole('button', { name: /^Parts \d/ }).click();
      }
    } else if (slug === 'anchors') {
      await open(slug, 'anchors');
      await screenshot(slug, 1);
      for (const point of [
        [-7, -6, 6],
        [7, -6, 6],
        [0, 7, 6],
      ])
        await act(
          (s, _, point) => s.addFitAnchor({ partId: 'moving', point, normal: [0, 0, 1] }),
          point,
        );
      await button('Finish adding anchors').click();
      await screenshot(slug, 2);
      await page.locator('.anchor-row').first().getByRole('button').first().click();
      await screenshot(slug, 3);
      const current = Number(
        await page.getByRole('spinbutton', { name: 'Anchor target X', exact: true }).inputValue(),
      );
      await animate(
        () => field('Anchor target X', current + 3),
        'move one target; balance the other anchors without stretching the block.',
      );
      await screenshot(slug, 4);
      await button('Hold current positions').click();
      await screenshot(slug, 5);
    } else if (slug === 'hard-pins' || slug === 'soft-pins') {
      const soft = slug === 'soft-pins';
      await open(slug, 'pins');
      const placing = button(soft ? 'Soft pin' : 'Pin').last();
      if ((await placing.getAttribute('aria-pressed')) !== 'true') await placing.click();
      await screenshot(slug, 1);
      const points = soft
        ? [
            [-7, -6, 6],
            [7, 6, 6],
          ]
        : [[-7, -6, 6]];
      for (const point of points)
        await act((s, _, point) => s.addPin({ partId: 'moving', point, normal: [0, 0, 1] }), point);
      await button('Finish placing pins').click();
      await screenshot(slug, 2);
      if (soft) {
        await page.locator('.anchor-row').first().getByRole('button').first().click();
        await field('Soft pin priority', 85);
        await page.locator('.anchor-row').nth(1).getByRole('button').first().click();
        await field('Soft pin priority', 15);
      } else {
        await button('Rotate part').click();
      }
      await screenshot(slug, 3);
      await animate(
        async () => {
          await act((s) =>
            s.transform('moving', { quaternion: [0, 0, Math.sin(0.3), Math.cos(0.3)] }),
          );
          await act((s) => s.setTool('pins'));
        },
        soft
          ? 'the weaker soft pin stretches farther.'
          : 'rotate while the hard pin stays fixed in world space.',
      );
      await screenshot(slug, 4);
      await button('Reset resting points').click();
      await screenshot(slug, 5);
    } else if (slug === 'joints') {
      await open(slug, 'joint');
      await screenshot(slug, 1);
      await pick('moving', [10, 0, 0], [1, 0, 0]);
      await screenshot(slug, 2);
      await targetView();
      await pick('target', [-10, 0, 0], [-1, 0, 0]);
      await screenshot(slug, 3);
      await act((s) => s.focus('iso', true));
      await act((s) => s.setOperation({ keepConnected: true, rotationLocks: [true, true, false] }));
      await screenshot(slug, 4);
      await animate(
        () => button('Create joint').click(),
        'bring the child and parent anchors together.',
      );
      await expect(page.locator('.assembly-inspector')).toHaveCount(0);
      await act((s) => s.setTool('rotate'));
      await animate(
        () => field('Rotation Z', 25),
        'rotate around the connected anchor on the free Z axis.',
      );
      await screenshot(slug, 5);
    } else if (slug === 'precision') {
      await open(slug, 'transform');
      await screenshot(slug, 1);
      await act((s) => s.setTool('translate'));
      await animate(
        () => field('Position X', -12),
        'translate along world X while keeping the original orientation.',
      );
      await screenshot(slug, 2);
      await field('Move step', 0.1);
      await button('Move X positive').click();
      await button('Snap dragging').click();
      await screenshot(slug, 3, page.locator('.transform-adjustments'));
      await act((s) => {
        s.setPartPivot({ partId: 'moving', point: [10, 0, 0], normal: [1, 0, 0] });
        s.setTool('rotate');
      });
      await screenshot(slug, 4, page.locator('.part-pivot-controls'));
      await act((s) => {
        s.setTool('translate');
        s.beginFreeTransform('translate');
      });
      await screenshot(slug, 5);
      await act((s) => s.finishFreeTransform(false));
    }
    if (animation) await animation.finish();
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  if (animation) await animation.dispose();
  await browser.close();
}
