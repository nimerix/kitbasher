import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry, PlaneGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';
import { fixture, inStore, openScene, screen } from './helpers/refine';
import { failOnBrowserErrors } from './helpers/warp-grid';
import { readSavedScene } from './saved-scene';

failOnBrowserErrors();

const block = {
  ...fixture,
  parts: [
    {
      ...fixture.parts[0],
      name: 'Coarse block',
      source: 'block.stl',
      geometry: serializeGeometry(new BoxGeometry(8, 6, 4)),
    },
  ],
};

async function openSculpt(page: Page, scene = block) {
  await openScene(page, scene);
  await page.locator('.part-select[title="Coarse block"]').click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page
    .getByRole('toolbar', { name: 'Assembly tools' })
    .getByRole('button', { name: /^Sculpt\b/ })
    .click();
}

const mesh = (page: Page) =>
  inStore(page, (state) => {
    const geometry = state.scene.parts[0].geometry;
    const positions = geometry.getAttribute('position');
    let peak = -Infinity;
    for (let i = 0; i < positions.count; i++) peak = Math.max(peak, positions.getZ(i));
    return {
      positions: Array.from(positions.array),
      indices: geometry.index ? Array.from(geometry.index.array) : null,
      triangles: (geometry.index?.count ?? positions.count) / 3,
      peak,
    };
  });

async function penTap(page: Page, pressure: number) {
  const point = await screen(page, [1, 0, 2]);
  const session = await page.context().newCDPSession(page);
  try {
    const sample = { ...point, pointerType: 'pen' as const, button: 'left' as const };
    await session.send('Input.dispatchMouseEvent', {
      ...sample,
      type: 'mousePressed',
      buttons: 1,
      force: pressure,
    });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await session.send('Input.dispatchMouseEvent', {
      ...sample,
      type: 'mouseReleased',
      buttons: 0,
    });
  } finally {
    await session.detach();
  }
}

test('only sculpts the selected part when its surface is visible under the tip', async ({
  page,
}) => {
  await openSculpt(page, {
    ...block,
    parts: [block.parts[0], { ...block.parts[0], id: 'cover', name: 'Cover', position: [0, 0, 6] }],
  });
  const before = await mesh(page);
  await penTap(page, 0.9);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await mesh(page)).toEqual(before);
  await page.getByRole('button', { name: 'Hide Cover' }).click();
  await penTap(page, 0.9);
  await expect.poll(async () => (await mesh(page)).peak).toBeGreaterThan(before.peak);
});

test('commits a released stroke before a tool change in the same frame', async ({ page }) => {
  await openSculpt(page);
  const before = await mesh(page);
  const point = await screen(page, [1, 0, 2]);
  await page.evaluate(async (spot) => {
    const storeUrl = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!;
    const { useEditor } = await import(storeUrl);
    const canvas = document.querySelector('canvas')!;
    const event = {
      clientX: spot.x,
      clientY: spot.y,
      pointerId: 42,
      pointerType: 'pen',
      isPrimary: true,
      bubbles: true,
    };
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...event, buttons: 1, pressure: 0.8 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', event));
    useEditor.getState().setTool('select');
  }, point);
  expect((await mesh(page)).peak).toBeGreaterThan(before.peak);
});

test('queues another press and mask changes while a released stroke finishes', async ({ page }) => {
  await openSculpt(page);
  const first = await screen(page, [-1, 0, 2]);
  const second = await screen(page, [1, 0, 2]);
  await page.evaluate(
    ({ first, second }) => {
      const canvas = document.querySelector('canvas')!;
      const now = performance.now.bind(performance);
      let elapsed = now();
      // Force the released-stroke path regardless of the test machine's speed.
      performance.now = () => (elapsed += 8);
      try {
        for (const point of [first, second]) {
          const pen = {
            pointerId: 24,
            isPrimary: true,
            pointerType: 'pen',
            pressure: 0.8,
            bubbles: true,
            clientX: point.x,
            clientY: point.y,
          };
          canvas.dispatchEvent(new PointerEvent('pointerdown', { ...pen, buttons: 1 }));
          canvas.dispatchEvent(new PointerEvent('pointerup', pen));
        }
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const invert = Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === 'Invert mask',
        );
        if (!invert) throw new Error('Missing Invert mask button');
        invert.click();
      } finally {
        performance.now = now;
      }
    },
    { first, second },
  );
  await expect
    .poll(() =>
      inStore(page, (state) => {
        const past = state.sculpt?.past ?? [];
        return {
          strokes: past.filter((step) => step.before.geometry !== step.after.geometry).length,
          mask: state.sculpt?.mask?.every((weight) => weight === 1),
        };
      }),
    )
    .toEqual({ strokes: 2, mask: true });
});

test('cancels a held queued press and preserves the released stroke through part edits', async ({
  page,
}) => {
  await openSculpt(page);
  const point = await screen(page, [1, 0, 2]);
  await page.evaluate(async (point) => {
    const storeUrl = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!;
    const { useEditor } = await import(storeUrl);
    const canvas = document.querySelector('canvas')!;
    const now = performance.now.bind(performance);
    let elapsed = now();
    performance.now = () => (elapsed += 8);
    const pen = {
      clientX: point.x,
      clientY: point.y,
      pointerId: 24,
      isPrimary: true,
      pointerType: 'pen',
      pressure: 0.8,
      bubbles: true,
    };
    const press = () =>
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...pen, buttons: 1 }));
    const release = () => canvas.dispatchEvent(new PointerEvent('pointerup', pen));
    try {
      press();
      release();
      press();
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      release();
      for (const event of ['keydown', 'keyup']) {
        document.body.dispatchEvent(
          new KeyboardEvent(event, { key: ' ', code: 'Space', bubbles: true }),
        );
      }
      useEditor.getState().patchParts(['block'], { name: 'Renamed after release' });
      useEditor.getState().setView({ explode: 50 });
    } finally {
      performance.now = now;
    }
  }, point);
  await expect
    .poll(() =>
      inStore(page, (state) => [
        state.sculpt?.past.length,
        state.temporaryOrbit,
        state.scene.parts[0].name,
        state.view.explode,
      ]),
    )
    .toEqual([1, false, 'Renamed after release', 50]);
});

test('restores the committed mesh when a replayed preview is cancelled', async ({ page }) => {
  await openSculpt(page);
  const point = await screen(page, [1, 0, 2]);
  await page.evaluate((point) => {
    const canvas = document.querySelector('canvas')!;
    const now = performance.now.bind(performance);
    let elapsed = now();
    performance.now = () => (elapsed += 8);
    const pen = {
      clientX: point.x,
      clientY: point.y,
      isPrimary: true,
      pointerType: 'pen',
      pressure: 0.8,
      bubbles: true,
    };
    try {
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...pen, pointerId: 40, buttons: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...pen, pointerId: 40 }));
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...pen, pointerId: 41, buttons: 1 }));
    } finally {
      performance.now = now;
    }
  }, point);
  const previewState = () =>
    page.evaluate(async () => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const { partMeshes } = await import(
        urls.find((url) => /\/src\/xr\/part-meshes\.ts/.test(url))!
      );
      const { useEditor } = await import(urls.find((url) => /\/src\/core\/store\.ts/.test(url))!);
      const state = useEditor.getState();
      return {
        strokes: state.sculpt?.past.length,
        committed: partMeshes.get('block').geometry === state.scene.parts[0].geometry,
      };
    });
  await expect.poll(previewState).toEqual({ strokes: 1, committed: false });
  await page.keyboard.press('Escape');
  await expect.poll(previewState).toEqual({ strokes: 1, committed: true });
});

test('runs a queued undo after saving a released stroke', async ({ page }) => {
  await openSculpt(page);
  const before = await mesh(page);
  const point = await screen(page, [1, 0, 2]);
  const downloading = page.waitForEvent('download');
  await page.evaluate((point) => {
    const canvas = document.querySelector('canvas')!;
    const now = performance.now.bind(performance);
    let elapsed = now();
    performance.now = () => (elapsed += 8);
    try {
      const pen = {
        clientX: point.x,
        clientY: point.y,
        pointerId: 29,
        isPrimary: true,
        pointerType: 'pen',
        pressure: 0.8,
        bubbles: true,
      };
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...pen, buttons: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', pen));
      document.querySelector<HTMLButtonElement>('button[aria-label="Save scene"]')!.click();
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'z',
          code: 'KeyZ',
          ctrlKey: !navigator.platform.includes('Mac'),
          metaKey: navigator.platform.includes('Mac'),
          bubbles: true,
          cancelable: true,
        }),
      );
    } finally {
      performance.now = now;
    }
  }, point);
  await downloading;
  await expect.poll(() => inStore(page, (state) => state.sculpt?.future.length)).toBe(1);
  expect(await mesh(page)).toEqual(before);
});

test('keeps Undo ahead of a mask edit queued behind Save', async ({ page }) => {
  await openSculpt(page);
  const before = await mesh(page);
  const point = await screen(page, [1, 0, 2]);
  const downloading = page.waitForEvent('download');
  await page.evaluate((point) => {
    const canvas = document.querySelector('canvas')!;
    const now = performance.now.bind(performance);
    let elapsed = now();
    performance.now = () => (elapsed += 8);
    try {
      const pen = {
        clientX: point.x,
        clientY: point.y,
        pointerId: 29,
        isPrimary: true,
        pointerType: 'pen',
        pressure: 0.8,
        bubbles: true,
      };
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...pen, buttons: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', pen));
      document.querySelector<HTMLButtonElement>('button[aria-label="Save scene"]')!.click();
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'z',
          code: 'KeyZ',
          ctrlKey: !navigator.platform.includes('Mac'),
          metaKey: navigator.platform.includes('Mac'),
          bubbles: true,
          cancelable: true,
        }),
      );
      const invert = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Invert mask',
      );
      if (!invert) throw new Error('Missing Invert mask button');
      invert.click();
    } finally {
      performance.now = now;
    }
  }, point);
  await downloading;
  await expect
    .poll(() => inStore(page, (state) => state.sculpt?.mask?.every((weight) => weight === 1)))
    .toBe(true);
  expect(await mesh(page)).toEqual(before);
});

test('preserves Undo behind Save after leaving Sculpt', async ({ page }) => {
  await openSculpt(page);
  const before = await mesh(page);
  const point = await screen(page, [1, 0, 2]);
  const downloading = page.waitForEvent('download');
  await page.evaluate(async (point) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(urls.find((url) => /\/src\/core\/store\.ts/.test(url))!);
    const canvas = document.querySelector('canvas')!;
    const now = performance.now.bind(performance);
    let elapsed = now();
    performance.now = () => (elapsed += 8);
    try {
      const pen = {
        clientX: point.x,
        clientY: point.y,
        pointerId: 29,
        isPrimary: true,
        pointerType: 'pen',
        pressure: 0.8,
        bubbles: true,
      };
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...pen, buttons: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', pen));
      useEditor.getState().setTool('select');
      document.querySelector<HTMLButtonElement>('button[aria-label="Save scene"]')!.click();
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'z',
          code: 'KeyZ',
          ctrlKey: !navigator.platform.includes('Mac'),
          metaKey: navigator.platform.includes('Mac'),
          bubbles: true,
          cancelable: true,
        }),
      );
    } finally {
      performance.now = now;
    }
  }, point);
  await downloading;
  await expect.poll(() => inStore(page, (state) => state.tool)).toBe('select');
  await expect.poll(() => inStore(page, (state) => state.future.length)).toBe(1);
  await expect.poll(() => mesh(page)).toEqual(before);
});

test('cancels a held press queued behind a busy save after the released stroke detaches', async ({
  page,
}) => {
  await openSculpt(page);
  const point = await screen(page, [1, 0, 2]);
  await page.evaluate(async (point) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor, afterReleasedSculpt } = await import(
      urls.find((url) => /\/src\/core\/store\.ts/.test(url))!
    );
    const canvas = document.querySelector('canvas')!;
    const now = performance.now.bind(performance);
    let elapsed = now();
    const pen = {
      clientX: point.x,
      clientY: point.y,
      pointerType: 'pen',
      isPrimary: true,
      pressure: 0.8,
      bubbles: true,
    };
    performance.now = () => (elapsed += 8);
    try {
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...pen, pointerId: 40, buttons: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...pen, pointerId: 40 }));
      afterReleasedSculpt(() => useEditor.getState().setBusy('Preparing scene file…'));
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...pen, pointerId: 41, buttons: 1 }));
    } finally {
      performance.now = now;
    }
  }, point);
  await expect
    .poll(() => inStore(page, (state) => [state.busy, state.sculpt?.past.length]))
    .toEqual(['Preparing scene file…', 1]);
  await page.keyboard.press('Escape');
  await page.evaluate(async (point) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor, afterReleasedSculpt } = await import(
      urls.find((url) => /\/src\/core\/store\.ts/.test(url))!
    );
    document.querySelector('canvas')!.dispatchEvent(
      new PointerEvent('pointerup', {
        clientX: point.x,
        clientY: point.y,
        pointerType: 'pen',
        pointerId: 41,
        isPrimary: true,
        bubbles: true,
      }),
    );
    afterReleasedSculpt(() =>
      useEditor.getState().patchParts(['block'], { name: 'Queue settled' }),
    );
    useEditor.getState().setBusy(null);
  }, point);
  await expect
    .poll(() => inStore(page, (state) => [state.scene.parts[0].name, state.sculpt?.past.length]))
    .toEqual(['Queue settled', 1]);
});

for (const queueUndo of [false, true]) {
  test(
    queueUndo
      ? 'runs Undo after Free Transform closes when both follow a released stroke'
      : 'takes the free-transform baseline after a released stroke commits',
    async ({ page }) => {
      await openSculpt(page);
      const before = await mesh(page);
      const point = await screen(page, [1, 0, 2]);
      await page.evaluate(
        ({ point, queueUndo }) => {
          const now = performance.now.bind(performance);
          let elapsed = now();
          performance.now = () => (elapsed += 8);
          try {
            const canvas = document.querySelector('canvas')!;
            const pen = {
              clientX: point.x,
              clientY: point.y,
              pointerType: 'pen',
              pointerId: 40,
              isPrimary: true,
              pressure: 0.8,
              bubbles: true,
            };
            canvas.dispatchEvent(new PointerEvent('pointerdown', { ...pen, buttons: 1 }));
            canvas.dispatchEvent(new PointerEvent('pointerup', pen));
            window.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'G', code: 'KeyG', shiftKey: true }),
            );
            if (queueUndo)
              window.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true }),
              );
          } finally {
            performance.now = now;
          }
        },
        { point, queueUndo },
      );
      await expect(page.locator('.free-transform-prompt')).toBeVisible();
      const sculpted = await mesh(page);
      expect(sculpted.triangles).toBeGreaterThan(before.triangles);
      await page.keyboard.press('Escape');
      await expect.poll(() => inStore(page, (state) => Boolean(state.freeTransform))).toBe(false);
      if (queueUndo) {
        await expect.poll(() => mesh(page)).toEqual(before);
        expect(await inStore(page, (state) => [state.past.length, state.future.length])).toEqual([
          0, 1,
        ]);
        await page.keyboard.press('ControlOrMeta+Shift+Z');
        await expect.poll(() => mesh(page)).toEqual(sculpted);
      } else {
        expect(await mesh(page)).toEqual(sculpted);
      }
    },
  );
}

test('fills the path of a fast small-brush pen sweep in one undo step', async ({ page }) => {
  await openSculpt(page, {
    ...block,
    parts: [
      {
        ...block.parts[0],
        geometry: serializeGeometry(new PlaneGeometry(8, 6, 160, 120).translate(0, 0, 2)),
      },
    ],
  });
  const radius = page.getByRole('spinbutton', { name: 'Radius', exact: true });
  await radius.fill('0.12');
  await radius.press('Enter');
  const start = await screen(page, [-2, 0, 2]);
  const end = await screen(page, [2, 0, 2]);
  await page.evaluate(
    ({ start, end }) => {
      const canvas = document.querySelector('canvas')!;
      const pen = {
        pointerId: 17,
        isPrimary: true,
        pointerType: 'pen',
        pressure: 0.8,
        bubbles: true,
      };
      canvas.dispatchEvent(
        new PointerEvent('pointerdown', { ...pen, clientX: start.x, clientY: start.y, buttons: 1 }),
      );
      canvas.dispatchEvent(
        new PointerEvent('pointermove', { ...pen, clientX: end.x, clientY: end.y, buttons: 1 }),
      );
      canvas.dispatchEvent(
        new PointerEvent('pointerup', { ...pen, clientX: end.x, clientY: end.y }),
      );
    },
    { start, end },
  );
  await expect
    .poll(() =>
      inStore(page, (state) => {
        const positions = state.scene.parts[0].geometry.getAttribute('position');
        const covered = new Set<number>();
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i);
          if (x >= -2 && x < 2 && positions.getZ(i) > 2 + 1e-5)
            covered.add(Math.floor((x + 2) * 10));
        }
        return [covered.size, state.sculpt?.past.length];
      }),
    )
    .toEqual([40, 1]);
});

test('draws into a coarse face with pen pressure and undoes topology with displacement', async ({
  page,
}) => {
  await openSculpt(page);
  const before = await mesh(page);
  await penTap(page, 0.25);
  await expect.poll(async () => (await mesh(page)).peak).toBeGreaterThan(before.peak);
  const light = await mesh(page);
  expect(light.triangles).toBeGreaterThan(before.triangles);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => mesh(page)).toEqual(before);
  await penTap(page, 0.9);
  await expect.poll(async () => (await mesh(page)).peak).toBeGreaterThan(light.peak);
  const heavy = await mesh(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => mesh(page)).toEqual(before);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => mesh(page)).toEqual(heavy);
});

test('cancels an active stroke and reopens the completed stroke from disk', async ({ page }) => {
  await openSculpt(page);
  const before = await mesh(page);
  const point = await screen(page, [1, 0, 2]);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 12, point.y, { steps: 3 });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const url = performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((url) => /\/src\/xr\/part-meshes\.ts(?:\?.*)?$/.test(url))!;
        const { partMeshes } = await import(url);
        const geometry = partMeshes.get('block').geometry;
        return Math.min(
          geometry.drawRange.count,
          geometry.index?.count ?? geometry.getAttribute('position').count,
        );
      }),
    )
    .toBeGreaterThan(before.triangles * 3);
  expect(await mesh(page)).toEqual(before);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await mesh(page)).toEqual(before);
  expect(await inStore(page, (state) => state.sculpt?.past.length)).toBe(0);
  await penTap(page, 0.8);
  await expect.poll(async () => (await mesh(page)).triangles).toBeGreaterThan(before.triangles);
  const completed = await mesh(page);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const file = await readSavedScene((await (await downloading).path())!);
  const oldGeometry = await inStore(page, (state) => state.scene.parts[0].geometry.uuid);
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'sculpt.kitbash',
    mimeType: 'application/octet-stream',
    buffer: file.bytes,
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await expect
    .poll(() => inStore(page, (state) => state.scene.parts[0].geometry.uuid))
    .not.toBe(oldGeometry);
  await expect.poll(() => mesh(page)).toEqual(completed);
});

test('a fully inverted mask protects the coarse surface until cleared', async ({ page }) => {
  await openSculpt(page);
  const before = await mesh(page);
  await page.getByRole('button', { name: 'Mask', exact: true }).click();
  await page.getByRole('button', { name: /invert mask/i }).click();
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await penTap(page, 0.9);
  expect(await mesh(page)).toEqual(before);
  await page.getByRole('button', { name: 'Mask', exact: true }).click();
  await page.getByRole('button', { name: /clear mask/i }).click();
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await penTap(page, 0.9);
  await expect.poll(async () => (await mesh(page)).peak).toBeGreaterThan(before.peak);
});

test('mask paint subdivides without displacement and restores weights with undo and redo', async ({
  page,
}) => {
  await openSculpt(page);
  const before = await mesh(page);
  const weights = () => inStore(page, (state) => Array.from(state.sculpt?.mask ?? []));
  await page.getByRole('button', { name: 'Mask', exact: true }).click();
  await penTap(page, 0.8);
  await expect.poll(async () => (await weights()).some((weight) => weight > 0)).toBe(true);
  const painted = await mesh(page);
  expect(painted.triangles).toBeGreaterThan(before.triangles);
  expect(painted.peak).toEqual(before.peak);
  const protection = await weights();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => mesh(page)).toEqual(before);
  expect(await weights()).toEqual([]);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => mesh(page)).toEqual(painted);
  expect(await weights()).toEqual(protection);
});

test('applies Clay Buildup and Inflate and keeps their falloff settings independent', async ({
  page,
}) => {
  await openSculpt(page);
  const before = await mesh(page);
  const falloff = page.getByRole('combobox', { name: 'Falloff' });
  await page.getByText('Advanced brush settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Clay Buildup', exact: true }).click();
  await falloff.selectOption('hard');
  await penTap(page, 0.9);
  await expect.poll(async () => (await mesh(page)).peak).toBeGreaterThan(before.peak);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => mesh(page)).toEqual(before);
  await page.getByRole('button', { name: 'Inflate/Deflate', exact: true }).click();
  await expect(falloff).toHaveValue('soft');
  await penTap(page, 0.9);
  await expect.poll(async () => (await mesh(page)).peak).toBeGreaterThan(before.peak);
  await page.getByRole('button', { name: 'Clay Buildup', exact: true }).click();
  await expect(falloff).toHaveValue('hard');
  await page.getByRole('button', { name: 'Reset brush settings' }).click();
  await expect(falloff).toHaveValue('soft');
});
