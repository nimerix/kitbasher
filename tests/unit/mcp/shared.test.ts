import { get } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BoxGeometry } from 'three';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sharedDocument } from '../../../mcp/document';
import { LiveView } from '../../../mcp/live';
import { Session } from '../../../mcp/session';
import { createServer } from '../../../mcp/tools';
import { appendGeometry } from '../../../src/core/scene-file';

interface SharedPart {
  id: string;
  name: string;
  geometry: string;
  position: number[];
  color: string;
  [key: string]: unknown;
}
interface Message {
  version: number;
  epoch: number;
  scene: { name: string; parts: SharedPart[]; joints: Record<string, unknown>[] };
  geometries: Record<string, unknown>;
  history: Record<string, [number, number]>;
}

let folder: string;
let client: Client;
let live: LiveView;
let base: string;
let stream: ReturnType<typeof listen>;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'kitbasher-shared-'));
  await mkdir(join(folder, 'app'));
  await writeFile(join(folder, 'app', 'index.html'), '<title>Kitbasher</title>');
});
afterAll(() => rm(folder, { recursive: true, force: true }));

beforeEach(async () => {
  live = new LiveView(join(folder, 'app'));
  const { server } = createServer(new Session(), live);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  await call('add_parts', {
    parts: ['a', 'b', 'c'].map((id, i) => ({
      id,
      name: id,
      position: [i * 30, 0, 0],
      shapes: [{ type: 'box', size: [10, 10, 10] }],
    })),
  });
  const url = new URL((await call('open_live_view', { open_browser: false })).url);
  base = `${url.origin}${url.pathname}`;
  stream = listen(`${base}live/events`);
});
afterEach(async () => {
  stream.close();
  live.stop();
  await client.close();
});

/** Calls a tool, returning its JSON and any note about changes made in the live view. */
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const texts = (result.content as { type: string; text?: string }[])
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text!);
  if (result.isError) throw new Error(texts.join('\n'));
  const notes = texts.slice(1).map((text) => JSON.parse(text).user_changes);
  return { ...JSON.parse(texts[0]), user_changes: notes[0] };
}

function listen(url: string) {
  const messages: Message[] = [];
  const waiting: { test: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
  const request = get(url, (response) => {
    let buffer = '';
    response.on('data', (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const line = buffer
          .slice(0, end)
          .split('\n')
          .find((row) => row.startsWith('data: '));
        buffer = buffer.slice(end + 2);
        if (!line) continue;
        const message = JSON.parse(line.slice(6)) as Message;
        messages.push(message);
        for (const waiter of [...waiting])
          if (waiter.test(message)) {
            waiting.splice(waiting.indexOf(waiter), 1);
            waiter.resolve(message);
          }
      }
    });
  });
  request.on('error', () => {});
  return {
    /** The newest message, once one passes the test. */
    until: (test: (m: Message) => boolean = () => true) => {
      const newest = messages.at(-1);
      if (newest && test(newest)) return Promise.resolve(newest);
      return new Promise<Message>((resolve) => waiting.push({ test, resolve }));
    },
    current: () => stream.until((m) => m.version === sharedDocument.version),
    close: () => request.destroy(),
  };
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** A tab's edit: the scene from a message, changed, and sent with that message's version. */
function edit(
  message: Message,
  change: (scene: Message['scene']) => void,
  options: { client?: string; checkpoint?: boolean; replace?: boolean } = {},
) {
  const scene = structuredClone(message.scene);
  change(scene);
  return post('live/edit', {
    client: options.client ?? 'tab-1',
    base: message.version,
    epoch: message.epoch,
    checkpoint: options.checkpoint ?? true,
    replace: options.replace,
    scene,
  });
}

const partIn = (scene: Message['scene'], id: string) => scene.parts.find((p) => p.id === id)!;
const pose = async (id: string) => (await call('get_scene', { ids: [id] })).parts[0];

describe('editing from a tab', () => {
  it('reaches the agent, which is told what the user changed', async () => {
    const message = await stream.current();
    const result = await edit(message, (scene) => (partIn(scene, 'a').position = [5, 0, 0]));
    expect(result.status).toBe(200);
    expect(result.body.version).toBe(message.version + 1);
    const scene = await call('get_scene');
    expect(scene.parts[0].position).toEqual([5, 0, 0]);
    expect(scene.user_changes).toEqual({ parts_changed: ['a'] });
    expect((await call('get_scene')).user_changes).toBeUndefined();
    // Every tab hears about it too, with this tab's undo history.
    const echoed = await stream.until((m) => m.version === result.body.version);
    expect(partIn(echoed.scene, 'a').position).toEqual([5, 0, 0]);
    expect(echoed.history['tab-1']).toEqual([1, 0]);
  });

  it('combines a change made on an older version with what the agent did since', async () => {
    const message = await stream.current();
    await call('update_parts', {
      updates: [
        { id: 'a', color: '#ff0000' },
        { id: 'b', translate: [0, 7, 0] },
      ],
    });
    expect((await edit(message, (scene) => (partIn(scene, 'a').position = [3, 0, 0]))).status).toBe(
      200,
    );
    const a = await pose('a');
    expect([a.position, a.color]).toEqual([[3, 0, 0], '#ff0000']);
    expect((await pose('b')).position).toEqual([30, 7, 0]);
  });

  it('lets the later edit win when both moved the same part', async () => {
    const message = await stream.current();
    await call('update_parts', { updates: [{ id: 'a', position: [10, 0, 0] }] });
    await edit(message, (scene) => (partIn(scene, 'a').position = [20, 0, 0]));
    expect((await pose('a')).position).toEqual([20, 0, 0]);
  });

  it('seats a jointed part again when combined edits pull it away', async () => {
    await call('create_joint', {
      child: 'b',
      parent: 'a',
      child_anchor: { face: '-x' },
      parent_anchor: { face: '+x' },
    });
    const message = await stream.current();
    await call('update_parts', { updates: [{ id: 'a', translate: [0, 50, 0] }] });
    await edit(message, (scene) => (partIn(scene, 'b').position = [100, 0, 0]));
    const scene = await call('get_scene');
    expect(scene.joints[0].anchor_gap).toBeCloseTo(0, 6);
    expect(scene.parts.find((p: { id: string }) => p.id === 'b').position[1]).toBeCloseTo(50, 6);
  });

  it('refuses a change that conflicts with the agent’s relationships, and changes nothing', async () => {
    const message = await stream.current();
    await call('create_joint', {
      child: 'c',
      parent: 'a',
      child_anchor: { face: 'center' },
      parent_anchor: { face: 'center' },
    });
    const before = sharedDocument.version;
    const result = await edit(message, (scene) =>
      scene.joints.push({
        id: 'mine',
        name: 'Mine',
        parentId: 'b',
        childId: 'c',
        parentAnchor: [0, 0, 0],
        childAnchor: [0, 0, 0],
        restRotation: [0, 0, 0, 1],
        rotationLocks: [false, false, false],
        keepConnected: true,
      }),
    );
    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/already has a parent/);
    expect(sharedDocument.version).toBe(before);
    expect((await call('get_scene')).joints).toHaveLength(1);
  });

  it('ignores a change that changes nothing', async () => {
    const message = await stream.current();
    const result = await edit(message, () => {});
    expect(result.body.version).toBe(message.version);
    expect((await call('get_scene')).user_changes).toBeUndefined();
  });
});

describe('meshes from a tab', () => {
  const mesh = () => {
    const parts: BlobPart[] = [];
    const { layout } = appendGeometry(new BoxGeometry(4, 4, 4), parts, 0);
    return { layout, body: new Blob(parts) };
  };
  const upload = async (key: string, layout: unknown, body: Blob) =>
    (
      await fetch(`${base}live/geometry/${key}`, {
        method: 'POST',
        headers: { 'X-Kitbasher-Layout': JSON.stringify(layout) },
        body,
      })
    ).status;

  it('takes a new mesh, then a part that uses it', async () => {
    const { layout, body } = mesh();
    expect(await upload('tab-mesh-1', layout, body)).toBe(204);
    expect(await upload('tab-mesh-1', layout, body)).toBe(204);
    const message = await stream.current();
    const result = await edit(message, (scene) =>
      scene.parts.push({
        ...partIn(scene, 'a'),
        id: 'imported',
        name: 'Imported',
        geometry: 'tab-mesh-1',
      }),
    );
    expect(result.status).toBe(200);
    const imported = await pose('imported');
    expect(imported.triangles).toBe(12);
    expect(imported.size).toEqual([4, 4, 4]);
    expect((await fetch(`${base}live/geometry/tab-mesh-1`)).status).toBe(200);
  });

  it('refuses a part whose mesh never arrived, and meshes that are not meshes', async () => {
    const message = await stream.current();
    const missing = await edit(message, (scene) => (partIn(scene, 'a').geometry = 'never-sent'));
    expect(missing.status).toBe(409);
    expect(missing.body.error).toMatch(/never sent/);
    const { layout, body } = mesh();
    expect(await upload('bad%20key', layout, body)).toBe(400);
    expect(await upload('short', layout, body.slice(0, 20))).toBe(400);
    expect(await upload('nolayout', 'not json at all', body)).toBe(400);
    expect(
      await upload('nans', layout, new Blob([new Float32Array(body.size / 4).fill(NaN)])),
    ).toBe(400);
  });
});

describe('undo by author', () => {
  it('reverts only the author’s own change', async () => {
    const message = await stream.current();
    const moved = await edit(message, (scene) => (partIn(scene, 'a').position = [5, 0, 0]));
    await call('update_parts', { updates: [{ id: 'b', translate: [0, 9, 0] }] });
    expect((await post('live/undo', { client: 'tab-1' })).body.changed).toBe(true);
    expect((await pose('a')).position).toEqual([0, 0, 0]);
    expect((await pose('b')).position).toEqual([30, 9, 0]);
    await call('undo');
    expect((await pose('b')).position).toEqual([30, 0, 0]);
    expect((await post('live/redo', { client: 'tab-1' })).body.changed).toBe(true);
    expect((await pose('a')).position).toEqual([5, 0, 0]);
    expect(moved.status).toBe(200);
  });

  it('keeps a value someone else set after the step being undone', async () => {
    const message = await stream.current();
    await edit(message, (scene) => (partIn(scene, 'a').position = [5, 0, 0]));
    await call('update_parts', { updates: [{ id: 'a', position: [9, 0, 0] }] });
    const undone = await post('live/undo', { client: 'tab-1' });
    expect(undone.body.changed).toBe(false);
    expect((await pose('a')).position).toEqual([9, 0, 0]);
    // The agent's undo is told the same.
    await edit(await stream.current(), (scene) => (partIn(scene, 'a').position = [1, 0, 0]));
    const agentUndo = await call('undo');
    expect(agentUndo.changed).toBe(false);
    expect((await pose('a')).position).toEqual([1, 0, 0]);
  });

  it('makes one step of a drag', async () => {
    let message = await stream.current();
    for (const [x, checkpoint] of [
      [1, true],
      [2, false],
      [3, false],
    ] as const) {
      const result = await edit(message, (scene) => (partIn(scene, 'a').position = [x, 0, 0]), {
        checkpoint,
      });
      message = await stream.until((m) => m.version === result.body.version);
    }
    expect(message.history['tab-1']).toEqual([1, 0]);
    await post('live/undo', { client: 'tab-1' });
    expect((await pose('a')).position).toEqual([0, 0, 0]);
  });

  it('keeps each tab’s history separate, and says when there is nothing to undo', async () => {
    const message = await stream.current();
    await edit(message, (scene) => (partIn(scene, 'a').position = [5, 0, 0]), { client: 'tab-1' });
    expect((await post('live/undo', { client: 'tab-2' })).body).toMatchObject({ empty: true });
    expect((await pose('a')).position).toEqual([5, 0, 0]);
    expect((await post('live/undo', { client: 'agent' })).status).toBe(400);
  });

  it('does not share a failed agent call', async () => {
    const before = sharedDocument.version;
    await expect(
      call('update_parts', {
        updates: [
          { id: 'a', translate: [1, 0, 0] },
          { id: 'missing', translate: [1, 0, 0] },
        ],
      }),
    ).rejects.toThrow(/missing/);
    expect(sharedDocument.version).toBe(before);
  });
});

describe('replacing the scene from a tab', () => {
  it('starts everyone over, and the agent is told', async () => {
    await call('save_scene', { path: join(folder, 'agent.kitbash'), overwrite: true });
    const message = await stream.current();
    const result = await edit(
      message,
      (scene) => {
        scene.name = 'Opened by the user';
        scene.parts = [{ ...partIn(scene, 'c'), id: 'only' }];
        scene.joints = [];
      },
      { replace: true },
    );
    expect(result.status).toBe(200);
    const scene = await call('get_scene');
    expect(scene).toMatchObject({ name: 'Opened by the user', part_count: 1, can_undo: 0 });
    expect(scene.user_changes).toEqual({ scene_replaced: true });
    // The agent's file belongs to the old scene, and the user's scene is not saved anywhere.
    expect(scene.path).toBeNull();
    expect(scene.unsaved).toBe(true);
    await expect(call('save_scene')).rejects.toThrow(/no file yet/);
    await expect(call('new_scene')).rejects.toThrow(/unsaved/);
    const stale = await edit(message, (s) => (partIn(s, 'a').position = [1, 0, 0]));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/replaced/);
  });
});

describe('requests a tab cannot make', () => {
  it('refuses malformed edits', async () => {
    const message = await stream.current();
    const valid = {
      client: 'tab-1',
      base: message.version,
      epoch: message.epoch,
      scene: message.scene,
    };
    expect((await post('live/edit', 'not json')).status).toBe(400);
    expect((await post('live/edit', { ...valid, client: undefined })).status).toBe(400);
    expect((await post('live/edit', { ...valid, client: 'agent' })).status).toBe(400);
    expect((await post('live/edit', { ...valid, base: 'latest' })).status).toBe(400);
    expect(
      (await post('live/edit', { ...valid, scene: { ...valid.scene, parts: 'none' } })).status,
    ).toBe(400);
    const tooOld = await post('live/edit', { ...valid, base: -5 });
    expect(tooOld.status).toBe(409);
    expect(tooOld.body.error).toMatch(/too old/);
    expect(
      (await fetch(`${base.replace(/[0-9a-f]{32}/, '0'.repeat(32))}live/edit`, { method: 'POST' }))
        .status,
    ).toBe(404);
  });
});
