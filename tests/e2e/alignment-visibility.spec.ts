import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';

const fixture = {
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Crowded alignment bench',
  parts: [
    { id: 'a', name: 'Moving piece', position: [-18, 30, 0] },
    { id: 'b', name: 'Target piece', position: [18, 30, 0] },
    { id: 'c', name: 'Other piece', position: [48, 30, 0] },
    { id: 'hidden', name: 'Hidden piece', position: [-48, 30, 0] },
  ].map((part) => ({
    ...part,
    geometry: serializeGeometry(new BoxGeometry(16, 16, 16)),
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#c7a48c',
    visible: part.id !== 'hidden',
    locked: false,
    source: 'test',
  })),
  joints: [],
};

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', (error) => messages.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') messages.push(message.text());
  });
  await page.goto('/');
  await expect(page).toHaveTitle(/Kitbasher/);
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'alignment.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await expect(page.locator('.document-title')).toContainText(fixture.name);
  await page.getByRole('button', { name: 'Toggle grid', exact: true }).click();
  await page.locator('.part-select[title="Moving piece"]').click();
  await page.locator('.part-select[title="Target piece"]').click({ modifiers: ['Shift'] });
  await page.keyboard.press('1');
  await page.keyboard.press('5');
  await page.getByRole('button', { name: 'Align A', exact: true }).click();
  await expect(page.getByLabel('Moving part', { exact: true })).toHaveValue('a');
  await expect(page.getByLabel('Target part or plane')).toHaveValue('b');
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const fiber = await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!);
    const root = fiber._roots.get(document.querySelector('canvas')).store.getState();
    const state = useEditor.getState();
    return {
      tool: state.tool as string,
      pending: state.operation.pending?.partId as string | undefined,
      pairs: state.operation.pairs.length as number,
      isolated: state.isolated as string[] | null,
      revision: state.revision as number,
      history: state.past.length as number,
      savedVisibility: state.scene.parts.map((part: any) => part.visible) as boolean[],
      parts: Object.fromEntries(
        state.scene.parts.map((part: any) => {
          const mesh = root.scene.getObjectByName(`part:${part.id}`);
          return [
            part.id,
            {
              shown: mesh.parent.visible as boolean,
              opacity: mesh.material.opacity as number,
              transparent: mesh.material.transparent as boolean,
              depthWrite: mesh.material.depthWrite as boolean,
              shadows: mesh.castShadow as boolean,
            },
          ];
        }),
      ) as Record<
        string,
        {
          shown: boolean;
          opacity: number;
          transparent: boolean;
          depthWrite: boolean;
          shadows: boolean;
        }
      >,
    };
  });
}

async function shown(page: Page) {
  return Object.entries((await snapshot(page)).parts)
    .filter(([, part]) => part.shown)
    .map(([id]) => id);
}

async function edit(page: Page, run: string) {
  await page.evaluate(async (run) => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!;
    const { useEditor } = await import(url);
    new Function('state', run)(useEditor.getState());
  }, run);
}

async function point(page: Page, id: string, local = [0, 0, 8]) {
  const canvas = (await page.locator('canvas').boundingBox())!;
  const ndc = await page.evaluate(
    async ({ id, local }) => {
      const url = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((url) => url.includes('/@react-three_fiber.js'))!;
      const root = (await import(url))._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const mesh = root.scene.getObjectByName(`part:${id}`);
      mesh.updateWorldMatrix(true, false);
      return mesh
        .localToWorld(root.camera.position.clone().fromArray(local))
        .project(root.camera)
        .toArray();
    },
    { id, local },
  );
  return {
    x: canvas.x + ((ndc[0] + 1) * canvas.width) / 2,
    y: canvas.y + ((1 - ndc[1]) * canvas.height) / 2,
  };
}

async function pick(page: Page, id: string, local?: number[]) {
  const at = await point(page, id, local);
  await page.mouse.click(at.x, at.y);
}

test('isolates both selected parts temporarily and restores prior isolation on cancel', async ({
  page,
}) => {
  const before = await snapshot(page);
  await page.getByLabel('Alignment view').selectOption('pair');
  await expect.poll(() => shown(page)).toEqual(['a', 'b']);
  let now = await snapshot(page);
  expect(now.savedVisibility).toEqual(before.savedVisibility);
  expect(now.revision).toBe(before.revision);
  expect(now.history).toBe(before.history);
  await pick(page, 'c');
  expect((await snapshot(page)).pending).toBeUndefined();
  await page.getByLabel('Alignment view').selectOption('scene');
  await expect.poll(() => shown(page)).toEqual(['a', 'b', 'c']);

  await edit(page, "state.isolate(['c'])");
  await expect.poll(() => shown(page)).toEqual(['c']);
  await page.getByLabel('Alignment view').selectOption('pair');
  await expect.poll(() => shown(page)).toEqual(['a', 'b']);
  await page.getByRole('button', { name: /^Cancel/ }).click();
  await expect.poll(() => shown(page)).toEqual(['c']);
  now = await snapshot(page);
  expect(now.isolated).toEqual(['c']);
  expect(now.savedVisibility).toEqual(before.savedVisibility);
  expect(now.history).toBe(before.history);
});

test('active-only follows every point, reset, completed pairs, and apply', async ({ page }) => {
  await page.getByRole('button', { name: '3+ point fit', exact: true }).click();
  await page.getByLabel('Alignment view').selectOption('active');
  await expect.poll(() => shown(page)).toEqual(['a']);
  for (const local of [
    [-3, -3, 8],
    [3, -3, 8],
    [0, 3, 8],
  ]) {
    await pick(page, 'a', local);
    await expect.poll(() => shown(page)).toEqual(['b']);
    // The moving point's marker is hidden along with its part.
    await expect(page.locator('.annotation-label').filter({ hasText: /^source$/ })).toHaveCount(0);
    await pick(page, 'b', local);
    await expect.poll(() => shown(page)).toEqual(['a']);
  }
  expect((await snapshot(page)).pairs).toBe(3);
  await expect(page.getByRole('button', { name: 'Apply alignment', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  expect((await snapshot(page)).pairs).toBe(0);
  await expect.poll(() => shown(page)).toEqual(['a']);

  await page.getByRole('button', { name: 'Point to point', exact: true }).click();
  await pick(page, 'a');
  await expect.poll(() => shown(page)).toEqual(['b']);
  await pick(page, 'b');
  await expect.poll(() => shown(page)).toEqual(['a', 'b']);
  await page.getByRole('button', { name: 'Apply alignment', exact: true }).click();
  await expect.poll(() => shown(page)).toEqual(['a', 'b', 'c']);
  expect((await snapshot(page)).savedVisibility).toEqual([true, true, true, false]);
});

test('ghosts are translucent and click-through in front of the active mesh', async ({ page }) => {
  // Put the target directly in front of the moving part from the orthographic front view.
  await edit(page, "state.transform('b', { position: [-18, 30, 20] })");
  await page.getByLabel('Alignment view').selectOption('ghost');
  await expect.poll(async () => (await snapshot(page)).parts.b.opacity).toBe(0.18);
  await expect.poll(() => shown(page)).toEqual(['a', 'b']);
  const before = await snapshot(page);
  expect(before.parts.b).toMatchObject({ transparent: true, depthWrite: false, shadows: false });
  // The click must pass through the foreground ghost and land on a real source triangle.
  await pick(page, 'a');
  await expect.poll(async () => (await snapshot(page)).pending).toBe('a');
  await expect.poll(async () => (await snapshot(page)).parts.a.opacity).toBe(0.18);
  expect((await snapshot(page)).parts.b.opacity).toBe(1);
  await expect(page.locator('.annotation-label').filter({ hasText: /^source$/ })).toBeVisible();
  // Navigation preserves the pending target and its ghost presentation.
  await page.keyboard.press('o');
  await page.keyboard.press('Escape');
  expect((await snapshot(page)).pending).toBe('a');
  expect((await snapshot(page)).parts.a.opacity).toBe(0.18);
  // Separate the silhouettes for visual inspection after proving overlapping click-through.
  await edit(page, "state.transform('b', { position: [18, 30, 0] })");
  await page.screenshot({ path: '/tmp/kitbasher-alignment-ghost.png' });
  await pick(page, 'b');
  await expect.poll(async () => (await snapshot(page)).pairs).toBe(1);
  expect((await snapshot(page)).parts.a.opacity).toBe(1);
  await page.getByRole('button', { name: /^Cancel/ }).click();
  await expect.poll(() => shown(page)).toEqual(['a', 'b', 'c']);
  expect((await snapshot(page)).parts.b).toMatchObject({
    opacity: 1,
    transparent: false,
    depthWrite: true,
    shadows: true,
  });
});

for (const method of ['contact', 'flush'])
  test(`${method} paint steps follow the active patch and reference-plane alignment stays available`, async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Paint contact surfaces', exact: true }).click();
    await page.getByLabel('Surface relationship').selectOption(method);
    await page.getByLabel('Alignment view').selectOption('active');
    await expect.poll(() => shown(page)).toEqual(['a']);
    await pick(page, 'a');
    await page.getByRole('button', { name: 'Next: paint target', exact: true }).click();
    await expect.poll(() => shown(page)).toEqual(['b']);
    await pick(page, 'b');
    await page.getByRole('button', { name: 'Finish pair', exact: true }).click();
    await expect.poll(() => shown(page)).toEqual(['a', 'b']);
    await page
      .getByRole('button', {
        name: method === 'flush' ? 'Add seam' : 'Add surface pair',
        exact: true,
      })
      .click();
    await expect.poll(() => shown(page)).toEqual(['a']);
    await page.getByRole('button', { name: 'Point to plane', exact: true }).click();
    await page.getByLabel('Target part or plane').selectOption('plane-xy');
    await expect.poll(() => shown(page)).toEqual(['a', 'b', 'c']);
    await expect(
      page.getByLabel('Alignment view').locator('option[value="active"]'),
    ).toBeDisabled();
    await page.getByLabel('Target part or plane').selectOption('b');
    await expect.poll(() => shown(page)).toEqual(['a']);
  });
