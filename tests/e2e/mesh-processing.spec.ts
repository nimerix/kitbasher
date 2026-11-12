import { expect, test, type Page } from '@playwright/test';
import { SphereGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';
import { readSavedScene } from './saved-scene';

async function seed(page: Page, dense = false) {
  const geometry = serializeGeometry(
    new SphereGeometry(10, dense ? 320 : 64, dense ? 192 : 48).translate(30, 20, 40),
  );
  await page.evaluate(async (geometry) => {
    const storeUrl = '/src/core/store.ts',
      geometryUrl = '/src/core/geometry.ts';
    const { useEditor } = await import(storeUrl);
    const { deserializeGeometry } = await import(geometryUrl);
    const state = useEditor.getState();
    state.setScene({
      name: 'Scan test',
      joints: [],
      parts: [
        {
          id: 'scan',
          name: 'Dense scan',
          geometry: deserializeGeometry(geometry),
          position: [0, 0, 0],
          quaternion: [0, 0, 0, 1],
          scale: [1, 1, 1],
          color: '#b3bdc7',
          visible: true,
          locked: false,
          source: 'test',
        },
      ],
    });
    state.select('scan');
    state.focus(undefined, true);
  }, geometry);
}

async function parts(page: Page) {
  return page.evaluate(async () => {
    const url = '/src/core/store.ts';
    const { useEditor } = await import(url);
    return useEditor.getState().scene.parts.map((p: any) => ({
      id: p.id,
      visible: p.visible,
      uuid: p.geometry.uuid,
      triangles: (p.geometry.index?.count ?? p.geometry.attributes.position.count) / 3,
    }));
  });
}

test('decimates in a worker, keeps the original, saves both, and restores with undo', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await seed(page);
  const original = await parts(page);
  await page.getByRole('button', { name: 'Decimate or remesh…' }).click();
  await page.getByRole('button', { name: 'Prepare mesh' }).click();
  await expect(page.getByRole('button', { name: 'Add processed copy' })).toBeEnabled();
  await page.getByRole('button', { name: 'Add processed copy' }).click();
  const result = await parts(page);
  expect(result).toHaveLength(2);
  expect(result[0]).toEqual({ ...original[0], visible: false });
  expect(result[1].triangles).toBeLessThan(original[0].triangles);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const savedPath = testInfo.outputPath('processed.kitbash');
  await (await download).saveAs(savedPath);
  const saved = await readSavedScene(savedPath);
  expect(saved.scene.parts).toHaveLength(2);
  expect(saved.scene.parts[0].visible).toBe(false);
  expect(saved.scene.parts[0].geometry.index!.count / 3).toBe(original[0].triangles);
  expect(saved.scene.parts[1].geometry.index!.count / 3).toBe(result[1].triangles);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await parts(page)).toEqual(original);
  expect(errors).toEqual([]);
});

test('remeshes and cancels without modifying the scene', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  // Translation makes the sphere's tiny pole/seam differences round to identical Float32 positions.
  await seed(page);
  const original = await parts(page);
  await page.getByRole('button', { name: 'Decimate or remesh…' }).click();
  await page.getByRole('radio', { name: 'Voxel remesh' }).click();
  await page.getByLabel('Voxel resolution').fill('32');
  await page.getByRole('button', { name: 'Prepare mesh' }).click();
  await expect(page.getByRole('button', { name: 'Add processed copy' })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await parts(page)).toEqual(original);
});

test('draws a proxy in Fast mode while retaining full geometry for tools and scene data', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await seed(page, true);
  const original = await parts(page);
  await page.getByRole('button', { name: /Display:/ }).click();
  await page.getByRole('radio', { name: 'Fast', exact: true }).click();
  await page.keyboard.press('Escape');
  const displayed = () =>
    page.evaluate(async () => {
      const url = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((url) => url.includes('/@react-three_fiber.js'))!;
      const root = (await import(url))._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const mesh = root.scene.getObjectByName('part:scan');
      return {
        uuid: mesh.geometry.uuid,
        triangles: (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3,
      };
    });
  await expect
    .poll(async () => (await displayed()).triangles)
    .toBeLessThan(original[0].triangles * 0.9);
  expect(await parts(page)).toEqual(original);
  await page.evaluate(async () => {
    const url = '/src/core/store.ts';
    (await import(url)).useEditor.getState().setTool('measure');
  });
  await expect.poll(async () => (await displayed()).uuid).toBe(original[0].uuid);
  await page.evaluate(async () => {
    const url = '/src/core/store.ts';
    (await import(url)).useEditor.getState().setTool('select');
  });
  await expect
    .poll(async () => (await displayed()).triangles)
    .toBeLessThan(original[0].triangles * 0.9);
  await page.getByRole('button', { name: /Display:/ }).click();
  await page.getByRole('radio', { name: 'Full', exact: true }).click();
  await expect.poll(async () => (await displayed()).uuid).toBe(original[0].uuid);
});
