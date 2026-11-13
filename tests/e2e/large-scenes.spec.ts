import { expect, test, type Page } from '@playwright/test';
import { readFile, rm, stat } from 'node:fs/promises';

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
});
test.afterEach(({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

/** Hidden, so the check covers files and memory without depending on the test machine's GPU. */
function addDensePart(page: Page, triangles: number) {
  return page.evaluate(async (triangles) => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!;
    const { useEditor } = await import(url);
    const state = useEditor.getState();
    const sample = state.scene.parts[0].geometry;
    const positions = new Float32Array(triangles * 9),
      normals = new Float32Array(triangles * 9);
    for (let i = 0; i < positions.length; i++) {
      positions[i] = Math.sin(i) * 137.123;
      normals[i] = Math.cos(i);
    }
    const geometry = new sample.constructor();
    const Attribute = sample.getAttribute('position').constructor;
    geometry.setAttribute('position', new Attribute(positions, 3));
    geometry.setAttribute('normal', new Attribute(normals, 3));
    state.addParts([
      {
        id: 'dense',
        name: 'Dense scan',
        geometry,
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        color: '#c5c2b8',
        visible: false,
        locked: false,
        source: 'test',
      },
    ]);
  }, triangles);
}

function meshChecksum(page: Page, id: string) {
  return page.evaluate(async (id) => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!;
    const { useEditor } = await import(url);
    const part = useEditor.getState().scene.parts.find((part: { id: string }) => part.id === id);
    let hash = 0x811c9dc5;
    let words = 0;
    for (const name of ['position', 'normal']) {
      const values = new Uint32Array(part.geometry.getAttribute(name).array.buffer);
      words += values.length;
      for (let i = 0; i < values.length; i++) hash = Math.imul(hash ^ values[i], 16777619);
    }
    return { hash: hash >>> 0, words };
  }, id);
}

test('saves and reopens a scene far past the browser text limit', async ({ page }, testInfo) => {
  test.setTimeout(240000);
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  const triangles = 3_000_000;
  await addDensePart(page, triangles);
  const original = await meshChecksum(page, 'dense');

  const saved = page.waitForEvent('download', { timeout: 60000 });
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const path = testInfo.outputPath('large.kitbash');
  await (await saved).saveAs(path);
  await expect(page.locator('.toast-error')).toHaveCount(0);
  const { size } = await stat(path);
  // These values share nothing, so they pack to about their own size: 24 bytes per vertex.
  expect(size).toBeGreaterThan(triangles * 3 * 24 * 0.95);
  expect(size).toBeLessThan(triangles * 3 * 24 * 1.05);

  await page.keyboard.press('ControlOrMeta+n');
  await page.locator('.new-options button').first().click();
  await expect(page.locator('.part-select')).toHaveCount(0);

  await page.getByLabel('Open Kitbasher scene').setInputFiles(path);
  await page.getByRole('button', { name: 'Open scene', exact: true }).click({ timeout: 60000 });
  await expect(page.locator('.part-select[title="Dense scan"]')).toBeVisible();
  expect(await meshChecksum(page, 'dense')).toEqual(original);
  await rm(path);
});

async function storedRecovery(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ name: string; version: number; parts: number; meshes: number }>(
        (resolve, reject) => {
          const open = indexedDB.open('kitbasher-workbench');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const transaction = db.transaction(['scenes', 'geometries']);
            const scene = transaction.objectStore('scenes').get('current');
            const meshes = transaction.objectStore('geometries').count();
            transaction.oncomplete = () => {
              db.close();
              resolve({
                name: scene.result.name,
                version: scene.result.version,
                parts: scene.result.parts.length,
                meshes: meshes.result,
              });
            };
          };
        },
      ),
  );
}

const countPuts = () => {
  const counts = { scenes: 0, geometries: 0 };
  (window as unknown as { puts: typeof counts }).puts = counts;
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: [unknown, IDBValidKey?]) {
    counts[this.name as keyof typeof counts]++;
    return put.apply(this, args);
  };
};
const puts = (page: Page) =>
  page.evaluate(() => (window as unknown as { puts: { scenes: number; geometries: number } }).puts);
const saved = (page: Page) =>
  expect(page.getByText('Saved locally', { exact: true })).toBeVisible();

test('autosave writes each mesh once, however many edits follow', async ({ page }) => {
  await page.addInitScript(countPuts);
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await expect.poll(async () => (await puts(page)).geometries).toBe(15);
  await saved(page);

  await page.locator('.part-select[title="Torso shell"]').click();
  const x = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await x.fill('12');
  await x.press('Enter');
  const edited = (await puts(page)).scenes;
  await expect.poll(async () => (await puts(page)).scenes).toBeGreaterThan(edited);
  await saved(page);
  expect((await puts(page)).geometries).toBe(15);

  // A duplicate shares its mesh, so the copy adds nothing to storage.
  await page.keyboard.press('ControlOrMeta+d');
  await expect.poll(async () => (await storedRecovery(page)).parts).toBe(16);
  expect((await puts(page)).geometries).toBe(15);
  expect((await storedRecovery(page)).meshes).toBe(15);

  await page.reload();
  await expect(page.getByText('Recovered your local assembly')).toBeVisible();
  await expect(page.locator('.part-select[title="Torso shell copy"]')).toBeVisible();
  await page.locator('.part-select[title="Torso shell"]').click();
  await expect(x).toHaveValue('12');
  await x.fill('20');
  await x.press('Enter');
  await saved(page);
  expect((await puts(page)).geometries).toBe(0);

  // Removing a mesh's only parts removes the mesh.
  await page.locator('.part-select[title="Left foot"]').click();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await storedRecovery(page)).meshes).toBe(14);
});

test('a failed mesh write keeps the previous save and recovers later', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await saved(page);
  const before = await storedRecovery(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    (window as unknown as { restorePut: () => void }).restorePut = () => {
      IDBObjectStore.prototype.put = put;
    };
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      ...args: [unknown, IDBValidKey?]
    ) {
      if (this.name === 'geometries') throw new DOMException('No space', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  const geometry = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  };
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'next.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'kitbasher',
        version: 1,
        units: 'mm',
        name: 'Next scene',
        joints: [],
        parts: [
          {
            id: 'next',
            name: 'Next part',
            geometry,
            position: [0, 0, 0],
            quaternion: [0, 0, 0, 1],
            scale: [1, 1, 1],
            color: '#aabbcc',
            visible: true,
            locked: false,
            source: 'test',
          },
        ],
      }),
    ),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await expect(page.getByText('Recovery unavailable · save a scene file')).toBeVisible();
  expect(await storedRecovery(page)).toEqual(before);

  await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut());
  await page.locator('.part-select[title="Next part"]').click();
  const x = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await x.fill('3');
  await x.press('Enter');
  await saved(page);
  expect(await storedRecovery(page)).toEqual({
    name: 'Next scene',
    version: 2,
    parts: 1,
    meshes: 1,
  });
});

test('never stores or downloads a file the browser cannot read back', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await saved(page);
  const before = await storedRecovery(page);
  await page.evaluate(() => {
    const arrayBuffer = Blob.prototype.arrayBuffer;
    (window as unknown as { restoreRead: () => void }).restoreRead = () => {
      Blob.prototype.arrayBuffer = arrayBuffer;
    };
    Blob.prototype.arrayBuffer = () =>
      Promise.reject(new DOMException('Too large', 'NotReadableError'));
  });
  // Combining makes a new mesh, which autosave then has to write.
  await page.getByRole('button', { name: 'Unlock Display base', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.locator('.merge-tool').click();
  await page.getByRole('button', { name: 'Merge parts', exact: true }).click();
  await expect(page.getByText('Recovery unavailable · save a scene file')).toBeVisible();
  expect(await storedRecovery(page)).toEqual(before);

  const save = page.getByRole('button', { name: 'Save scene', exact: true });
  await save.click();
  await expect(page.locator('.toast-error')).toContainText('could not prepare a file this large');
  await page.evaluate(() => (window as unknown as { restoreRead: () => void }).restoreRead());
  const download = page.waitForEvent('download');
  await save.click();
  await download;
});

test('upgrades an autosave left by the previous version', async ({ page }) => {
  // This same-origin page does not run the app, so the old database stays untouched.
  await page.goto('/assets/kitbasher.svg');
  await page.evaluate(
    (scene) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('kitbasher-workbench', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('scenes');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const transaction = open.result.transaction('scenes', 'readwrite');
          transaction.objectStore('scenes').put(
            {
              ...scene,
              parts: scene.parts.map((part) => ({
                ...part,
                geometry: { positions: new Float32Array(part.geometry.positions) },
              })),
            },
            'current',
          );
          transaction.oncomplete = () => {
            open.result.close();
            resolve();
          };
        };
      }),
    {
      format: 'kitbasher',
      version: 1,
      units: 'mm',
      name: 'Old autosave',
      joints: [],
      constraints: [],
      parts: [
        {
          id: 'old',
          name: 'Old part',
          geometry: { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0] },
          position: [0, 0, 0],
          quaternion: [0, 0, 0, 1],
          scale: [1, 1, 1],
          color: '#aabbcc',
          visible: true,
          locked: false,
          source: 'test',
        },
      ],
    },
  );
  // The bare SVG page's missing favicon is not an app error.
  browserErrors.get(page)!.length = 0;
  await page.goto('/');
  await expect(page.getByText('Recovered your local assembly')).toBeVisible();
  await expect(page.locator('.part-select[title="Old part"]')).toBeVisible();
  await expect
    .poll(() => storedRecovery(page))
    .toEqual({ name: 'Old autosave', version: 2, parts: 1, meshes: 1 });
});

test('explains a truncated scene file', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'partial.kitbash',
    mimeType: 'application/octet-stream',
    buffer: bytes.subarray(0, bytes.length - 1000),
  });
  await expect(page.locator('.toast-error')).toContainText('incomplete or damaged');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toHaveCount(0);
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
});
