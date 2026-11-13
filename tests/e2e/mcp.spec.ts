import { execSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

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
  execSync('npx vite build && npx vite build --config vite.mcp.config.ts', { stdio: 'pipe' });
});

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'kitbasher-e2e-mcp-'));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist-mcp/kitbasher-mcp.js'],
    stderr: 'ignore',
  });
  client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(transport);
});

test.afterEach(async () => {
  await client.close();
  await rm(folder, { recursive: true, force: true });
});

const part = (name: string) => `.part-select[title="${name}"]`;

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
