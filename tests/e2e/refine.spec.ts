import { expect, test, type Page } from '@playwright/test';
import { failOnBrowserErrors } from './helpers/warp-grid';
import {
  chainStraightness,
  clickProposal,
  clickSurface,
  crest,
  drag,
  half,
  fixture,
  inEditor,
  inStore,
  indexedBlockFixture,
  openRefine,
  planeFit,
  previewOffModel,
  noticeCount,
  cylinderFixture,
  rimCrest,
  plate,
  plateFixture,
  screen,
  surfaceCorner,
  useAlongPreset,
} from './helpers/refine';
import { serializeGeometry } from '../../src/core/geometry';
import { slottedPlate } from '../helpers/soft-edges';
import type { RegionSolve } from '../../src/core/refine-region';
import type { RefineMode } from '../../src/core/store';
import type { BufferGeometry } from 'three';
import type { Vec3 } from '../../src/core/types';

failOnBrowserErrors();

const undo = (page: Page) => page.keyboard.press('ControlOrMeta+z');
const redo = (page: Page) => page.keyboard.press('ControlOrMeta+Shift+z');

/** A point on the block's front face. */
const front = (x: number, y: number): Vec3 => [x, y, half[2]];

/** The session's undo and redo counts. */
const steps = (page: Page) =>
  inStore(page, (s) => ({ undo: s.refine!.undo.length, redo: s.refine!.redo.length }));

/** Uuid of the part's geometry and a sum of its positions, to tell whether it changed. */
const partMesh = (page: Page) =>
  inStore(page, (s) => {
    const part = s.scene.parts[0];
    const position = part.geometry.getAttribute('position');
    let sum = 0;
    for (let i = 0; i < position.count; i++)
      sum += position.getX(i) * 1.1 + position.getY(i) * 1.3 + position.getZ(i) * 1.7;
    return { uuid: part.geometry.uuid, count: position.count, sum, source: part.source };
  });

/** Sets the brush radius in the panel. */
async function brushRadius(page: Page, radius: number) {
  const field = page.getByRole('spinbutton', { name: 'Brush radius', exact: true });
  await field.fill(String(radius));
  await field.press('Enter');
  await expect
    .poll(() => inEditor(page, (store) => store.refineBrushRadius(store.useEditor.getState())))
    .toBe(radius);
}

/** Lays a two-point guide on the top front edge and accepts it. */
async function acceptGuide(page: Page) {
  await clickSurface(page, crest(-3));
  await clickSurface(page, crest(3));
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
}

/** Runs detection and waits for it to finish; returns the number of proposals. */
async function detect(page: Page) {
  await page.getByRole('button', { name: 'Find edges and surfaces' }).click();
  await expect.poll(() => inStore(page, (s) => s.refine!.detect.running)).toBe(false);
  return inStore(page, (s) => s.refine!.features.filter((f) => f.state === 'pending').length);
}

/** The front crest proposal at the top or bottom of the block. */
const frontProposal = (page: Page, side: 1 | -1 = 1) =>
  inEditor(
    page,
    (store, side) => {
      const found = store.useEditor.getState().refine!.features.find((f) => {
        if (f.state !== 'pending' || f.feature.type !== 'edge') return false;
        const points = f.feature.input.segments.flatMap((g) => g.points.map((p) => p.position));
        return (
          points.every((p) => p[1] * side > 2 && p[2] > 1) &&
          Math.abs(points[0][0] - points.at(-1)![0]) > 4
        );
      });
      return found?.id ?? null;
    },
    side,
  );

const pendingIds = (page: Page) =>
  inStore(page, (s) => s.refine!.features.filter((f) => f.state === 'pending').map((f) => f.id));

/** The ends the pending guide's latest solve used, or null before it has one. */
const solvedEnds = (page: Page) =>
  inEditor(page, (store) => {
    const refine = store.useEditor.getState().refine!;
    const f = refine.features.find((f) => f.state === 'pending');
    const solve = f && (store.refineSolved(refine, f) as { ends: string[] } | null);
    return solve ? solve.ends : null;
  });

/** Keeps the current draft and a copy of the preview's positions in the page. */
const keepDraft = (page: Page) =>
  inStore(page, (s) => {
    const { draft, preview } = s.refine!;
    (globalThis as { kept?: unknown }).kept = {
      draft,
      positions: Float64Array.from(preview!.getAttribute('position').array),
    };
  });

/** Whether a new draft has been built since keepDraft. */
const draftRebuilt = (page: Page) =>
  inStore(page, (s) => {
    const kept = (globalThis as { kept?: { draft: unknown } }).kept!;
    return s.refine!.draft !== null && s.refine!.draft !== kept.draft;
  });

/** Largest change of a preview coordinate since keepDraft, mm. */
const previewChange = (page: Page) =>
  inStore(page, (s) => {
    const kept = (globalThis as { kept?: { positions: Float64Array } }).kept!;
    const now = s.refine!.preview!.getAttribute('position').array;
    let most = 0;
    for (let i = 0; i < now.length; i++)
      most = Math.max(most, Math.abs(now[i] - kept.positions[i]));
    return most;
  });

/** Clicks the viewport beside the block, where no part is. */
async function clickBeside(page: Page) {
  const box = (await page.locator('canvas').boundingBox())!;
  const side = await screen(page, [half[0], 0, half[2]]);
  const right = box.x + box.width;
  await page.mouse.click((side.x + right) / 2, side.y);
}

/** The rivet at (0, 1) on the riveted plate. */
const rivet = plate.rivets.find((r) => r.x === 0 && r.z === 1)!;

/** Paints four strokes across the plate's top face over the rivet at (0, 1). */
async function paintRivet(page: Page) {
  for (const z of [0.4, 0.8, 1.2, 1.6])
    await drag(page, [
      [-1.2, 0.5, z],
      [1.2, 0.5, z],
    ]);
}

/**
 * On the working surface: the height of the rivet at (0, 1) over the plate around it, and how far
 * the plate's top vertices near it spread about their mean height.
 */
const rivetMeasure = (page: Page) =>
  inEditor(
    page,
    (store, rivet) => {
      const { position, weldedCount } = store.useEditor.getState().refine!.model!.mesh;
      const base: number[] = [];
      let peak = -Infinity;
      for (let v = 0; v < weldedCount; v++) {
        const [x, y, z] = [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]];
        if (y < 0.3) continue;
        const r = Math.hypot(x - rivet.x, z - rivet.z);
        if (r < 0.05) peak = Math.max(peak, y);
        else if (r > 0.6 && Math.abs(x) < 0.9 && z > 0.5 && z < 1.5) base.push(y);
      }
      const mean = base.reduce((s, y) => s + y, 0) / base.length;
      return {
        spread: Math.max(...base.map((y) => Math.abs(y - mean))),
        height: peak - mean,
        samples: base.length,
      };
    },
    rivet,
  );

test('guides a straight edge, accepts it and applies it', async ({ page }) => {
  await openRefine(page);
  await useAlongPreset(page);
  await clickSurface(page, crest(-3));
  await clickSurface(page, crest(3));
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
  const past = await inStore(page, (s) => s.past.length);
  await page.getByRole('button', { name: 'Apply' }).click();
  const part = await inStore(page, (s) => ({
    source: s.scene.parts[0].source,
    past: s.past.length,
  }));
  expect(part.source).toBe('Refine · Scanned block');
  expect(part.past).toBe(past + 1);
  expect(await chainStraightness(page)).toBeLessThan(0.02);
});

test('places an arc', async ({ page }) => {
  // Three clicks on the cylinder's rounded top rim, seen from above.
  await openRefine(page, { scene: cylinderFixture, view: '7' });
  await page.getByRole('radio', { name: 'Arc', exact: true }).click();
  for (const angle of [-0.9, 0, 0.9]) await clickSurface(page, rimCrest(angle));
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  // One arc through the three points, not a line from point to point.
  expect(
    await inStore(page, (s) => {
      const f = s.refine!.features[0];
      return f.feature.type === 'edge'
        ? f.feature.input.segments.map((g) => [g.kind, g.points.length])
        : null;
    }),
  ).toEqual([['arc', 3]]);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
  const guide = await inStore(page, (s) => {
    const f = s.refine!.features[0];
    if (f.feature.type !== 'edge' || !f.curve) return null;
    return {
      segments: f.feature.input.segments.map((g) => ({
        kind: g.kind,
        points: g.points.map((p) => p.position),
      })),
      curve: [...f.curve.points],
    };
  });
  expect(guide).not.toBeNull();
  const { segments, curve } = guide!;
  expect(segments.map((g) => [g.kind, g.points.length])).toEqual([['arc', 3]]);
  // The circle through the clicks, seen from above (x, z).
  const [a, b, c] = segments[0].points.map((p) => [p[0], p[2]]);
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const sq = (p: number[]) => p[0] ** 2 + p[1] ** 2;
  const center = [
    (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d,
    (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d,
  ];
  const radius = Math.hypot(a[0] - center[0], a[1] - center[1]);
  const flat: number[][] = [];
  for (let i = 0; i < curve.length; i += 3) flat.push([curve[i], curve[i + 2]]);
  // The solved edge bends with the arc: its distance from the clicks' centre hardly changes along it
  // (measured 2.99 to 3.01 mm; two straight lines would dip 0.3 mm between the clicks).
  const radii = flat.map((p) => Math.hypot(p[0] - center[0], p[1] - center[1]));
  expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.1);
  // Its middle stands off the chord between its ends by about the sagitta of the clicks' circle
  // over that chord (measured 0.74 mm against 0.81).
  const [start, end, middle] = [flat[0], flat.at(-1)!, flat[Math.floor(flat.length / 2)]];
  const chord = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const sagitta = radius - Math.sqrt(radius ** 2 - (chord / 2) ** 2);
  const standoff =
    Math.abs(
      (end[0] - start[0]) * (middle[1] - start[1]) - (end[1] - start[1]) * (middle[0] - start[0]),
    ) / chord;
  expect(sagitta).toBeGreaterThan(0.3);
  expect(standoff).toBeGreaterThan(sagitta / 2);
  expect(standoff).toBeLessThan(sagitta * 1.5);
});

test('previews a closed guide on the plane of a rounded slot', async ({ page }, info) => {
  const geometry = serializeGeometry(
    slottedPlate(0.35, 0.15, { step: 0.035, ripple: 0.01, noise: 0.006, indexed: true }),
  );
  const scene = { ...fixture, parts: [{ ...fixture.parts[0], name: 'Slotted plate', geometry }] };
  await openRefine(page, { scene, view: '7' });
  await page.getByRole('combobox', { name: 'Plane' }).selectOption('points');
  for (const p of [
    [-1, 1, -0.85],
    [1, 1, -0.85],
    [0, 1, 0.85],
  ] as Vec3[])
    await clickSurface(page, p);
  await expect.poll(() => inStore(page, (s) => s.refine!.planes.length)).toBe(1);
  await inStore(page, (s) => s.setRefineEdge({ width: 0.5, wallAngle: 90, joint: 'smooth' }));
  const start: Vec3 = [-1.5, 1, -0.35];
  await clickSurface(page, start);
  await clickSurface(page, [1.5, 1, -0.35]);
  await page.getByRole('radio', { name: 'Arc', exact: true }).click();
  await clickSurface(page, [1.85, 1, 0]);
  await clickSurface(page, [1.5, 1, 0.35]);
  await page.getByRole('radio', { name: 'Line', exact: true }).click();
  await clickSurface(page, [-1.5, 1, 0.35]);
  await page.getByRole('radio', { name: 'Arc', exact: true }).click();
  await clickSurface(page, [-1.85, 1, 0]);
  await clickSurface(page, start);
  await expect.poll(() => inStore(page, (s) => s.refine!.features[0]?.curve?.closed)).toBe(true);
  await page.screenshot({ path: info.outputPath('slotted-plate.png') });
});

test('places a closed path and accepts it', async ({ page }) => {
  await openRefine(page);
  await page.getByRole('radio', { name: 'Line', exact: true }).click();
  const corners = [surfaceCorner(-1, 1), surfaceCorner(1, 1), surfaceCorner(1, -1)];
  corners.push(surfaceCorner(-1, -1));
  for (const corner of corners) await clickSurface(page, corner);
  // A click on the first handle closes the path.
  await clickSurface(page, corners[0]);
  const path = await inStore(page, (s) => {
    const f = s.refine!.features.find((f) => f.state === 'pending')!;
    return f.feature.type === 'edge'
      ? { closed: f.feature.input.closed, segments: f.feature.input.segments.length }
      : null;
  });
  expect(path).toEqual({ closed: true, segments: 4 });
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
});

/**
 * The selected pending region's solve once the preview has made it: its fully weighted base
 * vertices (not kept as detail) and what it fitted.
 */
const regionSolve = (page: Page) =>
  inEditor(page, (store) => {
    const refine = store.useEditor.getState().refine!;
    const f = refine.features.find((f) => f.id === refine.selected[0]);
    const solve = f && (store.refineSolved(refine, f) as RegionSolve | null);
    if (!solve) return null;
    const base = [...solve.vertices].filter((_, i) => solve.weight[i] >= 0.999 && !solve.detail[i]);
    return { vertices: [...solve.vertices], base, fitted: solve.fitted };
  });

/** World positions of welded vertices on the session's working surface. */
const modelPoints = (page: Page, vertices: number[]) =>
  inEditor(
    page,
    (store, vertices) => {
      const { position } = store.useEditor.getState().refine!.model!.mesh;
      return vertices.map((v) => [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]]);
    },
    vertices,
  );

test('paints a region and runs each treatment', async ({ page }) => {
  await openRefine(page);
  await page.getByRole('radio', { name: 'Region', exact: true }).click();
  await brushRadius(page, 0.5);
  const treatments = ['Smooth', 'Flatten', 'Shape'] as const;
  for (const [i, treatment] of treatments.entries()) {
    // A patch 2.2 mm wide and 4 mm high, wide enough to keep an interior inside its blend.
    const x = (i - 1) * 2.4;
    await drag(
      page,
      [-1.5, -0.75, 0, 0.75, 1.5].flatMap((y) => [front(x - 0.6, y), front(x + 0.6, y)]),
    );
    await expect.poll(() => inStore(page, (s) => s.refine!.triangles.length)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Make region' }).click();
    await page.getByRole('radio', { name: treatment, exact: true }).click();
    await expect
      .poll(() =>
        inStore(page, (s) => {
          const f = s.refine!.features.find((f) => f.id === s.refine!.selected[0]);
          return f?.feature.type === 'region' ? f.feature.input.treatment : null;
        }),
      )
      .toBe(treatment.toLowerCase());
    await expect.poll(() => regionSolve(page)).not.toBeNull();
    const solve = (await regionSolve(page))!;
    expect(solve.base.length).toBeGreaterThan(10);
    if (treatment === 'Shape') {
      expect(solve.fitted).toBe('plane');
      await expect(page.getByText('Fits a plane')).toBeVisible();
    }
    const before = await modelPoints(page, solve.vertices);
    const base = planeFit(await modelPoints(page, solve.base));
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(page.getByText(`${i + 1} accepted · 0 proposed`)).toBeVisible();
    const after = await modelPoints(page, solve.vertices);
    const moved = Math.max(
      ...after.map((p, k) =>
        Math.hypot(p[0] - before[k][0], p[1] - before[k][1], p[2] - before[k][2]),
      ),
    );
    const treated = planeFit(await modelPoints(page, solve.base));
    // Measured: Smooth 0.016 to 0.0002 mm RMS off a plane; Flatten and Shape 0.04 mm to 1e-7 at most.
    expect(base.rms).toBeGreaterThan(0.008);
    expect(moved).toBeGreaterThan(0.01);
    if (treatment === 'Smooth') expect(treated.rms).toBeLessThan(base.rms / 4);
    else expect(treated.max).toBeLessThan(0.002);
  }
  expect(await inStore(page, (s) => s.refine!.model !== s.refine!.start)).toBe(true);
  await expect(page.getByRole('button', { name: 'Apply' })).toBeEnabled();
});

test('a Crease stroke proposes a wide edge or accepts one within the brush radius', async ({
  page,
}) => {
  await openRefine(page);
  await page.getByRole('radio', { name: 'Brush', exact: true }).click();
  let before = (await steps(page)).undo;
  await page.getByRole('radio', { name: 'Crease', exact: true }).click();
  // At the default radius the rounding is wider than the brush: the guide waits to be accepted.
  await drag(page, [crest(-3), crest(3)], 40);
  await expect.poll(async () => (await steps(page)).undo).toBe(before + 1);
  await expect(
    page.getByText('The edge is wider than the brush. Check the preview, then accept it.'),
  ).toBeVisible();
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  const pending = await inStore(page, (s) => {
    const f = s.refine!.features[0];
    return { type: f.feature.type, origin: f.origin, selected: s.refine!.selected };
  });
  expect(pending).toMatchObject({ type: 'edge', origin: 'hand', selected: [expect.any(String)] });
  await page.getByRole('radio', { name: 'Edge', exact: true }).click();
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();

  // A brush as wide as the rounding: the stroke is accepted on release.
  await page.getByRole('radio', { name: 'Brush', exact: true }).click();
  await brushRadius(page, 1.2);
  before = (await steps(page)).undo;
  await drag(
    page,
    [
      crest(-3).map((v, a) => (a === 1 ? -v : v)) as Vec3,
      crest(3).map((v, a) => (a === 1 ? -v : v)) as Vec3,
    ],
    40,
  );
  await expect.poll(async () => (await steps(page)).undo).toBe(before + 1);
  await expect(page.getByText('2 accepted · 0 proposed')).toBeVisible();

  expect(await inStore(page, (s) => s.refine!.model !== s.refine!.start)).toBe(true);
});

test('a flatten stroke takes the curve out of a face where a smooth stroke keeps it', async ({
  page,
}) => {
  await openRefine(page, { scene: cylinderFixture });
  await page.getByRole('radio', { name: 'Brush', exact: true }).click();
  await brushRadius(page, 1);
  const spread: Record<string, { before: number; after: number }> = {};
  // Each brush strokes its own strip of the rippled side, up the cylinder at `angle` from +z.
  for (const [kind, angle] of [
    ['Flatten', -0.45],
    ['Smooth', 0.45],
  ] as const) {
    const before = (await steps(page)).undo;
    const stroked = await inEditor(
      page,
      (store, angle) => {
        const { position, weldedCount } = store.useEditor.getState().refine!.model!.mesh;
        const found: number[] = [];
        for (let v = 0; v < weldedCount; v++) {
          const [x, y, z] = [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]];
          if (
            Math.abs(Math.atan2(x, z) - angle) < 0.2 &&
            Math.abs(y) < 0.5 &&
            Math.hypot(x, z) > 2.8
          )
            found.push(v);
        }
        return found;
      },
      angle,
    );
    expect(stroked.length).toBeGreaterThan(10);
    const original = await modelPoints(page, stroked);
    await page.getByRole('radio', { name: kind, exact: true }).click();
    const side = (y: number): Vec3 => [3 * Math.sin(angle), y, 3 * Math.cos(angle)];
    await drag(page, [side(-0.8), side(0.8)], 30);
    await expect.poll(async () => (await steps(page)).undo).toBe(before + 1);
    const current = await modelPoints(page, stroked);
    spread[kind] = { before: planeFit(original).rms, after: planeFit(current).rms };
    if (kind === 'Smooth') {
      const moved = Math.max(
        ...current.map((p, i) => Math.hypot(...p.map((x, a) => x - original[i][a]))),
      );
      expect(moved, 'Smooth moves the stroked strip').toBeGreaterThan(0.005);
    }
  }
  // RMS off a plane fitted to the strip, mm, measured: Flatten 0.026 to 0.0052, Smooth 0.026 to
  // 0.0229. Smooth keeps the cylinder's curve; Flatten pulls the strip toward one plane.
  expect(spread.Smooth.after).toBeGreaterThan(spread.Smooth.before / 2);
  expect(spread.Flatten.after).toBeLessThan(spread.Smooth.after / 2);
});

type SourceSnapshot = {
  geometry: BufferGeometry;
  position: ArrayBufferView;
  buffers: (
    geometry: BufferGeometry,
  ) => Record<'positions' | 'normals' | 'index', Uint8Array | null>;
  bytes: Record<'positions' | 'normals' | 'index', Uint8Array | null>;
  workingPositions: Float64Array;
};

/** Copies the source and working buffers in the page for comparison after Detect. */
const keepSource = (page: Page) =>
  inStore(page, (s) => {
    const view = (array: ArrayBufferView | undefined) =>
      array ? new Uint8Array(array.buffer, array.byteOffset, array.byteLength) : null;
    const buffers = (geometry: BufferGeometry) => ({
      positions: view(geometry.getAttribute('position').array),
      normals: view(geometry.getAttribute('normal')?.array),
      index: view(geometry.index?.array),
    });
    const geometry = s.scene.parts[0].geometry;
    const { positions, normals, index } = buffers(geometry);
    (globalThis as { source?: SourceSnapshot }).source = {
      geometry,
      position: geometry.getAttribute('position').array,
      buffers,
      bytes: {
        positions: positions!.slice(),
        normals: normals?.slice() ?? null,
        index: index?.slice() ?? null,
      },
      workingPositions: s.refine!.model!.mesh.position.slice(),
    };
  });

const sourceKept = (page: Page) =>
  inStore(page, (s) => {
    const kept = (globalThis as { source?: SourceSnapshot }).source!;
    const geometry = s.scene.parts[0].geometry;
    const now = kept.buffers(kept.geometry);
    const sameBytes = (key: keyof SourceSnapshot['bytes']) => {
      const before = kept.bytes[key],
        after = now[key];
      return before && after
        ? before.length === after.length && after.every((byte, i) => byte === before[i])
        : before === after;
    };
    return {
      geometry: geometry === kept.geometry,
      array: geometry.getAttribute('position').array === kept.position,
      positions: sameBytes('positions'),
      normals: sameBytes('normals'),
      index: sameBytes('index'),
    };
  });

const edgeInput = (page: Page, id: string) =>
  inEditor(
    page,
    (store, id) => {
      const f = store.useEditor.getState().refine!.features.find((f) => f.id === id);
      return f?.feature.type === 'edge' ? f.feature.input : undefined;
    },
    id,
  );

test('detects without changing either mesh, edits two selected guides and accepts one', async ({
  page,
}) => {
  await openRefine(page, { scene: indexedBlockFixture });
  await keepSource(page);
  await page.getByRole('radio', { name: 'Detect' }).click();
  await detect(page);
  const source = { geometry: true, array: true, positions: true, normals: true, index: true };
  expect(await sourceKept(page), 'Detect leaves the source geometry intact').toEqual(source);
  expect(
    await inStore(page, (s) => {
      const before = (globalThis as { source?: SourceSnapshot }).source!.workingPositions;
      const { position } = s.refine!.model!.mesh;
      return position.length === before.length && position.every((x, i) => x === before[i]);
    }),
    'Detect leaves the working positions intact',
  ).toBe(true);
  expect(await inStore(page, (s) => s.refine!.model === s.refine!.start)).toBe(true);
  const before = await inStore(
    page,
    (s) => s.scene.parts[0].geometry.getAttribute('position').count,
  );
  const id = (await frontProposal(page))!;
  const second = (await frontProposal(page, -1))!;
  const untouched = (
    await inStore(page, (s) =>
      s
        .refine!.features.filter((f) => f.state === 'pending' && f.feature.type === 'edge')
        .map((f) => f.id),
    )
  ).find((other) => other !== id && other !== second)!;
  if (!untouched) throw new Error('Detect needs a third edge to check unselected settings');
  const untouchedInput = await edgeInput(page, untouched);
  const defaults = await inStore(page, (s) => s.refine!.edge);
  await clickProposal(page, id);
  await clickProposal(page, second, [id]);
  await page.getByRole('radio', { name: 'Edge', exact: true }).click();
  await page.getByRole('switch', { name: 'Choose width automatically' }).click();
  const width = page.getByRole('spinbutton', { name: 'Width', exact: true });
  await width.fill('1.2');
  await width.press('Enter');
  await expect
    .poll(async () => (await edgeInput(page, id))?.width, { message: 'Top guide Width' })
    .toBe(1.2);
  expect((await edgeInput(page, second))?.width, 'Bottom guide Width').toBe(1.2);
  expect(await edgeInput(page, untouched), 'Unselected guide inputs').toEqual(untouchedInput);
  expect(await inStore(page, (s) => s.refine!.edge), 'Edge defaults').toEqual(defaults);
  await page.getByRole('radio', { name: 'Detect', exact: true }).click();
  await clickProposal(page, id);
  await page.getByRole('button', { name: 'Accept selected' }).click();
  await expect(page.getByText(/1 accepted · \d+ proposed/)).toBeVisible();
  expect(
    await inStore(page, (s) => {
      const f = s.refine!.features.find((f) => f.state === 'accepted');
      return f?.feature.type === 'edge' ? [f.id, f.feature.input.width] : null;
    }),
  ).toEqual([id, 1.2]);
  expect(await inStore(page, (s) => s.scene.parts[0].geometry.getAttribute('position').count)).toBe(
    before,
  );
  // Accept changes the working surface only; Apply alone gives the part new geometry.
  expect(await sourceKept(page)).toMatchObject({ geometry: true, array: true, positions: true });
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect
    .poll(() => sourceKept(page))
    .toMatchObject({ geometry: false, array: false, positions: true });
});

test('Width goes to the selected guide, or with none selected to the next guide', async ({
  page,
}) => {
  await openRefine(page);
  const defaults = await inStore(page, (s) => s.refine!.edge);
  await clickSurface(page, crest(-3));
  await clickSurface(page, crest(3));
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  const widths = () =>
    inStore(page, (s) =>
      s.refine!.features.map((f) => (f.feature.type === 'edge' ? f.feature.input.width : null)),
    );
  const auto = page.getByRole('switch', { name: 'Choose width automatically' });
  const width = page.getByRole('spinbutton', { name: 'Width', exact: true });
  await auto.click();
  await width.fill('1.2');
  await width.press('Enter');
  await expect.poll(widths).toEqual([1.2]);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
  // Nothing is selected now: the next guide's defaults are as they were.
  expect(await inStore(page, (s) => s.refine!.selected)).toEqual([]);
  expect(await inStore(page, (s) => s.refine!.edge)).toEqual(defaults);
  await expect(auto).toHaveAttribute('aria-checked', 'true');

  // With nothing selected, Width sets the defaults and leaves the guides alone.
  await auto.click();
  await expect.poll(() => inStore(page, (s) => s.refine!.edge.width)).toBeGreaterThan(0);
  await width.fill('0.9');
  await width.press('Enter');
  await expect.poll(() => inStore(page, (s) => s.refine!.edge.width)).toBe(0.9);
  expect(await widths()).toEqual([1.2]);
});

test('undoes and redoes inside the session, then cancels', async ({ page }) => {
  await openRefine(page);
  const original = await partMesh(page);
  await acceptGuide(page);
  await undo(page);
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  await redo(page);
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(() => inStore(page, (s) => s.refine)).toBeNull();
  expect(await partMesh(page)).toEqual(original);
});

test('says so when a guide finds no edge', async ({ page }) => {
  await openRefine(page);
  await clickSurface(page, front(-2, 0));
  await clickSurface(page, front(2, 0));
  await expect(
    page.locator('.refine-counts').filter({ hasText: 'No edge found under this guide.' }),
  ).toBeVisible();
});

const noEdge = 'No edge found under this guide. Move it onto the rounded edge or change Width.';

test('says once per guide that it finds no edge', async ({ page }) => {
  await openRefine(page);
  await clickSurface(page, front(-2, 1));
  await clickSurface(page, front(2, 1));
  await expect(page.locator('.refine-counts').filter({ hasText: noEdge })).toBeVisible();
  await expect.poll(() => noticeCount(page, noEdge)).toBe(1);
  // A new Width for the same guide fails for the same reason: nothing new to say.
  await keepDraft(page);
  await page.getByRole('switch', { name: 'Choose width automatically' }).click();
  const width = page.getByRole('spinbutton', { name: 'Width', exact: true });
  await width.fill('0.5');
  await width.press('Enter');
  await expect
    .poll(() =>
      inStore(page, (s) =>
        s.refine!.features.map((f) => (f.feature.type === 'edge' ? f.feature.input.width : null)),
      ),
    )
    .toEqual([0.5]);
  await expect.poll(() => draftRebuilt(page)).toBe(true);
  expect(await noticeCount(page, noEdge)).toBe(1);
  // A click off the part lets go of the guide; a second guide that fails says so again.
  await clickBeside(page);
  await expect.poll(() => inStore(page, (s) => s.refine!.selected)).toEqual([]);
  await clickSurface(page, front(-2, -1));
  await clickSurface(page, front(2, -1));
  await expect.poll(() => inStore(page, (s) => s.refine!.features.length)).toBe(2);
  await expect.poll(() => noticeCount(page, noEdge)).toBe(2);
});

test('an open guide shows its automatic ends and goes back to them', async ({ page }) => {
  await openRefine(page);
  await clickSurface(page, crest(-3));
  await clickSurface(page, crest(3));
  await expect.poll(() => solvedEnds(page)).not.toBeNull();
  const chosen = (await solvedEnds(page))!;
  const named = { taper: 'Fade', hold: 'Hold' } as Record<string, string>;
  const selects = [page.getByLabel('Start of the guide'), page.getByLabel('End of the guide')];
  for (const [k, select] of selects.entries()) {
    await expect(select).toHaveValue('auto');
    await expect(select.locator('option[value="auto"]')).toHaveText(`Auto (${named[chosen[k]]})`);
  }
  const other = chosen[0] === 'hold' ? 'taper' : 'hold';
  await selects[0].selectOption(other);
  await expect.poll(() => solvedEnds(page)).toEqual([other, chosen[1]]);
  await selects[0].selectOption('auto');
  await expect.poll(() => solvedEnds(page)).toEqual(chosen);
  await expect(selects[0].locator('option[value="auto"]')).toHaveText(`Auto (${named[chosen[0]]})`);
  expect(
    await inStore(page, (s) => {
      const f = s.refine!.features[0];
      return f.feature.type === 'edge' ? f.feature.input.ends : null;
    }),
  ).toEqual([null, null]);
});

test('Reach off Automatic keeps the preview, and a new Reach changes it', async ({ page }) => {
  await openRefine(page);
  await page.getByRole('radio', { name: 'Region', exact: true }).click();
  await brushRadius(page, 0.5);
  await drag(
    page,
    [-1.5, -0.75, 0, 0.75, 1.5].flatMap((y) => [front(-0.6, y), front(0.6, y)]),
  );
  await page.getByRole('button', { name: 'Make region' }).click();
  await expect.poll(() => inStore(page, (s) => s.refine!.draft !== null)).toBe(true);
  const scale = () =>
    inStore(page, (s) => {
      const f = s.refine!.features[0];
      return f.feature.type === 'region' ? (f.feature.input.scale ?? null) : undefined;
    });
  expect(await scale()).toBeNull();
  await keepDraft(page);
  await page.getByRole('switch', { name: 'Choose reach automatically' }).click();
  const reach = page.getByRole('spinbutton', { name: 'Reach', exact: true });
  await expect(reach).toBeVisible();
  const seeded = (await scale())!;
  expect(seeded).toBeGreaterThan(0);
  expect(Number(await reach.inputValue())).toBeGreaterThan(0);
  await expect.poll(() => draftRebuilt(page)).toBe(true);
  // Measured: the seeded Reach is 3.42 mm; the least Reach, 0.3 mm, moves the preview 0.042 mm.
  expect(await previewChange(page)).toBeLessThan(1e-6);
  await keepDraft(page);
  await reach.fill('0.3');
  await reach.press('Enter');
  await expect.poll(scale).toBe(0.3);
  await expect.poll(() => draftRebuilt(page)).toBe(true);
  expect(await previewChange(page)).toBeGreaterThan(0.01);
});

/** The first region's treatment and Offset. */
const regionDetail = (page: Page) =>
  inStore(page, (s) => {
    const f = s.refine!.features[0];
    return f.feature.type === 'region' ? [f.feature.input.treatment, f.feature.input.detail] : null;
  });

const regionDraftReady = (page: Page) =>
  inEditor(page, (store) => {
    const refine = store.useEditor.getState().refine!;
    const kept = (globalThis as { kept?: { draft: unknown } }).kept!;
    return (
      refine.draft !== null &&
      refine.draft !== kept.draft &&
      store.refineSolved(refine, refine.features[0]) !== null
    );
  });

const previewVertexDistance = (page: Page) =>
  inStore(page, (s) => {
    const { positions: before } = (globalThis as { kept?: { positions: Float64Array } }).kept!;
    const position = s.refine!.preview!.getAttribute('position');
    const after = position.array;
    let max = 0;
    if (after.length === before.length) {
      for (let i = 0; i < after.length; i += 3) {
        max = Math.max(
          max,
          Math.hypot(
            after[i] - before[i],
            after[i + 1] - before[i + 1],
            after[i + 2] - before[i + 2],
          ),
        );
      }
    }
    return { beforeCount: before.length / 3, afterCount: position.count, max };
  });

test('Offset off Automatic moves the preview less than 0.02 mm and a large Offset flattens a rivet', async ({
  page,
}) => {
  await openRefine(page, { scene: plateFixture, view: '7' });
  await page.getByRole('radio', { name: 'Region', exact: true }).click();
  await brushRadius(page, 0.5);
  await paintRivet(page);
  await page.getByRole('button', { name: 'Make region' }).click();
  await expect.poll(() => inStore(page, (s) => s.refine!.draft !== null)).toBe(true);
  await keepDraft(page);
  await page.getByRole('radio', { name: 'Flatten', exact: true }).click();
  await expect.poll(() => regionDetail(page)).toEqual(['flatten', null]);
  await expect
    .poll(() => regionDraftReady(page), { message: 'Current automatic Flatten draft' })
    .toBe(true);
  await keepDraft(page);

  const before = await rivetMeasure(page);
  const offset = page.getByRole('spinbutton', { name: 'Offset', exact: true });
  await test.step('Offset off Automatic preserves the preview within 0.02 mm', async () => {
    await page.getByRole('switch', { name: 'Choose offset automatically' }).click();
    await expect(offset).toBeVisible();
    expect((await regionDetail(page))![1]).toBeGreaterThan(0);
    expect(Number(await offset.inputValue())).toBeGreaterThan(0);
    await expect
      .poll(() => regionDraftReady(page), { message: 'Current fixed Offset Flatten draft' })
      .toBe(true);
    const { beforeCount, afterCount, max } = await previewVertexDistance(page);
    expect.soft(afterCount, 'Offset keeps the preview vertex count').toBe(beforeCount);
    // Automatic recalculates each round; using its final limit in every round moves the preview 0.0088 mm.
    if (afterCount === beforeCount)
      expect.soft(max, 'Offset preview drift (mm)').toBeLessThan(0.02);
  });

  await test.step('A large Offset flattens the rivet', async () => {
    await offset.fill('0.5');
    await offset.press('Enter');
    await expect.poll(() => regionDetail(page)).toEqual(['flatten', 0.5]);
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
    // Measured: 0.233 mm high before, 0.001 after.
    expect((await rivetMeasure(page)).height, 'Rivet height after a large Offset').toBeLessThan(
      before.height / 2,
    );
  });
});

test('settings with no matching selection go to the next guide and region', async ({ page }) => {
  await openRefine(page);
  await page.getByRole('radio', { name: 'Arc', exact: true }).click();
  await page.getByRole('switch', { name: 'Choose width automatically' }).click();
  const width = page.getByRole('spinbutton', { name: 'Width', exact: true });
  await width.fill('1.1');
  await width.press('Enter');
  const strength = page.getByRole('spinbutton', { name: 'Strength', exact: true });
  await strength.fill('50');
  await strength.press('Enter');
  await page.getByRole('radio', { name: 'Smooth', exact: true }).click();
  await expect
    .poll(() => inStore(page, (s) => s.refine!.edge))
    .toEqual({
      kind: 'arc',
      width: 1.1,
      joint: 'smooth',
      strength: 0.5,
      ends: [null, null],
      position: 'corner',
      fit: 0,
      path: true,
      wallAngle: null,
      usePlane: true,
      plane: null,
    });
  // Two arcs: three clicks, then two more.
  for (const x of [-3, -2, -1, 0, 1]) await clickSurface(page, crest(x));
  await expect
    .poll(() =>
      inStore(page, (s) => {
        const f = s.refine!.features[0];
        if (f?.feature.type !== 'edge') return null;
        const { segments, joints, width, strength } = f.feature.input;
        return { kinds: segments.map((g) => g.kind), joints, width, strength };
      }),
    )
    .toEqual({ kinds: ['arc', 'arc'], joints: ['smooth'], width: 1.1, strength: 0.5 });

  const selectedEdge = () =>
    inStore(page, (s) => {
      const f = s.refine!.features[0];
      return { id: f.id, input: f.feature.input, selected: s.refine!.selected };
    });
  const before = await selectedEdge();
  await page.getByRole('radio', { name: 'Region', exact: true }).click();
  await page.getByRole('radio', { name: 'Flatten', exact: true }).click();
  await strength.fill('40');
  await strength.press('Enter');
  await page.getByRole('switch', { name: 'Keep detail' }).click();
  await expect
    .poll(() => inStore(page, (s) => s.refine!.region))
    .toMatchObject({ treatment: 'flatten', strength: 0.4, keepDetail: false });
  const after = await selectedEdge();
  expect(after.selected, 'The Edge remains selected in Region mode').toEqual([before.id]);
  expect(after.input, 'Region settings leave the selected Edge inputs alone').toEqual(before.input);
  await brushRadius(page, 0.5);
  await drag(page, [front(-1, 0), front(1, 0)]);
  await page.getByRole('button', { name: 'Make region' }).click();
  await expect
    .poll(() =>
      inStore(page, (s) => {
        const f = s.refine!.features.find((f) => f.feature.type === 'region');
        if (f?.feature.type !== 'region') return null;
        const { treatment, strength, keepDetail } = f.feature.input;
        return { treatment, strength, keepDetail };
      }),
    )
    .toEqual({ treatment: 'flatten', strength: 0.4, keepDetail: false });
});

test.describe('stroke interruption', () => {
  test.use({ hasTouch: true });

  test('Escape, blur and mode changes discard a live stroke and preserve redo', async ({
    page,
  }) => {
    await openRefine(page);
    const brush = page.getByRole('radio', { name: 'Brush', exact: true });
    await brush.click();
    await page.getByRole('radio', { name: 'Smooth', exact: true }).click();
    await drag(page, [front(-2, 1), front(2, 1)], 30);
    await expect.poll(() => steps(page)).toEqual({ undo: 1, redo: 0 });
    await undo(page);
    await expect.poll(() => steps(page)).toEqual({ undo: 0, redo: 1 });
    const interruptions: [string, RefineMode, () => Promise<unknown>][] = [
      ['Escape', 'brush', () => page.keyboard.press('Escape')],
      [
        'window blur',
        'brush',
        async () => {
          const context = page.context();
          const other = await context.newPage();
          const cdp = await context.newCDPSession(page);
          try {
            await page.bringToFront();
            // Disable Playwright's focus emulation so switching tabs sends a real window blur.
            await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
            await other.bringToFront();
            await page.waitForFunction(() => !document.hasFocus(), undefined, { polling: 50 });
          } finally {
            await other.close();
            await page.bringToFront();
            await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
            await cdp.detach();
          }
        },
      ],
      [
        'mode by keyboard',
        'detect',
        async () => {
          await brush.focus();
          await page.keyboard.press('ArrowRight');
        },
      ],
      // Tap the control with a second pointer while the mouse stroke holds capture.
      [
        'mode in the panel',
        'edge',
        () => page.getByRole('radio', { name: 'Edge', exact: true }).tap(),
      ],
    ];
    const a = await screen(page, front(-2, -1)),
      b = await screen(page, front(0, -1)),
      c = await screen(page, front(2, -1));
    for (const [name, mode, interrupt] of interruptions) {
      await test.step(name, async () => {
        await brush.click();
        await inStore(page, (s) => {
          (globalThis as { kept?: unknown }).kept = {
            model: s.refine!.model,
            redo: s.refine!.redo[0],
          };
        });
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.mouse.move(b.x, b.y, { steps: 20 });
        await expect.poll(() => previewOffModel(page)).toBeGreaterThan(1e-3);
        await interrupt();
        await page.mouse.move(c.x, c.y, { steps: 10 });
        await page.mouse.up();
        expect(
          await inStore(page, (s) => ({ tool: s.tool, mode: s.refine?.mode })),
          'Destination mode',
        ).toEqual({ tool: 'refine', mode });
        expect(await steps(page)).toEqual({ undo: 0, redo: 1 });
        expect(
          await inStore(page, (s) => {
            const kept = (globalThis as { kept?: { model: unknown; redo: unknown } }).kept!;
            return { model: s.refine!.model === kept.model, redo: s.refine!.redo[0] === kept.redo };
          }),
          'Working mesh and redo entry',
        ).toEqual({ model: true, redo: true });
        expect(await previewOffModel(page)).toBeLessThan(1e-4);
        expect(await inStore(page, (s) => s.refine!.features.length)).toBe(0);
      });
    }
  });
});

test('sets the ends of an open guide and keeps them on accept', async ({ page }) => {
  await openRefine(page);
  await clickSurface(page, crest(-3));
  await clickSurface(page, crest(3));
  const ends = () => solvedEnds(page);
  await expect.poll(ends).not.toBeNull();
  const end = page.getByLabel('End of the guide'),
    start = page.getByLabel('Start of the guide');
  await end.selectOption({ label: 'Fade' });
  await start.selectOption({ label: 'Hold' });
  await expect.poll(ends).toEqual(['hold', 'taper']);
  await end.selectOption({ label: 'Hold' });
  await start.selectOption({ label: 'Fade' });
  await expect.poll(ends).toEqual(['taper', 'hold']);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
  expect(
    await inStore(page, (s) => {
      const f = s.refine!.features[0];
      return f.feature.type === 'edge' ? f.feature.input.ends : null;
    }),
  ).toEqual(['taper', 'hold']);
});

test('undoes each point and each handle drag as its own step', async ({ page }) => {
  await openRefine(page);
  const points = () =>
    inStore(page, (s) => {
      const f = s.refine!.features[0];
      if (!f || f.feature.type !== 'edge') return [];
      return f.feature.input.segments.flatMap((g) =>
        g.points.map((p) => p.position.map((v) => Math.round(v * 1000) / 1000)),
      );
    });
  const states = [await points()];
  for (const x of [-3, 0, 3]) {
    await clickSurface(page, crest(x));
    await expect.poll(points).not.toEqual(states.at(-1));
    states.push(await points());
  }
  const start = (await steps(page)).undo;
  // The end handle: it lies on the surface, where the preview leaves the rounding.
  for (const [from, to] of [
    [3, 2.5],
    [2.5, 2],
  ]) {
    const a = await screen(page, crest(from)),
      b = await screen(page, crest(to));
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.mouse.up();
    await expect.poll(points).not.toEqual(states.at(-1));
    states.push(await points());
  }
  expect((await steps(page)).undo).toBe(start + 2);
  for (let i = states.length - 2; i >= 0; i--) {
    await undo(page);
    await expect.poll(points).toEqual(states[i]);
  }
  for (let i = 1; i < states.length; i++) {
    await redo(page);
    await expect.poll(points).toEqual(states[i]);
  }
});

// A selected guide's handle stays reachable when the guide's own preview stands in front of it.
test('chooses a guide point and removes it with the key or panel button', async ({ page }) => {
  await openRefine(page);
  await page.getByRole('radio', { name: 'Spline', exact: true }).click();
  for (const x of [-2, 0, 2]) await clickSurface(page, crest(x));
  const remove = page.getByRole('button', { name: 'Remove point', exact: true });
  const points = () =>
    inStore(page, (s) => {
      const guide = s.refine!.features[0]?.feature;
      return guide?.type === 'edge' ? guide.input.segments[0].points.length : null;
    });
  await expect(remove).toBeDisabled();
  await clickSurface(page, crest(0));
  await expect(remove).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(remove).toBeDisabled();
  expect(await points()).toBe(3);
  await clickSurface(page, crest(0));
  const before = await steps(page);
  await page.keyboard.press('Backspace');
  await expect.poll(points).toBe(2);
  expect((await steps(page)).undo).toBe(before.undo + 1);
  await expect(remove).toBeDisabled();
  await undo(page);
  await expect.poll(points).toBe(3);
  await clickSurface(page, crest(0));
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect.poll(points).toBe(2);
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  // Detect shows the button only while a point is chosen.
  await undo(page);
  await expect.poll(points).toBe(3);
  await page.getByRole('radio', { name: 'Detect', exact: true }).click();
  await expect(remove).toHaveCount(0);
  await clickSurface(page, crest(0));
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect.poll(points).toBe(2);
});

test('drags the middle handle of a guide on an exterior edge', async ({ page }) => {
  await openRefine(page);
  for (const x of [-3, 0, 3]) await clickSurface(page, crest(x));
  await expect.poll(() => inStore(page, (s) => !!s.refine!.draft)).toBe(true);
  const middle = () =>
    inStore(page, (s) => {
      const f = s.refine!.features[0];
      return f.feature.type === 'edge' ? f.feature.input.segments[1].points[0].position[0] : null;
    });
  const a = await screen(page, crest(0)),
    b = await screen(page, crest(1));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(middle).toBeGreaterThan(0.8);
});

test('Enter waits for release and presentation of a dragged guide', async ({ page }) => {
  await openRefine(page);
  await clickSurface(page, crest(-3));
  await clickSurface(page, crest(3));
  const accept = page.getByRole('button', { name: 'Accept', exact: true });
  await expect(accept).toBeEnabled();
  const a = await screen(page, crest(3));
  const b = await screen(page, crest(1.7));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await expect(accept).toBeDisabled();
  await page.mouse.move(b.x, b.y, { steps: 3 });
  await expect
    .poll(() =>
      inStore(page, (s) => {
        const f = s.refine!.features[0].feature;
        return f.type === 'edge' ? f.input.segments[0].points[1].position[0] : null;
      }),
    )
    .toBeLessThan(2);
  await page.keyboard.press('Enter');
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  await page.mouse.up();
  await expect(accept).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
});

test('Escape during a handle drag leaves the session as it was', async ({ page }) => {
  await openRefine(page);
  await clickSurface(page, crest(-3));
  await clickSurface(page, crest(3));
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  const keep = () =>
    inEditor(page, (store) => {
      const { features, undo, redo } = store.useEditor.getState().refine!;
      (globalThis as { kept?: unknown[] }).kept = [features, undo, redo];
    });
  const same = () =>
    inEditor(page, (store) => {
      const { features, undo, redo } = store.useEditor.getState().refine!;
      const kept = (globalThis as { kept?: unknown[] }).kept!;
      return [features === kept[0], undo === kept[1], redo === kept[2]];
    });
  await keep();
  const a = await screen(page, crest(3)),
    b = await screen(page, crest(1));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await expect.poll(same).not.toEqual([true, true, true]);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(same).toEqual([true, true, true]);
  expect(await inStore(page, (s) => s.tool)).toBe('refine');
});

test('a new detection replaces the pending proposals', async ({ page }) => {
  await openRefine(page);
  await page.getByRole('radio', { name: 'Detect', exact: true }).click();
  const first = await detect(page);
  expect(first).toBeGreaterThan(0);
  const before = await pendingIds(page);
  expect(await detect(page)).toBe(first);
  expect((await pendingIds(page)).filter((id) => before.includes(id))).toEqual([]);

  // A proposal the user edited stays through a new run.
  const edited = (await frontProposal(page))!;
  await clickProposal(page, edited);
  await page.getByRole('radio', { name: 'Edge', exact: true }).click();
  await page.getByRole('switch', { name: 'Choose width automatically' }).click();
  const width = page.getByRole('spinbutton', { name: 'Width', exact: true });
  await width.fill('1.2');
  await width.press('Enter');
  await page.getByRole('radio', { name: 'Detect', exact: true }).click();
  const untouched = (await pendingIds(page)).filter((id) => id !== edited);
  await detect(page);
  const kept = await inStore(page, (s) =>
    s.refine!.features.map((f) => ({
      id: f.id,
      state: f.state,
      width: f.feature.type === 'edge' ? f.feature.input.width : null,
    })),
  );
  expect(
    kept.filter((f) => untouched.includes(f.id)),
    'Untouched proposals replaced',
  ).toEqual([]);
  expect(
    kept.find((f) => f.id === edited),
    'Edited proposal kept',
  ).toEqual({
    id: edited,
    state: 'pending',
    width: 1.2,
  });
  expect(
    kept.filter((f) => f.state === 'pending' && f.id !== edited),
    'Fresh unrelated proposals',
  ).toHaveLength(untouched.length);
  expect(
    await frontProposal(page, -1),
    'Fresh bottom front proposal after the edit',
  ).not.toBeNull();

  await clickProposal(page, edited);
  await page.getByRole('button', { name: 'Accept selected' }).click();
  await expect(page.getByText(/1 accepted · \d+ proposed/)).toBeVisible();
  const beforeAcceptRerun = await pendingIds(page);
  await detect(page);
  await expectFreshBottomProposal(page, beforeAcceptRerun);
  expect(
    await inStore(page, (s) =>
      s.refine!.features.filter((f) => f.state === 'accepted').map((f) => f.id),
    ),
  ).toEqual([edited]);
});

async function expectFreshBottomProposal(page: Page, before: string[]) {
  const after = await pendingIds(page);
  expect(
    after.filter((id) => before.includes(id)),
    'Prior pending IDs removed',
  ).toEqual([]);
  const bottom = await frontProposal(page, -1);
  expect(bottom, 'Fresh bottom front proposal present').not.toBeNull();
}

test('a new detection proposes nothing along an accepted edge', async ({ page }) => {
  await openRefine(page);
  await page.getByRole('radio', { name: 'Detect', exact: true }).click();
  await detect(page);
  await clickProposal(page, (await frontProposal(page))!);
  await page.getByRole('button', { name: 'Accept selected' }).click();
  await expect(page.getByText(/1 accepted · \d+ proposed/)).toBeVisible();
  const before = await pendingIds(page);
  await detect(page);
  await expectFreshBottomProposal(page, before);
  // No pending edge lies along the accepted top front edge.
  expect(
    await inStore(page, (s) =>
      s.refine!.features.some((f) => {
        if (f.state !== 'pending' || f.feature.type !== 'edge') return false;
        const points = f.feature.input.segments.flatMap((g) => g.points.map((p) => p.position));
        return points.every((p) => p[1] > 2 && p[2] > 1);
      }),
    ),
  ).toBe(false);
});

test('selects all proposals, dismisses them, and accepts them in one step', async ({ page }) => {
  await openRefine(page);
  await page.getByRole('radio', { name: 'Detect', exact: true }).click();
  const count = await detect(page);
  await page.getByRole('button', { name: 'Select all proposed' }).click();
  await expect.poll(() => inStore(page, (s) => s.refine!.selected.length)).toBe(count);
  await page.getByRole('button', { name: 'Dismiss selected' }).click();
  await expect(page.getByText('0 accepted · 0 proposed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select all proposed' })).toHaveCount(0);

  expect(await detect(page)).toBe(count);
  await page.getByRole('button', { name: 'Select all proposed' }).click();
  await expect.poll(() => inStore(page, (s) => s.refine!.selected.length)).toBe(count);
  // More than 8 selected: no live preview is built, and the preview shows the working surface.
  expect(count).toBeGreaterThan(8);
  const draft = () =>
    inStore(page, (s) => ({ skipped: s.refine!.draftSkipped, built: s.refine!.draft !== null }));
  await expect.poll(draft).toEqual({ skipped: true, built: false });
  const hint = page.getByText('Preview is off while more than 8 are selected.');
  await expect(hint).toBeVisible();
  expect(await previewOffModel(page)).toBeLessThan(1e-4);
  // Pick the four visible edges from the front, then the four visible from the back.
  const selected: string[] = [];
  for (const side of [1, -1]) {
    if (side === -1) {
      await page.getByRole('button', { name: 'Perspective', exact: true }).click();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await expect
        .poll(async () => {
          const left = await screen(page, [-half[0], 0, 0]);
          const right = await screen(page, [half[0], 0, 0]);
          return left.x > right.x;
        })
        .toBe(true);
    }
    const edges = await inEditor(
      page,
      (store, side) =>
        store.useEditor
          .getState()
          .refine!.features.flatMap((f) =>
            f.state === 'pending' &&
            f.feature.type === 'edge' &&
            f.feature.input.segments.every((g) => g.points.every((p) => p.position[2] * side > 1))
              ? [f.id]
              : [],
          ),
      side,
    );
    for (const id of edges) {
      await clickProposal(page, id, selected.length ? selected : undefined);
      selected.push(id);
    }
  }
  expect(selected).toHaveLength(8);
  await expect.poll(draft).toEqual({ skipped: false, built: true });
  await expect(hint).toBeHidden();
  expect(await previewOffModel(page)).toBeGreaterThan(0.01);

  // Add the back face's region to cross the limit by exactly one.
  await clickSurface(page, [0, 0, -half[2]], 'Shift');
  await expect
    .poll(() => inStore(page, (s) => s.refine!.selected.length), { message: 'Nine selected' })
    .toBe(9);
  await expect.poll(draft, { message: 'Preview skips at nine selected' }).toEqual({
    skipped: true,
    built: false,
  });
  expect(await previewOffModel(page), 'Nine selected show the working mesh').toBeLessThan(1e-4);

  await page.getByRole('button', { name: 'Select all proposed' }).click();
  await expect.poll(draft).toEqual({ skipped: true, built: false });
  const before = await steps(page);
  await page.getByRole('button', { name: 'Accept selected' }).click();
  await expect(page.getByText(`${count} accepted · 0 proposed`)).toBeVisible();
  expect(await steps(page)).toEqual({ undo: before.undo + 1, redo: 0 });
  await undo(page);
  await expect(page.getByText(`0 accepted · ${count} proposed`)).toBeVisible();
});

test('Delete does not reach the scene, and Cancel leaves the part as it was', async ({ page }) => {
  await openRefine(page);
  const original = await partMesh(page);
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  expect(await inStore(page, (s) => ({ parts: s.scene.parts.length, tool: s.tool }))).toEqual({
    parts: 1,
    tool: 'refine',
  });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(() => inStore(page, (s) => s.refine)).toBeNull();
  expect(await inStore(page, (s) => s.scene.parts.length)).toBe(1);
  expect(await partMesh(page)).toEqual(original);
});

test('a mode change and Escape keep the work and leaving the tool discards it', async ({
  page,
}) => {
  await openRefine(page);
  const original = await partMesh(page);
  await acceptGuide(page);
  await page.getByRole('radio', { name: 'Brush', exact: true }).click();
  await page.getByRole('radio', { name: 'Edge', exact: true }).click();
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByText('Apply to keep your changes, or Cancel to discard them.'),
  ).toBeVisible();
  expect(await inStore(page, (s) => ({ tool: s.tool, held: !!s.refine }))).toEqual({
    tool: 'refine',
    held: true,
  });
  await page.keyboard.press('v');
  await expect(page.getByText('Refinement discarded. Use Apply to keep it.')).toBeVisible();
  expect(await inStore(page, (s) => ({ tool: s.tool, refine: s.refine }))).toEqual({
    tool: 'select',
    refine: null,
  });
  expect(await partMesh(page)).toEqual(original);
});

test('scene undo and redo after Apply swap the original and refined meshes', async ({ page }) => {
  await openRefine(page);
  const original = await partMesh(page);
  await keepSource(page);
  await acceptGuide(page);
  const past = await inStore(page, (s) => s.past.length);
  expect(past).toBe(0);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => (await partMesh(page)).source).toBe('Refine · Scanned block');
  // Apply is one scene undo step.
  expect(await inStore(page, (s) => s.past.length)).toBe(past + 1);
  const refined = await partMesh(page);
  await page.keyboard.press('Escape');
  await expect.poll(() => inStore(page, (s) => s.tool)).toBe('select');
  await undo(page);
  await expect.poll(() => partMesh(page)).toEqual(original);
  expect(await sourceKept(page), 'Undo restores the source geometry').toMatchObject({
    geometry: true,
    array: true,
    positions: true,
  });
  // A second undo has nothing of the part's left to undo.
  await undo(page);
  expect(await inStore(page, (s) => s.past.length)).toBe(past);
  expect(await sourceKept(page), 'Second undo keeps the source geometry').toMatchObject({
    geometry: true,
    array: true,
    positions: true,
  });
  expect(await partMesh(page)).toEqual(original);
  await redo(page);
  await expect.poll(() => partMesh(page)).toEqual(refined);
});

test('flattens a riveted plate and keeps the rivet', async ({ page }) => {
  await openRefine(page, { scene: plateFixture, view: '7' });
  await page.getByRole('radio', { name: 'Region', exact: true }).click();
  await brushRadius(page, 0.5);
  await paintRivet(page);
  const before = await rivetMeasure(page);
  expect(before.samples).toBeGreaterThan(10);
  await page.getByRole('button', { name: 'Make region' }).click();
  await page.getByRole('radio', { name: 'Flatten', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Keep detail' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
  const after = await rivetMeasure(page);
  expect(after.spread).toBeLessThan(before.spread / 2);
  expect(Math.abs(after.height - before.height)).toBeLessThan(0.02);
});

test('the toolbar has a Refine button with its shortcut', async ({ page }) => {
  await openRefine(page);
  await page.keyboard.press('Escape');
  const button = page.getByTitle('Refine edges and surfaces on a scan (E)');
  await expect(button).toBeVisible();
  await expect(button).toContainText('Refine');
  await expect(button).toContainText('E');
  await button.click();
  await expect(button).toHaveClass(/active/);
  await expect.poll(() => inStore(page, (s) => s.refine?.stage ?? null)).toBe('ready');
});

test('the Refine indexing status distinguishes the gestures that wait from clicks', async ({
  page,
}) => {
  await openRefine(page);
  await inEditor(page, (store) => store.useEditor.setState({ indexingMeshes: 1 }));
  await expect(page.locator('.status-context')).toHaveText(
    'Preparing a dense mesh. Strokes, paint and handle drags wait. Single clicks still work.',
  );
});

/** The first guide's point `index` of segment `segment`, with its lock and the guide's plane. */
const guidePoint = (page: Page, segment = 0, index = 0) =>
  inEditor(
    page,
    (store, [segment, index]) => {
      const f = store.useEditor.getState().refine!.features[0];
      if (f?.feature.type !== 'edge') return null;
      const { plane, segments } = f.feature.input;
      const point = segments[segment].points[index];
      const offPlane = plane
        ? Math.abs(
            [0, 1, 2].reduce(
              (sum, a) => sum + (point.position[a] - plane.origin[a]) * plane.normal[a],
              0,
            ),
          )
        : null;
      return { position: point.position, lock: point.lock ?? null, offPlane };
    },
    [segment, index],
  );

/** Screen position of the move widget's u arrow, once the overlay has drawn it. */
async function uArrow(page: Page) {
  const read = () =>
    page.evaluate(async () => {
      interface Projected {
        x: number;
        y: number;
      }
      interface Arrow {
        name: string;
        matrixWorld: unknown;
        geometry: {
          computeBoundingSphere(): void;
          boundingSphere: {
            center: { clone(): { applyMatrix4(m: unknown): { project(c: unknown): Projected } } };
          };
        };
      }
      interface Node {
        type: string;
        picker?: { translate: { children: Arrow[] } };
      }
      const url = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((url) => url.includes('/@react-three_fiber.js'))!;
      const root = (await import(url))._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const gizmos: Node[] = [];
      root.scene.traverse((o: Node) => {
        if (o.type === 'TransformControlsGizmo') gizmos.push(o);
      });
      const arrow = gizmos[0]?.picker?.translate.children.find((c) => c.name === 'X');
      if (!arrow) return null;
      arrow.geometry.computeBoundingSphere();
      const ndc = arrow.geometry.boundingSphere.center
        .clone()
        .applyMatrix4(arrow.matrixWorld)
        .project(root.camera);
      const box = document.querySelector('canvas')!.getBoundingClientRect();
      return {
        x: box.x + ((ndc.x + 1) * box.width) / 2,
        y: box.y + ((1 - ndc.y) * box.height) / 2,
      };
    });
  await expect.poll(read, { timeout: 15000 }).not.toBeNull();
  return (await read())!;
}

/** A plane through three clicks on the block's top face, seen from above. */
async function topPlane(page: Page) {
  await page.getByRole('combobox', { name: 'Plane' }).selectOption('points');
  // The panel and the status line both say what the session waits for.
  await expect(page.locator('.refine-picking')).toContainText('Click 3 points on the part');
  await expect(page.locator('.status-context')).toHaveText(
    'Click 3 points on the part for the plane. 0 of 3 picked. Esc stops picking.',
  );
  for (const p of [
    [-2, half[1], -1],
    [2, half[1], -1],
    [0, half[1], 1],
  ] as Vec3[])
    await clickSurface(page, p);
  await expect.poll(() => inStore(page, (s) => s.refine!.planes.length)).toBe(1);
}

test('right-click on a guide point opens its menu, which fixes it', async ({ page }) => {
  await openRefine(page);
  await clickSurface(page, crest(-3));
  await clickSurface(page, crest(3));
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  const spot = await screen(page, (await guidePoint(page, 0, 1))!.position);
  await page.mouse.click(spot.x, spot.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Guide point actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Unlock' })).toBeDisabled();
  await menu.getByRole('menuitem', { name: 'Fixed' }).click();
  await expect(menu).toBeHidden();
  await expect.poll(async () => (await guidePoint(page, 0, 1))?.lock).toEqual({ kind: 'fixed' });
});

test('the move widget moves a point on a plane, and it stays in the plane', async ({ page }) => {
  await openRefine(page, { view: '7' });
  await topPlane(page);
  for (const p of [
    [-1, half[1], 0],
    [1, half[1], 0],
  ] as Vec3[])
    await clickSurface(page, p);
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  const before = (await guidePoint(page, 0, 1))!;
  expect(before.offPlane).toBeLessThan(1e-9);
  // A click on the point chooses it and shows its widget.
  const spot = await screen(page, before.position);
  await page.mouse.click(spot.x, spot.y);
  await expect.poll(() => inStore(page, (s) => s.refine!.chosenPoint?.index)).toBe(1);
  // The u arrow of the widget, where the gizmo drew it, toward the camera.
  const grip = await uArrow(page);
  const undo = await inStore(page, (s) => s.refine!.undo.length);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  // Along the arrow, away from the point.
  const away = Math.sign(grip.x - spot.x) || 1;
  await page.mouse.move(grip.x + 30 * away, grip.y, { steps: 6 });
  await page.mouse.move(grip.x + 60 * away, grip.y, { steps: 6 });
  await page.mouse.up();
  const after = (await guidePoint(page, 0, 1))!;
  expect(Math.abs(after.position[0] - before.position[0])).toBeGreaterThan(0.1);
  expect(Math.abs(after.position[2] - before.position[2])).toBeLessThan(0.05);
  expect(after.offPlane).toBeLessThan(1e-9);
  // One drag is one step.
  expect(await inStore(page, (s) => s.refine!.undo.length)).toBe(undo + 1);
  expect(
    await inStore(
      page,
      (s) =>
        s.refine!.features[0].feature.type === 'edge' &&
        s.refine!.features[0].feature.input.segments[0].points.length,
    ),
  ).toBe(2);
});

test('a Parallel constraint holds through a drag, and its icon deletes it', async ({ page }) => {
  await openRefine(page, { view: '7' });
  await topPlane(page);
  const y = half[1];
  const [a, b, c, d]: Vec3[] = [
    [-1, y, 1],
    [-1, y, -1],
    [1, y, -1],
    [1.3, y, 1.1],
  ];
  for (const p of [a, b, c, d]) await clickSurface(page, p);
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  // The first line's menu, then Parallel, then a click on the third line.
  const first = await screen(page, [-1, y, 0]);
  await page.mouse.click(first.x, first.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Guide segment actions' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Parallel' }).click();
  await expect(page.locator('.refine-picking')).toContainText(
    'Click the other segment of the guide.',
  );
  await expect(page.locator('.status-context')).toContainText(
    'Click the other segment of the guide.',
  );
  await clickSurface(page, [(c[0] + d[0]) / 2, y, (c[2] + d[2]) / 2]);
  const parallelism = () =>
    inStore(page, (s) => {
      const f = s.refine!.features[0];
      if (f.feature.type !== 'edge') return null;
      const { segments, constraints } = f.feature.input;
      const dir = (i: number) => {
        const [p, q] = segments[i].points.map((point) => point.position);
        const v = [0, 1, 2].map((k) => q[k] - p[k]);
        const l = Math.hypot(...v);
        return v.map((x) => x / l);
      };
      const [u, w] = [dir(0), dir(2)];
      const cross = Math.hypot(
        u[1] * w[2] - u[2] * w[1],
        u[2] * w[0] - u[0] * w[2],
        u[0] * w[1] - u[1] * w[0],
      );
      return { kinds: (constraints ?? []).map((k) => k.kind), cross };
    });
  await expect.poll(async () => (await parallelism())?.kinds).toEqual(['parallel']);
  expect((await parallelism())!.cross).toBeLessThan(1e-6);
  // Dragging the last point keeps the lines parallel.
  const before = (await guidePoint(page, 2, 1))!.position;
  await drag(page, [d, [1.8, y, 0.4]]);
  const after = (await guidePoint(page, 2, 1))!;
  expect(Math.hypot(after.position[0] - before[0], after.position[2] - before[2])).toBeGreaterThan(
    0.1,
  );
  expect(after.offPlane).toBeLessThan(1e-9);
  expect((await parallelism())!.cross).toBeLessThan(1e-6);
  // Its icon's menu deletes it.
  const icon = page.getByRole('img', { name: 'Parallel constraint' });
  await expect(icon).toBeVisible({ timeout: 15000 });
  await icon.click({ button: 'right' });
  const iconMenu = page.getByRole('menu', { name: 'Constraint actions' });
  await expect(iconMenu).toBeVisible();
  await iconMenu.getByRole('menuitem', { name: 'Delete constraint' }).click();
  await expect.poll(async () => (await parallelism())?.kinds).toEqual([]);
});

test('cleans the whole part, steps back, then cleans a painted area and applies', async ({
  page,
}) => {
  await openRefine(page, { scene: plateFixture, view: '7' });
  const original = await partMesh(page);
  await page.getByRole('radio', { name: 'Clean', exact: true }).click();
  const clean = page.getByRole('button', { name: 'Clean surface' });
  const setting = async (name: string, percent: number) => {
    const field = page.getByRole('spinbutton', { name, exact: true });
    await field.fill(String(percent));
    await field.press('Enter');
  };
  const run = async () => {
    await clean.click();
    await expect.poll(() => inStore(page, (s) => s.refine!.clean.running)).toBe(false);
  };
  const before = await rivetMeasure(page);
  // Smooth alone evens out the plate's ripple.
  await setting('Sharpen', 0);
  await setting('Depth', 0);
  await expect
    .poll(() => inStore(page, (s) => s.refine!.clean))
    .toMatchObject({ smooth: 0.5, sharpen: 0, depth: 0 });
  await run();
  expect(await steps(page)).toEqual({ undo: 1, redo: 0 });
  expect((await rivetMeasure(page)).spread).toBeLessThan(before.spread / 2);
  await undo(page);
  expect(await steps(page)).toEqual({ undo: 0, redo: 1 });
  expect(await rivetMeasure(page)).toEqual(before);
  // Depth alone raises the rivet off the plate.
  await setting('Smooth', 0);
  await setting('Depth', 150);
  await expect.poll(() => inStore(page, (s) => s.refine!.clean.depth)).toBe(1.5);
  await run();
  expect((await rivetMeasure(page)).height).toBeGreaterThan(1.1 * before.height);
  await undo(page);

  await page.getByRole('radio', { name: 'Painted area', exact: true }).click();
  await expect(clean).toBeDisabled();
  await brushRadius(page, 0.5);
  await paintRivet(page);
  await expect(clean).toBeEnabled();
  // Each paint stroke is a step of its own; the clean is one more.
  const painted = (await steps(page)).undo;
  await run();
  expect(await steps(page)).toEqual({ undo: painted + 1, redo: 0 });
  expect((await rivetMeasure(page)).height).toBeGreaterThan(1.1 * before.height);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => (await partMesh(page)).sum).not.toBe(original.sum);
  expect((await partMesh(page)).source).toBe(`Refine · ${original.source}`);
});

test('squares the rounded edges of a plate and applies', async ({ page }) => {
  await openRefine(page, { scene: plateFixture, view: '7' });
  const original = await partMesh(page);
  await page.getByRole('radio', { name: 'Clean', exact: true }).click();
  const setting = async (name: string, percent: number) => {
    const field = page.getByRole('spinbutton', { name, exact: true });
    await field.fill(String(percent));
    await field.press('Enter');
  };
  const triangles = () => inStore(page, (s) => s.refine!.model!.mesh.triangleCount);
  const before = await triangles();
  await setting('Sharpen', 0);
  await setting('Depth', 0);
  await setting('Square', 100);
  await expect
    .poll(() => inStore(page, (s) => s.refine!.clean))
    .toMatchObject({ smooth: 0.5, sharpen: 0, depth: 0, square: 1 });
  await page.getByRole('button', { name: 'Clean surface' }).click();
  await expect.poll(() => inStore(page, (s) => s.refine!.clean.running)).toBe(false);
  // The rebuilt corners are cut into the surface along their new edges.
  expect(await steps(page)).toEqual({ undo: 1, redo: 0 });
  expect(await triangles()).toBeGreaterThan(before);
  await undo(page);
  expect(await triangles()).toBe(before);
  await redo(page);
  await expect.poll(triangles).toBeGreaterThan(before);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => (await partMesh(page)).sum).not.toBe(original.sum);
});
