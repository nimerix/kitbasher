import { expect, test, type Page } from '@playwright/test';
import type { BufferGeometry } from 'three';
import { serializeGeometry } from '../../../src/core/geometry';
import type { Vec3 } from '../../../src/core/types';

/** The grid fixtures' part: about the size of a miniature's head or shoulder pad. */
export const radius = 15;

export interface Placement {
  position?: Vec3;
  quaternion?: [number, number, number, number];
  scale?: Vec3;
  color?: string;
}

/** A part for a fixture scene. The first is the one warped: its id is `ball`. */
export const fixturePart = (
  id: string,
  geometry: BufferGeometry,
  {
    position = [0, radius, 0],
    quaternion = [0, 0, 0, 1],
    scale = [1, 1, 1],
    color = '#d4a272',
  }: Placement = {},
) => ({
  id,
  name: id === 'ball' ? 'Scanned ball' : id,
  position,
  color,
  geometry: serializeGeometry(geometry),
  quaternion,
  scale,
  visible: true,
  locked: false,
  source: 'test',
});

export function failOnBrowserErrors() {
  const errors = new WeakMap<Page, string[]>();
  test.beforeEach(({ page }) => {
    const list: string[] = [];
    errors.set(page, list);
    page.on('pageerror', (error) => list.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') list.push(message.text());
    });
  });
  test.afterEach(async ({ page }) => {
    expect(errors.get(page)).toEqual([]);
  });
}

/**
 * Opens a scene of the warped part and any others, and lays a grid over the whole of it at
 * `density`: by default 3, the default for a painted region, which a whole part's grid had too
 * when these tests were written.
 */
export async function layGrid(
  page: Page,
  geometry: BufferGeometry,
  placement: Placement = {},
  others: ReturnType<typeof fixturePart>[] = [],
  density = 3,
) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  const scene = {
    format: 'kitbasher',
    version: 1,
    units: 'mm',
    name: 'Warp grid',
    joints: [],
    parts: [fixturePart('ball', geometry, placement), ...others],
  };
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'grid.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scene)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await page.locator('.part-select[title="Scanned ball"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page.keyboard.press('w');
  await page.getByRole('radio', { name: 'Whole part', exact: true }).click();
  await page.getByRole('button', { name: 'Lay grid', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close gap', exact: true })).toBeEnabled();
  await setDensity(page, density);
}

/**
 * Waits until the grid's edges are laid along the surface rather than drawn as chords, the solve
 * has settled, its buffers hold the surface as last written, and the drawn line was checked
 * against it, its points chosen again if it strayed.
 */
export async function gridTraced(page: Page) {
  await expect
    .poll(
      () =>
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
          const drawing = space?.userData.drawing;
          const version = warp?.preview?.getAttribute('position').version ?? 0;
          return (
            warp?.stage === 'warp' &&
            !warp.settling &&
            space?.userData.model === warp.model &&
            space.userData.traced &&
            drawing.written === version &&
            drawing.refined === version
          );
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
}

export async function setDensity(page: Page, level: number) {
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

export async function setProjection(page: Page, projection: 'perspective' | 'orthographic') {
  await page.evaluate(async (projection) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    useEditor.setState((state: any) => ({ view: { ...state.view, projection } }));
  }, projection);
  await page.waitForTimeout(100);
}

/** Points the camera at `centre` from a direction, at a distance or orthographic zoom. */
export async function lookFrom(
  page: Page,
  direction: number[],
  distance = 70,
  zoom = 12,
  centre: number[] = [0, radius, 0],
) {
  await page.evaluate(
    async ({ direction, distance, zoom, centre }) => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const root = (
        await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!)
      )._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const { camera, controls } = root;
      const target = camera.position.clone().fromArray(centre);
      const offset = camera.position
        .clone()
        .fromArray(direction)
        .normalize()
        .multiplyScalar(distance);
      controls.target.copy(target);
      camera.position.copy(target).add(offset);
      camera.lookAt(target);
      if (camera.isOrthographicCamera) {
        camera.zoom = zoom;
        camera.updateProjectionMatrix();
      }
      controls.update();
      root.invalidate();
      // Frames that follow the camera, such as a headlight's, run before the next measurement.
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    },
    { direction, distance, zoom, centre },
  );
}

/** Sets a lighting preset and waits until the viewport's lights are the preset's. */
export async function setLighting(page: Page, preset: string) {
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

export function note(name: string, value: unknown) {
  test.info().annotations.push({ type: name, description: JSON.stringify(value) });
}

/** The part's width on screen in CSS pixels, and a typical cell's at the part's centre. */
export function partAcross(page: Page, part = 'ball') {
  return page.evaluate(async (part) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const THREE = await import(urls.find((url) => /\/deps\/three\.js/.test(url))!);
    const root = (await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!))._roots
      .get(document.querySelector('canvas'))
      .store.getState();
    const mesh = root.scene.getObjectByName(`part:${part}`);
    const { camera, size } = root;
    const position = mesh.geometry.getAttribute('position');
    const point = new THREE.Vector3();
    let low = Infinity,
      high = -Infinity;
    const stride = Math.max(1, Math.floor(position.count / 50_000));
    for (let i = 0; i < position.count; i += stride) {
      point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).project(camera);
      low = Math.min(low, point.x);
      high = Math.max(high, point.x);
    }
    const across = ((high - low) / 2) * size.width;
    const box = new THREE.Box3().setFromObject(mesh);
    const centre = box.getCenter(new THREE.Vector3());
    const space = root.scene.getObjectByName('warp-grid:core');
    const cell = space ? space.material.uniforms.cell.value : 0;
    const distance = camera.isOrthographicCamera
      ? 1
      : centre.applyMatrix4(camera.matrixWorldInverse).negate().z;
    const pixel = (2 * distance) / (camera.projectionMatrix.elements[5] * size.height);
    return { across, cell: cell / pixel };
  }, part);
}

export type GridPass = 'core' | 'casing';

/**
 * Where each pass of the grid shows, measured from what is drawn. For each pass, every segment
 * is drawn with the production vertex shader, geometry and normals, its instance number as its
 * colour wherever the line's width covers at least half a pixel, however faded, after the parts'
 * own surfaces as in the viewport: what the depth test hides, not what fades. Samples every
 * 0.05 mm along each segment count as shown where their pixel holds a segment of the same grid
 * edge, and as drawn where it holds any segment. Samples within a few pixels of a node, where
 * edges cross, are left out.
 *
 * Beside that, the viewport's own blended image is read with the grid shown and hidden. A sample
 * counts as touched where the two differ by more than 12 levels in a channel, and as stray where
 * it is touched though no ID pass draws any segment within two pixels: grid showing where the
 * ID passes say nothing does.
 *
 * Classes by shape: on the ball and plate, `front` and `back` by the surface's facing at the
 * sample. On the dome, `inner` and `outer` sheet samples that face the camera or away. On the box,
 * the part of its front face behind its own plate, and the plate's front. Behind a cover, every
 * sample is `covered`. Samples within 3 px of an outline or of a jump in depth are tallied apart,
 * under the class name with ` rim`, because a line's width can overhang an edge in front of it.
 */
export type GridShape = 'ball' | 'dome' | 'box' | 'plate' | 'covered';

export async function gridVisibility(
  page: Page,
  shape: GridShape,
  passes: GridPass[] = ['core', 'casing'],
) {
  return page.evaluate(
    async ({ shape, passes, radius }) => {
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
      const { gl, camera, size, scene: viewport } = root;
      const space = viewport.getObjectByName('warp-grid');
      const lines = {
        core: viewport.getObjectByName('warp-grid:core'),
        casing: viewport.getObjectByName('warp-grid:casing'),
      };
      const drawing = space.userData.drawing;
      const count: number = drawing.segments;
      const drawn: Float32Array = drawing.drawn();
      const toWorld = lines.core.matrixWorld;
      const buffer = gl.getDrawingBufferSize(new THREE.Vector2());
      const width = buffer.x,
        height = buffer.y,
        ratio = width / size.width;

      let nonFinite = 0;
      for (let i = 0; i < count * 6; i++) if (!Number.isFinite(drawn[i])) nonFinite++;
      // The grid edge of each segment.
      const edgeOf: Uint32Array = drawing.edgeOf;

      const parts = viewport.children
        .flatMap((child: any) => {
          const found: any[] = [];
          child.traverse((object: any) => {
            if (object.isMesh && object.name.startsWith('part:')) found.push(object);
          });
          return found;
        })
        .filter((mesh: any) => mesh.visible);
      // Every part's surface in black over a black background, as the viewport orders them:
      // the surfaces first, then the line, which tests depth without writing it.
      const surfaces = parts.map((mesh: any) => {
        const surface = new THREE.Mesh(
          mesh.geometry,
          new THREE.MeshBasicMaterial({
            color: 0x000000,
            side: mesh.material.side,
            polygonOffset: mesh.material.polygonOffset,
            polygonOffsetFactor: mesh.material.polygonOffsetFactor,
            polygonOffsetUnits: mesh.material.polygonOffsetUnits,
          }),
        );
        surface.matrixAutoUpdate = false;
        surface.matrix.copy(mesh.matrixWorld);
        surface.matrixWorldNeedsUpdate = true;
        return surface;
      });
      const idFragment = `
        varying float vAcross;
        varying float vHalf;
        varying float vAlpha;
        flat varying float vId;
        void main() {
          float aa = max( length( vec2( dFdx( vAcross ), dFdy( vAcross ) ) ), 1e-4 );
          float coverage = clamp( ( vHalf - abs( vAcross ) ) / aa + 0.5, 0.0, 1.0 );
          if ( coverage < 0.5 || vAlpha <= 0.0 ) discard;
          float id = vId + 1.0;
          gl_FragColor = vec4( mod( id, 256.0 ), mod( floor( id / 256.0 ), 256.0 ),
            floor( id / 65536.0 ), 255.0 ) / 255.0;
        }`;
      const render = (scene: any, target: any) => {
        gl.setRenderTarget(target);
        gl.clear();
        gl.render(scene, camera);
      };
      const ids: Record<string, Uint8Array> = {};
      const target = new THREE.WebGLRenderTarget(width, height);
      const clearColor = gl.getClearColor(new THREE.Color()),
        clearAlpha = gl.getClearAlpha();
      gl.setClearColor(0x000000, 1);
      for (const pass of passes) {
        const production = lines[pass as 'core' | 'casing'].material;
        const material = new THREE.ShaderMaterial({
          vertexShader: production.vertexShader,
          fragmentShader: idFragment,
          uniforms: production.uniforms,
          defines: { ...production.defines, GRID_ID: '' },
          side: production.side,
          depthWrite: false,
          transparent: true,
          blending: THREE.NoBlending,
        });
        const line = new THREE.Mesh(lines.core.geometry, material);
        // Every segment, though the viewport leaves out those too small on screen to show.
        line.onBeforeRender = () => (lines.core.geometry.instanceCount = count);
        line.frustumCulled = false;
        line.renderOrder = 1;
        line.matrixAutoUpdate = false;
        line.matrix.copy(toWorld);
        line.matrixWorldNeedsUpdate = true;
        const scene = new THREE.Scene();
        scene.add(...surfaces, line);
        render(scene, target);
        ids[pass] = new Uint8Array(width * height * 4);
        gl.readRenderTargetPixels(target, 0, 0, width, height, ids[pass]);
        material.dispose();
      }
      // Every part's view depth, to find outlines and where one surface covers another.
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
        side: THREE.DoubleSide,
      });
      const depthScene = new THREE.Scene();
      for (const surface of surfaces) {
        const copy = surface.clone();
        copy.material = depthMaterial;
        depthScene.add(copy);
      }
      gl.setClearColor(0x000000, 0);
      render(depthScene, depthTarget);
      const depths = new Float32Array(width * height * 4);
      gl.readRenderTargetPixels(depthTarget, 0, 0, width, height, depths);
      gl.setRenderTarget(null);
      gl.setClearColor(clearColor, clearAlpha);
      depthMaterial.dispose();
      depthTarget.dispose();
      target.dispose();
      for (const surface of surfaces) surface.material.dispose();

      // The viewport's own image, with the grid shown and hidden.
      const context = gl.getContext() as WebGL2RenderingContext;
      const readCanvas = () => {
        gl.setRenderTarget(null);
        gl.render(viewport, camera);
        const pixels = new Uint8Array(width * height * 4);
        context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);
        return pixels;
      };
      const shown = readCanvas();
      space.visible = false;
      const bare = readCanvas();
      space.visible = true;
      root.invalidate();

      // Outlines and jumps in depth: a step between neighbours much larger than the steps
      // beside it, so a steady slope is not one.
      const depthAt = (x: number, y: number) =>
        x < 0 || y < 0 || x >= width || y >= height ? 0 : depths[(y * width + x) * 4];
      const edge = new Uint8Array(width * height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const d = depthAt(x, y);
          for (const [dx, dy] of [
            [1, 0],
            [0, 1],
          ]) {
            const n = depthAt(x + dx, y + dy);
            if (!d !== !n) {
              edge[y * width + x] = 1;
              continue;
            }
            if (!d) continue;
            const step = Math.abs(n - d);
            const before = Math.abs(d - depthAt(x - dx, y - dy) || 0),
              after = Math.abs(depthAt(x + 2 * dx, y + 2 * dy) - n || 0);
            if (step > 0.3 && step > 3 * Math.max(before, after)) edge[y * width + x] = 1;
          }
        }
      const band = Math.ceil(3 * ratio);
      const nearEdge = (x: number, y: number) => {
        for (let dy = -band; dy <= band; dy++)
          for (let dx = -band; dx <= band; dx++) {
            const px = x + dx,
              py = y + dy;
            if (px >= 0 && py >= 0 && px < width && py < height && edge[py * width + px])
              return true;
          }
        return false;
      };

      // Projected nodes, bucketed by pixel, to leave out samples where edges meet.
      const near = 4 * ratio;
      const bucket = new Map<number, number[][]>();
      const nodePositions = useEditor.getState().warp.state.positions;
      const p = new THREE.Vector3();
      for (let i = 0; i < nodePositions.length; i += 3) {
        p.fromArray(nodePositions, i).project(camera);
        const node = [((p.x + 1) / 2) * width, ((p.y + 1) / 2) * height];
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
      const centre = new THREE.Vector3(0, radius, 0);
      const plateNormal = new THREE.Vector3(0, 0, 1)
        .applyMatrix3(new THREE.Matrix3().getNormalMatrix(toWorld))
        .normalize();
      const classify = (local: any, world: any, view: any) => {
        if (shape === 'covered') return 'covered';
        if (shape === 'ball') return world.clone().sub(centre).dot(view) > 0 ? 'front' : 'back';
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
        return `${outward ? 'outer' : 'inner'} ${normal.dot(view) > 0 ? 'facing' : 'away'}`;
      };
      // Whether the ID passes draw any segment within two pixels.
      const spread = Math.ceil(2 * ratio);
      const drawnNear = (x: number, y: number) => {
        for (const pass of passes)
          for (let dy = -spread; dy <= spread; dy++)
            for (let dx = -spread; dx <= spread; dx++) {
              const px = x + dx,
                py = y + dy;
              if (px < 0 || py < 0 || px >= width || py >= height) continue;
              const o = (py * width + px) * 4;
              if (ids[pass][o] || ids[pass][o + 1] || ids[pass][o + 2]) return true;
            }
        return false;
      };
      type Tally = Record<
        string,
        { samples: number; shown: number; drawn: number; touched: number; stray: number }
      >;
      const tally: Record<string, Tally> = {};
      for (const pass of passes) tally[pass] = {};
      const a = new THREE.Vector3(),
        b = new THREE.Vector3(),
        local = new THREE.Vector3(),
        world = new THREE.Vector3(),
        screen = new THREE.Vector3();
      for (let i = 0; i < count; i++) {
        a.fromArray(drawn, i * 6);
        b.fromArray(drawn, i * 6 + 3);
        const length = a.clone().applyMatrix4(toWorld).distanceTo(b.clone().applyMatrix4(toWorld));
        const steps = Math.max(1, Math.ceil(length / 0.05));
        for (let s = 0; s < steps; s++) {
          local.lerpVectors(a, b, (s + 0.5) / steps);
          world.copy(local).applyMatrix4(toWorld);
          const view = camera.isOrthographicCamera
            ? forward.clone().negate()
            : eye.clone().sub(world).normalize();
          const name = classify(local, world, view);
          if (!name) continue;
          screen.copy(world).project(camera);
          if (Math.abs(screen.x) > 0.98 || Math.abs(screen.y) > 0.98 || Math.abs(screen.z) > 1)
            continue;
          const x = ((screen.x + 1) / 2) * width,
            y = ((screen.y + 1) / 2) * height;
          if (nearNode(x, y)) continue;
          const px = Math.floor(x),
            py = Math.floor(y);
          const key = nearEdge(px, py) ? `${name} rim` : name;
          const o = (py * width + px) * 4;
          const touched =
            Math.max(
              Math.abs(shown[o] - bare[o]),
              Math.abs(shown[o + 1] - bare[o + 1]),
              Math.abs(shown[o + 2] - bare[o + 2]),
            ) > 12;
          const stray = touched && !drawnNear(px, py);
          for (const pass of passes) {
            const pixels = ids[pass];
            const id = pixels[o] + pixels[o + 1] * 256 + pixels[o + 2] * 65536 - 1;
            const entry = (tally[pass][key] ??= {
              samples: 0,
              shown: 0,
              drawn: 0,
              touched: 0,
              stray: 0,
            });
            entry.samples++;
            if (id >= 0 && id < count) entry.drawn++;
            if (id >= 0 && id < count && edgeOf[id] === edgeOf[i]) entry.shown++;
            if (touched) entry.touched++;
            if (stray) entry.stray++;
          }
        }
      }
      const shares: Record<
        string,
        Record<string, { shown: number; drawn: number; touched: number; stray: number }>
      > = {};
      for (const pass of passes) {
        shares[pass] = {};
        for (const [name, { samples, shown, drawn, touched, stray }] of Object.entries(tally[pass]))
          shares[pass][name] = {
            shown: shown / samples,
            drawn: drawn / samples,
            touched: touched / samples,
            stray: stray / samples,
          };
      }
      return { segments: count, nonFinite, tally, shares };
    },
    { shape, passes, radius },
  );
}

/** Every visible part's view depth per pixel, 0 where none is drawn: `(THREE, gl, camera, scene)`. */
const viewDepthsSource = `
  return (THREE, gl, camera, viewport) => {
    const buffer = gl.getDrawingBufferSize(new THREE.Vector2());
    const width = buffer.x, height = buffer.y;
    const material = new THREE.ShaderMaterial({
      vertexShader: 'varying float vDepth; void main() { vec4 view = modelViewMatrix * vec4(position, 1.0); vDepth = -view.z; gl_Position = projectionMatrix * view; }',
      fragmentShader: 'varying float vDepth; void main() { gl_FragColor = vec4(vDepth, 0.0, 0.0, 1.0); }',
      side: THREE.DoubleSide,
    });
    const scene = new THREE.Scene();
    viewport.traverseVisible((object) => {
      if (!object.isMesh || !object.name.startsWith('part:')) return;
      const copy = new THREE.Mesh(object.geometry, material);
      copy.matrixAutoUpdate = false;
      copy.matrix.copy(object.matrixWorld);
      copy.matrixWorldNeedsUpdate = true;
      scene.add(copy);
    });
    const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType });
    const clearColor = gl.getClearColor(new THREE.Color()), clearAlpha = gl.getClearAlpha();
    gl.setClearColor(0x000000, 0);
    gl.setRenderTarget(target);
    gl.clear();
    gl.render(scene, camera);
    const depths = new Float32Array(width * height * 4);
    gl.readRenderTargetPixels(target, 0, 0, width, height, depths);
    gl.setRenderTarget(null);
    gl.setClearColor(clearColor, clearAlpha);
    target.dispose();
    material.dispose();
    return depths;
  };
`;

/** Relative luminance of an sRGB pixel. */
const luminanceSource = `
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (p, i) => 0.2126 * channel(p[i]) + 0.7152 * channel(p[i + 1]) + 0.0722 * channel(p[i + 2]);
`;

/**
 * WCAG contrast of the grid against the surface beside it, per part colour. Samples are the
 * middles of segments on surface facing the camera squarely, away from nodes; at each, `core`
 * is the contrast at the line's centre (the pixels whose centres the 1.5 px core covers) and `line` the best
 * across the line's full width, each between the drawn image and the same pixels with the grid
 * hidden. Returns the worst and the fifth-percentile sample for each colour.
 */
export async function gridContrast(page: Page, colors: string[], partId = 'ball') {
  return page.evaluate(
    async ({ colors, luminanceSource, viewDepthsSource, partId }) => {
      const luminance = new Function(luminanceSource)() as (p: Uint8Array, i: number) => number;
      const viewDepths = new Function(viewDepthsSource)();
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
      const space = scene.getObjectByName('warp-grid');
      const part = scene.getObjectByName(`part:${partId}`);
      const drawing = space.userData.drawing;
      const drawn: Float32Array = drawing.drawn();
      const normals: Float32Array = drawing.normals;
      const count: number = drawing.segments;
      const toWorld = scene.getObjectByName('warp-grid:core').matrixWorld;
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(toWorld);
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
      const eye = camera.getWorldPosition(new THREE.Vector3()),
        forward = camera.getWorldDirection(new THREE.Vector3());
      const a = new THREE.Vector3(),
        b = new THREE.Vector3(),
        p = new THREE.Vector3(),
        normal = new THREE.Vector3();
      const depths = viewDepths(THREE, gl, camera, scene);
      const nodes: [number, number][] = [];
      const positions = useEditor.getState().warp.state.positions;
      for (let i = 0; i < positions.length; i += 3) {
        p.fromArray(positions, i).project(camera);
        nodes.push([((p.x + 1) / 2) * width, ((p.y + 1) / 2) * height]);
      }
      // Where edges meet at a node, one line's casing crosses another, so those are left out.
      const apart = 8 * ratio;
      const samples: [number, number, number, number][] = [];
      for (let i = 0; i < count; i++) {
        a.fromArray(drawn, i * 6).applyMatrix4(toWorld);
        b.fromArray(drawn, i * 6 + 3).applyMatrix4(toWorld);
        p.lerpVectors(a, b, 0.5);
        normal
          .fromArray(normals, i * 6)
          .add(new THREE.Vector3().fromArray(normals, i * 6 + 3))
          .applyMatrix3(normalMatrix)
          .normalize();
        const view = camera.isOrthographicCamera
          ? forward.clone().negate()
          : eye.clone().sub(p).normalize();
        if (normal.dot(view) < 0.5) continue;
        const depth = -p.clone().applyMatrix4(camera.matrixWorldInverse).z;
        a.project(camera);
        b.project(camera);
        p.project(camera);
        if (Math.abs(p.x) > 0.95 || Math.abs(p.y) > 0.95 || p.z > 1) continue;
        // Only where nothing nearer covers the line.
        const seen =
          depths[
            (Math.floor(((p.y + 1) / 2) * height) * width + Math.floor(((p.x + 1) / 2) * width)) * 4
          ];
        if (!(Math.abs(seen - depth) < 0.1)) continue;
        const dx = (b.x - a.x) * width,
          dy = (b.y - a.y) * height,
          l = Math.hypot(dx, dy);
        if (!(l > 4 * ratio)) continue;
        const x = ((p.x + 1) / 2) * width,
          y = ((p.y + 1) / 2) * height;
        if (nodes.some(([nx, ny]) => Math.hypot(nx - x, ny - y) < apart)) continue;
        samples.push([x, y, -dy / l, dx / l]);
      }
      const material = part.material;
      const original = material.color.getHex();
      // Across the whole line and a pixel beyond it.
      const reach = Math.ceil(2.75 * ratio);
      const results: {
        color: string;
        core: { worst: number; low: number; median: number };
        line: { worst: number; low: number; median: number };
      }[] = [];
      const summary = (values: number[]) => {
        values.sort((m, n) => m - n);
        return {
          worst: values[0],
          low: values[Math.floor(values.length * 0.05)],
          median: values[values.length >> 1],
        };
      };
      for (const color of colors) {
        material.color.set(color);
        const shown = read();
        space.visible = false;
        const bare = read();
        space.visible = true;
        const core: number[] = [],
          line: number[] = [];
        for (const [x, y, nx, ny] of samples) {
          let centre = 1,
            best = 1;
          for (let k = -reach; k <= reach; k += 0.25) {
            const px = Math.floor(x + k * nx),
              py = Math.floor(y + k * ny);
            const i = (py * width + px) * 4;
            const [l1, l2] = [luminance(shown, i), luminance(bare, i)].sort((m, n) => n - m);
            const contrast = (l1 + 0.05) / (l2 + 0.05);
            best = Math.max(best, contrast);
            // Pixels whose centres lie within the core, 1.5 px wide.
            const offset = (px + 0.5 - x) * nx + (py + 0.5 - y) * ny;
            if (Math.abs(offset) <= 0.75 * ratio) centre = Math.max(centre, contrast);
          }
          core.push(centre);
          line.push(best);
        }
        results.push({ color, core: summary(core), line: summary(line) });
      }
      material.color.setHex(original);
      root.invalidate();
      return { samples: samples.length, results };
    },
    { colors, luminanceSource, viewDepthsSource, partId },
  );
}

/**
 * Over every pixel of the warped part: the share the grid touches at all (any channel differs by
 * more than 12 levels) and the share it changes noticeably (luminance contrast above 1.5:1),
 * between the drawn image and the same view with the grid hidden. `color`, when given, is the
 * part's colour while measuring.
 */
export async function gridCoverage(page: Page, partId = 'ball', color?: string) {
  return page.evaluate(
    async ({ luminanceSource, partId, color }) => {
      const luminance = new Function(luminanceSource)() as (p: Uint8Array, i: number) => number;
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const THREE = await import(urls.find((url) => /\/deps\/three\.js/.test(url))!);
      const root = (
        await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!)
      )._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const { gl, camera, scene, size } = root;
      const space = scene.getObjectByName('warp-grid');
      const part = scene.getObjectByName(`part:${partId}`);
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
      const original = part.material.color.getHex();
      if (color) part.material.color.set(color);
      const shown = read();
      space.visible = false;
      const bare = read();
      part.material.color.setHex(original);
      // The part's pixels: where it is drawn in white over black.
      const mask = new THREE.Mesh(part.geometry, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      mask.matrixAutoUpdate = false;
      mask.matrix.copy(part.matrixWorld);
      mask.matrixWorldNeedsUpdate = true;
      const only = new THREE.Scene();
      only.background = new THREE.Color(0x000000);
      only.add(mask);
      const target = new THREE.WebGLRenderTarget(width, height);
      gl.setRenderTarget(target);
      gl.render(only, camera);
      const silhouette = new Uint8Array(width * height * 4);
      gl.readRenderTargetPixels(target, 0, 0, width, height, silhouette);
      gl.setRenderTarget(null);
      target.dispose();
      mask.material.dispose();
      space.visible = true;
      root.invalidate();
      let pixels = 0,
        touched = 0,
        noticeable = 0;
      for (let i = 0; i < width * height * 4; i += 4) {
        if (silhouette[i] < 128) continue;
        pixels++;
        if (
          Math.max(
            Math.abs(shown[i] - bare[i]),
            Math.abs(shown[i + 1] - bare[i + 1]),
            Math.abs(shown[i + 2] - bare[i + 2]),
          ) > 12
        )
          touched++;
        const [l1, l2] = [luminance(shown, i), luminance(bare, i)].sort((m, n) => n - m);
        if ((l1 + 0.05) / (l2 + 0.05) > 1.5) noticeable++;
      }
      return {
        pixels: pixels / (width / size.width) ** 2,
        touched: touched / pixels,
        noticeable: noticeable / pixels,
      };
    },
    { luminanceSource, partId, color },
  );
}

/**
 * How much of each set of points shows, named by the start of their objects' names. A dot's pixels
 * are where its set draws with everything else hidden, away from its antialiased edges; one shows
 * where the viewport's own image holds the same colour there. Pixels under
 * part `cover`, where it is drawn alone, are tallied apart as `covered`.
 */
export async function dotsShown(page: Page, names: string[], cover?: string) {
  return page.evaluate(
    async ({ names, cover }) => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const THREE = await import(urls.find((url) => /\/deps\/three\.js/.test(url))!);
      const root = (
        await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!)
      )._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const { gl, camera, scene } = root;
      const context = gl.getContext() as WebGL2RenderingContext;
      const buffer = gl.getDrawingBufferSize(new THREE.Vector2());
      const width = buffer.x,
        height = buffer.y;
      const read = () => {
        gl.setRenderTarget(null);
        gl.render(scene, camera);
        const pixels = new Uint8Array(width * height * 4);
        context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);
        return pixels;
      };
      const shown = read();
      // Everything drawn but the given objects hidden, over a colour nothing else has.
      const alone = (keep: (object: any) => boolean) => {
        const hidden: any[] = [];
        scene.traverse((object: any) => {
          if (
            (object.isMesh || object.isLine || object.isPoints) &&
            object.visible &&
            !keep(object)
          ) {
            hidden.push(object);
            object.visible = false;
          }
        });
        const background = scene.background;
        scene.background = new THREE.Color(1, 0, 1);
        const pixels = read();
        scene.background = background;
        for (const object of hidden) object.visible = true;
        return pixels;
      };
      const magenta = (p: Uint8Array, i: number) => p[i] > 250 && p[i + 1] < 5 && p[i + 2] > 250;
      // What shows itself however it is hidden, such as a gizmo, is left out.
      const always = alone(() => false);
      const covering = cover ? alone((object) => object.name === `part:${cover}`) : null;
      const result: Record<string, Record<string, { pixels: number; shown: number }>> = {};
      for (const name of names) {
        let found = false;
        scene.traverse((object: any) => {
          if (object.isPoints && object.visible && object.name.startsWith(name)) found = true;
        });
        if (!found) continue;
        const dots = alone((object) => object.isPoints && object.name.startsWith(name));
        const tally = { clear: { pixels: 0, shown: 0 }, covered: { pixels: 0, shown: 0 } };
        // Inside a dot: neither the pixel nor any beside it is background.
        const inside = (i: number) => {
          const x = (i / 4) % width,
            y = Math.floor(i / 4 / width);
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const px = x + dx,
                py = y + dy;
              if (px < 0 || py < 0 || px >= width || py >= height) return false;
              if (magenta(dots, (py * width + px) * 4)) return false;
            }
          return true;
        };
        for (let i = 0; i < dots.length; i += 4) {
          if (!inside(i) || !magenta(always, i)) continue;
          const entry = covering && !magenta(covering, i) ? tally.covered : tally.clear;
          entry.pixels++;
          if (
            Math.max(
              Math.abs(dots[i] - shown[i]),
              Math.abs(dots[i + 1] - shown[i + 1]),
              Math.abs(dots[i + 2] - shown[i + 2]),
            ) <= 12
          )
            entry.shown++;
        }
        result[name] = tally;
      }
      root.invalidate();
      return result;
    },
    { names, cover },
  );
}
