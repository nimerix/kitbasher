import { expect, test, type Page } from '@playwright/test';
import { failOnBrowserErrors } from './helpers/warp-grid';
import {
  chainStraightness,
  clickSurface,
  crest,
  drag,
  half,
  inEditor,
  inStore,
  openRefine,
  plate,
  plateFixture,
  proposalSpot,
  screen,
  surfaceCorner,
} from './helpers/refine';
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

/** The id of the detected pending edge along the top front edge. */
const topFrontProposal = (page: Page) =>
  inStore(page, (s) => {
    const found = s.refine!.features.find((f) => {
      if (f.state !== 'pending' || f.feature.type !== 'edge') return false;
      const points = f.feature.input.segments.flatMap((g) => g.points.map((p) => p.position));
      return (
        points.every((p) => p[1] > 2 && p[2] > 1) && Math.abs(points[0][0] - points.at(-1)![0]) > 4
      );
    });
    return found?.id ?? null;
  });

/** Clicks a pending proposal where its curve is drawn and waits until it alone is selected. */
async function clickProposal(page: Page, id: string) {
  const spot = await screen(page, await proposalSpot(page, id));
  await page.mouse.click(spot.x, spot.y);
  await expect.poll(() => inStore(page, (s) => s.refine!.selected)).toEqual([id]);
}

test('guides a straight edge, accepts it and applies it', async ({ page }) => {
  await openRefine(page);
  await clickSurface(page, crest(-3));
  await clickSurface(page, crest(3));
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
  await page.getByRole('button', { name: 'Apply' }).click();
  const part = await inStore(page, (s) => ({
    source: s.scene.parts[0].source,
    past: s.past.length,
  }));
  expect(part.source).toBe('Refine · Scanned block');
  expect(await chainStraightness(page)).toBeLessThan(0.02);
});

test('places an arc', async ({ page }) => {
  await openRefine(page);
  await page.getByRole('radio', { name: 'Arc', exact: true }).click();
  for (const x of [-2, 0, 2]) await clickSurface(page, crest(x));
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
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
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(page.getByText(`${i + 1} accepted · 0 proposed`)).toBeVisible();
  }
  expect(await inStore(page, (s) => s.refine!.model !== s.refine!.start)).toBe(true);
  await expect(page.getByRole('button', { name: 'Apply' })).toBeEnabled();
});

test('strokes with each brush', async ({ page }) => {
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

  await brushRadius(page, 0.5);
  for (const kind of ['Flatten', 'Smooth']) {
    before = (await steps(page)).undo;
    await page.getByRole('radio', { name: kind, exact: true }).click();
    await drag(page, [front(-2, 0), front(2, 0)], 30);
    await expect.poll(async () => (await steps(page)).undo).toBe(before + 1);
  }
  expect(await inStore(page, (s) => s.refine!.model !== s.refine!.start)).toBe(true);
});

test('detects, adjusts a proposal and accepts it', async ({ page }) => {
  await openRefine(page);
  await page.getByRole('radio', { name: 'Detect' }).click();
  await page.getByRole('button', { name: 'Find edges and surfaces' }).click();
  await expect(page.getByText(/0 accepted · [1-9]\d* proposed/)).toBeVisible();
  const before = await inStore(
    page,
    (s) => s.scene.parts[0].geometry.getAttribute('position').count,
  );
  const id = (await topFrontProposal(page))!;
  expect(id).not.toBeNull();
  await clickProposal(page, id);
  // A proposal is adjusted like a hand-placed guide, with Edge mode's controls.
  await page.getByRole('radio', { name: 'Edge', exact: true }).click();
  await page.getByRole('switch', { name: 'Choose width automatically' }).click();
  const width = page.getByRole('spinbutton', { name: 'Width', exact: true });
  await width.fill('1.2');
  await width.press('Enter');
  await expect
    .poll(() =>
      inStore(page, (s) => {
        const f = s.refine!.features.find(
          (f) =>
            f.state === 'pending' && f.feature.type === 'edge' && s.refine!.selected.includes(f.id),
        );
        return f?.feature.type === 'edge' ? f.feature.input.width : null;
      }),
    )
    .toBe(1.2);
  await page.getByRole('radio', { name: 'Detect', exact: true }).click();
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

test('scene undo after Apply restores the original mesh', async ({ page }) => {
  await openRefine(page);
  const original = await partMesh(page);
  await acceptGuide(page);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => (await partMesh(page)).source).toBe('Refine · Scanned block');
  await page.keyboard.press('Escape');
  await expect.poll(() => inStore(page, (s) => s.tool)).toBe('select');
  await undo(page);
  await expect.poll(() => partMesh(page)).toEqual(original);
});

test('says so when a guide finds no edge', async ({ page }) => {
  await openRefine(page);
  await clickSurface(page, front(-2, 0));
  await clickSurface(page, front(2, 0));
  await expect(page.getByText('No edge found under this guide.')).toBeVisible();
});

test('sets the ends of an open guide and keeps them on accept', async ({ page }) => {
  await openRefine(page);
  await clickSurface(page, crest(-3));
  await clickSurface(page, crest(3));
  const solvedEnds = () =>
    inEditor(page, (store) => {
      const refine = store.useEditor.getState().refine!;
      const f = refine.features.find((f) => f.state === 'pending');
      const solve = f && (store.refineSolved(refine, f) as { ends: string[] } | null);
      return solve ? solve.ends : null;
    });
  await expect.poll(solvedEnds).not.toBeNull();
  const end = page.getByLabel('End of the guide'),
    start = page.getByLabel('Start of the guide');
  await end.selectOption({ label: 'Fade' });
  await start.selectOption({ label: 'Hold' });
  await expect.poll(solvedEnds).toEqual(['hold', 'taper']);
  await end.selectOption({ label: 'Hold' });
  await start.selectOption({ label: 'Fade' });
  await expect.poll(solvedEnds).toEqual(['taper', 'hold']);
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

// The handle lies 0.155 mm under its own guide's previewed sharp edge and must stay reachable.
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

test('Escape during a stroke leaves the session as it was', async ({ page }) => {
  await openRefine(page);
  await page.getByRole('radio', { name: 'Brush', exact: true }).click();
  await page.getByRole('radio', { name: 'Smooth', exact: true }).click();
  // One finished stroke first, so there is an undo step to keep.
  await drag(page, [front(-2, 1), front(2, 1)], 30);
  await expect.poll(async () => (await steps(page)).undo).toBe(1);
  const before = await steps(page);
  await inEditor(page, (store) => {
    (globalThis as { refineModel?: unknown }).refineModel =
      store.useEditor.getState().refine!.model;
  });
  const a = await screen(page, front(-2, -1)),
    b = await screen(page, front(0, -1)),
    c = await screen(page, front(2, -1));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 20 });
  await page.keyboard.press('Escape');
  await page.mouse.move(c.x, c.y, { steps: 10 });
  await page.mouse.up();
  expect(
    await inEditor(
      page,
      (store) =>
        store.useEditor.getState().refine!.model ===
        (globalThis as { refineModel?: unknown }).refineModel,
    ),
  ).toBe(true);
  expect(await steps(page)).toEqual(before);
  expect(await inStore(page, (s) => s.tool)).toBe('refine');
  // The preview shows the model again, with no trace of the stroke.
  const off = await inStore(page, (s) => {
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
  expect(off).toBeLessThan(1e-4);
});

test('a new detection replaces the pending proposals', async ({ page }) => {
  await openRefine(page);
  await page.getByRole('radio', { name: 'Detect', exact: true }).click();
  const pendingIds = () =>
    inStore(page, (s) => s.refine!.features.filter((f) => f.state === 'pending').map((f) => f.id));
  const first = await detect(page);
  expect(first).toBeGreaterThan(0);
  const before = await pendingIds();
  expect(await detect(page)).toBe(first);
  expect((await pendingIds()).filter((id) => before.includes(id))).toEqual([]);

  // A proposal the user edited stays through a new run.
  const edited = (await topFrontProposal(page))!;
  await clickProposal(page, edited);
  await page.getByRole('radio', { name: 'Edge', exact: true }).click();
  await page.getByRole('switch', { name: 'Choose width automatically' }).click();
  const width = page.getByRole('spinbutton', { name: 'Width', exact: true });
  await width.fill('1.2');
  await width.press('Enter');
  await page.getByRole('radio', { name: 'Detect', exact: true }).click();
  const untouched = (await pendingIds()).filter((id) => id !== edited);
  await detect(page);
  const kept = await inStore(page, (s) =>
    s.refine!.features.map((f) => ({
      id: f.id,
      state: f.state,
      width: f.feature.type === 'edge' ? f.feature.input.width : null,
    })),
  );
  expect(kept.filter((f) => untouched.includes(f.id))).toEqual([]);
  expect(kept.find((f) => f.id === edited)).toEqual({ id: edited, state: 'pending', width: 1.2 });

  await clickProposal(page, edited);
  await page.getByRole('button', { name: 'Accept selected' }).click();
  await expect(page.getByText(/1 accepted · \d+ proposed/)).toBeVisible();
  await detect(page);
  expect(
    await inStore(page, (s) =>
      s.refine!.features.filter((f) => f.state === 'accepted').map((f) => f.id),
    ),
  ).toEqual([edited]);
});

test('a new detection proposes nothing along an accepted edge', async ({ page }) => {
  await openRefine(page);
  await page.getByRole('radio', { name: 'Detect', exact: true }).click();
  await detect(page);
  await clickProposal(page, (await topFrontProposal(page))!);
  await page.getByRole('button', { name: 'Accept selected' }).click();
  await expect(page.getByText(/1 accepted · \d+ proposed/)).toBeVisible();
  await detect(page);
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
  // More than 8 selected: no live preview is built.
  expect(await inStore(page, (s) => s.refine!.draftSkipped)).toBe(count > 8);
  await expect(page.getByText('Preview is off while more than 8 are selected.')).toBeVisible();
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

test('a mode change keeps the work and leaving the tool discards it', async ({ page }) => {
  await openRefine(page);
  const original = await partMesh(page);
  await acceptGuide(page);
  await page.getByRole('radio', { name: 'Brush', exact: true }).click();
  await page.getByRole('radio', { name: 'Edge', exact: true }).click();
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
  await page.keyboard.press('Escape');
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
  await acceptGuide(page);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => (await partMesh(page)).source).toBe('Refine · Scanned block');
  const refined = await partMesh(page);
  await page.keyboard.press('Escape');
  await expect.poll(() => inStore(page, (s) => s.tool)).toBe('select');
  await undo(page);
  await expect.poll(() => partMesh(page)).toEqual(original);
  await redo(page);
  await expect.poll(() => partMesh(page)).toEqual(refined);
});

test('flattens a riveted plate and keeps the rivet', async ({ page }) => {
  await openRefine(page, { scene: plateFixture, view: '7' });
  await page.getByRole('radio', { name: 'Region', exact: true }).click();
  await brushRadius(page, 0.5);
  const rivet = plate.rivets.find((r) => r.x === 0 && r.z === 1)!;
  for (const z of [0.4, 0.8, 1.2, 1.6])
    await drag(page, [
      [-1.2, 0.5, z],
      [1.2, 0.5, z],
    ]);
  const measure = () =>
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
  const before = await measure();
  expect(before.samples).toBeGreaterThan(10);
  await page.getByRole('button', { name: 'Make region' }).click();
  await page.getByRole('radio', { name: 'Flatten', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Keep detail' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
  const after = await measure();
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
