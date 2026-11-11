import { expect, test, type Page } from '@playwright/test';
import { Quaternion, Vector3 } from 'three';

async function cameraState(page: Page) {
  return page.evaluate(async () => {
    // Use the renderer's actual module instance and live camera, rather than a mock.
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => url.includes('/@react-three_fiber.js'))!;
    const fiber = await import(url);
    // A page that has just loaded shows its canvas a moment before the renderer takes it.
    while (!fiber._roots.get(document.querySelector('canvas')))
      await new Promise((resolve) => setTimeout(resolve, 10));
    const { camera, controls } = fiber._roots
      .get(document.querySelector('canvas'))
      .store.getState();
    const storePath = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!;
    const editor = (await import(storePath)).useEditor.getState();
    return {
      position: camera.position.toArray() as [number, number, number],
      target: controls.target.toArray() as [number, number, number],
      quaternion: camera.quaternion.toArray() as [number, number, number, number],
      zoom: camera.zoom as number,
      distance: controls.getDistance() as number,
      selection: editor.selected as string[],
      revision: editor.revision as number,
      parts: editor.scene.parts.map(
        (part: { id: string; position: number[]; quaternion: number[]; scale: number[] }) => ({
          id: part.id,
          position: part.position,
          quaternion: part.quaternion,
          scale: part.scale,
        }),
      ),
      pending: editor.operation.pending,
      pairs: editor.operation.pairs,
    };
  });
}

async function dragView(page: Page, dx = 90, dy = 35, button: 'left' | 'right' = 'left') {
  const box = (await page.locator('canvas').boundingBox())!;
  const x = box.x + box.width * 0.5,
    y = box.y + box.height * 0.42;
  await page.mouse.move(x, y);
  await page.mouse.down({ button });
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up({ button });
}

function close(a: number[], b: number[], precision = 5) {
  a.forEach((value, i) => expect(value).toBeCloseTo(b[i], precision));
}

function orbitsAround(
  before: Awaited<ReturnType<typeof cameraState>>,
  after: Awaited<ReturnType<typeof cameraState>>,
  pivot: number[],
) {
  const rotation = new Quaternion(...after.quaternion).multiply(
    new Quaternion(...before.quaternion).invert(),
  );
  for (const key of ['position', 'target'] as const)
    close(
      after[key],
      new Vector3(...before[key])
        .sub(new Vector3(...pivot))
        .applyQuaternion(rotation)
        .add(new Vector3(...pivot))
        .toArray(),
      4,
    );
  expect(after.distance).toBeCloseTo(before.distance, 4);
}

const torsoCenter = [0, 75.75, 1.375];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Orbit tool (O)', exact: true })).toBeVisible();
  await page.locator('.part-select[title="Torso shell"]').click();
});

test('orbits and pans with real left drags and buttons without moving or deselecting parts', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const before = await cameraState(page);
  await page.getByRole('button', { name: 'Orbit tool (O)', exact: true }).click();
  close((await cameraState(page)).position, before.position);
  close((await cameraState(page)).target, before.target);
  await page.keyboard.press('.');
  const centered = await cameraState(page);
  await dragView(page);
  await page.keyboard.press('h'); // Settles any orbit damping before the pan begins.
  const orbited = await cameraState(page);
  expect(
    new Vector3(...orbited.position).distanceTo(new Vector3(...centered.position)),
  ).toBeGreaterThan(10);
  close(orbited.target, torsoCenter);
  expect(orbited.distance).toBeCloseTo(centered.distance, 5);
  await expect(page.getByRole('button', { name: 'Pan tool (H)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dragView(page, 80, -25);
  await page.getByRole('button', { name: 'Exit camera tool (Esc)', exact: true }).click();
  const panned = await cameraState(page);
  expect(new Vector3(...panned.target).distanceTo(new Vector3(...orbited.target))).toBeGreaterThan(
    1,
  );
  close(
    new Vector3(...panned.position).sub(new Vector3(...orbited.position)).toArray(),
    new Vector3(...panned.target).sub(new Vector3(...orbited.target)).toArray(),
  );
  expect(
    new Quaternion(...panned.quaternion).angleTo(new Quaternion(...orbited.quaternion)),
  ).toBeLessThan(1e-6);
  expect(panned.zoom).toBe(orbited.zoom);
  expect(panned.selection).toEqual(before.selection);
  expect(panned.parts).toEqual(before.parts);
  expect(panned.revision).toBe(before.revision);
  await page.keyboard.press('h');
  const stepBefore = await cameraState(page);
  await page.getByRole('button', { name: 'Pan right', exact: true }).click();
  const stepped = await cameraState(page);
  expect(
    new Vector3(...stepped.target).distanceTo(new Vector3(...stepBefore.target)),
  ).toBeGreaterThan(1);
  await page.keyboard.press('o');
  const orbitBefore = await cameraState(page);
  await page.getByRole('button', { name: 'Orbit up', exact: true }).click();
  const orbitAfter = await cameraState(page);
  orbitsAround(orbitBefore, orbitAfter, torsoCenter);
  expect(orbitAfter.distance).toBeCloseTo(orbitBefore.distance, 5);
  expect(
    new Vector3(...orbitAfter.position).distanceTo(new Vector3(...orbitBefore.position)),
  ).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});

test('sets a selection pivot without zooming, toggles the default, and persists the preference', async ({
  page,
}) => {
  const preference = page.getByRole('switch', { name: 'Orbit around selection by default' });
  await expect(preference).toHaveAttribute('aria-checked', 'true');
  await preference.click();
  await expect(preference).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Home');
  const all = await cameraState(page);
  await page.keyboard.press('o');
  close((await cameraState(page)).target, all.target);
  await dragView(page, 60, 10);
  await page.keyboard.press('Escape');
  const off = await cameraState(page);
  close(off.target, all.target);
  await page.keyboard.press('.');
  const pivoted = await cameraState(page);
  close(pivoted.target, torsoCenter);
  expect(pivoted.distance).toBeCloseTo(off.distance, 5);
  expect(pivoted.zoom).toBe(off.zoom);
  expect(
    new Quaternion(...pivoted.quaternion).angleTo(new Quaternion(...off.quaternion)),
  ).toBeLessThan(1e-6);
  await page.reload();
  await expect(preference).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Shift+.');
  await expect(preference).toHaveAttribute('aria-checked', 'true');
  await page.locator('.part-select[title="Left arm"]').click();
  await page.keyboard.press('o');
  const selected = await cameraState(page);
  expect(selected.selection).toEqual(['arm-L']);
  await dragView(page, 60, 15);
  await page.keyboard.press('Escape');
  const armPivot = await page.evaluate(async () => {
    const resource = performance.getEntriesByType('resource').map((entry) => entry.name);
    const store = (
      await import(resource.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!)
    ).useEditor.getState();
    const navigation = await import(
      resource.find((url) => /\/src\/core\/navigation\.ts(?:\?.*)?$/.test(url))!
    );
    return navigation.selectionOrbitCenter(store.scene.parts, store.selected).toArray();
  });
  orbitsAround(selected, await cameraState(page), armPivot);
});

test('navigates during alignment and returns to the same picked source', async ({ page }) => {
  await page.getByRole('button', { name: 'Align A', exact: true }).click();
  const canvas = page.locator('canvas'),
    box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.43 } });
  await expect(page.getByText('Now click the matching target surface.')).toBeVisible();
  const picked = await cameraState(page);
  expect(picked.pending).not.toBeNull();
  await page.keyboard.press('o');
  await dragView(page);
  await page.keyboard.press('h');
  await dragView(page, -40, 20);
  await page.keyboard.press('Escape');
  await expect(page.getByText('Now click the matching target surface.')).toBeVisible();
  const returned = await cameraState(page);
  expect(returned.pending).toEqual(picked.pending);
  expect(returned.pairs).toEqual(picked.pairs);
  expect(returned.parts).toEqual(picked.parts);
  // Editing shortcuts explicitly leave the camera tool and bring back the gizmo.
  await page.keyboard.press('o');
  await page.keyboard.press('g');
  await expect(page.getByRole('button', { name: 'Orbit tool (O)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByRole('button', { name: 'Move (G)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('supports orthographic camera navigation and leaves shortcuts alone in text fields', async ({
  page,
}) => {
  await page.keyboard.press('5');
  await expect(page.getByRole('button', { name: 'Orthographic', exact: true })).toBeVisible();
  const before = await cameraState(page);
  await page.keyboard.press('NumpadDecimal');
  const centered = await cameraState(page);
  close(centered.target, torsoCenter);
  expect(centered.zoom).toBe(before.zoom);
  expect(centered.parts).toEqual(before.parts);
  expect(centered.selection).toEqual(before.selection);
  await page.keyboard.press('h');
  await page.getByRole('button', { name: 'Pan down', exact: true }).click();
  const panned = await cameraState(page);
  expect(panned.target).not.toEqual(centered.target);
  expect(panned.zoom).toBe(centered.zoom);
  await page.keyboard.press('o');
  close((await cameraState(page)).position, panned.position);
  close((await cameraState(page)).target, panned.target);
  await page.getByRole('button', { name: 'Orbit left', exact: true }).click();
  const rotated = await cameraState(page);
  orbitsAround(panned, rotated, torsoCenter);
  expect(rotated.zoom).toBe(centered.zoom);
  await page.keyboard.press('Escape');
  const search = page.getByRole('textbox', { name: 'Search parts' });
  await search.fill('o.h');
  await expect(search).toHaveValue('o.h');
  await expect(page.getByRole('button', { name: 'Orbit tool (O)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByRole('button', { name: 'Pan tool (H)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('keeps camera tools and selection controls accessible on a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Orbit tool (O)', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Camera navigation' });
  await expect(panel).toBeVisible();
  for (const name of [
    'Orbit up',
    'Orbit left',
    'Orbit right',
    'Orbit down',
    'Center orbit on selection (.)',
  ]) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeInViewport();
  }
  await page.getByRole('button', { name: 'Orbit right', exact: true }).click();
  await page.getByRole('button', { name: 'Pan tool (H)', exact: true }).click();
  await page.getByRole('button', { name: 'Pan left', exact: true }).click();
  await expect(
    page.getByRole('switch', { name: 'Orbit around selection by default' }),
  ).toBeInViewport();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test('preserves pan when orbiting a moved selection with drags and buttons', async ({ page }) => {
  const x = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await x.fill('35');
  await x.press('Enter');
  const before = await cameraState(page);
  await dragView(page, 55, 10);
  await page.keyboard.press('h'); // Settle damping, then return to normal selection.
  await page.keyboard.press('Escape');
  const orbited = await cameraState(page);
  orbitsAround(before, orbited, [35, 75.75, 1.375]);
  expect(orbited.selection).toEqual(['torso']);
  expect(orbited.parts).toEqual(before.parts);
  await dragView(page, 60, -10, 'right');
  await page.keyboard.press('h');
  await page.keyboard.press('Escape');
  const panned = await cameraState(page);
  expect(new Vector3(...panned.target).distanceTo(new Vector3(...orbited.target))).toBeGreaterThan(
    1,
  );
  await dragView(page, -55, 5);
  await page.keyboard.press('h');
  await page.keyboard.press('Escape');
  const afterDrag = await cameraState(page);
  orbitsAround(panned, afterDrag, [35, 75.75, 1.375]);
  await page.keyboard.press('o');
  close((await cameraState(page)).position, afterDrag.position);
  close((await cameraState(page)).target, afterDrag.target);
  await page.getByRole('button', { name: 'Orbit right', exact: true }).click();
  orbitsAround(afterDrag, await cameraState(page), [35, 75.75, 1.375]);
});

test('retains the panned view around a clicked surface pivot', async ({ page }) => {
  await page.keyboard.press('p');
  const box = (await page.locator('canvas').boundingBox())!;
  await page.locator('canvas').click({ position: { x: box.width * 0.5, y: box.height * 0.43 } });
  await expect(page.getByText(/Pivot set · orbit, rotate/)).toBeVisible();
  const pivot = (await cameraState(page)).target;
  await page.keyboard.press('h');
  await page.getByRole('button', { name: 'Pan right', exact: true }).click();
  const panned = await cameraState(page);
  expect(panned.target).not.toEqual(pivot);
  await page.keyboard.press('o');
  close((await cameraState(page)).position, panned.position);
  close((await cameraState(page)).target, panned.target);
  await dragView(page, 40, -15);
  await page.keyboard.press('Escape');
  const afterDrag = await cameraState(page);
  orbitsAround(panned, afterDrag, pivot);
  await page.keyboard.press('o');
  await page.getByRole('button', { name: 'Orbit down', exact: true }).click();
  orbitsAround(afterDrag, await cameraState(page), pivot);
});
