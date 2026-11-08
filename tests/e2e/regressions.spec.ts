import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry, Vector3 } from 'three';
import { serializeGeometry } from '../../src/core/geometry';
import { readSavedScene } from './saved-scene';

const box = serializeGeometry(new BoxGeometry(16, 16, 16));
const part = (id: string, name: string, position: number[], extra: object = {}) => ({
  id,
  name,
  geometry: box,
  position,
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#c7a48c',
  visible: true,
  locked: false,
  source: 'test',
  ...extra,
});
const scene = (parts: ReturnType<typeof part>[], extra: object = {}) => ({
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Regression bench',
  parts,
  joints: [],
  ...extra,
});
const sideBySide = () =>
  scene([part('a', 'Moving piece', [-14, 30, 0]), part('b', 'Target piece', [14, 30, 0])]);

const browserErrors = new WeakMap<Page, string[]>();
let expectCrash = false;

test.beforeEach(async ({ page }) => {
  expectCrash = false;
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  if (!expectCrash) expect(browserErrors.get(page)).toEqual([]);
});

async function state(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const fiber = await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!);
    const root = fiber._roots.get(document.querySelector('canvas')).store.getState();
    const s = useEditor.getState();
    const camera = root.camera;
    return {
      selected: s.selected as string[],
      past: s.past.length as number,
      future: s.future.length as number,
      name: s.scene.name as string,
      tool: s.tool as string,
      pivotPicking: s.pivotPicking as boolean,
      temporaryOrbit: s.temporaryOrbit as boolean,
      brushRadius: s.brushRadius as number,
      pending: !!s.operation.pending,
      painted: s.operation.surfacePairs.reduce(
        (sum: number, pair: { source: { faces: number[] } | null }) =>
          sum + (pair.source?.faces.length ?? 0),
        0,
      ) as number,
      parts: s.scene.parts.map(
        (p: { id: string; name: string; color: string; position: number[] }) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          position: p.position,
        }),
      ),
      camera: {
        position: camera.position.toArray() as [number, number, number],
        target: root.controls.target.toArray() as [number, number, number],
        orthographic: !!camera.isOrthographicCamera,
        height: (camera.isOrthographicCamera
          ? (camera.top - camera.bottom) / camera.zoom
          : 2 *
            camera.position.distanceTo(root.controls.target) *
            Math.tan((camera.fov * Math.PI) / 360)) as number,
      },
    };
  });
}

async function openFixture(page: Page, fixture: object) {
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'fixture.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

const settled = (page: Page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

async function screenPoint(page: Page, id: string, local: number[]) {
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

async function paint(page: Page, id: string, local: number[]) {
  const point = await screenPoint(page, id, local);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.up();
  await settled(page);
}

async function orbitView(page: Page) {
  const canvas = (await page.locator('canvas').boundingBox())!;
  const x = canvas.x + canvas.width * 0.5,
    y = canvas.y + canvas.height * 0.42;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 90, y + 35, { steps: 12 });
  await page.mouse.up();
  // Entering and leaving a camera tool settles orbit damping.
  await page.keyboard.press('h');
  await page.keyboard.press('Escape');
  await settled(page);
}

const expectClose = (actual: number[], expected: number[], precision = 4) =>
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], precision));

test('hidden parts do not intercept viewport clicks', async ({ page }) => {
  await openFixture(
    page,
    scene([part('front', 'Front piece', [0, 30, 30]), part('back', 'Back piece', [0, 30, 0])]),
  );
  await page.keyboard.press('1');
  await settled(page);
  const point = await screenPoint(page, 'back', [0, 0, 8]);
  await page.mouse.click(point.x, point.y);
  expect((await state(page)).selected).toEqual(['front']);
  await page.getByRole('button', { name: 'Hide Front piece', exact: true }).click();
  await settled(page);
  await page.mouse.click(point.x, point.y);
  expect((await state(page)).selected).toEqual(['back']);
});

test('the custom pivot marker follows the selection', async ({ page }) => {
  await openFixture(
    page,
    scene([
      part('a', 'Pivot piece', [-14, 30, 0], { pivot: [0, 0, 8] }),
      part('b', 'Plain piece', [14, 30, 0]),
    ]),
  );
  await page.locator('.part-select[title="Pivot piece"]').click();
  await expect(page.locator('.pivot-label')).toHaveCount(1);
  await page.locator('.part-select[title="Plain piece"]').click();
  await expect(page.locator('.pivot-label')).toHaveCount(0);
  await page.locator('.part-select[title="Pivot piece"]').click();
  await expect(page.locator('.pivot-label')).toHaveCount(1);
});

test('resizing the viewport keeps the current camera view', async ({ page }) => {
  await page.keyboard.press('1');
  await settled(page);
  await orbitView(page);
  const before = (await state(page)).camera;
  const width = (await page.locator('canvas').boundingBox())!.width;
  await page.getByRole('button', { name: 'Hide inspector', exact: true }).click();
  await expect
    .poll(async () => (await page.locator('canvas').boundingBox())!.width)
    .toBeGreaterThan(width);
  await settled(page);
  const after = (await state(page)).camera;
  expectClose(after.position, before.position);
  expectClose(after.target, before.target);
});

test('switching projection keeps the view direction and scale', async ({ page }) => {
  await orbitView(page);
  const perspective = (await state(page)).camera;
  const direction = (camera: typeof perspective) =>
    new Vector3(...camera.position)
      .sub(new Vector3(...camera.target))
      .normalize()
      .toArray();
  await page.keyboard.press('5');
  await expect(page.getByRole('button', { name: 'Orthographic', exact: true })).toBeVisible();
  await settled(page);
  const orthographic = (await state(page)).camera;
  expect(orthographic.orthographic).toBe(true);
  expectClose(orthographic.target, perspective.target);
  expectClose(direction(orthographic), direction(perspective));
  expect(orthographic.height / perspective.height).toBeCloseTo(1, 2);
  await page.keyboard.press('5');
  await expect(page.getByRole('button', { name: 'Perspective', exact: true })).toBeVisible();
  await settled(page);
  const restored = (await state(page)).camera;
  expect(restored.orthographic).toBe(false);
  expectClose(restored.target, perspective.target);
  expectClose(direction(restored), direction(perspective));
  expect(restored.height / perspective.height).toBeCloseTo(1, 2);
});

test('keyboard-focused buttons activate with Space and Enter', async ({ page }) => {
  const snap = page.locator('.snap-toggle');
  await page.getByRole('button', { name: 'Measure distance (D)', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(snap).toBeFocused();
  await page.keyboard.press('Space');
  await expect(snap).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Enter');
  await expect(snap).toHaveAttribute('aria-pressed', 'false');
  expect((await state(page)).temporaryOrbit).toBe(false);

  await page.locator('.part-select[title="Torso shell"]').click();
  await page.keyboard.press('a');
  await page.getByRole('combobox', { name: 'Target part or plane', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Reset', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast-error')).toHaveCount(0);
});

test('Space still orbits after a mouse click leaves focus on a button', async ({ page }) => {
  const snap = page.locator('.snap-toggle');
  await snap.click();
  await expect(snap).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.down('Space');
  expect((await state(page)).temporaryOrbit).toBe(true);
  await page.keyboard.up('Space');
  await settled(page);
  expect((await state(page)).temporaryOrbit).toBe(false);
  await expect(snap).toHaveAttribute('aria-pressed', 'true');
});

test('repeating a tool shortcut keeps unfinished alignment work', async ({ page }) => {
  await openFixture(page, sideBySide());
  await page.locator('.part-select[title="Moving piece"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('b');
  await settled(page);
  await paint(page, 'a', [0, 0, 8]);
  const painted = (await state(page)).painted;
  expect(painted).toBeGreaterThan(0);
  await page.keyboard.press('b');
  expect((await state(page)).painted).toBe(painted);
  await page.keyboard.press('a');
  expect((await state(page)).painted).toBe(painted);
  await page.locator('.paint-tool').click();
  expect((await state(page)).painted).toBe(painted);
  await page.getByRole('button', { name: 'Paint contact surfaces', exact: true }).click();
  expect((await state(page)).painted).toBe(painted);

  await page.keyboard.press('Escape');
  await page.keyboard.press('a');
  await page.getByRole('button', { name: 'Point to point', exact: true }).click();
  const point = await screenPoint(page, 'a', [0, 0, 8]);
  await page.mouse.click(point.x, point.y);
  expect((await state(page)).pending).toBe(true);
  await page.keyboard.press('a');
  expect((await state(page)).pending).toBe(true);
  await page.getByRole('button', { name: 'Point to point', exact: true }).click();
  expect((await state(page)).pending).toBe(true);
});

test('exporting selected parts writes a scene that can be reopened', async ({ page }) => {
  await openFixture(
    page,
    scene(
      [
        part('a', 'Moving piece', [-14, 30, 0]),
        part('b', 'Target piece', [14, 30, 0]),
        part('c', 'Other piece', [40, 30, 0]),
      ],
      {
        constraints: [
          {
            id: 'mate',
            name: 'Mate',
            sourceId: 'a',
            targetId: 'b',
            sourcePlane: { point: [8, 0, 0], normal: [1, 0, 0] },
            targetPlane: { point: [-8, 0, 0], normal: [-1, 0, 0] },
            kind: 'mate',
            angle: 0,
            offset: 12,
            opposed: true,
            enabled: true,
          },
        ],
      },
    ),
  );
  await page.locator('.part-select[title="Moving piece"]').click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.locator('.export-format', { hasText: 'Kitbasher scene' }).click();
  await page.getByRole('combobox', { name: 'Export scope', exact: true }).selectOption('selected');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export assembly' }).click();
  const { scene: file, bytes } = await readSavedScene((await (await download).path())!);
  expect(file.parts.map((p: { id: string }) => p.id)).toEqual(['a']);
  expect(file.constraints).toEqual([]);
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'subset.kitbash',
    mimeType: 'application/octet-stream',
    buffer: bytes,
  });
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeVisible();
  await expect(page.locator('.toast-error')).toHaveCount(0);
});

test('no-op renames leave history alone and Escape cancels them', async ({ page }) => {
  await openFixture(page, sideBySide());
  await page.locator('.part-select[title="Moving piece"]').click();
  const x = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await x.fill('5');
  await x.press('Enter');
  await page.getByRole('button', { name: 'Undo (Ctrl/⌘ Z)', exact: true }).click();
  const before = await state(page);
  expect(before.future).toBe(1);

  await page.locator('.document-title button').click();
  await page.getByRole('textbox', { name: 'Assembly name', exact: true }).press('Enter');
  let current = await state(page);
  expect(current.past).toBe(before.past);
  expect(current.future).toBe(1);

  await page.locator('.document-title button').click();
  await page.getByRole('textbox', { name: 'Assembly name', exact: true }).fill('Changed');
  await page.getByRole('textbox', { name: 'Assembly name', exact: true }).press('Escape');
  current = await state(page);
  expect(current.name).toBe('Regression bench');
  expect(current.future).toBe(1);

  await page.locator('.part-name-button').click();
  await page.getByRole('textbox', { name: 'Part name', exact: true }).press('Enter');
  current = await state(page);
  expect(current.past).toBe(before.past);
  expect(current.future).toBe(1);

  await page.locator('.part-name-button').click();
  await page.getByRole('textbox', { name: 'Part name', exact: true }).fill('Renamed');
  await page.getByRole('textbox', { name: 'Part name', exact: true }).press('Escape');
  current = await state(page);
  expect(current.parts[0].name).toBe('Moving piece');
  expect(current.future).toBe(1);
});

test('one color picker session is one undo step', async ({ page }) => {
  await openFixture(page, sideBySide());
  await page.locator('.part-select[title="Moving piece"]').click();
  const before = await state(page);
  const pick = (colors: string[]) =>
    page.getByLabel('Part material color').evaluate((element, colors) => {
      const input = element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      for (const color of colors) {
        setter.call(input, color);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, colors);
  await pick(['#112233', '#223344', '#334455']);
  let current = await state(page);
  expect(current.parts[0].color).toBe('#334455');
  expect(current.past).toBe(before.past + 1);
  await pick(['#445566', '#556677']);
  current = await state(page);
  expect(current.past).toBe(before.past + 2);
  await page.getByRole('button', { name: 'Undo (Ctrl/⌘ Z)', exact: true }).click();
  expect((await state(page)).parts[0].color).toBe('#334455');
  await page.getByRole('button', { name: 'Undo (Ctrl/⌘ Z)', exact: true }).click();
  expect((await state(page)).parts[0].color).toBe('#c7a48c');
});

test('toolbar undo reverts the last paint stroke like the shortcut', async ({ page }) => {
  await openFixture(page, sideBySide());
  await page.locator('.part-select[title="Moving piece"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('b');
  await settled(page);
  await paint(page, 'a', [0, 0, 8]);
  expect((await state(page)).painted).toBeGreaterThan(0);
  const undo = page.getByRole('button', { name: 'Undo (Ctrl/⌘ Z)', exact: true });
  await expect(undo).toBeEnabled();
  await undo.click();
  const current = await state(page);
  expect(current.tool).toBe('align');
  expect(current.painted).toBe(0);
});

test('pressing the gizmo without dragging leaves history and redo intact', async ({ page }) => {
  await page.locator('.part-select[title="Torso shell"]').click();
  const x = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await x.fill('12');
  await x.press('Enter');
  await page.getByRole('button', { name: 'Undo (Ctrl/⌘ Z)', exact: true }).click();
  await expect(x).toHaveValue('0');
  await page.getByRole('button', { name: 'Move (G)', exact: true }).click();
  await settled(page);
  const before = await state(page);
  const canvas = (await page.locator('canvas').boundingBox())!;
  await page.mouse.move(canvas.x + canvas.width * 0.578, canvas.y + canvas.height * 0.425);
  await page.mouse.down();
  await page.mouse.up();
  let current = await state(page);
  expect(current.past).toBe(before.past);
  expect(current.future).toBe(before.future);

  // The same handle does drag, and that whole drag is a single undo step.
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width * 0.635, canvas.y + canvas.height * 0.435, {
    steps: 12,
  });
  await page.mouse.up();
  await expect(x).not.toHaveValue('0');
  current = await state(page);
  expect(current.past).toBe(before.past + 1);
  expect(current.future).toBe(0);
  await page.getByRole('button', { name: 'Undo (Ctrl/⌘ Z)', exact: true }).click();
  await expect(x).toHaveValue('0');
});

test('mirrored parts can be moved with the gizmo', async ({ page }) => {
  await openFixture(page, scene([part('mirror', 'Mirrored', [0, 30, 0], { scale: [-1, 1, 1] })]));
  await page.locator('.part-select[title="Mirrored"]').click();
  await page.keyboard.press('1');
  await page.getByRole('button', { name: 'Move (G)', exact: true }).click();
  await settled(page);
  const canvas = (await page.locator('canvas').boundingBox())!,
    cx = canvas.x + canvas.width / 2,
    cy = canvas.y + canvas.height / 2;
  await page.mouse.move(cx + 70, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 115, cy, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).not.toHaveValue(
    '0',
  );
});

test('dropped files are not queued again for the next import', async ({ page }) => {
  const stl =
    'solid a\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid a\n';
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.items.add(new File([text], 'dropped.stl'));
    document
      .querySelector('.workbench')!
      .dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }),
      );
  }, stl);
  await expect(page.getByText('1 file selected')).toBeVisible();
  await page.getByRole('button', { name: 'Import parts', exact: true }).last().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Control+i');
  await expect(page.getByText('Drop your models here')).toBeVisible();
});

test('the import picker can choose the same file again', async ({ page }) => {
  await page.keyboard.press('Control+i');
  const input = page.getByLabel('Choose model files');
  await input.setInputFiles({ name: 'a.stl', mimeType: 'model/stl', buffer: Buffer.from('x') });
  await expect(page.getByText('1 file selected')).toBeVisible();
  expect(await input.inputValue()).toBe('');
});

test('brush radius accepts typed decimals', async ({ page }) => {
  await openFixture(page, sideBySide());
  await page.locator('.part-select[title="Moving piece"]').click();
  await page.keyboard.press('b');
  const radius = page.getByRole('spinbutton', { name: 'Brush radius', exact: true });
  await radius.click();
  await radius.press('ControlOrMeta+a');
  await radius.pressSequentially('0.5');
  await radius.press('Enter');
  expect((await state(page)).brushRadius).toBe(0.5);
});

test('the editor works where crypto.randomUUID is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    delete (Crypto.prototype as Partial<Crypto>).randomUUID;
  });
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.locator('.part-select[title="Torso shell"]').click();
  await page.keyboard.press('ControlOrMeta+d');
  await expect.poll(async () => (await state(page)).parts.length).toBe(16);
  await page.keyboard.press('b');
  await expect(page.getByRole('combobox', { name: 'Surface relationship' })).toBeVisible();
});

test('menus close with Escape and outside clicks without changing the tool', async ({ page }) => {
  await page.locator('.part-select[title="Torso shell"]').click();
  await page.getByRole('button', { name: 'Move (G)', exact: true }).click();
  const file = page.locator('.app-menu > button', { hasText: 'File' });
  await expect(file).toHaveAttribute('aria-expanded', 'false');
  await file.click();
  await expect(file).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.dropdown-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dropdown-menu')).toHaveCount(0);
  expect((await state(page)).tool).toBe('translate');

  const view = page.locator('.view-selector > button');
  await view.click();
  await expect(page.locator('.view-menu')).toBeVisible();
  await page.locator('.statusbar').click();
  await expect(page.locator('.view-menu')).toHaveCount(0);
  await view.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.view-menu')).toHaveCount(0);
  expect((await state(page)).tool).toBe('translate');
});

test('only toggle buttons expose a pressed state', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Move (G)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  for (const name of ['Help and keyboard shortcuts', 'Zoom in', 'Frame all (Home)'])
    await expect(page.getByRole('button', { name, exact: true })).not.toHaveAttribute(
      'aria-pressed',
      /.*/,
    );
});

test('holding a toggle shortcut does not flicker it', async ({ page }) => {
  await page.keyboard.down('p');
  await page.keyboard.down('p');
  await page.keyboard.down('p');
  await page.keyboard.down('p');
  await page.keyboard.up('p');
  expect((await state(page)).pivotPicking).toBe(true);
});

test('a render failure offers recovery instead of a blank page', async ({ page }) => {
  expectCrash = true;
  const crash = async () => {
    await page.evaluate(async () => {
      const url = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!;
      const { useEditor } = await import(url);
      const scene = useEditor.getState().scene;
      useEditor.setState({ scene: { ...scene, parts: [{ id: 'broken', name: 'Broken' }] } });
    });
    await expect(page.getByRole('alert')).toContainText('Something went wrong');
  };
  await openFixture(page, sideBySide());
  // Autosave is debounced, so let the opened scene reach IndexedDB.
  await page.waitForTimeout(1200);
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();

  await crash();
  await page.getByRole('button', { name: 'Reload Kitbasher', exact: true }).click();
  await expect(page.getByText('Recovered your local assembly')).toBeVisible();
  await expect(page.locator('.part-select[title="Moving piece"]')).toBeVisible();

  await crash();
  await page.getByRole('button', { name: 'Discard local save and reload', exact: true }).click();
  await expect(page.locator('.part-select[title="Torso shell"]')).toBeVisible();
  await expect(page.getByText('Recovered your local assembly')).toHaveCount(0);
});
