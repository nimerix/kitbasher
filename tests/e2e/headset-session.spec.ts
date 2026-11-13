import { execSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Matrix4, Vector3 } from 'three';
import { sceneBounds } from '../../src/core/geometry';
import { createSample } from '../../src/core/sample';
import { frameRig, toRoom } from '../../src/core/xr';

// These run the program a person starts, with the built app, a browser on this computer, and
// an emulated headset that joins over the network address with the code.
const emulator = fileURLToPath(
  new URL('../../node_modules/iwer/build/iwer.min.js', import.meta.url),
);
const online = Object.values(networkInterfaces())
  .flat()
  .some((entry) => entry?.family === 'IPv4' && !entry.internal);

let host: ChildProcess;
let home: string;
let output = '';

test.beforeAll(() => {
  execSync('npx vite build && npx vite build --config vite.mcp.config.ts --mode headset', {
    stdio: 'pipe',
  });
});

test.beforeEach(async () => {
  test.skip(!online, 'Needs a network address for the headset to reach.');
  home = await mkdtemp(join(tmpdir(), 'kitbasher-e2e-headset-'));
  output = '';
  host = spawn(process.execPath, ['dist-mcp/kitbasher-headset.js', '--no-open'], {
    // The certificate is kept in the home folder, which here is not the real one.
    env: { ...process.env, HOME: home, USERPROFILE: home, KITBASHER_SHARE_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stdout!.on('data', (chunk) => (output += chunk));
  host.stderr!.on('data', (chunk) => (output += chunk));
  await expect.poll(() => output, { timeout: 15000 }).toContain('Press Ctrl+C');
});

test.afterEach(async () => {
  host?.kill();
  if (home) await rm(home, { recursive: true, force: true });
});

const printed = () => ({
  local: output.match(/On this computer\s+(http:\/\/\S+)/)![1],
  address: output.match(/In the headset\s+(https:\/\/\S+)/)![1],
  code: output
    .match(/Code\s+(\d{3}) (\d{3})/)!
    .slice(1)
    .join(''),
});

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

test('a headset joins with the code, and what it moves moves on the computer', async ({
  page,
  browser,
}) => {
  const { local, address, code } = printed();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(local);
  await expect(page.locator('.part-row')).toHaveCount(15);
  await expect(page.getByText('Shared session')).toBeVisible();

  // The computer has no headset of its own, so its button says how one joins.
  await page.locator('.headset-button').click();
  const how = page.getByRole('dialog', { name: 'Join from a headset' });
  await expect(how).toContainText(address);
  await expect(how).toContainText(`${code.slice(0, 3)} ${code.slice(3)}`);
  await page.keyboard.press('Escape');

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
  });
  const headset = await context.newPage();
  headset.on('pageerror', (error) => errors.push(error.message));
  await headset.addInitScript({ path: emulator });
  await headset.addInitScript(() => {
    const iwer = (window as any).IWER;
    const device = new iwer.XRDevice(iwer.metaQuest3);
    device.installRuntime({ forceInstall: true });
    (window as any).xrDevice = device;
    const requestSession = navigator.xr!.requestSession.bind(navigator.xr!);
    navigator.xr!.requestSession = async (...args) => {
      const session = await requestSession(...args);
      (window as any).xrSession = session;
      return session;
    };
  });
  await headset.goto(address);
  await headset.getByLabel('Code').fill(code === '123456' ? '654321' : '123456');
  await headset.getByRole('button', { name: 'Join' }).click();
  await expect(headset.getByRole('status')).toHaveText(/not the code/);
  await headset.getByLabel('Code').fill(code);
  await headset.getByRole('button', { name: 'Join' }).click();
  await expect(headset.locator('.part-row')).toHaveCount(15);
  await expect(headset.getByText('Shared session')).toBeVisible();

  await headset.locator('.headset-button').click();
  await headset.getByRole('menuitem', { name: 'Virtual space' }).click();
  await headset.waitForTimeout(800);

  // Where the sample's left arm is in the room, for eyes the emulator puts at 1.6 m.
  const rig = frameRig(new Matrix4().makeTranslation(0, 1.6, 0), sceneBounds(createSample().parts));
  const arm = toRoom(rig, new Vector3(-25, 60, 1)).toArray();
  const reach = 0.03;
  await headset.evaluate((position) => {
    const controller = (window as any).xrDevice.controllers.right;
    controller.position.set(...position);
  }, arm);
  await frames(headset);
  // The emulator positions the pointing ray. Put the physical grip at the arm instead.
  const start = await headset.evaluate(async (position) => {
    const session: XRSession = (window as any).xrSession;
    const space = await session.requestReferenceSpace('local-floor');
    return new Promise<number[]>((resolve) => {
      session.requestAnimationFrame((_time, frame) => {
        const source = [...session.inputSources].find((source) => source.handedness === 'right')!;
        const grip = frame.getPose(source.gripSpace!, space)!.transform.position;
        const ray = [2 * position[0] - grip.x, 2 * position[1] - grip.y, 2 * position[2] - grip.z];
        (window as any).xrDevice.controllers.right.position.set(...ray);
        resolve(ray);
      });
    });
  }, arm);
  await frames(headset);
  await headset.evaluate(() =>
    (window as any).xrDevice.controllers.right.updateButtonValue('trigger', 1),
  );
  await frames(headset);
  for (let i = 1; i <= 10; i++) {
    await headset.evaluate(
      ([position, offset]) =>
        (window as any).xrDevice.controllers.right.position.set(
          (position as number[])[0] - (offset as number),
          (position as number[])[1],
          (position as number[])[2],
        ),
      [start, (reach * i) / 10] as const,
    );
    await frames(headset, 1);
  }
  await frames(headset, 6);
  await headset.evaluate(() =>
    (window as any).xrDevice.controllers.right.updateButtonValue('trigger', 0),
  );
  await frames(headset, 6);

  // The arm follows the hand, away from the body, by 30 mm in the room.
  await page.locator('.part-select[title="Left arm"]').click();
  const x = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await expect
    .poll(async () => Number(await x.inputValue()))
    .toBeCloseTo(-25 - reach * rig.scale, 1);

  // Each side undoes its own work: the computer has nothing to undo, and the headset's
  // session ending leaves the computer's scene as it is.
  await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled();
  await context.close();
  await expect
    .poll(async () => Number(await x.inputValue()))
    .toBeCloseTo(-25 - reach * rig.scale, 1);
  expect(errors).toEqual([]);
});
