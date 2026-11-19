import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';

const geometry = serializeGeometry(new BoxGeometry(20, 20, 20, 12, 12, 12));
// The neighbour's -X face is 1 mm from the block's +X face.
const fixture = {
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Warp seam',
  joints: [],
  parts: [
    { id: 'block', name: 'Scanned block', position: [0, 10, 0], color: '#d4a272' },
    { id: 'wall', name: 'Neighbour', position: [21, 10, 0], color: '#8cbeb6' },
  ].map((part) => ({
    ...part,
    geometry,
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    visible: true,
    locked: false,
    source: 'test',
  })),
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

async function editorState(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor, warpBrushRadius } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const fiber = await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!);
    const root = fiber._roots.get(document.querySelector('canvas')).store.getState();
    const state = useEditor.getState(),
      warp = state.warp;
    const block = state.scene.parts.find((part: any) => part.id === 'block');
    return {
      tool: state.tool as string,
      stage: (warp?.stage ?? null) as string | null,
      faces: (warp?.faces.length ?? 0) as number,
      brushRadius: state.brushRadius as number,
      warpBrushRadius: warpBrushRadius(state) as number,
      points: (warp?.points ?? []).map((point: any) => ({
        at: point.target ?? point.pin,
        moved: point.target !== null,
      })) as { at: number[]; moved: boolean }[],
      selectedPoints: (warp?.selectedPoints.length ?? 0) as number,
      undo: (warp?.undo.length ?? 0) as number,
      gap: (warp?.seam?.largestGap ?? null) as number | null,
      past: state.past.length as number,
      source: block.source as string,
      mesh: Array.from(block.geometry.getAttribute('position').array) as number[],
      previewIndexed: Boolean(warp?.preview?.boundsTree),
      preview: warp?.preview
        ? (Array.from(warp.preview.getAttribute('position').array) as number[])
        : null,
      drawn: Array.from(
        root.scene.getObjectByName('part:block').geometry.getAttribute('position').array,
      ) as number[],
      controls: root.controls.enabled as boolean,
      camera: root.camera.position.toArray() as number[],
    };
  });
}

/** Screen position of a world point, or of a named object's local point. */
async function screen(page: Page, world: number[], name?: string) {
  const box = (await page.locator('canvas').boundingBox())!;
  const ndc = await page.evaluate(
    async ({ world, name }) => {
      const url = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((url) => url.includes('/@react-three_fiber.js'))!;
      const root = (await import(url))._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const point = root.camera.position.clone().fromArray(world);
      if (name) {
        let target: any;
        root.scene.traverse((object: any) => {
          if (!target && object.name === name && object.geometry?.type !== 'CylinderGeometry')
            target = object;
        });
        target.updateWorldMatrix(true, false);
        point.applyMatrix4(target.matrixWorld);
      }
      return point.project(root.camera).toArray();
    },
    { world, name },
  );
  return { x: box.x + ((ndc[0] + 1) * box.width) / 2, y: box.y + ((1 - ndc[1]) * box.height) / 2 };
}

/** Screen position of the X arrow of the move gizmo on the selected control point. */
async function moveHandle(page: Page) {
  const box = (await page.locator('canvas').boundingBox())!;
  const ndc = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => url.includes('/@react-three_fiber.js'))!;
    const root = (await import(url))._roots.get(document.querySelector('canvas')).store.getState();
    let controls: any;
    root.scene.traverse((object: any) => {
      if (object.isTransformControls && object.visible) controls = object;
    });
    const handle = controls.gizmo.picker.translate.children.find((o: any) => o.name === 'X');
    handle.geometry.computeBoundingBox();
    const point = handle.geometry.boundingBox.getCenter(root.camera.position.clone());
    handle.localToWorld(point);
    return point.project(root.camera).toArray();
  });
  return { x: box.x + ((ndc[0] + 1) * box.width) / 2, y: box.y + ((1 - ndc[1]) * box.height) / 2 };
}

/** Drags a gizmo handle partway, and the window loses focus before the button is released. */
async function interruptedDrag(page: Page, from: { x: number; y: number }, by = { x: 30, y: 0 }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 6 });
  const dragging = await editorState(page);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const interrupted = await editorState(page);
  await page.mouse.up();
  return { dragging, interrupted };
}

async function open(page: Page, scene = fixture) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'warp.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scene)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Scanned block"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
}

const differs = (a: number[], b: number[]) => a.some((value, i) => Math.abs(value - b[i]) > 1e-4);

test('closes a seam, moves a control point, applies, undoes and cancels', async ({ page }) => {
  const indexedGeometry = serializeGeometry(new BoxGeometry(20, 20, 20, 52, 52, 52));
  await open(page, {
    ...fixture,
    parts: fixture.parts.map((part) =>
      part.id === 'block' ? { ...part, geometry: indexedGeometry } : part,
    ),
  });
  const original = await editorState(page);

  await page.keyboard.press('w');
  await expect(page.getByTitle('Warp a scanned surface (W)')).toHaveClass(/active/);
  await page.getByRole('radio', { name: 'Whole part', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Place points automatically' }).uncheck();
  // The grid is built by the warp worker.
  await page.getByRole('button', { name: 'Lay grid', exact: true }).click();
  const close = page.getByRole('button', { name: 'Close gap', exact: true });
  await expect(close).toBeEnabled();
  const readout = page.locator('.warp-readout');
  await expect(readout).toContainText('Gap to neighbour');
  await expect(readout).toContainText('1.00 mm');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  await expect(page.locator('.statusbar')).toContainText(
    'Click the surface to add a control point · Drag a handle to warp · Shift for fine adjustment',
  );

  await close.click();
  await expect(readout).toContainText('Closed');
  const closed = await editorState(page);
  expect(closed.gap).toBeLessThanOrEqual(0);
  expect(closed.undo).toBe(1);
  // The part draws the warped preview, and the scene keeps the source until Apply.
  expect(differs(closed.drawn, original.mesh)).toBe(true);
  expect(closed.mesh).toEqual(original.mesh);

  // A point on the front face, away from the neighbour, then a numeric step along X.
  // Close gap displaced the front face. Place the point under the cursor on that surface.
  const corner = original.mesh.findIndex(
    (_, i) =>
      i % 3 === 0 &&
      Math.hypot(original.mesh[i] + 5, original.mesh[i + 1], original.mesh[i + 2] - 10) < 1e-4,
  );
  const shift = [0, 1, 2].map((a) => closed.drawn[corner + a] - original.mesh[corner + a]);
  expect(shift[0]).toBeGreaterThan(0.5);
  const clicked = [-4.5 + shift[0], 10.5 + shift[1], 10 + shift[2]];
  const front = await screen(page, clicked);
  await page.mouse.click(front.x, front.y);
  const added = await editorState(page);
  expect(added.previewIndexed).toBe(true);
  expect(added.points).toHaveLength(1);
  expect(added.points[0].moved).toBe(false);
  expect(added.selectedPoints).toBe(1);
  expect(added.undo).toBe(2);
  expect(Math.hypot(...added.points[0].at.map((value, a) => value - clicked[a]))).toBeLessThan(0.1);
  await page.getByRole('button', { name: 'Move X negative', exact: true }).click();
  const moved = await editorState(page);
  expect(moved.points[0].moved).toBe(true);
  expect(moved.points[0].at[0]).toBeCloseTo(added.points[0].at[0] - 1, 5);
  expect(moved.undo).toBe(3);
  expect(moved.past).toBe(original.past);
  expect(differs(moved.preview!, added.preview!)).toBe(true);

  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const applied = await editorState(page);
  expect(applied.past).toBe(original.past + 1);
  expect(applied.source).toBe('Warp · test');
  expect(differs(applied.mesh, original.mesh)).toBe(true);
  expect(applied.stage).toBe('region');

  await page.keyboard.press('ControlOrMeta+z');
  const undone = await editorState(page);
  expect(undone.mesh).toEqual(original.mesh);
  expect(undone.source).toBe('test');
  expect(undone.stage).toBeNull();

  // Reopen, paint a region with a larger brush, and warp inside it.
  await page.keyboard.press('w');
  await expect(page.locator('.statusbar')).toContainText(
    'Paint the area to warp, or choose Whole part · Alt erases',
  );
  // Warp's brush starts at 3 % of the 20 mm block, and ] sizes it without touching Align's.
  expect((await editorState(page)).warpBrushRadius).toBe(0.6);
  await page.keyboard.press(']');
  const sized = await editorState(page);
  expect(sized.warpBrushRadius).toBeCloseTo(0.75, 5);
  expect(sized.brushRadius).toBe(original.brushRadius);
  const [start, end] = [await screen(page, [-4, 10, 10]), await screen(page, [2, 10, 10])];
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
  const painted = await editorState(page);
  expect(painted.faces).toBeGreaterThan(0);
  expect(painted.mesh).toEqual(original.mesh);
  await page.getByRole('button', { name: 'Lay grid', exact: true }).click();
  await expect(close).toBeEnabled();
  // No surface in the painted region faces the neighbour, so there is no seam to report.
  await expect(readout).toHaveCount(0);

  const centre = await screen(page, [-1, 10, 10]);
  await page.mouse.click(centre.x, centre.y);
  expect((await editorState(page)).points).toHaveLength(1);

  // Clicking empty space clears the point selection; clicking its marker selects it again.
  const canvas = (await page.locator('canvas').boundingBox())!;
  await page.mouse.click(canvas.x + 40, canvas.y + canvas.height - 120);
  const cleared = await editorState(page);
  expect(cleared.selectedPoints).toBe(0);
  expect(cleared.points).toHaveLength(1);
  const marker = await screen(page, cleared.points[0].at);
  await page.mouse.click(marker.x, marker.y);
  expect((await editorState(page)).selectedPoints).toBe(1);

  // A gizmo drag cut short by the window losing focus still ends as one session step.
  const before = await editorState(page);
  const handle = await interruptedDrag(page, await moveHandle(page));
  expect(handle.dragging.points[0].moved).toBe(true);
  expect(handle.dragging.undo).toBe(before.undo);
  expect(handle.dragging.controls).toBe(false);
  expect(handle.interrupted.undo).toBe(before.undo + 1);
  expect(handle.interrupted.controls).toBe(true);
  const interrupted = await editorState(page);
  expect(interrupted.undo).toBe(before.undo + 1);
  expect(differs(interrupted.preview!, before.preview!)).toBe(true);

  // So does a drag of the combined Transform gizmo.
  // In this view the Z arrow hides the X arrow, so the drag is up the Y arrow.
  await page.keyboard.press('t');
  const pivot = await screen(page, interrupted.points[0].at);
  // The gizmo takes its screen size on its first frame.
  await expect
    .poll(async () => pivot.y - (await screen(page, [0, 0, 0], 'transform:move:Y')).y)
    .toBeGreaterThan(40);
  const arrow = await screen(page, [0, 0, 0], 'transform:move:Y');
  const gizmo = await interruptedDrag(page, arrow, { x: 0, y: -30 });
  expect(gizmo.dragging.undo).toBe(interrupted.undo);
  expect(gizmo.dragging.controls).toBe(false);
  expect(gizmo.interrupted.undo).toBe(interrupted.undo + 1);
  expect(gizmo.interrupted.controls).toBe(true);
  const combined = await editorState(page);
  expect(combined.undo).toBe(interrupted.undo + 1);
  expect(combined.points[0].at[1]).toBeGreaterThan(interrupted.points[0].at[1] + 0.5);

  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const cancelled = await editorState(page);
  expect(cancelled.tool).toBe('select');
  expect(cancelled.stage).toBeNull();
  expect(cancelled.mesh).toEqual(original.mesh);
  expect(cancelled.drawn).toEqual(original.mesh);
  expect(cancelled.past).toBe(original.past);
});

test('dragging the region brush paints a stroke without orbiting', async ({ page }) => {
  await open(page);
  await page.keyboard.press('w');
  await expect(page.locator('.statusbar')).toContainText(
    'Paint the area to warp, or choose Whole part · Alt erases',
  );
  const [start, end] = [await screen(page, [-6, 10, 10]), await screen(page, [6, 10, 10])];
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const dab = await editorState(page);
  expect(dab.faces).toBeGreaterThan(0);
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  const stroke = await editorState(page);
  expect(stroke.camera).toEqual(dab.camera);
  expect(stroke.faces).toBeGreaterThan(dab.faces);
});

test('toolbar transform buttons choose the control point gizmo while warping', async ({ page }) => {
  await open(page);
  await page.keyboard.press('w');
  await page.getByRole('radio', { name: 'Whole part', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Place points automatically' }).uncheck();
  await page.getByRole('button', { name: 'Lay grid', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close gap', exact: true })).toBeEnabled();
  const front = await screen(page, [-4.5, 10.5, 10]);
  await page.mouse.click(front.x, front.y);
  expect((await editorState(page)).points).toHaveLength(1);

  const toolbar = page.locator('.toolbar');
  for (const [title, gizmo] of [
    ['Rotate (R)', 'rotate'],
    ['Scale (S)', 'scale'],
    ['Transform (T)', 'transform'],
    ['Move (G)', 'translate'],
  ]) {
    await toolbar.getByTitle(title, { exact: true }).click();
    const state = await page.evaluate(async () => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const { useEditor } = await import(
        urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
      );
      const { tool, warp } = useEditor.getState();
      return { tool, gizmo: warp?.gizmo, points: warp?.points.length };
    });
    expect(state, title).toEqual({ tool: 'warp', gizmo, points: 1 });
  }
  await expect(page.getByText('Warp discarded', { exact: false })).toHaveCount(0);

  // Select still leaves the tool, which ends the session.
  await toolbar.getByTitle('Select (V)', { exact: true }).click();
  expect((await editorState(page)).stage).toBeNull();
});

test('a Shift press on the gizmo centre leaves its point selected', async ({ page }) => {
  await open(page);
  await page.keyboard.press('w');
  await page.getByRole('radio', { name: 'Whole part', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Place points automatically' }).uncheck();
  await page.getByRole('button', { name: 'Lay grid', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close gap', exact: true })).toBeEnabled();
  const front = await screen(page, [-4.5, 10.5, 10]);
  await page.mouse.click(front.x, front.y);
  const added = await editorState(page);
  expect(added.selectedPoints).toBe(1);

  // The marker lies under the gizmo's centre handle, which takes the press.
  const centre = await screen(page, added.points[0].at);
  await page.keyboard.down('Shift');
  await page.mouse.click(centre.x, centre.y);
  expect((await editorState(page)).selectedPoints).toBe(1);
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 2, centre.y + 1, { steps: 2 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const after = await editorState(page);
  expect(after.selectedPoints).toBe(1);
  expect(after.points).toHaveLength(1);
});

test('a whole part gets pins of its own, so a moved point bends it, shaped by radius and falloff', async ({
  page,
}) => {
  await open(page);
  const original = await editorState(page);
  await page.keyboard.press('w');
  await page.getByRole('radio', { name: 'Whole part', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Place points automatically' })).toBeChecked();
  await page.getByRole('button', { name: 'Lay grid', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close gap', exact: true })).toBeEnabled();
  const laid = await editorState(page);
  expect(laid.points).toHaveLength(8);
  expect(laid.points.every((point) => !point.moved)).toBe(true);
  expect(laid.undo).toBe(0);

  const front = await screen(page, [-4.5, 10.5, 10]);
  await page.mouse.click(front.x, front.y);
  expect((await editorState(page)).points).toHaveLength(9);
  const radius = page.getByRole('spinbutton', { name: 'Point radius', exact: true });
  await radius.fill('0');
  await radius.press('Tab');
  const placed = (await editorState(page)).points.at(-1)!;
  for (let step = 0; step < 3; step++)
    await page.getByRole('button', { name: 'Move Z positive', exact: true }).click();
  const point = await editorState(page);
  expect(point.points.at(-1)!.moved).toBe(true);
  const lift = point.points.at(-1)!.at[2] - placed.at[2];
  expect(lift).toBeGreaterThan(0.5);
  // The back of the block stays where it was: the drag bends the part instead of moving it.
  const back = (mesh: number[]) =>
    Math.max(
      ...mesh.flatMap((value, i) =>
        i % 3 === 2 && Math.abs(original.mesh[i] + 10) < 1e-4
          ? [Math.abs(value - original.mesh[i])]
          : [],
      ),
    );
  expect(back(point.preview!)).toBeLessThan(0.15 * lift);

  await radius.fill('6');
  await radius.press('Tab');
  const wide = await editorState(page);
  expect(wide.undo).toBe(point.undo + 1);
  expect(differs(wide.preview!, point.preview!)).toBe(true);
  const falloff = page.getByRole('spinbutton', { name: 'Point falloff', exact: true });
  await falloff.fill('0');
  await falloff.press('Tab');
  const plateau = await editorState(page);
  expect(plateau.undo).toBe(wide.undo + 1);
  expect(differs(plateau.preview!, wide.preview!)).toBe(true);

  await page.getByRole('button', { name: 'Distribute points', exact: true }).click();
  expect((await editorState(page)).points).toHaveLength(17);
});

test('says the surface is still settling, and Apply waits for it to settle', async ({ page }) => {
  await open(page, {
    ...fixture,
    parts: fixture.parts.map((part) =>
      part.id === 'block'
        ? { ...part, geometry: serializeGeometry(new BoxGeometry(20, 20, 20, 52, 52, 52)) }
        : part,
    ),
  });
  await page.keyboard.press('w');
  await page.getByRole('radio', { name: 'Whole part', exact: true }).click();
  await page.getByRole('button', { name: 'Lay grid', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close gap', exact: true })).toBeEnabled();
  // The finest grid settles longest.
  await page.getByRole('slider', { name: 'Grid density', exact: true }).fill('6');
  await expect(page.getByRole('button', { name: 'Close gap', exact: true })).toBeEnabled();
  const front = await screen(page, [-4.5, 10.5, 10]);
  await page.mouse.click(front.x, front.y);
  const radius = page.getByRole('spinbutton', { name: 'Point radius', exact: true });
  await radius.fill('0');
  await radius.press('Tab');
  // Records the surface shown when Apply is pressed, and when it stops settling.
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!;
    const { useEditor } = await import(url);
    const w = window as unknown as { pressed: number[] | null; settled: number[] | null };
    const shown = () =>
      Array.from(useEditor.getState().warp.preview.getAttribute('position').array) as number[];
    w.pressed = w.settled = null;
    document.addEventListener(
      'click',
      (event) => {
        if ((event.target as Element).closest('.warp-actions .button.primary')) w.pressed = shown();
      },
      true,
    );
    useEditor.subscribe((state: any, previous: any) => {
      if (previous.warp?.settling && state.warp && !state.warp.settling) w.settled = shown();
    });
  });
  const settling = page.locator('.warp-settling');
  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  await expect(settling).toHaveCount(0);
  // A real drag on the gizmo's X arrow, released.
  const handle = await moveHandle(page);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 240, handle.y, { steps: 8 });
  await page.mouse.up();
  await expect(settling).toContainText('The surface is still settling. Apply waits for it.');
  await apply.click();
  const applying = page.getByRole('button', { name: 'Applying…', exact: true });
  await expect(applying).toBeDisabled();
  await expect(applying).toHaveAttribute('aria-busy', 'true');
  await expect(settling).toContainText('Applying once the surface settles…');
  // Input still reaches the page while it settles.
  await page.mouse.move(front.x + 40, front.y + 40);
  await expect.poll(async () => (await editorState(page)).source).toBe('Warp · test');
  const applied = await editorState(page);
  const { pressed, settled } = await page.evaluate(() => {
    const w = window as unknown as { pressed: number[]; settled: number[] };
    return { pressed: w.pressed, settled: w.settled };
  });
  expect(applied.stage).toBe('region');
  // It baked the settled surface, which had gone on moving after the button was pressed.
  expect(applied.mesh).toEqual(settled);
  expect(differs(settled, pressed)).toBe(true);
});

test.describe('with clipping on, as by default', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the Warp button keeps the toolbar on one row at 1440 px', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('button', { name: 'Avoid clipping', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const toolbar = page.locator('.toolbar');
    // Transform already took two rows with clipping on before Warp was added.
    for (const tool of [
      'Select (V)',
      'Move (G)',
      'Rotate (R)',
      'Scale (S)',
      'Warp a scanned surface (W)',
    ]) {
      await toolbar.getByTitle(tool, { exact: true }).click();
      // One row is 46 px tall, two are 78.
      expect((await toolbar.boundingBox())!.height, tool).toBeLessThan(50);
    }
    // The labels it hides stay in the tooltips.
    await expect(page.getByTitle('Pin parts in space')).toBeVisible();
    await expect(page.getByTitle(/^Create joint/)).toBeVisible();
  });
});

/** The session's undo depth, whether a warp gesture is open, and the selected point's settings. */
async function sliderState(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor, isWarpDragging } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const warp = useEditor.getState().warp;
    const point = warp.points.find((point: any) => warp.selectedPoints.includes(point.id));
    return {
      undo: warp.undo.length as number,
      dragging: isWarpDragging() as boolean,
      radius: point.radius as number,
      falloff: point.falloff as number,
    };
  });
}

/** Presses on a slider at a share of its width and drags it to another, leaving the button down. */
async function pressSlider(page: Page, name: string, from: number, to: number) {
  const slider = page.getByRole('slider', { name, exact: true });
  const size = (await slider.boundingBox())!;
  await slider.hover({ position: { x: from * size.width, y: size.height / 2 } });
  await page.mouse.down();
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + to * box.width, box.y + box.height / 2, { steps: 6 });
}

test('each radius or falloff gesture is one undo step and ends exactly once', async ({ page }) => {
  await open(page);
  await page.keyboard.press('w');
  await page.getByRole('radio', { name: 'Whole part', exact: true }).click();
  await page.getByRole('button', { name: 'Lay grid', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close gap', exact: true })).toBeEnabled();
  const front = await screen(page, [-4.5, 10.5, 10]);
  await page.mouse.click(front.x, front.y);
  for (let step = 0; step < 3; step++)
    await page.getByRole('button', { name: 'Move Z positive', exact: true }).click();
  const start = await sliderState(page);
  expect(start.dragging).toBe(false);

  // A drag and release.
  await pressSlider(page, 'Point radius slider', 0.3, 0.6);
  expect((await sliderState(page)).dragging).toBe(true);
  await page.mouse.up();
  const dragged = await sliderState(page);
  expect(dragged).toMatchObject({ undo: start.undo + 1, dragging: false });
  expect(dragged.radius).not.toBe(start.radius);

  // Straight from one slider to the other: one step each, and nothing from the first's blur.
  await pressSlider(page, 'Point radius slider', 0.6, 0.5);
  await page.mouse.up();
  await pressSlider(page, 'Point falloff slider', 0.9, 0.4);
  await page.mouse.up();
  const switched = await sliderState(page);
  expect(switched).toMatchObject({ undo: dragged.undo + 2, dragging: false });
  expect(switched.falloff).toBeLessThan(0.6);

  // Arrow keys: a step per press.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  const keyed = await sliderState(page);
  expect(keyed).toMatchObject({ undo: switched.undo + 2, dragging: false });
  expect(keyed.falloff).toBeCloseTo(switched.falloff - 0.02, 6);

  // The window losing focus mid-drag ends the gesture once; the release adds nothing.
  await pressSlider(page, 'Point radius slider', 0.5, 0.7);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const blurred = await sliderState(page);
  expect(blurred).toMatchObject({ undo: keyed.undo + 1, dragging: false });
  await page.mouse.up();
  expect(await sliderState(page)).toMatchObject({ undo: blurred.undo, dragging: false });

  // So does a cancelled pointer.
  await pressSlider(page, 'Point falloff slider', 0.4, 0.7);
  await page.evaluate(() =>
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })),
  );
  const cancelled = await sliderState(page);
  expect(cancelled).toMatchObject({ undo: blurred.undo + 1, dragging: false });
  await page.mouse.up();
  expect((await sliderState(page)).undo).toBe(cancelled.undo);
});

/** Every point's radius and falloff, which are selected, what new points take, and undo depth. */
async function pointSettings(page: Page): Promise<{
  points: { radius: number; falloff: number; selected: boolean }[];
  pointRadius: number | null;
  pointFalloff: number;
  undo: number;
}> {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const warp = useEditor.getState().warp;
    return {
      points: warp.points.map((point: any) => ({
        radius: point.radius as number,
        falloff: point.falloff as number,
        selected: warp.selectedPoints.includes(point.id) as boolean,
      })),
      pointRadius: warp.pointRadius as number | null,
      pointFalloff: warp.pointFalloff as number,
      undo: warp.undo.length as number,
    };
  });
}

test('selected points with different radii or falloffs show each field as mixed', async ({
  page,
}) => {
  await open(page);
  await page.keyboard.press('w');
  await page.getByRole('radio', { name: 'Whole part', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Place points automatically' }).uncheck();
  await page.getByRole('button', { name: 'Lay grid', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close gap', exact: true })).toBeEnabled();
  const radius = page.getByRole('spinbutton', { name: 'Point radius', exact: true });
  const falloff = page.getByRole('spinbutton', { name: 'Point falloff', exact: true });
  const radiusSlider = page.getByRole('slider', { name: 'Point radius slider', exact: true });
  const falloffSlider = page.getByRole('slider', { name: 'Point falloff slider', exact: true });
  const help = page.locator('.warp-point-settings > .anchor-help');
  const set = async (field: typeof radius, value: string) => {
    await field.fill(value);
    await field.press('Tab');
  };
  /** Adds a point at a spot on the front with these settings, which then selects it alone. */
  const place = async (at: number[], r: string, f: string) => {
    const spot = await screen(page, at);
    await page.mouse.click(spot.x, spot.y);
    await set(radius, r);
    await set(falloff, f);
    return spot;
  };
  const a = await place([-5, 5, 10], '2.6', '70');
  await place([5, 15, 10], '3.8', '35');
  // One selected: its own values, as before.
  await expect(radius).toHaveValue('3.8');
  await expect(falloff).toHaveValue('35');
  await expect(help).toContainText('New points use the same settings.');
  const single = await pointSettings(page);
  // Typing the value it already has changes nothing.
  await set(radius, '3.8');
  expect((await pointSettings(page)).undo).toBe(single.undo);

  // Both selected: both fields mixed, and the text says what a new point gets.
  await page.keyboard.down('Shift');
  await page.mouse.click(a.x, a.y);
  await page.keyboard.up('Shift');
  expect((await pointSettings(page)).points.map(({ selected }) => selected)).toEqual([true, true]);
  for (const field of [radius, falloff]) {
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute('placeholder', 'Mixed');
  }
  for (const slider of [radiusSlider, falloffSlider]) {
    await expect(slider).toHaveAttribute('aria-valuetext', 'Mixed');
    await expect(slider).toHaveClass(/mixed/);
  }
  await expect(help).toHaveText(
    'The selected points move the surface within their own radii. New points use a 3.8 mm radius and 35% falloff.',
  );
  await expect(help).not.toContainText('the same settings');
  // A new point gets just that. The gizmo sits between the two selected.
  const spot = await screen(page, [-5, 15, 10]);
  await page.mouse.click(spot.x, spot.y);
  const added = await pointSettings(page);
  expect(added.points).toHaveLength(3);
  expect(added.points.at(-1)).toEqual({ radius: 3.8, falloff: 0.35, selected: true });
  // Undo takes it away and selects the two again.
  await page.keyboard.press('ControlOrMeta+z');
  expect((await pointSettings(page)).points).toHaveLength(2);

  // Typing one of the values into the mixed field sets both, as one undo step.
  const mixed = await pointSettings(page);
  expect(mixed.points.map(({ selected }) => selected)).toEqual([true, true]);
  await set(radius, '2.6');
  const same = await pointSettings(page);
  expect(same.points.map(({ radius }) => radius)).toEqual([2.6, 2.6]);
  expect(same.undo).toBe(mixed.undo + 1);
  // Each field is mixed on its own: the radii now agree and the falloffs do not.
  await expect(radius).toHaveValue('2.6');
  await expect(radiusSlider).not.toHaveClass(/mixed/);
  await expect(falloff).toHaveValue('');
  await expect(falloffSlider).toHaveAttribute('aria-valuetext', 'Mixed');
  await set(falloff, '35');
  const level = await pointSettings(page);
  expect(level.points.map(({ falloff }) => falloff)).toEqual([0.35, 0.35]);
  expect(level.undo).toBe(same.undo + 1);
  await expect(falloff).toHaveValue('35');
  // Undo gives back each step, and the fields show them mixed again.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(falloff).toHaveValue('');
  await page.keyboard.press('ControlOrMeta+z');
  expect((await pointSettings(page)).points.map(({ radius }) => radius)).toEqual([2.6, 3.8]);
  await expect(radius).toHaveValue('');

  // A slider used from mixed sets both.
  const box = (await radiusSlider.boundingBox())!;
  await page.mouse.click(box.x + 0.5 * box.width, box.y + box.height / 2);
  const slid = await pointSettings(page);
  expect(slid.points[0].radius).toBe(slid.points[1].radius);
  expect(slid.undo).toBe(mixed.undo + 1);

  // Nothing selected: what new points take, as before.
  const empty = await screen(page, [0, 27, 0]);
  await page.mouse.click(empty.x, empty.y);
  expect((await pointSettings(page)).points.some(({ selected }) => selected)).toBe(false);
  await expect(radius).not.toHaveValue('');
  await expect(help).toHaveText('New points use this radius and falloff.');
});

test('choosing the least value on a mixed slider sets it on every selected point', async ({
  page,
}) => {
  await open(page);
  await page.keyboard.press('w');
  await page.getByRole('radio', { name: 'Whole part', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Place points automatically' }).uncheck();
  await page.getByRole('button', { name: 'Lay grid', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close gap', exact: true })).toBeEnabled();
  const radius = page.getByRole('spinbutton', { name: 'Point radius', exact: true });
  const falloff = page.getByRole('spinbutton', { name: 'Point falloff', exact: true });
  const set = async (field: typeof radius, value: string) => {
    await field.fill(value);
    await field.press('Tab');
  };
  const place = async (at: number[], r: string, f: string) => {
    const spot = await screen(page, at);
    await page.mouse.click(spot.x, spot.y);
    await set(radius, r);
    await set(falloff, f);
    return spot;
  };
  const a = await place([-5, 5, 10], '2.6', '70');
  await place([5, 15, 10], '3.8', '35');
  await page.keyboard.down('Shift');
  await page.mouse.click(a.x, a.y);
  await page.keyboard.up('Shift');
  const mixed = await pointSettings(page);
  expect(mixed.points.map(({ selected }) => selected)).toEqual([true, true]);
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  for (const [name, setting, field] of [
    ['Point radius slider', 'radius', radius],
    ['Point falloff slider', 'falloff', falloff],
  ] as const) {
    const slider = page.getByRole('slider', { name, exact: true });
    const gestures = {
      Home: () => slider.press('Home'),
      Left: () => slider.press('ArrowLeft'),
      'a click at the left end': async () => {
        const box = (await slider.boundingBox())!;
        await page.mouse.click(box.x + 1, box.y + box.height / 2);
      },
    };
    // Only the primary button chooses a value.
    for (const button of ['right', 'middle'] as const) {
      const box = (await slider.boundingBox())!;
      await page.mouse.click(box.x + 1, box.y + box.height / 2, { button });
      await page.keyboard.press('Escape');
      expect(await pointSettings(page), `${setting} after a ${button} click`).toEqual(mixed);
    }
    for (const [gesture, act] of Object.entries(gestures)) {
      await expect(slider, gesture).toHaveAttribute('aria-valuetext', 'Mixed');
      await act();
      const least = await pointSettings(page);
      expect(
        least.points.map((point) => point[setting]),
        `${setting} after ${gesture}`,
      ).toEqual([0, 0]);
      expect(least.undo, `${setting} after ${gesture}`).toBe(mixed.undo + 1);
      await expect(slider).not.toHaveClass(/mixed/);
      await expect(field).toHaveValue('0');
      // Undo gives the two values back.
      await blur();
      await page.keyboard.press('ControlOrMeta+z');
      expect((await pointSettings(page)).points).toEqual(mixed.points);
    }
  }
});
