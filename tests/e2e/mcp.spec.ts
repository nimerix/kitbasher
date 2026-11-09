import { execSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from '@playwright/test';

// These drive the bundle a client would really start, over real stdio, with the real app.
let folder: string;
let client: Client;
let transport: StdioClientTransport;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[]).find(
    (entry) => entry.type === 'text',
  )!.text!;
  if (result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
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

test('the live view follows the agent in the real app', async ({ page }) => {
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
  await expect(page.getByText('Following agent')).toBeVisible();
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

  // A followed scene belongs to the server, so the tab leaves its own autosave alone.
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
