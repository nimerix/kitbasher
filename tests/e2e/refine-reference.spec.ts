import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { failOnBrowserErrors } from './helpers/warp-grid';
import { inEditor, inStore } from './helpers/refine';
import type { Vec3 } from '../../src/core/types';

// Renders the reference scans before and after their refinement, for a person to judge against
// photos of the parts. The scans are private and never in the repository: REFINE_SCANS names the
// folder holding 45.stl and 57.stl, each with an optional <part>.refine.json (RefineProposals in
// world coordinates, accepted in order) and <part>.views.json (extra close views). REFINE_LIST
// picks another list, <part>.<list>.json, whose after images carry its name.
const scans = process.env.REFINE_SCANS;
const list = process.env.REFINE_LIST ?? 'refine';
const out = join('test-results', 'refine-reference');

interface View {
  name: string;
  position: Vec3;
  target: Vec3;
  /** Seen with the part turned over about x, so a face underneath is lit as one on top is. */
  flip?: boolean;
}

failOnBrowserErrors();
test.skip(!scans, 'REFINE_SCANS names the folder of the reference scans');

async function importScan(page: Page, file: string) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'empty.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'kitbasher',
        version: 1,
        units: 'mm',
        name: 'Reference',
        joints: [],
        parts: [],
      }),
    ),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await expect(page.locator('.part-select')).toHaveCount(0);
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.locator('.dropdown-menu button', { hasText: 'Import' }).first().click();
  await page.getByLabel('Choose model files').setInputFiles(file);
  await page.locator('.modal-footer .button.primary').click();
  await expect(page.locator('.part-select')).toHaveCount(1, { timeout: 120_000 });
  await page.locator('.part-select').first().click();
  await page.keyboard.press('Home');
  await expect.poll(() => inStore(page, (s) => s.indexingMeshes), { timeout: 120_000 }).toBe(0);
}

/** Top, bottom and two three-quarter views around the part's bounds. */
async function framedViews(page: Page): Promise<View[]> {
  const { centre, radius } = await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const root = (await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!))._roots
      .get(document.querySelector('canvas'))
      .store.getState();
    const { useEditor } = await import(
      urls.find((u) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(u))!
    );
    const part = useEditor.getState().scene.parts[0];
    const mesh = root.scene.getObjectByName(`part:${part.id}`);
    mesh.updateMatrixWorld();
    part.geometry.computeBoundingSphere();
    const sphere = part.geometry.boundingSphere;
    return {
      centre: sphere.center.clone().applyMatrix4(mesh.matrixWorld).toArray() as Vec3,
      radius: sphere.radius,
    };
  });
  const d = radius * 3.2;
  const at = (x: number, y: number, z: number): Vec3 => {
    const l = Math.hypot(x, y, z);
    return [centre[0] + (x / l) * d, centre[1] + (y / l) * d, centre[2] + (z / l) * d];
  };
  return [
    { name: 'top', position: at(0, 1, 0.001), target: centre },
    { name: 'bottom', position: at(0, -1, 0.001), target: centre, flip: true },
    { name: 'three-quarter-front', position: at(1, 0.9, 1), target: centre },
    { name: 'three-quarter-back', position: at(-1, 0.9, -1), target: centre },
  ];
}

/** Turns the part over about x through its origin, or back, outside any Refine session. */
async function turnOver(page: Page, over: boolean) {
  await inEditor(
    page,
    ({ useEditor }, over) => {
      const state = useEditor.getState();
      const part = state.scene.parts[0];
      const held = window as unknown as { upright?: [number, number, number, number] };
      held.upright ??= part.quaternion;
      const [x, y, z, w] = held.upright;
      // A half turn about x, (1, 0, 0, 0), applied after the part's own rotation.
      const turned: [number, number, number, number] = over ? [w, -z, y, -x] : held.upright;
      if (turned.some((value, i) => value !== part.quaternion[i]))
        state.transform(part.id, { quaternion: turned });
    },
    over,
  );
}

async function shoot(page: Page, view: View, file: string) {
  await turnOver(page, !!view.flip);
  const origin = await inStore(page, (s) => s.scene.parts[0].position);
  // A point on the part, seen with it turned over: its offset from the origin turned too.
  const turn = (p: Vec3): Vec3 =>
    view.flip ? [p[0], 2 * origin[1] - p[1], 2 * origin[2] - p[2]] : p;
  const position = turn(view.position),
    target = turn(view.target);
  await page.evaluate(
    async ({ position, target }) => {
      const url = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((url) => url.includes('/@react-three_fiber.js'))!;
      const root = (await import(url))._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const { camera, controls, invalidate } = root;
      camera.position.set(...position);
      controls.target.set(...target);
      camera.lookAt(...target);
      controls.update();
      invalidate();
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
    },
    { position, target },
  );
  await page.locator('canvas').screenshot({ path: join(out, file) });
}

/** Closed under welding, with no triangle of zero area, and the triangle count. */
async function geometryCheck(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(
      urls.find((u) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(u))!
    );
    const topology = '/src/core/mesh-topology.ts';
    const { hasClosedEdges, weldedPositionIndex } = await import(/* @vite-ignore */ topology);
    const geometry = useEditor.getState().scene.parts[0].geometry;
    const { indices, vertices } = weldedPositionIndex(geometry);
    const position = geometry.getAttribute('position');
    const corner = (c: number) => (geometry.index ? geometry.index.getX(c) : c);
    let zeroArea = 0;
    const count = (geometry.index ? geometry.index.count : position.count) / 3;
    for (let t = 0; t < count; t++) {
      const [a, b, c] = [0, 1, 2].map((k) => {
        const v = corner(t * 3 + k);
        return [position.getX(v), position.getY(v), position.getZ(v)];
      });
      const u = [0, 1, 2].map((k) => b[k] - a[k]),
        w = [0, 1, 2].map((k) => c[k] - a[k]);
      const area = Math.hypot(
        u[1] * w[2] - u[2] * w[1],
        u[2] * w[0] - u[0] * w[2],
        u[0] * w[1] - u[1] * w[0],
      );
      if (!(area > 0)) zeroArea++;
    }
    return { triangles: count, closed: hasClosedEdges(indices, vertices), zeroArea };
  });
}

for (const part of ['45', '57'])
  test(`renders scan ${part} before and after its refinement`, async ({ page }) => {
    test.setTimeout(1_800_000);
    mkdirSync(out, { recursive: true });
    const features = join(scans!, `${part}.${list}.json`);
    const suffix = list === 'refine' ? 'after' : `${list}-after`;
    await importScan(page, join(scans!, `${part}.stl`));
    await inStore(page, (s) => s.select(null));
    const extra = join(scans!, `${part}.views.json`);
    // The renders show the part alone, once the environment and shadows have settled.
    await page.addStyleTag({
      content: '.camera-navigation, .notification-toasts { visibility: hidden !important; }',
    });
    await page.waitForTimeout(2000);
    const views = [
      ...(await framedViews(page)),
      ...(existsSync(extra) ? (JSON.parse(readFileSync(extra, 'utf8')) as View[]) : []),
    ];
    for (const view of views) await shoot(page, view, `${part}-${view.name}-before.png`);
    await turnOver(page, false);
    if (!existsSync(features)) return;

    const before = await geometryCheck(page);
    await page.evaluate(async () => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const { useEditor } = await import(
        urls.find((u) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(u))!
      );
      (window as unknown as { original: unknown }).original =
        useEditor.getState().scene.parts[0].geometry;
    });
    await inStore(page, (s) => s.select(s.scene.parts[0].id));
    await page.keyboard.press('e');
    await expect
      .poll(() => inStore(page, (s) => s.refine?.stage ?? null), { timeout: 120_000 })
      .toBe('ready');
    const proposals = JSON.parse(readFileSync(features, 'utf8'));
    const replay = await inEditor(
      page,
      ({ useEditor }, proposals) => {
        const refine = useEditor.getState().refine!;
        const added = proposals.map(
          (feature: { type: string; input: { triangles?: number[] } }, i: number) => ({
            id: `reference-${i}`,
            state: 'pending',
            origin: 'hand',
            feature:
              feature.type === 'region'
                ? {
                    ...feature,
                    input: {
                      ...feature.input,
                      triangles: Uint32Array.from(feature.input.triangles!),
                    },
                  }
                : feature,
          }),
        );
        useEditor.setState({ refine: { ...refine, features: [...refine.features, ...added] } });
        const start = performance.now();
        useEditor.getState().acceptRefine(added.map((f: { id: string }) => f.id));
        const accept = performance.now() - start;
        const session = useEditor.getState().refine!;
        const accepted = session.features.filter((f) => f.state === 'accepted').length;
        const applyStart = performance.now();
        const applied = useEditor.getState().applyRefine();
        return {
          proposals: proposals.length,
          accepted,
          acceptMs: accept,
          applyMs: performance.now() - applyStart,
          applied,
        };
      },
      proposals,
    );
    expect(replay.applied).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => inStore(page, (s) => s.refine)).toBeNull();
    await inStore(page, (s) => s.select(null));
    const after = await geometryCheck(page);
    const undone = await page.evaluate(async () => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const { useEditor } = await import(
        urls.find((u) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(u))!
      );
      useEditor.getState().undo();
      const restored =
        useEditor.getState().scene.parts[0].geometry ===
        (window as unknown as { original: unknown }).original;
      useEditor.getState().redo();
      return restored;
    });
    for (const view of views) await shoot(page, view, `${part}-${view.name}-${suffix}.png`);
    await turnOver(page, false);
    writeFileSync(
      join(out, `${part}-${list}.json`),
      JSON.stringify({ replay, before, after, undoRestoresOriginal: undone }, null, 2),
    );
    expect(after.closed).toBe(true);
    expect(after.zeroArea).toBe(0);
    expect(undone).toBe(true);
  });
