import { expect, test, type Page } from '@playwright/test';

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
      geometryUrl = '/src/core/geometry.ts';
    const { useEditor } = await import(storeUrl);
    const geometry = await import(geometryUrl);
    const state = useEditor.getState();
    const source = state.scene.parts.find((part: any) => part.id === state.selected[0]);
    const baked = geometry.bakedPartGeometry(source);
    state.patchParts([source.id], { name: 'Changed during merge' });
    (window as any).__mergeWorker.onmessage({ data: { result: geometry.binaryGeometry(baked) } });
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
