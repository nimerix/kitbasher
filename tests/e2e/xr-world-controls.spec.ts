import { expect, test, type Page } from '@playwright/test';
import { Quaternion, Vector3 } from 'three';
import {
  setup,
  read,
  frames,
  place,
  aimAtScene,
  press,
  tap,
  stick,
  clickControl,
  attachControls,
} from './helpers/xr';
import type { Vec } from './helpers/xr';

const axes = (page: Page, left: [number, number], right: [number, number]) =>
  page.evaluate(
    ({ left, right }) => {
      const controllers = (window as any).xrDevice.controllers;
      controllers.left.updateAxes('thumbstick', ...left);
      controllers.right.updateAxes('thumbstick', ...right);
    },
    { left, right },
  );
const room = (rig: NonNullable<Awaited<ReturnType<typeof read>>['rig']>, point: Vec) =>
  new Vector3(...point)
    .sub(new Vector3(...rig.position))
    .applyQuaternion(new Quaternion(...rig.quaternion).invert())
    .divideScalar(rig.scale);
const nearRig = (
  actual: NonNullable<Awaited<ReturnType<typeof read>>['rig']>,
  expected: typeof actual,
) => {
  expect(actual.scale).toBeCloseTo(expected.scale, 6);
  expect(
    new Vector3(...actual.position).distanceTo(new Vector3(...expected.position)),
  ).toBeLessThan(1e-5);
  expect(
    new Quaternion(...actual.quaternion).angleTo(new Quaternion(...expected.quaternion)),
  ).toBeLessThan(1e-6);
};

test('one controller zooms around a fixed work point, turns once per deflection, and restores its view', async ({
  page,
}) => {
  await setup(page);
  await aimAtScene(page, [-20, 21, 3]);
  const before = await read(page);
  await press(page, 'right', 'squeeze', true);
  const pivot: Vec = await page.evaluate(async () => {
    const url = '/src/core/xr-session.ts';
    return (await import(url)).useXR.getState().runtime.navigationPivot.toArray();
  });
  expect((await read(page)).wristVisible).toBe(false);
  await stick(page, 'right', 0, -1, 18);
  const zoomed = await read(page);
  expect(zoomed.rig!.scale).toBeLessThan(before.rig!.scale * 0.9);
  expect(room(zoomed.rig!, pivot).distanceTo(room(before.rig!, pivot))).toBeLessThan(1e-5);
  await axes(page, [0, 0], [1, 0]);
  await frames(page, 4);
  const turned = await read(page);
  expect(
    new Quaternion(...zoomed.rig!.quaternion).angleTo(new Quaternion(...turned.rig!.quaternion)),
  ).toBeCloseTo(Math.PI / 6, 5);
  await frames(page, 18);
  nearRig((await read(page)).rig!, turned.rig!);
  // A latched turn must not freeze the physical grip while the stick stays held.
  await page.evaluate(() => ((window as any).xrDevice.controllers.right.position.x += 0.04));
  await frames(page);
  const carried = await read(page);
  const displacement = room(carried.rig!, pivot).sub(room(turned.rig!, pivot));
  expect(displacement.x).toBeCloseTo(0.04, 5);
  expect(displacement.y).toBeCloseTo(0, 5);
  expect(displacement.z).toBeCloseTo(0, 5);
  expect(carried.rig!.quaternion).toEqual(turned.rig!.quaternion);
  await axes(page, [0, 0], [0, 0]);
  await press(page, 'right', 'squeeze', false);
  await frames(page, 6);
  expect((await read(page)).parts).toEqual(before.parts);
  expect((await read(page)).past).toBe(before.past);
  expect((await read(page)).wristVisible).toBe(true);
  await clickControl(page, 'panel', 'previousView');
  nearRig((await read(page)).rig!, before.rig!);
  await attachControls(page, 'world-view');
});

test('Previous view restores level mode along with a tipped view', async ({ page }) => {
  await setup(page);
  await clickControl(page, 'panel', 'level');
  await place(page, 'left', [-0.15, 1.2, -0.3]);
  await place(page, 'right', [0.15, 1.2, -0.3]);
  await press(page, 'left', 'squeeze', true);
  await press(page, 'right', 'squeeze', true);
  await place(page, 'right', [0.15, 1.4, -0.3]);
  await frames(page);
  await press(page, 'left', 'squeeze', false);
  await press(page, 'right', 'squeeze', false);
  const tipped = await read(page);
  expect(tipped.level).toBe(false);
  expect(Math.hypot(tipped.rig!.quaternion[0], tipped.rig!.quaternion[2])).toBeGreaterThan(0.1);
  await clickControl(page, 'panel', 'level');
  const upright = await read(page);
  expect(upright.level).toBe(true);
  expect(upright.rig!.quaternion[0]).toBeCloseTo(0, 6);
  expect(upright.rig!.quaternion[2]).toBeCloseTo(0, 6);
  await clickControl(page, 'panel', 'previousView');
  nearRig((await read(page)).rig!, tipped.rig!);
  expect((await read(page)).level).toBe(false);
  await clickControl(page, 'panel', 'previousView');
  nearRig((await read(page)).rig!, upright.rig!);
  expect((await read(page)).level).toBe(true);
  expect((await read(page)).parts).toEqual(tipped.parts);
});

test('session focus loss cancels gestures immediately and requires fresh navigation input', async ({
  page,
}) => {
  await setup(page);
  for (const visibility of ['hidden', 'visible-blurred']) {
    await press(page, 'right', 'squeeze', true);
    await axes(page, [0, 0], [0, -1]);
    await frames(page, 6);
    // Dispatch and inspect synchronously, without a hidden animation frame to cancel for us.
    const suspended = await page.evaluate(async (visibility) => {
      const url = '/src/core/xr-session.ts';
      const { runtime, session } = (await import(url)).useXR.getState();
      const rig = {
        position: runtime.rig.position.toArray(),
        quaternion: runtime.rig.quaternion.toArray(),
        scale: runtime.rig.scale,
      };
      Object.defineProperty(session, 'visibilityState', { value: visibility, configurable: true });
      session.dispatchEvent(new Event('visibilitychange'));
      const actions = [...runtime.pointers.values()].map((pointer: any) => pointer.action);
      (window as any).xrDevice.controllers.right.position.x += 0.2;
      Object.defineProperty(session, 'visibilityState', { value: 'visible', configurable: true });
      session.dispatchEvent(new Event('visibilitychange'));
      return { rig, actions };
    }, visibility);
    expect(suspended.actions.every((action) => action === null)).toBe(true);
    await frames(page, 8);
    nearRig((await read(page)).rig!, suspended.rig);
    await axes(page, [0, 0], [0, 0]);
    await press(page, 'right', 'squeeze', false);
    await press(page, 'right', 'squeeze', true);
    await page.evaluate(() => ((window as any).xrDevice.controllers.right.position.x += 0.03));
    await frames(page);
    expect((await read(page)).rig!.position).not.toEqual(suspended.rig.position);
    await press(page, 'right', 'squeeze', false);
  }
});

test('a missing pinch fingertip ends bare-hand navigation even when the ray remains tracked', async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const device = (window as any).xrDevice;
    device.primaryInputMode = 'hand';
    device.hands.right.position.set(0.6, 1.2, -0.2);
  });
  await frames(page, 8);
  await page.evaluate(() => (window as any).xrDevice.hands.right.updatePinchValue(1));
  await frames(page, 8);
  const before = await read(page);
  const lost = await page.evaluate(async () => {
    const url = '/src/core/xr-session.ts';
    const runtime = (await import(url)).useXR.getState().runtime;
    const poses = new Map();
    const joints = new Map();
    let right: any;
    for (const pointer of runtime.pointers.values()) {
      poses.set(pointer.source.targetRaySpace, { transform: { matrix: pointer.aim.toArray() } });
      poses.set(pointer.source.gripSpace, { transform: { matrix: pointer.matrix().toArray() } });
      for (const [name, joint] of pointer.source.hand ?? [])
        joints.set(
          joint,
          name === 'thumb-tip' && pointer.source.handedness === 'right'
            ? null
            : {
                transform: {
                  position: pointer.hand.position,
                  orientation: pointer.hand.quaternion,
                },
              },
        );
      if (pointer.source.handedness === 'right') right = pointer;
    }
    const actionBefore = right.action?.kind;
    runtime.update({
      getViewerPose: () => ({ transform: { matrix: runtime.head.toArray() } }),
      getPose: (space: unknown) => poses.get(space) ?? null,
      getJointPose: (joint: unknown) => joints.get(joint) ?? null,
    });
    return { actionBefore, tracked: right.tracked, action: right.action };
  });
  expect(lost).toEqual({ actionBefore: 'world', tracked: false, action: null });
  await page.evaluate(() => ((window as any).xrDevice.hands.right.position.x += 0.2));
  await frames(page, 8);
  nearRig((await read(page)).rig!, before.rig!);
  expect((await read(page)).parts).toEqual(before.parts);
  await page.evaluate(() => (window as any).xrDevice.hands.right.updatePinchValue(0));
  await frames(page, 4);
  await page.evaluate(() => (window as any).xrDevice.hands.right.updatePinchValue(1));
  await frames(page, 4);
  await page.evaluate(() => ((window as any).xrDevice.hands.right.position.x += 0.03));
  await frames(page, 4);
  expect((await read(page)).rig!.position).not.toEqual(before.rig!.position);
});

test('view changes and grip navigation release held parts without moving their geometry', async ({
  page,
}) => {
  await setup(page);
  for (const action of ['zoomIn', 'trueSize', 'reset', 'level']) {
    await aimAtScene(page, [-20, 21, 3]);
    await press(page, 'right', 'trigger', true);
    const before = await read(page);
    await clickControl(page, 'panel', action, 'left');
    await frames(page);
    expect((await read(page)).parts).toEqual(before.parts);
    expect((await read(page)).past).toBe(before.past);
    await press(page, 'right', 'trigger', false);
    await clickControl(page, 'panel', 'reset');
  }
  await aimAtScene(page, [-20, 21, 3]);
  await press(page, 'right', 'trigger', true);
  const before = await read(page);
  await place(page, 'left', [-0.3, 1.2, -0.25]);
  await press(page, 'left', 'squeeze', true);
  await place(page, 'left', [-0.2, 1.2, -0.25]);
  await frames(page);
  expect((await read(page)).parts).toEqual(before.parts);
  expect((await read(page)).past).toBe(before.past);
  expect((await read(page)).rig!.position).not.toEqual(before.rig!.position);
  await press(page, 'left', 'squeeze', false);
  await press(page, 'right', 'trigger', false);
});

test('trigger misses and locked selections stay still; optional legacy navigation is explicit', async ({
  page,
}) => {
  await setup(page);
  await place(page, 'right', [0.6, 1.1, -0.2]);
  await frames(page);
  const before = await read(page);
  await press(page, 'right', 'trigger', true);
  await place(page, 'right', [0.7, 1.1, -0.2]);
  await frames(page);
  await press(page, 'right', 'trigger', false);
  nearRig((await read(page)).rig!, before.rig!);
  await page.evaluate(async () => {
    const url = '/src/core/store.ts';
    const state = (await import(url)).useEditor.getState();
    state.patchParts(['source'], { locked: true });
    state.select(null);
  });
  await aimAtScene(page, [-20, 21, 3]);
  await tap(page, 'right', 'trigger');
  expect((await read(page)).selected).toEqual(['source']);
  nearRig((await read(page)).rig!, before.rig!);
  await clickControl(page, 'panel', 'page:world');
  await clickControl(page, 'panel', 'bind:triggerWorld');
  expect((await read(page)).settings.triggerWorld).toBe(true);
  await place(page, 'right', [0.6, 1.1, -0.2]);
  await frames(page);
  await press(page, 'right', 'trigger', true);
  await place(page, 'right', [0.7, 1.1, -0.2]);
  await frames(page);
  await press(page, 'right', 'trigger', false);
  expect((await read(page)).rig!.position).not.toEqual(before.rig!.position);
  await attachControls(page, 'world-settings');
});

test('framing respects isolation and focus requires a visible selection', async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const url = '/src/core/store.ts';
    const state = (await import(url)).useEditor.getState();
    state.transform('target', { position: [10000, 20, 0] });
    state.isolate(['source']);
    state.select(null);
  });
  await frames(page);
  const before = await read(page);
  await clickControl(page, 'panel', 'focusSelection');
  nearRig((await read(page)).rig!, before.rig!);
  await clickControl(page, 'panel', 'reset');
  const framed = await read(page);
  const center = room(framed.rig!, [-22, 20, 0]);
  expect(center.x).toBeCloseTo(0, 4);
  expect(center.y).toBeCloseTo(1.35, 4);
  expect(center.z).toBeCloseTo(-0.55, 4);
  expect(Math.hypot(16, 16, 6) / framed.rig!.scale).toBeCloseTo(0.4, 4);
  expect(framed.parts).toEqual(before.parts);
  expect(framed.past).toBe(before.past);
});

test('mapped world input wins over either edit stick and edits wait for neutral after navigation', async ({
  page,
}) => {
  await setup(page);
  await aimAtScene(page, [-20, 21, 3]);
  await tap(page, 'right', 'trigger');
  await page.evaluate(async () => {
    const url = '/src/core/xr-input.ts';
    const state = (await import(url)).useXRInput.getState();
    state.setSettings({ axes: { left: 'translate', right: 'world' } });
  });
  await place(page, 'left', [-0.4, 1.1, -0.2]);
  await frames(page);
  const before = await read(page);
  await axes(page, [1, 0], [0, -1]);
  await frames(page, 15);
  expect((await read(page)).parts).toEqual(before.parts);
  expect((await read(page)).rig!.scale).toBeLessThan(before.rig!.scale);
  await axes(page, [1, 0], [0, 0]);
  await frames(page, 10);
  expect((await read(page)).parts).toEqual(before.parts);
  await axes(page, [0, 0], [0, 0]);
  await frames(page);
  await stick(page, 'left', 1, 0);
  expect((await read(page)).parts).not.toEqual(before.parts);
  expect((await read(page)).past).toBe(before.past + 1);
});

test('grip interrupts a same-controller grab or paint stroke while preserving editor work', async ({
  page,
}) => {
  await setup(page);
  await aimAtScene(page, [-20, 21, 3]);
  await press(page, 'right', 'trigger', true);
  const before = await read(page);
  await press(page, 'right', 'squeeze', true);
  await place(page, 'right', [0.4, 1.2, -0.2]);
  await frames(page);
  expect((await read(page)).parts).toEqual(before.parts);
  expect((await read(page)).rig!.position).not.toEqual(before.rig!.position);
  await press(page, 'right', 'squeeze', false);
  await press(page, 'right', 'trigger', false);
  await clickControl(page, 'panel', 'reset');
  await clickControl(page, 'wrist', 'align');
  for (let i = 0; i < 4; i++) await clickControl(page, 'panel', 'edit:alignMode');
  await aimAtScene(page, [-20, 21, 3]);
  await press(page, 'right', 'trigger', true);
  const painted = await read(page);
  expect(painted.painting).toBe(true);
  await press(page, 'right', 'squeeze', true);
  expect((await read(page)).painting).toBe(false);
  await stick(page, 'right', 0, -1);
  expect((await read(page)).operation).toEqual(painted.operation);
  expect((await read(page)).parts).toEqual(painted.parts);
  await press(page, 'right', 'squeeze', false);
  await press(page, 'right', 'trigger', false);
});

test('turning the ray around a stationary physical grip does not drag the world', async ({
  page,
}) => {
  await setup(page);
  await press(page, 'right', 'squeeze', true);
  const before = await read(page);
  await page.evaluate(async () => {
    const url = '/src/core/xr-session.ts';
    const runtime = (await import(url)).useXR.getState().runtime;
    const pointer: any = [...runtime.pointers.values()].find(
      (pointer: any) => pointer.source.handedness === 'right',
    );
    const grip = pointer.hand.position.clone();
    const localOffset = grip.clone().applyMatrix4(pointer.aim.clone().invert());
    // Rotate 90 degrees about room Y: (x,y,z) -> (z,y,-x). Update atomically before a frame.
    const controller = (window as any).xrDevice.controllers.right;
    controller.quaternion.set(0, Math.SQRT1_2, 0, Math.SQRT1_2);
    controller.position.set(grip.x - localOffset.z, grip.y - localOffset.y, grip.z + localOffset.x);
  });
  await frames(page, 8);
  nearRig((await read(page)).rig!, before.rig!);
  expect((await read(page)).parts).toEqual(before.parts);
});

test('loss of a controller grip pose ends navigation without falling back to the ray pose', async ({
  page,
}) => {
  await setup(page);
  await press(page, 'right', 'squeeze', true);
  const before = await read(page);
  const lost = await page.evaluate(async () => {
    const url = '/src/core/xr-session.ts';
    const runtime = (await import(url)).useXR.getState().runtime;
    const poses = new Map();
    let right: any;
    for (const pointer of runtime.pointers.values()) {
      poses.set(pointer.source.targetRaySpace, { transform: { matrix: pointer.aim.toArray() } });
      if (pointer.source.handedness === 'right') {
        right = pointer;
        poses.set(pointer.source.gripSpace, null);
      } else
        poses.set(pointer.source.gripSpace, { transform: { matrix: pointer.matrix().toArray() } });
    }
    runtime.update({
      getViewerPose: () => ({ transform: { matrix: runtime.head.toArray() } }),
      getPose: (space: unknown) => poses.get(space) ?? null,
    });
    return { tracked: right.tracked, action: right.action };
  });
  expect(lost).toEqual({ tracked: false, action: null });
  await place(page, 'right', [0.6, 1.2, -0.2]);
  await frames(page, 8);
  nearRig((await read(page)).rig!, before.rig!);
  expect((await read(page)).parts).toEqual(before.parts);
  await press(page, 'right', 'squeeze', false);
  await press(page, 'right', 'squeeze', true);
  await place(page, 'right', [0.7, 1.2, -0.2]);
  await frames(page);
  expect((await read(page)).rig!.position).not.toEqual(before.rig!.position);
});
