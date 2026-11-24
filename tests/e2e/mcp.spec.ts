import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { BoxGeometry, Mesh } from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { serializeGeometry } from '../../src/core/geometry';
import { queueAfterPenRelease } from './helpers/sculpt';
import { readSavedScene } from './saved-scene';

// These drive the bundle a client would really start, over real stdio, with the real app.
let folder: string;
let client: Client;
let transport: StdioClientTransport;

/** Calls a tool, returning its JSON with any note about changes made in a tab. */
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const texts = (result.content as { type: string; text?: string }[])
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text!);
  if (result.isError) throw new Error(`${name}: ${texts.join('\n')}`);
  const notes = texts.slice(1).map((text) => JSON.parse(text).user_changes);
  return notes.length ? { ...JSON.parse(texts[0]), user_changes: notes[0] } : JSON.parse(texts[0]);
};

const model = [
  {
    name: 'Agent base',
    color: '#41474a',
    position: [0, 5, 0],
    shapes: [{ type: 'box', size: [80, 10, 80], corner_radius: 2 }],
  },
  {
    name: 'Agent column',
    position: [0, 40, 0],
    shapes: [
      { type: 'cylinder', radius: 8, height: 60, color: '#c7c3b6' },
      { type: 'sphere', radius: 11, position: [0, 32, 0], color: '#ce8050' },
    ],
  },
];

test.beforeAll(() => {
  execSync('npx vite build && npm run build:mcp', { stdio: 'pipe' });
});

test.beforeEach(async ({}, testInfo) => {
  folder = await mkdtemp(join(tmpdir(), 'kitbasher-e2e-mcp-'));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist-mcp/kitbasher-mcp.js'],
    stderr: 'ignore',
    ...(testInfo.title.startsWith('native mesh') ? { env: { KITBASHER_NATIVE_MESH: 'all' } } : {}),
    ...(testInfo.title.startsWith('parallel indexes')
      ? { env: { KITBASHER_CROSS_ORIGIN_ISOLATED: '1' } }
      : {}),
  });
  client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(transport);
});

test.afterEach(async () => {
  await client.close();
  await rm(folder, { recursive: true, force: true });
});

const part = (name: string) => `.part-select[title="${name}"]`;

test('parallel indexes work in the built live host with unindexed scan data', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { url } = await call('open_live_view', { open_browser: false });
  await page.goto(url);
  await expect(page.locator('canvas')).toBeVisible();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    (window as any).parallel = { started: 0, completed: 0 };
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes('parallelMeshBVH.worker')) {
          (window as any).parallel.started++;
          this.addEventListener('message', (event) => {
            if (event.data.serialized) (window as any).parallel.completed++;
          });
        }
      }
    };
  });
  const geometry = new BoxGeometry(10, 8, 6, 210, 210, 210);
  const data = new STLExporter().parse(new Mesh(geometry), { binary: true });
  await page.getByRole('button', { name: 'Import parts', exact: true }).click();
  await page.getByLabel('Choose model files').setInputFiles({
    name: 'Dense box.stl',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(data.buffer),
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Import parts', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).parallel), { timeout: 20_000 })
    .toEqual({ started: 1, completed: 1 });
  expect(errors).toEqual([]);
  geometry.dispose();
});

test('native mesh previews remain unapplied until confirmed in the live editor', async ({
  page,
}) => {
  test.skip(
    !existsSync(`dist-mcp/kitbasher-mesh-native${process.platform === 'win32' ? '.exe' : ''}`),
    'Run build:native to test the optional helper.',
  );
  await call('add_parts', {
    parts: [{ id: 'block', name: 'Native block', shapes: [{ type: 'box', size: [10, 8, 6] }] }],
  });
  const { url } = await call('open_live_view', { open_browser: false });
  await page.goto(url);
  await page.locator(part('Native block')).click();
  await page.getByRole('button', { name: 'Decimate or remesh…' }).click();
  await page.getByRole('radio', { name: 'Voxel remesh' }).click();
  await page.getByLabel('Voxel resolution').fill('24');
  const response = page.waitForResponse((response) => response.url().endsWith('/live/process'));
  await page.getByRole('button', { name: 'Prepare mesh' }).click();
  expect((await response).headers()['x-kitbasher-backend']).toBe('native');
  await expect(page.getByRole('button', { name: 'Add processed copy' })).toBeEnabled();
  expect((await call('get_scene')).parts).toHaveLength(1);
  await page.getByRole('button', { name: 'Add processed copy' }).click();
  await expect.poll(async () => (await call('get_scene')).parts.length).toBe(2);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await call('get_scene')).parts.length).toBe(1);
});

test('free placement publishes only confirmed poses and yields to a shared scene update', async ({
  page,
}) => {
  await call('add_parts', { parts: model });
  const { url } = await call('open_live_view', { open_browser: false });
  await page.goto(url);
  await page.locator(part('Agent column')).click();
  const field = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await expect(field).toHaveValue('0');
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  const box = (await page.locator('canvas').boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const position = async () =>
    (await call('get_scene')).parts.find((p: { id: string }) => p.id === 'agent-column').position;
  let edits = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/live/edit')) edits++;
  });
  await page.mouse.move(start.x, start.y);
  await page.keyboard.press('Shift+g');
  await page.mouse.move(start.x + 60, start.y, { steps: 8 });
  await expect(field).not.toHaveValue('0');
  expect(await position()).toEqual([0, 40, 0]);
  expect(edits).toBe(0);
  await page.mouse.click(start.x + 60, start.y, { button: 'right' });
  await expect(field).toHaveValue('0');
  expect(await position()).toEqual([0, 40, 0]);
  expect(edits).toBe(0);

  await page.mouse.move(start.x, start.y);
  await page.keyboard.press('Shift+g');
  await page.mouse.move(start.x + 60, start.y, { steps: 8 });
  const wanted = Number(await field.inputValue());
  await page.keyboard.press('Enter');
  await expect.poll(async () => Math.abs((await position())[0] - wanted)).toBeLessThan(0.001);
  expect(edits).toBe(1);
  await expect(page.getByRole('button', { name: /^Undo \((⌘|Ctrl)\+Z\)$/ })).toBeEnabled();
  await page.keyboard.press('Control+z');
  await expect(field).toHaveValue('0');
  expect(await position()).toEqual([0, 40, 0]);

  await page.mouse.move(start.x, start.y);
  await page.keyboard.press('Shift+g');
  await page.mouse.move(start.x + 35, start.y, { steps: 6 });
  await call('update_parts', { updates: [{ id: 'agent-base', translate: [0, 0, 30] }] });
  await expect(page.locator('.free-transform-prompt')).toHaveCount(0);
  await expect(field).toHaveValue('0');
  expect(await position()).toEqual([0, 40, 0]);
});

test('a scene saved through MCP opens in the app', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await call('add_parts', { parts: model });
  await call('create_joint', {
    child: 'agent-column',
    parent: 'agent-base',
    child_anchor: { local: [0, -30, 0] },
    parent_anchor: { face: '+y' },
  });
  const file = join(folder, 'agent.kitbash');
  await call('save_scene', { path: file });

  await page.goto('/');
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'agent.kitbash',
    mimeType: 'application/octet-stream',
    buffer: await readFile(file),
  });
  await expect(page.getByText('2 parts · 1 joints')).toBeVisible();
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await expect(page.locator('.part-row')).toHaveCount(2);
  await page.locator(part('Agent column')).click();
  await expect(page.getByRole('spinbutton', { name: 'Position Y', exact: true })).toHaveValue('40');
  expect(errors).toEqual([]);
});

test('the live view shows the agent’s changes in the real app', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const meshes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/live/geometry/')) meshes.push(request.url());
  });
  await call('new_scene', { name: 'Watched build' });
  const { url, viewers } = await call('open_live_view', { open_browser: false });
  expect(viewers).toBe(0);

  await page.goto(url);
  await expect(page.getByText('Shared with agent')).toBeVisible();
  await expect(page.locator('.part-row')).toHaveCount(0);

  await call('add_parts', { parts: [model[0]] });
  await expect(page.locator(part('Agent base'))).toBeVisible();
  await expect(page.getByText('Watched build').first()).toBeVisible();
  await expect.poll(() => meshes.length).toBe(1);

  await call('add_parts', { parts: [model[1]] });
  await expect(page.locator(part('Agent column'))).toBeVisible();
  await expect.poll(() => meshes.length).toBe(2);

  // A later change resends metadata only, and the tab shows the new pose.
  await page.locator(part('Agent column')).click();
  await call('update_parts', { updates: [{ id: 'agent-column', position: [11, 40, 0] }] });
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('11');
  expect(meshes).toHaveLength(2);

  // Parts follow a removal and its undo, and the selection stays valid.
  await call('delete_parts', { ids: ['agent-column'] });
  await expect(page.locator('.part-row')).toHaveCount(1);
  await call('undo');
  await expect(page.locator('.part-row')).toHaveCount(2);

  // A copy shares its mesh, so it fetches nothing new.
  const before = meshes.length;
  await call('duplicate_parts', { ids: ['agent-column'], translate: [30, 0, 0] });
  await expect(page.locator('.part-row')).toHaveCount(3);
  expect(meshes.length).toBe(before);

  // A shared scene belongs to the server, so the tab leaves its own autosave alone.
  const saved = await page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open('kitbasher-workbench', 2);
        open.onupgradeneeded = () => {
          open.result.createObjectStore('scenes');
          open.result.createObjectStore('geometries');
        };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction('scenes').objectStore('scenes').get('current');
          get.onsuccess = () => {
            open.result.close();
            resolve(get.result ?? null);
          };
        };
      }),
  );
  expect(saved).toBeNull();

  // The tab says so when the agent has gone, and keeps the last scene.
  const pid = transport.pid!;
  await client.close();
  await expect(page.getByText('Agent disconnected')).toBeVisible();
  await expect(page.locator('.part-row')).toHaveCount(3);
  // The server does not linger just because a browser tab is still connected.
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return 'running';
      } catch {
        return 'exited';
      }
    })
    .toBe('exited');
  expect(errors).toEqual([]);
});

test('the live view frames a new scene, then leaves a moved camera alone', async ({ page }) => {
  await call('add_parts', { parts: [model[0]] });
  const { url } = await call('open_live_view', { open_browser: false });
  await page.goto(url);
  await expect(page.locator(part('Agent base'))).toBeVisible();
  // Shadows fit the scene's bounds, so leave them out of a comparison of the camera alone.
  await page.getByRole('button', { name: /^Display:/ }).click();
  await page.getByRole('button', { name: 'Edit lights…' }).click();
  await page.getByRole('switch', { name: 'Shadows', exact: true }).click();
  await page.getByRole('button', { name: 'Close lighting' }).click();
  await page.waitForTimeout(400);
  const framed = await page.locator('canvas').first().screenshot();

  // Taking the camera stops automatic framing as the model grows.
  await page.locator('canvas').first().hover();
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(400);
  const zoomed = await page.locator('canvas').first().screenshot();
  expect(zoomed.equals(framed)).toBe(false);
  await call('add_parts', {
    parts: [{ ...model[1], name: 'Far part', position: [4000, 40, 0] }],
  });
  await expect(page.locator(part('Far part'))).toBeVisible();
  await page.waitForTimeout(400);
  const after = await page.locator('canvas').first().screenshot();
  expect(after.equals(zoomed)).toBe(true);
});

const tetrahedron = Buffer.from(
  'solid tetra\nfacet normal 0 0 -1\nouter loop\nvertex 0 0 0\nvertex 0 10 0\nvertex 10 0 0\nendloop\nendfacet\nfacet normal 0 -1 0\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 0 10\nendloop\nendfacet\nfacet normal -1 0 0\nouter loop\nvertex 0 0 0\nvertex 0 0 10\nvertex 0 10 0\nendloop\nendfacet\nfacet normal 1 1 1\nouter loop\nvertex 10 0 0\nvertex 0 10 0\nvertex 0 0 10\nendloop\nendfacet\nendsolid tetra',
);

test('tabs and the agent edit one scene, each with its own view', async ({ browser }) => {
  await call('add_parts', { parts: model });
  const { url } = await call('open_live_view', { open_browser: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const first = await context.newPage();
  const second = await context.newPage();
  const errors: string[] = [];
  const edits = new Map<Page, number>();
  const uploads: string[] = [];
  for (const page of [first, second]) {
    edits.set(page, 0);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.url().endsWith('/live/edit')) edits.set(page, edits.get(page)! + 1);
      if (request.method() === 'POST' && request.url().includes('/live/geometry/'))
        uploads.push(request.url());
    });
    await page.goto(url);
    await expect(page.getByText('Shared with agent')).toBeVisible();
    await expect(page.locator('.part-row')).toHaveCount(2);
  }
  const field = (page: Page, axis: string) =>
    page.getByRole('spinbutton', { name: `Position ${axis}`, exact: true });
  const positionOf = (scene: { parts: { id: string; position: number[] }[] }, id: string) =>
    scene.parts.find((p) => p.id === id)!.position;

  // A change in one tab reaches the other tab and the agent, which is told about it.
  await first.locator(part('Agent column')).click();
  await field(first, 'X').fill('25');
  await field(first, 'X').press('Enter');
  await second.locator(part('Agent column')).click();
  await expect(field(second, 'X')).toHaveValue('25');
  const seen = await call('get_scene');
  expect(positionOf(seen, 'agent-column')).toEqual([25, 40, 0]);
  expect(seen.user_changes).toEqual({ parts_changed: ['agent-column'] });

  // Looking around in one tab sends nothing, and moves no other view.
  const sent = [...edits.values()];
  const otherView = await second.locator('canvas').first().screenshot();
  const canvas = first.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  await canvas.hover();
  await first.mouse.wheel(0, 500);
  await first.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await first.mouse.down({ button: 'middle' });
  await first.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 50, { steps: 8 });
  await first.mouse.up({ button: 'middle' });
  await first.waitForTimeout(400);
  expect([...edits.values()]).toEqual(sent);
  expect((await second.locator('canvas').first().screenshot()).equals(otherView)).toBe(true);
  expect((await call('get_scene')).user_changes).toBeUndefined();

  // The agent's change reaches both tabs, whatever each has selected.
  await second.locator(part('Agent base')).click();
  await call('update_parts', { updates: [{ id: 'agent-base', translate: [0, 0, 30] }] });
  await expect(field(second, 'Z')).toHaveValue('30');
  await expect(field(first, 'X')).toHaveValue('25');

  // Undo in a tab reverts that tab's change, and the agent's undo reverts the agent's.
  await first.getByRole('button', { name: /^Undo \((⌘|Ctrl)\+Z\)$/ }).click();
  await expect(field(first, 'X')).toHaveValue('0');
  const undone = await call('get_scene');
  expect(positionOf(undone, 'agent-column')).toEqual([0, 40, 0]);
  expect(positionOf(undone, 'agent-base')).toEqual([0, 5, 30]);
  await call('undo');
  await expect(field(second, 'Z')).toHaveValue('0');
  await expect(field(first, 'X')).toHaveValue('0');
  await first.locator(part('Agent column')).click();
  await first.keyboard.press('ControlOrMeta+Shift+z');
  await expect(field(first, 'X')).toHaveValue('25');
  await expect(first.getByRole('button', { name: /^Redo \((⌘|Ctrl)\+Shift\+Z\)$/ })).toBeDisabled();

  // A model imported in a tab sends its mesh once, and the agent can work with it.
  await first.getByRole('button', { name: 'Import parts', exact: true }).click();
  await first.getByLabel('Choose model files').setInputFiles({
    name: 'tetra.stl',
    mimeType: 'model/stl',
    buffer: tetrahedron,
  });
  await first
    .getByRole('dialog')
    .getByRole('button', { name: 'Import parts', exact: true })
    .click();
  await expect(second.locator('.part-row')).toHaveCount(3);
  expect(uploads).toHaveLength(1);
  const imported = await call('get_scene');
  expect(imported.user_changes.parts_added).toHaveLength(1);
  const [id] = imported.user_changes.parts_added;
  const placed = await call('place_parts', {
    placements: [{ id, target: 'agent-base', side: '+y' }],
  });
  expect(placed.placed[0].bounds.min[1]).toBeCloseTo(10, 4);
  await second.locator('.part-select[title="tetra"]').click();
  await expect(field(second, 'Y')).not.toHaveValue('0');
  expect(errors).toEqual([]);
  await context.close();
});

test('refusing an ordinary shared edit discards its queued undo', async ({ page }) => {
  await call('add_parts', { parts: model });
  const { url } = await call('open_live_view', { open_browser: false });
  await page.goto(url);
  await expect(page.getByText('Shared with agent')).toBeVisible();
  const undo = page.getByRole('button', { name: /^Undo \((⌘|Ctrl)\+Z\)$/ });
  const rename = async (name: string) => {
    await page.getByTitle('Rename assembly').click();
    const field = page.getByRole('textbox', { name: 'Assembly name' });
    await field.fill(name);
    await field.press('Enter');
  };
  await rename('Accepted assembly name');
  await expect(undo).toBeEnabled();

  let reject = () => {};
  const held = new Promise<void>((resolve) => {
    reject = resolve;
  });
  const edit = /\/live\/edit$/;
  await page.route(edit, async (route) => {
    await held;
    await route.fulfill({ status: 409, json: { error: 'Edit refused for this test.' } });
  });
  const submitted = page.waitForRequest(edit);
  await rename('Refused assembly name');
  await submitted;
  const undoRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/live\/undo$/.test(request.url())) undoRequests.push(request.url());
  });
  await undo.click();
  reject();
  await expect(page.getByText(/edit refused for this test/i)).toBeVisible();
  await expect(page.getByTitle('Rename assembly')).toHaveText('Accepted assembly name');

  await page.unroute(edit);
  const nextEdit = page.waitForResponse(edit);
  await rename('New assembly name');
  expect((await nextEdit).ok()).toBe(true);
  expect(undoRequests).toEqual([]);
});

for (const replaceScene of [false, true]) {
  test(
    replaceScene
      ? 'discards commands from a queued preview when the shared scene is replaced'
      : 'discards the queued Undo when a shared stroke refusal closes a preview',
    async ({ page }) => {
      await call('add_parts', {
        parts: [{ id: 'block', name: 'Sculpt block', shapes: [{ type: 'box', size: [10, 8, 6] }] }],
      });
      const { url } = await call('open_live_view', { open_browser: false });
      await page.goto(url);
      const title = page.getByTitle('Rename assembly');
      const originalName = 'Untitled assembly';
      await expect(title).toHaveText(originalName);
      const acceptedName = 'Accepted assembly name';
      const rename = async (name: string) => {
        await title.click();
        const field = page.getByRole('textbox', { name: 'Assembly name' });
        await field.fill(name);
        await field.press('Enter');
      };
      await rename(acceptedName);
      await expect(page.getByRole('button', { name: /^Undo \((⌘|Ctrl)\+Z\)$/ })).toBeEnabled();
      await page.locator(part('Sculpt block')).click();
      await page.keyboard.press('1');
      await page.keyboard.press('Home');
      await page.getByRole('button', { name: 'Sculpt', exact: true }).click();
      const canvas = (await page.locator('canvas').boundingBox())!;
      const point = { x: canvas.x + canvas.width / 2 + 8, y: canvas.y + canvas.height / 2 - 7 };

      let rejectStroke = () => {};
      const held = new Promise<void>((resolve) => {
        rejectStroke = resolve;
      });
      const edit = /\/live\/edit$/;
      await page.route(edit, async (route) => {
        if (!route.request().postDataJSON().sculpt) return route.continue();
        await held;
        await route.fulfill({ status: 409, json: { error: 'Stroke refused for this test.' } });
      });
      let undoRequests = 0;
      page.on('request', (request) => {
        if (request.url().endsWith('/live/undo')) undoRequests++;
      });
      const submitted = page.waitForRequest(edit);
      await queueAfterPenRelease(page, point, [
        { key: 'G', code: 'KeyG', shiftKey: true },
        { key: 'z', code: 'KeyZ', ctrlKey: true },
        { key: 'F1', code: 'F1' },
      ]);
      expect((await submitted).postDataJSON().sculpt).toBeTruthy();
      const prompt = page.locator('.free-transform-prompt');
      const help = page.getByRole('dialog', { name: 'A workbench that gets out of your way.' });
      await expect(prompt).toBeVisible();
      if (replaceScene) {
        await call('new_scene', { name: 'Replacement', discard_unsaved: true });
        await expect(title).toHaveText('Replacement');
        await expect(prompt).toHaveCount(0);
        const renamed = page.waitForResponse(
          (response) =>
            edit.test(response.url()) &&
            response.request().postDataJSON().scene.name === 'Newer rename',
          { timeout: 8000 },
        );
        await rename('Newer rename');
        await expect(title).toHaveText('Newer rename');
        rejectStroke();
        expect((await renamed).ok()).toBe(true);
        expect((await call('get_scene')).name).toBe('Newer rename');
        await expect(help).toHaveCount(0);
        expect(undoRequests).toBe(0);
      } else {
        rejectStroke();
        await expect(page.getByText(/stroke refused for this test/i)).toBeVisible();
        await expect(prompt).toHaveCount(0);
        // A later non-history command still runs after the refused stroke rolls back.
        await expect(help).toBeVisible();
        await expect(title).toHaveText(acceptedName);
        expect(undoRequests).toBe(0);
        await help.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await page.keyboard.press('ControlOrMeta+z');
        await expect(title).toHaveText(originalName);
        expect(undoRequests).toBe(1);
      }
    },
  );
}

test('publishes Delete queued behind a stroke interrupted by a shared pose update', async ({
  page,
}) => {
  await call('add_parts', {
    parts: [{ id: 'block', name: 'Sculpt block', shapes: [{ type: 'box', size: [10, 8, 6] }] }],
  });
  const { url } = await call('open_live_view', { open_browser: false });
  await page.goto(url);
  await page.locator(part('Sculpt block')).click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: 'Sculpt', exact: true }).click();
  const radius = page.getByRole('spinbutton', { name: 'Radius', exact: true });
  await radius.fill('0.12');
  await radius.press('Enter');
  const box = (await page.locator('canvas').boundingBox())!;
  const start = { x: box.x + box.width / 2 - 55, y: box.y + box.height / 2 - 7 };
  const edit = page.waitForResponse(
    (response) =>
      response.url().endsWith('/live/edit') && !response.request().postDataJSON().sculpt,
    { timeout: 5000 },
  );
  await queueAfterPenRelease(page, start, [{ key: 'Delete', code: 'Delete' }], {
    end: { x: start.x + 140, y: start.y },
    releaseClockOn: 'resume-sculpt-clock',
  });
  try {
    await call('update_parts', { updates: [{ id: 'block', translate: [2, 0, 0] }] });
    await expect(page.locator(part('Sculpt block'))).toHaveCount(0);
    expect((await edit).ok()).toBe(true);
    expect((await call('get_scene')).parts).toHaveLength(0);
  } finally {
    await page.evaluate(() => window.dispatchEvent(new Event('resume-sculpt-clock')));
  }
});

for (const replyOrder of ['HTTP first', 'stream first', 'stream then HTTP error'] as const) {
  test(`keeps a stroke and queued Save when acknowledging a replacement with ${replyOrder}`, async ({
    page,
  }) => {
    const holdResponse = replyOrder !== 'HTTP first';
    await page.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          this.addEventListener('scene', (event) => {
            const { version } = JSON.parse(event.data);
            const { dataset } = document.documentElement;
            dataset.sharedVersion = String(version);
            if (dataset.holdShared === '1') {
              event.stopImmediatePropagation();
              window.addEventListener(
                'release-shared-scene',
                () => this.dispatchEvent(new MessageEvent('scene', { data: event.data })),
                { once: true },
              );
            }
          });
        }
      };
    });
    await call('add_parts', {
      parts: [{ id: 'old', name: 'Old block', shapes: [{ type: 'box', size: [10, 8, 6] }] }],
    });
    const { url } = await call('open_live_view', { open_browser: false });
    await page.goto(url);
    await expect(page.locator(part('Old block'))).toBeVisible();
    const geometry = new BoxGeometry(10, 8, 6);
    const openedScene = {
      format: 'kitbasher',
      version: 1,
      units: 'mm',
      name: 'Opened scene',
      joints: [],
      parts: [
        {
          id: 'new',
          name: 'New block',
          geometry: serializeGeometry(geometry),
          position: [0, 0, 0],
          quaternion: [0, 0, 0, 1],
          scale: [1, 1, 1],
          color: '#cccccc',
          visible: true,
          locked: false,
          source: 'block',
        },
      ],
    };
    let submit = () => {};
    let reply = () => {};
    const submitted = new Promise<void>((resolve) => {
      submit = resolve;
    });
    const answered = new Promise<void>((resolve) => {
      reply = resolve;
    });
    const edit = /\/live\/edit$/;
    let replacementVersion = 0;
    await page.route(edit, async (route) => {
      if (!route.request().postDataJSON().replace) return route.continue();
      await submitted;
      const response = await route.fetch();
      replacementVersion = (await response.json()).version;
      if (holdResponse) await answered;
      if (replyOrder === 'stream then HTTP error')
        await route.fulfill({ status: 502, json: { error: 'Replacement response was lost.' } });
      else await route.fulfill({ response });
    });
    await page.getByLabel('Open Kitbasher scene').setInputFiles({
      name: 'opened.kitbash',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(openedScene)),
    });
    const opening = page.waitForRequest(
      (request) => edit.test(request.url()) && request.postDataJSON().replace,
    );
    await page.getByRole('button', { name: 'Open scene', exact: true }).click();
    const original = await opening;
    await page.locator(part('New block')).click();
    await page.keyboard.press('1');
    await page.keyboard.press('Home');
    await page.getByRole('button', { name: 'Sculpt', exact: true }).click();
    const box = (await page.locator('canvas').boundingBox())!;
    await queueAfterPenRelease(
      page,
      { x: box.x + box.width / 2 + 8, y: box.y + box.height / 2 - 7 },
      [
        { key: 'G', code: 'KeyG', shiftKey: true },
        { key: 's', code: 'KeyS', ctrlKey: true },
      ],
    );
    const prompt = page.locator('.free-transform-prompt');
    await expect(prompt).toBeVisible();
    const response = page.waitForResponse((result) => result.request() === original);
    const acceptedStroke = page
      .waitForResponse(
        (result) => edit.test(result.url()) && !!result.request().postDataJSON().sculpt,
        { timeout: 8000 },
      )
      .catch(() => null);
    if (!holdResponse)
      await page.evaluate(() => {
        document.documentElement.dataset.holdShared = '1';
      });
    submit();
    if (!holdResponse) expect((await response).ok()).toBe(true);
    await expect.poll(() => replacementVersion).toBeGreaterThan(0);
    await expect(page.locator('html')).toHaveAttribute(
      'data-shared-version',
      String(replacementVersion),
    );
    if (holdResponse) {
      reply();
      expect((await response).status()).toBe(replyOrder === 'stream then HTTP error' ? 502 : 200);
    } else {
      await page.evaluate(() => {
        delete document.documentElement.dataset.holdShared;
        window.dispatchEvent(new Event('release-shared-scene'));
      });
    }
    expect((await acceptedStroke)?.ok()).toBe(true);
    await expect(prompt).toBeVisible();
    const download = page.waitForEvent('download');
    await page.keyboard.press('Escape');
    const saved = await download;
    const { scene } = await readSavedScene((await saved.path())!);
    expect(scene.name).toBe('Opened scene');
    const sculpted = scene.parts[0].geometry;
    expect(sculpted.index?.count ?? sculpted.getAttribute('position').count).toBeGreaterThan(36);
    geometry.dispose();
  });
}

for (const loseReply of [false, true]) {
  test(
    loseReply
      ? 'preserves the newer shared scene after a replacement loses both acknowledgments'
      : 'rejects an in-flight Open after another editor replaces the shared scene',
    async ({ page }) => {
      const openedName = 'Opened by this tab';
      if (loseReply)
        await page.addInitScript((name) => {
          const NativeEventSource = window.EventSource;
          window.EventSource = class extends NativeEventSource {
            constructor(url: string | URL, init?: EventSourceInit) {
              super(url, init);
              this.addEventListener('scene', (event) => {
                if (JSON.parse(event.data).scene.name === name) event.stopImmediatePropagation();
              });
            }
          };
        }, openedName);
      const { url } = await call('open_live_view', { open_browser: false });
      await page.goto(url);
      const title = page.getByTitle('Rename assembly');
      await expect(title).toHaveText('Untitled assembly');

      let resume = () => {};
      const held = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const edit = /\/live\/edit$/;
      let replacements = 0;
      await page.route(edit, async (route) => {
        if (!route.request().postDataJSON().replace || ++replacements !== 1)
          return route.continue();
        if (loseReply) {
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          await route.abort('connectionreset');
        } else {
          await held;
          await route.continue();
        }
      });
      const submitted = page.waitForRequest(edit);
      await page.getByLabel('Open Kitbasher scene').setInputFiles({
        name: 'opened.kitbash',
        mimeType: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({
            format: 'kitbasher',
            version: 1,
            units: 'mm',
            name: openedName,
            parts: [],
            joints: [],
          }),
        ),
      });
      await page.getByRole('button', { name: 'Open scene', exact: true }).click();
      const request = await submitted;
      if (loseReply) {
        await expect(page.getByText(/Agent disconnected/)).toBeVisible();
        expect((await call('get_scene')).name).toBe(openedName);
      }
      const newer = 'Newer shared scene';
      await call('new_scene', { name: newer, discard_unsaved: true });
      await expect(title).toHaveText(newer);
      if (!loseReply) {
        const response = page.waitForResponse((result) => result.request() === request);
        resume();
        expect((await response).status()).toBe(409);
      }
      await title.click();
      const field = page.getByRole('textbox', { name: 'Assembly name' });
      await field.fill('Edit on the newer scene');
      const renamed = page.waitForResponse(
        (result) => edit.test(result.url()) && !result.request().postDataJSON().replace,
      );
      await field.press('Enter');
      expect((await renamed).ok()).toBe(true);
      expect((await call('get_scene')).name).toBe('Edit on the newer scene');
      expect(replacements).toBe(1);
    },
  );
}

test('shared sculpt strokes keep their checkpoints and refuse a stale target pose', async ({
  page,
}) => {
  await call('add_parts', {
    parts: [{ id: 'block', name: 'Sculpt block', shapes: [{ type: 'box', size: [10, 8, 6] }] }],
  });
  const { url } = await call('open_live_view', { open_browser: false });
  await page.goto(url);
  await page.locator(part('Sculpt block')).click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: 'Sculpt', exact: true }).click();
  const radius = page.getByRole('spinbutton', { name: 'Radius', exact: true });
  await radius.fill('1.5');
  await radius.press('Enter');

  const canvas = await page.locator('canvas').boundingBox();
  expect(canvas).not.toBeNull();
  const x = canvas!.x + canvas!.width / 2;
  const y = canvas!.y + canvas!.height / 2;
  const editUrl = /\/live\/edit$/;
  const ofSculpt = (request: { postDataJSON: () => { sculpt?: unknown } }) =>
    !!request.postDataJSON().sculpt;

  let unpause = () => {};
  let blocked = new Promise<void>((resolve) => {
    unpause = resolve;
  });
  let intercept = true;
  await page.route(editUrl, async (route) => {
    if (intercept && ofSculpt(route.request())) {
      intercept = false;
      await blocked;
    }
    await route.continue();
  });

  const first = page.waitForRequest((request) => editUrl.test(request.url()) && ofSculpt(request));
  await page.mouse.click(x + 8, y - 7);
  const firstRequest = await first;
  await page.mouse.click(x + 16, y - 7);
  const second = page.waitForResponse(
    (response) =>
      editUrl.test(response.url()) &&
      response.request() !== firstRequest &&
      ofSculpt(response.request()),
  );
  unpause();
  const secondResponse = await second;
  expect(secondResponse.status()).toBe(200);
  expect(secondResponse.request().postDataJSON().sculpt.source).not.toEqual(
    firstRequest.postDataJSON().sculpt.source,
  );
  expect(secondResponse.request().postDataJSON().checkpoint).toBe(true);

  // The stroke can change geometry through zero-valued weights, which it then discards.
  const invertMask = page.getByRole('button', { name: 'Invert mask', exact: true });
  const clearMask = page.getByRole('button', { name: 'Clear mask', exact: true });
  await invertMask.click();
  await invertMask.click();
  await expect(clearMask).toBeEnabled();

  blocked = new Promise<void>((resolve) => {
    unpause = resolve;
  });
  intercept = true;
  const third = page.waitForRequest((request) => editUrl.test(request.url()) && ofSculpt(request));
  await page.mouse.click(x + 24, y - 7);
  const thirdRequest = await third;
  await expect(clearMask).toBeDisabled();
  const extraUndo: string[] = [];
  page.on('request', (request) => {
    if (/\/live\/undo$/.test(request.url())) extraUndo.push(request.url());
  });
  await page.keyboard.press('ControlOrMeta+z');
  await call('update_parts', { updates: [{ id: 'block', translate: [2, 0, 0] }] });
  const refused = page.waitForResponse((response) => response.request() === thirdRequest);
  unpause();
  expect((await refused).status()).toBe(409);
  await expect(
    page.getByText(/sculpt target changed before the stroke reached the shared scene/i),
  ).toBeVisible();
  await expect(clearMask).toBeEnabled();
  expect((await call('get_scene')).parts[0].position).toEqual([2, 0, 0]);
  expect(extraUndo).toEqual([]);
});

test('an ordinary edit between queued strokes preserves a newer remote mesh', async ({ page }) => {
  await call('add_parts', {
    parts: [{ id: 'block', name: 'Sculpt block', shapes: [{ type: 'box', size: [10, 8, 6] }] }],
  });
  const { url } = await call('open_live_view', { open_browser: false });
  await page.goto(url);
  await page.locator(part('Sculpt block')).click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: 'Sculpt', exact: true }).click();
  const radius = page.getByRole('spinbutton', { name: 'Radius', exact: true });
  await radius.fill('1.5');
  await radius.press('Enter');

  const canvas = (await page.locator('canvas').boundingBox())!;
  const x = canvas.x + canvas.width / 2;
  const y = canvas.y + canvas.height / 2;
  const editUrl = /\/live\/edit$/;
  let unblock = () => {};
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let applyRemote = () => {};
  const remoteReady = new Promise<void>((resolve) => {
    applyRemote = resolve;
  });
  let held = false;
  let completed = false;
  let remoteGeometry = '';
  await page.route(editUrl, async (route) => {
    const body = route.request().postDataJSON();
    if (held || !body.sculpt) return await route.continue();
    held = true;
    await remoteReady;
    const accepted = await route.fetch();
    if (accepted.ok()) {
      const { version } = await accepted.json();
      remoteGeometry = body.sculpt.source;
      // Replace the stroke's mesh using a separate author's edit before this tab can send again.
      const remote = await page.request.post(route.request().url(), {
        data: {
          client: 'remote-editor',
          base: version,
          epoch: body.epoch,
          checkpoint: true,
          scene: {
            ...body.scene,
            parts: body.scene.parts.map((part: { id: string }) => ({
              ...part,
              ...(part.id === body.sculpt.partId
                ? { geometry: remoteGeometry, name: 'Remotely edited block' }
                : {}),
            })),
          },
        },
      });
      completed = remote.ok();
    }
    await blocked;
    await route.fulfill({ response: accepted });
  });

  await page.mouse.click(x + 8, y - 7);
  await expect.poll(() => held).toBe(true);
  await page.getByTitle('Rename assembly').click();
  await page.getByRole('textbox', { name: 'Assembly name' }).fill('Renamed while sculpting');
  await page.getByRole('textbox', { name: 'Assembly name' }).press('Enter');
  await page.mouse.click(x + 16, y - 7);
  applyRemote();
  await expect.poll(() => completed).toBe(true);
  await expect(page.locator(part('Remotely edited block'))).toBeVisible();
  const ordinary = page.waitForRequest(
    (request) => editUrl.test(request.url()) && !request.postDataJSON().sculpt,
  );
  unblock();
  const request = await ordinary;
  expect((await request.response())?.status()).toBe(200);
  await expect(
    page.getByText(/sculpt target changed before the stroke reached the shared scene/i),
  ).toBeVisible();
  expect((await call('get_scene')).name).toBe('Renamed while sculpting');
  expect(request.postDataJSON().scene.parts[0].geometry).toBe(remoteGeometry);
});

test('a remote mesh survives the delayed response for a single sculpt stroke', async ({ page }) => {
  await call('add_parts', {
    parts: [{ id: 'block', name: 'Sculpt block', shapes: [{ type: 'box', size: [10, 8, 6] }] }],
  });
  const { url } = await call('open_live_view', { open_browser: false });
  await page.goto(url);
  await page.locator(part('Sculpt block')).click();
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: 'Sculpt', exact: true }).click();
  const radius = page.getByRole('spinbutton', { name: 'Radius', exact: true });
  await radius.fill('1.5');
  await radius.press('Enter');

  const canvas = page.locator('canvas');
  const box = (await canvas.boundingBox())!;
  const triangles = page.locator('.scene-summary').getByText(/triangles$/);
  const baseline = await triangles.innerText();
  const editUrl = /\/live\/edit$/;
  let finish = () => {};
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let acceptedVersion = 0;
  await page.route(editUrl, async (route) => {
    const accepted = await route.fetch();
    if (accepted.ok() && route.request().postDataJSON().sculpt) {
      const { version } = await accepted.json();
      acceptedVersion = version;
      await held;
    }
    await route.fulfill({ response: accepted });
  });

  const sent = page.waitForRequest(
    (request) => editUrl.test(request.url()) && !!request.postDataJSON().sculpt,
  );
  await page.mouse.click(box.x + box.width / 2 + 8, box.y + box.height / 2 - 7);
  await page.mouse.move(box.x - 2, box.y + 2);
  const request = await sent;
  await expect.poll(() => acceptedVersion).toBeGreaterThan(0);
  await expect(triangles).not.toHaveText(baseline);

  const original = request.postDataJSON();
  const remote = await page.request.post(request.url(), {
    data: {
      client: 'remote-editor',
      base: acceptedVersion,
      epoch: original.epoch,
      checkpoint: true,
      scene: {
        ...original.scene,
        parts: original.scene.parts.map((part: { id: string }) => ({
          ...part,
          ...(part.id === original.sculpt.partId
            ? { geometry: original.sculpt.source, name: 'Restored block' }
            : {}),
        })),
      },
    },
  });
  expect(remote.ok()).toBe(true);
  await expect(page.locator(part('Restored block'))).toBeVisible();
  const completed = page.waitForResponse((response) => response.request() === request);
  finish();
  expect((await completed).ok()).toBe(true);
  await expect(triangles).toHaveText(baseline);
});
