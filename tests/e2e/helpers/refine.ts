import { expect, type Page } from '@playwright/test';
import { serializeGeometry } from '../../../src/core/geometry';
import type { useEditor } from '../../../src/core/store';
import type { Vec3 } from '../../../src/core/types';
import { softBox } from '../../helpers/soft-edges';

type EditorState = ReturnType<typeof useEditor.getState>;

/** Half the block's size, its fillet radius, and how far each fillet's crest sits in from the faces. */
export const half: Vec3 = [4, 3, 2];
export const fillet = 0.6;
const inset = fillet - fillet / Math.SQRT2;

/** A scanned block at the origin: every edge rounded, the surface rippled and noisy. */
export const fixture = {
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Refine',
  joints: [],
  parts: [
    {
      id: 'block',
      name: 'Scanned block',
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: '#d4a272',
      geometry: serializeGeometry(softBox(half, fillet, { step: 0.2, ripple: 0.04, noise: 0.008 })),
      visible: true,
      locked: false,
      source: 'Scanned block',
    },
  ],
};

/** The crest of the block's top front fillet at x. */
export const crest = (x: number): Vec3 => [x, half[1] - inset, half[2] - inset];

/** Runs a function of the editor state in the page and returns what it returns. */
export async function inStore<T>(page: Page, read: (state: EditorState) => T): Promise<T> {
  return page.evaluate(async (body) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    return new Function('state', `return (${body})(state);`)(useEditor.getState());
  }, read.toString());
}

/** Screen position of a world point. */
export async function screen(page: Page, world: Vec3) {
  const box = (await page.locator('canvas').boundingBox())!;
  const ndc = await page.evaluate(async (world) => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => url.includes('/@react-three_fiber.js'))!;
    const root = (await import(url))._roots.get(document.querySelector('canvas')).store.getState();
    return root.camera.position.clone().fromArray(world).project(root.camera).toArray();
  }, world);
  return { x: box.x + ((ndc[0] + 1) * box.width) / 2, y: box.y + ((1 - ndc[1]) * box.height) / 2 };
}

/** Clicks the surface where a world point shows. */
export async function clickSurface(page: Page, world: Vec3) {
  const spot = await screen(page, world);
  await page.mouse.click(spot.x, spot.y);
}

/** Opens the block, selects it, looks at it from the front and starts Refine on it. */
export async function openRefine(page: Page) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'refine.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Scanned block"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page.keyboard.press('e');
  await expect(page.getByRole('radio', { name: 'Edge', exact: true })).toBeVisible();
  await expect.poll(() => inStore(page, (s) => s.refine?.stage ?? null)).toBe('ready');
}

/**
 * Largest distance from their best straight line of the part's vertices on a sharp edge (where
 * faces around a vertex turn more than 60 degrees), along the middle of the top front edge.
 */
export async function chainStraightness(page: Page) {
  return inStore(page, (state) => {
    const geometry = state.scene.parts[0].geometry;
    const position = geometry.getAttribute('position');
    const index = geometry.index;
    const count = index ? index.count : position.count;
    const key = (v: number) =>
      [position.getX(v), position.getY(v), position.getZ(v)].map((x) => x.toFixed(5)).join(' ');
    const normals = new Map<string, number[][]>();
    for (let t = 0; t < count; t += 3) {
      const v = [0, 1, 2].map((c) => (index ? index.getX(t + c) : t + c));
      const p = v.map((i) => [position.getX(i), position.getY(i), position.getZ(i)]);
      const u = [0, 1, 2].map((a) => p[1][a] - p[0][a]),
        w = [0, 1, 2].map((a) => p[2][a] - p[0][a]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const length = Math.hypot(n[0], n[1], n[2]);
      if (!(length > 0)) continue;
      for (const i of v) {
        const k = key(i);
        if (!normals.has(k)) normals.set(k, []);
        normals.get(k)!.push(n.map((x) => x / length));
      }
    }
    const chain: number[][] = [];
    for (const [k, list] of normals) {
      const p = k.split(' ').map(Number);
      if (Math.abs(p[0]) > 2 || p[1] < 2 || p[2] < 1) continue;
      let least = 1;
      for (const a of list)
        for (const b of list) least = Math.min(least, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
      if (least < 0.5) chain.push(p);
    }
    if (chain.length < 5) return Infinity;
    // The edge runs along x: fit y and z as straight lines in x.
    const fit = (axis: number) => {
      const n = chain.length;
      const mx = chain.reduce((s, p) => s + p[0], 0) / n,
        my = chain.reduce((s, p) => s + p[axis], 0) / n;
      const slope =
        chain.reduce((s, p) => s + (p[0] - mx) * (p[axis] - my), 0) /
        chain.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
      return (x: number) => my + slope * (x - mx);
    };
    const y = fit(1),
      z = fit(2);
    return Math.max(...chain.map((p) => Math.hypot(p[1] - y(p[0]), p[2] - z(p[0]))));
  });
}
