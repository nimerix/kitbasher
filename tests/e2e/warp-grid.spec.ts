import { expect, test, type Page } from '@playwright/test';
import { LatheGeometry, SphereGeometry, Vector2, type BufferGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';
import { distinctColor } from '../../src/core/appearance';

// A curved convex part about the size of a miniature's head or shoulder pad.
const radius = 15;
const ball = new SphereGeometry(radius, 96, 64);

/** A dome 0.8 mm thick, like a cloak: its inner surface must never show through. */
function dome() {
  const arc = (r: number) =>
    Array.from({ length: 41 }, (_, i) => {
      const a = (i / 40) * (Math.PI / 2);
      return new Vector2(r * Math.cos(a), r * Math.sin(a));
    });
  const outer = arc(radius),
    inner = arc(radius - 0.8).reverse();
  return new LatheGeometry([...outer, ...inner, outer[0]], 96);
}

const scene = (geometry: BufferGeometry) => ({
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Warp grid',
  joints: [],
  parts: [
    {
      id: 'ball',
      name: 'Scanned ball',
      position: [0, radius, 0],
      color: '#d4a272',
      geometry: serializeGeometry(geometry),
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      visible: true,
      locked: false,
      source: 'test',
    },
  ],
});

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
});
test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

async function layGrid(page: Page, geometry: BufferGeometry = ball) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'grid.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scene(geometry))),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Scanned ball"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page.keyboard.press('w');
  await page.getByRole('radio', { name: 'Whole part', exact: true }).click();
  await page.getByRole('button', { name: 'Lay grid', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close gap', exact: true })).toBeEnabled();
}

async function setDensity(page: Page, level: number) {
  await page.getByRole('slider', { name: 'Grid density' }).fill(String(level));
  await expect(page.getByRole('button', { name: 'Close gap', exact: true })).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
        const { useEditor } = await import(
          urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
        );
        const { warp } = useEditor.getState();
        return warp.stage === 'warp' ? warp.density : -1;
      }),
    )
    .toBe(level);
}

/** Points the camera at the part's centre from a direction, at 70 mm. */
async function lookFrom(page: Page, direction: number[]) {
  await page.evaluate(
    async ({ direction, radius }) => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const root = (
        await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!)
      )._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const { camera, controls } = root;
      const centre = camera.position.clone().set(0, radius, 0);
      const offset = camera.position.clone().fromArray(direction).normalize().multiplyScalar(70);
      controls.target.copy(centre);
      camera.position.copy(centre).add(offset);
      camera.lookAt(centre);
      controls.update();
      root.invalidate();
    },
    { direction, radius },
  );
}

/**
 * Draws the grid's own core material over the part's depth, offscreen, and counts its pixels.
 * On the ball: edges facing the camera with and without the depth test, and edges well round
 * the back with it. On the dome: edges of its inner surface, and of the rest, with it.
 */
async function gridPixels(page: Page, part: 'ball' | 'dome') {
  return page.evaluate(
    async ({ part, radius }) => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const THREE = await import(urls.find((url) => /\/deps\/three\.js/.test(url))!);
      const root = (
        await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!)
      )._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const { gl, camera, size } = root;
      const core = root.scene.getObjectByName('warp-grid:core');
      const mesh = root.scene.getObjectByName('part:ball');
      const { array: ends, stride } = core.geometry.getAttribute('instanceStart').data;
      const centre = new THREE.Vector3(0, radius, 0),
        eye = camera.getWorldPosition(new THREE.Vector3());
      const point = (i: number) => new THREE.Vector3().fromArray(ends, i);
      // How squarely a point on the ball faces the camera.
      const facing = (p: InstanceType<typeof THREE.Vector3>) =>
        p.clone().sub(centre).normalize().dot(eye.clone().sub(p).normalize());
      const inside = (p: InstanceType<typeof THREE.Vector3>) =>
        p.distanceTo(centre) < radius - 0.4 && p.y > radius + 0.8;
      const sets: Record<string, number[]> = {};
      const add = (name: string, i: number) =>
        (sets[name] ??= []).push(...ends.subarray(i, i + stride));
      for (let i = 0; i < ends.length; i += stride) {
        const a = point(i),
          b = point(i + 3);
        if (part === 'dome') add(inside(a) && inside(b) ? 'inner' : 'outer', i);
        else if (facing(a.clone().add(b).multiplyScalar(0.5)) > 0) add('front', i);
        // An edge that crosses the outline is neither.
        else if (facing(a) < -0.2 && facing(b) < -0.2) add('back', i);
      }
      const target = new THREE.WebGLRenderTarget(size.width, size.height);
      const surface = new THREE.Mesh(
        mesh.geometry,
        new THREE.MeshBasicMaterial({
          color: 0x000000,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        }),
      );
      surface.matrixAutoUpdate = false;
      surface.matrix.copy(mesh.matrixWorld);
      const pixels = new Uint8Array(size.width * size.height * 4);
      const count = (edges: number[] = [], depthTest = true) => {
        if (!edges.length) return 0;
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x000000);
        const geometry = new core.geometry.constructor();
        const buffer = new THREE.InstancedInterleavedBuffer(new Float32Array(edges), stride, 1);
        for (const [name, attribute] of Object.entries(core.geometry.attributes) as any)
          if (attribute.isInterleavedBufferAttribute)
            geometry.setAttribute(
              name,
              new THREE.InterleavedBufferAttribute(buffer, attribute.itemSize, attribute.offset),
            );
        geometry.instanceCount = edges.length / stride;
        const material = core.material.clone();
        material.color.set(0xffffff);
        material.depthTest = depthTest;
        material.resolution.set(size.width, size.height);
        const line = new core.constructor(geometry, material);
        line.frustumCulled = false;
        scene.add(surface, line);
        gl.setRenderTarget(target);
        gl.render(scene, camera);
        gl.readRenderTargetPixels(target, 0, 0, size.width, size.height, pixels);
        gl.setRenderTarget(null);
        geometry.dispose();
        material.dispose();
        let lit = 0;
        for (let p = 0; p < pixels.length; p += 4) if (pixels[p] > 127) lit++;
        return lit;
      };
      const result: Record<string, number> =
        part === 'dome'
          ? { inner: count(sets.inner), outer: count(sets.outer) }
          : {
              front: count(sets.front, false),
              shown: count(sets.front),
              back: count(sets.back),
            };
      target.dispose();
      surface.material.dispose();
      return { edges: ends.length / stride, ...result } as Record<string, number>;
    },
    { part, radius },
  );
}

/** WCAG contrast between drawn grid pixels and the same pixels with the grid hidden. */
async function gridContrast(page: Page, colors: string[]) {
  return page.evaluate(
    async ({ colors, radius }) => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const THREE = await import(urls.find((url) => /\/deps\/three\.js/.test(url))!);
      const root = (
        await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!)
      )._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const { gl, camera, scene } = root;
      const grid = ['warp-grid:casing', 'warp-grid:core'].map((name) =>
        scene.getObjectByName(name),
      );
      const part = scene.getObjectByName('part:ball');
      const { array: ends, stride } = grid[1].geometry.getAttribute('instanceStart').data;
      const canvas = gl.domElement as HTMLCanvasElement,
        width = canvas.width,
        height = canvas.height;
      const context = gl.getContext() as WebGL2RenderingContext;
      const read = () => {
        gl.setRenderTarget(null);
        gl.render(scene, camera);
        const pixels = new Uint8Array(width * height * 4);
        context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);
        return pixels;
      };
      const channel = (v: number) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (p: Uint8Array, i: number) =>
        0.2126 * channel(p[i]) + 0.7152 * channel(p[i + 1]) + 0.0722 * channel(p[i + 2]);
      // Points a third and two thirds along each edge that faces the camera squarely.
      const centre = new THREE.Vector3(0, radius, 0),
        eye = camera.getWorldPosition(new THREE.Vector3());
      const samples: [number, number][] = [];
      const a = new THREE.Vector3(),
        b = new THREE.Vector3(),
        p = new THREE.Vector3();
      for (let i = 0; i < ends.length; i += stride) {
        a.fromArray(ends, i);
        b.fromArray(ends, i + 3);
        for (const t of [1 / 3, 2 / 3]) {
          p.lerpVectors(a, b, t);
          const normal = p.clone().sub(centre).normalize(),
            view = eye.clone().sub(p).normalize();
          if (normal.dot(view) < 0.5) continue;
          p.project(camera);
          if (Math.abs(p.x) > 0.95 || Math.abs(p.y) > 0.95) continue;
          samples.push([Math.round(((p.x + 1) / 2) * width), Math.round(((p.y + 1) / 2) * height)]);
        }
      }
      const results: { color: string; worst: number; low: number; median: number }[] = [];
      const material = part.material;
      const original = material.color.getHex();
      for (const color of colors) {
        material.color.set(color);
        const shown = read();
        grid.forEach((line: any) => (line.visible = false));
        const bare = read();
        grid.forEach((line: any) => (line.visible = true));
        const contrasts = samples.map(([x, y]) => {
          let best = 1;
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++) {
              const i = ((y + dy) * width + x + dx) * 4;
              const [l1, l2] = [luminance(shown, i), luminance(bare, i)].sort((m, n) => n - m);
              best = Math.max(best, (l1 + 0.05) / (l2 + 0.05));
            }
          return best;
        });
        contrasts.sort((m, n) => m - n);
        results.push({
          color,
          worst: contrasts[0],
          low: contrasts[Math.floor(contrasts.length * 0.02)],
          median: contrasts[Math.floor(contrasts.length / 2)],
        });
      }
      material.color.setHex(original);
      root.invalidate();
      return { samples: samples.length, results };
    },
    { colors, radius },
  );
}

async function setLighting(page: Page, preset: string) {
  await page.evaluate(async (preset) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const { presetLighting } = await import(
      urls.find((url) => /\/src\/core\/lighting\.ts(?:\?.*)?$/.test(url))!
    );
    useEditor.setState((state: any) => ({
      scene: { ...state.scene, lighting: presetLighting(preset) },
    }));
  }, preset);
  // Lights and shadows take a frame to follow.
  await page.waitForTimeout(200);
}

// The design asks for 90 % at the default density; coarser grids have longer, deeper chords.
const visibleShare = [
  [0, 0.85],
  [3, 0.9],
  [6, 0.9],
] as const;

test('the grid is drawn along nearly all of a curved part and not through it', async ({ page }) => {
  await layGrid(page);
  for (const [level, share] of visibleShare) {
    await setDensity(page, level);
    for (const [view, direction] of [
      ['front', [0, 0.2, 1]],
      ['glancing', [1, 0.15, 0.3]],
    ] as const) {
      await lookFrom(page, [...direction]);
      const grid = await gridPixels(page, 'ball');
      test.info().annotations.push({
        type: `density ${level}, ${view}`,
        description: JSON.stringify(grid),
      });
      expect(grid.front).toBeGreaterThan(1000);
      expect(grid.shown / grid.front, `density ${level}, ${view}`).toBeGreaterThan(share);
      expect(grid.back / grid.front, `density ${level}, ${view}`).toBeLessThan(0.002);
    }
  }
});

test('the inner surface of a thin part never shows through its outer one', async ({ page }) => {
  await layGrid(page, dome());
  for (const level of [0, 3]) {
    await setDensity(page, level);
    for (const direction of [
      [0.2, 1, 0.3],
      [1, 0.6, 0.2],
    ]) {
      await lookFrom(page, direction);
      const grid = await gridPixels(page, 'dome');
      test.info().annotations.push({
        type: `density ${level}, from ${direction}`,
        description: JSON.stringify(grid),
      });
      expect(grid.outer).toBeGreaterThan(1000);
      expect(grid.inner).toBeLessThan(grid.outer * 0.002);
    }
  }
});

test('grid lines stand out over light, dark and Distinct colours in every lighting', async ({
  page,
}) => {
  await layGrid(page);
  const colors = [...Array.from({ length: 24 }, (_, i) => distinctColor(i)), '#ffffff', '#1c1c1c'];
  for (const preset of ['studio', 'soft', 'headlight', 'dramatic']) {
    await setLighting(page, preset);
    const { samples, results } = await gridContrast(page, colors);
    test.info().annotations.push({ type: preset, description: JSON.stringify(results) });
    expect(samples).toBeGreaterThan(200);
    // Nearly every point along the lines reaches 3:1 against the surface under it.
    for (const result of results)
      expect(result.low, `${preset} ${result.color}`).toBeGreaterThan(3);
  }
});
