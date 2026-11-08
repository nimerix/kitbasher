import { expect, test, type Page } from '@playwright/test';
import { closeSync, openSync, writeSync } from 'node:fs';
import { rm, stat, truncate, writeFile } from 'node:fs/promises';

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

function writeLines(path: string, lines: Iterable<string>) {
  const file = openSync(path, 'w');
  const buffer = Buffer.allocUnsafe(2 ** 24);
  let used = 0;
  for (const line of lines) {
    if (used + line.length > buffer.length) {
      writeSync(file, buffer, 0, used);
      used = 0;
    }
    used += buffer.write(line, used, 'latin1');
  }
  writeSync(file, buffer, 0, used);
  closeSync(file);
}

const height = (x: number, z: number) => (Math.sin(x * 0.01) * Math.cos(z * 0.013) * 10).toFixed(4);

/** About 42 bytes per triangle, with no normals: the most triangles a text format holds. */
function* gridObj(side: number) {
  yield 'o scan\n';
  for (let z = 0; z <= side; z++)
    for (let x = 0; x <= side; x++) yield `v ${x}.0000 ${height(x, z)} ${z}.0000\n`;
  const at = (x: number, z: number) => z * (side + 1) + x + 1;
  for (let z = 0; z < side; z++)
    for (let x = 0; x < side; x++) {
      yield `f ${at(x, z)} ${at(x, z + 1)} ${at(x + 1, z)}\n`;
      yield `f ${at(x + 1, z)} ${at(x, z + 1)} ${at(x + 1, z + 1)}\n`;
    }
}

function* gridTextStl(side: number) {
  yield 'solid scan\n';
  const corner = (x: number, z: number) => `    vertex ${x}.0000 ${height(x, z)} ${z}.0000\n`;
  for (let z = 0; z < side; z++)
    for (let x = 0; x < side; x++) {
      const a = corner(x, z);
      const b = corner(x + 1, z);
      const c = corner(x, z + 1);
      const d = corner(x + 1, z + 1);
      yield `facet normal 0 1 0\n  outer loop\n${a}${c}${b}  endloop\nendfacet\n`;
      yield `facet normal 0 1 0\n  outer loop\n${b}${c}${d}  endloop\nendfacet\n`;
    }
  yield 'endsolid scan\n';
}

async function openWorkbench(page: Page) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
}

async function startImport(page: Page, path: string) {
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.locator('.dropdown-menu button', { hasText: 'Import' }).first().click();
  await page.getByLabel('Choose model files').setInputFiles(path);
  await page.locator('.import-options select').nth(1).selectOption('y');
  await page.locator('.modal-footer .button.primary').click();
}

async function frameAll(page: Page) {
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.locator('.dropdown-menu button', { hasText: 'Frame all' }).click();
  await page.waitForTimeout(300);
}

function editor<T>(page: Page, read: string): Promise<T> {
  return page.evaluate(async (read) => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!;
    const { useEditor } = await import(url);
    return new Function('state', `return ${read}`)(useEditor.getState());
  }, read);
}

/** Beside the sample model, which stands at the origin in the middle of the view. */
async function clickBesideOrigin(page: Page) {
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2 - 170, box.y + box.height / 2 + 30);
  await page.waitForTimeout(200);
}

const denseMeshNotice = 'Preparing a dense mesh';

test('imports an OBJ of the size that used to crash the tab', async ({ page }, testInfo) => {
  test.setTimeout(240000);
  const path = testInfo.outputPath('scan.obj');
  const side = 2320;
  writeLines(path, gridObj(side));
  expect((await stat(path)).size).toBeGreaterThan(405 * 2 ** 20);
  await openWorkbench(page);
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { statuses: string[] }).statuses = seen;
    new MutationObserver(() => {
      const status = document.querySelector('.busy-overlay span')?.textContent;
      if (status) seen.push(status);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });

  await startImport(page, path);
  await expect(page.locator('.toast')).toContainText('Imported 1 part', { timeout: 120000 });

  const statuses = await page.evaluate(
    () => (window as unknown as { statuses: string[] }).statuses,
  );
  expect(statuses.some((status) => /^Importing scan\.obj… \d+%$/.test(status))).toBe(true);
  const part = await editor<{ id: string; name: string; vertices: number }>(
    page,
    `(() => {
      const part = state.scene.parts.find((part) => part.source === 'scan.obj');
      return { id: part.id, name: part.name, vertices: part.geometry.getAttribute('position').count };
    })()`,
  );
  expect(part.name).toBe('scan');
  expect(part.vertices).toBe(side * side * 2 * 3);

  // Picking on a mesh this size is prepared in a worker.
  await frameAll(page);
  await expect(page.locator('.status-context')).not.toContainText(denseMeshNotice, {
    timeout: 60000,
  });
  await page.keyboard.press('Escape');
  await clickBesideOrigin(page);
  expect(await editor<string[]>(page, 'state.selected')).toEqual([part.id]);
  await rm(path);
});

test('imports a text STL past the browser string limit', async ({ page }, testInfo) => {
  test.setTimeout(240000);
  const path = testInfo.outputPath('scan.stl');
  const side = 1320;
  writeLines(path, gridTextStl(side));
  expect((await stat(path)).size).toBeGreaterThan(0x1fffffe8);
  await openWorkbench(page);
  await startImport(page, path);
  await expect(page.locator('.toast')).toContainText('Imported 1 part', { timeout: 120000 });
  expect(
    await editor<number>(
      page,
      `state.scene.parts.find((part) => part.source === 'scan.stl').geometry.getAttribute('position').count`,
    ),
  ).toBe(side * side * 2 * 3);
  await rm(path);
});

async function addFlatMesh(page: Page, triangles: number) {
  await page.evaluate(async (triangles) => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!;
    const { useEditor } = await import(url);
    const state = useEditor.getState();
    const sample = state.scene.parts[0].geometry;
    const side = Math.ceil(Math.sqrt(triangles / 2));
    const size = 2000 / side;
    const positions = new Float32Array(side * side * 18);
    const normals = new Float32Array(side * side * 18);
    let at = 0;
    const put = (x: number, z: number) => {
      positions[at] = x * size - 1000;
      positions[at + 2] = z * size - 1000;
      normals[at + 1] = 1;
      at += 3;
    };
    for (let z = 0; z < side; z++)
      for (let x = 0; x < side; x++) {
        put(x, z);
        put(x, z + 1);
        put(x + 1, z);
        put(x + 1, z);
        put(x, z + 1);
        put(x + 1, z + 1);
      }
    const geometry = new sample.constructor();
    const Attribute = sample.getAttribute('position').constructor;
    geometry.setAttribute('position', new Attribute(positions, 3));
    geometry.setAttribute('normal', new Attribute(normals, 3));
    state.addParts([
      {
        id: 'flat',
        name: 'Flat scan',
        geometry,
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        color: '#c5c2b8',
        visible: true,
        locked: false,
        source: 'test',
      },
    ]);
  }, triangles);
}

test('stays usable while a dense mesh is prepared for clicking', async ({ page }) => {
  test.setTimeout(120000);
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/bvh.worker.ts*', async (route) => {
    await released;
    await route.continue();
  });
  await openWorkbench(page);
  await addFlatMesh(page, 1_200_000);
  const status = page.locator('.status-context');
  await expect(status).toContainText(denseMeshNotice);

  // The sample model behind it stays clickable, and the mesh does not hold up the pointer.
  await frameAll(page);
  await page.keyboard.press('Escape');
  await clickBesideOrigin(page);
  expect(await editor<string[]>(page, 'state.selected')).toEqual([]);

  release();
  await expect(status).not.toContainText(denseMeshNotice, { timeout: 60000 });
  await clickBesideOrigin(page);
  expect(await editor<string[]>(page, 'state.selected')).toEqual(['flat']);
  expect(
    await editor<boolean>(
      page,
      `!!state.scene.parts.find((part) => part.id === 'flat').geometry.boundsTree`,
    ),
  ).toBe(true);
});

test('says so when a dense mesh cannot be prepared for clicking', async ({ page }) => {
  await page.route('**/bvh.worker.ts*', (route) => route.abort());
  await openWorkbench(page);
  await addFlatMesh(page, 1_200_000);
  await expect(page.locator('.toast-error')).toContainText('Select it in the parts list');
  await expect(page.locator('.status-context')).not.toContainText(denseMeshNotice);
  browserErrors.get(page)!.length = 0;
});

test('refuses a mesh too large to draw before reading it', async ({ page }, testInfo) => {
  const path = testInfo.outputPath('huge.stl');
  const faces = 64_000_000;
  const header = Buffer.alloc(84);
  header.writeUInt32LE(faces, 80);
  await writeFile(path, header);
  // Sparse, so this takes no time or disk space.
  await truncate(path, 84 + faces * 50);
  await openWorkbench(page);
  await startImport(page, path);
  await expect(page.getByRole('alert')).toContainText(
    'huge.stl is too large for a browser to draw',
  );
  await rm(path);
});

test('explains a text glTF past the browser string limit', async ({ page }, testInfo) => {
  const path = testInfo.outputPath('huge.gltf');
  await writeFile(path, '{}');
  await truncate(path, 600_000_000);
  await openWorkbench(page);
  await startImport(page, path);
  await expect(page.getByRole('alert')).toContainText('Convert it to GLB');
  await rm(path);
});

test('keeps instances of a GLB mesh as one mesh', async ({ page }) => {
  await openWorkbench(page);
  const result = await page.evaluate(async () => {
    const filePath = '/src/core/files.ts';
    const samplePath = '/src/core/sample.ts';
    const { exportGlb, importModels } = await import(filePath);
    const scene = (await import(samplePath)).createSample();
    const copies = [100, -100].map((x, i) => ({
      ...scene.parts[0],
      id: `copy-${i}`,
      position: [x, 0, 0],
    }));
    const glb = await exportGlb({ ...scene, parts: copies, joints: [], constraints: [] }, copies);
    const parts = await importModels([new File([glb], 'instances.glb')], {
      units: 'auto',
      up: 'y',
      center: false,
    });
    return {
      count: parts.length,
      shared: parts[0].geometry === parts[1].geometry,
      x: parts.map((part: { position: number[] }) => part.position[0]),
    };
  });
  expect(result.count).toBe(2);
  expect(result.shared).toBe(true);
  expect(result.x[0] - result.x[1]).toBeCloseTo(200);
});
