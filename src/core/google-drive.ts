import { DriveError, driveAccessToken, refreshDriveToken } from './google-auth';
import { safeFilename } from './files';
import { assertReadable, readSceneFile, sceneFileBlob } from './scene-file';
import type { DriveFileBinding, SceneDocument } from './types';

const api = 'https://www.googleapis.com/drive/v3/files';
const uploadApi = 'https://www.googleapis.com/upload/drive/v3/files';
const fields = 'id,name,version,modifiedTime,trashed,appProperties,md5Checksum';
const chunkSize = 8 * 1024 * 1024;

export interface DriveFile {
  id: string;
  name: string;
  version: string;
  modifiedTime?: string;
  md5Checksum?: string;
  trashed?: boolean;
  appProperties?: Record<string, string>;
}

export class DriveConflict extends DriveError {
  constructor(readonly file: DriveFile) {
    super(
      'The scene in Drive differs from your local copy. Choose which version to keep.',
      'conflict',
    );
  }
}

export function driveBinding(file: DriveFile): DriveFileBinding {
  return {
    id: file.id,
    version: file.version,
    ...(file.md5Checksum ? { md5Checksum: file.md5Checksum } : {}),
  };
}

function sameContent(a: { version: string | null; md5Checksum?: string }, b: DriveFile) {
  return a.md5Checksum && b.md5Checksum ? a.md5Checksum === b.md5Checksum : a.version === b.version;
}

/** Compare in bounded chunks, even for scenes too large for one ArrayBuffer. */
async function identicalBlobs(a: Blob, b: Blob, signal: AbortSignal) {
  if (a.size !== b.size) return false;
  for (let offset = 0; offset < a.size; offset += 1024 * 1024) {
    signal.throwIfAborted();
    const [left, right] = await Promise.all(
      [a, b].map(
        async (blob) =>
          new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()),
      ),
    );
    if (!left.every((byte, index) => byte === right[index])) return false;
  }
  return true;
}

function fileRecord(value: unknown): DriveFile {
  const file = value as DriveFile | null;
  if (
    !file ||
    typeof file.id !== 'string' ||
    !/^[\w-]+$/.test(file.id) ||
    typeof file.name !== 'string' ||
    typeof file.version !== 'string'
  ) {
    throw new DriveError('Google Drive returned incomplete file information. Try again.');
  }
  return file;
}

export function readDriveBinding(value: unknown): DriveFileBinding | null {
  const binding = value as DriveFileBinding | null;
  if (
    !binding ||
    typeof binding.id !== 'string' ||
    !/^[\w-]+$/.test(binding.id) ||
    !(binding.version === null || typeof binding.version === 'string')
  )
    return null;
  return {
    id: binding.id,
    version: binding.version,
    ...(typeof binding.md5Checksum === 'string' && /^[a-f0-9]{32}$/i.test(binding.md5Checksum)
      ? { md5Checksum: binding.md5Checksum }
      : {}),
    ...(typeof binding.pendingWriteId === 'string'
      ? { pendingWriteId: binding.pendingWriteId }
      : {}),
  };
}

async function checkResponse(response: Response) {
  if (response.ok || response.status === 308) return response;
  const body = await response.json().catch(() => null);
  const reason = body?.error?.errors?.[0]?.reason;
  const status = response.status;
  if (status === 401)
    throw new DriveError('Reconnect to Google Drive to continue autosaving.', 'auth', status);
  if (status === 412)
    throw new DriveError(
      'The Drive file changed during saving. Check again, then choose which version to keep.',
      'conflict',
      status,
    );
  if (
    status === 429 ||
    status >= 500 ||
    ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason)
  ) {
    throw new DriveError(
      'Google Drive is temporarily unavailable. Autosave will retry.',
      'retryable',
      status,
    );
  }
  const message =
    status === 404
      ? 'This Drive file is unavailable. Check the connected account or save a new copy.'
      : reason === 'storageQuotaExceeded'
        ? 'Your Google Drive is full. Free up space, then retry.'
        : status === 403
          ? 'Google Drive refused access. Check file permissions and that the Drive API is enabled.'
          : `Google Drive could not save this scene (HTTP ${status}). Retry or download a copy.`;
  throw new DriveError(message, 'error', status);
}

export class GoogleDriveClient {
  constructor(
    private readonly getToken: () => string | Promise<string> = driveAccessToken,
    private readonly refreshToken: (rejected: string) => Promise<string> = refreshDriveToken,
  ) {}

  private async request(url: string, init: RequestInit = {}, signal?: AbortSignal) {
    const headers = new Headers(init.headers);
    const accessToken = await this.getToken();
    headers.set('Authorization', `Bearer ${accessToken}`);
    try {
      const send = () =>
        fetch(url, {
          ...init,
          headers,
          cache: 'no-store',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
            : AbortSignal.timeout(120000),
        });
      let response = await send();
      if (response.status === 401) {
        headers.set('Authorization', `Bearer ${await this.refreshToken(accessToken)}`);
        signal?.throwIfAborted();
        response = await send();
      }
      return await checkResponse(response);
    } catch (error) {
      if (signal?.aborted || error instanceof DriveError) throw error;
      throw new DriveError(
        'Could not reach Google Drive. Your edits will retry when the connection returns.',
        'retryable',
      );
    }
  }

  async allocateId(signal?: AbortSignal): Promise<string> {
    const response = await this.request(
      `${api}/generateIds?count=1&space=drive&type=files`,
      {},
      signal,
    );
    const { ids } = await response.json();
    if (!Array.isArray(ids) || typeof ids[0] !== 'string' || !/^[\w-]+$/.test(ids[0])) {
      throw new DriveError('Google Drive could not reserve a file. Try again.');
    }
    return ids[0];
  }

  async list(pageToken?: string): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    const query = new URLSearchParams({
      q: "trashed = false and appProperties has { key='kitbasher' and value='scene' }",
      fields: `nextPageToken,files(${fields})`,
      orderBy: 'modifiedTime desc',
      pageSize: '100',
      ...(pageToken ? { pageToken } : {}),
    });
    const response = await this.request(`${api}?${query}`);
    const data = await response.json();
    if (!Array.isArray(data.files))
      throw new DriveError('Google Drive could not list your scenes.');
    return { files: data.files.map(fileRecord), nextPageToken: data.nextPageToken };
  }

  async metadata(id: string, signal?: AbortSignal) {
    const response = await this.request(
      `${api}/${encodeURIComponent(id)}?fields=${fields}`,
      {},
      signal,
    );
    return fileRecord(await response.json());
  }

  async open(id: string, signal?: AbortSignal): Promise<{ scene: SceneDocument; file: DriveFile }> {
    const file = await this.metadata(id, signal);
    if (file.trashed)
      throw new DriveError('This scene is in Google Drive trash. Restore it first.');
    const response = await this.request(`${api}/${encodeURIComponent(id)}?alt=media`, {}, signal);
    const scene = await readSceneFile(await response.blob());
    const latest = await this.metadata(id, signal);
    if (latest.trashed || !sameContent(file, latest)) {
      throw new DriveError(
        'This scene changed while it was opening. Please open it again.',
        'conflict',
      );
    }
    return { scene, file: latest };
  }

  async save(
    scene: SceneDocument,
    binding: DriveFileBinding,
    signal: AbortSignal,
    progress: (fraction: number) => void,
  ): Promise<DriveFile> {
    const blob = await sceneFileBlob(scene);
    await assertReadable(blob);
    signal.throwIfAborted();
    let current: DriveFile | null = null;
    try {
      current = await this.metadata(binding.id, signal);
    } catch (error) {
      // A pre-generated id makes retries of a new file safe, even after a lost response.
      if (!(error instanceof DriveError && error.status === 404 && binding.version === null))
        throw error;
    }
    if (current?.trashed)
      throw new DriveError('This scene is in Google Drive trash. Restore it or save a new copy.');
    if (current && !sameContent(binding, current)) {
      // Old recovery records have no checksum. A lost upload response can also leave
      // an old binding. Compare actual bytes before calling either case a conflict.
      // An appProperties write id alone is unsafe: external editors may preserve it.
      const response = await this.request(
        `${api}/${encodeURIComponent(binding.id)}?alt=media`,
        {},
        signal,
      );
      const identical = await identicalBlobs(blob, await response.blob(), signal);
      const latest = await this.metadata(binding.id, signal);
      if (identical && !latest.trashed && sameContent(current, latest)) return latest;
      throw new DriveConflict(latest);
    }
    const metadata = {
      ...(!current ? { id: binding.id } : {}),
      name: `${safeFilename(scene.name)}.kitbash`,
      mimeType: 'application/octet-stream',
      appProperties: { kitbasher: 'scene', kitbasherWrite: binding.pendingWriteId },
    };
    const response = await this.request(
      `${uploadApi}${current ? `/${encodeURIComponent(binding.id)}` : ''}?uploadType=resumable&fields=${fields}`,
      {
        method: current ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': blob.type,
          'X-Upload-Content-Length': String(blob.size),
        },
        body: JSON.stringify(metadata),
      },
      signal,
    );
    const location = response.headers.get('Location');
    // Never send a bearer token to a URL supplied by file contents or another origin.
    if (!location || new URL(location).origin !== 'https://www.googleapis.com') {
      throw new DriveError('Google Drive did not return a valid upload session. Retry saving.');
    }
    let offset = 0,
      failures = 0,
      stalled = 0;
    while (offset < blob.size) {
      const end = Math.min(offset + chunkSize, blob.size);
      let chunk: Response;
      try {
        chunk = await this.request(
          location,
          {
            method: 'PUT',
            headers: {
              'Content-Type': blob.type,
              'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}`,
            },
            body: blob.slice(offset, end),
          },
          signal,
        );
        failures = 0;
      } catch (error) {
        if (!(error instanceof DriveError && error.kind === 'retryable') || ++failures > 3)
          throw error;
        // The server may have accepted a chunk (or the complete file) before the connection broke.
        chunk = await this.request(
          location,
          { method: 'PUT', headers: { 'Content-Range': `bytes */${blob.size}` } },
          signal,
        );
      }
      if (chunk.status !== 308) {
        const result = await chunk.json().catch(() => {
          throw new DriveError(
            'Google Drive did not confirm the saved revision. Autosave will retry.',
            'retryable',
          );
        });
        const file = fileRecord(result);
        if (file.id !== binding.id)
          throw new DriveError('Google Drive returned a different file. Saving has stopped.');
        progress(1);
        return file;
      }
      const range = chunk.headers.get('Range');
      const match = range?.match(/^bytes=0-(\d+)$/);
      const next = match ? Number(match[1]) + 1 : 0;
      if (
        next < 0 ||
        next > blob.size ||
        (range && !match) ||
        (next <= offset && ++stalled > 3) ||
        next === blob.size
      ) {
        throw new DriveError(
          'Google Drive could not confirm the upload. Autosave will retry.',
          'retryable',
        );
      }
      if (next > offset) stalled = 0;
      offset = next;
      progress(offset / blob.size);
    }
    throw new DriveError('Google Drive did not finish the upload.', 'retryable');
  }
}

export const googleDrive = new GoogleDriveClient();
