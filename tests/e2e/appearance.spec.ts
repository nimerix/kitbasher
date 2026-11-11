import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry, Color } from 'three';
import { serializeGeometry } from '../../src/core/geometry';
import { readSavedScene } from './saved-scene';

// Flow: editor colors from the inspector and display menu, distinct colors, scene lighting from
// the lighting panel, and light handles in the viewport. None of it reaches an export.
const box = serializeGeometry(new BoxGeometry(16, 16, 16));
const fixture = {
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Appearance bench',
  // The first two share a material color.
  parts: [
    { id: 'a', name: 'Left block', position: [-30, 30, 0], color: '#c7a48c' },
    { id: 'b', name: 'Middle block', position: [0, 30, 0], color: '#c7a48c' },
    { id: 'c', name: 'Right block', position: [30, 30, 0], color: '#6f8fb5' },
  ].map((part) => ({
    ...part,
    geometry: box,
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    visible: true,
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
  await expect(page.locator('canvas')).toBeVisible();
  await openScene(page, Buffer.from(JSON.stringify(fixture)));
  await frontView(page);
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

async function openScene(page: Page, buffer: Buffer) {
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'appearance.kitbash',
    mimeType: 'application/octet-stream',
    buffer,
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await expect(page.locator('.document-title')).toContainText(fixture.name);
}

/** Head-on and orthographic, so each sampled pixel looks straight at a front face. */
async function frontView(page: Page) {
  await page.locator('canvas').first().focus();
  await page.keyboard.press('1');
  await page.keyboard.press('5');
  await settled(page);
}

const settled = (page: Page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

async function deselect(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await editor(page)).selected).toEqual([]);
}

async function editor(page: Page) {
  return page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!;
    const { useEditor, sceneLighting } = await import(url);
    const state = useEditor.getState();
    return JSON.parse(
      JSON.stringify({
        parts: state.scene.parts.map((p: any) => ({
          id: p.id,
          color: p.color,
          displayColor: p.displayColor ?? null,
        })),
        mode: state.view.partColors,
        own: state.scene.lighting ?? null,
        lighting: sceneLighting(state),
        activeLight: state.activeLight,
        selected: state.selected,
        past: state.past.length,
      }),
    ) as {
      parts: { id: string; color: string; displayColor: string | null }[];
      mode: string;
      own: Lighting | null;
      lighting: Lighting;
      activeLight: string | null;
      selected: string[];
      past: number;
    };
  });
}

interface Lighting {
  exposure: number;
  lights: { id: string; kind: string; name: string; position: number[] }[];
}

/** The average color of a few pixels around a point given in a part's own coordinates. */
async function shade(page: Page, id: string, local = [-4, -4, 8]) {
  await settled(page);
  return page.evaluate(
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
      const ndc = mesh
        .localToWorld(root.camera.position.clone().fromArray(local))
        .project(root.camera);
      root.gl.render(root.scene, root.camera);
      const gl = root.gl.getContext();
      const pixels = new Uint8Array(5 * 5 * 4);
      gl.readPixels(
        Math.round(((ndc.x + 1) / 2) * gl.drawingBufferWidth) - 2,
        Math.round(((ndc.y + 1) / 2) * gl.drawingBufferHeight) - 2,
        5,
        5,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      const sum = [0, 0, 0];
      for (let i = 0; i < pixels.length; i += 4)
        for (let c = 0; c < 3; c++) sum[c] += pixels[i + c];
      return sum.map((value) => value / 25);
    },
    { id, local },
  );
}

const difference = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const luminance = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Where a world point lands on the page. */
async function screenPoint(page: Page, point: number[]) {
  const canvas = (await page.locator('canvas').first().boundingBox())!;
  const ndc = await page.evaluate(async (point) => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => url.includes('/@react-three_fiber.js'))!;
    const root = (await import(url))._roots.get(document.querySelector('canvas')).store.getState();
    return root.camera.position.clone().fromArray(point).project(root.camera).toArray();
  }, point);
  return {
    x: canvas.x + ((ndc[0] + 1) * canvas.width) / 2,
    y: canvas.y + ((1 - ndc[1]) * canvas.height) / 2,
  };
}

async function lightHandles(page: Page) {
  return page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => url.includes('/@react-three_fiber.js'))!;
    const root = (await import(url))._roots.get(document.querySelector('canvas')).store.getState();
    let count = 0;
    root.scene.traverse((object: any) => {
      if (object.userData.lightHandle) count++;
    });
    return count;
  });
}

const selectPart = (page: Page, name: string) =>
  page.locator(`.part-select[title="${name}"]`).click();

const undo = (page: Page) => page.getByRole('button', { name: /^Undo \((⌘|Ctrl)\+Z\)$/ }).click();

async function openDisplayMenu(page: Page) {
  await page.getByRole('button', { name: /^Display:/ }).click();
  const popover = page.getByRole('dialog', { name: 'Display' });
  await expect(popover).toBeVisible();
  return popover;
}

async function openLightingPanel(page: Page) {
  const popover = await openDisplayMenu(page);
  await popover.getByRole('button', { name: 'Edit lights…' }).click();
  await expect(popover).toHaveCount(0);
  const panel = page.getByRole('dialog', { name: 'Lighting' });
  await expect(panel).toBeVisible();
  return panel;
}

async function setNumber(page: Page, label: string, value: string) {
  const input = page.getByRole('spinbutton', { name: label, exact: true });
  await input.fill(value);
  await input.press('Enter');
}

test('an editor color paints the part in the viewport only and clears again', async ({ page }) => {
  const base = await shade(page, 'b');
  expect(difference(base, await shade(page, 'a'))).toBeLessThan(6);

  await selectPart(page, 'Middle block');
  const before = (await editor(page)).past;
  await page.getByLabel('Part editor color').fill('#2f6fe0');
  let state = await editor(page);
  expect(state.parts.find((p) => p.id === 'b')).toEqual({
    id: 'b',
    color: '#c7a48c',
    displayColor: '#2f6fe0',
  });
  expect(state.past).toBe(before + 1);
  await expect(page.locator('.editor-color')).toContainText('#2F6FE0');
  await expect(page.locator('.part-select[title="Middle block"] .part-swatch')).toHaveCSS(
    'background-color',
    'rgb(47, 111, 224)',
  );
  // The material tint is untouched.
  await expect(page.getByLabel('Part material color')).toHaveValue('#c7a48c');

  await deselect(page);
  const [r, g, b] = await shade(page, 'b');
  expect(b).toBeGreaterThan(r + 60);
  expect(b).toBeGreaterThan(g + 20);
  // Other parts keep their material color.
  expect(difference(await shade(page, 'a'), base)).toBeLessThan(6);

  await selectPart(page, 'Middle block');
  await page.getByRole('button', { name: 'Clear editor color', exact: true }).click();
  await expect(page.locator('.editor-color')).toContainText('None');
  await expect(page.getByLabel('Part editor color')).toBeFocused();
  state = await editor(page);
  expect(state.parts.find((p) => p.id === 'b')!.displayColor).toBeNull();
  await deselect(page);
  expect(difference(await shade(page, 'b'), base)).toBeLessThan(6);
});

test('distinct mode tells same-colored parts apart, material mode hides editor colors, and the mode is remembered', async ({
  page,
}) => {
  const display = page.getByRole('button', { name: /^Display:/ });
  await expect(display).toHaveAccessibleName('Display: Editor · Studio');
  const a = await shade(page, 'a');
  expect(difference(a, await shade(page, 'b'))).toBeLessThan(6);

  let popover = await openDisplayMenu(page);
  const modes = popover.getByRole('radiogroup', { name: 'Part colors' });
  await modes.getByRole('radio', { name: 'Distinct' }).click();
  await expect(modes.getByRole('radio', { name: 'Distinct' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(display).toHaveAccessibleName('Display: Distinct · Studio');
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  expect((await editor(page)).mode).toBe('distinct');
  const distinctA = await shade(page, 'a'),
    distinctB = await shade(page, 'b');
  expect(difference(distinctA, distinctB)).toBeGreaterThan(30);
  expect(difference(distinctA, a)).toBeGreaterThan(20);

  // An editor color wins over the distinct color, and material mode shows neither.
  await selectPart(page, 'Middle block');
  await page.getByLabel('Part editor color').fill('#2f6fe0');
  await deselect(page);
  expect((await shade(page, 'b'))[2]).toBeGreaterThan((await shade(page, 'b'))[0] + 60);
  popover = await openDisplayMenu(page);
  await popover.getByRole('radio', { name: 'Material' }).click();
  await page.keyboard.press('Escape');
  await expect(display).toHaveAccessibleName('Display: Material · Studio');
  expect(difference(await shade(page, 'b'), a)).toBeLessThan(6);
  expect(difference(await shade(page, 'a'), a)).toBeLessThan(6);
  expect((await editor(page)).parts.find((p) => p.id === 'b')!.displayColor).toBe('#2f6fe0');

  // The View menu offers the same modes.
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Material part colors' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Distinct part colors' }).click();
  await expect(display).toHaveAccessibleName('Display: Distinct · Studio');

  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('Recovered your local assembly')).toBeVisible();
  await expect(display).toHaveAccessibleName('Display: Distinct · Studio');
  expect((await editor(page)).mode).toBe('distinct');
  await frontView(page);
  expect(difference(await shade(page, 'a'), distinctA)).toBeLessThan(6);
  // The editor color comes back with the recovered scene.
  const recovered = await shade(page, 'b');
  expect(recovered[2]).toBeGreaterThan(recovered[0] + 60);
});

test('GLB export keeps material colors, never editor colors', async ({ page }) => {
  await selectPart(page, 'Middle block');
  await page.getByLabel('Part editor color').fill('#2f6fe0');
  await selectPart(page, 'Right block');
  await page.getByLabel('Part editor color').fill('#e0402f');
  const popover = await openDisplayMenu(page);
  await popover.getByRole('radio', { name: 'Distinct' }).click();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: /Blender \/ glTF/ }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export assembly', exact: true }).click();
  const buffer = await readFile((await (await downloading).path())!);
  expect(buffer.subarray(0, 4).toString()).toBe('glTF');
  expect(buffer.subarray(16, 20).toString()).toBe('JSON');
  const text = buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString('utf8');
  const gltf = JSON.parse(text);
  expect(text).not.toMatch(/displayColor|lighting/i);

  const linear = (hex: string) => new Color(hex).toArray();
  const exported = gltf.nodes
    .filter((node: any) => node.extras?.kitbasherId && node.mesh !== undefined)
    .map((node: any) => {
      const material = gltf.materials[gltf.meshes[node.mesh].primitives[0].material];
      return { id: node.extras.kitbasherId, color: material.pbrMetallicRoughness.baseColorFactor };
    });
  expect(exported.map((e: { id: string }) => e.id).sort()).toEqual(['a', 'b', 'c']);
  for (const { id, color } of exported) {
    const part = fixture.parts.find((p) => p.id === id)!;
    linear(part.color).forEach((value, i) => expect(color[i]).toBeCloseTo(value, 4));
  }
  for (const editorColor of ['#2f6fe0', '#e0402f'])
    for (const { color } of exported)
      expect(difference(color.slice(0, 3), linear(editorColor))).toBeGreaterThan(0.1);
});

test('lighting: brightness, point lights, undo, saving, and reset', async ({ page }) => {
  await selectPart(page, 'Middle block');
  await page.getByLabel('Part editor color').fill('#2f6fe0');
  await deselect(page);
  const dim = luminance(await shade(page, 'a'));

  const panel = await openLightingPanel(page);
  await expect(panel).toContainText('Using your default lighting');
  await expect(panel.getByRole('button', { name: 'Reset to default' })).toBeDisabled();
  // The first light is ready to edit.
  await expect(panel.getByRole('button', { name: /^Key/, pressed: true })).toBeVisible();

  await panel.getByRole('slider', { name: 'Brightness' }).fill('1.6');
  let state = await editor(page);
  expect(state.own?.exposure).toBe(1.6);
  await expect(panel).toContainText('This scene has its own lighting');
  await expect(page.getByRole('button', { name: /^Display:/ })).toHaveAccessibleName(
    'Display: Editor · Custom',
  );
  const bright = luminance(await shade(page, 'a'));
  expect(bright).toBeGreaterThan(dim + 10);
  const brightened = state.lighting;

  await panel.getByRole('button', { name: 'Add point' }).click();
  state = await editor(page);
  const point = state.lighting.lights.find((l) => l.kind === 'point')!;
  expect(point).toBeTruthy();
  expect(state.activeLight).toBe(point.id);
  await expect(panel.getByRole('heading', { name: 'Point light' })).toBeVisible();
  // Straight in front of the left block.
  await setNumber(page, 'Light position X', '-30');
  await setNumber(page, 'Light position Y', '30');
  await setNumber(page, 'Light position Z', '50');
  state = await editor(page);
  expect(state.lighting.lights.find((l) => l.id === point.id)!.position).toEqual([-30, 30, 50]);
  expect(luminance(await shade(page, 'a'))).toBeGreaterThan(bright + 5);
  // The point light and the three directional ones each have a handle.
  expect(await lightHandles(page)).toBe(4);

  // Three moves and the new light are four steps back.
  for (let i = 0; i < 4; i++) await undo(page);
  state = await editor(page);
  expect(state.lighting).toEqual(brightened);
  await expect(panel.getByRole('heading', { name: 'Point light' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /^Key/, pressed: true })).toBeVisible();
  expect(luminance(await shade(page, 'a'))).toBeCloseTo(bright, -1);

  // Lighting and editor colors travel with the scene file.
  await panel.getByRole('button', { name: 'Add point' }).click();
  await setNumber(page, 'Light position Z', '75');
  const saved = (await editor(page)).lighting;
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const { scene: file, bytes } = await readSavedScene((await (await downloading).path())!);
  expect(file.lighting).toEqual(saved);
  expect(file.parts.find((p) => p.id === 'b')!.displayColor).toBe('#2f6fe0');
  expect(file.parts.find((p) => p.id === 'b')!.color).toBe('#c7a48c');

  // Reset to default drops the scene's own lighting.
  await panel.getByRole('button', { name: 'Reset to default' }).click();
  state = await editor(page);
  expect(state.own).toBeNull();
  expect(state.lighting.exposure).toBe(1);
  await expect(panel).toContainText('Using your default lighting');
  await expect(panel.getByRole('button', { name: 'Reset to default' })).toBeDisabled();
  expect(Math.abs(luminance(await shade(page, 'a')) - dim)).toBeLessThan(3);

  await openScene(page, bytes);
  state = await editor(page);
  expect(state.own).toEqual(saved);
  expect(state.parts.find((p) => p.id === 'b')!.displayColor).toBe('#2f6fe0');
  await expect(panel).toContainText('This scene has its own lighting');
  await panel.getByRole('button', { name: 'Reset to default' }).click();
  expect((await editor(page)).own).toBeNull();
});

test('clicking a light handle picks that light without touching the part selection', async ({
  page,
}) => {
  const panel = await openLightingPanel(page);
  await panel.getByRole('button', { name: 'Add point' }).click();
  // In front of the middle block, so a click that fell through would select it.
  await setNumber(page, 'Light position X', '0');
  await setNumber(page, 'Light position Y', '30');
  await setNumber(page, 'Light position Z', '20');
  const point = (await editor(page)).activeLight!;
  expect((await editor(page)).lighting.lights.find((l) => l.id === point)!.position).toEqual([
    0, 30, 20,
  ]);

  // The right block's own gizmo points away from the handle.
  for (const selection of [[], ['c']]) {
    if (selection.length) await selectPart(page, 'Right block');
    await panel.getByRole('button', { name: /^Key/ }).click();
    expect((await editor(page)).activeLight).not.toBe(point);
    await settled(page);
    const handle = await screenPoint(page, [0, 30, 20]);
    await page.mouse.click(handle.x, handle.y);
    await expect.poll(async () => (await editor(page)).activeLight).toBe(point);
    expect((await editor(page)).selected).toEqual(selection);
    await expect(panel.getByRole('button', { name: /^Point 1/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(panel.getByRole('heading', { name: 'Point light' })).toBeVisible();
  }

  // Closing the panel takes the handles away.
  await panel.getByRole('button', { name: 'Close lighting' }).click();
  await expect(panel).toHaveCount(0);
  await settled(page);
  expect(await lightHandles(page)).toBe(0);
});
