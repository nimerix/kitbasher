import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry, type BufferGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';

const part = (
  id: string,
  name: string,
  geometry: BufferGeometry,
  position: number[],
  color = '#d4a272',
) => ({
  id,
  name,
  position,
  color,
  geometry: serializeGeometry(geometry),
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  visible: true,
  locked: false,
  source: 'test',
});
const sceneOf = (parts: ReturnType<typeof part>[]) => ({
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Warp strokes',
  joints: [],
  parts,
});

// A 20 mm block whose front face, at z = 10 in the world, is painted and warped.
const block = part('block', 'Scanned block', new BoxGeometry(20, 20, 20, 40, 40, 40), [0, 10, 0]);
const fixture = sceneOf([block]);

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

/**
 * Opens a scene, by default the block, paints most of the front of the named part around a world
 * point and lays the grid.
 */
async function warpFront(
  page: Page,
  scene: object = fixture,
  name = 'Scanned block',
  at = [0, 10, 10],
) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'strokes.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scene)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator(`.part-select[title="${name}"]`).click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page.keyboard.press('w');
  const radius = page.getByRole('spinbutton', { name: 'Brush radius', exact: true });
  await radius.fill('8.5');
  await radius.press('Enter');
  const centre = await screen(page, at);
  await page.mouse.click(centre.x, centre.y);
  await page.getByRole('button', { name: 'Lay grid', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Line', exact: true })).toBeVisible();
}

/**
 * The world depth of the named part's written surface under a screen position, or null where the
 * pointer misses it or another part is in front.
 */
async function surfaceDepth(page: Page, spot: { x: number; y: number }, partId: string) {
  const box = (await page.locator('canvas').boundingBox())!;
  const ndc = [((spot.x - box.x) / box.width) * 2 - 1, 1 - ((spot.y - box.y) / box.height) * 2];
  return page.evaluate(
    async ({ ndc, partId }) => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const { useEditor } = await import(
        urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
      );
      const root = (
        await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!)
      )._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const { partMeshes } = await import(
        urls.find((url) => /\/src\/xr\/part-meshes\.ts(?:\?.*)?$/.test(url))!
      );
      const warp = useEditor.getState().warp;
      root.raycaster.setFromCamera({ x: ndc[0], y: ndc[1] }, root.camera);
      let nearest: any = null;
      for (const mesh of partMeshes.values()) {
        const hit = root.raycaster.intersectObject(mesh, false)[0];
        if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
      }
      const own = partMeshes.get(partId);
      return nearest && nearest.object === own && own.geometry === warp.preview
        ? (nearest.point.z as number)
        : null;
    },
    { ndc, partId },
  );
}

/** Drags with the primary button through world points, in `steps` pointer moves per leg. */
async function drag(page: Page, through: number[][], steps = 12) {
  const spots = await Promise.all(through.map((point) => screen(page, point)));
  await page.mouse.move(spots[0].x, spots[0].y);
  await page.mouse.down();
  for (const spot of spots.slice(1)) await page.mouse.move(spot.x, spot.y, { steps });
  await page.mouse.up();
}

/** Runs a function of the editor store in the page, given `args`. */
async function inStore<T>(page: Page, body: string, args: unknown = null): Promise<T> {
  return page.evaluate(
    async ({ body, args }) => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const store = await import(urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!);
      return new Function('store', 'args', body)(store, args);
    },
    { body, args },
  );
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

test('after undoing an added area, the radius field still edits the line selected before', async ({
  page,
}) => {
  await warpFront(page);
  await page.getByRole('radio', { name: 'Line', exact: true }).click();
  await drag(page, [
    [-5, 9, 10],
    [5, 11, 10],
  ]);
  const drawn = await state(page);
  const line = drawn.handles.at(-1)!;
  expect(drawn.selected).toEqual([line.id]);
  const field = page.getByRole('spinbutton', { name: 'Point radius', exact: true });
  const radiusOf = (id: string) =>
    inStore<number>(
      page,
      'return store.useEditor.getState().warp.points.find((p) => p.id === args).radius;',
      id,
    );
  await field.fill('3.3');
  await field.press('Enter');
  expect(await radiusOf(line.id)).toBe(3.3);

  await page.getByRole('radio', { name: 'Area', exact: true }).click();
  await drag(page, [
    [-3, 4, 10],
    [3, 5, 10],
  ]);
  const painted = await state(page);
  expect(painted.handles.at(-1)!.kind).toBe('area');
  expect(painted.selected).not.toContain(line.id);

  await page.keyboard.press('ControlOrMeta+z');
  const undone = await state(page);
  expect(undone.handles.map(({ id }: { id: string }) => id)).toEqual([line.id]);
  expect(undone.selected).toEqual([line.id]);
  await expect(page.locator('.warp-point-settings')).not.toContainText(
    'New points use this radius and falloff.',
  );
  await field.fill('6.6');
  await field.press('Enter');
  expect(await radiusOf(line.id)).toBe(6.6);
  expect((await state(page)).undo).toBe(undone.undo + 1);

  // With nothing selected the field sets what new handles take, and undo takes that back first.
  const empty = await screen(page, [16, 10, 10]);
  await page.mouse.click(empty.x, empty.y);
  expect((await state(page)).selected).toEqual([]);
  await expect(page.locator('.warp-point-settings')).toContainText(
    'New points use this radius and falloff.',
  );
  await field.fill('2');
  await field.press('Enter');
  const defaults = await state(page);
  expect(defaults.undo).toBe(undone.undo + 2);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await inStore<number>(page, 'return store.useEditor.getState().warp.pointRadius;')).toBe(
    6.6,
  );
  expect(await radiusOf(line.id)).toBe(6.6);
});

test('undo back to a feathered layout shows its feather, and laying it again changes nothing', async ({
  page,
}) => {
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
  const brush = page.getByRole('spinbutton', { name: 'Brush radius', exact: true });
  await brush.fill('6');
  await brush.press('Enter');
  const centre = await screen(page, [0, 10, 10]);
  await page.mouse.click(centre.x, centre.y);
  const feather = page.getByRole('switch', { name: 'Feather the painted edge', exact: true });
  const width = page.getByRole('spinbutton', { name: 'Feather width', exact: true });
  await feather.click();
  await width.fill('1.75');
  await width.press('Enter');
  const lay = page.getByRole('button', { name: 'Lay grid', exact: true });
  const edit = page.getByRole('button', { name: 'Edit region', exact: true });
  const laid = () => expect.poll(async () => (await state(page)).stage).toBe('warp');
  await lay.click();
  await laid();
  const laidWidth = () =>
    inStore<number | null>(
      page,
      'return store.useEditor.getState().warp.model.feather?.width ?? null;',
    );
  expect(await laidWidth()).toBe(1.75);
  await page.getByRole('radio', { name: 'Point', exact: true }).click();
  const spot = await screen(page, [2, 11, 10]);
  await page.mouse.click(spot.x, spot.y);
  for (let step = 0; step < 3; step++)
    await page.getByRole('button', { name: 'Move Z positive', exact: true }).click();

  // Feather off, laid again: a layout of its own.
  await edit.click();
  await feather.click();
  await expect(feather).toHaveAttribute('aria-checked', 'false');
  await lay.click();
  await laid();
  expect(await laidWidth()).toBeNull();

  await page.keyboard.press('ControlOrMeta+z');
  await laid();
  await expect.poll(laidWidth).toBe(1.75);
  await inStore(page, 'store.finishWarpSettling();');
  const written = () =>
    inStore<{ marked: boolean; undo: number; surface: number[] }>(
      page,
      `const warp = store.useEditor.getState().warp;
      const marked = warp.model.marked === true;
      warp.model.marked = true;
      return { marked, undo: warp.undo.length, surface: Array.from(warp.preview.getAttribute('position').array) };`,
    );
  const before = await written();
  await edit.click();
  await expect(feather).toHaveAttribute('aria-checked', 'true');
  await expect(width).toHaveValue('1.75');
  await lay.click();
  await laid();
  await inStore(page, 'store.finishWarpSettling();');
  const after = await written();
  // The same model, no new step and not a vertex moved.
  expect(after.marked).toBe(true);
  expect(after.undo).toBe(before.undo);
  expect(after.surface).toEqual(before.surface);
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
  await inStore(page, 'store.finishWarpSettling();');
  const lift = await inStore<number>(
    page,
    'const line = store.useEditor.getState().warp.points.at(-1); return line.target[2] - line.pin[2];',
  );
  const radius = await inStore<number>(
    page,
    'return store.useEditor.getState().warp.points.at(-1).radius;',
  );
  // Seen from the front again, each spot the pointer passed over is picked on screen and the
  // written surface found under it: the line's own record of itself plays no part.
  await page.keyboard.press('1');
  const rises: (number | null)[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const spot = await screen(page, [-5 + 10 * t, 9 + 2 * t, 10]);
    rises.push(await surfaceDepth(page, spot, 'block'));
  }
  expect(radius).toBeGreaterThan(0);
  expect(lift).toBeGreaterThan(1);
  const found = rises.flatMap((z) => (z === null ? [] : [z - 10]));
  expect(found.length).toBeGreaterThanOrEqual(38);
  // Both ends, and every spot between them, stand at the lift with no peak anywhere.
  expect(rises[0]).not.toBeNull();
  expect(rises.at(-1)).not.toBeNull();
  for (const rise of found) expect(Math.abs(rise - lift)).toBeLessThan(0.1 * lift);
  for (let i = 1; i < found.length - 1; i++)
    expect(found[i] - Math.min(found[i - 1], found[i + 1])).toBeLessThan(0.05 * lift);
});

test('at radius 0 the help says a point, a line or an area moves only the surface it lies on', async ({
  page,
}) => {
  await warpFront(page);
  const help = page.locator('.warp-point-settings > .anchor-help');
  const radius = page.getByRole('spinbutton', { name: 'Point radius', exact: true });
  const falloff = page.getByRole('spinbutton', { name: 'Point falloff', exact: true });
  const set = async (field: typeof radius, value: string) => {
    await field.fill(value);
    await field.press('Enter');
  };
  const plain = 'moves the surface it lies on, with nothing added around it.';
  // New handles take radius 0, so each is made with it.
  await set(radius, '0');
  const spot = await screen(page, [-6, 4, 10]);
  await page.mouse.click(spot.x, spot.y);
  await expect(help).toHaveText(`The selected point ${plain} New points use the same settings.`);
  await page.getByRole('radio', { name: 'Line', exact: true }).click();
  await drag(page, [
    [-5, 9, 10],
    [5, 11, 10],
  ]);
  await expect(help).toHaveText(`The selected line ${plain} New points use the same settings.`);
  await page.getByRole('radio', { name: 'Area', exact: true }).click();
  await drag(page, [
    [-3, 15, 10],
    [3, 16, 10],
  ]);
  await expect(help).toHaveText(`The selected area ${plain} New points use the same settings.`);
  const made = await state(page);
  expect(made.handles.map(({ kind }: { kind: string }) => kind)).toEqual(['point', 'line', 'area']);

  // With new points set apart, the text says what they take.
  const empty = await screen(page, [16, 10, 10]);
  await page.mouse.click(empty.x, empty.y);
  expect((await state(page)).selected).toEqual([]);
  await set(radius, '3.3');
  await set(falloff, '45');
  const select = (ids: string[]) =>
    inStore(page, 'store.useEditor.getState().selectWarpPoints(args);', ids);
  const [point, line, area] = made.handles.map(({ id }: { id: string }) => id);
  await select([line]);
  await expect(help).toHaveText(
    `The selected line ${plain} New points use a 3.3 mm radius and 45% falloff.`,
  );
  await select([point, area]);
  await expect(help).toHaveText(
    'The selected handles move the surface they lie on, with nothing added around them. New points use a 3.3 mm radius and 45% falloff.',
  );
});

test('a press on a part in front makes no handle on the part behind', async ({ page }) => {
  // An opaque cover 4 mm in front of the left of the block's painted face.
  const cover = part('cover', 'Cover', new BoxGeometry(8, 20, 1), [-6, 10, 14], '#3a4a5a');
  await warpFront(page, sceneOf([block, cover]));
  const before = await state(page);
  await page.getByRole('radio', { name: 'Area', exact: true }).click();
  const onCover = await screen(page, [-6, 10, 14.5]);
  await page.mouse.click(onCover.x, onCover.y);
  expect((await state(page)).handles).toHaveLength(before.handles.length);

  // A line pressed on the cover is no stroke, even once it comes out over the painted face.
  await page.getByRole('radio', { name: 'Line', exact: true }).click();
  const out = await screen(page, [5, 10, 10]);
  await page.mouse.move(onCover.x, onCover.y);
  await page.mouse.down();
  await page.mouse.move(onCover.x + 4, onCover.y, { steps: 2 });
  expect((await state(page)).controls).toBe(true);
  await page.mouse.move(out.x, out.y, { steps: 12 });
  expect((await state(page)).controls).toBe(true);
  await page.mouse.up();
  const after = await state(page);
  expect(after.handles).toHaveLength(before.handles.length);
  expect(after.undo).toBe(before.undo);

  // Beside the cover a press still draws.
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await drag(page, [
    [1, 8, 10],
    [7, 12, 10],
  ]);
  expect((await state(page)).handles).toHaveLength(before.handles.length + 1);
});

test('switching between Line and Area during a press discards the stroke', async ({ page }) => {
  await warpFront(page);
  for (const [from, to] of [
    ['line', 'area'],
    ['area', 'line'],
  ] as const) {
    await inStore(page, 'store.useEditor.getState().setWarpAdd(args);', from);
    const before = await state(page);
    const [a, b] = [await screen(page, [-5, 8, 10]), await screen(page, [5, 11, 10])];
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
    await inStore(page, 'store.useEditor.getState().setWarpAdd(args);', to);
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
    const after = await state(page);
    expect(after.handles, `${from} to ${to}`).toHaveLength(before.handles.length);
    expect(after.undo, `${from} to ${to}`).toBe(before.undo);
    expect(after.controls, `${from} to ${to}`).toBe(true);
  }
});

test('a stroke drops an Apply waiting for the surface to settle', async ({ page }) => {
  await warpFront(page);
  await page.getByRole('radio', { name: 'Line', exact: true }).click();
  await drag(page, [
    [-5, 13, 10],
    [5, 13, 10],
  ]);
  // The line is lifted and the surface set back to rest, so it settles again from there; idle
  // settling is held until the stroke below has begun.
  const geometry = await inStore<boolean>(
    page,
    `
    const { useEditor, finishWarpSettling } = store;
    const line = useEditor.getState().warp.points.at(-1);
    useEditor.getState().moveWarpPoints(
      [{ id: line.id, target: [line.pin[0], line.pin[1], line.pin[2] + 2] }],
      'end',
    );
    finishWarpSettling();
    const warp = useEditor.getState().warp;
    const rotations = new Float64Array(warp.state.rotations.length);
    for (let i = 3; i < rotations.length; i += 4) rotations[i] = 1;
    window.__held = [];
    window.__setTimeout = window.setTimeout;
    window.setTimeout = (run, ...rest) =>
      String(run).includes('stepWarpSettle')
        ? (window.__held.push(run), 0)
        : window.__setTimeout(run, ...rest);
    useEditor.setState({
      warp: { ...warp, state: { positions: warp.model.restNodes.slice(), rotations }, settling: true },
    });
    useEditor.getState().applyWarp();
    window.__geometry = useEditor.getState().scene.parts[0].geometry;
    return useEditor.getState().warp.applying;
  `,
  );
  expect(geometry).toBe(true);
  const [a, b] = [await screen(page, [-5, 7, 10]), await screen(page, [5, 7, 10])];
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, a.y, { steps: 6 });
  // Settling to the end while the stroke is held bakes nothing.
  const during = await inStore<{ applying: boolean; baked: boolean; handles: number }>(
    page,
    `
    const { useEditor, finishWarpSettling } = store;
    const applying = useEditor.getState().warp.applying;
    window.setTimeout = window.__setTimeout;
    for (const run of window.__held) run();
    finishWarpSettling();
    return {
      applying,
      baked: useEditor.getState().scene.parts[0].geometry !== window.__geometry,
      handles: useEditor.getState().warp.points.length,
    };
  `,
  );
  expect(during).toEqual({ applying: false, baked: false, handles: 1 });
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  const after = await state(page);
  expect(after.handles).toHaveLength(2);
  expect(after.handles[1].kind).toBe('line');
  expect(
    await inStore<boolean>(
      page,
      'return store.useEditor.getState().scene.parts[0].geometry === window.__geometry;',
    ),
  ).toBe(true);
});

/**
 * How much of the drawn lines of line and area handles shows, near the screen path through world
 * points and everywhere: the pixels they cover when they pass every depth test, and how many of
 * those look the same when they are drawn as they are, depth-tested against the surface.
 */
async function strokeShare(page: Page, path: number[][]) {
  return page.evaluate(async (path) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const root = (await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!))._roots
      .get(document.querySelector('canvas'))
      .store.getState();
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const { gl, scene, camera, size } = root;
    const lines: any[] = [];
    scene.traverse((object: any) => {
      if (object.visible && object.material?.isLineMaterial) lines.push(object);
    });
    const canvas = gl.domElement as HTMLCanvasElement;
    const { width, height } = canvas;
    const context = gl.getContext() as WebGL2RenderingContext;
    const read = () => {
      gl.setRenderTarget(null);
      gl.render(scene, camera);
      const pixels = new Uint8Array(width * height * 4);
      context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const shown = read();
    // Passing every depth test, still writing depth, so what is drawn after them is unchanged.
    const depthFunc = lines.map((line) => line.material.depthFunc);
    for (const line of lines) line.material.depthFunc = 1;
    const all = read();
    for (const line of lines) line.visible = false;
    const none = read();
    lines.forEach((line, i) => {
      line.visible = true;
      line.material.depthFunc = depthFunc[i];
    });
    root.invalidate();
    const ratio = width / size.width;
    const ends = path.map((p) => {
      const v = camera.position.clone().fromArray(p).project(camera);
      return [((v.x + 1) / 2) * width, ((v.y + 1) / 2) * height];
    });
    const near = (x: number, y: number) => {
      for (let i = 1; i < ends.length; i++) {
        const [ax, ay] = ends[i - 1],
          [bx, by] = ends[i];
        const ux = bx - ax,
          uy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * ux + (y - ay) * uy) / (ux * ux + uy * uy)));
        if (Math.hypot(x - ax - t * ux, y - ay - t * uy) <= 6 * ratio) return true;
      }
      return false;
    };
    const differ = (a: Uint8Array, b: Uint8Array, i: number) =>
      Math.max(
        Math.abs(a[i] - b[i]),
        Math.abs(a[i + 1] - b[i + 1]),
        Math.abs(a[i + 2] - b[i + 2]),
      ) > 16;
    const tally = { line: { drawn: 0, shown: 0 }, all: { drawn: 0, shown: 0 } };
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (!differ(all, none, i)) continue;
        const seen = differ(all, shown, i) ? 0 : 1;
        tally.all.drawn++;
        tally.all.shown += seen;
        if (near(x, y)) {
          tally.line.drawn++;
          tally.line.shown += seen;
        }
      }
    let length = 0;
    for (let i = 1; i < ends.length; i++)
      length += Math.hypot(ends[i][0] - ends[i - 1][0], ends[i][1] - ends[i - 1][1]) / ratio;
    return { ...tally, length };
  }, path);
}

/** Moves the camera along its line of sight until a CSS pixel at its target is `size` mm. */
async function pixelAt(page: Page, size: number) {
  await page.evaluate(async (size) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const root = (await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!))._roots
      .get(document.querySelector('canvas'))
      .store.getState();
    const { camera, controls } = root;
    const target = controls.target.clone();
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const distance = (size * root.size.height) / (2 * tan);
    camera.position.sub(target).setLength(distance).add(target);
    camera.lookAt(target);
    controls.update();
    root.invalidate();
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  }, size);
}

/**
 * Turns the camera about its target, by `degrees` about the vertical, half way round by default,
 * or about its own horizontal to look down across the surface.
 */
async function turnAround(page: Page, degrees = 180, tilt = false) {
  await page.evaluate(
    async ({ degrees, tilt }) => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const root = (
        await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!)
      )._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const { camera, controls } = root;
      const target = controls.target.clone();
      const offset = camera.position.clone().sub(target);
      const axis = tilt ? offset.clone().cross(camera.up).normalize() : camera.up;
      camera.position.copy(target).add(offset.applyAxisAngle(axis, (degrees * Math.PI) / 180));
      camera.lookAt(target);
      controls.update();
      root.invalidate();
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    },
    { degrees, tilt },
  );
}

for (const colors of ['light', 'dark', 'distinct'] as const)
  test(`a line and an area on the front of a thin plate show from the front, also turned away, and not from behind, ${colors}`, async ({
    page,
  }) => {
    // A 0.2 mm plate, painted on its front at z = 0.1.
    const plate = part(
      'plate',
      'Thin plate',
      new BoxGeometry(20, 20, 0.2, 40, 40, 1),
      [0, 10, 0],
      colors === 'dark' ? '#1c1c1c' : '#e4e0d8',
    );
    await warpFront(page, sceneOf([plate]), 'Thin plate', [0, 10, 0.1]);
    if (colors === 'distinct')
      await inStore(page, "store.useEditor.getState().setView({ partColors: 'distinct' });");
    // Radius 0, so no reach is drawn around the handles.
    await inStore(page, "store.useEditor.getState().setWarpPointSettings({ radius: 0 }, 'end');");
    // Zoomed out as a 100 mm part is framed, where the old lift of a few pixels exceeded 0.2 mm.
    await pixelAt(page, 0.1);
    await page.getByRole('radio', { name: 'Line', exact: true }).click();
    const line = [
      [-6, 7, 0.1],
      [6, 9, 0.1],
    ];
    await drag(page, line);
    await page.getByRole('radio', { name: 'Area', exact: true }).click();
    const brush = page.getByRole('spinbutton', { name: 'Brush radius', exact: true });
    await brush.fill('1.5');
    await brush.press('Enter');
    await drag(page, [
      [-2, 13, 0.1],
      [2, 13.5, 0.1],
    ]);
    expect((await state(page)).handles.map((handle: { kind: string }) => handle.kind)).toEqual([
      'line',
      'area',
    ]);
    // Nothing selected, so no gizmo is drawn, and no brush cursor.
    await inStore(page, 'store.useEditor.getState().selectWarpPoints([]);');
    await page.getByRole('radio', { name: 'Point', exact: true }).click();
    await page.mouse.move(0, 0);
    const front = await strokeShare(page, line);
    // Looked at 65° from above, the half of its width beyond the line would sink into the
    // surface if its corners were not laid on it.
    await turnAround(page, 65, true);
    const slope = await strokeShare(page, line);
    await turnAround(page, -65, true);
    await turnAround(page);
    const back = await strokeShare(page, line);
    test.info().annotations.push({
      type: 'pixels',
      description: JSON.stringify({ front, slope, back }),
    });
    // Drawn along its whole length, at least the core's width.
    expect(front.line.drawn).toBeGreaterThan(2.5 * front.length);
    expect(front.all.drawn).toBeGreaterThan(2 * front.line.drawn);
    expect(front.line.shown).toBeGreaterThan(0.99 * front.line.drawn);
    expect(front.all.shown).toBeGreaterThan(0.99 * front.all.drawn);
    expect(slope.line.drawn).toBeGreaterThan(2.5 * slope.length);
    expect(slope.line.shown).toBeGreaterThan(0.99 * slope.line.drawn);
    expect(slope.all.shown).toBeGreaterThan(0.99 * slope.all.drawn);
    // From behind, the plate hides all of it.
    expect(back.all.drawn).toBeGreaterThan(0.9 * front.all.drawn);
    expect(back.all.shown).toBeLessThan(0.002 * back.all.drawn);
  });
