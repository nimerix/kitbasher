import { test, expect, type Page } from '@playwright/test';
import { Quaternion } from 'three';
import {
  setup,
  read,
  frames,
  aimAtScene,
  press,
  tap,
  clickControl,
  stick,
  attachControls,
} from './helpers/xr';

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on('pageerror', (error) => list.push(error.message));
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));

test('wrist tools and face buttons pick, step back, and apply an alignment', async ({ page }) => {
  await setup(page);
  await clickControl(page, 'wrist', 'align');
  expect((await read(page)).tool).toBe('align');
  await attachControls(page, 'point-alignment');
  await aimAtScene(page, [-20, 21, 3]);
  await tap(page, 'right', 'a-button');
  expect((await read(page)).operation.pending?.partId).toBe('source');
  await aimAtScene(page, [24, 21, 3]);
  await tap(page, 'right', 'a-button');
  expect((await read(page)).operation.pairs).toHaveLength(1);
  await tap(page, 'right', 'b-button');
  let state = await read(page);
  expect(state.operation.pairs).toHaveLength(0);
  expect(state.operation.pending?.partId).toBe('source');
  await tap(page, 'right', 'a-button');
  await tap(page, 'right', 'a-button');
  state = await read(page);
  expect(state.parts.find((part) => part.id === 'source')!.position[0]).toBeCloseTo(22, 4);
  expect(state.parts.find((part) => part.id === 'target')!.position).toEqual([22, 20, 0]);
  expect(state.past).toBe(1);
  await tap(page, 'left', 'x-button');
  expect((await read(page)).parts.find((part) => part.id === 'source')!.position).toEqual([
    -22, 20, 0,
  ]);
});

test('painting uses exact mesh faces, advances pairs, adjusts the brush and undoes strokes', async ({
  page,
}) => {
  await setup(page);
  await clickControl(page, 'wrist', 'align');
  for (let i = 0; i < 4; i++) await clickControl(page, 'panel', 'edit:alignMode');
  expect((await read(page)).operation.mode).toBe('surface');
  await aimAtScene(page, [-20, 21, 3]);
  await press(page, 'right', 'trigger', true);
  let state = await read(page);
  expect(state.operation.surfacePairs[0].source?.partId).toBe('source');
  expect(state.operation.surfacePairs[0].source!.faces.length).toBeGreaterThan(1);
  const facesBefore = state.operation.surfacePairs[0].source!.faces.length;
  const radius = state.brushRadius;
  // Growing a stationary brush must paint its larger footprint within the same stroke.
  await stick(page, 'right', 0, -1, 40);
  state = await read(page);
  expect(state.brushRadius).toBeGreaterThan(radius);
  expect(state.operation.surfacePairs[0].source!.faces.length).toBeGreaterThan(facesBefore);
  expect(state.painting).toBe(true);
  await press(page, 'right', 'trigger', false);
  state = await read(page);
  expect(state.painting).toBe(false);
  expect(state.paintHistory).toBe(1);
  await attachControls(page, 'paint-source');
  await tap(page, 'right', 'a-button');
  expect((await read(page)).operation.activeSurface?.side).toBe('target');
  await aimAtScene(page, [24, 21, 3]);
  await tap(page, 'right', 'trigger');
  expect((await read(page)).operation.surfacePairs[0].target?.partId).toBe('target');
  await tap(page, 'left', 'x-button');
  expect((await read(page)).operation.surfacePairs[0].target).toBeNull();
  await tap(page, 'right', 'trigger');
  await tap(page, 'right', 'a-button');
  expect((await read(page)).operation.activeSurface).toBeNull();
  await tap(page, 'right', 'a-button');
  state = await read(page);
  expect(state.operation.surfacePairs).toHaveLength(2);
  expect(state.operation.activeSurface?.side).toBe('source');
  expect(state.past).toBe(0);
});

test('thumbstick rotation has precision mode and one undo step per gesture', async ({ page }) => {
  await setup(page);
  await clickControl(page, 'wrist', 'rotate');
  await aimAtScene(page, [-20, 21, 3]);
  await tap(page, 'right', 'trigger');
  expect((await read(page)).selected).toEqual(['source']);
  await stick(page, 'right', 0.8, 0);
  const coarse = await read(page);
  const coarseAngle = new Quaternion(...coarse.parts[0].quaternion).angleTo(new Quaternion());
  expect(coarseAngle).toBeGreaterThan(0.01);
  expect(coarse.past).toBe(1);
  await tap(page, 'left', 'x-button');
  expect((await read(page)).parts[0].quaternion).toEqual([0, 0, 0, 1]);
  await tap(page, 'right', 'thumbstick');
  expect((await read(page)).precision).toBe(true);
  await stick(page, 'right', 0.8, 0);
  const fine = await read(page);
  const fineAngle = new Quaternion(...fine.parts[0].quaternion).angleTo(new Quaternion());
  expect(fineAngle).toBeGreaterThan(0);
  expect(fineAngle).toBeLessThan(coarseAngle * 0.4);
  expect(fine.past).toBe(1);
});

test('headset binding edits persist and change the physical button action immediately', async ({
  page,
}) => {
  await setup(page);
  await clickControl(page, 'panel', 'page:bindings');
  // Y defaults to tools. One cycle assigns Bring panel here, the next assigns Precision.
  await clickControl(page, 'panel', 'bind:button:y');
  await clickControl(page, 'panel', 'bind:button:y');
  expect((await read(page)).settings.buttons.y).toBe('precision');
  await attachControls(page, 'controller-bindings');
  const visible = (await read(page)).wristVisible;
  await tap(page, 'left', 'y-button');
  expect((await read(page)).precision).toBe(true);
  expect((await read(page)).wristVisible).toBe(visible);
  await clickControl(page, 'panel', 'exit');
  await page.reload();
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: /^Preferences \(/ }).click();
  await page.getByRole('tab', { name: 'Headset' }).click();
  await expect(page.getByRole('combobox', { name: 'Y · left action', exact: true })).toHaveValue(
    'precision',
  );
});

test('both sticks share an undo step until the final stick returns to neutral', async ({
  page,
}) => {
  await setup(page);
  await clickControl(page, 'wrist', 'rotate');
  await aimAtScene(page, [-20, 21, 3]);
  await tap(page, 'right', 'trigger');
  await page.evaluate(() => {
    const controllers = (window as any).xrDevice.controllers;
    controllers.left.updateAxes('thumbstick', 0.7, 0);
    controllers.right.updateAxes('thumbstick', 0.7, 0);
  });
  await frames(page, 14);
  await page.evaluate(() =>
    (window as any).xrDevice.controllers.left.updateAxes('thumbstick', 0, 0),
  );
  await frames(page, 6);
  await page.evaluate(() =>
    (window as any).xrDevice.controllers.right.updateAxes('thumbstick', 0, 0),
  );
  await frames(page);
  const changed = await read(page);
  expect(changed.past).toBe(1);
  expect(changed.parts[0].position[0]).toBeGreaterThan(-22);
  expect(new Quaternion(...changed.parts[0].quaternion).angleTo(new Quaternion())).toBeGreaterThan(
    0.01,
  );
  await tap(page, 'left', 'x-button');
  const restored = await read(page);
  expect(restored.parts[0].position).toEqual([-22, 20, 0]);
  expect(restored.parts[0].quaternion).toEqual([0, 0, 0, 1]);
});
