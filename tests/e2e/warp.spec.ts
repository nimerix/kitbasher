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
    const { useEditor } = await import(
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
  await page.keyboard.press(']');
  expect((await editorState(page)).brushRadius).toBeCloseTo(3.75, 5);
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

test('toolbar transform buttons choose the control point gizmo while warping', async ({ page }) => {
  await open(page);
  await page.keyboard.press('w');
  await page.getByRole('radio', { name: 'Whole part', exact: true }).click();
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
