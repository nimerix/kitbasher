import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry } from 'three';
import { GoogleDriveClient, readDriveBinding } from '../../src/core/google-drive';
import { DriveError } from '../../src/core/google-auth';
import { readSceneFile } from '../../src/core/scene-file';
import type { SceneDocument } from '../../src/core/types';

const file = { id: 'scene-1', name: 'Assembly.kitbash', version: '2' };
const binding = { id: file.id, version: '1', pendingWriteId: 'write-1' };
const session = 'https://www.googleapis.com/upload/drive/v3/files/scene-1?upload_id=test';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const init = () => new Response(null, { status: 200, headers: { Location: session } });
const scene = (geometry: BufferGeometry = new BoxGeometry(1, 2, 3)): SceneDocument => ({
  name: 'Assembly',
  parts: [
    {
      id: 'part',
      name: 'Box',
      geometry,
      position: [4, 5, 6],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      source: 'test',
      color: '#abcdef',
      visible: true,
      locked: false,
    },
  ],
  joints: [],
});
const client = () => new GoogleDriveClient(() => 'test-access-token');
const signal = () => new AbortController().signal;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Google Drive scene files', () => {
  it('updates the same file with a complete portable scene, including its name and geometry', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ ...file, version: '1' }))
      .mockResolvedValueOnce(init())
      .mockResolvedValueOnce(json(file));
    vi.stubGlobal('fetch', fetcher);
    const document = scene();
    const progress = vi.fn();
    expect(await client().save(document, binding, signal(), progress)).toEqual(file);
    const [url, request] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('/files/scene-1?uploadType=resumable');
    expect(request.method).toBe('PATCH');
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer test-access-token');
    expect(JSON.parse(request.body as string)).toMatchObject({
      name: 'Assembly.kitbash',
      appProperties: { kitbasher: 'scene', kitbasherWrite: 'write-1' },
    });
    const uploaded = await readSceneFile(fetcher.mock.calls[2][1].body as Blob);
    expect(uploaded.parts[0].position).toEqual([4, 5, 6]);
    expect(uploaded.parts[0].geometry.getAttribute('position').count).toBe(24);
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it('uses a reserved id to create a scene and recognizes its own upload after a lost response', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(init())
      .mockResolvedValueOnce(json(file))
      .mockResolvedValueOnce(json({ ...file, appProperties: { kitbasherWrite: 'write-1' } }))
      .mockResolvedValueOnce(init())
      .mockResolvedValueOnce(json({ ...file, version: '3' }));
    vi.stubGlobal('fetch', fetcher);
    const pending = { ...binding, version: null };
    await client().save(scene(), pending, signal(), () => {});
    expect(fetcher.mock.calls[1][1].method).toBe('POST');
    expect(JSON.parse(fetcher.mock.calls[1][1].body).id).toBe(file.id);
    await client().save(scene(), pending, signal(), () => {});
    expect(fetcher.mock.calls[4][1].method).toBe('PATCH');
  });

  it('refuses to overwrite a remotely changed file or recreate a removed existing file', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(file)).mockResolvedValueOnce(json({}, 404));
    vi.stubGlobal('fetch', fetcher);
    await expect(client().save(scene(), binding, signal(), () => {})).rejects.toMatchObject({
      kind: 'conflict',
    });
    await expect(client().save(scene(), binding, signal(), () => {})).rejects.toMatchObject({
      status: 404,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('resumes at the server-acknowledged byte after an interrupted chunk', async () => {
    const geometry = new BufferGeometry().setAttribute(
      'position',
      new BufferAttribute(new Float32Array(750000 * 3), 3),
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ ...file, version: '1' }))
      .mockResolvedValueOnce(init())
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(
        new Response(null, { status: 308, headers: { Range: 'bytes=0-262143' } }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 308, headers: { Range: 'bytes=0-8650751' } }),
      )
      .mockResolvedValueOnce(json(file));
    vi.stubGlobal('fetch', fetcher);
    await client().save(scene(geometry), binding, signal(), () => {});
    const headers = (index: number) => new Headers(fetcher.mock.calls[index][1].headers);
    expect(headers(2).get('Content-Range')).toMatch(/^bytes 0-8388607\//);
    expect(headers(3).get('Content-Range')).toMatch(/^bytes \*\//);
    expect(headers(4).get('Content-Range')).toMatch(/^bytes 262144-8650751\//);
    expect(headers(5).get('Content-Range')).toMatch(/^bytes 8650752-/);
  });

  it('accepts a completed upload when only its final response was lost', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ ...file, version: '1' }))
      .mockResolvedValueOnce(init())
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(json(file));
    vi.stubGlobal('fetch', fetcher);
    expect(await client().save(scene(), binding, signal(), () => {})).toEqual(file);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rejects an upload session on another origin before sending it credentials', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ ...file, version: '1' }))
      .mockResolvedValueOnce(
        new Response(null, { headers: { Location: 'https://example.com/upload' } }),
      );
    vi.stubGlobal('fetch', fetcher);
    await expect(client().save(scene(), binding, signal(), () => {})).rejects.toThrow(
      'valid upload session',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries when the upload response body is interrupted after its headers arrive', async () => {
    const brokenBody = new ReadableStream({
      start(controller) {
        controller.error(new TypeError('connection closed'));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ ...file, version: '1' }))
        .mockResolvedValueOnce(init())
        .mockResolvedValueOnce(new Response(brokenBody)),
    );
    await expect(client().save(scene(), binding, signal(), () => {})).rejects.toMatchObject({
      kind: 'retryable',
    });
  });

  it.each([
    [401, 'auth'],
    [429, 'retryable'],
    [503, 'retryable'],
    [403, 'error'],
  ] as const)('classifies HTTP %i without claiming a save', async (status, kind) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, status)));
    await expect(client().save(scene(), binding, signal(), () => {})).rejects.toMatchObject({
      kind,
    });
  });

  it('keeps authorization failures distinct from network errors', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const unauthorized = new GoogleDriveClient(() => {
      throw new DriveError('Reconnect', 'auth');
    });
    await expect(unauthorized.allocateId()).rejects.toMatchObject({ kind: 'auth' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('lists only app-created scenes and carries the next page token', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ files: [file], nextPageToken: 'next' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await client().list('previous')).toEqual({ files: [file], nextPageToken: 'next' });
    const query = new URL(fetcher.mock.calls[0][0]).searchParams;
    expect(query.get('q')).toContain("key='kitbasher' and value='scene'");
    expect(query.get('pageToken')).toBe('previous');
  });

  it('validates recovery bindings and strips any unrelated data', () => {
    expect(readDriveBinding({ ...binding, accessToken: 'must-not-persist' })).toEqual(binding);
    expect(readDriveBinding({ id: '../another', version: '1' })).toBeNull();
    expect(readDriveBinding({ id: 'valid', version: 1 })).toBeNull();
  });
});
