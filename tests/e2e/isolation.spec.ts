import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';

// Flow: I / Shift+I and the isolation bar -> a view-only isolated set -> other parts hidden,
// or drawn and pickable only where a distance field puts them near the isolated part.
const box = serializeGeometry(new BoxGeometry(16, 16, 16));
const fixture = {
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Isolation bench',
  // The first two face each other across a 1 mm gap.
  parts: [
    { id: 'a', name: 'Moving piece', position: [-8.5, 30, 0] },
    { id: 'b', name: 'Target piece', position: [8.5, 30, 0] },
    { id: 'c', name: 'Far piece', position: [40, 30, 0] },
  ].map((part) => ({
    ...part,
    geometry: box,
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#c7a48c',
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
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'isolation.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await expect(page.locator('.document-title')).toContainText(fixture.name);
  await page.getByRole('button', { name: 'Toggle grid', exact: true }).click();
  await page.locator('.part-select[title="Moving piece"]').click();
  // Head-on and orthographic, so each pixel looks straight through the parts.
  await page.keyboard.press('1');
  await page.keyboard.press('5');
  await settled(page);
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

const settled = (page: Page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

async function view(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const fiber = await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!);
    const root = fiber._roots.get(document.querySelector('canvas')).store.getState();
    const state = useEditor.getState();
    let gizmo = false;
    root.scene.traverse((object: any) => {
      if (object.isTransformControls && object.visible) gizmo = true;
    });
    const mesh = (id: string) => root.scene.getObjectByName(`part:${id}`);
    return {
      isolated: state.isolated as string[] | null,
      settings: state.view.isolation as { nearby: boolean; distance: number },
      detail: state.nearbyDetail as number | null,
      selected: state.selected as string[],
      revision: state.revision as number,
      past: state.past.length as number,
      picked: state.operation.pairs.map((pair: any) => pair.target.partId) as string[],
      shown: Object.fromEntries(
        state.scene.parts.map((part: any) => [part.id, !!mesh(part.id)?.parent.visible]),
      ) as Record<string, boolean>,
      visible: state.scene.parts.map((part: any) => part.visible) as boolean[],
      // The distance field a cut-away part is drawn with.
      field: Object.fromEntries(
        state.scene.parts.map((part: any) => [
          part.id,
          (mesh(part.id) &&
            root.gl.properties.get(mesh(part.id).material).uniforms?.nearbyField?.value?.uuid) ??
            null,
        ]),
      ) as Record<string, string | null>,
      gizmo,
      cameraDistance: root.camera.position.distanceTo(root.controls.target) as number,
    };
  });
}

/** Where a point given in a part's own coordinates lands on the page. */
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

/** Whether anything is drawn over the background at a point on a part. */
async function drawn(page: Page, id: string, local: number[]) {
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
      const pixel = new Uint8Array(4);
      gl.readPixels(
        Math.round(((ndc.x + 1) / 2) * gl.drawingBufferWidth),
        Math.round(((ndc.y + 1) / 2) * gl.drawingBufferHeight),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixel,
      );
      // The viewport background is #272a2f.
      return Math.max(...[39, 42, 47].map((value, i) => Math.abs(pixel[i] - value))) > 25;
    },
    { id, local },
  );
}

async function setDistance(page: Page, value: string) {
  const input = page.getByLabel('Nearby distance in mm');
  await input.fill(value);
  await input.press('Enter');
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
  await settled(page);
}

// The front face of each box, seen head-on after pressing 1.
const front = [0, 0, 8];

test('I isolates the selection in the viewport only, and I again shows everything', async ({
  page,
}) => {
  const before = await view(page);
  expect(await drawn(page, 'b', front)).toBe(true);
  await page.keyboard.press('i');
  await settled(page);
  let now = await view(page);
  expect(now.isolated).toEqual(['a']);
  expect(now.shown).toEqual({ a: true, b: false, c: false });
  expect(await drawn(page, 'a', front)).toBe(true);
  expect(await drawn(page, 'b', front)).toBe(false);
  // The scene is untouched: nothing to undo, save, or share.
  expect(now.visible).toEqual([true, true, true]);
  expect(now.revision).toBe(before.revision);
  expect(now.past).toBe(before.past);
  const notice = page.getByRole('region', { name: 'Isolation' });
  await expect(notice).toContainText('Moving piece');
  await expect(page.locator('.part-row.outside-isolation')).toHaveCount(2);
  await expect(page.locator('.part-row .part-isolated-icon')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Exit isolation (I)', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');

  // A part left out of the view cannot be clicked.
  const hidden = await screenPoint(page, 'b', front);
  await page.mouse.click(hidden.x, hidden.y);
  expect((await view(page)).selected).toEqual([]);

  await page.keyboard.press('i');
  await settled(page);
  now = await view(page);
  expect(now.isolated).toBeNull();
  expect(now.shown).toEqual({ a: true, b: true, c: true });
  expect(await drawn(page, 'b', front)).toBe(true);
  await expect(notice).toHaveCount(0);
  await expect(page.locator('.part-row.outside-isolation')).toHaveCount(0);
});

test('Shift+I also draws other parts where they come within the distance', async ({ page }) => {
  await page.keyboard.press('Shift+I');
  await expect.poll(async () => (await view(page)).detail).not.toBeNull();
  let now = await view(page);
  expect(now.isolated).toEqual(['a']);
  expect(now.settings).toEqual({ nearby: true, distance: 2 });
  // Only the neighbor is in reach. Its facing side is 1 mm away, so 2 mm reaches 1 mm around
  // the corner onto its front, and the rest is cut away.
  expect(now.shown).toEqual({ a: true, b: true, c: false });
  expect(await drawn(page, 'b', [-7.5, 0, 8])).toBe(true);
  expect(await drawn(page, 'b', [-6.4, 0, 8])).toBe(false);
  expect(await drawn(page, 'b', front)).toBe(false);

  await setDistance(page, '4');
  await expect.poll(() => drawn(page, 'b', [-5.6, 0, 8])).toBe(true);
  expect(await drawn(page, 'b', [-4.4, 0, 8])).toBe(false);
  const field = (await view(page)).field.b;
  expect(field).not.toBeNull();

  // Moving the isolated part carries the cut along without measuring the field again.
  await edit(page, `state.transform('a', { position: [-10.5, 30, 0] })`);
  expect(await drawn(page, 'b', [-5.6, 0, 8])).toBe(false);
  expect(await drawn(page, 'b', [-7.5, 0, 8])).toBe(true);
  now = await view(page);
  expect(now.field.b).toBe(field);
  await edit(page, `state.undo()`);
  expect(await drawn(page, 'b', [-5.6, 0, 8])).toBe(true);
  expect((await view(page)).isolated).toEqual(['a']);

  // A distance inside the same reach is only a new limit.
  await setDistance(page, '3');
  await settled(page);
  expect(await drawn(page, 'b', [-5.6, 0, 8])).toBe(false);
  expect(await drawn(page, 'b', [-6.5, 0, 8])).toBe(true);
  expect((await view(page)).field.b).toBe(field);

  // Closer than the gap, nothing of the neighbor remains.
  await setDistance(page, '0.5');
  await expect.poll(() => drawn(page, 'b', [-7.8, 0, 8])).toBe(false);

  await setDistance(page, '4');
  await expect.poll(() => drawn(page, 'b', [-5.6, 0, 8])).toBe(true);
  await page.getByRole('switch', { name: 'Nearby surfaces' }).click();
  await settled(page);
  now = await view(page);
  expect(now.settings).toEqual({ nearby: false, distance: 4 });
  expect(now.shown).toEqual({ a: true, b: false, c: false });
  expect(await drawn(page, 'b', [-5.6, 0, 8])).toBe(false);

  // The preference is remembered, and the isolation itself is not.
  await page.reload();
  await expect(page.locator('canvas')).toBeVisible();
  // The viewport may still be starting, so keep asking until it answers.
  await expect
    .poll(async () => (await view(page).catch(() => null))?.settings)
    .toEqual({ nearby: false, distance: 4 });
  expect((await view(page)).isolated).toBeNull();
});

test('nearby surfaces can be clicked and picked, and cut-away ones cannot', async ({ page }) => {
  await page.keyboard.press('Shift+I');
  await setDistance(page, '4');
  await expect.poll(() => drawn(page, 'b', [-5.6, 0, 8])).toBe(true);

  const cut = await screenPoint(page, 'b', front);
  await page.mouse.click(cut.x, cut.y);
  expect((await view(page)).selected).toEqual([]);
  const near = await screenPoint(page, 'b', [-6.5, 0, 8]);
  await page.mouse.click(near.x, near.y);
  expect((await view(page)).selected).toEqual(['b']);

  // Alignment picks land on the nearby surface of the cut-away target.
  await page.locator('.part-select[title="Moving piece"]').click();
  await page.keyboard.press('a');
  await settled(page);
  const source = await screenPoint(page, 'a', front);
  await page.mouse.click(source.x, source.y);
  await page.mouse.click(cut.x, cut.y);
  expect((await view(page)).picked).toEqual([]);
  await page.mouse.click(near.x, near.y);
  expect((await view(page)).picked).toEqual(['b']);
  await page.keyboard.press('Escape');

  // A part too far away to be drawn offers no gizmo to drag blind.
  await page.keyboard.press('g');
  await page.locator('.part-select[title="Far piece"]').click();
  await settled(page);
  expect((await view(page)).gizmo).toBe(false);
  await page.locator('.part-select[title="Target piece"]').click();
  await settled(page);
  expect((await view(page)).gizmo).toBe(true);
  await page.keyboard.press('v');
  await page.locator('.part-select[title="Moving piece"]').click();

  // From the far side the facing surface shows through the cut, and so does a click.
  await page.keyboard.press('3');
  await settled(page);
  const through = await screenPoint(page, 'b', [8, 0, 0]);
  await page.mouse.click(through.x, through.y);
  expect((await view(page)).selected).toEqual(['b']);
});

test('menus, the isolation bar, and framing follow the isolated view', async ({ page }) => {
  await page.locator('.part-select[title="Moving piece"]').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Component actions' });
  const isolate = menu.getByRole('menuitem', { name: 'Isolate selected' });
  await expect(isolate.locator('kbd')).toHaveText('I');
  await expect(menu.getByRole('menuitem', { name: 'Hide others' })).toBeVisible();
  await isolate.click();
  expect((await view(page)).isolated).toEqual(['a']);

  // Frame all means everything in the isolated view.
  await page.keyboard.press('Home');
  await settled(page);
  const close = (await view(page)).cameraDistance;

  // The interference view compares what the isolated view shows.
  await page.getByRole('button', { name: 'Interference' }).click();
  await expect(page.getByRole('region', { name: 'Interference inspection' })).toContainText(
    'at least two visible parts',
  );
  await page.getByRole('button', { name: 'Close interference view', exact: true }).click();

  // Selecting another part in the list and pressing I moves the isolation to it.
  await page.locator('.part-select[title="Target piece"]').click();
  await page.keyboard.press('g');
  await settled(page);
  expect((await view(page)).gizmo).toBe(false);
  await page.keyboard.press('i');
  await settled(page);
  let now = await view(page);
  expect(now.isolated).toEqual(['b']);
  expect(now.shown).toEqual({ a: false, b: true, c: false });
  expect(now.gizmo).toBe(true);
  await page.keyboard.press('v');

  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.locator('.dropdown-menu button', { hasText: 'Exit isolation' }).click();
  expect((await view(page)).isolated).toBeNull();
  await page.keyboard.press('Home');
  await settled(page);
  expect((await view(page)).cameraDistance).toBeGreaterThan(close * 1.5);

  await page.getByRole('button', { name: 'Isolate selection (I)', exact: true }).click();
  expect((await view(page)).isolated).toEqual(['b']);
  await page.getByRole('button', { name: 'Exit isolation', exact: true }).click();
  now = await view(page);
  expect(now.isolated).toBeNull();
  expect(now.shown).toEqual({ a: true, b: true, c: true });

  // Deleting the isolated part ends the isolation instead of leaving an empty view.
  await page.keyboard.press('i');
  await page.keyboard.press('Delete');
  await settled(page);
  now = await view(page);
  expect(now.isolated).toBeNull();
  expect(now.shown).toEqual({ a: true, c: true });
});

test('nearby surfaces around a dense part appear without holding the viewport', async ({
  page,
}) => {
  test.setTimeout(120000);
  // A 1.2-million-triangle sphere whose surface passes 1 mm from the far piece. Around the
  // corner, the piece's front is within 4 mm for about its last 1.6 mm.
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!;
    const { useEditor } = await import(url);
    const state = useEditor.getState();
    const sample = state.scene.parts[0].geometry;
    const rings = 548,
      segments = 1096,
      radius = 20;
    const positions = new Float32Array(rings * segments * 18);
    let at = 0;
    const put = (ring: number, segment: number) => {
      const polar = (ring / rings) * Math.PI,
        turn = (segment / segments) * Math.PI * 2;
      positions[at++] = radius * Math.sin(polar) * Math.cos(turn);
      positions[at++] = radius * Math.cos(polar);
      positions[at++] = radius * Math.sin(polar) * Math.sin(turn);
    };
    for (let ring = 0; ring < rings; ring++)
      for (let segment = 0; segment < segments; segment++) {
        put(ring, segment);
        put(ring, segment + 1);
        put(ring + 1, segment);
        put(ring + 1, segment);
        put(ring, segment + 1);
        put(ring + 1, segment + 1);
      }
    const geometry = new sample.constructor();
    const Attribute = sample.getAttribute('position').constructor;
    geometry.setAttribute('position', new Attribute(positions, 3));
    geometry.computeVertexNormals();
    state.addParts([
      {
        id: 'dense',
        name: 'Dense scan',
        geometry,
        position: [69, 30, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        color: '#c5c2b8',
        visible: true,
        locked: false,
        source: 'test',
      },
    ]);
    // The longest time the page went without reaching a frame.
    const stalls = ((window as any).stalls = { longest: 0, running: true });
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      stalls.longest = Math.max(stalls.longest, now - last);
      last = now;
      if (stalls.running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.keyboard.press('1');
  await settled(page);
  await page.evaluate(() => ((window as any).stalls.longest = 0));
  await page.keyboard.press('Shift+I');
  await expect.poll(async () => (await view(page)).detail, { timeout: 30000 }).not.toBeNull();
  await setDistance(page, '4');
  await expect.poll(() => drawn(page, 'c', [7.5, 0, 8]), { timeout: 30000 }).toBe(true);
  const longest = await page.evaluate(() => {
    (window as any).stalls.running = false;
    return (window as any).stalls.longest as number;
  });
  expect(longest).toBeLessThan(250);
  const now = await view(page);
  expect(now.isolated).toEqual(['dense']);
  expect(now.shown).toEqual({ a: false, b: false, c: true, dense: true });
  expect(await drawn(page, 'c', [5, 0, 8])).toBe(false);
});
