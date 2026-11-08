import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { BoxGeometry, Mesh, Matrix4, Quaternion, Vector3 } from 'three';
import type { SceneDocument } from '../../src/core/types';
import { readSavedScene } from './saved-scene';
import { serializeScene } from '../helpers/legacy-scene';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { serializeGeometry } from '../../src/core/geometry';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.locator('.part-select[title="Torso shell"]').click();
  await expect(page.getByRole('spinbutton', { name: 'Position Y', exact: true })).toHaveValue('76');
});

test('positions an assembly, preserves joints, undoes, saves and recovers', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const x = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await x.fill('12');
  await x.press('Enter');
  await page.locator('.part-select[title="Optics & head"]').click();
  await expect(x).toHaveValue('12');
  await page.locator('.part-select[title="Power pack"]').click();
  await expect(x).toHaveValue('12');
  await page.locator('.part-select[title="Torso shell"]').click();
  await page.getByRole('button', { name: 'Undo (Ctrl/⌘ Z)', exact: true }).click();
  await expect(x).toHaveValue('0');
  await page.getByRole('button', { name: 'Redo (Ctrl/⌘ Shift Z)', exact: true }).click();
  await expect(x).toHaveValue('12');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const saved = await downloadPromise;
  expect(saved.suggestedFilename()).toMatch(/\.kitbash$/);
  const { scene: file, bytes } = await readSavedScene((await saved.path())!);
  expect(file.parts).toHaveLength(15);
  expect(file.joints).toHaveLength(2);
  expect(file.parts.find((p) => p.id === 'torso')!.position[0]).toBe(12);
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Recovered your local assembly')).toBeVisible();
  await page.locator('.part-select[title="Torso shell"]').click();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('12');
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'Restored.kitbash',
    mimeType: 'application/octet-stream',
    buffer: bytes,
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Torso shell"]').click();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('12');
  expect(errors).toEqual([]);
});

test('filters parts, locks axes, measures, and uses an orthographic view', async ({ page }) => {
  const search = page.getByRole('textbox', { name: 'Search parts' });
  await search.fill('head');
  await expect(page.locator('.part-row')).toHaveCount(1);
  await page.locator('.part-select[title="Optics & head"]').click();
  await search.fill('');
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toBeEnabled();
  await expect(page.getByRole('spinbutton', { name: 'Rotation X', exact: true })).toBeDisabled();
  await expect(page.getByRole('spinbutton', { name: 'Rotation Y', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'X rotation locked' }).click();
  const rx = page.getByRole('spinbutton', { name: 'Rotation X', exact: true });
  await rx.fill('25');
  await rx.press('Enter');
  await expect(rx).toHaveValue('25');
  await page.getByRole('button', { name: 'Measure distance (D)' }).click();
  await expect(page.getByText('Pick the first surface point')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('5');
  await expect(page.getByRole('button', { name: 'Orthographic' })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle grid', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Toggle grid', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('slider', { name: 'Exploded view amount' }).fill('45');
  await expect(page.locator('.exploded-notice')).toBeVisible();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Exploded view amount' })).toHaveValue('0');
});

test('picks real mesh surfaces and applies point alignment', async ({ page }) => {
  await page.getByRole('button', { name: 'Align A', exact: true }).click();
  await page.getByRole('combobox', { name: 'Target part or plane' }).selectOption('shoulder-R');
  const canvas = page.locator('canvas');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.43 } });
  await expect(page.getByText('Now click the matching target surface.')).toBeVisible();
  await canvas.click({ position: { x: box.width * 0.62, y: box.height * 0.37 } });
  await expect(page.getByRole('button', { name: 'Apply alignment' })).toBeEnabled();
  await page.getByRole('button', { name: 'Apply alignment' }).click();
  await expect(page.getByText('Parts aligned', { exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).not.toHaveValue(
    '0',
  );
});

test('imports an STL, combines objects, and restores the merge with undo', async ({ page }) => {
  await page.getByRole('button', { name: 'Import parts', exact: true }).click();
  await page.getByLabel('Choose model files').setInputFiles({
    name: 'test-tetrahedron.stl',
    mimeType: 'model/stl',
    buffer: Buffer.from(
      'solid tetra\nfacet normal 0 0 -1\nouter loop\nvertex 0 0 0\nvertex 0 10 0\nvertex 10 0 0\nendloop\nendfacet\nfacet normal 0 -1 0\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 0 10\nendloop\nendfacet\nfacet normal -1 0 0\nouter loop\nvertex 0 0 0\nvertex 0 0 10\nvertex 0 10 0\nendloop\nendfacet\nfacet normal 1 1 1\nouter loop\nvertex 10 0 0\nvertex 0 10 0\nvertex 0 0 10\nendloop\nendfacet\nendsolid tetra',
    ),
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Import parts', exact: true }).click();
  await expect(page.getByText('Imported 1 part', { exact: true })).toBeVisible();
  await expect(page.locator('.part-row')).toHaveCount(16);
  await page.locator('.part-select[title="Right arm"]').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Merge selected', exact: true }).click();
  await page.getByRole('button', { name: 'Merge parts', exact: true }).click();
  await expect(page.getByText('2 parts combined into one mesh')).toBeVisible();
  await expect(page.locator('.part-row')).toHaveCount(15);
  await page.getByRole('button', { name: 'Undo (Ctrl/⌘ Z)', exact: true }).click();
  await expect(page.locator('.part-row')).toHaveCount(16);
});

test('exports separate meshes to Blender GLB and multipart 3MF', async ({ page }) => {
  for (const format of ['glb', '3mf']) {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page
      .getByRole('button', { name: format === 'glb' ? /Blender \/ glTF/ : /Multipart model/ })
      .click();
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export assembly', exact: true }).click();
    const file = await downloading,
      buffer = await readFile((await file.path())!);
    expect(file.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));
    expect(buffer.length).toBeGreaterThan(1000);
    if (format === 'glb') expect(buffer.subarray(0, 4).toString()).toBe('glTF');
    else expect(buffer.subarray(0, 2).toString()).toBe('PK');
  }
});

test('keeps the workbench usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Show parts panel', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show parts panel', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Search parts' })).toBeVisible();
  await page.getByRole('button', { name: 'Close parts panel', exact: true }).click();
  await page.getByRole('button', { name: 'Align', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Moving part' })).toBeVisible();
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test('runs an actual Boolean union in the worker and preserves colors', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const scenePath = '/src/core/scene-file.ts',
      mergePath = '/src/core/merge.ts',
      geometryPath = '/src/core/geometry.ts';
    const positions = [
      -5, -5, -5, 5, -5, -5, 5, 5, -5, -5, 5, -5, -5, -5, 5, 5, -5, 5, 5, 5, 5, -5, 5, 5,
    ];
    const indices = [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1,
      2, 6, 1, 6, 5,
    ];
    const parts = [0, 1].map((i) => ({
      id: String(i),
      name: `Block ${i}`,
      geometry: { positions, indices },
      position: [i * 5, 5, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: i ? '#e1a363' : '#94b9a3',
      visible: true,
      locked: false,
      source: 'test',
    }));
    const scene = (await import(scenePath)).parseScene({
      format: 'kitbasher',
      version: 1,
      units: 'mm',
      name: 'Union test',
      parts,
      joints: [],
    });
    const merged = await (await import(mergePath)).mergeParts(scene.parts, 'union', 'United');
    const data = (await import(geometryPath)).serializeGeometry(merged.geometry),
      idx = data.indices ?? Array.from({ length: data.positions.length / 3 }, (_, i) => i);
    let volume = 0;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3,
        b = idx[i + 1] * 3,
        c = idx[i + 2] * 3,
        p = data.positions;
      volume +=
        (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) +
          p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) +
          p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
        6;
    }
    return { volume: Math.abs(volume), colors: data.colors?.length, triangles: idx.length / 3 };
  });
  expect(result.volume).toBeCloseTo(1500, 2);
  expect(result.colors).toBeGreaterThan(0);
  expect(result.triangles).toBeGreaterThan(12);
});

test('round trips GLB and 3MF with part placement and physical scale', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const samplePath = '/src/core/sample.ts',
      filePath = '/src/core/files.ts',
      geometryPath = '/src/core/geometry.ts';
    const scene = (await import(samplePath)).createSample(),
      { exportGlb, export3mf, importModels } = await import(filePath),
      { sceneBounds } = await import(geometryPath);
    const glb = await exportGlb(scene, scene.parts),
      mf = export3mf(scene, scene.parts);
    const options = { units: 'auto', up: 'auto', center: false };
    const glbParts = await importModels([new File([glb], 'roundtrip.glb')], options),
      mfParts = await importModels([new File([mf.slice().buffer], 'roundtrip.3mf')], options);
    const bounds = (parts: unknown) => {
      const box = sceneBounds(parts);
      return box.max.clone().sub(box.min).toArray();
    };
    return {
      glbCount: glbParts.length,
      mfCount: mfParts.length,
      original: bounds(scene.parts),
      glb: bounds(glbParts),
      mf: bounds(mfParts),
      names: mfParts.map((p: { name: string }) => p.name),
    };
  });
  expect(results.glbCount).toBe(15);
  expect(results.mfCount).toBe(15);
  for (let i = 0; i < 3; i++) {
    expect(results.glb[i]).toBeCloseTo(results.original[i], 2);
    expect(results.mf[i]).toBeCloseTo(results.original[i], 2);
  }
  expect(results.names).toContain('Optics & head');
});

test('creates an anchored joint from two mesh surface picks', async ({ page }) => {
  await page.locator('.part-select[title="Optics & head"]').click();
  await page.getByRole('button', { name: 'Remove joint', exact: true }).click();
  await page.getByRole('button', { name: 'Joint J', exact: true }).click();
  await page.getByRole('combobox', { name: 'Target part or plane' }).selectOption('torso');
  const canvas = page.locator('canvas'),
    box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 0.49, y: box.height * 0.28 } });
  await expect(page.getByText('Now click the matching target surface.')).toBeVisible();
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.43 } });
  await page.getByRole('button', { name: /^Create joint/ }).click();
  await expect(page.getByText('Joint created · keep connected on')).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Y rotation free', exact: true })).toBeVisible();
});

test('moves a constrained assembly with the gizmo and cancels uncommitted numeric edits', async ({
  page,
}) => {
  const x = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await x.fill('52');
  await x.press('Escape');
  await expect(x).toHaveValue('0');
  await page.getByRole('button', { name: 'Move (G)', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Move (G)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.evaluate(() => new Promise<number>((resolve) => requestAnimationFrame(resolve)));
  const box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.578, box.y + box.height * 0.425);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.635, box.y + box.height * 0.435, { steps: 12 });
  await page.mouse.up();
  await expect(x).not.toHaveValue('0');
  const position = await x.inputValue();
  await page.locator('.part-select[title="Optics & head"]').click();
  await expect(x).toHaveValue(position);
});

test('picks a dense imported mesh using the accelerated viewport path', async ({ page }) => {
  const geometry = new BoxGeometry(30, 30, 30, 60, 60, 60);
  const scene = {
    format: 'kitbasher',
    version: 1,
    units: 'mm',
    name: 'Dense scan test',
    parts: [
      {
        id: 'dense',
        name: 'Dense mesh',
        geometry: serializeGeometry(geometry),
        position: [0, 15, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        color: '#c8c0b0',
        visible: true,
        locked: false,
        source: '43,200-triangle test mesh',
      },
    ],
    joints: [],
  };
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'Dense.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scene)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Dense mesh"]').click();
  await page.getByRole('button', { name: 'Align A', exact: true }).click();
  await page.getByRole('combobox', { name: 'Target part or plane' }).selectOption('plane-xz');
  const canvas = page.locator('canvas'),
    box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(page.getByText('Now click the matching target surface.')).toBeVisible();
});

function expectConnectedAnchors(scene: SceneDocument) {
  for (const joint of scene.joints.filter((j) => j.keepConnected !== false)) {
    const anchor = (id: string, point: [number, number, number]) => {
      const part = scene.parts.find((p) => p.id === id)!;
      return new Vector3(...point).applyMatrix4(
        new Matrix4().compose(
          new Vector3(...part.position),
          new Quaternion(...part.quaternion),
          new Vector3(...part.scale),
        ),
      );
    };
    expect(
      anchor(joint.parentId, joint.parentAnchor).distanceTo(
        anchor(joint.childId, joint.childAnchor),
      ),
    ).toBeLessThan(1e-6);
  }
}

async function downloadedScene(page: Page): Promise<SceneDocument> {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const download = await downloading;
  return (await readSavedScene((await download.path())!)).scene;
}

async function openFixture(page: Page, scene: unknown) {
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'regression.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scene)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
}

test('keeps collecting matching pairs after three and fits all five pairs', async ({ page }) => {
  await page.getByRole('button', { name: 'Align A', exact: true }).click();
  await page.getByRole('button', { name: '3+ point fit', exact: true }).click();
  await page.getByRole('combobox', { name: 'Target part or plane' }).selectOption('shoulder-R');
  const canvas = page.locator('canvas'),
    box = (await canvas.boundingBox())!;
  const offsets = [
    [-6, -6],
    [6, -6],
    [-6, 6],
    [6, 6],
    [0, 0],
  ];
  for (const [i, [x, y]] of offsets.entries()) {
    await canvas.click({ position: { x: box.width * 0.5 + x, y: box.height * 0.43 + y } });
    await expect(page.getByText('Now click the matching target surface.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply alignment' })).toBeDisabled();
    if (i >= 3) await expect(page.locator('.pending-pair')).toContainText('Source picked');
    await canvas.click({ position: { x: box.width * 0.62 + x, y: box.height * 0.37 + y } });
    await expect(page.locator('.pair-row')).toHaveCount(i + 1);
    if (i >= 2) {
      await expect(page.getByRole('button', { name: 'Apply alignment' })).toBeEnabled();
      await expect(page.getByLabel('Best-fit RMS error')).toContainText('mm RMS');
    }
  }
  await page.getByRole('button', { name: 'Apply alignment' }).click();
  await expect(page.getByText(/Aligned 5 pairs.*mm RMS/)).toBeVisible();
});

test('toggles the persistent joint anchor, moves connected parts, and restores paused scenes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.part-select[title="Optics & head"]').click();
  const keep = page.getByRole('switch', { name: 'Keep connected', exact: true });
  await expect(keep).toHaveAttribute('aria-checked', 'true');
  const x = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await x.fill('15');
  await x.press('Enter');
  await page.locator('.part-select[title="Torso shell"]').click();
  await expect(x).toHaveValue('15');
  await page.locator('.part-select[title="Optics & head"]').click();
  const yRotation = page.getByRole('spinbutton', { name: 'Rotation Y', exact: true });
  await yRotation.fill('35');
  await yRotation.press('Enter');
  const anchored = await downloadedScene(page);
  expectConnectedAnchors(anchored);
  expect(
    anchored.joints.find((j: { childId: string }) => j.childId === 'head')!.keepConnected,
  ).toBe(true);
  await keep.click();
  await expect(keep).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('spinbutton', { name: 'Rotation X', exact: true })).toBeEnabled();
  await x.fill('45');
  await x.press('Enter');
  const rx = page.getByRole('spinbutton', { name: 'Rotation X', exact: true });
  await rx.fill('20');
  await rx.press('Enter');
  const paused = await downloadedScene(page);
  expect(paused.joints.find((j: { childId: string }) => j.childId === 'head')!.keepConnected).toBe(
    false,
  );
  await page.locator('.part-select[title="Torso shell"]').click();
  await x.fill('5');
  await x.press('Enter');
  await page.locator('.part-select[title="Optics & head"]').click();
  await expect(x).toHaveValue('45');
  await openFixture(page, serializeScene(paused));
  await page.locator('.part-select[title="Optics & head"]').click();
  await expect(keep).toHaveAttribute('aria-checked', 'false');
  await expect(x).toHaveValue('45');
  await keep.click();
  await expect(keep).toHaveAttribute('aria-checked', 'true');
  await expect(x).not.toHaveValue('45');
  expect(errors).toEqual([]);
});

test('aligns a connected part from real picks without removing its joint', async ({ page }) => {
  await page.locator('.part-select[title="Optics & head"]').click();
  await page.getByRole('button', { name: 'Align A', exact: true }).click();
  await page.getByRole('combobox', { name: 'Target part or plane' }).selectOption('shoulder-R');
  const canvas = page.locator('canvas'),
    box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 0.49, y: box.height * 0.29 } });
  await expect(page.getByText('Now click the matching target surface.')).toBeVisible();
  await canvas.click({ position: { x: box.width * 0.62, y: box.height * 0.37 } });
  await page.getByRole('button', { name: 'Apply alignment' }).click();
  await expect(page.getByText(/Parts aligned.*anchor connected/)).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Keep connected', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const scene = await downloadedScene(page);
  expect(scene.joints).toHaveLength(2);
  expectConnectedAnchors(scene);
  expect(scene.parts.find((p: { id: string }) => p.id === 'shoulder-R')!.position).toEqual([
    22, 82, 0,
  ]);
});

test('imports an offset-origin scan with usable transform coordinates', async ({ page }) => {
  const geometry = new BoxGeometry(30, 30, 30).translate(1200, 800, -600);
  await page.getByRole('button', { name: 'Import parts', exact: true }).click();
  await page.getByLabel('Choose model files').setInputFiles({
    name: 'offset-scan.stl',
    mimeType: 'model/stl',
    buffer: Buffer.from(new STLExporter().parse(new Mesh(geometry))),
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Import parts', exact: true }).click();
  await expect(page.getByText('Imported 1 part', { exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('0');
  await expect(page.getByRole('spinbutton', { name: 'Position Y', exact: true })).toHaveValue('15');
  const ry = page.getByRole('spinbutton', { name: 'Rotation Y', exact: true });
  await ry.fill('30');
  await ry.press('Enter');
  await expect(ry).toHaveValue('30');
  const scene = await downloadedScene(page),
    imported = scene.parts.find((p: { source: string }) => p.source === 'offset-scan.stl')!;
  expect(
    Math.max(...Array.from(imported.geometry.getAttribute('position').array, Math.abs)),
  ).toBeLessThan(16);
});

test('drags move and rotate gizmos on a legacy scan whose origin is far outside the view', async ({
  page,
}) => {
  const geometry = new BoxGeometry(30, 30, 30).translate(1200, 800, -600);
  await openFixture(page, {
    format: 'kitbasher',
    version: 1,
    units: 'mm',
    name: 'Legacy offset scan',
    parts: [
      {
        id: 'offset',
        name: 'Offset scan',
        geometry: serializeGeometry(geometry),
        position: [-1200, -785, 600],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        color: '#c5c2b8',
        visible: true,
        locked: false,
        source: 'legacy.stl',
      },
    ],
    joints: [],
  });
  await page.locator('.part-select[title="Offset scan"]').click();
  await page.keyboard.press('1');
  await page.getByRole('button', { name: 'Move (G)', exact: true }).click();
  const box = (await page.locator('canvas').boundingBox())!,
    cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  const x = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await page.mouse.move(cx + 70, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 115, cy, { steps: 12 });
  await page.mouse.up();
  await expect(x).not.toHaveValue('-1200');
  const moved = await downloadedScene(page);
  const pivot = (part: SceneDocument['parts'][number]) =>
    new Vector3(1200, 800, -600).applyMatrix4(
      new Matrix4().compose(
        new Vector3(...part.position),
        new Quaternion(...part.quaternion),
        new Vector3(...part.scale),
      ),
    );
  const center = pivot(moved.parts[0]);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: 'Rotate (R)', exact: true }).click();
  await page.mouse.move(cx - 70.7, cy - 70.7);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    const angle = ((-135 + (i * 45) / 12) * Math.PI) / 180;
    await page.mouse.move(cx + 100 * Math.cos(angle), cy + 100 * Math.sin(angle));
  }
  await page.mouse.up();
  await expect(page.getByRole('spinbutton', { name: 'Rotation Z', exact: true })).not.toHaveValue(
    '0',
  );
  const rotated = await downloadedScene(page);
  expect(pivot(rotated.parts[0]).distanceTo(center)).toBeLessThan(1e-6);
  const rz = page.getByRole('spinbutton', { name: 'Rotation Z', exact: true });
  await rz.fill('20');
  await rz.press('Enter');
  const numeric = await downloadedScene(page);
  expect(pivot(numeric.parts[0]).distanceTo(center)).toBeLessThan(1e-6);
});

test('can create a joint with Keep connected off and leave the part free to position', async ({
  page,
}) => {
  await page.locator('.part-select[title="Optics & head"]').click();
  await page.getByRole('button', { name: 'Remove joint', exact: true }).click();
  await page.getByRole('button', { name: 'Joint J', exact: true }).click();
  await page.getByRole('switch', { name: 'Keep connected', exact: true }).click();
  await page.getByRole('combobox', { name: 'Target part or plane' }).selectOption('torso');
  const canvas = page.locator('canvas'),
    box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 0.49, y: box.height * 0.28 } });
  await expect(page.getByText('Now click the matching target surface.')).toBeVisible();
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.43 } });
  await page.getByRole('button', { name: /^Create joint/ }).click();
  await expect(page.getByText('Joint created · keep connected off')).toBeVisible();
  const x = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await x.fill('42');
  await x.press('Enter');
  await expect(x).toHaveValue('42');
  await page.locator('.part-select[title="Torso shell"]').click();
  await expect(x).toHaveValue('0');
});
