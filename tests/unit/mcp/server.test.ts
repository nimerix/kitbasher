import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { get, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LiveView } from '../../../mcp/live';
import { createServer, instructions } from '../../../mcp/tools';
import { Session } from '../../../mcp/session';
import { readGeometry, validateLayout } from '../../../src/core/scene-file';

let folder: string;
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'kitbasher-server-'));
  await mkdir(join(folder, 'app', 'assets'), { recursive: true });
  await writeFile(join(folder, 'app', 'index.html'), '<title>Kitbasher</title>');
  await writeFile(join(folder, 'app', 'assets', 'main.js'), 'export {}');
  await writeFile(join(folder, 'secret.txt'), 'private');
});
afterAll(() => rm(folder, { recursive: true, force: true }));

let client: Client;
let live: LiveView;
let session: Session;
const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as { type: string; text?: string }[]).find((c) => c.type === 'text')!.text!;
const data = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.parse(text(result));
const box = (id: string, position = [0, 0, 0]) => ({
  id,
  name: id,
  position,
  shapes: [{ type: 'box', size: [10, 10, 10] }],
});

beforeEach(async () => {
  live = new LiveView(join(folder, 'app'));
  session = new Session();
  const { server } = createServer(session, live);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});
afterEach(async () => {
  live.stop();
  await client.close();
});

describe('protocol', () => {
  it('teaches conventions when a client connects', () => {
    expect(client.getInstructions()).toBe(instructions);
    expect(instructions).toMatch(/millimeters/);
    expect(instructions).toMatch(/Y is up/);
  });

  it('offers tools with schemas every client can read', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(20);
    const names = new Set<string>();
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z_]+$/);
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      expect(tool.description!.length).toBeGreaterThan(20);
      expect(tool.annotations?.openWorldHint).toBe(false);
      expect(tool.annotations?.readOnlyHint).toBeTypeOf('boolean');
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe('object');
      // Some model APIs reject these at the top level, and others ignore them when nested.
      const serialized = JSON.stringify(schema);
      for (const keyword of ['"oneOf"', '"allOf"', '"$ref"', '"prefixItems"'])
        expect(serialized).not.toContain(keyword);
      // Zod writes a nullable field with anyOf, and only resetting a pivot needs one.
      expect(serialized.includes('"anyOf"')).toBe(tool.name === 'update_parts');
      expect(schema.additionalProperties).toBe(false);
    }
  });

  it('builds, moves, and describes through tool calls', async () => {
    const added = data(
      await client.callTool({ name: 'add_parts', arguments: { parts: [box('a')] } }),
    );
    expect(added.added[0].id).toBe('a');
    await client.callTool({
      name: 'update_parts',
      arguments: { updates: [{ id: 'a', translate: [5, 0, 0] }] },
    });
    const scene = data(await client.callTool({ name: 'get_scene', arguments: {} }));
    expect(scene.parts[0].position).toEqual([5, 0, 0]);
    expect(scene.units).toBe('mm');
  });

  it('runs parallel calls in the order they were sent', async () => {
    const calls = [
      client.callTool({ name: 'add_parts', arguments: { parts: [box('a')] } }),
      client.callTool({
        name: 'save_scene',
        arguments: { path: join(folder, 'order.kitbash'), overwrite: true },
      }),
      client.callTool({
        name: 'update_parts',
        arguments: { updates: [{ id: 'a', translate: [1, 0, 0] }] },
      }),
      client.callTool({
        name: 'update_parts',
        arguments: { updates: [{ id: 'a', translate: [1, 0, 0] }] },
      }),
      client.callTool({ name: 'get_scene', arguments: {} }),
    ];
    const results = await Promise.all(calls);
    expect(results.every((result) => !result.isError)).toBe(true);
    const scene = data(results[4]);
    expect(scene.parts[0].position).toEqual([2, 0, 0]);
    expect(scene.unsaved).toBe(true);
  });

  it('returns failures as tool errors the model can read', async () => {
    const missing = await client.callTool({
      name: 'update_parts',
      arguments: { updates: [{ id: 'ghost', translate: [1, 0, 0] }] },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/no part "ghost"/);
    await expect(
      client.callTool({ name: 'no_such_tool', arguments: {} }).then((result) => {
        if (result.isError) throw new Error(text(result));
        return result;
      }),
    ).rejects.toThrow(/not found/);
  });

  it('rejects misspelled parameters rather than silently ignoring them', async () => {
    const result = await client.callTool({
      name: 'update_parts',
      arguments: { updates: [{ id: 'a', rotation_degrees: [1, 2, 3] }] },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/rotation_degrees/);
    const top = await client.callTool({ name: 'get_scene', arguments: { detail: true } });
    expect(top.isError).toBe(true);
  });

  it('rejects vectors of the wrong length', async () => {
    const result = await client.callTool({
      name: 'update_parts',
      arguments: { updates: [{ id: 'a', position: [1, 2] }] },
    });
    expect(result.isError).toBe(true);
  });

  it('accepts a null pivot to reset it', async () => {
    await client.callTool({ name: 'add_parts', arguments: { parts: [box('a')] } });
    const result = await client.callTool({
      name: 'update_parts',
      arguments: { updates: [{ id: 'a', pivot: null }] },
    });
    expect(result.isError).toBeFalsy();
  });

  it('returns renders as image content, and can also save them', async () => {
    await client.callTool({ name: 'add_parts', arguments: { parts: [box('a')] } });
    const path = join(folder, 'views', 'render.png');
    const result = await client.callTool({
      name: 'render_view',
      arguments: { views: ['iso'], width: 256, output_path: path },
    });
    const [image] = result.content as { type: string; data: string; mimeType: string }[];
    expect(image.type).toBe('image');
    expect(image.mimeType).toBe('image/png');
    const png = Buffer.from(image.data, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(await readFile(path)).toEqual(png);
    expect(data(result).views[0].name).toBe('iso');
    const refused = await client.callTool({
      name: 'render_view',
      arguments: { output_path: join(folder, 'views', 'render.exe') },
    });
    expect(refused.isError).toBe(true);
    expect(existsSync(join(folder, 'views', 'render.exe'))).toBe(false);
  });

  it('reaches every tool with a valid minimal call', async () => {
    const called = new Set<string>();
    const step = async (name: string, args: object = {}) => {
      called.add(name);
      const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
      expect(result.isError ? `${name}: ${text(result)}` : '').toBe('');
      return result;
    };
    const scene = join(folder, 'tour.kitbash');
    await step('new_scene', { name: 'Tour', discard_unsaved: true });
    await step('add_parts', { parts: [box('a'), box('b', [40, 0, 0]), box('c', [80, 0, 0])] });
    await step('update_parts', { updates: [{ id: 'b', translate: [1, 0, 0] }] });
    await step('place_parts', { placements: [{ id: 'b', target: 'a', side: '+x' }] });
    await step('duplicate_parts', { ids: ['c'], translate: [30, 0, 0] });
    await step('delete_parts', { ids: ['c-copy'] });
    await step('align_parts', {
      source: 'c',
      target: 'b',
      method: 'point',
      pairs: [{ source: { face: '-x' }, target: { face: '+x' } }],
    });
    await step('fit_anchors', {
      part: 'c',
      anchors: [{ point: { face: 'center' }, target: [90, 0, 0] }],
    });
    await step('create_joint', {
      child: 'b',
      parent: 'a',
      child_anchor: { face: '-x' },
      parent_anchor: { face: '+x' },
      name: 'Hinge',
    });
    await step('update_joint', { id: 'hinge', rotation_locks: [true, true, false] });
    await step('create_plane_constraint', {
      source: 'c',
      target: 'a',
      kind: 'parallel',
      source_plane: { face: '+y' },
      target_plane: { face: '+y' },
      opposed: false,
      name: 'Level',
    });
    await step('update_plane_constraint', { id: 'level', enabled: false });
    await step('remove_relationships', { joints: ['hinge'], plane_constraints: ['level'] });
    await step('fit_surfaces', {
      source: 'c',
      target: 'a',
      method: 'mate',
      pairs: [
        { source: { point: [90, -5, 0], radius: 3 }, target: { point: [0, 5, 0], radius: 3 } },
      ],
    });
    await step('undo');
    await step('redo');
    await step('raycast', { origin: [0, 100, 0], direction: [0, -1, 0] });
    await step('inspect_interference', { distance: 1 });
    await step('render_view', { views: ['front'], width: 128 });
    await step('merge_parts', { ids: ['a', 'b'], mode: 'combine', name: 'AB' });
    await step('save_scene', { path: scene, overwrite: true });
    await step('export_scene', { path: join(folder, 'tour.stl'), overwrite: true });
    await step('import_model', { path: join(folder, 'tour.stl') });
    await step('open_scene', { path: scene, discard_unsaved: true });
    await step('open_live_view', { open_browser: false });
    await step('get_scene');
    const { tools } = await client.listTools();
    expect([...called].sort()).toEqual(tools.map((tool) => tool.name).sort());
  });
});

function fetchRaw(url: string, host?: string) {
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const parsed = new URL(url);
    const request = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        // Unlike fetch, this does not tidy up a path before sending it.
        path: `${parsed.pathname}${parsed.search}`,
        headers: host ? { Host: host } : {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode!, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/** Reads server-sent events until one satisfies the test. */
function nextScene(
  url: string,
  test: (message: {
    scene: { parts: { id: string }[] };
    geometries: Record<string, never>;
  }) => boolean,
) {
  return new Promise<{
    message: {
      scene: { parts: { id: string; geometry: string }[] };
      geometries: Record<string, never>;
    };
    close: () => void;
  }>((resolve, reject) => {
    const request = get(url, (response) => {
      let buffer = '';
      response.on('data', (chunk) => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end < 0) return;
          const line = buffer
            .slice(0, end)
            .split('\n')
            .find((row) => row.startsWith('data: '));
          buffer = buffer.slice(end + 2);
          if (!line) continue;
          const message = JSON.parse(line.slice(6));
          if (test(message)) resolve({ message, close: () => request.destroy() });
        }
      });
    });
    request.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
    });
  });
}

describe('live view', () => {
  const start = async () => {
    const result = data(
      await client.callTool({ name: 'open_live_view', arguments: { open_browser: false } }),
    );
    const url = new URL(result.url);
    return { url, base: `${url.origin}${url.pathname}`, result };
  };

  it('binds to loopback and gives one stable, unguessable address', async () => {
    const { url, result } = await start();
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toMatch(/^\/[0-9a-f]{32}\/$/);
    expect(url.searchParams.get('live')).toBe('1');
    expect(result.opened).toBe(false);
    const again = data(
      await client.callTool({ name: 'open_live_view', arguments: { open_browser: false } }),
    );
    expect(again.url).toBe(result.url);
  });

  it('serves the app only under its token', async () => {
    const { url, base } = await start();
    expect((await fetchRaw(base)).body.toString()).toContain('Kitbasher');
    expect((await fetchRaw(`${base}assets/main.js`)).status).toBe(200);
    expect((await fetchRaw(url.origin)).status).toBe(404);
    expect((await fetchRaw(`${url.origin}/assets/main.js`)).status).toBe(404);
    expect((await fetchRaw(`${url.origin}/${'0'.repeat(32)}/`)).status).toBe(404);
  });

  it('never serves files outside the app', async () => {
    const { base } = await start();
    for (const path of [
      '../secret.txt',
      '..%2fsecret.txt',
      'assets/../../secret.txt',
      '%2e%2e/secret.txt',
    ]) {
      const response = await fetchRaw(`${base}${path}`);
      expect(response.body.toString()).not.toContain('private');
      expect(response.status).not.toBe(200);
    }
  });

  it('refuses other host names, which is how DNS rebinding would reach it', async () => {
    const { url, base } = await start();
    expect((await fetchRaw(base, 'attacker.example')).status).toBe(403);
    expect((await fetchRaw(base, `attacker.example:${url.port}`)).status).toBe(403);
    expect((await fetchRaw(base, `localhost:${url.port}`)).status).toBe(200);
  });

  it('streams changes, and serves each mesh for the app to read back', async () => {
    const { base } = await start();
    await client.callTool({ name: 'add_parts', arguments: { parts: [box('a')] } });
    const first = await nextScene(
      `${base}live/events`,
      (message) => message.scene.parts.length === 1,
    );
    expect(live.viewers).toBe(1);
    const { geometry } = first.message.scene.parts[0];
    const layout = first.message.geometries[geometry];
    const update = nextScene(`${base}live/events`, (message) => message.scene.parts.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.callTool({ name: 'add_parts', arguments: { parts: [box('b', [30, 0, 0])] } });
    const second = await update;
    expect(second.message.scene.parts.map((part) => part.id)).toEqual(['a', 'b']);
    const response = await fetchRaw(`${base}live/geometry/${geometry}`);
    expect(response.status).toBe(200);
    const blob = new Blob([response.body as BlobPart]);
    validateLayout(layout, 0, blob.size);
    const mesh = await readGeometry(blob, layout);
    expect(mesh.getAttribute('position').count).toBe(36);
    expect((await fetchRaw(`${base}live/geometry/unknown`)).status).toBe(404);
    first.close();
    second.close();
  });

  it('explains a missing build', async () => {
    const unbuilt = new LiveView(join(folder, 'nowhere'));
    await expect(unbuilt.start()).rejects.toThrow(/npm run build/);
    unbuilt.stop();
  });

  it('stops serving when stopped, and only answers GET', async () => {
    const { base } = await start();
    const post = await new Promise<number>((resolve, reject) => {
      const parsed = new URL(base);
      const request = httpRequest(
        { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'POST' },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.on('error', reject);
      request.end();
    });
    expect(post).toBe(404);
    live.stop();
    await expect(fetchRaw(base)).rejects.toThrow();
  });
});
