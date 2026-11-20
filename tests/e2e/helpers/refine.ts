import { expect, type Page } from '@playwright/test';
import { serializeGeometry } from '../../../src/core/geometry';
import type { useEditor } from '../../../src/core/store';
import type { Vec3 } from '../../../src/core/types';
import { rivetedPlate, softBox, softCylinder } from '../../helpers/soft-edges';

type EditorState = ReturnType<typeof useEditor.getState>;
type Store = typeof import('../../../src/core/store');

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

/** A small riveted plate: half size [3, 0.5, 2], six domes 0.25 mm high on its top face. */
export const plate = rivetedPlate({ step: 0.2, ripple: 0.04, noise: 0.008 });

export const plateFixture = {
  ...fixture,
  parts: [
    {
      ...fixture.parts[0],
      id: 'plate',
      name: 'Riveted plate',
      geometry: serializeGeometry(plate.geometry),
      source: 'Riveted plate',
    },
  ],
};

/** A scanned cylinder about Y, radius 3, height 3, its rims rounded like the block's edges. */
export const cylinder = { radius: 3, halfHeight: 1.5 };

export const cylinderFixture = {
  ...fixture,
  parts: [
    {
      ...fixture.parts[0],
      id: 'cylinder',
      name: 'Scanned cylinder',
      geometry: serializeGeometry(
        softCylinder(cylinder.radius, cylinder.halfHeight, fillet, {
          step: 0.2,
          ripple: 0.04,
          noise: 0.008,
        }),
      ),
      source: 'Scanned cylinder',
    },
  ],
};

/** The crest of the cylinder's top rim at `angle` radians about Y from +x toward +z. */
export const rimCrest = (angle: number): Vec3 => {
  const r = cylinder.radius - inset;
  return [r * Math.cos(angle), cylinder.halfHeight - inset, r * Math.sin(angle)];
};

/** The crest of the block's top front fillet at x. */
export const crest = (x: number): Vec3 => [x, half[1] - inset, half[2] - inset];

/** A point on the rounded corner of the front face, by the corner's x and y signs. */
export const surfaceCorner = (x: number, y: number): Vec3 => {
  const out = fillet / Math.sqrt(3);
  return [x * (half[0] - fillet + out), y * (half[1] - fillet + out), half[2] - fillet + out];
};

/** The middle of the curve the viewport draws for a pending proposal, world space. */
export async function proposalSpot(page: Page, id: string): Promise<Vec3> {
  return page.evaluate(async (id) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { refineCurves } = await import(
      urls.find((url) => /\/src\/components\/RefinePointer\.tsx(?:\?.*)?$/.test(url))!
    );
    const { points } = refineCurves.get(id);
    const middle = Math.floor(points.length / 6) * 3;
    return [points[middle], points[middle + 1], points[middle + 2]];
  }, id);
}

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

/** Runs a function of the store module and `args` in the page and returns what it returns. */
export async function inEditor<T, A = null>(
  page: Page,
  read: (store: Store, args: A) => T,
  args: A = null as A,
): Promise<T> {
  return page.evaluate(
    async ({ body, args }) => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const store = await import(urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!);
      return new Function('store', 'args', `return (${body})(store, args);`)(store, args);
    },
    { body: read.toString(), args },
  );
}

/** How many notifications with `message` the app has raised since the page opened. */
export async function noticeCount(page: Page, message: string): Promise<number> {
  return page.evaluate(async (message) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useActivity } = await import(
      urls.find((url) => /\/src\/core\/activity\.ts(?:\?.*)?$/.test(url))!
    );
    return useActivity
      .getState()
      .notifications.filter((n: { message: string }) => n.message === message).length;
  }, message);
}

/** Largest distance of the session preview's vertices from the working surface they show, mm. */
export const previewOffModel = (page: Page) =>
  inStore(page, (s) => {
    const { preview, model } = s.refine!;
    const position = preview!.getAttribute('position');
    const { weldOf, position: welded } = model!.mesh;
    let most = 0;
    for (let g = 0; g < position.count; g++) {
      const v = weldOf[g] * 3;
      most = Math.max(
        most,
        Math.abs(position.getX(g) - welded[v]),
        Math.abs(position.getY(g) - welded[v + 1]),
        Math.abs(position.getZ(g) - welded[v + 2]),
      );
    }
    return most;
  });

/**
 * The plane fitted to points by least squares, and the points' RMS and largest distance from it:
 * the smallest eigenvector of their covariance, by Jacobi rotations.
 */
export function planeFit(points: readonly number[][]) {
  const n = points.length;
  const mean = [0, 1, 2].map((a) => points.reduce((s, p) => s + p[a], 0) / n);
  const c = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => points.reduce((s, p) => s + (p[i] - mean[i]) * (p[j] - mean[j]), 0)),
  );
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++)
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(c[p][q]) < 1e-30) continue;
      const theta = (c[q][q] - c[p][p]) / (2 * c[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cos = 1 / Math.sqrt(t * t + 1),
        sin = t * cos;
      for (let k = 0; k < 3; k++) {
        const [a, b] = [c[k][p], c[k][q]];
        c[k][p] = cos * a - sin * b;
        c[k][q] = sin * a + cos * b;
      }
      for (let k = 0; k < 3; k++) {
        const [a, b] = [c[p][k], c[q][k]];
        c[p][k] = cos * a - sin * b;
        c[q][k] = sin * a + cos * b;
      }
      for (let k = 0; k < 3; k++) {
        const [a, b] = [v[k][p], v[k][q]];
        v[k][p] = cos * a - sin * b;
        v[k][q] = sin * a + cos * b;
      }
    }
  const least = [0, 1, 2].reduce((m, i) => (c[i][i] < c[m][m] ? i : m), 0);
  const normal = [v[0][least], v[1][least], v[2][least]];
  const off = points.map((p) =>
    Math.abs([0, 1, 2].reduce((s, a) => s + (p[a] - mean[a]) * normal[a], 0)),
  );
  return {
    normal,
    rms: Math.sqrt(off.reduce((s, d) => s + d * d, 0) / n),
    max: Math.max(...off),
  };
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

/** Drags with the primary button through world points, in `steps` pointer moves per leg. */
export async function drag(page: Page, through: Vec3[], steps = 12) {
  const spots = [];
  for (const point of through) spots.push(await screen(page, point));
  await page.mouse.move(spots[0].x, spots[0].y);
  await page.mouse.down();
  for (const spot of spots.slice(1)) await page.mouse.move(spot.x, spot.y, { steps });
  await page.mouse.up();
}

/** Opens a scene with no part selected. */
export async function openScene(page: Page, scene: object = fixture) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  const file = {
    name: 'refine.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scene)),
  };
  const confirm = page.getByRole('button', { name: 'Open scene', exact: true });
  // The app drops a file given while it is busy, as it can be just after start: give it again.
  await expect(async () => {
    if (!(await confirm.isVisible()))
      await page.getByLabel('Open Kitbasher scene').setInputFiles(file);
    await expect(confirm).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
  await confirm.click();
}

/**
 * Opens the block, or another one-part scene, selects its part, looks at it from the front (or
 * the given view key) and starts Refine on it.
 */
export async function openRefine(
  page: Page,
  { scene = fixture, view = '1' }: { scene?: typeof fixture; view?: string } = {},
) {
  await openScene(page, scene);
  await page.locator(`.part-select[title="${scene.parts[0].name}"]`).click();
  await page.keyboard.press(view);
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
