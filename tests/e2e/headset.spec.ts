import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { BoxGeometry, Quaternion, Vector3 } from 'three';
import { serializeGeometry } from '../../src/core/geometry';

// Meta's WebXR emulator stands in for the headset, its controllers, and its hands.
const emulator = fileURLToPath(
  new URL('../../node_modules/iwer/build/iwer.min.js', import.meta.url),
);

const box = (id: string, name: string, size: number[], position: number[], locked = false) => ({
  id,
  name,
  geometry: serializeGeometry(new BoxGeometry(...size)),
  position,
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#8fa3b8',
  visible: true,
  locked,
  source: 'test',
});
const fixture = {
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Bench',
  joints: [],
  parts: [
    box('wall', 'Wall', [10, 40, 40], [0, 20, 0]),
    box('block', 'Block', [10, 10, 10], [30, 20, 0]),
  ],
};

// The default: parts stop at each other.
test.use({ storageState: { cookies: [], origins: [] } });

type Vec = [number, number, number];
type Hand = 'left' | 'right';

async function setup(page: Page, scene: object | null = fixture) {
  await page.addInitScript({ path: emulator });
  await page.addInitScript(() => {
    const iwer = (window as any).IWER;
    const device = new iwer.XRDevice(iwer.metaQuest3);
    // Chrome has WebXR of its own, with no headset behind it.
    device.installRuntime({ forceInstall: true });
    (window as any).xrDevice = device;
  });
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  if (!scene) return;
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'headset.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scene)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await expect(page.locator('.part-row')).toHaveCount((scene as typeof fixture).parts.length);
}

async function enter(page: Page, mode: 'In your room' | 'Virtual space' = 'Virtual space') {
  await page.locator('.headset-button').click();
  await page.getByRole('menuitem', { name: mode }).click();
  await expect.poll(() => read(page).then((state) => state.placed)).toBe(true);
}

/** Lets the headset draw a few frames, which is when it reads the hands. */
const frames = (page: Page, count = 4) =>
  page.evaluate(
    (count) =>
      new Promise<void>((done) => {
        const step = (left: number) =>
          left ? requestAnimationFrame(() => step(left - 1)) : done();
        step(count);
      }),
    count,
  );

function read(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const module = (name: string) =>
      import(urls.find((url) => new RegExp(`/src/core/${name}\\.ts(?:\\?.*)?$`).test(url))!);
    const { useXR } = await module('xr-session');
    const { useEditor } = await module('store');
    const { runtime, mode, passthrough } = useXR.getState();
    const editor = useEditor.getState();
    const parts: Record<string, { position: number[]; quaternion: number[] }> = {};
    for (const part of editor.scene.parts)
      parts[part.id] = { position: part.position, quaternion: part.quaternion };
    return {
      mode: mode as string | null,
      passthrough: passthrough as boolean,
      placed: !!runtime?.placed,
      magnification: (runtime?.magnification ?? 0) as number,
      rig: runtime
        ? {
            position: runtime.rig.position.toArray() as number[],
            quaternion: runtime.rig.quaternion.toArray() as number[],
            scale: runtime.rig.scale as number,
          }
        : null,
      parts,
      selected: editor.selected as string[],
      past: editor.past.length as number,
      clip: editor.view.clip.enabled as boolean,
      hands: Object.fromEntries(
        [...(runtime?.pointers.values() ?? [])].map((pointer: any) => [
          pointer.source.handedness,
          pointer.hand.position.toArray(),
        ]),
      ) as Record<string, number[]>,
    };
  });
}

/** The viewport's own camera and orbit controls, which the headset borrows. */
function desktopView(page: Page) {
  return page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => name.includes('/@react-three_fiber.js'))!;
    const root = (await import(url))._roots.get(document.querySelector('canvas')).store.getState();
    return {
      position: root.camera.position
        .toArray()
        .map((value: number) => Math.round(value * 1e4) / 1e4),
      fov: root.camera.fov as number,
      near: root.camera.near as number,
      far: root.camera.far as number,
      orbit: root.controls.enabled as boolean,
      background: !!root.scene.background,
      inScene: root.camera.parent === root.scene || root.camera.parent?.parent === root.scene,
    };
  });
}

/** Where a point in the scene is in the room, and the reverse. */
async function toRoom(page: Page, scene: Vec): Promise<Vec> {
  const { rig } = await read(page);
  const [x, y, z, w] = rig!.quaternion;
  const offset = scene.map((value, i) => value - rig!.position[i]) as Vec;
  return new Vector3(...offset)
    .applyQuaternion(new Quaternion(x, y, z, w).invert())
    .divideScalar(rig!.scale)
    .toArray();
}

async function toScene(page: Page, room: Vec): Promise<Vec> {
  const { rig } = await read(page);
  const [x, y, z, w] = rig!.quaternion;
  return new Vector3(...room)
    .multiplyScalar(rig!.scale)
    .applyQuaternion(new Quaternion(x, y, z, w))
    .add(new Vector3(...rig!.position))
    .toArray();
}

async function panelPoint(page: Page, action: string): Promise<Vec> {
  return page.evaluate(async (action) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useXR } = await import(urls.find((url) => /\/src\/core\/xr-session\.ts/.test(url))!);
    return useXR.getState().runtime.panel.center(action).toArray();
  }, action);
}

type Input = 'controllers' | 'hands';

const place = (page: Page, hand: Hand, position: Vec, input: Input = 'controllers') =>
  page.evaluate(
    ([hand, position, input]) =>
      (window as any).xrDevice[input as string][hand as string].position.set(
        ...(position as number[]),
      ),
    [hand, position, input] as const,
  );

/** Points a controller at a place in the room from where the controller is. */
const aim = (page: Page, hand: Hand, target: Vec) =>
  page.evaluate(
    ([hand, target]) => {
      const controller = (window as any).xrDevice.controllers[hand as string];
      const [x, y, z] = target as number[];
      const from = controller.position;
      const d = [x - from.x, y - from.y, z - from.z];
      const length = Math.hypot(...d);
      // The shortest turn that takes straight ahead, -Z, to the target.
      const q = [d[1] / length, -d[0] / length, 0, 1 - d[2] / length];
      const norm = Math.hypot(...q);
      controller.quaternion.set(q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm);
    },
    [hand, target] as const,
  );

const turn = (page: Page, hand: Hand, quaternion: [number, number, number, number]) =>
  page.evaluate(
    ([hand, quaternion]) =>
      (window as any).xrDevice.controllers[hand as string].quaternion.set(
        ...(quaternion as number[]),
      ),
    [hand, quaternion] as const,
  );

async function press(page: Page, hand: Hand, id: 'trigger' | 'squeeze', down = true) {
  await page.evaluate(
    ([hand, id, value]) =>
      (window as any).xrDevice.controllers[hand as string].updateButtonValue(id, value),
    [hand, id, down ? 1 : 0] as const,
  );
  await frames(page);
}

/** Moves a controller or hand in small steps, drawing a frame at each. */
async function move(
  page: Page,
  hand: Hand,
  from: Vec,
  to: Vec,
  input: Input = 'controllers',
  steps = 12,
) {
  for (let i = 1; i <= steps; i++) {
    const at = from.map((value, k) => value + ((to[k] - value) * i) / steps) as Vec;
    await place(page, hand, at, input);
    await frames(page, 1);
  }
  await frames(page);
}

/** Aims at a control on the in-headset panel from just in front of it, and clicks it. */
async function click(page: Page, action: string) {
  const target = await panelPoint(page, action);
  const eyes: Vec = [0, 1.6, 0];
  await place(page, 'right', target.map((value, i) => value + (eyes[i] - value) * 0.25) as Vec);
  await aim(page, 'right', target);
  await frames(page);
  await press(page, 'right', 'trigger');
  await press(page, 'right', 'trigger', false);
}

const add = (a: Vec, b: Vec) => a.map((value, i) => value + b[i]) as Vec;
const span = (a: Vec, b: Vec) => Math.hypot(...a.map((value, i) => value - b[i]));
/** Where the app takes a hand to be, which is the tip it points from. */
const hand = async (page: Page, side: Hand) => (await read(page)).hands[side] as Vec;

test('offers the headset only where the browser has one', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.locator('.headset-button')).toHaveCount(0);
});

test('sets the model within reach and returns the desktop view on leaving', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);
  const before = await desktopView(page);
  await enter(page);
  const state = await read(page);
  expect(state.mode).toBe('vr');
  expect(state.passthrough).toBe(false);
  // The fixture is about 60 mm across, and is shown 0.4 m across.
  expect(state.magnification).toBeGreaterThan(5);
  expect(state.magnification).toBeLessThan(9);
  // Half a meter ahead of the eyes, which the emulator puts at 1.6 m, and a little below them.
  const center = await toRoom(page, [15, 20, 0]);
  expect(center[0]).toBeCloseTo(0, 3);
  expect(center[1]).toBeCloseTo(1.35, 3);
  expect(center[2]).toBeCloseTo(-0.55, 3);
  const during = await desktopView(page);
  expect(during.orbit).toBe(false);
  expect(during.near).toBeLessThan(0.1);

  await click(page, 'exit');
  await expect.poll(() => read(page).then((s) => s.mode)).toBeNull();
  await expect(page.locator('.headset-button')).toHaveText('Headset');
  await expect.poll(() => desktopView(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test('holds a part in the hand, and stops it at another part', async ({ page }) => {
  await setup(page);
  await enter(page);
  const { rig } = await read(page);
  const start = await toRoom(page, [30, 20, 0]);
  await place(page, 'right', start);
  await frames(page);
  await press(page, 'right', 'trigger');
  expect((await read(page)).selected).toEqual(['block']);
  // A press that does not move leaves nothing to undo.
  expect((await read(page)).past).toBe(0);

  const away = add(start, [0.05, 0.02, 0]);
  await move(page, 'right', start, away);
  let block = (await read(page)).parts.block.position;
  expect(block[0]).toBeCloseTo(30 + 0.05 * rig!.scale, 2);
  expect(block[1]).toBeCloseTo(20 + 0.02 * rig!.scale, 2);

  // Through the wall, whose near face is at x = 5. The block is 10 mm wide.
  const beyond = add(start, [-50 / rig!.scale, 0.02, 0]);
  await move(page, 'right', away, beyond, 'controllers', 30);
  await press(page, 'right', 'trigger', false);
  const state = await read(page);
  block = state.parts.block.position;
  expect(block[0]).toBeGreaterThan(9.85);
  expect(block[0]).toBeLessThan(10.05);
  expect(block[1]).toBeCloseTo(20 + 0.02 * rig!.scale, 1);
  expect(state.parts.wall.position).toEqual([0, 20, 0]);
  // The whole hold is one step.
  expect(state.past).toBe(1);

  await click(page, 'undo');
  expect((await read(page)).parts.block.position).toEqual([30, 20, 0]);
  await click(page, 'redo');
  expect((await read(page)).parts.block.position[0]).toBeCloseTo(block[0], 3);
});

test('passes through other parts once No clip is turned off on the panel', async ({ page }) => {
  await setup(page);
  await enter(page);
  expect((await read(page)).clip).toBe(true);
  await click(page, 'clip');
  expect((await read(page)).clip).toBe(false);
  const { rig } = await read(page);
  const start = await toRoom(page, [30, 20, 0]);
  await turn(page, 'right', [0, 0, 0, 1]);
  await place(page, 'right', start);
  await frames(page);
  await press(page, 'right', 'trigger');
  await move(page, 'right', start, add(start, [-30 / rig!.scale, 0, 0]));
  await press(page, 'right', 'trigger', false);
  expect((await read(page)).parts.block.position[0]).toBeCloseTo(0, 2);
});

test('holds a part pointed at from a distance, turning it about where it was taken', async ({
  page,
}) => {
  await setup(page);
  await enter(page);
  const { rig } = await read(page);
  // The middle of the block's front face.
  const face = await toRoom(page, [30, 20, 5]);
  const start = add(face, [0, 0, 0.3]);
  await place(page, 'right', start);
  await aim(page, 'right', face);
  await frames(page);
  await press(page, 'right', 'trigger');
  expect((await read(page)).selected).toEqual(['block']);

  // The part moves as far as the hand does, however far away it is.
  const raised = add(start, [0, 0.03, 0]);
  await move(page, 'right', start, raised);
  let block = (await read(page)).parts.block;
  expect(block.position[0]).toBeCloseTo(30, 2);
  expect(block.position[1]).toBeCloseTo(20 + 0.03 * rig!.scale, 2);
  expect(block.position[2]).toBeCloseTo(0, 2);

  // A quarter turn of the wrist about the pointing direction turns the block about that point.
  await turn(page, 'right', [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
  await frames(page);
  await press(page, 'right', 'trigger', false);
  block = (await read(page)).parts.block;
  expect(Math.abs(block.quaternion[2])).toBeCloseTo(Math.SQRT1_2, 2);
  expect(Math.abs(block.quaternion[3])).toBeCloseTo(Math.SQRT1_2, 2);
  expect(block.position[0]).toBeCloseTo(30, 1);
  expect(block.position[1]).toBeCloseTo(20 + 0.03 * rig!.scale, 1);
});

test('one hand carries the world, and two resize it', async ({ page }) => {
  await setup(page);
  await enter(page);
  const before = await read(page);
  const left: Vec = [-0.1, 1.2, -0.3],
    right: Vec = [0.1, 1.2, -0.3];
  await place(page, 'left', left);
  await place(page, 'right', right);
  await frames(page);

  // The grip holds the world wherever it points, and nothing in the scene changes.
  const held = await toScene(page, await hand(page, 'right'));
  await press(page, 'right', 'squeeze');
  const carried = add(right, [0.08, 0.05, -0.02]);
  await move(page, 'right', right, carried);
  const dragged = await read(page);
  expect(dragged.magnification).toBeCloseTo(before.magnification, 6);
  (await toScene(page, await hand(page, 'right'))).forEach((value, i) =>
    expect(value).toBeCloseTo(held[i], 3),
  );
  expect(dragged.parts).toEqual(before.parts);
  expect(dragged.past).toBe(0);

  // A second hand makes it two: moving them apart makes everything larger.
  const middle = async () => {
    const [a, b] = [await hand(page, 'left'), await hand(page, 'right')];
    return toScene(page, a.map((value, i) => (value + b[i]) / 2) as Vec);
  };
  const anchor = await middle();
  const narrow = span(await hand(page, 'left'), await hand(page, 'right'));
  await press(page, 'left', 'squeeze');
  await move(page, 'right', carried, add(carried, [0.18, 0, 0]));
  const resized = await read(page);
  const wide = span(await hand(page, 'left'), await hand(page, 'right'));
  expect(resized.magnification / dragged.magnification).toBeCloseTo(wide / narrow, 4);
  // What was between the hands still is.
  (await middle()).forEach((value, i) => expect(value).toBeCloseTo(anchor[i], 3));
  // Kept level: the world turned about the vertical only.
  expect(resized.rig!.quaternion[0]).toBeCloseTo(0, 6);
  expect(resized.rig!.quaternion[2]).toBeCloseTo(0, 6);
  await press(page, 'left', 'squeeze', false);
  await press(page, 'right', 'squeeze', false);

  await click(page, 'trueSize');
  expect((await read(page)).magnification).toBeCloseTo(1, 6);
  await click(page, 'reset');
  expect((await read(page)).magnification).toBeCloseTo(before.magnification, 4);
});

test('a locked part holds the world instead of moving', async ({ page }) => {
  await setup(page, {
    ...fixture,
    parts: [box('wall', 'Wall', [10, 40, 40], [0, 20, 0], true), fixture.parts[1]],
  });
  await enter(page);
  const start = await toRoom(page, [0, 20, 0]);
  await place(page, 'right', start);
  await frames(page);
  const held = await toScene(page, await hand(page, 'right'));
  await press(page, 'right', 'trigger');
  await move(page, 'right', start, add(start, [0.05, 0, 0]));
  await press(page, 'right', 'trigger', false);
  const state = await read(page);
  expect(state.parts.wall.position).toEqual([0, 20, 0]);
  expect(state.past).toBe(0);
  (await toScene(page, await hand(page, 'right'))).forEach((value, i) =>
    expect(value).toBeCloseTo(held[i], 3),
  );
});

test('a bare hand takes a part by pinching it', async ({ page }) => {
  await setup(page);
  await enter(page);
  await page.evaluate(() => ((window as any).xrDevice.primaryInputMode = 'hand'));
  const rest: Vec = [0.2, 1.3, -0.3];
  const pinching = async (value: number) => {
    await page.evaluate((v) => (window as any).xrDevice.hands.right.updatePinchValue(v), value);
    await frames(page, 8);
  };
  await place(page, 'right', rest, 'hands');
  // Where the fingers meet is not where the emulator says the hand is, so pinch the air to find it.
  await pinching(1);
  const pinch = await hand(page, 'right');
  await pinching(0);
  const { rig } = await read(page);
  const block = await toRoom(page, [30, 20, 0]);
  const start = add(rest, block.map((value, i) => value - pinch[i]) as Vec);
  await move(page, 'right', rest, start, 'hands');
  await pinching(1);
  expect((await read(page)).selected).toEqual(['block']);
  await move(page, 'right', start, add(start, [0.04, 0, 0]), 'hands');
  await pinching(0);
  const state = await read(page);
  expect(state.parts.block.position[0]).toBeGreaterThan(30 + 0.03 * rig!.scale);
  expect(state.past).toBe(1);
});

test('shows the room behind the model when asked to', async ({ page }) => {
  await setup(page);
  expect((await desktopView(page)).background).toBe(true);
  await enter(page, 'In your room');
  const state = await read(page);
  expect(state.mode).toBe('ar');
  expect(state.passthrough).toBe(true);
  await expect.poll(() => desktopView(page).then((view) => view.background)).toBe(false);
  await click(page, 'exit');
  await expect.poll(() => desktopView(page).then((view) => view.background)).toBe(true);
});

test('the panel moves by its background, and B brings it back in front of the viewer', async ({
  page,
}) => {
  await setup(page);
  await enter(page);
  const panel = () =>
    page.evaluate(async () => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const { useXR } = await import(urls.find((url) => /\/src\/core\/xr-session\.ts/.test(url))!);
      const { object } = useXR.getState().runtime.panel;
      return {
        position: object.position.toArray() as Vec,
        // In the heading, beside the name, where there is nothing to press.
        heading: object.position
          .clone()
          .set(0.08, 0.117, 0)
          .applyMatrix4(object.matrix)
          .toArray() as Vec,
      };
    });
  const before = await panel();
  const eyes: Vec = [0, 1.6, 0];
  const start = before.heading.map((value, i) => value + (eyes[i] - value) * 0.25) as Vec;
  await place(page, 'right', start);
  await aim(page, 'right', before.heading);
  await frames(page);
  await press(page, 'right', 'trigger');
  await move(page, 'right', start, add(start, [0.1, 0.04, 0]));
  await press(page, 'right', 'trigger', false);
  const moved = await panel();
  add(before.position, [0.1, 0.04, 0]).forEach((value, i) =>
    expect(moved.position[i]).toBeCloseTo(value, 4),
  );
  // Nothing in the scene was touched.
  expect((await read(page)).past).toBe(0);

  await page.evaluate(() =>
    (window as any).xrDevice.controllers.right.updateButtonValue('b-button', 1),
  );
  await frames(page);
  await page.evaluate(() =>
    (window as any).xrDevice.controllers.right.updateButtonValue('b-button', 0),
  );
  await frames(page);
  (await panel()).position.forEach((value, i) => expect(value).toBeCloseTo(before.position[i], 4));
});

test('sets a scene that replaces the one in view before the viewer again', async ({ page }) => {
  await setup(page);
  await enter(page);
  await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(urls.find((url) => /\/src\/core\/store\.ts/.test(url))!);
    const [wall] = useEditor.getState().scene.parts;
    useEditor.getState().setScene({
      name: 'Elsewhere',
      joints: [],
      parts: [{ ...wall, id: 'far', name: 'Far', position: [900, 300, -400] }],
    });
  });
  await frames(page);
  const center = await toRoom(page, [900, 300, -400]);
  expect(center[0]).toBeCloseTo(0, 3);
  expect(center[1]).toBeCloseTo(1.35, 3);
  expect(center[2]).toBeCloseTo(-0.55, 3);
  // Its 57.4 mm diagonal is shown 0.4 m across.
  expect((await read(page)).magnification).toBeCloseTo(400 / Math.hypot(10, 40, 40), 3);
});

test('tips the world over once Keep level is off, and stands it up again', async ({ page }) => {
  await setup(page);
  await enter(page);
  await click(page, 'level');
  const left: Vec = [-0.1, 1.2, -0.3],
    right: Vec = [0.1, 1.2, -0.3];
  await turn(page, 'right', [0, 0, 0, 1]);
  await place(page, 'left', left);
  await place(page, 'right', right);
  await press(page, 'left', 'squeeze');
  await press(page, 'right', 'squeeze');
  const held = [
    await toScene(page, await hand(page, 'left')),
    await toScene(page, await hand(page, 'right')),
  ];
  await move(page, 'right', right, add(right, [-0.03, 0.12, 0.02]));
  const tipped = await read(page);
  expect(Math.hypot(tipped.rig!.quaternion[0], tipped.rig!.quaternion[2])).toBeGreaterThan(0.1);
  // Free to tilt, the world stays in both hands exactly.
  const now = [
    await toScene(page, await hand(page, 'left')),
    await toScene(page, await hand(page, 'right')),
  ];
  now.forEach((point, k) => point.forEach((value, i) => expect(value).toBeCloseTo(held[k][i], 2)));
  await press(page, 'left', 'squeeze', false);
  await press(page, 'right', 'squeeze', false);

  await click(page, 'level');
  const level = await read(page);
  expect(level.rig!.quaternion[0]).toBeCloseTo(0, 6);
  expect(level.rig!.quaternion[2]).toBeCloseTo(0, 6);
  expect(level.magnification).toBeCloseTo(tipped.magnification, 6);
});
