import { expect, test, type Page } from '@playwright/test';

test('combines through a real worker while retaining indexed vertices and source data', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  const result = await page.evaluate(async () => {
    const storeUrl = '/src/core/store.ts',
      mergeUrl = '/src/core/merge.ts',
      geometryUrl = '/src/core/geometry.ts';
    const { useEditor } = await import(storeUrl);
    const { deserializeGeometry } = await import(geometryUrl);
    const inputs = useEditor
      .getState()
      .scene.parts.slice(0, 2)
      .map((part: any) => ({
        ...part,
        geometry: deserializeGeometry({
          positions: [
            -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
          ],
          indices: [
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7,
            3, 1, 2, 6, 1, 6, 5,
          ],
        }),
      }));
    const count = (part: any) =>
      part.geometry.index?.count ?? part.geometry.attributes.position.count;
    const triangleVertices = inputs.reduce((sum: number, part: any) => sum + count(part), 0);
    const before = inputs.map((part: any) => part.geometry.attributes.position.array.slice());
    const merged = await (await import(mergeUrl)).mergeParts(inputs, 'combine', 'Combined');
    const result = {
      indices: merged.geometry.index?.count,
      expected: triangleVertices,
      compact: merged.geometry.attributes.position.count < triangleVertices,
      bounds: !!merged.geometry.boundingBox && !!merged.geometry.boundingSphere,
      intact: inputs.every((part: any, i: number) =>
        before[i].every(
          (value: number, j: number) => value === part.geometry.attributes.position.array[j],
        ),
      ),
    };
    merged.geometry.dispose();
    return result;
  });
  expect(result.indices).toBe(result.expected);
  expect(result).toMatchObject({ compact: true, bounds: true, intact: true });
});

async function startControlledMerge(page: Page) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.evaluate(async () => {
    const storeUrl = '/src/core/store.ts';
    const { useEditor } = await import(storeUrl);
    const NativeWorker = window.Worker;
    class ControlledWorker {
      onmessage: null | ((event: { data: unknown }) => void) = null;
      terminated = false;
      postMessage() {
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              type: 'progress',
              progress: { detail: 'Checking closed surface · Detailed scan', progress: null },
            },
          }),
        );
      }
      terminate() {
        this.terminated = true;
      }
    }
    window.Worker = class {
      constructor(url: string | URL, options?: WorkerOptions) {
        if (!String(url).includes('merge.worker')) return new NativeWorker(url, options);
        const worker = new ControlledWorker();
        (window as any).__mergeWorker = worker;
        return worker;
      }
    } as unknown as typeof Worker;
    const ids = useEditor
      .getState()
      .scene.parts.filter((part: any) => !part.locked)
      .slice(0, 2)
      .map((part: any) => part.id);
    useEditor.setState({ selected: ids });
    useEditor.getState().setModal('merge');
  });
  await page.getByRole('button', { name: /^Boolean union/ }).click();
  await page.getByRole('button', { name: 'Merge parts', exact: true }).click();
  await expect(
    page.getByText('Checking closed surface · Detailed scan', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Merge progress' })).not.toHaveAttribute(
    'value',
  );
}

async function sceneParts(page: Page) {
  return page.evaluate(async () => {
    const url = '/src/core/store.ts';
    return (await import(url)).useEditor
      .getState()
      .scene.parts.map((part: any) => ({ id: part.id, name: part.name }));
  });
}

test('shows merge progress in the modal and cancels without applying late worker output', async ({
  page,
}) => {
  await startControlledMerge(page);
  const original = await sceneParts(page);
  await page.getByRole('button', { name: 'Cancel operation', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const status = await page.evaluate(async () => {
    const url = '/src/core/activity.ts';
    const worker = (window as any).__mergeWorker;
    worker.onmessage({ data: { result: null } });
    return {
      terminated: worker.terminated,
      status: (await import(url)).useActivity
        .getState()
        .tasks.find((task: any) => task.title === 'Boolean union').status,
    };
  });
  expect(status).toEqual({ terminated: true, status: 'cancelled' });
  expect(await sceneParts(page)).toEqual(original);
});

test('rejects a finished merge when a source part changed while it was running', async ({
  page,
}) => {
  await startControlledMerge(page);
  const original = await sceneParts(page);
  const changedId = await page.evaluate(async () => {
    const storeUrl = '/src/core/store.ts',
      geometryUrl = '/src/core/geometry.ts',
      transferUrl = '/src/core/geometry-transfer.ts',
      mergeUrl = '/src/core/merge.ts';
    const { useEditor } = await import(storeUrl);
    const geometry = await import(geometryUrl);
    const state = useEditor.getState();
    const source = state.scene.parts.find((part: any) => part.id === state.selected[0]);
    const baked = geometry.bakedPartGeometry(source);
    state.patchParts([source.id], { name: 'Changed during merge' });
    const { geometry: result, ...part } = (await import(mergeUrl)).mergedPart(
      baked,
      'Merged',
      'test',
    );
    (window as any).__mergeWorker.onmessage({
      data: { part, geometry: (await import(transferUrl)).snapshotGeometry(result) },
    });
    return source.id;
  });
  await expect(
    page.getByRole('alert').filter({ hasText: 'The source parts changed while merging' }),
  ).toBeVisible();
  const after = await sceneParts(page);
  expect(after).toHaveLength(original.length);
  expect(after.find((part: any) => part.id === changedId)).toEqual({
    id: changedId,
    name: 'Changed during merge',
  });
  await expect(page.getByRole('button', { name: 'Merge parts', exact: true })).toBeEnabled();
});
