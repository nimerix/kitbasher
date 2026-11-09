import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';
import { readSavedScene } from './saved-scene';

const fixture = {
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Anchor fitting',
  joints: [],
  parts: [
    {
      id: 'moving',
      name: 'Scanned part',
      geometry: serializeGeometry(new BoxGeometry(32, 32, 2)),
      position: [0, 24, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: '#d4a272',
      visible: true,
      locked: false,
      source: 'test',
    },
  ],
};

async function state(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((e) => e.name);
    const { useEditor } = await import(
      urls.find((u) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(u))!
    );
    const s = useEditor.getState();
    return {
      parts: s.scene.parts.map(({ geometry, ...part }: any) => ({
        ...part,
        vertices: Array.from(geometry.getAttribute('position').array),
      })),
      past: s.past.length,
      tool: s.tool,
      picking: s.anchorPicking,
    };
  });
}

async function screenPoint(page: Page, local: number[] | 'handle') {
  const box = (await page.locator('canvas').boundingBox())!;
  const ndc = await page.evaluate(async (local) => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((u) => u.includes('/@react-three_fiber.js'))!;
    const root = (await import(url))._roots.get(document.querySelector('canvas')).store.getState();
    let point = root.camera.position.clone();
    if (local === 'handle') {
      let controls: any;
      root.scene.traverse((object: any) => {
        if (object.isTransformControls && object.visible) controls = object;
      });
      const handle = controls.gizmo.picker.translate.children.find((o: any) => o.name === 'X');
      handle.geometry.computeBoundingBox();
      point = handle.geometry.boundingBox.getCenter(point);
      handle.localToWorld(point);
    } else {
      const mesh = root.scene.getObjectByName('part:moving');
      mesh.updateWorldMatrix(true, false);
      mesh.localToWorld(point.fromArray(local));
    }
    return point.project(root.camera).toArray();
  }, local);
  return { x: box.x + ((ndc[0] + 1) * box.width) / 2, y: box.y + ((1 - ndc[1]) * box.height) / 2 };
}

async function setup(page: Page) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'anchors.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Scanned part"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page.getByTitle('Rigid anchor fit (K)').click();
  for (const local of [
    [-10, -10, 1],
    [10, -10, 1],
    [0, 10, 1],
  ]) {
    const p = await screenPoint(page, local);
    await page.mouse.click(p.x, p.y);
  }
  await expect(page.getByRole('button', { name: 'Remove anchor 3', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Finish adding anchors', exact: true }).click();
}

test('picks surface anchors, fits numerically, undoes, and saves/reopens the unchanged mesh', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setup(page);
  const before = await state(page);
  const field = page.getByRole('spinbutton', { name: 'Anchor target Z', exact: true });
  await field.fill('1.3');
  await field.press('Enter');
  const fitted = await state(page);
  expect(fitted.parts[0].quaternion).not.toEqual(before.parts[0].quaternion);
  expect(fitted.parts[0].anchors[2].target[2]).toBe(1.3);
  expect(fitted.parts[0].anchors.slice(0, 2)).toEqual(before.parts[0].anchors.slice(0, 2));
  expect(fitted.parts[0].scale).toEqual(before.parts[0].scale);
  expect(fitted.parts[0].vertices).toEqual(before.parts[0].vertices);
  await page.getByRole('button', { name: 'Undo (Ctrl/⌘ Z)', exact: true }).click();
  expect((await state(page)).parts).toEqual(before.parts);
  await page.getByRole('button', { name: 'Redo (Ctrl/⌘ Shift Z)', exact: true }).click();
  expect((await state(page)).parts).toEqual(fitted.parts);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const { scene, bytes } = await readSavedScene((await (await downloaded).path())!);
  expect(scene.parts[0].anchors).toEqual(fitted.parts[0].anchors);
  await page
    .getByLabel('Open Kitbasher scene')
    .setInputFiles({ name: 'saved.kitbash', mimeType: 'application/octet-stream', buffer: bytes });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Scanned part"]').click();
  await page.keyboard.press('k');
  await expect(
    page.getByRole('button', { name: 'Select anchor 3 target', exact: true }),
  ).toBeVisible();
  expect((await state(page)).parts).toEqual(fitted.parts);
  await page.getByRole('button', { name: 'Hold current positions', exact: true }).click();
  await expect(page.getByText(/Fit gap: 0.000 mm RMS/)).toBeVisible();
  await page.getByRole('button', { name: 'Remove anchor 3', exact: true }).click();
  expect((await state(page)).parts[0].anchors).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('drags an anchor handle as one undo step, with Shift precision and camera recovery', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setup(page);
  const before = await state(page);
  const drag = async (fine: boolean) => {
    const handle = await screenPoint(page, 'handle');
    await page.mouse.move(handle.x, handle.y);
    if (fine) await page.keyboard.down('Shift');
    await page.mouse.down();
    await page.mouse.move(handle.x + 40, handle.y, { steps: 8 });
    await page.mouse.up();
    if (fine) await page.keyboard.up('Shift');
  };
  await drag(false);
  const coarse = await state(page);
  expect(coarse.past).toBe(before.past + 1);
  const delta = coarse.parts[0].anchors[2].target[0] - before.parts[0].anchors[2].target[0];
  expect(Math.abs(delta)).toBeGreaterThan(0.1);
  expect(coarse.parts[0].anchors).toHaveLength(3);
  await page.getByRole('button', { name: 'Undo (Ctrl/⌘ Z)', exact: true }).click();
  expect((await state(page)).parts).toEqual(before.parts);
  await page.keyboard.press('k');
  await drag(true);
  const fine = await state(page);
  const small = fine.parts[0].anchors[2].target[0] - before.parts[0].anchors[2].target[0];
  expect(small / delta).toBeCloseTo(0.1, 3);
  expect(fine.past).toBe(before.past + 1);
  expect(fine.parts[0].vertices).toEqual(before.parts[0].vertices);
  await page.keyboard.press('o');
  await page.getByRole('button', { name: 'Orbit right', exact: true }).click();
  await page.keyboard.press('Escape');
  expect((await state(page)).parts).toEqual(fine.parts);
  expect(errors).toEqual([]);
});
