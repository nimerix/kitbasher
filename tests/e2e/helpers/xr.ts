import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { BoxGeometry, Quaternion, Vector3 } from 'three';
import { serializeGeometry } from '../../../src/core/geometry';
import type { AssemblyOperation, Tool } from '../../../src/core/types';

const emulator = fileURLToPath(
  new URL('../../../node_modules/iwer/build/iwer.min.js', import.meta.url),
);
const geometry = serializeGeometry(new BoxGeometry(16, 16, 6, 8, 8, 2));
const fixture = {
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'VR editor controls',
  joints: [],
  parts: [-22, 22].map((x, index) => ({
    id: index ? 'target' : 'source',
    name: index ? 'Target' : 'Source',
    geometry,
    position: [x, 20, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#aabbcc',
    visible: true,
    locked: false,
    source: 'test',
  })),
};
export type Vec = [number, number, number];
export type Hand = 'left' | 'right';

export async function setup(page: Page) {
  await page.addInitScript({ path: emulator });
  await page.addInitScript(() => {
    const iwer = (window as any).IWER;
    const device = new iwer.XRDevice(iwer.metaQuest3);
    device.installRuntime({ forceInstall: true });
    (window as any).xrDevice = device;
  });
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'xr-controls.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await expect(page.locator('.part-row')).toHaveCount(2);
  await page.locator('.headset-button').click();
  await page.getByRole('menuitem', { name: 'Virtual space' }).click();
  await expect.poll(() => read(page).then((state) => state.placed)).toBe(true);
  // Keep the palette well to the left of the parts and panel for repeatable ray picking.
  await place(page, 'left', [-0.35, 1.15, -0.25]);
  await frames(page);
}

export const frames = (page: Page, count = 4) =>
  page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const step = (left: number) =>
          left ? requestAnimationFrame(() => step(left - 1)) : resolve();
        step(count);
      }),
    count,
  );

export function read(page: Page) {
  return page.evaluate(async () => {
    const storeUrl = '/src/core/store.ts',
      xrUrl = '/src/core/xr-session.ts',
      inputUrl = '/src/core/xr-input.ts';
    const { useEditor } = await import(storeUrl),
      { useXR } = await import(xrUrl),
      { useXRInput } = await import(inputUrl);
    const state = useEditor.getState(),
      runtime = useXR.getState().runtime;
    return {
      placed: !!runtime?.placed,
      tool: state.tool as Tool,
      operation: state.operation as AssemblyOperation,
      selected: state.selected as string[],
      brushRadius: state.brushRadius as number,
      painting: state.painting as boolean,
      brushErase: state.brushErase as boolean,
      paintHistory: state.paintHistory.length as number,
      past: state.past.length as number,
      precision: runtime?.precision as boolean,
      wristVisible: runtime?.wrist.object.visible as boolean,
      parts: state.scene.parts.map((part: any) => ({
        id: part.id as string,
        position: part.position as Vec,
        quaternion: part.quaternion as [number, number, number, number],
        scale: part.scale as Vec,
      })) as {
        id: string;
        position: Vec;
        quaternion: [number, number, number, number];
        scale: Vec;
      }[],
      settings: useXRInput.getState().settings,
      level: useXR.getState().settings.level as boolean,
      rig: runtime
        ? {
            position: runtime.rig.position.toArray() as Vec,
            quaternion: runtime.rig.quaternion.toArray() as [number, number, number, number],
            scale: runtime.rig.scale as number,
          }
        : null,
    };
  });
}

export const place = (page: Page, hand: Hand, position: Vec) =>
  page.evaluate(
    ({ hand, position }) => {
      (window as any).xrDevice.controllers[hand].position.set(...position);
    },
    { hand, position },
  );

export const aim = (page: Page, hand: Hand, target: Vec) =>
  page.evaluate(
    ({ hand, target }) => {
      const controller = (window as any).xrDevice.controllers[hand],
        from = controller.position;
      const d = [target[0] - from.x, target[1] - from.y, target[2] - from.z],
        length = Math.hypot(...d);
      const q = [d[1] / length, -d[0] / length, 0, 1 - d[2] / length],
        norm = Math.hypot(...q);
      controller.quaternion.set(q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm);
    },
    { hand, target },
  );

export async function press(page: Page, hand: Hand, button: string, down: boolean) {
  await page.evaluate(
    ({ hand, button, down }) =>
      (window as any).xrDevice.controllers[hand].updateButtonValue(button, down ? 1 : 0),
    { hand, button, down },
  );
  await frames(page);
}
export async function tap(page: Page, hand: Hand, button: string) {
  await press(page, hand, button, true);
  await press(page, hand, button, false);
}

export async function clickControl(
  page: Page,
  surface: 'panel' | 'wrist',
  action: string,
  hand: Hand = 'right',
) {
  const target: Vec = await page.evaluate(
    async ({ surface, action }) => {
      const url = '/src/core/xr-session.ts';
      const { useXR } = await import(url);
      const center = useXR.getState().runtime[surface].center(action);
      if (!center) throw new Error(`No ${surface} control for ${action}`);
      return center.toArray();
    },
    { surface, action },
  );
  const eyes: Vec = [0, 1.6, 0];
  await place(page, hand, target.map((value, i) => value + (eyes[i] - value) * 0.3) as Vec);
  await aim(page, hand, target);
  await frames(page);
  await tap(page, hand, 'trigger');
}

export async function aimAtScene(page: Page, point: Vec) {
  const { rig } = await read(page);
  const target = new Vector3(...point)
    .sub(new Vector3(...rig!.position))
    .applyQuaternion(new Quaternion(...rig!.quaternion).invert())
    .divideScalar(rig!.scale)
    .toArray();
  await place(page, 'right', [target[0], target[1], target[2] + 0.12]);
  await aim(page, 'right', target);
  await frames(page);
}

export async function stick(page: Page, hand: Hand, x: number, y: number, count = 14) {
  await page.evaluate(
    ({ hand, x, y }) => (window as any).xrDevice.controllers[hand].updateAxes('thumbstick', x, y),
    { hand, x, y },
  );
  await frames(page, count);
  await page.evaluate(
    (hand) => (window as any).xrDevice.controllers[hand].updateAxes('thumbstick', 0, 0),
    hand,
  );
  await frames(page);
}

/** Keep readable headset textures with the test artifacts for layout review. */
export async function attachControls(page: Page, label: string) {
  const textures = await page.evaluate(async () => {
    const url = '/src/core/xr-session.ts';
    const { useXR } = await import(url);
    const { panel, wrist } = useXR.getState().runtime;
    return { panel: panel.canvas.toDataURL(), wrist: wrist.canvas.toDataURL() };
  });
  for (const [surface, data] of Object.entries(textures)) {
    const path = test.info().outputPath(`${label}-${surface}.png`);
    await writeFile(path, Buffer.from(data.split(',')[1], 'base64'));
    await test.info().attach(`${label}-${surface}`, {
      path,
      contentType: 'image/png',
    });
  }
}
