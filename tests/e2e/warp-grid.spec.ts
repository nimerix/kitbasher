import { expect, test, type Page } from '@playwright/test';
import {
  BoxGeometry,
  LatheGeometry,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { distinctColor } from '../../src/core/appearance';
import type { Vec3 } from '../../src/core/types';
import { scanLike } from '../helpers/scan-like';
import {
  dotsShown,
  failOnBrowserErrors,
  fixturePart,
  gridContrast,
  gridCoverage,
  gridTraced,
  gridVisibility,
  layGrid,
  lookFrom,
  note,
  partAcross,
  radius,
  setDensity,
  setLighting,
  setProjection,
  type Placement,
} from './helpers/warp-grid';

failOnBrowserErrors();

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

const distinct = [...Array.from({ length: 24 }, (_, i) => distinctColor(i)), '#ffffff'];
const nearBlack = '#1c1c1c';

/**
 * Lines carry full ink only where cells are large on screen: 40 px or more. Contrast is measured
 * there, on surface facing the camera this squarely, so its cells keep nearly their full size.
 */
const squarely = 0.9;

/** Where cells are large on screen, the grid's dark core stands out at its centre on every colour. */
async function expectCoreContrast(page: Page, label: string) {
  const { cell } = await partAcross(page);
  expect(cell * squarely, `${label}: cells on screen`).toBeGreaterThan(40);
  const { samples, results } = await gridContrast(page, distinct, 'ball', squarely);
  note(`${label} core`, results);
  expect(samples, label).toBeGreaterThan(100);
  for (const { color, core } of results)
    expect(core.low, `${label} ${color}: fifth percentile at the core`).toBeGreaterThan(3);
}

/** Where cells are large on screen, on a near-black part, the light casing makes the line stand out. */
async function expectCasingContrast(page: Page, label: string) {
  const { results } = await gridContrast(page, [nearBlack], 'ball', squarely);
  note(`${label} casing`, results);
  expect(results[0].line.low, `${label}: fifth percentile across the line`).toBeGreaterThan(3);
}

/**
 * The visibility floor: on every Distinct colour, white and a near-black part, the grid changes
 * the luminance of at least this share of the part's pixels by more than 1.2:1.
 */
const visible = 0.08;

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
      const label = `density ${level}, ${view}`;
      expect(grid.nonFinite).toBe(0);
      expect(grid.tally.core.front.samples).toBeGreaterThan(2000);
      expect(grid.shares.core.front.shown, label).toBeGreaterThan(0.9);
      // The finest grid fades where the surface turns away; coarser ones are drawn in full.
      if (level < 6) expect(grid.shares.core.front.touched, label).toBeGreaterThan(0.9);
      for (const pass of ['core', 'casing'] as const) {
        expect(grid.shares[pass].back.shown, `${label} ${pass}`).toBeLessThan(0.002);
        expect(grid.shares[pass].back.stray, `${label} ${pass}`).toBeLessThan(0.002);
      }
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
      const label = `density ${level}, ${view}`;
      note(label, grid);
      const facing = view.startsWith('outside') ? 'outer facing' : 'inner facing';
      const hidden = view.startsWith('outside') ? 'inner away' : 'outer away';
      expect(grid.tally.core[facing].samples).toBeGreaterThan(1000);
      if (whole) expect(grid.shares.core[facing].shown, label).toBeGreaterThan(0.9);
      expect(grid.tally.core[hidden].samples).toBeGreaterThan(1000);
      for (const pass of ['core', 'casing'] as const) {
        expect(grid.shares[pass][hidden].shown, `${label} ${pass}`).toBeLessThan(0.002);
        expect(grid.shares[pass][hidden].stray, `${label} ${pass}`).toBeLessThan(0.002);
      }
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
      const label = `density ${level}, from ${direction}`;
      note(label, grid);
      expect(grid.tally.core.covered.samples).toBeGreaterThan(200);
      for (const pass of ['core', 'casing'] as const) {
        expect(grid.shares[pass].covered.shown, `${label} ${pass}`).toBeLessThan(0.002);
        expect(grid.shares[pass].covered.stray, `${label} ${pass}`).toBeLessThan(0.002);
      }
      expect(grid.shares.core.plate.shown, label).toBeGreaterThan(0.9);
    }
  }
});

/** Moves a part in place, outside history, as if dragged there. */
async function placePart(page: Page, id: string, position: Vec3) {
  await page.evaluate(
    async ({ id, position }) => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const { useEditor } = await import(
        urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
      );
      useEditor.setState((state: any) => ({
        scene: {
          ...state.scene,
          parts: state.scene.parts.map((part: any) =>
            part.id === id ? { ...part, position } : part,
          ),
        },
      }));
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    },
    { id, position },
  );
}

test('an opaque plate just in front hides the grid at any tilt, in either projection', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const centre: Vec3 = [0, radius, 0];
  const results: Record<string, unknown> = {};
  for (const tilt of [55, 80]) {
    // Turned away from the camera about x, so the plates slope steeply across each line.
    const turn = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (-tilt * Math.PI) / 180);
    const quaternion = turn.toArray() as Placement['quaternion'];
    const cover = fixturePart('cover', new PlaneGeometry(60, 60, 4, 4), {
      position: [centre[0], centre[1], centre[2] - 5],
      quaternion,
      color: '#9a8f86',
    });
    await layGrid(page, new PlaneGeometry(24, 24, 48, 48), { position: centre, quaternion }, [
      cover,
    ]);
    for (const projection of ['perspective', 'orthographic'] as const) {
      await setProjection(page, projection);
      for (const [where, target] of [
        ['centred', centre],
        ['off axis', [centre[0] + 12, centre[1] + 7, centre[2]]],
      ] as const) {
        await lookFrom(page, [0, 0, 1], 70, 14, [...target]);
        // Just behind the grid it hides nothing. Steeply turned, the core fades out while the
        // casing still draws, and lines crowd so a pixel may hold a neighbouring edge.
        await placePart(page, 'cover', [centre[0], centre[1], centre[2] - 0.2]);
        const open = await gridVisibility(page, 'covered');
        const label = `${tilt}°, ${projection}, ${where}`;
        expect(open.tally.core.covered.samples, label).toBeGreaterThan(1000);
        expect(
          Math.max(open.shares.core.covered.drawn, open.shares.casing.covered.drawn),
          `${label}, cover behind`,
        ).toBeGreaterThan(0.9);
        for (const gap of [0.2, 0.8]) {
          // Nearer than the grid along the camera's axis.
          await placePart(page, 'cover', [centre[0], centre[1], centre[2] + gap]);
          const grid = await gridVisibility(page, 'covered');
          results[`${label}, ${gap} mm`] = grid.shares;
          for (const pass of ['core', 'casing'] as const)
            for (const name of Object.keys(grid.tally[pass])) {
              expect(grid.shares[pass][name].drawn, `${label}, ${gap} mm, ${pass} ${name}`).toBe(0);
              expect(grid.shares[pass][name].stray, `${label}, ${gap} mm, ${pass} ${name}`).toBe(0);
            }
        }
      }
    }
    await setProjection(page, 'perspective');
  }
  note('covered', results);
});

// At overview distance, about 400 mm, a perspective camera's 0.1 mm near plane leaves depth too
// coarse to separate surfaces 0.2 mm apart: the editor's own limit, so it is not tested there.

test('a line just beyond the near plane is not pulled in front of it', async ({ page }) => {
  // A plate facing the camera, its surface 0.103 mm in front of the orthographic camera, whose
  // near plane is 0.1 mm away: half the usual pull would put the line nearer than that.
  await layGrid(page, new PlaneGeometry(24, 24, 24, 24));
  await setProjection(page, 'orthographic');
  await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const root = (await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!))._roots
      .get(document.querySelector('canvas'))
      .store.getState();
    const { camera, controls } = root;
    controls.enabled = false;
    camera.position.set(0, 15, 0.103);
    camera.lookAt(0, 15, 0);
    camera.zoom = 30;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    root.invalidate();
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  const grid = await gridVisibility(page, 'plate');
  note('near plane', grid.shares);
  expect(grid.tally.core.front.samples).toBeGreaterThan(1000);
  expect(grid.shares.core.front.shown).toBeGreaterThan(0.9);
});

test('a mirrored part and a turned, unevenly scaled plate draw their grids whole', async ({
  page,
}) => {
  await layGrid(page, ball(), { scale: [-1, 1, 1] });
  await lookFrom(page, [0, 0.2, 1]);
  const mirrored = await gridVisibility(page, 'ball');
  note('mirrored ball', mirrored);
  expect(mirrored.nonFinite).toBe(0);
  expect(mirrored.shares.core.front.shown).toBeGreaterThan(0.9);
  expect(mirrored.shares.core.back.shown).toBeLessThan(0.002);
  expect(mirrored.shares.casing.back.shown).toBeLessThan(0.002);

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
    const facing = plate.tally.core.front ? 'front' : 'back';
    note(`plate, density ${level}`, plate);
    expect(plate.nonFinite).toBe(0);
    expect(plate.tally.core[facing].samples).toBeGreaterThan(1000);
    expect(plate.shares.core[facing].shown).toBeGreaterThan(0.9);
  }
});

/**
 * The furthest any drawn segment lies from the written surface, sampled along each one, once the
 * grid's buffers hold the surface as last written. Also what was sampled: segments, and samples
 * on edges drawn along mesh edges after their walks failed, whose points lie on mesh vertices.
 */
function gapFromSurface(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const THREE = await import(urls.find((url) => /\/deps\/three\.js/.test(url))!);
    const { MeshBVH } = await import(urls.find((url) => /\/deps\/three-mesh-bvh\.js/.test(url))!);
    const root = (await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!))._roots
      .get(document.querySelector('canvas'))
      .store.getState();
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const { preview, settling } = useEditor.getState().warp;
    const version = preview.getAttribute('position').version;
    const drawing = root.scene.getObjectByName('warp-grid').userData.drawing;
    for (let frame = 0; frame < 120 && drawing.written !== version; frame++) {
      root.invalidate();
      await new Promise((done) => requestAnimationFrame(done));
    }
    const drawn: Float32Array = drawing.drawn();
    const surface = new THREE.BufferGeometry();
    surface.setAttribute('position', preview.getAttribute('position').clone());
    if (preview.index) surface.setIndex(preview.index.clone());
    const bvh = new MeshBVH(surface);
    const { path } = drawing;
    const rerouted = (e: number) =>
      path.start[e + 1] > path.start[e] &&
      path.from
        .subarray(path.start[e], path.start[e + 1])
        .every((from: number, i: number) => from === path.to[path.start[e] + i]);
    const point = new THREE.Vector3();
    let worst = 0,
      reroutedSamples = 0;
    for (let s = 0; s < drawing.segments; s++)
      for (const f of [0.25, 0.5, 0.75]) {
        point.fromArray(drawn, s * 6).lerp(new THREE.Vector3().fromArray(drawn, s * 6 + 3), f);
        worst = Math.max(worst, bvh.closestPointToPoint(point).distance);
        if (rerouted(drawing.edgeOf[s])) reroutedSamples++;
      }
    return {
      worst,
      failed: path.failed,
      rerouted: path.rerouted,
      edges: path.ends.length / 2,
      segments: drawing.segments,
      reroutedSamples,
      // The surface measured, the one the drawn line was last checked against, and how many
      // times points chosen again were drawn.
      version: drawing.written === version ? version : -1,
      refined: drawing.refined,
      adopted: drawing.adopted,
      settling,
    };
  });
}

/**
 * Pixels of the view that change when the segments of edges drawn along mesh edges, after their
 * walks failed, are moved out of sight in both of the grid's passes, and how many segments those
 * are. The view is then drawn as it was.
 */
function reroutedPixels(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const root = (await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!))._roots
      .get(document.querySelector('canvas'))
      .store.getState();
    const { gl, camera, scene } = root;
    const drawing = scene.getObjectByName('warp-grid').userData.drawing;
    const { path } = drawing;
    const rerouted = (e: number) =>
      path.start[e + 1] > path.start[e] &&
      path.from
        .subarray(path.start[e], path.start[e + 1])
        .every((from: number, i: number) => from === path.to[path.start[e] + i]);
    const base = scene
      .getObjectByName('warp-grid:core')
      .geometry.getAttribute('instanceStart').data;
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
    const differ = (a: Uint8Array, b: Uint8Array) => {
      let count = 0;
      for (let i = 0; i < a.length; i += 4)
        if (
          Math.max(
            Math.abs(a[i] - b[i]),
            Math.abs(a[i + 1] - b[i + 1]),
            Math.abs(a[i + 2] - b[i + 2]),
          ) > 12
        )
          count++;
      return count;
    };
    const shown = read();
    const saved = base.array.slice();
    let segments = 0;
    for (let s = 0; s < drawing.segments; s++)
      if (rerouted(drawing.edgeOf[s])) {
        segments++;
        base.array.fill(1e7, s * 6, s * 6 + 6);
      }
    base.needsUpdate = true;
    const without = read();
    base.array.set(saved);
    base.needsUpdate = true;
    const again = read();
    root.invalidate();
    return { segments, changed: differ(shown, without), restored: differ(shown, again) };
  });
}

/**
 * On a plate laid flat, holds points at its corners and pulls one near its middle 2 mm up, and
 * returns how many points it holds and how far the surface under the pulled one rose.
 */
function pullPlate(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const THREE = await import(urls.find((url) => /\/deps\/three\.js/.test(url))!);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const editor = () => useEditor.getState();
    const part = editor().scene.parts[0];
    const position = part.geometry.getAttribute('position');
    const index = part.geometry.index;
    const faceAt = (x: number, y: number) => {
      const triangle = new THREE.Triangle(),
        closest = new THREE.Vector3(),
        point = new THREE.Vector3(x, y, 0);
      for (let f = 0; f < index.count / 3; f++) {
        triangle.setFromAttributeAndIndices(
          position,
          index.getX(f * 3),
          index.getX(f * 3 + 1),
          index.getX(f * 3 + 2),
        );
        if (triangle.closestPointToPoint(point, closest).distanceTo(point) < 1e-6) return f;
      }
      return -1;
    };
    // Only these points, placed in the part's own space, where the plate lies at z = 0.
    editor().removeWarpPoints(editor().warp.points.map((point: { id: string }) => point.id));
    for (const [x, y] of [
      [-15, -15],
      [15, -15],
      [-15, 15],
      [15, 15],
      [0.3, 0.2],
    ])
      editor().addWarpPoint({ partId: 'ball', point: [x, y, 0], normal: [0, 0, 1] }, faceAt(x, y));
    const { points } = editor().warp;
    // Targets are in the world, where the plate's local z is up.
    editor().moveWarpPoints([{ id: points.at(-1).id, target: [0.3, 17, -0.2] }], 'end');
    const written = editor().warp.output.positions;
    let rise = -Infinity;
    for (let v = 0; v < written.length; v += 3)
      if (Math.hypot(written[v] - 0.3, written[v + 1] - 0.2) < 0.5)
        rise = Math.max(rise, written[v + 2]);
    return { points: points.length, rise };
  });
}

const flat: Placement = { quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] };

test('the grid stays on a flat plate once it bends, and in view', async ({ page }) => {
  await layGrid(page, new PlaneGeometry(40, 40, 16, 16), flat);
  const pulled = await pullPlate(page);
  note('pulled', pulled);
  expect(pulled.points).toBe(5);
  expect(pulled.rise).toBeGreaterThan(1.8);
  await gridTraced(page);
  const gap = await gapFromSurface(page);
  note('gap', gap);
  expect(gap.failed).toBe(0);
  expect(gap.worst).toBeLessThan(0.02);
  await lookFrom(page, [0.1, 1, 0.5], 80);
  const grid = await gridVisibility(page, 'plate');
  note('visibility', grid);
  const facing = grid.tally.core.front ? 'front' : 'back';
  expect(grid.tally.core[facing].samples).toBeGreaterThan(1000);
  expect(grid.shares.core[facing].shown).toBeGreaterThan(0.9);
});

test('a coarse grid on a finely meshed plate follows it at once as it bends, and stays put', async ({
  page,
}) => {
  test.setTimeout(120_000);
  for (const density of [0, 1]) {
    // Each coarse grid edge crosses dozens of mesh edges, chosen on the flat plate.
    await layGrid(page, new PlaneGeometry(40, 40, 80, 80), flat, [], density);
    const before = await gapFromSurface(page);
    const pulled = await pullPlate(page);
    note(`density ${density}, pulled`, pulled);
    expect(pulled.points).toBe(5);
    expect(pulled.rise).toBeGreaterThan(1.8);
    // On the first surface written, as the drawn points were chosen on the flat plate.
    const first = await gapFromSurface(page);
    note(`density ${density}, first`, first);
    expect(first.version).toBeGreaterThan(before.version);
    expect(first.adopted).toBe(before.adopted);
    expect(first.worst).toBeLessThan(0.1);
    // Once the solve has settled and the drawn line was checked against the surface it ends on.
    await gridTraced(page);
    const settled = await gapFromSurface(page);
    note(`density ${density}, settled`, settled);
    expect(settled.settling).toBe(false);
    expect(settled.refined).toBe(settled.version);
    expect(settled.failed).toBe(0);
    expect(settled.worst).toBeLessThan(0.1);
    // Its points were never chosen again, so no line moved once the pull was released.
    expect(settled.adopted).toBe(before.adopted);
  }
});

/** A plate turned 55° away from the camera about x, and a part of its own shape and turn. */
const slope = () => {
  const turn = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (-55 * Math.PI) / 180);
  const normal = new Vector3(0, 0, 1).applyQuaternion(turn);
  return { quaternion: turn.toArray() as Placement['quaternion'], normal };
};

test('reach dots show whole on a slope over the grid, and a part 0.2 mm in front hides them', async ({
  page,
}) => {
  const { quaternion, normal } = slope();
  const centre: Vec3 = [0, radius, 0];
  const cover = fixturePart('cover', new PlaneGeometry(60, 60, 4, 4), {
    position: [0, radius, -20],
    quaternion,
    // A colour no dot has.
    color: '#2040ff',
  });
  await layGrid(page, new PlaneGeometry(40, 40, 60, 60), { position: centre, quaternion }, [cover]);
  // A handle with a radius, pulled off the surface and still selected.
  await page.evaluate(async (normal) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const editor = () => useEditor.getState();
    editor().setWarpPointSettings({ radius: 8 }, 'end');
    const part = editor().scene.parts[0];
    const position = part.geometry.getAttribute('position');
    const index = part.geometry.index;
    // A face at the plate's middle.
    let face = -1;
    for (let f = 0; f < index.count / 3 && face < 0; f++) {
      const v = index.getX(f * 3);
      if (Math.hypot(position.getX(v), position.getY(v)) < 0.5) face = f;
    }
    const v = index.getX(face * 3);
    editor().addWarpPoint(
      { partId: 'ball', point: [position.getX(v), position.getY(v), 0], normal: [0, 0, 1] },
      face,
    );
    const point = editor().warp.points.at(-1);
    const target = point.pin.map((value: number, axis: number) => value + 1.5 * normal[axis]);
    editor().moveWarpPoints([{ id: point.id, target }], 'end');
  }, normal.toArray());
  await gridTraced(page);
  await lookFrom(page, [0, 0, 1]);
  const open = await dotsShown(page, ['warp-reach:dot', 'warp-reach']);
  note('open', open);
  for (const name of ['warp-reach:dot', 'warp-reach']) {
    expect(open[name].clear.pixels, name).toBeGreaterThan(250);
    expect(open[name].clear.shown / open[name].clear.pixels, name).toBeGreaterThan(0.9);
  }
  // The written surface's left half, 0.2 mm nearer along the camera's axis: dots under it are
  // hidden, and those beside it, or partly under it, show where it does not cover them.
  await page.evaluate(async (radius) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const THREE = await import(urls.find((url) => /\/deps\/three\.js/.test(url))!);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const { preview } = useEditor.getState().warp;
    const position = preview.getAttribute('position'),
      index = preview.index;
    const half: number[] = [];
    for (let f = 0; f < index.count / 3; f++) {
      const corners = [0, 1, 2].map((k) => index.getX(f * 3 + k));
      if (corners.every((v) => position.getX(v) <= 0))
        for (const v of corners) half.push(position.getX(v), position.getY(v), position.getZ(v));
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(half, 3));
    geometry.computeVertexNormals();
    useEditor.setState((state: any) => ({
      scene: {
        ...state.scene,
        parts: state.scene.parts.map((part: any) =>
          part.id === 'cover' ? { ...part, geometry, position: [0, radius, 0.2] } : part,
        ),
      },
    }));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  }, radius);
  const covered = await dotsShown(page, ['warp-reach'], 'cover');
  note('covered', covered);
  const { clear, covered: under } = covered['warp-reach'];
  expect(under.pixels).toBeGreaterThan(500);
  expect(under.shown / under.pixels).toBeLessThan(0.002);
  expect(clear.pixels).toBeGreaterThan(500);
  expect(clear.shown / clear.pixels).toBeGreaterThan(0.99);
});

test('seam points beside a neighbouring part show whole on a slope, and the part hides its own', async ({
  page,
}) => {
  const { quaternion, normal } = slope();
  const centre = new Vector3(0, radius, 0);
  // A rod 4 mm wide lying 1 mm off the plate, across its middle.
  const rod = fixturePart('rod', new BoxGeometry(40, 4, 1), {
    position: centre.clone().addScaledVector(normal, 1.5).toArray() as Vec3,
    quaternion,
    color: '#2040ff',
  });
  await layGrid(
    page,
    new PlaneGeometry(40, 40, 60, 60),
    { position: centre.toArray() as Vec3, quaternion },
    [rod],
  );
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
        const { useEditor } = await import(
          urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
        );
        return useEditor.getState().warp.seam?.vertices.length ?? 0;
      }),
    )
    .toBeGreaterThan(50);
  await lookFrom(page, [0, 0, 1]);
  const seam = await dotsShown(page, ['warp-seam'], 'rod');
  note('seam', seam);
  const { clear, covered } = seam['warp-seam'];
  expect(clear.pixels).toBeGreaterThan(200);
  expect(clear.shown / clear.pixels).toBeGreaterThan(0.9);
  expect(covered.pixels).toBeGreaterThan(50);
  expect(covered.shown / covered.pixels).toBeLessThan(0.02);
});

test('on a scan-like part, failed walks are drawn along the surface, never across a gap', async ({
  page,
}) => {
  await layGrid(page, scanLike(), { position: [0, 16, 0] });
  for (const level of [0, 3]) {
    await setDensity(page, level);
    const gap = await gapFromSurface(page);
    const cover = await gridCoverage(page);
    note(`density ${level}`, { gap, cover });
    expect(gap.failed).toBeGreaterThan(0);
    expect(gap.rerouted).toBe(gap.failed);
    // What is measured is drawn and shows: segments between points, some along rerouted edges.
    expect(gap.segments).toBeGreaterThan(gap.edges);
    expect(gap.reroutedSamples).toBeGreaterThan(50);
    expect(cover.touched).toBeGreaterThan(0.05);
    expect(gap.worst).toBeLessThan(0.05);
    // The rerouted segments themselves show: the view changes without them.
    const alone = await reroutedPixels(page);
    note(`density ${level}, rerouted`, alone);
    expect(alone.segments).toBeGreaterThan(0);
    expect(alone.restored).toBe(0);
    expect(alone.changed).toBeGreaterThan(50);
  }
});

test('at the whole-part default the grid leaves most of the part as it is, and no more at any density', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await layGrid(page, ball());
  const light = ['#d4a272', ...distinct];
  // About 500 px across, as a whole scanned part fills the view, and 300 px, as with a model.
  for (const [across, distance] of [
    [500, 80],
    [300, 125],
  ] as const) {
    await lookFrom(page, [0, 0.2, 1], distance);
    const { across: width } = await partAcross(page);
    expect(width).toBeGreaterThan(across * 0.93);
    expect(width).toBeLessThan(across * 1.1);
    for (const level of [5, 3, 6]) {
      // The whole-part default is held to every colour; the others to the part's own and white.
      if (level !== 5 && across === 500) continue;
      await setDensity(page, level);
      for (const [view, direction] of [
        ['front', [0, 0.2, 1]],
        ['side', [1, 0.5, 0.4]],
      ] as const) {
        await lookFrom(page, [...direction], distance);
        const label = `density ${level}, ${across} px, ${view}`;
        const noticeable: Record<string, number> = {};
        for (const color of level === 5 ? light : ['#d4a272', '#ffffff'])
          noticeable[color] = (await gridCoverage(page, 'ball', color)).noticeable;
        noticeable[nearBlack] = (await gridCoverage(page, 'ball', nearBlack)).noticeable;
        note(label, noticeable);
        for (const [color, share] of Object.entries(noticeable))
          expect(share, `${label} ${color}`).toBeLessThan(color === nearBlack ? 0.2 : 0.16);
      }
    }
  }
});

test('the grid stays visible on every Distinct colour, white and a near-black part', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await layGrid(page, ball());
  for (const level of [3, 5, 6]) {
    await setDensity(page, level);
    for (const distance of [80, 125, 200]) {
      await lookFrom(page, [0, 0.2, 1], distance);
      const label = `density ${level}, ${distance} mm`;
      const perceptible: Record<string, number> = {};
      for (const color of [...distinct, nearBlack])
        perceptible[color] = (await gridCoverage(page, 'ball', color)).perceptible;
      note(label, perceptible);
      for (const [color, share] of Object.entries(perceptible))
        expect(share, `${label} ${color}`).toBeGreaterThan(visible);
    }
  }
});

test('the plate at the coarsest density draws its outline and a few lines inside, not a fan', async ({
  page,
}) => {
  await layGrid(page, new PlaneGeometry(40, 40, 80, 80), flat, [], 0);
  const pulled = await pullPlate(page);
  expect(pulled.rise).toBeGreaterThan(1.8);
  await gridTraced(page);
  const lines = await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const root = (await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!))._roots
      .get(document.querySelector('canvas'))
      .store.getState();
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const { model } = useEditor.getState().warp;
    const { path } = root.scene.getObjectByName('warp-grid').userData.drawing;
    const p = model.restNodes;
    // In the world the plate lies flat at y = 15, its border 20 mm out along x and z.
    const border = (n: number) =>
      Math.abs(Math.abs(p[n * 3]) - 20) < 1e-4 || Math.abs(Math.abs(p[n * 3 + 2]) - 20) < 1e-4;
    const count = (ends: ArrayLike<number>) => {
      const lines = new Map<number, number>();
      for (let e = 0; e < ends.length; e += 2) {
        const [a, b] = [ends[e], ends[e + 1]];
        if (border(a) === border(b)) continue;
        const inside = border(a) ? b : a;
        lines.set(inside, (lines.get(inside) ?? 0) + 1);
      }
      return Math.max(0, ...lines.values());
    };
    const { edgeStart, edges } = model.grid;
    const grid: number[] = [];
    for (let n = 0; n + 1 < edgeStart.length; n++)
      for (let k = edgeStart[n]; k < edgeStart[n + 1]; k++) grid.push(n, edges[k]);
    return { grid: count(grid) / 2, drawn: count(path.ends) };
  });
  note('lines to the border', lines);
  // The grid itself fans out from a node inside to dozens of border nodes; the drawing does not.
  expect(lines.grid).toBeGreaterThan(50);
  expect(lines.drawn).toBeGreaterThan(0);
  expect(lines.drawn).toBeLessThanOrEqual(4);
  await lookFrom(page, [0.1, 1, 0.5], 80);
  const cover = await gridCoverage(page, 'ball');
  note('cover', cover);
  expect(cover.noticeable).toBeLessThan(0.05);
});

test('at the highest density a coarser net of the grid stays readable as you zoom out', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await layGrid(page, ball());
  const purple = distinct.find((color) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    return b > r && r > g;
  })!;
  // What the grid covers at its default density, about 300 px across: the bar for the finest.
  await lookFrom(page, [0, 0.2, 1], 125);
  const bar: Record<string, number> = {};
  for (const color of [purple, nearBlack])
    bar[color] = Math.max(0.16, (await gridCoverage(page, 'ball', color)).noticeable);
  await setDensity(page, 6);
  // From about 400 px across to 150, where the finest grid's own cells are too small to show.
  const steps: Record<string, { perceptible: number; noticeable: number }[]> = {
    [purple]: [],
    [nearBlack]: [],
  };
  for (let distance = 100; distance <= 260; distance *= 1.1) {
    await lookFrom(page, [0, 0.2, 1], distance);
    for (const color of [purple, nearBlack]) {
      const { perceptible, noticeable } = await gridCoverage(page, 'ball', color);
      steps[color].push({ perceptible, noticeable });
    }
  }
  note('bar', bar);
  note('steps', steps);
  for (const [color, shares] of Object.entries(steps)) {
    for (const { perceptible } of shares)
      expect(perceptible, `${color}: still a grid`).toBeGreaterThan(visible);
    // About 300 px across it covers no more than the default grid does.
    expect(shares[3].noticeable, color).toBeLessThan(bar[color]);
    // No step of the zoom changes much of what it covers at once.
    for (let i = 1; i < shares.length; i++)
      expect(
        Math.abs(shares[i].noticeable - shares[i - 1].noticeable),
        `${color}, step ${i}`,
      ).toBeLessThan(0.12);
  }
});

test('where cells are large on screen, the core stands out on Distinct colours and white, and the casing on a near-black part', async ({
  page,
}) => {
  await layGrid(page, ball());
  for (const [view, direction] of [
    ['front', [0, 0.2, 1]],
    ['side', [1, 0.5, 0.4]],
  ] as const) {
    await lookFrom(page, [...direction], 70);
    await expectCoreContrast(page, `close, ${view}`);
    await expectCasingContrast(page, `close, ${view}`);
  }
});

test('the line stands out in every lighting', async ({ page }) => {
  await layGrid(page, ball());
  await lookFrom(page, [0, 0.2, 1]);
  for (const preset of ['studio', 'soft', 'headlight', 'dramatic']) {
    await setLighting(page, preset);
    // Where a preset leaves the surface in shadow, the casing carries the line.
    const { samples, results } = await gridContrast(
      page,
      [...distinct, nearBlack],
      'ball',
      squarely,
    );
    note(preset, results);
    expect(samples).toBeGreaterThan(100);
    for (const { color, line } of results)
      expect(line.low, `${preset} ${color}: fifth percentile across the line`).toBeGreaterThan(3);
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
    expect(grid.shares.core.front.shown, view).toBeGreaterThan(0.9);
    expect(grid.shares.core.back.shown, view).toBeLessThan(0.002);
    expect(grid.shares.casing.back.shown, view).toBeLessThan(0.002);
  }
  // Zoomed in until cells are large on screen.
  await lookFrom(page, [0, 0.2, 1], 200, 20);
  await expectCoreContrast(page, 'orthographic');
});

test.describe('at device pixel ratio 2', () => {
  test.use({ deviceScaleFactor: 2 });

  test('the grid is whole and stands out', async ({ page }) => {
    await layGrid(page, ball());
    await lookFrom(page, [0, 0.2, 1]);
    const grid = await gridVisibility(page, 'ball');
    note('visibility', grid);
    expect(grid.shares.core.front.shown).toBeGreaterThan(0.9);
    expect(grid.shares.core.back.shown).toBeLessThan(0.002);
    await expectCoreContrast(page, 'ratio 2');
  });
});
