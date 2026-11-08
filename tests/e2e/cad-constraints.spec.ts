import { expect, test, type Page } from '@playwright/test';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { serializeGeometry } from '../../src/core/geometry';
import type { SceneFile } from '../../src/core/types';
import { readSavedScene } from './saved-scene';

// Browser plugin not available; use local Playwright.
// Flow: preserve paint/picks while orbiting -> precisely transform -> retain and edit plane mates.
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
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

const plateGeometry = serializeGeometry(new PlaneGeometry(32, 32, 16, 16));
const plates: SceneFile = {
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'CAD plane assembly',
  joints: [],
  parts: [-28, 28].map((x, i) => ({
    id: i ? 'target' : 'moving',
    name: i ? 'Target plate' : 'Moving plate',
    geometry: plateGeometry,
    position: [x, 54, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: i ? '#8cbeb6' : '#d4a272',
    locked: false,
    visible: true,
    source: 'test',
  })),
};
const cube: SceneFile = {
  ...plates,
  name: 'Precision drag fixture',
  parts: [
    {
      ...plates.parts[0],
      id: 'cube',
      name: 'Precision cube',
      geometry: serializeGeometry(new BoxGeometry(30, 30, 30)),
      position: [0, 15, 0],
    },
  ],
};

async function state(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const fiber = await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!);
    const root = fiber._roots.get(document.querySelector('canvas')).store.getState();
    const s = useEditor.getState();
    return {
      operation: s.operation,
      selected: s.selected,
      painting: s.painting,
      temporaryOrbit: s.temporaryOrbit,
      precision: s.precision,
      tool: s.tool,
      past: s.past.length,
      constraints: s.scene.constraints ?? [],
      parts: s.scene.parts.map((part: any) => ({
        id: part.id,
        position: part.position,
        quaternion: part.quaternion,
        scale: part.scale,
      })),
      camera: root.camera.position.toArray(),
      target: root.controls.target.toArray(),
      cameraEnabled: root.controls.enabled,
    };
  });
}
async function screenPoint(page: Page, id: string, local: number[]) {
  const box = (await page.locator('canvas').boundingBox())!;
  const ndc = await page.evaluate(
    async ({ id, local }) => {
      const url = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((url) => url.includes('/@react-three_fiber.js'))!;
      const fiber = await import(url),
        root = fiber._roots.get(document.querySelector('canvas')).store.getState();
      const mesh = root.scene.getObjectByName(`part:${id}`);
      mesh.updateWorldMatrix(true, false);
      return mesh
        .localToWorld(root.camera.position.clone().fromArray(local))
        .project(root.camera)
        .toArray();
    },
    { id, local },
  );
  return { x: box.x + ((ndc[0] + 1) * box.width) / 2, y: box.y + ((1 - ndc[1]) * box.height) / 2 };
}
async function openFixture(page: Page, fixture = plates) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'cad.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator(`.part-select[title="${fixture.parts[0].name}"]`).click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await expect(page.locator('.document-title')).toContainText(fixture.name);
  await expect(page).toHaveTitle('Kitbasher — Assembly workbench');
}
async function paint(page: Page, id: string, local = [0, 0, 0]) {
  const point = await screenPoint(page, id, local);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 3, point.y + 1, { steps: 3 });
  await page.mouse.up();
}
async function cameraDrag(page: Page, button: 'left' | 'middle' | 'right', space = false) {
  if (space) await page.keyboard.down('Space');
  const point = await screenPoint(page, 'moving', [0, 0, 0]);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down({ button });
  await page.mouse.move(point.x + 36, point.y + 14, { steps: 8 });
  await page.mouse.up({ button });
  if (space) await page.keyboard.up('Space');
}

for (const workflow of ['point', 'paint'] as const) {
  test(`orbits on the model with middle drag and Space while preserving ${workflow} alignment`, async ({
    page,
  }) => {
    await openFixture(page);
    if (workflow === 'paint') {
      await page.keyboard.press('b');
      await page.getByRole('combobox', { name: 'Target part', exact: true }).selectOption('target');
      await paint(page, 'moving', [-5, 0, 0]);
    } else {
      await page.keyboard.press('a');
      await page.getByRole('button', { name: '3+ point fit', exact: true }).click();
      const point = await screenPoint(page, 'moving', [-5, 0, 0]);
      await page.mouse.click(point.x, point.y);
    }
    const initial = await state(page);
    if (workflow === 'paint')
      expect(initial.operation.surfacePairs[0].source!.faces.length).toBeGreaterThan(0);
    else expect(initial.operation.pending).not.toBeNull();
    for (const gesture of [
      { button: 'middle' },
      { button: 'left', space: true },
      { button: 'right' },
    ] as const) {
      await page.keyboard.press('1');
      const before = await state(page);
      await cameraDrag(page, gesture.button, 'space' in gesture && gesture.space);
      const after = await state(page);
      expect(
        new Vector3(...after.camera).distanceTo(new Vector3(...before.camera)),
      ).toBeGreaterThan(0.1);
      expect(after.operation).toEqual(initial.operation);
      expect(after.tool).toBe('align');
      await expect(page.getByRole('menu', { name: 'Component actions' })).toHaveCount(0);
      expect(after.parts).toEqual(initial.parts);
      expect(after.selected).toEqual(initial.selected);
      expect(after.temporaryOrbit).toBe(false);
      expect(after.painting).toBe(false);
    }
    // Focus loss must clear temporary modifiers and leave the current workflow intact.
    await page.keyboard.down('Space');
    await page.keyboard.down('Shift');
    expect((await state(page)).temporaryOrbit).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    const blurred = await state(page);
    expect(blurred.temporaryOrbit).toBe(false);
    expect(blurred.precision).toBe(false);
    expect(blurred.operation).toEqual(initial.operation);
    await page.keyboard.up('Space');
    await page.keyboard.up('Shift');
    if (workflow === 'paint') {
      await page.keyboard.press('1');
      await paint(page, 'moving', [-3, 0, 0]);
      expect((await state(page)).operation.surfacePairs[0].source!.faces.length).toBeGreaterThan(
        initial.operation.surfacePairs[0].source!.faces.length,
      );
    }
  });
}

for (const mode of ['translate', 'rotate'] as const) {
  test(`uses 10 percent Shift sensitivity for an actual ${mode} gizmo and switches mid-drag continuously`, async ({
    page,
  }) => {
    await openFixture(page, cube);
    const box = (await page.locator('canvas').boundingBox())!,
      cx = box.x + box.width / 2,
      cy = box.y + box.height / 2;
    const initial = await state(page);
    const at = (t: number) =>
      mode === 'translate'
        ? { x: cx + 70 + t * 60, y: cy }
        : {
            x: cx + 100 * Math.cos(((-135 + t * 45) * Math.PI) / 180),
            y: cy + 100 * Math.sin(((-135 + t * 45) * Math.PI) / 180),
          };
    const distance = (a: Awaited<ReturnType<typeof state>>, b = initial) =>
      mode === 'translate'
        ? new Vector3(...a.parts[0].position).distanceTo(new Vector3(...b.parts[0].position))
        : new Quaternion(...a.parts[0].quaternion).angleTo(
            new Quaternion(...b.parts[0].quaternion),
          );
    async function drag(fine: boolean, switchGain = false) {
      await page
        .getByRole('button', {
          name: mode === 'translate' ? 'Move (G)' : 'Rotate (R)',
          exact: true,
        })
        .click();
      if (fine) await page.keyboard.down('Shift');
      const start = at(0);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      const samples: Awaited<ReturnType<typeof state>>[] = [];
      for (let i = 1; i <= 12; i++) {
        const p = at(i / 12);
        await page.mouse.move(p.x, p.y);
        if ([4, 8, 12].includes(i)) samples.push(await state(page));
        if (switchGain && i === 4) {
          await page.keyboard.down('Shift');
          expect(distance(await state(page), samples[0])).toBeLessThan(1e-6);
        }
        if (switchGain && i === 8) {
          await page.keyboard.up('Shift');
          expect(distance(await state(page), samples[1])).toBeLessThan(1e-6);
        }
      }
      await page.mouse.up();
      if (fine) await page.keyboard.up('Shift');
      return { final: await state(page), samples };
    }
    const normal = await drag(false);
    expect(distance(normal.final)).toBeGreaterThan(mode === 'translate' ? 1 : 0.05);
    expect(normal.final.past).toBe(initial.past + 1);
    await page.keyboard.press('Control+z');
    expect((await state(page)).parts).toEqual(initial.parts);
    const fine = await drag(true);
    expect(distance(fine.final) / distance(normal.final)).toBeCloseTo(0.1, 3);
    expect(fine.final.past).toBe(initial.past + 1);
    await page.keyboard.press('Control+z');
    expect((await state(page)).parts).toEqual(initial.parts);
    const mixed = await drag(false, true);
    const increments = [
      distance(mixed.samples[0]),
      distance(mixed.samples[1], mixed.samples[0]),
      distance(mixed.samples[2], mixed.samples[1]),
    ];
    const reference = [
      distance(normal.samples[0]),
      distance(normal.samples[1], normal.samples[0]),
      distance(normal.samples[2], normal.samples[1]),
    ];
    expect(increments[0] / reference[0]).toBeCloseTo(1, 3);
    expect(increments[1] / reference[1]).toBeCloseTo(0.1, 3);
    expect(increments[2] / reference[2]).toBeCloseTo(1, 3);
    expect(mixed.final.past).toBe(initial.past + 1);
    await page.keyboard.press('Control+z');
    expect((await state(page)).parts).toEqual(initial.parts);
  });
}

test('paints one plane pair, retains its mate, edits and suppresses it, and restores it from a saved scene', async ({
  page,
}) => {
  await openFixture(page);
  await page.keyboard.press('b');
  await page.getByRole('combobox', { name: 'Target part', exact: true }).selectOption('target');
  await page
    .getByRole('combobox', { name: 'Surface relationship', exact: true })
    .selectOption('mate');
  const planeFilter = page.getByRole('switch', {
    name: 'Restrict brush to seed plane',
    exact: true,
  });
  await planeFilter.click();
  await page
    .getByRole('spinbutton', { name: 'Brush plane angle tolerance', exact: true })
    .fill('12');
  await page
    .getByRole('spinbutton', { name: 'Brush plane angle tolerance', exact: true })
    .press('Enter');
  await page
    .getByRole('spinbutton', { name: 'Brush plane distance tolerance', exact: true })
    .fill('0.2');
  await page
    .getByRole('spinbutton', { name: 'Brush plane distance tolerance', exact: true })
    .press('Enter');
  await paint(page, 'moving');
  await page.getByRole('button', { name: 'Next: paint target', exact: true }).click();
  await paint(page, 'target');
  await page.getByRole('button', { name: 'Finish pair', exact: true }).click();
  const opposing = page.getByRole('switch', { name: 'Opposing face normals', exact: true });
  if ((await opposing.getAttribute('aria-checked')) === 'true') await opposing.click();
  await page.getByRole('switch', { name: 'Keep plane constraints active', exact: true }).click();
  await page.screenshot({ path: '/tmp/kitbasher-cad-plane-controls-desktop.png' });
  await page.getByRole('button', { name: 'Create plane constraints', exact: true }).click();
  expect((await state(page)).constraints).toHaveLength(1);
  await page.keyboard.press('v');
  await page.locator('.part-select[title="Target plate"]').click();
  const z = page.getByRole('spinbutton', { name: 'Position Z', exact: true });
  await z.fill('8');
  await z.press('Enter');
  expect((await state(page)).parts[0].position[2]).toBeCloseTo(8, 5);
  await page.getByRole('button', { name: /^Constraints\s+1$/ }).click();
  const offset = page.getByRole('spinbutton', { name: /^Offset for / });
  await offset.fill('2');
  await offset.press('Enter');
  expect((await state(page)).parts[0].position[2]).toBeCloseTo(10, 5);
  await page.screenshot({ path: '/tmp/kitbasher-cad-constraints-desktop.png' });
  const active = page.getByRole('switch', { name: /^Enable / });
  await active.click();
  await z.fill('12');
  await z.press('Enter');
  expect((await state(page)).parts[0].position[2]).toBeCloseTo(10, 5);
  await active.click();
  expect((await state(page)).parts[0].position[2]).toBeCloseTo(14, 5);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const { scene: file, bytes } = await readSavedScene((await (await download).path())!);
  expect(file.constraints).toHaveLength(1);
  expect(file.constraints![0].offset).toBe(2);
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'saved.kitbash',
    mimeType: 'application/octet-stream',
    buffer: bytes,
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  expect((await state(page)).constraints).toEqual(file.constraints);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Show parts panel', exact: true }).click();
  await page.getByRole('button', { name: /^Constraints\s+1$/ }).click();
  await expect(page.getByRole('spinbutton', { name: /^Offset for / })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/kitbasher-cad-constraints-mobile.png' });
});

test('restores camera and gizmo after interrupting an object drag for navigation or focus loss', async ({
  page,
}) => {
  await openFixture(page, cube);
  const box = (await page.locator('canvas').boundingBox())!,
    cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  await page.getByRole('button', { name: 'Move (G)', exact: true }).click();
  await page.mouse.move(cx + 70, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy, { steps: 6 });
  expect((await state(page)).cameraEnabled).toBe(false);
  await page.keyboard.down('Space');
  await page.mouse.up();
  expect((await state(page)).cameraEnabled).toBe(true);
  await page.keyboard.up('Space');
  await page.keyboard.press('1');
  const before = await state(page);
  await page.mouse.move(cx + 70, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy, { steps: 6 });
  expect((await state(page)).parts).not.toEqual(before.parts);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  expect((await state(page)).cameraEnabled).toBe(true);
});

test('clips a real painted brush to its seed plane and prevents later strokes on disconnected coplanar faces', async ({
  page,
}) => {
  const positions: number[] = [];
  for (let x = -15; x < 15; x += 10) {
    const z = (v: number) => Math.max(0, v + 5) * 0.5;
    const a = [x, -5, z(x)],
      b = [x + 10, -5, z(x + 10)],
      c = [x + 10, 5, z(x + 10)],
      d = [x, 5, z(x)];
    positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  positions.push(-15, 7, 0, -5, 7, 0, -5, 15, 0, -15, 7, 0, -5, 15, 0, -15, 15, 0);
  const geometry = new BufferGeometry().setAttribute(
    'position',
    new BufferAttribute(new Float32Array(positions), 3),
  );
  geometry.computeVertexNormals();
  await openFixture(page, {
    ...plates,
    parts: [{ ...plates.parts[0], geometry: serializeGeometry(geometry) }, plates.parts[1]],
  });
  await page.keyboard.press('b');
  const radius = page.getByRole('spinbutton', { name: 'Brush radius', exact: true });
  await radius.fill('100');
  await radius.press('Enter');
  const filter = page.getByRole('switch', { name: 'Restrict brush to seed plane', exact: true });
  await filter.click();
  const angle = page.getByRole('spinbutton', { name: 'Brush plane angle tolerance', exact: true });
  await angle.fill('10');
  await angle.press('Enter');
  const tolerance = page.getByRole('spinbutton', {
    name: 'Brush plane distance tolerance',
    exact: true,
  });
  await tolerance.fill('0.1');
  await tolerance.press('Enter');
  await paint(page, 'moving', [-10, 0, 0]);
  expect((await state(page)).operation.surfacePairs[0].source!.faces).toEqual([0, 1]);
  await page.getByRole('button', { name: 'Clear this patch', exact: true }).click();
  await filter.click();
  await paint(page, 'moving', [-10, 0, 0]);
  const connected = (await state(page)).operation.surfacePairs[0].source!;
  expect(connected.faces).toEqual([0, 1, 2, 3, 4, 5]);
  await paint(page, 'moving', [-10, 11, 0]);
  expect((await state(page)).operation.surfacePairs[0].source).toEqual(connected);
  await page.getByRole('button', { name: 'Clear this patch', exact: true }).click();
  await paint(page, 'moving', [-10, 11, 0]);
  expect((await state(page)).operation.surfacePairs[0].source!.faces).toEqual([6, 7]);
});
