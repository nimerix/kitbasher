import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';

// A 20 mm block whose front face, at z = 10 in the world, is painted and warped.
const fixture = {
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Warp strokes',
  joints: [],
  parts: [
    {
      id: 'block',
      name: 'Scanned block',
      position: [0, 10, 0],
      color: '#d4a272',
      geometry: serializeGeometry(new BoxGeometry(20, 20, 20, 40, 40, 40)),
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      visible: true,
      locked: false,
      source: 'test',
    },
  ],
};

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

async function state(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const fiber = await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!);
    const root = fiber._roots.get(document.querySelector('canvas')).store.getState();
    const editor = useEditor.getState(),
      warp = editor.warp;
    return {
      stage: (warp?.stage ?? null) as string | null,
      region: (warp?.faces.length ?? 0) as number,
      paintHistory: editor.paintHistory.length as number,
      handles: (warp?.points ?? []).map((point: any) => ({
        id: point.id as string,
        kind: point.kind as string,
        samples: point.samples.length as number,
        faces: (point.faces?.length ?? 0) as number,
        at: (point.target ?? point.pin) as number[],
        moved: point.target !== null,
      })),
      selected: (warp?.selectedPoints ?? []) as string[],
      undo: (warp?.undo.length ?? 0) as number,
      camera: root.camera.position.toArray() as number[],
      controls: root.controls.enabled as boolean,
    };
  });
}

/** Screen position of a world point. */
async function screen(page: Page, world: number[]) {
  const box = (await page.locator('canvas').boundingBox())!;
  const ndc = await page.evaluate(async (world) => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => url.includes('/@react-three_fiber.js'))!;
    const root = (await import(url))._roots.get(document.querySelector('canvas')).store.getState();
    return root.camera.position.clone().fromArray(world).project(root.camera).toArray();
  }, world);
  return { x: box.x + ((ndc[0] + 1) * box.width) / 2, y: box.y + ((1 - ndc[1]) * box.height) / 2 };
}

/** Screen position of an arrow of the move gizmo on the selected handle. */
async function moveHandle(page: Page, axis: 'X' | 'Y' | 'Z') {
  const box = (await page.locator('canvas').boundingBox())!;
  const ndc = await page.evaluate(async (axis) => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => url.includes('/@react-three_fiber.js'))!;
    const root = (await import(url))._roots.get(document.querySelector('canvas')).store.getState();
    let controls: any;
    root.scene.traverse((object: any) => {
      if (object.isTransformControls && object.visible) controls = object;
    });
    const handle = controls.gizmo.picker.translate.children.find((o: any) => o.name === axis);
    handle.geometry.computeBoundingBox();
    const point = handle.geometry.boundingBox.getCenter(root.camera.position.clone());
    handle.localToWorld(point);
    return point.project(root.camera).toArray();
  }, axis);
  return { x: box.x + ((ndc[0] + 1) * box.width) / 2, y: box.y + ((1 - ndc[1]) * box.height) / 2 };
}

/** Opens the block, paints most of its front face and lays the grid. */
async function warpFront(page: Page) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'strokes.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Scanned block"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page.keyboard.press('w');
  const radius = page.getByRole('spinbutton', { name: 'Brush radius', exact: true });
  await radius.fill('8.5');
  await radius.press('Enter');
  const centre = await screen(page, [0, 10, 10]);
  await page.mouse.click(centre.x, centre.y);
  await page.getByRole('button', { name: 'Lay grid', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Line', exact: true })).toBeVisible();
}

/** Drags with the primary button through world points, in `steps` pointer moves per leg. */
async function drag(page: Page, through: number[][], steps = 12) {
  const spots = await Promise.all(through.map((point) => screen(page, point)));
  await page.mouse.move(spots[0].x, spots[0].y);
  await page.mouse.down();
  for (const spot of spots.slice(1)) await page.mouse.move(spot.x, spot.y, { steps });
  await page.mouse.up();
}

test('a line drawn on the surface makes one handle without moving the camera', async ({ page }) => {
  await warpFront(page);
  await page.getByRole('radio', { name: 'Line', exact: true }).click();
  await expect(page.locator('.warp-add')).toContainText('Drag on the surface to draw a line.');
  await expect(page.locator('.statusbar')).toContainText('Drag on the surface to draw a line');
  const before = await state(page);
  await drag(page, [
    [-5, 8, 10],
    [5, 11, 10],
  ]);
  const drawn = await state(page);
  expect(drawn.camera).toEqual(before.camera);
  expect(drawn.controls).toBe(true);
  expect(drawn.handles).toHaveLength(before.handles.length + 1);
  const line = drawn.handles.at(-1)!;
  expect(line.kind).toBe('line');
  expect(line.samples).toBeGreaterThan(3);
  expect(drawn.selected).toEqual([line.id]);
  expect(drawn.undo).toBe(before.undo + 1);

  // A short stroke makes nothing, and the click that ends it adds no point.
  const near = await screen(page, [0, 6, 10]);
  await page.mouse.move(near.x, near.y);
  await page.mouse.down();
  await page.mouse.move(near.x + 2, near.y + 1);
  await page.mouse.up();
  const short = await state(page);
  expect(short.handles).toHaveLength(drawn.handles.length);
  expect(short.selected).toEqual(drawn.selected);
  expect(short.undo).toBe(drawn.undo);

  // A click on the surface in Line mode adds nothing either.
  await page.mouse.click(near.x, near.y);
  expect((await state(page)).handles).toHaveLength(drawn.handles.length);

  // Escape and losing the window discard a stroke in progress.
  for (const interrupt of [
    () => page.keyboard.press('Escape'),
    () => page.evaluate(() => window.dispatchEvent(new Event('blur'))),
  ]) {
    const [from, to] = [await screen(page, [-5, 4, 10]), await screen(page, [4, 4, 10])];
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await interrupt();
    await page.mouse.up();
    const after = await state(page);
    expect(after.handles).toHaveLength(drawn.handles.length);
    expect(after.stage).toBe('warp');
    expect(after.controls).toBe(true);
    expect(after.camera).toEqual(before.camera);
  }
});

test('middle drag and Space drag still navigate in Line and Area mode', async ({ page }) => {
  await warpFront(page);
  for (const mode of ['Line', 'Area']) {
    await page.getByRole('radio', { name: mode, exact: true }).click();
    const start = await state(page);
    const [from, to] = [await screen(page, [-4, 10, 10]), await screen(page, [4, 12, 10])];
    await page.mouse.move(from.x, from.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up({ button: 'middle' });
    const middle = await state(page);
    expect(middle.camera).not.toEqual(start.camera);
    expect(middle.handles).toHaveLength(start.handles.length);

    await page.keyboard.down('Space');
    await page.mouse.move(to.x, to.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    const space = await state(page);
    expect(space.camera).not.toEqual(middle.camera);
    expect(space.handles).toHaveLength(start.handles.length);
    await page.keyboard.press('1');
    await page.keyboard.press('Home');
  }
});

test('a press on a marker or the gizmo selects or drags it and starts no stroke', async ({
  page,
}) => {
  await warpFront(page);
  await page.getByRole('radio', { name: 'Line', exact: true }).click();
  await drag(page, [
    [-5, 8, 10],
    [5, 8, 10],
  ]);
  await drag(page, [
    [-5, 13, 10],
    [5, 13, 10],
  ]);
  const two = await state(page);
  expect(two.handles).toHaveLength(2);
  expect(two.selected).toEqual([two.handles[1].id]);

  // Pressing on the first line's marker and letting go selects it.
  const marker = await screen(page, two.handles[0].at);
  await page.mouse.move(marker.x, marker.y);
  await page.mouse.down();
  await page.mouse.move(marker.x + 3, marker.y + 1, { steps: 2 });
  await page.mouse.up();
  const picked = await state(page);
  expect(picked.handles).toHaveLength(2);
  expect(picked.selected).toEqual([two.handles[0].id]);

  // Dragging the gizmo moves the handle and draws nothing.
  const arrow = await moveHandle(page, 'X');
  await page.mouse.move(arrow.x, arrow.y);
  await page.mouse.down();
  await page.mouse.move(arrow.x + 40, arrow.y, { steps: 6 });
  await page.mouse.up();
  const moved = await state(page);
  expect(moved.handles).toHaveLength(2);
  expect(moved.handles[0].moved).toBe(true);
  expect(moved.handles[0].at[0]).toBeGreaterThan(two.handles[0].at[0] + 0.5);
  expect(moved.undo).toBe(picked.undo + 1);
  expect(moved.controls).toBe(true);
});

test('an area stroke leaves the region and its paint history alone', async ({ page }) => {
  await warpFront(page);
  await page.getByRole('radio', { name: 'Area', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Brush radius', exact: true })).toBeVisible();
  const before = await state(page);
  await drag(page, [
    [-3, 9, 10],
    [3, 10, 10],
  ]);
  const painted = await state(page);
  expect(painted.camera).toEqual(before.camera);
  expect(painted.handles).toHaveLength(before.handles.length + 1);
  const area = painted.handles.at(-1)!;
  expect(area.kind).toBe('area');
  expect(area.faces).toBeGreaterThan(10);
  expect(area.samples).toBeGreaterThanOrEqual(4);
  expect(painted.selected).toEqual([area.id]);
  expect(painted.region).toBe(before.region);
  expect(painted.paintHistory).toBe(before.paintHistory);
  expect(painted.undo).toBe(before.undo + 1);

  // Undo takes the whole area away.
  await page.keyboard.press('ControlOrMeta+z');
  expect((await state(page)).handles).toHaveLength(before.handles.length);
});

test('the first drag of a new line with the default radius lifts a smooth ridge', async ({
  page,
}) => {
  await warpFront(page);
  await page.getByRole('radio', { name: 'Line', exact: true }).click();
  await drag(page, [
    [-5, 9, 10],
    [5, 11, 10],
  ]);
  // Seen from the right, the move gizmo's Z arrow lies across the screen.
  await page.keyboard.press('3');
  const arrow = await moveHandle(page, 'Z');
  await page.mouse.move(arrow.x, arrow.y);
  await page.mouse.down();
  // Towards the front, past the block's face.
  const to = await screen(page, [0, 10, 12]);
  const from = await screen(page, [0, 10, 10]);
  await page.mouse.move(arrow.x + (to.x - from.x), arrow.y, { steps: 10 });
  await page.mouse.up();
  const ridge = await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const { facePoint } = await import(
      urls.find((url) => /\/src\/core\/warp-strokes\.ts(?:\?.*)?$/.test(url))!
    );
    const warp = useEditor.getState().warp;
    const line = warp.points.at(-1);
    const model = warp.model;
    const lift = line.target[2] - line.pin[2];
    // Each drawn spot along the line, as far as the written surface has moved it.
    const rises = line.path.map(
      (spot: any) =>
        facePoint(model, warp.output.positions, spot)[2] -
        facePoint(model, model.positions, spot)[2],
    );
    return { lift, rises, radius: line.radius };
  });
  expect(ridge.radius).toBeGreaterThan(0);
  expect(ridge.lift).toBeGreaterThan(1);
  // Between the line's ends the ridge stands at the lift, with no peak at any sample.
  const inner = ridge.rises.slice(
    Math.floor(ridge.rises.length * 0.1),
    Math.ceil(ridge.rises.length * 0.9),
  );
  for (const rise of inner) expect(Math.abs(rise - ridge.lift)).toBeLessThan(0.1 * ridge.lift);
  for (let i = 1; i < inner.length - 1; i++)
    expect(inner[i] - Math.min(inner[i - 1], inner[i + 1])).toBeLessThan(0.05 * ridge.lift);
});
