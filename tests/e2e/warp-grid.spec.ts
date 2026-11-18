import { expect, test, type Page } from '@playwright/test';
import {
  BoxGeometry,
  LatheGeometry,
  PlaneGeometry,
  SphereGeometry,
  Vector2,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { serializeGeometry } from '../../src/core/geometry';
import { distinctColor } from '../../src/core/appearance';
import type { Vec3 } from '../../src/core/types';

// A curved convex part about the size of a miniature's head or shoulder pad.
const radius = 15;
const ball = () => new SphereGeometry(radius, 96, 64);

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

/** A 30 mm box with a plate 4 mm in front of its front face, covering most of it. */
function coveredBox() {
  const plate = new BoxGeometry(20, 20, 1, 4, 4, 1).translate(0, 0, 19.5);
  return mergeGeometries([new BoxGeometry(30, 30, 30, 6, 6, 6), plate]);
}

interface Placement {
  quaternion?: [number, number, number, number];
  scale?: Vec3;
}

const scene = (
  geometry: BufferGeometry,
  { quaternion = [0, 0, 0, 1], scale = [1, 1, 1] }: Placement,
) => ({
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
      quaternion,
      scale,
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

async function layGrid(page: Page, geometry: BufferGeometry, placement: Placement = {}) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'grid.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scene(geometry, placement))),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Scanned ball"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page.keyboard.press('w');
  await page.getByRole('radio', { name: 'Whole part', exact: true }).click();
  await page.getByRole('button', { name: 'Lay grid', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close gap', exact: true })).toBeEnabled();
  await gridTraced(page);
}

/** Waits until the grid's edges are laid along the surface rather than drawn as chords. */
async function gridTraced(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
        const root = (
          await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!)
        )._roots
          .get(document.querySelector('canvas'))
          .store.getState();
        const { useEditor } = await import(
          urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
        );
        const { warp } = useEditor.getState();
        const space = root.scene.getObjectByName('warp-grid');
        return (
          warp?.stage === 'warp' && space?.userData.model === warp.model && space.userData.traced
        );
      }),
    )
    .toBe(true);
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
  await gridTraced(page);
}

async function setProjection(page: Page, projection: 'perspective' | 'orthographic') {
  await page.evaluate(async (projection) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    useEditor.setState((state: any) => ({ view: { ...state.view, projection } }));
  }, projection);
  await page.waitForTimeout(100);
}

/** Points the camera at the part's centre from a direction, at a distance or orthographic zoom. */
async function lookFrom(page: Page, direction: number[], distance = 70, zoom = 12) {
  await page.evaluate(
    async ({ direction, radius, distance, zoom }) => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const root = (
        await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!)
      )._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const { camera, controls } = root;
      const centre = camera.position.clone().set(0, radius, 0);
      const offset = camera.position
        .clone()
        .fromArray(direction)
        .normalize()
        .multiplyScalar(distance);
      controls.target.copy(centre);
      camera.position.copy(centre).add(offset);
      camera.lookAt(centre);
      if (camera.isOrthographicCamera) {
        camera.zoom = zoom;
        camera.updateProjectionMatrix();
      }
      controls.update();
      root.invalidate();
      // Frames that follow the camera, such as a headlight's, run before the next measurement.
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    },
    { direction, radius, distance, zoom },
  );
}

type Shape = 'ball' | 'dome' | 'box' | 'plate';

/**
 * Visible share of grid length by class. Each segment of the grid's core is drawn in its own
 * colour with the core's own material, over the part with the part's own depth offset, and each
 * sample along a segment counts as visible where its pixel shows that segment or its neighbour
 * along the edge. Samples within a few pixels of a node, where edges meet, are left out.
 *
 * Samples that should be hidden are not counted within 3 px of an outline or a step in the
 * surface's depth, where a line's width overhangs the edge in front of it.
 *
 * Classes: on the ball and plate, `front` and `back` by the surface's facing at the sample. On
 * the dome, `inner` and `outer` sheet samples that face the camera or away. On the box, the part
 * of its front face behind the plate, and the plate's own front.
 */
async function gridVisibility(page: Page, shape: Shape) {
  return page.evaluate(
    async ({ shape, radius }) => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const THREE = await import(urls.find((url) => /\/deps\/three\.js/.test(url))!);
      const root = (
        await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!)
      )._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const { useEditor } = await import(
        urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
      );
      const { gl, camera, size } = root;
      const core = root.scene.getObjectByName('warp-grid:core');
      const mesh = root.scene.getObjectByName('part:ball');
      const source = core.geometry;
      const { array } = source.getAttribute('instanceStart').data;
      const count: number = source.instanceCount;
      const toWorld = core.matrixWorld;
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(toWorld);
      const buffer = gl.getDrawingBufferSize(new THREE.Vector2());
      const width = buffer.x,
        height = buffer.y,
        ratio = width / size.width;

      let nonFinite = 0;
      for (let i = 0; i < count * 6; i++) if (!Number.isFinite(array[i])) nonFinite++;

      // Each segment's id in its colour; 0 is the background.
      const colors = new Float32Array(count * 6);
      for (let i = 0; i < count; i++) {
        const id = i + 1;
        for (const o of [0, 3]) {
          colors[i * 6 + o] = (id & 255) / 255;
          colors[i * 6 + o + 1] = ((id >> 8) & 255) / 255;
          colors[i * 6 + o + 2] = ((id >> 16) & 255) / 255;
        }
      }
      const geometry = new source.constructor();
      for (const name of ['instanceStart', 'instanceEnd'])
        geometry.setAttribute(name, source.getAttribute(name));
      const colorBuffer = new THREE.InstancedInterleavedBuffer(colors, 6, 1);
      geometry.setAttribute(
        'instanceColorStart',
        new THREE.InterleavedBufferAttribute(colorBuffer, 3, 0),
      );
      geometry.setAttribute(
        'instanceColorEnd',
        new THREE.InterleavedBufferAttribute(colorBuffer, 3, 3),
      );
      geometry.instanceCount = count;
      const material = core.material.clone();
      material.vertexColors = true;
      material.color.set(0xffffff);
      material.transparent = false;
      material.blending = THREE.NoBlending;
      material.opacity = 1;
      material.resolution.set(size.width, size.height);
      const line = new core.constructor(geometry, material);
      line.frustumCulled = false;
      // After the surface, as in the viewport: lines test depth but do not write it.
      line.renderOrder = 1;
      line.matrixAutoUpdate = false;
      line.matrix.copy(toWorld);
      line.matrixWorldNeedsUpdate = true;
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
      surface.matrixWorldNeedsUpdate = true;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x000000);
      scene.add(surface, line);
      const target = new THREE.WebGLRenderTarget(width, height);
      gl.setRenderTarget(target);
      gl.render(scene, camera);
      const pixels = new Uint8Array(width * height * 4);
      gl.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      // The surface's own view depth, to find where it ends or one part of it covers another.
      const depthTarget = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType });
      const depthMaterial = new THREE.ShaderMaterial({
        vertexShader: `varying float vDepth;
          void main() {
            vec4 view = modelViewMatrix * vec4(position, 1.0);
            vDepth = -view.z;
            gl_Position = projectionMatrix * view;
          }`,
        fragmentShader: `varying float vDepth;
          void main() { gl_FragColor = vec4(vDepth, 0.0, 0.0, 1.0); }`,
      });
      const plain = surface.material;
      surface.material = depthMaterial;
      line.visible = false;
      scene.background = null;
      const clearColor = gl.getClearColor(new THREE.Color()),
        clearAlpha = gl.getClearAlpha();
      gl.setClearColor(0x000000, 0);
      gl.setRenderTarget(depthTarget);
      gl.clear();
      gl.render(scene, camera);
      const depths = new Float32Array(width * height * 4);
      gl.readRenderTargetPixels(depthTarget, 0, 0, width, height, depths);
      gl.setRenderTarget(null);
      gl.setClearColor(clearColor, clearAlpha);
      surface.material = plain;
      depthMaterial.dispose();
      depthTarget.dispose();
      target.dispose();
      geometry.dispose();
      material.dispose();
      surface.material.dispose();
      // Within a few pixels of the surface's outline or of a step in depth, a line's width can
      // overhang the edge in front of it.
      const band = Math.ceil(3 * ratio);
      const nearStep = (x: number, y: number) => {
        let low = Infinity,
          high = -Infinity;
        for (let dy = -band; dy <= band; dy++)
          for (let dx = -band; dx <= band; dx++) {
            const px = Math.min(width - 1, Math.max(0, x + dx)),
              py = Math.min(height - 1, Math.max(0, y + dy));
            const d = depths[(py * width + px) * 4] || Infinity;
            low = Math.min(low, d);
            high = Math.max(high, d);
          }
        return high - low > 1;
      };

      // Projected nodes, bucketed by pixel, to leave out samples where edges meet.
      const near = 3 * ratio;
      const nodes: number[][] = [];
      const bucket = new Map<number, number[][]>();
      const nodePositions = useEditor.getState().warp.state.positions;
      const p = new THREE.Vector3();
      for (let i = 0; i < nodePositions.length; i += 3) {
        p.fromArray(nodePositions, i).project(camera);
        const node = [((p.x + 1) / 2) * width, ((p.y + 1) / 2) * height];
        nodes.push(node);
        const key = Math.floor(node[0] / 8) * 100000 + Math.floor(node[1] / 8);
        if (!bucket.has(key)) bucket.set(key, []);
        bucket.get(key)!.push(node);
      }
      const nearNode = (x: number, y: number) => {
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            for (const [nx, ny] of bucket.get(
              (Math.floor(x / 8) + dx) * 100000 + Math.floor(y / 8) + dy,
            ) ?? [])
              if (Math.hypot(nx - x, ny - y) < near) return true;
        return false;
      };

      const eye = camera.getWorldPosition(new THREE.Vector3());
      const forward = camera.getWorldDirection(new THREE.Vector3());
      const toEye = (q: InstanceType<typeof THREE.Vector3>) =>
        camera.isOrthographicCamera ? forward.clone().negate() : eye.clone().sub(q).normalize();
      const centre = new THREE.Vector3(0, radius, 0);
      const plateNormal = new THREE.Vector3(0, 0, 1).applyMatrix3(normalMatrix).normalize();
      const classify = (
        local: InstanceType<typeof THREE.Vector3>,
        world: InstanceType<typeof THREE.Vector3>,
      ) => {
        const view = toEye(world);
        if (shape === 'ball') {
          const facing = world.clone().sub(centre).normalize().dot(view);
          return facing > 0 ? 'front' : 'back';
        }
        if (shape === 'plate') return plateNormal.dot(view) > 0 ? 'front' : 'back';
        if (shape === 'box') {
          if (Math.abs(local.z - 15) < 0.05 && Math.abs(local.x) < 9.5 && Math.abs(local.y) < 9.5)
            return 'covered';
          if (Math.abs(local.z - 20) < 0.05) return 'plate';
          return null;
        }
        // The dome's sheets, away from its rim.
        if (local.y < 0.8) return null;
        const outward = local.length() > radius - 0.4;
        const normal = world.clone().sub(centre).normalize();
        if (!outward) normal.negate();
        const facing = normal.dot(view) > 0 ? 'facing' : 'away';
        return `${outward ? 'outer' : 'inner'} ${facing}`;
      };

      const tally: Record<string, { samples: number; visible: number }> = {};
      const hidden = new Set(['back', 'covered', 'inner away', 'outer away']);
      const edgeSamples: Record<string, number> = {};
      const a = new THREE.Vector3(),
        b = new THREE.Vector3(),
        local = new THREE.Vector3(),
        world = new THREE.Vector3(),
        screen = new THREE.Vector3();
      for (let i = 0; i < count; i++) {
        a.fromArray(array, i * 6);
        b.fromArray(array, i * 6 + 3);
        const length = a.clone().applyMatrix4(toWorld).distanceTo(b.clone().applyMatrix4(toWorld));
        const steps = Math.max(1, Math.ceil(length / 0.05));
        for (let s = 0; s < steps; s++) {
          local.lerpVectors(a, b, (s + 0.5) / steps);
          world.copy(local).applyMatrix4(toWorld);
          const name = classify(local, world);
          if (!name) continue;
          screen.copy(world).project(camera);
          if (Math.abs(screen.x) > 0.98 || Math.abs(screen.y) > 0.98 || Math.abs(screen.z) > 1)
            continue;
          const x = ((screen.x + 1) / 2) * width,
            y = ((screen.y + 1) / 2) * height;
          if (nearNode(x, y)) continue;
          if (hidden.has(name) && nearStep(Math.floor(x), Math.floor(y))) {
            edgeSamples[name] = (edgeSamples[name] ?? 0) + 1;
            continue;
          }
          const o = (Math.floor(y) * width + Math.floor(x)) * 4;
          const id = pixels[o] + pixels[o + 1] * 256 + pixels[o + 2] * 65536 - 1;
          const entry = (tally[name] ??= { samples: 0, visible: 0 });
          entry.samples++;
          if (Math.abs(id - i) <= 1) entry.visible++;
        }
      }
      const shares: Record<string, number> = {};
      for (const [name, { samples, visible }] of Object.entries(tally))
        shares[name] = visible / samples;
      return { segments: count, nodes: nodes.length, nonFinite, tally, shares, edgeSamples };
    },
    { shape, radius },
  );
}

const colors = [...Array.from({ length: 24 }, (_, i) => distinctColor(i)), '#ffffff', '#1c1c1c'];

/**
 * WCAG contrast of the grid at points along edges that face the camera squarely, away from
 * nodes: at each point,
 * the best contrast across the line's width between the drawn pixels and the same pixels with the
 * grid hidden. Returns the worst point for each part colour.
 */
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
      const { useEditor } = await import(
        urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
      );
      const { gl, camera, scene, size } = root;
      const grid = ['warp-grid:casing', 'warp-grid:core'].map((name) =>
        scene.getObjectByName(name),
      );
      const part = scene.getObjectByName('part:ball');
      const core = grid[1];
      const { array } = core.geometry.getAttribute('instanceStart').data;
      const count: number = core.geometry.instanceCount;
      const canvas = gl.domElement as HTMLCanvasElement,
        width = canvas.width,
        height = canvas.height,
        ratio = width / size.width;
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
      // The middle of each segment that faces the camera squarely, and the line's screen normal.
      // Where edges meet at a node their cores cover each other's casings, so points within a
      // few pixels of one are left out.
      const centre = new THREE.Vector3(0, radius, 0),
        eye = camera.getWorldPosition(new THREE.Vector3()),
        forward = camera.getWorldDirection(new THREE.Vector3());
      const a = new THREE.Vector3(),
        b = new THREE.Vector3(),
        p = new THREE.Vector3();
      const nodes: [number, number][] = [];
      const positions = useEditor.getState().warp.state.positions;
      for (let i = 0; i < positions.length; i += 3) {
        p.fromArray(positions, i).project(camera);
        nodes.push([((p.x + 1) / 2) * width, ((p.y + 1) / 2) * height]);
      }
      const apart = 8 * ratio;
      const samples: [number, number, number, number][] = [];
      for (let i = 0; i < count; i++) {
        a.fromArray(array, i * 6).applyMatrix4(core.matrixWorld);
        b.fromArray(array, i * 6 + 3).applyMatrix4(core.matrixWorld);
        p.lerpVectors(a, b, 0.5);
        const normal = p.clone().sub(centre).normalize(),
          view = camera.isOrthographicCamera
            ? forward.clone().negate()
            : eye.clone().sub(p).normalize();
        if (normal.dot(view) < 0.5) continue;
        a.project(camera);
        b.project(camera);
        p.project(camera);
        if (Math.abs(p.x) > 0.95 || Math.abs(p.y) > 0.95) continue;
        const dx = (b.x - a.x) * width,
          dy = (b.y - a.y) * height,
          l = Math.hypot(dx, dy);
        if (!(l > 0)) continue;
        const x = ((p.x + 1) / 2) * width,
          y = ((p.y + 1) / 2) * height;
        if (nodes.some(([nx, ny]) => Math.hypot(nx - x, ny - y) < apart)) continue;
        samples.push([x, y, -dy / l, dx / l]);
      }
      const results: { color: string; worst: number; median: number }[] = [];
      const material = part.material;
      const original = material.color.getHex();
      // Across the casing's full width, 6.5 px.
      const reach = Math.ceil(3.25 * ratio);
      for (const color of colors) {
        material.color.set(color);
        const shown = read();
        grid.forEach((line: any) => (line.visible = false));
        const bare = read();
        grid.forEach((line: any) => (line.visible = true));
        const contrasts = samples.map(([x, y, nx, ny]) => {
          let best = 1;
          for (let k = -reach; k <= reach; k++) {
            const i = (Math.floor(y + k * ny) * width + Math.floor(x + k * nx)) * 4;
            const [l1, l2] = [luminance(shown, i), luminance(bare, i)].sort((m, n) => n - m);
            best = Math.max(best, (l1 + 0.05) / (l2 + 0.05));
          }
          return best;
        });
        contrasts.sort((m, n) => m - n);
        results.push({ color, worst: contrasts[0], median: contrasts[contrasts.length >> 1] });
      }
      material.color.setHex(original);
      root.invalidate();
      return { samples: samples.length, results };
    },
    { colors, radius },
  );
}

/**
 * Over the middle of the part (a disc of half its projected radius): the share of pixels the grid
 * changes at all, by more than 12 levels in a channel, and the share it changes noticeably, by
 * more than 1.5:1 in luminance contrast.
 */
async function gridCover(page: Page) {
  return page.evaluate(async (radius) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const THREE = await import(urls.find((url) => /\/deps\/three\.js/.test(url))!);
    const root = (await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!))._roots
      .get(document.querySelector('canvas'))
      .store.getState();
    const { gl, camera, scene, size } = root;
    const grid = ['warp-grid:casing', 'warp-grid:core'].map((name) => scene.getObjectByName(name));
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
    const shown = read();
    grid.forEach((line: any) => (line.visible = false));
    const bare = read();
    grid.forEach((line: any) => (line.visible = true));
    root.invalidate();
    const centre = new THREE.Vector3(0, radius, 0).project(camera);
    const edge = new THREE.Vector3(0, radius, 0)
      .addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), radius)
      .project(camera);
    const cx = ((centre.x + 1) / 2) * width,
      cy = ((centre.y + 1) / 2) * height,
      // The part's radius in pixels, and the disc of half that radius in its middle.
      reach = (Math.abs(edge.x - centre.x) * width) / 2,
      middle = reach / 2;
    const channel = (v: number) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (p: Uint8Array, i: number) =>
      0.2126 * channel(p[i]) + 0.7152 * channel(p[i + 1]) + 0.0722 * channel(p[i + 2]);
    let pixels = 0,
      changed = 0,
      covered = 0;
    for (let y = Math.floor(cy - middle); y < cy + middle; y++)
      for (let x = Math.floor(cx - middle); x < cx + middle; x++) {
        if (Math.hypot(x - cx, y - cy) > middle) continue;
        const i = (y * width + x) * 4;
        pixels++;
        if (
          Math.max(
            Math.abs(shown[i] - bare[i]),
            Math.abs(shown[i + 1] - bare[i + 1]),
            Math.abs(shown[i + 2] - bare[i + 2]),
          ) > 12
        )
          changed++;
        const [l1, l2] = [luminance(shown, i), luminance(bare, i)].sort((m, n) => n - m);
        if ((l1 + 0.05) / (l2 + 0.05) > 1.5) covered++;
      }
    return {
      across: (2 * reach) / (width / size.width),
      changed: changed / pixels,
      covered: covered / pixels,
    };
  }, radius);
}

/** Sets a lighting preset and waits until the viewport's lights are the preset's. */
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
  await expect
    .poll(() =>
      page.evaluate(async (preset) => {
        const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
        const { presetLighting } = await import(
          urls.find((url) => /\/src\/core\/lighting\.ts(?:\?.*)?$/.test(url))!
        );
        const root = (
          await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!)
        )._roots
          .get(document.querySelector('canvas'))
          .store.getState();
        const lit: number[] = [];
        root.scene.traverse((object: any) => {
          if (object.isDirectionalLight || object.isPointLight || object.isSpotLight)
            lit.push(object.intensity);
        });
        const wanted = presetLighting(preset).lights.map((light: any) => light.intensity);
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        return JSON.stringify(lit.sort()) === JSON.stringify(wanted.sort());
      }, preset),
    )
    .toBe(true);
}

function note(name: string, value: unknown) {
  test.info().annotations.push({ type: name, description: JSON.stringify(value) });
}

test('the grid lies along a curved part, all of its facing side drawn and none of the rest', async ({
  page,
}) => {
  await layGrid(page, ball());
  for (const level of [0, 3, 6]) {
    await setDensity(page, level);
    for (const [view, direction] of [
      ['front', [0, 0.2, 1]],
      ['glancing', [1, 0.15, 0.3]],
    ] as const) {
      await lookFrom(page, [...direction]);
      const grid = await gridVisibility(page, 'ball');
      note(`density ${level}, ${view}`, grid);
      expect(grid.nonFinite).toBe(0);
      expect(grid.tally.front.samples).toBeGreaterThan(2000);
      expect(grid.shares.front, `density ${level}, ${view}`).toBeGreaterThan(0.9);
      expect(grid.shares.back, `density ${level}, ${view}`).toBeLessThan(0.002);
    }
  }
});

test('a thin shell shows neither sheet through the other', async ({ page }) => {
  await layGrid(page, dome());
  for (const level of [0, 3]) {
    await setDensity(page, level);
    // From low on the hollow side the dome's own wall hides much of its inner sheet.
    for (const [view, direction, whole] of [
      ['outside', [0.2, 1, 0.3], true],
      ['outside, low', [1, 0.6, 0.2], true],
      ['hollow side', [0.2, -1, 0.3], true],
      ['hollow side, low', [1, -0.5, 0.2], false],
    ] as const) {
      await lookFrom(page, [...direction]);
      const grid = await gridVisibility(page, 'dome');
      note(`density ${level}, ${view}`, grid);
      const facing = view.startsWith('outside') ? 'outer facing' : 'inner facing';
      const hidden = view.startsWith('outside') ? 'inner away' : 'outer away';
      expect(grid.tally[facing].samples).toBeGreaterThan(1000);
      if (whole) expect(grid.shares[facing], `density ${level}, ${view}`).toBeGreaterThan(0.9);
      expect(grid.tally[hidden].samples).toBeGreaterThan(1000);
      expect(grid.shares[hidden], `density ${level}, ${view}`).toBeLessThan(0.002);
    }
  }
});

test('a face behind another face of the part hides its grid', async ({ page }) => {
  await layGrid(page, coveredBox());
  for (const level of [0, 3]) {
    await setDensity(page, level);
    for (const direction of [
      [0, 0, 1],
      [0.25, 0.2, 1],
    ]) {
      await lookFrom(page, direction, 90);
      const grid = await gridVisibility(page, 'box');
      note(`density ${level}, from ${direction}`, grid);
      expect(grid.tally.covered.samples).toBeGreaterThan(200);
      expect(grid.shares.covered, `density ${level}, from ${direction}`).toBeLessThan(0.002);
      expect(grid.shares.plate, `density ${level}, from ${direction}`).toBeGreaterThan(0.9);
    }
  }
});

test('a mirrored part and a turned, unevenly scaled plate draw their grids whole', async ({
  page,
}) => {
  await layGrid(page, ball(), { scale: [-1, 1, 1] });
  await lookFrom(page, [0, 0.2, 1]);
  const mirrored = await gridVisibility(page, 'ball');
  note('mirrored ball', mirrored);
  expect(mirrored.nonFinite).toBe(0);
  expect(mirrored.shares.front).toBeGreaterThan(0.9);
  expect(mirrored.shares.back).toBeLessThan(0.002);

  // Turned 40° about a slanted axis and stretched unevenly.
  const half = (40 * Math.PI) / 360,
    axis = [0.3, 0.8, 0.52],
    l = Math.hypot(...axis);
  const quaternion = [
    ...axis.map((v) => (v / l) * Math.sin(half)),
    Math.cos(half),
  ] as Placement['quaternion'];
  await layGrid(page, new PlaneGeometry(30, 30, 48, 48), { quaternion, scale: [1.6, 0.7, 2.5] });
  for (const level of [3, 6]) {
    await setDensity(page, level);
    const plate = await gridVisibility(page, 'plate');
    const facing = plate.tally.front ? 'front' : 'back';
    note(`plate, density ${level}`, plate);
    expect(plate.nonFinite).toBe(0);
    expect(plate.tally[facing].samples).toBeGreaterThan(1000);
    expect(plate.shares[facing]).toBeGreaterThan(0.9);
  }
});

test('the surface stays visible between the lines of the finest grid', async ({ page }) => {
  await layGrid(page, ball());
  await setDensity(page, 6);
  // About 260 px across, as a part this size is with a whole model in view.
  await lookFrom(page, [0, 0.2, 1], 150);
  const far = await gridCover(page);
  note('far', far);
  expect(far.across).toBeGreaterThan(240);
  expect(far.across).toBeLessThan(290);
  // Most of the surface shows through unaltered or nearly so, and the grid is still there.
  expect(far.covered).toBeLessThan(0.5);
  expect(far.changed).toBeLessThan(0.65);
  expect(far.covered).toBeGreaterThan(0.1);
  await lookFrom(page, [0, 0.2, 1]);
  const near = await gridCover(page);
  note('near', near);
  expect(near.covered).toBeLessThan(0.5);
  expect(near.changed).toBeLessThan(0.65);
});

test('grid lines stand out over light, dark and Distinct colours in every lighting', async ({
  page,
}) => {
  await layGrid(page, ball());
  await lookFrom(page, [0, 0.2, 1]);
  for (const preset of ['studio', 'soft', 'headlight', 'dramatic']) {
    await setLighting(page, preset);
    const { samples, results } = await gridContrast(page, colors);
    note(preset, results);
    expect(samples).toBeGreaterThan(200);
    for (const result of results)
      expect(result.worst, `${preset} ${result.color}`).toBeGreaterThan(3);
  }
});

test('the grid is whole and stands out with an orthographic camera', async ({ page }) => {
  await layGrid(page, ball());
  await setProjection(page, 'orthographic');
  for (const [view, direction] of [
    ['front', [0, 0.2, 1]],
    ['glancing', [1, 0.15, 0.3]],
  ] as const) {
    await lookFrom(page, [...direction], 200);
    const grid = await gridVisibility(page, 'ball');
    note(view, grid);
    expect(grid.shares.front, view).toBeGreaterThan(0.9);
    expect(grid.shares.back, view).toBeLessThan(0.002);
  }
  await lookFrom(page, [0, 0.2, 1], 200);
  const { samples, results } = await gridContrast(page, colors);
  note('contrast', results);
  expect(samples).toBeGreaterThan(200);
  for (const result of results) expect(result.worst, result.color).toBeGreaterThan(3);
});

test.describe('at device pixel ratio 2', () => {
  test.use({ deviceScaleFactor: 2 });

  test('the grid is whole and stands out', async ({ page }) => {
    await layGrid(page, ball());
    await lookFrom(page, [0, 0.2, 1]);
    const grid = await gridVisibility(page, 'ball');
    note('visibility', grid);
    expect(grid.shares.front).toBeGreaterThan(0.9);
    expect(grid.shares.back).toBeLessThan(0.002);
    const { samples, results } = await gridContrast(page, colors);
    note('contrast', results);
    expect(samples).toBeGreaterThan(200);
    for (const result of results) expect(result.worst, result.color).toBeGreaterThan(3);
  });
});
